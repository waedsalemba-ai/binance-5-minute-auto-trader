import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { apiApp } from './src/server/api-app.ts';
import { Logger } from './src/server/logger.ts';
import { AutoTradingEngine } from './src/server/auto-trading-engine.ts';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// 1. Mount API Router with all /api/*, /health, /ready routes
app.use(apiApp);

// 2. Frontend delivery: Vite middleware in dev or static dist in production
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
      // Guard: Never serve HTML for /api, /health, or /ready routes
      if (req.path.startsWith('/api') || req.path === '/health' || req.path === '/ready') {
        return res.status(404).json({ success: false, error: `Route not found: ${req.path}` });
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    Logger.info('PAPER', 'INFO', `🚀 Binance 2m Scanner & Auto Trader listening on http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown handling
  const handleShutdown = (signal: string) => {
    Logger.info('PAPER', 'SYSTEM', `Received ${signal}. Shutting down server and trading scheduler gracefully...`);
    AutoTradingEngine.getInstance().stopScheduler();
    server.close(() => {
      Logger.info('PAPER', 'SYSTEM', 'HTTP server closed. Exiting process.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

startServer().catch(err => {
  console.error('Fatal server start error:', err);
});
