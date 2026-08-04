import { describe, it, expect } from 'vitest';
import {
  ELEMENT_IDS, ELEMENTS, DUALS, DUAL_LIST, LEGACY_DUAL_IDS, PRIMALS, PRIMAL_LIST,
  pairKey, getDual,
} from '../../src/game/Elements.js';

/**
 * Elements — the shared vocabulary.
 *
 * FREEZE TEST. The 15 dual names in particular are a KNOWN REGRESSION SURFACE:
 * the docblock in Elements.js records that an earlier draft invented Steam,
 * Magma, Crystal, Void and Magic, none of which exist in the real game. They are
 * spelled out literally below so that "correcting" them from memory a second
 * time fails loudly instead of shipping.
 */

const EXPECTED_ELEMENTS = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];

describe('Elements — the six', () => {
  it('is exactly the six elements, in the canonical order', () => {
    expect(ELEMENT_IDS).toEqual(EXPECTED_ELEMENTS);
    expect(Object.keys(ELEMENTS)).toEqual(EXPECTED_ELEMENTS);
  });

  it('gives every element a complete, self-consistent record', () => {
    for (const id of ELEMENT_IDS) {
      const e = ELEMENTS[id];
      expect(e.id).toBe(id);                      // the key and the record agree
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.glyph.length).toBeGreaterThan(0);
      expect(e.tagline.length).toBeGreaterThan(10);
      expect(e.role.length).toBeGreaterThan(0);
      for (const k of ['color', 'accent', 'rim']) {
        expect(Number.isInteger(e[k])).toBe(true);
        expect(e[k]).toBeGreaterThanOrEqual(0);
        expect(e[k]).toBeLessThanOrEqual(0xffffff);
      }
      expect(e.emissive).toBeGreaterThan(0);
    }
  });

  it('pins the identity hexes that VFX bucketing depends on', () => {
    // ElementLang builds COLOR_TO_FAMILY from these exact integers; a changed
    // hex silently falls through to familyFromHue and can bucket wrong.
    expect(ELEMENTS.fire.color).toBe(0xff5a1f);
    expect(ELEMENTS.water.color).toBe(0x2fa8ff);
    // Nature was 0x4fe07a — a neon spring green at HSL S=0.70 that read as a
    // highlighter under bloom. Deliberately re-authored; the PROPERTIES that
    // change was supposed to buy (lower chroma, same hue bucket, still distinct
    // from every other green on the board) are asserted in nature-colour.test.js
    // rather than being implied by this one literal.
    expect(ELEMENTS.nature.color).toBe(0x63bd76);
    expect(ELEMENTS.earth.color).toBe(0xc08a4a);
    expect(ELEMENTS.light.color).toBe(0xfff2c4);
    expect(ELEMENTS.dark.color).toBe(0x8a4fd6);
  });

  it('keeps all six identity colours distinct', () => {
    const colors = ELEMENT_IDS.map((id) => ELEMENTS[id].color);
    expect(new Set(colors).size).toBe(6);
    const accents = ELEMENT_IDS.map((id) => ELEMENTS[id].accent);
    expect(new Set(accents).size).toBe(6);
  });

  it('names Darkness, whose id is "dark"', () => {
    // The id/name mismatch is deliberate and consumed by the UI; freeze it.
    expect(ELEMENTS.dark.name).toBe('Darkness');
    expect(ELEMENT_IDS.map((id) => ELEMENTS[id].name)).toEqual([
      'Fire', 'Water', 'Nature', 'Earth', 'Light', 'Darkness',
    ]);
  });
});

describe('Elements — pairKey', () => {
  it('is order-independent', () => {
    expect(pairKey('fire', 'water')).toBe('fire+water');
    expect(pairKey('water', 'fire')).toBe('fire+water');
    expect(pairKey('dark', 'earth')).toBe(pairKey('earth', 'dark'));
  });

  it('sorts lexicographically, which is what the DUALS keys are written in', () => {
    expect(pairKey('nature', 'earth')).toBe('earth+nature');
    expect(pairKey('light', 'dark')).toBe('dark+light');
    // Every one of the 15 authored keys must already be in sorted form,
    // otherwise getDual would miss it for one of the two argument orders.
    for (const key of Object.keys(DUALS)) {
      const [a, b] = key.split('+');
      expect(pairKey(a, b)).toBe(key);
      expect(pairKey(b, a)).toBe(key);
    }
  });

  it('produces all 15 unordered pairs and no duplicates', () => {
    const keys = new Set();
    for (let i = 0; i < ELEMENT_IDS.length; i++) {
      for (let j = i + 1; j < ELEMENT_IDS.length; j++) {
        keys.add(pairKey(ELEMENT_IDS[i], ELEMENT_IDS[j]));
      }
    }
    expect(keys.size).toBe(15);
  });
});

