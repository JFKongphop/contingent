'use client';

import React, { useState } from 'react';
import { useWeb3 } from '../context/Web3Context';

export type Status = { kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string };

export function StatusLine({ s }: { s?: Status }) {
  if (!s || s.kind === 'idle') return null;
  const color = s.kind === 'ok' ? '#00a854' : s.kind === 'err' ? '#FF3366' : '#64748b';
  const icon = s.kind === 'busy' ? '⏳ ' : s.kind === 'ok' ? '✓ ' : '✕ ';
  return <div className="font-mono text-[12px] break-words" style={{ color }}>{icon}{s.msg}</div>;
}

/** Reusable keyed action runner with per-key status + connection guard. */
export function useActions() {
  const { isConnected, wrongNetwork, write, refresh } = useWeb3();
  const [st, setSt] = useState<Record<string, Status>>({});
  const ready = isConnected && !wrongNetwork && !!write;
  async function run(key: string, fn: () => Promise<string>) {
    if (!ready) { setSt((p) => ({ ...p, [key]: { kind: 'err', msg: 'Connect wallet on Arbitrum Sepolia first' } })); return; }
    setSt((p) => ({ ...p, [key]: { kind: 'busy', msg: 'Submitting…' } }));
    try {
      const msg = await fn();
      setSt((p) => ({ ...p, [key]: { kind: 'ok', msg } }));
      refresh();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setSt((p) => ({ ...p, [key]: { kind: 'err', msg: (e as any)?.shortMessage ?? (e as any)?.message ?? 'Failed' } }));
    }
  }
  return { st, run, ready };
}

export function Field({ label, value, onChange, suffix }: { label: string; value: string; onChange: (v: string) => void; suffix?: string }) {
  return (
    <label className="block">
      <div className="font-mono text-[11.5px] uppercase tracking-wider text-slate-600 mb-1">{label}</div>
      <div className="neo-input flex items-center gap-2 px-3 py-2 focus-within:shadow-[3px_3px_0px_0px_#000]">
        <input
          className="flex-1 min-w-0 bg-transparent border-none outline-none p-0 font-mono font-bold text-sm"
          style={{ boxShadow: 'none' }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
        />
        {suffix && <span className="font-mono text-[12px] text-slate-500 shrink-0 uppercase tracking-wide">{suffix}</span>}
      </div>
    </label>
  );
}
