/**
 * Sfx.js — every cue in the game, synthesised.
 *
 * House rules:
 *  - Each cue is layered: TRANSIENT (what you notice) + BODY (what it is) +
 *    TAIL (where it is). A single oscillator is never acceptable.
 *  - Everything is scheduled on absolute AudioContext times. No setTimeout in
 *    synthesis, which means a cue renders bit-identically in an
 *    OfflineAudioContext and can therefore be measured numerically.
 *  - Every cue randomises pitch, timbre and micro-timing so the 400th creep
 *    death does not sound like the 1st.
 */
import {
  mtof, wave, ad, asr, rnd, clamp, panner, cents, lerp,
} from './dsp.js';

// D natural minor is the tonal centre of the whole score; SFX quote it so the
// interface and the music never disagree harmonically.
const D = 50;                       // MIDI D3
const MINOR = [0, 2, 3, 5, 7, 8, 10];

/** Per-element sonic identity. Duals inherit from their two parents. */
const DUAL_PARENTS = {
  steam: ['fire', 'water'], ember: ['fire', 'nature'], magma: ['earth', 'fire'],
  blaze: ['fire', 'light'], hellfire: ['dark', 'fire'], ice: ['nature', 'water'],
  mud: ['earth', 'water'], mist: ['light', 'water'], abyss: ['dark', 'water'],
  life: ['earth', 'nature'], gaia: ['light', 'nature'], poison: ['dark', 'nature'],
  crystal: ['earth', 'light'], void: ['dark', 'earth'], magic: ['dark', 'light'],
};

