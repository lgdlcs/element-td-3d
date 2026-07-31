import * as THREE from 'three';
import { makeSmokeSprite } from '../assets/ProceduralTextures.js';
import { DecalSystem, G_SHOCK, G_POOL, G_FROST, G_RUNE, G_VOID, M_SCORCH, M_CRATER, M_POISON, M_DUST, M_SHADOW } from './DecalSystem.js';
import { RibbonSystem } from './Ribbons.js';
import { resolveFamily, FAMILY_FX, FAMILY_MUZZLE } from './ElementLang.js';
import { FX_MAX_LUM, SMOKE_ALPHA, SMOKE_SCATTER } from './Levels.js';

/**
 * The VFX layer.
 *
 * Design rules, in priority order:
 *  1. **The effects are the lighting.** The board is deliberately dark; every
 *     emissive here is authored ABOVE the 1.05 scene-referred bloom threshold
 *     so it blooms, while every *matter* particle (smoke, dust, soot) is kept
 *     firmly below it so it reads as occluding mass, not glow.
 *  2. **White core, saturated surround.** Additive stacking is what turns
 *     combat into white soup (gate G7). We avoid it by making the hot centre of
 *     an effect small and white and the wide part saturated and dim, so ten
 *     overlapping effects still read as ten coloured shapes.
 *  3. **Everything is pooled and batched.** Whole layer is ~7 draw calls.
 *
 * Draw calls owned here:
 *   points(1) · decal-glow(1) · decal-mark(1) · lightning ribbon(1)
 * plus, from ProjectileManager: trail ribbon(1) · billboards(1) · rocks(1)
 */

// particle kinds
const K_GLOW = 0;
const K_SMOKE = 1;
const K_EMBER = 2;   // flickers, buoyant
const K_SHARD = 3;   // hard-edged, no bloom halo (rock chips, ice shards)
const K_STREAK = 4;  // stretched along its own screen-space velocity

export class EffectSystem {
  constructor(scene, camera, budget = 20000) {
    this.scene = scene;
    this.camera = camera;
    this.max = Math.max(2000, budget | 0);
    this.time = 0;

    this.px = new Float32Array(this.max);
    this.py = new Float32Array(this.max);
    this.pz = new Float32Array(this.max);
    this.vx = new Float32Array(this.max);
    this.vy = new Float32Array(this.max);
    this.vz = new Float32Array(this.max);
    this.life = new Float32Array(this.max);
    this.maxLife = new Float32Array(this.max);
    this.size = new Float32Array(this.max);
    this.sizeEnd = new Float32Array(this.max);
    this.drag = new Float32Array(this.max);
    this.grav = new Float32Array(this.max);
    this.spin = new Float32Array(this.max);
    this.stretch = new Float32Array(this.max);
    this.alphaMul = new Float32Array(this.max);
    this.kind = new Uint8Array(this.max);
    this.col = new Float32Array(this.max * 3);
    this.head = 0;
    this.liveCount = 0;

    this.#build();

    this.decals = new DecalSystem(scene, 192, 160);
    this.arcs = new RibbonSystem(scene, { slots: 128, nodes: 16, renderOrder: 11, softness: 1.9, gain: 2.1 });
    this.arcs2 = new ArcBank(16, 128);
    // Muzzle cones get their own ribbon pass: they want a softer, fatter
    // falloff than a lightning filament, and one extra draw call is cheap.
    // `softness` is the edge exponent — raised, and `gain` cut, because at 3.0
    // the whole cone sat above the 1.05 bloom threshold and a five-unit-long
    // above-threshold ribbon is exactly the "large area above threshold" the
    // post stack turns into a wash.
    this.muzzleRibbons = new RibbonSystem(scene, {
      slots: 192, nodes: 8, renderOrder: 10, softness: 2.4, gain: 1.95,
    });
    this.muzzles = new MuzzleBank(8, 192);
    // 4 flash + 2 sustained ember slots.
    //
    // SIX IN TOTAL, which is exactly what this layer allocated before the
    // sustained tier existed — the ember slots are carved out of the flash
    // budget, not added to it. That is deliberate: a point light costs zero
    // draw calls but adds a BRDF evaluation to every lit fragment in the frame,
    // and this scene already carries 16 of them. Measured on the midgame board,
    // stepping the fx pool 6 -> 9 was the single most expensive thing in this
    // round; the sustained tier is worth having, more lights are not.
    // If you raise these numbers, re-run tools/scratch/vfx-r6-lightcost.mjs.
    this.lights = new LightPool(scene, 4, 2);

    // Recent projectile spawns, so a muzzle flash can learn which way the
    // barrel was pointing without Towers.js having to tell us.
    this._hints = [];
    for (let i = 0; i < 24; i++) {
      this._hints.push({ t: -99, x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0, family: null });
    }
    this._hintCursor = 0;

    // status-effect emitters (attached by ProjectileManager)
    this.creeps = null;
    this.heightAt = null;   // see setHeightProvider()
    this._statusAcc = 0;
    this._auraAcc = 0;
    this._auraCursor = 0;
    this._litCandidates = [];   // flat [x, z, kind] triples, reused every tick

    // Simple global load meter — lets the busiest moments self-throttle so a
    // 30-tower barrage never turns the screen into soup.
    this.loadEma = 0;
    this._eventsThisFrame = 0;

    /**
     * Drop every NEW emission while true. Set around the local simulation only,
     * while the player is watching another board (Game.frame).
     *
     * `update()` is deliberately NOT gated by this: particles already in flight
     * have to finish their arc, and freezing them mid-air is a more obvious
     * artefact than letting a half-second of the previous board's smoke drift
     * out. The spectate view emits through this same system a few lines later in
     * the same frame, which is why the mute wraps the sim rather than the frame.
     */
    this.muted = false;
  }

  #build() {
    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.scene.add(this.group);

    // No glow sprite any more: the glow/ember profile is analytic in the
    // fragment shader (see #makePointCloud) so its falloff can be authored
    // exactly rather than baked into a texture at one fixed exponent.
    const smokeTex = makeSmokeSprite(128, 7);

