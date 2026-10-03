/**
 * GAME HUNT — the rite's own facts.
 *
 * `assertRiteContract` covers everything TRUE OF ANY RITE (fixed rand budget on
 * three waves, determinism, idle pays nothing, mashing loses to play, fuzz stays
 * finite, a pure score(), a drainEvents that empties). It runs once, first, and
 * this file does not repeat any of it.
 *
 * What is left is what makes this rite THIS rite:
 *
 *  - the RELOAD really blocks the next shot, and is the only price of a miss
 *    (a miss no longer spooks the runner);
 *  - `t < claimAt` is STRICT, so a tie is not a state this rite can be in;
 *  - the run IS the clock: an animal runs between two neighbouring bushes over
 *    exactly its window, and at most two run at once;
 *  - the shot is HITSCAN: aiming where the animal is on the step hits, and
 *    aiming where it was does not. That is the guard on the split with
 *    `fishing`, whose hook sinks while the fish swims (the LEADING shot);
 *  - species, lanes and temperaments are DEALT, so every seed gets the same mix.
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
  WINDOW_MIN, LANES, BUSH_R, SPECIES,
} from '../../src/minigames/rites/HuntRite.js';
import { assertRiteContract } from './helpers/rite-contract.js';

const DT = MINIGAMES.dt;

function spawn({ seed = 1234, occurrence = 0, wave = 8 } = {}) {
  const inst = HUNT_RITE.create();
  inst.init({
    rand: riteRng(seed, HUNT_RITE.id, occurrence),
    wave, occurrence, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/** Step with neutral input until one more step would pass `target`. */
function stepTo(inst, target) {
  let guard = 0;
  while (inst.t + DT <= target && guard++ < 4000) inst.update(DT, makeInput());
  return inst;
}

/** Where the shot fired on the NEXT step must land to hit `a`: its position then. */
function aimNext(inst, a) { return inst.posAt(a, inst.t + DT); }

/** One step carrying a single shot at (x, y). */
function shoot(inst, x, y, button = 0, source = 'pointer') {
  return inst.update(DT, makeInput({ clicks: [clickAt(x, y, button, source)] }));
}

/**
 * The ceiling: shoot the most urgent runner the instant the trigger is free, at
 * where it will be on the step the shot resolves.
 */
const SKILLED = (inst) => {
  const a = inst.liveAnimal();
  if (!a || inst.recoil > 0) return makeInput();
  const p = aimNext(inst, a);
  return makeInput({ action: 1, clicks: [clickAt(p.x, p.y, 0, 'pointer')] });
};

function runOut(inst, strategy) {
  for (let n = 0; n < Math.ceil(DURATION / DT) + 1; n++) {
    if (inst.update(DT, strategy(inst, n)) === true) break;
  }
  return inst;
}

// ===========================================================================

describe('HuntRite — the shared checklist', () => {
  it('honours the whole rite contract', () => {
    assertRiteContract(HUNT_RITE, { randCalls: RAND_CALLS, skilled: SKILLED });
  });

  it('publishes a rand budget that is the arithmetic, not a memory of it', () => {
    // 3 rivals x 4 draws + 14 animals x 4 draws + 1 cosmetic seed.
    expect(RAND_CALLS).toBe(69);
    expect(EXPECTED).toBe(10);
    expect(HUNT_RITE.duration).toBe(DURATION);
  });

  it('lays out a different hunt for a different seed', () => {
    const a = spawn({ seed: 11 }).animals.map((x) => [x.x0, x.lane, x.species]);
    const b = spawn({ seed: 12 }).animals.map((x) => [x.x0, x.lane, x.species]);
    expect(b).not.toEqual(a);
  });

  it('is a 3D rite: a view and no 2D draw', () => {
    expect(typeof HUNT_RITE.view).toBe('function');
    expect(spawn().draw).toBeUndefined();
  });
});

