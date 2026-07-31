/**
 * AudioEngine — fully procedural score, SFX and ambience. Zero binary assets.
 *
 *   AudioEngine
 *     ├── Mixer      bus structure, reverbs, ducking, voice budget, limiter
 *     ├── Sfx        every game cue, layered (transient + body + tail)
 *     ├── Music      adaptive score in D minor, driven by the cues it receives
 *     └── Ambience   wind over stone, the abyss drone, sparse arcane events
 *
 * PUBLIC API (stable)
 *   play(name)                       the 15 game cues
 *   setVolume(v)                     master, 0..1
 *   playImpact(elementId, k, opts)   element-flavoured combat impact
 *   playShot(elementId, k, opts)     near-subliminal tower muzzle cue
 *   setBusVolume(bus, v)             'music' | 'sfx' | 'amb'
 *   setMusicEnabled(b) / setMuted(b)
 *   update(dt, state)                OPTIONAL — the engine self-drives without it
 *
 * The music director needs no wiring: it infers game state from the cues the
 * game already sends (`waveStart` raises intensity, `bossHorn` switches to the
 * dread mode, `death` adds combat heat, `waveClear` cadences and settles). If
 * `window.__game` happens to exist it is used, defensively, as a refinement.
 */
import { makeNoise, clamp, rnd } from './dsp.js';
import { Mixer } from './Mixer.js';
import { Sfx } from './Sfx.js';
import { Music } from './Music.js';
import { Ambience } from './Ambience.js';

/**
 * Per-cue policy.
 *   pri    voice priority (higher survives when the budget is full)
 *   dur    expected voice lifetime, for budgeting
 *   thr    minimum seconds between two of this cue
 *   duck   how far the music/ambience gets pushed down (0..1)
 */
const CUE = {
  build:       { pri: 7, dur: 0.8, thr: 0.03, duck: 0.16 },
  upgrade:     { pri: 7, dur: 1.6, thr: 0.03, duck: 0.20 },
  sell:        { pri: 6, dur: 0.8, thr: 0.03, duck: 0.12 },
  select:      { pri: 4, dur: 0.15, thr: 0.045, duck: 0 },
  deny:        { pri: 6, dur: 0.4, thr: 0.10, duck: 0.10 },
  death:       { pri: 2, dur: 0.35, thr: 0.028, duck: 0 },
  bossDeath:   { pri: 9, dur: 2.6, thr: 0.30, duck: 0.42 },
  leak:        { pri: 9, dur: 1.4, thr: 0.12, duck: 0.55 },
  waveStart:   { pri: 8, dur: 1.4, thr: 0.30, duck: 0.30 },
  bossHorn:    { pri: 9, dur: 3.4, thr: 0.60, duck: 0.50 },
  waveClear:   { pri: 8, dur: 2.0, thr: 0.30, duck: 0.28 },
  elementPick: { pri: 8, dur: 2.6, thr: 0.15, duck: 0.35 },
  victory:     { pri: 9, dur: 4.4, thr: 1.00, duck: 0.85 },
  gameover:    { pri: 9, dur: 5.2, thr: 1.00, duck: 0.85 },
};

export class AudioEngine {
  /**
   * @param {object} [opts]
   * @param {BaseAudioContext} [opts.context] inject a context (offline analysis)
   * @param {boolean} [opts.autoStart] build the graph immediately (no gesture)
   * @param {number}  [opts.volume]
   */
  constructor(opts = {}) {
    this.ctx = null;
    this.enabled = true;
    this.muted = false;
    this.masterVolume = opts.volume ?? 0.5;   // start gentle
    this._injected = opts.context ?? null;
    this._poll = null;

    if (this._injected || opts.autoStart) {
      this.#init();
      return;
    }
    // Browsers require a gesture before audio may start; arm on first input.
    const arm = () => {
      this.#init();
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', arm);
      window.addEventListener('keydown', arm);
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  #init() {
    if (this.ctx) return;
    let ctx = this._injected;
    if (!ctx) {
      const Ctx = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!Ctx) { this.enabled = false; return; }
      ctx = new Ctx({ latencyHint: 'interactive' });
    }
    this.ctx = ctx;

    this.mixer = new Mixer(ctx, { masterVolume: this.muted ? 0 : this.masterVolume });
    this.sfx = new Sfx(ctx, this.mixer);
    this.sfx.setNoise({
      white: makeNoise(ctx, 2.0, 'white'),
      pink: makeNoise(ctx, 3.0, 'pink'),
      brown: makeNoise(ctx, 3.0, 'brown'),
    });
    this.music = new Music(ctx, this.mixer, this.sfx);
    this.ambience = new Ambience(ctx, this.mixer, this.sfx);

    this.ambience.start(ctx.currentTime + 0.02);
    this.music.start(ctx.currentTime + 0.2);

    this.#startPolling();
  }

