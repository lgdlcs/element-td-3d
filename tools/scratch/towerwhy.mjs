/**
 * 21 towers cost 40ms. Removing 64 per-fragment hash evaluations from their
 * shader changed nothing, so the cost is not the procedural detail and not ALU.
 * Substitute the material wholesale to find what it actually is.
 *
 *   basic          - no lighting, no shadows, no PBR. Isolates everything the
 *                    lighting model does from everything geometry does.
 *   standard bare  - full PBR, zero custom injections. Splits "our shader" from
 *                    "three's shader".
 *   depth-only     - colorWrite off. Leaves rasterisation and depth alone.
 */
import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire','water','nature','earth','light','dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire','water','nature','earth','light','dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  await new Promise(r => setTimeout(r, 6000));
  window.__game.pipeline.composer.passes.forEach(x => {
    if (x.constructor.name !== 'RenderPass') x.enabled = false; });
  window.__tb = null;
  g.scene.traverse(o => { if (o.name === 'towerBatch') window.__tb = o; });
  window.__orig = window.__tb.material;
});

const bench = () => p.evaluate(() => new Promise(res => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => { const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a,c)=>a-c); res(+t[70].toFixed(2)); } };
  requestAnimationFrame(tick);
}));

const step = async (label, fn) => {
  if (fn) await p.evaluate(fn);
  await p.waitForTimeout(1400);
  const ms = await bench();
  console.log(label.padEnd(34), String(ms).padStart(6) + 'ms');
  return ms;
};

const base = await step('baseline (our tower material)');
await step('  hidden entirely', () => { window.__tb.visible = false; });
await step('  visible again', () => { window.__tb.visible = true; });

await step('  MeshBasicMaterial (no lighting)', () => {
  const THREE = window.__tb.material.constructor.__proto__ ? null : null;
  const m = new window.__game.constructor.__THREE__.MeshBasicMaterial({ color: 0x888888 });
  window.__tb.material = m;
});
await step('  restore', () => { window.__tb.material = window.__orig; });

await step('  colorWrite off (raster+depth only)', () => {
  window.__orig.colorWrite = false; window.__orig.needsUpdate = true; });
await step('  restore', () => { window.__orig.colorWrite = true; window.__orig.needsUpdate = true; });

await step('  castShadow off', () => { window.__tb.castShadow = false; });
await step('  + receiveShadow off', () => { window.__tb.receiveShadow = false;
  window.__orig.needsUpdate = true; });
await step('  restore both', () => { window.__tb.castShadow = true;
  window.__tb.receiveShadow = true; window.__orig.needsUpdate = true; });

console.log('\nlights in scene:', await p.evaluate(() => {
  const out = [];
  window.__game.scene.traverse(o => { if (o.isLight && o.visible)
    out.push(o.type + (o.castShadow ? '(shadow)' : '')); });
  return out.join(', ');
}));
await b.close();
