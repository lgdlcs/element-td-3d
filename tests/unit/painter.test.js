/**
 * The Painter, against a recording context.
 *
 * There is no canvas in node and there is no canvas in jsdom either, so what can
 * be tested here is not the PICTURE — that is tests/e2e's job — but the two
 * things that have gone wrong in this file before and would go wrong silently
 * again: the transform arithmetic, and the colour handling inside `halo`.
 *
 * The fake context records every call and every stop. That is enough to catch
 * the exact defect this pass fixes: a gradient whose middle stop is identical to
 * its first is a hard-edged disc pretending to be a glow, and nothing about it
 * throws, warns or looks wrong until someone photographs it.
 *
 * PROVE THE INSTRUMENT CAN FAIL (docs/TESTING.md §4): restoring the old
 * `color.replace(/[\d.]+\)$/, '0.18)')` line fails "builds a real falloff for a
 * colour that is not rgba"; dropping the `closePath()` from `blob` fails "a blob
 * is a closed path"; and swapping the sign in `toClient` fails the round trip.
 */

import { describe, it, expect } from 'vitest';
import { FIELD } from '../../src/minigames/contract.js';
import { Painter, face, measurableFace, resetFaces } from '../../src/minigames/Painter.js';

/** A CanvasRenderingContext2D that remembers what it was asked to do. */
function fakeCtx() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const gradient = () => {
    const stops = [];
    return { stops, addColorStop: (at, col) => stops.push([at, col]) };
  };
  return {
    calls,
    canvas: { width: 800, height: 450 },
    setTransform: rec('setTransform'),
    clearRect: rec('clearRect'),
    save: rec('save'), restore: rec('restore'),
    translate: rec('translate'), rotate: rec('rotate'), scale: rec('scale'),
    beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    arc: rec('arc'), ellipse: rec('ellipse'), rect: rec('rect'), roundRect: rec('roundRect'),
    clip: rec('clip'), fill: rec('fill'), stroke: rec('stroke'), fillText: rec('fillText'),
    createRadialGradient: (...a) => { const g = gradient(); calls.push(['radial', g, ...a]); return g; },
    createLinearGradient: (...a) => { const g = gradient(); calls.push(['linear', g, ...a]); return g; },
  };
}

function painter() {
  const c = fakeCtx();
  const g = new Painter(c);
  g.layout(1600, 900, 2);
  return { g, c, names: () => c.calls.map((x) => x[0]) };
}

/** The gradient object created by the last radial/linear call. */
function lastGradient(c) {
  for (let i = c.calls.length - 1; i >= 0; i--) {
    if (c.calls[i][0] === 'radial' || c.calls[i][0] === 'linear') return c.calls[i][1];
  }
  return null;
}

// ===========================================================================
describe('the letterbox transform', () => {
  it('toClient is the exact inverse of toField', () => {
    const { g } = painter();
    for (const [x, y] of [[0, 0], [FIELD.hw, FIELD.hh], [-FIELD.hw, -FIELD.hh], [3.25, -1.75]]) {
      const p = g.toClient(x, y);
      const back = g.toField(p.x, p.y);
      expect(back.x, `x at ${x},${y}`).toBeCloseTo(x, 10);
      expect(back.y, `y at ${x},${y}`).toBeCloseTo(y, 10);
    }
  });

  it('puts the field centre at the canvas centre and +y upward', () => {
    const { g } = painter();
    expect(g.toClient(0, 0)).toEqual({ x: 800, y: 450 });
    // +y is UP in the field and DOWN in CSS pixels. A sign error here is the
    // kind that makes every rite look almost right and aim upside down.
    expect(g.toClient(0, 1).y).toBeLessThan(450);
  });

  it('letterboxes rather than stretches on a wide canvas', () => {
    const c = fakeCtx();
    const g = new Painter(c);
    g.layout(4000, 900, 1);              // far wider than 16:9
    expect(g.ppu).toBe(100);             // limited by height: 900 / 9
    // The field still fits, and the spare width is margin rather than stretch.
    expect(g.toClient(FIELD.hw, 0).x).toBe(2000 + 800);
  });
});

