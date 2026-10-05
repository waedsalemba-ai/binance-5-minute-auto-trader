import React, { useState } from 'react';
import { AlertTriangle, ShieldAlert, RotateCcw, Power, CheckCircle2, X } from 'lucide-react';
import { Position } from '../types/index.ts';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
}

export const SwitchToRealModal: React.FC<ModalProps> = ({ isOpen, onClose, onConfirm, loading }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-[#0f172a] border-2 border-amber-500/50 rounded-2xl p-6 shadow-2xl">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-200">
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 text-amber-400 mb-4">
          <div className="p-3 bg-amber-500/10 rounded-xl border border-amber-500/30">
            <AlertTriangle className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-100">Switch to REAL Binance Spot Trading</h3>
            <span className="text-xs text-amber-400 font-mono font-medium">REAL FUNDS EXECUTION</span>
          </div>
        </div>

        <div className="space-y-3 text-sm text-slate-300 mb-6 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
          <p className="text-amber-300 font-semibold">⚠️ Important Notice:</p>
          <ul className="list-disc list-inside space-y-1.5 text-xs text-slate-300">
            <li>Future automatic BUY and SELL orders will execute on your real Binance Spot account using <strong>real USDT</strong>.</li>
            <li>Paper balances and open paper positions will <strong>NOT</strong> be transferred to real trading.</li>
            <li>Each new BUY will strictly use your configured fixed trade amount.</li>
            <li>Ensure you have validated your Binance API credentials and set appropriate risk parameters.</li>
          </ul>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 bg-slate-800/80 hover:bg-slate-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-5 py-2 text-sm font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-lg shadow-lg shadow-amber-500/20 transition-all flex items-center gap-2"
          >
            {loading ? 'Switching...' : 'Yes, Switch to REAL Mode'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const SwitchToPaperModal: React.FC<ModalProps> = ({ isOpen, onClose, onConfirm, loading }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-[#0f172a] border border-slate-700 rounded-2xl p-6 shadow-2xl">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-200">
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 text-emerald-400 mb-4">
          <div className="p-3 bg-emerald-500/10 rounded-xl border border-emerald-500/30">
            <CheckCircle2 className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-100">Switch to PAPER Trading Mode</h3>
            <span className="text-xs text-emerald-400 font-mono">Simulated Wallet • Real Binance Market Data</span>
          </div>
        </div>

        <div className="text-sm text-slate-300 space-y-2 mb-6 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
          <p>Real Binance auto-trading will stop immediately.</p>
          <p className="text-xs text-slate-400">
            Existing Binance Spot positions will remain open on your exchange account. The application will <strong>not</strong> automatically liquidate or alter them.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 bg-slate-800/80 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-5 py-2 text-sm font-bold text-slate-900 bg-emerald-400 hover:bg-emerald-300 rounded-lg shadow-lg shadow-emerald-500/20 transition-all"
          >
            {loading ? 'Switching...' : 'Switch to Paper Mode'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const EmergencyStopModal: React.FC<ModalProps> = ({ isOpen, onClose, onConfirm, loading }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
      <div className="relative w-full max-w-md bg-[#180d12] border-2 border-rose-500 rounded-2xl p-6 shadow-2xl shadow-rose-950/50">
        <div className="flex items-center gap-3 text-rose-500 mb-4">
          <div className="p-3 bg-rose-500/20 rounded-xl border border-rose-500/40">
            <ShieldAlert className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-xl font-extrabold text-rose-400">EMERGENCY STOP</h3>
            <span className="text-xs text-slate-400">Immediate Strategy Halt</span>
          </div>
        </div>

        <p className="text-sm text-slate-200 mb-6">
          This will immediately stop all automatic trading, cancel queued buy/sell executions, and lock the safety gate.
          <br /><br />
          <span className="text-xs text-rose-300 font-semibold">
            Existing Binance Spot positions will remain safely on Binance and will NOT be market dumped.
          </span>
        </p>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-5 py-2 text-sm font-bold text-white bg-rose-600 hover:bg-rose-500 rounded-lg shadow-lg shadow-rose-600/40 flex items-center gap-2"
          >
            <Power className="w-4 h-4" />
            {loading ? 'Halting...' : 'CONFIRM EMERGENCY STOP'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const ResetPaperWalletModal: React.FC<ModalProps> = ({ isOpen, onClose, onConfirm, loading }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg bg-[#0f172a] border border-amber-500/40 rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 text-amber-400 mb-4">
          <div className="p-3 bg-amber-500/10 rounded-xl border border-amber-500/30">
            <RotateCcw className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-100">Reset Active Positions & Wallet Balance</h3>
            <span className="text-xs text-amber-400 font-mono font-medium">SIMULATED ACCOUNT RESTORE</span>
          </div>
        </div>

        <div className="space-y-3 text-sm text-slate-300 mb-6 bg-slate-900/70 p-4 rounded-xl border border-slate-800">
          <p className="font-semibold text-slate-200">This action will perform the following resets:</p>
          <ul className="space-y-2 text-xs text-slate-300">
            <li className="flex items-start gap-2">
              <span className="text-rose-400 font-bold">✕</span>
              <span><strong>All Active Positions:</strong> Closes and wipes all open token positions and active strategy allocations.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-emerald-400 font-bold">✓</span>
              <span><strong>Wallet Balance:</strong> Restores available balance to default <strong>1,000.00 USDT</strong> and resets token holdings to 0.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-sky-400 font-bold">↺</span>
              <span><strong>Trade Records & Cooldowns:</strong> Clears trade metrics, realized PnL, fees, and symbol cooldown lockouts.</span>
            </li>
          </ul>
          <div className="pt-2 border-t border-slate-800 text-[11px] text-slate-400 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>REAL Binance Spot exchange funds and API keys remain completely isolated and unaffected.</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-5 py-2 text-sm font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-lg shadow-lg shadow-amber-500/25 transition-all flex items-center gap-2"
          >
            <RotateCcw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Resetting Everything...' : 'Confirm Reset (1000 USDT)'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ManualSellModalProps extends ModalProps {
  position: Position | null;
}

export const ManualSellModal: React.FC<ManualSellModalProps> = ({ isOpen, onClose, onConfirm, position, loading }) => {
  if (!isOpen || !position) return null;
  const isReal = position.mode === 'REAL';
  const estValue = (position.currentPrice * position.remainingQuantity).toFixed(2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-md bg-[#0f172a] border border-slate-700 rounded-2xl p-6 shadow-2xl">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-200">
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 text-rose-400 mb-4">
          <div className="p-3 bg-rose-500/10 rounded-xl border border-rose-500/30">
            <AlertTriangle className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-100">Confirm Position Exit</h3>
            <span className={`text-xs font-mono font-bold ${isReal ? 'text-amber-400' : 'text-emerald-400'}`}>
              {isReal ? 'REAL BINANCE SPOT MARKET SELL' : 'SIMULATED PAPER SELL'}
            </span>
          </div>
        </div>

        <div className="space-y-2.5 text-xs font-mono bg-slate-900/80 p-4 rounded-xl border border-slate-800 mb-6 text-slate-300">
          <div className="flex justify-between">
            <span className="text-slate-400">Symbol:</span>
            <span className="font-bold text-slate-100">{position.symbol}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Quantity to Sell:</span>
            <span className="text-slate-200">{position.remainingQuantity}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Current Market Price:</span>
            <span className="text-slate-200">${position.currentPrice}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Entry Quote Amount:</span>
            <span className="text-slate-200">{position.entryQuoteAmount} USDT</span>
          </div>
          <div className="flex justify-between border-t border-slate-800 pt-2 font-bold">
            <span className="text-slate-300">Estimated Value:</span>
            <span className="text-emerald-400">~{estValue} USDT</span>
          </div>
        </div>

        {isReal && (
          <p className="text-xs text-amber-400 font-semibold mb-6">
            ⚠️ This will submit an immediate live MARKET SELL order to Binance Spot.
          </p>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-5 py-2 text-sm font-bold text-white bg-rose-600 hover:bg-rose-500 rounded-lg shadow-lg shadow-rose-600/30"
          >
            {loading ? 'Submitting...' : 'Confirm Market Sell'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AdminUnlockModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (token: string) => void;
}

export const AdminUnlockModal: React.FC<AdminUnlockModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) {
      setError('Please enter your Admin Access Token.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminToken: tokenInput.trim() }),
      });
      const data = await res.json();
      if (data.success && data.token) {
        onSuccess(data.token);
        onClose();
      } else {
        setError(data.error || 'Authentication failed.');
      }
    } catch (err: any) {
      setError(err.message || 'Network error during login.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4">
      <div className="relative w-full max-w-md bg-[#0f172a] border border-slate-700 rounded-2xl p-6 shadow-2xl">
        <button onClick={onClose} className="absolute top-4 right-4 text-slate-400 hover:text-slate-200">
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 text-amber-400 mb-4">
          <div className="p-3 bg-amber-500/10 rounded-xl border border-amber-500/30">
            <ShieldAlert className="w-7 h-7" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-100">Admin Control Access</h3>
            <span className="text-xs text-slate-400 font-mono">Authenticate to manage server settings</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              ADMIN ACCESS TOKEN
            </label>
            <input
              type="password"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="Enter ADMIN_TOKEN configured on server"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-amber-500"
              autoFocus
            />
          </div>

          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-400 font-medium">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 text-sm font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-lg shadow-lg shadow-amber-500/20"
            >
              {loading ? 'Authenticating...' : 'Unlock Controls'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

