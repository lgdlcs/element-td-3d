import * as THREE from 'three';
import { ELEMENTS } from '../Elements.js';
import {
  Parts, MAT, bevelBox, taperBox, prism, lathe, shard, rock, ring, sphere,
  limb, twist, erode, rng, hashStr,
} from './TowerParts.js';

/**
 * The tower silhouette language.
 *
 * Rule 1 — every pure element is legible as a black shape.
 *
 * ROUND 5 REWRITE. Rounds 1-4 wrote that rule down and then failed it three
 * times in a blind A/B, with all three art directors independently using the
 * same words: "eight variations on the same tapered chess-pawn, distinguished
 * only by tint". They were right, and the reason is now measurable: the
 * silhouette tool had never once produced a usable image (PITFALLS §8), so the
 * previous language was six *surface treatments* — jagged, smooth, branching —
 * hung on ONE mass. Every element had the same total height (within 15%), the
 * same footprint order, the same widest-point-at-the-ground, the same
 * bottom-heavy cone, and no negative space anywhere. Adjectives about texture
 * cannot separate shapes; only MASS and PROFILE can.
 *
 * The rewrite assigns each family a different answer to three questions —
 * how tall relative to how wide, where the widest point sits, and whether the
 * outline has a hole in it:
 *
 *   earth   SQUAT BUNKER.   Shortest and by far widest. A battered talus and a
 *                           crenellated drum. Aspect ~1.4:1. Widest at ground.
 *   water   CANTILEVERED.   An aqueduct ARCH on two piers with an orb slung in
 *                           the void. Wide, low, and the only silhouette with a
 *                           hole through the middle of it.
 *   fire    ASYMMETRIC.     Mass thrown off-axis: a lopsided outline whose
 *                           bounding box is not centred on the tile. The only
 *                           tower that leans.
 *   nature  TOP-HEAVY.      Three thin splayed trunks, nothing at knee height,
 *                           and a canopy 5 units across at the very top.
 *                           Widest point at ~90% height.
 *   dark    SKELETAL.       A three-legged armature that kicks OUT to a wide
 *                           shoulder ring then pinches back IN under a heavy
 *                           crown. Two waists, three triangular voids, and
 *                           almost nothing on the ground.
 *   light   NEEDLE.         Tallest by 40% and narrowest by 4x. No wide base at
 *                           all — a uniform thin shaft, aspect ~11:1.
 *
 * Height spread across the six is 1.9x and footprint spread is 4.8x, so no two
 * families share a bounding box. Verify with:
 *   node tools/tower-sheet.mjs --set pure --silhouette
 *
 * Rule 2 — a dual tower is a genuine fusion, not a shared "reactor":
 *   the HEAVIER parent (earth > nature > water > fire > dark > light) donates
 *   the foundation and the shaft; the LIGHTER parent donates the crown; a
 *   machined collar carrying both parents' emissive bands joins them. Seven
 *   duals whose canonical names are strongly figurative (Howitzer, Blacksmith,
 *   Atom, Mushroom, Well, Geyser, Trickery) override the crown entirely with a
 *   purpose-built one.
 */

const HEAVY = { earth: 5, nature: 4, water: 3, fire: 2, dark: 1, light: 0 };

/**
 * Stone / metal / trim per element.
 *
 * Round 3 lifted every channel's VALUE: they had been authored against a floor
 * that a premultiplied-alpha bug had left almost pure ambient, and once that was
 * fixed water, nature and dark sat below 8% luminance against a ~40% floor —
 * not a silhouette, a hole. Those values are kept.
 *
 * Round 4 lifts CHROMA. Side by side with the shipped game the single most
 * obvious difference, after silhouette, is CHROMA: their fire tower is red
 * stone, their water tower is blue stone, and you can name the element from a
 * 40-pixel thumbnail with the glow switched off. Ours were six variations on
 * grey-brown at roughly 8-14% saturation, which is why the element read
 * depended entirely on the emissive core.
 *
 * Value is deliberately held near where round 3 put it — that was measured
 * against the floor and works — so this is a chroma change, not a brightness
 * change, and the silhouette separation from the flagstones is unaffected.
 */
/*
 * ROUND 7. The round-4 chroma lift was in the right direction and stopped one
 * step short of the thing that actually breaks the read: THREE OF THE SIX
 * FAMILIES SHARED A HUE BAND. fire (0x8c3d2b), earth (0x9a7136) and light
 * (0xbfae7e) are all warm ochre within ~35 degrees of hue of each other, at
 * similar value. Under a warm key that is one colour. Ablate the emissives
 * (`node tools/tower-camsil.mjs --modes noemis`) and two thirds of the board is
 * a single mass of tan drums — which is the second half of "differentiated only
 * by hue, and the hues are washed out by additive bloom": there was less hue
 * there than the code suggested.
 *
 * Warm-side families cannot be separated by hue alone, because there is not
 * enough wheel between red and cream. They are separated by a VALUE LADDER
 * instead, which survives ACES and bloom in a way that hue does not:
 *
 *   fire   dark, maximum chroma red     stone luminance ~0.19
 *   earth  mid bronze / amber           stone luminance ~0.44
 *   light  near-white ivory + gold      stone luminance ~0.76
 *
 * Cool-side families keep hue separation, with chroma pushed up: water cyan-
 * blue, nature yellow-green, dark violet. Law 4 — saturation carries the read,
 * brightness does not — so every entry gains chroma and only `light` gains
 * value.
 */
const PAL = {
  fire:   { stone: 0x7a2416, stone2: 0xbc3c19, metal: 0x37110b, trim: 0xff6a22 },
  water:  { stone: 0x1f6fae, stone2: 0x49a9de, metal: 0x113a5c, trim: 0x46cdf5 },
  nature: { stone: 0x2e7a2c, stone2: 0x66bc44, metal: 0x154018, trim: 0xaadd3a },
  earth:  { stone: 0x9c7a2c, stone2: 0xc9a13c, metal: 0x4d3612, trim: 0xefb52c },
  light:  { stone: 0xd8cfae, stone2: 0xf9f1d2, metal: 0x8d7c4e, trim: 0xffd964 },
  dark:   { stone: 0x552b9c, stone2: 0x8a55d8, metal: 0x2b1650, trim: 0xb56cff },
};

/**
 * Primal override of the palette above.
 *
 * The same override on all six, so "primal" reads as a CLASS before the element
 * does: near-black metal everywhere, and the trim pushed to the element's ACCENT
 * (the brightest hex it owns) so the contrast against that metal is maximal.
 * Stone is untouched — the element read lives there and in the emissive.
 */
const PAL_PRIMAL = {};
for (const [id, p] of Object.entries(PAL)) {
  PAL_PRIMAL[id] = { ...p, metal: 0x0e0b12, trim: ELEMENTS[id].accent };
}

const TAU = Math.PI * 2;

/**
 * The mass budget per family — the table that makes the silhouettes different.
 *
 *   h    shaft height as a multiple of the base 6.35 units
 *   foot radius the ground-contact debris is scattered to
 *
 * These are the numbers a blind viewer is actually reading. Do not equalise
 * them "for consistency": the spread IS the deliverable. h ranges 0.74 (earth)
 * to 1.46 (light), which is a 2.0x height difference between the shortest and
 * the tallest tower on the board, and the footprints run 4.9 units (earth) to
 * 1.1 (light).
 */
const SHAPE = {
  fire:   { h: 0.92, foot: 1.72 },
  water:  { h: 0.98, foot: 2.30 },
  nature: { h: 1.10, foot: 1.34 },
  earth:  { h: 0.58, foot: 2.26 },
  light:  { h: 1.70, foot: 0.96 },
  dark:   { h: 1.30, foot: 1.12 },
};

/**
 * THE HEIGHT CONSTANT, AND WHY IT IS THE MOST IMPORTANT NUMBER IN THIS FILE.
 *
 * Round 6 lost 3/3 with all three blind critics saying the towers were
 * indistinguishable — "the same barrel/keg silhouette with a coloured glow on
 * top" — even though the six profiles above are unmistakable in the elevation
 * sheet. `tools/tower-camsil.mjs` explains the contradiction: the elevation is
 * not the image being judged.
 *
 * At the gameplay camera the towers do not have individual silhouettes at all.
 * They form ONE continuous mass. Measured, on the shipped midgame board:
 *
 *   camera pitch                          51.5 deg below horizontal
 *   tower pitch on the board              4.0 world units (a 2x2 footprint)
 *   height at which a tower stops
 *     covering the BASE of the tower
 *     one row behind it: 4 * tan(51.5)    5.04 units
 *   actual tower heights                  7.93 - 13.03, mean 9.91
 *   towers over that threshold            21 of 21
 *
 * Every tower on the board was 1.6x to 2.6x taller than the height at which it
 * buries its neighbour. So the only part of any tower that survived into the
 * frame was the crown and the top of the drum under it — which is *precisely*
 * the "cylinder plus glowing orb" the critics kept describing. It is not a
 * shape problem and it was never fixable by reshaping: the shapes were there
 * and the frame could not show them.
 *
 * The control that proves it: `--modes sil,spread` renders the same towers,
 * same camera, same distance, differing only in spacing. Packed, they are one
 * blob; spread, all six families are separable instantly.
 *
 * The reference agrees independently. In `etd2-05` and `etd2-11` an Element TD
 * 2 tower is roughly as tall as its footprint is wide (~1.0-1.3x), sits fully
 * inside its tile, and at maximum density you can still see floor between the
 * rows and every tower's complete outline against it. Ours were ~2.5x.
 *
 * 2.45 puts the shortest family (water) at 4.2 units and the tallest (light) at
 * 7.1, mean 5.6, so the three families still above the threshold are exactly
 * the three with the least solid area — the needle, the skeletal armature and
 * the leaning shard, none of which occlude much even when they are tall. The
 * height SPREAD is unchanged at 1.67x, because the spread is the silhouette
 * lever and only the absolute scale was ever the bug.
 *
 * If you raise this number, re-run `node tools/tower-camsil.mjs --modes sil`
 * and look at the image. If the towers merge into one mass, G3 cannot pass no
 * matter what else is true.
 */
