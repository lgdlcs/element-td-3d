import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
console.log(await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire','water','nature','earth','light','dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire','water','nature','earth','light','dark'];
  let n = 0, fails = [];
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3) {
      if (!g.grid.canPlaceTower(c, r) || g.path.wouldBlock(c, r)) continue;
      try { g.towers.create(keys[n % 6], 0, c, r); n++; }
      catch (e) { fails.push(e.message); }
    }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  await new Promise(r => setTimeout(r, 4000));
  const rr = g.pipeline.renderer.info.render;
  return JSON.stringify({ created: n, fails: fails.slice(0,3),
    towerCount: g.towers.towers?.length ?? g.towers.batch?._instUsed,
    lights: g.towers.batch.lights.length,
    calls: rr.calls, tris: rr.triangles }, null, 2);
}));
await b.close();
