import {
  TradingMode,
  OrderRequest,
  ExecutionResult,
  OrderStatus,
  Position,
  Order,
  Trade,
  WalletBalance,
  ReconciliationResult,
  SymbolAuditRecord,
} from '../types/index.ts';
import { Storage } from './storage.ts';
import { BinanceRequestManager } from './binance-client.ts';
import { BinanceSymbolValidator } from './symbol-validator.ts';
import { Logger } from './logger.ts';
import {
  calculatePositionNetPnL,
  calculateBreakEvenExitPrice,
  calculateTargetExitPrice,
} from './exit-decision-engine.ts';

export interface TradingExecutor {
  getMode(): TradingMode;
  getBalance(): Promise<WalletBalance>;
  buy(request: OrderRequest): Promise<ExecutionResult>;
  sell(request: OrderRequest, positionId?: string): Promise<ExecutionResult>;
  getOpenPositions(): Promise<Position[]>;
  getOrderStatus(orderId: string): Promise<OrderStatus>;
  reconcile(): Promise<ReconciliationResult>;
}

// --------------------------------------------------------------------------
// Paper Trading Executor
// --------------------------------------------------------------------------
export class PaperTradingExecutor implements TradingExecutor {
  private binance = BinanceRequestManager.getInstance();

  public getMode(): TradingMode {
    return 'PAPER';
  }

