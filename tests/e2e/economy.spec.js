import { test, expect } from '@playwright/test';
import {
  startRun, hoverCell, clickCell, readState, toastText,
  FIRE_COST, SELL_REFUND,
} from './helpers.js';

/**
 * The purse: what each action costs, what it gives back, and what happens when
 * there is not enough.
 *
 * Simulation paused throughout. Interest pays 2% of the banked gold every 15
 * simulated seconds (ECONOMY.interestTick) and the prep clock would eventually
 * send a wave whose bounties pay out too — either would turn every exact figure
 * below into an approximation.
 */
test.describe('economy', () => {
  test('upgrading debits exactly the next level cost, and a maxed tower refuses', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 2000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });

    let gold = (await readState(page)).gold;
    expect(gold).toBe(2000 - FIRE_COST[0]);

    // Level 0 -> 1 -> 2, each debited at the level's own price.
    for (const lv of [1, 2]) {
      await page.evaluate(() => window.__game.upgradeTower(window.__game.selectedTower));
      const s = await readState(page);
      expect(await page.evaluate(() => window.__game.towers.towers[0].level)).toBe(lv);
      expect(s.gold).toBe(gold - FIRE_COST[lv]);
      gold = s.gold;
    }

    // Level 2 is the top of a pure tower's three levels.
    await page.evaluate(() => window.__game.upgradeTower(window.__game.selectedTower));
    expect(await page.evaluate(() => window.__game.towers.towers[0].level)).toBe(2);
    expect((await readState(page)).gold).toBe(gold);
    expect(await toastText(page)).toBe('Max level');
    await expect(page.locator('#insp-upgrade')).toBeDisabled();

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('selling refunds 75% of everything that went into the tower', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 2000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      const id = g.towers.towers[0].id;
      g.selectTower(id);
      g.upgradeTower(id);        // level 1
      g.upgradeTower(id);        // level 2
    });

    const spent = FIRE_COST[0] + FIRE_COST[1] + FIRE_COST[2];   // 520
    const before = await readState(page);
    expect(before.gold).toBe(2000 - spent);

    await page.evaluate(() => window.__game.sellTower(window.__game.selectedTower));

    const after = await readState(page);
    expect(after.towers).toBe(0);
    expect(after.gold).toBe(before.gold + Math.floor(spent * SELL_REFUND));
    // Selling is a 25% haircut on the whole investment, never a way to profit.
    expect(after.gold).toBeLessThan(2000);
    expect(await page.evaluate(() => window.__game.grid.canPlaceTower(10, 8))).toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a purse that cannot afford the tower refuses the placement', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: FIRE_COST[0] - 1 });

    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await hoverCell(page, 10, 8);

    // The hover says so before the click.
    expect(await page.evaluate(() => window.__game.hover.reason)).toBe('poor');
    await expect(page.locator('#place-hint')).toHaveClass(/\bon\b/);
    await expect(page.locator('#place-hint')).toContainText('Not enough gold');

    const before = await readState(page);
    await clickCell(page, 10, 8);
    const after = await readState(page);

    expect(after.towers).toBe(0);
    expect(after.gold).toBe(before.gold);
    expect(await toastText(page)).toBe('Not enough gold');
    expect(await page.evaluate(() => window.__game.grid.canPlaceTower(10, 8))).toBe(true);

    // One more gold and the same click goes through — the refusal really was
    // about the price and nothing else.
    await page.evaluate(() => { window.__game.state.gold = 60; });
    await clickCell(page, 10, 8);
    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(1);
    expect((await readState(page)).gold).toBe(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});

/**
 * THE PURSE FLOOR.
 *
 * Four identical guards protect it — build (Game.js:711), convertTower (:783),
 * morphTower (:880) and upgradeTower (:942) — and only the first was exercised.
 * Deleting any of the other three lets `state.gold -= cost` run unguarded, the
 * top bar renders a negative number, and 257 tests stay green. `grep -rn
 * "toBeGreaterThanOrEqual(0)" tests/` for gold returned nothing at all.
 *
 * Each case below is the same three-part shape, because two of the three parts
 * are what make it evidence rather than decoration:
 *   1. at cost - 1 the action is REFUSED and nothing moved;
 *   2. gold never goes negative;
 *   3. at exactly cost the action SUCCEEDS and the purse lands on 0 — the
 *      control that proves the refusal was about the price and not about some
 *      unrelated precondition being wrong.
 */
