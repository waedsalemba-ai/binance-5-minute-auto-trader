import React, { useState, useMemo } from 'react';
import {
  Search,
  Filter,
  ArrowUpDown,
  Flame,
  Radio,
  ExternalLink,
  RefreshCw,
  SlidersHorizontal,
  Star,
} from 'lucide-react';
import { TechnicalAnalysis, StrategyState, Position, TradingMode } from '../types/index.ts';

interface ScannerViewProps {
  analyses: TechnicalAnalysis[];
  positions: Position[];
  mode: TradingMode;
  onSelectSymbol: (symbol: string) => void;
  onRunScan: () => void;
  isScanning: boolean;
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  analyses,
  positions,
  mode,
  onSelectSymbol,
  onRunScan,
  isScanning,
}) => {
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('binance_scanner_watchlist');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const toggleWatchlist = (symbol: string) => {
    setWatchlist(prev => {
      const next = prev.includes(symbol) ? prev.filter(s => s !== symbol) : [...prev, symbol];
      try {
        localStorage.setItem('binance_scanner_watchlist', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<'score' | 'change' | 'volume' | 'price'>('score');
  const [sortAsc, setSortAsc] = useState(false);

  const watchlistSymbolSet = useMemo(() => {
    return new Set(watchlist);
  }, [watchlist]);

  const activeSymbolSet = useMemo(() => {
    return new Set(positions.filter(p => p.mode === mode && p.status === 'OPEN').map(p => p.symbol));
  }, [positions, mode]);

  const filteredList = useMemo(() => {
    return analyses
      .filter(item => {
        if (searchTerm && !item.symbol.toLowerCase().includes(searchTerm.toLowerCase())) {
          return false;
        }
        if (stateFilter === 'WATCHLIST') {
          return watchlistSymbolSet.has(item.symbol);
        }
        if (stateFilter === 'POSITIONS') {
          return activeSymbolSet.has(item.symbol);
        }
        if (stateFilter !== 'ALL' && item.strategyState !== stateFilter) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        let diff = 0;
        if (sortBy === 'score') diff = b.score - a.score;
        else if (sortBy === 'change') diff = b.priceChange24h - a.priceChange24h;
        else if (sortBy === 'volume') diff = b.quoteVolume24h - a.quoteVolume24h;
        else if (sortBy === 'price') diff = b.price - a.price;
        return sortAsc ? -diff : diff;
      });
  }, [analyses, searchTerm, stateFilter, sortBy, sortAsc, activeSymbolSet, watchlistSymbolSet]);

  const getStateBadge = (state: StrategyState) => {
    switch (state) {
      case 'PRE_BULLISH':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30">PRE_BULLISH</span>;
      case 'STRONG_BULLISH':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">STRONG_BULLISH</span>;
      case 'BULLISH':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-teal-500/20 text-teal-400 border border-teal-500/30">BULLISH</span>;
      case 'WEAKENING':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30 animate-pulse">WEAKENING</span>;
      case 'EXIT':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-600/30 text-red-300 border border-red-500/40">EXIT</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">NEUTRAL</span>;
    }
  };

  const getTfPill = (tf?: { trend: string }) => {
    if (!tf) return <span className="text-slate-600">-</span>;
    if (tf.trend === 'BULLISH') return <span className="text-emerald-400 font-bold">▲</span>;
    if (tf.trend === 'BEARISH') return <span className="text-rose-400 font-bold">▼</span>;
    return <span className="text-slate-500">●</span>;
  };

  return (
    <div className="space-y-4">
      {/* Search, Filter Bar & Controls */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
        {/* State Filter Buttons */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
          {[
            { id: 'ALL', label: 'All Pairs' },
            { id: 'WATCHLIST', label: `★ Watchlist (${watchlist.length})` },
            { id: 'PRE_BULLISH', label: 'Pre-Bullish (Buy)' },
            { id: 'STRONG_BULLISH', label: 'Strong Bullish' },
            { id: 'WEAKENING', label: 'Weakening (Exit)' },
            { id: 'BULLISH', label: 'Bullish' },
            { id: 'POSITIONS', label: `My Positions (${activeSymbolSet.size})` },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setStateFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg transition-colors ${
                stateFilter === f.id
                  ? 'bg-amber-500 text-slate-950 font-bold shadow-md shadow-amber-500/20'
                  : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Search Input & Scan Trigger */}
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search symbol (e.g. BTC, SOL)..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-900 border border-slate-800 rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500 font-mono"
            />
          </div>

          <button
            onClick={onRunScan}
            disabled={isScanning}
            className="px-3.5 py-1.5 text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition-all flex items-center gap-2"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-amber-400' : ''}`} />
            <span className="hidden sm:inline">{isScanning ? 'Scanning...' : 'Scan Now'}</span>
          </button>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="bg-slate-900/90 border-b border-slate-800 text-slate-400 font-mono">
                <th className="py-3 px-3 cursor-pointer" onClick={() => { setSortBy('price'); setSortAsc(!sortAsc); }}>
                  Symbol
                </th>
                <th className="py-3 px-3 cursor-pointer" onClick={() => { setSortBy('price'); setSortAsc(!sortAsc); }}>
                  Price
                </th>
                <th className="py-3 px-3 cursor-pointer" onClick={() => { setSortBy('change'); setSortAsc(!sortAsc); }}>
                  24h Change
                </th>
                <th className="py-3 px-3 cursor-pointer" onClick={() => { setSortBy('volume'); setSortAsc(!sortAsc); }}>
                  24h Quote Vol
                </th>
                <th className="py-3 px-3 text-center">
                  MTF (5m|15m|1h|4h)
                </th>
                <th className="py-3 px-3">RSI-14</th>
                <th className="py-3 px-3">Vol Ratio</th>
                <th className="py-3 px-3">Structure</th>
                <th className="py-3 px-3 cursor-pointer" onClick={() => { setSortBy('score'); setSortAsc(!sortAsc); }}>
                  <div className="flex items-center gap-1">
                    <span>Score (0-100)</span>
                    <ArrowUpDown className="w-3 h-3 text-slate-500" />
                  </div>
                </th>
                <th className="py-3 px-3">Strategy State</th>
                <th className="py-3 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredList.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-slate-500">
                    No tokens match current filters. Check search term or run a fresh scan.
                  </td>
                </tr>
              ) : (
                filteredList.map(item => {
                  const hasPosition = activeSymbolSet.has(item.symbol);
                  const lastIdx = item.indicators.rsi14.length - 1;
                  const rsiVal = item.indicators.rsi14[lastIdx] || 50;

                  return (
                    <tr
                      key={item.symbol}
                      className={`hover:bg-slate-800/40 transition-colors ${
                        hasPosition ? 'bg-amber-500/5' : ''
                      }`}
                    >
                      {/* Symbol */}
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              toggleWatchlist(item.symbol);
                            }}
                            title={watchlistSymbolSet.has(item.symbol) ? 'Remove from Watchlist' : 'Add to Watchlist'}
                            className={`p-1 rounded hover:bg-slate-700/60 transition-colors ${
                              watchlistSymbolSet.has(item.symbol) ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'
                            }`}
                          >
                            <Star className={`w-3.5 h-3.5 ${watchlistSymbolSet.has(item.symbol) ? 'fill-amber-400' : ''}`} />
                          </button>
                          <span className="font-bold text-slate-100">{item.symbol}</span>
                          {hasPosition && (
                            <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-amber-500 text-slate-950">
                              POSITION
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Price */}
                      <td className="py-3 px-3 text-slate-200">
                        ${item.price}
                      </td>

                      {/* 24h Change */}
                      <td className={`py-3 px-3 font-bold ${
                        item.priceChange24h >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}>
                        {item.priceChange24h >= 0 ? '+' : ''}{item.priceChange24h.toFixed(2)}%
                      </td>

                      {/* 24h Volume */}
                      <td className="py-3 px-3 text-slate-400">
                        ${(item.quoteVolume24h / 1e6).toFixed(2)}M
                      </td>

                      {/* MTF Signals */}
                      <td className="py-3 px-3 text-center">
                        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-slate-900 rounded border border-slate-800 text-[10px]">
                          <span>5m:{getTfPill(item.multiTimeframe['5m'])}</span>
                          <span>15m:{getTfPill(item.multiTimeframe['15m'])}</span>
                          <span>1h:{getTfPill(item.multiTimeframe['1h'])}</span>
                          <span>4h:{getTfPill(item.multiTimeframe['4h'])}</span>
                        </div>
                      </td>

                      {/* RSI-14 */}
                      <td className="py-3 px-3">
                        <span className={rsiVal >= 70 ? 'text-rose-400 font-bold' : rsiVal <= 30 ? 'text-emerald-400 font-bold' : 'text-slate-300'}>
                          {rsiVal.toFixed(1)}
                        </span>
                      </td>

                      {/* Volume Ratio */}
                      <td className="py-3 px-3">
                        <span className={item.indicators.volumeRatio >= 1.5 ? 'text-amber-400 font-bold' : 'text-slate-400'}>
                          {item.indicators.volumeRatio}x
                        </span>
                      </td>

                      {/* Structure */}
                      <td className="py-3 px-3 text-slate-300 text-[11px]">
                        {item.marketStructure.trend}
                      </td>

                      {/* Score Bar */}
                      <td className="py-3 px-3 min-w-[120px]">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-100 w-6 text-right">{item.score}</span>
                          <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                item.score >= 80
                                  ? 'bg-emerald-400'
                                  : item.score >= 65
                                  ? 'bg-sky-400'
                                  : item.score >= 50
                                  ? 'bg-amber-400'
                                  : 'bg-slate-600'
                              }`}
                              style={{ width: `${item.score}%` }}
                            />
                          </div>
                        </div>
                      </td>

                      {/* Strategy State */}
                      <td className="py-3 px-3">
                        {getStateBadge(item.strategyState)}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-3 text-right">
                        <button
                          onClick={() => onSelectSymbol(item.symbol)}
                          className="px-2.5 py-1 text-[11px] bg-slate-800 hover:bg-slate-700 text-amber-400 rounded border border-slate-700 transition-colors font-bold"
                        >
                          Analyze
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
