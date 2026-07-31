import * as THREE from 'three';

/**
 * Creep-owned FX pools. Three draw calls total, all instanced, all CPU-simulated
 * over small fixed pools so cost is bounded no matter how hard the board dies.
 *
 *   ParticleField  — soft billboards (smoke, embers, motes) AND ground-aligned
 *                    decals (scorch, ash, shockwaves) in ONE draw call, using
 *                    premultiplied alpha so additive and alpha sprites coexist.
 *   GibField       — instanced shards for shatter/ragdoll deaths.
 *   ContactField   — a per-creep ground quad: dark contact occlusion plus an
 *                    element-coloured glow puddle. This is what stops units
 *                    looking like they float, and it is the single strongest
 *                    "how many are there" cue from a top-down camera.
 */

// =============================================================================
export const PK = { SMOKE: 0, EMBER: 1, SCORCH: 2, RUNE: 3 };

export class ParticleField {
  constructor(capacity = 1100) {
    this.cap = capacity;
    this.n = 0;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.max = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.kind = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.col = new Float32Array(capacity * 3);

    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;

    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    for (const a of [this.aP, this.aD, this.aC]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aP', this.aP);
    geo.setAttribute('aD', this.aD);   // size, life01, kind, seed
    geo.setAttribute('aC', this.aC);
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */`
        attribute vec3 aP;
        attribute vec4 aD;
        attribute vec3 aC;
        varying vec2 vUv;
        varying vec4 vD;
        varying vec3 vC;
        void main() {
          vUv = uv; vD = aD; vC = aC;
          float s = aD.x;
          if (aD.z > 1.5) {
            // ground-aligned decal
            float a = aD.w * 6.283;
            float ca = cos(a), sa = sin(a);
            vec2 p = vec2(position.x * ca - position.y * sa, position.x * sa + position.y * ca) * s;
            vec4 wp = modelMatrix * vec4(aP + vec3(p.x, 0.0, p.y), 1.0);
            gl_Position = projectionMatrix * viewMatrix * wp;
          } else {
            vec4 mv = modelViewMatrix * vec4(aP, 1.0);
            float a = aD.w * 6.283 + aD.y * 1.2;
            float ca = cos(a), sa = sin(a);
            mv.xy += vec2(position.x * ca - position.y * sa, position.x * sa + position.y * ca) * s;
            gl_Position = projectionMatrix * mv;
          }
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        varying vec4 vD;
        varying vec3 vC;
        void main() {
          vec2 d = vUv - 0.5;
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          float k = vD.z;
          float t = vD.y;                    // 1 -> 0 over life
          float soft = pow(1.0 - r, 1.6);

          if (k < 0.5) {                     // SMOKE — alpha blended
            float a = soft * t * 0.34;
            gl_FragColor = vec4(vC * a, a);
          } else if (k < 1.5) {              // EMBER — additive (alpha 0)
            float core = pow(1.0 - r, 4.0);
            gl_FragColor = vec4(vC * (core * 2.6 + soft * 0.7) * t, 0.0);
          } else if (k < 2.5) {              // SCORCH — dark alpha decal
            float a = soft * t * 0.72;
            gl_FragColor = vec4(vC * a * 0.25, a);
          } else {                           // RUNE — additive ground ring
            float ring = smoothstep(0.55, 0.92, r) * smoothstep(1.0, 0.90, r);
            gl_FragColor = vec4(vC * (ring * 3.0 + soft * 0.35) * t, 0.0);
          }
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.geo = geo;
  }

  emit(kind, x, y, z, vx, vy, vz, size, life, r, g, b, grow = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.max[i] = life;
    this.size[i] = size; this.grow[i] = grow;
    this.kind[i] = kind;
    this.seed[i] = Math.random();
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
  }

  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        n--;
        if (i !== n) {
          this.px[i] = this.px[n]; this.py[i] = this.py[n]; this.pz[i] = this.pz[n];
          this.vx[i] = this.vx[n]; this.vy[i] = this.vy[n]; this.vz[i] = this.vz[n];
          this.life[i] = this.life[n]; this.max[i] = this.max[n];
          this.size[i] = this.size[n]; this.grow[i] = this.grow[n];
          this.kind[i] = this.kind[n]; this.seed[i] = this.seed[n];
          this.col[i * 3] = this.col[n * 3];
          this.col[i * 3 + 1] = this.col[n * 3 + 1];
          this.col[i * 3 + 2] = this.col[n * 3 + 2];
        }
        i--;
        continue;
      }
      const k = this.kind[i];
      if (k < 1.5) {
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        if (k < 0.5) {                       // smoke: rises, drags
          this.vx[i] *= 1 - dt * 1.4; this.vz[i] *= 1 - dt * 1.4;
          this.vy[i] += dt * 0.35;
        } else {                             // ember: gravity
          this.vy[i] -= dt * 4.2;
          this.vx[i] *= 1 - dt * 0.9; this.vz[i] *= 1 - dt * 0.9;
          if (this.py[i] < 0.05) { this.py[i] = 0.05; this.vy[i] = Math.abs(this.vy[i]) * 0.28; }
        }
      }
      this.size[i] += this.grow[i] * dt;
    }
    this.n = n;

    const P = this.aP.array, D = this.aD.array, C = this.aC.array;
    for (let i = 0; i < n; i++) {
      P[i * 3] = this.px[i]; P[i * 3 + 1] = this.py[i]; P[i * 3 + 2] = this.pz[i];
      D[i * 4] = this.size[i];
      D[i * 4 + 1] = this.life[i] / this.max[i];
      D[i * 4 + 2] = this.kind[i];
      D[i * 4 + 3] = this.seed[i];
      C[i * 3] = this.col[i * 3]; C[i * 3 + 1] = this.col[i * 3 + 1]; C[i * 3 + 2] = this.col[i * 3 + 2];
    }
    this.geo.instanceCount = n;
    this.aP.needsUpdate = true; this.aD.needsUpdate = true; this.aC.needsUpdate = true;
  }
}

// =============================================================================
export class GibField {
  constructor(capacity = 420) {
    this.cap = capacity;
    this.n = 0;
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.rx = new Float32Array(capacity);
    this.ry = new Float32Array(capacity);
    this.wx = new Float32Array(capacity);
    this.wy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.max = new Float32Array(capacity);
    this.sz = new Float32Array(capacity);
    this.gy = new Float32Array(capacity);   // ground height where this gib landed
    this.col = new Float32Array(capacity * 3);

    const geo = new THREE.TetrahedronGeometry(0.5, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      vertexShader: /* glsl */`
        attribute vec3 aC;
        attribute float aFade;
        varying vec3 vC;
        varying float vF;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vC = aC; vF = aFade;
          vN = normalize(mat3(instanceMatrix) * normal);
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vV = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vC;
        varying float vF;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec3 N = normalize(vN);
          vec3 L = normalize(vec3(0.45, 0.8, 0.35));
          float d = max(dot(N, L), 0.0);
          float rim = pow(1.0 - max(dot(N, normalize(vV)), 0.0), 2.0);
          vec3 c = vC * (0.10 + 0.55 * d) + vC * rim * 2.2;
          gl_FragColor = vec4(c, clamp(vF * 1.6, 0.0, 1.0));
        }
      `,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 8;
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aFade = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aC.setUsage(THREE.DynamicDrawUsage);
    this.aFade.setUsage(THREE.DynamicDrawUsage);
    this.mesh.geometry.setAttribute('aC', this.aC);
    this.mesh.geometry.setAttribute('aFade', this.aFade);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  emit(x, y, z, vx, vy, vz, size, life, r, g, b, groundY = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.gy[i] = groundY;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.rx[i] = Math.random() * 6.28; this.ry[i] = Math.random() * 6.28;
    this.wx[i] = (Math.random() - 0.5) * 16; this.wy[i] = (Math.random() - 0.5) * 16;
    this.life[i] = life; this.max[i] = life;
    this.sz[i] = size;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
  }

  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        n--;
        if (i !== n) {
          for (const a of ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'rx', 'ry', 'wx', 'wy', 'life', 'max', 'sz', 'gy']) {
            this[a][i] = this[a][n];
          }
          this.col[i * 3] = this.col[n * 3];
          this.col[i * 3 + 1] = this.col[n * 3 + 1];
          this.col[i * 3 + 2] = this.col[n * 3 + 2];
        }
        i--;
        continue;
      }
      this.vy[i] -= dt * 13.0;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      const floorY = this.gy[i] + this.sz[i] * 0.4;
      if (this.py[i] < floorY) {
        this.py[i] = floorY;
        this.vy[i] = -this.vy[i] * 0.32;
        this.vx[i] *= 0.6; this.vz[i] *= 0.6;
        this.wx[i] *= 0.5; this.wy[i] *= 0.5;
      }
      this.rx[i] += this.wx[i] * dt;
      this.ry[i] += this.wy[i] * dt;
    }
    this.n = n;

    const C = this.aC.array, F = this.aFade.array;
    for (let i = 0; i < n; i++) {
      const t = this.life[i] / this.max[i];
      const s = this.sz[i] * Math.min(1, t * 2.2);
      this._p.set(this.px[i], this.py[i], this.pz[i]);
      this._e.set(this.rx[i], this.ry[i], this.rx[i] * 0.5);
      this._q.setFromEuler(this._e);
      this._s.set(s, s * 1.5, s);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
      C[i * 3] = this.col[i * 3]; C[i * 3 + 1] = this.col[i * 3 + 1]; C[i * 3 + 2] = this.col[i * 3 + 2];
      F[i] = Math.min(1, t * 2.5);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aC.needsUpdate = true;
    this.aFade.needsUpdate = true;
  }
}

// =============================================================================
/** Per-creep ground contact: occlusion core + element-coloured glow puddle. */
export class ContactField {
  constructor(capacity) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;

    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // x,y,z,radius
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4); // rgb, strength
    // dirX, dirZ, aspect (stretch along travel), groundY
    this.aX = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aP.setUsage(THREE.DynamicDrawUsage);
    this.aC.setUsage(THREE.DynamicDrawUsage);
    this.aX.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aP', this.aP);
    geo.setAttribute('aC', this.aC);
    geo.setAttribute('aX', this.aX);
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      // PITFALLS.md §2, for the third time in this codebase. A quad authored in
      // the XY plane and then re-mapped to world XZ by the vertex shader has had
      // its handedness flipped, so its face normal points at -Y and an overhead
      // camera sees only back faces. Measured before this line existed: hiding
      // the entire ContactField changed the pixels under every creep's feet by
      // at most 1/255. It had never drawn anything.
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        attribute vec4 aP;
        attribute vec4 aC;
        attribute vec4 aX;   // dirX, dirZ, aspect, groundY
        varying vec2 vUv;
        varying vec4 vC;
        varying float vH;
        void main() {
          vUv = uv; vC = aC;
          vH = max(0.0, aP.y - aX.w);
          // Oriented along the direction of travel: the pool is stretched
          // forward and offset backward, so it reads as a moving unit's
          // shadow rather than a symmetric sticker.
          vec2 dir = aX.xy;
          vec2 side = vec2(-dir.y, dir.x);
          vec2 off = side * position.x * aP.w
                   + dir  * position.y * aP.w * aX.z
                   - dir  * aP.w * (aX.z - 1.0) * 0.42;
          // LIFT, and it is 6x what round 4 used (0.045). Verified by forcing
          // this material to opaque magenta and capturing a real midgame board:
          // at 0.045 and 0.11 the decal was almost entirely rejected by the
          // depth test, because the creeps walk in a SUNKEN lane and groundY
          // is sampled at the unit's centre while the quad reaches out over the
          // terrace shoulder on either side. Lifting it clears that. The float
          // this introduces is ~5 screen pixels at gameplay zoom and is not
          // detectable; an invisible shadow is.
          vec3 wp = vec3(aP.x + off.x, aX.w + 0.26, aP.z + off.y);
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        varying vec4 vC;
        varying float vH;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          if (r > 1.0) discard;

          // ===================================================================
          // ROUND 5 — this is a SHADOW again, and it was not one before.
          // ===================================================================
          // The blend is premultiplied-alpha NormalBlending, so the result is
          //     out = src.rgb + dst * (1 - src.a)
          // i.e. src.a darkens and src.rgb adds. Round 4 wrote an alpha of
          // at most 0.82 * pow(1-r,1.55) — which is already soft — and then an
          // rgb term of sat * 1.30 * (ring * 3.15 + 0.72), up to ~4 in the
          // channel it was saturating. The additive term won by a factor of
          // five and the "contact shadow" was net BRIGHTER than the floor it
          // was drawn on. Ablated on a real board: hiding the whole creep layer
          // changed nothing dark under the units, because nothing dark was ever
          // there. Three critics asked for "a hard contact shadow"; they were
          // looking at a coloured puddle.
          //
          // Now: a hard, dark, defined ellipse does the contact, and the
          // hostile colour is confined to a thin rim OUTSIDE the dark core
          // where it cannot cancel it.
          float lift = clamp(vH * 0.30, 0.0, 1.0);          // flyers lose contact

          // HARD core with a defined edge. smoothstep(0.30, 0.94) holds full
          // strength across the middle third instead of falling away from the
          // centre like the old pow() did — that flat top is the difference
          // between "this unit sits on the board" and "this unit has some haze
          // near it".
          float core = 1.0 - smoothstep(0.30, 0.94, r);
          float occ = core * (0.86 - 0.72 * lift);

          // Leading edge of the pool is hotter — a direction-of-travel tell
          // that survives even when the creep itself is only 40px tall.
          float lead = smoothstep(0.30, 0.98, vUv.y);

          // A tight annulus of the reserved hostile red, hugging the OUTSIDE of
          // the shadow. Two jobs: it separates the dark ellipse from any dark
          // real shadow the key light is already casting nearby, and it is the
          // one part of a creep that a 3.5-cell tower cannot hide, because it
          // lives on the ground plane.
          float ring = smoothstep(0.60, 0.86, r) * smoothstep(1.0, 0.88, r);
          vec3 hue = vC.rgb / max(max(max(vC.r, vC.g), vC.b), 1e-3);
          float lo = min(min(hue.r, hue.g), hue.b);
          vec3 sat = clamp((hue - lo * 0.6) / max(1.0 - lo * 0.6, 1e-3), 0.0, 1.0);
          vec3 c = sat * vC.w * ring * (0.45 + 0.95 * lead) * (1.0 - 0.55 * lift);
          gl_FragColor = vec4(c, occ);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.geo = geo;
  }

  set(n, x, y, z, radius, r, g, b, strength, dirX = 0, dirZ = 1, aspect = 1, groundY = 0) {
    const P = this.aP.array, C = this.aC.array, X = this.aX.array;
    P[n * 4] = x; P[n * 4 + 1] = y; P[n * 4 + 2] = z; P[n * 4 + 3] = radius;
    C[n * 4] = r; C[n * 4 + 1] = g; C[n * 4 + 2] = b; C[n * 4 + 3] = strength;
    X[n * 4] = dirX; X[n * 4 + 1] = dirZ; X[n * 4 + 2] = aspect; X[n * 4 + 3] = groundY;
  }

  commit(count) {
    this.geo.instanceCount = count;
    this.aP.needsUpdate = true;
    this.aC.needsUpdate = true;
    this.aX.needsUpdate = true;
  }
}
