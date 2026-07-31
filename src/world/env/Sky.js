import * as THREE from 'three';
import { NOISE } from './glsl.js';

/**
 * One inverted sphere carrying the entire deep sky. 1 draw call, no textures.
 *
 * ROUND 2 — the sky is now a two-anchor complementary scheme, not a blue wash.
 *
 *   WARM anchor  : an ember/amber "furnace" glow filling the key hemisphere,
 *                  strongest low down (elevation -10 to -50) which is exactly
 *                  the band the 52-deg-pitched gameplay camera looks through.
 *   COOL anchor  : deep indigo/teal on the anti-key hemisphere, with the
 *                  aurora and the densest star field.
 *   BRIDGE       : the magenta nebula is deliberately parked on the terminator
 *                  between the two, so the transition reads as a hue ramp
 *                  amber -> rose -> violet -> indigo rather than a hard seam.
 *
 * The overall VALUE has also come down. Round 1's sky sat at L=33 while the
 * board sat at L=50 -- far too close for "the board is the only lit thing in
 * the world". The gradient constants below are roughly 35% darker so the lit
 * arena can win by a factor, not a few percent.
 */
export class Sky {
  constructor(sunDir = new THREE.Vector3(27.1, 29.4, -30.1).normalize()) {
    const geo = new THREE.SphereGeometry(500, 48, 32);

    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      // The dome must WRITE DEPTH. The GTAO pass reads the depth buffer and
      // multiplies its result over the frame; a background with no depth is
      // reconstructed at the far plane and comes back as solid black.
      depthWrite: true,
      depthTest: true,
      fog: false,
      toneMapped: true,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDir.clone() },
        uZenith: { value: new THREE.Color(0x03060f) },
        uMid: { value: new THREE.Color(0x060f2c) },
        // ROUND 3: darkened from 0x112c58. This is the brightest base term in
        // the dome and it lives exactly at the elevation band the backdrop
        // ruins occupy, so at the old value the GAPS between silhouettes came
        // back as saturated blue cut-outs brighter than anything around them.
        uHorizon: { value: new THREE.Color(0x0b1e3f) },
        uAbyss: { value: new THREE.Color(0x0a0620) },
        uNebulaA: { value: new THREE.Color(0x9c2a63) },   // rose / magenta
        uNebulaB: { value: new THREE.Color(0x11566e) },   // teal
        uAurora: { value: new THREE.Color(0x2f9fd0) },
        uSun: { value: new THREE.Color(0xffb057) },       // ember amber
        uForge: { value: new THREE.Color(0xff6a1e) },     // hot core of the warm side
        uExposure: { value: 1.0 },
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vDir;
        uniform float uTime, uExposure;
        uniform vec3 uSunDir, uZenith, uMid, uHorizon, uAbyss;
        uniform vec3 uNebulaA, uNebulaB, uAurora, uSun, uForge;

        ${NOISE}

