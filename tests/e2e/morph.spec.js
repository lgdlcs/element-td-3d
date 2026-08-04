import { test, expect } from '@playwright/test';
import { startRun, readState, toastText, settle } from './helpers.js';

/**
 * MORPHING AND ARMING — the widest coverage hole in the suite, on the two paths
 * that spend gold.
 *
 * Before this file, `grep -rn "morphTower\|convertTower\|morphCost\|convertCost"
 * tests/` returned four COMMENTS and no calls. towerdefs.test.js and
 * config.test.js assert the CONSTANTS and then re-implement the formula inside
 * the test, so they agree with themselves rather than with the code: inverting
 * `paid * ECONOMY.morphCredit` into a divide makes morphs free or negative and
 * leaves the whole suite green.
 *
 * Everything here drives the live game and asserts what a player would notice —
 * the purse, the tower's key, its level, the toast — and every case is a rule
 * the source docblocks state in prose:
 *
 *   - the quoted price is the charged price (morphCost is pure for that reason)
 *   - the per-tile tax makes a boss-wave flip-flop expensive, and SATURATES
 *   - prep only
 *   - a primal cannot morph out
 *   - arming a foundation credits its cost in full and costs 5 gold net
 *   - the purse never goes negative on any of them
 */

/** ECONOMY.morphTax / morphTaxCap. Asserted against the live values below. */
const TAX_STEP = 0.5;
const TAX_CAP = 4;

