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
