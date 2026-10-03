/**
 * The dev-only rite sandbox (/rites.html, src/dev/RiteSandbox.js).
 *
 * It mounts the real MinigameHost with no board, so these tests prove that a
 * rite plays to a result there, that the reward is shown and credited to
 * nothing, that Replay really is the same seed, and that the in-game DEV
 * panel Rite row still works and links here.
 */
import { test, expect } from '@playwright/test';
import { VITE_CLIENT_STUB } from './fixtures.js';
import { startRun } from './helpers.js';

async function openSandbox(page, query = '') {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.route('**/@vite/client', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_CLIENT_STUB }));
  await page.goto(`/rites.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__sandbox, null, { timeout: 30000 });
  return errors;
}

const viewReady = (page) => page.waitForFunction(
  () => window.__sandbox.host.isOpen && !window.__sandbox.host._viewPending, null, { timeout: 30000 });

/** Shoot the front-row creep targets where they will be a few frames from now. */
async function shootFrontRow(page, shots) {
  for (let s = 0; s < shots; s++) {
    const aim = await page.evaluate(() => {
      const h = window.__sandbox.host;
      const r = h.instance;
      const i = r.targets.findIndex((t, k) => t.row === 0 && t.kind === 'creep'
        && r.aliveAt(k, r.t) && Math.abs(r.xAt(k, r.t + 0.05)) < 5);
      return i < 0 ? null : h.fieldToClient(r.xAt(i, r.t + 0.05), r.yAt(i));
    });
    if (aim) await page.mouse.click(aim.x, aim.y);
    await page.waitForTimeout(250);
  }
}

test('picker launches Lucky Shot without the board, shows the would-be reward, Replay keeps the seed', async ({ page }) => {
  const errors = await openSandbox(page);
  await expect(page.locator('#sbx-list [data-rite]')).toHaveCount(6);
  expect(await page.evaluate(() => typeof window.__game)).toBe('undefined');

  await page.fill('#sbx-wave', '12');
  await page.click('[data-rite="luckyshot"]');
  await viewReady(page);
  const layout = () => page.evaluate(() => JSON.stringify(window.__sandbox.host.instance.targets.map((t) => [t.kind, t.lane])));
  const first = await layout();
  const seed = await page.evaluate(() => window.__sandbox.run.seed);
  expect(page.url()).toContain(`rite=luckyshot&wave=12&seed=${seed}`);

  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__sandbox.host.mode === 'play');
  await shootFrontRow(page, 8);
  await page.waitForFunction(() => window.__sandbox.host.mode === 'result', null, { timeout: 45000 });
  await page.click('#rite-continue');

  await expect(page.locator('#sbx')).toHaveAttribute('data-mode', 'done');
  const res = await page.textContent('#sbx-res');
  const gold = Number(/would have paid (\d+) gold/.exec(res)?.[1]);
  expect(gold).toBeGreaterThan(0);

  await page.keyboard.press('KeyR');
  await viewReady(page);
  expect(await page.evaluate(() => window.__sandbox.run.seed)).toBe(seed);
  expect(await layout()).toBe(first);
  expect(errors).toEqual([]);
});

test('?rite= opens Game Hunt directly with the query params, and abandoning returns to the list', async ({ page }) => {
  const errors = await openSandbox(page, '?rite=hunt&wave=20&seed=1234&q=low');
  await viewReady(page);
  expect(await page.evaluate(() => {
    const { host, run } = window.__sandbox;
    return { id: host.def.id, wave: host.wave, occ: host.occurrence, seed: run.seed, q: run.quality };
  })).toEqual({ id: 'hunt', wave: 20, occ: 3, seed: 1234, q: 'low' });

  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__sandbox.host.mode === 'play');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__sandbox.host.mode === 'result');
  await page.keyboard.press('Enter');
  await expect(page.locator('#sbx-res')).toContainText('abandoned, would have paid 0 gold');

  await page.click('[data-act="reseed"]');
  await viewReady(page);
  expect(await page.evaluate(() => window.__sandbox.run.seed)).not.toBe(1234);
  await page.click('#rite-skip');
  await page.waitForFunction(() => window.__sandbox.host.mode === 'result');
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyB');
  await expect(page.locator('#sbx')).toHaveAttribute('data-mode', 'pick');
  expect(new URL(page.url()).search).toBe('?q=low');
  expect(errors).toEqual([]);
});

test('the in-game DEV panel Rite row still launches a rite, and its sandbox button opens rites.html', async ({ page, context }) => {
  const { errors } = await startRun(page, { freeze: true });
  await page.keyboard.press('F9');
  await page.selectOption('#dev-rite', 'luckyshot');
  await page.click('[data-act="rite"]');
  await page.waitForSelector('#rite.open', { timeout: 15000 });
  expect(await page.evaluate(() => window.__game.minigames.def.id)).toBe('luckyshot');
  await page.click('#rite-skip');
  await page.waitForFunction(() => window.__game.minigames.mode === 'result');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !window.__game.minigames.isOpen);

  const seed = await page.evaluate(() => window.__game.seed);
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('[data-act="sandbox"]')]);
  await popup.waitForFunction(() => window.__sandbox?.host.isOpen, null, { timeout: 30000 });
  expect(await popup.evaluate(() => [window.__sandbox.host.def.id, window.__sandbox.run.seed]))
    .toEqual(['luckyshot', seed]);
  expect(errors).toEqual([]);
});
