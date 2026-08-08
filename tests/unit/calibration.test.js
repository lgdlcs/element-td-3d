/**
 * ############################################################################
 * #  CALIBRATION GATE — NOT A REGRESSION TEST.                               #
 * #                                                                          #
 * #  THIS FILE IS EXPECTED TO FAIL. Every failure in it is a rite that is     #
 * #  not yet tuned, not a bug someone introduced. Do not skip it, do not      #
 * #  loosen it to make CI green, and do not delete a case because it is red   #
 * #  — the red cases ARE the work list. It goes green when the six rites      #
 * #  agree with each other, and on that day it becomes a regression test      #
 * #  without a line of it changing.                                          #
 * ############################################################################
 *
 * WHAT IS BROKEN, AND WHY A GATE RATHER THAN SIX MORE UNIT TESTS.
 *
 * `contract.js` promises, in the `minigameReward` docblock, that the payout is
 * "owned by the contract and not by the rite, so every rite is worth the same at
 * the same level of play". That promise is currently false, and all 81 rite unit
 * tests pass while it is false, because every one of those suites validates its
 * own rite against ITSELF: a perfect run scores ~1, an idle run scores ~0, and
 * nothing checks the enormous space in between or compares one rite to another.
 * Measured with the shared reference player in `helpers/reference-player.js`,
 * one competent player scores 0.148 in `heaven` and 0.973 in `platforms` at the
 * same wave 3. Through `minigameReward` that is 9% of the purse against 97% — a
 * TENFOLD difference in gold decided by nothing but which rite the seed dealt.
 *
 * A cross-rite claim cannot live in a per-rite suite. It lives here.
 *
 * ---------------------------------------------------------------------------
 * THE TARGET CURVE, AND WHY THESE THREE NUMBERS
 * ---------------------------------------------------------------------------
 *
 *   wave  3 -> 0.82      wave 28 -> 0.68      wave 53 -> 0.54     (+- 0.12)
 *
 * measured as the mean ratio of `REFERENCE_SKILL` over `SEEDS`.
 *
 * It is a straight line: 0.82 at the first rite, falling about 0.0056 per wave
 * to 0.54 at the last. Straight on purpose — a rite author tuning a difficulty
 * curve needs to know the target at wave 18 and wave 41, not only at the three
 * waves that happen to be probed, and a straight line is the only shape you can
 * read off without this file in front of you.
 *
 * WHY 0.82 AT WAVE 3, not 1.0. The first rite of a run should feel like a
 * reward, and it should not feel like a formality. Through `MINIGAMES.payCurve`
 * (1.25) a ratio of 0.82 pays 78% of the perfect purse — generous, and still
 * visibly short of flawless, so the player can see there is a better run
 * available. A target of 1.0 would mean the rite pays out identically whether
 * you engage or not, which is a cutscene with a mouse attached.
 *
 * WHY 0.54 AT WAVE 53, not 0.2. Wave 53 is the last rite in a run and the wave
 * after it is the most expensive thing the player will ever buy. 0.54 pays 44%
 * of the perfect purse: it is unambiguously worth playing, the ceiling is
 * visibly out of reach, and — the constraint that actually rules out a lower
 * number — the rite is still WINNABLE. A curve that ends at 0.2 is a curve
 * whose last third is a formality in the other direction: the difference between
 * a good run and a bad one shrinks into the rounding, and the interlude becomes
 * a toll rather than a game. The drop from 0.82 to 0.54 is the whole difficulty
 * arc, and 0.28 of ratio is a difference a player can feel on the result card
 * without being punished for having a late-game run.
 *
 * WHY +- 0.12 AND NOT +- 0.03. Two reasons, and the second is the important one.
 *
 *   1. It is what the instrument can actually resolve. Five seeds of a chaotic
 *      simulation give a standard error of a few hundredths; a tolerance near
 *      that would fail on the seed list rather than on the rite.
 *   2. It is what "worth the same" needs to mean to be reachable. At wave 53
 *      the band is 0.42..0.66, which through the pay curve is 34%..60% of the
 *      purse — a 1.76x spread between the meanest rite and the most generous.
 *      That is not equality, and it is not meant to be: six rites with four
 *      different verbs cannot be tuned to a hair, and a gate demanding it would
 *      be gamed with score fudge factors rather than met with design. What it
 *      replaces is a 25x spread (0.07 to 1.00). A gate that six agents can hit
 *      by making their rite better is worth more than one they can only hit by
 *      making the number lie.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR SHAPE RULES, WHICH MATTER MORE THAN THE CURVE
 * ---------------------------------------------------------------------------
 *
 * A rite can sit on the curve and still be broken. These four are the shape of a
 * score, and a rite that fails one of them is not a difficulty problem, it is a
 * design problem — fix them FIRST, then aim at the curve.
 *
 *  1. IDLE IS STRICTLY WORSE THAN TRYING, at every wave, by a real margin. The
 *     single worst finding in the batch: in `heaven` the reference player beats
 *     a player who walked away by 0.023 at wave 3 and by 0.005 at wave 53
 *     (0.148 vs 0.125, 0.071 vs 0.066). Through `payCurve` that is a difference
 *     of ZERO GOLD, rounded. Both runs are scored by survival time and both die
 *     in the first two seconds, so the rite is not measuring the player at all.
 *     `minigameReward` has no gate under it any more — the floor and threshold
 *     were removed on purpose — so the rite's own idle score is the only thing
 *     making "start it and look away" unprofitable.
 *  2. THE MID-BAND EXISTS. A clumsy player must land between the two ends rather
 *     than snapping to one of them. A rite whose score is bimodal is a pass/fail
 *     switch wearing a ratio: it reports 0..1 to the host, the host feeds it to
 *     a continuous pay curve, and the player experiences a coin flip.
 *  3. MONOTONIC IN SKILL. More skill never scores less.
 *  4. MONOTONIC IN WAVE. A fixed player does not score HIGHER on a later wave.
 *     `wave` is the difficulty axis and the entire reason the curve above can be
 *     stated; a rite that gets easier as the run goes on makes it meaningless.
 *
 * ---------------------------------------------------------------------------
 * CURRENT STATE — measured when this file landed. Read the first table.
 * ---------------------------------------------------------------------------
 *
 * Reference player (m=1), mean of 5 seeds. `!` marks outside the +-0.12 band.
 *
 *     rite         w3            w28           w53
 *     heaven       0.148 !       0.093 !       0.071 !
 *     platforms    0.973 !       0.883 !       0.811 !
 *     luckyshot    0.863         0.884 !       0.937 !
 *     offroad      0.801         0.729         0.714 !
 *     hunt         1.000 !       0.925 !       0.225 !
 *     fishing      0.743         0.865 !       0.962 !
 *     TARGET       0.82+-.12     0.68+-.12     0.54+-.12
 *
 * Shape rules. "3/3" means all three probed waves fail.
 *
 *     rite        idle<trying  mid-band     mono skill  mono wave  ceiling
 *     heaven      FAIL 3/3     FAIL 3/3     pass        pass       FAIL w53
 *     platforms   pass         FAIL 3/3     pass        pass       pass
 *     luckyshot   pass         pass         pass        FAIL       pass
 *     offroad     pass         pass         pass        pass       pass
 *     hunt        pass         FAIL w28,53  pass        pass       pass
 *     fishing     pass         pass         pass        FAIL       pass
 *
 * 28 of 101 cases fail. By rite: heaven 10, platforms 6, hunt 5, luckyshot 3,
 * fishing 3, offroad 1.
 *
 * `offroad` is the only rite that fails nothing structural and misses the curve
 * in one cell only (0.714 at wave 53, wanted <= 0.66 — it does not get harder
 * fast enough). It is the worked example: aim at it.
 *
 * The five failures worth reading before touching anything:
 *
 *  - `heaven` is not a game under this instrument. It is 1.000 flawless and
 *    0.148 for a competent player at wave 3 — a cliff at roughly 0.25 s of
 *    reaction lag, which is inside human range, so every real player is on the
 *    wrong side of it. It fails four of the five rules.
 *  - `heaven` at wave 53 scores 0.31 under PERFECT play: the oracle bot cannot
 *    finish the course. The ceiling is unreachable, so no amount of scoring
 *    tuning helps until the wave scaling changes.
 *  - `platforms` is the mirror image: 0.973 / 0.883 / 0.811 for the reference
 *    player and IDENTICAL numbers for a clumsy one. Its only two outcomes are
 *    "survived the clock" and "fell off immediately". (Read that number with
 *    the harness's blind spot in mind — the brain reads the fall schedule, so
 *    this is an upper bound; see reference-player.js.)
 *  - `hunt` inverts across skill instead of across waves: flawless to m=1, then
 *    0.000 at m=2. A rite where a shot is on time or the animal is gone.
 *  - `luckyshot` and `fishing` both score HIGHER at wave 53 than at wave 3
 *    (0.863 -> 0.937 and 0.743 -> 0.962). Both score against a fixed PAR and
 *    clamp at 1, so raising the wave adds targets faster than it adds pressure.
 *
 * One observation that is not an assertion: `offroad` never exceeds 0.88 even
 * flawlessly, because its score blends three components one of which depends on
 * the rivals. That is a deliberate design, but it does compress its whole curve
 * against a ceiling below 1.
 *
 * ---------------------------------------------------------------------------
 * HOW TO USE THIS FILE IF YOU ARE TUNING ONE RITE
 * ---------------------------------------------------------------------------
 *
 *   npx vitest run tests/unit/calibration.test.js -t heaven
 *
 * Every failure names the rite, the wave, what was measured and what was
 * required, so the message alone is the brief. The first test prints the whole
 * table and the elapsed time; read it before you change anything.
 *
 * DO NOT tune by adding a multiplier to `score()`. The gate measures the same
 * thing the player feels, and a rite that only passes because its ratio was
 * scaled has moved the problem into the result card, where the headline says
 * "Flawless" over a 0.54. Tune the game: the window, the speed, the count, the
 * wave scaling.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  RITE_IDS, SEEDS, REFERENCE_SKILL, SKILL_PERFECT, skill, playRite, meanRatio,
} from './helpers/reference-player.js';

/** The three waves the curve is stated at: first rite, middle, last. */
const CURVE_WAVES = Object.freeze([3, 28, 53]);

