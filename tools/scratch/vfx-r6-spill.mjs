#!/usr/bin/env node
/**
 * Does a ground pool actually TINT the tower standing in it?
 *
 * Builds one tower, parks a sustained nature/fire pool at its feet, and reads
 * back the mean colour of the tower's lower body with the ember light armed and
 * with it neutered. If the two are equal, the pool is still a sticker.
 *   node tools/scratch/vfx-r6-spill.mjs [family]
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const FAM = process.argv[2] || 'nature';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().split('\n')[0]); });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const setup = async (armed) => page.evaluate(async ({ fam, armed }) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
  if (!window.__spillReady) {
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    g.state.pendingElementPicks = 0; g.state.gold = 999999;
    g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
    g.build('earth', 12, 9);   // a neutral-coloured tower, so any tint is the pool's
    const t = g.towers.towers[0];
    g.rig.focus(t.x, t.z, 16); g.rig._polarGoal = 1.15;
    window.__spillT = t;
    window.__spillReady = 1;
    await wait(1500);
  }
  const t = window.__spillT;
  // Neuter or arm the sustained tier, then keep the pool topped up.
  const L = g.fx.lights;
  L.__armed = armed;
  if (!L.__patched) {
    const orig = L.ember.bind(L);
    L.ember = (...a) => { if (L.__armed) orig(...a); };
    L.__patched = 1;
  }
  for (const it of L.items) { it.peak = 0; it.light.intensity = 0; }
  const pump = () => g.fx.impactElemental(t.x + 0.9, 0.2, t.z + 0.9, fam, 1.6);
  for (let i = 0; i < 6; i++) { pump(); await wait(120); }
  await wait(120);
  for (const it of L.items) { it.peak = 0; it.light.intensity = 0; }   // kill flashes
  await wait(60);
  const cam = g.pipeline?.camera ?? g.camera;
  cam.updateMatrixWorld();
  const e = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
  const px = (x, y, z) => {
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    return [Math.round(((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * innerWidth),
            Math.round((1 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 + 0.5)) * innerHeight)];
  };
  return { body: px(t.x, 0.7, t.z), embers: L.embers.map(i => +i.light.intensity.toFixed(2)) };
}, { fam: FAM, armed });

const shot = async (armed, out) => {
  const info = await setup(armed);
  const buf = await page.screenshot({ type: 'png' });
  writeFileSync(out, buf);
  return info;
};
const on = await shot(true, `shots/vfx-r6-spill-on.png`);
const off = await shot(false, `shots/vfx-r6-spill-off.png`);
// Mean colour of a box around the tower's lower body, both frames.
const mean = await page.evaluate(async ([a, b, cx, cy]) => {
  const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  const out = [];
  for (const s of [a, b]) {
    const im = await load(s);
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(Math.max(0, cx - 45), Math.max(0, cy - 35), 90, 70).data;
    let r = 0, g = 0, bl = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bl += d[i + 2]; }
    const n = d.length / 4;
    out.push([+(r / n).toFixed(1), +(g / n).toFixed(1), +(bl / n).toFixed(1)]);
  }
  return out;
}, [`data:image/png;base64,${(await import('node:fs')).readFileSync('shots/vfx-r6-spill-on.png').toString('base64')}`,
    `data:image/png;base64,${(await import('node:fs')).readFileSync('shots/vfx-r6-spill-off.png').toString('base64')}`,
    on.body[0], on.body[1]]);
await browser.close();
console.log(JSON.stringify({ family: FAM, samplePx: on.body, emberOn: on.embers, emberOff: off.embers, meanWithLight: mean[0], meanWithout: mean[1], errs: [...new Set(errs)].slice(0, 3) }, null, 1));
