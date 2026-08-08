/**
 * "escape from gay heaven" — thread the corridor, touch nothing burning.
 *
 * A bone-white cloud corridor scrolls right to left. You are a mote of soul-
 * light threading through it. The corridor is crossed by bands of EMBER, and
 * every band you get past without being burned is a point.
 *
 * The name is kept verbatim, deliberately. It is the name the map used.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY (the rewrite of 2026-08)
 * ---------------------------------------------------------------------------
 *
 * The first version scored `survived / DURATION` under instant death with no
 * lives. That composition cannot produce a middle: the score IS
 * `min(time-to-first-error, 20) / 20`, so it collapses the moment the error
 * rate rises above near-zero. Measured against the shared reference player,
 * 0.30 units of aim noise — 1.9% of the field width — plus 67 ms of lag took a
 * run from 0.90 to 0.26, and a histogram of 144 mid-skill runs at wave 28 held
 * 94 below 0.10, 50 between 0.10 and 0.20, and NOT ONE above 0.20. It reported
 * a ratio and delivered a coin flip. Worse, from wave 43 on, trying paid less
 * than idling by less than one gold.
 *
 * THREE CHANGES, IN THE ORDER THEY MATTER.
 *
 * 1. THE SCORE IS BANDS CLEARED OUT OF BANDS PRESENTED. Not time. A band is
 *    CLEARED if it passed the mote's column without ever having touched it;
 *    PRESENTED is how many bands the course puts in front of the reference
 *    column inside the clock, and it is fixed at `init` — it does not shrink
 *    when the player dies. So one mistake costs exactly one band out of ~12 at
 *    wave 3 and ~22 at wave 53, and the score walks smoothly from 0 to 1
 *    instead of snapping. That is the whole mid-band.
 *
 *    IT ALSO CLOSES THE OLD "HANG BACK AT THE LEFT WALL" EDGE, which the
 *    previous version named and accepted. Loitering at the far left buys
 *    lookahead, but bands now reach you LATER, so fewer of them pass you inside
 *    the clock while the denominator stays where it was. Lookahead costs score.
 *
 * 2. THE MOTE HAS THREE LIVES AND AN I-FRAME FLASH. Instant permadeath is what
 *    made time-to-first-error the only measurable quantity in the rite. A hit
 *    now costs a life, marks that band unclearable, and grants `GRACE` seconds
 *    of invulnerability — extended until the mote is actually clear of pink, so
 *    one contact can never eat two lives. The run ends when the lives are gone,
 *    and the bands the player never got to are still in the denominator: dying
 *    early is severely punished without being an instant zero.
 *
 * 3. THE WAVE CURVE LEAVES ROOM FOR A HAND. `SWEEP_A` and `GATE_SPAN` now
 *    shrink with the wave and the reaction interval bottoms out higher. The
 *    worst gate→sweep transition at wave 53 used to demand 96% of the mote's
 *    speed budget — 4% of margin, and the author's own perfect bot died on 22
 *    of 24 seeds there. See `#buildCourse` for the arithmetic; the rule is that
 *    the worst demanded move never exceeds `SPEED_BUDGET` of `MOVE_SPEED`.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN DECISIONS THAT SURVIVED
 * ---------------------------------------------------------------------------
 *
 * 1. THE POINTER IS CLAMPED TO `MOVE_SPEED`. The mote CHASES the cursor at a
 *    fixed 7 u/s instead of being the cursor. Without that clamp the pointer is
 *    a teleport: you park the cursor in the next gap and the rite is over
 *    before it started, because no dodging game survives an instantaneous
 *    actuator. The clamp is the entire difficulty budget, so `axis` (arrow keys
 *    / WASD, normalised to the SAME top speed) is not a lesser control path —
 *    it is exactly as good, which is the only honest way to offer two.
 *
 * 2. EVERY HAZARD CARRIES A SECOND, NON-COLOUR SIGNAL, AND THE SIGNALS ARE THE
 *    ONES THAT WERE VERIFIED TO WORK. A dichromacy simulation of the shipped
 *    frame found that the black outline channel carries the whole shape under
 *    both protanopia and deuteranopia — that is kept and EXTENDED: the hazard
 *    is now one closed path per mass, stroked all the way round, so the outer
 *    boundary is outlined too. (It was not, before; roughly half the hazard
 *    perimeter was a pure hue edge.)
 *
 *    THE PULSE WAS A LIE AND IS NOW A RIM. The old pulse modulated outline
 *    width from 0.07 to 0.10 world units — 3.90 to 5.58 CSS px, a 1.68 px swing
 *    — plus the alpha of an already-faint additive halo. That is below
 *    perceptual threshold in motion, and it was billed in the comments as half
 *    the redundancy. It now modulates the ALPHA OF A BRIGHT INNER RIM drawn
 *    INSIDE the silhouette (`RIM_ALPHA_LO`..`RIM_ALPHA_HI`, a 0.70 swing on a
 *    0.16-unit band), which is a luminance change a player sees. The silhouette
 *    and the outline never move: a shape that breathes is a shape whose hitbox
 *    appears to breathe, and a hitbox that lies is worse than no signal at all.
 *
 *    THE FREQUENCY IS CHOSEN, NOT INHERITED. It was 4 Hz, which sits inside the
 *    3-5 Hz photosensitive band. Now that the pulse modulates AREA LUMINANCE
 *    rather than a line width, "almost certainly under the general-flash
 *    threshold" is no longer an argument worth leaning on, so it is set to
 *    `PULSE_HZ = 2.5` — below the 3 Hz floor of the flash guidance, still fast
 *    enough to read unambiguously as "the thing that is strobing".
 *
 *    The safe route is still drawn POSITIVELY in the cool accent (a light shaft
 *    through a gate's gap, a cool line down a sweep's throat), and chevrons on
 *    the hazard point at the way through — the signal that survives a
 *    black-and-white screenshot.
 *
 * 3. THE HAZARD HUE IS EMBER, NOT MAGENTA, AND THE HUE IS GAMEPLAY. `#ff4fd8`
 *    was not a colour this game owns: the board is warm sunlit greens and tans
 *    under obsidian-and-gold chrome, and screaming magenta over near-black was
 *    the hardest break of "does it look like the game it interrupts" in the six
 *    rites. Ember (`#ff8a3d`) is the same family as `--warn`/`--gold`, reads as
 *    the sun burning through the cloud, and — the reason it is safe — carries a
 *    relative luminance around 0.42 against a 0.01 sky, so the hazard is
 *    separated from everything else by VALUE first and hue second. It stays the
 *    only saturated warm hue on the stage; the cloud, the mote, the rails and
 *    the ribbon are bone-white and cool blue. See `#palette` for the hue rule
 *    and `heaven-rite.test.js` for the assertion that holds it.
 *
 * 4. THE FIRST BAND IS ALWAYS A SWEEP, AND A SWEEP COVERS THE WHOLE COLUMN.
 *    A sweep is a diagonal canyon: hazard above and below a gap whose centre
 *    ramps from one extreme of the corridor to the other as the band passes.
 *    Stand anywhere and you are inside it within a couple of seconds — which is
 *    what makes an idle run worth nothing on every wave — and, as an opener, it
 *    is the tutorial: it says FOLLOW THE GAP in one gesture and no words.
 *    `LEAD_IN` holds the whole schedule back so the opener arrives after the
 *    hint above the stage has been read, rather than 1.9 s into a 20 s rite.
 *
 * NO DOM, NO THREE, NO Math.random — the unit suite imports this in node.
 */

import { FIELD, clamp, lerp } from '../contract.js';
import { mulberry32 } from '../../core/Rng.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// The clock and the actuator
// ---------------------------------------------------------------------------

/** Seconds. Also `HEAVEN_RITE.duration`. */
const DURATION = 20;

/**
 * World units per second, and the single most load-bearing number here.
 *
 * Both control paths top out at exactly this. The pointer path moves the mote
 * TOWARD the cursor by at most `MOVE_SPEED * dt`; the keyboard path normalises
 * the 8-way `axis` to unit length first, so a diagonal is not 1.41x faster than
 * a cardinal — the classic free speed bug, and in a dodging game it is not
 * cosmetic, it is a strictly better control scheme for whoever notices.
 */
