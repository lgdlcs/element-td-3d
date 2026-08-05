import * as THREE from 'three';
import { Sky } from './env/Sky.js';
import { Backdrop } from './env/Backdrop.js';
import { GroundFog } from './env/Atmosphere.js';
import { Motes } from './env/Motes.js';
import { Breach } from './env/Breach.js';

/** Direction of the key light. Kept in sync with Lighting.js (KEY_POS).
 *  Azimuth -48 deg, elevation 36 deg — inside the camera's visible window. */
export const KEY_DIR = new THREE.Vector3(27.1, 29.4, -30.1).normalize();

/** Fog colour — must match the sky just above the horizon or distant
 *  geometry looks like it was cut out and pasted on. */
export const FOG_COLOR = 0x151c34;

/**
 * Everything outside the arena: sky, background geometry, atmosphere, motes.
 *
 * OWNED BY THE ENVIRONMENT AGENT. `Game.js` only ever calls the constructor,
 * `update(dt, elapsed, camera)` and `dispose()`; keep that contract stable.
 *
 * Layout (draw calls in brackets):
 *   sky dome            [1]  warm/cool split, nebula bridge, stars
 *   breach              [2]  luminous rift + light shafts (G5)
 *   surround           [28]  continuous heightfield to r=300 + clustered props
 *   ground fog          [1]  instanced billboards
 *   motes               [1]  GPU-animated dust + embers
 *
 * `forge` (molten sea) and `cloud strata` were removed in round 4 — both
 * furnished a void that no longer exists, and opaque ground occluded them
 * completely.
 */
export class Environment {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'environment';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    // Take over the atmosphere from Game's placeholder values.
    scene.background = null;                 // the sky dome is the background
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0022);

    const budget = quality?.particleBudget ?? 20000;
    // Round 3: capped harder. 1600 motes at the corrected sprite size covered
    // the whole frame in confetti and buried the board. The number that reads
    // as "the air is alive" without competing with gameplay is ~500-700.
    const moteCount = Math.max(200, Math.min(700, Math.round(budget * 0.022)));
    const fogCount = budget >= 9000 ? 130 : 60;

    this.sky = new Sky(KEY_DIR);
    this.group.add(this.sky.mesh);

    // The molten sea below and the cloud strata are GONE as of round 4.
    //
    // Both existed to furnish the void under a floating platform. Round 4
    // deleted the void — the board is now cut into continuous terrain that
    // runs off all four edges of frame (Art Bible §0 law 1) — so opaque
    // ground occludes both of them completely. Measured at 3,552 triangles
    // and 2 draw calls for exactly zero pixels.
    //
    // `Forge` and `CloudStrata` remain exported from Atmosphere.js; nothing
    // constructs them. Delete there once round 4 has settled.

    // Light shafts (gate G5) + the diegetic source of the warm key.
    this.breach = new Breach(quality);
    this.group.add(this.breach.group);
    /** Object3D the screen-space GodRaysPass can track. See Breach.js. */
    this.godRayAnchor = this.breach.anchor;

    this.backdrop = new Backdrop(quality);
    this.group.add(this.backdrop.group);

    this.groundFog = new GroundFog(fogCount);
    this.group.add(this.groundFog.mesh);

    this.motes = new Motes(moteCount);
    this.group.add(this.motes.points);

    // `potato` drops the decor layer: the off-board backdrop, the ground fog and
    // the motes. Sky and breach stay — they are the horizon and the diegetic
    // key source, and without them the frame reads as a void rather than as a
    // cheaper version of the same place.
    //
    // Kept CONSTRUCTED and merely hidden, not skipped, so update() stays
    // unconditional and the governor can put them back at runtime without
    // building anything mid-frame.
    if (quality?.envDetail === false) {
      this.backdrop.group.visible = false;
      this.groundFog.mesh.visible = false;
      this.motes.points.visible = false;
    }

    this.group.updateMatrixWorld(true);
    this._pixelRatio = 1;
  }

  /** Renderer pixel ratio feeds point-sprite sizing; harmless if never called. */
  setPixelRatio(r) { this._pixelRatio = r; }

  update(dt, elapsed, camera) {
    if (!camera) return;
    const pr = this._pixelRatio;
    this.sky.update(elapsed, camera);

    this.breach.update(elapsed);

    this.backdrop.update(dt, elapsed, pr);
    this.groundFog.update(elapsed);
    this.motes.update(elapsed, pr);
  }

  dispose() {
    this.sky.dispose();

    this.breach.dispose();

    this.backdrop.dispose();
    this.groundFog.dispose();
    this.motes.dispose();
    this.scene.remove(this.group);
  }
}
