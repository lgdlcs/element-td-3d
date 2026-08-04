/**
 * Element visual language.
 *
 * Maps a tower's identity colour back to one of the six elemental families so
 * VFX can speak the right dialect (Art Bible §7) even when the caller does not
 * pass an explicit `element` field. `spawn()` accepts an optional `element`,
 * and this module is the graceful fallback when it is absent.
 *
 * READ-ONLY consumer of ../game/Elements.js — never mutates it.
 */
import { ELEMENTS, DUALS } from '../game/Elements.js';

/** Canonical projectile archetypes. */
export const ARCH = {
  BOLT: 0,    // fire — jagged flame head, ember shed
  ORB: 1,     // water — smooth refractive orb, droplet shed
  SEED: 2,    // nature — spinning seed husk with spore halo
  BOULDER: 3, // earth — tumbling rock, arcs, dust trail
  LANCE: 4,   // light — thin bright lance with a 4-point flare
  VOID: 5,    // dark — dark core, bright violet rim, inward wisps
};

export const FAMILY_INDEX = { fire: 0, water: 1, nature: 2, earth: 3, light: 4, dark: 5 };
export const FAMILY_LIST = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];

const ARCH_OF = {
  fire: ARCH.BOLT,
  water: ARCH.ORB,
  nature: ARCH.SEED,
  earth: ARCH.BOULDER,
  light: ARCH.LANCE,
  dark: ARCH.VOID,
};

/**
 * For every dual we choose the parent whose *visual* language dominates.
 * (Steam looks like water, magma looks like fire, void looks like dark, ...)
 */
const DUAL_FAMILY = {
  steam: 'water', ember: 'fire', magma: 'fire', blaze: 'light', hellfire: 'fire',
  ice: 'water', mud: 'earth', mist: 'water', abyss: 'dark', life: 'nature',
  gaia: 'nature', poison: 'nature', crystal: 'light', void: 'dark', magic: 'light',
};

// colour hex -> family, built once from the canonical tables.
const COLOR_TO_FAMILY = new Map();
for (const id of FAMILY_LIST) {
  const e = ELEMENTS[id];
  COLOR_TO_FAMILY.set(e.color, id);
  COLOR_TO_FAMILY.set(e.accent, id);
}
for (const [, d] of Object.entries(DUALS)) {
  COLOR_TO_FAMILY.set(d.color, DUAL_FAMILY[d.id] ?? 'light');
}

// id -> family, covers explicit `element` strings including dual ids.
const ID_TO_FAMILY = new Map();
for (const id of FAMILY_LIST) ID_TO_FAMILY.set(id, id);
for (const [k, v] of Object.entries(DUAL_FAMILY)) ID_TO_FAMILY.set(k, v);

/**
 * Resolve a family id from whatever the caller happened to give us.
 * `element` wins; colour is the fallback; hue analysis is the last resort so a
 * brand-new colour never breaks.
 */
export function resolveFamily(element, colorHex) {
  if (element && ID_TO_FAMILY.has(element)) return ID_TO_FAMILY.get(element);
  if (typeof colorHex === 'number' && COLOR_TO_FAMILY.has(colorHex)) {
    return COLOR_TO_FAMILY.get(colorHex);
  }
  if (typeof colorHex === 'number') return familyFromHue(colorHex);
  return 'light';
}

/** Crude but stable hue bucket, used only for colours we've never seen. */
function familyFromHue(hex) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.08) return max > 0.7 ? 'light' : 'dark';
  let h = 0;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 20 || h >= 340) return 'fire';
  if (h < 48) return b < 0.35 ? 'earth' : 'fire';
  if (h < 70) return 'light';
  if (h < 165) return 'nature';
  if (h < 255) return 'water';
  return 'dark';
}

export function archetypeOf(family) {
  return ARCH_OF[family] ?? ARCH.ORB;
}

/**
 * Per-family VFX tuning. All colours are sRGB hex; the effect system converts.
 * `spark`  — the fast radial burst colour
 * `soot`   — the slow secondary smoke/dust colour
 * `decal`  — the lingering ground mark colour
 */
