import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  ARENA_HW, ARENA_HH, SHELF, arenaEdgeDist, surroundHeight, surroundNormal,
  makeSurroundMaterial, roadQuery, ROAD_PATH, ROAD_HW,
} from './Surround.js';

/* ==================================================================
 * THE SURROUND — ROUND 5. AUTHORED, NOT SCATTERED.
 *
 * "Backdrop" is a misnomer kept for API stability; this builds the landscape
 * the arena is cut into.
 *
 * ---- why this file was rewritten again ---------------------------------
 *
 * Round 4 satisfied law 1 — ground reached every frame edge — and then lost a
 * blind A/B 3-for-3 at 96 / 92 / 96 %, with all three critics independently
 * naming the same defect:
 *
 *   "The play area is a floating slab, not a place."
 *   "the world does not continue anywhere"
 *   "flat black-blue ground plus a dozen identical low-poly rock chunks"
 *
 * The mechanism, now law 5 in the Art Bible: round 4's props were distributed
 * by `clusterCentres()` — dart-thrown centres, members on a radial falloff,
 * per-instance yaw and scale. That is a very good density function, and a
 * density function produces EVEN DENSITY BY CONSTRUCTION. "Even density
 * everywhere" is exactly what the word *undifferentiated* means. There is no
 * parameter of a distribution whose value is "landmark", because a landmark is
 * a place that differs from the places around it, and a stationary process has
 * no such place. You cannot tune scatter into composition.
 *
 * So every mass in this file is at a hand-chosen coordinate and has a name.
 * The scatter that remains is strictly LOCAL — members within a named cluster,
 * scree at the foot of a named cliff, rubble in a named breach. Between the
 * named things the ground is deliberately EMPTY. Uneven density is the
 * deliverable, not a side effect.
 *
 * ---- the composition ---------------------------------------------------
 *
 * Plan view, against the measured visible ground quad (see Surround.js):
 *
 *      TL(-58,-60)              TM(8,-50)                 TR(75,-39)
 *        .  west hill      north escarpment          east cliff  .
 *        .   SETTLEMENT      ~~ RAMPART ~~~ [GATEHOUSE] /shelves .
 *        .   (lit windows)   pines break     road       scree    .
 *        .                     the top edge    |                 .
 *   ML(-47,-10)  WATER BASIN        [ B O A R D ]      ROAD      MR(48,5)
 *        .        west terraces                          |       .
 *        .  fg rocks              fg spruce stand    fg spruce   .
 *      BL(-41,18)               BM(-4,24)                BR(33,30)
 *
 *   1  north rampart      crenellated, INTERRUPTED by a collapse and by a
 *                         tree stand (law 6), running off the left edge
 *   2  gatehouse          two towers straddling the road at (26,-30)
 *   3  the road           ENTERS the top edge, EXITS the bottom edge. Both
 *                         ends cropped by frame. This is the single element
 *                         that asserts the world has somewhere else to be.
 *   4  east cliff         terraced rock shelves + scree, cropped by the
 *                         top-right corner
 *   5  the settlement     11 houses with LIT WINDOWS on the west hill and
 *                         two more on the basin shore
 *   6  the water basin    dug hollow, mid-left, cropped by the left edge
 *   7  west terraces      low retaining walls stepping up the left edge
 *   8  four tree stands   two mid-ground (one breaking the top edge), two
 *                         FOREGROUND, cropped by the bottom edge, overlapping
 *                         the board's near corners  <-- law 2, the depth cue
 *                         all three critics named and we still did not have
 *
 * Draw calls [in brackets], all instanced or merged:
 *   surround ground [1]  boulder [1]  outcrop [1]  spire [1]  growth [1]
 *   ruin [1]  scrub [1]  conifer [1]  house [1]  window [1]  wall [1]
 *   slab [1]  road [1]  water [1]                            = 14
 *   + round 7: crate [1] barrel [1] fence [1] lamp [1]       = 18
 * The lamp posts' lanterns share the `window` instanced set, so a lit lamp
 * costs nothing. Verify against the capture, not against this comment
 * (PITFALLS 10a: a comment asserting a number is a rumour).
 * ================================================================== */

function makeRng(seed = 0xBADC0DE) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Strip to position+normal so variants merge and instance cleanly. */
function prep(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/**
 * prep() + a flat vertex colour used as a MULTIPLIER around 1.0.
 *
 * Lets one instanced mesh carry two or three materials' worth of albedo — a
 * conifer's trunk against its needles, a house's wall against its roof —
 * without spending a draw call on each. three multiplies `color` and
 * `instanceColor` into the same vColor, so per-instance tinting composes.
 *
 * MULTIPLIER, NOT COLOUR, and this is not a stylistic preference. The first
 * version passed absolute hexes (0x1b2f24 needles, 0x8c7355 walls) on top of a
 * material whose procedural albedo is already 0x1d3324 / 0x3d3428. Two dark
 * colours multiplied give 0.10 * 0.11 = 0.011: the entire foreground occluder
 * rendered as a black polygonal blob and the settlement as unlit rubble. It
 * measured as an 8-point drop in mean surround luminance. Components above 1.0
 * are legal and are how a trunk gets to be LIGHTER than the needles around it.
 */
function tinted(geo, rgb) {
  const g = prep(geo);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = rgb[0]; arr[i * 3 + 1] = rgb[1]; arr[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/* ------------------------------------------------------------------ */
/* Prop shapes. Low-poly and chosen for SILHOUETTE: at 40-90 units a prop  */
/* is 20-70px tall and only its outline survives.                          */
/* ------------------------------------------------------------------ */

/** Weather-rounded boulder. Icosahedron pushed around by two noise lobes. */
function boulder(rng) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const a = rng() * 9, b = rng() * 9, c = rng() * 9;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 0.74
      + 0.30 * Math.sin(v.x * 2.1 + a) * Math.cos(v.z * 1.7 + b)
      + 0.18 * Math.sin(v.y * 3.3 + c);
    v.multiplyScalar(n);
    v.y *= 0.62 + rng() * 0.18;          // boulders sit, they do not float
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.translate(0, 0.42, 0);
  return prep(g);                        // 80 tris
}

/** Fractured outcrop: a stack of tilted slabs shoving out of the ground. */
function outcrop(rng) {
  const parts = [];
  const n = 3 + Math.floor(rng() * 3);
  let y = 0, w = 1.0;
  for (let i = 0; i < n; i++) {
    const h = 0.34 + rng() * 0.46;
    const s = new THREE.BoxGeometry(w * (0.8 + rng() * 0.5), h, w * (0.6 + rng() * 0.6));
    s.rotateY(rng() * 3.1);
    s.rotateZ((rng() - 0.5) * 0.42);
    s.rotateX((rng() - 0.5) * 0.34);
    s.translate((rng() - 0.5) * w * 0.5, y + h * 0.5, (rng() - 0.5) * w * 0.5);
    parts.push(prep(s));
    y += h * (0.62 + rng() * 0.3);
    w *= 0.70 + rng() * 0.18;
  }
  return mergeGeometries(parts);         // ~60-90 tris
}

/** A leaning shard of rock. The one shape that reads at any distance. */
function spire(rng) {
  const seg = 5 + Math.floor(rng() * 3);
  const g = new THREE.CylinderGeometry(0.08 + rng() * 0.16, 0.42 + rng() * 0.3, 1, seg, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + 0.5;                     // 0 at base, 1 at tip
    const k = 1 + Math.sin(y * 5.5 + rng() * 0.2) * 0.11;
    p.setX(i, p.getX(i) * k + y * y * 0.24);       // lean, curving
    p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  g.translate(0, 0.5, 0);
  g.rotateZ((rng() - 0.5) * 0.3);
  return prep(g);                        // ~30 tris
}

/** Bare trunk with a few limbs. Reads as "something used to grow here". */
function deadGrowth(rng) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.045, 0.13, 1.0, 5, 3, true);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i) + 0.5;
    tp.setX(i, tp.getX(i) + Math.sin(y * 2.4) * 0.10);
    tp.setZ(i, tp.getZ(i) + Math.cos(y * 1.9) * 0.07);
  }
  trunk.computeVertexNormals();
  trunk.translate(0, 0.5, 0);
  parts.push(prep(trunk));
  const limbs = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < limbs; i++) {
    const y = 0.40 + rng() * 0.52;
    const len = 0.22 + rng() * 0.34;
    const l = new THREE.CylinderGeometry(0.012, 0.045, len, 3, 1, true);
    l.translate(0, len * 0.5, 0);
    l.rotateZ((rng() < 0.5 ? 1 : -1) * (0.7 + rng() * 0.6));
    l.rotateY(rng() * 6.28);
    l.translate(Math.sin(y * 2.4) * 0.10, y, Math.cos(y * 1.9) * 0.07);
    parts.push(prep(l));
  }
  return mergeGeometries(parts);         // ~60 tris
}

/** Fallen masonry: cut blocks, half sunk. Ties the wild ground to the arena. */
function ruinBlocks(rng) {
  const parts = [];
  const n = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const b = new THREE.BoxGeometry(
      0.5 + rng() * 0.9, 0.28 + rng() * 0.5, 0.4 + rng() * 0.7);
    b.rotateY(rng() * 3.1);
    b.rotateZ((rng() - 0.5) * 0.5);
    b.translate((rng() - 0.5) * 1.7, 0.10 + rng() * 0.42, (rng() - 0.5) * 1.7);
    parts.push(prep(b));
  }
  const w = new THREE.BoxGeometry(0.34, 0.9 + rng() * 1.1, 1.1 + rng() * 0.8);
  w.rotateY(rng() * 3.1);
  w.rotateZ((rng() - 0.5) * 0.12);
  w.translate((rng() - 0.5) * 1.2, 0.5, (rng() - 0.5) * 1.2);
  parts.push(prep(w));
  return mergeGeometries(parts);         // ~84 tris
}

/**
 * A clump of stiff blades.
 *
 * SIZED IN WORLD UNITS ON PURPOSE. The first version used h = 0.5..1.4 and an
 * instance scale that could reach 3.6x, i.e. blades five units tall and half
 * a unit wide. At this camera one world unit is ~1483/D pixels, so those were
 * 180px kites and the frame filled with pale confetti. A tuft has to top out
 * around ONE unit — roughly half a build cell — or it is not grass, it is a
 * banner. Material is DoubleSide, so one triangle per blade is enough.
 */
function tuft(rng) {
  const parts = [];
  const n = 5 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const h = 0.34 + rng() * 0.40;
    const g = new THREE.BufferGeometry();
    const a = (i / n) * 6.283 + rng() * 0.8;
    const lean = 0.10 + rng() * 0.20;
    const bx = Math.cos(a) * 0.07, bz = Math.sin(a) * 0.07;
    const tx = Math.cos(a) * lean * h, tz = Math.sin(a) * lean * h;
    const wdt = 0.022 + rng() * 0.016;
    const px = -Math.sin(a) * wdt, pz = Math.cos(a) * wdt;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      bx - px, 0, bz - pz,
      bx + px, 0, bz + pz,
      tx, h, tz,
    ]), 3));
    g.computeVertexNormals();
    parts.push(g);
  }
  return mergeGeometries(parts);         // 5-7 tris
}

/* ---------------- new shapes, round 5 ------------------------------ */

