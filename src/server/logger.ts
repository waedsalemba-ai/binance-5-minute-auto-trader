import fs from 'node:fs';
import path from 'node:path';
import { LogCategory, SystemLogEntry, TradingMode, StrategyState } from '../types/index.ts';
import { sanitizeLogMessage } from './security.ts';

const MAX_MEMORY_LOGS = 1000;
const memoryLogs: SystemLogEntry[] = [];
type LogListener = (entry: SystemLogEntry) => void;
const listeners = new Set<LogListener>();

const dataDir = path.resolve(process.cwd(), '.data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const logFile = path.join(dataDir, 'app.log');

export class Logger {
  static subscribe(listener: LogListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  static getRecentLogs(limit = 200, category?: LogCategory, mode?: TradingMode): SystemLogEntry[] {
    let result = [...memoryLogs];
    if (category) {
      result = result.filter(l => l.category === category);
    }
    if (mode) {
      result = result.filter(l => l.mode === mode);
    }
    return result.slice(-limit).reverse();
  }

  static clear(): void {
    memoryLogs.length = 0;
  }

  static log(
    category: LogCategory,
    level: 'info' | 'warn' | 'error',
    mode: TradingMode,
    message: string,
    meta?: {
      symbol?: string;
      orderId?: string;
      strategyState?: StrategyState;
      technicalScore?: number;
      details?: Record<string, unknown>;
    }
  ): SystemLogEntry {
    const sanitizedMsg = sanitizeLogMessage(message);
    const entry: SystemLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      timestamp: Date.now(),
      category,
      level,
      mode,
      symbol: meta?.symbol,
      orderId: meta?.orderId,
      strategyState: meta?.strategyState,
      technicalScore: meta?.technicalScore,
      message: sanitizedMsg,
      details: meta?.details,
    };

    memoryLogs.push(entry);
    if (memoryLogs.length > MAX_MEMORY_LOGS) {
      memoryLogs.shift();
    }

    // Format console output
    const timeStr = new Date(entry.timestamp).toISOString().split('T')[1].replace('Z', '');
    const tag = `[${category}]`.padEnd(16);
    const modeTag = `[${mode}]`;
    const symbolTag = entry.symbol ? ` [${entry.symbol}]` : '';
    const scoreTag = entry.technicalScore !== undefined ? ` Score:${entry.technicalScore}` : '';
    const stateTag = entry.strategyState ? ` State:${entry.strategyState}` : '';

    const formattedConsole = `${timeStr} ${tag} ${modeTag}${symbolTag}${scoreTag}${stateTag} ${sanitizedMsg}`;

    if (level === 'error') {
      console.error(formattedConsole);
    } else if (level === 'warn') {
      console.warn(formattedConsole);
    } else {
      console.log(formattedConsole);
    }

    // Persist to file asynchronously
    try {
      fs.appendFile(logFile, JSON.stringify(entry) + '\n', () => {});
    } catch {
      // ignore file error
    }

    // Notify active SSE subscribers
    listeners.forEach(fn => {
      try {
        fn(entry);
      } catch {
        // ignore subscriber errors
      }
    });

    return entry;
  }

  static info(mode: TradingMode, category: LogCategory, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log(category, 'info', mode, message, meta);
  }

  static warn(mode: TradingMode, category: LogCategory, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log(category, 'warn', mode, message, meta);
  }

  static error(mode: TradingMode, category: LogCategory, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log(category, 'error', mode, message, meta);
  }

  static scan(message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log('SCAN', 'info', 'PAPER', message, meta);
  }

  static strategy(mode: TradingMode, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log('STRATEGY', 'info', mode, message, meta);
  }

  static order(mode: TradingMode, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log('ORDER', 'info', mode, message, meta);
  }

  static wallet(mode: TradingMode, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log('WALLET', 'info', mode, message, meta);
  }

  static reconciliation(mode: TradingMode, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log('RECONCILIATION', 'info', mode, message, meta);
  }

  static binance(mode: TradingMode, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log('BINANCE', 'info', mode, message, meta);
  }

  static security(mode: TradingMode, message: string, meta?: Parameters<typeof Logger.log>[4]) {
    return Logger.log('SECURITY', 'info', mode, message, meta);
  }
}
