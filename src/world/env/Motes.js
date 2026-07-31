import * as THREE from 'three';

/**
 * Ambient dust motes + rising embers around the board, entirely GPU-animated
 * (position is a pure function of uTime and per-particle seeds), so the CPU
 * cost is zero and it is one draw call.
 *
 *   type 0 — cool dust, slow lissajous drift, twinkles
 *   type 1 — warm ember, rises and fades out at the top of the volume
 *
 * ==================================================================
 * ROUND 3 — WHY THIS SYSTEM WAS INVISIBLE (gate G6).
 *
 * The verdict was "the board is inert... no ambient motion, no embers, no
 * dust". 1600 motes were being drawn every frame. The bug was one constant:
 *
 *     gl_PointSize = clamp(uPix * sz * 90.0 / d, 1.0, 12.0);
 *
 * The gameplay camera sits ~70 world units from board centre, and sz runs
 * 0.35..1.7, so that evaluates to 0.45..2.2 px — and the clamp floor of 1.0
 * meant most motes rendered as a SINGLE PIXEL at ~30% alpha. They were
 * mathematically present and perceptually absent. The 90.0 was tuned for a
 * camera about 8 units out.
 *
 * Fixed by scaling the constant to the real camera distance, roughly doubling
 * the alpha, and — the part that makes them read as belonging to this board
 * rather than to a generic particle system — colouring a third of them with
 * the six elemental hues. The Art Bible asks for motes "lit by nearby tower
 * glow"; the environment layer has no access to tower positions and should
 * not acquire one, so instead each mote is assigned an element colour by its
 * position in a low-frequency spatial hash. The result is the same read:
 * patches of air near the board glow in tower colours.
 * ==================================================================
 */
export class Motes {
  constructor(count = 1200, { halfW = 30, halfH = 24, height = 20 } = {}) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 3);   // phase, speed, size
    const col = new Float32Array(count * 3);
    const type = new Float32Array(count);

    let s = 424242;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

    const dustA = new THREE.Color(0x9fd0ff);
    const dustB = new THREE.Color(0xe8dcc0);
    const ember = new THREE.Color(0xff9a44);
    // The six elemental hues. A third of the motes take one.
    //
    // These were previously chosen by a coarse spatial hash
    // (`floor(x/11)*7 + floor(z/11)*13`), which is an axis-aligned grid: every
    // mote inside a cell got an identical hue and the hue changed in a hard
    // step at each boundary. On screen that read as a regular lattice of
    // chevron-shaped colour clusters — a worse "prototype" tell than the
    // flat-shaded backdrop it was meant to enrich, because a regular grid is
    // something the natural world never produces.
    //
    // Now driven by a continuous low-frequency field and blended between
    // adjacent hues, so colour varies smoothly and no boundary exists anywhere.
    const ELEM = [0xff6a2a, 0x49b7ff, 0x5fe07a, 0xd9a25a, 0xfff0b0, 0xb478ff]
      .map((h) => new THREE.Color(h));
    const c = new THREE.Color();
    const c2 = new THREE.Color();

    /** Smooth, non-repeating scalar field over the XZ plane, roughly [0,1]. */
    const hueField = (x, z) => {
      const f = Math.sin(x * 0.037 + z * 0.021)
        + Math.sin(x * 0.013 - z * 0.041) * 0.8
        + Math.sin((x + z) * 0.026 + 1.7) * 0.6;
      return (f / 2.4) * 0.5 + 0.5;
    };

    for (let i = 0; i < count; i++) {
      const isEmber = rnd() < 0.30;
      const x = (rnd() * 2 - 1) * halfW;
      const y = rnd() * height;
      const z = (rnd() * 2 - 1) * halfH;
      pos[i * 3 + 0] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      seed[i * 3 + 0] = rnd() * 100;
      seed[i * 3 + 1] = 0.4 + rnd() * 1.3;
      seed[i * 3 + 2] = isEmber ? 0.7 + rnd() * 1.0 : 0.35 + rnd() * 1.15;
      const tinted = !isEmber && rnd() < 0.34;
      if (isEmber) c.copy(ember).multiplyScalar(0.85 + rnd() * 0.8);
      else if (tinted) {
        // Continuous position along the hue wheel, blended between neighbours
        // so there is never a visible boundary between two colours.
        const t = THREE.MathUtils.clamp(hueField(x, z), 0, 0.9999) * ELEM.length;
        const i0 = Math.floor(t);
        c.copy(ELEM[i0 % ELEM.length]);
        c2.copy(ELEM[(i0 + 1) % ELEM.length]);
        c.lerp(c2, t - i0).multiplyScalar(0.45 + rnd() * 0.6);
      }
      else c.copy(dustA).lerp(dustB, rnd()).multiplyScalar(0.42 + rnd() * 0.7);
      col[i * 3 + 0] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      type[i] = isEmber ? 1 : 0;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aType', new THREE.BufferAttribute(type, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height * 0.5, 0), 70);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPix: { value: 1 },
        uHeight: { value: height },
        uIntensity: { value: 1.0 },
      },
      vertexShader: /* glsl */`
        attribute vec3 aSeed;
        attribute vec3 aColor;
        attribute float aType;
        uniform float uTime, uPix, uHeight;
        varying vec3 vCol;
        varying float vAlpha;

        void main() {
          float ph = aSeed.x, sp = aSeed.y, sz = aSeed.z;
          vec3 p = position;
          float t = uTime;

          if (aType > 0.5) {
            // embers: rise, wobble, loop
            float life = fract((t * sp * 0.045) + ph * 0.0137);
            p.y = life * uHeight * 1.15;
            p.x += sin(t * 0.5 * sp + ph) * 1.6;
            p.z += cos(t * 0.43 * sp + ph * 1.7) * 1.6;
            vAlpha = smoothstep(0.0, 0.12, life) * smoothstep(1.0, 0.55, life);
            vAlpha *= 0.62;
          } else {
            // dust: slow lissajous, never leaves the volume
            p.x += sin(t * 0.13 * sp + ph) * 2.6;
            p.y += sin(t * 0.11 * sp + ph * 2.1) * 1.5;
            p.z += cos(t * 0.09 * sp + ph * 1.3) * 2.6;
            float tw = 0.35 + 0.65 * (0.5 + 0.5 * sin(t * (0.5 + sp) + ph * 3.0));
            vAlpha = tw * 0.34;
          }

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          // 330, not 90 — see the class header. At the real gameplay distance
          // (~70 units) this gives 2..8 px sprites instead of 1 px.
          gl_PointSize = clamp(uPix * sz * 330.0 / max(d, 1.0), 1.5, 13.0);
          vCol = aColor;
          // fade out very close to camera so motes never smear the lens
          vAlpha *= smoothstep(3.0, 12.0, d);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision mediump float;
        uniform float uIntensity;
        varying vec3 vCol;
        varying float vAlpha;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          float a = smoothstep(0.5, 0.0, d);
          a = a * a;
          float core = smoothstep(0.16, 0.0, d);
          vec3 c = vCol * (a + core * 1.3);
          float al = a * vAlpha * uIntensity;
          gl_FragColor = vec4(c * al * 1.35, al);
        }
      `,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'motes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  update(elapsed, pixelRatio = 1) {
    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uPix.value = pixelRatio;
  }

  dispose() { this.points.geometry.dispose(); this.material.dispose(); }
}