/**
 * A spruce. Unit height 1.0, so an instance scale IS its height in world
 * units — the foreground heroes are scaled 13-17 and the mid-ground stands
 * 5-9, and those numbers can be read straight off the placement tables.
 *
 * Built as stacked skirts with a jittered radius per rib rather than as cones,
 * because a smooth cone at 9 segments photographs as a party hat and the
 * silhouette is the entire point of a tree at this distance. Trunk and needles
 * carry different vertex colours so one draw call renders both.
 *
 * WINDING, derived not guessed (PITFALLS 2). Apex A=(0,h,0), ring points P0 at
 * angle a0 and P1 at a1 > a0:
 *   (P1-A) x (P0-A) = (h*r*da, r^2*da, 0)  at a0 = 0
 * i.e. +x (outward) and +y (up). So A -> P1 -> P0 faces out.
 */
function conifer(rng) {
  const parts = [];
  const TRUNK = 0.20;
  const tr = new THREE.CylinderGeometry(0.016, 0.036, TRUNK * 1.7, 5, 1, true);
  tr.translate(0, TRUNK * 0.85, 0);
  parts.push(tinted(tr, [1.9, 1.45, 0.95]));       // bare warm wood

  // 7 tiers x 11 ribs, not 5 x 9. The foreground stand is ~500px tall in
  // frame, and at 5x9 with a +-26% radius jitter each skirt was a handful of
  // 80px flat triangles: the occluder photographed as crumpled paper. The
  // silhouette needs enough ribs that its outline reads as ragged rather than
  // as faceted, and the jitter has to come DOWN as the count goes up.
  const tiers = 7;
  const seg = 11;
  for (let i = 0; i < tiers; i++) {
    const f = i / (tiers - 1);                       // 0 bottom, 1 top
    const y0 = TRUNK + f * (1.0 - TRUNK) * 0.84;
    const hgt = (1.0 - y0) * (0.40 + 0.22 * (1 - f));
    const rad = (0.245 - 0.180 * f) * (0.90 + rng() * 0.20);
    const pos = new Float32Array(seg * 9);
    for (let s = 0; s < seg; s++) {
      const a0 = (s / seg) * 6.28318 + rng() * 0.05;
      const a1 = ((s + 1) / seg) * 6.28318 + rng() * 0.05;
      const r0 = rad * (0.88 + rng() * 0.24);
      const r1 = rad * (0.88 + rng() * 0.24);
      const d0 = -rad * 0.22 * rng(), d1 = -rad * 0.22 * rng();   // droop
      const o = s * 9;
      pos[o] = 0; pos[o + 1] = y0 + hgt; pos[o + 2] = 0;
      pos[o + 3] = Math.cos(a1) * r1; pos[o + 4] = y0 + d1; pos[o + 5] = Math.sin(a1) * r1;
      pos[o + 6] = Math.cos(a0) * r0; pos[o + 7] = y0 + d0; pos[o + 8] = Math.sin(a0) * r0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    // Lower skirts sit in their own shade; the crown catches the key. Baking
    // that as vertex colour costs nothing and is the difference between a tree
    // and a green triangle. Spread 0.55 -> 1.17 so the tree has internal value
    // range even where the key does not reach it; the first pass topped out at
    // 1.55 and the sunlit crowns of the FOREGROUND stand came back the
    // brightest green in the frame. A near occluder has to sit below the
    // midground it frames, or it stops reading as near.
    const v = 0.55 + f * 0.62;
    parts.push(tinted(g, [v * 0.92, v, v * 0.86]));
  }
  return mergeGeometries(parts);         // ~55 tris
}

/**
 * A flat-roofed mud-brick house with a shallow gable, unit height 1.0.
 * Window openings are a separate instanced quad set (see `windowQuad`) so they
 * can be genuinely emissive.
 */
function house(rng) {
  const parts = [];
  // FIXED, not rolled: one geometry serves every instance, so a random depth
  // here silently moves the wall plane the lit windows are positioned against
  // (they are a separate instanced quad set and cannot see this geometry).
  const w = 1.05, dpt = 0.95, bh = 0.66;
  const body = new THREE.BoxGeometry(w, bh, dpt);
  body.translate(0, bh * 0.5, 0);
  parts.push(tinted(body, [2.0, 1.80, 1.42]));     // sun-bleached mud brick

  // Gable: a 4-sided pyramid, squashed. Cone with 4 segments, rotated 45 deg
  // so its ridges land on the box corners.
  const roof = new THREE.ConeGeometry(Math.max(w, dpt) * 0.80, 0.34 + rng() * 0.16, 4, 1);
  roof.rotateY(Math.PI * 0.25);
  roof.scale(w / Math.max(w, dpt) * 1.06, 1, dpt / Math.max(w, dpt) * 1.06);
  roof.translate(0, bh + 0.16, 0);
  parts.push(tinted(roof, [0.80, 0.66, 0.58]));    // dark thatch/tile

  // A stub of boundary wall so the settlement reads as enclosed rather than
  // as free-standing boxes on a hill.
  if (rng() < 0.6) {
    const bw = new THREE.BoxGeometry(0.14, 0.26, 0.7 + rng() * 0.8);
    bw.rotateY(rng() * 3.1);
    bw.translate((rng() - 0.5) * 1.5, 0.13, (rng() - 0.5) * 1.5 + dpt * 0.7);
    parts.push(tinted(bw, [1.55, 1.38, 1.10]));
  }
  return mergeGeometries(parts);         // ~28 tris
}

/** One lit window. A single quad; DoubleSide so orientation cannot kill it. */
function windowQuad() {
  const g = new THREE.PlaneGeometry(1, 1);
  return prep(g);                        // 2 tris
}

/**
 * A crenellated wall section, unit length 1 / unit height 1 / unit thickness 1.
 *
 * The body runs y 0..0.76 and four merlons y 0.76..1.0 with gaps between them,
 * so a non-uniform instance scale of (3, 5, 1.4) gives a 3-long, 5-high wall
 * with 1.1-unit merlons instead of scaling the crenellations into towers.
 * Also used, heavily squashed, for the west retaining terraces, and stretched
 * vertically for the gatehouse towers.
 */
function wallSeg(rng) {
  const parts = [];
  const body = new THREE.BoxGeometry(1, 0.76, 1);
  body.translate(0, 0.38, 0);
  parts.push(prep(body));
  const n = 4;
  for (let i = 0; i < n; i++) {
    // Chip one merlon off entirely now and then: a wall with every tooth
    // present is a fence, not a ruin (law 6).
    if (rng() < 0.18) continue;
    const bw = 1 / (n * 2 - 1);
    const m = new THREE.BoxGeometry(bw * (0.92 + rng() * 0.16), 0.24, 1.04);
    m.translate(-0.5 + bw * 0.5 + i * bw * 2, 0.76 + 0.12 * (0.8 + rng() * 0.4), 0);
    parts.push(prep(m));
  }
  return mergeGeometries(parts);         // ~60 tris
}

/** A wide flat rock shelf block for the terraced cliff. */
function slab(rng) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // Chip the top corners so a stack of these does not read as bricks.
    const y = p.getY(i);
    const k = y > 0 ? 0.80 + rng() * 0.28 : 1.0;
    p.setX(i, p.getX(i) * k + (rng() - 0.5) * 0.06);
    p.setZ(i, p.getZ(i) * k + (rng() - 0.5) * 0.06);
    p.setY(i, y + (rng() - 0.5) * 0.10);
  }
  g.computeVertexNormals();
  g.translate(0, 0.5, 0);
  return prep(g);                        // 12 tris
}

/* ---------------- round 7: HUMAN-SCALE SET DRESSING ------------------
 *
 * All three blind critics, independently: "nothing in the frame tells me how
 * big a tower is", "the slab could be a chess board or a stadium". What they
 * praised in the reference was that "the crates and the wall height all agree
 * on a human scale" — i.e. the scale cue is not one object, it is several
 * objects of DIFFERENT known sizes that agree with each other.
 *
 * So the sizes below are chosen against a 1 unit = 1 metre reading of the
 * world (spruces 5-15 units, houses 2.4-3.9, tuft ~0.7) and stated in the
 * geometry rather than in the instance scale, so a placement table cannot
 * quietly break the agreement:
 *
 *     crate  0.9 high      barrel 0.92 high
 *     fence  1.15-1.35 post, 2.2-unit bays
 *     lamp   2.9 to the lantern
 * ------------------------------------------------------------------ */

/** A plank crate with corner battens and a proud lid. */
function crate(rng) {
  const parts = [];
  const w = 0.88 + rng() * 0.20, d = 0.84 + rng() * 0.20;
  const b = new THREE.BoxGeometry(w, 0.86, d);
  b.translate(0, 0.43, 0);
  parts.push(tinted(b, [1.85, 1.46, 1.00]));           // pale sawn timber
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const p = new THREE.BoxGeometry(0.10, 0.90, 0.10);
    p.translate(sx * w * 0.47, 0.45, sz * d * 0.47);
    parts.push(tinted(p, [1.28, 1.02, 0.76]));         // darker batten
  }
  const lid = new THREE.BoxGeometry(w * 1.07, 0.085, d * 1.07);
  lid.translate(0, 0.90, 0);
  parts.push(tinted(lid, [2.05, 1.66, 1.18]));
  return mergeGeometries(parts);         // 72 tris
}

/** A hooped barrel. */
function barrel(rng) {
  const parts = [];
  const g = new THREE.CylinderGeometry(0.29, 0.25, 0.88 + rng() * 0.10, 9, 1);
  g.translate(0, 0.45, 0);
  parts.push(tinted(g, [1.55, 1.18, 0.84]));
  for (const y of [0.24, 0.66]) {
    const h = new THREE.CylinderGeometry(0.315, 0.315, 0.075, 9, 1, true);
    h.translate(0, y, 0);
    parts.push(tinted(h, [1.02, 1.00, 1.06]));         // iron hoop, cool
  }
  return mergeGeometries(parts);         // ~72 tris
}

/**
 * One bay of post-and-rail fence, unit LENGTH 1 along local x.
 *
 * Both rails are always present: this geometry is shared by every instance, so
 * a randomly missing rail would be missing in exactly the same place on all of
 * them, which is a repeating pattern rather than decay. Interruption is done at
 * placement time by dropping whole bays.
 */
function fenceBay(rng) {
  const parts = [];
  for (const px of [-0.5, 0.5]) {
    const h = 1.15 + rng() * 0.18;
    const p = new THREE.BoxGeometry(0.105, h, 0.105);
    p.rotateY(rng() * 0.5);
    p.translate(px, h * 0.5, (rng() - 0.5) * 0.05);
    parts.push(tinted(p, [1.45, 1.18, 0.90]));
  }
  for (const y of [0.50, 0.94]) {
    const r = new THREE.BoxGeometry(1.03, 0.072, 0.052);
    r.rotateZ((rng() - 0.5) * 0.05);
    r.translate(0, y, 0);
    parts.push(tinted(r, [1.90, 1.52, 1.10]));
  }
  return mergeGeometries(parts);         // 48 tris
}

