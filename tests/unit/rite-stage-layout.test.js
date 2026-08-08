/**
 * THE STAGE IS THE FIELD — A LAYOUT INVARIANT, TESTED.
 * ===========================================================================
 *
 * WHAT WENT WRONG, AND WHY NOTHING CAUGHT IT.
 *
 * `Painter.layout` letterboxes contract.js's fixed 16x9 FIELD into the canvas:
 * `ppu = min(cssW / 16, cssH / 9)`. That is correct code and it was doing its
 * job perfectly. The defect was one rule above it: `.rite-stage` declared
 * `aspect-ratio: 16 / 9` AND `width: 100%` AND `max-height: 56vh`. Those three
 * over-constrain the box, CSS keeps the explicit width and drops the ratio, and
 * the stage came out 1070 x 504 = 2.123 : 1 at a 1600x900 viewport. The painter
 * then fitted a 16:9 field into a 2.12:1 box and left 87.8 px of dead black on
 * EACH SIDE — 8.2 % of the stage per side, 16.4 % of the surface, on every frame
 * of all six minigames.
 *
 * The player-visible consequences were not subtle: fishing's waterline stopped
 * in mid-air, luckyshot's awning and all three rails were cut flat 78 px short,
 * and targets scrolling off the belt vanished into a bar instead of off-screen.
 *
 * AND IT SHIPPED. Through an entire build and a 128-spec e2e suite. Because
 * every existing test asks the same class of question — "did the rite score
 * correctly", "did the click land on the target", "did the overlay close" — and
 * all of those are answered through `painter.toClient`, which applies the SAME
 * wrong letterbox and therefore agrees with itself. A transform that is
 * consistently wrong is invisible to every test written in its own terms. The
 * only way to see it is to compare the letterbox against the box it is fitted
 * into, which is what this file does and nothing else did.
 *
 * ── WHY A UNIT TEST AND NOT AN E2E ASSERTION ────────────────────────────────
 *
 * An e2e check would be strictly better at one thing (a real browser really
 * lays the box out) and much worse at four:
 *   - it can only measure the ONE viewport the suite is configured with, and
 *     this defect is viewport-dependent: the ratio held fine at 1920x1080 and
 *     broke at 1600x900, because 56vh is what binds and 56vh moves;
 *   - it needs a GPU-backed Chromium, a booted 3D scene and ~30 s;
 *   - it cannot run on the CSS in isolation, so a stylesheet edit is only
 *     caught after someone runs the slow suite;
 *   - and it would live in tests/e2e, which the rite authors do not touch.
 * This runs in milliseconds against the stylesheet on disk, over a grid of
 * viewports chosen to make each constraint bind in turn.
 *
 * ── HOW IT WORKS, AND THE HONEST LIMIT ──────────────────────────────────────
 *
 * There is no layout engine in node and none in jsdom either (`offsetWidth` is
 * always 0), so this file contains a small, deliberately narrow CSS length
 * evaluator: px / vw / vh / %, `calc()`, `min()`, `max()`, `clamp()`, and one
 * level of `var()` indirection. It reads the DECLARATIONS OUT OF THE REAL
 * STYLESHEET rather than restating them, so a value edited in minigames.css
 * moves this test with it and a value DELETED from minigames.css fails it.
 *
 * The limit, stated rather than hidden: the evaluator models the box, it does
 * not implement CSS. It is checked against a real browser — the numbers it
 * predicts for the eight viewports below were compared against
 * `getBoundingClientRect()` in headless Chromium at the time of writing and
 * agreed to the pixel. If a future rule uses a feature this cannot evaluate,
 * `evalLength` throws by name instead of silently returning a plausible number,
 * which is the failure mode that matters.
 *
 * ── PROVE THE INSTRUMENT CAN FAIL (docs/TESTING.md §4) ──────────────────────
 *
 * Restore the shipped rule in `.rite-stage` — drop `box-sizing: content-box`
 * and `--rite-stage-h`, put back `width: 100%` and `max-height: 56vh` — and
 * FOUR of the eight assertions go red. The first prints, verbatim:
 *
 *   the painted field fills the stage on every viewport
 *     1600x900:  stage 1068.0 x 502.0 (2.1275:1), field 892.4 x 502.0 at ppu
 *                55.778, dead bar 87.8px per side (8.22% of stage width)
 *     1600x700:  stage 1068.0 x 390.0 (2.7385:1), field 693.3 x 390.0 at ppu
 *                43.333, dead bar 187.3px per side (17.54%)
 *     1280x800:  stage 1068.0 x 446.0 (2.3946:1), dead bar 137.6px (12.88%)
 *     2560x1000: stage 1068.0 x 558.0 (1.9140:1), dead bar 38.0px (3.56%)
 *
 * THOSE ARE THE REAL BROWSER'S NUMBERS. Headless Chromium at 1600x900 measured
 * canvas 1068 x 502 and `painter.ppu` 55.778 against the shipped stylesheet;
 * the model above predicts 1068 x 502 and 55.778. It is a model, but it is a
 * checked one.
 *
 * Note which viewports do NOT appear in that list: 1920x1080, 1100x1400,
 * 900x900 and 700x900 were all fine under the old CSS, because the height
 * budget did not bind there. A test pinned to one viewport — and the e2e suite
 * runs at exactly one, 1600x900 — could have been written against any of those
 * four and would have passed forever.
 *
 * Deleting `box-sizing: content-box` ALONE also fails it, and this is the more
 * valuable half: the stage comes out 890.4 x 500.0 = 1.7809:1 and the bar is
 * 0.8px per side, 0.09% of the width. Invisible on screen, identical in kind,
 * and precisely what a percentage tolerance would have waved through.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIELD } from '../../src/minigames/contract.js';

const CSS_PATH = fileURLToPath(new URL('../../src/ui/minigames.css', import.meta.url));
const CSS = readFileSync(CSS_PATH, 'utf8');

// ---------------------------------------------------------------------------
// A very small stylesheet reader.
// ---------------------------------------------------------------------------

/** Strip /* … *\/ comments. This file is mostly comments, so this matters. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Flatten the sheet to `{ media, selector, decls }` records, in source order.
 * Only one level of `@media` nesting exists in this stylesheet and only one
 * level is supported; a second level throws rather than being ignored.
 */
