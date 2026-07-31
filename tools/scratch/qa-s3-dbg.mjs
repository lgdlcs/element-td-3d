import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:5294';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];
const browser = await chromium.launch({ args: ARGS });
const mk = async (n) => {
  const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  p.on('console', (m) => console.log(`[${n} ${m.type()}]`, m.text()));
  p.on('pageerror', (e) => console.log(`[${n} pageerror]`, e.message));
  await p.goto(`${BASE}/?mp&q=low`, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby && !!window.__net, null, { timeout: 60000 });
  await p.waitForFunction(() => window.__net.state === 'online', null, { timeout: 20000 });
  return p;
};
const a = await mk('host'); const b = await mk('guest');
const state = (p) => p.evaluate(() => ({
  lobbyState: window.__lobby.state, conn: window.__lobby.connection,
  err: document.querySelector('#lobby-error')?.textContent.trim(),
  errHidden: document.querySelector('#lobby-error')?.hidden,
  code: document.querySelector('#lobby-code-chars')?.textContent.trim(),
  codeIn: document.querySelector('#lobby-code-in')?.value,
  joinDisabled: document.querySelector('#lobby-join')?.disabled,
  createDisabled: document.querySelector('#lobby-create')?.disabled,
  roster: [...document.querySelectorAll('#lobby-roster li')].map((li) => li.textContent.trim()),
  netRoom: window.__net.room ?? null,
}));
await a.evaluate(() => { const e = document.querySelector('#lobby-name'); e.value = 'Ada'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await a.click('#lobby-create');
await a.waitForTimeout(1500);
console.log('HOST after create', JSON.stringify(await state(a), null, 1));
const code = (await a.textContent('#lobby-code-chars')).trim();
console.log('CODE =', JSON.stringify(code));
await b.evaluate(() => { const e = document.querySelector('#lobby-name'); e.value = 'Bo'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await b.evaluate((c) => { const e = document.querySelector('#lobby-code-in'); e.value = c; e.dispatchEvent(new Event('input', { bubbles: true })); }, code);
console.log('GUEST before join', JSON.stringify(await state(b), null, 1));
await b.click('#lobby-join');
await b.waitForTimeout(2500);
console.log('GUEST after join', JSON.stringify(await state(b), null, 1));
console.log('HOST after join', JSON.stringify(await state(a), null, 1));
await browser.close();