    // Two passes, because the two halves of a good explosion blend differently:
    // energy ADDS light, matter OCCLUDES it. Doing both additively is what makes
    // smoke read as pale cotton wool instead of soot.
    this.energy = this.#makePointCloud(smokeTex, true);
    this.matter = this.#makePointCloud(smokeTex, false);
    this.group.add(this.energy.points);
    this.group.add(this.matter.points);
    this.mat = this.energy.mat;   // setViewport keeps working via #setViewportAll
  }

  #makePointCloud(smokeTex, additive) {
    const n = this.max;
    const geo = new THREE.BufferGeometry();
    const buf = {
      pos: new Float32Array(n * 3),
      col: new Float32Array(n * 3),
      size: new Float32Array(n),
      alpha: new Float32Array(n),
      kind: new Float32Array(n),
      rot: new Float32Array(n),
      stretch: new Float32Array(n),
    };
    const dyn = (a, k) => new THREE.BufferAttribute(a, k).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', dyn(buf.pos, 3));
    geo.setAttribute('pcolor', dyn(buf.col, 3));
    geo.setAttribute('psize', dyn(buf.size, 1));
    geo.setAttribute('palpha', dyn(buf.alpha, 1));
    geo.setAttribute('pkind', dyn(buf.kind, 1));
    geo.setAttribute('prot', dyn(buf.rot, 1));
    geo.setAttribute('pstretch', dyn(buf.stretch, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uSmoke: { value: smokeTex },
        uPixelRatio: { value: 1 },
        uViewHeight: { value: 1000 },
        uTime: { value: 0 },
        uMaxLum: { value: FX_MAX_LUM },
        uSmokeAlpha: { value: SMOKE_ALPHA },
        uSmokeScatter: { value: new THREE.Vector3().fromArray(SMOKE_SCATTER) },
      },
      vertexShader: /* glsl */`
        attribute vec3 pcolor;
        attribute float psize, palpha, pkind, prot, pstretch;
        varying vec3 vC;
        varying float vA, vK, vR, vS;
        uniform float uPixelRatio, uViewHeight;
        void main() {
          vC = pcolor; vA = palpha; vK = pkind; vR = prot; vS = pstretch;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Streaks need a quad long enough to hold the elongated shape; the
          // fragment shader compresses it back across the short axis.
          float grow = pkind > 3.5 ? max(1.0, pstretch) : 1.0;
          gl_PointSize = psize * grow * uPixelRatio * (uViewHeight * 0.5) / max(-mv.z, 0.001);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vC;
        varying float vA, vK, vR, vS;
        uniform sampler2D uSmoke;
        uniform float uTime, uMaxLum, uSmokeAlpha;
        uniform vec3 uSmokeScatter;

        // Hue-preserving emissive ceiling — see src/fx/Levels.js. The old
        // per-channel min(col, vec3(3.2)) desaturated on its way to white,
        // which spends exactly the thing ART_BIBLE law 4 says carries the read.
        vec3 capLum(vec3 c, float maxL) {
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          return l > maxL ? c * (maxL / l) : c;
        }

        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          int k = int(vK + 0.5);
          vec3 col = vC;
          float a;

          if (k == 4) {
            // STREAK — a spark smeared along its own screen-space velocity.
            // This is the single biggest difference between "particle dots"
            // and "sparks flying off something hot".
            float s0 = sin(vR), c0 = cos(vR);
            vec2 q = mat2(c0, -s0, s0, c0) * uv;   // q.x runs along the streak
            float st = max(vS, 1.0);
            float d = length(vec2(q.x, q.y * st)) * 2.0;
            if (d > 1.0) discard;
            // Bright at the leading end, tapering to nothing behind.
            float head = smoothstep(-1.0, 0.55, q.x * 2.0);
            float body = pow(1.0 - d, 1.25);
            float core = pow(1.0 - d, 6.0);
            // Peak alpha stays well under 1 so a spark reads as a hot smear of
            // light, not a solid clipped flake.
            a = (body * 0.26 + core * 0.42) * (0.20 + head * 0.85) * vA;
            if (a < 0.004) discard;
            // Only the very centre of a spark goes achromatic; a fully white
            // spark is indistinguishable between elements and stacks to soup.
            col = mix(col, vec3(max(max(col.r, col.g), col.b)), core * 0.35);
            gl_FragColor = vec4(capLum(col, uMaxLum), clamp(a, 0.0, 1.0));
            return;
          }

          float s = sin(vR), c = cos(vR);
          uv = mat2(c, -s, s, c) * uv + 0.5;
          if (k == 1) {
            // SMOKE — occluding matter, alpha-over, deliberately sub-threshold.
            a = texture2D(uSmoke, uv).a * vA;
            if (a < 0.004) discard;
            gl_FragColor = vec4(col, a);
            return;
          }
          if (k == 3) {
            // SHARD — hard-edged chip, no halo
            float d = length(uv - 0.5) * 2.0;
            a = smoothstep(1.0, 0.55, d) * vA;
            if (a < 0.004) discard;
            gl_FragColor = vec4(col, a);
            return;
          }
          // GLOW / EMBER.
          //
          // Analytic, NOT the pow(1-d, 2.4) sprite this used to sample. That
          // profile still carried ~0.19 alpha at half radius, so every particle
          // painted a wide translucent wash; a hundred of them composited into
          // the "diffuse haze" three blind critics named as the brightest thing
          // in frame. This is a small hot core plus a much faster-decaying
          // halo — the same peak, roughly a third of the covered area — so the
          // brightest element in frame is a *shape* with an edge.
          float d = clamp(length(gl_PointCoord - 0.5) * 2.0, 0.0, 1.0);
          float e = 1.0 - d;
          float e2 = e * e;
          float core = e2 * e2 * e;            // pow(e, 5)
          float halo = e2 * sqrt(max(e, 0.0)); // ~pow(e, 2.5)
          a = core + halo * 0.20;
          if (k == 2) a *= 0.55 + 0.45 * sin(uTime * 21.0 + vR * 9.0);
          a *= vA;
          if (a < 0.004) discard;
          // Hot white centre, saturated rim: keeps overlapping stacks readable.
          // Driven by the core term rather than by total alpha, so the white
          // heart stays small however bright the particle is authored.
          col = mix(col, mix(col, vec3(1.0), 0.75), smoothstep(0.35, 0.9, core));
          gl_FragColor = vec4(min(col, vec3(3.2)), min(a, 1.0));
        }
      `,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = additive ? 10 : 5;
    points.userData.__fx = true;
    return { geo, mat, points, buf, n: 0 };
  }

  setViewport(width, height, pixelRatio) {
    for (const c of [this.energy, this.matter]) {
      c.mat.uniforms.uViewHeight.value = height;
      c.mat.uniforms.uPixelRatio.value = pixelRatio;
    }
  }

  /** ProjectileManager hands us the creep arrays so we can drive status VFX. */
  attachCreeps(creeps) { this.creeps = creeps; }

  /**
   * Terrain height query (Game.js injects `arena.surfaceHeightAt`). Seats every
   * ground decal and every sustained pool light on the real surface instead of
   * a hardcoded Y. Optional — with no provider everything falls back to y=0,
   * which is what shipped before.
   */
  setHeightProvider(fn) {
    this.heightAt = typeof fn === 'function' ? fn : null;
    this.decals.heightAt = this.heightAt;
  }

  emit({ x, y, z, vx = 0, vy = 0, vz = 0, life = 1, size = 0.5, sizeEnd = 0,
         color = [1, 1, 1], drag = 1.5, grav = 0, kind = 0, spin = 0, stretch = 0,
         alphaScale = 1 }) {
    if (this.muted) return -1;
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.stretch[i] = stretch;
    this.alphaMul[i] = alphaScale;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.size[i] = size; this.sizeEnd[i] = sizeEnd;
    this.drag[i] = drag; this.grav[i] = grav;
    this.kind[i] = kind;
    this.spin[i] = spin;
    this.col[i * 3] = color[0]; this.col[i * 3 + 1] = color[1]; this.col[i * 3 + 2] = color[2];
    return i;
  }

  /** 0..1 congestion factor; effects thin themselves out when the board is busy. */
  get throttle() {
    return 1 / (1 + this.loadEma * 0.09);
  }

  // ---- authored effects ------------------------------------------------

  /**
   * Remember that a projectile just left a barrel. ProjectileManager calls
   * this from `spawn()`; `muzzleFlash()` then picks the hint up and knows which
   * way to point the cone and which dialect to speak. Entirely optional — with
   * no hint we fall back to a vertical cone and colour-derived family.
   */
  registerSpawnHint(x, y, z, dx, dy, dz, family) {
    if (this.muted) return;
    const l = Math.hypot(dx, dy, dz) || 1;
    const h = this._hints[this._hintCursor];
    this._hintCursor = (this._hintCursor + 1) % this._hints.length;
    h.t = this.time;
    h.x = x; h.y = y; h.z = z;
    h.dx = dx / l; h.dy = dy / l; h.dz = dz / l;
    h.family = family;
  }

  #findHint(x, y, z) {
    let best = null, bestD = 2.25;   // 1.5 units, squared
    for (const h of this._hints) {
      if (this.time - h.t > 0.12) continue;
      const d = (h.x - x) ** 2 + (h.y - y) ** 2 + (h.z - z) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }

  /**
   * MUZZLE FLASH — core + glow + tapered ribbon cone + point light + ground
   * spill, in a per-element dialect. There is deliberately no shared starburst
   * sprite anywhere in here.
   */
  muzzleFlash(x, y, z, colorHex, scale = 1) {
    if (this.muted) return;
    this._eventsThisFrame++;
    const ident = hexToLinear(colorHex);
    const hint = this.#findHint(x, y, z);
    const fam = hint?.family ?? resolveFamily(null, colorHex);
    const M = FAMILY_MUZZLE[fam] ?? FAMILY_MUZZLE.light;
    const F = FAMILY_FX[fam] ?? FAMILY_FX.light;
    const th = this.throttle;

    // Direction: the barrel if we know it, otherwise up-and-slightly-out.
    let dx = hint ? hint.dx : 0, dy = hint ? hint.dy : 1, dz = hint ? hint.dz : 0;
    if (!hint) {
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a) * 0.35; dz = Math.sin(a) * 0.35; dy = 0.9;
      const l = Math.hypot(dx, dy, dz);
      dx /= l; dy /= l; dz /= l;
    }

    // The tower's own colour leads; the family palette tints it. Steam and
    // Water then read as the same dialect in two different voices.
    const spark = mix3(hexToLinear(F.spark), ident, 0.75);
    const soot = hexToLinear(F.soot);

    // --- ribbon cone (the "trail") -----------------------------------
    this.muzzles.alloc(
      x, y, z, dx, dy, dz,
      M.coneLen * scale, M.coneW * scale, M.curl,
      [spark[0] * 1.05, spark[1] * 1.02, spark[2] * 0.98],
      M.coneLife, 1,
    );
    if (M.cross && th > 0.35) {
      // Light only: a perpendicular anamorphic bar through the muzzle.
      const px = -dz, pz = dx;
      const pl = Math.hypot(px, pz) || 1;
      const cl = M.cross * scale;
      for (const s of [1, -1]) {
        this.muzzles.alloc(
          x, y, z, (px / pl) * s, 0, (pz / pl) * s,
          cl, 0.11 * scale, 0, spark, M.coneLife * 0.8, 0.6,
        );
      }
    }

    // --- hot core (blooms) + saturated glow body (does not) ----------
    // Both sit at the barrel mouth. Offsetting them produced a two-blob
    // "hourglass"; concentric is what reads as one hot thing.
    // The core is the only part authored above the 1.05 bloom threshold, and
    // it dims under load so 30 simultaneous cores cannot stack to white.
    const coreK = M.coreGain * (0.55 + th * 0.45);
    this.emit({
      x, y, z,
      life: M.coreLife, size: M.coreSize * scale, sizeEnd: 0.02,
      color: [
        Math.min(3.2, 0.30 + spark[0] * coreK),
        Math.min(3.2, 0.28 + spark[1] * coreK),
        Math.min(3.2, 0.26 + spark[2] * coreK),
      ],
      drag: 10,
    });
    // The glow body is stretched along the barrel rather than a round blob,
    // so an end-on muzzle reads as a flash and a side-on one as a lick of
    // flame — never as a hanging bauble.
    this.emit({
      x, y, z,
      vx: dx * 7, vy: dy * 7, vz: dz * 7,
      life: M.glowLife, size: M.glowSize * 0.62 * scale, sizeEnd: M.glowSize * 0.22 * scale,
      color: [ident[0] * M.glowGain, ident[1] * M.glowGain, ident[2] * M.glowGain],
      drag: 13, kind: K_STREAK, stretch: 0.22,
    });

    // --- forward ejecta, streaked along its own velocity --------------
    const n = Math.max(2, Math.round(M.sparks * 0.65 * scale * th));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const spread = M.sparkSpread * Math.sqrt(Math.random());
      // Build a cone around (dx,dy,dz) without a full basis: jitter, then
      // renormalise. Good enough for sparks and much cheaper.
      let ex = dx + (Math.cos(a) * spread), ey = dy + (Math.random() - 0.4) * spread, ez = dz + (Math.sin(a) * spread);
      const el = Math.hypot(ex, ey, ez) || 1;
      ex /= el; ey /= el; ez /= el;
      const s = M.sparkSpeed * (0.5 + Math.random() * 0.9) * (0.7 + scale * 0.3);
      const sgn = M.suck ? -1 : 1;
      this.emit({
        x: x + ex * 0.2 * (M.suck ? 4 : 1),
        y: y + ey * 0.2 * (M.suck ? 4 : 1),
        z: z + ez * 0.2 * (M.suck ? 4 : 1),
        vx: ex * s * sgn, vy: ey * s * sgn, vz: ez * s * sgn,
        life: M.sparkLife * (0.65 + Math.random() * 0.7),
        size: 0.055 * scale, sizeEnd: 0.006,
        color: [spark[0] * 1.7, spark[1] * 1.5, spark[2] * 1.35],
        drag: 3.4, grav: M.sparkGrav,
        kind: K_STREAK, stretch: 0.85,
      });
    }

    // --- element garnish ---------------------------------------------
    if (M.embers) {
      const en = Math.max(1, Math.round(M.embers * th));
      for (let i = 0; i < en; i++) {
        this.emit({
          x: x + (Math.random() - 0.5) * 0.4, y, z: z + (Math.random() - 0.5) * 0.4,
          vx: dx * 1.2, vy: 1.4 + Math.random() * 1.8, vz: dz * 1.2,
          life: 0.7 + Math.random() * 0.7,
          size: M.spores ? 0.11 : 0.14, sizeEnd: 0.01,
          color: M.motes
            ? [spark[0] * 1.5, spark[1] * 1.5, spark[2] * 1.3]
            : [spark[0] * 1.7, spark[1] * 1.1, spark[2] * 0.55],
          drag: 1.1, grav: M.spores ? 0.5 : 1.3, kind: K_EMBER, spin: Math.random() * 6.28,
        });
      }
    }
    if (M.chips) {
      for (let i = 0; i < Math.max(1, Math.round(M.chips * th)); i++) {
        const a = Math.random() * Math.PI * 2;
        this.emit({
          x, y, z,
          vx: dx * 4 + Math.cos(a) * 3, vy: 2 + Math.random() * 4, vz: dz * 4 + Math.sin(a) * 3,
          life: 0.5 + Math.random() * 0.35,
          size: 0.14 + Math.random() * 0.09, sizeEnd: 0.05,
          color: [soot[0] * 2.6, soot[1] * 2.4, soot[2] * 2.2],
          drag: 0.4, grav: -26, kind: K_SHARD, spin: Math.random() * 6.28,
        });
      }
    }
    const sn = Math.max(1, Math.round(M.smoke * scale * th));
    for (let i = 0; i < sn; i++) {
      const a = Math.random() * Math.PI * 2;
      this.emit({
        x: x + dx * 0.4, y: y + 0.1, z: z + dz * 0.4,
        vx: dx * 1.6 + Math.cos(a) * 0.7,
        vy: M.smokeRise * (0.6 + Math.random() * 0.7),
        vz: dz * 1.6 + Math.sin(a) * 0.7,
        life: 0.45 + Math.random() * 0.45,
        size: 0.32 * scale, sizeEnd: 1.5 * scale,
        color: M.mist
          ? [soot[0] * 1.5, soot[1] * 1.6, soot[2] * 1.8]
          : [soot[0] * 0.7, soot[1] * 0.7, soot[2] * 0.75],
        drag: 1.6, grav: 0.25, kind: K_SMOKE,
        spin: (Math.random() - 0.5) * 2.6,
      });
    }

    // --- light + ground spill ----------------------------------------
    // The board is dark by design, so a muzzle really is a light source; the
    // decal is the cheap bounce term the point light cannot afford to be.
    // Both are now *tight*: a smaller distance with the same decay is a faster
    // falloff, and the intensity is raised to compensate at the near field, so
    // the muzzle reads as a punch on the tower it belongs to rather than a
    // glow smeared over its four neighbours.
    this.lights.flash(x, y, z, spark, 11.5 * M.light * scale, M.lightDist * 0.72 * scale, M.lightLife);
    this.decals.addGlow(
      x, z, M.spill * 0.30 * scale, M.spill * 0.62 * scale, 0.26, G_POOL,
      [ident[0] * 1.1, ident[1] * 1.1, ident[2] * 1.1],
      M.spillGain * 1.35 * (0.6 + th * 0.4), 2.4,
    );
  }

  /** Generic impact — kept for API compatibility; routes to the elemental one. */
  impact(x, y, z, c, family = null, scale = 1) {
    this.impactCore(x, y, z, c, family ?? familyFromLinear(c), scale, false);
  }

  /** Explicit element-flavoured impact. `elementId` may be a dual id. */
  impactElemental(x, y, z, elementId, scale = 1, colorLinear = null) {
    const fam = resolveFamily(elementId, null);
    const c = colorLinear ?? hexToLinear(FAMILY_FX[fam].decal);
    this.impactCore(x, y, z, c, fam, scale, false);
  }

  explosion(x, y, z, radius, c, family = null) {
    this.impactCore(x, y, z, c, family ?? familyFromLinear(c), Math.max(1, radius / 1.6), true, radius);
  }

  /**
   * The one impact routine. `heavy` = splash: bigger shockwave, real smoke
   * column, longer-lived ground decal, stronger light.
   */
  impactCore(x, y, z, c, family, scale, heavy, radius = 0) {
    // The one choke point for impact(), impactElemental() and explosion(): all
    // three route here, so muting it mutes them without three more guards.
    if (this.muted) return;
    this._eventsThisFrame++;
    const F = FAMILY_FX[family] ?? FAMILY_FX.light;
    const th = this.throttle;
    const R = heavy ? Math.max(1.2, radius) : 1.15 * scale;
    // The tower's own colour leads; the family palette only tints it. This is
    // what keeps Steam distinct from Water while both still "read as water".
    const ident = c && c.length === 3 ? c : hexToLinear(F.decal);
    const spark = mix3(hexToLinear(F.spark), ident, 0.5);
    const soot = hexToLinear(F.soot);
    const decalC = mix3(hexToLinear(F.decal), ident, 0.6);

    // --- flash -------------------------------------------------------
    this.emit({
      x, y, z, life: heavy ? 0.18 : 0.13,
      size: (heavy ? 2.6 : 1.5) * scale, sizeEnd: 0.1,
      color: [spark[0] * 2.6, spark[1] * 2.6, spark[2] * 2.6], drag: 12,
    });

    // --- radial spark burst -----------------------------------------
    const n = Math.max(4, Math.round(F.sparkCount * scale * (heavy ? 1.5 : 1) * th));
    const spd = F.sparkSpeed * (heavy ? 1.45 : 1) * (0.6 + scale * 0.4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      const s = spd * (0.45 + Math.random() * 0.9);
      const sn = Math.sin(p);
      this.emit({
        x, y, z,
        vx: sn * Math.cos(a) * s,
        vy: Math.abs(Math.cos(p)) * s * (F.implode ? -0.4 : 0.75) + (heavy ? 2.5 : 0.6),
        vz: sn * Math.sin(a) * s,
        life: F.sparkLife * (0.6 + Math.random() * 0.8),
        size: (heavy ? 0.22 : 0.17) * scale, sizeEnd: 0.01,
        color: [spark[0] * 2.2, spark[1] * 2.2, spark[2] * 2.2],
        drag: F.drag, grav: F.grav,
        kind: K_STREAK, stretch: 0.22,
      });
    }

    // --- element garnish ---------------------------------------------
    if (F.ember) {
      const en = Math.max(2, Math.round(7 * scale * th));
      for (let i = 0; i < en; i++) {
        const a = Math.random() * Math.PI * 2;
        this.emit({
          x: x + (Math.random() - 0.5) * R, y: y + 0.1, z: z + (Math.random() - 0.5) * R,
          vx: Math.cos(a) * 1.2, vy: 1.6 + Math.random() * 2.4, vz: Math.sin(a) * 1.2,
          life: 1.1 + Math.random() * 1.1,
          size: 0.16, sizeEnd: 0.02,
          color: [spark[0] * 1.5, spark[1] * 1.0, spark[2] * 0.5],
          drag: 0.8, grav: 1.4, kind: K_EMBER, spin: Math.random() * 6.28,
        });
      }
    }
    if (F.chunks) {
      const cn = Math.max(3, Math.round(9 * scale * th));
      for (let i = 0; i < cn; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 5 + Math.random() * 8;
        this.emit({
          x, y: y + 0.1, z,
          vx: Math.cos(a) * s, vy: 4 + Math.random() * 8, vz: Math.sin(a) * s,
          life: 0.7 + Math.random() * 0.5,
          size: 0.22 + Math.random() * 0.16, sizeEnd: 0.08,
          color: [soot[0] * 2.4, soot[1] * 2.2, soot[2] * 2.0],
          drag: 0.35, grav: -30, kind: K_SHARD, spin: Math.random() * 6.28,
        });
      }
    }
    if (F.motes) {
      const mn = Math.max(2, Math.round(6 * scale * th));
      for (let i = 0; i < mn; i++) {
        const a = Math.random() * Math.PI * 2;
        this.emit({
          x: x + (Math.random() - 0.5) * R * 1.4, y: y + Math.random() * 1.2, z: z + (Math.random() - 0.5) * R * 1.4,
          vx: Math.cos(a) * 0.5, vy: 0.7 + Math.random(), vz: Math.sin(a) * 0.5,
          life: 1.0 + Math.random() * 0.8,
          size: 0.13, sizeEnd: 0.01,
          color: [spark[0] * 1.6, spark[1] * 1.6, spark[2] * 1.4],
          drag: 1.4, grav: 0.3, kind: K_EMBER, spin: Math.random() * 6.28,
        });
      }
    }
    if (F.tendrils) {
      // Void: matter sucked INWARD, spawned on a shell moving back to centre.
      const tn = Math.max(3, Math.round(8 * scale * th));
      for (let i = 0; i < tn; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = R * (1.4 + Math.random() * 1.1);
        this.emit({
          x: x + Math.cos(a) * rr, y: y + (Math.random() - 0.3) * R, z: z + Math.sin(a) * rr,
          vx: -Math.cos(a) * rr * 3.4, vy: 0.5, vz: -Math.sin(a) * rr * 3.4,
          life: 0.38,
          size: 0.3, sizeEnd: 0.02,
          color: [spark[0] * 1.8, spark[1] * 1.4, spark[2] * 2.4],
          drag: 0.6, grav: 0,
        });
      }
    }

    // --- secondary smoke ---------------------------------------------
    const sn = Math.max(2, Math.round(F.smoke * (heavy ? 1.6 : 0.55) * scale * th));
    for (let i = 0; i < sn; i++) {
      const a = Math.random() * Math.PI * 2;
      this.emit({
        x: x + (Math.random() - 0.5) * R,
        y: y + Math.random() * 0.5,
        z: z + (Math.random() - 0.5) * R,
        vx: Math.cos(a) * (heavy ? 2.4 : 1.1),
        vy: F.smokeRise * (0.6 + Math.random() * 0.8),
        vz: Math.sin(a) * (heavy ? 2.4 : 1.1),
        life: (heavy ? 1.3 : 0.8) + Math.random() * 0.7,
        size: 0.7 * scale, sizeEnd: (heavy ? 3.4 : 1.9) * scale,
        // Sub-threshold on purpose: smoke must occlude, never bloom. Note the
        // *colour* matters as much as the blend mode — a pale colour under
        // NormalBlending still reads as cotton wool on a dark board.
        color: [soot[0] * 0.7, soot[1] * 0.7, soot[2] * 0.75],
        alphaScale: F.smokeAlpha ?? 1,
        drag: 1.0, grav: 0.3, kind: K_SMOKE,
        spin: (Math.random() - 0.5) * 2.4,
      });
    }

    // --- ground language ---------------------------------------------
    const D = this.decals;
    D.addGlow(x, z, R * 0.25, R * (heavy ? 2.1 : 1.8), heavy ? 0.5 : 0.40, G_SHOCK, decalC, heavy ? 1 : 0.9, 2.4);
    // The wide secondary wash used to run to R*3 at 0.24 strength — a big flat
    // translucent disc with no edge. Pulled in and dimmed; the ring above is
    // the shape, this is only its shadow.
    if (heavy) D.addGlow(x, z, R * 0.4, R * 2.15, 0.65, G_SHOCK, spark, 0.17, 3.0);

    // Persistent marks are the first thing to go when the board is saturated:
    // they are the least time-critical and the most pool-hungry.
    const wantMark = heavy || th > 0.55;
    // Every lingering pool below also parents a sustained point light through
    // `#poolLight`, so the thing on the floor is a light source and not a
    // sticker: towers, creeps and cobbles standing in it get tinted.
    switch (F.decalType) {
      case 'scorch': {
        if (wantMark) D.addMark(x, z, R * 1.1, R * 1.25, heavy ? 5 : 3.5, M_SCORCH, decalC, heavy ? 0.8 : 0.5);
        const life = F.glowDecalLife * (heavy ? 1.4 : 1);
        const gc = hexToLinear(F.glowDecal);
        D.addGlow(x, z, R * 0.75, R * 0.42, life, G_POOL, gc, heavy ? 0.55 : 0.32);
        this.#poolLight(x, z, gc, R * 1.6, life, heavy ? 17 : 8);
        break;
      }
      case 'frost': {
        const life = F.glowDecalLife * (heavy ? 1.5 : 1);
        const gc = hexToLinear(F.glowDecal);
        D.addGlow(x, z, R * 0.5, R * 1.15, life, G_FROST, gc, heavy ? 0.95 : 0.58, 2.0);
        this.#poolLight(x, z, gc, R * 1.8, life, heavy ? 12 : 6);
        break;
      }
      case 'poison':
        if (wantMark) D.addMark(x, z, R * 0.9, R * 1.35, heavy ? 6 : 3.5, M_POISON, decalC, heavy ? 0.9 : 0.5);
        this.#poolLight(x, z, decalC, R * 1.6, heavy ? 2.6 : 1.5, heavy ? 13 : 6.5);
        break;
      case 'crater':
        if (wantMark) D.addMark(x, z, R * 1.15, R * 1.35, heavy ? 9 : 5, M_CRATER, decalC, heavy ? 1 : 0.55);
        D.addMark(x, z, R * 0.6, R * 2.0, heavy ? 1.1 : 0.7, M_DUST, hexToLinear(0x6f6152), heavy ? 0.6 : 0.34, 2.4);
        break;
      case 'rune': {
        const life = heavy ? 0.9 : 0.55;
        D.addGlow(x, z, R * 1.5, R * 1.9, life, G_RUNE, decalC, heavy ? 0.9 : 0.6, 2.0);
        this.#poolLight(x, z, decalC, R * 2.0, life, heavy ? 18 : 9);
        break;
      }
      case 'void': {
        const life = heavy ? 0.7 : 0.45;
        D.addGlow(x, z, R * 2.0, R * 0.35, life, G_VOID, decalC, heavy ? 1 : 0.6, 1.0);
        if (wantMark) D.addMark(x, z, R * 1.0, R * 1.1, heavy ? 5 : 3, M_SCORCH, decalC, heavy ? 0.8 : 0.45);
        this.#poolLight(x, z, decalC, R * 1.7, life, heavy ? 15 : 7);
        break;
      }
      default:
        break;
    }

    // Tighter distance than before at a higher intensity: same punch at the
    // impact point, far less spill bleeding across the board.
    this.lights.flash(x, Math.max(y, 0.6), z, spark, heavy ? 34 : 13, heavy ? 8 : 4.6, heavy ? 0.34 : 0.17);
  }

  /**
   * Sustained fake bounce light for a lingering ground pool.
   *
   * Sits just above the floor so it grazes the cobbles and the lower third of
   * anything standing in it, which is where the reference frames put their
   * spill. `radius` is the light's cut-off distance, not the decal's — a light
   * that reaches much further than the pool it belongs to is a wash.
   */
  #poolLight(x, z, color, radius, dur, intensity) {
    if (dur < 0.25 || intensity <= 0) return;
    const y = (this.heightAt ? this.heightAt(x, z) : 0) + 0.55;
    this.lights.ember(x, Number.isFinite(y) ? y : 0.55, z, color, intensity, Math.max(2.0, radius), dur);
  }

  death(x, y, z, colorHex) {
    if (this.muted) return;
    this._eventsThisFrame++;
    const c = hexToLinear(colorHex);
    const th = this.throttle;
    const n = Math.max(6, Math.round(18 * th));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 3 + Math.random() * 6;
      this.emit({
        x, y: y + 0.6, z,
        vx: Math.cos(a) * s, vy: 2 + Math.random() * 5, vz: Math.sin(a) * s,
        life: 0.5 + Math.random() * 0.5,
        size: 0.28, sizeEnd: 0.01,
        color: [c[0] * 1.8, c[1] * 1.8, c[2] * 1.8],
        drag: 2.8, grav: -12,
      });
    }
    // A little rising soul-wisp, then a fading ash mark.
    for (let i = 0; i < Math.max(2, Math.round(5 * th)); i++) {
      this.emit({
        x: x + (Math.random() - 0.5) * 0.5, y: y + 0.4, z: z + (Math.random() - 0.5) * 0.5,
        vx: 0, vy: 2.4 + Math.random() * 1.6, vz: 0,
        life: 0.8 + Math.random() * 0.4,
        size: 0.22, sizeEnd: 0.01,
        color: [c[0] * 1.4, c[1] * 1.4, c[2] * 1.6],
        drag: 1.2, grav: 1.0, kind: K_EMBER, spin: Math.random() * 6.28,
      });
    }
    this.decals.addGlow(x, z, 0.2, 1.3, 0.35, G_SHOCK, c, 0.5, 2.4);
    this.decals.addMark(x, z, 0.7, 0.85, 5.0, M_SCORCH, c, 0.35);
  }

  /**
   * Chain lightning. A hot-white forked bolt: one main path plus short branches
   * that fork off it, all drawn in the shared arc ribbon (one draw call), plus a
   * light contribution at both ends.
   */
  lightning(x0, y0, z0, x1, y1, z1, c) {
    if (this.muted) return;
    this._eventsThisFrame++;
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz) || 1;
    const jitter = Math.min(1.6, len * 0.22);
    // A wide dim sheath under a narrow hot filament: this is what makes a bolt
    // read as *thick* without washing the frame out.
    this.arcs2.alloc(x0, y0, z0, x1, y1, z1, c, jitter * 1.5, 2.1, 0.45);
    const bolt = this.arcs2.alloc(x0, y0, z0, x1, y1, z1, c, jitter, 1.0, 1.0);
    if (bolt && this.throttle > 0.4) {
      // 2-3 forks leaving the main path, each with a stub of its own.
      const forks = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let f = 0; f < forks; f++) {
        const t = 0.25 + Math.random() * 0.5;
        const sx = x0 + dx * t, sy = y0 + dy * t, sz = z0 + dz * t;
        const a = Math.random() * Math.PI * 2;
        const r = len * (0.22 + Math.random() * 0.34);
        const ex = sx + Math.cos(a) * r;
        const ey = sy + (Math.random() - 0.15) * r * 0.8;
        const ez = sz + Math.sin(a) * r;
        this.arcs2.alloc(sx, sy, sz, ex, ey, ez, c, jitter * 0.7, 0.5, 0.75);
        if (Math.random() < 0.45) {
          const a2 = a + (Math.random() - 0.5) * 2.2;
          const r2 = r * 0.55;
          this.arcs2.alloc(ex, ey, ez,
            ex + Math.cos(a2) * r2, ey + (Math.random() - 0.3) * r2, ez + Math.sin(a2) * r2,
            c, jitter * 0.45, 0.3, 0.5);
        }
      }
      // Ground flash under both ends: the bolt lights the floor.
      this.decals.addGlow(x1, z1, 0.3, 2.4, 0.22, G_SHOCK, c, 0.7, 2.6);
      this.decals.addGlow(x0, z0, 1.4, 1.6, 0.16, G_POOL, c, 0.5);
    }
    // Sparks where it lands, and light at both ends.
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 4 + Math.random() * 5;
      this.emit({
        x: x1, y: y1, z: z1,
        vx: Math.cos(a) * s, vy: Math.random() * 4, vz: Math.sin(a) * s,
        life: 0.16 + Math.random() * 0.14,
        size: 0.2, sizeEnd: 0.01,
        color: [c[0] * 2.4 + 0.6, c[1] * 2.4 + 0.6, c[2] * 2.4 + 0.8],
        drag: 6, grav: -4,
      });
    }
    this.lights.flash(x1, y1, z1, c, 14, 6, 0.12);
  }

  /** Soft ground shadow under an arcing projectile. */
  groundShadow(x, z, r, dur = 0.08) {
    if (this.muted) return;
    this.decals.addMark(x, z, r, r, dur, M_SHADOW, BLACK, 1);
  }

  // ---- status-effect world VFX ----------------------------------------

  #updateStatus(dt) {
    const c = this.creeps;
    if (!c) return;
    this._statusAcc += dt;
    if (this._statusAcc < 0.06) return;
    const step = this._statusAcc;
    this._statusAcc = 0;
    const th = this.throttle;
    const n = c.alive.length;
    // Afflicted creeps are emitters too: a burning creep should throw light on
    // the ground it is standing on. Collected here, then handed one ember slot
    // at a time on a slow round-robin so a swarm cannot monopolise the pool.
    const lit = this._litCandidates;
    lit.length = 0;
    for (let i = 0; i < n; i++) {
      if (!c.alive[i]) continue;
      const x = c.x[i], y = c.y[i], z = c.z[i];

      if (c.burnT && c.burnT[i] > 0) lit.push(x, z, 0);
      else if (c.poisonT && c.poisonT[i] > 0) lit.push(x, z, 1);
      else if (c.slowT && c.slowT[i] > 0) lit.push(x, z, 2);

      if (c.burnT && c.burnT[i] > 0 && Math.random() < 0.85 * th) {
        // trailing embers + a wisp of dark smoke
        this.emit({
          x: x + (Math.random() - 0.5) * 0.5, y: y + 0.4 + Math.random() * 0.6, z: z + (Math.random() - 0.5) * 0.5,
          vx: (Math.random() - 0.5) * 0.6, vy: 1.6 + Math.random() * 1.6, vz: (Math.random() - 0.5) * 0.6,
          life: 0.5 + Math.random() * 0.4,
          size: 0.16, sizeEnd: 0.01,
          color: [2.6, 0.9, 0.22],
          drag: 1.4, grav: 1.2, kind: K_EMBER, spin: Math.random() * 6.28,
        });
        if (Math.random() < 0.25) {
          this.emit({
            x, y: y + 0.9, z,
            vx: 0, vy: 1.1, vz: 0, life: 0.7,
            size: 0.3, sizeEnd: 0.9,
            color: [0.09, 0.06, 0.05], drag: 1.2, grav: 0.4, kind: K_SMOKE,
            spin: (Math.random() - 0.5) * 2,
          });
        }
      }

      if (c.slowT && c.slowT[i] > 0 && Math.random() < 0.5 * th) {
        // frost mist clinging low around the body
        const a = Math.random() * Math.PI * 2;
        this.emit({
          x: x + Math.cos(a) * 0.45, y: y + 0.15 + Math.random() * 0.35, z: z + Math.sin(a) * 0.45,
          vx: Math.cos(a) * 0.25, vy: 0.25, vz: Math.sin(a) * 0.25,
          life: 0.75,
          size: 0.34, sizeEnd: 0.9,
          color: [0.30, 0.46, 0.62], drag: 1.6, grav: -0.15, kind: K_SMOKE,
          spin: (Math.random() - 0.5) * 1.5,
        });
        if (Math.random() < 0.22) {
          this.emit({
            x: x + (Math.random() - 0.5) * 0.6, y: y + 0.5 + Math.random() * 0.5, z: z + (Math.random() - 0.5) * 0.6,
            vx: 0, vy: -0.4, vz: 0, life: 0.5,
            size: 0.12, sizeEnd: 0.02,
            color: [1.5, 2.2, 2.8], drag: 2, grav: -2,
          });
        }
      }

      if (c.poisonT && c.poisonT[i] > 0 && Math.random() < 0.55 * th) {
        // Ichor beading on the body and dripping to the floor, with the
        // occasional heavy drop that leaves a small pool behind.
        const drip = Math.random() < 0.35;
        this.emit({
          x: x + (Math.random() - 0.5) * 0.55,
          y: y + (drip ? 0.15 : 0.55 + Math.random() * 0.5),
          z: z + (Math.random() - 0.5) * 0.55,
          vx: 0, vy: drip ? -0.4 : -1.6, vz: 0,
          life: drip ? 0.9 : 0.45,
          size: drip ? 0.16 : 0.10, sizeEnd: drip ? 0.02 : 0.01,
          color: [0.30, 1.35, 0.22],
          drag: drip ? 2.2 : 0.6, grav: drip ? -1.2 : -7,
          kind: drip ? K_EMBER : K_STREAK, stretch: 0.30,
          spin: Math.random() * 6.28,
        });
        if (Math.random() < 0.10) {
          this.decals.addMark(x, z, 0.16, 0.34, 2.2, M_POISON, [0.18, 0.55, 0.10], 0.55, 2.2);
        }
        if (Math.random() < 0.18) {
          this.emit({
            x, y: y + 0.7, z,
            vx: 0, vy: 0.7, vz: 0, life: 0.8,
            size: 0.26, sizeEnd: 0.8,
            color: [0.10, 0.20, 0.06], drag: 1.4, grav: 0.3, kind: K_SMOKE,
            alphaScale: 0.7, spin: (Math.random() - 0.5) * 1.8,
          });
        }
      }
    }

    // One sustained emitter per tick, rotating through the afflicted set. Short
    // distance, low intensity: this is a pool of light *under* a creep, not a
    // lamp. Two ticks of overlap keeps it from strobing.
    this._auraAcc += step;
    if (lit.length && this._auraAcc >= 0.22) {
      this._auraAcc = 0;
      const slots = lit.length / 3;
      const k = (this._auraCursor++ % slots) * 3;
      const kind = lit[k + 2];
      const col = kind === 0 ? STATUS_BURN : kind === 1 ? STATUS_POISON : STATUS_FROST;
      this.lights.ember(lit[k], 0.5, lit[k + 1], col, kind === 0 ? 9.0 : 6.0, 3.4, 0.5);
    }
  }

  // ---- frame -----------------------------------------------------------

  update(dt) {
    this.time += dt;
    this.energy.mat.uniforms.uTime.value = this.time;
    this.matter.mat.uniforms.uTime.value = this.time;

    // Cache the view/projection terms streak particles need this frame.
    const cam = this.camera;
    if (cam) {
      const e = cam.matrixWorldInverse.elements;
      for (let i = 0; i < 12; i++) V[i] = e[i];
      P00 = cam.projectionMatrix.elements[0] || 1;
      P11 = cam.projectionMatrix.elements[5] || 1;
    }

    // congestion EMA drives throttling of the *next* frame's effects
    this.loadEma += (this._eventsThisFrame / Math.max(dt, 1e-3) * 0.016 - this.loadEma) * Math.min(1, dt * 6);
    this._eventsThisFrame = 0;

    this.#updateStatus(dt);

    this.energy.n = 0;
    this.matter.n = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;

      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d;
      this.vy[i] = this.vy[i] * d + this.grav[i] * dt;

      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;

      if (this.py[i] < 0.04) { this.py[i] = 0.04; this.vy[i] *= -0.28; this.vx[i] *= 0.7; this.vz[i] *= 0.7; }

      const t = this.life[i] / this.maxLife[i];
      const k = this.kind[i];
      let fade;
      if (k === K_SMOKE) fade = Math.min(1, (1 - t) * 4.0) * t * 0.62;
      else if (k === K_SHARD) fade = Math.min(1, t * 3);
      else fade = t * t;
      fade *= this.alphaMul[i] || 1;

      const cloud = k === K_SMOKE ? this.matter : this.energy;
      const b = cloud.buf;
      const n = cloud.n++;
      let rot = this.spin[i] * (this.maxLife[i] - this.life[i]);
      let str = 0;
      if (k === K_STREAK) {
        // Project world velocity into screen space so the smear points where
        // the spark is actually going, from any camera angle.
        const vxw = this.vx[i], vyw = this.vy[i], vzw = this.vz[i];
        const sx = V[0] * vxw + V[4] * vyw + V[8] * vzw;
        const sy = V[1] * vxw + V[5] * vyw + V[9] * vzw;
        const speed = Math.hypot(vxw, vyw, vzw);
        rot = Math.atan2(sy * P11, sx * P00);
        str = Math.min(8, 1 + speed * this.stretch[i]);
      }
      b.stretch[n] = str;
      b.pos[n * 3] = this.px[i];
      b.pos[n * 3 + 1] = this.py[i];
      b.pos[n * 3 + 2] = this.pz[i];
      b.col[n * 3] = this.col[i * 3];
      b.col[n * 3 + 1] = this.col[i * 3 + 1];
      b.col[n * 3 + 2] = this.col[i * 3 + 2];
      b.size[n] = this.size[i] * t + this.sizeEnd[i] * (1 - t);
      b.alpha[n] = fade;
      b.kind[n] = k;
      b.rot[n] = rot;
    }
    this.liveCount = this.energy.n + this.matter.n;

    for (const cloud of [this.energy, this.matter]) {
      cloud.geo.setDrawRange(0, cloud.n);
      if (cloud.n > 0) {
        for (const a of ['position', 'pcolor', 'psize', 'palpha', 'pkind', 'prot', 'pstretch']) {
          const at = cloud.geo.attributes[a];
          if (at.clearUpdateRanges) { at.clearUpdateRanges(); at.addUpdateRange(0, cloud.n * at.itemSize); }
          at.needsUpdate = true;
        }
      }
    }

    this.decals.update(dt);
    this.arcs.begin();
    this.arcs2.update(dt, this.arcs);
    this.arcs.end();
    this.muzzleRibbons.begin();
    this.muzzles.update(dt, this.muzzleRibbons);
    this.muzzleRibbons.end();
    this.lights.update(dt);
  }
}

