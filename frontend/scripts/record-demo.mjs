// Demo recorder: drives the real frontend against Arbitrum Sepolia with an injected wallet and records a
// 1440×900 video. Adds a visible cursor, typed input, small scene captions, and logs every on-chain wait
// so `scripts/edit-demo.mjs` can speed those stretches up.
//
// Usage: DEMO_PK=0x... OUT=demo-video node scripts/record-demo.mjs   (dev server on :3000)
import { chromium } from 'playwright';
import { ethers } from 'ethers';
import fs from 'fs';

const RPC = process.env.ARB_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const OUT = process.env.OUT || 'demo-video';
const CAPTIONS = process.env.CAPTIONS !== '0';
const PACE = Number(process.env.PACE || 1.4); // scales every pause — 1.4 ≈ 3.5–4.5s on each readable step
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const HEDGE = '0x670b2dC8EEa68Cb6BA2caC4021FCE02b85C51Dcf';
fs.mkdirSync(`${OUT}/raw`, { recursive: true });

const rpc = new ethers.JsonRpcProvider(RPC, 421614);
const base = new ethers.Wallet(process.env.DEMO_PK, rpc);
let nextNonce = null; // managed locally so a resent tx keeps its nonce
const retry = async (fn, n = 6) => {
  for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await new Promise((r) => setTimeout(r, 1500)); } }
};
const sent = []; // { to, hash } — used to read the hedge id from its receipt

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: `${OUT}/raw`, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
page.on('console', (m) => { if (m.text().startsWith('[cofhe]')) console.log('   ' + m.text()); });
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const marks = []; // { s, e, label } — on-chain waits (seconds from video start)
const captions = []; // { t, html } — every caption change, logged even with CAPTIONS=0 (for HyperFrames overlays)

