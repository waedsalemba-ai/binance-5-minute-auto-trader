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
import { calculateAllIndicators } from './indicators.ts';
import { detectCandlePatterns } from './pattern-detector.ts';
import { analyzeMarketStructure } from './market-structure.ts';
import { StrategyEngine } from './strategy-engine.ts';
import { SafetyGate } from './safety-gate.ts';
import { PaperTradingExecutor, RealBinanceTradingExecutor, TradingExecutor } from './trading-executor.ts';
import { Logger } from './logger.ts';
import {
  evaluateExitDecision,
  calculatePositionNetPnL,
  calculateBreakEvenExitPrice,
  calculateTargetExitPrice,
} from './exit-decision-engine.ts';
import { evaluateEntryEligibility } from './entry-decision-engine.ts';

type StateUpdateListener = (data: { type: string; payload: any }) => void;

export class AutoTradingEngine {
  private static instance: AutoTradingEngine;
  private binance = BinanceRequestManager.getInstance();
  private paperExecutor = new PaperTradingExecutor();
  private realExecutor = new RealBinanceTradingExecutor();
  private scanTimer: NodeJS.Timeout | null = null;
  private isScanRunning = false;
  private isEmergencyStopped = false;
  private pendingBuyLocks = new Set<string>();
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
    return this.isEmergencyStopped;
  }

  public setEmergencyStop(active: boolean): void {
    this.isEmergencyStopped = active;
    if (active) {
      // Turn off auto-trading in settings
      Storage.updateSettings({ autoTrading: false });
      Logger.warn(
        Storage.getSettings().mode,
        'SECURITY',
        'EMERGENCY STOP ACTIVATED! Automatic trading halted immediately. Existing positions remain open.'
      );
    } else {
      Logger.info(
        Storage.getSettings().mode,
        'SECURITY',
        'Emergency stop cleared by user.'
      );
    }
    this.broadcast('emergency_stop_changed', { isEmergencyStopped: this.isEmergencyStopped });
  }

  public startScheduler(): void {
    if (this.scanTimer) return;
    const settings = Storage.getSettings();
    const intervalMs = settings.scanIntervalMs || 120000; // 2 minutes

    Logger.info('PAPER', 'SCAN', `AutoTrading scheduler initialized with ${intervalMs / 1000}s interval (2m).`);

    // Run first scan shortly after startup
    setTimeout(() => {
      this.runScanCycle().catch(err => Logger.error('PAPER', 'SCAN', `Initial scan error: ${err.message}`));
    }, 2000);

    this.scanTimer = setInterval(() => {
      this.runScanCycle().catch(err => Logger.error('PAPER', 'SCAN', `Scan cycle error: ${err.message}`));
    }, intervalMs);
  }

  public stopScheduler(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  public async runScanCycle(): Promise<TechnicalAnalysis[]> {
    if (this.isScanRunning) {
      Logger.warn('PAPER', 'SCAN', 'Previous scan cycle still active, skipping overlapping trigger.');
      return Storage.getAllAnalysis();
    }

    this.isScanRunning = true;
    const startTime = Date.now();
    const settings = Storage.getSettings();
    const currentMode = settings.mode;

    Storage.updateScannerSummary({ isScanning: true, lastScanTime: startTime });
    this.broadcast('scanner_started', { timestamp: startTime });

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
        `Starting 2m scan across ${validTickers.length} liquid USDT pairs (min 24h vol: $${(minVolume / 1e6).toFixed(1)}M${maxSymbolsEnv > 0 ? `, limit: ${maxSymbolsEnv}` : ', all liquid pairs'})`
      );

      const results: TechnicalAnalysis[] = [];
      let preBullishCount = 0;
      let bullishCount = 0;
      let strongBullishCount = 0;
      let weakeningCount = 0;
      let neutralCount = 0;

      // 2. Scan each symbol
      for (const t of validTickers) {
        try {
          const symbol = t.symbol;
          const candles5m = await this.binance.getKlines(symbol, '5m', Math.min(candleLimit, 250));
          if (candles5m.length < 35) continue;

          // Technical indicators on 5m
          const ind5m = calculateAllIndicators(candles5m);
          const patterns5m = detectCandlePatterns(candles5m);
          const struct5m = analyzeMarketStructure(candles5m);
          const tf5mSignal = StrategyEngine.analyzeTimeframe(candles5m, '5m');

          // Multi-timeframe: fetch 15m, 1h, 4h
          let tf15mSignal;
          let tf1hSignal;
          let tf4hSignal;

          try {
            const candles15m = await this.binance.getKlines(symbol, '15m', 60);
            if (candles15m.length >= 30) {
              tf15mSignal = StrategyEngine.analyzeTimeframe(candles15m, '15m');
            }
          } catch {}

          try {
            const candles1h = await this.binance.getKlines(symbol, '1h', 60);
            if (candles1h.length >= 30) {
              tf1hSignal = StrategyEngine.analyzeTimeframe(candles1h, '1h');
            }
          } catch {}

          try {
            const candles4h = await this.binance.getKlines(symbol, '4h', 60);
            if (candles4h.length >= 30) {
              tf4hSignal = StrategyEngine.analyzeTimeframe(candles4h, '4h');
            }
          } catch {}

          const mtf = {
            '5m': tf5mSignal,
            '15m': tf15mSignal,
            '1h': tf1hSignal,
            '4h': tf4hSignal,
          };

          const { score, components } = StrategyEngine.calculateTechnicalScore(
            candles5m,
            ind5m,
            patterns5m,
            struct5m,
            mtf
          );

          const prevAnalysis = Storage.getAnalysis(symbol);
          const { state: strategyState, reason: stateReason } = StrategyEngine.evaluateStrategyState(
            {
              symbol,
              price: parseFloat(t.lastPrice),
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
            price: parseFloat(t.lastPrice),
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

          // 3. Process automated trading decisions if enabled
          if (settings.autoTrading && !this.isEmergencyStopped) {
            await this.processTradingSignal(analysis, prevAnalysis?.strategyState, settings, currentMode);
          }
        } catch (symErr: any) {
          // continue with next symbol
        }
      }

      // 4. Ensure all active open positions are audited every cycle even if not in the volume ticker list
      if (settings.autoTrading && !this.isEmergencyStopped) {
        const openPositionsToAudit = Storage.getPositions(currentMode, 'OPEN');
        const scannedSymbols = new Set(validTickers.map(t => t.symbol));
        for (const pos of openPositionsToAudit) {
          if (!scannedSymbols.has(pos.symbol)) {
            try {
              let posAnalysis = Storage.getAnalysis(pos.symbol);
              if (!posAnalysis) {
                const livePrice = await this.binance.getLatestPrice(pos.symbol);
                posAnalysis = {
                  symbol: pos.symbol,
                  price: livePrice || pos.currentPrice,
                  priceChange24h: 0,
                  volume24h: 0,
                  quoteVolume24h: 0,
                  timestamp: Date.now(),
                  indicators: calculateAllIndicators([]),
                  patterns: [],
                  marketStructure: { trend: 'CONSOLIDATION', structure: 'NEUTRAL', breakout: 'NONE', supportLevels: [], resistanceLevels: [], swingHighs: [], swingLows: [] },
                  multiTimeframe: { '5m': { timeframe: '5m', trend: 'NEUTRAL', score: pos.currentScore, rsi: 50, macdCross: 'NONE' } },
                  score: pos.currentScore,
                  scoreComponents: [],
                  strategyState: pos.currentState,
                  stateReason: 'Direct open position audit',
                };
              }
              await this.evaluateAndProcessPositionExit(pos, posAnalysis, settings, currentMode);
            } catch (auditErr: any) {
              Logger.warn(currentMode, 'STRATEGY', `Open position audit error for ${pos.symbol}: ${auditErr.message}`);
            }
          }
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
        nextScanTime: Date.now() + (settings.scanIntervalMs || 120000),
        isScanning: false,
      };

      Storage.updateScannerSummary(summary);
      this.broadcast('scan_completed', { summary, resultsCount: results.length });

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      Logger.info(
        currentMode,
        'SCAN',
        `2m Scan completed in ${durationSec}s. Analyzed: ${results.length} | Pre-Bullish: ${preBullishCount} | Strong Bullish: ${strongBullishCount} | Weakening: ${weakeningCount}`
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
    mode: TradingMode
  ): Promise<void> {
    const symbol = analysis.symbol;
    const executor = this.getExecutor(mode);
    const openPosition = Storage.getOpenPositionForSymbol(symbol, mode);
    const lockKey = `${mode}:${symbol}`;
    const isPendingEntry = this.pendingBuyLocks.has(lockKey);
    const cooldownCheck = Storage.isSymbolInCooldown(symbol, mode);

    // -------------------------------------------------------------
    // 1. POSITION MANAGEMENT & EXIT ARCHITECTURE (IF POSITION OPEN)
    // -------------------------------------------------------------
    if (openPosition && openPosition.status === 'OPEN') {
      await this.evaluateAndProcessPositionExit(openPosition, analysis, settings, mode);
      return;
    }

    // -------------------------------------------------------------
    // 2. CENTRALIZED ENTRY DECISION EVALUATION (IF NO POSITION)
    // -------------------------------------------------------------
    const entryDecision = evaluateEntryEligibility({
      symbol,
      strategyState: analysis.strategyState,
      technicalScore: analysis.score,
      hasOpenPosition: !!openPosition,
      isPendingEntry,
      isEmergencyStopped: this.isEmergencyStopped,
      isInCooldown: cooldownCheck.inCooldown,
      settings,
    });

    if (!entryDecision.eligible) {
      // Log blocked or skipped entry for informative diagnostic tracking
      if (analysis.strategyState === 'PRE_BULLISH' || analysis.strategyState === 'STRONG_BULLISH') {
        Logger.info(
          mode,
          'STRATEGY',
          `Entry check for ${symbol}: ${entryDecision.reason}`,
          {
            symbol,
            strategyState: analysis.strategyState,
            technicalScore: analysis.score,
          }
        );
      }
      return;
    }

    // Acquire atomic per-symbol entry lock to prevent duplicate BUY in flight
    this.pendingBuyLocks.add(lockKey);

    try {
      const fixedAmount = settings.fixedTradeAmount;
      const wallet = Storage.getWallet(mode);
      const openPositions = Storage.getPositions(mode, 'OPEN');
      const symbolFilter = await this.binance.getSymbolFilters(symbol);

      const clientOrderId = `AUTO-${mode}-${symbol}-${Date.now().toString(36)}`;
      const orderRequest = {
        symbol,
        side: 'BUY' as const,
        quoteAmount: fixedAmount, // Strict invariant: exactly fixed trade amount
        reason: entryDecision.reason,
        strategyState: entryDecision.strategyState,
        technicalScore: entryDecision.technicalScore,
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
        this.isEmergencyStopped
      );

      if (!safetyResult.allowed) {
        Logger.warn(
          mode,
          'STRATEGY',
          `BUY Signal blocked by Safety Gate for ${symbol}: ${safetyResult.reason}`,
          {
            symbol,
            strategyState: entryDecision.strategyState,
            technicalScore: entryDecision.technicalScore,
          }
        );
        return;
      }

      Logger.info(
        mode,
        'STRATEGY',
        `BUY SIGNAL TRIGGERED: ${symbol} (${entryDecision.strategyState}) | Fixed Amount: ${fixedAmount} USDT | Score: ${entryDecision.technicalScore}`,
        {
          symbol,
          strategyState: entryDecision.strategyState,
          technicalScore: entryDecision.technicalScore,
        }
      );

      const execResult = await executor.buy(orderRequest);
      if (execResult.success) {
        this.broadcast('order_executed', { mode, order: execResult.order, position: execResult.position });
      }
    } catch (err: any) {
      Logger.error(mode, 'ORDER', `Execution of BUY failed for ${symbol}: ${err.message}`, {
        symbol,
        strategyState: entryDecision.strategyState,
        technicalScore: entryDecision.technicalScore,
      });
    } finally {
      // Release atomic lock regardless of outcome
      this.pendingBuyLocks.delete(lockKey);
    }
  }

  public async evaluateAndProcessPositionExit(
    position: Position,
    analysis: TechnicalAnalysis,
    settings: TradingSettings,
    mode: TradingMode
  ): Promise<void> {
    const symbol = position.symbol;
    const executor = this.getExecutor(mode);

    // 1. Fetch fresh live Binance market price
    let freshPrice = analysis.price;
    let priceTimestamp = analysis.timestamp;
    try {
      const livePrice = await this.binance.getLatestPrice(symbol);
      if (livePrice && livePrice > 0) {
        freshPrice = livePrice;
        priceTimestamp = Date.now();
      }
    } catch {
      // Fall back to analysis.price
    }

    // 2. Authoritative Exit Decision Evaluation
    const exitDecision = evaluateExitDecision({
      position,
      currentPrice: freshPrice,
      priceTimestamp,
      strategyState: analysis.strategyState,
      technicalScore: analysis.score,
      settings,
      isEmergencyStopped: this.isEmergencyStopped,
    });

    // 3. Update Position state with enriched metrics
    position.currentPrice = freshPrice;
    position.currentScore = analysis.score;
    position.currentState = analysis.strategyState;
    position.grossPnL = exitDecision.grossPnL;
    position.unrealizedPnL = exitDecision.grossPnL;
    position.unrealizedPnLPercent = Number((((freshPrice - position.entryPrice) / position.entryPrice) * 100).toFixed(2));
    position.estimatedNetPnL = exitDecision.netPnL;
    position.estimatedNetPnLPercent = exitDecision.netPnLPercent;
    position.breakEvenPrice = exitDecision.breakEvenPrice;
    position.takeProfitPrice = exitDecision.takeProfitPrice;
    position.stopLossPrice = exitDecision.stopLossPrice;
    position.exitReason = exitDecision.reason;
    position.exitStatus = exitDecision.shouldSell
      ? 'CLOSING'
      : exitDecision.reason === 'TAKE_PROFIT'
      ? 'WAITING_TP'
      : exitDecision.reason === 'STOP_LOSS'
      ? 'WAITING_SL'
      : 'HOLD';
    position.updatedAt = Date.now();
    Storage.savePosition(position);

    // Log the Exit Check
    Logger.info(mode, 'STRATEGY', exitDecision.logMessage, {
      symbol,
      strategyState: analysis.strategyState,
      technicalScore: analysis.score,
      details: {
        price: freshPrice,
        entry: position.entryPrice,
        netPnLPercent: exitDecision.netPnLPercent,
        decision: exitDecision.shouldSell ? 'SELL' : 'HOLD',
        reason: exitDecision.reason,
      },
    });

    // 4. If SELL decision is authorized
    if (exitDecision.shouldSell) {
      const clientOrderId = `AUTO-${mode}-SELL-${symbol}-${Date.now().toString(36)}`;
      const orderRequest = {
        symbol,
        side: 'SELL' as const,
        quantity: position.remainingQuantity,
        reason: `Auto-trader Exit: ${exitDecision.reason} (Net PnL: ${exitDecision.netPnLPercent >= 0 ? '+' : ''}${exitDecision.netPnLPercent}%, State: ${analysis.strategyState}, Score: ${analysis.score}).`,
        strategyState: analysis.strategyState,
        technicalScore: analysis.score,
        clientOrderId,
      };

      const safetyResult = SafetyGate.validateSell(
        orderRequest,
        position,
        mode,
        this.isEmergencyStopped
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

      // Pre-Execution Price Gap Protection: re-verify price right before submitting
      try {
        const preExecPrice = await this.binance.getLatestPrice(symbol);
        if (preExecPrice && preExecPrice > 0) {
          const reCheckDecision = evaluateExitDecision({
            position,
            currentPrice: preExecPrice,
            priceTimestamp: Date.now(),
            strategyState: analysis.strategyState,
            technicalScore: analysis.score,
            settings,
            isEmergencyStopped: this.isEmergencyStopped,
          });

          if (!reCheckDecision.shouldSell) {
            Logger.warn(
              mode,
              'STRATEGY',
              `SELL ABORTED due to pre-execution price gap for ${symbol}. Decision reversed to ${reCheckDecision.reason} (Net PnL: ${reCheckDecision.netPnLPercent}%).`,
              {
                symbol,
                strategyState: analysis.strategyState,
                technicalScore: analysis.score,
                details: { preExecPrice, netPnLPercent: reCheckDecision.netPnLPercent },
              }
            );
            return;
          }
        }
      } catch {
        // proceed if single price ping fails
      }

      Logger.info(
        mode,
        'STRATEGY',
        `AUTOMATIC SELL EXECUTING: ${symbol} | Reason: ${exitDecision.reason} | Estimated Net PnL: ${exitDecision.netPnLPercent}% | Qty: ${position.remainingQuantity}`,
        {
          symbol,
          strategyState: analysis.strategyState,
          technicalScore: analysis.score,
          details: {
            exitReason: exitDecision.reason,
            netPnLPercent: exitDecision.netPnLPercent,
          },
        }
      );

      try {
        const execResult = await executor.sell(orderRequest, position.id);
        if (execResult.success) {
          this.broadcast('order_executed', { mode, order: execResult.order, trade: execResult.trade, position: execResult.position });
        }
      } catch (err: any) {
        Logger.error(mode, 'ORDER', `Execution of SELL failed for ${symbol}: ${err.message}`, {
          symbol,
          strategyState: analysis.strategyState,
          technicalScore: analysis.score,
        });
      }
    }
  }
}