describe('HuntRite — the reload', () => {
  it('a miss costs the reload and nothing else: the runner keeps running', () => {
    const inst = spawn();
    const a = inst.animals[0];
    stepTo(inst, a.appearAt + 0.02);
    expect(a.state).toBe('live');
    shoot(inst, a.x0, a.y + 3);
    expect(a.state).toBe('live');
    expect(inst.taken).toBe(0);
    expect(inst.recoil).toBeGreaterThan(0);
    expect(inst.drainEvents().map((e) => e.type)).toEqual(['start', 'miss']);
  });

  it('spends exactly one shot when two clicks land in the same step', () => {
    const inst = spawn();
    inst.update(DT, makeInput({
      action: 2,
      clicks: [clickAt(0, 3.5, 0, 'pointer'), clickAt(1, 3.5, 0, 'pointer')],
    }));
    expect(inst.shots).toBe(1);
  });

  it('locks the trigger for RECOIL seconds and then releases it', () => {
    const inst = spawn();
    shoot(inst, 0, 3.5);
    expect(inst.shots).toBe(1);
    const held = Math.floor((RECOIL - 0.05) / DT);
    for (let i = 0; i < held; i++) shoot(inst, 0, 3.5);
    expect(inst.shots).toBe(1);
    expect(inst.blockedAt).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) shoot(inst, 0, 3.5);
    expect(inst.shots).toBe(2);
  });

  it('treats left, right and Space as one verb', () => {
    const takeWith = (button, source) => {
      const inst = spawn();
      const a = inst.animals[0];
      stepTo(inst, a.appearAt + 0.1);
      const p = aimNext(inst, a);
      shoot(inst, p.x, p.y, button, source);
      return inst.taken;
    };
    expect(takeWith(0, 'pointer')).toBe(1);
    expect(takeWith(2, 'pointer')).toBe(1);
    expect(takeWith(0, 'key')).toBe(1);
  });
});

describe('HuntRite — the deadline', () => {
  it('counts a hit landed before the rival fires', () => {
    const inst = spawn();
    const a = inst.animals[2];
    stepTo(inst, a.claimAt - 0.08);
    expect(a.state).toBe('live');
    const p = aimNext(inst, a);
    shoot(inst, p.x, p.y);
    expect(a.state).toBe('taken');
    expect(inst.taken).toBe(1);
  });

  it('does not count a hit after it: the rival already has it', () => {
    const inst = spawn();
    const a = inst.animals[2];
    stepTo(inst, a.claimAt + 0.05);
    expect(a.state).toBe('claimed');
    const p = inst.posAt(a, inst.t);
    shoot(inst, p.x, p.y);
    expect(inst.taken).toBe(0);
  });

  it('makes a tie impossible: the deadline resolves before the step\'s shots', () => {
    const inst = spawn();
    const a = inst.animals[1];
    stepTo(inst, a.claimAt - 1e-9);
    expect(a.state).toBe('live');
    expect(inst.t + DT).toBeGreaterThanOrEqual(a.claimAt);
    const before = inst.claimed;
    const p = aimNext(inst, a);
    shoot(inst, p.x, p.y);
    expect(a.state).toBe('claimed');
    expect(inst.taken).toBe(0);
    expect(inst.claimed).toBe(before + 1);
  });

  it('gives every deadline a rival from the roster, and keeps their tally', () => {
    const inst = spawn();
    const roster = inst.rivals.roster();
    expect(roster.length).toBe(3);
    for (const a of inst.animals) {
      expect(a.rival).toBeGreaterThanOrEqual(0);
      expect(a.claimant).toBe(roster[a.rival].name);
    }
    const events = [];
    runOut(inst, (i) => { events.push(...i.drainEvents()); return makeInput(); });
    expect(inst.rivalKills.reduce((s, v) => s + v, 0)).toBe(ANIMALS);
    const claims = events.filter((e) => e.type === 'claim');
    expect(claims.length).toBe(ANIMALS);
    for (const e of claims) {
      expect(e.rival).toBe(inst.animals[e.i].rival);
      const a = inst.animals[e.i];
      const at = inst.posAt(a, a.claimAt);
      expect([e.x, e.y]).toEqual([at.x, at.y]);
      expect(at.x).toBeCloseTo(a.x1, 9);
    }
    const twin = spawn();
    expect(twin.animals.map((a) => [a.claimAt, a.claimant]))
      .toEqual(spawn().animals.map((a) => [a.claimAt, a.claimant]));
  });
});