const SHAFT = 2.45;
/** Per upgrade level. Was 0.68, which made a level-2 light tower 15 units. */
const SHAFT_LEVEL = 0.18;

// ---------------------------------------------------------------------------
// Foundations — everything below the shaft. Returns the top Y.
//
// The plinth heights are themselves part of the vertical rhythm: water meets
// the ground at 0.30 and earth at 1.20, so the eye reads a different first
// interval on every family before the shaft has even started.
// ---------------------------------------------------------------------------
/**
 * Six free-standing obelisks planted around the footing, canted 8 degrees
 * inward, with an emissive sliver on the inner face. Primals only.
 *
 * This is the primal read that SURVIVES THE CAMERA. The SHAFT docblock below
 * proves that towers occlude each other from ~5 units up, which is precisely why
 * the tell cannot be height — making a primal taller would re-introduce the bug
 * round 7 spent a whole pass removing. The ring instead sits at 1.15 units on a
 * radius the neighbouring tile does not reach, under the additive ground pool,
 * which is visible even when the tower's own body is not.
 *
 * 1.86 + 0.19 = 2.05 against a 2.0-unit tile half-width: the ring reaches the
 * tile edge and no further, exactly like earth's 4.42 plinth does today.
 */
function primalRing(P, x) {
  const p = x.pal;
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU + 0.26;
    const cx = Math.cos(a) * 1.86, cz = Math.sin(a) * 1.86;
    P.add(shard(0.19, 1.15, 5, 0.30), {
      color: p.stone2, mat: MAT.stoneCut, x: cx, z: cz, y: 0.10, ry: a, rz: -0.14,
    });
    P.add(taperBox(0.055, 0.035, 0.72, 0.045, 0.03), {
      color: x.color, mat: MAT.core, emissive: x.emis * 1.35,
      x: cx * 0.86, z: cz * 0.86, y: 0.52, ry: a, rz: -0.14,
    });
  }
}

const PLINTH = {
  /** ASYMMETRIC — a cracked slab shoved off the tile centre, plus a broken step. */
  fire(P, x) {
    const p = x.pal;
    P.add(bevelBox(3.10, 0.40, 2.44, 0.07), { color: p.stone, mat: MAT.stoneCut, y: 0.20, ry: 0.13, x: 0.30 });
    P.add(bevelBox(2.00, 0.42, 1.72, 0.06), { color: p.stone2, mat: MAT.stoneCut, y: 0.61, ry: -0.34, x: 0.58, z: -0.16 });
    // Deliberately NOT mirrored: a low broken step on the far side, so the
    // footprint's centre of area sits well off the axis of the shaft.
    P.add(bevelBox(1.46, 0.28, 1.28, 0.06), { color: p.stone2, mat: MAT.stoneCut, y: 0.14, ry: 0.52, x: -1.34, z: 0.28 });
    for (let i = 0; i < 4; i++) {
      const a = -0.9 + x.rand() * 2.4;
      P.add(rock(0.34 + x.rand() * 0.24, 91 + i), { color: p.stone, mat: MAT.stone, x: 0.3 + Math.cos(a) * 1.36, z: Math.sin(a) * 1.30, y: 0.30, ry: a });
    }
    return 0.82;
  },
  /** CANTILEVERED — a wide, very shallow catch-basin the arch springs from. */
  water(P, x) {
    const p = x.pal;
    // 2.12 max radius, i.e. 4.24 across: the basin is the widest thing water
    // owns and it still has to fit a 4.0-unit tile without eating a neighbour.
    P.add(lathe([[0, 0], [2.08, 0.04], [2.12, 0.22], [1.82, 0.30], [1.68, 0.26], [1.62, 0.11], [0, 0.11]], 14),
      { color: p.stone, mat: MAT.stoneSmooth });
    P.add(ring(1.90, 0.085, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: 0.26, rx: Math.PI / 2 });
    return 0.30;
  },
  /** TOP-HEAVY — a small root ball. Nothing here may compete with the canopy. */
  nature(P, x) {
    const p = x.pal;
    P.add(lathe([[0, 0], [1.10, 0.06], [0.94, 0.32], [0.66, 0.48], [0, 0.54]], 14), { color: p.stone, mat: MAT.stone });
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * TAU + x.rand() * 0.4;
      const rr = 1.20 + x.rand() * 0.40;
      P.add(limb([Math.cos(a) * 0.32, 0.55, Math.sin(a) * 0.32], [Math.cos(a) * rr, 0.02, Math.sin(a) * rr], 0.19, 0.05, 5),
        { color: p.stone2, mat: MAT.wood });
    }
    return 0.54;
  },
  /** SQUAT BUNKER — the widest footprint on the board, and a battered talus. */
  earth(P, x) {
    const p = x.pal;
    P.add(bevelBox(4.42, 0.28, 4.42, 0.08), { color: p.stone, mat: MAT.stoneCut, y: 0.14 });
    P.add(bevelBox(3.98, 0.26, 3.98, 0.08), { color: p.stone2, mat: MAT.stoneCut, y: 0.41 });
    // The battered skirt is the whole "fortification, not column" read: a
    // sloped face carrying the mass outward instead of a stack of shrinking
    // boxes, which is what made this element photograph as a chimney.
    P.add(taperBox(3.74, 2.94, 0.66, 3.74, 2.94), { color: p.stone, mat: MAT.stoneCut, y: 0.87 });
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      P.add(prism(0.60, 0.78, 1.06, 7), {
        color: p.stone2, mat: MAT.stoneCut, x: Math.cos(a) * 1.58, z: Math.sin(a) * 1.58, y: 0.53, ry: a,
      });
    }
    return 1.20;
  },
  /** NEEDLE — an almost invisible footing. Any spread here kills the aspect. */
  light(P, x) {
    const p = x.pal;
    P.add(prism(0.90, 1.04, 0.24, 8), { color: p.stone2, mat: MAT.stoneCut, y: 0.12 });
    P.add(prism(0.66, 0.78, 0.24, 8), { color: p.stone, mat: MAT.stoneCut, y: 0.36 });
    P.add(ring(0.74, 0.042, TAU, 5, 16), { color: p.trim, mat: MAT.gold, y: 0.48, rx: Math.PI / 2 });
    return 0.50;
  },
  /** SKELETAL — three separate pads. There is no slab, and that is the point. */
  dark(P, x) {
    const p = x.pal;
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * TAU + 0.5;
      P.add(prism(0.42, 0.58, 0.30, 6), {
        color: p.stone, mat: MAT.stoneCut, x: Math.cos(a) * 0.66, z: Math.sin(a) * 0.66, y: 0.15, ry: a,
      });
    }
    P.add(prism(0.26, 0.36, 0.15, 6), { color: p.metal, mat: MAT.metalDark, y: 0.075 });
    return 0.30;
  },
};

/**
 * Where the tower meets the board.
 *
 * Nothing in the reference frames touches the ground with a clean seam: soil,
 * gravel and grass tufts pile against every footing, and the eye reads that
 * pile-up as "this object has been standing here" long before it reads any
 * surface detail. Ours met the flagstones with a perfectly straight machined
 * edge, which is a large part of why the plinths looked dropped in rather than
 * built. Five eroded chips and two tufts: ~110 triangles per tower, which
 * measured at 20.6k across every pass at seven chips and is trimmed to ~13k.
 */
function footing(P, x, r) {
  const p = x.pal;
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * TAU + x.rand() * 0.7;
    const rr = r * (0.94 + x.rand() * 0.30);
    P.add(rock(0.20 + x.rand() * 0.20, 301 + i, 0.42), {
      color: i % 3 === 0 ? p.stone2 : 0x4a4038, mat: MAT.stone, style: 0,
      x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: 0.05, ry: a, sy: 0.42 + x.rand() * 0.22,
    });
  }
  for (let i = 0; i < 2; i++) {
    const a = i * 2.6 + 1.1 + x.rand() * 0.5;
    const rr = r * 1.02;
    P.add(shard(0.05, 0.42 + x.rand() * 0.22, 3), {
      color: 0x50632f, mat: MAT.wood, style: 0,
      x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: 0.18, ry: a, rz: 0.30 - x.rand() * 0.6,
    });
  }
}

