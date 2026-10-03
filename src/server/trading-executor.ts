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
} from '../types/index.ts';
import { Storage } from './storage.ts';
import { BinanceRequestManager } from './binance-client.ts';
import { floorToStep, safeSubtract, safeMultiply, safeAdd } from './decimal-utils.ts';
import { Logger } from './logger.ts';
import { AuditLogger } from './audit-logger.ts';

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
// Paper Trading Executor (Real Binance Spot Prices + Simulated Ledger)
// --------------------------------------------------------------------------
export class PaperTradingExecutor implements TradingExecutor {
  private binance = BinanceRequestManager.getInstance();

  public getMode(): TradingMode {
    return 'PAPER';
  }

  public async getBalance(): Promise<WalletBalance> {
    const wallet = Storage.getWallet('PAPER');
    const positions = Storage.getPositions('PAPER', 'OPEN');

    let totalAssetValue = 0;
    let totalUnrealized = 0;

    for (const pos of positions) {
      try {
        const livePrice = await this.binance.getLatestPrice(pos.symbol);
        pos.currentPrice = livePrice;
        pos.unrealizedPnL = Number(((livePrice - pos.entryPrice) * pos.remainingQuantity).toFixed(4));
        pos.unrealizedPnLPercent = Number((((livePrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));
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

    // 1. Get real-time Binance market price
    const livePrice = await this.binance.getLatestPrice(request.symbol);
    if (!livePrice || livePrice <= 0) {
      throw new Error(`Real market price unavailable for ${request.symbol}. Paper BUY aborted.`);
    }

    // 2. Apply simulated slippage (5 bps = 0.05%)
    const slippageMultiplier = 1 + (settings.paperSlippageBps || 5) / 10000;
    const executionPrice = Number((livePrice * slippageMultiplier).toFixed(6));

    // 3. Calculate simulated fee and token quantity
    const feeRate = settings.paperFeeRate || 0.001; // 0.1% standard spot fee
    const fee = Number((fixedAmount * feeRate).toFixed(4));

    // Respect exchange LOT_SIZE stepSize
    const filter = await this.binance.getSymbolFilters(request.symbol);
    const rawQty = fixedAmount / executionPrice;
    const executedQty = floorToStep(rawQty, filter.stepSize);

    if (executedQty < filter.minQty) {
      throw new Error(`Calculated quantity ${executedQty} is below minimum quantity ${filter.minQty}`);
    }

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

    // Record idempotency key to prevent duplicate execution
    Storage.recordIdempotencyKey(request.clientOrderId, order.id, request.clientOrderId);

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

    AuditLogger.log({
      eventType: 'BUY_FILLED',
      mode: 'PAPER',
      symbol: request.symbol,
      side: 'BUY',
      quantity: executedQty,
      price: executionPrice,
      orderId: order.id,
      clientOrderId: request.clientOrderId,
      reason: request.reason,
    });

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
      throw new Error(`No open paper position found for ${request.symbol}`);
    }

    const sellQty = request.quantity || position.remainingQuantity;
    if (sellQty <= 0 || sellQty > position.remainingQuantity * 1.0001) {
      throw new Error(`Invalid sell quantity ${sellQty} (position remaining: ${position.remainingQuantity})`);
    }

    // 1. Get real-time Binance market price
    const livePrice = await this.binance.getLatestPrice(request.symbol);
    if (!livePrice || livePrice <= 0) {
      throw new Error(`Real market price unavailable for ${request.symbol}. Paper SELL aborted.`);
    }

    // 2. Apply simulated slippage on sell
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

    // 5. Calculate Net PnL accurately
    const costBasisRatio = sellQty / position.quantity;
    const entryCostAllocated = position.entryQuoteAmount * costBasisRatio;
    const grossPnL = Number((grossExitQuoteAmount - entryCostAllocated).toFixed(4));
    const totalFees = Number((position.entryFees * costBasisRatio + exitFee).toFixed(4));
    const netPnL = Number((grossPnL - totalFees).toFixed(4));
    const netPnLPercent = Number(((netPnL / entryCostAllocated) * 100).toFixed(2));

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
      entryFees: Number((position.entryFees * costBasisRatio).toFixed(4)),
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

    // 6. Update Position status
    position.remainingQuantity = Number((position.remainingQuantity - sellQty).toFixed(8));
    if (position.remainingQuantity <= 0.000001) {
      position.status = 'CLOSED';
      position.remainingQuantity = 0;
    }
    position.exitOrderId = order.id;
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

    // Set re-entry cooldown
    Storage.setSymbolCooldown(request.symbol, 'PAPER', settings.symbolCooldownMinutes || 30);

    AuditLogger.log({
      eventType: 'SELL_FILLED',
      mode: 'PAPER',
      symbol: request.symbol,
      side: 'SELL',
      quantity: sellQty,
      price: executionPrice,
      orderId: order.id,
      reason: request.reason,
      details: { netPnL, netPnLPercent },
    });

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
      discrepancies.push(`Realized PnL mismatch: wallet=${wallet.realizedPnL}, trades sum=${totalRealizedFromTrades.toFixed(2)}`);
      wallet.realizedPnL = Number(totalRealizedFromTrades.toFixed(4));
    }

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
// Real Binance Trading Executor (Live Binance Spot API with Strict Hardening)
// --------------------------------------------------------------------------
export class RealBinanceTradingExecutor implements TradingExecutor {
  private binance = BinanceRequestManager.getInstance();

  public getMode(): TradingMode {
    return 'REAL';
  }

  private getCredentials(): { apiKey: string; apiSecret: string } {
    const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
    if (!realAcc) throw new Error('Real account configuration not found');
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
          // unpriced or low liquidity asset
        }

        const isManagedPosition = realPositions.some(p => p.symbol === `${b.asset}USDT`);
        assetsList.push({
          asset: b.asset,
          symbol: `${b.asset}USDT`,
          free,
          locked,
          total,
          price,
          valueUsdt: Number(valUsdt.toFixed(2)),
          isExternal: !isManagedPosition, // Mark non-strategy holdings as external
        });
      }
    }

    const totalEquity = usdtFree + usdtLocked + totalOtherAssetValueUsdt;

    // Calculate open real positions unrealized PnL
    let totalUnrealized = 0;
    for (const pos of realPositions) {
      try {
        const livePrice = await this.binance.getLatestPrice(pos.symbol);
        pos.currentPrice = livePrice;
        pos.unrealizedPnL = Number(((livePrice - pos.entryPrice) * pos.remainingQuantity).toFixed(4));
        pos.unrealizedPnLPercent = Number((((livePrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));
        Storage.savePosition(pos);
        totalUnrealized += pos.unrealizedPnL;
      } catch {
        // ignore single price failure
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
    const { apiKey, apiSecret } = this.getCredentials();
    const settings = Storage.getSettings();
    const fixedAmount = settings.fixedTradeAmount;

    // Hard Invariant Check
    if (!request.quoteAmount || Math.abs(request.quoteAmount - fixedAmount) > 0.001) {
      throw new Error(`Real BUY invariant rejected: requested quote amount (${request.quoteAmount}) must equal fixed trade amount (${fixedAmount})`);
    }

    const clientOrderId = request.clientOrderId || `AUTO-REAL-${request.symbol}-${Date.now().toString(36)}`;

    // Check idempotency key before submitting
    if (Storage.hasIdempotencyKey(clientOrderId)) {
      throw new Error(`Duplicate order submission blocked for clientOrderId ${clientOrderId}`);
    }

    Logger.info('REAL', 'ORDER', `Submitting live Binance MARKET BUY for ${request.symbol} | Quote: ${fixedAmount} USDT`, {
      symbol: request.symbol,
      strategyState: request.strategyState,
      technicalScore: request.technicalScore,
    });

    AuditLogger.log({
      eventType: 'BUY_SUBMITTED',
      mode: 'REAL',
      symbol: request.symbol,
      side: 'BUY',
      quantity: fixedAmount,
      clientOrderId,
      reason: request.reason,
    });

    let response: any;
    try {
      response = await this.binance.placeMarketBuy(apiKey, apiSecret, request.symbol, fixedAmount, clientOrderId);
    } catch (err: any) {
      // Network Timeout or Disconnect Recovery: Query Binance to verify whether order was actually placed
      try {
        const queried = await this.binance.queryOrder(apiKey, apiSecret, request.symbol, clientOrderId);
        if (queried && queried.status) {
          response = queried;
          Logger.info('REAL', 'ORDER', `Recovered order state after timeout via queryOrder: ${queried.status}`);
        } else {
          throw err;
        }
      } catch (queryErr) {
        AuditLogger.log({
          eventType: 'ORDER_UNKNOWN',
          mode: 'REAL',
          symbol: request.symbol,
          clientOrderId,
          reason: `Order submission failed or timed out: ${err.message}`,
        });
        throw err;
      }
    }

    const executedQty = parseFloat(response.executedQty);
    const executedQuote = parseFloat(response.cummulativeQuoteQty);
    const fillPrice = executedQty > 0 ? executedQuote / executedQty : 0;

    let feeTotalUsdt = 0;
    let baseAssetFeeAmount = 0;
    let feeAsset = 'USDT';
    const baseAsset = request.symbol.replace('USDT', '');

    const fills = (response.fills || []).map((f: any) => {
      const comm = parseFloat(f.commission);
      const commAsset = f.commissionAsset;
      feeAsset = commAsset;

      // Handle base-asset commission (e.g. commission paid in BTC on BTCUSDT)
      if (commAsset === baseAsset) {
        baseAssetFeeAmount += comm;
        feeTotalUsdt += comm * parseFloat(f.price);
      } else if (commAsset === 'USDT') {
        feeTotalUsdt += comm;
      } else {
        // Approximate other commission assets (e.g. BNB) in USDT
        feeTotalUsdt += comm * (commAsset === 'BNB' ? 550 : 1);
      }

      return {
        price: parseFloat(f.price),
        qty: parseFloat(f.qty),
        commission: comm,
        commissionAsset: commAsset,
        tradeId: f.tradeId,
      };
    });

    // CRITICAL: If commission was deducted in base asset, actual available position quantity is reduced!
    const netReceivedQty = Number((executedQty - baseAssetFeeAmount).toFixed(8));

    const orderId = `real-order-${response.orderId}`;
    const order: Order = {
      id: orderId,
      clientOrderId: response.clientOrderId,
      binanceOrderId: response.orderId.toString(),
      accountId: 'real-default',
      mode: 'REAL',
      symbol: request.symbol,
      side: 'BUY',
      status: response.status as OrderStatus,
      requestedQuoteAmount: fixedAmount,
      executedQuantity: executedQty,
      executedQuoteAmount: executedQuote,
      executionPrice: fillPrice,
      fee: Number(feeTotalUsdt.toFixed(4)),
      feeAsset: feeAsset,
      reason: request.reason,
      strategyState: request.strategyState,
      technicalScore: request.technicalScore,
      createdAt: response.transactTime || Date.now(),
      updatedAt: Date.now(),
      fills,
    };
    Storage.saveOrder(order);
    Storage.recordIdempotencyKey(clientOrderId, order.id, clientOrderId);

    if (response.status === 'FILLED' || response.status === 'PARTIALLY_FILLED') {
      const positionId = `real-pos-${response.orderId}`;
      const position: Position = {
        id: positionId,
        accountId: 'real-default',
        mode: 'REAL',
        symbol: request.symbol,
        quantity: netReceivedQty,
        remainingQuantity: netReceivedQty, // Exact net quantity available for future SELL
        entryPrice: fillPrice,
        entryQuoteAmount: fixedAmount,
        entryFees: Number(feeTotalUsdt.toFixed(4)),
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

      AuditLogger.log({
        eventType: response.status === 'FILLED' ? 'BUY_FILLED' : 'BUY_PARTIAL',
        mode: 'REAL',
        symbol: request.symbol,
        side: 'BUY',
        quantity: netReceivedQty,
        price: fillPrice,
        orderId: order.id,
        clientOrderId,
        reason: request.reason,
      });

      this.getBalance().catch(err => Logger.warn('REAL', 'WALLET', `Post-buy balance sync error: ${err.message}`));

      Logger.info('REAL', 'ORDER', `Real Binance BUY ${response.status}: ${request.symbol} | Executed: ${executedQty} (Net: ${netReceivedQty}) @ ${fillPrice.toFixed(4)} | Total: ${executedQuote} USDT`, {
        symbol: request.symbol,
        orderId: order.id,
      });

      return { success: true, order, position };
    }

    return { success: false, order, error: `Order status is ${response.status}` };
  }

  public async sell(request: OrderRequest, positionId?: string): Promise<ExecutionResult> {
    const { apiKey, apiSecret } = this.getCredentials();
    const position = positionId
      ? Storage.getPositionById(positionId)
      : Storage.getOpenPositionForSymbol(request.symbol, 'REAL');

    if (!position || position.status !== 'OPEN') {
      throw new Error(`No open real position found for ${request.symbol}`);
    }

    // Retrieve exchange balance to verify available quantity before submitting sell
    const baseAsset = request.symbol.replace('USDT', '');
    const accountInfo = await this.binance.getAccount(apiKey, apiSecret);
    const assetBalance = accountInfo.balances.find(b => b.asset === baseAsset);
    const exchangeFree = assetBalance ? parseFloat(assetBalance.free) : 0;

    const filter = await this.binance.getSymbolFilters(request.symbol);
    const requestedSellQty = request.quantity || position.remainingQuantity;

    // Safety: ensure sell quantity does not exceed exchange free balance
    const clampedQty = Math.min(requestedSellQty, exchangeFree, position.remainingQuantity);
    const formattedSellQty = floorToStep(clampedQty, filter.stepSize);

    if (formattedSellQty < filter.minQty) {
      throw new Error(`Sell quantity ${formattedSellQty} is below exchange minQty ${filter.minQty}. Cannot execute sell.`);
    }

    const clientOrderId = request.clientOrderId || `AUTO-REAL-SELL-${request.symbol}-${Date.now().toString(36)}`;

    Logger.info('REAL', 'ORDER', `Submitting live Binance MARKET SELL for ${request.symbol} | Quantity: ${formattedSellQty}`, {
      symbol: request.symbol,
      strategyState: request.strategyState,
      technicalScore: request.technicalScore,
    });

    AuditLogger.log({
      eventType: 'SELL_SUBMITTED',
      mode: 'REAL',
      symbol: request.symbol,
      side: 'SELL',
      quantity: formattedSellQty,
      clientOrderId,
      reason: request.reason,
    });

    let response: any;
    try {
      response = await this.binance.placeMarketSell(apiKey, apiSecret, request.symbol, formattedSellQty, clientOrderId);
    } catch (err: any) {
      try {
        const queried = await this.binance.queryOrder(apiKey, apiSecret, request.symbol, clientOrderId);
        if (queried && queried.status) {
          response = queried;
          Logger.info('REAL', 'ORDER', `Recovered SELL order state after timeout via queryOrder: ${queried.status}`);
        } else {
          throw err;
        }
      } catch (queryErr) {
        AuditLogger.log({
          eventType: 'ORDER_UNKNOWN',
          mode: 'REAL',
          symbol: request.symbol,
          clientOrderId,
          reason: `SELL submission error/timeout: ${err.message}`,
        });
        throw err;
      }
    }

    const executedQty = parseFloat(response.executedQty);
    const executedQuote = parseFloat(response.cummulativeQuoteQty);
    const fillPrice = executedQty > 0 ? executedQuote / executedQty : 0;

    let feeTotalUsdt = 0;
    let feeAsset = 'USDT';
    const fills = (response.fills || []).map((f: any) => {
      const comm = parseFloat(f.commission);
      feeAsset = f.commissionAsset;
      if (feeAsset === 'USDT') {
        feeTotalUsdt += comm;
      } else {
        feeTotalUsdt += comm * (feeAsset === 'BNB' ? 550 : 1);
      }
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
      symbol: request.symbol,
      side: 'SELL',
      status: response.status as OrderStatus,
      requestedQuantity: formattedSellQty,
      executedQuantity: executedQty,
      executedQuoteAmount: executedQuote,
      executionPrice: fillPrice,
      fee: Number(feeTotalUsdt.toFixed(4)),
      feeAsset: feeAsset,
      reason: request.reason,
      strategyState: request.strategyState,
      technicalScore: request.technicalScore,
      createdAt: response.transactTime || Date.now(),
      updatedAt: Date.now(),
      fills,
    };
    Storage.saveOrder(order);
    Storage.recordIdempotencyKey(clientOrderId, order.id, clientOrderId);

    if (response.status === 'FILLED' || response.status === 'PARTIALLY_FILLED') {
      // Calculate Net PnL accurately using multi-asset fee deduction
      const costBasisRatio = position.quantity > 0 ? executedQty / position.quantity : 1;
      const entryCostAllocated = position.entryQuoteAmount * costBasisRatio;
      const grossPnL = Number((executedQuote - entryCostAllocated).toFixed(4));
      const totalFees = Number((position.entryFees * costBasisRatio + feeTotalUsdt).toFixed(4));
      const netPnL = Number((grossPnL - totalFees).toFixed(4));
      const netPnLPercent = entryCostAllocated > 0 ? Number(((netPnL / entryCostAllocated) * 100).toFixed(2)) : 0;

      const trade: Trade = {
        id: `real-trade-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        accountId: 'real-default',
        mode: 'REAL',
        symbol: request.symbol,
        entryOrderId: position.entryOrderId,
        exitOrderId: order.id,
        entryPrice: position.entryPrice,
        exitPrice: fillPrice,
        quantity: executedQty,
        entryQuoteAmount: Number(entryCostAllocated.toFixed(2)),
        exitQuoteAmount: Number(executedQuote.toFixed(2)),
        entryFees: Number((position.entryFees * costBasisRatio).toFixed(4)),
        exitFees: Number(feeTotalUsdt.toFixed(4)),
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

      // Update remaining quantity
      position.remainingQuantity = Number((position.remainingQuantity - executedQty).toFixed(8));
      if (position.remainingQuantity <= 0.00001 || response.status === 'FILLED') {
        position.status = 'CLOSED';
        position.remainingQuantity = 0;
      }
      position.exitOrderId = order.id;
      position.updatedAt = Date.now();
      Storage.savePosition(position);

      const settings = Storage.getSettings();
      Storage.setSymbolCooldown(request.symbol, 'REAL', settings.symbolCooldownMinutes || 30);

      AuditLogger.log({
        eventType: response.status === 'FILLED' ? 'SELL_FILLED' : 'SELL_PARTIAL',
        mode: 'REAL',
        symbol: request.symbol,
        side: 'SELL',
        quantity: executedQty,
        price: fillPrice,
        orderId: order.id,
        clientOrderId,
        reason: request.reason,
        details: { netPnL, netPnLPercent },
      });

      this.getBalance().catch(err => Logger.warn('REAL', 'WALLET', `Post-sell sync error: ${err.message}`));

      Logger.info('REAL', 'ORDER', `Real Binance SELL ${response.status}: ${request.symbol} | Net PnL: ${netPnL >= 0 ? '+' : ''}${netPnL} USDT (${netPnLPercent}%) | Fill: ${fillPrice.toFixed(4)}`, {
        symbol: request.symbol,
        orderId: order.id,
      });

      return { success: true, order, position, trade };
    }

    return { success: false, order, error: `Sell order status is ${response.status}` };
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
      const { apiKey, apiSecret } = this.getCredentials();
      const accountInfo = await this.binance.getAccount(apiKey, apiSecret);
      const openBinanceOrders = await this.binance.getOpenOrders(apiKey, apiSecret);
      const localPositions = Storage.getPositions('REAL', 'OPEN');

      // 1. Compare local positions against exchange balance
      for (const pos of localPositions) {
        const baseAsset = pos.symbol.replace('USDT', '');
        const bal = accountInfo.balances.find(b => b.asset === baseAsset);
        const free = bal ? parseFloat(bal.free) : 0;
        if (free < pos.remainingQuantity * 0.95) {
          discrepancies.push(`Position quantity discrepancy on ${pos.symbol}: local remaining=${pos.remainingQuantity}, exchange free=${free}`);
        }
      }

      // 2. Track open Binance orders
      if (openBinanceOrders.length > 0) {
        discrepancies.push(`Found ${openBinanceOrders.length} active open orders directly on Binance`);
      }

      await this.getBalance();

      AuditLogger.log({
        eventType: 'RECONCILIATION_SYNC',
        mode: 'REAL',
        reason: discrepancies.length > 0 ? `Reconciled with ${discrepancies.length} discrepancies noted.` : 'Reconciled cleanly with Binance Spot.',
        details: { discrepancies },
      });

      return {
        status: discrepancies.length > 0 ? 'MISMATCH' : 'OK',
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

      AuditLogger.log({
        eventType: 'RECONCILIATION_MISMATCH',
        mode: 'REAL',
        reason: `Reconciliation error: ${err.message}`,
      });

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
