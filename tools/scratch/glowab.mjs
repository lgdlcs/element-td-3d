// A/B the additive ground-glow decal: same frame with glowMesh on and off.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
p.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;' }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(async () => {
  const g = window.__game; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5], ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7], ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9], ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11], ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15], ['dark', 14, 15]];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  g.state.phase = 'prep';
  await wait(3000);
  g.paused = true;
});
writeFileSync('shots/ab-glow-on.png', await p.screenshot());
await p.evaluate(() => { window.__game.towers.batch.glowMesh.visible = false; });
await p.waitForTimeout(600);
writeFileSync('shots/ab-glow-off.png', await p.screenshot());
await p.evaluate(() => { window.__game.towers.batch.glowMesh.visible = true; for (const s of window.__game.towers.batch.lights) s.light.visible = false; });
await p.waitForTimeout(600);
writeFileSync('shots/ab-lights-off.png', await p.screenshot());
console.log(JSON.stringify({ errors: logs }));
await b.close();
