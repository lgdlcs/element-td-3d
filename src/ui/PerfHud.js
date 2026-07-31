/**
 * A frame-time readout.
 *
 * This did not exist until round 8, which is the whole point of it existing
 * now. Eight rounds of visual iteration ran against a blind-critic loop that
 * scores *still frames*, and a still frame costs nothing to look at. The
 * quality presets were therefore tuned entirely by eye and by luminance
 * histograms, and nothing in the loop would ever have reported that the game
 * does not reach interactive frame rates on the machine it is built on.
 *
 * Reports the MEDIAN over a sliding window rather than an average: one 300ms
 * shader-compile hitch drags an average for seconds afterwards and makes the
 * number unreadable exactly when you are trying to attribute a stutter. The
 * p95 is shown next to it because the worst frames are what a player feels;
 * a 60fps median with a 90ms p95 is a stuttering game, and a single number
 * cannot say that.
 *
 * Toggle with **G**, or F8. G is the real binding: on a Mac the F-row is media
 * keys by default, so F8 needs Fn held down and is not a usable shortcut. G is
 * checked against the full keymap (Q W E R T Y build, F codex, P pause, U
 * upgrade, X sell, WASD/QE camera) and is free; `e.code` is physical, so it
 * lands on the same key on AZERTY.
 *
 * Off by default - it must never appear in a capture used for a visual
 * comparison.
 */

const N = 120;   // ~2 seconds at 60fps

export class PerfHud {
  constructor(renderer) {
    this.renderer = renderer;
    this.times = new Float32Array(N);
    this.n = 0;
    this.i = 0;
    this._sorted = new Float32Array(N);
    this._acc = 0;

    const el = document.createElement('div');
    el.id = 'perf-hud';
    el.style.cssText = [
      'position:fixed', 'top:8px', 'left:8px', 'z-index:9999',
      'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#cfe9ff', 'background:rgba(6,10,18,.82)',
      'border:1px solid rgba(120,170,220,.28)', 'border-radius:5px',
      'padding:6px 9px', 'white-space:pre', 'pointer-events:none',
      'display:none', 'letter-spacing:.02em',
    ].join(';');
    document.body.appendChild(el);
    this.el = el;

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyG' && e.code !== 'F8') return;
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      this.toggle();
    });
  }

  get visible() { return this.el.style.display !== 'none'; }

  toggle(on = !this.visible) {
    this.el.style.display = on ? 'block' : 'none';
  }

  /** @param {number} dt seconds since the previous frame */
  update(dt) {
    const ms = dt * 1000;
    // Guard against the tab being backgrounded, which produces multi-second
    // dt values that are not frames and would poison the window.
    if (ms > 0 && ms < 2000) {
      this.times[this.i] = ms;
      this.i = (this.i + 1) % N;
      if (this.n < N) this.n++;
    }
    if (!this.visible) return;

    // Repaint at ~6Hz. A number that changes every frame is unreadable, and
    // the sort below is not free.
    this._acc += dt;
    if (this._acc < 0.16 || this.n < 8) return;
    this._acc = 0;

    const s = this._sorted.subarray(0, this.n);
    s.set(this.times.subarray(0, this.n));
    s.sort();
    const med = s[this.n >> 1];
    const p95 = s[Math.min(this.n - 1, Math.floor(this.n * 0.95))];

    const r = this.renderer.info.render;
    const m = this.renderer.info.memory;
    this.el.textContent =
      `${med.toFixed(1).padStart(5)} ms   ${(1000 / med).toFixed(0).padStart(3)} fps   median\n` +
      `${p95.toFixed(1).padStart(5)} ms   ${(1000 / p95).toFixed(0).padStart(3)} fps   p95\n` +
      `${String(r.calls).padStart(5)} draw calls\n` +
      `${(r.triangles / 1000).toFixed(0).padStart(5)}k triangles\n` +
      `${String(m.textures).padStart(5)} textures  ${m.geometries} geoms\n` +
      `${String(this.renderer.getPixelRatio().toFixed(2)).padStart(5)} pixel ratio`;
  }
}
