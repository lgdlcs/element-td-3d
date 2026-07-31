import * as THREE from 'three';

/**
 * A baked 3D value-noise volume, with its analytic gradient.
 *
 * WHY THIS EXISTS
 *
 * `TowerMaterial` evaluated its detail field procedurally, per fragment, every
 * frame. The field is `tdetail()`, two octaves of trilinear value noise, and it
 * was called four times per pixel: once for the surface value and three more
 * for a forward-difference gradient feeding the bump normal. Two octaves is two
 * `tnoise`, and each `tnoise` reads eight lattice corners, so the real cost was
 *
 *     4 calls x 2 octaves x 8 corners = 64 hash evaluations per fragment
 *
 * Measured at 41.7 ms for 21 towers on an Apple M1 (docs/PERF_BUDGET.md). The
 * field does not move: it is a pure function of local position. Everything
 * above was being recomputed sixty times a second for a value that could have
 * been computed once.
 *
 * WHAT THIS REPLACES IT WITH
 *
 * One `Data3DTexture`. RGB holds the gradient of the field, A holds its value,
 * so a single hardware trilinear fetch returns everything the shader previously
 * spent four calls computing:
 *
 *     64 hash evaluations  ->  2 texture fetches   (one per octave)
 *
 * Baking the gradient rather than differencing the value again in the shader is
 * what removes the other three calls. It also gives a *better* normal than the
 * original did: the forward difference in the old code sampled at a 0.03-0.075
 * unit step, which smears features finer than the step, whereas the gradient
 * here is differenced on the lattice itself.
 *
 * WHY A LATTICE TEXTURE IS NOT A LOOK CHANGE
 *
 * `tnoise` is value noise on an integer lattice with a smoothstep fade. Storing
 * the lattice and letting the sampler interpolate reproduces it exactly at the
 * corners and differs only in the fade curve between them (hardware is linear,
 * the original was smoothstep). That difference is sub-percent at the octave
 * scales used here, and it is applied to a +-18% albedo modulation. The tiling
 * period is the real constraint, and it is handled by SIZE below.
 *
 * SIZE / TILING
 *
 * The volume is sampled at `p * 3.2` (stone) and up to `p * 17` (metal, along
 * x and z). A tower is ~5 units tall, so a stone face spans ~16 lattice cells
 * and a brushed-metal band ~85. At SIZE = 64 with RepeatWrapping the stone
 * never repeats within one tower, and metal repeats along a band where the
 * feature is a directional streak whose repeat is invisible by construction.
 * SIZE = 64 costs 64^3 x 4 bytes = 1 MB, uploaded once at boot.
 */

const SIZE = 64;

/** The exact hash the shader used, so corner values are bit-identical. */
function thash(x, y, z) {
  let px = (x * 0.3183099 + 0.1) % 1;
  let py = (y * 0.3183099 + 0.2) % 1;
  let pz = (z * 0.3183099 + 0.3) % 1;
  if (px < 0) px += 1;
  if (py < 0) py += 1;
  if (pz < 0) pz += 1;
  px *= 17.0; py *= 17.0; pz *= 17.0;
  const v = px * py * pz * (px + py + pz);
  return v - Math.floor(v);
}

let _volume = null;

/**
 * @returns {THREE.Data3DTexture} RGB = gradient of the value field (central
 *   differences, in units of "per lattice cell"), A = the value itself.
 *   Cached: the bake runs once per page load.
 */
export function noiseVolume() {
  if (_volume) return _volume;

  const n = SIZE, n2 = n * n;
  // Corner values first, so the gradient can be central-differenced from them.
  const val = new Float32Array(n2 * n);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        val[z * n2 + y * n + x] = thash(x, y, z);

  const data = new Uint8Array(n2 * n * 4);
  const at = (x, y, z) => val[((z + n) % n) * n2 + ((y + n) % n) * n + ((x + n) % n)];

  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (z * n2 + y * n + x) * 4;
        // Central differences, wrapped — so the gradient is continuous across
        // the tiling seam and no visible ridge appears where the volume repeats.
        const gx = (at(x + 1, y, z) - at(x - 1, y, z)) * 0.5;
        const gy = (at(x, y + 1, z) - at(x, y - 1, z)) * 0.5;
        const gz = (at(x, y, z + 1) - at(x, y, z - 1)) * 0.5;
        // Gradient of a 0..1 field over one cell lands in -0.5..0.5; remap to
        // 0..1 for an 8-bit unsigned texture and undo it in the shader.
        data[i]     = Math.round(THREE.MathUtils.clamp(gx + 0.5, 0, 1) * 255);
        data[i + 1] = Math.round(THREE.MathUtils.clamp(gy + 0.5, 0, 1) * 255);
        data[i + 2] = Math.round(THREE.MathUtils.clamp(gz + 0.5, 0, 1) * 255);
        data[i + 3] = Math.round(val[z * n2 + y * n + x] * 255);
      }
    }
  }

  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // No mips: the sampler cannot pick a level for a volume addressed by world
  // position, and a wrong level would blur the grain away at grazing angles.
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  _volume = tex;
  return tex;
}

/**
 * GLSL that mirrors `tdetail()` from the old shader, reading the volume.
 *
 * Returns `vec4( gradient, value )`. The caller gets the bump gradient for
 * free — that is the whole point, and it is why three of the four original
 * calls disappear rather than merely getting cheaper.
 */
export const NOISE_VOLUME_GLSL = /* glsl */`
  precision highp sampler3D;
  uniform sampler3D uNoiseVol;
  const float NOISE_VOL_SIZE = ${SIZE}.0;

  /** value in .a, gradient (per world unit at this scale) in .rgb */
  vec4 tsample( vec3 p ) {
    vec4 t = texture( uNoiseVol, p / NOISE_VOL_SIZE );
    return vec4( ( t.rgb - 0.5 ), t.a );
  }

  /**
   * Two octaves, matching the old tdetail(): stone gets coarse isotropic
   * pitting, metal gets fine vertical brushed streaks.
   * Returns vec4( gradient in LOCAL space, value ).
   */
  vec4 tdetail4( vec3 p, float metal ) {
    vec3 sc = mix( vec3( 3.2 ), vec3( 17.0, 2.0, 17.0 ), metal );
    vec3 ps = p * sc;
    vec4 a = tsample( ps );
    vec4 b = tsample( ps * 2.17 + 11.3 );
    // Chain rule: d/dp = d/dps * dps/dp. The second octave carries its own
    // 2.17 factor. Without this the bump would be scaled wrongly on metal,
    // whose sc is 5x the stone value on x and z.
    vec3 grad = ( a.rgb * sc + b.rgb * 0.5 * sc * 2.17 ) * 0.66667;
    return vec4( grad, ( a.a + 0.5 * b.a ) * 0.66667 );
  }
`;
