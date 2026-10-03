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
 * THE GAME. You do not move. Three rows of tin targets ride the rails of a
 * carnival booth at different speeds and depths — tin ducks in front (1),
 * rabbits behind them (2), clay plates at the back (3): the back rows are
 * smaller, faster and worth more. Aim with the pointer, fire with LEFT, RIGHT
 * or SPACE (all three are the same verb; see below). One target in the eighteen
 * is GOLDEN and worth four times its row, once, and one is a BYSTANDER — a
 * cardboard figure with its hands up — worth minus one.
 *
 * LOGIC ONLY. This file is pure and node-testable; the booth, the rifle and the
 * shattering plates are LuckyShotView.js, loaded by the host through
 * `def.view`. The view reads this instance and the cues it emits; nothing here
 * knows it exists.
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
 * NO DOM, NO THREE, NO Math.random — the unit suite imports this in node.
 */

import { clamp } from '../contract.js';

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

/** How long the flip-back-up animation takes, at the END of the down time. Read by the view. */
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

/** Below this many rounds the counter starts shouting. Read by the view. */
const LOW_AMMO = 5;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, every wave, always.
 *
 *   ROWS      (3) — one belt phase per row, so two rows never march in lockstep
 *   TARGETS  (18) — one lane jitter per target, so the six are not a metronome
 *   1             — which target is golden
 *   1             — which target is the bystander (drawn to avoid the golden
 *                   WITHOUT a retry loop; a retry consumes a variable number of
 *                   values and that is the classic way to desync a room)
 *   1             — the seed for the view's cosmetic variation (`fxSeed`)
 *
 * Passed to `assertRiteContract` as `randCalls`, which pins it on three waves.
 */
const RAND_CALLS = ROWS + TARGETS + 3;   // 24

/** Index from a [0,1) draw, safe even if a generator ever returns exactly 1. */
function pick(u, n) { return Math.min(n - 1, Math.floor(u * n)); }

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
    /** Per-row radius and speed for THIS wave. Read by the world and by the view. */
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
     * ONE draw becomes every cosmetic value in the view.
     *
     * `ctx.rand()` may not be consulted for presentation — the number of calls
     * would then depend on how the frame went — so the view seeds its own
     * generator from this integer. It is drawn LAST so it can never shift a
     * gameplay draw.
     */
    this.fxSeed = Math.floor(ctx.rand() * 0xffffffff) >>> 0;

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

    // ---- presentation state (written in update, only READ by the view) -----
    this.aimX = 0;
    this.aimY = ROW_TABLE[0].y;
    this.aimed = false;
    this._events = [];
    this._started = false;
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

    /**
     * Every round emits exactly ONE cue, carrying where it landed and what it
     * hit (`i`, -1 for nothing) and what that was worth. The host plays the
     * sound off `type`; the view flashes the muzzle and knocks the target over
     * off the rest. Extra fields are ignored by the host's CUES table.
     */
    if (i < 0) {
      // A MISS STILL COSTS A ROUND. That is the whole economy of the rite.
      this.streak = 0;
      this._events.push({ type: 'miss', x: cx, y: cy, i: -1, value: 0 });
      return;
    }

    const tg = this.targets[i];
    const x = this.xAt(i, this.t);
    const y = ROW_TABLE[tg.row].y;
    const value = tg.value;
    tg.downUntil = this.t + (tg.kind === 'golden' ? GOLDEN_DOWN_TIME : DOWN_TIME);
    this.points += value;

    if (tg.kind === 'bystander') {
      this.bystanderHits++;
      this.streak = 0;
      // `break` is the heaviest negative the host has: something you were
      // supposed to protect went over. Exactly right for shooting a civilian.
      this._events.push({ type: 'break', x, y, i, value });
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
      // `perfect` is spent HERE and nowhere else. A rite can resolve twenty-odd
      // times in twenty seconds; kicking the stage at full weight for each of
      // them is nausea, not impact. The golden is the one moment that earned it.
      this._events.push({ type: 'perfect', x, y, i, value });
    } else {
      this._events.push({ type: 'good', x, y, i, value });
    }
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
  hint: 'Knock down the tin targets — every shot costs a round',
  rules: [
    'Shoot the targets as they slide past. Ducks 1, rabbits 2, plates 3.',
    'The golden one pays 4x, once. The figure with raised hands costs 1.',
    '24 rounds, and a miss spends one too. 38 points pays in full.',
  ],
  keys: [
    { keys: ['Mouse'], action: 'Aim' },
    { keys: ['Click', 'Space'], action: 'Shoot' },
  ],
  duration: DURATION,
  theme: 'luckyshot',
  eyebrow: 'Gallery',
  abandonNote: 'You left the gallery',
  // The crosshair is drawn IN the scene, at the raycast point, so the OS one
  // would be a second, slightly different promise of where the shot goes.
  cursor: 'none',
  create: () => new LuckyShotRite(),
  view: () => import('./LuckyShotView.js'),
};

export {
  LuckyShotRite, RAND_CALLS, AMMO, PAR, DURATION, END_HOLD,
  ROW_TABLE, PER_ROW, TARGETS, GOLDEN_MULT, BYSTANDER_VALUE, DOWN_TIME,
  RESET_SPIN, LOW_AMMO, TRACK,
};
