/**
 * Mixer.js — the bus structure.
 *
 *   music ─┐                         ┌─ hallSend ─┐
 *   sfx   ─┼─ (dry) ────────────────►│            ├─► sum ─► glue comp ─►
 *   amb   ─┘                         └─ roomSend ─┘             │
 *                                                               ▼
 *                              masterGain ─► limiter ─► ceiling ─► destination
 *
 * Every source bus has its own gain, its own duck gain (so cues can push the
 * music and ambience down without touching the player's volume settings) and
 * its own reverb send amounts. The master chain ends in a compressor tuned as
 * a limiter followed by a waveshaper whose transfer function asymptotes below
 * full scale — that pair is what makes clipping structurally impossible.
 *
 * The mixer also owns voice budgeting: when 30 towers fire in the same frame
 * we must not stack 30 impacts, so cues declare a priority and a cost and the
 * mixer culls what does not fit.
 */
import { makeIR, softClipCurve, ceilingCurve, clamp } from './dsp.js';

export class Mixer {
  constructor(ctx, { masterVolume = 0.5 } = {}) {
    this.ctx = ctx;

    // --- master chain (built back to front) -------------------------------
    this.ceiling = ctx.createWaveShaper();
    this.ceiling.curve = ceilingCurve(0.62);
    this.ceiling.oversample = '2x';
    this.ceiling.connect(ctx.destination);

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.0015;
    this.limiter.release.value = 0.12;
    this.limiter.connect(this.ceiling);

    this.master = ctx.createGain();
    this.master.gain.value = masterVolume;
    this.master.connect(this.limiter);

    this.glue = ctx.createDynamicsCompressor();
    this.glue.threshold.value = -20;
    this.glue.knee.value = 22;
    this.glue.ratio.value = 3.2;
    this.glue.attack.value = 0.006;
    this.glue.release.value = 0.22;
    this.glue.connect(this.master);

    // A gentle console-style saturation before the glue: rounds transients,
    // adds a little density, and pre-tames anything silly.
    this.drive = ctx.createWaveShaper();
    this.drive.curve = softClipCurve(1.25);
    this.drive.oversample = '2x';
    this.drive.connect(this.glue);

    this.sum = ctx.createGain();
    this.sum.gain.value = 1;
    this.sum.connect(this.drive);

    // --- reverbs ----------------------------------------------------------
    // Two spaces: a long cold hall for music/ambience (the abyss below the
    // arena) and a tight stone room for SFX (the flagstones of the arena).
    this.hall = ctx.createConvolver();
    this.hall.buffer = makeIR(ctx, { duration: 4.2, decay: 2.1, predelay: 0.03, damp: 0.78 });
    this.hallOut = ctx.createGain();
    this.hallOut.gain.value = 0.9;
    this.hall.connect(this.hallOut);
    this.hallOut.connect(this.sum);

    this.room = ctx.createConvolver();
    this.room.buffer = makeIR(ctx, { duration: 1.35, decay: 3.1, predelay: 0.008, damp: 0.6 });
    this.roomOut = ctx.createGain();
    this.roomOut.gain.value = 0.85;
    // A high-pass on the room return keeps impacts from muddying the low end.
    this.roomHP = ctx.createBiquadFilter();
    this.roomHP.type = 'highpass';
    this.roomHP.frequency.value = 260;
    this.room.connect(this.roomHP);
    this.roomHP.connect(this.roomOut);
    this.roomOut.connect(this.sum);

    // --- source buses -----------------------------------------------------
    this.buses = {};
    // Levels chosen from measurement, not taste: the ambience bed must sit at
    // roughly a third of the music RMS or it stops being a bed and becomes a
    // sound. See src/audio/probe.mjs.
    this.music = this.#bus('music', { gain: 0.75, hall: 0.26, room: 0.0 });
    this.sfx = this.#bus('sfx', { gain: 1.0, hall: 0.05, room: 0.24 });
    this.amb = this.#bus('amb', { gain: 0.42, hall: 0.34, room: 0.0 });

    // --- voice budget -----------------------------------------------------
    this._voices = [];          // { until, priority }
    this._budget = 22;          // simultaneous audible voices
    this._recent = new Map();   // name -> last start time (throttling)
  }

