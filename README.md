# Binance 5-Minute Crypto Scanner & 24/7 Auto Trader (PostgreSQL Production Architecture)

A hardened, 24/7 production web application combining Binance Spot market scanning, multi-timeframe technical indicator analysis, centralized bullish entry execution (`PRE_BULLISH` & `STRONG_BULLISH`), authoritative Net PnL exit architecture (`Take-Profit`, `Stop-Loss`, and `Technical Profit Exit`), persistent PostgreSQL relational storage, and live Binance Spot auto-trading with server-side security.

---

## 🌟 Production Architecture (24/7 Server-Authoritative)

```text
                    INTERNET
                       │
                       ▼  HTTPS / TLS
              React/Vite Frontend (SPA Dashboard)
                       │
                       │  REST API + Server-Sent Events (SSE)
                       ▼
             Node.js / Express Server (server.ts)
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
 2m Scanner      Trading Engine  Position Engine
       │               │               │
       └───────────────┼───────────────┘
                       │
                       ├──► Binance Spot API
                       │
                       ▼
             Render PostgreSQL Database (DATABASE_URL)
            ├── schema_migrations (Automated migrations)
            ├── trading_settings
            ├── system_state
            ├── wallets (Paper & Real)
            ├── positions (Open & Closed)
            ├── orders (Fills & Statuses)
            ├── trades (Realized PnL history)
            ├── trade_decisions (Audit log)
            ├── accounts & credentials (AES-256-GCM encrypted)
            └── symbol_cooldowns
```

The browser acts **strictly as an administrative dashboard**. Closing the browser, turning off your computer, or disconnecting does **NOT** interrupt market scanning, automated entry execution, TP/SL monitoring, or trade tracking.

---

## 🚀 Render 24/7 Deployment Step-by-Step Guide

### Step 1: Create a PostgreSQL Database on Render
1. In your [Render Dashboard](https://dashboard.render.com), click **New +** and select **PostgreSQL**.
2. Set:
   - **Name**: `binance-trader-db`
   - **Database**: `binance_trader`
   - **User**: `binance_trader`
   - **Region**: Same region as your Web Service
3. Copy the **Internal Database URL** (or External Database URL if deploying across accounts).

### Step 2: Create a Web Service on Render
1. Click **New +** and select **Web Service**.
2. Connect your GitHub repository containing this project.

### Step 3: Configure Build & Start Commands
- **Runtime**: `Node` (or `Bun`)
- **Build Command**: `bun install && bun run build` (or `npm install && npm run build`)
- **Start Command**: `npm start` (runs `tsx server.ts`)
- **Health Check Path**: `/health`

### Step 4: Configure Environment Variables
In the **Environment** tab of your Render Web Service, set the following required variables:

```bash
# 1. Database Connection (REQUIRED in Production)
DATABASE_URL=postgresql://binance_trader:YOUR_PASSWORD@dpg-xxxxx-a.render.com/binance_trader

# 2. Server Runtime
NODE_ENV=production
PORT=10000

# 3. Administrative Authentication & Token
ADMIN_ACCESS_TOKEN=12345
ADMIN_TOKEN=12345
CREDENTIAL_ENCRYPTION_KEY=GENERATE_A_32_BYTE_HEX_OR_PASSPHRASE

# 4. Live Trading Protection Guard (Default: false)
LIVE_TRADING_ENABLED=false

# 5. Binance Spot API (Optional environment defaults; can also be configured in UI)
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_API_BASE_URL=https://api.binance.com

# 6. CORS Origins
APP_ORIGIN=https://YOUR-APP.onrender.com
ALLOWED_ORIGINS=https://YOUR-APP.onrender.com

# 7. Exit Architecture Parameters
TAKE_PROFIT_PERCENT=2.0
STOP_LOSS_PERCENT=3.0
MIN_PROFIT_TO_TECHNICAL_EXIT_PERCENT=0.20
MAX_EXIT_PRICE_AGE_MS=5000

# 8. Strategy Entry Parameters
PRE_BULLISH_SCORE_MIN=65
STRONG_BULLISH_SCORE_MIN=80
WEAKENING_THRESHOLD=70
```

### Step 5: Deploy & Verify
1. Click **Deploy Web Service**.
2. Test the public health endpoint:
   ```bash
   curl https://YOUR-APP.onrender.com/health
   ```
   Response: `{"status":"ok","service":"binance-5-minute-auto-trader","environment":"production",...}`
3. Test the database readiness endpoint:
   ```bash
   curl https://YOUR-APP.onrender.com/ready
   ```
   Response: `{"ready":true,"server":true,"storage":true,"storageEngine":"PostgreSQL","database":"connected",...}`
4. Open `https://YOUR-APP.onrender.com` in your browser.
5. Create a test trade, restart the Render Web Service, and verify that positions, orders, trade history, and balances are 100% preserved.

---

## 🔒 Security Architecture & Guarantees

1. **Zero Secret Exposure**:
   - `DATABASE_URL`, `ADMIN_TOKEN`, `BINANCE_API_SECRET`, and `CREDENTIAL_ENCRYPTION_KEY` are kept strictly server-side.
   - Database passwords never appear in application logs or frontend responses.
2. **PostgreSQL ACID Transactions**:
   - Opening positions, executing orders, recording fills, and closing trades run within isolated PostgreSQL transactions (`withTransaction`), preventing duplicate executions during retries.
3. **Automated Schema Migrations & Zero Dependency on JSON**:
   - On startup, the server automatically initializes tables, constraints, and indexes.
   - Any legacy `/data/database.json` file is safely migrated once into PostgreSQL and archived as `.migrated`.
4. **Live Trading Guard (`LIVE_TRADING_ENABLED`)**:
   - Live trading requires `LIVE_TRADING_ENABLED=true` in server environment variables.
   - Any attempt to submit real Binance orders while `LIVE_TRADING_ENABLED != true` is rejected by both `SafetyGate` and `RealBinanceTradingExecutor`.

---

## 📊 Exit Engine & Risk Rules

| Rule | Trigger Condition | Resulting Action |
|---|---|---|
| **Take-Profit (TP)** | Net PnL $\ge$ `TAKE_PROFIT_PERCENT` (+2.0%) | **SELL** (Full profit locked) |
| **Stop-Loss (SL)** | Net PnL $\le$ `-STOP_LOSS_PERCENT` (-3.0%) | **SELL** (Loss capped) |
| **Technical Weakening (Profitable)** | State `WEAKENING`/`EXIT` & Net PnL $\ge$ `+0.20%` | **SELL** (Technical Profit Exit) |
| **Technical Weakening (Losing)** | State `WEAKENING`/`EXIT` & Net PnL $<$ `+0.20%` | **HOLD** (Never sell at a loss) |
| **Emergency Stop** | User triggered | **HALT** all automated buying |

---

## 🧪 Automated Testing

Run the full automated test suite covering technical indicators, strategy transitions, execution invariants, risk gates, and PostgreSQL persistence:

```bash
bun test # or npm test
```

## Binance Symbol Safety (patched)

Automatic scanning now uses Binance Spot `exchangeInfo` as the authoritative source of tradable USDT symbols and intersects it with 24-hour ticker data only for liquidity/ranking. Automatic BUYs and paper BUYs use a strict exact-symbol validation gate, so legacy aliases such as `RNDRUSDT`, `COCOSUSDT`, `POLYUSDT`, and `TOMOUSDT` cannot become new positions. Existing stale paper positions are not silently rewritten; use **Reset Positions & Balance** after deploying this patch if the current database contains unsupported legacy positions.
