import * as THREE from 'three';

/**
 * Procedural PBR texture forge.
 *
 * Everything ships as code — zero binary assets, instant load, and every map
 * (albedo / normal / roughness / AO / height) is derived from the same height
 * field so they are physically consistent with one another.
 */

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smootherstep(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

/** Tileable value noise. */
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const w = (a) => ((a % period) + period) % period;
  const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
  const u = smootherstep(xf), v = smootherstep(yf);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Tileable fBm. */
export function fbm(x, y, { octaves = 5, period = 8, lacunarity = 2, gain = 0.5, seed = 1 } = {}) {
  let sum = 0, amp = 1, norm = 0, p = period, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f, p, seed + o * 131) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
    p *= lacunarity;
  }
  return sum / norm;
}

/** Tileable ridged noise — great for rock and cracked earth. */
export function ridged(x, y, opts = {}) {
  const n = fbm(x, y, opts);
  return 1 - Math.abs(n * 2 - 1);
}

/** Tileable Worley/cellular noise. Returns { f1, f2, id }. */
export function worley(x, y, period, seed = 1) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 8, f2 = 8, id = 0;
  const w = (a) => ((a % period) + period) % period;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const px = cx + hash2(w(cx), w(cy), seed);
      const py = cy + hash2(w(cx), w(cy), seed + 977);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; id = hash2(w(cx), w(cy), seed + 31); }
      else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2, id };
}