/** A lamp post. The lantern's glow is an emissive quad in the window set. */
function lampPost() {
  const parts = [];
  const p = new THREE.CylinderGeometry(0.052, 0.088, 2.55, 6, 1);
  p.translate(0, 1.28, 0);
  parts.push(tinted(p, [1.05, 0.98, 0.95]));
  const arm = new THREE.BoxGeometry(0.05, 0.05, 0.32);
  arm.translate(0, 2.54, 0.14);
  parts.push(tinted(arm, [1.05, 0.98, 0.95]));
  const cage = new THREE.BoxGeometry(0.25, 0.30, 0.25);
  cage.translate(0, 2.36, 0.29);
  parts.push(tinted(cage, [1.35, 1.16, 0.92]));
  const cap = new THREE.ConeGeometry(0.21, 0.15, 4);
  cap.rotateY(Math.PI * 0.25);
  cap.translate(0, 2.59, 0.29);
  parts.push(tinted(cap, [0.95, 0.86, 0.78]));
  return mergeGeometries(parts);         // ~44 tris
}

/** A cut kerbstone for the road edge. */
function kerb(rng) {
  const g = new THREE.BoxGeometry(1, 0.7 + rng() * 0.5, 0.6 + rng() * 0.5);
  g.rotateY((rng() - 0.5) * 0.5);
  g.rotateZ((rng() - 0.5) * 0.22);
  g.translate(0, 0.3, 0);
  return prep(g);                        // 12 tris
}

/* ------------------------------------------------------------------ */
/* THE PLAN.                                                            */
/*                                                                      */
/* Everything below is a coordinate somebody chose. Local jitter inside  */
/* a named group is fine and desirable; there is no global distribution. */
/* ------------------------------------------------------------------ */

/** Tree stands. `fg: true` marks a foreground occluder (law 2). */
const STANDS = [
  // Breaks the TOP edge left of centre: "pines and broadleaf clumps break the
  // top edge". Placed where the terrain is ~5 units and the crop line is 12,
  // so the tall members are cut by the frame and the short ones are not —
  // which is what a treeline against a hill actually looks like.
  { n: 'north-break', x: -17, z: -31, rx: 15, rz: 5.0, n: 24, s: [5.5, 10.5] },
  // Crowning the settlement hill, upper left.
  { n: 'hill-crown', x: -47, z: -27, rx: 11, rz: 7, n: 15, s: [5.0, 9.0] },
  // At the foot of the east cliff, upper right, running off the right edge.
  { n: 'cliff-foot', x: 47, z: -6, rx: 9, rz: 9, n: 14, s: [5.0, 9.0] },
  // A few by the water, so the basin has a bank and not a rim.
  { n: 'basin-bank', x: -34, z: -6, rx: 6, rz: 6, n: 8, s: [4.5, 7.5] },
  // ---- FOREGROUND. Cropped by the bottom frame edge, overlapping the
  // board's near corners. All three blind critics named foreground occlusion
  // as the depth cue the reference has and we do not.
  // Sized DOWN from 11-17 units after the first capture: at 17 units and 4
  // members the occluder was a handful of enormous individual cones. A
  // treeline reads as a crown of many overlapping heads, not as four trees,
  // so the count goes up and the height comes down.
  { n: 'fg-right', x: 26, z: 26.5, rx: 7.5, rz: 3.5, n: 16, s: [9, 15], fg: true },
  { n: 'fg-left', x: -27, z: 25.0, rx: 8.0, rz: 3.5, n: 14, s: [9, 14], fg: true },
];

/**
 * The settlement. Eleven buildings on the west hill plus two on the basin
 * shore. Positions are clustered along the contour, with a lane between them,
 * because a village is a street and not a Poisson disc.
 */
const HOUSES = [
  [-40.5, -16.5], [-44.0, -19.5], [-39.0, -23.0], [-46.5, -24.5],
  [-42.0, -27.0], [-50.0, -21.0], [-51.5, -29.0], [-37.5, -20.0],
  [-45.0, -31.5], [-53.5, -25.0], [-36.5, -26.5],
  [-43.0, -2.5], [-41.0, 10.5],
];

/**
 * The north rampart, as runs with authored GAPS.
 *
 * Law 6: "A wall is allowed; a border is not." The two gaps are a collapse
 * (rubble spills through it, placed below) and a stand of pines growing
 * through the line. The run also stops dead at x = -36 and at the gatehouse
 * rather than turning a corner, so it reads as a fragment of something longer.
 */
const RAMPART_RUNS = [
  [-46.0, -22.0],    // west run, cropped by the left frame edge
  [-13.5, 5.0],      // centre run
  [12.0, 21.5],      // short run up to the gate
  [31.5, 42.0],      // beyond the gate, climbing onto the cliff
];
/** Centreline of the rampart: it wanders, it does not rule a line. */
const rampartZ = (x) => -29.6 + Math.sin(x * 0.062 + 1.1) * 1.9 - Math.max(0, x - 22) * 0.10;

/** The gatehouse: two towers straddling the road where it crosses the wall. */
const GATEHOUSE = { x: 26.0, z: -30.0 };

/** Terraced retaining walls stepping up the left edge. */
const WEST_TERRACES = [
  { x: -35.0, z0: -14, z1: 14, h: 1.9 },
  { x: -42.5, z0: -18, z1: 6, h: 2.3 },
  { x: -49.0, z0: -12, z1: -1, h: 2.6 },
];

/** The water basin, matching the 'basin' landform in Surround.js. */
const BASIN = { x: -39.5, z: 4.0, rx: 10.0, rz: 8.0, y: SHELF - 1.45 };

/* ------------------------------------------------------------------ */
/* ROUND 7 PLACEMENT TABLES.                                            */
/*                                                                      */
/* Coordinates checked against the measured visible ground quad in      */
/* Surround.js. The quad NARROWS toward the bottom of frame — the bottom */
/* edge runs (-41,18) -> (-4,24) -> (33,30) — so a prop at z = 25 is on  */
/* screen at x = +30 and off screen at x = -25. Two thirds of the first  */
/* pass of this table was placed outside the frame for exactly that      */
/* reason.                                                              */
/* ------------------------------------------------------------------ */

/** Depots and camps: the human-scale clutter (Art Bible gate: scale cue). */
const CAMPS = [
  { x: 24.5, z: -25.0, r: 3.4, crates: 6, barrels: 4, lamps: 2 },  // gate yard
  { x: 34.0, z: 9.0, r: 3.0, crates: 5, barrels: 3, lamps: 1 },    // road depot
  { x: 31.5, z: -9.0, r: 3.0, crates: 4, barrels: 3, lamps: 1 },   // east verge
  { x: 30.0, z: 23.0, r: 3.2, crates: 5, barrels: 3, lamps: 1 },   // near right
  { x: -24.0, z: 17.0, r: 3.0, crates: 4, barrels: 2, lamps: 1 },  // near left
  { x: -34.0, z: 8.0, r: 2.6, crates: 3, barrels: 2, lamps: 1 },   // basin landing
  { x: -44.0, z: -21.0, r: 3.2, crates: 4, barrels: 2, lamps: 2 }, // village square
];

/** Fence runs, [x0,z0,x1,z1]. A line of 1.2-unit posts is the cheapest ruler
 *  in the frame, and it also breaks up empty ground without adding chroma. */
const FENCE_RUNS = [
  [45.5, -4.0, 43.0, 12.0],       // east verge of the road, mid right
  [30.5, -14.0, 29.5, 4.0],       // between the board wall and the road:
                                  // the largest empty area left in frame
  [40.0, 14.0, 34.5, 24.0],       // continuing toward the bottom edge
  [-33.0, 14.5, -20.0, 18.5],     // bottom left, in front of the tree stand
  [-37.5, -12.0, -35.5, 0.0],     // along the west terraces
  [-47.0, -16.5, -38.5, -13.5],   // village field boundary
  [15.0, -25.5, 21.0, -27.0],     // inside the rampart, left of the gate
];

/** Rubble piles, replacing round 5's even perimeter walk (defect: "randomly
 *  distributed... cluster them along terrain logic"). Each sits where
 *  something fell down: a wall collapse, a cliff foot, a road cutting. */
const RUBBLE_PILES = [
  { x: -17.5, z: -24.0, r: 5.5, n: 10 },   // through the rampart collapse
  { x: 30.5, z: -22.0, r: 4.2, n: 8 },     // spill off the gatehouse
  { x: -30.0, z: 11.0, r: 4.6, n: 9 },     // slumped board corner, west
  { x: 13.0, z: 24.0, r: 5.0, n: 9 },      // near edge, cropped by the frame
  { x: 31.5, z: 6.0, r: 4.0, n: 8 },       // road cutting, east
  { x: -31.0, z: -8.0, r: 4.2, n: 8 },     // under the west bench
  { x: 21.0, z: 25.5, r: 3.6, n: 6 },
];

/** Meadow patches: dense scrub in a few places and none between them. Same
 *  law-5 argument as the props, applied to ground cover. */
const MEADOWS = [
  { x: -20, z: -25, rx: 9, rz: 4.5, n: 46 },
  { x: 12, z: 25.5, rx: 10, rz: 3.5, n: 40 },
  { x: 40, z: -2, rx: 6, rz: 8, n: 38 },
  { x: -33, z: -14, rx: 7, rz: 7, n: 34 },
  { x: 6, z: -25, rx: 7, rz: 3.5, n: 30 },
  { x: -30, z: 16, rx: 7, rz: 4, n: 30 },
  { x: 46, z: 14, rx: 5, rz: 7, n: 26 },
];

/** Smoothstep, JS side. */
const s01 = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Places that are walked on but are not the road. */
const WEAR_SPOTS = [
  { x: 26.0, z: -29.0, r: 7.0, k: 0.90 },    // the gatehouse yard
  { x: -43.0, z: -22.0, r: 8.0, k: 0.70 },   // the village lanes
  { x: -37.0, z: 6.0, r: 5.5, k: 0.65 },     // the trodden basin shore
  { x: 33.5, z: 10.0, r: 5.0, k: 0.85 },     // the roadside depot
  { x: 29.0, z: 23.0, r: 4.5, k: 0.85 },     // the near-right approach
  { x: -24.0, z: 17.0, r: 4.5, k: 0.80 },    // the near-left approach
];

/**
 * How worn the bare ground is at (x,z), 0..1. Written into the ground mesh as
 * the `aWear` attribute and turned into a second dirt albedo, with a
 * noise-ragged boundary, by the shared surround shader.
 *
 * This is defect 2 answered at the cause rather than at the symptom: the
 * critics read "a raw hue with no blending" at the road because the road WAS a
 * ribbon of one colour laid on a field of another with nothing in between. A
 * road is surrounded by ground that has been walked on.
 */
function wearAt(x, z) {
  let w = 0;
  const r = roadQuery(x, z);
  if (r.lat < 1e8) w = Math.max(w, 1 - s01(ROAD_HW * 0.85, ROAD_HW * 2.5, r.lat));
  const d = arenaEdgeDist(x, z);
  // FIRST PASS WAS 0.86 OVER 10.5 UNITS AND IT ATE THE FRAME. The visible
  // surround is only a few units deep along the bottom and sides, so a 10-unit
  // trampled apron is not 'a worn verge', it is 'the ground is now brown'. The
  // capture went from one flat green to one flat tan, which is the same defect
  // with a different hue. Keep it to a narrow scuff at the wall foot.
  if (d > -2) w = Math.max(w, 0.58 * (1 - s01(0.3, 4.5, d)));
  for (const p of WEAR_SPOTS) {
    w = Math.max(w, p.k * (1 - s01(p.r * 0.30, p.r, Math.hypot(x - p.x, z - p.z))));
  }
  return w;
}

