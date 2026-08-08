/**
 * PLATFORMS — "plateforme type mario party".
 *
 * Twenty-eight stone dalles over a void. They crack, they shake, they go. You
 * and three rivals are standing on them, and the only verb is WHERE YOU STAND.
 *
 * THE ONE SENTENCE: the floor is being eaten by a collapse with a SHAPE, so the
 * ground next to you is usually going the same way you are — and the longer you
 * stand on stone that has started to tip, the more it costs to leave.
 *
 * WHAT THIS RITE USED TO BE, AND WHY IT IS NOT THAT ANY MORE. The fall order was
 * a uniform permutation and leaving a doomed plate was free. Both of those are
 * the same mistake in two places: they make the answer to every question the
 * same answer. Measured, the whole game reduced to "when your tile flashes, step
 * to one that is not flashing" — 75 % of plates had a surviving neighbour at
 * every wave, and a greedy bot, a competent player and a clumsy one scored 0.97
 * / 0.88 / 0.81 IDENTICALLY. Two outcomes, no middle, no reading.
 *
 * The two fixes are `THE COLLAPSE` (destination) and `THE SAG` (departure), and
 * they are load-bearing in that order — read those two blocks before any number
 * in this file. Together they move the gap between the best line of play and
 * "step to any live neighbour" from 0.09/0.04/0.02 to 0.23/0.24/0.27, and the
 * skill ladder from flat to 0.99 / 0.98 / 0.90 / 0.53 at wave 3.
 *
 * WHY THE MARKER IS NOT SNAPPED TO TILES. A tile-snapped marker turns every
 * decision into a discrete keypress that either lands or does not, and the
 * pressure of a falling-floor game is entirely in the half second where you are
 * committed and not yet across. Continuous movement makes "get off before it
 * goes" a timing act instead of a menu choice. Cost, named: the cell boundaries
 * are invisible mid-move, which is why the drawn gaps are PAINT ONLY — see
 * `cellAt`.
 *
 * THREE LEGIBILITY TIERS, because the crack warning is the whole game:
 *   settled   full plate, quiet.
 *   stressed  desaturated, a hairline seam, a slow tremble. STRESS_LEAD before
 *             the crack even starts. This is the planning horizon: without it the
 *             endgame — six tiles left, no lookahead — is a coin flip, and a coin
 *             flip is not a skill curve.
 *   cracking  loud. A fuse bar whose LENGTH is the time left, a hard colour flip
 *             from warn to danger at 60 %, an accelerating shake, seams that
 *             widen — and THE TIP: the plate drops out of its socket, rolls, and
 *             squashes, which is the sag the player is fighting made visible.
 *             The tip is the channel that survives colour blindness; see
 *             `#drawPlate`, where the old scheme's failure is written down.
 *
 * AND A PIT UNDER ALL OF IT. See `#drawVoid`. The rite's premise is height, and
 * until now nothing below the floor was drawn at all, so a plate that fell just
 * stopped existing and the player's own death read as a deleted sprite. The
 * shaft, the party lights in it, and the fact that everything which falls
 * RECEDES rather than translating off-stage are one fix, not three.
 *
 * DETERMINISM. Exactly RAND_CALLS draws from ctx.rand, in a frozen order, none
 * of them inside a branch. Everything cosmetic comes from a private mulberry32
 * seeded by the last of those draws. See docs/MINIGAMES.md §3.
 *
 * NO DOM, NO THREE, NO Math.random — the unit suite imports this in node.
 */

import { clamp, lerp, approxTextWidth } from '../contract.js';
import { mulberry32 } from '../../core/Rng.js';
import { SeededRivals, PER_RIVAL } from '../rivals.js';

// ---- the field --------------------------------------------------------------

/** 7 x 4 = 28. The count is the clock: every tile falls exactly once. */
const COLS = 7;
const ROWS = 4;
const TILES = COLS * ROWS;

/**
 * Cell pitch and the plate drawn inside it.
 *
 * PITCH is the PLAY size, TILE is the PAINT size. The gap between plates is not
 * a hole: a continuously-moving marker that fell through a 0.24-unit seam it
 * cannot see would be the single most unfair thing in this rite. One rule —
 * "the cell under you is gone or off the grid" — covers both a fallen tile and
 * the outer edge, and there is no third case to get wrong.
 */
const PITCH_X = 2.0;
const PITCH_Y = 1.62;
const TILE_W = 1.78;
const TILE_H = 1.40;

/** Grid centre, nudged down to leave the top strip for the survival readout. */
const GRID_CY = -0.25;
const HALF_W = (COLS * PITCH_X) / 2;   // 7.0
const HALF_H = (ROWS * PITCH_Y) / 2;   // 3.24

/** World units per second. See MOVE_BUDGET below for why this number. */
const SPEED = 4.4;

/**
 * The move budget, written down because it is the difficulty and not an accident.
 *
 * Crossing a cell costs PITCH_Y / SPEED = 0.37 s vertically, PITCH_X / SPEED =
 * 0.45 s horizontally — so a hop is always affordable inside one warning, and
 * the rite is never a dexterity test. What it costs is a COMMITMENT: for four
 * tenths of a second you are between two plates and the one you chose may light
 * up while you are crossing it. That is the whole tension, and it is why the
 * warning is long (WARN_EARLY) and several plates are live at once rather than
 * the reverse.
 */

// ---- the schedule -----------------------------------------------------------

/** Seconds before the first tile starts to crack. The starting gun. */
const FIRST_CRACK = 0.95;
/** Seconds held after the last tile goes, so the field is seen to empty. */
const END_HOLD = 0.5;
/** Interval between successive tile releases, wave 3 -> wave 53. */
const INTERVAL_EARLY = 0.85;
const INTERVAL_LATE = 0.42;

/**
 * How long a plate shows the loud tier before its support goes.
 *
 * MEASURED, AND THE FIRST TUNING PASS WAS WRONG. The warning started at 1.0 s
 * against a 0.85 s interval, so almost exactly ONE plate was cracking at any
 * moment out of twenty-eight. A scripted player that reacted only when the loud
 * tier lit, a tenth of a second late, and could see nothing beyond it, scored
 * 0.92 — identical to an omniscient one. That is not a difficulty curve, it is a
 * walking simulator: with one doomed plate among four neighbours, moving ANYWHERE
 * was correct and there was nothing to read.
 *
 * warn / interval is therefore roughly 2.8, so about three plates are live at
 * once and a neighbour is a real gamble. Early on that still barely bites — nine
 * safe plates surround you — and that is the intended ramp: pressure comes from
 * the field SHRINKING, not from the numbers changing. By 60 % of the run a
 * quarter of what is left is already condemned.
 */
const WARN_EARLY = 2.35;
const WARN_LATE = 1.30;

/**
 * Quiet-tier lead, as a multiple of the loud warning. The planning horizon.
 *
 * Kept just above 1 on purpose. It buys the player roughly two extra plates of
 * lookahead — enough that the endgame is read rather than guessed — without
 * marking a third of the field and turning the loud tier into wallpaper.
 */
const STRESS_LEAD = 1.55;

/**
 * The rite's own clock, which the host's `duration` must not undercut by much.
 *
 * At wave 3 the schedule wants 25.99 s and only gets 24, so two tiles are still
 * standing when the clock stops — the field never quite empties early on, which
 * is the correct kindness. At wave 53 it wants 13.94 s and ENDS THERE, because
 * a floor that has run out is not a game any more. The score's denominator is
 * `runLength`, the shorter of the two, so both cases are scored out of the run
 * the player actually got.
 */