  public async getBalance(): Promise<WalletBalance> {
    const wallet = Storage.getWallet('PAPER');
    const positions = Storage.getPositions('PAPER', 'OPEN');
    const settings = Storage.getSettings();
    const feeRate = settings.paperFeeRate ?? 0.001;
    const slippageBps = settings.paperSlippageBps ?? 5;
    const tpPercent = settings.takeProfitPercent ?? 2.0;
    const slPercent = settings.stopLossPercent ?? 3.0;

    // Update unrealized PnL & asset value with latest prices
    let totalAssetValue = 0;
    let totalUnrealized = 0;

    for (const pos of positions) {
      try {
        const livePrice = await this.binance.getLatestPrice(pos.symbol);
        pos.currentPrice = livePrice;
        pos.grossPnL = Number(((livePrice - pos.entryPrice) * pos.remainingQuantity).toFixed(4));
        pos.unrealizedPnL = pos.grossPnL;
        pos.unrealizedPnLPercent = Number((((livePrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));
        
        // Enrich with authoritative net PnL and exit targets
        const pnlResult = calculatePositionNetPnL(pos, livePrice, feeRate, slippageBps);
        pos.estimatedNetPnL = pnlResult.netPnL;
        pos.estimatedNetPnLPercent = pnlResult.netPnLPercent;
        pos.breakEvenPrice = calculateBreakEvenExitPrice(pos, feeRate, slippageBps);
        pos.takeProfitPrice = calculateTargetExitPrice(pos, tpPercent, feeRate, slippageBps);
        pos.stopLossPrice = calculateTargetExitPrice(pos, -slPercent, feeRate, slippageBps);
        pos.exitStatus = pos.estimatedNetPnLPercent >= tpPercent ? 'WAITING_TP' : pos.estimatedNetPnLPercent <= -slPercent ? 'WAITING_SL' : 'HOLD';

        Storage.savePosition(pos);

        totalAssetValue += livePrice * pos.remainingQuantity;
        totalUnrealized += pos.unrealizedPnL;
      } catch {
        totalAssetValue += pos.currentPrice * pos.remainingQuantity;
        totalUnrealized += pos.unrealizedPnL;
      }
    }

    wallet.accountAssetValue = Number(totalAssetValue.toFixed(2));
    wallet.totalEquity = Number((wallet.usdtAvailable + wallet.usdtLocked + totalAssetValue).toFixed(2));
    wallet.unrealizedPnL = Number(totalUnrealized.toFixed(2));

    Storage.updateWallet('PAPER', wallet);
    return wallet;
  }

  public async buy(request: OrderRequest): Promise<ExecutionResult> {
    const settings = Storage.getSettings();
    const fixedAmount = settings.fixedTradeAmount;

    // Hard Invariant Check
    if (!request.quoteAmount || Math.abs(request.quoteAmount - fixedAmount) > 0.001) {
      throw new Error(`Paper BUY invariant error: requested quote amount (${request.quoteAmount}) must equal fixed trade amount (${fixedAmount})`);
    }

    // 1. Authoritative Binance Spot validation. Paper mode must mirror the
    //    real Binance tradable universe; it must never invent unsupported pairs.
    const validation = await BinanceSymbolValidator.getInstance().validateExactSpotUsdtSymbol(request.symbol);
    if (!validation.tradable) {
      throw new Error(`Paper BUY blocked: ${request.symbol} is not an exact current Binance Spot USDT symbol (${validation.reason}).`);
    }

    // 2. Get real-time Binance market price
    const livePrice = await this.binance.getLatestPrice(request.symbol);
    if (!livePrice || livePrice <= 0) {
      throw new Error(`Real market price unavailable for ${request.symbol}. Paper BUY aborted.`);
    }

    // 2. Apply simulated slippage (5 bps = 0.05%)
    const slippageMultiplier = 1 + (settings.paperSlippageBps || 5) / 10000;
    const executionPrice = Number((livePrice * slippageMultiplier).toFixed(6));

    // 3. Calculate simulated fee and token quantity
    const feeRate = settings.paperFeeRate || 0.001; // 0.1%
    const fee = Number((fixedAmount * feeRate).toFixed(4));
    const executedQty = Number((fixedAmount / executionPrice).toFixed(6));

    // 4. Create Order record
    const orderId = `paper-order-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const order: Order = {
      id: orderId,
      clientOrderId: request.clientOrderId,
      accountId: 'paper-default',
      mode: 'PAPER',
      symbol: request.symbol,
      side: 'BUY',
      status: 'FILLED',
      requestedQuoteAmount: fixedAmount,
      executedQuantity: executedQty,
      executedQuoteAmount: fixedAmount,
      executionPrice: executionPrice,
      fee: fee,
      feeAsset: 'USDT',
      reason: request.reason,
      strategyState: request.strategyState,
      technicalScore: request.technicalScore,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fills: [
        {
          price: executionPrice,
          qty: executedQty,
          commission: fee,
          commissionAsset: 'USDT',
          tradeId: Math.floor(Math.random() * 1000000),
        },
      ],
    };
    Storage.saveOrder(order);

    // 5. Create Position record
    const positionId = `paper-pos-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const position: Position = {
      id: positionId,
      accountId: 'paper-default',
      mode: 'PAPER',
      symbol: request.symbol,
      quantity: executedQty,
      remainingQuantity: executedQty,
      entryPrice: executionPrice,
      entryQuoteAmount: fixedAmount, // Invariant: exactly fixed amount
      entryFees: fee,
      entryScore: request.technicalScore,
      entryState: request.strategyState,
      entryReason: request.reason,
      currentPrice: executionPrice,
      currentScore: request.technicalScore,
      currentState: request.strategyState,
      unrealizedPnL: 0,
      unrealizedPnLPercent: 0,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'OPEN',
      entryOrderId: order.id,
    };
    Storage.savePosition(position);

    // 6. Update Paper Wallet
    const wallet = Storage.getWallet('PAPER');
    wallet.usdtAvailable = Number((wallet.usdtAvailable - fixedAmount - fee).toFixed(4));
    wallet.usdtTotal = Number((wallet.usdtAvailable + wallet.usdtLocked).toFixed(4));
    wallet.totalFeesPaid = Number((wallet.totalFeesPaid + fee).toFixed(4));

    // Update asset holding
    const baseAsset = request.symbol.replace('USDT', '');
    const assetIdx = wallet.assets.findIndex(a => a.asset === baseAsset);
    if (assetIdx >= 0) {
      wallet.assets[assetIdx].free += executedQty;
      wallet.assets[assetIdx].total += executedQty;
      wallet.assets[assetIdx].valueUsdt += fixedAmount;
    } else {
      wallet.assets.push({
        asset: baseAsset,
        symbol: request.symbol,
        free: executedQty,
        locked: 0,
        total: executedQty,
        price: executionPrice,
        valueUsdt: fixedAmount,
        isExternal: false,
      });
    }

    Storage.updateWallet('PAPER', wallet);

    Logger.info(
      'PAPER',
      'ORDER',
      `Paper BUY filled: ${request.symbol} | Amount: ${fixedAmount} USDT | Qty: ${executedQty} @ ${executionPrice} | Fee: ${fee} USDT`,
      {
        symbol: request.symbol,
        orderId: order.id,
        strategyState: request.strategyState,
        technicalScore: request.technicalScore,
      }
    );

    return {
      success: true,
      order,
      position,
    };
  }

  public async sell(request: OrderRequest, positionId?: string): Promise<ExecutionResult> {
    const position = positionId
      ? Storage.getPositionById(positionId)
      : Storage.getOpenPositionForSymbol(request.symbol, 'PAPER');

    if (!position || position.status !== 'OPEN') {
      throw new Error(`No open paper position found for ${request.symbol} (status: ${position?.status})`);
    }

    // Atomically transition OPEN -> CLOSING
    position.status = 'CLOSING';
    Storage.savePosition(position);

    try {
      const sellQty = request.quantity || position.remainingQuantity;

      // 1. Validate against the current Binance Spot universe.
      const validation = await BinanceSymbolValidator.getInstance().validateExactSpotUsdtSymbol(request.symbol);
      if (!validation.tradable) {
        throw new Error(`Paper SELL blocked: ${request.symbol} is not an exact current Binance Spot USDT symbol (${validation.reason}).`);
      }

      // 2. Get real-time Binance market price
      const livePrice = await this.binance.getLatestPrice(request.symbol);
      if (!livePrice || livePrice <= 0) {
        throw new Error(`Real market price unavailable for ${request.symbol}. Paper SELL aborted.`);
      }

      // 2. Apply simulated slippage on sell (slippage reduces realized price)
      const settings = Storage.getSettings();
      const slippageMultiplier = 1 - (settings.paperSlippageBps || 5) / 10000;
      const executionPrice = Number((livePrice * slippageMultiplier).toFixed(6));

      // 3. Execution value and fees
      const grossExitQuoteAmount = Number((sellQty * executionPrice).toFixed(4));
      const feeRate = settings.paperFeeRate || 0.001;
      const exitFee = Number((grossExitQuoteAmount * feeRate).toFixed(4));

      // 4. Create Order record
      const orderId = `paper-order-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const order: Order = {
        id: orderId,
        clientOrderId: request.clientOrderId,
        accountId: 'paper-default',
        mode: 'PAPER',
        symbol: request.symbol,
        side: 'SELL',
        status: 'FILLED',
        requestedQuantity: sellQty,
        executedQuantity: sellQty,
        executedQuoteAmount: grossExitQuoteAmount,
        executionPrice: executionPrice,
        fee: exitFee,
        feeAsset: 'USDT',
        reason: request.reason,
        strategyState: request.strategyState,
        technicalScore: request.technicalScore,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fills: [
          {
            price: executionPrice,
            qty: sellQty,
            commission: exitFee,
            commissionAsset: 'USDT',
            tradeId: Math.floor(Math.random() * 1000000),
          },
        ],
      };
      Storage.saveOrder(order);

      // 5. Calculate Net PnL & create Trade record
      const costBasisRatio = sellQty / position.quantity;
      const entryCostAllocated = position.entryQuoteAmount * costBasisRatio;
      const entryFeesAllocated = position.entryFees * costBasisRatio;
      const grossPnL = Number((grossExitQuoteAmount - entryCostAllocated).toFixed(4));
      const totalFees = Number((entryFeesAllocated + exitFee).toFixed(4));
      const netPnL = Number((grossPnL - totalFees).toFixed(4));
      const netPnLPercent = entryCostAllocated > 0
        ? Number(((netPnL / entryCostAllocated) * 100).toFixed(2))
        : 0;

      const trade: Trade = {
        id: `paper-trade-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        accountId: 'paper-default',
        mode: 'PAPER',
        symbol: request.symbol,
        entryOrderId: position.entryOrderId,
        exitOrderId: order.id,
        entryPrice: position.entryPrice,
        exitPrice: executionPrice,
        quantity: sellQty,
        entryQuoteAmount: Number(entryCostAllocated.toFixed(2)),
        exitQuoteAmount: Number(grossExitQuoteAmount.toFixed(2)),
        entryFees: Number(entryFeesAllocated.toFixed(4)),
        exitFees: exitFee,
        grossPnL: grossPnL,
        netPnL: netPnL,
        netPnLPercent: netPnLPercent,
        entryScore: position.entryScore,
        exitScore: request.technicalScore,
        entryReason: position.entryReason,
        exitReason: request.reason,
        openedAt: position.openedAt,
        closedAt: Date.now(),
        durationMs: Date.now() - position.openedAt,
      };
      Storage.saveTrade(trade);

      // 6. Update Position status (support partial fill semantics)
      position.remainingQuantity = Number((position.remainingQuantity - sellQty).toFixed(8));
      if (position.remainingQuantity <= 0.000001) {
        position.status = 'CLOSED';
        position.remainingQuantity = 0;
      } else {
        position.status = 'OPEN';
      }
      position.exitOrderId = order.id;
      position.exitReason = request.reason;
      position.updatedAt = Date.now();
      Storage.savePosition(position);

      // 7. Update Paper Wallet
      const wallet = Storage.getWallet('PAPER');
      wallet.usdtAvailable = Number((wallet.usdtAvailable + grossExitQuoteAmount - exitFee).toFixed(4));
      wallet.usdtTotal = Number((wallet.usdtAvailable + wallet.usdtLocked).toFixed(4));
      wallet.realizedPnL = Number((wallet.realizedPnL + netPnL).toFixed(4));
      wallet.totalFeesPaid = Number((wallet.totalFeesPaid + exitFee).toFixed(4));

      // Remove or reduce asset in wallet
      const baseAsset = request.symbol.replace('USDT', '');
      const assetIdx = wallet.assets.findIndex(a => a.asset === baseAsset);
      if (assetIdx >= 0) {
        wallet.assets[assetIdx].free = Math.max(0, wallet.assets[assetIdx].free - sellQty);
        wallet.assets[assetIdx].total = Math.max(0, wallet.assets[assetIdx].total - sellQty);
        wallet.assets[assetIdx].valueUsdt = Math.max(0, wallet.assets[assetIdx].valueUsdt - entryCostAllocated);
        if (wallet.assets[assetIdx].total <= 0.000001) {
          wallet.assets.splice(assetIdx, 1);
        }
      }

      Storage.updateWallet('PAPER', wallet);

      // Set cooldown
      Storage.setSymbolCooldown(request.symbol, 'PAPER', settings.symbolCooldownMinutes || 30);

      Logger.info(
        'PAPER',
        'ORDER',
        `Paper SELL filled: ${request.symbol} | Net PnL: ${netPnL >= 0 ? '+' : ''}${netPnL} USDT (${netPnLPercent}%) | Reason: ${request.reason}`,
        {
          symbol: request.symbol,
          orderId: order.id,
          strategyState: request.strategyState,
          technicalScore: request.technicalScore,
        }
      );

      return {
        success: true,
        order,
        position,
        trade,
      };
    } catch (err: any) {
      // Revert CLOSING -> OPEN on error
      position.status = 'OPEN';
      Storage.savePosition(position);
      Logger.error('PAPER', 'ORDER', `Paper SELL failed for ${request.symbol}: ${err.message}. Position status restored to OPEN.`);
      throw err;
    }
  }

  public async getOpenPositions(): Promise<Position[]> {
    return Storage.getPositions('PAPER', 'OPEN');
  }

  public async getOrderStatus(orderId: string): Promise<OrderStatus> {
    const order = Storage.getOrderById(orderId);
    return order ? order.status : 'UNKNOWN';
  }

  public async reconcile(): Promise<ReconciliationResult> {
    const wallet = Storage.getWallet('PAPER');
    const positions = Storage.getPositions('PAPER', 'OPEN');
    const trades = Storage.getTrades('PAPER');

    const totalRealizedFromTrades = trades.reduce((sum, t) => sum + t.netPnL, 0);
    const discrepancies: string[] = [];

    if (Math.abs(wallet.realizedPnL - totalRealizedFromTrades) > 0.05) {
      discrepancies.push(`Realized PnL mismatch: wallet says ${wallet.realizedPnL}, trades sum is ${totalRealizedFromTrades.toFixed(2)}`);
      wallet.realizedPnL = Number(totalRealizedFromTrades.toFixed(4));
    }

    // Invariant check: Equity = Available + Locked + Asset value
    const calculatedAssetValue = positions.reduce((sum, p) => sum + p.currentPrice * p.remainingQuantity, 0);
    wallet.accountAssetValue = Number(calculatedAssetValue.toFixed(2));
    wallet.totalEquity = Number((wallet.usdtAvailable + wallet.usdtLocked + calculatedAssetValue).toFixed(2));
    wallet.reconciliationStatus = discrepancies.length > 0 ? 'MISMATCH' : 'OK';
    wallet.lastReconciledAt = Date.now();

    Storage.updateWallet('PAPER', wallet);

    return {
      status: discrepancies.length > 0 ? 'MISMATCH' : 'OK',
      mode: 'PAPER',
      discrepancies,
      correctedCount: discrepancies.length,
      timestamp: Date.now(),
    };
  }
}

// --------------------------------------------------------------------------
// Real Binance Trading Executor
// --------------------------------------------------------------------------
export class RealBinanceTradingExecutor implements TradingExecutor {
  private binance = BinanceRequestManager.getInstance();

