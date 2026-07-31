import * as THREE from 'three';
import { COMMON, ANIM } from './material.js';
import { HOSTILE_GLSL } from './palette.js';

/**
 * CREEP SILHOUETTE PASSES — gate G4.
 *
 * Round 3's blind critic: *"The HUD says 8 alive. I found two."* Measured, our
 * creep bodies sat at ~15% saturation against a floor at 17-21% and nearly the
 * same hue, and the round-1 readability plan (a `pow(1-NdV, 3.4)` fresnel rim)
 * produces a band a fraction of a pixel wide on a body 54px tall. It cannot
 * work. Making it a full-body flood instead put a 5px-wide limb at high
 * luminance, where ACES bleaches it to near-white and the hue — the only axis
 * the stone floor cannot compete on — is thrown away.
 *
 * Element TD 2 does not use a fresnel rim. Look at
 * `reference/etd2-04-ruins-terraces-tower-glows.jpg`: the creeps are a DARK
 * body wrapped in a hard, saturated, uniformly-thick outline of the wave's
 * colour, sitting in a ground pool of the same hue. The outline is a constant
 * screen-space width, so it survives at any creep size; the chroma is extreme
 * but the luminance is modest, so it survives tonemapping.
 *
 * That is a hull shell, not a shader term, so this file draws two of them per
 * archetype. Both share the body's geometry AND its `instanceMatrix`, so they
 * cost no extra CPU and no extra geometry memory — only the draw call and the
 * rasterised triangles.
 *
 *   OUTLINE  BackSide, inflated along the animated normal, in the opaque queue.
 *            The inflated back faces poke out past the body everywhere the body
 *            does not cover them, which is exactly the silhouette, at a
 *            near-constant screen width because the inflation is scaled by view
 *            distance. This is the "how many are there" cue.
 *
 *   XRAY     FrontSide, inflated, `depthFunc = GreaterDepth`, depthWrite off,
 *            in the transparent queue. Depth-GREATER means it draws ONLY where
 *            something nearer already wrote depth — i.e. only where the creep is
 *            hidden behind a tower. Unoccluded creeps get nothing from it (the
 *            shell is in front of its own body, so the test fails). Towers grew
 *            tall in round 3 and creeps near the spawn went behind them; this is
 *            the Warcraft 3 answer, and it costs one extra pass rather than a
 *            second camera or a stencil.
 *
 * Neither shell casts shadows (they are not real mass) and both are excluded
 * from the AO G-buffer via `userData.noAO` — see PITFALLS.md §3, where GTAO's
 * override-material prepass silently ignored `transparent` and painted a wedge
 * across the board.
 *
 * =============================================================================
 * ROUND 5 — WHY THE ABOVE STILL FAILED, AND IT IS NOT A TUNING MISS EITHER
 * =============================================================================
 *
 * Round 4 declared this file a success on a controlled probe (HUD says 7, the
 * probe counts 7). Three blind critics then failed the real frame 3/3 with
 * *"there are no visible units"*. The ablation that settled it is in
 * `tools/scratch/r5-creep-ablate.mjs`: freeze a real midgame board, then hide
 * one creep pass at a time.
 *
 *   body only (both shells off)  -> the creeps are essentially GONE
 *   shells only (body off)       -> indistinguishable from the full frame
 *
 * So the shells were not outlining the creep. **They had replaced it.** What
 * was on screen was a pale mint translucent mass, at the same value, chroma and
 * softness as the tower VFX washes it was standing in — which is exactly what
 * three critics described without being able to name it.
 *
 * Two independent causes, both geometric:
 *
 * 1. THE X-RAY PASS PASSES ITS OWN DEPTH TEST EVERYWHERE. Inflating a hull
 *    outward along its normal moves every fragment toward the silhouette, and
 *    on any convex surface the silhouette is the FARTHEST part of it. So an
 *    outward-inflated hull is, by construction, behind its own body at every
 *    pixel — `depthFunc = GreaterDepth` therefore passes over the entire unit,
 *    occluded or not, and painted a ~0.5-alpha coloured sheet over every creep
 *    on the board. The `edge` weighting in the fragment shader attenuates that;
 *    it cannot gate it. **A depth-fail x-ray must not be inflated at all.** It
 *    is now inflation-zero with a small view-space bias *toward* the camera, so
 *    equal depth fails and only a genuine occluder in front lets it through.
 *
 * 2. THE COLOUR WAS THE WORST HUE AVAILABLE FOR ACES. Round 4 correctly wrote
 *    down law 4 (saturation carries, brightness bleaches) and then picked
 *    0x1fffc8 and 0xb4ff21 — cyan and lime, the two highest-luminance hues
 *    there are (luma 0.79 and 0.72 at full chroma). At the amplitudes this file
 *    used they land past the ACES shoulder and desaturate to mint no matter how
 *    much chroma you feed in. Red at full chroma is luma 0.21, so it takes ~4x
 *    the amplitude before it does the same thing. See `creeps/palette.js`,
 *    which is now the only place a creep colour may be authored.
 */

