import {
  TradingMode,
  TechnicalAnalysis,
  Position,
  TradingSettings,
  ScannerSummary,
  StrategyState,
  ServerEngineStatus,
  DecisionAuditRecord,
} from '../types/index.ts';
import { Storage } from './storage.ts';
import { BinanceRequestManager } from './binance-client.ts';
import { BinanceSymbolValidator } from './symbol-validator.ts';
import { BinanceTimeService } from './binance-time.ts';
import { calculateAllIndicators } from './indicators.ts';
import { detectCandlePatterns } from './pattern-detector.ts';
import { analyzeMarketStructure } from './market-structure.ts';
import { StrategyEngine } from './strategy-engine.ts';
import { SafetyGate } from './safety-gate.ts';
import { PaperTradingExecutor, RealBinanceTradingExecutor, TradingExecutor } from './trading-executor.ts';
import { Logger } from './logger.ts';
import { evaluateExitDecision } from './exit-decision-engine.ts';
import {
  evaluateEntryEligibility,
  BuyAuthorizationService,
} from './entry-decision-engine.ts';
import { CandidateRankInfo, BuyAuthorizationResult } from '../types/index.ts';

type StateUpdateListener = (data: { type: string; payload: any }) => void;

export class AutoTradingEngine {
  private static instance: AutoTradingEngine;
  private binance = BinanceRequestManager.getInstance();
  private paperExecutor = new PaperTradingExecutor();
  private realExecutor = new RealBinanceTradingExecutor();
  private scanTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private isScanRunning = false;
  private scanStartTime = 0;
  private isEmergencyStopped = false;
  private pendingBuyLocks = new Set<string>();
  private listeners = new Set<StateUpdateListener>();
  private isEngineRunning = false;

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
    return Storage.isEmergencyStopped();
  }

  public setEmergencyStop(active: boolean): void {
    Storage.setEmergencyStopped(active);
    if (active) {
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
    this.broadcast('emergency_stop_changed', { isEmergencyStopped: active });
  }

  /**
   * Starts the 24/7 server-side trading engine.
   * Runs independently of browser/frontend connection.
   */
  public async start(): Promise<void> {
    if (this.isEngineRunning) return;
    this.isEngineRunning = true;
    Logger.info('PAPER', 'SCAN', 'Initializing 24/7 server-side AutoTradingEngine and Binance services...');

    // 1. Synchronize Binance server time
    try {
      await BinanceTimeService.getInstance().syncWithBinance();
    } catch (err: any) {
      Logger.warn('PAPER', 'BINANCE', `Initial Binance time sync notice: ${err.message}`);
    }

    // 2. Warm up Binance Spot exchange metadata
    try {
      await BinanceSymbolValidator.getInstance().ensureFreshMetadata('SPOT');
    } catch (err: any) {
      Logger.warn('PAPER', 'BINANCE', `Initial Spot metadata warmup notice: ${err.message}`);
    }

    // 3. Start scan scheduler & watchdog
    this.startScheduler();
    this.startWatchdog();

    Storage.updateEngineTelemetry({
      engineStatus: 'RUNNING',
      schedulerStatus: 'RUNNING',
      watchdogStatus: 'RUNNING',
    });
  }

  /**
   * Stops the trading engine scheduler and watchdog.
   */
  public stop(): void {
    this.isEngineRunning = false;
    this.stopScheduler();
    this.stopWatchdog();
    Storage.updateEngineTelemetry({
      engineStatus: 'STOPPED',
      schedulerStatus: 'STOPPED',
      watchdogStatus: 'STOPPED',
    });
    Logger.info('PAPER', 'SCAN', 'AutoTradingEngine stopped.');
  }

  public isRunning(): boolean {
    return this.isEngineRunning && this.scanTimer !== null;
  }

  public startScheduler(): void {
    if (this.scanTimer) return;
    const settings = Storage.getSettings();
    const intervalMs = settings.scanIntervalMs || 120000; // 2 minutes default

    Logger.info('PAPER', 'SCAN', `AutoTrading scheduler initialized with ${intervalMs / 1000}s interval (2m).`);

    // Run first scan shortly after startup
    setTimeout(() => {
      this.runScanCycle().catch(err => Logger.error('PAPER', 'SCAN', `Initial scan error: ${err.message}`));
    }, 2000);

    this.scanTimer = setInterval(() => {
      this.runScanCycle().catch(err => Logger.error('PAPER', 'SCAN', `Scan cycle error: ${err.message}`));
    }, intervalMs);

    Storage.updateEngineTelemetry({ schedulerStatus: 'RUNNING' });
  }

  public stopScheduler(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    Storage.updateEngineTelemetry({ schedulerStatus: 'STOPPED' });
  }

  /**
   * Server-side Watchdog Monitor: runs every 30s to detect stalled cycles or drift.
   */
  public startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      this.runWatchdogCheck().catch(() => {});
    }, 30000);
    Storage.updateEngineTelemetry({ watchdogStatus: 'RUNNING' });
  }

  public stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    Storage.updateEngineTelemetry({ watchdogStatus: 'STOPPED' });
  }

  private async runWatchdogCheck(): Promise<void> {
    const now = Date.now();
    const settings = Storage.getSettings();
    const telemetry = Storage.getEngineTelemetry();

    // 1. Stuck scan cycle detection (> 5 minutes)
    if (this.isScanRunning && this.scanStartTime > 0 && now - this.scanStartTime > 300000) {
      Logger.warn(settings.mode, 'SCAN', 'Watchdog detected a stalled scan cycle (> 5m). Forcibly unlocking scan lock.');
      this.isScanRunning = false;
      this.scanStartTime = 0;
    }

    // 2. Scheduler restart if autoTrading is enabled but scheduler stopped
    if (settings.autoTrading && !this.scanTimer && this.isEngineRunning) {
      Logger.warn(settings.mode, 'SCAN', 'Watchdog detected autoTrading is enabled but scheduler timer was null. Restarting scheduler...');
      this.startScheduler();
    }

    // 3. Binance Clock Drift Check
    const timeService = BinanceTimeService.getInstance();
    if (!timeService.isSafeDrift()) {
      Logger.warn(settings.mode, 'BINANCE', `Watchdog detected clock drift (${timeService.getOffset()}ms). Resyncing...`);
      await timeService.syncWithBinance().catch(() => {});
    }

    // 4. Spot metadata validation cache verification
    const validator = BinanceSymbolValidator.getInstance();
    if (validator.getSpotMarketTelemetry().symbolsCount === 0) {
      Logger.warn(settings.mode, 'BINANCE', 'Watchdog detected empty Spot symbol cache. Refreshing metadata...');
      await validator.ensureFreshMetadata('SPOT', true).catch(() => {});
    }

    // Update telemetry
    Storage.updateEngineTelemetry({
      engineStatus: this.isEngineRunning ? 'RUNNING' : 'STOPPED',
      schedulerStatus: this.scanTimer ? 'RUNNING' : 'STOPPED',
      watchdogStatus: this.watchdogTimer ? 'RUNNING' : 'STOPPED',
    });
  }

  /**
   * Main Market Scanning & Automated 5m Strategy Execution Loop.
   */
  public async runScanCycle(): Promise<TechnicalAnalysis[]> {
    if (this.isScanRunning) {
      Logger.warn('PAPER', 'SCAN', 'Previous scan cycle still active, skipping overlapping trigger.');
      return Storage.getAllAnalysis();
    }

    this.isScanRunning = true;
    this.scanStartTime = Date.now();
    const startTime = this.scanStartTime;
    const settings = Storage.getSettings();
    const currentMode = settings.mode;

    Storage.updateScannerSummary({ isScanning: true, lastScanTime: startTime });
    Storage.updateEngineTelemetry({ lastScanAt: startTime });
    this.broadcast('scanner_started', { timestamp: startTime });

    try {
      // 1. Build the scanner universe from authoritative Binance Spot exchangeInfo
      //    and use 24hr ticker data ONLY for liquidity/ranking. This prevents
      //    legacy/delisted/non-Spot symbols from ever entering automatic trading.
      const validator = BinanceSymbolValidator.getInstance();
      const authoritativeUsdtSymbols = await validator.getTradableSpotUsdtSymbols();
      const tickers = await this.binance.get24hrTickers();
      const minVolume = Number(process.env.MIN_24H_VOLUME) || 1000000;
      const maxSymbolsEnv = process.env.MAX_SYMBOLS_PER_SCAN !== undefined ? Number(process.env.MAX_SYMBOLS_PER_SCAN) : 0;
      const candleLimit = Number(process.env.CANDLE_LIMIT) || 250;

      const sortedTickers = tickers
        .filter(t => {
          const sym = String(t.symbol || '').trim().toUpperCase();
          return (
            authoritativeUsdtSymbols.has(sym) &&
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
        `Starting authoritative Binance Spot scan across ${validTickers.length} liquid USDT pairs (min 24h vol: $${(minVolume / 1e6).toFixed(1)}M${maxSymbolsEnv > 0 ? `, limit: ${maxSymbolsEnv}` : ', all liquid pairs'})`
      );

      const results: TechnicalAnalysis[] = [];
      let preBullishCount = 0;
      let bullishCount = 0;
      let strongBullishCount = 0;
      let weakeningCount = 0;
      let neutralCount = 0;

      // 2. Scan each liquid Spot symbol
      for (const t of validTickers) {
        try {
          const symbol = t.symbol;
          const candles5m = await this.binance.getKlines(symbol, '5m', Math.min(candleLimit, 250));
          if (candles5m.length < 35) continue;

          // =========================================================================
          // CRITICAL: 5-MINUTE CLOSED CANDLE INVARIANT
          // Binance returns the currently forming, unfinished candle at [length - 1].
          // Strategy indicators, patterns, and ENTRY signals MUST evaluate the
          // latest CLOSED candle at [length - 2].
          // =========================================================================
          const closedCandles5m = candles5m.slice(0, candles5m.length - 1);
          const latestClosedCandle = closedCandles5m[closedCandles5m.length - 1];
          const closedCandleCloseTime = latestClosedCandle.closeTime;

          Storage.updateEngineTelemetry({ lastClosed5mCandleAt: closedCandleCloseTime });

          // Technical indicators computed on CLOSED candles
          const ind5m = calculateAllIndicators(closedCandles5m);
          const patterns5m = detectCandlePatterns(closedCandles5m);
          const struct5m = analyzeMarketStructure(closedCandles5m);
          const tf5mSignal = StrategyEngine.analyzeTimeframe(closedCandles5m, '5m');

          // Multi-timeframe trend confirmation: fetch 15m, 1h, 4h (using closed candles)
          let tf15mSignal;
          let tf1hSignal;
          let tf4hSignal;

          try {
            const candles15m = await this.binance.getKlines(symbol, '15m', 60);
            if (candles15m.length >= 30) {
              const closed15m = candles15m.slice(0, candles15m.length - 1);
              tf15mSignal = StrategyEngine.analyzeTimeframe(closed15m, '15m');
            }
          } catch {}

          try {
            const candles1h = await this.binance.getKlines(symbol, '1h', 60);
            if (candles1h.length >= 30) {
              const closed1h = candles1h.slice(0, candles1h.length - 1);
              tf1hSignal = StrategyEngine.analyzeTimeframe(closed1h, '1h');
            }
          } catch {}

          try {
            const candles4h = await this.binance.getKlines(symbol, '4h', 60);
            if (candles4h.length >= 30) {
              const closed4h = candles4h.slice(0, candles4h.length - 1);
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

          // Open positions are processed for exit in real time
          const openPosition = Storage.getOpenPositionForSymbol(symbol, currentMode);
          if (openPosition && openPosition.status === 'OPEN' && settings.autoTrading && !this.isEmergencyStopped) {
            Storage.updateEngineTelemetry({ lastExitEvaluationAt: Date.now() });
            await this.evaluateAndProcessPositionExit(openPosition, analysis, settings, currentMode);
          }
        } catch (symErr: any) {
          // continue with next symbol
        }
      }

      // 3. Process candidate evaluation, strict authorization, and ranking (Phases 2, 3, 4, 5, 7, 8)
      if (settings.autoTrading && !this.isEmergencyStopped) {
        await this.processScanCandidates(results, settings, currentMode);
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
      Storage.updateEngineTelemetry({ lastSuccessfulScanAt: Date.now() });
      this.broadcast('scan_completed', { summary, resultsCount: results.length });

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      Logger.info(
        currentMode,
        'SCAN',
        `Binance Spot scan completed in ${durationSec}s. Analyzed: ${results.length} | Pre-Bullish: ${preBullishCount} | Strong Bullish: ${strongBullishCount} | Weakening: ${weakeningCount}`
      );

      return results;
    } catch (err: any) {
      Logger.error(currentMode, 'SCAN', `Scan cycle failed: ${err.message}`);
      Storage.updateScannerSummary({ isScanning: false, error: err.message });
      throw err;
    } finally {
      this.isScanRunning = false;
      this.scanStartTime = 0;
    }
  }

  /**
   * PHASES 2, 3, 4, 5, 7, 8:
   * Evaluate all candidates, strictly authorize each, rank qualified candidates,
   * reserve capacity up to maxOpenPositions, and execute authorized BUYs in rank order.
   */
  public async processScanCandidates(
    analyses: TechnicalAnalysis[],
    settings: TradingSettings,
    mode: TradingMode
  ): Promise<void> {
    if (this.isEmergencyStopped || !settings.autoTrading) return;

    Storage.updateEngineTelemetry({ lastEntryEvaluationAt: Date.now() });

    // 1. Gather all candidates that have bullish signals and no existing position
    const candidateAuthorizations: BuyAuthorizationResult[] = [];
    const openPositions = Storage.getPositions(mode, 'OPEN');
    const openPositionSymbols = new Set(openPositions.map(p => p.symbol));
    const wallet = Storage.getWallet(mode);

    for (const analysis of analyses) {
      const symbol = analysis.symbol;
      
      // Skip if position already open (exit engine handles open positions)
      if (openPositionSymbols.has(symbol)) {
        continue;
      }

      // Check candle deduplication: if this closed 5m candle was already evaluated for this symbol, skip
      const lastEvaluatedCandleTime = Storage.getLastEvaluatedCandle(symbol);
      const candleCloseTime = analysis.timestamp;
      if (lastEvaluatedCandleTime && candleCloseTime <= lastEvaluatedCandleTime) {
        continue;
      }

      let symbolFilter;
      try {
        symbolFilter = await this.binance.getSymbolFilters(symbol);
      } catch {}

      // Authoritative deterministic BUY authorization evaluation
      const authResult = await BuyAuthorizationService.authorizeBuy({
        symbol,
        mode,
        analysis,
        settings,
        wallet,
        openPositions,
        symbolFilter,
        closedCandleCloseTime: candleCloseTime,
        isEmergencyStopped: this.isEmergencyStopped,
      });

      candidateAuthorizations.push(authResult);

      // Save decision audit for rejected candidates immediately
      if (!authResult.authorized) {
        Storage.setLastEvaluatedCandle(symbol, candleCloseTime);
        Storage.saveDecisionAudit({
          timestamp: authResult.evaluatedAt,
          symbol,
          candleTimestamp: authResult.marketDataTimestamp,
          timeframe: '5m',
          score5m: authResult.technicalScore,
          score15m: authResult.confirmationScore15m,
          rsi: analysis.indicators?.rsi14?.slice(-1)[0],
          price: authResult.entryPrice,
          trend: analysis.marketStructure?.trend || 'NEUTRAL',
          signalState: authResult.strategyState,
          decision: 'REJECTED',
          rejectionReason: authResult.rejectionReasons.join('; '),
          mode,
          tradeAmount: settings.fixedTradeAmount,
          passedChecks: authResult.passedChecks,
          failedChecks: authResult.failedChecks,
          qualified: false,
          orderSubmissionResult: 'REJECTED',
        });
      }
    }

    // 2. Rank ONLY candidates that passed every single mandatory check (Phase 5)
    const rankedCandidates = BuyAuthorizationService.rankQualifiedCandidates(candidateAuthorizations);

    if (rankedCandidates.length === 0) {
      return;
    }

    Logger.info(
      mode,
      'STRATEGY',
      `Identified ${rankedCandidates.length} fully qualified candidate(s) from scan universe: ${rankedCandidates.map(c => `${c.symbol} (Rank #${c.rank}, Score ${c.authorization.technicalScore})`).join(', ')}`
    );

    // 3. Check position capacity limit (Phase 4):
    // "maxOpenPositions" is exclusively a hard upper bound.
    // Buy only up to remaining capacity. Unused capacity remains unused if fewer candidates qualify.
    for (const candidate of rankedCandidates) {
      const auth = candidate.authorization;
      const symbol = candidate.symbol;
      const candleCloseTime = auth.marketDataTimestamp;

      // Safe concurrency reservation: reserve position capacity & balance headroom
      const reservation = Storage.reservePositionCapacity(symbol, mode, settings.fixedTradeAmount);
      if (!reservation.reserved) {
        Logger.info(
          mode,
          'STRATEGY',
          `Qualified candidate ${symbol} (Rank #${candidate.rank}) waiting for capacity: ${reservation.reason}`
        );
        Storage.saveDecisionAudit({
          timestamp: Date.now(),
          symbol,
          candleTimestamp: candleCloseTime,
          timeframe: '5m',
          score5m: auth.technicalScore,
          score15m: auth.confirmationScore15m,
          price: auth.entryPrice,
          trend: 'BULLISH',
          signalState: auth.strategyState,
          decision: 'HOLD',
          rejectionReason: reservation.reason,
          mode,
          tradeAmount: settings.fixedTradeAmount,
          passedChecks: auth.passedChecks,
          failedChecks: ['CAPACITY_WAITING'],
          qualified: true,
          rank: candidate.rank,
          availableCapacity: reservation.availableCapacity,
          capacityReserved: false,
          orderSubmissionResult: 'NOT_SUBMITTED',
        });
        continue;
      }

      // 4. Execute authorized BUY
      try {
        await this.executeAuthorizedBuy(candidate, settings, mode);
      } finally {
        Storage.releasePositionCapacity(symbol, mode);
      }
    }
  }

  private async executeAuthorizedBuy(
    candidate: CandidateRankInfo,
    settings: TradingSettings,
    mode: TradingMode
  ): Promise<void> {
    const { symbol, authorization: auth, rank } = candidate;
    const closedCandleTime = auth.marketDataTimestamp;
    const fixedAmount = settings.fixedTradeAmount;
    const executor = this.getExecutor(mode);

    // Deterministic & idempotent clientOrderId format: BOT_<MODE>_<SYMBOL>_<CANDLE_TIME>_BUY
    const clientOrderId = `BOT_${mode}_${symbol}_${closedCandleTime}_BUY`.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 36);
    const orderRequest = {
      symbol,
      side: 'BUY' as const,
      quoteAmount: fixedAmount,
      reason: `Rank #${rank} Authorized Entry (Score: ${auth.technicalScore})`,
      strategyState: auth.strategyState,
      technicalScore: auth.technicalScore,
      clientOrderId,
    };

    Logger.info(
      mode,
      'STRATEGY',
      `BUY AUTHORIZED: ${symbol} (Rank #${rank}, ${auth.strategyState}) | Fixed Amount: ${fixedAmount} USDT | Score: ${auth.technicalScore} | Decision: ${auth.decisionId}`
    );

    let submissionResult: 'FILLED' | 'FAILED' | 'REJECTED' = 'FAILED';
    let execError: string | null = null;

    try {
      const execResult = await executor.buy(orderRequest);
      Storage.setLastEvaluatedCandle(symbol, closedCandleTime);

      submissionResult = execResult.success ? 'FILLED' : 'FAILED';
      execError = execResult.success ? null : (execResult.error || 'Execution failed');

      Storage.saveDecisionAudit({
        timestamp: Date.now(),
        symbol,
        candleTimestamp: closedCandleTime,
        timeframe: '5m',
        score5m: auth.technicalScore,
        score15m: auth.confirmationScore15m,
        price: auth.entryPrice,
        trend: 'BULLISH',
        signalState: auth.strategyState,
        decision: execResult.success ? 'BUY' : 'REJECTED',
        rejectionReason: execResult.success ? null : execResult.error,
        mode,
        tradeAmount: fixedAmount,
        passedChecks: auth.passedChecks,
        failedChecks: auth.failedChecks,
        qualified: true,
        rank,
        availableCapacity: Storage.getAvailableCapacity(mode).availableCapacity,
        capacityReserved: true,
        orderSubmissionResult: submissionResult,
      });

      if (execResult.success) {
        this.broadcast('order_executed', { mode, order: execResult.order, position: execResult.position });
      }
    } catch (err: any) {
      execError = err.message;
      submissionResult = 'FAILED';
      Logger.error(mode, 'ORDER', `Execution of BUY failed for ${symbol}: ${err.message}`);

      Storage.saveDecisionAudit({
        timestamp: Date.now(),
        symbol,
        candleTimestamp: closedCandleTime,
        timeframe: '5m',
        score5m: auth.technicalScore,
        score15m: auth.confirmationScore15m,
        price: auth.entryPrice,
        trend: 'BULLISH',
        signalState: auth.strategyState,
        decision: 'REJECTED',
        rejectionReason: `EXECUTION_FAILED: ${err.message}`,
        mode,
        tradeAmount: fixedAmount,
        passedChecks: auth.passedChecks,
        failedChecks: ['ORDER_EXECUTION'],
        qualified: true,
        rank,
        capacityReserved: true,
        orderSubmissionResult: 'FAILED',
      });
    }
  }

  private async processTradingSignal(
    analysis: TechnicalAnalysis,
    previousState: StrategyState | undefined,
    settings: TradingSettings,
    mode: TradingMode,
    closedCandleTime: number
  ): Promise<void> {
    const symbol = analysis.symbol;
    const openPosition = Storage.getOpenPositionForSymbol(symbol, mode);

    // -------------------------------------------------------------
    // 1. POSITION MANAGEMENT & EXIT ARCHITECTURE (IF POSITION OPEN)
    // -------------------------------------------------------------
    if (openPosition && openPosition.status === 'OPEN') {
      Storage.updateEngineTelemetry({ lastExitEvaluationAt: Date.now() });
      await this.evaluateAndProcessPositionExit(openPosition, analysis, settings, mode);
      return;
    }

    // -------------------------------------------------------------
    // 2. CLOSED CANDLE DEDUPLICATION CHECK
    // If this closed 5m candle was already evaluated for entry, skip to prevent
    // duplicate buys across multiple scans during the same candle period.
    // -------------------------------------------------------------
    const lastEvaluatedCandleTime = Storage.getLastEvaluatedCandle(symbol);
    if (lastEvaluatedCandleTime && closedCandleTime <= lastEvaluatedCandleTime) {
      return;
    }

    Storage.updateEngineTelemetry({ lastEntryEvaluationAt: Date.now() });

    // -------------------------------------------------------------
    // 3. AUTHORITATIVE DETERMINISTIC BUY AUTHORIZATION SERVICE
    // All automatic entry orders pass through BuyAuthorizationService
    // -------------------------------------------------------------
    let symbolFilter;
    try {
      symbolFilter = await this.binance.getSymbolFilters(symbol);
    } catch {}

    const wallet = Storage.getWallet(mode);
    const openPositions = Storage.getPositions(mode, 'OPEN');

    const authResult = await BuyAuthorizationService.authorizeBuy({
      symbol,
      mode,
      analysis,
      settings,
      wallet,
      openPositions,
      symbolFilter,
      closedCandleCloseTime: closedCandleTime,
      isEmergencyStopped: this.isEmergencyStopped,
    });

    if (!authResult.authorized) {
      Storage.setLastEvaluatedCandle(symbol, closedCandleTime);
      Storage.saveDecisionAudit({
        timestamp: authResult.evaluatedAt,
        symbol,
        candleTimestamp: authResult.marketDataTimestamp,
        timeframe: '5m',
        score5m: authResult.technicalScore,
        score15m: authResult.confirmationScore15m,
        rsi: analysis.indicators?.rsi14?.slice(-1)[0],
        price: authResult.entryPrice,
        trend: analysis.marketStructure?.trend || 'NEUTRAL',
        signalState: authResult.strategyState,
        decision: 'REJECTED',
        rejectionReason: authResult.rejectionReasons.join('; '),
        mode,
        tradeAmount: settings.fixedTradeAmount,
        passedChecks: authResult.passedChecks,
        failedChecks: authResult.failedChecks,
        qualified: false,
        orderSubmissionResult: 'REJECTED',
      });
      return;
    }

    // -------------------------------------------------------------
    // 4. CAPACITY RESERVATION & EXECUTION
    // "maxOpenPositions" is exclusively a hard upper bound.
    // -------------------------------------------------------------
    const reservation = Storage.reservePositionCapacity(symbol, mode, settings.fixedTradeAmount);
    if (!reservation.reserved) {
      Logger.info(
        mode,
        'STRATEGY',
        `Qualified candidate ${symbol} waiting for capacity: ${reservation.reason}`
      );
      Storage.saveDecisionAudit({
        timestamp: Date.now(),
        symbol,
        candleTimestamp: closedCandleTime,
        timeframe: '5m',
        score5m: authResult.technicalScore,
        score15m: authResult.confirmationScore15m,
        price: authResult.entryPrice,
        trend: 'BULLISH',
        signalState: authResult.strategyState,
        decision: 'HOLD',
        rejectionReason: reservation.reason,
        mode,
        tradeAmount: settings.fixedTradeAmount,
        passedChecks: authResult.passedChecks,
        failedChecks: ['CAPACITY_WAITING'],
        qualified: true,
        rank: 1,
        availableCapacity: reservation.availableCapacity,
        capacityReserved: false,
        orderSubmissionResult: 'NOT_SUBMITTED',
      });
      return;
    }

    try {
      await this.executeAuthorizedBuy(
        {
          symbol,
          authorization: authResult,
          rank: 1,
        },
        settings,
        mode
      );
    } finally {
      Storage.releasePositionCapacity(symbol, mode);
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
      isEmergencyStopped: this.isEmergencyStopActive(),
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
      const clientOrderId = `BOT_${mode}_${symbol}_${Date.now()}_SELL`.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 36);
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
        this.isEmergencyStopActive()
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
            isEmergencyStopped: this.isEmergencyStopActive(),
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
        Storage.saveDecisionAudit({
          timestamp: Date.now(),
          symbol,
          candleTimestamp: Date.now(),
          timeframe: '5m',
          score5m: analysis.score,
          price: freshPrice,
          trend: analysis.marketStructure?.trend || 'NEUTRAL',
          signalState: analysis.strategyState,
          decision: execResult.success ? 'SELL' : 'REJECTED',
          rejectionReason: execResult.success ? null : execResult.error,
          mode,
          tradeAmount: position.entryQuoteAmount,
        });

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

  public getEngineStatus(): ServerEngineStatus {
    const settings = Storage.getSettings();
    const telemetry = Storage.getEngineTelemetry();
    const validator = BinanceSymbolValidator.getInstance();
    const spotTele = validator.getSpotMarketTelemetry();
    const openPositions = Storage.getPositions(settings.mode, 'OPEN');

    return {
      status: Storage.isReady() ? 'ok' : 'degraded',
      serverTime: new Date().toISOString(),
      tradingEngine: this.isEngineRunning ? 'RUNNING' : 'STOPPED',
      scheduler: this.scanTimer ? 'RUNNING' : 'STOPPED',
      watchdog: this.watchdogTimer ? 'RUNNING' : 'STOPPED',
      mode: settings.mode,
      autoTrading: settings.autoTrading,
      isEmergencyStopped: this.isEmergencyStopActive(),
      lastScanAt: telemetry.lastScanAt ? new Date(telemetry.lastScanAt).toISOString() : null,
      lastSuccessfulScanAt: telemetry.lastSuccessfulScanAt ? new Date(telemetry.lastSuccessfulScanAt).toISOString() : null,
      lastClosed5mCandleAt: telemetry.lastClosed5mCandleAt ? new Date(telemetry.lastClosed5mCandleAt).toISOString() : null,
      lastEntryEvaluationAt: telemetry.lastEntryEvaluationAt ? new Date(telemetry.lastEntryEvaluationAt).toISOString() : null,
      lastExitEvaluationAt: telemetry.lastExitEvaluationAt ? new Date(telemetry.lastExitEvaluationAt).toISOString() : null,
      activePositions: openPositions.length,
      validBinanceSymbols: spotTele.symbolsCount,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