export class Backdrop {
  constructor(quality) {
    this.group = new THREE.Group();
    this.group.name = 'surround';
    const rng = makeRng(0x51DE0417);
    const heavy = (quality?.particleBudget ?? 20000) >= 9000;

    this.materials = [];
    this.meshes = [];

    this.#buildGround(heavy);
    this.#buildProps(rng, heavy);
    this.#buildRoad();
    this.#buildWater();
  }

  /* ----------------------------------------------------------------
   * The ground itself.
   *
   * Polar annulus, r 16..300. r=16 is entirely under the arena (the board
   * covers |x|<27, |z|<21), so the inner hole is never visible.
   *
   * Ring radii are geometric, so spacing is fine where the player looks and
   * coarse where only a zoomed-out camera can reach. Round 5 raises the
   * tessellation from 104x44 to 152x56 because the heightfield now carries
   * TERRACES: a 3.3-unit riser sampled every 1.7 units survives, sampled
   * every 2.6 units turns back into a smooth slope and the whole point of
   * the rewrite is lost. Cost is +7.6k triangles on a 900k budget.
   *
   * Vertices carry a deterministic azimuthal jitter: a clean polar grid puts
   * 152 radial spokes through the shading normals and the eye finds them.
   * ---------------------------------------------------------------- */
  #buildGround(heavy) {
    const NA = heavy ? 152 : 96;
    const NR = heavy ? 56 : 36;
    const R0 = 16, R1 = 300;
    const kr = Math.log(R1 / R0);

    const nv = NA * (NR + 1);
    const pos = new Float32Array(nv * 3);
    const nrm = new Float32Array(nv * 3);
    const wear = new Float32Array(nv);
    const n = new THREE.Vector3();