// ---------------------------------------------------------------------------
// Map builders
// ---------------------------------------------------------------------------

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(canvas, { srgb = false, aniso = 8, repeat = 1 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  tex.repeat.set(repeat, repeat);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Sobel height -> tangent-space normal map. `strength` in height units per texel.
 */
export function heightToNormal(height, size, strength = 2.4) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);

      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len;
      const nzn = nz / len;

      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nzn * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Cheap horizon-based AO from a height field. */
export function heightToAO(height, size, radius = 6, strength = 1.0) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  const dirs = 8;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h0 = at(x, y);
      let occ = 0;
      for (let d = 0; d < dirs; d++) {
        const a = (d / dirs) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        let maxSlope = 0;
        for (let s = 1; s <= radius; s++) {
          const hs = at(Math.round(x + dx * s), Math.round(y + dy * s));
          maxSlope = Math.max(maxSlope, (hs - h0) / s);
        }
        occ += Math.max(0, maxSlope);
      }
      occ = 1 - Math.min(1, (occ / dirs) * 4 * strength);
      const v = Math.round(Math.pow(occ, 1.2) * 255);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function writeRGB(canvas, size, fn) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const c = { r: 0, g: 0, b: 0 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn(x, y, c);
      const i = (y * size + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, c.r * 255));
      img.data[i + 1] = Math.max(0, Math.min(255, c.g * 255));
      img.data[i + 2] = Math.max(0, Math.min(255, c.b * 255));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/**
 * Weathered arena stone: large slabs, chipped edges, dust in the joints.
 * Returns a full PBR map set ready for MeshStandardMaterial.
 */
export function makeStoneMaps(size = 1024, aniso = 8) {
  const N = size;
  const height = new Float32Array(N * N);
  const slabScale = 6;      // slabs per tile
  const mortar = 0.045;

  const cellIds = new Float32Array(N * N);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;

      // Brick-ish slab layout with alternating row offset.
      const row = Math.floor(v * slabScale);
      const offset = (row % 2) * 0.5;
      const su = (u * slabScale + offset) % 1;
      const sv = (v * slabScale) % 1;
      const cellId = hash2(Math.floor(u * slabScale + offset), row, 7);
      cellIds[y * N + x] = cellId;

      // Distance to the nearest joint, with a noisy edge so it isn't ruler-straight.
      const edgeNoise = fbm(u * 24, v * 24, { period: 24, octaves: 3, seed: 3 }) * 0.02;
      const dEdge = Math.min(su, 1 - su, sv, 1 - sv) + edgeNoise;
      const joint = 1 - smootherstep(Math.min(1, dEdge / mortar));

      // Surface: broad undulation + fine grit + per-slab height variation.
      const broad = fbm(u * 4, v * 4, { period: 4, octaves: 4, seed: 11 });
      const grit = fbm(u * 48, v * 48, { period: 48, octaves: 4, seed: 23 });
      const cracks = Math.pow(ridged(u * 10, v * 10, { period: 10, octaves: 4, seed: 41 }), 6);

      let h = 0.62 + (cellId - 0.5) * 0.09 + broad * 0.10 + grit * 0.05;
      h -= joint * 0.30;
      h -= cracks * 0.12;

      // Chipped corners.
      const chip = worley(u * 30, v * 30, 30, 57);
      if (chip.f1 < 0.13 && dEdge < 0.12) h -= (0.13 - chip.f1) * 1.6;

      height[y * N + x] = h;
    }
  }

  // Albedo derived from the same field.
  const albedoCanvas = writeRGB(makeCanvas(N), N, (x, y, c) => {
    const u = x / N, v = y / N;
    const h = height[y * N + x];
    const cellId = cellIds[y * N + x];

    // Base sandstone-granite, per-slab hue drift.
    const warm = 0.5 + cellId * 0.5;
    let r = 0.315 + warm * 0.055;
    let g = 0.288 + warm * 0.042;
    let b = 0.262 + warm * 0.030;

    // Height-driven shading: recessed joints go darker and cooler.
    const shade = THREE.MathUtils.clamp((h - 0.35) / 0.45, 0, 1);
    const k = 0.42 + shade * 0.72;
    r *= k; g *= k; b *= k * 1.03;

    // Lichen / mineral staining in the low areas.
    const stain = fbm(u * 6 + 3.1, v * 6 - 1.7, { period: 6, octaves: 5, seed: 71 });
    const stainMask = smootherstep(THREE.MathUtils.clamp((stain - 0.52) * 4, 0, 1)) * (1 - shade * 0.6);
    r = THREE.MathUtils.lerp(r, 0.20, stainMask * 0.55);
    g = THREE.MathUtils.lerp(g, 0.24, stainMask * 0.55);
    b = THREE.MathUtils.lerp(b, 0.17, stainMask * 0.55);

    // Fine speckle so it never reads flat under bloom.
    const speck = fbm(u * 160, v * 160, { period: 160, octaves: 2, seed: 91 }) - 0.5;
    r += speck * 0.045; g += speck * 0.045; b += speck * 0.045;

    c.r = r; c.g = g; c.b = b;
  });

  // Roughness: joints and stains are rough, slab faces are polished by traffic.
  const roughCanvas = writeRGB(makeCanvas(N), N, (x, y, c) => {
    const u = x / N, v = y / N;
    const h = height[y * N + x];
    const shade = THREE.MathUtils.clamp((h - 0.35) / 0.45, 0, 1);
    const micro = fbm(u * 70, v * 70, { period: 70, octaves: 3, seed: 13 });
    let rough = 0.94 - shade * 0.30 + (micro - 0.5) * 0.14;
    rough = THREE.MathUtils.clamp(rough, 0.28, 1.0);
    c.r = c.g = c.b = rough;
  });

  const normalCanvas = heightToNormal(height, N, 2.6);
  const aoCanvas = heightToAO(height, N, 7, 1.15);
  const heightCanvas = writeRGB(makeCanvas(N), N, (x, y, c) => {
    c.r = c.g = c.b = height[y * N + x];
  });

  return {
    map: toTexture(albedoCanvas, { srgb: true, aniso }),
    normalMap: toTexture(normalCanvas, { aniso }),
    roughnessMap: toTexture(roughCanvas, { aniso }),
    aoMap: toTexture(aoCanvas, { aniso }),
    displacementMap: toTexture(heightCanvas, { aniso }),
    heightData: height,
  };
}

/** Dark packed dirt for the creep path. */
export function makeDirtMaps(size = 512, aniso = 8) {
  const N = size;
  const height = new Float32Array(N * N);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      const base = fbm(u * 8, v * 8, { period: 8, octaves: 5, seed: 5 });
      const grit = fbm(u * 64, v * 64, { period: 64, octaves: 3, seed: 17 });
      const pebble = worley(u * 26, v * 26, 26, 33);
      const pebbleH = Math.max(0, 0.12 - pebble.f1) * 2.4;
      height[y * N + x] = 0.5 + base * 0.22 + grit * 0.08 + pebbleH;
    }
  }

  const albedo = writeRGB(makeCanvas(N), N, (x, y, c) => {
    const u = x / N, v = y / N;
    const h = height[y * N + x];
    const t = THREE.MathUtils.clamp((h - 0.4) / 0.4, 0, 1);
    const damp = fbm(u * 5 + 9, v * 5 - 4, { period: 5, octaves: 4, seed: 61 });
    let r = THREE.MathUtils.lerp(0.088, 0.175, t);
    let g = THREE.MathUtils.lerp(0.068, 0.138, t);
    let b = THREE.MathUtils.lerp(0.052, 0.102, t);
    const wet = smootherstep(THREE.MathUtils.clamp((damp - 0.55) * 3, 0, 1));
    r *= 1 - wet * 0.35; g *= 1 - wet * 0.32; b *= 1 - wet * 0.24;
    c.r = r; c.g = g; c.b = b;
  });

  const rough = writeRGB(makeCanvas(N), N, (x, y, c) => {
    const u = x / N, v = y / N;
    const damp = fbm(u * 5 + 9, v * 5 - 4, { period: 5, octaves: 4, seed: 61 });
    const wet = smootherstep(THREE.MathUtils.clamp((damp - 0.55) * 3, 0, 1));
    c.r = c.g = c.b = THREE.MathUtils.clamp(0.97 - wet * 0.42, 0.35, 1);
  });

  return {
    map: toTexture(albedo, { srgb: true, aniso }),
    normalMap: toTexture(heightToNormal(height, N, 2.0), { aniso }),
    roughnessMap: toTexture(rough, { aniso }),
    aoMap: toTexture(heightToAO(height, N, 5, 0.9), { aniso }),
    heightData: height,
  };
}

