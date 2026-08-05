import { describe, it, expect } from 'vitest';
import {
  GRID, CELL, SIM, ECONOMY, ELEMENT_PICK, PRIMAL, WAVES, COMBAT,
  QUALITY_PRESETS, QUALITY_ORDER, QUALITY_LABELS, LAYERS,
} from '../../src/core/Config.js';
import { PURE_TOWERS, DUAL_TOWERS, PRIMAL_TOWERS, FOUNDATION } from '../../src/game/TowerDefs.js';
import { ELEMENT_IDS } from '../../src/game/Elements.js';

/**
 * Config — the invariants that tie the constants together.
 *
 * FREEZE TEST. Config.js is dependency-free by design, which means nothing in it
 * can defend itself: every relation between two of its numbers, or between one
 * of its numbers and a table in another file, lives only in a comment. Those
 * relations are what this file makes executable.
 */

describe('Config — grid', () => {
  it('is a 26x20 board of 2.0-unit cells, 52x40 world units', () => {
    expect(GRID.cols).toBe(26);
    expect(GRID.rows).toBe(20);
    expect(GRID.cell).toBe(2.0);
    expect(GRID.width).toBe(52);
    expect(GRID.height).toBe(40);
  });

  it('keeps width/height as live getters derived from cols/rows', () => {
    // They are getters, not baked numbers: a resized board must not leave the
    // camera framing solving against a stale extent.
    const d = Object.getOwnPropertyDescriptor(GRID, 'width');
    expect(typeof d.get).toBe('function');
    expect(d.value).toBe(undefined);
  });

  it('has even dimensions, so 2x2 footprints tile the board exactly', () => {
    expect(GRID.cols % 2).toBe(0);
    expect(GRID.rows % 2).toBe(0);
  });

  it('leaves room for the two-wide, two-deep corridors at both ends', () => {
    // Grid.#carveCorridors writes rows 0,1 and rows-1,rows-2. Anything under
    // 4 rows would have those overlap.
    expect(GRID.rows).toBeGreaterThan(4);
    expect(GRID.cols).toBeGreaterThan(2);
  });
});

describe('Config — cell flags', () => {
  it('assigns four distinct small integers, FREE at 0', () => {
    expect(CELL).toEqual({ FREE: 0, TOWER: 1, BLOCKED: 2, PATH_ONLY: 3 });
    expect(new Set(Object.values(CELL)).size).toBe(4);
    // Grid stores these in a Uint8Array.
    for (const v of Object.values(CELL)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(256);
    }
    // FREE must be 0 so a zero-filled Uint8Array is an empty, buildable board.
    expect(CELL.FREE).toBe(0);
  });
});

describe('Config — simulation', () => {
  it('runs a fixed 60Hz step with a bounded catch-up', () => {
    expect(SIM.hz).toBe(60);
    expect(SIM.dt).toBeCloseTo(1 / 60, 12);
    expect(SIM.dt * SIM.hz).toBeCloseTo(1, 12);
    expect(SIM.maxSubSteps).toBe(5);
    // A frame drop can never be simulated for more than this much game time.
    expect(SIM.maxSubSteps * SIM.dt).toBeCloseTo(1 / 12, 12);
  });
});