test.describe('economy — the guards nobody was testing', () => {
  test('upgradeTower refuses at one gold short, and takes the last coin at exactly cost',
    async ({ page }) => {
      const { errors } = await startRun(page, { elements: ['fire'], gold: 2000 });
      await page.evaluate(() => {
        const g = window.__game;
        g.build('fire', 10, 8);
        g.setBuildSelection(null);
        g.selectTower(g.towers.towers[0].id);
      });

      const cost = await page.evaluate(() => {
        const t = window.__game.towers.towers[0];
        return t.def.levels[t.level + 1].cost;
      });
      expect(cost).toBeGreaterThan(0);

      await page.evaluate((c) => { window.__game.state.gold = c - 1; }, cost);
      await page.keyboard.press('u');            // the advertised route, not the method
      let s = await readState(page);
      expect(await page.evaluate(() => window.__game.towers.towers[0].level),
        'the upgrade went through on an unaffordable purse').toBe(0);
      expect(s.gold).toBe(cost - 1);
      expect(s.gold, 'the purse went negative').toBeGreaterThanOrEqual(0);
      expect(await toastText(page)).toBe('Not enough gold');

      // The control.
      await page.evaluate((c) => { window.__game.state.gold = c; }, cost);
      await page.keyboard.press('u');
      await expect.poll(() => page.evaluate(() => window.__game.towers.towers[0].level)).toBe(1);
      s = await readState(page);
      expect(s.gold).toBe(0);
      expect(s.gold).toBeGreaterThanOrEqual(0);

      expect(errors, errors.join('\n')).toEqual([]);
    });

  test('morphTower refuses at one gold short, and spends exactly the quoted price',
    async ({ page }) => {
      const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 4000 });
      await page.evaluate(() => {
        const g = window.__game;
        g.build('fire', 10, 8);
        g.setBuildSelection(null);
        g.selectTower(g.towers.towers[0].id);
      });

      // The price the Inspector would show. morphCost is pure, so the panel and
      // the charge cannot disagree — which is exactly why the test quotes it.
      const cost = await page.evaluate(() => {
        const g = window.__game;
        return g.morphCost(g.towers.towers[0], 'water');
      });
      expect(cost).toBeGreaterThan(0);

      await page.evaluate((c) => { window.__game.state.gold = c - 1; }, cost);
      const ok = await page.evaluate(() =>
        window.__game.morphTower(window.__game.towers.towers[0].id, 'water'));
      expect(ok, 'the morph went through on an unaffordable purse').toBe(false);
      let s = await readState(page);
      expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('fire');
      expect(s.gold).toBe(cost - 1);
      expect(s.gold, 'the purse went negative').toBeGreaterThanOrEqual(0);
      expect(await toastText(page)).toBe('Not enough gold');

      // The control: at exactly the price it goes through and the purse empties.
      await page.evaluate((c) => { window.__game.state.gold = c; }, cost);
      expect(await page.evaluate(() =>
        window.__game.morphTower(window.__game.towers.towers[0].id, 'water'))).toBe(true);
      s = await readState(page);
      expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('water');
      expect(s.gold).toBe(0);
      expect(s.gold).toBeGreaterThanOrEqual(0);

      expect(errors, errors.join('\n')).toEqual([]);
    });

  test('convertTower refuses at one gold short, and arms at exactly the quoted price',
    async ({ page }) => {
      const { errors } = await startRun(page, { elements: ['fire'], gold: 4000 });
      await page.evaluate(() => {
        const g = window.__game;
        g.build('foundation', 10, 8);
        g.setBuildSelection(null);
        g.selectTower(g.towers.towers[0].id);
      });
      expect(await page.evaluate(() => window.__game.heldFoundation?.def.kind),
        'the foundation is not armed for conversion').toBe('inert');

      const cost = await page.evaluate(() => window.__game.convertCost('fire'));
      expect(cost).toBeGreaterThan(0);

      await page.evaluate((c) => { window.__game.state.gold = c - 1; }, cost);
      const ok = await page.evaluate(() =>
        window.__game.convertTower(window.__game.selectedTower, 'fire'));
      expect(ok, 'the arming went through on an unaffordable purse').toBe(false);
      let s = await readState(page);
      expect(await page.evaluate(() => window.__game.towers.towers[0].def.kind)).toBe('inert');
      expect(s.gold).toBe(cost - 1);
      expect(s.gold, 'the purse went negative').toBeGreaterThanOrEqual(0);
      expect(await toastText(page)).toBe('Not enough gold');

      await page.evaluate((c) => { window.__game.state.gold = c; }, cost);
      expect(await page.evaluate(() =>
        window.__game.convertTower(window.__game.selectedTower, 'fire'))).toBe(true);
      s = await readState(page);
      expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('fire');
      expect(s.gold).toBe(0);
      expect(s.gold).toBeGreaterThanOrEqual(0);

      expect(errors, errors.join('\n')).toEqual([]);
    });
});
