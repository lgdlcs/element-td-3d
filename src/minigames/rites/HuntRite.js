/**
 * GAME HUNT — the reaction shot, in a 3D forest clearing.
 *
 * You sit in a hunting blind above a clearing at dusk. One at a time, fourteen
 * animals (deer, boar, hare) burst out of a bush and dash for the next one, on
 * one of three lanes at three distances. Three rival hunters sit in stands at
 * the treeline. Shoot the runner before the rival whose deadline it carries
 * does. That is the whole game: aim, click, one verb.
 *
 * LOGIC ONLY. The clearing, the stands and the rifle are HuntView.js. This file
 * is pure and node-testable: no DOM, no three, no Math.random.
 *
 * "FIRST TO SHOOT", STATED PLAINLY. There is no network (docs/MINIGAMES.md
 * §14-15). Every animal carries a PRE-DRAWN DEADLINE with a rival's name on it,
 * `claimAt = rivals.claimTime(i)`: land a hit at `t < claimAt` and it is yours,
 * otherwise that rival fires and it is theirs. Strictly `<` (the deadline is
 * aged before the step's shots), so a tie is not a state this rite can be in.
 * Two players in a room face the same rivals and the same deadlines.
 *
 * THE RUN IS THE CLOCK. An animal is live for exactly its dash: it leaves one
 * bush at `appearAt` and would reach the next at `claimAt`, at constant speed.
 * So the distance left to the bush IS the time left, and a fast runner is a
 * short window. Nothing needs a countdown ring or a sentence of rules.
 *
 * REACTION, NOT PREDICTION. The shot is hitscan: it resolves against where the
 * animal IS on the step of the press. `fishing` is the leading shot (its hook
 * sinks while the fish swims); nothing here may grow a travel time, or two of
 * the rites in a run become one game.
 *
 * THE ONE BRAKE. Unlimited ammo, but every shot costs a RELOAD, during which
 * the trigger is dead. A miss therefore costs real time out of a window that is
 * usually shorter than two reloads, which is the whole anti-mash rule: spraying
 * the field spends the trigger on nothing. The old second brake (a miss spooked
 * the animal, with a graze band to soften it) is gone: it needed a paragraph to
 * explain and the reload already prices a miss.
 *
 * CONTROLS: left click, right click and Space are one verb (§1.2). The rite
 * reads `input.clicks`, which carries the position AT THE PRESS.
 */

import { clamp, lerp } from '../contract.js';
import { SeededRivals, PER_RIVAL } from '../rivals.js';

/** Seconds on the clock. The host enforces it too. */
const DURATION = 20;

/** Animals in a round. One per rival claim slot, ~1.35 s apart. */
const ANIMALS = 14;

/**
 * The denominator of the score: `ratio = clamp(taken / EXPECTED)`. Ten of the
 * fourteen: two runners overlap at times, so taking every one is a flawless
 * round rather than a good one, and a good one should still pay in full.
 */
const EXPECTED = 10;

/** Rivals in the stands. */
const RIVAL_COUNT = 3;

/** Seconds the trigger is dead after a shot. The one brake. */
const RECOIL = 0.32;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, on every wave.
 *
 *   RIVAL_COUNT * PER_RIVAL   the roster, drawn inside SeededRivals
 *   ANIMALS * ANIMAL_DRAWS    species, gap+direction, lane, temperament rank
 *   + 1                       the view's cosmetic seed (`fxSeed`)
 */
const ANIMAL_DRAWS = 4;
const RAND_CALLS = RIVAL_COUNT * PER_RIVAL + ANIMALS * ANIMAL_DRAWS + 1;

