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
  /**
   * NATURE — foliage, not a highlighter.
   *
   * The old pair (0x4fe07a / 0xd6ff8f) was a neon spring green at HSV
   * S=0.65 V=0.88 with a near-white chartreuse accent, and under additive bloom
   * it clipped to fluorescent. Two independent problems were folded into that:
   *
   *  1. CHROMA. Real foliage sits around S=0.40-0.50; 0.65 is signage green.
   *     The new colour drops to S=0.48 V=0.74 and lifts the red channel
   *     79 -> 99, which is the grey-green that reads as a leaf rather than as a
   *     screen. Hue is held at 132.7 deg (was 137.8) — deliberately NOT moved,
   *     because that is the only stretch of the wheel nature owns: every other
   *     green on the board is yellow-side (disease 72 deg, poison 92 deg,
   *     bloom 95 deg) or cyan-side (well 172 deg). 132.7 sits in the gap.
   *     It also stays well inside ElementLang.familyFromHue's [70, 165) nature
   *     bucket, with ~40 deg of margin on the near side instead of the accent's
   *     old 12 deg.
   *
   *  2. THE ACCENT WAS THE ACTUAL CULPRIT. 0xd6ff8f is (214,255,143): a blown
   *     highlighter at hue 82.0, only 12 deg from bucketing as `light`. It is now a
   *     new-growth green at 112.2 deg, S=0.40 V=0.83 — still the brightest hex
   *     nature owns (it is the rune tint, the shard highlight and, via
   *     PAL_PRIMAL, Worldroot's trim) but unmistakably green.
   *
   * MEASURE THESE THROUGH `new THREE.Color().setHex(h).convertSRGBToLinear()`,
   * NOT FROM THE HEX. That is the path every consumer in the repo uses, and with
   * ColorManagement on (three's default) setHex already lands in linear space,
   * so the explicit convert is a SECOND transform and an authored value arrives
   * roughly squared. It is uniform across the whole game, so relative reads
   * between elements are honest; absolute ones from the hex are not.
   *
   * Measured that way, the old nature colour had luminance 0.372 — the SECOND
   * BRIGHTEST identity colour in the game, behind only Light (0.778) and above
   * Fire (0.220). That single number is the complaint. The new one is 0.164,
   * level with Water (0.164) and still comfortably above Earth (0.089) and
   * Dark (0.046).
   *
   * `emissive` goes UP, 2.2 -> 2.8, and that is not a contradiction: it
   * multiplies the albedo above, so at 2.2 the core would have landed at 0.44 of
   * its old radiance (0.164*2.2 = 0.361 against 0.372*2.2 = 0.819), which is the
   * "dull" failure mode; 2.8 lands it at 0.56 (0.459 against that same 0.819).
   * BOTH OF THOSE ARE RATIOS, which they were not: the figure quoted here used
   * to be the absolute product 0.361 written as "0.36" beside a real ratio, so
   * the pair read as a steeply non-linear response and is nothing of the kind.
   * Deliberately calmer either way, and
   * mid-pack among the six rather than second-hottest: earth 0.125, dark 0.128,
   * water 0.392, NATURE 0.459, fire 0.704, light 3.112.
   *
   * `rim` is re-authored to match (deep shadow green, 133.3 deg). NB: a grep of
   * src/ on 2026-08-03 found NO consumer of any element's `rim` — the `rim`
   * hits elsewhere are Arena/Lighting back-light and local GLSL variables. It is
   * kept as the authored third value of the ramp, not because anything samples
   * it.
   */
  nature: {
    id: 'nature',
    name: 'Nature',
    glyph: '❀',
    color: 0x63bd76,
    accent: 0x8ad47f,
    rim: 0x1d5c2b,
    emissive: 2.8,
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
  // Bloom was 0xc4ff8a — (196,255,138), a blown-out chartreuse with a maxed
  // green channel. It is the one DERIVED green that shared the neon register the
  // nature element has just left, so it comes down with it: same hue family
  // (94.9 deg, still the light-side green a light+nature fusion should be), but
  // V 1.00 -> 0.88 and S 0.46 -> 0.38. It stays the brightest green on the board
  // by value, which is its read against Poison and Disease.
  // Its VFX bucket is unaffected: DUAL_FAMILY has no `bloom` entry (only the
  // legacy `gaia`), so ElementLang maps this hex to the `light` family whatever
  // its value is.
  'light+nature': { id: 'bloom',      name: 'Bloom',      color: 0xaee08a, accent: 0xffffff, damage: 'nature' },
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

/**
 * Primal towers — one per element, the apex of a single element rather than of
 * a pairing. Colour and accent are DELIBERATELY the element's own hex and not a
 * bespoke one: ProjectileManager.spawn() resolves its VFX dialect through
 * ElementLang.resolveFamily(element, color), and an unseen hex would fall
 * through to familyFromHue() and can bucket wrong. The primal read is carried by
 * silhouette, emissive and the ground pool (TowerArchetypes), never by hue.
 */
export const PRIMALS = {
  fire:   { id: 'primal_fire',   name: 'Cataclysm',  tagline: 'The ground itself catches, and keeps burning.' },
  water:  { id: 'primal_water',  name: 'Maelstrom',  tagline: 'A vortex that drags a whole pack to a crawl.' },
  nature: { id: 'primal_nature', name: 'Worldroot',  tagline: 'Never stops firing. Never stops spreading.' },
  earth:  { id: 'primal_earth',  name: 'Tectonic',   tagline: 'The heaviest single blow on the board.' },
  light:  { id: 'primal_light',  name: 'Judgement',  tagline: 'Reaches further than anything, and armour is not a word it knows.' },
  dark:   { id: 'primal_dark',   name: 'Oblivion',   tagline: 'Devours the wounded and gives you back your lives.' },
};

/** All six, stable order, for UI grids. */
export const PRIMAL_LIST = ELEMENT_IDS.map((id) => ({ element: id, ...PRIMALS[id] }));
