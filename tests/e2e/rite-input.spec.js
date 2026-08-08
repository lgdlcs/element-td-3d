/**
 * RITE INPUT, IN A REAL BROWSER.
 *
 * Two facts about MinigameHost's pointer handling that no other environment can
 * establish, and that the unit suites therefore cannot own:
 *
 *  1. THE CLICK QUEUE. Two `pointerdown` events at two different points of the
 *     canvas, dispatched inside ONE animation frame, resolve as two distinct
 *     hits at two different world positions — even when the pointer has moved
 *     somewhere else entirely before the fixed step that consumes them. Before
 *     the queue the host kept a scalar click count plus one live pointer
 *     position, so a press at A followed by a move to B resolved at B: a hit
 *     credited to the wrong target. jsdom can dispatch those three events but
 *     cannot put them in a real frame with a real rAF-driven fixed step behind
 *     them, which is why this test lives here.
 *
 *  2. THE SECONDARY BUTTON. A real right click (Playwright's own mouse, not a
 *     synthesised event) arrives as a queue entry with `button: 2`, and the
 *     `contextmenu` it raises is prevented. Playwright cannot see the native
 *     menu, so the claim is asserted through a page-side listener installed
 *     before the click: the menu that never opens is the one whose event was
 *     `defaultPrevented`.
 *
 * TWO RULES THIS FILE OBEYS, BOTH LEARNED THE HARD WAY
 *
 * NO WALL CLOCK, ANYWHERE. Headless runs at roughly 4 fps here and the host
 * clamps a frame to `MINIGAMES.maxFrameDt`, so rite-time advances at about 40 %
 * of real time. Every wait below is a bounded rAF loop with a rite-state exit
 * condition; there is not a `performance.now()` or a `waitForTimeout` in the
 * file. tests/e2e/minigame.spec.js:81 names the same trap.
 *
 * NO SECOND LETTERBOX. World coordinates are converted to client pixels with
 * the host's own `painter.toClient` plus the canvas's `getBoundingClientRect`.
 * Re-deriving the transform in the spec would be a second implementation, free
 * to drift from the first and to agree with itself while both are wrong.
 *
 * WHY THE AIM IS EXACT AND NOT APPROXIMATE. `this.t` only ever advances inside
 * a fixed sub-step, and the queue is handed to the FIRST sub-step that runs
 * after it was filled. So a click queued while the instance reads `t` resolves
 * at exactly `t + MINIGAMES.dt`, whether the host's frame callback runs before
 * or after ours and however many sub-steps that frame ends up taking.
 * `LuckyShotRite.xAt(i, t)` is a pure function of `t`, so the spec can aim at
 * where a target WILL be rather than at where it was, and a slow machine moves
 * the wall clock without moving the target.
 */

import { test, expect } from '@playwright/test';
// `startRun` boots through `bootGame` (docs/TESTING.md, the HMR trap) and then
// does the one thing a rite needs on top of a bare boot: it answers the element
// picker. `Game.startMinigame` refuses while `pendingElementPicks > 0` — two
// stacked full-bleed dialogs is the shape the feature must not have — so a page
// that only called `bootGame` never opens a rite at all.
import { startRun } from './helpers.js';

/** Open the rite through the public entry point, exactly as the dev panel does. */
async function openLuckyShot(page, wave = 20, occurrence = 0) {
  await page.evaluate(
    ([w, o]) => window.__game.startMinigame('luckyshot', w, o),
    [wave, occurrence],
  );
  await page.waitForSelector('#rite.open', { timeout: 10000 });
  // Past the pre-roll (MinigameHost COUNTDOWN) before a single click is
  // recorded. A press during the announcement STARTS the rite and is
  // deliberately not delivered as a click — which is exactly the property this
  // file would otherwise trip over, since its whole subject is which presses
  // reach the rite and where.
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game.minigames.mode === 'play', null, { timeout: 10000 });
  await page.waitForFunction(() => window.__game.minigames.instance?.targets?.length > 0,
    null, { timeout: 10000 });
}

