/**
 * FISHING — a lake seen from the end of a pier, sixteen fish under the water,
 * three rival anglers in rowboats, and one verb: CAST.
 *
 * LOGIC ONLY. This file is pure and node-testable; the lake, the rod, the
 * lure's arc and the fish being yanked out of the water are FishingView.js,
 * loaded by the host through `def.view`. The view reads this instance and the
 * cues it emits; nothing here knows it exists.
 *
 * THE FIELD IS THE WATER SURFACE. Field x runs along the pier's edge, field y
 * runs out across the lake (FRAMES.ground), so a fish's (x, y) is the point on
 * the surface directly over it and a cast lands on the surface at the click.
 * The view puts each fish on the camera ray through that point at its own depth
 * (`placeOnRay`), so a fish deep in the water still covers the pixels its catch
 * ellipse is tested against.
 *
 * THE VERB IS THE WHOLE DESIGN, AND IT IS NOT `hunt`'s. `hunt` is a REACTION
 * shot: the animal is there, you shoot it. Fishing is a LEADING shot. A click
 * sends the lure flying in an arc from the rod; it splashes down FLIGHT seconds
 * later exactly where you clicked and catches whatever it overlaps AT THE
 * SPLASH, never what it flew over. The fish never stop, so the question is
 * "where will it be when the lure lands", which is a different mental act from
 * a reflex. The flight is a visible arc, so the delay reads as physics rather
 * than as an arbitrary rule (the side-on version dropped a sinking hook, which
 * needed a sentence to explain why it did not catch on the way down).
 *
 * THE LEAD IS A PER-FISH QUANTITY. The speed band is 3x wide and stratified, so
 * every run holds the slowest fish, the fastest, and fourteen between, and no
 * single memorised offset covers the shoal (the unit suite measures the best
 * constant and requires it to lose). The view draws the answer for the fish
 * nearest the pointer, a ring where the lure must land (`nearestFish`), on
 * every cast: a 20 s party game cannot afford a lesson. The skill left is
 * the hand's: following a ring that moves as fast as its fish, choosing which
 * fish, and not wasting a cast on the long reel of a miss.
 *
 * WHAT IS SCARCE: casts. An empty cast reels for longer than a full one, both
 * reels lengthen with the wave, and the rivals' claim schedule tightens with
 * it, so at wave 53 the lake empties before the clock does.
 *
 * NO DOM, NO THREE, NO Math.random — the unit suite imports this in node.
 */

import { clamp } from '../contract.js';
import { SeededRivals, PER_RIVAL } from '../rivals.js';

// ---- the lake -------------------------------------------------------------

/**
 * The band of lanes the shoal swims in, along field y (out from the pier).
 * Inset from the field edges so a fish's catch ellipse stays on the field.
 * The width also sets the shoal's density, and density is forgiveness: a
 * near-miss in a dense shoal lands a neighbour. ±3.2 is what the calibration
 * gate measured as fair together with RY_K.
 */
const LANE_NEAR = -3.2;
const LANE_FAR = 3.2;
/**
 * Horizontal wrap span, wider than the field: a fish swims off one side under
 * the reeds and comes back from the other two units later, so the shoal passes
 * THROUGH the frame rather than bouncing inside it.
 */
const SPAN = 20;

// ---- the cast -------------------------------------------------------------

/** Seconds from click to splash. THE constant the whole rite is built on. */
const FLIGHT = 0.45;
/**
 * Seconds of reeling after a cast that caught nothing, at wave 3. With FLIGHT it
 * makes an empty cycle 1.05 s against a full one's 0.75 s, so a player who
 * sprays gets fewer attempts than one who reads the water. That gap is the
 * anti-mash rule; there is no counter because the reel already is one.
 */
const REEL_EMPTY = 0.6;
/** Seconds of reeling after a catch, at wave 3. Shorter: the fish comes to you. */
const REEL_HELD = 0.3;
/**
 * How much longer both reels take at wave 53 than at wave 3. Together with
 * CLAIM_SQUEEZE this is the difficulty curve: fewer casts, less water. Tuned
 * against tests/unit/calibration.test.js (reference player 0.89 / 0.62 / 0.52
 * at waves 3 / 28 / 53, clumsy player 0.15 at wave 53 against a 0.10 floor).
 * 0.42 and 0.47 keep the clumsy player at 0.15 or above; 0.50 left it at 0.101.
 */