test.describe('morph', () => {
  test('charges exactly what morphCost quoted, and keeps as much level as the target holds',
    async ({ page }) => {
      const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 20000 });

      await page.evaluate(() => {
        const g = window.__game;
        g.build('fire', 10, 8);
        g.setBuildSelection(null);
        const id = g.towers.towers[0].id;
        g.selectTower(id);
        g.upgradeTower(id);          // level 1
        g.upgradeTower(id);          // level 2, the top of a pure tower
      });
      expect(await page.evaluate(() => window.__game.towers.towers[0].level)).toBe(2);

      const before = await readState(page);
      const quoted = await page.evaluate(() =>
        window.__game.morphCost(window.__game.towers.towers[0], 'steam'));
      expect(quoted, 'nothing to charge, so nothing to prove').toBeGreaterThan(0);

      const ok = await page.evaluate(() =>
        window.__game.morphTower(window.__game.towers.towers[0].id, 'steam'));
      expect(ok).toBe(true);

      const after = await readState(page);
      expect(before.gold - after.gold, 'the charge disagreed with the quote').toBe(quoted);
      expect(after.gold).toBeGreaterThanOrEqual(0);
      expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('steam');
      // A dual has TWO levels, so a source at level 2 keeps level 1 — the
      // `kept = min(t.level, tgt.levels.length - 1)` clamp.
      expect(await page.evaluate(() => window.__game.towers.towers[0].level)).toBe(1);
      // Still one tower, on the same anchor.
      expect(after.towers).toBe(1);
      expect(await page.evaluate(() => {
        const t = window.__game.towers.towers[0];
        return { c: t.c, r: t.r };
      })).toEqual({ c: 10, r: 8 });

      expect(errors, errors.join('\n')).toEqual([]);
    });

  test('carries the tile\'s history across, because towers.create hands back a new object',
    async ({ page }) => {
      // The snapshot in morphTower. Losing `mode` silently resets targeting to
      // 'first'; losing totalDamage/kills zeroes the Contribution panel and skews
      // every other tower's board share.
      const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 20000 });

      await page.evaluate(() => {
        const g = window.__game;
        g.build('fire', 10, 8);
        g.setBuildSelection(null);
        const t = g.towers.towers[0];
        g.selectTower(t.id);
        t.mode = 'strong';
        t.totalDamage = 51200;
        t.kills = 88;
      });

      await page.evaluate(() => window.__game.morphTower(window.__game.towers.towers[0].id, 'water'));
      expect(await page.evaluate(() => {
        const t = window.__game.towers.towers[0];
        return { key: t.key, mode: t.mode, totalDamage: t.totalDamage, kills: t.kills, morphCount: t.morphCount };
      })).toEqual({ key: 'water', mode: 'strong', totalDamage: 51200, kills: 88, morphCount: 1 });

      // The inspector is re-seated on the NEW id, or its buttons fire against a
      // tower byId() resolves to null.
      expect(await page.evaluate(() =>
        window.__game.selectedTower === window.__game.towers.towers[0].id)).toBe(true);
      await expect(page.locator('#inspector')).toHaveClass(/\bopen\b/);

      expect(errors, errors.join('\n')).toEqual([]);
    });

  test('taxes the same tile more every time, and SATURATES at the cap', async ({ page }) => {
    /**
     * The flip-flop tax is the only thing standing between a player and a
     * free boss re-spec: there is a prep phase before wave 30 AND before 31.
     * The multiplier climbs 1.0 / 1.5 / 2.0 / 2.5 / 3.0 and then STOPS, and the
     * stopping is as load-bearing as the climbing — an uncapped tax would make
     * a well-used tile unusable rather than expensive.
     */
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 400000 });
    const econ = await page.evaluate(() => fetch('/src/core/Config.js').then((r) => r.text()));
    expect(econ, 'ECONOMY.morphTax moved').toMatch(new RegExp(`morphTax:\\s*${TAX_STEP}`));
    expect(econ, 'ECONOMY.morphTaxCap moved').toMatch(new RegExp(`morphTaxCap:\\s*${TAX_CAP}`));

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });

    // The same morph, over and over, alternating so the target is always legal.
    const charges = [];
    for (let i = 0; i < TAX_CAP + 2; i++) {
      const to = i % 2 === 0 ? 'water' : 'fire';
      const before = (await readState(page)).gold;
      const quoted = await page.evaluate((k) =>
        window.__game.morphCost(window.__game.towers.towers[0], k), to);
      const ok = await page.evaluate((k) =>
        window.__game.morphTower(window.__game.towers.towers[0].id, k), to);
      expect(ok, `morph ${i} was refused`).toBe(true);
      const after = (await readState(page)).gold;
      expect(before - after, `morph ${i} charged something other than its quote`).toBe(quoted);
      expect(after).toBeGreaterThanOrEqual(0);
      charges.push(quoted);
    }

    // Fire -> water and water -> fire are not the same price, so compare each
    // DIRECTION against itself: charges[0], [2], [4] are fire -> water.
    const even = charges.filter((_, i) => i % 2 === 0);
    for (let i = 1; i < even.length; i++) {
      expect(even[i], `the tax did not climb on repeat ${i}`).toBeGreaterThan(even[i - 1]);
    }
    // The ratio between the first and the third is the tax multiplier walking
    // 1.0 -> 2.0, and nothing else in the formula changed between them: same
    // source key, same target, same level, so `want` and `paid` are identical.
    // Ranged rather than exact because morphCost rounds to whole gold at the
    // END, so a base of 27.5 lands on 28 at 1.0x and on 55 at 2.0x — a real 1.96
    // that is arithmetic, not drift.
    expect(even[1] / even[0], 'the tax step is not ~2x by the third morph')
      .toBeGreaterThan(1.85);
    expect(even[1] / even[0]).toBeLessThan(2.15);

    // ...and it stops. Past the cap, two consecutive morphs in the same
    // direction cost the same.
    const capped = await page.evaluate(async () => {
      const g = window.__game;
      const t = g.towers.towers[0];
      t.morphCount = 40;                                  // far past the cap
      const a = g.morphCost(t, t.key === 'fire' ? 'water' : 'fire');
      t.morphCount = 400;
      const b = g.morphCost(t, t.key === 'fire' ? 'water' : 'fire');
      return { a, b };
    });
    expect(capped.a, 'the morph tax does not saturate').toBe(capped.b);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('is refused once a wave is running, and says so', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 20000, freeze: false });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    await page.evaluate(() => { window.__game.startWaveNow(); });
    await expect.poll(() => page.evaluate(() => window.__game.state.phase)).toBe('combat');
    await page.evaluate(() => { window.__game.state.paused = true; });

    const before = await readState(page);
    const ok = await page.evaluate(() =>
      window.__game.morphTower(window.__game.towers.towers[0].id, 'water'));
    expect(ok).toBe(false);
    expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('fire');
    expect((await readState(page)).gold).toBe(before.gold);
    expect(await toastText(page)).toBe('Morph only between waves');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a primal cannot morph out, at any price', async ({ page }) => {
    /**
     * A primal ate two element stacks. Letting it morph into a cheap fusion
     * would either destroy them (theft) or hand them back (raise a primal, morph
     * it down, keep the stacks AND the fusion). Selling is the supported exit and
     * it returns them; primal.spec.js covers that half.
     */
    const { errors } = await startRun(page, { elements: ['fire'], gold: 20000 });
    await page.evaluate(() => {
      const g = window.__game;
      g.state.elements = ['fire', 'fire', 'fire', 'water'];
      g.hud.refreshBuildBar();
      g.build('primal_fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    expect(await page.evaluate(() => window.__game.towers.towers[0].def.kind)).toBe('primal');

    const before = await readState(page);
    expect(await page.evaluate(() =>
      window.__game.morphTower(window.__game.towers.towers[0].id, 'water'))).toBe(false);
    expect(await page.evaluate(() => window.__game.towers.towers[0].def.kind)).toBe('primal');
    expect((await readState(page)).gold).toBe(before.gold);
    expect(await toastText(page)).toBe('This tower cannot morph');
    // The stacks are exactly where they were, too.
    expect((await readState(page)).elements).toEqual(before.elements);

    // A foundation is refused as well — it has convertTower, which is cheaper.
    await page.evaluate(() => {
      const g = window.__game;
      g.build('foundation', 16, 12);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[1].id);
    });
    expect(await page.evaluate(() =>
      window.__game.morphTower(window.__game.towers.towers[1].id, 'water'))).toBe(false);
    expect(await page.evaluate(() => window.__game.towers.towers[1].def.kind)).toBe('inert');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('refuses a target the player has not bound', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 20000 });
    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    const before = await readState(page);
    // Nature is not bound, so neither the pure tower nor any nature fusion is a
    // legal morph target.
    expect(await page.evaluate(() =>
      window.__game.morphTower(window.__game.towers.towers[0].id, 'nature'))).toBe(false);
    expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('fire');
    expect((await readState(page)).gold).toBe(before.gold);
    expect(await toastText(page)).toBe('Element not bound');

    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('arming a foundation', () => {
  test('costs the discounted difference and credits the block in full', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 20000 });

    const quoted = await page.evaluate(() => window.__game.convertCost('fire'));
    const blockCost = await page.evaluate(() =>
      fetch('/src/game/TowerDefs.js').then((r) => r.text())
        .then((t) => Number(t.match(/key: 'foundation'[\s\S]*?cost: (\d+)/)[1])));
    expect(blockCost).toBe(20);

    const start = (await readState(page)).gold;
    await page.evaluate(() => {
      const g = window.__game;
      g.build('foundation', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    expect((await readState(page)).gold).toBe(start - blockCost);

    const ok = await page.evaluate(() =>
      window.__game.convertTower(window.__game.selectedTower, 'fire'));
    expect(ok).toBe(true);
    const after = await readState(page);
    expect(start - after.gold, 'block + arming did not add up to the quote')
      .toBe(blockCost + quoted);
    expect(after.gold).toBeGreaterThanOrEqual(0);
    expect(after.towers, 'arming created a second tower').toBe(1);
    expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('fire');
    expect(await page.evaluate(() => window.__game.towers.towers[0].level)).toBe(0);

    // THE COHERENCE CLAIM the source makes: block-then-arm costs 5 gold more
    // than the sale refunds, the identical constant every tower pays on this
    // route (paid = 0.75C + 5, refund = 0.75C).
    const beforeSale = (await readState(page)).gold;
    await page.evaluate(() => window.__game.sellTower(window.__game.towers.towers[0].id));
    const refund = (await readState(page)).gold - beforeSale;
    expect((blockCost + quoted) - refund).toBe(5);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('arming into a PRIMAL spends two stacks, and selling hands them back', async ({ page }) => {
    /**
     * The route the source docblock prices out: (900 - 20) * 0.75 = 660, so
     * 20 + 660 = 680 in and 0.75 * 900 = 675 back. Both halves are asserted
     * because the stack accounting is the part with no second chance — a refused
     * build that has already eaten two stacks is unrecoverable and invisible.
     */
    const { errors } = await startRun(page, { elements: ['fire'], gold: 20000 });
    await page.evaluate(() => {
      const g = window.__game;
      g.state.elements = ['fire', 'fire', 'fire'];
      g.hud.refreshBuildBar();
      g.build('foundation', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });

    const before = await readState(page);
    expect(before.elements.filter((e) => e === 'fire')).toHaveLength(3);
    const quoted = await page.evaluate(() => window.__game.convertCost('primal_fire'));
    expect(quoted).toBe(660);

    expect(await page.evaluate(() =>
      window.__game.convertTower(window.__game.selectedTower, 'primal_fire'))).toBe(true);

    const armed = await readState(page);
    expect(before.gold - armed.gold).toBe(quoted);
    expect(armed.gold).toBeGreaterThanOrEqual(0);
    expect(armed.elements.filter((e) => e === 'fire'),
      'arming a primal did not spend two stacks').toHaveLength(1);
    expect(await page.evaluate(() => window.__game.towers.towers[0].key)).toBe('primal_fire');

    // Sell: 675 back and both stacks returned.
    await page.evaluate(() => window.__game.sellTower(window.__game.towers.towers[0].id));
    const sold = await readState(page);
    expect(sold.gold - armed.gold).toBe(675);
    expect(sold.elements.filter((e) => e === 'fire'),
      'the primal kept the stacks it ate').toHaveLength(3);
    expect(sold.towers).toBe(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('refuses to arm a primal the player is short of stacks for, WITHOUT eating any',
    async ({ page }) => {
      const { errors } = await startRun(page, { elements: ['fire'], gold: 20000 });
      await page.evaluate(() => {
        const g = window.__game;
        g.state.elements = ['fire', 'fire'];        // one short
        g.hud.refreshBuildBar();
        g.build('foundation', 10, 8);
        g.setBuildSelection(null);
        g.selectTower(g.towers.towers[0].id);
      });

      const before = await readState(page);
      expect(await page.evaluate(() =>
        window.__game.convertTower(window.__game.selectedTower, 'primal_fire'))).toBe(false);
      const after = await readState(page);
      expect(after.gold, 'a refused arming still charged').toBe(before.gold);
      expect(after.elements, 'a refused arming ate stacks').toEqual(before.elements);
      expect(await page.evaluate(() => window.__game.towers.towers[0].def.kind)).toBe('inert');

      expect(errors, errors.join('\n')).toEqual([]);
    });

  test('refuses to arm with an element the player has not bound', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 20000 });
    await page.evaluate(() => {
      const g = window.__game;
      g.build('foundation', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    const before = await readState(page);
    expect(await page.evaluate(() =>
      window.__game.convertTower(window.__game.selectedTower, 'dark'))).toBe(false);
    expect((await readState(page)).gold).toBe(before.gold);
    expect(await toastText(page)).toBe('Element not bound');
    expect(await page.evaluate(() => window.__game.towers.towers[0].def.kind)).toBe('inert');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('leaves the maze bit-for-bit identical, which is why it skips the path rebuild',
    async ({ page }) => {
      // convertTower deliberately does NOT rebuild the flow field or remask the
      // road: the new tower occupies the same 2x2 anchor, so those four cells go
      // TOWER -> FREE -> TOWER inside one call with nothing observing the gap.
      // That is a fact rather than a bet only while the grid really is unchanged.
      const { errors } = await startRun(page, { elements: ['fire'], gold: 20000 });
      await page.evaluate(() => {
        const g = window.__game;
        g.build('foundation', 10, 8);
        g.setBuildSelection(null);
        g.selectTower(g.towers.towers[0].id);
      });
      const before = await page.evaluate(() => Array.from(window.__game.grid.cells).join(','));

      await page.evaluate(() => window.__game.convertTower(window.__game.selectedTower, 'fire'));
      await settle(page, 120);
      const after = await page.evaluate(() => Array.from(window.__game.grid.cells).join(','));
      expect(after, 'arming changed the maze, so skipping path.rebuild is now a bug')
        .toBe(before);

      expect(errors, errors.join('\n')).toEqual([]);
    });
});