function parseRules(src) {
  const s = stripComments(src);
  const out = [];
  let i = 0;
  let media = null;

  while (i < s.length) {
    const brace = s.indexOf('{', i);
    if (brace === -1) break;
    const prelude = s.slice(i, brace).trim();

    if (prelude.startsWith('@media')) {
      if (media) throw new Error('nested @media is not supported by this reader');
      media = prelude.slice('@media'.length).trim();
      i = brace + 1;
      continue;
    }
    if (prelude.startsWith('@keyframes') || prelude.startsWith('@supports')) {
      // Skip the whole block, braces and all. Nothing inside can declare a box.
      let d = 1, j = brace + 1;
      while (j < s.length && d > 0) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
      i = j;
      continue;
    }
    if (prelude.startsWith('@')) throw new Error(`unsupported at-rule: ${prelude}`);

    const close = s.indexOf('}', brace);
    if (close === -1) break;
    const body = s.slice(brace + 1, close);

    const decls = {};
    for (const part of body.split(';')) {
      const c = part.indexOf(':');
      if (c === -1) continue;
      decls[part.slice(0, c).trim()] = part.slice(c + 1).trim();
    }
    for (const sel of prelude.split(',')) {
      out.push({ media, selector: sel.trim(), decls });
    }

    i = close + 1;
    // A `}` that closes the media block rather than a rule: the next non-space
    // char is another `}`.
    const next = s.slice(i).match(/^\s*\}/);
    if (media && next) { media = null; i += next[0].length; }
  }
  return out;
}

const RULES = parseRules(CSS);

