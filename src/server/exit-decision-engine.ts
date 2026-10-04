import {
  Position,
  TradingSettings,
  StrategyState,
  ExitDecision,
  ExitReason,
  PositionNetPnLResult,
} from '../types/index.ts';

/**
 * Authoritative position Net PnL calculation.
 * Accounts for entry fees, estimated exit fees, and estimated exit slippage.
 */
export function calculatePositionNetPnL(
  position: Pick<Position, 'quantity' | 'remainingQuantity' | 'entryPrice' | 'entryQuoteAmount' | 'entryFees'>,
  currentPrice: number,
  feeRate = 0.001,
  slippageBps = 5
): PositionNetPnLResult {
  const sellQty = position.remainingQuantity > 0 ? position.remainingQuantity : position.quantity;
  const slippageMultiplier = 1 - slippageBps / 10000;
  const estimatedExitPrice = Number((currentPrice * slippageMultiplier).toFixed(6));
  const estimatedGrossExitValue = Number((sellQty * estimatedExitPrice).toFixed(4));
  const estimatedExitFees = Number((estimatedGrossExitValue * feeRate).toFixed(4));
  const estimatedNetExitValue = estimatedGrossExitValue - estimatedExitFees;

  const costBasisRatio = position.quantity > 0 ? sellQty / position.quantity : 1;
  const entryCostAllocated = position.entryQuoteAmount * costBasisRatio;
  const entryFeesAllocated = position.entryFees * costBasisRatio;

  const grossExitAtMarket = Number((sellQty * currentPrice).toFixed(4));
  const grossPnL = Number((grossExitAtMarket - entryCostAllocated).toFixed(4));

  const totalCost = entryCostAllocated + entryFeesAllocated;
  const netPnL = Number((estimatedNetExitValue - totalCost).toFixed(4));
  const netPnLPercent = entryCostAllocated > 0
    ? Number(((netPnL / entryCostAllocated) * 100).toFixed(2))
    : 0;

  return {
    grossPnL,
    netPnL,
    netPnLPercent,
    estimatedExitPrice,
    estimatedExitValue: estimatedGrossExitValue,
    entryFees: Number(entryFeesAllocated.toFixed(4)),
    estimatedExitFees,
  };
}

/**
 * Calculates the exact market exit price required to break even (Net PnL = 0)
 * after accounting for entry costs, entry fees, estimated exit fees, and slippage.
 */
export function calculateBreakEvenExitPrice(
  position: Pick<Position, 'quantity' | 'remainingQuantity' | 'entryPrice' | 'entryQuoteAmount' | 'entryFees'>,
  feeRate = 0.001,
  slippageBps = 5
): number {
  const sellQty = position.remainingQuantity > 0 ? position.remainingQuantity : position.quantity;
  if (sellQty <= 0) return position.entryPrice;

  const costBasisRatio = position.quantity > 0 ? sellQty / position.quantity : 1;
  const entryCostAllocated = position.entryQuoteAmount * costBasisRatio;
  const entryFeesAllocated = position.entryFees * costBasisRatio;
  const totalCost = entryCostAllocated + entryFeesAllocated;

  const slippageMultiplier = 1 - slippageBps / 10000;
  const costFactor = slippageMultiplier * (1 - feeRate);

  if (costFactor <= 0) return position.entryPrice;

  const breakEven = totalCost / (sellQty * costFactor);
  return Number(breakEven.toFixed(6));
}

/**
 * Calculates the exact market price required to reach a specific net PnL target percentage.
 */
export function calculateTargetExitPrice(
  position: Pick<Position, 'quantity' | 'remainingQuantity' | 'entryPrice' | 'entryQuoteAmount' | 'entryFees'>,
  targetNetPercent: number,
  feeRate = 0.001,
  slippageBps = 5
): number {
  const sellQty = position.remainingQuantity > 0 ? position.remainingQuantity : position.quantity;
  if (sellQty <= 0) return position.entryPrice;

  const costBasisRatio = position.quantity > 0 ? sellQty / position.quantity : 1;
  const entryCostAllocated = position.entryQuoteAmount * costBasisRatio;
  const entryFeesAllocated = position.entryFees * costBasisRatio;

  const targetNetPnL = entryCostAllocated * (targetNetPercent / 100);
  const requiredNetExitValue = entryCostAllocated + entryFeesAllocated + targetNetPnL;

  const slippageMultiplier = 1 - slippageBps / 10000;
  const costFactor = slippageMultiplier * (1 - feeRate);

  if (costFactor <= 0) return position.entryPrice;

  const targetPrice = requiredNetExitValue / (sellQty * costFactor);
  return Number(targetPrice.toFixed(6));
}

