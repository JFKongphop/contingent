import React from 'react';
import Link from 'next/link';

const ENGINES = [
  { c: '#9333ea', k: 'PUBLIC', t: 'v4 prices it', d: 'A prediction market whose odds are the fair premium.' },
  { c: '#00F076', k: 'PRIVATE', t: 'Fhenix hides it', d: 'Size & side are encrypted; premium computed on ciphertext.' },
  { c: '#00E5FF', k: 'SETTLE', t: '1inch moves it', d: 'Winners paid from LP capital in USDG after one decrypt.' },
];

export default function Landing() {
  return (
    <div className="h-screen overflow-hidden bg-[#f4f4f4] text-[#1b1b1b] flex flex-col selection:bg-[#FFE600] selection:text-black" style={{ fontFamily: 'var(--font-headline)' }}>
      {/* top bar */}
      <header className="w-full border-b-2 border-black bg-white shrink-0">
        <div className="w-full max-w-[1120px] mx-auto px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-[#00E5FF] border-2 border-black flex items-center justify-center font-black" style={{ boxShadow: '3px 3px 0 #000' }}>C</div>
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
            <span className="font-mono text-[12px] uppercase tracking-widest px-2 py-1 border-2 border-black bg-[#9333ea] text-white" style={{ boxShadow: '2px 2px 0 #000' }}>Confidential event derivatives</span>
            <span className="pulse-dot" />
            <span className="font-mono text-[12px] uppercase tracking-widest text-slate-700">Live on Arbitrum Sepolia</span>
          </div>

          <h1 className="font-black leading-[0.92] tracking-tight" style={{ fontSize: 'clamp(2.2rem, 6.5vw, 4.4rem)' }}>
            HEDGE ANY EVENT.<br />
            <span className="bg-[#00E5FF] px-2 border-2 border-black inline-block mt-2" style={{ boxShadow: '5px 5px 0 #000' }}>PRIVATELY.</span>
          </h1>

          <p className="mt-5 max-w-[58ch] text-base md:text-lg font-medium text-gray-700 leading-relaxed">
            An event hedge is a <b>binary derivative</b> — pay a premium, get paid if the event fires.
            Contingent prices it with a prediction market, <b>encrypts your position with Fhenix</b>, and
            settles in USDG. Your hand stays hidden; the odds stay public.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link href="/app" className="neo-btn neo-btn-cyan neo-btn-lg text-base">LAUNCH APP →</Link>
            <span className="font-mono text-[11.5px] text-slate-600">Live event · <b className="text-black">ETH ≥ $2,500</b></span>
          </div>

          {/* three engines — compact row */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {ENGINES.map((x) => (
              <div key={x.t} className="neo-card-sm bg-white p-3 flex flex-col gap-1">
                <span className="font-mono text-[11.5px] font-bold px-1.5 py-0.5 self-start border border-black" style={{ background: x.c, color: x.c === '#9333ea' ? '#fff' : '#000' }}>{x.k}</span>
                <h3 className="font-black text-base mt-0.5">{x.t}</h3>
                <p className="font-mono text-[12px] text-slate-700 leading-snug">{x.d}</p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
