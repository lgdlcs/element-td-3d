/**
 * THE PAINTER — the only thing a rite is allowed to draw with.
 *
 * It owns one transform and one job: turn the fixed 16x9 world rectangle
 * (contract.js FIELD) into whatever canvas the player has, letterboxed, at the
 * device pixel ratio. A rite therefore never sees a pixel, a DPR or a viewport
 * size, and a rite drawn at 1600x900 is the same drawing at 3840x1600.
 *
 * WHY THE Y AXIS IS FLIPPED HERE AND NOT IN EVERY RITE. Canvas 2D puts +y down;
 * the field puts +y up, like the rest of the game's maths. Doing the flip once,
 * in the transform, is the difference between one negation in this file and a
 * negation scattered through every rite, half of which will be forgotten. The
 * cost is that TEXT has to un-flip locally (glyphs would render upside down), so
 * `text()` does that itself and is the only place in the codebase that needs to
 * know.
 *
 * WHY THERE IS NO `get ctx()`. Exposing the raw CanvasRenderingContext2D would
 * let a rite do pixel work — `ctx.lineWidth = 2`, `ctx.font = '14px'` — and
 * every one of those is a difficulty or legibility bug that only appears on
 * someone else's monitor. If a primitive is missing, add it here where it is
 * expressed in world units for everyone. The escape hatch is deliberate absence.
 *
 * THE ONE HOLE IN THAT GUARANTEE, NAMED RATHER THAN DENIED: `linearFill` returns
 * a live CanvasGradient, which is an opaque handle belonging to the context. Two
 * rules make it safe, and they are rules because nothing can enforce them:
 *   1. CALL IT AT DRAW TIME ONLY. A gradient is bound to the context it came
 *      from and to the transform in force when it was created; one cached in
 *      `init` and reused after a resize paints the wrong place, or nothing.
 *   2. THE RETURN VALUE IS ONLY EVER PASSED STRAIGHT BACK as `o.fill` or
 *      `o.stroke`. It is not state, it is not stored, it is not inspected.
 * The alternative — twenty stacked translucent rectangles to fake a ramp — is
 * uglier, slower and still wrong at the edges. This is the smaller cost.
 *
 * No import of three, no import of Game. This file is the only DOM-adjacent part
 * of the rite pipeline, and it is adjacent rather than coupled: it takes a 2D
 * context and never looks up an element.
 */

import { FIELD } from './contract.js';

/** Degrees are for humans; every angle in this API is radians. */
const TAU = Math.PI * 2;

/* =========================================================================
   THE FACES
   -------------------------------------------------------------------------
   The game speaks in three voices — a flared humanist serif for identity, a
   grotesque for prose, a monospace for every number (ui.css, top of file) —
   and until this pass NONE of them reached the canvas. `text()` hardcoded a
   monospace stack and no rite ever passed `font`, so 100 % of on-canvas type
   was mono while the chrome eight pixels above it was setting titles in
   Optima. The display face is the game's voice and it appeared nowhere in the
   one place a rite is allowed to be expressive.

   WHY A TABLE OF KEYS AND NOT "just pass var(--font-display)". A rite has no
   DOM. It is handed a Painter and nothing else, so it cannot read a custom
   property off an element, and `ctx.font = 'var(--font-display)'` is not a
   font — it is a silently-ignored string that leaves the previous face in
   force. The lookup has to happen here, once, against
   `document.documentElement`, which is the same pattern minigames.css
   documents for the `--rite-<id>-*` colours.

   ── WHICH FACE IS SAFE FOR MEASURED LAYOUT ─────────────────────────────────

   `contract.js approxTextWidth` returns `0.6 * size * length`. That is within
   a few percent for a MONOSPACE face and it is a GUESS for anything else — the
   docblock there says so. A rite that measures a proportional string with it
   produces plates that are too small and labels that overlap, on someone
   else's machine, with no test failing. HuntRite's rival-name row and claim
   plate both depend on it today.

   So the table below is split, and the split is the API:

     'mono'  (default)  measurable  -> approxTextWidth is valid
     'num'              measurable  -> approxTextWidth is valid
     'display'          PROPORTIONAL -> approxTextWidth LIES. Use g.measure().
     'ui'               PROPORTIONAL -> approxTextWidth LIES. Use g.measure().

   `Painter.measurable(key)` is that table, queryable. `g.measure(str, size,
   o)` is the way out: a real `ctx.measureText` in world units, exact for any
   face — but it needs a live canvas, so it can only be called at DRAW time.
   That constraint is the honest one: proportional type may be laid out while
   drawing it, never in `update()` where the unit suite runs in node.

   THE FALLBACKS ARE LITERAL COPIES of the ui.css tokens rather than a throw or
   an empty string, so a Painter constructed in node or jsdom — where there is
   no computed style to read — paints a sane face instead of falling back to
   the context's default 10px sans. The duplication is deliberate and is the
   only kind that is safe: if the token drifts, the browser wins and the
   fallback is never consulted.
   ========================================================================= */

