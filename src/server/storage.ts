import fs from 'node:fs';
import path from 'node:path';
import {
  TradingMode,
  TradingAccount,
  Position,
  Order,
  Trade,
  WalletBalance,
  TradingSettings,
  TechnicalAnalysis,
  ScannerSummary,
} from '../types/index.ts';
import { EncryptedPayload, encryptSecret, decryptSecret, maskApiKey } from './security.ts';
import { Logger } from './logger.ts';
import { AuditLogger } from './audit-logger.ts';

function resolveDataDir(): string {
  let envDir = process.env.DATA_DIR?.trim();
  if (envDir && envDir.startsWith('=')) {
    envDir = envDir.substring(1).trim();
  }
  const dir = envDir && envDir.length > 0 ? path.resolve(process.cwd(), envDir) : path.resolve(process.cwd(), '.data');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    const fallback = path.resolve(process.cwd(), '.data');
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }
}

const DATA_DIR = resolveDataDir();
const DB_FILE = path.join(DATA_DIR, 'database.json');

export interface DatabaseSchema {
  version: number;
  emergencyStopActive: boolean;
  realModeConfirmed: boolean;
  settings: TradingSettings;
  accounts: Record<string, TradingAccount>;
  credentials: Record<string, { apiKey: string; secretPayload: EncryptedPayload }>;
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  paperWallet: WalletBalance;
  realWallet: WalletBalance;
  latestAnalysis: Record<string, TechnicalAnalysis>;
  symbolCooldowns: Record<string, { symbol: string; mode: TradingMode; until: number }>;
  idempotencyKeys: Record<string, { orderId: string; clientOrderId: string; timestamp: number }>;
  scannerSummary: ScannerSummary;
}

const DEFAULT_SETTINGS: TradingSettings = {
  mode: 'PAPER',
  autoTrading: false,
  fixedTradeAmount: Number(process.env.DEFAULT_FIXED_TRADE_AMOUNT) || 100,
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS) || 5,
  minimumUsdtReserve: Number(process.env.MIN_USDT_RESERVE) || 100,
  symbolCooldownMinutes: Number(process.env.SYMBOL_COOLDOWN_MINUTES) || 30,
  preBullishScoreMin: Number(process.env.PRE_BULLISH_SCORE_MIN) || 65,
  strongBullishScoreMin: Number(process.env.STRONG_BULLISH_SCORE_MIN) || 80,
  weakeningThreshold: Number(process.env.WEAKENING_THRESHOLD) || 70,
  maxTradeAmount: Number(process.env.MAX_TRADE_AMOUNT) || 1000,
  paperStartingBalance: Number(process.env.PAPER_STARTING_BALANCE) || 1000,
  paperFeeRate: Number(process.env.PAPER_FEE_RATE) || 0.001,
  paperSlippageBps: Number(process.env.PAPER_SLIPPAGE_BPS) || 5,
  manageExistingHoldings: false,
  resumeOnRestart: false,
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS) || 300000, // 5 minutes authoritative
};

function createInitialPaperWallet(startingBalance = 1000): WalletBalance {
  return {
    mode: 'PAPER',
    usdtAvailable: startingBalance,
    usdtLocked: 0,
    usdtTotal: startingBalance,
    accountAssetValue: 0,
    totalEquity: startingBalance,
    startingBalance: startingBalance,
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalFeesPaid: 0,
    assets: [],
    lastReconciledAt: Date.now(),
    reconciliationStatus: 'OK',
  };
}

function createInitialRealWallet(): WalletBalance {
  return {
    mode: 'REAL',
    usdtAvailable: 0,
    usdtLocked: 0,
    usdtTotal: 0,
    accountAssetValue: 0,
    totalEquity: 0,
    startingBalance: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalFeesPaid: 0,
    assets: [],
    lastReconciledAt: Date.now(),
    reconciliationStatus: 'OK',
  };
}

