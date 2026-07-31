/**
 * Music.js — the adaptive score.
 *
 * HARMONIC PLAN
 * -------------
 * Everything lives in **D natural minor (Aeolian)**: D E F G A B♭ C.
 * Boss material borrows the **Phrygian ♭2 (E♭)**, which is the single cheapest
 * way to make a mode sound like something is wrong.
 *
 *   calm     i  – VI – III – VII      (suspended, unresolved, patient)
 *   combat   i  – VII – VI – VII      (driving, no cadence, keeps pushing)
 *   boss     i  – ♭II – i  – v        (Phrygian dread; ♭II grinds on the tonic)
 *   cadence  iv – i                   (plagal resolution on wave clear)
 *
 * Chords are realised through a **voice-leading** step: each new chord picks
 * the octave placement of every voice nearest to where that voice already was,
 * so the pad glides between chords instead of jumping. That is the difference
 * between "a score" and "random tones".
 *
 * LAYERS (all present at all times; only their gains cross-fade)
 * -------------------------------------------------------------
 *   0 pad     reed+choir chord bed, filter opens with intensity   always
 *   1 sub     tonic pedal, then a pulsing heartbeat                0.15 → 0.40
 *   2 arp     glass 16th-note figure through the chord             0.28 → 0.55
 *   3 perc    procedural taiko + ash ticks                         0.45 → 0.70
 *   4 choir   sustained upper voice, the "epic" layer              0.62 → 0.88
 *   5 dread   boss-only: low brass ♭2 cluster + tritone motif      boss mode
 *
 * INTENSITY STATES (0..1, smoothed — never a hard cut)
 * ----------------------------------------------------
 *   0.10  prep / idle          0.55  wave spawned
 *   +heat combat pressure (each kill adds heat, heat decays ~6 s)
 *   0.95  boss engaged         0.16  wave cleared (after the cadence)
 *
 * The director is entirely self-driving: it runs its own look-ahead scheduler
 * on a timer and takes its cues from the `play()` calls the game already makes.
 */
import { mtof, wave, ad, asr, rnd, clamp, lerp, fade, cents } from './dsp.js';

const D = 50;                 // MIDI D3 — tonal centre

// Chords as semitone offsets from D, low voice first.
const CH = {
  i:    [0, 3, 7],            // D  F  A
  VI:   [8, 12, 15],          // B♭ D  F
  III:  [3, 7, 10],           // F  A  C
  VII:  [10, 14, 17],         // C  E  G
  iv:   [5, 8, 12],           // G  B♭ D
  v:    [7, 10, 14],          // A  C  E
  bII:  [1, 5, 8],            // E♭ G  B♭   (Phrygian)
};

const PROG = {
  calm:   ['i', 'VI', 'III', 'VII'],
  combat: ['i', 'VII', 'VI', 'VII'],
  boss:   ['i', 'bII', 'i', 'v'],
  cadence: ['iv', 'i'],
};

// 16-step arpeggio masks; index = intensity tier.
const ARP_MASKS = [
  0b1000000010000000,
  0b1000100010001000,
  0b1010100010101000,
  0b1010101010101010,
];

export class Music {
  constructor(ctx, mixer, sfx) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.sfx = sfx;

    this.intensity = 0.06;
    this.target = 0.10;
    this.heat = 0;
    this.mode = 'calm';         // calm | combat | boss
    this._cadence = 0;          // bars of plagal cadence queued
    this._bar = 0;
    this._step = 0;
    this._voicing = [D, D + 3, D + 7];
    this._enabled = true;

    this.bpm = 78;
    this.stepDur = 60 / this.bpm / 4;

    // --- layer graph ------------------------------------------------------
    this.root = ctx.createGain();          // fade in / out only
    this.root.gain.value = 0.0001;
    this.root.connect(mixer.music.input);