describe('Elements — the 15 duals', () => {
  it('is exactly the canonical table, key by key', () => {
    // Verbatim. Do not "fix" a name here without a wiki/screenshot citation:
    // see docs/REFERENCE.md and the docblock on DUALS.
    const byKey = Object.fromEntries(Object.entries(DUALS).map(([k, v]) => [k, v.id]));
    expect(byKey).toEqual({
      'fire+water': 'vapor',
      'fire+nature': 'solar',
      'earth+fire': 'blacksmith',
      'fire+light': 'lightning',
      'dark+fire': 'infernal',
      'nature+water': 'well',
      'earth+water': 'geyser',
      'light+water': 'ice',
      'dark+water': 'poison',
      'earth+nature': 'mushroom',
      'light+nature': 'bloom',
      'dark+nature': 'disease',
      'earth+light': 'atom',
      'dark+earth': 'howitzer',
      'dark+light': 'trickery',
    });
  });

  it('does NOT contain the five names of the earlier incorrect draft', () => {
    const ids = new Set(Object.values(DUALS).map((d) => d.id));
    const names = new Set(Object.values(DUALS).map((d) => d.name));
    for (const bogus of ['steam', 'magma', 'crystal', 'void', 'magic']) {
      expect(ids.has(bogus)).toBe(false);
    }
    for (const bogus of ['Steam', 'Magma', 'Crystal', 'Void', 'Magic']) {
      expect(names.has(bogus)).toBe(false);
    }
  });

  it('covers all 15 element pairings, exactly once each', () => {
    expect(Object.keys(DUALS).length).toBe(15);
    for (let i = 0; i < ELEMENT_IDS.length; i++) {
      for (let j = i + 1; j < ELEMENT_IDS.length; j++) {
        const key = pairKey(ELEMENT_IDS[i], ELEMENT_IDS[j]);
        expect(DUALS[key], `missing dual for ${key}`).toBeTruthy();
      }
    }
    expect(new Set(Object.values(DUALS).map((d) => d.id)).size).toBe(15);
    expect(new Set(Object.values(DUALS).map((d) => d.name)).size).toBe(15);
  });

  it('names each dual with the capitalised form of its id', () => {
    for (const d of Object.values(DUALS)) {
      expect(d.name.toLowerCase()).toBe(d.id);
    }
  });

  it('inherits its damage type from one of its two parent elements', () => {
    for (const [key, d] of Object.entries(DUALS)) {
      expect(key.split('+')).toContain(d.damage);
    }
    // Spot-check the two that read counter-intuitively.
    expect(DUALS['dark+water'].damage).toBe('dark');    // Poison, not Water
    expect(DUALS['earth+water'].damage).toBe('earth');  // Geyser, not Water
  });

  it('gives every dual a colour and an accent', () => {
    for (const d of Object.values(DUALS)) {
      expect(Number.isInteger(d.color)).toBe(true);
      expect(Number.isInteger(d.accent)).toBe(true);
      expect(d.color).toBeLessThanOrEqual(0xffffff);
    }
  });
});

describe('Elements — getDual', () => {
  it('resolves both argument orders to the same record', () => {
    for (const [key, expected] of Object.entries(DUALS)) {
      const [a, b] = key.split('+');
      expect(getDual(a, b)).toBe(expected);
      expect(getDual(b, a)).toBe(expected);
    }
  });

  it('returns null for a same-element pair and for an unknown element', () => {
    expect(getDual('fire', 'fire')).toBe(null);
    expect(getDual('fire', 'plasma')).toBe(null);
    expect(getDual('plasma', 'plasma')).toBe(null);
    expect(getDual(undefined, 'fire')).toBe(null);
  });
});

