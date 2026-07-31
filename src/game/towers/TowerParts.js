import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry toolkit for the procedural towers.
 *
 * Everything a tower is made of is authored as small primitives, tagged with a
 * (colour, material) pair, and merged into a handful of BufferGeometries that
 * a single BatchedMesh can draw. Material identity survives the merge inside
 * two vertex attributes:
 *
 *   color : vec3   linear albedo / emissive tint
 *   aMat  : vec4   ( metalness, roughness, emissiveIntensity, edgeWear )
 *
 * `edgeWear` is measured from the geometry itself — vertices where surface
 * normals diverge sharply are hard edges, and hard edges are where paint,
 * stone facing and patina get knocked off first.
 */

// --- surface presets -------------------------------------------------------
/**
 * `s` is the AUTHORED-DETAIL STYLE the fragment shader carves into this surface.
 * It is the thing that separates "a designed object" from "a noise placeholder":
 *
 *   0  none      — small parts, metal fittings, gems, emissive cores
 *   1  masonry   — coursed ashlar: horizontal courses, running-bond vertical
 *                  joints, per-block tint, a lit top chamfer per block
 *   2  fluted    — vertical carved channels, no courses (turned/cast stone)
 *   3  timber    — long vertical grain with occasional knots
 *
 * Frequency matters more than amplitude. High-frequency noise averages to flat
 * grey at gameplay distance; a 0.34-unit course line on a 3-unit-wide plinth
 * survives, because it is low-frequency and directional. Reference frames from
 * the shipped game show blocks you can count individually from the play camera.
 */
/**
 * Round 5 respread the roughness ladder. Three blind art directors said the
 * towers read as "one matte shader with a tint" and asked, verbatim, for "at
 * minimum three distinguishable roughness values" and "metal with actual
 * specular on the tower bands". The round-4 ladder ran 0.94 / 0.78 / 0.58 /
 * 0.42 / 0.30 / 0.16 — nominally six values, but the fragment stage then added
 * up to +-0.10 of grain, +0.16 of joint darkening and clamped at 0.17, which
 * squeezed the whole set into a band roughly 0.35 wide once ACES had finished
 * with it. Adjacent entries were indistinguishable.
 *
 * The ladder below is pushed apart at both ends instead. The gap that matters
 * is metal-to-stone: 0.24 vs 0.86 is a factor of 3.5 and produces a specular
 * lobe on a band that a 0.42/0.78 pair could not. Stone goes rougher, not
 * less rough, because the contrast is the deliverable and stone is the
 * background surface. Three unmistakable buckets, in the critics' terms:
 *
 *   crystal/gold/metal   0.09 - 0.24   sharp highlight, dark albedo, hot rim
 *   metalDark/stoneSmooth 0.38 - 0.60  broad sheen
 *   stoneCut/wood/stone   0.86 - 0.97  matte, no highlight at all
 */
export const MAT = {
  stone:      { m: 0.02, r: 0.97, w: 0.15, s: 1 },
  stoneCut:   { m: 0.03, r: 0.86, w: 0.17, s: 1 },
  stoneSmooth:{ m: 0.02, r: 0.60, w: 0.16, s: 2 },
  metal:      { m: 1.00, r: 0.24, w: 0.28, s: 0 },
  metalDark:  { m: 0.96, r: 0.38, w: 0.22, s: 0 },
  gold:       { m: 1.00, r: 0.15, w: 0.38, s: 0 },
  crystal:    { m: 0.10, r: 0.09, w: 0.05, s: 0 },
  wood:       { m: 0.00, r: 0.90, w: 0.25, s: 3 },
  core:       { m: 0.00, r: 0.35, w: 0.00, s: 0 },
};

const _c = new THREE.Color();
function linear(hex) { return _c.setHex(hex).convertSRGBToLinear().toArray(); }

