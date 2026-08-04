import { chromium } from 'playwright';
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const log = (...a) => console.log(...a);
const b = await chromium.launch({ args: ARGS });
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });
await page.addInitScript(() => { try { localStorage.setItem('elementtd.best.v1', JSON.stringify({ score: 48213, wave: 27, won: false, at: Date.now() })); } catch { /* */ } });
await page.goto('http://localhost:5273/?mp&q=low');
await page.waitForFunction(() => !!window.__lobby, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.waitForTimeout(3500);   // let it settle to 'offline'

// ---- force the 'late' branch: pretend a socket came up, never send a board
log('--- forcing late ---');
await page.evaluate(() => window.__lobby.setConnection('online'));
for (const t of [1, 5, 8, 9, 10]) {
  await page.waitForTimeout(t === 1 ? 1000 : (t === 5 ? 4000 : 1000));
  log(`t≈${t}s`, JSON.stringify(await page.evaluate(() => ({
    hall: document.getElementById('lobby').dataset.hall,
    status: document.getElementById('lobby-hall-status').textContent,
    note: document.getElementById('lobby-hall-note').textContent,
    list: document.getElementById('lobby-hall-list').textContent.replace(/\s+/g, ' ').trim(),
  }))));
}
await page.screenshot({ path: 'shots/rv-lobby-late-1280x720.png' });

// ---- 'unknown' branch
await page.evaluate(() => window.__lobby.setConnection('closed'));
await page.waitForTimeout(300);
log('unknown:', JSON.stringify(await page.evaluate(() => ({
  hall: document.getElementById('lobby').dataset.hall,
  status: document.getElementById('lobby-hall-status').textContent,
  note: document.getElementById('lobby-hall-note').textContent,
  conn: document.getElementById('lobby-conn-text').textContent,
}))));
await page.screenshot({ path: 'shots/rv-lobby-unknown-1280x720.png' });

// ---- room state with a full roster + board
log('--- room state ---');
await page.evaluate(() => {
  const l = window.__lobby;
  l.setConnection('online');
  window.__game.hud.setLeaderboard([
    { name: 'Emberkin', score: 128400, wave: 50, won: true },
    { name: 'Frostwright', score: 99120, wave: 44 },
    { name: 'Bramblesong', score: 71000, wave: 38 },
    { name: 'Umbramark', score: 50110, wave: 31 },
    { name: 'Quartzbane', score: 22050, wave: 19 },
  ]);
  l.setCode('AB2K');
  l.setPlayers([
    { id: 1, name: 'Emberkin', host: true, ready: true },
    { id: 2, name: 'Frostwright', ready: false },
    { id: 3, name: 'Bramblesong', ready: true },
    { id: 4, name: 'Umbramark', ready: false },
    { id: 5, name: 'Quartzbane', ready: true },
    { id: 6, name: 'Rimewake', ready: false },
  ], 1);
  l.setState('lobby');
});
await page.waitForTimeout(600);
log('room geometry:', JSON.stringify(await page.evaluate(() => {
  const inner = document.querySelector('.lobby-inner').getBoundingClientRect();
  const hall = document.getElementById('lobby-hall').getBoundingClientRect();
  return {
    innerH: Math.round(inner.height), innerTop: Math.round(inner.top), innerBottom: Math.round(inner.bottom),
    innerRight: Math.round(inner.right), hallLeft: Math.round(hall.left), hallRight: Math.round(hall.right),
    hallTop: Math.round(hall.top), hallBottom: Math.round(hall.bottom),
    overlap: Math.round(inner.right) > Math.round(hall.left),
    offRight: Math.round(hall.right) > window.innerWidth,
    innerScrolls: document.querySelector('.lobby-inner').scrollHeight > document.querySelector('.lobby-inner').clientHeight,
  };
})));
await page.screenshot({ path: 'shots/rv-lobby-room-1280x720.png' });

await page.setViewportSize({ width: 1920, height: 1080 });
await page.waitForTimeout(400);
await page.screenshot({ path: 'shots/rv-lobby-room-1920x1080.png' });

// ---- 2200px+ breakpoint (--lobby-w override)
await page.setViewportSize({ width: 2400, height: 1200 });
await page.waitForTimeout(400);
log('2400 geometry:', JSON.stringify(await page.evaluate(() => {
  const inner = document.querySelector('.lobby-inner').getBoundingClientRect();
  const hall = document.getElementById('lobby-hall').getBoundingClientRect();
  return { innerW: Math.round(inner.width), innerRight: Math.round(inner.right), hallLeft: Math.round(hall.left), hallW: Math.round(hall.width), gap: Math.round(hall.left - inner.right) };
})));
await page.screenshot({ path: 'shots/rv-lobby-room-2400x1200.png' });

log('errors:', JSON.stringify(errs));
await b.close();
