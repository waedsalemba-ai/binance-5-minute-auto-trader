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
  ResetPaperWalletModal,
  ManualSellModal,
  AdminUnlockModal,
} from './components/Modals.tsx';

export default function App() {
  const [currentTab, setCurrentTab] = useState<string>('dashboard');
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string>(() => {
    return sessionStorage.getItem('admin_session_token') || '';
  });
  const [isAdminModalOpen, setIsAdminModalOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);

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
    scanIntervalMs: 120000,
    takeProfitPercent: 2.0,
    stopLossPercent: 3.0,
    minProfitForTechnicalExitPercent: 0.20,
    maxExitPriceAgeMs: 5000,
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

  // Modals state
  const [targetSwitchMode, setTargetSwitchMode] = useState<TradingMode | null>(null);
  const [isEmergencyStopModalOpen, setIsEmergencyStopModalOpen] = useState(false);
  const [isResetPaperModalOpen, setIsResetPaperModalOpen] = useState(false);
  const [sellPositionTarget, setSellPositionTarget] = useState<Position | null>(null);
  const [modalLoading, setModalLoading] = useState(false);

  // Safe fetch helper that won't reject or throw unhandled exceptions
  const safeFetch = async <T = any>(url: string): Promise<T | null> => {
    try {
      const res = await fetch(url);
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
  };

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

      if (settingsRes.status === 'fulfilled' && settingsRes.value?.success) {
        setSettings(settingsRes.value.data);
      }
      if (tradingStatusRes.status === 'fulfilled' && tradingStatusRes.value?.success) {
        setWallet(tradingStatusRes.value.data.wallet);
        setIsEmergencyStopped(tradingStatusRes.value.data.emergencyStop);
      }
      if (scannerRes.status === 'fulfilled' && scannerRes.value?.success) {
        setAnalyses(scannerRes.value.data);
      }
      if (positionsRes.status === 'fulfilled' && positionsRes.value?.success) {
        setPositions(positionsRes.value.data);
      }
      if (ordersRes.status === 'fulfilled' && ordersRes.value?.success) {
        setOrders(ordersRes.value.data);
      }
      if (tradesRes.status === 'fulfilled' && tradesRes.value?.success) {
        setTrades(tradesRes.value.data);
      }
      if (logsRes.status === 'fulfilled' && logsRes.value?.success) {
        setLogs(logsRes.value.data);
      }
      if (scannerStatusRes.status === 'fulfilled' && scannerStatusRes.value?.success) {
        setSummary(scannerStatusRes.value.data);
        setIsScanning(scannerStatusRes.value.data.isScanning);
      }
    } catch (err) {
      // Graceful fallback
    }
  }, []);

  useEffect(() => {
    refreshState();

    // Setup SSE stream for real-time live events
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
        } else if (parsed.type === 'order_executed') {
          refreshState();
        } else if (parsed.type === 'emergency_stop_changed') {
          setIsEmergencyStopped(parsed.payload.isEmergencyStopped);
        }
      } catch (err) {
        // ignore parse error
      }
    };

    const interval = setInterval(refreshState, 15000);

    return () => {
      eventSource.close();
      clearInterval(interval);
    };
  }, [refreshState]);

  // Authenticated fetch helper
  const authFetch = async (url: string, options: RequestInit = {}) => {
    try {
      const headers = new Headers(options.headers || {});
      if (sessionToken) {
        headers.set('X-Session-Token', sessionToken);
      }
      const response = await fetch(url, { ...options, headers });
      if (response.status === 401) {
        setIsAdminModalOpen(true);
      }
      return response;
    } catch (err) {
      console.warn(`Request failed for ${url}:`, err);
      return new Response(JSON.stringify({ success: false, error: 'Network request error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };

  const handleLoginSuccess = (token: string) => {
    setSessionToken(token);
    sessionStorage.setItem('admin_session_token', token);
    refreshState();
  };

  // Actions
  const handleUpdateSettings = async (newSettings: Partial<TradingSettings>) => {
    try {
      const res = await authFetch('/api/trading/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });
      if (res.status === 401) return;
      const json = await res.json();
      if (!json.success) {
        console.error(json.error);
        return;
      }
      setSettings(json.data);
      await refreshState();
    } catch (err: any) {
      console.error('Settings update error:', err);
    }
  };

  const handleToggleAutoTrading = async () => {
    try {
      if (settings.autoTrading) {
        const res = await authFetch('/api/trading/stop', { method: 'POST' });
        if (res.status === 401) return;
      } else {
        const res = await authFetch('/api/trading/start', { method: 'POST' });
        if (res.status === 401) return;
        const json = await res.json();
        if (!json.success) {
          alert(json.error || 'Failed to start auto trading');
          return;
        }
      }
      await refreshState();
    } catch (err: any) {
      console.error('Toggle auto trading error:', err);
    }
  };

  const handleRunScan = async () => {
    setIsScanning(true);
    try {
      const res = await authFetch('/api/scanner/run', { method: 'POST' });
      if (res.status === 401) return;
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
    try {
      await handleUpdateSettings({ mode: targetSwitchMode, autoTrading: false });
      setTargetSwitchMode(null);
    } finally {
      setModalLoading(false);
    }
  };

  const handleEmergencyStopConfirm = async () => {
    setModalLoading(true);
    try {
      const res = await authFetch('/api/trading/emergency-stop', { method: 'POST' });
      if (res.status === 401) return;
      setIsEmergencyStopped(true);
      setIsEmergencyStopModalOpen(false);
      await refreshState();
    } finally {
      setModalLoading(false);
    }
  };

  const handleResetPaperConfirm = async () => {
    setModalLoading(true);
    try {
      const res = await authFetch('/api/wallet/reset-paper', { method: 'POST' });
      if (res.status === 401) return;
      setIsResetPaperModalOpen(false);
      await refreshState();
    } finally {
      setModalLoading(false);
    }
  };

  const handleManualSellConfirm = async () => {
    if (!sellPositionTarget) return;
    setModalLoading(true);
    try {
      const res = await authFetch(`/api/positions/${sellPositionTarget.id}/sell`, { method: 'POST' });
      if (res.status === 401) return;
      const json = await res.json();
      if (!json.success) {
        alert(json.error || 'Failed to sell position');
        return;
      }
      setSellPositionTarget(null);
      await refreshState();
    } finally {
      setModalLoading(false);
    }
  };

  const handleSyncWallet = async () => {
    try {
      const res = await authFetch('/api/wallet/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: settings.mode }),
      });
      if (res.status === 401) return;
      await refreshState();
    } catch (err: any) {
      console.error('Sync wallet error:', err);
    }
  };

  const handleConnectBinanceApi = async (apiKey: string, apiSecret: string) => {
    try {
      const res = await authFetch('/api/binance/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, apiSecret }),
      });
      if (res.status === 401) return;
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      await refreshState();
    } catch (err: any) {
      alert(err.message || 'Failed to connect Binance API');
    }
  };

  const handleDisconnectBinanceApi = async () => {
    if (!confirm('Are you sure you want to remove your Binance Spot API credentials?')) return;
    try {
      const res = await authFetch('/api/binance/disconnect', { method: 'POST' });
      if (res.status === 401) return;
      await refreshState();
    } catch (err: any) {
      console.error('Disconnect API error:', err);
    }
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
        onOpenEmergencyStopModal={() => setIsEmergencyStopModalOpen(true)}
        onOpenResetModal={() => setIsResetPaperModalOpen(true)}
        openPositionsCount={activePositionsCount}
        isScanning={isScanning}
      />

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
            onOpenEmergencyStopModal={() => setIsEmergencyStopModalOpen(true)}
          />
        )}

        {currentTab === 'positions' && (
          <PositionsView
            positions={positions}
            mode={settings.mode}
            onSelectSymbol={handleSelectSymbol}
            onOpenSellModal={pos => setSellPositionTarget(pos)}
            onOpenResetModal={() => setIsResetPaperModalOpen(true)}
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
            authFetch={authFetch}
          />
        )}

        {currentTab === 'logs' && (
          <LogsView
            logs={logs}
          />
        )}
      </main>

      {/* Confirmation & Action Modals */}
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

      <ResetPaperWalletModal
        isOpen={isResetPaperModalOpen}
        onClose={() => setIsResetPaperModalOpen(false)}
        onConfirm={handleResetPaperConfirm}
        loading={modalLoading}
      />

      <ManualSellModal
        isOpen={sellPositionTarget !== null}
        onClose={() => setSellPositionTarget(null)}
        onConfirm={handleManualSellConfirm}
        position={sellPositionTarget}
        loading={modalLoading}
      />

      <AdminUnlockModal
        isOpen={isAdminModalOpen}
        onClose={() => setIsAdminModalOpen(false)}
        onSuccess={handleLoginSuccess}
      />
    </div>
  );
}
