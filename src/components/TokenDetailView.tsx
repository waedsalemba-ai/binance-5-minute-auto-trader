import React, { useState, useEffect } from 'react';
import {
  ArrowLeft,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Layers,
  Shield,
  Activity,
  Zap,
  Info,
  DollarSign,
  BarChart2,
} from 'lucide-react';
import { Candle, TechnicalAnalysis, Position, TradingMode } from '../types/index.ts';
import { CandleChart } from './CandleChart.tsx';

interface TokenDetailViewProps {
  symbol: string;
  analysis: TechnicalAnalysis | undefined;
  positions: Position[];
  mode: TradingMode;
  onBack: () => void;
  onOpenSellModal: (pos: Position) => void;
}

export const TokenDetailView: React.FC<TokenDetailViewProps> = ({
  symbol,
  analysis,
  positions,
  mode,
  onBack,
  onOpenSellModal,
}) => {
  const [interval, setIntervalState] = useState<'5m' | '15m' | '1h' | '4h'>('5m');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const fetchCandles = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/candles/${symbol}?interval=${interval}&limit=120`);
        const json = await res.json();
        if (json.success && isMounted) {
          setCandles(json.data);
        }
      } catch (err) {
        console.error('Candle fetch error:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    fetchCandles();
    return () => {
      isMounted = false;
    };
  }, [symbol, interval]);

  const activePosition = positions.find(
    p => p.symbol === symbol && p.mode === mode && p.status === 'OPEN'
  );

  return (
    <div className="space-y-6">
      {/* Top Bar Navigation & Quick Stats */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-2 text-slate-400 hover:text-slate-100 bg-slate-900 border border-slate-800 rounded-xl transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-xl font-black text-slate-100 font-mono">{symbol}</h2>
              {analysis && (
                <span className={`px-2.5 py-0.5 rounded text-xs font-mono font-bold ${
                  analysis.strategyState === 'STRONG_BULLISH'
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : analysis.strategyState === 'PRE_BULLISH'
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                    : analysis.strategyState === 'WEAKENING'
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}>
                  {analysis.strategyState}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs font-mono text-slate-400 mt-1">
              <span>Spot Live</span>
              <span>•</span>
              <span>24h Quote Vol: ${((analysis?.quoteVolume24h || 0) / 1e6).toFixed(2)}M</span>
            </div>
          </div>
        </div>

        {/* Live Price & Change */}
        {analysis && (
          <div className="flex items-center gap-6">
            <div>
              <div className="text-2xl font-black font-mono text-slate-100">${analysis.price}</div>
              <div className={`text-xs font-mono font-bold flex items-center gap-1 ${
                analysis.priceChange24h >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}>
                {analysis.priceChange24h >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                {analysis.priceChange24h >= 0 ? '+' : ''}{analysis.priceChange24h.toFixed(2)}%
              </div>
            </div>

            {/* Timeframe Selector */}
            <div className="flex items-center p-1 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono">
              {(['5m', '15m', '1h', '4h'] as const).map(tf => (
                <button
                  key={tf}
                  onClick={() => setIntervalState(tf)}
                  className={`px-3 py-1.5 rounded-lg font-bold transition-colors ${
                    interval === tf
                      ? 'bg-amber-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Active Position Banner if Held */}
      {activePosition && (
        <div className="p-4 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/30 rounded-2xl flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-amber-500/20 text-amber-400 rounded-xl">
              <Layers className="w-6 h-6" />
            </div>
            <div className="text-xs font-mono">
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-100 text-sm">Active Strategy Position</span>
                <span className="px-2 py-0.2 rounded bg-amber-400/20 text-amber-300 font-bold text-[10px]">
                  {activePosition.mode}
                </span>
              </div>
              <div className="text-slate-400 mt-1 flex flex-wrap gap-4">
                <span>Fixed Entry Quote: <strong className="text-slate-200">{activePosition.entryQuoteAmount} USDT</strong></span>
                <span>Qty: <strong className="text-slate-200">{activePosition.remainingQuantity}</strong></span>
                <span>Entry Price: <strong className="text-slate-200">${activePosition.entryPrice}</strong></span>
                <span>Unrealized: <strong className={activePosition.unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  {activePosition.unrealizedPnL >= 0 ? '+' : ''}${activePosition.unrealizedPnL.toFixed(2)} ({activePosition.unrealizedPnLPercent}%)
                </strong></span>
              </div>
            </div>
          </div>

          <button
            onClick={() => onOpenSellModal(activePosition)}
            className="px-4 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-500 rounded-xl shadow-lg shadow-rose-600/20 transition-all"
          >
            Manual Market Sell
          </button>
        </div>
      )}

      {/* Candlestick Chart */}
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center rounded-xl">
            <RefreshCw className="w-8 h-8 text-amber-400 animate-spin" />
          </div>
        )}
        <CandleChart
          symbol={symbol}
          candles={candles}
          indicators={analysis?.indicators}
          supportLevels={analysis?.marketStructure.supportLevels}
          resistanceLevels={analysis?.marketStructure.resistanceLevels}
          height={440}
        />
      </div>

      {/* Analysis Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Technical Score Breakdown (0-100 Deterministic) */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              Technical Setup Score
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-black font-mono text-amber-400">
                {analysis?.score || 0}
              </span>
              <span className="text-xs text-slate-500 font-mono">/ 100</span>
            </div>
          </div>

          <p className="text-[11px] text-slate-400">
            Deterministic rule-based classification. Not a guarantee of profit.
          </p>

          <div className="space-y-2.5 text-xs font-mono">
            {analysis?.scoreComponents.map(comp => (
              <div key={comp.name} className="space-y-1">
                <div className="flex justify-between text-slate-300">
                  <span className="text-slate-400">{comp.name} (w:{comp.weight})</span>
                  <span className="font-bold text-slate-200">{comp.score} / {comp.weight}</span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-amber-400 rounded-full"
                    style={{ width: `${(comp.score / comp.weight) * 100}%` }}
                  />
                </div>
                <div className="text-[10px] text-slate-500">{comp.details}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Multi-Timeframe Alignment & Candle Patterns */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-5">
          <div>
            <h3 className="font-bold text-sm text-slate-100 mb-3 flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-sky-400" />
              Multi-Timeframe Alignment
            </h3>
            <div className="grid grid-cols-2 gap-2 text-xs font-mono">
              {(['5m', '15m', '1h', '4h'] as const).map(tf => {
                const signal = analysis?.multiTimeframe[tf];
                return (
                  <div key={tf} className="p-3 bg-slate-900 border border-slate-800 rounded-xl space-y-1">
                    <div className="flex justify-between text-slate-400 text-[11px]">
                      <span>{tf} Frame</span>
                      <span className="font-bold text-slate-300">{signal?.score || 50} pts</span>
                    </div>
                    <div className={`font-bold ${
                      signal?.trend === 'BULLISH' ? 'text-emerald-400' : signal?.trend === 'BEARISH' ? 'text-rose-400' : 'text-slate-400'
                    }`}>
                      {signal?.trend || 'NEUTRAL'}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      RSI: {signal?.rsi || 50} • MACD: {signal?.macdCross || 'NONE'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="font-bold text-sm text-slate-100 mb-2 flex items-center gap-2">
              <Activity className="w-4 h-4 text-purple-400" />
              Candlestick Patterns
            </h3>
            {(!analysis?.patterns || analysis.patterns.length === 0) ? (
              <div className="text-xs text-slate-500 p-3 bg-slate-900/60 rounded-xl border border-slate-800">
                No dominant candle patterns formed on the latest closed 5m bar.
              </div>
            ) : (
              <div className="space-y-2">
                {analysis.patterns.map(p => (
                  <div key={p.name} className="p-2.5 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono">
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-bold text-slate-200">{p.name}</span>
                      <span className={`px-2 py-0.2 rounded text-[10px] ${
                        p.type === 'BULLISH' ? 'bg-emerald-500/20 text-emerald-400' : p.type === 'BEARISH' ? 'bg-rose-500/20 text-rose-400' : 'bg-slate-800 text-slate-400'
                      }`}>
                        {p.type}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">{p.description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Market Structure, Support/Resistance & Strategy State */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4">
          <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-400" />
            Market Structure & Strategy
          </h3>

          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-2 text-xs font-mono">
            <div className="flex justify-between">
              <span className="text-slate-400">Trend:</span>
              <span className="font-bold text-slate-100">{analysis?.marketStructure.trend}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Structure:</span>
              <span className="text-slate-300">{analysis?.marketStructure.structure}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Breakout State:</span>
              <span className={analysis?.marketStructure.breakout !== 'NONE' ? 'text-amber-400 font-bold' : 'text-slate-400'}>
                {analysis?.marketStructure.breakout}
              </span>
            </div>
          </div>

          <div className="space-y-2 text-xs font-mono">
            <div className="text-slate-400 text-[11px]">Key Resistance Levels:</div>
            <div className="flex flex-wrap gap-1.5">
              {analysis?.marketStructure.resistanceLevels.map(r => (
                <span key={r} className="px-2 py-1 bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded">
                  ${r}
                </span>
              ))}
            </div>

            <div className="text-slate-400 text-[11px] pt-1">Key Support Levels:</div>
            <div className="flex flex-wrap gap-1.5">
              {analysis?.marketStructure.supportLevels.map(s => (
                <span key={s} className="px-2 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded">
                  ${s}
                </span>
              ))}
            </div>
          </div>

          <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-xs space-y-1">
            <div className="text-amber-400 font-bold font-mono">Auto Strategy Classification:</div>
            <p className="text-slate-300 text-[11px] leading-relaxed">
              {analysis?.stateReason || 'Continuous scanning in progress.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
