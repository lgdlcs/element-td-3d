import { describe, it, expect } from 'vitest';
import { AdaptiveResolution } from '../../src/render/AdaptiveResolution.js';

/**
 * The controller fed by a simulated vsync'd display: each frame lasts a whole
 * number of refresh intervals, enough to cover a GPU cost proportional to the
 * rendered area (scale squared), with 4% jitter and the odd missed vsync.
 * `costMs(t)` is the full-resolution cost at virtual time t.
 */
function play({ hz, costMs, secs }) {
  const interval = 1000 / hz;
  const renderer = { ratio: 1, getPixelRatio() { return this.ratio; }, setPixelRatio(v) { this.ratio = v; } };
  let changes = 0;
  const ar = new AdaptiveResolution(renderer, () => { changes++; });
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  let t = 0;
  let lastMs = 0;
  while (t < secs * 1000) {
    const work = costMs(t) * ar.scale * ar.scale * (1 + 0.04 * (rand() * 2 - 1));
    let vsyncs = Math.max(1, Math.ceil(work / interval));
    if (rand() < 0.01) vsyncs++;
    lastMs = vsyncs * interval;
    ar.update(lastMs / 1000);
    t += lastMs;
  }
  const settledMs = Math.max(1, Math.ceil((costMs(t) * ar.scale * ar.scale) / interval)) * (1000 / hz);
  return { changes, scale: ar.scale, settledFps: Math.round(1000 / settledMs), ratio: renderer.ratio };
}

const RATES = [60, 100, 144];

describe('AdaptiveResolution under vsync-quantized frame times', () => {
  // At 144 Hz a frame that misses one refresh still makes the next at 72 fps,
  // so full resolution already meets the target there.
  it.each([[60, 0.95], [100, 0.95], [144, 1]])('stops flipping at %i Hz when full resolution just misses the refresh', (hz, settled) => {
    // The 2026-10-04 recording: full scale just misses the refresh and 5% less
    // resolution makes it. On main this flipped every 48 frames, 830
    // resolution changes in ten minutes at 100 Hz. What remains is one probe
    // of full scale a minute, because a quantized frame time cannot say
    // whether the scene got lighter.
    const r = play({ hz, costMs: () => 1.05 * (1000 / hz), secs: 600 });
    expect(r.changes).toBeLessThanOrEqual(30);
    expect(r.scale).toBe(settled);
    expect(r.ratio).toBe(settled);
  });

  it.each(RATES)('leaves a machine with headroom at full resolution at %i Hz', (hz) => {
    const r = play({ hz, costMs: () => 0.5 * (1000 / hz), secs: 120 });
    expect(r).toMatchObject({ changes: 0, scale: 1 });
  });

  it.each(RATES)('degrades a genuinely slow machine until it holds 60 fps at %i Hz', (hz) => {
    const r = play({ hz, costMs: () => 40, secs: 300 });
    expect(r.scale).toBeLessThan(0.65);
    expect(r.settledFps).toBeGreaterThanOrEqual(60);
    expect(r.changes).toBeLessThanOrEqual(30);
  });

  it.each(RATES)('gives the pixels back within a minute of a heavy wave ending at %i Hz', (hz) => {
    const r = play({ hz, costMs: (t) => (t < 30_000 ? 40 : 6), secs: 100 });
    expect(r.scale).toBe(1);
  });

  it('stays at the clamp when even minScale cannot hold 60 fps', () => {
    const r = play({ hz: 60, costMs: () => 200, secs: 120 });
    expect(r).toMatchObject({ scale: 0.5, ratio: 0.5 });
    expect(r.changes).toBeLessThanOrEqual(4);
  });
});
