/**
 * Ambience.js — the environmental bed.
 *
 * "A ruined arcane arena suspended over a starlit abyss." That is three sounds:
 *   1. WIND moving over cut stone — two decorrelated noise bands, slowly
 *      modulated in cutoff and amplitude so it breathes rather than hisses.
 *   2. The ABYSS — a very low, very slow drone on the tonic and its fifth,
 *      detuned enough to beat once every few seconds.
 *   3. ARCANE RESONANCE — sparse, distant events: a struck harmonic somewhere
 *      out in the dark, or a subterranean rumble. Random, never on a grid.
 *
 * Everything is continuous and self-driving; nothing needs a game hook.
 */
import { mtof, wave, rnd, clamp, panner, ad } from './dsp.js';

const D = 50;

export class Ambience {
  constructor(ctx, mixer, sfx) {
    this.ctx = ctx;
    this.mixer = mixer;
    this.sfx = sfx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.0001;
    this.out.connect(mixer.amb.input);
    this._nodes = [];
    this._timer = null;
    this.energy = 0.25;         // rises with combat intensity
  }

  start(at = this.ctx.currentTime) {
    const ctx = this.ctx;

    // --- wind ------------------------------------------------------------
    this.windBands = [];
    for (const [freq, q, pan, amp, rate] of [
      [420, 0.55, -0.75, 0.16, 0.037],
      [900, 0.9, 0.8, 0.09, 0.053],
      [180, 0.4, 0.15, 0.13, 0.023],
    ]) {
      const src = ctx.createBufferSource();
      src.buffer = this.sfx._noise.pink;
      src.loop = true;
      src.playbackRate.value = rnd(0.85, 1.15);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;

      // slow cutoff drift
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const lg = ctx.createGain();
      lg.gain.value = freq * 0.45;
      lfo.connect(lg); lg.connect(bp.frequency);

      // slow amplitude gusts (a second, slower LFO)
      const g = ctx.createGain();
      g.gain.value = amp;
      const alfo = ctx.createOscillator();
      alfo.frequency.value = rate * 0.61;
      const ag = ctx.createGain();
      ag.gain.value = amp * 0.65;
      alfo.connect(ag); ag.connect(g.gain);

      const p = panner(ctx, pan);
      src.connect(bp); bp.connect(g); g.connect(p); p.connect(this.out);
      src.start(at, rnd(0, 1)); lfo.start(at); alfo.start(at);
      this.windBands.push({ bp, g, base: amp });
      this._nodes.push(src, lfo, alfo);
    }

    // --- the abyss drone --------------------------------------------------
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 280;
    this.droneFilter.Q.value = 0.7;
    this.droneFilter.connect(this.out);

    for (const [midi, det, amp] of [
      [D - 24, 0, 0.13], [D - 24, 6, 0.1], [D - 17, -5, 0.07], [D - 12, 3, 0.045],
    ]) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave(ctx, 'reed'));
      osc.frequency.value = mtof(midi);
      osc.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = amp;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rnd(0.03, 0.09);
      const lg = ctx.createGain();
      lg.gain.value = amp * 0.5;
      lfo.connect(lg); lg.connect(g.gain);
      osc.connect(g); g.connect(this.droneFilter);
      osc.start(at); lfo.start(at);
      this._nodes.push(osc, lfo);
    }

    // fade in over 6 s — the world should already have been there
    this.out.gain.setValueAtTime(0.0001, at);
    this.out.gain.exponentialRampToValueAtTime(0.32, at + 6);

    this.#schedule();
  }

  /** Sparse random events, re-armed after each fire. */
  #schedule() {
    if (typeof setTimeout !== 'function') return;
    const next = rnd(7000, 19000) * (1.3 - this.energy * 0.5);
    this._timer = setTimeout(() => { this.event(); this.#schedule(); }, next);
  }

  /** One ambient event at `t`. Exposed so it can be rendered offline. */
  event(t = this.ctx.currentTime + 0.02, kind = null) {
    const k = kind ?? (Math.random() < 0.55 ? 'resonance' : 'rumble');
    if (k === 'resonance') {
      // a struck harmonic, far away, in the mode
      const n = D + [0, 3, 7, 10, 12, 15][(Math.random() * 6) | 0];
      this.sfx.bell(t, {
        freq: mtof(n) * (Math.random() < 0.5 ? 1 : 0.5),
        peak: 0.028 + this.energy * 0.02, decay: rnd(2.2, 4.5), bright: 0.6,
        dest: this.out, pan: rnd(-0.85, 0.85),
      });
      this.sfx.tone(t + rnd(0.1, 0.4), {
        freq: mtof(n - 12), shape: 'glass', peak: 0.02, attack: 0.6, hold: 0.6,
        release: 2.4, dest: this.out, pan: rnd(-0.6, 0.6),
      });
    } else {
      // a low rumble from somewhere below the platform
      this.sfx.noise(t, {
        colour: 'brown', type: 'lowpass', freq: rnd(90, 180), to: rnd(40, 70), q: 0.6,
        peak: 0.16 + this.energy * 0.1, attack: rnd(0.8, 1.8), hold: 0.4,
        release: rnd(1.6, 3.2), dest: this.out, pan: rnd(-0.4, 0.4),
      });
      this.sfx.tone(t + 0.2, {
        freq: rnd(30, 44), shape: 'sub', peak: 0.09, attack: 1.2, hold: 0.6,
        release: 2.0, dest: this.out,
      });
    }
    return t;
  }

  /** Combat raises the wind and the event rate — the world reacts too. */
  setEnergy(v) {
    this.energy = clamp(v, 0, 1);
    const t = this.ctx.currentTime;
    if (!this.windBands) return;
    for (let i = 0; i < this.windBands.length; i++) {
      const b = this.windBands[i];
      b.g.gain.setTargetAtTime(b.base * (0.8 + this.energy * 0.9), t, 1.2);
      b.bp.Q.setTargetAtTime(0.4 + this.energy * 0.7, t, 1.5);
    }
    this.droneFilter.frequency.setTargetAtTime(240 + this.energy * 420, t, 1.5);
  }

  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0.0001, t, 0.6);
  }
}