describe('HuntRite — the run', () => {
  it('runs between two NEIGHBOURING bushes of its lane, edge to edge', () => {
    for (const seed of [3, 19, 404]) {
      for (const wave of [3, 28, 53]) {
        for (const a of spawn({ seed, wave }).animals) {
          const L = LANES[a.lane];
          const edge = BUSH_R * L.scale;
          const from = a.x0 - a.dir * edge;
          const to = a.x1 + a.dir * edge;
          const j = L.cover.findIndex((c) => Math.abs(c - from) < 1e-9);
          expect(j, `seed ${seed} wave ${wave} animal ${a.i} starts at a bush`).toBeGreaterThanOrEqual(0);
          expect(L.cover[j + a.dir]).toBeCloseTo(to, 9);
          expect(Math.sign(a.x1 - a.x0)).toBe(a.dir);
          expect(Math.abs(a.x0)).toBeLessThan(FIELD.hw);
          expect(Math.abs(a.x1)).toBeLessThan(FIELD.hw);
        }
      }
    }
  });

  it('covers the run over exactly its window: the distance left is the time left', () => {
    const inst = spawn({ seed: 8, wave: 28 });
    for (const a of inst.animals) {
      expect(inst.posAt(a, a.appearAt).x).toBeCloseTo(a.x0, 9);
      expect(inst.posAt(a, a.claimAt).x).toBeCloseTo(a.x1, 9);
      expect(inst.posAt(a, (a.appearAt + a.claimAt) / 2).x).toBeCloseTo((a.x0 + a.x1) / 2, 9);
    }
  });

  it('is HITSCAN: where it is hits, where it was misses', () => {
    // The split with `fishing`. A shot here has no travel time, so the player
    // aims at the runner, never ahead of it.
    const where = spawn({ seed: 8, wave: 28 });
    const a = where.animals.find((x) => x.claimAt - x.appearAt < 0.9);
    stepTo(where, a.appearAt + 0.3 * (a.claimAt - a.appearAt));
    const now = aimNext(where, a);
    shoot(where, now.x, now.y);
    expect(a.state).toBe('taken');

    const was = spawn({ seed: 8, wave: 28 });
    const b = was.animals[a.i];
    stepTo(was, b.appearAt + 0.3 * (b.claimAt - b.appearAt));
    const old = was.posAt(b, b.appearAt);
    shoot(was, old.x, old.y);
    expect(b.state).toBe('live');
  });

  it('never runs more than two animals at once, for the whole clock', () => {
    for (const wave of [3, 28, 53]) {
      const inst = spawn({ wave, seed: 77 });
      let worst = 0;
      runOut(inst, (i) => {
        let live = 0;
        for (const a of i.animals) if (a.state === 'live') live++;
        worst = Math.max(worst, live);
        return makeInput();
      });
      expect(worst, `wave ${wave}`).toBeLessThanOrEqual(2);
    }
  });

  it('gives the shot to the FRONT runner when two discs overlap', () => {
    const inst = spawn({ seed: 8 });
    const [near, far] = [inst.animals[0], inst.animals[1]];
    for (const [a, lane] of [[near, 0], [far, 2]]) {
      Object.assign(a, { lane, x0: 0, x1: 0.001, y: 0, hitR: 1, appearAt: 0, claimAt: 5 });
    }
    inst.update(DT, makeInput());
    shoot(inst, 0, 0);
    expect(near.state).toBe('taken');
    expect(far.state).toBe('live');
  });

  it('resolves every animal on screen, before the clock runs out', () => {
    for (const seed of [3, 19, 404]) {
      for (const wave of [3, 28, 53]) {
        for (const a of spawn({ seed, wave }).animals) {
          expect(a.appearAt).toBeGreaterThan(0);
          expect(a.claimAt).toBeLessThanOrEqual(DURATION - 0.2 + 1e-9);
          expect(a.claimAt - a.appearAt).toBeGreaterThanOrEqual(WINDOW_MIN - 1e-9);
          expect(a.claimAt - a.appearAt).toBeLessThanOrEqual(WINDOW_MAX + 1e-9);
        }
      }
    }
  });
});

