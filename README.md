# Binance 5-Minute Crypto Scanner & Auto Trader

A production-structured web application combining Binance Spot market scanning, multi-timeframe technical indicator analysis, automatic PRE_BULLISH entry and WEAKENING exit strategy execution, persistent Paper Trading wallet, and live Binance Spot auto-trading with strict risk safety controls.

---

## 🌟 Key Features

1. **Binance Spot Market Scanner**
   - Continuously scans active, liquid USDT pairs on Binance every 5 minutes.
   - Computes closed 5m, 15m, 1h, and 4h candles.
2. **Complete Technical Indicators Suite**
   - EMA (9, 21, 50, 200) & SMA (20, 50, 200)
   - RSI (14 with Wilder smoothing)
   - MACD (12, 26, 9)
   - Bollinger Bands (20, 2)
   - ATR (14) & VWAP
   - Volume SMA (20) & Volume Ratio
3. **Candlestick Patterns & Market Structure**
   - Detects Doji, Hammer, Inverted Hammer, Shooting Star, Bullish/Bearish Engulfing, Harami, Morning Star, Evening Star, Three White Soldiers, Three Black Crows.
   - Evaluates Swing Highs/Lows, Support & Resistance clusters, Higher Highs/Higher Lows, and Breakout/Breakdown states.
4. **Deterministic 0–100 Technical Setup Score**
   - Multi-timeframe trend alignment, momentum, volume ratio, EMA stacks, RSI context, MACD structure, market structure, candle patterns, and breakout volatility.
5. **Fixed Trade Amount Invariant (`requestedQuoteAmount === currentFixedTradeAmount`)**
   - Every single new automated BUY strictly utilizes your exact configured fixed USDT amount (e.g. `100.00 USDT`).
   - Sizing never scales dynamically with wallet growth, compounding, or losses.
6. **Isolated Paper & Real Trading Engines**
   - **Paper Mode**: Real Binance market prices + configurable slippage (5 bps) + 0.1% fees, starting with a persistent 1000 USDT paper wallet.
   - **Real Mode**: Connects to Binance Spot via encrypted API keys (AES-256-GCM at rest), placing real market orders with lot size and min notional checks.
   - Paper data, positions, orders, and ledger remain completely isolated from Real Binance data.
7. **Risk Safety Gate & Emergency Stop**
   - Server-enforced safety checks before every buy/sell: reserve preservation, max position limit (default 5), 30m symbol re-entry cooldown, clock drift sync, and duplicate order prevention.
   - Emergency Stop halts automatic trading instantly without liquidating existing holdings.
8. **Wallet Reconciliation & External Holdings Protection**
   - Mismatches trigger automatic auto-trading pause.
   - Pre-existing cryptocurrency balances on Binance are tagged as `EXTERNAL HOLDINGS` and never automatically liquidated.

---

## 🛠️ Architecture

```text
React SPA (Vite + Tailwind CSS + Canvas Charts)
       │
       ▼  REST API + Server-Sent Events (SSE)
Express Node.js Backend (server.ts)
       │
       ├── AutoTradingEngine (5m scheduler & scan loop)
       ├── StrategyEngine (Multi-timeframe scoring & state transitions)
       ├── SafetyGate (Server-side risk & invariant verification)
       ├── PaperTradingExecutor (Simulated ledger against live Binance data)
       ├── RealBinanceTradingExecutor (Signed Binance Spot REST API)
       ├── BinanceRequestManager (Rate limiter, concurrency queue, backoff)
       └── Storage (Thread-safe JSON atomic persistence & AES-256-GCM encryption)
```

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` or configure the following variables:

```bash
# Server & Runtime
PORT=3000
NODE_ENV=production

# Binance API Base URL
BINANCE_API_BASE_URL=https://api.binance.com

# 5-Minute Scanner Settings
SCAN_INTERVAL_MS=300000
DEFAULT_INTERVAL=5m
MAX_SYMBOLS_PER_SCAN=100
MIN_24H_VOLUME=1000000
CANDLE_LIMIT=250
REQUEST_CONCURRENCY=8

# Paper Trading Defaults
PAPER_STARTING_BALANCE=1000
PAPER_FEE_RATE=0.001
PAPER_SLIPPAGE_BPS=5

# Fixed Trade Sizing & Risk Controls
DEFAULT_FIXED_TRADE_AMOUNT=100
MAX_TRADE_AMOUNT=10000
MAX_OPEN_POSITIONS=5
MIN_USDT_RESERVE=100
SYMBOL_COOLDOWN_MINUTES=30

# Strategy Thresholds
PRE_BULLISH_SCORE_MIN=65
STRONG_BULLISH_SCORE_MIN=80
WEAKENING_THRESHOLD=70

# Security (AES-256-GCM key derivation)
CREDENTIAL_ENCRYPTION_KEY=
```

---

## 🚀 Getting Started

### Development
```bash
npm install
npm run dev
```

### Running Automated Tests
```bash
npm test
```

### Production Build & Run
```bash
npm run build
npm start
```

---

## 🔐 Binance API Security Guidelines

1. In Binance API Management, create an API Key.
2. Enable permissions:
   - **Enable Reading**
   - **Enable Spot & Margin Trading**
3. **DO NOT enable Withdrawals** (the application requires only Spot trading permissions and will show a prominent security warning if withdrawal is enabled).
4. Restrict IP access to your server's trusted static IP when hosting in production.
5. All credentials saved via the application are encrypted at rest using authenticated **AES-256-GCM** encryption. Secrets are never exposed to the frontend browser runtime or log outputs.
