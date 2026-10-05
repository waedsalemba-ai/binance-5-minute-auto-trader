import express, { Request, Response, NextFunction } from 'express';
import { Storage, DATA_DIR } from './storage.ts';
import { BinanceRequestManager } from './binance-client.ts';
import { BinanceTimeService } from './binance-time.ts';
import { AutoTradingEngine } from './auto-trading-engine.ts';
import { Logger } from './logger.ts';
import { TradingMode, OrderRequest } from '../types/index.ts';
import {
  verifyAdminToken,
  verifyAdminSessionToken,
  createAdminSessionToken,
  isAuthRequired,
} from './security.ts';

export const apiApp = express();

apiApp.use(express.json());

// --------------------------------------------------------------------------
// 1. Production CORS & Security Headers
// --------------------------------------------------------------------------
const isProduction = process.env.NODE_ENV === 'production';
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || process.env.APP_ORIGIN;
const allowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean)
  : [];

apiApp.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;

  if (!isProduction) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (origin) {
    const cleanOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.length === 0 || allowedOrigins.includes(cleanOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, X-Session-Token, X-Admin-Token'
  );

  // Security Headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// --------------------------------------------------------------------------
// 2. Simple Rate Limiter for Sensitive & Auth Endpoints
// --------------------------------------------------------------------------
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function rateLimiter(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again in a few moments.',
      });
    }

    entry.count++;
    next();
  };
}

// --------------------------------------------------------------------------
// 3. Admin Authentication Middleware
// --------------------------------------------------------------------------
export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  // If no ADMIN_TOKEN is configured in environment, allow access
  if (!isAuthRequired()) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const sessionHeader = (req.headers['x-session-token'] as string) || '';
  const directTokenHeader = (req.headers['x-admin-token'] as string) || '';

  let bearerToken = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  // 1. Check Bearer token or direct admin header against ADMIN_TOKEN
  if (bearerToken && (verifyAdminToken(bearerToken) || verifyAdminSessionToken(bearerToken))) {
    return next();
  }

  if (directTokenHeader && verifyAdminToken(directTokenHeader)) {
    return next();
  }

  // 2. Check X-Session-Token
  if (sessionHeader && verifyAdminSessionToken(sessionHeader)) {
    return next();
  }

  // Otherwise reject with 401 Unauthorized
  return res.status(401).json({
    success: false,
    error: 'Unauthorized: Administrative authentication required. Provide valid Authorization Bearer token or session.',
  });
}

// --------------------------------------------------------------------------
// 4. Background Workers (Single authoritative instances)
// --------------------------------------------------------------------------
const autoTrader = AutoTradingEngine.getInstance();
const binance = BinanceRequestManager.getInstance();

// Start 24/7 worker engine
autoTrader.startScheduler();
BinanceTimeService.getInstance().syncWithBinance();

// --------------------------------------------------------------------------
// 5. Health & Readiness Endpoints
// --------------------------------------------------------------------------
const healthHandler = (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'binance-5-minute-auto-trader',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
};

const readyHandler = (req: Request, res: Response) => {
  const settings = Storage.getSettings();
  const summary = Storage.getScannerSummary();
  const timeService = BinanceTimeService.getInstance();
  const storageReady = Storage.isReady();

  const isReady = storageReady && process.uptime() > 0;

  res.status(isReady ? 200 : 503).json({
    ready: isReady,
    server: true,
    storage: storageReady,
    scanner: !summary.error,
    dataDir: DATA_DIR,
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true',
    tradingMode: settings.mode,
    autoTrading: settings.autoTrading,
    clockSyncSafe: timeService.isSafeDrift(),
    timestamp: new Date().toISOString(),
  });
};

apiApp.get('/health', healthHandler);
apiApp.get('/api/health', healthHandler);
apiApp.get('/ready', readyHandler);
apiApp.get('/api/ready', readyHandler);

// --------------------------------------------------------------------------
// 6. Authentication API Endpoints
// --------------------------------------------------------------------------
apiApp.get('/api/auth/status', (req: Request, res: Response) => {
  const authRequired = isAuthRequired();
  const sessionHeader = (req.headers['x-session-token'] as string) || '';
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  const authenticated = !authRequired
    || verifyAdminToken(bearer)
    || verifyAdminSessionToken(bearer)
    || verifyAdminSessionToken(sessionHeader);

  res.json({
    success: true,
    authRequired,
    authenticated,
    mode: Storage.getSettings().mode,
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true',
  });
});

