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
import { Logger } from './logger.ts';

export class SafetyGate {
  public static validateBuy(
    request: OrderRequest,
    mode: TradingMode,
    settings: TradingSettings,
    wallet: WalletBalance,
    openPositions: Position[],
    symbolFilter: SymbolFilterRules,
    currentPrice: number,
    isEmergencyStopped: boolean
  ): SafetyCheckResult {
    // 0. Authoritative Database Readiness Check
    if (!Storage.isReady()) {
      return {
        allowed: false,
        code: 'DATABASE_UNAVAILABLE',
        reason: 'Authoritative PostgreSQL database is currently disconnected. Automated BUY orders are blocked until database connection and rehydration are restored.',
      };
    }

    // 1. Emergency Stop Check
    if (isEmergencyStopped) {
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

    // 3. Mode Isolation & Credentials Check
    if (mode === 'REAL') {
      if (process.env.LIVE_TRADING_ENABLED !== 'true') {
        return {
          allowed: false,
          code: 'LIVE_TRADING_DISABLED_BY_CONFIG',
          reason: 'Real live Binance trading is disabled by server configuration (LIVE_TRADING_ENABLED is not set to true).',
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
      if (!BinanceTimeService.getInstance().isSafeDrift()) {
        return {
          allowed: false,
          code: 'CLOCK_DRIFT_UNSAFE',
          reason: `Binance clock drift is unsafe (${BinanceTimeService.getInstance().getOffset()}ms). Re-synchronization required.`,
        };
      }
    }

    // 4. Wallet Reconciliation Status Check
    if (wallet.reconciliationStatus === 'MISMATCH' || wallet.reconciliationStatus === 'ERROR') {
      return {
        allowed: false,
        code: 'WALLET_RECONCILIATION_ERROR',
        reason: `Wallet reconciliation status is ${wallet.reconciliationStatus}: ${wallet.reconciliationError || 'Unresolved ledger mismatch'}. Trading paused.`,
      };
    }

    // 5. Fixed Trade Amount Invariant Validation
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

    // 6. Max Open Positions Check
    const activePositions = openPositions.filter(p => p.mode === mode && p.status === 'OPEN');
    if (activePositions.length >= settings.maxOpenPositions) {
      return {
        allowed: false,
        code: 'MAX_POSITIONS_REACHED',
        reason: `Maximum open positions limit reached (${activePositions.length}/${settings.maxOpenPositions}). Cannot open new position.`,
      };
    }

    // 7. Single Position Per Symbol Rule
    const existingPosition = activePositions.find(p => p.symbol === request.symbol);
    if (existingPosition) {
      return {
        allowed: false,
        code: 'POSITION_ALREADY_EXISTS',
        reason: `An active position for ${request.symbol} already exists (ID: ${existingPosition.id}). Only one active position per symbol allowed.`,
      };
    }

    // 8. Symbol Cooldown Check
    const cooldown = Storage.isSymbolInCooldown(request.symbol, mode);
    if (cooldown.inCooldown) {
      return {
        allowed: false,
        code: 'SYMBOL_IN_COOLDOWN',
        reason: `Symbol ${request.symbol} is in re-entry cooldown for another ${cooldown.remainingMinutes} minute(s).`,
      };
    }

    // 9. Available Balance & Reserve Check
    const feeRate = mode === 'PAPER' ? settings.paperFeeRate : 0.001; // ~0.1% spot fee
    const estimatedFee = fixedAmount * feeRate;
    const requiredTotal = fixedAmount + estimatedFee;
    const requiredWithReserve = requiredTotal + settings.minimumUsdtReserve;

    if (wallet.usdtAvailable < requiredTotal) {
      return {
        allowed: false,
        code: 'INSUFFICIENT_AVAILABLE_USDT',
        reason: `BUY BLOCKED. Required: ${requiredTotal.toFixed(2)} USDT (Trade: ${fixedAmount} + Fee: ${estimatedFee.toFixed(2)}), Available: ${wallet.usdtAvailable.toFixed(2)} USDT. Reason: Insufficient available USDT.`,
      };
    }

    if (wallet.usdtAvailable < requiredWithReserve) {
      return {
        allowed: false,
        code: 'MINIMUM_RESERVE_VIOLATION',
        reason: `BUY BLOCKED. Available balance (${wallet.usdtAvailable.toFixed(2)} USDT) would fall below minimum USDT reserve (${settings.minimumUsdtReserve} USDT) after trade of ${fixedAmount} USDT.`,
      };
    }

    // 10. Exchange Filters & Min Notional Validation
    if (fixedAmount < symbolFilter.minNotional) {
      return {
        allowed: false,
        code: 'MIN_NOTIONAL_NOT_MET',
        reason: `BUY BLOCKED. Trade amount: ${fixedAmount} USDT. Minimum notional required for ${request.symbol}: ${symbolFilter.minNotional} USDT. Increase the fixed trade amount.`,
      };
    }

    // Quantity estimate and stepSize check
    if (currentPrice > 0) {
      const estimatedQty = fixedAmount / currentPrice;
      if (estimatedQty < symbolFilter.minQty) {
        return {
          allowed: false,
          code: 'MIN_QUANTITY_NOT_MET',
          reason: `BUY BLOCKED. Estimated quantity ${estimatedQty.toFixed(6)} is below minimum exchange quantity ${symbolFilter.minQty}.`,
        };
      }
    }

    return { allowed: true, code: 'PASSED' };
  }

  public static validateSell(
    request: OrderRequest,
    position: Position,
    mode: TradingMode,
    isEmergencyStopped: boolean
  ): SafetyCheckResult {
    // Mode isolation
    if (position.mode !== mode) {
      return {
        allowed: false,
        code: 'MODE_MISMATCH',
        reason: `Cannot execute ${mode} SELL on a ${position.mode} position.`,
      };
    }

    if (position.status !== 'OPEN') {
      return {
        allowed: false,
        code: 'POSITION_NOT_OPEN',
        reason: `Position ${position.id} is already ${position.status}.`,
      };
    }

    if (!request.quantity || request.quantity <= 0) {
      return {
        allowed: false,
        code: 'INVALID_SELL_QUANTITY',
        reason: 'SELL quantity must be a positive number.',
      };
    }

    if (request.quantity > position.remainingQuantity * 1.0001) {
      return {
        allowed: false,
        code: 'EXCEEDS_POSITION_QUANTITY',
        reason: `Requested SELL quantity (${request.quantity}) exceeds position remaining quantity (${position.remainingQuantity}).`,
      };
    }

    return { allowed: true, code: 'PASSED' };
  }
}
