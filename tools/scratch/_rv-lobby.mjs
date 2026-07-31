import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const errs = [];
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=low&mp', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__lobby, null, { timeout: 120000 });
await p.waitForTimeout(2500);
const say = (k, v) => console.log(k + ' :: ' + JSON.stringify(v));

say('conn/state', await p.evaluate(() => ({ state: window.__lobby.state, conn: window.__lobby.connection, label: document.querySelector('#lobby-conn-text').textContent.trim(), createDisabled: document.querySelector('#lobby-create').disabled })));

const ZW = '​';
const nameCases = [
  ['16+ZWSP', 'abcdefghijklmnop' + ZW],
  ['a+20sp+b', 'a' + ' '.repeat(20) + 'b'],
  ['3xZWSP', ZW + ZW + ZW],
  ['20plain', 'x'.repeat(20)],
  ['ok', 'Ada'],
];
for (const [k, v] of nameCases) {
  const r = await p.evaluate((val) => {
    const n = document.querySelector('#lobby-name');
    n.value = val; n.dispatchEvent(new Event('input', { bubbles: true }));
    return { note: document.querySelector('#lobby-name-note').textContent.trim(), createDisabled: document.querySelector('#lobby-create').disabled, lobbyName: window.__lobby.name };
  }, v);
  say('F1 ' + k, r);
}

say('F2 redundant', await p.evaluate(() => {
  const ci = document.querySelector('#lobby-code-in');
  ci.focus(); ci.value = 'AB'; ci.dispatchEvent(new Event('input', { bubbles: true }));
  const before = document.activeElement.id;
  window.__lobby.setState('idle'); window.__lobby.setState('idle');
  return { before, after: document.activeElement.id, code: ci.value };
}));
await p.waitForTimeout(150);
say('F2 after rAF', await p.evaluate(() => document.activeElement.id));
await p.evaluate(() => window.__lobby.setState('connecting'));
await p.waitForTimeout(150);
say('F2 focus after real transition', await p.evaluate(() => document.activeElement.id));
await p.evaluate(() => window.__lobby.setState('idle'));
await p.waitForTimeout(150);

say('F3 ariaModal', await p.evaluate(() => document.querySelector('#lobby').getAttribute('aria-modal')));
async function ring(n, shift) {
  const out = [];
  for (let i = 0; i < n; i++) {
    await p.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    out.push(await p.evaluate(() => {
      const a = document.activeElement;
      const inside = document.querySelector('#lobby').contains(a);
      const vis = a.offsetParent !== null;
      return (a.id || a.tagName) + (inside ? '' : ' [OUT]') + (vis ? '' : ' [INVISIBLE]');
    }));
  }
  return out;
}
await p.evaluate(() => document.querySelector('#lobby-solo').focus());
say('F3 fwd from solo x8', await ring(8, false));
await p.evaluate(() => document.querySelector('#lobby-name').focus());
say('F3 back from name x5', await ring(5, true));
await p.evaluate(() => { const l = window.__lobby; l.setState('lobby'); l.setConnection('online'); l.setCode('WGNP'); l.setPlayers([{ id: 'p1', name: 'Ada', host: true }, { id: 'p2', name: 'Bo' }], 'p1'); });
await p.waitForTimeout(250);
say('F3 room fwd x8', await ring(8, false));
await p.evaluate(() => { document.activeElement.blur(); });
say('F3 from body', await ring(2, false));

say('F4', await p.evaluate(async () => {
  const l = window.__lobby;
  l.hide(); l.show(); l.hide();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const el = document.querySelector('#lobby');
  return { open: el.classList.contains('open'), hidden: el.hidden };
}));
say('F4 next show transitions', await p.evaluate(async () => {
  const l = window.__lobby; l.show();
  const el = document.querySelector('#lobby');
  const immediate = el.classList.contains('open');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { openImmediatelyAfterShow: immediate, openAfterFrame: el.classList.contains('open') };
}));

say('F5', await p.evaluate(() => {
  const l = window.__lobby; l.setState('lobby'); l.setConnection('online');
  l.setPlayers(Array.from({ length: 9 }, (_, i) => ({ id: 'x' + i, name: 'P' + i, host: i === 0 })), 'x0');
  return { count: document.querySelector('#lobby-count').textContent.trim(), rows: document.querySelectorAll('#lobby-roster li').length };
}));
say('F5 bad names', await p.evaluate(() => {
  const l = window.__lobby;
  l.setPlayers([{ id: 'a' }, { id: 'b', name: null }, { id: 'c', name: {} }, { id: 'd', name: 12 }, { id: 'e', name: '​​' }, { id: 'f', name: 'Real' }], 'f');
  return [...document.querySelectorAll('#lobby-roster li')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
}));
say('F5 startBlocker undefined host', await p.evaluate(() => {
  const l = window.__lobby;
  l.setPlayers([{ id: 'f', host: true }, { id: 'g', name: 'Bo' }], 'f');
  return document.querySelector('#lobby-start-note').textContent.trim();
}));
say('F5 elements from names', await p.evaluate(() => {
  window.__lobby.setPlayers([{ id: 'z', name: '<img src=x onerror="window.__xss=1">' }], 'z');
  return { imgs: document.querySelectorAll('#lobby-roster img').length, xss: window.__xss, text: document.querySelector('#lobby-roster li').textContent.trim() };
}));

say('F6', await p.evaluate(() => {
  const l = window.__lobby; l.setState('idle'); l.setConnection('online');
  const n = document.querySelector('#lobby-name'); n.value = 'Ada'; n.dispatchEvent(new Event('input', { bubbles: true }));
  const out = {};
  document.querySelector('#lobby-create').click();
  l.setError('ROOM_FULL', 'No room codes available.');
  out.afterCreate = document.querySelector('#lobby-error').textContent.trim();
  const ci = document.querySelector('#lobby-code-in'); ci.value = 'AB23'; ci.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#lobby-join').click();
  l.setError('ROOM_FULL', 'Room is full.');
  out.afterJoin = document.querySelector('#lobby-error').textContent.trim();
  out.intent = l.intent;
  return out;
}));

say('F7', await p.evaluate(() => {
  const l = window.__lobby; l.setState('connecting');
  return { state: l.state, nameDisabled: document.querySelector('#lobby-name').disabled, codeDisabled: document.querySelector('#lobby-code-in').disabled, createDisabled: document.querySelector('#lobby-create').disabled, joinDisabled: document.querySelector('#lobby-join').disabled };
}));
say('F7 can type while connecting', await p.evaluate(() => {
  const n = document.querySelector('#lobby-name'); n.focus(); n.value = 'Grace'; n.dispatchEvent(new Event('input', { bubbles: true }));
  const c = document.querySelector('#lobby-code-in'); c.value = 'ab23'; c.dispatchEvent(new Event('input', { bubbles: true }));
  return { name: n.value, code: c.value, lobbyName: window.__lobby.name };
}));

say('F8', await p.evaluate(() => {
  const l = window.__lobby; const out = {};
  for (const k of ['idle', 'connecting', 'open', 'online', 'offline', 'reconnecting', 'closed', 'error', 'bogus']) {
    l.setConnection(k);
    out[k] = { text: document.querySelector('#lobby-conn-text').textContent.trim(), cls: document.querySelector('#lobby-conn').className, createDisabled: document.querySelector('#lobby-create').disabled };
  }
  l.setConnection('online');
  return out;
}));

console.log('errs :: ' + JSON.stringify(errs));
await b.close();
