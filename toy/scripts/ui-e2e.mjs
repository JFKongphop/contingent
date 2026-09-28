// UI end-to-end test: drives the real PERPS tab in Chromium with an injected test wallet.
// fund + deposit → 🛡 OPEN PROTECTED LONG 5x (perp + NO cover, one tx) → CLOSE BOTH, with screenshots.
// Also records a video (usable as raw demo footage).
//
// Usage: PRIVATE_KEY=0x... SHOTS=/path/to/dir node scripts/ui-e2e.mjs
import { chromium } from 'playwright';
import { ethers } from 'ethers';
import fs from 'fs';

const RPC = process.env.ARB_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const SHOTS = process.env.SHOTS || 'ui-e2e-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const rpc = new ethers.JsonRpcProvider(RPC, 421614);
const base = new ethers.Wallet(process.env.PRIVATE_KEY, rpc);
const wallet = new ethers.NonceManager(base);
const retry = async (fn, n = 6) => {
  for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 1500)); } }
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: SHOTS, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

// Node-side wallet behind the injected EIP-1193 provider
await page.exposeFunction('__eth', async ({ method, params = [] }) => {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts': return [base.address];
    case 'eth_chainId': return '0x66eee';
    case 'net_version': return '421614';
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain': return null;
    case 'eth_sendTransaction': {
      const t = params[0];
      const tx = await wallet.sendTransaction({
        to: t.to, data: t.data,
        value: t.value ? BigInt(t.value) : 0n,
        gasLimit: t.gas ? BigInt(t.gas) : undefined,
        maxFeePerGas: t.maxFeePerGas ? BigInt(t.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: t.maxPriorityFeePerGas ? BigInt(t.maxPriorityFeePerGas) : undefined,
      });
      if (t.maxFeePerGas) console.log(`    (fee cap ${BigInt(t.maxFeePerGas)} wei)`);
      return tx.hash;
    }
    case 'personal_sign': return base.signMessage(ethers.getBytes(params[0]));
    case 'eth_signTypedData_v4': {
      const { domain, types, message } = JSON.parse(params[1]);
      delete types.EIP712Domain;
      return base.signTypedData(domain, types, message);
    }
    default: return retry(() => rpc.send(method, params));
  }
});
await page.addInitScript(() => {
  window.ethereum = { isMetaMask: true, request: (a) => window.__eth(a), on: () => {}, removeListener: () => {} };
});

const shot = async (name) => { await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); console.log(`  📸 ${name}.png`); };
const t0 = Date.now();
const step = async (name, fn) => { const s = Date.now(); process.stdout.write(`▶ ${name} … `); const r = await fn(); console.log(`✓ ${((Date.now() - s) / 1000).toFixed(1)}s${r ? '  ' + r : ''}`); return r; };
// wait for a ✓ status containing `ok`, or fail fast on a ✕ status
const waitStatus = async (ok, timeout = 240_000) => {
  const okLoc = page.getByText(ok).first();
  const errLoc = page.locator('div.font-mono', { hasText: '✕' }).first();
  const winner = await Promise.race([
    okLoc.waitFor({ timeout }).then(() => 'ok'),
    errLoc.waitFor({ timeout }).then(() => 'err'),
  ]);
  if (winner === 'err') throw new Error('UI error: ' + (await errLoc.innerText()));
  return (await okLoc.innerText()).replace(/\s+/g, ' ').trim();
};

try {
  await step('load /app', async () => { await page.goto('http://localhost:3000/app', { waitUntil: 'networkidle' }); });
  await step('connect wallet', async () => {
    await page.getByRole('button', { name: /CONNECT WALLET/ }).click();
    await page.getByText(base.address.slice(0, 6)).first().waitFor({ timeout: 30_000 });
  });
  await step('open PERPS tab', async () => {
    await page.getByRole('button', { name: 'PERPS', exact: true }).click();
    await page.getByText('Open an encrypted position').waitFor();
  });
  await shot('1-perps-tab');

  await step('mint + wrap 500 USDG (3 txs)', async () => {
    await page.getByRole('button', { name: 'MINT + WRAP' }).click();
    return waitStatus(/Wrapped/);
  });
  await step('deposit 200 encrypted collateral (UI default)', async () => {
    await page.getByRole('button', { name: 'DEPOSIT', exact: true }).click();
    return waitStatus(/Deposited/);
  });

  await step('🛡 OPEN PROTECTED LONG 5x — perp + NO cover in ONE tx', async () => {
    await page.getByText('Protect with the event market').waitFor();
    await shot('2-protect-toggle');
    await page.getByRole('button', { name: /OPEN PROTECTED LONG 5X/i }).click();
    const s = await waitStatus(/Opened PROTECTED/);
    if (/⚠/.test(s)) throw new Error('clamped: ' + s);
    return s;
  });
  await page.getByText(/PROTECTED · NO/).first().waitFor({ timeout: 60_000 });
  await shot('3-protected-position');

  await step('CLOSE BOTH (perp via async decrypt + protection hedge)', async () => {
    await page.getByRole('button', { name: 'CLOSE BOTH', exact: true }).first().click();
    const s = await waitStatus(/Closed #/);
    if (!/protection #\d+ closed/.test(s)) throw new Error('protection not closed: ' + s);
    return s;
  });
  await shot('4-closed');

  console.log(`\n✅ UI E2E PASSED in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
} catch (e) {
  console.log(`\n❌ UI E2E FAILED: ${e.message}`);
  await shot('FAIL');
  process.exitCode = 1;
} finally {
  if (consoleErrors.length) console.log(`\nbrowser console errors (${consoleErrors.length}):\n- ` + consoleErrors.slice(0, 8).join('\n- '));
  await context.close();
  await browser.close();
}
