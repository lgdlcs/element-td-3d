import { test, expect } from '@playwright/test';
import {
  startRun, hoverCell, clickCell, readState, footprint,
  gridOverlayState, wallRowExceptGap, toastText, settle,
  START_GOLD, FIRE_COST,
} from './helpers.js';

/**
 * Placing towers: the loop the whole game is made of.
 *
 * Every spec here runs with the simulation PAUSED. Prep counts down to an
 * automatic wave send and interest pays out every 15 simulated seconds, so an
 * exact-gold assertion on an unpaused board is a coin toss. Pausing does not
 * touch the build path: Game.#onClick, placementReason and build() are all
 * driven from pointer events, not from #step.
 *
 * Cell coordinates avoid columns 12-13 on rows 0-1 and 18-19: those are the
 * PATH_ONLY spawn/exit corridors carved by Grid.#carveCorridors.
 */
test.describe('build', () => {
  test('picking a card from the dock arms a build', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    expect((await readState(page)).selectedBuild).toBeNull();

    await page.click('#dock-pure .tcard[data-tower="fire"]');

    await expect.poll(() => page.evaluate(() => window.__game.selectedBuild)).toBe('fire');
    await expect(page.locator('#dock-pure .tcard[data-tower="fire"]')).toHaveClass(/\bselected\b/);
    // The "you are holding a piece" chip in the player's field of view.
    await expect(page.locator('#held-piece')).toHaveClass(/\bon\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the grid overlay fades in while a build is held and back out when it is dropped', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    // Nothing held, nothing selected: the overlay is off.
    await page.click('#dock-pure .tcard[data-tower="fire"]');
    await hoverCell(page, 10, 8);

    // setGridVisible() only sets a target; Arena.update eases uOpacity towards
    // it. Assert the instruction AND the ramp that follows it.
    expect((await gridOverlayState(page)).target).toBe(1);
    await expect.poll(
      () => gridOverlayState(page).then((s) => s.visible && s.opacity > 0.5),
      { message: 'grid overlay never ramped up under a held build' },
    ).toBe(true);

    // Instrument control (docs/PITFALLS.md §11): the same measurement must be
    // able to produce the OTHER answer, or "it was visible" proves nothing.
    await page.keyboard.press('Escape');
    expect((await gridOverlayState(page)).target).toBe(0);
    await expect.poll(
      () => gridOverlayState(page).then((s) => !s.visible),
      { message: 'grid overlay never faded out after Escape' },
    ).toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the hover ghost reports a free cell as valid', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    await hoverCell(page, 10, 8);

    const hover = await page.evaluate(() => window.__game.hover);
    expect(hover).toMatchObject({ c: 10, r: 8, valid: true, reason: 'valid' });
    // Silent on the valid case, by design — see HUD.showPlacementHint.
    await expect(page.locator('#place-hint')).not.toHaveClass(/\bon\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('clicking a free cell builds the tower, debits the exact cost and occupies 4 cells', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    const before = await readState(page);
    expect(before.gold).toBe(START_GOLD);

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    await clickCell(page, 10, 8);

    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(1);

    const after = await readState(page);
    expect(after.gold).toBe(before.gold - FIRE_COST[0]);

    const t = await page.evaluate(() => {
      const t = window.__game.towers.towers[0];
      return { key: t.key, c: t.c, r: t.r, level: t.level, id: t.id };
    });
    expect(t).toMatchObject({ key: 'fire', c: 10, r: 8, level: 0 });

    // CELL.TOWER === 1 on all four cells, all pointing at the same tower id.
    const fp = await footprint(page, 10, 8);
    expect(fp.cells).toEqual([1, 1, 1, 1]);
    expect(fp.ids).toEqual([t.id, t.id, t.id, t.id]);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('clicking an occupied cell builds nothing and costs nothing', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    await clickCell(page, 10, 8);
    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(1);

    // Re-arm explicitly: build() drops the selection when the purse can no
    // longer afford another one, and this spec must not depend on that.
    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    const before = await readState(page);

    // Same anchor, and also an overlapping one — a 2x2 footprint one cell over
    // is just as refused as an exact repeat.
    await clickCell(page, 10, 8);
    const sameAnchor = await readState(page);
    expect(sameAnchor.towers).toBe(before.towers);
    expect(sameAnchor.gold).toBe(before.gold);
    expect(await toastText(page)).toBe('Something is already there');

    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await clickCell(page, 11, 8);
    const overlapping = await readState(page);
    expect(overlapping.towers).toBe(before.towers);
    expect(overlapping.gold).toBe(before.gold);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a placement that would seal the maze is refused', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    // Wall rows 12-13 off except columns 12-13, so the only way through the
    // board is the two-wide gap a tower would exactly plug.
    const wall = await wallRowExceptGap(page, 12, 12);
    expect(wall.canPlace, 'the gap must be buildable, or the test proves nothing').toBe(true);
    expect(wall.wouldBlock, 'the gap must actually seal, or the test proves nothing').toBe(true);

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    await hoverCell(page, 12, 12);

    // The hover names the reason before the click is even made.
    expect(await page.evaluate(() => window.__game.hover.reason)).toBe('seal');
    await expect(page.locator('#place-hint')).toHaveClass(/\bon\b/);
    await expect(page.locator('#place-hint')).toContainText('Seals the maze');

    const before = await readState(page);
    await clickCell(page, 12, 12);
    const after = await readState(page);

    expect(after.towers).toBe(before.towers);
    expect(after.gold).toBe(before.gold);
    expect(await toastText(page)).toBe('That would seal the maze');
    // Still buildable one row up, where the wall does not close.
    expect(await page.evaluate(() => window.__game.placementReason(12, 9))).toBe('valid');

    await settle(page, 200);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
