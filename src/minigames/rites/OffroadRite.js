/**
 * OFFROAD RACING — steer a dirt track, take the gates, sweep the gold, and
 * spend three boosts where they count. Drawn in 3D by OffroadView.js.
 *
 * "course de voiture avec des points de passage, avec un boost pour accélérer et
 * une bombe pour bloquer ses adversaires. Des golds sont à ramasser sur la
 * route." Twelve gates, thirty nuggets, three boosts, 26 seconds.
 *
 * TWO VERBS, NOT THREE. The bomb from the original description shipped once
 * and was cut in the 3D rework. It needed the secondary button (or Digit1), a
 * paragraph on the intro card, and a rival behind you to be worth anything; the
 * ablation below priced it at 0.02-0.03 of ratio, and the calibration player
 * scored the same to three decimals with and without it. Steer and boost are
 * the whole game now: one hand on the arrows, one thumb on Space.
 *
 * WHAT THE BOOST IS WORTH, MEASURED (clean-driving bot, 40 seeds, mean ratio,
 * taken with the bomb still in; its row is kept as the evidence for the cut):
 *
 *                            w3      w28     w53
 *   everything            0.794   0.750   0.704
 *   boost mashed          0.769   0.731   0.678
 *   never boost           0.756   0.718   0.662
 *   never bomb            0.768   0.730   0.672
 *   ignore the gold       0.584   0.485   0.347
 *
 * Spending the three charges on the fast stretches (the yellow arrows on the
 * road) beats mashing them by about 0.02 and beats never pressing by about
 * 0.04, so the button is worth having AND worth thinking about.
 * `tests/unit/offroad-rite.test.js` re-derives that ordering. The gold is the
 * largest single term, which is right: this is a race with a collection layered
 * on it, and the collection is the part you are always doing.
 *
 * THE DETERMINISM-CRITICAL PART IS THE TRACK. `centreAt(s)` is a sum of three
 * sines of the distance travelled — a PURE FUNCTION of `s`, with no per-step
 * randomness and no integrated state. Two clients on one seed therefore agree
 * about where the road is at every distance, exactly, forever. The tempting
 * alternative (accumulate a heading, add a little noise per step) drifts apart
 * after a few hundred steps in a way that is invisible until two players compare
 * screenshots. See docs/MINIGAMES.md §3 and §4.
 *
 * NO DOM, NO THREE, NO Math.random — the unit suite imports this in node.
 * The 3D view is a dynamic import (`def.view`), so three.js never loads here.
 */

import { clamp, lerp } from '../contract.js';
import { SeededRivals, PER_RIVAL } from '../rivals.js';

// ---------------------------------------------------------------------------
// The course
// ---------------------------------------------------------------------------

/** Seconds on the clock. The longest of the six: a race under 20 s is not a race. */
const DURATION = 26;

/**
 * Length of the course in world units, and the number every other distance here
 * is measured against.
 *
 * WHY IT GREW FROM 158, WHICH IS THE SAME QUESTION AS "WHY IS SPEED WORTH
 * ANYTHING". At 158 a clean driver reached the flag at ~21.4 s of the 26 and
 * then sat there: every gate and every nugget had already gone past, so the last
 * 4.6 s were worth nothing and — the part that broke the boost — NEITHER WAS ANY
 * EXTRA SPEED. Measured over 40 seeds on the old numbers, mashing the boost on
 * cooldown scored 0.858 / 0.818 / 0.714 at waves 3 / 28 / 53 and spending it
 * "thoughtfully" scored 0.858 / 0.818 / 0.714 — the same run to three decimals,
 * because the only thing speed still bought was the 20 % rival term and a clean
 * driver had already maxed that at wave 3.
 *
 * At 217 the clock is the binding constraint the whole way. A clean driver who
 * never boosts is still short of the flag when the whistle goes and has missed
 * two or three gates and a handful of nuggets with it, so every source of speed
 * in the rite — holding the road, taking the gates clean (WIDE_DRAG), and
 * spending the three charges on the fast stretches — converts into the 80 % of
 * the score that is gates and gold rather than into a lead with nothing to buy.
 * The current ablation, same 40 seeds, is in the module docblock.
 *
 * The gate and nugget layout below is expressed as FRACTIONS of this number for
 * exactly that reason: falling short of the flag has to cost objectives, not
 * just pride, and it only does that if the objectives are spread over the whole
 * length. Tuning this constant alone re-spaces the entire course.
 */
const TRACK_LEN = 217;

/**
 * Where the finish line actually is, a little short of the course length.
 *
 * THE FLAG HAS TO BE REACHABLE BY SOMEBODY OR IT IS A PAINTING. At TRACK_LEN
 * exactly, nobody in the measured population ever crossed it: a driver holding a
 * perfect line, ignoring every nugget and spending all three boosts on fast
 * stretches reached 211 of 217 in the 26 s, and every player who stopped to
 * collect reached less. That would leave the whole "finisher" branch of
 * `#standings`, the FLAG on screen and the 'perfect' cue as code no run executes.
 *
 * At 0.98 of the course the sprinter takes it on 24 seeds of 40 at wave 3 and on
 * 3 of 40 at wave 53, and the collector never does — which is the tension the
 * rite wants: the
 * flag and the gold are two different runs, and a player has to choose which
 * race they are in. The gates and the nuggets are laid out against TRACK_LEN and
 * are untouched by this, so moving it changes what SPEED is worth and nothing
 * else.
 */
const FLAG_AT = TRACK_LEN * 0.98;

/** Half the drivable width. Outside it you are in the scrub and slower. */
const HALF_W = 1.6;

const BASE_SPEED = 7.4;
/** Seconds of rolling start. Not a countdown: a countdown spends the clock. */
const LAUNCH_T = 0.9;
/** Speed at t=0, as a fraction of base. The car is already moving when the flag drops. */
const LAUNCH_FROM = 0.42;

