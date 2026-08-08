/**
 * OFFROAD RACING — steer a dirt track, take the gates, sweep the gold, and use
 * the two verbs the other five rites do not have.
 *
 * "course de voiture avec des points de passage, avec un boost pour accélérer et
 * une bombe pour bloquer ses adversaires. Des golds sont à ramasser sur la
 * route." Twelve gates, thirty nuggets, three boosts, two bombs, 26 seconds.
 *
 * WHY IT IS TOP-DOWN AND NOT PSEUDO-3D. The obvious idea is the Out Run road —
 * a stack of trapezoids widening toward the camera — and it is a trap in THIS
 * painter. There is no perspective texture mapping and no path primitive, so the
 * road would be flat-shaded quads whose seams pop as they scroll and whose
 * "distance" is carried by nothing but width. That does not read as a road
 * receding, it reads as a rendering bug. Top-down is honest about what the
 * toolkit can express: one uniform scale, one vertical scroll, and every
 * position on screen means exactly what it is. The sense of speed comes from the
 * ground rushing past, which top-down gets for free and fake-3D has to fake
 * twice.
 *
 * WHAT EACH VERB IS WORTH, MEASURED, BECAUSE THE LAST VERSION'S ANSWER WAS "NOTHING".
 *
 * A clean-driving bot, 40 seeds, mean ratio, one option removed at a time. This
 * table is the rite's specification as much as any sentence above it, and
 * `tests/unit/offroad-rite.test.js` re-derives the two rows that matter so an
 * "improvement" cannot quietly flatten it again:
 *
 *                            w3      w28     w53
 *   everything            0.794   0.750   0.704
 *   boost mashed          0.769   0.731   0.678
 *   boost anywhere on road0.768   0.730   0.674
 *   never boost           0.756   0.718   0.662
 *   never bomb            0.768   0.730   0.672
 *   ignore the gold       0.584   0.485   0.347
 *
 * Read it in this order. Spending the three charges on the fast stretches beats
 * mashing them by 0.025 / 0.019 / 0.026 and beats never pressing at all by
 * 0.038 / 0.032 / 0.042 — so the button is worth having AND worth thinking
 * about, which are two different claims and the old build satisfied neither
 * (mashing then tied or beat deliberate play at every wave; see BOOST_DIRT_MUL).
 * The bomb is worth 0.026 / 0.020 / 0.032. And the gold is still the largest
 * single thing on the table, which is right: this is a race with a collection
 * layered on it, and the collection is the part you are always doing.
 *
 * THE ONE RITE WHERE THE TWO MOUSE BUTTONS ARE TWO DIFFERENT THINGS. Everywhere
 * else (`luckyshot`, `hunt`, `fishing`) left, right and Space are the same verb,
 * because a right click on a macOS trackpad is a two-finger press with a settle
 * delay and making that the only path to the primary verb handicaps one platform
 * in a reaction game. Here the distinction earns its keep: boost and bomb are
 * genuinely different decisions, both are keyboard-reachable (Space / Digit1),
 * and neither is time-critical to the millisecond.
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
 */

import { clamp, lerp } from '../contract.js';
import { mulberry32 } from '../../core/Rng.js';
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

/** Where the car sits on screen. Low, so most of the field is the road ahead. */
const CAR_Y = -3.15;

/** How far ahead the player can see, in world units. Field top (4.5) minus CAR_Y. */
const LOOKAHEAD = 4.5 - CAR_Y;

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

const BOMB_CHARGES = 2;
/** How far behind the car a mine is dropped. You block the people behind you. */
const MINE_BACK = 2.0;
/** Lateral catch radius. Wider than the rivals' weave, narrower than the road. */
const MINE_R = 1.05;
/** Seconds a mine costs a rival. The one WRITE into RivalSource in the whole game. */
const MINE_PENALTY = 1.5;

const RIVAL_COUNT = 3;
/** Amplitude of a rival's weave across the road, in world units. Pure, no draws. */
const RIVAL_WEAVE = 1.0;
/**
 * The rivals' clock, as a fraction of the player's.
 *
 * `SeededRivals` is tuned so a mid-skill ghost takes about COURSE_SECONDS (22 s)
 * to run a generic course; this rite's course takes a clean driver about 21 s,
 * and 22 against 21 puts the whole field inside a second of each other, where
 * the 20 % of the score they carry becomes a coin flip. Running them on a clock
 * 13 % short spreads the field across roughly 20-28 s, which is the range the
 * player's own driving spans.
 *
 * SCALING THE RESULT RATHER THAN REACHING INTO rivals.js, exactly as that
 * module's docblock asks: the shared constants are what make the six rites feel
 * like one game, and a rite that wants a different rhythm is entitled to a
 * different rhythm, not to a different `CLAIM_BASE` for everybody.
 *
 * Consequence to keep in mind: MINE_PENALTY is denominated in RIVAL seconds, so
 * a mine costs MINE_PENALTY * RIVAL_CLOCK seconds of wall clock.
 *
 * WHY IT IS NO LONGER 0.87. At 0.87 the field ran roughly 13 % quicker than its
 * own tuning intends, and the arithmetic of `SeededRivals.pressure` (0.42 at wave
 * 3, 0.78 at wave 53) then put the whole roster past a clean driver by the end of
 * the run: measured over 40 seeds, the best available driving beat 3.00 of 3
 * rivals at wave 3 and 1.63 of 3 at wave 53, and on the five calibration seeds it
 * was 0.2 of 3. That is a flat pay cut of most of the 20 % this term carries,
 * applied to a player who did everything right, with no counterplay — two 1.5 s
 * mines cannot close a three-way gap. A difficulty axis that removes the ability
 * to win rather than making winning harder is a wall, not a curve.
 *
 * At 1.06 the field is a little SLOWER than its generic tuning, which is the
 * right correction for a course a clean driver covers in ~21 s against the 22 s
 * `COURSE_SECONDS` assumes. A clean run now finishes 2nd of 4 at wave 53 (2.05 of
 * 3 beaten) and still 1st at wave 3 — the late game is a race you can lose rather
 * than one you have already lost, and the difficulty of the late game comes from
 * the road instead, which is the thing the player can actually drive at.
 */
