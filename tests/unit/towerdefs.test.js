import { describe, it, expect } from 'vitest';
import {
  PURE_TOWERS, DUAL_TOWERS, PRIMAL_TOWERS, FOUNDATION, ALL_TOWERS,
  towerDef, availableTowers, morphTargets,
} from '../../src/game/TowerDefs.js';
import { ELEMENT_IDS, DUALS, PRIMALS, LEGACY_DUAL_IDS } from '../../src/game/Elements.js';
import { PRIMAL, ECONOMY } from '../../src/core/Config.js';

/**
 * TowerDefs — the stat tables and the availability rules.
 *
 * FREEZE TEST. Two things here are load-bearing beyond their size:
 *
 *  1. `availableTowers` reads COUNTS, not presence, for the primal branch. Its
 *     docblock warns that passing a Set silently disables primals forever. That
 *     is asserted directly below rather than merely commented.
 *  2. The FOUNDATION price is documented as cost-neutral-or-better against
 *     building outright. That is an arithmetic relation between three constants
 *     in two files, so it is checked, not trusted.
 */

const ARMED = Object.entries(ALL_TOWERS).filter(([, d]) => d.kind !== 'inert');

describe('TowerDefs — table shape', () => {
  it('holds 6 pures, 15 duals, 6 primals and the foundation', () => {
    expect(Object.keys(PURE_TOWERS)).toEqual(ELEMENT_IDS);
    expect(Object.keys(DUAL_TOWERS).length).toBe(15);
    expect(Object.keys(PRIMAL_TOWERS).length).toBe(6);
    expect(Object.keys(ALL_TOWERS).length).toBe(6 + 15 + 6 + 1);
    expect(ALL_TOWERS.foundation).toBe(FOUNDATION);
  });

  it('makes every entry self-identifying: ALL_TOWERS[k].key === k', () => {
    for (const [k, d] of Object.entries(ALL_TOWERS)) expect(d.key).toBe(k);
  });

  it('gives each family its documented level count', () => {
    // Primals went 2 -> 3 in the apex round. Pure/dual/foundation did NOT, and
    // saying so here is half the value of this test: `def.levels.length` is
    // read generically all over Game, Inspector and BuildBar, so a tier added to
    // the wrong table is absorbed silently everywhere and shows up as a price.
    for (const d of Object.values(PURE_TOWERS)) expect(d.levels.length).toBe(3);
    for (const d of Object.values(DUAL_TOWERS)) expect(d.levels.length).toBe(2);
    for (const d of Object.values(PRIMAL_TOWERS)) expect(d.levels.length).toBe(3);
    expect(FOUNDATION.levels.length).toBe(1);
  });

  it('uses exactly four kinds, and only the foundation is inert', () => {
    const kinds = new Set(Object.values(ALL_TOWERS).map((d) => d.kind));
    expect([...kinds].sort()).toEqual(['dual', 'inert', 'primal', 'pure']);
    expect(Object.values(ALL_TOWERS).filter((d) => d.kind === 'inert')).toEqual([FOUNDATION]);
  });

  it('carries the element identity through to pure and primal towers', () => {
    expect(ELEMENT_IDS.map((id) => PURE_TOWERS[id].name)).toEqual([
      'Fire Tower', 'Water Tower', 'Nature Tower',
      'Earth Tower', 'Light Tower', 'Darkness Tower',
    ]);
    for (const id of ELEMENT_IDS) {
      expect(PURE_TOWERS[id].element).toBe(id);
      const p = PRIMAL_TOWERS[PRIMALS[id].id];
      expect(p.element).toBe(id);
      expect(p.kind).toBe('primal');
    }
    // The foundation belongs to no element — Game.convertTower keys off this.
    expect(FOUNDATION.element).toBe(null);
  });

  it('derives dual towers from the DUALS table, keeping the pair on the def', () => {
    for (const [key, d] of Object.entries(DUALS)) {
      const t = DUAL_TOWERS[d.id];
      expect(t.pair).toBe(key);
      expect(t.parts).toEqual(key.split('+'));
      expect(t.name).toBe(`${d.name} Tower`);
      expect(t.color).toBe(d.color);
    }
  });
});

