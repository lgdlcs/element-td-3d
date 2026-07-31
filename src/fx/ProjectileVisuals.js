import * as THREE from 'three';

/**
 * Projectile bodies.
 *
 * Two draw calls total:
 *   1. an instanced camera-facing quad running a procedural shader that draws
 *      a hot core + soft glow + element-specific silhouette, stretched along
 *      the velocity vector;
 *   2. an instanced low-poly rock for the earth family, which tumbles and is
 *      genuinely lit so it reads as matter rather than energy.
 *
 * The caller compacts live projectiles into slots 0..n-1 each frame.
 */
export class ProjectileRenderer {
  constructor(scene, max) {
    this.max = max;
    this.group = new THREE.Group();
    this.group.name = 'projectile-bodies';
    scene.add(this.group);

    // ---- billboards --------------------------------------------------
    const geo = new THREE.PlaneGeometry(2, 2);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aAccent = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    for (const a of [this.aColor, this.aAccent, this.aVel, this.aP]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aAccent', this.aAccent);
    geo.setAttribute('aVel', this.aVel);
    geo.setAttribute('aP', this.aP); // x=arch y=seed z=age w=stretch

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor, aAccent, aVel;
        attribute vec4 aP;
        varying vec3 vC, vA;
        varying vec4 vP;
        varying vec2 vL;
        void main() {
          vC = aColor; vA = aAccent; vP = aP;
          vL = position.xy;                 // -1..1 in the un-stretched disc
          vec3 centre = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float sc = instanceMatrix[0][0];
          vec4 mv = modelViewMatrix * vec4(centre, 1.0);
          vec4 vv = viewMatrix * vec4(aVel, 0.0);
          vec2 d = vv.xy;
          float dl = length(d);
          vec2 axis = dl > 1e-4 ? d / dl : vec2(0.0, 1.0);
          vec2 perp = vec2(-axis.y, axis.x);
          mv.xy += (axis * position.y * aP.w + perp * position.x) * sc;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec3 vC, vA;
        varying vec4 vP;
        varying vec2 vL;
        uniform float uTime;

        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(h21(i), h21(i+vec2(1,0)), f.x),
                     mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y);
        }

        void main() {
          float r = length(vL);
          if (r > 1.0) discard;
          float ang = atan(vL.y, vL.x);
          int arch = int(vP.x + 0.5);
          float seed = vP.y;
          float t = uTime + seed * 37.0;

          // Shared substrate: soft halo + hot core. The halo exponent is the
          // knob that decides whether a projectile is a defined bright object
          // or a travelling smudge — steepened, because at 2.6 the outer two
          // thirds of every quad still carried visible alpha.
          float halo = pow(max(0.0, 1.0 - r), 3.6);
          float core = pow(max(0.0, 1.0 - r * 2.3), 3.0);
          vec3 col = vC * halo;
          float a = halo * 0.7;

          if (arch == 0) {
            // FIRE — flickering flame lobes, white-hot heart
            float flick = vnoise(vec2(ang * 1.6, t * 6.0)) * 0.42;
            float body = smoothstep(1.0, 0.15, r + flick * r);
            a = body * 0.85 + core * 1.2;
            col = mix(vC, vA, core * 1.4);
            col = mix(col * 0.55, col, body);
            col += vA * core * 1.8;
          } else if (arch == 1) {
            // WATER — glassy orb, bright rim, offset specular
            float rim = smoothstep(0.55, 1.0, r) * smoothstep(1.0, 0.9, r) * 4.0;
            float spec = pow(max(0.0, 1.0 - length(vL - vec2(-0.32, 0.34)) * 3.4), 3.0);
            float inner = smoothstep(1.0, 0.1, r) * 0.5;
            a = inner * 0.8 + rim * 0.5 + spec * 1.1 + halo * 0.35;
            col = vC * (inner + rim) + vA * (spec * 2.2);
          } else if (arch == 2) {
            // NATURE — bright seed with an orbiting spore halo
            float pods = 0.5 + 0.5 * sin(ang * 5.0 + t * 5.0);
            float ring = smoothstep(0.12, 0.0, abs(r - 0.72)) * pods;
            a = core * 1.3 + ring * 0.75 + halo * 0.4;
            col = vC * (core * 1.2 + halo * 0.6) + vA * (ring * 1.4 + core * 0.8);
          } else if (arch == 3) {
            // EARTH — the rock mesh carries the read; this is just heat/dust glow
            a = halo * 0.30;
            col = vC * halo * 0.7;
          } else if (arch == 4) {
            // LIGHT — lance with a 4-point anamorphic flare
            float shaft = smoothstep(0.42, 0.0, abs(vL.x)) * smoothstep(1.0, 0.2, abs(vL.y));
            float star = pow(max(0.0, 1.0 - abs(vL.x) * 7.0), 2.0) * (1.0 - abs(vL.y))
                       + pow(max(0.0, 1.0 - abs(vL.y) * 7.0), 2.0) * (1.0 - abs(vL.x));
            a = shaft * 1.1 + star * 0.55 + core * 1.4 + halo * 0.3;
            col = vC * (shaft + halo) + vA * (core * 2.0 + star * 1.1);
          } else {
            // DARK — void sphere: absorbing centre ringed by a violet corona
            float corona = smoothstep(0.42, 0.72, r) * smoothstep(1.0, 0.74, r);
            float wisp = 0.5 + 0.5 * sin(ang * 4.0 - t * 4.0 + r * 6.0);
            float hole = smoothstep(0.62, 0.30, r);
            a = corona * (0.75 + wisp * 0.5) + halo * 0.3;
            a *= 1.0 - hole * 0.92;
            col = mix(vC, vA, corona * 0.8) * (1.0 + wisp * 0.5);
            col *= 1.0 - hole * 0.85;
          }

          if (a <= 0.004) discard;
          gl_FragColor = vec4(min(col * 1.9, vec3(3.2)), clamp(a, 0.0, 1.0));
        }
      `,
    });

    this.billboards = new THREE.InstancedMesh(geo, mat, max);
    this.billboards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.billboards.frustumCulled = false;
    this.billboards.count = 0;
    this.billboards.renderOrder = 9;
    this.billboards.userData.__fx = true;
    this.mat = mat;
    this.group.add(this.billboards);

    // ---- rocks -------------------------------------------------------
    const rockGeo = new THREE.IcosahedronGeometry(0.42, 0);
    // Rough the silhouette so it never reads as a faceted ball.
    const rp = rockGeo.attributes.position;
    for (let i = 0; i < rp.count; i++) {
      const s = 0.72 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.6;
      rp.setXYZ(i, rp.getX(i) * s, rp.getY(i) * s * 0.86, rp.getZ(i) * s);
    }
    rockGeo.computeVertexNormals();
    const rockMat = new THREE.MeshStandardMaterial({
      roughness: 0.92, metalness: 0.05, flatShading: true,
    });
    this.rocks = new THREE.InstancedMesh(rockGeo, rockMat, 256);
    this.rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rocks.frustumCulled = false;
    this.rocks.count = 0;
    this.rocks.castShadow = false;
    this.rocks.receiveShadow = false;
    this.rocks.userData.__fx = true;
    this.group.add(this.rocks);

    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._e = new THREE.Euler();
    this.nB = 0;
    this.nR = 0;
  }

  begin() { this.nB = 0; this.nR = 0; }

  pushBillboard(x, y, z, radius, vx, vy, vz, arch, seed, age, stretch, col, acc) {
    if (this.nB >= this.max) return;
    const n = this.nB++;
    this._p.set(x, y, z);
    this._q.identity();
    this._s.set(radius, radius, radius);
    this._m.compose(this._p, this._q, this._s);
    this.billboards.setMatrixAt(n, this._m);
    const c = this.aColor.array, a = this.aAccent.array, v = this.aVel.array, p = this.aP.array;
    c[n * 3] = col[0]; c[n * 3 + 1] = col[1]; c[n * 3 + 2] = col[2];
    a[n * 3] = acc[0]; a[n * 3 + 1] = acc[1]; a[n * 3 + 2] = acc[2];
    v[n * 3] = vx; v[n * 3 + 1] = vy; v[n * 3 + 2] = vz;
    p[n * 4] = arch; p[n * 4 + 1] = seed; p[n * 4 + 2] = age; p[n * 4 + 3] = stretch;
  }

  pushRock(x, y, z, scale, rx, ry, rz, r, g, b) {
    if (this.nR >= this.rocks.instanceMatrix.count) return;
    const n = this.nR++;
    this._p.set(x, y, z);
    this._e.set(rx, ry, rz);
    this._q.setFromEuler(this._e);
    this._s.set(scale, scale, scale);
    this._m.compose(this._p, this._q, this._s);
    this.rocks.setMatrixAt(n, this._m);
    TMPC.setRGB(r, g, b);
    this.rocks.setColorAt(n, TMPC);
  }

  end(time) {
    this.mat.uniforms.uTime.value = time;
    this.billboards.count = this.nB;
    this.rocks.count = this.nR;
    if (this.nB > 0) {
      this.billboards.instanceMatrix.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aAccent.needsUpdate = true;
      this.aVel.needsUpdate = true;
      this.aP.needsUpdate = true;
    }
    if (this.nR > 0) {
      this.rocks.instanceMatrix.needsUpdate = true;
      if (this.rocks.instanceColor) this.rocks.instanceColor.needsUpdate = true;
    }
  }
}

const TMPC = new THREE.Color();