// ---------------------------------------------------------------------------

const BLACK = [0, 0, 0];

// Status-emitter hues, linear. Saturation carries the read (ART_BIBLE law 4),
// so these are chroma-forward and the intensity argument sets the level.
const STATUS_BURN = [1.0, 0.34, 0.07];
const STATUS_POISON = [0.30, 1.0, 0.16];
const STATUS_FROST = [0.30, 0.62, 1.0];

function mix3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function hexToLinear(hex) {
  TMPC.setHex(hex || 0x000000).convertSRGBToLinear();
  return [TMPC.r, TMPC.g, TMPC.b];
}
const TMPC = new THREE.Color();

/** Last-ditch family guess from a linear colour, for legacy call sites. */
function familyFromLinear(c) {
  const r = Math.min(1, c[0]), g = Math.min(1, c[1]), b = Math.min(1, c[2]);
  const hex = (Math.round(Math.sqrt(r) * 255) << 16) | (Math.round(Math.sqrt(g) * 255) << 8) | Math.round(Math.sqrt(b) * 255);
  return resolveFamily(null, hex);
}

/**
 * Pooled point lights, in two tiers sharing one fixed allocation.
 *
 *  FLASH slots — sub-second punches: muzzles, impacts, where a bolt lands.
 *  EMBER slots — *sustained* emitters bound to a lingering effect. This tier is
 *    the answer to "the pools are flat coloured decals that do not tint the
 *    towers standing in them": a ground pool now also parents a real (cheap,
 *    shadowless) point light for as long as the pool is on the floor, so the
 *    tower faces, the creeps and the cobbles inside it are genuinely tinted.
 *
 * Every light is created in the constructor and never added or removed.
 * Falloff is deliberately tight (`decay = 2` over a short `distance`): a wide
 * soft light *is* the haze the critics failed us on.
 *
 * INTENSITY 0 IS NOT FREE — MEASURED AT 24.9 ms
 *
 * This pool used to leave all six lights permanently `visible`, on the stated
 * rationale that a constant `NUM_POINT_LIGHTS` means no material recompiles
 * mid-game. That rationale is sound and the cost of it was never measured.
 *
 * three.js decides whether a light exists **by `light.visible`, and never looks
 * at `intensity`**. Six invisible-in-effect lights at intensity 0 therefore
 * compiled six full point-light iterations — `getPointLightInfo` plus
 * `BRDF_GGX` — into every lit material in the game, and paid them on every lit
 * pixel of every frame, forever, to add exactly nothing to the image.
 *
 * Ablated: hiding these six lights saves **24.9 ms of an 82.1 ms frame** at
 * `high`, 1600x900. That is larger than the entire MSAA mechanism and it is the
 * single biggest item ever found in this renderer.
 *
 * It also hid for eight rounds behind a measurement artefact. Every previous fx
 * ablation used `fx.group.visible = false`, and these lights are `scene.add`ed
 * directly rather than parented to that group, so the recorded finding "fx costs
 * ~0" was true of fx GEOMETRY only and was quietly read as "fx is free".
 *
 * So slots now arm and disarm. The recompile the original design avoided is
 * real, but it is bounded: three.js caches one program variant per light count,
 * so each variant compiles once and is a cache hit thereafter. A median win of
 * this size is worth a handful of first-use compiles — but it is a p95 risk, and
 * p95 is half the budget target, so it must be measured and not assumed
 * (docs/PERF_BUDGET.md).
 */