const BOOST_CHARGES = 3;
const BOOST_TIME = 1.2;
/** A boost lit inside a fast stretch. See BOOST_COLD_MUL for the other case. */
const BOOST_MUL = 1.85;
/**
 * Boost while off the track. Wheels spin in the dirt, so it is worth barely more
 * than nothing — and combined with DIRT_MUL it is a NET LOSS versus not boosting
 * on the road at all.
 *
 * THIS LINE USED TO BE ADVERTISED AS "the one line that makes boost a decision
 * rather than a button to mash on frame one". IT WAS NOT, AND THE ABLATION SAID
 * SO. A clean driver is on the road essentially always, so the dirt branch never
 * fired for anybody who was playing; the two ablation rows it was supposed to
 * separate came out identical to three decimals (see TRACK_LEN). A
 * penalty that only punishes a player who was already losing is not a decision,
 * it is a consolation. The decision now lives in BOOST_COLD_MUL below, where it
 * costs something to the player who is doing well.
 */
const BOOST_DIRT_MUL = 1.12;
/**
 * Boost on a stretch of road the track itself is not straight over.
 *
 * THIS IS THE VERB'S ONLY REAL RULE, AND IT IS POSITIONAL. A charge fired inside
 * a FAST STRETCH (see `#findFastZones`) runs at BOOST_MUL; fired anywhere else it
 * runs at this, which is barely above the throttle the car already has, and the
 * charge is gone either way. So the three boosts are not "extra speed you have",
 * they are "extra speed you can collect from THREE PLACES ON THIS COURSE", and
 * finding those places is the decision.
 *
 * WHY A COLD BOOST STILL WORKS AT ALL, RATHER THAN BEING REFUSED. A refused press
 * is an input trap: the player pressed, the game did nothing visible, and the
 * charge is either silently kept (in which case mashing costs nothing and the
 * whole rule evaporates) or silently spent (in which case a mis-click costs a
 * third of the supply with no feedback). A weak boost is legible — the car
 * lurches, the dust is thin, the pip is gone — and it is never WORSE than not
 * pressing, which is the property that keeps this a decision about value rather
 * than a punishment for curiosity.
 *
 * WHY NOT A HANDLING PENALTY (the first version, measured and discarded). Making
 * the car understeer while boosting is the more physical idea and it produced a
 * genuinely better ablation table — but it also made a mistimed boost cost MORE
 * than not boosting, which turns any bot that spends its charges on cooldown into
 * a bot that scores below one that never presses the button. The calibration
 * gate's shared reference player is exactly such a bot, so the change inverted
 * its skill ladder (m = 0 scoring 0.696 against m = 0.5's 0.721 at wave 53) and
 * pushed the "ceiling stays reachable" assertion under its floor. A rule that
 * only reads as a difficulty change when the measuring instrument happens to play
 * well is not a rule, it is a trap for a specific bot.
 */
const BOOST_COLD_MUL = 1.15;
/**
 * How far ahead the road must be straight for a stretch to be FAST, and how
 * straight "straight" is, as |d(centreline)/ds|.
 *
 * REACH is sized off what a boost actually covers — BOOST_TIME * BOOST_MUL *
 * BASE_SPEED is about 16 units — cut back to 12 because demanding the whole run
 * be straight would find almost no zones on a course made of three sines. What
 * the player is promised is "the next second of this is clean", not "the whole
 * boost is".
 *
 * FAST_SLOPE is the wave scaling nobody had to write. The zones are found from
 * the track's OWN slope and `_ampScale` multiplies that slope, so a wave-53
 * course has fewer and shorter fast stretches than a wave-3 one with no second
 * difficulty constant to keep in step. Measured over 40 seeds: 2.4 stretches
 * covering 26 % of the course at wave 3, 2.4 covering 18 % at wave 28, 2.1
 * covering 14 % at wave 53. Later waves do not make the boost weaker, they make
 * PLACES TO SPEND IT scarcer — and note that the count is BELOW BOOST_CHARGES at
 * every wave, so at least one of the three is always going to be spent cold and
 * the question is which one. Loosening FAST_SLOPE to 0.20 was measured and puts
 * the wave-53 curve 0.027 outside the calibration band: the scarcity IS the
 * difficulty.
 */
const BOOST_REACH = 12;
const FAST_SLOPE = 0.155;
/** Fast stretches shorter than this are not drawn or counted: you cannot aim at them. */
const FAST_MIN_LEN = 4;
/** Resolution of the fast-zone scan, in world units. Fixed count, fixed cost, once. */
const FAST_STEP = 1.0;
/**
 * Scrub drag. Continuous, not a crash — a crash in a 26 s race is a dead run.
 *
 * WHY 0.52 AND NOT 0.62, WHICH IS A STORY ABOUT THE IDLE SCORE. The standings
 * compare FRACTIONS OF THE COURSE, so lengthening the track (see TRACK_LEN) made
 * the player relatively slower against a field whose pace is defined in course
 * fractions, and RIVAL_CLOCK had to be slowed to compensate. That is fine for a
 * driver and it is not fine for an unattended car: at 0.62 an idle run coasted to
 * about 60 % of the course, which at wave 3 was past the weakest two ghosts, and
 * "start it and look away" paid 0.133 on one seed of thirty — over the 0.12 this
 * rite's own suite pins and uncomfortably close to `assertRiteContract`'s 0.15.
 *
 * 0.52 is the one number that fixes it without touching anybody who is playing.
 * A driver who holds the road never evaluates this branch at all, so the whole
 * calibration table moves by under 0.003; an unattended car is in the scrub
 * within the first few seconds and stays there, so it eats the change for the
 * entire run and now finishes behind every rival on every seed and wave measured
 * (worst idle ratio 0.000 over 10 seeds x 3 waves).
 */
const DIRT_MUL = 0.52;

/** A gate taken wide costs this much speed for this long. Small, and it compounds. */
const WIDE_DRAG_MUL = 0.7;
const WIDE_DRAG_TIME = 0.5;