// ---------------------------------------------------------------------------
// Shafts — from the plinth top to `top`.
// ---------------------------------------------------------------------------
const BODY = {
  /**
   * ASYMMETRIC. The only tower on the board whose axis is not vertical.
   *
   * A KINKED shaft: it leans hard off the tile to a knee at 58% height, then
   * doubles back to land the crown on the axis. The first attempt leaned the
   * whole shaft, which displaced the top by 1.4 units — and the crown is yawed
   * about the tile axis by TowerBatch, so it cannot follow. It rendered as a
   * brazier floating in mid-air beside its own tower. The kink keeps the head
   * seated while still giving a lopsided outline with a corner in it, which is
   * what actually reads as asymmetric in black; a jagged surface on a centred
   * cone does not.
   */
  fire(P, x, y0, top) {
    const p = x.pal, h = top - y0;
    const kneeY = y0 + h * 0.58;
    const kneeX = 1.16;
    P.add(erode(limb([0.16, y0, 0.06], [kneeX, kneeY, -0.10], 1.04, 0.66, 6), 0.030, 5),
      { color: p.stone, mat: MAT.stoneCut });
    P.add(erode(limb([kneeX, kneeY, -0.10], [0.04, top, 0.02], 0.66, 0.34, 6), 0.026, 9),
      { color: p.stone2, mat: MAT.stoneCut });

    // The outrigger: a second, near-full-height spire braced off the lean side.
    const outG = shard(0.46, h * 0.88, 5, 0.20);
    outG.translate(0, h * 0.44, 0);
    P.add(outG, { color: p.stone2, mat: MAT.stoneCut, y: y0 + 0.10, x: 1.46, z: -0.34, rz: -0.26, ry: 0.7 });
    // ...and a stump on the other side, at a third the height. Not a mirror.
    const stumpG = shard(0.38, h * 0.34, 5, 0.24);
    stumpG.translate(0, h * 0.17, 0);
    P.add(stumpG, { color: p.stone, mat: MAT.stoneCut, y: y0, x: -1.06, z: 0.36, rz: 0.36, ry: 2.1 });

    // Blades raked in the lean direction only — a flame does not lick both ways.
    const angs = [0.15, 0.85, 5.55, 1.55, 5.05, 0.45];
    const axisX = (t) => (t < 0.58 ? kneeX * (t / 0.58) : kneeX * (1 - (t - 0.58) / 0.42));
    for (let i = 0; i < angs.length; i++) {
      const a = angs[i];
      const t = 0.20 + x.rand() * 0.62;
      const bh = (0.34 + x.rand() * 0.36) * h * (0.7 + t);
      P.add(shard(0.22, bh, 4), {
        color: i % 2 ? p.stone2 : p.metal, mat: i % 2 ? MAT.stoneCut : MAT.metalDark,
        x: axisX(t) + Math.cos(a) * (0.58 + t * 0.54), z: Math.sin(a) * (0.58 + t * 0.54),
        y: y0 + h * t * 0.97, ry: a, rz: -0.52 - x.rand() * 0.26 - t * 0.24,
      });
    }
    for (let i = 0; i < 3; i++) {
      const a = i * 2.09 + 0.6;
      P.add(taperBox(0.085, 0.045, h * 0.50, 0.055, 0.04), {
        color: x.color, mat: MAT.core, emissive: x.emis * 0.55,
        x: axisX(0.40) + Math.cos(a) * 0.50, z: Math.sin(a) * 0.50, y: y0 + h * 0.40, ry: a, rz: -0.28,
      });
    }
    P.add(ring(0.80, 0.090, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: y0 + h * 0.28, x: axisX(0.28), rx: Math.PI / 2, rz: -0.30 });
    P.add(ring(0.66, 0.085, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: kneeY + 0.06, x: kneeX, rx: Math.PI / 2, rz: 0.16 });
    P.add(ring(0.44, 0.075, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: top - 0.18, x: 0.06, rx: Math.PI / 2 });
    return top;
  },

  /**
   * CANTILEVERED. An aqueduct arch, and the only hole in any tower outline.
   *
   * Negative space is the single cheapest silhouette cue there is: no amount of
   * profile tuning on a solid mass can be confused with a shape you can see
   * through. Two battered piers, a semicircular arch springing off their
   * shoulders, and the reservoir orb slung in the void underneath it.
   */
  water(P, x, y0, top) {
    const p = x.pal, h = top - y0;
    // The arch must be proportional to the shaft, not to the span. It used to
    // be `rise = span * 1.06` with `pierH = h * 0.44`, which is fine only while
    // h is large: when round 7 cut the shafts to reference proportions the apex
    // overshot `top`, the neck lathe was built with NEGATIVE segment heights,
    // and the crown ended up seated inside the keystone. A hardcoded dimension
    // beside a scaled one is a latent bug waiting for someone to change the
    // scale.
    const span = 1.34;               // half the clear distance between piers
    const pierH = h * 0.34;
    const yS = y0 + pierH;           // springing line
    const rise = h * 0.50;

    for (const s of [-1, 1]) {
      P.add(lathe([[0, 0], [0.66, 0], [0.62, pierH * 0.26], [0.50, pierH * 0.62], [0.42, pierH], [0, pierH]], 10),
        { color: p.stone, mat: MAT.stoneSmooth, x: s * span, y: y0 });
      P.add(ring(0.54, 0.085, TAU, 5, 14), { color: p.trim, mat: MAT.metal, x: s * span, y: y0 + pierH * 0.52, rx: Math.PI / 2 });
    }

    // The arch. Nine voussoirs; alternating tint so it reads as laid stone.
    const segs = 9;
    let prev = null;
    for (let i = 0; i <= segs; i++) {
      const a = Math.PI - (i / segs) * Math.PI;
      const pt = [Math.cos(a) * span, yS + Math.sin(a) * rise, 0];
      if (prev) {
        P.add(limb(prev, pt, 0.30, 0.30, 6), { color: i % 2 ? p.stone2 : p.stone, mat: MAT.stoneCut });
      }
      prev = pt;
    }
    // Keystone, and the short neck carrying the crown up off the arch apex.
    const apex = yS + rise;
    P.add(taperBox(0.34, 0.44, 0.46, 0.62, 0.62), { color: p.stone2, mat: MAT.stoneCut, y: apex + 0.10 });
    P.add(lathe([[0.46, 0], [0.40, (top - apex) * 0.6], [0.44, top - apex - 0.28], [0, top - apex - 0.28]], 12),
      { color: p.stone, mat: MAT.stoneSmooth, y: apex + 0.30 });

    // The reservoir, hanging in the middle of the void where nothing else on
    // the board has anything at all.
    P.add(taperBox(0.07, 0.07, 0.52, 0.07, 0.07), { color: p.metal, mat: MAT.metal, y: apex - 0.26 });
    P.add(sphere(0.52, 12, 9), { color: x.color, mat: MAT.core, emissive: x.emis * 0.85, y: apex - 0.86 });
    P.add(ring(0.60, 0.055, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: apex - 0.86, rx: Math.PI / 2 - 0.5 });

    // Spillways off the outside of each pier: mass thrown sideways, low.
    for (const s of [-1, 1]) {
      P.add(taperBox(0.44, 0.22, 0.30, 0.72, 0.42), {
        color: p.stone2, mat: MAT.stoneSmooth, x: s * (span + 0.62), y: y0 + pierH * 0.30, rz: s * 0.5,
      });
    }
    return top;
  },

  /**
   * TOP-HEAVY. Widest point at ~90% of the height, and nothing at knee level.
   *
   * Three thin trunks splaying out of one root ball, carrying a canopy roughly
   * five units across. The previous version was a single fat centred trunk with
   * boughs, i.e. a cone with bumps; the read that survives in black is the
   * inversion — a narrow stem under a broad crown.
   */
  nature(P, x, y0, top) {
    const p = x.pal, h = top - y0;
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * TAU + 0.4;
      const lean = 0.30 + (i % 2) * 0.20;
      const outR = 0.52 + i * 0.16;
      const segs = 3;
      let prev = [Math.cos(a) * 0.26, y0, Math.sin(a) * 0.26];
      for (let j = 1; j <= segs; j++) {
        const t = j / segs;
        const aa = a + t * lean;
        const nxt = [Math.cos(aa) * (0.26 + outR * t), y0 + h * t * 0.90, Math.sin(aa) * (0.26 + outR * t)];
        P.add(twist(limb(prev, nxt, 0.34 - 0.075 * (j - 1), 0.27 - 0.075 * (j - 1), 6), 0.28),
          { color: j === 1 ? p.stone : p.stone2, mat: MAT.wood });
        prev = nxt;
      }
      // Canopy. Reach is what carries the read, so the boughs go far out and
      // the leaf masses are big — all of it above 84% height, which keeps the
      // creep lane clear underneath.
      for (let k = 0; k < 3; k++) {
        const ca = a + lean + (k - 1) * 0.92;
        const cr = 1.24 + k * 0.40 + (i % 2) * 0.16;
        const cy = y0 + h * (0.84 + (k % 2) * 0.10);
        P.add(limb(prev, [Math.cos(ca) * cr, cy, Math.sin(ca) * cr], 0.15, 0.07, 5), { color: p.stone2, mat: MAT.wood });
        // Leaf masses have to be big enough to MERGE into one canopy. At 0.58
        // radius they stayed nine separate blobs on nine separate sticks, which
        // photographs as scrap rather than as a crown — the top-heavy read only
        // works if the top is one continuous silhouette.
        // style 0, not the timber style the branches use: at 0.86 radius the
        // vertical grain reads as corrugated planking rather than as foliage.
        P.add(rock(0.86, 31 + i * 3 + k, 0.34), {
          color: p.trim, mat: MAT.wood, style: 0, x: Math.cos(ca) * cr, y: cy + 0.22, z: Math.sin(ca) * cr, sy: 0.54, ry: i + k,
        });
      }
      // A second, inner tier that closes the gap between the three trunks so
      // the canopy reads as a single dome rather than three separate bouquets.
      P.add(rock(0.94, 71 + i, 0.30), {
        color: p.trim, mat: MAT.wood, style: 0,
        x: Math.cos(a + lean * 0.5) * 0.62, y: y0 + h * 0.94, z: Math.sin(a + lean * 0.5) * 0.62, sy: 0.52,
      });
      P.add(sphere(0.20, 8, 6), {
        color: i ? x.accent : x.color, mat: MAT.core, emissive: x.emis * 0.7,
        x: Math.cos(a) * 0.46, y: y0 + h * (0.34 + i * 0.16), z: Math.sin(a) * 0.46,
      });
    }
    return top;
  },

  /**
   * SQUAT BUNKER. The shortest tower on the board and the only one wider than
   * it is tall through its lower half.
   *
   * A crenellated drum, not a stack of shrinking boxes: the previous stepped
   * column had a 2.24 base on a 6-unit shaft and photographed as a chimney,
   * which is precisely the "tapered cylinder" note. Merlons give a serrated top
   * edge that no other family has.
   */
  earth(P, x, y0, top) {
    const p = x.pal, h = top - y0;
    // Radii. The drum plus its parapet must stay inside ~2.4 so an earth tower
    // does not eat its neighbours' tiles: the cell is 2.0 and a tower owns 2x2.
    const rB = 1.78, rT = 1.56;
    P.add(prism(rT, rB, h * 0.80, 8), { color: p.stone, mat: MAT.stoneCut, y: y0 + h * 0.40 });
    // Two heavy string courses. Wide, flat metal — surfaces that can actually
    // hold a specular streak at this camera distance.
    for (let i = 0; i < 2; i++) {
      const t = 0.30 + i * 0.34;
      P.add(ring(rB - (rB - rT) * t + 0.10, 0.13, TAU, 4, 18), {
        color: p.metal, mat: MAT.metal, y: y0 + h * t, rx: Math.PI / 2,
      });
    }
    // Machicolated parapet: a corbelled ring that oversails the drum, then
    // merlons. This is the whole "fortification" read.
    P.add(lathe([[rT, 0], [rT + 0.34, 0.30], [rT + 0.34, 0.52], [rT + 0.10, 0.52], [rT + 0.10, 0.30], [rT - 0.02, 0]], 16),
      { color: p.stone2, mat: MAT.stoneCut, y: y0 + h * 0.80 });
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * TAU + 0.2;
      P.add(bevelBox(0.62, h * 0.20, 0.40, 0.05), {
        color: i % 2 ? p.stone2 : p.stone, mat: MAT.stoneCut,
        x: Math.cos(a) * (rT + 0.18), z: Math.sin(a) * (rT + 0.18), y: y0 + h * 0.90, ry: a,
      });
    }
    // Two squat buttress towers hanging off opposite flanks — the plan is not
    // radially symmetric, which separates it from light and dark at a glance.
    for (const s of [-1, 1]) {
      P.add(prism(0.52, 0.66, h * 0.62, 7), {
        color: p.stone2, mat: MAT.stoneCut, x: s * (rB + 0.34), z: s * 0.26, y: y0 + h * 0.31,
      });
      P.add(prism(0.74, 0.74, h * 0.10, 7), {
        color: p.metal, mat: MAT.metal, x: s * (rB + 0.34), z: s * 0.26, y: y0 + h * 0.66,
      });
    }
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + 0.4;
      P.add(taperBox(0.13, 0.09, h * 0.56, 0.07, 0.06), {
        color: x.color, mat: MAT.core, emissive: x.emis * 0.75,
        x: Math.cos(a) * (rB - 0.06), z: Math.sin(a) * (rB - 0.06), y: y0 + h * 0.40, ry: a,
      });
    }
    return top;
  },

  /**
   * NEEDLE. Tallest by 40%, narrowest by 4x, and the same width top to bottom.
   *
   * Every other family varies its section; this one deliberately does not. A
   * constant thin shaft with evenly spaced collars is the "precise, measured,
   * man-made" read, and its aspect ratio alone (~11:1) tells you which tower it
   * is at a size where nothing else is resolvable.
   */
  light(P, x, y0, top) {
    const p = x.pal, h = top - y0;
    P.add(prism(0.19, 0.27, h, 8), { color: p.stone2, mat: MAT.stoneCut, y: y0 + h / 2 });
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * TAU;
      P.add(taperBox(0.075, 0.055, h * 0.96, 0.10, 0.07), {
        color: p.stone, mat: MAT.stoneCut,
        x: Math.cos(a) * 0.26, z: Math.sin(a) * 0.26, y: y0 + h * 0.48, ry: a,
      });
    }
    // Six collars, not four: the eye counts them, and on a shaft this long four
    // left gaps big enough to read as three separate segments.
    for (let i = 0; i < 6; i++) {
      P.add(ring(0.36 - i * 0.016, 0.040, TAU, 5, 16), {
        color: p.trim, mat: MAT.gold, y: y0 + h * (0.10 + i * 0.156), rx: Math.PI / 2,
      });
    }
    for (const s of [-1, 1]) {
      P.add(taperBox(0.045, 0.028, h * 0.78, 0.038, 0.026), {
        color: x.color, mat: MAT.core, emissive: x.emis * 0.5, y: y0 + h * 0.50, z: s * 0.30,
      });
    }
    return top;
  },

  /**
   * SKELETAL. Three legs, three triangular voids, and two waists.
   *
   * The outline kicks OUT from an almost non-existent footprint to a wide
   * shoulder ring at 62% height, then pinches back IN under the crown. Nothing
   * else on the board changes direction twice, and nothing else is mostly empty
   * space. The old "inverted wedge" was a cone standing on its point, which
   * photographed as a cone.
   */
  dark(P, x, y0, top) {
    const p = x.pal, h = top - y0;
    const shY = y0 + h * 0.62;
    const rOut = 1.74;
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * TAU + 0.5;
      const foot = [Math.cos(a) * 0.42, y0, Math.sin(a) * 0.42];
      const knee = [Math.cos(a) * rOut, shY, Math.sin(a) * rOut];
      const neck = [Math.cos(a) * 0.48, top - 0.12, Math.sin(a) * 0.48];
      P.add(limb(foot, knee, 0.32, 0.20, 6), { color: p.stone, mat: MAT.stoneCut });
      P.add(limb(knee, neck, 0.20, 0.26, 6), { color: p.stone2, mat: MAT.stoneCut });
      // A blade hanging outboard and down off each shoulder: the void under the
      // splay gets a serrated upper edge instead of a clean triangle.
      P.add(shard(0.16, 1.45, 4), {
        color: p.metal, mat: MAT.metalDark,
        x: Math.cos(a) * (rOut + 0.16), z: Math.sin(a) * (rOut + 0.16), y: shY - 0.60, rx: Math.PI, ry: a, rz: 0.24,
      });
      P.add(taperBox(0.10, 0.07, h * 0.34, 0.07, 0.05), {
        color: x.color, mat: MAT.core, emissive: x.emis * 0.55,
        x: Math.cos(a) * (0.30 + rOut * 0.42), z: Math.sin(a) * (0.30 + rOut * 0.42),
        y: y0 + h * 0.40, ry: a, rz: -0.42,
      });
    }
    P.add(ring(rOut, 0.115, TAU, 4, 18), { color: p.trim, mat: MAT.metal, y: shY, rx: Math.PI / 2 });
    P.add(ring(rOut * 0.60, 0.075, TAU, 4, 16), { color: p.metal, mat: MAT.metalDark, y: shY - 0.34, rx: Math.PI / 2 });
    // The suspended heart, floating clear inside the armature.
    P.add(sphere(0.46, 12, 9), { color: x.color, mat: MAT.core, emissive: x.emis * 0.9, y: shY - 0.10 });
    P.add(ring(0.54, 0.050, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: top - 0.24, rx: Math.PI / 2 });
    return top;
  },
};

