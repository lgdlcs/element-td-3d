/**
 * OFFROAD RACING — the rite's own suite, on top of the shared checklist.
 *
 * `assertRiteContract` covers everything that is true of ANY rite: a fixed rand
 * budget on three waves, determinism, an idle run that terminates and pays
 * nothing, mashing losing to deliberate play, 1 500 steps of fuzz staying finite
 * and bounded, a pure `score()`, a `drainEvents` that empties. What is left, and
 * what this file is for, is the handful of claims that are specific to a racing
 * game and would otherwise be nobody's job:
 *
 *  - THE TRACK IS A PURE FUNCTION OF DISTANCE. This is the determinism-critical
 *    part of this rite. Sampled at 500 arbitrary distances, in a shuffled order,
 *    two instances on one seed must agree to the bit — because that is the only
 *    thing making two players in one room drive the same course.
 *  - GATES CREDIT ONLY FROM INSIDE, which is the rule the whole idle score rests
 *    on. Both halves are asserted: an unattended car CROSSES nearly every gate
 *    line, and is CREDITED with almost none of them.
 *  - A LANDED BOMB CHANGES THE STANDINGS. `applyPenalty` is the only write into
 *    `RivalSource` in the whole game, and if it does not move a result it is a
 *    particle effect with extra steps.
 *  - THE CHARGES ARE FINITE. Three boosts, two bombs, however hard the button is
 *    held.
 *  - `draw()` DOES NOT MUTATE. Enforced against a stub painter rather than a
 *    canvas, so this file stays in the `node` environment.
 *
 * node env (vitest.config.js default): this rite imports only `contract.js`,
 * `Rng.js` and `rivals.js`, none of which touch the DOM.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput } from '../../src/minigames/contract.js';
import { mulberry32 } from '../../src/core/Rng.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { assertRiteContract } from './helpers/rite-contract.js';
import {
  OFFROAD_RITE, RAND_CALLS, DURATION, TRACK_LEN, FLAG_AT, GATE_COUNT, COIN_COUNT,
  RIVAL_COUNT, BOOST_CHARGES, BOMB_CHARGES, HALF_W,
} from '../../src/minigames/rites/OffroadRite.js';

const DT = MINIGAMES.dt;
const STEP_CAP = Math.ceil(DURATION / DT) + 1;

function spawn(seed = 1234, wave = 8, occurrence = 0) {
  const inst = OFFROAD_RITE.create();
  inst.init({
    rand: riteRng(seed, OFFROAD_RITE.id, occurrence),
    wave, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/** Run a closed loop the way the host does, capped at the rite's own clock. */
function play(strategy, { seed = 1234, wave = 8 } = {}) {
  const inst = spawn(seed, wave);
  for (let n = 0; n < STEP_CAP; n++) {
    if (inst.update(DT, strategy(inst, n)) === true) break;
    inst.drainEvents?.();
  }
  return inst;
}

/**
 * A driver: aim at the next nugget, fall back to the next gate, boost only while
 * on the road, and drop a mine when a rival is behind and the car is on the line.
 *
 * WRITTEN AGAINST THE GAME'S PUBLIC SURFACE ONLY (`s`, `coins`, `gates`,
 * `centreAt`, `rivalDist`) so it is a player rather than a second copy of the
 * physics. It aims 2.2 units FURTHER ALONG the line than the thing it wants,
 * which is how a human copes with a car that does not self-centre: lead the
 * corner instead of chasing it.
 */
