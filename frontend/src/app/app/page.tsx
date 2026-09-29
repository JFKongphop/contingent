'use client';

import React, { useState } from 'react';
import { Header, Tab } from '../../components/Header';
import { MarketStatsBar } from '../../components/MarketStatsBar';
import { MarketConsole } from '../../components/MarketConsole';
import { PerpTerminal } from '../../components/PerpTerminal';
import { HedgerTerminal } from '../../components/HedgerTerminal';
import { PositionsManager } from '../../components/PositionsManager';
import { LPConsole } from '../../components/LPConsole';
import { KeeperConsole } from '../../components/KeeperConsole';

export default function App() {
  const [tab, setTab] = useState<Tab>('perps');
  return (
    <div className="min-h-screen bg-transparent text-slate-900 flex flex-col selection:bg-slate-200 selection:text-slate-900" style={{ fontFamily: 'var(--font-headline)' }}>
      <Header active={tab} onChange={setTab} />
      <main className="w-full flex-1 pb-16">
        <div className="w-full max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 pt-5 flex flex-col gap-4">
          {tab !== 'perps' && <MarketStatsBar />}
          {tab === 'market' && <MarketConsole />}
          {tab === 'perps' && <PerpTerminal />}
          {tab === 'hedge' && (<><HedgerTerminal onGoPerps={() => setTab('perps')} /><PositionsManager /></>)}
          {tab === 'lp' && <LPConsole />}
          {tab === 'keeper' && <KeeperConsole />}
        </div>
      </main>
    </div>
  );
}
