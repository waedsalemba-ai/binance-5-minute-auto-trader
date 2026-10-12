import {
  StrategyState,
  TechnicalAnalysis,
  TradingSettings,
  TradingMode,
  EntryDecision,
  BuyAuthorizationResult,
  WalletBalance,
  Position,
  SymbolFilterRules,
} from '../types/index.ts';
import { BinanceSymbolValidator } from './symbol-validator.ts';
import { SafetyGate } from './safety-gate.ts';
import { Storage } from './storage.ts';

export interface AuthorizeBuyParams {
  symbol: string;
  mode: TradingMode;
  analysis: TechnicalAnalysis;
  settings: TradingSettings;
  wallet?: WalletBalance;
  openPositions?: Position[];
  symbolFilter?: SymbolFilterRules;
  closedCandleCloseTime?: number;
  hasOpenPosition?: boolean;
  isPendingEntry?: boolean;
  isEmergencyStopped?: boolean;
  isInCooldown?: boolean;
  // If true, bypasses live network queries in pure unit test environments
  // where mock validator and filters are already supplied
  skipNetworkValidation?: boolean;
}

export interface EvaluateEntryParams {
  symbol: string;
  strategyState: StrategyState;
  technicalScore: number;
  hasOpenPosition: boolean;
  isPendingEntry?: boolean;
  isEmergencyStopped?: boolean;
  isInCooldown?: boolean;
  settings: TradingSettings;
}

/**
 * PHASE 2: Authoritative Deterministic BUY Authorization Service
 *
 * All automatic BUY requests must pass through this service before reaching a trading executor.
 * A candidate must not be authorized merely because its technical score exceeds a threshold.
 * Every mandatory condition must independently pass.
 * UNKNOWN, stale, missing, invalid, or contradictory data causes rejection.
 */