/**
 * THE DASH WINDOW, from leaving cover to the rival's shot.
 *
 *     window = (SHORT + (LONG - SHORT) * u^POW + GAIN * (claimTime(0) - ANCHOR))
 *              * (1 - WAVE_DROP * waveT)
 *
 * `u` is the animal's TEMPERAMENT rung (see `rungs`): every round holds the
 * same ladder from skittish sprinters to slow stragglers, and the seed only
 * decides which animal gets which. That spread is what gives the score a
 * mid-band on every seed: a player catches the runners inside their reach and
 * misses the rest. The roster flavours the whole ladder a little (GAIN), and the
 * wave shrinks all of it, which is the difficulty axis.
 */
const WINDOW_SHORT = 0.35;
const WINDOW_LONG = 2.3;
const WINDOW_POW = 2.3;
const WINDOW_GAIN = 0.10;
const WINDOW_ANCHOR = 1.55;
const WINDOW_WAVE_DROP = 0.75;
/** Eased, so the squeeze is gentle early in a run and bites late. */
const WINDOW_WAVE_EASE = 1.5;
const WINDOW_MIN = 0.28;
/**
 * THE STRAGGLER FLOOR, which the wave does not touch. The top few rungs keep a
 * long run at every wave, so a clumsy hand still has something to catch at
 * wave 53 and the score keeps a middle instead of collapsing to zero. Steep
 * (`u^4`), so it is the top quarter of the ladder and not a general discount.
 */
const FLOOR_BASE = 0.3;
const FLOOR_SPAN = 2.1;
const FLOOR_POW = 4;
/** Must stay under twice the rivals' CLAIM_SPACING (2.7 s), or three animals run at once. */
const WINDOW_MAX = 2.4;

/** A beat of empty clearing before the first deadline, and a pad before the last. */
const OPEN_DELAY = 0.5;
const END_PAD = 0.2;

/** A take inside this fraction of the dash is a snap shot and earns 'perfect'. */
const SNAP_FRAC = 0.34;

/** Seconds the last fall plays before the rite ends. */
const EXIT_HOLD = 0.7;

/**
 * THE SPECIES. Size is the honest difficulty dial in an aiming game, and the
 * player can see it: a hare is a small target and looks like one. `bob` is how
 * far the body rises on each stride, `stride` how many strides per second —
 * part of the hit test, because the disc follows the body the player sees.
 */
const SPECIES = Object.freeze([
  Object.freeze({ id: 'deer', hitR: 0.78, bob: 0.16, stride: 2.4 }),
  Object.freeze({ id: 'boar', hitR: 0.84, bob: 0.04, stride: 4.2 }),
  Object.freeze({ id: 'hare', hitR: 0.60, bob: 0.20, stride: 3.4 }),
]);

/**
 * THE LANES, NEAR FIRST. `y` is the body centre on the field, `scale` the size
 * of everything on it (hit disc included). The view puts each lane at a real
 * depth chosen so the three scales are one world size seen from three
 * distances. `cover` is where the bushes stand: an animal always runs between
 * two NEIGHBOURING bushes, so no bush ever stands in the middle of a run.
 *
 * The vertical gaps are what keeps the picture honest: a near bush tops out
 * below the mid lane's lowest disc, and a mid bush below the far lane's.
 */
const LANES = Object.freeze([
  Object.freeze({ y: -2.35, scale: 1.00, cover: Object.freeze([-6.3, -2.1, 2.1, 6.3]) }),
  Object.freeze({ y: -0.55, scale: 0.85, cover: Object.freeze([-6.6, -3.3, 0, 3.3, 6.6]) }),
  Object.freeze({ y: 0.95, scale: 0.70, cover: Object.freeze([-6.9, -4.14, -1.38, 1.38, 4.14, 6.9]) }),
]);

/** Half a bush, in field units before the lane scale. A run starts and ends at a bush's edge. */
const BUSH_R = 0.55;

/** Later waves push animals toward the far lanes: smaller and further. */
const DEPTH_WAVE = 0.34;

/** The herd's walk along the clearing: how far one animal breaks from the last. */
const X_STEP = 4.0;
const X_STEP_MIN = 1.2;

