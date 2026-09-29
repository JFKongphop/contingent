'use client';

import React, { useEffect, useState } from 'react';
import { STRIKE_USD, BINANCE_SYMBOL, EVENT_LABEL } from '../config/contracts';

interface Candle { o: number; h: number; l: number; c: number }

// Binance public klines (CORS-enabled, no key). Falls back to Coinbase if blocked.
async function fetchCandles(): Promise<Candle[]> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${BINANCE_SYMBOL}&interval=15m&limit=56`);
    if (r.ok) {
      const j = (await r.json()) as string[][];
      return j.map((k) => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
    }
  } catch { /* fall through */ }
  try {
    const r = await fetch('https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=900');
    const j = (await r.json()) as number[][]; // [time, low, high, open, close, volume]
    return j.slice(0, 56).reverse().map((k) => ({ o: k[3], h: k[2], l: k[1], c: k[4] }));
  } catch {
    return [];
  }
}

export function EthChart({ showStrike = true, title }: { showStrike?: boolean; title?: string } = {}) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const c = await fetchCandles();
      if (!alive) return;
      if (c.length) setCandles(c); else setErr(true);
    };
    load();
    const id = setInterval(load, 20000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const last = candles.length ? candles[candles.length - 1].c : 0;
  const above = last >= STRIKE_USD;

  // geometry
  const W = 680, H = 240, mL = 6, mR = 60, mT = 14, mB = 8;
  const pw = W - mL - mR, ph = H - mT - mB;
  const lows = candles.map((c) => c.l), highs = candles.map((c) => c.h);
  const anchor = showStrike ? [STRIKE_USD] : [];
  let lo = candles.length ? Math.min(...lows, ...anchor) : STRIKE_USD * 0.95;
  let hi = candles.length ? Math.max(...highs, ...anchor) : STRIKE_USD * 1.05;
  const pad = (hi - lo) * 0.08 || STRIKE_USD * 0.02;
  lo -= pad; hi += pad;
  const y = (v: number) => mT + ph - ((v - lo) / Math.max(1, hi - lo)) * ph;
  const n = Math.max(candles.length, 1);
  const cw = pw / n;
  const bodyW = Math.min(11, Math.max(2, cw * 0.62));
  const usd = (v: number) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 });

  return (
    <div className="neo-card bg-white p-3.5">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="pulse-dot" />
          <span className="font-black text-sm">{title ?? 'ETH / USD · Chainlink'}</span>
          <span className="font-mono text-[12px] text-slate-500 uppercase">15m · live</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-black mono-num text-lg">{last ? usd(last) : '—'}</span>
          {showStrike && (
            <span className="font-mono text-[12.5px] px-2.5 py-0.5 rounded-full border" style={{ color: above ? '#047857' : '#be123c', background: above ? '#ecfdf5' : '#fff1f2', borderColor: above ? '#a7f3d0' : '#fecdd3' }}>
              {above ? 'YES · above strike' : 'NO · below strike'}
            </span>
          )}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 'auto' }} role="img" aria-label="ETH/USD candlestick chart">
        <rect x={mL} y={mT} width={pw} height={ph} rx="10" fill="#fcfcfd" stroke="#e2e8f0" strokeWidth="1" />
        {/* price gridlines */}
        {[0, 0.5, 1].map((f, i) => {
          const v = lo + (hi - lo) * (1 - f), yy = mT + ph * f;
          return (
            <g key={i}>
              <line x1={mL} y1={yy} x2={mL + pw} y2={yy} stroke="#e2e2e2" strokeWidth="1" strokeDasharray="3 3" />
              <text x={mL + pw + 6} y={yy + 4} fontSize="11" fontFamily="'JetBrains Mono',monospace" fill="#64748b">{usd(v)}</text>
            </g>
          );
        })}
        {/* candles */}
        {candles.map((c, i) => {
          const cx = mL + cw * i + cw / 2;
          const up = c.c >= c.o;
          const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
          return (
            <g key={i}>
              <line x1={cx} y1={y(c.h)} x2={cx} y2={y(c.l)} stroke="#94a3b8" strokeWidth="1" />
              <rect x={cx - bodyW / 2} y={top} width={bodyW} height={Math.max(1.5, bot - top)} fill={up ? '#10b981' : '#f43f5e'} stroke={up ? '#059669' : '#e11d48'} strokeWidth="1" />
            </g>
          );
        })}
        {/* strike line */}
        {showStrike && (
          <>
            <line x1={mL} y1={y(STRIKE_USD)} x2={mL + pw} y2={y(STRIKE_USD)} stroke="#6d28d9" strokeWidth="2.5" strokeDasharray="6 3" />
            <rect x={mL + 4} y={y(STRIKE_USD) - 16} width={198} height={15} fill="#6d28d9" />
            <text x={mL + 8} y={y(STRIKE_USD) - 4} fontSize="11" fontFamily="'JetBrains Mono',monospace" fill="#fff" fontWeight="700">STRIKE {usd(STRIKE_USD)} · {EVENT_LABEL}</text>
          </>
        )}
      </svg>
      {err && <div className="font-mono text-[12.5px] text-[#e11d48] text-center pb-1">Price feed unreachable (CORS/network). The on-chain resolver still reads Chainlink.</div>}
    </div>
  );
}