const REEL_WAVE = 0.45;
/**
 * How far the rivals' claim schedule is compressed by wave 53. rivals.js says a
 * rite wanting a different rhythm "scales the RESULT"; this is that scale. The
 * order is untouched, so `claimant(i)` still names the angler the source dealt.
 */
const CLAIM_SQUEEZE = 0.15;
/** The lure's own radius, added to a fish's catch ellipse. */
const HOOK_R = 0.15;
/**
 * Half-height of the catch ellipse (across the fish's path), as a multiple of
 * its length. Taller than the drawn body on purpose: the lead is measured along
 * x, and punishing mouse tremor on the axis the rite is not about is noise.
 */
const RY_K = 0.6;

// ---- the water's stock ----------------------------------------------------

const FISH = 16;
/** ctx.rand() draws per fish: start offset, lane, speed, length, weave rate. */
const PER_FISH = 5;
/** The speed band, wide enough that the required lead is a per-fish question. */
const SPEED_MIN = 2.0;
const SPEED_MAX = 6.0;
const LEN_MIN = 0.5;
const LEN_MAX = 0.8;
/**
 * How far a fish weaves across its lane, in field units. Enough that it
 * visibly swims rather than slides on a rail, small enough that its lane
 * stays readable.
 */
const BOB = 0.2;
const GOLD_VALUE = 3;
/**
 * The golden fish is forced into the middle of the index range. Index sets the
 * deadline, so a golden fish at index 0 would be gone before the player has
 * read the water and one at 15 would never be contested.
 */
const GOLD_LO = 4;
const GOLD_SPAN = 8;

const RIVALS = 3;
const DURATION = 20;
/**
 * The bar, as a fraction of everything in the water: two thirds of (15 plain +
 * one golden at 3x) = 11.9 points. A near-flawless run clears it at wave 3; the
 * calibration gate needs flawless play to still clear 0.75 at wave 53.
 */
const PAR_FRACTION = 0.66;
const PAR = PAR_FRACTION * (FISH - 1 + GOLD_VALUE);

/** Cue queue cap. The host drains every frame; this is the seatbelt. */
const MAX_EVENTS = 32;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, every wave, always.
 *
 *   FISH * PER_FISH  the shoal
 *   + 1              which fish is golden
 *   + RIVALS * PER_RIVAL, consumed inside SeededRivals
 *   + 1              the seed for the view's cosmetic variation (`fxSeed`)
 */
const RAND_CALLS = FISH * PER_FISH + 1 + RIVALS * PER_RIVAL + 1;

/** Fish life cycle. */
const SWIMMING = 0;
const KEPT = 1;
const LOST = 2;

/** How long a landed lure stays "the hook in the water" before the rod frees it. */
const SETTLE_HOLD = 0.18;