// ---------------------------------------------------------------------------
// Crowns — the rotating head, authored around its own origin.
// Returns { muzzle:[x,y,z], top:number }.
// ---------------------------------------------------------------------------
const CROWN = {
  fire(H, x) {
    const p = x.pal, k = x.mass;
    H.add(lathe([[0.16, -0.32], [0.62, -0.24], [0.84, 0.10], [0.90, 0.34], [0.80, 0.34], [0.72, 0.02], [0.52, -0.14], [0.14, -0.20]], 12),
      { color: p.metal, mat: MAT.metalDark, s: k });
    // One extra subdivision: at 20 facets the facing-weighted emissive read
    // as a handful of broken plates rather than as a molten coal.
    H.add(rock(0.38 * k, 3, 0.30, 1), { color: x.color, mat: MAT.core, emissive: x.emis * 2.1, y: 0.06 * k });
    for (let i = 0; i < 5; i++) {
      const ea = i * 1.257 + 0.4;
      H.add(rock(0.10 * k, 41 + i), { color: x.accent, mat: MAT.core, emissive: x.emis * 2.4,
        x: Math.cos(ea) * 0.42 * k, z: Math.sin(ea) * 0.42 * k, y: (0.22 + (i % 3) * 0.12) * k });
    }
    const n = 4 + x.level;
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + 0.3;
      const bh = (1.05 + x.rand() * 1.15) * k;
      H.add(shard(0.115 * k, bh, 4), {
        color: i === 0 ? x.accent : p.metal, mat: i === 0 ? MAT.core : MAT.metalDark,
        emissive: i === 0 ? x.emis * 0.9 : 0,
        x: Math.cos(a) * 0.68 * k, z: Math.sin(a) * 0.68 * k,
        y: (0.20 + bh * 0.40), ry: a, rz: -0.20 - x.rand() * 0.26,
      });
    }
    return { muzzle: [0, 0.28 * k, 0.88 * k], top: 1.5 * k };
  },
  water(H, x) {
    const p = x.pal, k = x.mass;
    H.add(lathe([[0.14, -0.36], [0.60, -0.28], [0.74, -0.02], [0.66, 0.06], [0.52, -0.12], [0.12, -0.24]], 16),
      { color: p.stone, mat: MAT.stoneSmooth, s: k });
    H.add(sphere(0.40 * k, 18, 14), { color: x.color, mat: MAT.core, emissive: x.emis * 1.2, y: 0.10 * k });
    // Breaking wave crest arcing over the orb.
    H.add(ring(0.78 * k, 0.115 * k, Math.PI * 1.30, 6, 26), { color: p.trim, mat: MAT.metal, y: 0.34 * k, rx: 0.52, rz: 0.22 });
    H.add(ring(0.84 * k, 0.05 * k, TAU, 5, 16), { color: p.stone2, mat: MAT.stoneSmooth, y: 0.14 * k, rx: Math.PI / 2 - 0.45 });
    H.add(ring(0.92 * k, 0.042 * k, TAU, 5, 16), { color: p.stone2, mat: MAT.stoneSmooth, y: 0.14 * k, rx: Math.PI / 2 + 0.3, ry: 1.1 });
    return { muzzle: [0, 0.18 * k, 0.94 * k], top: 1.15 * k };
  },
  nature(H, x) {
    const p = x.pal, k = x.mass;
    H.add(lathe([[0.36, -0.4], [0.46, -0.16], [0.30, 0.04], [0, 0.06]], 12), { color: p.stone2, mat: MAT.wood, s: k });
    const prim = 3 + (x.level > 1 ? 1 : 0);
    for (let i = 0; i < prim; i++) {
      const a = i / prim * TAU + 0.5;
      const tip = [Math.cos(a) * 0.62 * k, 0.72 * k, Math.sin(a) * 0.62 * k];
      H.add(limb([0, -0.1, 0], tip, 0.13 * k, 0.06 * k, 5), { color: p.stone2, mat: MAT.wood });
      for (let j = 0; j < 2; j++) {
        const a2 = a + (j ? 0.7 : -0.7);
        const tip2 = [tip[0] + Math.cos(a2) * 0.38 * k, tip[1] + 0.34 * k, tip[2] + Math.sin(a2) * 0.38 * k];
        H.add(limb(tip, tip2, 0.06 * k, 0.028 * k, 4), { color: p.stone2, mat: MAT.wood });
        H.add(rock(0.30 * k, 51 + i * 3 + j, 0.5), {
          color: j ? 0x24401f : 0x2e5226, mat: MAT.wood, emissive: 0,
          x: tip2[0], y: tip2[1] + 0.05, z: tip2[2], sy: 0.34, ry: i + j,
        });
      }
    }
    H.add(sphere(0.21 * k, 12, 9), { color: x.color, mat: MAT.core, emissive: x.emis * 1.9, y: 0.10 * k, sy: 1.35 });
    return { muzzle: [0, 0.32 * k, 0.72 * k], top: 1.2 * k };
  },
  earth(H, x) {
    const p = x.pal, k = x.mass;
    // A SQUAT DRUM TURRET — the exact profile the blind critics praised in the
    // reference and could not find in ours. Wider than it is tall, banded, with
    // a heavy oversailing brim so it casts its own shadow onto the shaft.
    // NB these are RADII. The version that shipped this file for ten minutes
    // reused the numbers from the bevelBox turret they replaced, where they
    // were full WIDTHS — a 1.86 became a 3.72-diameter drum on a tile that is
    // 4.0 units across, and the brim overhung both neighbours by 1.6 units.
    H.add(prism(0.86 * k, 1.00 * k, 0.74 * k, 8), { color: p.stone2, mat: MAT.stoneCut, y: 0.06 * k });
    H.add(lathe([[0.86, 0], [1.14, 0.16], [1.14, 0.30], [0.86, 0.30], [0.84, 0.06]], 16),
      { color: p.metal, mat: MAT.metal, y: 0.42 * k, s: k });
    H.add(prism(0.68 * k, 0.82 * k, 0.30 * k, 8), { color: p.stone, mat: MAT.stoneCut, y: 0.88 * k, ry: 0.4 });
    H.add(prism(1.20 * k, 1.20 * k, 0.16 * k, 8), { color: p.trim, mat: MAT.metal, y: -0.40 * k });
    // The core burns in the slot between drum and cap.
    H.add(prism(0.78 * k, 0.78 * k, 0.14 * k, 8), { color: x.color, mat: MAT.core, emissive: x.emis * 1.8, y: 0.70 * k });
    // Stub barrels poking through the drum wall, not perched on top of it.
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + 0.4;
      const g = prism(0.17 * k, 0.24 * k, 0.86 * k, 8);
      g.rotateX(Math.PI / 2);
      H.add(g, { color: 0x2f2b26, mat: MAT.metal, x: Math.cos(a) * 0.92 * k, z: Math.sin(a) * 0.92 * k, y: 0.12 * k, ry: a - Math.PI / 2 });
    }
    return { muzzle: [0, 0.14 * k, 1.32 * k], top: 1.06 * k };
  },
  light(H, x) {
    const p = x.pal, k = x.mass;
    H.add(prism(0.16, 0.34, 0.34, 8), { color: p.stone, mat: MAT.stoneCut, y: -0.30 * k, s: k });
    // Light's identity is a NEEDLE: the tallest, thinnest, most precisely
    // radial outline on the board. The crystal is narrowed and the gold finial
    // roughly doubled, so the profile terminates in a point rather than a bead.
    H.add(shard(0.34 * k, 1.05 * k, 6, 0.42), { color: x.color, mat: MAT.crystal, emissive: x.emis * 0.72, y: 0.36 * k });
    H.add(shard(0.068 * k, 1.10 * k, 6, 0.24), { color: p.trim, mat: MAT.gold, y: 1.30 * k });
    H.add(ring(0.74 * k, 0.032 * k, TAU, 5, 16), { color: p.trim, mat: MAT.gold, y: 0.26 * k, rx: Math.PI / 2 });
    H.add(ring(0.62 * k, 0.028 * k, TAU, 5, 16), { color: p.trim, mat: MAT.gold, y: 0.26 * k, rz: 0.3 });
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      H.add(taperBox(0.05, 0.03, 0.30 * k, 0.05, 0.03), {
        color: p.trim, mat: MAT.gold, x: Math.cos(a) * 0.70 * k, z: Math.sin(a) * 0.70 * k, y: 0.26 * k, ry: a, rz: Math.PI / 2,
      });
    }
    return { muzzle: [0, 0.30 * k, 0.80 * k], top: 1.72 * k };
  },
  dark(H, x) {
    const p = x.pal, k = x.mass;
    H.add(sphere(0.46 * k, 14, 10), { color: 0x0d0a12, mat: MAT.crystal, y: 0.06 });
    H.add(sphere(0.34 * k, 12, 8), { color: x.color, mat: MAT.core, emissive: x.emis * 1.1, y: 0.06 });
    const n = 7 + x.level;
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + x.rand() * 0.4;
      const pitch = -0.8 + x.rand() * 2.0;
      const len = (0.95 + x.rand() * 1.05) * k;
      const dir = new THREE.Vector3(Math.cos(a) * Math.cos(pitch), Math.sin(pitch), Math.sin(a) * Math.cos(pitch));
      const g = shard(0.075 * k, len, 4);
      g.translate(0, len * 0.42, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      g.applyQuaternion(q);
      g.translate(0, 0.06, 0);
      H.add(g, { color: p.metal, mat: MAT.metalDark });
    }
    H.add(ring(0.86 * k, 0.045 * k, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: -0.40 * k, rx: Math.PI / 2 + 0.22 });
    return { muzzle: [0, 0.02, 0.86 * k], top: 1.35 * k };
  },
};

