/** Le spectate via le CLIC REEL sur la ligne du scoreboard, pas via net.watch(). */
import { chromium } from 'playwright';
const PAGE = process.argv[2] || 'http://localhost:5273';
const WS = process.argv[3] || 'ws://localhost:5274/ws';
const ARGS = ['--enable-unsafe-swiftshader','--mute-audio','--disable-background-timer-throttling',
  '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-frame-rate-limit','--use-angle=metal'];
const browser = await chromium.launch({ args: ARGS });
const errors = [];
const mk = async (tag) => {
  const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  p.on('pageerror', e => errors.push(`${tag} pageerror: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
  await p.goto(`${PAGE}/?mp&q=low&server=${encodeURIComponent(WS)}`, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby && !!window.__net, null, { timeout: 60000 });
  await p.waitForFunction(() => window.__net.state === 'online', null, { timeout: 25000 });
  return p;
};
const A = await mk('P1'), B = await mk('P2');
const named = (p, n) => p.evaluate((v) => { const el = document.querySelector('#lobby-name'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, n);
await named(A, 'Streamer'); await A.click('#lobby-create');
await A.waitForFunction(() => document.querySelector('#lobby-code-chars')?.textContent.trim().length === 4, null, { timeout: 20000 });
const code = (await A.textContent('#lobby-code-chars')).trim();
await named(B, 'Watcher');
await B.evaluate((c) => { const el = document.querySelector('#lobby-code-in'); el.value = c; el.dispatchEvent(new Event('input', { bubbles: true })); }, code);
await B.click('#lobby-join');
await A.waitForFunction(() => [...document.querySelectorAll('#lobby-roster li')].filter(li => !li.textContent.includes('open seat')).length === 2, null, { timeout: 20000 });
await B.click('#lobby-ready'); await A.waitForTimeout(300);
await A.click('#lobby-ready'); await A.waitForTimeout(400);
await A.click('#lobby-start');
for (const p of [A, B]) await p.waitForFunction(() => window.__game && window.__game.state.phase !== 'lobby', null, { timeout: 25000 });
// jouer un peu pour que le scoreboard se peuple
for (const p of [A, B]) await p.evaluate(() => {
  const g = window.__game;
  g.state.pendingElementPicks = 0;
  g.hud.closeElementPicker();
  g.state.gold = 99999; g.state.phase = 'combat'; g.waves.start(5);
});
await A.waitForTimeout(300);
for (const p of [A, B]) await p.waitForFunction(() => !document.querySelector('#picker')?.classList.contains('open'), null, { timeout: 10000 });
await A.waitForTimeout(4000);

const diag = await B.evaluate(() => {
  const sb = document.querySelector('#scoreboard');
  const rows = [...document.querySelectorAll('.sb-row')].map(li => ({
    id: li.dataset.id, cls: li.className, tab: li.tabIndex, txt: li.textContent.replace(/\s+/g, ' ').trim().slice(0, 40),
  }));
  return {
    scoreboardPresent: !!sb,
    scoreboardVisible: sb ? getComputedStyle(sb).display !== 'none' && getComputedStyle(sb).visibility !== 'hidden' && sb.getBoundingClientRect().width > 0 : false,
    scoreboardOpacity: sb ? getComputedStyle(sb).opacity : null,
    pointerEvents: sb ? getComputedStyle(sb).pointerEvents : null,
    rows,
    onWatchWired: typeof window.__scoreboard?.onWatch === 'function',
  };
});
console.log('DIAG', JSON.stringify(diag, null, 1));

let clicked = null;
try {
  const sel = '.sb-row.watchable';
  await B.waitForSelector(sel, { timeout: 5000 });
  await B.click(sel, { timeout: 5000 });
  clicked = 'ok';
} catch (e) { clicked = 'ECHEC: ' + e.message.split('\n').slice(0,6).join(' | '); }
await B.waitForTimeout(2500);

const after = await B.evaluate(() => ({
  spectating: !!window.__game?.spectating,
  netWatching: window.__net?.watching ?? null,
  barVisible: !!document.querySelector('.spectate-bar, #spectate-bar'),
  remoteCreeps: window.__spectate?.view?.creeps?._liveCount ?? null,
}));
console.log('CLICK', clicked);
console.log('HITTEST', JSON.stringify(await B.evaluate(() => {
  const li = document.querySelector('.sb-row.watchable');
  if (!li) return { row: null };
  const r = li.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  return {
    rowPE: getComputedStyle(li).pointerEvents,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    topEl: top ? `${top.tagName}.${top.className}` : null,
    topPE: top ? getComputedStyle(top).pointerEvents : null,
    listPE: getComputedStyle(li.parentElement).pointerEvents,
    panelPE: getComputedStyle(document.querySelector('#scoreboard')).pointerEvents,
  };
}), null, 1));
console.log('APRES', JSON.stringify(after, null, 1));
// A/B: on neutralise la regle ajoutee et on regarde qui recoit le clic.
console.log('SANS_LA_REGLE', JSON.stringify(await B.evaluate(() => {
  const st = document.createElement('style');
  st.textContent = '.sb-row.watchable{pointer-events:none!important}';
  document.head.appendChild(st);
  const li = document.querySelector('.sb-row.watchable');
  const r = li.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const out = { rowPE: getComputedStyle(li).pointerEvents, topEl: top ? `${top.tagName}.${top.className}` : null };
  st.remove();
  return out;
})));
console.log('ERREURS', errors.slice(0, 6));
await browser.close();
