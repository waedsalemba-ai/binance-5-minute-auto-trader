/**
 * Binance 5-Minute Crypto Scanner & Auto Trader - Core Types
 */

export type TradingMode = 'PAPER' | 'REAL';

export type StrategyState = 
  | 'NEUTRAL'
  | 'PRE_BULLISH'
  | 'BULLISH'
  | 'STRONG_BULLISH'
  | 'WEAKENING'
  | 'EXIT';

export type OrderSide = 'BUY' | 'SELL';

export type OrderStatus = 
  | 'CREATED'
  | 'SUBMITTING'
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export type PositionStatus = 'OPEN' | 'CLOSING' | 'CLOSED';

export type LogCategory = 
  | 'INFO'
  | 'WARN'
  | 'ERROR'
  | 'SCAN'
  | 'STRATEGY'
  | 'ORDER'
  | 'WALLET'
  | 'RECONCILIATION'
  | 'BINANCE'
  | 'SECURITY'
  | 'DATABASE';

export interface Candle {
  timestamp: number; // Open time ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  isClosed: boolean;
}

export interface TechnicalIndicators {
  ema9: number[];
  ema21: number[];
  ema50: number[];
  ema200: number[];
  sma20: number[];
  sma50: number[];
  sma200: number[];
  rsi14: number[];
  macd: {
    macdLine: number[];
    signalLine: number[];
    histogram: number[];
  };
  bollingerBands: {
    upper: number[];
    middle: number[];
    lower: number[];
    bandwidth: number[];
  };
  atr14: number[];
  vwap: number[];
  volumeSma20: number[];
  volumeRatio: number; // current volume / volumeSma20
}

export interface CandlePattern {
  name: string;
  type: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  significance: 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  timestamp: number;
}

export interface MarketStructure {
  trend: 'UPTREND' | 'DOWNTREND' | 'CONSOLIDATION';
  structure: 'HIGHER_HIGH' | 'HIGHER_LOW' | 'LOWER_HIGH' | 'LOWER_LOW' | 'NEUTRAL';
  breakout: 'BREAKOUT' | 'BREAKDOWN' | 'NONE';
  supportLevels: number[];
  resistanceLevels: number[];
  swingHighs: { price: number; timestamp: number }[];
  swingLows: { price: number; timestamp: number }[];
}

export interface TimeframeSignal {
  timeframe: '5m' | '15m' | '1h' | '4h';
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number;
  rsi: number;
  macdCross: 'BULLISH' | 'BEARISH' | 'NONE';
}

export interface ScoreComponent {
  name: string;
  weight: number;
  score: number;
  details: string;
}

export interface TechnicalAnalysis {
  symbol: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  quoteVolume24h: number;
  timestamp: number;
  indicators: TechnicalIndicators;
  patterns: CandlePattern[];
  marketStructure: MarketStructure;
  multiTimeframe: {
    '5m': TimeframeSignal;
    '15m'?: TimeframeSignal;
    '1h'?: TimeframeSignal;
    '4h'?: TimeframeSignal;
  };
  score: number; // 0 - 100
  scoreComponents: ScoreComponent[];
  strategyState: StrategyState;
  stateReason: string;
}

export interface SymbolFilterRules {
  minNotional: number;
  minQty: number;
  maxQty: number;
  stepSize: number;
  tickSize: number;
  minPrice: number;
  maxPrice: number;
}

export interface TradingAccount {
  id: string;
  name: string;
  mode: TradingMode;
  autoTrading: boolean;
  resumeOnRestart: boolean;
  hasApiKeys: boolean;
  apiKeyMasked?: string;
  apiSecretConfigured?: boolean;
  permissions?: {
    canTrade: boolean;
    canRead: boolean;
    hasWithdrawalWarning: boolean;
  };
  createdAt: number;
  updatedAt: number;
}

export interface Position {
  id: string;
  accountId: string;
  mode: TradingMode;
  symbol: string;
  quantity: number;
  remainingQuantity: number;
  entryPrice: number;
  entryQuoteAmount: number; // CRITICAL: Exact fixed trade amount used
  entryFees: number;
  entryScore: number;
  entryState: StrategyState;
  entryReason: string;
  currentPrice: number;
  currentScore: number;
  currentState: StrategyState;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  grossPnL?: number;
  estimatedNetPnL?: number;
  estimatedNetPnLPercent?: number;
  breakEvenPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  exitStatus?: string;
  exitReason?: string;
  openedAt: number;
  updatedAt: number;
  status: PositionStatus;
  entryOrderId: string;
  exitOrderId?: string;
}

export type ExitReason =
  | 'TAKE_PROFIT'
  | 'STOP_LOSS'
  | 'TECHNICAL_PROFIT_EXIT'
  | 'HOLD_PROFIT_PROTECTION'
  | 'HOLD'
  | 'MANUAL'
  | 'EMERGENCY';

export interface PositionNetPnLResult {
  grossPnL: number;
  netPnL: number;
  netPnLPercent: number;
  estimatedExitPrice: number;
  estimatedExitValue: number;
  entryFees: number;
  estimatedExitFees: number;
}

export interface ExitDecision {
  shouldSell: boolean;
  reason: ExitReason;
  netPnL: number;
  netPnLPercent: number;
  currentPrice: number;
  breakEvenPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  grossPnL: number;
  estimatedExitPrice: number;
  estimatedExitValue: number;
  entryFees: number;
  estimatedExitFees: number;
  logMessage: string;
}

