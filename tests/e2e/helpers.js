/**
 * Helpers shared by the "freeze the current build" E2E suite.
 *
 * fixtures.js owns the boot sequence and the console log. This module owns
 * everything a gameplay spec needs on top of it: getting past the opening
 * element picker, turning a grid cell into a screen coordinate, and clicking it
 * the way a player would.
 *
 * Two rules this file exists to enforce:
 *
 *  1. NO SLEEPS AS ASSERTIONS. `settle()` is only ever used to let an animation
 *     ramp advance; every fact is read back and waited on explicitly.
 *  2. A POINTER TEST THAT DOES NOT REACH THE CANVAS IS A FALSE PASS. `clickCell`
 *     refuses to click a point that is off screen or covered by a HUD panel,
 *     because a swallowed click looks exactly like "the game correctly refused
 *     to build" from the outside. See docs/PITFALLS.md §8 and §11.
 */

import { expect } from '@playwright/test';
import { bootGame, settle } from './fixtures.js';

/** ECONOMY.startGold / startLives. Asserted against the live game in boot.spec.js. */
export const START_GOLD = 275;
export const START_LIVES = 50;

/** PURE_TOWERS.fire level costs — the cheapest thing on the dock. */
export const FIRE_COST = [60, 140, 320];

/** ECONOMY.sellRefund. */
export const SELL_REFUND = 0.75;

/**
 * Boot the game and get it into a normal, playable prep phase.
 *
 * Under Playwright `navigator.webdriver` is true, so main.js skips the lobby and
 * starts a solo run — which opens the element picker as a modal over the board.
 * Every gameplay spec has to answer it first, and none of them care which card
 * the seed happened to offer, so this drives `chooseElement` directly (the same
 * entry point the picker's own click handler calls).
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [opts]
 * @param {string[]} [opts.elements=['fire','water']] elements to bind, in order.
 *        Two by default so morph targets exist — a single element can only morph
 *        into itself, i.e. nowhere.
 * @param {?number} [opts.gold=null]  override the purse (null keeps startGold)
 * @param {boolean} [opts.freeze=true] pause the simulation. Prep counts down to
 *        an automatic wave send and interest pays out on a 15s clock; a spec
 *        asserting an exact gold figure must not race either of them.
 * @returns {Promise<{errors:string[],warnings:string[],logs:string[]}>}
 */
export async function startRun(page, opts = {}) {
  const { elements = ['fire', 'water'], gold = null, freeze = true } = opts;
  const handles = await bootGame(page);

  await page.evaluate(({ elements, gold, freeze }) => {
    const g = window.__game;
    for (const id of elements) {
      // The picker hands out exactly one pick at a time; re-arming the counter
      // is how a spec binds a second element without waiting for wave 5.
      g.state.pendingElementPicks = 1;
      g.chooseElement(id);
    }
    if (gold !== null) {
      g.state.gold = gold;
      g.hud._goldShown = gold;   // skip the count-up tween, this is setup
    }
    g.state.paused = !!freeze;
    g.hud.refreshTop();
    g.hud.refreshBuildBar();
  }, { elements, gold, freeze });

  // The picker is a modal over the canvas: nothing pointer-driven works until it
  // is really gone, so wait for that rather than assuming it.
  await page.waitForFunction(
    () => !document.getElementById('picker')?.classList.contains('open'),
    null,
    { timeout: 10000 });

  return handles;
}

/**
 * Screen position (CSS px) of the centre of the 2x2 tower footprint anchored at
 * (c, r).
 *
 * Mirrors Game.#groundPoint exactly: the game raycasts against the y=0 plane and
 * builds its NDC from window.innerWidth/innerHeight, so this projects the same
 * y=0 point through the same camera and un-NDCs it the same way. Anything else
 * (surface height, canvas bounding rect) would drift the moment the terrain
 * moved under the cursor.
 */
export async function cellToScreen(page, c, r) {
  return page.evaluate(({ c, r }) => {
    const g = window.__game;
    // THREE is not on window; camera.position is a Vector3, so its constructor is.
    const V = g.camera.position.constructor;
    const p = g.grid.towerCentreToWorld(c, r, {});
    const v = new V(p.x, 0, p.z).project(g.camera);
    return {
      x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      w: window.innerWidth,
      h: window.innerHeight,
    };
  }, { c, r });
}