const MOVE_SPEED = 7;

/**
 * The fraction of `MOVE_SPEED` the hardest wave is allowed to demand.
 *
 * THIS IS THE CONSTRAINT THE OLD WAVE CURVE BROKE. At wave 53 the worst
 * gate→sweep transition asked for 96% of the mote's top speed, leaving 4% of
 * margin for a human hand — and an obstacle a player cannot clear does not read
 * as hard, it reads as broken. 0.72 leaves 28%: enough that a competent player
 * makes the move and a clumsy one sometimes does not, which is the band the
 * whole difficulty curve is built on. `#buildCourse` asserts the geometry
 * against it in a comment; the ceiling test in the calibration gate asserts it
 * for real.
 */
const SPEED_BUDGET = 0.75;

/** Collision radius of the mote. The drawn core is smaller; see `#drawMote`. */
const MOTE_R = 0.15;

/** Where the mote sits at t=0 and where it stays if nobody touches anything. */
const START_X = -2.2;
const START_Y = 0;

/** Mote travel limits. Inset from FIELD so the core never clips the letterbox. */
const PLAY_HW = FIELD.hw - 0.3;
const PLAY_HH = FIELD.hh - 0.18;

// ---------------------------------------------------------------------------
// The burn
// ---------------------------------------------------------------------------


/**
 * Seconds of invulnerability after a hit.
 *
 * EXTENDED UNTIL THE MOTE IS ACTUALLY CLEAR, which is the half that matters: a
 * fixed window expiring while the mote is still inside the same slab charges a
 * second life for one mistake, and a sweep is 8 units wide — up to 1.9 s to
 * pass. So `#grace` is refreshed to `ESCAPE_GRACE` for as long as anything is
 * overlapping, and the countdown only starts once the mote is in clear air.
 */
const GRACE = 1.1;
const ESCAPE_GRACE = 0.3;

// ---------------------------------------------------------------------------
// The course
// ---------------------------------------------------------------------------

/**
 * How many hazard bands the course HOLDS. Not how many the player sees.
 *
 * THE DENSITY RULE, AND IT IS A DETERMINISM RULE IN DISGUISE: `ctx.wave` makes
 * the rite harder by COMPRESSING THE SPAWN-TIME SCHEDULE, never by adding
 * entries. Every wave draws for all 30 bands; a low wave simply runs out of
 * clock around band 12 and the rest are never spawned. If difficulty added
 * bands instead, the number of `ctx.rand()` calls would depend on the wave,
 * two clients on one seed would draw different numbers of values, and every
 * layout after the first divergence would disagree. 30 is the ceiling: at wave
 * 53 the compressed schedule reaches band ~23 inside 20 s, with margin for the
 * per-band jitter.
 */
const BANDS = 30;

/** Draws per band: kind, centre, gap size, phase. See `RAND_CALLS`. */
const PER_BAND_DRAWS = 4;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, every wave, always.
 *
 * `BANDS * PER_BAND_DRAWS` for the course, plus ONE for the seed of the private
 * `mulberry32` that generates every cosmetic value (cloud puffs). That last
 * draw is the rule from docs/MINIGAMES.md §3: presentation noise never comes
 * off `ctx.rand` directly, or the number of values consumed starts depending on
 * the quality preset and the gameplay stream is poisoned from that point on.
 */
const RAND_CALLS = BANDS * PER_BAND_DRAWS + 1;

/** Band kinds. Small integers rather than strings: they are compared per band per step. */
const GATE = 0;
const SWEEP = 1;
const ORBS = 2;

/**
 * The six orderings of one triple, and the two of them that open on a sweep.
 *
 * Frozen at module scope so `#buildCourse` allocates nothing and so the set is
 * readable as a set: every course is a concatenation of these, which is what
 * makes "one of each kind per three bands" a property you can see rather than a
 * statistic you have to trust.
 */
const PERMS = Object.freeze([
  Object.freeze([GATE, SWEEP, ORBS]), Object.freeze([GATE, ORBS, SWEEP]),
  Object.freeze([SWEEP, GATE, ORBS]), Object.freeze([SWEEP, ORBS, GATE]),
  Object.freeze([ORBS, GATE, SWEEP]), Object.freeze([ORBS, SWEEP, GATE]),
]);
const SWEEP_FIRST = Object.freeze([PERMS[2], PERMS[3]]);

/** Where a band's leading edge appears. Outside PLAY_HW, so nothing pops in on the mote. */
const SPAWN_X = 8.4;
/** Where a band is done. Past the left edge by more than the widest band. */
const DESPAWN_X = -9.6;

/**
 * Seconds of empty sky before the first band's leading edge is released.
 *
 * The docs call the opening sweep the tutorial. At wave 53 the old schedule put
 * it on top of an idle mote 1.9 s into a 20 s rite — the rite was over before
 * the hint above the stage had been read. This is a flat offset applied to
 * every band, so it costs the same fraction of the course at every wave and
 * changes no gap, no speed and no spacing.
 */
const LEAD_IN = 0.75;

/** GATE: thickness of the pillar pair, in world units. */
const GATE_TH = 1.0;
/** GATE: how far the gap centre may sit from the middle. Wave-scaled; see `#buildCourse`. */
const GATE_SPAN_LO = 1.8;
const GATE_SPAN_HI = 1.7;

/**
 * SWEEP: horizontal extent, WAVE-SCALED, and it is the rite's main difficulty
 * dial rather than a layout convenience.
 *
 * The vertical speed a sweep demands is `2 * amp * scroll / w`, so widening the
 * band at the low waves makes the same excursion a gentle ramp and narrowing it
 * at the high waves makes it a scramble — with the gap's own height and the
 * throat's travel left alone. Doing it with `amp` instead would work on the
 * demanded speed and on the ANTI-SCENERY margin (see `SWEEP_CLEAR`) at the same
 * time, so an easier wave 3 would also mean a wave 3 whose sweeps stopped
 * covering the corridor, and an idle mote would start being paid.
 */
const SWEEP_W_LO = 8.0;
const SWEEP_W_HI = 6.5;
/** SWEEP: how far the throat's excursion must exceed the gap's own half-height. */
const SWEEP_CLEAR = 0.6;

/** SWEEP: the gap centre ramps between -A and +A across that width. Wave-scaled. */
const SWEEP_A_LO = 2.2;
const SWEEP_A_HI = 2.1;

/**
 * ORBS: the vertical spacing of the four-disc accordion, wave-scaled.
 *
 * The resting heights are `(j - 1.5) * spread`, so the stack is always centred
 * and always covers the corridor. It used to be a frozen [-3.3, -1.1, 1.1, 3.3]
 * with a wave-scaled radius, which made the WORST gap the same on every wave —
 * at wave 3 the free space between two discs was 0.31 units against a 0.15 mote,
 * i.e. the gentlest wave in the game asked for a 0.16-unit thread. Scaling the
 * spacing instead is what lets wave 3 be generous and wave 53 be mean with one
 * number.
 */
const ORB_SPREAD_LO = 3.05;
const ORB_SPREAD_HI = 2.4;
/** ORBS: bob frequency, Hz. Slow enough to read, fast enough to matter. */
const ORB_HZ = 0.55;
/** ORBS: x stagger, so the stack reads as four objects rather than one bar. */
const ORB_DX = 0.35;

// ---------------------------------------------------------------------------
// Feel
// ---------------------------------------------------------------------------

/** Clearance under which a pass counts as a near miss and fires `tick`. Once per band. */
const NEAR_MISS = 0.42;

/**
 * The accessibility pulse, in Hz, and it is CHOSEN rather than inherited.
 *
 * It was 4 Hz, which is inside the 3-5 Hz photosensitive band. That was
 * defensible only while the pulse modulated a line width — a couple of CSS
 * pixels, nowhere near the general-flash threshold — and that pulse was also
 * invisible, which is why it is now an area-luminance rim (see `#rim`). A
 * visible flash needs a defensible frequency, so: 2.5 Hz, under the 3 Hz floor
 * of the flash guidance, and still fast enough that "the thing that is
 * strobing" is instantly separable from "the thing that is not".
 */