  #bus(name, { gain, hall, room }) {
    const ctx = this.ctx;
    const input = ctx.createGain();          // where sources connect
    input.gain.value = 1;

    const duck = ctx.createGain();           // automated by the ducker
    duck.gain.value = 1;

    const level = ctx.createGain();          // user/mix level
    level.gain.value = gain;

    input.connect(duck);
    duck.connect(level);
    level.connect(this.sum);

    const hallSend = ctx.createGain();
    hallSend.gain.value = hall;
    level.connect(hallSend);
    hallSend.connect(this.hall);

    const roomSend = ctx.createGain();
    roomSend.gain.value = room;
    level.connect(roomSend);
    roomSend.connect(this.room);

    const b = { name, input, duck, level, hallSend, roomSend, baseGain: gain };
    this.buses[name] = b;
    return b;
  }

  // -------------------------------------------------------------------------
  // Ducking
  // -------------------------------------------------------------------------

  /**
   * Pull the music (and optionally ambience) down under an important cue.
   * Uses an exponential recovery so it breathes rather than pumps.
   */
  duck(amount = 0.45, attack = 0.05, release = 0.7, at = this.ctx.currentTime) {
    const target = clamp(1 - amount, 0.05, 1);
    for (const b of [this.music, this.amb]) {
      const g = b.duck.gain;
      const a = b === this.amb ? 1 - (1 - target) * 0.55 : target;
      g.cancelScheduledValues(at);
      g.setValueAtTime(Math.max(0.0001, g.value), at);
      g.linearRampToValueAtTime(a, at + attack);
      g.setTargetAtTime(1, at + attack + 0.02, release / 3);
    }
  }

  // -------------------------------------------------------------------------
  // Voice budget
  // -------------------------------------------------------------------------

  /** Drop expired voices. */
  #reap(now) {
    const v = this._voices;
    let w = 0;
    for (let i = 0; i < v.length; i++) if (v[i].until > now) v[w++] = v[i];
    v.length = w;
  }

  /**
   * Ask for permission to start a voice.
   * @param {number} priority higher wins; 0 = ambient chatter, 9 = must play
   * @param {number} dur      expected voice lifetime in seconds
   * @returns {boolean}
   */
  acquire(priority = 3, dur = 0.4) {
    const now = this.ctx.currentTime;
    this.#reap(now);
    if (this._voices.length < this._budget) {
      this._voices.push({ until: now + dur, priority });
      return true;
    }
    // Over budget: only let through cues that outrank the quietest voice.
    let minIdx = 0;
    for (let i = 1; i < this._voices.length; i++) {
      if (this._voices[i].priority < this._voices[minIdx].priority) minIdx = i;
    }
    if (priority > this._voices[minIdx].priority) {
      this._voices[minIdx] = { until: now + dur, priority };
      return true;
    }
    return false;
  }

  /** Rate-limit a named cue. Returns false if it fired too recently. */
  throttle(name, seconds) {
    const now = this.ctx.currentTime;
    const last = this._recent.get(name) ?? -1e9;
    if (now - last < seconds) return false;
    this._recent.set(name, now);
    return true;
  }

  get load() {
    this.#reap(this.ctx.currentTime);
    return this._voices.length / this._budget;
  }

  setMasterVolume(v) {
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(clamp(v, 0, 1.5), t, 0.02);
  }

  setBusVolume(name, v) {
    const b = this.buses[name];
    if (!b) return;
    b.baseGain = v;
    b.level.gain.setTargetAtTime(Math.max(0, v), this.ctx.currentTime, 0.03);
  }
}
