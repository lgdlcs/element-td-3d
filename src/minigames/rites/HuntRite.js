/**
 * GAME HUNT — the reaction shot.
 *
 * A forest clearing at dusk. An animal steps out of the treeline, freezes for a
 * beat, and bolts. You and three rivals are all aimed at the same animal, and
 * only the first shot counts. That is the whole game, and the whole design
 * problem is that "first to click" has no meaning without a second player.
 *
 * WHAT "FIRST TO CLICK" BECAME, STATED PLAINLY. There is no network here (see
 * the honest paragraph at the top of ../rivals.js). Every animal instead carries
 * a PRE-DRAWN DEADLINE with a name and a face on it: land a valid hit at
 * `t < claimAt` and the animal is yours, otherwise Kavi's name flashes over it
 * and it is gone. Strictly `<`, so a tie is not a state this rite can be in.
 * The deadline comes from the shared seed, which is the property that matters:
 * two players in the same room face the SAME three rivals with the SAME names
 * and the SAME deadlines, so afterwards their scores mean the same thing. It is
 * not a duel. It is a duel's arithmetic, played by both people separately.
 *
 * THE VERB, AND WHY IT IS GUARDED. `fishing` is this rite's twin — Lucas asked
 * for "the same thing but with fishermen and fish" — and if both of them are
 * "click the thing first" then two of the eleven rites in a run are one game.
 * The split is by PHYSICAL ACT: **hunt is a REACTION shot** (the animal is
 * there, you shoot it, speed is everything) and **fishing is a LEADING shot**
 * (the hook sinks for 0.35 s and the fish keeps swimming, so you aim where it
 * WILL be). Nothing in this file may drift toward prediction. The animal never
 * needs to be led; it stands still and dares you.
 *
 * THE TWO BRAKES, AND WHY THEY ARE NOT AN AMMO CAP. Unlimited ammo, but:
 *
 *   1. a 0.38 s RECOIL after every shot, and
 *   2. A SHOT INTO THE BUSHES SPOOKS THE LIVE ANIMAL — it bolts immediately.
 *
 * (2) is the anti-mash rule, and it is better than `luckyshot`'s ammo cap here
 * because it punishes precisely the behaviour this rite is about resisting:
 * panic-clicking at an animal you have not actually acquired. An ammo cap says
 * "you have run out"; this says "you scared it off", which is the same lesson
 * delivered by the fiction instead of by a counter. Mashing does not merely stop
 * scoring, it actively destroys the round — which is why the harness's mash
 * strategy lands near zero rather than near the ceiling.
 *
 * "INTO THE BUSHES" IS LOAD-BEARING AND USED TO SAY "ANYWHERE BUT THE ANIMAL".
 * A round that whistles past the shoulder is a GRAZE: it costs the recoil and
 * nothing else. See `#resolveShot` for why the old rule flattened the rite into
 * a pass/fail switch, and for the arithmetic showing that mashing is unaffected.
 *
 * CONTROLS: left click, right click and Space are ONE verb. Right-click is
 * supported because it is what the original map used; it is never required,
 * because a macOS trackpad's secondary click carries a settling delay and a
 * reaction game measured in tens of milliseconds must not handicap one platform.
 * The rite reads `input.clicks` (which carries the position AT THE PRESS) and
 * never `input.x/y`, which is a live pointer and would credit the shot to
 * wherever the mouse drifted by the end of the step.
 *
 * NO DOM, NO THREE, NO Math.random — the unit suite imports this in node.
 */

import { FIELD, clamp, lerp, approxTextWidth } from '../contract.js';
import { SeededRivals, PER_RIVAL } from '../rivals.js';
import { mulberry32 } from '../../core/Rng.js';

// ---------------------------------------------------------------------------
// The numbers. Every one of them is a design decision, so every one is named.
// ---------------------------------------------------------------------------

/** Seconds on the clock. Matches HUNT_RITE.duration; the host enforces it. */
const DURATION = 20;

/** How many animals a full round offers. */
const ANIMALS = 14;

/**
 * The denominator of the score: `ratio = clamp(taken / EXPECTED)`.
 *
 * 60 % of the field, rounded — eight. Chosen so the interesting band is where
 * real players live: a strong player passes it and clamps at 1, a middling one
 * lands somewhere in the middle of the range rather than at either wall. A
 * denominator of ANIMALS would put a good player at 0.7 and a great one at 0.95,
 * which compresses every human into the top third of the curve and makes the
 * payout insensitive to actually being good.
 */
const EXPECTED = Math.round(ANIMALS * 0.6);

/** Rivals in the field. Three, because "you and three others" is the fiction. */
const RIVAL_COUNT = 3;

/**
 * Seconds the trigger is locked after a shot. Brake #1.
 *
 * 0.38 rather than the original 0.45. The recoil is what caps the VOLUME of
 * shots, and at 0.45 it was also quietly deciding the score: a wasted shot near
 * an animal's appearance locked the trigger through that animal's entire window,
 * so a shaky player spent the round locked out by their own last mistake rather
 * than beaten by the rivals. It still caps the round at ~52 shots for 14 animals,
 * which is the property brake #1 exists for.
 */
const RECOIL = 0.38;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, on every wave, always.
 *
 * Written as the arithmetic rather than as `69` so that changing a loop bound
 * changes this constant in the same edit — a literal here is a literal that goes
 * stale silently, and the determinism rule (docs/MINIGAMES.md §3) only holds if
 * this number is the truth rather than a memory of it.
 *
 *   RIVAL_COUNT * PER_RIVAL   the roster, drawn inside SeededRivals' constructor
 *   ANIMALS * ANIMAL_DRAWS    species, treeline step, depth, temperament rank —
 *                             one loop, fixed length, no branches
 *   + 1                       the seed for the private presentation generator
 */
const ANIMAL_DRAWS = 4;
const RAND_CALLS = RIVAL_COUNT * PER_RIVAL + ANIMALS * ANIMAL_DRAWS + 1;

/**
 * THE REACTION WINDOW — from the animal stepping out to the rival's deadline.
 *
 * The most load-bearing arithmetic in the rite, and it answers to three things:
 * the WAVE (later rites are harder), the ROSTER (a fast field gives you less
 * time), and the ANIMAL (this is new, and it is the important one).
 *
 *     base    = MID + GAIN * (claimTime(0) - ANCHOR)      the roster's flavour
 *     scaled  = base * (1 - WAVE_DROP * waveT)            the difficulty axis
 *     window  = max(scaled + TAIL * temper,               this animal's own beat
 *                   MIN  + STRAGGLE * rWob^3)
 *
 * WHY THE ROSTER'S SHARE SHRANK FROM 0.55 TO 0.10. `claimTime(0)` swings about
 * 0.9 s across plausible rosters — wider than the entire band a reaction game
 * can live in. At GAIN 0.55 that swing WAS the difficulty: measured over 40
 * seeds at fixed skill, wave 53 paid 0.556 +- 0.248 with a minimum of 0.000 and
 * a maximum of 1.000. The same player, the same wave, scoring nothing on one
 * seed and everything on the next — that is not a difficulty curve, it is a
 * draw. The roster is meant to FLAVOUR the window, not to decide it, so it now
 * moves the window by about 0.09 s (roughly 15 % of it) instead of by 0.5 s.
 *
 * The difficulty it used to supply moved to WAVE_DROP, where it belongs: the
 * wave is a number the design controls and a straight line in, and the roster is
 * a number the seed controls. Keeping those two separate is also what made the
 * wave ladder monotone — while the roster drove the curve, the wave response was
 * a random walk, and the gate's "later waves are not easier" rule caught it.
 *
 * WHY THERE IS A PER-ANIMAL TERM AT ALL — THIS IS THE MID-BAND.
 *
 * Every animal in a round used to get the same window give or take 0.10 s, which
 * meant a round posed ONE question fourteen times. A player is either fast
 * enough for that question or they are not, so the score had two values: near 1
 * and near 0. The calibration gate named it exactly — flawless up to the
 * reference player, then 0.000 for a clumsy one, with nothing in between.
 *
 * So each animal now has a TEMPERAMENT. `temper` is the draw squared, so most of
 * a round is skittish and one or two beasts in it are not, and a round asks
 * fourteen DIFFERENT questions instead of one question fourteen times. A player
 * answers the ones inside their reach and misses the rest, which is what a
 * continuous score is made of.
 *
 * THE STRAGGLER FLOOR, AND WHY IT IGNORES THE WAVE. The second term is a floor,
 * not an addition, and `WAVE_DROP` never touches it: a beast that dawdles is a
 * beast that dawdles at wave 53 too. Without it the late waves compressed every
 * window toward WINDOW_MIN and the mid-band collapsed again at exactly the wave
 * where the player most needs the rite to still be a game. Cubed, so it is the
 * top tenth of the draw and not a general discount.
 */