function driver({ bombs = true, boost = 'fast' } = {}) {
  return (inst) => {
    const cam = inst.centreAt(inst.s);
    const u = inst.x - cam;

    let target = null;
    for (const c of inst.coins) {
      if (c.taken || c.s < inst.s) continue;
      if (c.s - inst.s > 9) break;
      target = { s: c.s, u: c.u };
      break;
    }
    if (!target) {
      const g = inst.gates[inst.nextGate];
      target = g ? { s: g.s, u: 0 } : { s: inst.s + 5, u: 0 };
    }

    // WHERE, NOT WHETHER. A charge is worth BOOST_MUL inside a fast stretch and
    // barely anything outside one, so the author's bot reads the road and holds
    // the button until the car is standing in one. `boost: 'mash'` is the same
    // driver with that one line removed, and the pair is what the ablation
    // measures — see the "spending a boost well" block below.
    const ready = inst.boostT <= 0 && inst.boostLeft > 0 && Math.abs(u) < HALF_W;
    const wantBoost = boost === 'never' ? false
      : boost === 'mash' ? true
      : ready && inst.isFast(inst.s);

    let bomb = false;
    if (bombs && inst.bombsLeft > 0 && Math.abs(u) < 0.35) {
      for (let id = 0; id < RIVAL_COUNT; id++) {
        // A mine sits BEHIND the car, so only a rival that has not reached it
        // yet can ever cross it. Three units of clearance covers MINE_BACK.
        if (inst.s - inst.rivalDist(id, inst.t) > 3) { bomb = true; break; }
      }
    }

    return makeInput({
      x: inst.centreAt(target.s + 2.2) + target.u - cam,
      y: 0,
      inside: true,
      action: wantBoost ? 1 : 0,
      altAction: bomb ? 1 : 0,
    });
  };
}

/**
 * A painter that records nothing and draws nothing.
 *
 * `Painter` needs a live CanvasRenderingContext2D and this file runs in node, so
 * the purity check gets a stub with the same SHAPE: every method chains, and
 * `linearFill` returns a sentinel rather than undefined, because a rite is
 * entitled to pass that straight back as a fill. If `draw` ever reaches for a
 * primitive that is not here, the test fails loudly with the missing name —
 * which is the right failure, not a silent pass.
 */
function stubPainter() {
  const g = {};
  const chain = [
    'save', 'restore', 'alpha', 'add', 'translate', 'rotate', 'scale', 'glow',
    'noGlow', 'circle', 'arc', 'rect', 'line', 'poly', 'blob', 'ellipse',
    'capsule', 'halo', 'text', 'clear',
  ];
  for (const m of chain) g[m] = () => g;
  g.linearFill = () => '<gradient>';
  g.clipRect = (_cx, _cy, _w, _h, fn) => { fn(g); return g; };
  // `clipField` is `clipRect` over the whole field and this rite wraps its ENTIRE
  // world layer in it. The stub has to run the callback rather than swallow it,
  // or the purity check above would be asserting about an empty function.
  g.clipField = (fn) => { fn(g); return g; };
  return g;
}

