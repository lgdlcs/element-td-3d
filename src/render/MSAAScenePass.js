import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Renders the scene into a PRIVATE multisampled target, then resolves it once
 * into the post chain — so geometry keeps 4x coverage antialiasing while the
 * post chain itself stops being multisampled.
 *
 * WHY
 *
 * `EffectComposer` allocates renderTarget1 and renderTarget2 from one template,
 * so setting `samples: 4` for the scene render also made **every fullscreen post
 * pass** write 4 samples and pay a full-screen colour resolve. The post chain
 * does not benefit from multisampling at all: a fullscreen quad has no interior
 * edges to antialias. We were paying coverage AA on eight passes to get it on one.
 *
 * Measured at `high`, 1600x900, pixelRatio 1, 21 towers + wave 21, via a 2x2
 * factorial (tools/scratch/interact.mjs):
 *
 *   MSAA 4x everywhere ......... 59.6 ms median / 81.8 ms p95
 *   MSAA off everywhere ........ 40.5 ms median / 53.3 ms p95   (24.2 ms)
 *
 * Of that 24.2 ms, ~12.5 ms is the post-chain half and is free of any visual
 * cost — measured twice by independent implementations (+12.5 and +13.0). The
 * other ~11 ms is coverage AA on the scene render itself, which is NOT free:
 * RenderPipeline's AA note records that MSAA was adopted precisely because SMAA
 * alone does not fix thin geometry, and this content is full of it — tower rings,
 * rim runes, grid lines, projectile trails. Those alias and crawl in motion
 * without coverage AA, so that half stays behind a preset knob.
 *
 * COST: one extra fullscreen copy, which is what buys back the eight resolves.
 *
 * Deliberately NOT relying on the composer's depth: nothing downstream reads it
 * (GTAOPass builds its own depth+normal G-buffer with an override material), so
 * the private target owns the only depth buffer that matters.
 */
export class MSAAScenePass extends Pass {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {number} samples MSAA sample count for the scene render
   * @param {THREE.Vector2} size drawing-buffer size in device pixels
   */
  constructor(scene, camera, samples, size) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.clear = true;
    this.needsSwap = false;   // we write readBuffer in place, like RenderPass

    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples,
      depthBuffer: true,
    });

    // A bare passthrough. Not CopyShader: this must not touch colour in any way
    // — no tone mapping, no encoding, no clamp. The chain is still scene-referred
    // linear HDR at this point and bloom's brightpass reads values above 1.
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.target.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);

    // Reading `.texture` of a multisampled target resolves it, once.
    this.material.uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);

    renderer.autoClear = oldAutoClear;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
