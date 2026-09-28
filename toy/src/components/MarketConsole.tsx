'use client';

import React, { useState } from 'react';
import { useWeb3 } from '../context/Web3Context';
import { useMarket } from '../lib/useMarket';
import { useActions, StatusLine, Field } from './ui';
import { EventChart } from './EventChart';
import { EVENT_ID } from '../config/contracts';

export function MarketConsole() {
  const { write } = useWeb3();
  const m = useMarket();
  const { st, run } = useActions();
  const [amt, setAmt] = useState('10');

  const stake = (yes: boolean) => run('stk', async () => {
    const tx = await write!.market.stake(EVENT_ID, yes, BigInt(amt || '0')); await tx.wait();
    m.reload();
    return `Staked ${amt} on ${yes ? 'YES' : 'NO'} · odds moved`;
  });

  const total = m.yesPool + m.noPool || 1;
  const yesPct = (m.yesPool / total) * 100;
  const noPct = 100 - yesPct;

  return (
    <div className="flex flex-col gap-3">
      <EventChart />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_0.9fr] gap-3">
      {/* the market */}
      <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="neo-badge-cyan px-2 py-0.5 text-[12px]" style={{ background: '#9333ea', color: '#fff' }}>PREDICTION MARKET</span>
          <h2 className="font-black text-lg">Public odds</h2>
        </div>

        {/* big odds */}
        <div className="neo-card-sm bg-[#fafafa] p-4 text-center">
          <div className="font-mono text-[11.5px] uppercase tracking-widest text-slate-600">Implied P(event) = yesPool / total</div>
          <div className="font-black text-6xl mono-num" style={{ color: '#9333ea' }}>{m.probPct.toFixed(1)}<span className="text-2xl">%</span></div>
        </div>

        {/* YES/NO split bar */}
        <div>
          <div className="flex justify-between font-mono text-[12px] mb-1">
            <span className="font-black" style={{ color: '#00a854' }}>YES {yesPct.toFixed(1)}%</span>
            <span className="font-black" style={{ color: '#FF3366' }}>{noPct.toFixed(1)}% NO</span>
          </div>
          <div className="flex h-9 border-2 border-black" style={{ boxShadow: '3px 3px 0 #000' }}>
            <div style={{ width: `${yesPct}%`, background: '#00F076' }} className="border-r-2 border-black" />
            <div style={{ width: `${noPct}%`, background: '#FF3366' }} />
          </div>
          <div className="flex justify-between font-mono text-[12px] mt-1 text-slate-700">
            <span>YES pool: <b>{m.yesPool.toLocaleString()}</b></span>
            <span>NO pool: <b>{m.noPool.toLocaleString()}</b></span>
          </div>
        </div>

        {/* stake to move odds */}
        <hr className="border-t-2 border-black" />
        <Field label="Stake (moves the odds)" value={amt} onChange={setAmt} suffix="units" />
        <div className="grid grid-cols-2 gap-2">
          <button className="neo-btn neo-btn-green" onClick={() => stake(true)} disabled={st.stk?.kind === 'busy' || !m.open}>STAKE YES ↑</button>
          <button className="neo-btn neo-btn-coral" onClick={() => stake(false)} disabled={st.stk?.kind === 'busy' || !m.open}>STAKE NO ↓</button>
        </div>
        <StatusLine s={st.stk} />
        {!m.open && <div className="font-mono text-[12px] text-[#FF3366]">Market closed / resolved — staking disabled.</div>}
      </div>

      {/* how it feeds the hedge */}
      <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
        <h3 className="font-black text-base">Prices your hedge</h3>
        <div className="neo-card-sm bg-[#fafafa] p-3 font-mono text-[13px]">
          premium = size · <span style={{ color: '#9333ea' }} className="font-black">p</span> / 10000
        </div>
        <Line k="YES · hedge $10k" v={`${(m.probYesBps).toLocaleString()} USDG`} />
        <Line k="NO · hedge $10k" v={`${(10000 - m.probYesBps).toLocaleString()} USDG`} />
        <p className="font-mono text-[12px] text-slate-600 leading-relaxed mt-1">
          Odds are public so discovery works. Your <b>position</b> (size + side) stays encrypted with
          Fhenix — you price off this number, you don&apos;t trade here.
        </p>
      </div>
      </div>
    </div>
  );
}

function Line({ k, v, c }: { k: string; v: string; c?: string }) {
  return (
    <div className="flex items-center justify-between border-b-2 border-dashed border-gray-200 pb-1.5">
      <span className="font-mono text-[12px] uppercase tracking-wide text-slate-600">{k}</span>
      <span className="font-black mono-num" style={c ? { color: c } : undefined}>{v}</span>
    </div>
  );
}