/** The target ratio for `REFERENCE_SKILL`, by wave. Straight line; see the docblock. */
const TARGET = Object.freeze({ 3: 0.82, 28: 0.68, 53: 0.54 });

/** Half-width of the acceptable band around the target. See the docblock. */
const TOLERANCE = 0.12;

/**
 * How far above an idle run a trying player must land.
 *
 * "Strictly greater" is the letter of the rule and is not enough: a trying
 * player beating a do-nothing run by 0.002 is a rite where engagement is worth
 * a rounding error, and through `payCurve` it is worth literally zero gold.
 * 0.15 is the same number `assertRiteContract` uses as its idle ceiling, so the
 * two rules compose: an idle run under 0.15 and a trying run 0.15 above it puts
 * deliberate play in a different half of the range from neglect.
 */
const IDLE_GAP = 0.15;

/**
 * The clumsy player: `m = 2`, i.e. twice the reference degradation — 0.56 s of
 * lag, half a unit of aim SD, a quarter of decisions wrong, a hand at 13 u/s.
 * Recognisably a person having a bad time, not a person who left the room.
 */
const CLUMSY = skill(2);

/** How far inside the [idle, perfect] range the clumsy player must land. */
const MID_MARGIN = 0.10;

/**
 * Skill ladder for the monotonicity sweep, worst last.
 * m = 0 is the rite author's own bot; m = 3.5 is barely participating.
 */
