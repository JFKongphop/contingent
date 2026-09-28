// Builds the HyperFrames composition for the polished demo: intro cards → framed app footage with a synced
// chapter rail + lower-third captions → outro. Reads the clean take (CAPTIONS=0) and its chapters.json.
//
// Usage: SRC=../demo-video/clean PROJECT=../demo-video/hyperframes node scripts/build-hyperframes.mjs
//        cd ../demo-video/hyperframes && npx hyperframes render -o ../contingent-demo-hyperframes.mp4
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const SRC = process.env.SRC || '../demo-video/clean';
const PROJECT = process.env.PROJECT || '../demo-video/hyperframes';
const video = `${SRC}/contingent-demo.mp4`;
const chapters = JSON.parse(fs.readFileSync(`${SRC}/chapters.json`, 'utf8'));
const vdur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString());

// ── timeline (seconds) ──
const INTRO = 6.5, PROBLEM = 7.5, OUTRO = 8;
const skip = chapters.find((c) => /ETH-PERP/.test(c.html ?? ''))?.t - 1.4 || 9.5; // start just before the app overview
const endAt = chapters.find((c) => /Uniswap v4 prices it/.test(c.html ?? ''))?.t ?? vdur; // outro card replaces the last caption
const F0 = INTRO + PROBLEM; // footage starts
const FD = +(endAt - skip).toFixed(2); // footage duration
const TOTAL = +(F0 + FD + OUTRO).toFixed(2);
const at = (t) => +(F0 + (t - skip)).toFixed(2); // footage-time → composition time

// rail chapters (first caption of each numbered step) and lower-third captions
const steps = [
  { key: /ETH-PERP/, label: 'ETH-PERP overview' },
  { key: /^<b>1 ·/, label: 'Encrypted collateral' },
  { key: /^<b>2 ·/, label: 'You vs. the chain' },
  { key: /^<b>3 ·/, label: 'Protected long · 1 tx' },
  { key: /^<b>4 ·/, label: 'Redacted position' },
  { key: /^<b>5 ·/, label: 'Close both' },
  { key: /^<b>6 ·/, label: 'Public odds' },
  { key: /^<b>7 ·/, label: 'Encrypted hedge' },
  { key: /^<b>8 ·/, label: 'Resolve & settle' },
  { key: /^<b>9 ·/, label: 'Premiums → LPs' },
].map((s) => ({ ...s, t: at(chapters.find((c) => s.key.test(c.html ?? '')).t) }));
const caps = chapters
  .filter((c) => c.html && c.t >= skip - 0.01 && c.t < endAt)
  .map((c, i, a) => ({ t: at(c.t), end: at(a[i + 1]?.t ?? endAt), html: c.html.replace(/^<b>\d+ ·<\/b>\s*/, '') }));

// ── assets ──
fs.mkdirSync(`${PROJECT}/assets`, { recursive: true });
fs.copyFileSync(video, `${PROJECT}/assets/app.mp4`);

const ROW = 70, RAIL_TOP = 150;
const rows = steps.map((s, i) => `
        <div class="row" style="top:${RAIL_TOP + i * ROW}px"><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="lbl">${s.label}</span><span class="tick" id="tick${i}">✓</span></div>`).join('');
const capEls = caps.map((c, i) => `
      <div class="cap" id="cap${i}">${c.html}</div>`).join('');

