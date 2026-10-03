import {
  TradingMode,
  OrderRequest,
  SafetyCheckResult,
  TradingSettings,
  WalletBalance,
  Position,
  SymbolFilterRules,
} from '../types/index.ts';
import { Storage } from './storage.ts';
import { BinanceTimeService } from './binance-time.ts';
import { floorToStep, meetsMinNotional } from './decimal-utils.ts';
import { Logger } from './logger.ts';
import { AuditLogger } from './audit-logger.ts';

export class SafetyGate {
  /**
   * Central Authoritative Validation for ALL BUY orders (Automatic, Manual, Retry).
   */
  public static validateBuy(
    request: OrderRequest,
    mode: TradingMode,
    settings: TradingSettings,
    wallet: WalletBalance,
    openPositions: Position[],
    symbolFilter: SymbolFilterRules,
    currentPrice: number,
    isEmergencyStopped: boolean,
    idempotencyKey?: string
  ): SafetyCheckResult {
    // 1. Emergency Stop Check - Strictly blocks all BUY entries
    if (isEmergencyStopped || Storage.isEmergencyStopActive()) {
      AuditLogger.log({
        eventType: 'BUY_REJECTED',
        mode,
        symbol: request.symbol,
        side: 'BUY',
        reason: 'Emergency stop is active. Automated buying is locked.',
      });
      return {
        allowed: false,
        code: 'EMERGENCY_STOP_ACTIVE',
        reason: 'Emergency stop is active. All automated buying is blocked.',
      };
    }

    // 2. Auto Trading Check
    if (!settings.autoTrading) {
      return {
        allowed: false,
        code: 'AUTO_TRADING_DISABLED',
        reason: 'Auto trading is disabled in system settings.',
      };
    }

    // 3. Idempotency Key Validation (Prevent Duplicate Submissions)
    if (idempotencyKey && Storage.hasIdempotencyKey(idempotencyKey)) {
      return {
        allowed: false,
        code: 'DUPLICATE_ORDER_ATTEMPT',
        reason: `Duplicate order rejected: Signal/Idempotency key (${idempotencyKey}) already executed.`,
      };
    }

    // 4. Mode Isolation & Real Credentials / Time Sync Check
    if (mode === 'REAL') {
      if (!Storage.isRealModeConfirmed()) {
        return {
          allowed: false,
          code: 'REAL_MODE_NOT_CONFIRMED',
          reason: 'REAL mode has not been explicitly confirmed via server-side disclaimer verification.',
        };
      }

      const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
      if (!realAcc || !realAcc.hasApiKeys) {
        return {
          allowed: false,
          code: 'REAL_CREDENTIALS_MISSING',
          reason: 'Binance API credentials are not configured for REAL mode.',
        };
      }
      if (!realAcc.autoTrading) {
        return {
          allowed: false,
          code: 'REAL_AUTO_TRADING_OFF',
          reason: 'Auto trading is not enabled on the REAL Binance account.',
        };
      }

      // Time Sync check
      const timeService = BinanceTimeService.getInstance();
      if (!timeService.isSafeDrift()) {
        return {
          allowed: false,
          code: 'CLOCK_DRIFT_UNSAFE',
          reason: `Binance clock drift is unsafe or stale (${timeService.getOffset()}ms offset). Synchronization required before live trading.`,
        };
      }
    }

    // 5. Wallet Reconciliation Status Check
    if (wallet.reconciliationStatus === 'MISMATCH' || wallet.reconciliationStatus === 'ERROR') {
      return {
        allowed: false,
        code: 'WALLET_RECONCILIATION_ERROR',
        reason: `Wallet reconciliation status is ${wallet.reconciliationStatus}: ${wallet.reconciliationError || 'Unresolved ledger mismatch'}. Trading paused.`,
      };
    }

    // 6. Fixed Trade Amount Invariant Validation
    const fixedAmount = settings.fixedTradeAmount;
    if (!fixedAmount || isNaN(fixedAmount) || !isFinite(fixedAmount) || fixedAmount <= 0) {
      return {
        allowed: false,
        code: 'INVALID_FIXED_AMOUNT',
        reason: `Configured fixed trade amount (${fixedAmount}) is invalid. Enter a positive USDT amount.`,
      };
    }

    if (fixedAmount > settings.maxTradeAmount) {
      return {
        allowed: false,
        code: 'EXCEEDS_MAX_TRADE_AMOUNT',
        reason: `Trade amount ${fixedAmount} USDT exceeds maximum allowed ${settings.maxTradeAmount} USDT.`,
      };
    }

    if (request.quoteAmount === undefined || Math.abs(request.quoteAmount - fixedAmount) > 0.001) {
      return {
        allowed: false,
        code: 'FIXED_AMOUNT_INVARIANT_VIOLATION',
        reason: `CRITICAL: Order requestedQuoteAmount (${request.quoteAmount}) must strictly equal configuredFixedTradeAmount (${fixedAmount}). Sizing alteration rejected.`,
      };
    }

    // 7. Max Open Positions Check
    const activePositions = openPositions.filter(p => p.mode === mode && p.status === 'OPEN');
    if (activePositions.length >= settings.maxOpenPositions) {
      return {
        allowed: false,
        code: 'MAX_POSITIONS_REACHED',
        reason: `Maximum open positions limit reached (${activePositions.length}/${settings.maxOpenPositions}). Cannot open new position.`,
      };
    }

    // 8. Single Position Per Symbol Rule
    const existingPosition = activePositions.find(p => p.symbol === request.symbol);
    if (existingPosition) {
      return {
        allowed: false,
        code: 'POSITION_ALREADY_EXISTS',
        reason: `An active position for ${request.symbol} already exists (ID: ${existingPosition.id}). Only one active position per symbol allowed.`,
      };
    }

    // 9. Symbol Cooldown Check
    const cooldown = Storage.isSymbolInCooldown(request.symbol, mode);
    if (cooldown.inCooldown) {
      return {
        allowed: false,
        code: 'SYMBOL_IN_COOLDOWN',
        reason: `Symbol ${request.symbol} is in re-entry cooldown for another ${cooldown.remainingMinutes} minute(s).`,
      };
    }

    // 10. Available Balance & Minimum Reserve Check
    const feeRate = mode === 'PAPER' ? settings.paperFeeRate : 0.001; // ~0.1% spot fee
    const estimatedFee = fixedAmount * feeRate;
    const requiredTotal = fixedAmount + estimatedFee;
    const requiredWithReserve = requiredTotal + settings.minimumUsdtReserve;

    if (wallet.usdtAvailable < requiredTotal) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_AVAILABLE_USDT',
        reason: `BUY BLOCKED. Required: ${requiredTotal.toFixed(2)} USDT (Trade: ${fixedAmount} + Fee: ${estimatedFee.toFixed(2)}), Available: ${wallet.usdtAvailable.toFixed(2)} USDT. Insufficient available USDT.`,
      };
    }

    if (wallet.usdtAvailable < requiredWithReserve) {
      return {
        allowed: false,
        code: 'MINIMUM_RESERVE_VIOLATION',
        reason: `BUY BLOCKED. Available balance (${wallet.usdtAvailable.toFixed(2)} USDT) would fall below minimum USDT reserve (${settings.minimumUsdtReserve} USDT) after trade of ${fixedAmount} USDT.`,
      };
    }

    // 11. Exchange Filters & Min Notional Validation
    if (fixedAmount < symbolFilter.minNotional) {
      return {
        allowed: false,
        code: 'MIN_NOTIONAL_NOT_MET',
        reason: `BUY BLOCKED. Trade amount: ${fixedAmount} USDT. Minimum notional required for ${request.symbol}: ${symbolFilter.minNotional} USDT. Increase fixed trade amount.`,
      };
    }

    if (currentPrice > 0) {
      const estimatedQty = fixedAmount / currentPrice;
      const roundedQty = floorToStep(estimatedQty, symbolFilter.stepSize);
      if (roundedQty < symbolFilter.minQty) {
        return {
          allowed: false,
          code: 'MIN_QUANTITY_NOT_MET',
          reason: `BUY BLOCKED. Estimated quantity ${roundedQty} is below minimum exchange quantity ${symbolFilter.minQty}.`,
        };
      }
    }

    AuditLogger.log({
      eventType: 'BUY_AUTHORIZED',
      mode,
      symbol: request.symbol,
      side: 'BUY',
      quantity: currentPrice > 0 ? floorToStep(fixedAmount / currentPrice, symbolFilter.stepSize) : undefined,
      price: currentPrice,
      reason: request.reason,
    });

    return { allowed: true, code: 'PASSED' };
  }

  /**
   * Central Authoritative Validation for ALL SELL orders (Automatic, Take Profit, Stop Loss, Manual Sell).
   */
  public static validateSell(
    request: OrderRequest,
    position: Position,
    mode: TradingMode,
    isEmergencyStopped: boolean,
    symbolFilter?: SymbolFilterRules,
    currentPrice?: number
  ): SafetyCheckResult {
    // 1. Mode isolation
    if (position.mode !== mode) {
      AuditLogger.log({
        eventType: 'SELL_REJECTED',
        mode,
        symbol: position.symbol,
        side: 'SELL',
        reason: `Mode mismatch: position mode ${position.mode} != execution mode ${mode}.`,
      });
      return {
        allowed: false,
        code: 'MODE_MISMATCH',
        reason: `Cannot execute ${mode} SELL on a ${position.mode} position.`,
      };
    }

    // 2. Position Status Validation
    if (position.status !== 'OPEN') {
      return {
        allowed: false,
        code: 'POSITION_NOT_OPEN',
        reason: `Position ${position.id} is already ${position.status}.`,
      };
    }

    // 3. Symbol Matching Validation
    if (request.symbol !== position.symbol) {
      return {
        allowed: false,
        code: 'SYMBOL_MISMATCH',
        reason: `Request symbol ${request.symbol} does not match position symbol ${position.symbol}.`,
      };
    }

    // 4. Quantity Validation
    if (!request.quantity || isNaN(request.quantity) || request.quantity <= 0) {
      return {
        allowed: false,
        code: 'INVALID_SELL_QUANTITY',
        reason: 'SELL quantity must be a strictly positive number.',
      };
    }

    // Ensure quantity does not exceed position remaining quantity
    if (request.quantity > position.remainingQuantity * 1.00001) {
      return {
        allowed: false,
        code: 'EXCEEDS_POSITION_QUANTITY',
        reason: `Requested SELL quantity (${request.quantity}) exceeds position remaining quantity (${position.remainingQuantity}).`,
      };
    }

    // 5. Exchange Filter Step Size / Min Qty Validation (if filter provided)
    if (symbolFilter) {
      if (request.quantity < symbolFilter.minQty) {
        return {
          allowed: false,
          code: 'BELOW_MIN_QTY',
          reason: `SELL quantity ${request.quantity} is below exchange minimum quantity ${symbolFilter.minQty}.`,
        };
      }

      if (currentPrice && currentPrice > 0) {
        if (!meetsMinNotional(currentPrice, request.quantity, symbolFilter.minNotional)) {
          return {
            allowed: false,
            code: 'MIN_NOTIONAL_NOT_MET',
            reason: `SELL value (~${(currentPrice * request.quantity).toFixed(2)} USDT) is below minimum notional ${symbolFilter.minNotional} USDT.`,
          };
        }
      }
    }

    AuditLogger.log({
      eventType: 'SELL_AUTHORIZED',
      mode,
      symbol: position.symbol,
      side: 'SELL',
      quantity: request.quantity,
      price: currentPrice || position.currentPrice,
      reason: request.reason,
    });

    return { allowed: true, code: 'PASSED' };
  }
}