    // Overall score level tracks intensity, so prep really is quieter than
    // heavy combat — before this existed, the states differed only in timbre
    // and measured within 1 dB of each other.
    this.level = ctx.createGain();
    this.level.gain.value = 0.4;
    this.level.connect(this.root);

    const L = (name, gain = 0) => {
      const g = ctx.createGain();
      g.gain.value = gain;
      g.connect(this.level);
      this.layers[name] = g;
      return g;
    };
    this.layers = {};
    L('pad', 0.9); L('sub', 0.0); L('arp', 0.0);
    L('perc', 0.0); L('choir', 0.0); L('dread', 0.0);

    // The pad runs through a shared filter that opens as things get worse.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 460;
    this.padFilter.Q.value = 0.6;
    this.padFilter.connect(this.layers.pad);

    this._t = 0;                 // next step time
    this._timer = null;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  start(at = this.ctx.currentTime + 0.15) {
    this._t = at;
    this._bar = 0;
    this._step = 0;
    // Long musical fade-in: the score should arrive, not switch on.
    const g = this.root.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(0.0001, at);
    g.exponentialRampToValueAtTime(0.55, at + 7);
    if (typeof setInterval === 'function' && !this._timer) {
      this._timer = setInterval(() => this.tick(), 25);
    }
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const t = this.ctx.currentTime;
    this.root.gain.cancelScheduledValues(t);
    this.root.gain.setTargetAtTime(0.0001, t, 0.4);
  }

  /** Scheduler heartbeat — schedules every step falling inside the horizon. */
  tick(horizon = 0.4) {
    if (!this._enabled) return;
    const now = this.ctx.currentTime;
    this.#smooth(0.025);
    let guard = 0;
    while (this._t < now + horizon && guard++ < 256) {
      this.#scheduleStep(this._t, this._step);
      this._step++;
      if (this._step % 16 === 0) this.#nextBar();
      this._t += this.stepDur;
    }
  }

  /** Offline/deterministic driving: render `bars` bars starting at `from`. */
  renderBars(from, bars) {
    this._t = from;
    for (let s = 0; s < bars * 16; s++) {
      this.#scheduleStep(this._t, this._step);
      this._step++;
      if (this._step % 16 === 0) this.#nextBar();
      this._t += this.stepDur;
    }
    return this._t;
  }