describe('Config — primal stacks', () => {
  it('spends strictly fewer stacks than it requires', () => {
    // Consuming >= required would leave the element gone and every fusion that
    // used it silently unbuildable. The docblock on availableTowers depends on
    // exactly this inequality: "spending 2 of 3 leaves 1, so the element is
    // still held and every pairing survives".
    expect(PRIMAL.stacksRequired).toBe(3);
    expect(PRIMAL.stacksConsumed).toBe(2);
    expect(PRIMAL.stacksConsumed).toBeLessThan(PRIMAL.stacksRequired);
    expect(PRIMAL.stacksConsumed).toBeGreaterThan(0);
    expect(PRIMAL.stacksRequired - PRIMAL.stacksConsumed).toBeGreaterThanOrEqual(1);
    for (const v of Object.values(PRIMAL)) expect(Number.isInteger(v)).toBe(true);
  });

  it('is reachable inside the 11 element picks a run grants', () => {
    // 11 picks total; 3 of one element must be drawable before the picks run out.
    const totalPicks = 1 + ECONOMY.lastElementWave / ECONOMY.elementEveryWaves;
    expect(totalPicks).toBe(11);
    expect(PRIMAL.stacksRequired).toBeLessThanOrEqual(totalPicks);
    // And a second primal of the same element is affordable in stacks too:
    // 3 to unlock, 2 spent, so 3 + 2 = 5 picks of one element buys two.
    expect(PRIMAL.stacksRequired + PRIMAL.stacksConsumed).toBeLessThanOrEqual(totalPicks);
  });
});

describe('Config — economy', () => {
  it('pins the opening position', () => {
    expect(ECONOMY.startGold).toBe(275);
    expect(ECONOMY.startLives).toBe(50);
    expect(ECONOMY.maxLives).toBe(ECONOMY.startLives);   // Primal Dark cannot exceed the start
  });

  it('affords a sensible opening build', () => {
    // 275 buys four pure towers (240) with change, or one pure plus ten blocks.
    const pure = PURE_TOWERS.fire.levels[0].cost;
    expect(Math.floor(ECONOMY.startGold / pure)).toBe(4);
    // ...and NOT a fusion or a primal on wave 1.
    expect(ECONOMY.startGold).toBeLessThan(DUAL_TOWERS.vapor.levels[0].cost);
    expect(ECONOMY.startGold).toBeLessThan(PRIMAL_TOWERS.primal_fire.levels[0].cost);
  });

  it('keeps every rate a sane fraction', () => {
    for (const k of ['interestRate', 'sellRefund', 'armDiscount', 'morphCredit']) {
      expect(ECONOMY[k]).toBeGreaterThan(0);
      expect(ECONOMY[k]).toBeLessThanOrEqual(1);
    }
    expect(ECONOMY.interestRate).toBe(0.02);
    expect(ECONOMY.interestTick).toBe(15);
    expect(ECONOMY.interestCap).toBe(6000);
    expect(ECONOMY.sellRefund).toBe(0.75);
  });

  it('credits a morph at exactly the sell refund, so morph is never worse than sell-then-rebuild', () => {
    expect(ECONOMY.morphCredit).toBe(ECONOMY.sellRefund);
  });

  it('indexes morphDiscount by source level and covers the deepest upgrade ladder', () => {
    expect(ECONOMY.morphDiscount).toEqual([0.10, 0.20, 0.30]);
    const deepest = Math.max(
      ...Object.values(PURE_TOWERS).map((d) => d.levels.length),
      ...Object.values(DUAL_TOWERS).map((d) => d.levels.length),
    );
    expect(deepest).toBe(3);
    // One entry per reachable source level index (0..deepest-1). Game.morphCost
    // clamps beyond this, so a shortfall would silently saturate rather than
    // throw -- which is exactly why it is checked here.
    expect(ECONOMY.morphDiscount.length).toBe(deepest);
    for (let i = 1; i < ECONOMY.morphDiscount.length; i++) {
      expect(ECONOMY.morphDiscount[i]).toBeGreaterThan(ECONOMY.morphDiscount[i - 1]);
    }
  });

  it('caps the per-tile morph tax so the flip-flop exploit saturates at 3x', () => {
    expect(ECONOMY.morphTax).toBe(0.5);
    expect(ECONOMY.morphTaxCap).toBe(4);
    // The comment claims "tax saturates at 3.0x": 1 + 0.5 * 4.
    expect(1 + ECONOMY.morphTax * ECONOMY.morphTaxCap).toBe(3.0);
  });

  it('grants a pick on a wave that is inside the schedule', () => {
    expect(ECONOMY.elementEveryWaves).toBe(5);
    expect(ECONOMY.lastElementWave).toBe(50);
    expect(ECONOMY.lastElementWave % ECONOMY.elementEveryWaves).toBe(0);
  });
});