/** @type {Record<string, {token: ?string, stack: string, measurable: boolean}>} */
const FACES = Object.freeze({
  mono: {
    token: null,   // no token: this IS the Painter's own default, deliberately
    stack: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    measurable: true,
  },
  num: {
    token: '--font-num',
    stack: "'SF Mono', 'JetBrains Mono', 'Roboto Mono', ui-monospace, Menlo, Consolas, monospace",
    measurable: true,
  },
  display: {
    token: '--font-display',
    stack: "'Optima', 'Palatino', 'Palatino Linotype', 'Iowan Old Style', 'Hoefler Text', Georgia, serif",
    measurable: false,
  },
  ui: {
    token: '--font-ui',
    stack: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'Segoe UI', sans-serif",
    measurable: false,
  },
});

/** Resolved stacks, keyed as in FACES. Cleared by `resetFaces()`. */
let faceCache = null;

/**
 * The CSS font stack for a face key.
 *
 * Reads the token off `document.documentElement` the first time it is asked
 * and caches the answer: `getComputedStyle` forces a style recalc and `text()`
 * runs many times a frame, so an uncached lookup is a per-glyph reflow. The
 * tokens are static for the life of the document, so the cache is not a
 * staleness risk — `resetFaces()` exists for the test that swaps the document
 * out from under it, not for production.
 *
 * An unknown key resolves to `mono`. That is deliberate: an unknown key is a
 * typo, and a typo that falls back to the MEASURABLE face cannot silently
 * break a measured layout. Passing a raw stack ('Georgia, serif') still works
 * and is passed straight through — anything containing a space or a comma is
 * not a key.
 *
 * @param {string} [name='mono']
 * @returns {string} a CSS font-family list
 */
export function face(name = 'mono') {
  if (typeof name === 'string' && !Object.prototype.hasOwnProperty.call(FACES, name)) {
    return name;   // a raw stack, handed back untouched
  }
  const key = name || 'mono';
  if (!faceCache) faceCache = Object.create(null);
  if (faceCache[key] !== undefined) return faceCache[key];

  const def = FACES[key];
  let stack = def.stack;
  if (def.token && typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(def.token).trim();
      if (v) stack = v;
    } catch { /* jsdom without a live view, node with a document shim: keep the literal */ }
  }
  faceCache[key] = stack;
  return stack;
}

/** Drop the resolved-stack cache. For tests that replace the document. */
export function resetFaces() { faceCache = null; }

/**
 * Is `contract.js approxTextWidth` valid for this face?
 *
 * True for the two monospace faces and for the default. FALSE for 'display'
 * and 'ui', and false is not a warning — it is the answer to "may I lay this
 * string out arithmetically", and the answer is no: use `Painter#measure`.
 * A raw stack (anything not in the table) is reported as NOT measurable,
 * because nothing here can know what it is.
 */
export function measurableFace(name = 'mono') {
  const def = FACES[name || 'mono'];
  return !!def && def.measurable;
}

