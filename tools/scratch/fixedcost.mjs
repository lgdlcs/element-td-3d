/**
 * Where do the ~20ms of resolution-independent cost per frame go?
 *
 * At 400x225 (90k pixels, 93 draw calls) the frame still takes 23ms. Nothing
 * about that geometry or that pixel count justifies it. Ablate the candidates
 * one at a time at a tiny viewport, so anything fragment-bound is already
 * near-free and only the fixed cost remains visible.
 */
import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 400, height: 225 } });
await p.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.waitForTimeout(2000);

const bench = async (label) => {
  await p.waitForTimeout(900);
  const ms = await p.evaluate(() => new Promise(res => {
    let n = 0, t0 = performance.now(); const t = [];
    const tick = () => { const x = performance.now(); t.push(x - t0); t0 = x;
      if (++n < 100) requestAnimationFrame(tick);
      else { t.sort((a,c)=>a-c); res(+t[50].toFixed(2)); } };
    requestAnimationFrame(tick);
  }));
  console.log(label.padEnd(34), String(ms).padStart(6) + 'ms');
  return ms;
};

const base = await bench('baseline (low, 400x225)');

await p.evaluate(() => { window.__game.pipeline.renderer.shadowMap.enabled = false;
  window.__game.scene.traverse(o => { if (o.material) (Array.isArray(o.material)?o.material:[o.material]).forEach(m => m.needsUpdate = true); }); });
await bench('  - shadow map');

await p.evaluate(() => { window.__game.state.paused = true; });
await bench('  - shadow map, sim paused');

await p.evaluate(() => { window.__game.pipeline.renderer.shadowMap.enabled = true;
  window.__game.state.paused = false;
  window.__game.scene.traverse(o => { if (o.material) (Array.isArray(o.material)?o.material:[o.material]).forEach(m => m.needsUpdate = true); }); });
await bench('restored');

await p.evaluate(() => { window.__game.state.paused = true; });
await bench('  - sim paused only');

// Raw renderer.render, bypassing the whole composer/post chain.
const raw = await p.evaluate(() => new Promise(res => {
  const g = window.__game, r = g.pipeline.renderer;
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => { r.setRenderTarget(null); r.render(g.scene, g.camera);
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 100) requestAnimationFrame(tick);
    else { t.sort((a,c)=>a-c); res(+t[50].toFixed(2)); } };
  requestAnimationFrame(tick);
}));
console.log('raw scene render, no post'.padEnd(34), String(raw).padStart(6) + 'ms');
console.log('\n(60fps vsync floor is 16.7ms - anything at or under that is capped, not measured)');
await b.close();
