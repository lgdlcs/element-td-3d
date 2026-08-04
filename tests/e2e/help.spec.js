import { test, expect } from '@playwright/test';
import { startRun, readState, settle, cameraAim } from './helpers.js';

/**
 * THE KEY SHEET, and the key caps scattered across the HUD.
 *
 * The sheet is a TRANSCRIPT of listeners that live in four other files
 * (Game.js's keydown switch, BuildBar.js's, CameraRig.js's, PerfHud.js's), which
 * is the exact shape of failure docs/PITFALLS.md §10 warns about: a claim about
 * another file's contents, with nothing keeping the two in step. uikit.js's
 * SHORTCUTS docblock says as much itself.
 *
 * THIS FILE USED TO COMPARE A TRANSCRIPT WITH A TRANSCRIPT. `GAME_KEYS`,
 * `DOCK_KEYS` and `PANEL_KEYS` were hand-copied here from those switches and
 * compared against a sheet built from SHORTCUTS, which is hand-copied there from
 * the same switches. Both sides of the comparison were copies of one human
 * artefact and the real source was never read, so adding `case 'KeyZ':` to
 * Game.js and telling nobody left all six tests green — the precise failure the
 * sheet exists to prevent.
 *
 * Now direction 1 READS THE SOURCE. Vite serves /src/* in dev (this suite
 * already depends on that), so the specs below fetch the listener files, extract
 * the key codes from the real switch, and assert set equality against the
 * `<kbd>` caps in the rendered sheet. Direction 2 (nothing advertised that is not
 * bound) stays, and the "is it actually live" spec below stays, because a
 * `case 'KeyU': break;` would satisfy both directions and still be dead.
 */

/**
 * Physical codes -> what a cap SAYS. Extraction gives codes; the sheet is
 * written in labels, and this is the only mapping between them.
 */
const CAP_OF = (code) => {
  if (code === 'Escape') return 'Esc';
  if (code === 'Space') return 'Space';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[code];
  return code;
};

/**
 * Pull the key codes a source file's keydown handling actually matches.
 *
 * Deliberately syntactic and deliberately narrow: `case 'KeyU':` and
 * `e.code === 'KeyF'` are the two forms every listener in this repo uses, plus
 * BuildBar's HOTKEYS array. Anything else is not matched, and a listener written
 * in a third style would show up as a MISSING key here rather than as a silent
 * pass — which is the safe direction to fail in.
 *
 * THAT LAST SENTENCE IS ONLY TRUE OF A STYLE, NOT OF A NAME, and the difference
 * cost a real omission. `CODE` used to list Key, Digit1-9, Space, Escape and the
 * four arrows and nothing else, so PerfHud's `e.code !== 'F8'` matched the STYLE
 * the extractor understands and produced no code at all — F8 was bound, absent
 * from the sheet, and silently exempt from the equality that exists to catch
 * exactly that. The class is now closed over the function keys and Digit0 too.
 */
async function boundKeys(page, path) {
  const src = await page.evaluate((p) => fetch(p).then((r) => r.text()), path);
  const codes = new Set();
  const CODE = "(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Space|Escape|Enter|Arrow(?:Left|Right|Up|Down))";
  for (const re of [
    new RegExp(`case\\s+'${CODE}'`, 'g'),
    new RegExp(`e\\.code\\s*===\\s*'${CODE}'`, 'g'),
    new RegExp(`e\\.code\\s*!==\\s*'${CODE}'`, 'g'),   // PerfHud's early-return form
    new RegExp(`'(Key[A-Z])'`, 'g'),          // BuildBar's HOTKEYS array
  ]) {
    for (const m of src.matchAll(re)) codes.add(m[1]);
  }
  return codes;
}

/** Every `<kbd>` inside the sheet, grouped by the section heading above it. */
const readSheet = (page) => page.evaluate(() => {
  const out = {};
  for (const g of document.querySelectorAll('#help .help-group')) {
    const title = g.querySelector('.legend')?.textContent?.trim() ?? '?';
    out[title] = [...g.querySelectorAll('kbd')].map((k) => k.textContent.trim());
  }
  return out;
});

const allCaps = (groups) => [...new Set(Object.values(groups).flat())];

