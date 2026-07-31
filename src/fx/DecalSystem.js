import * as THREE from 'three';

/**
 * Pooled, instanced ground decals.
 *
 * Two pools — one additive (energy: shockwaves, light pools, frost, runes) and
 * one alpha-blended (matter: scorch, craters, poison, dust, projectile shadows)
 * — so the whole persistent-decal layer is exactly TWO draw calls no matter how
 * many marks are on the board.
 *
 * Everything is procedural in the fragment shader: no textures, no atlas, no
 * upload cost. Instances are compacted every frame so `mesh.count` tracks the
 * live set and dead slots cost nothing.
 */

// ---- glow (additive) types -------------------------------------------------
export const G_SHOCK = 0;   // expanding shockwave ring
export const G_POOL = 1;    // soft light pool (fake bounce light / lingering flame)
export const G_FROST = 2;   // crystalline frost patch
export const G_RUNE = 3;    // holy rune circle
export const G_VOID = 4;    // void implosion swirl

// ---- mark (alpha) types ----------------------------------------------------
export const M_SCORCH = 0;  // sooty burn blob
export const M_CRATER = 1;  // radial cracks + rim
export const M_POISON = 2;  // mottled ichor pool
export const M_DUST = 3;    // pale dust ring
export const M_SHADOW = 4;  // soft projectile ground shadow

const COMMON_VERT = /* glsl */`
  attribute vec3 aColor;
  attribute vec4 aInfo;          // x=type y=seed z=age(0..1) w=strength
  varying vec2 vUv;
  varying vec3 vC;
  varying vec4 vI;
  void main() {
    vUv = uv;
    vC = aColor;
    vI = aInfo;
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;

const NOISE = /* glsl */`
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(h21(i), h21(i+vec2(1,0)), f.x),
               mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y);
  }
  float fbm2(vec2 p){
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; }
    return s;
  }
