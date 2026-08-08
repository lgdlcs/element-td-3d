/**
 * EVERY RITE, THE SAME SIX QUESTIONS.
 *
 * This file is not a gameplay suite. `tests/unit/<id>-rite.test.js` already
 * holds each rite to `assertRiteContract` (determinism, rand budget, an idle run
 * that terminates, a pure `score()`), and it does it in node in milliseconds.
 * What node cannot do is put a rite inside the real host, on a real canvas, in a
 * real rAF loop, and watch the LIFECYCLE the host owns: open, run, score, pay,
 * close. Those five verbs live in MinigameHost and are the same five for every
 * rite, so this asks all six the identical set of questions.
 *
 * THE LIST IS DERIVED, NEVER TYPED. `MINIGAME_IDS` is imported from the registry
 * and looped over, so a seventh rite is covered the day it is appended and a
 * rite that is deleted stops being tested rather than failing loudly at a name.
 * A spec with six hardcoded strings in it would go on passing while the seventh
 * rite shipped untested, and a suite that silently stops covering something is
 * the exact failure this file exists to prevent.
 *
 * WHAT IS ASSERTED PER RITE
 *
 *  1. IT OPENS. `Game.startMinigame` returns true, `#rite` carries `.open`, the
 *     host reports `isOpen`, and the phase is 'minigame'.
 *  2. IT RUNS. `instance.t` — the rite's own clock, advanced only from inside its
 *     `update` — is strictly greater after a bounded run of frames than it was
 *     before, and `draw()` was reached (counted through a wrapper) without the
 *     host's `#guard` catching anything.
 *  3. IT SCORES. `score()` returns a `ratio` inside [0, 1] with a non-empty
 *     `headline`, the host settled on that same ratio, and both the headline and
 *     the detail line reached the result card.
 *  4. GOLD IS CREDITED EXACTLY ONCE. `state.goldEarned.minigame` is the ledger;
 *     the delta across one session equals `minigameReward(ratio, gross)` — the
 *     game's own formula, imported into the page rather than re-derived here —
 *     `Game.addGold` was reached once with reason 'minigame' (or not at all, for
 *     a rite that idles to a payout of 0), and neither a further ten frames of
 *     result-card time nor two `close()` calls can move any of it again.
 *  5. IT CLOSES CLEAN. `listenerCount` is 0, the instance is dropped, `.open` is
 *     off the overlay, and the phase is back to 'prep' on the wave the rite was
 *     standing in front of.
 *  6. THE CONSOLE STAYS EMPTY for the whole session — errors over the whole run,
 *     warnings measured as a delta from the moment the rite opened, so a warning
 *     that belongs to boot is attributed to boot and not to the rite.
 *
 * IDLE PLAY, ON PURPOSE. Nothing here presses a key. Several rites score ~0 when
 * nobody plays them and that is the correct outcome, which is why assertion 4
 * compares the ledger against the score's own payout rather than against a
 * number this file expects to be positive. Input is somebody else's subject:
 * tests/e2e/rite-input.spec.js.
 *
 * THE TWO RULES THIS FILE OBEYS
 *
 * NO WALL CLOCK. Headless here runs the rite loop at roughly 9.6 fps with
 * rite-time advancing at about 0.73x of real time (measured), and both numbers
 * move with the machine. Every wait below is a bounded rAF loop with a
 * rite-state exit condition; there is not a `performance.now()` or a
 * `waitForTimeout` in the file. docs/TESTING.md says the same under "Headless
 * wall-clock time is not the game's time".
 *
 * THE SESSION IS ENDED, NOT WAITED OUT. A rite runs for 20-26 seconds of RITE
 * time, which is minutes of headless wall clock and six of those in a `workers:
 * 1` suite. So the run is deliberately short and the clock is then set to expire
 * on the next fixed step — `_remaining`, the same field the host decrements —
 * which drives the REAL settle path (`#settle` -> `score()` -> `addGold`) rather
 * than simulating it. Skipping would have been shorter still and would have
 * tested nothing: a skipped rite never calls `score()` and never pays.
 */

