import { test, expect } from '@playwright/test';
import {
  startRun, hoverCell, rightClickCell, gridOverlayState, hoverUniforms,
  placementHint, wallRowExceptGap, settle,
  samplePixels, cellClip, pixelDistance, hueDistance, freezeFrame,
  captureClip, clipDistance,
} from './helpers.js';

/**
 * THE BUILD CURSOR: the grid overlay, the 2x2 ghost and the six refusals.
 *
 * All four are ONE fragment shader sharing one opacity uniform
 * (Arena.#buildGridOverlay), so they cannot be judged separately — the grid, the
 * ghost, the seal-preview bars and the range ring live or die together. That is
 * why the overlay tests and the refusal tests are in one file.
 *
 * WHAT IS ACTUALLY OBSERVABLE FROM HERE, and why it is worth asserting. The
 * refusal COLOURS live in GLSL and no test in this repo reads pixels. What is
 * readable is the chain that ends in them:
 *
 *     Game.placementReason  ->  game.hover.reason        (the decision)
 *     Arena.setHover        ->  uHoverState              (the picture)
 *     HUD.showPlacementHint ->  #place-hint              (the words)
 *
 * The middle link is the one that was broken: before this round `creep` shared
 * `occupied`'s code and `stacks` had no code at all, so two of the six refusals
 * were painted as a third and only the hint text knew the difference. A test on
 * `hover.reason` alone would have passed throughout. Distinctness of the six
 * codes is therefore the headline assertion of this file.
 */

/**
 * Arena.setHover's encoding, mirrored so the expectation is written down rather
 * than derived from the subject. If Arena renumbers, this fails and someone
 * looks at the shader — which is the point.
 */
const HOVER_CODE = { valid: 0, occupied: 1, creep: 2, seal: 3, stacks: 4, poor: 5 };

