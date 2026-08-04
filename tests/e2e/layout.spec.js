import { test, expect } from '@playwright/test';
import { bootGame } from './fixtures.js';
import { startRun } from './helpers.js';

/**
 * LIGHT VISUAL NON-REGRESSION: nothing runs off the frame at 1280x720.
 *
 * Not a pixel diff. A screenshot comparison of a WebGL scene is a maintenance
 * tax nobody pays — the frame legitimately differs between GPU drivers, between
 * quality presets and between two consecutive seconds of a breathing camera. So
 * this asserts the one geometric property that is unambiguous, that a reviewer
 * cannot see in a diff, and that every one of the six changes in this round
 * could plausibly have broken: EVERY VISIBLE PANEL IS INSIDE THE VIEWPORT.
 *
 * 1280x720 specifically, because it is the smallest frame anyone plays on and
 * the one where the new furniture is tightest — the topbar grew a help button,
 * the dock grew a wider Send-wave capsule, and the lobby grew a 254px panel in
 * a gutter that only exists above 1180px.
 *
 * The page itself must not scroll either: a laid-out element that merely pokes
 * over the edge produces a scrollbar rather than an overflowing rect, and only
 * one of the two checks below sees each case.
 */

const VIEWPORT = { width: 1280, height: 720 };

/**
 * Measure every VISIBLE element matching `selectors` and report the ones whose
 * box leaves the viewport.
 *
 * `slack` exists because several panels are deliberately drawn with a blur or a
 * shadow that extends past their box, and because a transform-based entrance
 * animation can leave a sub-pixel remainder. 1px, not 20.
 */
async function overflowing(page, selectors, slack = 1) {
  return page.evaluate(({ selectors, slack }) => {
    const W = window.innerWidth, H = window.innerHeight;
    const out = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        // Hidden things are allowed to be parked off screen — several panels
        // live at translateY(120%) between uses. Only what is on screen counts.
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const over = {
          left: r.left < -slack,
          top: r.top < -slack,
          right: r.right > W + slack,
          bottom: r.bottom > H + slack,
        };
        if (over.left || over.top || over.right || over.bottom) {
          out.push({
            sel,
            id: el.id || el.className,
            rect: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) },
            viewport: { W, H },
            over,
          });
        }
      }
    }
    return out;
  }, { selectors, slack });
}

/** The page must not have acquired a scrollbar in either axis. */
async function pageScroll(page) {
  return page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
}

test.use({ viewport: VIEWPORT });

/**
 * Keep the frame that was measured, alongside the numbers.
 *
 * Attached to the report rather than written into the repo: `test-results/` is
 * gitignored, so a run leaves an artefact a human can look at without adding a
 * binary to review. It is EVIDENCE, never an assertion — no golden image is
 * compared, for the reasons in the file docblock.
 */