/**
 * Record every click record the rite is actually handed, from inside the page.
 *
 * The records are POOLED (contract.js NEUTRAL_INPUT): the host refills them on
 * the next step, so a spec that kept the references would read later clicks.
 * The fields are copied out here, one object per press, at the moment the rite
 * sees them.
 */
async function recordClicks(page) {
  await page.evaluate(() => {
    const inst = window.__game.minigames.instance;
    window.__clicks = [];
    const inner = inst.update.bind(inst);
    inst.update = (dt, input) => {
      for (const c of input.clicks) {
        window.__clicks.push({ x: c.x, y: c.y, button: c.button, source: c.source });
      }
      // The rite's own view of where the pointer is at the end of the step. Kept
      // so the spec can show it is NOT what the shots resolved against.
      window.__lastPointer = { x: input.x, y: input.y };
      return inner(dt, input);
    };
  });
}

/**
 * Spin frames until the rite has been handed `n` clicks, or give up.
 *
 * BOUNDED IN FRAMES, NEVER IN SECONDS. 600 frames is two and a half minutes of
 * headless wall clock and a handful of frames of what this actually needs.
 */
async function waitForClicks(page, n) {
  return page.evaluate(async (want) => {
    const h = window.__game.minigames;
    for (let i = 0; i < 600 && h.isOpen && window.__clicks.length < want; i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    return window.__clicks.length;
  }, n);
}

test.describe('rite input', () => {
  test('two presses in one frame are two hits, at the two places they were pressed', async ({ page }) => {
    const { errors } = await startRun(page, { freeze: false });
    await openLuckyShot(page);
    await recordClicks(page);

    /**
     * One evaluate, on purpose: read the world, convert, and dispatch — all
     * synchronously after a single rAF boundary, so both presses and the move
     * that follows them land inside ONE animation frame. Splitting this across
     * two `page.evaluate` calls would put a round trip (and therefore frames,
     * and therefore fixed steps) between the aim and the shot.
     */
    const plan = await page.evaluate(async () => {
      const { MINIGAMES } = await import('/src/core/Config.js');
      const h = window.__game.minigames;
      const inst = h.instance;

      await new Promise((r) => requestAnimationFrame(r));

      // Where the queued clicks will resolve. `t` advances only inside a fixed
      // sub-step and the queue goes to the first one that runs, so this is the
      // exact world time, not an estimate.
      const t = inst.t + MINIGAMES.dt;

      /**
       * FRONT ROW ONLY, AND THAT IS NOT LAZINESS. `hitIndex` walks the targets
       * front-to-back and returns the first containment, and the front row is
       * built first — so the centre of a front-row target resolves to that
       * target and to nothing else, whatever the rank behind it is doing. The
       * bystander is skipped because it scores as a hit on nothing.
       */
      const candidates = [];
      for (let i = 0; i < inst.targets.length; i++) {
        const tg = inst.targets[i];
        if (tg.row !== 0 || tg.kind === 'bystander') continue;
        if (!inst.aliveAt(i, t)) continue;
        const x = inst.xAt(i, t);
        if (Math.abs(x) > 6.5) continue;         // comfortably inside the field
        candidates.push({ i, x, y: inst.yAt(i) });
      }
      candidates.sort((p, q) => p.x - q.x);
      const a = candidates[0];
      const b = candidates[candidates.length - 1];
      if (!a || !b || a.i === b.i || b.x - a.x < 2) {
        return { ok: false, candidates };
      }

      // THE HOST'S OWN TRANSFORM. Never a second copy of the letterbox maths.
      const rect = h.$canvas.getBoundingClientRect();
      const toClient = (p) => {
        const c = h.painter.toClient(p.x, p.y);
        return { x: rect.left + c.x, y: rect.top + c.y };
      };

      /**
       * Empty air, above every rank: the back row tops out at 0.95 + 0.48.
       * This is where the pointer ENDS UP, and under the bug it is where both
       * shots would be credited — so it must be a place that cannot be hit.
       */
      const away = { x: 0, y: 3.4 };

      const pa = toClient(a);
      const pb = toClient(b);
      const pAway = toClient(away);

      const press = (p) => h.$canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, clientX: p.x, clientY: p.y,
        button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));

      press(pa);
      press(pb);
      // ...and the hand keeps moving before the step that resolves them. This
      // single line is what separates a queue from a live pointer read.
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: pAway.x, clientY: pAway.y,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));

      return { ok: true, a, b, away, pa, pb, pAway, t };
    });

    expect(plan.ok, `no two separated front-row targets on screen: ${JSON.stringify(plan.candidates)}`)
      .toBe(true);
    // Two DIFFERENT points on the canvas, which is half of what is being claimed.
    expect(Math.abs(plan.pa.x - plan.pb.x)).toBeGreaterThan(20);

    expect(await waitForClicks(page, 2)).toBe(2);

    const got = await page.evaluate(() => {
      const inst = window.__game.minigames.instance;
      return {
        clicks: window.__clicks,
        pointer: window.__lastPointer,
        shots: inst.shots,
        hits: inst.hits,
        down: inst.targets
          .map((tg, i) => (tg.downUntil > 0 ? i : -1))
          .filter((i) => i >= 0),
      };
    });

    // Both presses arrived, in the order they were made, at the positions they
    // were made — not at the position the pointer had moved on to.
    expect(got.clicks).toHaveLength(2);
    expect(got.clicks[0].x).toBeCloseTo(plan.a.x, 1);
    expect(got.clicks[0].y).toBeCloseTo(plan.a.y, 1);
    expect(got.clicks[1].x).toBeCloseTo(plan.b.x, 1);
    expect(got.clicks[1].y).toBeCloseTo(plan.b.y, 1);
    expect(got.clicks.every((c) => c.button === 0 && c.source === 'pointer')).toBe(true);
    // TWO DIFFERENT WORLD POSITIONS, stated as its own assertion rather than
    // left to be inferred from the two above.
    expect(Math.abs(got.clicks[0].x - got.clicks[1].x)).toBeGreaterThan(2);

    // The live pointer really did move away first, so the two positions above
    // could not have come from it.
    expect(got.pointer.y).toBeCloseTo(plan.away.y, 1);
    expect(Math.abs(got.pointer.y - plan.a.y)).toBeGreaterThan(2);

    // TWO DISTINCT HITS, on the two targets that were aimed at and no others.
    expect(got.shots).toBe(2);
    expect(got.hits).toBe(2);
    expect(got.down).toEqual([plan.a.i, plan.b.i].sort((p, q) => p - q));

    expect(errors).toEqual([]);
  });

  test('a real right click is a click with button 2, and no context menu opens', async ({ page }) => {
    const { errors } = await startRun(page, { freeze: false });
    await openLuckyShot(page);
    await recordClicks(page);

    // INSTALLED BEFORE THE CLICK, on window at the end of the bubble path: the
    // host prevents the menu on #rite, so by the time the event gets here the
    // verdict is already in. Playwright cannot see the OS menu; this is the
    // only observable that says it will not open.
    await page.evaluate(() => {
      window.__ctx = [];
      window.addEventListener('contextmenu', (e) => {
        window.__ctx.push({ prevented: e.defaultPrevented, target: e.target?.id ?? null });
      });
    });

    const at = await page.evaluate(() => {
      const r = window.__game.minigames.$canvas.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.click(at.x, at.y, { button: 'right' });

    expect(await waitForClicks(page, 1)).toBe(1);

    const got = await page.evaluate(() => ({
      clicks: window.__clicks,
      ctx: window.__ctx,
      shots: window.__game.minigames.instance.shots,
    }));

    expect(got.clicks).toHaveLength(1);
    expect(got.clicks[0].button).toBe(2);
    expect(got.clicks[0].source).toBe('pointer');
    // The secondary button is a real trigger here, not just a queue entry.
    expect(got.shots).toBe(1);

    expect(got.ctx).toHaveLength(1);
    expect(got.ctx[0].prevented).toBe(true);

    expect(errors).toEqual([]);
  });
});