const DURATION = 24;

/** Seconds of falling shown after the player is out, before the rite returns. */
const OUT_HOLD = 1.5;

// ---- the field of play ------------------------------------------------------

const RIVAL_COUNT = 3;

/**
 * Where everyone starts. Fixed, not drawn.
 *
 * The player takes the lower-middle cell and the rivals fan out around it, so
 * the opening frame reads as "four of us, one floor" with no seed-dependent
 * chance of two markers overlapping. The variety in this rite is the fall order;
 * spending rand on the spawn as well would buy a different picture for one
 * second and cost a fixed budget entry forever.
 */
const PLAYER_START = 2 * COLS + 3;                  // col 3, row 2
const RIVAL_STARTS = Object.freeze([COLS + 0, COLS + 6, 3]);   // (0,1) (6,1) (3,0)

/**
 * Hard cap on a ghost's hop list. A hop costs at least PITCH_Y / SPEED = 0.37 s
 * and the longest run is 26 s, so 96 is about 1.4x the worst real case — a bound
 * that cannot be reached rather than one that trims behaviour.
 */
const MAX_HOPS = 96;

/** Visual duration of a plate's plunge. Not gameplay: support is gone at t_gone. */
const FALL_VIS = 0.62;
/** Dust motes per fallen plate. Derived, never simulated — see `draw`. */
const DUST = 5;

/** Emit a `good` cue for leaving a doomed tile inside this window; `perfect` under half. */
const CLUTCH = 0.36;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, every wave, always.
 *
 * 28 for the collapse (see THE COLLAPSE below — three of them shape it, all
 * twenty-eight roughen it), 12 for the roster (RIVAL_COUNT x PER_RIVAL), 1 for
 * the private presentation seed. THE ORDER IS PART OF THE SEED CONTRACT: moving
 * the rival draw ahead of the collapse rerolls every existing run's floor.
 */
const RAND_CALLS = TILES + RIVAL_COUNT * PER_RIVAL + 1;

// ---- THE COLLAPSE -----------------------------------------------------------

/**
 * WHY THE FALL ORDER IS NOT A SHUFFLE ANY MORE. Read this before touching the
 * numbers under it.
 *
 * The first version dealt the fall order as a uniform permutation of 28 tiles.
 * That is the most obvious thing to write and it quietly deleted the game.
 * Measured: 0.4 s before a plate went, 75 % of plates had a 4-neighbour that
 * outlived them, IDENTICALLY AT EVERY WAVE — because a uniform permutation has
 * no geometry, so the odds that all four neighbours die before you are just
 * 1/(k+1) and no amount of `warn` or `interval` can move them. The consequence
 * was a rite with one line of play ("when your tile flashes, step to one that
 * isn't") and two outcomes: the author's greedy bot, a competent player and a
 * clumsy player all scored 0.97 / 0.88 / 0.81. A noisy skill sweep was FLAT from
 * skill 0.30 to 1.00. The `WARN_EARLY` retune documented below moved 0.92 to
 * 0.98 and fixed nothing, because the problem was never the warning — it was
 * that the DESTINATION was never scarce.
 *
 * So the floor is now eaten by THREE SPREADING BLOTS, and a plate's fall time is
 * its first-arrival time under them:
 *
 *     arrive[i] = min over blots of  distance(i, origin) / rate   + roughness
 *
 * Three consequences, and the third is the design:
 *
 *   1. NEIGHBOURS DIE TOGETHER. Adjacent plates have adjacent arrival times, so
 *      "an adjacent tile is safe" stops being a free 75 %. The number that
 *      matters — a neighbour that outlives you BY A HOP, i.e. one you can
 *      actually reach and then stand on — falls to roughly a third.
 *   2. ONE BLOT STARTS UNDER YOU. The player's own cell is an origin, so the
 *      first thing that happens is the ground opening at your feet and eating
 *      outward. That is the tutorial, and it is also what makes standing still
 *      worthless without a special case anywhere in the code.
 *   3. THE SAFE GROUND IS IN TWO PIECES, AND THEY ARE NOT WORTH THE SAME. Two
 *      of the three origins sit in far corners with DIFFERENT rates, so the
 *      last ground standing is a pocket in one corner and a smaller pocket in
 *      the other. A hill-climber that always steps to its longest-lived
 *      neighbour walks into whichever pocket is nearer and dies with it. The
 *      real question the rite now asks is "WHICH pocket, and do I leave now" —
 *      a commitment made ten seconds early, across ground that will be gone
 *      before you could change your mind. That is a second verb, and the first
 *      one the player cannot answer by looking at four tiles.
 *
 * This is a strictly harder floor than the shuffle, which is the point: the
 * ceiling is now ABOVE the greedy bot rather than equal to it.
 */

/**
 * The two non-player origins: a pair of far corners.
 *
 * A curated list rather than two draws, because the shape of the collapse is
 * the difficulty and a seed that happened to put both origins in the same
 * corner would deal a floor with one pocket and no decision in it. All four
 * entries are the same geometry under a reflection, so picking between them
 * with `occurrence` is STRUCTURAL VARIATION AND NOT DIFFICULTY — the run looks
 * different the second time the rite appears and is exactly as hard.
 */
const SCALES = Object.freeze([5.6, 3.2, 1.9, 1.25]);

/** Amplitude per scale. Long swells dominate; the short one only ruffles. */
const AMPS = Object.freeze([1.0, 0.62, 0.34, 0.19]);

/** How deep the well under the player's feet is, in units of the swell. */
const WELL = 1.55;
/** Radius of that well, in cells. */
const WELL_R = 1.5;

/** Per-plate jitter, in units of the swell. Keeps a ridge from arriving as a line. */
const ROUGH = 0.16;

// ---- THE SAG ----------------------------------------------------------------

/**
 * A CRACKED PLATE TIPS INWARD, AND LEAVING IT LATE COSTS YOU. Read this second.
 *
 * The collapse pattern above fixes WHERE you can go. It does not, on its own,
 * fix the other half of the diagnosis: that leaving a doomed plate was free.
 * Under the old rite the only two outcomes a scripted player could reach were
 * "walked off in time" and "did not move at all", because a hop cost a flat
 * 0.37 s against a warning of one to two seconds — so any departure, however
 * late, however fumbled, arrived. A rite where the margin is the same on the
 * first tenth as on the last tenth has no execution in it, and a calibration
 * sweep across four skill levels came back FLAT to three decimal places.
 *
 * So a plate that is coming apart sags toward its own centre, and anything
 * standing on it slides back in. The pull is zero while the plate is settled,
 * grows as the square of how far into `SAG_LEAD` the plate is, and never quite
 * reaches 1 — you can ALWAYS get off, it just costs more the longer you left
 * it. Crossing half a plate at 0.47 of pull takes twice what it takes at rest.
 *
 * WHY THIS AND NOT A SHORTER WARNING. A shorter warning moves the cliff; it
 * does not remove it. The sag turns the cliff into a slope: half a second of
 * hesitation is half a second of ground, a fumbled first step slides back to
 * where it started, and a player who reads the plate early crosses on flat
 * stone. That is a continuous cost function over exactly the axis a difficulty
 * curve is stated on, and it is the reason this rite can be measured at all.
 *
 * It is also the strongest thing on the screen: the plate visibly tips and the
 * marker visibly fights it, so the mechanic is never a hidden tax.
 */