const LADDER = Object.freeze([0, 0.5, 1, 2, 3.5]);

/**
 * Slack on both monotonicity rules.
 *
 * NOT a fudge factor — a measured bound. These are chaotic simulations sampled
 * at five seeds, and across all 18 rite/wave cells the largest inversion that
 * survives averaging is 0.018 (offroad, wave 53, m 0 -> 0.5). 0.05 sits above
 * that and well below any inversion a human would call real. If a rite fails
 * monotonicity by more than 0.05 it is not noise, it is a rite where trying
 * harder is punished.
 */
const MONO_SLACK = 0.05;

/** Waves the wave-monotonicity rule is checked at. Every rite appears twice per run. */
const WAVE_LADDER = Object.freeze([3, 13, 23, 33, 43, 53]);

/** A rite the ceiling must stay reachable in, however hard the wave. */
const CEILING_FLOOR = 0.75;

// ---------------------------------------------------------------------------
// One measurement pass, shared by every assertion below.
// ---------------------------------------------------------------------------

/**
 * Everything is measured ONCE, in `beforeAll`, and every `it` reads the cache.
 *
 * Not for elegance — for the budget. Each cell is five full playthroughs at a
 * fixed 60 Hz step, and the assertions overlap heavily (the curve, the mid-band
 * and the skill ladder all want m = 1 at wave 28). Measuring per-`it` would run
 * the same simulation four times and turn a 2 s gate into an 8 s one, which is
 * the difference between a gate that survives and a gate that gets deleted.
 */
