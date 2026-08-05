/**
 * Lever table AT PRESET `low` — the preset a weak machine actually gets.
 *
 * Every lever run in this project so far was measured at `high`, where MSAA,
 * GTAO and DOF dominate. None of those exist at `low`, so none of those numbers
 * transfer. The question here is different: once the post stack is already
 * gone, what is left, and can any of it be taken away?
 *
 * MEASUREMENT SHAPE, and why it is not one-page-per-arm
 * ----------------------------------------------------
 * The first version of this probe opened a fresh page per arm and ran them in
 * sequence. Its two baselines came out at 61.2 ms and 32.7 ms — 28.5 ms of
 * drift across the run, larger than almost every lever it was trying to size —
 * and `notowers` reported a NEGATIVE saving of 43 ms, which is impossible for
 * an arm that only hides geometry. That is the signature of a machine whose
 * available GPU time changed underneath the run, and it makes every row void.
 *
 * So each arm is now A/B/A on ONE page against ONE scenario: baseline, arm,
 * baseline. The reported cost is the arm against the MEAN of its own two
 * surrounding baselines, and the spread between those two baselines is printed
 * next to it. A row whose bracket spread exceeds its effect is marked NOISE and
 * must not be believed.
 *
 * Adaptive resolution is disabled and pixelRatio pinned to 1: a controller that
 * trades pixels for milliseconds absorbs every lever under test and reports
 * that they all cost the same.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const FRAMES = 150;

/**
 * Every arm is {on, off} so it can be reverted in place. Written as source
 * strings and injected once, because they run in the page.
 */
const ARMS = `window.__arms = {
  nocomposer: {
    on() {
      const p = window.__game.pipeline;
      p.__realRender = p.render;
      p.render = function () {
        this.renderer.info.reset();
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.scene, this.camera);
      };
    },
    off() { const p = window.__game.pipeline; p.render = p.__realRender; },
  },
  nopost: {
    keys: ['gtao','bloom','dof','grade','smaa'],
    on() { const p = window.__game.pipeline; this.saved = {};
      for (const k of this.keys) if (p.passes[k]) { this.saved[k] = p.passes[k].enabled; p.passes[k].enabled = false; } },
    off() { const p = window.__game.pipeline;
      for (const k in this.saved) p.passes[k].enabled = this.saved[k]; },
  },
  noshadow: {
    on() { const r = window.__game.pipeline.renderer; this.s = r.shadowMap.enabled; r.shadowMap.enabled = false;
           window.__game.scene.traverse(o => { if (o.isLight && o.castShadow) { o.castShadow = false; o.__hadShadow = true; } }); },
    off() { const r = window.__game.pipeline.renderer; r.shadowMap.enabled = this.s;
            window.__game.scene.traverse(o => { if (o.__hadShadow) { o.castShadow = true; delete o.__hadShadow; } }); },
  },
  nofxlights: {
    all() { const fx = window.__game.fx; return [...fx.lights.items, ...fx.lights.embers].map(i => i.light); },
    // A getter/setter that SWALLOWS writes, not a read-only value. LightPool
    // .update() assigns light.visible every frame; a non-writable property makes
    // that assignment throw in strict mode, which kills the frame loop. The run
    // then reports 16.7 ms — vsync over a frozen scene — for this arm and every
    // arm after it, which looks exactly like a huge win. It is not one.
    on() { for (const l of this.all()) {
             Object.defineProperty(l, 'visible', { get: () => false, set() {}, configurable: true }); } },
    off() { for (const l of this.all()) { delete l.visible; l.visible = false; } },
  },
  onelight: {
    on() { this.hid = []; const keep = [];
      window.__game.scene.traverse(o => { if (o.isDirectionalLight && o.castShadow) keep.push(o); });
      window.__game.scene.traverse(o => {
        if (o.isLight && !keep.includes(o) && o.visible) { o.visible = false; this.hid.push(o); } }); },
    off() { for (const o of this.hid) o.visible = true; },
  },
  flatground: {
    on() { const g = window.__game.arena.ground; if (!g) throw new Error('no arena.ground');
      let ctor = null;
      window.__game.scene.traverse(o => { if (!ctor && o.material && o.material.isMeshBasicMaterial) ctor = o.material.constructor; });
      if (!ctor) throw new Error('no MeshBasicMaterial to clone a ctor from');
      this.old = g.material; g.material = new ctor({ color: 0x5a6a4a }); },
    off() { window.__game.arena.ground.material = this.old; },
  },
  noenv: {
    on() { const g = window.__game.environment.group; this.v = g.visible; g.visible = false; },
    off() { window.__game.environment.group.visible = this.v; },
  },
  noground: {
    on() { const g = window.__game.arena.group; this.v = g.visible; g.visible = false; },
    off() { window.__game.arena.group.visible = this.v; },
  },
  notowers: {
    on() { const g = window.__game.towers.group; this.v = g.visible; g.visible = false; },
    off() { window.__game.towers.group.visible = this.v; },
  },
};`;

