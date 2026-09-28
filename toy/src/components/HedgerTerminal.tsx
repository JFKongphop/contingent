'use client';

import React, { useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '../context/Web3Context';
import { useMarket } from '../lib/useMarket';
import { encryptHedge } from '../lib/cofhe';
import { PayoffChart } from './PayoffChart';
import { EVENT_ID, USDG_DECIMALS, BPS } from '../config/contracts';

type Status = { kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string };

export function HedgerTerminal({ onGoPerps }: { onGoPerps?: () => void }) {
  const { write, provider, signer, isConnected, wrongNetwork, refresh } = useWeb3();
  const m = useMarket();

  const [isYes, setIsYes] = useState(true);
  const [notional, setNotional] = useState('400');
  const [st, setSt] = useState<Record<string, Status>>({});

  const set = (k: string, s: Status) => setSt((p) => ({ ...p, [k]: s }));
  const ready = isConnected && !wrongNetwork && !!write && !!provider && !!signer;

  const premium = useMemo(() => {
    const n = Number(notional) || 0;
    const pf = isYes ? m.probYesBps : BPS - m.probYesBps;
    return (n * pf) / BPS;
  }, [notional, isYes, m.probYesBps]);

  async function run(key: string, fn: () => Promise<string>) {
    if (!ready) { set(key, { kind: 'err', msg: 'Connect wallet on Arbitrum Sepolia first' }); return; }
    set(key, { kind: 'busy', msg: 'Submitting…' });
    try {
      const msg = await fn();
      set(key, { kind: 'ok', msg });
      refresh(); m.reload();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set(key, { kind: 'err', msg: (e as any)?.shortMessage ?? (e as any)?.message ?? 'Failed' });
    }
  }

  const openHedge = () => run('open', async () => {
    const size = ethers.parseUnits(notional || '0', USDG_DECIMALS);
    const enc = await encryptHedge(provider!, signer!, size, isYes);
    const tx = await write!.hedge.openHedge(EVENT_ID, enc.encSize, enc.sizeProof, enc.encIsYes, enc.dirProof);
    await tx.wait();
    return `Opened encrypted ${isYes ? 'YES' : 'NO'} hedge · size & side hidden`;
  });

  return (
    <div className="flex flex-col gap-3">
    <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-3">
      {/* left: open hedge */}
      <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="neo-badge-cyan px-2 py-0.5 text-[12px]">HEDGER</span>
          <h2 className="font-black text-lg">Open an encrypted event derivative</h2>
        </div>

        {/* direction */}
        <div>
          <div className="font-mono text-[11.5px] uppercase tracking-wider text-slate-600 mb-1">Direction (hidden on-chain)</div>
          <div className="grid grid-cols-2 gap-2">
            <button className="neo-btn" onClick={() => setIsYes(true)}
              style={isYes ? { background: '#00F076', boxShadow: '3px 3px 0 #000' } : { background: '#fff', boxShadow: '2px 2px 0 #000' }}>
              YES · event happens
            </button>
            <button className="neo-btn" onClick={() => setIsYes(false)}
              style={!isYes ? { background: '#FF3366', color: '#fff', boxShadow: '3px 3px 0 #000' } : { background: '#fff', boxShadow: '2px 2px 0 #000' }}>
              NO · it won&apos;t
            </button>
          </div>
        </div>

        {/* notional */}
        <label className="block">
          <div className="font-mono text-[11.5px] uppercase tracking-wider text-slate-600 mb-1">Notional (payout if you win)</div>
          <div className="neo-input flex items-center gap-2 px-3 py-2 focus-within:shadow-[3px_3px_0px_0px_#000]">
            <input className="flex-1 min-w-0 bg-transparent border-none outline-none p-0 font-mono font-bold text-sm" style={{ boxShadow: 'none' }} value={notional} onChange={(e) => setNotional(e.target.value)} inputMode="decimal" />
            <span className="font-mono text-[12px] text-slate-500 shrink-0 uppercase tracking-wide">USDG</span>
          </div>
        </label>

        {/* premium readout */}
        <div className="neo-card-sm bg-[#fafafa] p-3 flex items-center justify-between">
          <div>
            <div className="font-mono text-[11.5px] uppercase tracking-wider text-slate-600">Premium = size · {isYes ? 'p' : '(1−p)'} / 10000</div>
            <div className="font-black text-xl mono-num">{premium.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-sm font-mono text-slate-700">USDG</span></div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[11.5px] uppercase tracking-wider text-slate-600">at odds</div>
            <div className="font-black text-lg mono-num" style={{ color: '#9333ea' }}>{m.probPct.toFixed(1)}%</div>
          </div>
        </div>

        <button className="neo-btn neo-btn-cyan neo-btn-lg" onClick={openHedge} disabled={st.open?.kind === 'busy' || !m.open}>
          {st.open?.kind === 'busy' ? 'ENCRYPTING & OPENING…' : '🔒 OPEN ENCRYPTED HEDGE'}
        </button>
        <StatusLine s={st.open} />
        {!m.open && <div className="font-mono text-[12px] text-[#FF3366]">Market is closed / resolved — no new hedges.</div>}
        <p className="font-mono text-[12px] text-slate-600 mt-auto">
          Premium is paid from your <b>encrypted collateral</b> — wrap &amp; deposit it on{' '}
          <button className="underline font-bold text-black" onClick={onGoPerps}>PERPS</button> (shared balance).
        </p>
      </div>

      {/* right: live payoff of the hedge you're about to open */}
      <PayoffChart notional={Number(notional) || 0} premium={premium} isYes={isYes} compact />
    </div>
    </div>
  );
}

function StatusLine({ s }: { s?: Status }) {
  if (!s || s.kind === 'idle') return null;
  const color = s.kind === 'ok' ? '#00a854' : s.kind === 'err' ? '#FF3366' : '#64748b';
  return <div className="font-mono text-[12px] break-words" style={{ color }}>{s.kind === 'busy' ? '⏳ ' : s.kind === 'ok' ? '✓ ' : '✕ '}{s.msg}</div>;
}
