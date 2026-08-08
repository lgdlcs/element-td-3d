/**
 * THE RIVALS — the other players in a rite, without a network.
 *
 * Four of the six minigames are competitive in their original form: "the first
 * one who clicks wins", "the last one standing", "beat them to the finish".
 * This module is what those sentences resolve to here, and it is a pure module —
 * no DOM, no sockets, no clock — so tests/unit imports it directly.
 *
 * THE MODEL, IN ONE SENTENCE: a rival is a PURE FUNCTION of (t, skill, a
 * schedule drawn once at construction), plus a single mutable penalty
 * accumulator that the player is allowed to push on.
 *
 * That is the whole idea, and everything else falls out of it:
 *
 *  - Every competitive question in every rite reduces to one comparison: does
 *    the player's instant beat the rival's PUBLISHED function? `claimTime(i)`
 *    answers it for a contested target, `positionAt(id, t)` for a race, and
 *    `outAt(id)` for an elimination. Three questions, one arithmetic answer
 *    each, no simulation to step and nothing to keep in sync.
 *  - A contested target publishes a DEADLINE and a NAME, and they are two views
 *    of ONE schedule rather than a number with a label pasted on it. See
 *    `claimTimeFor` — `claimTime` is its minimum over the field, `claimant` is
 *    its argmin, and neither can drift from the other because neither is
 *    computed independently.
 *  - It costs zero allocation and zero randomness per frame. The constructor
 *    consumes exactly `count * PER_RIVAL` values from the rite's `ctx.rand` and
 *    NOTHING at runtime, which is what keeps a rite inside the determinism
 *    contract (docs/MINIGAMES.md): the number of rand() calls must not depend on
 *    what the player did.
 *  - Two players in the same room draw the same seed, so they face the same
 *    "Kavi" with the same skill and the same schedule. Whatever the rite says
 *    about you, it says the same thing to both of you.
 *
 * WHAT THIS HONESTLY IS NOT. A ghost does not bluff, does not camp a spot
 * because you are near it, does not change plan because you took the lead.
 * Beating "Kavi" is beating a number — and every player in the room is beating
 * the same number, which flavours a solo score but does not RANK two people in
 * real time. "The first one who clicks wins" degrades into "click before the
 * deadline".
 *
 * WHY THAT IS STILL THE RIGHT TRADE TODAY. A genuine duel on the transport this
 * game currently has would be worse, not better: it is a pure relay with a score
 * broadcast at 2 Hz, no clock synchronisation, no authority and no reconnection.
 * "First to click" over that resolves on ping rather than on reflex, and the
 * loser is always whoever has the worse connection. And the real blocker is not
 * the message format, it is the RENDEZVOUS — rites fire on each player's own
 * wave progression, so two players never enter the same rite at the same moment
 * in the first place.
 *
 * THE SEAM FOR LATER: a rite only ever talks to the RivalSource interface below.
 * A future `NetworkRivals` implements the same six methods and not one line of
 * any rite changes.
 */

/**
 * @typedef {object} Rival
 * @property {number} id     Index into the roster. Stable for the rite's life.
 * @property {string} name   Display name. Drawn from NAMES, never repeated.
 * @property {number} skill  0..1. Higher is faster and finishes ahead.
 */

/**
 * @typedef {object} RivalSource
 * @property {() => Rival[]} roster
 * @property {(id: number, targetIndex: number) => number} claimTimeFor
 * @property {(targetIndex: number) => number} claimTime
 * @property {(targetIndex: number) => (Rival|null)} claimant
 * @property {(id: number, t: number) => number} positionAt
 * @property {(id: number, seconds: number) => void} applyPenalty
 * @property {(id: number) => number} outAt
 */

/**
 * Rand draws per rival, fixed forever.
 *
 * A CONSTANT, not a function of `count` or `wave`, because the whole determinism
 * contract rests on a rite's rand budget being predictable from its constructor
 * arguments alone — `tests/unit/helpers/rite-contract.js` asserts exactly that
 * across three different waves. The four draws are: name, skill, reaction jitter
 * and pace jitter. Adding a fifth is allowed; making it conditional is not.
 */
export const PER_RIVAL = 4;