export const FAMILY_FX = {
  fire: {
    spark: 0xffb347, soot: 0x1c0c05, decal: 0xff4a10,
    sparkCount: 20, sparkSpeed: 11, sparkLife: 0.42, grav: -6, drag: 4.2,
    smoke: 10, smokeRise: 3.2, smokeAlpha: 1.0, ember: true, shimmer: true,
    decalType: 'scorch', glowDecal: 0xff5a1f, glowDecalLife: 1.5,
  },
  water: {
    // Water's "smoke" is mist: pale, but it must stay thin or it reads as
    // cotton wool. Low alpha does that; a pale *bright* colour does not.
    spark: 0xbfe9ff, soot: 0x38505e, decal: 0x7fd8ff,
    sparkCount: 22, sparkSpeed: 9, sparkLife: 0.5, grav: -16, drag: 2.2,
    smoke: 6, smokeRise: 1.0, smokeAlpha: 0.45, ember: false, shimmer: false,
    decalType: 'frost', glowDecal: 0x8fd8ff, glowDecalLife: 2.6,
  },
  nature: {
    // 0x8ad47f IS ELEMENTS.nature.accent, and re-authored from it deliberately.
    //
    // This entry kept 0xd6ff8f — the blown highlighter Elements.js names as the
    // actual cause of "the nature towers are too flashy" — for a whole round
    // after the identity colours moved off it. impactCore mixes it half-and-half
    // with the tower's own colour and emits the flash above the bloom threshold,
    // so the retired hex was HALF of every nature impact and muzzle burst: the
    // tower albedo dropped 56% (0.372 -> 0.164 measured through setHex +
    // convertSRGBToLinear) while the burst dropped 18%. A Worldroot L2 fires
    // 6.7 times a second, so a wave threw the old neon several times a second
    // next to a tower that was no longer neon.
    //
    // 0.294 against the body's 0.164 is a 1.79x spark/body ratio, which puts
    // nature between fire (1.52) and earth (2.32) instead of at 4.92, alone off
    // the end of the scale.
    //
    // NO glowDecal: decalType 'poison' reads `decal` and never touches it (only
    // 'scorch' and 'frost' do). The 0x7ad62a that used to sit here tuned nothing
    // and read as if it did.
    spark: 0x8ad47f, soot: 0x182a10, decal: 0x6ad04a,
    sparkCount: 18, sparkSpeed: 7.5, sparkLife: 0.75, grav: -1.6, drag: 2.6,
    smoke: 7, smokeRise: 1.6, smokeAlpha: 0.85, ember: false, shimmer: false,
    decalType: 'poison',
  },
  earth: {
    spark: 0xd8b077, soot: 0x2a2016, decal: 0x6b543a,
    sparkCount: 16, sparkSpeed: 9, sparkLife: 0.6, grav: -26, drag: 1.2,
    smoke: 16, smokeRise: 2.4, smokeAlpha: 1.0, ember: false, shimmer: false,
    decalType: 'crater', glowDecal: 0, glowDecalLife: 0,
    chunks: true,
  },
  light: {
    // Light barely smokes at all; what little there is must not be a pale slab.
    spark: 0xfff6da, soot: 0x3a3428, decal: 0xffe9b0,
    sparkCount: 24, sparkSpeed: 14, sparkLife: 0.3, grav: 1.0, drag: 6.5,
    smoke: 3, smokeRise: 2.0, smokeAlpha: 0.35, ember: false, shimmer: false,
    decalType: 'rune', glowDecal: 0xffe9b0, glowDecalLife: 1.1,
    motes: true,
  },
  dark: {
    spark: 0xc48aff, soot: 0x0c0512, decal: 0x5c3d8a,
    sparkCount: 20, sparkSpeed: 8, sparkLife: 0.55, grav: -2.0, drag: 3.0,
    smoke: 9, smokeRise: 1.2, smokeAlpha: 1.0, ember: false, shimmer: false,
    decalType: 'void', glowDecal: 0x8a4fd6, glowDecalLife: 1.8,
    implode: true, tendrils: true,
  },
};

/**
 * Muzzle-flash language, one entry per family.
 *
 * Every muzzle is built from the same four ingredients — a hot **core**, a
 * saturated **glow**, a tapered **ribbon cone** along the firing direction and
 * a **point light** — but no two families share a silhouette. This table is
 * what makes a fire muzzle a stubby fat billow and a light muzzle a long thin
 * lance with a cross flare.
 *
 *  cone*   ribbon geometry (world units) and how it evolves
 *  core*   the sub-pixel white-hot heart (blooms; above 1.05 linear)
 *  glow*   the wide saturated body (below 1.0 so stacks stay readable)
 *  spark*  the forward ejecta cone
 *  cross   draw a perpendicular anamorphic flare (light only)
 *  suck    ejecta travel INWARD (dark only)
 */
