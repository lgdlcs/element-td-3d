/**
 * THE RITE HOST, IN A REAL BROWSER.
 *
 * Every claim in this file is about `MinigameHost` and none of it is about any
 * particular minigame. `luckyshot` is the vehicle — it is the reference rite
 * (see its docblock), it is the one whose state a spec can drive exactly, and it
 * would be replaced here without a single assertion changing meaning. What each
 * of the six rites does with its twenty seconds is tests/e2e/rites.spec.js's
 * subject; that a rite gets twenty undisturbed seconds, over a live 3D board,
 * with one payout at the end and nothing left behind, is this file's.
 *
 * WHAT ONLY A BROWSER CAN ANSWER. The host has two unit suites already
 * (tests/unit/minigames.test.js in node, tests/unit/minigame-host.test.js in
 * jsdom) and they are cheaper and stricter about the maths. They cannot see:
 *
 *   - the overlay standing over the real WebGL viewport, eating a click that a
 *     moment earlier would have built a tower;
 *   - the keyboard shield — `document`, CAPTURE phase — beating the window-level
 *     listeners `Game.js` and `BuildBar` registered long before it. Space is
 *     this rite's primary verb AND the game's "send the next wave", so this is
 *     load-bearing rather than hygiene: without the shield the first thing a
 *     player does inside a minigame is start a wave they cannot see;
 *   - a rite whose draw() throws taking the rAF loop down with it, which is what
 *     `#guard` exists to prevent and what killed a real build once;
 *   - twenty seconds of running rite putting nothing on the console.
 *
 * THE `expect(errors).toEqual([])` AT THE END OF EACH TEST IS DOING WORK. A
 * throwing rite is caught by `#guard` and re-reported through console.error, so
 * a rite that breaks still fails the build rather than silently paying nothing.
 * The one test that expects an error asserts its exact shape instead.
 *
 * ── TWO RULES THIS FILE OBEYS ──────────────────────────────────────────────
 *
 * NO WALL CLOCK, ANYWHERE. Measured on this machine, headless runs the rite loop
 * at roughly 9.6 fps and the host clamps a frame to `MINIGAMES.maxFrameDt`, so
 * rite-time advances at about 0.73x real time — and that ratio is a property of
 * the machine, not of the game. Every wait below is a bounded rAF loop with a
 * rite-state exit condition (`spinUntil`) or a bounded run of frames asserting
 * that nothing moved (`spinFrames`). There is no `performance.now()` and no
 * `waitForTimeout` in this file. `RESUME_GRACE` is 1.2 s of RITE time, which is
 * where the previous version of this spec was flaky.
 *
 * NO SECOND LETTERBOX. World coordinates become client pixels through the host's
 * own `painter.toClient` plus the canvas's `getBoundingClientRect`, never through
 * a copy of the transform written here — a copy is free to drift from the
 * original and to agree with itself while both are wrong.
 *
 * WHY THE AIM IS EXACT AND NOT APPROXIMATE. `LuckyShotRite.t` only ever advances
 * inside a fixed sub-step, and a queued click is handed to the FIRST sub-step
 * that runs after it was queued. So a click dispatched while the instance reads
 * `t` resolves at exactly `t + MINIGAMES.dt`, whether the host's frame callback
 * runs before or after ours and however many sub-steps that frame takes.
 * `xAt(i, t)`, `aliveAt(i, t)` and `hitIndex(x, y, t)` are pure functions of `t`,
 * so the spec aims at where a target WILL be, and a slow machine moves the wall
 * clock without moving the target. Same reasoning, same three helpers, as
 * tests/e2e/rite-input.spec.js.
 */

import { test, expect } from '@playwright/test';
import { startRun, cellToScreen, clickCell, readState, FIRE_COST } from './helpers.js';

/** Open a rite the way the dev panel does, through the public entry point. */
async function openRite(page, wave = 20) {
  await page.evaluate((w) => window.__game.startMinigame('luckyshot', w, 0), wave);
  await page.waitForSelector('#rite.open', { timeout: 10000 });
  await page.waitForFunction(
    () => window.__game.minigames.instance?.targets?.length > 0,
    null, { timeout: 10000 });
}

