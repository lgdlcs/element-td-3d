import * as THREE from 'three';

/**
 * Creep geometry library.
 *
 * Every archetype is authored as a list of tagged primitives which get merged
 * into ONE non-indexed BufferGeometry per archetype (so the whole army is a
 * single InstancedMesh / draw call). Each vertex carries:
 *
 *   aPivot  vec3   joint origin in model space — the vertex shader rotates the
 *                  vertex about this point, which is what gives us a
 *                  skeletal-feeling gait with zero CPU cost.
 *   aPart   float  which "bone" the vertex belongs to (see PART).
 *   aMat    float  material class (see MAT) — drives roughness/metalness/glow
 *                  in the fragment shader so one material can look like hide,
 *                  iron, bone, cloth or molten light.
 *   aTint   vec3   per-part albedo multiplier, so a creep is never one flat
 *                  colour.
 */

// --- "bones" -----------------------------------------------------------------
export const PART = {
  TORSO: 0,
  LEG_L: 1,
  LEG_R: 2,
  HEAD: 3,
  ARM_L: 4,
  ARM_R: 5,
  CLOTH: 6,   // capes, banners, tatters — trails back, flutters
  WING_L: 7,
  WING_R: 8,
  ORBIT: 9,   // spins continuously around Y (rings, motes)
  STATIC: 10, // rigid, no local animation (feet, ground rings)
  TAIL: 11,
  LEG_L2: 12, // secondary leg pair (insects) — offset phase
  LEG_R2: 13,
};

// --- material classes --------------------------------------------------------
export const MAT = {
  HIDE: 0,   // rough organic skin
  IRON: 1,   // dark pitted metal
  BONE: 2,   // pale hard chitin / bone / horn
  CLOTH: 3,  // matte fabric, no spec
  GLOW: 4,   // emissive — eyes, cores, runes
};

// --- low-poly primitive helpers ---------------------------------------------
// Segment counts are hard-capped: a creep is ~40px tall at gameplay zoom, so
// every extra ring is triangles spent on nothing — and each one is paid again
// in the shadow pass, 300 times over.
const cap = (r, len, cs = 2, rs = 6) => new THREE.CapsuleGeometry(r, len, Math.min(cs, 2), Math.min(rs, 6));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, 0);
const cone = (r, h, s = 6) => new THREE.ConeGeometry(r, h, Math.min(s, 5));
const cyl = (rt, rb, h, s = 8) => new THREE.CylinderGeometry(rt, rb, h, Math.min(s, 6));
const torus = (r, t, s = 5, rings = 14) => new THREE.TorusGeometry(r, t, Math.min(s, 4), Math.min(rings, 14));
const plane = (w, h) => new THREE.PlaneGeometry(w, h, 1, 2);

class Builder {
  constructor() { this.parts = []; }

  /**
   * @param geo primitive
   * @param o   { pos, rot, scale, part, mat, pivot, tint, flat }
   */
  add(geo, o = {}) {
    this.parts.push({ geo, ...o });
    return this;
  }