describe('HuntRite — every round is the same hand', () => {
  it('deals the same species mix and lane mix on every seed', () => {
    const mix = (inst, key, n) => {
      const out = new Array(n).fill(0);
      for (const a of inst.animals) out[a[key]]++;
      return out;
    };
    for (const wave of [3, 53]) {
      const a = spawn({ seed: 11, wave });
      const b = spawn({ seed: 4242, wave });
      expect(mix(b, 'species', SPECIES.length)).toEqual(mix(a, 'species', SPECIES.length));
      expect(mix(b, 'lane', LANES.length)).toEqual(mix(a, 'lane', LANES.length));
    }
    expect(mix(spawn({ wave: 3 }), 'species', 3)).toEqual([6, 4, 4]);
  });

  it('deals the same spread of windows, in a different order', () => {
    const windows = (seed) => spawn({ seed, wave: 28 }).animals.map((a) => a.claimAt - a.appearAt);
    const a = windows(11);
    const b = windows(4242);
    const sa = [...a].sort((p, q) => p - q);
    const sb = [...b].sort((p, q) => p - q);
    for (let i = 0; i < sa.length; i++) {
      // The roster flavours the whole ladder by up to about a tenth of a second.
      expect(Math.abs(sb[i] - sa[i]), `rung ${i}`).toBeLessThanOrEqual(0.15);
    }
    expect(b.map((v) => v.toFixed(9))).not.toEqual(a.map((v) => v.toFixed(9)));
  });

  it('spreads the windows from sprinters to stragglers, and the wave squeezes them', () => {
    const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const at = (wave) => spawn({ wave }).animals.map((a) => a.claimAt - a.appearAt);
    for (const wave of [3, 28, 53]) {
      const w = at(wave);
      expect(Math.max(...w) - Math.min(...w), `wave ${wave}`).toBeGreaterThan(1.2);
      // The straggler floor: a long run survives to the last wave.
      expect(Math.max(...w), `wave ${wave}`).toBeGreaterThan(1.8);
    }
    expect(mean(at(53))).toBeLessThan(mean(at(28)));
    expect(mean(at(28))).toBeLessThan(mean(at(3)));
  });
});

describe('HuntRite — the score', () => {
  it('scores exactly 0 for an idle run: every animal goes to a rival', () => {
    const inst = runOut(spawn({ seed: 5, wave: 23 }), () => makeInput());
    expect(inst.score().ratio).toBe(0);
    expect(inst.claimed).toBe(ANIMALS);
    expect(inst.score().headline).toBe('The forest kept them');
  });

  it('clamps at 1 for a player who beats the expectation', () => {
    const inst = runOut(spawn({ seed: 909, wave: 28 }), SKILLED);
    expect(inst.taken).toBe(ANIMALS);
    expect(inst.score().ratio).toBe(1);
    expect(inst.score().headline).toBe('Unerring');
  });

  it('leaves a panic-clicker with almost nothing: the reload spends the trigger', () => {
    const rng = mulberry32(7);
    const inst = runOut(spawn({ seed: 909, wave: 28 }), () => makeInput({
      x: (rng() * 2 - 1) * FIELD.hw, y: (rng() * 2 - 1) * FIELD.hh, inside: true, down: true, action: 1,
      clicks: [clickAt((rng() * 2 - 1) * FIELD.hw, (rng() * 2 - 1) * FIELD.hh, 0, 'pointer')],
    }));
    expect(inst.score().ratio).toBeLessThan(0.2);
    expect(inst.shots).toBeLessThanOrEqual(Math.ceil(DURATION / RECOIL) + 1);
  });

  it('carries evidence on the result card', () => {
    const inst = spawn();
    const a = inst.animals[0];
    stepTo(inst, a.appearAt + 0.05);
    const p = aimNext(inst, a);
    shoot(inst, p.x, p.y);
    const s = inst.score();
    expect(s.detail).toBe(`1/${ANIMALS} taken · 0 to rivals · 1 shots`);
    expect(s.ratio).toBeCloseTo(1 / EXPECTED, 10);
  });

  it('tells the view where every take happened', () => {
    const inst = spawn();
    const a = inst.animals[0];
    stepTo(inst, a.appearAt + 0.05);
    const p = aimNext(inst, a);
    shoot(inst, p.x, p.y);
    const take = inst.drainEvents().find((e) => e.type === 'perfect' || e.type === 'good');
    expect(take).toEqual({ type: 'perfect', x: a.endX, y: a.endY, i: 0 });
    expect(a.endX).toBeCloseTo(p.x, 9);
  });
});
