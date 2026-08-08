/**
 * ONE SIMULATED PLAYER, SIX RITES — the instrument that makes them comparable.
 *
 * The six rites have four different verbs (chase a point, hop on an 8-way grid,
 * click a target, steer plus two buttons). Nothing can play all of them with one
 * body of code, and a bot that tried would be a strawman in five of them and a
 * fair test in one. So this file splits the player in two:
 *
 *   1. A BRAIN PER RITE (`INTENT`). It knows the game and answers ONE question
 *      per step: what does a player who reads this situation perfectly WANT to
 *      do right now? Each of the six is lifted from the strongest bot the rite's
 *      own author already wrote (provenance is named on every one). They are
 *      oracles — several read private-ish state like `inst.gone` — and that is
 *      the point: they establish the CEILING, so every score below it is caused
 *      by the degradation this file applies, not by a bot that could not play.
 *
 *   2. ONE BODY FOR ALL SIX (`makeBody`). It knows nothing about any rite. It
 *      takes the intent and pushes it through a human: a reaction delay, a hand
 *      that cannot teleport, an aim that wobbles, and decisions that sometimes
 *      come out wrong. Every rite is degraded by the SAME body, which is the
 *      only reason two rites' scores mean anything next to each other.
 *
 * WHY THIS SPLIT IS THE WHOLE DESIGN. If the degradation lived inside the six
 * brains, "heaven is harder than fishing" and "the heaven bot is worse than the
 * fishing bot" would be indistinguishable, and the calibration numbers would be
 * measuring the harness. With the body shared, the only per-rite variable left
 * is the rite. That is what a comparison needs.
 *
 * DETERMINISM. No `Math.random()` anywhere. The noise stream is
 * `mulberry32(hash(riteId, seed, wave, occurrence))` — it does NOT depend on the
 * skill vector, and the body draws a FIXED number of values per step whatever
 * the skill is (see `NOISE_DRAWS`). Two consequences, both deliberate:
 *   - the same (rite, seed, wave, skill) always produces the same score;
 *   - a skill sweep on one seed walks the SAME noise, so "more skill scored
 *     less" is a real inversion rather than two different dice rolls. Without
 *     that, monotonicity-in-skill would need dozens of seeds to see through the
 *     variance, and the sweep would not fit in a unit-test budget.
 *
 * THE FIDELITY CLAIM, STATED HONESTLY. At `SKILL_PERFECT` the body is a pass-
 * through (zero lag, infinite pointer speed, zero SD, zero noise), so a perfect
 * run here IS the author's bot, step for step. Everything else is that same bot
 * seen through a hand. This is not a claim that the reference player feels like
 * a human — it is a claim that it degrades all six rites in the same way, which
 * is the only property a calibration instrument owes anyone.
 *
 * WHAT THIS INSTRUMENT CANNOT SEE, SAID OUT LOUD. The brains are oracles: they
 * read the fall schedule, the claim deadlines, the exact hit discs. So the body
 * degrades EXECUTION (when, where, how steadily) and never KNOWLEDGE. In a rite
 * whose difficulty is mostly "can you read the warning in time", that makes
 * every number here an UPPER BOUND on what a human scores — `platforms` is the
 * clear case, and its measured curve should be read as "even knowing the whole
 * schedule, this is what execution costs you". This is a limit of the harness,
 * not of the rites, and the six rite suites' own bots have the same limit; it is
 * recorded here rather than quietly absorbed.
 *
 * BUDGET: `calibration.test.js` runs ~700 full rite playthroughs (6 rites x 5
 * skill levels x 3-6 waves x 5 seeds, ~800k fixed steps) and must stay under
 * 6 s wall clock — the whole unit suite is ~3 s for 573 tests, and a gate that
 * doubles a fast suite survives; one that takes a minute gets deleted by the
 * next person in a hurry. Measured 2.4 s. The suite prints its own elapsed time
 * so the next reader sees the number rather than trusting this sentence.
 *
 * NOT collected by vitest (only `tests/unit/**\/*.test.js` is) — this is a
 * helper. Import it from a suite.
 */