/** Seconds before a plate goes at which the stone starts to tip. */
const SAG_LEAD = 2.0;
/** Peak pull as a fraction of SPEED, wave 3 -> wave 53. */
const SAG_EARLY = 0.85;
const SAG_LATE = 0.90;

/**
 * NOT EVERY SLAB TIPS THE SAME, AND THAT IS THE DIFFERENCE BETWEEN A CLIFF AND
 * A CURVE.
 *
 * Measured, and it cost three tuning passes to see. With one sag value for the
 * whole floor, every hop in a run is the same hop: the same lead, the same
 * distance, the same pull. So the sag does not make late departures RISKY, it
 * makes them IMPOSSIBLE — and a player half a second slow does not lose a bit
 * of ground, they die on their first forced move. The skill sweep went 0.99 /
 * 0.99 / 0.10 / 0.10 across four levels: a cliff at a hundredth of a pull, in
 * the same place for everybody, which is the exact failure this whole redesign
 * exists to remove.
 *
 * So each plate draws its own temper, from the same 28 numbers the collapse
 * pattern uses. Some stone holds until the last instant and lets you walk off
 * flat; some tips the moment it cracks and will not give you back. Now "how
 * late can I leave" has an answer per plate rather than one answer for the
 * rite, being half a second slow costs you a FRACTION of your hops instead of
 * all of them, and the run ends somewhere along a distribution.
 *
 * It is also the best information in the rite: the tilt is visible from the
 * first frame of the crack, so a player who looks can tell a plate that will
 * drop them from one that will not, and leave the bad one first. That is a read
 * the old rite did not have anywhere.
 */
const TEMPER_MIN = 0.30;
const TEMPER_MAX = 1.80;

/** Design-token fallbacks. Literals here, never in the draw code. */
function readPalette() {
  const cs = typeof getComputedStyle === 'function' && typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement)
    : null;
  const tok = (name, fallback) => (cs?.getPropertyValue(name) || '').trim() || fallback;
  return {
    ink: tok('--ink', '#e9ebf3'),
    ink2: tok('--ink-2', '#a3a9bb'),
    ink3: tok('--ink-3', '#6d7488'),
    ink4: tok('--ink-4', '#4a5064'),
    gold: tok('--gold', '#e5bd79'),
    goldHi: tok('--gold-hi', '#f7dfae'),
    danger: tok('--danger', '#ff5f57'),
    warn: tok('--warn', '#ffb454'),
    line: tok('--line-2', 'rgba(255,255,255,0.14)'),
    line3: tok('--line-3', 'rgba(255,255,255,0.26)'),
    /**
     * The stage accent, from `:root`.
     *
     * PREFIXED, and not the generic `--rite-accent`, which is declared inside
     * `#rite[data-rite="platforms"]` — an element a rite never gets a handle on,
     * so that lookup missed every time and the fallback was what painted. The
     * theme block aliases this one into the generic name for the chrome, so the
     * stage and the canvas are guaranteed to be the same purple by the
     * stylesheet rather than by two people remembering.
     */
    accent: tok('--rite-platforms-accent', '#b79cf0'),
  };
}

/** Centre of cell `i`, in field units. */
function cellX(i) { return ((i % COLS) - (COLS - 1) / 2) * PITCH_X; }
function cellY(i) { return GRID_CY + ((ROWS - 1) / 2 - Math.floor(i / COLS)) * PITCH_Y; }

/**
 * The cell under a point, or -1 for the void.
 *
 * Uses the full PITCH, not the drawn plate: the gap is paint. Off the grid
 * returns -1 too, so "walked off the edge" and "stood on a tile that went" are
 * the same sentence in `update` and cannot drift apart.
 */
function cellAt(x, y) {
  const c = Math.floor((x + HALF_W) / PITCH_X);
  const r = Math.floor((GRID_CY + HALF_H - y) / PITCH_Y);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return -1;
  return r * COLS + c;
}

/** 4-neighbours of `i`, written into `out`; returns how many. Fixed order: U R D L. */
function neighbours(i, out) {
  const c = i % COLS, r = (i / COLS) | 0;
  let n = 0;
  if (r > 0) out[n++] = i - COLS;
  if (c < COLS - 1) out[n++] = i + 1;
  if (r < ROWS - 1) out[n++] = i + COLS;
  if (c > 0) out[n++] = i - 1;
  return n;
}