class LightPool {
  constructor(scene, flashCount = 5, emberCount = 4) {
    this.items = [];
    this.embers = [];
    for (let i = 0; i < flashCount; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;
      l.visible = false;   // see #arm: intensity 0 is NOT free
      scene.add(l);
      this.items.push({ light: l, t: 0, dur: 1, peak: 0 });
    }
    for (let i = 0; i < emberCount; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 5, 2);
      l.castShadow = false;
      l.visible = false;
      scene.add(l);
      this.embers.push({ light: l, t: 0, dur: 1, peak: 0, hold: 0.5 });
    }
    this.cursor = 0;
  }
  get count() { return this.items.length + this.embers.length; }

  flash(x, y, z, c, intensity, distance, dur) {
    // Steal the dimmest slot so a big explosion always wins over a muzzle pop.
    let best = null, bestVal = Infinity;
    for (const it of this.items) {
      const cur = it.peak * Math.max(0, 1 - it.t / it.dur);
      if (cur < bestVal) { bestVal = cur; best = it; }
    }
    if (!best || bestVal > intensity) return;
    best.light.position.set(x, y + 0.4, z);
    best.light.color.setRGB(Math.min(1, c[0] + 0.15), Math.min(1, c[1] + 0.15), Math.min(1, c[2] + 0.15));
    best.light.distance = distance;
    best.light.visible = true;
    best.peak = intensity;
    best.dur = dur;
    best.t = 0;
  }

  /**
   * Sustained emitter. `dur` should match the life of the thing on the ground
   * that is supposed to be glowing, so the light and the decal die together.
   * Saturation, not brightness, carries the read (ART_BIBLE law 4), so the
   * colour is pushed toward full chroma rather than toward white.
   */
  ember(x, y, z, c, intensity, distance, dur) {
    let best = null, bestVal = Infinity;
    for (const it of this.embers) {
      const cur = it.peak * Math.max(0, 1 - it.t / it.dur);
      if (cur < bestVal) { bestVal = cur; best = it; }
    }
    if (!best || bestVal > intensity) return;
    const m = Math.max(c[0], c[1], c[2]) || 1;
    best.light.position.set(x, y, z);
    // Normalised hue at full chroma: the *intensity* argument sets the level.
    best.light.color.setRGB(
      Math.min(1, 0.06 + c[0] / m),
      Math.min(1, 0.06 + c[1] / m),
      Math.min(1, 0.06 + c[2] / m),
    );
    best.light.distance = distance;
    best.light.visible = true;
    best.peak = intensity;
    best.dur = dur;
    best.hold = 0.45;
    best.t = 0;
  }

  update(dt) {
    for (const it of this.items) {
      // `visible = false`, not just `intensity = 0`. See the class docblock:
      // three.js charges a light to every lit pixel based on `visible` alone, so
      // a spent slot left visible costs a full GGX iteration scene-wide to
      // contribute nothing.
      if (it.t >= it.dur) { it.light.intensity = 0; it.light.visible = false; continue; }
      it.t += dt;
      const k = Math.max(0, 1 - it.t / it.dur);
      it.light.intensity = it.peak * k * k;
    }
    for (const it of this.embers) {
      if (it.t >= it.dur) { it.light.intensity = 0; it.light.visible = false; continue; }
      it.t += dt;
      const p = it.t / it.dur;
      // Fast attack, plateau while the pool is fresh, then a smooth decay that
      // lands on zero exactly when the decal does.
      const attack = Math.min(1, p / 0.08);
      const decay = p < it.hold ? 1 : 1 - (p - it.hold) / (1 - it.hold);
      it.light.intensity = it.peak * attack * decay * decay;
    }
  }
}