// ===========================================================================
describe('the new shape primitives', () => {
  it('a blob is a closed path of quadratics, one per point', () => {
    const { g, c, names } = painter();
    g.blob([[0, 0], [1, 0], [1, 1], [0, 1]], { fill: '#fff', stroke: '#000' });
    expect(names().filter((n) => n === 'quadraticCurveTo').length).toBe(4);
    // Closed, and starting on a MIDPOINT rather than on a vertex — that is what
    // makes the seam as smooth as every other joint.
    expect(names()).toContain('closePath');
    const move = c.calls.find((x) => x[0] === 'moveTo');
    expect(move.slice(1)).toEqual([0, 0.5]);
    expect(names()).toContain('fill');
    expect(names()).toContain('stroke');
  });

  it('a blob with fewer than three points degrades to a poly rather than vanishing', () => {
    const { g, names } = painter();
    g.blob([[0, 0], [1, 1]], { stroke: '#000' });
    expect(names()).toContain('lineTo');
    expect(names()).not.toContain('quadraticCurveTo');
  });

  it('an ellipse is one ellipse call, not a scaled circle', () => {
    const { g, c, names } = painter();
    g.ellipse(1, 2, 3, 0.5, 0.25, { fill: '#fff' });
    // THE POINT of the primitive: no scale() anywhere near it. A non-uniform
    // scale applies to the PEN as well as the path, so a stroked "ellipse" drawn
    // that way has a different eccentricity from its own fill.
    expect(names()).not.toContain('scale');
    expect(c.calls.find((x) => x[0] === 'ellipse').slice(1, 6)).toEqual([1, 2, 3, 0.5, 0.25]);
  });

  it('a capsule is a closed fillable path, and degenerates to a circle', () => {
    const { g, names } = painter();
    g.capsule(-1, 0, 1, 0, 0.3, { fill: '#fff', stroke: '#000' });
    expect(names().filter((n) => n === 'arc').length).toBe(2);
    expect(names()).toContain('closePath');
    expect(names()).toContain('fill');
    const p2 = painter();
    // Both ends at one point: still a shape, not an empty path or a throw.
    expect(() => p2.g.capsule(0, 0, 0, 0, 0.4, { fill: '#fff' })).not.toThrow();
    expect(p2.names()).toContain('fill');
  });

  it('clipRect restores even when the callback throws', () => {
    const { g, c, names } = painter();
    expect(() => g.clipRect(0, 0, 4, 2, () => { throw new Error('boom'); })).toThrow('boom');
    // A clip that survived its callback would silently crop every later draw in
    // the frame — a rite that renders correctly exactly once.
    expect(names().filter((n) => n === 'save').length)
      .toBe(names().filter((n) => n === 'restore').length);
    expect(c.calls.find((x) => x[0] === 'rect').slice(1)).toEqual([-2, -1, 4, 2]);
  });

  it('linearFill hands back a gradient with the stops it was given', () => {
    const { g, c } = painter();
    const fill = g.linearFill(-8, 0, 8, 0, [[0, '#000'], [1, '#fff']]);
    expect(lastGradient(c)).toBe(fill);
    expect(fill.stops).toEqual([[0, '#000'], [1, '#fff']]);
    // Out-of-range offsets are clamped rather than passed through: canvas throws
    // an IndexSizeError on those, and a throw inside draw() kills the frame.
    const f2 = g.linearFill(0, 0, 1, 1, [[-1, '#000'], [4, '#fff']]);
    expect(f2.stops.map((s) => s[0])).toEqual([0, 1]);
  });
});

// ===========================================================================
describe('halo', () => {
  it('builds a real falloff from bare channels and an alpha', () => {
    const { g, c } = painter();
    g.halo(0, 0, 3, '229,160,90', 0.5);
    const stops = lastGradient(c).stops;
    expect(stops.length).toBe(3);
    expect(stops[0]).toEqual([0, 'rgba(229,160,90,0.5)']);
    expect(stops[2]).toEqual([1, 'rgba(229,160,90,0)']);
    // The middle stop is DIMMER than the first, which is the whole definition of
    // a falloff and precisely what the old regex failed to guarantee.
    expect(stops[1][0]).toBe(0.55);
    expect(stops[1][1]).toBe('rgba(229,160,90,0.1700)');
  });

  it('still renders the four legacy rites exactly as before', () => {
    const { g, c } = painter();
    g.halo(0, 0, 8.2, 'rgba(229, 160, 90, 0.24)');
    let stops = lastGradient(c).stops;
    expect(stops[0]).toEqual([0, 'rgba(229, 160, 90, 0.24)']);
    expect(stops[1]).toEqual([0.55, 'rgba(229,160,90,0.18)']);
    expect(stops[2]).toEqual([1, 'rgba(0,0,0,0)']);

    // ...including the five-argument form, where the fifth argument meant
    // `inner`. Reading it as the new `alpha` would move every legacy glow.
    g.halo(0, 0, 2, 'rgba(255,255,255,0.28)', 0.35);
    stops = lastGradient(c).stops;
    expect(stops[1][0]).toBe(0.35);
  });

  /**
   * THE BUG THIS SIGNATURE CHANGE EXISTS FOR.
   *
   * `color.replace(/[\d.]+\)$/, '0.18)')` is a regex pretending to be a colour
   * parser. Hand it a hex, a named colour or an rgb() with no alpha and the
   * replace matches nothing, so the middle stop comes back IDENTICAL to the
   * first — the gradient collapses into a flat disc with a hard edge, and
   * nothing throws, warns or logs.
   */
  it('never produces a middle stop identical to the first', () => {
    const { g, c } = painter();
    for (const col of ['#e9ebf3', 'gold', 'rgb(12,34,56)', 'hsl(210 50% 50%)']) {
      g.halo(0, 0, 1, col);
      const stops = lastGradient(c).stops;
      const flat = stops.length >= 2 && stops[0][1] === stops[1][1];
      expect(flat, `${col} produced a flat two-stop "gradient"`).toBe(false);
    }
  });
});

