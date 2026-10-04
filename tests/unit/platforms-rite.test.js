/**
 * PLATFORMS — the rite where the floor is the clock, played in hops.
 *
 * `assertRiteContract` covers everything true of ANY rite. What is here is the
 * set of claims specific to THIS design, the ones a refactor could break while
 * every generic assertion stayed green:
 *
 *   - the fall order is a PERMUTATION, it has a SHAPE, and the player's tile
 *     goes first;
 *   - tiles start to shake on a constant beat and each shakes for its own time;
 *   - a hop is one tile, lands after HOP, holds through a key press, queues a
 *     tap made mid-air, goes diagonal on two keys, and stops at the edge;
 *   - standing on a tile that drops, or landing in a hole, ends the run at that
 *     instant; taking off in time does not;
 *   - an idle player lands in the 0.04-0.14 band;
 *   - the ghosts never stand on a tile that has gone, and the rival term is
 *     worth exactly 0.25;
 *   - `playerAt` / `ghostAt` agree with the stepped state, since the view draws
 *     from them between steps.
 *
 * `node` environment: this file must never reach for a DOM or for three.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { mulberry32 } from '../../src/core/Rng.js';
import { NAMES } from '../../src/minigames/rivals.js';
import {
  PLATFORMS_RITE, RAND_CALLS, TILES, COLS, ROWS, RIVAL_COUNT, HOP, STRESS_LEAD, LINGER,
  STAND, HOPPING, OUT,
  cellX, cellY, cellAt, neighbours, hopTarget,
} from '../../src/minigames/rites/PlatformsRite.js';
import { assertRiteContract } from './helpers/rite-contract.js';

const DT = MINIGAMES.dt;
/** Steps from takeoff to landing: the first step whose elapsed time reaches HOP. */
const HOP_STEPS = Math.ceil(HOP / DT - 1e-9);

