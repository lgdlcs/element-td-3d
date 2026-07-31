#!/usr/bin/env node
/**
 * Seam inspector (terrain round 4b).
 *
 * The joint between the board's retaining wall and the environment agent's
 * surround is the single most likely place in the frame for a G9 artefact, and
 * at gameplay framing it is 6 pixels tall behind a HUD panel. This drives the
 * live rig onto it, optionally hides the HUD, and captures.
 *
 *   node tools/scratch/r4b-seam.mjs --out shots/x.png --fx 0 --fz 22 \
 *        --dist 18 --polar 0.60 --azim 0 --hud 0
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(arg('out', 'shots/seam.png'));
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const cfg = {
  fx: +arg('fx', 0), fz: +arg('fz', 22), dist: +arg('dist', 18),
  polar: +arg('polar', 0.60), azim: +arg('azim', 0), hud: arg('hud', '0') === '1',
  js: arg('js', ''),
};

await page.evaluate(async (c) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let n = 0; n < 200 && document.getElementById('boot'); n++) await wait(150);
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
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
  for (const [k, cc, r] of MAZE) g.build(k, cc, r);
  g.state.wave = 21;
  if (!c.hud) for (const el of document.querySelectorAll('#ui, #hud, .hud, #app > div')) {
    if (!el.querySelector('canvas')) el.style.display = 'none';
  }
  await wait(1600);
  // CameraRig.#clampTarget() keeps the board on screen, which is exactly what
  // stops the rig from ever looking AT the rim. Take the camera off the rig.
  g.rig.update = () => {};
  const cam = g.rig.camera;
  const sp = Math.sin(c.polar);
  cam.position.set(c.fx + Math.sin(c.azim) * sp * c.dist,
    Math.cos(c.polar) * c.dist,
    c.fz + Math.cos(c.azim) * sp * c.dist);
  cam.lookAt(c.fx, 0, c.fz);
  cam.updateMatrixWorld();
  await wait(700);
  if (c.js) eval(c.js);
  await wait(600);
}, cfg);

await page.waitForTimeout(500);
const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(OUT, buf);
const stats = await page.evaluate(() => {
  const i = window.__game.pipeline.renderer.info;
  return { drawCalls: i.render.calls, triangles: i.render.triangles };
});
await browser.close();
console.log(JSON.stringify({ out: OUT, stats, errors: logs.filter((l) => /\[error\]|\[pageerror\]/.test(l)) }, null, 1));