import { MINIGAMES } from '../../../src/core/Config.js';
import { mulberry32, hashStr } from '../../../src/core/Rng.js';
import { FIELD, makeInput, clickAt } from '../../../src/minigames/contract.js';
import { riteRng } from '../../../src/minigames/schedule.js';

import { HEAVEN_RITE } from '../../../src/minigames/rites/HeavenRite.js';
import {
  PLATFORMS_RITE, cellX, cellY, cellAt, neighbours,
} from '../../../src/minigames/rites/PlatformsRite.js';
import { LUCKY_SHOT_RITE, TARGETS } from '../../../src/minigames/rites/LuckyShotRite.js';
import {
  OFFROAD_RITE, HALF_W, RIVAL_COUNT as OFFROAD_RIVALS,
} from '../../../src/minigames/rites/OffroadRite.js';
import { HUNT_RITE } from '../../../src/minigames/rites/HuntRite.js';
import { FISHING_RITE, FISH, SINK, SWIMMING } from '../../../src/minigames/rites/FishingRite.js';

const DT = MINIGAMES.dt;

/** The six, in a stable order. Every table in the calibration suite uses it. */
export const RITES = Object.freeze([
  HEAVEN_RITE, PLATFORMS_RITE, LUCKY_SHOT_RITE, OFFROAD_RITE, HUNT_RITE, FISHING_RITE,
]);

export const RITE_IDS = Object.freeze(RITES.map((r) => r.id));

