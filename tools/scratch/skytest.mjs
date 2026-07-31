/**
 * Is the off-board area expensive because of PER-PIXEL SHADER COST, or because
 * of coverage/geometry?
 *
 * envwhy.mjs showed sky and surround trade the same pixels: hiding either alone
 * saves nothing, hiding both saves ~10ms. That is consistent with an expensive
 * shader on whichever layer wins the depth test — but it is ALSO consistent with
 * several other stories, and the last time this project reasoned from
 * instruction count ("Sky.js: 15 fbm3 calls!") it optimised the wrong material
 * and bought 1.2ms of 41.7 (see PERF_BUDGET.md, "What did not work").
 *
 * So: substitute, don't count. Swap the material for MeshBasicMaterial, which
 * shades a pixel in ~nothing, and keep the geometry, the draw call and the
 * coverage identical. If the time goes away, the cost is the shader and baking
 * it is worth doing. If it does not, the shader is innocent again.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
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

// Swap materials on a named child subtree, keeping geometry + draw calls.
const swap = (names) => p.evaluate((ns) => {
  const THREE = window.__game.__THREE || null;
  const env = window.__game.environment.group;
  let n = 0;
  for (const name of ns) {
    const root = env.children.find((c) => c.name === name);
    if (!root) continue;
    root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh)) return;
      if (!o.__origMat) o.__origMat = o.material;
      const src = Array.isArray(o.__origMat) ? o.__origMat[0] : o.__origMat;
      // Build a trivial material of the same class family via the object's own
      // constructor chain — no THREE import available in page scope.
      const cheap = new src.constructor.prototype.constructor === undefined ? null : null;
      o.material = window.__cheapMat;
      o.material.side = src.side;
      o.material.transparent = src.transparent;
      o.material.depthWrite = src.depthWrite;
      o.material.blending = src.blending;
      n++;
    });
  }
  return n;
}, names);

// Make one shared MeshBasicMaterial using an existing material's constructor.
await p.evaluate(() => {
  // Any MeshBasicMaterial in the scene gives us the class without an import.
  let ctor = null;
  window.__game.scene.traverse((o) => {
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && m.type === 'MeshBasicMaterial' && !ctor) ctor = m.constructor;
  });
  if (!ctor) {
    // Fall back: clone any material and strip it to a constant output.
    const any = window.__game.environment.group.children[0];
    let m0 = null;
    any.traverse((o) => { if (!m0 && o.material) m0 = Array.isArray(o.material) ? o.material[0] : o.material; });
    ctor = m0.constructor;
  }
  window.__cheapMat = new ctor({ color: 0x2a2f3a });
  window.__cheapMatType = window.__cheapMat.type;
});
console.log('cheap material type:', await p.evaluate(() => window.__cheapMatType));

await p.waitForTimeout(900);
const base = await bench();
console.log(`\nbaseline (low, full pipeline)          ${String(base).padStart(6)}ms`);

const n1 = await swap(['sky']);
await p.waitForTimeout(900);
const s1 = await bench();
console.log(`sky -> trivial material (${String(n1).padStart(2)} meshes)   ${String(s1).padStart(6)}ms   saves ${(base - s1).toFixed(1)}ms`);

for (const name of ['surround', 'breach', 'ground-fog', 'motes']) {
  const k = await swap([name]);
  await p.waitForTimeout(900);
  const s = await bench();
  console.log(`+ ${name.padEnd(12)} -> trivial (${String(k).padStart(2)} meshes)  ${String(s).padStart(6)}ms   cumulative saves ${(base - s).toFixed(1)}ms`);
}

await b.close();
