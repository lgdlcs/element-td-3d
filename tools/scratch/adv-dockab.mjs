/** A/B: is the sub-1280 dock overflow caused by the new shrink policy? Throwaway. */
import { chromium } from 'playwright';
const OUT = '/private/tmp/claude-501/-Users-pouetpouets/026630db-b7b9-4e91-805a-b7d7caf27667/scratchpad';
const VITE_STUB = 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export const createHotContextLegacy=()=>({accept(){},dispose(){},invalidate(){},on(){},send(){}});';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());
await p.evaluate(() => {
  const g = window.__game;
  for (const id of ['fire', 'water', 'nature', 'earth', 'light', 'dark']) { g.state.pendingElementPicks = 1; g.chooseElement(id); }
  g.state.gold = 99999; g.hud._goldShown = 99999; g.state.paused = true;
  g.hud.refreshTop(); g.hud.refreshBuildBar();
});
await p.waitForTimeout(600);
const m = () => p.evaluate(() => {
  const d = document.getElementById('dock'); const s = document.getElementById('send-wave');
  const k = s.querySelector('kbd'); const l = s.querySelector('.sw-label'); const bo = document.getElementById('sw-bonus');
  const dr = d.getBoundingClientRect(); const sr = s.getBoundingClientRect();
  return {
    vw: innerWidth, dockR: Math.round(dr.right), need: d.scrollWidth, have: d.clientWidth,
    sendW: Math.round(sr.width), sendR: Math.round(sr.right),
    kbdR: Math.round(k.getBoundingClientRect().right),
    labelR: Math.round(l.getBoundingClientRect().right),
    bonusR: Math.round(bo.getBoundingClientRect().right),
    labelText: l.textContent,
  };
});
console.log('WITH the new rules (as shipped):', JSON.stringify(await m(), null, 1));
await p.screenshot({ path: `${OUT}/dockab-after-1200.png` });
// revert the two new rules in the live stylesheet
await p.addStyleTag({ content: '#dock { width: auto !important; } #send-wave.show { flex: 1 1 auto !important; min-width: 0 !important; }' });
await p.waitForTimeout(400);
console.log('WITHOUT them (pre-diff shrink policy):', JSON.stringify(await m(), null, 1));
await p.screenshot({ path: `${OUT}/dockab-before-1200.png` });
await b.close();
