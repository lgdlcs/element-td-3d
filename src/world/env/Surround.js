import * as THREE from 'three';

/* ==================================================================
 * THE SURROUND — the world the arena sits IN.
 *
 * ROUND 4 rewrite. Rounds 1-3 built a "backdrop": rings of silhouetted ruin
 * hanging in a void at radius 172-372 and depth y = -34 .. -340. Three blind
 * critics in a row failed gate G1 against it, and a measurement finally
 * explained why the fixes never landed:
 *
 *   camera (-7.4, 58.6, 41.6), target origin, fov 40 => pitch 54.2 deg,
 *   top-of-frame depression 34.2 deg.
 *
 *   Any GROUND at the board's level therefore fills the frame all the way to
 *   the top edge at 87 units from the camera. Nothing beyond that horizontal
 *   distance can be on screen at all.
 *
 * So every ruin in the old backdrop was only ever visible BECAUSE it hung in
 * the void below the horizon line. It could never read as "landscape"; it
 * could only ever read as objects floating in front of a gradient. That is
 * exactly what the critic described.
 *
 * The reference frames (Element TD 2) contain no void, no horizon band and no
 * silhouette layer. They are a continuous, fully lit, fully saturated
 * landscape running off all four frame edges, with the play area embedded in
 * it as a raised terrace. Depth comes from OVERLAP and from props cropped by
 * the frame edge, not from parallax bands.
 *
 * This file therefore builds:
 *   1. a continuous heightfield that starts UNDER the arena rim and runs out
 *      to r = 300 (only r < ~110 is ever on screen, the rest is for zoom-out),
 *   2. clustered, aperiodic props standing on it,
 *   3. a foreground cluster between the camera and the board's near corner,
 *      cropped by the bottom frame edge.
 *
 * Everything uses MeshStandardMaterial so it receives the same key/fill/rim
 * rig, the same env map, the same shadows, the same tonemap and the same fog
 * as the board. "Same fidelity as the play area" is not achievable with a
 * bespoke unlit shader; it is achievable by being lit by the same lights.
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* Arena footprint. Arena.js: play field 52 x 40, rim reaches RIM_T*0.48
 * beyond it, outer ground geometry stops at 54.64 x 42.64. The surround
 * shelf sits at SHELF, safely below the arena's lowest skirt vertex
 * (~ -0.10) so the two never z-fight, and tucks under the rim fascia
 * (bottom at +0.14) so no void is ever visible through the joint.         */
/* ------------------------------------------------------------------ */
export const ARENA_HW = 27.0;
export const ARENA_HH = 21.0;
/* Round 4, coordinator arbitration: the arena rim/underbelly is being replaced
 * by a low coursed-masonry retaining wall, and the surround must continue
 * outward from the far side of it at LANE-FLOOR level so the board reads as cut
 * into the landscape rather than perched on it. Arena.laneFloor is
 * plateauTop(0.20) - uRoadDepth(1.00) = -0.80, measured live. */
export const SHELF = -0.80;

/** Signed distance to the arena rectangle: <= 0 inside, > 0 outside. */
export function arenaEdgeDist(x, z) {
  const dx = Math.abs(x) - ARENA_HW;
  const dz = Math.abs(z) - ARENA_HH;
  const ox = Math.max(dx, 0), oz = Math.max(dz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0);
}

/* ------------------------------------------------------------------ */
/* Deterministic 2D value noise (JS side).                             */
/* The heightfield has to be queryable from JS so props can be planted  */
/* ON the ground rather than floating above or sunk into it, and so the */
/* mesh normals can be analytic instead of polar-grid artefacts.        */
/* ------------------------------------------------------------------ */
function h2(ix, iz) {
  let n = ix * 374761393 + iz * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
}
function vn2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = h2(ix, iz), b = h2(ix + 1, iz), c = h2(ix, iz + 1), d = h2(ix + 1, iz + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
}
function fbm2(x, z, oct) {
  let a = 0.5, s = 0, fx = x, fz = z;
  for (let i = 0; i < oct; i++) {
    s += a * vn2(fx, fz);
    fx = fx * 2.07 + 13.1; fz = fz * 2.07 + 7.3;
    a *= 0.5;
  }
  return s;
}
const sstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* ==================================================================
 * ROUND 5 — AUTHORED LANDFORM. (Art Bible sec 0, law 5.)
 *
 * Round 4's heightfield was three octaves of fbm plus a radially symmetric
 * "basin wall". Three blind critics then called the surround
 * "undifferentiated", "flat black-blue ground", "the world does not continue
 * anywhere" — and the reason is structural, not a tuning miss:
 *
 *   fbm is stationary. Its statistics are identical at every point by
 *   construction, and a radial term is identical at every azimuth by
 *   construction. A field that is the same everywhere IS undifferentiated.
 *   No amplitude, no octave count and no lacunarity can produce a landmark,
 *   because a landmark is a place that differs from the places around it.
 *
 * So the macro form is now a hand-written list of named masses at chosen
 * coordinates, and the noise is demoted to surface roughness on top of them.
 * Every entry in LANDFORMS below is a decision, not a sample.
 *
 * The coordinates were chosen against the MEASURED visible ground quad at the
 * shipping camera (-6.94, 58.17, 43), fov 40, 16:9 — unprojected onto y=-0.8:
 *
 *     TL(-58.6,-60.5)   TM( 8.0,-49.8)   TR( 74.6,-39.0)
 *     ML(-47.4,-10.0)                    MR( 48.1,  5.4)
 *     BL(-41.1, 18.2)   BM(-3.9, 24.2)   BR( 33.3, 30.2)
 *
 * Two consequences that drive every placement in this file and in Backdrop.js:
 *
 *   - The visible surround is only ~29 units deep at the top of frame and
 *     ~3 units deep at the bottom. There is no room for a "distant layer" at
 *     an actually distant radius; distance has to be carried by SCALE,
 *     AERIAL PERSPECTIVE and by masses running off the top edge.
 *   - Anything at height h is cropped by the top edge once
 *     h > (49.8 + z) * 0.61. The escarpment below crosses that line around
 *     z = -38, which is deliberate: the top of frame is filled by a rising
 *     hillside that is cut off by the frame, which is law 2 (depth from
 *     overlap) rather than law 1 (merely covering the screen).
 * ================================================================== */

