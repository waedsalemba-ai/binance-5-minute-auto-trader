# Binance 5-Minute Crypto Scanner & 24/7 Auto Trader (Production Web Application)

A hardened, 24/7 production web application combining Binance Spot market scanning, multi-timeframe technical indicator analysis, centralized bullish entry execution (`PRE_BULLISH` & `STRONG_BULLISH`), authoritative Net PnL exit architecture (`Take-Profit`, `Stop-Loss`, and `Technical Profit Exit`), persistent Paper Trading wallet, and live Binance Spot auto-trading with server-side security.

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
                       ▼
                Binance Spot API
                       │
                       ▼
            Persistent Storage (/data)
           ├── database.json (atomic)
           └── master.key (0600 mode)
```

The browser acts **strictly as an administrative dashboard**. Closing the browser, turning off your computer, or disconnecting does **NOT** interrupt market scanning, automated entry execution, TP/SL monitoring, or trade tracking.

---

## 🚀 Render 24/7 Deployment Step-by-Step Guide

### Step 1: Push Code to GitHub
Ensure all files including `render.yaml`, `package.json`, and source code are committed to your GitHub repository.

### Step 2: Create a Web Service on Render
1. Log in to your [Render Dashboard](https://dashboard.render.com).
2. Click **New +** and select **Web Service**.
3. Connect your GitHub repository containing this project.

### Step 3: Configure Build & Start Commands
- **Runtime**: `Node`
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`
- **Health Check Path**: `/health`

### Step 4: Attach a Persistent Disk
1. In your Render Web Service settings, scroll down to **Disks**.
2. Click **Add Disk**.
3. Set:
   - **Name**: `trader-data`
   - **Mount Path**: `/data`
   - **Size**: `1 GB` (Standard)

### Step 5: Configure Environment Variables
In the **Environment** tab, set:
```bash
NODE_ENV=production
PORT=10000
DATA_DIR=/data
APP_ORIGIN=https://YOUR-APP.onrender.com
ALLOWED_ORIGINS=https://YOUR-APP.onrender.com

# Administrative Auth & Encryption
ADMIN_TOKEN=GENERATE_A_LONG_RANDOM_SECRET_KEY
CREDENTIAL_ENCRYPTION_KEY=GENERATE_32_BYTE_HEX_OR_PASSPHRASE

# Live Trading Protection Guard (Default: false)
LIVE_TRADING_ENABLED=false

# Exit Architecture Parameters
TAKE_PROFIT_PERCENT=2.0
STOP_LOSS_PERCENT=3.0
MIN_PROFIT_TO_TECHNICAL_EXIT_PERCENT=0.20
MAX_EXIT_PRICE_AGE_MS=5000

# Strategy Entry Parameters
PRE_BULLISH_SCORE_MIN=65
STRONG_BULLISH_SCORE_MIN=80
WEAKENING_THRESHOLD=70
```

### Step 6: Deploy & Verify
1. Click **Create Web Service** / **Deploy**.
2. Test the public health endpoint:
   ```bash
   curl https://YOUR-APP.onrender.com/health
   ```
   Response: `{"status":"ok","service":"binance-5-minute-auto-trader","timestamp":"..."}`
3. Test the readiness endpoint:
   ```bash
   curl https://YOUR-APP.onrender.com/ready
   ```
   Response: `{"ready":true,"server":true,"storage":true,"scanner":true,...}`
4. Open `https://YOUR-APP.onrender.com` in your browser.
5. Verify Paper Trading mode operations, scanning, and order triggers.
6. Restart the Render Web Service and verify that positions, trade history, paper wallet, and settings are 100% preserved.

---

## 🔒 Security Architecture & Guarantees

1. **Zero Secret Exposure**:
   - `ADMIN_TOKEN`, `BINANCE_API_SECRET`, and `CREDENTIAL_ENCRYPTION_KEY` never leak into frontend bundles, HTML, URL parameters, SSE logs, or client state.
2. **Restricted CORS & Security Headers**:
   - Strict origin validation in production matching `ALLOWED_ORIGINS`.
   - `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`.
3. **Live Trading Guard (`LIVE_TRADING_ENABLED`)**:
   - Live trading requires `LIVE_TRADING_ENABLED=true` in server environment variables.
   - Any attempt to submit real Binance orders while `LIVE_TRADING_ENABLED != true` is rejected by both `SafetyGate` and `RealBinanceTradingExecutor`.
4. **Crash-Safe Atomic Storage**:
   - Database writes are executed via temporary files, disk fsync (`fs.fsyncSync`), and atomic file renames to prevent corruption during unexpected shutdowns.

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

## 🧪 Automated Test Suite

Run the full automated test suite covering all indicators, entry engine, exit architecture, storage, and authentication contracts:
```bash
npm test
```
