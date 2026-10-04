/**
 * Holds 60 fps by trading resolution, which is the only knob on this renderer
 * that is both continuous and honest.
 *
 * WHY RESOLUTION AND NOT A QUALITY PRESET
 *
 * Measured on an M1 (tools/scratch/cpubound.mjs, preset `low`, 21 towers,
 * wave 21, full pipeline):
 *
 *   pixelRatio 2.0   3200x1800   80.7 ms
 *   pixelRatio 1.5   2400x1350   56.7 ms
 *   pixelRatio 1.0   1600x900    34.1 ms
 *   pixelRatio 0.5   800x450     17.9 ms
 *   pixelRatio 0.25  400x225     16.6 ms  (vsync floor)
 *
 * Cost is linear in PIXEL COUNT at ~12 ns/px across a 64x range in area, and
 * `game.frame()` with rendering stubbed out costs **0.20 ms median**. The frame
 * is fragment-bound with essentially no CPU component, so pixels are a dial that
 * maps almost exactly onto milliseconds — halve the area, halve the frame.
 *
 * That is not true of the quality presets. Dropping `ultra` to `low` changes
 * shadow resolution, AO, MSAA and the light pool all at once, in discrete jumps,
 * and the player sees the scene change. Scaling resolution degrades one axis,
 * smoothly, and on a high-DPI display the first 2x of it is invisible because it
 * is spending the display's oversampling rather than the image's detail.
 *
 * WHY IT IS CLAMPED AT `minScale`
 *
 * A controller that will do anything to hit its target will render the game at
 * 160x90 rather than admit it cannot cope. Below `minScale` the game is no
 * longer worth looking at, so the controller stops and lets the frame rate fall.
 * A visibly soft image at 40 fps is a state the player can understand and act on
 * (lower the preset); an unreadable image at 60 fps is not.
 *
 * WHY IT PROBES INSTEAD OF READING HEADROOM
 *
 * On a vsync'd display a frame lasts a whole number of refresh intervals, so
 * the frame time says only whether the frame made the refresh, never by how
 * much. At 100 Hz every frame is 10 or 20 ms and at 60 Hz 16.7 or 33.3, so no
 * fixed "comfortably inside budget" threshold is reachable on every display: a
 * 13.5 ms upscale bar was met by every 10 ms frame and a 16.6 ms target missed
 * by every 20 ms one, and a machine sitting on that boundary flipped between
 * two scales every 48 frames for as long as it ran (screen recording
 * 2026-10-04, tools/scratch/vsync-flicker.mjs). The same bar was never met at
 * 60 Hz, so a scale lost to one heavy wave never came back there.
 *
 * So the only question is whether the frame meets 60 fps. While it does, the
 * controller adds pixels a step at a time. A scale that loses 60 fps is kept
 * out of reach for a hold that doubles every time it fails again, up to a
 * minute, and an upscale that fails is undone rather than re-estimated. The
 * flips decay from every 0.8 s to about one probe a minute, and a lighter
 * scene still gets its pixels back within that minute.
 *
 * A minute is a whole prep phase, though, and a long wave keeps failing the
 * probe just above the floor until its hold is at the cap. The game knows when
 * the board gets lighter even though the frame time cannot, so the end of a
 * wave calls forgetFailures() and the climb starts right away.
 */

/** Over this is under 60 fps, with room for a 60 Hz display's own jitter. */
const BUDGET_MS = 17.5;
/** A loss of 60 fps this soon after an upscale is that upscale failing. */
const PROBE_MS = 3_000;
const FIRST_HOLD_MS = 10_000;
const MAX_HOLD_MS = 60_000;