const PULSE_HZ = 2.5;

/**
 * The inner rim: the pulse the player can actually see.
 *
 * Drawn INSIDE the silhouette, inset by `RIM_INSET`, `RIM_W` wide, at an alpha
 * that swings the full `RIM_ALPHA_LO`..`RIM_ALPHA_HI`. In world units 0.16 is
 * about 9 CSS px at 1600x900, and a 0.70 alpha swing on a bright warm band over
 * a mid-warm fill is a luminance change, not a width change. The old signal was
 * a 1.68 px swing on an outline and half an alpha point on an additive halo.
 */
const RIM_INSET = 0.13;
const RIM_W = 0.16;
const RIM_ALPHA_LO = 0.14;
const RIM_ALPHA_HI = 0.84;

/** The hard black outline, at a CONSTANT width. It is the shape, so it never moves. */
const OUTLINE_W = 0.085;

/** Ring-buffer length of the mote's comet trail. Fixed: this is the whole anti-growth story. */
const TRAIL = 16;

/** Cosmetic cloud puffs, and the per-quality budget for DRAWING them. */
const PUFFS = 30;
const PUFF_PTS = 9;
/**
 * How many of the puffs are CORRIDOR WALL rather than background stratum.
 *
 * Generated first, so the frame the `low` preset drops is always a background
 * stratum and never the corridor's own edge. Fourteen — seven a side — spaced
 * across the wrap span rather than scattered, because the fiction promises a
 * cloud CORRIDOR and eight puffs at random x form nothing at all. Contiguity is
 * what makes it a wall.
 */
const BANK_PUFFS = 14;

// ---------------------------------------------------------------------------

/**
 * Signed clearance from (x, y) to the nearest hazard edge of `b`, in world units.
 *
 * Negative means overlapping — a hit. `Infinity` means the band is not over that
 * x at all. ONE function for collision, for near-miss detection and for the
 * test's skilled strategy, because three implementations of "how close am I to
 * dying" is three chances for the hit box and the picture to disagree.
 *
 * Module scope rather than a method: it is a pure function of its arguments and
 * nothing else, and putting it here makes that unmissable.
 */
function bandClearance(b, x, y, t, scroll) {
  const bx = SPAWN_X + b.halfW - scroll * (t - b.t0);
  const dx = Math.abs(x - bx);
  if (dx > b.halfW + MOTE_R) return Infinity;

  if (b.kind === GATE) {
    // Hazard everywhere except the slot. Clearance is to whichever lip is closer.
    return Math.min(y - (b.gc - b.gh), (b.gc + b.gh) - y) - MOTE_R;
  }

  if (b.kind === SWEEP) {
    /**
     * `s` runs 0 at the band's LEFT edge to 1 at its right, and the gap centre
     * ramps -A*dir -> +A*dir across it.
     *
     * LEFT, NOT RIGHT, AND THE DIRECTION IS THE WHOLE POINT. The course scrolls
     * leftward toward a mote that is to its left, so the part of a band that
     * touches the player FIRST is its leftmost slice. Writing this the other way
     * round — which is what "leading edge" intuitively suggests — inverts the
     * ramp the player has to chase relative to the one they can see coming, and
     * the rite stays perfectly playable while feeling arbitrary. Cost: one
     * debugging session. `s` is therefore defined so that s=0 IS first contact.
     *
     * Clamped rather than extrapolated: outside the band the ramp is meaningless.
     */
    const s = clamp((x - (bx - b.halfW)) / b.w, 0, 1);
    const c = b.dir * b.amp * (2 * s - 1);
    return b.gh - Math.abs(y - c) - MOTE_R;
  }

  // ORBS: four discs on an accordion. Alternating phase (j * PI) means the gaps
  // between them open and close in opposition, so at every instant at least one
  // route through is open — verified by construction, not by hoping.
  let best = Infinity;
  for (let j = 0; j < 4; j++) {
    const oy = (j - 1.5) * b.spread + b.gc
      + b.bob * Math.sin(t * ORB_HZ * TAU + b.phase * TAU + j * Math.PI);
    const ox = bx + (j % 2 ? ORB_DX : -ORB_DX);
    const d = Math.hypot(x - ox, y - oy) - b.gh - MOTE_R;
    if (d < best) best = d;
  }
  return best;
}

/** Wrap a scrolling cosmetic x back into [-span/2, span/2). Pure; no accumulation. */
function wrapX(x, span) {
  const h = span / 2;
  return ((((x + h) % span) + span) % span) - h;
}

/**
 * Scratch point buffers for the sweep's two slabs, MUTATED IN PLACE at draw time.
 *
 * Module scope, not instance state, and that is not an accident: `draw()` must
 * not mutate the rite (the unit suite JSON-snapshots the instance around five
 * render passes), and a rite that allocates a fresh point array per band per
 * frame allocates megabytes a minute for a shape whose size never changes. The
 * same trade `OffroadRite` makes for its road strip.
 *
 * FOUR POINTS, NOT SIXTEEN SLICES. The old draw filled each slab as 16 vertical
 * rectangles, which put a visible ~0.5-unit pixel staircase on BOTH boundaries
 * of the primary hazard while the accent centreline drawn through the middle of
 * the same shape was perfectly smooth. There was never a curve to tessellate:
 * the throat centre is LINEAR in x, so each slab is a quadrilateral and one
 * `poly` draws it exactly, smooth, in one path — which also means it can be
 * stroked all the way round, so the outer boundary gets the black outline the
 * accessibility rule always claimed it had.
 */
const SWEEP_HI = [[0, 0], [0, 0], [0, 0], [0, 0]];
const SWEEP_LO = [[0, 0], [0, 0], [0, 0], [0, 0]];

class HeavenRite {
  init(ctx) {
    /**
     * Difficulty, entirely from `ctx.wave`, entirely as continuous lerps.
     *
     * Rites run on waves 3..53. `waveT` is clamped rather than trusted, because
     * the dev panel can launch any rite on any wave and a negative `waveT`
     * would hand out a slower-than-slowest scroll on wave 1.
     */
    /**
     * THE WARP, AND IT IS THERE FOR MONOTONICITY RATHER THAN FOR FEEL.
     *
     * Linear in the wave, every difficulty driver here (scroll, gap height,
     * throat amplitude, orb spacing) moved slowly for the first half of the run
     * and then fell off a shelf, so the measured curve was flat from wave 3 to
     * wave 23 and steep after it. Flat is the dangerous shape: the calibration
     * gate asserts that a fixed player never scores HIGHER on a later wave, and
     * over five seeds a flat stretch inverts on sampling noise alone — measured
     * at +0.046 between waves 13 and 23 against a 0.05 slack, i.e. passing by
     * accident. `** 0.66` front-loads the ramp so every ten waves cost roughly
     * the same, which is also what a player expects from a difficulty curve.
     */
    const waveT = Math.pow(clamp((ctx.wave - 3) / 50, 0, 1), 0.66);
    this.waveT = waveT;
    this.scroll = lerp(4.6, 7.6, waveT);
    /**
     * The reaction window between two bands, in seconds, AFTER their footprints
     * have been subtracted (see the schedule pass in `#buildCourse`).
     *
     * The floor was 0.72 and is now 0.86. That single number was most of the
     * wave-53 ceiling failure: the worst move a course can ask for is from one
     * extreme of a gate's span to the opposite mouth of a sweep, and dividing
     * that distance by 0.72 s demanded more speed than the mote has.
     */
    this.interval = lerp(0.90, 0.74, waveT);
    // Advisory only, and it may never reach gameplay (contract.js MinigameCtx).
    // It thins the cloud DRAW loop; see #drawSky.
    this.puffCount = ctx.quality === 'low' ? 18 : ctx.quality === 'medium' ? 24 : PUFFS;
    /**
     * `occurrence` IS NOT READ, AND THAT IS THE CORRECT ANSWER HERE.
     *
     * It already indexes `ctx.rand` (schedule.js `riteRng`), so the second
     * appearance of this rite is a different course for free — different kinds
     * in different orders at different heights. A rite only needs to read
     * `occurrence` when its SHAPE is fixed and only its coordinates come off the
     * seed; this one's shape comes off the seed too. Reading it to add, say, a
     * mirror on top would change nothing a player could name, and every extra
     * dependency on it is another thing that has to be proved not to move the
     * difficulty (contract.js MinigameCtx).
     */

    this.t = 0;
    this.over = false;
    this.endT = 0;

    this.grace = 0;
    this.hitT = -99;
    this.cleared = 0;
    this.burned = 0;
    this.started = false;

    this.mx = START_X;
    this.my = START_Y;
    // Previous step's position, for the draw-time interpolation. See #drawMote.
    this.pmx = START_X;
    this.pmy = START_Y;
    /** Last frame's clearance, for the draw layer's tension read. Never gameplay. */
    this.clearance = Infinity;

    this._events = [];

    // Fixed-size scratch. Nothing here ever grows; that is the whole reason the
    // fuzz test's "no unbounded growth" rule is satisfied by construction
    // rather than by a cap somewhere.
    this.trail = new Float64Array(TRAIL * 2);
    this.trailAt = 0;
    this.trailN = 0;
    this.ticked = new Uint8Array(BANDS);
    this.passed = new Uint8Array(BANDS);
    this.touched = new Uint8Array(BANDS);

    this.#buildCourse(ctx);
    /**
     * THE LAST DRAW, AND THE ONLY ONE PRESENTATION IS ALLOWED.
     *
     * Everything cosmetic downstream comes off `_fx`, never off `ctx.rand`. If
     * a puff drew from the gameplay stream, thinning the puffs on the `low`
     * preset would shift every hazard on the course — a difficulty change
     * caused by a graphics setting, which is the exact desync docs/MINIGAMES.md
     * §3 forbids.
     */
    this._fx = mulberry32(Math.floor(ctx.rand() * 0xffffffff) >>> 0);
    this.#buildClouds();
    this._palette = this.#palette();

    // Seed the trail so the first frame is not a single dot at the origin.
    for (let i = 0; i < TRAIL; i++) this.#pushTrail(this.mx, this.my);
  }

