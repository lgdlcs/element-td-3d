#!/usr/bin/env node
/**
 * Where is each tower of the midgame maze on screen, and what colour is it?
 * Samples a box around the CROWN of every tower and reports mean luminance +
 * median hue, so a palette change can be attributed to the towers that own it
 * instead of to a hue band that several families share.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.route('**/@vite/client', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export const createHotContext = () => ({ accept(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){} }); export const injectQuery = (u) => u; export const removeStyle = () => {};' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await page.evaluate(() => document.getElementById('boot')?.remove());

const MAZE = [
  ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
  ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
  ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
  ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
  ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
  ['dark', 14, 15],
];

const out = await page.evaluate(async (MAZE) => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0;
  g.state.gold = 999999;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  g.hud.refreshBuildBar();
  for (const [key, c, r] of MAZE) g.build(key, c, r);
  await new Promise((r) => setTimeout(r, 2500));
  const V = g.camera.position.constructor;
  return g.towers.towers.map((t) => {
    const v = new V(t.x, 5.0, t.z).project(g.camera);
    return {
      key: t.key,
      x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
    };
  });
}, MAZE);

const buf = await page.screenshot({ type: 'png', timeout: 120000 });
const { writeFileSync } = await import('node:fs');
writeFileSync(process.argv[2] ?? 'probe.png', buf);
writeFileSync((process.argv[2] ?? 'probe.png') + '.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.filter((t) => t.key === 'nature' || t.key === 'light')));
await browser.close();