apiApp.post('/api/auth/login', rateLimiter(10, 60000), (req: Request, res: Response) => {
  const { adminToken } = req.body;
  if (!adminToken || typeof adminToken !== 'string') {
    return res.status(400).json({ success: false, error: 'Admin token is required.' });
  }

  if (!isAuthRequired() || verifyAdminToken(adminToken)) {
    const sessionToken = createAdminSessionToken();
    Logger.info('PAPER', 'SECURITY', 'Admin session successfully authenticated.');
    return res.json({
      success: true,
      message: 'Authentication successful.',
      token: sessionToken,
    });
  }

  Logger.warn('PAPER', 'SECURITY', 'Failed admin login attempt: invalid token provided.');
  return res.status(401).json({ success: false, error: 'Invalid admin token. Ensure it matches ADMIN_TOKEN in your environment.' });
});

apiApp.post('/api/auth/logout', (req: Request, res: Response) => {
  res.json({ success: true, message: 'Logged out successfully.' });
});

// --------------------------------------------------------------------------
// 7. Real-time Server-Sent Events (SSE) Stream
// --------------------------------------------------------------------------
apiApp.get('/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connected payload
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  const unsubEngine = autoTrader.subscribe(event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  const unsubLogger = Logger.subscribe(logEntry => {
    res.write(`data: ${JSON.stringify({ type: 'log', payload: logEntry })}\n\n`);
  });

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
// 8. Public Market & Scanner Read APIs
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
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.get('/api/symbols', async (req: Request, res: Response) => {
  try {
    const analyses = Storage.getAllAnalysis();
    res.json({ success: true, data: analyses });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.get('/api/candles/:symbol', async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(symbol)) {
      return res.status(400).json({ success: false, error: 'Invalid symbol format.' });
    }
    const interval = (req.query.interval as string) || '5m';
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

    const candles = await binance.getKlines(symbol, interval, limit);
    res.json({ success: true, data: candles });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.get('/api/analysis/:symbol', async (req: Request, res: Response) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const analysis = Storage.getAnalysis(symbol);
    res.json({ success: true, data: analysis || null });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.get('/api/scanner/status', (req: Request, res: Response) => {
  res.json({ success: true, data: Storage.getScannerSummary() });
});

apiApp.get('/api/scanner/results', (req: Request, res: Response) => {
  res.json({ success: true, data: Storage.getAllAnalysis() });
});

apiApp.get('/api/positions', (req: Request, res: Response) => {
  const mode = req.query.mode as TradingMode | undefined;
  const status = req.query.status as any;
  const positions = Storage.getPositions(mode, status);
  res.json({ success: true, data: positions });
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

apiApp.get('/api/logs', (req: Request, res: Response) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const category = req.query.category as any;
  const mode = req.query.mode as any;
  const logs = Logger.getRecentLogs(limit, category, mode);
  res.json({ success: true, data: logs });
});

apiApp.get('/api/trading/settings', (req: Request, res: Response) => {
  res.json({ success: true, data: Storage.getSettings() });
});

// --------------------------------------------------------------------------
// 9. Protected Admin Endpoints (Require Admin Authentication)
// --------------------------------------------------------------------------
apiApp.post('/api/scanner/run', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const results = await autoTrader.runScanCycle();
    res.json({ success: true, message: `Scanned ${results.length} pairs`, count: results.length });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
        fixedTradeAmount: settings.fixedTradeAmount,
        wallet,
        positions,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.post('/api/trading/start', requireAdminAuth, (req: Request, res: Response) => {
  const settings = Storage.getSettings();
  if (settings.mode === 'REAL') {
    if (process.env.LIVE_TRADING_ENABLED !== 'true') {
      return res.status(400).json({
        success: false,
        error: 'REAL live trading is disabled by server configuration (LIVE_TRADING_ENABLED is not set to true).',
      });
    }

    const realAcc = Storage.getAccounts().find(a => a.mode === 'REAL');
    if (!realAcc || !realAcc.hasApiKeys) {
      return res.status(400).json({
        success: false,
        error: 'Cannot start REAL auto trading: Binance API credentials are not configured.',
      });
    }
    realAcc.autoTrading = true;
    Storage.saveAccount(realAcc);
  }

  if (autoTrader.isEmergencyStopActive()) {
    autoTrader.setEmergencyStop(false);
  }

  Storage.updateSettings({ autoTrading: true });
  Logger.info(settings.mode, 'STRATEGY', `Auto Trading STARTED in ${settings.mode} mode. Fixed amount: ${settings.fixedTradeAmount} USDT.`);
  res.json({ success: true, message: `Auto trading started in ${settings.mode} mode.`, settings: Storage.getSettings() });
});

apiApp.post('/api/trading/stop', requireAdminAuth, (req: Request, res: Response) => {
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

apiApp.post('/api/trading/emergency-stop', requireAdminAuth, (req: Request, res: Response) => {
  autoTrader.setEmergencyStop(true);
  res.json({
    success: true,
    message: 'EMERGENCY STOP ACTIVATED! All automatic trading stopped immediately. Existing positions remain untouched.',
  });
});

apiApp.put('/api/trading/settings', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const updates = req.body;
    if (updates.mode === 'REAL' && process.env.LIVE_TRADING_ENABLED !== 'true') {
      return res.status(400).json({
        success: false,
        error: 'Cannot switch to REAL mode: Live trading is disabled by server configuration (LIVE_TRADING_ENABLED != true).',
      });
    }

    const prevSettings = Storage.getSettings();
    const updated = Storage.updateSettings(updates);

    if (prevSettings.fixedTradeAmount !== updated.fixedTradeAmount) {
      Logger.info(
        updated.mode,
        'STRATEGY',
        `Fixed trade amount updated: ${prevSettings.fixedTradeAmount} USDT → ${updated.fixedTradeAmount} USDT. Applies to future BUY orders only.`
      );
    }

    if (prevSettings.mode !== updated.mode) {
      Logger.info(
        updated.mode,
        'SECURITY',
        `Trading mode switched to ${updated.mode}.`
      );
    }

    res.json({ success: true, data: updated });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

apiApp.get('/api/wallet', async (req: Request, res: Response) => {
  try {
    const mode = (req.query.mode as TradingMode) || Storage.getSettings().mode;
    const executor = autoTrader.getExecutor(mode);
    const wallet = await executor.getBalance();
    res.json({ success: true, data: wallet });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.post('/api/wallet/sync', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const mode = (req.body.mode as TradingMode) || Storage.getSettings().mode;
    const executor = autoTrader.getExecutor(mode);
    const result = await executor.reconcile();
    const wallet = await executor.getBalance();
    res.json({ success: true, data: wallet, reconciliation: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.post(['/api/wallet/reset-paper', '/api/wallet/reset'], requireAdminAuth, (req: Request, res: Response) => {
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
      message: 'All active positions closed and paper wallet balance reset to default 1000 USDT.',
      data: wallet,
      positions,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.post('/api/positions/:id/sell', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const positionId = req.params.id;
    const position = Storage.getPositionById(positionId);
    if (!position || position.status !== 'OPEN') {
      return res.status(404).json({ success: false, error: 'Open position not found.' });
    }

    const mode = position.mode;
    const executor = autoTrader.getExecutor(mode);
    const clientOrderId = `MANUAL-${mode}-SELL-${position.symbol}-${Date.now().toString(36)}`;

    const orderRequest: OrderRequest = {
      symbol: position.symbol,
      side: 'SELL',
      quantity: position.remainingQuantity,
      reason: 'Manual user exit from dashboard.',
      strategyState: 'EXIT',
      technicalScore: position.currentScore || 50,
      clientOrderId,
    };

    const result = await executor.sell(orderRequest, position.id);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiApp.post('/api/binance/test', requireAdminAuth, rateLimiter(5, 60000), async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: 'API Key and Secret are required.' });
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
    res.status(400).json({ success: false, error: err.message });
  }
});

apiApp.post('/api/binance/connect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ success: false, error: 'API Key and Secret are required.' });
    }

    const account = await binance.testCredentials(apiKey.trim(), apiSecret.trim());
    const hasWithdrawal = Boolean(account.canWithdraw);

    const realAccId = 'real-default';
    Storage.saveBinanceCredentials(realAccId, apiKey.trim(), apiSecret.trim(), {
      canTrade: account.canTrade,
      canRead: true,
      hasWithdrawalWarning: hasWithdrawal,
    });

    const realExecutor = autoTrader.getExecutor('REAL');
    await realExecutor.getBalance();

    Logger.info('REAL', 'SECURITY', 'Binance Spot credentials securely saved with AES-256-GCM encryption at rest.');

    res.json({
      success: true,
      message: 'Binance credentials connected and verified successfully.',
      hasWithdrawalWarning: hasWithdrawal,
      account: Storage.getAccount(realAccId),
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

apiApp.post('/api/binance/disconnect', requireAdminAuth, (req: Request, res: Response) => {
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
// 12. Database Health, Diagnostics & Backup Endpoints
// --------------------------------------------------------------------------
apiApp.get('/api/db/health', (req: Request, res: Response) => {
  const isReady = Storage.isReady();
  const stats = Storage.getDatabaseStats();
  res.status(isReady ? 200 : 503).json({
    success: isReady,
    status: isReady ? 'HEALTHY' : 'UNHEALTHY',
    timestamp: new Date().toISOString(),
    dataDir: stats.dataDir,
    dbFile: stats.dbFile,
    fileSizeBytes: stats.fileSizeBytes,
  });
});

apiApp.get('/api/db/stats', (req: Request, res: Response) => {
  res.json({
    success: true,
    data: Storage.getDatabaseStats(),
  });
});

apiApp.post('/api/db/backup', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const backupResult = Storage.backupDatabase();
    res.json({
      success: true,
      message: 'Database backup snapshot successfully created.',
      data: backupResult,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: `Failed to create database snapshot: ${err.message}`,
    });
  }
});
