/**
 * Paired verification of MSAAScenePass, in one session.
 *
 * NEW (shipped): composer buffers single-sampled, scene rendered into a private
 *                4x target, resolved once by a fullscreen copy.
 * OLD (emulated): composer buffers back to samples=4, AND the scene pass
 *                 rendering straight into readBuffer with no private target —
 *                 which is exactly what a plain RenderPass did.
 *
 * Emulating OLD by only restoring samples=4 would be wrong: that leaves the
 * private multisampled target in place too, which is strictly MORE work than the
 * old pipeline, not the same.
 *
 * Lights are force-disarmed for the whole window in both rows, via the
 * dur=Infinity / visible=false pattern that interact.mjs had to arrive at — a
 * one-shot disarm is undone by the next muzzle flash and a `visible=false`
 * interval loses the race against LightPool.update() inside the rAF callback.
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
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?';
}));

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
  // Hold the pool disarmed for the whole run, in BOTH rows.
  const lp = g.fx.lights;
  setInterval(() => [...lp.items, ...lp.embers].forEach((i) => {
    i.light.visible = false; i.light.intensity = 0; i.t = i.dur;
  }), 16);
  await new Promise((r) => setTimeout(r, 9000));
  return k;
});
if (n < 21) { console.log(`ABORT: only ${n} towers`); await b.close(); process.exit(1); }

const state = () => p.evaluate(() => {
  const pl = window.__game.pipeline;
  const c = pl.composer;
  const lp = window.__pool;
  return {
    pass: c.passes[0].constructor.name,
    composerSamples: c.renderTarget1.samples,
    privateSamples: c.passes[0].target ? c.passes[0].target.samples : 'none',
    poolVisible: [...lp.items, ...lp.embers].filter((i) => i.light.visible).length,
    buf: `${pl.renderer.domElement.width}x${pl.renderer.domElement.height}`,
    calls: pl.renderer.info.render.calls,
  };
});

const bench = (frames = 220) => p.evaluate((f) => new Promise((res) => {
  let i = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++i < f) requestAnimationFrame(tick);
    else { t.sort((a, c) => a - c); res({ med: +t[f >> 1].toFixed(2), p95: +t[Math.floor(f * 0.95)].toFixed(2) }); }
  };
  requestAnimationFrame(tick);
}), frames);

await p.waitForTimeout(2200);
let s = await state();
console.log(`\nNEW  ${s.pass}, composer samples=${s.composerSamples}, private=${s.privateSamples}, pool ${s.poolVisible}/6, ${s.buf}, ${s.calls} calls`);
const New = await bench();
console.log(`     median ${String(New.med).padStart(6)}ms  p95 ${String(New.p95).padStart(6)}ms`);

// --- emulate OLD ---
const ok = await p.evaluate(() => {
  const c = window.__game.pipeline.composer;
  const pass = c.passes[0];
  if (!pass.target) return false;         // preset had msaa 0; nothing to compare
  for (const rt of [c.renderTarget1, c.renderTarget2]) { rt.samples = 4; rt.dispose(); }
  // Bypass the private target entirely: render straight into readBuffer, which
  // is precisely what RenderPass does.
  pass.render = function (renderer, writeBuffer, readBuffer) {
    const old = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = old;
  };
  return true;
});
if (!ok) { console.log('\npreset has msaa=0, nothing to compare'); await b.close(); process.exit(0); }

await p.waitForTimeout(2500);
s = await state();
console.log(`\nOLD  scene straight to readBuffer, composer samples=${s.composerSamples}, pool ${s.poolVisible}/6, ${s.buf}, ${s.calls} calls`);
const Old = await bench();
console.log(`     median ${String(Old.med).padStart(6)}ms  p95 ${String(Old.p95).padStart(6)}ms`);

console.log(`\n--- result ------------------------------------------`);
console.log(`median  ${Old.med} -> ${New.med} ms   saves ${(Old.med - New.med).toFixed(1)} ms`);
console.log(`p95     ${Old.p95} -> ${New.p95} ms   saves ${(Old.p95 - New.p95).toFixed(1)} ms`);
console.log(errs.length ? `\nERRORS: ${errs.join('\n')}` : 'no page errors');
await b.close();