/**
 * The name pool.
 *
 * Deliberately short, invented, and phonetically unlike each other — a player
 * reads a name for a tenth of a second on a result card and must be able to tell
 * "Kavi" from "Nuru" without looking twice. Twenty-four is more than four times
 * the largest roster any rite uses, so a full draw never comes close to
 * exhausting the pool and repeat rosters across a run stay rare.
 *
 * ORDER IS PART OF THE SEED CONTRACT, exactly as in registry.js: the draw below
 * indexes into this array, so reordering it changes who every existing seed
 * produces. Append, never shuffle.
 */
export const NAMES = Object.freeze([
  'Kavi', 'Nuru', 'Sable', 'Orin', 'Perah', 'Tuck',
  'Vesna', 'Iro', 'Mott', 'Larke', 'Quill', 'Bram',
  'Senna', 'Doss', 'Halix', 'Wren', 'Yara', 'Corm',
  'Ashe', 'Pike', 'Rusk', 'Tovi', 'Elda', 'Jax',
]);

/** Clamp, local so this module imports nothing. */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * A uniform in [0, 1) from three integers, with no state and no draw.
 *
 * This is what lets `claimant` vary per target without spending a single
 * `rand()`: the per-target deal is a pure HASH of (roster seed, target, step)
 * rather than a stream, so it can be evaluated for target 9 without having
 * evaluated targets 0..8 — which is exactly the property `claimTime` already
 * had and the reason the whole module is questionable in any order.
 *
 * Integer-only (`Math.imul`, `>>>`) so two engines cannot disagree about a
 * rounding bit, which is the failure mode a float hash would have across
 * clients: the same seed, a different name over the same animal.
 */
function hashU(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (b + 0x165667b1), 0xc2b2ae35);
  h = Math.imul(h ^ (c + 0x27d4eb2f), 0x2545f491);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** A float mapped into 32 bits, for folding drawn values into a hash seed. */
function bits(v) { return Math.floor((v - Math.floor(v)) * 0x100000000) >>> 0; }

/**
 * The tuning constants, in seconds.
 *
 * Sized against the rite durations in docs/MINIGAMES.md (20-26 s): the first
 * contested target is claimed around two seconds in — long enough to see it,
 * short enough that dithering costs it — and a full course takes a mid-skill
 * rival about twenty seconds, so a competent player finishes with the field
 * rather than alone. A rite that wants a different rhythm scales the RESULT; it
 * must not reach in and change these, because every rite shares them and that
 * shared feel is most of why rivals live in one module.
 */
const CLAIM_BASE = 2.1;
const CLAIM_SPACING = 1.35;
const CLAIM_URGENCY = 1.2;
/**
 * Floor under a rival's weight in the per-target deal (see `#deal`).
 *
 * The deal is skill-weighted, so the best rival takes most targets — but never
 * all of them, and a straggler is never mathematically excluded. With skills in
 * roughly 0.25..0.95 this makes the strongest rival about 1.6x as likely as the
 * weakest to be first to a given target: a field with a leader, not a field with
 * an owner. At 0 the weakest rival at skill 0.05 would be a spectator.
 */
const CLAIM_WEIGHT_FLOOR = 0.25;
const COURSE_SECONDS = 22;
const OUT_BASE = 4.5;
const OUT_SPAN = 18;
/** Beyond this, a rival is treated as having lasted the whole rite. */
const OUT_SURVIVE = 21;

/**
 * The only implementation: rivals as pre-drawn schedules.
 *
 * @implements {RivalSource}
 */
