import { chromium } from 'playwright';
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const log = (...a) => console.log(...a);
const w = Number(process.argv[2] || 1280), h = Number(process.argv[3] || 720);

const b = await chromium.launch({ args: ARGS });
const page = await b.newPage({ viewport: { width: w, height: h } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });
await page.addInitScript(() => {
  try { localStorage.setItem('elementtd.best.v1', JSON.stringify({ score: 48213, wave: 27, won: false, at: Date.now() })); } catch { /* */ }
  const Real = window.WebSocket;
  window.WebSocket = function (url, p) { return new Real(String(url).replace(':5274', ':5299'), p); };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, Real);
  window.__xss = 0;
});
await page.goto(`http://localhost:5273/?mp&q=low`);
await page.waitForFunction(() => !!window.__lobby, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());

const snap = () => page.evaluate(() => ({
  hall: document.getElementById('lobby')?.dataset.hall,
  conn: window.__lobby?.connection,
  status: document.getElementById('lobby-hall-status')?.textContent,
  note: document.getElementById('lobby-hall-note')?.textContent,
  list: document.getElementById('lobby-hall-list')?.textContent.replace(/\s+/g, ' ').trim(),
  err: document.getElementById('lobby-error')?.hidden ? '' : document.getElementById('lobby-error')?.textContent,
  late: window.__lobby?._hallLate,
  timerArmed: !!window.__lobby?._hallTimer,
}));

let prev = '';
for (let t = 0; t <= 12; t++) {
  const s = JSON.stringify(await snap());
  if (s !== prev) { log(`t=${t}s`, s); prev = s; }
  await page.waitForTimeout(1000);
}
await page.screenshot({ path: `shots/rv-lobby-server-empty-${w}x${h}.png` });

// ---- inject a hostile / edge-case board through the real publish path -----
log('\n--- inject hostile board ---');
await page.evaluate(() => {
  window.__game.hud.setLeaderboard([
    { name: '<img src=x onerror="window.__xss=1">', score: 999999, wave: 50, won: true },
    { name: 'AVeryLongNameThatGoesOnAndOnForever', score: 123456, wave: 41 },
    { name: null, score: '77', wave: null },
    { name: 'Ember', score: NaN, wave: undefined },
    { name: 'Mireward', score: -5, wave: 3 },
    { name: 'sixth-should-not-render', score: 1, wave: 1 },
  ]);
});
await page.waitForTimeout(500);
log(JSON.stringify(await snap(), null, 1));
log('xss fired:', await page.evaluate(() => window.__xss));
log('row geometry:', JSON.stringify(await page.evaluate(() => {
  const hall = document.getElementById('lobby-hall').getBoundingClientRect();
  return [...document.querySelectorAll('.hall-row')].map((r) => {
    const b = r.getBoundingClientRect();
    const nm = r.querySelector('.hr-name')?.getBoundingClientRect();
    const sc = r.querySelector('.hr-score')?.getBoundingClientRect();
    return { txt: r.textContent.replace(/\s+/g, ' ').trim(), overflowRight: Math.round(b.right - hall.right), scoreRight: Math.round((sc?.right ?? 0) - hall.right), nameW: Math.round(nm?.width ?? 0) };
  });
}), null, 1));
log('hall box:', JSON.stringify(await page.evaluate(() => {
  const el = document.getElementById('lobby-hall'); const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), scrollH: el.scrollHeight, clientH: el.clientHeight, offBottom: r.bottom > window.innerHeight };
})));
await page.screenshot({ path: `shots/rv-lobby-server-hostile-${w}x${h}.png` });

// ---- stale: kill the socket ---------------------------------------------
log('\n--- close socket (stale) ---');
await page.evaluate(() => { window.__lobby.setConnection('closed'); });
await page.waitForTimeout(400);
log(JSON.stringify(await snap(), null, 1));
await page.screenshot({ path: `shots/rv-lobby-server-stale-${w}x${h}.png` });

// ---- back online, empty board -------------------------------------------
log('\n--- online + empty board ---');
await page.evaluate(() => { window.__lobby.setConnection('online'); window.__game.hud.setLeaderboard([]); });
await page.waitForTimeout(400);
log(JSON.stringify(await snap(), null, 1));
await page.screenshot({ path: `shots/rv-lobby-server-empty2-${w}x${h}.png` });

// ---- standing sentence edge cases ---------------------------------------
log('\n--- standing sentences ---');
for (const [label, top, best] of [
  ['beats none', [{ name: 'a', score: 90000, wave: 5 }, { name: 'b', score: 80000, wave: 5 }], { score: 48213, wave: 27 }],
  ['equal to last', [{ name: 'a', score: 90000, wave: 5 }, { name: 'b', score: 48213, wave: 5 }], { score: 48213, wave: 27 }],
  ['beats top', [{ name: 'a', score: 100, wave: 5 }], { score: 48213, wave: 27 }],
  ['no local best', [{ name: 'a', score: 100, wave: 5 }], { score: 0, wave: 0 }],
]) {
  await page.evaluate(([t, bst]) => {
    window.__lobby.best = bst;
    window.__game.hud.setLeaderboard(t);
  }, [top, best]);
  await page.waitForTimeout(200);
  log(label.padEnd(14), '->', JSON.stringify(await page.evaluate(() => ({
    note: document.getElementById('lobby-hall-note').textContent,
    best: document.getElementById('lobby-hall-best').textContent.replace(/\s+/g, ' ').trim(),
  }))));
}

// ---- does the subscription survive after the lobby is hidden? -----------
log('\n--- leak check ---');
await page.evaluate(() => { window.__hallCalls = 0; const l = window.__lobby; l.hide(); });
await page.waitForTimeout(500);
const beforeHidden = await page.evaluate(() => document.getElementById('lobby-hall-list').innerHTML.length);
await page.evaluate(() => window.__game.hud.setLeaderboard([{ name: 'AfterHide', score: 5, wave: 1 }]));
await page.waitForTimeout(300);
const afterHidden = await page.evaluate(() => document.getElementById('lobby-hall-list').textContent.replace(/\s+/g, ' ').trim());
log('hidden lobby still re-renders on new frames:', JSON.stringify(afterHidden), 'lobbyHidden=', await page.evaluate(() => document.getElementById('lobby').hidden));

log('\nerrors:', JSON.stringify(errs));
await b.close();
