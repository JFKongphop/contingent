// Live end-to-end test against Arbitrum Sepolia + the real Fhenix CoFHE service.
// Flow: mint → wrap → encrypted deposit → open perp (encrypted) → protect (buy NO, encrypted)
//       → liquidation check (1-bit reveal) → close perp (async decrypt) .
// Does NOT resolve the event market (irreversible).
//
// Usage: PRIVATE_KEY=0x... ARB_RPC=https://... node scripts/live-e2e.mjs
import { ethers } from 'ethers';
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/node';
import { arbSepolia } from '@cofhe/sdk/chains';
import { Ethers6Adapter } from '@cofhe/sdk/adapters';
import { Encryptable } from '@cofhe/sdk';

const A = {
  hedge: '0x670b2dC8EEa68Cb6BA2caC4021FCE02b85C51Dcf',
  cusdg: '0xd8f57E64bc235D4bceF8D2f791BDf46908408F94',
  collateral: '0x4E4cb1b3B326C79FDFD51E14C26C9bDA7a5F5898',
  perp: '0x8547089cE2380ec20Ad68c5fff4E661863452718',
  usdg: '0x766f287682ecfbD8f97551727684c7d7aD67a53f',
};
const EVENT_ID = '0x7d16602ed50f13146544454b9de4fc3f796dd69547f5c4c2855ff34ec0cbea78';

const provider = new ethers.JsonRpcProvider(process.env.ARB_RPC, 421614);
// NonceManager: track the nonce locally — a load-balanced public RPC can report a stale one
const baseWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const wallet = new ethers.NonceManager(baseWallet);
wallet.address = baseWallet.address;
const RESUME_ID = process.env.PERP_ID ? Number(process.env.PERP_ID) : 0; // resume at the liquidation check
const C = (addr, abi) => new ethers.Contract(addr, abi, wallet);
const usdg = C(A.usdg, ['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const cusdg = C(A.cusdg, ['function wrap(uint256)', 'function confidentialTransferAndCall(address,bytes32,bytes,bytes) returns (bytes32)']);
const perp = C(A.perp, [
  'function openPosition(bytes32,bytes,bytes32,bytes,uint64) returns (uint256)',
  'function requestClose(uint256)',
  'function fulfillClose(uint256,uint64,bytes,uint64,bytes)',
  'function requestLiquidationCheck(uint256)',
  'function resolveLiquidationCheck(uint256,bool,bytes)',
  'function getPosition(uint256) view returns (tuple(address owner,uint64 leverage,uint256 entryPrice,uint256 openedAt,uint8 status,bytes32 collateral,bytes32 size,bytes32 isLong,bytes32 maxProfit,bytes32 payout,bytes32 liquidatable,uint256 markPriceAtRequest,address keeper))',
  'event PositionOpened(uint256 indexed id, address indexed owner, uint64 leverage, uint256 entryPrice)',
]);
const hedge = C(A.hedge, [
  'function openHedge(bytes32,bytes32,bytes,bytes32,bytes) returns (uint256)',
  'event HedgeOpened(uint256 indexed positionId, address indexed user, bytes32 indexed eventId, uint32 entryProbBps)',
]);

const u = (n) => ethers.parseUnits(String(n), 6);
// public RPCs occasionally return transient "Internal error" on reads — retry them
const retry = async (fn, n = 6) => {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
};
const t0 = Date.now();
const step = async (name, fn) => {
  const s = Date.now();
  process.stdout.write(`▶ ${name} … `);
  const r = await fn();
  console.log(`✓ ${((Date.now() - s) / 1000).toFixed(1)}s${r ? '  ' + r : ''}`);
  return r;
};
const send = async (p) => (await p).wait();
const parseId = (rc, contract, evName, arg) => {
  for (const log of rc.logs) {
    try { const ev = contract.interface.parseLog(log); if (ev?.name === evName) return Number(ev.args[arg]); } catch {}
  }
  return 0;
};

console.log(`wallet ${wallet.address}`);
const client = createCofheClient(createCofheConfig({ supportedChains: [arbSepolia] }));
await step('connect CoFHE client', async () => {
  const { publicClient, walletClient } = await Ethers6Adapter(provider, baseWallet);
  await client.connect(publicClient, walletClient);
});

const enc64 = async (v, target) => { const r = await client.encryptInputs([Encryptable.uint64(v)]).setConsumingContract(target).execute(); return [r[0], r[r.length - 1]]; };
const encB = async (v, target) => { const r = await client.encryptInputs([Encryptable.bool(v)]).setConsumingContract(target).execute(); return [r[0], r[r.length - 1]]; };
const dec = async (h) => { const r = await client.decryptForTx(h).withoutACP().execute(); return { v: BigInt(r.decryptedValue), sig: r.signature }; };

let perpId = RESUME_ID;
let hedgeId = 'n/a (resumed)';
if (!RESUME_ID) {
  await step('mint + approve + wrap 300 USDG', async () => {
    await send(usdg.mint(wallet.address, u(300)));
    await send(usdg.approve(A.cusdg, u(300)));
    await send(cusdg.wrap(u(300)));
  });

  await step('deposit 300 encrypted collateral', async () => {
    const [h, p] = await enc64(u(300), A.cusdg);
    await send(cusdg.confidentialTransferAndCall(A.collateral, h, p, '0x'));
  });

  perpId = await step('open LONG 5x, 100 collateral (encrypted)', async () => {
    const [ch, cp] = await enc64(u(100), A.perp);
    const [dh, dp] = await encB(true, A.perp);
    const rc = await send(perp.openPosition(ch, cp, dh, dp, 5));
    return parseId(rc, perp, 'PositionOpened', 'id');
  });

  hedgeId = await step('🛡 protect: buy NO 100 on "ETH ≥ $2,500" (encrypted)', async () => {
    const [sh, sp] = await enc64(u(100), A.hedge);
    const [dh, dp] = await encB(false, A.hedge);
    const rc = await send(hedge.openHedge(EVENT_ID, sh, sp, dh, dp));
    return parseId(rc, hedge, 'HedgeOpened', 'positionId');
  });
} else {
  console.log(`↺ resuming at perp #${RESUME_ID}`);
}

await step(`liquidation check on perp #${perpId} (expect healthy, 1 bit)`, async () => {
  await send(perp.requestLiquidationCheck(perpId));
  const p = await retry(() => perp.getPosition(perpId));
  const f = await dec(p.liquidatable);
  await send(perp.resolveLiquidationCheck(perpId, f.v === 1n, f.sig));
  const after = await retry(() => perp.getPosition(perpId));
  return `flag=${f.v} status=${after.status} (1=Open)`;
});

await step(`close perp #${perpId} (async decrypt payout + collateral)`, async () => {
  const before = await retry(() => usdg.balanceOf(wallet.address));
  await send(perp.requestClose(perpId));
  const p = await retry(() => perp.getPosition(perpId));
  const pay = await dec(p.payout);
  const col = await dec(p.collateral);
  await send(perp.fulfillClose(perpId, pay.v, pay.sig, col.v, col.sig));
  const got = (await retry(() => usdg.balanceOf(wallet.address))) - before;
  return `payout=${ethers.formatUnits(pay.v, 6)} collateral=${ethers.formatUnits(col.v, 6)} received=${ethers.formatUnits(got, 6)} USDG`;
});

console.log(`\n✅ LIVE E2E PASSED in ${((Date.now() - t0) / 1000).toFixed(0)}s — perp #${perpId}, protection hedge #${hedgeId}`);
process.exit(0);
