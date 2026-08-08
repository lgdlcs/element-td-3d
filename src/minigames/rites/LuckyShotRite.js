/**
 * LUCKY SHOT — the carnival shooting gallery, and THE REFERENCE RITE.
 *
 * If you are writing a new rite, read this one first. It was chosen as the
 * example on purpose: it exercises the click queue (the one piece of the input
 * contract with a sharp edge), it does NOT use `rivals.js` (so nothing here is
 * about competition), its randomness budget is a single flat list of draws in
 * `init`, and it ends early by returning `true`. Everything a new author needs
 * and nothing else.
 *
 * THE GAME. You do not move. Three rows of creep cut-outs track across the
 * booth at different speeds and depths — the back rows are smaller, faster and
 * worth more. Aim with the pointer, fire with LEFT, RIGHT or SPACE (all three
 * are the same verb; see below). One target in the eighteen is GOLDEN and worth
 * triple, and one is a BYSTANDER worth minus one.
 *
 * THE AMMO LIMIT IS THE DESIGN. Twenty-four rounds, spent on a hit AND on a
 * miss, and running out ends the rite there and then. Without it the optimal
 * play is to spray the field at 60 clicks per second, which is not a game — it
 * is a benchmark of the player's mouse. Do not soften it, do not refund a miss,
 * do not top it up on a streak. Every other number in this file is tuning; this
 * one is the rite.
 *
 * WHY ALL THREE BUTTONS FIRE. The original Warcraft III map used right-click,
 * and right-click is supported for that reason — but it is never REQUIRED. On a
 * macOS trackpad a secondary click is a two-finger press with a settling delay,
 * and in a game measured in tens of milliseconds that is a handicap applied to
 * one platform. The host already enqueues a PointerClick for a right button, a
 * left button and a Space/Enter commit alike, so this rite reads `input.clicks`
 * and nothing else — it never looks at `button`, and it deliberately never
 * reads `action` or `altAction`, which would double-count every shot.
 *
 * WHY IT READS `clicks` AND NOT `input.x/y`. This is the rite the click queue
 * was built for. `input.x/y` is where the pointer IS at the end of the step;
 * `clicks[k].x/y` is where it WAS when the button went down. Two targets, two
 * clicks inside one 16.6 ms slice, at two different positions, must resolve as
 * two distinct hits — resolving against `input.x/y` credits both to whatever
 * the player happened to be over a frame later. There is a unit test for
 * exactly that in tests/unit/luckyshot-rite.test.js.
 *
 * NO DOM (beyond one `getComputedStyle` in `init`, guarded), NO THREE, NO
 * Math.random — the unit suite imports this in node.
 */

import { clamp, approxTextWidth } from '../contract.js';
import { mulberry32 } from '../../core/Rng.js';
import { MINIGAMES } from '../../core/Config.js';

// ---------------------------------------------------------------------------
// The tuning table. Every number a player can feel lives up here.
// ---------------------------------------------------------------------------

/** Seconds on the clock, matching `duration` on the def below. */
const DURATION = 20;

/** THE ANTI-MASH RULE. Rounds, spent on a hit and on a miss alike. */
const AMMO = 24;

/** Targets per row. Six, as the fiction promises: 3 rows x 6. */
const PER_ROW = 6;

/**
 * The width of the belt the targets ride, in world units.
 *
 * Wider than the field's 16 on purpose: the two spare units on each side are
 * where a target enters from and exits to, so a row reads as a conveyor passing
 * through a booth rather than as six objects teleporting at the frame edge. It
 * also puts the wrap seam (+/-10) safely off-canvas, where nobody can click it.
 */
const TRACK = 20;

/**
 * The rows, FRONT FIRST. That order is load-bearing twice over: `targets` is
 * built in this order, so iterating it is iterating front-to-back, which is
 * what makes "the frontmost target wins an overlap" a two-line hit test rather
 * than a sort.
 *
 * Depth is encoded three ways at once — height on screen, SIZE, and speed —
 * because colour must never be the only channel (docs/MINIGAMES.md §12). The
 * value of a row is legible from its size before a player has read a number.
 *
 * THE FRONT TWO ROWS JUST OVERLAP, and the numbers were chosen for it: the gap
 * between them (1.35) is a shade under the sum of their radii (1.50), so the
 * front rank kisses the one behind and a point can sit inside both. That is the
 * gallery look — ranks nearly touching, not merged — and it is what makes "the
 * frontmost target wins" a rule with teeth rather than a comment about a case
 * that never happens. The back row is clear of the middle by a third of a unit,
 * because three rows that all overlapped read as one clump rather than as three
 * depths; that was measured on a screenshot, not guessed.
 *
 * THE 0.15 OF VERTICAL OVERLAP IS NOT WHAT WAS PILING THE FRONT TWO ROWS, AND IT
 * IS NOT NEGOTIABLE ANYWAY. The lens it makes is 0.011 u wider than the unit
 * suite's overlap probe needs; widen the gap by a hundredth and the rite loses
 * the case "the frontmost target wins" is a rule about. The pile on the
 * screenshot was HORIZONTAL and came from the lane jitter — see LANE_JITTER.
 *
 * Move a row and you are changing the hit test, not just the picture —
 * tests/unit/luckyshot-rite.test.js searches for a real overlap and fails
 * loudly if the geometry stops producing one.
 */
const ROW_TABLE = Object.freeze([
  Object.freeze({ y: -2.00, r: 0.86, speed: 2.05, dir:  1, value: 1 }),
  Object.freeze({ y: -0.65, r: 0.64, speed: 2.80, dir: -1, value: 2 }),
  Object.freeze({ y:  0.95, r: 0.48, speed: 3.60, dir:  1, value: 3 }),
]);

/**
 * How far a target may sit from its evenly spaced slot, as a fraction of the
 * slot (TRACK / PER_ROW = 3.33 u).
 *
 * IT WAS 0.34 AND IT WAS THE PILE. Two neighbours in the SAME row could each be
 * nudged 1.13 u towards one another, leaving 1.07 u between their centres —
 * inside the 1.72 u sum of two front-row radii, so two "1"s drew as one lump
 * with a three-unit hole beside it. At 0.16 the closest two neighbours can get
 * is 2.27 u, comfortably clear of any pair of radii in any row, and the
 * procession still does not tick like a metronome.
 */
const LANE_JITTER = 0.16;

