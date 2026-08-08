/**
 * `heaven` — "escape from gay heaven".
 *
 * The shared checklist (`assertRiteContract`) proves this thing is a legal
 * rite: fixed rand budget, deterministic, idle runs end and pay nothing, score()
 * is pure, no unbounded growth. What it CANNOT know is what this particular
 * rite promised, so everything after the first `it` is one of those promises:
 *
 *   - the score is BANDS CLEARED OUT OF BANDS PRESENTED, the denominator is
 *     fixed at layout time, and touching a band costs exactly that band;
 *   - one contact never costs two bands' worth of grace: the i-frame window is
 *     held open until the mote is genuinely clear;
 *   - an idle run is worth almost nothing on EVERY wave, with no cliff between
 *     waves — which is what the "first band always sweeps the whole column" and
 *     "no gap is ever left on the centreline" rules exist to deliver, so both
 *     rules are pinned here too;
 *   - the ceiling is reachable at every wave, because the worst move any course
 *     can demand stays inside `SPEED_BUDGET` of the mote's top speed. This is
 *     the promise the FIRST version broke: at wave 53 it asked for 96% of the
 *     budget and the author's own bot could not finish;
 *   - the two control paths have the same top speed, so offering both is not
 *     offering one good one and one bad one;
 *   - `draw` mutates nothing;
 *   - the hazard hue is the only saturated warm mass on the stage, which is
 *     half of the accessibility claim (the black outline and the pulsing rim
 *     are the other half and are visual, so they live in the code, its comments
 *     and a dichromacy simulation of the rendered frame).
 *
 * THE CALIBRATION CURVE IS NOT ASSERTED HERE. `tests/unit/calibration.test.js`
 * owns it, against the shared reference player, so that one instrument judges
 * all six rites. This file owns the things that are true of THIS rite whatever
 * the curve is.
 *
 * `node` environment: the rite guards `document` itself and falls back to
 * literals, which is exactly what this file is standing on.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { assertRiteContract } from './helpers/rite-contract.js';
import {
  HEAVEN_RITE, RAND_CALLS, DURATION, BANDS, MOVE_SPEED, MOTE_R, GATE, SWEEP, ORBS,
  START_X, START_Y, SPEED_BUDGET, SWEEP_W,
} from '../../src/minigames/rites/HeavenRite.js';

const DT = MINIGAMES.dt;

function spawn({ seed = 1, occurrence = 0, wave = 8 } = {}) {
  const inst = HEAVEN_RITE.create();
  inst.init({
    rand: riteRng(seed, HEAVEN_RITE.id, occurrence),
    wave, occurrence, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/** Run to the rite's own ending. Returns the instance and how long it lasted. */
function play(strategy, o = {}) {
  const inst = spawn(o);
  const cap = Math.ceil(DURATION / DT) + 1;
  let steps = 0;
  for (; steps < cap; steps++) {
    if (inst.update(DT, strategy(inst, steps)) === true) { steps++; break; }
    inst.drainEvents();
  }
  return { inst, steps, score: inst.score() };
}

/**
 * A competent player.
 *
 * IT PLANS AGAINST THE BAND IT WILL MEET NEXT, NOT AGAINST A FIXED DISTANCE,
 * and that distinction is the difference between a bot that scores 0.4 and one
 * that scores 0.95 on the same course. Two earlier versions are worth recording
 * because each failed for a reason a human fails for too:
 *
 *   v1 sampled clearance at fixed distances AHEAD OF THE MOTE. That reads the
 *      orb accordion where it is NOW and walks into where it will BE, because
 *      orbs bob on the clock rather than on x. Fixed in the rite, by giving
 *      `clearanceAt` an optional time.
 *   v2 sampled a fixed ladder of future TIMES and summed them. Averaging "the
 *      wall arriving in 0.1 s" with "the gap 1.5 s away" steers into the
 *      compromise between them, which in a rite whose gaps are two units tall
 *      is simply the wall. It chattered and died mid-course.
 *
 * v3, below: find the earliest moment `dz` at which anything at all occupies
 * the mote's column, then pick the height that keeps the most room AT that
 * moment and just after it. `clearanceAt(mx, 0, t)` returns Infinity exactly
 * when no band overlaps the column — the guard is on x alone — so the probe is
 * one cheap scan and needs no knowledge of the course's internals.
 *
 * IT IS UNCHANGED FROM THE VERSION `tests/unit/helpers/reference-player.js`
 * LIFTED, and it must stay that way: the calibration gate measures this rite
 * with a copy of this function, so a bot tuned here to move a number there
 * would be measuring the harness. The one honest way to raise the ceiling is to
 * make the course fair, which is what `SPEED_BUDGET` is for.
 *
 * ITS KNOWN WEAKNESS, NAMED. It plans against the FIRST band to occupy its
 * column and nothing behind it, so a band arriving hard on the heels of a wide
 * sweep catches it flat. That is a bot limitation, not a rite one — but it is
 * also a fair proxy for a human's, and it is the reason the schedule's
 * footprint subtraction (see `#buildCourse`) has to be real rather than
 * approximate. Raising `scroll` at the low waves so a sweep clears the column
 * sooner took the flawless ceiling at wave 3 from 0.80 to 1.00 without touching
 * a single gap size.
 */
