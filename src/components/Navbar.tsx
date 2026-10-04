import React from 'react';
import {
  Activity,
  Layers,
  Radio,
  Sliders,
  Wallet,
  Clock,
  Power,
  ShieldAlert,
  BarChart3,
  ListOrdered,
  FileText,
  Key,
  RotateCcw,
} from 'lucide-react';
import { TradingMode } from '../types/index.ts';
import { FirebaseAuthButton } from './FirebaseAuthButton.tsx';

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  mode: TradingMode;
  onOpenSwitchModeModal: (targetMode: TradingMode) => void;
  autoTrading: boolean;
  onToggleAutoTrading: () => void;
  fixedTradeAmount: number;
  isEmergencyStopped: boolean;
  onOpenEmergencyStopModal: () => void;
  onOpenResetModal: () => void;
  openPositionsCount: number;
  isScanning: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  setCurrentTab,
  mode,
  onOpenSwitchModeModal,
  autoTrading,
  onToggleAutoTrading,
  fixedTradeAmount,
  isEmergencyStopped,
  onOpenEmergencyStopModal,
  onOpenResetModal,
  openPositionsCount,
  isScanning,
}) => {
  const isReal = mode === 'REAL';

  return (
    <header className="sticky top-0 z-40 w-full bg-[#0d131f]/95 backdrop-blur-md border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Top Tier: Branding, Mode, Trade Amount, Auto-Trading, Reset & Emergency Stop */}
        <div className="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-slate-800/60">
          {/* Logo & Title */}
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 shadow-lg shadow-amber-500/20 text-slate-950 font-black text-xl">
              ₿
              <span className={`absolute -top-1 -right-1 w-3 h-3 rounded-full border-2 border-[#0d131f] ${isScanning ? 'bg-amber-400 animate-ping' : 'bg-emerald-400'}`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base sm:text-lg tracking-tight text-slate-100">BINANCE 5M</span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-mono">
                  SCANNER & AUTO TRADER
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Binance Spot Live
                </span>
                <span>•</span>
                <span>5-Minute Interval</span>
                {isScanning && <span className="text-amber-400 animate-pulse font-mono">• Scanning...</span>}
              </div>
            </div>
          </div>

          {/* Quick Actions & Status Badges */}
          <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
            {/* Fixed Trade Amount Pill */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono">
              <span className="text-slate-400">Fixed Trade:</span>
              <span className="font-bold text-amber-400">{fixedTradeAmount.toFixed(2)} USDT</span>
            </div>

            {/* Trading Mode Badge & Toggle */}
            <div className="flex items-center p-0.5 bg-slate-900 border border-slate-800 rounded-xl">
              <button
                onClick={() => isReal && onOpenSwitchModeModal('PAPER')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  !isReal
                    ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                PAPER
              </button>
              <button
                onClick={() => !isReal && onOpenSwitchModeModal('REAL')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                  isReal
                    ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/30 animate-pulse'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {isReal && <span className="w-2 h-2 rounded-full bg-slate-950 animate-ping" />}
                REAL FUNDS
              </button>
            </div>

            {/* Auto Trading Switch */}
            <button
              onClick={onToggleAutoTrading}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all border ${
                autoTrading
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/20'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700'
              }`}
            >
              <Power className={`w-3.5 h-3.5 ${autoTrading ? 'text-emerald-400' : 'text-slate-500'}`} />
              Auto Trading: <span className="font-mono">{autoTrading ? 'ON' : 'OFF'}</span>
            </button>

            {/* Reset Positions & Wallet Button */}
            <button
              onClick={onOpenResetModal}
              title="Reset all active positions and restore wallet balance to default 1000 USDT"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500 hover:text-slate-950 shadow-sm"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Positions & Balance</span>
            </button>

            {/* Emergency Stop Button */}
            <button
              onClick={onOpenEmergencyStopModal}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all shadow-md ${
                isEmergencyStopped
                  ? 'bg-rose-600 text-white animate-pulse'
                  : 'bg-rose-500/15 text-rose-400 border border-rose-500/30 hover:bg-rose-500 hover:text-white'
              }`}
            >
              <ShieldAlert className="w-4 h-4" />
              <span className="hidden sm:inline">EMERGENCY STOP</span>
            </button>

            {/* Firebase Auth Account Button */}
            <FirebaseAuthButton />
          </div>
        </div>

        {/* Bottom Tier: Navigation Tabs */}
        <nav className="flex items-center gap-1 py-2 overflow-x-auto no-scrollbar text-xs font-medium">
          {[
            { id: 'dashboard', label: 'Dashboard', icon: Activity },
            { id: 'scanner', label: 'Scanner', icon: Radio },
            { id: 'analysis', label: 'Token Analysis', icon: BarChart3 },
            { id: 'trading', label: 'Trading & Safety', icon: Sliders },
            {
              id: 'positions',
              label: 'Positions',
              icon: Layers,
              badge: openPositionsCount > 0 ? openPositionsCount : undefined,
            },
            { id: 'orders', label: 'Orders & History', icon: ListOrdered },
            { id: 'paper_wallet', label: 'Paper Wallet', icon: Wallet },
            { id: 'real_wallet', label: 'Real Binance', icon: Key },
            { id: 'settings', label: 'Settings', icon: Sliders },
            { id: 'logs', label: 'System Logs', icon: FileText },
          ].map(tab => {
            const Icon = tab.icon;
            const isActive = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setCurrentTab(tab.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg whitespace-nowrap transition-colors ${
                  isActive
                    ? 'bg-slate-800 text-amber-400 font-semibold border border-slate-700/80 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-amber-400' : 'text-slate-400'}`} />
                <span>{tab.label}</span>
                {tab.badge !== undefined && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-amber-500 text-slate-950 font-bold">
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
