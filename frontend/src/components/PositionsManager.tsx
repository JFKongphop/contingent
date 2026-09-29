'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useWeb3 } from '../context/Web3Context';
import { useMarket } from '../lib/useMarket';
import { useActions, StatusLine } from './ui';
import { BPS } from '../config/contracts';

interface Pos { id: number; entryProbBps: number; openedAt: number; }

export function PositionsManager() {
  const { read, account } = useWeb3();
  const m = useMarket();
  const { st, run } = useActions();
  const { write } = useWeb3();
  const [rows, setRows] = useState<Pos[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!account) { setRows([]); return; }
    setLoading(true);
    const out: Pos[] = [];
    try {
      const next = m.nextPositionId;
      for (let id = 1; id < next; id++) {
        const owner = await read.nft.ownerOrZero(id).catch(() => '0x0000000000000000000000000000000000000000');
        if (owner?.toLowerCase() !== account.toLowerCase()) continue;
        const p = await read.positions.get(id).catch(() => null);
        if (p) out.push({ id, entryProbBps: Number(p.entryProbBps), openedAt: Number(p.openedAt) });
      }
    } catch { /* ignore */ }
    setRows(out);
    setLoading(false);
  }, [account, read, m.nextPositionId]);

  useEffect(() => { load(); }, [load]);

  const close = (id: number) => run(`c${id}`, async () => {
    const tx = await write!.hedge.closeHedge(id, { gasLimit: 2_000_000 }); await tx.wait();
    load(); return `Closed #${id} · premium refunded`;
  });

  if (!account) return null;
  return (
    <div className="neo-card bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-black text-lg">Your hedges</h2>
        <button className="neo-btn neo-btn-white neo-btn-sm" onClick={load}>{loading ? '…' : 'REFRESH'}</button>
      </div>
      {rows.length === 0 ? (
        <div className="font-mono text-[12px] text-slate-600 py-6 text-center">No open hedges. Open one above — your size &amp; side stay encrypted.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((p) => (
            <div key={p.id} className="neo-card-sm bg-slate-50 p-3 flex flex-wrap items-center gap-3 justify-between">
              <div className="flex items-center gap-3">
                <span className="font-black mono-num text-lg">#{p.id}</span>
                <span className="neo-pill px-2 py-0.5 text-[12.5px] bg-white">🔒 size &amp; side encrypted</span>
                <span className="font-mono text-[12.5px] text-slate-700">entry odds {(p.entryProbBps / BPS * 100).toFixed(1)}%</span>
              </div>
              <div className="flex items-center gap-2">
                {m.open && <button className="neo-btn neo-btn-white neo-btn-sm" onClick={() => close(p.id)} disabled={st[`c${p.id}`]?.kind === 'busy'}>{st[`c${p.id}`]?.kind === 'busy' ? '…' : 'CLOSE'}</button>}
                {m.resolved && <span className="neo-badge-yellow px-2 py-0.5 text-[12.5px]">settle in Keeper tab →</span>}
              </div>
              <div className="w-full"><StatusLine s={st[`c${p.id}`]} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
