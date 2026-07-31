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
 */

/** Target frame time. 60 fps with a little slack so we do not oscillate. */
const TARGET_MS = 16.6;
const UPSCALE_MS = 13.5;   // only add pixels if we are comfortably inside budget

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
    this.minScale = opts.minScale ?? 0.6;
    this.enabled = opts.enabled ?? true;
    this.scale = this.maxScale;

    this._samples = [];
    this._cooldown = 0;
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
    if (median > TARGET_MS) {
      // Cost is linear in AREA, so the scale factor that would hit the target
      // is sqrt(target / actual). Damp it: overshooting down is ugly and the
      // measurement is one sample of a noisy process.
      const ideal = this.scale * Math.sqrt(TARGET_MS / median);
      next = this.scale + (ideal - this.scale) * 0.6;
    } else if (median < UPSCALE_MS && this.scale < this.maxScale) {
      // Climb back slowly. A player who walks away from a heavy wave should
      // regain sharpness, but not so eagerly that we ping-pong across the
      // budget every second.
      next = this.scale * 1.06;
    }

    next = Math.max(this.minScale, Math.min(this.maxScale, next));
    // Quantise, so we do not reallocate render targets over rounding noise.
    next = Math.round(next * 20) / 20;
    if (next === this.scale) return;

    this.scale = next;
    this.renderer.setPixelRatio(next);
    this.onChange?.();
    this._cooldown = 1;
  }
}