/**
 * THE WAVE SCALES THE PENALTIES, NOT THE CHALLENGE, and this is the single most
 * important tuning decision in the file.
 *
 * By wave 53 the scrub is DIRT_WAVE deeper and a gate taken wide drags for
 * WIDE_WAVE longer. Neither makes the road bendier, the gates narrower or the
 * gold further away — the course a flawless driver sees at wave 53 is very
 * nearly the course they see at wave 3, and they pay neither penalty because
 * they commit neither mistake.
 *
 * WHY THAT SHAPE. The calibration gate asks for two things at once at wave 53:
 * a flawless run must still score at least 0.75, and a competent one must fall
 * to about 0.54. That is a demand for 0.2 of SEPARATION between two players, and
 * every lever that makes the course itself harder — a bigger WAVE_AMP, narrower
 * gates, a smaller catch radius, deeper ruts — was measured and moves both
 * players together, because both have to drive the same road. Scaling the cost
 * of a MISTAKE is the only lever whose size is multiplied by how often you make
 * one. A driver who never leaves the road is indifferent to DIRT_WAVE by
 * definition; a driver who spends a fifth of the race in the scrub pays it a
 * fifth of the race long.
 *
 * It is also the honest reading of what a late-game rally stage is. The corners
 * are not sharper at the end of a run; the surface is worse, and the same
 * mistake costs more.
 */
const DIRT_WAVE = 0.20;
const WIDE_WAVE = 1.2;

/**
 * Lateral authority, in world units per second.
 *
 * The budget it has to cover: the track's own worst lateral rate (~2.2 u/s at
 * wave 3, ~2.8 at wave 53), plus the centrifugal slide on top of it, plus the
 * understeer. Worst case is around 3.4 of these 4.7 — the car is always able to
 * hold the line, and never able to hold it carelessly.
 */
const LAT_SPEED = 4.7;
/** Seconds for the lateral velocity to reach its target. The car has mass. */
const LAT_TAU = 0.11;
/**
 * Understeer, per second, as a multiple of the current offset from the line.
 *
 * The car does NOT self-centre — see the long note in `update`. 0.45 gives a
 * divergence time constant of ~2.2 s: a player who is 0.5 u off and does nothing
 * about it is 0.78 u off a second later, and countering it costs 0.45 * u u/s of
 * the LAT_SPEED budget, which is under a fifth of it anywhere on the road.
 */
const DRIFT_RATE = 0.45;
/**
 * The rope. Beyond this the course marshals turn you back — and it exists so an
 * idle car stays on screen and stays bounded rather than driving to x = 400.
 */
const ROPE = 7.0;
/**
 * How much of the corner throws the car outward, as a fraction of the road's own
 * lateral rate. 0.35 means a corner the road takes at 2 u/s slides the car out at
 * a further 0.7 u/s, so the total the player has to hold against on the worst
 * corner is about 2.7 of the 4.7 u/s available — hard work, never a wall.
 */
const CENTRIFUGAL = 0.35;

const GATE_COUNT = 12;
/**
 * The gates are laid out as FRACTIONS of TRACK_LEN, and they stop before it.
 *
 * TWO THINGS HAD TO BE TRUE AT ONCE and one number could not do both. Every gate
 * and every nugget has to be REACHABLE — a rite that scores you out of twelve
 * gates and then hands a strong driver eleven of them because the clock ran out
 * is scoring you out of eleven and lying about it. And running out of clock has
 * to COST something, or speed is worth nothing and the boost is a decoration
 * (which is exactly what it was: see TRACK_LEN).
 *
 * So the objectives finish at GATE_LAST (86 % of the course) and the FLAG is
 * further on. The last sixth of the track is a pure sprint: nothing to collect,
 * nothing to thread, only the finish line and the three rivals running for it.
 * A driver who held the line and spent the boosts well takes it; one who did not
 * watches the field cross first. That is where the 20 % rival term lives, and it
 * is why it is now a term a good run can win rather than a tax on a good run.
 */
const GATE_S0 = TRACK_LEN * 0.076;
const GATE_STEP = TRACK_LEN * 0.0798;
/** How far a gate may slide from its nominal spacing to find an apex, and at what resolution. */
const GATE_APEX_W = GATE_STEP * 0.492;
const GATE_APEX_STEPS = 48;
/** Gate half-widths land in [GATE_HW_MIN, GATE_HW_MIN + GATE_HW_SPAN]. */
const GATE_HW_MIN = 0.9;
const GATE_HW_SPAN = 0.35;

const COIN_COUNT = 30;
/** Spread over the same stretch as the gates, for the reason spelled out there. */
const COIN_S0 = TRACK_LEN * 0.038;
const COIN_STEP = TRACK_LEN * 0.03165;
/** How far off the centreline a nugget can sit. Inside HALF_W, so always drivable. */
const COIN_SPREAD = 1.15;
const COIN_R = 0.34;

const RIVAL_COUNT = 3;
/** Overtake hysteresis, in standings-key units: about one car length of course. */
const PASS_GAP = 1 / FLAG_AT;
/** Amplitude of a rival's weave across the road, in world units. Pure, no draws. */
const RIVAL_WEAVE = 1.0;
/**
 * The rivals' clock, as a multiple of the player's, at wave 3 and wave 53.
 *
 * Scaling the result rather than reaching into rivals.js, as that module's
 * docblock asks: the shared constants keep the six rites feeling like one game.
 *
 * TUNED SO THE PLACE IS CONTESTED. At 1.55 flat the field was so slow that any
 * car that stayed on the road beat all three at waves 3 and 28, the HUD read
 * "1st" from the third second on, and 20 % of the score was free. Measured over
 * 20 seeds (tools/scratch/offroad-law.mjs), the rivals beaten out of 3 are now:
 *
 *                               w3     w28    w53
 *   clean driver, no boost      1.65   1.35   0.95
 *   clean, boost mashed         2.05   1.55   1.25
 *   clean, boost on the arrows  2.85   2.50   1.75
 *
 * The clock grows with the wave because SeededRivals' pressure already speeds
 * the roster up by a quarter between wave 3 and 53; a flat clock would put the
 * whole field past a flawless driver late in the run, a wall rather than a curve.
 */
const RIVAL_CLOCK = Object.freeze([1.08, 1.26]);
/**
 * The grid: rival `id` starts GRID_GAP * (id + 1) units up the road and you
 * start last. Without it the four cars share the line, the ghosts are faded
 * into your own car, and you never see the field you are racing.
 */
