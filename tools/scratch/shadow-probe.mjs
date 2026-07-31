/**
 * Do towers actually cast shadows onto the board?
 *
 * All three round-7 critics, independently and as their #2/#3 defect: "no
 * directional shadow anywhere on the cobbles", "towers cast no readable cast
 * shadow onto the tiles", "towers, enemies and props all cast nothing".
 *
 * I dismissed the same complaint in rounds 5 and 6 because tower shadows were
 * plainly visible then. Two things changed in round 7: towers lost ~40% of
 * their height, and the board albedo dropped ~3x. So measure, do not argue.
 *
 * The decisive test is ablation: if disabling the shadow map changes the board
 * pixels by ~nothing, then no shadows are being drawn on it, whatever the
 * settings claim. This is the PITFALLS §8 class — a feature nobody can see is
 * a feature that may not exist.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/shadow', { recursive: true });

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
});

// What does the rig actually say?
console.log('rig:', JSON.stringify(await p.evaluate(() => {
  const g = window.__game;
  const r = g.pipeline.renderer;
  const out = { shadowMapEnabled: r.shadowMap.enabled, type: r.shadowMap.type, casters: 0, lights: [] };
  g.scene.traverse((o) => { if (o.castShadow && (o.isMesh || o.isBatchedMesh || o.isInstancedMesh)) out.casters++; });
  g.scene.traverse((o) => {
    if (o.isDirectionalLight) out.lights.push({
      name: o.name || 'dir', intensity: +o.intensity.toFixed(2), castShadow: o.castShadow,
      mapSize: o.shadow?.mapSize?.x, radius: o.shadow?.radius,
      cam: o.shadow?.camera ? [o.shadow.camera.left, o.shadow.camera.right,
                               o.shadow.camera.top, o.shadow.camera.bottom] : null,
    });
  });
  return out;
}), null, 2));

/** Mean/変動 over a crop of the board floor only. */
const boardStats = async (file) => {
  await p.waitForTimeout(800);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/shadow/${file}`, buf);
  return p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(400, 250, 1150, 650).data;   // board floor region
    const L = [];
    for (let i = 0; i < px.length; i += 4)
      L.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    const mean = L.reduce((a, c) => a + c, 0) / L.length;
    const sd = Math.sqrt(L.reduce((a, c) => a + (c - mean) ** 2, 0) / L.length);
    return { mean: +mean.toFixed(1), sd: +sd.toFixed(1) };
  }, buf.toString('base64'));
};

const on = await boardStats('a-shadows-on.png');
console.log('shadows ON  (board crop):', JSON.stringify(on));

await p.evaluate(() => {
  const r = window.__game.pipeline.renderer;
  r.shadowMap.enabled = false;
  // Force every material to recompile without the shadow branch.
  window.__game.scene.traverse((o) => { if (o.material) {
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
  } });
});
const off = await boardStats('b-shadows-off.png');
console.log('shadows OFF (board crop):', JSON.stringify(off));

console.log('\n--- verdict ---');
const dMean = Math.abs(on.mean - off.mean), dSd = Math.abs(on.sd - off.sd);
console.log(`delta mean ${dMean.toFixed(1)} L, delta sd ${dSd.toFixed(1)}`);
console.log(dMean < 2.0 && dSd < 2.0
  ? 'CRITICS ARE RIGHT: disabling shadows barely changes the board. Almost nothing is being cast onto it.'
  : 'Shadows ARE being cast on the board; the complaint is about their READ (contrast/softness), not their existence.');
await b.close();