// ---------------------------------------------------------------------------
// Terrain zone materials
//
// Each zone ships as exactly TWO textures so the ground shader can blend three
// of them without exploding the sample count:
//
//   albedo : RGBA sRGB   — rgb = base colour, a = emissive / seam mask
//   nra    : RGBA linear — r,g = tangent normal xy, b = roughness, a = AO
//
// Normal z is reconstructed in the shader as sqrt(1 - x^2 - y^2).
// ---------------------------------------------------------------------------

/**
 * Build a packed RGBA map as RAW BYTES, never as a canvas.
 *
 * ============================ READ THIS ==================================
 * A 2D canvas' backing store is PREMULTIPLIED. Uploading one as a texture
 * therefore destroys the colour of every texel whose alpha is below 255 —
 * and destroys it irrecoverably where alpha is 0, because the stored value
 * is literally (0,0,0,0) and there is nothing left to divide back out.
 * `texture.premultiplyAlpha = false` does not save you: it controls what the
 * GL does on upload, not what the browser already did on write.
 *
 * Every packed map in this file uses the alpha channel as a DATA channel:
 *
 *   flagstone albedo   a = engraved-channel mask   -> RGB survived only
 *                                                     along the engraving
 *   road / decay albedo a = 0                      -> RGB entirely black
 *   normal+rough+AO     a = ambient occlusion      -> normal.xy and
 *                                                     roughness scaled by AO
 *   macro variation     a = dampness field         -> RGB scaled by dampness
 *
 * So the arena floor had, in effect, NO albedo: the board's whole appearance
 * was the key light's specular lobe, which is why it read as one flat beige
 * value no matter what the albedo said, why two rounds of colour work moved
 * nothing, and why the only visible stone on the plate was a lattice of pale
 * marks where the engraving mask happened to push alpha to 1.
 *
 * Raw bytes into a DataTexture have no premultiplication step at all. Do not
 * route these back through a canvas.
 * =========================================================================
 */
function writeRGBA(size, fn) {
  const d = new Uint8Array(size * size * 4);
  const c = { r: 0, g: 0, b: 0, a: 1 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      c.r = c.g = c.b = 0; c.a = 1;
      fn(x, y, c);
      const i = (y * size + x) * 4;
      d[i] = Math.max(0, Math.min(255, c.r * 255));
      d[i + 1] = Math.max(0, Math.min(255, c.g * 255));
      d[i + 2] = Math.max(0, Math.min(255, c.b * 255));
      d[i + 3] = Math.max(0, Math.min(255, c.a * 255));
    }
  }
  return { data: d, size };
}

