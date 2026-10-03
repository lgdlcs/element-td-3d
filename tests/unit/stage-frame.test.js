/**
 * `frameField` frames the same way every time it is asked.
 *
 * The host calls a view's `layout()` on every resize, on the same camera. The
 * bisection used to run under the near/far planes the PREVIOUS call left on the
 * camera, so every probe past the old far plane "failed" and every second call
 * parked the camera at the top of the search range, 320 units away: a resize
 * during a rite shrank the whole scene to a postage stamp, and the next resize
 * fixed it again.
 *
 * Pure three.js maths, no WebGL: node environment.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { FRAMES, frameField } from '../../src/minigames/Stage3D.js';

describe('frameField', () => {
  it('returns the same distance on a second call on the same camera', () => {
    for (const tilt of [-15, -24, -30]) {
      const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
      const o = { fov: 40, tilt, yaw: 8, margin: 0.05 };
      const first = frameField(cam, FRAMES.upright, 16 / 9, o);
      const at = cam.position.clone();
      const second = frameField(cam, FRAMES.upright, 16 / 9, o);
      expect(second, `tilt ${tilt}`).toBeCloseTo(first, 6);
      expect(cam.position.distanceTo(at), `tilt ${tilt}`).toBeLessThan(1e-6);
      expect(first).toBeLessThan(25);
    }
  });
});
