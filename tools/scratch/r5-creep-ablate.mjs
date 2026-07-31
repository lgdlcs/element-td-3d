#!/usr/bin/env node
/**
 * Round 5 creep readability probe.
 *
 * Sets up the real `midgame` scenario, then captures a matrix of ablations of
 * the CREEP layer only (body / outline / xray / contact / healthbars), plus a
 * hue histogram of the board region weighted by chroma. Answers two questions
 * the round-4 probe never asked:
 *
 *   1. Which creep pass is actually producing the pixels on screen?
 *   2. Which hues are already spoken for by towers/terrain/VFX in a real frame?
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],
    ['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],
    ['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],
    ['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  g.state.wave = 21; g.state.gold = 4820; g.state.lives = 43; g.state.phase = 'combat';
  g.waves.start(22);
  await wait(3600);
  // FREEZE so every ablation photographs the identical instant.
  g.state.speed = 0; if (g.setSpeed) g.setSpeed(0);
  await wait(300);
});

const shot = async (name, setup) => {
  await page.evaluate((s) => {
    const g = window.__game;
    const C = g.creeps;
    const A = Object.values(C.archetypes);
    // restore everything first
    for (const a of A) { a.mesh.visible = true; a.outline.visible = true; a.xray.visible = true; }
    C.contact.mesh.visible = true;
    C.healthBars.mesh.visible = true;
    C.particles.mesh.visible = true;
    C.group.visible = true;
    if (s === 'nocreeps') C.group.visible = false;
    if (s === 'noxray') for (const a of A) a.xray.visible = false;
    if (s === 'nooutline') for (const a of A) a.outline.visible = false;
    if (s === 'nobody') for (const a of A) a.mesh.visible = false;
    if (s === 'nocontact') C.contact.mesh.visible = false;
    if (s === 'onlybody') { for (const a of A) { a.outline.visible = false; a.xray.visible = false; } C.contact.mesh.visible = false; }
  }, setup);
  await page.waitForTimeout(700);
  writeFileSync(`shots/r5-abl-${name}.png`, await page.screenshot({ type: 'png', timeout: 120000 }));
};

for (const n of ['base', 'nocreeps', 'noxray', 'nooutline', 'nobody', 'nocontact', 'onlybody']) {
  await shot(n, n);
}

// restore
await page.evaluate(() => {
  const C = window.__game.creeps;
  C.group.visible = true;
  for (const a of Object.values(C.archetypes)) { a.mesh.visible = true; a.outline.visible = true; a.xray.visible = true; }
  C.contact.mesh.visible = true;
});

const info = await page.evaluate(() => {
  const g = window.__game;
  const c = g.creeps, cam = g.rig?.camera ?? g.camera;
  cam.updateMatrixWorld(true);
  const V = new g.arena.group.position.constructor();
  const out = [];
  for (let k = 0; k < c._liveCount; k++) {
    const i = c._live[k];
    V.set(c.x[i], c.y[i] + 1, c.z[i]);
    V.project(cam);
    out.push({ t: c.typeKeys[c.typeIdx[i]],
      px: [Math.round((V.x * .5 + .5) * 1920), Math.round((-V.y * .5 + .5) * 1080)],
      groundY: +c.groundY[i].toFixed(2), y: +c.y[i].toFixed(2),
      scale: +c.scale[i].toFixed(2) });
  }
  return { creeps: out, alive: c.count,
    draws: g.pipeline.renderer.info.render.calls,
    tris: g.pipeline.renderer.info.render.triangles };
});
console.log(JSON.stringify(info, null, 1));
console.log('ERRORS', logs.slice(0, 10));
await browser.close();