/** DataTexture wrapper for writeRGBA output. Mip/aniso set up like a CanvasTexture. */
function packedTexture(pack, { srgb = false, aniso = 8, repeat = 1 } = {}) {
  const tex = new THREE.DataTexture(pack.data, pack.size, pack.size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.repeat.set(repeat, repeat);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Horizon AO computed on a half-res copy of the height field then bilinearly
 * upsampled. AO is inherently low frequency, so this is a free 4x speedup.
 */
function fastAO(height, size, radius = 5, strength = 1.0, dirs = 6) {
  const M = size >> 1;
  const small = new Float32Array(M * M);
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      const i = (y * 2) * size + x * 2;
      small[y * M + x] = (height[i] + height[i + 1]
        + height[i + size] + height[i + size + 1]) * 0.25;
    }
  }
  const out = new Float32Array(M * M);
  const at = (x, y) => small[((y % M) + M) % M * M + (((x % M) + M) % M)];
  const cos = [], sin = [];
  for (let d = 0; d < dirs; d++) {
    const a = (d / dirs) * Math.PI * 2;
    cos.push(Math.cos(a)); sin.push(Math.sin(a));
  }
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      const h0 = small[y * M + x];
      let occ = 0;
      for (let d = 0; d < dirs; d++) {
        const dx = cos[d], dy = sin[d];
        let maxSlope = 0;
        for (let s = 1; s <= radius; s++) {
          const hs = at(Math.round(x + dx * s), Math.round(y + dy * s));
          const sl = (hs - h0) / s;
          if (sl > maxSlope) maxSlope = sl;
        }
        occ += maxSlope;
      }
      out[y * M + x] = 1 - Math.min(1, (occ / dirs) * 4 * strength);
    }
  }
  // bilinear upsample lookup
  return (x, y) => {
    const fx = (x - 0.5) * 0.5, fy = (y - 0.5) * 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const w = (a, m) => ((a % m) + m) % m;
    const a0 = out[w(y0, M) * M + w(x0, M)];
    const a1 = out[w(y0, M) * M + w(x0 + 1, M)];
    const b0 = out[w(y0 + 1, M) * M + w(x0, M)];
    const b1 = out[w(y0 + 1, M) * M + w(x0 + 1, M)];
    return (a0 * (1 - tx) + a1 * tx) * (1 - ty) + (b0 * (1 - tx) + b1 * tx) * ty;
  };
}

/** Pack tangent normal (xy) + roughness + AO into one linear RGBA canvas. */
function packNRA(height, size, { normalStrength = 2.4, aoRadius = 5, aoStrength = 1.0, roughAt }) {
  const N = size;
  const at = (x, y) => height[((y + N) % N) * N + ((x + N) % N)];
  const ao = fastAO(height, N, aoRadius, aoStrength);
  return writeRGBA(N, (x, y, c) => {
    const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
    const l = at(x - 1, y), r = at(x + 1, y);
    const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
    const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
    const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
    let nx = -dx * normalStrength, ny = -dy * normalStrength;
    const len = Math.hypot(nx, ny, 1);
    nx /= len; ny /= len;
    c.r = nx * 0.5 + 0.5;
    c.g = ny * 0.5 + 0.5;
    c.b = roughAt(x, y, height[y * N + x]);
    c.a = ao(x, y);
  });
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v) => v - Math.floor(v);

/**
 * Zone 1 — arcane flagstone. Irregular cut slabs (cellular, not brick), tight
 * joints, plus an engraved channel motif that reads as carved arcane geometry
 * and carries the emissive seam mask in the albedo alpha.
 */
/**
 * Zone 1 — the buildable plateau's stone. GRAIN ONLY.
 *
 * ROUND 4b, AND THIS IS A DELETION, NOT AN ADDITION.
 *
 * This function used to build a three-level warped-Worley flagstone
 * tessellation: joints, chamfers, per-slab value and hue drift, spalled
 * corners, hairline fractures. Every blind critic for three rounds described
 * the floor as "one crazed-vein texture at one UV scale", and a close capture
 * proved them right — at the ground's detail scale the cells resolve as a
 * network of thin dark veins over pale plaster. Dry mud, not cut stone.
 *
 * Round 4 replaced the STRUCTURE with an analytic, world-space slab lattice in
 * GroundMaterial (1.55 x 1.15 world units, running bond, per-slab hash, joints
 * antialiased against their own screen derivative). That lattice cannot tile at
 * any zoom, and it already owns joint, chamfer, AO, per-slab value, per-slab
 * hue and per-slab roughness. Everything this texture was contributing was
 * therefore a SECOND, contradictory lattice multiplied on top of the first —
 * which is why the round-4 fix had to be `uGrainFlat`, a gamma lift that
 * crushed the map's own contrast to stop the veins showing through.
 *
 * So the veins are gone at the source. What is left is what a detail layer is
 * actually for: mineral grain, cavity, staining and micro-roughness, with no
 * feature large enough to read as a shape and nothing periodic enough to count.
 * `uGrainFlat` can then go back to 0 and the grain gets its full contrast back.
 *
 * Alpha still carries the arcane engraving (Art Bible sec 3: "engraved channels
 * that glow faintly along the seams"), but it is no longer the joint network —
 * it is a wandering ridged channel gated by a long-wavelength mask, so it
 * degrades to a dim wash instead of tracing every crack on the plate.
 */
