/**
 * VFX levels, re-derived against the CURRENT plate.
 *
 * Everything in this tree used to be authored against a scene whose mean
 * luminance was 56 and whose bloom threshold was 1.05. The frame was relit two
 * rounds ago: mean luminance is now ~124 (roughly 3x) and the bloom threshold
 * was raised to 2.05 to match. Numbers tuned against the old dark plate are
 * wrong in exactly the way the ground albedo turned out to be wrong — nobody
 * re-derived them, so they are recorded here in one place with the reasoning,
 * rather than scattered as magic numbers across four files.
 *
 * These are LINEAR, scene-referred values, read before ACES.
 */

/**
 * Bloom threshold the post stack is currently running. Not our value to set —
 * this is a mirror of it, and the only thing this file uses it for is to say
 * where "blooms" starts. If RenderPipeline moves, this comment is what tells
 * the next agent that these numbers are relative to it.
 *
 * PITFALLS §10: a comment that asserts a value living in another file is a
 * comment that will eventually lie, so nothing here *depends* on the number —
 * it is documentation, and FX_MAX_LUM below is an absolute ceiling either way.
 */
export const BLOOM_THRESHOLD_AT_AUTHORING = 2.05;

/**
 * Hue-preserving ceiling on any emissive this layer writes.
 *
 * Sits above the bloom threshold, so a hot core still blooms — a small hot core
 * is the point. What it forbids is the top end running away: the old ceiling
 * was `min(col, vec3(3.2))`, a PER-CHANNEL clamp, which flattens the largest
 * channel down onto the others and therefore desaturates on its way to white.
 * ART_BIBLE law 4 is explicit that saturation carries readability and
 * brightness does not, so a ceiling that spends chroma first is the wrong
 * ceiling. `capLum()` in each shader scales the whole colour by maxL/L instead,
 * which takes level and holds hue and chroma exactly.
 */
export const FX_MAX_LUM = 2.8;

/**
 * Smoke opacity multiplier, and the ambient the smoke scatters back.
 *
 * The smoke tier is alpha-over near-black soot, and it was authored to occlude
 * a dark board. On a plate three times brighter the same particle is a dirty
 * hole punched in the frame rather than a volume, and it lands squarely on the
 * tower cluster. Measured, paired on one build: hiding the whole fx layer made
 * the barrage board crop BRIGHTER, 126.5 -> 131.8 (midgame 133.8 -> 135.3).
 * ART_BIBLE law 8 says towers, units and effects own the TOP of the value
 * range; an effects layer with a net-negative luminance contribution over the
 * tower cluster fails it in the direction nobody was checking.
 *
 * Two corrections, both toward "thin veil" rather than "dark mass":
 *  - peak alpha cut, so smoke never owns a pixel outright and a tower
 *    silhouette always survives through it;
 *  - a scatter floor, because real smoke re-emits the ambient it sits in. It
 *    is deliberately well BELOW the board's mid-tone so smoke still reads as
 *    occluding matter, just not as a hole.
 */
export const SMOKE_ALPHA = 0.46;
export const SMOKE_SCATTER = [0.075, 0.079, 0.092];
