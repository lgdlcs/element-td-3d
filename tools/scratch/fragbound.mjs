/**
 * Is the frame fragment-bound?
 *
 * `low` renders 269k triangles in 93 draw calls and still takes 85ms. That
 * triangle budget is trivial; the cost has to be per-pixel. If frame time
 * scales with pixel count while geometry is held constant, the bottleneck is
 * fragment shading, and no reduction in scope, model detail or draw calls will
 * touch it.
 */
import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const bench = () => p.evaluate(() => new Promise(res => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => { const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 100) requestAnimationFrame(tick);
    else { t.sort((a,c)=>a-c); res(+t[50].toFixed(2)); } };
  requestAnimationFrame(tick);
}));

for (const [w, h] of [[1600,900],[1131,636],[800,450],[400,225],[200,113]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(1200);
  const ms = await bench();
  console.log(`${String(w).padStart(4)}x${String(h).padStart(3)}  ${String((w*h/1000)|0).padStart(5)}k px  ${String(ms).padStart(6)}ms  (${(1000/ms).toFixed(0).padStart(3)}fps)  ${(ms/(w*h)*1e6).toFixed(1)} ns/px`);
}
await b.close();
