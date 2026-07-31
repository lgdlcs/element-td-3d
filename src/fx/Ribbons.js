import * as THREE from 'three';
import { FX_MAX_LUM } from './Levels.js';

/**
 * Camera-facing tapered ribbons in ONE draw call.
 *
 * A single static index buffer describes `slots × (nodes-1)` quads. Every frame
 * the caller compacts the live ribbons into slots 0..n-1 and we shrink the draw
 * range, so unused slots cost literally nothing.
 *
 * The screen-facing expansion happens in the vertex shader from the spine point
 * plus its neighbour, which means the CPU only ever writes a centre-line — no
 * per-frame billboard maths, no matrix churn.
 *
 * Used for projectile trails and for lightning arcs.
 */
export class RibbonSystem {
  constructor(scene, { slots = 256, nodes = 14, renderOrder = 8, softness = 1.0, gain = 1.0 } = {}) {
    this.slots = slots;
    this.nodes = nodes;
    const V = slots * nodes * 2;

    this.pos = new Float32Array(V * 3);
    this.next = new Float32Array(V * 3);
    this.side = new Float32Array(V);
    this.param = new Float32Array(V * 2); // u (0 head -> 1 tail), half-width
    this.col = new Float32Array(V * 3);

    const geo = new THREE.BufferGeometry();
    const dyn = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', dyn(this.pos, 3));
    geo.setAttribute('aNext', dyn(this.next, 3));
    geo.setAttribute('aSide', dyn(this.side, 1));
    geo.setAttribute('aParam', dyn(this.param, 2));
    geo.setAttribute('aColor', dyn(this.col, 3));

    const idx = new Uint32Array(slots * (nodes - 1) * 6);
    let o = 0;
    for (let s = 0; s < slots; s++) {
      for (let k = 0; k < nodes - 1; k++) {
        const a = (s * nodes + k) * 2;
        const b = (s * nodes + k + 1) * 2;
        idx[o++] = a; idx[o++] = a + 1; idx[o++] = b;
        idx[o++] = b; idx[o++] = a + 1; idx[o++] = b + 1;
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uSoft: { value: softness }, uGain: { value: gain },
        uMaxLum: { value: FX_MAX_LUM },
      },
      vertexShader: /* glsl */`
        attribute vec3 aNext;
        attribute float aSide;
        attribute vec2 aParam;
        attribute vec3 aColor;
        varying float vSide, vU, vFace;
        varying vec3 vC;
        void main() {
          vSide = aSide; vU = aParam.x; vC = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec4 mvN = modelViewMatrix * vec4(aNext, 1.0);
          vec3 d = mvN.xyz - mv.xyz;
          float dl = length(d);
          vec3 dir = dl > 1e-5 ? d / dl : vec3(1.0, 0.0, 0.0);
          vec3 toEye = normalize(-mv.xyz);
          vec3 perp = cross(dir, toEye);
          float pl = length(perp);
          // How side-on the ribbon is. When the spine points at (or away from)
          // the camera this collapses to 0, perp becomes numerically
          // meaningless and neighbouring quads flip — which drew the ribbon as
          // a hard-edged bowtie. Fading on pl removes the artefact and is
          // also just correct: an edge-on ribbon has no projected area.
          vFace = pl;
          perp = pl > 1e-5 ? perp / pl : vec3(0.0, 1.0, 0.0);
          mv.xyz += perp * aSide * aParam.y;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying float vSide, vU, vFace;
        varying vec3 vC;
        uniform float uSoft, uGain, uMaxLum;

        // Hue-preserving emissive ceiling. min(col, vec3(k)) clips the largest
        // channel toward the others, i.e. it desaturates on its way to white,
        // which is the exact failure ART_BIBLE law 4 warns about: saturation is
        // what carries readability, and a per-channel clamp spends it first.
        // Scaling the whole vector by maxL/L holds hue and chroma exactly and
        // only takes level.
        vec3 capLum(vec3 c, float maxL) {
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          return l > maxL ? c * (maxL / l) : c;
        }

        void main() {
          float face = smoothstep(0.02, 0.42, vFace);
          if (face <= 0.001) discard;
          float e = 1.0 - abs(vSide);
          // soft feathered edge with a hot filament down the centre
          float body = pow(max(e, 0.0), uSoft);
          float core = pow(max(e, 0.0), 11.0);
          // clamp(), not (1.0 - vU): vU is a varying, and perspective-correct
          // interpolation does not respect the range the vertex shader wrote.
          // A vU a hair above 1.0 gives pow() a negative base with a
          // NON-INTEGER exponent, which is NaN -- and one NaN fragment entering
          // the bloom pyramid blanks the ENTIRE frame with errors: [] and a
          // normal draw-call count (PITFALLS §9). This shader has been the only
          // unguarded pow in the fx tree; three ablation runs today came back
          // black, and disabling this pass was what brought them back.
          float taper = pow(clamp(1.0 - vU, 0.0, 1.0), 1.15);
          float head = smoothstep(0.30, 0.0, vU);      // hottest at the nose
          float a = (body * 0.72 + core * 0.60) * taper * face;
          if (a <= 0.004) discard;
          // White filament inside a saturated sheath: bright without going soup.
          vec3 col = vC * uGain * (0.95 + core * 1.0 + head * 0.55);
          col = mix(col, vec3(max(max(col.r, col.g), col.b)), core * (0.30 + head * 0.25));
          gl_FragColor = vec4(capLum(col, uMaxLum), a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.castShadow = false;
    this.mesh.userData.__fx = true;
    this.geo = geo;
    this.mat = mat;
    scene.add(this.mesh);
    this.used = 0;
  }

  begin() { this.used = 0; }

  /**
   * @param {Float32Array} pts  flat xyz, index 0 = HEAD (newest)
   * @param {number} count      number of valid points in `pts`
   * @param {number} offset     float offset into `pts`
   * @param {number[]} rgb      linear colour
   * @param {number} width      half-width at the head, tapers to 0 at the tail
   * @param {number} fade       overall brightness 0..1
   */
  push(pts, offset, count, rgb, width, fade = 1) {
    if (this.used >= this.slots || count < 2) return false;
    const s = this.used++;
    const N = this.nodes;
    const base = s * N * 2;
    const r = rgb[0] * fade, g = rgb[1] * fade, b = rgb[2] * fade;

    for (let k = 0; k < N; k++) {
      const src = Math.min(k, count - 1) * 3 + offset;
      const nxt = Math.min(k + 1, count - 1) * 3 + offset;
      const u = k / (N - 1);
      // Comet profile: a narrow nose, a bulge just behind it, then a long
      // pinch to a true point at the tail. This is what stops a ribbon reading
      // as a neon tube.
      const nose = u < 0.18 ? 0.42 + 0.58 * (u / 0.18) : 1;
      const w = k >= count ? 0 : width * nose * Math.pow(1 - u, 1.45);
      for (let sd = 0; sd < 2; sd++) {
        const v = base + k * 2 + sd;
        this.pos[v * 3] = pts[src]; this.pos[v * 3 + 1] = pts[src + 1]; this.pos[v * 3 + 2] = pts[src + 2];
        this.next[v * 3] = pts[nxt]; this.next[v * 3 + 1] = pts[nxt + 1]; this.next[v * 3 + 2] = pts[nxt + 2];
        this.side[v] = sd === 0 ? -1 : 1;
        this.param[v * 2] = u;
        this.param[v * 2 + 1] = w;
        this.col[v * 3] = r; this.col[v * 3 + 1] = g; this.col[v * 3 + 2] = b;
      }
    }
    return true;
  }

  end() {
    const verts = this.used * this.nodes * 2;
    this.geo.setDrawRange(0, this.used * (this.nodes - 1) * 6);
    if (verts > 0) {
      for (const a of ['position', 'aNext', 'aSide', 'aParam', 'aColor']) {
        const at = this.geo.attributes[a];
        // Upload only the slots we actually wrote this frame.
        if (at.clearUpdateRanges) {
          at.clearUpdateRanges();
          at.addUpdateRange(0, verts * at.itemSize);
        }
        at.needsUpdate = true;
      }
    }
  }
}
