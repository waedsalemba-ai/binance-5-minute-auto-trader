import React, { useState, useEffect } from 'react';
import { Sliders, Save, CheckCircle2, AlertTriangle, Database, HardDrive, Download, RefreshCw } from 'lucide-react';
import { TradingSettings } from '../types/index.ts';

interface SettingsViewProps {
  settings: TradingSettings;
  onUpdateSettings: (newSettings: Partial<TradingSettings>) => Promise<void>;
  authFetch?: (url: string, options?: RequestInit) => Promise<Response>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ settings, onUpdateSettings, authFetch }) => {
  const [form, setForm] = useState<TradingSettings>({ ...settings });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Database stats state
  const [dbStats, setDbStats] = useState<any>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);

  const fetchDbStats = async () => {
    try {
      const res = await fetch('/api/db/stats');
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setDbStats(data.data);
        }
      }
    } catch {
      // Ignore background stats failure
    }
  };

  useEffect(() => {
    fetchDbStats();
  }, []);

  const handleBackup = async () => {
    setBackingUp(true);
    setBackupMessage(null);
    try {
      const fetcher = authFetch || fetch;
      const res = await fetcher('/api/db/backup', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setBackupMessage(`Backup successfully created! Size: ${(data.data.sizeBytes / 1024).toFixed(1)} KB`);
        fetchDbStats();
      } else {
        setBackupMessage(`Backup failed: ${data.error}`);
      }
    } catch (err: any) {
      setBackupMessage(`Backup error: ${err.message}`);
    } finally {
      setBackingUp(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      await onUpdateSettings(form);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to update settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5">
        <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
          <Sliders className="w-5 h-5 text-amber-400" />
          System & Strategy Configuration
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Fine-tune the 2-minute scanner parameters, execution sizing, and risk thresholds.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-[#0f172a] border border-slate-800 rounded-2xl p-6 space-y-6">
        {error && (
          <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-400 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>Settings successfully saved and applied to future strategy executions!</span>
          </div>
        )}

        {/* Trade Sizing Section */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-slate-200 border-b border-slate-800 pb-2">
            1. Trade Sizing (Fixed Allocation Model)
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
            <div className="space-y-1.5">
              <label className="text-amber-400 font-bold">Fixed Trade Amount (USDT)</label>
              <input
                type="number"
                step="any"
                value={form.fixedTradeAmount}
                onChange={e => setForm({ ...form, fixedTradeAmount: parseFloat(e.target.value) || 100 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Fixed USDT spent on every new automated BUY.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300">Max Configurable Trade Amount (USDT)</label>
              <input
                type="number"
                disabled
                value={form.maxTradeAmount}
                className="w-full px-3 py-2 bg-slate-900/50 border border-slate-800 rounded-xl text-slate-500"
              />
              <p className="text-[10px] text-slate-500">Upper risk ceiling enforced by backend.</p>
            </div>
          </div>
        </div>

        {/* Risk & Safety Controls */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-slate-200 border-b border-slate-800 pb-2">
            2. Risk & Position Limits
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs font-mono">
            <div className="space-y-1.5">
              <label className="text-slate-300">Max Open Positions</label>
              <input
                type="number"
                value={form.maxOpenPositions}
                onChange={e => setForm({ ...form, maxOpenPositions: parseInt(e.target.value) || 5 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Max concurrent active positions (1 - 20).</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300">Minimum USDT Reserve</label>
              <input
                type="number"
                step="any"
                value={form.minimumUsdtReserve}
                onChange={e => setForm({ ...form, minimumUsdtReserve: parseFloat(e.target.value) || 100 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Preserved wallet cushion never touched by trades.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300">Post-Sell Cooldown (Mins)</label>
              <input
                type="number"
                value={form.symbolCooldownMinutes}
                onChange={e => setForm({ ...form, symbolCooldownMinutes: parseInt(e.target.value) || 30 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Minutes before a sold symbol can be rebought.</p>
            </div>
          </div>
        </div>

        {/* Strategy Score Thresholds */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-slate-200 border-b border-slate-800 pb-2">
            3. Technical Score Classification Thresholds
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs font-mono">
            <div className="space-y-1.5">
              <label className="text-sky-400 font-bold">Pre-Bullish Entry Min</label>
              <input
                type="number"
                value={form.preBullishScoreMin}
                onChange={e => setForm({ ...form, preBullishScoreMin: parseFloat(e.target.value) || 65 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Minimum score to trigger automatic BUY (Default: 65).</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-emerald-400 font-bold">Strong Bullish Min</label>
              <input
                type="number"
                value={form.strongBullishScoreMin}
                onChange={e => setForm({ ...form, strongBullishScoreMin: parseFloat(e.target.value) || 80 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Threshold to hold position in expansion (Default: 80).</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-rose-400 font-bold">Weakening Exit Threshold</label>
              <input
                type="number"
                value={form.weakeningThreshold}
                onChange={e => setForm({ ...form, weakeningThreshold: parseFloat(e.target.value) || 70 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Triggers complete position SELL (Default: 70).</p>
            </div>
          </div>
        </div>

        {/* Exit Engine & Profitability Gate Section */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-slate-200 border-b border-slate-800 pb-2">
            4. Exit Engine, Take Profit & Stop Loss Rules
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-mono">
            <div className="space-y-1.5">
              <label className="text-emerald-400 font-bold">Take Profit %</label>
              <input
                type="number"
                step="0.1"
                value={form.takeProfitPercent}
                onChange={e => setForm({ ...form, takeProfitPercent: parseFloat(e.target.value) || 2.0 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Net profit target to trigger SELL (Default: 2.0%).</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-rose-400 font-bold">Stop Loss %</label>
              <input
                type="number"
                step="0.1"
                value={form.stopLossPercent}
                onChange={e => setForm({ ...form, stopLossPercent: parseFloat(e.target.value) || 3.0 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Sole automated loss exit trigger (Default: 3.0%).</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-amber-400 font-bold">Min Profit for Tech Exit %</label>
              <input
                type="number"
                step="0.05"
                value={form.minProfitForTechnicalExitPercent}
                onChange={e => setForm({ ...form, minProfitForTechnicalExitPercent: parseFloat(e.target.value) || 0.20 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Profitability gate buffer for weakening exit (Default: 0.20%).</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300">Max Exit Price Age (ms)</label>
              <input
                type="number"
                step="500"
                value={form.maxExitPriceAgeMs}
                onChange={e => setForm({ ...form, maxExitPriceAgeMs: parseInt(e.target.value) || 5000 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Stale price protection threshold (Default: 5000ms).</p>
            </div>
          </div>
        </div>

        {/* Paper Simulation Parameters */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold text-slate-200 border-b border-slate-800 pb-2">
            5. Paper Trading Simulation Parameters
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
            <div className="space-y-1.5">
              <label className="text-slate-300">Simulated Slippage (BPS)</label>
              <input
                type="number"
                value={form.paperSlippageBps}
                onChange={e => setForm({ ...form, paperSlippageBps: parseFloat(e.target.value) || 5 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">5 BPS = 0.05% slippage applied to market fills.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300">Simulated Fee Rate</label>
              <input
                type="number"
                step="0.0001"
                value={form.paperFeeRate}
                onChange={e => setForm({ ...form, paperFeeRate: parseFloat(e.target.value) || 0.001 })}
                className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">0.001 = 0.1% standard Binance Spot taker fee.</p>
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t border-slate-800">
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 text-xs font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-xl shadow-lg shadow-amber-500/20 transition-all flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </form>

      {/* Database Storage & Persistence Health Card */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-500/10 rounded-lg border border-amber-500/20 text-amber-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-100">Server Database Storage & Persistence Health</h3>
              <p className="text-xs text-slate-400">Crash-safe atomic storage engine with cold-restart rehydration.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchDbStats}
              className="p-1.5 text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800 rounded-lg transition-colors"
              title="Refresh database stats"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={handleBackup}
              disabled={backingUp}
              className="px-3 py-1.5 text-xs font-semibold text-slate-200 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition-all flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              {backingUp ? 'Creating Backup...' : 'Backup Snapshot'}
            </button>
          </div>
        </div>

        {backupMessage && (
          <div className="p-3 bg-slate-900 border border-slate-700 rounded-xl text-xs text-amber-300 flex items-center gap-2 font-mono">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{backupMessage}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 text-xs font-mono">
          <div className="bg-slate-900/80 border border-slate-800/80 p-3 rounded-xl">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Storage Status</span>
            <span className="text-emerald-400 font-bold flex items-center gap-1.5 mt-1">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              {dbStats?.isReady ? 'HEALTHY / READY' : 'INITIALIZING'}
            </span>
          </div>

          <div className="bg-slate-900/80 border border-slate-800/80 p-3 rounded-xl">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Open / Total Positions</span>
            <span className="text-slate-100 font-bold text-sm mt-1 block">
              {dbStats?.openPositionsCount ?? 0} <span className="text-slate-500 font-normal">/ {dbStats?.positionsCount ?? 0}</span>
            </span>
          </div>

          <div className="bg-slate-900/80 border border-slate-800/80 p-3 rounded-xl">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Trade & Order History</span>
            <span className="text-slate-100 font-bold text-sm mt-1 block">
              {dbStats?.tradesCount ?? 0} trades <span className="text-slate-500 font-normal">({dbStats?.ordersCount ?? 0} orders)</span>
            </span>
          </div>

          <div className="bg-slate-900/80 border border-slate-800/80 p-3 rounded-xl">
            <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Storage Engine</span>
            <span className="text-amber-400 font-bold text-sm mt-1 block">
              {dbStats?.storageEngine || 'PostgreSQL'}
            </span>
          </div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl space-y-2 text-xs">
          <div className="flex items-center gap-2 text-slate-300 font-mono">
            <HardDrive className="w-4 h-4 text-amber-400" />
            <span className="font-semibold text-slate-200">Active PostgreSQL Target:</span>
            <span className="px-2 py-0.5 bg-slate-800 border border-slate-700 rounded text-amber-300 text-[11px] truncate max-w-md">
              {dbStats?.databaseUrlSanitized || 'PostgreSQL (Render)'}
            </span>
          </div>
          <p className="text-slate-400 text-[11px] leading-relaxed">
            Persistent storage is powered by <code className="text-amber-300">DATABASE_URL</code> on PostgreSQL. All open positions, trade history, order executions, and paper wallet balances are persisted directly to relational tables with ACID transactions, surviving server restarts and redeployments.
          </p>
        </div>
      </div>
    </div>
  );
};
