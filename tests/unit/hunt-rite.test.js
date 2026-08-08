/**
 * GAME HUNT — the rite's own facts.
 *
 * `assertRiteContract` covers everything TRUE OF ANY RITE (a fixed rand budget
 * on three waves, determinism, an idle run that terminates and pays nothing,
 * mashing losing to play, 1 500 steps of fuzz staying finite and bounded, a pure
 * score(), a drainEvents that empties). It is called once, first, and this file
 * does not repeat any of it.
 *
 * What is left is what makes this rite THIS rite, and each of these has a way of
 * being broken that the shared checklist cannot see:
 *
 *  - a shot into empty air SPOOKS the live animal (brake #2, and the whole
 *    anti-mash design — the checklist would only notice its absence as a mash
 *    score creeping up, and only if it crept past 0.6);
 *  - the 0.38 s RECOIL really blocks the second shot (brake #1);
 *  - `t < claimAt` is STRICT, so a shot on the step the deadline passes is a
 *    loss and a TIE IS NOT A STATE THIS RITE CAN BE IN;
 *  - at most one animal is contested at a time (the schedule's invariant, which
 *    a retune of WINDOW_MAX or of the rival source's spacing could break
 *    silently — the picture would still look fine);
 *  - THE ANIMAL DOES NOT MOVE WHILE IT IS LIVE. That one is the guard on the
 *    design risk the whole lot was flagged for: `fishing` is the LEADING shot
 *    and `hunt` is the REACTION shot, and if a well-meaning edit ever gives the
 *    animal a drift, two of the eleven rites in a run become the same game.
 *
 * node environment. No DOM, no three.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput, clickAt } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { mulberry32 } from '../../src/core/Rng.js';
import {
  HUNT_RITE, RAND_CALLS, ANIMALS, EXPECTED, RECOIL, DURATION, WINDOW_MAX,
  WINDOW_MIN, GRAZE_BAND,
} from '../../src/minigames/rites/HuntRite.js';
import { assertRiteContract } from './helpers/rite-contract.js';

const DT = MINIGAMES.dt;

/** Build a live instance without a host. */
function spawn({ seed = 1234, occurrence = 0, wave = 8 } = {}) {
  const inst = HUNT_RITE.create();
  inst.init({
    rand: riteRng(seed, HUNT_RITE.id, occurrence),
    wave, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/**
 * The point a player actually aims at: the animal's MASS, not its feet.
 *
 * Duplicated from HuntRite's private `#bodyLift` on purpose. A test that
 * imported the offset would still pass if the rite moved the hit disc away from
 * the drawn silhouette; this one has to be updated by hand when the picture
 * changes, which is the point.
 */
function aim(a) { return { x: a.x, y: a.y + 0.30 * a.scale }; }

/** Step with neutral input until one more step would pass `target`. */
function stepTo(inst, target) {
  let guard = 0;
  while (inst.t + DT <= target && guard++ < 4000) inst.update(DT, makeInput());
  return inst;
}

/** One step carrying a single shot at (x, y). */
function shoot(inst, x, y, button = 0) {
  return inst.update(DT, makeInput({ action: button === 0 ? 1 : 0, altAction: button === 2 ? 1 : 0, clicks: [clickAt(x, y, button, 'pointer')] }));
}

/**
 * A player who takes the shot the instant the animal is up and the trigger is
 * free. The ceiling, not a human — its job is to prove the ceiling is reachable
 * and that mashing does not get near it.
 */
const SKILLED = (inst) => {
  const a = inst.liveAnimal();
  if (!a || inst.recoil > 0) return makeInput();
  const p = aim(a);
  return makeInput({ action: 1, clicks: [clickAt(p.x, p.y, 0, 'pointer')] });
};

/** A structural snapshot that skips functions. For the draw()-purity check. */
function snap(o, depth = 0, seen = new Set()) {
  if (o === null || typeof o !== 'object') {
    return typeof o === 'number' && !Number.isFinite(o) ? String(o) : o;
  }
  if (seen.has(o) || depth > 6) return '[deep]';
  seen.add(o);
  if (Array.isArray(o) || ArrayBuffer.isView(o)) return Array.from(o, (v) => snap(v, depth + 1, seen));
  const out = {};
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'function') continue;
    out[k] = snap(o[k], depth + 1, seen);
  }
  return out;
}

/** Every Painter method a rite may call, stubbed and chainable. */
const PAINTER_METHODS = [
  'save', 'restore', 'alpha', 'add', 'translate', 'rotate', 'scale', 'glow', 'noGlow',
  'circle', 'arc', 'rect', 'line', 'poly', 'blob', 'ellipse', 'capsule', 'halo', 'text',
];
function stubPainter() {
  const g = { calls: 0 };
  for (const m of PAINTER_METHODS) g[m] = () => { g.calls++; return g; };
  g.linearFill = () => 'gradient';
  g.clipRect = (_a, _b, _c, _d, fn) => { fn(g); return g; };
  return g;
}

// ===========================================================================

describe('HuntRite — the shared checklist', () => {
  it('honours the whole rite contract', () => {
    assertRiteContract(HUNT_RITE, { randCalls: RAND_CALLS, skilled: SKILLED });
  });

  it('publishes a rand budget that is the arithmetic, not a memory of it', () => {
    // 3 rivals x 4 draws + 14 animals x 4 draws + 1 presentation seed.
    expect(RAND_CALLS).toBe(3 * 4 + ANIMALS * 4 + 1);
    expect(EXPECTED).toBe(8);
    expect(HUNT_RITE.duration).toBe(DURATION);
  });

  it('lays out a different forest for a different seed', () => {
    // Without this, the budget and determinism tests both pass on a rite that
    // ignores the seed entirely and hands every player the same fourteen animals.
    const a = spawn({ seed: 11 }).animals.map((x) => [x.x, x.y, x.species]);
    const b = spawn({ seed: 12 }).animals.map((x) => [x.x, x.y, x.species]);
    expect(b).not.toEqual(a);
  });
});

describe('HuntRite — the two brakes', () => {
  it('spooks the live animal when a shot hits nothing', () => {
    const inst = spawn();
    const a = inst.animals[0];
    stepTo(inst, a.appearAt + 0.02);
    expect(a.state).toBe('live');

    // Deliberately up in the canopy: inside the field, nowhere near the animal.
    shoot(inst, a.x, a.y + 3);
    expect(a.state).toBe('spooked');
    expect(inst.taken).toBe(0);
    expect(inst.spooked).toBe(1);
    // 'break' rather than 'miss': what was lost is the animal, not the bullet.
    expect(inst.drainEvents().map((e) => e.type)).toContain('break');
  });

  it('grazes rather than spooks when the shot only just missed', () => {
    // THE LINE BETWEEN THE TWO BRAKES. Brake #2 punishes firing into the bushes;
    // a round that whistles past the shoulder is a different mistake and costs
    // only the recoil. Without this split, aim wobble was instantly fatal and
    // the rite collapsed into "on time or gone" with no middle — which is what
    // the calibration gate measured as a missing mid-band.
    const inst = spawn();
    const a = inst.animals[0];
    stepTo(inst, a.appearAt + 0.02);
    expect(a.state).toBe('live');

    // Just outside the kill disc, comfortably inside the graze band.
    const d = a.hitR + GRAZE_BAND * a.scale * 0.5;
    shoot(inst, a.x + d, a.y + 0.30 * a.scale);
    expect(a.state, 'a near miss must not spook the animal').toBe('live');
    expect(inst.taken).toBe(0);
    expect(inst.spooked).toBe(0);
    expect(inst.grazed).toBe(1);
    const types = inst.drainEvents().map((e) => e.type);
    expect(types).toContain('miss');
    expect(types).not.toContain('break');
    // And it still costs the trigger, which is what makes a graze expensive.
    expect(inst.recoil).toBeGreaterThan(0);
  });

  it('still spooks the moment the shot leaves the graze band', () => {
    // The complement of the test above, and the guard on the anti-mash rule:
    // widening the band until nothing spooks would pass every other test here.
    const inst = spawn();
    const a = inst.animals[0];
    stepTo(inst, a.appearAt + 0.02);
    const d = a.hitR + GRAZE_BAND * a.scale + 0.05;
    shoot(inst, a.x + d, a.y + 0.30 * a.scale);
    expect(a.state).toBe('spooked');
    expect(inst.spooked).toBe(1);
    expect(inst.grazed).toBe(0);
  });

  it('reports a plain miss when nothing was on the field to spook', () => {
    const inst = spawn();
    expect(inst.liveAnimal()).toBe(null);
    shoot(inst, 0, 3.5);
    const types = inst.drainEvents().map((e) => e.type);
    expect(types).toContain('miss');
    expect(types).not.toContain('break');
    expect(inst.spooked).toBe(0);
  });

  it('spends exactly one shot when two clicks land in the same step', () => {
    // The host hands a whole frame's clicks to sub-step 1, so a fast player (or
    // a macro) can present several at once. The recoil has to eat them there,
    // not one step later.
    const inst = spawn();
    inst.update(DT, makeInput({
      action: 2,
      clicks: [clickAt(0, 3.5, 0, 'pointer'), clickAt(1, 3.5, 0, 'pointer')],
    }));
    expect(inst.shots).toBe(1);
  });

  it('locks the trigger for 0.45 s and then releases it', () => {
    const inst = spawn();
    shoot(inst, 0, 3.5);
    expect(inst.shots).toBe(1);

    // Hammering through the whole recoil window buys nothing.
    const held = Math.floor((RECOIL - 0.05) / DT);
    for (let i = 0; i < held; i++) shoot(inst, 0, 3.5);
    expect(inst.shots).toBe(1);

    // Past it, the very next click fires.
    for (let i = 0; i < 5; i++) shoot(inst, 0, 3.5);
    expect(inst.shots).toBe(2);
  });

  it('treats left, right and Space as one verb', () => {
    // Right-click is what the original map used; it must never be REQUIRED and
    // must never be worth more. A rite that read only `action` would silently
    // ignore the secondary button; one that read only `altAction`, the primary.
    const takeWith = (button, source) => {
      const inst = spawn();
      const a = inst.animals[0];
      stepTo(inst, a.appearAt + 0.02);
      const p = aim(a);
      inst.update(DT, makeInput({ clicks: [clickAt(p.x, p.y, button, source)] }));
      return inst.taken;
    };
    expect(takeWith(0, 'pointer')).toBe(1);
    expect(takeWith(2, 'pointer')).toBe(1);
    expect(takeWith(0, 'key')).toBe(1);
  });
});

describe('HuntRite — the deadline', () => {
  it('counts a hit landed before the rival claim time', () => {
    const inst = spawn();
    const a = inst.animals[2];
    stepTo(inst, a.claimAt - 0.08);
    expect(a.state).toBe('live');
    const p = aim(a);
    shoot(inst, p.x, p.y);
    expect(a.state).toBe('taken');
    expect(inst.taken).toBe(1);
  });

  it('does not count a hit landed after it — the animal is already gone', () => {
    const inst = spawn();
    const a = inst.animals[2];
    stepTo(inst, a.claimAt + 0.05);
    expect(a.state).toBe('claimed');
    const p = aim(a);
    shoot(inst, p.x, p.y);
    expect(inst.taken).toBe(0);
  });

  it('makes a tie impossible: the deadline resolves before the step\'s shots', () => {
    // The strict `<` in the spec, expressed as an ORDER OF OPERATIONS. update()
    // ages the animals before it reads input.clicks, so a shot arriving on the
    // step that crosses claimAt finds nothing live. Swap those two blocks and
    // the boundary silently becomes `<=` — a change no other test would see.
    const inst = spawn();
    const a = inst.animals[1];
    stepTo(inst, a.claimAt - 1e-9);
    expect(a.state).toBe('live');
    expect(inst.t).toBeLessThan(a.claimAt);
    expect(inst.t + DT).toBeGreaterThanOrEqual(a.claimAt);

    const claimedBefore = inst.claimed;   // animal 0's deadline is already past
    const p = aim(a);
    shoot(inst, p.x, p.y);
    expect(a.state).toBe('claimed');
    expect(inst.taken).toBe(0);
    expect(inst.claimed).toBe(claimedBefore + 1);
  });

  it('puts a named rival on every deadline, from the shared roster', () => {
    const inst = spawn();
    const names = new Set(inst.rivals.roster().map((r) => r.name));
    expect(names.size).toBe(3);
    for (const a of inst.animals) expect(names.has(a.claimant)).toBe(true);

    // The same seed produces the same three names and the same deadlines for
    // every player in the room — that is the whole substitute for a network.
    const twin = spawn();
    expect(twin.rivals.roster().map((r) => r.name)).toEqual([...inst.rivals.roster()].map((r) => r.name));
    expect(twin.animals.map((a) => a.claimAt)).toEqual(inst.animals.map((a) => a.claimAt));
  });

  it('deals every round the SAME spread of windows, in a different order', () => {
    // THE ANTI-LOTTERY INVARIANT, and the reason the mid-band exists on every
    // seed rather than on average. The fourteen temperaments are a hand, not
    // fourteen rolls: two seeds at one wave must produce the same MULTISET of
    // windows and (almost always) a different assignment of them to animals.
    //
    // Without this the number of reachable animals is a binomial with an SD of
    // about two — a quarter of EXPECTED — so the round rolled its own difficulty
    // on top of every other roll, and the same player at wave 53 scored 0.000 on
    // one seed and 1.000 on the next.
    const windows = (seed) => spawn({ seed, wave: 28 }).animals.map((a) => a.claimAt - a.appearAt);
    const a = windows(11);
    const b = windows(4242);
    const sortedA = [...a].sort((p, q) => p - q);
    const sortedB = [...b].sort((p, q) => p - q);

    // The PROFILE is the same rung for rung. Not bit-identical: the roster still
    // flavours the whole hand (WINDOW_GAIN), so two seeds can shift the ladder
    // bodily by up to about a tenth of a second. What must not vary is its
    // SHAPE — that is the difference between "this field is a little quicker"
    // and "this round happens to contain no animal you can catch".
    for (let i = 0; i < sortedA.length; i++) {
      expect(Math.abs(sortedB[i] - sortedA[i]),
        `rung ${i}: two seeds dealt different SHAPES of round `
        + `(${sortedA[i].toFixed(3)}s vs ${sortedB[i].toFixed(3)}s)`).toBeLessThanOrEqual(0.12);
    }
    // ...but not in the same order, or the straggler would always be animal 13.
    expect(b.map((v) => v.toFixed(9))).not.toEqual(a.map((v) => v.toFixed(9)));
  });

  it('spreads those windows widely enough to ask more than one question', () => {
    // The mid-band's precondition, asserted here rather than only in the
    // calibration gate: if every animal in a round wants the same reaction time,
    // the round has one difficulty and the score has two values.
    for (const wave of [3, 28, 53]) {
      const w = spawn({ wave }).animals.map((a) => a.claimAt - a.appearAt);
      const spread = Math.max(...w) - Math.min(...w);
      expect(spread, `wave ${wave} deals a near-uniform window (spread ${spread.toFixed(3)}s)`)
        .toBeGreaterThan(0.35);
    }
  });

  it('gives a faster field a tighter window, and never an impossible one', () => {
    // The wave curve, measured rather than asserted by eye. `WINDOW_MAX` is also
    // the schedule's safety margin: it must stay under the rival source's target
    // spacing or two animals are contested at once.
    const windowsAt = (wave) => {
      const inst = spawn({ wave });
      return inst.animals.map((a) => a.claimAt - a.appearAt);
    };
    const early = windowsAt(3);
    const late = windowsAt(53);
    const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
    expect(mean(late)).toBeLessThan(mean(early));
    for (const w of [...early, ...late]) {
      expect(w).toBeGreaterThanOrEqual(WINDOW_MIN - 1e-9);
      expect(w).toBeLessThanOrEqual(WINDOW_MAX + 1e-9);
    }
    const inst = spawn();
    expect(WINDOW_MAX).toBeLessThan(inst.rivals.claimTime(1) - inst.rivals.claimTime(0));
  });
});

describe('HuntRite — the round', () => {
  it('contests exactly one animal at a time, for the whole clock', () => {
    for (const wave of [3, 28, 53]) {
      const inst = spawn({ wave, seed: 77 });
      let worst = 0;
      for (let n = 0; n < Math.ceil(DURATION / DT); n++) {
        if (inst.update(DT, makeInput()) === true) break;
        let live = 0;
        for (const a of inst.animals) if (a.state === 'live') live++;
        if (live > worst) worst = live;
      }
      expect(worst, `wave ${wave} had ${worst} animals contested at once`).toBeLessThanOrEqual(1);
    }
  });

  it('resolves every animal on screen, before the clock runs out', () => {
    // An animal still standing when the host closes the overlay reads as a bug
    // even though the score is identical, which is what END_PAD is for.
    for (const seed of [3, 19, 404]) {
      for (const wave of [3, 28, 53]) {
        const inst = spawn({ seed, wave });
        for (const a of inst.animals) {
          expect(a.appearAt).toBeGreaterThan(0);
          expect(a.claimAt).toBeLessThanOrEqual(DURATION - 0.2 + 1e-9);
          expect(a.claimAt).toBeGreaterThan(a.appearAt);
        }
      }
    }
  });

  it('is a REACTION shot: the animal never moves while it is contested', () => {
    // THE GUARD ON THE ONE DESIGN RISK IN THE WHOLE WAVE. `fishing` is the
    // leading shot — its fish keeps swimming while the hook sinks. If an animal
    // here ever acquires a drift, aiming becomes prediction and two of the
    // eleven rites in a run collapse into one game. The position is fixed at
    // init and this asserts that nothing in update() touches it.
    const inst = spawn({ seed: 8, wave: 28 });
    const before = inst.animals.map((a) => [a.x, a.y, a.scale, a.hitR]);
    const rng = mulberry32(5);
    for (let n = 0; n < Math.ceil(DURATION / DT); n++) {
      const fire = rng() < 0.1;
      if (inst.update(DT, makeInput({
        x: (rng() * 2 - 1) * FIELD.hw, y: (rng() * 2 - 1) * FIELD.hh, inside: true,
        clicks: fire ? [clickAt((rng() * 2 - 1) * FIELD.hw, (rng() * 2 - 1) * FIELD.hh, 0, 'pointer')] : [],
      })) === true) break;
    }
    expect(inst.animals.map((a) => [a.x, a.y, a.scale, a.hitR])).toEqual(before);
  });

  it('scores exactly 0 for an idle run — every animal goes to a rival', () => {
    const inst = spawn({ seed: 5, wave: 23 });
    let steps = 0;
    while (steps < Math.ceil(DURATION / DT) + 1) {
      steps++;
      if (inst.update(DT, makeInput()) === true) break;
    }
    const s = inst.score();
    expect(s.ratio).toBe(0);
    expect(inst.claimed).toBe(ANIMALS);
    expect(inst.spooked).toBe(0);
    expect(s.headline).toBe('The forest kept them');
  });

  it('clamps at 1 for a player who beats the expectation', () => {
    const inst = spawn({ seed: 909, wave: 28 });
    for (let n = 0; n < Math.ceil(DURATION / DT); n++) {
      if (inst.update(DT, SKILLED(inst, n)) === true) break;
    }
    expect(inst.taken).toBeGreaterThanOrEqual(EXPECTED);
    expect(inst.score().ratio).toBe(1);
    expect(inst.spooked).toBe(0);
  });

  it('leaves a panic-clicker with nothing, because the misses do the damage', () => {
    // Stronger than the shared checklist's 0.6 ceiling, and a claim about THIS
    // design: spraying does not merely fail to score, it destroys the round.
    const rng = mulberry32(7);
    const inst = spawn({ seed: 909, wave: 28 });
    for (let n = 0; n < Math.ceil(DURATION / DT); n++) {
      if (inst.update(DT, makeInput({
        x: (rng() * 2 - 1) * FIELD.hw, y: (rng() * 2 - 1) * FIELD.hh, inside: true, down: true, action: 1,
        clicks: [clickAt((rng() * 2 - 1) * FIELD.hw, (rng() * 2 - 1) * FIELD.hh, 0, 'pointer')],
      })) === true) break;
    }
    expect(inst.score().ratio).toBeLessThan(0.2);
    expect(inst.spooked).toBeGreaterThan(ANIMALS / 2);
    // The recoil is what caps the volume: 20 s at one shot per 0.45 s.
    expect(inst.shots).toBeLessThanOrEqual(Math.ceil(DURATION / RECOIL) + 1);
  });

  it('carries evidence on the result card', () => {
    const inst = spawn();
    const a = inst.animals[0];
    stepTo(inst, a.appearAt + 0.02);
    const p = aim(a);
    shoot(inst, p.x, p.y);
    const s = inst.score();
    expect(s.detail).toBe(`1/${ANIMALS} taken · 0 claimed · 0 spooked · 0 grazed`);
    expect(s.ratio).toBeCloseTo(1 / EXPECTED, 10);
  });
});

describe('HuntRite — drawing', () => {
  it('draws without touching a single field of state', () => {
    // docs/MINIGAMES.md §5: draw() is skipped entirely on a zero-sized canvas
    // and called a variable number of times per step, so anything it mutates is
    // a round that diverges between two players with identical inputs.
    const inst = spawn({ seed: 21, wave: 33 });
    const rng = mulberry32(99);
    for (let n = 0; n < 400; n++) {
      const fire = rng() < 0.12;
      inst.update(DT, makeInput({
        inside: true,
        clicks: fire ? [clickAt((rng() * 2 - 1) * FIELD.hw, (rng() * 2 - 1) * FIELD.hh, 0, 'pointer')] : [],
      }));
    }
    const before = snap(inst);
    const g = stubPainter();
    for (const alpha of [0, 0.5, 0.99]) inst.draw(g, alpha);
    expect(g.calls).toBeGreaterThan(50);
    expect(snap(inst)).toEqual(before);
  });

  it('draws every phase a round can be in without throwing', () => {
    // A throw inside draw() is not a wrong picture, it is a dead rite: the host
    // catches it, abandons the round and pays nothing. Walk one full clock with
    // takes, spooks and claims all in flight and render every step.
    const inst = spawn({ seed: 64, wave: 41 });
    const g = stubPainter();
    const rng = mulberry32(3);
    for (let n = 0; n < Math.ceil(DURATION / DT); n++) {
      // Alternate between aiming true and aiming wild, so takes, spooks, plain
      // misses, rival claims and the recoil lock all occur in the same run.
      const a = inst.liveAnimal();
      let clicks = [];
      if (a && inst.recoil <= 0 && rng() < 0.5) {
        const p = aim(a);
        clicks = rng() < 0.5 ? [clickAt(p.x, p.y, 0, 'pointer')] : [clickAt(p.x + 2.5, p.y + 1.5, 2, 'pointer')];
      } else if (rng() < 0.05) {
        clicks = [clickAt((rng() * 2 - 1) * FIELD.hw, (rng() * 2 - 1) * FIELD.hh, 0, 'pointer')];
      }
      const end = inst.update(DT, makeInput({ inside: true, clicks }));
      inst.draw(g, 0.4);
      inst.drainEvents();
      if (end === true) break;
    }
    expect(inst.taken + inst.claimed + inst.spooked).toBe(ANIMALS);
    expect(Number.isFinite(inst.score().ratio)).toBe(true);
  });
});
