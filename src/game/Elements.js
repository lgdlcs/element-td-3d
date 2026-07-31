/**
 * Element definitions — the shared vocabulary of the whole game.
 * Every subsystem (towers, VFX, UI, audio, shaders) reads its identity colours
 * and semantics from here so the art direction stays coherent.
 *
 * Colours are authored in LINEAR-ish sRGB hex; consumers must call
 * `new THREE.Color(hex).convertSRGBToLinear()` (or set via `setHex(h, SRGBColorSpace)`).
 */

export const ELEMENT_IDS = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];

export const ELEMENTS = {
  fire: {
    id: 'fire',
    name: 'Fire',
    glyph: 'ƒ',
    color: 0xff5a1f,
    accent: 0xffd166,
    rim: 0xff2d00,
    emissive: 3.2,
    // narrative + mechanical identity
    tagline: 'Burns through armour, punishes the slow.',
    role: 'sustained damage over time',
  },
  water: {
    id: 'water',
    name: 'Water',
    glyph: '≈',
    color: 0x2fa8ff,
    accent: 0xa8e8ff,
    rim: 0x0066cc,
    emissive: 2.4,
    tagline: 'Chills and slows, bends the tide of a wave.',
    role: 'slow / control',
  },
  nature: {
    id: 'nature',
    name: 'Nature',
    glyph: '❀',
    color: 0x4fe07a,
    accent: 0xd6ff8f,
    rim: 0x0f7a3a,
    emissive: 2.2,
    tagline: 'Fast, relentless, feeds on what it kills.',
    role: 'attack speed',
  },
  earth: {
    id: 'earth',
    name: 'Earth',
    glyph: '◈',
    color: 0xc08a4a,
    accent: 0xf0d6a8,
    rim: 0x5c3a18,
    emissive: 1.4,
    tagline: 'Heavy, splashing impacts that shake the ground.',
    role: 'splash damage',
  },
  light: {
    id: 'light',
    name: 'Light',
    glyph: '✦',
    color: 0xfff2c4,
    accent: 0xffffff,
    rim: 0xffc04d,
    emissive: 4.0,
    tagline: 'Pierces, chains, and reveals.',
    role: 'range / pierce',
  },
  dark: {
    id: 'dark',
    name: 'Darkness',
    glyph: '●',
    color: 0x8a4fd6,
    accent: 0xdca8ff,
    rim: 0x2a0a4a,
    emissive: 2.8,
    tagline: 'Devours. Grows stronger with every kill.',
    role: 'execute / scaling',
  },
};

/** Canonical pair key, order-independent: `fire+water`. */
export function pairKey(a, b) {
  return [a, b].sort().join('+');
}

/**
 * Dual-element tower table. 6 elements -> 15 unordered pairs.
 *
 * These names are the CANONICAL Element TD ones, verified two independent
 * ways: each tower's own wiki infobox `elements=` field, and an in-game
 * screenshot of the Tower Table modal (reference/etd2-09-hud-tower-table.jpg).
 * See docs/REFERENCE.md. Do not "correct" these from memory — several
 * plausible-sounding names (Steam, Magma, Crystal, Void, Magic) are NOT in
 * the real game and were wrong in an earlier draft of this file.
 */
export const DUALS = {
  'fire+water':   { id: 'vapor',      name: 'Vapor',      color: 0xbfe9ff, accent: 0xffffff, damage: 'water' },
  'fire+nature':  { id: 'solar',      name: 'Solar',      color: 0xffb43d, accent: 0xfff0a8, damage: 'fire' },
  'earth+fire':   { id: 'blacksmith', name: 'Blacksmith', color: 0xff5a24, accent: 0xffc46a, damage: 'fire' },
  'fire+light':   { id: 'lightning',  name: 'Lightning',  color: 0xa8e4ff, accent: 0xffffff, damage: 'light' },
  'dark+fire':    { id: 'infernal',   name: 'Infernal',   color: 0xd6285c, accent: 0xff7ab8, damage: 'fire' },
  'nature+water': { id: 'well',       name: 'Well',       color: 0x4fd6c4, accent: 0xbdfff2, damage: 'water' },
  'earth+water':  { id: 'geyser',     name: 'Geyser',     color: 0x6fc4d6, accent: 0xd0f2ff, damage: 'earth' },
  'light+water':  { id: 'ice',        name: 'Ice',        color: 0x9fe8ff, accent: 0xffffff, damage: 'water' },
  'dark+water':   { id: 'poison',     name: 'Poison',     color: 0x7ad62a, accent: 0xd6ff5c, damage: 'dark' },
  'earth+nature': { id: 'mushroom',   name: 'Mushroom',   color: 0xc46a5c, accent: 0xf0d0a8, damage: 'nature' },
  'light+nature': { id: 'bloom',      name: 'Bloom',      color: 0xc4ff8a, accent: 0xffffff, damage: 'nature' },
  'dark+nature':  { id: 'disease',    name: 'Disease',    color: 0x8a9e3d, accent: 0xd6e08a, damage: 'dark' },
  'earth+light':  { id: 'atom',       name: 'Atom',       color: 0xe8e0ff, accent: 0xffffff, damage: 'light' },
  'dark+earth':   { id: 'howitzer',   name: 'Howitzer',   color: 0x8a7a5c, accent: 0xd6c4a0, damage: 'earth' },
  'dark+light':   { id: 'trickery',   name: 'Trickery',   color: 0xff8ae8, accent: 0xffffff, damage: 'light' },
};

/**
 * Ids used by an earlier incorrect draft. Kept so tooling, saved boards and
 * the screenshot harness that reference the old names keep resolving.
 */
export const LEGACY_DUAL_IDS = {
  steam: 'vapor', ember: 'solar', magma: 'blacksmith', blaze: 'lightning',
  hellfire: 'infernal', mud: 'geyser', mist: 'ice', abyss: 'poison',
  life: 'mushroom', gaia: 'bloom', crystal: 'atom', void: 'howitzer',
  magic: 'trickery',
};

export function getDual(a, b) {
  return DUALS[pairKey(a, b)] ?? null;
}

/** All 15 pairs, stable order, for UI grids. */
export const DUAL_LIST = Object.entries(DUALS).map(([key, v]) => ({
  key,
  parts: key.split('+'),
  ...v,
}));
