/**
 * ONE CHECKLIST, EVERY RITE.
 *
 * `assertRiteContract(def)` runs the list of things that must be true of ANY
 * minigame — determinism, a fixed randomness budget, an idle run that ends and
 * pays nothing, a purity guarantee on score(), no unbounded growth — against
 * whatever definition it is handed.
 *
 * WHY THIS FILE EXISTS RATHER THAN SIX COPIES OF THE SAME EIGHT TESTS. Six rites
 * are written by six people at six moments. Without a shared harness, the first
 * one gets a careful suite, the fourth gets the three assertions its author
 * remembered, and the sixth gets whatever fit in the time left — and the whole
 * point of the contract in `src/minigames/contract.js` is that a rite the host
 * can run is a rite the host can run SAFELY. Eight assertions times six rites
 * for the price of one file, and a new rite is compliant on the day it is
 * written rather than after the first bug report.
 *
 * NOT collected by vitest: only `tests/unit/**\/*.test.js` is (vitest.config.js),
 * so this is a helper, not a suite. Call it from inside an `it()`.
 *
 * EVERY FAILURE MESSAGE NAMES THE RITE AND THE RULE. A bare "expected 0.3 to be
 * less than 0.15" in a six-rite run tells the reader nothing about which rite
 * broke which promise, and a message nobody can act on is a test nobody trusts.
 */

import { expect } from 'vitest';
import { MINIGAMES } from '../../../src/core/Config.js';
import { mulberry32 } from '../../../src/core/Rng.js';
import { FIELD, makeInput, clickAt } from '../../../src/minigames/contract.js';
import { riteRng } from '../../../src/minigames/schedule.js';

const DT = MINIGAMES.dt;

/** The three waves the budget is checked at: first rite, middle, last. */
const WAVES = [3, 28, 53];

/**
 * A ratio no rite may exceed by mashing.
 *
 * Mashing is the universal degenerate strategy — press everything every frame —
 * and it is the one an automated player finds instantly. A rite it beats is a
 * rite with no skill in it, whatever its author intended. 0.6 is deliberately
 * generous: this is a floor under "there is some skill here", not a tuning knob.
 * A rite that wants the stronger claim passes `skilled` and gets it compared
 * directly.
 */
const MASH_CEILING = 0.6;

/** What an idle run must stay under. Below it, the payout is a rounding error. */
const IDLE_CEILING = 0.15;

/** Steps of fuzz. 1 500 is 25 s at 60 Hz — longer than any rite's clock. */
const FUZZ_STEPS = 1500;

