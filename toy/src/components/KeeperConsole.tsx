'use client';

import React, { useState } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '../context/Web3Context';
import { useMarket } from '../lib/useMarket';
import { useActions, StatusLine, Field } from './ui';
import { decryptForTx } from '../lib/cofhe';
import { EVENT_ID, USDG_DECIMALS } from '../config/contracts';

export function KeeperConsole() {
  const { write, read, provider, signer } = useWeb3();
  const m = useMarket();
  const { st, run } = useActions();
  const [posId, setPosId] = useState('1');

  const resolve = () => run('res', async () => {
    const tx = await write!.market.resolve(EVENT_ID); await tx.wait();
    return `Resolved · outcome ${(await read.market.isResolved(EVENT_ID))[1] ? 'YES' : 'NO'}`;
  });

  const settle = () => run('set', async () => {
    const id = BigInt(posId || '0');
    if (await read.hedge.paid(id)) return `#${id} is already settled`;
    // 1. compute payout (branchless) + allowPublic — skipped if an earlier attempt already did it
    const requested = (await read.hedge.payoutHandle(id)) !== ethers.ZeroHash;
    let tx;
    if (!requested) { tx = await write!.hedge.requestSettlement(id, { gasLimit: 1_500_000 }); await tx.wait(); }
    // 2. off-chain decrypt of the payout handle
    const handle = await read.hedge.payoutHandle(id) as string;
    const { value, signature } = await decryptForTx(provider!, signer!, handle);
    // 3. verify on-chain + pay winner
    tx = await write!.hedge.fulfillSettlement(id, value, signature, { gasLimit: 800_000 }); await tx.wait();
    const paid = Number(ethers.formatUnits(value, USDG_DECIMALS));
    return paid > 0 ? `Paid ${paid.toLocaleString()} USDG to the winner` : 'Loser — payout 0';
  });

  const sweep = () => run('swp', async () => {
    let tx = await write!.hedge.requestPremiumSweep(EVENT_ID, { gasLimit: 800_000 }); await tx.wait();
    const handle = await read.vault.premiumPool(EVENT_ID) as string;
    const { value, signature } = await decryptForTx(provider!, signer!, handle);
    tx = await write!.hedge.sweepPremiums(EVENT_ID, value, signature, { gasLimit: 400_000 }); await tx.wait();
    return `Swept ${Number(ethers.formatUnits(value, USDG_DECIMALS)).toLocaleString()} USDG premium to LPs`;
  });

  const finalise = () => run('fin', async () => {
    const tx = await write!.hedge.finaliseEvent(EVENT_ID); await tx.wait();
    return 'Event finalised · capacity released';
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
        <div className="flex items-center gap-2"><span className="neo-badge-yellow px-2 py-0.5 text-[12px]">KEEPER</span><h2 className="font-black text-lg">Settlement</h2></div>
        <button className="neo-btn neo-btn-yellow neo-btn-lg" onClick={resolve} disabled={st.res?.kind === 'busy' || m.resolved}>
          {m.resolved ? '✓ RESOLVED' : st.res?.kind === 'busy' ? 'RESOLVING…' : '1 · RESOLVE EVENT'}
        </button>
        <StatusLine s={st.res} />

        <hr className="border-t-2 border-black" />
        <Field label="Position id to settle" value={posId} onChange={setPosId} />
        <button className="neo-btn neo-btn-cyan neo-btn-lg" onClick={settle} disabled={st.set?.kind === 'busy' || !m.resolved}>
          {st.set?.kind === 'busy' ? 'SETTLING (decrypt…)' : '2 · SETTLE POSITION'}
        </button>
        <StatusLine s={st.set} />
      </div>

      <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
        <h3 className="font-black text-base">Post-settlement</h3>
        <button className="neo-btn neo-btn-green neo-btn-lg" onClick={sweep} disabled={st.swp?.kind === 'busy' || !m.resolved || m.premiumsSwept}>
          {m.premiumsSwept ? '✓ PREMIUMS SWEPT' : st.swp?.kind === 'busy' ? 'SWEEPING…' : '3 · SWEEP PREMIUMS → LPs'}
        </button>
        <StatusLine s={st.swp} />
        <button className="neo-btn neo-btn-white neo-btn-lg" onClick={finalise} disabled={st.fin?.kind === 'busy'}>4 · FINALISE EVENT</button>
        <StatusLine s={st.fin} />

        <div className="neo-card-sm bg-[#fafafa] p-3 mt-1 grid grid-cols-2 gap-2 font-mono text-[12px]">
          <div><span className="text-slate-600">reserve</span><div className="font-black mono-num">{m.reserve.toLocaleString()}</div></div>
          <div><span className="text-slate-600">paid out</span><div className="font-black mono-num">{m.paidOut.toLocaleString()}</div></div>
          <div><span className="text-slate-600">capacity</span><div className="font-black mono-num">{m.capacity.toLocaleString()}</div></div>
          <div><span className="text-slate-600">swept</span><div className="font-black mono-num">{m.premiumsSwept ? 'yes' : 'no'}</div></div>
        </div>
      </div>
    </div>
  );
}
