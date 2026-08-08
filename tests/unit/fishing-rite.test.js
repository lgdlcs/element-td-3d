/**
 * FISHING — the rite whose whole reason to exist is that it is NOT `hunt`.
 *
 * `assertRiteContract` covers what every rite owes the host. This file covers
 * the four claims that are specific to this one, in descending order of how
 * badly the rite is broken if one of them stops holding:
 *
 *   1. THE LEADING SHOT, AND THAT IT IS A PER-FISH ONE. A cast aimed at where a
 *      fish IS misses; the same cast aimed at where it WILL BE when the hook
 *      lands, hits. If this ever passes in both directions, `fishing` has
 *      silently become a reaction shooter and two of the eleven rites in a run
 *      are the same game.
 *
 *      THAT PAIR IS NOT ENOUGH ON ITS OWN AND FOR A LONG TIME IT WAS ALL THERE
 *      WAS. "Some lead beats no lead" is satisfied by a player who has memorised
 *      ONE NUMBER, and that is exactly what a player was doing: measured against
 *      the rite as originally tuned, a bot casting a fixed 1.2 units ahead of
 *      every nose — no velocity model at all — scored 1.00 / 1.00 / 0.96 across
 *      waves 3 / 28 / 53. The file now also measures the best constant available
 *      at each wave and requires it to lose, which is the claim the rite's whole
 *      docblock actually makes.
 *   2. The reel, and everything else that is SCARCE. An empty cast costs a
 *      second or more of a twenty-second rite, and both reels — plus the rivals'
 *      whole claim schedule — tighten with the wave. Before that they did not,
 *      and the rite measured a flat 1.00 from wave 3 to wave 53 because thirty
 *      casts chased sixteen fish at every difficulty.
 *   3. The deadline. A hook that lands after a rival's claim time does not
 *      count — strictly.
 *   4. The golden fish is worth 3x, and an idle run is worth 0.
 *
 * Plus the two structural rules that no rite may break and that the shared
 * harness cannot check for it: `draw` does not mutate, and the seed actually
 * lays out the water (otherwise the determinism assertions all pass on a rite
 * that ignores its seed entirely).
 *
 * `node` environment: this file imports no DOM and the rite guards its one
 * getComputedStyle, so the palette resolves to its literal fallbacks here.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput, clickAt } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { Painter } from '../../src/minigames/Painter.js';
import { assertRiteContract } from './helpers/rite-contract.js';
import {
  FISHING_RITE, RAND_CALLS, SINK, REEL_EMPTY, REEL_HELD, REEL_WAVE, CLAIM_SQUEEZE,
  FISH, PAR, PAR_FRACTION, GOLD_VALUE, GHOST_CASTS, SURFACE, SURFACE_AMP, SHALLOW,
  HOOK_R, SPEED_MIN, SPEED_MAX, LEN_MAX, DEEP, DURATION, SWIMMING, KEPT,
} from '../../src/minigames/rites/FishingRite.js';

const DT = MINIGAMES.dt;

/** A live instance, without a host. */
function spawn({ seed = 1234, occurrence = 0, wave = 8 } = {}) {
  const inst = FISHING_RITE.create();
  inst.init({
    rand: riteRng(seed, FISHING_RITE.id, occurrence),
    wave, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/** Step with no input. */
function idle(inst, steps) {
  for (let i = 0; i < steps; i++) { inst.update(DT, makeInput()); inst.drainEvents(); }
}

/**
 * Cast at (x, y) on the NEXT step, and report the instant the hook will land.
 *
 * The landing time has to be predicted rather than read back, because the whole
 * point of the rite is that the aim point is a function of it. `update` advances
 * `t` before it looks at the queue, so a click delivered now lands at
 * `t + DT + SINK`.
 */
function landingTime(inst) { return inst.t + DT + SINK; }
function cast(inst, x, y, button = 0) {
  inst.update(DT, makeInput({ x, y, inside: true, action: 1, clicks: [clickAt(x, y, button, 'pointer')] }));
  inst.drainEvents();
}

/**
 * Find a fish that can be aimed at cleanly at time `tl`.
 *
 * Three conditions, all of them there to make the leading-shot assertion mean
 * exactly one thing:
 *   - it is still swimming and its deadline is comfortably beyond `tl`, so a
 *     miss is a miss and not a rival's claim;
 *   - both the "now" point and the "then" point are inside the field, so
 *     neither is clamped by the cast (a clamped aim point is not the aim the
 *     test wrote);
 *   - NO OTHER FISH overlaps either point at `tl`, so a hit is this fish and a
 *     miss is not a neighbour caught by accident.
 */
function isolatedFish(inst, tl) {
  for (let i = 0; i < FISH; i++) {
    const f = inst.fish[i];
    if (f.state !== SWIMMING || inst.claimAt[i] < tl + 1.5) continue;
    const nowX = inst.fishX(f, inst.t);
    const nowY = inst.fishY(f, inst.t);
    const thenX = inst.fishX(f, tl);
    const thenY = inst.fishY(f, tl);
    if (Math.abs(nowX) > 6.8 || Math.abs(thenX) > 6.8) continue;
    // The wrap seam: if the fish crossed it between now and then, "ahead" and
    // "behind" swap sign and the test would be aiming at the wrong side.
    if (Math.abs(thenX - nowX) > 3) continue;
    let clean = true;
    for (let j = 0; j < FISH && clean; j++) {
      if (j === i || inst.fish[j].state !== SWIMMING) continue;
      if (inst.overlaps(inst.fish[j], tl, nowX, nowY)) clean = false;
      if (inst.overlaps(inst.fish[j], tl, thenX, thenY)) clean = false;
    }
    if (clean) return { i, f, nowX, nowY, thenX, thenY };
  }
  return null;
}

// ===========================================================================

describe('FishingRite — the contract', () => {
  it('passes the shared rite checklist', () => {
    assertRiteContract(FISHING_RITE, { randCalls: RAND_CALLS, skilled: SKILLED });
  });

  it('draws exactly RAND_CALLS values, and the arithmetic behind the constant holds', () => {
    let calls = 0;
    const inst = FISHING_RITE.create();
    inst.init({ rand: () => (calls++, 0.5), wave: 41, width: 16, height: 9, quality: 'low' });
    expect(calls).toBe(RAND_CALLS);
    // 16 fish x 5 + 1 golden + 3 rivals x 4 + 1 presentation seed.
    expect(RAND_CALLS).toBe(94);
  });

  it('lays the water out from the seed', () => {
    // Without this, every determinism assertion above passes just as happily on
    // a rite that ignores ctx.rand entirely.
    const a = spawn({ seed: 11 });
    const b = spawn({ seed: 12 });
    const xs = (i) => i.fish.map((f) => Math.round(f.x0 * 1000));
    expect(xs(a)).not.toEqual(xs(b));
    expect(a.roster.map((r) => r.name)).not.toEqual(b.roster.map((r) => r.name));
  });

  it('shares one roster and one set of deadlines for a given seed', () => {
    // The multiplayer claim, such as it is: two players in a room draw the same
    // seed, so they face the same three names on the same schedule. What is
    // LOST is real-time competition — "first to click wins" has degraded into
    // "beat a deadline that has a name on it", and the deadline does not care
    // whether the other player is having a good run. What is KEPT is that two
    // scores from the same room are comparable afterwards.
    const a = spawn({ seed: 77, occurrence: 2, wave: 23 });
    const b = spawn({ seed: 77, occurrence: 2, wave: 23 });
    expect(a.roster.map((r) => `${r.name}:${r.skill}`)).toEqual(b.roster.map((r) => `${r.name}:${r.skill}`));
    expect(Array.from(a.claimAt)).toEqual(Array.from(b.claimAt));
  });

  it('never mutates state in draw()', () => {
    const inst = spawn({ seed: 5 });
    idle(inst, 200);
    cast(inst, 2.4, -1.1);
    idle(inst, 10);
    const g = recordingPainter();
    const before = JSON.stringify(inst, replacer);
    inst.draw(g, 0);
    inst.draw(g, 0.5);
    inst.draw(g, 0.99);
    expect(JSON.stringify(inst, replacer)).toBe(before);
    // And it actually drew the whole scene — a draw() that bailed out early
    // would trivially "not mutate".
    expect(g.calls).toBeGreaterThan(600);
    // The two primitives this rite's look depends on and which nothing else
    // would notice the loss of: the water's depth ramp and the surface clip.
    expect(g.names).toContain('linear');
    expect(g.names).toContain('clip');
    expect(g.names).toContain('quadraticCurveTo');   // blob — the fish bodies
  });

  it('draws every phase of a cast without a non-finite coordinate', () => {
    // One NaN in a path blanks the frame with no error attached and no stack to
    // read (docs/PITFALLS.md §9). The sink, the settle and the linger are three
    // different branches of #drawHook, and the empty-water path is a fourth.
    const inst = spawn({ seed: 314, wave: 41 });
    const g = recordingPainter();
    for (let i = 0; i < 1200; i++) {
      if (i % 90 === 40) cast(inst, ((i % 7) - 3) * 1.7, -1.5 - (i % 5) * 0.4);
      else { inst.update(DT, makeInput({ x: (i % 13) - 6, y: -1, inside: i % 17 !== 0 })); inst.drainEvents(); }
      inst.draw(g, (i % 6) / 6);
    }
    expect(inst.casts).toBeGreaterThan(5);
    expect(inst.empties + inst.kept).toBe(inst.casts);
  });
});

// ===========================================================================

describe('FishingRite — the leading shot', () => {
  it('has fish that out-swim their own catch window, at the worst corner', () => {
    // If this inequality ever fails, aiming AT a fish starts working and the
    // rite silently collapses into `hunt`. Asserted rather than trusted to a
    // comment, because it is a relationship between four constants that will be
    // tuned separately by four different people.
    const widestCatch = LEN_MAX * 0.5 + HOOK_R;
    expect(SPEED_MIN * SINK).toBeGreaterThan(widestCatch);
  });

  it('MISSES a cast aimed at where the fish is, and HITS one aimed at where it will be', () => {
    // THE assertion this rite exists for. Run twice from the same state — once
    // aiming at the present, once at the future — so the only difference
    // between the two runs is the aim point.
    const probe = spawn({ seed: 4242, wave: 8 });
    idle(probe, 12);
    const tl = landingTime(probe);
    const pick = isolatedFish(probe, tl);
    expect(pick, 'seed 4242 offered no cleanly isolated fish 12 steps in').toBeTruthy();

    const now = spawn({ seed: 4242, wave: 8 });
    idle(now, 12);
    cast(now, pick.nowX, pick.nowY);
    idle(now, Math.ceil(SINK / DT) + 2);
    expect(now.kept, 'aiming at the fish\'s CURRENT position must miss').toBe(0);
    expect(now.empties).toBe(1);

    const lead = spawn({ seed: 4242, wave: 8 });
    idle(lead, 12);
    cast(lead, pick.thenX, pick.thenY);
    idle(lead, Math.ceil(SINK / DT) + 2);
    expect(lead.kept, 'aiming at the fish\'s position at t+SINK must land it').toBe(1);
    expect(lead.fish[pick.i].state).toBe(KEPT);
  });

  it('holds the leading rule across several seeds', () => {
    // One seed proving it is a coincidence away from being a bad test. Every
    // seed that offers an isolated fish must show the same pair of outcomes.
    let checked = 0;
    for (const seed of [3, 19, 88, 401, 1207, 9001]) {
      const probe = spawn({ seed, wave: 14 });
      idle(probe, 20);
      const tl = landingTime(probe);
      const pick = isolatedFish(probe, tl);
      if (!pick) continue;
      checked++;

      const a = spawn({ seed, wave: 14 });
      idle(a, 20);
      cast(a, pick.nowX, pick.nowY);
      idle(a, Math.ceil(SINK / DT) + 2);

      const b = spawn({ seed, wave: 14 });
      idle(b, 20);
      cast(b, pick.thenX, pick.thenY);
      idle(b, Math.ceil(SINK / DT) + 2);

      expect(a.kept, `seed ${seed}: aiming at the present should miss`).toBe(0);
      expect(b.kept, `seed ${seed}: aiming at t+SINK should hit`).toBe(1);
    }
    expect(checked, 'no seed produced a testable fish — the helper is too strict').toBeGreaterThanOrEqual(4);
  });

  it('punishes a player who plays it like `hunt`', () => {
    // THE claim that justifies shipping two rites with one competitive rule,
    // stated as a number instead of as an argument. NO_LEAD is a perfect
    // REACTION player: it always finds a live fish and always puts the hook
    // exactly on it, with zero human error. If `fishing` were `hunt` with
    // different sprites, that player would score 1.0.
    //
    // Measured across six seeds at wave 28: 1.000 for the leading player,
    // 0.236 for the reaction player — and the 0.236 is not skill, it is the
    // occasional lucky collision with a NEIGHBOURING fish in a shoal. Four
    // times the score for the same reflexes and a different question answered.
    const avg = (strategy) => {
      let s = 0;
      for (const seed of [1, 2, 3, 4, 5, 909]) s += playOut(seed, 28, strategy).score().ratio;
      return s / 6;
    };
    const lead = avg(SKILLED);
    const react = avg(NO_LEAD);
    expect(lead).toBeGreaterThan(0.9);
    expect(react).toBeLessThan(lead * 0.5);
  });

  it('is not playable with ONE memorised offset, at any wave', () => {
    // THE ASSERTION THAT WAS MISSING, and its absence is what let this rite
    // claim a mechanic it did not have. The old suite proved only that SOME lead
    // beats NO lead, which a single constant satisfies — and a single constant
    // is exactly what a player was using, because with a speed band 1.7x wide
    // and a catch ellipse half a unit across, "1.2 units ahead of the nose"
    // covered the whole shoal. Measured then: 1.000 / 1.000 / 0.960 at waves
    // 3 / 28 / 53, against 1.000 / 1.000 / 1.000 for a bot that computed the
    // real lead per fish. There was nothing to read.
    //
    // The band is 2.6x wide now and the ellipse is narrower than the spread it
    // has to resolve, so a memorised offset is a rule that fits some of the
    // shoal and misses the rest — and misses cost a reel. FIXED_LEAD is given
    // the BEST constant available at each wave (searched, not guessed), so this
    // is the strongest version of that player, not a strawman.
    for (const wave of [3, 28, 53]) {
      const lead = avgOver(SKILLED, wave);
      let best = 0;
      for (let c = 0.4; c <= 3.6; c += 0.2) best = Math.max(best, avgOver(fixedLead(c), wave));
      expect(lead, `wave ${wave}: the real lead should still clear par`).toBeGreaterThan(0.9);
      expect(best, `wave ${wave}: the best single constant scored ${best.toFixed(3)} — `
        + 'a memorised offset must not be able to play this rite')
        .toBeLessThan(0.8);
    }
    // And it must get WORSE as the shoal speeds up, not better: the wave widens
    // the spread of leads, so one number covers less of it.
    let bestEarly = 0, bestLate = 0;
    for (let c = 0.4; c <= 3.6; c += 0.2) {
      bestEarly = Math.max(bestEarly, avgOver(fixedLead(c), 3));
      bestLate = Math.max(bestLate, avgOver(fixedLead(c), 53));
    }
    expect(bestLate).toBeLessThan(bestEarly - 0.2);
  });

  it('spreads the required lead wider than the window that forgives it', () => {
    // The inequality behind the test above, stated over constants so a future
    // tuner sees WHY the speed band is that wide. The lead a fish demands is
    // |v| * SINK; the widest catch ellipse forgives LEN_MAX + 2 * HOOK_R of
    // horizontal error. If the spread of demands is not several windows across,
    // one offset covers the lake.
    const spread = (SPEED_MAX - SPEED_MIN) * SINK;
    const window = LEN_MAX + 2 * HOOK_R;
    expect(spread).toBeGreaterThan(window * 1.5);
  });

  it('does not catch what the lure falls PAST on the way down', () => {
    // The rule that keeps the leading shot from decaying into a swept line: a
    // sinking lure is closed, and only the settle fishes. A fish sitting on the
    // vertical path but not at the landing depth must survive.
    const inst = spawn({ seed: 620, wave: 8 });
    idle(inst, 30);
    const tl = landingTime(inst);
    const pick = isolatedFish(inst, tl);
    expect(pick).toBeTruthy();
    // Aim at the fish's future x, but two units below its depth: the lure
    // passes through the fish and keeps going.
    cast(inst, pick.thenX, pick.thenY - 2.0);
    idle(inst, Math.ceil(SINK / DT) + 2);
    expect(inst.fish[pick.i].state).toBe(SWIMMING);
  });
});

// ===========================================================================

describe('FishingRite — the reel', () => {
  it('blocks the next cast for REEL_EMPTY after a cast that caught nothing', () => {
    const inst = spawn({ seed: 31, wave: 3 });
    idle(inst, 6);
    const tl = landingTime(inst);
    // The silt floor: nothing swims down there, so this is an empty cast by
    // construction rather than by luck.
    cast(inst, 0, -4.0);
    expect(inst.casts).toBe(1);

    // Try to cast on EVERY step until well past the reel, counting how many are
    // accepted and when. This is the anti-mash rule measured, not asserted.
    let acceptedAt = -1;
    for (let i = 0; i < 120 && acceptedAt < 0; i++) {
      inst.update(DT, makeInput({ x: 0, y: -4.0, inside: true, action: 1, clicks: [clickAt(0, -4.0, 0, 'pointer')] }));
      inst.drainEvents();
      if (inst.casts === 2) acceptedAt = inst.t;
    }
    expect(inst.empties).toBe(1);
    expect(acceptedAt).toBeGreaterThan(0);
    // The rod frees at landAt + the reel for THIS wave; the first step at or
    // past that is within one DT of it. `inst.reelEmpty` and not the module
    // constant, because the reel is a function of the wave now — that is the
    // whole scarcity fix and reading the constant here would pin the old rite.
    expect(inst.reelEmpty).toBeCloseTo(REEL_EMPTY, 10);   // wave 8 ~ the base
    expect(acceptedAt).toBeGreaterThanOrEqual(tl + inst.reelEmpty);
    expect(acceptedAt).toBeLessThan(tl + inst.reelEmpty + 2 * DT);
  });

  it('reels in faster after a catch than after a miss, at every wave', () => {
    // The asymmetry is the reward: a good read buys you back most of a second.
    expect(REEL_HELD).toBeLessThan(REEL_EMPTY);
    expect(REEL_EMPTY).toBe(0.7);
    for (const wave of [3, 28, 53]) {
      const inst = spawn({ seed: 5, wave });
      expect(inst.reelHeld).toBeLessThan(inst.reelEmpty);
    }
  });

  it('spends at most one cast per step, however many clicks arrive', () => {
    const inst = spawn({ seed: 44, wave: 8 });
    idle(inst, 4);
    inst.update(DT, makeInput({
      x: 0, y: -4.0, inside: true, action: 3,
      clicks: [clickAt(-3, -4, 0, 'pointer'), clickAt(0, -4, 0, 'pointer'), clickAt(3, -4, 2, 'pointer')],
    }));
    expect(inst.casts).toBe(1);
    // And the one it took is the FIRST, at the position captured at the press —
    // not input.x, which is where the pointer had drifted to by the end of the
    // step. That is the entire reason the click queue exists.
    expect(inst.hook.x).toBe(-3);
  });

  it('accepts left click, right click and a keyboard commit identically', () => {
    // Right-click is supported because the original used it. It is never
    // REQUIRED, because a trackpad's two-finger secondary click has a settling
    // delay, and a rite whose verb is timing must not handicap one platform.
    for (const [button, source] of [[0, 'pointer'], [2, 'pointer'], [0, 'key']]) {
      const inst = spawn({ seed: 8, wave: 8 });
      idle(inst, 3);
      inst.update(DT, makeInput({
        x: 1.5, y: -2, inside: true,
        action: button === 0 ? 1 : 0, altAction: button === 2 ? 1 : 0,
        clicks: [clickAt(1.5, -2, button, source)],
      }));
      expect(inst.casts, `button ${button} / ${source} must cast`).toBe(1);
    }
  });

  it('clamps a cast into the water', () => {
    const inst = spawn({ seed: 9, wave: 8 });
    idle(inst, 3);
    // A keyboard commit fires at the last pointer position, which can be dry
    // land or off the field entirely.
    cast(inst, 99, 4.4);
    expect(inst.hook.y).toBeLessThan(SURFACE);
    expect(Math.abs(inst.hook.x)).toBeLessThanOrEqual(FIELD.hw);
  });
});

// ===========================================================================

describe('FishingRite — the rivals', () => {
  it('does not count a hook that lands after the deadline', () => {
    const inst = spawn({ seed: 150, wave: 8 });
    // Pick a fish and let its deadline pass, then land a perfect leading cast
    // on it. The aim is right; the clock is not.
    const target = 0;
    const deadline = inst.claimAt[target];
    idle(inst, Math.ceil((deadline + 0.2) / DT));
    expect(inst.fish[target].state).not.toBe(SWIMMING);
    expect(inst.lost).toBeGreaterThan(0);

    const tl = landingTime(inst);
    const f = inst.fish[target];
    cast(inst, inst.fishX(f, tl), inst.fishY(f, tl));
    idle(inst, Math.ceil(SINK / DT) + 2);
    expect(inst.kept).toBe(0);
    expect(inst.points).toBe(0);
  });

  it('claims strictly: the deadline is the fastest rival on a frozen schedule', () => {
    const inst = spawn({ seed: 150, wave: 8 });
    // The schedule is cached at init because this rite never calls
    // applyPenalty — there is no verb in fishing that slows a rival down. If a
    // later edit adds one, this assertion is what will fail.
    //
    // SCALED, never replaced: rivals.js publishes the rhythm and says in as many
    // words that a rite wanting a different one "scales the RESULT". The wave
    // decides how fast the field's afternoon runs; the source still decides the
    // order and the names, which is what the `claimBy` assertion below pins.
    for (let i = 0; i < FISH; i++) {
      expect(inst.claimAt[i]).toBeCloseTo(inst.rivals.claimTime(i) * inst.claimScale, 12);
    }
    // Deadlines march outward with the index, so fish come under pressure one
    // at a time rather than all at once.
    for (let i = 1; i < FISH; i++) expect(inst.claimAt[i]).toBeGreaterThan(inst.claimAt[i - 1]);
  });

  it('faces a harder field on a later wave', () => {
    const early = spawn({ seed: 61, wave: 3 });
    const late = spawn({ seed: 61, wave: 53 });
    expect(late.claimAt[5]).toBeLessThan(early.claimAt[5]);
    // And faster fish, which is a longer required lead rather than a smaller
    // hit window — difficulty the player can see coming.
    expect(late.speedMul).toBeGreaterThan(early.speedMul);
    expect(Math.abs(late.fish[0].v)).toBeGreaterThan(Math.abs(early.fish[0].v));
  });

  it('flashes a rival name for a fish it takes, and tallies it', () => {
    const inst = spawn({ seed: 150, wave: 8 });
    const evs = [];
    for (let i = 0; i < 300; i++) { inst.update(DT, makeInput()); evs.push(...inst.drainEvents()); }
    const claims = evs.filter((e) => e.type === 'claim');
    expect(claims.length).toBe(inst.lost);
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) expect(Number.isFinite(c.x)).toBe(true);
    expect(Array.from(inst.tally).reduce((a, b) => a + b, 0)).toBe(inst.lost);
    // More than one angler is on the water. NOT "all three": the claimant of a
    // fish is now `RivalSource.claimant(i)`, the argmin of a real schedule,
    // rather than the old `i % RIVALS` round robin — so a slow angler CAN go a
    // round without taking anything, and a test that demanded all three would be
    // pinning the round robin rather than the rule. What must never come back is
    // ONE name on every fish, which is what the source published before it had
    // a `claimant` at all.
    const used = Array.from(inst.tally).filter((n) => n > 0).length;
    expect(used, `tally ${Array.from(inst.tally)}`).toBeGreaterThan(1);
    // And the name is the schedule's, not a decoration beside it.
    for (let i = 0; i < inst.claimBy.length; i++) {
      expect(inst.claimBy[i]).toBe(inst.rivals.claimant(i).id);
    }
  });
});

// ===========================================================================

describe('FishingRite — what is scarce', () => {
  it('makes the wave take the water away, not just speed it up', () => {
    // The rite's original failure in one assertion. `speedMul` and the old
    // `shallowBias` moved nothing a player could feel: the cast cycle was 0.65 s
    // against a claim every 1.35 s, so thirty casts chased sixteen fish at every
    // wave and the calibration harness read a FLAT 1.00 from wave 3 to wave 53.
    // Two things have to tighten with the wave or there is no curve: how long
    // the lake lasts, and how many casts fit inside it.
    const early = spawn({ seed: 61, wave: 3 });
    const late = spawn({ seed: 61, wave: 53 });

    // 1. THE WATER RUNS OUT SOONER. The last fish's deadline is the moment the
    //    lake is empty whatever the player does.
    expect(late.claimAt[FISH - 1]).toBeLessThan(early.claimAt[FISH - 1] * 0.9);
    expect(early.claimAt[FISH - 1]).toBeGreaterThan(DURATION);   // wave 3: the clock binds
    expect(late.claimAt[FISH - 1]).toBeLessThan(DURATION);       // wave 53: the water binds

    // 2. AND A CAST COSTS MORE OF IT. Both reels lengthen, so the same twenty
    //    seconds buys fewer attempts and a wasted one costs a larger share.
    expect(late.reelHeld).toBeGreaterThan(early.reelHeld * 1.2);
    expect(late.reelEmpty).toBeGreaterThan(early.reelEmpty * 1.2);
    expect(REEL_WAVE).toBeGreaterThan(0);
    expect(CLAIM_SQUEEZE).toBeGreaterThan(0);

    // The two together, as the number that actually decides the rite: how many
    // casts fit between the start and the moment the water is gone.
    const budget = (i) => Math.min(DURATION, i.claimAt[FISH - 1]) / (SINK + i.reelHeld);
    expect(budget(late)).toBeLessThan(budget(early) * 0.8);
  });

  it('does not make the shoal DENSER as the wave rises', () => {
    // The bug that made the rite get easier as it got harder, pinned. The wave
    // used to empty the top third of the water column, which packed sixteen fish
    // into two thirds of the lake — and a near-miss in a dense shoal blunders
    // into a neighbour. Depth is stratified and wave-invariant now: the same
    // sixteen bands at wave 3 and at wave 53.
    const early = spawn({ seed: 77, wave: 3 });
    const late = spawn({ seed: 77, wave: 53 });
    const depths = (i) => i.fish.map((f) => f.depth).sort((a, b) => a - b);
    expect(depths(late)).toEqual(depths(early));
    // One fish per band, so the column is covered on every seed.
    for (const inst of [early, late]) {
      const d = depths(inst);
      for (let k = 1; k < d.length; k++) expect(d[k] - d[k - 1]).toBeGreaterThan(0);
      expect(d[0]).toBeGreaterThan(DEEP);
      expect(d[d.length - 1]).toBeLessThanOrEqual(SHALLOW);
    }
    // And the shallowest fish clears the deepest TROUGH the waterline reaches,
    // because the water is drawn as a polygon along that line now rather than as
    // a rectangle at SURFACE. A fish whose back reached the trough would be
    // sliced by its own lake — the arithmetic that used to be a comment.
    expect(SHALLOW + 0.2 + LEN_MAX * 0.17).toBeLessThan(SURFACE - SURFACE_AMP);
  });

  it('deals the same shoal of speeds and the same eight-and-eight of directions', () => {
    // Not tidiness: it is what makes the rite the SAME QUESTION on every seed.
    // A free draw can deal sixteen fish inside half a unit of each other's lead,
    // and that run is one where a single offset works all afternoon — the exact
    // failure the widened band exists to prevent, arriving by luck instead of by
    // design. It can also deal thirteen fish swimming the same way, and a
    // one-directional shoal is a lead that is always to the right.
    for (const seed of [3, 19, 401]) {
      const inst = spawn({ seed, wave: 8 });
      const right = inst.fish.filter((f) => f.v > 0).length;
      expect(right, `seed ${seed} dealt ${right} fish to the right`).toBe(FISH / 2);
      const leads = inst.fish.map((f) => Math.abs(f.v) * SINK).sort((a, b) => a - b);
      // Slowest to fastest spans more than the window that forgives a bad lead.
      expect(leads[FISH - 1] - leads[0]).toBeGreaterThan(LEN_MAX + 2 * HOOK_R);
    }
  });

  it('spends the lead ghost after three casts and never shows it again', () => {
    // The ghost renders the exact answer the rules are computed from. As a
    // permanent overlay it does not teach the lead, it replaces it — the act
    // becomes "click the dashed circle" and every velocity cue in the rite is
    // decoration. It is a tutorial, so it ends.
    const inst = spawn({ seed: 42, wave: 8 });
    expect(inst.ghostCasts).toBe(GHOST_CASTS);
    expect(GHOST_CASTS).toBeLessThanOrEqual(3);

    const g = recordingPainter();
    const withPointer = () => {
      inst.update(DT, makeInput({ x: 0, y: -1.2, inside: true }));
      inst.drainEvents();
    };
    withPointer();
    const before = g.names.length;
    inst.draw(g, 0);
    const early = g.names.length - before;

    for (let n = 0; n < GHOST_CASTS; n++) {
      cast(inst, 0, -4.0);                       // the silt: an empty cast, on purpose
      for (let i = 0; i < 200 && (inst.hook || inst.t < inst.readyAt); i++) withPointer();
    }
    expect(inst.casts).toBe(GHOST_CASTS);
    expect(inst.ghostCasts).toBe(0);

    withPointer();
    const mid = g.names.length;
    inst.draw(g, 0);
    // Strictly fewer primitives once the ghost is gone: an ellipse, a dot and a
    // line stop being drawn. Counting calls rather than pixels is the only thing
    // a node test can see, and it is enough to catch the gate being removed.
    expect(g.names.length - mid).toBeLessThan(early);
  });
});

// ===========================================================================

describe('FishingRite — the score', () => {
  it('pays the golden fish three times over', () => {
    const inst = spawn({ seed: 512, wave: 8 });
    const gi = inst.goldIndex;
    expect(inst.fish[gi].gold).toBe(true);
    // Confined to the middle of the index range, so it is neither gone before
    // the player has read the water nor uncontested for the whole rite.
    expect(gi).toBeGreaterThanOrEqual(4);
    expect(gi).toBeLessThan(12);

    // Wait until it is aimable and still alive, then take it with a lead.
    let landed = false;
    for (let step = 0; step < 700 && !landed; step++) {
      if (inst.fish[gi].state !== SWIMMING) break;
      const tl = landingTime(inst);
      if (tl < inst.claimAt[gi] - 0.2 && inst.hook == null && inst.t >= inst.readyAt) {
        const x = inst.fishX(inst.fish[gi], tl);
        if (Math.abs(x) < 6.5) {
          cast(inst, x, inst.fishY(inst.fish[gi], tl));
          idle(inst, Math.ceil(SINK / DT) + 2);
          landed = inst.fish[gi].state === KEPT;
          continue;
        }
      }
      idle(inst, 1);
    }
    expect(landed, 'the golden fish was never landable').toBe(true);
    expect(inst.goldKept).toBe(true);
    // Three points for the golden one, one for every other fish landed.
    expect(inst.points).toBe(GOLD_VALUE + (inst.kept - 1));
    expect(GOLD_VALUE).toBe(3);
    expect(inst.score().detail).toContain('golden');
  });

  it('scores 0 when everything is left to the rivals', () => {
    const inst = spawn({ seed: 70, wave: 28 });
    let ended = false;
    for (let i = 0; i < 1300 && !ended; i++) { ended = inst.update(DT, makeInput()) === true; inst.drainEvents(); }
    expect(ended).toBe(true);
    const s = inst.score();
    expect(s.ratio).toBe(0);
    expect(s.headline).toBe('Never cast');
    expect(inst.lost).toBeGreaterThan(8);
  });

  it('is clamped, continuous and monotone in points', () => {
    const inst = spawn({ seed: 1, wave: 8 });
    let last = -1;
    for (let p = 0; p <= 20; p++) {
      inst.points = p;
      const r = inst.score().ratio;
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(PAR).toBeCloseTo(PAR_FRACTION * (FISH - 1 + GOLD_VALUE), 10);
    // The bar is two thirds of the water and not half of it. At 0.55 a perfect
    // run cleared par with a third of the lake still swimming, so the top of the
    // range was unplayable-toward — the ceiling was decoration.
    expect(PAR_FRACTION).toBeGreaterThan(0.6);
  });

  it('ends early once the water is empty rather than running the clock out', () => {
    // Not reachable by a human on most seeds — it is the guard that stops a
    // cleared lake from making the player watch twenty seconds of nothing.
    const inst = spawn({ seed: 2, wave: 8 });
    for (const f of inst.fish) { f.state = KEPT; f.endAt = 0; }
    inst.kept = FISH;
    expect(inst.update(DT, makeInput())).toBe(true);
  });
});

// ===========================================================================
// Helpers that need the rite's own geometry, kept below the suites that read
// best without them.

/**
 * A player who reads the water: cast at the leading position of the nearest
 * uncontested fish whenever the rod is free.
 *
 * Passed to assertRiteContract as `skilled`, which upgrades "mashing must stay
 * under a ceiling" into "mashing must lose to real play" — a much stronger
 * claim, and the only one that actually says there is a game here.
 */
const SKILLED = aimAt(SINK);

/**
 * The same player with the lead removed: it puts the hook exactly ON a live
 * fish, which is precisely how `hunt` is played. Its score is the measurement
 * of how different the two rites actually are.
 */
const NO_LEAD = aimAt(0);

/**
 * A perfect aiming player that leads its target by `ahead` seconds.
 *
 * One function for both strategies on purpose: the ONLY difference between the
 * player who understands this rite and the player who does not is a single
 * number in the time argument. If a future edit ever makes those two score the
 * same, the diff that did it will be visible right here.
 */
function aimAt(ahead) {
  return function play(inst) {
    if (inst.hook || inst.t < inst.readyAt) return makeInput();
    const tl = inst.t + DT + SINK;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < FISH; i++) {
      const f = inst.fish[i];
      if (f.state !== SWIMMING || inst.claimAt[i] <= tl + 0.05) continue;
      const x = inst.fishX(f, tl);
      if (Math.abs(x) > 7.2) continue;
      // Nearest to the middle, so the "player" does not teleport across the
      // lake every shot. Any consistent ordering works; this one looks human.
      const d = Math.abs(x);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return makeInput();
    const f = inst.fish[best];
    const at = inst.t + DT + ahead;
    const x = inst.fishX(f, at);
    const y = inst.fishY(f, at);
    return makeInput({ x, y, inside: true, action: 1, clicks: [clickAt(x, y, 0, 'pointer')] });
  };
}

/**
 * A player who has learned ONE NUMBER and applies it to every fish: put the hook
 * `ahead` units in front of the nose, whatever the fish is doing.
 *
 * This is the strawman that turned out not to be one. It has perfect execution
 * and no velocity model at all, and against the rite as originally tuned it
 * scored 1.00 / 1.00 / 0.96 — indistinguishable from a bot computing the exact
 * landing position. Every claim this file makes about "reading the water"
 * depended on this player failing, and nothing measured whether it did.
 */
function fixedLead(ahead) {
  return function play(inst) {
    if (inst.hook || inst.t < inst.readyAt) return makeInput();
    const tl = inst.t + DT + SINK;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < FISH; i++) {
      const f = inst.fish[i];
      if (f.state !== SWIMMING || inst.claimAt[i] <= tl + 0.05) continue;
      const x = inst.fishX(f, tl);
      if (Math.abs(x) > 7.2) continue;
      if (Math.abs(x) < bestD) { bestD = Math.abs(x); best = i; }
    }
    if (best < 0) return makeInput();
    const f = inst.fish[best];
    const at = inst.t + DT;
    const x = inst.fishX(f, at) + Math.sign(f.v) * (f.len * 0.5 + ahead);
    const y = inst.fishY(f, at);
    return makeInput({ x, y, inside: true, action: 1, clicks: [clickAt(x, y, 0, 'pointer')] });
  };
}

/** Mean ratio of one strategy over a fixed seed list. The unit of every claim. */
const AIM_SEEDS = Object.freeze([1, 2, 3, 4, 5, 909]);
function avgOver(strategy, wave) {
  let s = 0;
  for (const seed of AIM_SEEDS) s += playOut(seed, wave, strategy).score().ratio;
  return s / AIM_SEEDS.length;
}

/** Run a whole rite under one strategy and hand back the finished instance. */
function playOut(seed, wave, strategy) {
  const inst = spawn({ seed, wave });
  const cap = Math.ceil(FISHING_RITE.duration / DT) + 1;
  for (let n = 0; n < cap; n++) {
    if (inst.update(DT, strategy(inst, n)) === true) break;
    inst.drainEvents();
  }
  return inst;
}

/**
 * THE REAL Painter over a fake 2D context — the same shape
 * `tests/unit/painter.test.js` uses.
 *
 * Deliberately not a hand-written Painter stub. A stub agrees with whatever the
 * rite happens to call, so it certifies `capsule(x1, y1, x2, y2, r, o)` and
 * `ellipse(cx, cy, rx, ry, rot, o)` even when the arguments are in the wrong
 * order — and an argument-order mistake in a drawing API is exactly the class of
 * bug that produces a plausible-looking frame nobody can explain. Going through
 * the real class means every call is type- and arity-checked by the code that
 * will run in the browser.
 *
 * The context throws on any non-finite number, which is the one visual failure a
 * node test can catch and a screenshot cannot: a single NaN in a path blanks the
 * frame with no error attached (docs/PITFALLS.md §9).
 */
function recordingPainter() {
  const calls = [];
  const rec = (name) => (...args) => {
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`ctx.${name} got ${a}`);
    }
    calls.push(name);
  };
  const gradient = () => ({ addColorStop: (at, col) => rec('addColorStop')(at, String(col)) });
  const c = {
    canvas: { width: 1600, height: 900 },
    setTransform: rec('setTransform'), clearRect: rec('clearRect'),
    save: rec('save'), restore: rec('restore'),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), quadraticCurveTo: rec('quadraticCurveTo'),
    arc: rec('arc'), ellipse: rec('ellipse'), rect: rec('rect'), roundRect: rec('roundRect'),
    clip: rec('clip'), fill: rec('fill'), stroke: rec('stroke'), fillText: rec('fillText'),
    createRadialGradient: (...a) => { rec('radial')(...a); return gradient(); },
    createLinearGradient: (...a) => { rec('linear')(...a); return gradient(); },
  };
  const g = new Painter(c);
  g.layout(1600, 900, 2);
  Object.defineProperty(g, 'calls', { get: () => calls.length });
  g.names = calls;
  return g;
}

/** Drop typed arrays into plain arrays so JSON.stringify sees their contents. */
function replacer(_k, v) {
  return ArrayBuffer.isView(v) ? Array.from(v) : v;
}
