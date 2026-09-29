import React from 'react';
import Link from 'next/link';

const ENGINES = [
  { c: '#6d28d9', k: 'PUBLIC', t: 'Prediction market prices it', d: 'Public odds set the fair premium for every hedge and protection.' },
  { c: '#059669', k: 'PRIVATE', t: 'Fhenix hides it', d: 'Size & side are encrypted; premium computed on ciphertext.' },
  { c: '#0f172a', k: 'SETTLE', t: 'USDG settles it', d: 'Winners paid in USDG from LP capital after one decrypt.' },
];

export default function Landing() {
  return (
    <div className="h-screen overflow-hidden bg-transparent text-slate-900 flex flex-col selection:bg-slate-200 selection:text-slate-900" style={{ fontFamily: 'var(--font-headline)' }}>
      {/* top bar */}
      <header className="w-full border-b border-slate-900/10 bg-white shrink-0">
        <div className="w-full max-w-[1120px] mx-auto px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#0f172a] text-white flex items-center justify-center font-bold" style={{ boxShadow: '0 8px 20px -8px rgba(15,23,42,.5)' }}>C</div>
            <span className="font-black tracking-tight text-lg">CONTINGENT</span>
          </div>
          <div className="flex items-center gap-2">
            <a href="https://sepolia.arbiscan.io/address/0x670b2dC8EEa68Cb6BA2caC4021FCE02b85C51Dcf" target="_blank" rel="noreferrer" className="neo-btn neo-btn-white neo-btn-sm hidden sm:inline-flex">CONTRACTS ↗</a>
            <Link href="/app" className="neo-btn neo-btn-cyan neo-btn-sm">LAUNCH APP →</Link>
          </div>
        </div>
      </header>

      {/* single-screen hero */}
      <main className="flex-1 min-h-0 flex flex-col justify-center">
        <div className="w-full max-w-[1120px] mx-auto px-5 w-full">
          <div className="inline-flex items-center gap-2 mb-4 flex-wrap">
            <span className="font-mono text-[12.5px] uppercase tracking-widest px-3 py-1 rounded-full border border-violet-200 bg-violet-50 text-violet-700">Confidential event derivatives</span>
            <span className="pulse-dot" />
            <span className="font-mono text-[12.5px] uppercase tracking-widest text-slate-700">Live on Arbitrum Sepolia</span>
          </div>

          <h1 className="font-black leading-[0.92] tracking-tight" style={{ fontSize: 'clamp(2.2rem, 6.5vw, 4.4rem)' }}>
            HEDGE ANY EVENT.<br />
            <span className="bg-[#0f172a] text-white px-4 pt-1 pb-3 rounded-2xl inline-block mt-2 leading-none" style={{ boxShadow: '0 20px 40px -18px rgba(15,23,42,.55)' }}>PRIVATELY.</span>
          </h1>

          <p className="mt-5 max-w-[58ch] text-base md:text-lg font-medium text-gray-700 leading-relaxed">
            An event hedge is a <b>binary derivative</b> — pay a premium, get paid if the event fires.
            Contingent prices it with a prediction market, <b>encrypts your position with Fhenix</b>, and
            settles in USDG. Your hand stays hidden; the odds stay public.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link href="/app" className="neo-btn neo-btn-cyan neo-btn-lg text-base">LAUNCH APP →</Link>
            <span className="font-mono text-[12px] text-slate-600">Live event · <b className="text-black">ETH ≥ $2,500</b></span>
          </div>

          {/* three engines — compact row */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {ENGINES.map((x) => (
              <div key={x.t} className="neo-card-sm bg-white p-3 flex flex-col gap-1">
                <span className="font-mono text-[12px] font-bold px-1.5 py-0.5 self-start rounded-full border" style={{ color: x.c, background: x.c + '12', borderColor: x.c + '40' }}>{x.k}</span>
                <h3 className="font-black text-base mt-0.5">{x.t}</h3>
                <p className="font-mono text-[12.5px] text-slate-700 leading-snug">{x.d}</p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
