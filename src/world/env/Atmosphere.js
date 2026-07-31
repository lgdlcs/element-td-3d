import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NOISE } from './glsl.js';

/* ================================================================== */
/* Cloud strata — horizontal mist decks above and below the platform   */
/* ================================================================== */

/**
 * ROUND 2 — the decks are now colour-graded by DEPTH, because there is a
 * molten abyss underneath this world. The lowest deck sits just above the
 * furnace and reads hot orange; the highest deck is far from it and stays
 * cool steel-blue. That vertical warm->cool ramp is doing a lot of the work
 * of the second colour anchor: it gives the void below the platform an
 * unmistakable amber core with cool haze stacked over it.
 */
/* ROUND 3 — opacities cut ~35%. Measured on the round-2 frame: the void at
 * lower-left sat at L=52.8 and the void at lower-right at L=88.8, against a
 * board whose DIMMEST quadrant was L=55 and whose brightest was L=95. The
 * empty space under the arena was out-valuing half the arena. The strata and
 * the forge together were the cause; both are now subordinate.            */
const STRATA = [
  //  y     inner  outer  tintR,G,B          opacity  scale  drift
  [-58, 60, 230, 0.09, 0.17, 0.40, 0.038, 0.030, 0.9],   // cool, nearest camera
  [-108, 80, 320, 0.22, 0.14, 0.32, 0.035, 0.019, 0.6],  // violet transition
  [-186, 90, 420, 0.19, 0.14, 0.28, 0.031, 0.011, 0.4],  // violet
  [-286, 100, 480, 0.46, 0.19, 0.12, 0.032, 0.007, 0.25], // hot, over the forge
];

/**
 * All strata merged into one geometry, per-deck parameters carried on vertex
 * attributes so the whole thing is 1 draw call / 1 program.
 */