/** Small deterministic RNG so a given tower always looks identical. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}
export function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Edge-wear bake
// ---------------------------------------------------------------------------
function computeEdge(geo) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = pos.count;
  const map = new Map();
  const key = (i) => `${Math.round(pos.getX(i) * 800)},${Math.round(pos.getY(i) * 800)},${Math.round(pos.getZ(i) * 800)}`;
  for (let i = 0; i < n; i++) {
    const k = key(i);
    let a = map.get(k);
    if (!a) map.set(k, (a = []));
    a.push(i);
  }
  const out = new Float32Array(n);
  for (const idxs of map.values()) {
    let minDot = 1;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const ia = idxs[a], ib = idxs[b];
        const d = nrm.getX(ia) * nrm.getX(ib) + nrm.getY(ia) * nrm.getY(ib) + nrm.getZ(ia) * nrm.getZ(ib);
        if (d < minDot) minDot = d;
      }
    }
    // 1 -> coplanar (no edge), -1 -> a fold back on itself (a sharp corner).
    let e = THREE.MathUtils.clamp((1 - minDot) * 0.85, 0, 1);
    if (idxs.length === 1) e = 0.08;
    for (const i of idxs) {
      // Rain, boots and impacts polish upward-facing edges first.
      const up = THREE.MathUtils.clamp(nrm.getY(i) * 0.5 + 0.62, 0, 1);
      out[i] = e * (0.40 + 0.60 * up);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Part accumulator
// ---------------------------------------------------------------------------
export class Parts {
  /**
   * @param yOffset height of this part group's pivot above the ground. Baked
   *        into color.a so the shader's grime/dust gradient stays anchored to
   *        the board even for sub-groups whose local origin is not the ground.
   */
  constructor(yOffset = 0) {
    this.items = [];
    this.yOffset = yOffset;
    /** linear element colour, used by the shader's glowing carved channels */
    this.elem = [0.6, 0.6, 0.7];
  }

  /** @param hex the tower's element colour — lights the carved channels. */
  setElem(hex) { this.elem = linear(hex); return this; }

  get length() { return this.items.length; }

  /**
   * @param geo   source BufferGeometry (consumed — do not reuse externally)
   * @param o     { color, mat, x,y,z, rx,ry,rz, s|sx,sy,sz, emissive, wear }
   */
  add(geo, o = {}) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ'));
    const s = o.s ?? 1;
    m.compose(
      new THREE.Vector3(o.x || 0, o.y || 0, o.z || 0),
      q,
      new THREE.Vector3(o.sx ?? s, o.sy ?? s, o.sz ?? s),
    );
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.applyMatrix4(m);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.deleteAttribute('uv');
    g.deleteAttribute('uv1');
    g.deleteAttribute('uv2');

    const preset = o.mat ?? MAT.stone;
    const emissive = o.emissive ?? 0;
    const wearScale = o.wear ?? 1;
    const col = linear(o.color ?? 0x808080);
    // Authored-detail style, and how strongly the element energy runs in the
    // carved channels. The channel strength is folded into the colour, so a
    // strength of 0 simply means "no channel here" with no extra attribute.
    const style = o.style ?? preset.s ?? 0;
    const chan = (o.channel ?? (style === 1 || style === 2 ? 1 : 0));
    const el = this.elem;
    const count = g.attributes.position.count;
    const cArr = new Float32Array(count * 4);
    const mArr = new Float32Array(count * 4);
    const dArr = new Float32Array(count * 4);
    const edge = computeEdge(g);
    const gp = g.attributes.position;
    for (let i = 0; i < count; i++) {
      // The element colour is now carried on EVERY vertex, not only on the ones
      // with a carved channel, because the rim-light term in TowerMaterial
      // needs a family hue on every surface — that is what separates a tower
      // from the flagstones it stands on at gameplay distance. The channel flag
      // therefore no longer fits in the colour and is packed into the style
      // slot instead: style is 0..3, so bit 8 is free.
      dArr[i * 4] = el[0]; dArr[i * 4 + 1] = el[1]; dArr[i * 4 + 2] = el[2];
      dArr[i * 4 + 3] = style + (chan > 0 ? 8 : 0);
      cArr[i * 4] = col[0]; cArr[i * 4 + 1] = col[1]; cArr[i * 4 + 2] = col[2];
      // Normalised height above the board, used by the shader's grime gradient.
      // The divisor is the tallest tower we build. It moved 5.2 -> 9.8 with the
      // round-3 scale-up and back to 7.2 in round 7, when the shafts were cut to
      // reference proportions (see SHAFT in TowerArchetypes). If it is left too
      // high the gradient only uses the bottom half of its range and every
      // tower reads as uniformly sooty.
      cArr[i * 4 + 3] = THREE.MathUtils.clamp((gp.getY(i) + this.yOffset + 0.4) / 7.2, 0, 1);
      mArr[i * 4] = preset.m;
      mArr[i * 4 + 1] = preset.r;
      mArr[i * 4 + 2] = emissive;
      mArr[i * 4 + 3] = preset.w * wearScale * edge[i];
    }
    g.setAttribute('color', new THREE.BufferAttribute(cArr, 4));
    g.setAttribute('aMat', new THREE.BufferAttribute(mArr, 4));
    g.setAttribute('aDet', new THREE.BufferAttribute(dArr, 4));
    this.items.push(g);
    return this;
  }

  build() {
    if (!this.items.length) return null;
    const merged = mergeGeometries(this.items, false);
    for (const g of this.items) g.dispose();
    this.items.length = 0;
    merged.computeBoundingSphere();
    return merged;
  }
}

// ---------------------------------------------------------------------------
// Primitive library
// ---------------------------------------------------------------------------

