#!/usr/bin/env node
/**
 * VFX round-6 verification. Runs the midgame scenario and samples, over a
 * 4-second window of live combat:
 *   - point-light census (how many the fx layer owns, how hot they get)
 *   - how often an ember (sustained pool) light is actually lit
 *   - draw calls / triangles / live particles
 *   - frame time with the fx ember lights on vs forced off (light cost)
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().split('\n')[0]); });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const out = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5], ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7], ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9], ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11], ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15], ['dark', 14, 15]];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  g.state.wave = 21; g.state.phase = 'combat'; g.waves.start(22);
  await wait(2500);

  const L = []; g.scene.traverse(o => { if (o.isLight) L.push(o); });
  const pts = L.filter(o => o.isPointLight);
  const fxFlash = g.fx.lights.items.map(i => i.light);
  const fxEmber = g.fx.lights.embers.map(i => i.light);

  const sample = async (ms) => {
    const s = { emberLitFrames: 0, flashLitFrames: 0, frames: 0, maxEmber: 0, calls: 0, tris: 0, live: 0 };
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      await new Promise(r => requestAnimationFrame(r));
      s.frames++;
      if (fxEmber.some(l => l.intensity > 0.05)) s.emberLitFrames++;
      if (fxFlash.some(l => l.intensity > 0.05)) s.flashLitFrames++;
      s.maxEmber = Math.max(s.maxEmber, ...fxEmber.map(l => l.intensity));
      const r = g.pipeline.renderer.info;
      s.calls = Math.max(s.calls, r.render.calls); s.tris = Math.max(s.tris, r.render.triangles);
      s.live = Math.max(s.live, g.fx.liveCount);
    }
    s.ms = ms / s.frames;
    return s;
  };
  const on = await sample(4000);
  // Cost of the fx point lights: remove them from the scene entirely, which
  // recompiles every lit material with a smaller NUM_POINT_LIGHTS.
  const removed = [...fxFlash, ...fxEmber];
  for (const l of removed) l.parent.remove(l);
  g.scene.traverse(o => { if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach(x => x.needsUpdate = true); } });
  await wait(1200);
  const off = await sample(4000);
  return {
    totalLights: L.length, pointLights: pts.length,
    fxFlashLights: fxFlash.length, fxEmberLights: fxEmber.length,
    on, off,
    emberDutyPct: +(on.emberLitFrames / on.frames * 100).toFixed(1),
    flashDutyPct: +(on.flashLitFrames / on.frames * 100).toFixed(1),
  };
});
await browser.close();
console.log(JSON.stringify({ ...out, errs: [...new Set(errs)].slice(0, 5) }, null, 1));
