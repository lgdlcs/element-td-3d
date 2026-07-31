/**
 * `surround` costs 9.0ms (skytest.mjs). Is it the PROCEDURAL INJECTION in its
 * onBeforeCompile, or the PBR LIGHTING path of MeshStandardMaterial itself?
 *
 * The two answers imply opposite fixes:
 *   - injection  -> bake the procedural albedo/roughness to a texture at load,
 *                   keep MeshStandardMaterial, look is preserved exactly
 *   - PBR/lights -> baking changes nothing; the surround must stop being lit
 *                   geometry (unlit + baked lighting), which is a look change
 *
 * Three rungs, same geometry and draw calls throughout:
 *   1. as authored             (Standard + injection)
 *   2. plain Standard          (injection removed, lighting kept)
 *   3. Basic                   (unlit, no lighting at all)
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

const surroundMeshes = () => p.evaluate(() => {
  const root = window.__game.environment.group.children.find((c) => c.name === 'surround');
  let n = 0; root.traverse((o) => { if (o.isMesh || o.isInstancedMesh) n++; });
  return n;
});
console.log('surround meshes:', await surroundMeshes());

await p.waitForTimeout(900);
const base = await bench();
console.log(`\n1. as authored (Standard + injection)   ${String(base).padStart(6)}ms`);

// 2. Plain MeshStandardMaterial: same class, same lighting, NO injection.
//    Clone the authored material and clear onBeforeCompile + the cache key so
//    three.js compiles a genuinely different program (PITFALLS 11).
await p.evaluate(() => {
  const root = window.__game.environment.group.children.find((c) => c.name === 'surround');
  root.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh)) return;
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!o.__orig) o.__orig = o.material;
    const m = src.clone();
    m.onBeforeCompile = () => {};
    m.customProgramCacheKey = () => 'plain-standard';
    m.needsUpdate = true;
    o.material = m;
  });
});
await p.waitForTimeout(1400);
const plain = await bench();
console.log(`2. plain Standard (no injection)       ${String(plain).padStart(6)}ms   injection costs ${(base - plain).toFixed(1)}ms`);

// 3. Unlit.
await p.evaluate(() => {
  let ctor = null;
  window.__game.scene.traverse((o) => {
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && m.type === 'MeshBasicMaterial' && !ctor) ctor = m.constructor;
  });
  const cheap = new ctor({ color: 0x2a2f3a });
  const root = window.__game.environment.group.children.find((c) => c.name === 'surround');
  root.traverse((o) => { if (o.isMesh || o.isInstancedMesh) o.material = cheap; });
});
await p.waitForTimeout(1400);
const basic = await bench();
console.log(`3. unlit Basic                         ${String(basic).padStart(6)}ms   PBR lighting costs ${(plain - basic).toFixed(1)}ms`);
console.log(`\n   total recoverable from surround:    ${(base - basic).toFixed(1)}ms`);

await b.close();
