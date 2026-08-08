// @vitest-environment jsdom
/**
 * THE THEME TOKENS ACTUALLY REACH THE CANVAS.
 *
 * Wave 0 put each rite's palette in `src/ui/minigames.css` as
 * `#rite[data-rite="x"] { --rite-accent: … }`. A rite has NO DOM by design — it
 * is handed a Painter and nothing else — so every rite read its colours with the
 * `Lottery.js#readPalette` pattern, off `document.documentElement`. Those
 * properties are scoped to the `#rite` element, so every one of those lookups
 * missed and the literal fallback in the JS is what actually painted. Four of
 * the six rite authors reported it independently and none of them owned the
 * shared files needed to fix it.
 *
 * The fix is prefixed tokens on `:root` (`--rite-hunt-accent`, …) with the
 * `[data-rite]` blocks aliasing them into the generic names for the CHROME. This
 * file is the part that makes it stay fixed. Two levels of claim:
 *
 *   1. SYNTHETIC — set a property on the root, init the rite, see it come out of
 *      the palette. That is the instrument.
 *   2. REAL — load the SHIPPED stylesheet into the document, init the rite, and
 *      assert the value the canvas would paint with is the value written in
 *      minigames.css. A synthetic test alone would still pass if the rite read a
 *      token nobody ever declared.
 *
 * PROVE THE INSTRUMENT CAN FAIL (docs/TESTING.md §4). Every assertion here was
 * watched go red by reverting one rite at a time to `tok('--rite-accent', …)`:
 * the synthetic case fails because nothing declares the generic name at the
 * root, and the shipped-stylesheet case fails because `--rite-accent` resolves
 * on `#rite` and never on `:root`. Deleting a `:root` declaration from the
 * stylesheet fails the shipped case alone, which is the drift this is for.
 *
 * jsdom, not node: this is the one rite-adjacent thing that cannot be asserted
 * without a `getComputedStyle`, and asserting it against a fake would be
 * asserting that the fake works.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIELD } from '../../src/minigames/contract.js';
import { riteRng } from '../../src/minigames/schedule.js';
import { HEAVEN_RITE } from '../../src/minigames/rites/HeavenRite.js';
import { PLATFORMS_RITE } from '../../src/minigames/rites/PlatformsRite.js';
import { OFFROAD_RITE } from '../../src/minigames/rites/OffroadRite.js';
import { HUNT_RITE } from '../../src/minigames/rites/HuntRite.js';
import { FISHING_RITE } from '../../src/minigames/rites/FishingRite.js';

/**
 * Paths are resolved from the project root, not from `import.meta.url`: this
 * file runs under the jsdom environment, where `import.meta.url` is an `http:`
 * URL that `readFileSync` refuses. Vitest's cwd is the project root.
 */
const src = (rel) => readFileSync(resolve(process.cwd(), rel), 'utf8');
const CSS = src('src/ui/minigames.css');

/** Build a rite instance in whatever the document currently says the theme is. */
function spawn(def, { wave = 8, seed = 5 } = {}) {
  const inst = def.create();
  inst.init({
    rand: riteRng(seed, def.id, 0),
    wave, width: FIELD.w, height: FIELD.h, quality: 'high',
  });
  return inst;
}

