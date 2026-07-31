/**
 * QA scenario 3 — SINGLE-PORT HOSTING.
 *
 * The claim under test: `npm run build` + `PORT=5294 node server/index.js` is
 * the WHOLE deployment. So this loads the real built page from that one port in
 * a real browser and asserts three things that a curl cannot:
 *
 *   a) every subresource the page actually requests returns < 400 (no 404 on a
 *      hashed asset, which is the classic broken-deploy symptom),
 *   b) the console and the page are error-free and the game finishes booting,
 *   c) two browsers reach the lobby over the WebSocket ON THE SAME PORT, create
 *      and join a room, and a run actually starts on both.
 *
 * Nothing is served from vite here — the vite dev server is not even required
 * to be running.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5294';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const R = {};
const browser = await chromium.launch({ args: ARGS });

// ---- a + b: the page loads whole from one port ----------------------------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => requests.push({ url: r.url(), status: r.status() }));

  await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
  await page.waitForTimeout(4000);

  R.singlePort = {
    origin: BASE,
    // Every response, so a 404 on any asset is visible rather than inferred.
    responses: requests.map((r) => `${r.status} ${r.url.replace(BASE, '')}`),
    bad: requests.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`),
    allSameOrigin: requests.every((r) => r.url.startsWith(BASE)),
    booted: await page.evaluate(() => !!window.__game && !document.getElementById('boot')),
    canvasPainted: await page.evaluate(() => {
      const c = document.getElementById('viewport');
      return !!c && c.width > 0 && c.height > 0;
    }),
    // Proof it is the BUILT bundle and not a dev server.
    scriptSrc: await page.evaluate(() =>
      [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'))),
    errors,
  };
  await page.close();
}

// ---- c: a multiplayer run starts on the same port -------------------------
{
  const mkPage = async (name) => {
    const p = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const errs = [];
    p.on('pageerror', (e) => errs.push(`${name} pageerror: ` + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(`${name} console: ` + m.text()); });
    // `?mp` forces the lobby (webdriver otherwise boots straight to solo).
    // No `?server=`: the point is that the default URL resolves to THIS port.
    await p.goto(`${BASE}/?mp&q=low`, { waitUntil: 'load' });
    await p.waitForFunction(() => !!window.__lobby && !!window.__net, null, { timeout: 60000 });
    return { p, errs };
  };

  const a = await mkPage('host');
  const b = await mkPage('guest');

  const wsUrl = await a.p.evaluate(() => window.__net._url);
  await a.p.waitForFunction(() => window.__net.state === 'online', null, { timeout: 20000 });
  await b.p.waitForFunction(() => window.__net.state === 'online', null, { timeout: 20000 });

  const setName = async (pg, name) => pg.evaluate((n) => {
    const el = document.querySelector('#lobby-name');
    el.value = n; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, name);

  await setName(a.p, 'Ada');
  await a.p.click('#lobby-create');
  await a.p.waitForFunction(() => document.querySelector('#lobby-code-chars')?.textContent.trim().length === 4,
    null, { timeout: 20000 });
  const code = (await a.p.textContent('#lobby-code-chars')).trim();

  await setName(b.p, 'Bo');
  await b.p.evaluate((c) => {
    const el = document.querySelector('#lobby-code-in');
    el.value = c; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, code);
  await b.p.click('#lobby-join');
  // The roster always renders six <li>: four of them are "open seat" placeholders.
  const occupied = () => [...document.querySelectorAll('#lobby-roster li')]
    .filter((li) => !li.textContent.includes('open seat')).length;
  await a.p.waitForFunction(() => [...document.querySelectorAll('#lobby-roster li')]
    .filter((li) => !li.textContent.includes('open seat')).length === 2, null, { timeout: 20000 });

  await b.p.click('#lobby-ready');
  await a.p.waitForTimeout(400);
  await a.p.click('#lobby-ready');
  await a.p.waitForTimeout(500);
  const startVisible = await a.p.evaluate(() => {
    const el = document.querySelector('#lobby-start');
    return { hidden: el.hidden, disabled: el.disabled };
  });
  await a.p.click('#lobby-start');

  const running = async (pg) => pg.waitForFunction(
    () => window.__game && window.__game.state.phase !== 'lobby', null, { timeout: 25000 }).then(() => true).catch(() => false);
  const aRun = await running(a.p);
  const bRun = await running(b.p);
  await a.p.waitForTimeout(4000);

  const snap = async (pg) => pg.evaluate(() => ({
    seed: window.__game.seed,
    phase: window.__game.state.phase,
    wave: window.__game.state.wave,
    lobbyHidden: document.getElementById('lobby')?.hidden !== false,
    rosterInScoreboard: document.querySelectorAll('#scoreboard .sb-list li').length,
  }));
  const sa = await snap(a.p);
  const sb = await snap(b.p);

  R.multiplayer = {
    wsUrl,
    wsUrlUsesSamePort: wsUrl === `ws://localhost:5294/ws`,
    code,
    startVisible,
    hostStarted: aRun, guestStarted: bRun,
    host: sa, guest: sb,
    seedsMatch: sa.seed === sb.seed,
    errors: [...a.errs, ...b.errs],
  };
  await a.p.close();
  await b.p.close();
}

console.log(JSON.stringify(R, null, 2));
await browser.close();