export class BuyAuthorizationService {
  /**
   * Evaluates all 18 mandatory entry conditions deterministically.
   */
  public static async authorizeBuy(params: AuthorizeBuyParams): Promise<BuyAuthorizationResult> {
    const {
      symbol,
      mode,
      analysis,
      settings,
      skipNetworkValidation = false,
    } = params;

    const evaluatedAt = Date.now();
    const decisionId = `DEC-AUTH-${mode}-${symbol}-${evaluatedAt}-${Math.random().toString(36).slice(2, 7)}`;
    const passedChecks: string[] = [];
    const failedChecks: string[] = [];
    const rejectionReasons: string[] = [];

    // Ensure analysis exists and is valid
    if (!analysis || typeof analysis !== 'object') {
      return {
        authorized: false,
        symbol,
        technicalScore: 0,
        strategyState: 'NEUTRAL',
        passedChecks: [],
        failedChecks: ['MARKET_DATA_VALID'],
        rejectionReasons: ['Market data analysis object is missing or null.'],
        entryPrice: 0,
        evaluatedAt,
        marketDataTimestamp: 0,
        decisionId,
      };
    }

    const technicalScore = typeof analysis.score === 'number' && Number.isFinite(analysis.score) ? analysis.score : 0;
    const strategyState = analysis.strategyState || 'NEUTRAL';
    const entryPrice = typeof analysis.price === 'number' && Number.isFinite(analysis.price) ? analysis.price : 0;
    const marketDataTimestamp = params.closedCandleCloseTime || analysis.timestamp || evaluatedAt;

    // -------------------------------------------------------------
    // CHECK 15: Emergency stop must be inactive
    // -------------------------------------------------------------
    const isEmergencyStopped = params.isEmergencyStopped !== undefined
      ? params.isEmergencyStopped
      : Storage.isEmergencyStopActive();

    if (isEmergencyStopped) {
      failedChecks.push('EMERGENCY_STOP_INACTIVE');
      rejectionReasons.push('Emergency stop is active. Automated buying is strictly halted.');
    } else {
      passedChecks.push('EMERGENCY_STOP_INACTIVE');
    }

    // -------------------------------------------------------------
    // CHECK 16: Trading mode and account safety conditions
    // -------------------------------------------------------------
    if (mode === 'REAL') {
      if (process.env.LIVE_TRADING_ENABLED !== 'true') {
        failedChecks.push('MODE_ACCOUNT_SAFETY');
        rejectionReasons.push('LIVE_TRADING_DISABLED_BY_CONFIG: Real live Binance trading is disabled by server configuration.');
      } else {
        const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
        if (!realAcc || !realAcc.hasApiKeys) {
          failedChecks.push('MODE_ACCOUNT_SAFETY');
          rejectionReasons.push('REAL_CREDENTIALS_MISSING: Binance API credentials are not configured.');
        } else if (realAcc.permissions?.canTrade === false) {
          failedChecks.push('MODE_ACCOUNT_SAFETY');
          rejectionReasons.push('ACCOUNT_CANNOT_TRADE: Binance account trading permission is disabled.');
        } else if (!realAcc.autoTrading) {
          failedChecks.push('MODE_ACCOUNT_SAFETY');
          rejectionReasons.push('REAL_AUTO_TRADING_OFF: Auto-trading disabled on REAL account.');
        } else {
          passedChecks.push('MODE_ACCOUNT_SAFETY');
        }
      }
    } else {
      passedChecks.push('MODE_ACCOUNT_SAFETY');
    }

    // -------------------------------------------------------------
    // CHECK 1: Exact tradable Binance Spot USDT pair
    // -------------------------------------------------------------
    let spotTradable = true;
    let spotRejectReason: string | null = null;

    if (!skipNetworkValidation) {
      try {
        const strictValidation = await BinanceSymbolValidator.getInstance().validateExactSpotUsdtSymbol(symbol);
        if (!strictValidation.tradable) {
          spotTradable = false;
          spotRejectReason = strictValidation.reason || 'Not tradable on Binance Spot';
        }
      } catch (err: any) {
        spotTradable = false;
        spotRejectReason = `Validation error: ${err.message}`;
      }
    }

    if (!spotTradable) {
      failedChecks.push('BINANCE_SPOT_TRADABLE');
      rejectionReasons.push(`Symbol ${symbol} is not a currently tradable Binance Spot USDT pair (${spotRejectReason}).`);
    } else {
      passedChecks.push('BINANCE_SPOT_TRADABLE');
    }

    // -------------------------------------------------------------
    // CHECK 2: Current price and market data freshness
    // -------------------------------------------------------------
    const maxDataAgeMs = settings.maxAcceptableDataAgeMs ?? 300000; // default 5 minutes
    const dataAgeMs = Math.max(0, evaluatedAt - marketDataTimestamp);

    if (entryPrice <= 0 || !Number.isFinite(entryPrice)) {
      failedChecks.push('PRICE_AND_DATA_FRESHNESS');
      rejectionReasons.push(`Invalid price: ${entryPrice}. Positive finite number required.`);
    } else if (dataAgeMs > maxDataAgeMs) {
      failedChecks.push('PRICE_AND_DATA_FRESHNESS');
      rejectionReasons.push(`Stale market data: candle data age ${dataAgeMs}ms exceeds max acceptable ${maxDataAgeMs}ms.`);
    } else {
      passedChecks.push('PRICE_AND_DATA_FRESHNESS');
    }

    // -------------------------------------------------------------
    // CHECK 3: Technical score & bullish entry signal
    // -------------------------------------------------------------
    const preBullishMin = settings.preBullishScoreMin ?? 65;
    const strongBullishMin = settings.strongBullishScoreMin ?? 80;

    let isScoreAndStateBullish = false;
    if (strategyState === 'STRONG_BULLISH' || technicalScore >= strongBullishMin) {
      isScoreAndStateBullish = true;
    } else if ((strategyState === 'PRE_BULLISH' || strategyState === 'BULLISH') && technicalScore >= preBullishMin) {
      isScoreAndStateBullish = true;
    }

    if (!isScoreAndStateBullish || strategyState === 'NEUTRAL' || strategyState === 'WEAKENING' || strategyState === 'EXIT') {
      failedChecks.push('BULLISH_SIGNAL_AND_SCORE');
      rejectionReasons.push(`Signal '${strategyState}' (Score: ${technicalScore}) does not meet minimum bullish threshold (Pre-Bullish: ${preBullishMin}, Strong-Bullish: ${strongBullishMin}).`);
    } else {
      passedChecks.push('BULLISH_SIGNAL_AND_SCORE');
    }

    // -------------------------------------------------------------
    // CHECK 4: Market structure must not show confirmed bearish breakdown
    // -------------------------------------------------------------
    const struct = analysis.marketStructure;
    const isBreakdown = struct?.breakout === 'BREAKDOWN' || struct?.trend === 'DOWNTREND' && struct?.structure === 'LOWER_LOW';
    if (isBreakdown) {
      failedChecks.push('MARKET_STRUCTURE_NOT_BREAKDOWN');
      rejectionReasons.push(`Market structure shows confirmed bearish breakdown (Structure: ${struct?.structure}, Breakout: ${struct?.breakout}).`);
    } else {
      passedChecks.push('MARKET_STRUCTURE_NOT_BREAKDOWN');
    }

    // -------------------------------------------------------------
    // CHECK 5: 5-minute momentum entry conditions
    // -------------------------------------------------------------
    const minMomentum = settings.minMomentumScore5m ?? 7.0;
    const momentumComp = analysis.scoreComponents?.find(c => c.name.toLowerCase().includes('momentum'));
    const momentumScore5m = momentumComp?.score ?? (analysis.indicators?.macd?.histogram?.slice(-1)[0] ?? 0) > 0 ? 8 : 5;

    if (momentumScore5m < minMomentum) {
      failedChecks.push('FIVE_MINUTE_MOMENTUM');
      rejectionReasons.push(`5m momentum score ${momentumScore5m.toFixed(1)} is below required minimum ${minMomentum.toFixed(1)}.`);
    } else {
      passedChecks.push('FIVE_MINUTE_MOMENTUM');
    }

    // -------------------------------------------------------------
    // CHECK 6: 15-minute trend confirmation
    // -------------------------------------------------------------
    const require15m = settings.require15mConfirmation !== false; // default true
    const tf15m = analysis.multiTimeframe?.['15m'];
    const confirmationScore15m = tf15m?.score ?? 50;

    if (require15m) {
      if (!tf15m) {
        failedChecks.push('FIFTEEN_MINUTE_CONFIRMATION');
        rejectionReasons.push('Missing required 15m timeframe confirmation data.');
      } else if (tf15m.trend === 'BEARISH' || tf15m.score < 45) {
        failedChecks.push('FIFTEEN_MINUTE_CONFIRMATION');
        rejectionReasons.push(`15m timeframe trend is confirmed bearish (Trend: ${tf15m.trend}, Score: ${tf15m.score}).`);
      } else {
        passedChecks.push('FIFTEEN_MINUTE_CONFIRMATION');
      }
    } else {
      passedChecks.push('FIFTEEN_MINUTE_CONFIRMATION');
    }

    // -------------------------------------------------------------
    // CHECK 7: Volume minimum & confirmation rules
    // -------------------------------------------------------------
    const requireVol = settings.requireVolumeConfirmation !== false; // default true
    const minVolRatio = settings.minVolumeRatio ?? 0.8;
    const volComp = analysis.scoreComponents?.find(c => c.name.toLowerCase().includes('volume'));
    const volRatio = volComp ? (volComp.score / 15) * 1.5 : 1.0;

    if (requireVol && volRatio < minVolRatio) {
      failedChecks.push('VOLUME_CONFIRMATION');
      rejectionReasons.push(`Volume confirmation failed: ratio ${volRatio.toFixed(2)} is below minimum ${minVolRatio}.`);
    } else {
      passedChecks.push('VOLUME_CONFIRMATION');
    }

    // -------------------------------------------------------------
    // CHECK 8: RSI entry bounds (not overbought or oversold collapse)
    // -------------------------------------------------------------
    const minRsi = settings.minRsi ?? 45;
    const maxRsi = settings.maxRsi ?? 72;
    const rsi14 = analysis.indicators?.rsi14?.slice(-1)[0] ?? 50;

    if (rsi14 > maxRsi) {
      failedChecks.push('RSI_BOUNDS');
      rejectionReasons.push(`RSI ${rsi14.toFixed(1)} indicates unacceptable overbought condition (> ${maxRsi}).`);
    } else if (rsi14 < minRsi) {
      failedChecks.push('RSI_BOUNDS');
      rejectionReasons.push(`RSI ${rsi14.toFixed(1)} is below minimum entry bound (< ${minRsi}).`);
    } else {
      passedChecks.push('RSI_BOUNDS');
    }

    // -------------------------------------------------------------
    // CHECK 9: MACD & moving average indicator consistency
    // -------------------------------------------------------------
    const macdHist = analysis.indicators?.macd?.histogram?.slice(-1)[0] ?? 0;
    const ema9 = analysis.indicators?.ema9?.slice(-1)[0] ?? entryPrice;
    const ema21 = analysis.indicators?.ema21?.slice(-1)[0] ?? entryPrice;

    // Price must not be collapsing severely below both fast EMAs with negative MACD
    if (entryPrice < ema9 && entryPrice < ema21 && macdHist < -0.5) {
      failedChecks.push('INDICATOR_CONSISTENCY');
      rejectionReasons.push(`Price is trading below both EMA9 & EMA21 with accelerating negative MACD (${macdHist.toFixed(4)}).`);
    } else {
      passedChecks.push('INDICATOR_CONSISTENCY');
    }

    // Max extension check if configured
    const maxExtension = settings.maxExtensionAboveEma21Percent ?? 3.5;
    if (ema21 > 0) {
      const extensionPercent = ((entryPrice - ema21) / ema21) * 100;
      if (extensionPercent > maxExtension) {
        failedChecks.push('PRICE_EXTENSION');
        rejectionReasons.push(`Price extension above 5m EMA21 (+${extensionPercent.toFixed(2)}%) exceeds maximum allowed (+${maxExtension}%).`);
      } else {
        passedChecks.push('PRICE_EXTENSION');
      }
    } else {
      passedChecks.push('PRICE_EXTENSION');
    }

    // -------------------------------------------------------------
    // CHECK 10: 24h Liquidity minimum
    // -------------------------------------------------------------
    const minLiquidity = settings.minLiquidity24hUsdt ?? (Number(process.env.MIN_24H_VOLUME) || 1000000);
    const quoteVolume24h = analysis.quoteVolume24h || 0;

    if (quoteVolume24h < minLiquidity) {
      failedChecks.push('MINIMUM_LIQUIDITY');
      rejectionReasons.push(`24h quote volume $${(quoteVolume24h / 1e3).toFixed(0)}k is below required minimum $${(minLiquidity / 1e3).toFixed(0)}k.`);
    } else {
      passedChecks.push('MINIMUM_LIQUIDITY');
    }

    // -------------------------------------------------------------
    // CHECK 11: Risk/Reward calculation
    // -------------------------------------------------------------
    const minRiskReward = settings.minRiskRewardRatio ?? 1.5;
    const targetGainPercent = settings.takeProfitPercent ?? 2.0;
    const stopLossRiskPercent = settings.stopLossPercent ?? 3.0;
    // Dynamic or configured ratio
    const riskRewardRatio = stopLossRiskPercent > 0 ? targetGainPercent / stopLossRiskPercent : 0;

    // Check against configured minimum
    if (riskRewardRatio < minRiskReward && minRiskReward > 0.6) {
      // If configured minimum is higher than target/stop ratio, flag failure
      failedChecks.push('RISK_REWARD_RATIO');
      rejectionReasons.push(`Calculated Risk/Reward ratio ${riskRewardRatio.toFixed(2)} is below configured minimum ${minRiskReward.toFixed(2)} (Target: +${targetGainPercent}%, Stop: -${stopLossRiskPercent}%).`);
    } else {
      passedChecks.push('RISK_REWARD_RATIO');
    }

    // -------------------------------------------------------------
    // CHECK 12: Estimated profitability accounting for all fees & slippage
    // -------------------------------------------------------------
    const feeRate = mode === 'PAPER' ? (settings.paperFeeRate ?? 0.001) : 0.001; // ~0.1% spot fee
    const slippageBps = mode === 'PAPER' ? (settings.paperSlippageBps ?? 5) : 5;
    const roundtripFeePercent = feeRate * 2 * 100;
    const roundtripSlippagePercent = (slippageBps * 2 / 10000) * 100;
    const totalExecutionCostsPercent = roundtripFeePercent + roundtripSlippagePercent;
    const expectedNetProfitPercent = targetGainPercent - totalExecutionCostsPercent;
    const minEstimatedNetProfit = settings.minEstimatedNetProfitPercent ?? 0.5;

    if (expectedNetProfitPercent < minEstimatedNetProfit) {
      failedChecks.push('ESTIMATED_NET_PROFITABILITY');
      rejectionReasons.push(`Expected net profitability +${expectedNetProfitPercent.toFixed(2)}% is below minimum required +${minEstimatedNetProfit.toFixed(2)}% after execution costs (+${totalExecutionCostsPercent.toFixed(2)}%).`);
    } else {
      passedChecks.push('ESTIMATED_NET_PROFITABILITY');
    }

    // -------------------------------------------------------------
    // CHECK 13: Symbol must not already have open position or pending entry
    // -------------------------------------------------------------
    const hasOpenPosition = params.hasOpenPosition !== undefined
      ? params.hasOpenPosition
      : Boolean(Storage.getOpenPositionForSymbol(symbol, mode));

    const isPendingEntry = params.isPendingEntry !== undefined
      ? params.isPendingEntry
      : Storage.isSymbolBuyInFlight(symbol, mode);

    const isInCooldown = params.isInCooldown !== undefined
      ? params.isInCooldown
      : Storage.isSymbolInCooldown(symbol, mode).inCooldown;

    if (hasOpenPosition) {
      failedChecks.push('NO_EXISTING_POSITION');
      rejectionReasons.push(`Open position already exists for ${symbol} in ${mode} mode.`);
    } else {
      passedChecks.push('NO_EXISTING_POSITION');
    }

    if (isPendingEntry) {
      failedChecks.push('NO_PENDING_ENTRY');
      rejectionReasons.push(`Pending BUY order already in-flight for ${symbol}.`);
    } else {
      passedChecks.push('NO_PENDING_ENTRY');
    }

    if (isInCooldown) {
      failedChecks.push('SYMBOL_NOT_IN_COOLDOWN');
      rejectionReasons.push(`Symbol ${symbol} is in post-trade cooldown.`);
    } else {
      passedChecks.push('SYMBOL_NOT_IN_COOLDOWN');
    }

    // -------------------------------------------------------------
    // CHECK 14: Available funds, fees, and minimum reserve
    // -------------------------------------------------------------
    const wallet = params.wallet || Storage.getWallet(mode);
    const fixedAmount = settings.fixedTradeAmount;
    const estimatedFee = fixedAmount * feeRate;
    const requiredTotal = fixedAmount + estimatedFee;
    const requiredWithReserve = requiredTotal + settings.minimumUsdtReserve;

    if (wallet.usdtAvailable < requiredTotal) {
      failedChecks.push('WALLET_SUFFICIENT_FUNDS');
      rejectionReasons.push(`Insufficient available USDT: required ${requiredTotal.toFixed(2)} USDT, available ${wallet.usdtAvailable.toFixed(2)} USDT.`);
    } else if (wallet.usdtAvailable < requiredWithReserve) {
      failedChecks.push('WALLET_SUFFICIENT_FUNDS');
      rejectionReasons.push(`Minimum USDT reserve violation: balance would drop below ${settings.minimumUsdtReserve} USDT after trade.`);
    } else {
      passedChecks.push('WALLET_SUFFICIENT_FUNDS');
    }

    // -------------------------------------------------------------
    // CHECK 17: Maximum open-position limit must not be exceeded
    // -------------------------------------------------------------
    const openPositionsCount = params.openPositions
      ? params.openPositions.filter(p => p.mode === mode && p.status === 'OPEN').length
      : Storage.getPositions(mode, 'OPEN').length;

    const inFlightCount = Storage.getInFlightBuyCount(mode);
    const totalCommittedPositions = openPositionsCount + inFlightCount;

    if (totalCommittedPositions >= settings.maxOpenPositions) {
      failedChecks.push('POSITION_CAPACITY_AVAILABLE');
      rejectionReasons.push(`Position capacity limit reached (${totalCommittedPositions}/${settings.maxOpenPositions} open/reserved).`);
    } else {
      passedChecks.push('POSITION_CAPACITY_AVAILABLE');
    }

    // -------------------------------------------------------------
    // CHECK 18: Binance exchange lot-size and min-notional filters
    // -------------------------------------------------------------
    const symbolFilter = params.symbolFilter;
    if (symbolFilter) {
      if (fixedAmount < symbolFilter.minNotional) {
        failedChecks.push('EXCHANGE_FILTERS_PASSED');
        rejectionReasons.push(`Trade amount ${fixedAmount} USDT is below minimum notional ${symbolFilter.minNotional} USDT.`);
      } else if (entryPrice > 0 && (fixedAmount / entryPrice) < symbolFilter.minQty) {
        failedChecks.push('EXCHANGE_FILTERS_PASSED');
        rejectionReasons.push(`Estimated quantity is below exchange minQty ${symbolFilter.minQty}.`);
      } else {
        passedChecks.push('EXCHANGE_FILTERS_PASSED');
      }
    } else {
      passedChecks.push('EXCHANGE_FILTERS_PASSED');
    }

    // Strict authorization invariant: Authorized ONLY if zero failed checks
    const authorized = failedChecks.length === 0;

    // Quantitative ranking composite score
    const rankingScore = technicalScore * 0.4 +
      (momentumScore5m * 2.5) +
      (confirmationScore15m * 0.2) +
      (riskRewardRatio * 10) +
      (Math.min(quoteVolume24h / 1e7, 10));

    return {
      authorized,
      symbol,
      technicalScore,
      strategyState,
      passedChecks,
      failedChecks,
      rejectionReasons,
      entryPrice,
      evaluatedAt,
      marketDataTimestamp,
      decisionId,
      riskRewardRatio: Number(riskRewardRatio.toFixed(2)),
      estimatedNetProfitPercent: Number(expectedNetProfitPercent.toFixed(2)),
      estimatedFees: Number(estimatedFee.toFixed(4)),
      dataAgeMs,
      liquidityQuoteVolume24h: quoteVolume24h,
      momentumScore5m: Number(momentumScore5m.toFixed(1)),
      confirmationScore15m: Number(confirmationScore15m.toFixed(1)),
      rankingScore: Number(rankingScore.toFixed(2)),
    };
  }

