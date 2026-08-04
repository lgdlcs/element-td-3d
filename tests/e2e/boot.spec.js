import { test, expect } from '@playwright/test';
import { bootGame, settle } from './fixtures.js';
import { START_GOLD, START_LIVES } from './helpers.js';

/**
 * What a player sees in the first second, frozen.
 *
 * Under Playwright main.js skips the lobby (navigator.webdriver), so a boot lands
 * straight in a solo run whose first act is the free element pick. Everything
 * here is the CURRENT behaviour of that opening, including the two details that
 * routinely surprise people:
 *
 *  - `state.wave` is 0 while the top bar reads "1". refreshTop renders
 *    Math.max(1, wave), so the counter never shows a wave zero the player is not
 *    in. Both facts are asserted on purpose.
 *  - The run is already in the 'pickElement' phase with the picker modal open,
 *    not in 'prep'. Nothing pointer-driven on the board works until it is closed.
 */
test.describe('boot', () => {
  test('opens on a clean HUD with the documented starting economy', async ({ page }) => {
    const { errors } = await bootGame(page);

    // --- state -----------------------------------------------------------
    const s = await page.evaluate(() => {
      const g = window.__game;
      return {
        gold: g.state.gold,
        lives: g.state.lives,
        wave: g.state.wave,
        score: g.state.score,
        phase: g.state.phase,
        speed: g.state.speed,
        paused: g.state.paused,
        elements: g.state.elements.slice(),
        pending: g.state.pendingElementPicks,
        towers: g.towers.towers.length,
        selectedBuild: g.selectedBuild,
        selectedTower: g.selectedTower,
      };
    });
    expect(s.gold).toBe(START_GOLD);
    expect(s.lives).toBe(START_LIVES);
    expect(s.wave).toBe(0);
    expect(s.score).toBe(0);
    expect(s.speed).toBe(1);
    expect(s.paused).toBe(false);
    expect(s.towers).toBe(0);
    expect(s.selectedBuild).toBeNull();
    expect(s.selectedTower).toBeNull();
    // The opening pick has been granted but not yet spent.
    expect(s.phase).toBe('pickElement');
    expect(s.pending).toBe(1);
    expect(s.elements).toEqual([]);

    // --- the HUD panels a player needs on frame one ----------------------
    for (const sel of ['#topbar', '#dock', '#threat', '#stat-gold', '#stat-lives',
                       '#stat-wave', '#stat-score', '#speed-buttons', '#pause-btn']) {
      await expect(page.locator(sel), `${sel} missing from the HUD`).toHaveCount(1);
    }

    // --- the numbers the player actually reads ---------------------------
    // KNOWN DEFECT, FROZEN AS-IS, NOT FIXED HERE.
    //
    // The gold readout says "0" on a board that holds 275. refreshTop() never
    // writes #stat-gold; only HUD.update()'s count-up tween does, and it is
    // guarded by `if (this._goldShown !== target)`. The constructor seeds
    // _goldShown from state.gold, so on frame one the two are already equal, the
    // tween never runs, and the "0" baked into the topbar markup is left on
    // screen. It self-heals on the first gold change of any size — usually the
    // 15-second interest payout, or the player's first build.
    //
    // Asserted as observed on purpose: this suite is a freeze of the current
    // build. Whoever fixes the readout should flip these two assertions.
    await expect(page.locator('#stat-gold')).toHaveText('0');
    await page.evaluate(() => { window.__game.state.gold += 1; });
    await expect.poll(
      () => page.locator('#stat-gold').textContent(),
      { message: 'gold readout never caught up after the purse changed' },
    ).toBe(String(START_GOLD + 1));

    await expect(page.locator('#stat-lives')).toHaveText(String(START_LIVES));
    // wave 0 in state, "1" on screen — see the docblock.
    await expect(page.locator('#stat-wave')).toHaveText('1');
    await expect(page.locator('#stat-score')).toHaveText('0');

    // --- the opening modal ------------------------------------------------
    await expect(page.locator('#picker')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#picker-cards .pcard')).toHaveCount(3);

    await settle(page, 500);
    expect(errors, `console/page errors during boot:\n${errors.join('\n')}`).toEqual([]);
  });

  test('committing the free pick binds the element and starts the prep phase', async ({ page }) => {
    const { errors } = await bootGame(page);

    // Click the first offered card, exactly where a player would.
    const chosen = await page.evaluate(
      () => document.querySelector('#picker-cards .pcard')?.dataset.id ?? null);
    await page.click('#picker-cards .pcard');

    await expect.poll(() => page.evaluate(() => window.__game.state.phase)).toBe('prep');

    const s = await page.evaluate(() => {
      const g = window.__game;
      return {
        elements: g.state.elements.slice(),
        picks: g.state.picks.slice(),
        pending: g.state.pendingElementPicks,
        prepTimer: g.state.prepTimer,
        wave: g.state.wave,
        gold: g.state.gold,
        dockCards: document.querySelectorAll('#dock-pure .tcard').length,
      };
    });
    expect(s.elements).toHaveLength(1);
    expect(s.picks).toEqual(s.elements);
    expect(s.pending).toBe(0);
    if (chosen) expect(s.elements[0]).toBe(chosen);
    // Wave 1 gets a full minute of build time (WAVES.prepFirst), already ticking.
    expect(s.prepTimer).toBeGreaterThan(50);
    expect(s.prepTimer).toBeLessThanOrEqual(60);
    expect(s.wave).toBe(0);
    // Picking costs nothing.
    expect(s.gold).toBe(START_GOLD);
    // One dock card per bound element.
    expect(s.dockCards).toBe(1);

    await expect(page.locator('#picker')).not.toHaveClass(/\bopen\b/);
    expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
