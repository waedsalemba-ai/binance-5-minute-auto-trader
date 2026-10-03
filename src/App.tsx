import React, { useState, useEffect, useCallback } from 'react';
import {
  TradingMode,
  TradingSettings,
  WalletBalance,
  Position,
  Order,
  Trade,
  ScannerSummary,
  TechnicalAnalysis,
  SystemLogEntry,
  TradingAccount,
} from './types/index.ts';

import { Navbar } from './components/Navbar.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { ScannerView } from './components/ScannerView.tsx';
import { TokenDetailView } from './components/TokenDetailView.tsx';
import { TradingView } from './components/TradingView.tsx';
import { PositionsView } from './components/PositionsView.tsx';
import { OrdersView } from './components/OrdersView.tsx';
import { PaperWalletView } from './components/PaperWalletView.tsx';
import { RealWalletView } from './components/RealWalletView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import { LogsView } from './components/LogsView.tsx';
import {
  SwitchToRealModal,
  SwitchToPaperModal,
  EmergencyStopModal,
  ResetEmergencyStopModal,
  ResetPaperWalletModal,
  ManualSellModal,
} from './components/Modals.tsx';

export default function App() {
  const [currentTab, setCurrentTab] = useState<string>('dashboard');
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string>('');

  // Core App State
  const [settings, setSettings] = useState<TradingSettings>({
    mode: 'PAPER',
    autoTrading: false,
    fixedTradeAmount: 100,
    maxOpenPositions: 5,
    minimumUsdtReserve: 100,
    symbolCooldownMinutes: 30,
    preBullishScoreMin: 65,
    strongBullishScoreMin: 80,
    weakeningThreshold: 70,
    maxTradeAmount: 10000,
    paperStartingBalance: 1000,
    paperFeeRate: 0.001,
    paperSlippageBps: 5,
    manageExistingHoldings: false,
    resumeOnRestart: false,
    scanIntervalMs: 300000, // 5 minutes authoritative
  });

  const [wallet, setWallet] = useState<WalletBalance>({
    mode: 'PAPER',
    usdtAvailable: 1000,
    usdtLocked: 0,
    usdtTotal: 1000,
    accountAssetValue: 0,
    totalEquity: 1000,
    startingBalance: 1000,
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalFeesPaid: 0,
    assets: [],
    lastReconciledAt: Date.now(),
    reconciliationStatus: 'OK',
  });

  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [analyses, setAnalyses] = useState<TechnicalAnalysis[]>([]);
  const [summary, setSummary] = useState<ScannerSummary>({
    pairsAnalyzed: 0,
    preBullishCount: 0,
    bullishCount: 0,
    strongBullishCount: 0,
    weakeningCount: 0,
    neutralCount: 0,
    openPositionsCount: 0,
    todayTradesCount: 0,
    lastScanTime: 0,
    nextScanTime: 0,
    isScanning: false,
  });
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [isEmergencyStopped, setIsEmergencyStopped] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Modals state
  const [targetSwitchMode, setTargetSwitchMode] = useState<TradingMode | null>(null);
  const [isEmergencyStopModalOpen, setIsEmergencyStopModalOpen] = useState(false);
  const [isResetEmergencyModalOpen, setIsResetEmergencyModalOpen] = useState(false);
  const [isResetPaperModalOpen, setIsResetPaperModalOpen] = useState(false);
  const [sellPositionTarget, setSellPositionTarget] = useState<Position | null>(null);
  const [modalLoading, setModalLoading] = useState(false);

  // Helper with automatic authentication headers
  const getAuthHeaders = useCallback((extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...extra,
    };
    if (authToken) {
      headers['X-Admin-Token'] = authToken;
    }
    return headers;
  }, [authToken]);

  // Safe fetch helper that won't reject or throw unhandled exceptions
  const safeFetch = useCallback(async <T = any>(url: string): Promise<T | null> => {
    try {
      const res = await fetch(url, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return null;
      }
      const data = await res.json();
      return data;
    } catch {
      return null;
    }
  }, [getAuthHeaders]);

  // Fetch initial authentication status
  useEffect(() => {
    fetch('/api/auth/status')
      .then(res => res.json())
      .then(data => {
        if (data.token) {
          setAuthToken(data.token);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch all core state
  const refreshState = useCallback(async () => {
    try {
      const [
        settingsRes,
        tradingStatusRes,
        scannerRes,
        positionsRes,
        ordersRes,
        tradesRes,
        logsRes,
        scannerStatusRes,
      ] = await Promise.allSettled([
        safeFetch('/api/trading/settings'),
        safeFetch('/api/trading/status'),
        safeFetch('/api/scanner/results'),
        safeFetch('/api/positions'),
        safeFetch('/api/orders'),
        safeFetch('/api/trades'),
        safeFetch('/api/logs?limit=300'),
        safeFetch('/api/scanner/status'),
      ]);

      if (settingsRes.status === 'fulfilled' && settingsRes.value?.data) {
        setSettings(settingsRes.value.data);
      }
      if (tradingStatusRes.status === 'fulfilled' && tradingStatusRes.value?.data) {
        const data = tradingStatusRes.value.data;
        if (data.wallet) setWallet(data.wallet);
        setIsEmergencyStopped(data.emergencyStop);
      }
      if (scannerRes.status === 'fulfilled' && scannerRes.value?.data) {
        setAnalyses(scannerRes.value.data);
      }
      if (positionsRes.status === 'fulfilled' && positionsRes.value?.data) {
        setPositions(positionsRes.value.data);
      }
      if (ordersRes.status === 'fulfilled' && ordersRes.value?.data) {
        setOrders(ordersRes.value.data);
      }
      if (tradesRes.status === 'fulfilled' && tradesRes.value?.data) {
        setTrades(tradesRes.value.data);
      }
      if (logsRes.status === 'fulfilled' && logsRes.value?.data) {
        setLogs(logsRes.value.data);
      }
      if (scannerStatusRes.status === 'fulfilled' && scannerStatusRes.value?.data) {
        setSummary(scannerStatusRes.value.data);
        setIsScanning(scannerStatusRes.value.data.isScanning);
      }
    } catch {
      // ignore transient refresh errors
    }
  }, [safeFetch]);

  // Real-time SSE Stream listener
  useEffect(() => {
    refreshState();

    const eventSource = new EventSource('/api/stream');

    eventSource.onmessage = event => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'log') {
          setLogs(prev => [parsed.payload, ...prev.slice(0, 400)]);
        } else if (parsed.type === 'scan_completed') {
          setSummary(parsed.payload.summary);
          setIsScanning(false);
          refreshState();
        } else if (parsed.type === 'scanner_started') {
          setIsScanning(true);
        } else if (parsed.type === 'positions_synced' && parsed.payload?.positions) {
          setPositions(prev => {
            const syncedList: Position[] = parsed.payload.positions;
            const syncedMap = new Map(syncedList.map(p => [p.id, p]));
            return prev.map(p => syncedMap.get(p.id) || p);
          });
        } else if (parsed.type === 'order_executed') {
          refreshState();
        } else if (parsed.type === 'emergency_stop_changed') {
          setIsEmergencyStopped(parsed.payload.isEmergencyStopped);
          refreshState();
        }
      } catch {
        // ignore parse error
      }
    };

    const interval = setInterval(refreshState, 15000);

    return () => {
      eventSource.close();
      clearInterval(interval);
    };
  }, [refreshState]);

  // Actions
  const handleUpdateSettings = async (newSettings: Partial<TradingSettings>) => {
    const res = await fetch('/api/trading/settings', {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(newSettings),
    });
    const json = await res.json();
    if (!json.success) {
      const msg = json.error?.message || json.error || 'Failed to update settings';
      setErrorMessage(msg);
      throw new Error(msg);
    }
    setSettings(json.data);
    await refreshState();
  };

  const handleToggleAutoTrading = async () => {
    setErrorMessage(null);
    if (settings.autoTrading) {
      await fetch('/api/trading/stop', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
    } else {
      const res = await fetch('/api/trading/start', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const json = await res.json();
      if (!json.success) {
        const msg = json.error?.message || json.error || 'Failed to start auto trading';
        setErrorMessage(msg);
        alert(msg);
        return;
      }
    }
    await refreshState();
  };

  const handleRunScan = async () => {
    setIsScanning(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/scanner/run', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const json = await res.json();
      if (!json.success) {
        setErrorMessage(json.error?.message || 'Scan failed to run');
      }
      await refreshState();
    } catch (err: any) {
      console.error('Scan trigger error:', err);
    } finally {
      setIsScanning(false);
    }
  };

  const handleSwitchModeConfirm = async () => {
    if (!targetSwitchMode) return;
    setModalLoading(true);
    setErrorMessage(null);
    try {
      if (targetSwitchMode === 'REAL') {
        // Confirm real mode disclaimer with backend
        const confirmRes = await fetch('/api/trading/confirm-real-mode', {
          method: 'POST',
          headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ phrase: 'I UNDERSTAND THIS USES REAL BINANCE FUNDS' }),
        });
        const confirmJson = await confirmRes.json();
        if (!confirmJson.success) {
          throw new Error(confirmJson.error?.message || 'Failed to confirm REAL mode');
        }
      }

      await handleUpdateSettings({ mode: targetSwitchMode, autoTrading: false });
      setTargetSwitchMode(null);
    } catch (err: any) {
      setErrorMessage(err.message);
      alert(err.message);
    } finally {
      setModalLoading(false);
    }
  };

  const handleEmergencyStopConfirm = async () => {
    setModalLoading(true);
    try {
      await fetch('/api/trading/emergency-stop', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      setIsEmergencyStopped(true);
      setIsEmergencyStopModalOpen(false);
      await refreshState();
    } finally {
      setModalLoading(false);
    }
  };

  const handleResetEmergencyConfirm = async () => {
    setModalLoading(true);
    try {
      await fetch('/api/trading/emergency-reset', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      setIsEmergencyStopped(false);
      setIsResetEmergencyModalOpen(false);
      await refreshState();
    } finally {
      setModalLoading(false);
    }
  };

  const handleResetPaperConfirm = async () => {
    setModalLoading(true);
    try {
      await fetch('/api/wallet/reset-paper', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      setIsResetPaperModalOpen(false);
      await refreshState();
    } finally {
      setModalLoading(false);
    }
  };

  const handleManualSellConfirm = async () => {
    if (!sellPositionTarget) return;
    setModalLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/positions/${sellPositionTarget.id}/sell`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const json = await res.json();
      if (!json.success) {
        const msg = json.error?.message || json.error || 'Failed to sell position';
        setErrorMessage(msg);
        alert(msg);
        return;
      }
      setSellPositionTarget(null);
      await refreshState();
    } finally {
      setModalLoading(false);
    }
  };

  const handleSyncPositions = async () => {
    try {
      const res = await fetch('/api/positions/sync', {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ mode: settings.mode }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        setPositions(json.data);
        if (json.wallet) setWallet(json.wallet);
      }
    } catch {
      // ignore sync error
    }
  };

  const handleSyncWallet = async () => {
    await fetch('/api/wallet/sync', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ mode: settings.mode }),
    });
    await refreshState();
  };

  const handleConnectBinanceApi = async (apiKey: string, apiSecret: string) => {
    const res = await fetch('/api/binance/connect', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ apiKey, apiSecret }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || json.error || 'Connection failed');
    await refreshState();
  };

  const handleDisconnectBinanceApi = async () => {
    if (!confirm('Are you sure you want to remove your Binance Spot API credentials?')) return;
    await fetch('/api/binance/disconnect', {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    await refreshState();
  };

  const handleSelectSymbol = (symbol: string) => {
    setSelectedSymbol(symbol);
    setCurrentTab('analysis');
  };

  const selectedAnalysis = selectedSymbol
    ? analyses.find(a => a.symbol === selectedSymbol)
    : analyses[0];

  const activePositionsCount = positions.filter(p => p.mode === settings.mode && p.status === 'OPEN').length;

  return (
    <div className="min-h-screen bg-[#0b0e14] text-slate-100 flex flex-col font-sans">
      {/* Top Navbar */}
      <Navbar
        currentTab={currentTab}
        setCurrentTab={tab => {
          setCurrentTab(tab);
          if (tab !== 'analysis') setSelectedSymbol(null);
        }}
        mode={settings.mode}
        onOpenSwitchModeModal={mode => setTargetSwitchMode(mode)}
        autoTrading={settings.autoTrading}
        onToggleAutoTrading={handleToggleAutoTrading}
        fixedTradeAmount={settings.fixedTradeAmount}
        isEmergencyStopped={isEmergencyStopped}
        onOpenEmergencyStopModal={() => {
          if (isEmergencyStopped) {
            setIsResetEmergencyModalOpen(true);
          } else {
            setIsEmergencyStopModalOpen(true);
          }
        }}
        onOpenResetModal={() => setIsResetPaperModalOpen(true)}
        openPositionsCount={activePositionsCount}
        isScanning={isScanning}
      />

      {/* Error alert toast if active */}
      {errorMessage && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 w-full">
          <div className="p-3 bg-rose-500/15 border border-rose-500/40 rounded-xl text-xs font-mono text-rose-300 flex items-center justify-between">
            <span>⚠️ {errorMessage}</span>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-slate-400 hover:text-slate-200 font-bold px-2 py-0.5"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {currentTab === 'dashboard' && (
          <DashboardView
            mode={settings.mode}
            wallet={wallet}
            positions={positions}
            summary={summary}
            analyses={analyses}
            fixedTradeAmount={settings.fixedTradeAmount}
            autoTrading={settings.autoTrading}
            onRunScan={handleRunScan}
            isScanning={isScanning}
            onSelectSymbol={handleSelectSymbol}
            onOpenSellModal={pos => setSellPositionTarget(pos)}
            onOpenResetModal={() => setIsResetPaperModalOpen(true)}
          />
        )}

        {currentTab === 'scanner' && (
          <ScannerView
            analyses={analyses}
            positions={positions}
            mode={settings.mode}
            onSelectSymbol={handleSelectSymbol}
            onRunScan={handleRunScan}
            isScanning={isScanning}
          />
        )}

        {currentTab === 'analysis' && (
          <TokenDetailView
            symbol={selectedSymbol || (analyses[0]?.symbol ?? 'BTCUSDT')}
            analysis={selectedAnalysis}
            positions={positions}
            mode={settings.mode}
            onBack={() => setCurrentTab('scanner')}
            onOpenSellModal={pos => setSellPositionTarget(pos)}
          />
        )}

        {currentTab === 'trading' && (
          <TradingView
            settings={settings}
            mode={settings.mode}
            wallet={wallet}
            positions={positions}
            onUpdateSettings={handleUpdateSettings}
            onToggleAutoTrading={handleToggleAutoTrading}
            isEmergencyStopped={isEmergencyStopped}
            onOpenEmergencyStopModal={() => {
              if (isEmergencyStopped) {
                setIsResetEmergencyModalOpen(true);
              } else {
                setIsEmergencyStopModalOpen(true);
              }
            }}
          />
        )}

        {currentTab === 'positions' && (
          <PositionsView
            positions={positions}
            mode={settings.mode}
            onSelectSymbol={handleSelectSymbol}
            onOpenSellModal={pos => setSellPositionTarget(pos)}
            onOpenResetModal={() => setIsResetPaperModalOpen(true)}
            onSyncPositions={handleSyncPositions}
          />
        )}

        {currentTab === 'orders' && (
          <OrdersView
            trades={trades}
            orders={orders}
            mode={settings.mode}
          />
        )}

        {currentTab === 'paper_wallet' && (
          <PaperWalletView
            wallet={wallet}
            trades={trades}
            positions={positions}
            onOpenResetModal={() => setIsResetPaperModalOpen(true)}
            onSyncWallet={handleSyncWallet}
          />
        )}

        {currentTab === 'real_wallet' && (
          <RealWalletView
            wallet={wallet}
            account={accounts.find(a => a.mode === 'REAL')}
            onSyncWallet={handleSyncWallet}
            onConnectApi={handleConnectBinanceApi}
            onDisconnectApi={handleDisconnectBinanceApi}
          />
        )}

        {currentTab === 'settings' && (
          <SettingsView
            settings={settings}
            onUpdateSettings={handleUpdateSettings}
          />
        )}

        {currentTab === 'logs' && (
          <LogsView
            logs={logs}
          />
        )}
      </main>

      {/* Modals */}
      <SwitchToRealModal
        isOpen={targetSwitchMode === 'REAL'}
        onClose={() => setTargetSwitchMode(null)}
        onConfirm={handleSwitchModeConfirm}
        loading={modalLoading}
      />

      <SwitchToPaperModal
        isOpen={targetSwitchMode === 'PAPER'}
        onClose={() => setTargetSwitchMode(null)}
        onConfirm={handleSwitchModeConfirm}
        loading={modalLoading}
      />

      <EmergencyStopModal
        isOpen={isEmergencyStopModalOpen}
        onClose={() => setIsEmergencyStopModalOpen(false)}
        onConfirm={handleEmergencyStopConfirm}
        loading={modalLoading}
      />

      <ResetEmergencyStopModal
        isOpen={isResetEmergencyModalOpen}
        onClose={() => setIsResetEmergencyModalOpen(false)}
        onConfirm={handleResetEmergencyConfirm}
        loading={modalLoading}
      />

      <ResetPaperWalletModal
        isOpen={isResetPaperModalOpen}
        onClose={() => setIsResetPaperModalOpen(false)}
        onConfirm={handleResetPaperConfirm}
        loading={modalLoading}
      />

      <ManualSellModal
        isOpen={Boolean(sellPositionTarget)}
        position={sellPositionTarget}
        onClose={() => setSellPositionTarget(null)}
        onConfirm={handleManualSellConfirm}
        loading={modalLoading}
      />
    </div>
  );
}