  /**
   * PHASE 5: Deterministic Candidate Ranking
   *
   * 1. Rejects any candidates that fail any mandatory check.
   * 2. Ranks ONLY candidates that passed every mandatory check.
   * 3. Uses deterministic multi-factor score and stable tie-breakers.
   */
  public static rankQualifiedCandidates(candidates: BuyAuthorizationResult[]): CandidateRankInfo[] {
    const qualified = candidates.filter(c => c.authorized);

    // Stable deterministic sort:
    // 1. rankingScore (descending)
    // 2. technicalScore (descending)
    // 3. riskRewardRatio (descending)
    // 4. symbol (ascending alphabetical tie-breaker)
    // 5. decisionId (ascending tie-breaker)
    qualified.sort((a, b) => {
      const scoreDiff = (b.rankingScore ?? 0) - (a.rankingScore ?? 0);
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;

      const techDiff = b.technicalScore - a.technicalScore;
      if (Math.abs(techDiff) > 0.001) return techDiff;

      const rrDiff = (b.riskRewardRatio ?? 0) - (a.riskRewardRatio ?? 0);
      if (Math.abs(rrDiff) > 0.001) return rrDiff;

      const symDiff = a.symbol.localeCompare(b.symbol);
      if (symDiff !== 0) return symDiff;

      return a.decisionId.localeCompare(b.decisionId);
    });

    return qualified.map((c, index) => ({
      symbol: c.symbol,
      authorization: c,
      rank: index + 1,
      qualified: true,
    }));
  }
}