const anim = [];
// intro
anim.push(`tl.fromTo('#logo', {opacity:0, y:30}, {opacity:1, y:0, duration:.6, ease:'power3.out'}, .2)`);
anim.push(`tl.fromTo('#t1', {opacity:0, y:40}, {opacity:1, y:0, duration:.7, ease:'power3.out'}, .6)`);
anim.push(`tl.fromTo('#t2', {opacity:0, y:40}, {opacity:1, y:0, duration:.7, ease:'power3.out'}, 1.1)`);
anim.push(`tl.fromTo('.chip', {opacity:0, y:20}, {opacity:1, y:0, duration:.5, stagger:.12, ease:'power2.out'}, 1.9)`);
anim.push(`tl.to('#intro', {opacity:0, duration:.5}, ${INTRO - 0.5})`);
// problem
const P = INTRO;
anim.push(`tl.fromTo('#p-eyebrow', {opacity:0, y:20}, {opacity:1, y:0, duration:.5}, ${P + .2})`);
anim.push(`tl.fromTo('#p-num', {opacity:0, scale:.85}, {opacity:1, scale:1, duration:.7, ease:'back.out(1.6)'}, ${P + .5})`);
anim.push(`tl.fromTo('#p-sub', {opacity:0, y:20}, {opacity:1, y:0, duration:.5}, ${P + 1.2})`);
anim.push(`tl.fromTo('#p-line1', {opacity:0, x:-30}, {opacity:1, x:0, duration:.6}, ${P + 2.2})`);
anim.push(`tl.fromTo('#p-line2', {opacity:0, x:-30}, {opacity:1, x:0, duration:.6}, ${P + 3.6})`);
anim.push(`tl.to('#problem', {opacity:0, duration:.5}, ${P + PROBLEM - 0.5})`);
// app scene
anim.push(`tl.fromTo('#frame', {opacity:0, scale:.94}, {opacity:1, scale:1, duration:.7, ease:'power3.out'}, ${F0})`);
anim.push(`tl.fromTo('#vid', {opacity:0}, {opacity:1, duration:.7}, ${F0 + .2})`);
anim.push(`tl.fromTo('#rail', {opacity:0, x:40}, {opacity:1, x:0, duration:.6, ease:'power3.out'}, ${F0 + .3})`);
anim.push(`tl.fromTo('#bar', {scaleX:0}, {scaleX:1, duration:${FD}, ease:'none'}, ${F0})`);
steps.forEach((s, i) => {
  anim.push(`tl.to('#hl', {y:${i * ROW}, duration:.45, ease:'power2.inOut'}, ${s.t})`);
  if (i > 0) anim.push(`tl.to('#tick${i - 1}', {opacity:1, duration:.3}, ${s.t})`);
});
anim.push(`tl.to('#tick${steps.length - 1}', {opacity:1, duration:.3}, ${F0 + FD - .4})`);
caps.forEach((c, i) => {
  anim.push(`tl.fromTo('#cap${i}', {opacity:0, y:14}, {opacity:1, y:0, duration:.35, ease:'power2.out'}, ${c.t})`);
  anim.push(`tl.to('#cap${i}', {opacity:0, duration:.25}, ${Math.max(c.t + .4, c.end - .25).toFixed(2)})`);
});
anim.push(`tl.to(['#app', '#vid'], {opacity:0, duration:.5}, ${F0 + FD - .5})`);
// outro
const O = F0 + FD;
anim.push(`tl.fromTo('#o-logo', {opacity:0, y:24}, {opacity:1, y:0, duration:.6, ease:'power3.out'}, ${O + .3})`);
anim.push(`tl.fromTo('.stack', {opacity:0, y:24}, {opacity:1, y:0, duration:.5, stagger:.18, ease:'power2.out'}, ${O + .8})`);
anim.push(`tl.fromTo('#o-live', {opacity:0}, {opacity:1, duration:.6}, ${O + 2.4})`);

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@500;700&display=swap" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #f1f1f1; }
      #root { position: relative; width: 1920px; height: 1080px; font-family: 'Space Grotesk', system-ui, sans-serif; color: #111;
        background-color: #f1f1f1; background-image: linear-gradient(#e4e4e4 1px, transparent 1px), linear-gradient(90deg, #e4e4e4 1px, transparent 1px);
        background-size: 48px 48px; }
      .clip { position: absolute; inset: 0; }
      .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
      .box { border: 4px solid #000; box-shadow: 8px 8px 0 #000; background: #fff; }
      .logo { display: inline-flex; align-items: center; gap: 18px; }
      .logo .c { width: 64px; height: 64px; background: #00E5FF; border: 4px solid #000; box-shadow: 5px 5px 0 #000;
        display: grid; place-items: center; font: 700 38px 'Space Grotesk'; }
      .logo .w { font: 700 34px 'Space Grotesk'; letter-spacing: .02em; }
      /* intro */
      #intro { display: flex; flex-direction: column; justify-content: center; padding: 0 160px; gap: 34px; }
      #intro h1 { font: 700 104px/1.02 'Space Grotesk'; letter-spacing: -.02em; }
      #t2 span { background: #00E5FF; border: 5px solid #000; box-shadow: 9px 9px 0 #000; padding: 0 22px; display: inline-block; margin-top: 14px; }
      .chips { display: flex; gap: 16px; flex-wrap: wrap; }
      .chip { font: 700 22px 'JetBrains Mono'; border: 3px solid #000; box-shadow: 4px 4px 0 #000; background: #fff; padding: 10px 18px; }
      .chip.live { background: #00F076; }
      /* problem */
      #problem { display: flex; flex-direction: column; justify-content: center; padding: 0 160px; gap: 22px; }
      #p-eyebrow { font: 700 24px 'JetBrains Mono'; letter-spacing: .14em; color: #FF3366; }
      #p-num { font: 700 220px/1 'Space Grotesk'; letter-spacing: -.03em; transform-origin: left center; }
      #p-num span { color: #FF3366; }
      #p-sub { font: 500 34px 'JetBrains Mono'; color: #444; }
      .pl { font: 600 44px/1.25 'Space Grotesk'; max-width: 1500px; }
      #p-line2 b { background: #00E5FF; padding: 0 10px; border: 3px solid #000; }
      /* app */
      #topbar { position: absolute; left: 48px; top: 26px; right: 48px; height: 60px; display: flex; align-items: center; justify-content: space-between; }
      #topbar .logo .c { width: 48px; height: 48px; font-size: 28px; box-shadow: 4px 4px 0 #000; }
      #topbar .logo .w { font-size: 28px; }
      .pill { font: 700 18px 'JetBrains Mono'; border: 3px solid #000; box-shadow: 4px 4px 0 #000; padding: 8px 16px; background: #00F076; }
      #frame { position: absolute; left: 48px; top: 104px; width: 1392px; height: 870px; overflow: hidden; }
      #vid { position: absolute; inset: auto; left: 52px; top: 108px; width: 1384px; height: 862px; object-fit: cover; z-index: 5; }
      #barwrap { position: absolute; left: 48px; top: 986px; width: 1392px; height: 10px; border: 3px solid #000; background: #fff; }
      #bar { height: 100%; width: 100%; background: #00E5FF; transform-origin: left center; }
      .cap { position: absolute; left: 48px; top: 1010px; width: 1392px; text-align: center; opacity: 0;
        font: 600 30px 'Space Grotesk'; color: #111; }
      .cap b { background: #00E5FF; padding: 0 8px; border: 2px solid #000; }
      #rail { position: absolute; left: 1476px; top: 104px; width: 396px; height: 870px; }
      #rail h3 { position: absolute; left: 22px; top: 26px; font: 700 20px 'JetBrains Mono'; letter-spacing: .14em; color: #666; }
      #rail h2 { position: absolute; left: 22px; top: 60px; font: 700 34px 'Space Grotesk'; }
      #hl { position: absolute; left: 12px; top: ${RAIL_TOP}px; width: 364px; height: ${ROW - 10}px; background: #00E5FF; border: 3px solid #000; box-shadow: 4px 4px 0 #000; }
      .row { position: absolute; left: 12px; width: 364px; height: ${ROW - 10}px; display: flex; align-items: center; gap: 14px; padding: 0 16px; }
      .row .n { font: 700 18px 'JetBrains Mono'; color: #555; width: 28px; }
      .row .lbl { font: 600 23px 'Space Grotesk'; flex: 1; }
      .row .tick { font: 700 22px 'JetBrains Mono'; color: #00a854; opacity: 0; }
      /* outro */
      #outro { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; text-align: center; }
      #outro .stacks { display: flex; gap: 22px; }
      .stack { padding: 22px 30px; }
      .stack .k { font: 700 18px 'JetBrains Mono'; letter-spacing: .12em; color: #666; }
      .stack .v { font: 700 40px 'Space Grotesk'; margin-top: 6px; }
      .stack:nth-child(1) { background: #fff; } .stack:nth-child(2) { background: #00E5FF; } .stack:nth-child(3) { background: #00F076; }
      #o-live { font: 600 30px 'JetBrains Mono'; color: #333; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1920" data-height="1080">

      <section id="intro" class="clip" data-start="0" data-duration="${INTRO}" data-track-index="0">
        <div id="logo" class="logo"><span class="c">C</span><span class="w">CONTINGENT</span></div>
        <h1><div id="t1">Leverage with a capped crash.</div><div id="t2"><span>Fully encrypted.</span></div></h1>
        <div class="chips">
          <span class="chip">ETH-PERP 1–10x</span><span class="chip">Prediction-market protection</span>
          <span class="chip">Fhenix FHE</span><span class="chip live">● Live · Arbitrum Sepolia</span>
        </div>
      </section>

      <section id="problem" class="clip" data-start="${INTRO}" data-duration="${PROBLEM}" data-track-index="0">
        <div id="p-eyebrow">THE PROBLEM</div>
        <div id="p-num"><span>$19B+</span></div>
        <div id="p-sub">liquidated in a single day · 10 Oct 2025</div>
        <div id="p-line1" class="pl">On-chain perps publish every size, side and liquidation price — cascades and stop-hunts feed on them.</div>
        <div id="p-line2" class="pl">Contingent <b>encrypts</b> the position and <b>caps the crash</b> with a prediction market.</div>
      </section>

      <section id="app" class="clip" data-start="${F0}" data-duration="${FD}" data-track-index="0">
        <div id="topbar">
          <div class="logo"><span class="c">C</span><span class="w">CONTINGENT</span></div>
          <span class="pill">● LIVE ON ARBITRUM SEPOLIA · REAL TXS · SPED-UP WAITS</span>
        </div>
        <div id="frame" class="box"></div>
        <div id="barwrap"><div id="bar"></div></div>
        <div id="rail" class="box">
          <h3>DEMO</h3><h2>What you'll see</h2>
          <div id="hl"></div>${rows}
        </div>${capEls}
      </section>

      <!-- the video is timed on its own, as a direct child of the stage, laid over the frame box -->
      <video id="vid" class="clip" src="assets/app.mp4" muted playsinline data-start="${F0}" data-duration="${FD}" data-media-start="${skip.toFixed(2)}" data-track-index="1"></video>

      <section id="outro" class="clip" data-start="${+(F0 + FD).toFixed(2)}" data-duration="${OUTRO}" data-track-index="0">
        <div id="o-logo" class="logo"><span class="c">C</span><span class="w">CONTINGENT</span></div>
        <div class="stacks">
          <div class="stack box"><div class="k">PRICES IT</div><div class="v">Uniswap v4 odds</div></div>
          <div class="stack box"><div class="k">HIDES IT</div><div class="v">Fhenix FHE</div></div>
          <div class="stack box"><div class="k">SETTLES IT</div><div class="v">USDG · Chainlink</div></div>
        </div>
        <div id="o-live">Live &amp; source-verified on Arbitrum Sepolia</div>
      </section>
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${anim.join(';\n      ')};
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
`;
fs.writeFileSync(`${PROJECT}/index.html`, html);
console.log(`composition: intro ${INTRO}s + problem ${PROBLEM}s + app ${FD}s (from ${skip.toFixed(1)}s) + outro ${OUTRO}s = ${TOTAL}s (${Math.floor(TOTAL / 60)}:${String(Math.round(TOTAL % 60)).padStart(2, '0')})`);
console.log(`steps: ${steps.map((s) => s.t).join(', ')}`);