const RIVAL_CLOCK = 1.55;

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

/**
 * The road is drawn as one closed strip: STRIP_HALF samples down the left edge,
 * the same samples back up the right. Sized from the visible window (4.0 behind
 * the car plus LOOKAHEAD plus a margin) so the buffer is a module constant and
 * the per-frame work has no length to grow.
 */
const STRIP_STEP = 0.55;
const STRIP_HALF = Math.ceil((4.0 + LOOKAHEAD + 0.6) / STRIP_STEP) + 1;
/**
 * The buffer itself, at MODULE scope rather than on the instance, and that is
 * deliberate: `draw` must not mutate the rite (the contract says so and this
 * rite's test proves it), and a scratch buffer hanging off `this` is a mutation
 * however cosmetic its contents. Safe to share because the host draws exactly
 * one rite at a time on one thread — stated here rather than assumed, because it
 * is the only thing making this legal.
 */
const STRIP = Array.from({ length: 2 * STRIP_HALF }, () => [0, 0]);

/** Scenery repeats on this period, so a fixed pool tiles an unbounded track. */
const SCENERY_SPAN = 40;
const SCENERY_N = 72;

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
    this._pal = readPalette();

    /** 0 at the first rite of a run, 1 at the last. The difficulty axis, once. */
    this._waveT = clamp((ctx.wave - 3) / 50, 0, 1);

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
    // Everything cosmetic hangs off this generator so that no amount of scenery
    // detail can ever move the rand budget. docs/MINIGAMES.md §3.
    const nz = mulberry32(Math.floor(ctx.rand() * 0xffffffff));
    /** @type {{s:number, side:number, u:number, r:number, kind:number}[]} */
    this.scenery = [];
    for (let i = 0; i < SCENERY_N; i++) {
      this.scenery.push({
        s: nz() * SCENERY_SPAN,
        side: nz() < 0.5 ? -1 : 1,
        u: HALF_W + 0.35 + nz() * 5.4,
        r: 0.1 + nz() * 0.26,
        kind: nz(),
      });
    }

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
    this.bombsLeft = BOMB_CHARGES;
    this.dragT = 0;

    /** @type {{s:number, u:number, live:boolean, flash:number}[]} */
    this.mines = [];
    this.bombHits = 0;

    this.gatesHit = 0;
    /**
     * Which gates were run wide. Drawn as a permanent red cross on the gate, so
     * a player who looked away during the flash can still see what happened when
     * they glance at the mirror. A bounded array — at most GATE_COUNT entries.
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

    this._events = [{ type: 'start' }];
    this._started = false;
    /** Cosmetic only, driven in update because draw must not mutate. */
    this._shake = 0;
    this._goldFlash = 0;
    this._gateFlash = 0;
    this._boostFlash = 0;
    /** The MISSED wash, and which side of the gate the car was on. See `draw`. */
    this._missFlash = 0;
    this._missSide = 1;
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
   * disagree between two clients. It exists for ONE reason: a bomb has to be
   * aimable. A rival pinned to the centreline would make every mine a coin flip
   * on distance alone; a rival that visibly weaves is a rival you can wait for.
   */
  rivalLateral(id, t) {
    return RIVAL_WEAVE * Math.sin(1.3 * t + id * 2.399);
  }

  /** A rival's fraction of the course at wall-clock time `t`. See RIVAL_CLOCK. */
  rivalProgress(id, t) {
    return this.rivals.positionAt(id, t / RIVAL_CLOCK);
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
    const tPrev = this.t;
    this.t += dt;

    // ---- steering ---------------------------------------------------------
    // Keys win over the pointer when both are live: a player holding an arrow
    // has made a deliberate choice, and mixing the two produces a car that
    // fights itself.
    const ax = input.axis?.x || 0;
    let cmd = 0;
    if (ax !== 0) {
      cmd = ax > 0 ? 1 : -1;
    } else if (input.inside) {
      // Positional: the car goes where the pointer is. `u` is already the car's
      // screen x (see the mapping in draw), so this is a straight difference.
      cmd = clamp((input.x - (this.x - this.centreAt(this.s))) / 2.0, -1, 1);
    }
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
      this._boostFlash = 1;
      this.#cue(this.boostHot ? 'good' : 'tick', this.x - this.centreAt(this.s));
    }
    if (this.boostT > 0) this.boostT = Math.max(0, this.boostT - dt);

    // ---- bomb -------------------------------------------------------------
    // Right button OR Digit1, for the same reason the boost takes Space: no verb
    // in this game is reachable only through the secondary button.
    const bomb = (input.altAction | 0) > 0 || ((input.slots?.[0] | 0) > 0);
    if (bomb && this.bombsLeft > 0) {
      this.bombsLeft--;
      this.mines.push({
        s: Math.max(0, this.s - MINE_BACK),
        u: this.x - this.centreAt(this.s),
        live: true,
        flash: 0.35,
      });
      // 'good', not 'miss': laying a trap is a deliberate positive act. 'boom'
      // is saved for the moment it actually catches someone, which is the part
      // that deserves the explosion and the stage kick.
      this.#cue('good', this.x - this.centreAt(this.s));
    }

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
    this.#resolveMines(tPrev, this.t);

    // ---- cosmetics (in update, never in draw) -----------------------------
    this._shake = Math.max(0, this._shake - dt * 3);
    this._goldFlash = Math.max(0, this._goldFlash - dt * 2.6);
    this._boostFlash = Math.max(0, this._boostFlash - dt * 2.2);
    this._gateFlash = Math.max(0, this._gateFlash - dt * 2.2);
    this._missFlash = Math.max(0, this._missFlash - dt * 1.4);
    for (const m of this.mines) if (m.flash > 0) m.flash = Math.max(0, m.flash - dt);

    const st = this.#standings();
    this.place = st.place;
    this.beaten = st.beaten;

    if (this.s >= FLAG_AT) {
      this.s = FLAG_AT;
      this.finishT = this.t;
      this.finished = true;
      this._over = true;
      this.#cue('perfect');
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
        this._gateFlash = 1;
        this.#cue('good', u);
      } else {
        this.dragT = this._wideTime;
        this._shake = 0.6;
        this.missedGates.push(i0);
        this._missFlash = 1;
        this._missSide = u > 0 ? 1 : -1;
        this.#cue('miss', u);
      }
      this.nextGate++;
    }
  }

  #resolveCoins() {
    for (const c of this.coins) {
      if (c.taken || c.s > this.s || c.s < this._prevS) continue;
      const span = this.s - this._prevS;
      const f = span > 1e-9 ? clamp((c.s - this._prevS) / span, 0, 1) : 1;
      const u = lerp(this._prevX, this.x, f) - this.centreAt(c.s);
      if (Math.abs(u - c.u) <= COIN_R) {
        c.taken = true;
        this.coinsTaken++;
        this._goldFlash = 1;
        this.#cue('gold', c.u);
      }
    }
  }

  /**
   * The bomb — the one place a ghost reacts to the player.
   *
   * A mine sits at a track distance and a lateral offset. When a rival's
   * distance crosses it within MINE_R laterally, `applyPenalty` fires and that
   * rival's ENTIRE FUTURE moves: every later position, every claim, its finishing
   * time and therefore the standings. Nothing is re-simulated and nothing is
   * stored — the penalty is an offset inside a pure function. That single write
   * is what makes "bloquer ses adversaires" mean something instead of being a
   * particle effect.
   *
   * One mine takes one rival. A mine that caught the whole field would make the
   * two charges strictly better than any driving.
   */
  #resolveMines(t0, t1) {
    for (const m of this.mines) {
      if (!m.live) continue;
      for (let id = 0; id < RIVAL_COUNT; id++) {
        const a = this.rivalDist(id, t0);
        const b = this.rivalDist(id, t1);
        if (!(a <= m.s && m.s <= b)) continue;
        if (Math.abs(this.rivalLateral(id, t1) - m.u) > MINE_R) continue;
        this.rivals.applyPenalty(id, MINE_PENALTY);
        m.live = false;
        m.flash = 0.5;
        this.bombHits++;
        this._shake = 1;
        this.#cue('boom', m.u);
        break;
      }
    }
  }

  #cue(type, x) {
    if (this._events.length >= MAX_EVENTS) return;
    this._events.push(x === undefined ? { type } : { type, x });
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
   * The bomb reads straight through it: MINE_PENALTY seconds of penalty either
   * pushes a rival's finish later or leaves them short of the flag, and both move
   * the key downward by construction.
   *
   * PURE. Reads instance state, writes none — `update` caches the result for the
   * HUD, `score()` recomputes it, and the two can never disagree.
   */
  #standings() {
    const mine = this.finished ? 2 - this.finishT / DURATION : this.s / FLAG_AT;

    let ahead = 0, beaten = 0;
    for (let id = 0; id < RIVAL_COUNT; id++) {
      const ft = this.#rivalFinishTime(id);
      const key = ft <= this.t ? 2 - ft / DURATION : this.rivalProgress(id, this.t);
      if (key >= mine) ahead++; else beaten++;
    }
    return { place: ahead + 1, beaten };
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

  // ---- draw -------------------------------------------------------------

  /**
   * THE SCREEN MAPPING, once, here, because everything below depends on it.
   *
   *   camera  = centreAt(s_car)              the road is centred under the car
   *   screenX = worldX - camera
   *   screenY = CAR_Y + (worldS - s_car)     one world unit per world unit
   *
   * Uniform scale on both axes, no compression, no perspective. The consequence
   * worth naming: the car's own screen x IS its offset from the centreline, so
   * "am I on the road" and "where am I on screen" are the same number and the
   * player never has to translate between them.
   *
   * MUTATES NOTHING. Every value it needs was computed in update; `alpha`
   * interpolates the car between the last two steps and nothing else.
   */
  draw(g, alpha) {
    const P = this._pal;
    const a = clamp(alpha ?? 0, 0, 1);
    const s = lerp(this._prevS, this.s, a);
    const x = lerp(this._prevX, this.x, a);
    const cam = this.centreAt(s);
    const u = x - cam;
    const sLo = s - 4.0;
    const sHi = s + LOOKAHEAD + 0.6;
    const boosting = this.boostT > 0;

    g.clipField(() => {
    g.save();
    if (this._shake > 0) g.translate(0, -0.06 * this._shake);

    // ---- ground -----------------------------------------------------------
    g.rect(0, 0, 16, 9, {
      fill: g.linearFill(0, 4.5, 0, -4.5, [
        [0, rgba(P.c.ink4, 0.16)],
        [0.55, rgba(P.c.ink4, 0.07)],
        [1, rgba(P.c.accent, 0.05)],
      ]),
    });

    // ---- the ground streaming past -----------------------------------------
    // THE SUBJECT OF THIS RITE IS SPEED AND THE FIRST BUILD HAD NO CUE FOR IT.
    // What was here was a pool of flat grey ellipses and thin vertical ticks on
    // a brown gradient, and in a still they read as potholes and scratches on the
    // canvas rather than as ground going past — damage, not motion. Three things
    // fix it and all three are functions of `s`, so they cost no state:
    //
    //  - every scenery item is a rock with a LIT TOP and a shadow, so it reads as
    //    an object sitting on the ground rather than as a hole in it;
    //  - each one drags a STREAK behind it whose length is the distance the car
    //    covers in ~0.11 s, so the streaks stretch when the car is quick and
    //    collapse to nothing when it is slow. That is the whole speedometer: at a
    //    boost they are twice as long as at a standstill;
    //  - and the streaks are warm rather than grey, so the scrub reads as dust.
    const vel = this.speed || BASE_SPEED;
    const streak = clamp(vel * 0.11, 0.08, 1.1);
    for (const it of this.scenery) {
      const base = it.s + Math.ceil((sLo - it.s) / SCENERY_SPAN) * SCENERY_SPAN;
      for (let ws = base; ws <= sHi; ws += SCENERY_SPAN) {
        const px = this.centreAt(ws) - cam + it.side * it.u;
        if (px < -8.6 || px > 8.6) continue;
        const py = CAR_Y + (ws - s);
        // The streak first, so the rock sits on top of its own motion blur.
        g.line(px, py, px, py - streak * (0.6 + it.r), rgba(P.c.accent, 0.16), it.r * 0.7, 'round');
        if (it.kind < 0.55) {
          // A rock: dark base, lit crown. Two shapes, one object.
          g.ellipse(px, py, it.r * 1.15, it.r * 0.72, 0, { fill: rgba(P.c.ink4, 0.55) });
          g.ellipse(px, py + it.r * 0.2, it.r * 0.72, it.r * 0.36, 0, { fill: rgba(P.c.accent, 0.28) });
        } else if (it.kind < 0.82) {
          // A tuft of scrub: three blades, leaning the way the car is going.
          for (const k of [-1, 0, 1]) {
            g.line(px + k * it.r * 0.45, py - it.r * 0.3,
              px + k * it.r * 0.7, py + it.r * 1.1, rgba(P.c.ink3, 0.4), 0.05, 'round');
          }
        } else {
          // A marker stake, with a shadow so it stands up off the ground.
          g.line(px + 0.06, py - 0.04, px + 0.06, py + it.r * 1.5, 'rgba(0,0,0,0.35)', 0.07, 'round');
          g.line(px, py, px, py + it.r * 1.6, rgba(P.c.ink2, 0.45), 0.06, 'round');
        }
      }
    }

    // ---- the road ---------------------------------------------------------
    // ONE POLYGON, NOT A CHAIN OF CAPSULES, and the first version was the chain.
    // A stadium per segment is the obvious way to sweep a width along a curve,
    // and it produces two artefacts at once on screen: the round caps bulge past
    // the edge so the border scallops, and — worse — a translucent fill STACKS in
    // every overlap, so the road is drawn as a string of brighter beads with dark
    // notches between them. Caught in a screenshot, not by a test, because
    // nothing about it throws. Down the left edge, back up the right, filled once.
    // The point buffer is allocated once at module load and MUTATED IN PLACE — a
    // rite that builds a fresh 50-entry array of pairs every frame allocates
    // megabytes a minute for a shape whose size never changes.
    //
    // TWO PASSES, NOT ONE, AND THE FIRST IS THE FIX FOR THE REAL BUG. The strip
    // used to be filled once at alpha 0.17, which in a rally game means the
    // subject of the picture — the surface you are driving on — was a warm smudge
    // that faded into the background before it reached the top of the frame. You
    // could not see where the road ENDED, which is the one thing the whole rite
    // asks you to judge. The shoulder is drawn wider and darker first so the road
    // has an edge to be brighter than, and the surface itself now goes on at 0.42.
    const strip = STRIP;
    const layStrip = (halfW) => {
      for (let i = 0; i < STRIP_HALF; i++) {
        const ws = sLo + i * STRIP_STEP;
        const c = this.centreAt(ws) - cam;
        const y = CAR_Y + (ws - s);
        const l = strip[i], r = strip[2 * STRIP_HALF - 1 - i];
        l[0] = c - halfW; l[1] = y;
        r[0] = c + halfW; r[1] = y;
      }
    };
    layStrip(HALF_W + 0.34);
    g.poly(strip, { fill: 'rgba(0,0,0,0.42)' });
    layStrip(HALF_W);
    // `poly`, not `blob`: the edges of a road are the edges of a road, and a
    // smoothing pass would round the two ends of the strip off into a lozenge.
    g.poly(strip, { fill: rgba(P.c.accent, 0.42) });

    // ---- the fast stretches, lit on the road --------------------------------
    // THE BOOST'S AFFORDANCE, and it is drawn rather than explained because a
    // rule the player cannot see is a rule the player cannot use. A charge lit
    // inside one of these runs at BOOST_MUL; anywhere else it is nearly wasted
    // (BOOST_COLD_MUL). So the stretch is painted as a brighter panel of surface
    // with chevrons pointing up it — the shape a road paints on itself when it
    // wants you to go — and it scrolls with the ground because it is a function
    // of distance, not of time.
    for (const z of this.fastZones) {
      if (z.s1 < sLo || z.s0 > sHi) continue;
      const a0 = Math.max(z.s0, sLo), a1 = Math.min(z.s1, sHi);
      const lit = this.boostLeft > 0 ? 0.16 : 0.07;
      for (let ws = a0; ws < a1; ws += STRIP_STEP) {
        const w1 = Math.min(ws + STRIP_STEP, a1);
        const c0 = this.centreAt(ws) - cam, c1 = this.centreAt(w1) - cam;
        const y0 = CAR_Y + (ws - s), y1 = CAR_Y + (w1 - s);
        g.poly([[c0 - HALF_W, y0], [c0 + HALF_W, y0], [c1 + HALF_W, y1], [c1 - HALF_W, y1]],
          { fill: rgba(P.c.goldHi, lit) });
      }
      // Chevrons, on the distance so they stream at the car's own speed.
      for (let ws = Math.ceil(a0 / 2.2) * 2.2; ws < a1 - 0.6; ws += 2.2) {
        const cx = this.centreAt(ws) - cam, cy = CAR_Y + (ws - s);
        const col = rgba(P.c.goldHi, this.boostLeft > 0 ? 0.5 : 0.18);
        g.line(cx - 0.5, cy, cx, cy + 0.42, col, 0.07, 'round');
        g.line(cx + 0.5, cy, cx, cy + 0.42, col, 0.07, 'round');
      }
    }

    // Edges, dashed on the DISTANCE itself rather than on a timer, so the dashes
    // rush at exactly the speed the car is doing and stop dead when it does.
    //
    // BRIGHT, THICK AND WHITE. They used to be the same grey at the same weight
    // as the wheel ruts three lines below, so the two read as four lane markings
    // on a highway and the actual EDGE of the drivable surface was indistinguish-
    // able from a decoration in the middle of it. The edge is the rule; it gets
    // the strongest mark on the road.
    for (const side of [-1, 1]) {
      for (let ws = Math.floor(sLo / 1.4) * 1.4; ws <= sHi; ws += 2.8) {
        const y0 = CAR_Y + (ws - s), y1 = CAR_Y + (ws + 1.1 - s);
        g.line(this.centreAt(ws) - cam + side * HALF_W, y0,
          this.centreAt(ws + 1.1) - cam + side * HALF_W, y1,
          rgba(P.c.ink, 0.85), 0.11, 'round');
      }
    }
    // A pair of wheel ruts down the racing line. Cheap, and it is what tells the
    // player where the line IS when no gate is in view — DARK and thin, so they
    // read as worn-in grooves in the surface rather than as painted lines.
    for (const side of [-0.5, 0.5]) {
      for (let ws = sLo; ws <= sHi; ws += 1.2) {
        g.line(this.centreAt(ws) - cam + side, CAR_Y + (ws - s),
          this.centreAt(ws + 1.2) - cam + side, CAR_Y + (ws + 1.2 - s),
          'rgba(0,0,0,0.3)', 0.16);
      }
    }

    // ---- gates ------------------------------------------------------------
    for (let i = 0; i < this.gates.length; i++) {
      const gate = this.gates[i];
      if (gate.s < sLo - 1 || gate.s > sHi) continue;
      const gx = this.centreAt(gate.s) - cam;
      const gy = CAR_Y + (gate.s - s);
      const done = i < this.nextGate;
      const next = i === this.nextGate;
      // THE STATE OF A GATE IS TOLD TWICE: once in colour and once in shape.
      // Under deuteranopia the gold of a live gate and the grey of a spent one
      // are close enough to be one colour, so a spent gate also loses its
      // crossbar and keeps only two short stubs, and a MISSED one is struck
      // through. See the note on the palette at the bottom of the file.
      const missed = done && this.missedGates.includes(i);
      const col = missed ? P.c.danger : done ? P.c.ink4 : next ? P.c.gold : P.c.ink2;
      const al = done ? (missed ? 0.7 : 0.35) : next ? 1 : 0.6;
      g.save().alpha(al);
      // The bunting first, so the posts read as ends of a line rather than as
      // two unrelated sticks — the shape a player has to judge is the GAP.
      g.line(gx - gate.hw, gy, gx + gate.hw, gy, rgba(col, done ? 0.25 : 0.6), 0.05);
      for (const side of [-1, 1]) {
        g.capsule(gx + side * gate.hw, gy - 0.16, gx + side * gate.hw, gy + 0.16, 0.13,
          { fill: rgba(col, 0.9) });
        // A chevron on each post pointing INTO the gap: a non-colour channel for
        // "this is the way through", and the thing that survives a dichromat.
        if (!done) {
          g.line(gx + side * (gate.hw + 0.02), gy + 0.19,
            gx + side * (gate.hw - 0.22), gy + 0.34, rgba(col, 0.8), 0.05, 'round');
        }
      }
      // The strike-through on a gate that was run wide. This is the permanent
      // half of the miss feedback — the flash below is the loud half.
      if (missed) {
        const r = gate.hw + 0.18;
        g.line(gx - r, gy - 0.3, gx + r, gy + 0.3, rgba(P.c.danger, 0.8), 0.08, 'round');
        g.line(gx - r, gy + 0.3, gx + r, gy - 0.3, rgba(P.c.danger, 0.8), 0.08, 'round');
      }
      if (next) {
        g.save().add();
        g.halo(gx, gy, 1.5, chan(P.c.gold), 0.16);
        g.restore();
      }
      g.text(String(i + 1), gx, gy + 0.52, { size: 0.3, fill: rgba(col, 0.75) });
      g.restore();
    }

    // ---- MISSED --------------------------------------------------------------
    // FIVE GATES WENT PAST WITH NO ACKNOWLEDGEMENT AT ALL in the last build: the
    // HUD said 1/12 with gate 6 on screen and nothing on the frame had ever said
    // otherwise. "Gates credit only from inside" is the single rule the whole idle
    // score rests on, so it is the one rule the player must be able to SEE fire.
    // It now fires three ways at once, on purpose, because one of them is always
    // where the player is not looking: the gate keeps a permanent red cross (see
    // above), the screen takes a red wash from the edge the car missed on, and
    // the word lands under the car. `_missFlash` and `_missSide` are set in
    // update; draw only reads them.
    if (this._missFlash > 0) {
      const f = this._missFlash;
      g.save().alpha(clamp(f, 0, 1));
      // A wash from the side the car was on, so the flash also says WHICH WAY.
      g.rect(this._missSide * 6.2, 0, 7.6, 9, {
        fill: g.linearFill(this._missSide * 9.5, 0, 0, 0, [
          [0, rgba(P.c.danger, 0.4)], [1, rgba(P.c.danger, 0)],
        ]),
      });
      g.text('MISSED', 0, CAR_Y + 1.15, {
        size: 0.5 + 0.12 * f, fill: rgba(P.c.danger, 0.95), tracking: 0.18, weight: 700,
      });
      g.restore();
    }

    // ---- the next gate, when it is still over the horizon -------------------
    // GATE_STEP (17.3) is longer than the visible strip (12.25), so for most of
    // the race there is NO gate on screen at all. A racer whose objective is
    // invisible most of the time is a racer you cannot plan in — the first
    // screenshot of this rite had the car threading an empty road with the HUD
    // saying 8/12 and nothing on screen explaining what the eighth had been. So
    // the pending gate gets a marker pinned to the top edge, at the lateral
    // position it will have when it arrives, with the distance to it.
    //
    // IT SITS BELOW y = 4.5 AND ALWAYS DID NOT. The label used to be at 4.36 with
    // an ascender on top of that, i.e. off the field — invisible only because the
    // stage was being letterboxed at the time. Everything here is laid out
    // downward from the arrow now, inside the clip.
    const pending = this.gates[this.nextGate];
    if (pending && pending.s > sHi) {
      const px = clamp(this.centreAt(pending.s) - cam, -7.0, 7.0);
      const away = pending.s - s;
      g.save().alpha(clamp(1.4 - away / 26, 0.3, 1));
      g.poly([[px - 0.28, 4.00], [px + 0.28, 4.00], [px, 4.34]], { fill: P.c.gold });
      // Bunting width to scale, so "this one is narrow" is readable before it is
      // reachable — which is the only thing that makes an early line worth taking.
      g.line(px - pending.hw, 3.82, px + pending.hw, 3.82, rgba(P.c.gold, 0.5), 0.05);
      g.text(`${this.nextGate + 1}`, px, 3.50, { size: 0.28, fill: rgba(P.c.gold, 0.9) });
      g.restore();
    }

    // ---- gold -------------------------------------------------------------
    // A COIN, NOT A DOT. Under a dichromat simulation the old flat gold disc sat
    // at the same lightness as the road it was lying on and vanished; the ring
    // plus the dark core plus the bob give it an outline and an interior, which
    // is a shape channel that no colour blindness can take away.
    for (const c of this.coins) {
      if (c.taken || c.s < sLo || c.s > sHi) continue;
      const px = this.centreAt(c.s) - cam + c.u;
      const py = CAR_Y + (c.s - s);
      const bob = 0.9 + 0.1 * Math.sin(c.s * 2.1 + this.t * 4);
      g.save().add();
      g.halo(px, py, 0.5, chan(P.c.gold), 0.22 * bob);
      g.restore();
      g.circle(px, py, 0.22 * bob, { fill: 'rgba(0,0,0,0.5)' });
      g.circle(px, py, 0.2 * bob, { fill: P.c.goldHi });
      g.circle(px, py, 0.1 * bob, { stroke: rgba(P.c.accent, 0.85), width: 0.05 });
    }

    // ---- mines ------------------------------------------------------------
    for (const m of this.mines) {
      if (m.s < sLo - 1 || m.s > sHi) continue;
      const px = this.centreAt(m.s) - cam + m.u;
      const py = CAR_Y + (m.s - s);
      if (m.live) {
        const pulse = 0.55 + 0.45 * Math.sin(this.t * 11);
        g.circle(px, py, 0.24, { fill: rgba(P.c.danger, 0.85) });
        g.circle(px, py, 0.24 + 0.16 * pulse, { stroke: rgba(P.c.danger, 0.5), width: 0.05 });
        // Spikes: a mine is not a coin, and at this size the only thing keeping
        // the two apart for a dichromat is that one of them is round.
        for (let k = 0; k < 6; k++) {
          const th = (k / 6) * Math.PI * 2 + this.t * 0.9;
          g.line(px + Math.cos(th) * 0.22, py + Math.sin(th) * 0.22,
            px + Math.cos(th) * 0.36, py + Math.sin(th) * 0.36,
            rgba(P.c.danger, 0.8), 0.06, 'round');
        }
      } else if (m.flash > 0) {
        g.save().add();
        g.halo(px, py, 1.6 * (1.4 - m.flash), chan(P.c.danger), m.flash * 1.6);
        g.restore();
      }
    }

    // ---- rivals -----------------------------------------------------------
    // THE LABELS USED TO PILE UP. Three ghosts leave the line together and weave
    // on phase-shifted sines, so at t = 0 they are on top of each other and their
    // three names were drawn at the same height, overlapping into "Iroerahck".
    // Two fixes, both cheap: each rival's label sits on its OWN rung (0.62, 0.92,
    // 1.22 above the car, by id) so three labels can never share a baseline, and
    // a label is dropped entirely while another rival is within 0.55 of it
    // laterally and on a lower rung — at which point the cars are visibly one
    // clump and naming them individually is noise.
    const roster = this.rivals.roster();
    for (let id = 0; id < RIVAL_COUNT; id++) {
      const rs = this.rivalDist(id, this.t);
      if (rs < sLo || rs > sHi) continue;
      const px = this.centreAt(rs) - cam + this.rivalLateral(id, this.t);
      const py = CAR_Y + (rs - s);
      // Rivals are DARK and the player is LIGHT. That contrast is the one that
      // has to survive a dichromat, so it is carried by lightness, not by hue.
      drawCar(g, px, py, 0, P.c.ink4, P.c.ink2, false);
      let clear = true;
      for (let o = 0; o < id; o++) {
        const os = this.rivalDist(o, this.t);
        const ox = this.centreAt(os) - cam + this.rivalLateral(o, this.t);
        if (Math.abs(ox - px) < 0.55 && Math.abs(os - rs) < 1.2) { clear = false; break; }
      }
      if (!clear) continue;
      g.text(roster[id].name, px, py + 0.62 + id * 0.3,
        { size: 0.26, fill: rgba(P.c.ink2, 0.9) });
    }

    // ---- the player -------------------------------------------------------
    const heading = Math.atan2(-this.vx, Math.max(1, this.speed || BASE_SPEED)) * 0.9;
    const offRoad = Math.abs(u) > HALF_W;
    if (boosting || offRoad) {
      // Dust: a fixed rosette behind the car, phase-driven. No particle list, so
      // no allocation and nothing to leak. A COLD boost throws a third as much of
      // it as a hot one, which is the feedback that the charge was wasted.
      const heat = offRoad ? 1 : this.boostHot ? 1 : 0.35;
      g.save().add();
      for (let i = 0; i < 7; i++) {
        const ph = (this.t * 5 + i * 0.61) % 1;
        g.halo(u - this.vx * 0.06 * i + Math.sin(i * 2.3 + this.t * 9) * 0.18,
          CAR_Y - 0.45 - ph * 1.5, (0.32 * (1 - ph) + 0.1) * heat,
          chan(offRoad ? P.c.accent : P.c.goldHi), 0.24 * (1 - ph) * heat);
      }
      g.restore();
    }
    g.ellipse(u, CAR_Y - 0.08, 0.42, 0.6, 0, { fill: 'rgba(0,0,0,0.45)' });
    // THE PLAYER'S CAR IS THE LIGHTEST THING ON THE ROAD, and that is a colour-
    // blindness fix rather than a style choice. It used to be `--rite-offroad-
    // accent`, a mid orange, painted on a surface tinted with the same token: run
    // through a deuteranope simulation the car, the road, the coins and the gate
    // all collapsed to one yellow and the car was the same colour as the thing it
    // was driving on. Now the shell is near-white ink with a dark outline and the
    // accent is demoted to the roof panel, so the separation is carried by
    // LIGHTNESS — which no form of dichromacy touches — and the hue is decoration
    // on top of a picture that already works without it.
    drawCar(g, u, CAR_Y, heading, P.c.ink, P.c.ink4, true, boosting ? P.c.goldHi : P.c.accent);

    g.restore();
    });

    // ---- HUD --------------------------------------------------------------
    this.#drawHud(g, P);
  }

  #drawHud(g, P) {
    const st = { place: this.place, beaten: this.beaten };

    // Top-left: gates and gold, the two things the score is mostly made of.
    // The counter flashes gold on a credit and RED on a miss, so the number the
    // player is watching is also the number that tells them the rule fired.
    g.text(`GATES ${this.gatesHit}/${GATE_COUNT}`, -7.5, 4.05,
      { size: 0.36, align: 'left', tracking: 0.06,
        fill: this._missFlash > 0.35 ? P.c.danger
          : this._gateFlash > 0.4 ? P.c.gold : P.c.ink2 });
    // ...and the misses are carried as their own count rather than left to
    // subtraction. `12 - 5` is arithmetic; `5 MISSED` is a fact.
    if (this.missedGates.length > 0) {
      g.text(`${this.missedGates.length} MISSED`, -7.5, 3.14, {
        size: 0.28, align: 'left', tracking: 0.08,
        fill: rgba(P.c.danger, this._missFlash > 0.35 ? 1 : 0.65),
      });
    }
    g.text(`GOLD ${this.coinsTaken}/${COIN_COUNT}`, -7.5, 3.55,
      { size: 0.36, align: 'left', fill: this._goldFlash > 0.4 ? P.c.goldHi : P.c.ink2, tracking: 0.06 });

    // Top-right: the standing, live. A race you cannot see yourself losing is a
    // solitaire with extra steps.
    g.text(`${PLACES[clamp(st.place - 1, 0, 3)]} of ${RIVAL_COUNT + 1}`, 7.5, 4.05,
      { size: 0.42, align: 'right', fill: st.place === 1 ? P.c.goldHi : P.c.ink, tracking: 0.04 });
    const left = Math.max(0, DURATION - this.t);
    g.text(`${left.toFixed(1)}s`, 7.5, 3.5,
      { size: 0.34, align: 'right', fill: left < 5 ? P.c.danger : P.c.ink3 });

    // Bottom: the two verbs, as charges. Pips rather than a number, because the
    // question a player asks mid-corner is "have I got one left", not "how many".
    //
    // ROUND FOR BOOST, SQUARE FOR BOMB. Both rows used to be discs told apart by
    // hue alone — gold against red — and under a deuteranope simulation the two
    // converge, so the player is left with "some pips at the left and some pips
    // at the right" and no way to know which row is which if the labels are read
    // in a hurry. The shape says it without the colour, and the colour still says
    // it for everyone else.
    const pip = (i, filled, col, cx) => {
      g.circle(cx + i * 0.42, -4.05, 0.14, filled
        ? { fill: col } : { stroke: rgba(col, 0.4), width: 0.05 });
    };
    const chip = (i, filled, col, cx) => {
      g.rect(cx + i * 0.42, -4.05, 0.25, 0.25, filled
        ? { fill: col, radius: 0.04 } : { stroke: rgba(col, 0.4), width: 0.05, radius: 0.04 });
    };
    // BOOST goes bright while the car is standing in a fast stretch with a charge
    // in hand — the HUD half of the affordance the road paints in `draw`. It is
    // the difference between "you have three boosts" and "spend one HERE".
    const armed = this.boostLeft > 0 && this.boostT <= 0 && this.isFast(this.s);
    g.text(armed ? 'BOOST NOW' : 'BOOST', -7.5, -4.05,
      { size: 0.3, align: 'left', tracking: 0.1, fill: armed ? P.c.goldHi : rgba(P.c.ink3, 0.9) });
    for (let i = 0; i < BOOST_CHARGES; i++) {
      pip(i, i < this.boostLeft, armed ? P.c.goldHi : P.c.gold, -4.85);
    }
    g.text('BOMB', 4.2, -4.05, { size: 0.3, align: 'left', fill: rgba(P.c.ink3, 0.9), tracking: 0.1 });
    for (let i = 0; i < BOMB_CHARGES; i++) chip(i, i < this.bombsLeft, P.c.danger, 6.0);

    // Progress bar along the bottom edge: the only place the whole course
    // become a picture, and the only cue that the flag is coming.
    const prog = clamp(this.s / FLAG_AT, 0, 1);
    g.line(-3.4, -4.32, 3.4, -4.32, rgba(P.c.ink4, 0.8), 0.05, 'round');
    g.line(-3.4, -4.32, -3.4 + 6.8 * prog, -4.32, P.c.accent, 0.07, 'round');
    for (let id = 0; id < RIVAL_COUNT; id++) {
      const rp = clamp(this.rivalDist(id, this.t) / FLAG_AT, 0, 1);
      g.circle(-3.4 + 6.8 * rp, -4.32, 0.06, { fill: rgba(P.c.ink2, 0.8) });
    }
    g.circle(-3.4 + 6.8 * prog, -4.32, 0.1, { fill: P.c.goldHi });

    if (this.finished) {
      g.text('FLAG', 0, 0.6, { size: 0.9, fill: P.c.goldHi, tracking: 0.2 });
    }
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers — free functions, so nothing here can touch instance state.
// ---------------------------------------------------------------------------