export class SeededRivals {
  /**
   * @param {() => number} rand  The rite's ctx.rand. Consumed count * PER_RIVAL
   *   times HERE and never again — see the module docblock.
   * @param {{count?: number, wave?: number}} o
   *   `wave` moves the difficulty (later waves face better rivals) and MUST NOT
   *   move the number of draws. That split is the determinism contract in one
   *   line: the wave is allowed to change the numbers, never the arithmetic.
   */
  constructor(rand, { count = 3, wave = 1 } = {}) {
    const n = Math.max(0, Math.floor(count));
    this.wave = wave;
    /**
     * How good the field is, 0.42 at the first rite to 0.78 at the last.
     *
     * Saturating rather than linear: a rite at wave 53 should be hard, but a
     * roster that is uniformly better than any human is not a difficulty curve,
     * it is a "you lose" screen with extra steps.
     */
    this.pressure = 0.42 + 0.36 * clamp((wave - 3) / 50, 0, 1);

    /** @type {Rival[]} */
    this.rivals = [];
    /** Seconds of penalty pushed on by the player. The ONLY mutable state. */
    this._penalty = new Float64Array(n);
    /** Output of `#best`, written rather than returned so nothing allocates. */
    this._bestT = Infinity;
    this._bestId = -1;

    // ---- the one and only draw -----------------------------------------
    // A fixed loop of a fixed length making a fixed number of calls each. No
    // rejection sampling, no "draw again if we already used that name": both
    // are variable-length and both would break the budget. Uniqueness comes
    // from a partial Fisher-Yates over an index list instead, which is exactly
    // one draw per rival however the numbers land.
    const bag = NAMES.map((_, i) => i);
    /** Per-rival constants, drawn once: a reaction offset and a pace scale. */
    this._react = [];
    this._pace = [];
    for (let i = 0; i < n; i++) {
      const pick = i + Math.floor(rand() * (bag.length - i));
      const j = clamp(pick, i, bag.length - 1);   // guards rand() === 1 exactly
      const tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;

      // Skill is centred on `pressure` with a spread, so a roster has a leader
      // and a straggler rather than three clones of the difficulty setting.
      const skill = clamp(this.pressure + (rand() - 0.5) * 0.34, 0.05, 0.97);
      this.rivals.push({ id: i, name: NAMES[bag[i]], skill });

      // `_react` shifts a claim earlier or later; `_pace` scales progress. Both
      // are small, and they exist so that two rivals who drew the same skill are
      // still not the same rival. Kept well under CLAIM_URGENCY so they cannot
      // invert the skill ordering — see claimTime.
      this._react.push((rand() - 0.5) * 0.5);
      this._pace.push(0.9 + rand() * 0.2);
    }

    /**
     * The seed for the per-target deal, FOLDED OUT OF THE VALUES ALREADY DRAWN
     * rather than drawn as a fifth value.
     *
     * That is not squeamishness about the budget — PER_RIVAL is allowed to grow.
     * It is that a fifth draw would shift every subsequent `ctx.rand()` in every
     * rite that builds a roster, which re-rolls the animals, the fish, the tile
     * order and the track of every seed that has ever been played, for a feature
     * that is a permutation of names. The reaction and pace jitters are already
     * a seeded, independent pair per rival; hashing their bits gives a seed with
     * the same provenance and no cost. Skill is deliberately NOT folded in, so a
     * test that pokes a skill afterwards moves the arrival times without also
     * silently re-dealing the roster underneath itself.
     */
    let s = 0x811c9dc5;
    for (let i = 0; i < n; i++) {
      s = Math.imul(s ^ bits(this._react[i] + 0.5), 0x85ebca6b) >>> 0;
      s = Math.imul(s ^ bits(this._pace[i]), 0xc2b2ae35) >>> 0;
    }
    this._dealSeed = s >>> 0;

    /**
     * Scratch, allocated once. `#rungs` fills the first, `#deal` the second, and
     * neither ever escapes the call — which is how `claimTime` keeps its "zero
     * allocation while a rite is running" promise now that it does real work.
     */
    this._rung = new Float64Array(n);
    this._deal = new Int32Array(n);
  }

