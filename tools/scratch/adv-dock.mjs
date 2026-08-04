/** Where does the dock stop fitting? Throwaway. */
import { chromium } from 'playwright';
const OUT = '/private/tmp/claude-501/-Users-pouetpouets/026630db-b7b9-4e91-805a-b7d7caf27667/scratchpad';
const VITE_STUB = 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export const createHotContextLegacy=()=>({accept(){},dispose(){},invalidate(){},on(){},send(){}});';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
const p = await ctx.newPage();
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
await p.waitForTimeout(600);
const rows = [];
for (const w of [1600, 1500, 1440, 1400, 1366, 1300, 1280, 1240, 1200, 1152, 1100, 1024, 960]) {
  await p.setViewportSize({ width: w, height: 800 });
  await p.waitForTimeout(350);
  rows.push(await p.evaluate(() => {
    const d = document.getElementById('dock');
    const s = document.getElementById('send-wave');
    const dr = d.getBoundingClientRect(); const sr = s.getBoundingClientRect();
    return {
      vw: innerWidth,
      dockL: Math.round(dr.left), dockR: Math.round(dr.right),
      need: d.scrollWidth, have: d.clientWidth,
      overflow: d.scrollWidth - d.clientWidth,
      sendR: Math.round(sr.right),
      sendOutsideDock: Math.round(sr.right) > Math.round(dr.right) + 1,
      sendOffscreen: Math.round(sr.right) > innerWidth,
      overflowStyle: getComputedStyle(d).overflow,
    };
  }));
}
console.log(JSON.stringify(rows, null, 1));
await p.setViewportSize({ width: 1024, height: 768 });

await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/run-dock-1024x768.png` });
await p.setViewportSize({ width: 1200, height: 800 });
await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/run-dock-1200x800.png` });
await b.close();