const bench = (page) => page.evaluate((n) => new Promise((res) => {
  let i = 0, t0 = performance.now(); const times = [];
  const tick = () => {
    const t = performance.now(); times.push(t - t0); t0 = t;
    if (++i < n) requestAnimationFrame(tick);
    else {
      times.sort((a, c) => a - c);
      const r = window.__game.pipeline.renderer.info.render;
      res({ median: +times[n >> 1].toFixed(2), p95: +times[Math.floor(n * 0.95)].toFixed(2), calls: r.calls });
    }
  };
  requestAnimationFrame(tick);
}), FRAMES);

const settle = (page) => page.waitForTimeout(1200);

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
let pageErr = null;
p.on('pageerror', (e) => { pageErr = e.message; });
await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(() => {
  const pl = window.__game.pipeline;
  pl.adaptive.enabled = false;
  pl.renderer.setPixelRatio(1);
  pl.resize();
});

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
  if (n < 21) throw new Error(`only ${n}/21 towers placed`);
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 8000));
});

await p.addScriptTag({ content: ARMS });
const names = await p.evaluate(() => Object.keys(window.__arms));

console.log(`preset low, 1600x900, dpr 1, adaptive off, 21 towers + wave 21, ${FRAMES} frames/cell, A/B/A per arm\n`);
console.log('arm           arm ms   p95    saves   bracket   verdict');

// Wave 21 empties as creeps die. A cell measured against a nearly empty board
// is a different scenario, so top it up before every cell.
const keepAlive = async () => p.evaluate(async () => {
  const g = window.__game;
  if (g.creeps._liveCount < 12) { g.waves.start(21); await new Promise((r) => setTimeout(r, 2500)); }
});

// A dead frame loop reports 16.7 ms — vsync over a frozen scene — which reads
// as the largest win in the table. Refuse to print anything after one.
const assertLive = async (where) => {
  if (pageErr) { console.log(`\nABORTED at ${where}: frame loop threw: ${pageErr}`); process.exit(1); }
  const moving = await p.evaluate(() => new Promise((res) => {
    const t = window.__game.tElapsed ?? window.__game.pipeline.renderer.info.render.frame;
    setTimeout(() => res((window.__game.tElapsed ?? window.__game.pipeline.renderer.info.render.frame) !== t), 300);
  }));
  if (!moving) { console.log(`\nABORTED at ${where}: frame loop is not advancing`); process.exit(1); }
};

for (const name of names) {
  await keepAlive();
  await assertLive(`${name} (before)`);
  const a1 = await bench(p);
  await p.evaluate((n) => window.__arms[n].on(), name);
  await settle(p);
  const arm = await bench(p);
  await p.evaluate((n) => window.__arms[n].off(), name);
  await settle(p);
  await assertLive(`${name} (after)`);
  const a2 = await bench(p);

  const base = (a1.median + a2.median) / 2;
  const bracket = Math.abs(a1.median - a2.median);
  const saves = base - arm.median;
  const verdict = bracket >= Math.abs(saves) ? 'NOISE' : (saves > 2 ? 'real' : 'tiny');
  console.log(
    `${name.padEnd(12)} ${String(arm.median).padStart(7)} ${String(arm.p95).padStart(6)} ` +
    `${saves.toFixed(1).padStart(7)}ms ${bracket.toFixed(1).padStart(7)}ms   ${verdict}` +
    `   (base ${a1.median}/${a2.median})`,
  );
}
await p.close();
await b.close();