describe('TowerDefs — level tables', () => {
  it('has strictly increasing costs within every table', () => {
    for (const [k, d] of Object.entries(ALL_TOWERS)) {
      const costs = d.levels.map((l) => l.cost);
      for (let i = 1; i < costs.length; i++) {
        expect(costs[i], `${k} level ${i}`).toBeGreaterThan(costs[i - 1]);
      }
      expect(costs[0]).toBeGreaterThan(0);
    }
  });

  it('has strictly increasing damage and non-increasing cooldown as it upgrades', () => {
    for (const [k, d] of ARMED) {
      for (let i = 1; i < d.levels.length; i++) {
        expect(d.levels[i].damage, `${k} damage L${i}`).toBeGreaterThan(d.levels[i - 1].damage);
        expect(d.levels[i].cooldown, `${k} cooldown L${i}`).toBeLessThanOrEqual(d.levels[i - 1].cooldown);
        expect(d.levels[i].range, `${k} range L${i}`).toBeGreaterThan(d.levels[i - 1].range);
      }
    }
  });

  it('gives every armed tower non-zero damage, cooldown, range and projectile speed', () => {
    for (const [k, d] of ARMED) {
      for (const [i, l] of d.levels.entries()) {
        expect(l.damage, `${k} L${i} damage`).toBeGreaterThan(0);
        expect(l.cooldown, `${k} L${i} cooldown`).toBeGreaterThan(0);
        expect(l.range, `${k} L${i} range`).toBeGreaterThan(0);
        expect(l.speed, `${k} L${i} speed`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the foundation inert: no damage, no cooldown, no range', () => {
    const l = FOUNDATION.levels[0];
    expect([l.damage, l.cooldown, l.range, l.speed]).toEqual([0, 0, 0, 0]);
    expect(l.cost).toBe(20);
  });

  it('pins the price ladder: pure 60/140/320, fusion 450/1100, primal 900/2200/3100', () => {
    for (const d of Object.values(PURE_TOWERS)) expect(d.levels.map((l) => l.cost)).toEqual([60, 140, 320]);
    for (const d of Object.values(DUAL_TOWERS)) expect(d.levels.map((l) => l.cost)).toEqual([450, 1100]);
    for (const d of Object.values(PRIMAL_TOWERS)) expect(d.levels.map((l) => l.cost)).toEqual([900, 2200, 3100]);
  });

  it('costs a fully-forged primal exactly four times a fully-forged fusion', () => {
    // The mental model the PRIMAL_STATS docblock ships, updated with the third
    // tier: 900 + 2200 + 3100 = 6200 = 4 x 1550. It was 2x while a primal
    // stopped at two levels.
    const cum = (d) => d.levels.reduce((s, l) => s + l.cost, 0);
    expect(cum(PRIMAL_TOWERS.primal_fire)).toBe(6200);
    expect(cum(DUAL_TOWERS.vapor)).toBe(1550);
    expect(cum(PRIMAL_TOWERS.primal_fire)).toBe(4 * cum(DUAL_TOWERS.vapor));
    // ...and the third step alone costs what the whole tower used to.
    expect(PRIMAL_TOWERS.primal_fire.levels[2].cost).toBe(3100);
    expect(cum(PURE_TOWERS.fire)).toBe(520);
  });

  it('keeps the documented 2.2x primal-over-fusion direct DPS ratio', () => {
    // The balance statement in TowerDefs.js quotes 2.25x at L0, 2.19x at L1 and
    // 4.35x for the new L2 against a fully-forged fusion (there is no fusion L2
    // to compare against — that asymmetry IS the tier).
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const dps = (defs, lv) => mean(defs.map((d) => d.levels[lv].damage / d.levels[lv].cooldown));
    const primals = Object.values(PRIMAL_TOWERS);
    const fusions = Object.values(DUAL_TOWERS);
    expect(dps(primals, 0) / dps(fusions, 0)).toBeCloseTo(2.25, 2);
    expect(dps(primals, 1) / dps(fusions, 1)).toBeCloseTo(2.19, 2);
    expect(dps(primals, 2) / dps(fusions, 1)).toBeCloseTo(4.35, 2);

    // Gold efficiency at each family's TOP level: only ~1.1x, which is the whole
    // point of the design. NOTE the `levels.length - 1`: this used to be a hard
    // `levels[1]`, which silently became "the middle tier's DPS over the WHOLE
    // three-tier cost" the moment a level was added, and reported 0.55.
    const top = (d) => d.levels[d.levels.length - 1];
    const eff = (defs) => mean(defs.map((d) => (top(d).damage / top(d).cooldown)
      / d.levels.reduce((s, l) => s + l.cost, 0)));
    expect(eff(primals) / eff(fusions)).toBeGreaterThan(1.0);
    expect(eff(primals) / eff(fusions)).toBeLessThan(1.2);
    expect(eff(primals) / eff(fusions)).toBeCloseTo(1.09, 2);
  });

  it('spreads the six primals within +/-8% of each other on direct DPS', () => {
    // OBSERVED, and it disagrees with the docblock: TowerDefs.js says "+/-4% on
    // direct DPS", but at L0 the real spread is -7.9%..+6.6% (Maelstrom is the
    // low end, Tectonic the high end). L1 does sit inside +/-4.3%. Frozen as
    // measured; the comment is what is wrong, not the numbers.
    const dpsOf = (lv) => Object.values(PRIMAL_TOWERS).map((d) => d.levels[lv].damage / d.levels[lv].cooldown);
    for (const lv of [0, 1]) {
      const a = dpsOf(lv);
      const m = a.reduce((s, x) => s + x, 0) / a.length;
      for (const x of a) expect(Math.abs(x / m - 1)).toBeLessThan(0.08);
    }
    // Pin the outliers so a re-tune has to acknowledge them.
    const l0 = (k) => PRIMAL_TOWERS[k].levels[0].damage / PRIMAL_TOWERS[k].levels[0].cooldown;
    expect(l0('primal_water')).toBeCloseTo(345.45, 1);
    expect(l0('primal_earth')).toBeCloseTo(400.0, 1);
  });

  it('gives Judgement the longest range on the board and nothing else exceeds 14.5', () => {
    const maxRange = (d) => Math.max(...d.levels.map((l) => l.range));
    // 19.0 at the new top tier; it was 17.5 when a primal stopped at two levels.
    expect(maxRange(PRIMAL_TOWERS.primal_light)).toBe(19.0);
    for (const [k, d] of ARMED) {
      if (k === 'primal_light') continue;
      expect(maxRange(d), `${k} out-ranges Judgement`).toBeLessThanOrEqual(14.5);
    }
  });
});

/**
 * THE THIRD PRIMAL TIER.
 *
 * A separate block from the level tables above because the claims are different
 * in kind: those freeze the shape of every table, these are the balance
 * statement the PRIMAL_STATS docblock makes, executed. That docblock says
 * outright that "a number in a comment is a rumour until it is derived from the
 * array under it" — this is where it stops being a rumour.
 *
 * The sign on the gold-efficiency step is the one nobody would guess and the
 * one the whole tier rests on, so it gets its own test.
 */
describe('TowerDefs — the third primal tier', () => {
  const primals = Object.entries(PRIMAL_TOWERS);
  const dps = (l) => l.damage / l.cooldown;
  const cumTo = (d, lv) => d.levels.slice(0, lv + 1).reduce((s, l) => s + l.cost, 0);

  it('gives all six exactly three levels', () => {
    expect(primals.length).toBe(6);
    for (const [k, d] of primals) expect(d.levels.length, `${k}`).toBe(3);
    // Named individually so "all six" cannot pass on an empty table.
    for (const el of ELEMENT_IDS) expect(PRIMAL_TOWERS[`primal_${el}`].levels.length).toBe(3);
  });

  it('raises cost, damage, range and DPS at every step, and never the cooldown', () => {
    for (const [k, d] of primals) {
      for (let i = 1; i < 3; i++) {
        expect(d.levels[i].cost, `${k} cost L${i}`).toBeGreaterThan(d.levels[i - 1].cost);
        expect(d.levels[i].damage, `${k} damage L${i}`).toBeGreaterThan(d.levels[i - 1].damage);
        expect(d.levels[i].range, `${k} range L${i}`).toBeGreaterThan(d.levels[i - 1].range);
        expect(d.levels[i].speed, `${k} speed L${i}`).toBeGreaterThan(d.levels[i - 1].speed);
        expect(d.levels[i].cooldown, `${k} cooldown L${i}`).toBeLessThan(d.levels[i - 1].cooldown);
        expect(dps(d.levels[i]), `${k} dps L${i}`).toBeGreaterThan(dps(d.levels[i - 1]));
      }
      // Roughly a doubling per step, which is what makes the tier feel like a
      // tier rather than a percentage. Measured 2.24-2.62x on the L1->L2 step.
      expect(dps(d.levels[2]) / dps(d.levels[1]), `${k} L2 step`).toBeGreaterThan(1.8);
      expect(dps(d.levels[2]) / dps(d.levels[1]), `${k} L2 step`).toBeLessThan(2.8);
    }
  });

  it('holds the six inside +/-4% of each other on direct DPS at level 3', () => {
    // The docblock's rule — the six are separated by their signature effect and
    // never by raw numbers. It is honoured at L2 to within +/-0.4%; L0 and L1
    // predate it and are frozen as measured in the test above.
    const a = primals.map(([, d]) => dps(d.levels[2]));
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    expect(m).toBeCloseTo(1949.4, 0);
    for (const [k, d] of primals) {
      const off = Math.abs(dps(d.levels[2]) / m - 1);
      expect(off, `${k} is ${(off * 100).toFixed(1)}% off the mean at L2`).toBeLessThan(0.04);
    }
  });

  it('narrows the primal gold-efficiency EDGE at the third level instead of widening it', () => {
    /**
     * The design claim, executable: a primal is bought with tiles rather than
     * with gold, so the third tier must not be the point at which it also
     * becomes the best gold on the board. Its edge over a fully-forged fusion
     * shrinks, +9.6% -> +8.8%.
     *
     * CAREFUL WITH THE DOCBLOCK'S WORDING, because it overstates this. PRIMAL_STATS
     * calls the third level "the only upgrade in the game" whose gold efficiency
     * goes down. Measured across ALL_TOWERS, cumulative DPS-per-gold falls on
     * EVERY upgrade of EVERY armed tower — pure fire runs 0.3333 -> 0.2571 ->
     * 0.2462 and all fifteen fusions drop too. The bare fall is therefore the
     * norm and distinguishes nothing; what is actually unusual, and what the
     * surrounding paragraph is really arguing, is the fall RELATIVE TO THE
     * FUSION BASELINE. That is the form asserted here, with the universal fall
     * kept below as the control that makes the distinction visible.
     */
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const effAt = (lv) => mean(primals.map(([, d]) => dps(d.levels[lv]) / cumTo(d, lv)));
    expect(effAt(1)).toBeCloseTo(0.3167, 4);
    expect(effAt(2)).toBeCloseTo(0.3144, 4);
    expect(effAt(2)).toBeLessThan(effAt(1));

    // The yardstick the docblock argues from: a fully-forged fusion, 447.7/1550.
    const fusionEff = mean(Object.values(DUAL_TOWERS)
      .map((d) => dps(d.levels[1]) / (d.levels[0].cost + d.levels[1].cost)));
    expect(fusionEff).toBeCloseTo(0.2889, 4);
    expect(effAt(1) / fusionEff).toBeCloseTo(1.096, 3);
    expect(effAt(2) / fusionEff).toBeCloseTo(1.088, 3);
    expect(effAt(2) / fusionEff).toBeLessThan(effAt(1) / fusionEff);
    // "only 1.1x per gold" — the ceiling that stops a primal being the answer to
    // every question instead of to the tile question.
    expect(effAt(2) / fusionEff).toBeLessThan(1.2);

    // Control for the paragraph above.
    for (const [k, d] of ARMED) {
      const first = dps(d.levels[0]) / cumTo(d, 0);
      const last = dps(d.levels[d.levels.length - 1]) / cumTo(d, d.levels.length - 1);
      expect(last, `${k}: the raw fall is universal, not a primal trait`).toBeLessThan(first);
    }
  });

  it('costs 6 200 to forge fully, which is what the docblock says', () => {
    for (const [k, d] of primals) {
      expect(cumTo(d, 2), `${k} cumulative`).toBe(6200);
      expect(cumTo(d, 1), `${k} through L1`).toBe(3100);   // the old full price
    }
    // Sell refunds ECONOMY.sellRefund of what was actually spent, so these are
    // the three figures Game.sellTower can hand back. Asserted end-to-end
    // against the live game in tests/e2e/primal.spec.js.
    expect(Math.floor(900 * ECONOMY.sellRefund)).toBe(675);
    expect(Math.floor(3100 * ECONOMY.sellRefund)).toBe(2325);
    expect(Math.floor(6200 * ECONOMY.sellRefund)).toBe(4650);
  });

  it('leaves the stack price a per-TILE price, untouched by the new level', () => {
    // PRIMAL.stacksConsumed is charged once by Game.build and refunded in full by
    // Game.sellTower at any level. Nothing in the level table may imply
    // otherwise, so no level carries a stack field of its own.
    expect(PRIMAL.stacksRequired).toBe(3);
    expect(PRIMAL.stacksConsumed).toBe(2);
    for (const [k, d] of primals) {
      for (const [i, l] of d.levels.entries()) {
        expect(l.stacks, `${k} L${i} must not price stacks per level`).toBeUndefined();
      }
    }
  });

  it('adds the tier to primals ONLY — no other tower gained a level', () => {
    const shape = Object.fromEntries(
      Object.entries(ALL_TOWERS).map(([k, d]) => [k, d.levels.length]));
    const byKind = {};
    for (const [k, d] of Object.entries(ALL_TOWERS)) (byKind[d.kind] ??= new Set()).add(shape[k]);
    expect([...byKind.pure]).toEqual([3]);
    expect([...byKind.dual]).toEqual([2]);
    expect([...byKind.primal]).toEqual([3]);
    expect([...byKind.inert]).toEqual([1]);
    // 6*3 + 15*2 + 6*3 + 1 = 67 authored levels in the whole game.
    expect(Object.values(shape).reduce((s, n) => s + n, 0)).toBe(67);
  });
});

describe('TowerDefs — towerDef()', () => {
  it('resolves every canonical key', () => {
    for (const k of Object.keys(ALL_TOWERS)) expect(towerDef(k)).toBe(ALL_TOWERS[k]);
  });

  it('resolves every legacy dual id onto the canonical def', () => {
    for (const [old, current] of Object.entries(LEGACY_DUAL_IDS)) {
      expect(towerDef(old)).toBe(DUAL_TOWERS[current]);
      expect(towerDef(old).key).toBe(current);   // never the legacy string
    }
    expect(towerDef('steam').name).toBe('Vapor Tower');
    expect(towerDef('magma').name).toBe('Blacksmith Tower');
  });

  it('returns null for anything it does not know', () => {
    expect(towerDef('nope')).toBe(null);
    expect(towerDef('')).toBe(null);
    expect(towerDef(undefined)).toBe(null);
    expect(towerDef('fire+water')).toBe(null);   // a pair key is not a tower key
  });

  /**
   * KNOWN LATENT BUG, frozen as observed behaviour (reported, not fixed).
   *
   * ALL_TOWERS and LEGACY_DUAL_IDS are plain object literals, so towerDef()
   * inherits Object.prototype. `towerDef('constructor')` hands back the Object
   * constructor instead of null, and every caller then reads `.levels`,
   * `.kind`, `.key` off a function.
   *
   * Nothing in the current game reaches it: tower keys come from
   * availableTowers()/BuildBar, and SpectateCodec validates against its own
   * table. It becomes live the moment a key crosses the network or a URL.
   */
  it('is not prototype-safe: Object.prototype members resolve to something', () => {
    expect(towerDef('constructor')).toBe(Object);
    expect(typeof towerDef('toString')).toBe('function');
    expect(towerDef('hasOwnProperty')).not.toBe(null);
  });
});

describe('TowerDefs — availableTowers()', () => {
  const keys = (owned) => availableTowers(owned).map((d) => d.key);

  it('offers nothing when you own nothing', () => {
    expect(keys([])).toEqual([]);
  });

  it('offers only the pure tower for a single element', () => {
    expect(keys(['fire'])).toEqual(['fire']);
    expect(keys(['dark'])).toEqual(['dark']);
  });

  it('adds the fusion as soon as you hold both parents', () => {
    expect(keys(['fire', 'water'])).toEqual(['fire', 'water', 'vapor']);
    expect(keys(['water', 'fire'])).toEqual(['water', 'fire', 'vapor']);   // order-independent fusion
  });

  it('offers 6 pures + 15 fusions = 21 with one of each element', () => {
    const all = keys(ELEMENT_IDS);
    expect(all.length).toBe(21);
    expect(new Set(all).size).toBe(21);
    expect(all.filter((k) => PURE_TOWERS[k]).length).toBe(6);
    expect(all.filter((k) => DUAL_TOWERS[k]).length).toBe(15);
    expect(all.filter((k) => PRIMAL_TOWERS[k]).length).toBe(0);
  });

  it('unlocks the primal at exactly PRIMAL.stacksRequired copies, not before', () => {
    expect(PRIMAL.stacksRequired).toBe(3);
    expect(keys(['fire'])).not.toContain('primal_fire');
    expect(keys(['fire', 'fire'])).not.toContain('primal_fire');
    expect(keys(['fire', 'fire', 'fire'])).toContain('primal_fire');
    expect(keys(['fire', 'fire', 'fire', 'fire'])).toContain('primal_fire');
    // Duplicates never duplicate the pure or the fusion offers.
    expect(keys(['fire', 'fire', 'fire'])).toEqual(['fire', 'primal_fire']);
  });

  it('keeps every fusion alive alongside a primal — a primal never breaks one', () => {
    const k = keys(['fire', 'fire', 'fire', 'water']);
    expect(k).toEqual(['fire', 'water', 'vapor', 'primal_fire']);
  });

  it('offers all six primals at 18 stacks', () => {
    const owned = ELEMENT_IDS.flatMap((id) => [id, id, id]);
    const k = keys(owned);
    expect(k.length).toBe(27);                                        // 6 + 15 + 6
    for (const id of ELEMENT_IDS) expect(k).toContain(`primal_${id}`);
  });

  /**
   * The docblock warning, made executable.
   *
   * availableTowers accepts any iterable, so a Set is silently accepted — and
   * every count collapses to 1, which switches primals off for the rest of the
   * run with no error anywhere. This test exists so that a future refactor that
   * "tidies" Game.state.elements into a Set fails here instead of in a player's
   * wave-45 run.
   */
  it('LOSES primals if the caller passes a Set instead of an array', () => {
    const owned = ['fire', 'fire', 'fire'];
    expect(keys(owned)).toContain('primal_fire');
    expect(keys(new Set(owned))).not.toContain('primal_fire');
    expect(keys(new Set(owned))).toEqual(['fire']);
  });

  it('accepts a non-array iterable without throwing, pures and fusions intact', () => {
    const gen = function* () { yield 'fire'; yield 'water'; };
    expect(availableTowers(gen()).map((d) => d.key)).toEqual(['fire', 'water', 'vapor']);
  });

  it('never offers the foundation — it is always available and lives outside this list', () => {
    for (const owned of [[], ['fire'], ELEMENT_IDS, ['fire', 'fire', 'fire']]) {
      expect(keys(owned)).not.toContain('foundation');
    }
  });

  it('ignores an unrecognised element id below the primal threshold', () => {
    expect(keys(['fire', 'plasma'])).toEqual(['fire']);
    expect(keys(['plasma'])).toEqual([]);
    expect(keys(['plasma', 'plasma'])).toEqual([]);
  });

  /**
   * KNOWN LATENT BUG, frozen as observed behaviour (reported, not fixed).
   *
   * The pure and fusion loops guard with `if (PURE_TOWERS[id])` and
   * `if (d)`, but the primal loop does not: at stacksRequired copies it does
   * `PRIMALS[id].id` unguarded, so three copies of an id that is not one of the
   * six throws a TypeError and takes the whole build bar refresh with it.
   *
   * Unreachable today — Game.state.elements is only ever fed from
   * rollElementChoices over ELEMENT_IDS. It becomes live if element ids ever
   * arrive from a save file, a URL or the network.
   */
  it('THROWS on three copies of an unrecognised element id', () => {
    expect(() => availableTowers(['plasma', 'plasma', 'plasma'])).toThrow(TypeError);
    expect(() => availableTowers(['fire', 'plasma', 'plasma', 'plasma'])).toThrow(TypeError);
  });

  it('returns the shared def objects, not copies', () => {
    expect(availableTowers(['fire'])[0]).toBe(PURE_TOWERS.fire);
  });
});

describe('TowerDefs — morphTargets()', () => {
  it('is availableTowers minus every primal', () => {
    const owned = ELEMENT_IDS.flatMap((id) => [id, id, id]);
    const avail = availableTowers(owned).map((d) => d.key);
    const morph = morphTargets(owned).map((d) => d.key);
    expect(avail.length).toBe(27);
    expect(morph.length).toBe(21);                                     // the documented maximum
    expect(morph.some((k) => PRIMAL_TOWERS[k])).toBe(false);
    expect(avail.filter((k) => !PRIMAL_TOWERS[k])).toEqual(morph);
  });

  it('never offers the foundation as a morph target', () => {
    for (const owned of [[], ['fire'], ELEMENT_IDS, ['fire', 'fire', 'fire']]) {
      expect(morphTargets(owned).map((d) => d.key)).not.toContain('foundation');
    }
  });

  it('collapses to just the pure when the only unlock is a primal', () => {
    expect(morphTargets(['fire', 'fire', 'fire']).map((d) => d.key)).toEqual(['fire']);
  });
});

describe('TowerDefs — foundation economics', () => {
  it('prices arming strictly below building the same tower outright', () => {
    // Game.convertCost: round((target cost - foundation cost) * (1 - armDiscount)).
    // The foundation's own 20 is credited in full, so the route costs
    // 20 + convertCost and must never exceed the direct price.
    expect(ECONOMY.armDiscount).toBe(0.25);
    const foundationCost = FOUNDATION.levels[0].cost;
    for (const [k, d] of ARMED) {
      const direct = d.levels[0].cost;
      const convert = Math.max(0, Math.round((direct - foundationCost) * (1 - ECONOMY.armDiscount)));
      expect(foundationCost + convert, `${k}: block-then-arm must be cheaper`).toBeLessThan(direct);
    }
  });

  it('pins the two routes the source comments quote', () => {
    const conv = (c) => Math.max(0, Math.round((c - FOUNDATION.levels[0].cost) * (1 - ECONOMY.armDiscount)));
    expect(20 + conv(60)).toBe(50);      // pure fire: 50 instead of 60
    expect(20 + conv(450)).toBe(343);    // fusion
    expect(20 + conv(900)).toBe(680);    // primal, the "680 vs 675 refund" note
    expect(Math.round(900 * ECONOMY.sellRefund)).toBe(675);
  });

  it('keeps the foundation the cheapest thing on the board by a wide margin', () => {
    const cheapestArmed = Math.min(...ARMED.map(([, d]) => d.levels[0].cost));
    expect(FOUNDATION.levels[0].cost).toBe(20);
    expect(cheapestArmed).toBe(60);
    // Affordable on the opening purse (275) many times over: mazing is possible
    // on wave 1, which is the entire reason the piece exists.
    expect(Math.floor(ECONOMY.startGold / FOUNDATION.levels[0].cost)).toBe(13);
  });
});