const ROWS = ROW_TABLE.length;
const TARGETS = ROWS * PER_ROW;

/**
 * The golden target pays this many times its own row's value, ONCE.
 *
 * It was 3x-forever and is now 4x-once (see GOLDEN_CLAIMS). A prize that renews
 * itself has to be small or it becomes the whole rite; a prize that is taken
 * once can afford to be worth going out of your way for, which is the only thing
 * that makes "leave the row you are tracking and cross the booth" a decision
 * rather than a mistake. Four rather than three because the claim rule removed
 * about two points from a competent run and the calibration curve wanted them
 * back — in the field, not in the bar.
 */
const GOLDEN_MULT = 4;

/** The bystander. Negative, small, and the only way to lose points. */
const BYSTANDER_VALUE = -1;

/**
 * PAR — the score that is worth a full payout.
 *
 * Nineteen hits at the average target value, out of twenty-four rounds. That is
 * 79 % accuracy on moving targets, which is a good run and not a perfect one:
 * the ceiling has to be reachable or the top of the curve is decoration.
 *
 * PAR IS CONSTANT ACROSS WAVES, AND THAT IS DELIBERATE. `ctx.wave` shrinks and
 * quickens the valuable row, so a late rite genuinely is harder — but the payout
 * ALREADY scales with the wave, because `minigameReward` multiplies by the next
 * wave's gross. Indexing PAR to the wave as well would charge the player twice
 * for the same wave: harder targets AND a higher bar, for gold they were going
 * to get for the same quality of play. One of the two scales. It is the reward.
 *
 * The corollary is that the wave has to be felt IN THE FIELD or it is not felt
 * at all — a constant bar with a constant game is a rite that gets easier as the
 * player's other numbers grow. See WAVE_SHRINK for the lever that carries it.
 */
const AVG_VALUE = ROW_TABLE.reduce((a, r) => a + r.value, 0) / ROWS;   // 2
const PAR_HITS = 19;
const PAR = PAR_HITS * AVG_VALUE;                                      // 38

/** Seconds a knocked-down target stays down before it flips back up. */
const DOWN_TIME = 1.15;

/**
 * The golden target stays down more than four times as long.
 *
 * Not flavour: it is worth 3x, so if it came back on the ordinary timer the
 * whole optimal line would be "stand where the golden respawns and wait", and
 * the other seventeen targets would be scenery. It was 3.2 s, which was chosen
 * for exactly that reason and MEASURED SHORT: a bot that fired at nothing but
 * the golden scored 0.740 / 0.700 / 0.735 out of ~7 of its 24 rounds — better
 * than a competent player, on a third of the ammo, with no aiming problem to
 * solve because it never had to leave one spot.
 */
const GOLDEN_DOWN_TIME = 5.0;

/**
 * THE PRIZE IS CLAIMED ONCE. A longer timer alone does not fix camping.
 *
 * At 5 s the camper still gets four bites of a 9-point target inside the clock,
 * and the arithmetic still says "wait at the shiny one" — the timer only changes
 * how profitable the wait is, never that it is the best line. So the triple is
 * a PRIZE, not a rate: the first knockdown pays 3x, and the cut-out comes back
 * up as an ordinary member of its row, grey, un-haloed, wearing its row's
 * numeral. After that, standing on it is farming one target for its face value,
 * which is strictly worse than shooting the eighteen that are standing.
 *
 * It also gives the rite a real opening decision — go and take the prize now, at
 * whatever range it happens to be, or bank the row you are already tracking —
 * which is worth more than a bonus that renews itself for free.
 */
const GOLDEN_CLAIMS = 1;

/**
 * WHAT THE WAVE ACTUALLY MAKES HARDER, AND WHY IT IS NOT THE BAR.
 *
 * PAR is constant (see below, and that reasoning stands). Row speed alone was
 * the only thing the wave moved, and the calibration harness measured what that
 * is worth: nothing. The reference player scored 0.863 at wave 3 and 0.937 at
 * wave 53 — the rite got EASIER as the run got harder, because a hand that
 * tracks a belt does not care how fast the belt goes, and 24 rounds against a
 * fixed 38 has enough slack to absorb a 40% speed-up without noticing.
 *
 * THE LEVER IS THE BACK ROW'S SIZE, AND IT IS THE ONE THE GAME WAS ALREADY
 * ABOUT. The rite's whole decision is "how much value will I pay for in
 * difficulty": the front row is fat, slow and worth 1; the back row is small,
 * quick and worth 3. The wave TILTS THAT TRADE rather than taxing the player.
 * The valuable row shrinks (and quickens) as the run goes on until, late, the
 * greedy line — always shoot the 3 — is a coin flip on a 0.3 u disc, and the
 * player who moves down to the 2s and the 1s out-scores them. The front row
 * never shrinks by a hair, so the floor of the rite is exactly where it was:
 * a player who cannot hit the back row late has somewhere honest to go.
 *
 * That also keeps the wave OUT OF THE HIT GEOMETRY that matters. Rows 0 and 1
 * must overlap for `hitIndex`'s frontmost rule to have a case, and both of their
 * radii are wave-invariant, so the overlap is the same at wave 53 as at wave 3.
 * Only the back row — which is clear of the middle by a third of a unit and gets
 * clearer as it shrinks — moves.
 */
const WAVE_FIRST = 3;
const WAVE_LAST = 53;

/**
 * Radius multiplier per row at WAVE_LAST.
 *
 * ONLY THE BACK ROW, AND THE OTHER TWO ARE 1.00 BY ARITHMETIC RATHER THAN BY
 * TASTE. Rows 0 and 1 have to keep overlapping (above), and the lens their 1.35
 * gap makes is 0.011 u deeper than the unit suite's probe needs. Shrinking the
 * middle row by even 3% closes it. So the front two ranks are wave-invariant in
 * size — which is also the design, since they are the honest fallback — and the
 * whole size lever is spent on the row that is worth triple and is a third of a
 * unit clear of anything it could collide with.
 */
const WAVE_SHRINK = Object.freeze([1.00, 1.00, 0.54]);

/** Speed multiplier per row at WAVE_LAST. The valuable rows quicken most. */
const WAVE_SPEED = Object.freeze([1.10, 1.30, 1.60]);

