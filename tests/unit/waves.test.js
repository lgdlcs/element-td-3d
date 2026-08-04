import { describe, it, expect, afterEach } from 'vitest';
import {
  TOTAL_WAVES, isAirWave, prepTimeFor, waveDef, waveThreat, WaveRunner,
} from '../../src/game/Waves.js';
import { mulberry32 } from '../../src/core/Rng.js';
import { ECONOMY, WAVES } from '../../src/core/Config.js';

/**
 * Waves — the difficulty staircase and the spawner.
 *
 * FREEZE TEST. The scaling curves are closed-form functions of the wave number,
 * so "monotone" can be proved over the whole schedule rather than spot-checked.
 * Everything is asserted over waves 1..80 (past TOTAL_WAVES, into the endless
 * boss tail) so that a change to the endless branch is caught too.
 */

const ALL = Array.from({ length: 80 }, (_, i) => i + 1);
const realRandom = Math.random;
afterEach(() => { Math.random = realRandom; });

describe('Waves — schedule shape', () => {
  it('scripts 55 waves before the endless tail', () => {
    expect(TOTAL_WAVES).toBe(55);
    expect(waveDef(55).endless).toBe(false);
    expect(waveDef(56).endless).toBe(true);
  });

  it('carries the wave number back on the def', () => {
    for (const n of ALL) expect(waveDef(n).n).toBe(n);
  });

  it('runs a boss every tenth wave, and every wave past 55', () => {
    const bosses = ALL.filter((n) => waveDef(n).isBoss);
    expect(bosses.filter((n) => n <= 55)).toEqual([10, 20, 30, 40, 50]);
    expect(bosses.filter((n) => n > 55)).toEqual(ALL.filter((n) => n > 55));
    for (const n of bosses) expect(waveDef(n).type).toBe('boss');
  });

  it('runs an air wave every 7th, except where a boss collides', () => {
    expect(WAVES.airEvery).toBe(7);
    expect(ALL.filter(isAirWave)).toEqual([7, 14, 21, 28, 35, 42, 49]);
    // 70 is both 7x10 and 10x7. The boss wins — rewriting it into a flyer would
    // silently delete the boss, per the docblock.
    expect(isAirWave(70)).toBe(false);
    expect(waveDef(70).type).toBe('boss');
    // Air stops with the scripted schedule: 56 is a multiple of 7 but endless.
    expect(isAirWave(56)).toBe(false);
    for (const n of ALL) expect(waveDef(n).isAir).toBe(isAirWave(n));
  });

  it('never labels a wave both air and boss', () => {
    for (const n of ALL) {
      const d = waveDef(n);
      expect(d.isAir && d.isBoss).toBe(false);
    }
  });

  it('resolves the ORDER rotation to real creep types only', () => {
    const seen = new Set(ALL.map((n) => waveDef(n).type));
    expect([...seen].sort()).toEqual(['armored', 'boss', 'fast', 'flying', 'normal', 'swarm']);
    // 'ground' is a slot name, not a creep type; it must never leak out.
    expect(seen.has('ground')).toBe(false);
  });

  it('pins the first ten wave types', () => {
    expect(ALL.slice(0, 10).map((n) => waveDef(n).type)).toEqual([
      'normal', 'fast', 'armored', 'swarm', 'normal', 'normal',
      'flying',                                       // 7: the fixed air cadence
      'fast', 'swarm', 'boss',
    ]);
  });

  it('grants an element every 5th wave through wave 50 — 10 in the schedule', () => {
    const grants = ALL.filter((n) => waveDef(n).grantsElement);
    expect(grants).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    // Plus the free opening pick granted by Game on boot = the documented 11.
    expect(grants.length + 1).toBe(11);
    expect(ECONOMY.elementEveryWaves).toBe(5);
    expect(ECONOMY.lastElementWave).toBe(50);
  });
});