export interface EntryDecision {
  eligible: boolean;
  reason: string;
  strategyState: StrategyState;
  technicalScore: number;
}

export interface Order {
  id: string;
  clientOrderId: string;
  binanceOrderId?: string;
  accountId: string;
  mode: TradingMode;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  requestedQuoteAmount?: number; // Exact fixed amount for BUY
  requestedQuantity?: number; // Exact position quantity for SELL
  executedQuantity: number;
  executedQuoteAmount: number;
  executionPrice: number;
  fee: number;
  feeAsset: string;
  reason: string;
  strategyState: StrategyState;
  technicalScore: number;
  createdAt: number;
  updatedAt: number;
  fills?: {
    price: number;
    qty: number;
    commission: number;
    commissionAsset: string;
    tradeId: number;
  }[];
  errorMessage?: string;
}

export interface Trade {
  id: string;
  accountId: string;
  mode: TradingMode;
  symbol: string;
  entryOrderId: string;
  exitOrderId: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  entryQuoteAmount: number;
  exitQuoteAmount: number;
  entryFees: number;
  exitFees: number;
  grossPnL: number;
  netPnL: number;
  netPnLPercent: number;
  entryScore: number;
  exitScore: number;
  entryReason: string;
  exitReason: string;
  openedAt: number;
  closedAt: number;
  durationMs: number;
}

export interface WalletBalance {
  mode: TradingMode;
  usdtAvailable: number;
  usdtLocked: number;
  usdtTotal: number;
  accountAssetValue: number;
  totalEquity: number;
  startingBalance: number;
  realizedPnL: number;
  unrealizedPnL: number;
  totalFeesPaid: number;
  assets: {
    asset: string;
    symbol: string;
    free: number;
    locked: number;
    total: number;
    price: number;
    valueUsdt: number;
    isExternal: boolean;
  }[];
  lastReconciledAt: number;
  reconciliationStatus: 'OK' | 'MISMATCH' | 'SYNCING' | 'ERROR';
  reconciliationError?: string;
}

export interface TradingSettings {
  mode: TradingMode;
  autoTrading: boolean;
  fixedTradeAmount: number; // Hard fixed USDT amount per BUY
  maxOpenPositions: number;
  minimumUsdtReserve: number;
  symbolCooldownMinutes: number;
  preBullishScoreMin: number;
  strongBullishScoreMin: number;
  weakeningThreshold: number;
  maxTradeAmount: number;
  paperStartingBalance: number;
  paperFeeRate: number;
  paperSlippageBps: number;
  manageExistingHoldings: boolean;
  resumeOnRestart: boolean;
  scanIntervalMs: number;
  // Exit Engine & Profitability Gate Parameters
  takeProfitPercent: number; // e.g. 2.0% NET profit target
  stopLossPercent: number; // e.g. 3.0% NET loss ceiling
  minProfitForTechnicalExitPercent: number; // e.g. 0.20% minimum buffer for technical weakening exits
  maxExitPriceAgeMs: number; // e.g. 5000 ms max allowable price age before exit decision
}

export interface SystemLogEntry {
  id: string;
  timestamp: number;
  category: LogCategory;
  level: 'info' | 'warn' | 'error';
  mode: TradingMode;
  symbol?: string;
  orderId?: string;
  strategyState?: StrategyState;
  technicalScore?: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface ScannerSummary {
  pairsAnalyzed: number;
  preBullishCount: number;
  bullishCount: number;
  strongBullishCount: number;
  weakeningCount: number;
  neutralCount: number;
  openPositionsCount: number;
  todayTradesCount: number;
  lastScanTime: number;
  nextScanTime: number;
  isScanning: boolean;
  error?: string;
}

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  code: string;
  details?: Record<string, unknown>;
}

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  quoteAmount?: number; // MUST equal fixedTradeAmount for BUY
  quantity?: number; // MUST equal position.remainingQuantity for SELL
  reason: string;
  strategyState: StrategyState;
  technicalScore: number;
  clientOrderId: string;
}

export interface ExecutionResult {
  success: boolean;
  order: Order;
  position?: Position;
  trade?: Trade;
  error?: string;
}

export interface ReconciliationResult {
  status: 'OK' | 'MISMATCH' | 'ERROR';
  mode: TradingMode;
  discrepancies: string[];
  correctedCount: number;
  timestamp: number;
}

// --- Binance Symbol Validation & Migration Types ---
export type MarketType = 'SPOT' | 'USDM_FUTURES';

export interface SymbolNormalizationResult {
  originalSymbol: string;
  normalizedSymbol: string;
  baseAsset: string;
  quoteAsset: string;
  mappingApplied: boolean;
  mappingReason: string | null;
}

export interface SymbolValidationResult {
  requestedSymbol: string;
  normalizedSymbol: string;
  market: MarketType;
  exists: boolean;
  status: string | null; // e.g. 'TRADING', 'BREAK', 'HALT', 'DELISTED', null
  tradable: boolean;
  reason: string | null;
  baseAsset?: string;
  quoteAsset?: string;
  filters?: SymbolFilterRules;
  lastUpdated?: number;
}

export interface SymbolAuditRecord {
  timestamp: number;
  requestedSymbol: string;
  normalizedSymbol: string;
  market: MarketType;
  side: OrderSide;
  validationResult: boolean;
  binanceStatus: string | null;
  mappingApplied: boolean;
  rejectionReason: string | null;
  orderId?: string;
}