class PlatformsRite {
  init(ctx) {
    this.wave = ctx.wave;
    this.quality = ctx.quality;
    this.palette = readPalette();

    const ws = clamp((ctx.wave - 3) / 50, 0, 1);
    this.interval = lerp(INTERVAL_EARLY, INTERVAL_LATE, ws);
    this.warn = lerp(WARN_EARLY, WARN_LATE, ws);
    this.sag = lerp(SAG_EARLY, SAG_LATE, ws);

    // ---- draw 1: the collapse (28) --------------------------------------
    // All twenty-eight up front, unconditionally, so the budget cannot depend
    // on anything. The first three also SHAPE the collapse; every one of them
    // roughens it. See THE COLLAPSE above.
    const u = new Float64Array(TILES);
    for (let i = 0; i < TILES; i++) u[i] = ctx.rand();

    // The four swells. Direction and phase per scale, eight draws, taken off
    // the front of the same block. The quarter-turn from `occurrence` is the
    // structural variation: the second time the rite appears the floor is the
    // same floor rotated, which is a different picture and exactly as hard.
    const turn = (ctx.occurrence | 0) * (Math.PI / 2);
    /** The collapse field, in arbitrary units. Only its RANK ORDER is used. */
    this.arrive = new Float64Array(TILES);
    const pc = PLAYER_START % COLS, pr = (PLAYER_START / COLS) | 0;
    for (let i = 0; i < TILES; i++) {
      const c = i % COLS, r = (i / COLS) | 0;
      let v = 0;
      for (let m = 0; m < SCALES.length; m++) {
        const th = u[2 * m] * Math.PI * 2 + turn;
        const ph = u[2 * m + 1] * Math.PI * 2;
        v += AMPS[m] * Math.sin(
          (2 * Math.PI / SCALES[m]) * (c * Math.cos(th) + r * Math.sin(th)) + ph,
        );
      }
      const d2 = ((c - pc) ** 2 + (r - pr) ** 2) / (WELL_R * WELL_R);
      this.arrive[i] = v - WELL * Math.exp(-d2) + u[i] * ROUGH;
    }

    /**
     * Each plate's own temper. Read off the same draws, walked with a stride so
     * a plate's tipping is not correlated with its place in the fall order —
     * otherwise "late in the collapse" and "treacherous" would be the same fact
     * and the player would only ever have one thing to read.
     */
    this.temper = new Float64Array(TILES);
    for (let i = 0; i < TILES; i++) {
      this.temper[i] = this.sag * lerp(TEMPER_MIN, TEMPER_MAX, u[(i * 11 + 7) % TILES]);
    }

    // Sorting the arrival field is what makes the release order a PERMUTATION:
    // every tile falls exactly once, and the count of releases is still the
    // length of the rite. The index tiebreak keeps it a total order, so two
    // clients that computed the same arrivals cannot disagree about the floor.
    const order = Array.from({ length: TILES }, (_, i) => i)
      .sort((a, b) => (this.arrive[a] - this.arrive[b]) || (a - b));

    /**
     * The player's own floor is first, always.
     *
     * The player's cell is already an ORIGIN, so it is at arrival distance zero
     * and would come first anyway but for its own roughness draw and the two
     * other origins, which also sit at zero. Forcing it is one swap, costs no
     * draw, and preserves the permutation. Two reasons, and the second is the
     * load-bearing one:
     *   - It is the tutorial. The first thing that happens in the rite is the
     *     ground under YOU cracking, one second in, and nobody needs the rule
     *     explained after that.
     *   - Without it, an idle player's death time is a uniform draw over the
     *     whole run — average ratio 0.37 — so "start it and look away" would be
     *     a third of a real score. The reward curve has no gate left
     *     (contract.js minigameReward), so the only thing making doing nothing
     *     worthless is the rite. This is that thing.
     */
    const at = order.indexOf(PLAYER_START);
    order[at] = order[0];
    order[0] = PLAYER_START;
    this.order = order;

    /** When each CELL's support vanishes, indexed by cell. */
    this.gone = new Float64Array(TILES);
    for (let k = 0; k < TILES; k++) {
      this.gone[order[k]] = FIRST_CRACK + k * this.interval + this.warn;
    }

    const lastGone = FIRST_CRACK + (TILES - 1) * this.interval + this.warn;
    /** The scored denominator: the run the player actually got. */
    this.runLength = Math.min(lastGone + END_HOLD, DURATION);

    // ---- draw 2: the roster (12) ----------------------------------------
    this.rivals = new SeededRivals(ctx.rand, { count: RIVAL_COUNT, wave: ctx.wave });

    // ---- draw 3: the presentation seed (1) -------------------------------
    // Everything below this line is cosmetic and MUST come from here. A single
    // ctx.rand() for an unbounded amount of noise is the whole trick.
    const nz = mulberry32(Math.floor(ctx.rand() * 0xffffffff) >>> 0);
    /** Per-tile plunge character: tilt, spin, and a phase for the tremble. */
    this.tilt = new Float64Array(TILES);
    this.phase = new Float64Array(TILES);
    /** DUST offsets per tile, packed [ax, ay, ...]. Read in draw, never written. */
    this.dust = new Float64Array(TILES * DUST * 2);
    for (let i = 0; i < TILES; i++) {
      this.tilt[i] = (nz() - 0.5) * 1.5;
      this.phase[i] = nz() * Math.PI * 2;
      for (let d = 0; d < DUST; d++) {
        this.dust[(i * DUST + d) * 2] = (nz() - 0.5) * TILE_W;
        this.dust[(i * DUST + d) * 2 + 1] = (nz() - 0.5) * TILE_H;
      }
    }

    // ---- the ghosts ------------------------------------------------------
    this.paths = [];
    this.rivalOut = new Float64Array(RIVAL_COUNT);
    for (let id = 0; id < RIVAL_COUNT; id++) {
      this.paths.push(this.#walkGhost(id));
    }
    /** One flag per rival, so `claim` fires exactly once each. */
    this._outEmitted = new Uint8Array(RIVAL_COUNT);

    // ---- the player ------------------------------------------------------
    this.t = 0;
    this.stepDt = 1 / 60;
    this.px = cellX(PLAYER_START);
    this.py = cellY(PLAYER_START);
    /** Facing, for the lean. Held through a stop rather than reset to zero. */
    this.fx = 0;
    this.fy = -1;
    this.cell = PLAYER_START;
    /** How hard the plate under you is currently reclaiming you. Drawn, not stored logic. */
    this.pull = 0;
    /** Whether the current plate has already announced its crack. */
    this._cracked = false;
    this.alive = true;
    /** Frozen at the instant of elimination. The number the score is made of. */
    this.aliveFor = 0;
    this.outAt = Infinity;
    this._events = [];
    this._events.push({ type: 'start' });
  }

  /**
   * Build a rival's hop list, once, in init.
   *
   * THE MODEL: a ghost walks toward whichever neighbouring cell survives
   * longest, and commits `lag` seconds before its own floor goes. A better rival
   * has a shorter lag, so it leaves earlier and more often makes it across —
   * which means the field thins in skill order without anything simulating a
   * decision. It reacts to the same fall schedule the player is reading, so it
   * looks alive because it IS looking at the same thing.
   *
   * Returned as a time-keyed polyline: knot k is (t, x, y), and consecutive
   * knots at the same position express a hold. Position at any time is one
   * lerp. Nothing here is stepped, so it is evaluable at any t in any order.
   *
   * TWO DEATHS, AND WHY BOTH. `SeededRivals.outAt(id)` is the PUBLISHED
   * elimination time and the interface a future NetworkRivals would implement,
   * so it is honoured as a cap. But a ghost whose lag ran out while its plate
   * dropped has visibly died on screen, and a marker that keeps walking on
   * nothing for four seconds because a formula says it is alive is the kind of
   * lie a player notices immediately. The effective time is the earlier of the
   * two, and the score reads the effective one — the number the player watched.
   */
  #walkGhost(id) {
    const r = this.rivals.roster()[id];
    const skill = r ? r.skill : 0.5;
    // 0.34 s at the top of the field, 0.96 s at the bottom. Compare MOVE_BUDGET:
    // a hop costs 0.37-0.45 s, so a low-skill ghost is committing later than it
    // can afford and dies to the same mistake a distracted player does.
    const lag = 0.34 + (1 - skill) * 0.62;
    const capped = this.rivals.outAt(id);

    const t = [0];
    const xs = [cellX(RIVAL_STARTS[id])];
    const ys = [cellY(RIVAL_STARTS[id])];
    const nb = new Int32Array(4);

    let cell = RIVAL_STARTS[id];
    let now = 0;
    let out = Infinity;

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const g = this.gone[cell];
      if (g > this.runLength) { out = Infinity; break; }        // outlasts the run
      const depart = Math.max(now, g - lag);
      if (depart >= g) { out = g; break; }                      // reacted too late
      if (depart >= capped) { out = capped; break; }

      let best = -1, bestGone = -Infinity;
      const n = neighbours(cell, nb);
      for (let k = 0; k < n; k++) {
        if (this.gone[nb[k]] > bestGone) { bestGone = this.gone[nb[k]]; best = nb[k]; }
      }
      if (best < 0) { out = g; break; }

      const nx = cellX(best), ny = cellY(best);
      // A ghost pays the same sag the player does, or it would glide off a
      // tipping plate the player is scrambling on — the one lie in this rite a
      // watcher would catch instantly. Half the crossing is fought (centre to
      // the seam), half is on the next plate, and the pull is read at departure.
      const d = Math.hypot(nx - xs[xs.length - 1], ny - ys[ys.length - 1]);
      const sk = clamp(1 - (g - depart) / SAG_LEAD, 0, 1);
      const eff = Math.max(0.08, 1 - this.temper[cell] * sk * sk);
      const arrive = depart + (d / 2) / (SPEED * eff) + (d / 2) / SPEED;
      t.push(depart, arrive);
      xs.push(xs[xs.length - 1], nx);
      ys.push(ys[ys.length - 1], ny);

      if (bestGone <= arrive) { out = arrive; break; }          // stepped onto nothing
      now = arrive;
      cell = best;
    }