import { test, expect } from '@playwright/test';
import { startRun } from './helpers.js';
// THE POINT OF THE FILE. Imported, not transcribed — see the docblock.
import { MINIGAME_IDS } from '../../src/minigames/registry.js';

/**
 * The wave the rite stands in front of. 20 rather than 3 so the reward formula
 * is on its proportional branch (`nextGross * perfectFrac`) instead of pinned to
 * `minPerfect`, which would make assertion 4 agree with itself for the wrong
 * reason on a rite that scored zero.
 */
const WAVE = 20;
const OCCURRENCE = 0;

/** Frames of rite time to let each rite actually play before the clock is cut. */
const RUN_SECONDS = 1.0;
/**
 * Hard ceilings, in FRAMES. At the measured ~9.6 fps, 300 frames is half a
 * minute of wall clock and roughly twenty times what the exit condition needs;
 * the bound exists so a rite that stops advancing fails as a failed condition
 * rather than as a test timeout with nothing to read.
 */
const MAX_RUN_FRAMES = 300;
const MAX_SETTLE_FRAMES = 120;

/** Open the rite through the public entry point, exactly as the schedule does. */
async function openRite(page, id) {
  const opened = await page.evaluate(
    ([i, w, o]) => window.__game.startMinigame(i, w, o),
    [id, WAVE, OCCURRENCE],
  );
  await page.waitForSelector('#rite.open', { timeout: 15000 });
  // The five-second pre-roll (MinigameHost COUNTDOWN) runs before the rite is
  // stepped at all, so everything below — draws, the rite's own clock, the
  // payout — is measured from the moment the field actually goes live. Skipped
  // rather than waited out: the host hands over on a commit, which is what a
  // player does, and it keeps the six-rite loop five seconds shorter each.
  await page.evaluate(() => {
    window.__game.minigames.$stage.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: 0, clientY: 0, button: 0, buttons: 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  });
  await page.waitForFunction(() => window.__game.minigames.mode === 'play', null, { timeout: 15000 });
  return opened;
}

/**
 * Count `draw` calls, count credits, and take the gold baseline.
 *
 * WHY `addGold` AND NOT `score`. The obvious instrument for "settled once" is a
 * counter on `score()`, and it is wrong: `score()` is documented PURE and rites
 * are free to call it themselves — FishingRite.#drawHud calls it on every frame
 * to draw the creel bar, and measured, that is 16 calls in a one-second session.
 * A counter there would be asserting a private drawing habit rather than the
 * host's lifecycle. `Game.addGold` is the other end of the same claim and is
 * unambiguous: `#settle` is the only caller with reason 'minigame', and it is
 * guarded by `_credited`.
 *
 * The reason is recorded with each call, so a credit that arrives from anywhere
 * else in the game (interest, a leak refund) is visible instead of being
 * silently folded into the count.
 */
async function instrument(page) {
  await page.evaluate(() => {
    const g = window.__game;
    const inst = g.minigames.instance;
    window.__rite = {
      draws: 0,
      credits: [],
      t0: inst.t,
      ledger0: g.state.goldEarned.minigame ?? 0,
      purse0: g.state.gold,
    };
    const draw = inst.draw.bind(inst);
    inst.draw = (painter, alpha) => { window.__rite.draws++; return draw(painter, alpha); };
    const addGold = g.addGold.bind(g);
    g.addGold = (amount, reason) => {
      window.__rite.credits.push({ amount, reason });
      return addGold(amount, reason);
    };
  });
}

/** Spin frames until the rite's own clock has advanced `secs`, or give up. */
async function runFrames(page, secs, maxFrames) {
  return page.evaluate(async ([want, cap]) => {
    const h = window.__game.minigames;
    let frames = 0;
    while (frames < cap && h.isOpen && h.mode === 'play'
      && (h.instance?.t ?? Infinity) - window.__rite.t0 < want) {
      await new Promise((r) => requestAnimationFrame(r));
      frames++;
    }
    return { frames, t: h.instance?.t ?? null, mode: h.mode, isOpen: h.isOpen };
  }, [secs, maxFrames]);
}

