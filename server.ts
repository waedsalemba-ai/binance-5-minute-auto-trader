import express, { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { apiApp, startBackgroundWorkers } from './src/server/api-app.ts';
import { Storage, DATA_DIR } from './src/server/storage.ts';
import { AutoTradingEngine } from './src/server/auto-trading-engine.ts';
import { Logger } from './src/server/logger.ts';
import { sanitizeDatabaseUrl } from './src/server/postgres.ts';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// --------------------------------------------------------------------------
// 1. Strict Production Environment Validation
// --------------------------------------------------------------------------
if (isProduction) {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim().length === 0) {
    console.error('FATAL: DATABASE_URL environment variable is required in production.');
    process.exit(1);
  }

  const adminToken = process.env.ADMIN_TOKEN || process.env.ADMIN_ACCESS_TOKEN;
  if (!adminToken || adminToken.trim().length === 0 || adminToken === '12345') {
    console.error('FATAL: A strong ADMIN_TOKEN environment variable is required in production (cannot be empty or default).');
    process.exit(1);
  }

  const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!encKey || encKey.trim().length === 0) {
    console.error('FATAL: CREDENTIAL_ENCRYPTION_KEY environment variable is required in production for secure credential storage.');
    process.exit(1);
  }
}

// --------------------------------------------------------------------------
// 2. Health & Readiness endpoints at root level
// --------------------------------------------------------------------------
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'binance-5-minute-auto-trader',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get('/ready', async (req: Request, res: Response) => {
  const isReady = await Storage.isDatabaseReadyAsync();
  const settings = Storage.getSettings();
  const summary = Storage.getScannerSummary();
  res.status(isReady ? 200 : 503).json({
    ready: isReady,
    server: true,
    storage: isReady,
    storageEngine: 'PostgreSQL',
    database: isReady ? 'connected' : 'disconnected',
    scanner: !summary.error,
    autoTrading: settings.autoTrading,
    mode: settings.mode,
    dataDir: DATA_DIR,
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// --------------------------------------------------------------------------
// 3. Mount API Router
// --------------------------------------------------------------------------
app.use(apiApp);

// --------------------------------------------------------------------------
// 4. Production Startup Sequence
// --------------------------------------------------------------------------
async function startServer() {
  Logger.info('PAPER', 'DATABASE', 'Beginning production startup sequence: initializing PostgreSQL storage and rehydrating state...');

  // 1. Ensure PostgreSQL is connected, schema is initialized, and state is rehydrated
  await Storage.ensureReady();
  const isDbReady = await Storage.isDatabaseReadyAsync();

  if (!isDbReady) {
    const errMsg = 'FATAL: Authoritative PostgreSQL database failed to initialize or ping successfully.';
    Logger.error('PAPER', 'DATABASE', errMsg);
    if (isProduction) {
      console.error(errMsg);
      process.exit(1);
    }
  }

  // 2. Setup Frontend delivery
  const distPath = path.resolve(process.cwd(), 'dist');
  const hasDist = fs.existsSync(distPath) && fs.existsSync(path.join(distPath, 'index.html'));

  if (!isProduction || !hasDist) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      if (req.path.startsWith('/api') || req.path === '/health' || req.path === '/ready') {
        return res.status(404).json({ success: false, error: `Route not found: ${req.path}` });
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 3. Start HTTP Server
  const server = app.listen(PORT, '0.0.0.0', () => {
    Logger.info(
      'PAPER',
      'INFO',
      `🚀 Binance 5m Scanner & 24/7 Auto Trader running on 0.0.0.0:${PORT} [ENV: ${process.env.NODE_ENV || 'development'}] [STORAGE: PostgreSQL at ${sanitizeDatabaseUrl(process.env.DATABASE_URL)}] [LIVE: ${process.env.LIVE_TRADING_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}]`
    );

    // 4. ONLY AFTER successful database initialization & HTTP listen, start AutoTradingEngine and Binance sync
    if (isDbReady) {
      Logger.info('PAPER', 'INFO', 'Starting 24/7 server-side AutoTradingEngine and Binance time synchronization...');
      startBackgroundWorkers();
    }
  });

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    Logger.info('PAPER', 'INFO', `Received ${signal}. Performing graceful shutdown...`);

    // Stop background scanner & timers
    AutoTradingEngine.getInstance().stopScheduler();

    // Flush pending state
    Storage.flush();

    server.close(() => {
      Logger.info('PAPER', 'INFO', 'HTTP server closed cleanly. Process exiting.');
      process.exit(0);
    });

    // Force terminate if graceful shutdown hangs
    setTimeout(() => {
      console.error('Graceful shutdown timed out. Force exiting.');
      process.exit(1);
    }, 8000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

startServer().catch(err => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
