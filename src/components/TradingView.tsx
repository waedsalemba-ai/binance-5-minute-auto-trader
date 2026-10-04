import React, { useState } from 'react';
import {
  Sliders,
  ShieldCheck,
  AlertTriangle,
  Lock,
  Power,
  Clock,
  DollarSign,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Save,
} from 'lucide-react';
import { TradingSettings, TradingMode, WalletBalance, Position } from '../types/index.ts';

interface TradingViewProps {
  settings: TradingSettings;
  mode: TradingMode;
  wallet: WalletBalance;
  positions: Position[];
  onUpdateSettings: (newSettings: Partial<TradingSettings>) => Promise<void>;
  onToggleAutoTrading: () => void;
  isEmergencyStopped: boolean;
  onOpenEmergencyStopModal: () => void;
}

export const TradingView: React.FC<TradingViewProps> = ({
  settings,
  mode,
  wallet,
  positions,
  onUpdateSettings,
  onToggleAutoTrading,
  isEmergencyStopped,
  onOpenEmergencyStopModal,
}) => {
  const [fixedAmountInput, setFixedAmountInput] = useState<string>(settings.fixedTradeAmount.toString());
  const [maxPositionsInput, setMaxPositionsInput] = useState<string>(settings.maxOpenPositions.toString());
  const [reserveInput, setReserveInput] = useState<string>(settings.minimumUsdtReserve.toString());
  const [cooldownInput, setCooldownInput] = useState<string>(settings.symbolCooldownMinutes.toString());
  const [preBullishMinInput, setPreBullishMinInput] = useState<string>(settings.preBullishScoreMin.toString());
  const [strongBullishMinInput, setStrongBullishMinInput] = useState<string>(settings.strongBullishScoreMin.toString());
  const [weakeningInput, setWeakeningInput] = useState<string>(settings.weakeningThreshold.toString());
  const [tpInput, setTpInput] = useState<string>((settings.takeProfitPercent ?? 2.0).toString());
  const [slInput, setSlInput] = useState<string>((settings.stopLossPercent ?? 3.0).toString());
  const [minTechProfitInput, setMinTechProfitInput] = useState<string>((settings.minProfitForTechnicalExitPercent ?? 0.20).toString());

  const [validationError, setValidationError] = useState<string | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setSavedSuccess(false);

    const fixedAmt = parseFloat(fixedAmountInput);
    if (isNaN(fixedAmt) || !isFinite(fixedAmt) || fixedAmt <= 0) {
      setValidationError('Invalid trade amount. Enter a positive USDT amount.');
      return;
    }
    if (fixedAmt > (settings.maxTradeAmount || 10000)) {
      setValidationError(`Trade amount cannot exceed maximum allowed (${settings.maxTradeAmount} USDT).`);
      return;
    }

    const maxPos = parseInt(maxPositionsInput);
    if (isNaN(maxPos) || maxPos < 1 || maxPos > 20) {
      setValidationError('Max open positions must be between 1 and 20.');
      return;
    }

    const reserve = parseFloat(reserveInput);
    if (isNaN(reserve) || reserve < 0) {
      setValidationError('Minimum USDT reserve must be 0 or greater.');
      return;
    }

    const tpVal = parseFloat(tpInput);
    const slVal = parseFloat(slInput);
    const minTechVal = parseFloat(minTechProfitInput);

    setSaving(true);
    try {
      await onUpdateSettings({
        fixedTradeAmount: fixedAmt,
        maxOpenPositions: maxPos,
        minimumUsdtReserve: reserve,
        symbolCooldownMinutes: parseInt(cooldownInput) || 30,
        preBullishScoreMin: parseFloat(preBullishMinInput) || 65,
        strongBullishScoreMin: parseFloat(strongBullishMinInput) || 80,
        weakeningThreshold: parseFloat(weakeningInput) || 70,
        takeProfitPercent: isNaN(tpVal) || tpVal <= 0 ? 2.0 : tpVal,
        stopLossPercent: isNaN(slVal) || slVal <= 0 ? 3.0 : slVal,
        minProfitForTechnicalExitPercent: isNaN(minTechVal) || minTechVal < 0 ? 0.20 : minTechVal,
      });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 3000);
    } catch (err: any) {
      setValidationError(err.message || 'Failed to update trading settings.');
    } finally {
      setSaving(false);
    }
  };

  const activePositions = positions.filter(p => p.mode === mode && p.status === 'OPEN');
  const requiredUsdtForNextBuy = settings.fixedTradeAmount + settings.fixedTradeAmount * 0.001;
  const isBalanceSufficient = wallet.usdtAvailable >= requiredUsdtForNextBuy;
  const isReserveSufficient = wallet.usdtAvailable - settings.fixedTradeAmount >= settings.minimumUsdtReserve;
  const isPositionsLimitOk = activePositions.length < settings.maxOpenPositions;

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
            <Sliders className="w-5 h-5 text-amber-400" />
            Strategy Engine & Risk Safety Gate
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Server-enforced risk constraints. Sizing model: Fixed USDT Amount per new trade.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onToggleAutoTrading}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-2 ${
              settings.autoTrading
                ? 'bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20'
                : 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700'
            }`}
          >
            <Power className="w-4 h-4" />
            Auto Trading: {settings.autoTrading ? 'RUNNING' : 'STOPPED'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Settings Form */}
        <form onSubmit={handleSave} className="lg:col-span-2 bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="font-bold text-sm text-slate-100">Trade Sizing & Risk Parameters</h3>
            {savedSuccess && (
              <span className="text-xs text-emerald-400 font-mono flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" /> Settings Saved!
              </span>
            )}
          </div>

          {validationError && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{validationError}</span>
            </div>
          )}

          {/* CRITICAL: Fixed Trade Amount Card */}
          <div className="p-4 bg-amber-500/5 border border-amber-500/20 rounded-xl space-y-2">
            <div className="flex justify-between items-center">
              <label className="text-xs font-bold text-amber-400">
                Fixed Trade Amount (USDT)
              </label>
              <span className="text-[11px] font-mono text-slate-400">
                Current: <strong className="text-amber-300">{settings.fixedTradeAmount} USDT</strong>
              </span>
            </div>
            <div className="relative">
              <input
                type="number"
                step="any"
                value={fixedAmountInput}
                onChange={e => setFixedAmountInput(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono font-bold bg-slate-900 border border-amber-500/40 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
                placeholder="100.00"
              />
              <span className="absolute right-3 top-2 text-xs font-mono font-bold text-slate-400">
                USDT
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              <strong>Critical Rule:</strong> Fixed amount used for every new BUY. Never calculated as dynamic % of equity.
              When changed, the new amount applies strictly to future BUY orders without altering existing positions.
            </p>
          </div>

          {/* Grid of other parameters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Max Open Positions
              </label>
              <input
                type="number"
                value={maxPositionsInput}
                onChange={e => setMaxPositionsInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Max concurrent strategy positions (Default: 5)</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Minimum USDT Reserve (USDT)
              </label>
              <input
                type="number"
                step="any"
                value={reserveInput}
                onChange={e => setReserveInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Preserves emergency safety cushion in wallet</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Post-Sell Cooldown (Minutes)
              </label>
              <input
                type="number"
                value={cooldownInput}
                onChange={e => setCooldownInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Blocks immediate re-entry on sold symbols (Default: 30m)</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Pre-Bullish Entry Score Min
              </label>
              <input
                type="number"
                value={preBullishMinInput}
                onChange={e => setPreBullishMinInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Minimum score required to trigger BUY (Default: 65)</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Strong Bullish Min Score
              </label>
              <input
                type="number"
                value={strongBullishMinInput}
                onChange={e => setStrongBullishMinInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Score threshold to confirm strong trend (Default: 80)</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">
                Weakening Exit Threshold
              </label>
              <input
                type="number"
                value={weakeningInput}
                onChange={e => setWeakeningInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Triggers SELL when score falls below this (Default: 70)</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-emerald-400">
                Take Profit %
              </label>
              <input
                type="number"
                step="0.1"
                value={tpInput}
                onChange={e => setTpInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Net profit target to trigger SELL (Default: 2.0%)</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-rose-400">
                Stop Loss %
              </label>
              <input
                type="number"
                step="0.1"
                value={slInput}
                onChange={e => setSlInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Sole automated loss exit trigger (Default: 3.0%)</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-amber-400">
                Min Profit for Tech Exit %
              </label>
              <input
                type="number"
                step="0.05"
                value={minTechProfitInput}
                onChange={e => setMinTechProfitInput(e.target.value)}
                className="w-full px-3 py-1.5 text-xs font-mono bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
              <p className="text-[10px] text-slate-500">Buffer required for weakening exits (Default: 0.20%)</p>
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-slate-800">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 text-xs font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-xl shadow-lg shadow-amber-500/20 transition-all flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving Settings...' : 'Save Trading Settings'}
            </button>
          </div>
        </form>

        {/* Safety Gate Real-Time Audit */}
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4">
          <h3 className="font-bold text-sm text-slate-100 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            Safety Gate Checklist ({mode})
          </h3>

          <p className="text-[11px] text-slate-400">
            Automated verification evaluated before every BUY or SELL order.
          </p>

          <div className="space-y-2.5 text-xs font-mono">
            {/* Auto Trading Active */}
            <div className="flex items-center justify-between p-2.5 bg-slate-900/80 rounded-xl border border-slate-800">
              <span className="text-slate-300">Auto Trading Enabled</span>
              {settings.autoTrading ? (
                <span className="text-emerald-400 flex items-center gap-1 font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> YES
                </span>
              ) : (
                <span className="text-slate-500 flex items-center gap-1">
                  <XCircle className="w-3.5 h-3.5" /> OFF
                </span>
              )}
            </div>

            {/* Emergency Stop Inactive */}
            <div className="flex items-center justify-between p-2.5 bg-slate-900/80 rounded-xl border border-slate-800">
              <span className="text-slate-300">Emergency Stop Inactive</span>
              {!isEmergencyStopped ? (
                <span className="text-emerald-400 flex items-center gap-1 font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> CLEAR
                </span>
              ) : (
                <span className="text-rose-500 flex items-center gap-1 font-bold">
                  <XCircle className="w-3.5 h-3.5" /> HALTED
                </span>
              )}
            </div>

            {/* Available Balance >= Trade Amount */}
            <div className="flex items-center justify-between p-2.5 bg-slate-900/80 rounded-xl border border-slate-800">
              <span className="text-slate-300">Balance &ge; Fixed Amount</span>
              {isBalanceSufficient ? (
                <span className="text-emerald-400 flex items-center gap-1 font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> OK (${wallet.usdtAvailable.toFixed(2)})
                </span>
              ) : (
                <span className="text-rose-400 flex items-center gap-1 font-bold">
                  <XCircle className="w-3.5 h-3.5" /> INSUFFICIENT
                </span>
              )}
            </div>

            {/* Reserve Protected */}
            <div className="flex items-center justify-between p-2.5 bg-slate-900/80 rounded-xl border border-slate-800">
              <span className="text-slate-300">Reserve Cushion Preserved</span>
              {isReserveSufficient ? (
                <span className="text-emerald-400 flex items-center gap-1 font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> OK
                </span>
              ) : (
                <span className="text-amber-400 flex items-center gap-1 font-bold">
                  <AlertTriangle className="w-3.5 h-3.5" /> BELOW RESERVE
                </span>
              )}
            </div>

            {/* Positions Limit */}
            <div className="flex items-center justify-between p-2.5 bg-slate-900/80 rounded-xl border border-slate-800">
              <span className="text-slate-300">Position Slots Available</span>
              {isPositionsLimitOk ? (
                <span className="text-emerald-400 flex items-center gap-1 font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> {activePositions.length}/{settings.maxOpenPositions}
                </span>
              ) : (
                <span className="text-amber-400 flex items-center gap-1 font-bold">
                  <XCircle className="w-3.5 h-3.5" /> MAX REACHED
                </span>
              )}
            </div>

            {/* Wallet Reconciliation */}
            <div className="flex items-center justify-between p-2.5 bg-slate-900/80 rounded-xl border border-slate-800">
              <span className="text-slate-300">Ledger Reconciled</span>
              {wallet.reconciliationStatus === 'OK' ? (
                <span className="text-emerald-400 flex items-center gap-1 font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5" /> OK
                </span>
              ) : (
                <span className="text-rose-400 flex items-center gap-1 font-bold">
                  <XCircle className="w-3.5 h-3.5" /> {wallet.reconciliationStatus}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