  /**
   * THE SCHEDULE, in one array: the arrival offsets of the whole field at any
   * target, sorted ascending, written into `this._rung`.
   *
   * Read from the CURRENT skills rather than cached at construction, because
   * `roster()` hands out live objects and the difficulty tests poke them.
   * Insertion sort: n is at most a handful, and it sorts in place with no
   * allocation and no comparator closure.
   */
  #rungs() {
    const n = this.rivals.length;
    for (let k = 0; k < n; k++) {
      this._rung[k] = -this.rivals[k].skill * CLAIM_URGENCY + this._react[k];
    }
    for (let k = 1; k < n; k++) {
      const v = this._rung[k];
      let j = k - 1;
      while (j >= 0 && this._rung[j] > v) { this._rung[j + 1] = this._rung[j]; j--; }
      this._rung[j + 1] = v;
    }
  }

  /**
   * WHO IS ON WHICH RUNG at target `i`. Fills `this._deal` with rival ids, best
   * arrival first, and returns it.
   *
   * THIS IS THE WHOLE FIX, so it is worth being precise about what it does and
   * does not change. The old model gave each rival a fixed offset, so the field's
   * arrival times at target i were `{offset_r} + spacing * i` — and the SAME
   * rival held the smallest offset at every single target. Correct arithmetic,
   * and it meant one name owned all fourteen animals of a hunt.
   *
   * What varies per target is therefore not the LADDER but WHO STANDS ON IT. The
   * multiset of arrival times is untouched; a seeded, skill-weighted shuffle
   * decides which rival occupies which rung this time. The consequences are the
   * point:
   *
   *  - `claimTime(i)` is bit-for-bit what it was before this method existed
   *    (a permutation cannot move a minimum), so no existing seed's deadlines
   *    moved, and the "one contested target at a time" spacing that `hunt`
   *    derives its window from is exactly `CLAIM_SPACING` as it always was.
   *  - `claimant(i)` is a real answer to "who took it", not a decoration: it is
   *    the argmin of the same array whose min is the deadline.
   *  - Skill still means something. The deal is weighted by it, so the leader
   *    takes most targets over a full round — just not all of them.
   *
   * Sequential weighted sampling without replacement, with the `k`-th uniform
   * hashed from (seed, target, k). No draw, no state, no allocation, and target
   * 9 is answerable without target 8 ever being asked for.
   */
  #deal(i) {
    const n = this.rivals.length;
    const d = this._deal;
    for (let k = 0; k < n; k++) d[k] = k;
    for (let k = 0; k < n - 1; k++) {
      let total = 0;
      for (let j = k; j < n; j++) total += CLAIM_WEIGHT_FLOOR + this.rivals[d[j]].skill;
      let u = hashU(this._dealSeed, i, k) * total;
      let pick = n - 1;
      for (let j = k; j < n; j++) {
        u -= CLAIM_WEIGHT_FLOOR + this.rivals[d[j]].skill;
        if (u <= 0) { pick = j; break; }
      }
      const t = d[k]; d[k] = d[pick]; d[pick] = t;
    }
    return d;
  }

  /**
   * When rival `id` would reach contested target `targetIndex`, in seconds.
   *
   * THE PRIMITIVE. `claimTime` is the minimum of this over the field and
   * `claimant` is its argmin, which is what makes the deadline and the name two
   * views of one schedule rather than two independent stories that agree by
   * accident until someone edits one of them.
   *
   * Infinity for an id nobody dealt — the same answer an empty field gives.
   */
  claimTimeFor(id, targetIndex) {
    if (!this.rivals[id]) return Infinity;
    const i = Math.max(0, Math.floor(targetIndex));
    this.#rungs();
    const d = this.#deal(i);
    for (let k = 0; k < d.length; k++) {
      if (d[k] === id) {
        return CLAIM_BASE + CLAIM_SPACING * i + this._rung[k] + this._penalty[id];
      }
    }
    return Infinity;
  }

  /**
   * The winner of target `i` and their time, without dealing twice. Writes
   * `_bestId`/`_bestT` instead of returning a pair, so the hot path allocates
   * nothing. Private; `claimTime` and `claimant` are the public views.
   */
  #best(i) {
    this._bestT = Infinity;
    this._bestId = -1;
    const n = this.rivals.length;
    if (n === 0) return;
    this.#rungs();
    const d = this.#deal(Math.max(0, Math.floor(i)));
    const front = CLAIM_BASE + CLAIM_SPACING * Math.max(0, Math.floor(i));
    for (let k = 0; k < n; k++) {
      const t = front + this._rung[k] + this._penalty[d[k]];
      if (t < this._bestT) { this._bestT = t; this._bestId = d[k]; }
    }
  }

  /** The field, in draw order. Do not mutate — it is the rite's display list. */
  roster() { return this.rivals; }

  /**
   * When rival `id` would claim the `targetIndex`-th contested target, in
   * seconds from the start of the rite.
   *
   * Not per-rival: the rite asks "when is target i taken", and the answer is the
   * FASTEST rival's time for it, because that is the only one that matters to
   * the player. Returns Infinity when nobody is left to take it.
   *
   * The shape is `base + spacing * index - skill * urgency`: targets come up in
   * a rhythm, and a better field eats them sooner. Strictly decreasing in skill
   * for a given rival, which `tests/unit/rivals.test.js` pins — an "improvement"
   * that ever made a better rival slower would be invisible in play and would
   * quietly invert the whole difficulty curve.
   *
   * Consecutive targets are exactly `CLAIM_SPACING` apart with no penalties in
   * play, and that is load-bearing rather than incidental: `hunt` sizes its
   * contest window against it so that exactly one animal is contested at a time.
   * `#deal` was written to permute the field across the ladder precisely so it
   * could not disturb this — a permutation cannot move a minimum.
   *
   * A roster with no rivals returns Infinity: nobody takes it, ever, which is
   * the right answer for a solo rite that constructs the source anyway.
   */
  claimTime(targetIndex) {
    this.#best(targetIndex);
    return this._bestT;
  }

  /**
   * WHO takes target `i` — the rival whose `claimTimeFor` is minimal there, or
   * `null` when the field is empty.
   *
   * The method this interface was missing, and the reason it was missing is
   * instructive: `claimTime` alone is a complete answer to "did I beat the
   * field", so a rite could ship without ever asking who the field WAS. Both
   * `hunt` and `fishing` then put a name on screen anyway — one rolled it from
   * its presentation RNG, the other rotated round the roster — and in both cases
   * the name was decoration with no relationship to the number beside it. A
   * player who noticed would be right to conclude the rivals are fake.
   *
   * Returns the live roster object, not a copy: a caller wants `.name` and
   * occasionally `.skill`, and handing back a clone per call would allocate on
   * a path that is deliberately allocation-free.
   */
  claimant(targetIndex) {
    this.#best(targetIndex);
    return this._bestId < 0 ? null : this.rivals[this._bestId];
  }

  /**
   * Rival `id`'s progress at time `t`, in [0, 1] of the course.
   *
   * A pure function of the elapsed time, the rival's constants and the penalty
   * accumulated so far — no integration, no per-step state, so it can be
   * evaluated at any `t` in any order and gives the same answer. That is what
   * makes it testable at 500 sampled times and identical on every client.
   *
   * The penalty is subtracted from `t` rather than from the result: a bomb costs
   * a rival SECONDS, which is a thing a player can feel and a commentator can
   * say, not an abstract percentage of a track.
   */
  positionAt(id, t) {
    const r = this.rivals[id];
    if (!r) return 0;
    const eff = t - this._penalty[id];
    if (eff <= 0) return 0;
    const speed = (0.55 + r.skill * 0.55) * this._pace[id];
    return clamp((eff * speed) / COURSE_SECONDS, 0, 1);
  }

  /**
   * The player pushes back. Adds `seconds` of delay to everything this rival
   * does from now on, deterministically.
   *
   * THE ONE WRITE IN THE WHOLE INTERFACE, and the reason "block your opponents"
   * means something: an offroad bomb calls this, and the rival's entire future —
   * every position, every claim — shifts with it, without anything being
   * re-simulated. Negative values are ignored rather than treated as a boost;
   * there is no verb in any rite that helps a rival, and silently supporting one
   * would be an economy exploit waiting for a typo.
   */
  applyPenalty(id, seconds) {
    if (!this.rivals[id] || !(seconds > 0)) return;
    this._penalty[id] += seconds;
  }

  /**
   * When rival `id` is eliminated, in seconds, or Infinity if they survive the
   * rite. For the falling-platforms shape: the player's rank is how many of
   * these they outlasted.
   *
   * Derived from skill rather than drawn separately, so it costs no extra rand
   * and so it agrees with everything else the rival does: the rival with the
   * best arrival times is also the one who survives longest. (Which target that
   * rival actually TAKES is `claimant`'s business — `#deal` permutes who stands
   * on which rung, and skill is what weights the deal.)
   */
  outAt(id) {
    const r = this.rivals[id];
    if (!r) return Infinity;
    const life = OUT_BASE + r.skill * OUT_SPAN + this._react[id] * 2 - this._penalty[id];
    return life >= OUT_SURVIVE ? Infinity : Math.max(0, life);
  }
}
