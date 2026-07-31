/**
 * The two experiments the fan-out said must run before any further planning.
 *
 * EXPERIMENT 1 — do lights and MSAA interact?
 *
 * They are the two large levers that are plausibly independent: one is ALU per
 * lit fragment, the other is bytes per pass. Every number so far comes from
 * single-recipe pairings, so "look-free path = 37-45 ms" is extrapolation. On
 * this scene that has burned us before: sky alone was free, surround alone was
 * free, both together were 10 ms.
 *
 * A single before/after cannot answer it. This runs the full 2x2:
 *
 *              lights disarmed      lights pinned on
 *   MSAA 4x         R1                    R2
 *   MSAA off        R3                    R4
 *
 *   light saving without MSAA change = R2 - R1
 *   light saving with MSAA off       = R4 - R3
 *   equal  -> additive, the levers stack and 37-45 ms is real
 *   R4-R3 much smaller -> they overlap, and the combined estimate is too
 *                         optimistic by the difference
 *
 * MSAA is removed by dropping both composer buffers to samples=0, which is the
 * A3/D4 mechanism (+23.5 / +23.4, cross-checked). A2 — MSAA confined to the
 * scene render — is the shippable, look-free version and shares the mechanism;
 * A3 is used here because it is applicable at runtime and gives a bigger, and
 * therefore cleaner, signal for an interaction test.
 *
 * EXPERIMENT 2 — how expensive is the lit off-board decor, really?
 *
 * This is the single largest unmeasured term in the residual. The fan-out recipe
 * meant to size it looked for `window.THREE`, did not find it, and silently fell
 * back to moving albedo into emissive — which leaves the lighting loop compiled
 * in and measures nothing. Its 31.2 ms is void. This does a REAL swap to a
 * genuine MeshBasicMaterial (constructor recovered from a material already in
 * the scene, which is how tools/scratch/skytest.mjs did it successfully) against
 * the untouched baseline, not stacked on top of the light ablations.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const setup = async (p) => {
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  await p.goto('http://localhost:5273/?q=high', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
  const gpu = await p.evaluate(() => {
    const gl = window.__game.pipeline.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  if (/swiftshader|software/i.test(gpu)) throw new Error(`software renderer: ${gpu}`);
  const n = await p.evaluate(async () => {
    const g = window.__game;
    g.pipeline.adaptive.enabled = false;
    g.pipeline.renderer.setPixelRatio(1);
    g.pipeline.resize();
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    g.state.gold = 999999; g.hud.closeElementPicker?.();
    const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    let k = 0;
    for (let r = 4; r < 14 && k < 21; r += 3)
      for (let c = 4; c < 22 && k < 21; c += 3)
        if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[k % 6], 0, c, r); k++; }
    g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
    g.waves.start(21);
    window.__pool = g.fx.lights;
    await new Promise((r) => setTimeout(r, 9000));
    return k;
  });
  if (n < 21) throw new Error(`only ${n} towers placed`);
  const buf = await p.evaluate(() => {
    const r = window.__game.pipeline.renderer;
    return `${r.domElement.width}x${r.domElement.height} pr=${r.getPixelRatio()}`;
  });
  return { gpu, buf };
};

const bench = (p, frames = 200) => p.evaluate((n) => new Promise((res) => {
  let i = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++i < n) requestAnimationFrame(tick);
    else {
      t.sort((a, c) => a - c);
      res({ med: +t[n >> 1].toFixed(2), p95: +t[Math.floor(n * 0.95)].toFixed(2) });
    }
  };
  requestAnimationFrame(tick);
}), frames);

// Reproduces the OLD behaviour exactly: slot visible, intensity 0.
//
// Setting `visible = true` from an interval does NOT work and a previous run
// proved it — LightPool.update() runs inside the rAF callback, after the
// interval, and disarms the slot again, so the pinned cells measured 0 visible
// lights while claiming 6. Instead of racing the disarm, remove its trigger:
// `dur = Infinity` makes `t >= dur` permanently false, so update() never
// disarms, and with `peak = 0` it computes intensity = 0 * 1 = 0.
const PIN_ON = () => {
  const lp = window.__pool;
  const hold = () => [...lp.items, ...lp.embers].forEach((i) => {
    i.light.visible = true; i.peak = 0; i.dur = Infinity; i.t = 0;
  });
  hold();
  window.__pin = setInterval(hold, 16);
};
// Must be an INTERVAL, symmetric to PIN_ON. A one-shot disarm is undone within
// milliseconds: wave 21 is live, towers are firing, and every muzzle flash and
// impact re-arms a slot. A first run of this probe used a one-shot and printed
// poolVisible=6/6 on all four cells — the factorial never varied the factor it
// claimed to, which is exactly why it produced negative light costs.
const PIN_OFF = () => {
  clearInterval(window.__pin);
  const lp = window.__pool;
  window.__pin = setInterval(() => {
    [...lp.items, ...lp.embers].forEach((i) => { i.light.visible = false; i.light.intensity = 0; i.t = i.dur; });
  }, 16);
};
const MSAA_OFF = () => {
  const c = window.__game.pipeline.composer;
  for (const rt of [c.renderTarget1, c.renderTarget2]) { rt.samples = 0; rt.dispose(); }
  return `${c.renderTarget1.samples}/${c.renderTarget2.samples}`;
};

const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });

// ---------------- EXPERIMENT 1: 2x2 factorial ----------------
console.log('=== EXPERIMENT 1: do lights and MSAA interact? ===');
const cells = {};
// Each cell gets a FRESH page: applying MSAA_OFF is not reversible, and
// measuring R1 after R3 in one session would compare different GPU states.
for (const [key, msaaOff, pinned] of [
  ['R1', false, false], ['R2', false, true],
  ['R3', true, false], ['R4', true, true],
]) {
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const info = await setup(p);
  if (key === 'R1') console.log(`GPU: ${info.gpu}\nbuffer: ${info.buf}\n`);

  // Warm every light-count program variant so no cell pays a first-use compile.
  await p.evaluate(async () => {
    const all = [...window.__pool.items, ...window.__pool.embers].map((i) => i.light);
    for (let k = 0; k <= all.length; k++) {
      all.forEach((l, j) => { l.visible = j < k; l.intensity = j < k ? 2 : 0; });
      window.__game.pipeline.renderer.compile(window.__game.scene, window.__game.camera);
      await new Promise((r) => requestAnimationFrame(r));
    }
    all.forEach((l) => { l.visible = false; l.intensity = 0; });
  });

  if (msaaOff) await p.evaluate(MSAA_OFF);
  await p.evaluate(pinned ? PIN_ON : PIN_OFF);
  await p.waitForTimeout(2500);

  const state = await p.evaluate(() => {
    const c = window.__game.pipeline.composer;
    const lp = window.__pool;
    const on = [...lp.items, ...lp.embers].filter((i) => i.light.visible).length;
    return `samples=${c.renderTarget1.samples} poolVisible=${on}/6 buf=${window.__game.pipeline.renderer.domElement.width}x${window.__game.pipeline.renderer.domElement.height}`;
  });
  const r = await bench(p);
  cells[key] = r;
  // Re-read the pool AFTER benching: the condition has to have held for the
  // whole measurement window, not just at the moment it was set.
  const held = await p.evaluate(() => {
    const lp = window.__pool;
    return [...lp.items, ...lp.embers].filter((i) => i.light.visible).length;
  });
  const wanted = pinned ? 6 : 0;
  const bad = held !== wanted ? `  *** INVALID: wanted ${wanted} visible, held ${held} ***` : '';
  console.log(`${key}  MSAA ${msaaOff ? 'off' : ' 4x'}  lights ${pinned ? 'pinned on ' : 'disarmed  '}  median ${String(r.med).padStart(6)}ms  p95 ${String(r.p95).padStart(6)}ms   [${state} after=${held}]${bad}${errs.length ? '  ERR ' + errs[0] : ''}`);
  if (bad) cells[key].invalid = true;
  await p.close();
}

if (Object.values(cells).some((c) => c.invalid)) {
  console.log('\nABORTING ANALYSIS: at least one cell did not hold its condition for the');
  console.log('whole measurement window. No interaction conclusion can be drawn.');
  await b.close();
  process.exit(1);
}
const lightNoMsaa = cells.R2.med - cells.R1.med;
const lightWithMsaa = cells.R4.med - cells.R3.med;
const msaaSaving = cells.R2.med - cells.R4.med;
console.log(`\nlight cost with MSAA 4x     ${lightNoMsaa.toFixed(1)} ms   (R2 - R1)`);
console.log(`light cost with MSAA off    ${lightWithMsaa.toFixed(1)} ms   (R4 - R3)`);
console.log(`MSAA cost, lights pinned    ${msaaSaving.toFixed(1)} ms   (R2 - R4)`);
const overlap = lightNoMsaa - lightWithMsaa;
console.log(overlap > 2
  ? `\nTHEY OVERLAP by ${overlap.toFixed(1)} ms. Combining them saves ${(cells.R2.med - cells.R3.med).toFixed(1)} ms, NOT ${(lightNoMsaa + msaaSaving).toFixed(1)} ms.`
  : `\nADDITIVE within noise (${overlap.toFixed(1)} ms). Combined saving ${(cells.R2.med - cells.R3.med).toFixed(1)} ms is real.`);
console.log(`best measured configuration: ${cells.R3.med} ms median / ${cells.R3.p95} ms p95`);

// ---------------- EXPERIMENT 2: lit off-board decor ----------------
console.log('\n=== EXPERIMENT 2: real unlit swap on the surround ===');
{
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await setup(p);
  await p.evaluate(PIN_OFF);
  await p.waitForTimeout(2200);
  const base = await bench(p);
  console.log(`baseline (untouched)                     median ${String(base.med).padStart(6)}ms  p95 ${String(base.p95).padStart(6)}ms`);

  const swap = await p.evaluate(() => {
    // Recover a real MeshBasicMaterial constructor from the live scene. The
    // fan-out recipe looked for window.THREE, failed, and silently fell back to
    // an emissive hack that leaves the lighting loop compiled in — which is why
    // its number was void.
    let ctor = null;
    window.__game.scene.traverse((o) => {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!ctor && m && m.type === 'MeshBasicMaterial') ctor = m.constructor;
    });
    if (!ctor) return { ok: false, why: 'no MeshBasicMaterial in scene to borrow a constructor from' };
    const root = window.__game.environment.group.children.find((c) => c.name === 'surround');
    if (!root) return { ok: false, why: 'no surround group' };
    let swapped = 0, lit = 0;
    root.traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh)) return;
      const src = Array.isArray(o.material) ? o.material[0] : o.material;
      if (src && /Standard|Physical|Lambert|Phong/.test(src.type)) lit++;
      const m = new ctor({ color: 0x39404c });
      m.side = src?.side ?? 0;
      o.material = m;
      swapped++;
    });
    return { ok: true, swapped, lit, type: new ctor().type };
  });
  if (!swap.ok) console.log(`  SWAP FAILED: ${swap.why} — the number below would be meaningless, aborting`);
  else {
    console.log(`  swapped ${swap.swapped} meshes (${swap.lit} were lit) to real ${swap.type}`);
    await p.waitForTimeout(2500);
    const r = await bench(p);
    console.log(`surround truly unlit                     median ${String(r.med).padStart(6)}ms  p95 ${String(r.p95).padStart(6)}ms   saves ${(base.med - r.med).toFixed(1)}ms median`);
  }
  if (errs.length) console.log(`  ERRORS: ${errs[0]}`);
  await p.close();
}

await b.close();
