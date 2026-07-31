import * as THREE from 'three';

/* --- tiny deterministic 3D value noise (mirrors the GLSL one closely) --- */
function hash3(x, y, z) {
  let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return h - Math.floor(h);
}
function smooth(t) { return t * t * (3 - 2 * t); }
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  const n = (a, b, c) => hash3(ix + a, iy + b, iz + c);
  const lerp = (a, b, t) => a + (b - a) * t;
  return lerp(
    lerp(lerp(n(0, 0, 0), n(1, 0, 0), fx), lerp(n(0, 1, 0), n(1, 1, 0), fx), fy),
    lerp(lerp(n(0, 0, 1), n(1, 0, 1), fx), lerp(n(0, 1, 1), n(1, 1, 1), fx), fy),
    fz);
}
function ridged(x, y, z, oct) {
  let a = 0.5, s = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(x, y, z) * 2 - 1);
    s += a * n * n;
    x = x * 2.11 + 3.7; y = y * 2.11 + 11.9; z = z * 2.11 + 23.1;
    a *= 0.5;
  }
  return s;
}
function fbm(x, y, z, oct) {
  let a = 0.5, s = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y, z);
    x = x * 2.03 + 17.3; y = y * 2.03 + 9.1; z = z * 2.03 + 4.7;
    a *= 0.5;
  }
  return s;
}

/**
 * Builds a linear float equirect map of the same world the Sky dome draws:
 * warm key sun, cool aurora arc, violet/teal nebula, glowing horizon, abyss.
 *
 * This is what metals reflect. A flat gradient gives dead chrome — the sun
 * disc plus the aurora arc give a bright specular anchor *and* a cool sweep
 * on the opposite side, which is what sells a curved metal surface.
 */
export function buildSkyEquirect(sunDirIn, size = 512) {
  const w = size, h = size / 2;
  const data = new Float32Array(w * h * 4);
  const sun = sunDirIn.clone().normalize();

  const zenith = [0.016, 0.022, 0.048];
  const mid = [0.042, 0.062, 0.130];
  const horizon = [0.100, 0.135, 0.205];
  const abyss = [0.030, 0.014, 0.008];      // the forge is DOWN there
  const nebA = [0.46, 0.13, 0.32];
  const nebB = [0.06, 0.26, 0.34];
  const aurora = [0.16, 0.80, 0.66];
  const sunCol = [1.0, 0.68, 0.34];
  const forge = [1.0, 0.34, 0.09];

  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  for (let y = 0; y < h; y++) {
    const theta = ((y + 0.5) / h) * Math.PI;
    const sT = Math.sin(theta), cT = Math.cos(theta);
    for (let x = 0; x < w; x++) {
      const phi = ((x + 0.5) / w) * Math.PI * 2;
      const dx = sT * Math.cos(phi), dy = cT, dz = sT * Math.sin(phi);

      let c;
      if (dy >= 0) {
        const k = Math.pow(dy, 0.62);
        c = mix(horizon, mid, smoothstepf(0, 0.42, k));
        c = mix(c, zenith, smoothstepf(0.35, 1, k));
      } else {
        c = mix(horizon, abyss, Math.pow(-dy, 0.5));
        const g = Math.pow(-dy, 2.6) * 0.10;
        c = [c[0] + nebB[0] * g, c[1] + nebB[1] * g, c[2] + nebB[2] * g];
      }

      // nebula
      const fil = ridged(dx * 2.1, dy * 2.1, dz * 2.1, 4);
      const mask = fbm(dx * 0.9, dy * 0.9, dz * 0.9, 3);
      let neb = Math.pow(Math.max(0, fil - 0.42), 1.7) * smoothstepf(0.30, 0.78, mask);
      neb *= smoothstepf(-0.30, 0.35, dy);
      const hue = fbm(dx * 0.55 + 7.3, dy * 0.55 + 7.3, dz * 0.55 + 7.3, 2);
      const nc = mix(nebB, nebA, smoothstepf(0.35, 0.68, hue));
      c = [c[0] + nc[0] * neb * 1.35, c[1] + nc[1] * neb * 1.35, c[2] + nc[2] * neb * 1.35];

      // aurora arc on the cool side — a broad soft area light for metals
      const sd = dx * sun.x + dy * sun.y + dz * sun.z;
      const side = smoothstepf(0.15, -0.75, sd);
      const band = smoothstepf(-0.02, 0.10, dy) * smoothstepf(0.52, 0.16, dy);
      const wob = fbm(dx * 1.6, dy * 5.0, dz * 1.6, 3);
      let rib = Math.sin(dx * 5.5 + dz * 3.1 + wob * 7.0);
      rib = Math.pow(Math.max(0, rib * 0.5 + 0.5), 4.5);
      const aur = rib * band * side;
      c = [c[0] + aurora[0] * aur * 0.75, c[1] + aurora[1] * aur * 0.75, c[2] + aurora[2] * aur * 0.75];
      const wash = band * side * 0.10;
      c = [c[0] + aurora[0] * wash * 0.4, c[1] + aurora[1] * wash * 0.6, c[2] + aurora[2] * wash * 0.7];

      // key sun: tight bright disc + broad falloff
      const d = Math.max(0, sd);
      const glow = Math.pow(d, 900) * 260 + Math.pow(d, 14) * 1.1 + Math.pow(d, 3) * 0.10;
      c = [c[0] + sunCol[0] * glow, c[1] + sunCol[1] * glow, c[2] + sunCol[2] * glow];

      // horizon haze ring
      const haze = Math.exp(-Math.abs(dy) * 9) * 0.3;
      const hz = mix([0.10, 0.14, 0.22], [sunCol[0] * 0.5, sunCol[1] * 0.5, sunCol[2] * 0.5], smoothstepf(0, 0.9, d));
      c = [c[0] + hz[0] * haze, c[1] + hz[1] * haze, c[2] + hz[2] * haze];

      /* --- ROUND 2: the two colour anchors, in the reflection map too ----
         Chrome that reflects a purely cool sky comes back cool no matter how
         warm the key is. The equirect now carries the same warm/cool split
         the Sky dome draws, so a metal tower shell picks up amber on one
         flank and indigo on the other — which is most of what makes a curved
         metal surface read as metal at all. */
      const azLen = Math.hypot(dx, dz) || 1e-5;
      const sunAzLen = Math.hypot(sun.x, sun.z) || 1e-5;
      const azDot = (dx * sun.x + dz * sun.z) / (azLen * sunAzLen);
      const warmSide = smoothstepf(-0.55, 0.72, azDot);
      // furnace glow on the key side, strongest below the horizon
      const fBand = smoothstepf(-0.05, 0.30, -dy) * smoothstepf(1.05, 0.55, -dy);
      const fg = Math.pow(warmSide, 1.35) * fBand;
      c = [c[0] + forge[0] * fg * 0.62, c[1] + forge[1] * fg * 0.62, c[2] + forge[2] * fg * 0.62];
      const wsh = Math.pow(warmSide, 2.0) * 0.16;
      c = [c[0] + sunCol[0] * wsh, c[1] + sunCol[1] * wsh, c[2] + sunCol[2] * wsh];
      // the molten sea itself, straight down
      const nadir = Math.pow(Math.max(0, -dy), 3.0);
      c = [c[0] + forge[0] * nadir * 0.55, c[1] + forge[1] * nadir * 0.55, c[2] + forge[2] * nadir * 0.55];

      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 1;
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function smoothstepf(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
