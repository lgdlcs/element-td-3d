import { chromium } from 'playwright';
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const log = (...a) => console.log(...a);
const tag = process.argv[2] || 'noserver';
const secs = Number(process.argv[3] || 22);
const w = Number(process.argv[4] || 1280), h = Number(process.argv[5] || 720);

const b = await chromium.launch({ args: ARGS });
const page = await b.newPage({ viewport: { width: w, height: h } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });
await page.addInitScript(() => {
  try { localStorage.setItem('elementtd.best.v1', JSON.stringify({ score: 48213, wave: 27, won: false, at: Date.now() })); } catch { /* */ }
});
await page.goto(`http://localhost:5273/?mp&q=low`);
await page.waitForFunction(() => !!window.__lobby, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());

const snap = () => page.evaluate(() => ({
  hall: document.getElementById('lobby')?.dataset.hall,
  conn: document.getElementById('lobby-conn-text')?.textContent,
  lobbyConn: window.__lobby?.connection,
  cls: document.getElementById('lobby')?.className,
  status: document.getElementById('lobby-hall-status')?.textContent,
  note: document.getElementById('lobby-hall-note')?.textContent,
  list: document.getElementById('lobby-hall-list')?.textContent.replace(/\s+/g, ' ').trim(),
  err: document.getElementById('lobby-error')?.hidden ? '' : document.getElementById('lobby-error')?.textContent,
  timer: window.__lobby?._hallTimer,
  late: window.__lobby?._hallLate,
}));

let prev = '';
for (let t = 0; t <= secs; t += 1) {
  const s = JSON.stringify(await snap());
  if (s !== prev) { log(`t=${String(t).padStart(2)}s`, s); prev = s; }
  await page.waitForTimeout(1000);
}
await page.screenshot({ path: `shots/rv-lobbytime-${tag}-${w}x${h}.png` });
log('errors:', JSON.stringify(errs));
await b.close();