export function makeFlagstoneMaps(size = 640, aniso = 8) {
  const N = size;
  const H = new Float32Array(N * N);
  const seam = new Float32Array(N * N);
  const rough = new Float32Array(N * N);
  // Grain fields, cached so the albedo pass sees exactly what the height pass
  // saw. Four octaves at deliberately non-harmonic-looking scales; the smallest
  // is 97 per tile, which at the ground's 0.118 detail scale is ~0.09 world
  // units — under a pixel at gameplay framing, i.e. genuine grain.
  const G1 = new Float32Array(N * N);   // broad blotch, ~1/3 tile
  const G2 = new Float32Array(N * N);   // mottle
  const G3 = new Float32Array(N * N);   // grit
  const G4 = new Float32Array(N * N);   // mineral speckle
  const PIT = new Float32Array(N * N);  // shallow pitting

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N;
      const i = y * N + x;

      const g1 = fbm(u * 3, v * 3, { period: 3, octaves: 3, seed: 11 });
      const g2 = fbm(u * 11, v * 11, { period: 11, octaves: 3, seed: 23 });
      const g3 = fbm(u * 37, v * 37, { period: 37, octaves: 2, seed: 47 });
      const g4 = fbm(u * 97, v * 97, { period: 97, octaves: 2, seed: 91 });
      // Pitting: isolated shallow hollows, not lines. A threshold on a
      // mid-frequency field gives blobs; a threshold on a RIDGED field would
      // give exactly the crack network this rewrite exists to remove.
      const pit = Math.max(0, fbm(u * 23, v * 23, { period: 23, octaves: 2, seed: 131 }) - 0.615) * 2.8;
      G1[i] = g1; G2[i] = g2; G3[i] = g3; G4[i] = g4; PIT[i] = pit;

      // --- arcane engraving ------------------------------------------------
      // A continuous wandering channel, never a closed loop and never radially
      // symmetric (PITFALLS 6: anything with angular symmetry aliases into a
      // pinwheel at gameplay distance).
      const vein = ridged(u * 6 + 2.4, v * 6 - 5.1, { period: 6, octaves: 3, seed: 613 });
      const chanLine = smootherstep(clamp01((vein - 0.80) * 7.0));
      const gate = smootherstep(clamp01(
        (fbm(u * 3 + 11, v * 3 - 7, { period: 3, octaves: 3, seed: 33 }) - 0.58) * 5.0));
      const chan = chanLine * gate;
      seam[i] = chan;

      // --- height: grain, cavity, pitting. No joints, no chamfers. ---------
      let h = 0.74
        + (g1 - 0.5) * 0.050
        + (g2 - 0.5) * 0.045
        + (g3 - 0.5) * 0.030
        + (g4 - 0.5) * 0.016;
      h -= pit * 0.095;
      h -= chan * 0.070;              // the engraved channel is a shallow cut
      H[i] = h;

      // --- roughness -------------------------------------------------------
      let rg = 0.80 + (g3 - 0.5) * 0.22 + (g2 - 0.5) * 0.12 + (g4 - 0.5) * 0.10;
      rg += pit * 0.22;               // grit collects in the hollows
      rg -= chan * 0.34;              // polished glassy channel floor
      rough[i] = clamp01(Math.min(1, Math.max(0.22, rg)));
    }
  }

  const albedo = writeRGBA(N, (x, y, c) => {
    const u = x / N, v = y / N, i = y * N + x;

    // Cool grey-violet arcane granite, hue ~262 at ~15% saturation. Kept from
    // the previous map: under a 7.6-intensity #ffd096 key the red channel is
    // amplified ~1.7x relative to blue, so an albedo that measures neutral in
    // isolation renders pink. Cold stone, warm sun (law 4 — the ground is the
    // lowest-saturation surface in frame and must stay that way).
    //
    // VALUE. This carries ONLY grain now. Large-scale value belongs to the
    // composition pass (uRimDark / uCentreLift / the gobo) and per-slab value
    // belongs to the analytic lattice; a third copy here multiplies into mud.
    // Mean is set so the plate's measured luminance survives uGrainFlat going
    // 0.70 -> 0 (the old map was being gamma-lifted and then scaled 0.78).
    // 1.095 is SOLVED, not chosen. tools/scratch/r4b-flagmean.mjs reimplements
    // the deleted map's albedo pass and integrates both maps' mean LINEAR
    // sample through the shader's grain mix; the old map at uGrainFlat = 0.70
    // means L = 0.1117, and this map at uGrainFlat = 0 has to match it or the
    // board's value moves. At 0.735 it came out at 0.455x — the deletion would
    // have HALVED the board. The grain amplitudes are scaled with it so the
    // relative contrast is +-37% rather than the +-30% a bare rescale gives:
    // that is the headroom the gamma lift was costing.
    const val = 1.095
      + (G2[i] - 0.5) * 0.375
      + (G3[i] - 0.5) * 0.210
      + (G4[i] - 0.5) * 0.110
      + (G1[i] - 0.5) * 0.125;

    let r = 0.352 * val;
    let g = 0.364 * val;
    let b = 0.452 * val;

    // Cavity: the fine octaves darken the crevices and lift the ridges. This is
    // what stops a lit surface with a varying colour and a constant normal from
    // reading as a painted primitive.
    const cav = smootherstep(clamp01((G3[i] * 0.58 + G4[i] * 0.42 - 0.34) / 0.36));
    const kc = 0.88 + 0.20 * cav;
    r *= kc; g *= kc; b *= kc;

    // Pits are dark, cool and hold their colour (Art Bible 8: shadows never go
    // to pure black).
    const p = clamp01(PIT[i]);
    r = THREE.MathUtils.lerp(r, 0.052, p * 0.72);
    g = THREE.MathUtils.lerp(g, 0.051, p * 0.72);
    b = THREE.MathUtils.lerp(b, 0.066, p * 0.72);

    // Mineral staining at two scales so it is not one blotch size. Both targets
    // are COLD: a grey-teal mineral crust and a blue-black damp stain. The only
    // warm hue on this plate is the road, which is the one place warmth carries
    // information.
    const stain = fbm(u * 5 + 3.1, v * 5 - 1.7, { period: 5, octaves: 3, seed: 71 });
    const sm = smootherstep(clamp01((stain - 0.56) * 4));
    r = THREE.MathUtils.lerp(r, 0.128, sm * 0.30);
    g = THREE.MathUtils.lerp(g, 0.142, sm * 0.30);
    b = THREE.MathUtils.lerp(b, 0.150, sm * 0.30);
    const stain2 = fbm(u * 17 - 8.2, v * 17 + 4.6, { period: 17, octaves: 3, seed: 219 });
    const sm2 = smootherstep(clamp01((stain2 - 0.60) * 5)) * 0.34;
    r = THREE.MathUtils.lerp(r, 0.055, sm2);
    g = THREE.MathUtils.lerp(g, 0.056, sm2);
    b = THREE.MathUtils.lerp(b, 0.072, sm2);

    const speck = fbm(u * 120, v * 120, { period: 120, octaves: 2, seed: 91 }) - 0.5;
    r += speck * 0.013; g += speck * 0.013; b += speck * 0.015;

    // The engraved channel is a dark cut; its light comes from the emissive
    // term in the ground shader, not from the albedo (PITFALLS 6: painting an
    // element colour AND emitting it doubles into flat fluorescent card).
    const ch = seam[i];
    r *= 1 - ch * 0.42; g *= 1 - ch * 0.38; b *= 1 - ch * 0.30;

    c.r = r; c.g = g; c.b = b;
    // Safe: raw byte data, not a canvas. See writeRGBA() and PITFALLS 1.
    c.a = ch;
  });

  const nra = packNRA(H, N, {
    // With no joints to carve, the normal is carrying pure grain, so it can
    // take a little more gain than the 1.75 the jointed map needed without
    // turning any edge into a specular white line.
    normalStrength: 2.05,
    aoRadius: 8,
    aoStrength: 1.5,
    roughAt: (x, y) => rough[y * N + x],
  });

  return {
    albedo: packedTexture(albedo, { srgb: true, aniso }),
    nra: packedTexture(nra, { aniso }),
    heightData: H,
  };
}

