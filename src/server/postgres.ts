import pg from 'pg';
import { newDb } from 'pg-mem';
import fs from 'node:fs';
import path from 'node:path';
import {
  Position,
  Order,
  Trade,
  WalletBalance,
  TradingSettings,
  TradingAccount,
  TradingMode,
} from '../types/index.ts';
import { EncryptedPayload, maskApiKey } from './security.ts';
import { Logger } from './logger.ts';

// --------------------------------------------------------------------------
// 1. Database Connection & URL Sanitization
// --------------------------------------------------------------------------

export function normalizeDatabaseUrl(rawUrl?: string): string {
  if (!rawUrl) return '';
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    // If Render internal service hostname is used (e.g. dpg-db1udtss728c73ac7e00-a) without a domain suffix,
    // normalize to the standard Render Postgres public hostname format: dpg-*.oregon-postgres.render.com
    if (parsed.hostname && parsed.hostname.startsWith('dpg-') && !parsed.hostname.includes('.')) {
      parsed.hostname = `${parsed.hostname}.oregon-postgres.render.com`;
      return parsed.toString();
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export function sanitizeDatabaseUrl(rawUrl?: string): string {
  if (!rawUrl) return '[NOT_SET]';
  try {
    const u = new URL(normalizeDatabaseUrl(rawUrl));
    if (u.password) {
      u.password = '****';
    }
    return u.toString();
  } catch {
    return rawUrl.replace(/(:\/\/[^:]+:)([^@]+)(@)/, '$1****$3');
  }
}

let activePool: pg.Pool | null = null;
let isRemoteConnected = false;
let lastConnectionError: string | null = null;
let reconnectIntervalTimer: NodeJS.Timeout | null = null;
let isReconnecting = false;
const onReconnectCallbacks: Array<() => Promise<void>> = [];

export function registerDatabaseReconnectHandler(fn: () => Promise<void>): void {
  onReconnectCallbacks.push(fn);
}

async function notifyReconnected(): Promise<void> {
  for (const cb of onReconnectCallbacks) {
    try {
      await cb();
    } catch (err: any) {
      Logger.error('PAPER', 'DATABASE', `Error during database rehydration callback: ${err.message}`);
    }
  }
}

function isNetworkOrDnsError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || '');
  const code = String(err.code || '');
  return (
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    msg.includes('getaddrinfo') ||
    msg.includes('Connection timeout') ||
    msg.includes('Connection timed out')
  );
}

