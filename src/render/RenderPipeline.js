import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { QUALITY_PRESETS, GRID } from '../core/Config.js';
import { DepthOfFieldPass } from './DepthOfFieldPass.js';
import { GodRaysPass } from './GodRaysPass.js';
import { AdaptiveResolution } from './AdaptiveResolution.js';
import { MSAAScenePass } from './MSAAScenePass.js';

/**
 * Forward pipeline:
 *
 *   RenderPass (MSAA scene target)
 *     -> GTAO            contact occlusion
 *     -> [GodRays]       off by default, see GodRaysPass.js
 *     -> UnrealBloom     emissive-only, threshold above the lit-stone ceiling
 *     -> DepthOfField    tilt-shift diorama defocus
 *     -> Grade           ACES-adjacent lift/gamma/gain, CA, grain, vignette
 *     -> SMAA
 *     -> OutputPass      tonemap + sRGB
 *
 * ANTI-ALIASING DECISION (measured, not guessed)
 * ----------------------------------------------
 * Candidates were TAARenderPass and SMAA. TAARenderPass converges by
 * re-rendering the scene `2^sampleLevel` times with a jittered projection and
 * only accumulates while the scene is static; this board has creeps,
 * projectiles and orbiting tower rings moving *every* frame, so accumulation
 * is permanently reset - you pay 2-4x the ~930 draw calls for essentially one
 * jittered sample, and any part that does accumulate ghosts behind the creeps.
 * That is a straight fail on both perf (Art Bible 10) and G9 (popping/smear).
 *
 * What actually fixes thin geometry here - tower rings, rim runes, grid lines,
 * projectile trails - is geometric coverage AA at the source, so the scene
 * render target is now a **multisampled** WebGL2 target (`samples: 4` on
 * ultra/high/medium, 0 on low). That is resolved by the GPU for a fraction of
 * a millisecond and cannot ghost, because it is intra-frame. SMAA is kept
 * afterwards to clean up shader-level aliasing (specular sparkle, emissive
 * edges, the bloom composite) that MSAA cannot see.
 *
 * Result: MSAA(4) + SMAA. Same frame cost class as SMAA alone, visibly
 * cleaner ring/rune edges, zero ghosting.
 */
