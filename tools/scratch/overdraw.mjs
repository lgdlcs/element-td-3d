/**
 * Where do the 85ms of scene-only render time go?
 *
 * 788k triangles in 159 draw calls should cost ~2ms on an M1. Measuring 85ms
 * means each pixel is being shaded many times over - stacked translucent
 * layers, each one repaying the full framebuffer. Attribute it by hiding
 * groups one at a time with post disabled, so nothing downstream can mask the
 * result.
 *
 * Also counts, per object, the screen-space area of every transparent mesh, to
 * turn "overdraw" from a hypothesis into a number.
 */
import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
p.on('console', m => { const t=m.text(); if(/THREE.WebGLProgram|shader|GLSL|ERROR:/i.test(t)) console.log('[SHADER]', t.slice(0,400)); });
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
  g.waves.start(21);
  await new Promise(r => setTimeout(r, 8000));
  // Post off for the whole run: measure the scene, nothing else.
  window.__game.pipeline.composer.passes.forEach(x => {
    if (x.constructor.name !== 'RenderPass') x.enabled = false; });
});

// Inventory of transparent / blended meshes, biggest first.
console.log('--- transparent meshes, by world-space footprint ---');
console.log(await p.evaluate(() => {
  const out = [];
  window.__game.scene.traverse(o => {
    if (!o.visible || !(o.isMesh || o.isInstancedMesh)) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    const m = ms[0]; if (!m) return;
    if (!m.transparent && m.blending === 1 && m.depthWrite !== false) return;
    o.geometry?.computeBoundingBox?.();
    const bb = o.geometry?.boundingBox; if (!bb) return;
    const w = (bb.max.x - bb.min.x) * o.scale.x, h = (bb.max.z - bb.min.z) * o.scale.z;
    const v = (bb.max.y - bb.min.y) * o.scale.y;
    out.push({ name: o.name || o.type, area: Math.round(Math.max(w * h, w * v)),
               blend: m.blending, dw: m.depthWrite, tr: !!m.transparent });
  });
  out.sort((a, c) => c.area - a.area);
  return out.slice(0, 18).map(x =>
    `${String(x.area).padStart(8)} u²  blend=${x.blend} depthWrite=${x.dw} transparent=${x.tr}  ${x.name}`).join('\n');
}));

const bench = () => p.evaluate(() => new Promise(res => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => { const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a,c)=>a-c); res(+t[70].toFixed(2)); } };
  requestAnimationFrame(tick);
}));

const GROUPS = ['environment', 'arena', 'towers', 'creeps', 'fx'];
await p.waitForTimeout(900);
const base = await bench();
console.log(`\n--- scene only (post off) ---\nbaseline                       ${String(base).padStart(6)}ms  ${(1000/base).toFixed(0).padStart(3)}fps`);

for (const key of GROUPS) {
  const ok = await p.evaluate(k => {
    const g = window.__game;
    const grp = g[k]?.group || g[k];
    if (!grp || !('visible' in grp)) return false;
    grp.__wasVisible = grp.visible; grp.visible = false; return true;
  }, key);
  if (!ok) { console.log(`  - ${key.padEnd(28)} (no such group)`); continue; }
  await p.waitForTimeout(700);
  const ms = await bench();
  console.log(`  - ${key.padEnd(28)} ${String(ms).padStart(6)}ms   saves ${(base-ms).toFixed(1)}ms`);
  await p.evaluate(k => { const g = window.__game; const grp = g[k]?.group || g[k];
    grp.visible = grp.__wasVisible ?? true; }, key);
  await p.waitForTimeout(400);
}

// Shadow map, measured with post off so it is not hidden behind GTAO.
await p.evaluate(() => { window.__game.pipeline.renderer.shadowMap.enabled = false;
  window.__game.scene.traverse(o => { if (o.material)
    (Array.isArray(o.material)?o.material:[o.material]).forEach(m => m.needsUpdate = true); }); });
await p.waitForTimeout(1200);
const noShadow = await bench();
console.log(`  - shadow map${' '.repeat(18)} ${String(noShadow).padStart(6)}ms   saves ${(base-noShadow).toFixed(1)}ms`);
await b.close();
