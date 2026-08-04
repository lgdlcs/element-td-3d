import { test, expect } from '@playwright/test';
import { startRun, readState, FIRE_COST, SELL_REFUND } from './helpers.js';

/**
 * Every keyboard shortcut Game.js binds today, doing what the UI says it does.
 *
 * Most of these run with the simulation PAUSED. That is not a workaround: the
 * key handlers are wired on `window` and call straight into Game, and `paused`
 * only gates #step inside frame(). Space still sends the wave, U still upgrades.
 * Freezing the sim just removes the prep countdown and the interest clock from
 * the assertions.
 *
 * Deliberately NOT covered here (they belong to other modules and other specs):
 * F/B/QWERTY (BuildBar), arrows and Enter (Picker), G and F8 (PerfHud), WASD and
 * Q/E (CameraRig).
 */
test.describe('shortcuts', () => {
  test('Space sends the next wave', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    const before = await readState(page);
    expect(before.phase).toBe('prep');
    expect(before.wave).toBe(0);

    await page.keyboard.press('Space');

    const after = await readState(page);
    expect(after.phase).toBe('combat');
    expect(after.wave).toBe(1);
    // Sending early pays a bonus of round(prepTimer * 2) — the toast announces it.
    expect(after.gold).toBeGreaterThan(before.gold);
    await expect(page.locator('#toast')).toContainText('Early send bonus');

    // A second Space during combat is a no-op: startWaveNow bails unless the
    // phase is 'prep'.
    await page.keyboard.press('Space');
    expect((await readState(page)).wave).toBe(1);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('P pauses and resumes, and the HUD button follows', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], freeze: false });

    expect((await readState(page)).paused).toBe(false);
    await expect(page.locator('#pause-btn')).toHaveAttribute('aria-label', 'Pause');

    await page.keyboard.press('p');
    await expect.poll(() => page.evaluate(() => window.__game.state.paused)).toBe(true);
    await expect(page.locator('#pause-btn')).toHaveClass(/\bpaused\b/);
    await expect(page.locator('#pause-btn')).toHaveAttribute('aria-label', 'Resume');

    // While paused the wave clock really is stopped.
    const t0 = await page.evaluate(() => window.__game.state.prepTimer);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__game.state.prepTimer)).toBe(t0);

    await page.keyboard.press('p');
    await expect.poll(() => page.evaluate(() => window.__game.state.paused)).toBe(false);
    await expect(page.locator('#pause-btn')).not.toHaveClass(/\bpaused\b/);
    await expect(page.locator('#pause-btn')).toHaveAttribute('aria-label', 'Pause');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('1 / 2 / 3 set the simulation speed', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    expect((await readState(page)).speed).toBe(1);

    for (const n of [3, 2, 1]) {
      await page.keyboard.press(String(n));
      await expect.poll(() => page.evaluate(() => window.__game.state.speed)).toBe(n);
      await expect(page.locator(`#speed-buttons button[data-speed="${n}"]`))
        .toHaveAttribute('aria-pressed', 'true');
    }

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('U upgrades the selected tower', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 1000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    const before = await readState(page);
    expect(await page.evaluate(() => window.__game.towers.towers[0].level)).toBe(0);

    await page.keyboard.press('u');

    await expect.poll(() => page.evaluate(() => window.__game.towers.towers[0].level)).toBe(1);
    expect((await readState(page)).gold).toBe(before.gold - FIRE_COST[1]);
    await expect(page.locator('#inspector .ih-level')).toContainText('Level 2 of 3');

    // U with nothing selected does nothing and throws nothing.
    await page.evaluate(() => window.__game.selectTower(null));
    await page.keyboard.press('u');
    expect(await page.evaluate(() => window.__game.towers.towers[0].level)).toBe(1);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('M opens the morph sheet on the selected tower', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 5000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    // The stats view first.
    expect(await page.evaluate(() => window.__game.hud.inspector.view)).not.toBe('morph');

    await page.keyboard.press('m');

    await expect.poll(() => page.evaluate(() => window.__game.hud.inspector.view)).toBe('morph');
    await expect(page.locator('#inspector')).toHaveClass(/\bmorph\b/);
    await expect(page.locator('#inspector .morph-sheet')).toHaveCount(1);
    // Water is bound, so at least the Water pure tower is offered as a target.
    await expect(page.locator('#inspector [data-morph="water"]')).toHaveCount(1);
    // Opening the sheet commits nothing.
    expect(await page.evaluate(() => window.__game.towers.towers.length)).toBe(1);
    expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('fire');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('X sells the selected tower and refunds it', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 1000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    const before = await readState(page);
    expect(before.towers).toBe(1);

    await page.keyboard.press('x');

    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(0);
    const after = await readState(page);
    expect(after.gold).toBe(before.gold + Math.floor(FIRE_COST[0] * SELL_REFUND));
    expect(after.selectedTower).toBeNull();
    await expect(page.locator('#inspector')).not.toHaveClass(/\bopen\b/);
    // The four cells are handed back.
    expect(await page.evaluate(() => window.__game.grid.canPlaceTower(10, 8))).toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a shortcut typed into a text field is not a shortcut', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 1000 });

    // There is no <input> on screen during a solo run (the lobby is skipped
    // under Playwright), so the guard needs one to be tested at all.
    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
      const i = document.createElement('input');
      i.id = '__test-input';
      i.type = 'text';
      i.style.cssText = 'position:fixed;left:8px;top:50%;z-index:99999';
      document.body.appendChild(i);
      i.focus();
    });

    const before = await readState(page);
    expect(before.phase).toBe('prep');
    expect(before.towers).toBe(1);

    // Space would send the wave, p would pause, 3 would triple the speed,
    // x would sell the selected tower, u would upgrade it.
    await page.keyboard.type('p3xu');
    await page.keyboard.press('Space');

    const after = await readState(page);
    expect(after.phase).toBe('prep');
    expect(after.paused).toBe(before.paused);
    expect(after.speed).toBe(before.speed);
    expect(after.towers).toBe(1);
    expect(after.gold).toBe(before.gold);
    expect(await page.evaluate(() => window.__game.towers.towers[0].level)).toBe(0);
    // The keys went where they were typed.
    expect(await page.inputValue('#__test-input')).toBe('p3xu ');

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