  public getMode(): TradingMode {
    return 'REAL';
  }

  private getCredentials(): { apiKey: string; apiSecret: string } {
    const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
    if (!realAcc) throw new Error('Real account not found');
    const creds = Storage.getDecryptedCredentials(realAcc.id);
    if (!creds) throw new Error('No Binance API credentials configured');
    return creds;
  }

  public async getBalance(): Promise<WalletBalance> {
    const { apiKey, apiSecret } = this.getCredentials();
    const accountInfo = await this.binance.getAccount(apiKey, apiSecret);

    let usdtFree = 0;
    let usdtLocked = 0;
    const assetsList: WalletBalance['assets'] = [];
    let totalOtherAssetValueUsdt = 0;

    const realPositions = Storage.getPositions('REAL', 'OPEN');

    for (const b of accountInfo.balances) {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      const total = free + locked;

      if (b.asset === 'USDT') {
        usdtFree = free;
        usdtLocked = locked;
        continue;
      }

      if (total > 0.00001) {
        let price = 0;
        let valUsdt = 0;
        try {
          const sym = `${b.asset}USDT`;
          price = await this.binance.getLatestPrice(sym);
          valUsdt = total * price;
          totalOtherAssetValueUsdt += valUsdt;
        } catch {
          // not paired with USDT or low liquidity
        }

        // Determine if external holding or strategy-owned
        const isManagedPosition = realPositions.some(p => p.symbol === `${b.asset}USDT`);
        assetsList.push({
          asset: b.asset,
          symbol: `${b.asset}USDT`,
          free,
          locked,
          total,
          price,
          valueUsdt: Number(valUsdt.toFixed(2)),
          isExternal: !isManagedPosition,
        });
      }
    }

    const totalEquity = usdtFree + usdtLocked + totalOtherAssetValueUsdt;

    // Calculate open real positions unrealized PnL & exit metrics
    let totalUnrealized = 0;
    const settings = Storage.getSettings();
    const feeRate = 0.001; // Standard Binance spot fee estimate
    const slippageBps = 5;
    const tpPercent = settings.takeProfitPercent ?? 2.0;
    const slPercent = settings.stopLossPercent ?? 3.0;

    for (const pos of realPositions) {
      try {
        const livePrice = await this.binance.getLatestPrice(pos.symbol);
        pos.currentPrice = livePrice;
        pos.grossPnL = Number(((livePrice - pos.entryPrice) * pos.remainingQuantity).toFixed(4));
        pos.unrealizedPnL = pos.grossPnL;
        pos.unrealizedPnLPercent = Number((((livePrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));

        // Enrich with authoritative net PnL and exit targets
        const pnlResult = calculatePositionNetPnL(pos, livePrice, feeRate, slippageBps);
        pos.estimatedNetPnL = pnlResult.netPnL;
        pos.estimatedNetPnLPercent = pnlResult.netPnLPercent;
        pos.breakEvenPrice = calculateBreakEvenExitPrice(pos, feeRate, slippageBps);
        pos.takeProfitPrice = calculateTargetExitPrice(pos, tpPercent, feeRate, slippageBps);
        pos.stopLossPrice = calculateTargetExitPrice(pos, -slPercent, feeRate, slippageBps);
        pos.exitStatus = pos.estimatedNetPnLPercent >= tpPercent ? 'WAITING_TP' : pos.estimatedNetPnLPercent <= -slPercent ? 'WAITING_SL' : 'HOLD';

        Storage.savePosition(pos);
        totalUnrealized += pos.unrealizedPnL;
      } catch {
        // ignore individual price failure
      }
    }

    const trades = Storage.getTrades('REAL');
    const totalRealized = trades.reduce((sum, t) => sum + t.netPnL, 0);
    const totalFees = trades.reduce((sum, t) => sum + t.entryFees + t.exitFees, 0);

    const updatedWallet: WalletBalance = {
      mode: 'REAL',
      usdtAvailable: Number(usdtFree.toFixed(2)),
      usdtLocked: Number(usdtLocked.toFixed(2)),
      usdtTotal: Number((usdtFree + usdtLocked).toFixed(2)),
      accountAssetValue: Number(totalOtherAssetValueUsdt.toFixed(2)),
      totalEquity: Number(totalEquity.toFixed(2)),
      startingBalance: 0,
      realizedPnL: Number(totalRealized.toFixed(2)),
      unrealizedPnL: Number(totalUnrealized.toFixed(2)),
      totalFeesPaid: Number(totalFees.toFixed(2)),
      assets: assetsList,
      lastReconciledAt: Date.now(),
      reconciliationStatus: 'OK',
    };

    Storage.updateWallet('REAL', updatedWallet);
    return updatedWallet;
  }

  public async buy(request: OrderRequest): Promise<ExecutionResult> {
    if (process.env.LIVE_TRADING_ENABLED !== 'true') {
      throw new Error('Live Binance trading is disabled. Set LIVE_TRADING_ENABLED=true in server environment variables to enable real order placement.');
    }

    const { apiKey, apiSecret } = this.getCredentials();
    const settings = Storage.getSettings();
    const fixedAmount = settings.fixedTradeAmount;

    // 1. Authoritative Binance Spot Market Validation & Normalization
    const validator = BinanceSymbolValidator.getInstance();
    const valResult = await validator.validateSpotSymbol(request.symbol);

    if (!valResult.tradable || !valResult.exists) {
      const rejectionReason = valResult.reason || 'SYMBOL_NOT_TRADABLE';
      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: request.symbol,
        normalizedSymbol: valResult.normalizedSymbol || request.symbol,
        market: 'SPOT',
        side: 'BUY',
        validationResult: false,
        binanceStatus: valResult.status,
        mappingApplied: valResult.normalizedSymbol !== request.symbol,
        rejectionReason,
      });

      Logger.warn(
        'REAL',
        'ORDER',
        `LIVE_ORDER_BLOCKED symbol=${request.symbol} market=SPOT reason=${rejectionReason} binanceStatus=${valResult.status}`
      );
      throw new Error(`Live BUY blocked: Symbol ${request.symbol} is not tradable on Binance Spot (${rejectionReason})`);
    }

    // 2. Permissions and Quote Asset Checks
    if (!valResult.isSpotTradingAllowed) {
      const reason = 'SPOT_TRADING_NOT_ALLOWED';
      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: request.symbol,
        normalizedSymbol: valResult.normalizedSymbol,
        market: 'SPOT',
        side: 'BUY',
        validationResult: false,
        binanceStatus: valResult.status,
        mappingApplied: valResult.normalizedSymbol !== request.symbol,
        rejectionReason: reason,
      });
      Logger.warn('REAL', 'ORDER', `LIVE_ORDER_BLOCKED symbol=${request.symbol} market=SPOT reason=${reason}`);
      throw new Error(`Live BUY blocked: ${reason}`);
    }