/**
 * Each draw's rank among the fourteen, as the midpoint of its rung on an even
 * ladder: `(rank + 0.5) / n`. Ties cannot happen with a float generator.
 */
function rungs(draws, key) {
  const order = draws.map((_, i) => i).sort((p, q) => draws[p][key] - draws[q][key]);
  const out = new Array(draws.length);
  for (let k = 0; k < order.length; k++) out[order[k]] = (k + 0.5) / draws.length;
  return out;
}

const LIVE = 'live', WAIT = 'wait', TAKEN = 'taken', CLAIMED = 'claimed';

// ---------------------------------------------------------------------------

class HuntRite {
  init(ctx) {
    this.wave = ctx.wave;
    /** Second visit in a run: night. The view reads it; no number changes. */
    this.night = (ctx.occurrence ?? 0) % 2 === 1;
    const waveT = clamp((ctx.wave - 3) / 50, 0, 1);

    // ---- the draws, in one fixed order, none inside a branch ---------------
    this.rivals = new SeededRivals(ctx.rand, { count: RIVAL_COUNT, wave: ctx.wave });
    const roster = this.rivals.roster();

    const flavour = WINDOW_GAIN * (this.rivals.claimTime(0) - WINDOW_ANCHOR);
    const shrink = 1 - WINDOW_WAVE_DROP * waveT ** WINDOW_WAVE_EASE;

    // Four draws per animal, all made up front in one fixed order. Reordering
    // them changes what every existing seed produces.
    const draws = [];
    for (let i = 0; i < ANIMALS; i++) {
      draws.push({ species: ctx.rand(), step: ctx.rand(), lane: ctx.rand(), temper: ctx.rand() });
    }

    // THREE OF THEM ARE DEALT AS HANDS, NOT ROLLED. Each draw is only used for
    // its RANK among the fourteen, mapped onto a fixed ladder of rungs. So every
    // round holds the same mix of species, lanes and temperaments, and the seed
    // decides only which animal gets which. Rolled independently, the number of
    // far hares or skittish sprinters in a round is a binomial, and the round
    // rolls its own difficulty on top of the player's skill.
    const uSpecies = rungs(draws, 'species');
    const uLane = rungs(draws, 'lane');
    const uTemper = rungs(draws, 'temper');

    /** @type {Array<object>} one record per animal, all made here. */
    this.animals = [];
    let prevX = 0;
    for (let i = 0; i < ANIMALS; i++) {
      const species = uSpecies[i] < 0.45 ? 0 : uSpecies[i] < 0.75 ? 1 : 2;
      const lane = Math.min(2, Math.floor(clamp(uLane[i] * (1 - DEPTH_WAVE) + DEPTH_WAVE * waveT, 0, 0.999) * 3));
      const L = LANES[lane];

      // WHERE: THE HERD WORKS ALONG THE CLEARING. Each animal breaks from the
      // bush nearest a point within X_STEP of the last one, never closer than
      // X_STEP_MIN, and runs on the way the herd is walking unless a wall says
      // otherwise. Independent positions put two consecutive animals twelve
      // units apart, and crossing twelve units is a journey, not a reaction.
      const s = draws[i].step * 2 - 1;
      const step = (s < 0 ? -1 : 1) * Math.max(X_STEP_MIN, Math.abs(s) * X_STEP);
      const want = prevX + step;
      let j = 0;
      for (let k = 1; k < L.cover.length; k++) {
        if (Math.abs(L.cover[k] - want) < Math.abs(L.cover[j] - want)) j = k;
      }
      let dir = step < 0 ? -1 : 1;
      if (j + dir < 0 || j + dir >= L.cover.length) dir = -dir;
      const edge = BUSH_R * L.scale;
      const x0 = L.cover[j] + dir * edge;
      const x1 = L.cover[j + dir] - dir * edge;
      prevX = (x0 + x1) / 2;

      const u = uTemper[i];
      const ladder = WINDOW_SHORT + (WINDOW_LONG - WINDOW_SHORT) * u ** WINDOW_POW;
      const floor = FLOOR_BASE + FLOOR_SPAN * u ** FLOOR_POW;
      const window = clamp(Math.max((ladder + flavour) * shrink, floor), WINDOW_MIN, WINDOW_MAX);
      const claimAt = Math.min(this.rivals.claimTime(i) + OPEN_DELAY, DURATION - END_PAD);
      const who = this.rivals.claimant(i);

      this.animals.push({
        i, species, lane, dir, x0, x1,
        y: L.y,
        scale: L.scale,
        hitR: SPECIES[species].hitR * L.scale,
        appearAt: claimAt - window,
        claimAt,
        /** Index into `rivals.roster()` of the hunter whose deadline this is. */
        rival: who ? roster.indexOf(who) : -1,
        claimant: who ? who.name : 'the field',
        /** 'wait' | 'live' | 'taken' | 'claimed' */
        state: WAIT,
        /** When and where it left the round. -1 while it is still running. */
        endedAt: -1,
        endX: 0,
        endY: 0,
        /** Fraction of the dash run at the take. */
        tookAt: 0,
      });
    }

    /** One draw seeds every cosmetic choice in the view. Drawn LAST. */
    this.fxSeed = Math.floor(ctx.rand() * 0xffffffff) >>> 0;

    // ---- the mutable round ------------------------------------------------
    this.t = 0;
    this.recoil = 0;
    this.shots = 0;
    this.taken = 0;
    this.claimed = 0;
    this.snap = 0;
    /** Animals each rival took, by roster index. The stands' tallies. */
    this.rivalKills = new Array(RIVAL_COUNT).fill(0);
    /** When a press was eaten by the reload. The view flashes the reload ring. */
    this.blockedAt = -2;
    /** Last pointer position, for the view's crosshair and rifle. */
    this.aimX = 0;
    this.aimY = -0.6;
    this.aimed = false;
    this._started = false;
    this._events = [];
    this._pos = { x: 0, y: 0 };
  }