class FishingRite {
  init(ctx) {
    this.wave = ctx.wave;
    this.hw = ctx.width / 2;
    this.hh = ctx.height / 2;

    this.t = 0;
    this.points = 0;
    this.kept = 0;
    this.lost = 0;
    this.casts = 0;
    this.empties = 0;
    this.goldKept = false;

    /** The lure in flight or just landed, or null. One at a time: the line is the resource. */
    this.hook = null;
    /** The most recent cast, kept after `hook` clears so the view can reel it in. */
    this.last = null;
    /** Rite time before which no new cast is accepted. */
    this.readyAt = 0;
    /** Last moment a cast was refused, for the view's "still reeling" pulse. */
    this.deniedAt = -9;

    /** Difficulty from the wave moves the NUMBERS, never the number of draws. */
    const press = clamp((ctx.wave - 3) / 50, 0, 1);
    this.speedMul = 1 + 0.4 * press;
    this.reelHeld = REEL_HELD * (1 + REEL_WAVE * press);
    this.reelEmpty = REEL_EMPTY * (1 + REEL_WAVE * press);
    this.claimScale = 1 - CLAIM_SQUEEZE * press;
    /** Length of the reel currently running, so the view's dial has a denominator. */
    this.reelSpan = this.reelHeld;

    // ---- the one and only draw, in a fixed order -------------------------
    /** @type {Array<{x0:number,v:number,lane:number,len:number,bobP:number,bobW:number,gold:boolean,state:number,endAt:number}>} */
    this.fish = [];
    const stride = SPAN / FISH;
    for (let i = 0; i < FISH; i++) {
      // Start, lane, speed and length are all STRATIFIED: one fish per slice,
      // jittered inside it, so the water is the same question on every seed.
      // The lane, speed and length strata follow `i * k % FISH` with k coprime
      // to 16, so lane, speed and deadline (which follows i) are decorrelated:
      // the water does not drain from the near lanes first, and the fastest
      // fish is not always the first one taken.
      const x0 = -SPAN / 2 + (i + ctx.rand()) * stride;
      const band = ((i * 7) % FISH) + ctx.rand();
      const lane = LANE_NEAR + (band / FISH) * (LANE_FAR - LANE_NEAR);
      const sp = SPEED_MIN + ((((i * 5) % FISH) + ctx.rand()) / FISH) * (SPEED_MAX - SPEED_MIN);
      // Thue-Morse on the index: exactly eight fish each way on every seed,
      // without the comb that `i % 2` would draw over stratified starts.
      const dir = ((i ^ (i >> 1) ^ (i >> 2) ^ (i >> 3)) & 1) ? -1 : 1;
      const len = LEN_MIN + ((((i * 3) % FISH) + ctx.rand()) / FISH) * (LEN_MAX - LEN_MIN);
      this.fish.push({
        x0,
        v: dir * sp * this.speedMul,
        lane,
        len,
        // Golden angle: sixteen weave phases that never line up, for zero draws.
        bobP: i * 2.399963229728653,
        bobW: 1.3 + ctx.rand() * 1.1,
        gold: false,
        state: SWIMMING,
        /** When it left the water (caught or claimed). -9 while swimming. */
        endAt: -9,
      });
    }

    this.goldIndex = GOLD_LO + Math.floor(ctx.rand() * GOLD_SPAN);
    const gf = this.fish[this.goldIndex];
    gf.gold = true;
    gf.len = Math.min(LEN_MAX, gf.len * 1.15);
    // Worth 3x, so it must not also be the easiest fish in the lake: it swims in
    // the top fifth of the speed range.
    gf.v = Math.sign(gf.v) * (SPEED_MIN + 0.8 * (SPEED_MAX - SPEED_MIN)) * this.speedMul;

    /**
     * The other three anglers. This rite never calls applyPenalty, so the claim
     * schedule is frozen at init: `claimAt[i]` is the field's best time at fish
     * i, scaled by the wave, and `claimBy[i]` is whoever posted it.
     */
    this.rivals = new SeededRivals(ctx.rand, { count: RIVALS, wave: ctx.wave });
    this.roster = this.rivals.roster();
    this.claimAt = new Float64Array(FISH);
    this.claimBy = new Int8Array(FISH);
    for (let i = 0; i < FISH; i++) {
      this.claimAt[i] = this.rivals.claimTime(i) * this.claimScale;
      const who = this.rivals.claimant(i);
      this.claimBy[i] = who ? who.id : -1;
    }
    /** Fish taken by each rival so far. */
    this.tally = new Int32Array(RIVALS);

    /** One draw becomes every cosmetic value in the view. Drawn last. */
    this.fxSeed = Math.floor(ctx.rand() * 0xffffffff) >>> 0;

    /** Pointer, remembered from update so the view never reads an input record. */
    this.aimX = 0;
    this.aimY = 0;
    this.aimed = false;

    this._events = [{ type: 'start' }];
  }

  // ---- the water, as pure functions of time -------------------------------