export function startDatabaseReconnectLoop(): void {
  if (reconnectIntervalTimer) return;

  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) return;

  const effectiveUrl = normalizeDatabaseUrl(rawUrl);
  reconnectIntervalTimer = setInterval(async () => {
    if (isRemoteConnected || isReconnecting) return;
    isReconnecting = true;
    const sanitized = sanitizeDatabaseUrl(effectiveUrl);

    try {
      const isLocal = effectiveUrl.includes('localhost') || effectiveUrl.includes('127.0.0.1');
      const testPool = new pg.Pool({
        connectionString: effectiveUrl,
        ssl: isLocal ? false : { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      const testClient = await testPool.connect();
      const res = await testClient.query('SELECT 1 as ping');
      testClient.release();

      if (res.rows?.[0]?.ping === 1 || res.rows?.[0]?.ping === '1') {
        if (activePool) {
          try {
            await activePool.end();
          } catch {}
        }
        activePool = testPool;
        isRemoteConnected = true;
        lastConnectionError = null;

        Logger.info('PAPER', 'DATABASE', `[DATABASE] [POSTGRES] Re-established connection to PostgreSQL at ${sanitized}. Running schema verification and rehydrating state...`);
        await initializePostgresSchema();
        await notifyReconnected();
        Logger.info('PAPER', 'DATABASE', '[DATABASE] [POSTGRES] Rehydration complete. Trading engine is now READY.');
      }
    } catch (err: any) {
      lastConnectionError = err.message;
      isRemoteConnected = false;
      Logger.warn('PAPER', 'DATABASE', `[DATABASE] [POSTGRES] Reconnection attempt failed (${err.message}). Retrying in 5s...`);
    } finally {
      isReconnecting = false;
    }
  }, 5000);
  reconnectIntervalTimer.unref();
}

export async function probeAndSelectPool(): Promise<pg.Pool> {
  if (activePool && isRemoteConnected) {
    return activePool;
  }

  const isTest = process.env.NODE_ENV === 'test';
  if (isTest) {
    if (!activePool) {
      const memDb = newDb();
      const MemPool = memDb.adapters.createPg().Pool;
      activePool = new MemPool() as unknown as pg.Pool;
      isRemoteConnected = true;
    }
    return activePool;
  }

  const rawUrl = process.env.DATABASE_URL?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!rawUrl) {
    if (isProduction) {
      const errMsg = 'FATAL: DATABASE_URL environment variable is required in production.';
      Logger.error('PAPER', 'DATABASE', errMsg);
      throw new Error(errMsg);
    }

    if (isTest) {
      // In explicit automated test runner with no external DB, provide pg-mem for unit tests only
      if (!activePool) {
        const memDb = newDb();
        const MemPool = memDb.adapters.createPg().Pool;
        activePool = new MemPool() as unknown as pg.Pool;
        isRemoteConnected = true;
        Logger.info('PAPER', 'DATABASE', '[TEST] Initialized in-memory PostgreSQL engine for test suite execution.');
      }
      return activePool;
    }

    const errMsg = 'DATABASE_URL environment variable is not configured.';
    Logger.error('PAPER', 'DATABASE', errMsg);
    throw new Error(errMsg);
  }

  const effectiveUrl = normalizeDatabaseUrl(rawUrl);
  const sanitized = sanitizeDatabaseUrl(effectiveUrl);
  const isLocal = effectiveUrl.includes('localhost') || effectiveUrl.includes('127.0.0.1');

  const remotePool = new pg.Pool({
    connectionString: effectiveUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  remotePool.on('error', (err) => {
    isRemoteConnected = false;
    lastConnectionError = err.message;
    Logger.error('PAPER', 'DATABASE', `[DATABASE] [POSTGRES] Connection pool error: ${err.message}. Marking database disconnected.`);
    startDatabaseReconnectLoop();
  });

  // Test remote connection with timeout
  try {
    const testClient = await Promise.race([
      remotePool.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connection timed out after 5000ms')), 5000)
      ),
    ]);
    const res = await testClient.query('SELECT 1 as ping');
    testClient.release();

    if (res.rows?.[0]?.ping === 1 || res.rows?.[0]?.ping === '1') {
      activePool = remotePool;
      isRemoteConnected = true;
      lastConnectionError = null;
      Logger.info('PAPER', 'DATABASE', `[DATABASE] [POSTGRES] Successfully connected to PostgreSQL at ${sanitized}`);
      return activePool;
    }
  } catch (err: any) {
    lastConnectionError = err.message;
    isRemoteConnected = false;
    activePool = null;

    Logger.error(
      'PAPER',
      'DATABASE',
      `[DATABASE] [POSTGRES] Failed to connect to PostgreSQL at ${sanitized}: ${err.message}. Storage is marked UNHEALTHY. Starting automatic reconnection loop.`
    );

    startDatabaseReconnectLoop();

    if (isProduction) {
      // In production, do not proceed with dummy database
      throw new Error(`Failed to connect to production PostgreSQL at ${sanitized}: ${err.message}`);
    }

    if (isTest) {
      // Test suite fallback
      const memDb = newDb();
      const MemPool = memDb.adapters.createPg().Pool;
      activePool = new MemPool() as unknown as pg.Pool;
      isRemoteConnected = true;
      return activePool;
    }

    throw err;
  }

  throw new Error('PostgreSQL connection failed.');
}

export function getPostgresPool(): pg.Pool | null {
  return activePool;
}

export function setTestPool(pool: pg.Pool | null): void {
  activePool = pool;
  isRemoteConnected = Boolean(pool);
  if (pool) {
    lastConnectionError = null;
  }
}

export function isPostgresConnected(): boolean {
  return isRemoteConnected;
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  if (!activePool || !isRemoteConnected) {
    try {
      await probeAndSelectPool();
    } catch {
      throw new Error(`[DATABASE] PostgreSQL is currently disconnected: ${lastConnectionError || 'Connection unavailable'}. Query rejected to prevent data loss.`);
    }
  }

  if (!activePool) {
    throw new Error('[DATABASE] PostgreSQL active pool is unavailable.');
  }

  try {
    return await activePool.query<T>(text, params);
  } catch (err: any) {
    if (isNetworkOrDnsError(err)) {
      isRemoteConnected = false;
      lastConnectionError = err.message;
      startDatabaseReconnectLoop();
    }
    throw err;
  }
}

export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  if (!activePool || !isRemoteConnected) {
    try {
      await probeAndSelectPool();
    } catch {
      throw new Error(`[DATABASE] PostgreSQL is currently disconnected: ${lastConnectionError || 'Connection unavailable'}. Transaction rejected to prevent data loss.`);
    }
  }

  if (!activePool) {
    throw new Error('[DATABASE] PostgreSQL active pool is unavailable.');
  }

  let client: pg.PoolClient;
  try {
    client = await activePool.connect();
  } catch (err: any) {
    isRemoteConnected = false;
    lastConnectionError = err.message;
    startDatabaseReconnectLoop();
    throw err;
  }

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr: any) {
      Logger.error('PAPER', 'DATABASE', `Rollback error: ${rbErr.message}`);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function checkPostgresHealth(): Promise<{
  isConnected: boolean;
  error?: string;
  storageEngine: string;
}> {
  if (!isRemoteConnected || !activePool) {
    return {
      isConnected: false,
      error: lastConnectionError || 'PostgreSQL database is currently disconnected.',
      storageEngine: 'PostgreSQL',
    };
  }

  try {
    const res = await activePool.query('SELECT 1 as ping');
    const ok = res.rows?.[0]?.ping === 1 || res.rows?.[0]?.ping === '1';
    return {
      isConnected: ok,
      error: ok ? undefined : 'Ping query did not return expected response',
      storageEngine: 'PostgreSQL',
    };
  } catch (err: any) {
    isRemoteConnected = false;
    lastConnectionError = err.message;
    startDatabaseReconnectLoop();
    return {
      isConnected: false,
      error: err.message,
      storageEngine: 'PostgreSQL',
    };
  }
}

// --------------------------------------------------------------------------
// 2. Schema Migrations & Initialization
// --------------------------------------------------------------------------

export async function initializePostgresSchema(): Promise<void> {
  Logger.info('PAPER', 'DATABASE', 'Checking and applying PostgreSQL database schema migrations...');

  await withTransaction(async (client) => {
    const safeExec = async (sql: string, params?: any[]) => {
      try {
        return await client.query(sql, params);
      } catch (err: any) {
        if (
          err.message?.includes('already exists') ||
          err.message?.includes('Not supported')
        ) {
          return { rowCount: 0, rows: [] } as any;
        }
        throw err;
      }
    };

    await safeExec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(32) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        applied_at BIGINT NOT NULL
      );
    `);

    // Migration 1: Core trading tables
    const migration1Applied = await safeExec('SELECT id FROM schema_migrations WHERE id = $1', ['1']);
    if (migration1Applied.rowCount === 0) {
      // System State
      await safeExec(`
        CREATE TABLE IF NOT EXISTS system_state (
          key VARCHAR(64) PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);

      // Trading Settings
      await safeExec(`
        CREATE TABLE IF NOT EXISTS trading_settings (
          id VARCHAR(32) PRIMARY KEY DEFAULT 'current',
          mode VARCHAR(16) NOT NULL DEFAULT 'PAPER',
          auto_trading BOOLEAN NOT NULL DEFAULT FALSE,
          fixed_trade_amount NUMERIC NOT NULL DEFAULT 100,
          max_open_positions INT NOT NULL DEFAULT 5,
          minimum_usdt_reserve NUMERIC NOT NULL DEFAULT 100,
          symbol_cooldown_minutes INT NOT NULL DEFAULT 30,
          pre_bullish_score_min INT NOT NULL DEFAULT 65,
          strong_bullish_score_min INT NOT NULL DEFAULT 80,
          weakening_threshold INT NOT NULL DEFAULT 70,
          max_trade_amount NUMERIC NOT NULL DEFAULT 1000,
          paper_starting_balance NUMERIC NOT NULL DEFAULT 1000,
          paper_fee_rate NUMERIC NOT NULL DEFAULT 0.001,
          paper_slippage_bps NUMERIC NOT NULL DEFAULT 5,
          manage_existing_holdings BOOLEAN NOT NULL DEFAULT FALSE,
          resume_on_restart BOOLEAN NOT NULL DEFAULT FALSE,
          scan_interval_ms INT NOT NULL DEFAULT 120000,
          take_profit_percent NUMERIC NOT NULL DEFAULT 2.0,
          stop_loss_percent NUMERIC NOT NULL DEFAULT 3.0,
          min_profit_for_technical_exit_percent NUMERIC NOT NULL DEFAULT 0.20,
          max_exit_price_age_ms INT NOT NULL DEFAULT 5000,
          updated_at BIGINT NOT NULL
        );
      `);

      // Wallets
      await safeExec(`
        CREATE TABLE IF NOT EXISTS wallets (
          mode VARCHAR(16) PRIMARY KEY,
          usdt_available NUMERIC NOT NULL,
          usdt_locked NUMERIC NOT NULL DEFAULT 0,
          usdt_total NUMERIC NOT NULL,
          account_asset_value NUMERIC NOT NULL DEFAULT 0,
          total_equity NUMERIC NOT NULL,
          starting_balance NUMERIC NOT NULL,
          realized_pnl NUMERIC NOT NULL DEFAULT 0,
          unrealized_pnl NUMERIC NOT NULL DEFAULT 0,
          total_fees_paid NUMERIC NOT NULL DEFAULT 0,
          assets JSONB NOT NULL DEFAULT '[]'::jsonb,
          last_reconciled_at BIGINT NOT NULL,
          reconciliation_status VARCHAR(32) NOT NULL DEFAULT 'OK',
          updated_at BIGINT NOT NULL
        );
      `);

      // Positions
      await safeExec(`
        CREATE TABLE IF NOT EXISTS positions (
          id VARCHAR(64) PRIMARY KEY,
          account_id VARCHAR(64) NOT NULL,
          symbol VARCHAR(32) NOT NULL,
          mode VARCHAR(16) NOT NULL,
          status VARCHAR(16) NOT NULL,
          entry_price NUMERIC NOT NULL,
          quantity NUMERIC NOT NULL,
          remaining_quantity NUMERIC DEFAULT 0,
          entry_quote_amount NUMERIC NOT NULL,
          entry_fees NUMERIC NOT NULL DEFAULT 0,
          entry_score NUMERIC NOT NULL DEFAULT 0,
          entry_state VARCHAR(32) NOT NULL,
          entry_reason TEXT NOT NULL,
          current_price NUMERIC NOT NULL,
          current_score NUMERIC NOT NULL DEFAULT 0,
          current_state VARCHAR(32) NOT NULL,
          gross_pnl NUMERIC DEFAULT 0,
          unrealized_pnl NUMERIC DEFAULT 0,
          unrealized_pnl_percent NUMERIC DEFAULT 0,
          estimated_net_pnl NUMERIC DEFAULT 0,
          estimated_net_pnl_percent NUMERIC DEFAULT 0,
          break_even_price NUMERIC,
          take_profit_price NUMERIC,
          stop_loss_price NUMERIC,
          opened_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          entry_order_id VARCHAR(64),
          exit_order_id VARCHAR(64),
          closed_at BIGINT,
          exit_price NUMERIC,
          exit_reason TEXT,
          exit_score NUMERIC,
          realized_net_pnl NUMERIC,
          realized_net_pnl_percent NUMERIC,
          exit_fees NUMERIC DEFAULT 0
        );
      `);
      await safeExec(`CREATE INDEX IF NOT EXISTS idx_positions_mode_status ON positions(mode, status);`);
      await safeExec(`CREATE INDEX IF NOT EXISTS idx_positions_symbol_mode_status ON positions(symbol, mode, status);`);

      // Orders
      await safeExec(`
        CREATE TABLE IF NOT EXISTS orders (
          id VARCHAR(64) PRIMARY KEY,
          client_order_id VARCHAR(64) UNIQUE NOT NULL,
          binance_order_id VARCHAR(64),
          account_id VARCHAR(64) NOT NULL,
          mode VARCHAR(16) NOT NULL,
          symbol VARCHAR(32) NOT NULL,
          side VARCHAR(8) NOT NULL,
          status VARCHAR(16) NOT NULL,
          requested_quote_amount NUMERIC DEFAULT 0,
          executed_quantity NUMERIC NOT NULL DEFAULT 0,
          executed_quote_amount NUMERIC NOT NULL DEFAULT 0,
          execution_price NUMERIC,
          fee NUMERIC NOT NULL DEFAULT 0,
          fee_asset VARCHAR(16) NOT NULL DEFAULT 'USDT',
          reason TEXT NOT NULL,
          strategy_state VARCHAR(32),
          technical_score NUMERIC,
          fills JSONB NOT NULL DEFAULT '[]'::jsonb,
          error_message TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);
      await safeExec(`CREATE INDEX IF NOT EXISTS idx_orders_mode_symbol ON orders(mode, symbol);`);
      await safeExec(`CREATE INDEX IF NOT EXISTS idx_orders_client_id ON orders(client_order_id);`);

      // Trades
      await safeExec(`
        CREATE TABLE IF NOT EXISTS trades (
          id VARCHAR(64) PRIMARY KEY,
          account_id VARCHAR(64) NOT NULL,
          entry_order_id VARCHAR(64) NOT NULL,
          exit_order_id VARCHAR(64) NOT NULL,
          symbol VARCHAR(32) NOT NULL,
          mode VARCHAR(16) NOT NULL,
          entry_price NUMERIC NOT NULL,
          exit_price NUMERIC NOT NULL,
          quantity NUMERIC NOT NULL,
          entry_quote_amount NUMERIC NOT NULL,
          exit_quote_amount NUMERIC NOT NULL,
          entry_fees NUMERIC NOT NULL,
          exit_fees NUMERIC NOT NULL,
          gross_pnl NUMERIC NOT NULL,
          net_pnl NUMERIC NOT NULL,
          net_pnl_percent NUMERIC NOT NULL,
          entry_score NUMERIC,
          exit_score NUMERIC,
          entry_reason TEXT,
          exit_reason TEXT,
          opened_at BIGINT NOT NULL,
          closed_at BIGINT NOT NULL,
          duration_ms BIGINT NOT NULL
        );
      `);
      await safeExec(`CREATE INDEX IF NOT EXISTS idx_trades_mode_symbol ON trades(mode, symbol);`);

      // Trade Decisions (Audit log)
      await safeExec(`
        CREATE TABLE IF NOT EXISTS trade_decisions (
          id VARCHAR(64) PRIMARY KEY,
          symbol VARCHAR(32) NOT NULL,
          action VARCHAR(16) NOT NULL,
          mode VARCHAR(16) NOT NULL,
          strategy_state VARCHAR(32) NOT NULL,
          score NUMERIC NOT NULL,
          decision_reason TEXT NOT NULL,
          price NUMERIC NOT NULL,
          details JSONB,
          timestamp BIGINT NOT NULL
        );
      `);
      await safeExec(`CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON trade_decisions(symbol, timestamp);`);

      // Accounts
      await safeExec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          mode VARCHAR(16) NOT NULL,
          auto_trading BOOLEAN NOT NULL DEFAULT FALSE,
          resume_on_restart BOOLEAN NOT NULL DEFAULT FALSE,
          has_api_keys BOOLEAN NOT NULL DEFAULT FALSE,
          api_key_masked VARCHAR(32),
          api_secret_configured BOOLEAN NOT NULL DEFAULT FALSE,
          permissions JSONB,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);

      // Credentials (AES-256-GCM encrypted payload)
      await safeExec(`
        CREATE TABLE IF NOT EXISTS credentials (
          account_id VARCHAR(64) PRIMARY KEY,
          api_key TEXT NOT NULL,
          secret_iv TEXT NOT NULL,
          secret_tag TEXT NOT NULL,
          secret_data TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);

      // Symbol Cooldowns
      await safeExec(`
        CREATE TABLE IF NOT EXISTS symbol_cooldowns (
          key VARCHAR(64) PRIMARY KEY,
          symbol VARCHAR(32) NOT NULL,
          mode VARCHAR(16) NOT NULL,
          until_timestamp BIGINT NOT NULL
        );
      `);

      await safeExec(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES ($1, $2, $3)',
        ['1', '001_initial_schema', Date.now()]
      );
      Logger.info('PAPER', 'DATABASE', 'Applied migration 001_initial_schema successfully.');
    }
  });
}

// --------------------------------------------------------------------------
// 3. One-Time Safe Migration from File-Based JSON Storage
// --------------------------------------------------------------------------

export async function migrateFromJsonIfPresent(jsonPath: string): Promise<boolean> {
  if (!fs.existsSync(jsonPath)) {
    return false;
  }

  // Check if migration was already executed
  const checkMigration = await query(
    'SELECT value FROM system_state WHERE key = $1',
    ['json_migration_completed']
  );
  if (checkMigration.rowCount && checkMigration.rowCount > 0) {
    return false;
  }

  // Check if PostgreSQL already contains trading records
  const checkPositions = await query('SELECT COUNT(*) as count FROM positions');
  const count = parseInt(checkPositions.rows[0]?.count || '0', 10);
  if (count > 0) {
    // Database already has records, skip
    await query(
      'INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING',
      ['json_migration_completed', JSON.stringify({ completedAt: Date.now() }), Date.now()]
    );
    return false;
  }

  try {
    Logger.info('PAPER', 'DATABASE', `Found existing JSON file at ${jsonPath}. Performing safe one-time migration to PostgreSQL...`);
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);

    await withTransaction(async (client) => {
      // 1. Settings
      if (parsed.settings) {
        const s = parsed.settings;
        await client.query(
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
            updated_at = EXCLUDED.updated_at`,
          [
            s.mode || 'PAPER',
            Boolean(s.autoTrading),
            Number(s.fixedTradeAmount) || 100,
            Number(s.maxOpenPositions) || 5,
            Number(s.minimumUsdtReserve) || 100,
            Number(s.symbolCooldownMinutes) || 30,
            Number(s.preBullishScoreMin) || 65,
            Number(s.strongBullishScoreMin) || 80,
            Number(s.weakeningThreshold) || 70,
            Number(s.maxTradeAmount) || 1000,
            Number(s.paperStartingBalance) || 1000,
            Number(s.paperFeeRate) || 0.001,
            Number(s.paperSlippageBps) || 5,
            Boolean(s.manageExistingHoldings),
            Boolean(s.resumeOnRestart),
            Number(s.scanIntervalMs) || 120000,
            Number(s.takeProfitPercent) || 2.0,
            Number(s.stopLossPercent) || 3.0,
            Number(s.minProfitForTechnicalExitPercent) || 0.20,
            Number(s.maxExitPriceAgeMs) || 5000,
            Date.now(),
          ]
        );
      }

      // 2. Emergency stop state
      await client.query(
        `INSERT INTO system_state (key, value, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ['emergency_stop', JSON.stringify({ isEmergencyStopped: Boolean(parsed.isEmergencyStopped) }), Date.now()]
      );

      // 3. Wallets
      if (parsed.paperWallet) {
        const w = parsed.paperWallet;
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
            total_equity = EXCLUDED.total_equity,
            realized_pnl = EXCLUDED.realized_pnl,
            updated_at = EXCLUDED.updated_at`,
          [
            'PAPER',
            Number(w.usdtAvailable) || 1000,
            Number(w.usdtLocked) || 0,
            Number(w.usdtTotal) || 1000,
            Number(w.accountAssetValue) || 0,
            Number(w.totalEquity) || 1000,
            Number(w.startingBalance) || 1000,
            Number(w.realizedPnL) || 0,
            Number(w.unrealizedPnL) || 0,
            Number(w.totalFeesPaid) || 0,
            JSON.stringify(w.assets || []),
            Number(w.lastReconciledAt) || Date.now(),
            w.reconciliationStatus || 'OK',
            Date.now(),
          ]
        );
      }

      if (parsed.realWallet) {
        const w = parsed.realWallet;
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
            total_equity = EXCLUDED.total_equity,
            updated_at = EXCLUDED.updated_at`,
          [
            'REAL',
            Number(w.usdtAvailable) || 0,
            Number(w.usdtLocked) || 0,
            Number(w.usdtTotal) || 0,
            Number(w.accountAssetValue) || 0,
            Number(w.totalEquity) || 0,
            Number(w.startingBalance) || 0,
            Number(w.realizedPnL) || 0,
            Number(w.unrealizedPnL) || 0,
            Number(w.totalFeesPaid) || 0,
            JSON.stringify(w.assets || []),
            Number(w.lastReconciledAt) || Date.now(),
            w.reconciliationStatus || 'OK',
            Date.now(),
          ]
        );
      }

      // 4. Positions
      if (Array.isArray(parsed.positions)) {
        for (const pos of parsed.positions) {
          await client.query(
            `INSERT INTO positions (
              id, account_id, symbol, mode, status, entry_price, quantity,
              remaining_quantity, entry_quote_amount, entry_fees, entry_score,
              entry_state, entry_reason, current_price, current_score, current_state,
              gross_pnl, unrealized_pnl, unrealized_pnl_percent, estimated_net_pnl,
              estimated_net_pnl_percent, break_even_price, take_profit_price,
              stop_loss_price, opened_at, updated_at, entry_order_id, exit_order_id,
              closed_at, exit_price, exit_reason, exit_score, realized_net_pnl,
              realized_net_pnl_percent, exit_fees
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
              $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
              $29, $30, $31, $32, $33, $34, $35
            ) ON CONFLICT (id) DO NOTHING`,
            [
              pos.id,
              pos.accountId || 'paper-default',
              pos.symbol,
              pos.mode,
              pos.status,
              pos.entryPrice,
              pos.quantity,
              pos.remainingQuantity ?? pos.quantity,
              pos.entryQuoteAmount,
              pos.entryFees || 0,
              pos.entryScore || 0,
              pos.entryState || 'STRONG_BULLISH',
              pos.entryReason || 'Auto Trade Entry',
              pos.currentPrice || pos.entryPrice,
              pos.currentScore || 0,
              pos.currentState || pos.entryState || 'STRONG_BULLISH',
              pos.grossPnL || 0,
              pos.unrealizedPnL || 0,
              pos.unrealizedPnLPercent || 0,
              pos.estimatedNetPnL || 0,
              pos.estimatedNetPnLPercent || 0,
              pos.breakEvenPrice || pos.entryPrice,
              pos.takeProfitPrice || pos.entryPrice * 1.02,
              pos.stopLossPrice || pos.entryPrice * 0.97,
              pos.openedAt || Date.now(),
              pos.updatedAt || Date.now(),
              pos.entryOrderId || null,
              pos.exitOrderId || null,
              pos.closedAt || null,
              pos.exitPrice || null,
              pos.exitReason || null,
              pos.exitScore || null,
              pos.realizedNetPnL || null,
              pos.realizedNetPnLPercent || null,
              pos.exitFees || 0,
            ]
          );
        }
      }

      // 5. Orders
      if (Array.isArray(parsed.orders)) {
        for (const ord of parsed.orders) {
          await client.query(
            `INSERT INTO orders (
              id, client_order_id, binance_order_id, account_id, mode, symbol,
              side, status, requested_quote_amount, executed_quantity,
              executed_quote_amount, execution_price, fee, fee_asset, reason,
              strategy_state, technical_score, fills, error_message, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
              $16, $17, $18, $19, $20, $21
            ) ON CONFLICT (client_order_id) DO NOTHING`,
            [
              ord.id,
              ord.clientOrderId || ord.id,
              ord.binanceOrderId || null,
              ord.accountId || 'paper-default',
              ord.mode,
              ord.symbol,
              ord.side,
              ord.status,
              ord.requestedQuoteAmount || 0,
              ord.executedQuantity || 0,
              ord.executedQuoteAmount || 0,
              ord.executionPrice || null,
              ord.fee || 0,
              ord.feeAsset || 'USDT',
              ord.reason || 'Trading Order',
              ord.strategyState || null,
              ord.technicalScore || null,
              JSON.stringify(ord.fills || []),
              ord.errorMessage || null,
              ord.createdAt || Date.now(),
              ord.updatedAt || Date.now(),
            ]
          );
        }
      }

      // 6. Trades
      if (Array.isArray(parsed.trades)) {
        for (const trd of parsed.trades) {
          await client.query(
            `INSERT INTO trades (
              id, account_id, entry_order_id, exit_order_id, symbol, mode,
              entry_price, exit_price, quantity, entry_quote_amount, exit_quote_amount,
              entry_fees, exit_fees, gross_pnl, net_pnl, net_pnl_percent,
              entry_score, exit_score, entry_reason, exit_reason,
              opened_at, closed_at, duration_ms
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
              $16, $17, $18, $19, $20, $21, $22, $23
            ) ON CONFLICT (id) DO NOTHING`,
            [
              trd.id,
              trd.accountId || 'paper-default',
              trd.entryOrderId || '',
              trd.exitOrderId || '',
              trd.symbol,
              trd.mode,
              trd.entryPrice,
              trd.exitPrice,
              trd.quantity,
              trd.entryQuoteAmount,
              trd.exitQuoteAmount,
              trd.entryFees || 0,
              trd.exitFees || 0,
              trd.grossPnL || 0,
              trd.netPnL || 0,
              trd.netPnLPercent || 0,
              trd.entryScore || null,
              trd.exitScore || null,
              trd.entryReason || null,
              trd.exitReason || null,
              trd.openedAt || Date.now(),
              trd.closedAt || Date.now(),
              trd.durationMs || 0,
            ]
          );
        }
      }

      // Mark migration completed
      await client.query(
        `INSERT INTO system_state (key, value, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ['json_migration_completed', JSON.stringify({ completedAt: Date.now() }), Date.now()]
      );
    });

    // Rename JSON file to .migrated so it is preserved as backup but not reused
    try {
      const migratedBackupPath = `${jsonPath}.migrated.${Date.now()}`;
      fs.renameSync(jsonPath, migratedBackupPath);
      Logger.info('PAPER', 'DATABASE', `One-time migration to PostgreSQL complete. Old JSON archived at ${migratedBackupPath}`);
    } catch {
      // If rename fails, system_state flag prevents re-migration
    }

    return true;
  } catch (err: any) {
    Logger.error('PAPER', 'DATABASE', `JSON to PostgreSQL migration failed: ${err.message}`);
    return false;
  }
}

// --------------------------------------------------------------------------
// 4. High-Level Atomic Database Transactions
// --------------------------------------------------------------------------

export interface OpenPositionParams {
  position: Position;
  order: Order;
  wallet: WalletBalance;
}

export async function openPositionTransaction(params: OpenPositionParams): Promise<void> {
  const { position, order, wallet } = params;

  await withTransaction(async (client) => {
    // 1. Prevent duplicate order execution
    const existingOrder = await client.query(
      'SELECT id FROM orders WHERE client_order_id = $1',
      [order.clientOrderId]
    );
    if (existingOrder.rowCount && existingOrder.rowCount > 0) {
      throw new Error(`Duplicate order prevented: Order with clientOrderId ${order.clientOrderId} already exists.`);
    }

    // 2. Prevent duplicate open position for symbol
    const existingPos = await client.query(
      'SELECT id FROM positions WHERE symbol = $1 AND mode = $2 AND status = $3',
      [position.symbol, position.mode, 'OPEN']
    );
    if (existingPos.rowCount && existingPos.rowCount > 0) {
      throw new Error(`Duplicate position prevented: An OPEN position already exists for ${position.symbol} [${position.mode}].`);
    }

    // 3. Insert order
    await client.query(
      `INSERT INTO orders (
        id, client_order_id, binance_order_id, account_id, mode, symbol, side, status,
        requested_quote_amount, executed_quantity, executed_quote_amount, execution_price,
        fee, fee_asset, reason, strategy_state, technical_score, fills, error_message, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        order.id,
        order.clientOrderId,
        order.binanceOrderId || null,
        order.accountId,
        order.mode,
        order.symbol,
        order.side,
        order.status,
        order.requestedQuoteAmount,
        order.executedQuantity,
        order.executedQuoteAmount,
        order.executionPrice || null,
        order.fee,
        order.feeAsset,
        order.reason,
        order.strategyState || null,
        order.technicalScore || null,
        JSON.stringify(order.fills || []),
        order.errorMessage || null,
        order.createdAt,
        order.updatedAt,
      ]
    );

    // 4. Insert position
    await client.query(
      `INSERT INTO positions (
        id, account_id, symbol, mode, status, entry_price, quantity, remaining_quantity,
        entry_quote_amount, entry_fees, entry_score, entry_state, entry_reason,
        current_price, current_score, current_state, gross_pnl, unrealized_pnl,
        unrealized_pnl_percent, estimated_net_pnl, estimated_net_pnl_percent,
        break_even_price, take_profit_price, stop_loss_price, opened_at, updated_at,
        entry_order_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
      )`,
      [
        position.id,
        position.accountId,
        position.symbol,
        position.mode,
        position.status,
        position.entryPrice,
        position.quantity,
        position.remainingQuantity,
        position.entryQuoteAmount,
        position.entryFees,
        position.entryScore,
        position.entryState,
        position.entryReason,
        position.currentPrice,
        position.currentScore,
        position.currentState,
        position.grossPnL,
        position.unrealizedPnL,
        position.unrealizedPnLPercent,
        position.estimatedNetPnL,
        position.estimatedNetPnLPercent,
        position.breakEvenPrice,
        position.takeProfitPrice,
        position.stopLossPrice,
        position.openedAt,
        position.updatedAt,
        position.entryOrderId,
      ]
    );

    // 5. Update wallet
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
        total_fees_paid = EXCLUDED.total_fees_paid,
        assets = EXCLUDED.assets,
        last_reconciled_at = EXCLUDED.last_reconciled_at,
        updated_at = EXCLUDED.updated_at`,
      [
        wallet.mode,
        wallet.usdtAvailable,
        wallet.usdtLocked,
        wallet.usdtTotal,
        wallet.accountAssetValue,
        wallet.totalEquity,
        wallet.startingBalance,
        wallet.realizedPnL,
        wallet.unrealizedPnL,
        wallet.totalFeesPaid,
        JSON.stringify(wallet.assets),
        wallet.lastReconciledAt,
        wallet.reconciliationStatus,
        Date.now(),
      ]
    );

    // 6. Record audit decision
    await client.query(
      `INSERT INTO trade_decisions (
        id, symbol, action, mode, strategy_state, score, decision_reason, price, details, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        `DEC-BUY-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        position.symbol,
        'BUY',
        position.mode,
        position.entryState,
        position.entryScore,
        position.entryReason,
        position.entryPrice,
        JSON.stringify({ orderId: order.id, quantity: position.quantity, quoteAmount: position.entryQuoteAmount }),
        Date.now(),
      ]
    );
  });
}

export interface ClosePositionParams {
  position: Position;
  exitOrder: Order;
  trade: Trade;
  wallet: WalletBalance;
}

export async function closePositionTransaction(params: ClosePositionParams): Promise<void> {
  const { position, exitOrder, trade, wallet } = params;

  await withTransaction(async (client) => {
    // 1. Prevent duplicate exit order
    const existingOrder = await client.query(
      'SELECT id FROM orders WHERE client_order_id = $1',
      [exitOrder.clientOrderId]
    );
    if (existingOrder.rowCount && existingOrder.rowCount > 0) {
      throw new Error(`Duplicate exit order prevented: Order with clientOrderId ${exitOrder.clientOrderId} already exists.`);
    }

    // 2. Prevent duplicate trade
    const existingTrade = await client.query(
      'SELECT id FROM trades WHERE id = $1',
      [trade.id]
    );
    if (existingTrade.rowCount && existingTrade.rowCount > 0) {
      throw new Error(`Duplicate trade prevented: Trade ${trade.id} already exists.`);
    }

    // 3. Insert exit order
    await client.query(
      `INSERT INTO orders (
        id, client_order_id, binance_order_id, account_id, mode, symbol, side, status,
        requested_quote_amount, executed_quantity, executed_quote_amount, execution_price,
        fee, fee_asset, reason, strategy_state, technical_score, fills, error_message, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        exitOrder.id,
        exitOrder.clientOrderId,
        exitOrder.binanceOrderId || null,
        exitOrder.accountId,
        exitOrder.mode,
        exitOrder.symbol,
        exitOrder.side,
        exitOrder.status,
        exitOrder.requestedQuoteAmount,
        exitOrder.executedQuantity,
        exitOrder.executedQuoteAmount,
        exitOrder.executionPrice || null,
        exitOrder.fee,
        exitOrder.feeAsset,
        exitOrder.reason,
        exitOrder.strategyState || null,
        exitOrder.technicalScore || null,
        JSON.stringify(exitOrder.fills || []),
        exitOrder.errorMessage || null,
        exitOrder.createdAt,
        exitOrder.updatedAt,
      ]
    );

    // 4. Update position to CLOSED
    await client.query(
      `UPDATE positions SET
        status = 'CLOSED',
        remaining_quantity = 0,
        current_price = $1,
        closed_at = $2,
        exit_price = $3,
        exit_reason = $4,
        exit_order_id = $5,
        exit_score = $6,
        realized_net_pnl = $7,
        realized_net_pnl_percent = $8,
        exit_fees = $9,
        updated_at = $10
       WHERE id = $11`,
      [
        trade.exitPrice,
        trade.closedAt,
        trade.exitPrice,
        trade.exitReason,
        exitOrder.id,
        trade.exitScore,
        trade.netPnL,
        trade.netPnLPercent,
        trade.exitFees,
        Date.now(),
        position.id,
      ]
    );

    // 5. Insert trade record
    await client.query(
      `INSERT INTO trades (
        id, account_id, entry_order_id, exit_order_id, symbol, mode, entry_price, exit_price,
        quantity, entry_quote_amount, exit_quote_amount, entry_fees, exit_fees,
        gross_pnl, net_pnl, net_pnl_percent, entry_score, exit_score,
        entry_reason, exit_reason, opened_at, closed_at, duration_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
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
        trade.entryScore,
        trade.exitScore,
        trade.entryReason,
        trade.exitReason,
        trade.openedAt,
        trade.closedAt,
        trade.durationMs,
      ]
    );

    // 6. Update wallet balance
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
        realized_pnl = EXCLUDED.realized_pnl,
        total_fees_paid = EXCLUDED.total_fees_paid,
        assets = EXCLUDED.assets,
        last_reconciled_at = EXCLUDED.last_reconciled_at,
        updated_at = EXCLUDED.updated_at`,
      [
        wallet.mode,
        wallet.usdtAvailable,
        wallet.usdtLocked,
        wallet.usdtTotal,
        wallet.accountAssetValue,
        wallet.totalEquity,
        wallet.startingBalance,
        wallet.realizedPnL,
        wallet.unrealizedPnL,
        wallet.totalFeesPaid,
        JSON.stringify(wallet.assets),
        wallet.lastReconciledAt,
        wallet.reconciliationStatus,
        Date.now(),
      ]
    );

    // 7. Record audit decision
    await client.query(
      `INSERT INTO trade_decisions (
        id, symbol, action, mode, strategy_state, score, decision_reason, price, details, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        `DEC-SELL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        position.symbol,
        'SELL',
        position.mode,
        trade.exitScore ? 'EXIT' : 'MANUAL',
        trade.exitScore || 0,
        trade.exitReason,
        trade.exitPrice,
        JSON.stringify({ tradeId: trade.id, realizedPnL: trade.netPnL, durationMs: trade.durationMs }),
        Date.now(),
      ]
    );
  });
}