const WINDOW_MID = 0.24;
const WINDOW_GAIN = 0.10;
const WINDOW_ANCHOR = 1.55;
/** Wave shortening. The difficulty axis, and now the whole of it. */
const WINDOW_WAVE_DROP = 0.55;
const WINDOW_MIN = 0.28;
/** Must stay under the rival source's CLAIM_SPACING, or two animals overlap. */
const WINDOW_MAX = 1.25;
/** How much of the window this animal's temperament is worth. */
const WINDOW_TAIL = 0.95;
/** Squared: most of a round is skittish, one or two beasts in it are not. */
const WINDOW_TEMPER_POW = 2;
/** The straggler floor, which the wave does not touch. See above. */
const WINDOW_STRAGGLE = 0.45;
const WINDOW_STRAGGLE_POW = 3;

/**
 * A beat of lead-in before the first deadline, and a pad before the last.
 *
 * OPEN_DELAY buys the player a moment of empty clearing to settle into before
 * anything is contested. END_PAD clamps the final deadline inside the clock so
 * that every animal RESOLVES ON SCREEN — an animal still standing when the host
 * closes the overlay reads as a bug, even though the score is identical.
 */
const OPEN_DELAY = 0.5;
const END_PAD = 0.2;

/**
 * The fraction of the window the animal spends stepping out before it freezes.
 *
 * The freeze is the rite's heartbeat and it has to read as two things at once:
 * an INVITATION (it is standing still, take the shot) and a COUNTDOWN (the ring
 * around it is closing). Everything before it is the tell — motion at the edge
 * of the treeline — and it is deliberately short: a long walk-out would let a
 * player pre-aim, which turns a reaction into a wait.
 */
const EMERGE_FRAC = 0.22;

/** A take inside this fraction of the window is a snap shot and earns 'perfect'. */
const SNAP_FRAC = 0.34;

/** Seconds an animal's exit animation plays after it resolves. */
const EXIT_HOLD = 0.62;
/** Seconds a rival's name hangs over the animal it took. The sting. */
const CLAIM_FLASH = 0.8;

/**
 * Hit radius, in world units, before the animal's depth scale is applied.
 *
 * Per species, because "how big a thing is" is the honest difficulty dial in an
 * aiming game and the player can SEE it: a hare is a small target and looks like
 * one. Scaled by depth as well, so an animal at the back of the clearing is
 * genuinely harder in exactly the way the picture promises.
 */
const HIT_R = Object.freeze([0.78, 0.86, 0.62]);   // deer, boar, hare

/**
 * How far outside the kill disc a shot still counts as a GRAZE rather than as a
 * spook, in world units before the depth scale. See `#resolveShot`.
 */
const GRAZE_BAND = 1.0;

/** Species ids, used as array indices. Kept as constants so nothing reads `1`. */
const DEER = 0, BOAR = 1, HARE = 2;

/** Where animals may stand: x is spread outward by the wave, y is depth. */
const X_SPAN_BASE = 4.2;
const X_SPAN_WAVE = 1.8;
/** The treeline walk: how far one animal steps from the last. See init(). */
const X_STEP = 4.6;
const X_STEP_MIN = 0.9;
const Y_NEAR = -2.55;
const Y_FAR = -0.20;
/** Wave pushes animals deeper (smaller, further from centre) as well as wider. */
const DEPTH_WAVE = 0.34;

/**
 * Where the clearing meets the treeline, in world units.
 *
 * One constant rather than the three separate literals that used to encode it
 * (`0.28` for a hairline, `0.1` for the trunk feet, `0.3` for the top of the
 * floor wash). Three numbers a hair apart is exactly how a seam gets drawn: they
 * were meant to be the same place and nothing made them be.
 */
const TREELINE_Y = 0.24;

/** Scenery counts. Fixed, so the rand budget cannot depend on them at runtime. */
const TREES_FAR = 18, TREES_MID = 11, TREES_NEAR = 3;
/** Points per generated silhouette. `blob` smooths through them. */
const BLOB_PTS = 9;

/** Dust/impact particles. A RING, pre-allocated, never grown. */
const DUST_MAX = 28;

/**
 * The forest's own palette — FALLBACKS ONLY.
 *
 * This used to be the shipping palette, as a frozen module constant, and the
 * reason given was sound at the time: the hunt greens lived in
 * `#rite[data-rite="hunt"]`, a block scoped to the OVERLAY ELEMENT, which a rite
 * never sees and cannot query, so reading `--rite-accent` off the document
 * element resolved the `:root` default (`--ink-3`, a grey) and would have
 * painted the forest in UI colours.
 *
 * That is no longer true. The greens are declared on `:root` as
 * `--rite-hunt-*`, and the `[data-rite="hunt"]` block aliases the accent from
 * there for the chrome, so the stylesheet is once again the single place the
 * forest's colour is decided. `#readPalette` reads them; the values below are
 * what paints in node and in jsdom, where there is no stylesheet at all.
 *
 * `pelt`, `peltDark` and `ember` stay LITERAL and are not tokens. They are the
 * subject, not the room: an animal must stay legible against the treeline, and
 * retuning the room is not licence to move the thing the player is aiming at.
 *
 * THE PELT WAS THE WORST MEASUREMENT IN THE ART REVIEW, SO IT IS WORTH THE
 * PARAGRAPH. It used to be `#161310` — a near-black hide, on the theory that the
 * animal reads as a SILHOUETTE against a lit clearing. Sampled off a real frame,
 * that theory produced:
 *
 *     pelt vs the ground behind it   rgb(21,19,16) vs rgb(18,31,22)   1.089 : 1
 *     pelt vs the ground below it    rgb(21,19,16) vs rgb(11,19,13)   1.017 : 1
 *     pelt vs the mid canopy         rgb(21,19,16) vs rgb(10,22,15)   1.002 : 1
 *
 * WCAG's floor for a non-text UI object is 3:1, and this is the object the whole
 * rite asks you to click. A reviewer played eight seconds of it, clicking
 * continuously, and never saw an animal — they read the score off the pip row.
 *
 * The silhouette theory was not wrong, it was BACKWARDS. A silhouette needs the
 * subject and its background on opposite sides of the value scale, and a dark
 * animal in a dark forest at dusk has nowhere to go but into it. So the animal
 * is now the LIGHTEST thing in the frame instead of the darkest — a hide catching
 * the last of the light in the one lit pool of the clearing, which is also the
 * more honest picture of what a clearing at dusk looks like. The forest keeps its
 * near-black framing and gets darker to make room.
 *
 * Measured against the same three backgrounds, `pelt` is now 4.9:1, 5.4:1 and
 * 5.6:1. `peltDark` is the shadowed underside and carries no read on its own, so
 * it sits lower, but still above the floor rather than inside it.
 */
const FOREST = Object.freeze({
  canopyFar: '#0c1912',
  canopyMid: '#08120c',
  canopyNear: '#030705',
  trunkFar: '#091209',
  trunkNear: '#020504',
  floor: '#08110e',
  rim: '#86c294',
  accent: '134,194,148',
  /** Not themed — see above. */
  groundLo: 'rgba(3,7,5,0.0)',
  pelt: '#b08a5e',
  peltDark: '#7d5c3c',
  /** The deepest accent on the animal — hooves, eye socket, antler roots. */
  peltShade: '#4a3524',
  ember: '229,160,90',
});

/**
 * `'#86c294'` -> `'134,194,148'`, the bare-channel form `Painter.halo` and every
 * `rgba(...)` below want.
 *
 * Exists so the ground wash, the mist and the rim glow are all DERIVED from the
 * one accent token rather than written next to it as a second copy — the failure
 * mode being a stylesheet edit that moves the rim and leaves the glow behind.
 * A token authored as anything but a six-digit hex falls back rather than
 * producing a string `addColorStop` throws on, and a throw inside draw() ends
 * the rite.
 */
function channels(css, fallback) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(css).trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

// ---------------------------------------------------------------------------