describe('Config — element picker', () => {
  it('offers three cards with at most one echo slot, opening from the second pick', () => {
    expect(ELEMENT_PICK).toEqual({ slots: 3, echoFromPick: 1, echoSlots: 1 });
    expect(ELEMENT_PICK.echoSlots).toBeLessThan(ELEMENT_PICK.slots);
    // Three cards must be drawable from six elements even with no echo.
    expect(ELEMENT_PICK.slots).toBeLessThanOrEqual(ELEMENT_IDS.length);
    // Echo opens after the free opening pick (index 0), not on it.
    expect(ELEMENT_PICK.echoFromPick).toBeGreaterThan(0);
  });
});

describe('Config — combat', () => {
  it('keeps the global crit a minority roll with a real payoff', () => {
    expect(COMBAT.critChance).toBe(0.18);
    expect(COMBAT.critMult).toBe(3.2);
    expect(COMBAT.critChance).toBeGreaterThan(0);
    expect(COMBAT.critChance).toBeLessThan(0.5);
    expect(COMBAT.critMult).toBeGreaterThan(1);
    // Expected multiplier on a direct hit, for anyone re-tuning the stat tables.
    const expected = 1 + COMBAT.critChance * (COMBAT.critMult - 1);
    expect(expected).toBeCloseTo(1.396, 3);
  });
});

describe('Config — wave pacing', () => {
  it('floors prep below its opening value and reaches the floor on a real wave', () => {
    expect(WAVES.prepFloor).toBeLessThan(WAVES.prepFirst);
    expect(WAVES.prepStep).toBeGreaterThan(0);
    const wavesToFloor = 1 + (WAVES.prepFirst - WAVES.prepFloor) / WAVES.prepStep;
    expect(wavesToFloor).toBe(7);
    expect(Number.isInteger(wavesToFloor)).toBe(true);   // no fractional last step
    expect(WAVES.bossPrepBonus).toBeGreaterThan(0);
  });

  it('does not put air waves on the boss cadence', () => {
    // airEvery must not divide 10, or every boss would also be an air wave and
    // the fixed cadence would be full of holes.
    expect(10 % WAVES.airEvery).not.toBe(0);
    expect(WAVES.airEvery).toBe(7);
  });
});