  /**
   * Lay out all 30 bands. EXACTLY `BANDS * PER_BAND_DRAWS` draws, in one loop,
   * with no branch between a draw and the next — the four values come off
   * `ctx.rand` unconditionally and are then INTERPRETED per kind. A `rand()`
   * inside an `if (kind === ...)` is the classic way to break determinism, and
   * it is invisible until two clients disagree about where the walls are.
   */
  #buildCourse(ctx) {
    this.bands = [];
    let perm = PERMS[0];

    /**
     * The two ranges that decide the worst move a course can demand, both
     * shrinking with the wave. THE ARITHMETIC, at wave 53:
     *
     *   worst transition   = GATE_SPAN_HI + SWEEP_A_HI = 1.75 + 2.10 = 3.85 u
     *   window             = interval floor            = 0.86 s
     *   demanded           = 3.85 / 0.86               = 4.48 u/s
     *   budget             = MOVE_SPEED * SPEED_BUDGET = 5.04 u/s      OK
     *
     *   sweep throat speed = 2 * SWEEP_A_HI * scroll / SWEEP_W
     *                      = 2 * 2.10 * 7.4 / 8        = 3.89 u/s       OK
     *
     * The old numbers were 2.4 + 2.9 = 5.3 u over 0.72 s = 7.36 u/s against a
     * 7 u/s mote — 105% of the budget on the transition and 96% once the
     * schedule's footprint subtraction is accounted for. That is why the
     * author's own perfect bot died on 22 of 24 seeds at wave 53, and no
     * scoring change could have fixed it.
     */
    const gateSpan = lerp(GATE_SPAN_LO, GATE_SPAN_HI, this.waveT);
    const sweepA = lerp(SWEEP_A_LO, SWEEP_A_HI, this.waveT);
    const sweepW = lerp(SWEEP_W_LO, SWEEP_W_HI, this.waveT);
    const orbSpread = lerp(ORB_SPREAD_LO, ORB_SPREAD_HI, this.waveT);

    for (let i = 0; i < BANDS; i++) {
      const kindRoll = ctx.rand();
      const cRoll = ctx.rand();
      const hRoll = ctx.rand();
      const phase = ctx.rand();

      /**
       * THE KIND COMES OUT OF A SHUFFLED TRIPLE, NOT OUT OF A PER-BAND ROLL.
       *
       * An independent roll per band was the obvious way and it is the wrong
       * one twice over. It deals runs — five sweeps in a row is a course three
       * times harder than five gates in a row, at the same wave — so seed-to-
       * seed spread swamped the wave signal, and the calibration gate's
       * "a later wave is never easier" rule was passing or failing on which
       * courses the five fixed seeds happened to draw. And a run of one kind is
       * not interesting to play: the whole point of having three verbs is that
       * they alternate.
       *
       * So the course is built in TRIPLES, each a permutation of the three
       * kinds: every three bands is one gate, one sweep and one accordion, in
       * an order the seed picks. The mix is identical on every seed and every
       * wave; only the arrangement varies. The first triple is drawn from the
       * two permutations that OPEN ON A SWEEP, which is how band 0 stays the
       * full-column opener without a special case that spends no roll.
       *
       * The roll is read on every band and used on every third, which keeps the
       * `ctx.rand` budget flat and visible — see RAND_CALLS.
       */
      if (i % 3 === 0) perm = (i === 0 ? SWEEP_FIRST : PERMS)[Math.min(
        (i === 0 ? SWEEP_FIRST : PERMS).length - 1,
        Math.floor(kindRoll * (i === 0 ? SWEEP_FIRST : PERMS).length),
      )];
      const kind = perm[i % 3];

      // Gap sizes tighten with the wave. The +-9% roll is what stops a course
      // from reading as a metronome; it is never enough to make a gap unfair,
      // and it is deliberately small — this rite's difficulty is meant to live
      // in `ctx.wave`, not in how lucky the seed was.
      const jitter = 0.91 + 0.18 * hRoll;
      const b = { kind, t0: 0, phase, halfW: 0, gc: 0, gh: 0, dir: 1, amp: sweepA, w: sweepW, bob: 0, spread: orbSpread };

      if (kind === GATE) {
        b.halfW = GATE_TH / 2;
        b.gh = lerp(1.25, 0.95, this.waveT) * jitter;
        /**
         * THE SLOT IS NEVER ON THE CENTRELINE, and this is a scoring rule as
         * much as a design one. A gate whose gap happens to sit where the mote
         * already is is not an obstacle, it is scenery — and with the score now
         * counting bands rather than seconds, a course full of scenery is a
         * course a player who walked away gets paid for. Measured: with a plain
         * uniform centre, an idle mote parked at y=0 cleared 30% of the course
         * on every wave, which is above the contract's idle ceiling on its own.
         * Pushing the slot clear of the middle by its own half-height means
         * EVERY gate demands a move, from anywhere.
         */
        const u = cRoll * 2 - 1;
        const side = u < 0 ? -1 : 1;
        b.gc = side * lerp(b.gh + 0.3, gateSpan, Math.abs(u));
      } else if (kind === SWEEP) {
        b.halfW = sweepW / 2;
        b.dir = cRoll < 0.5 ? 1 : -1;
        /**
         * THE THROAT ALWAYS OVERSHOOTS ITS OWN HEIGHT, by `SWEEP_CLEAR`.
         *
         * Same anti-scenery rule as the gate's off-centre slot, and it has to
         * be a CLAMP rather than a hope: with an unclamped roll the tallest
         * gaps left a mote parked on the centreline exposed for about 2% of the
         * band's width — 0.02 s, i.e. one and a bit fixed steps, so whether the
         * opener killed an idle run came down to sampling phase. 0.6 units of
         * overshoot puts the exposure at a quarter of the pass, which is a
         * moment a player can see and a moment a test can rely on.
         */
        b.gh = Math.min(lerp(1.50, 1.25, this.waveT) * jitter, b.amp - SWEEP_CLEAR);
      } else {
        b.gh = lerp(0.33, 0.68, this.waveT) * jitter;   // orb radius
        b.halfW = b.gh + ORB_DX;
        // Same rule as the gate, same reason: the accordion's middle gap is
        // never left sitting on the corridor centreline, or an idle mote parked
        // at y=0 is paid for half the orb bands it never dodged.
        const u = cRoll * 2 - 1;
        b.gc = (u < 0 ? -1 : 1) * lerp(0.95, 1.30, Math.abs(u));
        b.bob = lerp(0.14, 1.0, this.waveT);
      }

      this.bands.push(b);
    }

