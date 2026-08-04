#!/usr/bin/env node
/**
 * How blown-out is a Judgement primal, measured rather than argued.
 *
 * Lays five towers on a fixed lattice — pure Light L2, Judgement L0/L1/L2 and
 * Cataclysm L2 — at one camera, then counts, per tower column, how many pixels
 * are clipped to near-white in ALL THREE channels. A silhouette survives bloom
 * when the clipped core is small relative to the tower; it dies when the clipped
 * region is the tower.
 *
 *   node tools/scratch/_r3-lightblow.mjs --out shots/_r3-lightblow.png
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(arg('out', 'shots/_r3-lightblow.png'));
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;',
}));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const info = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
  g.state.pendingElementPicks = 0;
  g.state.gold = 9e9;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  for (const t of [...g.towers.towers]) g.towers.remove(t.id);

  const SET = [
    ['light', 2, 'pure light L2'],
    ['primal_light', 0, 'Judgement L0'],
    ['primal_light', 2, 'Judgement L2'],
    ['primal_fire', 2, 'Cataclysm L2'],
    ['fire', 2, 'pure fire L2'],
  ];
  const out = [];
  let col = 4;
  for (const [key, level, label] of SET) {
    // Building a primal CONSUMES three copies of its element, so the wallet has
    // to be refilled between towers or the second one silently fails.
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark',
      'light', 'light', 'fire', 'fire'];
    g.hud.refreshBuildBar();
    const c = col, r = 10;
    if (!g.build(key, c, r)) { out.push({ label, err: 'build failed' }); col += 4; continue; }
    const t = g.towers.towers[g.towers.towers.length - 1];
    for (let i = 0; i < level; i++) g.towers.upgrade(t.id);
    out.push({ label, id: t.id, x: t.x, z: t.z });
    col += 4;
  }
  g.rig.focus(4, 2, 62);
  await wait(1800);
  // Project each tower's ground anchor to screen so the reader can slice.
  const V = g.camera.position.constructor;
  for (const o of out) {
    if (o.x === undefined) continue;
    const v = new V(o.x, 3, o.z).project(g.camera);
    o.sx = Math.round((v.x * 0.5 + 0.5) * window.innerWidth);
    o.sy = Math.round((-v.y * 0.5 + 0.5) * window.innerHeight);
  }
  return out;
});

const buf = await page.screenshot({ path: OUT });
await browser.close();

// Count clipped pixels per column band using the raw PNG through a tiny decoder:
// re-open the file in a headless page is overkill, so use sharp-free counting via
// playwright's own screenshot of clipped regions instead. Simplest honest route:
// re-launch and read pixels from a canvas.
const b2 = await chromium.launch({ args: ['--hide-scrollbars'] });
const p2 = await b2.newPage({ viewport: { width: 1600, height: 900 } });
await p2.setContent(`<img id="i" src="data:image/png;base64,${buf.toString('base64')}">`);
await p2.waitForFunction(() => document.getElementById('i').complete);
const counts = await p2.evaluate((towers) => {
  const img = document.getElementById('i');
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, cv.width, cv.height).data;
  const res = [];
  for (const t of towers) {
    if (t.sx === undefined) { res.push({ label: t.label, err: t.err }); continue; }
    const x0 = Math.max(0, t.sx - 70), x1 = Math.min(cv.width, t.sx + 70);
    const y0 = Math.max(0, t.sy - 210), y1 = Math.min(cv.height, t.sy + 40);
    let clipped = 0, bright = 0, total = 0, core = 0;
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * cv.width + x) * 4;
        const r = d[o], g = d[o + 1], b = d[o + 2];
        total++;
        if (r > 248 && g > 248 && b > 248) {
          clipped++;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
        if (r > 200 && g > 200 && b > 200) bright++;
        if (Math.min(r, g, b) > 232) core++;
      }
    }
    res.push({
      label: t.label, total,
      corePx: core,
      brightPct: +(bright / total * 100).toFixed(2),
      clippedBox: clipped ? `${maxx - minx + 1}x${maxy - miny + 1}` : '-',
    });
  }
  return res;
}, info);
await b2.close();

console.log(JSON.stringify({ out: OUT, counts }, null, 2));