/**
 * A car, seen from directly above: shell, roof, four wheels.
 *
 * `blob` rather than `poly` for the shell, because a car body is a smooth closed
 * silhouette and a six-point `poly` reads as a badly tessellated curve rather
 * than as stylisation (see the Painter docblock). `ellipse` rather than a scaled
 * circle for the wheels, so the outline keeps one width on both axes.
 */
function drawCar(g, x, y, rot, body, trim, isPlayer, roof) {
  g.save().translate(x, y).rotate(rot);
  for (const sx of [-1, 1]) {
    g.ellipse(sx * 0.3, 0.28, 0.09, 0.17, 0, { fill: 'rgba(0,0,0,0.72)' });
    g.ellipse(sx * 0.3, -0.28, 0.1, 0.19, 0, { fill: 'rgba(0,0,0,0.72)' });
  }
  g.blob([
    [0, 0.52], [0.26, 0.3], [0.28, -0.28], [0.16, -0.5],
    [-0.16, -0.5], [-0.28, -0.28], [-0.26, 0.3],
  ], { fill: body, stroke: rgba(trim, isPlayer ? 0.9 : 0.45), width: isPlayer ? 0.06 : 0.045 });
  g.rect(0, 0.06, 0.3, 0.3, { fill: roof ?? rgba(trim, 0.3), radius: 0.08 });
  // The player gets a nose flash the ghosts do not: one more non-colour channel
  // separating "me" from "them" for anyone the hues have collapsed for.
  if (isPlayer) {
    g.poly([[-0.13, 0.34], [0.13, 0.34], [0, 0.52]], { fill: rgba(trim, 0.85) });
  }
  g.restore();
}