const GRID_GAP = 2;

/**
 * The three sine wavenumbers of the centreline, in radians per world unit.
 *
 * FIXED, not drawn: they are what makes every seed's track feel like the same
 * SPORT — one long sweeper, one medium, one flick — while the phases below make
 * it a different track. Drawing the wavelengths too would let a seed roll a
 * course that is either flat or unsteerable, and "this seed was unplayable" is
 * not a thing a shared-seed room can afford.
 */
const WAVE_K = Object.freeze([0.035, 0.075, 0.135]);
const WAVE_A = Object.freeze([2.3, 1.8, 1.5]);
/** How much harder the composite bends at wave 53 than at wave 3. See `_ampScale`. */
const WAVE_AMP = 0.28;

/**
 * WHAT WAVE_AMP CAN AND CANNOT BUY, because two other ideas were tried here and
 * both are recorded rather than repeated.
 *
 * Bending the road HARDER taxes effort, and effort is not what separates players:
 * raising this constant from 0.28 to 0.60 moved a flawless bot from 0.823 to
 * 0.718 at wave 53 and a competent one from 0.771 to 0.710. The whole rite got
 * a tenth worse and the DIFFERENCE between the two barely moved — a rite that
 * got slower, not one that got harder.
 *
 * Bending it FASTER — a fourth sine at ~12 units of wavelength, a chicane — taxes
 * latency instead, and it worked far too well in the wrong direction: at that
 * wavelength a fixed aiming lead is a phase shift, so the reference player's
 * 0.28 s of lag CANCELLED the harness bot's 2.2-unit lead and the degraded
 * player scored ABOVE the flawless one (0.626 against 0.498 at wave 53). Any
 * track content whose wavelength is near "one reaction time of travel" makes the
 * skill ladder a statement about the bot's tuning, not about the rite.
 *
 * So the wave scaling that survived is the one in FAST_SLOPE: a bendier course
 * has fewer places worth spending a boost, which is a difficulty the player can
 * see on the road ahead and act on.
 */

/** Cap on the cue queue. The host drains every step; this is the belt to that brace. */
const MAX_EVENTS = 24;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, every wave, always.
 *
 * The order is part of the seed contract exactly as `NAMES` is in rivals.js —
 * moving a draw rerolls every existing seed's course:
 *
 *   3                     the three centreline phases
 *   GATE_COUNT (12)       one half-width per gate
 *   COIN_COUNT (30)       one lateral offset per nugget
 *   RIVAL_COUNT*PER_RIVAL the roster, consumed inside SeededRivals
 *   1                     the seed of the private presentation generator
 *
 * Every one of those is an unconditional loop bounded by a module constant.
 * `ctx.wave` moves the NUMBERS (amplitude, rival pressure) and never the count —
 * that split is the determinism contract in one sentence.
 */
const RAND_CALLS = 3 + GATE_COUNT + COIN_COUNT + RIVAL_COUNT * PER_RIVAL + 1;

/** Ordinals for the result card. Four racers, so four words is the whole table. */
const PLACES = Object.freeze(['1st', '2nd', '3rd', '4th']);

/** The blend. Stated once, here, because the result card has to itemise it. */
const W_GATES = 0.45;
const W_COINS = 0.35;
const W_RIVALS = 0.20;

