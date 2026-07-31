import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const out = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire','water','nature','earth','light','dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase='prep'; g.hud.refreshBuildBar();
  const MAZE=[['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of MAZE) g.build(k,c,r);
  g.state.phase='combat'; g.waves.start(22);
  await wait(3600); await wait(2500);
  const info = g.pipeline.renderer.info;
  const geo = {};
  for (const [k, a] of Object.entries(g.creeps.archetypes)) {
    geo[k] = a.mesh.geometry.attributes.position.count / 3;
  }
  const snap = () => ({ calls: info.render.calls, tris: info.render.triangles });
  const setShells = (v) => { for (const a of Object.values(g.creeps.archetypes)) { a.outline.visible = v; a.xray.visible = v; } };
  const setCreeps = (v) => { g.creeps.group.visible = v; };
  await wait(300); const all = snap();
  setShells(false); await wait(300); const noShells = snap();
  setShells(true); setCreeps(false); await wait(300); const noCreeps = snap();
  setCreeps(true);
  return { geoTris: geo, all, noShells, noCreeps, alive: g.creeps.count };
});
await browser.close();
console.log(JSON.stringify({ ...out, errs }, null, 2));