    /**
     * THE SCHEDULE, IN A SECOND PASS, AND THE FAIRNESS ARGUMENT LIVES HERE.
     *
     * Gap between band i and band i+1:
     *
     *     (halfW_i + halfW_{i+1}) / scroll   +   interval * (1 + 0.25 * jitter)
     *      ^ the two footprints, in seconds      ^ the wave-scaled reaction time
     *
     * The first term is not decoration. A sweep is 8 units wide, so its LEFT
     * edge — the edge that reaches the player first — arrives 4 units before
     * its centre. A schedule that spaced band centres by a flat multiple of
     * `interval` therefore gave the player a fraction of the advertised time to
     * get from a gate's slot to a sweep's mouth. Subtracting the footprints
     * makes the reaction window `interval` MEAN `interval`, at every wave, for
     * every pair of kinds.
     *
     * A SECOND PASS RATHER THAN ONE LOOP because the gap needs band i+1's width
     * before band i's time can be fixed. It also puts every `ctx.rand()` call
     * in the loop above and none down here, which makes the fixed budget a
     * property you can see rather than one you have to trace.
     *
     * The jitter is added to the INCREMENT and is non-negative, so it can only
     * push bands further apart. Applied to an absolute time it could reorder
     * two entries and stack a gate inside a sweep.
     */
    let t0 = LEAD_IN;
    for (let i = 0; i < BANDS; i++) {
      this.bands[i].t0 = t0;
      const next = this.bands[i + 1];
      if (!next) break;
      t0 += (this.bands[i].halfW + next.halfW) / this.scroll
        + this.interval * (1 + 0.25 * this.bands[i].phase);
    }

