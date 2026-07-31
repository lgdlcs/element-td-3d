import * as THREE from 'three';
import { buildSkyEquirect } from './env/skyHDR.js';

/* ==================================================================
 * ROUND 2 — the key light moved, and that is the single most important
 * change in this file. Measured facts about the gameplay camera:
 *
 *   position   ~(-7, 57, 42)      polar pitch  ~52 deg down
 *   fov 40 / 16:9                 => frame spans
 *   elevation  -27 deg (top edge) .. -72 deg (bottom edge)
 *   azimuth   -127 deg (left)     .. -34 deg (right)
 *
 * The ENTIRE frame is below the horizon, and the visible azimuth window is
 * only 93 degrees wide. Round 1 put the key at azimuth +37 deg — i.e. 118 deg
 * away from the centre of frame, essentially behind the camera. Every warm
 * cue the sky painted "in the key azimuth" was therefore drawn in a part of
 * the world the player never looks at, which is the mechanical reason the
 * frame read 90% cool blue.
 *
 * The key now sits at azimuth -48 deg, elevation 40 deg: a three-quarter
 * BACK-right key inside the visible window. Consequences:
 *   - its warm sky glow now lands in the top-right of frame,
 *   - shadows rake down-left across the board instead of straight at camera,
 *   - every tower and creep gets a warm top-back edge against a cool floor.
 * ================================================================== */

/** Key light direction (world-space position of the sun relative to origin). */
export const KEY_POS = new THREE.Vector3(25.6, 32.1, -28.5);

/** Unit key direction, exported so the sky/breach can align to it exactly. */
export const KEY_DIR_V = KEY_POS.clone().normalize();

/**
 * Cinematic rig tuned so the BOARD is the brightest region of the frame.
 *
 * Round 1's rig failed the project's own pitch — "the board is the only lit
 * thing in the world, and it glows" — because the cool terms (rim 2.40 +
 * fill 0.70 + hemi 0.46 + ambient 0.80 + env 0.95) summed to more than the
 * key. The board came out a flat blue-grey at L=50 while the backdrop ruins
 * sat at L=46: a 8% separation, which is no separation at all.
 *
 * Round 2 inverts the balance: one dominant warm key, everything cool cut to
 * roughly a third. The cool terms still exist -- they are what keeps shadow
 * interiors blue instead of black (G7) and what rims every silhouette -- but
 * they are now clearly subordinate.
 *
 *   key    — warm amber sun, 36 deg elevation, azimuth -48. Only shadow caster.
 *   fill   — cool sky bounce opposite the key, low, no shadows.
 *   rim    — cool back light, low and behind-left, silhouette separation.
 *   ember  — WARM UP-LIGHT from directly below, standing in for the molten
 *            abyss under the platform. This is the second half of the
 *            complementary scheme: the arena is lit warm from above-right and
 *            warm from below, and only the sides are cool.
 *   hemi   — sky/ground ambient. The ground half is now a hot ember brown,
 *            because what is "below" this world is literally glowing.
 *
 * `key` is public because RenderPipeline auto-discovers it for god rays and
 * other systems anchor to it.
 */
export class Lighting {
  constructor(scene, quality) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'lighting';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    const shadowSize = quality.shadowMapSize;

    // --- key ------------------------------------------------------------
    // Hotter and 3x stronger than round 1, because the board has to WIN the
    // frame, not merely be in it. At 40 deg elevation a 10-unit tower throws
    // a 12-unit shadow: long enough to read as raking light, short enough
    // that 21 towers do not turn the board into stripes.
    // Measured effect on the floor: direct term 7.60 * sin(40) = 4.89 against
    // round 1's 2.55 * sin(48.8) = 1.92, i.e. 2.5x more direct light, while
    // every ambient/fill term was cut roughly in half.
    // ROUND 6 — RELIT FOR DAY (law 7). Measured against the whole reference set
    // with `tools/scratch/lum-vs-ref.mjs`: we sat at mean L=55.2 / p90=104 /
    // 67.3% of frame below L=64 / 37.9% saturation, against a reference mean of
    // 115.4 / p90 ~205 / 26.5% / 55.2%. Our brightest decile was darker than the
    // reference median in nine reference frames out of nine. Three blind critics
    // called that "no key light"; the key was always there, the whole frame just
    // sat in the bottom quarter of the range, so nothing had a readable lit side
    // and no material could be read.
    //
    // 7.60 -> 34.0, and the rig is now KEY-DOMINANT rather than key-plus-a-lot-
    // of-ambient. That distinction was measured, not stylistic. The first pass
    // at this raised every term together (key 10.4, hemi 2.75, ambient 1.05,
    // env 2.0) and hit all four of law 7's numbers — but it collapsed the
    // board:surround luminance ratio from 1.73 to 1.35, because board and
    // surround are both horizontal ground and a broad ambient lifts them
    // equally, while ACES compresses the brighter one harder. Moving that same
    // energy into the key restored the ratio to 1.64 at identical frame
    // brightness: the board is open and sunlit, the surround is sloped and
    // partly self-shadowing, so only a DIRECTIONAL term can tell them apart.
    // Grade contrast cannot substitute for this — see RenderPipeline's uGamma.
    //
    // Slightly less orange than round 2's 0xffd096: at this intensity that hue
    // pushed the flagstone plate straight into amber.
    const key = new THREE.DirectionalLight(0xffdcaa, 34.0);
    key.position.copy(KEY_POS);
    key.castShadow = true;
    key.shadow.mapSize.set(shadowSize, shadowSize);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 190;
    // Platform is 52 x 40; the lower sun needs a wider frustum than round 1's
    // 40 or the far corner shadows are clipped off mid-board.
    const ext = 46;
    key.shadow.camera.left = -ext;
    key.shadow.camera.right = ext;
    key.shadow.camera.top = ext;
    key.shadow.camera.bottom = -ext;
    key.shadow.bias = -0.00035;
    // Lower sun => more grazing incidence => more acne, so normalBias rises.
    key.shadow.normalBias = 0.030;
    key.shadow.radius = 2.6;
    key.shadow.blurSamples = 16;
    key.shadow.camera.updateProjectionMatrix();
    this.group.add(key, key.target);
    this.key = key;

