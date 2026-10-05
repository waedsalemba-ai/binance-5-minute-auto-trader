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

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), '.data');

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error(`Error creating DATA_DIR at ${DATA_DIR}:`, err);
  }
}

export const DB_FILE = path.join(DATA_DIR, 'database.json');

export interface DatabaseSchema {
  version: number;
  settings: TradingSettings;
  isEmergencyStopped: boolean;
  accounts: Record<string, TradingAccount>;
  credentials: Record<string, { apiKey: string; secretPayload: EncryptedPayload }>;
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  paperWallet: WalletBalance;
  realWallet: WalletBalance;
  latestAnalysis: Record<string, TechnicalAnalysis>;
  symbolCooldowns: Record<string, { symbol: string; mode: TradingMode; until: number }>;
  scannerSummary: ScannerSummary;
  lastPersistedAt?: number;
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
  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS) || 120000,
  takeProfitPercent: Number(process.env.TAKE_PROFIT_PERCENT) || 2.0,
  stopLossPercent: Number(process.env.STOP_LOSS_PERCENT) || 3.0,
  minProfitForTechnicalExitPercent: Number(process.env.MIN_PROFIT_TO_TECHNICAL_EXIT_PERCENT) || 0.20,
  maxExitPriceAgeMs: Number(process.env.MAX_EXIT_PRICE_AGE_MS) || 5000,
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
    settings: { ...DEFAULT_SETTINGS },
    isEmergencyStopped: false,
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
    lastPersistedAt: Date.now(),
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
        // Ensure defaults merge and migrate schema version
        const mergedSettings: TradingSettings = {
          ...DEFAULT_SETTINGS,
          ...(parsed.settings || {}),
          takeProfitPercent: Number(parsed.settings?.takeProfitPercent ?? DEFAULT_SETTINGS.takeProfitPercent),
          stopLossPercent: Number(parsed.settings?.stopLossPercent ?? DEFAULT_SETTINGS.stopLossPercent),
          minProfitForTechnicalExitPercent: Number(parsed.settings?.minProfitForTechnicalExitPercent ?? DEFAULT_SETTINGS.minProfitForTechnicalExitPercent),
          maxExitPriceAgeMs: Number(parsed.settings?.maxExitPriceAgeMs ?? DEFAULT_SETTINGS.maxExitPriceAgeMs),
        };
        if (mergedSettings.scanIntervalMs === 300000) {
          mergedSettings.scanIntervalMs = 120000;
        }

        const loadedDb: DatabaseSchema = {
          ...getInitialDb(),
          ...parsed,
          version: 2,
          settings: mergedSettings,
        };

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
      const tempPath = `${DB_FILE}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
      const serialized = JSON.stringify(this.db, null, 2);
      
      // Write and fsync temporary file to ensure disk persistence
      const fd = fs.openSync(tempPath, 'w', 0o600);
      fs.writeSync(fd, serialized, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      // Atomic rename replaces target database file safely
      fs.renameSync(tempPath, DB_FILE);
    } catch (err) {
      Logger.error('PAPER', 'ERROR', `Atomic database save error: ${err}`);
    }
  }

  public save(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveImmediate();
    }, 50);
  }

  public flush(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.saveImmediate();
  }

  public isReady(): boolean {
    return fs.existsSync(DATA_DIR) && this.db !== undefined;
  }

  public getDataDir(): string {
    return DATA_DIR;
  }

  // --- Settings ---
  public getSettings(): TradingSettings {
    return { ...this.db.settings };
  }

  public updateSettings(updates: Partial<TradingSettings>): TradingSettings {
    // Validate fixed trade amount if provided
    if (updates.fixedTradeAmount !== undefined) {
      const val = Number(updates.fixedTradeAmount);
      if (isNaN(val) || !isFinite(val) || val <= 0 || val > this.db.settings.maxTradeAmount) {
        throw new Error(`Invalid trade amount. Must be a positive number up to ${this.db.settings.maxTradeAmount} USDT.`);
      }
      this.db.settings.fixedTradeAmount = Number(val.toFixed(2));
    }

    if (updates.maxOpenPositions !== undefined) {
      const maxPos = Math.max(1, Math.min(20, Math.floor(Number(updates.maxOpenPositions))));
      this.db.settings.maxOpenPositions = maxPos;
    }

    if (updates.minimumUsdtReserve !== undefined) {
      this.db.settings.minimumUsdtReserve = Math.max(0, Number(updates.minimumUsdtReserve));
    }

    if (updates.symbolCooldownMinutes !== undefined) {
      this.db.settings.symbolCooldownMinutes = Math.max(1, Math.floor(Number(updates.symbolCooldownMinutes)));
    }

    if (updates.preBullishScoreMin !== undefined) {
      this.db.settings.preBullishScoreMin = Math.max(50, Math.min(95, Number(updates.preBullishScoreMin)));
    }

    if (updates.strongBullishScoreMin !== undefined) {
      this.db.settings.strongBullishScoreMin = Math.max(60, Math.min(100, Number(updates.strongBullishScoreMin)));
    }

    if (updates.weakeningThreshold !== undefined) {
      this.db.settings.weakeningThreshold = Math.max(40, Math.min(90, Number(updates.weakeningThreshold)));
    }

    if (updates.mode !== undefined) {
      this.db.settings.mode = updates.mode;
    }

    if (updates.autoTrading !== undefined) {
      this.db.settings.autoTrading = Boolean(updates.autoTrading);
    }

    if (updates.resumeOnRestart !== undefined) {
      this.db.settings.resumeOnRestart = Boolean(updates.resumeOnRestart);
    }

    if (updates.manageExistingHoldings !== undefined) {
      this.db.settings.manageExistingHoldings = Boolean(updates.manageExistingHoldings);
    }

    if (updates.takeProfitPercent !== undefined) {
      const tp = Number(updates.takeProfitPercent);
      if (!isNaN(tp) && tp > 0) {
        this.db.settings.takeProfitPercent = Number(tp.toFixed(2));
      }
    }

    if (updates.stopLossPercent !== undefined) {
      const sl = Number(updates.stopLossPercent);
      if (!isNaN(sl) && sl > 0) {
        this.db.settings.stopLossPercent = Number(sl.toFixed(2));
      }
    }

    if (updates.minProfitForTechnicalExitPercent !== undefined) {
      const minP = Number(updates.minProfitForTechnicalExitPercent);
      if (!isNaN(minP) && minP >= 0) {
        this.db.settings.minProfitForTechnicalExitPercent = Number(minP.toFixed(2));
      }
    }

    if (updates.maxExitPriceAgeMs !== undefined) {
      const age = Number(updates.maxExitPriceAgeMs);
      if (!isNaN(age) && age >= 1000) {
        this.db.settings.maxExitPriceAgeMs = Math.floor(age);
      }
    }

    if (updates.paperFeeRate !== undefined) {
      const fee = Number(updates.paperFeeRate);
      if (!isNaN(fee) && fee >= 0) {
        this.db.settings.paperFeeRate = fee;
      }
    }

    if (updates.paperSlippageBps !== undefined) {
      const slip = Number(updates.paperSlippageBps);
      if (!isNaN(slip) && slip >= 0) {
        this.db.settings.paperSlippageBps = slip;
      }
    }

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
    this.save();
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
    this.save();
  }

  // --- Wallets ---
  public getWallet(mode: TradingMode): WalletBalance {
    return mode === 'PAPER' ? { ...this.db.paperWallet } : { ...this.db.realWallet };
  }

  public saveWallet(wallet: WalletBalance): WalletBalance {
    return this.updateWallet(wallet.mode, wallet);
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
    this.save();
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
      list = list.filter(t => t.symbol === symbol);
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

  // --- Emergency Stop Persistence ---
  public isEmergencyStopped(): boolean {
    return Boolean(this.db.isEmergencyStopped);
  }

  public setEmergencyStopped(val: boolean): void {
    this.db.isEmergencyStopped = Boolean(val);
    this.save();
  }

  // --- Database Stats & Diagnostics ---
  public getDatabaseStats() {
    let fileSize = 0;
    let fileModifiedAt = 0;
    try {
      if (fs.existsSync(DB_FILE)) {
        const stat = fs.statSync(DB_FILE);
        fileSize = stat.size;
        fileModifiedAt = stat.mtimeMs;
      }
    } catch {
      // Ignore stat error
    }

    return {
      dataDir: DATA_DIR,
      dbFile: DB_FILE,
      fileSizeBytes: fileSize,
      fileModifiedAt,
      isReady: this.isReady(),
      positionsCount: this.db.positions.length,
      openPositionsCount: this.db.positions.filter(p => p.status === 'OPEN').length,
      ordersCount: this.db.orders.length,
      tradesCount: this.db.trades.length,
      paperBalance: this.db.paperWallet.usdtAvailable,
      paperEquity: this.db.paperWallet.totalEquity,
      isEmergencyStopped: this.isEmergencyStopped(),
      tradingMode: this.db.settings.mode,
      autoTrading: this.db.settings.autoTrading,
      version: this.db.version,
      lastPersistedAt: this.db.lastPersistedAt || fileModifiedAt,
    };
  }

  // --- Backup & Snapshots ---
  public backupDatabase(customPath?: string): { success: boolean; backupPath: string; timestamp: number; sizeBytes: number } {
    this.flush();
    const timestamp = Date.now();
    const backupFileName = `database-backup-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}.json`;
    const targetPath = customPath || path.join(DATA_DIR, 'backups', backupFileName);

    try {
      const backupDir = path.dirname(targetPath);
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      fs.copyFileSync(DB_FILE, targetPath);
      const stat = fs.statSync(targetPath);
      Logger.info('PAPER', 'DATABASE', `Database backup successfully created at ${targetPath} (${stat.size} bytes).`);
      return {
        success: true,
        backupPath: targetPath,
        timestamp,
        sizeBytes: stat.size,
      };
    } catch (err: any) {
      Logger.error('PAPER', 'DATABASE', `Failed to create database backup: ${err.message}`);
      throw new Error(`Backup failed: ${err.message}`);
    }
  }

  // --- Cold Reboot Rehydration ---
  public reloadFromDisk(): void {
    this.db = this.loadDb();
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
