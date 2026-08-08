/**
 * The rival model, which is arithmetic and therefore fully testable.
 *
 * Everything the four competitive rites will ask of an opponent goes through
 * `SeededRivals`, and every one of those questions has an exact answer — so the
 * things worth pinning are the CONTRACT properties rather than the numbers: a
 * constant randomness budget, reproducibility from a seed, monotonicity in
 * skill, and the one write (`applyPenalty`) actually moving the future.
 *
 * PROVE THE INSTRUMENT CAN FAIL (docs/TESTING.md §4). Two mutations were planted
 * and watched go red before being reverted: making the name draw a rejection
 * loop (`while (used.has(i)) i = rand()`) fails the budget test at every count,
 * and flipping `- r.skill * CLAIM_URGENCY` to `+` fails "a better rival always
 * claims sooner" — which is the assertion that stops a difficulty curve from
 * silently running backwards.
 */

import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../../src/core/Rng.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { SeededRivals, PER_RIVAL, NAMES } from '../../src/minigames/rivals.js';

/** A rand that counts itself. The determinism contract is about this number. */
function counted(seed = 1) {
  const r = mulberry32(seed);
  const fn = () => { fn.calls++; return r(); };
  fn.calls = 0;
  return fn;
}

// ===========================================================================
describe('the randomness budget', () => {
  /**
   * THE ONE PROPERTY A RITE CANNOT RECOVER FROM LOSING.
   *
   * A rite's rand() call count must be a function of its constructor arguments
   * and nothing else — not the wave, not the player. Two clients on one seed
   * that draw a different NUMBER of values do not diverge visibly at first: they
   * agree about the rivals and disagree about everything the rite drew after
   * them, which surfaces as "the targets are in different places" three seconds
   * later and looks like a rendering bug.
   */
  it('costs exactly count * PER_RIVAL draws, whatever the count or the wave', () => {
    for (const count of [0, 1, 3, 5, 8]) {
      for (const wave of [3, 28, 53]) {
        const rand = counted(count * 100 + wave);
        const built = new SeededRivals(rand, { count, wave });
        expect(built.roster().length).toBe(count);
        expect(rand.calls, `count ${count} @ wave ${wave}`).toBe(count * PER_RIVAL);
      }
    }
  });

  it('draws nothing at all at runtime, however hard it is questioned', () => {
    const rand = counted(9);
    const rivals = new SeededRivals(rand, { count: 4, wave: 33 });
    const after = rand.calls;
    for (let i = 0; i < 500; i++) {
      rivals.claimTime(i % 12);
      rivals.positionAt(i % 4, i * 0.05);
      rivals.outAt(i % 4);
      rivals.roster();
    }
    rivals.applyPenalty(2, 1.5);
    // Zero allocation is a nice-to-have; zero DRAWS is the contract. A rival
    // that rolled for anything per frame would consume the rite's stream at a
    // rate that depends on frame count, i.e. on the machine.
    expect(rand.calls).toBe(after);
  });
});

// ===========================================================================
describe('reproducibility', () => {
  it('same seed, same roster — names, skills and claim times all', () => {
    const build = () => new SeededRivals(riteRng(4242, 'hunt', 2), { count: 4, wave: 23 });
    const a = build();
    const b = build();
    expect(b.roster()).toEqual(a.roster());
    for (let i = 0; i < 12; i++) expect(b.claimTime(i)).toBe(a.claimTime(i));
  });

  it('two instances from one seed agree at 500 sampled times', () => {
    // Sampled out of order on purpose: `positionAt` is advertised as a pure
    // function of t, so evaluating it backwards must give the same answers as
    // evaluating it forwards. Anything that integrated per step would not.
    const a = new SeededRivals(riteRng(7, 'offroad', 0), { count: 3, wave: 18 });
    const b = new SeededRivals(riteRng(7, 'offroad', 0), { count: 3, wave: 18 });
    for (let i = 500; i > 0; i--) {
      const t = i * 0.05;
      for (let id = 0; id < 3; id++) {
        expect(b.positionAt(id, t), `rival ${id} @ t=${t.toFixed(2)}`).toBe(a.positionAt(id, t));
      }
    }
  });

  it('a different seed gives a different field', () => {
    const a = new SeededRivals(riteRng(1, 'hunt', 0), { count: 4, wave: 23 });
    const b = new SeededRivals(riteRng(2, 'hunt', 0), { count: 4, wave: 23 });
    expect(b.roster().map((r) => r.name)).not.toEqual(a.roster().map((r) => r.name));
  });

  it('never deals the same name twice in one roster', () => {
    for (let seed = 0; seed < 80; seed++) {
      const r = new SeededRivals(riteRng(seed, 'fishing', 0), { count: 6, wave: 43 });
      const names = r.roster().map((x) => x.name);
      expect(new Set(names).size, `seed ${seed}`).toBe(names.length);
      for (const n of names) expect(NAMES).toContain(n);
    }
  });
});

