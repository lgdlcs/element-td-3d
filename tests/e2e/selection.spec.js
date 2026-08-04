import { test, expect } from '@playwright/test';
import { startRun, clickCell, readState, gridOverlayState } from './helpers.js';

/**
 * Selecting a standing tower, and getting back out.
 *
 * Note the asymmetry Escape has today: it clears BOTH the queued build and the
 * inspected tower in one keystroke (Game.#wirePointer's Escape case runs
 * setBuildSelection(null) and then selectTower(null)), even though the two can
 * never be set at the same time — setBuildSelection(key) drops the tower
 * selection on its way in. Both halves are asserted separately below.
 */
test.describe('selection', () => {
  test('clicking a standing tower opens the inspector on it', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await clickCell(page, 10, 8);
    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(1);

    // Drop the piece in hand, or the next click would try to build again.
    await page.evaluate(() => window.__game.setBuildSelection(null));
    await expect(page.locator('#inspector')).not.toHaveClass(/\bopen\b/);

    await clickCell(page, 10, 8);

    const id = await page.evaluate(() => window.__game.towers.towers[0].id);
    await expect.poll(() => page.evaluate(() => window.__game.selectedTower)).toBe(id);
    await expect(page.locator('#inspector')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#inspector')).toContainText('Fire Tower');
    // Level 1 of 3 for a freshly built pure tower.
    await expect(page.locator('#inspector .ih-level')).toContainText('Level 1 of 3');
    // The four targeting modes and the three actions the panel offers.
    await expect(page.locator('#inspector [data-mode]')).toHaveCount(4);
    await expect(page.locator('#insp-upgrade')).toHaveCount(1);
    await expect(page.locator('#insp-morph')).toHaveCount(1);
    await expect(page.locator('#insp-sell')).toHaveCount(1);

    // Selecting a tower also raises the grid overlay — it is what carries the
    // range ring, which is painted by the same shader (Arena.#buildGridOverlay).
    expect((await gridOverlayState(page)).target).toBe(1);

    // Clicking empty ground clears the selection again.
    await clickCell(page, 16, 12);
    await expect.poll(() => page.evaluate(() => window.__game.selectedTower)).toBeNull();
    await expect(page.locator('#inspector')).not.toHaveClass(/\bopen\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Escape drops a queued build', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    expect((await readState(page)).selectedBuild).toBe('fire');

    await page.keyboard.press('Escape');

    await expect.poll(() => page.evaluate(() => window.__game.selectedBuild)).toBeNull();
    await expect(page.locator('#dock-pure .tcard[data-tower="fire"]')).not.toHaveClass(/\bselected\b/);
    await expect(page.locator('#held-piece')).not.toHaveClass(/\bon\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Escape deselects an inspected tower and closes the inspector', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    await expect(page.locator('#inspector')).toHaveClass(/\bopen\b/);

    await page.keyboard.press('Escape');

    await expect.poll(() => page.evaluate(() => window.__game.selectedTower)).toBeNull();
    await expect(page.locator('#inspector')).not.toHaveClass(/\bopen\b/);
    // With neither a build nor a tower selected the overlay is asked to fade out.
    expect((await gridOverlayState(page)).target).toBe(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
