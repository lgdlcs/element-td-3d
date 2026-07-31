// Measures the real idle vs firing emissive multiplier across a live combat second.
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = []; p.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;' }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const out = await p.evaluate(async () => {
  const g = window.__game; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5], ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7], ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9], ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11], ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15], ['dark', 14, 15]];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  await wait(1500);
  // idle sample (no creeps yet)
  let idleMin = 1e9, idleMax = -1e9;
  for (let s = 0; s < 30; s++) { for (const t of g.towers.towers) { idleMin = Math.min(idleMin, t.pulse); idleMax = Math.max(idleMax, t.pulse); } await wait(33); }
  g.state.phase = 'combat'; g.waves.start(22);
  await wait(3000);
  let fireMax = -1e9, lightMax = 0;
  for (let s = 0; s < 120; s++) {
    for (const t of g.towers.towers) fireMax = Math.max(fireMax, t.pulse);
    for (const sl of g.towers.batch.lights) lightMax = Math.max(lightMax, sl.light.intensity);
    await wait(16);
  }
  // hero core emissive: fire crown rock is emis * 2.1
  const spec = g.towers.towers[0].spec;
  let batched = 0, meshes = 0;
  g.towers.group.traverse((o) => { if (o.isMesh) meshes++; if (o.isBatchedMesh) batched++; });
  return {
    idleMin: +idleMin.toFixed(3), idleMax: +idleMax.toFixed(3), fireMax: +fireMax.toFixed(3),
    ratio: +(fireMax / idleMin).toFixed(2),
    lightMax: +lightMax.toFixed(1),
    meshes, batched,
    calls: g.pipeline.renderer.info.render.calls, tris: g.pipeline.renderer.info.render.triangles,
    heights: g.towers.towers.slice(0, 6).map((t) => ({ k: t.key, h: +t.spec.height.toFixed(2), mult: +(t.spec.height / 4).toFixed(2) })),
  };
});
console.log(JSON.stringify({ out, errors: logs }, null, 2));
await b.close();