/** Rounded box — the chamfer is what catches a specular highlight on an edge. */
export function bevelBox(w, h, d, bevel = 0.05) {
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const pos = geo.attributes.position;
  const hw = w / 2, hh = h / 2, hd = d / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const sx = Math.abs(x) > hw - 1e-4 ? Math.sign(x) : 0;
    const sy = Math.abs(y) > hh - 1e-4 ? Math.sign(y) : 0;
    const sz = Math.abs(z) > hd - 1e-4 ? Math.sign(z) : 0;
    if (Math.abs(sx) + Math.abs(sy) + Math.abs(sz) >= 2) {
      pos.setXYZ(i, x - sx * bevel, y - sy * bevel, z - sz * bevel);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

/** Box tapering from bottom footprint to top footprint. */
export function taperBox(wb, wt, h, db = wb, dt = wt) {
  const geo = new THREE.BoxGeometry(1, h, 1, 1, 1, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = y / h + 0.5;
    pos.setX(i, pos.getX(i) * THREE.MathUtils.lerp(wb, wt, t));
    pos.setZ(i, pos.getZ(i) * THREE.MathUtils.lerp(db, dt, t));
  }
  geo.computeVertexNormals();
  return geo;
}

export function prism(rTop, rBot, h, sides = 6, open = false) {
  return new THREE.CylinderGeometry(rTop, rBot, h, sides, 1, open);
}

export function lathe(points, seg = 16) {
  const pts = points.map((p) => new THREE.Vector2(p[0], p[1]));
  return new THREE.LatheGeometry(pts, seg);
}

/**
 * Double pyramid — the crystal shard vocabulary used all over the towers.
 *
 * Both cones' tapers used to be inverted, which pinched the middle and flared
 * both ends: every "crystal" in the game was in fact an hourglass, and a
 * 4-sided hourglass photographs as a flat bowtie. `waist` names where the widest
 * section sits along the height, which is what it should have meant all along.
 */
export function shard(r, h, sides = 4, waist = 0.28) {
  const g = new THREE.CylinderGeometry(r, 0.001, h * waist, sides, 1);
  const g2 = new THREE.CylinderGeometry(0.001, r, h * (1 - waist), sides, 1);
  g.translate(0, h * waist * 0.5 - h * 0.5, 0);
  g2.translate(0, h * waist + h * (1 - waist) * 0.5 - h * 0.5, 0);
  const m = mergeGeometries([g.toNonIndexed(), g2.toNonIndexed()], false);
  g.dispose(); g2.dispose();
  m.computeVertexNormals();
  return m;
}

/** Irregular chunk of rock — icosahedron pushed around by a hash. */
export function rock(r, seed = 1, rough = 0.34, detail = 0) {
  const g = new THREE.IcosahedronGeometry(r, detail).toNonIndexed();
  const pos = g.attributes.position;
  const rand = rng(seed);
  const table = [];
  for (let i = 0; i < 64; i++) table.push(1 - rough + rand() * rough * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = (Math.round(x * 40) * 73856093 ^ Math.round(y * 40) * 19349663 ^ Math.round(z * 40) * 83492791) >>> 0;
    const f = table[k % 64];
    pos.setXYZ(i, x * f, y * f * 0.86, z * f);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Torus, optionally a partial arc (for wave crests, orbital bands, dashes).
 *
 * This is by a wide margin the most-instantiated primitive on a tower — every
 * collar, kerb, shell and halo is one — so its tessellation is the largest
 * single lever on the tower triangle bill. Two budgets are enforced here rather
 * than at ~40 call sites:
 *   - the tube section is capped at 4 segments. At the tube radii towers
 *     actually use (0.026–0.12 world units) a rounder section is sub-pixel.
 *   - an arc gets segments in proportion to how much of the circle it spans,
 *     so a 0.3-radian dash is not tessellated as if it were a full ring.
 */
export function ring(r, tube, arc = Math.PI * 2, radial = 4, tubular = 14) {
  const tub = Math.max(4, Math.min(tubular, Math.ceil(tubular * arc / (Math.PI * 2)) + 2));
  return new THREE.TorusGeometry(r, tube, Math.min(radial, 4), tub, arc);
}

/** Spheres are capped for the same reason; 12x9 is smooth under vertex normals. */
export function sphere(r, w = 12, h = 9) {
  return new THREE.SphereGeometry(r, Math.min(w, 12), Math.min(h, 9));
}

/** Tapered limb between two points — the branch/root/pipe primitive. */
export function limb(from, to, r0, r1, sides = 5) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Twist a geometry about Y — used for the organic/unstable silhouettes. */
export function twist(geo, radPerUnit) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const a = y * radPerUnit;
    pos.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a));
  }
  geo.computeVertexNormals();
  return geo;
}

/** Push vertices around by a hash — turns clean primitives into eroded ones. */
export function erode(geo, amount, seed = 7, freq = 1.4) {
  const pos = geo.attributes.position;
  const rand = rng(seed);
  const t = [];
  for (let i = 0; i < 128; i++) t.push(rand() * 2 - 1);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = (Math.round(x * freq * 16) * 374761393 ^ Math.round(y * freq * 16) * 668265263 ^ Math.round(z * freq * 16) * 2147483647) >>> 0;
    const f = t[k % 128] * amount;
    pos.setXYZ(i, x + f, y + t[(k >>> 7) % 128] * amount * 0.6, z + t[(k >>> 3) % 128] * amount);
  }
  geo.computeVertexNormals();
  return geo;
}