  /**
   * Where animal `a`'s body centre (and hit disc) is at time `t`. PURE.
   *
   * Constant speed from `x0` to `x1` over the dash, plus the stride's bob. Before
   * the dash it waits at `x0`; after it, it holds `x1`. The view asks for any
   * `t`, and a test can ask where it will be next step.
   */
  posAt(a, t, out = { x: 0, y: 0 }) {
    const w = a.claimAt - a.appearAt;
    const run = clamp((t - a.appearAt) / w, 0, 1);
    const S = SPECIES[a.species];
    const since = run * w;
    out.x = lerp(a.x0, a.x1, run);
    out.y = a.y + S.bob * a.scale * Math.abs(Math.sin(Math.PI * S.stride * since));
    return out;
  }

  /**
   * The most urgent animal running (the earliest deadline), or null. Two can be
   * running at once: a window is up to WINDOW_MAX and the deadlines are spaced
   * CLAIM_SPACING apart, so the next animal breaks cover while the last is
   * still in the open.
   */
  liveAnimal() {
    let best = null;
    for (const a of this.animals) if (a.state === LIVE && (!best || a.claimAt < best.claimAt)) best = a;
    return best;
  }

  update(dt, input) {
    if (!this._started) { this._started = true; this._events.push({ type: 'start' }); }
    this.t += dt;
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt);
    if (input.inside) { this.aimX = input.x; this.aimY = input.y; this.aimed = true; }

    // 1. Time first: animals break cover, and rivals fire on their deadlines.
    //    Before the shots, so a press on the step that crosses `claimAt` finds
    //    nothing live: that ordering is what makes the deadline strict.
    for (const a of this.animals) {
      if (a.state === WAIT && this.t >= a.appearAt) a.state = LIVE;
      if (a.state === LIVE && this.t >= a.claimAt) {
        this.posAt(a, this.t, this._pos);
        this.#end(a, CLAIMED);
        this.claimed++;
        if (a.rival >= 0) this.rivalKills[a.rival]++;
        this._events.push({ type: 'claim', x: a.endX, y: a.endY, i: a.i, rival: a.rival });
      }
    }

