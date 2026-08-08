/**
 * A TEST FOR THE TEST HARNESS.
 *
 * `tests/unit/helpers/rite-contract.js` is about to be the only thing standing
 * between six independently written minigames and six different ideas of what a
 * rite owes the host. A shared checklist that silently passes everything is
 * worse than no checklist: it converts "nobody checked" into "it was checked",
 * and the second is much harder to notice.
 *
 * So this file does two things, both against a SYNTHETIC rite defined here
 * rather than against a real one. Synthetic on purpose: the real rites are
 * replaced in the next commit, and a harness whose only proof of life leaves
 * with them is a harness nobody can trust afterwards.
 *
 *   1. A compliant rite passes the whole list.
 *   2. Each rule REJECTS a rite that breaks it. That is docs/TESTING.md §4 —
 *      prove the instrument can fail — applied to the instrument itself.
 */

import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../../src/core/Rng.js';
import { makeInput, clickAt } from '../../src/minigames/contract.js';
import { assertRiteContract } from './helpers/rite-contract.js';

/** Targets in the synthetic rite. A module constant, as the contract demands. */
const TARGETS = 6;
/** Shots. THE anti-mashing rule: without a limit, spraying the field is optimal. */
const AMMO = 10;
/** How close a shot has to land, in world units. */
const HIT_R = 0.9;
/** Seconds between targets. */
const SPACING = 2.4;

/**
 * The reference rite, in miniature: aim, shoot, score.
 *
 * Written to be exactly compliant and nothing more — a fixed rand budget of
 * TARGETS + 1, no randomness after init, an idle run that ends on its own and
 * scores zero, a pure score(), a drained event queue. Each `broken*` case below
 * is this class with one property removed.
 */
class Synthetic {
  init(ctx) {
    this.t = 0;
    this.hits = 0;
    this.ammo = AMMO;
    this.events = [];
    this.xs = [];
    for (let i = 0; i < TARGETS; i++) this.xs.push((ctx.rand() * 2 - 1) * 7);
    this._fx = mulberry32(Math.floor(ctx.rand() * 0xffffffff) >>> 0);
  }

  /** Index of the target that is up right now, or -1 between targets. */
  live() {
    const i = Math.floor(this.t / SPACING);
    return i >= 0 && i < TARGETS ? i : -1;
  }

  update(dt, input) {
    this.t += dt;
    const i = this.live();
    for (const c of input.clicks) {
      if (this.ammo <= 0) break;
      this.ammo--;
      if (i >= 0 && Math.abs(c.x - this.xs[i]) <= HIT_R) {
        this.hits++;
        this.events.push({ type: 'good', x: c.x });
      } else {
        this.events.push({ type: 'miss', x: c.x });
      }
    }
    return this.t >= TARGETS * SPACING;
  }

  draw() {}

  score() {
    const ratio = this.hits / TARGETS;
    return { ratio, headline: ratio > 0.8 ? 'Clean' : 'Ragged', detail: `${this.hits}/${TARGETS}` };
  }

  drainEvents() { return this.events.splice(0, this.events.length); }
}

const SYNTH = {
  id: 'synthetic', name: 'Synthetic', hint: 'Shoot the mark.',
  duration: TARGETS * SPACING + 1,
  create: () => new Synthetic(),
};

/** A player who shoots the live target, once each, on the frame it appears. */
const SKILLED = (inst) => {
  const i = inst.live();
  const fresh = i >= 0 && i !== inst._lastSeen;
  if (!fresh) return makeInput();
  inst._lastSeen = i;
  return makeInput({ action: 1, clicks: [clickAt(inst.xs[i], 0, 0, 'pointer')] });
};

/** Build a variant of SYNTH with one method replaced. */
function variant(patch) {
  return { ...SYNTH, create: () => Object.assign(new Synthetic(), patch) };
}

