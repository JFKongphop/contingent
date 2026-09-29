'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '../context/Web3Context';
import { useActions, StatusLine, Field } from './ui';
import { EthChart } from './EthChart';
import { encryptUint64, encryptBool, encryptHedge, decryptForTx, decryptForView, decryptBoolForView } from '../lib/cofhe';
import { useMarket } from '../lib/useMarket';
import { ADDRESSES, USDG_DECIMALS, FEED_DECIMALS, PERP, EVENT_LABEL, STRIKE_USD, BPS } from '../config/contracts';

const LEVERAGES = [1, 2, 3, 5, 10];
// fields stored only as ciphertext — shown as redaction bars (width varies so it reads like a censored document)
const REDACTED: [string, number][] = [
  ['Collateral', 44], ['Position size', 52], ['Long / short', 30],
  ['Liq. price', 48], ['Protection side', 26], ['Cover', 40],
];
const usd = (v: number, d = 0) => '$' + v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const u6 = (v: bigint) => Number(ethers.formatUnits(v, USDG_DECIMALS));

// position inputs are encrypted on-chain; we keep the trader's own copy locally for the PnL estimate
type LocalRec = { c: number; long: boolean; protect?: { n: number; hedgeId: number } };
const recKey = (acct: string, id: number) => `contingent:perp:${acct.toLowerCase()}:${id}`;
function saveRec(acct: string, id: number, r: LocalRec) { try { localStorage.setItem(recKey(acct, id), JSON.stringify(r)); } catch { /* ignore */ } }
function loadRec(acct: string, id: number): LocalRec | null { try { const s = localStorage.getItem(recKey(acct, id)); return s ? JSON.parse(s) : null; } catch { return null; } }

// ── protection math (long perp + NO on "ETH ≥ strike") ──
const MAX_PROFIT = PERP.MAX_PROFIT_MULT;
function perpPnlAt(price: number, entry: number, c: number, lev: number, long: boolean) {
  const liq = long ? entry * (1 - 0.95 / lev) : entry * (1 + 0.95 / lev);
  if (long ? price <= liq : price >= liq) return -c; // liquidated: collateral lost
  const raw = c * lev * ((price - entry) / entry) * (long ? 1 : -1);
  return Math.max(-c, Math.min(raw, c * MAX_PROFIT));
}
function hedgePnlAt(price: number, n: number, premium: number, yes = false) {
  const pays = yes ? price >= STRIKE_USD : price < STRIKE_USD; // NO pays below the strike, YES at/above
  return (pays ? n : 0) - premium;
}

// hedgeId: the linked protection — from the on-chain ProtectedPerp link, or a locally recorded PROTECT
interface Row { id: number; leverage: number; entry: number; status: number; rec: LocalRec | null; hedgeId: number }

