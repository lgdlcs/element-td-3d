/**
 * Is there a fixed per-frame floor, or is the cost shared between groups?
 *
 * overdraw.mjs reported that hiding `environment`, `arena` OR `towers`
 * individually each saved 22.9ms and each landed on the SAME 40.8ms. Costs that
 * additive-attribution cannot explain: you cannot save the same 23ms three
 * times. Either there is a large fixed floor, or the three groups shade the
 * same pixels and whichever survives repays the fill on its own.
 *
 * This hides groups CUMULATIVELY, so the last row is a genuinely empty scene.
 * A large number on the empty row is a floor that no amount of art reduction
 * will ever touch — and that changes what is worth optimising.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 8000));
  window.__game.pipeline.composer.passes.forEach((x) => {
    if (x.constructor.name !== 'RenderPass') x.enabled = false;
  });
});

const bench = () => p.evaluate(() => new Promise((res) => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a, c) => a - c); res(+t[70].toFixed(2)); }
  };
  requestAnimationFrame(tick);
}));

const stats = () => p.evaluate(() => {
  const r = window.__game.pipeline.renderer.info.render;
  return { calls: r.calls, tris: r.triangles };
});

await p.waitForTimeout(900);
let ms = await bench();
let s = await stats();
console.log(`baseline                    ${String(ms).padStart(6)}ms  ${String(s.calls).padStart(4)} calls ${String(Math.round(s.tris / 1000)).padStart(5)}k tri`);

const GROUPS = ['fx', 'creeps', 'towers', 'environment', 'arena'];
let hidden = [];
for (const key of GROUPS) {
  hidden.push(key);
  const ok = await p.evaluate((k) => {
    const g = window.__game; const grp = g[k]?.group || g[k];
    if (!grp || !('visible' in grp)) return false;
    grp.visible = false; return true;
  }, key);
  if (!ok) { console.log(`  no group: ${key}`); continue; }
  await p.waitForTimeout(700);
  ms = await bench(); s = await stats();
  console.log(`- ${hidden.join('+').padEnd(25)} ${String(ms).padStart(6)}ms  ${String(s.calls).padStart(4)} calls ${String(Math.round(s.tris / 1000)).padStart(5)}k tri`);
}

// Everything hidden. Whatever remains is renderer + shadow + clear.
await p.evaluate(() => { window.__game.pipeline.renderer.shadowMap.enabled = false; });
await p.waitForTimeout(900);
ms = await bench(); s = await stats();
console.log(`- everything + no shadow    ${String(ms).padStart(6)}ms  ${String(s.calls).padStart(4)} calls ${String(Math.round(s.tris / 1000)).padStart(5)}k tri`);

await b.close();
