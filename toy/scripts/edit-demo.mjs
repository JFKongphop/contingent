// Speeds up the on-chain waits logged by record-demo.mjs and renders the final MP4.
// Each wait of d seconds plays in ~2s + (d−2)/8 (short ones stay real-time); everything else is 1×.
//
// Usage: OUT=demo-video node scripts/edit-demo.mjs   → $OUT/contingent-demo.mp4
import { execFileSync } from 'child_process';
import fs from 'fs';

const OUT = process.env.OUT || 'demo-video';
const src = `${OUT}/raw/demo.webm`;
const marks = JSON.parse(fs.readFileSync(`${OUT}/marks.json`, 'utf8'));
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).toString());

// timeline of [start, end, speed]
const segs = [];
let t = 0;
for (const m of marks) {
  if (m.s > t) segs.push([t, m.s, 1]);
  const d = m.e - m.s;
  const target = d <= 2.5 ? d : Math.min(6, 2 + (d - 2) / 8); // long waits never exceed 6 s on screen
  segs.push([m.s, m.e, d / target]);
  t = m.e;
}
if (t < dur) segs.push([t, dur, 1]);

const parts = segs.map(([s, e, k], i) =>
  `[0:v]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=(PTS-STARTPTS)/${k.toFixed(4)}[v${i}]`);
const filter = `${parts.join(';')};${segs.map((_, i) => `[v${i}]`).join('')}concat=n=${segs.length}:v=1:a=0,fps=30,format=yuv420p[out]`;

execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-filter_complex', filter, '-map', '[out]',
  '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', `${OUT}/contingent-demo.mp4`], { stdio: 'inherit' });

const final = segs.reduce((a, [s, e, k]) => a + (e - s) / k, 0);

// map raw-video times onto the edited timeline (used to sync HyperFrames overlays)
const mapT = (t) => segs.reduce((a, [s, e, k]) => a + (t <= s ? 0 : (Math.min(t, e) - s) / k), 0);
if (fs.existsSync(`${OUT}/captions.json`)) {
  const caps = JSON.parse(fs.readFileSync(`${OUT}/captions.json`, 'utf8'));
  fs.writeFileSync(`${OUT}/chapters.json`, JSON.stringify(caps.map((c) => ({ t: +mapT(c.t).toFixed(2), html: c.html })), null, 2));
}
console.log(`raw ${dur.toFixed(1)}s → final ${final.toFixed(1)}s (${Math.floor(final / 60)}:${String(Math.round(final % 60)).padStart(2, '0')}) → ${OUT}/contingent-demo.mp4`);