describe('Config — quality presets', () => {
  it('defines the five presets, and only `potato` carries extra knobs', () => {
    expect(Object.keys(QUALITY_PRESETS)).toEqual(['ultra', 'high', 'medium', 'low', 'potato']);
    const keys = Object.keys(QUALITY_PRESETS.ultra).sort();
    for (const [name, p] of Object.entries(QUALITY_PRESETS)) {
      if (name === 'potato') continue;
      expect(Object.keys(p).sort(), `preset ${name}`).toEqual(keys);
    }
    // `potato` is a superset: it answers every knob the others do, plus four of
    // its own. The four are opt-IN and absent everywhere else precisely so that
    // "absent means the normal path" stays true — RenderPipeline tests
    // `q.post === false`, not `!q.post`, for that reason.
    const potato = Object.keys(QUALITY_PRESETS.potato).sort();
    for (const k of keys) expect(potato, `potato is missing ${k}`).toContain(k);
    expect(potato.filter((k) => !keys.includes(k)).sort())
      .toEqual(['envDetail', 'extraLights', 'post', 'shadows']);
  });

  it('keeps the extra `potato` knobs off every other preset', () => {
    for (const [name, p] of Object.entries(QUALITY_PRESETS)) {
      if (name === 'potato') continue;
      for (const k of ['post', 'shadows', 'envDetail', 'extraLights']) {
        expect(p[k], `${name}.${k} must be absent, not false`).toBeUndefined();
      }
    }
  });

  it('degrades monotonically from ultra down to potato', () => {
    const order = ['ultra', 'high', 'medium', 'low', 'potato'];
    for (const knob of ['shadowMapSize', 'csmCascades', 'towerLights', 'particleBudget', 'anisotropy', 'pixelRatioCap']) {
      const vals = order.map((k) => QUALITY_PRESETS[k][knob]);
      for (let i = 1; i < vals.length; i++) {
        expect(vals[i], `${knob} at ${order[i]}`).toBeLessThanOrEqual(vals[i - 1]);
      }
    }
  });

  it('keeps godrays off everywhere, per the GodRaysPass note', () => {
    for (const p of Object.values(QUALITY_PRESETS)) {
      expect(p.godrays).toBe(false);
      expect(p.taa).toBe(false);
      expect(p.ssr).toBe(false);
    }
  });

  it('pins the tower-light budget — the single most expensive knob in the file', () => {
    expect(QUALITY_PRESETS.ultra.towerLights).toBe(4);
    expect(QUALITY_PRESETS.high.towerLights).toBe(3);
    expect(QUALITY_PRESETS.medium.towerLights).toBe(2);
    expect(QUALITY_PRESETS.low.towerLights).toBe(0);
  });

  it('leaves bloom on everywhere it renders through the composer', () => {
    for (const [name, p] of Object.entries(QUALITY_PRESETS)) {
      // `potato` has no composer to hang a bloom pass on — see its docblock and
      // the direct path in RenderPipeline.build. Asserting bloom there would be
      // asserting a pass that is never constructed.
      if (p.post === false) { expect(p.bloom, `${name}`).toBe(false); continue; }
      expect(p.bloom, `${name}`).toBe(true);
      expect(p.bloomThreshold, `${name}`).toBeGreaterThan(1);
      expect(p.bloomStrength, `${name}`).toBeGreaterThan(0);
    }
  });

  it('orders QUALITY_ORDER cheapest-first and covers every preset', () => {
    // The settings panel renders in this order and QualityGovernor steps along
    // it, so a preset missing here is a preset the player cannot reach.
    expect([...QUALITY_ORDER].sort()).toEqual(Object.keys(QUALITY_PRESETS).sort());
    expect(QUALITY_ORDER[0]).toBe('potato');
    expect(QUALITY_ORDER[QUALITY_ORDER.length - 1]).toBe('ultra');
    for (const q of QUALITY_ORDER) expect(QUALITY_LABELS[q], `label for ${q}`).toBeTruthy();
  });
});

describe('Config — render layers', () => {
  it('assigns distinct three.js layer indices in the legal 0..31 range', () => {
    const vals = Object.values(LAYERS);
    expect(new Set(vals).size).toBe(vals.length);
    for (const v of vals) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(32);
    }
    expect(LAYERS).toEqual({ DEFAULT: 0, BLOOM_ONLY: 1, NO_SHADOW: 2, ATMOSPHERE: 3 });
  });
});

describe('Config — cross-file cost invariants', () => {
  it('makes the foundation cheap enough to maze with from wave 1', () => {
    expect(FOUNDATION.levels[0].cost).toBeLessThan(PURE_TOWERS.fire.levels[0].cost);
    expect(FOUNDATION.levels[0].cost * 4).toBeLessThan(ECONOMY.startGold);
  });

  it('orders the three tiers by entry price: pure < fusion < primal', () => {
    expect(PURE_TOWERS.fire.levels[0].cost).toBeLessThan(DUAL_TOWERS.vapor.levels[0].cost);
    expect(DUAL_TOWERS.vapor.levels[0].cost).toBeLessThan(PRIMAL_TOWERS.primal_fire.levels[0].cost);
  });

  it('never lets a sell refund exceed what was paid', () => {
    for (const d of [PURE_TOWERS.fire, DUAL_TOWERS.vapor, PRIMAL_TOWERS.primal_fire, FOUNDATION]) {
      let spent = 0;
      for (const l of d.levels) {
        spent += l.cost;
        expect(Math.round(spent * ECONOMY.sellRefund)).toBeLessThan(spent);
      }
    }
  });
});
