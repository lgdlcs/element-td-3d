#!/usr/bin/env node
/**
 * Creep ablation capture. Proves WHICH creep layer produces which pixels.
 *   node tools/scratch/r4-abl.mjs <mode> out.png
 * modes: all | nobody | noshell | noxray | nooutline | onlycontact | nocontact
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [MODE = 'all', OUT = 'shots/r4-abl.png'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const info = await page.evaluate(async (mode) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire','water','nature','earth','light','dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase='prep'; g.hud.refreshBuildBar();
  const MAZE=[['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of MAZE) g.build(k,c,r);
  g.state.wave=21; g.state.gold=4820; g.state.lives=43; g.state.score=128400;
  g.state.phase='combat'; g.waves.start(22);
  await wait(3600); await wait(2200);
  const A = Object.values(g.creeps.archetypes);
  const set = (k, v) => { for (const a of A) a[k].visible = v; };
  if (mode === 'nobody') set('mesh', false);
  if (mode === 'noshell') { set('outline', false); set('xray', false); }
  if (mode === 'noxray') set('xray', false);
  if (mode === 'nooutline') set('outline', false);
  if (mode === 'nocontact') g.creeps.contact.mesh.visible = false;
  if (mode === 'onlyxray') { set('mesh', false); set('outline', false); g.creeps.contact.mesh.visible = false; g.creeps.healthBars.mesh.visible = false; }
  if (mode === 'onlycontact') { set('mesh', false); set('outline', false); set('xray', false); g.creeps.healthBars.mesh.visible = false; }
  await wait(500);
  const c = g.creeps;
  const cam = g.pipeline?.camera ?? g.camera ?? g.rig?.camera;
  cam.updateMatrixWorld();
  const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse); const e = m.elements;
  const out = [];
  for (let i = 0; i < c.capacity; i++) {
    if (!c.alive[i]) continue;
    const x = c.x[i], y = c.y[i], z = c.z[i];
    const cw = e[3]*x + e[7]*y + e[11]*z + e[15];
    out.push({ i, type: c.typeKeys[c.typeIdx[i]],
      sx: Math.round(((e[0]*x+e[4]*y+e[8]*z+e[12])/cw*0.5+0.5)*innerWidth),
      sy: Math.round((1-((e[1]*x+e[5]*y+e[9]*z+e[13])/cw*0.5+0.5))*innerHeight) });
  }
  const r = g.pipeline.renderer.info;
  return { alive: c.count, creeps: out, calls: r.render.calls, tris: r.render.triangles };
}, MODE);
const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(resolve(OUT), buf);
await browser.close();
console.log(JSON.stringify({ mode: MODE, out: OUT, ...info, errs }, null, 2));