    /**
     * THE DENOMINATOR, FIXED HERE AND NEVER TOUCHED AGAIN.
     *
     * `presented` is how many bands the course puts fully past the REFERENCE
     * COLUMN (`START_X`) inside the clock. Fixed at layout time, not counted
     * during play, and that is the whole reason the score is honest: a player
     * who dies on band 4 of 18 is scored out of 18, not out of 4. Dying early
     * costs you every band you never met.
     *
     * The numerator is counted against the mote's ACTUAL column, so drifting
     * right meets bands sooner and drifting left meets fewer of them — which is
     * what puts a price on the "hang back at the wall for free lookahead" edge
     * the first version named and shrugged at. `score()` clamps the ratio at 1
     * so the right-hand drift cannot manufacture credit.
     */
    let presented = 0;
    for (const b of this.bands) {
      const clearT = b.t0 + (SPAWN_X + 2 * b.halfW - START_X + MOTE_R) / this.scroll;
      if (clearT <= DURATION) presented++;
    }
    // Never zero: `score()` divides by it, and a course that presents nothing
    // is a bug rather than a perfect run.
    this.presented = Math.max(1, presented);
  }

  /**
   * Cosmetic cloud puffs, from the PRIVATE generator.
   *
   * Point arrays are baked here in LOCAL space and the draw pass only
   * translates them. Two reasons, and the second is the one that bites: baking
   * keeps `draw` allocation-free at 60 Hz, and it keeps `draw` from touching
   * `this._fx` — advancing a generator inside `draw` would be a mutation in the
   * one method the contract says must not mutate, and it would make the picture
   * depend on how many frames happened to render.
   *
   * TWO KINDS, AND THE FIRST ONE IS THE FICTION. `BANK_PUFFS` of them are the
   * corridor's walls: SPACED ALONG THE WRAP SPAN, alternating top and bottom, so
   * consecutive puffs overlap and the two banks read as continuous cloud rather
   * than as scattered ovals. The rest are background strata at very low alpha.
   *
   * THE BANKS ARE OPAQUE, AND THAT IS THE FIX FOR THE SCALLOPING. The old banks
   * were eight ovals at alpha 0.50-0.72; two of them at 0.6 composite to 0.84,
   * so every overlap was a brighter lens with a countable petal edge and the
   * cloud read as a pile of translucent ellipses. Opaque fills UNION — the
   * silhouette of the mass is the outline of the union and nothing inside it is
   * visible at all. The form then comes from drawing the mass twice, once in a
   * shadow tone and once offset outward in the lit tone, which is a terminator
   * rather than a stack of alphas. See `#drawSky`.
   */
  #buildClouds() {
    const fx = this._fx;
    this.puffs = [];
    for (let i = 0; i < PUFFS; i++) {
      const bank = i < BANK_PUFFS;
      const side = i % 2 ? 1 : -1;
      const r = bank ? 1.5 + fx() * 1.1 : 0.9 + fx() * 1.8;
      const pts = [];
      for (let k = 0; k < PUFF_PTS; k++) {
        const a = (k / PUFF_PTS) * TAU;
        // Lobes on the outward side, flatter on the corridor side: a cloud bank
        // seen from inside the canyon has a soft crown and a level underside.
        const lobe = bank ? (0.78 + 0.42 * fx()) : (0.62 + 0.5 * fx());
        const rr = r * lobe;
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr * (bank ? 0.74 : 0.62)]);
      }
      const span = FIELD.w + 8;
      this.puffs.push({
        // Banks: evenly spaced across the wrap span with a light jitter, which
        // is what makes them contiguous. Strata: anywhere.
        x: bank
          ? -span / 2 + ((i >> 1) + 0.5) * (span / (BANK_PUFFS / 2)) + (fx() * 2 - 1) * 0.9
          : (fx() * 2 - 1) * 9,
        y: bank
          ? side * (FIELD.hh + 1.05 + fx() * 0.45)
          : (fx() * 2 - 1) * 3.4,
        r,
        bank,
        side,
        pts,
        speed: bank ? 0.82 : 0.16 + fx() * 0.4,
        // Strata only. The banks are opaque; see the docblock.
        alpha: 0.035 + fx() * 0.07,
      });
    }
  }

  /**
   * Design tokens, read ONCE, off the document element, with literal fallbacks.
   *
   * The `Lottery.js:722` pattern, plus a `document` guard it does not need: the
   * lottery only ever runs in a browser, this rite is imported by a vitest suite
   * whose environment is `node`, where bare `document` is a ReferenceError and
   * not an `undefined`. Guarding only `getComputedStyle` is therefore not
   * enough here, and the failure is a thrown init rather than a wrong colour.
   *
   * WHY THE HAZARD HUE HAS NO TOKEN, AND STILL DOES NOT. `--rite-ember` is read
   * anyway, so a designer can promote it to `:root` later without touching this
   * file, but the shipping value is the literal below and that is deliberate:
   * the hazard hue is GAMEPLAY, not chrome. The rite's whole accessibility claim
   * is "the hazard is the only saturated warm mass on the stage", and a value
   * that lives in a stylesheet another rite's theme block can redefine is a
   * claim nothing enforces. A kill condition is not paint.
   *
   * THE HUE MOVED FROM MAGENTA TO EMBER. `#ff4fd8` over near-black was the
   * single hardest break of "does this look like the game it interrupts" across
   * the six rites: the board is warm sunlit greens and tans under obsidian and
   * gold, and there is no magenta anywhere in it. Ember sits in the same family
   * as `--warn` (#ffb454) and `--gold` (#e5bd79) without being either, keeps a
   * relative luminance around 0.42 against a 0.01 sky so the separation is
   * carried by VALUE before hue, and survives both simulated dichromacies as a
   * bright warm mass with a hard black edge — which was the property the
   * verified accessibility review said was doing the work.
   *
   * Everything that is only paint — the cloud, the rails, the ribbon, the accent
   * — comes from the tokens, which is where the "no hex literals" rule applies.
   */
  #palette() {
    const cs = (typeof document !== 'undefined' && typeof getComputedStyle === 'function')
      ? getComputedStyle(document.documentElement)
      : null;
    const tok = (name, fallback) => (cs?.getPropertyValue(name) || '').trim() || fallback;
    return {
      ember: tok('--rite-ember', '#ff8a3d'),
      emberDeep: tok('--rite-ember-deep', '#b8410f'),
      emberRim: '#ffd9a0',
      emberRgb: '255,138,61',
      outline: tok('--bg', '#05060a'),
      cloud: tok('--ink', '#e9ebf3'),
      cloud2: tok('--ink-2', '#a3a9bb'),
      cloud3: tok('--ink-3', '#6d7488'),
      cloud4: tok('--ink-4', '#4a5064'),
      accent: tok('--rite-heaven-accent', '#9fc4e8'),
      accentRgb: '159,196,232',
      good: tok('--good', '#56d99a'),
    };
  }

  #pushTrail(x, y) {
    this.trail[this.trailAt * 2] = x;
    this.trail[this.trailAt * 2 + 1] = y;
    this.trailAt = (this.trailAt + 1) % TRAIL;
    if (this.trailN < TRAIL) this.trailN++;
  }

  /**
   * Signed clearance to the nearest hazard at a point, optionally at a FUTURE
   * time. Pure — it reads the baked course and nothing else.
   *
   * Public because it is the honest way to write a competent player: the test's
   * skilled strategy samples it over candidate heights and steers at the best
   * one, instead of re-deriving the geometry and then proving something about
   * its own copy of it. Nothing in the rite's own loop reads it — `update` runs
   * the same walk inline because it also needs to know WHICH band was close,
   * for the once-per-band `tick`.
   *
   * THE `at` ARGUMENT IS WHY THIS TAKES A TIME AND NOT A DISTANCE. "How much
   * room at x + 4?" is only equivalent to "how much room in 4/scroll seconds?"
   * for hazards whose shape is carried entirely by x. The orb accordion is not
   * one of those — it bobs on the clock — so a distance-based lookahead reads
   * the orbs where they are NOW and walks into where they will BE. Querying a
   * future time instead handles every band kind with one expression, and it is
   * also what a player is actually doing.
   */
  clearanceAt(x, y, at = this.t) {
    let best = Infinity;
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i];
      if (at < b.t0) continue;
      const c = bandClearance(b, x, y, at, this.scroll);
      if (c < best) best = c;
    }
    return best;
  }

  /** True while the mote cannot be hurt. Read by `draw` for the i-frame flash. */
  get invulnerable() { return this.grace > 0; }

  // -------------------------------------------------------------------------

  update(dt, input) {
    // Finished: freeze. The host stops calling us, but the fuzz harness does
    // not, and a rite that keeps integrating after its own ending is a rite
    // whose score depends on who stopped it.
    if (this.over) return true;

    if (!this.started) {
      this.started = true;
      this._events.push({ type: 'start' });
    }

    this.t += dt;
    if (this.grace > 0) this.grace = Math.max(0, this.grace - dt);

    // ---- the actuator ----------------------------------------------------
    // Keyboard wins when it is held: `axis` is an explicit, deliberate press,
    // and a player using both should not fight their own cursor. Normalised, so
    // a diagonal is not 1.41x faster than a cardinal.
    this.pmx = this.mx;
    this.pmy = this.my;
    const ax = input.axis?.x || 0;
    const ay = input.axis?.y || 0;
    if (ax || ay) {
      const inv = 1 / Math.hypot(ax, ay);
      this.mx += ax * inv * MOVE_SPEED * dt;
      this.my += ay * inv * MOVE_SPEED * dt;
    } else if (input.inside) {
      // `input.x/y` are only meaningful while `inside` — the host leaves the
      // last known position there otherwise (docs/MINIGAMES.md §11), so a rite
      // that chases it anyway drifts toward a ghost. Finite-guarded because one
      // NaN here becomes a NaN position and then a blank frame with no error.
      const tx = Number.isFinite(input.x) ? input.x : this.mx;
      const ty = Number.isFinite(input.y) ? input.y : this.my;
      const dx = tx - this.mx;
      const dy = ty - this.my;
      const d = Math.hypot(dx, dy);
      const step = Math.min(d, MOVE_SPEED * dt);
      if (d > 1e-6) { this.mx += (dx / d) * step; this.my += (dy / d) * step; }
    }
    this.mx = clamp(this.mx, -PLAY_HW, PLAY_HW);
    this.my = clamp(this.my, -PLAY_HH, PLAY_HH);
    this.#pushTrail(this.mx, this.my);

    // ---- the course ------------------------------------------------------
    let nearest = Infinity;
    let overlapping = false;
    let burnedThisStep = false;
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i];
      if (this.t < b.t0) break;                     // schedule is sorted; nothing later has spawned
      const bx = SPAWN_X + b.halfW - this.scroll * (this.t - b.t0);
      if (bx + b.halfW < DESPAWN_X) continue;

      const c = bandClearance(b, this.mx, this.my, this.t, this.scroll);
      if (c < nearest) nearest = c;

      if (c < 0) {
        overlapping = true;
        /**
         * TOUCHING A BAND COSTS THE BAND, ALWAYS. Whether or not it costs a
         * life. That is what stops the i-frames from being a free pass through
         * the next slab: invulnerability protects the RUN, never the SCORE.
         */
        this.touched[i] = 1;
        // Only the first band met on this step can take the life, and only if
        // the mote is not already inside the window from a previous contact.
        if (!this.invulnerable && !burnedThisStep) burnedThisStep = true;
      }

      if (c < NEAR_MISS && !this.ticked[i]) {
        this.ticked[i] = 1;
        this._events.push({ type: 'tick', x: this.mx });
      }
      if (!this.passed[i] && bx + b.halfW < this.mx - MOTE_R) {
        this.passed[i] = 1;
        if (!this.touched[i]) {
          this.cleared++;
          // 'gold' is the host's frequent, unshaken positive — a pickup. One per
          // band cleared clean is literally one point of the score, so the cue
          // and the number are the same event. 'good' would kick the stage
          // twenty times in twenty seconds, which is nausea, not reward.
          this._events.push({ type: 'gold', x: this.mx });
        }
      }
    }
    this.clearance = nearest;

    // ---- the burn --------------------------------------------------------
    if (burnedThisStep) {
      this.burned++;
      this.hitT = this.t;
      this.grace = GRACE;
      // 'break' is the host's heaviest negative — "something you were
      // protecting broke" — with a full stage kick. Losing a band is exactly
      // that, and it must not share a cue with the end of the run.
      this._events.push({ type: 'break', x: this.mx });
    } else if (overlapping && this.grace < ESCAPE_GRACE) {
      // Still inside the hazard with the window running out: hold it open until
      // the mote is genuinely clear. One contact may never cost two lives — a
      // sweep is 8 units wide and takes up to 1.9 s to pass.
      this.grace = ESCAPE_GRACE;
    }

    if (this.t >= DURATION) {
      this.over = true;
      this.endT = this.t;
      // One closing cue, and only the flawless run gets the big one.
      this._events.push({ type: this.burned === 0 ? 'perfect' : 'good', x: this.mx });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------

  /**
   * MUTATES NOTHING. Every value below is derived from `this.t` and the baked
   * course, and the only reason that is worth a comment is that the tempting
   * shortcuts — a scratch point array on `this`, a `this._fx()` for sparkle, a
   * cached gradient — are all mutations, and a mutation in here makes the
   * picture depend on the refresh rate. (The two sweep buffers are at MODULE
   * scope for exactly that reason; see `SWEEP_HI`.)
   */
  draw(g, alpha) {
    const p = this._palette;
    const t = this.t;
    // The accessibility pulse. A player who cannot separate the hues can still
    // separate "the thing that is strobing" from "the thing that is not" — see
    // PULSE_HZ for why the frequency is what it is.
    const pulse = 0.5 + 0.5 * Math.sin(t * PULSE_HZ * TAU);
    const dist = this.scroll * t;

    g.clipRect(0, 0, FIELD.w, FIELD.h, () => {
      this.#drawSky(g, dist, p);
      for (let i = 0; i < this.bands.length; i++) {
        const b = this.bands[i];
        if (t < b.t0) break;
        const bx = SPAWN_X + b.halfW - this.scroll * (t - b.t0);
        if (bx + b.halfW < DESPAWN_X || bx - b.halfW > FIELD.hw + 1) continue;
        if (b.kind === GATE) this.#drawGate(g, b, bx, pulse, p);
        else if (b.kind === SWEEP) this.#drawSweep(g, b, bx, pulse, p);
        else this.#drawOrbs(g, b, bx, t, pulse, p);
      }
      this.#drawMote(g, alpha, pulse, p);
    });

    this.#drawRibbon(g, p);
  }

  /**
   * The corridor: two opaque cloud banks with a lit crown and a shaded
   * underside, plus faint strata behind them.
   *
   * `quality` thins the DRAW loop and nothing else. The puffs are all generated
   * either way — `puffCount` is the only thing the preset touches — because a
   * preset that changed how many values came out of the private generator would
   * make two players on one seed see different clouds, and a preset that
   * reached the gameplay stream would make them play different courses. The
   * banks are generated first so the frame the low preset drops is always a
   * background stratum, never the corridor's own edge.
   *
   * THREE PASSES, AND THE ORDER IS THE WHOLE PICTURE:
   *   strata  translucent, far behind, alpha under 0.11 so no overlap is
   *           countable;
   *   shadow  every bank puff, OPAQUE, in the mid tone — the union of these is
   *           the silhouette of the wall and its inner edge is the corridor;
   *   crown   every bank puff again, opaque, in bone white, pushed 0.34 units
   *           OUTWARD and slightly shrunk. The mid tone survives only as a band
   *           along the corridor-facing edge, which is a terminator: form and
   *           a light direction for the price of a second fill and no alpha.
   */
  #drawSky(g, dist, p) {
    const span = FIELD.w + 8;
    const n = this.puffCount;

    for (let i = BANK_PUFFS; i < n; i++) {
      const q = this.puffs[i];
      g.save().alpha(q.alpha).translate(wrapX(q.x - dist * q.speed, span), q.y);
      g.blob(q.pts, { fill: p.cloud2 });
      g.restore();
    }
    for (let i = 0; i < BANK_PUFFS; i++) {
      const q = this.puffs[i];
      g.save().translate(wrapX(q.x - dist * q.speed, span), q.y);
      g.blob(q.pts, { fill: p.cloud3 });
      g.restore();
    }
    for (let i = 0; i < BANK_PUFFS; i++) {
      const q = this.puffs[i];
      g.save().translate(wrapX(q.x - dist * q.speed, span), q.y + q.side * 0.34).scale(0.97);
      g.blob(q.pts, { fill: p.cloud });
      g.restore();
    }

    // The rails. Faint, cool, and the only straight lines in the sky — they
    // tell the player where the corridor ENDS without a wall that looks lethal.
    g.alpha(0.2)
      .line(-FIELD.hw, PLAY_HH + 0.12, FIELD.hw, PLAY_HH + 0.12, p.accent, 0.03)
      .line(-FIELD.hw, -PLAY_HH - 0.12, FIELD.hw, -PLAY_HH - 0.12, p.accent, 0.03)
      .alpha(1);
  }

  /**
   * The pulsing inner rim — the accessibility signal that is actually visible.
   *
   * Always drawn INSIDE the silhouette. The caller supplies the two endpoints of
   * an edge already inset by `RIM_INSET`; what changes over time is the ALPHA of
   * a bright warm band, never a position and never a width. See RIM_ALPHA_LO.
   */
  #rimLine(g, x0, y0, x1, y1, pulse, p) {
    g.alpha(RIM_ALPHA_LO + (RIM_ALPHA_HI - RIM_ALPHA_LO) * pulse);
    g.line(x0, y0, x1, y1, p.emberRim, RIM_W, 'round');
    g.alpha(1);
  }

  #drawGate(g, b, bx, pulse, p) {
    const top = b.gc + b.gh;
    const bot = b.gc - b.gh;
    const lim = FIELD.hh + 0.6;
    const hiH = lim - top;
    const loH = bot + lim;
    const hw = GATE_TH / 2;

    g.save().add().alpha(0.14 + 0.1 * pulse);
    g.halo(bx, top + 0.3, 1.5, p.emberRgb, 1);
    g.halo(bx, bot - 0.3, 1.5, p.emberRgb, 1);
    g.restore();

    if (hiH > 0) {
      g.rect(bx, top + hiH / 2, GATE_TH, hiH, { fill: p.ember, radius: 0.18 });
      g.rect(bx, top + hiH / 2, GATE_TH, hiH, { stroke: p.outline, width: OUTLINE_W, radius: 0.18 });
      this.#rimLine(g, bx - hw + RIM_INSET, top + RIM_INSET, bx + hw - RIM_INSET, top + RIM_INSET, pulse, p);
    }
    if (loH > 0) {
      g.rect(bx, bot - loH / 2, GATE_TH, loH, { fill: p.ember, radius: 0.18 });
      g.rect(bx, bot - loH / 2, GATE_TH, loH, { stroke: p.outline, width: OUTLINE_W, radius: 0.18 });
      this.#rimLine(g, bx - hw + RIM_INSET, bot - RIM_INSET, bx + hw - RIM_INSET, bot - RIM_INSET, pulse, p);
    }

    // Chevrons pointing INTO the gap — the third signal, and the one that works
    // in a black-and-white screenshot.
    this.#chevron(g, bx, top + 0.6, -1, p);
    this.#chevron(g, bx, bot - 0.6, 1, p);
    this.#shaft(g, bx, b.gc, GATE_TH, b.gh, p);
  }

  /**
   * The diagonal canyon.
   *
   * ONE CLOSED QUADRILATERAL PER SLAB, not sixteen vertical slices. The throat
   * centre is LINEAR in x — `c = dir * amp * (2s - 1)` — so there was never a
   * curve here to tessellate, and slicing it produced a ~0.5-unit pixel
   * staircase down both boundaries of the game's primary hazard while the cool
   * centreline drawn through the middle of that same shape came out perfectly
   * smooth. Same image, same shape, two different qualities of edge.
   *
   * A single path also means the whole perimeter can be stroked, so the OUTER
   * boundary carries the black outline too. It did not before: roughly half the
   * hazard's perimeter was a pure hue edge, which is precisely the edge a
   * dichromat cannot rely on.
   *
   * The two point buffers are at module scope and mutated in place; see
   * `SWEEP_HI` for why that is not a `draw()` mutation.
   */
  #drawSweep(g, b, bx, pulse, p) {
    const left = bx - b.halfW;
    const right = bx + b.halfW;
    const lim = FIELD.hh + 0.9;
    // Measured from the LEFT edge, matching bandClearance exactly. If these two
    // ever disagree the picture and the hit box part company, which is the one
    // bug this rite cannot survive.
    const cL = -b.dir * b.amp;
    const cR = b.dir * b.amp;

    const hi = SWEEP_HI;
    hi[0][0] = left; hi[0][1] = cL + b.gh;
    hi[1][0] = right; hi[1][1] = cR + b.gh;
    hi[2][0] = right; hi[2][1] = lim;
    hi[3][0] = left; hi[3][1] = lim;

    const lo = SWEEP_LO;
    lo[0][0] = left; lo[0][1] = cL - b.gh;
    lo[1][0] = right; lo[1][1] = cR - b.gh;
    lo[2][0] = right; lo[2][1] = -lim;
    lo[3][0] = left; lo[3][1] = -lim;

    g.poly(hi, { fill: p.ember });
    g.poly(lo, { fill: p.ember });
    g.poly(hi, { stroke: p.outline, width: OUTLINE_W });
    g.poly(lo, { stroke: p.outline, width: OUTLINE_W });

    // The rim runs down the two lips of the throat, inside the hazard.
    this.#rimLine(g, left, cL + b.gh + RIM_INSET, right, cR + b.gh + RIM_INSET, pulse, p);
    this.#rimLine(g, left, cL - b.gh - RIM_INSET, right, cR - b.gh - RIM_INSET, pulse, p);

    // The route, named positively: a cool line straight down the throat.
    g.alpha(0.55).line(left, cL, right, cR, p.accent, 0.045).alpha(1);

    // A halo at the mouth of the throat — the LEFT end, which is the end the
    // player arrives at.
    g.save().add().alpha(0.16 + 0.14 * pulse);
    g.halo(left, cL, 2.2, p.accentRgb, 0.5);
    g.restore();
  }

  #drawOrbs(g, b, bx, t, pulse, p) {
    for (let j = 0; j < 4; j++) {
      const oy = (j - 1.5) * b.spread + b.gc
        + b.bob * Math.sin(t * ORB_HZ * TAU + b.phase * TAU + j * Math.PI);
      const ox = bx + (j % 2 ? ORB_DX : -ORB_DX);
      g.save().add().alpha(0.16 + 0.1 * pulse);
      g.halo(ox, oy, b.gh * 2.6, p.emberRgb, 1);
      g.restore();
      g.circle(ox, oy, b.gh, { fill: p.ember });
      g.circle(ox, oy, b.gh * 0.5, { fill: p.emberDeep });
      // The rim, inside the silhouette. Same alpha swing as every other hazard.
      g.alpha(RIM_ALPHA_LO + (RIM_ALPHA_HI - RIM_ALPHA_LO) * pulse);
      g.circle(ox, oy, Math.max(0.02, b.gh - RIM_INSET), { stroke: p.emberRim, width: RIM_W });
      g.alpha(1);
      g.circle(ox, oy, b.gh, { stroke: p.outline, width: OUTLINE_W });
    }
  }

  #chevron(g, x, y, dir, p) {
    g.line(x - 0.26, y - 0.26 * dir, x, y + 0.1 * dir, p.outline, 0.09, 'round');
    g.line(x + 0.26, y - 0.26 * dir, x, y + 0.1 * dir, p.outline, 0.09, 'round');
  }

  /** The safe route, drawn POSITIVELY: a cool shaft of light through the gap. */
  #shaft(g, x, cy, w, gh, p) {
    g.save().add().alpha(0.5);
    g.halo(x, cy, gh * 1.6, p.accentRgb, 0.55);
    g.restore();
    g.alpha(0.55).line(x - w, cy, x + w, cy, p.accent, 0.04).alpha(1);
  }

  /**
   * The mote, and the ONE thing in this rite that earns `alpha`.
   *
   * docs/MINIGAMES.md is right that most rites can ignore the interpolation
   * fraction — 16.6 ms of positional lag is invisible at most speeds. This one
   * is not most speeds: the mote covers 0.117 units per step and its core is
   * 0.108 across, so an un-interpolated mote moves by more than its own width
   * between steps and visibly stutters on a 144 Hz panel while the hazards it
   * is threading scroll smoothly past it. Lerping from the previous step's
   * position costs two stored numbers.
   *
   * THE I-FRAME FLASH. While `grace` is running the core blinks at 9 Hz — fast,
   * short-lived and confined to a 0.1-unit disc, which is what "you are
   * currently intangible" has to look like for it to be readable at a glance.
   * It is deliberately NOT the same clock as the hazard pulse: two things
   * strobing in step read as one thing.
   *
   * The TRAIL is deliberately not interpolated: it is a record of where the
   * mote has been, and smoothing a record of the past is just blurring it.
   */
  #drawMote(g, alpha, pulse, p) {
    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 0;
    const x = this.pmx + (this.mx - this.pmx) * a;
    const y = this.pmy + (this.my - this.pmy) * a;
    const inv = this.grace > 0;
    const blink = inv ? 0.5 + 0.5 * Math.sin(this.t * 9 * TAU) : 1;

    for (let i = 0; i < this.trailN; i++) {
      const k = (this.trailAt - 1 - i + TRAIL * 2) % TRAIL;
      const f = 1 - i / this.trailN;
      g.save().add().alpha(0.1 * f * f);
      g.circle(this.trail[k * 2], this.trail[k * 2 + 1], 0.1 + 0.24 * f, { fill: p.accent });
      g.restore();
    }
    g.save().add();
    // The halo breathes on the same clock as the hazards, but INVERTED: when
    // the danger is at its brightest the soul is at its dimmest. It reads as the
    // corridor pressing in, and it costs nothing.
    g.halo(x, y, 1.1 + 0.12 * (1 - pulse), p.accentRgb, inv ? 0.22 : 0.42);
    g.restore();
    g.alpha(inv ? 0.3 + 0.7 * blink : 1);
    g.circle(x, y, MOTE_R * 0.72, { fill: p.cloud });
    g.alpha(1);
  }

  /**
   * The ribbon, which IS the scoreboard.
   *
   * One pip per PRESENTED band, in course order, plus the clock underneath and
   * the remaining lives at the right. That is the score model drawn literally:
   * a pip lights cool when its band went by clean, goes dark warm when it
   * burned, and sits grey until the band arrives. A player can see what the
   * number is made of without a word of text, which is the only way a rite this
   * short can teach its own scoring.
   *
   * The old ribbon showed survival time with three quarter pips, which was an
   * honest picture of the old score and is a wrong one now.
   */
  #drawRibbon(g, p) {
    const y = -FIELD.hh + 0.34;
    const w = 8.6;
    const n = this.presented;
    const f = clamp(this.t / DURATION, 0, 1);

    g.alpha(0.28).line(-w / 2, y - 0.24, w / 2, y - 0.24, p.cloud4, 0.045, 'round').alpha(1);
    g.line(-w / 2, y - 0.24, -w / 2 + w * f, y - 0.24, p.accent, 0.055, 'round');

    for (let i = 0; i < n; i++) {
      const px = -w / 2 + (w * (i + 0.5)) / n;
      const burnt = this.touched[i] === 1;
      const done = this.passed[i] === 1 || burnt;
      g.circle(px, y, done ? 0.075 : 0.05, {
        fill: !done ? p.cloud4 : burnt ? p.emberDeep : p.accent,
      });
    }

  }

  /**
   * BANDS CLEARED OUT OF BANDS PRESENTED.
   *
   * `presented` is fixed at layout time (see `#buildCourse`), so an early death
   * does not shrink the denominator — the bands you never reached still count
   * against you, which is what makes running out of lives cost more than a
   * single burn without collapsing the score to zero. Clamped at 1 because a
   * player who drifts right meets more bands than the reference column does.
   */
  score() {
    const presented = this.presented;
    const ratio = clamp(this.cleared / presented, 0, 1);
    const headline = ratio >= 1 ? 'Escaped'
      : ratio >= 0.82 ? 'Barely singed'
        : ratio >= 0.6 ? 'Scorched'
          : ratio >= 0.35 ? 'Burned through'
            : ratio > 0 ? 'Ashes'
              : 'Never left';
    return {
      ratio,
      headline,
      detail: `${this.cleared}/${presented} bands cleared · ${this.burned} burn${this.burned === 1 ? '' : 's'}`,
    };
  }

  drainEvents() { return this._events.splice(0, this._events.length); }
  teardown() { this._events.length = 0; }
}

/** @type {import('../contract.js').MinigameDef} */
export const HEAVEN_RITE = {
  id: 'heaven',
  name: 'escape from gay heaven',
  hint: 'Steer the mote — thread the gaps, three lights to spend',
  duration: DURATION,
  theme: 'heaven',
  eyebrow: 'Ascent',
  abandonNote: 'You stayed in heaven',
  // The avatar IS the pointer, so a second arrow on top of it is one cursor too
  // many. A crosshair would promise aiming, which this rite never asks for.
  cursor: 'none',
  create: () => new HeavenRite(),
};

export {
  HeavenRite, RAND_CALLS, DURATION, BANDS, MOVE_SPEED, MOTE_R, START_X, START_Y,
  GATE, SWEEP, ORBS, GRACE, SPEED_BUDGET, SWEEP_CLEAR,
};