function spawn({ seed = 1, wave = 8, occurrence = 0 } = {}) {
  const inst = PLATFORMS_RITE.create();
  inst.init({
    rand: riteRng(seed, PLATFORMS_RITE.id, occurrence),
    wave, occurrence, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/** Run to the rite's own end, or to the host's cap, whichever first. */
function play(strategy, o = {}) {
  const inst = spawn(o);
  const cap = Math.ceil(PLATFORMS_RITE.duration / DT) + 1;
  let steps = 0;
  for (; steps < cap; steps++) {
    if (inst.update(DT, strategy(inst, steps)) === true) { steps++; break; }
    inst.drainEvents();
  }
  return { inst, steps, score: inst.score() };
}

const axis = (x, y) => makeInput({ axis: { x, y } });
const idle = () => makeInput();

/** Step with a fixed input until `pred` or `max` steps. */
function stepUntil(inst, input, pred, max = 2000) {
  for (let n = 0; n < max && !pred(inst); n++) inst.update(DT, input);
}

/** Park the player on `cell` as if they had just landed there. */
function park(inst, cell) {
  inst.cell = cell; inst.px = cellX(cell); inst.py = cellY(cell); inst.landedAt = inst.t;
}

/** Step idle with the player kept on `cell` (re-parked each step, so it never wears) until `pred`. */
function holdOn(inst, cell, pred, max = 2000) {
  for (let n = 0; n < max && !pred(inst); n++) { park(inst, cell); inst.update(DT, idle()); }
}

/** The axis that hops from `from` toward neighbour `to`. */
function toward(from, to) {
  return axis(Math.sign(cellX(to) - cellX(from)), Math.sign(cellY(to) - cellY(from)));
}

/**
 * What the floor SHOWS, as a number (higher is safer): a hole, a shaking tile
 * (its glow says how long is left), a darkened tile, or settled ground scored by
 * how much settled ground it connects to. The same reading as the calibration
 * brain in helpers/reference-player.js; no `gone` time beyond what is visible.
 * Room rather than adjacent open tiles since tiles wear out under a player who
 * lingers: every stop leaves a hole behind, and a greedy reader walks into a
 * dead end.
 */
const NB = new Int32Array(8);
const NB2 = new Int32Array(8);
function look(inst, i) {
  const left = inst.gone[i] - inst.t;
  if (left <= 0) return -1e9;
  if (left <= inst.shake[i]) return left;
  if (left <= inst.shake[i] * STRESS_LEAD) return 50;
  const seen = new Uint8Array(TILES);
  const queue = [i];
  seen[i] = 1;
  for (let h = 0; h < queue.length; h++) {
    const n = neighbours(queue[h], NB2);
    for (let k = 0; k < n; k++) {
      const c = NB2[k];
      if (!seen[c] && inst.gone[c] - inst.t > inst.shake[c] * STRESS_LEAD) { seen[c] = 1; queue.push(c); }
    }
  }
  return 100 + queue.length;
}

/** Deliberate play: stay on settled ground, leave a darkening tile for the safest-looking neighbour. */
function skilled(inst) {
  if (!inst.alive) return idle();
  const cur = inst.to >= 0 ? inst.to : inst.cell;
  if (look(inst, cur) >= 100) return idle();
  const n = neighbours(cur, NB);
  let best = cur, bestV = look(inst, cur);
  for (let k = 0; k < n; k++) {
    const v = look(inst, NB[k]);
    if (v > bestV) { bestV = v; best = NB[k]; }
  }
  return best === cur ? idle() : toward(cur, best);
}

/** The same reader, but it hops to a random neighbour that is still there. */
function anyLive(rng) {
  return (inst) => {
    if (!inst.alive || inst.state !== STAND) return idle();
    if (look(inst, inst.cell) >= 100) return idle();
    const n = neighbours(inst.cell, NB);
    const live = [];
    for (let k = 0; k < n; k++) if (inst.gone[NB[k]] > inst.t) live.push(NB[k]);
    if (!live.length) return idle();
    return toward(inst.cell, live[Math.floor(rng() * live.length)]);
  };
}

/** A novice: notices only once the tile shakes, then hops in a random direction. */
function panicker(rng) {
  return (inst) => {
    if (!inst.alive || inst.state !== STAND) return idle();
    if (inst.gone[inst.cell] - inst.t > inst.shake[inst.cell]) return idle();
    const d = Math.floor(rng() * 8);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    return axis(dirs[d][0], dirs[d][1]);
  };
}

// ---------------------------------------------------------------------------

describe('platforms — the shared contract', () => {
  it('passes assertRiteContract', () => {
    assertRiteContract(PLATFORMS_RITE, { randCalls: RAND_CALLS, skilled });
  });

  it('declares its randomness budget as 28 collapse + 12 roster + 1 cosmetic seed', () => {
    expect(RAND_CALLS).toBe(41);
  });
});

describe('platforms — the fall schedule', () => {
  it('is a permutation: every tile falls exactly once', () => {
    for (const seed of [1, 77, 4242]) {
      const inst = spawn({ seed, wave: 12 });
      expect([...inst.order].sort((a, b) => a - b)).toEqual(Array.from({ length: TILES }, (_, i) => i));
    }
  });

  it('starts shaking the tile under the player first, on every seed', () => {
    for (const seed of [1, 2, 3, 99, 4242]) {
      const inst = spawn({ seed, wave: 30 });
      expect(inst.order[0]).toBe(inst.cell);
    }
  });

  it('falls in a SHAPE: adjacent tiles go at adjacent times', () => {
    // A uniform shuffle gives a mean neighbour rank gap near 9.7 on this grid;
    // that is what made "hop anywhere that is not shaking" a winning strategy.
    const nb = new Int32Array(8);
    let sum = 0, n = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const inst = spawn({ seed, wave: 28 });
      const rank = new Int32Array(TILES);
      inst.order.forEach((cell, k) => { rank[cell] = k; });
      for (let i = 0; i < TILES; i++) {
        const c = neighbours(i, nb);
        for (let k = 0; k < c; k++) { sum += Math.abs(rank[nb[k]] - rank[i]); n++; }
      }
    }
    const mean = sum / n;
    expect(mean, `mean neighbour rank gap ${mean.toFixed(2)}`).toBeLessThan(7.5);
    expect(mean).toBeGreaterThan(2);
  });

  it('starts each tile shaking on a constant beat, and each one shakes for its own time', () => {
    const inst = spawn({ seed: 5, wave: 20 });
    for (let k = 1; k < TILES; k++) {
      const a = inst.order[k - 1], b = inst.order[k];
      const beat = (inst.gone[b] - inst.shake[b]) - (inst.gone[a] - inst.shake[a]);
      expect(beat).toBeCloseTo(inst.interval, 9);
    }
    const s = [...inst.shake];
    expect(Math.max(...s) / Math.min(...s), 'every tile shakes for the same time').toBeGreaterThan(1.5);
    expect(Math.min(...s)).toBeGreaterThan(HOP);
  });

  it('gets faster and shorter-fused as the wave climbs', () => {
    const early = spawn({ seed: 5, wave: 3 });
    const late = spawn({ seed: 5, wave: 53 });
    expect(late.interval).toBeLessThan(early.interval);
    expect(late.warn).toBeLessThan(early.warn);
    expect(late.runLength).toBeLessThan(PLATFORMS_RITE.duration);
    expect(early.runLength).toBe(PLATFORMS_RITE.duration);
  });

  it('lays a different floor for a different seed', () => {
    expect([...spawn({ seed: 1, wave: 12 }).order]).not.toEqual([...spawn({ seed: 2, wave: 12 }).order]);
  });
});

describe('platforms — hopping', () => {
  it('moves exactly one tile per hop and lands after HOP seconds', () => {
    const inst = spawn({ seed: 3, wave: 3 });
    const from = inst.cell;
    inst.update(DT, axis(1, 0));
    expect(inst.state).toBe(HOPPING);
    expect(inst.to).toBe(from + 1);
    for (let n = 1; n < HOP_STEPS; n++) inst.update(DT, idle());
    expect(inst.state).toBe(HOPPING);
    inst.update(DT, idle());
    expect(inst.state).toBe(STAND);
    expect(inst.cell).toBe(from + 1);
    expect(inst.px).toBeCloseTo(cellX(from + 1), 9);
  });

  it('keeps hopping while the key is held, and stops when it is let go', () => {
    const inst = spawn({ seed: 3, wave: 3 });
    const from = inst.cell;
    for (let n = 0; n < HOP_STEPS * 2; n++) inst.update(DT, axis(-1, 0));
    expect(inst.state).toBe(HOPPING);
    expect(inst.to).toBe(from - 2);
    stepUntil(inst, idle(), (i) => i.state === STAND);
    for (let n = 0; n < 10; n++) inst.update(DT, idle());
    expect(inst.cell).toBe(from - 2);
  });

  it('takes a tap made mid-air on landing, so a quick press is never lost', () => {
    const inst = spawn({ seed: 3, wave: 3 });
    const from = inst.cell;
    inst.update(DT, axis(0, 1));
    for (let n = 0; n < 10; n++) inst.update(DT, idle());
    inst.update(DT, axis(1, 0));                          // a one-frame tap mid-air
    stepUntil(inst, idle(), (i) => i.state === STAND && i.to < 0 && i.cell !== from - COLS);
    stepUntil(inst, idle(), (i) => i.state === STAND);
    expect(inst.cell).toBe(from - COLS + 1);
  });

  it('bends the hop diagonal when the second arrow lands a few frames late, with no extra hop', () => {
    for (const lag of [1, 2, 3, 4]) {
      const inst = spawn({ seed: 3, wave: 3 });
      const from = inst.cell;
      for (let n = 0; n < lag; n++) inst.update(DT, axis(0, 1));
      for (let n = lag; n < HOP_STEPS - 1; n++) inst.update(DT, axis(1, 1));
      stepUntil(inst, idle(), (i) => i.state === STAND);
      expect(inst.cell, `second arrow ${lag} steps late`).toBe(from - COLS + 1);
      for (let n = 0; n < 60; n++) inst.update(DT, idle());
      expect(inst.cell).toBe(from - COLS + 1);
    }
  });

  it('keeps a mid-air tap made while holding another arrow, even released before the landing', () => {
    const inst = spawn({ seed: 3, wave: 3 });
    const from = inst.cell;
    for (let n = 0; n < 10; n++) inst.update(DT, axis(0, 1));
    for (let n = 0; n < 3; n++) inst.update(DT, axis(1, 1));
    stepUntil(inst, axis(0, 1), (i) => i.state === STAND || i.cell !== from);
    expect(inst.cell).toBe(from - COLS);
    expect(inst.to).toBe(from - 2 * COLS + 1);
  });

  it('hops diagonally on two keys, and the edge of the floor is a wall', () => {
    const c = 2 * COLS + 3;
    expect(hopTarget(c, 1, 1)).toBe(COLS + 4);
    expect(hopTarget(0, -1, 0)).toBe(-1);
    expect(hopTarget(0, -1, 1)).toBe(-1);
    expect(hopTarget(COLS - 1, 1, 1)).toBe(-1);
    expect(hopTarget(COLS - 1, 1, -1)).toBe(2 * COLS - 1);   // the in-grid part survives
    // Held into the wall, the player stays on the floor until the floor goes.
    const { inst } = play(() => axis(-1, 0), { seed: 3, wave: 3 });
    expect(cellAt(inst.px, inst.py) % COLS).toBe(0);
  });
});

describe('platforms — dying', () => {
  it('drops an idle player with the first tile and scores 0.04 to 0.14', () => {
    // The floor is the start tile's own shake, which varies per tile: 0.98 s
    // to 2.0 s at wave 3, so the idle run is 1.9-3.0 s of a 24 s run.
    for (const wave of [3, 18, 28, 43, 53]) {
      const { inst, score } = play(idle, { seed: 5, wave });
      expect(inst.alive, `wave ${wave}: idle survived`).toBe(false);
      expect(inst.aliveFor, `wave ${wave}`).toBeCloseTo(inst.gone[inst.order[0]], 1);
      expect(score.ratio, `wave ${wave}: idle ratio ${score.ratio}`).toBeGreaterThan(0.04);
      expect(score.ratio, `wave ${wave}: idle ratio ${score.ratio}`).toBeLessThan(0.14);
    }
  });

  it('kills a player standing on a tile at that tile’s own drop time', () => {
    const inst = spawn({ seed: 21, wave: 15 });
    const victim = inst.order[6];
    park(inst, victim);
    stepUntil(inst, idle(), (i) => !i.alive);
    expect(inst.state).toBe(OUT);
    expect(inst.aliveFor).toBeGreaterThanOrEqual(inst.gone[victim]);
    expect(inst.aliveFor - inst.gone[victim]).toBeLessThanOrEqual(DT + 1e-9);
  });

  it('wears out a tile you stand on for 2.5 s: it darkens, then drops', () => {
    const inst = spawn({ seed: 21, wave: 15 });
    const cell = inst.order[TILES - 1];
    park(inst, cell);
    const scheduled = inst.gone[cell];
    const t0 = inst.t;
    stepUntil(inst, idle(), (i) => i.gone[cell] !== scheduled, Math.ceil(2.5 / DT) + 2);
    expect(inst.t - t0).toBeCloseTo(2.5, 1);
    expect(inst.gone[cell] - inst.t).toBeCloseTo(inst.shake[cell] * STRESS_LEAD, 9);
    expect(inst.gone[cell]).toBeLessThan(scheduled);
    stepUntil(inst, idle(), (i) => !i.alive);
    expect(inst.aliveFor - inst.gone[cell]).toBeLessThanOrEqual(DT + 1e-9);
  });

  it('does not wear a tile you keep hopping off', () => {
    const inst = spawn({ seed: 21, wave: 3 });
    const a = inst.order[TILES - 1];
    const nb = new Int32Array(8);
    const n = neighbours(a, nb);
    let b = nb[0];
    for (let k = 1; k < n; k++) if (inst.gone[nb[k]] > inst.gone[b]) b = nb[k];
    park(inst, a);
    const ga = inst.gone[a], gb = inst.gone[b];
    for (let k = 0; k < 6; k++) {
      const [from, to] = k % 2 ? [b, a] : [a, b];
      stepUntil(inst, idle(), () => false, Math.ceil(1 / DT));
      inst.update(DT, toward(from, to));
      stepUntil(inst, idle(), (i) => i.state === STAND);
    }
    expect(inst.alive).toBe(true);
    expect(inst.gone[a]).toBe(ga);
    expect(inst.gone[b]).toBe(gb);
  });

  it('kills a player who lands in a hole, at the landing', () => {
    const inst = spawn({ seed: 21, wave: 15 });
    const hole = inst.order[5];
    const nb = new Int32Array(8);
    const n = neighbours(hole, nb);
    let from = -1;
    for (let k = 0; k < n; k++) if (inst.gone[nb[k]] > inst.gone[hole] + 2) from = nb[k];
    expect(from, 'no standing neighbour next to the hole on this seed').toBeGreaterThanOrEqual(0);
    holdOn(inst, from, (i) => i.t > i.gone[hole] + 0.1);
    const t0 = inst.t;
    inst.update(DT, toward(from, hole));
    stepUntil(inst, idle(), (i) => !i.alive || i.state === STAND, HOP_STEPS + 2);
    expect(inst.alive).toBe(false);
    expect(inst.aliveFor - t0).toBeCloseTo(HOP, 1);
  });

  it('saves a player who takes off a frame before the drop, and says so', () => {
    const inst = spawn({ seed: 21, wave: 15 });
    const cell = inst.order[8];
    const nb = new Int32Array(8);
    const n = neighbours(cell, nb);
    let to = nb[0];
    for (let k = 1; k < n; k++) if (inst.gone[nb[k]] > inst.gone[to]) to = nb[k];
    park(inst, cell);
    stepUntil(inst, idle(), (i) => i.gone[cell] - i.t <= 2 * DT);
    inst.drainEvents();
    inst.update(DT, toward(cell, to));
    expect(inst.drainEvents().map((e) => e.type)).toContain('perfect');
    stepUntil(inst, idle(), (i) => i.state === STAND);
    expect(inst.alive).toBe(true);
    expect(inst.cell).toBe(to);
  });

  it('ends shortly after the player is out rather than running the full clock', () => {
    const { inst, steps } = play(idle, { seed: 5, wave: 3 });
    expect(steps * DT).toBeLessThan(inst.aliveFor + 2);
  });
});

describe('platforms — the rivals', () => {
  it('fields three named rivals, all distinct, the same three for every player on a seed', () => {
    const a = spawn({ seed: 8, wave: 22 }).rivals.roster().map((r) => r.name);
    expect(new Set(a).size).toBe(RIVAL_COUNT);
    for (const n of a) expect(NAMES).toContain(n);
    expect(spawn({ seed: 8, wave: 22 }).rivals.roster().map((r) => r.name)).toEqual(a);
  });

  it('never shows a ghost standing on a tile that has gone, and never outlives its published time', () => {
    // The visual honesty claim the view depends on: a ghost on the floor is on
    // a tile that is still there. A stand on a gone tile would draw a rival
    // floating over the void.
    const at = { x: 0, y: 0, h: 0 };
    for (const seed of [1, 12, 99, 4242]) {
      for (const wave of [3, 28, 53]) {
        const inst = spawn({ seed, wave });
        for (let id = 0; id < RIVAL_COUNT; id++) {
          const out = inst.rivalOut[id];
          if (Number.isFinite(out)) expect(out).toBeLessThanOrEqual(inst.rivals.outAt(id) + 1e-9);
          const p = inst.paths[id];
          for (let k = 1; k < p.t.length; k++) expect(p.t[k]).toBeGreaterThanOrEqual(p.t[k - 1]);
          const end = Math.min(out, inst.runLength);
          for (let t = 0; t < end - 1e-6; t += 0.05) {
            inst.ghostAt(id, t, at);
            if (at.h > 0) continue;
            const c = cellAt(at.x, at.y);
            expect(c, `seed ${seed} w${wave} ghost ${id} off the floor at ${t.toFixed(2)}`).toBeGreaterThanOrEqual(0);
            expect(inst.gone[c], `seed ${seed} w${wave} ghost ${id} on a gone tile at ${t.toFixed(2)}`)
              .toBeGreaterThan(t);
          }
        }
      }
    }
  });

  it('keeps rivals under the wear rule, and walks them off a tile the player wore out', () => {
    // A player who walks to a rival and parks wears tiles out next to it and
    // under it. Rivals must see a worn tile like any other drop and keep off
    // it, and no rival may stand still longer than the player is allowed to.
    const at = { x: 0, y: 0, h: 0 };
    let wears = 0, rodeWornDown = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const inst = spawn({ seed, wave: 12 });
      const prey = seed % RIVAL_COUNT;
      const planned = Float64Array.from(inst.gone);
      const still = new Float64Array(RIVAL_COUNT);
      const last = Array.from({ length: RIVAL_COUNT }, () => ({ x: NaN, y: NaN }));
      for (let n = 0; n < 2000; n++) {
        let input = idle();
        if (inst.alive && inst.state === STAND) {
          inst.ghostAt(prey, inst.t, at);
          const dx = at.x - inst.px, dy = at.y - inst.py;
          if (look(inst, inst.cell) < 100) {
            input = axis(Math.sign(Math.round(dx)) || 1, Math.sign(Math.round(dy)));
          }
        }
        const before = Float64Array.from(inst.gone);
        const done = inst.update(DT, input) === true;
        for (let c = 0; c < TILES; c++) if (inst.gone[c] < before[c]) wears++;
        for (let id = 0; id < RIVAL_COUNT; id++) {
          if (inst.rivalOut[id] <= inst.t) continue;
          inst.ghostAt(id, inst.t, at);
          const moved = at.x !== last[id].x || at.y !== last[id].y;
          still[id] = moved ? 0 : still[id] + DT;
          last[id].x = at.x; last[id].y = at.y;
          expect(still[id], `seed ${seed} rival ${id} stood ${still[id].toFixed(2)} s`).toBeLessThan(LINGER);
          if (at.h === 0) {
            expect(inst.gone[cellAt(at.x, at.y)], `seed ${seed} rival ${id} on a gone tile`).toBeGreaterThan(inst.t);
          }
        }
        for (const e of inst.drainEvents()) {
          if (e.type !== 'claim') continue;
          inst.ghostAt(e.i, inst.rivalOut[e.i], at);
          expect(e.x, `seed ${seed} rival ${e.i} claimed away from where it fell`).toBe(at.x);
          const p = inst.paths[e.i];
          const stood = p.x.at(-1) === p.x.at(-2) && p.y.at(-1) === p.y.at(-2);
          const c = cellAt(at.x, at.y);
          if (stood && inst.gone[c] !== planned[c]) rodeWornDown++;
        }
        if (done) break;
      }
    }
    expect(wears, 'the chase never wore a tile out').toBeGreaterThan(30);
    expect(rodeWornDown, 'a rival stood on a worn tile until it dropped').toBe(0);
  });

  it('drops every ghost into a hole or with its tile, never over the edge of the floor', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const wave of [3, 28, 53]) {
        const inst = spawn({ seed, wave });
        for (let id = 0; id < RIVAL_COUNT; id++) {
          const out = inst.rivalOut[id];
          if (!Number.isFinite(out)) continue;
          const p = inst.paths[id];
          const c = cellAt(p.x[p.x.length - 1], p.y[p.y.length - 1]);
          expect(c, `seed ${seed} w${wave} ghost ${id} ends off the floor`).toBeGreaterThanOrEqual(0);
          expect(inst.gone[c], `seed ${seed} w${wave} ghost ${id} ends on live stone`).toBeLessThanOrEqual(out + 1e-9);
        }
      }
    }
  });

  it('makes outliving rivals worth exactly a quarter of the score', () => {
    const { inst, score } = play(skilled, { seed: 909, wave: 28 });
    const outlived = inst.outlived();
    expect(outlived).toBeGreaterThan(0);
    const before = inst.rivalOut.slice();
    for (let i = 0; i < RIVAL_COUNT; i++) inst.rivalOut[i] = Infinity;
    const lonely = inst.score();
    inst.rivalOut.set(before);
    expect(score.ratio - lonely.ratio).toBeCloseTo(0.25 * (outlived / RIVAL_COUNT), 9);
    expect(score.detail).toContain(`outlived ${outlived} of ${RIVAL_COUNT}`);
  });

  it('announces each rival leaving exactly once', () => {
    const inst = spawn({ seed: 909, wave: 28 });
    const cap = Math.ceil(PLATFORMS_RITE.duration / DT) + 1;
    const seen = { claim: 0, fail: 0, start: 0 };
    for (let n = 0; n < cap; n++) {
      const ended = inst.update(DT, skilled(inst)) === true;
      for (const e of inst.drainEvents()) if (e.type in seen) seen[e.type]++;
      if (ended) break;
    }
    expect(seen.start).toBe(1);
    expect(seen.fail).toBeLessThanOrEqual(1);
    expect(seen.claim).toBe([...inst.rivalOut].filter((t) => t <= inst.t).length);
  });
});