// ===========================================================================
describe('assertRiteContract', () => {
  it('passes a rite that honours the whole contract', () => {
    assertRiteContract(SYNTH, { randCalls: TARGETS + 1, skilled: SKILLED });
  });

  it('rejects a rand budget that depends on the wave', () => {
    // The classic determinism break: a loop bounded by difficulty rather than
    // by a module constant. Two clients on one seed then draw a different NUMBER
    // of values and disagree about everything drawn afterwards.
    const bad = {
      ...SYNTH,
      create: () => {
        const inst = new Synthetic();
        const init = inst.init.bind(inst);
        inst.init = (ctx) => { init(ctx); for (let i = 0; i < ctx.wave; i++) ctx.rand(); };
        return inst;
      },
    };
    expect(() => assertRiteContract(bad, { randCalls: TARGETS + 1 }))
      .toThrow(/fixed rand budget/);
  });

  it('rejects a rite that consults Math.random', () => {
    const bad = variant({
      update(dt) { this.t += dt; this.hits += Math.random() < 0.5 ? 1 : 0; return this.t >= 4; },
    });
    expect(() => assertRiteContract(bad, { randCalls: TARGETS + 1 })).toThrow(/determinism/);
  });

  it('rejects a rite that pays for doing nothing', () => {
    const bad = variant({ score() { return { ratio: 0.4, headline: 'Free', detail: '' }; } });
    expect(() => assertRiteContract(bad, { randCalls: TARGETS + 1 }))
      .toThrow(/an idle run scores nothing/);
  });

  it('rejects a rite that mashing wins', () => {
    // The ammo limit removed, and nothing else. Spraying the field then beats
    // aiming, which is the exact failure the limit exists to prevent — and the
    // exact failure that is invisible to a human tester who plays properly.
    const bad = variant({
      update(dt, input) {
        this.t += dt;
        const i = this.live();
        for (const c of input.clicks) {
          if (i >= 0 && Math.abs(c.x - this.xs[i]) <= HIT_R * 6) this.hits++;
        }
        return this.t >= TARGETS * SPACING;
      },
      score() {
        const ratio = Math.min(1, this.hits / TARGETS);
        return { ratio, headline: 'x', detail: '' };
      },
    });
    expect(() => assertRiteContract(bad, { randCalls: TARGETS + 1 }))
      .toThrow(/mashing is not a strategy/);
  });

  it('rejects a score() that moves the game on', () => {
    const bad = variant({
      score() { this.hits++; return { ratio: 0, headline: 'x', detail: '' }; },
    });
    expect(() => assertRiteContract(bad, { randCalls: TARGETS + 1 }))
      .toThrow(/score\(\) is pure/);
  });

  it('rejects a queue that grows without limit', () => {
    const bad = variant({
      update(dt) { this.t += dt; for (let i = 0; i < 20; i++) this.xs.push(i); return this.t >= 14.4; },
      drainEvents() { return []; },
    });
    expect(() => assertRiteContract(bad, { randCalls: TARGETS + 1 }))
      .toThrow(/no unbounded growth/);
  });

  it('rejects a drainEvents that hands back the same events twice', () => {
    const bad = variant({ drainEvents() { return this.events; } });
    expect(() => assertRiteContract(bad, { randCalls: TARGETS + 1 }))
      .toThrow(/drainEvents empties/);
  });

  it('rejects a rite that goes non-finite under fuzz', () => {
    const bad = variant({
      update(dt, input) { this.t += dt; this.hits += input.axis.x / 0 || 0; return this.t >= 14.4; },
      score() { return { ratio: this.t > 5 ? NaN : 0, headline: 'x', detail: '' }; },
    });
    expect(() => assertRiteContract(bad, { randCalls: TARGETS + 1 })).toThrow(/finite number/);
  });

  it('insists the author writes the budget down', () => {
    expect(() => assertRiteContract(SYNTH, {})).toThrow(/explicit randCalls/);
  });
});
