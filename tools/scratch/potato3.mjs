/**
 * Decisive, ABSOLUTE-number probe. Answers three questions the delta-only runs
 * could not, in one session on one page.
 *
 * WHY THIS EXISTS
 *
 * potato2.mjs reported that hiding the composer, the shadows, the backdrop, the
 * ground fog, the motes and every secondary light AT ONCE saves 4.4 ms, with a
 * spread of 0.7 ms across three cycles — i.e. tightly measured and tiny. Taken
 * at face value that kills every art-side lever at `low` at once. But it prints
 * only DELTAS, so it cannot distinguish "these levers are worthless" from "every
 * cell in this run was already at the vsync clamp, where all deltas are 0"
 * (PERF_BUDGET: 16.7 ms is vsync, and every rAF-interval probe saturates there).
 *
 * So this one prints the absolute median of every cell, and includes:
 *   - a FLOOR cell (scene emptied entirely) to locate the vsync clamp, and
 *   - a resolution sweep, because cost is known to be linear in pixel area on
 *     this renderer, so a cell that does NOT move with resolution is not
 *     measuring the renderer at all.
 *
 * Read the output as: if `floor` is ~16.7 and the baselines are far above it,
 * the numbers are real. If everything sits near 16.7, the run is void.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const FRAMES = 150;

const SETUP = `window.__t = {
  potatoOn() {
    const g = window.__game, p = g.pipeline;
    p.__realRender = p.render;
    p.render = function () {
      this.renderer.info.reset();
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    };
    const r = p.renderer; this.s = r.shadowMap.enabled; r.shadowMap.enabled = false;
    g.scene.traverse(o => { if (o.isLight && o.castShadow) { o.castShadow = false; o.__hadShadow = true; } });
    this.hid = [];
    const hide = (o) => { if (o && o.visible) { o.visible = false; this.hid.push(o); } };
    hide(g.environment.backdrop.group);
    hide(g.environment.groundFog.mesh);
    hide(g.environment.motes.points);
    g.scene.traverse(o => { if (o.isLight && !o.__hadShadow && !o.isAmbientLight) hide(o); });
  },
  potatoOff() {
    const g = window.__game, p = g.pipeline;
    p.render = p.__realRender; delete p.__realRender;
    p.renderer.shadowMap.enabled = this.s;
    g.scene.traverse(o => { if (o.__hadShadow) { o.castShadow = true; delete o.__hadShadow; } });
    for (const o of this.hid) o.visible = true;
    this.hid = [];
  },
  floorOn() {
    const g = window.__game;
    this.fhid = [];
    for (const grp of [g.environment.group, g.arena.group, g.towers.group, g.fx.group]) {
      if (grp && grp.visible) { grp.visible = false; this.fhid.push(grp); }
    }
    if (g.creeps.mesh && g.creeps.mesh.visible) { g.creeps.mesh.visible = false; this.fhid.push(g.creeps.mesh); }
  },
  floorOff() { for (const o of this.fhid) o.visible = true; this.fhid = []; },
  dpr(v) {
    const p = window.__game.pipeline;
    p.renderer.setPixelRatio(v);
    p.resize();
  },
};`;

const bench = (page) => page.evaluate((n) => new Promise((res) => {
  let i = 0, t0 = performance.now(); const times = [];
  const tick = () => {
    const t = performance.now(); times.push(t - t0); t0 = t;
    if (++i < n) requestAnimationFrame(tick);
    else {
      times.sort((a, c) => a - c);
      const gl = window.__game.pipeline.renderer.getContext();
      const r = window.__game.pipeline.renderer.info.render;
      res({
        median: +times[n >> 1].toFixed(1), p95: +times[Math.floor(n * 0.95)].toFixed(1),
        buf: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`, calls: r.calls, tris: r.triangles,
      });
    }
  };
  requestAnimationFrame(tick);
}), FRAMES);

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
let pageErr = null;
p.on('pageerror', (e) => { pageErr = e.message; });
await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => { window.__game.pipeline.adaptive.enabled = false; });

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
await p.addScriptTag({ content: SETUP });

const topUp = () => p.evaluate(async () => {
  const g = window.__game;
  if (g.creeps._liveCount < 12) { g.waves.start(21); await new Promise((r) => setTimeout(r, 2500)); }
});

const CELLS = [
  ['base   dpr1.0', 1.0, null],
  ['potato dpr1.0', 1.0, 'potato'],
  ['floor  dpr1.0', 1.0, 'floor'],
  ['base   dpr0.5', 0.5, null],
  ['potato dpr0.5', 0.5, 'potato'],
  ['base   dpr1.5', 1.5, null],
  ['base   dpr1.0 (repeat)', 1.0, null],
];

console.log('preset low, viewport 1600x900, adaptive OFF, 21 towers + wave 21, absolute medians\n');
console.log('cell                     median     p95    buffer      calls    tris');

for (const [label, dpr, arm] of CELLS) {
  await topUp();
  await p.evaluate((v) => window.__t.dpr(v), dpr);
  if (arm === 'potato') await p.evaluate(() => window.__t.potatoOn());
  if (arm === 'floor') await p.evaluate(() => { window.__t.potatoOn(); window.__t.floorOn(); });
  await p.waitForTimeout(1500);
  const r = await bench(p);
  if (arm === 'floor') await p.evaluate(() => { window.__t.floorOff(); window.__t.potatoOff(); });
  if (arm === 'potato') await p.evaluate(() => window.__t.potatoOff());
  await p.waitForTimeout(800);
  console.log(`${label.padEnd(24)} ${String(r.median).padStart(6)}  ${String(r.p95).padStart(6)}  ${r.buf.padEnd(11)} ${String(r.calls).padStart(4)}  ${String((r.tris / 1000) | 0).padStart(5)}k`);
  if (pageErr) { console.log('\nABORT: frame loop threw: ' + pageErr); break; }
}

await p.close();
await b.close();