/**
 * The shape of the ramp between WAVE_FIRST and WAVE_LAST.
 *
 * SPENT EARLY, ON PURPOSE, AND MEASURED RATHER THAN CHOSEN. The target curve is
 * a STRAIGHT line in wave (calibration.test.js), but what a player feels is not
 * the radius, it is the AREA of the disc they are trying to land a shaky hand
 * inside — and area is the square of the thing being ramped, so a straight ramp
 * in radius is a lever that does almost nothing for the first half of a run and
 * everything in the last quarter. Swept with everything else held, reference
 * player, waves 3 / 28 / 53:
 *
 *   ease 1.0 (straight)   0.795 / 0.821 / 0.558   <- wave 28 OUTSIDE the band,
 *                                                    and 0.047 of inversion
 *                                                    between waves 3 and 23
 *   ease 0.45             0.795 / 0.684 / 0.558   <- on the line, 0.016 worst
 *
 * Both end in the same place. Only one of them is a difficulty curve on the way
 * there, and a dial the player cannot feel moving for twenty-five waves is a
 * dial they never learn to respect.
 */
const WAVE_EASE = 0.45;

/** How long the flip-back-up animation takes, at the END of the down time. */
const RESET_SPIN = 0.45;

/**
 * A beat between the last round and the result card.
 *
 * Firing the 24th round must not cut to the result on the same frame — the
 * player never sees whether it landed, and the last shot is the one they care
 * about most. Ammo is still zero throughout, so nothing can be scored during
 * the hold; it buys the kill a moment on screen and costs nothing.
 */
const END_HOLD = 0.45;

/** Below this many rounds the counter starts shouting. */
const LOW_AMMO = 5;

// ---- presentation-only sizes ----------------------------------------------

/** Points on each target's silhouette, fed to `Painter.blob`. */
const SHAPE_PTS = 9;

/** Pre-drawn noise values. See `#noise()` for why the generator is not kept. */
const NOISE_N = 64;

/** Spark and floating-number pools. Ring buffers: bounded by construction. */
const SPARKS = 24;
const POPS = 6;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, every wave, always.
 *
 *   ROWS      (3) — one belt phase per row, so two rows never march in lockstep
 *   TARGETS  (18) — one lane jitter per target, so the six are not a metronome
 *   1             — which target is golden
 *   1             — which target is the bystander (drawn to avoid the golden
 *                   WITHOUT a retry loop; a retry consumes a variable number of
 *                   values and that is the classic way to desync a room)
 *   1             — the seed for the private presentation generator
 *
 * Passed to `assertRiteContract` as `randCalls`, which pins it on three waves.
 */
const RAND_CALLS = ROWS + TARGETS + 3;   // 24

/**
 * Scratch for one silhouette, MODULE-LEVEL AND NOT INSTANCE STATE.
 *
 * `draw()` must not mutate the instance (the contract, and a unit test), so a
 * per-frame buffer cannot hang off `this`. It lives here instead: one rite
 * draws at a time, `draw` is synchronous and does not re-enter, and this saves
 * eighteen array allocations per frame in the one file that draws eighteen
 * shapes. If a second rite is ever drawn in the same frame, this is the line
 * that breaks — so it is named here rather than discovered later.
 */
const SHAPE_SCRATCH = Array.from({ length: SHAPE_PTS }, () => [0, 0]);

/**
 * The booth's own darkness — for a numeral painted ON a light target, and for
 * the shadow line under a plank.
 *
 * The ONE colour here that is not a design token, and it is named rather than
 * scattered as four literals so the exception is visible. There is no token for
 * it: the stage's backdrop is `--rite-stage-bg` in minigames.css, a multi-stop
 * GRADIENT set on `#rite` rather than on the document element, and a canvas can
 * neither resolve a gradient token nor read a variable off an element it does
 * not have. This tracks the dark end of that gradient by hand. Everything else
 * in this file comes from `#readPalette`.
 */
const BOOTH_INK = '#0b0806';

/** Index from a [0,1) draw, safe even if a generator ever returns exactly 1. */
function pick(u, n) { return Math.min(n - 1, Math.floor(u * n)); }

/**
 * The value painted on a cut-out — UPRIGHT, whatever the cut-out is doing.
 *
 * Called inside `#drawTarget`'s rotated frame and immediately undoing that
 * rotation, which looks like a contradiction and is the whole point. The BOARD
 * tips when it is knocked down and when it flips back up; the NUMBER PAINTED ON
 * IT must not, because it is the one piece of information the player is reading
 * off the board. On a screenshot the golden target — the highest value on the
 * field, and the one that spends the longest lying down, so the one most often
 * caught mid-flip — was showing its "4x" at thirty degrees and squashed, while
 * every 1, 2 and 3 around it stood upright. The single hardest label to read was
 * the one it mattered most to read.
 *
 * @param {number} tilt  The frame's rotation, in radians, to be cancelled.
 */
function faceNumeral(g, str, size, tilt) {
  g.save();
  g.translate(0, -0.02);
  g.rotate(tilt);
  g.text(str, 0, 0, { size, fill: BOOTH_INK, weight: 600, baseline: 'middle' });
  g.restore();
}

/**
 * '#e5bd79' -> '229,189,121'. `Painter.halo` wants BARE channels and there is
 * no CSS token in that form, so rather than hardcode a second copy of the
 * palette this converts the token that is already read. Anything that is not a
 * six-digit hex (a token authored as `rgba(...)`, or a missing variable) falls
 * back to the literal, which is the same rule the token reader itself uses.
 */
function channels(css, fallback) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// ---------------------------------------------------------------------------