const host = (page, fn) => page.evaluate(fn);

/**
 * Spin animation frames until `expr` holds, and fail loudly if it never does.
 *
 * BOUNDED IN FRAMES, NEVER IN SECONDS — the trap this whole file is written
 * around. `expr` is a JavaScript expression evaluated in the page with `h` (the
 * host) and `g` (the game) in scope; 900 frames is a minute and a half of
 * headless wall clock and a handful of frames of what anything here needs.
 *
 * @returns {Promise<number>} frames actually spun, for a spec that wants to say
 *   "and it took more than none".
 */
async function spinUntil(page, expr, maxFrames = 900) {
  const r = await page.evaluate(async ([src, max]) => {
    const pred = new Function('h', 'g', `return (${src});`);
    const g = window.__game;
    for (let i = 0; i < max; i++) {
      if (pred(g.minigames, g)) return { ok: true, frames: i };
      await new Promise((res) => requestAnimationFrame(res));
    }
    return { ok: false, frames: max };
  }, [expr, maxFrames]);
  expect(r.ok, `spun ${r.frames} frames and \`${expr}\` never became true`).toBe(true);
  return r.frames;
}

/**
 * Let `n` frames happen and nothing else.
 *
 * The counterpart to spinUntil, for the assertions of the form "and then this
 * did NOT move": there is no state to wait for, so the wait is a count of frames
 * rather than a stretch of time. 60 frames is six seconds of headless wall clock
 * and four-odd seconds of rite time — far more than any of the things asserted
 * still would need to change if they were going to.
 */
async function spinFrames(page, n = 60) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((r) => requestAnimationFrame(r));
  }, n);
}

/**
 * PLAY THE RITE, FOR REAL, UP TO `maxShots` ROUNDS.
 *
 * This is the difference between proving the payout PATH and proving that a
 * PLAYED rite pays. The previous version of this file overwrote
 * `instance.score` to force a ratio of 1 — correct at the time, because the six
 * rites were stubs and there was nothing to play — and what it demonstrated was
 * that `#settle` credits whatever `score()` returns. It could not have caught a
 * rite whose real score never reaches the host.
 *
 * Each round: wait a frame, ask the instance where a target WILL be at the exact
 * time the click will resolve, verify with `hitIndex` that the shot resolves
 * against THAT target and not against a nearer rank overlapping it, convert
 * through the host's own painter, and dispatch a real `pointerdown` on the
 * canvas. Then wait — in frames — for `shots` to tick, so the next aim is
 * computed with the previous hit already registered and two rounds can never
 * pile into one sub-step and fight over the same target.
 *
 * The bystander is skipped: it is worth -1 and the point here is a positive
 * score, not a demonstration that the rite can be played badly.
 *
 * @returns {Promise<Array<{i:number, value:number, shots:number, hits:number, points:number}>>}
 */
async function playRite(page, maxShots) {
  return page.evaluate(async (want) => {
    const { MINIGAMES } = await import('/src/core/Config.js');
    const h = window.__game.minigames;
    const out = [];

    for (let frame = 0; frame < 900 && out.length < want; frame++) {
      await new Promise((r) => requestAnimationFrame(r));
      const inst = h.instance;
      if (!h.isOpen || h.mode !== 'play' || !inst) break;
      if (inst.ammo <= 0) break;

      // Where the click WILL resolve. `t` advances only inside a fixed sub-step
      // and the queue goes to the first one that runs, so this is the exact
      // world time and not an estimate.
      const t = inst.t + MINIGAMES.dt;
      const shots0 = inst.shots;

      // `targets` is built front-row-first, so the first index that survives
      // the `hitIndex` check is the nearest one — the same front-to-back walk
      // the hit test itself does.
      let pick = -1;
      for (let i = 0; i < inst.targets.length; i++) {
        if (inst.targets[i].kind === 'bystander') continue;
        if (!inst.aliveAt(i, t)) continue;
        const x = inst.xAt(i, t);
        if (Math.abs(x) > 6.5) continue;              // comfortably inside the field
        if (inst.hitIndex(x, inst.yAt(i), t) !== i) continue;   // occluded by a nearer rank
        pick = i;
        break;
      }
      if (pick < 0) continue;                          // nothing clean on screen this frame

      const x = inst.xAt(pick, t);
      const y = inst.yAt(pick);
      // THE HOST'S OWN TRANSFORM. Never a second copy of the letterbox maths.
      const rect = h.$canvas.getBoundingClientRect();
      const c = h.painter.toClient(x, y);
      h.$canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: rect.left + c.x,
        clientY: rect.top + c.y,
        button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));

      // Resolve before aiming again, so the next shot cannot be aimed at a
      // target this one is about to knock down.
      for (let k = 0; k < 600 && inst.shots === shots0 && h.isOpen; k++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      out.push({
        i: pick,
        value: inst.targets[pick].value,
        shots: inst.shots,
        hits: inst.hits,
        points: inst.points,
      });
    }
    return out;
  }, maxShots);
}