  #nextBar() {
    this._bar++;
    if (this._cadence > 0) this._cadence--;
    // Tempo only ever changes at a bar line so nothing stutters.
    const bpm = lerp(76, 96, clamp(this.intensity, 0, 1));
    this.bpm = bpm;
    this.stepDur = 60 / bpm / 4;
  }

  // -------------------------------------------------------------------------
  // Intensity model
  // -------------------------------------------------------------------------

  #smooth(dt) {
    this.heat = Math.max(0, this.heat - dt * 0.16);
    const base = this.mode === 'boss' ? 0.78 : this.target;
    const want = clamp(base + this.heat * 0.35, 0, 1);
    // Rises fast (tension should arrive), falls slowly (release should linger).
    const k = want > this.intensity ? 0.85 : 0.22;
    this.intensity += (want - this.intensity) * clamp(dt * k * 6, 0, 1);
    this.applyLayerGains();
  }

  /**
   * Force the intensity (used by the offline analysis harness and by anything
   * that wants to jump the score somewhere without waiting for the smoother).
   */
  setIntensity(x, immediate = true) {
    this.intensity = clamp(x, 0, 1);
    this.target = this.intensity;
    if (immediate) {
      const t = this.ctx.currentTime;
      const set = (n, v) => { this.layers[n].gain.cancelScheduledValues(t); this.layers[n].gain.setValueAtTime(v, t); };
      this.applyLayerGains();
      // also snap, so an offline render does not spend a second fading in
      set('pad', lerp(0.85, 0.62, this.intensity));
      set('sub', fade(this.intensity, 0.15, 0.40) * 0.85);
      set('arp', fade(this.intensity, 0.28, 0.55) * 0.7);
      set('perc', fade(this.intensity, 0.45, 0.70) * 0.8);
      set('choir', fade(this.intensity, 0.62, 0.88) * 0.6);
      set('dread', this.mode === 'boss' ? 0.75 : 0);
      this.level.gain.cancelScheduledValues(t);
      this.level.gain.setValueAtTime(lerp(0.30, 0.85, this.intensity), t);
      this.root.gain.cancelScheduledValues(t);
      this.root.gain.setValueAtTime(0.55, t);
      this.padFilter.frequency.cancelScheduledValues(t);
      this.padFilter.frequency.setValueAtTime(lerp(380, 2600, Math.pow(this.intensity, 1.4)), t);
    }
  }

  applyLayerGains() {
    const x = this.intensity;
    const t = this.ctx.currentTime;
    const set = (name, v) => {
      const g = this.layers[name].gain;
      if (Math.abs(g.value - v) < 0.002) return;
      g.setTargetAtTime(v, t, 0.35);
    };
    set('pad', lerp(0.85, 0.62, x));
    set('sub', fade(x, 0.15, 0.40) * 0.85);
    set('arp', fade(x, 0.28, 0.55) * 0.7);
    set('perc', fade(x, 0.45, 0.70) * 0.8);
    set('choir', fade(x, 0.62, 0.88) * 0.6);
    set('dread', this.mode === 'boss' ? 0.75 : 0);
    this.level.gain.setTargetAtTime(lerp(0.30, 0.85, x), t, 0.6);
    this.padFilter.frequency.setTargetAtTime(lerp(380, 2600, Math.pow(x, 1.4)), t, 0.5);
  }

  /** Called by AudioEngine when the game reports state through play(). */
  setState(mode, target) {
    this.mode = mode;
    if (target != null) this.target = target;
    this.applyLayerGains();
  }

  /** Combat pressure — each kill nudges the score up, then it settles. */
  addHeat(v = 0.12) { this.heat = clamp(this.heat + v, 0, 1.6); }

  /** Queue a plagal cadence (iv – i) for the next two bars. */
  cadence() { this._cadence = 2; }

  // -------------------------------------------------------------------------
  // Harmony
  // -------------------------------------------------------------------------

  #chordForBar(bar) {
    if (this._cadence > 0) return CH[PROG.cadence[(2 - this._cadence) % 2]];
    const prog = PROG[this.mode] ?? PROG.calm;
    return CH[prog[bar % prog.length]];
  }

  /**
   * Voice leading: place each chord tone in the octave nearest to where that
   * voice currently sits. Keeps common tones static and moves the rest by step.
   */
  #voiceLead(offsets) {
    const prev = this._voicing;
    const pcOf = (m) => ((m % 12) + 12) % 12;
    const pcs = offsets.map((o) => pcOf(D + o));
    const LO = D - 7, HI = D + 24;

    // Realise one assignment of pitch classes to voices, low to high, keeping
    // each voice at least a whole tone above the one below (no unisons, no
    // crossings) and as close as possible to where that voice already was.
    const realise = (assign) => {
      const out = [];
      let floor = LO;
      let cost = 0;
      for (let i = 0; i < assign.length; i++) {
        const pc = assign[i];
        const anchor = clamp(prev[i] ?? (D + offsets[i]), floor, HI);
        let best = null, bestD = 1e9;
        for (let m = floor; m <= HI; m++) {
          if (pcOf(m) !== pc) continue;
          const d = Math.abs(m - anchor);
          if (d < bestD) { bestD = d; best = m; }
        }
        if (best == null) return null;
        cost += Math.abs(best - (prev[i] ?? best));
        out.push(best);
        floor = best + 2;
      }
      return { out, cost };
    };

    // Try every assignment (i.e. every inversion). Root position is rarely the
    // smoothest option — allowing inversions is what turns parallel planing
    // into actual voice leading, and it measured 4.7 -> ~1.3 semitones of
    // average motion per chord.
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let best = null;
    for (const p of perms) {
      if (p.length !== pcs.length) continue;
      const r = realise(p.map((i) => pcs[i]));
      if (r && (!best || r.cost < best.cost)) best = r;
    }
    const out = best ? best.out : pcs.map((pc, i) => D + offsets[i]);
    this._voicing = out;
    return out;
  }

  // -------------------------------------------------------------------------
  // Step rendering
  // -------------------------------------------------------------------------

  #scheduleStep(t, step) {
    const inBar = step % 16;
    const bar = Math.floor(step / 16);
    const x = this.intensity;

    if (inBar === 0) {
      const voicing = this.#voiceLead(this.#chordForBar(bar));
      this.#pad(t, voicing);
      this.#subPedal(t, voicing[0]);
      if (x > 0.6) this.#choir(t, voicing);
      if (this.mode === 'boss') this.#dread(t, bar, voicing);
    }

    // --- sub heartbeat ----------------------------------------------------
    if (x > 0.2) {
      const beat = inBar % 4 === 0;
      if (beat && (inBar === 0 || inBar === 8 || x > 0.5)) {
        this.#pulse(t, this._voicing[0] - 24, 0.2 + x * 0.2);
      }
    }

    // --- percussion -------------------------------------------------------
    if (x > 0.42) {
      const heavy = x > 0.72;
      if (inBar === 0 || inBar === 6 || (heavy && inBar === 10)) {
        this.sfx.drum(t, { freq: inBar === 0 ? 62 : 74, peak: (0.13 + x * 0.14), decay: 0.5, dest: this.layers.perc });
      }
      if (inBar === 8) {
        this.sfx.noise(t, {
          colour: 'white', type: 'bandpass', freq: rnd(3200, 4600), q: 1.3,
          peak: 0.05 * x, attack: 0.001, decay: 0.09, dest: this.layers.perc, pan: rnd(-0.4, 0.4),
        });
      }
      if (heavy && inBar % 4 === 2) {
        this.sfx.noise(t + rnd(0, 0.006), {
          colour: 'pink', type: 'highpass', freq: 5200,
          peak: 0.025 * x, attack: 0.001, decay: 0.05, dest: this.layers.perc, pan: rnd(-0.6, 0.6),
        });
      }
    }

    // --- arpeggio ---------------------------------------------------------
    if (x > 0.26) {
      const tier = clamp(Math.floor(fade(x, 0.26, 0.95) * 3.999), 0, 3);
      const mask = ARP_MASKS[tier];
      if (mask & (1 << (15 - inBar))) {
        const v = this._voicing;
        const seq = [v[0] + 12, v[1] + 12, v[2] + 12, v[1] + 24, v[2] + 12, v[0] + 24];
        const n = seq[(step * 3 + bar) % seq.length];
        this.#pluck(t, n, 0.055 + x * 0.045);
      }
    }
  }

  #pad(t, voicing) {
    const dur = this.stepDur * 16;
    for (let i = 0; i < voicing.length; i++) {
      const f = mtof(voicing[i]) * cents(rnd(-5, 5));
      for (const [shape, mul, amp] of [['reed', 1, 0.1], ['reed', 1.002, 0.075], ['choir', 2, 0.035]]) {
        const osc = this.ctx.createOscillator();
        osc.setPeriodicWave(wave(this.ctx, shape));
        osc.frequency.value = f * mul;
        osc.detune.value = rnd(-7, 7);
        const g = this.ctx.createGain();
        // overlapping envelopes -> a continuous bed, not a chopped one
        asr(g.gain, t, { peak: amp * (1 - i * 0.18), attack: dur * 0.35, hold: dur * 0.3, release: dur * 0.6 });
        osc.connect(g); g.connect(this.padFilter);
        osc.start(t);
        osc.stop(t + dur * 1.4);
      }
    }
  }

  #subPedal(t, low) {
    const dur = this.stepDur * 16;
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(wave(this.ctx, 'sub'));
    osc.frequency.value = mtof(low - 24);
    const g = this.ctx.createGain();
    asr(g.gain, t, { peak: 0.16, attack: dur * 0.25, hold: dur * 0.4, release: dur * 0.5 });
    osc.connect(g); g.connect(this.layers.sub);
    osc.start(t); osc.stop(t + dur * 1.3);
  }

  #pulse(t, midi, amp) {
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(wave(this.ctx, 'sub'));
    const f = mtof(midi);
    osc.frequency.setValueAtTime(f * 1.6, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.07);
    const g = this.ctx.createGain();
    ad(g.gain, t, { peak: amp * 0.5, attack: 0.006, decay: 0.34 });
    osc.connect(g); g.connect(this.layers.sub);
    osc.start(t); osc.stop(t + 0.45);
  }

  #pluck(t, midi, amp) {
    const f = mtof(midi) * cents(rnd(-7, 7));
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(wave(this.ctx, 'glass'));
    osc.frequency.value = f;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(f * 6, t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.4), t + 0.3);
    filt.Q.value = 1.4;
    const g = this.ctx.createGain();
    ad(g.gain, t, { peak: amp, attack: 0.003, decay: rnd(0.22, 0.4) });
    osc.connect(filt); filt.connect(g); g.connect(this.layers.arp);
    osc.start(t); osc.stop(t + 0.7);
  }

  #choir(t, voicing) {
    const dur = this.stepDur * 16;
    const top = voicing[voicing.length - 1] + 12;
    for (const m of [top, top - 5]) {
      const osc = this.ctx.createOscillator();
      osc.setPeriodicWave(wave(this.ctx, 'choir'));
      osc.frequency.value = mtof(m) * cents(rnd(-9, 9));
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = rnd(4.2, 5.4);
      const lg = this.ctx.createGain(); lg.gain.value = 7;
      lfo.connect(lg); lg.connect(osc.detune);
      const g = this.ctx.createGain();
      asr(g.gain, t, { peak: 0.055, attack: dur * 0.45, hold: dur * 0.2, release: dur * 0.7 });
      osc.connect(g); g.connect(this.layers.choir);
      osc.start(t); lfo.start(t);
      osc.stop(t + dur * 1.4); lfo.stop(t + dur * 1.4);
    }
  }

  /** Boss layer: a ♭2 brass cluster plus a four-note tritone motif. */
  #dread(t, bar, voicing) {
    const dur = this.stepDur * 16;
    const root = voicing[0] - 12;
    for (const [m, amp] of [[root, 0.09], [root + 1, 0.05], [root + 7, 0.055]]) {
      const osc = this.ctx.createOscillator();
      osc.setPeriodicWave(wave(this.ctx, 'brass'));
      osc.frequency.value = mtof(m) * cents(rnd(-8, 8));
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(300, t);
      f.frequency.linearRampToValueAtTime(1500, t + dur * 0.6);
      const g = this.ctx.createGain();
      asr(g.gain, t, { peak: amp, attack: dur * 0.3, hold: dur * 0.25, release: dur * 0.6 });
      osc.connect(f); f.connect(g); g.connect(this.layers.dread);
      osc.start(t); osc.stop(t + dur * 1.3);
    }
    // motif: D – E♭ – D – A♭ (the tritone), one note per beat, alternate bars
    if (bar % 2 === 1) {
      const motif = [0, 1, 0, 6];
      for (let i = 0; i < motif.length; i++) {
        const tt = t + i * this.stepDur * 4;
        const osc = this.ctx.createOscillator();
        osc.setPeriodicWave(wave(this.ctx, 'metal'));
        osc.frequency.value = mtof(D + 12 + motif[i]);
        const g = this.ctx.createGain();
        ad(g.gain, tt, { peak: 0.05, attack: 0.005, decay: 0.5 });
        osc.connect(g); g.connect(this.layers.dread);
        osc.start(tt); osc.stop(tt + 0.7);
      }
    }
  }
}
