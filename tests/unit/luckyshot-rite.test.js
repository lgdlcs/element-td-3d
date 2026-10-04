/**
 * LUCKY SHOT — the reference rite's own suite.
 *
 * Two halves, and the split is deliberate.
 *
 * The first half is `assertRiteContract`, which every rite passes: the fixed
 * randomness budget, determinism, an idle run that ends and pays nothing,
 * mashing beaten by deliberate play, fuzz that stays finite, a pure `score()`,
 * a `drainEvents` that empties. Nothing below re-implements any of that.
 *
 * The second half is the part a shared harness CANNOT know: the rules that make
 * this particular game a game. Ammo runs out and the rite ends. One click
 * resolves against exactly one target, and against the FRONTMOST one when two
 * overlap. The bystander subtracts. A miss still costs a round.
 *
 * And one test that is not really about this rite at all:
 *
 *   "two clicks in one step, at two positions, are two distinct hits"
 *
 * is THE proof that the Wave 0 click queue works end to end. Before it,
 * `input.x/y` was the only position a rite could read, so a pointerdown at A
 * followed by a move to B before the next fixed step credited the shot to B —
 * and two presses inside one 16.6 ms slice could only ever resolve at one
 * place. If that test ever goes red, the queue is broken, not this file.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput, clickAt } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import {
  LUCKY_SHOT_RITE, RAND_CALLS, AMMO, RACK, PAR, DURATION, END_HOLD,
  PER_ROW, TARGETS, ROW_TABLE, GOLDEN_MULT, BYSTANDER_VALUE,
} from '../../src/minigames/rites/LuckyShotRite.js';
import { assertRiteContract } from './helpers/rite-contract.js';

const DT = MINIGAMES.dt;

/** A live instance, without a host. */
function spawn({ seed = 1234, occurrence = 0, wave = 8 } = {}) {
  const inst = LUCKY_SHOT_RITE.create();
  inst.init({
    rand: riteRng(seed, LUCKY_SHOT_RITE.id, occurrence),
    wave, occurrence, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/**
 * Advance to the step BEFORE `n`, so that the next `update` lands on `t = n*DT`.
 *
 * `update` adds `dt` first and resolves clicks afterwards, so a click handed to
 * the nth update is resolved at `t = n*DT`. Every positional assertion below is
 * written against that time, which is why this helper stops one short.
 */
function runTo(inst, n) {
  for (let k = 0; k < n - 1; k++) inst.update(DT, makeInput());
  return n * DT;
}

/**
 * Step until `done`, or fail. Every wait in this file goes through here.
 *
 * Never `while (…) update()`. A test that waits on a condition the code under
 * test controls is a test that HANGS when that code breaks, and a hang is worse
 * than a failure: CI reports a timeout with no assertion attached, and a local
 * run just sits there. Found the hard way, mutating the miss path to refund a
 * round — "step until the gun is empty" became forever.
 */
function stepUntil(inst, done, what, cap = Math.ceil(DURATION / DT) + 60) {
  for (let n = 0; n < cap; n++) {
    const ended = inst.update(DT, makeInput()) === true;
    if (done(inst, ended)) return n + 1;
  }
  throw new Error(`stepUntil: ${what} never happened in ${cap} steps`);
}

/** Steps from one shot to the first step the rifle is racked again. */
const RACK_STEPS = Math.ceil(RACK / DT - 1e-6);

/** Wait out the rack after a shot, so the next `update` is the first that can fire. */
function rack(inst) {
  for (let k = 0; k < RACK_STEPS - 1; k++) inst.update(DT, makeInput());
}

/** A shot at (x, y), delivered through the click queue like the host does. */
function shotAt(x, y, button = 0) {
  return makeInput({ x, y, inside: true, action: button === 0 ? 1 : 0, altAction: button === 2 ? 1 : 0, clicks: [clickAt(x, y, button)] });
}

/** How many targets are lying down right now. */
function downCount(inst, t) {
  let n = 0;
  for (let i = 0; i < TARGETS; i++) if (!inst.aliveAt(i, t)) n++;
  return n;
}

/**
 * The first moment a front-row target and a middle-row target overlap far
 * enough for a single point to sit comfortably inside both.
 *
 * Scanned rather than hardcoded: the rows are seeded, so the moment moves with
 * the seed, and a literal time here would be a test that passes for one seed
 * and silently stops testing anything for every other one. The rows close at
 * 4.85 u/s relative over a 20-unit belt with 36 pairs, so this is found within
 * a fraction of the clock — a null return is a real failure, not a flaky one.
 *
 * The candidate point is the centre of the lens (the foot of the radical line
 * on the line of centres), NOT the midpoint of the two centres: the two circles
 * have different radii, so the midpoint sits outside the smaller one for most
 * of the range where they genuinely overlap.
 */
function findOverlap(inst) {
  for (let n = 1; n < 900; n++) {
    const t = n * DT;
    for (let a = 0; a < PER_ROW; a++) {
      for (let b = PER_ROW; b < 2 * PER_ROW; b++) {
        const ax = inst.xAt(a, t), ay = inst.yAt(a);
        const bx = inst.xAt(b, t), by = inst.yAt(b);
        const ra = inst.targets[a].r, rb = inst.targets[b].r;
        const d = Math.hypot(bx - ax, by - ay);
        if (d <= Math.abs(ra - rb) || d >= ra + rb) continue;      // no lens
        const k = (d * d + ra * ra - rb * rb) / (2 * d);           // along a -> b
        // 0.94 of each radius: a point sitting on a boundary would make the
        // assertion depend on a float comparison rather than on the rule.
        if (k > ra * 0.94 || d - k > rb * 0.94) continue;
        const px = ax + ((bx - ax) / d) * k;
        const py = ay + ((by - ay) / d) * k;
        if (px < -6.5 || px > 6.5) continue;
        return { n, t, front: a, back: b, px, py };
      }
    }
  }
  return null;
}

/**
 * Two targets, in two different rows, that are on screen, standing, far apart,
 * and each of which owns the point at its own centre (i.e. nothing in front of
 * it is covering that point). The setup for the click-queue test.
 */
function findTwoClean(inst, opts = {}) {
  const { skip = -1 } = opts;
  for (let n = 1; n < 900; n++) {
    const t = n * DT;
    for (let a = 0; a < PER_ROW; a++) {
      for (let b = 2 * PER_ROW; b < TARGETS; b++) {
        if (a === skip || b === skip) continue;
        if (inst.targets[a].kind === 'bystander' || inst.targets[b].kind === 'bystander') continue;
        const ax = inst.xAt(a, t), bx = inst.xAt(b, t);
        if (Math.abs(ax) > 6.5 || Math.abs(bx) > 6.5) continue;
        if (Math.abs(ax - bx) < 2.5) continue;          // two genuinely different places
        if (inst.hitIndex(ax, inst.yAt(a), t) !== a) continue;
        if (inst.hitIndex(bx, inst.yAt(b), t) !== b) continue;
        return { n, t, a, b, ax, ay: inst.yAt(a), bx, by: inst.yAt(b) };
      }
    }
  }
  return null;
}

/** The first moment target `i` is on screen, standing, and owns its own centre. */
function findClean(inst, i) {
  for (let n = 1; n < 900; n++) {
    const t = n * DT;
    const x = inst.xAt(i, t);
    if (Math.abs(x) > 6.5) continue;
    if (inst.hitIndex(x, inst.yAt(i), t) !== i) continue;
    return { n, t, x, y: inst.yAt(i) };
  }
  return null;
}

/**
 * A deliberate play strategy, for the harness's "mashing loses to playing"
 * comparison: five aimed shots a second at the most valuable standing target
 * that is on screen, and never at the bystander.
 */
function skilled(inst, step) {
  if (step % 12 !== 0) return makeInput();
  const t = inst.t + DT;
  let best = -1;
  let bestVal = -Infinity;
  for (let i = 0; i < TARGETS; i++) {
    const tg = inst.targets[i];
    if (tg.kind === 'bystander' || !inst.aliveAt(i, t)) continue;
    const x = inst.xAt(i, t);
    if (Math.abs(x) > 7) continue;
    if (tg.value > bestVal) { bestVal = tg.value; best = i; }
  }
  if (best < 0) return makeInput();
  return shotAt(inst.xAt(best, t), inst.yAt(best));
}

// ---------------------------------------------------------------------------

describe('LuckyShotRite — the shared contract', () => {
  it('passes assertRiteContract', () => {
    assertRiteContract(LUCKY_SHOT_RITE, { randCalls: RAND_CALLS, skilled });
  });

  it('draws exactly 24 seeded values, and the constant says so', () => {
    // Written out rather than derived: the harness compares init's behaviour to
    // RAND_CALLS, so if both drifted together nothing would notice. This pins
    // the constant itself to a number a human agreed to.
    expect(RAND_CALLS).toBe(24);
  });

  it('gives two seeds two different galleries', () => {
    // Otherwise the determinism and budget tests both pass on a rite that
    // ignores its seed entirely.
    const a = spawn({ seed: 1 });
    const b = spawn({ seed: 2 });
    const lanes = (inst) => inst.targets.map((tg) => tg.lane);
    expect(lanes(b)).not.toEqual(lanes(a));
    expect([b.golden, b.bystander]).not.toEqual([a.golden, a.bystander]);
  });

  it('never puts the golden and the bystander on the same target', () => {
    // The bystander is drawn over TARGETS-1 and shifted past the golden, which
    // is the branch-free way to get a distinct index. Swept over many seeds
    // because a collision would be a one-in-eighteen bug.
    for (let seed = 0; seed < 200; seed++) {
      const inst = spawn({ seed });
      expect(inst.golden, `seed ${seed}`).not.toBe(inst.bystander);
      expect(inst.targets.filter((t) => t.kind === 'golden')).toHaveLength(1);
      expect(inst.targets.filter((t) => t.kind === 'bystander')).toHaveLength(1);
    }
  });
});

describe('LuckyShotRite — the click queue', () => {
  /**
   * THE TEST THE WHOLE WAVE 0 INPUT CHANGE EXISTS FOR.
   *
   * A press resolves where it was pressed. `x/y` is left at a second press's
   * position, as the host leaves it, so a rite that read `input.x/y` would fire
   * the first round at the wrong place. The second press falls inside RACK and
   * is dropped without costing a round.
   */
  it('resolves a click where it was pressed, and drops a second one inside the rack', () => {
    const inst = spawn({ seed: 77 });
    const found = findTwoClean(inst);
    expect(found, 'no two clean targets found in 15 s — the layout changed').not.toBeNull();

    runTo(inst, found.n);
    expect(Math.abs(found.ax - found.bx)).toBeGreaterThan(2.5);   // two real positions

    const before = inst.points;
    inst.update(DT, makeInput({
      // `x/y` is left at the SECOND click's position, exactly as the host would
      // leave it after two pointerdowns — so a rite that read x/y would score
      // the first shot at the second shot's place and this test would fail.
      x: found.bx, y: found.by, inside: true, action: 2,
      clicks: [clickAt(found.ax, found.ay), clickAt(found.bx, found.by)],
    }));

    expect(inst.aliveAt(found.a, inst.t), 'first click did not land where it was pressed').toBe(false);
    expect(inst.aliveAt(found.b, inst.t), 'second click fired while the rifle racked').toBe(true);
    expect(inst.shots).toBe(1);
    expect(inst.hits).toBe(1);
    expect(inst.ammo, 'a dropped press must not cost a round').toBe(AMMO - 1);
    expect(inst.points - before).toBe(inst.targets[found.a].value);
  });

  it('fires on the right button and on a keyboard commit, exactly like the left', () => {
    // All three verbs are equal by design: the original map used right-click,
    // but requiring it taxes a trackpad by the two-finger settle delay.
    for (const [button, source] of [[0, 'pointer'], [2, 'pointer'], [0, 'key']]) {
      const inst = spawn({ seed: 5 });
      const found = findClean(inst, inst.golden === 0 ? 1 : 0);
      runTo(inst, found.n);
      inst.update(DT, makeInput({
        x: found.x, y: found.y, inside: true,
        clicks: [clickAt(found.x, found.y, button, source)],
      }));
      expect(inst.shots, `button ${button} / ${source}`).toBe(1);
      expect(inst.hits, `button ${button} / ${source}`).toBe(1);
    }
  });

  it('ignores action/altAction on their own — the queue is the only trigger', () => {
    // A commit with no queued click cannot exist through the host (it enqueues
    // one for every commit, keyboard included), so this pins the rule rather
    // than a scenario: reading both counters would fire twice per press.
    const inst = spawn();
    inst.update(DT, makeInput({ inside: true, x: 0, y: 0, action: 3, altAction: 2 }));
    expect(inst.shots).toBe(0);
    expect(inst.ammo).toBe(AMMO);
  });
});

describe('LuckyShotRite — hit resolution', () => {
  it('gives one click exactly one target, even inside an overlap', () => {
    const inst = spawn({ seed: 31 });
    const o = findOverlap(inst);
    expect(o, 'the front and middle rows never overlapped — check ROW_TABLE').not.toBeNull();

    // Prove the instrument can fail: the point really is inside BOTH.
    const dFront = Math.hypot(o.px - inst.xAt(o.front, o.t), o.py - inst.yAt(o.front));
    const dBack = Math.hypot(o.px - inst.xAt(o.back, o.t), o.py - inst.yAt(o.back));
    expect(dFront).toBeLessThanOrEqual(inst.targets[o.front].r);
    expect(dBack).toBeLessThanOrEqual(inst.targets[o.back].r);

    runTo(inst, o.n);
    expect(downCount(inst, o.t)).toBe(0);
    inst.update(DT, shotAt(o.px, o.py));
    expect(downCount(inst, inst.t), 'one round knocked down more than one target').toBe(1);
  });

  it('gives the overlap to the frontmost target', () => {
    const inst = spawn({ seed: 31 });
    const o = findOverlap(inst);
    // The rule, stated directly against the resolver…
    expect(inst.hitIndex(o.px, o.py, o.t)).toBe(o.front);
    // …and again through a real shot, because the resolver is only half of it.
    runTo(inst, o.n);
    inst.update(DT, shotAt(o.px, o.py));
    expect(inst.aliveAt(o.front, inst.t)).toBe(false);
    expect(inst.aliveAt(o.back, inst.t)).toBe(true);
  });

  it('cannot hit a target that is lying down', () => {
    const inst = spawn({ seed: 12 });
    const i = inst.golden === 3 ? 4 : 3;
    const f = findClean(inst, i);
    runTo(inst, f.n);
    inst.update(DT, shotAt(f.x, f.y));
    expect(inst.aliveAt(i, inst.t)).toBe(false);

    // Same target, as soon as the rifle is racked, still down: a second round
    // is spent and buys nothing. Without this a player could sit on one cut-out
    // and farm it.
    rack(inst);
    const pts = inst.points;
    const x2 = inst.xAt(i, inst.t + DT);
    inst.update(DT, shotAt(x2, f.y));
    expect(inst.points).toBe(pts);
    expect(inst.shots).toBe(2);
  });

  it('pays the golden target a multiple of its row', () => {
    const inst = spawn({ seed: 88 });
    const g = inst.targets[inst.golden];
    const prize = ROW_TABLE[g.row].value * GOLDEN_MULT;
    expect(g.value).toBe(prize);

    const f = findClean(inst, inst.golden);
    runTo(inst, f.n);
    inst.update(DT, shotAt(f.x, f.y));
    // `prize`, not `g.value` — the claim rewrites the target in place, and a
    // test that read the value AFTER the shot would assert nothing at all.
    expect(inst.points).toBe(prize);
    expect(inst.goldenHits).toBe(1);
    expect(inst.drainEvents().some((e) => e.type === 'perfect')).toBe(true);
  });

  /**
   * THE PRIZE IS TAKEN ONCE, AND THIS IS THE ANTI-CAMPING RULE STATED DIRECTLY.
   *
   * Before it, the golden came back on its own timer worth its full multiple
   * every time, and a bot that fired at NOTHING BUT the golden — never moving,
   * never aiming at anything else — scored 0.740 / 0.700 / 0.735 out of about
   * seven of its twenty-four rounds. Better than a competent player, on a third
   * of the ammo, with no aiming problem to solve. The long down time was meant
   * to prevent exactly that and only changed how profitable the wait was.
   */
  it('pays the golden multiple once, then the cut-out is an ordinary target', () => {
    const inst = spawn({ seed: 88 });
    const i = inst.golden;
    const row = inst.targets[i].row;
    const prize = ROW_TABLE[row].value * GOLDEN_MULT;

    const f = findClean(inst, i);
    runTo(inst, f.n);
    inst.update(DT, shotAt(f.x, f.y));
    expect(inst.points).toBe(prize);

    // It comes back up as a creep: face value, no gold, nothing to camp.
    expect(inst.targets[i].kind).toBe('creep');
    expect(inst.targets[i].value).toBe(ROW_TABLE[row].value);

    // Forward from HERE — `findClean` scans from t = 0, which is in the past.
    stepUntil(inst, (o) => {
      const t = o.t + DT;
      return o.aliveAt(i, t) && Math.abs(o.xAt(i, t)) < 6
        && o.hitIndex(o.xAt(i, t), o.yAt(i), t) === i;
    }, 'the claimed target standing back up in the clear');
    const before = inst.points;
    inst.update(DT, shotAt(inst.xAt(i, inst.t + DT), inst.yAt(i)));
    expect(inst.points - before, 'the prize paid twice').toBe(ROW_TABLE[row].value);
    expect(inst.goldenHits, 'a claimed target still counted as golden').toBe(1);
  });

  it('caps what waiting for the prize can ever be worth', () => {
    /**
     * The measurement the rule above exists for, run rather than quoted.
     *
     * This camper is the strongest possible version of the exploit: it knows
     * which target is golden, it is handed the exact centre so it never misses,
     * and it fires the instant the prize is standing — for the whole clock. It
     * used to bank the multiple over and over. Now the prize is finite by
     * construction, so the ENTIRE rite spent waiting for it is worth one prize:
     * at most 12 of 60, a fifth of the payout, against 24 rounds it
     * never fired. Whatever else a player does, this is not the line.
     */
    for (const seed of [1234, 77, 31337]) {
      const camp = spawn({ seed });
      for (let step = 0; step < Math.ceil(DURATION / DT) + 2; step++) {
        const t = camp.t + DT;
        const i = camp.golden;
        // Only ever fires at a target that is STILL the prize — the point being
        // that after one claim there is nothing here left to wait for.
        const on = camp.targets[i].kind === 'golden'
          && camp.aliveAt(i, t) && Math.abs(camp.xAt(i, t)) < 7;
        if (camp.update(DT, on ? shotAt(camp.xAt(i, t), camp.yAt(i)) : makeInput()) === true) break;
      }
      expect(camp.goldenHits, `seed ${seed}`).toBe(1);
      expect(camp.points, `seed ${seed}`)
        .toBeLessThanOrEqual(ROW_TABLE.at(-1).value * GOLDEN_MULT);
      expect(camp.score().ratio, `seed ${seed}: camping the prize paid too well`)
        .toBeLessThan(0.35);
    }
  });

  it('subtracts for the bystander, and says so', () => {
    const inst = spawn({ seed: 44 });
    expect(inst.targets[inst.bystander].value).toBe(BYSTANDER_VALUE);

    const f = findClean(inst, inst.bystander);
    runTo(inst, f.n);
    inst.update(DT, shotAt(f.x, f.y));

    expect(inst.points).toBe(BYSTANDER_VALUE);
    expect(inst.bystanderHits).toBe(1);
    expect(inst.hits, 'a bystander is not a hit').toBe(0);
    expect(inst.drainEvents().some((e) => e.type === 'break')).toBe(true);
    // Negative points never become a negative payout.
    expect(inst.score().ratio).toBe(0);
    expect(inst.score().detail).toContain('bystander');
  });

  it('hits to the drawn radius and not a millimetre further', () => {
    /**
     * NO AIM ASSIST. The hit radius IS the radius the silhouette is drawn at,
     * and this is the assertion that says so — without it, every "one click,
     * one target" test above still passes with a hitbox twice the size of the
     * picture, which is the single most common way a shooter starts lying to
     * its players. Verified by mutation: doubling the radius turns this red and
     * nothing else in the file notices.
     */
    const inst = spawn({ seed: 63 });
    const i = 0;
    const r = inst.targets[i].r;
    let found = null;
    for (let n = 1; n < 900 && !found; n++) {
      const t = n * DT;
      const x = inst.xAt(i, t), y = inst.yAt(i);
      if (Math.abs(x) > 5) continue;
      // Just inside is this target; just outside is nothing at all — the second
      // half matters, because "outside" must not mean "the row behind".
      if (inst.hitIndex(x + r * 0.96, y, t) !== i) continue;
      if (inst.hitIndex(x + r * 1.06, y, t) !== -1) continue;
      found = { n, t, x, y };
    }
    expect(found, 'no clear edge moment found — the rows may be too crowded').not.toBeNull();

    runTo(inst, found.n);
    inst.update(DT, shotAt(found.x + r * 1.06, found.y));
    expect(inst.hits, 'a shot outside the silhouette scored').toBe(0);
    expect(inst.shots).toBe(1);
  });

  it('charges a round for a miss', () => {
    const inst = spawn();
    // Below the front rail by more than a radius: nothing can be there.
    inst.update(DT, shotAt(0, -4.3));
    expect(inst.ammo).toBe(AMMO - 1);
    expect(inst.shots).toBe(1);
    expect(inst.hits).toBe(0);
    expect(inst.points).toBe(0);
    expect(inst.drainEvents().some((e) => e.type === 'miss')).toBe(true);
  });
});

describe('LuckyShotRite — ammo is the design', () => {
  it('ends the rite when the last round is spent', () => {
    const inst = spawn();
    const miss = shotAt(0, -4.3);
    for (let k = 0; k < AMMO; k++) {
      expect(inst.update(DT, miss), `ended early, after ${k + 1} of ${AMMO} rounds`).not.toBe(true);
      if (k < AMMO - 1) rack(inst);
    }
    expect(inst.ammo).toBe(0);

    // A short hold so the last shot is seen, then it is over, short of the
    // clock: an empty gun ends the rite, it does not leave the player watching
    // a booth until the timer runs out.
    stepUntil(inst, (_i, ended) => ended, 'the rite ending after running dry', 200);
    expect(inst.t).toBeLessThan((AMMO - 1) * RACK + END_HOLD + 4 * DT);
    expect(inst.t).toBeLessThan(DURATION);
  });

  it('spends nothing once the gun is empty', () => {
    const inst = spawn();
    const miss = shotAt(0, -4.3);
    for (let k = 0; k < AMMO + 5; k++) { inst.update(DT, miss); rack(inst); }
    expect(inst.shots).toBe(AMMO);
    expect(inst.ammo).toBe(0);
  });

  it('spends one round on a step of twelve clicks: the rack drops the rest', () => {
    const inst = spawn();
    const clicks = Array.from({ length: 12 }, () => clickAt(0, -4.3));
    inst.update(DT, makeInput({ x: 0, y: -4.3, inside: true, clicks }));
    expect(inst.shots).toBe(1);
    expect(inst.ammo).toBe(AMMO - 1);
  });

  it('lasts at least AMMO racks for a player who presses on every step', () => {
    // The mash that used to end the rite in about two seconds.
    const inst = spawn();
    const miss = shotAt(0, -4.3);
    let n = 0;
    while (inst.update(DT, miss) !== true && n < Math.ceil(DURATION / DT) + 60) n++;
    expect(inst.shots).toBe(AMMO);
    expect(inst.t).toBeGreaterThanOrEqual((AMMO - 1) * RACK + END_HOLD - DT);
  });

  it('scores a do-nothing run at exactly zero', () => {
    const inst = spawn();
    const n = stepUntil(inst, (_i, ended) => ended, 'an idle run ending');
    expect(inst.t).toBeGreaterThanOrEqual(DURATION - DT);
    expect(inst.ammo).toBe(AMMO);
    expect(inst.score().ratio).toBe(0);
    expect(n).toBeLessThanOrEqual(Math.ceil(DURATION / DT) + 1);
  });
});

describe('LuckyShotRite — score', () => {
  it('reaches a full ratio at PAR and clamps above it', () => {
    const inst = spawn();
    inst.points = PAR;
    expect(inst.score().ratio).toBe(1);
    inst.points = PAR * 3;
    expect(inst.score().ratio).toBe(1);
    inst.points = -9;
    expect(inst.score().ratio).toBe(0);
  });

  it('is a constant bar across waves, on purpose', () => {
    // The reward already scales with the next wave's gross (contract.js
    // minigameReward). Indexing PAR too would charge the player twice for the
    // same wave. The FIELD is what the wave moves; see the next test.
    const early = spawn({ wave: 3 });
    const late = spawn({ wave: 53 });
    early.points = 20; late.points = 20;
    expect(late.score().ratio).toBe(early.score().ratio);
  });
});

describe('LuckyShotRite — what the wave actually moves', () => {
  /**
   * THE ONE THING THE CALIBRATION GATE CAUGHT HERE.
   *
   * Row speed was the only wave lever, and the harness measured what it was
   * worth: the reference player scored 0.863 at wave 3 and 0.937 at wave 53 —
   * the rite got EASIER as the run got harder, which makes `wave` meaningless as
   * a difficulty axis for every rite, not only this one. A hand that tracks a
   * belt does not care how fast the belt goes. A hand with half a centimetre of
   * wobble cares enormously how big the target is.
   */
  it('shrinks and quickens the valuable row, and only that row', () => {
    const early = spawn({ wave: 3 });
    const late = spawn({ wave: 53 });

    // The back row — the one worth 3 — is the whole lever.
    expect(late.rowR[2]).toBeLessThan(early.rowR[2] * 0.7);
    expect(late.rowSpeed[2]).toBeGreaterThan(early.rowSpeed[2] * 1.4);

    // The front two ranks do not shrink by a hair. They are the honest fallback
    // for a player who cannot hit the back row late, and — see ROW_TABLE — their
    // radii are what makes `hitIndex`'s frontmost rule have a case at all.
    expect(late.rowR[0]).toBe(early.rowR[0]);
    expect(late.rowR[1]).toBe(early.rowR[1]);

    // A target's own radius is the row's, so the hit test moves with the picture
    // rather than beside it.
    expect(late.targets[2 * PER_ROW].r).toBe(late.rowR[2]);
  });

  it('keeps the front-two overlap at the last wave as well as the first', () => {
    // The rule "the frontmost target wins" needs a real overlap to be a rule
    // about anything, and the wave must not quietly delete it late in a run.
    for (const wave of [3, 28, 53]) {
      const inst = spawn({ seed: 31, wave });
      expect(findOverlap(inst), `no front/middle overlap at wave ${wave}`).not.toBeNull();
    }
  });

  it('never lets two neighbours in a row close inside their own radii', () => {
    /**
     * THE PILE, AS AN ASSERTION. The lane jitter was +-0.34 of a slot, so two
     * neighbours could each lean 1.13 u towards one another and end up 1.07 u
     * apart — inside the 1.72 u sum of two front-row radii. On a screenshot that
     * is not a procession with character, it is two cut-outs drawn on top of
     * each other beside a three-unit hole.
     */
    for (let seed = 0; seed < 60; seed++) {
      const inst = spawn({ seed });
      for (let row = 0; row < ROW_TABLE.length; row++) {
        for (let col = 1; col < PER_ROW; col++) {
          const a = inst.targets[row * PER_ROW + col - 1];
          const b = inst.targets[row * PER_ROW + col];
          expect(b.lane - a.lane, `seed ${seed}, row ${row}, cols ${col - 1}/${col}`)
            .toBeGreaterThan(a.r + b.r);
        }
      }
    }
  });

  it('varies structure on a second visit without varying difficulty', () => {
    // `occurrence` is allowed to change the shape of the world and nothing else
    // (contract.js). Every belt runs the other way; not one number moves.
    const a = spawn({ seed: 9, occurrence: 0 });
    const b = spawn({ seed: 9, occurrence: 1 });
    expect(b.rowR).toEqual(a.rowR);
    expect(b.rowSpeed).toEqual(a.rowSpeed);
    expect(b.dirFlip).toBe(-a.dirFlip);
    const dir = (inst, i) => Math.sign(inst.xAt(i, 1.0) - inst.xAt(i, 0.9));
    for (let i = 0; i < TARGETS; i++) expect(dir(b, i), `target ${i}`).toBe(-dir(a, i));
  });
});

describe('LuckyShotRite — what the view is handed', () => {
  /**
   * The 3D view (LuckyShotView.js) starts every effect — muzzle flash, recoil,
   * the target falling, the plate shattering, the bullet hole — from the ONE
   * cue each round emits. A round that emitted nothing would fire silently and
   * invisibly; one that emitted two would flash twice. So the count is pinned,
   * and so is what the cue carries.
   */
  it('emits exactly one positioned cue per round, naming what it hit', () => {
    const inst = spawn({ seed: 21 });
    const f = findClean(inst, inst.golden);
    runTo(inst, f.n);
    inst.drainEvents();
    inst.update(DT, shotAt(f.x, f.y));
    rack(inst);
    inst.update(DT, shotAt(0, 4.2));
    const ev = inst.drainEvents();
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ type: 'perfect', i: inst.golden, value: ROW_TABLE[inst.targets[inst.golden].row].value * GOLDEN_MULT });
    expect(ev[0].x).toBeCloseTo(f.x, 6);
    expect(ev[1]).toEqual({ type: 'miss', x: 0, y: 4.2, i: -1, value: 0 });
  });

  it('hands the view a cosmetic seed without spending a gameplay draw on it', () => {
    const a = spawn({ seed: 5 });
    const b = spawn({ seed: 6 });
    expect(Number.isInteger(a.fxSeed)).toBe(true);
    expect(a.fxSeed).not.toBe(b.fxSeed);
  });
});