/** A structural clone, for the mutation checks. Handles the typed array in SeededRivals. */
function snap(o, depth = 0, seen = new Set()) {
  if (o === null || typeof o !== 'object') {
    return typeof o === 'number' && !Number.isFinite(o) ? String(o) : o;
  }
  if (seen.has(o) || depth > 5) return '[deep]';
  seen.add(o);
  if (Array.isArray(o) || ArrayBuffer.isView(o)) return Array.from(o, (v) => snap(v, depth + 1, seen));
  const out = {};
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'function') continue;
    out[k] = snap(o[k], depth + 1, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('offroad rite — the shared contract', () => {
  it('passes assertRiteContract', () => {
    // The rand budget is the literal an author has to keep in step with the
    // draws; see RAND_CALLS in the rite for what each one buys.
    assertRiteContract(OFFROAD_RITE, { randCalls: 58, skilled: driver() });
  });

  it('declares the rand budget it actually spends', () => {
    // 3 track phases + 12 gate widths + 30 nugget offsets + 3x4 rivals + 1 seed.
    expect(RAND_CALLS).toBe(58);
  });

  it('is 26 seconds — the longest of the six', () => {
    expect(OFFROAD_RITE.duration).toBe(DURATION);
    expect(DURATION).toBe(26);
  });
});

describe('offroad rite — the track is a pure function of distance', () => {
  it('two instances on one seed agree at 500 distances', () => {
    const a = spawn(4242, 18);
    const b = spawn(4242, 18);
    // Shuffled, and each generator asked out of order, because "pure" means the
    // answer cannot depend on what was asked before it. A track built by
    // integrating a heading would pass a forward sweep and fail this.
    const rng = mulberry32(11);
    const order = Array.from({ length: 500 }, () => rng() * (TRACK_LEN + 40) - 20);
    for (const s of order) {
      expect(a.centreAt(s)).toBe(b.centreAt(s));
      expect(a.slopeAt(s)).toBe(b.slopeAt(s));
    }
    // ...and asking `a` again, after `b` has been driven a while, still agrees.
    for (let n = 0; n < 300; n++) b.update(DT, makeInput({ inside: true, x: 3 }));
    for (const s of order.slice(0, 120)) expect(a.centreAt(s)).toBe(b.centreAt(s));
  });

  it('a different seed is a different course', () => {
    const a = spawn(1, 18);
    const b = spawn(2, 18);
    let differing = 0;
    for (let i = 0; i < 500; i++) {
      const s = (i / 500) * TRACK_LEN;
      if (Math.abs(a.centreAt(s) - b.centreAt(s)) > 0.05) differing++;
    }
    expect(differing).toBeGreaterThan(400);
  });

  it('the derivative is the derivative — a wrong sign would invert every corner', () => {
    const a = spawn(77, 30);
    const h = 1e-5;
    for (let s = 0; s < TRACK_LEN; s += 7.3) {
      const fd = (a.centreAt(s + h) - a.centreAt(s - h)) / (2 * h);
      expect(a.slopeAt(s)).toBeCloseTo(fd, 6);
    }
  });
});

describe('offroad rite — gates credit only from inside', () => {
  /**
   * THE TWO HALVES OF THE RULE, and the second is the one that matters.
   *
   * The throttle is automatic, so an unattended car still drives and still
   * REACHES the gates. If reaching one counted, "start the rite and look away"
   * would pay; the plan measured that alternative at ~0.4. Crediting only the
   * inside — plus a car that does not hold its own line — makes it pay nothing.
   */
  it('an idle car crosses most gate lines and is credited with almost none', () => {
    for (const wave of [3, 23, 53]) {
      for (const seed of [1, 7, 42, 99, 1234, 4242, 90210, 31337, 555, 8]) {
        const inst = play(() => makeInput(), { seed, wave });
        const where = `seed ${seed} wave ${wave}`;
        // FOUR, NOT SEVEN, AND THE NUMBER MOVED FOR A REASON RATHER THAN TO GO
        // GREEN. The course is 217 units now instead of 158 (see TRACK_LEN) and
        // the scrub is deeper (DIRT_MUL), so an unattended car covers a smaller
        // FRACTION of a longer track and reaches fewer gate LINES than it used
        // to. The claim this assertion exists to make is untouched: the idle car
        // still arrives at a third to a half of the gates and is credited with
        // at most one of them.
        expect(inst.gatesPassed, `${where}: an idle car should still REACH gates`)
          .toBeGreaterThanOrEqual(4);
        expect(inst.gatesHit, `${where}: an idle car was credited ${inst.gatesHit} gates`)
          .toBeLessThanOrEqual(1);
      }
    }
  });

  it('a car held hard to one side passes the lines and scores zero', () => {
    // Full lock right for the whole race: it crosses gate lines and takes none.
    const inst = play(() => makeInput({ axis: { x: 1, y: 0 } }), { seed: 31337, wave: 12 });
    expect(inst.gatesPassed).toBeGreaterThanOrEqual(4);
    expect(inst.gatesHit).toBe(0);
    expect(inst.coinsTaken).toBe(0);
    expect(inst.score().ratio).toBe(0);
  });

  it('a car that holds the line is credited, so the rule is not just "nobody scores"', () => {
    const inst = play(driver(), { seed: 31337, wave: 12 });
    expect(inst.gatesHit).toBeGreaterThanOrEqual(8);
    expect(inst.gatesHit).toBeLessThanOrEqual(GATE_COUNT);
    expect(inst.coinsTaken).toBeGreaterThanOrEqual(12);
    expect(inst.score().ratio).toBeGreaterThan(0.6);
  });

  it('running a gate wide costs speed as well as the credit', () => {
    const clean = play(driver(), { seed: 909, wave: 20 });
    const wide = play(() => makeInput({ axis: { x: 1, y: 0 } }), { seed: 909, wave: 20 });
    expect(wide.s).toBeLessThan(clean.s);
  });
});

describe('offroad rite — the idle band', () => {
  /**
   * Measured across 10 seeds x 3 waves rather than asserted on one. A number
   * that holds on a single seed is not a number: an earlier build of this rite
   * averaged 0.06 idle and still paid 0.38 on one seed in a few hundred, because
   * the course happened to wander back through the level the car started at.
   */
  it('doing nothing pays a rounding error on every seed and wave', () => {
    let worst = 0;
    for (const wave of [3, 23, 53]) {
      for (const seed of [1, 7, 42, 99, 1234, 4242, 90210, 31337, 555, 8]) {
        const s = play(() => makeInput(), { seed, wave }).score();
        expect(s.ratio, `idle at seed ${seed} wave ${wave} scored ${s.ratio.toFixed(3)}`)
          .toBeLessThan(0.12);
        worst = Math.max(worst, s.ratio);
      }
    }
    // Pinned so an "improvement" that quietly makes idling pay shows up here.
    expect(worst).toBeLessThan(0.12);
  });

  it('an idle car finishes last and never reaches the flag', () => {
    const inst = play(() => makeInput(), { seed: 5, wave: 23 });
    expect(inst.finished).toBe(false);
    expect(inst.s).toBeLessThan(TRACK_LEN);
    expect(inst.beaten).toBe(0);
    expect(inst.score().detail).toContain(`4th of ${RIVAL_COUNT + 1}`);
  });
});

describe('offroad rite — the bomb is the one write into RivalSource', () => {
  it('a landed bomb changes the final standings', () => {
    // Seed 34 / wave 43 is a race the player is losing by one place. Two runs,
    // the SAME driving script, differing only in whether the two mines are laid.
    const bombed = play(driver({ bombs: true }), { seed: 34, wave: 43 });
    const control = play(driver({ bombs: false }), { seed: 34, wave: 43 });

    expect(bombed.bombHits, 'the mines never caught anybody').toBeGreaterThan(0);
    expect(control.bombHits).toBe(0);
    // Same driving, so the parts of the score the bomb does not touch must be
    // identical — otherwise this compares two different races.
    expect(bombed.gatesHit).toBe(control.gatesHit);
    expect(bombed.coinsTaken).toBe(control.coinsTaken);
    // ...and the part it does touch moved.
    expect(bombed.beaten).toBeGreaterThan(control.beaten);
    expect(bombed.place).toBeLessThan(control.place);
    expect(bombed.score().ratio).toBeGreaterThan(control.score().ratio);
  });

  it('the penalty lands on the rival, not on the scoreboard', () => {
    // The mechanism, not the outcome: the caught rival is genuinely further back
    // for the rest of the race, through SeededRivals.positionAt and nothing else.
    const bombed = play(driver({ bombs: true }), { seed: 34, wave: 43 });
    const control = play(driver({ bombs: false }), { seed: 34, wave: 43 });
    // Swept rather than sampled at the whistle: `positionAt` clamps at 1, so a
    // rival who finished before the clock reads 1.0 in both runs and the penalty
    // hides behind the ceiling. It shows up everywhere BEFORE that.
    let moved = 0;
    for (let id = 0; id < RIVAL_COUNT; id++) {
      let behind = false;
      for (let t = 4; t <= DURATION; t += 0.5) {
        if (bombed.rivalProgress(id, t) < control.rivalProgress(id, t) - 1e-9) { behind = true; break; }
      }
      if (behind) moved++;
    }
    expect(moved).toBe(bombed.bombHits);
  });

  it('laying a mine never makes the standings worse', () => {
    // The weak but universal version of the claim above, over a spread of races.
    for (const seed of [1, 2, 3, 11, 42, 909]) {
      for (const wave of [13, 33, 53]) {
        const bombed = play(driver({ bombs: true }), { seed, wave });
        const control = play(driver({ bombs: false }), { seed, wave });
        expect(bombed.beaten, `seed ${seed} wave ${wave}: bombing lost a place`)
          .toBeGreaterThanOrEqual(control.beaten);
      }
    }
  });

  it('one mine takes at most one rival', () => {
    const inst = play(driver({ bombs: true }), { seed: 34, wave: 43 });
    expect(inst.bombHits).toBeLessThanOrEqual(BOMB_CHARGES);
  });
});

describe('offroad rite — the charges are finite', () => {
  it('three boosts and two bombs, however hard the buttons are held', () => {
    const inst = play(() => makeInput({
      inside: true, x: 0, action: 3, altAction: 3, slots: [3, 0, 0, 0, 0, 0],
    }), { seed: 17, wave: 30 });
    expect(inst.boostLeft).toBe(0);
    expect(inst.bombsLeft).toBe(0);
    expect(inst.mines.length).toBe(BOMB_CHARGES);
    expect(BOOST_CHARGES).toBe(3);
    expect(BOMB_CHARGES).toBe(2);
  });

  it('a boost pressed while boosting costs no charge', () => {
    // Forgiving by design: a double click must not silently burn a third of the
    // supply. Two presses one step apart are one boost.
    const inst = spawn(3, 10);
    inst.update(DT, makeInput({ inside: true, x: 0, action: 1 }));
    inst.update(DT, makeInput({ inside: true, x: 0, action: 1 }));
    expect(inst.boostLeft).toBe(BOOST_CHARGES - 1);
  });

  it('the bomb answers Digit1 as well as the right button', () => {
    const key = spawn(3, 10);
    key.update(DT, makeInput({ inside: true, slots: [1, 0, 0, 0, 0, 0] }));
    expect(key.bombsLeft).toBe(BOMB_CHARGES - 1);

    const rmb = spawn(3, 10);
    rmb.update(DT, makeInput({ inside: true, altAction: 1 }));
    expect(rmb.bombsLeft).toBe(BOMB_CHARGES - 1);
  });

  it('a right click never spends a boost, and a left click never spends a bomb', () => {
    const inst = spawn(3, 10);
    inst.update(DT, makeInput({ inside: true, altAction: 1 }));
    expect(inst.boostLeft).toBe(BOOST_CHARGES);
    const other = spawn(3, 10);
    other.update(DT, makeInput({ inside: true, action: 1 }));
    expect(other.bombsLeft).toBe(BOMB_CHARGES);
  });
});

describe('offroad rite — draw() does not mutate state', () => {
  it('is a read-only pass, at every interpolation fraction', () => {
    const inst = spawn(808, 27);
    const drive = driver();
    const g = stubPainter();
    for (let n = 0; n < 700; n++) {
      if (inst.update(DT, drive(inst, n)) === true) break;
      inst.drainEvents?.();
    }
    const before = snap(inst);
    for (const alpha of [0, 0.25, 0.5, 0.999, 1]) inst.draw(g, alpha);
    inst.draw(g);                     // and with alpha omitted entirely
    expect(snap(inst), 'draw() moved something').toEqual(before);
    // Nothing queued either: a draw that pushes a cue plays a sound per frame.
    expect(inst.drainEvents()).toEqual([]);
  });

  it('draws a fresh instance and a finished one without reaching for anything missing', () => {
    const g = stubPainter();
    expect(() => spawn(9, 4).draw(g, 0)).not.toThrow();
    // Seed 20 is one of the courses a coin-chasing driver can still get to the
    // flag on — most are not, by design (see FLAG_AT).
    const done = play(driver(), { seed: 20, wave: 3 });
    expect(done.finished).toBe(true);
    expect(() => done.draw(g, 0.5)).not.toThrow();
  });
});

describe('offroad rite — the score is the blend, itemised', () => {
  it('weights gates 0.45, gold 0.35 and the field 0.20', () => {
    const inst = play(driver(), { seed: 4242, wave: 15 });
    const expected = 0.45 * (inst.gatesHit / GATE_COUNT)
      + 0.35 * (inst.coinsTaken / COIN_COUNT)
      + 0.20 * (inst.beaten / RIVAL_COUNT);
    expect(inst.score().ratio).toBeCloseTo(expected, 12);
  });

  it('the result card spells out the three parts', () => {
    const inst = play(driver(), { seed: 4242, wave: 15 });
    const { detail } = inst.score();
    expect(detail).toMatch(/^\d+\/12 gates · \d+ gold · (1st|2nd|3rd|4th) of 4$/);
    expect(detail).toContain(`${inst.gatesHit}/12 gates`);
    expect(detail).toContain(`${inst.coinsTaken} gold`);
  });

  it('is monotone in skill: better driving never scores worse', () => {
    const idle = play(() => makeInput(), { seed: 55, wave: 22 }).score().ratio;
    const mash = play(() => makeInput({
      inside: true, x: 0, down: true, action: 1, altAction: 1,
    }), { seed: 55, wave: 22 }).score().ratio;
    const good = play(driver(), { seed: 55, wave: 22 }).score().ratio;
    expect(idle).toBeLessThan(good);
    expect(mash).toBeLessThan(good);
  });

  it('score() is safe to call before the first step', () => {
    const s = spawn(1, 5).score();
    expect(s.ratio).toBe(0);
    expect(s.headline).toBe('Did not start');
  });
});

describe('offroad rite — the definition', () => {
  it('publishes its dressing, including the cursor that says "steered, not aimed"', () => {
    expect(OFFROAD_RITE.id).toBe('offroad');
    expect(OFFROAD_RITE.theme).toBe('offroad');
    expect(OFFROAD_RITE.cursor).toBe('default');
    expect(typeof OFFROAD_RITE.abandonNote).toBe('string');
    expect(OFFROAD_RITE.hint.length).toBeLessThan(80);
  });

  it('emits a start cue on the first step and a boom when a mine catches', () => {
    const inst = spawn(34, 43);
    const first = inst.drainEvents();
    expect(first.some((e) => e.type === 'start')).toBe(true);

    const drive = driver();
    let sawBoom = false, sawGold = false;
    for (let n = 0; n < STEP_CAP; n++) {
      const done = inst.update(DT, drive(inst, n)) === true;
      for (const e of inst.drainEvents()) {
        if (e.type === 'boom') sawBoom = true;
        if (e.type === 'gold') sawGold = true;
      }
      if (done) break;
    }
    expect(sawBoom).toBe(true);
    expect(sawGold).toBe(true);
  });
});

describe('offroad rite — spending a boost well beats spending it at all', () => {
  /**
   * THE ABLATION, AS AN ASSERTION.
   *
   * The previous build advertised `BOOST_DIRT_MUL` as "the one line that makes
   * boost a decision rather than a button to mash on frame one" and it was not
   * true: measured over 40 seeds, mashing the charges on cooldown scored 0.858 /
   * 0.818 / 0.714 at waves 3 / 28 / 53 against 0.858 / 0.817 / 0.712 for spending
   * them "thoughtfully" — the same run to three decimals. The claim was in a
   * docblock and nothing checked it, which is exactly how a claim stays wrong.
   *
   * So it is checked. Twelve seeds rather than forty (a unit suite has a budget)
   * and the margin required is deliberately well under the measured one, because
   * this is a claim about an ORDERING and not a pin on a number that will drift
   * every time the course is tuned.
   */
  const ABLATION_SEEDS = [1, 7, 42, 99, 1234, 4242, 90210, 31337, 555, 8, 909, 2468];

  const mean = (opts, wave) => ABLATION_SEEDS
    .reduce((a, seed) => a + play(driver(opts), { seed, wave }).score().ratio, 0)
    / ABLATION_SEEDS.length;

  it('reading the road beats mashing the button, at every wave', () => {
    for (const wave of [3, 28, 53]) {
      const fast = mean({}, wave);
      const mash = mean({ boost: 'mash' }, wave);
      expect(fast - mash, `wave ${wave}: spending the charges inside a fast `
        + `stretch scored ${fast.toFixed(3)} and mashing them on cooldown scored `
        + `${mash.toFixed(3)}. If that gap is not real, the boost is a button and `
        + `not a decision — which is precisely what the last build shipped.`)
        .toBeGreaterThan(0.01);
    }
  });

  it('...and mashing still beats never pressing it, which is the other half', () => {
    // A rule that made a mistimed boost WORSE than no boost would be a trap
    // rather than a decision: the player who experiments would be punished below
    // the player who ignored the mechanic. A cold boost is weak, never negative.
    for (const wave of [3, 28, 53]) {
      const mash = mean({ boost: 'mash' }, wave);
      const never = mean({ boost: 'never' }, wave);
      expect(mash, `wave ${wave}: mashing ${mash.toFixed(3)} vs never boosting `
        + `${never.toFixed(3)} — a wasted charge must cost less than an unused one`)
        .toBeGreaterThanOrEqual(never - 0.005);
    }
  });

  it('a charge lit outside a fast stretch covers visibly less ground', () => {
    // The mechanism under the two statistics above, isolated: one seed, one
    // course, the same car, the charge lit in the two different places.
    const hot = spawn(4242, 12);
    const cold = spawn(4242, 12);
    // Drive both to the start of the first fast stretch, holding the line.
    const zone = hot.fastZones[0];
    const hold = (inst) => makeInput({ inside: true, x: 0, y: 0 });
    while (hot.s < zone.s0 + 0.5) { hot.update(DT, hold(hot)); hot.drainEvents(); }
    while (cold.s < zone.s0 + 0.5) { cold.update(DT, hold(cold)); cold.drainEvents(); }
    expect(hot.s).toBeCloseTo(cold.s, 9);
    hot.update(DT, makeInput({ inside: true, x: 0, action: 1 }));
    cold.update(DT, hold(cold));
    expect(hot.boostHot, 'the first fast zone did not read as fast').toBe(true);
    for (let n = 0; n < 90; n++) { hot.update(DT, hold(hot)); cold.update(DT, hold(cold)); }
    const gain = hot.s - cold.s;

    const late = spawn(4242, 12);
    while (late.s < zone.s1 + 3) { late.update(DT, hold(late)); late.drainEvents(); }
    const before = spawn(4242, 12);
    while (before.s < zone.s1 + 3) { before.update(DT, hold(before)); before.drainEvents(); }
    late.update(DT, makeInput({ inside: true, x: 0, action: 1 }));
    before.update(DT, hold(before));
    expect(late.boostHot, 'a charge lit past the zone should be cold').toBe(false);
    for (let n = 0; n < 90; n++) { late.update(DT, hold(late)); before.update(DT, hold(before)); }
    const coldGain = late.s - before.s;

    expect(gain).toBeGreaterThan(coldGain * 2);
    expect(coldGain).toBeGreaterThan(0);           // never a punishment
  });

  it('the fast stretches are a property of the seed, not of the run', () => {
    // They are cached in init and read every press, so they had better be the
    // same answer the track gives — otherwise the lit panel on screen and the
    // rule the press resolves against are two different things.
    for (const wave of [3, 28, 53]) {
      const inst = spawn(4242, wave);
      for (const z of inst.fastZones) {
        expect(z.s1 - z.s0).toBeGreaterThanOrEqual(4);
        expect(inst.isFast((z.s0 + z.s1) / 2)).toBe(true);
      }
      // And there are fewer of them the harder the wave, which is the whole
      // wave scaling of this verb.
      expect(inst.fastZones.length).toBeGreaterThan(0);
    }
    const easy = spawn(4242, 3).fastZones.reduce((a, z) => a + z.s1 - z.s0, 0);
    const hard = spawn(4242, 53).fastZones.reduce((a, z) => a + z.s1 - z.s0, 0);
    expect(hard).toBeLessThan(easy);
  });
});

describe('offroad rite — missing a gate is visible', () => {
  it('records which gates were run wide, and flashes when one is', () => {
    // The rule "gates credit only from inside" is what holds the idle score at
    // nothing, and the last build fired it in total silence: GATES 1/12 with gate
    // 6 on screen and no mark anywhere on the frame. `missedGates` is what the
    // permanent cross is drawn from and `_missFlash` is the loud half.
    const inst = play(() => makeInput({ axis: { x: 1, y: 0 } }), { seed: 31337, wave: 12 });
    expect(inst.gatesHit).toBe(0);
    expect(inst.missedGates.length).toBe(inst.gatesPassed);
    // Every entry is a real gate index, in order, and never repeated.
    for (let i = 1; i < inst.missedGates.length; i++) {
      expect(inst.missedGates[i]).toBeGreaterThan(inst.missedGates[i - 1]);
    }
    expect(inst.missedGates.length).toBeLessThanOrEqual(GATE_COUNT);
  });

  it('a clean pass records no miss', () => {
    const inst = play(driver(), { seed: 31337, wave: 12 });
    expect(inst.missedGates.length).toBe(inst.gatesPassed - inst.gatesHit);
  });
});

describe('offroad rite — occurrence mirrors the course and nothing else', () => {
  /**
   * `ctx.occurrence` is allowed to change the SHAPE of a rite and forbidden to
   * change its difficulty (docs/MINIGAMES.md §4). A reflection is the largest
   * change that provably cannot: it is an isometry, so every corner radius,
   * every lateral rate and every gate width is preserved exactly.
   */
  // Both instances are built from the SAME rand stream and differ only in the
  // `occurrence` field, which isolates the mirror from the fact that the host
  // also re-seeds `riteRng` per occurrence. Testing `spawn(seed, wave, 1)`
  // against `spawn(seed, wave, 0)` would compare two unrelated courses and prove
  // nothing about the reflection.
  const mirrorPair = (seed, wave) => [0, 1].map((occ) => {
    const inst = OFFROAD_RITE.create();
    inst.init({
      rand: riteRng(seed, OFFROAD_RITE.id, 0),
      wave, occurrence: occ, width: FIELD.w, height: FIELD.h, quality: 'high',
    });
    return inst;
  });

  it('the second visit is the first one in a mirror', () => {
    const [a, b] = mirrorPair(4242, 18);
    for (let s = 0; s < TRACK_LEN; s += 3.1) {
      expect(b.centreAt(s)).toBeCloseTo(-a.centreAt(s), 9);
      expect(b.slopeAt(s)).toBeCloseTo(-a.slopeAt(s), 9);
    }
    // The gates land on the same distances with the same widths — an apex is an
    // apex whichever way the corner turns — and the gold mirrors with the road.
    for (let i = 0; i < GATE_COUNT; i++) {
      expect(b.gates[i].s).toBeCloseTo(a.gates[i].s, 9);
      expect(b.gates[i].hw).toBeCloseTo(a.gates[i].hw, 12);
    }
    for (let i = 0; i < COIN_COUNT; i++) {
      expect(b.coins[i].s).toBeCloseTo(a.coins[i].s, 9);
      expect(b.coins[i].u).toBeCloseTo(-a.coins[i].u, 12);
    }
    // ...and it costs no randomness, so the roster is untouched.
    expect(b.rivals.roster().map((r) => r.name)).toEqual(a.rivals.roster().map((r) => r.name));
  });

  it('a mirrored driver scores exactly what the original did', () => {
    // The difficulty claim, executed rather than asserted: the same bot with its
    // steering reflected produces the same race.
    const mirrored = (inst) => {
      const cam = inst.centreAt(inst.s);
      let target = null;
      for (const c of inst.coins) {
        if (c.taken || c.s < inst.s) continue;
        if (c.s - inst.s > 9) break;
        target = { s: c.s, u: c.u };
        break;
      }
      if (!target) {
        const g = inst.gates[inst.nextGate];
        target = g ? { s: g.s, u: 0 } : { s: inst.s + 5, u: 0 };
      }
      return makeInput({ x: inst.centreAt(target.s + 2.2) + target.u - cam, y: 0, inside: true });
    };
    for (const seed of [1, 42, 4242]) {
      const runs = mirrorPair(seed, 18).map((inst) => {
        for (let n = 0; n < STEP_CAP; n++) {
          if (inst.update(DT, mirrored(inst)) === true) break;
          inst.drainEvents?.();
        }
        return inst;
      });
      const [a, b] = runs;
      expect(b.gatesHit, `seed ${seed}: the mirror is a different difficulty`).toBe(a.gatesHit);
      expect(b.coinsTaken).toBe(a.coinsTaken);
      expect(b.score().ratio).toBeCloseTo(a.score().ratio, 12);
    }
  });
});

describe('offroad rite — the flag is reachable and not free', () => {
  it('a driver who races rather than collects can take it', () => {
    // FLAG_AT exists because at TRACK_LEN exactly nobody ever crossed the line
    // and the whole finisher branch of the standings was dead code.
    const sprint = (inst) => makeInput({
      inside: true, y: 0,
      x: inst.centreAt(inst.s + 2.2) - inst.centreAt(inst.s),
      action: inst.boostT <= 0 && inst.boostLeft > 0 && inst.isFast(inst.s) ? 1 : 0,
    });
    let finished = 0;
    for (const seed of [1, 7, 42, 99, 1234, 4242, 90210, 31337, 555, 8, 909, 2468]) {
      if (play(sprint, { seed, wave: 3 }).finished) finished++;
    }
    expect(finished, 'nobody can reach the flag — the finish line is a painting')
      .toBeGreaterThan(0);
    expect(FLAG_AT).toBeLessThan(TRACK_LEN);
  });
});