/**
 * Assert that (x, y) actually lands on the 3D viewport.
 *
 * A click that a HUD panel eats produces no tower and no gold change — which is
 * indistinguishable from a correctly refused placement. This turns that silent
 * false pass into a loud failure.
 */
async function assertOnCanvas(page, pt, label) {
  expect(pt.x, `${label}: x off screen`).toBeGreaterThan(0);
  expect(pt.y, `${label}: y off screen`).toBeGreaterThan(0);
  expect(pt.x, `${label}: x off screen`).toBeLessThan(pt.w);
  expect(pt.y, `${label}: y off screen`).toBeLessThan(pt.h);

  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? (el.id || el.className || el.tagName) : 'none';
  }, pt);
  expect(hit, `${label}: point is covered by "${hit}", not the canvas`).toBe('viewport');
}

/** Move the pointer over the tower anchor (c, r). */
export async function hoverCell(page, c, r) {
  const pt = await cellToScreen(page, c, r);
  await assertOnCanvas(page, pt, `hover (${c},${r})`);
  await page.mouse.move(pt.x, pt.y);
  return pt;
}

/**
 * Click the tower anchor (c, r) the way a player does: move, press, release, all
 * at the same point so Game's 5px drag threshold treats it as a click and not as
 * a camera pan.
 */
export async function clickCell(page, c, r) {
  const pt = await hoverCell(page, c, r);
  await page.mouse.down();
  await page.mouse.up();
  return pt;
}

/**
 * Right-button TAP on the tower anchor (c, r): press and release at the same
 * point, so Game's 5px threshold treats it as a cancel rather than as the end of
 * a camera orbit.
 *
 * The right button is SHARED — CameraRig starts an orbit drag on it and Game
 * watches for a tap — and neither listener stops propagation, so both see every
 * event. That is the whole reason the distance rule exists, and the reason the
 * pair of helpers below is a pair.
 */
export async function rightClickCell(page, c, r) {
  const pt = await hoverCell(page, c, r);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  return pt;
}

/**
 * Right-button DRAG from the tower anchor (c, r): the camera orbit. `dx`/`dy`
 * must clear the 5px threshold or this is just a slow tap.
 *
 * Moved in several steps because CameraRig accumulates per-move deltas; one
 * giant jump would still orbit, but it would not exercise the same path a hand
 * does.
 */
