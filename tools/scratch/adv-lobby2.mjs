/** ADVERSARIAL PROBE — lobby hall WITH a live backend + hostile frames. Throwaway. */
import { chromium } from 'playwright';
const OUT = '/private/tmp/claude-501/-Users-pouetpouets/026630db-b7b9-4e91-805a-b7d7caf27667/scratchpad';
const VITE_STUB = 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export const createHotContextLegacy=()=>({accept(){},dispose(){},invalidate(){},on(){},send(){}});';
const say = (n, o) => console.log(`\n## ${n}\n${JSON.stringify(o, null, 1)}`);

// The real mp server is on 5275 (5274 is squatted by a stale vite). Rewrite the
// socket URL in the page so NetClient reaches it unmodified.
const REWRITE = `(() => {
  const OW = window.WebSocket;
  function W(url, protocols) {
    const u = String(url).replace(':5274', ':5275');
    return protocols === undefined ? new OW(u) : new OW(u, protocols);
  }
  W.prototype = OW.prototype;
  for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) W[k] = OW[k];
  window.WebSocket = W;
})();`;

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });

async function open(w, h, best) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[err] ${m.text()}`); });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
  await p.addInitScript(REWRITE);
  if (best) await p.addInitScript((v) => { try { localStorage.setItem('elementtd.best.v1', v); } catch { /* */ } }, best);
  await p.goto('http://localhost:5273/?q=low&mp', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby, null, { timeout: 90000 });
  await p.evaluate(() => document.getElementById('boot')?.remove());
  return { ctx, p, errors };
}

const snap = (p) => p.evaluate(() => {
  const L = window.__lobby; const el = document.getElementById('lobby');
  const txt = (id) => document.getElementById(id)?.textContent.replace(/\s+/g, ' ').trim();
  const hall = document.getElementById('lobby-hall');
  const r = hall.getBoundingClientRect();
  return {
    state: L.state, conn: L.connection, hall: el.dataset.hall, topLen: L.top.length, received: L.topReceived,
    status: txt('lobby-hall-status'), best: txt('lobby-hall-best'), list: txt('lobby-hall-list'),
    note: txt('lobby-hall-note'), mini: txt('lobby-hall-mini'),
    rows: [...document.querySelectorAll('.hall-row')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    listHTML: document.getElementById('lobby-hall-list').innerHTML.slice(0, 400),
    overflowY: hall.scrollHeight > hall.clientHeight,
    box: { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), rr: Math.round(r.right) },
    vh: innerHeight, vw: innerWidth,
    timer: !!L._hallTimer, late: L._hallLate,
    text: el.innerText,
  };
});

// ---- 1. live server, empty board -----------------------------------------
{
  const { ctx, p, errors } = await open(1280, 720, null);
  await p.waitForTimeout(2500);
  const s = await snap(p);
  say('live server / empty board 1280x720', { ...s, text: undefined, errors });
  await p.screenshot({ path: `${OUT}/lobby-live-empty-1280x720.png` });
  await ctx.close();
}

// ---- 2. live server + a real posted score --------------------------------
{
  const { ctx, p, errors } = await open(1280, 720, JSON.stringify({ score: 12345, wave: 33, won: false, at: Date.now() }));
  await p.waitForTimeout(2000);
  // post a few results through the transport, like a finished run does
  await p.evaluate(async () => {
    const net = window.__net;
    net.hello('Aurelia');
    net.best({ score: 98765, wave: 55, won: true });
    await new Promise((r) => setTimeout(r, 200));
    net.hello('Bram');
    net.best({ score: 4321, wave: 12, won: false });
  });
  await p.waitForTimeout(1500);
  const s = await snap(p);
  say('live server / 2 real scores', { ...s, text: undefined, errors });
  await p.screenshot({ path: `${OUT}/lobby-live-scores-1280x720.png` });

  // -- the socket dies -> 'stale'
  await p.evaluate(() => window.__lobby.setConnection('closed'));
  await p.waitForTimeout(400);
  say('after a drop', await snap(p).then((x) => ({ hall: x.hall, status: x.status, note: x.note, rows: x.rows })));
  await ctx.close();
}

// ---- 3. hostile / malformed frames ---------------------------------------
{
  const { ctx, p, errors } = await open(1280, 720, JSON.stringify({ score: 500, wave: 4, won: false, at: 1 }));
  await p.waitForTimeout(2200);
  await p.evaluate(() => {
    window.__lobby.setConnection('online');
    window.__game.hud.setLeaderboard([
      { name: '<img src=x onerror="window.__pwn=1">', score: 999, wave: 3 },
      { name: 'Mireward', score: -5, wave: -2 },
      { name: null, score: NaN, wave: undefined },
      { name: 'A'.repeat(120), score: '1e21', wave: 9 },
      { name: 'Ok', score: 700, wave: 2 },
      { name: 'Ok2', score: 650, wave: 2 },
    ]);
  });
  await p.waitForTimeout(600);
  const s = await snap(p);
  say('hostile frame', {
    ...s, text: undefined, errors,
    pwned: await p.evaluate(() => !!window.__pwn),
  });
  await p.screenshot({ path: `${OUT}/lobby-hostile-1280x720.png` });

  // -- #standing() against a SHORT board (fewer rows than HALL_ROWS)
  await p.evaluate(() => {
    window.__game.hud.setLeaderboard([
      { name: 'Top', score: 90000, wave: 50 },
      { name: 'Two', score: 80000, wave: 44 },
    ]);
  });
  await p.waitForTimeout(400);
  say('short board vs local best 500', await snap(p).then((x) => ({ rows: x.rows, note: x.note, mini: x.mini })));

  // -- the leak: hide(), then a reconnect re-arms the timer
  await p.evaluate(() => { window.__lobby.hide(); });
  await p.waitForTimeout(200);
  const afterHide = await p.evaluate(() => ({ timer: !!window.__lobby._hallTimer, sub: !!window.__lobby._unsubscribeTop }));
  await p.evaluate(() => { window.__lobby.topReceived = false; window.__lobby.setConnection('online'); });
  await p.waitForTimeout(200);
  const afterReconnect = await p.evaluate(() => ({ timer: !!window.__lobby._hallTimer, sub: !!window.__lobby._unsubscribeTop, hidden: window.__lobby.$el.hidden }));
  say('hidden-lobby timer leak', { afterHide, afterReconnect });

  // -- show() again with no board: does the timer ever fire? (permanent spinner)

  await ctx.close();
}

// ---- 4. tall/short viewport ----------------------------------------------
for (const [w, h] of [[1280, 620], [1440, 560], [3440, 1440]]) {
  const { ctx, p, errors } = await open(w, h, JSON.stringify({ score: 12345, wave: 33, won: true, at: 1 }));
  await p.waitForTimeout(2200);
  await p.evaluate(() => {
    window.__lobby.setConnection('online');
    window.__game.hud.setLeaderboard([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ name: `Player ${i}`, score: 50000 - i * 3000, wave: 55 - i })));
  });
  await p.waitForTimeout(500);
  const s = await snap(p);
  say(`live board ${w}x${h}`, {
    hall: s.hall, rows: s.rows.length, box: s.box, vh: s.vh, overflowY: s.overflowY,
    clipped: s.box.t < 0 || s.box.b > s.vh, note: s.note, errors,
  });
  await p.screenshot({ path: `${OUT}/lobby-live-${w}x${h}.png` });
  await ctx.close();
}

await b.close();