/**
 * Zone 2 — the walked road. Ash and packed dirt, wheel ruts, ash flecks,
 * scattered gravel pushed to the shoulders.
 */
export function makeRoadMaps(size = 320, aniso = 8) {
  const N = size;
  const H = new Float32Array(N * N);
  const rough = new Float32Array(N * N);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, i = y * N + x;
      const base = fbm(u * 6, v * 6, { period: 6, octaves: 4, seed: 5 });
      const grit = fbm(u * 56, v * 56, { period: 56, octaves: 2, seed: 17 });
      // scuff streaks running along the tile's U axis: reads as direction of travel
      const streak = fbm(u * 2.5, v * 30, { period: 30, octaves: 2, seed: 88 });
      const peb = worley(u * 18, v * 18, 18, 33);
      const pebbleH = Math.max(0, 0.11 - peb.f1) * 2.6;
      H[i] = 0.5 + base * 0.20 + grit * 0.055 + (streak - 0.5) * 0.05 + pebbleH;

      const damp = fbm(u * 4 + 9, v * 4 - 4, { period: 4, octaves: 4, seed: 61 });
      const wet = smootherstep(clamp01((damp - 0.52) * 3));
      rough[i] = clamp01(0.99 - wet * 0.5 + (grit - 0.5) * 0.1);
    }
  }

  const albedo = writeRGBA(N, (x, y, c) => {
    const u = x / N, v = y / N, i = y * N + x;
    const h = H[i];
    const t = clamp01((h - 0.40) / 0.36);
    // Warm trodden ash-and-clay. It must read WARM against the cool grey
    // flagstone: at gameplay distance hue separation carries the road, not value.
    let r = THREE.MathUtils.lerp(0.105, 0.268, t);
    let g = THREE.MathUtils.lerp(0.082, 0.202, t);
    let b = THREE.MathUtils.lerp(0.068, 0.152, t);
    const damp = fbm(u * 4 + 9, v * 4 - 4, { period: 4, octaves: 4, seed: 61 });
    const wet = smootherstep(clamp01((damp - 0.52) * 3));
    r *= 1 - wet * 0.40; g *= 1 - wet * 0.42; b *= 1 - wet * 0.38;
    // pale ash flecks
    const fleck = fbm(u * 110, v * 110, { period: 110, octaves: 2, seed: 44 });
    const fm = Math.max(0, fleck - 0.68) * 2.4;
    r += fm * 0.14; g += fm * 0.12; b += fm * 0.10;
    c.r = r; c.g = g; c.b = b; c.a = 0;
  });

  const nra = packNRA(H, N, {
    normalStrength: 2.2,
    aoRadius: 5,
    aoStrength: 1.0,
    roughAt: (x, y) => rough[y * N + x],
  });

  return { albedo: packedTexture(albedo, { srgb: true, aniso }), nra: packedTexture(nra, { aniso }), heightData: H };
}