const M = { curve: {}, idle: {}, ladder: {}, waves: {}, elapsedMs: 0 };

const key = (id, wave) => `${id}@${wave}`;

beforeAll(() => {
  const t0 = Date.now();
  for (const id of RITE_IDS) {
    for (const wave of CURVE_WAVES) {
      M.idle[key(id, wave)] = meanRatio({ rite: id, wave, idle: true });
      M.ladder[key(id, wave)] = LADDER.map((m) => meanRatio({ rite: id, wave, skill: skill(m) }));
    }
    for (const wave of WAVE_LADDER) {
      M.waves[key(id, wave)] = meanRatio({ rite: id, wave, skill: REFERENCE_SKILL });
    }
  }
  // The curve and the ladder's m = 1 entry are the same measurement.
  for (const id of RITE_IDS) {
    for (const wave of CURVE_WAVES) {
      M.curve[key(id, wave)] = M.ladder[key(id, wave)][LADDER.indexOf(1)];
    }
  }
  M.elapsedMs = Date.now() - t0;
});

const f3 = (v) => v.toFixed(3);

// ---------------------------------------------------------------------------

describe('CALIBRATION GATE — the table', () => {
  /**
   * Always passes. Its whole job is to put the numbers in the console next to
   * the failures, because a red list without the measurements is six agents
   * each re-deriving the same table by hand.
   */
  it('prints the current state and the time it cost', () => {
    const lines = [];
    lines.push('');
    lines.push('  CALIBRATION GATE — reference player, mean of ' + SEEDS.length + ' seeds');
    lines.push('  skill: ' + JSON.stringify(REFERENCE_SKILL));
    lines.push('');
    lines.push('  rite        ' + CURVE_WAVES.map((w) => `w${w}`.padEnd(9)).join('') + ' idle(w53)  perfect(w53)');
    for (const id of RITE_IDS) {
      const cells = CURVE_WAVES.map((w) => {
        const v = M.curve[key(id, w)];
        const off = Math.abs(v - TARGET[w]) > TOLERANCE ? '!' : ' ';
        return `${f3(v)}${off}   `;
      }).join('');
      const perfect = meanRatio({ rite: id, wave: 53, skill: SKILL_PERFECT });
      lines.push(`  ${id.padEnd(11)} ${cells} ${f3(M.idle[key(id, 53)])}      ${f3(perfect)}`);
    }
    lines.push(`  TARGET      ${CURVE_WAVES.map((w) => `${TARGET[w].toFixed(2)}+-${TOLERANCE}`.padEnd(12)).join('')}`);
    lines.push('');
    lines.push(`  measured in ${M.elapsedMs} ms  ("!" = outside the band)`);
    lines.push('');
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    expect(M.elapsedMs, 'the calibration sweep blew its 6 s budget — trim seeds or waves before anyone deletes it')
      .toBeLessThan(6000);
  });
});