export class Painter {
  /** @param {CanvasRenderingContext2D} ctx2d */
  constructor(ctx2d) {
    this.c = ctx2d;
    /**
     * CSS pixels per world unit, after letterboxing. Set by layout().
     *
     * NAMED `ppu` AND NOT `scale`, which is what it was called for exactly one
     * screenshot. Adding a `scale(x, y)` method to this class made the instance
     * FIELD shadow the prototype METHOD, so `g.scale(1, 0.3)` became "call the
     * number 1.0", every draw() threw, the whole rAF loop died and the overlay
     * froze on its first frame. It cost twenty minutes because the error —
     * "translate(...).scale is not a function" — points at the method, not at
     * the field. Never give a field the name of a method on the same class.
     */
    this.ppu = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
  }

  /**
   * Recompute the letterbox for a canvas of `cssW x cssH` at `dpr`.
   *
   * Called on every resize and every frame (it is a handful of divisions — far
   * cheaper than deciding whether it is needed). `min` of the two ratios is
   * what makes it a letterbox rather than a stretch: a stretched field changes
   * the aspect of every circle a rite draws and, worse, changes how far the
   * pointer travels per world unit on one axis only.
   */
  layout(cssW, cssH, dpr) {
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    this.ppu = Math.min(cssW / FIELD.w, cssH / FIELD.h);
    const s = this.ppu * dpr;
    // a=+s, d=-s: uniform scale with the y axis inverted. e,f centre the origin.
    this.c.setTransform(s, 0, 0, -s, (cssW * dpr) / 2, (cssH * dpr) / 2);
  }

  /**
   * CSS-pixel point -> field coordinates. The host's pointer plumbing; a rite
   * never needs it, because the input record it receives is already in field
   * units.
   */
  toField(px, py) {
    return {
      x: (px - this.cssW / 2) / this.ppu,
      y: -(py - this.cssH / 2) / this.ppu,
    };
  }

  /**
   * Field coordinates -> CSS-pixel point, relative to the canvas box. The exact
   * inverse of toField.
   *
   * IT EXISTS FOR THE E2E SPECS, and that is a real reason rather than a
   * convenience. A spec that wants to click on a world position has to undo the
   * letterbox, and the only other way to do that is to re-derive `ppu` and the
   * centring inside the spec — a second implementation of a transform, which
   * will agree with this one right up until someone changes the letterbox and
   * then produces clicks that land somewhere plausible but wrong. Pair it with
   * getBoundingClientRect() to get a viewport point.
   */
  toClient(x, y) {
    return {
      x: this.cssW / 2 + x * this.ppu,
      y: this.cssH / 2 - y * this.ppu,
    };
  }

  /** Wipe the whole backing store, transform-independent. */
  clear() {
    this.c.save();
    this.c.setTransform(1, 0, 0, 1, 0, 0);
    this.c.clearRect(0, 0, this.c.canvas.width, this.c.canvas.height);
    this.c.restore();
  }

  // ---- state ------------------------------------------------------------

  save() { this.c.save(); return this; }
  restore() { this.c.restore(); return this; }
  alpha(a) { this.c.globalAlpha = a; return this; }
  /** Additive blending, for sparks and glows. Always pair with restore(). */
  add() { this.c.globalCompositeOperation = 'lighter'; return this; }
  translate(x, y) { this.c.translate(x, y); return this; }
  rotate(a) { this.c.rotate(a); return this; }
  /** Non-uniform scale — the only way to get an elliptical halo out of `halo`. */
  scale(x, y = x) { this.c.scale(x, y); return this; }

  /**
   * Soft outer glow on subsequent fills. `blur` is in WORLD units and converted
   * here — shadowBlur is one of the few canvas properties the transform does not
   * apply to, which is exactly the sort of pixel leak this class exists to
   * absorb.
   */
  glow(color, blur) {
    this.c.shadowColor = color;
    this.c.shadowBlur = blur * this.ppu * this.dpr;
    return this;
  }

  noGlow() { this.c.shadowBlur = 0; this.c.shadowColor = 'transparent'; return this; }

  // ---- primitives -------------------------------------------------------

  /** @param {{fill?:string, stroke?:string, width?:number}} o */
  circle(x, y, r, o = {}) {
    const c = this.c;
    c.beginPath();
    c.arc(x, y, Math.max(0, r), 0, TAU);
    if (o.fill) { c.fillStyle = o.fill; c.fill(); }
    if (o.stroke) { c.strokeStyle = o.stroke; c.lineWidth = o.width ?? 0.04; c.stroke(); }
    return this;
  }