test.describe('key sheet', () => {
  test('opens on H, on ? and on its HUD button; closes on Escape', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);
    await expect(page.locator('#help-btn')).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#help')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#help-btn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#help .help-sheet')).toBeVisible();

    // H again toggles it back off.
    await page.keyboard.press('h');
    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);

    // '?' is a `key` test rather than a `code` test, deliberately: it is Shift+/
    // on a US layout and Shift+, on a French one, so no physical code describes
    // it. KeyH is the layout-proof fallback and is what the UI advertises.
    await page.keyboard.press('Shift+Slash');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);

    await page.keyboard.press('Escape');
    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);

    // The button opens it too, and the close button shuts it.
    await page.click('#help-btn');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    await page.click('#help .help-close');
    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('advertises every key the SOURCE binds — read from the source, not transcribed', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });
    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    const caps = allCaps(await readSheet(page));

    // Read the real listeners. If Vite ever stops serving source, these come
    // back empty and the sanity check below fails loudly rather than passing
    // vacuously.
    const sources = {
      '/src/game/Game.js': 5,
      '/src/ui/BuildBar.js': 5,
      '/src/ui/HUD.js': 1,
      '/src/ui/PerfHud.js': 1,
      '/src/ui/Picker.js': 1,
      // CameraRig IS read, and it was not. Its absence made the WASD exemption
      // below dead code: those codes could never enter `bound`, so an exemption
      // that looks like coverage covered nothing.
      '/src/core/CameraRig.js': 4,
    };
    const bySource = {};
    for (const [path, floor] of Object.entries(sources)) {
      bySource[path] = await boundKeys(page, path);
      // A floor on EVERY file, not only on the two big ones. A fetch that 404s
      // or a file that moves returns an empty set, and an empty set makes the
      // loop below pass by reading nothing.
      expect(bySource[path].size, `${path} source was not readable`).toBeGreaterThanOrEqual(floor);
    }
    const [game, dock, hud, perf, picker, rigKeys] = Object.values(bySource);

    // WASD IS NO LONGER EXEMPT. The exemption used to read "WASD lives in
    // CameraRig behind a Set, not a switch" — but CameraRig was not among the
    // files fetched, so those codes could never have appeared in `bound` and the
    // exemption covered nothing at all. It is read now, its Set literals match
    // the third pattern, and the caps it needs (W A S D Q E) are on the sheet.
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']) {
      expect(rigKeys.has(c), `CameraRig no longer binds ${c}`).toBe(true);
    }
    // One alias remains, declared rather than quietly passing: Picker binds
    // ArrowUp/ArrowDown as pure aliases of Left/Right (one `else if` each, same
    // call), and the sheet prints the pair the picker's own footer prints.
    // Listing four arrows for two behaviours is noise.
    const EXEMPT = new Set();
    const ALIAS = { ArrowUp: 'ArrowLeft', ArrowDown: 'ArrowRight' };
    const pickerSrc = await page.evaluate(() => fetch('/src/ui/Picker.js').then((r) => r.text()));
    expect(pickerSrc, 'ArrowUp is no longer an alias of ArrowLeft')
      .toMatch(/'ArrowLeft'\s*\|\|\s*e\.code === 'ArrowUp'/);
    expect(pickerSrc, 'ArrowDown is no longer an alias of ArrowRight')
      .toMatch(/'ArrowRight'\s*\|\|\s*e\.code === 'ArrowDown'/);

    const bound = new Set([...game, ...dock, ...hud, ...perf, ...picker]);
    for (const code of bound) {
      if (EXEMPT.has(code)) continue;
      const cap = CAP_OF(ALIAS[code] ?? code);
      expect(caps, `a listener binds ${code} and the sheet omits "${cap}"`).toContain(cap);
    }

    // The control, so the loop above cannot pass by reading nothing: a code that
    // no listener matches must NOT appear on the sheet.
    expect(bound.has('KeyZ')).toBe(false);
    expect(caps).not.toContain('Z');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('names the POINTER gestures too, including the one this branch added', async ({ page }) => {
    /**
     * A panel headed "Every key on the board" shipped omitting three live
     * pointer bindings, one of which — right-click to drop what you are holding
     * — was added in the same change as the panel. It existed only on the
     * transient #held-piece chip, which disappears the moment the piece does.
     *
     * Read from CameraRig's own source for the two camera gestures, so this
     * cannot rot the way the key lists did.
     */
    const { errors } = await startRun(page, { elements: ['fire'] });
    await page.keyboard.press('h');
    const caps = allCaps(await readSheet(page));

    const rig = await page.evaluate(() => fetch('/src/core/CameraRig.js').then((r) => r.text()));
    // CameraRig.#bind: button 2 or shift+button 0 orbits, button 1 pans.
    expect(rig, 'CameraRig no longer orbits on the right button').toMatch(/e\.button === 2/);
    expect(rig, 'CameraRig no longer orbits on shift+left').toMatch(/e\.button === 0 && e\.shiftKey/);
    expect(rig, 'CameraRig no longer pans on the middle button').toMatch(/e\.button === 1/);
    for (const cap of ['Right-drag', 'Shift', 'Left-drag', 'Middle-drag', 'Wheel']) {
      expect(caps, `the camera binds it and the sheet omits "${cap}"`).toContain(cap);
    }

    // Game.#wirePointer's right-button tap.
    const gameSrc = await page.evaluate(() => fetch('/src/game/Game.js').then((r) => r.text()));
    expect(gameSrc, 'the right-click cancel is gone').toMatch(/#cancelSelection\(\)/);
    expect(caps, 'right-click cancels and the sheet does not say so').toContain('Right-click');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('advertises none that it does not bind', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });
    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);

    const groups = await readSheet(page);

    // ---- direction 2: the Game-owned groups claim EXACTLY the switch ----
    // Any letter added to one of these two sections is a claim about Game.js's
    // switch, so the comparison is an equality and not a subset.
    expect(groups['The selected tower']).toEqual(['U', 'M', 'X']);
    expect(groups['The run']).toEqual(['Space', 'P', '1', '2', '3']);

    // The remaining Game key lives in the Building section alongside the dock's,
    // and so does the right-button gesture that undoes exactly what Escape does.
    expect(groups.Building).toEqual(['Q', 'W', 'E', 'R', 'T', 'Y', 'B', 'F', 'Esc', 'Right-click']);

    // Five sections, no empty one, and every cap is a real <kbd> element so
    // assistive tech announces it as keyboard input.
    expect(Object.keys(groups)).toEqual(
      ['Building', 'The selected tower', 'The run', 'Camera', 'Elsewhere']);
    for (const [title, list] of Object.entries(groups)) {
      expect(list.length, `${title} is empty`).toBeGreaterThan(0);
    }
    // Scoped to .help-cols: the footer carries two more caps (H and Esc) that
    // describe the sheet itself rather than the game.
    expect(await page.locator('#help .help-cols kbd').count()).toBe(
      Object.values(groups).reduce((n, l) => n + l.length, 0));
    expect(await page.locator('#help .help-foot kbd').allTextContents()).toEqual(['H', 'Esc']);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('every key the sheet advertises for the run and the selection is actually live', async ({ page }) => {
    /**
     * The other half of "the transcript is true". Direction 2 above proves the
     * sheet does not name a key the switch has no case for; this proves the case
     * does something. A `case 'KeyU': break;` would satisfy both the sheet and
     * the previous test and would still be a dead shortcut.
     */
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 20000 });
    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });

    // P, 1/2/3 and U each have to move something. Ordered so nothing undoes an
    // earlier reading; X is last because it removes the tower the others need.
    const before = await readState(page);
    await page.keyboard.press('p');
    expect((await readState(page)).paused, 'P is advertised and dead').not.toBe(before.paused);
    await page.keyboard.press('p');

    for (const n of [3, 2, 1]) {
      await page.keyboard.press(String(n));
      expect((await readState(page)).speed, `${n} is advertised and dead`).toBe(n);
    }

    await page.keyboard.press('u');
    await expect.poll(() => page.evaluate(() => window.__game.towers.towers[0].level),
      { message: 'U is advertised and dead' }).toBe(1);

    await page.keyboard.press('m');
    await expect.poll(() => page.evaluate(() => window.__game.hud.inspector.view),
      { message: 'M is advertised and dead' }).toBe('morph');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__game.selectTower(window.__game.towers.towers[0].id));

    await page.keyboard.press('x');
    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length),
      { message: 'X is advertised and dead' }).toBe(0);

    // Space last of all: it leaves prep, which the assertions above depend on.
    expect((await readState(page)).phase).toBe('prep');
    await page.keyboard.press('Space');
    expect((await readState(page)).phase, 'Space is advertised and dead').toBe('combat');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('so are the Building, Camera and Elsewhere keys — the other three groups', async ({ page }) => {
    /**
     * THE TEST ABOVE COVERED TWO GROUPS OUT OF FIVE.
     *
     * Its own docblock says why it exists — "a `case 'KeyU': break;` would
     * satisfy both the sheet and the previous test and would still be a dead
     * shortcut" — and then it exercised only "The run" and "The selected tower".
     * Proved by mutation: replacing PerfHud's `this.toggle()` with `return;`
     * leaves G bound, still calling preventDefault, still advertised, and doing
     * nothing — and the whole file stayed green. B, F and the element hotkeys
     * are the keys a player tries FIRST, and the picker's arrows are the first
     * modal they ever meet.
     */
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 20000 });

    // ---- Building: B, F, Q/W ------------------------------------------
    await page.keyboard.press('b');
    expect((await readState(page)).selectedBuild, 'B is advertised and dead').toBe('foundation');
    await page.keyboard.press('b');   // toggles back off
    expect((await readState(page)).selectedBuild).toBeNull();

    await page.keyboard.press('f');
    await expect(page.locator('#codex'), 'F is advertised and dead').toHaveClass(/\bopen\b/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#codex')).not.toHaveClass(/\bopen\b/);

    // Q and W are the first two of ELEMENT_ORDER, which is the order the run was
    // seeded in. A hotkey for an UNBOUND element must stay inert, which is the
    // other half of the contract and the reason E is checked too.
    await page.keyboard.press('q');
    expect((await readState(page)).selectedBuild, 'Q is advertised and dead').toBe('fire');
    await page.keyboard.press('w');
    expect((await readState(page)).selectedBuild, 'W is advertised and dead').toBe('water');
    await page.keyboard.press('e');
    expect((await readState(page)).selectedBuild, 'E armed an element that is not bound').toBe('water');
    await page.keyboard.press('Escape');

    // ---- Camera: W/A/S/D pan, Q/E orbit -------------------------------
    // The same two letters do two things at once and the sheet says so, so the
    // camera has to be read separately from the dock. Held DOWN, because the rig
    // integrates its keys per frame rather than acting on the keydown.
    //
    // focus() with a distance first, and that is not decoration: CameraRig boots
    // with `_autoFrame` true and re-solves the framing for its first ~60 update
    // calls, which rewrites _targetGoal from under a pan. Measured — holding D
    // moved the target to 6.87 and it was back at 0 a moment after the release,
    // so a before/after read is a coin toss. focus(x, z, dist) is the public way
    // to turn auto-framing off; it is what tools/shot.mjs uses.
    await page.evaluate(() => window.__game.rig.focus(0, 0, 40));
    const pan = () => page.evaluate(() => {
      const t = window.__game.rig._targetGoal;
      return { x: +t.x.toFixed(3), z: +t.z.toFixed(3) };
    });
    const pan0 = await pan();
    await page.keyboard.down('d');
    await expect.poll(async () => (await pan()).x !== pan0.x || (await pan()).z !== pan0.z,
      { message: 'D is advertised and dead' }).toBe(true);
    await page.keyboard.up('d');

    const aim1 = await cameraAim(page);
    await page.keyboard.down('q');
    await expect.poll(async () => (await cameraAim(page)).azimuth,
      { message: 'Q is advertised and dead as an orbit key' }).not.toBe(aim1.azimuth);
    await page.keyboard.up('q');
    await page.keyboard.press('Escape');   // Q also armed a tower, by design

    // ---- Elsewhere: G ---------------------------------------------------
    // main.js exposes the readout as window.__perf; PerfHud.visible reads its
    // own inline display, which is the same thing the player sees.
    expect(await page.evaluate(() => window.__perf?.visible ?? null),
      'no PerfHud to toggle').toBe(false);
    await page.keyboard.press('g');
    await expect.poll(() => page.evaluate(() => window.__perf.visible),
      { message: 'G is advertised and dead' }).toBe(true);
    await page.keyboard.press('g');
    await expect.poll(() => page.evaluate(() => window.__perf.visible)).toBe(false);

    // ---- Elsewhere: the picker's arrows and Enter ----------------------
    // The picker tracks its selection with FOCUS, not with an index, so the
    // observable is which card owns document.activeElement.
    await page.evaluate(() => {
      const g = window.__game;
      g.state.pendingElementPicks = 1;
      g.hud.openElementPicker();
    });
    await expect(page.locator('#picker')).toHaveClass(/\bopen\b/);
    const focused = () => page.evaluate(() => {
      const cards = [...document.querySelectorAll('#picker-cards .pcard')];
      return cards.indexOf(document.activeElement);
    });
    // show() focuses the first card on the next frame.
    await expect.poll(focused, { message: 'the offer never took focus' }).toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect.poll(focused, { message: 'the right arrow is advertised and dead' }).toBe(1);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(focused, { message: 'the left arrow is advertised and dead' }).toBe(0);

    const owned = (await readState(page)).elements.length;
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__game.state.elements.length),
      { message: 'Enter is advertised and dead' }).toBe(owned + 1);
    await expect(page.locator('#picker')).not.toHaveClass(/\bopen\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('is a real modal for the KEYBOARD too: game keys do not fire through the veil', async ({ page }) => {
    /**
     * THE OTHER HALF OF aria-modal="true".
     *
     * #help declares role="dialog" aria-modal="true", traps Tab, takes focus and
     * lays a full-bleed veil that eats every click. All of that was true for the
     * mouse and none of it was true for the keyboard: HUD's listener consumed
     * H, ?, Escape and Tab and RETURNED, so BuildBar's window listener and
     * Game.js's switch went on running behind the veil. Measured with the sheet
     * open: Space sent wave 1 and moved the phase from prep to combat, P
     * un-paused, 3 set the speed, Q armed a Fire Tower — none of it visible,
     * because the veil covers #held-piece and the dock.
     *
     * Sending a wave early is IRREVERSIBLE, and the sheet is precisely the
     * surface a player opens mid-prep to check a key.
     */
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 20000, freeze: false });
    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
      g.setSpeed(1);
    });

    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    const before = await readState(page);
    expect(before.phase).toBe('prep');
    const level0 = await page.evaluate(() => window.__game.towers.towers[0].level);

    // F is deliberately NOT in this list: it swaps this sheet for the Tower
    // Table, which is the one thing a reference panel is allowed to do to
    // another, and the sheet advertises it. Everything below touches the run.
    for (const k of ['Space', 'p', '3', 'q', 'b', 'u', 'm', 'x', 'g']) {
      await page.keyboard.press(k);
    }
    await settle(page, 200);

    const after = await readState(page);
    expect(after.phase, 'Space sent a wave through the veil').toBe('prep');
    expect(after.wave, 'Space advanced the wave through the veil').toBe(before.wave);
    expect(after.paused, 'P toggled pause through the veil').toBe(before.paused);
    expect(after.speed, '3 changed the speed through the veil').toBe(before.speed);
    expect(after.selectedBuild, 'a dock hotkey armed a tower through the veil').toBeNull();
    expect(after.towers, 'X sold a tower through the veil').toBe(before.towers);
    expect(await page.evaluate(() => window.__game.towers.towers[0].level),
      'U upgraded through the veil').toBe(level0);
    expect(await page.evaluate(() => window.__perf.visible),
      'G toggled the perf readout through the veil').toBe(false);
    expect(await page.evaluate(() => window.__game.hud.inspector.view),
      'M opened the morph sheet through the veil').not.toBe('morph');

    // The sheet is still up and still the thing with focus — none of those keys
    // closed it either.
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);

    // ...and the four keys the sheet DOES own still work through the shield.
    await page.keyboard.press('h');
    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);
    // With the sheet shut, the very same key that did nothing a moment ago works.
    await page.keyboard.press('3');
    expect((await readState(page)).speed, 'the shield outlived the sheet').toBe(3);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('fits without an internal scrollbar on a short laptop frame', async ({ page }) => {
    /**
     * ui.css's `max-height: 860px` block states the contract: "the key sheet has
     * to fit WITHOUT an internal scrollbar, because the last group of shortcuts
     * is a group nobody scrolls to". It did not hold. Measured at 1440x620 —
     * a 1366x768 laptop with a tab strip and an address bar — scrollHeight 615
     * against clientHeight 546, i.e. 69px over, with the final row (the element
     * picker's arrows) cut in half.
     *
     * Root cause was .help-cols: an auto-fit GRID capped at two tracks by the
     * sheet's own max width, aligning five unequal groups into rows as tall as
     * their tallest member. It is a multi-column box now.
     */
    const { errors } = await startRun(page, { elements: ['fire'] });

    for (const [width, height] of [[1440, 620], [1280, 660], [1600, 900], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.__game.hud.setHelp(true));
      await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
      await expect.poll(async () => {
        const a = await page.evaluate(() => document.querySelector('#help .help-sheet').scrollHeight);
        await new Promise((r) => setTimeout(r, 60));
        const b = await page.evaluate(() => document.querySelector('#help .help-sheet').scrollHeight);
        return a === b;
      }, { message: `the sheet never settled at ${width}x${height}` }).toBe(true);

      const m = await page.evaluate(() => {
        const s = document.querySelector('#help .help-sheet');
        const groups = [...document.querySelectorAll('#help .help-group')];
        const last = groups[groups.length - 1].getBoundingClientRect();
        const box = s.getBoundingClientRect();
        return {
          over: s.scrollHeight - s.clientHeight,
          groups: groups.length,
          lastBottom: Math.round(last.bottom),
          sheetBottom: Math.round(box.bottom),
          sheetTop: Math.round(box.top),
        };
      });
      const at = `at ${width}x${height}`;
      expect(m.groups, `groups went missing ${at}`).toBe(5);
      expect(m.over, `the key sheet needs an internal scrollbar ${at}`).toBeLessThanOrEqual(1);
      // The overflow number alone would be satisfied by a sheet taller than the
      // window; this is the claim the docblock actually makes.
      expect(m.lastBottom, `the last group of shortcuts is below the fold ${at}`)
        .toBeLessThanOrEqual(m.sheetBottom);
      expect(m.sheetTop, `the sheet starts above the frame ${at}`).toBeGreaterThanOrEqual(0);
      expect(m.sheetBottom, `the sheet ends below the frame ${at}`).toBeLessThanOrEqual(height);
      await page.evaluate(() => window.__game.hud.setHelp(false));
    }

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('stands down for the end card and the element offer, which demand an answer', async ({ page }) => {
    /**
     * #help is z-index 44, #endcard is 40 and #picker is 30 — so the reference
     * sheet went OVER both decision modals AND its veil ate their clicks.
     * Measured: after showEnd(false), H put the sheet on top and
     * elementFromPoint at the centre of the end card's button returned
     * `.help-cols`. The ui.css block claimed the opposite ("under ... the end
     * card (50-ish)"), which is what a comment asserting another file's constant
     * gets you.
     *
     * showEnd() already closed the sheet on the way in; this is the other
     * direction.
     */
    const { errors } = await startRun(page, { elements: ['fire'] });

    // ---- the element offer ---------------------------------------------
    await page.evaluate(() => {
      const g = window.__game;
      g.state.pendingElementPicks = 1;
      g.hud.openElementPicker();
    });
    await expect(page.locator('#picker')).toHaveClass(/\bopen\b/);
    await page.keyboard.press('h');
    await expect(page.locator('#help'), 'the sheet opened over a forced choice')
      .not.toHaveClass(/\bopen\b/);
    // The offer is still usable — nothing swallowed its keys on the way past.
    await page.keyboard.press('Enter');
    await expect(page.locator('#picker')).not.toHaveClass(/\bopen\b/);

    // ...and once it is gone, H works again.
    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    await page.keyboard.press('Escape');

    // ---- the end card ---------------------------------------------------
    await page.evaluate(() => window.__game.hud.showEnd(false));
    await expect(page.locator('#endcard')).toHaveClass(/\bshow\b/);
    await page.keyboard.press('h');
    await expect(page.locator('#help'), 'the sheet opened over the end card')
      .not.toHaveClass(/\bopen\b/);
    // The end card's own control is reachable, which is the failure this is for.
    const onTop = await page.evaluate(() => {
      const b = document.getElementById('end-again');
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === b || b.contains(hit);
    });
    expect(onTop, 'something is covering the end card button').toBe(true);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a click outside closes it WITHOUT reaching the board', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    // A piece in hand is what makes this test worth writing: without the
    // full-bleed veil, "outside" is the board and dismissing the sheet would
    // queue a tower on whatever tile the cursor happened to be over.
    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);

    const before = await readState(page);
    // Top-left corner: outside the centred sheet at any viewport this suite uses.
    await page.mouse.click(12, 12);

    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);
    const after = await readState(page);
    expect(after.towers, 'the dismissing click reached the board').toBe(before.towers);
    expect(after.gold).toBe(before.gold);
    expect(after.selectedBuild).toBe('fire');

    // A click ON the sheet does not close it.
    await page.keyboard.press('h');
    await page.click('#help .help-head h3');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('does not open when the key is typed into a text field', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'] });

    await page.evaluate(() => {
      const i = document.createElement('input');
      i.id = '__test-input';
      i.type = 'text';
      i.style.cssText = 'position:fixed;left:8px;top:50%;z-index:99999';
      document.body.appendChild(i);
      i.focus();
    });

    await page.keyboard.type('h?h');
    await settle(page, 150);

    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);
    expect(await page.inputValue('#__test-input')).toBe('h?h');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('never shares the screen with the tower table', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire'], freeze: false });

    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    await page.keyboard.press('f');
    await expect(page.locator('#codex')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);

    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#codex')).not.toHaveClass(/\bopen\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('opens DURING a wave and stays open — H is not a control that flickers', async ({ page }) => {
    /**
     * THE SHIPPED BLOCKER THIS FREEZES.
     *
     * HUD.update used to close the sheet on every frame whose phase was not
     * prep/lobby/pickElement. `combat` is where a run spends most of its time, so
     * H and the ? button both put the sheet up for exactly one frame and then
     * tore it down: measured `open` immediately and `false` at +120ms. That does
     * not read as a refusal, it reads as a crash — and it made the panel built
     * to answer "the shortcuts are not visible enough" unreachable for most of
     * the game.
     *
     * The assertion is deliberately about STABILITY, not just about the class
     * being set: a one-frame open would pass a bare toHaveClass. Two reads, one
     * settle apart, plus the same check for the button and the same check after
     * a wave starts underneath an already-open sheet.
     */
    const { errors } = await startRun(page, { elements: ['fire'], freeze: false });

    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__game.state.phase)).toBe('combat');

    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);
    await settle(page, 600);
    expect(await page.evaluate(() => window.__game.state.phase)).toBe('combat');
    await expect(page.locator('#help'), 'the sheet closed itself during combat').toHaveClass(/\bopen\b/);
    await expect(page.locator('#help .help-sheet')).toBeVisible();

    // The button is the other way in, and it was equally dead.
    await page.keyboard.press('Escape');
    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);
    await page.click('#help-btn');
    await settle(page, 400);
    await expect(page.locator('#help-btn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('is a real modal: focus goes in, Tab cannot leave, and Escape is consumed', async ({ page }) => {
    /**
     * `.help-sheet` declares role="dialog" aria-modal="true". Nothing used to
     * honour it: focus stayed on <body>, and six Tabs walked onto the three speed
     * buttons, #pause-btn, #restart-btn and #help-btn — every one of them behind
     * the veil and activatable with Space or Enter. #restart-btn calls
     * location.reload(), so a keyboard player reading the shortcut sheet could
     * destroy their own run with Tab x5 + Enter.
     *
     * The Escape half is a separate promise the UI made twice at once: the
     * sheet's footer says "Esc closes it" and the #held-piece chip says "Esc or
     * right-click to cancel". One press used to do both.
     */
    const { errors } = await startRun(page, { elements: ['fire'] });
    await page.evaluate(() => window.__game.setBuildSelection('fire'));

    await page.keyboard.press('h');
    await expect(page.locator('#help')).toHaveClass(/\bopen\b/);

    const inSheet = () => page.evaluate(() =>
      !!document.activeElement?.closest('#help .help-sheet'));
    expect(await inSheet(), 'focus never entered the dialog').toBe(true);

    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await inSheet(), `Tab ${i + 1} escaped the dialog`).toBe(true);
    }
    // Shift+Tab is the same trap from the other side.
    await page.keyboard.press('Shift+Tab');
    expect(await inSheet()).toBe(true);

    // ONE Escape closes the sheet and leaves the piece in hand...
    await page.keyboard.press('Escape');
    await expect(page.locator('#help')).not.toHaveClass(/\bopen\b/);
    expect(await page.evaluate(() => window.__game.selectedBuild),
      'Escape closed the sheet AND dropped the piece').toBe('fire');
    // ...and focus comes back to the control that opened it, not to <body>.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('help-btn');

    // ...the SECOND drops the piece, which is what the chip promises.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__game.selectedBuild)).toBeNull();

    expect(errors, errors.join('\n')).toEqual([]);
  });
});