/** Build a live instance without a host. */
function spawn(def, { seed = 1234, occurrence = 0, wave = 8, rand = null } = {}) {
  const inst = def.create();
  inst.init({
    rand: rand ?? riteRng(seed, def.id, occurrence),
    wave, occurrence, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/**
 * Run a closed loop, exactly as docs/MINIGAMES.md tells a rite author to.
 *
 * Capped at the rite's own clock, because that is what MinigameHost does: a rite
 * that never returns true is ended by the host at `duration`, so a test that ran
 * longer would be testing a situation no player can reach.
 */
function play(def, strategy, o = {}) {
  const inst = spawn(def, o);
  const cap = Math.ceil(def.duration / DT) + 1;
  let steps = 0;
  let ended = false;
  for (; steps < cap; steps++) {
    if (inst.update(DT, strategy(inst, steps)) === true) { ended = true; steps++; break; }
    inst.drainEvents?.();
  }
  return { inst, steps, ended, score: inst.score() };
}

/**
 * A structural snapshot of an instance's own state.
 *
 * Used for the purity check and for the growth check. Depth- and cycle-limited
 * because a rite may legitimately hold nested particle records, and a helper
 * that stack-overflows on a legal rite is a helper that gets deleted.
 */
function snapshot(o, depth = 0, seen = new Set()) {
  if (o === null || typeof o !== 'object') {
    return typeof o === 'number' && !Number.isFinite(o) ? String(o) : o;
  }
  if (seen.has(o) || depth > 4) return '[deep]';
  seen.add(o);
  if (Array.isArray(o) || ArrayBuffer.isView(o)) {
    return Array.from(o, (v) => snapshot(v, depth + 1, seen));
  }
  const out = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'function') continue;
    out[k] = snapshot(v, depth + 1, seen);
  }
  return out;
}

/** Total number of array slots the instance is holding, at any depth. */
function arrayLoad(o, depth = 0, seen = new Set()) {
  if (o === null || typeof o !== 'object' || seen.has(o) || depth > 4) return 0;
  seen.add(o);
  let n = 0;
  if (Array.isArray(o) || ArrayBuffer.isView(o)) {
    n += o.length;
    if (Array.isArray(o)) for (const v of o) n += arrayLoad(v, depth + 1, seen);
    return n;
  }
  for (const k of Object.keys(o)) n += arrayLoad(o[k], depth + 1, seen);
  return n;
}

/** Walk a score record and fail on anything that is not a finite number in range. */
function assertScoreShape(id, rule, s) {
  expect(s, `[${id}] ${rule}: score() returned nothing`).toBeTruthy();
  expect(Number.isFinite(s.ratio), `[${id}] ${rule}: ratio is ${s.ratio}, not a finite number`).toBe(true);
  expect(s.ratio, `[${id}] ${rule}: ratio below 0`).toBeGreaterThanOrEqual(0);
  expect(s.ratio, `[${id}] ${rule}: ratio above 1`).toBeLessThanOrEqual(1);
  expect(typeof s.headline, `[${id}] ${rule}: headline must be a string`).toBe('string');
}

// ---------------------------------------------------------------------------

/**
 * @param {import('../../../src/minigames/contract.js').MinigameDef} def
 * @param {object} o
 * @param {number} o.randCalls  The EXACT number of ctx.rand() calls init makes.
 *   Required, and required to be a literal the author wrote down: the assertion
 *   is not "some fixed number" but "this number", so an accidental extra draw
 *   inside a loop bound is caught rather than absorbed.
 * @param {(inst: object, step: number) => object} [o.skilled]  A strategy that
 *   plays the rite properly. Optional, because it cannot be written generically
 *   — but supply it if you can: with it, mashing is compared against real play
 *   instead of against a ceiling.
 * @param {number} [o.mashCeiling]  Override MASH_CEILING for a rite where
 *   mashing legitimately gets somewhere (offroad's throttle is automatic, so
 *   spamming boost is not nothing). Raising it is a claim about the design and
 *   should be commented at the call site.
 */
export function assertRiteContract(def, { randCalls, skilled = null, mashCeiling = MASH_CEILING } = {}) {
  const id = def?.id ?? '<no id>';
  expect(typeof randCalls, `[${id}] assertRiteContract needs an explicit randCalls`).toBe('number');

  // ---- 0. the published shape ------------------------------------------
  expect(typeof def.create, `[${id}] def.create must be a function`).toBe('function');
  expect(def.duration, `[${id}] def.duration must be a positive number of seconds`).toBeGreaterThan(0);
  const probe = def.create();
  for (const m of ['init', 'update', 'draw', 'score']) {
    expect(typeof probe[m], `[${id}] rule "the contract": ${m}() is missing`).toBe('function');
  }
  expect(def.create(), `[${id}] rule "one instance per create": create() returned the same object twice`)
    .not.toBe(probe);

  // ---- 1. a fixed randomness budget, on every wave ----------------------
  // THE determinism rule (docs/MINIGAMES.md): two players on one seed must draw
  // the same numbers, so the COUNT of draws may never depend on the wave, the
  // quality preset or anything a player did. A rand() inside a conditional is
  // the classic way to break this and it is invisible until two clients
  // disagree about where the targets are.
  for (const wave of WAVES) {
    let calls = 0;
    spawn(def, { wave, rand: () => { calls++; return 0.5; } });
    expect(calls, `[${id}] rule "fixed rand budget": init() drew ${calls} values at wave ${wave}, expected ${randCalls}`)
      .toBe(randCalls);
  }

  // ---- 2. determinism: same seed, same script, same score ---------------
  // Scripted from a SEPARATE generator so the input sequence is identical by
  // construction rather than by reading the rite's own state (which would make
  // the two runs agree for the wrong reason).
  const script = (rng) => (_inst, step) => {
    const r = rng();
    return makeInput({
      x: (r * 2 - 1) * FIELD.hw,
      y: (rng() * 2 - 1) * FIELD.hh,
      inside: true,
      action: step % 23 === 0 ? 1 : 0,
      altAction: step % 31 === 0 ? 1 : 0,
      clicks: step % 23 === 0 ? [clickAt((r * 2 - 1) * FIELD.hw, 0, 0, 'pointer')] : [],
    });
  };
  const a = play(def, script(mulberry32(99)), { seed: 4242, wave: 18 });
  const b = play(def, script(mulberry32(99)), { seed: 4242, wave: 18 });
  expect(b.score, `[${id}] rule "determinism": same seed and same inputs produced a different score`)
    .toEqual(a.score);
  expect(b.steps, `[${id}] rule "determinism": same seed and same inputs took a different number of steps`)
    .toBe(a.steps);
  assertScoreShape(id, 'determinism', a.score);

  // ---- 3. an idle run ends on its own, and is worth nothing -------------
  // Both halves matter. "Ends" because a rite that waits for an input it never
  // gets hands the player a full clock of nothing; "worth nothing" because the
  // reward curve has no gate any more (contract.js minigameReward), so the only
  // thing keeping "start it and look away" unprofitable is the rite's own idle
  // score.
  const idle = play(def, () => makeInput(), { seed: 5, wave: 23 });
  expect(idle.steps, `[${id}] rule "an idle run terminates": it ran past its own clock`)
    .toBeLessThanOrEqual(Math.ceil(def.duration / DT) + 1);
  assertScoreShape(id, 'an idle run scores nothing', idle.score);
  expect(idle.score.ratio, `[${id}] rule "an idle run scores nothing": doing nothing scored ${idle.score.ratio.toFixed(3)}, over ${IDLE_CEILING}`)
    .toBeLessThan(IDLE_CEILING);

  // ---- 4. mashing is not a strategy -------------------------------------
  const mashRng = mulberry32(7);
  const mash = play(def, () => makeInput({
    x: (mashRng() * 2 - 1) * FIELD.hw,
    y: (mashRng() * 2 - 1) * FIELD.hh,
    inside: true, down: true, action: 1, altAction: 1,
    clicks: [clickAt((mashRng() * 2 - 1) * FIELD.hw, (mashRng() * 2 - 1) * FIELD.hh, 0, 'pointer')],
  }), { seed: 909, wave: 28 });
  assertScoreShape(id, 'mashing is not a strategy', mash.score);
  expect(mash.score.ratio, `[${id}] rule "mashing is not a strategy": pressing everything every frame scored ${mash.score.ratio.toFixed(3)}`)
    .toBeLessThanOrEqual(mashCeiling);
  if (skilled) {
    const good = play(def, skilled, { seed: 909, wave: 28 });
    expect(mash.score.ratio, `[${id}] rule "mashing is not a strategy": mashing (${mash.score.ratio.toFixed(3)}) matched or beat deliberate play (${good.score.ratio.toFixed(3)})`)
      .toBeLessThan(good.score.ratio);
  }

  // ---- 5. fuzz: finite, and bounded ------------------------------------
  // Longer than any rite's clock ON PURPOSE. The host stops at `duration`, but a
  // rite that only stays finite because something else stops it is a rite one
  // refactor away from a NaN, and one NaN in a draw call is a blank frame with
  // no error attached (docs/PITFALLS.md §9).
  const fz = mulberry32(31337);
  const inst = spawn(def, { seed: 17, wave: 43, occurrence: 3 });
  const load0 = arrayLoad(inst);
  for (let i = 0; i < FUZZ_STEPS; i++) {
    const x = (fz() * 2 - 1) * FIELD.hw;
    const y = (fz() * 2 - 1) * FIELD.hh;
    const hit = fz() < 0.08;
    inst.update(DT, makeInput({
      x, y, inside: fz() < 0.9, down: fz() < 0.3,
      action: hit ? 1 : 0,
      altAction: fz() < 0.04 ? 1 : 0,
      axis: { x: Math.round(fz() * 2 - 1), y: Math.round(fz() * 2 - 1) },
      clicks: hit ? [clickAt(x, y, fz() < 0.5 ? 0 : 2, 'pointer')] : [],
    }));
    inst.drainEvents?.();
  }
  assertScoreShape(id, 'fuzz stays finite', inst.score());
  const load1 = arrayLoad(inst);
  // A generous bound: particle pools breathe, and the number that matters is
  // "does it grow WITHOUT LIMIT". Anything under a few thousand slots after
  // 1 500 steps of abuse is a pool; 25x its starting load is a leak.
  expect(load1, `[${id}] rule "no unbounded growth": arrays held ${load0} slots after init and ${load1} after ${FUZZ_STEPS} fuzz steps`)
    .toBeLessThanOrEqual(Math.max(4000, load0 * 25));

  // ---- 6. score() is pure ----------------------------------------------
  // A score() that advances a counter, drains a queue or lazily resolves the
  // last target is a rite whose payout depends on how many times the host
  // happened to ask — and the host asks once, the result card asks again, and
  // tests ask constantly.
  const before = snapshot(inst);
  const s1 = inst.score();
  const s2 = inst.score();
  expect(s2, `[${id}] rule "score() is pure": two consecutive calls disagreed`).toEqual(s1);
  expect(snapshot(inst), `[${id}] rule "score() is pure": calling score() mutated the instance`)
    .toEqual(before);

  // ---- 7. drainEvents empties ------------------------------------------
  // Optional method, mandatory behaviour if present: a queue that is read
  // without being cleared plays the same sound on every frame for the rest of
  // the rite, which is the loudest bug in the catalogue.
  if (typeof inst.drainEvents === 'function') {
    inst.drainEvents();
    expect(inst.drainEvents(), `[${id}] rule "drainEvents empties": a second drain returned events`)
      .toEqual([]);
  }
}