// ===========================================================================
describe('the published functions', () => {
  it('a better rival always claims sooner', () => {
    // One rival at a time, so the comparison is about skill and not about which
    // of three happened to be fastest.
    let prev = Infinity;
    for (const skill of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const r = new SeededRivals(mulberry32(5), { count: 1, wave: 8 });
      r.roster()[0].skill = skill;
      const t = r.claimTime(3);
      expect(t, `skill ${skill}`).toBeLessThan(prev);
      prev = t;
    }
  });

  it('claim times march forward with the target index', () => {
    const r = new SeededRivals(riteRng(11, 'hunt', 1), { count: 3, wave: 28 });
    let prev = -Infinity;
    for (let i = 0; i < 10; i++) {
      const t = r.claimTime(i);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    // An empty field takes nothing, ever — the right answer for a solo rite
    // that constructs a source anyway rather than branching on its absence.
    expect(new SeededRivals(mulberry32(1), { count: 0 }).claimTime(0)).toBe(Infinity);
  });

  it('position runs from 0 to 1 and never goes backwards', () => {
    const r = new SeededRivals(riteRng(3, 'offroad', 0), { count: 3, wave: 33 });
    for (let id = 0; id < 3; id++) {
      expect(r.positionAt(id, 0)).toBe(0);
      expect(r.positionAt(id, -5)).toBe(0);
      let prev = -1;
      for (let t = 0; t <= 40; t += 0.25) {
        const p = r.positionAt(id, t);
        expect(p).toBeGreaterThanOrEqual(prev);
        expect(p).toBeLessThanOrEqual(1);
        prev = p;
      }
      expect(r.positionAt(id, 1000)).toBe(1);
    }
    // An id nobody dealt is not an exception; it is a rival at the start line.
    expect(r.positionAt(99, 10)).toBe(0);
  });

  it('a penalty moves the whole future of one rival and nobody else', () => {
    const r = new SeededRivals(riteRng(21, 'offroad', 0), { count: 3, wave: 28 });
    const before = [0, 1, 2].map((id) => r.positionAt(id, 10));
    const claim0 = r.claimTime(2);

    r.applyPenalty(1, 1.5);

    expect(r.positionAt(1, 10), 'the bombed rival must lose ground')
      .toBeLessThan(before[1]);
    expect(r.positionAt(0, 10)).toBe(before[0]);
    expect(r.positionAt(2, 10)).toBe(before[2]);
    // Monotone in the size of the push, and it accumulates rather than replaces:
    // two bombs are worse than one, which is the only reason to carry a second.
    const once = r.positionAt(1, 10);
    r.applyPenalty(1, 1.5);
    expect(r.positionAt(1, 10)).toBeLessThan(once);
    // And it delays claims too — a blocked rival is not still first to the prize.
    expect(r.claimTime(2)).toBeGreaterThanOrEqual(claim0);
  });

  it('refuses a negative penalty rather than treating it as a boost', () => {
    const r = new SeededRivals(riteRng(21, 'offroad', 0), { count: 2, wave: 28 });
    const p = r.positionAt(0, 8);
    r.applyPenalty(0, -10);
    r.applyPenalty(9, 3);          // no such rival
    expect(r.positionAt(0, 8)).toBe(p);
  });

  it('elimination agrees with skill, and a penalty can end a rite for a rival', () => {
    const r = new SeededRivals(mulberry32(77), { count: 2, wave: 8 });
    r.roster()[0].skill = 0.05;
    r.roster()[1].skill = 0.95;
    expect(r.outAt(0)).toBeLessThan(r.outAt(1));
    expect(r.outAt(99)).toBe(Infinity);
    // The strongest rival survives the rite; enough penalty and they do not.
    expect(r.outAt(1)).toBe(Infinity);
    r.applyPenalty(1, 12);
    expect(Number.isFinite(r.outAt(1))).toBe(true);
    expect(r.outAt(1)).toBeGreaterThanOrEqual(0);
  });

  it('later waves face a better field, and never a perfect one', () => {
    const early = new SeededRivals(riteRng(6, 'hunt', 0), { count: 5, wave: 3 });
    const late = new SeededRivals(riteRng(6, 'hunt', 0), { count: 5, wave: 53 });
    const mean = (r) => r.roster().reduce((s, x) => s + x.skill, 0) / r.roster().length;
    expect(mean(late)).toBeGreaterThan(mean(early));
    // A roster that is uniformly better than any human is not a difficulty
    // curve, it is a "you lose" screen with more steps.
    for (const x of late.roster()) expect(x.skill).toBeLessThan(1);
  });
});

// ===========================================================================
/**
 * THE DEADLINE AND THE NAME ARE ONE SCHEDULE.
 *
 * `claimTime` shipped without a `claimant`, and both rites that needed one
 * invented it: `hunt` rolled a name out of its presentation RNG and `fishing`
 * rotated round the roster. Both were honest in their comments and both meant
 * the name on screen had no relationship to the number it was standing next to.
 * The assertions below are the ones that make that impossible to reintroduce:
 * the two accessors must be the min and the argmin of ONE array.
 *
 * PROVE THE INSTRUMENT CAN FAIL (docs/TESTING.md §4). Three mutations were
 * planted and watched go red: returning `this.rivals[0]` from `claimant` fails
 * both "not degenerate" and "agrees with claimTimeFor"; dropping the `i` term
 * from `hashU` in `#deal` fails "not degenerate" (every target deals the same
 * order again, which is the original bug); and skipping the `_penalty` term in
 * `claimTimeFor` fails "the two views agree under a penalty".
 */
describe('claimant — who took the target', () => {
  it('is the rival whose own time at that target is minimal', () => {
    for (const count of [1, 3, 5]) {
      const r = new SeededRivals(riteRng(31, 'hunt', 1), { count, wave: 28 });
      for (let i = 0; i < 16; i++) {
        const times = r.roster().map((x) => r.claimTimeFor(x.id, i));
        const best = Math.min(...times);
        expect(r.claimTime(i), `count ${count} target ${i}`).toBe(best);
        expect(r.claimant(i).id, `count ${count} target ${i}`).toBe(times.indexOf(best));
      }
    }
  });

  it('still agrees with claimTime once a rival has been blocked', () => {
    // The penalty is the only write in the interface, so it is the only way the
    // two views could be made to disagree by a caller.
    const r = new SeededRivals(riteRng(88, 'offroad', 0), { count: 4, wave: 33 });
    r.applyPenalty(r.claimant(0).id, 6);
    for (let i = 0; i < 12; i++) {
      const times = r.roster().map((x) => r.claimTimeFor(x.id, i));
      expect(r.claimTime(i)).toBe(Math.min(...times));
      expect(r.claimant(i).id).toBe(times.indexOf(Math.min(...times)));
    }
  });

  it('same seed, same claimants — and a different seed, a different round', () => {
    const build = (seed) => new SeededRivals(riteRng(seed, 'fishing', 0), { count: 3, wave: 23 });
    const names = (r) => Array.from({ length: 13 }, (_, i) => r.claimant(i).name);
    expect(names(build(9))).toEqual(names(build(9)));
    expect(names(build(9))).not.toEqual(names(build(10)));
  });

  it('spreads a full round over the roster instead of handing it to one rival', () => {
    // THE BUG THIS METHOD EXISTS FOR. With index-independent offsets the fastest
    // rival was arithmetically first to all fourteen animals of a hunt, which is
    // correct and reads as a broken game. Swept wide rather than pinned to one
    // seed: a single lucky seed proves nothing about a distribution.
    let worstShare = 0;
    for (let seed = 0; seed < 200; seed++) {
      const r = new SeededRivals(riteRng(seed, 'hunt', 0), { count: 3, wave: 3 + (seed % 50) });
      const tally = new Map();
      for (let i = 0; i < 14; i++) {
        const id = r.claimant(i).id;
        tally.set(id, (tally.get(id) ?? 0) + 1);
      }
      expect(tally.size, `seed ${seed} had one claimant for all 14`).toBeGreaterThan(1);
      worstShare = Math.max(worstShare, Math.max(...tally.values()));
    }
    // Nobody ever takes the whole round, but the leader is allowed to dominate
    // one: the deal is weighted by skill, so a flat distribution would be its
    // own bug — it would mean skill stopped meaning anything.
    expect(worstShare).toBeLessThan(14);
    expect(worstShare).toBeGreaterThan(7);
  });

  it('favours the better rival over many rounds without excluding the worse', () => {
    const r = new SeededRivals(mulberry32(404), { count: 3, wave: 20 });
    r.roster()[0].skill = 0.9;
    r.roster()[1].skill = 0.5;
    r.roster()[2].skill = 0.1;
    const tally = [0, 0, 0];
    for (let i = 0; i < 4000; i++) tally[r.claimant(i).id]++;
    expect(tally[0]).toBeGreaterThan(tally[1]);
    expect(tally[1]).toBeGreaterThan(tally[2]);
    // CLAIM_WEIGHT_FLOOR is what keeps the last line true: at zero, the 0.1
    // rival would be a spectator with a name.
    expect(tally[2]).toBeGreaterThan(0);
  });

  it('has no claimant when there is no field, and costs no draws', () => {
    const rand = counted(5);
    const solo = new SeededRivals(rand, { count: 0, wave: 12 });
    expect(solo.claimant(3)).toBe(null);
    expect(solo.claimTimeFor(0, 3)).toBe(Infinity);

    const r = new SeededRivals(rand, { count: 4, wave: 12 });
    const after = rand.calls;
    for (let i = 0; i < 400; i++) { r.claimant(i); r.claimTimeFor(i % 4, i); }
    expect(rand.calls).toBe(after);
    // An id nobody dealt is not an exception either.
    expect(r.claimTimeFor(99, 2)).toBe(Infinity);
  });
});
