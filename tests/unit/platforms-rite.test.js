/**
 * PLATFORMS — the rite where the floor is the clock.
 *
 * `assertRiteContract` covers everything true of ANY rite (fixed rand budget,
 * determinism, an idle run that ends and pays nothing, mashing beaten by play,
 * fuzz stays finite and bounded, score() pure, drainEvents empties). What is
 * here on top of it is the set of claims specific to THIS design — the ones a
 * refactor could break while every generic assertion stayed green:
 *
 *   - the fall order is a PERMUTATION and the player's own plate is first;
 *   - the collapse has a SHAPE — neighbouring plates go at neighbouring times,
 *     it opens under the player, and every plate has its own temper;
 *   - the SAG is a tax and never a cage: leaving late costs real time, leaving
 *     at the last instant is still possible;
 *   - the best neighbour is worth much more than any live one — the claim the
 *     whole redesign exists to make true, and the one a tuning pass could
 *     quietly undo while every other assertion here stayed green;
 *   - an idle player dies on that plate and lands in the 0.08-0.14 band;
 *   - standing on a doomed plate kills you at exactly its published time;
 *   - the field EDGE kills too, with no tile involved;
 *   - the rival term is worth exactly 0.25 and moves the score;
 *   - `draw()` does not mutate a single field.
 *
 * `node` environment: this file must never reach for a DOM. The painter used by
 * the purity test is a proxy that answers every call with itself, which is
 * enough because a rite is not allowed to READ anything back from the painter.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { mulberry32 } from '../../src/core/Rng.js';
import { NAMES } from '../../src/minigames/rivals.js';
import {
  PLATFORMS_RITE, RAND_CALLS, TILES, COLS, RIVAL_COUNT,
  cellX, cellY, cellAt, neighbours,
} from '../../src/minigames/rites/PlatformsRite.js';
import { assertRiteContract } from './helpers/rite-contract.js';

const DT = MINIGAMES.dt;

/** Where the player starts, in grid coordinates. Mirrors PLAYER_START. */
const PLAYER_START_COL = 3;
const PLAYER_START_ROW = 2;

