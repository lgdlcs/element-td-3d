/**
 * Round 2 of the `low`-preset lever table: break the 21.8 ms environment down,
 * and size the composer bypass properly.
 *
 * potato.mjs established at `low`, 1600x900, dpr 1 (bracket in brackets):
 *   environment hidden  21.8 ms (4.3)   shadows off  11.0 ms (1.8)
 *   ground hidden       10.0 ms (2.8)   flat ground   8.2 ms (2.1)
 *   one light only       5.6 ms (1.5)
 * and could NOT size `nocomposer` or `nopost`: both trended large but their
 * brackets (86 ms, 31 ms) swamped the effect. This machine has a browser and a
 * compositor competing for the same GPU, so a single A/B/A is not enough for
 * the arms that matter most.
 *
 * So: REPEATS. Each arm runs 3 independent A/B/A cycles and the reported cost
 * is the MEDIAN of the three deltas, with the spread of those deltas printed.
 * A lever whose three deltas do not agree has not been measured, however
 * pleasing its mean is.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const FRAMES = 120;
const CYCLES = 3;

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
    off() { const p = window.__game.pipeline; p.render = p.__realRender; delete p.__realRender; },
  },
  nopost: {
    keys: ['gtao','bloom','dof','grade','smaa'],
    on() { const p = window.__game.pipeline; this.saved = {};
      for (const k of this.keys) if (p.passes[k]) { this.saved[k] = p.passes[k].enabled; p.passes[k].enabled = false; } },
    off() { const p = window.__game.pipeline; for (const k in this.saved) p.passes[k].enabled = this.saved[k]; },
  },
  sky:       { on() { const m = window.__game.environment.sky.mesh; this.v = m.visible; m.visible = false; },
               off() { window.__game.environment.sky.mesh.visible = this.v; } },
  backdrop:  { on() { const g = window.__game.environment.backdrop.group; this.v = g.visible; g.visible = false; },
               off() { window.__game.environment.backdrop.group.visible = this.v; } },
  breach:    { on() { const g = window.__game.environment.breach.group; this.v = g.visible; g.visible = false; },
               off() { window.__game.environment.breach.group.visible = this.v; } },
  groundfog: { on() { const m = window.__game.environment.groundFog.mesh; this.v = m.visible; m.visible = false; },
               off() { window.__game.environment.groundFog.mesh.visible = this.v; } },
  motes:     { on() { const p = window.__game.environment.motes.points; this.v = p.visible; p.visible = false; },
               off() { window.__game.environment.motes.points.visible = this.v; } },
  noshadow: {
    on() { const r = window.__game.pipeline.renderer; this.s = r.shadowMap.enabled; r.shadowMap.enabled = false;
           window.__game.scene.traverse(o => { if (o.isLight && o.castShadow) { o.castShadow = false; o.__hadShadow = true; } }); },
    off() { const r = window.__game.pipeline.renderer; r.shadowMap.enabled = this.s;
            window.__game.scene.traverse(o => { if (o.__hadShadow) { o.castShadow = true; delete o.__hadShadow; } }); },
  },
  /** Everything a 'potato' preset would plausibly do, at once. */
  potato: {
    on() {
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
      const keep = [];
      g.scene.traverse(o => { if (o.isDirectionalLight && o.__hadShadow) keep.push(o); });
      g.scene.traverse(o => { if (o.isLight && !keep.includes(o) && !o.isAmbientLight) hide(o); });
    },
    off() {
      const g = window.__game, p = g.pipeline;
      p.render = p.__realRender; delete p.__realRender;
      p.renderer.shadowMap.enabled = this.s;
      g.scene.traverse(o => { if (o.__hadShadow) { o.castShadow = true; delete o.__hadShadow; } });
      for (const o of this.hid) o.visible = true;
    },
  },
};`;

const bench = (page) => page.evaluate((n) => new Promise((res) => {
  let i = 0, t0 = performance.now(); const times = [];
  const tick = () => {
    const t = performance.now(); times.push(t - t0); t0 = t;
    if (++i < n) requestAnimationFrame(tick);
    else { times.sort((a, c) => a - c); res(+times[n >> 1].toFixed(2)); }
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

const guard = async (where) => {
  if (pageErr) { console.log(`\nABORTED at ${where}: frame loop threw: ${pageErr}`); await b.close(); process.exit(1); }
};
const topUp = () => p.evaluate(async () => {
  const g = window.__game;
  if (g.creeps._liveCount < 12) { g.waves.start(21); await new Promise((r) => setTimeout(r, 2500)); }
});

console.log(`preset low, 1600x900, dpr 1, adaptive off, 21 towers + wave 21`);
console.log(`${FRAMES} frames/cell, ${CYCLES} independent A/B/A cycles per arm, cost = median of the ${CYCLES} deltas\n`);
console.log('arm            cost   deltas                 verdict');

for (const name of names) {
  const deltas = [];
  for (let c = 0; c < CYCLES; c++) {
    await topUp();
    await guard(name);
    const a1 = await bench(p);
    await p.evaluate((n) => window.__arms[n].on(), name);
    await p.waitForTimeout(1000);
    const arm = await bench(p);
    await p.evaluate((n) => window.__arms[n].off(), name);
    await p.waitForTimeout(1000);
    const a2 = await bench(p);
    await guard(name);
    deltas.push(+(((a1 + a2) / 2) - arm).toFixed(1));
  }
  const sorted = deltas.slice().sort((a, c) => a - c);
  const cost = sorted[CYCLES >> 1];
  const spread = sorted[CYCLES - 1] - sorted[0];
  const verdict = spread > Math.abs(cost) ? 'NOISE' : (cost > 2 ? 'real' : 'tiny');
  console.log(`${name.padEnd(12)} ${cost.toFixed(1).padStart(6)}ms  [${deltas.join(', ').padEnd(20)}] ${verdict} (spread ${spread.toFixed(1)})`);
}

await p.close();
await b.close();