const SHELL_VERT = /* glsl */`
  uniform float uInflate;
  /**
   * View-space push TOWARD the camera, in world units. Only the x-ray uses it,
   * and it is what makes depthFunc = GreaterDepth mean what it is supposed to
   * mean: with zero inflation the shell sits exactly on its own body, so equal
   * depth must FAIL, and biasing it nearer guarantees that instead of leaving
   * it to floating-point luck. Anything still passing is behind a real
   * occluder by more than uZBias.
   */
  uniform float uZBias;
  varying float vNdv;
  varying float vUpZ;
  varying float vDepth;

  void main() {
    creepAnim();
    vec3 transformed = cRot * (position - aPivot) + cOff;
    vTint = aTint; vMat = aMat; vICol = instanceColor;
    vExtra = instanceExtra; vAnim = instanceAnim;
    vObjY = position.y;

    vec3 n = normalize(vLocalN);
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(transformed, 1.0);
    // Inflate in VIEW space, scaled by view depth, so the outline is a constant
    // number of pixels whether the creep is a 54px runner at the far rim or a
    // boss filling a quarter of the frame. A model-space offset would be
    // hairline on the small units — the exact failure mode of the old rim.
    vec3 vn = normalize(mat3(modelViewMatrix * instanceMatrix) * n);
    float depth = max(1.0, -mv.z);
    // XY only. Displacing along view Z as well would push the outline behind
    // the floor at the creep's feet and eat the bottom of every silhouette.
    mv.xy += vn.xy * uInflate * depth;
    // View space is -Z forward, so ADDING z moves toward the camera.
    mv.z += uZBias;

    vWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
    vNdv = abs(vn.z);
    vUpZ = n.y;
    vDepth = depth;
    gl_Position = projectionMatrix * mv;
  }
`;

const SHELL_HEAD = /* glsl */`
  varying float vNdv;
  varying float vUpZ;
  varying float vDepth;
  varying vec3 vICol;
  varying vec4 vExtra;
  varying vec4 vAnim;
  varying vec3 vWorldPos;
  varying float vObjY;
  varying vec3 vTint;
  varying float vMat;
  varying vec3 vLocalN;
  uniform float uTime;

  // The reserved hostile hue. Round 4 derived the shell colour from the
  // per-instance element colour, which is how five of six archetypes ended up
  // wearing a tower's colour. The hue is now a constant; the instance colour
  // only chooses how light or deep this archetype's red is.
  ${HOSTILE_GLSL}

  // Status is allowed to shift the shell by a FEW degrees and no more. A
  // midgame board with fire, poison and frost towers puts a status on nearly
  // every creep, so anything stronger repaints the whole wave out of the
  // reserved band — measured in round 4 as gold-orange creeps, i.e. the arena
  // floor's own hue family, which is the exact failure the last three rounds
  // were about. Division of labour: the SHELL always says "hostile"; the BODY
  // interior says what is currently happening to it.
  void statusHue(inout vec3 h, vec4 extra) {
    float frozen  = step(0.5, mod(extra.w, 2.0));
    float burning = step(0.5, mod(floor(extra.w / 2.0), 2.0));
    float poison  = step(0.5, mod(floor(extra.w / 4.0), 2.0));
    h = mix(h, h * vec3(0.70, 1.30, 2.00), frozen * 0.22);   // toward violet-red
    h = mix(h, h * vec3(1.05, 1.55, 0.55), burning * 0.16);  // toward ember
    h = mix(h, h * vec3(0.75, 2.00, 0.95), poison * 0.20);   // toward sick pink
  }
`;

