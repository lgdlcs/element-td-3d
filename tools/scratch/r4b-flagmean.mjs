#!/usr/bin/env node
/**
 * Did replacing the flagstone map brighten the board?
 *
 * The board's value comes from albedo * light, so the honest check is the MEAN
 * LINEAR ALBEDO the ground shader actually samples — before, that was
 *     mix(albF_old, pow(albF_old, 0.62) * 0.78, uGrainFlat=0.70)
 * and now it is albF_new with uGrainFlat = 0. This reimplements the OLD map's
 * albedo pass verbatim (it is deleted from the source) and the NEW one by
 * import, and compares the two means through that mix.
 *
 * Coarse grid: 160x160 of a 640 map. We want a mean, not a texture.
 */
import * as THREE from 'three';
import { fbm, ridged, worley } from '../../src/assets/ProceduralTextures.js';

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const fract = (x) => x - Math.floor(x);
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = THREE.MathUtils.lerp;
const toLinear = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);

const N = 160;
const SLAB = 2.2;

function oldAlbedo(u, v) {
  const wu = (fbm(u * 3, v * 3, { period: 3, octaves: 2, seed: 9 }) - 0.5) * 0.26;
  const wv = (fbm(u * 3 + 5.3, v * 3 - 2.1, { period: 3, octaves: 2, seed: 19 }) - 0.5) * 0.26;
  const cell = worley(u * SLAB + wu, v * SLAB + wv, SLAB, 77);
  let edge = cell.f2 - cell.f1, id = cell.id;
  if (cell.id > 0.54) {
    const fineC = worley(u * SLAB * 2 + wu, v * SLAB * 2 + wv, SLAB * 2, 143);
    const fineEdge = (fineC.f2 - fineC.f1) * 0.44;
    if (fineEdge < edge) { edge = fineEdge; id = fineC.id * 0.6 + cell.id * 0.4; }
    if (fineC.id > 0.82) {
      const tinyC = worley(u * SLAB * 4 + wu, v * SLAB * 4 + wv, SLAB * 4, 271);
      const tinyEdge = (tinyC.f2 - tinyC.f1) * 0.22;
      if (tinyEdge < edge) { edge = tinyEdge; id = tinyC.id * 0.55 + id * 0.45; }
    }
  }
  const j = 1 - smootherstep(clamp01(edge / 0.016));
  const cham = 1 - smootherstep(clamp01((edge - 0.014) / 0.052));
  const chanLine = 1 - smootherstep(clamp01(edge / 0.030));
  const veinMask = smootherstep(clamp01(
    (fbm(u * 1.5 + 11, v * 1.5 - 7, { period: 3, octaves: 3, seed: 33 }) - 0.60) * 6.0))
    * smootherstep(clamp01((id - 0.45) * 3.0));
  const ch = chanLine * veinMask;
  const broad = fbm(u * 3, v * 3, { period: 3, octaves: 3, seed: 11 });
  const grit = fbm(u * 44, v * 44, { period: 44, octaves: 2, seed: 23 });
  const fracN = ridged(u * 9 + 2.4, v * 9 - 5.1, { period: 9, octaves: 3, seed: 613 });
  const frac = Math.max(0, fracN - 0.74) * 3.4 * (1 - j);
  let h = 0.74 + (cell.id - 0.5) * 0.038 + broad * 0.024 + grit * 0.014;
  h -= cham * 0.055; h -= j * 0.16; h -= frac * 0.035; h -= ch * 0.09;
  if (edge < 0.10) {
    const chip = fbm(u * 22, v * 22, { period: 22, octaves: 2, seed: 57 });
    h -= Math.max(0, chip - 0.52) * (0.10 - edge) * 3.2;
  }
  const val = 0.72 + id * 0.38;
  const hue = fract(id * 13.77) - 0.5;
  let r = 0.352 * val * (1 + hue * 0.22);
  let g = 0.364 * val * (1 + hue * 0.05);
  let b = 0.452 * val * (1 - hue * 0.20);
  const shade = clamp01((h - 0.58) / 0.20);
  const k = 0.74 + shade * 0.44; r *= k; g *= k; b *= k;
  const cl = cham * (1 - j) * 0.42;
  r = lerp(r, r * 1.19 + 0.022, cl); g = lerp(g, g * 1.19 + 0.021, cl); b = lerp(b, b * 1.20 + 0.026, cl);
  r = lerp(r, 0.048, j * 0.80); g = lerp(g, 0.047, j * 0.80); b = lerp(b, 0.060, j * 0.80);
  const skirt = cham * (1 - j) * 0.42;
  r *= 1 - skirt * 0.34; g *= 1 - skirt * 0.34; b *= 1 - skirt * 0.32;
  r = lerp(r, 0.052, clamp01(frac)); g = lerp(g, 0.051, clamp01(frac)); b = lerp(b, 0.064, clamp01(frac));
  const stain = fbm(u * 5 + 3.1, v * 5 - 1.7, { period: 5, octaves: 3, seed: 71 });
  const sm = smootherstep(clamp01((stain - 0.56) * 4));
  r = lerp(r, 0.128, sm * 0.30); g = lerp(g, 0.142, sm * 0.30); b = lerp(b, 0.150, sm * 0.30);
  const stain2 = fbm(u * 17 - 8.2, v * 17 + 4.6, { period: 17, octaves: 3, seed: 219 });
  const sm2 = smootherstep(clamp01((stain2 - 0.60) * 5)) * 0.34;
  r = lerp(r, 0.055, sm2); g = lerp(g, 0.056, sm2); b = lerp(b, 0.072, sm2);
  const speck = fbm(u * 120, v * 120, { period: 120, octaves: 2, seed: 91 }) - 0.5;
  r += speck * 0.013; g += speck * 0.013; b += speck * 0.015;
  r *= 1 - ch * 0.5; g *= 1 - ch * 0.45; b *= 1 - ch * 0.35;
  return [r, g, b];
}