/* =========================================================================
   THE FACES, THE MEASUREMENT, AND THE FIELD CLIP
   -------------------------------------------------------------------------
   Three capabilities added together because they answer one review finding:
   the display face never reached the canvas, and the moment it can, something
   has to say which face may be laid out arithmetically and which may not.
   ========================================================================= */

describe('the faces reach the canvas', () => {
  it('defaults to monospace, exactly as before', () => {
    const { g, c } = painter();
    g.text('x', 0, 0, { size: 0.5 });
    expect(c.font).toBe('400 0.5px ui-monospace, SFMono-Regular, Menlo, monospace');
  });

  it('resolves the display and numeric faces by key', () => {
    const { g, c } = painter();
    g.text('x', 0, 0, { size: 0.5, font: 'display' });
    expect(c.font).toMatch(/Optima/);
    g.text('x', 0, 0, { size: 0.5, font: 'num' });
    expect(c.font).toMatch(/SF Mono/);
  });

  it('passes a raw CSS stack straight through', () => {
    // A rite that wants something not in the table is not blocked; it simply
    // gets no measurability guarantee.
    const { g, c } = painter();
    g.text('x', 0, 0, { size: 0.5, font: 'Georgia, serif' });
    expect(c.font).toBe('400 0.5px Georgia, serif');
    expect(measurableFace('Georgia, serif')).toBe(false);
  });

  /**
   * THE POINT OF THE WHOLE FEATURE, AND THE THING A RITE AUTHOR WILL GET WRONG.
   *
   * `contract.js approxTextWidth` is `0.6 * size * length` and its docblock
   * says plainly that it is a guess for anything but monospace. HuntRite lays
   * out rival names and a claim plate with it. So the table has to be able to
   * answer "may I measure this arithmetically" — if it could not, the only
   * thing standing between the pretty font and overlapping text would be
   * whether the next author read a comment.
   */
  it('says which faces approxTextWidth may be used with', () => {
    expect(measurableFace('mono')).toBe(true);
    expect(measurableFace()).toBe(true);
    expect(measurableFace('num')).toBe(true);
    expect(measurableFace('display')).toBe(false);
    expect(measurableFace('ui')).toBe(false);
  });

  it('an unknown key falls back to the MEASURABLE face, not the pretty one', () => {
    // A typo must not silently break a measured layout. `face()` hands an
    // unrecognised string back as a raw stack, and `measurableFace` reports
    // false for it — the safe answer in both directions.
    expect(measurableFace('dsiplay')).toBe(false);
  });

  it('survives node, where there is no document to read a token off', () => {
    // The whole resolution path is `getComputedStyle(document.documentElement)`
    // and this suite runs in node. A throw or an empty string here would give
    // every rite the context's default 10px sans-serif — a silently wrong
    // picture, which is the failure mode this class exists to avoid.
    resetFaces();
    expect(typeof document).toBe('undefined');
    expect(face('display')).toMatch(/Optima/);
    expect(face('num')).toMatch(/SF Mono/);
    expect(face()).toMatch(/ui-monospace/);
    resetFaces();
  });

  it('measure() agrees with the font text() would have set', () => {
    const c = fakeCtx();
    let asked = null;
    c.measureText = (s) => { asked = { s, font: c.font }; return { width: 4.2 }; };
    const g = new Painter(c);
    g.layout(1600, 900, 2);
    expect(g.measure('abc', { size: 0.6, font: 'display' })).toBe(4.2);
    expect(asked.s).toBe('abc');
    expect(asked.font).toMatch(/Optima/);
    expect(asked.font).toMatch(/0\.6px/);
  });

  it('measure() falls back to the approximation with no measureText', () => {
    // The recording double in this file has none, and neither does node.
    // A NaN here would propagate silently into a plate width.
    const { g } = painter();
    expect(g.measure('abcde', { size: 0.5 })).toBeCloseTo(0.6 * 0.5 * 5, 10);
  });
});

describe('clipField', () => {
  /**
   * OffroadRite draws to y = -7.15 and PlatformsRite drops a dead player to
   * y ~= -7, both outside the +-4.5 field. Both were masked by a canvas that
   * was WIDER than 16:9 and therefore fitted the field to its height. Now that
   * the stage is honestly 16:9 there is no slack left to absorb an overdraw,
   * and this is the one-word opt-in those rites need.
   */
  it('clips to exactly the field rectangle', () => {
    const { g, c, names } = painter();
    let inside = false;
    g.clipField(() => { inside = true; });
    expect(inside).toBe(true);
    const rect = c.calls.find((x) => x[0] === 'rect');
    expect(rect.slice(1)).toEqual([-FIELD.w / 2, -FIELD.h / 2, FIELD.w, FIELD.h]);
    expect(names()).toContain('clip');
    // save/restore paired, or the clip leaks into the rest of the frame and
    // the rite renders correctly exactly once.
    expect(names().filter((n) => n === 'save').length)
      .toBe(names().filter((n) => n === 'restore').length);
  });

  it('lifts the clip even if the callback throws', () => {
    const { g, names } = painter();
    expect(() => g.clipField(() => { throw new Error('boom'); })).toThrow('boom');
    expect(names().filter((n) => n === 'save').length)
      .toBe(names().filter((n) => n === 'restore').length);
  });
});