describe('Waves — scaling curves are monotone', () => {
  it('raises HP strictly on every single wave, forever', () => {
    for (let n = 2; n <= 80; n++) {
      expect(waveDef(n).hp, `wave ${n}`).toBeGreaterThan(waveDef(n - 1).hp);
    }
  });

  it('pins the HP anchors of the curve', () => {
    expect(waveDef(1).hp).toBe(52);
    expect(waveDef(10).hp).toBe(240);
    expect(waveDef(20).hp).toBe(1387);
    expect(waveDef(50).hp).toBe(264012);
    expect(waveDef(55).hp).toBe(646752);
  });

  it('never lowers the creep count on a non-boss wave, and caps it at 30', () => {
    let prev = 0;
    for (const n of ALL) {
      const d = waveDef(n);
      if (d.isBoss) continue;
      expect(d.count, `wave ${n}`).toBeGreaterThanOrEqual(prev);
      expect(d.count).toBeLessThanOrEqual(30);
      prev = d.count;
    }
    expect(waveDef(1).count).toBe(8);
    expect(waveDef(55).count).toBe(30);   // saturated
  });

  it('sends one boss early and more as the tiers climb', () => {
    expect(waveDef(10).count).toBe(1);
    expect(waveDef(20).count).toBe(1);
    expect(waveDef(50).count).toBe(3);
    expect(waveDef(60).count).toBe(4);
    let prev = 0;
    for (const n of ALL) {
      const d = waveDef(n);
      if (!d.isBoss) continue;
      expect(d.count).toBeGreaterThanOrEqual(prev);
      prev = d.count;
    }
  });

  it('raises bounty monotonically within each of the two tracks', () => {
    // Boss bounty (90 base) and normal bounty (9 base) are two separate curves;
    // interleaved they are not monotone, so they are checked apart.
    for (const isBoss of [false, true]) {
      let prev = 0;
      for (const n of ALL) {
        const d = waveDef(n);
        if (d.isBoss !== isBoss) continue;
        expect(d.bounty, `wave ${n}`).toBeGreaterThanOrEqual(prev);
        prev = d.bounty;
      }
    }
    expect(waveDef(1).bounty).toBe(9);
    expect(waveDef(10).bounty).toBe(142);
    expect(waveDef(55).bounty).toBe(139);
  });

  it('tightens the spawn interval down to a 0.22s floor', () => {
    let prev = Infinity;
    for (const n of ALL) {
      const d = waveDef(n);
      if (d.isBoss) continue;
      expect(d.interval, `wave ${n}`).toBeLessThanOrEqual(prev + 1e-9);
      expect(d.interval).toBeGreaterThanOrEqual(0.22);
      prev = d.interval;
    }
    expect(waveDef(1).interval).toBeCloseTo(0.62, 6);
    expect(waveDef(80).interval).toBe(1.6);    // bosses use their own cadence
  });

  it('shortens prep from 60s to a 30s floor, with a bonus on boss waves', () => {
    expect([WAVES.prepFirst, WAVES.prepStep, WAVES.prepFloor, WAVES.bossPrepBonus])
      .toEqual([60, 5, 30, 6]);
    expect(prepTimeFor(1)).toBe(60);
    expect(prepTimeFor(2)).toBe(55);
    expect(prepTimeFor(7)).toBe(30);           // floor reached
    expect(prepTimeFor(9)).toBe(30);
    expect(prepTimeFor(10)).toBe(36);          // boss bonus on top of the floor
    expect(prepTimeFor(80)).toBe(36);
    let prev = Infinity;
    for (const n of ALL) {
      if (waveDef(n).isBoss) continue;
      expect(prepTimeFor(n)).toBeLessThanOrEqual(prev);
      prev = prepTimeFor(n);
    }
    for (const n of ALL) expect(waveDef(n).prepTime).toBe(prepTimeFor(n));
  });

  it('computes threat as hp x count', () => {
    for (const n of ALL) {
      const d = waveDef(n);
      expect(waveThreat(n)).toBe(d.hp * d.count);
    }
    expect(waveThreat(1)).toBe(416);
  });

  it('DROPS threat on a boss wave, because the count collapses to one', () => {
    // OBSERVED, and it is what the HUD threat rail actually shows: wave 10 reads
    // as LESS threatening than wave 9 (240 vs 2222). Frozen deliberately — if a
    // future change makes the meter monotone, this test should be the thing that
    // says so out loud.
    expect(waveThreat(9)).toBe(2222);
    expect(waveThreat(10)).toBe(240);
    expect(waveThreat(10)).toBeLessThan(waveThreat(9));
    expect(waveThreat(11)).toBeGreaterThan(waveThreat(9));
  });
});

/** Minimal stand-in for CreepManager: records spawns, counts live bodies. */
function stubCreeps() {
  return {
    count: 0,
    spawns: [],
    spawn(type, hp, bounty, jitter) {
      this.spawns.push({ type, hp, bounty, jitter });
      this.count++;
    },
  };
}

/** Run a whole wave to completion, returning what the spawner did. */
function runWave(n, seed, dt = 1 / 60) {
  Math.random = mulberry32(seed);
  const creeps = stubCreeps();
  const wr = new WaveRunner(creeps, null);
  const started = [];
  const cleared = [];
  wr.onWaveStart = (d) => started.push(d.n);
  wr.onWaveCleared = (d) => cleared.push(d.n);
  wr.start(n);
  let ticks = 0;
  while (wr.spawning && ticks < 100000) { wr.update(dt); ticks++; }
  const spawnedInProgress = wr.inProgress;
  creeps.count = 0;              // the player killed them all
  wr.update(dt);
  return { creeps, wr, ticks, started, cleared, spawnedInProgress };
}

