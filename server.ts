import express, { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { apiApp } from './src/server/api-app.ts';
import { Storage, DATA_DIR } from './src/server/storage.ts';
import { AutoTradingEngine } from './src/server/auto-trading-engine.ts';
import { Logger } from './src/server/logger.ts';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// 1. Health & Readiness endpoints at root level
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'binance-5-minute-auto-trader',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get('/ready', (req: Request, res: Response) => {
  const isReady = Storage.isReady();
  res.status(isReady ? 200 : 503).json({
    ready: isReady,
    server: true,
    storage: isReady,
    scanner: true,
    dataDir: DATA_DIR,
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true',
    timestamp: new Date().toISOString(),
  });
});

// 2. Mount API Router
app.use(apiApp);

// 3. Frontend delivery
async function startServer() {
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

  const server = app.listen(PORT, '0.0.0.0', () => {
    Logger.info(
      'PAPER',
      'INFO',
      `🚀 Binance 5m Scanner & 24/7 Auto Trader running on 0.0.0.0:${PORT} [ENV: ${process.env.NODE_ENV || 'development'}] [DATA_DIR: ${DATA_DIR}] [LIVE: ${process.env.LIVE_TRADING_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}]`
    );
  });

  // Graceful shutdown handling
  let isShuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    Logger.info('PAPER', 'INFO', `Received ${signal}. Performing graceful shutdown...`);

    // Stop background scanner & timers
    AutoTradingEngine.getInstance().stopScheduler();

    // Flush pending persistent database state to disk
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
