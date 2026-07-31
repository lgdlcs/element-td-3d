import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Diorama depth of field ("tilt-shift").
 *
 * Why not a depth-buffer DOF? Three's BokehPass re-renders the whole scene
 * with a depth material, which on this board costs a second ~900 draw calls -
 * a third of our 8ms budget for an effect that is meant to be barely
 * perceptible. Because this is a fixed-pitch RTS camera looking at a plane,
 * screen-space Y *is* depth: the far rim of the board is always at the top of
 * the frame and the near rim always at the bottom. A tilt-shift CoC therefore
 * reproduces the real defocus almost exactly for zero geometry cost, with no
 * depth discontinuity artefacts and no ghosting on moving creeps.
 *
 * The focus band is placed at the board centre and is deliberately wide, so
 * every gameplay-critical element (towers, creeps, health bars) stays sharp;
 * only the far rim, the abyss beyond it and the extreme near corner soften.
 */
const DepthOfFieldShader = {
  name: 'DepthOfFieldShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uFocus: { value: -0.06 },     // ndc.y of the sharp band centre
    // The auto-framed board occupies ndc.y -0.97 .. +0.61, so the far ramp is
    // placed just under its far rim and the near ramp just above the near one:
    // the play surface stays sharp, the abyss beyond it falls away.
    uFarStart: { value: 0.52 },   // ndc.y where far defocus begins
    uNearStart: { value: -0.74 }, // ndc.y where near defocus begins
    uFarMax: { value: 5.0 },      // px @1080p
    uNearMax: { value: 2.2 },
    uStrength: { value: 1.0 },
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
    uniform vec2 uResolution;
    uniform float uFocus, uFarStart, uNearStart, uFarMax, uNearMax, uStrength;
    varying vec2 vUv;

    void main() {
      float y = vUv.y * 2.0 - 1.0;

      // Circle of confusion, in pixels, from the tilt-shift focus band.
      float far  = smoothstep(uFarStart,  0.95, y);
      float near = smoothstep(-uNearStart, 1.00, -y);
      float coc  = (far * uFarMax + near * uNearMax) * uStrength;

      // Reference resolution 1080p so the look is DPI independent.
      coc *= uResolution.y / 1080.0;

      // Most of the frame is inside the focus band; this early-out keeps whole
      // quads off the blur path, which is where the cost actually lives.
      if (coc < 0.40) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

      vec2 px = coc / uResolution;

      // 9-tap golden-angle spiral: at <=3px radius this is indistinguishable
      // from 13 taps and ~30% cheaper.
      vec3 sum = texture2D(tDiffuse, vUv).rgb;
      float w = 1.0;
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        float a = fi * 2.39996323;
        float r = sqrt((fi + 0.5) / 8.0);
        vec2 o = vec2(cos(a), sin(a)) * r;
        float tw = 1.0 - 0.35 * r;
        sum += texture2D(tDiffuse, vUv + o * px).rgb * tw;
        w += tw;
      }
      gl_FragColor = vec4(sum / w, 1.0);
    }
  `,
};

export class DepthOfFieldPass extends ShaderPass {
  constructor() {
    super(DepthOfFieldShader);
  }

  setSize(w, h) { this.uniforms.uResolution.value.set(w, h); }
}

export { DepthOfFieldShader };
