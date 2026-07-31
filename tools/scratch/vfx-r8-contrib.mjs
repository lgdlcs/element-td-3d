/**
 * What does the VFX layer actually put on the plate, now that the frame is 3x
 * brighter and the bloom threshold is 2.05?
 *
 * Paired on ONE build (PITFALLS §12): full frame vs the same frame with the fx
 * layer suppressed, minutes apart, same page, same seed. Reports the area the
 * layer pushes into each luminance band and how much of the tower cluster it
 * covers.
 *
 *   node tools/scratch/vfx-r8-contrib.mjs [midgame|barrage] [tag]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const SCENARIO = process.argv[2] ?? 'midgame';
const TAG = process.argv[3] ?? 'x';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/vfx-r8/contrib', { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async (scenario) => {
  const g = window.__game;
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  if (scenario === 'barrage') {
    const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark',
                  'steam', 'magma', 'ice', 'poison', 'void', 'magic',
                  'blaze', 'crystal', 'life', 'mud', 'abyss', 'gaia'];
    let n = 0;
    for (let r = 3; r <= 17 && n < 34; r += 2)
      for (let c = 6; c <= 18 && n < 34; c += 2) { g.build(keys[n % keys.length], c, r); n++; }
    for (const t of g.towers.towers) { g.state.gold = 999999; g.towers.upgrade(t.id); }
    g.state.wave = 34; g.state.phase = 'combat';
    g.waves.start(35);
    await new Promise((r) => setTimeout(r, 4500));
  } else {
    const MAZE = [
      ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
      ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
      ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
      ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
      ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
      ['dark', 14, 15],
    ];
    for (const [k, c, r] of MAZE) g.build(k, c, r);
    g.state.wave = 21; g.state.phase = 'combat';
    g.waves.start(22);
    await new Promise((r) => setTimeout(r, 3600));
  }
}, SCENARIO);

const grab = async (file) => {
  await p.waitForTimeout(600);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/vfx-r8/contrib/${file}`, buf);
  return buf.toString('base64');
};

const A = await grab(`${TAG}-${SCENARIO}-full.png`);
const drawA = await p.evaluate(() => ({
  dc: window.__game.pipeline.renderer.info.render.calls,
  tri: window.__game.pipeline.renderer.info.render.triangles,
  live: window.__game.fx.liveCount,
}));

await p.evaluate(() => {
  const f = window.__game.fx;
  f.group.visible = false;
  f.decals.glow.mesh.visible = false; f.decals.mark.mesh.visible = false;
  f.arcs.mesh.visible = false; f.muzzleRibbons.mesh.visible = false;
  for (const it of [...f.lights.items, ...f.lights.embers]) { it.peak = 0; it.light.intensity = 0; }
  f.muzzleFlash = () => {}; f.impactCore = () => {}; f.lightning = () => {};
});
const B = await grab(`${TAG}-${SCENARIO}-nofx.png`);

const r = await p.evaluate(async ([a, bb]) => {
  const load = async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    return cx.getImageData(380, 250, 1180, 700);
  };
  const A = (await load(a)).data, B = (await load(bb)).data;
  const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
  let n = 0, sumA = 0, sumB = 0;
  let clipA = 0, clipB = 0;            // pure-white clip (all channels > 248)
  let hotA = 0, hotB = 0;              // L > 235
  let covered = 0;                     // pixels fx raised by more than 25 L
  let heavy = 0;                       // pixels fx raised by more than 60 L
  let desatA = 0;                      // fx pixels whose saturation collapsed
  const LA = [];
  for (let i = 0; i < A.length; i += 4) {
    const la = lum(A, i), lb = lum(B, i);
    n++; sumA += la; sumB += lb; LA.push(la);
    if (A[i] > 248 && A[i + 1] > 248 && A[i + 2] > 248) clipA++;
    if (B[i] > 248 && B[i + 1] > 248 && B[i + 2] > 248) clipB++;
    if (la > 235) hotA++;
    if (lb > 235) hotB++;
    if (la - lb > 25) {
      covered++;
      const mx = Math.max(A[i], A[i + 1], A[i + 2]), mn = Math.min(A[i], A[i + 1], A[i + 2]);
      if (mx === 0 || (mx - mn) / mx < 0.10) desatA++;
    }
    if (la - lb > 60) heavy++;
  }
  LA.sort((x, y) => x - y);
  return {
    meanFull: +(sumA / n).toFixed(1), meanNoFx: +(sumB / n).toFixed(1),
    p99: +LA[Math.floor(0.99 * n)].toFixed(0),
    clipPctFull: +(100 * clipA / n).toFixed(3), clipPctNoFx: +(100 * clipB / n).toFixed(3),
    hotPctFull: +(100 * hotA / n).toFixed(2), hotPctNoFx: +(100 * hotB / n).toFixed(2),
    fxCoverPct: +(100 * covered / n).toFixed(2),
    fxHeavyPct: +(100 * heavy / n).toFixed(2),
    fxDesatPctOfCover: covered ? +(100 * desatA / covered).toFixed(1) : 0,
  };
}, [A, B]);

console.log(SCENARIO, TAG, JSON.stringify({ ...r, ...drawA }, null, 1));
await b.close();
