/**
 * Shared GLSL building blocks for the environment layer.
 * Kept in one place so every env shader samples the *same* noise field —
 * that is what makes the sky, the clouds and the fog feel like one world.
 */

export const NOISE = /* glsl */`
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  vec3 hash33(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
  }

  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z);
  }

  float fbm3(vec3 p, int oct) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= oct) break;
      s += a * vnoise(p);
      p = p * 2.03 + vec3(17.3, 9.1, 4.7);
      a *= 0.5;
    }
    return s;
  }

  // Ridged variant — gives nebula filaments rather than woolly blobs.
  float ridged(vec3 p, int oct) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= oct) break;
      float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
      s += a * n * n;
      p = p * 2.11 + vec3(3.7, 11.9, 23.1);
      a *= 0.5;
    }
    return s;
  }
`;

/** Soft, non-clipping tone shaping used by every additive env element. */
export const SOFTEN = /* glsl */`
  vec3 soften(vec3 c) { return c / (1.0 + c * 0.55); }
`;