// ---------------------------------------------------------------------------
// Figurative dual crowns — these override the parent-B crown entirely.
// ---------------------------------------------------------------------------
const SIGNATURE = {
  /** Darkness + Earth. Long-barrelled siege artillery. */
  howitzer(H, x) {
    const p = PAL.earth, k = x.mass;
    H.add(bevelBox(1.12 * k, 0.36 * k, 1.30 * k, 0.05), { color: p.metal, mat: MAT.metal, y: -0.18 });
    for (const s of [-1, 1]) {
      H.add(bevelBox(0.16 * k, 0.62 * k, 0.62 * k, 0.04), { color: p.metal, mat: MAT.metal, x: s * 0.48 * k, y: 0.18 * k });
    }
    const bl = 2.05 * k;
    const g = prism(0.155 * k, 0.235 * k, bl, 9);
    g.rotateX(Math.PI / 2);
    H.add(g, { color: 0x2a2622, mat: MAT.metal, y: 0.30 * k, z: bl * 0.42, rx: -0.30 });
    H.add(ring(0.24 * k, 0.055 * k, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: 0.30 * k + Math.sin(0.30) * bl * 0.86, z: bl * 0.83, rx: -0.30 });
    H.add(ring(0.28 * k, 0.05 * k, TAU, 5, 16), { color: p.trim, mat: MAT.metal, y: 0.30 * k + 0.10, z: bl * 0.18, rx: -0.30 });
    H.add(prism(0.30 * k, 0.34 * k, 0.34 * k, 8), { color: PAL.dark.trim, mat: MAT.core, emissive: x.emis * 1.5, y: 0.24 * k, z: -0.34 * k });
    const my = 0.30 * k + Math.sin(0.30) * bl * 0.86;
    return { muzzle: [0, my, bl * 0.88], top: 1.0 * k, pitch: true };
  },

  /** Fire + Earth. A forge: anvil, floating hammer, glowing slot. */
  blacksmith(H, x) {
    const p = PAL.earth, k = x.mass;
    H.add(bevelBox(1.40 * k, 0.46 * k, 1.10 * k, 0.05), { color: p.stone2, mat: MAT.stoneCut, y: -0.24 * k });
    // anvil: waist + body + horn
    H.add(taperBox(0.56, 0.34, 0.34 * k, 0.5, 0.34), { color: 0x33302c, mat: MAT.metal, y: 0.06 * k, s: k });
    H.add(bevelBox(1.16 * k, 0.26 * k, 0.52 * k, 0.04), { color: 0x3a3733, mat: MAT.metal, y: 0.34 * k });
    const horn = prism(0.02 * k, 0.16 * k, 0.55 * k, 8);
    horn.rotateX(Math.PI / 2);
    H.add(horn, { color: 0x3a3733, mat: MAT.metal, y: 0.34 * k, z: 0.80 * k });
    // forge slot
    H.add(bevelBox(0.86 * k, 0.10 * k, 0.34 * k, 0.02), { color: PAL.fire.trim, mat: MAT.core, emissive: x.emis * 2.0, y: 0.49 * k });
    H.add(bevelBox(0.5 * k, 0.14 * k, 0.5 * k, 0.03), { color: x.color, mat: MAT.core, emissive: x.emis * 1.4, y: -0.44 * k });
    return { muzzle: [0, 0.5 * k, 0.9 * k], top: 0.8 * k };
  },

  /** Earth + Light. A nucleus in orbital shells. */
  atom(H, x) {
    const k = x.mass;
    H.add(sphere(0.38 * k, 16, 12), { color: x.color, mat: MAT.core, emissive: x.emis * 2.0, y: 0.10 });
    H.add(sphere(0.20 * k, 10, 8), { color: PAL.earth.trim, mat: MAT.core, emissive: x.emis * 1.0, y: 0.10, x: 0.22 * k });
    for (let i = 0; i < 3; i++) {
      H.add(ring(0.86 * k, 0.030 * k, TAU, 5, 16), {
        color: PAL.light.trim, mat: MAT.gold, y: 0.10, rx: Math.PI / 2 + i * 0.9, ry: i * 1.1, rz: i * 0.6,
      });
    }
    H.add(prism(0.5 * k, 0.62 * k, 0.20 * k, 8), { color: PAL.earth.metal, mat: MAT.metal, y: -0.52 * k });
    return { muzzle: [0, 0.10, 0.92 * k], top: 1.0 * k };
  },

  /** Nature + Earth. A fungal growth: broad cap, gills, satellite caps. */
  mushroom(H, x) {
    const k = x.mass;
    H.add(lathe([[0, 0.62], [0.42, 0.56], [0.86, 0.34], [1.10, 0.02], [1.06, -0.04], [0.70, 0.14], [0.30, 0.26], [0, 0.28]], 12),
      { color: x.color, mat: MAT.stoneSmooth, s: k });
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * TAU;
      H.add(taperBox(0.05, 0.03, 0.06 * k, 0.62 * k, 0.30 * k), {
        color: x.accent, mat: MAT.core, emissive: x.emis * 0.55,
        x: Math.cos(a) * 0.55 * k, z: Math.sin(a) * 0.55 * k, y: 0.06 * k, ry: -a,
      });
    }
    H.add(prism(0.22 * k, 0.30 * k, 0.70 * k, 9), { color: PAL.nature.stone2, mat: MAT.wood, y: -0.36 * k });
    for (let i = 0; i < 3; i++) {
      const a = i * 2.09 + 0.4;
      H.add(lathe([[0, 0.24], [0.20, 0.20], [0.36, 0.02], [0, 0.02]], 12), {
        color: x.color, mat: MAT.stoneSmooth, s: 0.8 * k,
        x: Math.cos(a) * 0.9 * k, z: Math.sin(a) * 0.9 * k, y: -0.5 * k, rz: (i - 1) * 0.2,
      });
    }
    return { muzzle: [0, 0.30 * k, 0.90 * k], top: 0.8 * k };
  },

  /** Nature + Water. A stone wellhead with a hanging bucket. */
  well(H, x) {
    const p = PAL.water, k = x.mass;
    H.add(lathe([[0.60, -0.42], [0.86, -0.40], [0.90, 0.10], [0.78, 0.14], [0.74, -0.34], [0.58, -0.36]], 16),
      { color: p.stone, mat: MAT.stoneCut, s: k });
    H.add(lathe([[0, -0.16], [0.74, -0.18], [0.74, -0.10], [0, -0.08]], 16),
      { color: x.color, mat: MAT.core, emissive: x.emis * 1.5, s: k });
    for (const s of [-1, 1]) {
      H.add(taperBox(0.13, 0.10, 1.0 * k, 0.13, 0.10), { color: PAL.nature.stone2, mat: MAT.wood, x: s * 0.66 * k, y: 0.62 * k });
    }
    const beam = taperBox(0.11, 0.11, 1.55 * k, 0.13, 0.13);
    beam.rotateZ(Math.PI / 2);
    H.add(beam, { color: PAL.nature.stone2, mat: MAT.wood, y: 1.14 * k });
    H.add(taperBox(0.02, 0.02, 0.42 * k, 0.02, 0.02), { color: 0x2a2724, mat: MAT.metal, y: 0.90 * k });
    H.add(prism(0.20 * k, 0.16 * k, 0.28 * k, 10), { color: PAL.nature.trim, mat: MAT.wood, y: 0.60 * k });
    return { muzzle: [0, -0.10 * k, 0.88 * k], top: 1.35 * k };
  },

  /** Water + Earth. A cracked vent erupting upward. */
  geyser(H, x) {
    const p = PAL.earth, k = x.mass;
    H.add(lathe([[0, -0.42], [1.02, -0.44], [0.72, 0.02], [0.50, 0.26], [0.38, 0.28], [0.56, 0.0], [0.86, -0.34], [0, -0.34]], 15),
      { color: p.stone, mat: MAT.stoneCut, s: k });
    H.add(lathe([[0, 0.20], [0.34, 0.24], [0.20, 0.9], [0.10, 1.35], [0, 1.4]], 16),
      { color: x.color, mat: MAT.core, emissive: x.emis * 1.6, s: k });
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU + 0.6;
      H.add(prism(0.09 * k, 0.12 * k, 0.7 * k, 8), {
        color: p.metal, mat: MAT.metal, x: Math.cos(a) * 0.72 * k, z: Math.sin(a) * 0.72 * k, y: 0.02, rz: (i % 2 ? 0.3 : -0.3), ry: a,
      });
    }
    return { muzzle: [0, 0.5 * k, 0.72 * k], top: 1.45 * k };
  },

  /** Light + Darkness. An unstable illusion: the crown, plus two ghosts of it. */
  trickery(H, x) {
    const k = x.mass;
    // Only the real crystal keeps its band; giving the two ghosts one as well
    // produced three overlapping wire hoops that read as spaghetti.
    const one = (dx, dy, rot, col, mat, em, s, band) => {
      H.add(shard(0.34 * s, 0.95 * s, 6, 0.42), { color: col, mat, emissive: em, y: 0.24 * k + dy, x: dx, ry: rot, rz: rot * 0.3 });
      if (band) H.add(ring(0.62 * s, 0.028 * s, TAU, 4, 16), { color: PAL.light.trim, mat: MAT.gold, y: 0.24 * k + dy, x: dx, rx: Math.PI / 2 + rot * 0.4 });
    };
    one(0, 0, 0, x.color, MAT.crystal, x.emis * 1.4, k, true);
    one(-0.52 * k, 0.16 * k, 0.7, PAL.dark.trim, MAT.core, x.emis * 0.35, 0.72 * k, false);
    one(0.50 * k, -0.10 * k, -0.9, x.accent, MAT.core, x.emis * 0.30, 0.66 * k, false);
    H.add(prism(0.44 * k, 0.56 * k, 0.18 * k, 6), { color: PAL.dark.metal, mat: MAT.metal, y: -0.44 * k });
    return { muzzle: [0, 0.24 * k, 0.78 * k], top: 1.0 * k };
  },
};