export class AdaptiveResolution {
  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {() => void} onChange  called after the scale changes, to resize
   *                               the composer and any size-dependent passes
   * @param {{maxScale?: number, minScale?: number, enabled?: boolean}} opts
   */
  constructor(renderer, onChange, opts = {}) {
    this.renderer = renderer;
    this.onChange = onChange;

    // Never exceed what the preset already decided, and never exceed the
    // display. This layer only ever takes pixels away.
    this.maxScale = opts.maxScale ?? renderer.getPixelRatio();
    // 0.6 -> 0.5.
    //
    // The clamp's job (see the docblock above) is to stop the controller
    // rendering at 160x90 rather than admit defeat, and 0.5 still honours that:
    // from a 1600x900 viewport it is an 800x450 buffer, which is soft but is a
    // picture. What 0.6 did in practice was strand every machine weaker than the
    // reference M1 against the clamp within two seconds of loading, where the
    // controller then had nothing to do for the rest of the session.
    //
    // Cost is linear in pixel AREA, so this is not the 17% it looks like: it
    // takes the floor from 0.36 to 0.25 of full resolution, i.e. it hands back
    // ~30% of the remaining frame at the point where the alternative was giving
    // up. Below this the game stops being worth looking at and QualityGovernor
    // takes over instead, which trades features rather than legibility.
    this.minScale = opts.minScale ?? 0.5;
    this.enabled = opts.enabled ?? true;
    this.scale = this.maxScale;

    this._samples = [];
    this._cooldown = 0;
    this._clock = 0;
    this._upAt = -Infinity;
    this._upFrom = this.scale;
    /** scale -> {until, hold}: levels that lost 60 fps, kept out of reach. */
    this._blocked = new Map();
  }

  /**
   * @param {number} dt seconds since the previous frame
   */
  update(dt) {
    if (!this.enabled) return;

    // A backgrounded tab produces one enormous dt. Feeding that to the
    // controller would collapse the resolution on return.
    const ms = dt * 1000;
    if (ms > 500) { this._samples.length = 0; return; }

    this._clock += ms;
    this._samples.push(ms);
    // 24 frames is ~0.4s at 60fps and ~0.6s at 40fps: long enough that one
    // slow frame cannot move the resolution, short enough that convergence
    // from the preset ceiling down to budget takes under two seconds. At 45
    // frames plus a 2-batch cooldown a step took ~3.3s, and the controller was
    // measured still descending nine seconds after load — which reads exactly
    // like a controller that has settled at the wrong value.
    if (this._samples.length < 24) return;

    // Cooldown so a resize's own cost is not read as evidence about the new
    // scale — the first frames after a target reallocation are always slow.
    if (this._cooldown > 0) { this._cooldown--; this._samples.length = 0; return; }

    // Median, not mean: one GC pause must not move the resolution.
    const sorted = this._samples.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this._samples.length = 0;

    let next = this.scale;
    if (median > BUDGET_MS) {
      this._block(this.scale);
      if (this._clock - this._upAt < PROBE_MS) {
        // The upscale we just made cost 60 fps: undo it.
        next = this._upFrom;
      } else {
        // Cost is linear in AREA, so the scale factor that would hit the
        // target is sqrt(target / actual). Damp it, since overshooting down is
        // ugly, but always move at least one step: a frame quantized to the
        // next refresh can look close enough that the damped step rounds back.
        const ideal = this.scale * Math.sqrt(BUDGET_MS / median);
        next = Math.min(this.scale + (ideal - this.scale) * 0.6, this.scale - 0.05);
      }
    } else {
      const up = Math.round(Math.min(this.maxScale, this.scale * 1.06) * 20) / 20;
      if (!(this._blocked.get(up)?.until > this._clock)) next = up;
    }
    next = Math.max(this.minScale, Math.min(this.maxScale, next));
    // Quantise, so we do not reallocate render targets over rounding noise.
    // A display ratio off the grid (4/3) would round above it, so clamp again.
    next = Math.min(this.maxScale, Math.round(next * 20) / 20);
    if (next === this.scale) return;

    if (next > this.scale) { this._upAt = this._clock; this._upFrom = this.scale; }
    this.scale = next;
    this.renderer.setPixelRatio(next);
    this.onChange?.();
    this._cooldown = 1;
  }

  /**
   * The board just got lighter in a way a vsync-quantized frame time cannot
   * show (a wave ended). Scales that lost 60 fps under the old load are no
   * longer out of reach.
   */
  forgetFailures() {
    this._blocked.clear();
  }

  /** Every repeat failure at the same scale doubles how long it stays out of reach. */
  _block(scale) {
    const prev = this._blocked.get(scale);
    const hold = prev ? Math.min(prev.hold * 2, MAX_HOLD_MS) : FIRST_HOLD_MS;
    this._blocked.set(scale, { until: this._clock + hold, hold });
  }
}
