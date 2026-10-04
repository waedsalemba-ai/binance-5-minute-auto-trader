import {
  StrategyState,
  TechnicalAnalysis,
  TradingSettings,
  EntryDecision,
} from '../types/index.ts';

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
 * Authoritative entry decision evaluation engine.
 * Determines whether a symbol signal is eligible for automated BUY entry.
 *
 * Requirements:
 * 1. Both PRE_BULLISH (score >= preBullishScoreMin) and STRONG_BULLISH (score >= strongBullishScoreMin)
 *    are valid entry triggers when no position exists.
 * 2. STRONG_BULLISH is NOT an exit-only state: with no position it triggers BUY; with an open position it HOLDS.
 * 3. Does not require a previous state (e.g. unknown -> STRONG_BULLISH is valid).
 * 4. Never buys NEUTRAL, WEAKENING, or EXIT states.
 * 5. Position awareness: blocks duplicate buys if a position is already open.
 * 6. Concurrency safe: respects pending entry locks.
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

  // 2. Position awareness: If position already open, do not buy again (Hold/Manage position instead)
  if (hasOpenPosition) {
    return {
      eligible: false,
      reason: `Open position exists for ${symbol}: Holding/managing existing position.`,
      strategyState,
      technicalScore,
    };
  }

  // 3. Pending entry lock: Prevent concurrent scan cycles from submitting duplicate BUYs
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

  // 6. High conviction STRONG_BULLISH entry (Score >= strongBullishMin or state === 'STRONG_BULLISH')
  if (strategyState === 'STRONG_BULLISH' || technicalScore >= strongBullishMin) {
    return {
      eligible: true,
      reason: `High-conviction STRONG_BULLISH entry confirmed (Score: ${technicalScore} >= ${strongBullishMin}).`,
      strategyState: 'STRONG_BULLISH',
      technicalScore,
    };
  }

  // 7. Confirmed PRE_BULLISH entry (Score >= preBullishMin and state === 'PRE_BULLISH' or 'BULLISH')
  if ((strategyState === 'PRE_BULLISH' || strategyState === 'BULLISH') && technicalScore >= preBullishMin) {
    return {
      eligible: true,
      reason: `Confirmed PRE_BULLISH structural setup confirmed (Score: ${technicalScore} >= ${preBullishMin}).`,
      strategyState: 'PRE_BULLISH',
      technicalScore,
    };
  }

  // 8. Low score or unrecognized state fallback
  return {
    eligible: false,
    reason: `Technical score ${technicalScore} is below minimum entry threshold (${preBullishMin}).`,
    strategyState,
    technicalScore,
  };
}
