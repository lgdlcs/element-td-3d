/**
 * THE MINIGAME CONTRACT — the one file every rite and the host agree on.
 *
 * Read docs/MINIGAMES.md before writing a rite. This file is the machine-
 * readable half of that document: the coordinate space, the input record, the
 * reward formula, and the typedefs. It imports nothing but Config, touches no
 * DOM and no three.js, so `tests/unit` can import it directly.
 *
 * THE ONE RULE THAT MAKES ALL THE OTHERS POSSIBLE: a rite's logic never sees a
 * pixel. It works in a fixed 16x9 world rectangle (FIELD), and the host maps
 * that rectangle onto whatever canvas the player happens to have. A rite written
 * in pixels is a rite whose difficulty changes when the window is resized, which
 * means a test at 1600x900 proves nothing about anybody else's screen and two
 * players in the same room are not playing the same game. There is no runtime
 * check for this — there cannot be — so it is stated here and enforced by the
 * fact that the host never hands a rite a pixel value to work with.
 */

import { MINIGAMES } from '../core/Config.js';

/**
 * The play field, in world units. 16x9 because the overlay is letterboxed to
 * that ratio on every screen, so a rite that uses the full rectangle is never
 * cropped and never has dead margin. Origin is the CENTRE — x in [-8, 8], y in
 * [-4.5, 4.5] — because almost everything a rite draws is arranged around a
 * middle, and centre-origin removes an offset from every single expression.
 */
export const FIELD = Object.freeze({
  w: 16,
  h: 9,
  get hw() { return this.w / 2; },
  get hh() { return this.h / 2; },
});

/**
 * A neutral input record.
 *
 * DELIBERATELY A PLAIN OBJECT OF PRIMITIVES, not an event, not a Set, not a live
 * reference to host state. A test must be able to write the exact input sequence
 * by hand — `{...NEUTRAL_INPUT, action: 1}` — and get bit-identical results to a
 * real player who clicked at that moment. Anything with identity (a Set, a
 * DOM event) makes that awkward and makes replay logs impossible.
 *
 *  x, y     pointer position in FIELD world units. Meaningless when `inside` is
 *           false, and left at the last known position rather than reset, so a
 *           rite that reads it anyway gets a stale value rather than a jump to
 *           the origin.
 *  inside   the pointer is over the field this step.
 *  down     the primary pointer is held down at the END of this step.
 *  action   how many COMMIT events (mouse-down inside the field, Space, or
 *           Enter) landed during this step. An integer, not a boolean, because
 *           the host runs a fixed step and a fast player can commit twice inside
 *           one 16.6 ms slice; collapsing that to a boolean silently eats an
 *           input, and eating an input in a reaction game is the worst possible
 *           bug to have.
 *  axis     held direction, each component in {-1, 0, 1}, from the arrow keys or
 *           WASD/ZQSD. y is POSITIVE UP, matching the field, not the DOM.
 *  slots    SLOT_COUNT counters, one per discrete choice, each holding how many
 *           presses of that choice landed during this step. See SLOT_COUNT.
 *  clicks   PointerClick[], in the order they arrived, for THIS STEP ONLY. Read
 *           the two sharp edges below before you touch it.
 *  altAction how many SECONDARY commits (right button) landed this step. The
 *           mirror of `action`, and deliberately a second counter rather than a
 *           flag inside `action`: a rite that only has one verb reads `action`
 *           and is untouched by the existence of a second button.
 *
 * TWO SHARP EDGES ON `clicks`, BOTH OF WHICH WILL BITE SILENTLY.
 *
 *  1. THE QUEUE BELONGS TO THE FIRST SUB-STEP OF A FRAME. The host runs a fixed
 *     step and a slow frame runs several of them; the clicks that arrived since
 *     the last frame are handed to sub-step 1 and sub-steps 2..n see an EMPTY
 *     array. Same rule as `action`, for the same reason: handing the same three
 *     clicks to three sub-steps turns one shot into three. A rite must therefore
 *     never assume it sees a click every step, and must never accumulate across
 *     sub-steps by reading `clicks.length` outside the step it was given.
 *
 *  2. THE RECORDS ARE POOLED AND REUSED. The host pre-allocates
 *     MINIGAMES.maxClicksPerStep of them and refills the same objects on the next
 *     pointerdown — that is what keeps a reaction game at zero allocation per
 *     frame. A rite that stores a PointerClick and reads it two steps later is
 *     reading recycled memory: the x/y it finds belong to a shot the player took
 *     afterwards. COPY WHAT YOU KEEP (`{ x: c.x, y: c.y }`), never the record.
 *     This is the `Painter.ppu` of the input side: an edge with no runtime check
 *     and a failure mode that looks like a physics bug, so it is named here.
 *
 * Beyond the cap the host DROPS clicks silently rather than growing the queue.
 * Twelve primary commits inside one frame is a macro or a stuck button, not a
 * player, and an unbounded queue is an unbounded frame.
 */