function spawn({ seed = 1, wave = 8, occurrence = 0 } = {}) {
  const inst = PLATFORMS_RITE.create();
  inst.init({
    rand: riteRng(seed, PLATFORMS_RITE.id, occurrence),
    wave, width: FIELD.w, height: FIELD.h, quality: 'high',
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

/** An axis that walks the marker toward a world point. Nothing else steers. */
function toward(inst, tx, ty) {
  const dx = tx - inst.px, dy = ty - inst.py;
  return makeInput({
    axis: {
      x: Math.abs(dx) > 0.06 ? Math.sign(dx) : 0,
      y: Math.abs(dy) > 0.06 ? Math.sign(dy) : 0,
    },
  });
}

/**
 * Deliberate play: stand still while the plate is comfortable, otherwise move to
 * whichever neighbour lasts longest.
 *
 * It reads `inst.gone` directly, so it is an ORACLE and scores above what a
 * human can — that is fine for its two jobs (beat mashing, beat a panicker) and
 * it is stated here so nobody reads 0.97 as a claim about the player experience.
 */
const NB = new Int32Array(4);
function skilled(inst) {
  const cur = cellAt(inst.px, inst.py);
  if (cur < 0) return makeInput();
  const n = neighbours(cur, NB);
  let best = cur, bestGone = inst.gone[cur];
  for (let k = 0; k < n; k++) {
    if (inst.gone[NB[k]] > bestGone) { bestGone = inst.gone[NB[k]]; best = NB[k]; }
  }
  const target = inst.gone[cur] - inst.t > 1.1 ? cur : best;
  return toward(inst, cellX(target), cellY(target));
}

/**
 * The same reader as `skilled`, with ONE thing changed: it steps to a random
 * neighbour that has not gone yet instead of to the longest-lived one. The gap
 * between the two is the whole claim that this rite has a decision in it.
 */
function anyLive(rng) {
  return (inst) => {
    const cur = cellAt(inst.px, inst.py);
    if (cur < 0) return makeInput();
    if (inst.gone[cur] - inst.t > 1.1) return makeInput();
    const n = neighbours(cur, NB);
    const live = [];
    for (let k = 0; k < n; k++) if (inst.gone[NB[k]] > inst.t) live.push(NB[k]);
    const tgt = live.length ? live[Math.floor(rng() * live.length)] : cur;
    return toward(inst, cellX(tgt), cellY(tgt));
  };
}

/** A novice: notices only at the last moment, then hops somewhere at random. */
function panicker(rng) {
  let tgt = -1;
  return (inst) => {
    const cur = cellAt(inst.px, inst.py);
    if (cur < 0) return makeInput();
    if (tgt < 0 || tgt === cur) {
      if (inst.gone[cur] - inst.t > 0.7) return makeInput();
      tgt = NB[Math.floor(rng() * neighbours(cur, NB))];
    }
    return toward(inst, cellX(tgt), cellY(tgt));
  };
}

/**
 * Every call answers with itself, so a chained draw runs without a canvas —
 * AND ANY FUNCTION ARGUMENT IS INVOKED.
 *
 * That second half is not politeness. `draw()` now wraps the whole frame in
 * `Painter.clipField(fn)`, and a stub that swallowed the callback would run the
 * purity test and the survives-the-whole-run test against a painter that drew
 * NOTHING: both would pass forever, on any code, including code that throws on
 * its first line. A stub that silently makes its suite vacuous is worse than no
 * stub, so this one calls what it is handed.
 */
function stubPainter() {
  const p = new Proxy({}, {
    get: () => (...args) => {
      for (const a of args) if (typeof a === 'function') a(p);
      return p;
    },
  });
  return p;
}

/** Cycle-safe structural snapshot, typed arrays included. */
function snap(o, depth = 0, seen = new Set()) {
  if (o === null || typeof o !== 'object') return typeof o === 'number' && !Number.isFinite(o) ? String(o) : o;
  if (seen.has(o) || depth > 5) return '[deep]';
  seen.add(o);
  if (Array.isArray(o) || ArrayBuffer.isView(o)) return Array.from(o, (v) => snap(v, depth + 1, seen));
  const out = {};
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'function') continue;
    out[k] = snap(o[k], depth + 1, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('platforms — the shared contract', () => {
  it('passes assertRiteContract', () => {
    assertRiteContract(PLATFORMS_RITE, { randCalls: RAND_CALLS, skilled });
  });

  it('declares its randomness budget as 28 shuffle + 12 roster + 1 noise seed', () => {
    // Spelled out rather than recomputed from the constants it is checking: the
    // point of the number is that a stray draw changes it, and a formula that
    // tracks the code cannot notice a stray draw.
    expect(RAND_CALLS).toBe(41);
  });
});

describe('platforms — the fall schedule', () => {
  it('is a permutation: every tile falls exactly once, none twice', () => {
    for (const seed of [1, 77, 4242]) {
      const inst = spawn({ seed, wave: 12 });
      expect(inst.order).toHaveLength(TILES);
      expect(new Set(inst.order).size).toBe(TILES);
      expect([...inst.order].sort((a, b) => a - b))
        .toEqual(Array.from({ length: TILES }, (_, i) => i));
    }
  });

  it('puts the plate under the player first, on every seed', () => {
    // The rite's one designed certainty. If this ever stops being true, an idle
    // player's death becomes a uniform draw over the run and "start it and look
    // away" is worth a third of a real score.
    for (const seed of [1, 2, 3, 99, 4242]) {
      const inst = spawn({ seed, wave: 30 });
      expect(cellAt(inst.px, inst.py)).toBe(inst.order[0]);
    }
  });

  it('falls in a SHAPE: adjacent plates go at adjacent times', () => {
    // THE central claim of the redesign, stated as a number rather than as a
    // docblock. Under the uniform permutation this rite used to deal, the fall
    // ranks of two neighbouring cells were independent, so the mean absolute
    // rank gap across every edge of the grid was 9.7 — a third of the whole
    // schedule, which is what made "step anywhere that is not flashing" a
    // winning strategy. A correlated collapse has to be well under that or the
    // destination is not scarce and nothing else in the design matters.
    const nb = new Int32Array(4);
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
    expect(mean, `mean neighbour rank gap ${mean.toFixed(2)} — the collapse has lost its shape`)
      .toBeLessThan(7);
    // And not a machine either: a zero-jitter distance field would deal rings in
    // index order and the floor would be the same picture every seed.
    expect(mean).toBeGreaterThan(2);
  });

  it('opens the ground under the player and spreads outward from there', () => {
    // The collapse field has a well at the player's cell, so the plates that go
    // early are the ones NEAR the player. Without this the opening beat is a
    // crack somewhere the player is not looking.
    for (const seed of [1, 77, 4242]) {
      const inst = spawn({ seed, wave: 12 });
      const early = inst.order.slice(0, 6);
      let near = 0;
      for (const cell of early) {
        const dc = Math.abs((cell % COLS) - (PLAYER_START_COL));
        const dr = Math.abs(Math.floor(cell / COLS) - PLAYER_START_ROW);
        if (dc + dr <= 2) near++;
      }
      expect(near, `seed ${seed}: only ${near} of the first six plates were near the player`)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it('gives every plate its own temper, so late departures are a risk and not a rule', () => {
    // A single sag value for the whole floor makes every hop the same hop: the
    // mechanic stops being "leaving late is risky" and becomes "leaving late is
    // fatal", which is a cliff wearing a slope's clothes. The spread is what
    // puts a distribution under the score.
    const inst = spawn({ seed: 9, wave: 28 });
    const vals = [...inst.temper];
    expect(Math.min(...vals)).toBeGreaterThan(0);
    expect(Math.max(...vals) / Math.min(...vals), 'the floor tips uniformly')
      .toBeGreaterThan(2);
  });

  it('releases plates at a constant interval, in order', () => {
    const inst = spawn({ seed: 5, wave: 20 });
    for (let k = 1; k < TILES; k++) {
      const gap = inst.gone[inst.order[k]] - inst.gone[inst.order[k - 1]];
      expect(gap).toBeCloseTo(inst.interval, 9);
    }
  });

  it('gets faster and shouts later as the wave climbs', () => {
    const early = spawn({ seed: 5, wave: 3 });
    const late = spawn({ seed: 5, wave: 53 });
    expect(late.interval).toBeLessThan(early.interval);
    expect(late.warn).toBeLessThan(early.warn);
    // The floor runs out before the host's clock at the last wave, and does not
    // at the first: the run length is the shorter of schedule and duration.
    expect(late.runLength).toBeLessThan(PLATFORMS_RITE.duration);
    expect(early.runLength).toBe(PLATFORMS_RITE.duration);
  });

  it('lays a different floor for a different seed', () => {
    const a = spawn({ seed: 1, wave: 12 });
    const b = spawn({ seed: 2, wave: 12 });
    expect([...a.order]).not.toEqual([...b.order]);
  });
});

describe('platforms — dying', () => {
  it('drops an idle player on the first plate and scores 0.08 to 0.14', () => {
    for (const wave of [3, 18, 28, 43, 53]) {
      const { inst, score } = play(() => makeInput(), { seed: 5, wave });
      const expected = inst.gone[inst.order[0]];
      expect(inst.alive, `wave ${wave}: idle survived`).toBe(false);
      expect(inst.aliveFor, `wave ${wave}: died at the wrong time`).toBeCloseTo(expected, 1);
      expect(score.ratio, `wave ${wave}: idle ratio ${score.ratio}`).toBeGreaterThan(0.07);
      expect(score.ratio, `wave ${wave}: idle ratio ${score.ratio}`).toBeLessThan(0.14);
    }
  });

  it('kills a player who never leaves a doomed plate, at that plate’s own time', () => {
    // Parked on a plate chosen from the schedule rather than the start cell, so
    // this is about the rule and not about the opening beat.
    const inst = spawn({ seed: 21, wave: 15 });
    const victim = inst.order[6];
    inst.px = cellX(victim); inst.py = cellY(victim); inst.cell = victim;
    const cap = Math.ceil(PLATFORMS_RITE.duration / DT) + 1;
    for (let n = 0; n < cap && inst.alive; n++) inst.update(DT, makeInput());
    expect(inst.alive).toBe(false);
    // Within one fixed step of the published time — it cannot be exact, because
    // the check happens on step boundaries.
    expect(inst.aliveFor).toBeGreaterThanOrEqual(inst.gone[victim]);
    expect(inst.aliveFor - inst.gone[victim]).toBeLessThanOrEqual(DT + 1e-9);
  });

  it('kills a player who walks off the edge, with no plate involved', () => {
    // Straight left from x = 0 reaches the void at 7 / 4.4 = 1.59 s, well before
    // the start plate is due. Edge and fallen plate must be the same rule.
    const { inst } = play(() => makeInput({ axis: { x: -1, y: 0 } }), { seed: 3, wave: 3 });
    expect(inst.alive).toBe(false);
    expect(inst.aliveFor).toBeLessThan(inst.gone[inst.order[0]]);
    expect(inst.aliveFor).toBeCloseTo(7 / 4.4, 1);
    expect(inst.px).toBeLessThan(-7);
  });

  it('ends shortly after the player is out rather than running the full clock', () => {
    // The plan's wording is "the clock keeps running and your survival number
    // freezes". It does — for a beat, so the fall is seen — and then the rite
    // returns. Twenty seconds of watching a floor you are not on is not a rite,
    // it is a screensaver, and the score cannot change after the elimination.
    const { inst, steps } = play(() => makeInput(), { seed: 5, wave: 3 });
    expect(steps * DT).toBeLessThan(inst.aliveFor + 2);
    expect(steps * DT).toBeLessThan(PLATFORMS_RITE.duration);
  });
});

describe('platforms — the rivals', () => {
  it('fields three named rivals, all distinct and all from the shared pool', () => {
    const inst = spawn({ seed: 8, wave: 22 });
    const names = inst.rivals.roster().map((r) => r.name);
    expect(names).toHaveLength(RIVAL_COUNT);
    expect(new Set(names).size).toBe(RIVAL_COUNT);
    for (const n of names) expect(NAMES).toContain(n);
  });

  it('gives every player on a seed the same three rivals', () => {
    const a = spawn({ seed: 4242, wave: 31 }).rivals.roster().map((r) => r.name);
    const b = spawn({ seed: 4242, wave: 31 }).rivals.roster().map((r) => r.name);
    expect(b).toEqual(a);
  });

  it('walks each ghost off its own plate and eliminates it on the field', () => {
    const inst = spawn({ seed: 12, wave: 26 });
    for (let id = 0; id < RIVAL_COUNT; id++) {
      const out = inst.rivalOut[id];
      expect(Number.isFinite(out) || out === Infinity).toBe(true);
      if (Number.isFinite(out)) {
        expect(out).toBeGreaterThan(0);
        // Never later than the published elimination time — outAt() is the cap,
        // the walk may only kill a ghost sooner.
        expect(out).toBeLessThanOrEqual(inst.rivals.outAt(id) + 1e-9);
      }
      // The path is a hold-then-glide polyline with strictly non-decreasing time.
      const p = inst.paths[id];
      for (let k = 1; k < p.t.length; k++) expect(p.t[k]).toBeGreaterThanOrEqual(p.t[k - 1]);
    }
  });

  it('makes outliving rivals worth exactly a quarter of the score', () => {
    const { inst, score } = play(skilled, { seed: 909, wave: 28 });
    const outlived = inst.outlived();
    expect(outlived).toBeGreaterThan(0);

    // Same survival, no rivals beaten: the ratio must drop by 0.25 * n / 3.
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
    let claims = 0;
    let fails = 0;
    let starts = 0;
    for (let n = 0; n < cap; n++) {
      const ended = inst.update(DT, skilled(inst, n)) === true;
      for (const e of inst.drainEvents()) {
        if (e.type === 'claim') claims++;
        if (e.type === 'fail') fails++;
        if (e.type === 'start') starts++;
      }
      if (ended) break;
    }
    expect(starts).toBe(1);
    expect(fails).toBeLessThanOrEqual(1);
    expect(claims).toBe([...inst.rivalOut].filter((t) => t <= inst.t).length);
    expect(claims).toBeLessThanOrEqual(RIVAL_COUNT);
  });
});

describe('platforms — the sag', () => {
  it('costs real time to leave a plate late, and almost nothing to leave it early', () => {
    // The mechanic, measured on the clock rather than asserted. Same plate, same
    // distance, same input; only the moment of departure differs. If these two
    // ever converge, the rite is back to a flat cost and the skill ladder goes
    // flat with it — that is exactly how it broke the first time.
    const cross = (leadSeconds) => {
      const inst = spawn({ seed: 4, wave: 28 });
      const cell = inst.order[14];
      const target = cell - COLS;            // the plate directly above
      const leave = inst.gone[cell] - leadSeconds;
      // Fast-forward with no input; the player is parked on `cell`.
      inst.px = cellX(cell); inst.py = cellY(cell); inst.cell = cell;
      while (inst.t < leave) inst.update(DT, makeInput());
      const t0 = inst.t;
      const ty = cellY(target);
      for (let n = 0; n < 400; n++) {
        if (cellAt(inst.px, inst.py) === target) return inst.t - t0;
        inst.update(DT, makeInput({ axis: { x: 0, y: Math.sign(ty - inst.py) } }));
      }
      return Infinity;
    };
    const early = cross(2.6);      // before the stone has started to tip
    const late = cross(0.55);      // in the last half second
    expect(early, `an early hop took ${early.toFixed(3)}s`).toBeLessThan(0.5);
    expect(late, `a late hop took ${late.toFixed(3)}s, an early one ${early.toFixed(3)}s`)
      .toBeGreaterThan(early * 1.4);
  });

  it('always lets you off eventually — the pull is a tax, never a cage', () => {
    // The one thing the sag must never do. A pull at or above SPEED would mean a
    // plate that cannot be left at all, which is not difficulty, it is a rite
    // that stopped taking input.
    for (const wave of [3, 28, 53]) {
      const inst = spawn({ seed: 3, wave });
      const cell = inst.order[20];
      inst.px = cellX(cell); inst.py = cellY(cell); inst.cell = cell;
      // Park until the very last instant, then run.
      while (inst.t < inst.gone[cell] - 0.30) inst.update(DT, makeInput());
      const start = inst.py;
      for (let n = 0; n < 12; n++) inst.update(DT, makeInput({ axis: { x: 0, y: 1 } }));
      expect(inst.py, `wave ${wave}: the plate would not release the player at all`)
        .toBeGreaterThan(start + 1e-6);
    }
  });
});

describe('platforms — skill', () => {
  it('makes the BEST neighbour worth much more than any live one', () => {
    // The critics' finding, turned into a gate. Two oracles, identical except
    // for which neighbour they pick: `skilled` takes the longest-lived,
    // `anyLive` takes a random one that has not gone yet. Under the uniform
    // permutation this rite used to deal, the gap was 0.09 / 0.04 / 0.02 — i.e.
    // "moving ANYWHERE was correct" and the rite had one line of play with no
    // decision in it. The collapse pattern is the thing that makes the choice
    // cost something, so this number is the collapse's own regression test.
    const at = (wave, strat) => {
      let sum = 0;
      for (let seed = 1; seed <= 16; seed++) sum += play(strat(seed), { seed, wave }).score.ratio;
      return sum / 16;
    };
    for (const wave of [3, 28, 53]) {
      const best = at(wave, () => skilled);
      const any = at(wave, (seed) => anyLive(mulberry32(seed * 7 + 3)));
      expect(best - any, `wave ${wave}: best-neighbour ${best.toFixed(3)} vs `
        + `any-live-neighbour ${any.toFixed(3)} — the destination is not scarce`)
        .toBeGreaterThan(0.12);
    }
  });

  it('rewards reading the floor over panicking over wandering over nothing', () => {
    const at = (wave, strat) => {
      let sum = 0;
      for (let seed = 1; seed <= 12; seed++) sum += play(strat(), { seed, wave }).score.ratio;
      return sum / 12;
    };
    for (const wave of [18, 43]) {
      const good = at(wave, () => skilled);
      const panic = at(wave, () => panicker(mulberry32(5)));
      const idle = at(wave, () => () => makeInput());
      expect(good, `wave ${wave}`).toBeGreaterThan(panic + 0.05);
      expect(panic, `wave ${wave}`).toBeGreaterThan(idle + 0.2);
    }
  });

  it('never pays a full score for a run that ended early', () => {
    const { score, inst } = play(() => makeInput(), { seed: 5, wave: 28 });
    expect(score.ratio).toBeLessThan(0.75 * (inst.aliveFor / inst.runLength) + 0.25 + 1e-9);
    expect(score.ratio).toBeLessThanOrEqual(1);
  });
});

describe('platforms — drawing', () => {
  it('draw() mutates nothing, mid-run or after the fall', () => {
    for (const wave of [3, 40]) {
      const inst = spawn({ seed: 6, wave });
      // Mid-run: plates standing, plates cracking, plates in the air.
      for (let n = 0; n < 600; n++) { inst.update(DT, skilled(inst, n)); inst.drainEvents(); }
      const before = snap(inst);
      inst.draw(stubPainter(), 0);
      inst.draw(stubPainter(), 0.5);
      inst.draw(stubPainter(), 0.99);
      expect(snap(inst), `wave ${wave}: draw() changed instance state`).toEqual(before);
    }
  });

  it('draw() survives the whole run, from the first frame to the last', () => {
    const inst = spawn({ seed: 11, wave: 53 });
    const g = stubPainter();
    expect(() => {
      inst.draw(g, 0);
      for (let n = 0; n < 1200; n++) {
        inst.update(DT, panicker(mulberry32(3))(inst, n));
        inst.drainEvents();
        inst.draw(g, (n % 60) / 60);
      }
    }).not.toThrow();
  });
});

describe('platforms — the definition', () => {
  it('publishes a steered cursor and its own abandon note', () => {
    expect(PLATFORMS_RITE.id).toBe('platforms');
    expect(PLATFORMS_RITE.duration).toBe(24);
    expect(PLATFORMS_RITE.theme).toBe('platforms');
    expect(PLATFORMS_RITE.cursor).toBe('default');
    expect(PLATFORMS_RITE.abandonNote).toBeTruthy();
    expect(TILES).toBe(COLS * 4);
  });
});
