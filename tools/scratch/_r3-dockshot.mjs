/** Dock at narrow frames, cropped to the dock. Throwaway. */
import { chromium } from 'playwright';
const VITE_STUB = 'export const createHotContext=()=>({accept(){},acceptExports(){},prune(){},dispose(){},decline(){},invalidate(){},on(){},off(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());
await p.evaluate(() => {
  const g = window.__game;
  for (const id of ['fire', 'water', 'nature', 'earth', 'light', 'dark']) { g.state.pendingElementPicks = 1; g.chooseElement(id); }
  g.state.gold = 99999; g.hud._goldShown = 99999; g.state.paused = true;
  g.hud.refreshTop(); g.hud.refreshBuildBar();
});
for (const w of [1280, 1200, 1024, 940]) {
  await p.setViewportSize({ width: w, height: 800 });
  await p.waitForTimeout(500);
  await p.screenshot({ path: `shots/_r3-dock-${w}.png`, clip: { x: 0, y: 660, width: w, height: 140 } });
  console.log('shots/_r3-dock-' + w + '.png');
}
await b.close();
