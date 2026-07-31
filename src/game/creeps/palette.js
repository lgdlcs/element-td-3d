/**
 * THE RESERVED HOSTILE HUE — round 5.
 * =============================================================================
 *
 * Three independent blind critics, none of whom saw each other's answers, all
 * said the same thing about round 4: they could not find a single enemy in the
 * frame. Two of them prescribed the same fix in the same words — *"a saturated
 * hostile accent reserved exclusively for enemies"*, *"a consistent contrasting
 * hue not used by any tower"*.
 *
 * This file is that reservation, and it is the only place a creep colour may be
 * authored.
 *
 *      HOSTILE = hue 344-356, saturation >= 88%.
 *      Nothing that is not an enemy may enter that band.
 *
 * WHY RED, and why this is a technical argument rather than a taste one
 * ---------------------------------------------------------------------------
 * Law 4 of the Art Bible: saturation carries readability, brightness does not,
 * because ACES bleaches hue out of anything bright. The corollary nobody had
 * used yet is that *how* bright a saturated colour is depends on WHICH hue it
 * is, because luminance is 0.2126R + 0.7152G + 0.0722B.
 *
 *   pure green at full chroma   -> luminance 0.72  -> ACES bleaches it to mint
 *   pure cyan   at full chroma  -> luminance 0.79  -> bleaches to white
 *   pure red    at full chroma  -> luminance 0.21  -> survives to 4x the level
 *
 * Round 4 shipped creeps at 0x1fffc8 (spring cyan) and 0xb4ff21 (lime). Those
 * are the two worst hues on that list. Measured on a real midgame capture, they
 * rendered as pale mint fog, at almost exactly the value and chroma of the
 * tower VFX washes they were standing in. Red is the only hue that can be run
 * at extreme chroma AND stay dark enough for ACES to keep the chroma.
 *
 * It is also, separately, the universal hostile convention, and it is what
 * Element TD 2 itself does — reference/etd2-06-graveyard-creep-rimlights.jpg is
 * a board of near-black demons wearing hot crimson edge lines on pale ground.
 *
 * WHAT ELSE IS IN FRAME (measured from src/game/Elements.js, round 5)
 * ---------------------------------------------------------------------------
 * Every tower body colour, sorted by hue:
 *
 *   mushroom 9   fire 16   blacksmith 16   earth 31   solar 36   howitzer 38
 *   light 46   disease 68   bloom 85   poison 89   nature 138   well 172
 *   ice 195   vapor 200   lightning 200   geyser 191   water 205   atom 252
 *   dark 268   trickery 310   infernal 342
 *
 * 344-356 is empty. The nearest neighbour is `infernal` (dark+fire) at hue 342,
 * 81% saturation — CROSS-TREE NOTE for the towers agent: that is the single
 * tower inside two degrees of the reserved band and it should move to hue <=
 * 320. It is a dual that requires two elements, so it is absent from most
 * boards; the reservation holds in practice today but it is not airtight.
 *
 * Terrain is warm stone at hue 0-20 and 17-21% saturation. It shares the hue
 * FAMILY but is four times less saturated and much lighter, which is the axis
 * law 4 exists to exploit.
 *
 * WHAT THE ARCHETYPES DO WITH THEIR ONE COLOUR
 * ---------------------------------------------------------------------------
 * They do not get their own hues. Round 4 gave each archetype a distinct
 * colour, and the result was that a wave of Stalkers was cyan — i.e. the water
 * tower's colour — and a wave of Mites was lime, i.e. nature's. Enemies read as
 * more tower glow. Identity now comes from silhouette, size and animation,
 * which is where Element TD 2 puts it too; the colour only ever says "hostile".
 * The variation below is VALUE inside one hue, never hue.
 */

/** Every enemy colour in the game. sRGB hex. Nothing outside this table. */
export const HOSTILE = {
  /** Grunt — the reference hostile red. hue 351, S 100%, V 100%. */
  normal: 0xff0026,
  /** Stalker — a shade lighter so a fast unit reads hot. hue 352. */
  fast: 0xff2444,
  /** Bulwark — deeper and heavier. hue 350, V 78%. */
  armored: 0xc70020,
  /** Mite — pale, because a small unit at 30px needs more value, not less. */
  swarm: 0xff5568,
  /** Wisp — the coolest edge of the band so a flyer separates from a walker. */
  flying: 0xff0048,
  /** Colossus — the hottest, purest red in the game. hue 355. */
  boss: 0xff0014,
};

/** The single canonical hostile red, for anything that is not per-archetype. */
export const HOSTILE_PRIMARY = 0xff0026;

/**
 * GLSL: the reserved hostile red at full chroma, in linear space.
 *
 * Deliberately a constant rather than something derived from `instanceColor` —
 * derivation is how round 4 ended up with six different creep hues, five of
 * which were a tower's. `instanceColor` still exists and still modulates VALUE
 * (see HOSTILE above), but the HUE is not negotiable from a per-instance
 * attribute.
 */
export const HOSTILE_GLSL = /* glsl */`
  // Hostile identity: hue is fixed, the instance colour only sets the level.
  // Returned at full chroma with the red primary intact, so it stays red all
  // the way through the ACES shoulder instead of climbing to white.
  vec3 hostileHue(vec3 instCol) {
    // Level = how bright this archetype's variant is. Unit-normalised so a
    // caller multiplying by 1.0 always gets the same apparent brightness of
    // red regardless of which archetype it is.
    float lvl = clamp(max(max(instCol.r, instCol.g), instCol.b), 0.30, 1.0);
    // Chroma is pinned. g/b are the small amounts that keep it from reading as
    // a clipped primary; they are what make it crimson rather than fire-engine.
    // Archetype variation rides on the OFF channels only (Mite is the pale one,
    // Bulwark the deep one), so the hue moves by at most a few degrees while
    // the value moves a lot.
    float pale = clamp(min(instCol.g, instCol.b) * 2.2, 0.0, 0.30);
    return vec3(1.0, 0.022 + pale, 0.078 + pale * 0.75) * lvl;
  }
`;
