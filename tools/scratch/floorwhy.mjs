/**
 * What IS the 16.7ms empty-scene floor? (floor.mjs)
 *
 * An empty scene at 5 draw calls / 0 triangles cannot be costing 16.7ms on
 * geometry or on material ALU. The remaining suspects are all properties of the
 * TARGET being rendered into, not of what is drawn into it: sample count,
 * pixel count, and format. Vary each one against an empty scene and see which
 * moves the number.
 *
 * If it scales with pixel count, it is bandwidth and the fix is resolution /
 * MSAA / format. If it does not move at all, it is a fixed CPU or driver stall
 * and every art optimisation in the project is irrelevant.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.waitForTimeout(3000);

// Empty scene, post off, shadows off — reproduce floor.mjs's last row exactly.
console.log(await p.evaluate(() => {
  const g = window.__game;
  for (const k of ['fx', 'creeps', 'towers', 'environment', 'arena']) {
    const grp = g[k]?.group || g[k];
    if (grp && 'visible' in grp) grp.visible = false;
  }
  g.pipeline.renderer.shadowMap.enabled = false;
  g.pipeline.composer.passes.forEach((x) => { if (x.constructor.name !== 'RenderPass') x.enabled = false; });

  const c = g.pipeline.composer;
  const rt = c.renderTarget1;
  const r = g.pipeline.renderer;
  return `target: ${rt.width}x${rt.height} samples=${rt.samples} `
    + `type=${rt.texture.type} format=${rt.texture.format} `
    + `| pixelRatio=${r.getPixelRatio()} drawingBuffer=${r.domElement.width}x${r.domElement.height} `
    + `| passes=${c.passes.map((x) => x.constructor.name).join(',')} `
    + `| background=${g.scene.background ? g.scene.background.constructor.name : 'null'} `
    + `env=${g.scene.environment ? 'yes' : 'no'} fog=${g.scene.fog ? 'yes' : 'no'}`;
}));

const bench = () => p.evaluate(() => new Promise((res) => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a, c) => a - c); res(+t[70].toFixed(2)); }
  };
  requestAnimationFrame(tick);
}));

await p.waitForTimeout(900);
console.log(`\nempty scene, post off, shadows off   ${String(await bench()).padStart(6)}ms`);

// --- 1. does it scale with pixel count? ---
for (const pr of [2, 1.5, 1, 0.5]) {
  await p.evaluate((v) => {
    const g = window.__game;
    g.pipeline.renderer.setPixelRatio(v);
    g.pipeline.composer.setPixelRatio?.(v);
    g.pipeline.resize?.(window.innerWidth, window.innerHeight);
  }, pr);
  await p.waitForTimeout(800);
  const ms = await bench();
  const dims = await p.evaluate(() => {
    const r = window.__game.pipeline.renderer;
    return `${r.domElement.width}x${r.domElement.height}`;
  });
  console.log(`  pixelRatio ${String(pr).padEnd(4)} (${dims.padEnd(11)})       ${String(ms).padStart(6)}ms`);
}

// --- 2. is it the composer at all? render straight to the screen. ---
await p.evaluate(() => {
  const g = window.__game;
  g.pipeline.renderer.setPixelRatio(2);
  g.pipeline.resize?.(window.innerWidth, window.innerHeight);
  const r = g.pipeline.renderer, sc = g.scene, cam = g.camera;
  g.pipeline.__origRender = g.pipeline.render.bind(g.pipeline);
  g.pipeline.render = () => { r.setRenderTarget(null); r.render(sc, cam); };
});
await p.waitForTimeout(800);
console.log(`\n  direct to screen, no composer      ${String(await bench()).padStart(6)}ms   <- pixelRatio 2`);

// --- 3. and with nothing drawn at all? ---
await p.evaluate(() => {
  const g = window.__game;
  const r = g.pipeline.renderer;
  g.pipeline.render = () => { r.setRenderTarget(null); r.clear(); };
});
await p.waitForTimeout(800);
console.log(`  clear only, no render call         ${String(await bench()).padStart(6)}ms   <- the true CPU/sim floor`);

await b.close();