const HORIZON = 2.6;     // seconds of foresight. Beyond this the mote drifts to centre.
const PROBE = 0.04;      // resolution of the "when does something arrive" scan.
/** Sample the arrival moment and two beats after it, so the aim TRACKS a moving throat. */
const PHASES = Object.freeze([[0, 2], [0.22, 1], [0.55, 0.5]]);
const SAMPLES = 91;

function bestY(inst) {
  let dz = 0;
  while (dz <= HORIZON && !Number.isFinite(inst.clearanceAt(inst.mx, 0, inst.t + dz))) dz += PROBE;
  if (dz > HORIZON) return 0;                 // clear air: sit mid-corridor, most options open

  const hh = FIELD.hh - 0.2;
  let best = inst.my;
  let bestV = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const y = -hh + (2 * hh * i) / (SAMPLES - 1);
    let v = 0;
    for (const [d, w] of PHASES) {
      // Capped above so extra room stops paying, and floored below so "deep
      // inside a wall" and "just inside a wall" are both simply refused.
      v += w * Math.max(-2.5, Math.min(0.9, inst.clearanceAt(inst.mx, y, inst.t + dz + d)));
    }
    // Tiebreak toward where we already are: a player who teleports their
    // intention every frame oscillates and never arrives.
    v -= Math.abs(y - inst.my) * 0.03;
    if (v > bestV) { bestV = v; best = y; }
  }
  return best;
}

/** The pointer path, which is the headline control. Proportional, so it settles. */
const SKILLED = (inst) => makeInput({ inside: true, x: inst.mx, y: bestY(inst) });

/**
 * The same brain on the KEYBOARD path. Bang-bang rather than proportional —
 * `axis` is +-1 — so it overshoots slightly, which is exactly the difference a
 * player feels between the two and the reason both are worth running.
 */
const SKILLED_KEYS = (inst) => {
  const dy = bestY(inst) - inst.my;
  return makeInput({ axis: { x: 0, y: Math.abs(dy) < 0.06 ? 0 : Math.sign(dy) } });
};

/** '#rrggbb' -> hue in degrees and saturation in [0,1]. For the hue rule below. */
function hsl(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  return { h, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

/** sRGB relative luminance, for the VALUE half of the accessibility claim. */
function luminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(((n >> 16) & 255) / 255)
    + 0.7152 * lin(((n >> 8) & 255) / 255)
    + 0.0722 * lin((n & 255) / 255);
}

const WAVES = [3, 8, 18, 28, 38, 48, 53];
const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];

// ===========================================================================

