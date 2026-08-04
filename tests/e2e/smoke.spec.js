import { test, expect } from '@playwright/test';
import { bootGame, settle } from './fixtures.js';

/**
 * Smoke test for the E2E harness itself.
 *
 * It asserts the three things every other spec silently depends on: the game
 * boots, the renderer got a real canvas with a real size, and nothing threw on
 * the way up. If this fails, no other E2E result means anything.
 *
 * Note on the console assertion: the game runs under Playwright with
 * navigator.webdriver set, which makes it skip the lobby and start a solo run.
 * A clean boot is genuinely silent -- any error here is a regression, not noise.
 */
test.describe('boot smoke', () => {
  test('the game boots with a sized canvas and no JS errors', async ({ page }) => {
    const { errors } = await bootGame(page);

    // 1. The game object is the contract every harness in this repo relies on.
    const shape = await page.evaluate(() => {
      const g = window.__game;
      return {
        hasState: !!g.state,
        hasGrid: !!g.grid,
        hasArena: !!g.arena,
        hasTowers: !!g.towers,
        cols: g.grid?.cols ?? -1,
        rows: g.grid?.rows ?? -1,
      };
    });
    expect(shape.hasState).toBe(true);
    expect(shape.hasGrid).toBe(true);
    expect(shape.hasArena).toBe(true);
    expect(shape.hasTowers).toBe(true);
    expect(shape.cols).toBe(26);
    expect(shape.rows).toBe(20);

    // 2. A real drawing surface. A zero-sized canvas still renders "fine" in
    //    the sense that nothing throws, so this has to be measured explicitly.
    const canvas = await page.evaluate(() => {
      const el = document.getElementById('viewport');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, bw: el.width, bh: el.height };
    });
    expect(canvas).not.toBeNull();
    expect(canvas.w).toBeGreaterThan(0);
    expect(canvas.h).toBeGreaterThan(0);
    expect(canvas.bw).toBeGreaterThan(0);
    expect(canvas.bh).toBeGreaterThan(0);

    // 3. Let a few frames actually run before declaring the boot clean: some
    //    failures (bad shader link, NaN in a uniform) only surface once the
    //    render loop touches the offending material.
    await settle(page, 800);
    expect(errors, `console/page errors during boot:\n${errors.join('\n')}`).toEqual([]);
  });
});