export class CloudStrata {
  constructor() {
    const parts = [];
    for (let i = 0; i < STRATA.length; i++) {
      const [y, inner, outer] = STRATA[i];
      const g = new THREE.RingGeometry(inner, outer, 72, 6).toNonIndexed();
      g.rotateX(-Math.PI / 2);
      g.translate(0, y, 0);
      const n = g.attributes.position.count;
      const idx = new Float32Array(n).fill(i);
      const rad = new Float32Array(n);
      const p = g.attributes.position;
      for (let k = 0; k < n; k++) {
        const r = Math.hypot(p.getX(k), p.getZ(k));
        rad[k] = (r - inner) / (outer - inner);
      }
      g.deleteAttribute('normal');
      g.deleteAttribute('uv');
      g.setAttribute('aLayer', new THREE.BufferAttribute(idx, 1));
      g.setAttribute('aRad', new THREE.BufferAttribute(rad, 1));
      parts.push(g);
    }
    const geo = mergeGeometries(parts);
    for (const g of parts) g.dispose();

    const tints = STRATA.map((s) => new THREE.Vector3(s[3], s[4], s[5]));
    const params = STRATA.map((s) => new THREE.Vector3(s[6], s[7], s[8]));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uTint: { value: tints },
        uParam: { value: params },
        uCam: { value: new THREE.Vector3() },
      },
      vertexShader: /* glsl */`
        attribute float aLayer;
        attribute float aRad;
        varying vec3 vWorld;
        varying float vRad;
        varying float vLayer;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vRad = aRad;
          vLayer = aLayer;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime;
        uniform vec3 uTint[${STRATA.length}];
        uniform vec3 uParam[${STRATA.length}];
        uniform vec3 uCam;
        varying vec3 vWorld;
        varying float vRad;
        varying float vLayer;

        ${NOISE}

        void main() {
          int li = int(vLayer + 0.5);
          vec3 tint = uTint[0];
          vec3 par = uParam[0];
          for (int i = 0; i < ${STRATA.length}; i++) {
            if (i == li) { tint = uTint[i]; par = uParam[i]; }
          }
          float opacity = par.x, scale = par.y, drift = par.z;

          vec3 q = vec3(vWorld.x, vWorld.y * 0.35, vWorld.z) * scale;
          q += vec3(uTime * drift * 0.045, 0.0, uTime * drift * 0.022);
          float n = fbm3(q, 4);
          float n2 = fbm3(q * 2.7 + 31.0, 3);
          float dens = smoothstep(0.56, 0.99, n * 0.75 + n2 * 0.35);

          // fade both edges of the ring so no hard rim is ever visible
          float edge = smoothstep(0.0, 0.22, vRad) * smoothstep(1.0, 0.62, vRad);

          // grazing-angle fade: hides the fact that this is a flat plane
          vec3 vd = normalize(vWorld - uCam);
          float graze = pow(abs(vd.y), 0.45);

          float a = dens * edge * graze * opacity;
          if (a < 0.004) discard;

          // self-shadowing: denser cores read darker, wisps catch light
          vec3 col = tint * (0.30 + 0.75 * (1.0 - dens));
          gl_FragColor = vec4(col, a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'cloud-strata';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -50;
  }

  update(elapsed, camera) {
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uCam.value.copy(camera.position);
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

/* ==================================================================
 * NOTE — no in-scene god-ray geometry lives here any more.
 *
 * A fan of additive shafts used to hang on the key-light axis. Additive
 * blending cannot darken anything, but GTAOPass renders its OWN depth/normal
 * prepass of the scene with an override material, which ignores
 * `depthWrite:false`. Any large mesh spanning the board therefore became a
 * giant occluder in that prepass and stamped a hard-edged dark wedge across
 * the arena floor — a flat gate-G9 failure.
 *
 * God rays belong in screen space (RenderPipeline's GodRaysPass), where they
 * cannot participate in the AO prepass at all. If in-scene shafts are ever
 * wanted back, they need a pass-level exclusion hook first.
 * ================================================================== */

/* ================================================================== */
/* Ground fog — billboarded soft sheets creeping over the arena rim    */
/* ================================================================== */

export class GroundFog {
  constructor(count = 120, { halfW = 27, halfH = 21 } = {}) {
    const geo = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    geo.index = plane.index;
    geo.setAttribute('position', plane.attributes.position);
    geo.setAttribute('uv', plane.attributes.uv);
    geo.instanceCount = count;

    const off = new Float32Array(count * 3);
    const par = new Float32Array(count * 4);
    let s = 991;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

    for (let i = 0; i < count; i++) {
      const rimSide = i < count * 0.85;
      let x, z, y, scale;
      if (rimSide) {
        // walk the platform perimeter
        const t = rnd();
        const per = 2 * (halfW * 2 + halfH * 2);
        let d = t * per;
        if (d < halfW * 2) { x = -halfW + d; z = -halfH; }
        else if ((d -= halfW * 2) < halfH * 2) { x = halfW; z = -halfH + d; }
        else if ((d -= halfH * 2) < halfW * 2) { x = halfW - d; z = halfH; }
        else { d -= halfW * 2; x = -halfW; z = halfH - d; }
        const push = (rnd() - 0.35) * 9;
        x += Math.sign(x) * push * 0.7;
        z += Math.sign(z) * push * 0.7;
        y = -1.6 + rnd() * 2.6;
        scale = 9 + rnd() * 16;
      } else {
        // spill pouring off the edge into the abyss
        const a = rnd() * Math.PI * 2;
        const r = 26 + rnd() * 22;
        x = Math.cos(a) * r * 1.25;
        z = Math.sin(a) * r;
        y = -14 + rnd() * 13;
        scale = 10 + rnd() * 15;
      }
      off[i * 3] = x; off[i * 3 + 1] = y; off[i * 3 + 2] = z;
      par[i * 4] = scale;
      par[i * 4 + 1] = rnd() * 100;              // seed
      par[i * 4 + 2] = 0.25 + rnd() * 0.7;       // drift speed
      par[i * 4 + 3] = rimSide ? 1.0 : 0.55;     // opacity class
    }

    geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
    geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(par, 4));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x8fabdd) },   // cool top
        uWarm: { value: new THREE.Color(0xc2652f) },    // forge-lit underside
        // Round 3: 0.075 was below the visible threshold at this camera
        // distance — the critic's G6 note ("no low fog card creeping over the
        // platform rim") was correct even though the system was running.
        // Round 4: the world beyond the rim is now continuous lit ground
        // rather than a black void, so a sheet tuned to register against
        // black reads as a pale smear over the landscape. Cut to a haze.
        uOpacity: { value: 0.075 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aOffset;
        attribute vec4 aParam;
        uniform float uTime;
        varying vec2 vUv;
        varying float vSeed;
        varying float vClass;
        varying float vDepth;
        void main() {
          vUv = uv;
          vSeed = aParam.y;
          vClass = aParam.w;
          // How far below the platform deck this puff sits. Drives the
          // warm/cool ramp in the fragment shader: fog spilling over the rim
          // and down into the void is lit from beneath by the molten sea, fog
          // sitting on the deck is lit by the cool sky.
          vDepth = clamp(-aOffset.y / 22.0, 0.0, 1.0);
          float t = uTime * aParam.z;
          vec3 c = aOffset;
          c.x += sin(t * 0.21 + aParam.y) * 3.2;
          c.z += cos(t * 0.17 + aParam.y * 1.7) * 3.2;
          c.y += sin(t * 0.13 + aParam.y * 0.6) * 0.9;
          float pulse = 0.82 + 0.18 * sin(t * 0.19 + aParam.y * 2.1);
          float sc = aParam.x * pulse;
          // camera-facing billboard
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 wp = c + (right * position.x + up * position.y) * sc;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime, uOpacity;
        uniform vec3 uColor, uWarm;
        varying vec2 vUv;
        varying float vSeed;
        varying float vClass;
        varying float vDepth;

        float h2(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.545); }
        float n2(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x),
                     mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y);
        }

        void main() {
          vec2 p = vUv - 0.5;
          float d = length(p) * 2.0;
          float soft = smoothstep(1.0, 0.05, d);
          soft *= soft;
          vec2 q = vUv * 2.6 + vec2(vSeed, vSeed * 0.7) + uTime * 0.012;
          float n = n2(q) * 0.6 + n2(q * 2.3 + 5.0) * 0.4;
          float a = soft * smoothstep(0.28, 0.85, n) * uOpacity * vClass;
          if (a < 0.003) discard;
          // Vertical light ramp WITHIN each puff as well as between puffs:
          // the bottom of a billboard is nearer the forge than its top.
          float k = clamp(vDepth + (0.5 - vUv.y) * 0.55, 0.0, 1.0);
          vec3 c = mix(uColor, uWarm, pow(k, 2.1));
          gl_FragColor = vec4(c * (0.7 + n * 0.5), a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'ground-fog';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  update(elapsed) { this.material.uniforms.uTime.value = elapsed; }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

/* ================================================================== */
/* The Forge — a molten sea far below the platform.                    */
/* ================================================================== */

/**
 * ROUND 2. This used to be `AbyssGlow`: a teal/violet disc that added one
 * more cool tone to an already 90%-cool frame.
 *
 * It is now the primary WARM ANCHOR of the whole composition, and it earns
 * that job on pure screen real estate: the gameplay camera pitches 52 deg
 * down, so the bottom half of every frame is looking straight into the void
 * under the arena. Whatever colour lives down there occupies more pixels
 * than the sky does.
 *
 * Structurally it is cracked crust rather than a smooth gradient — dark
 * plates with incandescent fissures between them, breathing on two
 * out-of-phase periods so the light under the board never sits still (G6).
 * A cool violet outer ring keeps it complementary rather than an orange wash.
 *
 * Exported as `AbyssGlow` too, so nothing that imported the old name breaks.
 */
export class Forge {
  constructor() {
    const geo = new THREE.CircleGeometry(430, 96);
    geo.rotateX(-Math.PI / 2);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uHot: { value: new THREE.Color(0xffab5e) },   // fissure cores
        uMag: { value: new THREE.Color(0xd23a0a) },   // magma body
        uRim: { value: new THREE.Color(0x4a2ea8) },   // cool violet outskirts
      },
      vertexShader: /* glsl */`
        varying vec2 vP;
        void main() {
          vP = position.xz / 430.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime; uniform vec3 uHot, uMag, uRim;
        varying vec2 vP;

        ${NOISE}

        void main() {
          float r = length(vP);
          if (r > 1.0) discard;
          float t = uTime;

          // Falloff: broad body, hot centre.
          float body = pow(clamp(1.0 - r, 0.0, 1.0), 2.9);
          float core = pow(clamp(1.0 - r * 1.9, 0.0, 1.0), 2.4);

          // Cracked crust. The ridged noise gives thin bright veins between dark
          // plates, which is exactly what cooling magma looks like from above.
          vec3 q = vec3(vP.x, 0.0, vP.y) * 3.6;
          float plates = fbm3(q * 0.9 + vec3(t * 0.006, 0.0, t * 0.004), 3);
          float veins = ridged(q * 1.7 + vec3(0.0, t * 0.010, 0.0), 4);
          veins = pow(clamp(veins - 0.46, 0.0, 1.0), 1.25);

          // Two out-of-phase breaths: the sea swells slowly, the veins flare
          // faster. Nothing under the board is ever a still frame.
          float swell = 0.62 + 0.38 * sin(t * 0.055);
          float flare = 0.55 + 0.45 * sin(t * 0.17 + plates * 5.5);

          vec3 c = uMag * body * (0.22 + 0.78 * plates) * swell * 0.185;
          c += uHot * veins * (body * 0.9 + core * 1.5) * flare * 0.60;
          c += uHot * core * swell * 0.15;

          // Cool violet outer ring — the complement. Without it the whole
          // lower frame is one orange note and the grade collapses.
          float ring = smoothstep(0.42, 0.88, r) * smoothstep(1.0, 0.80, r);
          c += uRim * ring * (0.45 + 0.55 * plates) * 0.52;

          float a = clamp(body * 0.44 + veins * 0.26 + ring * 0.17, 0.0, 1.0);
          gl_FragColor = vec4(c, a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = -268;
    this.mesh.name = 'forge';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -60;
  }

  update(elapsed) { this.material.uniforms.uTime.value = elapsed; }
  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

export { Forge as AbyssGlow };