/**
 * @typedef {object} PointerClick
 * @property {number} x  FIELD units, captured AT THE MOMENT OF THE PRESS.
 *   Not `input.x` at the end of the step: a pointerdown at A followed by a
 *   pointermove to B before the next fixed step used to resolve the shot at B,
 *   i.e. credited it to whatever the player happened to be over a frame later.
 * @property {number} y  FIELD units, same capture.
 * @property {number} button  0 = primary, 2 = secondary. Nothing else is queued.
 * @property {'pointer'|'key'} source  A keyboard commit (Space/Enter) enqueues a
 *   click at the last known pointer position, so a shooting rite is playable
 *   without a mouse button and a trackpad user is not handicapped by the
 *   two-finger settle delay. A rite that wants to treat the two differently can;
 *   most should not.
 */

/**
 * How many DISCRETE CHOICES a rite may offer at once, and why the number is six.
 *
 * `axis` covers continuous verbs and `action` covers "now", but neither can say
 * WHICH OF SEVERAL a player picked. A rite built on choosing — the wheel of
 * counters has six elements, so six answers — has to express that, and the two
 * cheap ways of expressing it are both wrong: an axis plus a commit turns one
 * decision into two keystrokes and destroys the reaction-time ceiling the game
 * is about, and reading raw key codes inside a rite would put the DOM in a file
 * the unit suite runs in node.
 *
 * So the host translates Digit1..Digit6 (and Numpad1..6) into six COUNTERS, in
 * the same shape and for the same reason as `action`: a count, not a boolean,
 * because two presses can land inside one 16.6 ms slice and eating an input in a
 * reaction game is the worst bug available. A rite that does not care about
 * discrete choices never reads the field and nothing changes for it.
 *
 * SIX because six is the number of elements (Elements.ELEMENT_IDS), which is the
 * only fixed-arity choice this game has. `e.code` is used rather than `e.key`,
 * so Digit1..Digit6 are the same six physical keys on QWERTY and on AZERTY,
 * where the unshifted glyphs are `&é"'(-`.
 */
export const SLOT_COUNT = 6;

export const NEUTRAL_INPUT = Object.freeze({
  x: 0, y: 0, inside: false, down: false, action: 0, altAction: 0,
  axis: Object.freeze({ x: 0, y: 0 }),
  slots: Object.freeze(new Array(SLOT_COUNT).fill(0)),
  clicks: Object.freeze([]),
});

/** A mutable input record seeded with the neutral values. For the host and tests. */
export function makeInput(over = {}) {
  return {
    ...NEUTRAL_INPUT,
    axis: { ...NEUTRAL_INPUT.axis },
    slots: [...NEUTRAL_INPUT.slots],
    // A FRESH ARRAY PER CALL, like `slots` and for the same reason: a test that
    // pushes onto one record's queue must not be writing into every other
    // record ever made, including the frozen neutral one.
    clicks: [...NEUTRAL_INPUT.clicks],
    ...over,
  };
}

/** One pooled-shaped click, for tests and for anything scripting a shot. */
export function clickAt(x, y, button = 0, source = 'pointer') {
  return { x, y, button, source };
}

