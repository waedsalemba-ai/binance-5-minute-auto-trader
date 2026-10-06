import fs from 'node:fs';
import path from 'node:path';
import {
  TradingMode,
  TradingAccount,
  MarketType,
  Position,
  Order,
  Trade,
  WalletBalance,
  TradingSettings,
  TechnicalAnalysis,
  ScannerSummary,
  StrategyState,
  SymbolAuditRecord,
} from '../types/index.ts';
import { EncryptedPayload, encryptSecret, decryptSecret, maskApiKey } from './security.ts';
import { Logger } from './logger.ts';
import {
  query,
  withTransaction,
  initializePostgresSchema,
  migrateFromJsonIfPresent,
  checkPostgresHealth,
  sanitizeDatabaseUrl,
  openPositionTransaction,
  closePositionTransaction,
  isPostgresConnected,
  registerDatabaseReconnectHandler,
  OpenPositionParams,
  ClosePositionParams,
} from './postgres.ts';

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

export interface DatabaseMemoryCache {
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
  symbolAudits: SymbolAuditRecord[];
  scannerSummary: ScannerSummary;
  lastPersistedAt: number;
}

class PostgresStorageEngine {
  private cache: DatabaseMemoryCache;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.cache = this.createDefaultCache();
    // Register automatic rehydration callback on reconnect
    registerDatabaseReconnectHandler(async () => {
      await this.loadFromPostgres();
    });
    // Initialize PostgreSQL schema and load on boot
    this.initPromise = this.init();
  }

  private createDefaultCache(): DatabaseMemoryCache {
    const paperAccId = 'paper-default';
    const realAccId = 'real-default';

    return {
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
      symbolAudits: [],
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

  public async init(): Promise<void> {
    try {
      // 1. Initialize PostgreSQL schema
      await initializePostgresSchema();

      // 2. Perform safe one-time migration from JSON if present
      await migrateFromJsonIfPresent(DB_FILE);

      // 3. Load all persistent data from PostgreSQL into cache
      await this.loadFromPostgres();

      this.isInitialized = true;
      Logger.info('PAPER', 'DATABASE', '[DATABASE] [POSTGRES] PostgreSQL storage engine initialized and state rehydrated successfully.');
    } catch (err: any) {
      Logger.error('PAPER', 'DATABASE', `[DATABASE] [POSTGRES] Failed to initialize PostgreSQL storage engine: ${err.message}`);
      this.isInitialized = false;
      if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
        throw err;
      }
    }
  }

  public async ensureReady(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
    if (!this.isInitialized && isPostgresConnected()) {
      await this.init();
    }
  }

  public async loadFromPostgres(): Promise<void> {
    try {
      // Load Settings
      const settingsRes = await query('SELECT * FROM trading_settings WHERE id = $1', ['current']);
      if (settingsRes.rows.length > 0) {
        const row = settingsRes.rows[0];
        this.cache.settings = {
          mode: (row.mode as TradingMode) || 'PAPER',
          autoTrading: Boolean(row.auto_trading),
          fixedTradeAmount: Number(row.fixed_trade_amount) || 100,
          maxOpenPositions: Number(row.max_open_positions) || 5,
          minimumUsdtReserve: Number(row.minimum_usdt_reserve) || 100,
          symbolCooldownMinutes: Number(row.symbol_cooldown_minutes) || 30,
          preBullishScoreMin: Number(row.pre_bullish_score_min) || 65,
          strongBullishScoreMin: Number(row.strong_bullish_score_min) || 80,
          weakeningThreshold: Number(row.weakening_threshold) || 70,
          maxTradeAmount: Number(row.max_trade_amount) || 1000,
          paperStartingBalance: Number(row.paper_starting_balance) || 1000,
          paperFeeRate: Number(row.paper_fee_rate) || 0.001,
          paperSlippageBps: Number(row.paper_slippage_bps) || 5,
          manageExistingHoldings: Boolean(row.manage_existing_holdings),
          resumeOnRestart: Boolean(row.resume_on_restart),
          scanIntervalMs: Number(row.scan_interval_ms) || 120000,
          takeProfitPercent: Number(row.take_profit_percent) || 2.0,
          stopLossPercent: Number(row.stop_loss_percent) || 3.0,
          minProfitForTechnicalExitPercent: Number(row.min_profit_for_technical_exit_percent) || 0.20,
          maxExitPriceAgeMs: Number(row.max_exit_price_age_ms) || 5000,
        };
      }

      // Load System State (Emergency Stop)
      const stopRes = await query('SELECT value FROM system_state WHERE key = $1', ['emergency_stop']);
      if (stopRes.rows.length > 0) {
        const val = typeof stopRes.rows[0].value === 'string'
          ? JSON.parse(stopRes.rows[0].value)
          : stopRes.rows[0].value;
        this.cache.isEmergencyStopped = Boolean(val?.isEmergencyStopped);
      }

      // Load Wallets
      const walletsRes = await query('SELECT * FROM wallets');
      for (const row of walletsRes.rows) {
        const walletObj: WalletBalance = {
          mode: row.mode as TradingMode,
          usdtAvailable: Number(row.usdt_available),
          usdtLocked: Number(row.usdt_locked || 0),
          usdtTotal: Number(row.usdt_total),
          accountAssetValue: Number(row.account_asset_value || 0),
          totalEquity: Number(row.total_equity),
          startingBalance: Number(row.starting_balance),
          realizedPnL: Number(row.realized_pnl || 0),
          unrealizedPnL: Number(row.unrealized_pnl || 0),
          totalFeesPaid: Number(row.total_fees_paid || 0),
          assets: typeof row.assets === 'string' ? JSON.parse(row.assets) : row.assets || [],
          lastReconciledAt: Number(row.last_reconciled_at || Date.now()),
          reconciliationStatus: row.reconciliation_status || 'OK',
        };
        if (row.mode === 'PAPER') {
          this.cache.paperWallet = walletObj;
        } else if (row.mode === 'REAL') {
          this.cache.realWallet = walletObj;
        }
      }

      // Load Positions
      const positionsRes = await query('SELECT * FROM positions ORDER BY opened_at ASC');
      this.cache.positions = positionsRes.rows.map(row => ({
        id: row.id,
        accountId: row.account_id,
        symbol: row.symbol,
        mode: row.mode as TradingMode,
        status: row.status as Position['status'],
        entryPrice: Number(row.entry_price),
        quantity: Number(row.quantity),
        remainingQuantity: Number(row.remaining_quantity ?? row.quantity),
        entryQuoteAmount: Number(row.entry_quote_amount),
        entryFees: Number(row.entry_fees || 0),
        entryScore: Number(row.entry_score || 0),
        entryState: row.entry_state,
        entryReason: row.entry_reason,
        currentPrice: Number(row.current_price),
        currentScore: Number(row.current_score || 0),
        currentState: row.current_state,
        grossPnL: Number(row.gross_pnl || 0),
        unrealizedPnL: Number(row.unrealized_pnl || 0),
        unrealizedPnLPercent: Number(row.unrealized_pnl_percent || 0),
        estimatedNetPnL: Number(row.estimated_net_pnl || 0),
        estimatedNetPnLPercent: Number(row.estimated_net_pnl_percent || 0),
        breakEvenPrice: Number(row.break_even_price),
        takeProfitPrice: Number(row.take_profit_price),
        stopLossPrice: Number(row.stop_loss_price),
        openedAt: Number(row.opened_at),
        updatedAt: Number(row.updated_at),
        entryOrderId: row.entry_order_id || '',
        exitOrderId: row.exit_order_id || undefined,
        exitReason: row.exit_reason || undefined,
      }));

      // Load Orders
      const ordersRes = await query('SELECT * FROM orders ORDER BY created_at ASC');
      this.cache.orders = ordersRes.rows.map(row => ({
        id: row.id,
        clientOrderId: row.client_order_id,
        binanceOrderId: row.binance_order_id || undefined,
        accountId: row.account_id,
        mode: row.mode as TradingMode,
        symbol: row.symbol,
        side: row.side as Order['side'],
        status: row.status as Order['status'],
        requestedQuoteAmount: Number(row.requested_quote_amount || 0),
        executedQuantity: Number(row.executed_quantity || 0),
        executedQuoteAmount: Number(row.executed_quote_amount || 0),
        executionPrice: Number(row.execution_price || 0),
        fee: Number(row.fee || 0),
        feeAsset: row.fee_asset || 'USDT',
        reason: row.reason || '',
        strategyState: (row.strategy_state as StrategyState) || 'STRONG_BULLISH',
        technicalScore: Number(row.technical_score || 0),
        fills: typeof row.fills === 'string' ? JSON.parse(row.fills) : row.fills || [],
        errorMessage: row.error_message || undefined,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
      }));

      // Load Trades
      const tradesRes = await query('SELECT * FROM trades ORDER BY closed_at ASC');
      this.cache.trades = tradesRes.rows.map(row => ({
        id: row.id,
        accountId: row.account_id,
        entryOrderId: row.entry_order_id || '',
        exitOrderId: row.exit_order_id || '',
        symbol: row.symbol,
        mode: row.mode as TradingMode,
        entryPrice: Number(row.entry_price),
        exitPrice: Number(row.exit_price),
        quantity: Number(row.quantity),
        entryQuoteAmount: Number(row.entry_quote_amount),
        exitQuoteAmount: Number(row.exit_quote_amount),
        entryFees: Number(row.entry_fees || 0),
        exitFees: Number(row.exit_fees || 0),
        grossPnL: Number(row.gross_pnl || 0),
        netPnL: Number(row.net_pnl || 0),
        netPnLPercent: Number(row.net_pnl_percent || 0),
        entryScore: Number(row.entry_score || 0),
        exitScore: Number(row.exit_score || 0),
        entryReason: row.entry_reason || '',
        exitReason: row.exit_reason || '',
        openedAt: Number(row.opened_at),
        closedAt: Number(row.closed_at),
        durationMs: Number(row.duration_ms || 0),
      }));

      // Load Accounts
      const accountsRes = await query('SELECT * FROM accounts');
      for (const row of accountsRes.rows) {
        this.cache.accounts[row.id] = {
          id: row.id,
          name: row.name,
          mode: row.mode as TradingMode,
          autoTrading: Boolean(row.auto_trading),
          resumeOnRestart: Boolean(row.resume_on_restart),
          hasApiKeys: Boolean(row.has_api_keys),
          apiKeyMasked: row.api_key_masked || undefined,
          apiSecretConfigured: Boolean(row.api_secret_configured),
          permissions: typeof row.permissions === 'string' ? JSON.parse(row.permissions) : row.permissions || undefined,
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        };
      }

      // Load Credentials
      const credsRes = await query('SELECT * FROM credentials');
      for (const row of credsRes.rows) {
        this.cache.credentials[row.account_id] = {
          apiKey: row.api_key,
          secretPayload: {
            iv: row.secret_iv,
            tag: row.secret_tag,
            data: row.secret_data,
          },
        };
      }

      // Load Symbol Cooldowns
      const cdRes = await query('SELECT * FROM symbol_cooldowns');
      this.cache.symbolCooldowns = {};
      const now = Date.now();
      for (const row of cdRes.rows) {
        const until = Number(row.until_timestamp);
        if (until > now) {
          this.cache.symbolCooldowns[row.key] = {
            symbol: row.symbol,
            mode: row.mode as TradingMode,
            until,
          };
        }
      }

      // Load Symbol Audit Records (most recent 200)
      try {
        const auditRes = await query('SELECT * FROM symbol_audit_records ORDER BY timestamp DESC LIMIT 200');
        this.cache.symbolAudits = auditRes.rows.map(row => ({
          id: row.id,
          timestamp: Number(row.timestamp),
          requestedSymbol: row.requested_symbol,
          normalizedSymbol: row.normalized_symbol,
          market: row.market as MarketType,
          side: row.side as Order['side'],
          validationResult: Boolean(row.validation_result),
          binanceStatus: row.binance_status || null,
          mappingApplied: Boolean(row.mapping_applied),
          rejectionReason: row.rejection_reason || null,
          orderId: row.order_id || undefined,
        }));
      } catch {
        this.cache.symbolAudits = [];
      }

      this.cache.scannerSummary.openPositionsCount = this.cache.positions.filter(p => p.status === 'OPEN').length;
      this.cache.lastPersistedAt = Date.now();
    } catch (err: any) {
      Logger.error('PAPER', 'DATABASE', `Error loading state from PostgreSQL: ${err.message}`);
      throw err;
    }
  }

  // --- Health & Readiness ---
  public isReady(): boolean {
    return this.isInitialized && isPostgresConnected();
  }

  public async isDatabaseReadyAsync(): Promise<boolean> {
    const health = await checkPostgresHealth();
    return health.isConnected && this.isInitialized;
  }

  public getDataDir(): string {
    return DATA_DIR;
  }

  public flush(): void {
    // No-op for file disk flush; all updates write synchronously to PostgreSQL
    this.cache.lastPersistedAt = Date.now();
  }

  // --- Settings ---
  public getSettings(): TradingSettings {
    return { ...this.cache.settings };
  }

  public updateSettings(updates: Partial<TradingSettings>): TradingSettings {
    if (updates.fixedTradeAmount !== undefined) {
      const val = Number(updates.fixedTradeAmount);
      if (isNaN(val) || !isFinite(val) || val <= 0 || val > this.cache.settings.maxTradeAmount) {
        throw new Error(`Invalid trade amount. Must be a positive number up to ${this.cache.settings.maxTradeAmount} USDT.`);
      }
      this.cache.settings.fixedTradeAmount = Number(val.toFixed(2));
    }

    if (updates.maxOpenPositions !== undefined) {
      const maxPos = Math.max(1, Math.min(20, Math.floor(Number(updates.maxOpenPositions))));
      this.cache.settings.maxOpenPositions = maxPos;
    }

    if (updates.minimumUsdtReserve !== undefined) {
      this.cache.settings.minimumUsdtReserve = Math.max(0, Number(updates.minimumUsdtReserve));
    }

    if (updates.symbolCooldownMinutes !== undefined) {
      this.cache.settings.symbolCooldownMinutes = Math.max(1, Math.floor(Number(updates.symbolCooldownMinutes)));
    }

    if (updates.preBullishScoreMin !== undefined) {
      this.cache.settings.preBullishScoreMin = Math.max(50, Math.min(95, Number(updates.preBullishScoreMin)));
    }

    if (updates.strongBullishScoreMin !== undefined) {
      this.cache.settings.strongBullishScoreMin = Math.max(60, Math.min(100, Number(updates.strongBullishScoreMin)));
    }

    if (updates.weakeningThreshold !== undefined) {
      this.cache.settings.weakeningThreshold = Math.max(40, Math.min(90, Number(updates.weakeningThreshold)));
    }

    if (updates.mode !== undefined) {
      this.cache.settings.mode = updates.mode;
    }

    if (updates.autoTrading !== undefined) {
      this.cache.settings.autoTrading = Boolean(updates.autoTrading);
    }

    if (updates.resumeOnRestart !== undefined) {
      this.cache.settings.resumeOnRestart = Boolean(updates.resumeOnRestart);
    }

    if (updates.manageExistingHoldings !== undefined) {
      this.cache.settings.manageExistingHoldings = Boolean(updates.manageExistingHoldings);
    }

    if (updates.takeProfitPercent !== undefined) {
      const tp = Number(updates.takeProfitPercent);
      if (!isNaN(tp) && tp > 0) {
        this.cache.settings.takeProfitPercent = Number(tp.toFixed(2));
      }
    }

    if (updates.stopLossPercent !== undefined) {
      const sl = Number(updates.stopLossPercent);
      if (!isNaN(sl) && sl > 0) {
        this.cache.settings.stopLossPercent = Number(sl.toFixed(2));
      }
    }

    if (updates.minProfitForTechnicalExitPercent !== undefined) {
      const minP = Number(updates.minProfitForTechnicalExitPercent);
      if (!isNaN(minP) && minP >= 0) {
        this.cache.settings.minProfitForTechnicalExitPercent = Number(minP.toFixed(2));
      }
    }

    if (updates.maxExitPriceAgeMs !== undefined) {
      const age = Number(updates.maxExitPriceAgeMs);
      if (!isNaN(age) && age >= 1000) {
        this.cache.settings.maxExitPriceAgeMs = Math.floor(age);
      }
    }

    if (updates.paperFeeRate !== undefined) {
      const fee = Number(updates.paperFeeRate);
      if (!isNaN(fee) && fee >= 0) {
        this.cache.settings.paperFeeRate = fee;
      }
    }

    if (updates.paperSlippageBps !== undefined) {
      const slip = Number(updates.paperSlippageBps);
      if (!isNaN(slip) && slip >= 0) {
        this.cache.settings.paperSlippageBps = slip;
      }
    }

    // Persist to PostgreSQL
    const s = this.cache.settings;
    query(
      `INSERT INTO trading_settings (
        id, mode, auto_trading, fixed_trade_amount, max_open_positions,
        minimum_usdt_reserve, symbol_cooldown_minutes, pre_bullish_score_min,
        strong_bullish_score_min, weakening_threshold, max_trade_amount,
        paper_starting_balance, paper_fee_rate, paper_slippage_bps,
        manage_existing_holdings, resume_on_restart, scan_interval_ms,
        take_profit_percent, stop_loss_percent, min_profit_for_technical_exit_percent,
        max_exit_price_age_ms, updated_at
      ) VALUES (
        'current', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      ) ON CONFLICT (id) DO UPDATE SET
        mode = EXCLUDED.mode,
        auto_trading = EXCLUDED.auto_trading,
        fixed_trade_amount = EXCLUDED.fixed_trade_amount,
        max_open_positions = EXCLUDED.max_open_positions,
        minimum_usdt_reserve = EXCLUDED.minimum_usdt_reserve,
        symbol_cooldown_minutes = EXCLUDED.symbol_cooldown_minutes,
        pre_bullish_score_min = EXCLUDED.pre_bullish_score_min,
        strong_bullish_score_min = EXCLUDED.strong_bullish_score_min,
        weakening_threshold = EXCLUDED.weakening_threshold,
        take_profit_percent = EXCLUDED.take_profit_percent,
        stop_loss_percent = EXCLUDED.stop_loss_percent,
        min_profit_for_technical_exit_percent = EXCLUDED.min_profit_for_technical_exit_percent,
        updated_at = EXCLUDED.updated_at`,
      [
        s.mode,
        s.autoTrading,
        s.fixedTradeAmount,
        s.maxOpenPositions,
        s.minimumUsdtReserve,
        s.symbolCooldownMinutes,
        s.preBullishScoreMin,
        s.strongBullishScoreMin,
        s.weakeningThreshold,
        s.maxTradeAmount,
        s.paperStartingBalance,
        s.paperFeeRate,
        s.paperSlippageBps,
        s.manageExistingHoldings,
        s.resumeOnRestart,
        s.scanIntervalMs,
        s.takeProfitPercent,
        s.stopLossPercent,
        s.minProfitForTechnicalExitPercent,
        s.maxExitPriceAgeMs,
        Date.now(),
      ]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist settings to PostgreSQL: ${err.message}`);
    });

    return this.getSettings();
  }

  // --- Accounts & Credentials ---
  public getAccount(id: string): TradingAccount | undefined {
    return this.cache.accounts[id];
  }

  public getAccounts(): TradingAccount[] {
    return Object.values(this.cache.accounts);
  }

  public saveAccount(acc: TradingAccount): void {
    const updated = { ...acc, updatedAt: Date.now() };
    this.cache.accounts[acc.id] = updated;

    query(
      `INSERT INTO accounts (
        id, name, mode, auto_trading, resume_on_restart, has_api_keys,
        api_key_masked, api_secret_configured, permissions, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        auto_trading = EXCLUDED.auto_trading,
        has_api_keys = EXCLUDED.has_api_keys,
        api_key_masked = EXCLUDED.api_key_masked,
        api_secret_configured = EXCLUDED.api_secret_configured,
        permissions = EXCLUDED.permissions,
        updated_at = EXCLUDED.updated_at`,
      [
        updated.id,
        updated.name,
        updated.mode,
        updated.autoTrading,
        updated.resumeOnRestart,
        updated.hasApiKeys,
        updated.apiKeyMasked || null,
        updated.apiSecretConfigured || false,
        JSON.stringify(updated.permissions || null),
        updated.createdAt,
        updated.updatedAt,
      ]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist account to PostgreSQL: ${err.message}`);
    });
  }

  public saveBinanceCredentials(accountId: string, apiKey: string, secret: string, permissions?: TradingAccount['permissions']): void {
    const payload = encryptSecret(secret);
    this.cache.credentials[accountId] = {
      apiKey,
      secretPayload: payload,
    };

    const acc = this.cache.accounts[accountId] || {
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

    this.cache.accounts[accountId] = acc;

    withTransaction(async (client) => {
      await client.query(
        `INSERT INTO credentials (account_id, api_key, secret_iv, secret_tag, secret_data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id) DO UPDATE SET
           api_key = EXCLUDED.api_key,
           secret_iv = EXCLUDED.secret_iv,
           secret_tag = EXCLUDED.secret_tag,
           secret_data = EXCLUDED.secret_data,
           updated_at = EXCLUDED.updated_at`,
        [accountId, apiKey, payload.iv, payload.tag, payload.data, Date.now()]
      );

      await client.query(
        `INSERT INTO accounts (
          id, name, mode, auto_trading, resume_on_restart, has_api_keys,
          api_key_masked, api_secret_configured, permissions, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          has_api_keys = EXCLUDED.has_api_keys,
          api_key_masked = EXCLUDED.api_key_masked,
          api_secret_configured = EXCLUDED.api_secret_configured,
          permissions = EXCLUDED.permissions,
          updated_at = EXCLUDED.updated_at`,
        [
          acc.id,
          acc.name,
          acc.mode,
          acc.autoTrading,
          acc.resumeOnRestart,
          acc.hasApiKeys,
          acc.apiKeyMasked || null,
          acc.apiSecretConfigured || false,
          JSON.stringify(acc.permissions || null),
          acc.createdAt,
          acc.updatedAt,
        ]
      );
    }).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist credentials to PostgreSQL: ${err.message}`);
    });
  }

  public getDecryptedCredentials(accountId: string): { apiKey: string; apiSecret: string } | null {
    const creds = this.cache.credentials[accountId];
    if (!creds) return null;
    try {
      const secret = decryptSecret(creds.secretPayload);
      return {
        apiKey: creds.apiKey,
        apiSecret: secret,
      };
    } catch {
      Logger.error('REAL', 'SECURITY', `Failed to decrypt Binance credentials for account ${accountId}`);
      return null;
    }
  }

  public removeBinanceCredentials(accountId: string): void {
    delete this.cache.credentials[accountId];
    if (this.cache.accounts[accountId]) {
      this.cache.accounts[accountId].hasApiKeys = false;
      this.cache.accounts[accountId].apiKeyMasked = undefined;
      this.cache.accounts[accountId].apiSecretConfigured = false;
      this.cache.accounts[accountId].autoTrading = false;
      this.cache.accounts[accountId].permissions = undefined;
    }

    withTransaction(async (client) => {
      await client.query('DELETE FROM credentials WHERE account_id = $1', [accountId]);
      await client.query(
        `UPDATE accounts SET
          has_api_keys = FALSE,
          api_key_masked = NULL,
          api_secret_configured = FALSE,
          auto_trading = FALSE,
          permissions = NULL,
          updated_at = $1
         WHERE id = $2`,
        [Date.now(), accountId]
      );
    }).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to remove credentials from PostgreSQL: ${err.message}`);
    });
  }

  // --- Wallets ---
  public getWallet(mode: TradingMode): WalletBalance {
    return mode === 'PAPER' ? { ...this.cache.paperWallet } : { ...this.cache.realWallet };
  }

  public saveWallet(wallet: WalletBalance): WalletBalance {
    return this.updateWallet(wallet.mode, wallet);
  }

  public updateWallet(mode: TradingMode, updates: Partial<WalletBalance>): WalletBalance {
    const target = mode === 'PAPER' ? this.cache.paperWallet : this.cache.realWallet;
    const updated: WalletBalance = {
      ...target,
      ...updates,
      lastReconciledAt: Date.now(),
    };

    if (mode === 'PAPER') {
      this.cache.paperWallet = updated;
    } else {
      this.cache.realWallet = updated;
    }

    query(
      `INSERT INTO wallets (
        mode, usdt_available, usdt_locked, usdt_total, account_asset_value,
        total_equity, starting_balance, realized_pnl, unrealized_pnl,
        total_fees_paid, assets, last_reconciled_at, reconciliation_status, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (mode) DO UPDATE SET
        usdt_available = EXCLUDED.usdt_available,
        usdt_locked = EXCLUDED.usdt_locked,
        usdt_total = EXCLUDED.usdt_total,
        account_asset_value = EXCLUDED.account_asset_value,
        total_equity = EXCLUDED.total_equity,
        realized_pnl = EXCLUDED.realized_pnl,
        unrealized_pnl = EXCLUDED.unrealized_pnl,
        total_fees_paid = EXCLUDED.total_fees_paid,
        assets = EXCLUDED.assets,
        last_reconciled_at = EXCLUDED.last_reconciled_at,
        updated_at = EXCLUDED.updated_at`,
      [
        updated.mode,
        updated.usdtAvailable,
        updated.usdtLocked,
        updated.usdtTotal,
        updated.accountAssetValue,
        updated.totalEquity,
        updated.startingBalance,
        updated.realizedPnL,
        updated.unrealizedPnL,
        updated.totalFeesPaid,
        JSON.stringify(updated.assets),
        updated.lastReconciledAt,
        updated.reconciliationStatus,
        Date.now(),
      ]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist wallet to PostgreSQL: ${err.message}`);
    });

    return updated;
  }

  public resetPaperAccount(): void {
    const starting = this.cache.settings.paperStartingBalance || 1000;
    this.cache.paperWallet = createInitialPaperWallet(starting);
    this.cache.positions = this.cache.positions.filter(p => p.mode !== 'PAPER');
    this.cache.orders = this.cache.orders.filter(o => o.mode !== 'PAPER');
    this.cache.trades = this.cache.trades.filter(t => t.mode !== 'PAPER');

    Object.keys(this.cache.symbolCooldowns).forEach(k => {
      if (this.cache.symbolCooldowns[k].mode === 'PAPER') {
        delete this.cache.symbolCooldowns[k];
      }
    });

    this.cache.scannerSummary.openPositionsCount = this.getPositions('PAPER', 'OPEN').length;

    withTransaction(async (client) => {
      await client.query('DELETE FROM positions WHERE mode = $1', ['PAPER']);
      await client.query('DELETE FROM orders WHERE mode = $1', ['PAPER']);
      await client.query('DELETE FROM trades WHERE mode = $1', ['PAPER']);
      await client.query('DELETE FROM symbol_cooldowns WHERE mode = $1', ['PAPER']);

      const pw = this.cache.paperWallet;
      await client.query(
        `INSERT INTO wallets (
          mode, usdt_available, usdt_locked, usdt_total, account_asset_value,
          total_equity, starting_balance, realized_pnl, unrealized_pnl,
          total_fees_paid, assets, last_reconciled_at, reconciliation_status, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (mode) DO UPDATE SET
          usdt_available = EXCLUDED.usdt_available,
          usdt_locked = EXCLUDED.usdt_locked,
          usdt_total = EXCLUDED.usdt_total,
          account_asset_value = EXCLUDED.account_asset_value,
          total_equity = EXCLUDED.total_equity,
          starting_balance = EXCLUDED.starting_balance,
          realized_pnl = EXCLUDED.realized_pnl,
          unrealized_pnl = EXCLUDED.unrealized_pnl,
          total_fees_paid = EXCLUDED.total_fees_paid,
          assets = EXCLUDED.assets,
          last_reconciled_at = EXCLUDED.last_reconciled_at,
          updated_at = EXCLUDED.updated_at`,
        [
          'PAPER',
          pw.usdtAvailable,
          pw.usdtLocked,
          pw.usdtTotal,
          pw.accountAssetValue,
          pw.totalEquity,
          pw.startingBalance,
          pw.realizedPnL,
          pw.unrealizedPnL,
          pw.totalFeesPaid,
          JSON.stringify(pw.assets),
          pw.lastReconciledAt,
          pw.reconciliationStatus,
          Date.now(),
        ]
      );
    }).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to reset paper account in PostgreSQL: ${err.message}`);
    });

    Logger.info('PAPER', 'WALLET', `Paper account successfully reset: all active positions closed, wallet balance restored to default ${starting} USDT.`);
  }

  // --- Clear All Saved Data ---
  public async clearAllSavedData(options?: { resetSettings?: boolean; wipeLogs?: boolean }): Promise<{
    positionsCleared: number;
    ordersCleared: number;
    tradesCleared: number;
    filesRemoved: string[];
    paperWalletReset: boolean;
  }> {
    const positionsCleared = this.cache.positions.length;
    const ordersCleared = this.cache.orders.length;
    const tradesCleared = this.cache.trades.length;

    // 1. Reset memory cache
    this.cache.positions = [];
    this.cache.orders = [];
    this.cache.trades = [];
    this.cache.symbolCooldowns = {};
    this.cache.symbolAudits = [];
    const defaultStarting = this.cache.settings.paperStartingBalance || 1000;
    this.cache.paperWallet = createInitialPaperWallet(defaultStarting);
    this.cache.realWallet = createInitialRealWallet();
    this.cache.scannerSummary.openPositionsCount = 0;
    this.cache.scannerSummary.todayTradesCount = 0;
    this.cache.latestAnalysis = {};

    if (options?.resetSettings) {
      this.cache.settings = { ...DEFAULT_SETTINGS };
    }

    // 2. Wipe database tables
    try {
      await withTransaction(async (client) => {
        await client.query('DELETE FROM positions');
        await client.query('DELETE FROM orders');
        await client.query('DELETE FROM trades');
        await client.query('DELETE FROM trade_decisions');
        await client.query('DELETE FROM symbol_audit_records').catch(() => {});
        await client.query('DELETE FROM symbol_cooldowns');
        await client.query('DELETE FROM system_state');

        if (options?.resetSettings) {
          await client.query('DELETE FROM trading_settings');
        }

        const pw = this.cache.paperWallet;
        await client.query(
          `INSERT INTO wallets (
            mode, usdt_available, usdt_locked, usdt_total, account_asset_value,
            total_equity, starting_balance, realized_pnl, unrealized_pnl,
            total_fees_paid, assets, last_reconciled_at, reconciliation_status, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (mode) DO UPDATE SET
            usdt_available = EXCLUDED.usdt_available,
            usdt_locked = EXCLUDED.usdt_locked,
            usdt_total = EXCLUDED.usdt_total,
            account_asset_value = EXCLUDED.account_asset_value,
            total_equity = EXCLUDED.total_equity,
            starting_balance = EXCLUDED.starting_balance,
            realized_pnl = EXCLUDED.realized_pnl,
            unrealized_pnl = EXCLUDED.unrealized_pnl,
            total_fees_paid = EXCLUDED.total_fees_paid,
            assets = EXCLUDED.assets,
            last_reconciled_at = EXCLUDED.last_reconciled_at,
            updated_at = EXCLUDED.updated_at`,
          [
            'PAPER',
            pw.usdtAvailable,
            pw.usdtLocked,
            pw.usdtTotal,
            pw.accountAssetValue,
            pw.totalEquity,
            pw.startingBalance,
            pw.realizedPnL,
            pw.unrealizedPnL,
            pw.totalFeesPaid,
            JSON.stringify(pw.assets),
            pw.lastReconciledAt,
            pw.reconciliationStatus,
            Date.now(),
          ]
        );

        const rw = this.cache.realWallet;
        await client.query(
          `INSERT INTO wallets (
            mode, usdt_available, usdt_locked, usdt_total, account_asset_value,
            total_equity, starting_balance, realized_pnl, unrealized_pnl,
            total_fees_paid, assets, last_reconciled_at, reconciliation_status, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (mode) DO UPDATE SET
            usdt_available = EXCLUDED.usdt_available,
            usdt_locked = EXCLUDED.usdt_locked,
            usdt_total = EXCLUDED.usdt_total,
            account_asset_value = EXCLUDED.account_asset_value,
            total_equity = EXCLUDED.total_equity,
            starting_balance = EXCLUDED.starting_balance,
            realized_pnl = EXCLUDED.realized_pnl,
            unrealized_pnl = EXCLUDED.unrealized_pnl,
            total_fees_paid = EXCLUDED.total_fees_paid,
            assets = EXCLUDED.assets,
            last_reconciled_at = EXCLUDED.last_reconciled_at,
            updated_at = EXCLUDED.updated_at`,
          [
            'REAL',
            rw.usdtAvailable,
            rw.usdtLocked,
            rw.usdtTotal,
            rw.accountAssetValue,
            rw.totalEquity,
            rw.startingBalance,
            rw.realizedPnL,
            rw.unrealizedPnL,
            rw.totalFeesPaid,
            JSON.stringify(rw.assets),
            rw.lastReconciledAt,
            rw.reconciliationStatus,
            Date.now(),
          ]
        );
      });
    } catch (err: any) {
      Logger.error('PAPER', 'DATABASE', `Error wiping database tables: ${err.message}`);
    }

    // 3. Delete disk files (migrated JSON files, backups, temporary files, logs)
    const filesRemoved: string[] = [];
    const explicitTargets = [
      DB_FILE,
      path.join(DATA_DIR, 'database.json'),
      path.resolve(process.cwd(), '.data', 'database.json'),
      path.resolve(process.cwd(), 'data', 'database.json'),
      '/data/database.json',
      path.join(DATA_DIR, 'app.log'),
      path.resolve(process.cwd(), '.data', 'app.log'),
    ];

    for (const target of explicitTargets) {
      if (fs.existsSync(target)) {
        try {
          if (fs.statSync(target).isFile()) {
            fs.unlinkSync(target);
            filesRemoved.push(target);
          }
        } catch {}
      }
    }

    const dirsToCheck = [DATA_DIR, path.resolve(process.cwd(), '.data'), path.join(DATA_DIR, 'backups')];

    for (const dir of dirsToCheck) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (
              file.endsWith('.json') ||
              file.includes('.migrated') ||
              file.endsWith('.log') ||
              file.startsWith('database-backup') ||
              file.startsWith('pg-database-backup')
            ) {
              const fullPath = path.join(dir, file);
              try {
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                  fs.unlinkSync(fullPath);
                  filesRemoved.push(fullPath);
                }
              } catch {}
            }
          }
        } catch {}
      }
    }

    Logger.info('PAPER', 'DATABASE', `All saved data deleted: ${positionsCleared} positions, ${ordersCleared} orders, ${tradesCleared} trades cleared, ${filesRemoved.length} disk files wiped.`);

    return {
      positionsCleared,
      ordersCleared,
      tradesCleared,
      filesRemoved,
      paperWalletReset: true,
    };
  }

  // --- Positions ---
  public getPositions(mode?: TradingMode, status?: Position['status']): Position[] {
    let list = this.cache.positions;
    if (mode) {
      list = list.filter(p => p.mode === mode);
    }
    if (status) {
      list = list.filter(p => p.status === status);
    }
    return list;
  }

  public getOpenPositionForSymbol(symbol: string, mode: TradingMode): Position | undefined {
    return this.cache.positions.find(p => p.symbol === symbol && p.mode === mode && p.status === 'OPEN');
  }

  public getPositionById(id: string): Position | undefined {
    return this.cache.positions.find(p => p.id === id);
  }

  public savePosition(position: Position): void {
    const updated = { ...position, updatedAt: Date.now() };
    const idx = this.cache.positions.findIndex(p => p.id === position.id);
    if (idx >= 0) {
      this.cache.positions[idx] = updated;
    } else {
      this.cache.positions.push(updated);
    }

    query(
      `INSERT INTO positions (
        id, account_id, symbol, mode, status, entry_price, quantity, remaining_quantity,
        entry_quote_amount, entry_fees, entry_score, entry_state, entry_reason,
        current_price, current_score, current_state, gross_pnl, unrealized_pnl,
        unrealized_pnl_percent, estimated_net_pnl, estimated_net_pnl_percent,
        break_even_price, take_profit_price, stop_loss_price, opened_at, updated_at,
        entry_order_id, exit_order_id, closed_at, exit_price, exit_reason, exit_score,
        realized_net_pnl, realized_net_pnl_percent, exit_fees
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30, $31, $32, $33, $34, $35
      ) ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        remaining_quantity = EXCLUDED.remaining_quantity,
        current_price = EXCLUDED.current_price,
        current_score = EXCLUDED.current_score,
        current_state = EXCLUDED.current_state,
        gross_pnl = EXCLUDED.gross_pnl,
        unrealized_pnl = EXCLUDED.unrealized_pnl,
        unrealized_pnl_percent = EXCLUDED.unrealized_pnl_percent,
        estimated_net_pnl = EXCLUDED.estimated_net_pnl,
        estimated_net_pnl_percent = EXCLUDED.estimated_net_pnl_percent,
        closed_at = EXCLUDED.closed_at,
        exit_price = EXCLUDED.exit_price,
        exit_reason = EXCLUDED.exit_reason,
        exit_order_id = EXCLUDED.exit_order_id,
        exit_score = EXCLUDED.exit_score,
        realized_net_pnl = EXCLUDED.realized_net_pnl,
        realized_net_pnl_percent = EXCLUDED.realized_net_pnl_percent,
        exit_fees = EXCLUDED.exit_fees,
        updated_at = EXCLUDED.updated_at`,
      [
        updated.id,
        updated.accountId || 'paper-default',
        updated.symbol,
        updated.mode,
        updated.status,
        updated.entryPrice,
        updated.quantity,
        updated.remainingQuantity ?? updated.quantity,
        updated.entryQuoteAmount,
        updated.entryFees ?? 0,
        updated.entryScore ?? 0,
        updated.entryState || 'STRONG_BULLISH',
        updated.entryReason || 'Auto Trade Entry',
        updated.currentPrice ?? updated.entryPrice,
        updated.currentScore || 0,
        updated.currentState || updated.entryState || 'STRONG_BULLISH',
        updated.grossPnL || 0,
        updated.unrealizedPnL || 0,
        updated.unrealizedPnLPercent || 0,
        updated.estimatedNetPnL || 0,
        updated.estimatedNetPnLPercent || 0,
        updated.breakEvenPrice || updated.entryPrice,
        updated.takeProfitPrice || (updated.entryPrice * 1.02),
        updated.stopLossPrice || (updated.entryPrice * 0.97),
        updated.openedAt || Date.now(),
        updated.updatedAt || Date.now(),
        updated.entryOrderId || null,
        updated.exitOrderId || null,
        null,
        null,
        updated.exitReason || null,
        null,
        null,
        null,
        (updated as any).exitFees ?? 0,
      ]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist position to PostgreSQL: ${err.message}`);
    });
  }

  // --- Orders ---
  public getOrders(mode?: TradingMode, symbol?: string): Order[] {
    let list = this.cache.orders;
    if (mode) {
      list = list.filter(o => o.mode === mode);
    }
    if (symbol) {
      list = list.filter(o => o.symbol === symbol);
    }
    return list.slice().reverse();
  }

  public getOrderById(id: string): Order | undefined {
    return this.cache.orders.find(o => o.id === id || o.clientOrderId === id);
  }

  public saveOrder(order: Order): void {
    const updated = { ...order, updatedAt: Date.now() };
    const idx = this.cache.orders.findIndex(o => o.id === order.id || o.clientOrderId === order.clientOrderId);
    if (idx >= 0) {
      this.cache.orders[idx] = updated;
    } else {
      this.cache.orders.push(updated);
    }

    query(
      `INSERT INTO orders (
        id, client_order_id, binance_order_id, account_id, mode, symbol, side, status,
        requested_quote_amount, executed_quantity, executed_quote_amount, execution_price,
        fee, fee_asset, reason, strategy_state, technical_score, fills, error_message, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      ON CONFLICT (client_order_id) DO UPDATE SET
        status = EXCLUDED.status,
        executed_quantity = EXCLUDED.executed_quantity,
        executed_quote_amount = EXCLUDED.executed_quote_amount,
        execution_price = EXCLUDED.execution_price,
        fee = EXCLUDED.fee,
        fills = EXCLUDED.fills,
        error_message = EXCLUDED.error_message,
        updated_at = EXCLUDED.updated_at`,
      [
        updated.id,
        updated.clientOrderId,
        updated.binanceOrderId || null,
        updated.accountId,
        updated.mode,
        updated.symbol,
        updated.side,
        updated.status,
        updated.requestedQuoteAmount || 0,
        updated.executedQuantity || 0,
        updated.executedQuoteAmount || 0,
        updated.executionPrice || null,
        updated.fee,
        updated.feeAsset,
        updated.reason,
        updated.strategyState || null,
        updated.technicalScore || null,
        JSON.stringify(updated.fills || []),
        updated.errorMessage || null,
        updated.createdAt,
        updated.updatedAt,
      ]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist order to PostgreSQL: ${err.message}`);
    });
  }

  // --- Trades ---
  public getTrades(mode?: TradingMode, symbol?: string): Trade[] {
    let list = this.cache.trades;
    if (mode) {
      list = list.filter(t => t.mode === mode);
    }
    if (symbol) {
      list = list.filter(t => t.symbol === symbol);
    }
    return list.slice().reverse();
  }

  public saveTrade(trade: Trade): void {
    const idx = this.cache.trades.findIndex(t => t.id === trade.id);
    if (idx >= 0) {
      this.cache.trades[idx] = trade;
    } else {
      this.cache.trades.push(trade);
    }

    query(
      `INSERT INTO trades (
        id, account_id, entry_order_id, exit_order_id, symbol, mode, entry_price, exit_price,
        quantity, entry_quote_amount, exit_quote_amount, entry_fees, exit_fees,
        gross_pnl, net_pnl, net_pnl_percent, entry_score, exit_score,
        entry_reason, exit_reason, opened_at, closed_at, duration_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      ON CONFLICT (id) DO UPDATE SET
        net_pnl = EXCLUDED.net_pnl,
        net_pnl_percent = EXCLUDED.net_pnl_percent,
        exit_price = EXCLUDED.exit_price,
        closed_at = EXCLUDED.closed_at`,
      [
        trade.id,
        trade.accountId,
        trade.entryOrderId,
        trade.exitOrderId,
        trade.symbol,
        trade.mode,
        trade.entryPrice,
        trade.exitPrice,
        trade.quantity,
        trade.entryQuoteAmount,
        trade.exitQuoteAmount,
        trade.entryFees,
        trade.exitFees,
        trade.grossPnL,
        trade.netPnL,
        trade.netPnLPercent,
        trade.entryScore || null,
        trade.exitScore || null,
        trade.entryReason || null,
        trade.exitReason || null,
        trade.openedAt,
        trade.closedAt,
        trade.durationMs,
      ]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist trade to PostgreSQL: ${err.message}`);
    });
  }

  // --- Atomic Transaction Helpers ---
  public async openPositionTx(params: OpenPositionParams): Promise<void> {
    await openPositionTransaction(params);
    this.saveOrder(params.order);
    this.savePosition(params.position);
    this.saveWallet(params.wallet);
  }

  public async closePositionTx(params: ClosePositionParams): Promise<void> {
    await closePositionTransaction(params);
    this.saveOrder(params.exitOrder);
    this.savePosition(params.position);
    this.saveTrade(params.trade);
    this.saveWallet(params.wallet);
  }

  // --- Cooldowns ---
  public setSymbolCooldown(symbol: string, mode: TradingMode, minutes: number): void {
    const key = `${mode}_${symbol}`;
    const until = Date.now() + minutes * 60 * 1000;
    this.cache.symbolCooldowns[key] = { symbol, mode, until };

    query(
      `INSERT INTO symbol_cooldowns (key, symbol, mode, until_timestamp)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET until_timestamp = EXCLUDED.until_timestamp`,
      [key, symbol, mode, until]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to set symbol cooldown in PostgreSQL: ${err.message}`);
    });
  }

  public isSymbolInCooldown(symbol: string, mode: TradingMode): { inCooldown: boolean; remainingMinutes: number } {
    const key = `${mode}_${symbol}`;
    const cd = this.cache.symbolCooldowns[key];
    if (!cd) return { inCooldown: false, remainingMinutes: 0 };
    const diff = cd.until - Date.now();
    if (diff > 0) {
      return { inCooldown: true, remainingMinutes: Math.ceil(diff / (60 * 1000)) };
    }
    delete this.cache.symbolCooldowns[key];
    query('DELETE FROM symbol_cooldowns WHERE key = $1', [key]).catch(() => {});
    return { inCooldown: false, remainingMinutes: 0 };
  }

  // --- Emergency Stop ---
  public isEmergencyStopped(): boolean {
    return Boolean(this.cache.isEmergencyStopped);
  }

  public setEmergencyStopped(val: boolean): void {
    this.cache.isEmergencyStopped = Boolean(val);

    query(
      `INSERT INTO system_state (key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      ['emergency_stop', JSON.stringify({ isEmergencyStopped: Boolean(val) }), Date.now()]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist emergency stop to PostgreSQL: ${err.message}`);
    });
  }

  // --- Database Stats & Diagnostics ---
  public getDatabaseStats() {
    return {
      storageEngine: 'PostgreSQL',
      databaseUrlSanitized: sanitizeDatabaseUrl(process.env.DATABASE_URL),
      isReady: this.isReady(),
      positionsCount: this.cache.positions.length,
      openPositionsCount: this.cache.positions.filter(p => p.status === 'OPEN').length,
      ordersCount: this.cache.orders.length,
      tradesCount: this.cache.trades.length,
      paperBalance: this.cache.paperWallet.usdtAvailable,
      paperEquity: this.cache.paperWallet.totalEquity,
      isEmergencyStopped: this.isEmergencyStopped(),
      tradingMode: this.cache.settings.mode,
      autoTrading: this.cache.settings.autoTrading,
      dataDir: DATA_DIR,
      lastPersistedAt: this.cache.lastPersistedAt,
    };
  }

  // --- Backup Snapshot ---
  public backupDatabase(customPath?: string): { success: boolean; backupPath: string; timestamp: number; sizeBytes: number } {
    const timestamp = Date.now();
    const backupFileName = `pg-database-backup-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}.json`;
    const targetPath = customPath || path.join(DATA_DIR, 'backups', backupFileName);

    try {
      const backupDir = path.dirname(targetPath);
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const dump = {
        version: 3,
        storageEngine: 'PostgreSQL',
        timestamp,
        settings: this.cache.settings,
        isEmergencyStopped: this.cache.isEmergencyStopped,
        wallets: { paper: this.cache.paperWallet, real: this.cache.realWallet },
        positions: this.cache.positions,
        orders: this.cache.orders,
        trades: this.cache.trades,
        accounts: this.cache.accounts,
      };

      const serialized = JSON.stringify(dump, null, 2);
      fs.writeFileSync(targetPath, serialized, 'utf8');
      const stat = fs.statSync(targetPath);
      Logger.info('PAPER', 'DATABASE', `PostgreSQL snapshot successfully written to ${targetPath} (${stat.size} bytes).`);

      return {
        success: true,
        backupPath: targetPath,
        timestamp,
        sizeBytes: stat.size,
      };
    } catch (err: any) {
      Logger.error('PAPER', 'DATABASE', `Failed to create database backup snapshot: ${err.message}`);
      throw new Error(`Backup failed: ${err.message}`);
    }
  }

  // --- Cold Reboot Rehydration ---
  public reloadFromDisk(): void {
    // Re-query all tables from PostgreSQL
    this.loadFromPostgres().catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to reload from PostgreSQL: ${err.message}`);
    });
  }

  // --- Analysis & Scanner State ---
  public saveAnalysis(symbol: string, analysis: TechnicalAnalysis): void {
    this.cache.latestAnalysis[symbol] = analysis;
  }

  public getAnalysis(symbol: string): TechnicalAnalysis | undefined {
    return this.cache.latestAnalysis[symbol];
  }

  public getAllAnalysis(): TechnicalAnalysis[] {
    return Object.values(this.cache.latestAnalysis);
  }

  public getScannerSummary(): ScannerSummary {
    return { ...this.cache.scannerSummary };
  }

  public updateScannerSummary(updates: Partial<ScannerSummary>): void {
    this.cache.scannerSummary = {
      ...this.cache.scannerSummary,
      ...updates,
    };
  }

  // --- Symbol Audit Trail ---
  public saveSymbolAuditRecord(record: SymbolAuditRecord): void {
    const id = record.id || `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const fullRecord: SymbolAuditRecord = {
      ...record,
      id,
    };

    this.cache.symbolAudits.unshift(fullRecord);
    if (this.cache.symbolAudits.length > 500) {
      this.cache.symbolAudits.pop();
    }

    query(
      `INSERT INTO symbol_audit_records (
        id, timestamp, requested_symbol, normalized_symbol, market, side,
        validation_result, binance_status, mapping_applied, rejection_reason, order_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO NOTHING`,
      [
        fullRecord.id,
        fullRecord.timestamp,
        fullRecord.requestedSymbol,
        fullRecord.normalizedSymbol,
        fullRecord.market,
        fullRecord.side,
        fullRecord.validationResult,
        fullRecord.binanceStatus || null,
        fullRecord.mappingApplied,
        fullRecord.rejectionReason || null,
        fullRecord.orderId || null,
      ]
    ).catch(err => {
      Logger.error('PAPER', 'DATABASE', `Failed to persist symbol audit record to PostgreSQL: ${err.message}`);
    });
  }

  public getSymbolAuditRecords(limit = 100): SymbolAuditRecord[] {
    return this.cache.symbolAudits.slice(0, limit);
  }
}

export const Storage = new PostgresStorageEngine();