export const FAMILY_MUZZLE = {
  fire: {
    coneLen: 2.05, coneW: 0.330, coneGrow: 1.55, coneLife: 0.232, curl: 0.55,
    coreSize: 0.40, coreLife: 0.116, coreGain: 3.0,
    glowSize: 1.30, glowLife: 0.248, glowGain: 0.85,
    sparks: 9, sparkSpeed: 9, sparkSpread: 0.55, sparkLife: 0.26, sparkGrav: 1.2,
    embers: 4, smoke: 3, smokeRise: 2.6,
    light: 1.0, lightDist: 8.5, lightLife: 0.248,
    spill: 1.7, spillGain: 0.42,
  },
  water: {
    coneLen: 1.80, coneW: 0.266, coneGrow: 1.30, coneLife: 0.202, curl: 0.20,
    coreSize: 0.34, coreLife: 0.109, coreGain: 2.7,
    glowSize: 1.09, glowLife: 0.232, glowGain: 0.80,
    sparks: 12, sparkSpeed: 8, sparkSpread: 0.62, sparkLife: 0.42, sparkGrav: -11,
    embers: 0, smoke: 2, smokeRise: 0.8, mist: true,
    light: 0.75, lightDist: 7.5, lightLife: 0.217,
    spill: 1.5, spillGain: 0.34,
  },
  nature: {
    coneLen: 1.60, coneW: 0.166, coneGrow: 1.25, coneLife: 0.232, curl: 0.35,
    coreSize: 0.30, coreLife: 0.109, coreGain: 2.5,
    glowSize: 1.03, glowLife: 0.279, glowGain: 0.78,
    sparks: 7, sparkSpeed: 6, sparkSpread: 0.70, sparkLife: 0.55, sparkGrav: -1.2,
    embers: 5, smoke: 2, smokeRise: 1.1, spores: true,
    light: 0.65, lightDist: 7, lightLife: 0.232,
    spill: 1.4, spillGain: 0.30,
  },
  earth: {
    coneLen: 1.30, coneW: 0.380, coneGrow: 1.15, coneLife: 0.171, curl: 0.15,
    coreSize: 0.30, coreLife: 0.093, coreGain: 2.0,
    glowSize: 0.94, glowLife: 0.186, glowGain: 0.55,
    sparks: 6, sparkSpeed: 7, sparkSpread: 0.50, sparkLife: 0.35, sparkGrav: -22,
    embers: 0, smoke: 7, smokeRise: 1.6, chips: 5,
    light: 0.5, lightDist: 6, lightLife: 0.171,
    spill: 1.9, spillGain: 0.22,
  },
  light: {
    coneLen: 3.30, coneW: 0.240, coneGrow: 1.10, coneLife: 0.171, curl: 0.0,
    coreSize: 0.46, coreLife: 0.116, coreGain: 3.2,
    glowSize: 1.03, glowLife: 0.186, glowGain: 0.95,
    sparks: 8, sparkSpeed: 15, sparkSpread: 0.22, sparkLife: 0.20, sparkGrav: 0.6,
    embers: 3, smoke: 1, smokeRise: 1.4, cross: 0.95, motes: true,
    light: 1.25, lightDist: 10, lightLife: 0.202,
    spill: 2.1, spillGain: 0.40,
  },
  dark: {
    coneLen: 1.60, coneW: 0.318, coneGrow: 0.72, coneLife: 0.264, curl: 0.75,
    coreSize: 0.26, coreLife: 0.109, coreGain: 2.2,
    glowSize: 1.36, glowLife: 0.31, glowGain: 0.72,
    sparks: 10, sparkSpeed: 6, sparkSpread: 0.85, sparkLife: 0.30, sparkGrav: -1.0,
    embers: 0, smoke: 3, smokeRise: 0.7, suck: true,
    light: 0.7, lightDist: 8, lightLife: 0.279,
    spill: 1.6, spillGain: 0.30,
  },
};