export class RenderPipeline {
  constructor(canvas, quality = 'ultra') {
    this.quality = QUALITY_PRESETS[quality] ? quality : 'high';
    this.q = QUALITY_PRESETS[this.quality];

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // handled by MSAA on the composer target
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.q.pixelRatioCap));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // R6: 1.08 -> 1.65. Most of the day relight is still in Lighting.js, not
    // here: exposure multiplies emitters and plate alike, whereas raising the
    // LIGHTS raises only the plate and therefore brings the emissives down
    // relative to it, which is what law 4 wants. The share that does live here
    // exists to pay for the uGamma contrast below, which darkens midtones.
    this.renderer.toneMappingExposure = 1.65;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.info.autoReset = false;

    this.maxAnisotropy = Math.min(
      this.q.anisotropy,
      this.renderer.capabilities.getMaxAnisotropy(),
    );

    this.clock = new THREE.Clock();
    this.composer = null;
    this.passes = {};
    this._size = new THREE.Vector2();
    this._keyLight = null;
    /** Optional in-frame emitter for screen-space shafts; see render(). */
    this.godRayAnchor = null;
  }

  build(scene, camera) {
    this.scene = scene;
    this.camera = camera;

    const size = this.renderer.getSize(new THREE.Vector2());
    const samples = this.renderer.capabilities.isWebGL2 === false ? 0 : (this.q.msaa ?? 0);

    // The composer's OWN buffers are single-sampled, always.
    //
    // EffectComposer clones this template for both ping-pong buffers, so a
    // `samples: 4` here made every fullscreen post pass write 4 samples and pay
    // a full-screen resolve — eight passes paying coverage AA that a fullscreen
    // quad cannot benefit from, to get it on the one pass that can. Measured at
    // 24.2 ms total, of which ~12.5 ms is this post-chain half and is free of any
    // visual cost. See MSAAScenePass.js for the factorial.
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 0,
      depthBuffer: true,
    });

    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());

    // Coverage AA on GEOMETRY is kept, in a private target that resolves once.
    // Falls back to a plain RenderPass when the preset asks for no MSAA at all,
    // so `low` does not pay the extra fullscreen copy for nothing.
    const dpr = this.renderer.getPixelRatio();
    this.passes.render = samples > 0
      ? new MSAAScenePass(scene, camera, samples, new THREE.Vector2(size.x * dpr, size.y * dpr))
      : new RenderPass(scene, camera);
    this.composer.addPass(this.passes.render);

    // ---------------------------------------------------------------- GTAO
    // Verified on/off with screenshots: without it, tower bases and creep feet
    // float. Radius is tuned to the 2-unit cell so the darkening is a contact
    // shadow at the base of things, not a global dirt wash across the flags.
    if (this.q.ssao) {
      const gtao = new GTAOPass(scene, camera, size.x, size.y);
      gtao.output = GTAOPass.OUTPUT.Default;
      // ROUND 7 — GTAO WAS ENABLED AND PRODUCING ALMOST NO OCCLUSION.
      //
      // Three blind critics independently: "no ambient occlusion / no contact,
      // nothing darkens where geometry meets the floor, the towers read as
      // stickers". The pass was on. §10 says prove which stage drops it before
      // adding a second system, so the raw AO buffer was dumped
      // (GTAOPass.OUTPUT.AO, downstream passes disabled) and it came back
      // essentially WHITE: hairline outlines at silhouette edges and nothing at
      // any tower base. shots/r7/ao-sweep-base.png. Measured over the board,
      // fraction of pixels carrying ANY occlusion: 0.2%.
      //
      // The gate was `thickness`, and the trap is that the obvious knob makes it
      // WORSE (tools/scratch/r7-ao-sweep.mjs, one build, % of board occluded):
      //
      //   baseline (r1.15 t0.6)              0.2%
      //   radius 2.0 / 3.0 / 4.5      0.2 / 0.1 / 0.0%   <- backwards
      //   thickness 1.5 / 3.0 / 8.0   0.7 / 1.0 / 2.1%
      //   r3.0 t3.0                          1.1%
      //   r4.0 t6.0 exp1.0 scale2.2          6.3%
      //
      // `thickness` is a view-space depth REJECTION threshold: GTAOShader skips
      // any horizon sample whose |viewDelta.z| exceeds it. At 0.6 world units,
      // on a board where a tower plinth is ~1.5 units across and the camera is
      // pitched ~52 degrees, virtually every genuine occluder sits further than
      // that in view Z from the floor pixel beside it and was thrown away — so
      // only samples that landed within 0.6 of the shading point survived, i.e.
      // silhouette hairlines. Raising `radius` alone spreads the four sample
      // steps further out (the first step is at pow(1/STEPS, distanceExponent)
      // of it), which walks them straight past the contact region that the
      // thickness gate still rejects. The two are coupled and only move
      // together; that is why four rounds of "AO is on" was true and useless.
      //
      // distanceExponent 1.6 -> 1.0 spreads the steps linearly instead of
      // bunching them at the shading point, and scale 1.3 -> 2.0 is the gamma on
      // the final AO term.
      gtao.updateGtaoMaterial({
        // The presets now carry 3.0 directly. This was briefly floored here with
        // a Math.max while the preset still said 1.15, which meant the config
        // stated a value the renderer did not use — the exact shape of the
        // godrays defect in PITFALLS §10, where a preset and a docblock
        // disagreed and cost three rounds. A knob that lies about its own value
        // is worse than a wrong knob, so the floor is gone and Config is the
        // single source of truth again.
        radius: this.q.ssaoRadius ?? 3.0,
        distanceExponent: 1.0,
        // One build cell, so a tower base and the terrace face are both inside
        // the rejection window instead of both outside it.
        thickness: 5.0,
        scale: 2.0,
        samples: this.q.ssaoSamples ?? 12,
        distanceFallOff: 0.9,
        screenSpaceRadius: false,
      });
      if (gtao.updatePdMaterial) {
        gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3.5, radius: 4, rings: 2, samples: 8 });
      }
      // CRITICAL: without a clip box, GTAO evaluates the sky dome and the
      // distant background geometry too. Those are back-facing shells, so the
      // horizon search reports full occlusion and the AO comes out at 0 -
      // measured: the sky went from rgb(47,78,107) to rgb(0,0,3), i.e. the
      // entire environment was being crushed to black (a straight G1/G5 fail).
      // Clipping AO to the arena volume leaves everything outside at AO = 1.
      gtao.setSceneClipBox(new THREE.Box3(
        new THREE.Vector3(-GRID.width * 0.75, -14, -GRID.height * 0.9),
        new THREE.Vector3(GRID.width * 0.75, 18, GRID.height * 0.9),
      ));
      gtao.blendIntensity = this.q.ssaoIntensity ?? 1.0;
      this.#excludeTranslucentFromAO(gtao, scene);
      this.passes.gtao = gtao;
      this.composer.addPass(gtao);
    }

    // ------------------------------------------------------------- god rays
    this.passes.godrays = new GodRaysPass();
    this.passes.godrays.enabled = !!this.q.godrays;
    this.composer.addPass(this.passes.godrays);

    // ---------------------------------------------------------------- bloom
    // Threshold sits in *scene-referred linear*, above anything a lit surface
    // can reach under the key light. Only genuine emitters (tower cores,
    // projectiles, rim runes, impact flashes) cross it, so 30 towers firing
    // brightens the emitters, not the stone (gate G7).
    //
    // R6: 1.05 -> 2.05. The threshold is not a look knob, it is a *function of
    // the plate*. The day relight raised lit stone roughly 3x in linear, which
    // put the sunlit flagstone straight through a 1.05 brightpass — the whole
    // board would have entered the bloom pyramid and hazed over. Track this
    // number against the key whenever the key moves.
    if (this.q.bloom) {
      const bloom = new UnrealBloomPass(
        size,
        this.q.bloomStrength ?? 0.55,
        this.q.bloomRadius ?? 0.62,
        this.q.bloomThreshold ?? 1.05,
      );
      this.passes.bloom = bloom;
      this.composer.addPass(bloom);
    }

    // ------------------------------------------------------------------ DOF
    if (this.q.dof) {
      const dof = new DepthOfFieldPass();
      dof.uniforms.uStrength.value = this.q.dofStrength ?? 1.0;
      this.passes.dof = dof;
      this.composer.addPass(dof);
    }

    // ---------------------------------------------------------------- grade
    this.passes.grade = new ShaderPass(GradeShader);
    this.passes.grade.uniforms.uResolution.value.copy(size);
    this.passes.grade.uniforms.uGrain.value = this.q.grain ?? 0.024;
    this.passes.grade.uniforms.uAberration.value = this.q.aberration ?? 0.9;
    this.composer.addPass(this.passes.grade);

    this.passes.smaa = new SMAAPass();
    this.composer.addPass(this.passes.smaa);

    this.passes.output = new OutputPass();
    this.composer.addPass(this.passes.output);

    // Find the key light once so the (optional) god-ray pass can track it.
    scene.traverse((o) => {
      if (!this._keyLight && o.isDirectionalLight && o.castShadow) this._keyLight = o;
    });

    this.resize();

    // Holds 60 fps by trading pixels, which is the only continuous knob on this
    // renderer — see AdaptiveResolution.js for the measurements that justify
    // preferring it to switching quality presets. Constructed here, after the
    // preset has set its own pixel ratio, so that ratio becomes the ceiling:
    // this layer only ever removes pixels.
    this.adaptive = new AdaptiveResolution(this.renderer, () => this.resize());
    return this;
  }

  /**
   * GTAOPass builds its own depth+normal G-buffer by re-rendering the scene
   * with an override material. That prepass ignores blending entirely, so any
   * translucent shell - a god-ray fan, ground fog, a smoke card, a decal quad -
   * is written into the G-buffer as if it were solid geometry. The AO shader
   * then evaluates occlusion on that phantom surface and multiplies the result
   * over the beauty pass, painting a hard-edged dark wedge across whatever is
   * behind it. (Reproduced and screenshotted: shots/ab-wedge-{on,off}.png.)
   *
   * CONVENTION for the environment / VFX agents
   * -------------------------------------------
   * You do not have to do anything for the common case: an object is
   * automatically kept out of the AO G-buffer when its material is
   * `transparent`, uses non-Normal blending, or has `depthWrite === false`, and
   * for all Points / Line / Sprite objects. That covers fog, motes, shafts,
   * trails, decals and status volumetrics by construction.
   *
   * Two explicit escape hatches, both on `object.userData`:
   *   `userData.noAO = true`        force-exclude an opaque object from AO
   *   `userData.aoOccluder = true`  force-INCLUDE a translucent object
   *                                 (e.g. a glass panel that should occlude)
   *
   * A dedicated layer was considered and rejected: `Object3D.layers.set()` is
   * the only form a camera-layer filter can act on, and that also removes the
   * object from raycasting and from every shadow camera - a silent, far-reaching
   * side effect for anyone tagging a mesh. userData is inert.
   */
  #excludeTranslucentFromAO(gtao, scene) {
    const skip = (o) => {
      const ud = o.userData;
      if (ud) {
        if (ud.noAO === true) return true;
        if (ud.aoOccluder === true) return false;
      }
      if (o.isPoints || o.isLine || o.isLineSegments || o.isLineLoop || o.isSprite) return true;
      const m = o.material;
      if (!m) return false;
      const list = Array.isArray(m) ? m : [m];
      for (const mat of list) {
        if (mat.transparent === true) return true;
        if (mat.depthWrite === false) return true;
        if (mat.blending !== undefined && mat.blending !== THREE.NormalBlending) return true;
      }
      return false;
    };

    const hidden = [];
    const inner = gtao.render.bind(gtao);
    gtao.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
      hidden.length = 0;
      scene.traverseVisible((o) => {
        if (o !== scene && skip(o)) { o.visible = false; hidden.push(o); }
      });
      try {
        inner(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      } finally {
        for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
      }
    };
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (this.composer) {
      const dpr = this.renderer.getPixelRatio();
      // MUST come before setSize. EffectComposer keeps its OWN pixel ratio,
      // captured once at construction, and sizes every intermediate render
      // target by it. Without this line, changing the renderer's pixel ratio
      // only rescales the final blit to the canvas: the scene, the AO prepass
      // and the whole post chain keep rendering at the original resolution, so
      // the frame costs exactly what it did before. That is precisely what the
      // adaptive controller measured — it walked all the way down to its 0.6
      // clamp for zero milliseconds of gain.
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
      this._size.set(w * dpr, h * dpr);
      if (this.passes.grade) this.passes.grade.uniforms.uResolution.value.copy(this._size);
      if (this.passes.dof) this.passes.dof.setSize(this._size.x, this._size.y);
      if (this.passes.bloom) this.passes.bloom.setSize(w, h);
    }
  }

  render(elapsed, dt) {
    const g = this.passes.grade;
    if (g) {
      g.uniforms.uTime.value = elapsed;
      // decay any transient screen shake / flash driven by gameplay
      g.uniforms.uFlash.value = Math.max(0, g.uniforms.uFlash.value - dt * 2.2);
    }
    const gr = this.passes.godrays;
    // Anchor the shafts to a light source that is actually ON SCREEN.
    //
    // The key light cannot be used here, and this is geometric rather than a
    // tuning miss: the camera pitches ~52 degrees down, so working the frustum
    // back through the framing puts the sun in view only if it sits below
    // about -7.5 degrees elevation — i.e. underneath the horizon, lighting the
    // board from below. No key elevation is both usable and visible. Measured
    // live, the key projected to (36.8, 114.9) in uv space: 36 screen-widths
    // right and 114 frame-heights up. The pass was firing zero pixels.
    //
    // The environment exposes `godRayAnchor` — the breach, a genuine in-frame
    // emitter — which is the correct thing for screen-space shafts to radiate
    // from anyway.
    if (gr && gr.enabled) gr.track(this.godRayAnchor ?? this._keyLight, this.camera);

    this.renderer.info.reset();
    this.composer.render(dt);
  }

  /** Gameplay hook: full-screen colour flash (leak damage, boss spawn...). */
  flash(intensity = 1, color = [1, 0.25, 0.2]) {
    const g = this.passes.grade;
    if (!g) return;
    g.uniforms.uFlash.value = Math.min(1.5, g.uniforms.uFlash.value + intensity);
    g.uniforms.uFlashColor.value.set(...color);
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; }

  /** Debug toggles used by the screenshot harness / QA agents. */
  setPass(name, on) { if (this.passes[name]) this.passes[name].enabled = !!on; }
  setGodRays(on) { this.setPass('godrays', on); }
}

