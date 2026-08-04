import { chromium } from 'playwright';
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const log = (...a) => console.log(...a);
const tag = process.argv[2] || 'noserver';

const b = await chromium.launch({ args: ARGS });

for (const [w, h] of [[1280, 720], [1920, 1080], [1440, 900], [1180, 800], [1179, 800]]) {
  const page = await b.newPage({ viewport: { width: w, height: h } });
  await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });
  // seed a personal best so the headline has a number in it
  await page.addInitScript(() => {
    try { localStorage.setItem('elementtd.best.v1', JSON.stringify({ score: 48213, wave: 27, won: false, at: Date.now() })); } catch { /* */ }
  });
  await page.goto(`http://localhost:5273/?mp&q=low`);
  await page.waitForFunction(() => !!window.__lobby, null, { timeout: 30000 });
  await page.evaluate(() => document.getElementById('boot')?.remove());
  await page.waitForTimeout(1500);

  const probe = await page.evaluate(() => {
    const l = document.getElementById('lobby');
    const hall = document.getElementById('lobby-hall');
    const inner = document.querySelector('.lobby-inner');
    const r = hall.getBoundingClientRect(), i = inner.getBoundingClientRect();
    return {
      hallState: l.dataset.hall,
      conn: document.getElementById('lobby-conn-text').textContent,
      lobbyState: l.className,
      errBoxHidden: document.getElementById('lobby-error').hidden,
      errBoxText: document.getElementById('lobby-error').textContent,
      hall: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom), display: getComputedStyle(hall).display },
      inner: { x: Math.round(i.left), w: Math.round(i.width), h: Math.round(i.height), right: Math.round(i.right), bottom: Math.round(i.bottom) },
      overlapX: Math.round(i.right) > Math.round(r.left),
      offRight: Math.round(r.right) > window.innerWidth,
      offBottom: Math.round(r.bottom) > window.innerHeight,
      status: document.getElementById('lobby-hall-status').textContent,
      best: document.getElementById('lobby-hall-best').textContent.replace(/\s+/g, ' ').trim(),
      list: document.getElementById('lobby-hall-list').textContent.replace(/\s+/g, ' ').trim(),
      note: document.getElementById('lobby-hall-note').textContent,
      docScrollW: document.documentElement.scrollWidth,
    };
  });
  log(`\n=== ${w}x${h} [${tag}] ===`);
  log(JSON.stringify(probe, null, 1));
  const txt = JSON.stringify(probe);
  if (/undefined|NaN|\[object/.test(txt)) log('!! SUSPECT TEXT IN HALL');
  await page.screenshot({ path: `shots/rv-lobby-${tag}-${w}x${h}.png` });
  log('errors:', JSON.stringify(errs));
  await page.close();
}
await b.close();
