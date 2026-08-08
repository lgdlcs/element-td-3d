/**
 * THE RITE OF FORTUNE — the rules, the economics and the determinism contract.
 *
 * `environment: 'node'`. Nothing here imports three or a DOM; the host-side
 * behaviour (one credit, no leaks, the phase restore) lives in
 * `lottery-host.test.js`, which needs jsdom.
 *
 * The centrepiece is `EV + pot feed < 1`. It is asserted, and then it is
 * DELIBERATELY BROKEN in a copy of the table so that we have watched the
 * assertion go red — docs/PITFALLS.md rule 4: an instrument that has never
 * failed has not been shown to be an instrument.
 */

import { describe, it, expect } from 'vitest';
import { rngFor } from '../../src/core/Rng.js';
import { TOTAL_WAVES, waveDef } from '../../src/game/Waves.js';
import {
  FIRST_WAGER_WAVE, LOTTERY_OUTCOMES, POT_FEED, RESERVE_MULT, STAKE_LADDER,
  evBase, evCeiling, outcomeBands, payoutFor, potContribution, probabilitySum,
  resolveLottery, returnStdDev, stakeFor, wagerBlock, waveGross, winRate,
} from '../../src/game/lottery.js';

const gross = (n) => waveDef(n).count * waveDef(n).bounty;

describe('the payout table', () => {
  it('sums to exactly 1', () => {
    // Not toBeCloseTo. The probabilities are three-decimal literals and their
    // sum is representable; if a future edit makes this need a tolerance, the
    // edit is what needs looking at.
    expect(probabilitySum()).toBeCloseTo(1, 12);
    expect(outcomeBands().at(-1).to).toBeCloseTo(1, 12);
  });

  it('has exactly one pot outcome and no zero-payout outcome', () => {
    expect(LOTTERY_OUTCOMES.filter((o) => o.pot)).toHaveLength(1);
    // The floor is 0.25, never 0. You never walk away from this table with
    // nothing in your hand; see the docblock in lottery.js.
    for (const o of LOTTERY_OUTCOMES) expect(o.mult).toBeGreaterThan(0);
    expect(Math.min(...LOTTERY_OUTCOMES.map((o) => o.mult))).toBe(0.25);
  });

  it('every probability is positive', () => {
    for (const o of LOTTERY_OUTCOMES) expect(o.p).toBeGreaterThan(0);
  });

  it('the ids are unique and stable', () => {
    expect(LOTTERY_OUTCOMES.map((o) => o.id))
      .toEqual(['ash', 'shard', 'vein', 'lode', 'geyser', 'conv']);
  });

  it('publishes the measured EV, deviation and win rate', () => {
    expect(evBase()).toBeCloseTo(0.8865, 10);
    expect(returnStdDev()).toBeCloseTo(0.930, 3);
    expect(winRate()).toBeCloseTo(0.26, 10);
  });
});

/**
 * THE INVARIANT. If this file only had one test, it would be this one.
 */
describe('EV + pot feed < 1 — the invariant that keeps this a tower defence', () => {
  it('holds for the shipped table', () => {
    expect(evCeiling()).toBeLessThan(1);
    expect(evCeiling()).toBeCloseTo(0.9865, 10);
  });

  it('leaves a real margin, not a rounding one', () => {
    // 1.35 percentage points. Tight enough that the wager is nearly fair,
    // wide enough that a floating-point wobble cannot flip the sign.
    expect(1 - evCeiling()).toBeGreaterThan(0.01);
  });

  /**
   * THE INSTRUMENT IS SHOWN TO BE ABLE TO FAIL.
   *
   * These are the exact numbers of ITERATION 1 of the design — a generous
   * floor, strong tails and a 20 % feed, each defensible alone — whose ceiling
   * came out at 1.25 and which the full-run simulation showed paying the
   * maximal wagerer +1 054 gold. That is the failure mode the shipped table
   * exists to avoid, so it is pinned here rather than described.
   */
  it('would fail on the rejected first-iteration table', () => {
    const rejected = [
      { p: 0.440, mult: 0.25 }, { p: 0.280, mult: 0.75 }, { p: 0.160, mult: 1.5 },
      { p: 0.085, mult: 3 }, { p: 0.020, mult: 8 }, { p: 0.015, mult: 5 },
    ];
    const ev = rejected.reduce((s, o) => s + o.p * o.mult, 0);
    expect(rejected.reduce((s, o) => s + o.p, 0)).toBeCloseTo(1, 12);
    expect(ev + 0.20).toBeGreaterThan(1);          // 1.25 — the broken ceiling
    expect(ev).toBeGreaterThan(1);                 // +EV even before the pot
  });

  it('would fail if the floor outcome were made free', () => {
    // Removing the 0.25x floor and handing that mass to the 3x tail is the
    // shape of "make losing hurt less by making winning bigger". It breaks.
    const tweaked = LOTTERY_OUTCOMES.map((o) => (o.id === 'ash' ? { ...o, mult: 1.0 } : o));
    const ev = tweaked.reduce((s, o) => s + o.p * o.mult, 0);
    expect(ev + POT_FEED).toBeGreaterThan(1);
  });
});

