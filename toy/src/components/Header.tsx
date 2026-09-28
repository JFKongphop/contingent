'use client';

import React from 'react';
import { useWeb3 } from '../context/Web3Context';

export type Tab = 'market' | 'perps' | 'hedge' | 'lp' | 'keeper';

const TABS: { id: Tab; label: string; color: string }[] = [
  { id: 'perps', label: 'PERPS', color: '#00E5FF' },
  { id: 'market', label: 'MARKET', color: '#9333ea' },
  { id: 'hedge', label: 'HEDGE', color: '#00E5FF' },
  { id: 'lp', label: 'UNDERWRITE', color: '#00F076' },
  { id: 'keeper', label: 'SETTLE', color: '#FFE600' },
];

export function Header({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const { account, isConnecting, connect, wrongNetwork, switchNetwork, balances, blockNumber } = useWeb3();
  const short = account ? `${account.slice(0, 6)}…${account.slice(-4)}` : null;

  return (
    <header className="w-full bg-white border-b-2 border-black sticky top-0 z-50">
      {/* top tier */}
      <div className="w-full max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14 gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-[#00E5FF] text-black border-2 border-black flex items-center justify-center font-black" style={{ boxShadow: '3px 3px 0 #000' }}>C</div>
          <div className="leading-none">
            <div className="font-black tracking-tight text-lg">CONTINGENT</div>
            <div className="font-mono text-[11.5px] text-slate-700 uppercase tracking-wider">confidential event hedging</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex items-center gap-1.5 font-mono text-[12px] text-slate-700 border-2 border-black px-2 py-1" style={{ boxShadow: '2px 2px 0 #000' }}>
            <span className="pulse-dot" /> blk {blockNumber || '—'}
          </span>
          {account && (
            <span className="hidden md:inline font-mono text-[12px] neo-pill px-2.5 py-1 bg-white">{balances.usdg} USDG</span>
          )}
          {wrongNetwork && (
            <button className="neo-btn neo-btn-coral neo-btn-sm" onClick={switchNetwork}>WRONG NET · SWITCH</button>
          )}
          {short ? (
            <span className="neo-btn neo-btn-white neo-btn-sm cursor-default">{short}</span>
          ) : (
            <button className="neo-btn neo-btn-cyan neo-btn-sm" onClick={connect} disabled={isConnecting}>
              {isConnecting ? 'CONNECTING…' : 'CONNECT WALLET'}
            </button>
          )}
        </div>
      </div>
      {/* nav tier */}
      <div className="w-full border-t-2 border-black bg-[#fafafa]">
        <div className="w-full max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 flex gap-2 overflow-x-auto py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              className="neo-btn neo-btn-sm shrink-0"
              style={active === t.id
                ? { background: '#00E5FF', color: '#000', boxShadow: '3px 3px 0 #000' }
                : { background: '#fff', color: '#000', boxShadow: '2px 2px 0 #000' }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