class OffroadRite {
  init(ctx) {
    this.wave = ctx.wave;

    /** 0 at the first rite of a run, 1 at the last. The difficulty axis, once. */
    this._waveT = clamp((ctx.wave - 3) / 50, 0, 1);
    this._rivalClock = RIVAL_CLOCK[0] + (RIVAL_CLOCK[1] - RIVAL_CLOCK[0]) * this._waveT;

    /**
     * How hard the course bends. Wave 3 drives the base shape; wave 53 drives it
     * WAVE_AMP harder, which at the top is a peak lateral rate of ~3.6 u/s
     * against 4.7 of authority, plus the centrifugal slide on top — demanding,
     * never impossible. What the wave really moves is where the boost is worth
     * spending: a bendier course has fewer fast stretches (see FAST_SLOPE).
     */
    this._ampScale = 1 + WAVE_AMP * this._waveT;
    /** What a mistake costs on this wave. See DIRT_WAVE. */
    this._dirtMul = DIRT_MUL * (1 - DIRT_WAVE * this._waveT);
    this._wideTime = WIDE_DRAG_TIME * (1 + WIDE_WAVE * this._waveT);

    /**
     * STRUCTURAL VARIATION FROM `ctx.occurrence`, AND NOTHING ELSE FROM IT.
     *
     * The second time a run deals this rite the whole course is MIRRORED: every
     * left-hander is a right-hander, the gates hang on the other side of the
     * apexes, and the gold scatters the other way. A player who learned the first
     * one by feel has to read the second one.
     *
     * It is the safe kind of variation because it is an isometry. The composite
     * is negated, the nugget offsets are negated with it, and `#apexNear`
     * maximises an absolute value — so the mirrored course is the original course
     * seen in a mirror, with the same corner radii, the same lateral rates, the
     * same gate widths and therefore EXACTLY the same difficulty. `occurrence`
     * moves the shape and must never move the numbers (docs/MINIGAMES.md §4); a
     * reflection is the largest change that provably does not.
     *
     * Costs no `rand()`, so RAND_CALLS is untouched.
     */
    this._mirror = ((ctx.occurrence | 0) % 2 === 0) ? 1 : -1;

    // ---- 1. the track: three phases, and nothing else ---------------------
    this._phase = [ctx.rand() * Math.PI * 2, ctx.rand() * Math.PI * 2, ctx.rand() * Math.PI * 2];
    /**
     * The start-line normalisation, and it is not cosmetic — it is what makes
     * the idle score the same on every seed.
     *
     * `centreAt` returns the raw composite MINUS its value at s = 0, so the
     * course always begins exactly on the racing line. Without it the car's
     * starting level is wherever the three phases happened to land, and the idle
     * score depends on that: a seed whose start sits near the composite's modal
     * level (near zero, where a sum of sines spends most of its time) has the
     * road crossing back through the idle car over and over. Measured before
     * this line existed: idle averaged 0.096 but one seed in a few hundred paid
     * 0.45 — "look away and get paid" as a property of the seed, invisible to
     * everyone who did not roll it.
     */
    this._c0 = 0;
    this._c0 = this.centreAt(0);

    // ---- 2. the gates: hung on the apexes ---------------------------------
    // Each gate slides to the point of MAXIMUM |centreline| inside its window
    // rather than sitting at its nominal even spacing. Two reasons, and the
    // second is the load-bearing one:
    //
    //  - It is what a rally course does. A gate on the apex of a corner asks for
    //    a committed line; a gate on a straight asks for nothing.
    //  - The idle car holds level 0 forever (see _c0 above), and an apex is by
    //    construction the point FURTHEST from level 0 in its neighbourhood. So
    //    "throttle is automatic, therefore doing nothing still drives" resolves
    //    to about two gates out of twelve on every seed, rather than to two on
    //    most and nine on an unlucky one.
    //
    // The window is under half the nominal spacing, so the gates cannot reorder
    // and `#resolveGates` can stay a single forward scan.
    /** @type {{s:number, hw:number}[]} */
    this.gates = [];
    for (let i = 0; i < GATE_COUNT; i++) {
      this.gates.push({
        s: this.#apexNear(GATE_S0 + i * GATE_STEP),
        hw: GATE_HW_MIN + ctx.rand() * GATE_HW_SPAN,
      });
    }

    // ---- 3. the gold ------------------------------------------------------
    // Evenly spaced in DISTANCE and scattered only in LATERAL offset. Jittering
    // the spacing too produces clumps and long empty stretches, and a pickup you
    // cannot see coming is not a decision, it is a lottery.
    /** @type {{s:number, u:number, taken:boolean}[]} */
    this.coins = [];
    const spread = COIN_SPREAD * this._mirror;
    for (let i = 0; i < COIN_COUNT; i++) {
      this.coins.push({
        s: COIN_S0 + i * COIN_STEP,
        u: (ctx.rand() * 2 - 1) * spread,
        taken: false,
      });
    }

    // ---- 3b. the fast stretches -------------------------------------------
    // Found ONCE, here, because the track is a pure function of distance and so
    // are they. Computing them per frame would be the same answer at ~300 cosine
    // evaluations a frame; computing them per press would make the rule invisible
    // until after the player had spent the charge.
    /** @type {{s0:number, s1:number}[]} */
    this.fastZones = this.#findFastZones();

    // ---- 4. the field -----------------------------------------------------
    this.rivals = new SeededRivals(ctx.rand, { count: RIVAL_COUNT, wave: ctx.wave });

    // ---- 5. presentation noise, from ONE draw -----------------------------
    // The view seeds its scenery (trees, rocks, hills) from this, so no amount
    // of scenery detail can ever move the rand budget. docs/MINIGAMES.md §3.
    this.fxSeed = Math.floor(ctx.rand() * 0xffffffff);

    // ---- state ------------------------------------------------------------
    this.t = 0;
    this.s = 0;                       // distance along the track
    this.x = this.centreAt(0);        // WORLD lateral position, not an offset
    this.vx = 0;
    this.speed = 0;
    this._prevS = 0;
    this._prevX = this.x;

    this.boostLeft = BOOST_CHARGES;
    this.boostT = 0;
    /** Was the burning boost lit inside a fast stretch? Latched at ignition. */
    this.boostHot = false;
    /** How many of the three were spent well. Not scored — the HUD and the tests read it. */
    this.boostsHot = 0;
    this.dragT = 0;

    this.gatesHit = 0;
    /**
     * Which gates were run wide. The view turns those arches red for the rest
     * of the race. A bounded array — at most GATE_COUNT entries.
     * @type {number[]}
     */
    this.missedGates = [];
    /**
     * Gate LINES crossed, inside or wide. Not part of the score — it exists so a
     * test can prove the rule the idle score depends on: an idle car crosses
     * nearly every gate line and is credited with almost none of them.
     */
    this.gatesPassed = 0;
    this.coinsTaken = 0;
    this.nextGate = 0;

    /** Set when the flag is crossed; Infinity means "never got there". */
    this.finishT = Infinity;
    this.finished = false;
    /** Latched when the flag or the clock ends the race. See `update`. */
    this._over = false;

    /** Cached standings, for the HUD only. score() recomputes and never reads these. */
    this.place = RIVAL_COUNT + 1;
    this.beaten = 0;
    /** Which rivals are ahead, with PASS_GAP of hysteresis. Drives the overtake cues only. */
    this._rivalAhead = Array.from({ length: RIVAL_COUNT }, () => true);
    /** Each rival's finish time is a pure function of its id, so it is solved once. */
    this._rivalFt = Array.from({ length: RIVAL_COUNT }, (_, id) => this.#rivalFinishTime(id));

    this._events = [{ type: 'start' }];
    this._started = false;
  }

  // ---- the track --------------------------------------------------------

  /**
   * Lateral position of the centreline at distance `s`, in world units.
   *
   * PURE, and that is the entire point. No `this.t`, no accumulated heading, no
   * random. Sampled at 500 arbitrary distances by two instances on one seed it
   * agrees to the bit, which is the property that lets two clients race the same
   * course without exchanging a byte.
   */
  centreAt(s) {
    const p = this._phase, m = this._mirror, a = this._ampScale * m;
    return a * (
      WAVE_A[0] * Math.sin(WAVE_K[0] * s + p[0])
      + WAVE_A[1] * Math.sin(WAVE_K[1] * s + p[1])
      + WAVE_A[2] * Math.sin(WAVE_K[2] * s + p[2])
    ) - this._c0;
  }

  /**
   * d(centreline)/ds — the exact derivative of `centreAt`, not a finite
   * difference. Written out because it is used every step for the centrifugal
   * slide, and because a divided difference would make the car's handling depend
   * on the sampling epsilon, which is precisely the kind of hidden constant that
   * makes two clients disagree after a few hundred steps.
   */
  slopeAt(s) {
    const p = this._phase, m = this._mirror, a = this._ampScale * m;
    return a * (
      WAVE_A[0] * WAVE_K[0] * Math.cos(WAVE_K[0] * s + p[0])
      + WAVE_A[1] * WAVE_K[1] * Math.cos(WAVE_K[1] * s + p[1])
      + WAVE_A[2] * WAVE_K[2] * Math.cos(WAVE_K[2] * s + p[2])
    );
  }

  /**
   * The distance inside `sNom ± GATE_APEX_W` where the centreline is furthest
   * from the start line. A fixed-count scan, not a solver: the derivative has
   * three terms and a closed form would be a root-finder with a branch count
   * that depends on the phases — variable work in `init`, for a number that only
   * has to be right to a few centimetres.
   */
  #apexNear(sNom) {
    let best = sNom, bestV = -1;
    for (let i = 0; i <= GATE_APEX_STEPS; i++) {
      const s = sNom - GATE_APEX_W + (2 * GATE_APEX_W * i) / GATE_APEX_STEPS;
      const v = Math.abs(this.centreAt(s));
      if (v > bestV) { bestV = v; best = s; }
    }
    return best;
  }