    if (valResult.quoteAsset !== 'USDT') {
      const reason = 'INVALID_QUOTE_ASSET';
      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: request.symbol,
        normalizedSymbol: valResult.normalizedSymbol,
        market: 'SPOT',
        side: 'BUY',
        validationResult: false,
        binanceStatus: valResult.status,
        mappingApplied: valResult.normalizedSymbol !== request.symbol,
        rejectionReason: reason,
      });
      Logger.warn('REAL', 'ORDER', `LIVE_ORDER_BLOCKED symbol=${request.symbol} market=SPOT reason=${reason}`);
      throw new Error(`Live BUY blocked: Only USDT quote asset is supported (${valResult.quoteAsset})`);
    }

    // 3. Minimum Notional Check
    if (fixedAmount < valResult.filters.minNotional) {
      const reason = `MIN_NOTIONAL_NOT_MET (${fixedAmount} < ${valResult.filters.minNotional})`;
      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: request.symbol,
        normalizedSymbol: valResult.normalizedSymbol,
        market: 'SPOT',
        side: 'BUY',
        validationResult: false,
        binanceStatus: valResult.status,
        mappingApplied: valResult.normalizedSymbol !== request.symbol,
        rejectionReason: reason,
      });
      Logger.warn('REAL', 'ORDER', `LIVE_ORDER_BLOCKED symbol=${request.symbol} market=SPOT reason=${reason}`);
      throw new Error(`Live BUY blocked: Fixed amount ${fixedAmount} USDT is below minimum notional ${valResult.filters.minNotional} USDT`);
    }

    // 4. Hard Invariant Check on Quote Amount
    if (!request.quoteAmount || Math.abs(request.quoteAmount - fixedAmount) > 0.001) {
      throw new Error(`Real BUY invariant rejected: requested quote amount (${request.quoteAmount}) must equal fixed trade amount (${fixedAmount})`);
    }

    // 5. Live Binance Account Validation (canTrade & balance check)
    let accountInfo;
    try {
      accountInfo = await this.binance.getAccount(apiKey, apiSecret);
    } catch (accErr: any) {
      throw new Error(`Failed to fetch Binance account status: ${accErr.message}`);
    }

    if (!accountInfo.canTrade) {
      const reason = 'ACCOUNT_CANNOT_TRADE';
      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: request.symbol,
        normalizedSymbol: valResult.normalizedSymbol,
        market: 'SPOT',
        side: 'BUY',
        validationResult: false,
        binanceStatus: valResult.status,
        mappingApplied: valResult.normalizedSymbol !== request.symbol,
        rejectionReason: reason,
      });
      Logger.error('REAL', 'ORDER', `LIVE_ORDER_BLOCKED symbol=${request.symbol} market=SPOT reason=${reason}`);
      throw new Error('Live Binance BUY blocked: API account cannot trade (canTrade is false)');
    }

    const usdtBalanceObj = accountInfo.balances.find(b => b.asset === 'USDT');
    const usdtAvailable = usdtBalanceObj ? parseFloat(usdtBalanceObj.free) : 0;
    const requiredTotal = fixedAmount + (fixedAmount * 0.001);

    if (usdtAvailable < requiredTotal) {
      const reason = `INSUFFICIENT_AVAILABLE_USDT (Required: ${requiredTotal.toFixed(2)}, Available: ${usdtAvailable.toFixed(2)})`;
      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: request.symbol,
        normalizedSymbol: valResult.normalizedSymbol,
        market: 'SPOT',
        side: 'BUY',
        validationResult: false,
        binanceStatus: valResult.status,
        mappingApplied: valResult.normalizedSymbol !== request.symbol,
        rejectionReason: reason,
      });
      Logger.warn('REAL', 'ORDER', `LIVE_ORDER_BLOCKED symbol=${request.symbol} market=SPOT reason=${reason}`);
      throw new Error(`Live Binance BUY blocked: Insufficient available USDT (Required: ${requiredTotal.toFixed(2)}, Available: ${usdtAvailable.toFixed(2)})`);
    }

    const targetTradingSymbol = valResult.normalizedSymbol;
    const clientOrderId = request.clientOrderId || `AUTO-REAL-${targetTradingSymbol}-${Date.now().toString(36)}`;

    // Record submission audit
    Storage.saveSymbolAuditRecord({
      timestamp: Date.now(),
      requestedSymbol: request.symbol,
      normalizedSymbol: targetTradingSymbol,
      market: 'SPOT',
      side: 'BUY',
      validationResult: true,
      binanceStatus: valResult.status,
      mappingApplied: targetTradingSymbol !== request.symbol,
      rejectionReason: null,
      orderId: clientOrderId,
    });

    // Place market buy on Binance
    Logger.info('REAL', 'ORDER', `Submitting live Binance MARKET BUY for ${targetTradingSymbol} (from ${request.symbol}) | Quote: ${fixedAmount} USDT`, {
      symbol: targetTradingSymbol,
      strategyState: request.strategyState,
      technicalScore: request.technicalScore,
    });

    let response;
    try {
      response = await this.binance.placeMarketBuy(apiKey, apiSecret, targetTradingSymbol, fixedAmount, clientOrderId);
    } catch (binanceErr: any) {
      // Invalidate metadata cache on Binance error to ensure fresh state
      validator.invalidateCache('SPOT');
      validator.ensureFreshMetadata('SPOT', true).catch(() => {});

      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: request.symbol,
        normalizedSymbol: targetTradingSymbol,
        market: 'SPOT',
        side: 'BUY',
        validationResult: false,
        binanceStatus: 'ERROR',
        mappingApplied: targetTradingSymbol !== request.symbol,
        rejectionReason: `BINANCE_REJECTION: ${binanceErr.message}`,
        orderId: clientOrderId,
      });

      Logger.error('REAL', 'ORDER', `LIVE_ORDER_REJECTED symbol=${targetTradingSymbol} reason=${binanceErr.message}`);
      throw binanceErr;
    }

    const executedQty = parseFloat(response.executedQty);
    const executedQuote = parseFloat(response.cummulativeQuoteQty);
    const fillPrice = executedQty > 0 ? executedQuote / executedQty : 0;

    let feeTotal = 0;
    let feeAsset = 'USDT';
    const fills = (response.fills || []).map(f => {
      const comm = parseFloat(f.commission);
      feeTotal += comm;
      feeAsset = f.commissionAsset;
      return {
        price: parseFloat(f.price),
        qty: parseFloat(f.qty),
        commission: comm,
        commissionAsset: f.commissionAsset,
        tradeId: f.tradeId,
      };
    });

    const orderId = `real-order-${response.orderId}`;
    const order: Order = {
      id: orderId,
      clientOrderId: response.clientOrderId,
      binanceOrderId: response.orderId.toString(),
      accountId: 'real-default',
      mode: 'REAL',
      symbol: targetTradingSymbol,
      side: 'BUY',
      status: response.status as OrderStatus,
      requestedQuoteAmount: fixedAmount,
      executedQuantity: executedQty,
      executedQuoteAmount: executedQuote,
      executionPrice: fillPrice,
      fee: feeTotal,
      feeAsset: feeAsset,
      reason: request.reason,
      strategyState: request.strategyState,
      technicalScore: request.technicalScore,
      createdAt: response.transactTime || Date.now(),
      updatedAt: Date.now(),
      fills,
    };
    Storage.saveOrder(order);

    if (response.status === 'FILLED' || response.status === 'PARTIALLY_FILLED') {
      const positionId = `real-pos-${response.orderId}`;
      const position: Position = {
        id: positionId,
        accountId: 'real-default',
        mode: 'REAL',
        symbol: targetTradingSymbol,
        quantity: executedQty,
        remainingQuantity: executedQty,
        entryPrice: fillPrice,
        entryQuoteAmount: fixedAmount,
        entryFees: feeTotal,
        entryScore: request.technicalScore,
        entryState: request.strategyState,
        entryReason: request.reason,
        currentPrice: fillPrice,
        currentScore: request.technicalScore,
        currentState: request.strategyState,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        openedAt: response.transactTime || Date.now(),
        updatedAt: Date.now(),
        status: 'OPEN',
        entryOrderId: order.id,
      };
      Storage.savePosition(position);

      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: request.symbol,
        normalizedSymbol: targetTradingSymbol,
        market: 'SPOT',
        side: 'BUY',
        validationResult: true,
        binanceStatus: 'FILLED',
        mappingApplied: targetTradingSymbol !== request.symbol,
        rejectionReason: null,
        orderId: order.id,
      });

      // Trigger background real balance update
      this.getBalance().catch(err => Logger.warn('REAL', 'WALLET', `Post-buy balance sync error: ${err.message}`));

      Logger.info('REAL', 'ORDER', `Real Binance BUY FILLED: ${targetTradingSymbol} | Executed: ${executedQty} @ ${fillPrice.toFixed(4)} | Total: ${executedQuote} USDT`, {
        symbol: targetTradingSymbol,
        orderId: order.id,
      });

      return { success: true, order, position };
    }

    return { success: false, order, error: `Order status is ${response.status}` };
  }

  public async sell(request: OrderRequest, positionId?: string): Promise<ExecutionResult> {
    if (process.env.LIVE_TRADING_ENABLED !== 'true') {
      throw new Error('Live Binance trading is disabled. Set LIVE_TRADING_ENABLED=true in server environment variables to enable real order placement.');
    }

    const { apiKey, apiSecret } = this.getCredentials();
    const position = positionId
      ? Storage.getPositionById(positionId)
      : Storage.getOpenPositionForSymbol(request.symbol, 'REAL');

    if (!position || position.status !== 'OPEN') {
      throw new Error(`No open real position found for ${request.symbol} (status: ${position?.status})`);
    }

    // 1. Authoritative Spot Symbol Validation
    const validator = BinanceSymbolValidator.getInstance();
    const valResult = await validator.validateSpotSymbol(position.symbol);

    if (!valResult.tradable) {
      Logger.warn(
        'REAL',
        'ORDER',
        `LIVE_ORDER_BLOCKED SELL symbol=${position.symbol} market=SPOT reason=${valResult.reason}`
      );
      throw new Error(`Live SELL blocked: Symbol ${position.symbol} is not tradable on Binance Spot (${valResult.reason})`);
    }

    // 2. Validate & Floor Sell Quantity to LOT_SIZE stepSize
    const rawSellQty = request.quantity || position.remainingQuantity;
    const qtyFormat = await validator.formatOrderQuantity(valResult.normalizedSymbol, rawSellQty, 'SPOT');

    if (!qtyFormat.valid) {
      const reason = qtyFormat.reason || 'INVALID_QUANTITY';
      Storage.saveSymbolAuditRecord({
        timestamp: Date.now(),
        requestedSymbol: position.symbol,
        normalizedSymbol: valResult.normalizedSymbol,
        market: 'SPOT',
        side: 'SELL',
        validationResult: false,
        binanceStatus: valResult.status,
        mappingApplied: valResult.normalizedSymbol !== position.symbol,
        rejectionReason: reason,
      });
      Logger.warn('REAL', 'ORDER', `LIVE_ORDER_BLOCKED SELL symbol=${position.symbol} reason=${reason}`);
      throw new Error(`Live SELL blocked: ${reason}`);
    }

    // 3. Verify Account Asset Balance on Binance
    let accountInfo;
    try {
      accountInfo = await this.binance.getAccount(apiKey, apiSecret);
    } catch (accErr: any) {
      throw new Error(`Failed to fetch Binance account status: ${accErr.message}`);
    }

    if (!accountInfo.canTrade) {
      throw new Error('Live Binance SELL blocked: API account cannot trade (canTrade is false)');
    }

    const baseAsset = valResult.baseAsset;
    const assetBalanceObj = accountInfo.balances.find(b => b.asset === baseAsset);
    const assetFree = assetBalanceObj ? parseFloat(assetBalanceObj.free) : 0;

    let finalSellQty = qtyFormat.numericQty;
    if (assetFree < finalSellQty) {
      if (assetFree >= valResult.filters.minQty) {
        // Adjust downward to exact free asset balance floored to stepSize
        const recheck = await validator.formatOrderQuantity(valResult.normalizedSymbol, assetFree, 'SPOT');
        if (!recheck.valid) {
          throw new Error(`Live SELL blocked: Available ${baseAsset} (${assetFree}) cannot satisfy stepSize`);
        }
        finalSellQty = recheck.numericQty;
      } else {
        throw new Error(`Live SELL blocked: Insufficient ${baseAsset} balance on Binance (Available: ${assetFree}, Required: ${finalSellQty})`);
      }
    }

    // Atomically transition OPEN -> CLOSING
    position.status = 'CLOSING';
    Storage.savePosition(position);

    const clientOrderId = request.clientOrderId || `AUTO-REAL-SELL-${valResult.normalizedSymbol}-${Date.now().toString(36)}`;

    Storage.saveSymbolAuditRecord({
      timestamp: Date.now(),
      requestedSymbol: position.symbol,
      normalizedSymbol: valResult.normalizedSymbol,
      market: 'SPOT',
      side: 'SELL',
      validationResult: true,
      binanceStatus: valResult.status,
      mappingApplied: valResult.normalizedSymbol !== position.symbol,
      rejectionReason: null,
      orderId: clientOrderId,
    });

    try {
      Logger.info('REAL', 'ORDER', `Submitting live Binance MARKET SELL for ${valResult.normalizedSymbol} | Quantity: ${finalSellQty}`, {
        symbol: valResult.normalizedSymbol,
        strategyState: request.strategyState,
        technicalScore: request.technicalScore,
      });

      let response;
      try {
        response = await this.binance.placeMarketSell(apiKey, apiSecret, valResult.normalizedSymbol, finalSellQty, clientOrderId);
      } catch (sellErr: any) {
        validator.invalidateCache('SPOT');
        validator.ensureFreshMetadata('SPOT', true).catch(() => {});
        throw sellErr;
      }

      const executedQty = parseFloat(response.executedQty);
      const executedQuote = parseFloat(response.cummulativeQuoteQty);
      const fillPrice = executedQty > 0 ? executedQuote / executedQty : 0;

      let feeTotal = 0;
      let feeAsset = 'USDT';
      const fills = (response.fills || []).map(f => {
        const comm = parseFloat(f.commission);
        feeTotal += comm;
        feeAsset = f.commissionAsset;
        return {
          price: parseFloat(f.price),
          qty: parseFloat(f.qty),
          commission: comm,
          commissionAsset: f.commissionAsset,
          tradeId: f.tradeId,
        };
      });

      const orderId = `real-order-${response.orderId}`;
      const order: Order = {
        id: orderId,
        clientOrderId: response.clientOrderId,
        binanceOrderId: response.orderId.toString(),
        accountId: 'real-default',
        mode: 'REAL',
        symbol: valResult.normalizedSymbol,
        side: 'SELL',
        status: response.status as OrderStatus,
        requestedQuantity: finalSellQty,
        executedQuantity: executedQty,
        executedQuoteAmount: executedQuote,
        executionPrice: fillPrice,
        fee: feeTotal,
        feeAsset: feeAsset,
        reason: request.reason,
        strategyState: request.strategyState,
        technicalScore: request.technicalScore,
        createdAt: response.transactTime || Date.now(),
        updatedAt: Date.now(),
        fills,
      };
      Storage.saveOrder(order);

      if (response.status === 'FILLED' || response.status === 'PARTIALLY_FILLED') {
        // Calculate PnL based on actual Binance execution
        const costBasisRatio = executedQty / position.quantity;
        const entryCostAllocated = position.entryQuoteAmount * costBasisRatio;
        const entryFeesAllocated = position.entryFees * costBasisRatio;
        const grossPnL = Number((executedQuote - entryCostAllocated).toFixed(4));
        const totalFees = Number((entryFeesAllocated + feeTotal).toFixed(4));
        const netPnL = Number((grossPnL - totalFees).toFixed(4));
        const netPnLPercent = entryCostAllocated > 0
          ? Number(((netPnL / entryCostAllocated) * 100).toFixed(2))
          : 0;

        const trade: Trade = {
          id: `real-trade-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          accountId: 'real-default',
          mode: 'REAL',
          symbol: valResult.normalizedSymbol,
          entryOrderId: position.entryOrderId,
          exitOrderId: order.id,
          entryPrice: position.entryPrice,
          exitPrice: fillPrice,
          quantity: executedQty,
          entryQuoteAmount: Number(entryCostAllocated.toFixed(2)),
          exitQuoteAmount: Number(executedQuote.toFixed(2)),
          entryFees: Number(entryFeesAllocated.toFixed(4)),
          exitFees: feeTotal,
          grossPnL,
          netPnL,
          netPnLPercent,
          entryScore: position.entryScore,
          exitScore: request.technicalScore,
          entryReason: position.entryReason,
          exitReason: request.reason,
          openedAt: position.openedAt,
          closedAt: response.transactTime || Date.now(),
          durationMs: (response.transactTime || Date.now()) - position.openedAt,
        };
        Storage.saveTrade(trade);

        // Update remaining quantity & position status
        position.remainingQuantity = Number((position.remainingQuantity - executedQty).toFixed(8));
        if (position.remainingQuantity <= 0.00001 || position.remainingQuantity < valResult.filters.minQty || response.status === 'FILLED') {
          position.status = 'CLOSED';
          position.remainingQuantity = 0;
        } else {
          position.status = 'OPEN';
        }
        position.exitOrderId = order.id;
        position.exitReason = request.reason;
        position.updatedAt = Date.now();
        Storage.savePosition(position);

        Storage.saveSymbolAuditRecord({
          timestamp: Date.now(),
          requestedSymbol: position.symbol,
          normalizedSymbol: valResult.normalizedSymbol,
          market: 'SPOT',
          side: 'SELL',
          validationResult: true,
          binanceStatus: 'FILLED',
          mappingApplied: valResult.normalizedSymbol !== position.symbol,
          rejectionReason: null,
          orderId: order.id,
        });

        const settings = Storage.getSettings();
        Storage.setSymbolCooldown(position.symbol, 'REAL', settings.symbolCooldownMinutes || 30);

        // Re-sync wallet
        this.getBalance().catch(err => Logger.warn('REAL', 'WALLET', `Post-sell sync error: ${err.message}`));

        Logger.info('REAL', 'ORDER', `Real Binance SELL FILLED: ${valResult.normalizedSymbol} | Net PnL: ${netPnL >= 0 ? '+' : ''}${netPnL} USDT (${netPnLPercent}%) | Fill: ${fillPrice.toFixed(4)}`, {
          symbol: valResult.normalizedSymbol,
          orderId: order.id,
        });

        return { success: true, order, position, trade };
      }

      // If status is neither FILLED nor PARTIALLY_FILLED
      position.status = 'OPEN';
      Storage.savePosition(position);
      return { success: false, order, error: `Sell order status is ${response.status}` };
    } catch (err: any) {
      position.status = 'OPEN';
      Storage.savePosition(position);
      Logger.error('REAL', 'ORDER', `Real SELL failed for ${position.symbol}: ${err.message}. Position status restored to OPEN.`);
      throw err;
    }
  }

  public async getOpenPositions(): Promise<Position[]> {
    return Storage.getPositions('REAL', 'OPEN');
  }

  public async getOrderStatus(orderId: string): Promise<OrderStatus> {
    const order = Storage.getOrderById(orderId);
    if (!order) return 'UNKNOWN';
    if (order.status === 'FILLED' || order.status === 'CANCELED' || order.status === 'REJECTED') {
      return order.status;
    }

    try {
      const { apiKey, apiSecret } = this.getCredentials();
      const res = await this.binance.queryOrder(apiKey, apiSecret, order.symbol, order.clientOrderId);
      order.status = res.status as OrderStatus;
      order.executedQuantity = parseFloat(res.executedQty);
      order.executedQuoteAmount = parseFloat(res.cummulativeQuoteQty);
      Storage.saveOrder(order);
      return order.status;
    } catch {
      return order.status;
    }
  }

  public async reconcile(): Promise<ReconciliationResult> {
    const discrepancies: string[] = [];
    try {
      await this.getBalance();
      return {
        status: 'OK',
        mode: 'REAL',
        discrepancies,
        correctedCount: 0,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      discrepancies.push(`Failed to reconcile with Binance: ${err.message}`);
      const wallet = Storage.getWallet('REAL');
      wallet.reconciliationStatus = 'ERROR';
      wallet.reconciliationError = err.message;
      Storage.updateWallet('REAL', wallet);

      return {
        status: 'ERROR',
        mode: 'REAL',
        discrepancies,
        correctedCount: 0,
        timestamp: Date.now(),
      };
    }
  }
}