  /** Arc from `a0` to `a1` radians, stroked. */
  arc(x, y, r, a0, a1, color, width = 0.06, cap = 'round') {
    const c = this.c;
    c.beginPath();
    c.arc(x, y, Math.max(0, r), a0, a1);
    c.strokeStyle = color; c.lineWidth = width; c.lineCap = cap;
    c.stroke();
    return this;
  }

  /** Centre-anchored rectangle. `o.radius` rounds the corners, in world units. */
  rect(cx, cy, w, h, o = {}) {
    const c = this.c;
    const x = cx - w / 2, y = cy - h / 2;
    c.beginPath();
    if (o.radius) c.roundRect(x, y, w, h, Math.min(o.radius, w / 2, h / 2));
    else c.rect(x, y, w, h);
    if (o.fill) { c.fillStyle = o.fill; c.fill(); }
    if (o.stroke) { c.strokeStyle = o.stroke; c.lineWidth = o.width ?? 0.03; c.stroke(); }
    return this;
  }

  line(x1, y1, x2, y2, color, width = 0.03, cap = 'butt') {
    const c = this.c;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2);
    c.strokeStyle = color; c.lineWidth = width; c.lineCap = cap; c.stroke();
    return this;
  }

  /** @param {Array<[number,number]>} pts */
  poly(pts, o = {}) {
    if (pts.length < 2) return this;
    const c = this.c;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    if (o.close !== false) c.closePath();
    if (o.fill) { c.fillStyle = o.fill; c.fill(); }
    if (o.stroke) { c.strokeStyle = o.stroke; c.lineWidth = o.width ?? 0.03; c.stroke(); }
    return this;
  }

  /**
   * A CLOSED, SMOOTHED outline through `pts` — the shape primitive.
   *
   * `poly` joins its points with straight segments, which is right for a plate
   * and wrong for everything alive. A canopy, a deer, a fish and a car shell are
   * all "a smooth closed silhouette", and drawing them with `poly` does not read
   * as stylised low-poly, it reads as a curve someone failed to tessellate.
   *
   * The curve is a quadratic through the MIDPOINT of every segment, using each
   * input point as the control handle. That is the classic closed-spline trick
   * and it has the property this needs: the outline is C1 continuous everywhere
   * including across the seam, it never overshoots the convex hull of the input,
   * and it needs no tangents — so a rite can generate its silhouette with six
   * seeded radii in a loop and get something organic without solving anything.
   * The points are pulled toward, not passed through; for a shape that must hit
   * an exact coordinate, put a point on each side of it or use `poly`.
   *
   * @param {Array<[number,number]>} pts  3 or more. Fewer falls through to poly.
   * @param {{fill?:string|CanvasGradient, stroke?:string|CanvasGradient, width?:number}} o
   */
  blob(pts, o = {}) {
    const n = pts.length;
    if (n < 3) return this.poly(pts, o);
    const c = this.c;
    // Scalars, not [x,y] pairs: this runs per shape per frame and the midpoints
    // are pure intermediates. No allocation.
    let px = pts[n - 1][0], py = pts[n - 1][1];
    c.beginPath();
    c.moveTo((px + pts[0][0]) / 2, (py + pts[0][1]) / 2);
    for (let i = 0; i < n; i++) {
      px = pts[i][0]; py = pts[i][1];
      const nx = pts[(i + 1) % n][0], ny = pts[(i + 1) % n][1];
      c.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
    }
    c.closePath();
    if (o.fill) { c.fillStyle = o.fill; c.fill(); }
    if (o.stroke) { c.strokeStyle = o.stroke; c.lineWidth = o.width ?? 0.03; c.stroke(); }
    return this;
  }

  /**
   * A true ellipse, centred, rotated by `rot` radians.
   *
   * The only way to get one before this was `save().scale(1, 0.4).circle(...)`,
   * and that is not the same drawing: a non-uniform scale is applied to the PEN
   * as well as to the path, so a 0.04 stroke comes out 0.04 wide on one axis and
   * 0.016 on the other. The outline ends up a different eccentricity from the
   * fill it is supposed to be tracing, which is most visible on exactly the
   * thing ellipses are for — a contact shadow under a tilting object.
   *
   * @param {{fill?:string|CanvasGradient, stroke?:string|CanvasGradient, width?:number}} o
   */
  ellipse(cx, cy, rx, ry, rot = 0, o = {}) {
    const c = this.c;
    c.beginPath();
    c.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), rot, 0, TAU);
    if (o.fill) { c.fillStyle = o.fill; c.fill(); }
    if (o.stroke) { c.strokeStyle = o.stroke; c.lineWidth = o.width ?? 0.03; c.stroke(); }
    return this;
  }

  /**
   * A stadium: the segment (x1,y1)-(x2,y2) swept by a disc of radius `r`.
   *
   * A real closed path rather than a thick round-capped `line`, which is the
   * shape you reach for otherwise — and which cannot be filled and stroked
   * differently, because with a line the fill IS the stroke. Limbs, fish bodies,
   * rails, gates and boost bars all want an outline in a second colour.
   *
   * @param {{fill?:string|CanvasGradient, stroke?:string|CanvasGradient, width?:number}} o
   */
  capsule(x1, y1, x2, y2, r, o = {}) {
    const c = this.c;
    const rr = Math.max(0, r);
    const a = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath();
    // Two half-turns in the same direction, joined by the straight sides the
    // arcs imply. Degenerate (both ends equal) falls out as a circle, which is
    // the right answer rather than an empty path.
    c.arc(x1, y1, rr, a + Math.PI / 2, a + Math.PI * 1.5);
    c.arc(x2, y2, rr, a - Math.PI / 2, a + Math.PI / 2);
    c.closePath();
    if (o.fill) { c.fillStyle = o.fill; c.fill(); }
    if (o.stroke) { c.strokeStyle = o.stroke; c.lineWidth = o.width ?? 0.03; c.stroke(); }
    return this;
  }

  /**
   * A linear gradient in WORLD units, for use as `o.fill` or `o.stroke`.
   *
   * READ THE DOCBLOCK AT THE TOP OF THIS FILE FIRST. This is the one place the
   * raw context leaks a handle, and the two rules are: call it at DRAW TIME, and
   * pass the result STRAIGHT BACK as a fill or a stroke. Never store it — a
   * gradient outlives neither a resize nor a transform change, and one cached in
   * `init` paints the wrong place forever without throwing.
   *
   * @param {Array<[number,string]>} stops  [offset 0..1, css colour]
   * @returns {CanvasGradient}
   */
  linearFill(x1, y1, x2, y2, stops) {
    const g = this.c.createLinearGradient(x1, y1, x2, y2);
    for (const [at, col] of stops) g.addColorStop(Math.max(0, Math.min(1, at)), col);
    return g;
  }

  /**
   * Run `fn` with drawing clipped to a centre-anchored rectangle.
   *
   * Callback-scoped rather than a clip()/unclip() pair, because there is no
   * unclip: the only way back is restore(), so an API that let a rite set a clip
   * and forget to lift it would leak the clip into every later draw call in the
   * frame and produce a rite that renders correctly exactly once. A scroller, a
   * water line and a scope reticle all want this and none of them should have to
   * remember the save.
   *
   * @param {(g: Painter) => void} fn
   */
  clipRect(cx, cy, w, h, fn) {
    const c = this.c;
    c.save();
    c.beginPath();
    c.rect(cx - w / 2, cy - h / 2, w, h);
    c.clip();
    try { fn(this); } finally { c.restore(); }
    return this;
  }

  /**
   * A radial falloff blob. The cheapest convincing light in 2D, and the reason
   * the overlay can look lit without adding a single thing to the three.js
   * pipeline (docs/PERF_BUDGET.md: the frame is fragment-bound, the CPU is not).
   *
   * SIGNATURE: `halo(x, y, r, rgb, alpha = 1, inner = 0.55)`, where `rgb` is the
   * BARE channels — '229,160,90' — and the stops are built here.
   *
   * WHY IT CHANGED. The old form took a whole `rgba(...)` string and derived its
   * middle stop with `color.replace(/[\d.]+\)$/, '0.18)')`. That is a regex
   * pretending to be a colour parser: hand it '#e9ebf3', 'gold', a computed
   * `color-mix(...)` or an rgb() with no alpha and the replace does nothing, so
   * the middle stop is IDENTICAL to the first, the falloff collapses to a hard
   * disc, and nothing anywhere throws. A silent wrong picture is the worst
   * failure mode this class can have, so the alpha is now a number.
   *
   * The old call shape still works and still renders exactly as it did — the
   * four existing rites use it — detected by sniffing a leading `rgb(`/`rgba(`,
   * in which case the fifth argument is read as `inner` the way it used to be.
   * A colour that is neither form (a hex, a name, an hsl) fades in two stops
   * rather than three: never flat, and never a throw.
   *
   * (The defaults are resolved in the body rather than in the parameter list:
   * `alpha` and `inner` share a slot across the two call shapes, so a default
   * expression there would silently turn a legacy 4-argument call into inner=1.)
   */
  halo(x, y, r, rgb, alpha, inner) {
    const c = this.c;
    const g = c.createRadialGradient(x, y, 0, x, y, Math.max(0.0001, r));

    if (typeof rgb === 'string' && /^rgba?\(/.test(rgb)) {
      // Legacy call: a full colour string, and the 5th slot meant `inner`.
      const at = typeof alpha === 'number' ? alpha : 0.55;
      g.addColorStop(0, rgb);
      const m = rgb.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
      // 0.18 is the literal the old regex substituted, kept so the four rites
      // written against it look identical. Unparseable colours skip the middle
      // stop entirely rather than repeat themselves into a hard-edged disc.
      if (m) g.addColorStop(at, `rgba(${m[1]},${m[2]},${m[3]},0.18)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
    } else if (typeof rgb === 'string' && /^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$/.test(rgb)) {
      const a = typeof alpha === 'number' ? alpha : 1;
      const at = typeof inner === 'number' ? inner : 0.55;
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(at, `rgba(${rgb},${(a * 0.34).toFixed(4)})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
    } else {
      /**
       * Anything else — a hex, a named colour, an hsl(), a CSS variable already
       * resolved to something unexpected — fades from the colour to nothing in
       * two stops.
       *
       * NOT interpolated into `rgba(...)`, which is the tempting one-liner:
       * `rgba(#e9ebf3,1)` is not a colour, and addColorStop THROWS on an
       * unparseable one. A throw inside draw() is not a wrong picture, it is a
       * dead rite (MinigameHost.#guard abandons it) — so the fallback is a real
       * gradient rather than a crash, and unlike the old regex it is never flat.
       */
      g.addColorStop(0, rgb);
      g.addColorStop(1, 'rgba(0,0,0,0)');
    }

    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, Math.max(0, r), 0, TAU); c.fill();
    return this;
  }

  /**
   * Text, in world units, upright.
   *
   * `size` is a cap height in world units, so 0.6 is the same fraction of the
   * field on every screen. The local scale(1,-1) undoes the field's y-flip for
   * the glyphs only; without it every label renders mirrored, which is the first
   * thing anyone hits when they add text to a flipped canvas.
   *
   * `tracking` IS IN WORLD UNITS, like everything else here, and that sentence
   * exists because the first version passed it through as `${tracking}px`. Under
   * the field transform a "pixel" is one WORLD unit — about 83 screen pixels at
   * 1600x900 — so `tracking: 3` rendered a five-letter word across the whole
   * anvil with the rest of the sentence clipped off the field. Caught in a
   * screenshot, not by a test, which is the honest reason the note is this long.
   *
   * `font` IS A FACE KEY — 'mono' (the default), 'num', 'display' or 'ui' —
   * resolved against the ui.css type tokens by `face()` above. Read the FACES
   * docblock at the top of this file before reaching for 'display': it is the
   * game's voice, it is the right choice for a headline painted on the canvas,
   * and `contract.js approxTextWidth` CANNOT MEASURE IT. Anything laid out
   * against a measured width — a plate sized to its label, a row of names that
   * must not collide — either stays on 'mono'/'num' or is measured for real
   * with `measure()` below. A raw CSS stack is still accepted and still works;
   * it is simply reported as unmeasurable, because nothing here can know.
   *
   * @param {{size?:number, fill?:string, align?:CanvasTextAlign,
   *          baseline?:CanvasTextBaseline, font?:string, weight?:string|number,
   *          tracking?:number}} o
   */
  text(str, x, y, o = {}) {
    const c = this.c;
    const size = o.size ?? 0.5;
    c.save();
    c.translate(x, y);
    c.scale(1, -1);
    c.font = `${o.weight ?? 400} ${size}px ${face(o.font)}`;
    c.textAlign = o.align ?? 'center';
    c.textBaseline = o.baseline ?? 'middle';
    if (o.tracking) c.letterSpacing = `${o.tracking}px`;
    c.fillStyle = o.fill ?? '#e9ebf3';
    c.fillText(str, 0, 0);
    if (o.tracking) c.letterSpacing = '0px';
    c.restore();
    return this;
  }

  /**
   * The REAL advance width of `str`, in world units. The escape hatch that
   * makes the proportional faces usable in a measured position.
   *
   * `contract.js approxTextWidth` is `0.6 * size * length` and is only honest
   * for a monospace face. This is `ctx.measureText` under the same font string
   * `text()` would set, so it is exact for every face — including 'display',
   * where the approximation is off by tens of percent on a word like "Wynn".
   *
   * THE PRICE, STATED RATHER THAN HIDDEN: it needs a live 2D context, so it
   * exists only at DRAW time. A rite that wants a plate sized to a proportional
   * label must size it inside `draw()`; it cannot precompute the layout in
   * `update()`, which is where the node unit suite runs. That is not a
   * limitation to work around — it is the reason `approxTextWidth` exists, and
   * the boundary between "geometry the simulation owns" and "geometry the
   * picture owns" is exactly where it belongs.
   *
   * Falls back to `approxTextWidth`'s formula if the context cannot measure
   * (a recording double in a unit test), so a caller never gets NaN.
   *
   * @param {{size?:number, font?:string, weight?:string|number}} [o]
   */
  measure(str, o = {}) {
    const size = o.size ?? 0.5;
    const s = String(str);
    const c = this.c;
    if (typeof c.measureText !== 'function') return 0.6 * size * s.length;
    c.save();
    c.font = `${o.weight ?? 400} ${size}px ${face(o.font)}`;
    const m = c.measureText(s);
    c.restore();
    const w = m && Number.isFinite(m.width) ? m.width : null;
    return w === null ? 0.6 * size * s.length : w;
  }

  /**
   * Run `fn` clipped to the whole field — the one-line guard against painting
   * outside the world.
   *
   * WHY THIS IS ITS OWN METHOD AND NOT `clipRect(0, 0, FIELD.w, FIELD.h, fn)`.
   * It is the same call, and that is the point: the version a rite would have
   * to write by hand imports FIELD, spells out four arguments and can be typed
   * wrong; this one cannot, and it costs a rite author one word to be safe.
   *
   * THE HAZARD IT ANSWERS. The stage used to be 2.12:1 while the field is
   * 16:9, so `Painter.layout` fitted the field to the stage's HEIGHT and threw
   * away 8 % of the width on each side. Every rite therefore had its
   * out-of-field geometry hidden by the canvas edge for free, and two of them
   * lean on that without saying so — `OffroadRite` draws to y = -7.15 and
   * +5.50 with no clip at all, and `PlatformsRite` lets a dead player fall to
   * y ~= -7. Now that the stage is exactly 16:9 the letterbox has no slack
   * left in either axis to absorb an overdraw, and a stage that is one pixel
   * taller than 16:9 on some future viewport turns those into visible spill.
   *
   * The cost is one save/clip/restore per frame, which is nothing next to the
   * hundreds of path operations inside it.
   *
   * @param {(g: Painter) => void} fn
   */
  clipField(fn) {
    return this.clipRect(0, 0, FIELD.w, FIELD.h, fn);
  }
}
