#!/usr/bin/env node
/**
 * Ground truth for gate G4: where ARE the creeps on screen, and how big?
 * Captures the frame, then overlays a labelled marker on every alive creep's
 * projected position so a human/LLM can compare "what I can see" against
 * "what is actually there".
 *
 *   node tools/scratch/r4-probe.mjs --out shots/x.png [--scenario midgame] [--marks]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(arg('out', 'shots/r4-probe.png'));
const SCENARIO = arg('scenario', 'midgame');
const W = 1920, H = 1080;
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await page.evaluate(async ({ scenario, settle }) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of MAZE) g.build(k,c,r);
  g.state.wave = 21; g.state.gold = 4820; g.state.lives = 43; g.state.score = 128400;
  g.state.phase = 'combat';
  g.waves.start(Number(scenario) || 22);
  await wait(Number(settle));
}, { scenario: SCENARIO, settle: arg('ms', 2600) });

await page.waitForTimeout(400);

const info = await page.evaluate(({ W, H }) => {
  const g = window.__game;
  const cam = g.pipeline?.camera ?? g.camera ?? g.rig?.camera;
  const c = g.creeps;
  const out = [];
  for (let i = 0; i < c.capacity; i++) {
    if (!c.alive[i]) continue;
    const t = c.typeKeys[c.typeIdx[i]];
    out.push({ i, type: t, x: c.x[i], y: c.y[i], z: c.z[i], scale: c.scale[i], hp: c.hp[i] / c.maxHp[i] });
  }
  return { count: c.count, hud: document.body.innerText.match(/(\d+)\s*alive/)?.[1], creeps: out,
           camPos: [cam.position.x, cam.position.y, cam.position.z] };
}, { W, H });

// Project with the page's own THREE via the camera matrices.
const proj = await page.evaluate(({ pts }) => {
  const g = window.__game;
  const cam = g.pipeline?.camera ?? g.camera ?? g.rig?.camera;
  cam.updateMatrixWorld();
  const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
  const e = m.elements;
  const px = (x, y, z) => {
    const cx = e[0]*x + e[4]*y + e[8]*z + e[12];
    const cy = e[1]*x + e[5]*y + e[9]*z + e[13];
    const cw = e[3]*x + e[7]*y + e[11]*z + e[15];
    return [(cx/cw*0.5+0.5)*innerWidth, (1-(cy/cw*0.5+0.5))*innerHeight];
  };
  return pts.map((p) => {
    const foot = px(p.x, p.y, p.z);
    const head = px(p.x, p.y + p.h, p.z);
    return { ...p, sx: foot[0], sy: foot[1], hx: head[0], hy: head[1], px: Math.abs(foot[1]-head[1]) };
  });
}, { pts: info.creeps.map((c) => ({ ...c, h: 1.9 * c.scale })) });

if (argv.includes('--marks')) {
  await page.evaluate((pts) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none';
    d.innerHTML = pts.map((p, n) => `<div style="position:absolute;left:${p.sx}px;top:${p.sy}px;transform:translate(-50%,-50%);width:56px;height:56px;border:2px solid #ff00ff;border-radius:50%"></div><div style="position:absolute;left:${p.sx + 30}px;top:${p.sy}px;color:#ff00ff;font:bold 14px monospace">${n + 1} ${p.type}</div>`).join('');
    document.body.appendChild(d);
  }, proj);
  await page.waitForTimeout(150);
}

const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(OUT, buf);
const stats = await page.evaluate(() => {
  const i = window.__game.pipeline.renderer.info;
  return { drawCalls: i.render.calls, triangles: i.render.triangles, programs: i.programs?.length ?? 0 };
});
await browser.close();
console.log(JSON.stringify({ out: OUT, hudAlive: info.count, stats,
  creeps: proj.map((p) => ({ i: p.i, type: p.type, sx: Math.round(p.sx), sy: Math.round(p.sy), pxHeight: Math.round(p.px), hp: +p.hp.toFixed(2) })),
  errors: logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')) }, null, 2));