    // --- fill (cool, opposite the key, keeps shadows blue) ----------------
    // Its only job is the colour and readability of shadow interiors.
    // R6: 0.34 -> 0.85, and the hue went from 0x4a7ae0 to a much PALER blue.
    // Counter-intuitive but measured: a strongly blue fill lands on green grass
    // and warm stone as a near-complementary, which desaturates them toward
    // grey. Round 2's note that "pale ambient arrives as neutral" was true when
    // ambient was the dominant term; with a key this dominant the opposite
    // holds, and neutralising the cool terms RAISED whole-frame saturation.
    const fill = new THREE.DirectionalLight(0x9fbdf2, 0.85);
    fill.position.set(-34, 15, 30);
    this.group.add(fill);
    this.fill = fill;

    // --- rim / back (separation) -----------------------------------------
    // At azimuth -128 (the left edge of the visible window) so it is genuinely
    // opposite the key ON SCREEN rather than merely opposite in world space.
    // R6 holds it at ~1.7: with the key at 34 it stays clearly subordinate, and
    // raising it with everything else only flattened the lit/unlit split.
    const rim = new THREE.DirectionalLight(0x63b0ff, 1.70);
    rim.position.set(-27.4, 9.4, -34.6);
    this.group.add(rim);
    this.rim = rim;

    // --- ember (warm up-light from the molten abyss below) -----------------
    // Round 1 had this at 0.34 and called it a "kicker". It is now a real
    // member of the scheme: it is what makes the platform rim, the underside
    // of every floating shard and the base of the ground fog read amber.
    const ember = new THREE.DirectionalLight(0xff9a48, 1.10);
    ember.position.set(6, -30, 14);
    this.group.add(ember);
    this.ember = ember;
    this.kicker = ember;   // legacy alias

    // --- ambient / hemisphere ---------------------------------------------
    // Sky term cool, GROUND term hot: there is a molten glow under this world
    // and every down-facing surface should know about it.
    // R6: 0.34 -> 1.25, and the sky half is now pale rather than saturated blue
    // (see the fill above for why). What lifts the frame out of night is the
    // key, not this; hemi's job is to keep the shadow side and the away-facing
    // slopes readable. It is deliberately the hemisphere and not the flat
    // ambient that carries the ambient budget: hemi is directional (sky above,
    // ember below), so it still models a lit side and a dark side, whereas flat
    // ambient at this level washes the frame into exactly the "middle-value
    // mush with no dark anchor" three critics named. The ground half stays a
    // hot ember brown - what is below this world is genuinely glowing.
    const hemi = new THREE.HemisphereLight(0xa8c8f5, 0x9c4a18, 1.25);
    this.group.add(hemi);
    this.hemi = hemi;

    // The black point. G7 says shadows must keep colour and detail, so this
    // term exists purely to stop the darkest stone reaching 0 on any channel.
    // R6: 0.46 -> 0.35. It went DOWN. Flat ambient is the one term that cannot
    // model a lit side, so it is the first thing to cut when the key rises; the
    // shadow floor is now held by the grade's lift instead, which does the same
    // job without also flattening the mid-ground.
    const amb = new THREE.AmbientLight(0x5a6f9e, 0.35);
    this.group.add(amb);
    this.ambient = amb;

    this.group.updateMatrixWorld(true);
    this.time = 0;
    this._basePos = KEY_POS.clone();
    this._rimBase = 1.70;
  }

  /**
   * Procedural HDR environment for PBR reflections.
   * Returns the PMREM texture and installs it on the scene.
   */
  buildEnvironment(renderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();

    const sky = buildSkyEquirect(KEY_POS, 512);
    const env = pmrem.fromEquirectangular(sky).texture;
    this.scene.environment = env;
    // Halved from 0.95. The env map is a cool sky; at full strength it was a
    // second ambient light and the biggest single contributor to the blue cast.
    // R6: 0.48 -> 1.05. This is the IBL that gives non-metals their sense of sky
    // and metals anything to reflect. Round 2 halved it to kill a blue cast; the
    // cast was really the *ratio* of env to key, and the key has since risen
    // 4.5x, so it can be restored without the cast returning.
    this.scene.environmentIntensity = 1.05;
    this.envMap = env;
    sky.dispose();
    pmrem.dispose();
    return env;
  }

  update(dt) {
    this.time += dt;
    // Barely-there sun drift: enough that raking shadows creep over a minute,
    // slow enough that you never catch it moving.
    const a = this.time * 0.017;
    this.key.position.set(
      this._basePos.x + Math.sin(a) * 2.4,
      this._basePos.y,
      this._basePos.z + Math.cos(a) * 2.4,
    );
    // Rim breathes very slightly so still frames are never fully dead.
    this.rim.intensity = this._rimBase + Math.sin(this.time * 0.11) * 0.12;
    this.group.updateMatrixWorld(true);
  }
}
