import { test, expect } from '@playwright/test';
import {
  startRun, clickCell, hoverCell, rightClickCell, rightDragCell, readState,
  gridOverlayState, hoverUniforms, cameraAim, watchContextMenu, contextMenuEvents,
} from './helpers.js';

/**
 * RIGHT-CLICK TO CANCEL.
 *
 * The right button belongs to two owners at once. CameraRig binds pointerdown on
 * the canvas and starts an orbit on button 2; Game binds pointerdown on the SAME
 * canvas and watches for a tap. Neither stops propagation, so both handlers see
 * every event and the only thing keeping them out of each other's way is the 5px
 * drag threshold. Every test here is therefore a pair: the gesture must do its
 * job AND must not have done the other owner's.
 *
 * Also asserted throughout: no browser context menu ever appears. CameraRig's
 * preventDefault is the single line that stops one, and a context menu over the
 * board would eat the next click as well as look broken.
 */
test.describe('right-click cancel', () => {
  test('a right-click tap drops the tower in hand', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });
    await watchContextMenu(page);

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    expect((await readState(page)).selectedBuild).toBe('fire');
    await expect(page.locator('#held-piece')).toHaveClass(/\bon\b/);

    const before = await readState(page);
    await rightClickCell(page, 10, 8);

    await expect.poll(() => page.evaluate(() => window.__game.selectedBuild)).toBeNull();
    await expect(page.locator('#dock-pure .tcard[data-tower="fire"]')).not.toHaveClass(/\bselected\b/);
    await expect(page.locator('#held-piece')).not.toHaveClass(/\bon\b/);

    // THE OTHER HALF. Cancelling must not also place the thing being cancelled:
    // the right button must never reach Game.#onClick, which only the button
    // guard in #wirePointer stops it doing.
    const after = await readState(page);
    expect(after.towers, 'the right-click built a tower').toBe(before.towers);
    expect(after.gold).toBe(before.gold);

    // ...and the whole build cursor is torn down with it.
    expect((await gridOverlayState(page)).target).toBe(0);

    const menus = await contextMenuEvents(page);
    expect(menus.length, 'no contextmenu was fired at all').toBeGreaterThan(0);
    for (const m of menus) expect(m.prevented, `context menu on ${m.target}`).toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a right-click tap deselects an inspected tower and closes the inspector', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], gold: 1000 });
    await watchContextMenu(page);

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    await expect(page.locator('#inspector')).toHaveClass(/\bopen\b/);

    // Aim somewhere OTHER than the tower, so this cannot pass by accident of
    // "clicking a tower re-selects it".
    await rightClickCell(page, 16, 12);

    await expect.poll(() => page.evaluate(() => window.__game.selectedTower)).toBeNull();
    await expect(page.locator('#inspector')).not.toHaveClass(/\bopen\b/);
    // The range ring lives in the grid shader, so it goes with the selection.
    expect((await gridOverlayState(page)).target).toBe(0);
    // The tower itself is untouched — this is a deselect, not a sell.
    expect((await readState(page)).towers).toBe(1);

    for (const m of await contextMenuEvents(page)) expect(m.prevented).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('one right-click undoes ONE thing: the piece in hand first', async ({ page }) => {
    /**
     * THIS TEST COULD NOT FAIL, AND NOW IT CAN.
     *
     * It used to build, inspect, then take a fresh piece — but setBuildSelection
     * calls selectTower(null) on its way in, so `selectedTower` was already null
     * before the right-click and the two ordered branches inside
     * Game.#cancelSelection were indistinguishable. Proven by mutation: replacing
     * `if (both)` with `if (true)` — deleting the entire distinction between
     * Escape and right-click — left all six specs in this file green.
     *
     * The pair is unreachable through the UI (see the audit note on
     * #cancelSelection), so the only way to assert the documented ordering is to
     * WRITE THE PAIR DIRECTLY. That is legitimate here precisely because the
     * ordering is a contract about a state the code says it handles: if a future
     * edit collapses the branches, this goes red.
     */
    const { errors } = await startRun(page, { elements: ['fire'], gold: 1000 });

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
      // The raw field, deliberately: setBuildSelection would clear the tower.
      g.selectedBuild = 'fire';
    });
    expect(await page.evaluate(() => window.__game.selectedTower)).not.toBeNull();
    expect(await page.evaluate(() => window.__game.selectedBuild)).toBe('fire');

    // ONE right-click. The piece goes, the inspected tower SURVIVES.
    await rightClickCell(page, 16, 12);
    expect(await page.evaluate(() => window.__game.selectedBuild),
      'the right-click did not drop the piece').toBeNull();
    expect(await page.evaluate(() => window.__game.selectedTower),
      'one right-click undid TWO things').not.toBeNull();

    // A second one takes the tower.
    await rightClickCell(page, 16, 12);
    await expect.poll(() => page.evaluate(() => window.__game.selectedTower)).toBeNull();

    // A third on an empty board is a no-op and throws nothing.
    await rightClickCell(page, 16, 12);
    const s = await readState(page);
    expect(s.selectedBuild).toBeNull();
    expect(s.selectedTower).toBeNull();
    expect(s.towers).toBe(1);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Escape is the panic button: it tears down even when nothing is selected', async ({ page }) => {
    /**
     * The OTHER half of what the `both` parameter buys, and the half that IS
     * reachable on a real board. Escape runs both teardowns unconditionally,
     * which is what guarantees an orphaned ghost or range ring cannot survive a
     * state the code did not predict; a right-click on an empty board does
     * nothing at all. Asserted through the shader uniforms, because "the ring is
     * gone" is a fact about the picture and not about a flag.
     */
    const { errors } = await startRun(page, { elements: ['fire'], gold: 1000 });

    // Both gestures are delivered OFF the canvas (the top bar), because
    // Game.#updateHover clears the ring on any pointermove over the board — so a
    // helper that moves the cursor onto a cell would clear the fixture itself and
    // the test would pass for the wrong reason.
    await page.mouse.move(4, 4);

    // Strand a range ring with nothing selected — exactly the orphan the
    // unconditional teardown exists for.
    await page.evaluate(() => {
      const g = window.__game;
      g.arena.setRangeIndicator(0, 0, 9, 0xff5a1f);
      g.arena.setGridVisible(true);
      g.arena.setHover(10, 8, 'valid');
    });
    expect((await hoverUniforms(page)).range).toBeGreaterThan(0);

    // A right-click changes nothing: there is nothing selected to undo.
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    expect((await hoverUniforms(page)).range,
      'the right-click ran a teardown it was not asked for').toBeGreaterThan(0);

    // Escape sweeps it.
    await page.keyboard.press('Escape');
    await expect.poll(() => hoverUniforms(page).then((u) => u.range)).toBe(0);
    expect((await hoverUniforms(page)).c).toBe(-99);
    expect((await gridOverlayState(page)).target).toBe(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a right-DRAG orbits the camera and does NOT cancel', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });
    await watchContextMenu(page);

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    const aimBefore = await cameraAim(page);

    await rightDragCell(page, 10, 8, 140, 50);

    // The piece is still in hand.
    expect(await page.evaluate(() => window.__game.selectedBuild)).toBe('fire');
    await expect(page.locator('#held-piece')).toHaveClass(/\bon\b/);
    expect((await gridOverlayState(page)).target).toBe(1);

    // ...and the camera really moved, or the drag never reached CameraRig and
    // "it did not cancel" would prove nothing (docs/PITFALLS.md §11).
    const aimAfter = await cameraAim(page);
    expect(Math.abs(aimAfter.azimuth - aimBefore.azimuth),
      'the orbit drag never reached CameraRig').toBeGreaterThan(0.05);
    expect(Math.abs(aimAfter.polar - aimBefore.polar)).toBeGreaterThan(0.005);

    for (const m of await contextMenuEvents(page)) expect(m.prevented).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('an orbit that comes BACK to where it started is still an orbit', async ({ page }) => {
    /**
     * THE COMMONEST CAMERA GESTURE THERE IS: spin the board round to look at
     * something, spin it back. It releases within a pixel or two of its own
     * origin, so the old rule — hypot(up - down) <= 5, the DISPLACEMENT — read it
     * as a tap and dropped the tower in hand mid-gesture, with no visible cause.
     * Measured before the fix: azimuth went -0.16 -> -1.00 -> -0.16, a 48-degree
     * orbit, AND selectedBuild went 'dark' -> null on the release.
     *
     * The existing drag test only ever goes out and never comes home, which is
     * why it never saw this.
     */
    const { errors } = await startRun(page, { elements: ['fire'] });
    await watchContextMenu(page);

    await page.click('#dock-pure .tcard[data-tower="fire"]');
    const aimBefore = await cameraAim(page);

    const pt = await hoverCell(page, 10, 8);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(pt.x + 168, pt.y + 40, { steps: 8 });
    await page.mouse.move(pt.x, pt.y, { steps: 8 });          // ...and back home
    await page.mouse.up({ button: 'right' });

    // The camera really moved and really came back, or this proves nothing.
    const aimAfter = await cameraAim(page);
    expect(Math.abs(aimAfter.azimuth - aimBefore.azimuth),
      'the orbit never returned to its origin, so this is not the gesture under test')
      .toBeLessThan(0.02);

    // ...and the piece is still in hand.
    expect(await page.evaluate(() => window.__game.selectedBuild),
      'an orbit that ended where it began dropped the tower in hand').toBe('fire');
    await expect(page.locator('#held-piece')).toHaveClass(/\bon\b/);
    expect((await gridOverlayState(page)).target).toBe(1);

    for (const m of await contextMenuEvents(page)) expect(m.prevented).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('pointercancel drops the measurement instead of leaving it stale', async ({ page }) => {
    /**
     * A drag that leaves the window, or a gesture the browser takes over, fires
     * pointercancel instead of pointerup. Game.#wirePointer added a handler for
     * exactly that and nothing exercised it: deleting those four lines left the
     * whole suite green. The failure it prevents is delayed and baffling — the
     * stale down-point survives, and the NEXT right-release is measured against
     * a press from minutes earlier.
     */
    const { errors } = await startRun(page, { elements: ['fire'] });
    await page.evaluate(() => window.__game.setBuildSelection('fire'));

    const pt = await hoverCell(page, 10, 8);
    await page.mouse.down({ button: 'right' });
    await page.evaluate(() => document.getElementById('viewport')
      ?.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })));
    expect(await page.evaluate(() => window.__game._cancelDownAt),
      'pointercancel did not clear the down-point').toBeNull();

    // Releasing 200px away must now be inert in both directions: no cancel from
    // the abandoned press, and no cancel from a measurement against null.
    await page.mouse.move(pt.x + 200, pt.y + 60, { steps: 6 });
    await page.mouse.up({ button: 'right' });
    expect(await page.evaluate(() => window.__game.selectedBuild)).toBe('fire');

    // And the NEXT genuine tap still works — the state was cleared, not wedged.
    await rightClickCell(page, 10, 8);
    await expect.poll(() => page.evaluate(() => window.__game.selectedBuild)).toBeNull();

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('right-click cancels over the HUD too, and never serves a browser menu', async ({ page }) => {
    /**
     * The gesture used to be bound to the CANVAS, so it was dead over every pixel
     * of #ui-root — measured, a right-click on #dock, #pause-btn or #threat
     * dropped nothing and served the OS context menu instead. The dock is a
     * full-width band along the bottom and is exactly where the cursor is one
     * instant after taking a piece off it, so "right-click to cancel" failed in
     * its single most common position. With the key sheet up it was worse: the
     * veil covers the whole screen.
     */
    const { errors } = await startRun(page, { elements: ['fire'] });
    await watchContextMenu(page);

    const surfaces = ['#dock', '#pause-btn', '#threat'];
    for (const sel of surfaces) {
      await page.evaluate((s) => {
        window.__game.setBuildSelection('fire');
        return s;
      }, sel);
      expect(await page.evaluate(() => window.__game.selectedBuild)).toBe('fire');
      await page.click(sel, { button: 'right', position: { x: 4, y: 4 }, force: true });
      await expect.poll(() => page.evaluate(() => window.__game.selectedBuild),
        { message: `a right-click on ${sel} did not cancel` }).toBeNull();
    }

    // The full-bleed veil, which covers the canvas that used to be the only
    // surface where any of this worked.
    await page.evaluate(() => { window.__game.setBuildSelection('fire'); window.__game.hud.setHelp(true); });
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    await page.click('#help .help-veil', { button: 'right', position: { x: 20, y: 20 } });
    await expect.poll(() => page.evaluate(() => window.__game.selectedBuild)).toBeNull();
    await page.keyboard.press('Escape');

    // Not one browser menu anywhere in any of that.
    const menus = await contextMenuEvents(page);
    expect(menus.length, 'no contextmenu was fired at all').toBeGreaterThan(3);
    for (const m of menus) expect(m.prevented, `context menu on ${m.target}`).toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a right-click in a text field belongs to the field, menu and all', async ({ page }) => {
    // The one deliberate exemption: pasting a room code into the lobby needs the
    // native menu, and nothing is ever queued behind a focused input.
    const { errors } = await startRun(page, { elements: ['fire'] });
    await watchContextMenu(page);

    await page.evaluate(() => {
      const i = document.createElement('input');
      i.id = '__test-input';
      i.type = 'text';
      i.style.cssText = 'position:fixed;left:8px;top:50%;width:180px;z-index:99999';
      document.body.appendChild(i);
      i.focus();
    });
    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await page.click('#__test-input', { button: 'right' });

    expect(await page.evaluate(() => window.__game.selectedBuild),
      'a right-click in a text field cancelled the build').toBe('fire');
    const onInput = (await contextMenuEvents(page)).filter((m) => m.target === '__test-input');
    expect(onInput.length).toBeGreaterThan(0);
    for (const m of onInput) expect(m.prevented, 'the field lost its paste menu').toBe(false);

    await page.evaluate(() => document.getElementById('__test-input')?.remove());
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a 4px wobble is still a tap, and a left-click still builds', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    // The threshold is 5px inclusive. A hand never releases on the exact pixel
    // it pressed, so the tolerant side of the boundary is the one that matters.
    await page.click('#dock-pure .tcard[data-tower="fire"]');
    const pt = await page.evaluate(() => {
      const g = window.__game;
      const V = g.camera.position.constructor;
      const p = g.grid.towerCentreToWorld(10, 8, {});
      const v = new V(p.x, 0, p.z).project(g.camera);
      return {
        x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
        y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      };
    });
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(pt.x + 3, pt.y + 2);
    await page.mouse.up({ button: 'right' });

    await expect.poll(() => page.evaluate(() => window.__game.selectedBuild)).toBeNull();

    // CONTROL. The left button must be entirely unaffected by any of this: if
    // the pointer wiring had been broken, every assertion above would still pass
    // and the game would be unplayable.
    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await clickCell(page, 10, 8);
    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(1);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('right-click is inert while spectating — the camera keeps the button', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    // Game.#cancelSelection returns early when spectating. The reasoning is in
    // its docblock: the right button is the camera's, and ejecting a player from
    // the board they are watching because an orbit came in under 5px is worse
    // than the inverse. Escape is the way out, and it still is.
    await page.evaluate(() => { window.__game.spectating = true; });
    await page.evaluate(() => window.__game.setBuildSelection('fire'));

    await rightClickCell(page, 10, 8);

    // Nothing was dropped, and nothing threw.
    expect(await page.evaluate(() => window.__game.selectedBuild)).toBe('fire');
    expect(await page.evaluate(() => window.__game.spectating)).toBe(true);

    await page.evaluate(() => { window.__game.spectating = false; });
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