async function capture(page, testInfo, name) {
  // outputPath puts the file inside test-results/<test>/, which .gitignore
  // already covers. A path-backed attachment survives the plain `list` reporter;
  // a body-backed one only exists inside an HTML/JSON report.
  const path = testInfo.outputPath(name);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.describe('layout at 1280x720', () => {
  test('the lobby and its Hall of Records stay inside the frame', async ({ page }, testInfo) => {
    const { errors } = await bootGame(page, { query: 'mp' });
    await expect(page.locator('#lobby')).toBeVisible();

    // Let the connection settle: the offline card is the tallest state the plate
    // has, so measuring before the verdict measures the easy case.
    await expect.poll(
      () => page.evaluate(() => window.__lobby?.state),
      { timeout: 20000 },
    ).not.toBe('connecting');
    // POLL, NOT SLEEP. Everything below is a getBoundingClientRect whose verdict
    // depends on a CSS transition having finished, and helpers.js opens with "NO
    // SLEEPS AS ASSERTIONS" — this file was the only place that broke its own
    // rule, four times, in the same file that demonstrates the right technique
    // sixty lines further down. On a loaded machine (and workers:1 exists
    // because this machine gets loaded) a mid-transition panel reports a
    // legitimately off-screen rect and the test fails for a reason that is not a
    // bug, then passes on retry — which docs/TESTING.md calls a broken spec.
    await expect.poll(() => page.evaluate(() => {
      const el = document.querySelector('#lobby .lobby-inner');
      return el ? +getComputedStyle(el).opacity : 0;
    }), { message: 'the lobby plate never faded in' }).toBe(1);

    // The gutter panel is only laid out above 1180px, and 1280 is the first
    // frame that keeps it — so if this ever starts being skipped, the test has
    // silently stopped measuring the thing it was written for.
    await expect(page.locator('#lobby-hall')).toBeVisible();
    await capture(page, testInfo, 'lobby-1280x720.png');

    const bad = await overflowing(page, [
      '#lobby-hall', '.lobby-inner', '.lobby-card', '.lobby-head',
      '.lobby-foot', '#lobby-solo', '#lobby-conn', '#lobby-error',
    ]);
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);

    // The hall must clear the plate rather than sit on top of it.
    const gap = await page.evaluate(() => {
      const p = document.querySelector('.lobby-inner').getBoundingClientRect();
      const h = document.getElementById('lobby-hall').getBoundingClientRect();
      return h.left - p.right;
    });
    expect(gap, 'the hall overlaps the lobby plate').toBeGreaterThan(0);

    expect(await pageScroll(page)).toEqual({ x: 0, y: 0 });

    expect(errors.filter((e) => !/WebSocket connection to .* failed/i.test(e))).toEqual([]);
  });

  test('the in-game HUD stays inside the frame, at rest and with every panel open', async ({ page }, testInfo) => {
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 20000 });

    const CHROME = [
      '#topbar', '#dock', '#threat', '#inspector', '#codex', '#help .help-sheet',
      '#speed-buttons', '#pause-btn', '#help-btn', '#send-wave', '#codex-toggle',
      '#held-piece', '#place-hint',
    ];

    // ---- at rest -------------------------------------------------------
    await capture(page, testInfo, 'hud-rest-1280x720.png');
    expect(await overflowing(page, CHROME)).toEqual([]);

    // ---- inspector open on a tower ------------------------------------
    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    await expect(page.locator('#inspector')).toHaveClass(/\bopen\b/);
    expect(await overflowing(page, CHROME), 'inspector').toEqual([]);

    // ---- the morph sheet, which is the tallest inspector view ----------
    await page.keyboard.press('m');
    await expect(page.locator('#inspector')).toHaveClass(/\bmorph\b/);
    expect(await overflowing(page, CHROME), 'morph sheet').toEqual([]);
    await page.keyboard.press('Escape');

    // ---- the tower table -----------------------------------------------
    // `body.codex-open` deliberately SLIDES #threat and #inspector off the frame
    // and fades them to nothing, so both are legitimately outside the viewport
    // while it is up. Wait for the fade to finish rather than for a fixed number
    // of milliseconds: mid-transition they are off screen AND still opaque, and
    // measuring then reports a designed behaviour as a bug.
    await page.keyboard.press('f');
    await expect(page.locator('#codex')).toHaveClass(/\bopen\b/);
    await expect.poll(() => page.evaluate(() => [
      +getComputedStyle(document.getElementById('threat')).opacity,
      +getComputedStyle(document.getElementById('inspector')).opacity,
    ]), { message: 'the parked panels never faded out' }).toEqual([0, 0]);
    expect(await overflowing(page, CHROME), 'tower table').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#codex')).not.toHaveClass(/\bopen\b/);
    // The mirror of the poll above. #threat only: the Escape that closed the
    // morph sheet also cleared the tower selection, so #inspector is legitimately
    // shut rather than parked, and waiting for it to come back would wait for
    // ever. `overflowing()` skips opacity-0 elements, which is why a closed
    // inspector is not a problem for the measurement that follows.
    await expect.poll(() => page.evaluate(() =>
      +getComputedStyle(document.getElementById('threat')).opacity),
    { message: 'the threat rail never slid back in' }).toBe(1);

    // ---- the key sheet --------------------------------------------------
    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    await expect.poll(() => page.evaluate(() =>
      +getComputedStyle(document.getElementById('help')).opacity),
    { message: 'the key sheet never faded in' }).toBe(1);
    await capture(page, testInfo, 'hud-help-1280x720.png');
    expect(await overflowing(page, CHROME), 'key sheet').toEqual([]);
    // It also has to fit without an internal scrollbar, or the last group of
    // shortcuts is a group nobody reads.
    const fits = await page.evaluate(() => {
      const s = document.querySelector('#help .help-sheet');
      return { over: s.scrollHeight - s.clientHeight, h: s.getBoundingClientRect().height };
    });
    expect(fits.over, 'the key sheet needs an internal scrollbar at 720p').toBeLessThanOrEqual(1);
    expect(fits.h).toBeLessThan(VIEWPORT.height);
    await page.keyboard.press('Escape');

    // ---- the held-piece chip, which is positioned near the cursor -------
    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await expect(page.locator('#held-piece')).toHaveClass(/\bon\b/);
    // The chip slides up from translateY; a stable rect two reads apart is the
    // honest signal that it has arrived.
    await expect.poll(async () => {
      const a = await page.evaluate(() => Math.round(
        document.getElementById('held-piece').getBoundingClientRect().top));
      await new Promise((r) => setTimeout(r, 60));
      const b = await page.evaluate(() => Math.round(
        document.getElementById('held-piece').getBoundingClientRect().top));
      return a === b;
    }, { message: 'the held-piece chip never settled' }).toBe(true);
    expect(await overflowing(page, CHROME), 'held-piece chip').toEqual([]);

    expect(await pageScroll(page)).toEqual({ x: 0, y: 0 });
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the resting HUD still leaves the middle of the board clear', async ({ page }) => {
    // The existing layout contract from tools/ui-contract.mjs, at the smaller
    // frame this file is about: nothing the player did not open may sit over the
    // 27-73% x 18-80% box, because that is where the maze is built. The topbar
    // grew a button and the dock grew a wider capsule in this round, so it is
    // worth re-checking at the tightest viewport rather than only at 1600x900.
    const { errors } = await startRun(page, { elements: ['fire'] });

    const clash = await page.evaluate(() => {
      const W = window.innerWidth, H = window.innerHeight;
      const box = { l: W * 0.27, r: W * 0.73, t: H * 0.18, b: H * 0.80 };
      const out = [];
      for (const sel of ['#topbar', '#threat', '#inspector', '#dock']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > box.l && r.left < box.r && r.bottom > box.t && r.top < box.b) {
          out.push({ sel, rect: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }, box });
        }
      }
      return out;
    });
    expect(clash, JSON.stringify(clash, null, 2)).toEqual([]);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});

