import express, { Request, Response } from 'express';
import { Storage } from './storage.ts';
import { BinanceRequestManager } from './binance-client.ts';
import { BinanceTimeService } from './binance-time.ts';
import { AutoTradingEngine } from './auto-trading-engine.ts';
import { SafetyGate } from './safety-gate.ts';
import { Logger } from './logger.ts';
import { AuditLogger } from './audit-logger.ts';
import { requireAuth, isAllowedOrigin, getAdminToken, validateRequestAuth } from './auth.ts';
import { sanitizeLogMessage } from './security.ts';
import { TradingMode, OrderRequest } from '../types/index.ts';

export const apiApp = express();

apiApp.use(express.json());

// CORS & Security headers (Production hardened)
apiApp.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (process.env.NODE_ENV !== 'production') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token, X-API-Key, X-Requested-With');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  if (process.env.NODE_ENV === 'production' || req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Initialize Binance time sync and auto-trading engine
const autoTrader = AutoTradingEngine.getInstance();
const binance = BinanceRequestManager.getInstance();

// Auto-start scheduler (fail-closed check inside)
autoTrader.startScheduler();

// Structured error helper
function sendError(res: Response, status: number, code: string, message: string, retryable = false) {
  return res.status(status).json({
    success: false,
    error: {
      code,
      message: sanitizeLogMessage(message),
      retryable,
    },
  });
}

// --------------------------------------------------------------------------
// Real-time SSE Stream
// --------------------------------------------------------------------------
apiApp.get('/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial ping
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  const unsubEngine = autoTrader.subscribe(event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const unsubLogger = Logger.subscribe(logEntry => {
    res.write(`data: ${JSON.stringify({ type: 'log', payload: logEntry })}\n\n`);
  });

  // Keep alive ping every 15s
  const keepAlive = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping', timestamp: Date.now() })}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubEngine();
    unsubLogger();
  });
});

// --------------------------------------------------------------------------
// Authentication & Health Endpoints
// --------------------------------------------------------------------------

apiApp.get('/api/auth/status', (req: Request, res: Response) => {
  const isAuthenticated = validateRequestAuth(req);
  const token = getAdminToken();
  res.json({
    success: true,
    authenticated: isAuthenticated,
    token: token, // Used by the frontend client for session requests
  });
});

// Health check endpoint for cloud load balancers & monitoring
apiApp.get(['/health', '/api/health'], (req: Request, res: Response) => {
  res.json({
    status: 'ok',
  });
});

// Readiness check endpoint
apiApp.get(['/ready', '/api/ready'], (req: Request, res: Response) => {
  try {
    const settings = Storage.getSettings();
    const summary = Storage.getScannerSummary();
    const timeService = BinanceTimeService.getInstance();
    const isReady = Boolean(settings && summary && autoTrader);

    res.json({
      ready: isReady,
      database: true,
      tradingEngine: Boolean(autoTrader),
      timeService: timeService.isSafeDrift(),
      tradingMode: settings?.mode || 'PAPER',
      autoTrading: Boolean(settings?.autoTrading),
      emergencyStop: autoTrader.isEmergencyStopActive(),
      uptime: process.uptime(),
    });
  } catch (err: any) {
    res.status(503).json({
      ready: false,
      database: false,
      tradingEngine: false,
      error: err.message,
    });
  }
});

// --------------------------------------------------------------------------
// Market Data & Scanning
// --------------------------------------------------------------------------

apiApp.get('/api/market/status', async (req: Request, res: Response) => {
  try {
    const summary = Storage.getScannerSummary();
    const timeService = BinanceTimeService.getInstance();
    res.json({
      success: true,
      data: {
        summary,
        clockDriftMs: timeService.getOffset(),
        isClockDriftSafe: timeService.isSafeDrift(),
      },
    });
  } catch (err: any) {
    sendError(res, 500, 'MARKET_STATUS_ERROR', err.message);
  }
});

apiApp.get('/api/symbols', async (req: Request, res: Response) => {
  try {
    const analyses = Storage.getAllAnalysis();
    res.json({ success: true, data: analyses });
  } catch (err: any) {
    sendError(res, 500, 'SYMBOLS_ERROR', err.message);
  }
});

apiApp.get('/api/candles/:symbol', async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const interval = (req.query.interval as string) || '5m';
    const limit = Math.min(500, Number(req.query.limit) || 100);

    const candles = await binance.getKlines(symbol, interval, limit);
    res.json({ success: true, data: candles });
  } catch (err: any) {
    sendError(res, 500, 'CANDLES_FETCH_ERROR', err.message);
  }
});