function getInitialDb(): DatabaseSchema {
  const paperAccId = 'paper-default';
  const realAccId = 'real-default';

  return {
    version: 2,
    emergencyStopActive: false,
    realModeConfirmed: false,
    settings: { ...DEFAULT_SETTINGS },
    accounts: {
      [paperAccId]: {
        id: paperAccId,
        name: 'Paper Trading Account',
        mode: 'PAPER',
        autoTrading: false,
        resumeOnRestart: false,
        hasApiKeys: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      [realAccId]: {
        id: realAccId,
        name: 'Binance Spot Live Account',
        mode: 'REAL',
        autoTrading: false,
        resumeOnRestart: false,
        hasApiKeys: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
    credentials: {},
    positions: [],
    orders: [],
    trades: [],
    paperWallet: createInitialPaperWallet(DEFAULT_SETTINGS.paperStartingBalance),
    realWallet: createInitialRealWallet(),
    latestAnalysis: {},
    symbolCooldowns: {},
    idempotencyKeys: {},
    scannerSummary: {
      pairsAnalyzed: 0,
      preBullishCount: 0,
      bullishCount: 0,
      strongBullishCount: 0,
      weakeningCount: 0,
      neutralCount: 0,
      openPositionsCount: 0,
      todayTradesCount: 0,
      lastScanTime: 0,
      nextScanTime: Date.now() + DEFAULT_SETTINGS.scanIntervalMs,
      isScanning: false,
    },
  };
}

class StorageEngine {
  private db: DatabaseSchema;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.db = this.loadDb();
  }

  private loadDb(): DatabaseSchema {
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        
        const mergedSettings = {
          ...DEFAULT_SETTINGS,
          ...(parsed.settings || {}),
        };

        const initial = getInitialDb();
        const loadedDb: DatabaseSchema = {
          ...initial,
          ...parsed,
          emergencyStopActive: Boolean(parsed.emergencyStopActive),
          realModeConfirmed: Boolean(parsed.realModeConfirmed),
          settings: mergedSettings,
          accounts: {
            ...initial.accounts,
            ...(parsed.accounts || {}),
          },
          idempotencyKeys: parsed.idempotencyKeys || {},
        };

        // --- PRODUCTION FAIL-CLOSED RESTARTS ---
        // 1. If resumeOnRestart is false, ensure autoTrading is explicitly disabled after restart
        if (!mergedSettings.resumeOnRestart) {
          loadedDb.settings.autoTrading = false;
          Object.values(loadedDb.accounts).forEach(acc => {
            acc.autoTrading = false;
          });
          Logger.info('PAPER', 'SECURITY', 'resumeOnRestart is FALSE: Auto-trading disabled on startup.');
        }

        // 2. If Emergency Stop was active before shutdown, keep it locked and autoTrading OFF
        if (loadedDb.emergencyStopActive) {
          loadedDb.settings.autoTrading = false;
          Object.values(loadedDb.accounts).forEach(acc => {
            acc.autoTrading = false;
          });
          Logger.warn('PAPER', 'SECURITY', 'EMERGENCY STOP is ACTIVE from persistent storage. Auto-trading remains locked.');
        }

        return loadedDb;
      } catch (err) {
        Logger.error('PAPER', 'ERROR', `Failed to load DB file, resetting to defaults: ${err}`);
      }
    }
    const init = getInitialDb();
    this.db = init;
    this.saveImmediate();
    return init;
  }

  private saveImmediate(): void {
    try {
      const tempPath = `${DB_FILE}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.db, null, 2), { mode: 0o600 });
      fs.renameSync(tempPath, DB_FILE);
    } catch (err) {
      Logger.error('PAPER', 'ERROR', `Failed to write DB file: ${err}`);
    }
  }

  private save(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveImmediate();
      this.saveTimeout = null;
    }, 100);
  }

  // --- Emergency Stop Persistence ---
  public isEmergencyStopActive(): boolean {
    return Boolean(this.db.emergencyStopActive);
  }

  public setEmergencyStop(active: boolean): void {
    this.db.emergencyStopActive = active;
    if (active) {
      this.db.settings.autoTrading = false;
      Object.values(this.db.accounts).forEach(acc => {
        acc.autoTrading = false;
      });
      AuditLogger.log({
        eventType: 'EMERGENCY_STOP',
        mode: this.db.settings.mode,
        reason: 'Emergency stop activated. All automated buying locked.',
      });
    } else {
      AuditLogger.log({
        eventType: 'EMERGENCY_RESET',
        mode: this.db.settings.mode,
        reason: 'Emergency stop reset by authenticated user.',
      });
    }
    this.saveImmediate();
  }

  // --- Real Mode Confirmation ---
  public isRealModeConfirmed(): boolean {
    return Boolean(this.db.realModeConfirmed);
  }

  public setRealModeConfirmed(confirmed: boolean): void {
    this.db.realModeConfirmed = confirmed;
    if (confirmed) {
      AuditLogger.log({
        eventType: 'REAL_MODE_CONFIRMED',
        mode: 'REAL',
        reason: 'Real mode disclaimer explicitly confirmed with verified phrase.',
      });
    }
    this.save();
  }

  // --- Idempotency & Duplicate Prevention ---
  public hasIdempotencyKey(key: string): boolean {
    const entry = this.db.idempotencyKeys[key];
    if (!entry) return false;
    // Expire keys older than 24 hours
    if (Date.now() - entry.timestamp > 24 * 60 * 60 * 1000) {
      delete this.db.idempotencyKeys[key];
      return false;
    }
    return true;
  }

  public recordIdempotencyKey(key: string, orderId: string, clientOrderId: string): void {
    this.db.idempotencyKeys[key] = {
      orderId,
      clientOrderId,
      timestamp: Date.now(),
    };
    this.save();
  }

  // --- Settings ---
  public getSettings(): TradingSettings {
    return { ...this.db.settings };
  }

  public updateSettings(updates: Partial<TradingSettings>): TradingSettings {
    const prevMode = this.db.settings.mode;
    const prevAuto = this.db.settings.autoTrading;

    // Reject real mode if not confirmed
    if (updates.mode === 'REAL' && !this.db.realModeConfirmed) {
      throw new Error('Cannot switch to REAL mode without prior server-side confirmation (phrase verification required).');
    }

    // Reject auto trading start if emergency stop is active
    if (updates.autoTrading && this.db.emergencyStopActive) {
      throw new Error('Cannot enable auto-trading while Emergency Stop is active. Reset Emergency Stop first.');
    }

    this.db.settings = {
      ...this.db.settings,
      ...updates,
    };

    if (updates.mode !== undefined && updates.mode !== prevMode) {
      AuditLogger.log({
        eventType: updates.mode === 'REAL' ? 'REAL_MODE_ENABLED' : 'REAL_MODE_DISABLED',
        mode: updates.mode,
        reason: `Trading mode switched from ${prevMode} to ${updates.mode}.`,
      });
    }

    if (updates.autoTrading !== undefined && updates.autoTrading !== prevAuto) {
      AuditLogger.log({
        eventType: updates.autoTrading ? 'TRADING_STARTED' : 'TRADING_STOPPED',
        mode: this.db.settings.mode,
        reason: `Auto trading ${updates.autoTrading ? 'started' : 'stopped'}.`,
      });
    }

    AuditLogger.log({
      eventType: 'SETTINGS_UPDATED',
      mode: this.db.settings.mode,
      details: updates as Record<string, unknown>,
    });

    this.save();
    return this.getSettings();
  }

  // --- Accounts & Credentials ---
  public getAccount(id: string): TradingAccount | undefined {
    return this.db.accounts[id];
  }

  public getAccounts(): TradingAccount[] {
    return Object.values(this.db.accounts);
  }

  public saveAccount(acc: TradingAccount): void {
    this.db.accounts[acc.id] = { ...acc, updatedAt: Date.now() };
    this.save();
  }

  public saveBinanceCredentials(accountId: string, apiKey: string, secret: string, permissions?: TradingAccount['permissions']): void {
    const payload = encryptSecret(secret);
    this.db.credentials[accountId] = {
      apiKey,
      secretPayload: payload,
    };

    const acc = this.db.accounts[accountId] || {
      id: accountId,
      name: 'Binance Spot Live Account',
      mode: 'REAL',
      autoTrading: false,
      resumeOnRestart: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hasApiKeys: true,
    };

    acc.hasApiKeys = true;
    acc.apiKeyMasked = maskApiKey(apiKey);
    acc.apiSecretConfigured = true;
    acc.permissions = permissions;
    acc.updatedAt = Date.now();

    this.db.accounts[accountId] = acc;
    AuditLogger.log({
      eventType: 'CREDENTIALS_UPDATED',
      mode: 'REAL',
      account: accountId,
      reason: `Binance Spot credentials securely saved (API Key: ${acc.apiKeyMasked}).`,
    });

    this.saveImmediate();
  }

  public getDecryptedCredentials(accountId: string): { apiKey: string; apiSecret: string } | null {
    const creds = this.db.credentials[accountId];
    if (!creds) return null;
    try {
      const secret = decryptSecret(creds.secretPayload);
      return {
        apiKey: creds.apiKey,
        apiSecret: secret,
      };
    } catch (err) {
      Logger.error('REAL', 'SECURITY', `Failed to decrypt Binance credentials for account ${accountId}`);
      return null;
    }
  }

  public removeBinanceCredentials(accountId: string): void {
    delete this.db.credentials[accountId];
    if (this.db.accounts[accountId]) {
      this.db.accounts[accountId].hasApiKeys = false;
      this.db.accounts[accountId].apiKeyMasked = undefined;
      this.db.accounts[accountId].apiSecretConfigured = false;
      this.db.accounts[accountId].autoTrading = false;
      this.db.accounts[accountId].permissions = undefined;
    }
    AuditLogger.log({
      eventType: 'CREDENTIALS_REMOVED',
      mode: 'REAL',
      account: accountId,
      reason: 'Binance credentials removed from secure storage.',
    });
    this.saveImmediate();
  }

  // --- Wallets ---
  public getWallet(mode: TradingMode): WalletBalance {
    return mode === 'PAPER' ? { ...this.db.paperWallet } : { ...this.db.realWallet };
  }

  public updateWallet(mode: TradingMode, updates: Partial<WalletBalance>): WalletBalance {
    if (mode === 'PAPER') {
      this.db.paperWallet = {
        ...this.db.paperWallet,
        ...updates,
        lastReconciledAt: Date.now(),
      };
      this.save();
      return { ...this.db.paperWallet };
    } else {
      this.db.realWallet = {
        ...this.db.realWallet,
        ...updates,
        lastReconciledAt: Date.now(),
      };
      this.save();
      return { ...this.db.realWallet };
    }
  }

  public resetPaperAccount(): void {
    const starting = this.db.settings.paperStartingBalance || 1000;
    this.db.paperWallet = createInitialPaperWallet(starting);
    // Remove all paper positions, orders, trades
    this.db.positions = this.db.positions.filter(p => p.mode !== 'PAPER');
    this.db.orders = this.db.orders.filter(o => o.mode !== 'PAPER');
    this.db.trades = this.db.trades.filter(t => t.mode !== 'PAPER');
    // Clear paper cooldowns
    Object.keys(this.db.symbolCooldowns).forEach(k => {
      if (this.db.symbolCooldowns[k].mode === 'PAPER') {
        delete this.db.symbolCooldowns[k];
      }
    });
    this.db.scannerSummary.openPositionsCount = this.getPositions('PAPER', 'OPEN').length;

    AuditLogger.log({
      eventType: 'ACCOUNT_RESET',
      mode: 'PAPER',
      reason: `Paper account reset to starting balance of ${starting} USDT.`,
    });

    this.saveImmediate();
    Logger.info('PAPER', 'WALLET', `Paper account successfully reset: all active positions closed, wallet balance restored to default ${starting} USDT.`);
  }

  // --- Positions ---
  public getPositions(mode?: TradingMode, status?: Position['status']): Position[] {
    let list = this.db.positions;
    if (mode) {
      list = list.filter(p => p.mode === mode);
    }
    if (status) {
      list = list.filter(p => p.status === status);
    }
    return list;
  }

  public getOpenPositionForSymbol(symbol: string, mode: TradingMode): Position | undefined {
    return this.db.positions.find(p => p.symbol === symbol && p.mode === mode && p.status === 'OPEN');
  }

  public getPositionById(id: string): Position | undefined {
    return this.db.positions.find(p => p.id === id);
  }

  public savePosition(position: Position): void {
    const idx = this.db.positions.findIndex(p => p.id === position.id);
    if (idx >= 0) {
      this.db.positions[idx] = { ...position, updatedAt: Date.now() };
    } else {
      this.db.positions.push({ ...position, updatedAt: Date.now() });
    }
    this.save();
  }

  // --- Orders ---
  public getOrders(mode?: TradingMode, symbol?: string): Order[] {
    let list = this.db.orders;
    if (mode) {
      list = list.filter(o => o.mode === mode);
    }
    if (symbol) {
      list = list.filter(o => o.symbol === symbol);
    }
    return list.slice().reverse();
  }

  public getOrderById(id: string): Order | undefined {
    return this.db.orders.find(o => o.id === id || o.clientOrderId === id);
  }

  public saveOrder(order: Order): void {
    const idx = this.db.orders.findIndex(o => o.id === order.id || o.clientOrderId === order.clientOrderId);
    if (idx >= 0) {
      this.db.orders[idx] = { ...order, updatedAt: Date.now() };
    } else {
      this.db.orders.push({ ...order, updatedAt: Date.now() });
    }
    this.save();
  }

  // --- Trades ---
  public getTrades(mode?: TradingMode, symbol?: string): Trade[] {
    let list = this.db.trades;
    if (mode) {
      list = list.filter(t => t.mode === mode);
    }
    if (symbol) {
      list = list.filter(o => o.symbol === symbol);
    }
    return list.slice().reverse();
  }

  public saveTrade(trade: Trade): void {
    const idx = this.db.trades.findIndex(t => t.id === trade.id);
    if (idx >= 0) {
      this.db.trades[idx] = trade;
    } else {
      this.db.trades.push(trade);
    }
    this.save();
  }

  // --- Cooldowns ---
  public setSymbolCooldown(symbol: string, mode: TradingMode, minutes: number): void {
    const key = `${mode}_${symbol}`;
    this.db.symbolCooldowns[key] = {
      symbol,
      mode,
      until: Date.now() + minutes * 60 * 1000,
    };
    this.save();
  }

  public isSymbolInCooldown(symbol: string, mode: TradingMode): { inCooldown: boolean; remainingMinutes: number } {
    const key = `${mode}_${symbol}`;
    const cd = this.db.symbolCooldowns[key];
    if (!cd) return { inCooldown: false, remainingMinutes: 0 };
    const diff = cd.until - Date.now();
    if (diff > 0) {
      return { inCooldown: true, remainingMinutes: Math.ceil(diff / (60 * 1000)) };
    }
    delete this.db.symbolCooldowns[key];
    return { inCooldown: false, remainingMinutes: 0 };
  }

  // --- Analysis & Scanner ---
  public saveAnalysis(symbol: string, analysis: TechnicalAnalysis): void {
    this.db.latestAnalysis[symbol] = analysis;
  }

  public getAnalysis(symbol: string): TechnicalAnalysis | undefined {
    return this.db.latestAnalysis[symbol];
  }

  public getAllAnalysis(): TechnicalAnalysis[] {
    return Object.values(this.db.latestAnalysis);
  }

  public getScannerSummary(): ScannerSummary {
    return { ...this.db.scannerSummary };
  }

  public updateScannerSummary(updates: Partial<ScannerSummary>): void {
    this.db.scannerSummary = {
      ...this.db.scannerSummary,
      ...updates,
    };
    this.save();
  }
}

export const Storage = new StorageEngine();
