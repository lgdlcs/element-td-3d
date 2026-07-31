#!/usr/bin/env node
/**
 * TOWERS agent instrument. Boots midgame (wave 21, 21 towers), freezes the sim,
 * then:
 *   - reports the live state of the 8-light pool (intensity, distance)
 *   - measures frame time with the pool live vs. hard-hidden
 *   - measures the ground-glow footprint by ablating `towers.batch.glowMesh`
 *     and diffing the two frames read back FROM THE CANVAS, i.e. through the
 *     full post chain (bloom + grade), which is where a wide patch becomes a
 *     haze.
 *
 * Every number is a PAIRED measurement on one build (PITFALLS 12). Nothing here
 * is comparable to docs/STATUS.md.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TAG = arg('tag', 'x');
mkdirSync('shots/probe', { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [
    ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
    ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
    ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
    ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
    ['dark', 14, 15],
  ];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  g.state.wave = 21; g.state.phase = 'combat';
  g.waves.start(22);
  await wait(3600);
  g.state.speed = 0; if (g.setSpeed) g.setSpeed(0);
  await wait(600);

  // Canvas readback helper. `preserveDrawingBuffer` is usually off, so grab the
  // pixels in the SAME task as the render call.
  window.__grab = () => {
    const g2 = window.__game;
    const cv = g2.pipeline.renderer.domElement;
    g2.pipeline.render(performance.now() / 1000, 0.016);
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return { w: c.width, h: c.height, data: Array.from(d.data) };
  };
});

// --- light pool state -------------------------------------------------------
const lights = await page.evaluate(() => window.__game.towers.batch.lights.map((s) => ({
  i: +s.light.intensity.toFixed(2), d: +s.light.distance.toFixed(1),
  vis: s.light.visible, tid: s.towerId,
})));

// --- frame time: pool live vs pool hidden ----------------------------------
const frameTime = () => page.evaluate(async () => {
  const g = window.__game;
  const gl = g.pipeline.renderer.getContext();
  const ts = [];
  for (let k = 0; k < 45; k++) {
    await new Promise((res) => requestAnimationFrame(res));
    const t0 = performance.now();
    g.pipeline.render(k * 0.016, 0.016);
    gl.finish();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return { median: +ts[22].toFixed(1), p10: +ts[4].toFixed(1) };
});

const ftOn = await frameTime();
await page.evaluate(async () => {
  for (const s of window.__game.towers.batch.lights) s.light.visible = false;
  await new Promise((r) => setTimeout(r, 500));
});
const ftOff = await frameTime();
await page.evaluate(async () => {
  for (const s of window.__game.towers.batch.lights) s.light.visible = true;
  await new Promise((r) => setTimeout(r, 500));
});

// --- glow footprint by ablation, through the full post chain ---------------
const A = await page.evaluate(() => window.__grab());
await page.evaluate(async () => {
  window.__game.towers.batch.glowMesh.visible = false;
  await new Promise((r) => setTimeout(r, 500));
});
const B = await page.evaluate(() => window.__grab());
await page.evaluate(() => { window.__game.towers.batch.glowMesh.visible = true; });

const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(`shots/probe/${TAG}.png`, buf);

const stats = await page.evaluate(() => {
  const info = window.__game.pipeline.renderer.info;
  return { drawCalls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? 0 };
});
await browser.close();

const n = A.w * A.h;
let touched = 0, strong = 0, sum = 0, peak = 0;
let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
for (let p = 0; p < n; p++) {
  const o = p * 4;
  const d = Math.max(Math.abs(A.data[o] - B.data[o]), Math.abs(A.data[o + 1] - B.data[o + 1]),
    Math.abs(A.data[o + 2] - B.data[o + 2]));
  if (d > 3) {
    touched++; sum += d;
    const x = p % A.w, y = (p / A.w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (d > 24) strong++;
  if (d > peak) peak = d;
}
console.log(JSON.stringify({
  tag: TAG, stats,
  lights, frameTimeMs: { poolVisible: ftOn, poolHidden: ftOff },
  glowFootprint: {
    pixelsTouched: touched, pctOfFrame: +(100 * touched / n).toFixed(2),
    pixelsStrong: strong, pctStrong: +(100 * strong / n).toFixed(2),
    meanDelta: +(sum / Math.max(1, touched)).toFixed(1), peakDelta: peak,
    bbox: [minX, minY, maxX, maxY],
  },
  errors: logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')),
}, null, 2));
