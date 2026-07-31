/**
 * dsp.js — pure Web Audio primitives.
 *
 * Everything in the audio stack is synthesised at runtime; there is not a
 * single binary asset anywhere in the project. This module holds the low level
 * building blocks: noise buffers, procedurally generated impulse responses,
 * wavetables, saturation curves and envelope helpers.
 *
 * Nothing here touches the game — it is a small standalone DSP toolbox.
 */

/** Equal-tempered MIDI note -> Hz. */
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Clamp helper. */
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Linear interpolation. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Smooth 0..1 ramp used for layer cross-fades (no audible zipper). */
export function fade(x, a, b) {
  if (b === a) return x >= b ? 1 : 0;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic-ish random in a range. */
export const rnd = (a, b) => a + Math.random() * (b - a);
/** Random pick. */
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
/** Semitone -> ratio, for subtle per-hit detune. */
export const cents = (c) => Math.pow(2, c / 1200);

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/**
 * White / pink / brown noise buffer.
 * Pink uses the Paul Kellet approximation; brown is a leaky integrator.
 * Both are normalised so bus levels stay predictable between colours.
 */
export function makeNoise(ctx, seconds = 2, colour = 'white', channels = 2) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let ch = 0; ch < channels; ch++) {
    const d = buf.getChannelData(ch);
    if (colour === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else if (colour === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    // normalise
    let peak = 0;
    for (let i = 0; i < len; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    if (peak > 0) { const k = 0.98 / peak; for (let i = 0; i < len; i++) d[i] *= k; }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Reverb impulse responses (procedural — no IR files)
// ---------------------------------------------------------------------------

/**
 * Synthesises a plausible room: a short cluster of early reflections followed
 * by an exponentially decaying, progressively darkened noise tail. The tail is
 * lowpassed with a one-pole whose cutoff falls over time, which is what makes
 * a synthetic IR sound like stone rather than like a burst of static.
 *
 * @param {AudioContext} ctx
 * @param {object} o
 * @param {number} o.duration  tail length in seconds
 * @param {number} o.decay     exponential decay exponent (higher = tighter)
 * @param {number} o.predelay  seconds of silence before the tail
 * @param {number} o.damp      0..1 high frequency damping over the tail
 * @param {number} o.width     0..1 stereo decorrelation
 */
export function makeIR(ctx, {
  duration = 2.4, decay = 2.4, predelay = 0.012, damp = 0.72, width = 1,
  reflections = 9,
} = {}) {
  const rate = ctx.sampleRate;
  const len = Math.max(8, Math.floor(rate * (duration + predelay)));
  const buf = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(rate * predelay);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // --- diffuse tail -----------------------------------------------------
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      const env = Math.pow(1 - t, decay);
      const w = Math.random() * 2 - 1;
      // one-pole lowpass whose coefficient closes as the tail dies away
      const a = clamp(1 - damp * (0.25 + 0.75 * t), 0.02, 1);
      lp += a * (w - lp);
      d[i] = lp * env;
    }
    // --- early reflections ------------------------------------------------
    for (let r = 0; r < reflections; r++) {
      const tt = predelay + 0.004 + Math.pow(r / reflections, 1.4) * duration * 0.14;
      const idx = Math.floor(tt * rate) + (ch === 1 ? Math.floor(rnd(0, 0.0016 * rate * width)) : 0);
      if (idx < len) d[idx] += (Math.random() * 2 - 1) * 0.55 * Math.pow(1 - r / reflections, 1.6);
    }
    // --- normalise --------------------------------------------------------
    let peak = 0;
    for (let i = 0; i < len; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    if (peak > 0) { const k = 0.9 / peak; for (let i = 0; i < len; i++) d[i] *= k; }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Wavetables
// ---------------------------------------------------------------------------

const _waveCache = new WeakMap();

/**
 * Builds (and caches per-context) a PeriodicWave from a harmonic amplitude
 * recipe. Cheaper and far more characterful than stacking oscillators.
 */
export function wave(ctx, name) {
  let map = _waveCache.get(ctx);
  if (!map) { map = new Map(); _waveCache.set(ctx, map); }
  if (map.has(name)) return map.get(name);

  const recipes = {
    // dark reed organ — the harmonic spine of the score
    reed: (n) => (n % 2 ? 1 / n : 0.35 / n) * Math.exp(-n / 14),
    // hollow, glassy: strong odd partials with a formant bump
    glass: (n) => Math.exp(-Math.pow((n - 3) / 3.2, 2)) * 0.9 / Math.sqrt(n),
    // brass-ish: dense low harmonics rolling off late
    brass: (n) => Math.exp(-n / 9) * (1 / Math.pow(n, 0.72)),
    // choral formant stack (rough "aah")
    choir: (n) => {
      const f = [1, 2, 3, 4, 5, 6, 7, 8].includes(n) ? 1 : 0.6;
      const form = Math.exp(-Math.pow((n - 2) / 1.6, 2)) + 0.5 * Math.exp(-Math.pow((n - 7) / 3, 2));
      return (form * f) / Math.pow(n, 0.5) * 0.8;
    },
    // sub with a touch of grit so it survives small speakers
    sub: (n) => (n === 1 ? 1 : n === 2 ? 0.16 : n === 3 ? 0.07 : 0.02 / n),
    // metallic inharmonic-ish pluck
    metal: (n) => (n % 3 === 0 ? 0.9 : 0.35) * Math.exp(-n / 20) / Math.sqrt(n),
  };
  const fn = recipes[name] ?? recipes.reed;

  const N = 40;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  let norm = 0;
  for (let n = 1; n < N; n++) { imag[n] = fn(n); norm += Math.abs(imag[n]); }
  if (norm > 0) for (let n = 1; n < N; n++) imag[n] /= norm * 0.55;

  const w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  map.set(name, w);
  return w;
}

// ---------------------------------------------------------------------------
// Saturation / limiting curves
// ---------------------------------------------------------------------------

/** tanh soft-clip curve; `drive` >1 saturates harder. Guarantees |y| < 1. */
export function softClipCurve(drive = 1.6, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return c;
}

/**
 * Brick-wall-ish safety curve. Linear up to `knee`, then asymptotic to 0.985.
 * Sits last in the chain purely so nothing can ever reach full scale.
 */
export function ceilingCurve(knee = 0.7, n = 4096) {
  const c = new Float32Array(n);
  const top = 0.985;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    let y;
    if (a <= knee) y = a;
    else y = knee + (top - knee) * Math.tanh((a - knee) / (top - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Envelope helpers — every cue is scheduled on absolute times so cues render
// identically in an OfflineAudioContext (no setTimeout anywhere in synthesis).
// ---------------------------------------------------------------------------

const EPS = 0.00015;

/** Percussive attack/decay envelope on a gain param. Returns the end time. */
export function ad(param, t, { peak = 0.3, attack = 0.004, decay = 0.3, curve = 'exp' } = {}) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(EPS, t);
  if (attack <= 0.0005) param.setValueAtTime(peak, t + 0.0005);
  else param.linearRampToValueAtTime(peak, t + attack);
  const end = t + attack + decay;
  if (curve === 'lin') param.linearRampToValueAtTime(0, end);
  else param.exponentialRampToValueAtTime(EPS, end);
  return end;
}

/** Sustained ASR envelope (pads, horns). Returns the end time. */
export function asr(param, t, {
  peak = 0.3, attack = 0.05, hold = 0.4, release = 0.6,
} = {}) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(EPS, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + attack + hold);
  const end = t + attack + hold + release;
  param.exponentialRampToValueAtTime(EPS, end);
  return end;
}

/** Small helper: a stereo panner that degrades gracefully. */
export function panner(ctx, pan = 0) {
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }
  const g = ctx.createGain();
  return g;
}