export class Sfx {
  constructor(ctx, mixer) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.out = mixer.sfx.input;
    this._noise = null;      // injected by AudioEngine (shared buffers)
  }

  setNoise(buffers) { this._noise = buffers; }

  // -------------------------------------------------------------------------
  // Primitive voices
  // -------------------------------------------------------------------------

  /** Routed gain node with optional pan; every voice starts here. */
  #chan(dest, pan = 0, gain = 1) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (pan) { const p = panner(this.ctx, pan); g.connect(p); p.connect(dest ?? this.out); }
    else g.connect(dest ?? this.out);
    return g;
  }

  /**
   * Pitched voice. `shape` is either an OscillatorType or a wavetable name.
   * Frequency can glide (`to`) and be shaped by an exponential pitch env.
   */
  tone(t, {
    freq = 220, to = null, shape = 'sine', peak = 0.2, attack = 0.006, decay = 0.4,
    hold = 0, release = 0, dest = null, pan = 0, detune = 0, glideTime = null,
    filter = null, vibrato = null, curve = 'exp',
  } = {}) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    if (['sine', 'square', 'sawtooth', 'triangle'].includes(shape)) osc.type = shape;
    else osc.setPeriodicWave(wave(ctx, shape));
    osc.detune.value = detune;
    osc.frequency.setValueAtTime(Math.max(8, freq), t);
    if (to) {
      const gt = glideTime ?? (attack + decay + hold + release);
      osc.frequency.exponentialRampToValueAtTime(Math.max(8, to), t + gt);
    }
    if (vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = vibrato.rate ?? 5.2;
      const lg = ctx.createGain();
      lg.gain.value = vibrato.depth ?? 6;    // cents
      lfo.connect(lg); lg.connect(osc.detune);
      lfo.start(t); lfo.stop(t + attack + hold + decay + release + 0.3);
    }

    const g = ctx.createGain();
    let end;
    if (hold || release) end = asr(g.gain, t, { peak, attack, hold, release: release || decay });
    else end = ad(g.gain, t, { peak, attack, decay, curve });

    let node = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type ?? 'lowpass';
      f.Q.value = filter.q ?? 1;
      f.frequency.setValueAtTime(Math.max(20, filter.freq ?? 1200), t);
      if (filter.to) f.frequency.exponentialRampToValueAtTime(Math.max(20, filter.to), end);
      node.connect(f); node = f;
    }
    node.connect(g);
    g.connect(this.#chan(dest, pan));

    osc.start(t);
    osc.stop(end + 0.06);
    return end;
  }

  /** Noise voice with a sweepable filter — the workhorse for texture. */
  noise(t, {
    colour = 'white', type = 'lowpass', freq = 1200, to = null, q = 0.9,
    peak = 0.2, attack = 0.004, decay = 0.3, hold = 0, release = 0,
    dest = null, pan = 0, curve = 'exp',
  } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise[colour] ?? this._noise.white;
    src.loop = true;
    src.playbackRate.value = rnd(0.92, 1.08);
    // random read offset so repeated hits never share the same noise grains
    const off = rnd(0, Math.max(0.01, src.buffer.duration - 0.6));

    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(20, freq), t);

    const g = ctx.createGain();
    let end;
    if (hold || release) end = asr(g.gain, t, { peak, attack, hold, release: release || decay });
    else end = ad(g.gain, t, { peak, attack, decay, curve });
    if (to) f.frequency.exponentialRampToValueAtTime(Math.max(20, to), end);

    src.connect(f); f.connect(g);
    g.connect(this.#chan(dest, pan));
    src.start(t, off);
    src.stop(end + 0.06);
    return end;
  }

  /**
   * Inverted-envelope swell: noise that grows into a cut-off. This is the
   * "something is about to happen" primitive — used for dread and for dark.
   */
  swell(t, { dur = 0.9, freq = 300, to = 2400, peak = 0.16, dest = null, pan = 0, colour = 'pink' } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise[colour] ?? this._noise.white;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0002, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.92);
    g.gain.exponentialRampToValueAtTime(0.0002, t + dur + 0.06);
    src.connect(f); f.connect(g);
    g.connect(this.#chan(dest, pan));
    src.start(t, rnd(0, 1));
    src.stop(t + dur + 0.15);
    return t + dur + 0.1;
  }

  /** Struck-metal partial stack — bells, rings, crystal. */
  bell(t, { freq = 660, peak = 0.12, decay = 1.4, dest = null, pan = 0, ratios = null, bright = 1 } = {}) {
    const r = ratios ?? [1, 2.01, 2.99, 4.21, 5.43, 6.79];
    let end = t;
    for (let i = 0; i < r.length; i++) {
      const p = peak * Math.pow(0.62, i) * (i > 2 ? bright : 1);
      if (p < 0.0015) break;
      end = Math.max(end, this.tone(t + i * 0.0016, {
        freq: freq * r[i] * cents(rnd(-6, 6)), shape: 'sine',
        peak: p, attack: 0.002, decay: decay * Math.pow(0.72, i), dest, pan,
      }));
    }
    return end;
  }

  /** Deep struck drum (procedural taiko) — pitch-dropping sine + skin noise. */
  drum(t, { freq = 92, peak = 0.32, decay = 0.55, dest = null, pan = 0 } = {}) {
    const f = freq * cents(rnd(-40, 40));
    this.tone(t, { freq: f * 2.1, to: f * 0.62, shape: 'sub', peak, attack: 0.001, decay, glideTime: decay * 0.5, dest, pan });
    this.noise(t, { colour: 'brown', type: 'lowpass', freq: 900, to: 180, peak: peak * 0.5, attack: 0.001, decay: decay * 0.35, dest, pan });
    this.noise(t, { colour: 'white', type: 'bandpass', freq: rnd(2200, 3200), q: 1.1, peak: peak * 0.13, attack: 0.0008, decay: 0.045, dest, pan });
    return t + decay + 0.1;
  }

  // -------------------------------------------------------------------------
  // Game cues
  // -------------------------------------------------------------------------

  /** Heavy stone block seated into a socket. Transient + mass + grit tail. */
  build(t, pan = 0) {
    const k = cents(rnd(-70, 70));
    // transient: chipped stone edge (kept dark — measured centroid was reading
    // brighter than "stone", the bright grain was doing that)
    this.noise(t, { colour: 'white', type: 'bandpass', freq: rnd(1700, 2500), q: 1.4, peak: 0.11, attack: 0.0008, decay: 0.035, pan });
    // mass: two pitch-dropping bodies a fifth apart = "heavy"
    this.tone(t + 0.004, { freq: 148 * k, to: 62 * k, shape: 'sub', peak: 0.34, attack: 0.002, decay: 0.34, glideTime: 0.11, pan });
    this.tone(t + 0.006, { freq: 232 * k, to: 96 * k, shape: 'metal', peak: 0.1, attack: 0.003, decay: 0.26, glideTime: 0.09, pan: pan * 0.6 });
    // grit: gravel settling
    this.noise(t + 0.01, { colour: 'brown', type: 'lowpass', freq: 1500, to: 260, peak: 0.24, attack: 0.004, decay: 0.42, pan });
    // tail: a faint arcane ring so it belongs to this world
    this.bell(t + 0.03, { freq: mtof(D + 12) * k, peak: 0.035, decay: 0.9, bright: 0.4, pan });
    return t + 0.75;
  }

  /** Rising harmonic shimmer — mass being added, power being bound in. */
  upgrade(t, pan = 0) {
    const root = mtof(D + 12) * cents(rnd(-15, 15));
    const steps = [0, 3, 7, 12];          // minor triad + octave
    for (let i = 0; i < steps.length; i++) {
      const tt = t + i * 0.075;
      const f = root * Math.pow(2, steps[i] / 12);
      this.tone(tt, { freq: f, shape: 'glass', peak: 0.13 - i * 0.012, attack: 0.008, decay: 0.5 + i * 0.12, pan: pan + (i - 1.5) * 0.12 });
      this.bell(tt, { freq: f * 2, peak: 0.055, decay: 0.7, bright: 1.1, pan });
      // an octave of air above each step — this is the "shimmer" part
      this.tone(tt + 0.01, { freq: f * 4, shape: 'sine', peak: 0.03, attack: 0.004, decay: 0.35 + i * 0.1, pan: -pan });
    }
    // sub swell underneath: the tower gets heavier
    this.tone(t, { freq: mtof(D - 12), shape: 'sub', peak: 0.16, attack: 0.09, hold: 0.12, release: 0.5, pan });
    // filtered noise riser
    this.swell(t, { dur: 0.42, freq: 900, to: 9500, peak: 0.075, colour: 'pink', pan });
    this.bell(t + 0.31, { freq: root * 4, peak: 0.065, decay: 1.6, bright: 1.4, pan });
    return t + 1.5;
  }

  /** Dismantle: stone released, value returned. Descending, dusty. */
  sell(t, pan = 0) {
    const root = mtof(D + 12);
    this.noise(t, { colour: 'brown', type: 'lowpass', freq: 2200, to: 420, peak: 0.2, attack: 0.006, decay: 0.34, pan });
    [12, 7, 3, 0].forEach((s, i) => {
      this.tone(t + i * 0.055, {
        freq: root * Math.pow(2, s / 12) * cents(rnd(-8, 8)), shape: 'glass',
        peak: 0.11 - i * 0.01, attack: 0.004, decay: 0.28, pan: pan - (i - 1.5) * 0.1,
      });
    });
    this.tone(t + 0.02, { freq: 120, to: 74, shape: 'sub', peak: 0.19, attack: 0.004, decay: 0.3, glideTime: 0.16, pan });
    return t + 0.7;
  }

  /** UI tick. Deliberately tiny — it fires constantly. */
  select(t, pan = 0) {
    const f = mtof(D + 24) * cents(rnd(-25, 25));
    this.tone(t, { freq: f, shape: 'glass', peak: 0.08, attack: 0.001, decay: 0.075, pan });
    this.tone(t, { freq: f * 1.5, shape: 'sine', peak: 0.03, attack: 0.001, decay: 0.05, pan });
    this.noise(t, { colour: 'white', type: 'highpass', freq: 5200, peak: 0.03, attack: 0.0005, decay: 0.02, pan });
    return t + 0.12;
  }

  /** Refusal. A muted minor second — wrong, but not painful. */
  deny(t, pan = 0) {
    const f = mtof(D + 5);
    this.tone(t, { freq: f, shape: 'reed', peak: 0.11, attack: 0.004, decay: 0.2, filter: { type: 'lowpass', freq: 1400, to: 500 }, pan });
    this.tone(t + 0.008, { freq: f * Math.pow(2, 1 / 12), shape: 'reed', peak: 0.09, attack: 0.004, decay: 0.18, filter: { type: 'lowpass', freq: 1200, to: 450 }, pan });
    this.tone(t, { freq: 96, to: 70, shape: 'sub', peak: 0.14, attack: 0.002, decay: 0.16, glideTime: 0.1, pan });
    this.noise(t, { colour: 'brown', type: 'lowpass', freq: 700, peak: 0.06, attack: 0.002, decay: 0.1, pan });
    return t + 0.4;
  }

  /** A creep unmakes itself. Small, dry, heavily randomised. */
  death(t, pan = 0) {
    const f = rnd(300, 560);
    this.noise(t, { colour: 'white', type: 'bandpass', freq: f * rnd(3, 5), q: rnd(0.8, 2.2), peak: 0.15, attack: 0.001, decay: rnd(0.07, 0.15), pan });
    this.tone(t, { freq: f, to: f * rnd(0.35, 0.55), shape: 'metal', peak: 0.11, attack: 0.002, decay: rnd(0.11, 0.2), glideTime: 0.07, pan });
    this.noise(t + 0.01, { colour: 'brown', type: 'lowpass', freq: rnd(500, 900), peak: 0.1, attack: 0.003, decay: 0.16, pan });
    return t + 0.35;
  }

  /** A boss unmakes itself. This should feel like architecture collapsing. */
  bossDeath(t, pan = 0) {
    // crack
    this.noise(t, { colour: 'white', type: 'bandpass', freq: 3400, q: 1.2, peak: 0.22, attack: 0.001, decay: 0.09, pan });
    // sub drop
    this.tone(t, { freq: 110, to: 26, shape: 'sub', peak: 0.4, attack: 0.006, decay: 1.7, glideTime: 0.9, pan });
    // roar
    this.noise(t + 0.02, { colour: 'brown', type: 'lowpass', freq: 2600, to: 130, peak: 0.3, attack: 0.02, decay: 1.5, pan });
    // shatter sparkle raining down
    for (let i = 0; i < 7; i++) {
      this.bell(t + 0.05 + i * rnd(0.03, 0.12), {
        freq: mtof(D + 24 + [0, 3, 7, 10, 12][i % 5]) * cents(rnd(-20, 20)),
        peak: 0.035, decay: rnd(0.5, 1.2), bright: 1.1, pan: rnd(-0.7, 0.7),
      });
    }
    // the hall answering
    this.tone(t + 0.12, { freq: mtof(D - 12), shape: 'choir', peak: 0.09, attack: 0.25, hold: 0.4, release: 1.6, pan });
    this.tone(t + 0.12, { freq: mtof(D - 12 + 7), shape: 'choir', peak: 0.06, attack: 0.3, hold: 0.4, release: 1.6, pan: -pan });
    return t + 2.6;
  }

  /** Something got through. Sickening: dull, detuned, tritone. */
  leak(t, pan = 0) {
    this.tone(t, { freq: 86, to: 41, shape: 'sub', peak: 0.42, attack: 0.004, decay: 1.0, glideTime: 0.5, pan });
    // dropping tritone dyad = the sound of being wrong
    this.tone(t + 0.01, { freq: mtof(D), to: mtof(D - 12), shape: 'reed', peak: 0.14, attack: 0.008, decay: 0.7, glideTime: 0.55, filter: { type: 'lowpass', freq: 900, to: 280 }, pan });
    this.tone(t + 0.015, { freq: mtof(D + 6), to: mtof(D - 7), shape: 'reed', peak: 0.11, attack: 0.01, decay: 0.75, glideTime: 0.6, filter: { type: 'lowpass', freq: 800, to: 240 }, pan: -pan });
    // wet impact
    this.noise(t, { colour: 'brown', type: 'lowpass', freq: 900, to: 120, peak: 0.3, attack: 0.003, decay: 0.55, pan });
    this.noise(t, { colour: 'white', type: 'bandpass', freq: 1500, q: 0.7, peak: 0.09, attack: 0.001, decay: 0.06, pan });
    return t + 1.3;
  }

  /** The gate opens. A two-note modal call over a war drum. */
  waveStart(t, pan = 0) {
    this.drum(t, { freq: 78, peak: 0.26, decay: 0.6 });
    const a = mtof(D + 7), d = mtof(D + 12);
    this.tone(t + 0.03, { freq: a, shape: 'brass', peak: 0.11, attack: 0.03, hold: 0.16, release: 0.4, filter: { type: 'lowpass', freq: 2400, to: 1100 }, vibrato: { rate: 4.6, depth: 5 }, pan: -0.18 });
    this.tone(t + 0.26, { freq: d, shape: 'brass', peak: 0.12, attack: 0.03, hold: 0.24, release: 0.6, filter: { type: 'lowpass', freq: 2600, to: 1000 }, vibrato: { rate: 4.9, depth: 6 }, pan: 0.18 });
    this.tone(t + 0.26, { freq: mtof(D - 12), shape: 'sub', peak: 0.16, attack: 0.02, hold: 0.3, release: 0.5 });
    this.drum(t + 0.26, { freq: 92, peak: 0.18, decay: 0.45 });
    return t + 1.3;
  }

  /** Boss horn. Must be genuinely alarming without being a jump scare. */
  bossHorn(t, pan = 0) {
    // air before the note
    this.swell(t, { dur: 0.45, freq: 180, to: 900, peak: 0.09, colour: 'brown' });
    const root = mtof(D - 12);
    // cluster: root, fifth, and the Phrygian flat-2 grinding against it
    const layers = [
      { f: root, p: 0.17, det: 0 },
      { f: root * Math.pow(2, 7 / 12), p: 0.12, det: -9 },
      { f: root * 2, p: 0.085, det: 7 },
      { f: root * Math.pow(2, 13 / 12), p: 0.055, det: 4 },   // b9 — the dread
    ];
    for (const l of layers) {
      this.tone(t + 0.3, {
        freq: l.f * 0.985, to: l.f, shape: 'brass', peak: l.p, detune: l.det,
        attack: 0.16, hold: 1.0, release: 1.1, glideTime: 0.5,
        filter: { type: 'lowpass', freq: 700, to: 2600 },
        vibrato: { rate: 4.2, depth: 9 }, pan: rnd(-0.3, 0.3),
      });
    }
    // second, higher call answering
    this.tone(t + 1.1, {
      freq: root * Math.pow(2, 10 / 12), shape: 'brass', peak: 0.1,
      attack: 0.1, hold: 0.7, release: 0.9,
      filter: { type: 'lowpass', freq: 1600, to: 2800 }, vibrato: { rate: 5, depth: 12 }, pan: 0.25,
    });
    // war drums
    this.drum(t + 0.3, { freq: 62, peak: 0.3, decay: 0.9 });
    this.drum(t + 1.05, { freq: 58, peak: 0.24, decay: 0.9 });
    this.drum(t + 1.5, { freq: 54, peak: 0.28, decay: 1.1 });
    // subterranean shudder
    this.tone(t + 0.28, { freq: 33, shape: 'sub', peak: 0.3, attack: 0.2, hold: 1.4, release: 1.2 });
    return t + 3.2;
  }

  /** Wave survived. A real cadence: v -> i, warm, brief. */
  waveClear(t, pan = 0) {
    const chords = [
      [D + 12 + 7, D + 12 + 10, D + 24 + 2],   // A C E  (v)
      [D + 12, D + 12 + 7, D + 24 + 3],        // D A F  (i)
    ];
    chords.forEach((ch, ci) => {
      const tt = t + ci * 0.26;
      ch.forEach((n, i) => {
        this.tone(tt + i * 0.012, {
          freq: mtof(n) * cents(rnd(-6, 6)), shape: 'glass',
          peak: 0.085 - i * 0.012, attack: 0.01, decay: ci ? 1.1 : 0.4,
          pan: (i - 1) * 0.25,
        });
      });
      this.bell(tt, { freq: mtof(ch[0] + 12), peak: 0.04, decay: ci ? 1.5 : 0.6, bright: 0.8 });
    });
    this.tone(t + 0.26, { freq: mtof(D - 12), shape: 'sub', peak: 0.13, attack: 0.05, hold: 0.4, release: 0.8 });
    this.swell(t, { dur: 0.24, freq: 900, to: 5200, peak: 0.035 });
    return t + 1.9;
  }

  /** An element is bound. Crystalline bloom, mysterious rather than cheerful. */
  elementPick(t, pan = 0) {
    const notes = [D, D + 7, D + 12, D + 15, D + 19, D + 24];
    notes.forEach((n, i) => {
      const tt = t + i * 0.085;
      this.tone(tt, { freq: mtof(n) * cents(rnd(-8, 8)), shape: 'glass', peak: 0.075 - i * 0.007, attack: 0.02, decay: 1.2 + i * 0.15, pan: rnd(-0.4, 0.4) });
      if (i > 1) this.bell(tt, { freq: mtof(n + 12), peak: 0.03, decay: 1.4, bright: 1 });
    });
    this.tone(t, { freq: mtof(D - 12), shape: 'choir', peak: 0.075, attack: 0.35, hold: 0.7, release: 1.4 });
    this.tone(t + 0.1, { freq: mtof(D - 12 + 7), shape: 'choir', peak: 0.05, attack: 0.4, hold: 0.7, release: 1.4, pan: 0.3 });
    this.swell(t, { dur: 0.6, freq: 500, to: 7000, peak: 0.04 });
    return t + 2.6;
  }

  /** Victory: D minor resolving to D major (picardy third). Earned, not cute. */
  victory(t) {
    const seq = [
      { ch: [D, D + 7, D + 15], d: 0 },          // i
      { ch: [D - 2, D + 5, D + 12], d: 0.5 },    // VII
      { ch: [D + 3, D + 10, D + 19], d: 1.0 },   // III
      { ch: [D, D + 7, D + 16], d: 1.55 },       // I  (major third)
    ];
    for (const s of seq) {
      const tt = t + s.d;
      s.ch.forEach((n, i) => {
        this.tone(tt + i * 0.01, { freq: mtof(n), shape: 'brass', peak: 0.1 - i * 0.012, attack: 0.03, hold: 0.3, release: 0.7, filter: { type: 'lowpass', freq: 1800, to: 3200 }, vibrato: { rate: 5, depth: 6 }, pan: (i - 1) * 0.3 });
        this.tone(tt + i * 0.01, { freq: mtof(n + 12), shape: 'choir', peak: 0.045, attack: 0.08, hold: 0.35, release: 0.9, pan: (1 - i) * 0.3 });
      });
      this.tone(tt, { freq: mtof(s.ch[0] - 24), shape: 'sub', peak: 0.16, attack: 0.02, hold: 0.3, release: 0.5 });
      this.drum(tt, { freq: 70, peak: 0.2, decay: 0.5 });
    }
    for (let i = 0; i < 9; i++) {
      this.bell(t + 1.55 + i * rnd(0.05, 0.16), { freq: mtof(D + 24 + [0, 4, 7, 11, 12][i % 5]), peak: 0.03, decay: rnd(1, 2.2), pan: rnd(-0.8, 0.8) });
    }
    return t + 4.2;
  }

  /** Defeat: chromatic collapse into a sub that will not stop. */
  gameover(t) {
    const fall = [D, D - 1, D - 3, D - 5];
    fall.forEach((n, i) => {
      const tt = t + i * 0.45;
      this.tone(tt, { freq: mtof(n), shape: 'brass', peak: 0.11, attack: 0.05, hold: 0.35, release: 0.8, filter: { type: 'lowpass', freq: 1400, to: 420 }, vibrato: { rate: 3.4, depth: 10 }, pan: -0.2 });
      this.tone(tt + 0.02, { freq: mtof(n - 12) * 1.005, shape: 'reed', peak: 0.08, attack: 0.06, hold: 0.35, release: 0.9, filter: { type: 'lowpass', freq: 900, to: 300 }, pan: 0.2 });
      this.tone(tt, { freq: mtof(n - 24), shape: 'sub', peak: 0.2, attack: 0.03, hold: 0.4, release: 0.7 });
    });
    this.noise(t + 1.4, { colour: 'brown', type: 'lowpass', freq: 500, to: 90, peak: 0.2, attack: 0.6, decay: 2.4 });
    this.tone(t + 1.6, { freq: mtof(D - 24), shape: 'choir', peak: 0.07, attack: 0.8, hold: 0.8, release: 2.2 });
    this.tone(t + 1.6, { freq: mtof(D - 24 + 1), shape: 'choir', peak: 0.045, attack: 1.0, hold: 0.8, release: 2.2, pan: 0.4 });
    return t + 5.0;
  }

  // -------------------------------------------------------------------------
  // Element-flavoured combat impacts
  // -------------------------------------------------------------------------

  /**
   * @param {string} el   element or dual id
   * @param {number} k    intensity 0..1
   * @param {number} t    absolute start time
   * @param {number} pan  -1..1
   */
  impact(el, k, t, pan = 0) {
    const parents = DUAL_PARENTS[el];
    if (parents) {
      // 0.66, not 0.72: measurement showed duals summing ~2 dB hotter than the
      // single elements, which made magma/crystal stick out of the mix.
      this.#elemHit(parents[0], k * 0.66, t, pan);
      this.#elemHit(parents[1], k * 0.66, t + rnd(0.004, 0.016), pan * -0.6);
      return t + 1.0;
    }
    return this.#elemHit(el, k, t, pan);
  }

  #elemHit(el, k, t, pan) {
    // Loudness trim, derived from measurement: a raw pass showed a 15 dB spread
    // between nature (0.049 peak) and dark (0.271). These factors flatten the
    // six elements to roughly equal perceived level so no element dominates.
    const TRIM = { fire: 1.8, water: 1.45, nature: 1.75, earth: 0.85, light: 1.2, dark: 0.68 };
    const v = clamp(k, 0.15, 1) * (TRIM[el] ?? 1);
    switch (el) {
      case 'fire': {
        // crackle: a scatter of tiny bandpassed grains over a breathy body
        const n = 3 + ((Math.random() * 4) | 0);
        for (let i = 0; i < n; i++) {
          this.noise(t + rnd(0, 0.09), { colour: 'white', type: 'bandpass', freq: rnd(1800, 5200), q: rnd(4, 12), peak: 0.055 * v, attack: 0.0008, decay: rnd(0.015, 0.05), pan: pan + rnd(-0.2, 0.2) });
        }
        this.noise(t, { colour: 'pink', type: 'bandpass', freq: 900, to: 2600, q: 0.7, peak: 0.1 * v, attack: 0.004, decay: 0.24, pan });
        this.tone(t, { freq: rnd(150, 190), to: 70, shape: 'sub', peak: 0.13 * v, attack: 0.002, decay: 0.2, glideTime: 0.08, pan });
        return t + 0.45;
      }
      case 'water': {
        // burble: quick random pitch wobble + a droplet ping
        const f = rnd(320, 520);
        this.tone(t, { freq: f, to: f * rnd(1.6, 2.4), shape: 'sine', peak: 0.09 * v, attack: 0.004, decay: 0.13, glideTime: 0.1, pan });
        this.tone(t + 0.035, { freq: f * rnd(0.6, 0.8), to: f * 1.5, shape: 'sine', peak: 0.06 * v, attack: 0.003, decay: 0.1, glideTime: 0.08, pan: -pan });
        this.noise(t, { colour: 'white', type: 'bandpass', freq: 2600, to: 900, q: 1.6, peak: 0.06 * v, attack: 0.002, decay: 0.2, pan });
        this.tone(t + 0.01, { freq: 120, to: 78, shape: 'sub', peak: 0.09 * v, attack: 0.003, decay: 0.2, glideTime: 0.1 });
        return t + 0.4;
      }
      case 'nature': {
        // leaf/spore burst up top …
        this.noise(t, { colour: 'pink', type: 'bandpass', freq: rnd(1800, 3000), q: 1.1, peak: 0.09 * v, attack: 0.002, decay: 0.16, pan });
        this.tone(t, { freq: rnd(420, 620), to: rnd(260, 340), shape: 'metal', peak: 0.06 * v, attack: 0.002, decay: 0.14, glideTime: 0.06, pan });
        // … over an actual body. Measured RMS was a third of every other
        // element, which read as thin rather than light.
        this.noise(t + 0.02, { colour: 'brown', type: 'lowpass', freq: 900, to: 300, peak: 0.1 * v, attack: 0.004, decay: 0.3, pan });
        this.tone(t + 0.01, { freq: rnd(150, 190), to: rnd(88, 104), shape: 'sub', peak: 0.09 * v, attack: 0.003, decay: 0.26, glideTime: 0.1, pan });
        return t + 0.5;
      }
      case 'earth': {
        this.tone(t, { freq: rnd(96, 128), to: rnd(38, 46), shape: 'sub', peak: 0.26 * v, attack: 0.002, decay: 0.42, glideTime: 0.14, pan });
        this.noise(t, { colour: 'brown', type: 'lowpass', freq: 1200, to: 170, peak: 0.16 * v, attack: 0.002, decay: 0.34, pan });
        for (let i = 0; i < 4; i++) {
          this.noise(t + 0.04 + rnd(0, 0.18), { colour: 'white', type: 'bandpass', freq: rnd(700, 2200), q: 3, peak: 0.03 * v, attack: 0.001, decay: 0.04, pan: pan + rnd(-0.3, 0.3) });
        }
        return t + 0.6;
      }
      case 'light': {
        const f = mtof(D + 24 + [0, 3, 7, 10][(Math.random() * 4) | 0]);
        this.bell(t, { freq: f * cents(rnd(-14, 14)), peak: 0.075 * v, decay: 0.85, bright: 1.2, ratios: [1, 2, 3, 4.6, 6.2], pan });
        this.noise(t, { colour: 'white', type: 'highpass', freq: 5200, peak: 0.045 * v, attack: 0.001, decay: 0.09, pan });
        this.tone(t, { freq: f * 0.5, shape: 'glass', peak: 0.045 * v, attack: 0.004, decay: 0.5, pan: -pan });
        return t + 0.9;
      }
      case 'dark': {
        // swallow: inverted envelope, then an abrupt stop
        this.swell(t, { dur: 0.2, freq: 2400, to: 260, peak: 0.09 * v, colour: 'pink', pan });
        this.tone(t + 0.02, { freq: rnd(190, 240), to: 44, shape: 'reed', peak: 0.12 * v, attack: 0.05, decay: 0.3, glideTime: 0.24, filter: { type: 'lowpass', freq: 1600, to: 260 }, pan });
        this.tone(t + 0.02, { freq: 62, shape: 'sub', peak: 0.14 * v, attack: 0.03, decay: 0.34, pan });
        this.noise(t + 0.24, { colour: 'brown', type: 'lowpass', freq: 400, peak: 0.05 * v, attack: 0.002, decay: 0.18, pan });
        return t + 0.6;
      }
      default:
        // Unknown element: fall back to a generic heavy hit. Pass the raw `k`,
        // not `v`, so the earth trim is not applied twice.
        return this.#elemHit('earth', clamp(k, 0.15, 1) * 0.7, t, pan);
    }
  }

  /** Light muzzle cue when a tower fires. Deliberately near-subliminal. */
  shot(el, k, t, pan = 0) {
    const v = clamp(k, 0.1, 1) * 0.45;
    const base = DUAL_PARENTS[el] ? DUAL_PARENTS[el][0] : el;
    const f = { fire: 340, water: 520, nature: 620, earth: 190, light: 880, dark: 240 }[base] ?? 400;
    this.tone(t, { freq: f * cents(rnd(-90, 90)), to: f * rnd(1.5, 2.2), shape: 'glass', peak: 0.05 * v, attack: 0.001, decay: 0.07, glideTime: 0.05, pan });
    this.noise(t, { colour: 'white', type: 'bandpass', freq: f * 4, q: 2.2, peak: 0.04 * v, attack: 0.0008, decay: 0.045, pan });
    return t + 0.15;
  }
}
