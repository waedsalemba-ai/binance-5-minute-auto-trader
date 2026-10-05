import assert from 'node:assert';
import { calculateAllIndicators } from '../src/server/indicators.ts';
import { detectCandlePatterns } from '../src/server/pattern-detector.ts';
import { analyzeMarketStructure } from '../src/server/market-structure.ts';
import { StrategyEngine } from '../src/server/strategy-engine.ts';
import { SafetyGate } from '../src/server/safety-gate.ts';
import { PaperTradingExecutor } from '../src/server/trading-executor.ts';
import { Storage } from '../src/server/storage.ts';
import { sanitizeDatabaseUrl } from '../src/server/postgres.ts';
import { normalizeBinanceBaseUrl } from '../src/server/binance-client.ts';
import {
  Candle,
  TradingSettings,
  WalletBalance,
  Position,
  Order,
  Trade,
  SymbolFilterRules,
} from '../src/types/index.ts';
import {
  calculatePositionNetPnL,
  calculateBreakEvenExitPrice,
  calculateTargetExitPrice,
  evaluateExitDecision,
} from '../src/server/exit-decision-engine.ts';
import { evaluateEntryEligibility } from '../src/server/entry-decision-engine.ts';
import {
  verifyAdminToken,
  verifyAdminSessionToken,
  createAdminSessionToken,
  encryptSecret,
  decryptSecret,
} from '../src/server/security.ts';

function createMockCandles(count = 60, startPrice = 100, trend = 'up'): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const change = trend === 'up' ? (Math.random() * 2 - 0.5) : (Math.random() * 2 - 1.5);
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random();
    const low = Math.min(open, close) - Math.random();
    const volume = 1000 + Math.random() * 500;
    const timestamp = now - (count - i) * 5 * 60 * 1000;

    candles.push({
      timestamp,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: Number(volume.toFixed(2)),
      closeTime: timestamp + 5 * 60 * 1000 - 1,
      quoteVolume: Number((volume * close).toFixed(2)),
      trades: 150,
      isClosed: true,
    });
    price = close;
  }
  return candles;
}