/**
 * Does a `@media` prelude apply at this viewport?
 *
 * Only `max-width` is evaluated. `prefers-reduced-motion` is a USER setting
 * rather than a viewport, and the block it guards sets animations only — it
 * cannot move a box — so it is treated as not applying rather than throwing.
 * Anything else throws by name: a media query this cannot read would otherwise
 * be silently ignored, and a silently ignored rule is how the defect this file
 * exists for got in.
 */
function mediaApplies(media, vw) {
  if (!media) return true;
  if (/prefers-reduced-motion/.test(media)) return false;
  const m = media.match(/\(\s*max-width\s*:\s*([\d.]+)px\s*\)/);
  if (!m) throw new Error(`unsupported media query: ${media}`);
  return vw <= Number(m[1]);
}

/**
 * The cascaded value of `prop` for `selector` at viewport width `vw`.
 * Last matching declaration wins, which is right here because every rule in
 * this sheet that touches these properties has the same specificity.
 */
function declared(selector, prop, vw) {
  let v;
  for (const r of RULES) {
    if (r.selector !== selector) continue;
    if (!mediaApplies(r.media, vw)) continue;
    if (r.decls[prop] !== undefined) v = r.decls[prop];
  }
  return v;
}

/** Assert the sheet still declares something, with a message that says where. */
function require_(value, what) {
  if (value === undefined) {
    throw new Error(
      `${what} is not declared in src/ui/minigames.css. This test reads the ` +
      `real stylesheet rather than a copy of it, so a deleted declaration is a ` +
      `failure and not a silent pass.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// A very small CSS length evaluator. px / vw / vh / %, calc/min/max/clamp, var.
// ---------------------------------------------------------------------------

/**
 * @param {string} src   a CSS length expression
 * @param {{vw:number, vh:number, pct?:number, vars?:Record<string,string>}} ctx
 * @returns {number} px
 */
function evalLength(src, ctx) {
  const text = String(src).trim();
  let i = 0;

  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };

  function unit(n, u) {
    switch (u) {
      case '': case 'px': return n;
      case 'vw': return (n / 100) * ctx.vw;
      case 'vh': return (n / 100) * ctx.vh;
      case '%':
        if (ctx.pct === undefined) throw new Error(`'%' with no percentage base in: ${text}`);
        return (n / 100) * ctx.pct;
      default: throw new Error(`unsupported unit '${u}' in: ${text}`);
    }
  }

  function primary() {
    ws();
    if (text[i] === '(') { i++; const v = sum(); ws(); i++; return v; }

    const fn = /^(calc|min|max|clamp|var)\(/i.exec(text.slice(i));
    if (fn) {
      const name = fn[1].toLowerCase();
      i += fn[0].length;
      const args = [];
      if (name === 'var') {
        // var(--name) or var(--name, fallback) — one level, which is all the
        // sheet uses. The fallback is only consulted if the name is unset.
        ws();
        const start = i;
        while (i < text.length && !/[,)]/.test(text[i])) i++;
        const key = text.slice(start, i).trim();
        let fallback = null;
        if (text[i] === ',') { i++; const s2 = i; let d = 0;
          while (i < text.length && (d > 0 || text[i] !== ')')) { if (text[i] === '(') d++; if (text[i] === ')') d--; i++; }
          fallback = text.slice(s2, i).trim(); }
        ws(); i++;  // ')'
        const raw = ctx.vars?.[key] ?? fallback;
        if (raw == null) throw new Error(`unset custom property ${key} in: ${text}`);
        return evalLength(raw, ctx);
      }
      for (;;) {
        args.push(sum());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ')') { i++; break; }
        throw new Error(`malformed ${name}() in: ${text}`);
      }
      if (name === 'calc') return args[0];
      if (name === 'min') return Math.min(...args);
      if (name === 'max') return Math.max(...args);
      return Math.min(Math.max(args[0], args[1]), args[2]);  // clamp(min, val, max)
    }

    const num = /^[-+]?(?:\d*\.\d+|\d+)(px|vw|vh|%)?/.exec(text.slice(i));
    if (!num) throw new Error(`cannot parse a length at offset ${i} of: ${text}`);
    i += num[0].length;
    return unit(parseFloat(num[0]), num[1] ?? '');
  }

  function product() {
    let v = primary();
    for (;;) {
      ws();
      const op = text[i];
      if (op !== '*' && op !== '/') return v;
      i++;
      const rhs = primary();
      v = op === '*' ? v * rhs : v / rhs;
    }
  }

  function sum() {
    let v = product();
    for (;;) {
      ws();
      const op = text[i];
      // A '-' that starts a signed number is consumed by primary(); here a
      // +/- must be surrounded by whitespace, as CSS calc requires.
      if ((op !== '+' && op !== '-') || !/\s/.test(text[i - 1] ?? '')) return v;
      i++;
      v = op === '+' ? v + product() : v - product();
    }
  }

  const value = sum();
  ws();
  if (i !== text.length) throw new Error(`trailing input in: ${text}`);
  return value;
}

/** Horizontal padding from a `padding` shorthand (1..4 values). */
function padX(shorthand) {
  const parts = String(shorthand).trim().split(/\s+/);
  const right = parts.length === 1 ? parts[0] : parts[1];
  const left = parts.length >= 4 ? parts[3] : right;
  return { left, right };
}

// ---------------------------------------------------------------------------
// The model: what box does the stylesheet produce for `.rite-stage`?
// ---------------------------------------------------------------------------

/**
 * Resolve the stage's CONTENT box — which is exactly the canvas box, since
 * `.rite-stage canvas` is `width: 100%; height: 100%` — at a viewport.
 *
 * Everything below reads the sheet. The only facts hardcoded here are the two
 * the DOM owns rather than the stylesheet: that `.rite-stage` is a child of
 * `.rite-shell` (MinigameHost's markup), and that the global reset in ui.css
 * makes boxes `border-box` unless a rule says otherwise.
 */
function stageBox(vw, vh) {
  // The height budget lives on `#rite` and BOTH the shell and the stage derive
  // from it, which is the structural half of the fix: one number, two users.
  const budgetVars = {};
  for (const r of RULES) {
    if (r.selector !== '#rite' || !mediaApplies(r.media, vw)) continue;
    for (const [k, v] of Object.entries(r.decls)) if (k.startsWith('--')) budgetVars[k] = v;
  }
  require_(budgetVars['--rite-stage-h'], '--rite-stage-h on #rite');

  // --- the shell, which is the stage's containing block ---
  const shellW = evalLength(
    require_(declared('.rite-shell', 'width', vw), '.rite-shell width'),
    { vw, vh, vars: budgetVars });
  const shellPad = padX(require_(declared('.rite-shell', 'padding', vw), '.rite-shell padding'));
  const shellBorder = parseFloat(require_(declared('.rite-shell', 'border', vw), '.rite-shell border'));
  // border-box (global reset): the declared width includes border and padding.
  const inner = shellW - 2 * shellBorder
    - evalLength(shellPad.left, { vw, vh }) - evalLength(shellPad.right, { vw, vh });

  // --- the stage ---
  const vars = { ...budgetVars };
  for (const r of RULES) {
    if (r.selector !== '.rite-stage' || !mediaApplies(r.media, vw)) continue;
    for (const [k, v] of Object.entries(r.decls)) if (k.startsWith('--')) vars[k] = v;
  }
  const border = parseFloat(require_(declared('.rite-stage', 'border', vw), '.rite-stage border'));
  const contentBox = declared('.rite-stage', 'box-sizing', vw) === 'content-box';
  // The percentage base for a child's width is the containing block's CONTENT
  // width, whatever box-sizing the child itself uses.
  const ctx = { vw, vh, pct: inner, vars };

  const ratio = require_(declared('.rite-stage', 'aspect-ratio', vw), '.rite-stage aspect-ratio')
    .split('/').map(Number);

  const chrome = contentBox ? 0 : 2 * border;
  let w = evalLength(require_(declared('.rite-stage', 'width', vw), '.rite-stage width'), ctx) - chrome;
  let h = w * (ratio[1] / ratio[0]);

  const maxH = declared('.rite-stage', 'max-height', vw);
  if (maxH !== undefined) {
    // max-height applies to the same box aspect-ratio does, so it is compared
    // in the same terms and then converted back to a content height.
    const cap = evalLength(maxH, ctx) - chrome;
    if (h > cap) h = cap;   // THE OVER-CONSTRAINT: width is kept, ratio is not.
  }
  return { w, h, shellW, inner, budget: evalLength(budgetVars['--rite-stage-h'], { vw, vh }) };
}

/** What Painter.layout would do with that box. */
function letterbox(box) {
  const ppu = Math.min(box.w / FIELD.w, box.h / FIELD.h);
  return { ppu, fieldW: ppu * FIELD.w, fieldH: ppu * FIELD.h };
}

/**
 * The viewports. Chosen so that each constraint binds on some of them:
 *  - the height budget binds on the short/wide ones (1600x700, 2560x1000);
 *  - the shell's own width binds on the tall/narrow ones (1100x1400, 900x900);
 *  - 1600x900 is the e2e suite's viewport and the one the defect was measured
 *    at; 1920x1080 is the one where the old CSS happened to look FINE, which is
 *    precisely why a single-viewport check would not have caught this.
 */
const VIEWPORTS = [
  { w: 1600, h: 900 },
  { w: 1600, h: 700 },
  { w: 1920, h: 1080 },
  { w: 1280, h: 800 },
  { w: 1100, h: 1400 },
  { w: 900, h: 900 },
  { w: 700, h: 900 },
  { w: 2560, h: 1000 },
];

function report(vp, box, lb) {
  const barX = (box.w - lb.fieldW) / 2;
  const barY = (box.h - lb.fieldH) / 2;
  return `${vp.w}x${vp.h}: stage ${box.w.toFixed(1)} x ${box.h.toFixed(1)} `
    + `(${(box.w / box.h).toFixed(4)}:1), field ${lb.fieldW.toFixed(1)} x ${lb.fieldH.toFixed(1)} `
    + `at ppu ${lb.ppu.toFixed(3)}, dead bar ${barX.toFixed(1)}px per side horizontally `
    + `(${((barX / box.w) * 100).toFixed(2)}% of stage width) and ${barY.toFixed(1)}px `
    + `per side vertically`;
}

// ---------------------------------------------------------------------------

describe('the rite stage is the field', () => {
  it('the painted field fills the stage on every viewport', () => {
    const failures = [];
    for (const vp of VIEWPORTS) {
      const box = stageBox(vp.w, vp.h);
      const lb = letterbox(box);
      // Sub-pixel, not "close enough": the whole point is that a 1px border
      // eating the ratio is the same defect as an 88px bar, and a percentage
      // tolerance would wave the small one through until someone widened it.
      if (Math.abs(box.w - lb.fieldW) > 0.5 || Math.abs(box.h - lb.fieldH) > 0.5) {
        failures.push(report(vp, box, lb));
      }
    }
    expect(failures, `Painter.layout letterboxes contract.js FIELD (${FIELD.w}x${FIELD.h}) `
      + `into the stage, so any stage that is not ${FIELD.w}:${FIELD.h} is surface no rite `
      + `can paint into. Dead bars found:\n  ` + failures.join('\n  ')).toEqual([]);
  });

  it('the stage box is 16:9 to within a rounding error, everywhere', () => {
    const want = FIELD.w / FIELD.h;
    for (const vp of VIEWPORTS) {
      const box = stageBox(vp.w, vp.h);
      const got = box.w / box.h;
      expect(
        Math.abs(got - want),
        `${vp.w}x${vp.h}: stage is ${box.w.toFixed(1)} x ${box.h.toFixed(1)} = `
        + `${got.toFixed(4)}:1, wanted ${want.toFixed(4)}:1`,
      ).toBeLessThan(1e-3);
    }
  });

  it('the stage never overflows the shell or the height budget', () => {
    for (const vp of VIEWPORTS) {
      const box = stageBox(vp.w, vp.h);
      const border = parseFloat(declared('.rite-stage', 'border', vp.w));
      const contentBox = declared('.rite-stage', 'box-sizing', vp.w) === 'content-box';
      const outerW = box.w + (contentBox ? 2 * border : 0);
      const outerH = box.h + (contentBox ? 2 * border : 0);
      expect(outerW, `${vp.w}x${vp.h}: stage ${outerW.toFixed(1)}px wide overflows the `
        + `shell's ${box.inner.toFixed(1)}px content box`).toBeLessThanOrEqual(box.inner + 0.5);
      expect(outerH, `${vp.w}x${vp.h}: stage ${outerH.toFixed(1)}px tall exceeds its `
        + `${box.budget.toFixed(1)}px height budget`).toBeLessThanOrEqual(box.budget + 0.5);
    }
  });

  it('the shell hugs the stage — no empty glass beside it', () => {
    // The consequence of fixing the bars, if nothing else moves: the stage is
    // now sized by the HEIGHT budget on short windows, so a shell sized only by
    // `1120px / 92vw` becomes a panel much wider than its content — measured at
    // 1600x700, a 695px stage inside a 1070px panel. That is the same lie one
    // level out. The shell's width therefore carries the same derived term.
    //
    // This assertion is also what keeps the `+ 52px` in the shell's width
    // honest: it is the sum of that element's own padding and borders, CSS
    // cannot refer to them, so the arithmetic is checked here instead.
    for (const vp of VIEWPORTS) {
      const box = stageBox(vp.w, vp.h);
      const border = parseFloat(declared('.rite-stage', 'border', vp.w));
      const outerW = box.w + 2 * border;
      const slack = box.inner - outerW;
      expect(slack, `${vp.w}x${vp.h}: ${slack.toFixed(1)}px of empty shell either side of `
        + `a ${outerW.toFixed(1)}px stage in a ${box.inner.toFixed(1)}px panel — the shell's `
        + `width must derive from --rite-stage-h the way the stage's does`)
        .toBeLessThan(1);
      expect(slack, `${vp.w}x${vp.h}: the stage overflows the shell by `
        + `${(-slack).toFixed(1)}px`).toBeGreaterThan(-0.5);
    }
  });

  it('the height budget is one number, and the width cap is derived from it', () => {
    // THE REGRESSION SHAPE, NOT JUST THE REGRESSION. The shipped bug was two
    // independent constraints (`width: 100%`, `max-height: 56vh`) that were
    // free to disagree. The fix is structural: there is ONE budget and the
    // width is computed from it. If someone re-introduces a literal width or a
    // literal max-height, they have re-introduced the ability to disagree even
    // if today's numbers happen to line up.
    const width = require_(declared('.rite-stage', 'width', 1600), '.rite-stage width');
    const maxH = declared('.rite-stage', 'max-height', 1600);
    expect(width, 'the stage width must be capped by the height budget, not stated '
      + 'independently of it').toMatch(/var\(--rite-stage-h\)/);
    expect(maxH, 'max-height must reference the same budget the width is derived from')
      .toMatch(/var\(--rite-stage-h\)/);

    // And the narrow-window override must move the BUDGET, not max-height.
    // `.rite-stage` must have no media-query override at all now: everything it
    // needs recomputes from `#rite --rite-stage-h`.
    const narrow = RULES.filter((r) => r.selector === '.rite-stage' && r.media);
    for (const r of narrow) {
      expect(Object.keys(r.decls), `the ${r.media} override of .rite-stage must set `
        + `--rite-stage-h only; setting width or max-height there re-creates the defect`)
        .toEqual(['--rite-stage-h']);
    }
    const budgetOverride = RULES.find((r) => r.selector === '#rite' && r.media
      && r.decls['--rite-stage-h'] !== undefined);
    expect(budgetOverride, 'expected the narrow-window block to move --rite-stage-h on #rite, '
      + 'so that the stage AND the shell around it both follow').toBeTruthy();
  });

  it('the 1px hairline does not eat the ratio', () => {
    // `aspect-ratio` shapes whichever box `box-sizing` selects. Under the
    // global border-box reset that is the BORDER box, so the canvas inside
    // comes out (16:9 minus 2px) by (16:9 minus 2px) — not 16:9. Sub-pixel,
    // silent, and the same bug.
    expect(
      declared('.rite-stage', 'box-sizing', 1600),
      'the stage must be content-box so that aspect-ratio shapes the CONTENT '
      + 'area, which is exactly the canvas',
    ).toBe('content-box');
  });
});

describe('the panel frame does not depend on input modality', () => {
  // ui.css:88 — `#ui-root :focus-visible { outline: 2px solid var(--gold) }` —
  // matched `.rite-shell`, which carries tabindex="-1" and is focused on open.
  // The brightest element in the whole overlay was therefore a browser focus
  // ring that appeared on a keyboard-opened rite and vanished on a clicked one.
  const shellRules = RULES.filter((r) => r.selector.includes('.rite-shell'));

  it('the shell declines the global focus ring at a specificity that wins', () => {
    const off = shellRules.find((r) =>
      r.selector.includes(':focus-visible') && r.decls.outline === 'none');
    expect(off, 'expected a rule cancelling the focus ring on .rite-shell').toBeTruthy();
    // `#ui-root :focus-visible` is (1 id, 1 class-ish) = 1-1-0. A bare
    // `.rite-shell { outline: none }` is 0-1-0 and loses, which is exactly how
    // the ring shipped. The override must carry an id of its own.
    expect(off.selector, 'a bare `.rite-shell { outline: none }` is 0-1-0 and loses to '
      + '`#ui-root :focus-visible` (1-1-0) — the override needs an id selector')
      .toMatch(/#rite\b/);
  });

  it('the frame itself is unconditional', () => {
    const base = shellRules.find((r) => r.selector === '.rite-shell');
    expect(base?.['decls']?.['box-shadow'], 'the panel must carry its own frame in a '
      + 'property no focus rule fights over').toBeTruthy();
    expect(base.decls['box-shadow'], 'the frame must be visible without :focus-visible — '
      + 'a gold-tinted ring drawn as a shadow, not as an outline')
      .toMatch(/229,\s*189,\s*121/);
  });

  it('Skip and Continue keep a focus ring', () => {
    // Both used to declare `:focus-visible { outline: 1px solid var(--gold) }`
    // at 0-2-0, which LOST to ui.css's 1-1-0 and so described a picture that
    // was never on screen. They now inherit the game-wide treatment, and what
    // must never appear is a rule cancelling it.
    //
    // CONTINUE IS THE ONE THAT MATTERS. MinigameHost swallows Tab while a rite
    // plays, so nothing in the overlay is tab-reachable during play and Esc is
    // the keyboard route to Skip; but the host focuses Continue explicitly when
    // the result card opens, and that focus must be visible. Verified live:
    // `getComputedStyle(document.activeElement).outline` on the open result card
    // reads `solid 2px rgb(229, 189, 121)`, while the shell reads `none`.
    for (const sel of ['.rite-skip', '.rr-go']) {
      const killed = RULES.some((r) =>
        r.selector.includes(sel) && r.selector.includes(':focus')
        && (r.decls.outline === 'none' || r.decls.outline === '0'));
      expect(killed, `${sel} is a tab stop inside the rite overlay and must keep a `
        + `visible focus ring — nothing may cancel it`).toBe(false);
    }
  });
});