/** Bright, saturated hull outline drawn around every creep. */
export function makeOutlineMaterial() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    uniforms: {
      uInflate: { value: 0.0 },
      uZBias: { value: 0.0 },
      uTime: { value: 0 },
    },
    vertexShader: COMMON + ANIM + SHELL_VERT,
    fragmentShader: SHELL_HEAD + /* glsl */`
      void main() {
        vec3 h = hostileHue(vICol);
        statusHue(h, vExtra);
        float isBoss = step(0.5, mod(floor(vExtra.w / 8.0), 2.0));

        // Slow travelling pulse so a stationary crowd is never a dead frame,
        // and a per-creep phase so a wave does not strobe in unison.
        float pulse = 0.92 + 0.08 * sin(uTime * 2.2 + vExtra.z * 0.7 + vObjY * 1.4);

        // Value gradient down the body: the outline is hottest at the shoulders
        // and cools toward the feet, which is what stops a wave of outlines
        // reading as a row of identical stickers.
        float up = clamp(vObjY * 0.55 + 0.18, 0.0, 1.0);

        // MEASURED DOWN, twice, and the first number was wrong in the same way
        // round 4's was. Red buys ~4x the amplitude headroom of cyan before ACES
        // starts bleaching (luma 0.21 vs 0.79), so the first pass here ran at
        // 1.55-2.10 to spend it. Captured, that came back SALMON PINK: the ACES
        // shoulder is not the only thing lifting the off-channels — the bloom
        // pyramid adds a broad near-white halo around anything this hot, and a
        // 3px line is almost entirely halo. Backing off to ~1.0-1.4 puts it on
        // screen as the crimson it is authored as. The headroom is real; it just
        // has to be spent on chroma, not on level.
        float amp = (1.05 + 0.45 * up) * pulse * mix(1.0, 1.28, isBoss);

        // Spawn-in flare, and a hit flash that brightens the OUTLINE rather
        // than bleaching the body.
        float sp01 = clamp(vAnim.w, 0.0, 1.0);
        amp += (1.0 - sp01) * 1.6;

        // HIT FLASH — third attempt, and the first that survives a real board.
        // In a midgame frame the creeps under fire are re-flashed faster than
        // the 0.22s decay, so hitFlash is pinned at 1 on exactly the units you
        // most need to see. Round 1 added vec3(1.9,1.6,1.35) and bleached them;
        // round 4's first pass added 0.85 of near-white here and did it again,
        // measured on a capture as a cream-white blob where a cyan Stalker
        // should have been. A flash that can be permanently on must therefore
        // be a *gain* on the element colour, never a push toward white.
        float hf = clamp(vExtra.x, 0.0, 1.0);
        amp *= 1.0 + hf * hf * 0.40;
        vec3 c = h * amp + vec3(1.0, 0.96, 0.92) * hf * hf * 0.10;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  mat.toneMapped = true;
  return mat;
}

/**
 * Depth-fail silhouette: draws only the parts of a creep hidden behind a tower.
 * This is what keeps the count honest now that towers are 2.5-3.5 cells tall.
 */
export function makeXrayMaterial() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    uniforms: {
      // MUST STAY ZERO. See the round-5 note in this file's header: any
      // outward inflation puts the hull behind its own body at every pixel, so
      // GreaterDepth passes over the whole unit and the "x-ray" becomes a
      // coloured sheet pasted across every creep on the board. That is what
      // round 4 actually shipped.
      uInflate: { value: 0.0 },
      uZBias: { value: 0.0 },
      uTime: { value: 0 },
    },
    vertexShader: COMMON + ANIM + SHELL_VERT,
    fragmentShader: SHELL_HEAD + /* glsl */`
      void main() {
        vec3 h = hostileHue(vICol);
        statusHue(h, vExtra);
        float isBoss = step(0.5, mod(floor(vExtra.w / 8.0), 2.0));

        // Facing-ratio gradient so the hidden shape still reads as a volume
        // and not a flat vinyl sticker: brighter and more opaque at the
        // silhouette edge, softer through the middle.
        float edge = 1.0 - clamp(vNdv, 0.0, 1.0);
        float band = smoothstep(0.20, 0.92, edge);

        float scan = 0.88 + 0.12 * sin(uTime * 3.0 - vWorldPos.y * 5.5 + vExtra.z);
        // ROUND 5: back down from 0.48 base. With the inflation bug fixed this
        // pass only fires where a tower genuinely hides the unit, so it no
        // longer has to be faint to avoid glazing the whole board — but it also
        // must not out-read the unoccluded units standing next to it, or the
        // player learns to look for the ghost instead of the creep.
        float a = (0.34 + 0.44 * band) * scan * mix(1.0, 1.25, isBoss);

        // DISTANCE GATE. Kept from round 4: at the inspector/closeup cameras a
        // unit is 300px tall and needs no help, and the residual self-occlusion
        // (a pauldron in front of its own chest) is then large enough to read
        // as damage. Fades in across the range no camera preset sits in.
        a *= smoothstep(26.0, 44.0, vDepth);
        if (a < 0.004) discard;

        vec3 c = h * (0.85 + 1.15 * band) * scan;
        gl_FragColor = vec4(c * a, a);
      }
    `,
  });
  // ONLY where something nearer has already written depth — i.e. occluded.
  mat.depthFunc = THREE.GreaterDepth;
  mat.premultipliedAlpha = true;
  mat.toneMapped = true;
  return mat;
}

/**
 * Attach both shells to an archetype's body mesh. They share its geometry and
 * its `instanceMatrix` object, so `Creeps.#writeInstances` only has to keep
 * `.count` in sync — no second pass of matrix composition.
 */
export function makeShells(bodyMesh, outlineMat, xrayMat) {
  const outline = new THREE.InstancedMesh(bodyMesh.geometry, outlineMat, 1);
  const xray = new THREE.InstancedMesh(bodyMesh.geometry, xrayMat, 1);
  for (const m of [outline, xray]) {
    m.instanceMatrix = bodyMesh.instanceMatrix;
    m.castShadow = false;
    m.receiveShadow = false;
    m.frustumCulled = false;
    m.count = 0;
    m.userData.noAO = true;
  }
  outline.renderOrder = -1;   // before the body, so the body wins the interior
  xray.renderOrder = 6;
  return { outline, xray };
}
