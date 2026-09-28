'use client';

import React, { useEffect, useState } from 'react';
import { STRIKE_USD, BINANCE_SYMBOL } from '../config/contracts';

// ── theme (the only part that differs between frontend/ and frontend-prof/) ──
const T = {
  frame: { fill: '#fafafa', stroke: '#000', width: 2, rx: 0 },
  yesZone: 'rgba(0,240,118,0.10)', noZone: 'rgba(255,51,102,0.08)',
  zoneLabel: { yes: '#00875a', no: '#d6164a' },
  line: '#000', lineWidth: 2.5,
  areaTop: 'rgba(0,229,255,0.30)', areaBottom: 'rgba(0,229,255,0)',
  strike: '#9333ea', grid: '#e2e2e2', axis: '#64748b',
  dot: '#00E5FF',
};

type Win = '24H' | '7D';
interface Pt { t: number; c: number }

// Binance public klines (CORS-enabled). 24H = 96 × 15m, 7D = 168 × 1h. Falls back to Coinbase.
async function fetchSeries(win: Win): Promise<Pt[]> {
  const [interval, limit, gran] = win === '24H' ? ['15m', 96, 900] : ['1h', 168, 3600];
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${BINANCE_SYMBOL}&interval=${interval}&limit=${limit}`);
    if (r.ok) return ((await r.json()) as (string | number)[][]).map((k) => ({ t: +k[0], c: +k[4] }));
  } catch { /* fall through */ }
  try {
    const r = await fetch(`https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=${gran}`);
    const j = (await r.json()) as number[][]; // [time, low, high, open, close, volume]
    return j.slice(0, limit as number).reverse().map((k) => ({ t: k[0] * 1000, c: k[4] }));
  } catch {
    return [];
  }
}

/** MARKET chart: where ETH is relative to the event's strike, with the YES / NO outcome zones shaded. */
export function EventChart({ title = 'ETH / USD · Chainlink' }: { title?: string }) {
  const [win, setWin] = useState<Win>('7D');
  const [pts, setPts] = useState<Pt[]>([]);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => { const s = await fetchSeries(win); if (!alive) return; if (s.length) { setPts(s); setErr(false); } else setErr(true); };
    load();
    const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [win]);

  const last = pts.length ? pts[pts.length - 1].c : 0;
  const above = last >= STRIKE_USD;
  const dist = last - STRIKE_USD, distPct = last ? (dist / STRIKE_USD) * 100 : 0;

  // geometry — the y-range always contains the strike, so the distance to it is visible
  const W = 760, H = 280, mL = 8, mR = 74, mT = 16, mB = 26;
  const pw = W - mL - mR, ph = H - mT - mB;
  const vals = pts.map((p) => p.c);
  let lo = Math.min(STRIKE_USD, ...(vals.length ? vals : [STRIKE_USD * 0.95]));
  let hi = Math.max(STRIKE_USD, ...(vals.length ? vals : [STRIKE_USD * 1.05]));
  const pad = (hi - lo) * 0.12 || STRIKE_USD * 0.02;
  lo -= pad; hi += pad;
  const y = (v: number) => mT + ph - ((v - lo) / Math.max(1, hi - lo)) * ph;
  const x = (i: number) => mL + (pts.length > 1 ? (i / (pts.length - 1)) * pw : pw / 2);
  const ys = y(STRIKE_USD);
  const usd = (v: number) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join('');
  const area = pts.length ? `${line}L${x(pts.length - 1).toFixed(1)},${mT + ph}L${x(0).toFixed(1)},${mT + ph}Z` : '';
  const tick = (i: number) => {
    const d = new Date(pts[i].t);
    return win === '24H' ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div className="neo-card bg-white p-3.5">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="pulse-dot" />
          <span className="font-black text-sm">{title}</span>
          <div className="flex gap-1 ml-1">
            {(['24H', '7D'] as Win[]).map((w) => (
              <button key={w} onClick={() => setWin(w)} className="neo-btn neo-btn-sm !px-2 !py-0.5 !text-[12px]"
                style={win === w ? { background: '#00E5FF', boxShadow: '2px 2px 0 #000' } : { background: '#fff', boxShadow: '2px 2px 0 #000' }}>
                {w}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-black mono-num text-lg">{last ? usd(last) : '—'}</span>
          {last > 0 && (
            <span className="font-mono text-[12px] px-2 py-0.5 border-2 border-black"
              style={{ color: above ? '#000' : '#fff', background: above ? '#00F076' : '#FF3366', boxShadow: '2px 2px 0 #000' }}>
              {dist >= 0 ? '+' : '−'}{usd(Math.abs(dist))} · {Math.abs(distPct).toFixed(1)}% {above ? 'above' : 'below'} strike · <b>{above ? 'YES' : 'NO'} winning</b>
            </span>
          )}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }} role="img" aria-label="ETH price relative to the event strike">
        <defs>
          <linearGradient id="ev-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={T.areaTop} />
            <stop offset="100%" stopColor={T.areaBottom} />
          </linearGradient>
          <clipPath id="ev-clip"><rect x={mL} y={mT} width={pw} height={ph} rx={T.frame.rx} /></clipPath>
        </defs>
        <rect x={mL} y={mT} width={pw} height={ph} rx={T.frame.rx} fill={T.frame.fill} stroke={T.frame.stroke} strokeWidth={T.frame.width} />
        <g clipPath="url(#ev-clip)">
          {/* outcome zones */}
          <rect x={mL} y={mT} width={pw} height={Math.max(0, ys - mT)} fill={T.yesZone} />
          <rect x={mL} y={ys} width={pw} height={Math.max(0, mT + ph - ys)} fill={T.noZone} />
          <text x={mL + 12} y={mT + 20} fontSize="12" fontWeight="700" fontFamily="'JetBrains Mono',monospace" fill={T.zoneLabel.yes} opacity="0.8">YES ZONE · ETH ≥ {usd(STRIKE_USD)}</text>
          <text x={mL + 12} y={mT + ph - 10} fontSize="12" fontWeight="700" fontFamily="'JetBrains Mono',monospace" fill={T.zoneLabel.no} opacity="0.8">NO ZONE · ETH &lt; {usd(STRIKE_USD)}</text>
          {/* price */}
          {area && <path d={area} fill="url(#ev-area)" />}
          {line && <path d={line} fill="none" stroke={T.line} strokeWidth={T.lineWidth} strokeLinejoin="round" strokeLinecap="round" />}
          {/* strike */}
          <line x1={mL} y1={ys} x2={mL + pw} y2={ys} stroke={T.strike} strokeWidth="2" strokeDasharray="7 5" />
        </g>
        {/* last price marker */}
        {pts.length > 0 && (
          <>
            <circle cx={x(pts.length - 1)} cy={y(last)} r="9" fill={T.dot} opacity="0.18" />
            <circle cx={x(pts.length - 1)} cy={y(last)} r="4.5" fill={T.dot} stroke="#fff" strokeWidth="2" />
          </>
        )}
        {/* right axis: high · strike · low, plus the live price */}
        {[hi - pad, lo + pad].map((v, i) => (
          <text key={i} x={mL + pw + 8} y={y(v) + 4} fontSize="12" fontFamily="'JetBrains Mono',monospace" fill={T.axis}>{usd(v)}</text>
        ))}
        <rect x={mL + pw + 4} y={ys - 11} width={66} height={22} fill={T.strike} stroke="#000" strokeWidth="1.5" />
        <text x={mL + pw + 37} y={ys + 4} textAnchor="middle" fontSize="11.5" fontWeight="700" fontFamily="'JetBrains Mono',monospace" fill="#fff">{usd(STRIKE_USD)}</text>
        {/* time axis */}
        {pts.length > 2 && [0, Math.floor((pts.length - 1) / 2), pts.length - 1].map((i, k) => (
          <text key={k} x={x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'} fontSize="11.5" fontFamily="'JetBrains Mono',monospace" fill={T.axis}>{tick(i)}</text>
        ))}
      </svg>
      {err && <div className="font-mono text-[12px] text-[#FF3366] text-center pb-1">Price feed unreachable (CORS/network). The on-chain resolver still reads Chainlink.</div>}
    </div>
  );
}
