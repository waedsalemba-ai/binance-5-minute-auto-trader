import React, { useState } from 'react';
import {
  Key,
  Shield,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Lock,
  Eye,
  EyeOff,
  Trash2,
  DollarSign,
  ExternalLink,
} from 'lucide-react';
import { WalletBalance, TradingAccount } from '../types/index.ts';

interface RealWalletViewProps {
  wallet: WalletBalance;
  account: TradingAccount | undefined;
  onSyncWallet: () => Promise<void>;
  onConnectApi: (apiKey: string, apiSecret: string) => Promise<void>;
  onDisconnectApi: () => Promise<void>;
}

export const RealWalletView: React.FC<RealWalletViewProps> = ({
  wallet,
  account,
  onSyncWallet,
  onConnectApi,
  onDisconnectApi,
}) => {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiSecretInput, setApiSecretInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; warning?: boolean } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const hasKeys = account?.hasApiKeys;

  const handleTestConnection = async () => {
    if (!apiKeyInput.trim() || !apiSecretInput.trim()) {
      setErrorMessage('Please enter both Binance API Key and Secret Key.');
      return;
    }

    setTesting(true);
    setErrorMessage(null);
    setTestResult(null);

    try {
      const res = await fetch('/api/binance/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim(), apiSecret: apiSecretInput.trim() }),
      });
      const json = await res.json();
      if (json.success) {
        setTestResult({
          success: true,
          message: `Connection successful! Spot Trading: ${json.canTrade ? 'Enabled' : 'Disabled'}.`,
          warning: json.hasWithdrawalWarning,
        });
      } else {
        setTestResult({
          success: false,
          message: json.error || 'Failed to authenticate with Binance.',
        });
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err.message || 'Network error connecting to Binance.',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim() || !apiSecretInput.trim()) {
      setErrorMessage('Please enter both Binance API Key and Secret Key.');
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    try {
      await onConnectApi(apiKeyInput.trim(), apiSecretInput.trim());
      setApiKeyInput('');
      setApiSecretInput('');
      setTestResult(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to connect Binance API.');
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSyncWallet();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-500/20 text-amber-400 rounded-xl">
              <Key className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-100">Binance Spot Live Account</h2>
              <span className="text-xs text-amber-400 font-mono font-bold">
                {hasKeys ? 'BINANCE CONNECTED (AES-256 ENCRYPTED)' : 'NO API CREDENTIALS CONNECTED'}
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-2 max-w-2xl">
            Connect your Binance Spot API key to enable live trading. Credentials are encrypted at rest using AES-256-GCM and never exposed to browser memory.
          </p>
        </div>

        {hasKeys && (
          <div className="flex items-center gap-3">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-3.5 py-2 text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl border border-slate-700 transition-all flex items-center gap-2"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin text-amber-400' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Balances'}
            </button>
            <button
              onClick={onDisconnectApi}
              className="px-3.5 py-2 text-xs font-bold text-rose-400 hover:text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl transition-all flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Disconnect API
            </button>
          </div>
        )}
      </div>

      {/* Connected Account Overview or Setup Form */}
      {hasKeys ? (
        <div className="space-y-6">
          {/* Key Summary & Status Card */}
          <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-3">
                <Shield className="w-5 h-5 text-emerald-400" />
                <div>
                  <div className="text-xs text-slate-400">Masked API Key:</div>
                  <div className="text-sm font-mono font-bold text-slate-200">
                    {account?.apiKeyMasked || '••••••••••••••••'}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs font-mono">
                <span className="px-2.5 py-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg">
                  Spot Trading: Enabled
                </span>
                <span className="px-2.5 py-1 bg-slate-800 text-slate-300 rounded-lg">
                  Secret: Encrypted (AES-256-GCM)
                </span>
              </div>
            </div>

            {account?.permissions?.hasWithdrawalWarning && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-300 flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
                <div>
                  <strong className="font-bold">Security Advisory:</strong> Your API key currently has withdrawal permissions enabled. For enhanced safety, we recommend disabling withdrawal permissions on Binance, as this application only requires Spot Trading and Market Data permissions.
                </div>
              </div>
            )}
          </div>

          {/* Real Balances Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
              <span className="text-[11px] text-slate-400 font-medium">Real Total Equity</span>
              <div className="text-2xl font-black font-mono text-slate-100 mt-1">
                ${wallet.totalEquity.toFixed(2)}
              </div>
              <span className="text-[11px] text-slate-500 font-mono mt-1 block">
                Live Binance Spot Account
              </span>
            </div>

            <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
              <span className="text-[11px] text-slate-400 font-medium">Available USDT</span>
              <div className="text-2xl font-black font-mono text-emerald-400 mt-1">
                ${wallet.usdtAvailable.toFixed(2)}
              </div>
              <span className="text-[11px] text-slate-500 font-mono mt-1 block">
                Free balance for new trades
              </span>
            </div>

            <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4">
              <span className="text-[11px] text-slate-400 font-medium">Crypto Asset Holdings Value</span>
              <div className="text-2xl font-black font-mono text-amber-400 mt-1">
                ${wallet.accountAssetValue.toFixed(2)}
              </div>
              <span className="text-[11px] text-slate-500 font-mono mt-1 block">
                {wallet.assets.length} assets on Binance
              </span>
            </div>
          </div>

          {/* Live Binance Holdings Table */}
          <div className="bg-[#0f172a] border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-slate-800 flex justify-between items-center">
              <span className="font-bold text-sm text-slate-100">Live Binance Spot Balances</span>
              <span className="text-xs text-slate-400 font-mono">External holdings are never auto-sold</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="bg-slate-900/90 border-b border-slate-800 text-slate-400 font-mono">
                    <th className="py-3 px-4">Asset</th>
                    <th className="py-3 px-4">Free Balance</th>
                    <th className="py-3 px-4">Locked</th>
                    <th className="py-3 px-4">Total</th>
                    <th className="py-3 px-4">Est. Value (USDT)</th>
                    <th className="py-3 px-4 text-right">Holding Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {wallet.assets.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        No crypto asset balances detected on Binance. Free USDT balance: ${wallet.usdtAvailable.toFixed(2)}.
                      </td>
                    </tr>
                  ) : (
                    wallet.assets.map(a => (
                      <tr key={a.asset} className="hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-4 font-bold text-slate-100">{a.asset}</td>
                        <td className="py-3 px-4 text-slate-300">{a.free}</td>
                        <td className="py-3 px-4 text-slate-400">{a.locked}</td>
                        <td className="py-3 px-4 text-slate-200">{a.total}</td>
                        <td className="py-3 px-4 text-amber-400 font-bold">${a.valueUsdt.toFixed(2)}</td>
                        <td className="py-3 px-4 text-right">
                          {a.isExternal ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">
                              EXTERNAL HOLDING
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                              STRATEGY MANAGED
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        /* Credential Setup Form */
        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-6 space-y-6 max-w-2xl mx-auto shadow-2xl">
          <div>
            <h3 className="text-base font-bold text-slate-100">Connect Binance Spot API</h3>
            <p className="text-xs text-slate-400 mt-1">
              Enter your Binance API credentials. We recommend restricting API permissions strictly to <strong>Enable Reading</strong> and <strong>Enable Spot & Margin Trading</strong>.
            </p>
          </div>

          {errorMessage && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-xs text-rose-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {testResult && (
            <div className={`p-3 rounded-xl border text-xs ${
              testResult.success
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
            }`}>
              <div className="flex items-center gap-2 font-bold">
                {testResult.success ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                <span>{testResult.message}</span>
              </div>
            </div>
          )}

          <form onSubmit={handleSaveCredentials} className="space-y-4 font-mono text-xs">
            <div className="space-y-1.5">
              <label className="text-slate-300 font-bold block">Binance API Key</label>
              <input
                type="text"
                value={apiKeyInput}
                onChange={e => setApiKeyInput(e.target.value)}
                placeholder="Enter 64-character Binance API Key..."
                className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300 font-bold block">Binance Secret Key</label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={apiSecretInput}
                  onChange={e => setApiSecretInput(e.target.value)}
                  placeholder="Enter 64-character Binance API Secret..."
                  className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-800 rounded-xl text-slate-100 focus:outline-none focus:border-amber-400 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200"
                >
                  {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="p-3 bg-slate-900/60 rounded-xl border border-slate-800 text-[11px] text-slate-400 space-y-1">
              <div className="text-slate-300 font-bold flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-amber-400" />
                End-to-End Security Architecture
              </div>
              <p>• API Secrets are stored server-side encrypted with AES-256-GCM.</p>
              <p>• Never logged or transferred to browser client state.</p>
              <p>• Automatic trade executions strictly require explicit user start.</p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testing}
                className="px-4 py-2 text-xs font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${testing ? 'animate-spin' : ''}`} />
                {testing ? 'Testing...' : 'Test Connection'}
              </button>

              <button
                type="submit"
                disabled={saving}
                className="px-5 py-2 text-xs font-bold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-xl shadow-lg shadow-amber-500/20 transition-all flex items-center gap-1.5"
              >
                <Lock className="w-3.5 h-3.5" />
                {saving ? 'Connecting...' : 'Connect & Save Keys'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
