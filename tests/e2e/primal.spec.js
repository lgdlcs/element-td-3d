import { test, expect } from '@playwright/test';
import { startRun, clickCell, readState, toastText, SELL_REFUND } from './helpers.js';

/**
 * THE PRIMAL, END TO END, INCLUDING ITS NEW THIRD LEVEL.
 *
 * tests/unit/towerdefs.test.js already freezes the table (three levels,
 * 900/2200/3100, 6 200 fully forged). This file asserts that the game AGREES
 * with the table — that the gold actually leaves the purse in those amounts,
 * that the Inspector calls the third level the last one and not the second, that
 * a fourth upgrade is refused without charging for it, and that selling hands
 * back the right share of everything spent.
 *
 * The third level is the interesting case precisely because nothing in the code
 * hard-codes "two": every consumer reads `def.levels.length`. That means an
 * off-by-one is absorbed silently everywhere rather than throwing, and the only
 * way to catch it is arithmetic on a running game.
 */

/** PRIMAL_STATS.fire. Mirrored so the expectation is written down, not derived. */
const PRIMAL_COST = [900, 2200, 3100];
const PRIMAL_CUMULATIVE = 6200;
/** PRIMAL.stacksRequired / stacksConsumed. */
const STACKS_REQUIRED = 3;
const STACKS_CONSUMED = 2;

/** Three of one element, which is what unlocks the primal card at all. */
const THREE_FIRE = ['fire', 'fire', 'fire'];

const tower = (page) => page.evaluate(() => {
  const t = window.__game.towers.towers[0];
  return t ? { key: t.key, level: t.level, id: t.id, c: t.c, r: t.r } : null;
});

