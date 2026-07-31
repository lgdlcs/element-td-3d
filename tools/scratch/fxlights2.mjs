/**
 * Paired, same-session measurement of the fx LightPool arm/disarm change.
 *
 * The first attempt (fxlights.mjs) was unsound in ways worth recording:
 *   - it benched "idle" immediately after placing 21 towers, and each placement
 *     fires dust + a muzzle flash, so the pool was still fully armed and the row
 *     measured the OLD behaviour while claiming to measure the new one;
 *   - it counted point lights by scene traversal, which cannot tell an fx pool
 *     light from a tower or portal light;
 *   - it compared against a baseline from a different run.
 *
 * This version instruments the pool itself, waits for genuine decay, and gets
 * both states from ONE page session by forcing every slot visible (the old
 * behaviour) and then letting them disarm again. Same build, same scenario,
 * minutes apart: the only comparison this project accepts.
 *
 * Compile stalls are reported separately via `max`, because a program variant
 * compiling for the first time can produce a multi-second frame and that must
 * never be averaged into a median and called a cost.
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

console.log('GPU:', await p.evaluate(() => {
  const gl = window.__game.pipeline.renderer.getContext();
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
}));

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
  // wave 21 MUST be live: the benchmark that produced the +24.9ms figure ran
  // this scenario, and a first attempt at this probe omitted it and measured a
  // 57.8ms scene against a 82.1ms claim — a different scene, not a refutation.
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 9000));   // let placement fx fully decay
  return n;
});
if (placed < 21) { console.log(`ABORT: only ${placed} towers`); await b.close(); process.exit(1); }

// Locate the pool and expose exact counts.
const pool = await p.evaluate(() => {
  const lp = window.__game.fx?.lights;
  if (!lp) return null;
  window.__pool = lp;
  return { flash: lp.items.length, ember: lp.embers.length };
});
if (!pool) { console.log('ABORT: could not find fx.lights'); await b.close(); process.exit(1); }
console.log(`pool: ${pool.flash} flash + ${pool.ember} ember = ${pool.flash + pool.ember} point lights`);

const armed = () => p.evaluate(() => {
  const lp = window.__pool;
  const a = lp.items.filter((i) => i.light.visible).length;
  const e = lp.embers.filter((i) => i.light.visible).length;
  return `${a + e}/${lp.items.length + lp.embers.length} pool lights visible`;
});

const bench = (n = 200) => p.evaluate((frames) => new Promise((res) => {
  let i = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++i < frames) requestAnimationFrame(tick);
    else {
      t.sort((a, c) => a - c);
      res({ med: +t[frames >> 1].toFixed(2), p95: +t[Math.floor(frames * 0.95)].toFixed(2), max: +t[frames - 1].toFixed(2) });
    }
  };
  requestAnimationFrame(tick);
}), n);

const row = async (label) => {
  const r = await bench();
  console.log(`  ${label.padEnd(34)} median ${String(r.med).padStart(6)}ms  p95 ${String(r.p95).padStart(6)}ms  max ${String(r.max).padStart(7)}ms`);
  return r;
};

// Warm every light-count variant BEFORE measuring anything, so no row is
// contaminated by a first-use compile.
console.log('\nwarming program variants (arming and disarming the whole pool)...');
await p.evaluate(async () => {
  const lp = window.__pool;
  const all = [...lp.items, ...lp.embers].map((i) => i.light);
  for (let k = 0; k <= all.length; k++) {
    all.forEach((l, j) => { l.visible = j < k; l.intensity = j < k ? 2 : 0; });
    window.__game.pipeline.renderer.compile(window.__game.scene, window.__game.camera);
    await new Promise((r) => requestAnimationFrame(r));
  }
  all.forEach((l) => { l.visible = false; l.intensity = 0; });
});
await p.waitForTimeout(1500);

// --- OLD behaviour: every slot permanently visible at intensity 0 ---
await p.evaluate(() => {
  const lp = window.__pool;
  [...lp.items, ...lp.embers].forEach((i) => { i.light.visible = true; i.light.intensity = 0; });
  // Stop update() from disarming them again for the duration of this row.
  window.__pin = setInterval(() => {
    [...lp.items, ...lp.embers].forEach((i) => { i.light.visible = true; });
  }, 16);
});
await p.waitForTimeout(1800);
console.log(`\nOLD  all slots visible at intensity 0   (${await armed()})`);
const before = await row('idle');

// --- NEW behaviour: spent slots disarmed ---
await p.evaluate(() => {
  clearInterval(window.__pin);
  const lp = window.__pool;
  [...lp.items, ...lp.embers].forEach((i) => { i.light.visible = false; i.light.intensity = 0; i.t = i.dur; });
});
await p.waitForTimeout(1800);
console.log(`\nNEW  spent slots disarmed               (${await armed()})`);
const after = await row('idle');

// --- NEW behaviour under sustained combat: worst realistic case ---
const fire = () => p.evaluate(() => {
  const g = window.__game;
  for (let k = 0; k < 4; k++) {
    g.fx.explosion?.(-10 + k * 5, 1.0, k * 3 - 4, 3.5, 0xff8844);
    g.fx.muzzleFlash?.(-8 + k * 4, 1.4, k * 3, 0xffaa55, 1.6);
  }
}).catch(() => {});
const iv = setInterval(fire, 200);
await p.waitForTimeout(1500);
console.log(`\nNEW  sustained combat, pool cycling     (${await armed()})`);
const combat = await row('firing continuously');

// --- OLD behaviour under the SAME combat load ---------------------------
// Without this row the comparison is old-at-idle vs new-in-combat, which makes
// the new code look like a p95 regression when the two rows differ by the entire
// fx particle load rather than by the change under test.
await p.evaluate(() => {
  const lp = window.__pool;
  window.__pin = setInterval(() => {
    [...lp.items, ...lp.embers].forEach((i) => { i.light.visible = true; });
  }, 16);
});
await p.waitForTimeout(1200);
console.log(`\nOLD  same combat load, slots pinned on  (${await armed()})`);
const combatOld = await row('firing continuously');
await p.evaluate(() => clearInterval(window.__pin));
clearInterval(iv);

console.log(`\n--- result -------------------------------------------------`);
console.log(`idle median   ${before.med} -> ${after.med} ms   saves ${(before.med - after.med).toFixed(1)} ms`);
console.log(`idle p95      ${before.p95} -> ${after.p95} ms   saves ${(before.p95 - after.p95).toFixed(1)} ms`);
console.log(`under the SAME heavy fx load, old vs new:`);
console.log(`  combat median ${combatOld.med} -> ${combat.med} ms   p95 ${combatOld.p95} -> ${combat.p95} ms`);
console.log(combat.p95 > combatOld.p95 + 2
  ? `REGRESSION: the new code is worse under load; variant switching is costing more than the lights save.`
  : `No regression under load: arming on demand is never worse than pinning every slot on.`);
console.log(errs.length ? `\nERRORS: ${errs.join('\n')}` : 'no page errors');
await b.close();