describe('Elements — DUAL_LIST', () => {
  it('mirrors DUALS in insertion order, with parsed parts', () => {
    expect(DUAL_LIST.length).toBe(15);
    expect(DUAL_LIST.map((d) => d.key)).toEqual(Object.keys(DUALS));
    for (const d of DUAL_LIST) {
      expect(d.parts.length).toBe(2);
      expect(d.parts.join('+')).toBe(d.key);
      for (const p of d.parts) expect(ELEMENT_IDS).toContain(p);
      expect(d.id).toBe(DUALS[d.key].id);
    }
    expect(DUAL_LIST[0]).toMatchObject({ key: 'fire+water', id: 'vapor', parts: ['fire', 'water'] });
  });
});

describe('Elements — legacy dual ids', () => {
  it('maps 13 old ids, each onto a real canonical dual', () => {
    const canonical = new Set(Object.values(DUALS).map((d) => d.id));
    expect(Object.keys(LEGACY_DUAL_IDS).length).toBe(13);
    for (const [old, current] of Object.entries(LEGACY_DUAL_IDS)) {
      expect(canonical.has(current), `${old} -> ${current} is not a real dual`).toBe(true);
    }
  });

  it('maps the five wrong names the docblock calls out', () => {
    expect(LEGACY_DUAL_IDS.steam).toBe('vapor');
    expect(LEGACY_DUAL_IDS.magma).toBe('blacksmith');
    expect(LEGACY_DUAL_IDS.crystal).toBe('atom');
    expect(LEGACY_DUAL_IDS.void).toBe('howitzer');
    expect(LEGACY_DUAL_IDS.magic).toBe('trickery');
  });

  it('never shadows a canonical id, so towerDef cannot resolve ambiguously', () => {
    const canonical = new Set(Object.values(DUALS).map((d) => d.id));
    for (const old of Object.keys(LEGACY_DUAL_IDS)) {
      expect(canonical.has(old), `legacy id "${old}" collides with a canonical id`).toBe(false);
    }
  });

  it('is injective — no two old ids resolve to the same tower', () => {
    expect(new Set(Object.values(LEGACY_DUAL_IDS)).size).toBe(13);
  });

  it('leaves exactly two duals with no legacy alias', () => {
    // OBSERVED: `well` and `disease` were named correctly in the first draft, so
    // they never acquired an alias. Recorded, not a defect.
    const aliased = new Set(Object.values(LEGACY_DUAL_IDS));
    const orphans = Object.values(DUALS).map((d) => d.id).filter((id) => !aliased.has(id));
    expect(orphans).toEqual(['well', 'disease']);
  });
});

describe('Elements — primals', () => {
  it('is one primal per element, keyed by element id', () => {
    expect(Object.keys(PRIMALS)).toEqual(EXPECTED_ELEMENTS);
  });

  it('names the six apex towers', () => {
    expect(Object.fromEntries(Object.entries(PRIMALS).map(([el, p]) => [el, p.name]))).toEqual({
      fire: 'Cataclysm',
      water: 'Maelstrom',
      nature: 'Worldroot',
      earth: 'Tectonic',
      light: 'Judgement',
      dark: 'Oblivion',
    });
  });

  it('derives every primal id as primal_<element>', () => {
    for (const el of ELEMENT_IDS) {
      expect(PRIMALS[el].id).toBe(`primal_${el}`);
      expect(PRIMALS[el].tagline.length).toBeGreaterThan(10);
    }
  });

  it('cannot collide with a dual id', () => {
    const duals = new Set(Object.values(DUALS).map((d) => d.id));
    for (const p of Object.values(PRIMALS)) expect(duals.has(p.id)).toBe(false);
  });

  it('exposes PRIMAL_LIST in ELEMENT_IDS order with the element carried along', () => {
    expect(PRIMAL_LIST.map((p) => p.element)).toEqual(ELEMENT_IDS);
    expect(PRIMAL_LIST.map((p) => p.id)).toEqual(ELEMENT_IDS.map((id) => `primal_${id}`));
    expect(PRIMAL_LIST[4]).toMatchObject({ element: 'light', id: 'primal_light', name: 'Judgement' });
  });
});