  /**
   * THE FAST STRETCHES: every run of track over which the road stays straight
   * for the next BOOST_REACH units.
   *
   * A pure function of the track, so it is a property of the SEED and not of the
   * run — two clients light up the same stretches, and a player can be told about
   * one before reaching it. The scan is a fixed number of steps over a fixed
   * length, so it costs the same on every seed and every wave.
   *
   * Zones shorter than FAST_MIN_LEN are dropped. A one-unit sliver of straight
   * road is not a place you can decide to be: at 7.4 u/s it is a seventh of a
   * second, and offering the player a reward they can only collect by accident is
   * worse than not offering it.
   */
  #findFastZones() {
    const zones = [];
    let open = -1;
    const end = TRACK_LEN + BOOST_REACH;
    for (let s = 0; s <= end; s += FAST_STEP) {
      let worst = 0;
      for (let d = 0; d <= BOOST_REACH; d += FAST_STEP * 2) {
        const v = Math.abs(this.slopeAt(s + d));
        if (v > worst) worst = v;
      }
      const fast = worst <= FAST_SLOPE;
      if (fast && open < 0) open = s;
      if (!fast && open >= 0) {
        if (s - open >= FAST_MIN_LEN) zones.push({ s0: open, s1: s });
        open = -1;
      }
    }
    if (open >= 0 && end - open >= FAST_MIN_LEN) zones.push({ s0: open, s1: end });
    return zones;
  }

  /** Is distance `s` inside a fast stretch? A short scan over a short list. */
  isFast(s) {
    for (const z of this.fastZones) {
      if (s >= z.s0 && s <= z.s1) return true;
      if (z.s0 > s) break;
    }
    return false;
  }

  /**
   * A rival's lateral position at time `t`, relative to the centreline.
   *
   * Derived from the id rather than drawn, so it costs no rand and can never
   * disagree between two clients. Presentation only: the standings read
   * distance, never this. A rival that weaves reads as a driver; one pinned to
   * the centreline reads as a train.
   */
  rivalLateral(id, t) {
    return RIVAL_WEAVE * Math.sin(1.3 * t + id * 2.399);
  }

  /** A rival's fraction of the course at wall-clock time `t`. See RIVAL_CLOCK. */
  rivalProgress(id, t) {
    return Math.min(1, this.rivals.positionAt(id, t / this._rivalClock) + (GRID_GAP * (id + 1)) / TRACK_LEN);
  }

  /** A rival's distance along the track at wall-clock time `t`. */
  rivalDist(id, t) {
    return this.rivalProgress(id, t) * TRACK_LEN;
  }

  // ---- simulation -------------------------------------------------------

  update(dt, input) {
    // ONE LATCH, NOT TWO CONDITIONS. The host stops calling `update` after a
    // true, but `assertRiteContract` deliberately keeps going for 1 500 steps to
    // prove the rite stays finite past its own clock — and a rite that keeps
    // integrating after the flag would still be collecting gold in that test
    // while scoring off a distance no player was given time to cover.
    if (this._over) return true;
    this._started = true;

    this._prevS = this.s;
    this._prevX = this.x;
    this.t += dt;

    // ---- steering ---------------------------------------------------------
    // THE ARROWS ONLY. The pointer used to steer too ("the car goes where the
    // pointer is"), and under a chase camera that rule drove the car by itself:
    // the camera follows the road, so a mouse resting on the stage kept picking
    // the centreline and a hands-off run scored ~0.5. A parked hand must be an
    // idle car, so the pointer has no say in where the car goes.
    const ax = input.axis?.x || 0;
    const cmd = ax > 0 ? 1 : ax < 0 ? -1 : 0;
    const k = Math.min(1, dt / LAT_TAU);
    this.vx += (cmd * LAT_SPEED - this.vx) * k;
    this.x += this.vx * dt;

    // ---- understeer, and why an idle car ends up in the scrub --------------
    // The ruts push you OUTWARD: the further you already are from the racing
    // line, the harder the car wants to go further. `u = 0` is an equilibrium
    // and it is an UNSTABLE one, so holding the line is something the player
    // does continuously rather than something they set once.
    //
    // THIS IS ALSO WHAT MAKES THE IDLE SCORE A PROPERTY OF THE RITE INSTEAD OF A
    // PROPERTY OF THE SEED. Measured without it: an idle car drives dead
    // straight, so whether it threads the gates depends entirely on whether the
    // centreline happens to wander back through the level it started at — mean
    // ratio 0.06, but one seed in twenty paid over 0.15 and one in a few hundred
    // paid 0.38. "Start it and look away" being profitable on 5 % of seeds is
    // still profitable, and it is invisible to anyone who did not roll one.
    // With the divergence, every seed puts an unattended car in the scrub inside
    // the first few seconds, and the exponent — not the terrain — is what does
    // it. DRIFT_RATE is small enough (a time constant of ~1.2 s) that countering
    // it costs a fraction of the available lateral authority.
    this.x += DRIFT_RATE * (this.x - this.centreAt(this.s)) * dt;

    // ---- and the car slides to the OUTSIDE of every corner -----------------
    // Gravel. The back steps out, so a corner has to be steered INTO rather than
    // merely not steered away from. Physically it is the centrifugal half of the
    // same story as the line above; mechanically it is what closes the last hole
    // in the idle score. The divergence above is unstable but AGNOSTIC about
    // direction, so a seed can hand an unattended car a drift that happens to
    // shadow the road for a while — measured at 2 seed/wave pairs in 4 400,
    // paying up to 0.23. This term is a function of the track's own slope, so it
    // pushes AWAY from wherever the road is going, always, on every seed.
    this.x -= CENTRIFUGAL * this.slopeAt(this.s) * (this.speed || BASE_SPEED) * dt;

    // ---- boost ------------------------------------------------------------
    // A press while already boosting is IGNORED and costs no charge. Forgiving
    // on purpose: a double-click should not silently burn a third of the
    // player's supply.
    //
    // WHERE the charge is spent is decided HERE and latched for the whole burn,
    // not re-evaluated per step. A boost that faded out as the car left the fast
    // stretch would be a boost whose value depended on how long the zone had left
    // when you pressed — unreadable, and it would punish taking a zone late by
    // more than taking it never. Ignite hot or ignite cold; the answer is fixed
    // at the moment of the press, which is the moment the player made a choice.
    if ((input.action | 0) > 0 && this.boostLeft > 0 && this.boostT <= 0) {
      this.boostLeft--;
      this.boostT = BOOST_TIME;
      this.boostHot = this.isFast(this.s);
      this.boostsHot += this.boostHot ? 1 : 0;
      this.#cue(this.boostHot ? 'good' : 'tick', 'boost', this.x - this.centreAt(this.s), -1);
    }
    if (this.boostT > 0) this.boostT = Math.max(0, this.boostT - dt);

    // ---- throttle ---------------------------------------------------------
    const uNow = this.x - this.centreAt(this.s);
    const onRoad = Math.abs(uNow) <= HALF_W;
    const launch = clamp(this.t / LAUNCH_T, 0, 1);
    let speed = BASE_SPEED * (LAUNCH_FROM + (1 - LAUNCH_FROM) * launch);
    if (this.boostT > 0) {
      speed *= !onRoad ? BOOST_DIRT_MUL : this.boostHot ? BOOST_MUL : BOOST_COLD_MUL;
    }
    if (!onRoad) speed *= this._dirtMul;
    if (this.dragT > 0) { speed *= WIDE_DRAG_MUL; this.dragT = Math.max(0, this.dragT - dt); }
    this.s += speed * dt;
    this.speed = speed;

    // The rope. Clamped against the CENTRELINE rather than against world x, so
    // the marshals follow the course instead of standing in a straight line.
    const cNow = this.centreAt(this.s);
    if (this.x > cNow + ROPE) { this.x = cNow + ROPE; this.vx = Math.min(this.vx, 0); }
    if (this.x < cNow - ROPE) { this.x = cNow - ROPE; this.vx = Math.max(this.vx, 0); }

    this.#resolveGates();
    this.#resolveCoins();

    const st = this.#standings();
    this.place = st.place;
    this.beaten = st.beaten;
    this.#overtakes();

    if (this.s >= FLAG_AT) {
      this.s = FLAG_AT;
      this.finishT = this.t;
      this.finished = true;
      this._over = true;
      this.#cue('perfect', 'flag', this.x - this.centreAt(this.s));
      return true;
    }
    if (this.t >= DURATION) { this._over = true; return true; }
  }

  /**
   * Credit a gate only when the car passes INSIDE it.
   *
   * THIS IS THE RULE THE WHOLE IDLE SCORE RESTS ON. The throttle is automatic,
   * so a player who does nothing still drives — straight, at constant lateral
   * position, while the course snakes away underneath. If a gate counted for
   * being merely reached, that idle car would score around 0.4 and "start the
   * rite and look away" would be a paying strategy. Crediting only the inside
   * puts it at nothing at all. `tests/unit/offroad-rite.test.js` pins both
   * halves across ten seeds and three waves: an idle run CROSSES eight or nine
   * of the twelve gate lines and is CREDITED with at most one, for a ratio
   * between 0.000 and 0.049. Delete the `Math.abs(u) <= gate.hw` below and four
   * assertions go red, including the shared contract's idle ceiling.
   */
  #resolveGates() {
    while (this.nextGate < this.gates.length && this.gates[this.nextGate].s <= this.s) {
      const i0 = this.nextGate;
      const gate = this.gates[i0];
      // Where the car actually was at the moment it cut the line, not where it
      // is now: at 11 u/s a step is 0.19 u of travel and the lateral can move a
      // third of a gate width inside one.
      const span = this.s - this._prevS;
      const f = span > 1e-9 ? clamp((gate.s - this._prevS) / span, 0, 1) : 1;
      const xAt = lerp(this._prevX, this.x, f);
      const u = xAt - this.centreAt(gate.s);
      this.gatesPassed++;
      if (Math.abs(u) <= gate.hw) {
        this.gatesHit++;
        this.#cue('good', 'gate', u, i0);
      } else {
        this.dragT = this._wideTime;
        this.missedGates.push(i0);
        this.#cue('miss', 'gate', u, i0);
      }
      this.nextGate++;
    }
  }

  #resolveCoins() {
    for (let i = 0; i < this.coins.length; i++) {
      const c = this.coins[i];
      if (c.taken || c.s > this.s || c.s < this._prevS) continue;
      const span = this.s - this._prevS;
      const f = span > 1e-9 ? clamp((c.s - this._prevS) / span, 0, 1) : 1;
      const u = lerp(this._prevX, this.x, f) - this.centreAt(c.s);
      if (Math.abs(u - c.u) <= COIN_R) {
        c.taken = true;
        this.coinsTaken++;
        this.#cue('gold', 'coin', c.u, i);
      }
    }
  }

  /**
   * One presentation cue. `what` says which object it is about ('gate',
   * 'coin', 'boost', 'flag') and `i` which one, because the host's sound table
   * is keyed on `type` alone and 'good' is both a clean gate and a hot boost.
   * `x` is the lateral offset from the centreline, in field units.
   */
  #cue(type, what, x = 0, i = -1) {
    if (this._events.length >= MAX_EVENTS) return;
    this._events.push({ type, what, x, i });
  }

  // ---- standings --------------------------------------------------------

  /**
   * Who is where. Furthest at the whistle wins; among those who took the flag,
   * the earliest wins.
   *
   * ONE ORDER, NOT TWO, and the reason is a real hole in the naive version.
   * "Furthest at the whistle" alone breaks at high waves: `positionAt` clamps at
   * 1, so once the field is quick enough to finish inside the clock every rival
   * ties at the flag and the 20 % of the score they carry stops being winnable —
   * a difficulty curve that ends in a wall. "Earliest finish" alone breaks at low
   * waves in the other direction: nobody finishes, so every time is an
   * extrapolation and a car that never left second gear can extrapolate its way
   * past a ghost.
   *
   * So the two are stacked into a single monotone key: a finisher's key is
   * `2 - finishTime / DURATION` (always above 1, better when earlier) and a
   * non-finisher's is `distance / TRACK_LEN` (always at or below 1). Total order,
   * continuous inside each branch, no ties outside exact simultaneity.
   *
   * PURE. Reads instance state, writes none — `update` caches the result for the
   * HUD, `score()` recomputes it, and the two can never disagree.
   */
  #standings() {
    const mine = this.#myKey();
    let ahead = 0, beaten = 0;
    for (let id = 0; id < RIVAL_COUNT; id++) {
      if (this.#rivalKey(id) >= mine) ahead++; else beaten++;
    }
    return { place: ahead + 1, beaten };
  }

  #myKey() { return this.finished ? 2 - this.finishT / DURATION : this.s / FLAG_AT; }

  #rivalKey(id) {
    const ft = this._rivalFt[id];
    return ft <= this.t ? 2 - ft / DURATION : this.rivalProgress(id, this.t);
  }

  /**
   * One cue per overtake, either way. The race was invisible when you led it:
   * the ghosts fade once level with you, so passing one was a silent change of
   * a digit. PASS_GAP of hysteresis on the same key the standings use, so two
   * cars wheel to wheel never chatter.
   */
  #overtakes() {
    const mine = this.#myKey();
    for (let id = 0; id < RIVAL_COUNT; id++) {
      const lead = this.#rivalKey(id) - mine;
      if (this._rivalAhead[id] && lead < -PASS_GAP) {
        this._rivalAhead[id] = false;
        this.#cue('tick', 'pass', this.rivalLateral(id, this.t), id);
      } else if (!this._rivalAhead[id] && lead > PASS_GAP) {
        this._rivalAhead[id] = true;
        this.#cue('claim', 'passed', this.rivalLateral(id, this.t), id);
      }
    }
  }

  /**
   * When rival `id` completes the course, by bisection on `positionAt`.
   *
   * Bisection rather than algebra because the pace and the skill scaling live
   * INSIDE `SeededRivals` and reaching in for them would be a second copy of its
   * arithmetic — the copy that stays right until someone tunes the original.
   * `positionAt` is monotone non-decreasing in t, which is all bisection needs;
   * 44 halvings of a 512 s window resolve to well under a microsecond, and the
   * whole thing runs three times per call to score(), not per frame.
   */
  #rivalFinishTime(id) {
    let lo = 0, hi = 512;
    if (this.rivalProgress(id, hi) < 1) return Infinity;
    for (let i = 0; i < 44; i++) {
      const mid = (lo + hi) / 2;
      if (this.rivalProgress(id, mid) >= 1) hi = mid; else lo = mid;
    }
    return hi;
  }

  // ---- score ------------------------------------------------------------

  score() {
    const st = this.#standings();
    const gates = this.gatesHit / GATE_COUNT;
    const coins = this.coinsTaken / COIN_COUNT;
    const rivals = st.beaten / RIVAL_COUNT;
    const ratio = clamp(W_GATES * gates + W_COINS * coins + W_RIVALS * rivals, 0, 1);

    const headline = !this._started ? 'Did not start'
      : ratio >= 0.92 ? 'Course record'
      : ratio >= 0.75 ? 'Clean run'
      : ratio >= 0.5 ? 'On the pace'
      : ratio >= 0.25 ? 'Off the racing line'
      : 'In the scrub';

    // THE CARD ITEMISES THE BLEND. A three-way weighted sum is fine arithmetic
    // and completely opaque on screen: "0.61" tells a player nothing about what
    // to do differently, and "9/12 gates, 21 gold, 2nd of 4" tells them exactly.
    const detail = `${this.gatesHit}/${GATE_COUNT} gates · ${this.coinsTaken} gold · `
      + `${PLACES[clamp(st.place - 1, 0, PLACES.length - 1)]} of ${RIVAL_COUNT + 1}`;

    return { ratio, headline, detail };
  }

  drainEvents() { const e = this._events; this._events = []; return e; }
  teardown() { this._events = []; }
}

/** @type {import('../contract.js').MinigameDef} */
export const OFFROAD_RITE = {
  id: 'offroad',
  name: 'Offroad Racing',
  hint: 'Gates, gold and your finishing place all pay',
  rules: [
    'The car drives itself. Steer it through the gates and over the gold.',
    'Stay on the dirt road: grass and missed gates slow you down.',
    'You have 3 boosts. They are strongest on the yellow arrows.',
  ],
  keys: [
    { keys: ['←', '→'], action: 'Steer' },
    { keys: ['Space', 'Click'], action: 'Boost' },
  ],
  duration: DURATION,
  theme: 'offroad',
  eyebrow: 'Rally',
  abandonNote: 'You pulled off the track',
  // Steered, not aimed: a crosshair over a car would read as "click the car".
  cursor: 'default',
  create: () => new OffroadRite(),
  view: () => import('./OffroadView.js'),
};

export {
  OffroadRite, RAND_CALLS, DURATION, TRACK_LEN, FLAG_AT, GATE_COUNT, COIN_COUNT,
  RIVAL_COUNT, BOOST_CHARGES, BOOST_TIME, HALF_W, COIN_R,
};