export async function rightDragCell(page, c, r, dx = 120, dy = 40) {
  const pt = await hoverCell(page, c, r);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(pt.x + dx, pt.y + dy, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  return pt;
}

/**
 * Record every `contextmenu` event the page sees, and whether it was suppressed.
 *
 * BUBBLE phase, deliberately. A capture-phase listener on window runs BEFORE the
 * canvas handler that calls preventDefault, so it would report
 * `defaultPrevented: false` on an event that is in fact suppressed — a false
 * failure that looks exactly like a real one.
 */
export async function watchContextMenu(page) {
  await page.evaluate(() => {
    window.__ctxMenu = [];
    window.addEventListener('contextmenu', (e) => {
      window.__ctxMenu.push({
        prevented: e.defaultPrevented,
        target: e.target?.id || e.target?.tagName || '?',
      });
    });
  });
}

/** Everything recorded by watchContextMenu so far. */
export async function contextMenuEvents(page) {
  return page.evaluate(() => window.__ctxMenu ?? []);
}

/**
 * What the camera is aiming at. The GOALS, not the eased current values:
 * CameraRig.update lerps `azimuth` towards `_azimuthGoal` over several frames,
 * so reading the live value right after a drag reports a number that is still
 * moving (the same class of trap as gridOverlayState above).
 */
export async function cameraAim(page) {
  return page.evaluate(() => {
    const r = window.__game.rig;
    return { azimuth: r._azimuthGoal, polar: r._polarGoal, dist: r._distGoal };
  });
}

/**
 * What the grid-overlay shader is being told about the hover pad and the range
 * ring — i.e. the picture, not the intention.
 *
 * `state` is Arena.setHover's numeric encoding, which is the ONLY place the six
 * placement outcomes become six different pictures. Reading `game.hover.reason`
 * proves the game decided; reading this proves it told the shader, and the two
 * disagreed for two of the six outcomes before this round (creep shared
 * occupied's code and stacks had none at all).
 */
export async function hoverUniforms(page) {
  return page.evaluate(() => {
    const u = window.__game.arena.gridMaterial.uniforms;
    return {
      state: u.uHoverState.value,
      c: u.uHover.value.x,
      r: u.uHover.value.y,
      range: u.uRange.value,
      opacity: u.uOpacity.value,
    };
  });
}

/** The placement hint chip beside the cursor: is it up, and what does it say. */
export async function placementHint(page) {
  return page.evaluate(() => {
    const el = document.getElementById('place-hint');
    return {
      on: !!el?.classList.contains('on'),
      cls: el?.className ?? '',
      text: (el?.textContent ?? '').trim(),
    };
  });
}

/** A small, named slice of game state. Keeps the specs readable. */
export async function readState(page) {
  return page.evaluate(() => {
    const g = window.__game;
    return {
      gold: g.state.gold,
      lives: g.state.lives,
      wave: g.state.wave,
      score: g.state.score,
      phase: g.state.phase,
      speed: g.state.speed,
      paused: g.state.paused,
      killed: g.state.killed,
      elements: g.state.elements.slice(),
      towers: g.towers.towers.length,
      selectedBuild: g.selectedBuild,
      selectedTower: g.selectedTower,
    };
  });
}

/** The four grid cells a tower anchored at (c, r) occupies. CELL.TOWER === 1. */
export async function footprint(page, c, r) {
  return page.evaluate(({ c, r }) => {
    const g = window.__game;
    const cells = [];
    const ids = [];
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        cells.push(g.grid.get(c + dc, r + dr));
        ids.push(g.grid.towerId[g.grid.idx(c + dc, r + dr)]);
      }
    }
    return { cells, ids };
  }, { c, r });
}

/**
 * Grid-overlay visibility, read the honest way.
 *
 * setGridVisible() only sets a TARGET; Arena.update eases uOpacity towards it
 * and flips mesh.visible on a 0.004 threshold a frame or more later. Reading
 * `gridOverlay.visible` straight after the call reports the stale value — the
 * exact trap docs/PITFALLS.md §10 describes.
 */
export async function gridOverlayState(page) {
  return page.evaluate(() => {
    const a = window.__game.arena;
    return {
      target: a._gridTargetOpacity ?? 0,
      visible: !!a.gridOverlay?.visible,
      opacity: a.gridOverlay?.material?.uniforms?.uOpacity?.value ?? 0,
    };
  });
}

/**
 * Wall off rows `r` and `r + 1` except for a two-column gap, so that a tower
 * placed in the gap would seal the maze.
 *
 * Writes CELL.BLOCKED (2) straight into the grid — terrain, not towers — because
 * building the same wall out of real towers would take two dozen placements and
 * a lot of gold, and the thing under test is the refusal, not the wall.
 */
export async function wallRowExceptGap(page, r, gapC) {
  return page.evaluate(({ r, gapC }) => {
    const g = window.__game;
    for (let c = 0; c < g.grid.cols; c++) {
      if (c === gapC || c === gapC + 1) continue;
      g.grid.set(c, r, 2);
      g.grid.set(c, r + 1, 2);
    }
    g.path.rebuild();
    g.arena.refreshOccupancy();
    return { wouldBlock: g.path.wouldBlock(gapC, r), canPlace: g.grid.canPlaceTower(gapC, r) };
  }, { r, gapC });
}

/** The toast's current text. It is never cleared, only un-shown, so this is safe. */
export async function toastText(page) {
  return page.evaluate(() => document.getElementById('toast')?.textContent ?? '');
}

// ---------------------------------------------------------------------------
// PIXELS
// ---------------------------------------------------------------------------