`;

class DecalPool {
  constructor(scene, count, { blending, fragBody, renderOrder, depthWrite = false }) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);

    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.aInfo = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    this.aInfo.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aInfo', this.aInfo);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite,
      depthTest: true,
      blending,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      vertexShader: COMMON_VERT,
      fragmentShader: `precision highp float;
        varying vec2 vUv; varying vec3 vC; varying vec4 vI;
        ${NOISE}
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p) * 2.0;
          float ang = atan(p.y, p.x);
          float t = vI.z;            // 0 -> 1 age
          float seed = vI.y;
          int type = int(vI.x + 0.5);
          vec3 col = vC;
          float a = 0.0;
          ${fragBody}
          a *= vI.w;
          if (a <= 0.003) discard;
          gl_FragColor = vec4(min(col, vec3(3.2)), a);
        }`,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = renderOrder;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.__fx = true;
    scene.add(this.mesh);

    this.cap = count;
    this.items = [];
    for (let i = 0; i < count; i++) {
      this.items.push({ live: false, x: 0, y: 0, z: 0, r0: 1, r1: 1, rot: 0, t: 0, dur: 1, type: 0, seed: 0, strength: 1, ease: 1, r: 0, g: 0, b: 0 });
    }
    this.cursor = 0;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  spawn(x, y, z, r0, r1, dur, type, color, strength = 1, ease = 1) {
    // Prefer a dead slot; otherwise steal the oldest via round-robin.
    let it = null;
    for (let n = 0; n < this.cap; n++) {
      const c = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % this.cap;
      if (!c.live) { it = c; break; }
    }
    if (!it) { it = this.items[this.cursor]; this.cursor = (this.cursor + 1) % this.cap; }
    it.live = true;
    it.x = x; it.y = y; it.z = z;
    it.r0 = r0; it.r1 = r1;
    it.rot = Math.random() * Math.PI * 2;
    it.t = 0; it.dur = Math.max(0.016, dur);
    it.type = type;
    it.seed = Math.random();
    it.strength = strength;
    it.ease = ease;
    it.r = color[0]; it.g = color[1]; it.b = color[2];
    return it;
  }

  update(dt) {
    let n = 0;
    const ci = this.aColor.array, ii = this.aInfo.array;
    for (const it of this.items) {
      if (!it.live) continue;
      it.t += dt / it.dur;
      if (it.t >= 1) { it.live = false; continue; }
      const e = it.ease === 1 ? it.t : 1 - Math.pow(1 - it.t, it.ease);
      const r = it.r0 + (it.r1 - it.r0) * e;
      this._p.set(it.x, it.y, it.z);
      this._q.setFromAxisAngle(this._up, it.rot);
      this._s.set(r * 2, 1, r * 2);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      ci[n * 3] = it.r; ci[n * 3 + 1] = it.g; ci[n * 3 + 2] = it.b;
      ii[n * 4] = it.type; ii[n * 4 + 1] = it.seed;
      ii[n * 4 + 2] = it.t; ii[n * 4 + 3] = it.strength;
      n++;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aInfo.needsUpdate = true;
    }
  }
}

const GLOW_FRAG = /* glsl */`
  if (type == 0) {
    // Shockwave. Element TD 2's rings are thick turbulent *bands* of energy,
    // not sonar pings, so this is a wide wobbling annulus modulated by noise
    // along both the angular and radial axes, over a faint inner wash.
    float w = mix(0.36, 0.11, t);
    float wob = 0.84 + 0.055 * sin(ang * 3.0 + seed * 30.0)
                     + 0.028 * sin(ang * 7.0 - seed * 17.0);
    float band = smoothstep(w, 0.0, abs(r - wob));
    float turb = 0.55 + 0.70 * fbm2(vec2(ang * 2.4, r * 3.2) + seed * 11.0);
    float wash = smoothstep(1.0, 0.15, r) * 0.045 * (1.0 - t);
    a = band * turb * (1.0 - t) * (1.0 - t) + wash;
    col *= 1.0 + (1.0 - t) * 1.4;
  } else if (type == 1) {
    // Light pool. Was f*f — a broad, edgeless disc that read as a projected
    // sticker. Now a small hot centre inside a much faster-decaying body, so
    // the pool has a legible core and its coverage area is roughly halved.
    float f = smoothstep(1.0, 0.0, r);
    float f2 = f * f;
    float body = f2 * f;               // pow(f, 3)
    float hot = f2 * f2 * f2 * f2 * f; // pow(f, 9)
    a = (body * 0.52 + hot * 0.95) * (1.0 - t);
    col *= 1.0 + (1.0 - t) * 0.6 + hot * 0.5;
  } else if (type == 2) {
    // Frost. The previous version used radial sin() spokes and read as a flat
    // 2D pinwheel — the single worst sprite on the board. Frost is fractured
    // *plates* of rime, so this is noise-driven cellular breakup with a rimed
    // outer lip and no angular symmetry at all.
    float n1 = fbm2(p * 8.0 + seed * 23.0);
    float n2 = fbm2(p * 19.0 - seed * 7.0);
    float body = smoothstep(1.0, 0.10, r + (n1 - 0.5) * 0.30);
    float plates = smoothstep(0.46, 0.80, n1 * 0.7 + n2 * 0.45);
    float lip = smoothstep(0.17, 0.0, abs(r + (n1 - 0.5) * 0.4 - 0.85));
    float grow = smoothstep(0.0, 0.26, t);
    // The flat body wash is the part that has no edge, so it carries the
    // least weight; the plates and the lip are the shape.
    a = (body * 0.10 + plates * body * 0.50 + lip * 0.34) * grow
      * (1.0 - smoothstep(0.5, 1.0, t));
    col = mix(col, vec3(0.80, 0.92, 1.0), plates * 0.55);
  } else if (type == 3) {
    // Rune circle. Two soft rings plus a handful of glyph blocks — a sigil,
    // not a clock face. 24 evenly spaced ticks read as UI, so there are 9.
    float ring1 = smoothstep(0.055, 0.0, abs(r - 0.92));
    float ring2 = smoothstep(0.032, 0.0, abs(r - 0.64));
    float glyph = step(0.78, fract(ang / 6.2831 * 9.0 + seed))
                * smoothstep(0.10, 0.0, abs(r - 0.79));
    a = (ring1 * 0.85 + ring2 * 0.45 + glyph * 0.75) * (1.0 - t) * (1.0 - t);
    col *= 1.9;
  } else {
    // void swirl: spiral arms collapsing inward
    float spiral = sin(ang * 3.0 - r * 9.0 + t * 12.0 + seed * 20.0);
    // Squared so the disc has a falloff instead of a hard flat plateau; the
    // arms keep their weight, the wash between them loses most of its.
    float body = smoothstep(1.0, 0.1, r);
    body *= body;
    a = body * (0.20 + 0.55 * smoothstep(0.1, 0.9, spiral)) * (1.0 - t);
    col *= 1.0 + (1.0 - t) * 1.2;
  }