/**
 * Cut the clock and spin until the host has settled.
 *
 * `_remaining` is set below the fixed step rather than to 0 so the host reaches
 * `this._remaining <= 0` through its own decrement inside `update` — the same
 * line a rite that ran its full 26 seconds arrives on.
 */
async function settleRite(page, maxFrames) {
  return page.evaluate(async (cap) => {
    const h = window.__game.minigames;
    h._remaining = 0.0001;
    let frames = 0;
    while (frames < cap && h.isOpen && h.mode !== 'result') {
      await new Promise((r) => requestAnimationFrame(r));
      frames++;
    }
    return { frames, mode: h.mode, isOpen: h.isOpen };
  }, maxFrames);
}

/** Everything the assertions need, read in one round trip while still open. */
async function readSettled(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const h = g.minigames;
    // ASKED AGAIN, DELIBERATELY. The host consumed `score()` inside `#settle`,
    // and by the time the assertions run the instance would be gone — but the
    // rite contract requires `score()` to be PURE and the instance has not been
    // stepped since (mode is 'result', so `update` no longer reaches it). So the
    // answer here is the answer the host was given, and `_ratio` below is the
    // cross-check that says so rather than a claim taken on trust.
    const s = h.instance?.score?.() ?? null;
    return {
      score: s && {
        ratio: s.ratio, headline: s.headline, detail: s.detail, type: typeof s.ratio,
      },
      mode: h.mode,
      isOpen: h.isOpen,
      credited: h._credited,
      reward: h._reward,
      hostRatio: h._ratio,
      skipped: h._skipped,
      ledger: g.state.goldEarned.minigame ?? 0,
      purse: g.state.gold,
      phase: g.state.phase,
      listeners: h.listenerCount,
      cardShown: !h.$result.hidden,
      cardHeadline: h.$resHeadline.textContent,
      cardDetail: h.$resDetail.textContent,
      rite: window.__rite,
    };
  });
}

