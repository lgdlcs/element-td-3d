/**
 * `heaven`: "escape from gay heaven". Dodge everything pink.
 *
 * The shared checklist (`assertRiteContract`) proves this is a legal rite. What
 * follows is what THIS rite promises:
 *
 *   - the score is STRIKES DODGED OUT OF STRIKES PRESENTED, the denominator is
 *     fixed at init, and a strike that touches the mote is lost for good;
 *   - every strike is aimed at the mote, so standing still loses all of them,
 *     on every wave, and the layout is the same RELATIVE TO THE MOTE;
 *   - the worst move any strike can demand stays inside `SPEED_BUDGET` of the
 *     mote's top speed, and a competent player clears most of the course at
 *     every wave;
 *   - the two control paths have the same top speed;
 *   - pink is the only saturated magenta on the stage.
 *
 * The calibration curve lives in `calibration.test.js`, against the shared
 * reference player. `SKILLED` below is that player's brain at zero degradation.
 */

import { describe, it, expect } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { FIELD, makeInput } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { assertRiteContract } from './helpers/rite-contract.js';
import { heavenBestXY } from './helpers/reference-player.js';
import {
  HEAVEN_RITE, RAND_CALLS, DURATION, HAZARDS, MOVE_SPEED, MOTE_R, START_X, START_Y,
  HEART, BEAM, RING, RING_BAND, RING_SWING, SPEED_BUDGET,
} from '../../src/minigames/rites/HeavenRite.js';

const DT = MINIGAMES.dt;