await page.exposeFunction('__eth', async (req) => {
  try { return await handle(req); } catch (e) { console.log(`  rpc error [${req.method}]: ${e.shortMessage ?? e.message}`.slice(0, 300)); throw e; }
});
async function handle({ method, params = [] }) {
  switch (method) {
    case 'eth_requestAccounts':
    case 'eth_accounts': return [base.address];
    case 'eth_chainId': return '0x66eee';
    case 'net_version': return '421614';
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain': return null;
    case 'eth_sendTransaction': {
      // sign once, then (re)broadcast the same bytes — a flaky RPC can never cause a duplicate action
      const t = params[0];
      if (nextNonce === null) nextNonce = await retry(() => rpc.getTransactionCount(base.address, 'pending'));
      const req = await retry(() => base.populateTransaction({
        to: t.to, data: t.data, nonce: nextNonce,
        value: t.value ? BigInt(t.value) : 0n,
        gasLimit: t.gas ? BigInt(t.gas) : undefined,
        maxFeePerGas: t.maxFeePerGas ? BigInt(t.maxFeePerGas) : undefined,
        maxPriorityFeePerGas: t.maxPriorityFeePerGas ? BigInt(t.maxPriorityFeePerGas) : undefined,
      }));
      const raw = await base.signTransaction(req);
      const hash = ethers.keccak256(raw);
      for (let i = 0; ; i++) {
        try { await rpc.send('eth_sendRawTransaction', [raw]); break; } catch (e) {
          const m = String(e.shortMessage ?? e.message);
          if (/already known|nonce too low|known transaction/i.test(m)) break; // it's in
          if (i >= 6) throw e;
          console.log(`  resend ${i + 1}: ${m.slice(0, 120)}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      nextNonce++;
      sent.push({ to: (t.to || '').toLowerCase(), hash });
      return hash;
    }
    case 'personal_sign': return base.signMessage(ethers.getBytes(params[0]));
    case 'eth_signTypedData_v4': {
      const { domain, types, message } = JSON.parse(params[1]);
      delete types.EIP712Domain;
      return base.signTypedData(domain, types, message);
    }
    default: return retry(() => rpc.send(method, params));
  }
}

await page.addInitScript(({ captions }) => {
  window.ethereum = { isMetaMask: true, request: (a) => window.__eth(a), on: () => {}, removeListener: () => {} };
  // presentation layer: cursor, click ripple, caption, "on-chain" pill (pointer-events: none — never blocks the app)
  const css = `
    #demo-cursor{position:fixed;left:720px;top:450px;width:22px;height:22px;z-index:2147483647;pointer-events:none;
      transition:left .8s cubic-bezier(.4,0,.2,1),top .8s cubic-bezier(.4,0,.2,1)}
    #demo-cursor svg{filter:drop-shadow(2px 2px 0 rgba(0,0,0,.35))}
    .demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border:3px solid #00E5FF;border-radius:50%;
      z-index:2147483646;pointer-events:none;animation:demo-rip .5s ease-out forwards}
    @keyframes demo-rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
    #demo-cap{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;
      background:#111;color:#fff;border:2px solid #000;box-shadow:4px 4px 0 #00E5FF;padding:10px 18px;
      font:600 17px 'Space Grotesk',system-ui,sans-serif;letter-spacing:.01em;max-width:1380px;white-space:nowrap;text-align:center;
      transition:opacity .3s;opacity:0}
    #demo-cap b{color:#00E5FF}
    nextjs-portal{display:none!important}
    #demo-wait{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;background:#FFE500;
      border:2px solid #000;box-shadow:3px 3px 0 #000;padding:6px 12px;font:700 13px 'JetBrains Mono',monospace;
      opacity:0;transition:opacity .2s}`;
  const mount = () => {
    if (document.getElementById('demo-cursor')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const c = document.createElement('div'); c.id = 'demo-cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.6L20 11z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const cap = document.createElement('div'); cap.id = 'demo-cap'; document.body.appendChild(cap);
    const w = document.createElement('div'); w.id = 'demo-wait'; w.textContent = '⏳ on-chain · sped up'; document.body.appendChild(w);
    if (!captions) cap.style.display = 'none';
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mount) : mount();
  window.__demo = {
    move: (x, y) => { mount(); const c = document.getElementById('demo-cursor'); c.style.left = x + 'px'; c.style.top = y + 'px'; },
    ripple: (x, y) => { const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 600); },
    caption: (html) => { mount(); const el = document.getElementById('demo-cap'); if (!html) { el.style.opacity = 0; return; } el.innerHTML = html; el.style.opacity = 1; },
    wait: (on) => { mount(); document.getElementById('demo-wait').style.opacity = on ? 1 : 0; },
  };
}, { captions: CAPTIONS });

// ── helpers ──
const hold = (ms) => page.waitForTimeout(ms * PACE);
const caption = (html) => { captions.push({ t: now(), html }); return page.evaluate((h) => window.__demo?.caption(h), html); };
async function pointAt(loc) {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.evaluate(([x, y]) => window.__demo.move(x, y), [x, y]);
  await hold(700);
  return [x, y];
}
async function click(loc) {
  const [x, y] = await pointAt(loc);
  await page.evaluate(([x, y]) => window.__demo.ripple(x, y), [x, y]);
  await loc.click();
  await hold(250);
}
async function type(loc, text) {
  await click(loc);
  await loc.fill('');
  await loc.pressSequentially(text, { delay: 150 });
  await hold(300);
}
// eased scroll over `ms` — slow enough for a viewer to follow what passes by
async function scrollY(y, ms = 1600) {
  await page.evaluate(([to, ms]) => new Promise((done) => {
    const from = window.scrollY, d = to - from, t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const step = (now) => { const k = Math.min(1, (now - t0) / ms); window.scrollTo(0, from + d * ease(k)); k < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }), [y, ms]);
  await hold(400);
}
async function scrollTo(loc, offset = 120, ms = 1600) {
  const y = await loc.evaluate((el, off) => el.getBoundingClientRect().top + window.scrollY - off, offset);
  await scrollY(Math.max(0, y), ms);
}
// wait for a ✓ status (fail fast on ✕), logging the stretch as an on-chain wait for the editor
async function chain(label, ok, timeout = 240_000) {
  const s = now();
  await page.evaluate(() => window.__demo.wait(true));
  const okLoc = page.getByText(ok).first();
  const errLoc = page.locator('div.font-mono', { hasText: '✕' }).first();
  const winner = await Promise.race([
    okLoc.waitFor({ timeout }).then(() => 'ok'),
    errLoc.waitFor({ timeout }).then(() => 'err'),
  ]);
  await page.evaluate(() => window.__demo.wait(false));
  marks.push({ s, e: now(), label });
  if (winner === 'err') throw new Error(`${label}: ` + (await errLoc.innerText()));
  const msg = (await okLoc.innerText()).replace(/\s+/g, ' ').trim();
  console.log(`  ✓ ${label} (${(now() - s).toFixed(1)}s) ${msg}`);
  return msg;
}
const tab = (name) => page.getByRole('button', { name, exact: true });

try {
  // 1 · landing → app
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await caption('<b>Contingent</b> — leveraged perps with a capped crash, fully encrypted · live on Arbitrum Sepolia');
  await hold(3500);
  await click(page.getByRole('link', { name: /LAUNCH APP/ }).first());
  await page.waitForURL('**/app');
  await page.waitForLoadState('networkidle');
  await caption(null);
  await hold(1200);
  await click(page.getByRole('button', { name: /CONNECT WALLET/ }));
  await page.getByText(base.address.slice(0, 6)).first().waitFor({ timeout: 30_000 });
  await caption('<b>ETH-PERP</b> · live Chainlink price · 1–10x leverage · the house pool is the counterparty');
  await pointAt(page.getByText('MARK PRICE', { exact: false }).first());
  await hold(1800);
  await pointAt(page.getByText('size & side hidden').first());
  await hold(2200);

  // 2 · PERPS: encrypted collateral, you vs the chain
  const openCard = page.getByText('Open an encrypted position');
  await scrollTo(openCard, 20, 2000);
  await caption('<b>1 ·</b> Wrap USDG and deposit it as <b>encrypted</b> collateral');
  const fund = page.getByRole('button', { name: 'MINT + WRAP' });
  await type(fund.locator('xpath=preceding-sibling::input'), '1000');
  await click(fund);
  await chain('mint + wrap', /Wrapped/);
  await hold(1200);
  const dep = page.getByRole('button', { name: 'DEPOSIT', exact: true });
  await type(dep.locator('xpath=preceding-sibling::input'), '600');
  await click(dep);
  await chain('encrypted deposit', /Deposited/);
  await hold(1500);
  await caption('<b>2 ·</b> Only <b>you</b> can decrypt your balance — everyone else sees a ciphertext handle');
  await click(page.getByRole('button', { name: /REVEAL/ }).first());
  await chain('private reveal', /USDG free to trade/);
  await pointAt(page.getByText('🌐 Everyone else'));
  await hold(3200);

  // 3 · protected long — one transaction
  await caption('<b>3 ·</b> Long ETH 5x <b>+ protection</b> from the prediction market — worst case −100 → −35');
  await pointAt(page.getByText('Protect with the event market'));
  await hold(2200);
  await pointAt(page.getByText(/Liquidated & ETH below strike/));
  await hold(2600);
  await click(page.getByRole('button', { name: /OPEN PROTECTED LONG 5X/i }));
  await caption('<b>3 ·</b> Perp + NO hedge opened in <b>one transaction</b> — side picked on the ciphertext');
  await chain('open protected long', /Opened PROTECTED/);
  await hold(2500);

  // 4 · masked position → reveal
  const posCard = page.locator('div.neo-card').filter({ hasText: 'Your positions' }).last();
  await scrollTo(posCard, 260);
  await caption('<b>4 ·</b> On-chain your position is <b>redacted</b> — size, side, liquidation price');
  await pointAt(posCard.getByText(/est\. PnL/).first());
  await hold(2600);
  await click(posCard.getByRole('button', { name: /REVEAL/ }).first());
  await chain('reveal position', /HIDE/);
  await caption('<b>4 ·</b> Decrypted in your browser with a signed permit — nobody else can');
  await hold(3200);
  await caption('<b>5 ·</b> Close the perp <b>and</b> its protection in one click');
  await click(posCard.getByRole('button', { name: 'CLOSE BOTH' }).first());
  await chain('close both', /Closed #/);
  await hold(3000);

  // 5 · MARKET: public odds
  await scrollY(0);
  await click(tab('MARKET'));
  await caption('<b>6 ·</b> The odds are <b>public</b> — they price every hedge. Positions stay private.');
  await hold(2800);
  const stakeNo = page.getByRole('button', { name: /STAKE NO/ });
  await scrollTo(stakeNo, 520);
  await click(stakeNo);
  await chain('stake', /Staked/);
  await pointAt(page.getByText('Prices your hedge'));
  await hold(3000);

  // 6 · HEDGE: encrypted binary derivative
  await scrollY(0);
  await click(tab('HEDGE'));
  await caption('<b>7 ·</b> Or hedge the event directly — an encrypted binary derivative');
  const openHedge = page.getByRole('button', { name: /OPEN ENCRYPTED HEDGE/ });
  await scrollTo(page.getByText('Open an encrypted event derivative'), 20);
  await pointAt(page.getByText(/Binary derivative · payoff/));
  await hold(2600);
  await click(openHedge);
  await chain('open hedge', /Opened encrypted/);
  await hold(1500);
  const last = [...sent].reverse().find((t) => t.to === HEDGE.toLowerCase());
  const rc = await retry(() => rpc.getTransactionReceipt(last.hash));
  const opened = rc.logs.find((l) => l.address.toLowerCase() === HEDGE.toLowerCase() && l.topics.length === 4);
  const hedgeId = String(BigInt(opened.topics[1]));
  console.log(`  hedge id #${hedgeId}`);
  await hold(1500);

  // 7 · SETTLE
  await scrollY(0);
  await click(tab('SETTLE'));
  await caption('<b>8 ·</b> Chainlink resolves the event — only the <b>winning payout</b> is ever decrypted');
  await hold(1500);
  await click(page.getByRole('button', { name: /RESOLVE EVENT/ }));
  await chain('resolve', /Resolved · outcome/);
  await type(page.locator('input').first(), hedgeId);
  await click(page.getByRole('button', { name: /SETTLE POSITION/ }));
  await chain('settle', /Paid .* USDG to the winner|payout 0/);
  await hold(3000);
  await caption('<b>9 ·</b> Premiums go to the LPs — only the <b>aggregate</b> is revealed');
  await click(page.getByRole('button', { name: /SWEEP PREMIUMS/ }));
  await chain('sweep', /Swept/);
  await hold(3000);
  await caption('<b>Contingent</b> · Uniswap v4 prices it · Fhenix hides it · live &amp; verified on Arbitrum Sepolia');
  await hold(4500);
  console.log(`\n✅ recorded ${now().toFixed(0)}s`);
} catch (e) {
  console.log(`\n❌ ${e.message}`);
  await page.screenshot({ path: `${OUT}/FAIL.png`, fullPage: true });
  process.exitCode = 1;
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) fs.renameSync(await video.path(), `${OUT}/raw/demo.webm`);
  fs.writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 2));
  fs.writeFileSync(`${OUT}/captions.json`, JSON.stringify(captions, null, 2));
  console.log(`video → ${OUT}/raw/demo.webm · marks → ${OUT}/marks.json`);
}
