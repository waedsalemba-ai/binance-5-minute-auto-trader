import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Activity,
  Layers,
  Zap,
  Clock,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
  ArrowRight,
  Flame,
  RotateCcw,
  Globe,
  CheckCircle2,
  XCircle,
  Server,
  Cpu,
} from 'lucide-react';
import {
  WalletBalance,
  Position,
  ScannerSummary,
  TechnicalAnalysis,
  TradingMode,
  SpotMarketStatusData,
  ServerEngineStatus,
} from '../types/index.ts';

interface DashboardViewProps {
  mode: TradingMode;
  wallet: WalletBalance;
  positions: Position[];
  summary: ScannerSummary;
  analyses: TechnicalAnalysis[];
  fixedTradeAmount: number;
  autoTrading: boolean;
  onRunScan: () => void;
  isScanning: boolean;
  onSelectSymbol: (symbol: string) => void;
  onOpenSellModal: (pos: Position) => void;
  onOpenResetModal?: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  mode,
  wallet,
  positions,
  summary,
  analyses,
  fixedTradeAmount,
  autoTrading,
  onRunScan,
  isScanning,
  onSelectSymbol,
  onOpenSellModal,
  onOpenResetModal,
}) => {
  const [secondsToNextScan, setSecondsToNextScan] = useState<number>(0);
  const [spotStatus, setSpotStatus] = useState<SpotMarketStatusData | null>(null);
  const [engineStatus, setEngineStatus] = useState<ServerEngineStatus | null>(null);
  const [isServerConnected, setIsServerConnected] = useState<boolean>(true);

  const fetchTelemetry = async () => {
    try {
      const [spotRes, engineRes] = await Promise.allSettled([
        fetch('/api/market/spot-status'),
        fetch('/api/engine/status'),
      ]);

      if (spotRes.status === 'fulfilled' && spotRes.value.ok) {
        const json = await spotRes.value.json();
        if (json.success && json.data) {
          setSpotStatus(json.data);
        }
      }

      if (engineRes.status === 'fulfilled' && engineRes.value.ok) {
        const json = await engineRes.value.json();
        if (json.success && json.data) {
          setEngineStatus(json.data);
          setIsServerConnected(true);
        }
      }
    } catch {
      setIsServerConnected(false);
    }
  };

  useEffect(() => {
    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const updateCountdown = () => {
      if (summary.nextScanTime) {
        const diff = Math.max(0, Math.floor((summary.nextScanTime - Date.now()) / 1000));
        setSecondsToNextScan(diff);
      }
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [summary.nextScanTime]);

  const activePositions = positions.filter(p => p.mode === mode && p.status === 'OPEN');
  const preBullishSymbols = analyses.filter(a => a.strategyState === 'PRE_BULLISH');
  const strongBullishSymbols = analyses.filter(a => a.strategyState === 'STRONG_BULLISH');
  const weakeningSymbols = analyses.filter(a => a.strategyState === 'WEAKENING');

  const formatSec = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="space-y-6">
      {/* Banner / Mode Status Alert */}
      <div className={`p-4 rounded-2xl border flex flex-wrap items-center justify-between gap-4 ${
        mode === 'REAL'
          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
          : 'bg-slate-900/80 border-slate-800 text-slate-300'
      }`}>
        <div className="flex items-center gap-3">
          <div className={`p-2.5 rounded-xl ${mode === 'REAL' ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-slate-100">
                {mode === 'REAL' ? 'LIVE BINANCE SPOT TRADING' : 'SIMULATED PAPER TRADING'}
              </span>
              <span className={`text-[11px] font-mono px-2 py-0.5 rounded font-semibold ${
                autoTrading ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
              }`}>
                Auto: {autoTrading ? 'ACTIVE' : 'IDLE'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Strategy Sizing Model: <strong className="text-amber-400 font-mono">{fixedTradeAmount.toFixed(2)} USDT</strong> per new trade. Paper & Real modes remain completely isolated.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {onOpenResetModal && (
            <button
              onClick={onOpenResetModal}
              title="Reset all active positions and restore wallet balance to default 1000 USDT"
              className="px-3.5 py-1.5 text-xs font-bold bg-amber-500/15 hover:bg-amber-400 text-amber-400 hover:text-slate-950 rounded-xl border border-amber-500/30 transition-all flex items-center gap-1.5 shadow-sm"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Positions & Balance</span>
            </button>
          )}

          <button
            onClick={onRunScan}
            disabled={isScanning}
            className="px-3.5 py-1.5 text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition-all flex items-center gap-2"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-amber-400' : ''}`} />
            {isScanning ? 'Scanning Markets...' : 'Scan Now (2m)'}
          </button>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        {/* Total Equity */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Total Equity</span>
          <div className="text-xl sm:text-2xl font-black font-mono text-slate-100 mt-1">
            ${(wallet.totalEquity ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono">
            Avail: ${(wallet.usdtAvailable ?? 0).toFixed(2)}
          </div>
        </div>

        {/* Available USDT */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Available USDT</span>
          <div className="text-xl sm:text-2xl font-black font-mono text-emerald-400 mt-1">
            ${(wallet.usdtAvailable ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono">
            Allocated: ${(wallet.accountAssetValue ?? 0).toFixed(2)}
          </div>
        </div>

        {/* Unrealized PnL */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Unrealized PnL</span>
          <div className={`text-xl sm:text-2xl font-black font-mono mt-1 ${(wallet.unrealizedPnL ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {(wallet.unrealizedPnL ?? 0) >= 0 ? '+' : ''}${(wallet.unrealizedPnL ?? 0).toFixed(2)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Across {activePositions.length} active positions
          </div>
        </div>

        {/* Realized PnL */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Realized PnL</span>
          <div className={`text-xl sm:text-2xl font-black font-mono mt-1 ${(wallet.realizedPnL ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {(wallet.realizedPnL ?? 0) >= 0 ? '+' : ''}${(wallet.realizedPnL ?? 0).toFixed(2)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Fees paid: ${(wallet.totalFeesPaid ?? 0).toFixed(2)}
          </div>
        </div>

        {/* Open Positions */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Open Positions</span>
          <div className="text-xl sm:text-2xl font-black font-mono text-slate-100 mt-1">
            {activePositions.length} <span className="text-sm font-normal text-slate-500">/ 5 max</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono">
            {mode} Mode
          </div>
        </div>

        {/* Next 2m Scan */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium flex items-center justify-between">
            <span>Next Scan</span>
            <Clock className="w-3.5 h-3.5 text-amber-400" />
          </span>
          <div className="text-xl sm:text-2xl font-black font-mono text-amber-400 mt-1">
            {isScanning ? 'SCANNING' : formatSec(secondsToNextScan)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            2m interval sync
          </div>
        </div>
      </div>

      {/* 24/7 Server-Side Trading Engine & Scheduler Status Authority (Requirement 20) */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
              <Server className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                24/7 Server-Side Trading Engine & Scheduler Authority
              </h3>
              <p className="text-[11px] text-slate-400">
                Independent backend process on Render. Continues scanning, candle evaluation, TP/SL exits, and execution 24/7 even when browser is closed.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-mono px-2.5 py-1 rounded-lg font-bold flex items-center gap-1.5 ${
              isServerConnected
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
            }`}>
              <span className={`w-2 h-2 rounded-full ${isServerConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
              <span>SERVER: {isServerConnected ? 'CONNECTED' : 'DISCONNECTED'}</span>
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 text-xs font-mono">
          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">TRADING ENGINE</div>
            <div className={`font-bold mt-0.5 ${engineStatus?.tradingEngine === 'RUNNING' ? 'text-emerald-400' : 'text-slate-400'}`}>
              {engineStatus?.tradingEngine || 'RUNNING'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">SCHEDULER</div>
            <div className={`font-bold mt-0.5 ${engineStatus?.scheduler === 'RUNNING' ? 'text-emerald-400' : 'text-slate-400'}`}>
              {engineStatus?.scheduler || 'RUNNING'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">AUTO TRADING</div>
            <div className={`font-bold mt-0.5 ${autoTrading ? 'text-emerald-400' : 'text-slate-400'}`}>
              {autoTrading ? 'ON' : 'OFF'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">MODE</div>
            <div className={`font-bold mt-0.5 ${mode === 'REAL' ? 'text-amber-400' : 'text-sky-400'}`}>
              {mode}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">LAST SCAN</div>
            <div className="font-bold text-slate-300 mt-0.5 truncate">
              {engineStatus?.lastScanAt ? new Date(engineStatus.lastScanAt).toLocaleTimeString() : 'Active'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">LAST CLOSED 5M</div>
            <div className="font-bold text-amber-400 mt-0.5 truncate">
              {engineStatus?.lastClosed5mCandleAt ? new Date(engineStatus.lastClosed5mCandleAt).toLocaleTimeString() : 'Synced'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">LAST ENTRY CHECK</div>
            <div className="font-bold text-slate-300 mt-0.5 truncate">
              {engineStatus?.lastEntryEvaluationAt ? new Date(engineStatus.lastEntryEvaluationAt).toLocaleTimeString() : 'Evaluating'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">BINANCE SYMBOLS</div>
            <div className="font-bold text-emerald-400 mt-0.5">
              {engineStatus?.validBinanceSymbols || spotStatus?.symbolsCount || 0} Spot
            </div>
          </div>
        </div>
      </div>

      {/* Live Binance Spot Market & Validation Status Card */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400">
              <Globe className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
                Live Binance Spot Market & Validation Authority
              </h3>
              <p className="text-[11px] text-slate-400">
                Authoritative exchangeInfo metadata caching (5m TTL), delisted token protection, and Spot trading guard rails.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className={`text-[11px] font-mono px-2.5 py-1 rounded-lg font-bold flex items-center gap-1.5 ${
              spotStatus?.liveTradingReady
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-slate-800 text-slate-400 border border-slate-700'
            }`}>
              {spotStatus?.liveTradingReady ? (
                <>
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  <span>Live Trading Ready</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-3 h-3 text-slate-400" />
                  <span>{mode === 'REAL' ? 'Live Guard Active' : 'Paper Mode Active'}</span>
                </>
              )}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs font-mono">
          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">Binance API</div>
            <div className={`font-bold mt-0.5 flex items-center gap-1 ${spotStatus?.connected || spotStatus?.spotMarketAvailable ? 'text-emerald-400' : 'text-slate-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${spotStatus?.connected || spotStatus?.spotMarketAvailable ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
              <span>{spotStatus?.connected ? 'Connected' : 'Public Active'}</span>
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">API Can Trade</div>
            <div className={`font-bold mt-0.5 ${spotStatus?.canTrade ? 'text-emerald-400' : 'text-slate-400'}`}>
              {spotStatus?.canTrade ? 'Can Trade (YES)' : 'Cannot Trade (NO)'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">Spot Market</div>
            <div className={`font-bold mt-0.5 ${spotStatus?.spotMarketAvailable ? 'text-emerald-400' : 'text-rose-400'}`}>
              {spotStatus?.spotMarketAvailable ? `Available (${spotStatus.symbolsCount})` : 'Unavailable'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">Last exchangeInfo</div>
            <div className="font-bold text-slate-300 mt-0.5 truncate">
              {spotStatus?.lastExchangeInfoRefresh ? new Date(spotStatus.lastExchangeInfoRefresh).toLocaleTimeString() : 'Refreshing...'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">Last Validated Symbol</div>
            <div className="font-bold text-amber-400 mt-0.5 truncate">
              {spotStatus?.lastValidatedSymbol || 'Ready (None)'}
            </div>
          </div>

          <div className="p-2.5 bg-slate-900/80 border border-slate-800/80 rounded-xl">
            <div className="text-slate-500 text-[10px]">Last Error / Guard</div>
            <div className={`font-bold mt-0.5 truncate ${spotStatus?.lastValidationError ? 'text-rose-400' : 'text-emerald-400'}`}>
              {spotStatus?.lastValidationError || 'None (Passing)'}
            </div>
          </div>
        </div>
      </div>

      {/* Main Split: Scanner Summary & Signal Radar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Signal Radar & Scanner State */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              2-Minute Scanner Telemetry
            </h3>
            <span className="text-xs font-mono text-slate-400">
              {summary.pairsAnalyzed} USDT pairs
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl">
              <div className="text-slate-400 text-[11px]">PRE-BULLISH (Buy Zone)</div>
              <div className="text-lg font-bold text-sky-400 mt-0.5">{summary?.preBullishCount ?? 0}</div>
            </div>
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl">
              <div className="text-slate-400 text-[11px]">STRONG BULLISH (Holding)</div>
              <div className="text-lg font-bold text-emerald-400 mt-0.5">{summary?.strongBullishCount ?? 0}</div>
            </div>
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl">
              <div className="text-slate-400 text-[11px]">WEAKENING (Exit Zone)</div>
              <div className="text-lg font-bold text-rose-400 mt-0.5">{summary?.weakeningCount ?? 0}</div>
            </div>
            <div className="p-3 bg-slate-900/80 border border-slate-800 rounded-xl">
              <div className="text-slate-400 text-[11px]">BULLISH / NEUTRAL</div>
              <div className="text-lg font-bold text-slate-400 mt-0.5">{(summary?.bullishCount ?? 0) + (summary?.neutralCount ?? 0)}</div>
            </div>
          </div>

          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-3 text-xs text-slate-400 space-y-1.5">
            <div className="flex justify-between font-mono">
              <span>Strategy Invariant:</span>
              <span className="text-amber-400 font-bold">{(fixedTradeAmount ?? 0).toFixed(2)} USDT per BUY</span>
            </div>
            <div className="flex justify-between font-mono">
              <span>Max Simultaneous Positions:</span>
              <span className="text-slate-200">5 symbols</span>
            </div>
            <div className="flex justify-between font-mono">
              <span>Post-Sell Cooldown:</span>
              <span className="text-slate-200">30 minutes</span>
            </div>
          </div>
        </div>

        {/* Current Pre-Bullish Signals (Candidates for Buy) */}
        <div className="lg:col-span-2 bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
              <Flame className="w-4 h-4 text-sky-400" />
              Pre-Bullish Setups (Entry Opportunities)
            </h3>
            <span className="text-xs text-slate-400">Score &ge; 65</span>
          </div>

          {preBullishSymbols.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500 bg-slate-900/40 rounded-xl border border-dashed border-slate-800">
              No symbols currently in PRE_BULLISH setup state. Scanner runs continuously every 2 minutes.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {preBullishSymbols.slice(0, 4).map(item => (
                <div
                  key={item.symbol}
                  onClick={() => onSelectSymbol(item.symbol)}
                  className="p-3 bg-slate-900/80 hover:bg-slate-800/80 border border-slate-800 rounded-xl cursor-pointer transition-all group"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-bold text-slate-100 group-hover:text-amber-400 transition-colors">
                      {item.symbol}
                    </span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-500/10 text-sky-400 border border-sky-500/20">
                      Score {item.score ?? 0}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                    <span>${item.price ?? 0}</span>
                    <span className={(item.priceChange24h ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {(item.priceChange24h ?? 0) >= 0 ? '+' : ''}{(item.priceChange24h ?? 0).toFixed(2)}%
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-2 line-clamp-1">
                    {item.stateReason || ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Active Open Positions Table */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
            <Layers className="w-4 h-4 text-emerald-400" />
            Active Strategy Positions ({activePositions.length})
          </h3>
          <span className="text-xs font-mono text-slate-400">
            Isolated {mode} Positions
          </span>
        </div>

        {activePositions.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500 bg-slate-900/40 rounded-xl border border-dashed border-slate-800">
            No active positions open in {mode} mode. When a symbol triggers PRE_BULLISH and passes the Safety Gate, a fixed {(fixedTradeAmount ?? 0).toFixed(2)} USDT position will open.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 font-mono">
                  <th className="py-2.5 px-3">Symbol</th>
                  <th className="py-2.5 px-3">Entry / Qty</th>
                  <th className="py-2.5 px-3">Entry Price</th>
                  <th className="py-2.5 px-3">Current Price</th>
                  <th className="py-2.5 px-3">Break-Even / TP / SL</th>
                  <th className="py-2.5 px-3">Est. Net PnL</th>
                  <th className="py-2.5 px-3">Score & State</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {activePositions.map(pos => {
                  const netPnL = pos.estimatedNetPnL ?? pos.unrealizedPnL ?? 0;
                  const netPnLPercent = pos.estimatedNetPnLPercent ?? pos.unrealizedPnLPercent ?? 0;
                  return (
                    <tr key={pos.id} className="hover:bg-slate-900/40 transition-colors">
                      <td className="py-3 px-3 font-bold text-slate-100">{pos.symbol}</td>
                      <td className="py-3 px-3">
                        <div className="text-amber-400">{pos.entryQuoteAmount ?? 0} USDT</div>
                        <div className="text-[10px] text-slate-500">Qty: {pos.remainingQuantity ?? 0}</div>
                      </td>
                      <td className="py-3 px-3 text-slate-300">${pos.entryPrice ?? 0}</td>
                      <td className="py-3 px-3 text-slate-100 font-bold">${pos.currentPrice ?? 0}</td>
                      <td className="py-3 px-3 text-[11px]">
                        <div><span className="text-slate-500">BE:</span> <span className="text-amber-400">${pos.breakEvenPrice ?? '-'}</span></div>
                        <div><span className="text-slate-500">TP:</span> <span className="text-emerald-400">${pos.takeProfitPrice ?? '-'}</span> | <span className="text-slate-500">SL:</span> <span className="text-rose-400">${pos.stopLossPrice ?? '-'}</span></div>
                      </td>
                      <td className={`py-3 px-3 font-bold ${netPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {netPnL >= 0 ? '+' : ''}${netPnL.toFixed(2)} ({netPnLPercent >= 0 ? '+' : ''}{netPnLPercent}%)
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-300 font-bold">{pos.currentScore ?? 0}</span>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            pos.currentState === 'STRONG_BULLISH'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                              : pos.currentState === 'WEAKENING'
                              ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                              : 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                          }`}>
                            {pos.currentState}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right space-x-2">
                        <button
                          onClick={() => onSelectSymbol(pos.symbol)}
                          className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
                        >
                          Chart
                        </button>
                        <button
                          onClick={() => onOpenSellModal(pos)}
                          className="px-2.5 py-1 text-[11px] bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/30 rounded font-bold"
                        >
                          Sell
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