    // 2. The shots. The reload lock eats every press after the first.
    for (const c of input.clicks) {
      if (this.recoil > 0) { this.blockedAt = this.t; continue; }
      this.recoil = RECOIL;
      this.shots++;
      // The record is POOLED (contract.js): read x/y here, never keep `c`.
      this.#shoot(c.x, c.y);
    }

    // 3. End at the clock, or once every animal is down and its fall has played.
    if (this.t >= DURATION) return true;
    let last = -1;
    for (const a of this.animals) {
      if (a.state === WAIT || a.state === LIVE) return undefined;
      if (a.endedAt > last) last = a.endedAt;
    }
    return this.t >= last + EXIT_HOLD;
  }

  /**
   * One shot. It hits the FRONTMOST running animal whose disc contains the
   * point (lanes are near-first, so the lower lane index wins an overlap):
   * what the player sees in front is what they hit.
   */
  #shoot(x, y) {
    let hit = null;
    for (const a of this.animals) {
      if (a.state !== LIVE || (hit && hit.lane <= a.lane)) continue;
      const p = this.posAt(a, this.t, this._pos);
      if (Math.hypot(x - p.x, y - p.y) <= a.hitR) hit = a;
    }
    if (!hit) {
      this._events.push({ type: 'miss', x, y, i: -1 });
      return;
    }
    this.posAt(hit, this.t, this._pos);
    hit.tookAt = clamp((this.t - hit.appearAt) / (hit.claimAt - hit.appearAt), 0, 1);
    this.#end(hit, TAKEN);
    this.taken++;
    const snap = hit.tookAt <= SNAP_FRAC;
    if (snap) this.snap++;
    // 'perfect' (the stage kick) only for a snap shot: fourteen kicks in
    // twenty seconds would be nausea, not impact.
    this._events.push({ type: snap ? 'perfect' : 'good', x: hit.endX, y: hit.endY, i: hit.i });
  }

  #end(a, state) {
    a.state = state;
    a.endedAt = this.t;
    a.endX = this._pos.x;
    a.endY = this._pos.y;
  }

  /** PURE. `taken / EXPECTED`, clamped. */
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
      detail: `${this.taken}/${ANIMALS} taken · ${this.claimed} to rivals · ${this.shots} shots`,
    };
  }

  drainEvents() { return this._events.splice(0, this._events.length); }

  teardown() { this._events.length = 0; }
}

/** @type {import('../contract.js').MinigameDef} */
export const HUNT_RITE = {
  id: 'hunt',
  name: 'Game Hunt',
  hint: 'Shoot each runner before a rival hunter does',
  rules: [
    'Animals dash between bushes, near and far. Shoot them mid-run.',
    'If one reaches cover, a rival hunter gets it instead.',
    'Each shot needs a reload, so make it count. 10 pays in full.',
  ],
  keys: [
    { keys: ['Mouse'], action: 'Aim' },
    { keys: ['Click', 'Space'], action: 'Shoot' },
  ],
  duration: DURATION,
  theme: 'hunt',
  eyebrow: 'Hunt',
  abandonNote: 'You left the forest',
  // The crosshair is drawn in the scene at the raycast point.
  cursor: 'none',
  create: () => new HuntRite(),
  view: () => import('./HuntView.js'),
};

export {
  HuntRite, RAND_CALLS, ANIMALS, EXPECTED, RECOIL, DURATION, RIVAL_COUNT,
  WINDOW_MAX, WINDOW_MIN, SPECIES, LANES, BUSH_R, SNAP_FRAC, EXIT_HOLD,
};