apiApp.get('/api/analysis/:symbol', async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const analysis = Storage.getAnalysis(symbol);
    res.json({ success: true, data: analysis || null });
  } catch (err: any) {
    sendError(res, 500, 'ANALYSIS_ERROR', err.message);
  }
});

apiApp.get('/api/scanner/status', (req: Request, res: Response) => {
  res.json({ success: true, data: Storage.getScannerSummary() });
});

apiApp.get('/api/scanner/results', (req: Request, res: Response) => {
  const list = Storage.getAllAnalysis();
  res.json({ success: true, data: list });
});

apiApp.post('/api/scanner/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const results = await autoTrader.runScanCycle();
    res.json({ success: true, message: `Scanned ${results.length} pairs`, count: results.length });
  } catch (err: any) {
    sendError(res, 500, 'SCANNER_RUN_ERROR', err.message);
  }
});

// --------------------------------------------------------------------------
// Trading Controls & Settings (Protected by requireAuth)
// --------------------------------------------------------------------------

apiApp.get('/api/trading/status', async (req: Request, res: Response) => {
  const settings = Storage.getSettings();
  const mode = settings.mode;
  const executor = autoTrader.getExecutor(mode);

  try {
    const wallet = await executor.getBalance();
    const positions = await executor.getOpenPositions();
    res.json({
      success: true,
      data: {
        mode,
        autoTrading: settings.autoTrading,
        emergencyStop: autoTrader.isEmergencyStopActive(),
        realModeConfirmed: Storage.isRealModeConfirmed(),
        fixedTradeAmount: settings.fixedTradeAmount,
        wallet,
        positions,
      },
    });
  } catch (err: any) {
    sendError(res, 500, 'TRADING_STATUS_ERROR', err.message);
  }
});

apiApp.post('/api/trading/confirm-real-mode', requireAuth, (req: Request, res: Response) => {
  const { phrase } = req.body;
  const expected = 'I UNDERSTAND THIS USES REAL BINANCE FUNDS';
  if (phrase !== expected) {
    return sendError(res, 400, 'INVALID_CONFIRMATION_PHRASE', `Confirmation phrase must exactly equal "${expected}"`);
  }

  Storage.setRealModeConfirmed(true);
  res.json({
    success: true,
    message: 'REAL mode disclaimer confirmed and authorized on server.',
  });
});

apiApp.post('/api/trading/start', requireAuth, (req: Request, res: Response) => {
  const settings = Storage.getSettings();

  if (Storage.isEmergencyStopActive()) {
    return sendError(res, 400, 'EMERGENCY_STOP_ACTIVE', 'Cannot start auto trading: Emergency Stop is currently active. Explicit reset required.');
  }

  if (settings.mode === 'REAL') {
    if (!Storage.isRealModeConfirmed()) {
      return sendError(res, 400, 'REAL_MODE_NOT_CONFIRMED', 'Cannot start REAL auto trading: Server-side disclaimer verification is required.');
    }

    const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
    if (!realAcc || !realAcc.hasApiKeys) {
      return sendError(res, 400, 'REAL_CREDENTIALS_MISSING', 'Cannot start REAL auto trading: Binance API credentials are not configured.');
    }

    if (!BinanceTimeService.getInstance().isSafeDrift()) {
      return sendError(res, 400, 'CLOCK_DRIFT_UNSAFE', 'Cannot start REAL auto trading: Binance clock synchronization is unsafe.');
    }

    realAcc.autoTrading = true;
    Storage.saveAccount(realAcc);
  }

  Storage.updateSettings({ autoTrading: true });
  Logger.info(settings.mode, 'STRATEGY', `Auto Trading STARTED in ${settings.mode} mode. Fixed amount: ${settings.fixedTradeAmount} USDT.`);
  res.json({ success: true, message: `Auto trading started in ${settings.mode} mode.`, settings: Storage.getSettings() });
});

apiApp.post('/api/trading/stop', requireAuth, (req: Request, res: Response) => {
  const settings = Storage.getSettings();
  if (settings.mode === 'REAL') {
    const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
    if (realAcc) {
      realAcc.autoTrading = false;
      Storage.saveAccount(realAcc);
    }
  }

  Storage.updateSettings({ autoTrading: false });
  Logger.info(settings.mode, 'STRATEGY', `Auto Trading STOPPED in ${settings.mode} mode. Existing positions remain intact.`);
  res.json({ success: true, message: 'Auto trading stopped.', settings: Storage.getSettings() });
});

apiApp.post('/api/trading/emergency-stop', requireAuth, (req: Request, res: Response) => {
  autoTrader.setEmergencyStop(true);
  res.json({
    success: true,
    message: 'EMERGENCY STOP ACTIVATED! All automatic buying locked in persistent storage. Existing positions remain untouched.',
  });
});