test.describe('the rite host', () => {
  test('mounts over the live board, and the veil eats a click that would have built', async ({ page }) => {
    // Paused, so the purse is an exact number rather than a race with interest.
    const { errors } = await startRun(page, { elements: ['fire'] });

    // Arm a build BEFORE the overlay exists, so the click below is genuinely a
    // click that would otherwise have queued a tower.
    await page.click('#dock-pure .tcard[data-tower="fire"]');
    const before = await readState(page);
    expect(before.selectedBuild).toBe('fire');
    expect(before.towers).toBe(0);

    await openRite(page);
    expect(await host(page, () => window.__game.state.phase)).toBe('minigame');

    // The 3D board is still being rendered behind the veil — the overlay is a
    // surface over a live scene, not a replacement for it. `Game.elapsed` is
    // advanced by `frame()` above every phase check, so it moves iff the loop
    // that draws the board is running.
    const elapsed0 = await host(page, () => window.__game.elapsed);
    await spinFrames(page, 20);
    expect(await host(page, () => window.__game.elapsed)).toBeGreaterThan(elapsed0);

    // A cell that is free, buildable, and — the point — underneath the overlay.
    const pt = await cellToScreen(page, 14, 8);
    const covered = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return {
        inRite: !!document.getElementById('rite')?.contains(el),
        id: el?.id || el?.className || el?.tagName || 'none',
      };
    }, pt);
    expect(covered.inRite, `(14,8) is under "${covered.id}", not under the rite`).toBe(true);

    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await page.mouse.up();
    await spinFrames(page, 20);

    const during = await readState(page);
    expect(during.towers).toBe(0);
    expect(during.gold).toBe(before.gold);
    expect(during.phase).toBe('minigame');
    // The build is still HELD, not cancelled: the click never reached the game.
    expect(during.selectedBuild).toBe('fire');

    // INSTRUMENT CONTROL (docs/PITFALLS.md §11). The same click, at the same
    // point, with the veil gone: if this did not build, the assertion above
    // would be proving nothing but a bad coordinate.
    await host(page, () => window.__game.minigames.close());
    await spinUntil(page, "g.state.phase === 'prep'");
    await page.evaluate(() => window.__game.setBuildSelection('fire'));
    await clickCell(page, 14, 8);
    await expect.poll(() => page.evaluate(() => window.__game.towers.towers.length)).toBe(1);
    expect((await readState(page)).gold).toBe(before.gold - FIRE_COST[0]);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the keyboard shield beats every listener the game already had', async ({ page }) => {
    const { errors } = await startRun(page, { freeze: false });

    /**
     * A WINDOW-LEVEL BUBBLE LISTENER, exactly where `Game.js` and `BuildBar`
     * bind theirs, and registered BEFORE the host binds anything — which is the
     * real registration order and the reason the shield is on `document` at
     * CAPTURE. Capture on document runs before any bubble listener on window
     * whatever the order, and `#onKeyDown` calls stopPropagation, so this
     * listener must never hear a key while a rite is open.
     */
    await page.evaluate(() => {
      window.__leaked = [];
      window.addEventListener('keydown', (e) => window.__leaked.push(e.code));
    });

    // Instrument control first: with no rite open the listener DOES hear keys.
    // K rather than Space, because the control must not also send a wave.
    await page.keyboard.press('k');
    expect(await host(page, () => window.__leaked)).toEqual(['KeyK']);
    await host(page, () => { window.__leaked.length = 0; });

    await openRite(page);
    const before = await host(page, () => ({ ...window.__game.state, elements: null, picks: null }));

    // Space is the rite's own verb AND the game's "send the next wave". P, the
    // digits, X and U all spend or change something on the board behind the veil.
    for (const k of ['Space', 'p', '3', 'x', 'u', 'm', 'f', 'h']) await page.keyboard.press(k);
    await spinFrames(page, 30);

    expect(await host(page, () => window.__leaked)).toEqual([]);

    const after = await host(page, () => ({ ...window.__game.state, elements: null, picks: null }));
    expect(after.phase).toBe('minigame');
    expect(after.wave).toBe(before.wave);
    expect(after.speed).toBe(before.speed);
    expect(after.paused).toBe(before.paused);
    // ...and none of those keys opened a panel behind the overlay.
    expect(await page.locator('#help.open').count()).toBe(0);

    // SWALLOWED FOR THE GAME, DELIVERED TO THE RITE. The shield is not a mute
    // button: Space is a commit, so it must arrive as exactly one round spent.
    // The digits are slot presses and the rest are nothing, so one is the whole
    // answer.
    expect(await host(page, () => window.__game.minigames.instance.shots)).toBe(1);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a rite that is played pays exactly once, and the run clock stays frozen while it is', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 1000, freeze: false });

    await openRite(page);
    // Read the purse AFTER the phase is frozen rather than before: 'minigame'
    // is in FROZEN_PHASES, so from here nothing but the rite can move gold.
    const before = await host(page, () => ({
      gold: window.__game.state.gold,
      interest: window.__game.state.interestTimer,
      ledger: window.__game.state.goldEarned.minigame ?? 0,
    }));
    expect(await host(page, () => window.__game.state.phase)).toBe('minigame');

    // FROZEN_PHASES contains 'minigame' precisely so this cannot move: interest
    // pays on a real-time clock and would otherwise reward staring at the card.
    await spinFrames(page, 60);
    expect(await host(page, () => window.__game.state.interestTimer)).toBe(before.interest);
    expect(await host(page, () => window.__game.state.gold)).toBe(before.gold);

    // ---- play it, with real clicks at real world positions ------------------
    const shots = await playRite(page, 30);
    expect(shots.length, 'the rite was never actually played').toBeGreaterThan(10);

    const played = await host(page, () => {
      const i = window.__game.minigames.instance;
      return { shots: i.shots, hits: i.hits, points: i.points, ammo: i.ammo, score: i.score() };
    });
    // EVERY ROUND WAS A HIT, because every round was aimed with the rite's own
    // hit test. A miss here is not bad luck, it is the aim being wrong.
    expect(played.shots).toBe(shots.length);
    expect(played.hits).toBe(shots.length);
    expect(played.points).toBe(shots.reduce((a, s) => a + s.value, 0));
    expect(played.score.ratio).toBeGreaterThan(0);
    // Out of rounds, not out of time: the rite ended on its own ammo rule with
    // seconds still on the host's clock.
    expect(played.ammo).toBe(0);
    expect(await host(page, () => window.__game.minigames._remaining)).toBeGreaterThan(0);

    await spinUntil(page, "h.mode === 'result'");

    const after = await host(page, () => ({
      mode: window.__game.minigames.mode,
      gold: window.__game.state.gold,
      ledger: window.__game.state.goldEarned.minigame ?? 0,
      reward: window.__game.minigames._reward,
      ratio: window.__game.minigames._ratio,
    }));
    expect(after.mode).toBe('result');
    expect(after.ratio).toBeCloseTo(played.score.ratio, 6);
    expect(after.reward).toBeGreaterThan(0);
    expect(after.ledger).toBe(before.ledger + after.reward);
    expect(after.gold).toBe(before.gold + after.reward);

    // Everything that could ask for a second payout, at once.
    for (let i = 0; i < 10; i++) await page.keyboard.press('Escape');
    await spinUntil(page, "g.state.phase === 'prep'");
    await spinFrames(page, 30);
    expect(await host(page, () => window.__game.state.goldEarned.minigame)).toBe(after.ledger);
    expect(await host(page, () => window.__game.state.gold)).toBe(after.gold);
    expect(await host(page, () => window.__game.minigames.isOpen)).toBe(false);
    // The phase the run was in is restored, and the wave it was about to prepare
    // is the one it prepares. Nothing leaks: every listener the host took is
    // handed back.
    expect(await host(page, () => window.__game.state.phase)).toBe('prep');
    expect(await host(page, () => window.__game.state.wave)).toBe(19);
    expect(await host(page, () => window.__game.minigames.listenerCount)).toBe(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('Escape asks twice; the Skip button does not; neither pays', async ({ page }) => {
    // Paused: nothing here needs the simulation running, and an exact purse must
    // not race the interest clock. The rite runs either way — `minigames.update`
    // sits OUTSIDE Game.frame's paused block, on purpose.
    const { errors } = await startRun(page, { gold: 500 });
    await openRite(page);

    await page.keyboard.press('Escape');
    expect(await host(page, () => window.__game.minigames.mode)).toBe('play');
    await expect(page.locator('#rite-skip')).toHaveClass(/armed/);
    await page.keyboard.press('Escape');
    expect(await host(page, () => window.__game.minigames.mode)).toBe('result');
    expect(await host(page, () => window.__game.state.goldEarned.minigame ?? 0)).toBe(0);
    await page.click('#rite-continue');
    await spinUntil(page, "g.state.phase === 'prep'");
    expect(await host(page, () => window.__game.minigames.listenerCount)).toBe(0);

    // The BUTTON is a deliberate act on a labelled control, so it commits on the
    // first click. That asymmetry is the whole reason Escape is allowed to be a
    // reflex — see MinigameHost's ESC_ARM docblock.
    await openRite(page);
    await page.click('#rite-skip');
    expect(await host(page, () => window.__game.minigames.mode)).toBe('result');
    expect(await host(page, () => window.__game.minigames._reward)).toBe(0);
    expect(await host(page, () => window.__game.state.gold)).toBe(500);
    expect(await host(page, () => window.__game.state.goldEarned.minigame ?? 0)).toBe(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('blur and a hidden tab stop the clock, and the key that wakes it is not a shot', async ({ page }) => {
    const { errors } = await startRun(page, { freeze: false });
    await openRite(page);

    // One real round first, so the counter this test is about is known to MOVE.
    // Without it, "shots did not change" is satisfied by a rite that can never
    // register a shot at all.
    const fired = await playRite(page, 1);
    expect(fired.length, 'could not take a single real shot').toBe(1);
    const shotsBefore = fired[0].shots;
    expect(shotsBefore).toBe(1);

    // ---- blur --------------------------------------------------------------
    await spinUntil(page, 'h._remaining < h.def.duration');
    const at = await host(page, () => window.__game.minigames._remaining);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await host(page, () => window.__game.minigames._suspended)).toBe(true);
    await expect(page.locator('#rite-suspend')).toBeVisible();

    // BOUNDED IN FRAMES. 60 frames is several seconds of rite time on any
    // machine; a clock that was still running would have moved by any of them.
    await spinFrames(page, 60);
    expect(await host(page, () => window.__game.minigames._remaining)).toBe(at);

    // ---- resume, and the grace that swallows the waking key ----------------
    // The keypress that wakes a rite up is the player finding their way back to
    // the window, not a commit. It must not be a round.
    //
    // DISPATCHED AND READ IN ONE EVALUATE, deliberately: the grace is 1.2 s of
    // rite time and a Playwright round trip is not free, so reading it in a
    // second call would be asserting on a value a few frames of decay old — the
    // shape of the flake this test used to have.
    const woke = await page.evaluate(() => {
      const h = window.__game.minigames;
      h.$shell.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'Space', key: ' ', bubbles: true, cancelable: true,
      }));
      return { suspended: h._suspended, grace: h._grace, remaining: h._remaining };
    });
    expect(woke.suspended).toBe(false);
    expect(woke.grace).toBeGreaterThan(0);
    // Still frozen DURING the grace: the countdown is visible and costs nothing.
    expect(woke.remaining).toBe(at);
    await expect(page.locator('#rite-suspend')).toBeVisible();

    // RESUME_GRACE is 1.2 s of RITE time, which is where this spec used to be
    // flaky: a wall-clock wait long enough on one machine is short on another,
    // and this one advances rite time at ~0.73x real. Wait for the state.
    await spinUntil(page, 'h._grace <= 0');
    await spinUntil(page, `h._remaining < ${at}`);
    await expect(page.locator('#rite-suspend')).toBeHidden();
    expect(await host(page, () => window.__game.minigames.instance.shots)).toBe(shotsBefore);

    // ---- a hidden tab, which need not fire blur at all ---------------------
    const at2 = await host(page, () => window.__game.minigames._remaining);
    await page.evaluate(() => {
      // `document.hidden` is a getter on Document.prototype; an own property
      // shadows it for exactly as long as this test needs and is deleted below.
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await host(page, () => window.__game.minigames._suspended)).toBe(true);
    await spinFrames(page, 60);
    expect(await host(page, () => window.__game.minigames._remaining)).toBe(at2);
    await page.evaluate(() => { delete document.hidden; });

    // The same waking rule for the pointer: the click that focuses the window is
    // not a strike either.
    const woke2 = await page.evaluate(() => {
      const h = window.__game.minigames;
      const r = h.$canvas.getBoundingClientRect();
      h.$canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
      return { suspended: h._suspended, grace: h._grace, pending: h._pendingClicks.length };
    });
    expect(woke2.suspended).toBe(false);
    expect(woke2.grace).toBeGreaterThan(0);
    // The waking press left nothing in the click queue to be spent later.
    expect(woke2.pending).toBe(0);
    await spinUntil(page, 'h._grace <= 0');
    await spinUntil(page, `h._remaining < ${at2}`);
    expect(await host(page, () => window.__game.minigames.instance.shots)).toBe(shotsBefore);

    await host(page, () => window.__game.minigames.close());
    expect(await host(page, () => window.__game.minigames.listenerCount)).toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('resizing moves the letterbox and nothing else', async ({ page }) => {
    const { errors } = await startRun(page, { freeze: false });
    await openRite(page);
    await spinUntil(page, 'h.painter.ppu > 0');

    const before = await host(page, () => {
      const p = window.__game.minigames.painter;
      const i = window.__game.minigames.instance;
      return { ppu: p.ppu, x: i.xAt(0, 5), y: i.yAt(0), hit: i.hitIndex(i.xAt(0, 5), i.yAt(0), 5) };
    });

    await page.setViewportSize({ width: 900, height: 1200 });
    await spinUntil(page, `h.painter.cssW === h.$canvas.clientWidth && h.painter.ppu !== ${before.ppu}`);

    const geom = await host(page, () => {
      const p = window.__game.minigames.painter;
      return {
        w: p.cssW, h: p.cssH, ppu: p.ppu,
        centre: p.toField(p.cssW / 2, p.cssH / 2),
        corner: p.toField(p.cssW, 0),
      };
    });
    // THE INVARIANT IS THE LETTERBOX, not which axis wins it — the stage has its
    // own aspect-ratio and max-height, so either can bind and the first version
    // of this assertion guessed wrong. What must hold on every viewport: a
    // UNIFORM scale (so circles stay circles and the pointer travels the same
    // distance per world unit on both axes), the origin at the centre, and the
    // whole 16x9 field inside the canvas.
    expect(geom.ppu).toBeCloseTo(Math.min(geom.w / 16, geom.h / 9), 6);
    expect(geom.centre.x).toBeCloseTo(0, 6);
    expect(geom.centre.y).toBeCloseTo(0, 6);
    expect(Math.abs(geom.corner.x)).toBeGreaterThanOrEqual(8 - 1e-6);
    expect(Math.abs(geom.corner.y)).toBeGreaterThanOrEqual(4.5 - 1e-6);

    // NO PIXEL GAMEPLAY (MinigameHost guarantee 3). The rite is handed field
    // coordinates and a fixed dt, so a target's world position at a given world
    // time is the same number on a phone-shaped window as on a wide one — even
    // though every pixel it is drawn at has moved.
    const after = await host(page, () => {
      const i = window.__game.minigames.instance;
      return { x: i.xAt(0, 5), y: i.yAt(0), hit: i.hitIndex(i.xAt(0, 5), i.yAt(0), 5) };
    });
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.hit).toBe(before.hit);

    await host(page, () => window.__game.minigames.close());
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('a rite that throws is abandoned, loudly, and the run keeps rendering', async ({ page }) => {
    // Paused, so "the run paid nothing" is an exact number rather than a race
    // with a wave's bounties.
    const { errors } = await startRun(page, { gold: 700 });
    await openRite(page);
    await spinUntil(page, 'h.instance.t > 0');

    /**
     * THE CONTAINMENT WALL. `MinigameHost.update` is called from `Game.frame`,
     * which is called from main.js's rAF loop — and that loop has no try/catch.
     * Without `#guard` an exception in a rite's draw() does not make the
     * minigame look wrong, it freezes the entire game on frame one with no way
     * out. That happened for real once; this is the test that keeps it from
     * happening twice.
     */
    await page.evaluate(() => {
      window.__game.minigames.instance.draw = () => { throw new Error('spec: draw exploded'); };
    });
    await spinUntil(page, '!h.isOpen');

    // The rite lost its rite, and said so — swallowing it would leave a broken
    // rite paying nothing in silence.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[rite] 'luckyshot' threw and was abandoned");
    expect(errors[0]).toContain('spec: draw exploded');

    // The run continues, in the phase it was in before, with nothing left behind
    // and nothing paid for a rite that never finished.
    await spinUntil(page, "g.state.phase === 'prep'");
    expect(await host(page, () => window.__game.minigames.listenerCount)).toBe(0);
    expect(await host(page, () => window.__game.state.gold)).toBe(700);
    expect(await host(page, () => window.__game.state.goldEarned.minigame ?? 0)).toBe(0);
    await expect(page.locator('#rite.open')).toHaveCount(0);

    // AND THE LOOP IS STILL TURNING. `Game.elapsed` only advances from inside
    // `frame()`, so it moves iff the rAF chain the exception travelled through
    // survived it.
    const elapsed0 = await host(page, () => window.__game.elapsed);
    await spinFrames(page, 20);
    expect(await host(page, () => window.__game.elapsed)).toBeGreaterThan(elapsed0);

    // The strongest form of the same claim: a second rite opens and runs.
    await openRite(page);
    await spinUntil(page, 'h.instance.t > 0.2');
    await host(page, () => window.__game.minigames.close());
    await spinUntil(page, "g.state.phase === 'prep'");

    // Still exactly one error: the second rite did not inherit the first's fate.
    expect(errors, errors.join('\n')).toHaveLength(1);
  });

  test('the real schedule fires it after wave 3 and hands the run back to prep', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 5000, freeze: false });
    await page.evaluate(() => {
      window.__game.state.wave = 2;
      window.__game.waves.wave = 2;
      window.__game.startWaveNow();
    });
    // killAll only clears what has spawned; the runner keeps sending the rest,
    // so this is a bounded number of sweeps rather than a stretch of clock.
    await page.evaluate(async () => {
      for (let i = 0; i < 300 && window.__game.state.phase === 'combat'; i++) {
        window.__dev
          ? window.__dev.killAll()
          : window.__game.creeps.alive.forEach((a, k) => a && window.__game.creeps.kill(k, true));
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await spinUntil(page, "g.state.phase === 'minigame'");

    await expect(page.locator('#rite.open')).toBeVisible();
    await expect(page.locator('#rite-eyebrow')).toContainText('before wave 4');

    await host(page, () => window.__game.minigames.close());
    await spinUntil(page, "g.state.phase === 'prep'");
    expect(await host(page, () => window.__game.state.wave)).toBe(3);
    expect(await host(page, () => window.__game.minigames.listenerCount)).toBe(0);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