/**
 * Final grade. Runs after bloom and DOF so the grain and aberration sit on the
 * composite, which is where a real camera puts them.
 *
 * The look: cool blue-violet lift so shadows never crush to pure black (G7),
 * a warm gain so the key light stays golden, a soft shoulder that rolls the
 * top end off before ACES can clip it to white, and a fine-grained luminance
 * weighted grain that is perceptible at 200% and gone at 100%.
 */
const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    // R6 (day relight). Two critics named the vignette as "doing the art
    // direction's job" and "hiding the absence of environment". It was: at 0.46
    // with an 0.88 mix the frame corner rendered at 34% of its true value, i.e.
    // a quarter of the image was being deleted rather than shaped. Now 0.22 /
    // 0.72 => corner at ~91%. Still a lens falloff, no longer a black frame.
    uVignette: { value: 0.22 },
    uGrain: { value: 0.026 },
    uAberration: { value: 1.0 },
    // 2.95 -> 1.35. The relight that fixed the frame's value range also chased a
    // "mean saturation above 50%" target I had written into Art Bible law 7, and
    // hit it exactly (52.3%) with this multiply near 3.0. The frame came out
    // fluorescent: grass and road read as coloured plastic with no material left
    // in them. That target was wrong and has been removed from the law.
    //
    // The reference's ~55% frame-mean saturation is a SYMPTOM of carrying many
    // differently-coloured materials in one shot (sand, timber, cloth, foliage,
    // painted metal, stone). A global multiply instead raises the few large flat
    // ground areas we do have, uniformly — which is precisely how you get
    // fluorescence without richness. Cause and effect were inverted.
    //
    // Swept against images, not the number (tools/scratch/sat-sweep.mjs, output
    // in shots/sat/). 2.95/2.40/2.05 are all visibly radioactive; 1.35 lands the
    // grass, road and stone back on their own materials while leaving towers and
    // VFX clearly the most saturated things in frame (law 4). Frame-mean falls to
    // ~27.6%, and that is accepted: chroma comes back via distinct material
    // albedos, which is terrain/environment work, never via this knob.
    uSaturation: { value: 1.35 },
    // How much of the saturation gain survives on already-vivid pixels (1.0 =
    // a plain linear multiply). See the chroma rolloff in the fragment shader.
    uSatRolloff: { value: 0.50 },
    // (shadow, highlight) ends of the ACES pre-compensation ramp.
    uSatLuma: { value: new THREE.Vector2(0.96, 1.08) },
    // 1.03 pivoted around 0.18 linear, which pushed everything below mid-grey
    // DOWN — the wrong direction for a frame that is 67% below L=64.
    uContrast: { value: 1.0 },
    // Shadows keep colour and never reach neutral black (G7). R6 raises the
    // lift 4x, and it now holds the shadow floor that the flat AmbientLight
    // used to hold (see Lighting.js) — a black point set here costs no chroma
    // in the mid-ground, whereas one set with an ambient light flattens
    // everything it touches.
    //
    // It is also far LESS blue-violet than before, and that is a measured
    // choice rather than a taste one. At 4x strength the old blue-violet ratio
    // pushed the board's mean hue to 335 deg and the surround's to 198, i.e.
    // 137 deg of hue opposition against the 86-119 the board:surround
    // relationship is specified at. Flattening the lift toward neutral brings
    // that to 113 deg and lets the grass read green instead of cyan. The cool
    // shadow COLOUR is still there — it comes from the fill/rim/hemi lights,
    // which is where it belongs; the lift only sets the floor.
    uLift: { value: new THREE.Vector3(0.070, 0.071, 0.078) },
    // R6: 1.0 -> 1.30, i.e. a real contrast expansion in linear. This is what
    // keeps the board reading as the brightest region once the surround is no
    // longer sitting in the dark. Note it CANNOT do that job alone: gamma also
    // deepens the shadows (measured: 39% of frame below L=64 at gamma 1.40,
    // against law 7's 30% ceiling), and cancelling that with lift cancels the
    // separation right back out. The separation had to come from the key being
    // dominant; this only sharpens it.
    uGamma: { value: new THREE.Vector3(1.300, 1.307, 1.339) },
    uGain: { value: new THREE.Vector3(1.035, 1.0, 0.965) },
    // R6: 0.82 -> 0.60. The knee must sit ABOVE the lit plate and BELOW the
    // emitters, and the day relight moved both. Post-gamma the plate now lands
    // near 0.26, so 0.60 clears it comfortably while catching tower cores and
    // VFX far earlier than before — which is what stops them bleaching to white
    // at this exposure. Verified by eye, not by number: at 1.15 the fire and
    // light towers went white-hot and lost hue; at 0.60 they hold their colour.
    // Law 4 — saturation carries readability, brightness does not.
    uShoulder: { value: 0.60 },   // where the highlight roll-off starts
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Vector3(1, 0.25, 0.2) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberration, uSaturation, uContrast,
                  uShoulder, uFlash, uSatRolloff;
    uniform vec2 uSatLuma;
    uniform vec2 uResolution;
    uniform vec3 uLift, uGamma, uGain, uFlashColor;
    varying vec2 vUv;

    // Interleaved gradient noise - cheap, temporally stable enough, no texture.
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot(centred, centred);

      // Lateral chromatic aberration: scales with r^2 like a real lens, and is
      // clamped to well under a pixel at the very corners.
      float ca = uAberration * r2 * 0.0028;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + centred * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - centred * ca).b;

      // --- Lift / gamma / gain (ASC-CDL shaped) ---------------------------
      col = col * uGain + uLift;
      col = pow(max(col, 0.0), uGamma);

      // --- Highlight shoulder ---------------------------------------------
      // Compresses everything above uShoulder into a soft asymptote so ACES
      // never receives a value that clips flat to 1,1,1 (gate G7).
      vec3 over = max(col - uShoulder, 0.0);
      col = min(col, uShoulder) + over / (1.0 + over * 0.9);

      // Contrast around scene-referred mid grey.
      col = (col - 0.18) * uContrast + 0.18;

      // Saturation in Rec.709 luma, with a touch less in the deep shadows so
      // the cool lift reads as air rather than as a blue cast.
      //
      // R6 — ACES PRE-COMPENSATION. This pass runs BEFORE OutputPass, i.e.
      // before tonemapping, and the ACES curve desaturates progressively as
      // values rise. Measured: the round-6 day relight raised mean luminance
      // 55 -> 86 and saturation FELL 37.9% -> 34.9%, because everything the
      // relight brightened was handed to the part of the curve that eats
      // chroma. So the boost is now ramped by luma: near-neutral in the deep
      // shadows (where the cool lift must not become a blue cast) and strongest
      // through the upper mids, which is exactly where ACES will take it back
      // out. Law 4 — saturation carries readability, brightness does not.
      // A flat multiply is the wrong shape here, and this was measured rather
      // than assumed. Binned by region, our frame ran S35-48 where the
      // reference runs S51-70, while our >80% chroma bucket was already at
      // reference level. A linear boost scales the pixels that are ALREADY
      // vivid hardest in absolute terms, so cranking it to reach the mids
      // turned the tower emissives and the dirt road fluorescent long before
      // the grass and stone got there. So the gain rolls off with existing
      // chroma: strongest on the near-neutral mid-ground that actually needs
      // it, gentlest on emitters, which need none. Still monotonic in chroma,
      // so the board-lowest / towers-highest ordering of law 4 is preserved.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 dev = col - vec3(luma);
      float chroma = length(dev) / max(luma, 1e-3);
      float lumaW   = mix(uSatLuma.x, uSatLuma.y, smoothstep(0.01, 0.42, luma));
      float chromaW = mix(1.0, uSatRolloff, smoothstep(0.30, 1.25, chroma));
      float satW = 1.0 + (uSaturation - 1.0) * lumaW * chromaW;
      col = vec3(luma) + dev * satW;

      // Gameplay flash.
      col += uFlashColor * uFlash * 0.35;

      // Vignette - smooth, natural falloff, slightly warm-shifted at the edge
      // so the darkening reads as lens falloff and not as a black frame.
      float vig = smoothstep(1.02, 0.16, r2 * uVignette * 3.2);
      col *= mix(1.0, vig, 0.72);

      // Film grain, luminance-weighted so blacks stay clean.
      float g = ign(gl_FragCoord.xy + fract(uTime) * 1024.0) - 0.5;
      col += g * uGrain * (0.22 + 0.78 * sqrt(max(luma, 0.0)));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export { GradeShader };
