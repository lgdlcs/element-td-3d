#!/usr/bin/env node
/**
 * VFX round-6 ablation. Midgame scenario, then evaluates an arbitrary
 * expression against `g` before screenshotting.
 *   node tools/scratch/vfx-r6-abl.mjs "g.fx.decals.glow.mesh.visible=false" out.png
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [EXPR = '', OUT = 'shots/vfx-r6-abl.png'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const info = await page.evaluate(async (expr) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
  g.state.elements = ['fire','water','nature','earth','light','dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase='prep'; g.hud.refreshBuildBar();
  const MAZE=[['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of MAZE) g.build(k,c,r);
  g.state.wave=21; g.state.gold=4820; g.state.lives=43; g.state.score=128400;
  g.state.phase='combat'; g.waves.start(22);
  await wait(3600);
  let evalErr = null;
  if (expr) { try { (new Function('g', expr))(g); } catch (e) { evalErr = String(e); } }
  await wait(600);
  const r = g.pipeline.renderer.info;
  return { calls: r.render.calls, tris: r.render.triangles, programs: r.programs.length, live: g.fx.liveCount, evalErr };
}, EXPR);
const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(resolve(OUT), buf);
await browser.close();
console.log(JSON.stringify({ expr: EXPR, out: OUT, ...info, errs: errs.slice(0, 10) }, null, 2));