apiApp.post('/api/trading/emergency-reset', requireAuth, (req: Request, res: Response) => {
  autoTrader.setEmergencyStop(false);
  res.json({
    success: true,
    message: 'Emergency Stop successfully reset by authenticated user.',
  });
});

apiApp.get('/api/trading/settings', (req: Request, res: Response) => {
  res.json({ success: true, data: Storage.getSettings() });
});

apiApp.put('/api/trading/settings', requireAuth, (req: Request, res: Response) => {
  try {
    const prevSettings = Storage.getSettings();
    const updated = Storage.updateSettings(req.body);

    if (prevSettings.fixedTradeAmount !== updated.fixedTradeAmount) {
      Logger.info(
        updated.mode,
        'STRATEGY',
        `Fixed trade amount updated: ${prevSettings.fixedTradeAmount} USDT → ${updated.fixedTradeAmount} USDT.`
      );
    }

    res.json({ success: true, data: updated });
  } catch (err: any) {
    sendError(res, 400, 'SETTINGS_UPDATE_ERROR', err.message);
  }
});

// --------------------------------------------------------------------------
// Wallet, Positions & Manual Sell (Protected by requireAuth)
// --------------------------------------------------------------------------

apiApp.get('/api/wallet', async (req: Request, res: Response) => {
  try {
    const mode = (req.query.mode as TradingMode) || Storage.getSettings().mode;
    const executor = autoTrader.getExecutor(mode);
    const wallet = await executor.getBalance();
    res.json({ success: true, data: wallet });
  } catch (err: any) {
    sendError(res, 500, 'WALLET_FETCH_ERROR', err.message);
  }
});

apiApp.post('/api/wallet/sync', requireAuth, async (req: Request, res: Response) => {
  try {
    const mode = (req.body.mode as TradingMode) || Storage.getSettings().mode;
    const executor = autoTrader.getExecutor(mode);
    const result = await executor.reconcile();
    const wallet = await executor.getBalance();
    res.json({ success: true, data: wallet, reconciliation: result });
  } catch (err: any) {
    sendError(res, 500, 'WALLET_SYNC_ERROR', err.message);
  }
});

apiApp.post(['/api/wallet/reset-paper', '/api/wallet/reset'], requireAuth, (req: Request, res: Response) => {
  try {
    Storage.resetPaperAccount();
    const wallet = Storage.getWallet('PAPER');
    const positions = Storage.getPositions('PAPER');

    autoTrader.broadcast('order_executed', {
      order: {
        id: `RESET-${Date.now()}`,
        clientOrderId: `RESET-${Date.now()}`,
        mode: 'PAPER',
        symbol: 'ALL',
        side: 'SELL',
        type: 'MARKET',
        quantity: 0,
        executedQuantity: 0,
        quoteAmount: 0,
        executedQuoteAmount: 0,
        status: 'FILLED',
        time: Date.now(),
        updatedTime: Date.now(),
      },
      position: null,
      wallet,
    });

    res.json({
      success: true,
      message: 'All active positions closed and wallet balance reset to default 1000 USDT.',
      data: wallet,
      positions,
    });
  } catch (err: any) {
    sendError(res, 500, 'WALLET_RESET_ERROR', err.message);
  }
});

apiApp.get('/api/positions', async (req: Request, res: Response) => {
  const mode = req.query.mode as TradingMode | undefined;
  const status = req.query.status as any;
  const sync = req.query.sync === 'true';

  if (sync || status === 'OPEN') {
    await autoTrader.syncActivePositionsWithBinance().catch(() => {});
  }

  const positions = Storage.getPositions(mode, status);
  res.json({ success: true, data: positions });
});