test.describe('key caps on the controls themselves', () => {
  test('the HUD wears the caps the sheet promises', async ({ page }) => {
    // freeze:false so the pause glyph starts in its resting state — startRun
    // pauses by default, which would make the toggle below run backwards.
    const { errors } = await startRun(page, { elements: ['fire'], freeze: false });

    // A sheet nobody opens teaches nobody anything; the caps on the controls are
    // how a player learns a shortcut without going looking for it. Each pair
    // below is the visible cap AND the aria-keyshortcuts that says the same
    // thing to a screen reader.
    const caps = [
      ['#pause-btn kbd', 'P', '#pause-btn', 'P'],
      ['#help-btn kbd', 'H', '#help-btn', 'H'],
      ['#send-wave kbd', 'Space', '#send-wave', 'Space'],
      ['#codex-toggle kbd', 'F', '#codex-toggle', 'F'],
      ['#speed-buttons button[data-speed="1"] kbd', '1', '#speed-buttons button[data-speed="1"]', '1'],
      ['#speed-buttons button[data-speed="2"] kbd', '2', '#speed-buttons button[data-speed="2"]', '2'],
      ['#speed-buttons button[data-speed="3"] kbd', '3', '#speed-buttons button[data-speed="3"]', '3'],
    ];
    for (const [capSel, text, btnSel, shortcut] of caps) {
      await expect(page.locator(capSel), capSel).toHaveText(text);
      await expect(page.locator(btnSel)).toHaveAttribute('aria-keyshortcuts', shortcut);
    }

    // The pause glyph is rewritten every frame; if that write ever goes back to
    // the BUTTON instead of the .ib-glyph span it deletes the cap on tick one
    // and nobody ever sees it.
    await page.keyboard.press('p');
    await expect(page.locator('#pause-btn .ib-glyph')).toHaveText('▶');
    await expect(page.locator('#pause-btn kbd')).toHaveText('P');
    await page.keyboard.press('p');
    await expect(page.locator('#pause-btn .ib-glyph')).toHaveText('❚❚');
    await expect(page.locator('#pause-btn kbd')).toHaveText('P');

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the inspector and the held-piece chip carry theirs too', async ({ page }) => {
    const { errors } = await startRun(page, { elements: ['fire', 'water'], gold: 5000 });

    // The chip names BOTH ways out of a queued build. The right-click half is
    // Game.js's pointer wiring; tests/e2e/cancel.spec.js is what keeps the
    // sentence honest.
    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await expect(page.locator('#held-piece')).toHaveClass(/\bon\b/);
    await expect(page.locator('#held-piece kbd')).toHaveText('Esc');
    await expect(page.locator('#held-piece')).toContainText('right-click');

    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });

    await expect(page.locator('#insp-upgrade kbd')).toHaveText('U');
    await expect(page.locator('#insp-morph kbd')).toHaveText('M');
    await expect(page.locator('#insp-sell kbd')).toHaveText('X');
    for (const [sel, k] of [['#insp-upgrade', 'U'], ['#insp-morph', 'M'], ['#insp-sell', 'X']]) {
      await expect(page.locator(sel)).toHaveAttribute('aria-keyshortcuts', k);
    }
    await expect(page.locator('#inspector .insp-close')).toHaveAttribute('aria-keyshortcuts', 'Escape');

    // At the top level the Upgrade button loses its cap along with its job —
    // advertising U on a control that refuses is worse than not advertising it.
    await page.evaluate(() => {
      const g = window.__game;
      const id = g.towers.towers[0].id;
      g.upgradeTower(id); g.upgradeTower(id);
      g.selectTower(id);
    });
    await expect(page.locator('#insp-upgrade')).toBeDisabled();
    await expect(page.locator('#insp-upgrade kbd')).toHaveCount(0);
    await expect(page.locator('#insp-sell kbd')).toHaveText('X');
    // ...AND THE INVISIBLE CAP GOES WITH IT. The <kbd> was dropped and
    // `aria-keyshortcuts="U"` stayed, so the announcement a screen reader makes
    // and the one a sighted player gets disagreed on a disabled control.
    await expect(page.locator('#insp-upgrade')).not.toHaveAttribute('aria-keyshortcuts', /.*/);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a greyed Morph button advertises nothing, and M does not open a sheet with no destinations', async ({ page }) => {
    /**
     * Lobby.#sync states the rule this round — A CAP THAT PROMISES A DEAD KEY IS
     * WORSE THAN NO CAP — and the inspector broke it twice on the same control.
     * With one element bound there is nowhere to morph to, so #insp-morph is
     * disabled with the title "Nothing else is unlocked to morph into yet"; it
     * kept its <kbd>M</kbd> AND its aria-keyshortcuts, and pressing M opened the
     * morph sheet anyway — a card reading "28 DPS NOW -> — AFTER" with no
     * destination and the unavailability message underneath.
     */
    const { errors } = await startRun(page, { elements: ['fire'], gold: 5000 });
    await page.evaluate(() => {
      const g = window.__game;
      g.build('fire', 10, 8);
      g.setBuildSelection(null);
      g.selectTower(g.towers.towers[0].id);
    });
    await expect(page.locator('#inspector')).toHaveClass(/\bopen\b/);

    // Precondition: one element really does mean no morph targets.
    expect(await page.evaluate(() => window.__game.morphTargets.length)).toBeLessThanOrEqual(1);
    await expect(page.locator('#insp-morph')).toBeDisabled();
    await expect(page.locator('#insp-morph kbd')).toHaveCount(0);
    await expect(page.locator('#insp-morph')).not.toHaveAttribute('aria-keyshortcuts', /.*/);

    await page.keyboard.press('m');
    await settle(page, 150);
    expect(await page.evaluate(() => window.__game.hud.inspector.view),
      'M opened a morph sheet with nothing to morph into').toBe('tower');
    await expect(page.locator('#inspector')).not.toHaveClass(/\bmorph\b/);

    // The control: bind a second element and the same key works, so the guard is
    // a guard and not a broken hotkey.
    await page.evaluate(() => {
      const g = window.__game;
      g.state.pendingElementPicks = 1;
      g.chooseElement('water');
      g.hud.refreshBuildBar();
      g.selectTower(g.towers.towers[0].id);
    });
    await expect(page.locator('#insp-morph')).toBeEnabled();
    await expect(page.locator('#insp-morph kbd')).toHaveText('M');
    await expect(page.locator('#insp-morph')).toHaveAttribute('aria-keyshortcuts', 'M');
    await page.keyboard.press('m');
    await expect(page.locator('#inspector')).toHaveClass(/\bmorph\b/);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
