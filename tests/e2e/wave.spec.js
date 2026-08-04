import { test, expect } from '@playwright/test';
import { startRun, readState, settle, START_LIVES } from './helpers.js';

/**
 * A wave, end to end, at 3x.
 *
 * No sleeps stand in for progress here: every step waits on a fact read out of
 * the live game (creeps.count, tower.totalDamage, state.phase). setSpeed(3) only
 * shortens the wall-clock cost of waiting for those facts.
 *
 * The wave-1 script (see waveDef in src/game/Waves.js) is 8 Grunts, 52 hp each,
 * 9 gold bounty, and it grants no element pick — so clearing it returns straight
 * to 'prep' rather than reopening the picker.
 */
test.describe('wave', () => {
  test('a defended wave spawns, gets shot, clears, and pays out', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 100000 });

    // Six fire towers raised to their top level, flanking the spawn-to-goal
    // corridor at columns 12-13 without ever standing in it.
    await page.evaluate(() => {
      const g = window.__game;
      for (const [c, r] of [[10, 4], [14, 4], [10, 8], [14, 8], [10, 12], [14, 12]]) {
        g.build('fire', c, r);
        const t = g.towers.towers[g.towers.towers.length - 1];
        g.upgradeTower(t.id);
        g.upgradeTower(t.id);
      }
      g.setBuildSelection(null);
      g.selectTower(null);
    });
    expect((await readState(page)).towers).toBe(6);

    // 3x, and let the clock run again.
    await page.keyboard.press('3');
    await page.evaluate(() => { window.__game.state.paused = false; });
    expect((await readState(page)).speed).toBe(3);

    const beforeSend = await readState(page);
    expect(beforeSend.phase).toBe('prep');

    await page.keyboard.press('Space');
    const atSend = await readState(page);
    expect(atSend.phase).toBe('combat');
    expect(atSend.wave).toBe(1);
    await expect(page.locator('#announce')).toContainText('Wave');
    await expect(page.locator('#announce')).toContainText('01');

    // 1. Creeps actually reach the board.
    await expect.poll(
      () => page.evaluate(() => window.__game.creeps.count),
      { message: 'no creep ever spawned', timeout: 20000 },
    ).toBeGreaterThan(0);

    // 2. The towers actually shoot them. totalDamage is written by
    //    Projectiles.onDamage, so a non-zero value means a projectile was fired,
    //    travelled, and landed.
    await expect.poll(
      () => page.evaluate(() =>
        window.__game.towers.towers.reduce((n, t) => n + t.totalDamage, 0)),
      { message: 'no tower ever damaged anything', timeout: 25000 },
    ).toBeGreaterThan(0);

    // 3. The wave ends and the run goes back to building.
    await expect.poll(
      () => page.evaluate(() => window.__game.state.phase),
      { message: 'the wave never cleared', timeout: 40000 },
    ).toBe('prep');

    const after = await readState(page);
    expect(after.killed).toBeGreaterThan(0);
    // Bounties (9 per Grunt) plus the wave-clear score. Interest can also land
    // in this window, so the claim under test is "the purse grew", which is the
    // one a player would make.
    expect(after.gold).toBeGreaterThan(atSend.gold);
    // WaveRunner credits def.n * 100 on a clear, on top of 1.5x bounty per kill.
    expect(after.score).toBeGreaterThanOrEqual(beforeSend.score + 100);
    // Back in prep for wave 2, with a fresh countdown.
    expect(after.wave).toBe(1);
    expect(await page.evaluate(() => window.__game.state.prepTimer)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__game.waves.def)).toBeNull();

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('an undefended wave leaks, costs lives and burns the wave interest', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    // Nothing is built on purpose: every creep walks straight to the goal.
    await page.keyboard.press('3');
    await page.evaluate(() => { window.__game.state.paused = false; });

    const before = await readState(page);
    expect(before.lives).toBe(START_LIVES);
    expect(await page.evaluate(() => window.__game.state.interestActive)).toBe(true);

    await page.keyboard.press('Space');
    expect((await readState(page)).phase).toBe('combat');

    // A Grunt walks at 4.2 units/s across a ~40 unit board; at 3x this is a few
    // seconds of wall clock, but the wait is on the leak, not on a timer.
    await expect.poll(
      () => page.evaluate(() => window.__game.state.leaked),
      { message: 'nothing ever leaked on an empty board', timeout: 40000 },
    ).toBeGreaterThan(0);

    const leaked = await readState(page);
    expect(leaked.lives).toBeLessThan(before.lives);
    // The expensive half of the punishment: no interest for the rest of the wave.
    expect(await page.evaluate(() => window.__game.state.interestActive)).toBe(false);

    // The wave still ends — an unstoppable wave is still a finished one.
    await expect.poll(
      () => page.evaluate(() => window.__game.state.phase),
      { message: 'the wave never ended', timeout: 40000 },
    ).toBe('prep');
    // Clearing restores interest for the next wave.
    expect(await page.evaluate(() => window.__game.state.interestActive)).toBe(true);
    expect((await readState(page)).killed).toBe(0);

    await settle(page, 200);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