/**
 * Zone 3 — the decayed rim. Broken stone, spalled chunks, rubble packed with
 * ash and a crust of pale moss/mineral bloom in the shadows.
 */
export function makeDecayMaps(size = 320, aniso = 8) {
  const N = size;
  const H = new Float32Array(N * N);
  const rough = new Float32Array(N * N);
  const moss = new Float32Array(N * N);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, i = y * N + x;
      // chunky rubble: two worley octaves
      const c1 = worley(u * 7, v * 7, 7, 121);
      const c2 = worley(u * 17, v * 17, 17, 211);
      const chunk = Math.pow(clamp01(c1.f2 - c1.f1), 0.55);
      const grit = Math.pow(clamp01(c2.f2 - c2.f1), 0.7);
      const broad = fbm(u * 4, v * 4, { period: 4, octaves: 3, seed: 3 });
      const fine = fbm(u * 60, v * 60, { period: 60, octaves: 2, seed: 29 });
      H[i] = 0.32 + chunk * 0.34 + grit * 0.16 + broad * 0.12 + fine * 0.05;

      const m = smootherstep(clamp01(
        (fbm(u * 5 - 6, v * 5 + 2, { period: 5, octaves: 3, seed: 141 }) - 0.5) * 3.4))
        * clamp01(1 - chunk * 1.1);
      moss[i] = m;
      rough[i] = clamp01(0.95 - m * 0.06 + (fine - 0.5) * 0.12);
    }
  }

  const albedo = writeRGBA(N, (x, y, c) => {
    const i = y * N + x;
    const h = H[i];
    // Same stone as the plate, just shattered: cool grey-violet, and darker
    // than round 2 so the rubble islands read as broken ground sitting IN the
    // floor rather than as pale gravel painted ON it.
    const t = clamp01((h - 0.30) / 0.45);
    let r = THREE.MathUtils.lerp(0.034, 0.124, t);
    let g = THREE.MathUtils.lerp(0.034, 0.123, t);
    let b = THREE.MathUtils.lerp(0.043, 0.146, t);
    const m = moss[i];
    r = THREE.MathUtils.lerp(r, 0.086, m * 0.75);
    g = THREE.MathUtils.lerp(g, 0.101, m * 0.75);
    b = THREE.MathUtils.lerp(b, 0.098, m * 0.75);
    c.r = r; c.g = g; c.b = b; c.a = 0;
  });

  const nra = packNRA(H, N, {
    normalStrength: 2.6,
    aoRadius: 6,
    aoStrength: 1.35,
    roughAt: (x, y) => rough[y * N + x],
  });

  return { albedo: packedTexture(albedo, { srgb: true, aniso }), nra: packedTexture(nra, { aniso }), heightData: H };
}

/**
 * The macro variation layer: sampled ONCE across the whole arena (1x). It
 * modulates colour, roughness and AO of whatever zone is underneath, which is
 * what actually destroys the perception of a repeating detail tile.
 *
 *   rgb : colour multiplier, 0.5 == neutral
 *   a   : broad dampness / lowness field (drives puddles + roughness contrast)
 */