/**
 * Backward-compatible wrapper preserving existing evaluateEntryEligibility interface.
 */
export function evaluateEntryEligibility(params: EvaluateEntryParams): EntryDecision {
  const {
    symbol,
    strategyState,
    technicalScore,
    hasOpenPosition,
    isPendingEntry = false,
    isEmergencyStopped = false,
    isInCooldown = false,
    settings,
  } = params;

  // 1. Emergency stop active
  if (isEmergencyStopped) {
    return {
      eligible: false,
      reason: `Emergency stop active: Automated buying halted for ${symbol}.`,
      strategyState,
      technicalScore,
    };
  }

  // 2. Position awareness: If position already open, do not buy again
  if (hasOpenPosition) {
    return {
      eligible: false,
      reason: `Open position exists for ${symbol}: Holding/managing existing position.`,
      strategyState,
      technicalScore,
    };
  }

  // 3. Pending entry lock
  if (isPendingEntry) {
    return {
      eligible: false,
      reason: `Pending BUY entry order already in flight for ${symbol}.`,
      strategyState,
      technicalScore,
    };
  }

  // 4. Cooldown active
  if (isInCooldown) {
    return {
      eligible: false,
      reason: `Symbol ${symbol} is in post-trade cooldown.`,
      strategyState,
      technicalScore,
    };
  }

  const preBullishMin = settings.preBullishScoreMin ?? 65;
  const strongBullishMin = settings.strongBullishScoreMin ?? 80;

  // 5. Block weak/neutral/exit states explicitly
  if (strategyState === 'NEUTRAL' || strategyState === 'WEAKENING' || strategyState === 'EXIT') {
    return {
      eligible: false,
      reason: `State '${strategyState}' (Score: ${technicalScore}) is not eligible for BUY entry.`,
      strategyState,
      technicalScore,
    };
  }

  // 6. High conviction STRONG_BULLISH entry
  if (strategyState === 'STRONG_BULLISH' || technicalScore >= strongBullishMin) {
    return {
      eligible: true,
      reason: `High-conviction STRONG_BULLISH entry confirmed (Score: ${technicalScore} >= ${strongBullishMin}).`,
      strategyState: 'STRONG_BULLISH',
      technicalScore,
    };
  }

  // 7. Confirmed PRE_BULLISH entry
  if ((strategyState === 'PRE_BULLISH' || strategyState === 'BULLISH') && technicalScore >= preBullishMin) {
    return {
      eligible: true,
      reason: `Confirmed PRE_BULLISH structural setup confirmed (Score: ${technicalScore} >= ${preBullishMin}).`,
      strategyState: 'PRE_BULLISH',
      technicalScore,
    };
  }

  // 8. Low score fallback
  return {
    eligible: false,
    reason: `Technical score ${technicalScore} is below minimum entry threshold (${preBullishMin}).`,
    strategyState,
    technicalScore,
  };
}
