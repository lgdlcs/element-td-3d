/** Capture the same frame with fx hidden, and dump fx particle world bounds. */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 18; r += 3)
    for (let c = 4; c < 22 && n < 18; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 9000));
});

const info = await p.evaluate(() => {
  const g = window.__game;
  const out = { fx: [], decals: null, towerGlow: null };
  g.fx.group.children.forEach((o, i) => {
    const pos = o.geometry?.attributes?.position;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, live = 0;
    if (pos) {
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k);
        if (!isFinite(x) || (x === 0 && y === 0 && z === 0)) continue;
        live++; minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    out.fx.push({ i, name: o.name || o.type, count: pos?.count ?? 0, live, x: [minX, maxX].map(v => +v.toFixed(1)), z: [minZ, maxZ].map(v => +v.toFixed(1)) });
  });
  const dm = g.fx.decals?.mesh ?? g.fx.decalSystem?.mesh;
  if (dm) out.decals = { count: dm.count, name: dm.name };
  const gm = g.towers.batch?.glowMesh;
  if (gm) out.towerGlow = { count: gm.count ?? gm.instanceCount, visible: gm.visible, name: gm.name };
  return out;
});
console.log(JSON.stringify(info, null, 2));

await p.waitForTimeout(500);
writeFileSync('shots/diag-row-base.png', await p.screenshot({ type: 'png', timeout: 120000 }));
await p.evaluate(() => { window.__game.fx.group.visible = false; });
await p.waitForTimeout(900);
writeFileSync('shots/diag-row-nofx.png', await p.screenshot({ type: 'png', timeout: 120000 }));
await p.evaluate(() => { window.__game.fx.group.visible = true; window.__game.towers.batch.glowMesh.visible = false; });
await p.waitForTimeout(900);
writeFileSync('shots/diag-row-noglow.png', await p.screenshot({ type: 'png', timeout: 120000 }));
await b.close();
console.log('wrote diag-row-{base,nofx,noglow}.png');
