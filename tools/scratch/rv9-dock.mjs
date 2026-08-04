import { chromium } from 'playwright';
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const log = (...a) => console.log(...a);
const b = await chromium.launch({ args: ARGS });
for (const [w, h] of [[1280, 720], [1366, 768], [1920, 1080]]) {
  const page = await b.newPage({ viewport: { width: w, height: h } });
  await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://localhost:5273/?q=low');
  await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
  await page.evaluate(() => document.getElementById('boot')?.remove());
  await page.waitForTimeout(700);
  await page.evaluate(() => { document.querySelector('#picker .pc-card, #picker button')?.click(); });
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__game.state.gold = 5000; window.__game.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark']; window.__game.hud.refreshBuildBar(); });
  await page.waitForTimeout(500);
  const geo = await page.evaluate(() => {
    const sw = document.getElementById('send-wave');
    const k = sw.querySelector('kbd');
    const lbl = sw.querySelector('.sw-label');
    const bon = document.getElementById('sw-bonus');
    const R = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
    const dock = document.getElementById('dock').getBoundingClientRect();
    return {
      dock: { x: Math.round(dock.left), w: Math.round(dock.width), right: Math.round(dock.right), off: Math.round(dock.right) > window.innerWidth || Math.round(dock.left) < 0 },
      sendWave: R(sw), cap: R(k), label: R(lbl), bonus: R(bon),
      capOverLabel: R(k).x < R(lbl).right,
      capOverBonus: bon.offsetWidth > 0 && R(k).x < R(bon).right,
      bonusText: bon.textContent,
    };
  });
  log(`=== ${w}x${h} ===`, JSON.stringify(geo, null, 1));
  await page.screenshot({ path: `shots/rv-dock-${w}x${h}.png` });
  await page.screenshot({ path: `shots/rv-dock-crop-${w}x${h}.png`, clip: { x: 0, y: h - 220, width: w, height: 220 } });
  await page.screenshot({ path: `shots/rv-top-crop-${w}x${h}.png`, clip: { x: 0, y: 0, width: w, height: 70 } });
  log('errors:', JSON.stringify(errs));
  await page.close();
}
await b.close();
