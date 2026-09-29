'use client';

import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '../context/Web3Context';
import { useMarket } from '../lib/useMarket';
import { useActions, StatusLine, Field } from './ui';
import { ADDRESSES, USDG_DECIMALS } from '../config/contracts';

export function LPConsole() {
  const { write, account, read, eventId } = useWeb3();
  const m = useMarket();
  const { st, run } = useActions();
  const [amount, setAmount] = useState('50000');
  const [cap, setCap] = useState('100000');
  const [shares, setShares] = useState('0');

  useEffect(() => {
    if (!account) return;
    read.vault.sharesOf(account).then((s: bigint) => setShares(ethers.formatUnits(s, USDG_DECIMALS))).catch(() => {});
  }, [account, read, m.reserve]);

  const deposit = () => run('dep', async () => {
    const amt = ethers.parseUnits(amount || '0', USDG_DECIMALS);
    let tx = await write!.usdg.mint(account, amt); await tx.wait();
    tx = await write!.usdg.approve(ADDRESSES.vault, amt); await tx.wait();
    tx = await write!.vault.deposit(amt); await tx.wait();
    return `Deposited ${amount} USDG · minted LP shares`;
  });
  const withdraw = () => run('wd', async () => {
    const s = await read.vault.sharesOf(account) as bigint;
    const tx = await write!.vault.withdraw(s); await tx.wait();
    return 'Withdrew all free shares';
  });
  const earmark = () => run('em', async () => {
    const c = ethers.parseUnits(cap || '0', USDG_DECIMALS);
    const tx = await write!.vault.earmark(eventId, c, { gasLimit: 500000 }); await tx.wait();
    return `Earmarked ${cap} USDG capacity for the event`;
  });

  const spread = m.reserve - m.capacity; // rough "profit buffer" indicator
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
        <div className="flex items-center gap-2"><span className="neo-badge-green px-2 py-0.5 text-[12.5px]">LP</span><h2 className="font-black text-lg">Underwrite</h2></div>
        <Field label="Deposit amount" value={amount} onChange={setAmount} suffix="USDG" />
        <div className="grid grid-cols-2 gap-2">
          <button className="neo-btn neo-btn-green" onClick={deposit} disabled={st.dep?.kind === 'busy'}>{st.dep?.kind === 'busy' ? '…' : 'DEPOSIT'}</button>
          <button className="neo-btn neo-btn-white" onClick={withdraw} disabled={st.wd?.kind === 'busy'}>WITHDRAW ALL</button>
        </div>
        <StatusLine s={st.dep} /><StatusLine s={st.wd} />
        <hr className="border-t border-slate-900/10" />
        <Field label="Earmark capacity for event" value={cap} onChange={setCap} suffix="USDG" />
        <button className="neo-btn neo-btn-yellow" onClick={earmark} disabled={st.em?.kind === 'busy'}>{st.em?.kind === 'busy' ? '…' : 'EARMARK CAPACITY'}</button>
        <StatusLine s={st.em} />
      </div>

      <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
        <h3 className="font-black text-base">Reserve book</h3>
        <Row k="Total reserve" v={`${m.reserve.toLocaleString()} USDG`} c="#10b981" />
        <Row k="Earmarked (at risk)" v={`${m.earmarked.toLocaleString()} USDG`} />
        <Row k="Free (withdrawable)" v={`${m.freeReserve.toLocaleString()} USDG`} />
        <Row k="Your LP shares" v={Number(shares).toLocaleString()} />
        <Row k="Event capacity" v={`${m.capacity.toLocaleString()} USDG`} />
        <Row k="Paid out" v={`${m.paidOut.toLocaleString()} USDG`} c={m.paidOut > 0 ? '#e11d48' : undefined} />
        <p className="font-mono text-[12.5px] text-slate-600 mt-1">P&amp;L = premiums − payouts · buffer {spread.toLocaleString()} USDG</p>
      </div>
    </div>
  );
}

function Row({ k, v, c }: { k: string; v: string; c?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-gray-200 pb-1.5">
      <span className="font-mono text-[12.5px] uppercase tracking-wide text-slate-600">{k}</span>
      <span className="font-black mono-num" style={c ? { color: c } : undefined}>{v}</span>
    </div>
  );
}