/** A one-hot slots array, for tests and for anything that presses exactly one. */
export function slotsWith(index, count = 1) {
  const s = new Array(SLOT_COUNT).fill(0);
  if (index >= 0 && index < SLOT_COUNT) s[index] = count;
  return s;
}

/**
 * @typedef {object} MinigameCtx  Everything a rite is allowed to know.
 * @property {() => number} rand  Seeded generator from rngFor(seed, 'minigame:<id>', occurrence).
 *   THE ONLY source of randomness a rite may use. See the determinism contract
 *   in docs/MINIGAMES.md: a fixed number of calls, always, never inside a branch.
 * @property {number} wave        The wave about to be prepared. For flavour and
 *   for difficulty curves — NOT for the reward, which the host computes.
 * @property {number} occurrence  How many rites have come before this one in the
 *   run; 0 for the first. `riteOccurrence(wave)` in schedule.js, and the same
 *   number that indexes `rand` — so two appearances of one rite already get two
 *   layouts without anybody reading this.
 *
 *   FOR STRUCTURAL VARIATION ONLY. NEVER FOR DIFFICULTY.
 *
 *   Five of the six rites appear twice in a run, and without this a rite's
 *   second appearance is the same world with different coordinates: the same
 *   count of the same things arranged by the same rule. `occurrence` is how a
 *   rite says "the second time, the belt runs the other way" or "the second
 *   time, the gates are diagonal" — a different SHAPE, at the same difficulty.
 *
 *   Difficulty is `wave`'s job and only `wave`'s job, and the two are not
 *   interchangeable even though they rise together. `tests/unit/calibration.test.js`
 *   states one target curve as a function of `wave` and holds all six rites to
 *   it; a rite that also stiffened on `occurrence` would score two different
 *   things at the same wave depending on how the run happened to be laid out,
 *   which makes that curve unmeasurable — for every rite, not only for the one
 *   that cheated. Two players on one seed see the same occurrence, so this is
 *   determinism-safe; it is the calibration that it breaks, silently.
 *
 *   A rite that ignores it is entirely correct and nothing changes for it.
 * @property {number} width       FIELD.w. Always 16. Passed so a rite reads its
 *   own bounds from ctx rather than importing a constant it might not honour.
 * @property {number} height      FIELD.h. Always 9.
 * @property {string} quality     Render preset id ('low'|'medium'|'high'|'ultra').
 *   Advisory: use it to thin particle counts, never to change gameplay.
 */

/**
 * @typedef {object} MinigameScore
 * @property {number} ratio     0..1 performance. THE ONLY value the reward reads.
 * @property {string} headline  Short verdict for the result card ("Flawless").
 * @property {string} detail    One line of evidence ("6 strikes - 4 perfect").
 */

/**
 * @typedef {object} MinigameInstance
 * @property {(ctx: MinigameCtx) => void} init
 * @property {(dt: number, input: object) => (boolean|void)} update
 *   Called at a FIXED dt (MINIGAMES.dt). Return true to end the rite early.
 * @property {(g: import('./Painter.js').Painter, alpha: number) => void} draw
 *   Called once per rendered frame at a variable rate. MUST NOT mutate state.
 *   `alpha` is the interpolation fraction into the next step, in [0,1).
 * @property {() => MinigameScore} score  Pure. Safe to call at any time.
 * @property {() => void} [teardown]
 * @property {() => Array<{type: string, x?: number, y?: number}>} [drainEvents]
 *   Optional. Returns and CLEARS a queue of presentation cues (hit, miss, ...).
 *   The host turns them into sound and camera shake. Never read by score().
 */