export function PerpTerminal() {
  const { read, write, provider, signer, account, blockNumber, eventId } = useWeb3();
  const { st, run } = useActions();
  const m = useMarket();
  const [protectOpen, setProtectOpen] = useState<number | null>(null);
  const [protectN, setProtectN] = useState('100');
  const [protectOn, setProtectOn] = useState(true); // one-button protected position
  const [cover, setCover] = useState('100');
  // encrypted free collateral: the on-chain handle (what everyone sees) + your private decryption
  const [colHandle, setColHandle] = useState<string>('');
  const [colSeen, setColSeen] = useState<{ h: string; v: number } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [autoReveal, setAutoReveal] = useState(false);
  // positions are masked until the owner reveals them — values are decrypted from the chain, not local storage
  const [shown, setShown] = useState<Record<number, { c: number; long: boolean; cover?: number }>>({});
  const [revealingRow, setRevealingRow] = useState<number | null>(null);

  const [isLong, setIsLong] = useState(true);
  const [coll, setColl] = useState('100');
  const [lev, setLev] = useState(5);
  const [fund, setFund] = useState('500');
  const [deposit, setDeposit] = useState('200');
  const [liqId, setLiqId] = useState('1');

  const [mark, setMark] = useState(0);
  const [house, setHouse] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    try {
      const [mp, hl, oc] = await Promise.all([read.perp.markPrice(), read.perp.houseLiquidity(), read.perp.openCount()]);
      setMark(Number(ethers.formatUnits(mp, FEED_DECIMALS)));
      setHouse(u6(hl));
      setOpenCount(Number(oc));
    } catch { /* ignore */ }
    if (!account) { setRows([]); return; }
    try {
      const ids: bigint[] = await read.perp.positionsOf(account);
      const out: Row[] = [];
      for (const bid of ids) {
        const id = Number(bid);
        const p = await read.perp.getPosition(id);
        const status = Number(p.status);
        if (status === 5) continue; // closed
        const rec = loadRec(account, id);
        const linked = Number(await read.protectedPerp.protectionOf(id).catch(() => BigInt(0)));
        out.push({ id, leverage: Number(p.leverage), entry: Number(ethers.formatUnits(p.entryPrice, FEED_DECIMALS)), status, rec, hedgeId: rec?.protect?.hedgeId || linked });
      }
      setRows(out.reverse());
    } catch { /* ignore */ }
  }, [read, account]);

  useEffect(() => { load(); }, [load, blockNumber]);

  const ZERO_H = '0x' + '0'.repeat(64);
  const reveal = useCallback(async (h: string) => {
    if (!provider || !signer) return;
    setRevealing(true);
    try {
      const v = h === ZERO_H ? 0 : u6(await decryptForView(provider, signer, h));
      setColSeen({ h, v });
      setAutoReveal(true); // keep it fresh after deposits / opens (ACP is cached, no new signature)
    } catch { /* user rejected the signature or CoFHE unavailable */ }
    setRevealing(false);
  }, [provider, signer, ZERO_H]);

  useEffect(() => {
    if (!write || !account) return;
    let live = true;
    write.collateral.myCollateral().then((h: string) => {
      if (!live) return;
      setColHandle(h);
      if (autoReveal && colSeen?.h !== h) reveal(h);
    }).catch(() => { /* ignore */ });
    return () => { live = false; };
  }, [write, account, blockNumber, autoReveal, colSeen?.h, reveal]);

  // ── open-position preview ──
  const c = Number(coll) || 0;
  const size = c * lev;
  const liqPrice = mark ? (isLong ? mark * (1 - 0.95 / lev) : mark * (1 + 0.95 / lev)) : 0;
  const maxProfit = c * PERP.MAX_PROFIT_MULT;
  // protection leg: a long buys NO, a short buys YES (picked on the ciphertext by ProtectedPerp)
  const cv = Number(cover) || 0;
  const coverOdds = isLong ? (BPS - m.probYesBps) / BPS : m.probYesBps / BPS;
  const coverPremium = cv * coverOdds;
  const canProtect = m.open;
  const willProtect = protectOn && canProtect && cv > 0;
  const needed = c + (willProtect ? coverPremium : 0);
  const freeCol = colSeen && colSeen.h === colHandle ? colSeen.v : null;

  // ── actions ──
  const fundWrap = () => run('fund', async () => {
    const amt = ethers.parseUnits(fund || '0', USDG_DECIMALS);
    let tx = await write!.usdg.mint(account, amt); await tx.wait();
    tx = await write!.usdg.approve(ADDRESSES.cusdg, amt); await tx.wait();
    tx = await write!.cusdg.wrap(amt); await tx.wait();
    return `Wrapped ${fund} USDG → cUSDG`;
  });

  const depositCollateral = () => run('dep', async () => {
    const amt = ethers.parseUnits(deposit || '0', USDG_DECIMALS);
    const { handle, proof } = await encryptUint64(provider!, signer!, amt, ADDRESSES.cusdg);
    const tx = await write!.cusdg.confidentialTransferAndCall(ADDRESSES.collateral, handle, proof, '0x');
    await tx.wait();
    return `Deposited ${deposit} cUSDG as encrypted collateral`;
  });

  const open = () => run('open', async () => {
    const amt = ethers.parseUnits(coll || '0', USDG_DECIMALS);
    const side = isLong ? 'LONG' : 'SHORT';
    let id = 0, hedgeId = 0;

    if (willProtect) {
      // one transaction: perp + opposite-side event hedge, all three inputs encrypted for ProtectedPerp
      const to = ADDRESSES.protectedPerp;
      const ec = await encryptUint64(provider!, signer!, amt, to);
      const ed = await encryptBool(provider!, signer!, isLong, to);
      const ev = await encryptUint64(provider!, signer!, ethers.parseUnits(cover || '0', USDG_DECIMALS), to);
      const tx = await write!.protectedPerp.openProtected(ec.handle, ec.proof, ed.handle, ed.proof, lev, ev.handle, ev.proof);
      const rc = await tx.wait();
      for (const log of rc.logs) {
        try {
          const e = write!.protectedPerp.interface.parseLog(log);
          if (e?.name === 'ProtectedOpened') { id = Number(e.args.perpId); hedgeId = Number(e.args.hedgeId); }
        } catch { /* not ours */ }
      }
    } else {
      const ec = await encryptUint64(provider!, signer!, amt, ADDRESSES.perp);
      const ed = await encryptBool(provider!, signer!, isLong, ADDRESSES.perp);
      const tx = await write!.perp.openPosition(ec.handle, ec.proof, ed.handle, ed.proof, lev);
      const rc = await tx.wait();
      for (const log of rc.logs) {
        try { const e = write!.perp.interface.parseLog(log); if (e?.name === 'PositionOpened') id = Number(e.args.id); } catch { /* not ours */ }
      }
    }

    // amounts are clamped on-chain (free collateral, pool / vault capacity) — read back what was actually locked
    let actual = c, covered = cv, note = '';
    if (id) {
      try {
        const p = await write!.perp.getPosition(id);
        actual = u6(await decryptForView(provider!, signer!, p.collateral));
        if (actual < c) note += ` · ⚠ only ${actual.toLocaleString()} USDG locked`;
        if (hedgeId) {
          const hp = await write!.positions.get(hedgeId);
          covered = u6(await decryptForView(provider!, signer!, hp.size));
          if (covered < cv) note += ` · ⚠ only ${covered.toLocaleString()} covered`;
        }
      } catch { /* keep typed amounts if the private view-decrypt is unavailable */ }
    }
    if (id && account) saveRec(account, id, hedgeId ? { c: actual, long: isLong, protect: { n: covered, hedgeId } } : { c: actual, long: isLong });
    load();
    return hedgeId
      ? `Opened PROTECTED ${side} ${lev}x · perp #${id} + protection #${hedgeId} in one tx · side encrypted${note}`
      : `Opened ${side} ${lev}x · #${id} · size & side encrypted${note}`;
  });

  // close the perp, then its linked protection hedge (refunds the premium while the event is still open)
  const close = (r: Row) => run(`c${r.id}`, async () => {
    const id = r.id;
    let p = await write!.perp.getPosition(id);
    if (Number(p.status) === 1) {
      const tx = await write!.perp.requestClose(id); await tx.wait();
      p = await write!.perp.getPosition(id);
    }
    const pay = await decryptForTx(provider!, signer!, p.payout);
    const col = await decryptForTx(provider!, signer!, p.collateral);
    const tx = await write!.perp.fulfillClose(id, pay.value, pay.signature, col.value, col.signature);
    await tx.wait();
    let msg = `Closed #${id} · paid ${u6(pay.value).toLocaleString()} USDG`;

    const hid = r.hedgeId;
    if (hid) {
      if (!m.open) {
        msg += ` · protection #${hid} stays open (event resolved) — settle it on SETTLE`;
      } else {
        try {
          const tx2 = await write!.hedge.closeHedge(hid); await tx2.wait();
          msg += ` · protection #${hid} closed, premium refunded`;
          if (account && r.rec) saveRec(account, id, { c: r.rec.c, long: r.rec.long });
        } catch (e) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          msg += ` · ⚠ protection #${hid} still open — close it on HEDGE (${(e as any)?.shortMessage ?? 'failed'})`;
        }
      }
    }
    load();
    return msg;
  });

  const liquidate = () => run('liq', async () => {
    const id = Number(liqId);
    let p = await write!.perp.getPosition(id);
    if (Number(p.status) === 1) {
      const tx = await write!.perp.requestLiquidationCheck(id); await tx.wait();
      p = await write!.perp.getPosition(id);
    }
    if (Number(p.status) === 3) {
      const flag = await decryptForTx(provider!, signer!, p.liquidatable);
      const tx = await write!.perp.resolveLiquidationCheck(id, flag.value === 1n, flag.signature); await tx.wait();
      if (flag.value !== 1n) { load(); return `#${id} is healthy — only 1 bit revealed`; }
      p = await write!.perp.getPosition(id);
    }
    if (Number(p.status) === 4) {
      const col = await decryptForTx(provider!, signer!, p.collateral);
      const tx = await write!.perp.finalizeLiquidation(id, col.value, col.signature); await tx.wait();
      load();
      return `Liquidated #${id} · keeper bonus ${(u6(col.value) * 0.01).toLocaleString()} USDG`;
    }
    return `#${id} is not open`;
  });

  // buy NO on the event market, sized by the user, and link it to this perp position (locally)
  const protect = (r: Row) => run(`p${r.id}`, async () => {
    const n = Number(protectN) || 0;
    if (n <= 0) throw new Error('Enter a protection amount');
    const enc = await encryptHedge(provider!, signer!, ethers.parseUnits(String(n), USDG_DECIMALS), false);
    const tx = await write!.hedge.openHedge(eventId, enc.encSize, enc.sizeProof, enc.encIsYes, enc.dirProof);
    const rc = await tx.wait();
    let hedgeId = 0;
    for (const log of rc.logs) {
      try { const ev = write!.hedge.interface.parseLog(log); if (ev?.name === 'HedgeOpened') hedgeId = Number(ev.args.positionId); } catch { /* not ours */ }
    }
    // cover is scaled to the premium you could actually pay — read back the accepted size privately
    let cover = n, note = '';
    if (hedgeId) {
      try {
        const hp = await write!.positions.get(hedgeId);
        cover = u6(await decryptForView(provider!, signer!, hp.size));
        if (cover < n) note = ` · ⚠ only ${cover.toLocaleString()} covered (free collateral / vault cap)`;
      } catch { /* keep requested amount */ }
    }
    if (account && r.rec) saveRec(account, r.id, { ...r.rec, protect: { n: cover, hedgeId } });
    setProtectOpen(null);
    load();
    return `Protected #${r.id} · NO hedge #${hedgeId} (${cover.toLocaleString()} USDG) · encrypted${note}`;
  });

  const estPnl = (r: Row) => {
    const v = shown[r.id];
    if (!v || !mark) return null;
    const raw = v.c * r.leverage * ((mark - r.entry) / r.entry) * (v.long ? 1 : -1);
    return Math.max(-v.c, Math.min(raw, v.c * PERP.MAX_PROFIT_MULT));
  };

  const revealRow = async (r: Row) => {
    if (!provider || !signer) return;
    setRevealingRow(r.id);
    try {
      const p = await read.perp.getPosition(r.id);
      const [c, long] = await Promise.all([
        decryptForView(provider, signer, p.collateral).then(u6),
        decryptBoolForView(provider, signer, p.isLong),
      ]);
      let cover: number | undefined;
      if (r.hedgeId) cover = u6(await decryptForView(provider, signer, (await read.positions.get(r.hedgeId)).size));
      setShown((x) => ({ ...x, [r.id]: { c, long, cover } }));
      if (account) saveRec(account, r.id, { c, long, ...(r.hedgeId ? { protect: { n: cover ?? 0, hedgeId: r.hedgeId } } : {}) });
    } catch { /* signature rejected or CoFHE unavailable — stay masked */ }
    setRevealingRow(null);
  };
  const hideRow = (id: number) => setShown((x) => { const n = { ...x }; delete n[id]; return n; });

  const stats = useMemo(() => [
    { k: 'Mark price', v: mark ? usd(mark, 2) : '—', s: 'Chainlink ETH/USD' },
    { k: 'House liquidity', v: house.toLocaleString(), s: 'USDG · counterparty' },
    { k: 'Open positions', v: String(openCount), s: 'size & side hidden' },
    { k: 'Max leverage', v: `${PERP.MAX_LEVERAGE}x`, s: `profit cap ${PERP.MAX_PROFIT_MULT}x` },
  ], [mark, house, openCount]);

  return (
    <div className="flex flex-col gap-3">
      <div className="neo-card bg-white p-3">
        <div className="flex gap-2 flex-wrap">
          {stats.map((x) => (
            <div key={x.k} className="neo-card-sm px-3 py-2 min-w-[130px] flex-1 bg-white">
              <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600">{x.k}</div>
              <div className="font-black text-lg mono-num leading-tight">{x.v}</div>
              <div className="font-mono text-[12px] text-slate-600">{x.s}</div>
            </div>
          ))}
        </div>
      </div>

      <EthChart showStrike={false} title="ETH-PERP · Chainlink" />

      <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-3">
        {/* open position */}
        <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="neo-badge-cyan px-2 py-0.5 text-[12.5px]">PERPS</span>
            <h2 className="font-black text-lg">Open an encrypted position</h2>
          </div>

          <div>
            <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600 mb-1">Direction (hidden on-chain)</div>
            <div className="grid grid-cols-2 gap-2">
              <button className="neo-btn" onClick={() => setIsLong(true)}
                style={isLong ? { background: '#ecfdf5', color: '#047857', borderColor: '#10b981', boxShadow: '0 0 0 3px rgba(16,185,129,.15)' } : { background: '#fff' }}>
                LONG ↑
              </button>
              <button className="neo-btn" onClick={() => setIsLong(false)}
                style={!isLong ? { background: '#fff1f2', color: '#be123c', borderColor: '#f43f5e', boxShadow: '0 0 0 3px rgba(244,63,94,.15)' } : { background: '#fff' }}>
                SHORT ↓
              </button>
            </div>
          </div>

          <Field label="Collateral (hidden on-chain)" value={coll} onChange={setColl} suffix="USDG" />

          <div>
            <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600 mb-1">Leverage</div>
            <div className="grid grid-cols-5 gap-2">
              {LEVERAGES.map((l) => (
                <button key={l} className="neo-btn neo-btn-sm" onClick={() => setLev(l)}
                  style={lev === l ? { background: '#0f172a', color: '#fff', borderColor: '#0f172a' } : { background: '#fff' }}>
                  {l}x
                </button>
              ))}
            </div>
          </div>

          <div className="neo-card-sm bg-slate-50 p-3 grid grid-cols-2 gap-y-2 gap-x-4">
            <Read k="Position size" v={`${size.toLocaleString()} USDG`} />
            <Read k="Entry ≈ mark" v={mark ? usd(mark, 2) : '—'} />
            <Read k="Liquidation ≈" v={liqPrice ? usd(liqPrice, 2) : '—'} c="#e11d48" />
            <Read k="Max profit" v={`${maxProfit.toLocaleString()} USDG`} c="#059669" />
          </div>

          <div className="neo-card-sm p-3 flex flex-col gap-2 flex-1" style={{ background: willProtect ? '#f5f3ff' : '#f8fafc', borderColor: willProtect ? '#ddd6fe' : undefined }}>
            <label className="flex items-center gap-2 cursor-pointer font-black text-sm">
              <input type="checkbox" className="w-4 h-4 accent-black" checked={protectOn && canProtect} disabled={!canProtect}
                onChange={(e) => setProtectOn(e.target.checked)} />
              🛡 Protect with the event market
              <span className="font-mono text-[12px] font-normal text-slate-600">· same transaction</span>
            </label>
            {!canProtect && <div className="font-mono text-[12.5px] text-slate-600">Event market is closed — protection unavailable.</div>}
            {protectOn && canProtect && (
              <>
                <div className="font-mono text-[12.5px] text-slate-700">
                  Buys <b>{isLong ? 'NO' : 'YES'}</b> on “{EVENT_LABEL}” — pays your cover if ETH ends {isLong ? 'below' : 'at or above'} {usd(STRIKE_USD)}.
                  The side is picked on the ciphertext, so your direction stays hidden.
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-3 items-end mt-auto">
                  <Field label="Cover (paid if it hits)" value={cover} onChange={setCover} suffix="USDG" />
                  <div className="neo-card-sm bg-white px-3 py-2">
                    <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600">Premium @ {isLong ? 'NO' : 'YES'} {(coverOdds * 100).toFixed(1)}%</div>
                    <div className="font-black mono-num">{coverPremium.toFixed(2)} USDG</div>
                  </div>
                </div>
                <div className="font-mono text-[12.5px]">
                  Liquidated &amp; ETH {isLong ? 'below' : 'above'} strike:{' '}
                  <b style={{ color: '#e11d48' }}>−{c.toFixed(0)}</b> alone →{' '}
                  <b style={{ color: cv - coverPremium - c >= 0 ? '#059669' : '#e11d48' }}>
                    {cv - coverPremium - c >= 0 ? '+' : '−'}{Math.abs(cv - coverPremium - c).toFixed(1)}
                  </b> protected
                </div>
              </>
            )}
          </div>

          {freeCol !== null && freeCol < needed && (
            <div className="font-mono text-[12.5px] font-bold" style={{ color: '#e11d48' }}>
              ⚠ Free collateral {freeCol.toLocaleString()} USDG &lt; needed {needed.toFixed(2)} ({c} collateral{willProtect ? ` + ${coverPremium.toFixed(2)} premium` : ''}) — DEPOSIT more or it will be clamped.
            </div>
          )}
          <button className="neo-btn neo-btn-lg" onClick={open} disabled={st.open?.kind === 'busy'}
            style={{ background: isLong ? '#059669' : '#e11d48', borderColor: isLong ? '#059669' : '#e11d48', color: '#fff', boxShadow: '0 12px 28px -12px rgba(15,23,42,.45)' }}>
            {st.open?.kind === 'busy' ? 'ENCRYPTING & OPENING…' : `${willProtect ? '🛡' : '🔒'} OPEN ${willProtect ? 'PROTECTED ' : ''}${isLong ? 'LONG' : 'SHORT'} ${lev}x`}
          </button>
          <StatusLine s={st.open} />
        </div>

        {/* prepare collateral (shared with HEDGE) */}
        <div className="neo-card bg-white p-3.5 flex flex-col gap-3">
          <h3 className="font-black text-base">Prepare collateral <span className="font-mono text-[12px] text-slate-500 font-normal">· one-time · shared with HEDGE</span></h3>
          <div className="flex flex-col gap-2">
            <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600">1 · Fund &amp; wrap</div>
            <div className="flex items-center gap-2">
              <input className="neo-input px-3 py-2 w-full text-sm" value={fund} onChange={(e) => setFund(e.target.value)} inputMode="decimal" />
              <button className="neo-btn neo-btn-green neo-btn-sm shrink-0 self-stretch w-[120px]" onClick={fundWrap} disabled={st.fund?.kind === 'busy'}>
                {st.fund?.kind === 'busy' ? '…' : 'MINT + WRAP'}
              </button>
            </div>
            <StatusLine s={st.fund} />
          </div>
          <div className="flex flex-col gap-2">
            <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600">2 · Deposit encrypted collateral</div>
            <div className="flex items-center gap-2">
              <input className="neo-input px-3 py-2 w-full text-sm" value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
              <button className="neo-btn neo-btn-green neo-btn-sm shrink-0 self-stretch w-[120px]" onClick={depositCollateral} disabled={st.dep?.kind === 'busy'}>
                {st.dep?.kind === 'busy' ? '…' : 'DEPOSIT'}
              </button>
            </div>
            <StatusLine s={st.dep} />
          </div>

          {/* privacy made visible: same balance, two viewers */}
          <div className="flex flex-col gap-2">
            <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600">3 · Your encrypted collateral</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="neo-card-sm bg-[#ecfdf5] p-3 flex flex-col gap-1">
                <div className="font-mono text-[12px] uppercase tracking-wider text-slate-700">👁 You (decrypted)</div>
                {freeCol !== null ? (
                  <>
                    <div className="font-black mono-num text-xl leading-tight">{freeCol.toLocaleString()}</div>
                    <div className="font-mono text-[12px] text-slate-700">USDG free to trade</div>
                  </>
                ) : (
                  <button className="neo-btn neo-btn-white neo-btn-sm mt-1" onClick={() => reveal(colHandle)} disabled={!account || !colHandle || revealing}>
                    {!account ? 'CONNECT TO REVEAL' : revealing ? 'DECRYPTING…' : '👁 REVEAL'}
                  </button>
                )}
              </div>
              <div className="neo-card-sm bg-[#0f172a] text-white p-3 flex flex-col gap-1">
                <div className="font-mono text-[12px] uppercase tracking-wider text-slate-500">🌐 Everyone else</div>
                <div className="font-mono text-sm break-all leading-tight" style={{ color: '#a5f3fc' }}>
                  {colHandle && colHandle !== ZERO_H ? `${colHandle.slice(0, 10)}…${colHandle.slice(-6)}` : '0x••••••••…••••••'}
                </div>
                <div className="font-mono text-[12px] text-slate-500">ciphertext handle only</div>
              </div>
            </div>
            <p className="font-mono text-[12px] text-slate-500">
              Decrypted in your browser with a signed permit — the plaintext never goes on-chain.
            </p>
            <div className="neo-card-sm bg-white px-3 pt-2 pb-1 mt-1">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[12px] uppercase tracking-wider text-slate-600">What the chain sees</span>
                <span className="neo-badge-yellow px-2 py-0.5 text-[12px]">REDACTED</span>
              </div>
              <div className="grid grid-cols-2 gap-x-5">
                {REDACTED.map(([label, w]) => (
                  <div key={label} className="flex items-center justify-between gap-2 py-1.5 border-t border-dashed border-gray-300">
                    <span className="font-mono text-[12.5px] text-gray-700 whitespace-nowrap">{label}</span>
                    <span className="h-3 bg-black rounded-[2px] shrink-0" style={{ width: w }} aria-label="hidden" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* keeper: liquidation — sits in the spare space under the collateral steps */}
          <div className="mt-auto pt-3 border-t border-dashed border-gray-300 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="neo-badge-yellow px-2 py-0.5 text-[12.5px]">KEEPER</span>
              <h3 className="font-black text-base">Liquidation check</h3>
            </div>
            <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600">Position id</div>
            <div className="flex items-center gap-2">
              <input className="neo-input px-3 py-2 w-full text-sm" value={liqId} onChange={(e) => setLiqId(e.target.value)} inputMode="numeric" />
              <button className="neo-btn neo-btn-yellow neo-btn-sm shrink-0 self-stretch w-[120px]" onClick={liquidate} disabled={st.liq?.kind === 'busy'}>
                {st.liq?.kind === 'busy' ? 'CHECKING…' : 'CHECK & LIQ.'}
              </button>
            </div>
            <StatusLine s={st.liq} />
            <p className="font-mono text-[12.5px] text-slate-600 leading-relaxed">
              Computes margin on the ciphertext and reveals <b>one bit</b> (below 5% maintenance or not) — nobody can
              see your size, side or liquidation level, so stop-hunting is impossible. Keeper earns 1% of collateral.
            </p>
          </div>
        </div>
      </div>

      {/* your positions */}
      {account && (
        <div className="neo-card bg-white p-3.5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-black text-lg">Your positions</h2>
            <button className="neo-btn neo-btn-white neo-btn-sm" onClick={load}>REFRESH</button>
          </div>
          {/* a closed position leaves the list — keep its close result visible here */}
          {Object.keys(st).filter((k) => /^c\d+$/.test(k) && !rows.some((r) => `c${r.id}` === k)).map((k) => (
            <StatusLine key={k} s={st[k]} />
          ))}
          {rows.length === 0 ? (
            <div className="font-mono text-[12px] text-slate-600 py-6 text-center">No open positions. Open one above — size &amp; side stay encrypted.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((r) => {
                const pnl = estPnl(r);
                const v = shown[r.id];
                const mask = <span className="inline-block h-2.5 w-8 bg-black rounded-[2px] align-middle" aria-label="hidden" />;
                return (
                  <div key={r.id} className="neo-card-sm bg-slate-50 p-3 flex flex-wrap items-center gap-3 justify-between">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="font-black mono-num text-lg">#{r.id}</span>
                      <span className="neo-pill px-2 py-0.5 text-[12.5px] bg-white inline-flex items-center gap-1.5">
                        {v ? <b style={{ color: v.long ? '#059669' : '#e11d48' }}>{v.long ? 'LONG' : 'SHORT'}</b> : mask}
                        <span>{r.leverage}x ·</span>
                        {v ? <span>{v.c.toLocaleString()} USDG</span> : mask}
                      </span>
                      <span className="font-mono text-[12.5px] text-slate-700">entry {usd(r.entry, 2)}</span>
                      <span className="font-black mono-num text-sm inline-flex items-center gap-1.5" style={{ color: pnl === null ? '#111' : pnl >= 0 ? '#059669' : '#e11d48' }}>
                        est. PnL {pnl === null ? mask : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`}
                      </span>
                      <button className="neo-btn neo-btn-white neo-btn-sm" onClick={() => (v ? hideRow(r.id) : revealRow(r))} disabled={revealingRow === r.id}>
                        {revealingRow === r.id ? 'DECRYPTING…' : v ? '🙈 HIDE' : '👁 REVEAL'}
                      </button>
                      {r.status !== 1 && <span className="neo-badge-yellow px-2 py-0.5 text-[12.5px]">{PERP.STATUS[r.status]}</span>}
                      {r.hedgeId > 0 && (
                        <span className="neo-badge-cyan px-2 py-0.5 text-[12.5px] inline-flex items-center gap-1.5">
                          🛡 PROTECTED · {v ? `${v.long ? 'NO' : 'YES'} ${(v.cover ?? 0).toLocaleString()}` : mask} · #{r.hedgeId}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {r.status === 1 && !r.hedgeId && (
                        <button
                          className="neo-btn neo-btn-sm w-[120px]"
                          style={{ background: '#0f172a', color: '#fff', borderColor: '#0f172a' }}
                          onClick={() => { setProtectOpen(protectOpen === r.id ? null : r.id); setProtectN(String(r.rec?.c ?? 100)); }}
                          disabled={!r.rec || !r.rec.long || !m.open}
                          title={!r.rec ? 'Open this position from this browser to protect it' : !r.rec.long ? 'Shorts need an “ETH goes up” event market — not listed yet' : !m.open ? 'Event market is closed' : 'Buy event protection'}
                        >
                          🛡 PROTECT
                        </button>
                      )}
                      <button className="neo-btn neo-btn-white neo-btn-sm w-[120px]" onClick={() => close(r)} disabled={st[`c${r.id}`]?.kind === 'busy' || r.status === 3 || r.status === 4}
                        title={r.hedgeId ? 'Closes the perp and its protection hedge' : undefined}>
                        {st[`c${r.id}`]?.kind === 'busy' ? 'CLOSING…' : r.status === 2 ? 'FINISH CLOSE' : r.hedgeId ? 'CLOSE BOTH' : 'CLOSE'}
                      </button>
                    </div>
                    <div className="w-full"><StatusLine s={st[`c${r.id}`]} /><StatusLine s={st[`p${r.id}`]} /></div>
                    {protectOpen === r.id && r.rec && (
                      <ProtectPanel
                        entry={r.entry} lev={r.leverage} c={r.rec.c} mark={mark}
                        probYesBps={m.probYesBps} n={protectN} setN={setProtectN}
                        busy={st[`p${r.id}`]?.kind === 'busy'} onBuy={() => protect(r)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="font-mono text-[12px] text-slate-500 mt-2">Masked by default. 👁 REVEAL decrypts this position from the chain in your browser (only you are allowed to) — everyone else sees ciphertext.</p>
        </div>
      )}

    </div>
  );
}

function ProtectPanel({ entry, lev, c, mark, probYesBps, n, setN, busy, onBuy }: {
  entry: number; lev: number; c: number; mark: number; probYesBps: number;
  n: string; setN: (v: string) => void; busy: boolean; onBuy: () => void;
}) {
  const notional = Number(n) || 0;
  const noOdds = (BPS - probYesBps) / BPS;
  const premium = notional * noOdds;
  const liq = entry * (1 - 0.95 / lev);
  const px = mark || entry;
  const scenarios = [
    { name: 'ETH +8%', price: px * 1.08 },
    { name: `Crash to ${usd(STRIKE_USD * 0.92)}`, price: STRIKE_USD * 0.92 },
    { name: 'Liquidated', price: liq * 0.97 },
  ];
  const fmt = (v: number) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);
  const col = (v: number) => ({ color: v >= 0 ? '#059669' : '#e11d48' });

  return (
    <div className="w-full neo-card-sm bg-white p-3 flex flex-col gap-3 mt-1">
      <div>
        <div className="font-black text-sm">🛡 Protect with the event market</div>
        <div className="font-mono text-[12.5px] text-slate-700">
          Buy <b>NO</b> on “{EVENT_LABEL}” — pays your protection amount if ETH ends below {usd(STRIKE_USD)}. Encrypted, like your perp.
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
        <Field label="Protection amount (payout if ETH < strike)" value={n} onChange={setN} suffix="USDG" />
        <div className="neo-card-sm bg-slate-50 px-3 py-2">
          <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600">Premium @ NO {(noOdds * 100).toFixed(1)}%</div>
          <div className="font-black mono-num">{premium.toFixed(2)} USDG</div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[12px]">
          <thead>
            <tr className="text-slate-600 text-[12px] uppercase tracking-wider">
              <th className="text-left py-1">Scenario</th><th className="text-right">ETH</th>
              <th className="text-right">Perp alone</th><th className="text-right">Hedged</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => {
              const alone = perpPnlAt(s.price, entry, c, lev, true);
              const hedged = alone + hedgePnlAt(s.price, notional, premium);
              return (
                <tr key={s.name} className="border-t border-dashed border-gray-200">
                  <td className="py-1.5 font-bold">{s.name}</td>
                  <td className="text-right">{usd(s.price)}</td>
                  <td className="text-right font-black" style={col(alone)}>{fmt(alone)}</td>
                  <td className="text-right font-black" style={col(hedged)}>{fmt(hedged)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <button className="neo-btn neo-btn-lg" onClick={onBuy} disabled={busy || notional <= 0}
        style={{ background: '#0f172a', color: '#fff', borderColor: '#0f172a' }}>
        {busy ? 'ENCRYPTING & BUYING…' : `🛡 BUY PROTECTION · NO ${notional || 0} USDG`}
      </button>
      <p className="font-mono text-[12px] text-slate-500">
        The event resolves once (keeper), so a crash-and-recover can liquidate the perp while NO still loses; and the
        payout is fixed — it covers the move to {usd(STRIKE_USD)}, not the whole tail. Premium comes from your encrypted collateral.
      </p>
    </div>
  );
}

function Read({ k, v, c }: { k: string; v: string; c?: string }) {
  return (
    <div>
      <div className="font-mono text-[12px] uppercase tracking-wider text-slate-600">{k}</div>
      <div className="font-black mono-num" style={c ? { color: c } : undefined}>{v}</div>
    </div>
  );
}
