import { chromium } from 'playwright';
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
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  await new Promise((r) => setTimeout(r, 5000));
  g.state.paused = true;
});
const dump = (tag) => p.evaluate((t) => {
  const g = window.__game;
  const out = { tag: t, group: [] };
  const root = g.towers.batch ? g.towers.batch.group : (g.towers.group || g.towers.root);
  out.rootName = root?.name; out.rootVisible = root?.visible;
  root.traverse((o) => { if (!o.isPointLight) out.group.push({ n: o.name || o.type, vis: o.visible, cs: o.castShadow, cnt: o.isBatchedMesh ? o._instanceInfo?.filter((i)=>i.visible).length : undefined }); });
  const casters = [];
  g.scene.traverse((o) => { if (o.castShadow && (o.isMesh || o.isBatchedMesh || o.isInstancedMesh)) casters.push(o.name || o.type); });
  out.casters = casters;
  out.type = g.pipeline.renderer.shadowMap.type;
  return out;
}, tag);
console.log(JSON.stringify(await dump('before'), null, 1));
await p.evaluate(() => {
  const g = window.__game;
  const root = g.towers.batch ? g.towers.batch.group : (g.towers.group || g.towers.root);
  root.traverse((o) => { if (o.isMesh || o.isBatchedMesh || o.isInstancedMesh) o.castShadow = false; });
});
await p.waitForTimeout(1500);
console.log(JSON.stringify(await dump('after'), null, 1));
await p.screenshot({ path: 'shots/shadow/why-after.png' });
await b.close();
