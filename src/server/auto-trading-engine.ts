import {
  TradingMode,
  TechnicalAnalysis,
  Position,
  TradingSettings,
  ScannerSummary,
  StrategyState,
} from '../types/index.ts';
import { Storage } from './storage.ts';
import { BinanceRequestManager } from './binance-client.ts';
import { BinanceTimeService } from './binance-time.ts';
import { calculateAllIndicators, filterClosedCandles } from './indicators.ts';
import { detectCandlePatterns } from './pattern-detector.ts';
import { analyzeMarketStructure } from './market-structure.ts';
import { StrategyEngine } from './strategy-engine.ts';
import { SafetyGate } from './safety-gate.ts';
import { PaperTradingExecutor, RealBinanceTradingExecutor, TradingExecutor } from './trading-executor.ts';
import { Logger } from './logger.ts';
import { AuditLogger } from './audit-logger.ts';

type StateUpdateListener = (data: { type: string; payload: any }) => void;

export class AutoTradingEngine {
  private static instance: AutoTradingEngine;
  private binance = BinanceRequestManager.getInstance();
  private paperExecutor = new PaperTradingExecutor();
  private realExecutor = new RealBinanceTradingExecutor();
  private scanTimer: NodeJS.Timeout | null = null;
  private positionSyncTimer: NodeJS.Timeout | null = null;
  private isScanRunning = false;
  private isPositionSyncRunning = false;
  private listeners = new Set<StateUpdateListener>();

  private constructor() {}

  public static getInstance(): AutoTradingEngine {
    if (!AutoTradingEngine.instance) {
      AutoTradingEngine.instance = new AutoTradingEngine();
    }
    return AutoTradingEngine.instance;
  }