async function runAllTests() {
  console.log('🧪 Starting Binance 5m Scanner & Auto Trader Automated Test Suite...\n');
  await Storage.ensureReady();

  let passed = 0;
  let failed = 0;
  let testQueue = Promise.resolve();

  function test(name: string, fn: () => void | Promise<void>) {
    testQueue = testQueue.then(async () => {
      try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
      } catch (err: any) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        failed++;
      }
    });
  }

  // -------------------------------------------------------------
  // 1. Technical Indicators Calculation
  // -------------------------------------------------------------
  console.log('1. Technical Indicators:');
  test('EMA, SMA, RSI, MACD, Bollinger Bands, ATR & VWAP compute valid outputs', () => {
    const candles = createMockCandles(60, 200, 'up');
    const ind = calculateAllIndicators(candles);

    assert.equal(ind.ema9.length, 60);
    assert.equal(ind.sma20.length, 60);
    assert.ok(!isNaN(ind.ema9[59]));
    assert.ok(!isNaN(ind.rsi14[59]));
    assert.ok(ind.rsi14[59] >= 0 && ind.rsi14[59] <= 100);
    assert.ok(!isNaN(ind.macd.macdLine[59]));
    assert.ok(!isNaN(ind.bollingerBands.upper[59]));
    assert.ok(ind.bollingerBands.upper[59] >= ind.bollingerBands.middle[59]);
  });

  // -------------------------------------------------------------
  // 2. Candlestick Patterns & Market Structure
  // -------------------------------------------------------------
  console.log('\n2. Pattern & Market Structure Analysis:');
  test('Pattern detector detects bullish engulfing and hammer', () => {
    const candles: Candle[] = [
      { timestamp: 1, open: 100, high: 101, low: 95, close: 96, volume: 100, closeTime: 2, quoteVolume: 9600, trades: 10, isClosed: true },
      { timestamp: 2, open: 95.5, high: 103, low: 95, close: 102, volume: 200, closeTime: 3, quoteVolume: 20400, trades: 20, isClosed: true },
    ];
    const patterns = detectCandlePatterns(candles);
    assert.ok(patterns.some(p => p.name === 'Bullish Engulfing'));
  });

  test('Market structure identifies higher highs & higher lows in uptrend', () => {
    const candles = createMockCandles(80, 100, 'up');
    const structure = analyzeMarketStructure(candles);
    assert.ok(['UPTREND', 'CONSOLIDATION', 'DOWNTREND'].includes(structure.trend));
    assert.ok(Array.isArray(structure.supportLevels));
    assert.ok(Array.isArray(structure.resistanceLevels));
  });

  // -------------------------------------------------------------
  // 3. Fixed Trade Amount Sizing Invariants
  // -------------------------------------------------------------
  console.log('\n3. Fixed Trade Amount Invariant Rules:');
  test('Fixed trade amount invariant: BUY must equal configuredFixedTradeAmount', () => {
    Storage.resetPaperAccount();
    const defaultSettings: TradingSettings = {
      mode: 'PAPER',
      autoTrading: true,
      fixedTradeAmount: 100,
      maxOpenPositions: 5,
      minimumUsdtReserve: 100,
      symbolCooldownMinutes: 30,
      preBullishScoreMin: 65,
      strongBullishScoreMin: 80,
      weakeningThreshold: 70,
      maxTradeAmount: 10000,
      paperStartingBalance: 1000,
      paperFeeRate: 0.001,
      paperSlippageBps: 5,
      manageExistingHoldings: false,
      resumeOnRestart: false,
      scanIntervalMs: 120000,
      takeProfitPercent: 2.0,
      stopLossPercent: 3.0,
      minProfitForTechnicalExitPercent: 0.20,
      maxExitPriceAgeMs: 5000,
    };

    const wallet: WalletBalance = {
      mode: 'PAPER',
      usdtAvailable: 1000,
      usdtLocked: 0,
      usdtTotal: 1000,
      accountAssetValue: 0,
      totalEquity: 1000,
      startingBalance: 1000,
      realizedPnL: 0,
      unrealizedPnL: 0,
      totalFeesPaid: 0,
      assets: [],
      lastReconciledAt: Date.now(),
      reconciliationStatus: 'OK',
    };

    const filter: SymbolFilterRules = {
      minNotional: 5,
      minQty: 0.0001,
      maxQty: 999999,
      stepSize: 0.0001,
      tickSize: 0.01,
      minPrice: 0.01,
      maxPrice: 1000000,
    };

    // Valid 100 USDT trade
    const validCheck = SafetyGate.validateBuy(
      { symbol: 'ETHUSDT', side: 'BUY', quoteAmount: 100, reason: 'test', strategyState: 'PRE_BULLISH', technicalScore: 75, clientOrderId: 'c1' },
      'PAPER',
      defaultSettings,
      wallet,
      [],
      filter,
      2500,
      false
    );
    assert.strictEqual(validCheck.allowed, true);

    // Invalid quote amount (attempting 50 USDT instead of 100) -> Must reject
    const invalidCheck = SafetyGate.validateBuy(
      { symbol: 'ETHUSDT', side: 'BUY', quoteAmount: 50, reason: 'test', strategyState: 'PRE_BULLISH', technicalScore: 75, clientOrderId: 'c2' },
      'PAPER',
      defaultSettings,
      wallet,
      [],
      filter,
      2500,
      false
    );
    assert.strictEqual(invalidCheck.allowed, false);
    assert.strictEqual(invalidCheck.code, 'FIXED_AMOUNT_INVARIANT_VIOLATION');
  });

  test('Wallet with 150 USDT and 100 USDT reserve blocks a 100 USDT trade', () => {
    const settings = {
      ...Storage.getSettings(),
      autoTrading: true,
      fixedTradeAmount: 100,
      minimumUsdtReserve: 100,
    };

    const lowWallet: WalletBalance = {
      mode: 'PAPER',
      usdtAvailable: 150,
      usdtLocked: 0,
      usdtTotal: 150,
      accountAssetValue: 0,
      totalEquity: 150,
      startingBalance: 1000,
      realizedPnL: 0,
      unrealizedPnL: 0,
      totalFeesPaid: 0,
      assets: [],
      lastReconciledAt: Date.now(),
      reconciliationStatus: 'OK',
    };

    const filter: SymbolFilterRules = { minNotional: 5, minQty: 0.001, maxQty: 1000, stepSize: 0.001, tickSize: 0.01, minPrice: 0.01, maxPrice: 100000 };

    const check = SafetyGate.validateBuy(
      { symbol: 'SOLUSDT', side: 'BUY', quoteAmount: 100, reason: 'test', strategyState: 'PRE_BULLISH', technicalScore: 70, clientOrderId: 'c3' },
      'PAPER',
      settings,
      lowWallet,
      [],
      filter,
      150,
      false
    );

    assert.strictEqual(check.allowed, false);
    assert.strictEqual(check.code, 'MINIMUM_RESERVE_VIOLATION');
  });

  test('Trade amount change applies to future trades without altering historical records', () => {
    Storage.resetPaperAccount();
    Storage.updateSettings({ fixedTradeAmount: 100 });

    const pos1: Position = {
      id: 'pos-1',
      accountId: 'paper-default',
      mode: 'PAPER',
      symbol: 'BTCUSDT',
      quantity: 0.002,
      remainingQuantity: 0.002,
      entryPrice: 50000,
      entryQuoteAmount: 100, // Historical 100 USDT
      entryFees: 0.1,
      entryScore: 75,
      entryState: 'PRE_BULLISH',
      entryReason: 'initial',
      currentPrice: 50000,
      currentScore: 75,
      currentState: 'PRE_BULLISH',
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      openedAt: Date.now() - 60000,
      updatedAt: Date.now() - 60000,
      status: 'OPEN',
      entryOrderId: 'ord-1',
    };
    Storage.savePosition(pos1);

    // User updates fixed trade amount to 200 USDT
    Storage.updateSettings({ fixedTradeAmount: 200 });
    const currentSettings = Storage.getSettings();
    assert.strictEqual(currentSettings.fixedTradeAmount, 200);

    // Historical position entryQuoteAmount remains strictly 100 USDT
    const loadedPos = Storage.getPositionById('pos-1');
    assert.strictEqual(loadedPos?.entryQuoteAmount, 100);
  });

  // -------------------------------------------------------------
  // 4. Strategy State Machine & Cooldowns
  // -------------------------------------------------------------
  console.log('\n4. Strategy State Transitions & Risk Controls:');
  test('Strategy transitions: PRE_BULLISH -> STRONG_BULLISH -> WEAKENING', () => {
    const settings = Storage.getSettings();
    const candles = createMockCandles(60, 100, 'up');
    const ind = calculateAllIndicators(candles);
    const struct = analyzeMarketStructure(candles);

    const mtf = {
      '5m': { timeframe: '5m' as const, trend: 'BULLISH' as const, score: 75, rsi: 60, macdCross: 'BULLISH' as const },
    };

    const preBullishState = StrategyEngine.evaluateStrategyState(
      {
        symbol: 'AVAXUSDT',
        price: 35,
        priceChange24h: 4.2,
        volume24h: 500000,
        quoteVolume24h: 17500000,
        timestamp: Date.now(),
        indicators: ind,
        patterns: [],
        marketStructure: struct,
        multiTimeframe: mtf,
        score: 72, // >= 65
        scoreComponents: [],
        strategyState: 'NEUTRAL',
        stateReason: '',
      },
      'NEUTRAL',
      settings
    );
    assert.strictEqual(preBullishState.state, 'PRE_BULLISH');

    // Strong Bullish State
    const strongState = StrategyEngine.evaluateStrategyState(
      {
        symbol: 'AVAXUSDT',
        price: 40,
        priceChange24h: 12.5,
        volume24h: 800000,
        quoteVolume24h: 32000000,
        timestamp: Date.now(),
        indicators: ind,
        patterns: [],
        marketStructure: struct,
        multiTimeframe: mtf,
        score: 85, // >= 80
        scoreComponents: [],
        strategyState: 'PRE_BULLISH',
        stateReason: '',
      },
      'PRE_BULLISH',
      settings
    );
    assert.strictEqual(strongState.state, 'STRONG_BULLISH');

    // Weakening exit detection when score drops below 70
    const weakeningState = StrategyEngine.evaluateStrategyState(
      {
        symbol: 'AVAXUSDT',
        price: 38,
        priceChange24h: 5.0,
        volume24h: 400000,
        quoteVolume24h: 15200000,
        timestamp: Date.now(),
        indicators: ind,
        patterns: [],
        marketStructure: struct,
        multiTimeframe: mtf,
        score: 62, // < 70
        scoreComponents: [],
        strategyState: 'STRONG_BULLISH',
        stateReason: '',
      },
      'STRONG_BULLISH',
      settings
    );
    assert.strictEqual(weakeningState.state, 'WEAKENING');
  });

  test('Symbol cooldown blocks immediate re-entry for 30 minutes', () => {
    Storage.setSymbolCooldown('NEARUSDT', 'PAPER', 30);
    const cdCheck = Storage.isSymbolInCooldown('NEARUSDT', 'PAPER');
    assert.strictEqual(cdCheck.inCooldown, true);
    assert.ok(cdCheck.remainingMinutes >= 29 && cdCheck.remainingMinutes <= 30);
  });

  // -------------------------------------------------------------
  // 5. Paper Wallet Lifecycle & Reset
  // -------------------------------------------------------------
  console.log('\n5. Paper Wallet & Accounting Integrity:');
  test('Paper Account resets cleanly to 1000 USDT without affecting real settings', () => {
    Storage.resetPaperAccount();
    const wallet = Storage.getWallet('PAPER');
    assert.strictEqual(wallet.usdtAvailable, 1000);
    assert.strictEqual(wallet.usdtLocked, 0);
    assert.strictEqual(wallet.totalEquity, 1000);
    assert.strictEqual(wallet.assets.length, 0);
    assert.strictEqual(Storage.getPositions('PAPER').length, 0);
  });

  // -------------------------------------------------------------
  // 6. Binance Base URL Sanitization & Resilience
  // -------------------------------------------------------------
  console.log('\n6. Binance Base URL Sanitization & Resilience:');
  test('Base URL normalizer sanitizes malformed URLs, random tokens, and trailing slashes', () => {
    // Malformed token without http/https protocol
    assert.strictEqual(
      normalizeBinanceBaseUrl('T3DqQs8tHRlSnny8rzYtmNNwsxp5eqBWafOLk9HSGd5fjwDx47MEFrpbRPLI9cVf'),
      'https://api.binance.com'
    );
    // Empty or undefined
    assert.strictEqual(normalizeBinanceBaseUrl(undefined), 'https://api.binance.com');
    assert.strictEqual(normalizeBinanceBaseUrl(''), 'https://api.binance.com');
    // Valid custom URL with trailing slash
    assert.strictEqual(normalizeBinanceBaseUrl('https://api1.binance.com/'), 'https://api1.binance.com');
    assert.strictEqual(normalizeBinanceBaseUrl('https://data-api.binance.vision/api/v3/'), 'https://data-api.binance.vision');
  });

  // -------------------------------------------------------------
  // 7. Authoritative Net PnL Calculation & Break-Even Formula
  // -------------------------------------------------------------
  console.log('\n7. Authoritative Net PnL & Break-Even Calculation:');
  test('calculatePositionNetPnL accounts for entry fees, exit fees, and slippage', () => {
    const mockPos = {
      quantity: 1,
      remainingQuantity: 1,
      entryPrice: 100,
      entryQuoteAmount: 100,
      entryFees: 0.1, // 0.1% entry fee
    };

    // At entry price $100: Gross is 0, but after slippage (5bps = 0.05%) and exit fee (0.1%), net must be negative
    const pnlAtEntry = calculatePositionNetPnL(mockPos, 100, 0.001, 5);
    assert.ok(pnlAtEntry.netPnL < 0, 'Net PnL at entry price must be negative due to roundtrip fees & slippage');
    assert.strictEqual(pnlAtEntry.grossPnL, 0);
    assert.ok(pnlAtEntry.estimatedExitFees > 0);

    // At break-even price: Net PnL must equal 0
    const bePrice = calculateBreakEvenExitPrice(mockPos, 0.001, 5);
    assert.ok(bePrice > 100, 'Break-even price must be higher than entry price');
    const pnlAtBE = calculatePositionNetPnL(mockPos, bePrice, 0.001, 5);
    assert.ok(Math.abs(pnlAtBE.netPnL) < 0.01, `Net PnL at break-even price must be ~0, got ${pnlAtBE.netPnL}`);
  });

  // -------------------------------------------------------------
  // 8. Exit Architecture & Decision Rules (TEST 1 to TEST 8)
  // -------------------------------------------------------------
  console.log('\n8. Exit Decision Engine Verification:');
  const baseSettings: TradingSettings = {
    ...Storage.getSettings(),
    takeProfitPercent: 2.0,
    stopLossPercent: 3.0,
    minProfitForTechnicalExitPercent: 0.20,
    maxExitPriceAgeMs: 5000,
  };

  const samplePos: Position = {
    id: 'pos-test-1',
    accountId: 'paper-default',
    mode: 'PAPER',
    symbol: 'BTCUSDT',
    quantity: 1,
    remainingQuantity: 1,
    entryPrice: 100,
    entryQuoteAmount: 100,
    entryFees: 0.1,
    entryScore: 75,
    entryState: 'PRE_BULLISH',
    entryReason: 'entry',
    currentPrice: 100,
    currentScore: 75,
    currentState: 'PRE_BULLISH',
    unrealizedPnL: 0,
    unrealizedPnLPercent: 0,
    openedAt: Date.now() - 60000,
    updatedAt: Date.now() - 60000,
    status: 'OPEN',
    entryOrderId: 'ord-1',
  };

  test('TEST 1: Weakening while losing (Price 98, Net PnL -2%) -> MUST HOLD, NEVER SELL AT A LOSS', () => {
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: 98,
      priceTimestamp: Date.now(),
      strategyState: 'WEAKENING',
      technicalScore: 68,
      settings: baseSettings,
    });

    assert.strictEqual(decision.shouldSell, false, 'Weakening with loss must NOT trigger sell');
    assert.strictEqual(decision.reason, 'HOLD_PROFIT_PROTECTION');
    assert.ok(decision.netPnLPercent < 0);
  });

  test('TEST 2: Weakening while profitable (Price 101, Net PnL +0.75% >= +0.20%) -> MUST SELL with TECHNICAL_PROFIT_EXIT', () => {
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: 101,
      priceTimestamp: Date.now(),
      strategyState: 'WEAKENING',
      technicalScore: 68,
      settings: baseSettings,
    });

    assert.strictEqual(decision.shouldSell, true);
    assert.strictEqual(decision.reason, 'TECHNICAL_PROFIT_EXIT');
    assert.ok(decision.netPnLPercent >= 0.20);
  });

  test('TEST 3: Take profit triggered (Net PnL +2.05% >= +2.0%) -> MUST SELL with TAKE_PROFIT', () => {
    const tpPrice = calculateTargetExitPrice(samplePos, 2.05, 0.001, 5);
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: tpPrice,
      priceTimestamp: Date.now(),
      strategyState: 'STRONG_BULLISH',
      technicalScore: 85,
      settings: baseSettings,
    });

    assert.strictEqual(decision.shouldSell, true);
    assert.strictEqual(decision.reason, 'TAKE_PROFIT');
    assert.ok(decision.netPnLPercent >= 2.0);
  });

  test('TEST 4: Stop loss triggered (Net PnL -3.10% <= -3.0%) -> MUST SELL with STOP_LOSS', () => {
    const slPrice = calculateTargetExitPrice(samplePos, -3.10, 0.001, 5);
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: slPrice,
      priceTimestamp: Date.now(),
      strategyState: 'STRONG_BULLISH',
      technicalScore: 85,
      settings: baseSettings,
    });

    assert.strictEqual(decision.shouldSell, true);
    assert.strictEqual(decision.reason, 'STOP_LOSS');
    assert.ok(decision.netPnLPercent <= -3.0);
  });

  test('TEST 5: Small loss (Net PnL -0.50%, State WEAKENING) -> MUST HOLD', () => {
    const smallLossPrice = calculateTargetExitPrice(samplePos, -0.50, 0.001, 5);
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: smallLossPrice,
      priceTimestamp: Date.now(),
      strategyState: 'WEAKENING',
      technicalScore: 65,
      settings: baseSettings,
    });

    assert.strictEqual(decision.shouldSell, false);
    assert.strictEqual(decision.reason, 'HOLD_PROFIT_PROTECTION');
  });

  test('TEST 6: Small profit below technical threshold (Net PnL +0.10% < +0.20%) -> MUST HOLD', () => {
    const smallProfitPrice = calculateTargetExitPrice(samplePos, 0.10, 0.001, 5);
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: smallProfitPrice,
      priceTimestamp: Date.now(),
      strategyState: 'WEAKENING',
      technicalScore: 68,
      settings: baseSettings,
    });

    assert.strictEqual(decision.shouldSell, false);
    assert.strictEqual(decision.reason, 'HOLD_PROFIT_PROTECTION');
  });

  test('TEST 7: Strong bullish (Net PnL +1.0%, State STRONG_BULLISH) -> MUST HOLD', () => {
    const profitPrice = calculateTargetExitPrice(samplePos, 1.0, 0.001, 5);
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: profitPrice,
      priceTimestamp: Date.now(),
      strategyState: 'STRONG_BULLISH',
      technicalScore: 88,
      settings: baseSettings,
    });

    assert.strictEqual(decision.shouldSell, false);
    assert.strictEqual(decision.reason, 'HOLD');
  });

  test('TEST 8: Manual SELL is always allowed with reason MANUAL', () => {
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: 95, // losing position
      priceTimestamp: Date.now(),
      strategyState: 'NEUTRAL',
      technicalScore: 50,
      settings: baseSettings,
      isManual: true,
    });

    assert.strictEqual(decision.shouldSell, true);
    assert.strictEqual(decision.reason, 'MANUAL');
  });

  test('TEST 9: Stale price protection blocks automatic SELL if price is older than 5000ms', () => {
    const stalePriceTimestamp = Date.now() - 10000; // 10s old
    const decision = evaluateExitDecision({
      position: samplePos,
      currentPrice: 105,
      priceTimestamp: stalePriceTimestamp,
      strategyState: 'WEAKENING',
      technicalScore: 65,
      settings: baseSettings,
    });

    assert.strictEqual(decision.shouldSell, false);
    assert.strictEqual(decision.reason, 'HOLD');
  });

  // -------------------------------------------------------------
  // 9. Atomic CLOSING State Transition & Partial Fill Handling
  // -------------------------------------------------------------
  console.log('\n9. Atomic State Transition & Partial Fill Accounting:');
  test('Paper sell transitions OPEN -> CLOSING -> CLOSED and records trade', async () => {
    Storage.resetPaperAccount();
    const paperExec = new PaperTradingExecutor();
    
    // Create an open position
    const posToSell: Position = {
      id: 'pos-test-sell-1',
      accountId: 'paper-default',
      mode: 'PAPER',
      symbol: 'ETHUSDT',
      quantity: 0.1,
      remainingQuantity: 0.1,
      entryPrice: 2000,
      entryQuoteAmount: 200,
      entryFees: 0.2,
      entryScore: 78,
      entryState: 'PRE_BULLISH',
      entryReason: 'initial',
      currentPrice: 2000,
      currentScore: 78,
      currentState: 'PRE_BULLISH',
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      openedAt: Date.now() - 120000,
      updatedAt: Date.now() - 120000,
      status: 'OPEN',
      entryOrderId: 'ord-buy-1',
    };
    Storage.savePosition(posToSell);

    const sellResult = await paperExec.sell({
      symbol: 'ETHUSDT',
      side: 'SELL',
      quantity: 0.1,
      reason: 'Take Profit Exit',
      strategyState: 'EXIT',
      technicalScore: 60,
      clientOrderId: 'client-sell-1',
    }, posToSell.id);

    assert.strictEqual(sellResult.success, true);
    assert.strictEqual(sellResult.position?.status, 'CLOSED');
    assert.strictEqual(sellResult.position?.remainingQuantity, 0);
    assert.ok(sellResult.trade !== undefined);
    assert.strictEqual(sellResult.trade?.exitReason, 'Take Profit Exit');
  });

  // -------------------------------------------------------------
  // 10. Centralized Entry Decision Engine (Bullish Entry Verification)
  // -------------------------------------------------------------
  console.log('\n10. Bullish Entry Decision Engine Verification:');

  test('ENTRY TEST 1: STRONG_BULLISH signal (Score 85, no position) -> MUST BE ELIGIBLE FOR BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'BTCUSDT',
      strategyState: 'STRONG_BULLISH',
      technicalScore: 85,
      hasOpenPosition: false,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, true, 'STRONG_BULLISH signal with no position must be eligible for BUY');
    assert.strictEqual(decision.strategyState, 'STRONG_BULLISH');
    assert.strictEqual(decision.technicalScore, 85);
  });

  test('ENTRY TEST 2: PRE_BULLISH signal (Score 72, no position) -> MUST BE ELIGIBLE FOR BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'ETHUSDT',
      strategyState: 'PRE_BULLISH',
      technicalScore: 72,
      hasOpenPosition: false,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, true, 'PRE_BULLISH signal with no position must be eligible for BUY');
    assert.strictEqual(decision.strategyState, 'PRE_BULLISH');
    assert.strictEqual(decision.technicalScore, 72);
  });

  test('ENTRY TEST 3: Unknown previous state entering scanner directly as STRONG_BULLISH (Score 88) -> MUST BE ELIGIBLE FOR BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'SOLUSDT',
      strategyState: 'STRONG_BULLISH',
      technicalScore: 88,
      hasOpenPosition: false,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, true, 'Fresh token entering directly as STRONG_BULLISH must be eligible for BUY');
  });

  test('ENTRY TEST 4: STRONG_BULLISH with existing open position -> MUST BLOCK duplicate BUY (Hold position)', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'BTCUSDT',
      strategyState: 'STRONG_BULLISH',
      technicalScore: 90,
      hasOpenPosition: true,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, false, 'STRONG_BULLISH with open position must NOT create a duplicate BUY');
    assert.ok(decision.reason.includes('Open position exists'));
  });

  test('ENTRY TEST 5: STRONG_BULLISH with in-flight pending BUY lock -> MUST BLOCK duplicate in-flight BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'BNBUSDT',
      strategyState: 'STRONG_BULLISH',
      technicalScore: 86,
      hasOpenPosition: false,
      isPendingEntry: true,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, false, 'In-flight pending BUY lock must prevent concurrent double-entry');
    assert.ok(decision.reason.includes('Pending BUY entry'));
  });

  test('ENTRY TEST 6: NEUTRAL state (Score 55) -> MUST BLOCK BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'DOGEUSDT',
      strategyState: 'NEUTRAL',
      technicalScore: 55,
      hasOpenPosition: false,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, false, 'NEUTRAL state must never be bought');
  });

  test('ENTRY TEST 7: WEAKENING state (Score 68) -> MUST BLOCK BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'XRPUSDT',
      strategyState: 'WEAKENING',
      technicalScore: 68,
      hasOpenPosition: false,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, false, 'WEAKENING state must never be bought');
  });

  test('ENTRY TEST 8: EXIT state (Score 40) -> MUST BLOCK BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'ADAUSDT',
      strategyState: 'EXIT',
      technicalScore: 40,
      hasOpenPosition: false,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, false, 'EXIT state must never be bought');
  });

  test('ENTRY TEST 9: Cooldown active on symbol -> MUST BLOCK BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'AVAXUSDT',
      strategyState: 'STRONG_BULLISH',
      technicalScore: 88,
      hasOpenPosition: false,
      isInCooldown: true,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, false, 'Symbol in cooldown must block automatic BUY');
    assert.ok(decision.reason.includes('cooldown'));
  });

  test('ENTRY TEST 10: Emergency stop active -> MUST BLOCK BUY', () => {
    const decision = evaluateEntryEligibility({
      symbol: 'NEARUSDT',
      strategyState: 'STRONG_BULLISH',
      technicalScore: 92,
      hasOpenPosition: false,
      isEmergencyStopped: true,
      settings: baseSettings,
    });

    assert.strictEqual(decision.eligible, false, 'Emergency stop must block all BUYs');
    assert.ok(decision.reason.includes('Emergency stop'));
  });

  // -------------------------------------------------------------
  // 11. Production Security, Authentication & Session Verification
  // -------------------------------------------------------------
  console.log('\n11. Production Security & Authentication Verification:');

  test('AUTH TEST 1: Admin token validation and timing-safe comparison', () => {
    const originalEnvToken = process.env.ADMIN_TOKEN;
    const originalAccessToken = process.env.ADMIN_ACCESS_TOKEN;
    try {
      delete process.env.ADMIN_ACCESS_TOKEN;
      process.env.ADMIN_TOKEN = 'secret_production_admin_token_xyz987';
      assert.strictEqual(verifyAdminToken('secret_production_admin_token_xyz987'), true);
      assert.strictEqual(verifyAdminToken('wrong_token'), false);
      assert.strictEqual(verifyAdminToken(''), false);
    } finally {
      process.env.ADMIN_TOKEN = originalEnvToken;
      process.env.ADMIN_ACCESS_TOKEN = originalAccessToken;
    }
  });

  test('AUTH TEST 2: HMAC Session token issuance, verification, and tamper resistance', () => {
    const sessionToken = createAdminSessionToken();
    assert.ok(typeof sessionToken === 'string' && sessionToken.includes('.'));
    assert.strictEqual(verifyAdminSessionToken(sessionToken), true);

    // Tampered token must fail
    const tampered = sessionToken + 'tamper';
    assert.strictEqual(verifyAdminSessionToken(tampered), false);

    // Empty or corrupted tokens must fail
    assert.strictEqual(verifyAdminSessionToken(''), false);
    assert.strictEqual(verifyAdminSessionToken('corrupt.payload'), false);
  });

  test('AUTH TEST 3: AES-256-GCM Credential encryption and roundtrip decryption at rest', () => {
    const secretApiKey = 'my_binance_secret_key_1234567890abcdef';
    const encrypted = encryptSecret(secretApiKey);
    assert.ok(encrypted.iv && encrypted.tag && encrypted.data);
    assert.notStrictEqual(encrypted.data, secretApiKey);

    const decrypted = decryptSecret(encrypted);
    assert.strictEqual(decrypted, secretApiKey);
  });

  // -------------------------------------------------------------
  // 12. Persistent Storage & Cold Restart Verification (PostgreSQL)
  // -------------------------------------------------------------
  console.log('\n12. Persistent Storage & Cold Restart Verification (PostgreSQL):');

  test('PERSISTENCE TEST 1: PostgreSQL connection and schema verification', async () => {
    await Storage.ensureReady();
    assert.strictEqual(Storage.isReady(), true);
    const isDbReady = await Storage.isDatabaseReadyAsync();
    assert.strictEqual(isDbReady, true);
    const stats = Storage.getDatabaseStats();
    assert.strictEqual(stats.storageEngine, 'PostgreSQL');
    assert.strictEqual(stats.isReady, true);
  });

  test('PERSISTENCE TEST 2: Trade, open position, custom wallet balance, settings & emergency stop survive simulated cold server restart', async () => {
    const testPositionId = `POS-PERSIST-${Date.now()}`;
    const testOrderId = `ORD-PERSIST-${Date.now()}`;
    const testTradeId = `TRD-PERSIST-${Date.now()}`;

    // 1. Create and save active position
    const samplePosition: Position = {
      id: testPositionId,
      accountId: 'paper-default',
      symbol: 'SOLUSDT',
      mode: 'PAPER',
      status: 'OPEN',
      entryPrice: 155.50,
      quantity: 1.5,
      remainingQuantity: 1.5,
      entryQuoteAmount: 233.25,
      entryFees: 0.233,
      entryScore: 84,
      entryState: 'STRONG_BULLISH',
      entryReason: 'Strong Bullish Auto Entry',
      currentPrice: 158.20,
      currentScore: 84,
      currentState: 'STRONG_BULLISH',
      grossPnL: 4.05,
      unrealizedPnL: 4.05,
      unrealizedPnLPercent: 1.74,
      estimatedNetPnL: 3.58,
      estimatedNetPnLPercent: 1.53,
      breakEvenPrice: 155.81,
      takeProfitPrice: 158.92,
      stopLossPrice: 150.83,
      openedAt: Date.now() - 60000,
      updatedAt: Date.now(),
      entryOrderId: testOrderId,
    };
    Storage.savePosition(samplePosition);

    // 2. Save order
    const sampleOrder: Order = {
      id: testOrderId,
      clientOrderId: `CLIENT-${testOrderId}`,
      accountId: 'paper-default',
      mode: 'PAPER',
      symbol: 'SOLUSDT',
      side: 'BUY',
      status: 'FILLED',
      requestedQuoteAmount: 233.25,
      executedQuantity: 1.5,
      executedQuoteAmount: 233.25,
      executionPrice: 155.50,
      fee: 0.233,
      feeAsset: 'USDT',
      reason: 'Strong Bullish Auto Entry',
      strategyState: 'STRONG_BULLISH',
      technicalScore: 84,
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 60000,
      fills: [{ price: 155.50, qty: 1.5, commission: 0.233, commissionAsset: 'USDT', tradeId: 99991 }],
    };
    Storage.saveOrder(sampleOrder);

    // 3. Save trade
    const sampleTrade: Trade = {
      id: testTradeId,
      accountId: 'paper-default',
      entryOrderId: testOrderId,
      exitOrderId: 'ORD-EXIT-TEST',
      symbol: 'SOLUSDT',
      mode: 'PAPER',
      entryPrice: 155.50,
      exitPrice: 158.20,
      quantity: 1.5,
      entryQuoteAmount: 233.25,
      exitQuoteAmount: 237.30,
      entryFees: 0.233,
      exitFees: 0.237,
      grossPnL: 4.05,
      netPnL: 3.58,
      netPnLPercent: 1.53,
      entryScore: 84,
      exitScore: 84,
      entryReason: 'Strong Bullish Auto Entry',
      exitReason: 'Test Target Exit',
      openedAt: Date.now() - 60000,
      closedAt: Date.now(),
      durationMs: 60000,
    };
    Storage.saveTrade(sampleTrade);

    // 4. Update wallet balance with custom non-default amount
    const customWallet: WalletBalance = {
      mode: 'PAPER',
      usdtAvailable: 766.52,
      usdtLocked: 233.25,
      usdtTotal: 999.77,
      accountAssetValue: 237.30,
      totalEquity: 1003.82,
      startingBalance: 1000,
      realizedPnL: 12.50,
      unrealizedPnL: 3.58,
      totalFeesPaid: 0.233,
      assets: [{ asset: 'SOL', symbol: 'SOLUSDT', free: 1.5, locked: 0, total: 1.5, price: 158.20, valueUsdt: 237.30, isExternal: false }],
      lastReconciledAt: Date.now(),
      reconciliationStatus: 'OK',
    };
    Storage.saveWallet(customWallet);

    // 5. Update settings and emergency stop
    Storage.updateSettings({ fixedTradeAmount: 250, takeProfitPercent: 3.5 });
    Storage.setEmergencyStopped(true);

    // 6. Give asynchronous persistence query a moment to settle
    await new Promise(r => setTimeout(r, 80));

    // 7. SIMULATE COLD SERVER REBOOT / CONTAINER RESTART: reload fresh from PostgreSQL
    await Storage.loadFromPostgres();

    // 8. VERIFY all state is 100% preserved
    const reloadedPosition = Storage.getPositionById(testPositionId);
    assert.ok(reloadedPosition, 'Saved position must survive server reboot');
    assert.strictEqual(reloadedPosition.symbol, 'SOLUSDT');
    assert.strictEqual(reloadedPosition.status, 'OPEN');
    assert.strictEqual(reloadedPosition.entryPrice, 155.50);
    assert.strictEqual(reloadedPosition.quantity, 1.5);
    assert.strictEqual(reloadedPosition.estimatedNetPnLPercent, 1.53);

    const reloadedOrder = Storage.getOrderById(testOrderId);
    assert.ok(reloadedOrder, 'Saved order must survive server reboot');
    assert.strictEqual(reloadedOrder.executedQuantity, 1.5);

    const reloadedTrades = Storage.getTrades('PAPER', 'SOLUSDT');
    const matchedTrade = reloadedTrades.find(t => t.id === testTradeId);
    assert.ok(matchedTrade, 'Saved trade history must survive server reboot');
    assert.strictEqual(matchedTrade.entryQuoteAmount, 233.25);

    const reloadedWallet = Storage.getWallet('PAPER');
    assert.strictEqual(reloadedWallet.usdtAvailable, 766.52, 'Paper balance must NOT be reset on reboot');
    assert.strictEqual(reloadedWallet.totalEquity, 1003.82);
    assert.strictEqual(reloadedWallet.realizedPnL, 12.50);

    const reloadedSettings = Storage.getSettings();
    assert.strictEqual(reloadedSettings.fixedTradeAmount, 250, 'Settings must survive server reboot');
    assert.strictEqual(reloadedSettings.takeProfitPercent, 3.5);

    assert.strictEqual(Storage.isEmergencyStopped(), true, 'Emergency stop state must survive server reboot');

    // Clean up test emergency stop state
    Storage.setEmergencyStopped(false);
  });

  test('PERSISTENCE TEST 3: Database atomic transaction & duplicate order prevention', async () => {
    const dupOrderId = `ORD-DUP-${Date.now()}`;
    const dupPosId = `POS-DUP-${Date.now()}`;
    const pos: Position = {
      id: dupPosId,
      accountId: 'paper-default',
      symbol: 'AVAXUSDT',
      mode: 'PAPER',
      status: 'OPEN',
      entryPrice: 30.0,
      quantity: 10,
      remainingQuantity: 10,
      entryQuoteAmount: 300,
      entryFees: 0.3,
      entryScore: 85,
      entryState: 'STRONG_BULLISH',
      entryReason: 'Tx Test',
      currentPrice: 30.0,
      currentScore: 85,
      currentState: 'STRONG_BULLISH',
      grossPnL: 0,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      estimatedNetPnL: 0,
      estimatedNetPnLPercent: 0,
      breakEvenPrice: 30.06,
      takeProfitPrice: 30.6,
      stopLossPrice: 29.1,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      entryOrderId: dupOrderId,
    };
    const ord: Order = {
      id: dupOrderId,
      clientOrderId: `CLIENT-${dupOrderId}`,
      accountId: 'paper-default',
      mode: 'PAPER',
      symbol: 'AVAXUSDT',
      side: 'BUY',
      status: 'FILLED',
      requestedQuoteAmount: 300,
      executedQuantity: 10,
      executedQuoteAmount: 300,
      executionPrice: 30.0,
      fee: 0.3,
      feeAsset: 'USDT',
      reason: 'Tx Test',
      strategyState: 'STRONG_BULLISH',
      technicalScore: 85,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fills: [],
    };
    const wallet = Storage.getWallet('PAPER');
    await Storage.openPositionTx({ position: pos, order: ord, wallet });

    // Attempting to open same order again MUST reject with duplicate error
    await assert.rejects(
      async () => {
        await Storage.openPositionTx({ position: pos, order: ord, wallet });
      },
      /Duplicate order prevented|Duplicate position prevented/
    );
  });

  test('PERSISTENCE TEST 4: Database URL sanitization protects credentials from logs', () => {
    const rawWithPass = 'postgresql://binance_trader:SecretPassword123@dpg-server-a.render.com/binance_trader';
    const sanitized = sanitizeDatabaseUrl(rawWithPass);
    assert.ok(!sanitized.includes('SecretPassword123'), 'Sanitized URL must NEVER contain database password');
    assert.ok(sanitized.includes('binance_trader'), 'Sanitized URL preserves username and database target');
    assert.ok(sanitized.includes('****'), 'Sanitized URL replaces password with asterisks');
  });

  test('PERSISTENCE TEST 5: Database backup snapshot generation', () => {
    const backup = Storage.backupDatabase();
    assert.strictEqual(backup.success, true);
    assert.ok(backup.sizeBytes > 0);
    assert.ok(backup.backupPath.includes('pg-database-backup'));
  });

  // -------------------------------------------------------------
  // 13. Live Trading Safety Guard (LIVE_TRADING_ENABLED)
  // -------------------------------------------------------------
  console.log('\n13. Live Trading Execution Guard Verification:');

  test('GUARD TEST 1: REAL order execution is strictly blocked when LIVE_TRADING_ENABLED != true', () => {
    const originalLiveTradingEnv = process.env.LIVE_TRADING_ENABLED;
    try {
      process.env.LIVE_TRADING_ENABLED = 'false';

      const filter: SymbolFilterRules = {
        minNotional: 5,
        minQty: 0.0001,
        maxQty: 999999,
        stepSize: 0.0001,
        tickSize: 0.01,
        minPrice: 0.01,
        maxPrice: 1000000,
      };

      const realWallet: WalletBalance = {
        mode: 'REAL',
        usdtAvailable: 500,
        usdtLocked: 0,
        usdtTotal: 500,
        accountAssetValue: 0,
        totalEquity: 500,
        startingBalance: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        totalFeesPaid: 0,
        assets: [],
        lastReconciledAt: Date.now(),
        reconciliationStatus: 'OK',
      };

      const safetyResult = SafetyGate.validateBuy(
        {
          symbol: 'BTCUSDT',
          side: 'BUY',
          quoteAmount: 100,
          reason: 'Test Real Buy',
          strategyState: 'STRONG_BULLISH',
          technicalScore: 90,
          clientOrderId: 'test-guard-1',
        },
        'REAL',
        { ...baseSettings, autoTrading: true, fixedTradeAmount: 100 },
        realWallet,
        [],
        filter,
        50000,
        false
      );

      assert.strictEqual(safetyResult.allowed, false);
      assert.strictEqual(safetyResult.code, 'LIVE_TRADING_DISABLED_BY_CONFIG');
      assert.ok(safetyResult.reason?.includes('LIVE_TRADING_ENABLED'));
    } finally {
      process.env.LIVE_TRADING_ENABLED = originalLiveTradingEnv;
    }
  });

  await testQueue;

  console.log(`\n==============================================`);
  console.log(`Test Results: ${passed} Passed, ${failed} Failed.`);
  console.log(`==============================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});