/**
 * Bolt bookkeeping on top of the shared arc RibbonSystem. Bolts hold their own
 * jittered polyline, re-jitter every few frames (flicker) and expire fast.
 */
class ArcBank {
  constructor(nodes, cap) {
    this.nodes = nodes;
    this.cap = cap;
    this.pts = new Float32Array(cap * nodes * 3);
    this.items = [];
    for (let i = 0; i < cap; i++) {
      this.items.push({ idx: i, live: false, bright: 1, t: 0, dur: 0.22, w: 0.16, r: 1, g: 1, b: 1, jit: 1, reJit: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0 });
    }
    this.cursor = 0;
  }
  alloc(x0, y0, z0, x1, y1, z1, c, jitter, widthScale = 1, brightness = 1) {
    let it = null;
    for (let n = 0; n < this.cap; n++) {
      const cand = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % this.cap;
      if (!cand.live) { it = cand; break; }
    }
    if (!it) return null;
    it.live = true; it.t = 0; it.dur = 0.20 + Math.random() * 0.10;
    it.w = 0.16 * widthScale;
    it.bright = brightness;
    it.r = c[0]; it.g = c[1]; it.b = c[2];
    it.jit = jitter;
    it.ax = x0; it.ay = y0; it.az = z0;
    it.bx = x1; it.by = y1; it.bz = z1;
    it.reJit = 0;
    this.#jitter(it);
    return it;
  }
  #jitter(it) {
    const base = it.idx * this.nodes * 3;
    const N = this.nodes;
    for (let s = 0; s < N; s++) {
      const t = s / (N - 1);
      const j = t * (1 - t) * 4 * it.jit;
      this.pts[base + s * 3] = it.ax + (it.bx - it.ax) * t + (Math.random() - 0.5) * j;
      this.pts[base + s * 3 + 1] = it.ay + (it.by - it.ay) * t + (Math.random() - 0.5) * j * 0.6;
      this.pts[base + s * 3 + 2] = it.az + (it.bz - it.az) * t + (Math.random() - 0.5) * j;
    }
  }
  update(dt, ribbons) {
    for (const it of this.items) {
      if (!it.live) continue;
      it.t += dt;
      if (it.t >= it.dur) { it.live = false; continue; }
      it.reJit -= dt;
      if (it.reJit <= 0) { this.#jitter(it); it.reJit = 0.035; }
      const k = 1 - it.t / it.dur;
      const flick = 0.55 + 0.45 * Math.sin(it.t * 90);
      ribbons.push(this.pts, it.idx * this.nodes * 3, this.nodes,
        [it.r + 0.30, it.g + 0.30, it.b + 0.40],
        it.w * (0.6 + k * 0.6), k * flick * 1.4 * it.bright);
    }
  }
}

