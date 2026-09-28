'use client';

import { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useWeb3 } from '../context/Web3Context';
import { EVENT_ID, USDG_DECIMALS, FEED_DECIMALS, BPS } from '../config/contracts';

export interface MarketState {
  probYesBps: number; // 0..10000
  open: boolean; // open for hedging
  resolved: boolean;
  outcomeYes: boolean;
  reserve: number; // USDG
  earmarked: number; // USDG
  freeReserve: number; // USDG
  capacity: number; // USDG (this event)
  paidOut: number; // USDG
  premiumsSwept: boolean;
  feedPrice: number; // USD (e.g. 1.00)
  nextPositionId: number;
  yesPool: number; // USDG staked on YES (price discovery)
  noPool: number; // USDG staked on NO
  loading: boolean;
}

const INIT: MarketState = {
  probYesBps: 0, open: false, resolved: false, outcomeYes: false,
  reserve: 0, earmarked: 0, freeReserve: 0, capacity: 0, paidOut: 0, premiumsSwept: false,
  feedPrice: 0, nextPositionId: 1, yesPool: 0, noPool: 0, loading: true,
};

const u6 = (v: bigint) => Number(ethers.formatUnits(v, USDG_DECIMALS));

export function useMarket() {
  const { read, blockNumber } = useWeb3();
  const [state, setState] = useState<MarketState>(INIT);

  const load = useCallback(async () => {
    // settle each read on its own: one reverting call (e.g. freeReserve() while earmarked > reserve) must not
    // blank the whole market panel — failed fields keep their previous value
    const r = await Promise.allSettled([
      read.market.probYesBps(EVENT_ID) as Promise<bigint>,
      read.market.isOpenForHedging(EVENT_ID) as Promise<boolean>,
      read.market.isResolved(EVENT_ID) as Promise<[boolean, boolean]>,
      read.vault.totalReserve() as Promise<bigint>,
      read.vault.earmarked() as Promise<bigint>,
      read.vault.freeReserve() as Promise<bigint>,
      read.vault.events(EVENT_ID) as Promise<[bigint, bigint, boolean, boolean]>,
      read.feed.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
      read.positions.nextPositionId() as Promise<bigint>,
      read.market.getMarket(EVENT_ID) as Promise<[bigint, bigint, bigint, string, boolean, boolean, boolean]>,
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = (i: number): any => (r[i].status === 'fulfilled' ? (r[i] as PromiseFulfilledResult<unknown>).value : undefined);
    const [prob, open, res, reserve, earmarked, free, ev, round, nextId, mkt] = r.map((_, i) => ok(i));
    setState((s) => {
      const rsv = reserve !== undefined ? u6(reserve) : s.reserve;
      const ear = earmarked !== undefined ? u6(earmarked) : s.earmarked;
      return {
        probYesBps: prob !== undefined ? Number(prob) : s.probYesBps,
        open: open ?? s.open,
        resolved: res ? res[0] : s.resolved,
        outcomeYes: res ? res[1] : s.outcomeYes,
        reserve: rsv,
        earmarked: ear,
        freeReserve: free !== undefined ? u6(free) : Math.max(0, rsv - ear),
        capacity: ev ? u6(ev[0]) : s.capacity,
        paidOut: ev ? u6(ev[1]) : s.paidOut,
        premiumsSwept: ev ? ev[3] : s.premiumsSwept,
        feedPrice: round ? Number(ethers.formatUnits(round[1], FEED_DECIMALS)) : s.feedPrice,
        nextPositionId: nextId !== undefined ? Number(nextId) : s.nextPositionId,
        yesPool: mkt ? Number(mkt[0]) : s.yesPool,
        noPool: mkt ? Number(mkt[1]) : s.noPool,
        loading: false,
      };
    });
  }, [read]);

  useEffect(() => { load(); }, [load, blockNumber]);

  return { ...state, reload: load, probPct: (state.probYesBps / BPS) * 100 };
}