function spawn({ seed = 1, occurrence = 0, wave = 8 } = {}) {
  const inst = HEAVEN_RITE.create();
  inst.init({
    rand: riteRng(seed, HEAVEN_RITE.id, occurrence),
    wave, occurrence, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

function play(strategy, o = {}) {
  const inst = spawn(o);
  const cap = Math.ceil(DURATION / DT) + 1;
  let steps = 0;
  for (; steps < cap; steps++) {
    if (inst.update(DT, strategy(inst, steps)) === true) { steps++; break; }
    inst.drainEvents();
  }
  return { inst, steps, score: inst.score() };
}

/** The pointer path: aim the cursor where the brain wants to be. */
const SKILLED = (inst) => {
  const p = heavenBestXY(inst);
  return makeInput({ inside: true, x: p.x, y: p.y });
};

/** The same brain on the 8-way keyboard: hold the arrow nearest the wanted direction. */
const SKILLED_KEYS = (inst) => {
  const p = heavenBestXY(inst);
  const dx = p.x - inst.mx;
  const dy = p.y - inst.my;
  const d = Math.hypot(dx, dy);
  if (d < 0.08) return makeInput();
  return makeInput({
    axis: { x: Math.abs(dx) > d * 0.38 ? Math.sign(dx) : 0, y: Math.abs(dy) > d * 0.38 ? Math.sign(dy) : 0 },
  });
};

function hsl(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  return { h, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

function luminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(((n >> 16) & 255) / 255)
    + 0.7152 * lin(((n >> 8) & 255) / 255)
    + 0.0722 * lin((n & 255) / 255);
}

const WAVES = [3, 8, 18, 28, 38, 48, 53];
const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31];

describe('heaven rite', () => {
  it('honours the whole rite contract', () => {
    assertRiteContract(HEAVEN_RITE, { randCalls: RAND_CALLS, skilled: SKILLED });
  });

  it('spends exactly HAZARDS * 4 + 1 seeded values', () => {
    expect(RAND_CALLS).toBe(121);
    expect(RAND_CALLS).toBe(HAZARDS * 4 + 1);
  });

  it('is a 3D rite: a view and no 2D draw', () => {
    expect(typeof HEAVEN_RITE.view).toBe('function');
    expect(spawn().draw).toBeUndefined();
  });

  // ---- the score model ----------------------------------------------------

  it('scores strikes dodged out of strikes presented, with a denominator fixed at init', () => {
    const inst = spawn({ seed: 7, wave: 28 });
    const presented = inst.presented;
    expect(presented).toBeGreaterThan(8);
    for (let n = 0; n < 1201; n++) {
      const end = inst.update(DT, SKILLED(inst));
      inst.drainEvents();
      expect(inst.presented, 'the denominator moved during play').toBe(presented);
      if (end === true) break;
    }
    const s = inst.score();
    expect(s.ratio).toBeCloseTo(Math.min(1, inst.cleared / presented), 12);
    expect(s.detail).toBe(`${inst.cleared}/${presented} strikes dodged`);
  });

  it('a strike that touched the mote is never credited', () => {
    const inst = spawn({ seed: 3, wave: 20 });
    for (let n = 0; n < 1201; n++) {
      if (inst.update(DT, SKILLED(inst)) === true) break;
      inst.drainEvents();
    }
    let clean = 0;
    for (let i = 0; i < HAZARDS; i++) {
      if (inst.passed[i] && !inst.touched[i] && inst.inCourse[i]) clean++;
    }
    expect(inst.cleared).toBe(clean);
  });

  it('the run always lasts its full clock', () => {
    for (const wave of [3, 28, 53]) {
      const { inst, steps } = play(() => makeInput(), { seed: 5, wave });
      expect(steps, `wave ${wave} ended early`).toBeGreaterThan(Math.floor(DURATION / DT) - 2);
      expect(inst.t).toBeGreaterThanOrEqual(DURATION);
    }
  });

  // ---- the course ---------------------------------------------------------

  it('opens on hearts, and every three strikes is one of each kind', () => {
    for (const wave of [3, 28, 53]) {
      for (const seed of SEEDS) {
        const { hazards } = spawn({ seed, wave });
        expect(hazards[0].kind, `wave ${wave} seed ${seed}`).toBe(HEART);
        for (let i = 0; i + 2 < HAZARDS; i += 3) {
          const triple = [hazards[i].kind, hazards[i + 1].kind, hazards[i + 2].kind].sort();
          expect(triple, `wave ${wave} seed ${seed} triple at ${i}`).toEqual([HEART, BEAM, RING]);
        }
      }
    }
  });

  it('the course outlasts the clock on the hardest wave', () => {
    // The wave compresses the schedule and never adds strikes, so the last
    // strike must still be waiting when the clock runs out.
    for (const seed of SEEDS) {
      const { hazards } = spawn({ seed, wave: 53 });
      expect(hazards[HAZARDS - 1].t0, `seed ${seed}`).toBeGreaterThan(DURATION);
    }
  });

  it('a mote that never moves is touched by every strike in the course, on every wave', () => {
    for (let wave = 3; wave <= 53; wave += 5) {
      for (const seed of [31, 4]) {
        const { inst, score } = play(() => makeInput(), { seed, wave });
        for (let i = 0; i < HAZARDS; i++) {
          if (inst.inCourse[i]) expect(inst.touched[i], `wave ${wave} seed ${seed} strike ${i}`).toBe(1);
        }
        expect(score.ratio).toBe(0);
        expect(score.headline).toBe('Never left');
      }
    }
  });

  it('a strike is laid out around wherever the mote is when it appears', () => {
    // Same seed, two different starting spots: the first heart lands on the
    // mote both times, and the ring of hearts has the same shape around it.
    const still = spawn({ seed: 12, wave: 18 });
    const moved = spawn({ seed: 12, wave: 18 });
    for (let n = 0; n < 70; n++) {
      still.update(DT, makeInput());
      moved.update(DT, makeInput({ axis: { x: n < 40 ? 1 : 0, y: 0 } }));
    }
    const a = still.hazards[0];
    const b = moved.hazards[0];
    expect(a.aimed && b.aimed).toBeTruthy();
    expect(b.ax - a.ax).toBeGreaterThan(1);
    expect(a.hx[0]).toBe(a.ax);
    expect(b.hx[0]).toBe(b.ax);
    for (let k = 1; k < 6; k++) {
      expect(b.hx[k] - b.ax).toBeCloseTo(a.hx[k] - a.ax, 9);
      expect(b.hy[k] - b.ay).toBeCloseTo(a.hy[k] - a.ay, 9);
    }
  });

  it('the worst move any strike can demand stays inside the speed budget', () => {
    // HEART: out of the centre heart through the empty slot.
    // BEAM: from the mote into the far side of the gap, fired from the edge
    //   the mote stands on, so the wall's travel buys nothing.
    // RING: across to the wedge, at the nearest and furthest the source sits,
    //   with the ring's travel to the mote counted.
    const budget = MOVE_SPEED * SPEED_BUDGET + 1e-9;
    for (const wave of WAVES) {
      const P = spawn({ wave }).params;
      const heart = (P.heartR + MOTE_R) / P.warn[HEART];
      const beam = (P.beamReach + MOTE_R) / P.warn[BEAM];
      expect(heart, `wave ${wave}: hearts demand ${heart.toFixed(2)} u/s`).toBeLessThanOrEqual(budget);
      expect(beam, `wave ${wave}: beams demand ${beam.toFixed(2)} u/s`).toBeLessThanOrEqual(budget);
      for (const d of [2.5, 5.5]) {
        const lateral = d * Math.sin(RING_SWING) + MOTE_R;
        const time = P.warn[RING] + (d - RING_BAND - MOTE_R) / P.ringSpeed;
        expect(lateral / time, `wave ${wave}: a ring at ${d} u demands ${(lateral / time).toFixed(2)} u/s`)
          .toBeLessThanOrEqual(budget);
      }
    }
  });

  it('a competent player clears most of the course, at the easiest wave and the hardest', () => {
    for (const wave of [3, 28, 53]) {
      const runs = SEEDS.map((seed) => play(SKILLED, { seed, wave }));
      const mean = runs.reduce((a, r) => a + r.score.ratio, 0) / runs.length;
      expect(mean, `wave ${wave} mean ${mean.toFixed(3)}: `
        + runs.map((r, i) => `${SEEDS[i]}=${r.score.ratio.toFixed(2)}`).join(' '))
        .toBeGreaterThan(0.8);
      for (const r of runs.filter((x) => x.score.ratio >= 1)) {
        expect(r.score.ratio).toBe(1);
        expect(r.score.headline).toBe('Escaped');
        expect(r.inst.burned).toBe(0);
      }
    }
    const flawless = SEEDS.map((seed) => play(SKILLED, { seed, wave: 3 })).filter((r) => r.score.ratio === 1);
    expect(flawless.length, 'a competent player never cleared a wave 3 course outright').toBeGreaterThanOrEqual(3);
  });

  it('the wave makes a lagging player score less', () => {
    const laggy = (lag) => {
      const ring = [];
      return (inst) => {
        ring.push(heavenBestXY(inst));
        const p = ring.length > lag ? ring.shift() : ring[0];
        return makeInput({ inside: true, x: p.x, y: p.y });
      };
    };
    const seeds = [1, 2, 3, 5, 7, 11];
    const mean = (wave) => seeds
      .map((seed) => play(laggy(15), { seed, wave }).score.ratio)
      .reduce((a, b) => a + b, 0) / seeds.length;
    const early = mean(3);
    const late = mean(53);
    expect(early, `wave 3 mean ${early.toFixed(2)}`).toBeGreaterThan(0.75);
    expect(late, `wave 53 mean ${late.toFixed(2)}`).toBeLessThan(early - 0.1);
    expect(late, `wave 53 mean ${late.toFixed(2)}`).toBeGreaterThan(0.25);
  });

  it('occurrence deals a different course on the same seed', () => {
    const a = spawn({ seed: 4242, wave: 30, occurrence: 0 }).hazards.map((h) => `${h.kind}:${h.r1.toFixed(4)}`).join();
    const b = spawn({ seed: 4242, wave: 30, occurrence: 1 }).hazards.map((h) => `${h.kind}:${h.r1.toFixed(4)}`).join();
    expect(a).not.toBe(b);
  });

  it('different seeds lay out different courses', () => {
    const a = spawn({ seed: 1, wave: 20 }).hazards.map((h) => `${h.kind}:${h.r2.toFixed(4)}`).join();
    const b = spawn({ seed: 2, wave: 20 }).hazards.map((h) => `${h.kind}:${h.r2.toFixed(4)}`).join();
    expect(a).not.toBe(b);
  });

  it('emits its cues: the go signal, a pickup per dodge, a break per touch', () => {
    const inst = spawn({ seed: 1, wave: 28 });
    const seen = [];
    for (let n = 0; n < 1201; n++) {
      const end = inst.update(DT, SKILLED(inst));
      for (const e of inst.drainEvents()) {
        seen.push(e.type);
        if (e.type === 'gold' || e.type === 'break') {
          expect(Number.isInteger(e.i), `${e.type} names its strike`).toBe(true);
          expect(Number.isFinite(e.x) && Number.isFinite(e.y)).toBe(true);
        }
      }
      if (end === true) break;
    }
    expect(seen[0]).toBe('start');
    expect(seen.filter((t) => t === 'gold')).toHaveLength(inst.cleared);
    expect(seen.filter((t) => t === 'break')).toHaveLength(inst.burned);
    expect(seen.at(-1)).toBe(inst.burned === 0 ? 'perfect' : 'good');
    expect(seen.filter((t) => t === 'tick').length).toBeGreaterThan(0);
  });

  // ---- the controls -------------------------------------------------------

  it('the keyboard path is playable, not a courtesy', () => {
    const seeds = [1, 2, 3, 5, 7, 11];
    const avg = (s) => seeds.map((seed) => play(s, { seed, wave: 18 }).score.ratio)
      .reduce((a, b) => a + b, 0) / seeds.length;
    const keys = avg(SKILLED_KEYS);
    const mouse = avg(SKILLED);
    expect(keys, `keyboard mean ${keys.toFixed(2)} vs pointer ${mouse.toFixed(2)}`)
      .toBeGreaterThan(mouse - 0.2);
  });

  it('the two control paths have the same top speed, and a diagonal is not faster', () => {
    const a = spawn({ wave: 3 });
    const b = spawn({ wave: 3 });
    for (let n = 0; n < 30; n++) {
      a.update(DT, makeInput({ axis: { x: 0, y: 1 } }));
      b.update(DT, makeInput({ inside: true, x: b.mx, y: FIELD.hh }));
    }
    expect(a.my).toBeCloseTo(b.my, 6);
    expect(a.my - START_Y).toBeCloseTo(30 * DT * MOVE_SPEED, 6);
    const c = spawn({ wave: 3 });
    for (let n = 0; n < 30; n++) c.update(DT, makeInput({ axis: { x: 1, y: 1 } }));
    expect(Math.hypot(c.mx - START_X, c.my - START_Y)).toBeCloseTo(30 * DT * MOVE_SPEED, 6);
  });

  it('a pointer outside the field leaves the mote where it is', () => {
    const inst = spawn({ wave: 3 });
    for (let n = 0; n < 20; n++) inst.update(DT, makeInput({ inside: false, x: 7, y: 4 }));
    expect(inst.mx).toBe(START_X);
    expect(inst.my).toBe(START_Y);
  });

  // ---- the picture --------------------------------------------------------

  it('pink is the only saturated magenta on the stage, and the brightest thing on it', () => {
    const p = spawn()._palette;
    const pink = hsl(p.pink);
    expect(pink.h).toBeGreaterThan(290);
    expect(pink.h).toBeLessThan(330);
    expect(pink.s).toBeGreaterThan(0.9);
    for (const key of ['outline', 'cloud', 'cloud2', 'cloud3', 'accent', 'gold', 'good']) {
      const c = hsl(p[key]);
      const apart = Math.min(Math.abs(c.h - pink.h), 360 - Math.abs(c.h - pink.h));
      expect(c.s < 0.35 || apart > 70, `${key} (${p[key]}) sits ${apart.toFixed(0)}deg from pink at s=${c.s.toFixed(2)}`)
        .toBe(true);
    }
    const deep = hsl(p.pinkDeep);
    expect(Math.min(Math.abs(deep.h - pink.h), 360 - Math.abs(deep.h - pink.h))).toBeLessThan(20);
    expect(luminance(p.pink) / Math.max(1e-4, luminance(p.outline))).toBeGreaterThan(20);
  });
});