export interface EvaluateExitDecisionParams {
  position: Position;
  currentPrice: number;
  priceTimestamp?: number;
  strategyState: StrategyState;
  technicalScore?: number;
  settings: TradingSettings;
  isEmergencyStopped?: boolean;
  isManual?: boolean;
}

/**
 * Authoritative Centralized Exit Decision Engine.
 * Evaluates Stop Loss, Take Profit, Technical Weakening with Profitability Gate, and Hold.
 */
export function evaluateExitDecision(params: EvaluateExitDecisionParams): ExitDecision {
  const {
    position,
    currentPrice,
    priceTimestamp,
    strategyState,
    technicalScore = 50,
    settings,
    isEmergencyStopped = false,
    isManual = false,
  } = params;

  const feeRate = position.mode === 'PAPER' ? (settings.paperFeeRate ?? 0.001) : 0.001;
  const slippageBps = position.mode === 'PAPER' ? (settings.paperSlippageBps ?? 5) : 5;

  const pnl = calculatePositionNetPnL(position, currentPrice, feeRate, slippageBps);
  const breakEvenPrice = calculateBreakEvenExitPrice(position, feeRate, slippageBps);
  const tpPercent = settings.takeProfitPercent ?? 2.0;
  const slPercent = settings.stopLossPercent ?? 3.0;
  const minTechProfitPercent = settings.minProfitForTechnicalExitPercent ?? 0.20;
  const maxPriceAgeMs = settings.maxExitPriceAgeMs ?? 5000;

  const takeProfitPrice = calculateTargetExitPrice(position, tpPercent, feeRate, slippageBps);
  const stopLossPrice = calculateTargetExitPrice(position, -slPercent, feeRate, slippageBps);

  // Stale price protection check
  if (priceTimestamp && Date.now() - priceTimestamp > maxPriceAgeMs && !isManual) {
    return {
      shouldSell: false,
      reason: 'HOLD',
      netPnL: pnl.netPnL,
      netPnLPercent: pnl.netPnLPercent,
      currentPrice,
      breakEvenPrice,
      takeProfitPrice,
      stopLossPrice,
      grossPnL: pnl.grossPnL,
      estimatedExitPrice: pnl.estimatedExitPrice,
      estimatedExitValue: pnl.estimatedExitValue,
      entryFees: pnl.entryFees,
      estimatedExitFees: pnl.estimatedExitFees,
      logMessage: `EXIT CHECK ${position.symbol} STALE PRICE (${Date.now() - priceTimestamp}ms > ${maxPriceAgeMs}ms) -> HOLD`,
    };
  }

  // 1. Manual User Exit (always allowed)
  if (isManual) {
    return {
      shouldSell: true,
      reason: 'MANUAL',
      netPnL: pnl.netPnL,
      netPnLPercent: pnl.netPnLPercent,
      currentPrice,
      breakEvenPrice,
      takeProfitPrice,
      stopLossPrice,
      grossPnL: pnl.grossPnL,
      estimatedExitPrice: pnl.estimatedExitPrice,
      estimatedExitValue: pnl.estimatedExitValue,
      entryFees: pnl.entryFees,
      estimatedExitFees: pnl.estimatedExitFees,
      logMessage: `MANUAL SELL ${position.symbol} @ ${currentPrice} | Net PnL: ${pnl.netPnLPercent}%`,
    };
  }

  // 2. Emergency Stop (preserves positions, halts automated trading)
  if (isEmergencyStopped) {
    return {
      shouldSell: false,
      reason: 'EMERGENCY',
      netPnL: pnl.netPnL,
      netPnLPercent: pnl.netPnLPercent,
      currentPrice,
      breakEvenPrice,
      takeProfitPrice,
      stopLossPrice,
      grossPnL: pnl.grossPnL,
      estimatedExitPrice: pnl.estimatedExitPrice,
      estimatedExitValue: pnl.estimatedExitValue,
      entryFees: pnl.entryFees,
      estimatedExitFees: pnl.estimatedExitFees,
      logMessage: `EMERGENCY STOP ACTIVE -> HOLD ${position.symbol}`,
    };
  }

  // 3. Stop Loss: Net PnL <= -stopLossPercent (sole automated reason for accepting a loss)
  if (pnl.netPnLPercent <= -slPercent) {
    return {
      shouldSell: true,
      reason: 'STOP_LOSS',
      netPnL: pnl.netPnL,
      netPnLPercent: pnl.netPnLPercent,
      currentPrice,
      breakEvenPrice,
      takeProfitPrice,
      stopLossPrice,
      grossPnL: pnl.grossPnL,
      estimatedExitPrice: pnl.estimatedExitPrice,
      estimatedExitValue: pnl.estimatedExitValue,
      entryFees: pnl.entryFees,
      estimatedExitFees: pnl.estimatedExitFees,
      logMessage: `EXIT CHECK ${position.symbol}\nPrice: ${currentPrice}\nEntry: ${position.entryPrice}\nNet PnL: ${pnl.netPnLPercent}%\nDecision: SELL\nReason: STOP_LOSS`,
    };
  }

  // 4. Take Profit: Net PnL >= takeProfitPercent
  if (pnl.netPnLPercent >= tpPercent) {
    return {
      shouldSell: true,
      reason: 'TAKE_PROFIT',
      netPnL: pnl.netPnL,
      netPnLPercent: pnl.netPnLPercent,
      currentPrice,
      breakEvenPrice,
      takeProfitPrice,
      stopLossPrice,
      grossPnL: pnl.grossPnL,
      estimatedExitPrice: pnl.estimatedExitPrice,
      estimatedExitValue: pnl.estimatedExitValue,
      entryFees: pnl.entryFees,
      estimatedExitFees: pnl.estimatedExitFees,
      logMessage: `EXIT CHECK ${position.symbol}\nPrice: ${currentPrice}\nEntry: ${position.entryPrice}\nNet PnL: ${pnl.netPnLPercent}%\nDecision: SELL\nReason: TAKE_PROFIT`,
    };
  }

  // 5. Technical Weakening / Exit: Profitability Gate
  if (strategyState === 'WEAKENING' || strategyState === 'EXIT') {
    if (pnl.netPnLPercent >= minTechProfitPercent) {
      return {
        shouldSell: true,
        reason: 'TECHNICAL_PROFIT_EXIT',
        netPnL: pnl.netPnL,
        netPnLPercent: pnl.netPnLPercent,
        currentPrice,
        breakEvenPrice,
        takeProfitPrice,
        stopLossPrice,
        grossPnL: pnl.grossPnL,
        estimatedExitPrice: pnl.estimatedExitPrice,
        estimatedExitValue: pnl.estimatedExitValue,
        entryFees: pnl.entryFees,
        estimatedExitFees: pnl.estimatedExitFees,
        logMessage: `EXIT CHECK ${position.symbol}\nPrice: ${currentPrice}\nEntry: ${position.entryPrice}\nNet PnL: ${pnl.netPnLPercent}%\nState: ${strategyState}\nDecision: SELL\nReason: TECHNICAL_PROFIT_EXIT`,
      };
    } else {
      // Technical weakening with loss or profit below buffer -> STRICTLY HOLD
      return {
        shouldSell: false,
        reason: 'HOLD_PROFIT_PROTECTION',
        netPnL: pnl.netPnL,
        netPnLPercent: pnl.netPnLPercent,
        currentPrice,
        breakEvenPrice,
        takeProfitPrice,
        stopLossPrice,
        grossPnL: pnl.grossPnL,
        estimatedExitPrice: pnl.estimatedExitPrice,
        estimatedExitValue: pnl.estimatedExitValue,
        entryFees: pnl.entryFees,
        estimatedExitFees: pnl.estimatedExitFees,
        logMessage: `EXIT CHECK ${position.symbol}\nPrice: ${currentPrice}\nEntry: ${position.entryPrice}\nNet PnL: ${pnl.netPnLPercent}%\nState: ${strategyState}\nTP: +${tpPercent.toFixed(2)}%\nSL: -${slPercent.toFixed(2)}%\nTechnical Exit Min: +${minTechProfitPercent.toFixed(2)}%\nDecision: HOLD\nReason: TECHNICAL_WEAKENING_WITH_LOSS`,
      };
    }
  }

  // 6. Default: Hold
  return {
    shouldSell: false,
    reason: 'HOLD',
    netPnL: pnl.netPnL,
    netPnLPercent: pnl.netPnLPercent,
    currentPrice,
    breakEvenPrice,
    takeProfitPrice,
    stopLossPrice,
    grossPnL: pnl.grossPnL,
    estimatedExitPrice: pnl.estimatedExitPrice,
    estimatedExitValue: pnl.estimatedExitValue,
    entryFees: pnl.entryFees,
    estimatedExitFees: pnl.estimatedExitFees,
    logMessage: `EXIT CHECK ${position.symbol}\nPrice: ${currentPrice}\nEntry: ${position.entryPrice}\nNet PnL: ${pnl.netPnLPercent}%\nState: ${strategyState}\nDecision: HOLD\nReason: HOLD`,
  };
}