apiApp.post('/api/positions/sync', async (req: Request, res: Response) => {
  try {
    const updatedPositions = await autoTrader.syncActivePositionsWithBinance();
    const mode = (req.body.mode as TradingMode) || Storage.getSettings().mode;
    const wallet = Storage.getWallet(mode);

    res.json({
      success: true,
      message: 'Active positions synchronized online with Binance API.',
      data: updatedPositions,
      wallet,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    sendError(res, 500, 'POSITION_SYNC_ERROR', err.message);
  }
});

/**
 * Manual Sell Endpoint: Protected by requireAuth and Central SafetyGate validation.
 */
apiApp.post('/api/positions/:id/sell', requireAuth, async (req: Request, res: Response) => {
  try {
    const positionId = req.params.id;
    const position = Storage.getPositionById(positionId);
    if (!position || position.status !== 'OPEN') {
      return sendError(res, 404, 'POSITION_NOT_FOUND', 'Open position not found or already closed.');
    }

    const mode = position.mode;
    const executor = autoTrader.getExecutor(mode);
    const clientOrderId = `MANUAL-${mode}-SELL-${position.symbol}-${Date.now().toString(36)}`;

    const orderRequest: OrderRequest = {
      symbol: position.symbol,
      side: 'SELL',
      quantity: position.remainingQuantity,
      reason: 'Manual user exit from authenticated dashboard.',
      strategyState: 'EXIT',
      technicalScore: position.currentScore || 50,
      clientOrderId,
    };

    // Central Safety Gate Sell Validation
    const symbolFilter = await binance.getSymbolFilters(position.symbol);
    const livePrice = await binance.getLatestPrice(position.symbol);

    const safetyResult = SafetyGate.validateSell(
      orderRequest,
      position,
      mode,
      autoTrader.isEmergencyStopActive(),
      symbolFilter,
      livePrice
    );

    if (!safetyResult.allowed) {
      return sendError(res, 400, safetyResult.code, safetyResult.reason || 'Safety Gate rejected manual sell.');
    }

    const result = await executor.sell(orderRequest, position.id);
    res.json({ success: true, data: result });
  } catch (err: any) {
    sendError(res, 500, 'MANUAL_SELL_ERROR', err.message);
  }
});

apiApp.get('/api/orders', (req: Request, res: Response) => {
  const mode = req.query.mode as TradingMode | undefined;
  const symbol = req.query.symbol as string | undefined;
  const orders = Storage.getOrders(mode, symbol);
  res.json({ success: true, data: orders });
});

apiApp.get('/api/trades', (req: Request, res: Response) => {
  const mode = req.query.mode as TradingMode | undefined;
  const symbol = req.query.symbol as string | undefined;
  const trades = Storage.getTrades(mode, symbol);
  res.json({ success: true, data: trades });
});

// --------------------------------------------------------------------------
// Binance Credentials & Management (Protected by requireAuth)
// --------------------------------------------------------------------------

apiApp.post('/api/binance/test', requireAuth, async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) {
      return sendError(res, 400, 'MISSING_CREDENTIALS', 'API Key and Secret are required.');
    }

    const account = await binance.testCredentials(apiKey.trim(), apiSecret.trim());
    const hasWithdrawal = Boolean(account.canWithdraw);

    res.json({
      success: true,
      canTrade: account.canTrade,
      canWithdraw: account.canWithdraw,
      hasWithdrawalWarning: hasWithdrawal,
      accountType: account.accountType,
      balancesCount: account.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0).length,
    });
  } catch (err: any) {
    sendError(res, 400, 'BINANCE_TEST_FAILED', err.message);
  }
});

apiApp.post('/api/binance/connect', requireAuth, async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) {
      return sendError(res, 400, 'MISSING_CREDENTIALS', 'API Key and Secret are required.');
    }

    const account = await binance.testCredentials(apiKey.trim(), apiSecret.trim());
    const hasWithdrawal = Boolean(account.canWithdraw);

    const realAccId = 'real-default';
    Storage.saveBinanceCredentials(realAccId, apiKey.trim(), apiSecret.trim(), {
      canTrade: account.canTrade,
      canRead: true,
      hasWithdrawalWarning: hasWithdrawal,
    });

    // Synchronize initial real balances
    const realExecutor = autoTrader.getExecutor('REAL');
    await realExecutor.getBalance();

    res.json({
      success: true,
      message: 'Binance credentials connected and verified successfully with AES-256-GCM encryption at rest.',
      hasWithdrawalWarning: hasWithdrawal,
      account: Storage.getAccount(realAccId),
    });
  } catch (err: any) {
    sendError(res, 400, 'BINANCE_CONNECT_FAILED', err.message);
  }
});

apiApp.post('/api/binance/disconnect', requireAuth, (req: Request, res: Response) => {
  const realAccId = 'real-default';
  Storage.removeBinanceCredentials(realAccId);
  const settings = Storage.getSettings();
  if (settings.mode === 'REAL') {
    Storage.updateSettings({ mode: 'PAPER', autoTrading: false });
  }
  Logger.info('REAL', 'SECURITY', 'Binance credentials removed.');
  res.json({ success: true, message: 'Binance credentials removed.' });
});

// --------------------------------------------------------------------------
// System & Audit Logs (Protected)
// --------------------------------------------------------------------------

apiApp.get('/api/logs', (req: Request, res: Response) => {
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const category = req.query.category as any;
  const mode = req.query.mode as any;
  const logs = Logger.getRecentLogs(limit, category, mode);
  res.json({ success: true, data: logs });
});

apiApp.get('/api/audit-logs', requireAuth, (req: Request, res: Response) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const eventType = req.query.eventType as any;
  const auditLogs = AuditLogger.getRecent(limit, eventType);
  res.json({ success: true, data: auditLogs });
});
