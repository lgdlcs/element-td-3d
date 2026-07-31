/**
 * SCENARIO 3 - SINGLE-PORT HOSTING.
 * `node server/index.js` must serve dist/ AND the WebSocket from one port. This
 * loads the built game from that port in a real browser, records every network
 * response and every console message, then drives two clients through the real
 * lobby DOM (create / join / ready / start) to prove the socket lives on the
 * same origin as the page.
 *
 * Usage: node tools/scratch/v3-hosting.mjs [baseUrl]   (default http://localhost:5294)
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5294';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const log = (k, v) => console.log(`${k}: ${JSON.stringify(v)}`);
const browser = await chromium.launch({ args: ARGS });

/** One instrumented page: every response, console error and failed request. */
function makePage(ctx, tag) {
  const rec = { tag, responses: [], errors: [], failed: [], ws: [] };
  return ctx.newPage({ viewport: { width: 1280, height: 800 } }).then((page) => {
    page.on('response', (r) => rec.responses.push({ url: r.url(), status: r.status() }));
    page.on('requestfailed', (r) => rec.failed.push({ url: r.url(), err: r.failure()?.errorText }));
    page.on('console', (m) => { if (m.type() === 'error') rec.errors.push(m.text()); });
    page.on('pageerror', (e) => rec.errors.push(`pageerror: ${e.message}`));
    page.on('websocket', (ws) => rec.ws.push(ws.url()));
    return { page, rec };
  });
}

const ctx = await browser.newContext();
const A = await makePage(ctx, 'host');
const B = await makePage(ctx, 'guest');

// ---- A. the page loads entirely from this one port -------------------------
await A.page.goto(`${BASE}/?mp&q=low`, { waitUntil: 'load' });
await A.page.waitForFunction(() => window.__game, null, { timeout: 45000 });
await A.page.waitForTimeout(3000);

const origin = new URL(BASE).origin;
log('A_load', {
  responses: A.rec.responses.length,
  offOrigin: A.rec.responses.filter((r) => !r.url.startsWith(origin)).map((r) => r.url),
  notOk: A.rec.responses.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`),
  requestFailed: A.rec.failed,
  consoleErrors: A.rec.errors,
  websockets: A.rec.ws,
});
log('A_assets', A.rec.responses.map((r) => `${r.status} ${new URL(r.url).pathname}`));
log('A_healthz', await (await fetch(`${BASE}/healthz`)).text());
log('A_spa404', await (async () => {
  const r = await fetch(`${BASE}/no/such/route`);
  return { status: r.status, type: r.headers.get('content-type') };
})());

// ---- B. a multiplayer run starts on this same port --------------------------
await A.page.waitForSelector('#lobby:not([hidden])', { timeout: 20000 });
await A.page.fill('#lobby-name', 'HostAlpha');
await A.page.click('#lobby-create');
await A.page.waitForFunction(
  () => (document.querySelector('#lobby-code-chars')?.textContent || '').trim().length >= 4,
  null, { timeout: 20000 });
const code = (await A.page.textContent('#lobby-code-chars')).trim();
log('B_roomCode', code);

await B.page.goto(`${BASE}/?mp&q=low`, { waitUntil: 'load' });
await B.page.waitForFunction(() => window.__game, null, { timeout: 45000 });
await B.page.waitForSelector('#lobby:not([hidden])', { timeout: 20000 });
await B.page.fill('#lobby-name', 'GuestBravo');
await B.page.fill('#lobby-code-in', code);
await B.page.click('#lobby-join');

await A.page.waitForFunction(
  () => document.querySelectorAll('#lobby-roster li').length >= 2, null, { timeout: 20000 });
log('B_roster', await A.page.$$eval('#lobby-roster li', (ns) =>
  ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim())));

await A.page.click('#lobby-ready');
await B.page.click('#lobby-ready');
await A.page.waitForTimeout(800);
await A.page.waitForSelector('#lobby-start:not([hidden])', { timeout: 20000 });
await A.page.click('#lobby-start');

// Both clients must leave 'lobby' and land on the SAME seed the server handed out.
for (const p of [A, B]) {
  await p.page.waitForFunction(() => window.__game.state.phase !== 'lobby', null, { timeout: 25000 });
}
log('B_started', {
  host: await A.page.evaluate(() => ({
    phase: window.__game.state.phase, seed: window.__game.seed,
    net: window.__net.state, code: window.__net.code, url: window.__net._url,
  })),
  guest: await B.page.evaluate(() => ({
    phase: window.__game.state.phase, seed: window.__game.seed,
    net: window.__net.state, code: window.__net.code, url: window.__net._url,
  })),
});

// Play a little so `status` frames flow and the scoreboard proves the relay works.
for (const p of [A, B]) {
  await p.page.evaluate(() => {
    const g = window.__game;
    g.state.pendingElementPicks = 1; g.chooseElement('fire');
    g.state.gold = 100000; g.setSpeed(3);
  });
}
await A.page.waitForTimeout(1500);
for (const p of [A, B]) {
  await p.page.evaluate(() => { if (window.__game.state.phase === 'prep') window.__game.startWaveNow(); });
}
await A.page.waitForTimeout(8000);

log('B_scoreboard', {
  hostRows: await A.page.$$eval('#scoreboard .sb-list li', (ns) =>
    ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim())).catch(() => 'no rows'),
  hostWave: await A.page.evaluate(() => window.__game.state.wave),
  guestWave: await B.page.evaluate(() => window.__game.state.wave),
});

log('C_finalErrors', { host: A.rec.errors, guest: B.rec.errors });
log('C_finalNotOk', {
  host: A.rec.responses.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`),
  guest: B.rec.responses.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`),
});
log('C_websockets', { host: A.rec.ws, guest: B.rec.ws });

await browser.close();
