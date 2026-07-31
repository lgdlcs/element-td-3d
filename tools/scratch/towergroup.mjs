/**
 * Hiding towers.group saves 40.5ms. Hiding the towerBatch mesh inside it saves
 * 3.1ms. So ~37ms belongs to something else living in that group, and every
 * conclusion drawn about "tower shader cost" was attributed to the wrong object.
 * Enumerate the group and ablate its children one at a time.
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
  g.pipeline.composer.passes.forEach(x => { if (x.constructor.name !== 'RenderPass') x.enabled = false; });
});

console.log('--- children of towers.group ---');
console.log(await p.evaluate(() => window.__game.towers.group.children.map((c, i) => {
  const m = Array.isArray(c.material) ? c.material[0] : c.material;
  const tri = c.geometry?.index ? c.geometry.index.count / 3
            : c.geometry?.attributes?.position ? c.geometry.attributes.position.count / 3 : 0;
  return `${String(i).padStart(2)} ${(c.name || c.type).padEnd(22)} ${c.type.padEnd(14)} vis=${c.visible} tri=${Math.round(tri)}`
       + (m ? ` mat=${m.type} transparent=${!!m.transparent} blend=${m.blending} depthWrite=${m.depthWrite}` : '');
}).join('\n')));

const bench = () => p.evaluate(() => new Promise(res => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => { const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a,c)=>a-c); res(+t[70].toFixed(2)); } };
  requestAnimationFrame(tick);
}));

await p.waitForTimeout(1200);
const base = await bench();
console.log(`\nbaseline${' '.repeat(26)}${String(base).padStart(6)}ms`);

const count = await p.evaluate(() => window.__game.towers.group.children.length);
for (let i = 0; i < count; i++) {
  const name = await p.evaluate(j => {
    const c = window.__game.towers.group.children[j];
    c.__w = c.visible; c.visible = false; return c.name || c.type;
  }, i);
  await p.waitForTimeout(800);
  const ms = await bench();
  console.log(`  - [${String(i).padStart(2)}] ${name.padEnd(24)} ${String(ms).padStart(6)}ms   saves ${(base-ms).toFixed(1)}ms`);
  await p.evaluate(j => { const c = window.__game.towers.group.children[j]; c.visible = c.__w ?? true; }, i);
  await p.waitForTimeout(400);
}

// The payoff: all eight at once. Each dynamic light adds one iteration of the
// per-fragment lighting loop to EVERY lit pixel in the scene, so they are the
// scene's cost, not the towers'.
await p.evaluate(() => { window.__game.towers.group.children.forEach(c => {
  if (c.isPointLight) { c.__w = c.visible; c.visible = false; } }); });
await p.waitForTimeout(1500);
const noLights = await bench();
console.log(`\nall 8 PointLights off        ${String(noLights).padStart(6)}ms   saves ${(base-noLights).toFixed(1)}ms  (${(1000/noLights).toFixed(0)}fps)`);

// And with the post stack back on, which is how it actually ships.
await p.evaluate(() => { window.__game.pipeline.composer.passes.forEach(x => x.enabled = true); });
await p.waitForTimeout(1500);
const withPost = await bench();
console.log(`  + full post stack back on  ${String(withPost).padStart(6)}ms   (${(1000/withPost).toFixed(0)}fps)`);
await b.close();