// ---------------------------------------------------------------------------
// The collar that joins the two halves of a dual tower.
// ---------------------------------------------------------------------------
function dualCollar(C, x, a, b) {
  const k = x.mass;
  C.add(prism(0.62 * k, 0.78 * k, 0.44 * k, 6), { color: 0x26221d, mat: MAT.metal });
  C.add(ring(0.70 * k, 0.030 * k, TAU, 4, 18), { color: ELEMENTS[a].color, mat: MAT.core, emissive: 0.52, y: 0.12 * k, rx: Math.PI / 2 });
  C.add(ring(0.79 * k, 0.026 * k, TAU, 4, 18), { color: ELEMENTS[b].color, mat: MAT.core, emissive: 0.52, y: -0.12 * k, rx: Math.PI / 2 });
  for (let i = 0; i < 6; i++) {
    const ang = i / 6 * TAU;
    C.add(bevelBox(0.12 * k, 0.16 * k, 0.10 * k, 0.02), {
      color: 0x8a7a5c, mat: MAT.gold, x: Math.cos(ang) * 0.70 * k, z: Math.sin(ang) * 0.70 * k, ry: ang,
    });
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   base: THREE.BufferGeometry, head: THREE.BufferGeometry, headY: number,
 *   collar: ?THREE.BufferGeometry, collarY: number,
 *   halo: ?THREE.BufferGeometry, haloY: number,
 *   shards: Array, muzzle: number[], height: number,
 *   glowRadius: number, glowIntensity: number, runeY: number, pitch: boolean,
 * }}
 */