/**
 * Named macro masses. Hand-placed. Read this list as a plan view of the frame.
 *
 *   k     'ridge' rounded spine | 'mesa' flat top + steep terraced sides
 *         | 'bowl' depression
 *   rot   radians, rotates the ellipse
 *   h     peak height above the shelf (negative digs)
 */
export const LANDFORMS = [
  // NORTH ESCARPMENT — the hillside the world climbs into at the top of
  // frame. Long and shallow-angled so it is cropped by the top edge rather
  // than ending inside it.
  { n: 'north-escarpment', k: 'ridge', x: 2, z: -47, rx: 74, rz: 27, h: 20.0, rot: -0.10 },
  // UPPER-RIGHT CLIFF. The reference's "carved rock cliffs at upper-right".
  // Terraced hard, so it has genuine lit faces and shadowed risers.
  { n: 'east-cliff', k: 'mesa', x: 60, z: -30, rx: 27, rz: 25, h: 22.0, rot: 0.34 },
  // UPPER-LEFT SETTLEMENT HILL. Kept LOW on purpose: it stacks on top of the
  // escarpment, and the pair has to stay under the top-edge crop line
  // h < (49.8 + z) * 0.61 or the settlement is off screen entirely.
  { n: 'west-hill', k: 'mesa', x: -58, z: -26, rx: 24, rz: 22, h: 7.0, rot: -0.30 },
  // WEST TERRACES — "low retaining walls step up the left edge".
  { n: 'west-bench', k: 'ridge', x: -50, z: 2, rx: 15, rz: 30, h: 8.0, rot: 0.10 },
  // SOUTH-EAST FOREGROUND SHELF. Carries the foreground occluder stand, and
  // lifts it so the trees crop the bottom edge instead of standing in it.
  // A foreground occluder standing on flat ground is not an occluder — it is
  // just a tall thing next to the board. These two banks lift the near-corner
  // tree stands by ~4 units at the frame's bottom edge, which is what lets
  // their crowns rise across the board's near corners instead of sitting
  // politely beside them. Centres moved inward from x +-43 after the first
  // capture put the shelf entirely outside the visible bottom corners.
  { n: 'se-shelf', k: 'ridge', x: 32, z: 27, rx: 15, rz: 11, h: 7.0, rot: 0.40 },
  // SOUTH-WEST FOREGROUND SHELF, the bottom-left counterweight.
  { n: 'sw-shelf', k: 'ridge', x: -33, z: 26, rx: 15, rz: 10, h: 6.2, rot: -0.35 },
  // THE BASIN. A dug hollow that holds water, mid-left, cropped by the left
  // frame edge so the pool runs out of frame.
  { n: 'basin', k: 'bowl', x: -39.5, z: 4, rx: 9.5, rz: 7.5, h: -3.1, rot: 0.2 },
  // A quiet swell north-west so the left half is not one flat run into the
  // hill. Deliberately unremarkable: empty ground is part of the composition.
  { n: 'nw-swell', k: 'ridge', x: -30, z: -30, rx: 16, rz: 12, h: 3.4, rot: 0.5 },
];

/* ------------------------------------------------------------------ */
/* THE ROAD.                                                            */
/*                                                                      */
/* Law 5's single most load-bearing element: a road that ENTERS the frame */
/* at one edge and EXITS at another. Both ends are cropped, which is the  */
/* only cheap way to assert that the world has somewhere else to be.     */
/*                                                                      */
/* This one comes down off the north escarpment, passes through the      */
/* gatehouse at (26,-30), runs down the east side of the board and exits */
/* the bottom edge of frame at (33,40). Third component is the authored   */
/* elevation of the centreline: it descends 19 units across the frame,    */
/* which is where most of the surround's large-scale value structure      */
/* comes from.                                                           */
/* ------------------------------------------------------------------ */
export const ROAD_CTRL = [
  [-26, -78, 24.0],
  [-14, -68, 20.5],
  [-2, -57, 15.0],
  [11, -44, 8.6],
  [22, -35, 3.4],
  [30.5, -24, 0.6],
  [37.5, -11, -0.5],
  [39.5, 2, -0.9],
  [37.5, 15, -1.5],
  [34.5, 27, -2.8],
  [32.0, 40, -5.2],
  [30.0, 54, -8.0],
];
export const ROAD_HW = 3.5;          // half width of the paved surface
export const ROAD_SHOULDER = 6.0;    // corridor over which terrain blends in

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Densely sampled centreline: {x, z, y}. Built once at module load. */
export const ROAD_PATH = (() => {
  const C = ROAD_CTRL, out = [];
  const at = (i) => C[Math.min(C.length - 1, Math.max(0, i))];
  const SUB = 14;
  for (let i = 0; i < C.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB;
      out.push({
        x: catmull(p0[0], p1[0], p2[0], p3[0], t),
        z: catmull(p0[1], p1[1], p2[1], p3[1], t),
        y: catmull(p0[2], p1[2], p2[2], p3[2], t),
      });
    }
  }
  out.push({ x: C.at(-1)[0], z: C.at(-1)[1], y: C.at(-1)[2] });
  return out;
})();