/** `#rrggbb` -> `'r,g,b'`, matching what the rites hand to Painter.halo. */
function chan(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/**
 * The value the SHIPPED stylesheet declares for a token inside its `:root` block.
 *
 * Read out of the file rather than out of `getComputedStyle`, so the two sides
 * of the "real" assertion come from two different readers — otherwise a jsdom
 * quirk that dropped the declaration would make both sides agree on nothing.
 */
function declared(name) {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(CSS);
  expect(root, 'minigames.css must declare a :root block').toBeTruthy();
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(root[1]);
  expect(m, `${name} must be declared on :root in minigames.css`).toBeTruthy();
  return m[1].trim();
}

/**
 * Every token a rite reads, with the palette field it must land in.
 *
 * Deliberately a data table rather than five near-identical tests: the point is
 * that all six rites obey ONE rule, and a table makes a rite that quietly opts
 * out show up as a missing row rather than as a test nobody wrote.
 */
const CASES = [
  {
    def: HEAVEN_RITE,
    token: '--rite-heaven-accent',
    probe: '#123456',
    read: (i) => i._palette.accent,
  },
  {
    def: PLATFORMS_RITE,
    token: '--rite-platforms-accent',
    probe: '#234567',
    read: (i) => i.palette.accent,
  },
  {
    def: OFFROAD_RITE,
    token: '--rite-offroad-accent',
    probe: '#345678',
    read: (i) => i._pal.c.accent,
  },
  {
    def: HUNT_RITE,
    token: '--rite-hunt-accent',
    probe: '#456789',
    read: (i) => i.forest.rim,
  },
  {
    def: HUNT_RITE,
    token: '--rite-hunt-canopy-far',
    probe: '#0a0b0c',
    read: (i) => i.forest.canopyFar,
  },
  {
    def: HUNT_RITE,
    token: '--rite-hunt-floor',
    probe: '#0d0e0f',
    read: (i) => i.forest.floor,
  },
  {
    def: FISHING_RITE,
    token: '--rite-fishing-accent',
    probe: '#56789a',
    read: (i) => i.pal.rAccent,
    map: chan,
  },
  {
    def: FISHING_RITE,
    token: '--rite-fishing-deep',
    probe: '#010203',
    read: (i) => i.pal.rDeep,
    map: chan,
  },
  {
    def: FISHING_RITE,
    token: '--rite-fishing-shelf',
    probe: '#040506',
    read: (i) => i.pal.rShelf,
    map: chan,
  },
];

// ===========================================================================
describe('per-rite theme tokens resolve on :root', () => {
  afterEach(() => { document.documentElement.removeAttribute('style'); });

  for (const c of CASES) {
    it(`${c.def.id}: ${c.token} reaches the canvas`, () => {
      document.documentElement.style.setProperty(c.token, c.probe);
      const got = c.read(spawn(c.def));
      expect(got).toBe(c.map ? c.map(c.probe) : c.probe);
    });
  }

  it('a rite reads NOTHING off the generic --rite-accent', () => {
    // The exact shape of the original bug, kept as a standing assertion: the
    // generic name is chrome-only and lives on `#rite`. If a future rite reads
    // it off the root it will resolve to `--ink-3` — a UI grey — and paint the
    // stage in it. Poisoning the name at the root must move nothing.
    document.documentElement.style.setProperty('--rite-accent', '#ff00ff');
    expect(spawn(HEAVEN_RITE)._palette.accent).not.toBe('#ff00ff');
    expect(spawn(PLATFORMS_RITE).palette.accent).not.toBe('#ff00ff');
    expect(spawn(OFFROAD_RITE)._pal.c.accent).not.toBe('#ff00ff');
    expect(spawn(HUNT_RITE).forest.rim).not.toBe('#ff00ff');
    expect(spawn(FISHING_RITE).pal.rAccent).not.toBe(chan('#ff00ff'));
  });
});

// ===========================================================================
describe('the shipped stylesheet is what paints', () => {
  let $style;

  beforeEach(() => {
    $style = document.createElement('style');
    $style.textContent = CSS;
    document.head.appendChild($style);
  });
  afterEach(() => { $style.remove(); });

  for (const c of CASES) {
    it(`${c.def.id}: ${c.token} matches minigames.css`, () => {
      const want = declared(c.token);
      const got = c.read(spawn(c.def));
      expect(got).toBe(c.map ? c.map(want) : want);
    });
  }

  it('every [data-rite] accent is an alias, not a second copy of the colour', () => {
    // The rule that keeps the chrome and the canvas one palette. A theme block
    // that writes a literal `--rite-accent: #86c294` is the drift this whole
    // change is about: it would look identical until someone retuned :root.
    const blocks = CSS.match(/#rite\[data-rite="[a-z]+"\]\s*\{[\s\S]*?\n\}/g) ?? [];
    expect(blocks.length).toBe(6);
    for (const b of blocks) {
      const id = /data-rite="([a-z]+)"/.exec(b)[1];
      expect(b, `${id} theme block`).toContain(`--rite-accent: var(--rite-${id}-accent);`);
    }
  });
});

// ===========================================================================
/**
 * THE TWO DOCUMENTED EXCEPTIONS, PINNED AS EXCEPTIONS.
 *
 * Both are values whose authors argued they must NOT be themeable, and both
 * arguments survive the hoist. Asserted here so that "everything comes from a
 * token" never gets applied to them by a later sweep — and so that the reasons
 * are one grep away from the code that depends on them.
 */
describe('the values that deliberately stay literal', () => {
  afterEach(() => { document.documentElement.removeAttribute('style'); });

  it("heaven's kill pink is not a token the stylesheet can move", () => {
    // The rite's accessibility claim is "pink is the only saturated magenta on
    // the stage", and the hue IS the rule — a value another theme block could
    // redefine is a claim nothing enforces. So `--rite-pink` is read (a designer
    // may promote it deliberately) but the stylesheet must not declare it.
    expect(CSS).not.toContain('--rite-pink');
    const inst = spawn(HEAVEN_RITE);
    expect(inst._palette.pink).toBe('#ff4fd8');
    expect(inst._palette.pinkDeep).toBe('#b81590');
    // And moving the ACCENT must not move the hazard: they are different kinds
    // of colour, one paint and one rule.
    document.documentElement.style.setProperty('--rite-heaven-accent', '#ff4fd8');
    expect(spawn(HEAVEN_RITE)._palette.pink).toBe('#ff4fd8');
    expect(spawn(HEAVEN_RITE)._palette.accent).toBe('#ff4fd8');
  });

  it("luckyshot's booth ink has no token because a gradient stop is not one", () => {
    // The stage backdrop is `--rite-stage-bg`, a multi-stop gradient on `#rite`.
    // A canvas cannot resolve a gradient, so the dark end of it is tracked by
    // hand in the rite. Named rather than scattered, which is what keeps it one
    // exception instead of four literals.
    const js = src('src/minigames/rites/LuckyShotRite.js');
    expect(js).toContain("const BOOTH_INK = '#0b0806';");
    expect(CSS).toContain('#0a0806');   // the gradient stop it tracks, still there
  });
});