// ---------------------------------------------------------------------------

describe('CALIBRATION GATE — the target curve', () => {
  for (const id of RITE_IDS) {
    for (const wave of CURVE_WAVES) {
      it(`${id} pays a competent player ~${TARGET[wave]} at wave ${wave}`, () => {
        const got = M.curve[key(id, wave)];
        const want = TARGET[wave];
        const lo = want - TOLERANCE;
        const hi = want + TOLERANCE;
        const verdict = got < lo ? 'TOO PUNISHING' : 'TOO GENEROUS';
        const msg = `[${id}] wave ${wave} — ${verdict}. The reference player `
          + `(lag ${REFERENCE_SKILL.reactionLag}s, aimSd ${REFERENCE_SKILL.aimSd}u, `
          + `noise ${REFERENCE_SKILL.decisionNoise}, pointer ${REFERENCE_SKILL.pointerSpeed}u/s) `
          + `scored ${f3(got)} over ${SEEDS.length} seeds; the curve requires `
          + `${f3(lo)}..${f3(hi)} (target ${want.toFixed(2)} +- ${TOLERANCE}). `
          + `Off by ${f3(got < lo ? lo - got : got - hi)}.`;
        expect(got, msg).toBeGreaterThanOrEqual(lo);
        expect(got, msg).toBeLessThanOrEqual(hi);
      });
    }
  }
});

// ---------------------------------------------------------------------------

describe('CALIBRATION GATE — trying beats doing nothing', () => {
  for (const id of RITE_IDS) {
    for (const wave of CURVE_WAVES) {
      it(`${id} pays a player who fights more than one who walks away, at wave ${wave}`, () => {
        const trying = M.curve[key(id, wave)];
        const idle = M.idle[key(id, wave)];
        const msg = `[${id}] wave ${wave} — ENGAGEMENT IS NOT PAID. A player doing `
          + `nothing scores ${f3(idle)}; the reference player scores ${f3(trying)}, `
          + `a difference of ${f3(trying - idle)}. Required: at least ${IDLE_GAP}. `
          + (trying <= idle
            ? 'The idle run scores AS MUCH OR MORE than the real one — this rite pays for neglect.'
            : 'The gap is inside the rounding of the pay curve, so playing is worth nothing in gold.');
        expect(trying - idle, msg).toBeGreaterThanOrEqual(IDLE_GAP);
      });
    }
  }
});

// ---------------------------------------------------------------------------

describe('CALIBRATION GATE — the mid-band exists', () => {
  for (const id of RITE_IDS) {
    for (const wave of CURVE_WAVES) {
      it(`${id} puts a clumsy player between the two ends, at wave ${wave}`, () => {
        const ladder = M.ladder[key(id, wave)];
        const perfect = ladder[LADDER.indexOf(0)];
        const mid = ladder[LADDER.indexOf(2)];
        const idle = M.idle[key(id, wave)];
        const lo = idle + MID_MARGIN;
        const hi = perfect - MID_MARGIN;
        const where = mid < lo ? 'COLLAPSED TO THE FLOOR' : 'PINNED TO THE CEILING';
        const msg = `[${id}] wave ${wave} — NO MID-BAND, ${where}. A clumsy player `
          + `(2x the reference degradation) scored ${f3(mid)}. Idle is ${f3(idle)} and `
          + `flawless is ${f3(perfect)}, so a mid-band player must land in `
          + `${f3(lo)}..${f3(hi)}. The full skill ladder m=[${LADDER.join(', ')}] reads `
          + `[${ladder.map(f3).join(', ')}] — a rite whose ratio only ever reports one of `
          + `two values is a pass/fail switch wearing a continuous score.`;
        // A rite with no room between its own ends cannot have a mid-band at
        // all; say that rather than reporting an impossible interval.
        expect(perfect - idle, `[${id}] wave ${wave} — the whole score range is `
          + `${f3(perfect - idle)} wide (idle ${f3(idle)}, flawless ${f3(perfect)}). `
          + `There is no room for a mid-band because there is no range.`)
          .toBeGreaterThan(2 * MID_MARGIN);
        expect(mid, msg).toBeGreaterThanOrEqual(lo);
        expect(mid, msg).toBeLessThanOrEqual(hi);
      });
    }
  }
});