describe('platforms — skill', () => {
  const mean = (wave, strat, seeds = 16) => {
    let sum = 0;
    for (let seed = 1; seed <= seeds; seed++) sum += play(strat(seed), { seed, wave }).score.ratio;
    return sum / seeds;
  };

  it('makes the BEST neighbour worth more than any live one', () => {
    // The collapse's own regression test: if neighbours died independently,
    // a random live neighbour would be as good as the best one. Measured at
    // 0.120 / 0.116 / 0.168 (64 seeds) since rivals keep hopping too. Sixteen
    // seeds read 0.094 / 0.017 / 0.072 on the same code: the rivals' share of
    // the score is noise at that size. Smaller than the 2D rite's ~0.23, and
    // that is the honest cost of 8-way hops: most neighbours can be reached
    // and left again, so the skill moved from "which tile" to "leave in time".
    for (const wave of [3, 28, 53]) {
      const best = mean(wave, () => skilled, 64);
      const any = mean(wave, (seed) => anyLive(mulberry32(seed * 7 + 3)), 64);
      expect(best - any, `wave ${wave}: best ${best.toFixed(3)} vs any-live ${any.toFixed(3)}`)
        .toBeGreaterThan(0.03);
    }
  });

  it('rewards reading the floor over panicking over doing nothing', () => {
    for (const wave of [18, 43]) {
      const good = mean(wave, () => skilled, 12);
      const panic = mean(wave, (seed) => panicker(mulberry32(seed + 5)), 12);
      const none = mean(wave, () => idle, 12);
      expect(good, `wave ${wave}`).toBeGreaterThan(panic + 0.1);
      expect(panic, `wave ${wave}`).toBeGreaterThan(none + 0.05);
    }
  });
});