/** id -> def, so a caller can name a rite in a failure message. */
const BY_ID = new Map(RITES.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------
// The skill vector
// ---------------------------------------------------------------------------

/**
 * THE REFERENCE PLAYER — the one number the whole calibration hangs on.
 *
 * These four values are not measured from real players (nobody has that data
 * for this game); they are chosen to describe a *competent adult on a mouse* and
 * then held fixed forever, because the point of a reference is that it does not
 * move. Where each comes from:
 *
 *  reactionLag 0.28 s   Simple visual reaction time is ~0.25 s and a CHOICE
 *                       reaction ("which gap / which fish") is slower. 0.28 s is
 *                       17 fixed steps: long enough that a rite demanding a
 *                       sub-quarter-second read is provably unfair, short enough
 *                       that a rite with any planning horizon is unaffected.
 *  aimSd 0.25 u         World units, one sigma, on both axes. The field is 16x9,
 *                       so this is 1.6% of the width — about 25 px on a 1600 px
 *                       canvas, which is roughly where a mouse hand lands under
 *                       time pressure. Rite hit radii sit around 0.3-0.6 u, so
 *                       this SD misses sometimes and not usually. That is the
 *                       band a difficulty curve can actually be built on.
 *  decisionNoise 0.12   12% of DISCRETE decisions come out wrong (a hop to the
 *                       wrong tile, a dropped click, an occasional twitch shot).
 *                       Not per step — per decision; see `humanise`.
 *  pointerSpeed 26 u/s  The hand cannot teleport. 26 u/s crosses the 16-unit
 *                       field in 0.6 s, which is a brisk but unhurried mouse
 *                       sweep. This is what makes "the target is far away" cost
 *                       something in a click rite, and it is the reason the body
 *                       waits until the pointer has ARRIVED before committing.
 */
export const REFERENCE_SKILL = Object.freeze({
  reactionLag: 0.28,
  aimSd: 0.25,
  decisionNoise: 0.12,
  pointerSpeed: 26,
});

/** A body that does nothing to the intent. The author's bot, unmodified. */
export const SKILL_PERFECT = Object.freeze({
  reactionLag: 0, aimSd: 0, decisionNoise: 0, pointerSpeed: Infinity,
});

/**
 * The skill dial: `m` is a DEGRADATION MULTIPLIER, not a competence score.
 *
 * m = 0 is flawless, m = 1 is exactly `REFERENCE_SKILL`, m = 2 is twice as
 * laggy / twice as shaky / twice as wrong / half as quick with the mouse. A
 * single scalar rather than four independent knobs because the assertion that
 * matters — "more skill never scores less" — needs a TOTAL ORDER over players,
 * and four knobs only give a partial one. Callers who want to probe one axis can
 * still pass `over`.
 *
 * `decisionNoise` is capped at 0.9: at 1.0 every decision is wrong, which is not
 * a bad player, it is an adversary.
 */
export function skill(m, over = {}) {
  const k = Math.max(0, m);
  return Object.freeze({
    reactionLag: REFERENCE_SKILL.reactionLag * k,
    aimSd: REFERENCE_SKILL.aimSd * k,
    decisionNoise: Math.min(0.9, REFERENCE_SKILL.decisionNoise * k),
    pointerSpeed: k === 0 ? Infinity : REFERENCE_SKILL.pointerSpeed / k,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/**
 * An INTENT: what the brain wants, before a hand gets involved.
 *
 * @typedef {object} Intent
 * @property {?({x: number, y: number}|((t: number) => {x: number, y: number}))} aim
 *   Where the pointer should be, in FIELD units. `null` means "not touching the
 *   pointer this step" — the hand holds its last position and `inside` goes
 *   false, like a player who let go of the mouse.
 *
 *   IT MAY BE A FUNCTION OF TIME, AND THAT IS NOT A CONVENIENCE — IT IS WHAT
 *   KEEPS THE THREE SKILL AXES INDEPENDENT. A plain point is a decision AND a
 *   coordinate welded together, so lagging it charges the player twice: once for
 *   answering late (correct — that is `reactionLag`) and once for answering with
 *   coordinates that were true a third of a second ago (wrong — that is
 *   `aimSd`'s job, and it is not what latency does to a human, who tracks). The
 *   damage is invisible in a rite whose targets stand still and catastrophic in
 *   one whose whole design is a leading shot: `fishing`'s brain computes where a
 *   fish will be when the hook lands, and a stale copy of that number is not a
 *   worse player, it is a player aiming at a different lake.
 *
 *   So: a FUNCTION means "this is my policy, evaluate it at the moment my hand
 *   actually gets there". The lag applies to WHICH policy (which fish, which
 *   target), never to the arithmetic inside it. A plain point means "this is a
 *   place in the world" and is lagged whole, which is right for `heaven`, where
 *   the thing being read late IS the picture.
 * @property {?({x: number, y: number}|(() => {x: number, y: number}))} axis
 *   Held 8-way direction, y positive up. May be a function for the same reason
 *   `aim` may: it separates the DECISION (which tile am I going to — lagged)
 *   from the SERVO that walks there (closed-loop, unlagged). Lagging the servo
 *   too makes a bang-bang controller oscillate around its target, and the rite
 *   then gets blamed for the bot's control law rather than for its difficulty.
 *   That single mistake made `platforms` read 0.17 instead of 0.85 under nothing
 *   but a reaction time, which is a wrong answer stated confidently.
 * @property {boolean} fire  Wants a PRIMARY commit this step.
 * @property {boolean} alt   Wants a SECONDARY commit this step.
 */

/** Correlation time of the aim wobble. Below this, a hand does not re-aim. */
const DRIFT_TAU = 0.18;

/**
 * How often the player re-reads the situation, and therefore how long a misread
 * lasts. A wrong read you correct in 16 ms is not a wrong read, it is a
 * rendering artefact; 0.30 s is about one glance.
 */
const FLINCH_TICK = 0.30;

/**
 * How close the pointer must be to its target before the player commits, and
 * how long they will chase before giving up and shooting anyway.
 *
 * WITHOUT THIS, `pointerSpeed` WOULD NOT BE A DELAY, IT WOULD BE A GUARANTEED
 * MISS. Every click brain here picks a target and fires in the same step; a hand
 * with a finite speed is still at the old position when that click is emitted,
 * so a naive body would resolve every shot at wherever the mouse happened to be
 * mid-sweep — which is not a worse player, it is a different game. A human moves
 * THEN clicks. So a commit is held until the pointer is within `aimSd + 0.05` of
 * the target, and released regardless after `FIRE_PATIENCE`, which is what makes
 * a far target cost TIME (and therefore a rival's claim) rather than accuracy.
 */
const FIRE_PATIENCE = 0.5;

/** A held commit older than this is stale: the situation moved on. Drop it. */
const FIRE_STALE = 1.0;

/**
 * How long a wrong hop lasts before the player notices and steers back.
 *
 * BOUNDED, AND THE BOUND IS THE DIFFERENCE BETWEEN A MISSTEP AND A SUICIDE. An
 * earlier version latched the wrong direction until the brain changed its mind,
 * which in `platforms` means holding "left" across an eight-column grid and
 * walking off the edge — so 12% of hops became 12% chance of ending the run, and
 * the rite measured the harness again. A misstep is one hop in the wrong
 * direction followed by a correction; 0.25 s is about that.
 */
const MISSTEP_HOLD = 0.25;

/**
 * Uniforms drawn per step, ALWAYS, whatever the skill vector says.
 *
 * Fixed on purpose, and it is the same rule `assertRiteContract` enforces on the
 * rites themselves: a draw inside a branch makes two runs' streams diverge, and
 * here that would mean a skill sweep on one seed compares two different worlds
 * instead of two different players.
 */
const NOISE_DRAWS = 9;

/** The eight compass directions, for a hop that comes out wrong. */
const DIRS = Object.freeze([
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
  { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
]);

/**
 * Build the hand.
 *
 * Returns `(intent, t) => input`. The order of operations below IS the model and
 * is worth reading top to bottom: perceive late, misread sometimes, move slowly,
 * shake a little, commit when arrived, fumble sometimes.
 */
function makeBody(sk, rng) {
  const lagSteps = Math.max(0, Math.round((sk.reactionLag || 0) / DT));
  const ring = new Array(lagSteps + 1).fill(null);
  let ringAt = 0;

  const driftA = Math.exp(-DT / DRIFT_TAU);
  const driftK = Math.sqrt(1 - driftA * driftA);
  let dx = 0, dy = 0;

  let px = null, py = null;               // the hand. null until it first aims.
  let flinchSlot = -1;
  let flinchStale = false;                // this glance was a misread: hold still
  let staleX = 0, staleY = 0;

  let heldAxis = null;                    // the direction actually being pressed
  let lastWanted = '';                    // the direction the brain last wanted
  let wrongUntil = 0;                     // >0 while a misstep is being walked out

  let pending = false, pendingAge = 0;

  // Box-Muller, consuming exactly two uniforms. Never rejection-sampled: a
  // rejection loop draws a variable number of values and breaks NOISE_DRAWS.
  const gauss = () => {
    const u = Math.max(1e-9, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };

  return function body(intent, t) {
    // 1. PERCEIVE LATE. The intent acted on is the one formed `reactionLag` ago.
    ring[ringAt] = intent;
    ringAt = (ringAt + 1) % ring.length;
    const seen = ring[ringAt] ?? { aim: null, axis: null, fire: false, alt: false };

    // The fixed noise budget, drawn in one place and in one order.
    const gx = gauss(), gy = gauss();                       // 4 uniforms
    const rFlinch = rng();                                  // 1
    const rAxis = rng(), rAxisPick = rng();                 // 2
    const rFumble = rng(), rTwitch = rng();                 // 2  => NOISE_DRAWS

    const noise = sk.decisionNoise || 0;

    // 2. MISREAD SOMETIMES. `noise` of the player's glances land on the previous
    //    picture: the aim FREEZES where it was for the rest of the tick instead
    //    of following the target.
    //
    //    NOT A RANDOM JUMP. An earlier version threw the aim +-2 units on a bad
    //    read, and it turned out to measure nothing but itself: in `heaven` a
    //    two-unit jump is instant death, so at 12% noise the rite scored 0.14
    //    whatever its difficulty curve said, and the calibration table was a
    //    picture of the harness. A frozen aim is the failure a player actually
    //    has — you looked away, the world moved — and it costs exactly as much
    //    as the world moved, which is the difficulty being measured.
    const slot = Math.floor(t / FLINCH_TICK);
    if (slot !== flinchSlot) {
      flinchSlot = slot;
      flinchStale = rFlinch < noise;
      staleX = px ?? 0;
      staleY = py ?? 0;
    }

    // 3. MOVE SLOWLY, and 4. SHAKE A LITTLE. The wobble is an AR(1) so it has a
    //    correlation time: white noise at 60 Hz is a tremor no hand has, and it
    //    averages out over a hit window instead of causing misses.
    dx = dx * driftA + gx * driftK;
    dy = dy * driftA + gy * driftK;
    const sd = sk.aimSd || 0;

    // The aim point. A function is a POLICY and is evaluated NOW (see Intent);
    // a plain point is a place in the world and arrived `reactionLag` late.
    let want = null;
    if (typeof seen.aim === 'function') want = seen.aim(t);
    else if (seen.aim) want = seen.aim;

    let inside = false;
    let tx = px, ty = py;
    if (want) {
      inside = true;
      tx = (flinchStale ? staleX : want.x) + dx * sd;
      ty = (flinchStale ? staleY : want.y) + dy * sd;
      if (px === null) { px = tx; py = ty; }
      const ddx = tx - px, ddy = ty - py;
      const d = Math.hypot(ddx, ddy);
      const step = Math.min(d, (sk.pointerSpeed ?? Infinity) * DT);
      if (d > 1e-9) { px += (ddx / d) * step; py += (ddy / d) * step; }
    }
    if (px === null) { px = 0; py = 0; }

    // 5. HOP WRONG SOMETIMES. The roll is per DECISION — the step where the
    //    brain changes its mind — not per step, which is what makes 0.12 mean
    //    "12% of hops" rather than "12% of 1 200 frames".
    let axis = { x: 0, y: 0 };
    const dir = typeof seen.axis === 'function' ? seen.axis() : seen.axis;
    const wantAxis = dir && (dir.x || dir.y) ? `${dir.x},${dir.y}` : '';
    if (wantAxis !== lastWanted) {
      lastWanted = wantAxis;
      if (!wantAxis) { heldAxis = null; wrongUntil = 0; }
      else if (rAxis < noise) {
        heldAxis = DIRS[Math.min(7, Math.floor(rAxisPick * 8))];
        wrongUntil = t + MISSTEP_HOLD;
      } else { heldAxis = { x: dir.x, y: dir.y }; wrongUntil = 0; }
    }
    if (wrongUntil && t >= wrongUntil) {
      wrongUntil = 0;
      heldAxis = dir ? { x: dir.x, y: dir.y } : null;
    }
    if (heldAxis) axis = heldAxis;

    // 6. COMMIT WHEN ARRIVED. See FIRE_PATIENCE for why this is not optional.
    if (seen.fire) { if (!pending) pendingAge = 0; pending = true; }
    if (pending) pendingAge += DT;
    let fire = false;
    if (pending) {
      const arrived = tx === null || Math.hypot(tx - px, ty - py) <= sd + 0.05;
      if (arrived || pendingAge >= FIRE_PATIENCE) { fire = true; pending = false; }
      else if (pendingAge >= FIRE_STALE) { pending = false; }
    }

    // 7. FUMBLE SOMETIMES, TWITCH SOMETIMES. A dropped commit and a commit
    //    nobody asked for. The twitch rate is per SECOND (`noise * DT`), not per
    //    step: 12% of 1 200 steps would be 144 spurious clicks, which is a
    //    seizure, not a player.
    if (fire && rFumble < noise) fire = false;
    else if (!fire && rTwitch < noise * DT) fire = true;
    const alt = seen.alt && rFumble >= noise;

    return makeInput({
      x: px, y: py, inside,
      axis,
      action: fire ? 1 : 0,
      altAction: alt ? 1 : 0,
      clicks: fire ? [clickAt(px, py, 0, 'pointer')] : [],
    });
  };
}

// ---------------------------------------------------------------------------
// The six brains
// ---------------------------------------------------------------------------

const NO_INTENT = Object.freeze({ aim: null, axis: null, fire: false, alt: false });

/* ---- heaven ------------------------------------------------------------ */
/**
 * Lifted verbatim from `tests/unit/heaven-rite.test.js` (`bestY` / `SKILLED`,
 * the author's v3). Find the earliest moment anything occupies the mote's
 * column, then take the height with the most room at that moment and just after
 * it. Two weaker versions are documented at the original site; do not reinvent
 * them here.
 */
const HORIZON = 2.6;
const PROBE = 0.04;
const PHASES = Object.freeze([[0, 2], [0.22, 1], [0.55, 0.5]]);
const SAMPLES = 91;

function heavenBestY(inst) {
  let dz = 0;
  while (dz <= HORIZON && !Number.isFinite(inst.clearanceAt(inst.mx, 0, inst.t + dz))) dz += PROBE;
  if (dz > HORIZON) return 0;
  const hh = FIELD.hh - 0.2;
  let best = inst.my;
  let bestV = -Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const y = -hh + (2 * hh * i) / (SAMPLES - 1);
    let v = 0;
    for (const [d, w] of PHASES) {
      v += w * Math.max(-2.5, Math.min(0.9, inst.clearanceAt(inst.mx, y, inst.t + dz + d)));
    }
    v -= Math.abs(y - inst.my) * 0.03;
    if (v > bestV) { bestV = v; best = y; }
  }
  return best;
}

/* ---- platforms --------------------------------------------------------- */
/**
 * Lifted from `tests/unit/platforms-rite.test.js` (`skilled`). Stand still while
 * the plate is comfortable; otherwise move to whichever neighbour lasts longest.
 * Reads `inst.gone`, so it is an ORACLE and scores above any human — stated at
 * the original site and repeated here so nobody reads a perfect run as a claim
 * about the player experience.
 */
const NB = new Int32Array(4);

function platformsIntent(inst) {
  const cur = cellAt(inst.px, inst.py);
  if (cur < 0) return NO_INTENT;
  const n = neighbours(cur, NB);
  let best = cur, bestGone = inst.gone[cur];
  for (let k = 0; k < n; k++) {
    if (inst.gone[NB[k]] > bestGone) { bestGone = inst.gone[NB[k]]; best = NB[k]; }
  }
  const target = inst.gone[cur] - inst.t > 1.1 ? cur : best;
  const gx = cellX(target), gy = cellY(target);
  // The CHOICE of tile is what the reaction time delays. The walk to it is a
  // closed loop on the marker's live position, which is why this is a function.
  return {
    aim: null,
    axis: () => {
      const tx = gx - inst.px, ty = gy - inst.py;
      return {
        x: Math.abs(tx) > 0.06 ? Math.sign(tx) : 0,
        y: Math.abs(ty) > 0.06 ? Math.sign(ty) : 0,
      };
    },
    fire: false,
    alt: false,
  };
}

/* ---- luckyshot --------------------------------------------------------- */
/**
 * From `tests/unit/luckyshot-rite.test.js` (`skilled`): five aimed shots a
 * second at the most valuable standing target on screen, never the bystander.
 *
 * TWO CHANGES, BOTH OF WHICH MAKE THE BOT STRONGER, NOT WEAKER. The author's
 * version returns a neutral input on the eleven steps between shots; here the
 * aim is published EVERY step and only `fire` follows the cadence, because a
 * hand with a finite speed needs somewhere to be pointing in between. And the
 * aim is a POLICY (`t => where target i is at t`) rather than a point, so the
 * belt's motion is tracked instead of sampled once. At `SKILL_PERFECT` the
 * emitted clicks are identical to the author's — the hand teleports and the
 * policy is evaluated at the same instant, so neither change is visible.
 */
const SHOT_PERIOD = 12;

function luckyAim(inst) {
  const t = inst.t + DT;
  let best = -1, bestVal = -Infinity;
  for (let i = 0; i < TARGETS; i++) {
    const tg = inst.targets[i];
    if (tg.kind === 'bystander' || !inst.aliveAt(i, t)) continue;
    if (Math.abs(inst.xAt(i, t)) > 7) continue;
    if (tg.value > bestVal) { bestVal = tg.value; best = i; }
  }
  if (best < 0) return null;
  // `now` is the body's step time; the click it emits resolves one step later.
  return (now) => ({ x: inst.xAt(best, now + DT), y: inst.yAt(best) });
}

/* ---- offroad ----------------------------------------------------------- */
/**
 * From `tests/unit/offroad-rite.test.js` (`driver()`), bombs on. Aim at the next
 * nugget, fall back to the next gate, boost only while on the road, mine when a
 * rival is behind. Written against the public surface only, and it leads the
 * corner by 2.2 units because the car does not self-centre.
 */
function offroadIntent(inst) {
  const cam = inst.centreAt(inst.s);
  const u = inst.x - cam;

  let target = null;
  for (const c of inst.coins) {
    if (c.taken || c.s < inst.s) continue;
    if (c.s - inst.s > 9) break;
    target = { s: c.s, u: c.u };
    break;
  }
  if (!target) {
    const g = inst.gates[inst.nextGate];
    target = g ? { s: g.s, u: 0 } : { s: inst.s + 5, u: 0 };
  }

  const boost = inst.boostT <= 0 && inst.boostLeft > 0 && Math.abs(u) < HALF_W;

  let bomb = false;
  if (inst.bombsLeft > 0 && Math.abs(u) < 0.35) {
    for (let id = 0; id < OFFROAD_RIVALS; id++) {
      if (inst.s - inst.rivalDist(id, inst.t) > 3) { bomb = true; break; }
    }
  }

  return {
    aim: { x: inst.centreAt(target.s + 2.2) + target.u - cam, y: 0 },
    axis: null,
    fire: boost,
    alt: bomb,
  };
}

/* ---- hunt -------------------------------------------------------------- */
/**
 * From `tests/unit/hunt-rite.test.js` (`SKILLED` + `aim`): shoot the instant the
 * animal is up and the trigger is free, at the animal's MASS rather than its
 * feet. The 0.30 body lift is duplicated from the rite on purpose at the
 * original site — same reasoning applies to this copy.
 */
function huntIntent(inst) {
  const a = inst.liveAnimal();
  if (!a) return NO_INTENT;
  const aim = { x: a.x, y: a.y + 0.30 * a.scale };
  // The aim is published even during recoil so the hand is already there when
  // the trigger frees; only the trigger respects the lock.
  return { aim, axis: null, fire: inst.recoil <= 0, alt: false };
}

/* ---- fishing ----------------------------------------------------------- */
/**
 * From `tests/unit/fishing-rite.test.js` (`SKILLED` = `aimAt(SINK)`): cast at
 * where the nearest uncontested fish WILL BE when the hook lands. The lead is
 * the entire rite; `aimAt(0)` is the same player without it and scores far less.
 */
function fishingIntent(inst) {
  if (inst.hook || inst.t < inst.readyAt) return NO_INTENT;
  const tl = inst.t + DT + SINK;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < FISH; i++) {
    const f = inst.fish[i];
    if (f.state !== SWIMMING || inst.claimAt[i] <= tl + 0.05) continue;
    const x = inst.fishX(f, tl);
    if (Math.abs(x) > 7.2) continue;
    const d = Math.abs(x);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return NO_INTENT;
  const f = inst.fish[best];
  // A POLICY, NOT A POINT, AND THIS IS THE ONE PLACE IT IS LOAD-BEARING. The
  // lead is only correct for the instant the hook actually lands, so it is
  // recomputed against the body's current step time. Freezing it at the moment
  // the fish was CHOSEN would mean a lagged player aims a third of a second of
  // fish-travel behind the hook — which is not a worse angler, it is an angler
  // playing a rite that does not exist.
  return {
    aim: (now) => ({ x: inst.fishX(f, now + DT + SINK), y: inst.fishY(f, now + DT + SINK) }),
    axis: null, fire: true, alt: false,
  };
}

/** riteId -> (inst, step) => Intent. The only per-rite knowledge in the file. */
const INTENT = Object.freeze({
  heaven: (inst) => ({ aim: { x: inst.mx, y: heavenBestY(inst) }, axis: null, fire: false, alt: false }),
  platforms: platformsIntent,
  luckyshot: (inst, step) => ({
    aim: luckyAim(inst), axis: null, fire: step % SHOT_PERIOD === 0, alt: false,
  }),
  offroad: offroadIntent,
  hunt: huntIntent,
  fishing: fishingIntent,
});

// Fail loudly at import time rather than silently skipping a rite in a sweep: a
// calibration table with five rows and no explanation is worse than a crash.
for (const id of RITE_IDS) {
  if (typeof INTENT[id] !== 'function') {
    throw new Error(`[reference-player] no brain for rite '${id}' — the sweep would silently skip it`);
  }
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

/**
 * Play a rite once and report what happened.
 *
 * The loop is the host's: a fixed `dt`, capped at the rite's own clock, stopping
 * when the rite says it is done. `drainEvents` is called every step because the
 * host does and a rite is entitled to assume it.
 *
 * @param {object} o
 * @param {string} o.rite        Rite id.
 * @param {number} [o.seed]      Run seed. Feeds the rite's RNG AND the noise.
 * @param {number} [o.wave]      The wave being prepared. The difficulty axis.
 * @param {number} [o.occurrence] Which appearance this is. 0 or 1 in practice.
 * @param {object} [o.skill]     A skill vector; default `REFERENCE_SKILL`.
 * @param {boolean} [o.idle]     Ignore the brain entirely and send neutral input
 *   every step. This is the do-nothing baseline every rite must beat.
 * @returns {{ratio: number, headline: string, detail: string, steps: number,
 *            ended: boolean, inst: object}}
 */
export function playRite({
  rite, seed = 1234, wave = 8, occurrence = 0, skill: sk = REFERENCE_SKILL, idle = false,
} = {}) {
  const def = BY_ID.get(rite);
  if (!def) throw new Error(`[reference-player] unknown rite '${rite}'`);

  const inst = def.create();
  inst.init({
    rand: riteRng(seed, def.id, occurrence),
    wave, occurrence, width: FIELD.w, height: FIELD.h, quality: 'high',
  });

  // The noise stream is a pure function of the WORLD, never of the skill: a
  // sweep over m must walk one world, or "more skill scored less" is just two
  // dice. hashStr rather than an ad-hoc mix so the derivation is the one the
  // rest of the codebase already uses.
  const rng = mulberry32(hashStr(`refplayer:${def.id}:${seed}:${wave}:${occurrence}`));
  const brain = INTENT[def.id];
  const body = makeBody(sk, rng);

  const cap = Math.ceil(def.duration / DT) + 1;
  let steps = 0;
  let ended = false;
  for (; steps < cap; steps++) {
    const input = idle
      ? makeInput()
      : body(brain(inst, steps) ?? NO_INTENT, steps * DT);
    if (inst.update(DT, input) === true) { steps++; ended = true; break; }
    inst.drainEvents?.();
  }
  const s = inst.score();
  return {
    ratio: s.ratio, headline: s.headline, detail: s.detail, steps, ended, inst,
  };
}

/**
 * The mean ratio over several seeds. THE unit every calibration assertion uses.
 *
 * One seed is not a measurement: a rite can deal a merciful course and a brutal
 * one from two adjacent seeds, and tuning against a single draw tunes against
 * that draw. FIVE, not three, and the extra two are paid for by a specific
 * failure: at three seeds the skill sweep showed inversions of up to 0.06 (a
 * clumsier player scoring higher) that were pure sampling noise, which would
 * have forced the monotonicity assertion's slack up to where it stopped
 * catching real inversions. At five the worst residual inversion across all 18
 * rite/wave cells is 0.018, so a 0.05 slack is a genuine bound. The seeds are
 * literals so any number here is reproducible and quotable in a failure message.
 */
export const SEEDS = Object.freeze([1234, 90210, 777, 31337, 2468]);

export function meanRatio(o) {
  const seeds = o.seeds ?? SEEDS;
  let sum = 0;
  for (const seed of seeds) sum += playRite({ ...o, seed }).ratio;
  return sum / seeds.length;
}
