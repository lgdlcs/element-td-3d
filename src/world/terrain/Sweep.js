import * as THREE from 'three';

/**
 * Sweep a 2D profile around a closed path. This is how the arena rim stops
 * being a box: a real moulding profile (coping, chamfer, drip, frieze,
 * battered wall, underside turn-in) extruded around the platform perimeter,
 * with per-stone jitter and crumble baked into the vertices.
 *
 * Path points: { x, z, nx, nz, u, stone, t }
 *   nx/nz is the outward normal (mitred at corners).
 *   u is arc length; stone is the index of the coping block; t is 0..1 within it.
 *
 * Profile points: { o, y, hard?, cop?, wall?, bO?, bY?, tag? }
 *   o = outward offset, y = height, hard = break the shading normal here,
 *   cop = this vertex belongs to the coping block (receives per-stone jitter),
 *   wall = this vertex is on the coursed-masonry retaining face.
 *   bO/bY = where this profile point moves to at FULL BREACH (see below).
 *
 * BREACHES — ART BIBLE LAW 6, ADDED ROUND 5.
 *
 * Three independent blind critics, unprompted, all named the same defect: the
 * board's edge is "a single unbroken extruded rectangle", "a bright hard bar",
 * "the highest-contrast edge in the frame, so the eye goes to a decorative
 * frame instead of the combat". The craft of the wall was not the problem. Its
 * CONTINUITY was. A wall is allowed; a border is not.
 *
 * So the sweep takes a `breach(x, z)` field, 0..1, and every profile point
 * carrying a bO/bY target lerps toward that target as the field rises. At full
 * breach the coping, the kerb and the top two courses are all submerged BELOW
 * the ground plane's own skirted edge, and what is left is a rubble bank
 * running from the board floor down to the surround — i.e. the terrain reads
 * continuously ACROSS the boundary, which is exactly what law 6 asks for and
 * what no amount of dirtying a continuous wall could ever produce.
 *
 * The breach targets are chosen so the FOOTING NEVER MOVES (o = 0.75/0.92 are
 * untouched): the environment agent's apron meets us at 27.20/21.20 and a
 * collapsed section must not renegotiate that joint.
 *
 * The sweep also emits `aU` — arc length along the path in WORLD UNITS. The
 * rim's masonry is analytic and needs a run coordinate that is continuous
 * around the loop and identical to the one the coping blocks were laid on;
 * deriving it in the fragment shader from world XZ would disagree with the
 * geometry at every mitred corner.
 */

export function rectPath(hx, hz, ds = 0.5, stoneLen = 2.0) {
  const corners = [
    { x: -hx, z: -hz }, { x: hx, z: -hz }, { x: hx, z: hz }, { x: -hx, z: hz },
  ];
  const edgeN = [
    { nx: 0, nz: -1 }, { nx: 1, nz: 0 }, { nx: 0, nz: 1 }, { nx: -1, nz: 0 },
  ];

  const pts = [];
  let u = 0;
  for (let e = 0; e < 4; e++) {
    const a = corners[e], b = corners[(e + 1) % 4];
    const n = edgeN[e];
    const prevN = edgeN[(e + 3) % 4];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(2, Math.round(len / ds));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      let nx = n.nx, nz = n.nz;
      if (s === 0) {
        // mitre the corner so the moulding turns cleanly
        nx = (n.nx + prevN.nx); nz = (n.nz + prevN.nz);
        const l = Math.hypot(nx, nz) || 1;
        nx = (nx / l) * Math.SQRT2; nz = (nz / l) * Math.SQRT2;
      }
      pts.push({ x, z, nx, nz, u: u + len * t });
    }
    u += len;
  }

  const total = u;
  // Assign coping stones, snapping the count so blocks close the loop evenly.
  const stones = Math.max(8, Math.round(total / stoneLen));
  const sl = total / stones;
  for (const p of pts) {
    p.stone = Math.floor(p.u / sl) % stones;
    p.t = (p.u / sl) % 1;
  }
  pts.stoneCount = stones;
  pts.total = total;
  return pts;
}

