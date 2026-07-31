import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Screen-space radial light shafts anchored to the key light.
 *
 * DISABLED BY DEFAULT — and this time the presets agree with the sentence.
 *
 * The Environment agent adds in-scene volumetric haze / shafts. Running both
 * double-counts the same physical phenomenon and the shadows go milky, so this
 * pass exists, is tuned, and is left off.
 *
 * ## The defect that made it worth writing this down
 *
 * The preset flags said `godrays: true` for `ultra` and `high` while this
 * docblock said they were false, so nobody ever ablated the pass. It cost three
 * rounds. A row of element-coloured blobs sat on the surround, outside the
 * board, and was attributed in turn to the ground fog, to the creeps, to the
 * tower ground-glow pools, and finally to the tower geometry itself — because
 * every ablation performed was on WORLD objects, and hiding the towers did make
 * it go away. The towers were the source; this pass was the brush.
 *
 * The cause is structural. A screen-space radial god-ray pass is only valid if
 * its source buffer contains THE LIGHT AND NOTHING ELSE. This one brightpasses
 * `tDiffuse` — the entire composite — at `uThreshold`, and tower emissives are
 * the brightest thing in the frame by a wide margin. So it faithfully smeared
 * the towers outward along rays from the breach. Turning down the threshold, the
 * weight or the exposure cannot fix that; it only makes the wrong thing fainter.
 *
 * The real fix is an occlusion mask: render a source buffer in which every
 * geometry pixel is black and only the light source is lit (a depth prepass, or
 * a second render with all materials overridden), and march THAT. GTAO owns the
 * only depth we currently render and does not publish it, so that is real work
 * rather than a uniform tweak.
 *
 * `uSourceRadius` below is the cheap approximation, not the real fix: it
 * restricts the brightpass to a disc around the projected light, encoding the
 * assumption an unmasked pass makes implicitly anyway — that the bright thing
 * near the light IS the light. It stops the pass being a landmine if someone
 * flips a preset again. It does not make the pass correct.
 */
const GodRaysShader = {
  name: 'GodRaysShader',
  uniforms: {
    tDiffuse: { value: null },
    uLightPos: { value: new THREE.Vector2(0.5, 1.15) }, // uv space
    uDensity: { value: 0.62 },
    uWeight: { value: 0.22 },
    uDecay: { value: 0.94 },
    uThreshold: { value: 1.1 },
    uExposure: { value: 0.55 },
    /**
     * 0 when the shafts must not be drawn at all: the sun is behind the camera,
     * or its projected origin has drifted so far off-screen that the radial
     * direction stops being meaningful. `track()` drives this.
     */
    uIntensity: { value: 0.0 },
    /**
     * Radius, in uv, of the disc around `uLightPos` that may contribute to the
     * shafts. Anything further out is not the light and must not be smeared.
     * See the defect note in this file's docblock.
     */
    uSourceRadius: { value: 0.34 },
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
    uniform vec2 uLightPos;
    uniform float uDensity, uWeight, uDecay, uThreshold, uExposure, uIntensity;
    uniform float uSourceRadius;
    varying vec2 vUv;

    const int STEPS = 24;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);

      if (uIntensity <= 0.001) {
        gl_FragColor = base;
        return;
      }

      vec2 delta = (vUv - uLightPos) * (uDensity / float(STEPS));
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        uv -= delta;
        // Samples that walk off-screen must contribute NOTHING. Clamping the
        // uv instead re-reads the border texel on every remaining step, which
        // smears the frame edge into hard repeating streaks across the image.
        vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
        float valid = inside.x * inside.y;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        s = max(s - uThreshold, 0.0);
        // Only the neighbourhood of the light may act as a source. Without this
        // the pass rakes every bright pixel in the frame — tower emissives above
        // all — outward along the rays. Squared falloff so the disc has no rim.
        float near = 1.0 - smoothstep(uSourceRadius * 0.45, uSourceRadius,
                                      length(uv - uLightPos));
        acc += s * illum * uWeight * valid * near * near;
        illum *= uDecay;
      }

      // Fade toward the frame centre so gameplay never sits in a haze wash.
      float d = length(vUv - 0.5);
      acc *= uExposure * uIntensity * smoothstep(0.12, 0.62, d);

      gl_FragColor = vec4(base.rgb + acc, base.a);
    }
  `,
};

export class GodRaysPass extends ShaderPass {
  constructor() {
    super(GodRaysShader);
    this._p = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._toLight = new THREE.Vector3();
  }

  /**
   * Project the key light into uv space each frame, and decide whether shafts
   * are physically meaningful at all this frame.
   *
   * Two failure modes this guards against:
   *  - The sun is BEHIND the camera. `Vector3.project` divides by w, so a point
   *    behind the near plane comes back with mirrored x/y — the shafts would
   *    radiate from a plausible-looking but completely wrong origin.
   *  - The sun is far outside the frame. The radial direction degenerates and
   *    the effect reads as a directional smear rather than light.
   */
  track(light, camera) {
    if (!light || !camera) { this.uniforms.uIntensity.value = 0; return; }

    light.getWorldPosition(this._p);
    // Directional lights sit at an arbitrary distance; normalise the direction
    // and push it far away so the shaft origin is stable as the camera orbits.
    if (light.isDirectionalLight) {
      this._p.normalize().multiplyScalar(300);
      this._p.x += camera.position.x;
      this._p.z += camera.position.z;
    }

    // Reject anything behind the camera before trusting the projection.
    camera.getWorldDirection(this._fwd);
    this._toLight.copy(this._p).sub(camera.position);
    if (this._toLight.dot(this._fwd) <= 0) {
      this.uniforms.uIntensity.value = 0;
      return;
    }

    this._p.project(camera);
    const u = this._p.x * 0.5 + 0.5;
    const v = this._p.y * 0.5 + 0.5;
    this.uniforms.uLightPos.value.set(u, v);

    // Full strength on screen, fading out over one frame-width of margin.
    const outside = Math.max(0, -u, u - 1, -v, v - 1);
    this.uniforms.uIntensity.value = Math.max(0, 1 - outside / 0.85);
  }
}

export { GodRaysShader };
