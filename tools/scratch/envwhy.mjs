/**
 * `environment` is 12.1ms of the 14.8ms that keeps `low` off 60 fps
 * (lowgap.mjs). Which child?
 *
 * Ablates the direct children of the environment group one at a time, then
 * cumulatively, and prints each one's screen-space footprint so a large cheap
 * object is not confused with a small expensive one.
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

console.log('--- children of `environment` ---');
console.log(await p.evaluate(() => {
  const env = window.__game.environment.group;
  return env.children.map((c, i) => {
    let meshes = 0, tris = 0;
    c.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh || o.isPoints) {
        meshes++;
        const g = o.geometry;
        if (g?.index) tris += g.index.count / 3;
        else if (g?.attributes?.position) tris += g.attributes.position.count / 3;
      }
    });
    return `${String(i).padStart(2)}  ${(c.name || c.type).padEnd(22)} ${String(meshes).padStart(4)} meshes ${String(Math.round(tris / 1000)).padStart(5)}k tri  visible=${c.visible}`;
  }).join('\n');
}));

const bench = () => p.evaluate(() => new Promise((res) => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a, c) => a - c); res(+t[70].toFixed(2)); }
  };
  requestAnimationFrame(tick);
}));

const count = await p.evaluate(() => window.__game.environment.group.children.length);

await p.waitForTimeout(900);
const base = await bench();
console.log(`\n--- CUMULATIVE (full pipeline, low) ---\nbaseline ${base}ms`);

for (let i = 0; i < count; i++) {
  const name = await p.evaluate((k) => {
    const c = window.__game.environment.group.children[k];
    c.__was = c.visible; c.visible = false;
    return c.name || c.type;
  }, i);
  await p.waitForTimeout(650);
  const ms = await bench();
  console.log(`  - ${name.padEnd(24)} ${String(ms).padStart(6)}ms   saves ${(base - ms).toFixed(1)}ms`);
  // NOT restored: cumulative.
}

await b.close();
