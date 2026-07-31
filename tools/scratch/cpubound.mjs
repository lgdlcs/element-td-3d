/**
 * Are we CPU-bound?
 *
 * Three material ablations have now behaved non-additively: sky alone free,
 * surround alone free, both together 10ms. That is not how serial GPU shading
 * composes, but it is exactly how `frame = max(CPU, GPU)` composes — each cut
 * alone leaves GPU above the CPU floor and moves nothing; together they drop
 * GPU under it and the CPU floor appears.
 *
 * Resolution is the clean discriminator. Fragment cost scales with pixel count;
 * CPU cost does not care at all. Sweep pixelRatio over a 64x range in area.
 *
 * If frame time is flat, every GPU optimisation attempted so far was aimed at
 * something that was never the constraint, and the work belongs in the
 * JS frame loop instead.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));

const preset = process.argv[2] || 'low';
await p.goto(`http://localhost:5273/?q=${preset}`, { waitUntil: 'load' });
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
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 8000));
});

const bench = () => p.evaluate(() => new Promise((res) => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a, c) => a - c); res(+t[70].toFixed(2)); }
  };
  requestAnimationFrame(tick);
}));

console.log(`preset ${preset}, 21 towers, wave 21, full pipeline\n`);
console.log('pixelRatio   drawing buffer      frame');
for (const pr of [2, 1.5, 1, 0.5, 0.25]) {
  await p.evaluate((v) => {
    const g = window.__game;
    g.pipeline.renderer.setPixelRatio(v);
    g.pipeline.composer.setPixelRatio?.(v);
    g.pipeline.resize?.(window.innerWidth, window.innerHeight);
  }, pr);
  await p.waitForTimeout(1000);
  const ms = await bench();
  const dims = await p.evaluate(() => {
    const r = window.__game.pipeline.renderer;
    return `${r.domElement.width}x${r.domElement.height}`;
  });
  console.log(`   ${String(pr).padEnd(6)}    ${dims.padEnd(14)} ${String(ms).padStart(7)}ms  ${String(Math.round(1000 / ms)).padStart(3)}fps`);
}

// The JS half of the frame, measured directly: how long does game.frame() take
// with rendering removed entirely?
console.log('');
console.log(await p.evaluate(() => new Promise((res) => {
  const g = window.__game;
  const origRender = g.pipeline.render.bind(g.pipeline);
  g.pipeline.render = () => {};
  const t = [];
  let n = 0;
  const tick = () => {
    const a = performance.now();
    g.frame(0.016);
    t.push(performance.now() - a);
    if (++n < 120) requestAnimationFrame(tick);
    else {
      g.pipeline.render = origRender;
      t.sort((x, y) => x - y);
      res(`game.frame() with render() stubbed out: median ${t[60].toFixed(2)}ms  p95 ${t[114].toFixed(2)}ms   <- pure JS simulation cost`);
    }
  };
  requestAnimationFrame(tick);
})));

await b.close();