test.describe('build grid overlay', () => {
  test('raises with a build in hand and falls when the build is cancelled', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    expect((await gridOverlayState(page)).target).toBe(0);

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    await hoverCell(page, 10, 8);
    expect((await gridOverlayState(page)).target).toBe(1);

    // setGridVisible only sets a TARGET; Arena.update eases uOpacity towards it
    // and flips mesh.visible on a 0.004 threshold a frame or more later. Assert
    // the instruction AND the ramp, or this reads a stale boolean.
    await expect.poll(
      () => gridOverlayState(page).then((s) => s.visible && s.opacity > 0.5),
      { message: 'the overlay never ramped up under a held build' },
    ).toBe(true);

    // Cancelled with the RIGHT BUTTON here; build.spec.js covers the same ramp
    // under Escape. Both routes go through Game.#cancelSelection, and the whole
    // reason it is one function is that they must not drift apart.
    await rightClickCell(page, 10, 8);
    expect((await gridOverlayState(page)).target).toBe(0);
    await expect.poll(
      () => gridOverlayState(page).then((s) => !s.visible && s.opacity < 0.01),
      { message: 'the overlay never faded out after the cancel' },
    ).toBe(true);

    // The ghost and the range ring go with it: they are painted by the same
    // shader and would otherwise be left pointing at the last hovered cell.
    const u = await hoverUniforms(page);
    expect(u.range).toBe(0);
    expect(u.c).toBe(-99);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a selected TOWER also raises the overlay, because it carries the range ring', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 1000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });

    expect((await gridOverlayState(page)).target).toBe(1);
    const u = await hoverUniforms(page);
    // PURE_TOWERS.fire level 0 range. The ring is drawn by the grid shader, so
    // "the overlay is up" and "the ring exists" are the same fact.
    expect(u.range).toBeGreaterThan(0);
    expect(u.range).toBe(await page.evaluate(() => {
      const g = window.__game;
      return g.towers.stats(g.towers.towers[0]).range;
    }));

    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('placement refusals', () => {
  /**
   * All six outcomes on ONE page, in an order chosen so no setup poisons the
   * next. Six separate tests would each pay a ~4s boot for the same walk, and —
   * more importantly — the headline assertion is that the six codes are all
   * DIFFERENT, which needs them in one place anyway.
   *
   * Every step self-checks that the fixture produced the outcome it was aiming
   * for before reading anything: a setup that quietly failed would otherwise
   * report the previous state and pass.
   */
  test('each of the six outcomes gets its own hover code, and no two share one', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });
    const seen = {};

    const look = async (reason, c, r) => {
      await hoverCell(page, c, r);
      const got = await page.evaluate(() => window.__game.hover);
      expect(got, `expected ${reason} at (${c},${r}), the fixture produced ${got.reason}`)
        .toMatchObject({ c, r, reason });
      const u = await hoverUniforms(page);
      expect(u.c, `${reason}: the shader is pointed at the wrong cell`).toBe(c);
      expect(u.r).toBe(r);
      expect(u.state, `${reason} paints code ${u.state}`).toBe(HOVER_CODE[reason]);
      seen[reason] = { code: u.state, hint: await placementHint(page) };
      return seen[reason];
    };

    // ---- 1. VALID ------------------------------------------------------
    await page.click('#dock-pure .tcard[data-tower="fire"]');
    const valid = await look('valid', 10, 8);
    expect(valid.hint.on, 'the valid case is silent by design').toBe(false);

    // ---- 2. POOR -------------------------------------------------------
    // The purse, and nothing else, changes.
    await page.evaluate(() => { window.__game.state.gold = 10; });
    const poor = await look('poor', 10, 8);
    expect(poor.hint.on).toBe(true);
    expect(poor.hint.text).toContain('Not enough gold');
    expect(poor.hint.cls).toContain('h-gold');

    // ---- 3. STACKS -----------------------------------------------------
    // A primal is queued directly rather than through the dock: the dock only
    // offers one at PRIMAL.stacksRequired copies, and this is the guard for the
    // state where the card is gone but the selection is not. Note the gold is
    // STILL 10 and the answer is 'stacks', not 'poor' — that ordering is the
    // documented one (no amount of gold fixes a stack shortfall, so quoting a
    // price would be a lie).
    await page.evaluate(() => window.__game.setBuildSelection('primal_fire'));
    expect(await page.evaluate(() => window.__game.elementCount('fire'))).toBeLessThan(3);
    const stacks = await look('stacks', 10, 8);
    expect(stacks.hint.on).toBe(true);
    expect(stacks.hint.text).toContain('Stacks spent');

    // ---- 4. OCCUPIED ---------------------------------------------------
    await page.evaluate(() => {
      const g = window.__game;
      g.state.gold = 2000;
      g.build('fire', 10, 8);
      g.setBuildSelection('fire');
    });
    expect(await page.evaluate(() => window.__game.towers.towers.length)).toBe(1);
    const occupied = await look('occupied', 10, 8);
    expect(occupied.hint.on).toBe(true);
    expect(occupied.hint.text).toContain('Occupied');

    // ---- 5. CREEP ------------------------------------------------------
    // Spawned through the real pool, then moved onto the target cell. The sim is
    // paused, so it stays put; blockedByFootprint reads x/z, which is the code
    // path a walking creep exercises too.
    const placed = await page.evaluate(() => {
      const g = window.__game;
      const i = g.creeps.spawn(g.creeps.typeKeys[0], 500, 5, 0);
      if (i < 0) return { i, blocked: false };
      const p = g.grid.towerCentreToWorld(16, 12, {});
      g.creeps.x[i] = p.x;
      g.creeps.z[i] = p.z;
      g.creeps.flying[i] = 0;          // a flyer is exempt, by design
      return { i, blocked: g.creeps.blockedByFootprint(16, 12) };
    });
    expect(placed.i, 'the creep pool refused to spawn').toBeGreaterThanOrEqual(0);
    expect(placed.blocked, 'the creep is not standing on the footprint').toBe(true);
    const creep = await look('creep', 16, 12);
    expect(creep.hint.on).toBe(true);
    expect(creep.hint.text).toContain('Creeps in the way');
    expect(creep.hint.text).toContain('wait for it to walk on');

    // ---- 6. SEAL -------------------------------------------------------
    const wall = await wallRowExceptGap(page, 4, 12);
    expect(wall.canPlace, 'the gap must be buildable, or the test proves nothing').toBe(true);
    expect(wall.wouldBlock, 'the gap must actually seal, or the test proves nothing').toBe(true);
    const seal = await look('seal', 12, 4);
    expect(seal.hint.on).toBe(true);
    expect(seal.hint.text).toContain('Seals the maze');
    expect(seal.hint.cls).toContain('h-bad');

    // ---- THE HEADLINE --------------------------------------------------
    const codes = Object.values(seen).map((s) => s.code);
    expect(Object.keys(seen).sort()).toEqual(
      ['creep', 'occupied', 'poor', 'seal', 'stacks', 'valid']);
    expect(new Set(codes).size, `two outcomes share a picture: ${JSON.stringify(seen)}`).toBe(6);
    // And no two refusals say the same words either.
    const words = Object.entries(seen).filter(([k]) => k !== 'valid').map(([, s]) => s.hint.text);
    expect(new Set(words).size).toBe(5);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('only a sealing hover pays for the flood fill that paints the cut-off ground', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    // Arena.setSealPreview uploads a texture; Game.#updateHover runs on every
    // pointermove, so the flood fill is gated on `reason === 'seal'` and nothing
    // else. `_sealPainted` is Arena's own record of whether the blue channel
    // currently carries anything.
    const painted = () => page.evaluate(() => !!window.__game.arena._sealPainted);

    const wall = await wallRowExceptGap(page, 12, 12);
    expect(wall.wouldBlock).toBe(true);

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    await hoverCell(page, 16, 8);
    expect(await page.evaluate(() => window.__game.hover.reason)).toBe('valid');
    expect(await painted(), 'a valid hover painted the seal preview').toBe(false);

    await hoverCell(page, 12, 12);
    expect(await page.evaluate(() => window.__game.hover.reason)).toBe('seal');
    expect(await painted(), 'a sealing hover did NOT paint the seal preview').toBe(true);

    // ...and moving off it clears again, so the bars cannot outlive the hover.
    await hoverCell(page, 16, 8);
    await expect.poll(painted).toBe(false);

    await settle(page, 150);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

/**
 * THE PIXELS.
 *
 * Everything above this point asserts the chain that ENDS at a picture and stops
 * one link short of it: placementReason decides, uHoverState is told, the hint
 * says the words. The file docblock admits as much ("the refusal COLOURS live in
 * GLSL and no test in this repo reads pixels"), and docs/PITFALLS.md §8 is the
 * round where that gap cost three iterations — the six refusal hues existed, and
 * not one of them ever reached the screen.
 *
 * A shader that FAILS TO COMPILE is already covered sideways: the three specs
 * above go red on it, because three.js logs a console error and every one of
 * them asserts `errors` is empty. What is not covered is the class that actually
 * shipped: a shader that compiles and paints the wrong thing.
 *
 * These read the composited frame. Every assertion is a DELTA between two reads
 * of the same board, never a colour literal — absolute pixels move with the GPU
 * driver, the quality preset and two seconds of a breathing camera, which is
 * exactly why this repo has no golden images.
 */
test.describe('the overlay actually paints', () => {
  test('turning the grid on changes the board where a cell boundary is', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 5000 });

    // Everything but the arena stops moving BEFORE the first read, so the camera
    // cannot drift between the two samples; the arena keeps running because it
    // owns the ramp being measured.
    await freezeFrame(page, ['arena']);

    // A cell WELL away from the maze and from the lane, measured twice: once
    // with the overlay down and once with it up.
    const clip = await cellClip(page, 10, 8, 44);

    expect((await gridOverlayState(page)).target).toBe(0);
    await expect.poll(() => gridOverlayState(page).then((s) => s.opacity < 0.01)).toBe(true);
    const off = await samplePixels(page, clip);
    const offCap = await captureClip(page, clip);

    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await hoverCell(page, 16, 4);          // grid up, ghost somewhere ELSE
    await expect.poll(
      () => gridOverlayState(page).then((s) => s.visible && s.opacity > 0.9),
      { message: 'the overlay never ramped up' },
    ).toBe(true);
    const on = await samplePixels(page, clip);
    const onCap = await captureClip(page, clip);

    // The scribe lines are cyan and sit over grey flagstone, so both the
    // luminance and the blue channel have to move.
    //
    // TWO FLOORS, AND THE HIGH ONE IS THE POINT. The bars used to be 3 and 2 —
    // chosen as "far above frame-to-frame noise", which they are, and roughly a
    // quarter of what the working grid actually produces, which means the
    // quadrillage could lose 75% of its contrast without a red test. The whole
    // brief for this feature was that the grid was NOT VISIBLE ENOUGH, so a
    // floor a quarter of the way back down is the one thing this file must not
    // ship. Measured on three consecutive runs: luminance delta 26.1 / 26.2 /
    // 26.8, blue delta 32.5 / 32.8 / 33.4, mean-absolute pixel difference 26.6 /
    // 27.2 / 27.6, and the noise floor (two reads of the same frozen frame) 0.00
    // exactly. 12 is under half the measured value — room for a re-tune, no room
    // for a collapse.
    expect(Math.abs(on.lum - off.lum), 'the grid lost most of its contrast')
      .toBeGreaterThan(12);
    expect(on.b - off.b, 'the grid is not painting its cyan').toBeGreaterThan(12);
    // ...and it is a PICTURE, not a wash: a uniform tint over the whole box
    // would satisfy both lines above. Mean absolute difference is per-pixel.
    expect(await clipDistance(page, onCap, offCap), 'the grid is a flat tint, not lines')
      .toBeGreaterThan(12);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a non-buildable cell does NOT look like a free one', async ({ page }) => {
    /**
     * The hatching. `washA` in the fragment shader paints protected-lane and
     * blocked cells with a striped wash and a heavier scribe, and the whole
     * argument for it is that hue alone is useless to roughly one man in twelve —
     * so if the hatch silently stopped being drawn, every existing test would
     * still pass and the accessibility claim would be false.
     */
    const { errors } = await startRun(page, { elements: ['fire'], gold: 5000 });

    // MEASURED AS A DELTA AGAINST THE OVERLAY BEING OFF, on each cell separately.
    // The naive version — sample the two cells with the grid up and compare —
    // measures the TERRAIN: the spawn corridor is a sunken lane and reads 22
    // units cooler than the plateau before the overlay draws anything at all.
    // Subtracting each cell's own overlay-off reading is what isolates the paint.
    await freezeFrame(page, ['arena']);

    const lane = await page.evaluate(() => ({
      canPlace: window.__game.grid.canPlaceTower(12, 0),
    }));
    expect(lane.canPlace, 'cell (12,0) is buildable, so it proves nothing').toBe(false);

    const freeClip = await cellClip(page, 10, 8, 44);
    const laneClip = await cellClip(page, 12, 0, 44);
    await expect.poll(() => gridOverlayState(page).then((s) => s.opacity < 0.01)).toBe(true);
    const freeOff = await samplePixels(page, freeClip);
    const laneOff = await samplePixels(page, laneClip);

    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await hoverCell(page, 16, 4);          // grid up, ghost off both samples
    await expect.poll(
      () => gridOverlayState(page).then((s) => s.visible && s.opacity > 0.9)).toBe(true);
    const freeOn = await samplePixels(page, freeClip);
    const laneOn = await samplePixels(page, laneClip);

    // Both cells got painted. Measured over three runs: the free cell moves
    // 43.4 / 43.6 / 43.4 and the lane cell 30.0 / 30.5 / 31.2, against a noise
    // floor of 0.00 on a frozen frame. 12 is under half the smaller of the two.
    expect(pixelDistance(freeOn, freeOff), 'the free cell lost most of its paint')
      .toBeGreaterThan(12);
    expect(pixelDistance(laneOn, laneOff), 'the protected cell lost most of its paint')
      .toBeGreaterThan(12);

    // ...and NOT with the same paint. FREE_C is cyan (0.38, 0.80, 1.00) while the
    // lane wash is amber (1.00, 0.74, 0.24), so red-minus-blue is the axis that
    // has to separate them. Measured 47.4 / 48.2 / 48.3; the bar was 4, i.e. a
    // twelfth of the shipped separation.
    const warmth = (on, off) => (on.r - on.b) - (off.r - off.b);
    expect(warmth(laneOn, laneOff) - warmth(freeOn, freeOff),
      'a protected cell is painted with the same colour as a free one').toBeGreaterThan(20);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the six refusals paint six different pictures, not six different uniforms', async ({ page }) => {
    /**
     * THE ASSERTION THIS WHOLE FILE WAS MISSING. The distinctness test above
     * proves six different NUMBERS reach the shader. This proves the shader turns
     * them into six different images — which is the thing a player sees, and the
     * thing that was false for a whole round while every uniform was correct.
     *
     * Driven straight through Arena.setHover rather than through six gameplay
     * fixtures: the decision path is already covered above, this is about the
     * painting, and six real fixtures would take four boots to build.
     */
    const { errors } = await startRun(page, { elements: ['fire'], gold: 5000 });

    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await hoverCell(page, 10, 8);
    await expect.poll(
      () => gridOverlayState(page).then((s) => s.visible && s.opacity > 0.9)).toBe(true);
    // Now that the ramp is done, stop the whole frame — several of these motifs
    // pulse on uTime, and two reads of the SAME state at different phases would
    // otherwise look like two different states. The control at the bottom is
    // what proves this worked.
    await freezeFrame(page);

    const clip = await cellClip(page, 10, 8, 48);
    const set = async (state) => page.evaluate((s) => {
      const g = window.__game;
      g.arena.gridMaterial.uniforms.uTime.value = 0;
      g.arena.setHover(10, 8, s);
    }, state);

    const names = ['valid', 'occupied', 'creep', 'seal', 'stacks', 'poor'];
    const seen = {};      // mean colour, for the hue claims below
    const caps = {};      // raw bytes, for the "different picture" claim
    for (const s of names) {
      await set(s);
      seen[s] = await samplePixels(page, clip);
      caps[s] = await captureClip(page, clip);
    }

    /**
     * MEAN ABSOLUTE PER-PIXEL DIFFERENCE, NOT DISTANCE BETWEEN TWO MEANS.
     *
     * This loop used to compare `pixelDistance` — the euclidean distance between
     * the two 48px boxes' AVERAGE colours — against a bar of 10. An average is
     * blind to shape, which is precisely what the test claims to measure, and it
     * bit: `occupied` (a white cross-hatch) against `stacks` (a violet no-entry
     * disc) landed at 9.4-9.8 and this spec failed about one run in four, on
     * both the first attempt and the retry. Side by side and in greyscale the
     * two are unmistakable, so the test was crying "they paint the same picture"
     * about a feature that works — inside the suite whose entire job is to
     * freeze a working build. Lowering the bar to 8 would not have fixed it: the
     * margin was inside the measured noise of the statistic itself.
     *
     * clipDistance only cancels where two images agree PIXEL FOR PIXEL. Measured
     * across three runs: the closest pair is occupied/stacks at 13.5 / 21.8 /
     * 22.6, the furthest is valid/occupied at 62-67, and two reads of the same
     * frozen state come back at 0.00 exactly. The bar is 8 — 1.7x under the
     * worst pair ever observed, and infinitely above the noise floor.
     */
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = await clipDistance(page, caps[names[i]], caps[names[j]]);
        expect(d, `${names[i]} and ${names[j]} paint the same picture (per-pixel difference ${d.toFixed(1)})`)
          .toBeGreaterThan(8);
      }
    }

    // The control, and the reason the threshold above means anything: the same
    // state read twice is identical. Both statistics, because the mean is still
    // used for the hue claims below.
    await set('seal');
    const twice = await samplePixels(page, clip);
    const twiceCap = await captureClip(page, clip);
    expect(pixelDistance(seen.seal, twice), 'the instrument is too noisy to trust')
      .toBeLessThan(6);
    expect(await clipDistance(page, caps.seal, twiceCap),
      'the frame is not frozen: the same state paints two different pictures')
      .toBeLessThan(2);

    // And the two that MUST not be confusable, named explicitly because they are
    // the pair the shader authors themselves called out: 'poor' is gold and says
    // "later", 'seal' is red and says "never".
    expect(hueDistance(seen.poor.hue, seen.seal.hue),
      'the gold "too expensive" ghost and the red "seals the maze" ghost share a hue')
      .toBeGreaterThan(25);
    // 'stacks' is the sixth picture — violet, deliberately not red — and it is
    // the one no click can reach, so this is the only place it is ever seen.
    expect(hueDistance(seen.stacks.hue, seen.seal.hue),
      'the violet stack-shortfall ghost reads as another red refusal')
      .toBeGreaterThan(25);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