/**
 * Design tokens, read ONCE per rite from the document element.
 *
 * The pattern is `Lottery.js#readPalette` verbatim, and the two halves both
 * matter: read once (a getComputedStyle per frame is a forced style recalc every
 * frame) and fall back to literals (this module is imported by the unit suite in
 * node, where there is no `document` at all).
 *
 * The accent is read under its PREFIXED name, `--rite-offroad-accent`, which is
 * declared on `:root`. The generic `--rite-accent` is set on `#rite` — an
 * element a rite never has a handle on — so reading that one missed every time
 * and the literal below was silently what painted. The `[data-rite]` block
 * aliases the prefixed token into the generic one for the chrome's use.
 */
function readPalette() {
  const cs = (typeof document !== 'undefined' && typeof getComputedStyle === 'function')
    ? getComputedStyle(document.documentElement) : null;
  const tok = (name, fallback) => (cs?.getPropertyValue(name) || '').trim() || fallback;
  const c = {
    ink: tok('--ink', '#e9ebf3'),
    ink2: tok('--ink-2', '#a3a9bb'),
    ink3: tok('--ink-3', '#6d7488'),
    ink4: tok('--ink-4', '#4a5064'),
    gold: tok('--gold', '#e5bd79'),
    goldHi: tok('--gold-hi', '#f7dfae'),
    danger: tok('--danger', '#ff5f57'),
    accent: tok('--rite-offroad-accent', '#d98b4a'),
  };
  return { c };
}