/**
 * @typedef {object} MinigameDef
 * @property {string} id        Stable. Feeds the RNG label — changing it rerolls the world.
 * @property {string} name      Display title.
 * @property {string} hint      One line, present-tense imperative. The 2-second read.
 * @property {number} duration  Seconds on the clock.
 * @property {() => MinigameInstance} create
 * @property {string} [theme]   Value for `#rite[data-rite="..."]`, which selects
 *   the stage gradient, the veil and the accent in ui/minigames.css. Defaults to
 *   `id`. Separate from `id` because `id` is part of the SEED contract — renaming
 *   it rerolls every existing run — while a theme is only paint, and two rites
 *   are allowed to share one.
 * @property {string} [eyebrow] Overline above the title. Defaults to 'Interlude'.
 *   The host appends ' · before wave N'.
 * @property {string} [abandonNote] Result-card detail when the player walks away.
 *   Defaults to 'You walked away'. It exists because the literal used to be
 *   'You stepped away from the anvil', which is true of exactly one rite.
 * @property {string} [cursor]  CSS cursor for the stage. Defaults to the
 *   stylesheet's crosshair. A rite that is steered rather than aimed should say
 *   so — a crosshair over a car is a promise the controls do not keep.
 */

/**
 * The payout for a rite, in gold.
 *
 * Owned by the contract and not by the rite, so every rite is worth the same at
 * the same level of play and a new one cannot accidentally be three times more
 * lucrative than the others.
 *
 * ONE CURVE, NO GATE, NO FLOOR:
 *
 *     reward = round(perfect * ratio ** payCurve),
 *     perfect = max(minPerfect, nextGross * perfectFrac)
 *
 * The previous shape was a floor plus a threshold, and the two of them together
 * built a cliff: at wave 53 a ratio of 0.119 paid 0 and 0.121 paid 262. Nothing
 * on screen marked that edge, so the difference between "nearly nothing" and "a
 * fifth of a wave" was two thousandths of a score the player cannot see. The
 * exponent replaces both constants: it is steep enough near zero that a player
 * who did not play is paid a rounding error, and it never jumps.
 *
 * The property that actually matters: SKIPPING PAYS 0 (MinigameHost.#settle
 * short-circuits) and a ratio of 0 pays 0. Those two used to agree only because
 * `payThreshold` had been tuned to sit above every measured do-nothing score —
 * a constant that had to be re-measured every time a rite was added. They now
 * agree BY CONSTRUCTION, for any rite anyone ever writes.
 *
 * See the MINIGAMES docblock in Config.js for the measured whole-run totals.
 *
 * @param {number} ratio      0..1, from MinigameInstance.score()
 * @param {number} nextGross  count x bounty of the wave about to be prepared
 * @returns {number} whole gold
 */
export function minigameReward(ratio, nextGross) {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  const perfect = Math.max(MINIGAMES.minPerfect, (Number(nextGross) || 0) * MINIGAMES.perfectFrac);
  return Math.round(perfect * Math.pow(r, MINIGAMES.payCurve));
}

/**
 * A rough width for `str` at cap height `size`, in WORLD units.
 *
 * The Painter's default face is monospace (`ui-monospace, ..., Menlo`), so an
 * advance of 0.6 em is within a few percent on every platform the game runs on.
 * That is enough to size a plate behind a label or to decide a line break, and
 * it keeps `ctx.measureText` — the one measurement in this pipeline that needs a
 * live canvas — out of rite logic the unit suite runs in node. A rite that
 * measures for real is a rite that cannot be tested without a DOM.
 *
 * If you pass `font` to `text()` and it is not monospace, this is a guess.
 */
export function approxTextWidth(str, size) {
  return 0.6 * size * String(str).length;
}

/** Linear interpolation, because every rite wants it and none should redefine it. */
export function lerp(a, b, t) { return a + (b - a) * t; }

/** Clamp — same reasoning. */
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * A triangle wave in [0,1] from a phase in [0, inf).
 *
 * The needle motion primitive: `tri(p)` sweeps 0 -> 1 -> 0 over two units of
 * phase. Written with a modulo on the phase rather than by flipping a stored
 * direction flag, because a stored flag accumulates a different rounding error
 * per client over a few hundred steps and that is a desync you find in week
 * three. This is a pure function of the accumulated phase and cannot drift.
 */
export function tri(phase) {
  const u = phase - Math.floor(phase / 2) * 2;    // [0,2)
  return u < 1 ? u : 2 - u;
}