`;

const MARK_FRAG = /* glsl */`
  float n = fbm2(p * 4.5 + seed * 27.0);
  if (type == 0) {
    // scorch: irregular soot blob, dark, fades slowly
    float edge = smoothstep(0.95, 0.25, r + (n - 0.5) * 0.75);
    float core = smoothstep(0.55, 0.0, r + (n - 0.5) * 0.4);
    // A few dying embers around the rim, not a glowing torus.
    float ember = smoothstep(0.16, 0.0, abs(r + (n - 0.5) * 0.6 - 0.60))
                * smoothstep(0.45, 0.75, n) * (1.0 - smoothstep(0.0, 0.30, t));
    a = (edge * 0.34 + core * 0.24 + ember * 0.30) * (1.0 - smoothstep(0.35, 1.0, t));
    col = mix(vec3(0.03, 0.02, 0.02), col * 0.35, core * 0.8);
    col = mix(col, col * 1.5 + vec3(0.14, 0.05, 0.01), ember);
  } else if (type == 1) {
    // crater: dark bowl, radial cracks, dusty rim
    // Cracks must NOT converge on the centre — that reads as a pinwheel.
    // They start outside the bowl and die before the rim.
    float ca = abs(fract(ang / 6.2831 * 7.0 + seed + n * 0.55) - 0.5) * 2.0;
    float cracks = smoothstep(0.88, 1.0, ca)
                 * smoothstep(0.10, 0.42, r) * smoothstep(1.0, 0.55, r);
    float bowl = smoothstep(0.85, 0.1, r + (n - 0.5) * 0.35);
    float rim = smoothstep(0.12, 0.0, abs(r - 0.8)) * 0.4;
    a = (bowl * 0.30 + cracks * 0.62 + rim * 0.5) * (1.0 - smoothstep(0.4, 1.0, t));
    col = mix(vec3(0.04, 0.033, 0.026), col * 1.6, clamp(rim * 2.2 + cracks * 0.25, 0.0, 1.0));
  } else if (type == 2) {
    // poison: mottled ichor, slow boil
    float boil = fbm2(p * 6.0 + vec2(0.0, t * 1.6) + seed * 13.0);
    float body = smoothstep(0.95, 0.2, r + (boil - 0.5) * 0.5);
    a = body * body * 0.36 * (1.0 - smoothstep(0.45, 1.0, t));
    col = mix(col * 0.5, col * 1.4, smoothstep(0.4, 0.75, boil));
  } else if (type == 3) {
    // dust: expanding pale annulus
    // Narrower annulus at lower alpha: the wide pale version was the single
    // largest flat translucent area the VFX layer put on the board.
    float edge = smoothstep(0.22, 0.0, abs(r - 0.76)) * smoothstep(1.02, 0.62, r);
    a = edge * 0.13 * (1.0 - t) * (1.0 - t) * (0.6 + 0.6 * n);
  } else {
    // soft projectile shadow
    float f = smoothstep(1.0, 0.15, r);
    a = f * f * 0.42;
    col = vec3(0.0);
  }
`;

export class DecalSystem {
  constructor(scene, glowCount = 96, markCount = 96) {
    /**
     * Terrain height query, injected by Game.js. Buildable ground is a raised
     * terrace (ART_BIBLE law 3), so a decal pinned to a hardcoded Y sinks into
     * the terrace floor on the high ground and floats over the road on the low
     * — which is precisely why the pools read as "projected blobs" that never
     * touch anything. With this set, every decal is seated on the real surface.
     */
    this.heightAt = null;
    this.glow = new DecalPool(scene, glowCount, {
      blending: THREE.AdditiveBlending, fragBody: GLOW_FRAG, renderOrder: 7,
    });
    this.mark = new DecalPool(scene, markCount, {
      blending: THREE.NormalBlending, fragBody: MARK_FRAG, renderOrder: 6,
    });
  }

  /** Surface Y for a decal at (x, z), including its float-above-ground bias. */
  #seat(x, z, bias) {
    const h = this.heightAt ? this.heightAt(x, z) : 0;
    return (Number.isFinite(h) ? h : 0) + bias;
  }

  /** Additive energy decal. */
  addGlow(x, z, r0, r1, dur, type, color, strength = 1, ease = 1, y = null) {
    return this.glow.spawn(x, y ?? this.#seat(x, z, 0.055), z, r0, r1, dur, type, color, strength, ease);
  }

  /** Alpha-blended matter decal (scorch / crater / pool / dust / shadow). */
  addMark(x, z, r0, r1, dur, type, color, strength = 1, ease = 1, y = null) {
    return this.mark.spawn(x, y ?? this.#seat(x, z, 0.045), z, r0, r1, dur, type, color, strength, ease);
  }

  update(dt) {
    this.glow.update(dt);
    this.mark.update(dt);
  }
}