const ROAD_BB = (() => {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const p of ROAD_PATH) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  const m = ROAD_HW + ROAD_SHOULDER + 2;
  return { x0: x0 - m, x1: x1 + m, z0: z0 - m, z1: z1 + m };
})();

/**
 * Nearest-point query against the road centreline.
 * @returns {{lat:number, y:number, s:number, w:number, tx:number, tz:number}}
 *   lat  lateral distance from the centreline
 *   y    authored centreline elevation at the nearest point
 *   s    0..1 along the road
 *   w    corridor weight, 1 on the pavement falling to 0 past the shoulder
 *   tx,tz unit tangent (used to lay the ribbon and the kerbs)
 */
export function roadQuery(x, z) {
  if (x < ROAD_BB.x0 || x > ROAD_BB.x1 || z < ROAD_BB.z0 || z > ROAD_BB.z1) {
    return { lat: 1e9, y: 0, s: 0, w: 0, tx: 0, tz: 1 };
  }
  const P = ROAD_PATH;
  let best = Infinity, by = 0, bs = 0, btx = 0, btz = 1;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const ex = b.x - a.x, ez = b.z - a.z;
    const L2 = ex * ex + ez * ez || 1e-6;
    let t = ((x - a.x) * ex + (z - a.z) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + ex * t, pz = a.z + ez * t;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < best) {
      best = d2;
      by = a.y + (b.y - a.y) * t;
      bs = (i + t) / (P.length - 1);
      const L = Math.sqrt(L2);
      btx = ex / L; btz = ez / L;
    }
  }
  const lat = Math.sqrt(best);
  return {
    lat, y: by, s: bs, tx: btx, tz: btz,
    w: 1 - sstep(ROAD_HW, ROAD_HW + ROAD_SHOULDER, lat),
  };
}

/** One landform's contribution at (x,z). */
function landform(L, x, z) {
  const c = Math.cos(L.rot || 0), s = Math.sin(L.rot || 0);
  const dx = x - L.x, dz = z - L.z;
  const u = (dx * c + dz * s) / L.rx;
  const v = (-dx * s + dz * c) / L.rz;
  // Warp the radius with a mid-wavelength field so no mass is ever an
  // ellipse. Seeded off the landform's own coordinates so each is different.
  const q = Math.hypot(u, v)
    * (1 + (vn2(x * 0.042 + L.x * 0.7, z * 0.042 + L.z * 0.7) - 0.5) * 0.42);
  if (q >= 1) return 0;
  if (L.k === 'mesa') return L.h * sstep(1.0, 0.44, q);
  if (L.k === 'bowl') return L.h * sstep(1.0, 0.34, q);
  return L.h * sstep(1.0, 0.0, q);
}

/**
 * Cut a smooth height into flat treads and steep risers.
 *
 * This is what gives the surround LIT FACES AND SHADOWED FACES. Two critics
 * read the flat round-4 surround as "no key light direction"; the shadows
 * were correct, there was simply no geometry out there for the key to break
 * across. A terrace riser is a near-vertical surface with a definite normal,
 * so the key either hits it or does not, and the ground finally returns
 * something other than a constant.
 */
function terrace(h, step, phase) {
  const k = h / step + phase;
  const i = Math.floor(k), f = k - i;
  return (i + sstep(0.32, 0.68, f) - phase) * step;
}

/* ------------------------------------------------------------------
 * THE HEIGHTFIELD.
 * ------------------------------------------------------------------ */