/**
 * Duplicate path samples at coping-block boundaries so adjacent blocks can
 * have different heights without smearing the shading between them.
 */
function splitAtStones(path) {
  const out = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const prev = path[(i - 1 + path.length) % path.length];
    if (p.stone !== prev.stone) {
      out.push({ ...prev, stone: prev.stone, t: 1, u: p.u, x: p.x, z: p.z, nx: p.nx, nz: p.nz });
    }
    out.push(p);
  }
  // close the loop
  const first = path[0], last = path[path.length - 1];
  out.push({ ...last, stone: last.stone, t: 1, u: path.total, x: first.x, z: first.z, nx: first.nx, nz: first.nz });
  out.push({ ...first, u: path.total });
  out.total = path.total;
  out.stoneCount = path.stoneCount;
  return out;
}

/** Expand hard profile points into duplicates so normals break there. */
function expandProfile(profile) {
  const out = [];
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    out.push({ ...p });
    if (p.hard && i < profile.length - 1) out.push({ ...p, dup: true });
  }
  return out;
}

export function sweepProfile(rawPath, rawProfile, {
  jitter = null,          // (stoneIndex) => { dy, doff, crumble }
  uvScale = 0.25,
  closed = true,
  breach = null,          // (x, z) => 0..1, see the header
} = {}) {
  const path = closed ? splitAtStones(rawPath) : rawPath;
  const prof = expandProfile(rawProfile);
  const P = path.length, Q = prof.length;

  // cumulative profile arc length for V
  const vs = new Float32Array(Q);
  for (let j = 1; j < Q; j++) {
    vs[j] = vs[j - 1] + Math.hypot(prof[j].o - prof[j - 1].o, prof[j].y - prof[j - 1].y);
  }

  const pos = new Float32Array(P * Q * 3);
  const uv = new Float32Array(P * Q * 2);
  const cop = new Float32Array(P * Q);      // 1 where this vertex is coping
  const wal = new Float32Array(P * Q);      // 1 on the coursed retaining face
  const arc = new Float32Array(P * Q);      // arc length along the path, world units
  const brc = new Float32Array(P * Q);      // 0..1 collapse amount (law 6)
  const idx = [];

  for (let i = 0; i < P; i++) {
    const p = path[i];
    const j0 = jitter ? jitter(p.stone) : { dy: 0, doff: 0, crumble: 0 };
    // dome the top of each block a touch so blocks read individually
    const dome = Math.sin(Math.min(1, Math.max(0, p.t)) * Math.PI) * 0.018;
    // The collapse field is evaluated on the PATH LINE, not on the displaced
    // vertex: every point of one profile section must collapse together or the
    // shell tears open (a hole in the rim reads as a missing wall, not as a
    // ruined one, and shows the surround straight through the board).
    const bAmt = breach ? Math.max(0, Math.min(1, breach(p.x, p.z))) : 0;
    // Rubble does not collapse smoothly: a per-metre wobble on the amount
    // means the two shoulders of every breach crumble raggedly instead of
    // ramping like a chamfer.
    const bRag = bAmt > 0.001
      ? Math.max(0, Math.min(1, bAmt * (0.86 + 0.30 * Math.sin(p.u * 2.9 + 1.7)
                                        + 0.16 * Math.sin(p.u * 7.3 - 0.4))))
      : 0;
    for (let j = 0; j < Q; j++) {
      const q = prof[j];
      let o = q.o, y = q.y;
      if (q.cop) {
        o += j0.doff;
        y += j0.dy + dome - j0.crumble * (0.16 + 0.5 * Math.abs(p.t - 0.5));
      } else {
        o += j0.doff * 0.25;
      }
      if (bRag > 0.001 && (q.bY !== undefined || q.bO !== undefined)) {
        const tY = q.bY !== undefined ? q.bY : q.y;
        const tO = q.bO !== undefined ? q.bO : q.o;
        y += (tY - y) * bRag;
        o += (tO - o) * bRag;
      }
      const k = (i * Q + j);
      brc[k] = bRag;
      pos[k * 3] = p.x + p.nx * o;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = p.z + p.nz * o;
      uv[k * 2] = p.u * uvScale;
      uv[k * 2 + 1] = vs[j] * uvScale;
      cop[k] = q.cop ? 1 : 0;
      wal[k] = q.wall ? 1 : 0;
      arc[k] = p.u;
    }
  }

  for (let i = 0; i < P - 1; i++) {
    for (let j = 0; j < Q - 1; j++) {
      if (prof[j + 1].dup) continue;     // hard-edge duplicate: no face across it
      const a = i * Q + j, b = (i + 1) * Q + j, c = (i + 1) * Q + j + 1, d = i * Q + j + 1;
      idx.push(a, b, c, a, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aCoping', new THREE.BufferAttribute(cop, 1));
  geo.setAttribute('aWall', new THREE.BufferAttribute(wal, 1));
  geo.setAttribute('aU', new THREE.BufferAttribute(arc, 1));
  geo.setAttribute('aBreach', new THREE.BufferAttribute(brc, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.userData.arcTotal = path.total;
  return geo;
}

/**
 * Build a band geometry between two profile points — used for rune inlays.
 *
 * ROUND 4b: the band takes an offset PER EDGE, not one for the whole strip.
 * The rim runes used to sit on the outer fascia, which is a vertical surface
 * facing away from a camera pitched 55 degrees down — they were never once
 * visible in a capture. They now lie on the coping's INNER chamfer, which is a
 * sloped face, and a strip at a single offset cannot follow it.
 */
export function sweepBand(rawPath, yTop, yBot, offset, {
  uvRepeat = 1, offsetBot = null, breach = null,
} = {}) {
  const path = rawPath;
  const P = path.length;
  const oT = offset;
  const oB = offsetBot === null ? offset : offsetBot;
  const pos = new Float32Array((P + 1) * 2 * 3);
  const uv = new Float32Array((P + 1) * 2 * 2);
  // A continuous glowing line around the whole board IS the picture frame the
  // critics saw (law 6). `aLive` lets the fragment shader extinguish the frieze
  // wherever the wall carrying it has collapsed, and in authored dead stretches
  // besides, so the inlay reads as surviving fragments of a frieze rather than
  // as a neon border.
  const live = new Float32Array((P + 1) * 2);
  const idx = [];
  const total = path.total ?? 1;
  for (let i = 0; i <= P; i++) {
    const p = path[i % P];
    const u = (i === P ? total : p.u) / total * uvRepeat;
    const b = breach ? Math.max(0, Math.min(1, breach(p.x, p.z))) : 0;
    // Long, non-commensurate gating so whole runs of the frieze are simply
    // absent — the band survives on roughly half the perimeter.
    const gate = 0.5 + 0.5 * Math.sin(p.u * 0.132 + 0.9)
               + 0.34 * Math.sin(p.u * 0.061 - 2.2);
    let seg = Math.max(0, Math.min(1, (gate - 0.62) * 2.6));
    // ...and NEVER at a corner. A capture with only the arc gate still showed a
    // bright blue L wrapping the north-east corner, which is the single most
    // frame-like shape available: two straight bright lines meeting at a right
    // angle is what a picture frame IS. Corners are the last place a surviving
    // fragment of frieze may sit.
    const cx = Math.abs(p.x), cz = Math.abs(p.z);
    const mx = Math.max(cx, cz);
    const corner = mx > 1e-3 ? Math.min(cx, cz) / mx : 0;
    seg *= 1 - Math.max(0, Math.min(1, (corner - 0.55) / 0.30));
    for (let j = 0; j < 2; j++) {
      const k = i * 2 + j;
      live[k] = seg * (1 - b);
      const y = j === 0 ? yTop : yBot;
      const o = j === 0 ? oT : oB;
      pos[k * 3] = p.x + p.nx * o;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = p.z + p.nz * o;
      uv[k * 2] = u;
      uv[k * 2 + 1] = 1 - j;
    }
  }
  for (let i = 0; i < P; i++) {
    const a = i * 2, b = (i + 1) * 2;
    idx.push(a, b, b + 1, a, b + 1, a + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aLive', new THREE.BufferAttribute(live, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