class LuckyShotRite {
  init(ctx) {
    /**
     * Wave scales the ROW GEOMETRY — size and speed, per row — and nothing else.
     * Not the ammo, not the target count, not PAR, and — critically — not the
     * NUMBER of rand() calls, which would break the determinism contract the
     * moment two players sat on different waves. See WAVE_SHRINK for what the
     * lever is and the PAR docblock for why the bar stays put.
     */
    this.wave = ctx.wave;
    const w = clamp((ctx.wave - WAVE_FIRST) / (WAVE_LAST - WAVE_FIRST), 0, 1) ** WAVE_EASE;
    this.waveT = w;
    /** Per-row radius and speed for THIS wave. Read by the world and by draw. */
    this.rowR = ROW_TABLE.map((R, row) => R.r * (1 + (WAVE_SHRINK[row] - 1) * w));
    this.rowSpeed = ROW_TABLE.map((R, row) => R.speed * (1 + (WAVE_SPEED[row] - 1) * w));
    /**
     * Kept because the suite reads it and because one number is the honest
     * summary of "how much faster is this wave" — the belts, at the back.
     */
    this.speedMul = 1 + (WAVE_SPEED[ROWS - 1] - 1) * w;

    /**
     * STRUCTURAL VARIATION, NEVER DIFFICULTY. On a second visit the whole
     * gallery runs the other way: every belt reverses. Same speeds, same sizes,
     * same values, same ammo — a player who learned to lead left now leads
     * right, and not one number in the tuning table moved.
     */
    this.dirFlip = (ctx.occurrence || 0) % 2 === 0 ? 1 : -1;

    // ---- the fixed randomness budget: RAND_CALLS draws, in this order ------
    this.rowPhase = [];
    for (let r = 0; r < ROWS; r++) this.rowPhase.push(ctx.rand());

    const jitter = [];
    for (let i = 0; i < TARGETS; i++) jitter.push(ctx.rand() * 2 - 1);

    const golden = pick(ctx.rand(), TARGETS);
    // Drawn over TARGETS-1 and then shifted past the golden: a distinct index
    // for one draw, with no branch and no loop. "Draw again if it collides" is
    // the same distribution and a variable number of rand() calls.
    let bystander = pick(ctx.rand(), TARGETS - 1);
    if (bystander >= golden) bystander++;

    /**
     * ONE draw becomes every cosmetic value in the rite.
     *
     * `ctx.rand()` may not be consulted for presentation — the number of calls
     * would then depend on how the frame went — so a private mulberry32 is
     * seeded from a single draw, spent entirely here in `init`, and then
     * DROPPED. Nothing after this line holds a generator, which means nothing
     * after this line can accidentally advance one from `draw()`.
     */
    const fx = mulberry32(Math.floor(ctx.rand() * 0xffffffff) >>> 0);

    // ---- the field --------------------------------------------------------
    this.golden = golden;
    this.bystander = bystander;
    this.targets = [];
    for (let row = 0; row < ROWS; row++) {
      const R = ROW_TABLE[row];
      for (let col = 0; col < PER_ROW; col++) {
        const i = row * PER_ROW + col;
        const kind = i === golden ? 'golden' : i === bystander ? 'bystander' : 'creep';
        this.targets.push({
          row,
          r: this.rowR[row],
          kind,
          /**
           * What this target is worth RIGHT NOW. The golden's triple is a prize
           * and is spent on the first knockdown (GOLDEN_CLAIMS), after which
           * this drops to its row's face value and `kind` becomes 'creep' — one
           * field, so the score, the numeral and the pop-up cannot disagree.
           */
          value: kind === 'golden' ? R.value * GOLDEN_MULT
            : kind === 'bystander' ? BYSTANDER_VALUE
              : R.value,
          // Evenly spaced along the belt, nudged by at most LANE_JITTER of a
          // slot so the row is a procession and not a metronome. It can never
          // reorder the row, and — since the tightening — can never close two
          // neighbours to less than the sum of their radii either.
          lane: (col + LANE_JITTER * jitter[i]) * (TRACK / PER_ROW),
          /** World time at which this target stands back up. -1 = never hit. */
          downUntil: -1,
        });
      }
    }

    // Silhouette radii, flat and typed: one allocation for all eighteen shapes.
    this.shape = new Float64Array(TARGETS * SHAPE_PTS);
    for (let k = 0; k < this.shape.length; k++) this.shape[k] = 0.82 + fx() * 0.36;
    this.noise = new Float64Array(NOISE_N);
    for (let k = 0; k < NOISE_N; k++) this.noise[k] = fx();

    // ---- run state --------------------------------------------------------
    this.t = 0;
    this.ammo = AMMO;
    this.shots = 0;
    this.hits = 0;
    this.points = 0;
    this.goldenHits = 0;
    /** Prizes taken. Once this reaches GOLDEN_CLAIMS the gold is spent. */
    this.goldenClaims = 0;
    this.bystanderHits = 0;
    this.streak = 0;
    this.bestStreak = 0;
    /** World time the last round was spent, or -1. Drives END_HOLD. */
    this.emptyAt = -1;

    // ---- presentation state (written in update, only READ in draw) ---------
    this.aimX = 0;
    this.aimY = ROW_TABLE[0].y;
    this.aimed = false;
    this.flash = 0;
    this.recoil = 0;
    this._nc = 0;
    this._events = [];
    this._sparks = Array.from({ length: SPARKS },
      () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, kind: 'hit' }));
    this._sparkAt = 0;
    this._pops = Array.from({ length: POPS },
      () => ({ x: 0, y: 0, val: 0, life: 0, max: 1 }));
    this._popAt = 0;
    this._started = false;

    this.palette = this.#readPalette();
  }

  /**
   * Canvas colours come from the stylesheet, not from this file.
   *
   * A canvas cannot resolve `var(--gold)`, so the tokens are read ONCE, here,
   * with literal fallbacks so the same code runs in node and in jsdom. Never
   * per frame: `getComputedStyle` forces style resolution, and doing that
   * sixty times a second inside an overlay is a measurable stall for a value
   * that cannot change while a rite is open. Pattern lifted verbatim from
   * `src/ui/Lottery.js#readPalette`.
   */
  #readPalette() {
    const cs = typeof getComputedStyle === 'function' && typeof document !== 'undefined'
      ? getComputedStyle(document.documentElement)
      : null;
    const tok = (name, fallback) => (cs?.getPropertyValue(name) || '').trim() || fallback;
    const p = {
      ink: tok('--ink', '#e9ebf3'),
      ink2: tok('--ink-2', '#a3a9bb'),
      ink3: tok('--ink-3', '#6d7488'),
      ink4: tok('--ink-4', '#4a5064'),
      gold: tok('--gold', '#e5bd79'),
      goldHi: tok('--gold-hi', '#f7dfae'),
      danger: tok('--danger', '#ff5f57'),
      warn: tok('--warn', '#ffb454'),
      line: tok('--line-2', 'rgba(255,255,255,0.14)'),
    };
    p.goldRgb = channels(p.gold, '229,189,121');
    p.dangerRgb = channels(p.danger, '255,95,87');
    p.inkRgb = channels(p.ink, '233,235,243');
    return p;
  }

  // ---- the world ---------------------------------------------------------

  /**
   * Where target `i` is at world time `t`. A PURE FUNCTION OF `t`.
   *
   * Nothing about a target's position is integrated step by step, which is the
   * fixed-timestep rule in docs/MINIGAMES.md §4 applied to the thing it matters
   * most for: an accumulated `x += v * dt` picks up a different rounding error
   * on every client over twelve hundred steps, and a target that is half a
   * radius out of place is a hit on one machine and a miss on another. It also
   * means `draw` can ask for a position at `t + alpha * dt` and interpolate for
   * free, and that a test can ask where a target WILL be next step.
   */
  xAt(i, t) {
    const tg = this.targets[i];
    const R = ROW_TABLE[tg.row];
    const d = tg.lane + this.rowPhase[tg.row] * TRACK
      + R.dir * this.dirFlip * this.rowSpeed[tg.row] * t;
    return d - Math.floor(d / TRACK) * TRACK - TRACK / 2;
  }

  /** The row's height. Constant — targets travel, they do not bob. */
  yAt(i) { return ROW_TABLE[this.targets[i].row].y; }

  /** A target is shootable unless it is lying down. */
  aliveAt(i, t) { return t >= this.targets[i].downUntil; }

  /**
   * Which target a shot at (cx, cy) resolves against, or -1 for a clean miss.
   *
   * TWO RULES, AND BOTH ARE TESTED. Exactly ONE target per click, ever — the
   * loop returns on the first containment, so a shot into an overlap cannot
   * knock down two things and cannot be worth two values. And the FRONTMOST
   * target wins that overlap, which falls out of `targets` being built
   * front-row-first: the first index that contains the point is by construction
   * the nearest one. What the player sees in front is what they hit.
   *
   * The hit radius IS the drawn radius. No aim assist, no separate hitbox: a
   * gallery whose targets are bigger than they look is a gallery whose skill
   * ceiling is invisible.
   */
  hitIndex(cx, cy, t) {
    for (let i = 0; i < TARGETS; i++) {
      const tg = this.targets[i];
      if (t < tg.downUntil) continue;
      const dx = cx - this.xAt(i, t);
      const dy = cy - ROW_TABLE[tg.row].y;
      if (dx * dx + dy * dy <= tg.r * tg.r) return i;
    }
    return -1;
  }

  // ---- the step ----------------------------------------------------------

  update(dt, input) {
    this.t += dt;

    if (!this._started) {
      this._started = true;
      this._events.push({ type: 'start' });
    }

    // `inside` guarded: the host leaves the LAST KNOWN position in x/y rather
    // than resetting it, so reading them while the pointer is off the stage
    // gets a stale value. Keeping the reticle where it was is the honest
    // picture; snapping it to the origin would look like the player moved.
    if (input.inside) { this.aimX = input.x; this.aimY = input.y; this.aimed = true; }

    this.flash = Math.max(0, this.flash - dt * 3.2);
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.#stepFx(dt);

    /**
     * THE TRIGGER. One round per queued click, in the order they arrived.
     *
     * `input.clicks` and nothing else: `action` and `altAction` count the same
     * commits from the other side and adding them would fire twice per press.
     * The queue is only ever iterated INSIDE the step it was handed to (the
     * records are pooled and refilled — contract.js), and nothing from it is
     * kept: `#fire` takes two numbers.
     */
    for (const c of input.clicks) {
      if (this.ammo <= 0) break;                 // out of rounds: the queue is inert
      this.ammo--;
      this.shots++;
      this.recoil = 1;
      this.#fire(c.x, c.y);
      if (this.ammo === 0) this.emptyAt = this.t;
    }

    // Two ways to end, and the rite owns both. Returning true rather than
    // waiting for the host's clock is what makes an empty gun feel like an
    // ending instead of ten seconds of staring at a booth.
    if (this.emptyAt >= 0 && this.t >= this.emptyAt + END_HOLD) return true;
    if (this.t >= DURATION) return true;
    return undefined;
  }

  /** Resolve one round. The round is already spent by the time we get here. */
  #fire(cx, cy) {
    const i = this.hitIndex(cx, cy, this.t);

    if (i < 0) {
      // A MISS STILL COSTS A ROUND. That is the whole economy of the rite.
      this.streak = 0;
      this.#burst(cx, cy, 5, 'miss');
      this._events.push({ type: 'miss', x: cx });
      return;
    }

    const tg = this.targets[i];
    const x = this.xAt(i, this.t);
    const y = ROW_TABLE[tg.row].y;
    tg.downUntil = this.t + (tg.kind === 'golden' ? GOLDEN_DOWN_TIME : DOWN_TIME);
    this.points += tg.value;
    this.#pop(x, y, tg.value);

    if (tg.kind === 'bystander') {
      this.bystanderHits++;
      this.streak = 0;
      this.#burst(x, y, 8, 'bad');
      // `break` is the heaviest negative the host has: something you were
      // supposed to protect went over. Exactly right for shooting a civilian.
      this._events.push({ type: 'break', x });
      return;
    }

    this.hits++;
    this.streak++;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;

    if (tg.kind === 'golden') {
      this.goldenHits++;
      this.goldenClaims++;
      // THE PRIZE IS SPENT. It comes back up as an ordinary member of its row —
      // the halo, the spikes and the "3x" all go with `kind`, so what the player
      // sees standing again is exactly what it is now worth. See GOLDEN_CLAIMS.
      if (this.goldenClaims >= GOLDEN_CLAIMS) {
        tg.kind = 'creep';
        tg.value = ROW_TABLE[tg.row].value;
      }
      this.flash = 1;
      this.#burst(x, y, 14, 'gold');
      // `perfect` is spent HERE and nowhere else. A rite can resolve twenty-odd
      // times in twenty seconds; kicking the stage at full weight for each of
      // them is nausea, not impact. The golden is the one moment that earned it.
      this._events.push({ type: 'perfect', x });
    } else {
      this.#burst(x, y, 7, 'hit');
      this._events.push({ type: 'good', x });
    }
  }

  // ---- presentation state (stepped here, never in draw) ------------------

  /**
   * The next pre-drawn noise value.
   *
   * The generator itself was dropped at the end of `init` (see there), so
   * "random" spark angles come from a fixed table read with a rolling cursor.
   * Deterministic, allocation-free, and — the point — impossible to advance
   * from `draw()`, because `draw()` has no reason to call this and no
   * generator to reach for if it did.
   */
  #noise() {
    const v = this.noise[this._nc];
    this._nc = (this._nc + 1) % NOISE_N;
    return v;
  }

  /** Sparks and floating numbers. Ring buffers: the oldest is overwritten. */
  #burst(x, y, n, kind) {
    for (let k = 0; k < n; k++) {
      const s = this._sparks[this._sparkAt];
      this._sparkAt = (this._sparkAt + 1) % SPARKS;
      const a = this.#noise() * Math.PI * 2;
      const sp = 1.6 + this.#noise() * 3.4;
      s.x = x; s.y = y;
      s.vx = Math.cos(a) * sp;
      s.vy = Math.sin(a) * sp + 1.2;
      s.life = 0.30 + this.#noise() * 0.28;
      s.max = s.life;
      s.kind = kind;
    }
  }

  #pop(x, y, val) {
    const p = this._pops[this._popAt];
    this._popAt = (this._popAt + 1) % POPS;
    p.x = x; p.y = y; p.val = val; p.life = 0.9; p.max = 0.9;
  }

  #stepFx(dt) {
    for (const s of this._sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy -= 9 * dt;          // sawdust falls
      s.vx *= 0.985;
    }
    for (const p of this._pops) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.y += 1.4 * dt;
    }
  }

  // ---- drawing -----------------------------------------------------------

  /**
   * MUST NOT MUTATE STATE. Every value below is read; nothing is written.
   *
   * `alpha` is spent on ONE thing — the time positions are sampled at — which
   * is all it takes to make three rows of moving targets smooth on a 144 Hz
   * panel while the simulation stays at 60. It is not applied to the sparks or
   * the counters: sixteen milliseconds of lag on a spark is invisible, and on a
   * number it is nothing at all.
   */
  draw(g, alpha = 0) {
    const P = this.palette;
    const t = this.t + alpha * MINIGAMES.dt;

    // Clipped to the field: the letterbox can leave live canvas outside the
    // 16x9 rectangle, and a target riding the belt at x = 9 would be visible
    // out there — floating in the margin, unhittable, and obviously a bug.
    g.clipRect(0, 0, 16, 9, () => {
      this.#drawBooth(g, P);
      for (let row = ROWS - 1; row >= 0; row--) {
        for (let col = 0; col < PER_ROW; col++) this.#drawTarget(g, P, row * PER_ROW + col, t);
        this.#drawRail(g, P, row);
      }
      this.#drawFx(g, P);
      this.#drawReticle(g, P);
      this.#drawChrome(g, P);
    });
  }

  #drawBooth(g, P) {
    // Back wall: a warm wash under the lamp, falling to nothing at the floor.
    g.rect(0, 0, 16, 9, {
      fill: g.linearFill(0, 4.5, 0, -4.5, [
        [0, 'rgba(48,32,18,0.55)'], [0.55, 'rgba(20,14,9,0.35)'], [1, 'rgba(6,5,4,0.0)'],
      ]),
    });

    // The one hot lamp. Everything in the booth is lit from above by this.
    g.save().add();
    g.halo(0, 4.3, 7.2, P.goldRgb, 0.10, 0.4);
    g.restore();

    /**
     * Awning: ten stripes with a scalloped hem, alternating warm and dark.
     *
     * THE HEM IS A SHALLOW ELLIPSE, NOT A HALF-DISC, AND THE TWO READ COMPLETELY
     * DIFFERENTLY. It was a circle of radius 0.7 hung under a 1.6-wide stripe,
     * which left a fifth of a unit of black between neighbours — ten separate
     * round things in a row along the top of the frame, which on a screenshot is
     * not an awning, it is a row of coins. Two changes: the scallops now span
     * the FULL stripe (rx = half the stripe, so consecutive hems touch and the
     * hem is one continuous wave), and they are half as deep as they are wide,
     * because a real awning scallop is a shallow swag and a semicircle is a
     * bauble.
     *
     * It sits high enough that the hem clears the score readout — 3.48 against a
     * numeral topping out at 3.01 — because a fairground awning that crosses the
     * numbers is a fairground awning nobody can read through.
     */
    for (let k = 0; k < 10; k++) {
      const x = -8 + 0.8 + k * 1.6;
      const warm = k % 2 === 0;
      g.save().alpha(warm ? 0.34 : 0.20);
      g.rect(x, 4.17, 1.6, 0.66, { fill: warm ? P.gold : P.ink4 });
      g.ellipse(x, 3.90, 0.8, 0.42, 0, { fill: warm ? P.gold : P.ink4 });
      g.restore();
    }
    g.line(-8, 3.90, 8, 3.90, P.line, 0.03);

    // Sawdust floor, kept out from under the counters.
    g.save().alpha(0.5);
    g.rect(0, -4.29, 16, 0.42, { fill: P.ink4 });
    g.restore();
  }

  /**
   * The plank each row stands on, drawn AFTER its own row so it occludes the
   * feet. That single ordering choice is most of why three flat rows read as
   * three ranks at three depths.
   */
  #drawRail(g, P, row) {
    const y = ROW_TABLE[row].y - this.rowR[row] * 1.02;
    // OPAQUE, and thick enough to be a plank. The first version was a 0.22
    // sliver at half alpha and it read as a stray line crossing the targets
    // rather than as a shelf they stand on — an occluder that does not occlude
    // is just a line.
    g.rect(0, y - 0.06, 16, 0.34, { fill: BOOTH_INK });
    g.save().alpha(0.9 - row * 0.14);
    g.rect(0, y - 0.06, 16, 0.30, { fill: P.ink4, radius: 0.06 });
    g.rect(0, y + 0.07, 16, 0.05, { fill: P.ink3 });          // lamp-lit top edge
    g.restore();
  }

  #drawTarget(g, P, i, t) {
    const tg = this.targets[i];
    const R = ROW_TABLE[tg.row];
    const x = this.xAt(i, t);
    if (x < -9.2 || x > 9.2) return;              // beyond the booth walls

    const down = t < tg.downUntil;
    // The flip-up happens in the LAST RESET_SPIN seconds of the down time, so a
    // player can see a target coming back and pre-aim it. A target that simply
    // reappeared would feel like a spawn, not like a gallery.
    const rise = down ? clamp(1 - (tg.downUntil - t) / RESET_SPIN, 0, 1) : 1;
    const tilt = (1 - rise) * 1.44;               // ~82 degrees, flat on the rail

    g.save();
    g.translate(x, R.y - tg.r);                   // pivot at the foot, not the middle
    g.rotate(-tilt);
    g.translate(0, tg.r);
    g.alpha(down ? 0.45 + 0.55 * rise : 1);

    // The silhouette. Nine seeded radii through `blob`, which smooths them into
    // a closed outline — `poly` would give a nonagon, which reads as a failure
    // to tessellate rather than as a style.
    const base = i * SHAPE_PTS;
    for (let k = 0; k < SHAPE_PTS; k++) {
      const a = (k / SHAPE_PTS) * Math.PI * 2;
      const rr = tg.r * this.shape[base + k];
      SHAPE_SCRATCH[k][0] = Math.cos(a) * rr;
      SHAPE_SCRATCH[k][1] = Math.sin(a) * rr * 1.06;
    }

    if (tg.kind === 'golden') {
      g.save().add();
      g.halo(0, 0, tg.r * 3.4, P.goldRgb, 0.5, 0.35);
      g.restore();
      // Spikes: a second, non-chromatic signal that this one is special.
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + this.t * 0.9;
        g.line(Math.cos(a) * tg.r * 1.15, Math.sin(a) * tg.r * 1.15,
          Math.cos(a) * tg.r * 1.85, Math.sin(a) * tg.r * 1.85, P.goldHi, 0.08, 'round');
      }
      g.blob(SHAPE_SCRATCH, { fill: P.gold, stroke: P.goldHi, width: 0.07 });
      faceNumeral(g, `${GOLDEN_MULT}x`, tg.r * 0.78, tilt);
    } else if (tg.kind === 'bystander') {
      /**
       * THE BYSTANDER, and every channel except colour says so.
       *
       * Hands up instead of horns, a hard cross over the body, and — the one
       * that did the most work on a screenshot — an INVERTED outline: the
       * creeps are a mid-grey body with a light rim, so the bystander is a
       * near-white body with a black rim. Before that inversion it was a pale
       * blob among pale blobs and only the red X separated them, which is
       * exactly the single-channel failure docs/MINIGAMES.md §12 warns about.
       */
      g.blob(SHAPE_SCRATCH, { fill: P.ink, stroke: BOOTH_INK, width: 0.09 });
      g.capsule(-tg.r * 0.62, tg.r * 0.15, -tg.r * 0.95, tg.r * 1.05, tg.r * 0.15,
        { fill: P.ink, stroke: BOOTH_INK, width: 0.06 });
      g.capsule(tg.r * 0.62, tg.r * 0.15, tg.r * 0.95, tg.r * 1.05, tg.r * 0.15,
        { fill: P.ink, stroke: BOOTH_INK, width: 0.06 });
      const d = tg.r * 0.5;
      g.line(-d, -d, d, d, P.danger, 0.07, 'round');
      g.line(-d, d, d, -d, P.danger, 0.07, 'round');
    } else {
      // Horns FIRST, so the body covers their roots. Sharp, not capsules: a
      // rounded stub over a rounded body read as an antenna on a teddy bear.
      g.poly([[-tg.r * 0.42, tg.r * 0.5], [-tg.r * 0.86, tg.r * 1.32],
        [-tg.r * 0.20, tg.r * 0.78]], { fill: P.ink3 });
      g.poly([[tg.r * 0.42, tg.r * 0.5], [tg.r * 0.86, tg.r * 1.32],
        [tg.r * 0.20, tg.r * 0.78]], { fill: P.ink3 });
      // Lit from the lamp above: a vertical ramp rather than a flat fill, which
      // is the difference between a cut-out standing in a booth and a hole.
      g.blob(SHAPE_SCRATCH, {
        fill: g.linearFill(0, tg.r, 0, -tg.r, [[0, P.ink2], [0.55, P.ink3], [1, P.ink4]]),
        stroke: P.ink, width: 0.045,
      });
      // THE VALUE, AS A NUMERAL. It was three gold pips, and on a screenshot the
      // pips read as a face — which is charming and completely useless when the
      // question is "is this one worth 1 or 3". A carnival target has a number
      // painted on it; so does this one. Redundant with the size and the row,
      // which is the point: three channels, none of them colour alone.
      faceNumeral(g, `${tg.value}`, tg.r * 0.86, tilt);
    }

    g.restore();
  }

  #drawFx(g, P) {
    g.save().add();
    for (const s of this._sparks) {
      if (s.life <= 0) continue;
      const f = s.life / s.max;
      const col = s.kind === 'gold' ? P.goldHi : s.kind === 'bad' ? P.danger
        : s.kind === 'miss' ? P.ink3 : P.gold;
      g.alpha(f * 0.9);
      g.circle(s.x, s.y, 0.035 + 0.09 * f, { fill: col });
    }
    g.restore();

    for (const p of this._pops) {
      if (p.life <= 0) continue;
      const f = p.life / p.max;
      g.save().alpha(Math.min(1, f * 1.8));
      g.text(p.val > 0 ? `+${p.val}` : `${p.val}`, p.x, p.y + 0.9 * (1 - f), {
        size: 0.42 + 0.2 * f,
        fill: p.val > 2 ? P.goldHi : p.val > 0 ? P.gold : P.danger,
        weight: 600,
      });
      g.restore();
    }
  }

  #drawReticle(g, P) {
    if (!this.aimed) return;
    const k = 1 + this.recoil * 0.55;             // the trigger has weight
    const r = 0.34 * k;
    g.save().alpha(0.5 + 0.4 * this.recoil);
    g.circle(this.aimX, this.aimY, r, { stroke: P.goldHi, width: 0.035 });
    for (let q = 0; q < 4; q++) {
      const a = q * Math.PI / 2;
      g.line(this.aimX + Math.cos(a) * r * 1.35, this.aimY + Math.sin(a) * r * 1.35,
        this.aimX + Math.cos(a) * r * 2.15, this.aimY + Math.sin(a) * r * 2.15,
        P.goldHi, 0.035, 'round');
    }
    g.circle(this.aimX, this.aimY, 0.03, { fill: P.goldHi });
    g.restore();
  }

  #drawChrome(g, P) {
    const empty = this.ammo <= 0;
    const low = this.ammo <= LOW_AMMO;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 9);

    // A golden hit whites the whole booth for a beat. This is the pulse-jump.
    if (this.flash > 0) {
      g.save().add().alpha(this.flash * 0.22);
      g.rect(0, 0, 16, 9, { fill: P.goldHi });
      g.restore();
    }

    /**
     * Score, top left, in the band between the awning hem (3.06) and the back
     * row (1.43). PAR sits beside it, unadorned, because a player who does not
     * know what they are shooting for is playing a slot machine.
     *
     * `approxTextWidth` rather than a measured width: measuring for real needs
     * a live canvas, and a rite that measures for real is a rite the node suite
     * cannot import (contract.js says so at the function itself).
     */
    g.text(`${this.points}`, -7.5, 2.55, {
      size: 0.92, fill: P.goldHi, align: 'left', baseline: 'middle', weight: 600,
    });
    g.text(`/ ${PAR} PAR`, -7.5 + approxTextWidth(`${this.points}`, 0.92) + 0.22, 2.42, {
      size: 0.34, fill: P.ink3, align: 'left', baseline: 'middle', tracking: 0.06,
    });
    if (this.bestStreak > 1) {
      g.text(`BEST STREAK ${this.bestStreak}`, -7.5, 1.88, {
        size: 0.28, fill: P.ink3, align: 'left', baseline: 'middle', tracking: 0.1,
      });
    }

    /**
     * ---- the ammo counter, ONE OBJECT IN ONE CORNER -----------------------
     *
     * It used to be three things in two places: twenty-four pips pinned to the
     * bottom LEFT, the numeral pinned to the bottom RIGHT, and — the part that
     * did the real damage — the spent pips left behind as a long dark fence
     * across the whole frame, carrying no information at all and reading as a
     * border. A reading that is split across sixteen units is a reading nobody
     * takes in at a glance, which is the only kind of reading this number gets.
     *
     * Now the live rounds ARE the bar: the strip is drawn right-aligned under
     * the numeral, one capsule per round REMAINING, so it shortens towards the
     * corner as the rite runs and there is nothing left over to look at. The
     * number and the length say the same thing in two channels, in one place.
     */
    const col = empty ? P.danger : low ? P.warn : P.goldHi;
    const kick = empty ? 1 : low ? 0.35 * pulse : 0;

    /**
     * The warning glow, AND IT IS RAISED FROM THE BOTTOM EDGE RATHER THAN
     * CENTRED ON THE COUNTER.
     *
     * The comment above this used to claim "the whole counter lives below
     * -3.05, which is where the front row's lowest silhouette stops". The text
     * did. The halo did not: it was centred at (5.6, -3.7) with a radius of 4.6,
     * so it reached y = +0.9 and washed an additive gold over the right half of
     * rows 0 and 1 for the last five rounds of every run — brightening the play
     * area exactly when the player most needs to read it. It is now a small,
     * bright glow sitting ON the bottom edge with its centre just off frame, so
     * the counter is lit and the field is not. Arithmetic rather than an
     * assertion: -4.40 + 1.20 = -3.20, and the front row's rail bottoms out at
     * -3.11. The alpha is up because the area is a fifteenth of what it was; a
     * warning has to be seen, it just does not get to be seen everywhere.
     */
    if (low) {
      g.save().add().alpha((empty ? 0.6 : 0.42) * (0.45 + 0.55 * pulse));
      g.halo(6.8, -4.40, 1.20, empty ? P.dangerRgb : P.goldRgb, 1, 0.25);
      g.restore();
    }

    // The strip: one capsule per round REMAINING, growing leftwards from the
    // right edge. Its LENGTH is the ammo; nothing is drawn for a round already
    // spent, because an empty chamber is not a thing on the counter, it is the
    // absence of one. It sits above the numeral so the two read as one block.
    for (let k = 0; k < this.ammo; k++) {
      const x = 7.5 - k * 0.26;
      g.save().alpha(low ? 0.55 + 0.45 * pulse : 0.95);
      g.capsule(x, -3.40, x, -3.22, 0.07, { fill: col });
      g.restore();
    }

    g.text(`${this.ammo}`, 7.5, -4.02, {
      size: 0.95 + kick * 0.2, fill: col, align: 'right', baseline: 'middle', weight: 600,
    });
    g.text(empty ? 'OUT OF ROUNDS' : 'ROUNDS',
      7.5 - approxTextWidth(`${this.ammo}`, 0.95) - 0.28, -4.02, {
        size: 0.3, fill: empty ? P.danger : P.ink3, align: 'right', baseline: 'middle', tracking: 0.14,
      });
  }

  // ---- results -----------------------------------------------------------

  /**
   * PURE. Called by the host, by the result card and constantly by tests, so it
   * reads state and computes; it never resolves a pending shot, never drains a
   * queue and never advances a counter.
   */
  score() {
    const ratio = clamp(this.points / PAR, 0, 1);
    const headline = ratio >= 0.95 ? 'Dead eye'
      : ratio >= 0.7 ? 'Steady hand'
        : ratio >= 0.4 ? 'Fairground fair'
          : ratio >= 0.15 ? 'Wild rounds'
            : 'Cold barrel';
    const parts = [`${this.hits}/${this.shots} on target`, `${this.points} of ${PAR} pts`];
    if (this.goldenHits > 0) parts.push(`${this.goldenHits}x golden`);
    if (this.bystanderHits > 0) {
      parts.push(`${this.bystanderHits} bystander${this.bystanderHits > 1 ? 's' : ''}`);
    }
    return { ratio, headline, detail: parts.join(' · ') };
  }

  drainEvents() { const e = this._events; this._events = []; return e; }

  teardown() { this._events = []; }
}

/** @type {import('../contract.js').MinigameDef} */
export const LUCKY_SHOT_RITE = {
  id: 'luckyshot',
  name: 'Lucky Shot',
  hint: 'Shoot the rows — left, right or Space, and count your rounds',
  duration: DURATION,
  theme: 'luckyshot',
  eyebrow: 'Gallery',
  abandonNote: 'You left the gallery',
  // No `cursor`: the stylesheet's crosshair is exactly right for an aiming rite.
  create: () => new LuckyShotRite(),
};

export {
  LuckyShotRite, RAND_CALLS, AMMO, PAR, DURATION, END_HOLD,
  ROW_TABLE, PER_ROW, TARGETS, GOLDEN_MULT, BYSTANDER_VALUE, DOWN_TIME,
};
