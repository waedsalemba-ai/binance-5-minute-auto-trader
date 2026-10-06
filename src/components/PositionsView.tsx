import React from 'react';
import { Layers, TrendingUp, TrendingDown, Clock, ShieldAlert, BarChart3, AlertCircle, RotateCcw } from 'lucide-react';
import { Position, TradingMode } from '../types/index.ts';

interface PositionsViewProps {
  positions: Position[];
  mode: TradingMode;
  onSelectSymbol: (symbol: string) => void;
  onOpenSellModal: (pos: Position) => void;
  onOpenResetModal?: () => void;
}

export const PositionsView: React.FC<PositionsViewProps> = ({
  positions,
  mode,
  onSelectSymbol,
  onOpenSellModal,
  onOpenResetModal,
}) => {
  const currentPositions = positions.filter(p => p.mode === mode && p.status === 'OPEN');
  const totalAllocated = currentPositions.reduce((sum, p) => sum + (p.entryQuoteAmount || 0), 0);
  const totalCurrentValue = currentPositions.reduce((sum, p) => sum + (p.currentPrice || 0) * (p.remainingQuantity || 0), 0);
  const totalUnrealized = currentPositions.reduce((sum, p) => sum + (p.unrealizedPnL || 0), 0);

  const formatDuration = (openedAt: number) => {
    const diff = Math.max(0, Math.floor((Date.now() - openedAt) / 1000));
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Summary Cards */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <Layers className="w-5 h-5 text-amber-400" />
              Open Strategy Positions ({mode} Mode)
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Active positions managed by the 2-minute auto trader. Each new BUY is strictly sized to your fixed trade amount.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {onOpenResetModal && (
              <button
                onClick={onOpenResetModal}
                className="px-3.5 py-1.5 text-xs font-bold text-amber-400 hover:text-slate-950 bg-amber-500/15 hover:bg-amber-400 border border-amber-500/30 rounded-xl transition-all flex items-center gap-1.5 shadow-sm"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Positions & Balance</span>
              </button>
            )}

            <span className={`px-3 py-1.5 rounded-xl text-xs font-mono font-bold ${
              mode === 'REAL' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
            }`}>
              {mode} ISOLATION
            </span>
          </div>
        </div>

        {/* Summary Metric Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-800 text-xs font-mono">
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Total Fixed Capital Allocated:</span>
            <div className="text-base font-bold text-slate-100 mt-0.5">${totalAllocated.toFixed(2)} USDT</div>
          </div>
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Current Position Market Value:</span>
            <div className="text-base font-bold text-slate-100 mt-0.5">${totalCurrentValue.toFixed(2)} USDT</div>
          </div>
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Total Unrealized PnL:</span>
            <div className={`text-base font-bold mt-0.5 ${totalUnrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Positions Grid or Table */}
      {currentPositions.length === 0 ? (
        <div className="py-16 text-center bg-[#0f172a] border border-dashed border-slate-800 rounded-2xl space-y-3">
          <Layers className="w-10 h-10 text-slate-600 mx-auto" />
          <h3 className="text-sm font-bold text-slate-300">No Open Positions in {mode} Mode</h3>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            When the 2m scanner detects a validated PRE_BULLISH setup that satisfies the safety gate, a fixed trade amount BUY will execute automatically.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {currentPositions.map(pos => (
            <div
              key={pos.id}
              className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4 hover:border-slate-700 transition-colors shadow-lg"
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-black text-slate-100 font-mono">{pos.symbol}</span>
                    <span className="text-[10px] px-2 py-0.2 rounded font-mono font-bold bg-slate-800 text-slate-300">
                      {pos.mode}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500 font-mono flex items-center gap-1 mt-0.5">
                    <Clock className="w-3 h-3" /> Opened {formatDuration(pos.openedAt)} ago
                  </span>
                </div>

                <span className={`px-2.5 py-1 rounded text-xs font-mono font-bold ${
                  pos.currentState === 'STRONG_BULLISH'
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : pos.currentState === 'WEAKENING'
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30 animate-pulse'
                    : 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                }`}>
                  {pos.currentState}
                </span>
              </div>

              {/* Fixed Trade Amount Banner */}
              <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl flex justify-between items-center text-xs font-mono">
                <span className="text-amber-400 font-medium">Fixed Trade Amount:</span>
                <span className="text-slate-100 font-bold">{(pos.entryQuoteAmount ?? 0).toFixed(2)} USDT</span>
              </div>

              {/* Data Rows */}
              <div className="space-y-2 text-xs font-mono bg-slate-900/60 p-3.5 rounded-xl border border-slate-800/80 text-slate-300">
                <div className="flex justify-between">
                  <span className="text-slate-400">Position Quantity:</span>
                  <span className="text-slate-200">{pos.remainingQuantity}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Entry Price:</span>
                  <span className="text-slate-200">${pos.entryPrice}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Current Price:</span>
                  <span className="text-slate-100 font-bold">${pos.currentPrice}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Break-Even Price:</span>
                  <span className="text-amber-400 font-bold">${pos.breakEvenPrice ?? '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Take-Profit Price:</span>
                  <span className="text-emerald-400 font-bold">${pos.takeProfitPrice ?? '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Stop-Loss Price:</span>
                  <span className="text-rose-400 font-bold">${pos.stopLossPrice ?? '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Score Progress:</span>
                  <span>
                    <strong className="text-amber-400">{pos.currentScore}</strong>
                    <span className="text-slate-500 text-[10px] ml-1">(entry: {pos.entryScore})</span>
                  </span>
                </div>

                <div className="pt-2 border-t border-slate-800 space-y-1.5">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Current Gross PnL:</span>
                    <span className={(pos.grossPnL ?? pos.unrealizedPnL) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {(pos.grossPnL ?? pos.unrealizedPnL) >= 0 ? '+' : ''}${(pos.grossPnL ?? pos.unrealizedPnL).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between font-bold">
                    <span className="text-slate-200">Estimated Net PnL:</span>
                    <span className={(pos.estimatedNetPnL ?? pos.unrealizedPnL) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {(pos.estimatedNetPnL ?? pos.unrealizedPnL) >= 0 ? '+' : ''}${(pos.estimatedNetPnL ?? pos.unrealizedPnL).toFixed(2)} ({(pos.estimatedNetPnLPercent ?? pos.unrealizedPnLPercent) >= 0 ? '+' : ''}{pos.estimatedNetPnLPercent ?? pos.unrealizedPnLPercent}%)
                    </span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-800/80 flex justify-between items-center text-[11px]">
                  <span className="text-slate-400">Exit Status / Reason:</span>
                  <span className="text-amber-300 font-bold">
                    {pos.exitStatus ?? 'HOLD'}{pos.exitReason ? ` (${pos.exitReason})` : ''}
                  </span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => onSelectSymbol(pos.symbol)}
                  className="flex-1 py-2 text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl transition-colors flex items-center justify-center gap-1.5"
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                  View Chart
                </button>
                <button
                  onClick={() => onOpenSellModal(pos)}
                  className="flex-1 py-2 text-xs font-bold text-white bg-rose-600 hover:bg-rose-500 rounded-xl transition-all shadow-md shadow-rose-600/20"
                >
                  Sell Position
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