/**
 * Stop the frame moving, so two screenshots of the same state are the same
 * screenshot.
 *
 * Lifted verbatim from tools/ab.mjs, which needs the identical guarantee for its
 * pass A/Bs. Four independent things animate on a "paused" board: the render
 * loop keeps advancing every shader's uTime (so every pulsing motif drifts), the
 * camera rig idles, the environment breathes, and the grade pass lays down
 * per-frame FILM GRAIN — measured, that combination moves the mean RGB of a 48px
 * box by ~16 units, which is larger than several of the differences these tests
 * exist to detect.
 *
 * A FIFTH THING MOVES, AND IT IS NOT IN Game.frame() — which is why the loop
 * below could not reach it and why it went unnoticed for a round. AdaptiveResolution
 * is driven from main.js's render loop (`game.pipeline.adaptive?.update(dt)`,
 * main.js:148), one line AFTER game.frame(dt). It watches the median frame time
 * and calls `renderer.setPixelRatio()` when the scene is too slow — and
 * `page.screenshot()` is one of the slowest things that can happen to this page.
 * A spec that takes several captures in a row therefore convinces the controller
 * that the machine is struggling, and it drops the resolution UNDERNEATH the
 * test.
 *
 * Measured with tools/scratch/_audit-freeze.mjs, running grid-preview.spec.js's
 * exact sequence: the pixel ratio held at 0.75 (a 1200x675 buffer) across all six
 * captures and had fallen to 0.60 (960x540) by the control read. Nothing about
 * the board had changed; the whole scene had been re-rendered at a different
 * resolution and resampled back up, which moves every edge by a fraction of a
 * pixel. That is what made `grid-preview.spec.js:364` fail on its own control —
 * the same hover state, read twice, came back as two different pictures (3.7
 * against a bar of 2, and 8.7-8.9 against a mean-colour bar of 6).
 *
 * With this line in, two reads of the same frozen state come back at 0.000: the
 * noise floor is exactly zero, so every pixel threshold in this suite is measured
 * against nothing at all rather than against whatever the GPU was busy with.
 *
 * `keep` names subsystems to leave running. Freezing `arena.update` also freezes
 * the grid overlay's OPACITY EASE, so a test that has to sample the board before
 * and after the overlay comes up freezes everything except the arena first (so
 * the camera cannot drift between the two reads) and the arena after the ramp.
 * `keep` deliberately does NOT cover the resolution controller: no test wants a
 * moving pixel ratio, and there is no read for which it is the subject.
 */
export async function freezeFrame(page, keep = []) {
  await page.evaluate((keepList) => {
    const g = window.__game;
    g.state.paused = true;
    for (const k of ['rig', 'arena', 'environment', 'lighting', 'fx']) {
      if (keepList.includes(k)) continue;
      if (g[k] && g[k].update) g[k].update = () => {};
    }
    // Not in the loop above: it hangs off the pipeline, not off the game, and it
    // is updated outside Game.frame(). See the docblock.
    if (g.pipeline?.adaptive) g.pipeline.adaptive.enabled = false;
    const grade = g.pipeline?.passes?.grade;
    if (grade?.uniforms?.uGrain) grade.uniforms.uGrain.value = 0;
  }, keep);
}

/**
 * Read the actual frame.
 *
 * Everything in this suite up to now asserted the chain that ENDS at a pixel —
 * placementReason, then uHoverState, then the hint text — and stopped there.
 * docs/PITFALLS.md §8 records the round where exactly that was not enough: "the
 * six refusal hues existed and not one of them ever reached the screen — the
 * feature was written, reviewed, and never rendered a pixel". A shader that
 * compiles and paints the wrong thing is invisible to every other kind of test
 * in this repo.
 *
 * HOW, and why not gl.readPixels: the scene is drawn through a post pipeline and
 * the default drawing buffer is not preserved, so a readPixels after the fact
 * can legitimately come back empty. page.screenshot is what tools/shot.mjs uses
 * and it captures the composited frame; handing the PNG back to the page to be
 * decoded by the browser is the same trick shot.mjs's black-frame guard uses.
 *
 * Returns mean RGB, mean luminance, and the mean hue/saturation of the coloured
 * pixels — never a golden image. Absolute colours drift between GPU drivers and
 * between two seconds of a breathing camera; DELTAS between two reads of the
 * same frame do not, and every assertion built on this compares two reads.
 */