  /**
   * Fish `f`'s x at rite-time `t`. PURE: the catch test evaluates it at the
   * exact splash instant (between two steps), the view at an interpolated
   * time, and the tests a flight ahead.
   */
  fishX(f, t) {
    const u = f.x0 + f.v * t + SPAN / 2;
    return ((u % SPAN) + SPAN) % SPAN - SPAN / 2;
  }

  /** Fish `f`'s y at `t`: its lane plus a gentle weave. */
  fishY(f, t) {
    return f.lane + BOB * Math.sin(f.bobW * t + f.bobP);
  }

  /** Where fish `f` will be if a lure is cast at `t`. The ghost and the tests read it. */
  leadX(f, t) { return this.fishX(f, t + FLIGHT); }
  leadY(f, t) { return this.fishY(f, t + FLIGHT); }

  /**
   * The swimming fish whose lead point is nearest (x, y) at time `t`, or -1.
   * What the view's lead ring marks. Pure.
   */
  nearestFish(x, y, t) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < FISH; i++) {
      const f = this.fish[i];
      if (f.state !== SWIMMING || t + FLIGHT >= this.claimAt[i]) continue;
      const dx = this.leadX(f, t) - x;
      const dy = this.leadY(f, t) - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /**
   * Does a lure resting at (hx, hy) overlap fish `f` at time `t`?
   *
   * An ellipse because a fish is four times longer than it is wide. The wrap is
   * handled by testing the three images of the fish, so a fish straddling the
   * seam is catchable on both sides of it.
   */
  overlaps(f, t, hx, hy) {
    const rx = f.len * 0.5 + HOOK_R;
    const ry = f.len * RY_K + HOOK_R;
    const fy = this.fishY(f, t);
    const dy = (hy - fy) / ry;
    if (dy * dy > 1) return false;
    const fx = this.fishX(f, t);
    for (let k = -1; k <= 1; k++) {
      const dx = (hx - (fx + k * SPAN)) / rx;
      if (dx * dx + dy * dy <= 1) return true;
    }
    return false;
  }

  // ---- the step -----------------------------------------------------------

  update(dt, input) {
    this.t += dt;

    if (input.inside) { this.aimX = input.x; this.aimY = input.y; }
    this.aimed = !!input.inside;

    // 1. CASTS. `clicks`, not `action` and not input.x/y: the queue carries the
    //    position captured at the press. Left, right and a Space/Enter commit
    //    are one verb. Exactly one cast per step, and the extras are dropped
    //    rather than queued: a mashed burst is one cast.
    const clicks = input.clicks;
    if (clicks && clicks.length) {
      if (this.hook || this.t < this.readyAt) {
        this.deniedAt = this.t;
      } else {
        // COPY the two numbers: the records are pooled and refilled.
        const hx = clamp(clicks[0].x, -this.hw + 0.2, this.hw - 0.2);
        const hy = clamp(clicks[0].y, -this.hh + 0.2, this.hh - 0.2);
        this.hook = { x: hx, y: hy, t0: this.t, landAt: this.t + FLIGHT, hit: -1, settledAt: -1, readyAt: Infinity };
        this.last = this.hook;
        this.casts++;
        this._push({ type: 'tick', x: hx, y: hy });
      }
    }

    // 2. THE LURE SPLASHES DOWN. Resolved BEFORE the claim sweep, and the catch
    //    test also compares the exact splash instant with the exact deadline,
    //    so the outcome never depends on which side of a step boundary they fell.
    if (this.hook) {
      if (this.hook.settledAt < 0 && this.t >= this.hook.landAt) this.#settleHook();
      if (this.hook.settledAt >= 0 && this.t >= this.hook.settledAt + SETTLE_HOLD) this.hook = null;
    }

    // 3. THE RIVALS TAKE THEIRS.
    for (let i = 0; i < FISH; i++) {
      const f = this.fish[i];
      if (f.state !== SWIMMING || this.t < this.claimAt[i]) continue;
      f.state = LOST;
      f.endAt = this.claimAt[i];
      this.lost++;
      const who = this.claimBy[i];
      if (who >= 0) this.tally[who]++;
      this._push({ type: 'claim', x: this.fishX(f, f.endAt), y: this.fishY(f, f.endAt), i, who });
    }

    // 4. THE END. An empty lake ends the rite early rather than making the
    //    player watch a clock run out over cleared water.
    if (this.t >= DURATION) return true;
    if (this.kept + this.lost >= FISH && !this.hook) return true;
    return false;
  }

  /** Resolve the landed lure against the shoal. One fish per cast, the nearest. */
  #settleHook() {
    const h = this.hook;
    const tl = h.landAt;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < FISH; i++) {
      const f = this.fish[i];
      if (f.state !== SWIMMING) continue;
      // STRICT: the player wins by being early, never by tying.
      if (!(tl < this.claimAt[i])) continue;
      if (!this.overlaps(f, tl, h.x, h.y)) continue;
      const d = Math.hypot(this.fishX(f, tl) - h.x, this.fishY(f, tl) - h.y);
      if (d < bestD) { bestD = d; best = i; }
    }

    if (best >= 0) {
      const f = this.fish[best];
      f.state = KEPT;
      f.endAt = tl;
      this.kept++;
      const value = f.gold ? GOLD_VALUE : 1;
      this.points += value;
      if (f.gold) this.goldKept = true;
      h.hit = best;
      this.reelSpan = this.reelHeld;
      this._push({ type: f.gold ? 'perfect' : 'good', x: h.x, y: h.y, i: best, value });
    } else {
      this.empties++;
      this.reelSpan = this.reelEmpty;
      this._push({ type: 'miss', x: h.x, y: h.y, i: -1, value: 0 });
    }
    this.readyAt = tl + this.reelSpan;
    h.readyAt = this.readyAt;
    h.settledAt = tl;
  }

  _push(ev) { if (this._events.length < MAX_EVENTS) this._events.push(ev); }

  // ---- the verdict --------------------------------------------------------

  /** PURE. Reads counters and nothing else. */
  score() {
    const ratio = clamp(this.points / PAR, 0, 1);
    const headline = this.casts === 0 ? 'Never cast'
      : ratio >= 0.999 ? 'Full creel'
        : ratio > 0.75 ? 'Good water'
          : ratio > 0.45 ? 'A few keepers'
            : ratio > 0.15 ? 'Slim pickings'
              : 'Out-fished';
    const bits = [`${this.kept} landed`];
    if (this.goldKept) bits.push('golden fish');
    if (this.empties) bits.push(`${this.empties} empty`);
    bits.push(`${this.lost} taken`);
    return { ratio, headline, detail: bits.join(' · ') };
  }

  drainEvents() { return this._events.splice(0, this._events.length); }

  teardown() { this._events.length = 0; }
}

