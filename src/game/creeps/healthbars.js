import * as THREE from 'three';

/**
 * Instanced, billboarded health bars — one draw call for the whole army.
 *
 * Restyled for legibility without noise:
 *  - hairline capsule, not a chunky box
 *  - only drawn once damaged, and it fades out again when topped up
 *  - a white "damage lag" ghost trails the fill so a hit reads as an event
 *  - boss bars are wider, taller, gold-framed and segmented
 */
export class HealthBarField {
  constructor(capacity) {
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.attributes.position = quad.attributes.position;
    geo.attributes.uv = quad.attributes.uv;

    this.offsets = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.offsets.setUsage(THREE.DynamicDrawUsage);
    this.data.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('offset', this.offsets);
    geo.setAttribute('bardata', this.data); // hp01, ghost01, boss, alpha
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: { uScale: { value: new THREE.Vector2(0.95, 0.105) } },
      vertexShader: /* glsl */`
        attribute vec3 offset;
        attribute vec4 bardata;
        varying vec2 vUv;
        varying vec4 vData;
        uniform vec2 uScale;
        void main() {
          vUv = uv;
          vData = bardata;
          vec2 s = uScale * (1.0 + bardata.z * 1.35);
          vec4 mv = modelViewMatrix * vec4(offset, 1.0);
          // slight perspective compensation: bars never get microscopic
          float d = -mv.z;
          s *= mix(1.0, clamp(d / 45.0, 1.0, 1.7), 1.0);
          mv.xy += position.xy * s;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        varying vec4 vData;

        uniform vec2 uScale;

        // capsule SDF evaluated in aspect-corrected space so the bar is a real
        // rounded bar, not a squashed ellipse.
        float capsule(vec2 p, float t) {
          float aspect = uScale.x / uScale.y;
          vec2 q = vec2((p.x - 0.5) * aspect, p.y - 0.5);
          q.x = abs(q.x);
          float halfLen = max(0.0, aspect * 0.5 - t);
          q.x = max(q.x - halfLen, 0.0);
          return length(q) - t;
        }

        void main() {
          float hp    = clamp(vData.x, 0.0, 1.0);
          float ghost = clamp(vData.y, 0.0, 1.0);
          float boss  = vData.z;
          float alpha = vData.w;
          if (alpha <= 0.001) discard;

          float t = 0.46;                        // capsule half-thickness
          float d = capsule(vUv, t);
          float body = smoothstep(0.03, -0.01, d);
          if (body <= 0.001) discard;

          // inner track, leaving a hairline dark frame
          float inner = smoothstep(0.02, -0.02, d + 0.16);

          vec3 good = vec3(0.42, 1.05, 0.48);
          vec3 warn = vec3(1.15, 0.82, 0.16);
          vec3 bad  = vec3(1.20, 0.20, 0.16);
          vec3 fillCol = hp > 0.5 ? mix(warn, good, (hp - 0.5) * 2.0)
                                  : mix(bad, warn, hp * 2.0);
          if (boss > 0.5) fillCol = mix(vec3(1.25, 0.35, 0.18), vec3(1.35, 0.85, 0.30), hp);

          float isFill  = step(vUv.x, hp);
          float isGhost = step(vUv.x, ghost) * (1.0 - isFill);

          vec3 col = vec3(0.012, 0.013, 0.018);            // empty track
          col = mix(col, vec3(1.0, 0.92, 0.86) * 1.4, isGhost);
          col = mix(col, fillCol * (0.85 + 0.35 * (1.0 - abs(vUv.y - 0.5) * 2.0)), isFill);

          // boss: gold segmentation ticks
          if (boss > 0.5) {
            float seg = abs(fract(vUv.x * 8.0) - 0.5);
            col = mix(col, vec3(0.05, 0.04, 0.03), (1.0 - smoothstep(0.02, 0.05, seg)) * 0.75);
          }

          // frame: darken the outer hairline so it reads on any background
          col = mix(vec3(0.0), col, inner * 0.92 + 0.08);
          float a = body * alpha * (inner > 0.5 ? 1.0 : 0.9);
          gl_FragColor = vec4(col * a, a);
        }
      `,
      premultipliedAlpha: true,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.geo = geo;
  }

  set(n, x, y, z, hp01, ghost01, boss, alpha) {
    const o = this.offsets.array, d = this.data.array;
    o[n * 3] = x; o[n * 3 + 1] = y; o[n * 3 + 2] = z;
    d[n * 4] = hp01; d[n * 4 + 1] = ghost01; d[n * 4 + 2] = boss; d[n * 4 + 3] = alpha;
  }

  commit(count) {
    this.geo.instanceCount = count;
    this.offsets.needsUpdate = true;
    this.data.needsUpdate = true;
  }
}