/**
 * Muzzle cones.
 *
 * Each slot holds a short straight-ish spine that starts at the barrel and
 * runs along the firing direction. Over its (very short) life the spine
 * lengthens, the width collapses and the whole thing fades — which is what a
 * real muzzle flash does and what a static starburst sprite cannot do.
 *
 * `curl` bends the spine sideways over time so fire billows and void curls
 * back on itself, while light stays dead straight.
 */
class MuzzleBank {
  constructor(nodes, cap) {
    this.nodes = nodes;
    this.cap = cap;
    this.pts = new Float32Array(cap * nodes * 3);
    this.items = [];
    for (let i = 0; i < cap; i++) {
      this.items.push({
        idx: i, live: false, t: 0, dur: 0.14,
        x: 0, y: 0, z: 0, dx: 0, dy: 1, dz: 0,
        ux: 1, uy: 0, uz: 0,
        len: 1, grow: 1.4, w: 0.5, curl: 0, r: 1, g: 1, b: 1, gain: 1,
      });
    }
    this.cursor = 0;
  }

  alloc(x, y, z, dx, dy, dz, len, w, curl, color, dur, gain = 1) {
    let it = null;
    for (let n = 0; n < this.cap; n++) {
      const cand = this.items[this.cursor];
      this.cursor = (this.cursor + 1) % this.cap;
      if (!cand.live) { it = cand; break; }
    }
    if (!it) return null;
    it.live = true; it.t = 0; it.dur = dur;
    it.x = x; it.y = y; it.z = z;
    it.dx = dx; it.dy = dy; it.dz = dz;
    // Any vector perpendicular to the barrel, used as the curl axis.
    let ux = -dz, uy = 0, uz = dx;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-4) { ux = 1; uy = 0; uz = 0; ul = 1; }
    it.ux = ux / ul; it.uy = uy / ul; it.uz = uz / ul;
    it.len = len; it.w = w; it.curl = curl;
    it.gain = gain;
    it.r = color[0]; it.g = color[1]; it.b = color[2];
    return it;
  }

  update(dt, ribbons) {
    const N = this.nodes;
    for (const it of this.items) {
      if (!it.live) continue;
      it.t += dt;
      if (it.t >= it.dur) { it.live = false; continue; }
      const p = it.t / it.dur;
      const k = 1 - p;
      const L = it.len * (0.45 + p * 0.75);
      const base = it.idx * N * 3;
      for (let s = 0; s < N; s++) {
        const u = s / (N - 1);
        const c = it.curl * u * u * L * 0.30 * Math.sin(p * 3.0 + it.idx);
        this.pts[base + s * 3] = it.x + it.dx * L * u + it.ux * c;
        this.pts[base + s * 3 + 1] = it.y + it.dy * L * u + it.uy * c;
        this.pts[base + s * 3 + 2] = it.z + it.dz * L * u + it.uz * c;
      }
      // Width blooms then snaps shut; brightness decays on a sharper curve so
      // the flash punches instead of lingering.
      const wob = Math.sin(p * Math.PI);
      // Deliberately translucent: a muzzle cone that saturates to alpha 1
      // reads as a flat cardboard triangle the moment the camera gets close.
      ribbons.push(this.pts, base, N, TMP3(it.r, it.g, it.b),
        it.w * (0.55 + wob * 0.75), k * k * it.gain * 0.72);
    }
  }
}

const _t3 = [0, 0, 0];
function TMP3(r, g, b) { _t3[0] = r; _t3[1] = g; _t3[2] = b; return _t3; }

// Scratch camera terms for screen-space streak orientation.
const V = new Float64Array(12);
let P00 = 1, P11 = 1;