test.describe('primal', () => {
  test('three stacks unlock the card, and building it spends two of them', async ({ page }) => {
    const { errors } = await startRun(page, { elements: THREE_FIRE, gold: 10000 });

    // The dock offers exactly the pure and the primal at three copies — no
    // fusion, because there is only one element bound.
    await expect(page.locator('#dock-primal .tcard[data-tower="primal_fire"]')).toHaveCount(1);
    expect(await page.evaluate(() => window.__game.elementCount('fire'))).toBe(STACKS_REQUIRED);

    const before = await readState(page);
    await page.click('#dock-primal .tcard[data-tower="primal_fire"]');
    await clickCell(page, 10, 8);

    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(1);
    expect(await tower(page)).toMatchObject({ key: 'primal_fire', level: 0, c: 10, r: 8 });

    const after = await readState(page);
    expect(after.gold).toBe(before.gold - PRIMAL_COST[0]);
    expect(after.elements.filter((e) => e === 'fire').length)
      .toBe(STACKS_REQUIRED - STACKS_CONSUMED);
    // The card goes away with the stacks — one primal per three copies is the
    // whole economy of the tier.
    await expect(page.locator('#dock-primal .tcard[data-tower="primal_fire"]')).toHaveCount(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('upgrades twice to level 3, charging 2 200 then 3 100', async ({ page }) => {
    const { errors } = await startRun(page, { elements: THREE_FIRE, gold: 20000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('primal_fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    expect((await tower(page)).level).toBe(0);
    await expect(page.locator('#inspector')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#inspector .ih-level')).toContainText('Level 1 of 3');
    // Three pips, one lit. Two would mean the panel is rendering the old table.
    await expect(page.locator('#inspector .insp-pips i')).toHaveCount(3);
    await expect(page.locator('#inspector .insp-pips i.on')).toHaveCount(1);

    // ---- first upgrade: 2 200 -----------------------------------------
    let gold = (await readState(page)).gold;
    await expect(page.locator('#insp-upgrade')).toContainText('Upgrade');
    await expect(page.locator('#insp-upgrade')).toBeEnabled();
    await page.keyboard.press('u');

    await expect.poll(() => page.evaluate(() => window.__game.towers.towers[0].level)).toBe(1);
    expect((await readState(page)).gold).toBe(gold - PRIMAL_COST[1]);
    await expect(page.locator('#inspector .ih-level')).toContainText('Level 2 of 3');
    await expect(page.locator('#inspector .insp-pips i.on')).toHaveCount(2);

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR: level 2 is NOT the top any more.
    await expect(page.locator('#insp-upgrade')).toBeEnabled();
    await expect(page.locator('#insp-upgrade')).not.toContainText('Fully forged');
    await expect(page.locator('#inspector .ih-max')).toHaveCount(0);
    await expect(page.locator('#inspector .ih-next')).toHaveCount(1);

    // ---- second upgrade: 3 100 ----------------------------------------
    gold = (await readState(page)).gold;
    await page.keyboard.press('u');

    await expect.poll(() => page.evaluate(() => window.__game.towers.towers[0].level)).toBe(2);
    expect((await readState(page)).gold).toBe(gold - PRIMAL_COST[2]);
    await expect(page.locator('#inspector .ih-level')).toContainText('Level 3 of 3');
    await expect(page.locator('#inspector .insp-pips i.on')).toHaveCount(3);

    // ...and NOW it is the top.
    await expect(page.locator('#insp-upgrade')).toBeDisabled();
    await expect(page.locator('#insp-upgrade')).toContainText('Fully forged');
    await expect(page.locator('#inspector .ih-max')).toHaveCount(1);
    await expect(page.locator('#inspector .ih-next')).toHaveCount(0);

    // The whole ladder cost exactly what the table says.
    expect(20000 - (await readState(page)).gold).toBe(PRIMAL_CUMULATIVE);

    // The range ring followed the upgrade — 13.3 at Cataclysm L2.
    const ring = await page.evaluate(() =>
      window.__game.arena.gridMaterial.uniforms.uRange.value);
    expect(ring).toBe(await page.evaluate(() => {
      const g = window.__game;
      return g.towers.stats(g.towers.towers[0]).range;
    }));
    expect(ring).toBe(13.3);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('refuses a fourth upgrade without charging for it', async ({ page }) => {
    const { errors } = await startRun(page, { elements: THREE_FIRE, gold: 20000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('primal_fire', 10, 8);
      g.setBuildSelection(null);
      const id = g.towers.towers[0].id;
      g.upgradeTower(id);
      g.upgradeTower(id);
      g.selectTower(id);
    });
    expect((await tower(page)).level).toBe(2);

    const before = await readState(page);
    await page.keyboard.press('u');
    // Through the button as well as the key: the button is disabled, so this is
    // asserting that the disabled state is real and not only cosmetic.
    await page.evaluate(() => window.__game.upgradeTower(window.__game.towers.towers[0].id));

    const after = await readState(page);
    expect(after.gold).toBe(before.gold);
    expect((await tower(page)).level).toBe(2);
    expect(after.towers).toBe(1);
    expect(await toastText(page)).toBe('Max level');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('sells a fully-forged primal for 4 650 and returns both stacks', async ({ page }) => {
    const { errors } = await startRun(page, { elements: THREE_FIRE, gold: 20000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('primal_fire', 10, 8);
      g.setBuildSelection(null);
      const id = g.towers.towers[0].id;
      g.upgradeTower(id);
      g.upgradeTower(id);
      g.selectTower(id);
    });

    const before = await readState(page);
    expect(before.elements.filter((e) => e === 'fire').length).toBe(1);

    await page.keyboard.press('x');

    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(0);
    const after = await readState(page);

    // floor(6200 * 0.75). The refund is on what was SPENT, so an upgraded tower
    // must pay back more than a fresh one — that relation is the thing a
    // level-count bug breaks, and 4 650 is the arithmetic on all three levels.
    expect(Math.floor(PRIMAL_CUMULATIVE * SELL_REFUND)).toBe(4650);
    expect(after.gold).toBe(before.gold + 4650);

    // Stacks come back in full, at any level: PRIMAL.stacksConsumed is the price
    // of the TILE, not a per-level price.
    expect(after.elements.filter((e) => e === 'fire').length)
      .toBe(1 + STACKS_CONSUMED);
    expect(after.elements.filter((e) => e === 'fire').length).toBe(STACKS_REQUIRED);
    // ...so the card comes back too.
    await expect(page.locator('#dock-primal .tcard[data-tower="primal_fire"]')).toHaveCount(1);

    expect(after.selectedTower).toBeNull();
    await expect(page.locator('#inspector')).not.toHaveClass(/\bopen\b/);
    expect(await page.evaluate(() => window.__game.grid.canPlaceTower(10, 8))).toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('sells a level-1 primal for 675 — the refund tracks what was actually spent', async ({ page }) => {
    // The control for the test above. Without it, "4 650" could be any constant
    // the code happened to produce rather than a function of the ladder.
    const { errors } = await startRun(page, { elements: THREE_FIRE, gold: 20000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('primal_fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });

    const before = await readState(page);
    await page.keyboard.press('x');
    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(0);

    expect((await readState(page)).gold).toBe(before.gold + Math.floor(PRIMAL_COST[0] * SELL_REFUND));
    expect(Math.floor(PRIMAL_COST[0] * SELL_REFUND)).toBe(675);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the tower table advertises three levels and the 6 200 total', async ({ page }) => {
    const { errors } = await startRun(page, { elements: THREE_FIRE, gold: 10000 });

    // The codex is where a player learns what a tier costs before committing to
    // it, and it derives both figures from def.levels — so it is the cheapest
    // place for a stale "2 levels" to survive.
    await page.keyboard.press('f');
    await expect(page.locator('#codex')).toHaveClass(/\bopen\b/);

    const cell = page.locator('#codex [data-tower="primal_fire"]');
    await expect(cell).toHaveCount(1);
    await cell.hover();

    // One shared tooltip node (BuildBar.$tip, id="tip"), filled on hover.
    const tip = page.locator('#tip');
    await expect(tip).toHaveClass(/\bon\b/);
    await expect(tip.locator('.tip-foot')).toContainText('3 levels');
    // uikit.num uses a thin space as the thousands separator, not a comma.
    await expect(tip.locator('.tip-foot')).toContainText(`${6200 .toLocaleString('en-US').replace(/,/g, ' ')} fully forged`);

    await page.keyboard.press('Escape');
    await expect(page.locator('#codex')).not.toHaveClass(/\bopen\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