  public subscribe(listener: StateUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public broadcast(type: string, payload: any): void {
    this.listeners.forEach(fn => {
      try {
        fn({ type, payload });
      } catch {
        // ignore subscriber errors
      }
    });
  }

  public getExecutor(mode: TradingMode): TradingExecutor {
    return mode === 'PAPER' ? this.paperExecutor : this.realExecutor;
  }

  public isEmergencyStopActive(): boolean {
    return Storage.isEmergencyStopActive();
  }

  public setEmergencyStop(active: boolean): void {
    Storage.setEmergencyStop(active);
    this.broadcast('emergency_stop_changed', { isEmergencyStopped: active });
  }

  public async startScheduler(): Promise<void> {
    if (this.scanTimer) return;
    const settings = Storage.getSettings();
    const intervalMs = settings.scanIntervalMs || 300000; // 5 minutes authoritative

    // Start background Binance time synchronizer
    BinanceTimeService.getInstance().startPeriodicSync();

    // Start high-frequency online active position synchronizer (every 3s)
    this.startPositionSyncWorker(3000);

    // Fail-closed startup audit and resume check
    await this.validateStartupState();

    Logger.info(
      settings.mode,
      'SCAN',
      `AutoTrading scheduler initialized with ${intervalMs / 1000}s interval (5m). Position live-sync online. Auto-trading is ${settings.autoTrading ? 'ACTIVE' : 'IDLE'}.`
    );

    // Run first scan shortly after startup
    setTimeout(() => {
      this.runScanCycle().catch(err => Logger.error('PAPER', 'SCAN', `Initial scan error: ${err.message}`));
    }, 2000);

    this.scanTimer = setInterval(() => {
      this.runScanCycle().catch(err => Logger.error('PAPER', 'SCAN', `Scan cycle error: ${err.message}`));
    }, intervalMs);
  }

  public startPositionSyncWorker(intervalMs = 3000): void {
    if (this.positionSyncTimer) return;
    this.positionSyncTimer = setInterval(() => {
      this.syncActivePositionsWithBinance().catch(() => {});
    }, intervalMs);
  }

  public stopPositionSyncWorker(): void {
    if (this.positionSyncTimer) {
      clearInterval(this.positionSyncTimer);
      this.positionSyncTimer = null;
    }
  }

  /**
   * Always-online continuous synchronization of active positions with live Binance API mark prices and exchange balances.
   */
  public async syncActivePositionsWithBinance(): Promise<Position[]> {
    if (this.isPositionSyncRunning) return Storage.getPositions(undefined, 'OPEN');
    this.isPositionSyncRunning = true;

    try {
      const openPositions = Storage.getPositions(undefined, 'OPEN');
      if (openPositions.length === 0) {
        return [];
      }

      const updatedPositions: Position[] = [];
      const mode = Storage.getSettings().mode;

      // Group unique symbols to fetch current mark prices from Binance
      const symbols = [...new Set(openPositions.map(p => p.symbol))];
      const priceMap = new Map<string, number>();

      for (const sym of symbols) {
        try {
          const p = await this.binance.getLatestPrice(sym);
          if (p && p > 0) priceMap.set(sym, p);
        } catch {
          // ignore single symbol ticker failure
        }
      }

      // Check if real account credentials exist for live balance verification
      let realAccountData: any = null;
      const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
      if (realAcc?.hasApiKeys) {
        const creds = Storage.getDecryptedCredentials(realAcc.id);
        if (creds) {
          try {
            realAccountData = await this.binance.getAccount(creds.apiKey, creds.apiSecret);
          } catch {
            // ignore temporary account fetch errors
          }
        }
      }

      for (const pos of openPositions) {
        const livePrice = priceMap.get(pos.symbol) || pos.currentPrice;
        if (livePrice && livePrice > 0) {
          pos.currentPrice = livePrice;
          pos.unrealizedPnL = Number(((livePrice - pos.entryPrice) * pos.remainingQuantity).toFixed(4));
          pos.unrealizedPnLPercent = Number((((livePrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));
          pos.updatedAt = Date.now();
        }

        // For REAL positions, sync remainingQuantity with real Binance spot balance if available
        if (pos.mode === 'REAL' && realAccountData) {
          const baseAsset = pos.symbol.replace('USDT', '');
          const binanceBalance = realAccountData.balances?.find((b: any) => b.asset === baseAsset);
          if (binanceBalance) {
            const freeQty = parseFloat(binanceBalance.free) || 0;
            const lockedQty = parseFloat(binanceBalance.locked) || 0;
            const totalQty = freeQty + lockedQty;
            
            // If the Binance balance decreased externally, adjust remainingQuantity
            if (totalQty < pos.remainingQuantity * 0.999) {
              Logger.info('REAL', 'RECONCILIATION', `Position ${pos.symbol} quantity adjusted from ${pos.remainingQuantity} to ${totalQty} to match Binance online balance.`);
              pos.remainingQuantity = Number(totalQty.toFixed(8));
              if (pos.remainingQuantity <= 0) {
                pos.status = 'CLOSED';
                pos.closedAt = Date.now();
              }
            }
          }
        }

        Storage.savePosition(pos);
        updatedPositions.push(pos);
      }

      // Update wallet values
      const currentExecutor = this.getExecutor(mode);
      await currentExecutor.getBalance().catch(() => {});

      // Broadcast real-time position updates to all connected frontend clients
      this.broadcast('positions_synced', {
        positions: updatedPositions,
        timestamp: Date.now(),
        count: updatedPositions.length,
      });

      return updatedPositions;
    } finally {
      this.isPositionSyncRunning = false;
    }
  }

  /**
   * Fail-Closed startup validation.
   * If resumeOnRestart is false, autoTrading is strictly kept OFF.
   * If resumeOnRestart is true and mode is REAL, checks credentials, time sync, balances, and emergency stop.
   */
  public async validateStartupState(): Promise<void> {
    const settings = Storage.getSettings();
    const isEmergency = Storage.isEmergencyStopActive();

    if (isEmergency) {
      Storage.updateSettings({ autoTrading: false });
      Logger.warn('REAL', 'SECURITY', 'Startup: EMERGENCY STOP is ACTIVE from persistent storage. Auto-trading is LOCKED.');
      return;
    }

    if (!settings.resumeOnRestart) {
      Storage.updateSettings({ autoTrading: false });
      Logger.info(settings.mode, 'SECURITY', 'Startup: resumeOnRestart is FALSE. Auto-trading remains OFF until explicit user start.');
      return;
    }

    if (settings.mode === 'REAL' && settings.autoTrading) {
      try {
        Logger.info('REAL', 'SECURITY', 'Startup: Validating REAL trading resumption checklist...');
        const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
        if (!realAcc || !realAcc.hasApiKeys) {
          throw new Error('No Binance API credentials configured.');
        }

        const creds = Storage.getDecryptedCredentials(realAcc.id);
        if (!creds) {
          throw new Error('Unable to decrypt Binance credentials.');
        }

        // Verify Binance connectivity
        await this.binance.getAccount(creds.apiKey, creds.apiSecret);

        // Verify time synchronization
        const timeOk = await BinanceTimeService.getInstance().syncWithBinance();
        if (!timeOk || !BinanceTimeService.getInstance().isSafeDrift()) {
          throw new Error('Clock drift with Binance is unsafe.');
        }

        // Reconcile open orders & positions
        await this.realExecutor.reconcile();

        Logger.info('REAL', 'SECURITY', 'Startup: All REAL trading resumption safety checks PASSED.');
      } catch (err: any) {
        Storage.updateSettings({ autoTrading: false });
        Logger.error('REAL', 'SECURITY', `Startup: REAL resumption check failed (${err.message}). Auto-trading disabled for safety.`);
      }
    }
  }

  public stopScheduler(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.stopPositionSyncWorker();
  }

  public async runScanCycle(): Promise<TechnicalAnalysis[]> {
    if (this.isScanRunning) {
      Logger.warn('PAPER', 'SCAN', 'Previous scan cycle still active, skipping overlapping trigger.');
      return Storage.getAllAnalysis();
    }

    this.isScanRunning = true;
    const startTime = Date.now();
    const scanId = `scan-${startTime.toString(36)}`;
    const settings = Storage.getSettings();
    const currentMode = settings.mode;

    Storage.updateScannerSummary({ isScanning: true, lastScanTime: startTime });
    this.broadcast('scanner_started', { timestamp: startTime, scanId });

    try {
      // 1. Fetch 24hr tickers to select liquid USDT universe
      const tickers = await this.binance.get24hrTickers();
      const minVolume = Number(process.env.MIN_24H_VOLUME) || 1000000;
      const maxSymbolsEnv = process.env.MAX_SYMBOLS_PER_SCAN !== undefined ? Number(process.env.MAX_SYMBOLS_PER_SCAN) : 0;
      const candleLimit = Number(process.env.CANDLE_LIMIT) || 250;

      // Filter active USDT pairs (exclude leveraged tokens like UP/DOWN/BEAR/BULL)
      const sortedTickers = tickers
        .filter(t => {
          const sym = t.symbol;
          return (
            sym.endsWith('USDT') &&
            !sym.includes('UPUSDT') &&
            !sym.includes('DOWNUSDT') &&
            !sym.includes('BEARUSDT') &&
            !sym.includes('BULLUSDT') &&
            parseFloat(t.quoteVolume) >= minVolume
          );
        })
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

      const validTickers = maxSymbolsEnv > 0 ? sortedTickers.slice(0, maxSymbolsEnv) : sortedTickers;

      Logger.info(
        currentMode,
        'SCAN',
        `Starting 5m scan [${scanId}] across ${validTickers.length} liquid USDT pairs (min 24h vol: $${(minVolume / 1e6).toFixed(1)}M${maxSymbolsEnv > 0 ? `, limit: ${maxSymbolsEnv}` : ', all liquid pairs'})`
      );

      const results: TechnicalAnalysis[] = [];
      let preBullishCount = 0;
      let bullishCount = 0;
      let strongBullishCount = 0;
      let weakeningCount = 0;
      let neutralCount = 0;

      // 2. Scan each symbol using STRICTLY closed candles
      for (const t of validTickers) {
        try {
          const symbol = t.symbol;
          const rawCandles5m = await this.binance.getKlines(symbol, '5m', Math.min(candleLimit, 250));
          const closedCandles5m = filterClosedCandles(rawCandles5m);
          if (closedCandles5m.length < 35) continue;

          // Technical indicators on 5m closed candles
          const ind5m = calculateAllIndicators(closedCandles5m);
          const patterns5m = detectCandlePatterns(closedCandles5m);
          const struct5m = analyzeMarketStructure(closedCandles5m);
          const tf5mSignal = StrategyEngine.analyzeTimeframe(closedCandles5m, '5m');

          // Multi-timeframe: fetch 15m, 1h, 4h closed candles
          let tf15mSignal;
          let tf1hSignal;
          let tf4hSignal;

          try {
            const raw15m = await this.binance.getKlines(symbol, '15m', 60);
            const closed15m = filterClosedCandles(raw15m);
            if (closed15m.length >= 30) {
              tf15mSignal = StrategyEngine.analyzeTimeframe(closed15m, '15m');
            }
          } catch {}

          try {
            const raw1h = await this.binance.getKlines(symbol, '1h', 60);
            const closed1h = filterClosedCandles(raw1h);
            if (closed1h.length >= 30) {
              tf1hSignal = StrategyEngine.analyzeTimeframe(closed1h, '1h');
            }
          } catch {}

          try {
            const raw4h = await this.binance.getKlines(symbol, '4h', 60);
            const closed4h = filterClosedCandles(raw4h);
            if (closed4h.length >= 30) {
              tf4hSignal = StrategyEngine.analyzeTimeframe(closed4h, '4h');
            }
          } catch {}

          const mtf = {
            '5m': tf5mSignal,
            '15m': tf15mSignal,
            '1h': tf1hSignal,
            '4h': tf4hSignal,
          };

          const { score, components } = StrategyEngine.calculateTechnicalScore(
            closedCandles5m,
            ind5m,
            patterns5m,
            struct5m,
            mtf
          );

          const prevAnalysis = Storage.getAnalysis(symbol);
          const currentPrice = parseFloat(t.lastPrice);
          const { state: strategyState, reason: stateReason } = StrategyEngine.evaluateStrategyState(
            {
              symbol,
              price: currentPrice,
              priceChange24h: parseFloat(t.priceChangePercent),
              volume24h: parseFloat(t.volume),
              quoteVolume24h: parseFloat(t.quoteVolume),
              timestamp: Date.now(),
              indicators: ind5m,
              patterns: patterns5m,
              marketStructure: struct5m,
              multiTimeframe: mtf,
              score,
              scoreComponents: components,
              strategyState: 'NEUTRAL',
              stateReason: '',
            },
            prevAnalysis?.strategyState,
            settings
          );

          const analysis: TechnicalAnalysis = {
            symbol,
            price: currentPrice,
            priceChange24h: parseFloat(t.priceChangePercent),
            volume24h: parseFloat(t.volume),
            quoteVolume24h: parseFloat(t.quoteVolume),
            timestamp: Date.now(),
            indicators: ind5m,
            patterns: patterns5m,
            marketStructure: struct5m,
            multiTimeframe: mtf,
            score,
            scoreComponents: components,
            strategyState,
            stateReason,
          };

          Storage.saveAnalysis(symbol, analysis);
          results.push(analysis);

          if (strategyState === 'PRE_BULLISH') preBullishCount++;
          else if (strategyState === 'BULLISH') bullishCount++;
          else if (strategyState === 'STRONG_BULLISH') strongBullishCount++;
          else if (strategyState === 'WEAKENING') weakeningCount++;
          else neutralCount++;

          // 3. Process automated trading decisions if enabled & emergency stop is not active
          if (settings.autoTrading && !Storage.isEmergencyStopActive()) {
            const latestCandleTimestamp = closedCandles5m[closedCandles5m.length - 1]?.timestamp || Date.now();
            await this.processTradingSignal(analysis, prevAnalysis?.strategyState, settings, currentMode, latestCandleTimestamp);
          }
        } catch (symErr: any) {
          // continue with next symbol
        }
      }

      // Refresh positions and wallet balances
      const executor = this.getExecutor(currentMode);
      await executor.getBalance();
      const openPositions = await executor.getOpenPositions();
      const todayTrades = Storage.getTrades(currentMode).filter(
        t => t.closedAt > Date.now() - 24 * 60 * 60 * 1000
      );

      const summary: ScannerSummary = {
        pairsAnalyzed: results.length,
        preBullishCount,
        bullishCount,
        strongBullishCount,
        weakeningCount,
        neutralCount,
        openPositionsCount: openPositions.length,
        todayTradesCount: todayTrades.length,
        lastScanTime: Date.now(),
        nextScanTime: Date.now() + (settings.scanIntervalMs || 300000),
        isScanning: false,
      };

      Storage.updateScannerSummary(summary);
      this.broadcast('scan_completed', { summary, resultsCount: results.length });

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      Logger.info(
        currentMode,
        'SCAN',
        `5m Scan [${scanId}] completed in ${durationSec}s. Analyzed: ${results.length} | Pre-Bullish: ${preBullishCount} | Strong Bullish: ${strongBullishCount} | Weakening: ${weakeningCount}`
      );

      return results;
    } catch (err: any) {
      Logger.error(currentMode, 'SCAN', `Scan cycle failed: ${err.message}`);
      Storage.updateScannerSummary({ isScanning: false, error: err.message });
      throw err;
    } finally {
      this.isScanRunning = false;
    }
  }

  private async processTradingSignal(
    analysis: TechnicalAnalysis,
    previousState: StrategyState | undefined,
    settings: TradingSettings,
    mode: TradingMode,
    candleTimestamp: number
  ): Promise<void> {
    const symbol = analysis.symbol;
    const executor = this.getExecutor(mode);
    const openPosition = Storage.getOpenPositionForSymbol(symbol, mode);

    // -------------------------------------------------------------
    // BUY LOGIC: NEUTRAL -> PRE_BULLISH transition
    // -------------------------------------------------------------
    if (analysis.strategyState === 'PRE_BULLISH' && !openPosition) {
      const fixedAmount = settings.fixedTradeAmount;
      const wallet = Storage.getWallet(mode);
      const openPositions = Storage.getPositions(mode, 'OPEN');
      const symbolFilter = await this.binance.getSymbolFilters(symbol);

      // Deterministic idempotency key based on symbol, timeframe bar, and state
      const signalId = `SIG-${mode}-${symbol}-${candleTimestamp}-${analysis.strategyState}`;
      const clientOrderId = `AUTO-${mode}-${symbol}-${Date.now().toString(36)}`;

      const orderRequest = {
        symbol,
        side: 'BUY' as const,
        quoteAmount: fixedAmount, // Strict invariant: exactly fixed trade amount
        reason: `Auto-trader: PRE_BULLISH setup confirmed (Score: ${analysis.score} >= ${settings.preBullishScoreMin}).`,
        strategyState: analysis.strategyState,
        technicalScore: analysis.score,
        clientOrderId,
      };

      const safetyResult = SafetyGate.validateBuy(
        orderRequest,
        mode,
        settings,
        wallet,
        openPositions,
        symbolFilter,
        analysis.price,
        Storage.isEmergencyStopActive(),
        signalId
      );

      if (!safetyResult.allowed) {
        Logger.warn(
          mode,
          'STRATEGY',
          `BUY Signal blocked by Safety Gate for ${symbol}: ${safetyResult.reason}`,
          {
            symbol,
            strategyState: analysis.strategyState,
            technicalScore: analysis.score,
          }
        );
        return;
      }

      Logger.info(
        mode,
        'STRATEGY',
        `BUY SIGNAL AUTHORIZED: ${symbol} | Fixed Amount: ${fixedAmount} USDT | Score: ${analysis.score}`,
        {
          symbol,
          strategyState: analysis.strategyState,
          technicalScore: analysis.score,
        }
      );

      try {
        const execResult = await executor.buy(orderRequest);
        if (execResult.success) {
          Storage.recordIdempotencyKey(signalId, execResult.order.id, clientOrderId);
          this.broadcast('order_executed', { mode, order: execResult.order, position: execResult.position });
        }
      } catch (err: any) {
        Logger.error(mode, 'ORDER', `Execution of BUY failed for ${symbol}: ${err.message}`, {
          symbol,
          strategyState: analysis.strategyState,
          technicalScore: analysis.score,
        });
      }
      return;
    }

    // -------------------------------------------------------------
    // SELL LOGIC: STRONG_BULLISH -> WEAKENING transition
    // -------------------------------------------------------------
    if (openPosition && (analysis.strategyState === 'WEAKENING' || analysis.strategyState === 'EXIT')) {
      const clientOrderId = `AUTO-${mode}-SELL-${symbol}-${Date.now().toString(36)}`;
      const orderRequest = {
        symbol,
        side: 'SELL' as const,
        quantity: openPosition.remainingQuantity, // Sell entire strategy-owned position
        reason: `Auto-trader: Strong bullish momentum weakened (Score: ${analysis.score}, State: ${analysis.strategyState}). Exiting full position.`,
        strategyState: analysis.strategyState,
        technicalScore: analysis.score,
        clientOrderId,
      };

      const symbolFilter = await this.binance.getSymbolFilters(symbol);
      const safetyResult = SafetyGate.validateSell(
        orderRequest,
        openPosition,
        mode,
        Storage.isEmergencyStopActive(),
        symbolFilter,
        analysis.price
      );

      if (!safetyResult.allowed) {
        Logger.warn(
          mode,
          'STRATEGY',
          `SELL Signal blocked by Safety Gate for ${symbol}: ${safetyResult.reason}`,
          {
            symbol,
            strategyState: analysis.strategyState,
            technicalScore: analysis.score,
          }
        );
        return;
      }

      Logger.info(
        mode,
        'STRATEGY',
        `SELL SIGNAL AUTHORIZED: ${symbol} | Qty: ${openPosition.remainingQuantity} | Reason: Momentum weakening`,
        {
          symbol,
          strategyState: analysis.strategyState,
          technicalScore: analysis.score,
        }
      );

      try {
        const execResult = await executor.sell(orderRequest, openPosition.id);
        if (execResult.success) {
          this.broadcast('order_executed', { mode, order: execResult.order, trade: execResult.trade });
        }
      } catch (err: any) {
        Logger.error(mode, 'ORDER', `Execution of SELL failed for ${symbol}: ${err.message}`, {
          symbol,
          strategyState: analysis.strategyState,
          technicalScore: analysis.score,
        });
      }
      return;
    }

    // -------------------------------------------------------------
    // HOLD STATUS: Update open position metrics
    // -------------------------------------------------------------
    if (openPosition) {
      openPosition.currentPrice = analysis.price;
      openPosition.currentScore = analysis.score;
      openPosition.currentState = analysis.strategyState;
      openPosition.unrealizedPnL = Number(((analysis.price - openPosition.entryPrice) * openPosition.remainingQuantity).toFixed(4));
      openPosition.unrealizedPnLPercent = Number((((analysis.price - openPosition.entryPrice) / openPosition.entryPrice) * 100).toFixed(2));
      openPosition.updatedAt = Date.now();
      Storage.savePosition(openPosition);
    }
  }
}