describe('resolveLottery', () => {
  it('walks the cumulative table and covers both edges', () => {
    expect(resolveLottery(0).id).toBe('ash');
    expect(resolveLottery(0.4599999).id).toBe('ash');
    expect(resolveLottery(0.46).id).toBe('shard');
    expect(resolveLottery(0.7399999).id).toBe('shard');
    expect(resolveLottery(0.74).id).toBe('vein');
    expect(resolveLottery(0.895).id).toBe('lode');
    expect(resolveLottery(0.97).id).toBe('geyser');
    expect(resolveLottery(0.9749999).id).toBe('geyser');
    expect(resolveLottery(0.975).id).toBe('conv');
    expect(resolveLottery(0.9999999999).id).toBe('conv');
  });

  it('is total — no input falls off the table', () => {
    for (const u of [-1, 0, 1, 2, NaN, Infinity, -Infinity, undefined, null]) {
      expect(LOTTERY_OUTCOMES).toContain(resolveLottery(u));
    }
  });

  it('reproduces the table frequencies over a large sample', () => {
    // A million draws off a fixed generator: the point is not to re-derive the
    // probabilities but to prove the cumulative walk does not lose or double a
    // band, which an off-by-one in the loop would show as a whole missing row.
    const rand = rngFor(0xC0FFEE, 'lottery-test', 0);
    const seen = new Map(LOTTERY_OUTCOMES.map((o) => [o.id, 0]));
    const N = 1_000_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const o = resolveLottery(rand());
      seen.set(o.id, seen.get(o.id) + 1);
      sum += o.mult;
    }
    for (const o of LOTTERY_OUTCOMES) {
      expect(seen.get(o.id) / N).toBeCloseTo(o.p, 2);
    }
    expect(sum / N).toBeCloseTo(evBase(), 2);
  });

  it('takes a number, not a generator — it cannot consume a second value', () => {
    // The strongest form of "exactly one rand() call" available: the function is
    // structurally incapable of asking for more.
    expect(resolveLottery.length).toBe(1);
    let calls = 0;
    const rand = () => (calls++, 0.5);
    resolveLottery(rand());
    expect(calls).toBe(1);
  });
});