/**
 * BELOW THE HALL'S BREAKPOINT.
 *
 * lobby.css hides #lobby-hall entirely under 1180px — the plate is 560px plus
 * margins and there is no gutter left to put a 254px panel in. That decision is
 * defensible and documented, but the two viewports the whole feature was
 * specified against (1280x720 and 1920x1080) are BOTH above the cut, so nothing
 * ever measured the fallback: a 13" laptop in a non-maximised window is exactly
 * the case nobody looked at.
 *
 * 1100x700 is that case. The scoreboard the seventh feature asks for must still
 * be represented (as the condensed line inside the plate), the plate must not
 * reflow off the frame, and the page must not acquire a scrollbar.
 */
test.describe('layout at 1100x700 — under the Hall breakpoint', () => {
  test.use({ viewport: { width: 1100, height: 700 } });

  test('the gutter panel stands down and the condensed line takes over', async ({ page }, testInfo) => {
    const { errors } = await bootGame(page, { query: 'mp' });
    await expect(page.locator('#lobby')).toBeVisible();
    await expect.poll(
      () => page.evaluate(() => window.__lobby?.state),
      { timeout: 20000 },
    ).not.toBe('connecting');
    await expect.poll(() => page.evaluate(() => {
      const el = document.querySelector('#lobby .lobby-inner');
      return el ? +getComputedStyle(el).opacity : 0;
    })).toBe(1);

    // The panel is gone — that is the documented decision, asserted so a future
    // edit cannot half-apply it.
    await expect(page.locator('#lobby-hall')).toBeHidden();

    // ...and the scoreboard is NOT gone. This is the whole point of the case:
    // before the fallback existed there was nothing on screen at this width to
    // say a leaderboard was even a thing.
    const mini = page.locator('#lobby-hall-mini');
    await expect(mini).toBeVisible();
    await expect(mini).toContainText(/best|run finished/i);

    await capture(page, testInfo, 'lobby-1100x700.png');

    // Nothing reflowed off the frame, and the page did not start scrolling.
    const bad = await overflowing(page, [
      '.lobby-inner', '.lobby-card', '.lobby-head', '.lobby-foot',
      '#lobby-solo', '#lobby-conn', '#lobby-error', '#lobby-hall-mini',
    ]);
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
    expect(await pageScroll(page)).toEqual({ x: 0, y: 0 });

    expect(errors.filter((e) => !/WebSocket connection to .* failed/i.test(e))).toEqual([]);
  });

  test('the in-game dock still fits, and Send wave is not clipped', async ({ page }) => {
    // The dock's shrink policy is width-driven (ui.css's 1440px block), so the
    // narrowest supported frame is where it has to be checked. The measurement
    // is the button's own box against the dock's, because the failure mode was a
    // label rendered as "Send wav" with the bonus painted past the glass.
    const { errors } = await startRun(page, { elements: ['fire', 'water', 'nature'], gold: 5000 });
    await page.evaluate(() => window.__game.hud.build.setPrep(true, 59));

    const fit = await page.evaluate(() => {
      const R = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; };
      const dock = R(document.getElementById('dock'));
      const sw = R(document.getElementById('send-wave'));
      const lbl = R(document.querySelector('.sw-label'));
      const bon = R(document.getElementById('sw-bonus'));
      return { dock, sw, lbl, bon, bonusText: document.getElementById('sw-bonus').textContent };
    });

    expect(fit.sw.r, 'the Send wave button hangs off the dock').toBeLessThanOrEqual(fit.dock.r + 1);
    expect(fit.lbl.r, 'the Send wave LABEL is clipped').toBeLessThanOrEqual(fit.sw.r);
    expect(fit.bonusText, 'no early-send bonus to measure').toMatch(/^\+/);
    expect(fit.bon.r, 'the early-send bonus is painted outside the button')
      .toBeLessThanOrEqual(fit.sw.r);

    expect(await pageScroll(page)).toEqual({ x: 0, y: 0 });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

/**
 * THE DOCK'S WIDTH SWEEP, WITH A FULL WALLET.
 *
 * The test above measures a THREE-element dock at one width. Three elements is
 * four cards; six elements is eleven, and the row is a constant 1229px wide
 * whatever the frame, because #dock is `width: max-content` and #send-wave is
 * `flex: 0 0 auto` with a max-content floor. So the deficit is a pure function
 * of the viewport and nothing in the row was allowed to give:
 *
 *     1280 fits by 2px   1240 +25   1200 +67   1152 +115   1024 +243
 *
 * `overflow` on #dock is `visible`, so past the knee the button was painted
 * outside its own plate and cut off by the window instead — at 1200 its right
 * edge sat 48px past the viewport, taking the Space cap and the early-send
 * bonus with it. The ui.css block that introduced the floor says "Verified by
 * capture at 1280, 1366 and 1920": all three are above the knee.
 *
 * A sweep rather than one viewport, because the failure was linear in width and
 * a single sample cannot see a knee. Six elements rather than two, because the
 * card count is the load. 1024 is the floor: ui.css has explicit breakpoints at
 * 1120 and 900, so this band is supported, not incidental.
 */
test.describe('the dock across the supported width band', () => {
  test.use({ viewport: { width: 1600, height: 800 } });

  test('Send wave, its cap and its bonus stay inside the dock from 1600 down to 1024', async ({ page }) => {
    const { errors } = await startRun(page, {
      elements: ['fire', 'water', 'nature', 'earth', 'light', 'dark'],
      gold: 99999,
    });
    // The button only exists during prep with a countdown running; setPrep is
    // what BuildBar's own update calls, so this is the real reveal path.
    await page.evaluate(() => window.__game.hud.build.setPrep(true, 59));
    await expect(page.locator('#send-wave')).toHaveClass(/\bshow\b/);

    const measure = () => page.evaluate(() => {
      const R = (n) => { const r = n.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
      const d = document.getElementById('dock');
      return {
        vw: window.innerWidth,
        dock: R(d),
        overflow: d.scrollWidth - d.clientWidth,
        sw: R(document.getElementById('send-wave')),
        lbl: R(document.querySelector('.sw-label')),
        cap: R(document.querySelector('#send-wave kbd')),
        bon: R(document.getElementById('sw-bonus')),
        bonusText: document.getElementById('sw-bonus').textContent,
      };
    });

    for (const width of [1600, 1440, 1366, 1280, 1240, 1200, 1152, 1100, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      // POLL, NOT SLEEP (see the note in the 1280 block): a resize reflows over
      // more than one frame and a mid-reflow rect is a rect for a layout that
      // never existed.
      await expect.poll(async () => {
        const a = (await measure()).dock.r;
        await new Promise((r) => setTimeout(r, 60));
        const b = (await measure()).dock.r;
        return a === b && b > 0;
      }, { message: `the dock never settled at ${width}px` }).toBe(true);

      const m = await measure();
      const at = `at ${width}px`;
      expect(m.vw, at).toBe(width);
      expect(m.overflow, `the dock's own content overflows its plate ${at}`).toBeLessThanOrEqual(0);
      expect(m.sw.r, `the Send wave button hangs off the dock ${at}`).toBeLessThanOrEqual(m.dock.r + 1);
      expect(m.sw.r, `the Send wave button leaves the viewport ${at}`).toBeLessThanOrEqual(width);
      expect(m.lbl.r, `the Send wave LABEL is clipped ${at}`).toBeLessThanOrEqual(m.sw.r);
      expect(m.bonusText, `no early-send bonus to measure ${at}`).toMatch(/^\+/);
      expect(m.bon.r, `the early-send bonus is painted outside the button ${at}`).toBeLessThanOrEqual(m.sw.r);
      // The cap is the only thing that teaches Space exists, and it was the
      // first casualty: it lives at `right: 7px` inside a button that was itself
      // outside the window.
      expect(m.cap.r, `the Space cap is outside the button ${at}`).toBeLessThanOrEqual(m.sw.r);
      expect(m.cap.r, `the Space cap is off screen ${at}`).toBeLessThanOrEqual(width);
      expect(await pageScroll(page), `the page scrolls ${at}`).toEqual({ x: 0, y: 0 });
    }

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
