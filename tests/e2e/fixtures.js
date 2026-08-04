/**
 * Shared E2E boot helper.
 *
 * Every spec starts the same way: neutralise HMR, load the page, wait for the
 * game object, drop the boot splash, and keep a log of everything the console
 * said. This module is the single place that knows how, so a change to the boot
 * sequence is a one-file edit rather than a hunt through every spec.
 *
 * Usage:
 *
 *     import { test, expect } from '@playwright/test';
 *     import { bootGame } from './fixtures.js';
 *
 *     test('something', async ({ page }) => {
 *       const { errors } = await bootGame(page);
 *       await page.evaluate(() => window.__game.state.gold);
 *       expect(errors).toEqual([]);
 *     });
 */

// Vite's HMR client, replaced by a no-op that satisfies every import the
// transformed modules make of it.
const VITE_CLIENT_STUB =
  'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });' +
  'export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' +
  'export const createHotContextLegacy = () => ({ accept(){}, dispose(){}, invalidate(){}, on(){}, send(){} });';

/**
 * Boot the game in `page` and return handles on it.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [opts]
 * @param {string} [opts.quality='ultra']  value of the ?q= query param
 * @param {string} [opts.query='']         extra query string, e.g. 'seed=1337'
 * @param {number} [opts.timeout=90000]    how long to wait for window.__game
 * @param {boolean} [opts.keepBoot=false]  leave the #boot splash in the DOM
 * @returns {Promise<{
 *   errors: string[],   // page errors + console.error, mutated as they arrive
 *   warnings: string[], // console.warn, mutated as they arrive
 *   logs: string[],     // every console message, prefixed with its type
 * }>}
 */
export async function bootGame(page, opts = {}) {
  const {
    quality = 'ultra',
    query = '',
    timeout = 90000,
    keepBoot = false,
  } = opts;

  // Live arrays. The caller holds the same reference the listeners push into,
  // so asserting on them at the end of a test sees everything that happened.
  const errors = [];
  const warnings = [];
  const logs = [];

  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    logs.push(line);
    if (m.type() === 'error') errors.push(line);
    else if (m.type() === 'warning') warnings.push(line);
  });
  page.on('pageerror', (e) => {
    errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`);
  });

  // Neutralise Vite HMR. The dev server on 5273 is shared with whoever is
  // editing source at the same time; a hot reload mid-test silently rebuilds
  // Game and every piece of state the test set up vanishes, usually surfacing
  // as an inexplicable assertion failure minutes later. Stubbing the client
  // makes the page a sealed snapshot of whatever was on disk when it loaded.
  await page.route('**/@vite/client', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: VITE_CLIENT_STUB,
    }));

  const qs = `?q=${encodeURIComponent(quality)}${query ? `&${query}` : ''}`;
  await page.goto(`/${qs}`, { waitUntil: 'load' });

  // Generous on purpose: a cold module graph plus the procedural texture forge
  // regularly needs far more than the Playwright default of 30s on first run.
  await page.waitForFunction(() => !!window.__game, null, { timeout });

  // The boot splash covers the canvas and would swallow every pointer event.
  if (!keepBoot) {
    await page.evaluate(() => document.getElementById('boot')?.remove());
  }

  return { errors, warnings, logs };
}

/**
 * Advance real time by `ms` and let the render loop run. Prefer this over a
 * bare waitForTimeout in specs so the intent ("let frames happen") is explicit.
 * Several visual states -- the grid overlay opacity ramp in particular -- are
 * exponential eases that only settle after a handful of frames, so reading them
 * immediately after the call that requested them yields the stale value.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [ms=250]
 */
export async function settle(page, ms = 250) {
  await page.waitForTimeout(ms);
}

/**
 * Stand a SILENT server in front of the page: the socket connects and the server
 * never says anything.
 *
 * WHY A SPEC WOULD WANT THIS. Two of lobby-hall.spec.js's states are about a
 * server that is up: "connected, and no board has arrived yet" and "this exact
 * board arrived". Both used to be forced from the inside — `setConnection('online')`,
 * `hud.setLeaderboard([…])` — and both were then destroyed by a real transport
 * event landing afterwards. They failed in OPPOSITE machine configurations, so
 * there was no way to run the suite green on any machine:
 *
 *   with a server on 5274      the injected board is overwritten by the real
 *                              `leaderboard` frame the server broadcasts
 *   with nothing on 5274       NetClient's backoff ladder gives up and main.js
 *                              calls setConnection('offline'), which
 *                              Lobby.setConnection treats as "not connected" and
 *                              which therefore CLEARS the 8s hall timer
 *
 * The second one is a race, and a close one. Measured with
 * tools/scratch/_audit-hall.mjs: the timer was armed at t+2 580 ms and would have
 * fired at t+10 580 ms; the offline verdict landed at t+9 865 ms and disarmed it.
 * It won by 715 ms. Nothing about that margin is stable across machines, so those
 * specs were not testing the hall — they were testing whether this laptop lost a
 * race.
 *
 * WHY NOT `settleConnection` FIRST. That guard polls for a lobby state other than
 * 'connecting', and 'offline' satisfies it — but 'offline' means "not connected
 * yet" as well as "gave up". Measured, it returned after 23 ms while NetClient
 * had another 9.8 s of ladder to walk (BACKOFF_MS = [400, 900, 2000, 4000] plus
 * up to four 2 500 ms open timeouts before `_goOffline`).
 *
 * WHY NOT `net.disconnect()` FROM THE PAGE. Tried, and it is silently undone:
 * main.js publishes `window.__net` at line 99 but does not call `net.connect()`
 * until line 331, and bootGame returns as soon as `window.__game` exists. A
 * disconnect issued in that window clears `_wanted`, and the connect that has not
 * happened yet sets it straight back. It also leaves the lobby reading 'offline',
 * which is the wrong half of the feature: these two specs are about a LIVE
 * connection.
 *
 * So the server is mocked at the socket instead. A `routeWebSocket` handler that
 * does not call `connectToServer()` accepts the upgrade and speaks for the server
 * itself — and this one says nothing, ever. NetClient goes 'online' through its
 * real code path, `requestTop()` goes out and is never answered, so `topReceived`
 * stays false and the hall arms its timer exactly as it would against a server
 * that has no board to send. Nothing can overwrite a board the spec publishes
 * afterwards, because there is no other publisher.
 *
 * MUST BE CALLED BEFORE bootGame — a route cannot be installed on a navigation
 * that has already happened. A spec whose subject is the real transport must
 * obviously not call it at all.
 */
export async function silentServer(page) {
  await page.routeWebSocket('**/ws', () => {
    // Deliberately empty. Not calling connectToServer() is what makes this a
    // mock rather than a proxy: the upgrade is accepted, and no frame is ever
    // sent to the page.
  });
}
