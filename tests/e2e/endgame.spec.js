import { test, expect } from '@playwright/test';
import { startRun, readState, settle } from './helpers.js';

/**
 * THE END OF A RUN, which nothing could reach.
 *
 * `grep -rn "endcard\|gameOver" tests/` returned nothing before this file. The
 * game could not be lost or won by the suite: wave.spec.js leaks creeps and
 * checks that lives fall, then stops well above zero. So Game.#gameOver,
 * Game.#victory, HUD.showEnd and the saveBest sink in main.js — the only
 * persistence the game has — were all unexecuted.
 *
 * Lives are set to 1 and a wave is sent at an undefended board rather than
 * calling any private method: the thing worth freezing is the CHAIN (a leak
 * takes the last life, which ends the run, which paints the card, which writes
 * the record), and driving it from the middle would leave most of that chain
 * untested exactly as before.
 */
test.describe('end of run', () => {
  test('the last leak ends the run, paints the card and writes the record', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 0, freeze: false });

    await page.evaluate(() => {
      // Nothing beats the local best, so the "new best" branch is the one under
      // test; the tie/regression branches are covered in tests/unit/bestscore.
      localStorage.removeItem('elementtd.best.v1');
      const g = window.__game;
      g.state.lives = 1;
      g.state.score = 4242;
      g.hud.best = 0;
      g.hud.refreshTop();
      g.setSpeed(3);
      g.startWaveNow();
    });

    await expect.poll(() => page.evaluate(() => window.__game.state.phase),
      { timeout: 60000, message: 'the undefended wave never ended the run' }).toBe('gameover');

    // The card is the thing that says the run is over.
    await expect(page.locator('#endcard')).toHaveClass(/\bshow\b/);
    await expect(page.locator('#endcard .end-inner')).toHaveClass(/\blose\b/);
    await expect(page.locator('#endcard h1')).toHaveText('The Line Is Broken');
    await expect(page.locator('#endcard .end-best')).toHaveClass(/\brecord\b/);

    const s = await readState(page);
    expect(s.lives).toBeLessThanOrEqual(0);

    // ...and the ONLY thing the game remembers now remembers it. main.js's
    // onRunEnd is what writes this, so it also proves the hook is wired.
    const stored = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('elementtd.best.v1')); } catch { return null; }
    });
    expect(stored, 'the run ended and nothing was persisted').not.toBeNull();
    expect(stored.score).toBe(s.score);
    expect(stored.won).toBe(false);
    expect(stored.wave).toBeGreaterThanOrEqual(1);
    expect(stored.at).toBeGreaterThan(0);

    // The simulation is frozen once the run is over (FROZEN_PHASES), so the card
    // cannot be overtaken by a creep that is still walking.
    const wave = s.wave;
    await settle(page, 600);
    expect((await readState(page)).wave).toBe(wave);

    // LAST, because showEnd re-renders the card from `hud.best`, which main.js
    // has updated by now — re-rendering before the record assertions above would
    // measure the second render rather than the real one.
    //
    // The two full-bleed reference panels stand down for the result. The key
    // sheet is no longer phase-gated, so "it never coexists with the end card"
    // is a promise HUD.showEnd has to keep on purpose rather than by accident.
    await page.evaluate(() => { window.__game.hud.setHelp(true); window.__game.hud.build.setCodex(true); });
    await page.evaluate(() => window.__game.hud.showEnd(false));
    await expect(page.locator('#help'), 'the key sheet is up under the end card')
      .not.toHaveClass(/\bopen\b/);
    await expect(page.locator('#codex'), 'the tower table is up under the end card')
      .not.toHaveClass(/\bopen\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a second, worse run does not overwrite the record', async ({ page }) => {
    // The other half of the persistence contract, through the real end-of-run
    // path rather than through saveBest directly.
    const { errors } = await startRun(page, { elements: ['fire'], gold: 0, freeze: false });

    await page.evaluate(() => {
      localStorage.setItem('elementtd.best.v1',
        JSON.stringify({ score: 999999, wave: 50, won: true, at: 1 }));
      const g = window.__game;
      g.state.lives = 1;
      g.state.score = 10;
      g.setSpeed(3);
      g.startWaveNow();
    });

    await expect.poll(() => page.evaluate(() => window.__game.state.phase),
      { timeout: 60000 }).toBe('gameover');

    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('elementtd.best.v1')));
    expect(stored.score, 'a worse run overwrote the personal best').toBe(999999);
    // ...and the card says so rather than claiming a record.
    await expect(page.locator('#endcard .end-best')).not.toHaveClass(/\brecord\b/);
    await expect(page.locator('#endcard .end-best')).toContainText('Personal best');

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