export async function samplePixels(page, clip) {
  const png = await page.screenshot({ clip, animations: 'disabled' });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    let r = 0, g = 0, b = 0, lum = 0, sat = 0, n = 0;
    let hx = 0, hy = 0, hn = 0;
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i], G = px[i + 1], B = px[i + 2];
      r += R; g += G; b += B; n++;
      lum += 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
      const s = mx === 0 ? 0 : d / mx;
      sat += s;
      if (s > 0.25 && mx > 40) {
        let h = 0;
        if (mx === R) h = ((G - B) / d + 6) % 6;
        else if (mx === G) h = (B - R) / d + 2;
        else h = (R - G) / d + 4;
        h *= 60;
        // Averaged as a unit vector: hue wraps, and a plain mean of 350 and 10
        // is 180 — the opposite colour.
        hx += Math.cos(h * Math.PI / 180); hy += Math.sin(h * Math.PI / 180); hn++;
      }
    }
    const hue = hn ? ((Math.atan2(hy / hn, hx / hn) * 180 / Math.PI) + 360) % 360 : -1;
    return {
      r: r / n, g: g / n, b: b / n,
      lum: lum / n, sat: sat / n,
      hue, colouredFraction: hn / n, n,
    };
  }, png.toString('base64'));
}

/**
 * A screenshot clip centred on the tower anchor (c, r), clamped to the viewport.
 * Small on purpose — a wide box averages in the board around the thing under
 * test and washes out the very difference being measured.
 */
export async function cellClip(page, c, r, size = 40) {
  const pt = await cellToScreen(page, c, r);
  const half = Math.round(size / 2);
  return {
    x: Math.max(0, Math.min(pt.w - size, pt.x - half)),
    y: Math.max(0, Math.min(pt.h - size, pt.y - half)),
    width: size,
    height: size,
  };
}

/** Perceptual-ish distance between two samplePixels reads, 0..~441. */
export function pixelDistance(a, b) {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/**
 * The same clip, kept as raw bytes instead of as three averages.
 *
 * `samplePixels` + `pixelDistance` compare the MEAN colour of a box, and a mean
 * is blind to shape. Two motifs can differ completely and average to nearly the
 * same colour — measured, the `occupied` ghost (a white cross-hatch) and the
 * `stacks` ghost (a violet no-entry disc) are unmistakable side by side in
 * greyscale and sit 9.4-9.8 apart on the mean, against a threshold of 10. The
 * spec that used that pair failed roughly one run in four, on a feature that
 * works, in the suite whose job is to freeze a working build.
 *
 * Kept as a base64 PNG rather than decoded here because decoding needs a canvas,
 * and the canvas lives in the page.
 */
export async function captureClip(page, clip) {
  const png = await page.screenshot({ clip, animations: 'disabled' });
  return { b64: png.toString('base64'), width: clip.width, height: clip.height };
}

/**
 * MEAN ABSOLUTE PER-PIXEL DIFFERENCE between two captures of the same clip,
 * 0..255. Sensitive to shape, unlike a distance between two means: it only
 * cancels where the two images agree pixel for pixel.
 *
 * Still a DELTA between two reads of the same board at the same camera, which is
 * the rule for everything pixel-based in this suite — no golden images.
 */
export async function clipDistance(page, a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`clipDistance needs two captures of the same clip (${a.width}x${a.height} vs ${b.width}x${b.height})`);
  }
  return page.evaluate(async ([x, y]) => {
    const load = async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, cv.width, cv.height).data;
    };
    const A = await load(x), B = await load(y);
    if (A.length !== B.length) return -1;
    let sum = 0, n = 0;
    for (let i = 0; i < A.length; i += 4) {
      sum += (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3;
      n++;
    }
    return sum / n;
  }, [a.b64, b.b64]);
}

/** Smallest angle between two hues, in degrees. -1 on either side means "no hue". */
export function hueDistance(a, b) {
  if (a < 0 || b < 0) return -1;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export { settle };