export function surroundHeight(x, z) {
  const d = arenaEdgeDist(x, z);
  if (d <= 0) return SHELF;

  // Contact: hold the apron dead flat, then let relief in gradually. A hard
  // start here is the classic "geometry pasted onto geometry" tell.
  const t = sstep(0.5, 13.0, d);

  // ---- authored macro form -----------------------------------------
  let macro = 0;
  for (let i = 0; i < LANDFORMS.length; i++) macro += landform(LANDFORMS[i], x, z);

  // Terrace the high ground only, with a phase that wanders on a long
  // wavelength so the treads never read as contour lines drawn on a map.
  if (macro > 2.0) {
    const w = sstep(2.0, 7.0, macro) * (0.55 + 0.45 * vn2(x * 0.011 + 5.0, z * 0.011 + 17.0));
    const ph = vn2(x * 0.008 + 41.0, z * 0.008 + 3.0);
    macro += (terrace(macro, 3.3, ph) - macro) * w;
  }

  // ---- surface roughness on top of the authored form ----------------
  // Amplitude cut from round 4's +-3.6 to +-1.9: the macro masses now carry
  // the silhouette, and loud noise on top of them only blurs the landmarks
  // back into the undifferentiated field this rewrite exists to remove.
  const roll =
      (fbm2(x * 0.0295, z * 0.0295, 3) - 0.5) * 2.3
    + (fbm2(x * 0.083 + 31.7, z * 0.083 + 11.3, 2) - 0.5) * 1.3
    + (vn2(x * 0.21 + 61.0, z * 0.21 + 5.0) - 0.5) * 0.5;

  // Far mass, for the zoomed-out frame only. Nothing beyond ~94 units from
  // the camera is ever on screen at default framing.
  const far = sstep(110.0, 300.0, d) * (34.0 + 40.0 * vn2(x * 0.006 + 3.0, z * 0.006 + 9.0));

  let h = SHELF - 0.55 * t + (macro + roll) * t + far;

  // ---- the road cut -------------------------------------------------
  // A road is a thing done TO terrain: cut into the uphill side, embanked on
  // the downhill side, dead flat across its width. Blending toward an
  // authored centreline elevation produces all three for free.
  const r = roadQuery(x, z);
  if (r.w > 0) {
    const target = SHELF + r.y;
    // A raised shoulder berm just outside the pavement, so the road reads as
    // built rather than painted, and casts its own thin shadow.
    // Onset is strictly OUTSIDE the pavement half-width, so the berm term is
    // exactly zero everywhere the road ribbon mesh sits and the two can never
    // disagree about where the ground is (gate G9).
    // ROUND 7: cut 0.55 -> 0.34 and pushed outward. The berm was drawing its
    // own hard line right where the ribbon's new dissolving edge has to live
    // (see Backdrop #buildRoad), and two hard lines two units apart read as one
    // thick hard line. The road still reads as built; the shoulder is now a
    // swell rather than a kerb of earth.
    const berm = 0.34
      * sstep(ROAD_HW * 1.30, ROAD_HW * 1.9, r.lat)
      * (1 - sstep(ROAD_HW * 1.9, ROAD_HW * 3.1, r.lat));
    h += (target - h) * r.w * t;
    h += berm * r.w * t;
  }
  return h;
}

