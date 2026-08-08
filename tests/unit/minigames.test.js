/**
 * The rite pipeline, exercised without a browser.
 *
 * Everything here imports only pure modules — contract, schedule and registry.
 * Nothing imports three.js, Game.js or the host, which is the property the whole
 * contract was shaped around: if a rite can only be tested inside a canvas, it
 * will not be tested.
 *
 * SCOPE NOTE (wave 0.5). The per-rite suites that used to live at the bottom of
 * this file went with the four invented rites they tested. What remains here is
 * the pipeline: the contract, the reward curve, the schedule and the registry —
 * none of which name a rite. Each of the six real rites gets its own suite built
 * on `tests/unit/helpers/rite-contract.js`, and the host's own guarantees — no
 * leaked listeners, one gold credit — live in tests/unit/minigame-host.test.js.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES, ECONOMY } from '../../src/core/Config.js';
import { TOTAL_WAVES, waveDef } from '../../src/game/Waves.js';
import {
  FIELD, makeInput, minigameReward, tri, NEUTRAL_INPUT, clickAt, approxTextWidth,
} from '../../src/minigames/contract.js';
import { isRiteWave, riteOccurrence, riteForWave, riteRng } from '../../src/minigames/schedule.js';
import { MINIGAME_IDS, RITES, riteDef } from '../../src/minigames/registry.js';

// ===========================================================================
describe('contract', () => {
  it('the field is the fixed 16x9 rectangle every rite works in', () => {
    expect(FIELD.w).toBe(16);
    expect(FIELD.h).toBe(9);
    expect(FIELD.hw).toBe(8);
    expect(FIELD.hh).toBe(4.5);
  });

  it('makeInput hands back an independent record, not a shared one', () => {
    const a = makeInput();
    const b = makeInput({ action: 3 });
    a.axis.x = 1;
    expect(b.axis.x).toBe(0);
    expect(NEUTRAL_INPUT.axis.x).toBe(0);
    expect(a.action).toBe(0);
    expect(b.action).toBe(3);
  });

  it('the input record carries the full published shape, clicks included', () => {
    const n = makeInput();
    expect(Object.keys(n).sort()).toEqual(
      ['action', 'altAction', 'axis', 'clicks', 'down', 'inside', 'slots', 'x', 'y'],
    );
    expect(n.clicks).toEqual([]);
    expect(n.altAction).toBe(0);
    // The neutral record is frozen all the way down, so a rite that writes to
    // the input it was handed fails loudly in a test rather than quietly
    // poisoning every later step. (Non-strict mode swallows the write, which is
    // why the assertion is on the VALUE afterwards, not on a throw.)
    expect(Object.isFrozen(NEUTRAL_INPUT.clicks)).toBe(true);
  });

  /**
   * FRESHNESS, WHICH IS THE WHOLE REASON `clicks` IS BUILT LIKE `slots`.
   *
   * A single shared array behind every input record is the classic version of
   * this bug: it costs nothing, it passes every test that only ever makes one
   * record, and it turns a test that scripts two different frames into a test
   * where the first frame's shot is still loaded in the second.
   */
  it('every makeInput gets its own clicks array', () => {
    const a = makeInput();
    const b = makeInput();
    a.clicks.push(clickAt(1, 2));
    expect(b.clicks).toEqual([]);
    expect(NEUTRAL_INPUT.clicks).toEqual([]);
    expect(makeInput().clicks).toEqual([]);
    // ...and an explicit override still wins, so a test can script a shot.
    const c = makeInput({ clicks: [clickAt(3, 4, 2, 'key')] });
    expect(c.clicks).toEqual([{ x: 3, y: 4, button: 2, source: 'key' }]);
    expect(makeInput().clicks).toEqual([]);
  });

  it('approxTextWidth scales with both length and size, and is monospace-shaped', () => {
    expect(approxTextWidth('abcd', 0.5)).toBeCloseTo(1.2, 6);
    expect(approxTextWidth('', 0.5)).toBe(0);
    // Twice the glyphs is twice the box; twice the cap height is twice the box.
    expect(approxTextWidth('abcdefgh', 0.5)).toBeCloseTo(approxTextWidth('abcd', 1), 6);
  });

  it('tri is a triangle wave with period 2, and never leaves [0,1]', () => {
    expect(tri(0)).toBe(0);
    expect(tri(1)).toBe(1);
    expect(tri(2)).toBe(0);
    expect(tri(3)).toBe(1);
    for (let p = -4; p < 8; p += 0.017) {
      const v = tri(p);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('reward is monotonic in ratio and never worth a wave of its own', () => {
    // A late wave, deliberately: the reward is whole gold, so on a small wave
    // the assertions below would be testing Math.round rather than the formula.
    const gross = waveDef(50).count * waveDef(50).bounty;
    const at1 = minigameReward(1, gross);
    let prev = -1;
    for (let r = 0; r <= 1.00001; r += 0.01) {
      const v = minigameReward(r, gross);
      expect(v, `ratio ${r.toFixed(2)} paid less than the ratio below it`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(at1).toBe(Math.round(gross * MINIGAMES.perfectFrac));
    // A perfect rite is never worth a whole wave of bounty. That is the line
    // between "a bonus" and "skip the tower defence and play minigames".
    expect(at1).toBeLessThan(gross * 0.5);
    // Out-of-range ratios are clamped rather than trusted.
    expect(minigameReward(9, gross)).toBe(at1);
    expect(minigameReward(-3, gross)).toBe(0);
    expect(minigameReward(NaN, gross)).toBe(0);
  });

  /**
   * THE ANTI-CLIFF ASSERTION. If only one test in this file survives, this one.
   *
   * The shape this replaced was `ratio < payThreshold ? 0 : floor + ...`, and at
   * wave 53 that meant 0.119 paid 0 while 0.121 paid 262 gold. Nothing on screen
   * marks that edge — the player never sees `ratio` — so the difference between
   * "nothing happened" and "a fifth of a wave" was two thousandths of an
   * invisible number. Sweeping the range and refusing any jump is the ONE
   * assertion that would have caught it, and it holds for any future formula
   * without knowing anything about the formula.
   *
   * The tolerance is a whole gold rather than exactly `perfect * 0.01` on small
   * waves, and that is arithmetic honesty rather than slack: the payout is
   * rounded to whole gold, so on a wave where `perfect` is the 40-gold floor a
   * single-gold step IS 2.5% and no continuous curve can do better.
   */
  it('has no cliff anywhere: 1 000 adjacent ratios never jump', () => {
    const N = 1000;
    for (let n = 1; n <= TOTAL_WAVES; n++) {
      const r = riteForWave(1234, n);
      if (!r) continue;
      const next = waveDef(r.wave);
      const gross = next.count * next.bounty;
      const perfect = Math.max(MINIGAMES.minPerfect, gross * MINIGAMES.perfectFrac);
      const tol = Math.max(1, perfect * 0.01);
      let prev = minigameReward(0, gross);
      for (let i = 1; i <= N; i++) {
        const v = minigameReward(i / N, gross);
        expect(v - prev,
          `wave ${r.wave}: ratio ${(i / N).toFixed(3)} jumps ${v - prev} gold over the step below it`)
          .toBeLessThanOrEqual(tol);
        prev = v;
      }
    }
    // ...and on a late wave, where whole-gold rounding is noise rather than the
    // signal, the strict form of the same claim holds with no allowance at all.
    const late = waveDef(53).count * waveDef(53).bounty;
    const perfect = late * MINIGAMES.perfectFrac;
    let prev = minigameReward(0, late);
    for (let i = 1; i <= N; i++) {
      const v = minigameReward(i / N, late);
      expect(v - prev, `wave 53: a ${v - prev} gold step at ratio ${(i / N).toFixed(3)}`)
        .toBeLessThanOrEqual(perfect * 0.01);
      prev = v;
    }
  });

  /**
   * SKIPPING AND IDLING ARE WORTH THE SAME, AND NOW BY CONSTRUCTION.
   *
   * The economic bug this guards is invisible from any single call: skipping
   * pays 0 (MinigameHost.#settle) while opening the rite and doing nothing used
   * to pay `floorFrac` — 20% of a perfect run, 92 gold by wave 48 — so the
   * dominant line was "start it, look away". It was closed with a tuned
   * threshold that had to be re-measured against every new rite; it is now
   * closed by the exponent, which cannot rot.
   */
  it('doing nothing pays exactly what skipping pays: nothing', () => {
    for (let n = 1; n <= TOTAL_WAVES; n++) {
      const r = riteForWave(1234, n);
      if (!r) continue;
      const next = waveDef(r.wave);
      const gross = next.count * next.bounty;
      const skipped = 0;                                   // what #settle pays
      expect(minigameReward(0, gross)).toBe(skipped);
      // And the approach to zero is smooth, not a gate: a twitch is worth a
      // twitch, and there is no edge to sit just above.
      expect(minigameReward(1e-6, gross)).toBe(0);
      expect(minigameReward(1, gross)).toBeGreaterThan(0);
    }
  });

  it('the curve is convex: the bottom of the range is cheap without a gate', () => {
    const gross = waveDef(53).count * waveDef(53).bounty;
    const perfect = gross * MINIGAMES.perfectFrac;
    // An idle-ish score is worth a rounding error, a competent one most of the
    // prize. These are the two numbers the Config.js table is derived from.
    expect(minigameReward(0.05, gross) / perfect).toBeLessThan(0.03);
    expect(minigameReward(0.75, gross) / perfect).toBeGreaterThan(0.65);
  });

  it('the early-game floor keeps a perfect rite worth having on wave 4', () => {
    const gross = waveDef(4).count * waveDef(4).bounty;
    expect(minigameReward(1, gross)).toBe(MINIGAMES.minPerfect);
  });
});

// ===========================================================================
describe('schedule', () => {
  it('never collides with an element-pick wave, for the whole run', () => {
    for (let n = 1; n <= TOTAL_WAVES + 20; n++) {
      if (!isRiteWave(n)) continue;
      expect(waveDef(n).grantsElement, `wave ${n} grants an element AND a rite`).toBe(false);
      expect(n % ECONOMY.elementEveryWaves).not.toBe(0);
    }
  });

  it('fires 11 times over the scripted run, on the waves the design names', () => {
    const waves = [];
    for (let n = 1; n <= TOTAL_WAVES; n++) if (isRiteWave(n)) waves.push(n);
    expect(waves).toEqual([3, 8, 13, 18, 23, 28, 33, 38, 43, 48, 53]);
    // Deliberately equal to the number of element picks in a run: one decision
    // and one test per five waves. `grantsElement` covers 10 of them; the
    // eleventh is the free pick Game.beginRun hands out at wave 0.
    let picks = 1;
    for (let n = 1; n <= TOTAL_WAVES; n++) if (waveDef(n).grantsElement) picks++;
    expect(waves.length).toBe(picks);
  });

  it('never schedules a rite on the final wave, which ends in victory instead', () => {
    expect(isRiteWave(TOTAL_WAVES)).toBe(false);
    expect(riteForWave(1, TOTAL_WAVES)).toBeNull();
  });

  it('occurrence advances by exactly one per rite and starts at zero', () => {
    const seen = [];
    for (let n = 1; n <= TOTAL_WAVES; n++) if (isRiteWave(n)) seen.push(riteOccurrence(n));
    expect(seen).toEqual(seen.map((_, i) => i));
  });

  it('is a pure function of (seed, wave) — same seed, same rite, every time', () => {
    for (const seed of [0, 1, 7, 0xdeadbeef, 0xffffffff]) {
      for (let n = 1; n <= TOTAL_WAVES; n++) {
        expect(riteForWave(seed, n)).toEqual(riteForWave(seed, n));
      }
    }
  });

  it('deals every rite exactly once per cycle', () => {
    const N = MINIGAME_IDS.length;
    for (const seed of [3, 99, 123456]) {
      const ids = [];
      for (let n = 1; n <= TOTAL_WAVES; n++) {
        const r = riteForWave(seed, n);
        if (r) ids.push(r.id);
      }
      for (let c = 0; c + N <= ids.length; c += N) {
        expect(new Set(ids.slice(c, c + N)).size).toBe(N);
      }
    }
  });

  /**
   * THE PROPERTY THE REGISTRY DOCBLOCK CLAIMS, CHECKED RATHER THAN ASSERTED.
   *
   * 11 rites over 6 ids: occurrences 0-5 are cycle 0 (a full shuffle, so all six
   * appear) and 6-10 are cycle 1 slots 0..4. So every run plays all six, five of
   * them twice and one exactly once — with no special-casing anywhere in
   * schedule.js. If this ever goes red, the docblock in registry.js is lying.
   */
  it('every run plays all six rites: five twice, one exactly once', () => {
    expect(MINIGAME_IDS.length).toBe(6);
    for (const seed of [0, 3, 99, 4242, 123456, 0xffffffff]) {
      const counts = new Map(MINIGAME_IDS.map((id) => [id, 0]));
      let total = 0;
      for (let n = 1; n <= TOTAL_WAVES; n++) {
        const r = riteForWave(seed, n);
        if (!r) continue;
        total++;
        counts.set(r.id, counts.get(r.id) + 1);
      }
      expect(total, `seed ${seed}`).toBe(11);
      const tally = [...counts.values()].sort();
      expect(tally, `seed ${seed}: every rite appears, five of them twice`).toEqual([1, 2, 2, 2, 2, 2]);
    }
  });

  it('every id it can ever return is in the registry', () => {
    for (let seed = 0; seed < 200; seed++) {
      for (let n = 1; n <= TOTAL_WAVES; n++) {
        const r = riteForWave(seed, n);
        if (r) expect(riteDef(r.id), `${r.id} @ seed ${seed}`).toBeTruthy();
      }
    }
  });

  it('gives a different stream per rite id and per occurrence', () => {
    const a = riteRng(42, 'luckyshot', 0)();
    const b = riteRng(42, 'luckyshot', 1)();
    const c = riteRng(42, 'other', 0)();
    const d = riteRng(43, 'luckyshot', 0)();
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

// ===========================================================================
describe('registry', () => {
  /**
   * THE BASELINE, PINNED.
   *
   * The order of this array is part of the seed contract (registry.js), and it
   * was broken exactly once — when the four invented rites were deleted. Pinning
   * it here means the next reorder has to be a deliberate edit to a test rather
   * than an accident inside an import sort.
   */
  it('lists the six rites in the order the seed contract depends on', () => {
    expect([...MINIGAME_IDS]).toEqual(
      ['heaven', 'platforms', 'luckyshot', 'offroad', 'hunt', 'fishing'],
    );
    expect(Object.isFrozen(MINIGAME_IDS)).toBe(true);
    expect(Object.keys(RITES).sort()).toEqual([...MINIGAME_IDS].sort());
  });

  it('every entry satisfies the published definition shape', () => {
    for (const id of MINIGAME_IDS) {
      const def = RITES[id];
      expect(def.id).toBe(id);
      expect(typeof def.name).toBe('string');
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.hint).toBe('string');
      expect(def.duration).toBeGreaterThan(4);
      expect(def.duration).toBeLessThanOrEqual(30);
      const inst = def.create();
      for (const m of ['init', 'update', 'draw', 'score']) {
        expect(typeof inst[m], `${id}.${m}`).toBe('function');
      }
    }
  });

  it('a fresh instance per create() — two rites never share state', () => {
    for (const id of MINIGAME_IDS) {
      const a = RITES[id].create();
      const b = RITES[id].create();
      expect(a).not.toBe(b);
    }
  });
});

// ===========================================================================
describe('reward, measured against the real wave table', () => {
  it('a perfect run of every rite is a bonus, not an income stream', () => {
    let perfect = 0;
    let total = 0;
    for (let n = 1; n <= TOTAL_WAVES; n++) {
      const d = waveDef(n);
      total += d.count * d.bounty;
      const r = riteForWave(1234, n);
      if (!r) continue;
      const next = waveDef(r.wave);
      perfect += minigameReward(1, next.count * next.bounty);
    }
    // PUBLISHED NUMBERS (the MINIGAMES docblock in Config.js), pinned so a
    // tuning change has to move them on purpose and update the table with them.
    // 3 224 gold of rites against 62 210 gold of bounty is 5.2% of a run's
    // income — and that is the CEILING, reached only by playing all eleven
    // flawlessly. The same table's honest row is 0.75, which pays 2 251.
    expect(perfect).toBe(3224);
    expect(total).toBe(62210);
    expect(perfect / total).toBeLessThan(0.06);
  });
});