// ---------------------------------------------------------------------------

describe('CALIBRATION GATE — more skill never scores less', () => {
  for (const id of RITE_IDS) {
    for (const wave of CURVE_WAVES) {
      it(`${id} is monotone in skill at wave ${wave}`, () => {
        const v = M.ladder[key(id, wave)];
        for (let i = 1; i < v.length; i++) {
          const msg = `[${id}] wave ${wave} — SKILL IS PUNISHED. The worse player `
            + `(m=${LADDER[i]}) scored ${f3(v[i])}; the better one (m=${LADDER[i - 1]}) `
            + `scored ${f3(v[i - 1])}, i.e. ${f3(v[i] - v[i - 1])} LESS for playing better. `
            + `Slack is ${MONO_SLACK} (measured sampling noise). Full ladder `
            + `m=[${LADDER.join(', ')}] -> [${v.map(f3).join(', ')}].`;
          expect(v[i], msg).toBeLessThanOrEqual(v[i - 1] + MONO_SLACK);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------

describe('CALIBRATION GATE — later waves are not easier', () => {
  for (const id of RITE_IDS) {
    it(`${id} never scores a fixed player higher on a later wave`, () => {
      const v = WAVE_LADDER.map((w) => M.waves[key(id, w)]);
      for (let i = 1; i < v.length; i++) {
        const msg = `[${id}] — THE WAVE MAKES IT EASIER. The reference player scored `
          + `${f3(v[i])} at wave ${WAVE_LADDER[i]} but only ${f3(v[i - 1])} at wave `
          + `${WAVE_LADDER[i - 1]}: ${f3(v[i] - v[i - 1])} MORE on the harder wave. `
          + `Slack is ${MONO_SLACK}. Full curve `
          + `w=[${WAVE_LADDER.join(', ')}] -> [${v.map(f3).join(', ')}]. `
          + `\`wave\` is the difficulty axis (contract.js MinigameCtx) and the target `
          + `curve is stated against it — a rite that inverts it makes the curve `
          + `meaningless for every rite, not only this one.`;
        expect(v[i], msg).toBeLessThanOrEqual(v[i - 1] + MONO_SLACK);
      }
    });
  }
});

// ---------------------------------------------------------------------------

describe('CALIBRATION GATE — the ceiling stays reachable', () => {
  for (const id of RITE_IDS) {
    for (const wave of CURVE_WAVES) {
      it(`${id} can still be won at wave ${wave}`, () => {
        const perfect = M.ladder[key(id, wave)][LADDER.indexOf(0)];
        const msg = `[${id}] wave ${wave} — UNWINNABLE. Flawless play (the rite's own `
          + `author bot, undegraded) scored only ${f3(perfect)}; at least ${CEILING_FLOOR} `
          + `is required for the curve above to be reachable by anybody. No amount of `
          + `skill tuning fixes this — the wave scaling has outrun the game.`;
        expect(perfect, msg).toBeGreaterThanOrEqual(CEILING_FLOOR);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The instrument's own proof. THESE MUST PASS — if they do not, nothing above
// means anything, and the failure is in helpers/reference-player.js.
// ---------------------------------------------------------------------------

describe('the reference player itself', () => {
  it('is deterministic: the same run twice is the same score, on every rite', () => {
    for (const id of RITE_IDS) {
      const a = playRite({ rite: id, seed: 4242, wave: 28, skill: REFERENCE_SKILL });
      const b = playRite({ rite: id, seed: 4242, wave: 28, skill: REFERENCE_SKILL });
      expect(b.ratio, `[${id}] the reference player is not deterministic: `
        + `${a.ratio} then ${b.ratio}. An instrument that cannot repeat itself `
        + `cannot measure anything.`).toBe(a.ratio);
      expect(b.steps, `[${id}] two identical runs took ${a.steps} and ${b.steps} steps`)
        .toBe(a.steps);
      expect(b.detail, `[${id}] two identical runs produced different evidence`).toBe(a.detail);
    }
  });

  it('is independent of the skill vector in its noise stream', () => {
    // The same world, two players. If the noise depended on the skill, a skill
    // sweep would be comparing two different worlds and every monotonicity
    // result in this file would be a coincidence.
    const a = playRite({ rite: 'offroad', seed: 7, wave: 28, skill: skill(1) }).ratio;
    const b = playRite({ rite: 'offroad', seed: 7, wave: 28, skill: skill(1, {}) }).ratio;
    expect(b, 'two identical skill vectors disagreed — the noise is not a pure function of the world')
      .toBe(a);
  });

  it('measures: reaction lag alone lowers the score on at least four of the six', () => {
    // THE LOAD-BEARING CLAIM ABOUT THE HARNESS. Everything above is a statement
    // about the rites only if the body actually has grip on them; if latency
    // were free everywhere, the tables would be a property of the author bots.
    //
    // Lag is swept ALONE, from a flawless body, so nothing else can be credited
    // with the drop. It is swept to 3x the reference rather than tested at 1x
    // because several rites have a whole second of slack in their windows — a
    // rite that shrugs off 0.28 s and folds at 0.84 s is still a rite this
    // instrument can measure, and pretending otherwise would mean tuning the
    // reference player until it produced the answer we wanted.
    const LAGS = [0, 0.28, 0.56, 0.84];
    const moved = [];
    const flat = [];
    for (const id of RITE_IDS) {
      const base = meanRatio({ rite: id, wave: 28, skill: SKILL_PERFECT });
      let worst = base;
      for (const reactionLag of LAGS.slice(1)) {
        worst = Math.min(worst, meanRatio({ rite: id, wave: 28, skill: { ...SKILL_PERFECT, reactionLag } }));
      }
      (base - worst > 0.05 ? moved : flat).push(`${id} ${f3(base)}->${f3(worst)}`);
    }
    expect(moved.length, `reaction lag moved the score on only ${moved.length} of `
      + `${RITE_IDS.length} rites — the instrument has no grip on the rest, so their `
      + `rows in the tables above are weaker evidence than the others. `
      + `Moved: [${moved.join(', ')}]. Unmoved: [${flat.join(', ')}]. `
      + `(\`platforms\` is expected to be the unmoved one: its brain, like the `
      + `author's bot it is lifted from, reads the fall schedule and re-plans 1.1 s `
      + `ahead, so any lag under 1.1 s is free BY CONSTRUCTION OF THE BOT. That is `
      + `a known blind spot of the harness, recorded in reference-player.js.)`)
      .toBeGreaterThanOrEqual(4);
  });

  it('reproduces the author bot exactly at zero degradation', () => {
    // SKILL_PERFECT is a pass-through, so a "perfect" run must not depend on the
    // noise seed at all. If it does, some degradation is leaking in at m = 0 and
    // the ceiling this file measures is not the ceiling the rite suites measure.
    for (const id of RITE_IDS) {
      const a = playRite({ rite: id, seed: 1234, wave: 28, skill: SKILL_PERFECT }).ratio;
      const b = playRite({ rite: id, seed: 1234, wave: 28, skill: skill(0) }).ratio;
      expect(b, `[${id}] SKILL_PERFECT and skill(0) disagree (${a} vs ${b}) — `
        + `the zero of the skill dial is not the author's bot`).toBe(a);
    }
  });
});