    for (let i = 0; i <= NR; i++) {
      // Bias the radial distribution toward the visible band (r 16..95) so
      // the terraces and the road cut land on real vertices.
      const u = i / NR;
      const r = R0 * Math.exp(kr * Math.pow(u, 1.45));
      for (let j = 0; j < NA; j++) {
        const jt = (Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
        const a = (j / NA) * Math.PI * 2 + jt * (Math.PI * 2 / NA) * 0.55;
        const rr = r * (1 + jt * 0.06);
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        const y = surroundHeight(x, z);
        const o = (i * NA + j) * 3;
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        surroundNormal(x, z, n);
        nrm[o] = n.x; nrm[o + 1] = n.y; nrm[o + 2] = n.z;
        wear[i * NA + j] = wearAt(x, z);
      }
    }

    const idx = [];
    for (let i = 0; i < NR; i++) {
      for (let j = 0; j < NA; j++) {
        const j2 = (j + 1) % NA;
        const a = i * NA + j, b = i * NA + j2;
        const c = (i + 1) * NA + j, d = (i + 1) * NA + j2;
        // WINDING. First attempt used (a,c,b)/(b,c,d), whose face normal works
        // out to -Y: the entire surround was back-face culled from an
        // overhead camera. That is PITFALLS entry 2, repeated exactly.
        // Derivation, at theta=0:
        //   a=(r,0,0)  b~=(r,0,r*dtheta)  c=(r+dr,0,0)
        //   (b-a) x (c-a) = (0, +r*dtheta*dr, 0)  => a -> b -> c faces +Y.
        idx.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aWear', new THREE.BufferAttribute(wear, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    // Cool moss/turf where the ground is flat and sheltered, warm scuffed
    // dirt where it is worn, cool slate where it is steep.
    //
    // ROUND 5: falloff raised 0.28 -> 0.44 and the haze term switched on.
    // "Roughly 70% of the frame sits within a narrow dark-teal value band" was
    // partly this multiplier: it only ever subtracted, so the far field lost
    // brightness without gaining the contrast loss and hue shift that actually
    // read as distance. The mid-value mass now comes from raising the floor
    // and letting the terraces and the height-value term carry the spread.
    const mat = makeSurroundMaterial({
      name: 'ground',
      // Measured back down after the value pass overshot: surround:board
      // landed at 0.715 against law 4's 0.55-0.65, and the turf read as a
      // mown lawn. `low` desaturated toward teal and the whole ladder pulled
      // ~12%. Dark is not the same as flat — the SPREAD stays where the value
      // pass put it (p10-p90 = 72 against round 4's 64.7), only the mean moves.
      /* ROUND 7. Two of three blind critics: "grass is a single high-chroma
       * yellow-green with no variation". Both halves of that are addressed
       * here, and NOT with a chroma dial in either direction:
       *
       *  - the greens are desaturated at source. `low` was 0x0f4038, a 77%-
       *    saturation teal that comes back out of a 7.6-intensity amber key as
       *    fluorescent yellow-green; it is now a 50% turf green. Frame-mean
       *    saturation is deliberately not a target (law 7) — this is a per-
       *    material decision, judged on the capture.
       *  - FOUR distinct ground albedos now meet each other in frame instead
       *    of one: damp turf, dry bleached grass, dusty scuffed earth and the
       *    worn path, plus slate on the steep faces. That is where the
       *    reference's richness comes from.
       *
       * `sat` (the far-field chroma push) also comes down 1.9 -> 1.45. It only
       * bites past r=20, which is precisely the large flat field the critics
       * were looking at. */
      low: 0x1d3a2b, mid: 0x36351f, high: 0x27303f,
      dry: 0x424427, dryAmt: 0.62,
      worn: 0x4a3a28, wearAmt: 0.80,
      patchAmt: 0.62,
      scale: 0.055, rough: 0.94, detail: 1.0, bump: 1.15, bumpFreq: 0.95,
      falloff: 0.50, sat: 1.45, hazeAmt: 0.34, heightVal: 0.40, regionVal: 0.30,
    });
    this.materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'surround-ground';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    this.ground = mesh;
    this.group.add(mesh);
    this.meshes.push(mesh);
  }

  /* ----------------------------------------------------------------
   * Props — the authored composition.
   * ---------------------------------------------------------------- */
  #buildProps(rng, heavy) {
    const q = heavy ? 1 : 0.6;
    const place = [];
    const push = (set, x, z, s, extra) => place.push({ set, x, z, s, yaw: rng() * 6.283, ...extra });

    /** Never plant anything on the pavement or inside the board. */
    const onRoad = (x, z, m = 1.2) => roadQuery(x, z).lat < ROAD_HW + m;
    const clear = (x, z) => arenaEdgeDist(x, z) < 3.2;

    /* ============ 1. THE NORTH RAMPART ============================= */
    // Coursed segments walked along each run. Height varies along the length
    // (law 6: "value varying along their length") and two segments are
    // deliberately slumped to half height.
    for (const [x0, x1] of RAMPART_RUNS) {
      const seg = 3.1;
      const count = Math.max(1, Math.round((x1 - x0) / seg));
      for (let i = 0; i < count; i++) {
        const f = (i + 0.5) / count;
        const x = x0 + (x1 - x0) * f;
        const z = rampartZ(x) + (rng() - 0.5) * 0.7;
        // A long slow sag plus the odd collapsed course.
        let h = 4.6 + Math.sin(x * 0.09 + 0.7) * 0.85;
        if (rng() < 0.14) h *= 0.45;
        push('wall', x, z, 1, {
          sx: seg * 1.02, sy: h, sz: 1.5 + rng() * 0.35,
          yaw: Math.atan2(rampartZ(x + 2) - rampartZ(x - 2), 4) * -1,
          sink: 0.5,
        });
      }
    }
    // Rubble spilling THROUGH the collapsed gap at x -20.5..-13.5 — terrain
    // reading continuously across the wall line, which is law 6's actual test.
    for (let i = 0; i < 26; i++) {
      const x = -21.5 + rng() * 9.0;
      const z = rampartZ(x) + (rng() - 0.5) * 7.5;
      push(rng() < 0.45 ? 'ruin' : 'boulder', x, z, 0.6 + Math.pow(rng(), 1.6) * 2.4);
    }

    /* ============ 2. THE GATEHOUSE ================================= */
    // Two towers straddling the road, one of them broken down to half height,
    // plus a fallen lintel block lying across the verge.
    {
      const g = GATEHOUSE;
      const r = roadQuery(g.x, g.z);
      const nx = -r.tz, nz = r.tx;                       // road normal
      const off = ROAD_HW + 2.6;
      push('wall', g.x + nx * off, g.z + nz * off, 1,
        { sx: 4.6, sy: 10.5, sz: 4.2, yaw: Math.atan2(r.tx, r.tz), sink: 1.2 });
      push('wall', g.x - nx * off, g.z - nz * off, 1,
        { sx: 4.4, sy: 6.2, sz: 4.0, yaw: Math.atan2(r.tx, r.tz) + 0.12, sink: 1.2 });
      // the collapsed lintel
      push('slab', g.x - nx * (off + 2.6), g.z - nz * (off + 2.6), 1,
        { sx: 5.4, sy: 1.5, sz: 2.0, yaw: Math.atan2(r.tx, r.tz) + 0.5, tilt: 0.28 });
      for (let i = 0; i < 14; i++) {
        const a = rng() * 6.283, rr = 3.0 + rng() * 7.0;
        push(rng() < 0.5 ? 'ruin' : 'boulder',
          g.x + Math.cos(a) * rr, g.z + Math.sin(a) * rr, 0.5 + rng() * 1.5);
      }
    }

    /* ============ 3. THE EAST CLIFF =============================== */
    // Terraced shelves stacked on the mesa's visible face plus scree at its
    // foot. Placed on three authored courses, not scattered over the mass.
    {
      // The mesa crosses the top-edge crop line around z = -24, so the shelves
      // sit on the band between its foot (z ~ -8) and that line. Anything
      // further back is triangles nobody can see.
      // STRATA, NOT RUBBLE. The first pass put 20 slabs at scale 4-10 with a
      // free tilt across the mass and it photographed as a scree heap: a cliff
      // is a few big BEDS lying parallel, and the parallelism is the entire
      // read. So: fewer, much wider, much flatter, all tilted the same way
      // (the bedding dip), each course sitting on the terrace below it.
      /* ROUND 7 — THE BLOCKOUT MASSES.
       *
       * Blind critic: "flat blue/dark polygon shapes near the top-right that
       * read as unfinished blockout, not architecture." They were these: 11
       * beds at scale 8-15, i.e. single boxes 12-18 units across, each
       * presenting one 200-px flat facet to the camera. At that size a chipped
       * box has no silhouette, no internal edge and no shadow across it — the
       * eye gets a big untextured polygon and correctly reads greybox.
       *
       * The fix is not to delete the cliff (the frame needs a mass at the
       * top-right corner) but to make it out of rock-sized rocks: 27 beds at
       * scale 3.5-8 on five courses, each course overlapping the one below, so
       * the same volume is now built from pieces small enough that the
       * procedural relief and the cast shadows actually land on them. Buried
       * deeper too (sink 1.1), so they emerge from the hillside rather than
       * sitting on it. Scree, dead growth and scrub then cross the joins.
       */
      const DIP = 0.09;
      const COURSES = [
        { z: -6.5, x0: 42, x1: 66, n: 6, s: [3.5, 5.5] },
        { z: -10.5, x0: 43, x1: 67, n: 6, s: [4.0, 6.5] },
        { z: -14.5, x0: 45, x1: 69, n: 6, s: [4.5, 7.0] },
        { z: -18.5, x0: 47, x1: 70, n: 5, s: [5.0, 8.0] },
        { z: -22.5, x0: 49, x1: 72, n: 4, s: [5.5, 8.5] },
      ];
      for (const c of COURSES) {
        for (let i = 0; i < c.n; i++) {
          const f = (i + 0.5) / c.n;
          const x = c.x0 + (c.x1 - c.x0) * f + (rng() - 0.5) * 3.2;
          const z = c.z + (rng() - 0.5) * 2.2;
          const s = c.s[0] + rng() * (c.s[1] - c.s[0]);
          push('slab', x, z, 1, {
            sx: s * (1.15 + rng() * 0.5), sy: s * (0.26 + rng() * 0.16),
            sz: s * (0.60 + rng() * 0.35),
            yaw: 0.34 + (rng() - 0.5) * 0.34,      // beds share a strike, loosely
            tilt: DIP + (rng() - 0.5) * 0.09, sink: 1.1,
          });
        }
      }
      // scree fan at the foot and spilling between the courses, so the beds
      // are never seen meeting bare ground on a clean line.
      for (let i = 0; i < 34; i++) {
        const x = 39 + rng() * 30, z = 1 - rng() * 26;
        if (onRoad(x, z, 1.5)) continue;
        push(rng() < 0.72 ? 'boulder' : 'outcrop', x, z, 0.7 + Math.pow(rng(), 1.7) * 3.4);
      }
      // a few spires standing on the crest, cropped by the top edge
      for (let i = 0; i < 5; i++) {
        push('spire', 47 + rng() * 20, -24 - rng() * 7, 5.0 + rng() * 5.0);
      }
      // dead growth clinging to the shelves: something of known small size
      // standing on the cliff is what stops it reading as an untextured mass.
      for (let i = 0; i < 9; i++) {
        push('growth', 42 + rng() * 26, -4 - rng() * 20, 2.6 + rng() * 2.6);
      }
    }

    /* ============ 4. THE SETTLEMENT =============================== */
    // Every house yaws roughly toward the camera so its lit face is the one we
    // see; the camera sits at (-6.9, 43), so that is +x/+z from here.
    const windows = [];
    for (const [hx, hz] of HOUSES) {
      const yaw = Math.atan2(-6.9 - hx, 43 - hz) + (rng() - 0.5) * 0.7;
      const s = 2.4 + rng() * 1.5;
      push('house', hx, hz, 1, { sx: s, sy: s * (0.9 + rng() * 0.35), sz: s, yaw, sink: 0.12 });
      // 1-3 lit windows on the camera-facing wall
      const nw = 1 + Math.floor(rng() * 2.4);
      for (let k = 0; k < nw; k++) {
        windows.push({
          x: hx, z: hz, yaw, s,
          u: (rng() - 0.5) * 0.55, v: 0.16 + rng() * 0.24,
          // SIZED AS WINDOWS, round 7. At 0.16-0.25 x s these were 0.6-1.0
          // units wide on a 3-unit house: a shopfront, not a casement, and
          // they photographed as rows of bright bars. A window is ~0.8m.
          w: 0.10 + rng() * 0.05, h: 0.14 + rng() * 0.06,
          warm: rng(),
        });
      }
    }
    // A few dead trees and a ruined outbuilding to break the roofline.
    for (let i = 0; i < 7; i++) {
      push('growth', -52 + rng() * 17, -34 + rng() * 20, 3.4 + rng() * 3.0);
    }
    for (let i = 0; i < 6; i++) {
      push('ruin', -55 + rng() * 8, -18 + rng() * 14, 0.9 + rng() * 1.5);
    }

    /* ============ 5. WEST TERRACES ================================ */
    for (const t of WEST_TERRACES) {
      const seg = 2.9;
      const count = Math.max(1, Math.round((t.z1 - t.z0) / seg));
      for (let i = 0; i < count; i++) {
        if (rng() < 0.16) continue;                    // interrupted, always
        const z = t.z0 + (t.z1 - t.z0) * ((i + 0.5) / count);
        push('wall', t.x + (rng() - 0.5) * 0.8, z, 1, {
          sx: seg * 1.03, sy: t.h * (0.82 + rng() * 0.36), sz: 1.1,
          yaw: Math.PI * 0.5 + (rng() - 0.5) * 0.06, sink: 0.45,
        });
      }
    }

    /* ============ 6. THE BASIN SHORE ============================== */
    // A cut-stone kerb around the deep side of the pool, and boulders on the
    // shallow side, so the water has a built edge and a wild edge.
    for (let i = 0; i < 22; i++) {
      const a = 3.4 + (i / 22) * 3.6;
      const x = BASIN.x + Math.cos(a) * BASIN.rx * 0.96;
      const z = BASIN.z + Math.sin(a) * BASIN.rz * 0.96;
      push('slab', x, z, 1, { sx: 1.9, sy: 1.0 + rng() * 0.5, sz: 1.3, sink: 0.35 });
    }
    for (let i = 0; i < 16; i++) {
      const a = 0.2 + rng() * 3.2;
      const rr = 0.92 + rng() * 0.30;
      push('boulder', BASIN.x + Math.cos(a) * BASIN.rx * rr,
        BASIN.z + Math.sin(a) * BASIN.rz * rr, 0.7 + rng() * 2.0);
    }

    /* ============ 7. TREE STANDS ================================== */
    const conifers = [];
    for (const st of STANDS) {
      for (let i = 0; i < Math.round(st.n * q); i++) {
        // Density falls off toward the edge of the stand, and the stand has a
        // hard extent. Between stands there are NO trees at all — that is the
        // uneven density the whole rewrite is for.
        const a = rng() * 6.283, rr = Math.pow(rng(), 0.62);
        const x = st.x + Math.cos(a) * st.rx * rr;
        const z = st.z + Math.sin(a) * st.rz * rr;
        if (clear(x, z) || onRoad(x, z, 2.2)) continue;
        const s = st.s[0] + rng() * (st.s[1] - st.s[0]);
        conifers.push({ x, z, s, yaw: rng() * 6.283, fg: !!st.fg });
      }
      // Undergrowth and fallen rock inside the foreground stands, so the
      // occluder is a mass rather than a row of cones.
      if (st.fg) {
        for (let i = 0; i < 6; i++) {
          const a = rng() * 6.283, rr = Math.pow(rng(), 0.5);
          const x = st.x + Math.cos(a) * (st.rx + 2) * rr;
          const z = st.z + Math.sin(a) * (st.rz + 2) * rr;
          if (clear(x, z)) continue;
          // SMALL. These sit 15 units from the camera, where one world unit is
          // ~100px. The first pass allowed scale 5.8, which the generic
          // non-uniform jitter then stretched to 8, and `outcrop` is a stack of
          // tilted boxes: the foreground occluder photographed as a heap of
          // broken concrete slabs with the trees lost behind it. Boulders only,
          // and never more than three units.
          push('boulder', x, z, 1.2 + rng() * 1.8);
        }
      }
    }

    /* ============ 8. THE ROAD'S FURNITURE ========================= */
    // Kerbstones down both verges, with long stretches missing. A continuous
    // kerb is a border (law 6); an interrupted one is a road.
    {
      const P = ROAD_PATH;
      for (let i = 4; i < P.length - 4; i += 2) {
        const p = P[i], pn = P[i + 1];
        const tx = pn.x - p.x, tz = pn.z - p.z;
        const L = Math.hypot(tx, tz) || 1;
        const nx = -tz / L, nz = tx / L;
        for (const side of [-1, 1]) {
          // Authored gaps: the kerb survives in three stretches only.
          const s = i / P.length;
          const kept = (s > 0.18 && s < 0.34) || (s > 0.46 && s < 0.62) || (s > 0.72 && s < 0.86);
          if (!kept || rng() < 0.35) continue;
          const off = ROAD_HW + 0.55 + rng() * 0.35;
          const x = p.x + nx * side * off, z = p.z + nz * side * off;
          if (arenaEdgeDist(x, z) < 1.0) continue;
          // LONG AND LOW. At sy 0.75-1.25 these came out as a row of tan
          // menhirs standing beside the road; a kerb is a laid course, so it
          // has to be wider than it is tall and sunk most of the way in.
          push('kerb', x, z, 1, {
            sx: 2.2 + rng() * 1.1, sy: 0.42 + rng() * 0.22, sz: 0.7,
            yaw: Math.atan2(tx, tz), sink: 0.16,
          });
        }
      }
    }

    /* ============ 9. SEAM DEBRIS =================================== */
    /* ROUND 7. Blind critic: "the grey rocks left of the slab are low-poly,
     * uniformly lit and RANDOMLY DISTRIBUTED. Cluster them along terrain
     * logic." Round 5 walked the arena perimeter on a golden-ratio step —
     * which is a very good way to get even coverage, and even coverage is
     * exactly the complaint. Law 5 applies at 1-unit scale as well as at
     * 40-unit scale.
     *
     * So: seven named piles, each at a place where something fell down, with a
     * power-law size distribution inside each (one or two anchors and a tail
     * of chips, not a bag of identical pebbles). A thin scatter of singles
     * survives along the board seam so nothing meets the ground cleanly, but
     * it is a quarter of the previous density. */
    for (const p of RUBBLE_PILES) {
      const n = Math.round(p.n * q);
      for (let i = 0; i < n; i++) {
        const a = rng() * 6.283;
        const rr = Math.pow(rng(), 0.55) * p.r;
        const x = p.x + Math.cos(a) * rr, z = p.z + Math.sin(a) * rr * 0.8;
        if (arenaEdgeDist(x, z) < 0.2 || onRoad(x, z, 0.4)) continue;
        // Anchors first, chips after: size falls with distance from the
        // pile centre, which is what a heap of fallen stone actually does.
        const near = 1 - rr / p.r;
        const s = 0.30 + Math.pow(rng(), 1.7) * (0.6 + near * 2.9);
        push(rng() < 0.30 ? 'ruin' : 'boulder', x, z, s);
      }
    }
    {
      const per = 2 * (ARENA_HW * 2 + ARENA_HH * 2);
      const n = Math.round(17 * q);
      for (let i = 0; i < n; i++) {
        let t = ((i * 0.6180339887 + rng() * 0.010) % 1) * per;
        let x, z;
        if (t < ARENA_HW * 2) { x = -ARENA_HW + t; z = -ARENA_HH; }
        else if ((t -= ARENA_HW * 2) < ARENA_HH * 2) { x = ARENA_HW; z = -ARENA_HH + t; }
        else if ((t -= ARENA_HH * 2) < ARENA_HW * 2) { x = ARENA_HW - t; z = ARENA_HH; }
        else { t -= ARENA_HW * 2; x = -ARENA_HW; z = ARENA_HH - t; }
        const out = -0.4 + Math.pow(rng(), 0.8) * 3.8;
        x += Math.sign(x || 1) * (Math.abs(x) > ARENA_HW - 0.01 ? out : 0);
        z += Math.sign(z || 1) * (Math.abs(z) > ARENA_HH - 0.01 ? out : 0);
        x += (rng() - 0.5) * 1.6;
        z += (rng() - 0.5) * 1.6;
        if (onRoad(x, z, 0.4)) continue;
        push(rng() < 0.24 ? 'ruin' : 'boulder', x, z,
          0.28 + Math.pow(rng(), 2.0) * 0.85);
      }
    }

    /* ============ 9b. HUMAN-SCALE SET DRESSING ===================== */
    /* Defect 3, named by all three critics: "no scale reference anywhere".
     * Crates, barrels, fences and lamp posts, at sizes that agree with each
     * other and with the houses and trees already out there. They are
     * clustered into depots because a crate on its own in a field is a prop;
     * six crates, four barrels and a lamp together are a PLACE, and the fact
     * that somebody stacked them is what makes the size legible. */
    for (const c of CAMPS) {
      let px = null, pz = null, ps = 0;
      for (let i = 0; i < c.crates; i++) {
        // A third of them are stacked ON THE PREVIOUS CRATE, at its own x/z —
        // computing an independent position and merely raising y is how you
        // get boxes hovering over grass.
        const stackOn = px !== null && rng() < 0.34;
        let x, z;
        if (stackOn) {
          x = px + (rng() - 0.5) * 0.16; z = pz + (rng() - 0.5) * 0.16;
        } else {
          const a = rng() * 6.283, rr = Math.pow(rng(), 0.6) * c.r;
          x = c.x + Math.cos(a) * rr; z = c.z + Math.sin(a) * rr;
        }
        if (arenaEdgeDist(x, z) < 0.6 || onRoad(x, z, 0.3)) continue;
        const s = 0.85 + rng() * 0.30;
        push('crate', x, z, 1, {
          sx: s, sy: s * (0.9 + rng() * 0.2), sz: s * (0.92 + rng() * 0.16),
          sink: stackOn ? -0.86 * ps : 0.02,
          tilt: (rng() - 0.5) * (stackOn ? 0.14 : 0.05),
          upright: 0.12,
        });
        if (!stackOn) { px = x; pz = z; ps = s; }
      }
      for (let i = 0; i < c.barrels; i++) {
        const a = rng() * 6.283, rr = Math.pow(rng(), 0.5) * (c.r + 0.8);
        const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
        if (arenaEdgeDist(x, z) < 0.6 || onRoad(x, z, 0.3)) continue;
        const s = 0.92 + rng() * 0.22;
        push('barrel', x, z, 1, { sx: s, sy: s, sz: s, sink: 0.04 });
      }
      for (let i = 0; i < c.lamps; i++) {
        const a = 1.2 + rng() * 4.0, rr = c.r * (0.9 + rng() * 0.5);
        const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
        if (arenaEdgeDist(x, z) < 0.6 || onRoad(x, z, 0.6)) continue;
        // Face the lantern arm roughly at the camera, as the houses do.
        const yaw = Math.atan2(-6.9 - x, 43 - z) + (rng() - 0.5) * 0.5;
        const hh = 0.9 + rng() * 0.25;
        push('lamp', x, z, 1, { sx: 1, sy: hh, sz: 1, yaw, sink: 0.0, upright: 0.10 });
        // The lantern's flame rides in the WINDOW instanced set, so a lit
        // lamp costs zero extra draw calls. Local (0, 2.36, 0.29) is the cage
        // centre in lampPost(); y scales with the instance, z does not.
        windows.push({
          abs: true,
          px: x + Math.sin(yaw) * 0.29,
          py: surroundHeight(x, z) + 2.36 * hh,
          pz: z + Math.cos(yaw) * 0.29,
          yaw, w: 0.20, h: 0.26, warm: 0.75 + rng() * 0.25,
        });
      }
    }

    /* Fence runs. Bays are dropped, never truncated: a fence that stops in the
     * middle of a field is a fence, a fence that rings something is a border
     * (law 6). */
    for (const [x0, z0, x1, z1] of FENCE_RUNS) {
      const dx = x1 - x0, dz = z1 - z0;
      const L = Math.hypot(dx, dz);
      const bays = Math.max(1, Math.round(L / 2.2));
      const yaw = Math.atan2(dx, dz) + Math.PI * 0.5;
      for (let i = 0; i < bays; i++) {
        if (rng() < 0.13) continue;                    // a gap, or a rotted bay
        const f = (i + 0.5) / bays;
        const x = x0 + dx * f + (rng() - 0.5) * 0.25;
        const z = z0 + dz * f + (rng() - 0.5) * 0.25;
        // Half the bays were being eaten by a 0.8-unit road margin on runs
        // that deliberately follow the verge. A fence beside a road is the
        // point; only the pavement itself is off limits.
        if (arenaEdgeDist(x, z) < 1.0 || onRoad(x, z, 0.25)) continue;
        push('fence', x, z, 1, {
          sx: (L / bays) * 1.02, sy: 0.92 + rng() * 0.22, sz: 1,
          yaw: yaw + (rng() - 0.5) * 0.10, sink: 0.10,
        });
      }
    }

    /* ============ 10. SCRUB ======================================== */
    /* Restricted to three named contexts — the board apron, the road verges
     * and the basin bank — so the ground cover is uneven by construction.
     * Round 4 blanketed a 26-unit annulus at even density. */
    const tufts = [];
    const addTuft = (x, z, s) => {
      if (arenaEdgeDist(x, z) < -0.2 || onRoad(x, z, 0.2)) return;
      const nrm = surroundNormal(x, z);
      if (nrm.y < 0.88) return;
      tufts.push({ x, z, s, yaw: rng() * 6.283 });
    };
    for (let i = 0; i < Math.round(210 * q); i++) {          // apron
      const a = rng() * Math.PI * 2;
      const ux = Math.cos(a), uz = Math.sin(a);
      const k = Math.min(ARENA_HW / Math.max(Math.abs(ux), 1e-3),
                         ARENA_HH / Math.max(Math.abs(uz), 1e-3));
      const d = -0.15 + Math.pow(rng(), 2.3) * 13;
      addTuft(ux * (k + d), uz * (k + d), (0.55 + rng() * 0.45) * (1 + d * 0.012));
    }
    {                                                        // road verges
      const P = ROAD_PATH;
      for (let i = 0; i < Math.round(150 * q); i++) {
        const p = P[6 + Math.floor(rng() * (P.length - 12))];
        const a = rng() * 6.283, rr = ROAD_HW + 0.8 + rng() * 4.5;
        addTuft(p.x + Math.cos(a) * rr, p.z + Math.sin(a) * rr, 0.6 + rng() * 0.5);
      }
    }
    for (let i = 0; i < Math.round(90 * q); i++) {           // basin bank
      const a = rng() * 6.283, rr = 0.85 + rng() * 0.55;
      addTuft(BASIN.x + Math.cos(a) * BASIN.rx * rr,
              BASIN.z + Math.sin(a) * BASIN.rz * rr, 0.6 + rng() * 0.6);
    }
    /* MEADOW PATCHES, round 7. Ground cover concentrated into seven named
     * areas with bare ground between them. The critics' "no texture, no
     * variation" is partly a texture problem and partly this: a field with a
     * uniform sprinkle of grass over it is smooth at every scale the eye
     * cares about. Patches of long grass are a tonal element, not a detail. */
    for (const m of MEADOWS) {
      for (let i = 0; i < Math.round(m.n * q); i++) {
        const a = rng() * 6.283, rr = Math.pow(rng(), 0.55);
        addTuft(m.x + Math.cos(a) * m.rx * rr, m.z + Math.sin(a) * m.rz * rr,
                0.75 + rng() * 0.55);
      }
    }
    for (const st of STANDS) {                                // stand floors
      for (let i = 0; i < Math.round(26 * q); i++) {
        const a = rng() * 6.283, rr = Math.pow(rng(), 0.6);
        addTuft(st.x + Math.cos(a) * st.rx * rr, st.z + Math.sin(a) * st.rz * rr,
                (st.fg ? 1.5 : 0.7) + rng() * 0.6);
      }
    }

    /* --- build the instanced meshes ------------------------------------ */
    /* MATERIAL VALUE LADDER, round 5.
     *
     * The critics' "narrow dark-teal value band" is a statement about the
     * histogram, so it has to be answered with a histogram. Measured p10-p90
     * spread in the round-4 surround was 64.7 against the board's 117.9. The
     * ladder below is deliberately wide: cut masonry and the road sit ABOVE
     * the ground, wild rock sits on it, and the tree masses sit well below —
     * so the frame has darks and lights out there instead of one value with
     * texture on it. Every entry still respects law 4: the whole ladder lives
     * under the board, and hue stays opposed to it. */
    const SETS = {
      boulder: {
        geo: boulder(rng),
        // ROUND 7: greys, not blues, and a wide per-instance VALUE spread.
        // "The grey rocks are low-poly, UNIFORMLY LIT" — with a +-8% tint and
        // one albedo, every boulder in the frame returned the same number, so
        // a dozen of them read as one repeated asset. valSpread multiplies each
        // instance by 0.70-1.34, which is a full stop of separation between
        // neighbours and is what makes a cluster read as lit and shadowed
        // rather than as a decal sheet.
        mat: makeSurroundMaterial({ name: 'boulder', low: 0x212936, mid: 0x2d2d26, high: 0x343b4a, scale: 0.30, rough: 0.88, bump: 1.05, bumpFreq: 2.2, falloff: 0.56, hazeAmt: 0.34, heightVal: 0.32, skyBounce: 0x0f2434 }),
        sink: 0.16, tint: 0.20, valSpread: 0.30,
      },
      outcrop: {
        geo: outcrop(rng),
        mat: makeSurroundMaterial({ name: 'outcrop', low: 0x1c2634, mid: 0x282a23, high: 0x2f3745, scale: 0.34, rough: 0.90, bump: 1.15, bumpFreq: 2.4, falloff: 0.56, hazeAmt: 0.34, heightVal: 0.32, skyBounce: 0x0f2434 }),
        sink: 0.20, tint: 0.20, valSpread: 0.30,
      },
      spire: {
        geo: spire(rng),
        mat: makeSurroundMaterial({ name: 'spire', low: 0x17283f, mid: 0x24333e, high: 0x2c4260, scale: 0.28, rough: 0.86, slopeBias: 0.22, bump: 1.10, bumpFreq: 2.6, falloff: 0.54, hazeAmt: 0.42, heightVal: 0.32 }),
        sink: 0.10, tint: 0.14,
      },
      growth: {
        geo: deadGrowth(rng),
        mat: makeSurroundMaterial({ name: 'growth', low: 0x2a231b, mid: 0x362c20, high: 0x3e352a, scale: 1.10, rough: 0.95, bump: 1.10, bumpFreq: 3.5, falloff: 0.54, hazeAmt: 0.34, heightVal: 0.26 }),
        sink: 0.04, tint: 0.18,
      },
      ruin: {
        geo: ruinBlocks(rng),
        mat: makeSurroundMaterial({ name: 'ruin', low: 0x3a3325, mid: 0x47402f, high: 0x263850, scale: 0.42, rough: 0.84, bump: 1.15, bumpFreq: 2.8, falloff: 0.58, hazeAmt: 0.34, heightVal: 0.30 }),
        sink: 0.18, tint: 0.16, valSpread: 0.26,
      },
      // Cut, coursed masonry: warmer and a full stop higher in value than the
      // wild rock, so the built things read as built and carry the upper half
      // of the surround's histogram.
      wall: {
        geo: wallSeg(rng),
        mat: makeSurroundMaterial({ name: 'wall', low: 0x6d6049, mid: 0x7f6e51, high: 0x53535f, scale: 0.55, rough: 0.80, bump: 0.85, bumpFreq: 3.0, falloff: 0.68, sat: 1.7, hazeAmt: 0.38, heightVal: 0.26, regionVal: 0.16, skyBounce: 0x101f2c }),
        sink: 0.0, tint: 0.14,
      },
      slab: {
        geo: slab(rng),
        // skyBounce raised well above the default. The east cliff faces -x/+z
        // and the key comes from +x/-z, so every visible face of it is a
        // shadow side; with the stock 0x07161f it read as a black hole at the
        // right frame edge. Gate G7 is explicit that shadows keep colour and
        // detail, and open rock under a night sky genuinely does bounce cool.
        mat: makeSurroundMaterial({ name: 'slab', low: 0x313329, mid: 0x3b3728, high: 0x343a46, scale: 0.36, rough: 0.88, slopeBias: -0.10, bump: 1.20, bumpFreq: 2.0, falloff: 0.62, hazeAmt: 0.36, heightVal: 0.36, skyBounce: 0x122a3c }),
        sink: 0.28, tint: 0.17, valSpread: 0.24,
      },
      kerb: {
        geo: kerb(rng),
        mat: makeSurroundMaterial({ name: 'kerb', low: 0x6b6350, mid: 0x7c6d53, high: 0x565660, scale: 0.7, rough: 0.82, bump: 0.9, bumpFreq: 3.4, falloff: 0.68, sat: 1.7, hazeAmt: 0.30, heightVal: 0.22 }),
        sink: 0.22, tint: 0.16,
      },
      house: {
        geo: house(rng),
        mat: makeSurroundMaterial({ name: 'house', low: 0x5b4f3c, mid: 0x6a5b42, high: 0x4c4a53, scale: 0.9, rough: 0.85, bump: 0.65, bumpFreq: 4.0, falloff: 0.66, sat: 1.6, hazeAmt: 0.34, heightVal: 0.22, regionVal: 0.10, vertexColors: true }),
        sink: 0.05, tint: 0.16,
      },
      conifer: {
        geo: conifer(rng),
        // ALL THREE ZONE COLOURS ARE GREEN, and slopeBias is negative.
        // The shared shader picks `high` by SLOPE — which is right for ground
        // and catastrophic for a cone: every needle skirt is a steep face, so
        // rockW pinned to 1 and the entire foreground occluder rendered in the
        // blue rock colour. It photographed as crumpled blue paper. A material
        // whose zones mean "turf / dirt / exposed rock" has no business on a
        // tree unless all three are set to what the tree is made of.
        mat: makeSurroundMaterial({ name: 'conifer', low: 0x27412c, mid: 0x2e4522, high: 0x182b1e, slopeBias: -0.40, scale: 1.4, rough: 0.95, detail: 0.6, bump: 0.55, bumpFreq: 3.0, falloff: 0.52, sat: 1.9, hazeAmt: 0.42, heightVal: 0.22, regionVal: 0.14, skyBounce: 0x0c1e26, vertexColors: true }),
        sink: 0.03, tint: 0.20,
      },
      /* ---- round 7, the scale ruler ------------------------------------
       * Sawn timber is a MATERIAL THE FRAME DID NOT HAVE: warm, mid-value,
       * low-chroma, and nothing else out here is made of it. That is worth as
       * much to defect 1 as it is to defect 3 — law 7's point is that the
       * reference's colour comes from many materials in one frame, and a
       * timber family is one more. Values sit just under the masonry so the
       * crates never out-punch the walls they stand against. */
      crate: {
        geo: crate(rng),
        mat: makeSurroundMaterial({ name: 'crate', low: 0x5c4a30, mid: 0x6b5636, high: 0x4e4638, scale: 1.6, rough: 0.88, detail: 0.7, bump: 0.9, bumpFreq: 5.0, falloff: 0.72, sat: 1.5, hazeAmt: 0.26, heightVal: 0.16, regionVal: 0.10, vertexColors: true }),
        sink: 0.0, tint: 0.22, valSpread: 0.24,
      },
      barrel: {
        geo: barrel(rng),
        mat: makeSurroundMaterial({ name: 'barrel', low: 0x513f2a, mid: 0x604a2f, high: 0x4a4740, scale: 1.8, rough: 0.86, detail: 0.7, bump: 0.9, bumpFreq: 5.5, falloff: 0.72, sat: 1.5, hazeAmt: 0.26, heightVal: 0.16, regionVal: 0.10, vertexColors: true }),
        sink: 0.0, tint: 0.22, valSpread: 0.22,
      },
      fence: {
        geo: fenceBay(rng),
        mat: makeSurroundMaterial({ name: 'fence', low: 0x574a35, mid: 0x66573c, high: 0x4c4740, scale: 1.5, rough: 0.92, detail: 0.7, bump: 0.8, bumpFreq: 6.0, falloff: 0.70, sat: 1.5, hazeAmt: 0.30, heightVal: 0.16, regionVal: 0.10, vertexColors: true }),
        sink: 0.0, tint: 0.20, valSpread: 0.22,
      },
      lamp: {
        geo: lampPost(),
        mat: makeSurroundMaterial({ name: 'lamp', low: 0x3f3a33, mid: 0x4b443a, high: 0x45443f, scale: 2.2, rough: 0.72, detail: 0.6, bump: 0.6, bumpFreq: 6.0, falloff: 0.74, sat: 1.4, hazeAmt: 0.26, heightVal: 0.14, regionVal: 0.08, vertexColors: true }),
        sink: 0.0, tint: 0.12, valSpread: 0.14,
      },
    };

    const m4 = new THREE.Matrix4();
    const qt = new THREE.Quaternion();
    const eu = new THREE.Euler();
    const pv = new THREE.Vector3();
    const sv = new THREE.Vector3();
    const col = new THREE.Color();

    // Conifers ride the same pipeline as everything else. Explicit sx/sy/sz so
    // the authored heights in STANDS.s survive: the generic path applies a
    // 0.7-1.45 random y factor, which would turn "11-17 unit foreground
    // spruce" into "8-25 unit" and lose control of the frame edge crop.
    for (const c of conifers) {
      const w = 0.86 + rng() * 0.30;
      place.push({
        set: 'conifer', x: c.x, z: c.z, s: c.s, yaw: c.yaw, upright: 0.30,
        sx: c.s * w, sy: c.s, sz: c.s * w * (0.94 + rng() * 0.12),
      });
    }

    for (const [key, def] of Object.entries(SETS)) {
      const items = place.filter((p) => p.set === key);
      if (!items.length) { def.geo.dispose(); def.mat.dispose(); continue; }
      const mesh = new THREE.InstancedMesh(def.geo, def.mat, items.length);
      mesh.name = `surround-${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const sx = it.sx ?? it.s, sy = it.sy ?? it.s, sz = it.sz ?? it.s;
        const sink = it.sink ?? def.sink * sy;
        const y = surroundHeight(it.x, it.z) - sink;
        pv.set(it.x, y, it.z);
        // A prop standing bolt upright on sloping ground is a giveaway; lean
        // each one partway toward the surface normal. Built things (walls,
        // houses) and trees lean LESS than boulders — a mason levels a
        // course, and a spruce grows toward the light, not toward the slope.
        const n = surroundNormal(it.x, it.z);
        const UPRIGHT = key === 'wall' || key === 'house' || key === 'kerb'
          || key === 'crate' || key === 'barrel' || key === 'fence' || key === 'lamp';
        const lean = it.upright ?? (UPRIGHT ? 0.22 : 0.55);
        eu.set(Math.atan2(-n.z, 1) * lean + (rng() - 0.5) * 0.08 + (it.tilt ?? 0),
               it.yaw,
               Math.atan2(n.x, 1) * lean + (rng() - 0.5) * 0.08);
        qt.setFromEuler(eu);
        if (it.sx !== undefined) sv.set(sx, sy, sz);
        else sv.set(sx * (0.78 + rng() * 0.5), sy * (0.7 + rng() * 0.75), sz * (0.78 + rng() * 0.5));
        m4.compose(pv, qt, sv);
        mesh.setMatrixAt(i, m4);
        const t = def.tint;
        // Hue jitter (t) and VALUE jitter (valSpread) are separate on purpose:
        // hue jitter alone leaves every instance at the same luminance, which
        // is what "uniformly lit" meant. instanceColor is a multiplier, so a
        // spread of +-0.32 is roughly a stop either way.
        // Skewed toward the DARK end on purpose: a symmetric spread makes as
        // many rocks brighter than the mean as darker, and law 8 gives the
        // surround the bottom of the value range. The first pass ran symmetric
        // over a mid-grey albedo and the boulder field came back reading as
        // polystyrene.
        const vs = def.valSpread ?? 0;
        const v = 1 - vs + Math.pow(rng(), 1.35) * 2 * vs;
        col.setRGB(v * (1 + (rng() - 0.5) * t),
                   v * (1 + (rng() - 0.5) * t * 0.8),
                   v * (1 + (rng() - 0.5) * t));
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.materials.push(def.mat);
      this.meshes.push(mesh);
      this.group.add(mesh);
    }

    /* --- lit windows ---------------------------------------------------
     * The reference's single strongest "this is inhabited" signal, and the
     * only warm high-chroma note anywhere in the surround. Unlit
     * MeshBasicMaterial above 1.0 so it survives ACES as a hot point and
     * feeds bloom. Two tris each; 20-ish of them.
     * ------------------------------------------------------------------ */
    if (windows.length) {
      const wmat = new THREE.MeshBasicMaterial({
        name: 'window', side: THREE.DoubleSide, toneMapped: true,
        color: new THREE.Color(0xffb257).multiplyScalar(2.6),
      });
      wmat.userData.noAO = true;                     // PITFALLS 3
      this.materials.push(wmat);
      const mesh = new THREE.InstancedMesh(windowQuad(), wmat, windows.length);
      mesh.name = 'surround-window';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.userData.noAO = true;
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        const c = Math.cos(w.yaw), s = Math.sin(w.yaw);
        // House local +z is the camera-facing wall (see the yaw above). The
        // body is 0.95 deep, so the wall plane is at local z = 0.475; 0.52
        // stands the quad proud of it and absorbs the small lean the house
        // instance gets from the slope that this quad does not.
        if (w.abs) {
          pv.set(w.px, w.py, w.pz);
        } else {
          const lx = w.u * w.s, lz = 0.52 * w.s;
          pv.set(w.x + lx * c + lz * s,
                 surroundHeight(w.x, w.z) - 0.12 + w.v * w.s,
                 w.z - lx * s + lz * c);
        }
        eu.set(0, w.yaw, 0);
        qt.setFromEuler(eu);
        const ws = w.abs ? 1 : w.s;
        sv.set(w.w * ws, w.h * ws, 1);
        m4.compose(pv, qt, sv);
        mesh.setMatrixAt(i, m4);
        // Not every hearth burns the same colour.
        col.setRGB(1, 0.80 + w.warm * 0.30, 0.55 + w.warm * 0.55);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }

    /* --- scrub: wind-animated so the frame is never dead (G6) ----------- */
    if (tufts.length) {
      const tmat = makeSurroundMaterial({
        name: 'scrub', low: 0x1c3018, mid: 0x2c3814, high: 0x141f12,
        // A dry straw variant on the same 55-unit regional field the ground
        // uses, so the grass goes bleached in the same places the turf does
        // and the two agree instead of arguing.
        dry: 0x4a4426, dryAmt: 0.65, patchAmt: 0.40,
        scale: 1.9, rough: 1.0, detail: 0.55, bump: 0.0, falloff: 0.56,
        hazeAmt: 0.30, heightVal: 0.22, regionVal: 0.18,
      });
      tmat.side = THREE.DoubleSide;
      tmat.userData.uniforms.uTime = { value: 0 };
      const base = tmat.onBeforeCompile;
      tmat.onBeforeCompile = (shader) => {
        base(shader);
        shader.uniforms.uTime = tmat.userData.uniforms.uTime;
        shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            {
              vec3 ip = vec3(0.0);
              #ifdef USE_INSTANCING
                ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
              #endif
              // Bend proportional to height above the root, so blades pivot
              // at the ground instead of sliding sideways as a block.
              float bend = max(transformed.y, 0.0);
              float ph = ip.x * 0.21 + ip.z * 0.17;
              float w = sin(uTime * 1.15 + ph) * 0.5 + sin(uTime * 0.47 + ph * 2.3) * 0.5;
              transformed.x += w * bend * 0.24;
              transformed.z += cos(uTime * 0.83 + ph * 1.7) * bend * 0.16;
            }`);
      };
      this.scrubMat = tmat;
      this.materials.push(tmat);

      const mesh = new THREE.InstancedMesh(tuft(rng), tmat, tufts.length);
      mesh.name = 'surround-scrub';
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < tufts.length; i++) {
        const t = tufts[i];
        pv.set(t.x, surroundHeight(t.x, t.z) - 0.04, t.z);
        eu.set(0, t.yaw, 0);
        qt.setFromEuler(eu);
        sv.set(t.s * (0.85 + rng() * 0.35), t.s * (0.8 + rng() * 0.45), t.s * (0.85 + rng() * 0.35));
        m4.compose(pv, qt, sv);
        mesh.setMatrixAt(i, m4);
        col.setRGB(1 + (rng() - 0.5) * 0.34, 1 + (rng() - 0.5) * 0.26, 1 + (rng() - 0.5) * 0.34);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /* ----------------------------------------------------------------
   * THE ROAD RIBBON.
   *
   * One triangle strip laid on the road corridor. Every vertex samples
   * surroundHeight() — the same function the ground mesh samples — and the
   * corridor is flattened to the authored centreline elevation there, so the
   * two agree exactly and a 7cm lift is enough to stay off the ground without
   * peter-panning (gate G9).
   *
   * Its material is the brightest and warmest surface outside the board. That
   * is deliberate: it is the frame's largest single piece of large-scale value
   * variation, and it draws a line from the top edge to the bottom edge that
   * the eye follows out of frame at both ends.
   * ---------------------------------------------------------------- */
  #buildRoad() {
    const P = ROAD_PATH;
    /* ROUND 7 — THE EDGE DISSOLVES.
     *
     * Blind critic: "the brown dirt band at the right edge is a raw hue with no
     * blending... a straight diagonal edge runs from upper-right to lower-
     * right". Both are the same defect: the ribbon was exactly ROAD_HW wide and
     * ended on a ruled line, so the transition from pavement to grass happened
     * across one pixel at every point along a 90-unit curve.
     *
     * The strip is now 1.6x as wide, carries an `aEdge` attribute (0 at the
     * centreline, 1 at the rim), and the shared shader alpha-cuts the outer
     * third against a two-octave noise field. The result is a 2.5-unit ragged
     * fringe of pavement crumbling into the worn dirt corridor that the ground
     * mesh paints underneath it (see wearAt), which is three materials meeting
     * over five units instead of two meeting over none.
     *
     * ALPHA TEST, not transparency: an alpha-blended sheet lying on the ground
     * would sort against the terrain every frame and would need depthWrite
     * off, and PITFALLS 3 then pulls it out of the AO buffer for a different
     * reason. A cutout keeps it opaque, keeps it depth-correct and costs
     * nothing. */
    const COLS = 9;
    const WIDEN = 1.6;
    // Clip to the band any camera can reach; the control curve runs well past
    // it so the tangents at the visible ends are still correct.
    const i0 = P.findIndex((p) => p.z > -86);
    const i1 = P.length - 1 - [...P].reverse().findIndex((p) => p.z < 62);
    const lo = Math.max(0, i0), hi = Math.min(P.length - 1, i1);
    const rows = hi - lo + 1;
    if (rows < 2) return;

    const pos = new Float32Array(rows * COLS * 3);
    const nrm = new Float32Array(rows * COLS * 3);
    const edge = new Float32Array(rows * COLS);
    const n = new THREE.Vector3();
    for (let r = 0; r < rows; r++) {
      const p = P[lo + r];
      const a = P[Math.max(lo, lo + r - 1)], b = P[Math.min(hi, lo + r + 1)];
      const tx = b.x - a.x, tz = b.z - a.z;
      const L = Math.hypot(tx, tz) || 1;
      const nx = -tz / L, nz = tx / L;
      for (let c = 0; c < COLS; c++) {
        // Width wander, at a wavelength of ~120 samples rather than ~30.
        // The first version oscillated +-10% every three rows, and since a row
        // is about one world unit, the verge came out as a regular sawtooth
        // 40px across — a texture, not a road. A road's width varies over its
        // LENGTH, on the scale of the road, or it reads as a serration.
        const hw = ROAD_HW * WIDEN * (0.94 + 0.06 * Math.sin((lo + r) * 0.052));
        const t = (c / (COLS - 1) - 0.5) * 2;          // -1 .. 1
        const u = t * hw;
        const x = p.x + nx * u, z = p.z + nz * u;
        const o = (r * COLS + c) * 3;
        // Sampling surroundHeight (rather than the flattened centreline
        // elevation) is what lets the widened rim ride UP the shoulder berm
        // instead of slicing through it.
        pos[o] = x; pos[o + 1] = surroundHeight(x, z) + 0.07; pos[o + 2] = z;
        surroundNormal(x, z, n);
        nrm[o] = n.x; nrm[o + 1] = n.y; nrm[o + 2] = n.z;
        edge[r * COLS + c] = Math.abs(t);
      }
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = r * COLS + c, b = a + 1, d = (r + 1) * COLS + c, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const mat = makeSurroundMaterial({
      name: 'road',
      // Pulled down ~12% in value and given a THIRD albedo (uDry, here the
      // paler compacted centre wheel-track) so the surface is not one flat
      // hue either. It is still the brightest thing outside the board.
      low: 0x8d8471, mid: 0xa2947a, high: 0x7d786c,
      dry: 0xb4a88d, dryAmt: 0.70,
      patchAmt: 0.30, edgeAmt: 1.0,
      scale: 0.28, rough: 0.86, detail: 0.9, bump: 0.7, bumpFreq: 2.2,
      // The road is the ONE surface out here that is allowed to be pale and
      // warm. First pass ran it through the standard 0.74 falloff and the
      // standard 0x5fd2ff cool tint and it photographed as a rust stain — the
      // cool multiplier alone takes 60% of the red channel out at k=1. A
      // near-neutral tint and a high falloff floor are what keep it reading as
      // dust in low sun rather than as mud.
      falloff: 0.80, sat: 1.00, hazeAmt: 0.30, heightVal: 0.16, regionVal: 0.12,
      coolTint: 0xcfe6ff, skyBounce: 0x0d1a22,
    });
    mat.side = THREE.DoubleSide;      // the strip is thin; never risk culling it
    mat.alphaTest = 0.5;              // enables <alphatest_fragment>; see uEdgeAmt
    this.materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'surround-road';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    // The AO prepass uses an override material and cannot see the alpha cut
    // (PITFALLS 3), so the fringe would occlude as a solid rectangle.
    mesh.userData.noAO = true;
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  /* ----------------------------------------------------------------
   * THE WATER BASIN.
   *
   * A grid over the basin ellipse, emitting a quad only where the terrain is
   * genuinely BELOW the water line. That is what stops a water plane poking
   * through the hillside it is supposed to be sunk into, and it means the
   * shoreline is the terrain's shape rather than an ellipse drawn on top.
   * ---------------------------------------------------------------- */
  #buildWater() {
    const N = 44;
    const { x: cx, z: cz, rx, rz, y: wy } = BASIN;
    const V = [], I = [];
    const gridIdx = new Int32Array((N + 1) * (N + 1)).fill(-1);
    const wet = new Uint8Array((N + 1) * (N + 1));
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const x = cx + (i / N * 2 - 1) * rx;
        const z = cz + (j / N * 2 - 1) * rz;
        const k = i * (N + 1) + j;
        if (surroundHeight(x, z) < wy - 0.04) {
          wet[k] = 1;
          gridIdx[k] = V.length / 3;
          V.push(x, wy, z);
        }
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const a = gridIdx[i * (N + 1) + j];
        const b = gridIdx[i * (N + 1) + j + 1];
        const c = gridIdx[(i + 1) * (N + 1) + j];
        const d = gridIdx[(i + 1) * (N + 1) + j + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        // +Y facing: a=(x,z) b=(x,z+dz) c=(x+dx,z). (b-a)x(c-a) = +Y.
        I.push(a, b, c, b, d, c);
      }
    }
    if (!I.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V), 3));
    geo.setIndex(I);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    // Low roughness + real metalness so it picks up the environment and the
    // key as a specular sheet. The only genuinely smooth surface outside the
    // board, which is precisely why it reads.
    const mat = new THREE.MeshStandardMaterial({
      name: 'water',
      color: 0x0d2a3c, roughness: 0.09, metalness: 0.55,
      emissive: new THREE.Color(0x0b3550), emissiveIntensity: 0.55,
    });
    mat.userData.uniforms = { uTime: { value: 0 } };
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = mat.userData.uniforms.uTime;
      shader.vertexShader = 'varying vec3 vWWorld;\n' + shader.vertexShader
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n vWWorld = (modelMatrix * vec4(transformed,1.0)).xyz;');
      shader.fragmentShader = 'uniform float uTime;\nvarying vec3 vWWorld;\n' + shader.fragmentShader
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          {
            // Three crossed wave trains at incommensurable frequencies, so the
            // surface never repeats and never reads as a sine grid.
            vec2 p = vWWorld.xz;
            float g1 = cos(dot(p, vec2( 0.91, 0.41)) * 1.35 + uTime * 0.85);
            float g2 = cos(dot(p, vec2(-0.38, 0.92)) * 2.10 - uTime * 0.61);
            float g3 = cos(dot(p, vec2( 0.62,-0.78)) * 3.35 + uTime * 1.24);
            vec3 W = vec3(
              g1 * 0.91 * 1.35 * 0.055 + g2 * -0.38 * 2.10 * 0.030 + g3 * 0.62 * 3.35 * 0.014,
              0.0,
              g1 * 0.41 * 1.35 * 0.055 + g2 *  0.92 * 2.10 * 0.030 + g3 * -0.78 * 3.35 * 0.014);
            normal = normalize(normal + (viewMatrix * vec4(W, 0.0)).xyz);
          }`);
    };
    mat.customProgramCacheKey = () => 'surround-water';
    this.waterMat = mat;
    this.materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'surround-water';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    // Opaque, but a mirror-flat sheet in the AO G-buffer paints a hard dark
    // wedge across the bank behind it (PITFALLS 3).
    mesh.userData.noAO = true;
    this.meshes.push(mesh);
    this.group.add(mesh);
  }

  update(dt, elapsed) {
    if (this.scrubMat) this.scrubMat.userData.uniforms.uTime.value = elapsed;
    if (this.waterMat) this.waterMat.userData.uniforms.uTime.value = elapsed;
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
}