    if (out > capped) out = capped;
    this.rivalOut[id] = out > this.runLength ? Infinity : out;
    return { t, x: xs, y: ys };
  }

  /** A ghost's position at `time`. Pure; safe to call from draw. */
  #ghostAt(id, time) {
    const p = this.paths[id];
    const n = p.t.length;
    if (time <= p.t[0]) return [p.x[0], p.y[0]];
    for (let k = 1; k < n; k++) {
      if (time <= p.t[k]) {
        const span = p.t[k] - p.t[k - 1];
        const u = span > 1e-6 ? (time - p.t[k - 1]) / span : 1;
        return [lerp(p.x[k - 1], p.x[k], u), lerp(p.y[k - 1], p.y[k], u)];
      }
    }
    return [p.x[n - 1], p.y[n - 1]];
  }

  update(dt, input) {
    this.t += dt;
    this.stepDt = dt;
    const t = this.t;

    // Rivals leaving the field. Announced once each, from a separate emitted
    // flag rather than by editing rivalOut: those times are read by score() on
    // every call, and a queue that consumes its own source data is a score that
    // depends on how many times the host asked.
    for (let i = 0; i < RIVAL_COUNT; i++) {
      if (this._outEmitted[i] || this.rivalOut[i] > t) continue;
      this._outEmitted[i] = 1;
      const [gx] = this.#ghostAt(i, this.rivalOut[i]);
      this._events.push({ type: 'claim', x: gx });
    }

    if (this.alive) {
      // ---- movement ------------------------------------------------------
      // The cell you are standing IN at the start of the step. Read before the
      // move, because the sag is a property of the stone under your feet and
      // not of the one you are about to reach.
      const from = this.cell;
      let ax = input.axis?.x ?? 0;
      let ay = input.axis?.y ?? 0;
      // Normalise so a diagonal is not 41 % faster. A rite whose optimal line is
      // "always hold two keys" has one control, not two.
      const m = Math.hypot(ax, ay);
      if (m > 1e-6) {
        ax /= m; ay /= m;
        this.fx = ax; this.fy = ay;
        this.px += ax * SPEED * dt;
        this.py += ay * SPEED * dt;
      }

      // ---- the sag -------------------------------------------------------
      // Constant-magnitude, always inward, never >= SPEED. See THE SAG. It is
      // applied unconditionally rather than only while a key is held, so the
      // plate genuinely reclaims you if you stop halfway across it.
      this.pull = 0;
      if (from >= 0) {
        const k = clamp(1 - (this.gone[from] - t) / SAG_LEAD, 0, 1);
        this.pull = this.temper[from] * k * k;
        const ox = this.px - cellX(from), oy = this.py - cellY(from);
        const od = Math.hypot(ox, oy);
        if (this.pull > 0 && od > 1e-6) {
          const s = Math.min(od, this.pull * SPEED * dt);
          this.px -= (ox / od) * s;
          this.py -= (oy / od) * s;
        }
      }

      // ---- the one rule --------------------------------------------------
      const under = cellAt(this.px, this.py);
      if (under !== this.cell) {
        if (under >= 0 && this.cell >= 0) {
          // Left a doomed plate at the last moment: worth hearing.
          const slack = this.gone[this.cell] - t;
          if (slack >= 0 && slack < CLUTCH) {
            this._events.push({ type: slack < CLUTCH / 2 ? 'perfect' : 'good', x: this.px });
          }
        }
        this.cell = under;
        if (under >= 0) this._cracked = this.gone[under] - this.warn <= t;
      }
      if (under < 0 || this.gone[under] <= t) {
        this.alive = false;
        this.aliveFor = t;
        this.outAt = t;
        this._events.push({ type: 'fail', x: this.px });
      } else if (!this._cracked && this.gone[under] - this.warn <= t) {
        // Your own floor just entered the loud tier. Silent-kick cue: this fires
        // once per plate you are standing on and a shove every time would be a
        // 24-second earthquake.
        this._cracked = true;
        this._events.push({ type: 'tick', x: this.px });
      }
    }

    // ---- plates going, heard rather than seen ----------------------------
    // Only the ones near you: 28 `break` cues in 14 seconds is noise, and the
    // ones that matter are the ones you could have been standing on.
    for (let i = 0; i < TILES; i++) {
      const g = this.gone[i];
      if (g > t - dt && g <= t) {
        if (Math.abs(cellX(i) - this.px) + Math.abs(cellY(i) - this.py) < 3.2) {
          this._events.push({ type: 'break', x: cellX(i) });
        }
      }
    }

    if (!this.alive && t >= this.outAt + OUT_HOLD) return true;
    if (t >= this.runLength) {
      if (this.alive) this.aliveFor = this.runLength;
      return true;
    }
  }

  // ---- drawing --------------------------------------------------------------

  /**
   * THE PERSPECTIVE. One function, and everything that leaves the floor uses it.
   *
   * The camera is over the middle of the pit, so a plate falling straight down
   * recedes toward the CENTRE OF THE GRID, not toward the bottom of the frame.
   * Depth `d` maps to a scale of 1/(1+d) about that point — the standard
   * pinhole shrink, which is why the shaft walls, the fallen plates and a dead
   * player all agree with each other without any of them being hand-placed.
   *
   * It is also the fix for the two worst things in the old frame. Things that
   * fall no longer translate to y = -7 and leave the stage: they get smaller and
   * further away, which is both what falling looks like from above and the only
   * way the drop can be SEEN at all inside a 16x9 field.
   *
   * @returns {[number, number, number]} projected x, y, and the scale at `d`.
   */
  static project(x, y, d) {
    const s = 1 / (1 + d);
    return [x * s, GRID_CY + (y - GRID_CY) * s, s];
  }

  draw(g, alpha = 0) {
    const t = this.t + alpha * this.stepDt;
    // EVERYTHING is clipped to the stage. The old draw let a dead marker travel
    // to world y = -7 with nothing to stop it, so the most dramatic moment in
    // the rite rendered as "the sprite was deleted" — and the stage is about to
    // get wider, which would have made the off-field geometry visible instead
    // of merely absent. One clip, at the top, for the whole frame.
    g.clipField(() => this.#paint(g, t));
  }

  #paint(g, t) {
    this.#drawVoid(g, t);

    // Plates that have already released, drawn FIRST so standing stone occludes
    // them on the way down. That single ordering is most of why a fall reads as
    // "below the floor" rather than "in front of it".
    for (let i = 0; i < TILES; i++) {
      const u = (t - this.gone[i]) / FALL_VIS;
      if (u <= 0 || u >= 1) continue;
      this.#drawFalling(g, i, u);
    }

    for (let i = 0; i < TILES; i++) {
      if (this.gone[i] <= t) continue;
      this.#drawPlate(g, i, t);
    }

    // Dust hangs where the plate was, after it has gone. Purely derived from
    // (t - gone) and the baked offsets — no pool, no simulation, nothing to
    // leak, and it survives a paused frame without drifting.
    g.save().add();
    for (let i = 0; i < TILES; i++) {
      const age = (t - this.gone[i]) / 0.75;
      if (age <= 0 || age >= 1) continue;
      const x0 = cellX(i), y0 = cellY(i);
      const a = (1 - age) * 0.5;
      for (let d = 0; d < DUST; d++) {
        const ox = this.dust[(i * DUST + d) * 2];
        const oy = this.dust[(i * DUST + d) * 2 + 1];
        g.circle(x0 + ox * (1 + age * 0.5), y0 + oy - age * 0.5,
          0.09 * (1 - age * 0.6), { fill: `rgba(184,170,208,${a.toFixed(3)})` });
      }
    }
    g.restore();

    for (let id = 0; id < RIVAL_COUNT; id++) this.#drawRival(g, id, t);
    this.#drawPlayer(g, t);
    this.#drawHud(g, t);
  }

  /**
   * WHAT IS UNDER THE FLOOR, which until now was nothing at all.
   *
   * The premise of the rite is height — a party floor slung over a drop, with
   * lights swinging above it. The old frame had none of that: a plate that fell
   * simply stopped existing, the holes it left were the same flat background as
   * the margins, and the whole thing read closer to a memory game than to a
   * falling-floor game. A player was being asked to fear something that was not
   * drawn.
   *
   * So the grid footprint is a SHAFT: six rectangles receding on `project`, each
   * darker and fainter than the last, four corner lines running down to the
   * vanishing point, and the party lights pooling on the walls. Standing plates
   * cover it, the seams between them show a hairline of it, and a hole shows all
   * of it — which means the floor emptying is now the shaft OPENING, and the
   * dread is in the picture instead of in the docblock.
   *
   * All of it is a pure function of `t` and the baked noise. No state, nothing
   * to leak, and a paused frame is the same frame.
   */
  #drawVoid(g, t) {
    const p = this.palette;
    const DEPTHS = [0.16, 0.42, 0.82, 1.45, 2.5, 4.4];

    g.save();
    for (let k = 0; k < DEPTHS.length; k++) {
      const s = 1 / (1 + DEPTHS[k]);
      const a = 0.34 + 0.11 * k;
      g.rect(0, GRID_CY, HALF_W * 2 * s, HALF_H * 2 * s, {
        fill: `rgba(${Math.round(13 - k)},${Math.round(10 - k * 0.8)},${Math.round(22 - k * 2)},${a.toFixed(3)})`,
      });
      g.rect(0, GRID_CY, HALF_W * 2 * s, HALF_H * 2 * s, {
        stroke: `rgba(150,140,190,${(0.10 - k * 0.014).toFixed(3)})`, width: 0.02,
      });
    }
    // The four corners of the well, run down to the vanishing point. Two lines
    // of geometry and they are most of why the nested rects read as one hole
    // rather than as a stack of frames.
    const sN = 1 / (1 + DEPTHS[DEPTHS.length - 1]);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        g.line(sx * HALF_W, GRID_CY + sy * HALF_H,
          sx * HALF_W * sN, GRID_CY + sy * HALF_H * sN,
          'rgba(150,140,190,0.09)', 0.02);
      }
    }

    // THE PARTY LIGHTS. Three of them, sweeping the walls of the pit on a slow
    // irrational-ish beat so the pattern never obviously repeats. They are the
    // only reason the shaft has any colour, and they are what makes the rite's
    // eyebrow — "Party" — true of the picture.
    g.save().add();
    const lights = [
      ['183,156,240', 0.37, 0.0],
      ['229,189,121', 0.29, 2.1],
      ['120,196,214', 0.23, 4.3],
    ];
    for (let k = 0; k < lights.length; k++) {
      const [rgb, sp, ph] = lights[k];
      const lx = Math.sin(t * sp + ph) * HALF_W * 0.78;
      const ly = GRID_CY + Math.cos(t * sp * 0.63 + ph * 1.7) * HALF_H * 0.72;
      const d = 0.5 + 0.35 * Math.sin(t * sp * 0.4 + ph);
      const [px, py, s] = PlatformsRite.project(lx, ly, d);
      g.halo(px, py, 2.9 * s, rgb, 0.16 + 0.05 * Math.sin(t * 1.7 + ph));
    }
    g.restore();
    g.restore();
  }

  /** A standing plate, in one of the three legibility tiers. */
  #drawPlate(g, i, t) {
    const p = this.palette;
    const x = cellX(i), y = cellY(i);
    const left = this.gone[i] - t;
    const cracking = left <= this.warn;
    const stressed = !cracking && left <= this.warn * STRESS_LEAD;

    // The tremble. Amplitude and FREQUENCY both ramp — a plate about to go
    // buzzes rather than sways, and peripheral vision reads frequency long
    // before it reads hue.
    let sx = 0, sy = 0;
    if (cracking) {
      const k = 1 - left / this.warn;
      const amp = 0.05 * k * k;
      const f = 17 + 36 * k;
      sx = Math.sin(t * f + this.phase[i]) * amp;
      sy = Math.cos(t * f * 1.31 + this.phase[i] * 1.7) * amp;
    } else if (stressed) {
      const k = 1 - (left - this.warn) / (this.warn * (STRESS_LEAD - 1));
      sx = Math.sin(t * 6.5 + this.phase[i]) * 0.012 * k;
    }

    const hot = cracking && left <= this.warn * 0.4;

    /**
     * THE TIP. The sag, drawn — and the redundant channel the colour scheme
     * failed on.
     *
     * Under deuteranopia the old frame lost its primary signal completely: the
     * hot plate's `--danger` red and the cracking plates' `--warn` amber
     * collapse onto the same yellow, and the surviving cue was a two-pixel
     * difference in fuse length. Playable, barely, and only because the fuse
     * was there.
     *
     * The tip is the answer, and it is not a decoration bolted on for the test:
     * it is the SAG the player is fighting in `update`, so the strongest visual
     * on a doomed plate is the mechanic itself. It costs nothing to read — a
     * plate that has dropped and squashed is a different SHAPE, at any distance,
     * in any colour vision, on a monochrome screen. Re-verified on a simulated
     * deuteranope frame rather than asserted; the tilt and the drop survive it
     * and are what the eye lands on.
     */
    const tip = cracking ? clamp(1 - left / SAG_LEAD, 0, 1) ** 2 : 0;
    const drop = tip * 0.30;
    const roll = tip * this.tilt[i] * 0.13;

    // The gap the plate has dropped out of. Drawn first, at the plate's ORIGINAL
    // seat, so the tip reads as the stone leaving its socket.
    if (tip > 0.02) {
      g.rect(0 + x, y, TILE_W, TILE_H, {
        fill: `rgba(4,3,9,${(0.55 * tip).toFixed(3)})`, radius: 0.18,
      });
    }

    g.save().translate(x + sx, y + sy - drop);
    g.rotate(roll);
    g.scale(1, 1 - tip * 0.10);

    // Body. A vertical ramp reads as a lit slab from above; flat fill reads as
    // a UI rectangle, which is exactly what this must not look like. The hot
    // tier goes DARKER, not redder, so the bright rim below has something to be
    // bright against on a screen with no red in it.
    const body = g.linearFill(0, TILE_H / 2, 0, -TILE_H / 2, hot
      ? [[0, 'rgba(70,44,46,0.98)'], [1, 'rgba(24,16,20,0.98)']]
      : cracking
        ? [[0, 'rgba(96,74,74,0.98)'], [1, 'rgba(44,32,38,0.98)']]
        : stressed
          ? [[0, 'rgba(78,74,92,0.97)'], [1, 'rgba(36,34,46,0.97)']]
          : [[0, 'rgba(104,104,126,0.98)'], [1, 'rgba(46,46,62,0.98)']]);
    g.rect(0, 0, TILE_W, TILE_H, { fill: body, radius: 0.18 });

    // Rim. Colour flips HARD from warn to danger at 60 % of the crack rather
    // than lerping: a discrete change is a far stronger glance signal than a
    // gradient, and there is no colour-mixing code to get wrong.
    //
    // AND THE HOT RIM IS DOUBLE. `--danger` (luminance ~0.47) is DARKER than
    // `--warn` (~0.75), so with hue removed the hot plate was the QUIETER of the
    // two — the signal was not merely lost, it was inverted. A white-hot inner
    // hairline puts the hot tier at the top of the luminance range where it
    // belongs, and a trichromat still reads it as red with a molten core.
    g.rect(0, 0, TILE_W, TILE_H, {
      stroke: cracking ? (hot ? p.danger : p.warn) : stressed ? p.ink4 : p.line3,
      width: cracking ? (hot ? 0.085 : 0.05) : 0.028,
      radius: 0.18,
    });
    if (hot) {
      g.rect(0, 0, TILE_W - 0.07, TILE_H - 0.07, {
        stroke: 'rgba(255,246,240,0.92)', width: 0.03, radius: 0.15,
      });
    }

    if (stressed) {
      // One hairline seam. Quiet on purpose — this tier is information, not alarm.
      g.line(-TILE_W * 0.3, TILE_H * 0.16, TILE_W * 0.22, -TILE_H * 0.2,
        'rgba(255,255,255,0.13)', 0.022);
    }

    if (cracking) {
      const k = 1 - left / this.warn;
      const col = hot ? p.danger : p.warn;
      // Three seams spreading from the centre. Their LENGTH is the progress,
      // so the plate is readable with the colour channel removed entirely.
      const s = 0.24 + 0.62 * k;
      g.line(0, 0, -TILE_W * 0.46 * s, TILE_H * 0.4 * s, col, 0.026 + 0.026 * k);
      g.line(0, 0, TILE_W * 0.44 * s, TILE_H * 0.26 * s, col, 0.026 + 0.026 * k);
      g.line(0, 0, TILE_W * 0.1 * s, -TILE_H * 0.48 * s, col, 0.026 + 0.026 * k);

      // THE FUSE. Length is literally the time left. This is the primitive the
      // whole rite is read through, so it gets its own track and sits at the
      // bottom of the plate where four of them in a row are still one glance.
      //
      // It is also the only cue that survived the dichromat frame intact, so it
      // now gets the room to do that job properly: the hot tier's bar is nearly
      // twice as TALL, and the track carries a tick at the 40 % mark where the
      // tier flips, so "past the tick" is a position and not a hue.
      const barW = TILE_W * 0.68;
      const by = -TILE_H * 0.34;
      const barH = hot ? 0.16 : 0.09;
      g.rect(0, by, barW, barH, { fill: 'rgba(0,0,0,0.5)', radius: barH / 2 });
      g.line(-barW / 2 + barW * 0.4, by - barH * 0.9, -barW / 2 + barW * 0.4, by + barH * 0.9,
        'rgba(255,255,255,0.34)', 0.022);
      const w = barW * (left / this.warn);
      if (w > 0.02) {
        g.rect(-(barW - w) / 2, by, w, barH,
          { fill: hot ? 'rgba(255,246,240,0.95)' : col, radius: barH / 2 });
      }
      g.save().add();
      g.halo(0, 0, TILE_W * 0.8, hot ? '255,95,87' : '255,180,84', 0.06 + 0.14 * k);
      g.restore();
    }

    g.restore();
  }

  /**
   * A plate on its way down the shaft. Weight leaving, not an object deleted.
   *
   * Gravity in DEPTH, not in y. The old version accelerated the plate downward
   * in world units and it was 3.9 units below the field half a second in — off
   * the bottom of a 9-unit stage, so the last third of every fall was drawn
   * outside the picture. Here the same quadratic drives `project`, so the plate
   * shrinks into the pit and stays in frame for all of it.
   */
  #drawFalling(g, i, u) {
    const d = 5.0 * u * u;
    const [x, y, s] = PlatformsRite.project(cellX(i), cellY(i), d);
    g.save();
    g.alpha(1 - u * u * u);
    g.translate(x, y);
    g.rotate(this.tilt[i] * u * u);
    g.scale(s);
    g.rect(0, 0, TILE_W, TILE_H, { fill: 'rgba(30,26,42,0.95)', radius: 0.18 });
    g.rect(0, 0, TILE_W, TILE_H, { stroke: 'rgba(255,95,87,0.42)', width: 0.05, radius: 0.18 });
    g.restore();
  }

  /**
   * A rival marker plus its name.
   *
   * The name is the point — "you outlived Kavi" is only worth 0.25 of the score
   * if the player knows which one Kavi was. It is plated (so it survives over a
   * bright plate), 0.3 units tall (so it is legible at a glance) and drawn at
   * 0.62 alpha with the plate at 0.5 (so four of them are not the loudest thing
   * on the field). `approxTextWidth` sizes the plate rather than `measureText`,
   * which would drag a live canvas into logic the unit suite runs in node.
   */
  #drawRival(g, id, t) {
    const p = this.palette;
    const r = this.rivals.roster()[id];
    if (!r) return;
    const out = this.rivalOut[id];
    const dead = out <= t;
    const [x, y] = this.#ghostAt(id, dead ? out : t);

    if (dead) {
      const u = clamp((t - out) / 0.9, 0, 1);
      if (u >= 1) return;
      const [fx, fy, s] = PlatformsRite.project(x, y, 6 * u * u);
      g.save().alpha((1 - u * u) * 0.75).translate(fx, fy).scale(s);
      g.rotate(u * 1.4);
      this.#marker(g, p.ink4, p.ink3, 0.9);
      g.restore();
      return;
    }

    g.save().translate(x, y);
    g.save().add();
    g.halo(0, -0.12, 0.62, '163,169,187', 0.14);
    g.restore();
    this.#marker(g, p.ink2, p.ink4, 1);
    g.restore();

    this.#label(g, r.name, x, y + 0.72, p.ink2, 0.62);
  }

  /**
   * You. Gold, ringed, haloed — and labelled, so colour is never the only cue.
   *
   * THE FALL IS THE POINT NOW. It used to be a translate of `0.5 * 22 * (u *
   * 1.5)^2` — twenty-four world units down a nine-unit stage — with no clip
   * under it, so within four frames the marker was gone and the only thing left
   * saying what had happened was the word OUT at the top of the screen. The most
   * dramatic moment in the rite read as a deleted sprite.
   *
   * So the fall goes DOWN THE SHAFT, on the same `project` the plates use: the
   * marker recedes toward the middle of the pit, shrinking, spinning, trailing
   * the last of its own light, and it is still visible when the rite hands back.
   * The ring it leaves behind marks the exact stone that dropped you, and the
   * lights in the pit catch it on the way down. This is the one fix the void and
   * the death share, and neither works without the other.
   */
  #drawPlayer(g, t) {
    const p = this.palette;
    if (!this.alive) {
      const u = clamp((t - this.outAt) / OUT_HOLD, 0, 1);
      // The stone that dropped you: a ring at the exact spot, expanding once.
      const rw = clamp(u / 0.42, 0, 1);
      if (rw < 1) {
        g.save().add();
        g.circle(this.px, this.py, 0.4 + rw * 2.1, {
          stroke: `rgba(255,95,87,${(0.5 * (1 - rw)).toFixed(3)})`, width: 0.08 * (1 - rw) + 0.02,
        });
        g.restore();
      }
      const [fx, fy, s] = PlatformsRite.project(this.px, this.py, 7.5 * u * u);
      // A streak from where the floor was to where you are, so the eye is towed
      // down the shaft instead of having to find the marker again.
      g.save().add();
      g.line(this.px, this.py, fx, fy, `rgba(229,189,121,${(0.30 * (1 - u)).toFixed(3)})`, 0.1 * s + 0.02);
      g.halo(fx, fy, 1.5 * s, '229,189,121', 0.34 * (1 - u * u));
      g.restore();
      g.save().alpha(1 - u * u * u).translate(fx, fy).scale(s);
      g.rotate(u * 4.4);
      this.#marker(g, p.gold, p.ink4, 1);
      g.restore();
      return;
    }
    const bob = Math.sin(t * 7.5) * 0.035;
    g.save().translate(this.px, this.py + bob);
    g.save().add();
    g.halo(0, -0.1, 0.95, '229,189,121', 0.3);
    g.restore();
    g.circle(0, -0.02, 0.44, { stroke: p.goldHi, width: 0.035 });
    // A lean into the direction of travel, and a HARDER lean while the stone
    // under you is tipping — the sag has to be visible on the body as well as
    // on the plate, or a player losing ground to it cannot tell why.
    g.rotate(-this.fx * 0.22 - this.pull * 0.34);
    this.#marker(g, p.gold, p.goldHi, 1);
    g.restore();
    this.#label(g, 'YOU', this.px, this.py + 0.76, p.goldHi, 0.85);
  }

  /** The shared body: a capsule and a head, so all four read as the same species. */
  #marker(g, fill, rim, a) {
    g.save().alpha(a);
    g.capsule(0, -0.26, 0, 0.02, 0.15, { fill, stroke: rim, width: 0.028 });
    g.circle(0, 0.2, 0.15, { fill, stroke: rim, width: 0.028 });
    g.restore();
  }

  #label(g, str, x, y, fill, a) {
    const size = 0.3;
    const w = approxTextWidth(str, size) + 0.22;
    g.save().alpha(a);
    g.rect(x, y, w, 0.4, { fill: 'rgba(6,5,12,0.62)', radius: 0.12 });
    g.text(str, x, y, { size, fill, tracking: 0.03 });
    g.restore();
  }

  /**
   * ONE CLOCK, AND IT IS THE FLOOR.
   *
   * The old readout put `3.6s ALIVE` counting UP in the top-left, six inches
   * from the host's `23.4` counting DOWN in the chrome. Two clocks disagreeing
   * about which way time runs, in one frame, and the player has to work out that
   * they are measuring the same run from opposite ends. So the rite gives up its
   * timer: what it counts instead is STONE, which is the only thing on screen
   * that is both the difficulty and the duration — it runs out exactly when the
   * run does, in the same direction as the host's number, and it is made of the
   * thing the player is standing on rather than of an abstraction.
   *
   * The bar is nailed to its own label rather than floating at the bottom of the
   * frame in dead space, and it is no longer the only accent-coloured object in
   * the picture: the lights in the pit are the same purple, so it now belongs to
   * a scheme instead of being a stray.
   *
   * The seconds survive, in one place: the result line after you are out, where
   * the number stops being a clock and becomes the score.
   */
  #drawHud(g, t) {
    const p = this.palette;
    const outlived = this.outlived();

    let left = 0;
    for (let i = 0; i < TILES; i++) if (this.gone[i] > t) left++;

    g.text(`${left}`, -7.5, 3.95, {
      size: 0.66, fill: this.alive ? p.goldHi : p.ink3, align: 'left', weight: 600,
    });
    g.text(`OF ${TILES} STANDING`, -6.85, 4.06, {
      size: 0.26, fill: p.ink3, align: 'left', tracking: 0.1,
    });
    const barW = 4.2;
    const bx = -7.5 + barW / 2;
    g.rect(bx, 3.44, barW, 0.13, { fill: 'rgba(255,255,255,0.09)', radius: 0.065 });
    const w = barW * (left / TILES);
    if (w > 0.02) g.rect(-7.5 + w / 2, 3.44, w, 0.13, { fill: p.accent, radius: 0.065 });

    let up = this.alive ? 1 : 0;
    for (let i = 0; i < RIVAL_COUNT; i++) if (this.rivalOut[i] > t) up++;
    g.text(`${up} STILL UP`, 7.5, 3.9, { size: 0.34, fill: p.ink2, align: 'right', tracking: 0.1 });
    g.text(`OUTLIVED ${outlived}/${RIVAL_COUNT}`, 7.5, 3.4, {
      size: 0.28, fill: outlived > 0 ? p.gold : p.ink4, align: 'right', tracking: 0.08,
    });

    if (!this.alive) {
      g.text('OUT', 0, 3.78, { size: 0.5, fill: p.danger, tracking: 0.24, weight: 600 });
      g.text(`${this.aliveFor.toFixed(1)}s ON YOUR FEET`, 0, 3.28, {
        size: 0.28, fill: p.ink3, tracking: 0.1,
      });
    }
  }

  // ---- scoring --------------------------------------------------------------

  /**
   * `0.75 x (alive / runLength) + 0.25 x (outlived / 3)`.
   *
   * The 0.75 term is the brief verbatim — "the longer you stay alive, the more
   * it pays" — and it is measured against the run the player actually got, not
   * against the host's 24 s, because at wave 53 the floor is gone by 13.9 s and
   * scoring a full survival as 58 % would be a lie.
   *
   * The 0.25 term is the only thing that makes the rivals matter. Without it the
   * three markers are scenery and the rite is single-player with decoration; with
   * it, "outlive one more of them" is a real, nameable goal in the last seconds —
   * and because every player on the seed faces the same three, it is the same
   * goal for both of them.
   */
  /** Seconds the player lasted. Frozen at elimination, capped at the run. */
  aliveTime() {
    return this.alive ? Math.min(this.t, this.runLength) : this.aliveFor;
  }

  /** How many rivals went out strictly before the player did. */
  outlived(alive = this.aliveTime()) {
    let n = 0;
    for (let i = 0; i < RIVAL_COUNT; i++) if (this.rivalOut[i] < alive) n++;
    return n;
  }

  score() {
    const alive = this.aliveTime();
    const outlived = this.outlived(alive);
    const survival = clamp(alive / this.runLength, 0, 1);
    const ratio = clamp(0.75 * survival + 0.25 * (outlived / RIVAL_COUNT), 0, 1);
    return {
      ratio,
      headline: ratio >= 0.9 ? 'Last one standing'
        : ratio >= 0.66 ? 'Sure-footed'
          : ratio >= 0.4 ? 'Kept moving'
            : ratio >= 0.18 ? 'Went early'
              : 'Straight down',
      detail: `${alive.toFixed(1)}s of ${this.runLength.toFixed(1)}s · outlived ${outlived} of ${RIVAL_COUNT}`,
    };
  }

  drainEvents() { const e = this._events; this._events = []; return e; }
  teardown() { this._events = []; }
}

/** @type {import('../contract.js').MinigameDef} */
export const PLATFORMS_RITE = {
  id: 'platforms',
  name: 'Falling Platforms',
  hint: 'Move before the stone does — the longer you last, the more it pays',
  duration: DURATION,
  theme: 'platforms',
  eyebrow: 'Party',
  abandonNote: 'You stepped off before the floor did',
  // Steered, not aimed. A crosshair over a character is a promise the controls
  // do not keep.
  cursor: 'default',
  create: () => new PlatformsRite(),
};

export {
  PlatformsRite, RAND_CALLS, COLS, ROWS, TILES, RIVAL_COUNT,
  cellX, cellY, cellAt, neighbours,
};