/** @type {import('../contract.js').MinigameDef} */
export const FISHING_RITE = {
  id: 'fishing',
  name: 'Fishing',
  hint: 'Cast ahead of the fish — the lure takes a moment to land',
  rules: [
    'Point near a fish: a ring shows where it will be when your lure lands.',
    'Cast on the ring to catch it. Golden fish are worth 3.',
    'Rival boats take the fish you leave, and a miss reels in slowly.',
  ],
  keys: [
    { keys: ['Mouse'], action: 'Aim' },
    { keys: ['Click', 'Space'], action: 'Cast' },
  ],
  duration: DURATION,
  theme: 'fishing',
  eyebrow: 'Cast',
  abandonNote: 'You reeled in and walked off',
  // The reticle is drawn ON the water at the raycast point, so the OS crosshair
  // would be a second, slightly different promise of where the lure lands.
  cursor: 'none',
  create: () => new FishingRite(),
  view: () => import('./FishingView.js'),
};

export {
  FishingRite, RAND_CALLS, FLIGHT, REEL_EMPTY, REEL_HELD, REEL_WAVE, CLAIM_SQUEEZE,
  FISH, PAR, PAR_FRACTION, GOLD_VALUE, BOB, LANE_NEAR, LANE_FAR,
  HOOK_R, RY_K, SPEED_MIN, SPEED_MAX, LEN_MIN, LEN_MAX, SPAN, RIVALS, DURATION,
  SWIMMING, KEPT, LOST,
};
