import React, { useState, useRef, useEffect } from 'react';
import { FileText, Search, Trash2, Shield, Filter, ArrowDown } from 'lucide-react';
import { SystemLogEntry, LogCategory, TradingMode } from '../types/index.ts';

interface LogsViewProps {
  logs: SystemLogEntry[];
  onClearLogs?: () => void;
}

export const LogsView: React.FC<LogsViewProps> = ({ logs, onClearLogs }) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const filteredLogs = logs.filter(entry => {
    if (selectedCategory !== 'ALL' && entry.category !== selectedCategory) {
      return false;
    }
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const matchMsg = entry.message.toLowerCase().includes(q);
      const matchSym = entry.symbol?.toLowerCase().includes(q);
      const matchCat = entry.category.toLowerCase().includes(q);
      return matchMsg || matchSym || matchCat;
    }
    return true;
  });

  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const getCategoryColor = (cat: LogCategory) => {
    switch (cat) {
      case 'ORDER':
        return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      case 'STRATEGY':
        return 'text-purple-400 bg-purple-500/10 border-purple-500/30';
      case 'SCAN':
        return 'text-sky-400 bg-sky-500/10 border-sky-500/30';
      case 'WALLET':
        return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      case 'BINANCE':
        return 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30';
      case 'SECURITY':
        return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
      case 'RECONCILIATION':
        return 'text-teal-400 bg-teal-500/10 border-teal-500/30';
      default:
        return 'text-slate-400 bg-slate-800 border-slate-700';
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Banner & Filter Controls */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-slate-800 rounded-xl text-amber-400">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-100">Live Structured Execution Logs</h2>
            <span className="text-[11px] text-slate-400 font-mono">
              Real-time SSE event stream • Secrets strictly redacted
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
            <input
              type="text"
              placeholder="Filter logs..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="pl-8 pr-3 py-1 text-xs bg-slate-900 border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-400 font-mono"
            />
          </div>

          <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer bg-slate-900 px-2.5 py-1 rounded-lg border border-slate-800 font-mono">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={e => setAutoScroll(e.target.checked)}
              className="rounded text-amber-400 focus:ring-0"
            />
            <span>Auto-scroll</span>
          </label>
        </div>
      </div>

      {/* Category Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 text-xs font-mono font-medium">
        {[
          'ALL',
          'ORDER',
          'STRATEGY',
          'SCAN',
          'WALLET',
          'BINANCE',
          'SECURITY',
          'RECONCILIATION',
          'INFO',
          'WARN',
          'ERROR',
        ].map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-2.5 py-1 rounded-lg whitespace-nowrap transition-colors ${
              selectedCategory === cat
                ? 'bg-amber-500 text-slate-950 font-bold'
                : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Terminal View */}
      <div className="bg-[#0b0e14] border border-slate-800 rounded-2xl p-4 font-mono text-xs shadow-2xl h-[560px] overflow-y-auto space-y-1.5">
        {filteredLogs.length === 0 ? (
          <div className="py-20 text-center text-slate-600">
            No system log entries recorded matching current filter.
          </div>
        ) : (
          filteredLogs.map(entry => {
            const timeStr = new Date(entry.timestamp).toISOString().split('T')[1].replace('Z', '');
            return (
              <div
                key={entry.id}
                className="flex items-start gap-2.5 py-1 px-2 rounded hover:bg-slate-900/60 transition-colors border-b border-slate-900/40"
              >
                <span className="text-slate-500 text-[11px] shrink-0">{timeStr}</span>
                <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold border shrink-0 ${getCategoryColor(entry.category)}`}>
                  {entry.category}
                </span>
                <span className={`px-1 rounded text-[10px] font-bold shrink-0 ${
                  entry.mode === 'REAL' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-800 text-slate-400'
                }`}>
                  {entry.mode}
                </span>

                {entry.symbol && (
                  <span className="text-amber-300 font-bold shrink-0">[{entry.symbol}]</span>
                )}

                {entry.strategyState && (
                  <span className="text-sky-400 text-[10px] shrink-0">{entry.strategyState}</span>
                )}

                <span className={`flex-1 break-words ${
                  entry.level === 'error'
                    ? 'text-rose-400 font-semibold'
                    : entry.level === 'warn'
                    ? 'text-amber-300'
                    : 'text-slate-300'
                }`}>
                  {entry.message}
                </span>
              </div>
            );
          })
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
};