describe('platforms — what the view reads', () => {
  it('playerAt agrees with the stepped position and arcs mid-hop', () => {
    const inst = spawn({ seed: 3, wave: 3 });
    const at = { x: 0, y: 0, h: 0 };
    inst.update(DT, axis(1, 0));
    for (let n = 0; n < HOP_STEPS / 2; n++) inst.update(DT, idle());
    inst.playerAt(inst.t, at);
    expect(at.x).toBeCloseTo(inst.px, 9);
    expect(at.y).toBeCloseTo(inst.py, 9);
    expect(at.h).toBeGreaterThan(0.9);
    stepUntil(inst, idle(), (i) => i.state === STAND);
    inst.playerAt(inst.t, at);
    expect(at.h).toBe(0);
    expect(at.x).toBe(inst.px);
  });

  it('exposes a cosmetic seed and a standing count for the HUD', () => {
    const inst = spawn({ seed: 3, wave: 3 });
    expect(Number.isInteger(inst.fxSeed)).toBe(true);
    expect(inst.standing(0)).toBe(TILES);
    expect(inst.standing(1e9)).toBe(0);
    expect(TILES).toBe(COLS * ROWS);
  });
});

describe('platforms — the definition', () => {
  it('is a 3D rite with arrows-only rules', () => {
    expect(PLATFORMS_RITE.id).toBe('platforms');
    expect(PLATFORMS_RITE.duration).toBe(24);
    expect(typeof PLATFORMS_RITE.view).toBe('function');
    expect(PLATFORMS_RITE.cursor).toBe('default');
    expect(PLATFORMS_RITE.keys.map((k) => k.action)).toEqual(['Hop', 'Hop (letters)']);
    expect(PLATFORMS_RITE.rules.join(' ')).toMatch(/diagonal/);
  });
});