        // Sparse cellular stars. One cell lookup per layer — cheap enough to
        // afford two layers at full res.
        float starLayer(vec3 d, float scale, float density, float radius, float t, out vec3 tint) {
          vec3 p = d * scale;
          vec3 c = floor(p);
          vec3 f = fract(p) - 0.5;
          vec3 r = hash33(c + 3.17);
          tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.66), r.x);
          if (r.z > density) return 0.0;
          vec3 sp = (hash33(c + 11.7) - 0.5) * 0.55;
          float dd = length(f - sp);
          float br = smoothstep(radius, radius * 0.12, dd);
          float tw = 0.45 + 0.55 * sin(t * (0.6 + r.x * 2.2) + r.y * 6.2831);
          return br * br * (0.35 + 0.65 * tw) * (0.35 + r.y);
        }

        void main() {
          vec3 d = normalize(vDir);
          float up = d.y;
          float down = -up;                  // the gameplay camera lives here
          float t = uTime;

          // Horizontal (azimuth-only) alignment with the key. This is the
          // master warm/cool selector: +1 straight into the sun's compass
          // bearing, -1 directly away from it. Using the azimuth rather than
          // the full 3D dot means the warm side stays warm all the way down
          // into the abyss instead of pinching off at the horizon.
          vec2 dh = normalize(vec2(d.x, d.z) + 1e-5);
          vec2 sh = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
          float az = dot(dh, sh);                              // -1 .. 1
          // The split point is not arbitrary. The key bearing is -48 deg and the
          // frame spans azimuth -127 .. -34, so the LEFT edge of frame sits
          // 79 deg off the key: az = cos(79) = 0.19. Starting the ramp above
          // that value is what guarantees a genuinely cool region INSIDE the
          // picture. Round 2's first pass used smoothstep(-0.02, 0.88) and the
          // entire visible window came back warmSide >= 0.25 -- a warm frame
          // with the cool anchor pushed off-screen behind the camera, which is
          // exactly the round 1 failure with the hues swapped.
          // ROUND 2, FINAL SPLIT. The terrain agent committed its plate to a
          // warm sand/gold albedo, so the ENVIRONMENT takes the cool half of
          // the complementary pair: warm board, cool world. The Art Bible's
          // own phrasing is "cool grey-violet arcane granite lit warm" — the
          // light is warm, the world is not.
          //
          // Concretely the warm wedge is now confined to roughly +/-40 deg
          // around the key bearing (-48), which is the right ~45% of frame.
          // Everything left of that is deep violet-teal. An earlier pass used
          // smoothstep(0.24, 0.97) and the warm reached the far left corner,
          // producing a warm-monochrome frame -- the round 1 failure with the
          // hue rotated, which loses the blind test for the same reason.
          float warmSide = smoothstep(0.66, 0.99, az);         // 0 cool .. 1 warm

          // The camera is pitched 52 deg down with a 20 deg half-FOV, so the
          // frame occupies elevation -27 .. -72. Everything below is tuned to
          // put its strongest statement inside that window.
          float lum = 1.0 - smoothstep(0.05, 0.95, down);
          // "in frame" weight: peaks around elevation -35 deg (down = 0.57).
          float inFrame = smoothstep(0.05, 0.42, down) * smoothstep(1.02, 0.66, down);

          // ---- base gradient -----------------------------------------------
          vec3 col;
          if (up >= 0.0) {
            float k = pow(clamp(up, 0.0, 1.0), 0.62);
            col = mix(uHorizon, uMid, smoothstep(0.0, 0.42, k));
            col = mix(col, uZenith, smoothstep(0.35, 1.0, k));
          } else {
            col = mix(uHorizon, uMid, smoothstep(0.0, 0.34, down));
            col = mix(col, uAbyss, smoothstep(0.30, 0.98, down));
          }
          // Warm the base itself on the key side — subtle, but it means even
          // the darkest warm-side pixel is hue-separated from the cool side.
          col = mix(col, col * vec3(1.34, 1.00, 0.78), warmSide * 0.40);

          /* ================= WARM ANCHOR ==================================
             A furnace glow filling the key hemisphere. Three stacked terms:
               forge  — the hot low core, orange-red, strongest in frame
               wash   — a broad amber field over the whole warm hemisphere
               flare  — the sun's own bloom, high and out of frame but it
                        bleeds down into the top of the picture
             Noise-broken at every boundary: any clean smoothstep on an
             elevation iso-line shows up on screen as a straight edge.
          =============================================================== */
          /* ROUND 3 — THE WARM SIDE WAS A CARD, AND IT WAS MINE.
           *
           * Ablating the backdrop and the breach out of the frame left the
           * upper right as bare sky, and the sampler read it as:
           *
           *     rgb(157,99,64)  L=108.6  p50=111.1  p95=120.9
           *
           * A ten-point luminance spread across a 360x280 region. That is a
           * gradient card by any definition — and at L=108 it was BRIGHTER
           * than the board it is supposed to sit behind (L=74). The critic's
           * "flat gradient card with a straight hard edge" was partly the
           * shafts, but the flat field it sat in was this.
           *
           * Two causes, both the same mistake made in two places:
           *
           *  - every break-up term was sampled at d*0.48 to d*1.15, and d is a
           *    UNIT vector. A frequency of 1 over a unit sphere means one
           *    feature per radian: across the ~35 deg the warm side occupies
           *    on screen, grain and grainBig barely changed. The noise was
           *    real and completely invisible.
           *  - the coefficients were tuned against round 1's much brighter
           *    board and never revisited.
           *
           * Below: four octaves spanning d*2.2 to d*22, a ridged filament
           * layer that actually reaches threshold, and coefficients cut so the
           * warm anchor sits under the board instead of over it.
           */
          float grain = 0.42 + 0.58 * fbm3(d * 3.4 + vec3(4.1, t * 0.004, 0.0), 4);
          float grainMid = 0.55 + 0.45 * fbm3(d * 9.5 + vec3(0.0, t * 0.006, 2.3), 3);
          float grainFine = 0.70 + 0.30 * fbm3(d * 22.0 + vec3(1.7, 0.0, t * 0.010), 2);
          float grainBig = smoothstep(0.18, 0.86, fbm3(d * 1.35 + vec3(0.0, t * 0.0025, 9.2), 3));

          float forgeBand = smoothstep(-0.02, 0.40, down) * smoothstep(1.05, 0.52, down);
          float forge = pow(warmSide, 1.35) * forgeBand * grain * grainMid * grainFine;
          col += uForge * forge * 0.070;
          col += uSun * forge * 0.040;

          float wash = pow(warmSide, 2.0) * (0.30 + 0.85 * inFrame)
                     * (0.20 + 1.05 * grainBig) * grainMid;
          col += uSun * wash * 0.026;

          float sd = max(0.0, dot(d, uSunDir));
          col += uSun * (pow(sd, 5.0) * 0.16 + pow(sd, 1.5) * 0.026);

          // Ember striations: long thin hot filaments in the warm band. These
          // are what the god-ray brightpass and the eye both latch onto.
          // Two scales now — one that reads as cloud structure, one as fine
          // filament — because a single ridged layer at d*2.4 was, again, a
          // feature per radian.
          float striate = ridged(vec3(d.x * 4.6, d.y * 15.0 + t * 0.02, d.z * 4.6), 3);
          striate = pow(clamp(striate - 0.48, 0.0, 1.0), 1.4);
          float striate2 = ridged(vec3(d.x * 13.0, d.y * 34.0 - t * 0.03, d.z * 13.0), 2);
          striate2 = pow(clamp(striate2 - 0.55, 0.0, 1.0), 1.8);
          col += uForge * (striate * 0.30 + striate2 * 0.42)
               * forgeBand * pow(warmSide, 2.2);

          // Dark ash clouds drifting across the furnace. Structure needs both
          // signs: adding light everywhere only ever raises the floor.
          float ash = smoothstep(0.36, 0.78, fbm3(d * 5.2 + vec3(t * 0.008, 0.0, 5.1), 4));
          col *= mix(1.0, 0.36, ash * pow(warmSide, 1.4) * forgeBand);

          /* ================= BRIDGE: nebula on the terminator ============ */
          // Peaks where warmSide ~= 0.5, i.e. exactly between the two anchors.
          float termi = 1.0 - abs(warmSide * 2.0 - 1.0);
          vec3 np = d * 2.1 + vec3(0.0, 0.0, t * 0.004);
          float fil = ridged(np, 4);
          float mask = fbm3(d * 0.9 + vec3(t * 0.003, 0.0, 0.0), 3);
          float neb = pow(clamp(fil - 0.40, 0.0, 1.0), 1.6) * smoothstep(0.26, 0.76, mask);
          neb *= (0.20 + 1.05 * lum) * (0.30 + 1.30 * termi);
          float hue = fbm3(d * 0.55 + 7.3, 2);
          vec3 nebCol = mix(uNebulaB, uNebulaA, smoothstep(0.38, 0.80, hue));
          neb *= 0.75 + 0.25 * sin(t * 0.09 + hue * 4.0);
          col += nebCol * neb * 5.2;

          // Large soft rose wash, also terminator-weighted: gives the sky
          // large-scale value structure instead of uniform noise.
          float rose = smoothstep(0.34, 0.85, fbm3(d * 0.42 + vec3(0.0, t * 0.002, 4.1), 3));
          col += mix(uNebulaB, uNebulaA, 0.55) * rose * lum * termi * 0.50;

          /* ================= COOL ANCHOR ================================= */
          float coolSide = 1.0 - warmSide;
          // aurora ribbons, slung below the horizon on the cool side
          float band = smoothstep(-0.30, 0.42, down) * smoothstep(1.15, 0.40, down);
          float patchy = smoothstep(0.30, 0.80, fbm3(d * 1.15 + vec3(2.7, t * 0.006, 0.0), 3));
          float wob = fbm3(vec3(d.x * 1.6, d.y * 5.0 - t * 0.05, d.z * 1.6), 3);
          float rib = sin(d.x * 5.5 + d.z * 3.1 + wob * 7.0 + t * 0.13);
          rib = pow(clamp(rib * 0.5 + 0.5, 0.0, 1.0), 3.2);
          float aur = rib * band * pow(coolSide, 1.2) * patchy * (0.55 + 0.45 * sin(t * 0.11 + 1.7));
          col += uAurora * aur * 0.52;
          col += mix(uAurora, uNebulaB, 0.5) * band * coolSide * patchy * 0.055;

          // ---- stars: a *starlit* abyss, so they wrap all the way round ----
          // Suppressed on the warm side — you do not see stars through a furnace.
          vec3 tintA, tintB;
          float s1 = starLayer(d, 58.0, 0.095, 0.21, t, tintA);
          float s2 = starLayer(d, 132.0, 0.16, 0.27, t * 1.6, tintB);
          float dust = smoothstep(0.55, 1.0, fbm3(d * 3.0, 3));
          float starFade = (1.0 - 0.75 * smoothstep(0.55, 1.0, down))
                         * (1.0 - neb * 0.5)
          // ROUND 3: warm-side stars lifted from 0.42 to 0.68 of full. "You do
          // not see stars through a furnace" is true, but it left the entire
          // warm third of the frame with no high-frequency detail at all,
          // which is half of why it read as a card.
                         * (0.68 + 0.32 * coolSide);
          col += tintA * s1 * 3.1 * starFade;
          col += tintB * s2 * 0.95 * starFade * (0.4 + dust);

          /* ================= THE SILHOUETTE BAND =========================
             Measured on the round-2 iteration-3 frame: the backdrop ruins sat
             at L=31 and the sky behind them at L=30. Identical values mean no
             silhouette, and no silhouette means no storytelling however good
             the shapes are. Every matte painting solves this the same way —
             put a luminous band of atmosphere BEHIND the architecture.

             This band spans elevation -15 .. -49 deg (which is where the three
             backdrop rings actually sit from the camera's eye height), is cool
             steel-blue on the anti-key side and amber on the key side, and is
             broken up by two octaves of noise so it never shows an edge. The
             board still out-values it comfortably (87 vs ~60), so the eye
             still goes to the arena first.
          =============================================================== */
          /* ROUND 3 — THIS TERM WAS THE FLAT CARD.
           * Ablating the backdrop and the breach left the upper right at
           * L=93.7 with p50 94.6 and p95 109.7. Working back through the
           * terms, this band contributes ~0.15 linear red on the warm side —
           * five times the forge glow and more than everything else in the
           * shader put together. It WAS the warm sky.
           * And its two break-up octaves were at d*0.85 and d*2.6, i.e.
           * feature sizes of roughly 1700 px and 570 px on a 1920-wide frame.
           * The band was, to within a few percent, a constant. Frequencies
           * below are 4x and 11x higher (features ~410 px and ~135 px, both
           * comfortably above the DOF blur radius that eats the star discs),
           * with a third octave for grain, and the warm half is cut by 43%. */
          float sil = smoothstep(0.14, 0.40, down) * smoothstep(0.88, 0.52, down);
          float silBreak = 0.34 + 0.66 * fbm3(d * 3.6 + vec3(3.3, t * 0.0035, 0.0), 4);
          float silFine = 0.42 + 0.58 * fbm3(d * 11.0 + vec3(0.0, 0.0, t * 0.006), 3);
          silFine *= 0.68 + 0.32 * fbm3(d * 26.0 + vec3(5.5, t * 0.009, 0.0), 2);
          // ROUND 3: the cool half of this band has been cut by ~60%. It was
          // sized for round 2, when the backdrop ruins rendered at L=31 and
          // needed a luminous field behind them to be legible at all. The
          // ruins are now genuine near-black silhouettes, so the band no
          // longer has to fight for them — and at its old strength the gaps
          // BETWEEN ruins came back as saturated cyan-blue patches that read
          // as holes punched in the architecture. Measured on the 4x crop:
          // sky gaps at rgb(55,120,210) against silhouettes at rgb(20,24,38).
          vec3 silCool = vec3(0.10, 0.26, 0.72);
          vec3 silWarm = vec3(1.00, 0.52, 0.18);
          // Weighted toward the warm side. A band of equal strength all the
          // way round turns the cool third of the frame into milky pink haze
          // and swallows the star field, which is the one thing the "starlit
          // abyss" in the pitch actually depends on.
          col += mix(silCool, silWarm, smoothstep(0.10, 0.85, warmSide))
                 * sil * silBreak * silFine * (0.078 + 0.082 * warmSide);

          // ---- horizon haze ring -------------------------------------------
          float haze = exp(-abs(up) * 7.0);
          col += mix(vec3(0.040, 0.075, 0.16), uSun * 0.42, warmSide) * haze * 0.30;

          // ---- deep mist decks ---------------------------------------------
          // Broad horizontal streaks well below the horizon read as cloud
          // strata receding into the void. Lit warm from the key side.
          float deck = sin(down * 26.0 - 1.4 + fbm3(d * 1.4 + t * 0.01, 2) * 3.4);
          deck = pow(clamp(deck * 0.5 + 0.5, 0.0, 1.0), 3.0);
          vec3 deckCol = mix(vec3(0.13, 0.21, 0.40), uSun * 0.55, warmSide);
          col += deckCol * deck * smoothstep(0.10, 0.45, down) * smoothstep(1.0, 0.62, down) * 0.11;

          col *= uExposure;

          // ---- dither ------------------------------------------------------
          // The sky is a near-pure gradient over a very small value range, and
          // an 8-bit framebuffer quantises that into visible Mach bands. This
          // is triangular-PDF noise at +-1 LSB in linear space, applied BEFORE
          // the tonemap so it survives into the final quantisation. It is the
          // standard fix and it costs one hash.
          //
          // three's dithering flag is not usable here: it operates on the
          // ShaderChunk pipeline of built-in materials, and this is a raw
          // ShaderMaterial that writes gl_FragColor itself.
          float d1 = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          float d2 = fract(sin(dot(gl_FragCoord.xy + 17.3, vec2(63.7264, 10.873))) * 24634.6345);
          col += ((d1 + d2) - 1.0) / 255.0;

          gl_FragColor = vec4(max(col, 0.0), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
  }

  update(elapsed, camera) {
    this.material.uniforms.uTime.value = elapsed;
    this.mesh.position.copy(camera.position);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