describe('heaven rite', () => {
  it('honours the whole rite contract', () => {
    assertRiteContract(HEAVEN_RITE, { randCalls: RAND_CALLS, skilled: SKILLED });
  });

  it('spends exactly BANDS * 4 + 1 seeded values, and the constant says so', () => {
    // Pinned as a LITERAL as well as an expression: the expression alone would
    // silently follow a change to BANDS, and the point of the constant is that
    // a reviewer can see the number without doing arithmetic.
    expect(RAND_CALLS).toBe(121);
    expect(RAND_CALLS).toBe(BANDS * 4 + 1);
  });

  // -------------------------------------------------------------------------
  // The score model
  // -------------------------------------------------------------------------

  it('scores bands cleared out of bands presented, and the denominator is fixed at init', () => {
    // THE CHANGE THAT MADE THIS RITE A GAME. The old score was survival time
    // under instant death, which is `min(time-to-first-error, 20) / 20` — a
    // pass/fail switch wearing a ratio. This asserts the replacement is really
    // a ratio of counts and really has a fixed denominator, because a
    // denominator that shrank when the player died would pay MORE for dying
    // sooner.
    const inst = spawn({ seed: 7, wave: 28 });
    const presented = inst.presented;
    expect(presented, 'a course that presents nothing cannot be scored').toBeGreaterThan(4);

    for (let n = 0; n < 1201; n++) {
      const end = inst.update(DT, SKILLED(inst));
      inst.drainEvents();
      expect(inst.presented, 'the denominator moved during play').toBe(presented);
      if (end === true) break;
    }
    const s = inst.score();
    expect(s.ratio).toBeCloseTo(Math.min(1, inst.cleared / presented), 12);
    expect(s.detail).toBe(`${inst.cleared}/${presented} bands cleared · `
      + `${inst.burned} burn${inst.burned === 1 ? '' : 's'}`);
  });

  it('a touched band can never be cleared, however long the mote survives after it', () => {
    // The other half of the model: the i-frames protect the RUN, never the
    // SCORE. If a burned band could still be counted, invulnerability would be
    // a free pass through the next slab.
    const inst = spawn({ seed: 3, wave: 20 });
    for (let n = 0; n < 1201; n++) {
      if (inst.update(DT, makeInput()) === true) break;
      inst.drainEvents();
    }
    let clean = 0;
    for (let i = 0; i < inst.presented; i++) {
      if (inst.touched[i]) {
        expect(inst.passed[i] && !inst.touched[i], `band ${i} was burned and still counted`).toBe(false);
      } else if (inst.passed[i]) clean++;
    }
    expect(inst.cleared).toBe(clean);
  });

  it('one contact costs one burn, not one per step it lasts', () => {
    // The i-frame window is refreshed for as long as anything is overlapping,
    // so it cannot expire inside the slab that opened it. A sweep is
    // SWEEP_W units wide and takes over a second to pass at the slow waves; a
    // fixed window would charge two or three burns for one mistake and put the
    // cliff straight back.
    const inst = spawn({ seed: 11, wave: 8 });
    // Park in the middle. The opener sweeps the whole column, so contact is
    // certain, and nothing after it is dodged either.
    let burns = 0;
    let lastBurnT = -99;
    for (let n = 0; n < 1201; n++) {
      const before = inst.burned;
      const end = inst.update(DT, makeInput());
      if (inst.burned > before) {
        burns++;
        expect(inst.t - lastBurnT, `two burns ${(inst.t - lastBurnT).toFixed(3)}s apart`)
          .toBeGreaterThan(0.3);
        lastBurnT = inst.t;
        expect(inst.grace, 'a burn must open the i-frame window').toBeGreaterThan(0);
      }
      if (end === true) break;
    }
    expect(burns, 'an idle mote never met the hazard at all').toBeGreaterThan(0);
    // And an idle run cannot rack up one burn per band: they are all one long
    // stay inside the pink, separated by the escape window.
    expect(burns).toBeLessThan(inst.presented);
  });

  it('the run always lasts its full clock — there is no early death to score', () => {
    // DELIBERATELY DIFFERENT FROM THE REVIEW'S SUGGESTION, and the evidence is
    // worth recording. Lives that END the run were tried first and measured:
    // they put the bimodality straight back, because "did you survive to the
    // end" is a coin flip whatever the denominator says. On the shared
    // reference player the ladder read 0.87 at m=0.5 and 0.12 at m=1 — a cliff
    // between two adjacent skill levels. Removing the run-ending death and
    // keeping only the i-frames turned the same ladder into
    // 0.85 / 0.75 / 0.47 / 0.19. The stake is the score, which is what the
    // calibration gate says the stake should be.
    for (const wave of [3, 28, 53]) {
      const { inst, steps } = play(() => makeInput(), { seed: 5, wave });
      expect(steps, `wave ${wave} ended early`).toBeGreaterThan(Math.floor(DURATION / DT) - 2);
      expect(inst.t).toBeGreaterThanOrEqual(DURATION);
    }
  });

  // -------------------------------------------------------------------------
  // The course
  // -------------------------------------------------------------------------

  it('band 0 is always the full-column sweep, on every wave and every seed', () => {
    // This is the mechanism behind the idle band below. If a future edit lets
    // band 0 roll a gate, an idle mote parked on that gate's gap survives the
    // opener and the idle score jumps — a cliff, in the one place the plan
    // explicitly forbids one.
    for (const wave of WAVES) {
      for (const seed of SEEDS) {
        expect(spawn({ seed, wave }).bands[0].kind, `wave ${wave} seed ${seed}`).toBe(SWEEP);
      }
    }
  });

  it('every three bands is one gate, one sweep and one accordion', () => {
    // The mix is a property of the design, not of the seed. An independent roll
    // per band deals runs — five sweeps in a row is a course three times harder
    // than five gates at the same wave — and that spread swamped the wave
    // signal the calibration curve is stated against.
    for (const wave of [3, 28, 53]) {
      for (const seed of SEEDS) {
        const { bands } = spawn({ seed, wave });
        for (let i = 0; i + 2 < BANDS; i += 3) {
          const triple = [bands[i].kind, bands[i + 1].kind, bands[i + 2].kind].sort();
          expect(triple, `wave ${wave} seed ${seed} triple at ${i}`).toEqual([GATE, SWEEP, ORBS]);
        }
      }
    }
  });

  it('no band ever leaves the corridor centreline safe', () => {
    // THE ANTI-SCENERY RULE, and it is what keeps an idle run worth nothing now
    // that the score counts bands instead of seconds. A gate whose slot happens
    // to sit where the mote already is is not an obstacle; measured with a
    // plain uniform slot, a mote parked at y=0 and never touched cleared 30% of
    // every course on every wave, which is above the contract's idle ceiling on
    // its own.
    for (const wave of [3, 18, 38, 53]) {
      for (const seed of SEEDS.slice(0, 6)) {
        const inst = spawn({ seed, wave });
        for (let i = 0; i < BANDS; i++) {
          const b = inst.bands[i];
          if (b.kind === GATE) {
            expect(Math.abs(b.gc) - b.gh, `w${wave} s${seed} gate ${i} slot straddles y=0`)
              .toBeGreaterThan(MOTE_R);
          } else if (b.kind === SWEEP) {
            // The throat has to travel further from the middle than it is tall,
            // or a fixed mote at y=0 is inside the gap for the whole pass.
            expect(b.amp - b.gh, `w${wave} s${seed} sweep ${i} never covers the middle`)
              .toBeGreaterThan(-MOTE_R);
          }
        }
      }
    }
  });

  it('the worst move any course can demand stays inside the speed budget', () => {
    /**
     * THE ASSERTION THE FIRST VERSION WOULD HAVE FAILED, and the reason its
     * wave 53 was unwinnable: the worst gate→sweep transition asked for 96% of
     * the mote's top speed, leaving 4% of margin for a human hand, and the
     * author's own flawless bot died on 22 of 24 seeds there.
     *
     * Two demands are checked, both against `MOVE_SPEED * SPEED_BUDGET`:
     *
     *   the TRANSITION — from the furthest gate slot to the opposite sweep
     *   mouth, inside the reaction window the schedule guarantees (`interval`,
     *   which is what the footprint subtraction in `#buildCourse` makes it
     *   mean);
     *
     *   the CHASE — the vertical speed of a sweep's throat, which the mote has
     *   to match for the whole width of the band.
     */
    const budget = MOVE_SPEED * SPEED_BUDGET;
    for (const wave of WAVES) {
      const inst = spawn({ seed: 1, wave });
      let span = 0;
      let amp = 0;
      for (const b of inst.bands) {
        if (b.kind === GATE) span = Math.max(span, Math.abs(b.gc));
        if (b.kind === SWEEP) amp = Math.max(amp, b.amp);
      }
      const transition = (span + amp) / inst.interval;
      const chase = (2 * amp * inst.scroll) / SWEEP_W;
      expect(transition, `wave ${wave}: worst transition demands ${transition.toFixed(2)} u/s `
        + `of a ${budget.toFixed(2)} u/s budget`).toBeLessThanOrEqual(budget);
      expect(chase, `wave ${wave}: the sweep throat runs at ${chase.toFixed(2)} u/s `
        + `of a ${budget.toFixed(2)} u/s budget`).toBeLessThanOrEqual(budget);
    }
  });

  it('an idle run is worth almost nothing on every wave, with no cliff', () => {
    const ratios = [];
    for (let wave = 3; wave <= 53; wave++) {
      const { score } = play(() => makeInput(), { seed: 31, wave });
      ratios.push(score.ratio);
    }
    for (let i = 0; i < ratios.length; i++) {
      expect(ratios[i], `idle at wave ${i + 3} scored ${ratios[i].toFixed(3)}`).toBeLessThan(0.2);
    }
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    expect(mean, `idle mean ${mean.toFixed(3)}`).toBeLessThan(0.1);
    // No cliff: one wave of difficulty may never move the do-nothing score by
    // more than a fifth. The denominator is a small integer, so a single band
    // is worth 5-10% and an exact-hundredth rule would be measuring rounding.
    for (let i = 1; i < ratios.length; i++) {
      expect(Math.abs(ratios[i] - ratios[i - 1]), `cliff between waves ${i + 2} and ${i + 3}`)
        .toBeLessThan(0.2);
    }
  });

  /**
   * The score CEILING is reachable, and reaching it is worth exactly 1.0.
   *
   * Twelve seeds rather than one, because "seed 5 at wave 4 is clearable" is a
   * fact about seed 5 and this needs to be a fact about the rite. And at EVERY
   * wave, not only the first: an unreachable ceiling at wave 53 is exactly the
   * failure that made the previous version unfixable by scoring alone.
   */
  it('a competent player clears the course, at the easiest wave and the hardest', () => {
    for (const wave of [3, 28, 53]) {
      const runs = SEEDS.map((seed) => play(SKILLED, { seed, wave }));
      const mean = runs.reduce((a, r) => a + r.score.ratio, 0) / runs.length;
      expect(mean, `wave ${wave} flawless mean ${mean.toFixed(3)}: `
        + runs.map((r, i) => `${SEEDS[i]}=${r.score.ratio.toFixed(2)}`).join(' '))
        .toBeGreaterThan(0.85);
      const perfect = runs.filter((r) => r.score.ratio >= 1);
      expect(perfect.length, `only ${perfect.length}/${SEEDS.length} courses at wave ${wave} `
        + 'were cleared outright').toBeGreaterThanOrEqual(3);
      for (const r of perfect) {
        // Not `toBeCloseTo`. A clean run is an integer over an integer and must
        // land on exactly 1, or a flawless player is paid slightly less than
        // flawless and nobody ever notices.
        expect(r.score.ratio, `cleared at ${r.score.detail}`).toBe(1);
        expect(r.score.headline).toBe('Escaped');
        expect(r.inst.burned).toBe(0);
      }
    }
  });

  it('the wave scales the difficulty of a competent run', () => {
    // The claim `ctx.wave` exists to make, measured on a DEGRADED player,
    // because a flawless bot clears every wave by design (see the ceiling test
    // above) and would report a flat line. The degradation here is one thing
    // only — a quarter-second of reaction lag, applied by holding the brain's
    // answer for 15 steps — which is the axis this rite is actually about.
    const laggy = (lag) => {
      const ring = [];
      return (inst) => {
        ring.push(bestY(inst));
        const y = ring.length > lag ? ring.shift() : ring[0];
        return makeInput({ inside: true, x: inst.mx, y });
      };
    };
    const seeds = [1, 2, 3, 5, 7, 11];
    const mean = (wave) => seeds
      .map((seed) => play(laggy(15), { seed, wave }).score.ratio)
      .reduce((a, b) => a + b, 0) / seeds.length;
    const early = mean(3);
    const late = mean(53);
    expect(early, `wave 3 mean ${early.toFixed(2)}`).toBeGreaterThan(0.6);
    expect(late, `wave 53 mean ${late.toFixed(2)}`).toBeLessThan(early - 0.1);
    // But never zero: an unwinnable rite is not a hard rite.
    expect(late, `wave 53 mean ${late.toFixed(2)}`).toBeGreaterThan(0.15);
  });

  it('occurrence changes the shape and not the difficulty', () => {
    // `ctx.occurrence` is for structural variation only (contract.js
    // MinigameCtx). Here it mirrors every sweep, so the second appearance is
    // the same course upside down: identical kinds, identical schedule,
    // identical gap sizes, opposite ramps.
    const a = spawn({ seed: 4242, wave: 30, occurrence: 0 });
    const b = spawn({ seed: 4242, wave: 30, occurrence: 1 });
    expect(b.presented).toBe(a.presented);
    for (let i = 0; i < BANDS; i++) {
      expect(b.bands[i].kind).toBe(a.bands[i].kind);
      expect(b.bands[i].t0).toBeCloseTo(a.bands[i].t0, 12);
      expect(b.bands[i].gh).toBeCloseTo(a.bands[i].gh, 12);
      if (a.bands[i].kind === SWEEP) expect(b.bands[i].dir).toBe(-a.bands[i].dir);
    }
  });

  it('emits its cues: the go signal, a pickup per clean band, a break per burn', () => {
    const inst = spawn({ seed: 1, wave: 3 });
    const seen = [];
    for (let n = 0; n < 1201; n++) {
      const end = inst.update(DT, SKILLED(inst));
      for (const e of inst.drainEvents()) seen.push(e.type);
      if (end === true) break;
    }
    expect(seen[0], 'the go signal must be first').toBe('start');
    // One 'gold' per band cleared clean — the cue and the score are the same
    // event, which is the only way a twenty-second rite teaches its own scoring.
    expect(seen.filter((t) => t === 'gold')).toHaveLength(inst.cleared);
    expect(seen.filter((t) => t === 'break')).toHaveLength(inst.burned);
    expect(seen.at(-1)).toBe(inst.burned === 0 ? 'perfect' : 'good');
    // Threading a two-unit gap at 7 u/s cannot happen without near misses; if
    // this is ever zero the NEAR_MISS window has been tuned into uselessness.
    expect(seen.filter((t) => t === 'tick').length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // The controls
  // -------------------------------------------------------------------------

  it('the keyboard path is playable, not a courtesy', () => {
    // Same brain, bang-bang control. It must stay in the same league as the
    // pointer — if `axis` scored a third as well, offering it would be a trap.
    const seeds = [1, 2, 3, 5, 7, 11];
    const avg = (s) => seeds.map((seed) => play(s, { seed, wave: 8 }).score.ratio)
      .reduce((a, b) => a + b, 0) / seeds.length;
    const keys = avg(SKILLED_KEYS);
    const mouse = avg(SKILLED);
    expect(keys, `keyboard mean ${keys.toFixed(2)} vs pointer ${mouse.toFixed(2)}`)
      .toBeGreaterThan(mouse - 0.2);
  });

  it('the two control paths have the same top speed', () => {
    // The clamp is the difficulty budget. If the pointer path were faster than
    // `axis` the keyboard would be a handicap; if it were slower, the mouse
    // would be. Measured over 30 steps of "go straight up", from the same start.
    const a = spawn({ wave: 3 });
    const b = spawn({ wave: 3 });
    for (let n = 0; n < 30; n++) {
      a.update(DT, makeInput({ axis: { x: 0, y: 1 } }));
      b.update(DT, makeInput({ inside: true, x: b.mx, y: FIELD.hh }));
    }
    expect(a.my).toBeCloseTo(b.my, 6);
    expect(a.my).toBeCloseTo(30 * DT * MOVE_SPEED, 6);
    // And a diagonal is not free speed: 8-way must be normalised, or holding
    // two keys is 1.41x faster than holding one and the best control scheme is
    // whichever one the player happened to discover.
    const c = spawn({ wave: 3 });
    for (let n = 0; n < 30; n++) c.update(DT, makeInput({ axis: { x: 1, y: 1 } }));
    expect(Math.hypot(c.mx - START_X, c.my - START_Y)).toBeCloseTo(30 * DT * MOVE_SPEED, 6);
  });

  // -------------------------------------------------------------------------
  // The picture
  // -------------------------------------------------------------------------

  it('draw() mutates nothing', () => {
    const inst = spawn({ seed: 9, wave: 30 });
    for (let n = 0; n < 200; n++) inst.update(DT, SKILLED(inst));
    const before = JSON.stringify(inst);
    const g = stubPainter();
    for (let f = 0; f < 5; f++) inst.draw(g, f / 5);
    expect(JSON.stringify(inst)).toBe(before);
    expect(g.calls, 'draw() painted nothing at all').toBeGreaterThan(50);
  });

  it('draws every band kind without throwing', () => {
    // The draw path is the one half of a rite no unit test naturally reaches,
    // and a throw in there is not a wrong picture — MinigameHost.#guard
    // abandons the rite and the player loses the gold (docs/MINIGAMES.md §5).
    // So: run real courses, render every step, and require that all three
    // kinds actually went through the painter rather than trusting that they
    // did. Wave 3 and wave 53 for the two ends of the geometry.
    const kinds = new Set();
    for (const wave of [3, 53]) {
      for (const seed of [1, 2, 3, 5]) {
        const inst = spawn({ seed, wave });
        const g = stubPainter();
        for (let n = 0; n < 1201; n++) {
          const end = inst.update(DT, SKILLED(inst));
          inst.drainEvents();
          inst.draw(g, (n % 3) / 3);
          for (const b of inst.bands) if (inst.t >= b.t0) kinds.add(b.kind);
          if (end === true) break;
        }
      }
    }
    expect([...kinds].sort()).toEqual([GATE, SWEEP, ORBS].sort());
  });

  it('different seeds lay out different courses', () => {
    const a = spawn({ seed: 1, wave: 20 }).bands.map((b) => `${b.kind}:${b.gc.toFixed(3)}`).join();
    const b = spawn({ seed: 2, wave: 20 }).bands.map((b) => `${b.kind}:${b.gc.toFixed(3)}`).join();
    expect(a).not.toBe(b);
  });

  it('the hazard is the only saturated warm mass on the stage, and the brightest thing on it', () => {
    /**
     * HALF THE ACCESSIBILITY PROMISE, AND THE HALF A TEST CAN HOLD.
     *
     * A hazard identified by hue alone is unplayable for a dichromat, so the
     * rite adds a hard black outline all the way round every mass and a pulsing
     * inner rim — but those only help if nothing ELSE on the stage is close
     * enough to the hazard to be mistaken for it.
     *
     * TWO CHANNELS ARE ASSERTED, and the second is the one a simulated
     * dichromat actually uses. HUE: everything else is either desaturated
     * (cloud, outline) or more than 70 degrees away (the cool accent, the green
     * `--good`). VALUE: the hazard is more than four times the luminance of the
     * sky it sits on, so it separates by brightness before hue is involved —
     * which is exactly why the re-hue from magenta to ember did not cost the
     * rite anything under protanopia, where a red channel is what goes missing.
     */
    const p = spawn()._palette;
    const ember = hsl(p.ember);
    expect(ember.h, `hazard hue ${ember.h.toFixed(0)}deg is not warm`).toBeGreaterThan(10);
    expect(ember.h).toBeLessThan(45);
    expect(ember.s).toBeGreaterThan(0.9);

    for (const key of ['outline', 'cloud', 'cloud2', 'cloud3', 'cloud4', 'accent', 'good']) {
      const c = hsl(p[key]);
      const apart = Math.min(Math.abs(c.h - ember.h), 360 - Math.abs(c.h - ember.h));
      const ok = c.s < 0.35 || apart > 70;
      expect(ok, `${key} (${p[key]}) sits ${apart.toFixed(0)}deg from the hazard hue at s=${c.s.toFixed(2)}`)
        .toBe(true);
    }
    // The deep core and the pulsing rim are PART of the hazard and are meant to
    // share its family; what they may not do is drift out of it.
    for (const key of ['emberDeep', 'emberRim']) {
      const c = hsl(p[key]);
      const apart = Math.min(Math.abs(c.h - ember.h), 360 - Math.abs(c.h - ember.h));
      expect(apart, `${key} (${p[key]}) has left the hazard family`).toBeLessThan(30);
    }
    // Value. The stage gradient bottoms out around #070a10; `--bg` is the
    // darkest thing the palette knows and is what the outline is drawn in.
    expect(luminance(p.ember) / Math.max(1e-4, luminance(p.outline))).toBeGreaterThan(20);
    expect(luminance(p.ember)).toBeGreaterThan(0.3);
  });
});

/**
 * A Painter that records rather than paints.
 *
 * A Proxy so it never needs updating when Painter grows a primitive — the whole
 * API is "returns this", and the three exceptions are named: `clipRect` runs its
 * callback (otherwise the entire scene is skipped and the purity check passes
 * on a draw that did nothing), `linearFill` returns an opaque handle, and
 * `scale`/`translate` still have to chain.
 */
function stubPainter() {
  const state = { calls: 0 };
  const p = new Proxy(state, {
    get(t, k) {
      if (k === 'calls') return t.calls;
      if (typeof k === 'symbol') return undefined;
      t.calls++;
      if (k === 'clipRect') return (cx, cy, w, h, fn) => { fn(p); return p; };
      if (k === 'linearFill') return () => 'gradient';
      return () => p;
    },
  });
  return p;
}
