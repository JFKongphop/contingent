# Contingent — Frontend

Neo-brutalist trading cockpit for **Contingent**: privately hedge event risk, priced by a prediction
market, encrypted with Fhenix CoFHE, settled in USDG on **Arbitrum Sepolia**.

Wired to the **live, verified** deployment (see [`../DEPLOYMENTS.md`](../DEPLOYMENTS.md)). Stack: Next.js
16 · React 19 · ethers v6 · `@cofhe/sdk` (browser FHE) · Tailwind v4.

## Run

```bash
cd contingent/frontend
npm install
npm run dev        # http://localhost:3000
```

Connect a wallet (MetaMask) on **Arbitrum Sepolia** (the header offers to add/switch the network). You
need a little Sepolia ETH for gas — the app mints its own test USDG for you.

## The four consoles (tabs)

| Tab | Actor | What you do |
|---|---|---|
| **HEDGE** | Hedger | Mint + wrap test USDG → deposit **encrypted** collateral → open an **encrypted** hedge (size + side hidden), priced off the public odds. See your positions. |
| **UNDERWRITE** | LP | Deposit USDG to back payouts, earmark event capacity, watch the reserve book. |
| **SETTLE** | Keeper | Resolve the event, run the 3-step async decrypt to pay winners, sweep premiums to LPs, finalise. |
| **ORACLE** | — | Move the mock Chainlink feed (`$1.00 ↔ $0.95`) to trigger / avoid the depeg. |

## Demo script (2 minutes)

1. **ORACLE** — confirm the feed is pegged at `$1.00`.
2. **UNDERWRITE** — (optional; already seeded) deposit USDG + earmark capacity.
3. **HEDGE** — Fund & wrap → deposit collateral → **open a YES hedge** on the depeg. Note: the tx encrypts
   your size and side; nobody can read them.
4. **ORACLE** — click **DEPEG · $0.95**. The feed crosses the band.
5. **SETTLE** — **Resolve**, then **Settle position #N** (watch the async decrypt), then **Sweep premiums**.
   The winner is paid in USDG from the LP reserve.

## How the FHE integration works

`src/lib/cofhe.ts` bridges the app's ethers signer to the viem-based `@cofhe/sdk` via `Ethers6Adapter`,
then:
- **encrypt** a hedge — `encryptInputs([Encryptable.uint64(size)]) / [Encryptable.bool(side)]`, each bound
  to the Hedge contract, producing the `externalEuint64/externalEbool` handles + proofs `openHedge` takes.
- **decrypt** a settlement payout / premium pool — `decryptForTx(handle).withoutACP()`, returning the
  plaintext + Teecryptor signature that `fulfillSettlement` / `sweepPremiums` verify on-chain.

## Config

Addresses live in `src/config/contracts.ts` (the verified Arbitrum Sepolia deployment). Override the RPC
with `NEXT_PUBLIC_ARB_SEPOLIA_RPC` if you have a private endpoint.

> Test-only: the app mints mock USDG freely. Never point this at mainnet funds.