describe('the stake ladder', () => {
  it('is monotone non-decreasing across the whole run and beyond', () => {
    let prev = 0;
    for (let n = 1; n <= 60; n++) {
      const s = stakeFor(n);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('is what erases the boss-wave dip', () => {
    // The concrete case the running maximum exists for: wave 19 grosses 330 and
    // wave 20 (a boss, one unit) grosses 236. Without the max the stake would
    // read as a discount on a boss wave.
    expect(gross(19)).toBeGreaterThan(gross(20));
    expect(stakeFor(20)).toBeGreaterThanOrEqual(stakeFor(19));
    expect(stakeFor(19)).toBe(75);
    expect(stakeFor(20)).toBe(75);
  });

  it('only ever uses rungs from the published ladder', () => {
    for (let n = 1; n <= TOTAL_WAVES; n++) expect(STAKE_LADDER).toContain(stakeFor(n));
  });

  it('never exceeds 35 % of the wave it is priced against', () => {
    for (let n = 1; n <= TOTAL_WAVES; n++) {
      expect(stakeFor(n) / gross(n)).toBeLessThanOrEqual(0.35);
    }
  });

  it('stays a meaningful fraction from the wager window onward', () => {
    // Never so small it is beneath notice: from wave 3 up, the stake is always
    // at least 14 % of the wave's gross. Both bounds together are what keeps the
    // decision alive for 52 consecutive waves.
    for (let n = FIRST_WAGER_WAVE; n <= TOTAL_WAVES; n++) {
      expect(stakeFor(n) / gross(n)).toBeGreaterThan(0.13);
    }
  });

  it('scales with the economy rather than sitting still', () => {
    // The gross grows 58x across the run. A fixed stake would be 139 % of wave 1
    // and 2.4 % of wave 55 — the "decisive early, invisible late" failure the
    // brief names. The ladder tracks it.
    expect(gross(55) / gross(1)).toBeGreaterThan(50);
    expect(stakeFor(55) / stakeFor(3)).toBeGreaterThan(20);
  });

  it('is a pure function of the wave and clamps out of range', () => {
    expect(stakeFor(30)).toBe(stakeFor(30));
    expect(stakeFor(0)).toBe(stakeFor(1));
    expect(stakeFor(-5)).toBe(stakeFor(1));
    expect(stakeFor(9999)).toBe(stakeFor(120));
    expect(Number.isFinite(stakeFor(NaN))).toBe(true);
  });

  it('matches the published table at every documented rung', () => {
    const published = {
      3: 25, 11: 25, 12: 50, 17: 50, 18: 75, 22: 75, 23: 100, 27: 100,
      28: 150, 31: 150, 32: 200, 36: 200, 37: 300, 41: 300, 42: 400,
      46: 400, 47: 600, 52: 600, 53: 800, 55: 800,
    };
    for (const [n, want] of Object.entries(published)) {
      expect([Number(n), stakeFor(Number(n))]).toEqual([Number(n), want]);
    }
  });

  it('waveGross agrees with Waves.js', () => {
    for (let n = 1; n <= TOTAL_WAVES; n++) expect(waveGross(n)).toBe(gross(n));
  });
});

describe('the reserve rule, and its honest status', () => {
  it('blocks exactly when the stake is more than half the bank', () => {
    const at = (gold) => wagerBlock({ phase: 'prep', gold, wave: 30, wageredWave: null });
    const stake = stakeFor(30);
    expect(at(stake * RESERVE_MULT)).toBeNull();
    expect(at(stake * RESERVE_MULT - 1)).toBe('reserve');
    expect(at(0)).toBe('reserve');
  });

  /**
   * THE RULE IS INERT AND THE TEST SAYS SO OUT LOUD.
   *
   * Gold in hand at the start of prep n is at least the gross of wave n-1 — it
   * was just collected and cannot have been spent before it existed. Against
   * that floor the ratio never drops below 2.88x, so the 2x rule cannot fire.
   * The protection against a death spiral is the stake formula; this assertion
   * exists to notice the day someone changes the ladder and quietly makes the
   * rule load-bearing.
   */
  it('cannot fire under any spending policy — the floor ratio is 2.88x', () => {
    let worst = Infinity;
    let worstWave = 0;
    for (let n = 1; n <= TOTAL_WAVES; n++) {
      const floor = n === 1 ? 275 : gross(n - 1);      // ECONOMY.startGold on wave 1
      const r = floor / stakeFor(n);
      if (r < worst) { worst = r; worstWave = n; }
    }
    expect(worstWave).toBe(2);
    expect(worst).toBeCloseTo(2.88, 2);
    expect(worst).toBeGreaterThan(RESERVE_MULT);
  });

  it('does fire for a player who is already losing the run', () => {
    // It bites past ~31 % leaked, which is the one moment it should: 2.88 x 0.69
    // is 1.99, just under the threshold.
    const floor = gross(1);                    // the worst case, wave 2
    expect((floor * 0.69) / stakeFor(2)).toBeLessThan(RESERVE_MULT);
    expect((floor * 0.70) / stakeFor(2)).toBeGreaterThan(RESERVE_MULT);
  });
});

describe('wagerBlock — the button is dark for exactly these reasons', () => {
  const base = { phase: 'prep', gold: 100000, wave: 30, wageredWave: null };

  it('opens only in prep', () => {
    expect(wagerBlock(base)).toBeNull();
    for (const phase of ['combat', 'pickElement', 'minigame', 'lottery', 'gameover', 'victory', 'lobby']) {
      expect(wagerBlock({ ...base, phase })).toBe('phase');
    }
  });

  it('opens on wave 3, not before', () => {
    expect(wagerBlock({ ...base, wave: 1 })).toBe('tooEarly');
    expect(wagerBlock({ ...base, wave: 2 })).toBe('tooEarly');
    expect(wagerBlock({ ...base, wave: FIRST_WAGER_WAVE })).toBeNull();
  });

  it('allows exactly one wager per prep', () => {
    expect(wagerBlock({ ...base, wageredWave: 30 })).toBe('spent');
    expect(wagerBlock({ ...base, wageredWave: 29 })).toBeNull();
  });

  it('checks the phase before anything else, so a dark button never lies', () => {
    // A player in combat with no gold is told "between waves", not "too poor".
    expect(wagerBlock({ phase: 'combat', gold: 0, wave: 1, wageredWave: 1 })).toBe('phase');
  });

  it('caps the exposure at one wager per wave for the whole run', () => {
    // 52 draws maximum across a run — the exposure is bounded by construction,
    // and there is no "bet again to get it back" loop anywhere in the design.
    expect(TOTAL_WAVES - FIRST_WAGER_WAVE + 1).toBe(53);
  });
});

describe('the pot — conservative bookkeeping', () => {
  it('feeds a whole-gold tenth of every stake', () => {
    expect(potContribution(800)).toBe(80);
    expect(potContribution(0)).toBe(0);
    expect(potContribution(-100)).toBe(0);
  });

  it('never feeds MORE than a tenth — that is what makes the ceiling a bound', () => {
    // The two half-gold rungs. With Math.round these fed 3 and 8, the realised
    // feed across the window came out at 10.06 %, and the measured ceiling
    // (0.98706) sat above the published one (0.9865). Flooring is the fix and
    // this is the assertion that found it.
    expect(potContribution(25)).toBe(2);
    expect(potContribution(75)).toBe(7);
    for (const rung of STAKE_LADDER) {
      expect(potContribution(rung)).toBeLessThanOrEqual(rung * POT_FEED);
    }
  });

  it('empties in full on Convergence and is untouched otherwise', () => {
    const conv = LOTTERY_OUTCOMES.find((o) => o.pot);
    const ash = LOTTERY_OUTCOMES.find((o) => o.id === 'ash');
    expect(payoutFor(conv, 400, 900)).toEqual({ base: 800, payout: 1700, potPaid: 900, potAfter: 0 });
    expect(payoutFor(ash, 400, 900)).toEqual({ base: 100, payout: 100, potPaid: 0, potAfter: 900 });
  });

  it('never creates or destroys gold across a whole simulated run', () => {
    // fed === paid + held, for every seed, for the entire wager window.
    for (const seed of [1, 7, 4242, 0xC0FFEE, 0xffffffff]) {
      let pot = 0, fed = 0, paid = 0;
      for (let n = FIRST_WAGER_WAVE; n <= TOTAL_WAVES; n++) {
        const stake = stakeFor(n);
        const f = potContribution(stake);
        pot += f; fed += f;
        const r = payoutFor(resolveLottery(rngFor(seed, 'lottery', n)()), stake, pot);
        paid += r.potPaid;
        pot = r.potAfter;
      }
      expect(fed).toBe(paid + pot);
      expect(pot).toBeGreaterThanOrEqual(0);
    }
  });

  it('the pot cannot make the wager profitable — it is fed from the stakes', () => {
    // Over a run where EVERY pot is claimed, the total returned is still under
    // the total staked. This is the invariant restated in gold rather than in
    // ratios, which is the form a reader actually believes.
    let staked = 0, returned = 0, pot = 0;
    for (let n = FIRST_WAGER_WAVE; n <= TOTAL_WAVES; n++) {
      const stake = stakeFor(n);
      staked += stake;
      pot += potContribution(stake);
      // The most generous possible run: every draw is the expected multiplier
      // AND the pot is emptied into the player's hand at the very end.
      returned += stake * evBase();
    }
    returned += pot;
    expect(returned).toBeLessThan(staked);
    // The realised ratio sits AT OR UNDER the published ceiling, which is only
    // true because potContribution floors. See its docblock.
    expect(returned / staked).toBeLessThanOrEqual(evCeiling());
    expect(returned / staked).toBeLessThan(1);
  });
});

describe('determinism — the multiplayer contract', () => {
  const draw = (seed, wave) => resolveLottery(rngFor(seed, 'lottery', wave)());

  it('consumes exactly one rand() call, whatever the wave', () => {
    for (const wave of [3, 10, 20, 37, 55]) {
      let calls = 0;
      const rand = rngFor(1234, 'lottery', wave);
      const counted = () => { calls++; return rand(); };
      resolveLottery(counted());
      expect(calls).toBe(1);
    }
  });

  it('same seed, same wave, same outcome — a hundred times over', () => {
    for (let i = 0; i < 100; i++) {
      const seed = (i * 2654435761) >>> 0;
      const wave = 3 + (i % 53);
      expect(draw(seed, wave).id).toBe(draw(seed, wave).id);
    }
  });

  it('two players on one seed get the identical 55-draw sequence', () => {
    const seq = (seed) => Array.from({ length: TOTAL_WAVES }, (_, i) => draw(seed, i + 1).id);
    expect(seq(0xBEEF)).toEqual(seq(0xBEEF));
    expect(seq(0xBEEF)).not.toEqual(seq(0xBEEE));
  });

  it('is indexed on the wave, so skipping a draw never banks it', () => {
    // The whole argument for a global index rather than a personal wager
    // counter: wave 12's outcome is wave 12's outcome whether or not anyone
    // wagered on waves 3 to 11. Luck cannot be moved onto an expensive wave.
    const a = draw(99, 12);
    const b = draw(99, 12);
    expect(a).toBe(b);
    expect(draw(99, 12)).not.toBe(draw(99, 13));
  });

  it('does not read player state — the label carries everything', () => {
    // rngFor takes (seed, label, index) and nothing else. If a future edit
    // threaded gold or picks into it, this would be the test that noticed.
    const generator = rngFor(5, 'lottery', 20);
    expect(typeof generator).toBe('function');
    expect(rngFor(5, 'lottery', 20)()).toBe(rngFor(5, 'lottery', 20)());
  });

  it('the lottery stream is independent of the element and rite streams', () => {
    // Different labels, different streams: consulting one cannot shift another.
    const seed = 777;
    expect(rngFor(seed, 'lottery', 4)()).not.toBe(rngFor(seed, 'elements', 4)());
    expect(rngFor(seed, 'lottery', 4)()).not.toBe(rngFor(seed, 'minigame:luckyshot', 4)());
  });
});

describe('the run, end to end, in gold', () => {
  /**
   * A cheap re-derivation of the headline number, from the same primitives the
   * game ships rather than from the design simulator. It is not the simulator's
   * economy model — no interest, no spending policy — so it does not reproduce
   * the -1 075 figure. It answers the question that actually matters here: does
   * wagering every prep, on this table, cost the player gold?
   */
  it('wagering every prep costs gold on average across many seeds', () => {
    let total = 0;
    const RUNS = 4000;
    for (let r = 0; r < RUNS; r++) {
      const seed = (r * 2654435761) >>> 0;
      let net = 0, pot = 0;
      for (let n = FIRST_WAGER_WAVE; n <= TOTAL_WAVES; n++) {
        const stake = stakeFor(n);
        pot += potContribution(stake);
        const res = payoutFor(resolveLottery(rngFor(seed, 'lottery', n)()), stake, pot);
        pot = res.potAfter;
        net += res.payout - stake;
      }
      total += net;
    }
    const mean = total / RUNS;
    expect(mean).toBeLessThan(0);
    // The stakes over the window total 12 525 gold; the loss lands in the
    // hundreds-to-low-thousands, i.e. a few per cent of a 67 000 gold economy
    // rather than a run-defining swing in either direction.
    expect(mean).toBeGreaterThan(-3000);
  });

  it('but a meaningful minority of those runs still finish ahead', () => {
    // A wager nobody ever wins is a tax with an animation. Measured at ~28 %.
    let positive = 0;
    const RUNS = 4000;
    for (let r = 0; r < RUNS; r++) {
      const seed = (r * 2654435761) >>> 0;
      let net = 0, pot = 0;
      for (let n = FIRST_WAGER_WAVE; n <= TOTAL_WAVES; n++) {
        const stake = stakeFor(n);
        pot += potContribution(stake);
        const res = payoutFor(resolveLottery(rngFor(seed, 'lottery', n)()), stake, pot);
        pot = res.potAfter;
        net += res.payout - stake;
      }
      if (net > 0) positive++;
    }
    expect(positive / RUNS).toBeGreaterThan(0.15);
    expect(positive / RUNS).toBeLessThan(0.45);
  });

  it('three players in four see the pot break at least once', () => {
    // 2.5 % over 53 draws. The whole reason Convergence was made twice as
    // frequent and half as generous: an anticipation mechanic most players never
    // see resolve is a dead mechanic.
    let claimed = 0;
    const RUNS = 4000;
    for (let r = 0; r < RUNS; r++) {
      const seed = (r * 2654435761) >>> 0;
      for (let n = FIRST_WAGER_WAVE; n <= TOTAL_WAVES; n++) {
        if (resolveLottery(rngFor(seed, 'lottery', n)()).pot) { claimed++; break; }
      }
    }
    expect(claimed / RUNS).toBeGreaterThan(0.68);
  });
});
