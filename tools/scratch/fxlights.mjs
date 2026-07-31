/**
 * Verifies the fx LightPool arm/disarm change, and specifically whether it
 * damages p95.
 *
 * The benchmark that found this lever measured it by hiding the six lights and
 * never letting them fire. That is the easy half. The shipped version toggles
 * `visible`, which makes three.js compile one program variant per distinct light
 * count — so the honest question is not "is the median better" (it must be) but
 * "does the first explosion of each variant stall the frame". The budget target
 * is 16.6 ms median AND 25 ms p95; a median win bought with a p95 regression is
 * not a win.
 *
 * So this measures three states on one build:
 *   A. idle, no fx firing            -> the steady-state median gain
 *   B. combat with projectiles landing, FIRST pass  -> pays every compile
 *   C. the same combat, SECOND pass   -> variants now cached
 * If B has a bad p95 and C does not, the cost is compilation and it can be
 * warmed up at load. If both are bad, the toggle is the wrong design.
 *
 * Pins pixelRatio to 1 and disables AdaptiveResolution: left enabled it spends
 * any saving on pixels instead of frame time and every row reads "no change".
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:5273/?q=high', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const gpu = await p.evaluate(() => {
  const gl = window.__game.pipeline.renderer.getContext();
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
if (/swiftshader|software/i.test(gpu)) { console.log('ABORT: software renderer', gpu); await b.close(); process.exit(1); }
console.log('GPU:', gpu);

const placed = await p.evaluate(async () => {
  const g = window.__game;
  g.pipeline.adaptive.enabled = false;
  g.pipeline.renderer.setPixelRatio(1);
  g.pipeline.resize();
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
  return n;
});
if (placed < 21) { console.log(`ABORT: only ${placed} towers`); await b.close(); process.exit(1); }

const buf = await p.evaluate(() => {
  const r = window.__game.pipeline.renderer;
  return `${r.domElement.width}x${r.domElement.height} pr=${r.getPixelRatio()}`;
});
console.log('buffer:', buf);

// How many point lights does three.js actually think exist right now?
const lights = () => p.evaluate(() => {
  let pts = 0, dirs = 0;
  window.__game.scene.traverse((o) => {
    if (!o.visible) return;
    if (o.isPointLight) pts++;
    else if (o.isDirectionalLight) dirs++;
  });
  return `${pts} visible point lights, ${dirs} visible directionals`;
});

const bench = (frames = 180) => p.evaluate((n) => new Promise((res) => {
  let i = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++i < n) requestAnimationFrame(tick);
    else {
      t.sort((a, c) => a - c);
      res({ med: +t[n >> 1].toFixed(2), p95: +t[Math.floor(n * 0.95)].toFixed(2), max: +t[n - 1].toFixed(2) });
    }
  };
  requestAnimationFrame(tick);
}), frames);

// --- A. idle: nothing firing, pool fully disarmed ---
await p.evaluate(() => { window.__game.state.phase = 'prep'; });
await p.waitForTimeout(2500);
console.log(`\nA idle          ${await lights()}`);
let r = await bench();
console.log(`  median ${String(r.med).padStart(6)}ms  p95 ${String(r.p95).padStart(6)}ms  max ${String(r.max).padStart(6)}ms`);

// --- B. combat, first pass: every light-count variant compiles for the first time ---
const fire = () => p.evaluate(async () => {
  const g = window.__game;
  g.state.phase = 'combat';
  // Drive the pool directly and hard, so all six slots arm in the window.
  for (let k = 0; k < 6; k++) {
    g.fx.explosion?.(-10 + k * 4, 1.0, k * 2 - 4, 3.5, 0xff8844);
    g.fx.muzzleFlash?.(-8 + k * 3, 1.4, k * 2, 0xffaa55, 1.6);
  }
});
await fire();
await p.waitForTimeout(120);
console.log(`\nB combat, 1st   ${await lights()}`);
const bFire = setInterval(() => fire().catch(() => {}), 220);
r = await bench();
console.log(`  median ${String(r.med).padStart(6)}ms  p95 ${String(r.p95).padStart(6)}ms  max ${String(r.max).padStart(6)}ms`);

// --- C. same combat, second pass: variants cached ---
r = await bench();
console.log(`\nC combat, 2nd   (variants now cached)`);
console.log(`  median ${String(r.med).padStart(6)}ms  p95 ${String(r.p95).padStart(6)}ms  max ${String(r.max).padStart(6)}ms`);
clearInterval(bFire);

// --- D. back to idle, to confirm the pool really disarms again ---
await p.evaluate(() => { window.__game.state.phase = 'prep'; });
await p.waitForTimeout(3000);
console.log(`\nD idle again    ${await lights()}`);
r = await bench();
console.log(`  median ${String(r.med).padStart(6)}ms  p95 ${String(r.p95).padStart(6)}ms  max ${String(r.max).padStart(6)}ms`);

console.log(errs.length ? `\nERRORS: ${errs.join('\n')}` : '\nno page errors');
await b.close();