/**
 * `#rrggbb` -> `'r,g,b'`, the bare-channel form `Painter.halo` wants.
 *
 * Exists so glows are derived FROM THE TOKENS rather than from a second set of
 * hardcoded numbers next to them — the failure mode being a palette change that
 * moves every fill and leaves every glow behind. A token that is not a hex (a
 * project could legally define one as `rgb(...)`) falls back to a neutral warm
 * grey rather than producing an unparseable colour, which `addColorStop` throws
 * on and a throw inside draw() abandons the rite.
 */
function chan(hex) {
  if (typeof hex !== 'string') return '229,189,121';
  const h = hex.trim();
  if (/^#[0-9a-f]{6}$/i.test(h)) {
    return `${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)}`;
  }
  if (/^#[0-9a-f]{3}$/i.test(h)) {
    return `${parseInt(h[1] + h[1], 16)},${parseInt(h[2] + h[2], 16)},${parseInt(h[3] + h[3], 16)}`;
  }
  return '229,189,121';
}

/** A token at an alpha, as a css colour. Same reasoning as `chan`. */
function rgba(hex, a) { return `rgba(${chan(hex)},${a})`; }

/** @type {import('../contract.js').MinigameDef} */
export const OFFROAD_RITE = {
  id: 'offroad',
  name: 'Offroad Racing',
  hint: 'Steer through the gates — click to boost, right-click to drop a bomb',
  duration: DURATION,
  theme: 'offroad',
  eyebrow: 'Rally',
  abandonNote: 'You pulled off the track',
  // The only rite that is steered rather than aimed AND uses both buttons as
  // separate verbs; a crosshair over a car would read as "click the car".
  cursor: 'default',
  create: () => new OffroadRite(),
};

export {
  OffroadRite, RAND_CALLS, DURATION, TRACK_LEN, FLAG_AT, GATE_COUNT, COIN_COUNT,
  RIVAL_COUNT, BOOST_CHARGES, BOMB_CHARGES, HALF_W,
};
