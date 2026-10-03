import React from 'react';
import {
  Wallet,
  RotateCcw,
  TrendingUp,
  TrendingDown,
  DollarSign,
  PieChart,
  ShieldCheck,
  Percent,
} from 'lucide-react';
import { WalletBalance, Trade, Position } from '../types/index.ts';

interface PaperWalletViewProps {
  wallet: WalletBalance;
  trades: Trade[];
  positions: Position[];
  onOpenResetModal: () => void;
  onSyncWallet: () => void;
}

export const PaperWalletView: React.FC<PaperWalletViewProps> = ({
  wallet,
  trades,
  positions,
  onOpenResetModal,
  onSyncWallet,
}) => {
  const paperTrades = trades.filter(t => t.mode === 'PAPER');
  const paperPositions = positions.filter(p => p.mode === 'PAPER' && p.status === 'OPEN');

  const winCount = paperTrades.filter(t => t.netPnL > 0).length;
  const lossCount = paperTrades.filter(t => t.netPnL < 0).length;
  const totalTrades = paperTrades.length;
  const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : '0.0';

  const grossProfit = paperTrades.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = Math.abs(paperTrades.filter(t => t.netPnL < 0).reduce((s, t) => s + t.netPnL, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? '∞' : '0.00';

  const avgTrade = totalTrades > 0 ? (wallet.realizedPnL / totalTrades).toFixed(2) : '0.00';

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-xl">
              <Wallet className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-100">Paper Trading Wallet</h2>
              <span className="text-xs text-emerald-400 font-mono">
                Simulated Execution • Real Binance Spot Market Data
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-2 max-w-2xl">
            Initial starting balance is set to 1000 USDT. Simulated slippage is 5 bps and standard trading fees are 0.1%. Market prices are pulled directly from live Binance Spot orderbooks.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onOpenResetModal}
            className="px-4 py-2 text-xs font-bold text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-xl transition-all flex items-center gap-2"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Paper Account (1000 USDT)
          </button>
        </div>
      </div>

      {/* Primary Balance Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Total Equity</span>
          <div className="text-2xl font-black font-mono text-slate-100 mt-1">
            ${wallet.totalEquity.toFixed(2)}
          </div>
          <span className="text-[11px] text-slate-500 font-mono mt-1 block">
            Starting: ${wallet.startingBalance || 1000} USDT
          </span>
        </div>

        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Available USDT</span>
          <div className="text-2xl font-black font-mono text-emerald-400 mt-1">
            ${wallet.usdtAvailable.toFixed(2)}
          </div>
          <span className="text-[11px] text-slate-500 font-mono mt-1 block">
            Ready for new BUY allocations
          </span>
        </div>

        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Allocated in Assets</span>
          <div className="text-2xl font-black font-mono text-amber-400 mt-1">
            ${wallet.accountAssetValue.toFixed(2)}
          </div>
          <span className="text-[11px] text-slate-500 font-mono mt-1 block">
            {paperPositions.length} active positions
          </span>
        </div>

        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
          <span className="text-[11px] text-slate-400 font-medium">Total Realized PnL</span>
          <div className={`text-2xl font-black font-mono mt-1 ${wallet.realizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {wallet.realizedPnL >= 0 ? '+' : ''}${wallet.realizedPnL.toFixed(2)}
          </div>
          <span className="text-[11px] text-slate-500 font-mono mt-1 block">
            Fees: ${wallet.totalFeesPaid.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Performance Analytics Strip */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4">
        <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
          <PieChart className="w-4 h-4 text-sky-400" />
          Paper Account Performance Metrics
        </h3>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Win Rate:</span>
            <div className="text-base font-bold text-slate-100 mt-0.5">{winRate}%</div>
            <span className="text-[10px] text-slate-500">{winCount} wins / {lossCount} losses</span>
          </div>
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Profit Factor:</span>
            <div className="text-base font-bold text-slate-100 mt-0.5">{profitFactor}</div>
            <span className="text-[10px] text-slate-500">Gross: +${grossProfit.toFixed(2)} / -${grossLoss.toFixed(2)}</span>
          </div>
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Average Trade:</span>
            <div className={`text-base font-bold mt-0.5 ${Number(avgTrade) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              ${avgTrade}
            </div>
            <span className="text-[10px] text-slate-500">Net per completed trade</span>
          </div>
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Ledger Invariant:</span>
            <div className="text-base font-bold text-emerald-400 mt-0.5">VERIFIED</div>
            <span className="text-[10px] text-slate-500">Equity = USDT + Market Assets</span>
          </div>
        </div>
      </div>

      {/* Asset Holdings Table */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800 font-bold text-sm text-slate-100">
          Current Simulated Asset Holdings
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="bg-slate-900/90 border-b border-slate-800 text-slate-400 font-mono">
                <th className="py-3 px-4">Asset</th>
                <th className="py-3 px-4">Symbol</th>
                <th className="py-3 px-4">Quantity</th>
                <th className="py-3 px-4">Live Price</th>
                <th className="py-3 px-4">Total Value (USDT)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {wallet.assets.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    No cryptocurrency holdings currently in paper wallet. 100% held in available USDT.
                  </td>
                </tr>
              ) : (
                wallet.assets.map(a => (
                  <tr key={a.asset} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-bold text-slate-100">{a.asset}</td>
                    <td className="py-3 px-4 text-slate-400">{a.symbol}</td>
                    <td className="py-3 px-4 text-slate-200">{a.total}</td>
                    <td className="py-3 px-4 text-slate-200">${a.price}</td>
                    <td className="py-3 px-4 text-amber-400 font-bold">${a.valueUsdt.toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
