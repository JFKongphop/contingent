'use client';

import React from 'react';
import { useMarket } from '../lib/useMarket';
import { EVENT_LABEL, STRIKE_USD } from '../config/contracts';

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="neo-card-sm px-3 py-2 min-w-[130px] flex-1 bg-white">
      <div className="font-mono text-[11.5px] uppercase tracking-wider text-slate-600">{label}</div>
      <div className="font-black text-lg mono-num leading-tight" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="font-mono text-[11.5px] text-slate-600">{sub}</div>}
    </div>
  );
}

export function MarketStatsBar() {
  const m = useMarket();
  const above = m.feedPrice >= STRIKE_USD;
  const status = m.resolved
    ? (m.outcomeYes ? 'RESOLVED · YES' : 'RESOLVED · NO')
    : m.open ? 'OPEN FOR HEDGING' : 'CLOSED';
  const statusColor = m.resolved ? (m.outcomeYes ? '#00F076' : '#FF3366') : m.open ? '#00E5FF' : '#64748b';

  return (
    <div className="neo-card bg-white p-3">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="neo-badge-cyan px-2 py-0.5 text-[12px]">EVENT</span>
          <span className="font-black text-sm">{EVENT_LABEL}</span>
        </div>
        <span className="font-mono text-[12px] px-2 py-0.5 border-2 border-black" style={{ background: statusColor, color: m.open || m.outcomeYes ? '#000' : '#fff', boxShadow: '2px 2px 0 #000' }}>
          {status}
        </span>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Stat label="Implied odds (p)" value={`${m.probPct.toFixed(1)}%`} sub="public market" color="#9333ea" />
        <Stat label="ETH / USD" value={`$${m.feedPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} sub={above ? `≥ $${STRIKE_USD} · YES` : `< $${STRIKE_USD} · NO`} color={above ? '#00a854' : '#FF3366'} />
        <Stat label="Vault reserve" value={`${m.reserve.toLocaleString()}`} sub="USDG · LP capital" color="#00F076" />
        <Stat label="Capacity" value={`${m.capacity.toLocaleString()}`} sub={`${m.paidOut.toLocaleString()} paid`} />
      </div>
    </div>
  );
}