/**
 * The foundation block — cut stone, and nothing else.
 *
 * This is the only thing on the board with NO emissive, no crown, no collar, no
 * halo, no orbiting shards, no floating rune and no ground glow. Every one of
 * those cues is a promise that the object shoots, and withholding all of them
 * at once is the whole design: with twenty blocks on a board the player must be
 * able to tell walls from weapons in a thumbnail, from any angle, with the
 * emissives blown out by bloom. Tinting an armed silhouette grey would not
 * survive any of those conditions — the silhouette itself has to differ.
 *
 * Height is ~1.85 against a tower's ~6.8 head, so a maze built out of these is
 * a wall you see OVER: the creeps threading through it stay legible, which is
 * the one thing a mazing piece must not break.
 *
 * Kept deliberately cheap — five parts, one shared geometry for every
 * foundation on the board (TowerBatch caches specs by `key:level`) — because
 * mazing means the player will place dozens of them.
 */
function buildFoundationSpec(def) {
  // Neutral blue-grey granite. Held well off every element's hue AND off the
  // flagstone tone, so it neither joins a family nor disappears into the floor.
  const p = { stone: 0x6b7280, stone2: 0x9099a8, trim: 0xb9c0cc };
  const B = new Parts(0).setElem(def.color);

  // Three courses of an actual retaining wall — footing slab, battered course,
  // chamfered capstone — so it reads as built masonry rather than as rubble or
  // as a placeholder cube. The 3.94 footing against a 4.0 tile leaves a 0.06
  // joint, so foundations placed side by side read as one continuous wall with
  // mortar lines instead of as separate blocks.
  B.add(bevelBox(3.94, 0.30, 3.94, 0.09), { color: p.stone, mat: MAT.stoneCut, y: 0.15 });
  B.add(taperBox(3.66, 3.18, 1.12, 3.66, 3.18), { color: p.stone2, mat: MAT.stoneCut, y: 0.86 });
  // The capstone is deliberately OFF-CENTRE and slightly rotated. Together with
  // the buttress below this is what makes the block asymmetric, which is what
  // makes the per-instance quarter-turn in TowerBatch produce four visibly
  // different blocks out of one cached geometry. A 4-fold symmetric block looks
  // identical under every rotation, and the first version of this piece was
  // exactly that: a row of them read as a tiled texture, because it was one.
  B.add(bevelBox(3.30, 0.28, 3.52, 0.11), {
    color: p.stone, mat: MAT.stoneCut, y: 1.56, x: 0.16, z: -0.10, ry: 0.045,
  });

  // One corner buttress, clearly proud of the battered face so it catches the
  // key light and throws a shadow down the side. The previous pair sat at 1.52
  // with radius 0.5 against a 1.83 half-width — protruding by 0.19, which is
  // less than the bevel and invisible at gameplay distance.
  B.add(prism(0.46, 0.62, 1.34, 6), {
    color: p.stone2, mat: MAT.stoneCut, x: 1.66, z: 1.66, y: 0.67, ry: Math.PI * 0.25,
  });
  // A broken-off corner on the far side: a low wedge where the capstone stops
  // short. Reads as masonry that has taken a hit, and breaks the outline.
  B.add(bevelBox(1.18, 0.20, 1.18, 0.05), {
    color: p.stone, mat: MAT.stoneCut, x: -1.30, z: -1.24, y: 1.48, ry: 0.34,
  });

  const base = B.build();
  if (base) erode(base, 0.022, 41, 1.9);

  return {
    base,
    // No armament, at every level of the pipeline. TowerBatch skips a null
    // geometry (#addGeo returns -1, #addInstance short-circuits), so these cost
    // no instances rather than costing invisible ones.
    head: null, headY: 1.85,
    collar: null, collarY: 0,
    halo: null, haloY: 0,
    shards: [],
    muzzle: [0, 0, 0],
    pitch: false,
    height: 1.85,
    // Read by TowerBatch to drop this tower from the additive glow and rune
    // layers entirely, and to keep it from ever claiming a real point light.
    // Zeroing the intensities instead would still emit the geometry and still
    // pay the additive fill over a 4-unit patch per block, for nothing visible.
    inert: true,
    glowRadius: 0, glowIntensity: 0,
    runeY: 0,
  };
}