  /**
   * OPTIONAL refinement: if the page exposes `window.__game` we sample it a few
   * times a second to keep the score honest (creep pressure, low lives, prep
   * phase). Everything here is guarded — the engine is fully functional without
   * it, and nothing outside src/audio/ is required to change.
   */
  #startPolling() {
    if (typeof setInterval !== 'function') return;
    if (this._poll) return;
    this._poll = setInterval(() => {
      const g = (typeof window !== 'undefined') && window.__game;
      if (!g || !this.music) return;
      try {
        const st = g.state;
        if (!st) return;
        if (st.phase === 'prep' || st.phase === 'pickElement') {
          if (this.music.mode !== 'calm') this.music.setState('calm', 0.12);
          else this.music.target = 0.12;
        } else if (st.phase === 'combat' && this.music.mode === 'calm') {
          this.music.setState('combat', 0.5);
        }
        const n = g.creeps?.count ?? 0;
        const pressure = clamp(n / 45, 0, 1);
        const desperate = st.lives != null ? clamp(1 - st.lives / 20, 0, 1) : 0;
        if (this.music.mode !== 'calm') {
          this.music.target = clamp(0.5 + pressure * 0.3 + desperate * 0.2, 0, 1);
        }
        this.ambience?.setEnergy(clamp(this.music.intensity, 0, 1));
      } catch { /* never let audio break the game */ }
    }, 400);
  }

  #resume() {
    // Offline contexts have no transport to resume, and a live context may
    // reject if the gesture has not landed yet — never let either surface.
    if (!this.ctx || typeof this.ctx.resume !== 'function') return;
    if (this.ctx.state !== 'suspended') return;
    if (typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext) return;
    try { this.ctx.resume()?.catch?.(() => {}); } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Public cues
  // -------------------------------------------------------------------------

  play(name) {
    if (!this.enabled) return;
    this.#init();
    if (!this.ctx || !this.sfx) return;
    this.#resume();

    const cfg = CUE[name];
    if (!cfg) return;
    if (cfg.thr && !this.mixer.throttle(name, cfg.thr)) return;
    if (!this.mixer.acquire(cfg.pri, cfg.dur)) return;

    const t = this.ctx.currentTime + 0.012;
    if (cfg.duck) this.mixer.duck(cfg.duck, 0.04, cfg.duck > 0.4 ? 1.4 : 0.6, t);

    const pan = rnd(-0.18, 0.18);

    switch (name) {
      case 'build':       this.sfx.build(t, pan); break;
      case 'upgrade':     this.sfx.upgrade(t, pan); break;
      case 'sell':        this.sfx.sell(t, pan); break;
      case 'select':      this.sfx.select(t, pan); break;
      case 'deny':        this.sfx.deny(t, pan); break;
      case 'death':       this.sfx.death(t, rnd(-0.5, 0.5)); break;
      case 'bossDeath':   this.sfx.bossDeath(t, pan); break;
      case 'leak':        this.sfx.leak(t, pan); break;
      case 'waveStart':   this.sfx.waveStart(t, pan); break;
      case 'bossHorn':    this.sfx.bossHorn(t, pan); break;
      case 'waveClear':   this.sfx.waveClear(t); break;
      case 'elementPick': this.sfx.elementPick(t); break;
      case 'victory':     this.sfx.victory(t); break;
      case 'gameover':    this.sfx.gameover(t); break;
      default: break;
    }

    this.#react(name);
  }

  /** Music/ambience response to a cue — this is what makes the score adaptive. */
  #react(name) {
    const m = this.music;
    if (!m) return;
    switch (name) {
      case 'waveStart':
        m.setState('combat', 0.55);
        m.addHeat(0.2);
        this.ambience?.setEnergy(0.6);
        break;
      case 'bossHorn':
        m.setState('boss', 0.9);
        m.addHeat(0.5);
        this.ambience?.setEnergy(0.85);
        break;
      case 'waveClear':
        m.cadence();
        m.setState('calm', 0.16);
        m.heat *= 0.3;
        this.ambience?.setEnergy(0.3);
        break;
      case 'death':      m.addHeat(0.05); break;
      case 'bossDeath':  m.addHeat(0.3); break;
      case 'leak':       m.addHeat(0.3); break;
      case 'upgrade':    m.addHeat(0.04); break;
      case 'elementPick': m.setState('calm', 0.12); break;
      case 'victory':
      case 'gameover':
        m.setState('calm', 0.02);
        m.stop();
        this.ambience?.setEnergy(0.1);
        break;
      default: break;
    }
  }

  /**
   * Element-flavoured combat impact.
   * @param {string} elementId 'fire'|'water'|'nature'|'earth'|'light'|'dark'
   *                           or any dual id ('steam', 'magma', 'void', …)
   * @param {number} [intensity] 0..1 — scale it with damage or splash radius
   * @param {object} [opts] { pan: -1..1, big: boolean }
   */
  playImpact(elementId, intensity = 0.6, opts = {}) {
    if (!this.enabled || !this.sfx) return;
    const k = clamp(intensity, 0, 1);
    // Loud hits earn a slot; chip damage does not.
    const pri = 1 + Math.round(k * 4) + (opts.big ? 2 : 0);
    // Global impact rate limit, plus a stochastic cull when the board is busy.
    const load = this.mixer.load;
    if (load > 0.55 && Math.random() > (1 - load) * 1.8 + k * 0.35) return;
    if (!this.mixer.throttle(`imp:${elementId}`, 0.028 + load * 0.05)) return;
    if (!this.mixer.acquire(pri, 0.5)) return;
    this.#resume();
    this.sfx.impact(elementId, k, this.ctx.currentTime + 0.008, opts.pan ?? rnd(-0.6, 0.6));
  }

  /** Optional muzzle cue when a tower fires. Very quiet, aggressively culled. */
  playShot(elementId, intensity = 0.5, opts = {}) {
    if (!this.enabled || !this.sfx) return;
    const load = this.mixer.load;
    if (load > 0.35 && Math.random() > 0.35) return;
    if (!this.mixer.throttle(`shot:${elementId}`, 0.055 + load * 0.08)) return;
    if (!this.mixer.acquire(1, 0.16)) return;
    this.sfx.shot(elementId, clamp(intensity, 0, 1), this.ctx.currentTime + 0.006, opts.pan ?? rnd(-0.7, 0.7));
  }

  // -------------------------------------------------------------------------
  // Optional per-frame hook (the engine works fine without it)
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt seconds
   * @param {object} [state] the game's `state` object, if you want to wire it
   */
  update(dt, state) {
    if (!this.music || !state) return;
    if (state.phase === 'prep' && this.music.mode !== 'calm') this.music.setState('calm', 0.12);
  }

  // -------------------------------------------------------------------------
  // Volume / transport
  // -------------------------------------------------------------------------

  setVolume(v) {
    this.masterVolume = clamp(v, 0, 1);
    if (this.mixer && !this.muted) this.mixer.setMasterVolume(this.masterVolume);
  }

  getVolume() { return this.masterVolume; }

  setBusVolume(bus, v) { this.mixer?.setBusVolume(bus, clamp(v, 0, 1.5)); }

  setMuted(b) {
    this.muted = !!b;
    if (this.mixer) this.mixer.setMasterVolume(this.muted ? 0 : this.masterVolume);
  }

  setMusicEnabled(b) {
    if (!this.music) return;
    this.music._enabled = !!b;
    this.mixer.setBusVolume('music', b ? 0.75 : 0);
  }

  /** Release timers — handy for hot-reload and teardown. */
  dispose() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    this.music?.stop();
    this.ambience?.stop();
  }
}
