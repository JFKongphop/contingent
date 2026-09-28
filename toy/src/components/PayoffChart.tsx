'use client';

import React from 'react';

/**
 * Live binary-derivative payoff: your net P&L in each event outcome.
 * Win  → +（notional − premium）; Lose → −premium. Direction picks which outcome wins.
 */
export function PayoffChart({ notional, premium, isYes, compact = false }: { notional: number; premium: number; isYes: boolean; compact?: boolean }) {
  const N = Math.max(0, notional);
  const prem = Math.max(0, premium);
  const win = Math.max(0, N - prem);
  const yesPnl = isYes ? win : -prem; // P&L if the event happens (YES)
  const noPnl = isYes ? -prem : win; // P&L if it doesn't (NO)

  // compact: fits a half-width column (taller aspect) next to the open-hedge form
  const W = compact ? 560 : 1120, H = compact ? 380 : 210, mT = 30, mB = 40, mL = 20, mR = compact ? 36 : 20;
  const pw = W - mL - mR, ph = H - mT - mB;
  const maxUp = Math.max(win, 1);
  const maxDown = Math.max(prem, 1);
  const y0 = mT + (maxUp / (maxUp + maxDown)) * ph; // zero line
  const sUp = (y0 - mT) / maxUp;
  const sDn = (mT + ph - y0) / maxDown;
  const barW = compact ? 150 : 170;
  const fmt = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v)).toLocaleString();

  const bar = (cx: number, pnl: number, label: string, winning: boolean) => {
    const up = pnl >= 0;
    const h = up ? pnl * sUp : -pnl * sDn;
    const yy = up ? y0 - h : y0;
    const fill = up ? '#00F076' : '#FF3366';
    // up: value above the bar (dark green); down: value INSIDE the bar top (white) — never near the axis labels
    const valY = up ? yy - 9 : y0 + 22;
    return (
      <g key={label}>
        <rect x={cx - barW / 2} y={yy} width={barW} height={Math.max(2, h)} fill={fill} stroke="#000" strokeWidth="2" />
        <text x={cx} y={valY} textAnchor="middle" fontSize="19" fontWeight="700" fontFamily="'JetBrains Mono',monospace" fill={up ? '#00875a' : '#ffffff'}>{fmt(pnl)}</text>
        <text x={cx} y={H - 16} textAnchor="middle" fontSize="15" fontWeight="700" fontFamily="'JetBrains Mono',monospace" fill="#1b1b1b">{label}</text>
        <text x={cx} y={H - 3} textAnchor="middle" fontSize="11" fontFamily="'JetBrains Mono',monospace" fill="#64748b">{winning ? 'you win' : 'you lose'}</text>
      </g>
    );
  };

  return (
    <div className="neo-card bg-white p-3.5 flex flex-col">
      <div className="flex items-baseline justify-between mb-1">
        <div className="font-mono text-[11.5px] uppercase tracking-wider text-slate-500">Binary derivative · payoff</div>
        {compact && <div className="font-mono text-[11.5px] text-slate-500">net P&amp;L at resolution</div>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className={compact ? 'w-full flex-1 my-auto' : 'w-full'} style={{ height: 'auto' }} role="img" aria-label="Payoff diagram">
        {/* zero line */}
        <line x1={mL} y1={y0} x2={mL + pw} y2={y0} stroke="#000" strokeWidth="1.5" />
        <text x={mL + pw + 4} y={y0 + 4} textAnchor="end" fontSize="12" fontFamily="'JetBrains Mono',monospace" fill="#94a3b8">$0</text>
        {bar(mL + pw * (compact ? 0.27 : 0.3), yesPnl, 'EVENT YES', isYes)}
        {bar(mL + pw * (compact ? 0.73 : 0.7), noPnl, 'EVENT NO', !isYes)}
      </svg>
    </div>
  );
}