export function buildTowerSpec(def, level) {
  // Must come before anything reads PAL[def.element]: the foundation owns no
  // element, so the palette lookups below would resolve undefined and throw.
  if (def.kind === 'inert') return buildFoundationSpec(def);

  // A primal reuses its element's PLINTH/BODY/CROWN unchanged — no new family
  // authoring. What separates it is mass, palette, a second halo, the obelisk
  // ring and the ground pool; see each site below.
  const primal = def.kind === 'primal';
  const dual = def.kind === 'dual';
  const parts = dual ? [...def.parts].sort((p, q) => HEAVY[q] - HEAVY[p]) : [def.element, def.element];
  const baseEl = parts[0];
  const crownEl = parts[1];

  const rand = rng(hashStr(`${def.key}#${level}`));
  const color = def.color;
  const accent = def.accent;
  // Emissive budget. This is the *geometry* half; the other half is the
  // per-instance pulse in TowerManager (IDLE_PULSE / FIRE_PULSE), and the two
  // multiply. Round 2 cut both at once and the towers went dark exactly as the
  // board got 2.4x brighter. The geometry term is left where round 2 put it and
  // the presence is restored on the pulse instead, because that is the term the
  // firing spike also rides — so raising it lifts idle AND keeps the 10x flash
  // headroom, which raising the geometry term alone would not.
  const emis = (ELEMENTS[baseEl]?.emissive ?? 2.6) * (0.34 + level * 0.16)
    * (primal ? 1.45 : dual ? 1.15 : 1);

  // Round 3 scale. Art Bible §5 asks 2.5-3.5x the 2x2 footprint (4 world
  // units); a blind Art Director measured the round-2 towers at ~1x and we lost
  // the comparison on it. Shafts are ~3x taller, plinths ~1.25x wider, crowns
  // ~1.27x bigger, landing pure L0 at ~2.2x and L2 at ~2.7x footprint width.
  // Crowns are deliberately NOT shrunk with the shafts. With the shaft cut to
  // reference proportions the crown is now ~30-35% of the whole tower, which is
  // what an Element TD 2 tower actually is — a big characterful head on a short
  // body. Shrinking both would have produced a small version of the same
  // unreadable object.
  //
  // MASS, NOT HEIGHT, is the primal lever. 1.85 puts the crown ~42% larger than
  // a fusion's and ~30% larger than a level-2 pure's; the shaft gains only 12%
  // (hMul below), which keeps the worst case — Primal Light, the tallest family
  // — at 7.95 units, inside the band the board already occupies. Raising the
  // shaft instead would walk straight back into the occlusion bug the SHAFT
  // docblock documents.
  const mass = (primal ? 1.85 : dual ? 1.42 : 1.30) + level * 0.11;

  const x = {
    pal: primal ? PAL_PRIMAL[baseEl] : PAL[baseEl],
    palB: primal ? PAL_PRIMAL[crownEl] : PAL[crownEl],
    color, accent, emis, level, mass, rand, dual, primal,
  };

  // The crown carries the family read as much as the shaft does, so it is
  // scaled to the family too: a squat drum on earth wants to be broad, a needle
  // on light wants to be slim. Without this every element ended in a head of
  // the same size, which re-imposed the uniformity the shafts had just escaped.
  const CROWNK = { fire: 1.05, water: 1.00, nature: 1.00, earth: 1.20, light: 0.78, dark: 1.12 };

  // --- heights ------------------------------------------------------------
  const B = new Parts(0).setElem(color);
  const plinthTop = PLINTH[baseEl](B, x);
  const shp = SHAPE[baseEl];
  footing(B, x, shp.foot);
  if (primal) primalRing(B, x);
  // Round 4 set a flat 6.35 for every element, which is the single line most
  // responsible for "twenty near-identical chess pieces": six different profiles
  // forced into one bounding box read as one profile with six textures. The
  // per-family multiplier is the primary silhouette lever.
  //
  // Round 7 cut the CONSTANT (not the spread) by 2.6x — see the SHAFT docblock.
  // At the old value every tower was tall enough to hide the base of the tower
  // behind it, so the board rendered as one merged mass and no profile could
  // reach the frame.
  const hMul = shp.h * (primal ? 1.12 : 1);
  const bodyTop = plinthTop + (SHAFT + level * SHAFT_LEVEL) * hMul + (dual ? 0.35 : 0);
  BODY[baseEl](B, x, plinthTop, bodyTop);

  // --- collar (duals only) ------------------------------------------------
  let collar = null;
  let collarY = 0;
  let headY = bodyTop + 0.52 * mass;
  if (dual) {
    collarY = bodyTop + 0.24 * mass;
    const C = new Parts(collarY).setElem(color);
    dualCollar(C, x, parts[0], parts[1]);
    collar = C.build();
    headY = collarY + 0.62 * mass;
  }

  // --- crown --------------------------------------------------------------
  const H = new Parts(headY).setElem(color);
  const sig = dual ? SIGNATURE[def.key] : null;
  const crownCtx = {
    ...x,
    pal: primal ? PAL_PRIMAL[crownEl] : PAL[crownEl],
    mass: mass * (sig ? 1 : (CROWNK[crownEl] ?? 1)),
  };
  const info = sig ? sig(H, crownCtx) : CROWN[crownEl](H, crownCtx);

  // Duals that keep a parent crown get a hybrid accent from the base parent so
  // the fusion is not just "A below, B above".
  if (dual && !sig) {
    const k = mass;
    for (let i = 0; i < 3; i++) {
      const a = i * 2.09 + 0.9;
      H.add(shard(0.09 * k, 0.5 * k, 4), {
        color: ELEMENTS[baseEl].color, mat: MAT.core, emissive: emis * 0.8,
        x: Math.cos(a) * 0.72 * k, z: Math.sin(a) * 0.72 * k, y: -0.28 * k, ry: a, rz: 0.5,
      });
    }
  }

  // --- upgrade halo: an arcane orbital band, level >= 1 --------------------
  //
  // Round 1 built this as a thin torus in the XY plane plus a ring of radial
  // spikes laid out in the XZ plane — two different planes, so the teeth never
  // touched the band they were supposed to belong to, and each spike was a
  // 4-sided sliver that aliased into a cartwheel spoke at gameplay zoom.
  //
  // Now: one horizontal band with a section thick enough to hold a highlight,
  // and the light on it travels as tangential ARCS cut from the same torus.
  // A radial tooth reads as a gear cog; an arc reads as motion.
  //
  // Round 3: level 0 gets one too. It used to be the upgrade tell and nothing
  // else, which left a freshly built tower with zero secondary motion — a
  // static dark object, a straight gate-G6 fail on the most common thing on the
  // board. The tier read survives because the L0 band is smaller, thinner and
  // carries two arcs against level 2's five.
  let halo = null;
  let haloY = 0;
  {
    haloY = headY + info.top + 0.22;
    const R = new Parts(haloY).setElem(color);
    const rr = (0.60 + level * 0.11) * mass;
    // Level 0 gets NO continuous metal band. A full dark ring at that section
    // aliases into a thin unlit wire hoop at gameplay zoom — it photographed as
    // a wireframe artefact, not as a part. L0 therefore carries only the two
    // emissive arcs, which is also the clearer tier read.
    if (level >= 1) {
      R.add(ring(rr, 0.048, TAU, 4, 18), { color: 0x6b5c42, mat: MAT.metalDark, rx: Math.PI / 2 });
    }
    const dashes = 2 + level;
    for (let i = 0; i < dashes; i++) {
      const a = i / dashes * TAU;
      // Each arc tapers by sitting slightly proud of the band, so the leading
      // end catches the key light and the trailing end sinks back into it.
      R.add(ring(rr, 0.072 - i % 2 * 0.012, 0.34 + level * 0.10, 4, 6), {
        color: i % 2 ? color : accent, mat: MAT.core, emissive: emis * 1.05,
        rx: Math.PI / 2, ry: -a,
      });
    }
    if (primal) {
      // A second, larger, counter-read band. Two concentric orbital rings is a
      // silhouette nothing else on the board has, and it sits at the very top of
      // the tower — the one zone the gameplay camera never occludes.
      const rr2 = rr * 1.55;
      R.add(ring(rr2, 0.038, TAU, 4, 22), { color: 0x0e0b12, mat: MAT.metalDark, rx: Math.PI / 2 });
      for (let i = 0; i < 4; i++) {
        R.add(ring(rr2, 0.062, 0.26, 4, 6), {
          color: i % 2 ? accent : color, mat: MAT.core, emissive: emis * 1.25,
          rx: Math.PI / 2, ry: -(i / 4) * TAU + 0.4,
        });
      }
    }
    halo = R.build();
  }

  // --- orbiting shards ----------------------------------------------------
  const shards = [];
  // Fewer, fatter. A 4-sided bipyramid 0.085 wide and 0.30 tall is a sliver:
  // seen edge-on it collapses to a flat hard-edged triangle. Six sides and a
  // wider waist give it thickness from every angle, and cutting the count
  // stops seven of them turning a level-2 dual into confetti.
  // At least one at every level, for the same gate-G6 reason as the halo.
  // Seven on a primal — two past the cap every other tower obeys, which is the
  // point: the orbit is visibly denser and the loop below already handles any
  // count.
  const nShards = primal ? 7 : Math.min(5, 1 + (dual ? 1 : 0) + level * 2);
  for (let i = 0; i < nShards; i++) {
    const S = new Parts(headY).setElem(color);
    const big = i % 2 === 0;
    S.add(shard(0.105 + (big ? 0.035 : 0), 0.26 + (big ? 0.10 : 0), 6, 0.44), {
      color: big ? color : accent, mat: MAT.core, emissive: emis * 1.0,
    });
    shards.push({
      geo: S.build(),
      radius: (1.05 + (i % 3) * 0.18) * mass,
      y: headY + 0.1 + Math.sin(i * 2.1) * 0.42,
      speed: (i % 2 ? -1 : 1) * (0.55 + (i % 3) * 0.22),
      phase: i / Math.max(1, nShards) * TAU,
      bob: 0.10 + (i % 2) * 0.06,
      spin: 1.6 + (i % 3) * 0.9,
    });
  }

  return {
    base: B.build(),
    head: H.build(),
    headY,
    collar, collarY,
    halo, haloY,
    shards,
    muzzle: info.muzzle,
    pitch: !!info.pitch,
    height: headY + info.top,
    // Coloured light spill. The blind Art Director's single sharpest note was
    // "twenty glowing cores and the floor beneath them is uniformly grey"; the
    // decal was the mechanism and it was far too small and far too weak to be
    // seen on a floor that had just got 2.4x brighter. A 4.5-unit radius spills
    // past the 2x2 footprint and overlaps its neighbours, which is what turns
    // isolated dots into pools between towers.
    // The primal term is the largest single cue in this function. 6.2 units at
    // 0.46 intensity is ~1.5x the radius and ~1.8x the intensity of anything
    // else on the board and spills onto four neighbouring tiles — and per the
    // finding above, the pool is the one element cue that reads when the tower
    // itself is occluded.
    glowRadius: 4.05 + level * 0.28 + (dual ? 0.45 : 0) + (primal ? 2.15 : 0),
    // NB: every glowIntensity in rounds 1-2 was tuned against a layer that was
    // back-face culled and therefore never drawn (see createGroundGlowMaterial).
    // These are the first values ever chosen by looking at the thing. Roughly
    // 0.17x of the round-3 first guess, which blew the whole board to white.
    // Round 4: the terrain agent's new flagstones are far brighter than the
    // floor these were measured against, and an additive pool that reads on a
    // dark floor vanishes on a light one. In the reference frames the pool is
    // the single strongest element cue — you can name every tower's element
    // from the ground alone, without seeing the tower.
    glowIntensity: 0.235 + level * 0.065 + (dual ? 0.035 : 0) + (primal ? 0.22 : 0),
    runeY: headY + info.top + (level >= 1 ? 0.95 : 0.75),
  };
}