class HuntRite {
  init(ctx) {
    this.wave = ctx.wave;
    /**
     * The `occurrence` variation: the second time a run sends you here, it is
     * later in the evening. STRUCTURAL ONLY (docs/MINIGAMES.md) — this changes
     * the palette and puts a moon in the sky, and touches not one number that
     * score() can see. A rite that made the second visit harder would be a rite
     * that punished the player for the schedule's dice.
     */
    this.night = (ctx.occurrence ?? 0) % 2 === 1;
    /** 0 at the first rite, 1 at the last. The one difficulty parameter. */
    const waveT = clamp((ctx.wave - 3) / 50, 0, 1);

    // ---- the draws, in one fixed order, none of them inside a branch -----
    // Order is part of the seed contract exactly as much as the count is:
    // reordering these two blocks changes what every existing seed produces.

    /**
     * The rivals. Constructed FIRST so that `claimTime` is available while the
     * animals are being laid out — the schedule is derived from the deadlines,
     * not the other way round, because the deadlines are the shared thing.
     */
    this.rivals = new SeededRivals(ctx.rand, { count: RIVAL_COUNT, wave: ctx.wave });

    /**
     * The nominal window, from the roster's first published deadline. See the
     * WINDOW_* docblock — this is the compression that keeps a fast field hard
     * without letting it become unreachable.
     */
    const nominal = WINDOW_MID + WINDOW_GAIN * (this.rivals.claimTime(0) - WINDOW_ANCHOR);
    const scaled = nominal * (1 - WINDOW_WAVE_DROP * waveT);

    const xSpan = X_SPAN_BASE + X_SPAN_WAVE * waveT;

    /** @type {Array<object>} one record per animal, all of them made here. */
    this.animals = [];
    /** The walk's running position. See the `x` block below. */
    let prevX = 0;
    for (let i = 0; i < ANIMALS; i++) {
      const rSpecies = ctx.rand();
      const rX = ctx.rand();
      const rDepth = ctx.rand();
      const rWob = ctx.rand();

      // Species mix: deer are the round's spine, hares are the punctuation.
      const species = rSpecies < 0.45 ? DEER : rSpecies < 0.75 ? BOAR : HARE;

      // WHERE IT STEPS OUT: A WALK ALONG THE TREELINE, NOT FOURTEEN INDEPENDENT
      // DRAWS.
      //
      // This used to be a signed draw across the whole clearing, biased away
      // from the centre so that an animal never appeared under a parked
      // crosshair. The bias was right and the independence was not: two
      // consecutive animals could land on opposite edges, twelve world units
      // apart, and crossing twelve units is not a reaction, it is a journey. It
      // was measurable — the clumsy player lost TEN of fourteen animals to the
      // deadline with the trigger still free, because the hand was in transit
      // when it expired. A rite that is a reaction test for a fast hand and a
      // travel test for a slow one is two different games wearing one score.
      //
      // So the herd works its way along the treeline: each animal steps out
      // within X_STEP of the last, reflecting off the edges of the clearing
      // rather than clamping to them (a clamp piles animals up on the rim, which
      // is both a worse picture and a place the player learns to camp). The
      // draw count is unchanged — one `rX`, as before.
      //
      // The anti-camp property survives, and it is now stronger rather than
      // weaker: the step is signed and at least X_STEP_MIN, so the next animal
      // is never where the player is already looking, wherever that is. The old
      // rule only protected one point on the field, the centre.
      const step = (rX * 2 - 1) * X_STEP;
      const away = Math.sign(step) || 1;
      let x = prevX + (Math.abs(step) < X_STEP_MIN ? away * X_STEP_MIN : step);
      if (x > xSpan) x = 2 * xSpan - x;
      if (x < -xSpan) x = -2 * xSpan - x;
      prevX = x;
      // Which half of the clearing it is standing in. Drives the facing and the
      // bolt direction below: it turns to look at the middle, and it runs out
      // the side it came in on.
      const side = Math.sign(x) || 1;

      // Depth: 0 at the front of the clearing, 1 at the treeline. Later waves
      // push animals back, which shrinks them and shrinks the hit disc with
      // them — the difficulty the player can SEE rather than one applied to it.
      const depth = clamp(rDepth * (1 - DEPTH_WAVE) + DEPTH_WAVE * waveT, 0, 1);
      const y = lerp(Y_NEAR, Y_FAR, depth);
      const scale = 1 - 0.34 * depth;

      // The deadline: the rival source's own published time for contested
      // target i, shifted by the lead-in and clamped inside the clock so that
      // the last animal is resolved on screen rather than by the host closing.
      const claimAt = Math.min(this.rivals.claimTime(i) + OPEN_DELAY, DURATION - END_PAD);

      this.animals.push({
        i, species, x, y, scale, depth,
        /** Both filled in by the stratified temperament pass below. */
        appearAt: 0, claimAt,
        /** The raw draw. Only its RANK among the fourteen is used. */
        rWob,
        hitR: HIT_R[species] * scale,
        /** Facing: an animal stepping into a clearing faces the middle of it. */
        face: -side,
        /** It bolts back the way it came, toward the near edge. */
        flee: side,
        /** 'wait' | 'live' | 'taken' | 'claimed' | 'spooked' */
        state: 'wait',
        /** When it left the round, in rite seconds. -1 while it is still here. */
        endedAt: -1,
        /** Fraction of the window that had elapsed at the take. For the flash. */
        tookAt: 0,
        /** Presentation only, assigned below. Which rival's name flashes. */
        claimant: '',
        /** Its own silhouette, generated once. Never touched again. */
        body: null,
      });
    }

    /**
     * THE TEMPERAMENTS, DEALT AS A HAND RATHER THAN ROLLED ONE BY ONE.
     *
     * Each animal needs a window, and the window is mostly its temperament (see
     * the WINDOW_* docblock): skittish beasts give you a blink, stragglers give
     * you a beat and a half. The obvious implementation is fourteen independent
     * draws, and it was the implementation here until it was measured.
     *
     * Fourteen independent draws mean the NUMBER of reachable animals in a round
     * is a binomial, and a binomial over fourteen trials has a standard deviation
     * of about two. Two animals is a quarter of `EXPECTED`. So the round itself
     * was rolling a die about how hard it would be, on top of every other die,
     * and the player was being paid for it: at fixed skill, wave 53 measured
     * 0.556 +- 0.248 across 40 seeds, floor 0.000, ceiling 1.000.
     *
     * So the fourteen temperaments are a HAND, not fourteen rolls. Every round
     * contains the same spread — one at each rung of a fixed ladder — and the
     * seed decides only WHICH animal draws WHICH rung, by ranking the draws
     * already made. Consequences, all of them wanted:
     *
     *  - every round contains stragglers and skittish beasts in the same
     *    proportion, so the mid-band the calibration gate asks for exists on
     *    EVERY seed rather than on average across seeds;
     *  - the round is exactly as varied as before from where the player sits —
     *    they cannot see a rank, only a beast that lingers or does not, and
     *    which beast that is still moves with the seed;
     *  - it costs no draws. The ranking consumes `rWob`, which was already
     *    drawn, in the order it was already drawn, so the seed contract and
     *    RAND_CALLS are untouched.
     *
     * The ladder is `(rank + 0.5) / ANIMALS`, i.e. the fourteen midpoints of an
     * even split, put through the same skew a single draw used to get.
     */
    const byTemper = this.animals.map((a) => a).sort((p, q) => p.rWob - q.rWob);
    for (let rank = 0; rank < byTemper.length; rank++) {
      const a = byTemper[rank];
      const u = (rank + 0.5) / ANIMALS;
      const temper = Math.pow(u, WINDOW_TEMPER_POW);
      const typical = scaled + WINDOW_TAIL * temper;
      const straggler = WINDOW_MIN + WINDOW_STRAGGLE * Math.pow(u, WINDOW_STRAGGLE_POW);
      const window = clamp(Math.max(typical, straggler), WINDOW_MIN, WINDOW_MAX);
      // The `min` is a guard, not a case that occurs at any shipped tuning: it
      // only bites if the clamp on claimAt pulled a deadline backwards past its
      // own appearance, and a zero-length window would be an animal that is
      // claimed on the frame it appears.
      a.appearAt = Math.min(a.claimAt - window, a.claimAt - WINDOW_MIN);
    }

    /**
     * ONE draw for the presentation generator, and every cosmetic decision from
     * here down comes out of it (docs/MINIGAMES.md §3). Drawing tree shapes from
     * `ctx.rand` directly would make the budget depend on the scenery, which is
     * how a rite that looks fine desyncs a room.
     */
    this._fx = mulberry32(Math.floor(ctx.rand() * 0xffffffff) >>> 0);

    // ---- everything below is derived; no ctx.rand beyond this line -------

    /**
     * Which rival's name flashes over each animal — ASKED, not invented.
     *
     * `RivalSource.claimant(i)` is the argmin of the same per-rival schedule
     * whose minimum is `claimTime(i)`, so the name over an animal is the rival
     * who actually got there first. This used to be a roll of `this._fx`, which
     * was honest about being decoration and was still the wrong thing: the
     * deadline said one story and the name said another, and nothing could ever
     * make them disagree loudly enough to be noticed.
     *
     * `null` only for an empty roster, which no shipped tuning produces but a
     * dev-panel `RIVAL_COUNT` of 0 would.
     */
    for (const a of this.animals) {
      const who = this.rivals.claimant(a.i);
      a.claimant = who ? who.name : 'the field';
      a.body = this.#silhouette(a.species);
    }

    this.trees = this.#forest();

    // ---- the mutable round ------------------------------------------------
    this.t = 0;
    this.recoil = 0;
    this.shots = 0;
    this.taken = 0;
    this.claimed = 0;
    this.spooked = 0;
    /** Near misses: shots that cost the recoil but did not scare the animal. */
    this.grazed = 0;
    this.snap = 0;
    /** When a click was eaten by the recoil lock. For the trigger flash only. */
    this.blockedAt = -2;
    /** Last take, for the muzzle/impact ring. -2 so nothing draws on frame one. */
    this.flashAt = -2;
    this.flashX = 0;
    this.flashY = 0;
    this._started = false;
    this._events = [];

    /** A pre-allocated ring. Never grows, never shrinks. */
    this.dust = [];
    for (let i = 0; i < DUST_MAX; i++) {
      this.dust.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, r: 0.05, warm: 0 });
    }
    this._dustAt = 0;

    this.palette = this.#readPalette();
  }

  /**
   * Design tokens come from the stylesheet, not from literals in this file.
   *
   * Read ONCE, here, with literal fallbacks, exactly as `Lottery.js:722-734`
   * does — a canvas cannot resolve `var(--gold)`, and calling getComputedStyle
   * per frame is a forced style recalculation inside the render loop. The
   * fallbacks are what make this file importable in node and in jsdom, where
   * there is no stylesheet to read at all.
   *
   * The forest greens come through here too, under `--rite-hunt-*` on `:root`.
   * They are PREFIXED because `--rite-accent` is one generic name shared by six
   * themes and can therefore only be resolved on `#rite`, which a rite has no
   * handle on. `this.forest` is the merged result — themed values over the
   * FOREST fallbacks — and it is what the draw code reads; the module constant
   * is never read directly, so a token can never be shadowed by a stale literal.
   */
  #readPalette() {
    const cs = (typeof getComputedStyle === 'function' && typeof document !== 'undefined')
      ? getComputedStyle(document.documentElement) : null;
    const tok = (name, fallback) => (cs?.getPropertyValue(name) || '').trim() || fallback;

    const rim = tok('--rite-hunt-accent', FOREST.rim);
    const accent = channels(rim, FOREST.accent);
    this.forest = {
      ...FOREST,
      canopyFar: tok('--rite-hunt-canopy-far', FOREST.canopyFar),
      canopyMid: tok('--rite-hunt-canopy-mid', FOREST.canopyMid),
      canopyNear: tok('--rite-hunt-canopy-near', FOREST.canopyNear),
      trunkFar: tok('--rite-hunt-trunk-far', FOREST.trunkFar),
      trunkNear: tok('--rite-hunt-trunk-near', FOREST.trunkNear),
      floor: tok('--rite-hunt-floor', FOREST.floor),
      rim,
      accent,
      // Derived from the accent rather than written beside it: the ground wash
      // and the mist ARE the accent at low alpha, and two hexes that have to be
      // kept in step by hand is the drift this whole change is about.
      groundHi: `rgba(${accent},0.13)`,
      mist: `rgba(${accent},0.055)`,
    };

    return {
      ink: tok('--ink', '#e9ebf3'),
      ink2: tok('--ink-2', '#a3a9bb'),
      ink3: tok('--ink-3', '#6d7488'),
      ink4: tok('--ink-4', '#4a5064'),
      gold: tok('--gold', '#e5bd79'),
      goldHi: tok('--gold-hi', '#f7dfae'),
      danger: tok('--danger', '#ff5f57'),
      line: tok('--line-2', 'rgba(255,255,255,0.14)'),
    };
  }

  // ---- generation (init only; all of it from this._fx) --------------------

  /**
   * A closed outline for a species, as BLOB_PTS points around a base ellipse.
   *
   * Generated per animal rather than shared, so fourteen deer are fourteen
   * deer and not one deer stamped fourteen times. `blob` pulls the curve toward
   * these points without passing through them, which is why a handful of
   * wobbled radii is enough to look organic — see Painter.blob.
   */
  #silhouette(species) {
    const rx = species === DEER ? 0.46 : species === BOAR ? 0.44 : 0.27;
    const ry = species === DEER ? 0.24 : species === BOAR ? 0.27 : 0.20;
    const pts = [];
    for (let k = 0; k < BLOB_PTS; k++) {
      const a = (k / BLOB_PTS) * Math.PI * 2;
      const w = 0.86 + this._fx() * 0.28;
      // The shoulder hump: boars carry their mass forward and high, deer level.
      const hump = species === BOAR ? 1 + 0.30 * Math.max(0, Math.cos(a - 0.7)) : 1;
      pts.push([Math.cos(a) * rx * w, Math.sin(a) * ry * w * hump + 0.05]);
    }
    return pts;
  }

  /** A canopy mass: a blob of `n` wobbled radii around (x, y). */
  #canopy(x, y, r) {
    const pts = [];
    for (let k = 0; k < BLOB_PTS; k++) {
      const a = (k / BLOB_PTS) * Math.PI * 2;
      const w = 0.68 + this._fx() * 0.62;
      pts.push([x + Math.cos(a) * r * w, y + Math.sin(a) * r * w * 0.78]);
    }
    return pts;
  }

  /**
   * The forest, in three layers, built once.
   *
   * DEPTH COMES FROM OVERLAP AND VALUE, NOT FROM DETAIL. Three bands of closed
   * silhouettes — far and pale, mid with trunks, near and almost black framing
   * the edges of the frame — read as a forest at a glance and cost three
   * fill calls per band. Adding leaves would cost hundreds of calls and would
   * read as noise at this scale, which is the trap this Painter invites.
   *
   * WHAT CHANGED, AND WHY THE NEAR LAYER IS NO LONGER A TREE.
   *
   * The near layer used to be two full trees: a vertical trunk with a disc of
   * canopy on top, drawn from `y = 3.3` down to `y = -5`. Two things were wrong
   * with that and the second one is structural.
   *
   *  - It read as a lollipop. A bar and a disc is what a tree looks like to a
   *    layout engine, not to an eye.
   *  - THE TRUNKS RAN DOWN THROUGH THE GROUND. The floor of this scene is drawn
   *    TOP-DOWN — an ellipse of lit clearing seen from above and in front — and
   *    the trunks were drawn SIDE-ON, crossing it. One image cannot be in two
   *    projections at once; a viewer cannot tell you why it looks wrong, only
   *    that it does.
   *
   * So the near layer is now CANOPY OVERHANG: masses whose centres sit above the
   * top edge of the field, hanging down into the corners. They frame the clearing
   * (the player is looking out from under a tree, which is where a hunter would
   * be), they cost the same two fills, and because they never reach the ground
   * there is no projection to contradict. The trunk they imply is behind the
   * viewer, which is exactly where it should be.
   *
   * The far and mid bands moved DOWN and got shorter. About 35 % of the old frame
   * was canopy that never changed and never mattered; the treeline now sits just
   * above the clearing, which is where the animals come from and therefore where
   * the player is already looking.
   */
  #forest() {
    const out = [];
    for (let i = 0; i < TREES_FAR; i++) {
      const x = lerp(-9.4, 9.4, (i + this._fx() * 0.9) / TREES_FAR);
      const y = 1.05 + this._fx() * 0.85;
      const r = 0.95 + this._fx() * 0.80;
      out.push({ layer: 0, x, y, r, trunk: 0, sway: 0, pts: this.#canopy(x, y, r) });
    }
    for (let i = 0; i < TREES_MID; i++) {
      const x = lerp(-9.0, 9.0, (i + 0.2 + this._fx() * 0.7) / TREES_MID);
      const y = 0.72 + this._fx() * 0.70;
      const r = 0.78 + this._fx() * 0.55;
      // The mid trunks stop AT the treeline (see #drawTrees), never below it.
      out.push({
        layer: 1, x, y, r, trunk: 0.08 + this._fx() * 0.05,
        sway: 0.10 + this._fx() * 0.10, pts: this.#canopy(x, y, r),
      });
    }
    for (let i = 0; i < TREES_NEAR; i++) {
      // Overhang. `y` is ABOVE the top of the field (FIELD.hh is 4.5) so only the
      // underside of the mass is ever on screen, and `r` is large enough that the
      // corner is filled rather than dotted.
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * (4.6 + this._fx() * 3.4);
      const y = 5.5 + this._fx() * 0.9;
      const r = 2.6 + this._fx() * 1.4;
      out.push({
        layer: 2, x, y, r, trunk: 0,
        // The one moving thing in the top third of the frame. Pure function of
        // `this.t`, so draw() stays pure — see the banner above draw().
        sway: 0.16 + this._fx() * 0.14, pts: this.#canopy(x, y, r),
      });
    }
    return out;
  }

  // ---- the round ----------------------------------------------------------

  /**
   * The animal that is currently shootable, or null.
   *
   * Written as a search rather than as a stored index even though the schedule
   * guarantees at most one is live at a time (the widest window, WINDOW_MAX
   * 1.25 s, is shorter than the rival source's target spacing, ~1.35 s). A
   * stored index would be a second source of truth that a retune of either
   * constant could silently desynchronise; the search cannot go stale, and
   * `tests/unit/hunt-rite.test.js` pins the one-at-a-time property separately.
   */
  liveAnimal() {
    for (const a of this.animals) if (a.state === 'live') return a;
    return null;
  }

  update(dt, input) {
    if (!this._started) { this._started = true; this.#cue('start', 0); }
    this.t += dt;
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt);

    // 1. Time advances the animals: they step out, and they are taken from you
    //    if you do not take them first. The deadline is checked BEFORE the
    //    shots so that a click arriving on the same step the deadline passes
    //    resolves as a loss — `t < claimAt` is strict, and reversing the order
    //    here would quietly turn the boundary into `<=`.
    for (const a of this.animals) {
      if (a.state === 'wait' && this.t >= a.appearAt) a.state = 'live';
      if (a.state === 'live' && this.t >= a.claimAt) {
        a.state = 'claimed';
        a.endedAt = this.t;
        this.claimed++;
        this.#cue('claim', a.x);
      }
    }

    // 2. The shots. One per step at most survives the recoil lock, which is
    //    also what makes `action > 1` in a single step harmless.
    for (const c of input.clicks) {
      if (this.recoil > 0) { this.blockedAt = this.t; continue; }
      this.recoil = RECOIL;
      this.shots++;
      // The record is POOLED (contract.js): read x/y here, never keep `c`.
      this.#resolveShot(c.x, c.y);
    }

    this.#stepDust(dt);

    // 3. End when the round is spent, plus a beat for the last exit to play.
    if (this.t >= DURATION) return true;
    let last = -1;
    for (const a of this.animals) {
      if (a.state === 'wait' || a.state === 'live') return undefined;
      if (a.endedAt > last) last = a.endedAt;
    }
    return this.t >= last + EXIT_HOLD;
  }

  /**
   * A shot lands. Everything the rite is about happens in these fifteen lines.
   */
  #resolveShot(x, y) {
    this.flashAt = this.t;
    this.flashX = x;
    this.flashY = y;

    // Nearest live animal within its own hit disc. The disc is centred on the
    // BODY rather than on the record's ground point, because the player is
    // aiming at the silhouette they can see, not at the animal's feet.
    let hit = null;
    let best = Infinity;
    let nearest = null;
    let nearestD = Infinity;
    for (const a of this.animals) {
      if (a.state !== 'live') continue;
      const d = Math.hypot(x - a.x, y - (a.y + this.#bodyLift(a)));
      if (d < nearestD) { nearestD = d; nearest = a; }
      if (d <= a.hitR && d < best) { best = d; hit = a; }
    }

    if (hit) {
      const w = Math.max(1e-6, hit.claimAt - hit.appearAt);
      const p = clamp((this.t - hit.appearAt) / w, 0, 1);
      hit.state = 'taken';
      hit.endedAt = this.t;
      hit.tookAt = p;
      this.taken++;
      // 'perfect' is spent only on a snap shot. A rite that resolves fourteen
      // times in twenty seconds and kicks the stage every time is nausea, not
      // impact — the same reasoning that put 'tick' in the host's cue table.
      if (p <= SNAP_FRAC) { this.snap++; this.#cue('perfect', x); }
      else this.#cue('good', x);
      this.#burst(hit.x, hit.y + this.#bodyLift(hit), 7, 1);
      return;
    }

    // Brake #2. A shot into empty air with an animal on the field spooks it —
    // the heaviest negative cue available, because what just happened is not "a
    // miss", it is "the thing you had is gone and it was your doing".
    //
    // THE GRAZE BAND, AND WHY BRAKE #2 NEEDED ONE. The rule above used to fire
    // on any shot outside the kill disc, however close. That reads as the same
    // event to the code and as two completely different events to the player: a
    // round that whistles past the animal's shoulder is not the same mistake as
    // a round fired into the bushes, and only the second is the panic-clicking
    // this brake exists to punish. Worse, it made aim wobble instantly fatal,
    // which is what flattened this rite into a pass/fail switch — a hand that is
    // 0.4 u off is a middling player, and the rite scored them exactly as it
    // scored someone who walked away.
    //
    // So a near miss is a GRAZE: the animal holds, and the shot costs only the
    // 0.45 s recoil. That is not mercy — at these window widths the recoil is
    // usually longer than what is left of the deadline, so a graze still loses
    // the animal MOST of the time, and only the round's stragglers (the long
    // tail of WINDOW_TAIL) leave room for the second shot. It is the difference
    // between "usually fatal" and "always fatal", and that difference is the
    // entire mid-band.
    //
    // The anti-mash property is untouched, and that is arithmetic rather than
    // hope: the graze band is a disc of about 4 square units in a 144 square
    // unit field, so a shot at a random point lands inside it ~3 % of the time.
    // Spraying still destroys the round.
    if (nearest) {
      if (nearestD > nearest.hitR + GRAZE_BAND * nearest.scale) {
        nearest.state = 'spooked';
        nearest.endedAt = this.t;
        this.spooked++;
        this.#cue('break', x);
        this.#burst(nearest.x, nearest.y, 5, 0);
        return;
      }
      this.grazed++;
      this.#cue('miss', x);
      this.#burst(x, y, 4, 0);
      return;
    }
    this.#cue('miss', x);
    this.#burst(x, y, 3, 0);
  }

  /** How far above its ground point an animal's mass sits, in world units. */
  #bodyLift(a) { return 0.30 * a.scale; }

  /** Push `n` particles into the ring. Overwrites the oldest; never allocates. */
  #burst(x, y, n, warm) {
    for (let k = 0; k < n; k++) {
      const p = this.dust[this._dustAt];
      this._dustAt = (this._dustAt + 1) % DUST_MAX;
      // Deterministic spray from the presentation generator. Cosmetic only:
      // nothing here is ever read by score(), so advancing _fx in update is
      // safe for the seed contract (it is not ctx.rand) and safe for replay
      // (the number of update() calls is fixed by the host's fixed step).
      const a = this._fx() * Math.PI * 2;
      const s = 0.6 + this._fx() * 2.0;
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s;
      p.vy = Math.abs(Math.sin(a)) * s * 0.8 + 0.4;
      p.max = 0.28 + this._fx() * 0.34;
      p.life = p.max;
      p.r = 0.03 + this._fx() * 0.05;
      p.warm = warm;
    }
  }

  #stepDust(dt) {
    for (const p of this.dust) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy -= 5.4 * dt;
      p.vx *= 0.94;
    }
  }

  /** Queue a presentation cue. Bounded: the host drains every frame anyway. */
  #cue(type, x) {
    if (this._events.length < 32) this._events.push({ type, x });
  }

  // ---- drawing ------------------------------------------------------------
  // NOTHING BELOW THIS LINE MUTATES THE INSTANCE. Every animated value is a
  // pure function of `this.t` and the records fixed in init, which is what lets
  // the host skip draw() entirely on a zero-sized canvas without the round
  // diverging (docs/MINIGAMES.md §5) — and what the purity test pins.

  draw(g, alpha = 0) {
    // `alpha` is the fraction into the next step. Used only for the countdown
    // ring, which is the one element where 16 ms of lag is legible: it is a
    // deadline, and a deadline that stutters reads as unfair.
    const t = this.t + alpha * (1 / 60);
    const P = this.palette;

    // The field is 16x9 and the host letterboxes to exactly that, but a rite
    // that draws scenery deliberately past its own edges (the overhang masses
    // hang in from above, the bolt animation runs an animal 9.5 units sideways)
    // must say so rather than trust the canvas to be the same rectangle.
    g.clipRect(0, 0, FIELD.w, FIELD.h, () => {
      this.#drawSky(g, t);
      this.#drawTrees(g, 0, t);
      this.#drawTrees(g, 1, t);
      this.#drawFloor(g);
      for (const a of this.animals) this.#drawAnimal(g, a, t, P);
      this.#drawDust(g);
      this.#drawTrees(g, 2, t);
    });
    this.#drawHud(g, t, P);
  }

  #drawSky(g, t) {
    // Dusk sits in the canopy and dies before it reaches the floor. Drawn as
    // one gradient rather than as stacked translucent bands: at this contrast
    // the banding of the cheap version is visible on an OLED panel.
    //
    // NIGHT is the `occurrence` variation (see init): the second time a run
    // sends you into this forest it is later, the sky is colder and there is a
    // moon in it. STRUCTURAL ONLY — nothing here is read by score() and no
    // number in the round changes, which is the rule ctx.occurrence carries.
    const night = this.night;
    g.rect(0, 2.0, FIELD.w, 5.4, {
      fill: g.linearFill(0, 4.5, 0, -0.7, night ? [
        [0, 'rgba(120,150,205,0.15)'],
        [0.45, 'rgba(58,80,120,0.08)'],
        [1, 'rgba(4,6,10,0)'],
      ] : [
        [0, 'rgba(134,194,148,0.16)'],
        [0.45, 'rgba(70,116,84,0.09)'],
        [1, 'rgba(4,8,6,0)'],
      ]),
    });
    g.save().add();
    if (night) {
      g.halo(4.9, 3.35, 4.4, '150,178,225', 0.10, 0.22);
      g.circle(4.9, 3.35, 0.30, { fill: 'rgba(214,226,248,0.85)' });
    } else {
      g.halo(0, 2.6, 7.4, this.forest.accent, 0.075, 0.35);
    }
    // Motes drifting through the last of the light. Eight of them, pure
    // functions of t, so the sky is never a still photograph.
    for (let k = 0; k < 8; k++) {
      const ph = k * 2.399;
      const mx = Math.sin(t * 0.21 + ph) * 6.4 + Math.sin(t * 0.07 + ph * 3) * 1.2;
      const my = 1.1 + ((t * 0.13 + k * 0.37) % 1) * 2.9;
      const fade = Math.sin(((t * 0.13 + k * 0.37) % 1) * Math.PI);
      g.circle(mx, my, 0.030, {
        fill: `rgba(${night ? '170,195,240' : this.forest.accent},${(0.30 * fade).toFixed(3)})`,
      });
    }
    g.restore();
  }

  /**
   * One band of the treeline. `t` drives the sway, and nothing else moves.
   *
   * The mid trunks stop at TREELINE_Y instead of at 0.1, and the near band has no
   * trunk at all — see #forest for why a trunk that crosses the clearing is a
   * projection error rather than a styling choice.
   */
  #drawTrees(g, layer, t) {
    const fill = layer === 0 ? this.forest.canopyFar
      : layer === 1 ? this.forest.canopyMid : this.forest.canopyNear;
    for (const tr of this.trees) {
      if (tr.layer !== layer) continue;
      // A slow, tiny lateral drift, out of phase per tree via its own x. The top
      // third of the frame was 35 % of the picture and completely static; this
      // costs one translate per mass and is the difference between a backdrop
      // and a photograph of one.
      const sx = tr.sway ? Math.sin(t * 0.45 + tr.x * 0.7) * tr.sway : 0;
      g.save();
      if (sx) g.translate(sx, 0);
      if (tr.trunk > 0) {
        g.capsule(tr.x, tr.y, tr.x, TREELINE_Y, tr.trunk, { fill: this.forest.trunkFar });
      }
      g.blob(tr.pts, { fill });
      g.restore();
    }
  }

  /**
   * The clearing: a lit pool the animals stand in, so the subject always has
   * something to be seen AGAINST.
   *
   * THE THREE SEAMS. This method used to cut three hard horizontal lines edge to
   * edge, and a reviewer read them as a compositing fault rather than as a
   * forest — which is the correct reading, because that is what they were:
   *
   *  1. a literal `g.line(-8, 0.28, 8, 0.28, ...)` hairline at the treeline;
   *  2. the TOP EDGE of this gradient rect, whose first stop sat at full alpha
   *     exactly on the rect's own boundary, so the fill began at its brightest
   *     against whatever was behind it;
   *  3. the elliptical boundary of a flat-filled mist blob.
   *
   * Every one of them is the same mistake: a primitive whose EDGE is visible.
   * The fixes are the same shape too — the hairline is gone and the light it was
   * standing in for is now a soft band; the rect's gradient starts transparent
   * ABOVE its own top edge, so the boundary carries no value step; and the mist
   * is a `halo`, which is a radial falloff and has no edge to see.
   */
  #drawFloor(g) {
    // The wash. Note the gradient's first stop is transparent and its second is
    // the bright one: the rect's top edge is now inside a fade instead of being
    // the fade's start.
    g.rect(0, -2.4, FIELD.w, 5.4, {
      fill: g.linearFill(0, 0.3, 0, -5.1, [
        [0, 'rgba(134,194,148,0)'],
        [0.20, this.forest.groundHi],
        [0.62, 'rgba(60,100,72,0.06)'],
        [1, this.forest.groundLo],
      ]),
    });
    // The clearing's own light, and the far mist. Both radial, both edgeless.
    g.save().add();
    g.halo(0, -1.35, 7.6, this.forest.accent, 0.075, 0.30);
    g.halo(0, TREELINE_Y - 0.15, 9.0, this.forest.accent, 0.05, 0.12);
    g.restore();
    // The near ground falling into shadow at the bottom of the frame, as a
    // gradient rather than as the old hard-edged ellipse.
    g.rect(0, -3.9, FIELD.w, 1.6, {
      fill: g.linearFill(0, -3.1, 0, -4.7, [
        [0, 'rgba(3,7,5,0)'],
        [1, 'rgba(3,7,5,0.45)'],
      ]),
    });
  }

  /**
   * One animal, in whichever of its four moments it is in.
   *
   * The freeze is the beat that matters, so it gets the most drawing: a ground
   * halo that brightens (the invitation) and a ring that closes with an arc
   * draining off it (the countdown). They are the same object because they are
   * the same fact — the animal is standing still, and that is exactly the thing
   * that is about to stop being true.
   */
  #drawAnimal(g, a, t, P) {
    if (a.state === 'wait' && t < a.appearAt) return;

    const gone = a.endedAt >= 0 ? t - a.endedAt : -1;
    if (gone > Math.max(EXIT_HOLD, CLAIM_FLASH)) return;

    const w = Math.max(1e-6, a.claimAt - a.appearAt);
    const p = clamp(((a.endedAt >= 0 ? a.endedAt : t) - a.appearAt) / w, 0, 1);
    const lift = this.#bodyLift(a);

    // Where it is: emerging (sliding in from the treeline), frozen, or bolting.
    let ox = 0, oy = 0, tilt = 0, fade = 1, sink = 0;
    if (p < EMERGE_FRAC && gone < 0) {
      const e = 1 - p / EMERGE_FRAC;
      ox = a.flee * 0.85 * e * e;
      oy = 0.10 * e;
    }
    if (gone >= 0) {
      const k = clamp(gone / EXIT_HOLD, 0, 1);
      if (a.state === 'taken') {
        // It drops. A take should look like a result, not like a despawn.
        tilt = -1.15 * (1 - (1 - k) * (1 - k));
        sink = -0.16 * k;
        fade = 1 - k * 0.85;
      } else {
        // It bolts: accelerating away, leaning into the run, gone in half a
        // second. The same animation for a spook and for a claim, because from
        // where the player is standing they are the same event with different
        // causes — and the cause is spelled out by the name that flashes.
        ox = a.flee * 9.5 * k * k;
        oy = 0.10 * Math.sin(k * 18) * (1 - k);
        tilt = a.flee * 0.16;
        fade = 1 - k * 0.6;
      }
    }

    const bx = a.x + ox;
    const by = a.y + oy + sink;

    // THE SEPARATION HALO, AND WHY IT IS UNCONDITIONAL.
    //
    // There used to be a halo behind the animal and it was drawn only while the
    // animal was LIVE and past its emerge. So the two moments a player most
    // needs to find it — the instant it steps out of the treeline, and the whole
    // of its exit — were the two moments it had no separation from the
    // background at all. That is the tell arriving after the thing it is meant
    // to announce.
    //
    // It is now drawn for the animal's ENTIRE life, brightest at the emerge
    // (where finding it is the whole task) and riding `fade` out with the body.
    // It is a dark-to-light separation as much as a glow: at this size the
    // player is looking for a shape against a busy treeline, and a pool of
    // contrast under the shape is what makes one appear.
    // It is a DARK pool, not a glow, and that follows from the pelt being light
    // now (see FOREST): separation is a value DIFFERENCE, so the way to make a
    // lit hide read is to deepen what is behind it, not to brighten it. An
    // additive glow here would raise the background toward the subject and undo
    // the contrast the palette was rebuilt to get.
    const emergePop = p < EMERGE_FRAC && gone < 0 ? 1 - p / EMERGE_FRAC : 0;
    g.save().alpha(fade);
    g.halo(bx, by + lift * 0.6, (2.4 + 0.5 * emergePop) * a.scale,
      '2,6,4', 0.50 + 0.22 * emergePop, 0.26);
    g.restore();

    // Contact shadow, so the animal is planted rather than floating. Drawn AFTER
    // the halo so the halo does not wash it out.
    g.save().alpha(fade * 0.55);
    g.ellipse(bx, by - 0.03, 0.60 * a.scale, 0.13 * a.scale, 0, { fill: 'rgba(2,5,3,0.9)' });
    g.restore();

    // The freeze beat.
    if (a.state === 'live' && p >= EMERGE_FRAC) {
      const pf = clamp((p - EMERGE_FRAC) / (1 - EMERGE_FRAC), 0, 1);
      const urgent = pf > 0.72;
      const ring = lerp(1.55, 0.86, pf) * a.scale;
      const col = urgent ? P.danger : P.gold;

      // On top of the unconditional halo above: the freeze brightens.
      g.save().add();
      g.halo(bx, by + lift * 0.6, 2.3 * a.scale, this.forest.ember, 0.04 + 0.12 * pf, 0.42);
      g.restore();

      g.circle(bx, by + lift, ring, { stroke: `rgba(233,235,243,${(0.14 + 0.16 * pf).toFixed(3)})`, width: 0.018 });
      // The arc drains clockwise from the top: the deadline, made of the only
      // thing a player can read at a glance while aiming — an angle.
      const sweep = (1 - pf) * Math.PI * 2;
      g.save().alpha(0.55 + 0.45 * pf);
      g.arc(bx, by + lift, ring, Math.PI / 2 - sweep, Math.PI / 2, col, 0.055 + 0.03 * pf);
      g.restore();
      if (urgent) {
        // A second channel for the last quarter second, because a hue shift
        // alone is not a signal a deutan player receives: the ring also beats.
        const beat = 0.5 + 0.5 * Math.sin(t * 26);
        g.circle(bx, by + lift, ring + 0.10 + 0.06 * beat, { stroke: `rgba(255,95,87,${(0.20 * beat).toFixed(3)})`, width: 0.03 });
      }
    }

    // The animal itself, drawn twice: once swollen in near-black as a KEYLINE,
    // then properly on top. The keyline is what guarantees a closed edge all the
    // way round whatever the animal happens to be standing in front of — the
    // treeline behind it is a different value in every part of the frame, and a
    // subject that relies on its background to define its edge is the failure
    // this whole redraw is about. Scaling the same routine is also the only way
    // to outline a shape assembled from a dozen unrelated primitives without
    // computing their union.
    g.save();
    g.alpha(fade * 0.9);
    g.translate(bx, by - 0.012 * a.scale);
    g.rotate(tilt);
    g.scale(a.scale * a.face * 1.13, a.scale * 1.13);
    this.#drawBody(g, a, true);
    g.restore();

    g.save();
    g.alpha(fade);
    g.translate(bx, by);
    g.rotate(tilt);
    g.scale(a.scale * a.face, a.scale);
    this.#drawBody(g, a, false);
    g.restore();

    // The sting: a rival's name over the animal they took.
    if (a.state === 'claimed' && gone >= 0 && gone < CLAIM_FLASH) {
      const k = gone / CLAIM_FLASH;
      const alpha = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
      const ny = a.y + lift + 0.95 + 0.55 * k;
      const size = 0.34;
      const wpx = approxTextWidth(a.claimant, size) + 0.42;
      g.save().alpha(clamp(alpha, 0, 1));
      g.rect(a.x, ny, wpx, 0.5, { radius: 0.1, fill: 'rgba(4,10,7,0.72)', stroke: `rgba(${this.forest.accent},0.45)`, width: 0.016 });
      g.text(a.claimant, a.x, ny, { size, fill: this.forest.rim, tracking: 0.05 });
      g.restore();
    }

    // The take: one expanding ring, and nothing else. A take is already the
    // loudest thing on screen because the animal fell over.
    if (a.state === 'taken' && gone >= 0 && gone < 0.42) {
      const k = gone / 0.42;
      g.save().add().alpha(1 - k);
      g.circle(a.x, a.y + lift, 0.35 + 1.5 * k, { stroke: P.goldHi, width: 0.05 * (1 - k) });
      g.restore();
    }
  }

  /**
   * A species, in unit space: facing +x, feet at y = -0.55, mass around origin.
   *
   * ONE ANIMAL, NOT A KIT OF PARTS. The old version alternated `dark` and `mid`
   * between neighbouring limbs, and a reviewer's verdict was that you could
   * "count the four leg capsules, the body blob and the neck as separate
   * values". That is exactly what alternating fills does: a value change reads
   * as an OBJECT boundary, so putting one between a leg and the body announces
   * that they are two things. Value is for LIGHT, and light on an animal at
   * dusk comes from above.
   *
   * So the drawing order is now anatomical rather than decorative:
   *
   *   1. the FAR side — the two legs on the other side of the body, and the far
   *      ear — in `peltDark`. One step down, and they are the only things that
   *      get it, because they are the only things genuinely in shadow;
   *   2. the NEAR MASS — body, near legs, neck, head, haunch — all in `pelt`,
   *      one flat value, overlapping, so no internal edge exists to be counted;
   *   3. the light along the spine and the few dark accents, small enough that
   *      they describe the form instead of cutting it up.
   *
   * `keyline` is the swollen pass from #drawAnimal: everything in near-black,
   * same geometry, so the outline follows the real silhouette exactly.
   *
   * The TUSK used to be `#d9d2c4` — a near-white diagonal that read, in the
   * reviewer's words, as a scratch on the monitor. It is now bone against the
   * hide it sits on rather than the brightest pixel in the frame.
   */
  #drawBody(g, a, keyline) {
    const F = this.forest;
    const mid = keyline ? '#030704' : F.pelt;
    const dark = keyline ? '#030704' : F.peltDark;
    const deep = keyline ? '#030704' : F.peltShade;
    const bone = keyline ? '#030704' : '#c9b593';
    // The rim is a warm highlight now, not a green one: the animal is lit by the
    // same dusk as the clearing, and an accent-green edge on a tan hide reads as
    // a UI overlay stuck to it rather than as light.
    const rim = keyline ? '#030704' : 'rgba(247,223,174,0.55)';
    const eye = keyline ? '#030704' : '#f7dfae';
    const legR = a.species === HARE ? 0.042 : 0.058;

    if (a.species === DEER) {
      // 1. far side
      g.capsule(-0.28, -0.05, -0.36, -0.55, legR, { fill: dark });
      g.capsule(0.22, -0.05, 0.16, -0.55, legR, { fill: dark });
      // 2. near mass, all one value
      g.blob(a.body, { fill: mid });
      g.capsule(-0.18, -0.05, -0.10, -0.55, legR, { fill: mid });
      g.capsule(0.32, -0.05, 0.40, -0.55, legR, { fill: mid });
      g.capsule(0.34, 0.14, 0.56, 0.46, 0.10, { fill: mid });          // neck
      g.capsule(0.56, 0.50, 0.82, 0.44, 0.085, { fill: mid });         // head
      g.circle(-0.46, 0.16, 0.075, { fill: mid });                     // tail
      g.capsule(0.56, 0.56, 0.48, 0.74, 0.032, { fill: mid });         // ear
      // 3. accents
      g.capsule(0.82, 0.44, 0.90, 0.42, 0.055, { fill: deep });        // muzzle
      // Antlers: two strokes and two tines. Any more and they read as a bush.
      g.line(0.62, 0.62, 0.54, 1.02, deep, 0.032, 'round');
      g.line(0.54, 1.02, 0.34, 1.14, deep, 0.026, 'round');
      g.line(0.62, 0.62, 0.82, 0.98, deep, 0.030, 'round');
      g.line(0.82, 0.98, 0.97, 1.06, deep, 0.024, 'round');
      g.line(-0.40, 0.27, 0.34, 0.25, rim, 0.036, 'round');            // spine light
      g.line(0.40, 0.26, 0.60, 0.54, rim, 0.030, 'round');
      g.ellipse(0.70, 0.52, 0.034, 0.028, 0, { fill: eye });
    } else if (a.species === BOAR) {
      g.capsule(-0.24, -0.10, -0.30, -0.55, legR, { fill: dark });
      g.capsule(0.20, -0.10, 0.14, -0.55, legR, { fill: dark });
      g.poly([[0.38, 0.20], [0.48, 0.20], [0.40, 0.38]], { fill: dark });  // far ear
      g.blob(a.body, { fill: mid });
      g.capsule(-0.14, -0.10, -0.06, -0.55, legR, { fill: mid });
      g.capsule(0.30, -0.10, 0.38, -0.55, legR, { fill: mid });
      g.capsule(0.40, 0.06, 0.68, -0.04, 0.17, { fill: mid });         // head
      g.capsule(0.68, -0.04, 0.84, -0.08, 0.085, { fill: deep });      // snout
      g.line(0.72, -0.02, 0.83, 0.13, bone, 0.030, 'round');           // tusk
      g.line(-0.34, 0.26, 0.46, 0.19, rim, 0.040, 'round');
      g.ellipse(0.57, 0.06, 0.030, 0.026, 0, { fill: eye });
    } else {
      g.capsule(-0.18, -0.14, -0.26, -0.55, legR, { fill: dark });
      g.capsule(0.30, 0.24, 0.42, 0.58, 0.032, { fill: dark });        // far ear
      g.blob(a.body, { fill: mid });
      g.capsule(0.10, -0.14, 0.18, -0.55, legR, { fill: mid });
      g.capsule(-0.20, -0.02, -0.30, -0.30, 0.105, { fill: mid });     // haunch
      g.circle(0.27, 0.16, 0.130, { fill: mid });                      // head
      g.capsule(0.24, 0.24, 0.30, 0.64, 0.034, { fill: mid });         // near ear
      g.circle(-0.31, 0.10, 0.062, { fill: rim });                     // scut
      g.line(-0.18, 0.22, 0.21, 0.25, rim, 0.030, 'round');
      g.ellipse(0.33, 0.18, 0.028, 0.025, 0, { fill: eye });
    }
  }

  #drawDust(g) {
    g.save();
    for (const p of this.dust) {
      if (p.life <= 0) continue;
      const k = p.life / p.max;
      g.alpha(k * 0.7);
      g.circle(p.x, p.y, p.r * (0.5 + k), { fill: p.warm ? this.forest.rim : 'rgba(150,140,120,0.9)' });
    }
    g.restore();
  }

  /**
   * The read-at-a-glance layer.
   *
   * Fourteen pips, one per animal, each in its own final state. A player who
   * looks up for a tenth of a second between shots learns three things from it
   * — how far through the round they are, how they are doing, and (from the
   * gaps) whether they are losing animals to rivals or scaring them off
   * themselves. A number would carry only the second.
   */
  #drawHud(g, t, P) {
    const gap = 0.42;
    const x0 = -((ANIMALS - 1) * gap) / 2;
    for (const a of this.animals) {
      const x = x0 + a.i * gap;
      const y = 4.08;
      if (a.state === 'taken') {
        g.circle(x, y, 0.13, { fill: P.goldHi });
      } else if (a.state === 'claimed') {
        g.circle(x, y, 0.12, { stroke: this.forest.rim, width: 0.035 });
      } else if (a.state === 'spooked') {
        g.line(x - 0.10, y - 0.10, x + 0.10, y + 0.10, P.danger, 0.035, 'round');
        g.line(x - 0.10, y + 0.10, x + 0.10, y - 0.10, P.danger, 0.035, 'round');
      } else if (a.state === 'live') {
        g.circle(x, y, 0.15 + 0.03 * Math.sin(t * 12), { stroke: P.gold, width: 0.03 });
      } else {
        g.circle(x, y, 0.06, { fill: P.ink4 });
      }
    }

    g.text(`${this.taken} / ${EXPECTED}`, 7.5, 4.06, {
      size: 0.40, fill: this.taken >= EXPECTED ? P.goldHi : P.ink2, align: 'right', tracking: 0.04,
    });

    // Who you are shooting against. Three names, dim, permanent — the deadline
    // has a face on it and this is where the face lives.
    //
    // MOVED, AND GIVEN SEPARATORS. They used to sit at the top left, at y 4.06,
    // where the corner canopy is: dim grey text over a near-black tree, running
    // together into one string ("Kavi Wren Tovi") because the only thing between
    // two names was a gap the same size as the tracking inside them. They are
    // now on the bottom rail beside the trigger, over the darkest and emptiest
    // part of the frame, with a dot between them so three names read as three.
    const roster = this.rivals.roster();
    let rx = -7.6;
    for (let k = 0; k < roster.length; k++) {
      const name = roster[k].name;
      g.text(name, rx, -4.14, { size: 0.30, fill: P.ink3, align: 'left', tracking: 0.05 });
      rx += approxTextWidth(name, 0.30) + 0.22;
      if (k < roster.length - 1) {
        g.circle(rx, -4.12, 0.035, { fill: P.ink4 });
        rx += 0.30;
      }
    }

    // The trigger. A bar that refills, and a red pulse when a click was eaten
    // by it — a silently swallowed input is the one thing a reaction game may
    // never do without saying so.
    const ready = 1 - clamp(this.recoil / RECOIL, 0, 1);
    const blocked = clamp(1 - (t - this.blockedAt) / 0.22, 0, 1);
    g.rect(0, -4.16, 2.4, 0.10, { radius: 0.05, fill: 'rgba(255,255,255,0.08)' });
    if (ready > 0) {
      g.rect(-1.2 + (2.4 * ready) / 2, -4.16, 2.4 * ready, 0.10, {
        radius: 0.05, fill: ready >= 1 ? P.gold : `rgba(${this.forest.accent},0.75)`,
      });
    }
    if (blocked > 0) {
      g.save().alpha(blocked);
      g.rect(0, -4.16, 2.6, 0.18, { radius: 0.09, stroke: P.danger, width: 0.03 });
      g.restore();
    }

    // The muzzle mark: where the last shot actually landed. It is the only
    // feedback that distinguishes "I missed" from "I was locked out".
    const since = t - this.flashAt;
    if (since >= 0 && since < 0.2) {
      const k = since / 0.2;
      g.save().add().alpha(1 - k);
      g.circle(this.flashX, this.flashY, 0.10 + 0.5 * k, { stroke: P.ink, width: 0.03 * (1 - k) });
      g.restore();
    }
  }

  // ---- result -------------------------------------------------------------

  /**
   * PURE. Called by the host, by the result card and constantly by tests.
   *
   * `taken / EXPECTED`, clamped. Clamped rather than capped at ANIMALS because
   * exceeding the expectation should feel like exceeding it right up to the
   * moment it stops paying more — and because the reward curve
   * (contract.js minigameReward) has no headroom above 1 to hand out anyway.
   */
  score() {
    const ratio = clamp(this.taken / EXPECTED, 0, 1);
    const headline = this.taken === 0 ? 'The forest kept them'
      : this.taken >= ANIMALS - 1 ? 'Unerring'
        : this.taken >= EXPECTED ? 'Sure hand'
          : this.taken >= EXPECTED / 2 ? 'Fed the camp'
            : 'One for the pot';
    return {
      ratio,
      headline,
      // Grazes are on the card because they are the one outcome the player
      // cannot tell apart from a spook while they are playing — both are "I
      // fired and it is gone" — and the difference is exactly the lesson the
      // rite wants to teach: one of them was the rivals, the other was you.
      detail: `${this.taken}/${ANIMALS} taken · ${this.claimed} claimed · `
        + `${this.spooked} spooked · ${this.grazed} grazed`,
    };
  }

  drainEvents() { return this._events.splice(0, this._events.length); }

  teardown() { this._events.length = 0; }
}

/** @type {import('../contract.js').MinigameDef} */
export const HUNT_RITE = {
  id: 'hunt',
  name: 'Game Hunt',
  hint: 'Shoot before a rival does — click or Space. A miss spooks it.',
  duration: DURATION,
  theme: 'hunt',
  eyebrow: 'Hunt',
  abandonNote: 'You left the forest',
  // No `cursor`: the stylesheet's crosshair is exactly right for an aiming rite.
  create: () => new HuntRite(),
};

export {
  HuntRite, RAND_CALLS, ANIMALS, EXPECTED, RECOIL, DURATION,
  RIVAL_COUNT, WINDOW_MAX, WINDOW_MIN, HIT_R, EMERGE_FRAC, GRAZE_BAND,
};
