import React, { useState } from 'react';
import {
  ListOrdered,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  Clock,
  Download,
  Filter,
  Layers,
  DollarSign,
} from 'lucide-react';
import { Trade, Order, TradingMode } from '../types/index.ts';

interface OrdersViewProps {
  trades: Trade[];
  orders: Order[];
  mode: TradingMode;
}

export const OrdersView: React.FC<OrdersViewProps> = ({ trades, orders, mode }) => {
  const [activeTab, setActiveTab] = useState<'trades' | 'orders'>('trades');
  const [selectedMode, setSelectedMode] = useState<TradingMode>(mode);

  const filteredTrades = trades.filter(t => t.mode === selectedMode);
  const filteredOrders = orders.filter(o => o.mode === selectedMode);

  // Stats calculation
  const totalTradesCount = filteredTrades.length;
  const winningTrades = filteredTrades.filter(t => t.netPnL > 0).length;
  const losingTrades = filteredTrades.filter(t => t.netPnL < 0).length;
  const winRate = totalTradesCount > 0 ? ((winningTrades / totalTradesCount) * 100).toFixed(1) : '0.0';
  const totalNetPnL = filteredTrades.reduce((sum, t) => sum + t.netPnL, 0);
  const totalFees = filteredTrades.reduce((sum, t) => sum + t.entryFees + t.exitFees, 0);

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  };

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m ${s % 60}s`;
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <ListOrdered className="w-5 h-5 text-amber-400" />
              Execution Ledger & Trade History
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Complete audit trail of all automatic strategy orders and closed trade results.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Mode Filter */}
            <div className="flex items-center p-1 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono font-bold">
              <button
                onClick={() => setSelectedMode('PAPER')}
                className={`px-3 py-1.5 rounded-lg transition-colors ${
                  selectedMode === 'PAPER'
                    ? 'bg-emerald-500 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                PAPER HISTORY
              </button>
              <button
                onClick={() => setSelectedMode('REAL')}
                className={`px-3 py-1.5 rounded-lg transition-colors ${
                  selectedMode === 'REAL'
                    ? 'bg-amber-500 text-slate-950 shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                REAL HISTORY
              </button>
            </div>
          </div>
        </div>

        {/* Trade Summary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-800 text-xs font-mono">
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Total Closed Trades:</span>
            <div className="text-base font-bold text-slate-100 mt-0.5">{totalTradesCount}</div>
          </div>
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Win Rate:</span>
            <div className="text-base font-bold text-slate-100 mt-0.5">
              {winRate}% <span className="text-xs font-normal text-slate-500">({winningTrades}W / {losingTrades}L)</span>
            </div>
          </div>
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Total Net Realized PnL:</span>
            <div className={`text-base font-bold mt-0.5 ${totalNetPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {totalNetPnL >= 0 ? '+' : ''}${totalNetPnL.toFixed(2)}
            </div>
          </div>
          <div className="p-3 bg-slate-900/80 rounded-xl border border-slate-800">
            <span className="text-slate-400">Total Fees Paid:</span>
            <div className="text-base font-bold text-slate-300 mt-0.5">${totalFees.toFixed(2)}</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveTab('trades')}
          className={`px-4 py-2 text-xs font-bold rounded-xl transition-colors ${
            activeTab === 'trades'
              ? 'bg-slate-800 text-amber-400 border border-slate-700'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Closed Trades ({filteredTrades.length})
        </button>
        <button
          onClick={() => setActiveTab('orders')}
          className={`px-4 py-2 text-xs font-bold rounded-xl transition-colors ${
            activeTab === 'orders'
              ? 'bg-slate-800 text-amber-400 border border-slate-700'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Orders Log ({filteredOrders.length})
        </button>
      </div>

      {/* Closed Trades Table */}
      {activeTab === 'trades' && (
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="bg-slate-900/90 border-b border-slate-800 text-slate-400 font-mono">
                  <th className="py-3 px-3">Closed Time</th>
                  <th className="py-3 px-3">Symbol</th>
                  <th className="py-3 px-3">Trade Amount</th>
                  <th className="py-3 px-3">Quantity</th>
                  <th className="py-3 px-3">Entry Price</th>
                  <th className="py-3 px-3">Exit Price</th>
                  <th className="py-3 px-3">Fees</th>
                  <th className="py-3 px-3">Gross PnL</th>
                  <th className="py-3 px-3">Net PnL</th>
                  <th className="py-3 px-3">Duration</th>
                  <th className="py-3 px-3">Exit Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {filteredTrades.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-12 text-center text-slate-500">
                      No closed trades recorded yet in {selectedMode} mode.
                    </td>
                  </tr>
                ) : (
                  filteredTrades.map(trade => (
                    <tr key={trade.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-3 text-slate-400">{formatTime(trade.closedAt)}</td>
                      <td className="py-3 px-3 font-bold text-slate-100">{trade.symbol}</td>
                      <td className="py-3 px-3 text-amber-400 font-bold">{trade.entryQuoteAmount} USDT</td>
                      <td className="py-3 px-3 text-slate-300">{trade.quantity}</td>
                      <td className="py-3 px-3 text-slate-300">${trade.entryPrice}</td>
                      <td className="py-3 px-3 text-slate-300">${trade.exitPrice}</td>
                      <td className="py-3 px-3 text-slate-400">${(trade.entryFees + trade.exitFees).toFixed(4)}</td>
                      <td className={`py-3 px-3 ${trade.grossPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {trade.grossPnL >= 0 ? '+' : ''}${trade.grossPnL.toFixed(2)}
                      </td>
                      <td className={`py-3 px-3 font-bold ${trade.netPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {trade.netPnL >= 0 ? '+' : ''}${trade.netPnL.toFixed(2)} ({trade.netPnLPercent >= 0 ? '+' : ''}{trade.netPnLPercent}%)
                      </td>
                      <td className="py-3 px-3 text-slate-400">{formatDuration(trade.durationMs)}</td>
                      <td className="py-3 px-3 text-slate-400 text-[11px] max-w-xs truncate" title={trade.exitReason}>
                        {trade.exitReason}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Orders Table */}
      {activeTab === 'orders' && (
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="bg-slate-900/90 border-b border-slate-800 text-slate-400 font-mono">
                  <th className="py-3 px-3">Time</th>
                  <th className="py-3 px-3">Client Order ID</th>
                  <th className="py-3 px-3">Symbol</th>
                  <th className="py-3 px-3">Side</th>
                  <th className="py-3 px-3">Status</th>
                  <th className="py-3 px-3">Requested Sizing</th>
                  <th className="py-3 px-3">Executed Qty</th>
                  <th className="py-3 px-3">Execution Price</th>
                  <th className="py-3 px-3">Fee</th>
                  <th className="py-3 px-3">Strategy State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {filteredOrders.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-slate-500">
                      No order records found in {selectedMode} mode.
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map(order => (
                    <tr key={order.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-3 text-slate-400">{formatTime(order.createdAt)}</td>
                      <td className="py-3 px-3 text-slate-300 text-[11px] font-mono">{order.clientOrderId}</td>
                      <td className="py-3 px-3 font-bold text-slate-100">{order.symbol}</td>
                      <td className="py-3 px-3">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          order.side === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                        }`}>
                          {order.side}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <span className="text-slate-300 font-semibold">{order.status}</span>
                      </td>
                      <td className="py-3 px-3 text-amber-400 font-bold">
                        {order.requestedQuoteAmount ? `${order.requestedQuoteAmount} USDT` : `${order.requestedQuantity} QTY`}
                      </td>
                      <td className="py-3 px-3 text-slate-300">{order.executedQuantity}</td>
                      <td className="py-3 px-3 text-slate-300">${order.executionPrice}</td>
                      <td className="py-3 px-3 text-slate-400">{order.fee} {order.feeAsset}</td>
                      <td className="py-3 px-3 text-slate-400 text-[11px]">{order.strategyState}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