test.describe('rites — every minigame opens, runs, scores, pays once and closes', () => {
  for (const id of MINIGAME_IDS) {
    test(`${id}: full session lifecycle`, async ({ page }) => {
      // freeze: true — the board's own clock (prep countdown, interest) has
      // nothing to do with this and would only add wave sends to the log. The
      // rite runs anyway: MinigameHost.update sits BELOW the fixed-step block in
      // Game.frame, outside the `state.paused` guard (Game.js:1492).
      const { errors, warnings } = await startRun(page, { freeze: true });
      // Boot noise, if any, belongs to boot. Everything after this index is the
      // rite's.
      const warnBefore = warnings.length;
      expect(errors, `${id}: console was already dirty before the rite opened`)
        .toEqual([]);

      // ---- 1. it opens ---------------------------------------------------
      expect(await openRite(page, id), `${id}: startMinigame refused`).toBe(true);
      const opened = await page.evaluate(() => {
        const h = window.__game.minigames;
        return {
          isOpen: h.isOpen,
          defId: h.def?.id ?? null,
          hasInstance: !!h.instance,
          mode: h.mode,
          phase: window.__game.state.phase,
          listeners: h.listenerCount,
          duration: h.def?.duration ?? 0,
          remaining: h._remaining,
        };
      });
      expect(opened.isOpen, `${id}: host does not report open`).toBe(true);
      // The host opened THIS rite, not whichever one the registry happened to
      // hand back — a lookup that fell through would still set isOpen.
      expect(opened.defId).toBe(id);
      expect(opened.hasInstance).toBe(true);
      expect(opened.mode).toBe('play');
      expect(opened.phase).toBe('minigame');
      expect(opened.listeners, `${id}: nothing bound on open`).toBeGreaterThan(0);
      // NOT `toBeCloseTo(duration)`: a frame can (and measurably does) land
      // between `startMinigame` returning and this read, and the host decrements
      // `_remaining` by a fixed step on every one of them. Asserting the clock
      // was ARMED — full at most, not yet expired — is the claim that does not
      // depend on how many frames the machine got through in the meantime.
      expect(opened.duration, `${id}: rite has no duration`).toBeGreaterThan(0);
      expect(opened.remaining).toBeGreaterThan(0);
      expect(opened.remaining).toBeLessThanOrEqual(opened.duration);

      await instrument(page);

      // ---- 2. it runs ----------------------------------------------------
      const ran = await runFrames(page, RUN_SECONDS, MAX_RUN_FRAMES);
      expect(ran.frames, `${id}: rite clock never reached ${RUN_SECONDS}s in ${MAX_RUN_FRAMES} frames (t=${ran.t})`)
        .toBeLessThan(MAX_RUN_FRAMES);
      const midway = await page.evaluate(() => ({
        t: window.__game.minigames.instance?.t ?? null,
        draws: window.__rite.draws,
        remaining: window.__game.minigames._remaining,
        t0: window.__rite.t0,
      }));
      expect(midway.t, `${id}: instance.t did not advance`)
        .toBeGreaterThan(midway.t0);
      // draw() runs inside #guard, so a throw would be swallowed into
      // console.error and the counter would stop climbing. Both halves are
      // asserted: it was reached, and (below) nothing was logged.
      expect(midway.draws, `${id}: draw() was never reached`).toBeGreaterThan(0);
      // The host's clock moved too, which is what makes the cut below a cut
      // rather than the only thing that ever touched _remaining.
      expect(midway.remaining).toBeLessThan(opened.remaining);

      // ---- 3. it scores --------------------------------------------------
      const settled = await settleRite(page, MAX_SETTLE_FRAMES);
      expect(settled.mode, `${id}: never settled within ${MAX_SETTLE_FRAMES} frames`)
        .toBe('result');

      const now = await readSettled(page);
      expect(now.score, `${id}: score() returned nothing`).not.toBeNull();
      expect(now.score.type, `${id}: ratio is not a number`).toBe('number');
      expect(Number.isFinite(now.score.ratio)).toBe(true);
      expect(now.score.ratio).toBeGreaterThanOrEqual(0);
      expect(now.score.ratio).toBeLessThanOrEqual(1);
      expect(String(now.score.headline ?? '').trim(),
        `${id}: empty headline`).not.toBe('');
      // The card the player reads carries that headline, so the score reached
      // the screen rather than only the field it was stored in — and it is also
      // what proves the re-read above returned what the host actually settled on.
      expect(now.cardShown).toBe(true);
      expect(now.cardHeadline).toBe(now.score.headline);
      expect(now.cardDetail).toBe(now.score.detail ?? '');
      // Not a skip: the whole point of cutting the clock rather than pressing
      // Escape is that this path scores and pays.
      expect(now.skipped, `${id}: settled through the skip path`).toBeFalsy();
      expect(now.hostRatio, `${id}: the host settled on a different ratio`)
        .toBeCloseTo(now.score.ratio, 6);

      // ---- 4. gold, exactly once -----------------------------------------
      // The game's OWN formula, imported into the page. Re-deriving it here
      // would be a second implementation free to agree with itself while both
      // were wrong — and it is what makes this assertion work for a rite that
      // idles to 0 and for one that idles to 0.4 without either being special
      // cased.
      const expected = await page.evaluate(async ([ratio, wave]) => {
        const { minigameReward } = await import('/src/minigames/contract.js');
        const { waveDef } = await import('/src/game/Waves.js');
        const d = waveDef(wave);
        return minigameReward(ratio, d.count * d.bounty);
      }, [now.score.ratio, WAVE]);

      expect(now.credited, `${id}: settle ran without arming the credit guard`).toBe(true);
      expect(now.reward, `${id}: reward is not the formula applied to the score`)
        .toBe(expected);
      expect(now.ledger - now.rite.ledger0,
        `${id}: goldEarned.minigame delta != reward`).toBe(expected);
      expect(now.purse - now.rite.purse0,
        `${id}: purse delta != reward`).toBe(expected);
      // ONE CALL, OR NONE. The host only calls `addGold` when the reward is
      // positive, and an idle run of several of these rites correctly scores 0 —
      // so the expected number of credits is a function of the payout rather
      // than a constant, and asserting `1` here would be asserting that idle play
      // pays, which it must not.
      expect(now.rite.credits, `${id}: unexpected gold credits`)
        .toEqual(expected > 0 ? [{ amount: expected, reason: 'minigame' }] : []);

      // Ten more frames of result-card time. The card is live — it tweens the
      // gold count-up on every one of them — and none of that may reach the
      // ledger a second time. Well under RESULT_HOLD, so the card cannot
      // auto-advance underneath the read.
      const held = await page.evaluate(async () => {
        const g = window.__game;
        for (let i = 0; i < 10 && g.minigames.isOpen; i++) {
          await new Promise((r) => requestAnimationFrame(r));
        }
        return {
          ledger: g.state.goldEarned.minigame ?? 0,
          purse: g.state.gold,
          isOpen: g.minigames.isOpen,
          mode: g.minigames.mode,
          credits: window.__rite.credits.length,
        };
      });
      expect(held.isOpen, `${id}: result card closed itself mid-assertion`).toBe(true);
      expect(held.ledger, `${id}: ledger moved during the result card`).toBe(now.ledger);
      expect(held.purse).toBe(now.purse);
      expect(held.credits, `${id}: a second credit during the result card`)
        .toBe(now.rite.credits.length);

      // ---- 5. it closes clean --------------------------------------------
      const closed = await page.evaluate(() => {
        const g = window.__game;
        const h = g.minigames;
        h.close();
        const first = {
          ledger: g.state.goldEarned.minigame ?? 0,
          purse: g.state.gold,
          listeners: h.listenerCount,
          isOpen: h.isOpen,
          instanceDropped: h.instance === null,
          defDropped: h.def === null,
          openClass: h.$el.classList.contains('open'),
          ariaHidden: h.$el.getAttribute('aria-hidden'),
          hasTheme: 'rite' in h.$el.dataset,
          phase: g.state.phase,
          wave: g.state.wave,
          credits: window.__rite.credits.length,
        };
        // THE SECOND CLOSE. Escape, the Continue button and the auto-advance
        // timer all race for this in a real session; the `isOpen` guard is what
        // makes the loser a no-op instead of a second payout.
        h.close();
        return {
          ...first,
          ledger2: g.state.goldEarned.minigame ?? 0,
          purse2: g.state.gold,
          listeners2: h.listenerCount,
          phase2: g.state.phase,
          credits2: window.__rite.credits.length,
        };
      });
      expect(closed.isOpen).toBe(false);
      expect(closed.listeners, `${id}: ${closed.listeners} listener(s) left behind`).toBe(0);
      expect(closed.listeners2).toBe(0);
      expect(closed.instanceDropped).toBe(true);
      expect(closed.defDropped).toBe(true);
      expect(closed.openClass).toBe(false);
      expect(closed.ariaHidden).toBe('true');
      expect(closed.hasTheme, `${id}: data-rite survived close`).toBe(false);
      // The run continues, on the wave the rite was standing in front of.
      expect(closed.phase).toBe('prep');
      expect(closed.wave).toBe(WAVE - 1);
      expect(closed.phase2).toBe('prep');
      // A second close() cannot pay again.
      expect(closed.ledger2, `${id}: a second close() credited more gold`)
        .toBe(closed.ledger);
      expect(closed.purse2).toBe(closed.purse);
      expect(closed.ledger).toBe(now.ledger);
      // Neither close reached `addGold` at all — the ledger equality above is
      // the symptom, this is the mechanism.
      expect(closed.credits).toBe(now.rite.credits.length);
      expect(closed.credits2).toBe(now.rite.credits.length);

      // ---- 6. the console stayed empty ------------------------------------
      expect(errors, `${id}: console errors during the session`).toEqual([]);
      expect(warnings.slice(warnBefore), `${id}: console warnings during the session`)
        .toEqual([]);
    });
  }
});