describe('Waves — WaveRunner', () => {
  it('starts empty and idle', () => {
    const wr = new WaveRunner(stubCreeps(), null);
    expect([wr.wave, wr.spawned, wr.spawning, wr.def]).toEqual([0, 0, false, null]);
    expect(wr.inProgress).toBe(false);
  });

  it('spawns exactly waveDef(n).count creeps, no more and no fewer', () => {
    for (const n of [1, 5, 10, 21, 35, 50, 55, 60]) {
      const { creeps } = runWave(n, 12345);
      expect(creeps.spawns.length, `wave ${n}`).toBe(waveDef(n).count);
    }
  });

  it('is bit-for-bit deterministic for a given RNG seed', () => {
    const a = runWave(1, 1);
    const b = runWave(1, 1);
    expect(a.creeps.spawns).toEqual(b.creeps.spawns);
    expect(a.ticks).toBe(b.ticks);
    // Pinned so an accidental extra Math.random() call in the spawn path shows
    // up as a changed stream rather than passing silently.
    expect(a.ticks).toBe(276);
    expect(a.creeps.spawns[0].jitter).toBeCloseTo(0.5016591524705291, 12);
  });

  it('changes the rhythm but never the head count when the seed changes', () => {
    const a = runWave(1, 1);
    const b = runWave(1, 7);
    expect(a.ticks).not.toBe(b.ticks);
    expect(b.ticks).toBe(233);
    expect(a.creeps.spawns.length).toBe(b.creeps.spawns.length);
    expect(a.creeps.spawns.length).toBe(8);
  });

  it('hands every creep the wave type, hp and bounty from the def', () => {
    const { creeps } = runWave(21, 99);
    const d = waveDef(21);
    for (const s of creeps.spawns) {
      expect(s.type).toBe(d.type);
      expect(s.hp).toBe(d.hp);
      expect(s.bounty).toBe(d.bounty);
    }
    expect(d.type).toBe('flying');
  });

  it('jitters the spawn position within [0, 0.8) and never further', () => {
    // The cumulative `spawned * 0.4` offset was removed on purpose: it rendered
    // the pending wave as a rigid lattice off the board edge.
    for (const seed of [1, 2, 3, 42]) {
      const { creeps } = runWave(55, seed);
      for (const s of creeps.spawns) {
        expect(s.jitter).toBeGreaterThanOrEqual(0);
        expect(s.jitter).toBeLessThan(0.8);
      }
    }
  });

  it('fires onWaveStart once, with the def of the wave requested', () => {
    const { started } = runWave(13, 5);
    expect(started).toEqual([13]);
  });

  it('stays in progress while creeps are alive, then clears exactly once', () => {
    const { cleared, spawnedInProgress, wr } = runWave(1, 5);
    expect(spawnedInProgress).toBe(true);      // spawning done, bodies still up
    expect(cleared).toEqual([1]);
    expect(wr.def).toBe(null);
    expect(wr.inProgress).toBe(false);
  });

  it('does not clear twice if update runs again on an empty board', () => {
    Math.random = mulberry32(5);
    const creeps = stubCreeps();
    const wr = new WaveRunner(creeps, null);
    const cleared = [];
    wr.onWaveCleared = (d) => cleared.push(d.n);
    wr.start(1);
    while (wr.spawning) wr.update(1 / 60);
    creeps.count = 0;
    wr.update(1 / 60);
    wr.update(1 / 60);
    wr.update(1 / 60);
    expect(cleared).toEqual([1]);
  });

  it('drains the whole wave in one tick when dt is huge', () => {
    // The spawn loop is a `while`, not an `if`: a long frame must not stretch
    // the wave out over the next several frames.
    Math.random = mulberry32(5);
    const creeps = stubCreeps();
    const wr = new WaveRunner(creeps, null);
    wr.start(55);
    wr.update(1000);
    expect(creeps.spawns.length).toBe(waveDef(55).count);
    expect(wr.spawning).toBe(false);
  });

  it('sends a single body on an early boss wave', () => {
    const { creeps } = runWave(10, 1);
    expect(creeps.spawns.length).toBe(1);
    expect(creeps.spawns[0]).toMatchObject({ type: 'boss', hp: 240, bounty: 142 });
  });
});