/** Analytic-ish normal by central difference. */
export function surroundNormal(x, z, out = new THREE.Vector3()) {
  const e = 0.45;
  const hx = surroundHeight(x + e, z) - surroundHeight(x - e, z);
  const hz = surroundHeight(x, z + e) - surroundHeight(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

/* ------------------------------------------------------------------ */
/* Procedural surface shading, shared by the ground and every prop.     */
/*                                                                      */
/* This is injected into MeshStandardMaterial rather than replacing it.  */
/* PITFALLS entry 1 is the reason there is no canvas texture anywhere    */
/* here: everything is evaluated in world space in the fragment shader,  */
/* so there is no image, no alpha channel and nothing to premultiply.    */
/* ------------------------------------------------------------------ */
const GLSL_NOISE = /* glsl */`
  float sh2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float svn2(vec2 x){
    vec2 i = floor(x), f = fract(x);
    f = f*f*(3.0-2.0*f);
    return mix(mix(sh2(i), sh2(i+vec2(1.0,0.0)), f.x),
               mix(sh2(i+vec2(0.0,1.0)), sh2(i+vec2(1.0,1.0)), f.x), f.y);
  }
  float sfbm2(vec2 p, int oct){
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * svn2(p); p = p*2.07 + 13.1; a *= 0.5; }
    return s;
  }
`;

/**
 * MeshStandardMaterial + world-space procedural albedo / roughness.
 *
 * @param opts.low   colour of flat, sheltered ground (turf / moss / silt)
 * @param opts.mid   colour of worn, walked, dusty ground
 * @param opts.high  colour of exposed rock on steep faces
 * @param opts.scale base feature size in world units
 */
export function makeSurroundMaterial({
  low = 0x2c4a3c, mid = 0x5c5443, high = 0x4a5164,
  scale = 0.055, rough = 0.92, slopeBias = 0.0, detail = 1.0, bump = 0.55,
  bumpFreq = 0.5, falloff = 0.46, sat = 1.85, coolTint = 0x5fd2ff, skyBounce = 0x07161f,
  haze = 0x1c3252, hazeAmt = 0.30, heightVal = 0.30, regionVal = 0.26,
  /* ---- round 7: DISTINCT ALBEDOS, not more chroma. --------------------
   * Three blind critics: "grass is a single high-chroma yellow-green with no
   * variation", "no texture, no variation, no detail objects". Art Bible law 7
   * is explicit that the reference's richness comes from many differently
   * coloured materials in one frame and that a global chroma multiply produces
   * fluorescence instead. So the answer is more MATERIALS on the same surface,
   * each with its own hue AND its own value, plus a large-scale value breakup:
   *   dry    sun-bleached grass, on a ~55-unit regional field
   *   worn   trampled earth, driven by the aWear vertex attribute (roads,
   *          the board apron, authored yards) with a noise-ragged boundary
   *   patch  slow tonal/shadow patches at 30-80 units, so the field has
   *          light and dark areas the way a landscape under broken cloud does
   * All three default to OFF (amount 0) so every prop material is unchanged
   * unless it opts in. */
  dry = 0x46442c, dryAmt = 0.0,
  worn = 0x4a3a28, wearAmt = 0.0,
  patchAmt = 0.0,
  /* Dissolving alpha fringe, for the road ribbon. Needs material.alphaTest. */
  edgeAmt = 0.0,
  vertexColors = false,
  name = 'surround',
} = {}) {
  const mat = new THREE.MeshStandardMaterial({
    name,
    color: 0xffffff,
    roughness: rough,
    metalness: 0.02,
    vertexColors,
    dithering: true,
  });
  mat.userData.uniforms = {
    uLow: { value: new THREE.Color(low) },
    uMid: { value: new THREE.Color(mid) },
    uHigh: { value: new THREE.Color(high) },
    uScale: { value: scale },
    uSlopeBias: { value: slopeBias },
    uDetail: { value: detail },
    uBump: { value: bump },
    uBumpFreq: { value: bumpFreq },
    uFalloff: { value: falloff },
    uSat: { value: sat },
    uCoolTint: { value: new THREE.Color(coolTint) },
    uSkyBounce: { value: new THREE.Color(skyBounce) },
    uHaze: { value: new THREE.Color(haze) },
    uHazeAmt: { value: hazeAmt },
    uHeightVal: { value: heightVal },
    uRegionVal: { value: regionVal },
    uDry: { value: new THREE.Color(dry) },
    uDryAmt: { value: dryAmt },
    uWorn: { value: new THREE.Color(worn) },
    uWearAmt: { value: wearAmt },
    uPatchAmt: { value: patchAmt },
    uEdgeAmt: { value: edgeAmt },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);

    /* ----------------------------------------------------------------
     * SHADOW FRUSTUM FADE.
     *
     * The key light's shadow camera is 92x92 (Lighting.js: +-46), sized for
     * a 52x40 board. The surround runs to r=300, so the frame now contains
     * the EDGE of that frustum: inside it the ground is shadowed by props,
     * outside it three's getShadow() returns 1.0 unconditionally, and the
     * join is a hard axis-aligned rectangle straight across the landscape.
     * Verified by ablation — setting receiveShadow=false on the ground made
     * the rectangle disappear and changed nothing else.
     *
     * Real shadows still matter within a few tens of units of the board, so
     * rather than dropping them we ramp the shadow term back to "unshadowed"
     * over r = 30..44, comfortably inside the frustum's inscribed circle.
     * The transition is then a smooth radial gradient instead of a corner.
     *
     * The proper fix is a larger or cascaded shadow camera, which lives in
     * Lighting.js and is not this agent's file.
     * ---------------------------------------------------------------- */
    const LFB = THREE.ShaderChunk.lights_fragment_begin;
    const marker = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow(';
    if (LFB.includes(marker)) {
      const patched = LFB.replace(
        /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\(([^;]*?)\) : 1\.0;/,
        'directLight.color *= mix( 1.0, ( directLight.visible && receiveShadow ) ? getShadow($1) : 1.0, vSurShadowFade );');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <lights_fragment_begin>', patched);
    }

    /* aWear / aEdge are OPTIONAL vertex attributes. A geometry that does not
     * supply them leaves the generic attribute at its WebGL default of
     * (0,0,0,1), so every prop and every instanced set reads 0 and is
     * unaffected — no shader variant, no second material, no branch. */
    shader.vertexShader = `attribute float aWear;\nattribute float aEdge;\n`
      + `varying vec3 vSurWorld;\nvarying vec3 vSurNrm;\nvarying float vSurShadowFade;\n`
      + `varying float vSurWear;\nvarying float vSurEdge;\n` + shader.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vSurWear = aWear;
          vSurEdge = aEdge;
          vec4 wp = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            wn = mat3(instanceMatrix) * wn;
          #endif
          vSurWorld = (modelMatrix * wp).xyz;
          vSurNrm = normalize(mat3(modelMatrix) * wn);
          vSurShadowFade = 1.0 - smoothstep(30.0, 44.0, length(vSurWorld.xz));
        }`);

    shader.fragmentShader = `
      varying vec3 vSurWorld;
      varying vec3 vSurNrm;
      varying float vSurShadowFade;
      varying float vSurWear;
      varying float vSurEdge;
      uniform vec3 uLow, uMid, uHigh;
      uniform float uScale, uSlopeBias, uDetail, uBump, uBumpFreq, uFalloff, uSat;
      uniform float uHazeAmt, uHeightVal, uRegionVal;
      uniform vec3 uCoolTint, uSkyBounce, uHaze;
      uniform vec3 uDry, uWorn;
      uniform float uDryAmt, uWearAmt, uPatchAmt, uEdgeAmt;
      ${GLSL_NOISE}
      // Height field used ONLY for normal relief, in WORLD units so it never
      // tiles and so a prop scaled 6x gets 6x more relief across it rather
      // than a stretched copy. Base wavelength 1/uBumpFreq (2 units by
      // default), then 3x and 9x.
      float bumpH(vec2 q) {
        return svn2(q) * 0.55 + svn2(q * 3.0 + 9.0) * 0.30 + svn2(q * 9.0 + 21.0) * 0.15;
      }
    ` + shader.fragmentShader
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          // PROCEDURAL RELIEF.
          //
          // Round 3's backdrop was called "untextured flat-shaded boxes" from
          // a 1:1 crop. Round 4's first pass fixed the albedo and was still
          // flat, because a lit surface with a varying colour and a constant
          // NORMAL is a painted primitive, not a rough one. What sells rock is
          // that the key light breaks up across it. So: finite-difference a
          // fine noise field in world space and tilt the shading normal by its
          // gradient. No texture, no tangents, no UVs, no premultiply hazard
          // (PITFALLS 1) — and it never tiles, because it is world space.
          // EPSILON MATTERS. The first version differenced with e = 0.22 in a
          // field whose finest octave had period 0.025 in the same space: the
          // "gradient" was uncorrelated noise, the normal was randomised, and
          // the ground photographed as camouflage blotches at ~3 world units
          // (a lighting artefact that looked exactly like a bad albedo, and
          // survived two albedo rewrites aimed at the wrong cause). The
          // epsilon must be well under the finest feature. Finest octave here
          // is 9 * uBumpFreq, i.e. period 0.111 in q-space; e = 0.045.
          vec3 gN = normalize(vSurNrm);
          float bw = clamp(abs(gN.y), 0.0, 1.0);
          vec2 bq  = vSurWorld.xz * uBumpFreq;
          vec2 bqy = vec2(vSurWorld.x + vSurWorld.z, vSurWorld.y * 1.6) * uBumpFreq;
          const float e = 0.045;
          float f0 = bumpH(bq),  fx = bumpH(bq + vec2(e, 0.0)),  fz = bumpH(bq + vec2(0.0, e));
          float g0 = bumpH(bqy), gx = bumpH(bqy + vec2(e, 0.0)), gy = bumpH(bqy + vec2(0.0, e));
          vec3 flatP = vec3(-(fx - f0), 0.0, -(fz - f0));
          vec3 steepP = vec3(-(gx - g0) * 0.7, -(gy - g0), -(gx - g0) * 0.7);
          // Normalise by e to get a true gradient (magnitude ~2-5), then take
          // a small fraction of it. |W| lands around 0.15-0.45 against a unit
          // normal: enough for the key to break across the surface, nowhere
          // near enough to randomise which way it faces.
          vec3 W = mix(steepP, flatP, bw) * (uBump * 0.14 / e);
          normal = normalize(normal + (viewMatrix * vec4(W, 0.0)).xyz);
        }
      `)
      .replace('#include <map_fragment>', `
        {
          vec3 P = vSurWorld;
          vec3 N = normalize(vSurNrm);

          // Triplanar-ish: sample on the two dominant planes and blend by the
          // normal, so vertical rock faces are not smeared vertically.
          vec2 uvXZ = P.xz * uScale;
          vec2 uvY  = vec2(P.x + P.z, P.y * 1.6) * uScale;
          float bw = clamp(abs(N.y), 0.0, 1.0);

          float mac = mix(sfbm2(uvXZ * 0.21 + 3.1, 3), sfbm2(uvY * 0.21 + 3.1, 3), 1.0 - bw);
          float med = mix(sfbm2(uvXZ * 1.00, 3),        sfbm2(uvY * 1.00, 3),        1.0 - bw);
          float fin = mix(svn2(uvXZ * 5.30 + 17.0),     svn2(uvY * 5.30 + 17.0),     1.0 - bw);
          float gr  = mix(svn2(uvXZ * 21.0 + 51.0),     svn2(uvY * 21.0 + 51.0),     1.0 - bw);

          // ZONES. Continuous fields, never a threshold, so nothing ever
          // tiles or aliases into a pattern (PITFALLS 6).
          //
          // Two earlier attempts drove BOTH the rock zone and the dirt zone
          // off mid-frequency noise. The result photographs as camouflage:
          // 15-30 unit blobs of khaki against blue-green with no direction and
          // no macro form, which is a different failure from greybox but just
          // as synthetic. Rock is now purely a function of SLOPE (which is a
          // real physical cause and therefore reads as one) and soil colour is
          // a single long-wavelength regional field. All the mid and high
          // frequency energy is spent on VALUE and on the normal relief, where
          // it reads as surface rather than as pattern.
          float slope = clamp(1.0 - N.y, 0.0, 1.0);
          float rockW = smoothstep(0.15, 0.52, slope + uSlopeBias + (mac - 0.5) * 0.14);

          // REGIONAL soil tint: ONE octave, wavelength ~140 world units, i.e.
          // wider than the whole visible surround. The macro fbm was used
          // here before and its third octave lands at ~21 units, exactly the
          // blob size that photographs as camouflage. A single very long
          // wavelength gives the ground a sense of PLACE (this side is drier
          // than that side) with no pattern at any scale the eye can lock on.
          float reg = mix(svn2(uvXZ * 0.13 + 5.0), svn2(uvY * 0.13 + 5.0), 1.0 - bw);
          float dirtW = smoothstep(0.34, 0.78, reg) * 0.62;

          vec3 albedo = mix(uLow, uMid, dirtW);
          albedo = mix(albedo, uHigh, rockW);

          /* ------------------------------------------------------------
           * ROUND 7 — MORE MATERIALS, NOT MORE CHROMA. (Art Bible law 7.)
           *
           * Every field below is in WORLD units, deliberately NOT scaled by
           * uScale: uScale sets texture grain, and these are compositional
           * wavelengths (10-80 units) that have to stay put when a prop is
           * given a different grain. Getting that wrong is how the previous
           * regional term ended up with a 213-unit wavelength and therefore
           * evaluated to a constant across the whole visible frame.
           * ------------------------------------------------------------ */

          // DRY GRASS. A second grass albedo on a ~55-unit regional field,
          // ragged at the fine octave so its boundary is not an isoline.
          float dryF = svn2(P.xz * 0.018 + 71.0) * 0.72
                     + svn2(P.xz * 0.062 + 23.0) * 0.28;
          float dryW = smoothstep(0.40, 0.74, dryF) * uDryAmt * (1.0 - rockW);
          albedo = mix(albedo, uDry, dryW);

          // PATH WEAR. vSurWear is authored on the JS side (road corridor,
          // board apron, gatehouse yard); the noise turns a clean analytic
          // falloff into a ragged one, which is the whole difference between
          // 'a brown band' and 'a worn path'.
          float wn = svn2(P.xz * 0.115 + 13.0) * 0.62
                   + svn2(P.xz * 0.360 + 41.0) * 0.38;
          float wr = smoothstep(0.34, 0.80,
                       clamp(vSurWear, 0.0, 1.0) * 1.02 + (wn - 0.5) * 0.62);
          wr *= uWearAmt * (1.0 - rockW * 0.65);
          albedo = mix(albedo, uWorn, wr);

          // Value life at three frequencies. Multiplicative, so it reads as
          // grime and wear rather than as a second colour. The range is
          // deliberately narrow (0.72-1.14): albedo variance is what made the
          // ground read as painted camouflage, and the interest is meant to
          // come from the normal relief and from the props standing on it.
          float v = 0.72 + 0.20 * med + 0.14 * fin + 0.08 * gr;
          albedo *= mix(1.0, v, uDetail);

          // Cavity: the fine octave darkens crevices and lifts the ridges. One
          // of the cheapest ways to stop a low-poly surface reading as a
          // primitive.
          float cav = smoothstep(0.30, 0.70, fin * 0.6 + gr * 0.4);
          albedo *= 0.90 + 0.17 * cav;

          // TONE / SHADOW PATCHES. 80-, 33- and 13-unit octaves, so a handful
          // of soft darker areas fall across the visible field with ragged
          // edges. This is the term that answers 'a single flat green': it is
          // the only one that varies at a scale the eye reads as a SHAPE
          // rather than as grain, and it costs no chroma at all.
          // NOTE: this variable was called 'patch', which is a GLSL RESERVED
          // WORD. The shader then failed to compile, which throws nothing and
          // logs only to the console (PITFALLS 12.2) - the road simply did not
          // render. Do not rename it back.
          float tonePatch = svn2(P.xz * 0.0125 + 33.0) * 0.55
                          + svn2(P.xz * 0.0305 + 9.0) * 0.30
                          + svn2(P.xz * 0.0750 + 51.0) * 0.15;
          // Patches shift HUE as well as value. Darkening alone gave a light
          // khaki field and a dark khaki field, which is one material with a
          // stain on it; a patch that is both darker and COOLER reads as damp
          // ground or as cloud shadow, i.e. as a second condition of the same
          // surface, and it puts two hues in the frame for one multiply.
          albedo *= mix(vec3(1.0), vec3(0.50, 0.62, 0.74),
                        uPatchAmt * smoothstep(0.38, 0.82, tonePatch));

          /* ------------------------------------------------------------
           * LARGE-SCALE VALUE STRUCTURE. (Round 5.)
           *
           * "Roughly 70% of the frame sits within a narrow dark-teal value
           * band." Every term above this line varies at 0.2-20 world units,
           * which averages to a constant over any patch big enough to read as
           * a shape. The two terms below vary at 60-140 units — i.e. ONCE or
           * TWICE across the whole visible surround — which is the only band
           * at which a value difference can be seen as composition rather
           * than as texture.
           *
           * The height term is the important one and it is physically
           * motivated: high ground is dry, wind-scoured and pale; hollows
           * collect damp silt and go dark. It also means the authored
           * landforms in LANDFORMS pay off twice — once in silhouette, once
           * in value — which is what stops them reading as bumps.
           *
           * CENTRING MATTERS AND COST A ROUND. The first version was
           *   mix(1 - 0.75*A, 1 + A, smoothstep(-3, 15, y))
           * which looks symmetric and is not: almost the whole VISIBLE
           * surround sits at y = -1..4, i.e. smoothstep ~= 0.2, so the term
           * evaluated to ~0.85 nearly everywhere and simply dimmed the frame.
           * Measured: surround L fell 52.6 -> 38.5 and the p10-p90 spread fell
           * 64.7 -> 53.5 — darker AND flatter, the exact opposite of the
           * brief. The pivot has to sit at the height the ground actually is,
           * not at the midpoint of the height RANGE.
           * ------------------------------------------------------------ */
          float hv = smoothstep(-4.0, 13.0, P.y);
          albedo *= 1.0 + uHeightVal * (hv - 0.28) * 1.6;
          float regv = mix(svn2(P.xz * 0.0155 + 61.0), svn2(vec2(P.x + P.z, P.y) * 0.0155 + 61.0), 1.0 - bw);
          albedo *= 1.0 + uRegionVal * (regv - 0.5) * 2.0;

          diffuseColor.rgb *= albedo;

          /* DISSOLVING EDGE. Used by the road ribbon only (uEdgeAmt > 0 and
           * material.alphaTest > 0). vSurEdge runs 0 at the centreline to 1 at
           * the outer rim of the widened strip; the outer third is cut away by
           * a two-octave noise threshold, so the pavement CRUMBLES into the
           * worn ground under it instead of ending on a ruled line. Written in
           * map_fragment, which runs before alphatest_fragment. */
          {
            // FREQUENCY MATTERS MORE THAN AMPLITUDE HERE, and the first pass
            // got it backwards. At wavelengths of 1.6 and 0.57 world units the
            // noise is nearly CONSTANT across one 1.4-unit quad, so the
            // 'keep = 0.5' contour degenerates to the linear vSurEdge isoline
            // within each triangle: the fringe came out as a row of big
            // straight-edged triangular bites, which reads as a torn polygon
            // rather than as a crumbling edge. The noise has to wiggle several
            // times ACROSS a triangle, i.e. wavelength well under the quad
            // size: 0.54 and 0.24 units, ~13 and ~6 px at this camera.
            float en = svn2(P.xz * 1.85 + 7.0) * 0.55
                     + svn2(P.xz * 4.20 + 19.0) * 0.45;
            // smoothstep(edge0, edge1) with edge0 < edge1, ALWAYS. Reversing
            // the edges to save a subtraction is undefined behaviour in GLSL
            // and silent (PITFALLS 6).
            float keep = 1.0 - smoothstep(0.52, 1.02, clamp(vSurEdge, 0.0, 1.0))
                       + (en - 0.5) * 0.88;
            diffuseColor.a *= mix(1.0, step(0.5, keep), uEdgeAmt);
          }
        }
      `)
      .replace('#include <opaque_fragment>', `
        {
          /* ------------------------------------------------------------
           * LIGHT POOL + SKY BOUNCE.
           *
           * Two measured properties of the round-3 frame had to survive this
           * rewrite: board:surround luminance 2.29x, and 224 degrees of hue
           * opposition between them. Round 3 got both for free because its
           * backdrop was an UNLIT shader that mixed to a cool horizon colour.
           * A MeshStandardMaterial cannot: under a 7.6-intensity 0xffd096 key
           * the surround came back at L=97 (brighter than the board) and hue
           * 29 (six degrees from it). Saturating the albedo cool and halving
           * it twice only got to L=72 / hue 80 / saturation 2% — the amber key
           * and the cool fill simply cancel.
           *
           * So the grade is explicit, and both halves of it are motivated:
           *   falloff  — the arena is the lit thing in this world (the Art
           *              Bible's one-sentence pitch). Ground far from it sits
           *              outside the pool of light.
           *   sky tint — open ground away from the key reads as sky bounce,
           *              which is cool. Multiplicative, so it shifts hue
           *              without flattening the value structure the relief
           *              and the props are carrying.
           * Both ramp with distance from the board, so the joint at the rim
           * is untouched and there is no edge anywhere.
           * ------------------------------------------------------------ */
          float gd = length(vSurWorld.xz);
          float k = smoothstep(20.0, 86.0, gd);
          outgoingLight *= mix(1.0, uFalloff, k);
          outgoingLight *= mix(vec3(1.0), uCoolTint, k);
          outgoingLight += uSkyBounce * (0.25 + 0.75 * max(normalize(vSurNrm).y, 0.0)) * k;

          /* AERIAL PERSPECTIVE, not a darker band.
           *
           * The critics' word for the round-4 surround was "undifferentiated
           * dark", and the falloff above is half of why: it only ever
           * subtracts, so far ground and near ground differ in brightness but
           * not in CONTRAST or CHROMA, which is the actual signature of
           * distance. Real distance lifts the blacks toward the sky colour and
           * compresses the range. Quadratic in k so the near field is
           * untouched and only the top band of frame reads as far away.
           * Applied before the chroma push so the haze is desaturated. */
          outgoingLight = mix(outgoingLight, uHaze, uHazeAmt * k * k);
          // Chroma. A dark cool albedo under a 7.6-intensity amber key comes
          // out NEUTRAL — measured at 2% saturation against a reference whose
          // surround runs 30-50%. Tinting alone cannot fix that because the
          // warm direct term and the cool ambient cancel channel by channel.
          // Pushing chroma about the luminance axis raises saturation without
          // touching hue or value, which are both already where they need to
          // be.
          float glum = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
          outgoingLight = mix(vec3(glum), outgoingLight, mix(1.0, uSat, k));
        }
        #include <opaque_fragment>
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        {
          vec2 q = vSurWorld.xz * uScale;
          float r1 = sfbm2(q * 1.7 + 91.0, 3);
          // Genuine roughness contrast: damp hollows read wet and catch the
          // key, exposed ridges stay matte. Art Bible sec 3.
          roughnessFactor = clamp(roughness * (0.62 + 0.72 * r1), 0.18, 1.0);
        }
      `);
  };
  // Force a distinct program per configuration.
  mat.customProgramCacheKey = () => `surround-${name}`;
  return mat;
}
