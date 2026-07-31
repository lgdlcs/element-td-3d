#!/usr/bin/env node
/**
 * Isolated cost of the fx point lights.
 *
 * Static scene (21 towers, prep phase, no combat, no particles) so the only
 * variable is NUM_POINT_LIGHTS. Measures GPU frame time with the fx lights
 * present, then removed, then re-added, alternating to cancel thermal drift.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
console.log(JSON.stringify(await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5], ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7], ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9], ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11], ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15], ['dark', 14, 15]];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  await wait(2500);
  const L = g.fx.lights;
  const all = [...L.items, ...L.embers].map(i => i.light);
  const parent = all[0].parent;
  // Pin them all on at working intensity so the shader loop is doing real work.
  const arm = () => { for (const l of all) { l.intensity = 6; l.distance = 5; } };
  const bench = async (ms) => {
    // Warm up past the recompile, then time.
    for (let i = 0; i < 20; i++) await new Promise(r => requestAnimationFrame(r));
    let n = 0; const t0 = performance.now();
    while (performance.now() - t0 < ms) { arm(); await new Promise(r => requestAnimationFrame(r)); n++; }
    return (performance.now() - t0) / n;
  };
  const dirty = () => g.scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(x => { x.needsUpdate = true; }); });
  const ladder = {};
  for (const n of [0, 2, 3, 6, 9, 0]) {
    for (const l of all) parent.remove(l);
    for (let i = 0; i < n; i++) parent.add(all[i]);
    dirty(); await wait(700);
    const ms = +(await bench(2200)).toFixed(2);
    ladder[n] = ladder[n] === undefined ? ms : +((ladder[n] + ms) / 2).toFixed(2);
  }
  for (const l of all) parent.add(l);
  dirty();
  return { ladder, calls: g.pipeline.renderer.info.render.calls, lights: all.length };
}), null, 1));
await browser.close();