  /**
   * Place a capsule spanning p0 -> p1. Authoring limbs as bones (rather than
   * hand-placed capsules with hand-guessed Euler angles) is the only reliable
   * way to keep a skeleton connected — floating shins are instantly readable
   * as "broken" even at gameplay zoom.
   */
  bone(p0, p1, r, o = {}) {
    const a = new THREE.Vector3(...p0);
    const bb = new THREE.Vector3(...p1);
    const d = new THREE.Vector3().subVectors(bb, a);
    const len = Math.max(0.001, d.length() - r * 0.6);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), d.clone().normalize(),
    );
    const mid = a.clone().add(bb).multiplyScalar(0.5);
    this.parts.push({
      geo: cap(r, len, o.cs ?? 2, o.rs ?? 6),
      pos: [mid.x, mid.y, mid.z],
      quat: q,
      ...o,
      pivot: o.pivot || p0,
    });
    return this;
  }

  /** Mirror the previous N adds across X (cheap bilateral authoring). */
  mirror(n = 1, remap = {}) {
    const src = this.parts.slice(-n);
    for (const p of src) {
      const pos = (p.pos || [0, 0, 0]).slice();
      const rot = (p.rot || [0, 0, 0]).slice();
      const pivot = p.pivot ? p.pivot.slice() : null;
      pos[0] = -pos[0];
      rot[1] = -rot[1]; rot[2] = -rot[2];
      if (pivot) pivot[0] = -pivot[0];
      let quat = p.quat;
      if (quat) { quat = quat.clone(); quat.y = -quat.y; quat.z = -quat.z; }
      let part = p.part ?? PART.TORSO;
      if (remap[part] !== undefined) part = remap[part];
      this.parts.push({ ...p, pos, rot, pivot, part, quat });
    }
    return this;
  }

  build() {
    const chunks = [];
    let total = 0;
    for (const p of this.parts) {
      let g = p.geo.clone();
      const m = new THREE.Matrix4();
      const q = p.quat
        ? p.quat.clone()
        : new THREE.Quaternion().setFromEuler(
          new THREE.Euler(...(p.rot || [0, 0, 0]), 'XYZ'),
        );
      m.compose(
        new THREE.Vector3(...(p.pos || [0, 0, 0])),
        q,
        new THREE.Vector3(...(p.scale || [1, 1, 1])),
      );
      g.applyMatrix4(m);
      g = g.index ? g.toNonIndexed() : g;
      if (p.flat) g.computeVertexNormals();
      chunks.push({ g, p, count: g.attributes.position.count });
      total += g.attributes.position.count;
    }

    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const aPivot = new Float32Array(total * 3);
    const aPart = new Float32Array(total);
    const aMat = new Float32Array(total);
    const aTint = new Float32Array(total * 3);

    let o = 0;
    for (const { g, p, count } of chunks) {
      position.set(g.attributes.position.array, o * 3);
      if (g.attributes.normal) normal.set(g.attributes.normal.array, o * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
      const pv = p.pivot || p.pos || [0, 0, 0];
      const tint = p.tint || [1, 1, 1];
      const part = p.part ?? PART.TORSO;
      const mat = p.mat ?? MAT.HIDE;
      for (let k = 0; k < count; k++) {
        const i = o + k;
        aPivot[i * 3] = pv[0]; aPivot[i * 3 + 1] = pv[1]; aPivot[i * 3 + 2] = pv[2];
        aPart[i] = part;
        aMat[i] = mat;
        aTint[i * 3] = tint[0]; aTint[i * 3 + 1] = tint[1]; aTint[i * 3 + 2] = tint[2];
      }
      o += count;
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(position, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setAttribute('aPivot', new THREE.BufferAttribute(aPivot, 3));
    out.setAttribute('aPart', new THREE.BufferAttribute(aPart, 1));
    out.setAttribute('aMat', new THREE.BufferAttribute(aMat, 1));
    out.setAttribute('aTint', new THREE.BufferAttribute(aTint, 3));
    out.computeBoundingSphere();
    return out;
  }
}

// Shared tints so the family reads as one species set.
const T_DARK = [0.42, 0.40, 0.44];
const T_MID = [0.78, 0.74, 0.70];
const T_PALE = [1.18, 1.14, 1.05];
const T_RUST = [0.62, 0.44, 0.34];

// =============================================================================
// SWARM — "mite". Tiny, wide, low to the ground, six splayed legs, one eye.
// Silhouette: a scuttling wedge with a raised stinger. Reads as *many small*.
// =============================================================================
export function makeMiteGeometry() {
  const b = new Builder();

  // Six legs, splayed like a spider — long enough to read at tiny scale.
  const legPos = [[0.20, 0.30, 0.16], [0.22, 0.30, -0.02], [0.19, 0.30, -0.20]];
  legPos.forEach(([x, y, z], k) => {
    b.add(cap(0.045, 0.30, 2, 5), {
      pos: [x + 0.14, y - 0.02, z + (k - 1) * 0.06],
      rot: [0.1 * (k - 1), 0, -1.05],
      pivot: [x, y, z], part: k === 1 ? PART.LEG_L2 : PART.LEG_L, mat: MAT.BONE, tint: T_DARK,
    });
    b.add(cap(0.040, 0.26, 2, 5), {
      pos: [x + 0.30, y - 0.16, z + (k - 1) * 0.09],
      rot: [0, 0, -0.35],
      pivot: [x, y, z], part: k === 1 ? PART.LEG_L2 : PART.LEG_L, mat: MAT.BONE, tint: T_DARK,
    });
  });
  b.mirror(6, { [PART.LEG_L]: PART.LEG_R, [PART.LEG_L2]: PART.LEG_R2 });

  // Abdomen — the mass, sitting low and back.
  b.add(ico(0.30, 1), {
    pos: [0, 0.36, -0.14], scale: [0.92, 0.66, 1.15],
    part: PART.TORSO, mat: MAT.HIDE, tint: T_DARK, pivot: [0, 0.30, 0],
  });
  // Chitin shell — a hard, faceted lid that catches the rim light.
  b.add(ico(0.28, 0), {
    pos: [0, 0.42, -0.12], scale: [1.0, 0.62, 1.12],
    part: PART.TORSO, mat: MAT.BONE, tint: T_MID, pivot: [0, 0.30, 0], flat: true,
  });
  // Three dorsal spikes — breaks the blob outline.
  for (let k = 0; k < 3; k++) {
    b.add(cone(0.045, 0.20 - k * 0.03, 4), {
      pos: [0, 0.56 - k * 0.02, -0.02 - k * 0.16], rot: [-0.5 - k * 0.15, 0, 0],
      part: PART.TORSO, mat: MAT.BONE, tint: T_PALE, pivot: [0, 0.30, 0],
    });
  }

  // Head — thrust forward, low.
  b.add(ico(0.15, 0), {
    pos: [0, 0.32, 0.24], scale: [1.0, 0.8, 1.2],
    part: PART.HEAD, mat: MAT.HIDE, tint: T_DARK, pivot: [0, 0.34, 0.12], flat: true,
  });
  b.add(ico(0.075, 0), {
    pos: [0, 0.36, 0.34], part: PART.HEAD, mat: MAT.GLOW, pivot: [0, 0.34, 0.12],
  });
  // Mandibles.
  b.add(cone(0.035, 0.20, 4), {
    pos: [0.09, 0.26, 0.34], rot: [-1.35, 0, -0.3],
    part: PART.HEAD, mat: MAT.BONE, tint: T_PALE, pivot: [0, 0.34, 0.12],
  });
  b.mirror(1);

  // Stinger tail, raised — the strongest read at distance.
  b.add(cap(0.05, 0.18, 2, 5), {
    pos: [0, 0.50, -0.36], rot: [0.9, 0, 0],
    pivot: [0, 0.40, -0.24], part: PART.TAIL, mat: MAT.HIDE, tint: T_DARK,
  });
  b.add(cone(0.055, 0.26, 5), {
    pos: [0, 0.66, -0.46], rot: [-0.55, 0, 0],
    pivot: [0, 0.40, -0.24], part: PART.TAIL, mat: MAT.BONE, tint: T_PALE,
  });

  return b.build();
}

// =============================================================================
// FAST — "runner". Tall, thin, digitigrade, pitched forward, trailing scarf.
// Silhouette: a leaning blade. Nothing else in the roster leans.
// =============================================================================
export function makeRunnerGeometry() {
  const b = new Builder();
  const HIP = [0.17, 1.00, 0.02];

  // Digitigrade leg chain, authored as connected bones: thigh back, shin
  // forward, long spring metatarsal, claw. Reads as a sprinter's leg.
  b.bone(HIP, [0.18, 0.66, -0.34], 0.125, { part: PART.LEG_L, mat: MAT.HIDE, tint: T_MID, pivot: HIP });
  b.bone([0.18, 0.66, -0.34], [0.18, 0.28, 0.14], 0.092, { part: PART.LEG_L, mat: MAT.HIDE, tint: T_DARK, pivot: HIP });
  b.bone([0.18, 0.28, 0.14], [0.18, 0.05, 0.34], 0.062, { part: PART.LEG_L, mat: MAT.BONE, tint: T_MID, pivot: HIP });
  b.add(cone(0.05, 0.22, 4), {
    pos: [0.18, 0.045, 0.45], rot: [1.5, 0, 0],
    pivot: HIP, part: PART.LEG_L, mat: MAT.BONE, tint: T_PALE,
  });
  b.mirror(4, { [PART.LEG_L]: PART.LEG_R });

  // Pelvis block ties the legs to the body.
  b.add(box(0.42, 0.20, 0.26), {
    pos: [0, 1.00, 0.0], rot: [0.3, 0, 0],
    pivot: [0, 0.98, 0], part: PART.TORSO, mat: MAT.HIDE, tint: T_DARK, flat: true,
  });

  // Torso — one long forward-pitched bone. Nothing else in the roster leans.
  b.bone([0, 1.00, -0.02], [0, 1.44, 0.24], 0.215, {
    part: PART.TORSO, mat: MAT.HIDE, tint: T_MID, pivot: [0, 0.98, 0], cs: 3, rs: 8,
  });
  // Ribs / half-harness, deliberately asymmetric.
  b.add(box(0.34, 0.22, 0.11), {
    pos: [0.09, 1.30, 0.24], rot: [0.55, 0.12, 0.14],
    pivot: [0, 0.98, 0], part: PART.TORSO, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.add(box(0.24, 0.12, 0.09), {
    pos: [-0.11, 1.12, 0.22], rot: [0.55, -0.1, -0.22],
    pivot: [0, 0.98, 0], part: PART.TORSO, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  // Dorsal blades along the spine.
  for (let k = 0; k < 3; k++) {
    b.add(cone(0.045, 0.20 - k * 0.03, 4), {
      pos: [0, 1.30 - k * 0.14, -0.06 - k * 0.10], rot: [-2.1, 0, 0],
      pivot: [0, 0.98, 0], part: PART.TORSO, mat: MAT.BONE, tint: T_PALE,
    });
  }

  // Neck + head: long muzzle forward, swept crest back = an arrow.
  b.bone([0, 1.42, 0.22], [0, 1.56, 0.32], 0.085, {
    part: PART.HEAD, mat: MAT.HIDE, tint: T_DARK, pivot: [0, 1.42, 0.20],
  });
  b.add(ico(0.125, 1), {
    pos: [0, 1.60, 0.36], scale: [0.85, 0.9, 1.2],
    pivot: [0, 1.42, 0.20], part: PART.HEAD, mat: MAT.HIDE, tint: T_MID,
  });
  b.add(cone(0.075, 0.30, 5), {
    pos: [0, 1.56, 0.52], rot: [1.45, 0, 0],
    pivot: [0, 1.42, 0.20], part: PART.HEAD, mat: MAT.BONE, tint: T_PALE,
  });
  b.add(cone(0.05, 0.44, 4), {
    pos: [0, 1.72, 0.16], rot: [-2.2, 0, 0], scale: [1, 1, 0.45],
    pivot: [0, 1.42, 0.20], part: PART.HEAD, mat: MAT.BONE, tint: T_PALE,
  });
  b.add(ico(0.036, 0), {
    pos: [0.075, 1.63, 0.44], pivot: [0, 1.42, 0.20], part: PART.HEAD, mat: MAT.GLOW,
  });
  b.mirror(1);

  // Thin arms swept back like a sprinter's.
  const SH = [0.20, 1.34, 0.16];
  b.bone(SH, [0.27, 1.08, -0.06], 0.062, { part: PART.ARM_L, mat: MAT.HIDE, tint: T_MID, pivot: SH });
  b.bone([0.27, 1.08, -0.06], [0.30, 0.94, -0.32], 0.05, { part: PART.ARM_L, mat: MAT.HIDE, tint: T_DARK, pivot: SH });
  b.add(cone(0.045, 0.22, 4), {
    pos: [0.31, 0.88, -0.44], rot: [-1.0, 0, -0.15],
    pivot: SH, part: PART.ARM_L, mat: MAT.BONE, tint: T_PALE,
  });
  b.mirror(3, { [PART.ARM_L]: PART.ARM_R });

  // Trailing scarf — the motion tell.
  b.add(plane(0.34, 0.74), {
    pos: [0, 1.34, -0.34], rot: [-1.15, 0, 0],
    pivot: [0, 1.40, -0.06], part: PART.CLOTH, mat: MAT.CLOTH, tint: T_RUST,
  });
  b.add(plane(0.20, 0.52), {
    pos: [0.11, 1.24, -0.74], rot: [-1.35, 0.3, 0.1],
    pivot: [0, 1.40, -0.06], part: PART.CLOTH, mat: MAT.CLOTH, tint: T_RUST,
  });

  return b.build();
}

// =============================================================================
// NORMAL — "grunt". Hunched humanoid, broad shoulders, horned helm, loincloth.
// The reference silhouette everything else is measured against.
// =============================================================================
export function makeGruntGeometry() {
  const b = new Builder();

  // Legs — short, thick, planted.
  b.add(cap(0.155, 0.34, 2, 6), {
    pos: [0.19, 0.52, 0], pivot: [0.19, 0.78, 0],
    part: PART.LEG_L, mat: MAT.HIDE, tint: T_DARK,
  });
  b.add(cap(0.135, 0.26, 2, 6), {
    pos: [0.19, 0.20, 0.02], pivot: [0.19, 0.78, 0],
    part: PART.LEG_L, mat: MAT.HIDE, tint: T_MID,
  });
  b.add(box(0.20, 0.10, 0.30), {
    pos: [0.19, 0.05, 0.05], pivot: [0.19, 0.78, 0],
    part: PART.LEG_L, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.mirror(3, { [PART.LEG_L]: PART.LEG_R });

  // Torso — barrel chest, hunched forward.
  b.add(cap(0.345, 0.30, 3, 9), {
    pos: [0, 1.06, -0.02], rot: [0.14, 0, 0], scale: [1.12, 1, 0.86],
    pivot: [0, 0.78, 0], part: PART.TORSO, mat: MAT.HIDE, tint: T_MID,
  });
  // Chest plate, off-centre and battered.
  b.add(box(0.46, 0.34, 0.16), {
    pos: [0.02, 1.14, 0.20], rot: [0.16, 0.05, 0.06],
    pivot: [0, 0.78, 0], part: PART.TORSO, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.add(box(0.34, 0.10, 0.14), {
    pos: [-0.02, 0.88, 0.20], rot: [0.1, -0.04, -0.08],
    pivot: [0, 0.78, 0], part: PART.TORSO, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  // Back hump / bedroll.
  b.add(ico(0.20, 0), {
    pos: [0, 1.22, -0.24], scale: [1.2, 0.8, 0.8], rot: [0, 0.4, 0],
    pivot: [0, 0.78, 0], part: PART.TORSO, mat: MAT.CLOTH, tint: T_RUST, flat: true,
  });

  // Shoulders — asymmetric: one bare, one pauldroned.
  b.add(ico(0.17, 0), {
    pos: [0.36, 1.28, 0], scale: [1, 0.85, 1], rot: [0, 0, 0.2],
    pivot: [0.33, 1.26, 0], part: PART.ARM_L, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.add(cone(0.06, 0.20, 4), {
    pos: [0.46, 1.36, 0], rot: [0, 0, -0.7],
    pivot: [0.33, 1.26, 0], part: PART.ARM_L, mat: MAT.BONE, tint: T_PALE,
  });
  b.add(cap(0.115, 0.30, 2, 6), {
    pos: [0.36, 0.98, 0.02], rot: [0.1, 0, 0.05],
    pivot: [0.33, 1.26, 0], part: PART.ARM_L, mat: MAT.HIDE, tint: T_MID,
  });
  b.add(ico(0.09, 0), {
    pos: [0.37, 0.76, 0.06], pivot: [0.33, 1.26, 0],
    part: PART.ARM_L, mat: MAT.HIDE, tint: T_DARK, flat: true,
  });
  b.mirror(4, { [PART.ARM_L]: PART.ARM_R });

  // A crude cleaver in the right hand — asymmetry that reads instantly.
  b.add(box(0.05, 0.44, 0.05), {
    pos: [-0.40, 0.62, 0.10], rot: [0.3, 0, 0.1],
    pivot: [0.33, 1.26, 0], part: PART.ARM_R, mat: MAT.CLOTH, tint: T_RUST,
  });
  b.add(box(0.06, 0.34, 0.20), {
    pos: [-0.42, 0.36, 0.20], rot: [0.3, 0, 0.1],
    pivot: [0.33, 1.26, 0], part: PART.ARM_R, mat: MAT.IRON, tint: T_MID, flat: true,
  });

  // Head — sunk between shoulders, heavy brow, one horn broken.
  b.add(ico(0.195, 1), {
    pos: [0, 1.46, 0.04], scale: [0.95, 1.05, 1],
    pivot: [0, 1.30, 0], part: PART.HEAD, mat: MAT.HIDE, tint: T_MID,
  });
  b.add(box(0.30, 0.10, 0.24), {
    pos: [0, 1.54, 0.06], rot: [-0.14, 0, 0],
    pivot: [0, 1.30, 0], part: PART.HEAD, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.add(cone(0.06, 0.30, 5), {
    pos: [0.15, 1.68, -0.02], rot: [-0.2, 0, 0.5],
    pivot: [0, 1.30, 0], part: PART.HEAD, mat: MAT.BONE, tint: T_PALE,
  });
  b.add(cone(0.055, 0.13, 5), { // the broken one
    pos: [-0.15, 1.60, -0.02], rot: [-0.2, 0, -0.7],
    pivot: [0, 1.30, 0], part: PART.HEAD, mat: MAT.BONE, tint: T_PALE,
  });
  b.add(ico(0.035, 0), {
    pos: [0.07, 1.46, 0.17], pivot: [0, 1.30, 0], part: PART.HEAD, mat: MAT.GLOW,
  });
  b.mirror(1);

  // Ragged kilt.
  b.add(cone(0.28, 0.40, 7, 1), {
    pos: [0, 0.66, 0], rot: [Math.PI, 0, 0], scale: [1, 1, 0.85],
    pivot: [0, 0.84, 0], part: PART.CLOTH, mat: MAT.CLOTH, tint: T_RUST, flat: true,
  });

  return b.build();
}

// =============================================================================
// ARMORED — "brute". Wide, top-heavy, layered plate, tusks, no visible neck.
// Silhouette: a moving wall. Widest ground unit that is not the boss.
// =============================================================================
export function makeBruteGeometry() {
  const b = new Builder();

  // Thick columnar legs, wide stance.
  b.add(cyl(0.215, 0.185, 0.46, 7), {
    pos: [0.30, 0.55, 0], pivot: [0.30, 0.80, 0],
    part: PART.LEG_L, mat: MAT.HIDE, tint: T_DARK, flat: true,
  });
  b.add(box(0.34, 0.20, 0.24), {
    pos: [0.30, 0.62, 0.06], pivot: [0.30, 0.80, 0],
    part: PART.LEG_L, mat: MAT.IRON, tint: T_MID, flat: true,
  });
  b.add(cyl(0.185, 0.215, 0.30, 7), {
    pos: [0.30, 0.20, 0.01], pivot: [0.30, 0.80, 0],
    part: PART.LEG_L, mat: MAT.HIDE, tint: T_MID, flat: true,
  });
  b.add(box(0.30, 0.13, 0.40), {
    pos: [0.30, 0.07, 0.06], pivot: [0.30, 0.80, 0],
    part: PART.LEG_L, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.mirror(4, { [PART.LEG_L]: PART.LEG_R });

  // Torso — a wide wedge, wider at the shoulders.
  b.add(box(0.82, 0.64, 0.54), {
    pos: [0, 1.16, 0], rot: [0.1, 0, 0],
    pivot: [0, 0.82, 0], part: PART.TORSO, mat: MAT.HIDE, tint: T_MID, flat: true,
  });
  // Stacked belly plates — three overlapping bands.
  for (let k = 0; k < 3; k++) {
    b.add(box(0.74 - k * 0.06, 0.16, 0.14), {
      pos: [0, 0.94 + k * 0.20, 0.24 - k * 0.015], rot: [0.1 + k * 0.03, 0, 0],
      pivot: [0, 0.82, 0], part: PART.TORSO, mat: MAT.IRON,
      tint: k === 1 ? T_MID : T_DARK, flat: true,
    });
  }
  // Spine ridge.
  for (let k = 0; k < 4; k++) {
    b.add(cone(0.07, 0.26 - k * 0.04, 4), {
      pos: [0, 1.50 - k * 0.16, -0.24 + k * 0.015], rot: [-1.9, 0, 0],
      pivot: [0, 0.82, 0], part: PART.TORSO, mat: MAT.BONE, tint: T_PALE,
    });
  }

  // Enormous pauldrons — the defining read.
  b.add(ico(0.30, 0), {
    pos: [0.50, 1.44, 0], scale: [1.1, 0.9, 1.05], rot: [0, 0.3, 0.25],
    pivot: [0.44, 1.36, 0], part: PART.ARM_L, mat: MAT.IRON, tint: T_MID, flat: true,
  });
  b.add(cone(0.09, 0.34, 4), {
    pos: [0.66, 1.62, 0], rot: [0, 0, -0.75],
    pivot: [0.44, 1.36, 0], part: PART.ARM_L, mat: MAT.BONE, tint: T_PALE,
  });
  b.add(cap(0.155, 0.30, 2, 6), {
    pos: [0.52, 1.08, 0.04], rot: [0.2, 0, 0.08],
    pivot: [0.44, 1.36, 0], part: PART.ARM_L, mat: MAT.HIDE, tint: T_DARK,
  });
  b.add(ico(0.15, 0), {
    pos: [0.55, 0.80, 0.10], pivot: [0.44, 1.36, 0],
    part: PART.ARM_L, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.mirror(4, { [PART.ARM_L]: PART.ARM_R });

  // Head — sunk, helmeted, tusked.
  b.add(ico(0.20, 0), {
    pos: [0, 1.56, 0.10], scale: [1, 0.9, 1.1],
    pivot: [0, 1.44, 0.02], part: PART.HEAD, mat: MAT.HIDE, tint: T_MID, flat: true,
  });
  b.add(box(0.38, 0.16, 0.34), {
    pos: [0, 1.66, 0.08], rot: [-0.1, 0, 0],
    pivot: [0, 1.44, 0.02], part: PART.HEAD, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.add(cone(0.075, 0.34, 5), {
    pos: [0.13, 1.44, 0.22], rot: [-0.4, 0, 0.35],
    pivot: [0, 1.44, 0.02], part: PART.HEAD, mat: MAT.BONE, tint: T_PALE,
  });
  b.add(ico(0.04, 0), {
    pos: [0.08, 1.56, 0.26], pivot: [0, 1.44, 0.02], part: PART.HEAD, mat: MAT.GLOW,
  });
  b.mirror(2);

  // Plated skirt / tassets.
  b.add(cone(0.42, 0.34, 8, 1), {
    pos: [0, 0.72, 0], rot: [Math.PI, 0, 0],
    pivot: [0, 0.86, 0], part: PART.CLOTH, mat: MAT.IRON, tint: T_DARK, flat: true,
  });

  return b.build();
}

// =============================================================================
// FLYING — "wisp". No legs. Bulbous lantern core, two membranous wings,
// trailing tendrils. Silhouette: a hovering kite. Only unit with wings.
// =============================================================================
export function makeWispGeometry() {
  const b = new Builder();

  // Hooded shell with the lantern core protruding from under the cowl, so the
  // glow is actually visible instead of sealed inside the body.
  b.add(ico(0.30, 0), {
    pos: [0, 1.22, -0.02], scale: [1.05, 1.05, 1.05],
    pivot: [0, 1.26, 0], part: PART.TORSO, mat: MAT.HIDE, tint: T_DARK, flat: true,
  });
  b.add(ico(0.185, 1), {
    pos: [0, 1.34, 0.16], pivot: [0, 1.26, 0], part: PART.TORSO, mat: MAT.GLOW,
  });
  b.add(cone(0.34, 0.46, 6, 1), {
    pos: [0, 1.54, -0.06], rot: [-0.18, 0, 0],
    pivot: [0, 1.34, 0], part: PART.HEAD, mat: MAT.CLOTH, tint: T_DARK, flat: true,
  });
  b.add(ico(0.075, 0), {
    pos: [0.09, 1.42, 0.22], pivot: [0, 1.34, 0], part: PART.HEAD, mat: MAT.GLOW,
  });
  b.mirror(1);

  // WINGS — ROUND 2 REWRITE.
  //
  // Round 1 built these as CircleGeometry triangles rotated by Y=PI/2, which
  // stands them up in the ZY plane. The gameplay camera looks DOWN at ~55°, so
  // it saw them exactly edge-on: the wisp lost most of its silhouette at the
  // one angle the game is actually played from, and what was left was a pair of
  // hairlines. They are now near-horizontal slabs with real thickness — a manta
  // planform, which is the shape a top-down camera can actually see — with only
  // a shallow dihedral so they still read from a low angle.
  const WP = [0.18, 1.34, 0];
  const membrane = (w, d, t) => box(w, t, d);
  b.add(membrane(0.62, 0.86, 0.05), {
    pos: [0.44, 1.36, -0.02], rot: [0.05, 0.16, 0.26],
    pivot: WP, part: PART.WING_L, mat: MAT.CLOTH, tint: [0.30, 0.24, 0.36], flat: true,
  });
  b.add(membrane(0.52, 0.60, 0.045), {
    pos: [0.86, 1.31, -0.14], rot: [0.10, 0.30, 0.36],
    pivot: WP, part: PART.WING_L, mat: MAT.CLOTH, tint: [0.22, 0.18, 0.28], flat: true,
  });
  b.add(membrane(0.34, 0.36, 0.04), {
    pos: [1.16, 1.26, -0.30], rot: [0.14, 0.48, 0.44],
    pivot: WP, part: PART.WING_L, mat: MAT.CLOTH, tint: [0.17, 0.14, 0.22], flat: true,
  });
  // Glowing spars along the leading edge — reads as a bright arc from above.
  b.bone(WP, [0.86, 1.40, 0.16], 0.045, { part: PART.WING_L, mat: MAT.GLOW });
  b.bone([0.86, 1.40, 0.16], [1.30, 1.33, -0.10], 0.036, { part: PART.WING_L, mat: MAT.GLOW, pivot: WP });
  b.add(cone(0.05, 0.26, 4), {
    pos: [1.42, 1.29, -0.22], rot: [0, 0.5, -1.25],
    pivot: WP, part: PART.WING_L, mat: MAT.BONE, tint: T_MID,
  });
  b.mirror(6, { [PART.WING_L]: PART.WING_R });

  // Trailing tendrils.
  for (let k = 0; k < 3; k++) {
    b.bone([(k - 1) * 0.14, 1.08, -0.04], [(k - 1) * 0.24, 0.66 + k * 0.06, -0.16], 0.038, {
      part: PART.TAIL, mat: MAT.HIDE, tint: T_DARK, pivot: [0, 1.14, 0],
    });
  }
  // Orbiting rune ring — continuous secondary motion, and the flattest thing on
  // the model, so it is what a top-down camera reads first.
  b.add(torus(0.58, 0.030, 4, 14), {
    pos: [0, 1.18, 0], rot: [Math.PI / 2, 0, 0],
    pivot: [0, 1.18, 0], part: PART.ORBIT, mat: MAT.GLOW,
  });

  return b.build();
}

// =============================================================================
// BOSS — "colossus". 2.4 model units tall before its 2.2× instance scale, so it
// stands ~5 world units — taller than a tower. Crown of horns, back banner on a
// pole, cracked glowing core, ground rune ring, cape.
// =============================================================================
export function makeColossusGeometry() {
  const b = new Builder();

  // Ground rune ring — the "an event is happening" tell.
  b.add(torus(0.92, 0.05, 4, 24), {
    pos: [0, 0.07, 0], rot: [Math.PI / 2, 0, 0],
    pivot: [0, 0, 0], part: PART.ORBIT, mat: MAT.GLOW,
  });
  b.add(torus(1.16, 0.025, 4, 20), {
    pos: [0, 0.05, 0], rot: [Math.PI / 2, 0, 0],
    pivot: [0, 0, 0], part: PART.STATIC, mat: MAT.GLOW,
  });

  // Legs — massive, splayed, plated.
  b.add(cyl(0.26, 0.22, 0.56, 7), {
    pos: [0.40, 0.68, 0], rot: [0, 0, 0.06],
    pivot: [0.40, 0.96, 0], part: PART.LEG_L, mat: MAT.HIDE, tint: T_DARK, flat: true,
  });
  b.add(box(0.46, 0.26, 0.34), {
    pos: [0.42, 0.78, 0.10], pivot: [0.40, 0.96, 0],
    part: PART.LEG_L, mat: MAT.IRON, tint: T_MID, flat: true,
  });
  b.add(cyl(0.20, 0.24, 0.36, 7), {
    pos: [0.40, 0.24, 0.02], pivot: [0.40, 0.96, 0],
    part: PART.LEG_L, mat: MAT.HIDE, tint: T_MID, flat: true,
  });
  b.add(box(0.40, 0.16, 0.52), {
    pos: [0.40, 0.09, 0.10], pivot: [0.40, 0.96, 0],
    part: PART.LEG_L, mat: MAT.IRON, tint: T_DARK, flat: true,
  });
  b.add(cone(0.06, 0.22, 4), {
    pos: [0.40, 0.10, 0.38], rot: [1.45, 0, 0],
    pivot: [0.40, 0.96, 0], part: PART.LEG_L, mat: MAT.BONE, tint: T_PALE,
  });
  b.mirror(5, { [PART.LEG_L]: PART.LEG_R });

  // Torso — huge inverted wedge.
  b.add(box(0.86, 0.80, 0.58), {
    pos: [0, 1.42, 0], rot: [0.08, 0, 0], scale: [1, 1, 1],
    pivot: [0, 1.0, 0], part: PART.TORSO, mat: MAT.HIDE, tint: T_DARK, flat: true,
  });
  b.add(box(1.06, 0.34, 0.60), {
    pos: [0, 1.76, 0], rot: [0.04, 0, 0],
    pivot: [0, 1.0, 0], part: PART.TORSO, mat: MAT.IRON, tint: T_MID, flat: true,
  });
  // Cracked core — glowing chest wound.
  b.add(ico(0.24, 0), {
    pos: [0, 1.48, 0.30], scale: [1, 1.2, 0.5],
    pivot: [0, 1.0, 0], part: PART.TORSO, mat: MAT.GLOW, flat: true,
  });
  b.add(box(0.06, 0.44, 0.06), {
    pos: [0.16, 1.62, 0.30], rot: [0, 0, -0.4],
    pivot: [0, 1.0, 0], part: PART.TORSO, mat: MAT.GLOW,
  });
  b.mirror(1);
  b.add(box(0.05, 0.30, 0.05), {
    pos: [-0.05, 1.20, 0.31], rot: [0, 0, 0.25],
    pivot: [0, 1.0, 0], part: PART.TORSO, mat: MAT.GLOW,
  });
  // Belly plates.
  for (let k = 0; k < 3; k++) {
    b.add(box(0.80 - k * 0.08, 0.16, 0.14), {
      pos: [0, 1.06 + k * 0.16, 0.30 - k * 0.02],
      pivot: [0, 1.0, 0], part: PART.TORSO, mat: MAT.IRON, tint: T_DARK, flat: true,
    });
  }

  // Back banner — pole + torn flag. Highest point of the silhouette.
  b.add(cap(0.045, 1.30, 2, 5), {
    pos: [-0.34, 2.10, -0.38], rot: [0.24, 0, 0.16],
    pivot: [-0.30, 1.50, -0.30], part: PART.TORSO, mat: MAT.IRON, tint: T_DARK,
  });
  b.add(plane(0.46, 0.86), {
    pos: [-0.16, 2.36, -0.44], rot: [0, 0.25, 0.10],
    pivot: [-0.36, 2.72, -0.50], part: PART.CLOTH, mat: MAT.CLOTH, tint: T_RUST,
  });
  b.add(cone(0.06, 0.26, 4), {
    pos: [-0.44, 2.82, -0.52], rot: [0.24, 0, 0.16],
    pivot: [-0.30, 1.50, -0.30], part: PART.TORSO, mat: MAT.BONE, tint: T_PALE,
  });

  // Shoulders — colossal spiked pauldrons.
  b.add(ico(0.42, 0), {
    pos: [0.72, 1.88, 0], scale: [1.05, 0.85, 1.0], rot: [0, 0.4, 0.2],
    pivot: [0.62, 1.78, 0], part: PART.ARM_L, mat: MAT.IRON, tint: T_MID, flat: true,
  });
  for (let k = 0; k < 3; k++) {
    b.add(cone(0.09, 0.40 - k * 0.06, 4), {
      pos: [0.92 - k * 0.10, 2.10 + k * 0.02, -0.20 + k * 0.20], rot: [0.2 - k * 0.2, 0, -0.85],
      pivot: [0.62, 1.78, 0], part: PART.ARM_L, mat: MAT.BONE, tint: T_PALE,
    });
  }
  b.add(cap(0.17, 0.42, 2, 6), {
    pos: [0.78, 1.40, 0.04], rot: [0.2, 0, 0.10],
    pivot: [0.62, 1.78, 0], part: PART.ARM_L, mat: MAT.HIDE, tint: T_DARK,
  });
  b.add(ico(0.21, 0), {
    pos: [0.82, 1.00, 0.10], pivot: [0.62, 1.78, 0],
    part: PART.ARM_L, mat: MAT.IRON, tint: T_MID, flat: true,
  });
  b.mirror(6, { [PART.ARM_L]: PART.ARM_R });

  // A great notched blade dragged in the left fist.
  b.add(box(0.09, 1.30, 0.26), {
    pos: [-0.86, 0.72, 0.26], rot: [0.55, 0.1, 0.18],
    pivot: [0.62, 1.78, 0], part: PART.ARM_R, mat: MAT.IRON, tint: T_MID, flat: true,
  });
  b.add(box(0.07, 0.34, 0.10), {
    pos: [-0.88, 1.30, -0.10], rot: [0.55, 0.1, 0.18],
    pivot: [0.62, 1.78, 0], part: PART.ARM_R, mat: MAT.CLOTH, tint: T_RUST,
  });

  // Head — small relative to the shoulders, crowned, glowing eyes.
  b.add(ico(0.24, 0), {
    pos: [0, 2.06, 0.10], scale: [1, 1.1, 1.05],
    pivot: [0, 1.90, 0], part: PART.HEAD, mat: MAT.HIDE, tint: T_DARK, flat: true,
  });
  b.add(box(0.44, 0.18, 0.40), {
    pos: [0, 2.18, 0.08], rot: [-0.1, 0, 0],
    pivot: [0, 1.90, 0], part: PART.HEAD, mat: MAT.IRON, tint: T_MID, flat: true,
  });
  // Crown of five horns.
  for (let k = 0; k < 3; k++) {
    b.add(cone(0.065, 0.40 - k * 0.07, 5), {
      pos: [0.10 + k * 0.13, 2.34 + (k === 0 ? 0.06 : 0), -0.02 - k * 0.05],
      rot: [-0.25, 0, 0.25 + k * 0.22],
      pivot: [0, 1.90, 0], part: PART.HEAD, mat: MAT.BONE, tint: T_PALE,
    });
  }
  b.mirror(3);
  b.add(cone(0.06, 0.46, 5), {
    pos: [0, 2.42, -0.06], rot: [-0.2, 0, 0],
    pivot: [0, 1.90, 0], part: PART.HEAD, mat: MAT.BONE, tint: T_PALE,
  });
  // Eyes — two hot slits.
  b.add(box(0.10, 0.045, 0.04), {
    pos: [0.09, 2.05, 0.30], rot: [0, 0, 0.2],
    pivot: [0, 1.90, 0], part: PART.HEAD, mat: MAT.GLOW,
  });
  b.mirror(1);

  // Cape.
  b.add(plane(1.00, 1.30), {
    pos: [0, 1.28, -0.40], rot: [-0.16, 0, 0],
    pivot: [0, 1.92, -0.30], part: PART.CLOTH, mat: MAT.CLOTH, tint: [0.30, 0.26, 0.28],
  });

  return b.build();
}

export const ARCHETYPE_BUILDERS = {
  mite: makeMiteGeometry,
  runner: makeRunnerGeometry,
  grunt: makeGruntGeometry,
  brute: makeBruteGeometry,
  wisp: makeWispGeometry,
  colossus: makeColossusGeometry,
};