function newAlbedo(u, v) {
  const g1 = fbm(u * 3, v * 3, { period: 3, octaves: 3, seed: 11 });
  const g2 = fbm(u * 11, v * 11, { period: 11, octaves: 3, seed: 23 });
  const g3 = fbm(u * 37, v * 37, { period: 37, octaves: 2, seed: 47 });
  const g4 = fbm(u * 97, v * 97, { period: 97, octaves: 2, seed: 91 });
  const pit = Math.max(0, fbm(u * 23, v * 23, { period: 23, octaves: 2, seed: 131 }) - 0.615) * 2.8;
  const vein = ridged(u * 6 + 2.4, v * 6 - 5.1, { period: 6, octaves: 3, seed: 613 });
  const chanLine = smootherstep(clamp01((vein - 0.80) * 7.0));
  const gate = smootherstep(clamp01(
    (fbm(u * 3 + 11, v * 3 - 7, { period: 3, octaves: 3, seed: 33 }) - 0.58) * 5.0));
  const ch = chanLine * gate;
  const G = +(process.env.GAIN ?? 1);
  const val = G * 1.095 + (g2 - 0.5) * 0.375 + (g3 - 0.5) * 0.210 + (g4 - 0.5) * 0.110 + (g1 - 0.5) * 0.125;
  let r = 0.352 * val, g = 0.364 * val, b = 0.452 * val;
  const cav = smootherstep(clamp01((g3 * 0.58 + g4 * 0.42 - 0.34) / 0.36));
  const kc = 0.88 + 0.20 * cav; r *= kc; g *= kc; b *= kc;
  const p = clamp01(pit);
  r = lerp(r, 0.052, p * 0.72); g = lerp(g, 0.051, p * 0.72); b = lerp(b, 0.066, p * 0.72);
  const stain = fbm(u * 5 + 3.1, v * 5 - 1.7, { period: 5, octaves: 3, seed: 71 });
  const sm = smootherstep(clamp01((stain - 0.56) * 4));
  r = lerp(r, 0.128, sm * 0.30); g = lerp(g, 0.142, sm * 0.30); b = lerp(b, 0.150, sm * 0.30);
  const stain2 = fbm(u * 17 - 8.2, v * 17 + 4.6, { period: 17, octaves: 3, seed: 219 });
  const sm2 = smootherstep(clamp01((stain2 - 0.60) * 5)) * 0.34;
  r = lerp(r, 0.055, sm2); g = lerp(g, 0.056, sm2); b = lerp(b, 0.072, sm2);
  const speck = fbm(u * 120, v * 120, { period: 120, octaves: 2, seed: 91 }) - 0.5;
  r += speck * 0.013; g += speck * 0.013; b += speck * 0.015;
  r *= 1 - ch * 0.42; g *= 1 - ch * 0.38; b *= 1 - ch * 0.30;
  return [r, g, b];
}

// The shader's grain mix, applied to the LINEAR sample.
function grainMix(lin, flat) {
  return lin.map((c) => c * (1 - flat) + Math.max(c, 1e-4) ** 0.62 * 0.78 * flat);
}

function mean(fn, flat) {
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const srgb = fn(x / N, y / N).map((c) => clamp01(c));
      // the map is written as 8-bit sRGB bytes and sampled back as linear
      const lin = srgb.map((c) => toLinear(Math.round(c * 255) / 255));
      const m = grainMix(lin, flat);
      R += m[0]; G += m[1]; B += m[2]; n++;
    }
  }
  return { r: +(R / n).toFixed(4), g: +(G / n).toFixed(4), b: +(B / n).toFixed(4), L: +((0.2126 * R + 0.7152 * G + 0.0722 * B) / n).toFixed(4) };
}

const oldEff = mean(oldAlbedo, 0.70);
const newEff = mean(newAlbedo, 0.0);
const newRaw = mean(newAlbedo, 0.70);
console.log(JSON.stringify({
  oldMap_grainFlat070: oldEff,
  newMap_grainFlat000: newEff,
  newMap_grainFlat070: newRaw,
  ratio_new_over_old: +(newEff.L / oldEff.L).toFixed(3),
}, null, 1));
