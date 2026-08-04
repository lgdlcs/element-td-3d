/** Does the key sheet fit? Throwaway sweep. */
import { chromium } from 'playwright';
const VITE_STUB = 'export const createHotContext=()=>({accept(){},acceptExports(){},prune(){},dispose(){},decline(){},invalidate(){},on(){},off(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const shot = process.argv.includes('--shots');
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());
await p.evaluate(() => {
  const g = window.__game;
  for (const id of ['fire', 'water']) { g.state.pendingElementPicks = 1; g.chooseElement(id); }
  g.state.paused = true; g.hud.setHelp(true);
});
for (const [w, h] of [[1920, 1080], [1600, 900], [1440, 620], [1280, 720], [1280, 660], [1366, 700], [1024, 768]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(500);
  const r = await p.evaluate(() => {
    const s = document.querySelector('#help .help-sheet');
    const c = document.querySelector('.help-cols');
    const groups = [...c.children].map((g) => {
      const b = g.getBoundingClientRect();
      return { t: Math.round(b.top), h: Math.round(b.height), name: g.querySelector('h4,.help-legend,b')?.textContent?.slice(0, 14) ?? '' };
    });
    const cols = new Set(groups.map((g) => Math.round(c.getBoundingClientRect().left)));
    const last = groups[groups.length - 1];
    return {
      vw: innerWidth, vh: innerHeight,
      sheetW: Math.round(s.getBoundingClientRect().width),
      sheetH: Math.round(s.getBoundingClientRect().height),
      scrollH: s.scrollHeight, clientH: s.clientHeight,
      over: s.scrollHeight - s.clientHeight,
      colTemplate: getComputedStyle(c).gridTemplateColumns,
      lastGroupBottom: Math.round(last.t + last.h),
      sheetBottom: Math.round(s.getBoundingClientRect().bottom),
      groups: groups.map((g) => `${g.name}@${g.t}+${g.h}`),
    };
  });
  console.log(JSON.stringify(r));
  if (shot) await p.screenshot({ path: `shots/_r3-help-${w}x${h}.png` });
}
await b.close();