export function makeMacroMaps(size = 256, aniso = 8) {
  const N = size;
  const pack = writeRGBA(N, (x, y, c) => {
    const u = x / N, v = y / N;
    const big = fbm(u * 2, v * 2, { period: 2, octaves: 5, seed: 401 });
    const mid = fbm(u * 5 + 2.7, v * 5 - 1.3, { period: 5, octaves: 4, seed: 409 });
    const warm = fbm(u * 3 - 4.4, v * 3 + 8.1, { period: 3, octaves: 4, seed: 417 });

    const lum = (big * 0.62 + mid * 0.38 - 0.5);           // -0.5 .. 0.5
    // slight warm/cool split so the floor has colour temperature variation
    const temp = (warm - 0.5);
    c.r = clamp01(0.5 + lum * 0.62 + temp * 0.20);
    c.g = clamp01(0.5 + lum * 0.62);
    c.b = clamp01(0.5 + lum * 0.62 - temp * 0.24);

    // dampness pools in the broad lows
    const low = clamp01((0.44 - big) * 4.4);
    c.a = clamp01(smootherstep(low) * (0.35 + mid * 0.9));
  });
  // The raw bytes come back too: Arena needs to reproduce the exact same
  // lookups on the CPU for Arena.surfaceHeightAt(). They are now the SAME
  // bytes the GPU gets — previously the CPU read unpremultiplied values out
  // of getImageData while the GPU sampled premultiplied ones, so the vertex
  // displacement and surfaceHeightAt() were being driven by different data.
  return { texture: packedTexture(pack, { aniso }), data: pack.data, size: N };
}

/**
 * A tiling rune band for the platform rim and the portal rings.
 * Alpha carries the glyph mask; rgb is a soft inner-glow ramp.
 */
/**
 * @param opts.stroke  stroke weight as a fraction of the glyph cell. The
 *   default 0.16 is right for the portals, where a glyph is ~90px on screen.
 *   The rim band wraps a 194-unit perimeter and its glyphs land ~13px tall, at
 *   which size a 0.16 stroke is HALF A PIXEL and mip-averages to nothing — the
 *   rim runes rendered as a featureless blue hairline. It is not enough for a
 *   feature to be on screen; it has to survive its own resolution.
 * @param opts.blurR   glow radius in texels.
 */
export function makeRuneBand(w = 768, h = 96, { density = 22, seed = 5, stroke = 0.16, blurR = 2 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };

  const cellW = w / density;
  for (let i = 0; i < density; i++) {
    const cx = (i + 0.5) * cellW;
    const cy = h * 0.5;
    const sc = Math.min(cellW, h) * 0.34;
    ctx.lineWidth = Math.max(2, sc * stroke);
    const strokes = 3 + Math.floor(rnd() * 4);
    ctx.beginPath();
    for (let k = 0; k < strokes; k++) {
      const x0 = cx + (Math.round(rnd() * 2 - 1)) * sc;
      const y0 = cy + (Math.round(rnd() * 2 - 1)) * sc;
      const x1 = cx + (Math.round(rnd() * 2 - 1)) * sc;
      const y1 = cy + (Math.round(rnd() * 2 - 1)) * sc;
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    if (rnd() > 0.55) {
      ctx.beginPath();
      ctx.arc(cx, cy, sc * (0.5 + rnd() * 0.45), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Soften into a glow ramp so the band never aliases to hard pixels.
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + 3] / 255;
  const blur = new Float32Array(w * h);
  const R = blurR;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = ((x + dx) % w + w) % w, yy = Math.min(h - 1, Math.max(0, y + dy));
        sum += a[yy * w + xx]; n++;
      }
      blur[y * w + x] = sum / n;
    }
  }
  for (let i = 0; i < w * h; i++) {
    const core = a[i], glow = blur[i];
    const v = clamp01(core + glow * 0.85);
    d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255;
    d[i * 4 + 3] = v * 255;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Radial soft-particle sprite (additive glow). */
export function makeGlowSprite(size = 128, falloff = 2.2) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5) / c;
      const a = Math.pow(Math.max(0, 1 - d), falloff);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Turbulent smoke/flame puff sprite. */
export function makeSmokeSprite(size = 128, seed = 3) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5) / c;
      const n = fbm(x / size * 6, y / size * 6, { period: 6, octaves: 5, seed });
      let a = Math.max(0, 1 - d) * (0.45 + n * 0.9);
      a = Math.pow(THREE.MathUtils.clamp(a, 0, 1), 1.6);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
