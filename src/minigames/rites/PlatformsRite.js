/**
 * PLATFORMS — "plateforme type mario party". The logic; the 3D floor is
 * PlatformsView.js.
 *
 * Twenty-eight floating tiles over a void, 7 x 4. They shake, they glow, they
 * drop. You and three rivals hop from tile to tile, and the only verb is WHERE
 * YOU HOP.
 *
 * THE ONE SENTENCE: the floor is eaten by a collapse with a SHAPE, so the tile
 * next to you is usually going the same way yours is, and the question is which
 * corner of the floor will be the last one standing.
 *
 * WHAT CHANGED IN THE 3D REWORK, AND WHY.
 *
 *  - HOPS, NOT A SLIDING MARKER. One arrow = one hop to the next tile, holding
 *    keeps hopping, two arrows hop diagonally. The old continuous marker crossed
 *    invisible cell boundaries (the drawn gaps were "paint only"), which needed
 *    a paragraph to explain and read badly in 3D, where a character standing
 *    half over a gap looks like it should fall. A hop lands on a tile or in a
 *    hole, and the eye can see which before it happens. The commitment the old
 *    design wanted is still there: for HOP seconds you are in the air and the
 *    tile you chose may start to go while you fly at it.
 *  - NO SAG, NO PER-TILE TEMPER. A cracking tile used to pull you back toward
 *    its centre, by an amount that varied per tile. It was the mechanic that
 *    gave the old marker a skill curve, and it was invisible until you fought
 *    it: a rule a casual player meets as "the controls went sticky". With hops
 *    the skill curve comes from somewhere simpler — a hop into the wrong tile
 *    or into a hole costs the run — so the sag is deleted rather than ported.
 *  - THE EDGE IS A WALL. Hopping off the grid does nothing. Holding an arrow
 *    should run you to the edge of the floor, not off it; the void you fall
 *    into is the holes the collapse makes, which you can see.
 *
 * THE COLLAPSE (kept from the 2D rite, measured there). A uniform shuffle of the
 * fall order made "step to any tile that is not shaking" a winning strategy:
 * neighbours died independently, so a safe one was nearly always next to you.
 * Here a plate's fall time is its rank under a sum of four seeded swells plus a
 * well under the player, so neighbours die together, the ground opens under you
 * first, and the last ground standing is a pocket you have to walk to early.
 *
 * DETERMINISM. Exactly RAND_CALLS draws from ctx.rand, in a frozen order, none
 * of them inside a branch. The view's cosmetic noise comes from `fxSeed`, the
 * last of those draws. See docs/MINIGAMES.md §3.
 *
 * NO DOM, NO THREE, NO Math.random — the unit suite imports this in node.
 */

import { clamp, lerp } from '../contract.js';
import { SeededRivals, PER_RIVAL } from '../rivals.js';

// ---- the field --------------------------------------------------------------

/** 7 x 4 = 28. The count is the clock: every tile falls exactly once. */
const COLS = 7;
const ROWS = 4;
const TILES = COLS * ROWS;

/** Cell pitch in field units. Square, so a tile is a tile from any camera. */
const PITCH = 2.0;
const HALF_W = (COLS * PITCH) / 2;   // 7
const HALF_H = (ROWS * PITCH) / 2;   // 4

/**
 * Seconds in the air per hop, takeoff to landing.
 *
 * A floaty party hop: holding an arrow crosses the floor in three seconds, and
 * a hop is a commitment — a tile that starts to go while you are in the air is
 * still where you land. Measured: at 0.30 s a hop was so cheap that a slow
 * reaction cost nothing and the calibration ladder was flat.
 */
const HOP = 0.42;

// ---- the schedule -----------------------------------------------------------

/** Seconds before the first tile starts to shake. The starting gun. */
const FIRST_CRACK = 0.95;
/** Seconds held after the last tile goes, so the field is seen to empty. */
const END_HOLD = 0.5;
/** Interval between successive tile releases, wave 3 -> wave 53. */
const INTERVAL_EARLY = 0.85;
const INTERVAL_LATE = 0.42;

/**
 * How long a tile shakes before it drops, on average, wave 3 -> wave 53.
 *
 * Shorter than the 2D rite's 2.35 -> 1.30 s, because a hop is a clean exit and
 * a long shake made leaving free. With the darkened tier ahead of it (see
 * STRESS_LEAD) a careful player still gets ~2 s of notice at wave 3 and ~1.1 s
 * at wave 53; a player who only reacts to the shake gets 1.5 -> 0.85 s, minus
 * one hop. That gap is where the skill is.
 */
const WARN_EARLY = 1.5;
const WARN_LATE = 0.85;

/**
 * Each tile's shake is the wave's `warn` times 1 +- SHAKE_SPREAD, read off the
 * collapse draws. One shake length for the whole floor turns reaction time into
 * a cliff: under it you always make it, over it you never do. A spread makes
 * being slow cost a FRACTION of your hops, so the score slopes with skill. The
 * shake's own ramp in the view (glow and tremble) is what tells a quick tile
 * from a slow one.
 */
const SHAKE_SPREAD = 0.35;

/**
 * Quiet-tier lead, as a multiple of a tile's shake. PRESENTATION ONLY: the view
 * darkens a tile this far ahead of its drop, which is the planning horizon the
 * endgame needs to be read rather than guessed. Nothing in the logic reads it;
 * the calibration brain does, because a player can see it.
 */
const STRESS_LEAD = 1.3;

/**
 * The rite's own clock. At wave 3 the schedule wants ~26 s and gets 24, so a
 * couple of tiles are still standing at the end; at wave 53 the floor runs out
 * at ~13.9 s and the rite ends there. The score's denominator is `runLength`,
 * the shorter of the two.
 */
const DURATION = 24;

/** Seconds of falling shown after the player is out, before the rite returns. */
const OUT_HOLD = 1.6;

// ---- the field of play ------------------------------------------------------

const RIVAL_COUNT = 3;

/** Fixed spawns, not drawn: the variety in this rite is the fall order. */
const PLAYER_START = 2 * COLS + 3;                              // col 3, row 2
const RIVAL_STARTS = Object.freeze([COLS + 0, COLS + 6, 3]);    // (0,1) (6,1) (3,0)

/** Hard cap on a ghost's knot list: two knots per hop, a hop every HOP s at most. */
const MAX_HOPS = 96;

/** Emit `good` for a takeoff from a tile with less than this left; `perfect` under half. */
const CLUTCH = 0.36;

/** A tile dropping within this many cells of you is heard. */
const HEAR_CELLS = 1.6;

/**
 * ctx.rand() calls made by init(). EXACTLY this many, every wave, always.
 *
 * 28 for the collapse (eight of them shape it, all twenty-eight roughen it), 12
 * for the roster (RIVAL_COUNT x PER_RIVAL), 1 for the view's cosmetic seed. THE
 * ORDER IS PART OF THE SEED CONTRACT: moving the rival draw ahead of the
 * collapse rerolls every existing run's floor.
 */
const RAND_CALLS = TILES + RIVAL_COUNT * PER_RIVAL + 1;

/** The collapse swells: wavelength in cells, and amplitude. Long swells dominate. */
const SCALES = Object.freeze([5.6, 3.2, 1.9, 1.25]);
const AMPS = Object.freeze([1.0, 0.62, 0.34, 0.19]);
/** The well under the player's feet: depth in units of the swell, radius in cells. */
const WELL = 1.55;
const WELL_R = 1.5;
/** Per-plate jitter, so a ridge does not arrive as a line. */
const ROUGH = 0.16;

/** Player states. A hop is the only way to change tile. */
const STAND = 0;
const HOPPING = 1;
const OUT = 2;

const colOf = (i) => i % COLS;
const rowOf = (i) => (i / COLS) | 0;

/** Centre of cell `i`, in field units. Row 0 is the top (+y) row. */
function cellX(i) { return (colOf(i) - (COLS - 1) / 2) * PITCH; }
function cellY(i) { return ((ROWS - 1) / 2 - rowOf(i)) * PITCH; }

/** The cell under a field point, or -1 off the grid. */
function cellAt(x, y) {
  const c = Math.floor((x + HALF_W) / PITCH);
  const r = Math.floor((HALF_H - y) / PITCH);
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return -1;
  return r * COLS + c;
}

/**
 * The cell one hop from `i` along a held axis (+y is up), or -1 when the hop
 * goes nowhere. A component that would leave the grid is dropped rather than
 * the whole hop, so holding up+right against the right edge still hops up.
 */
function hopTarget(i, ax, ay) {
  let c = colOf(i) + ax;
  let r = rowOf(i) - ay;
  if (c < 0 || c >= COLS) c = colOf(i);
  if (r < 0 || r >= ROWS) r = rowOf(i);
  const to = r * COLS + c;
  return to === i ? -1 : to;
}

/** The 8-neighbours of `i`, written into `out`; returns how many. Fixed order. */
function neighbours(i, out) {
  const c = colOf(i), r = rowOf(i);
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && cc < COLS && rr >= 0 && rr < ROWS) out[n++] = rr * COLS + cc;
    }
  }
  return n;
}

/** Height of a hop's arc at progress u in [0, 1], in units of the peak. */
function arc(u) { return 4 * u * (1 - u); }

class PlatformsRite {
  init(ctx) {
    this.wave = ctx.wave;
    this.quality = ctx.quality;

    const ws = clamp((ctx.wave - 3) / 50, 0, 1);
    // Square root: the climb is front-loaded, so the middle waves already bite
    // and the last twenty are a plateau of "fast" rather than a cliff.
    const k = Math.sqrt(ws);
    this.interval = lerp(INTERVAL_EARLY, INTERVAL_LATE, k);
    this.warn = lerp(WARN_EARLY, WARN_LATE, k);

    // ---- draw 1: the collapse (28) --------------------------------------
    const u = new Float64Array(TILES);
    for (let i = 0; i < TILES; i++) u[i] = ctx.rand();

    // The quarter-turn from `occurrence` is structural variation: the second
    // time the rite appears the floor is the same floor rotated.
    const turn = (ctx.occurrence | 0) * (Math.PI / 2);
    const arrive = new Float64Array(TILES);
    const pc = colOf(PLAYER_START), pr = rowOf(PLAYER_START);
    for (let i = 0; i < TILES; i++) {
      const c = colOf(i), r = rowOf(i);
      let v = 0;
      for (let m = 0; m < SCALES.length; m++) {
        const th = u[2 * m] * Math.PI * 2 + turn;
        const ph = u[2 * m + 1] * Math.PI * 2;
        v += AMPS[m] * Math.sin((2 * Math.PI / SCALES[m]) * (c * Math.cos(th) + r * Math.sin(th)) + ph);
      }
      const d2 = ((c - pc) ** 2 + (r - pr) ** 2) / (WELL_R * WELL_R);
      arrive[i] = v - WELL * Math.exp(-d2) + u[i] * ROUGH;
    }

    // Sorting makes the release order a PERMUTATION; the index tiebreak makes
    // it a total order two clients cannot disagree about.
    const order = Array.from({ length: TILES }, (_, i) => i)
      .sort((a, b) => (arrive[a] - arrive[b]) || (a - b));
    // The player's own tile goes first, always: it is the tutorial, and it is
    // what makes "start it and look away" worth ~0.1 instead of a third.
    const at = order.indexOf(PLAYER_START);
    order[at] = order[0];
    order[0] = PLAYER_START;
    this.order = order;

    /** When each CELL drops, indexed by cell. A tile shakes for `warn` before. */
    this.gone = new Float64Array(TILES);
    // A tile STARTS to shake on a constant beat in `order`, and its own shake
    // length decides when it drops. The stride reads the draws in a different
    // order from the collapse, so "late in the fall order" and "quick to drop"
    // are not the same fact.
    this.shake = new Float64Array(TILES);
    for (let i = 0; i < TILES; i++) {
      this.shake[i] = this.warn * (1 + SHAKE_SPREAD * (2 * u[(i * 11 + 7) % TILES] - 1));
    }
    for (let n = 0; n < TILES; n++) {
      this.gone[order[n]] = FIRST_CRACK + n * this.interval + this.shake[order[n]];
    }
    let lastGone = 0;
    for (let i = 0; i < TILES; i++) lastGone = Math.max(lastGone, this.gone[i]);
    /** The scored denominator: the run the player actually got. */
    this.runLength = Math.min(lastGone + END_HOLD, DURATION);

    // ---- draw 2: the roster (12) ----------------------------------------
    this.rivals = new SeededRivals(ctx.rand, { count: RIVAL_COUNT, wave: ctx.wave });

    // ---- draw 3: the view's cosmetic seed (1) ----------------------------
    this.fxSeed = Math.floor(ctx.rand() * 0xffffffff) >>> 0;

    // ---- the ghosts ------------------------------------------------------
    this.paths = [];
    this.rivalOut = new Float64Array(RIVAL_COUNT);
    for (let id = 0; id < RIVAL_COUNT; id++) this.paths.push(this.#walkGhost(id));
    this._outEmitted = new Uint8Array(RIVAL_COUNT);

    // ---- the player ------------------------------------------------------
    this.t = 0;
    this.state = STAND;
    /** The tile you stand on, or took off from while HOPPING. */
    this.cell = PLAYER_START;
    /** The tile you are flying to while HOPPING; -1 otherwise. */
    this.to = -1;
    this.hopAt = 0;
    /** A direction pressed mid-air, taken on landing so a quick tap is never lost. */
    this.queueX = 0;
    this.queueY = 0;
    /** Last step's axis, to tell a new press from a held one. */
    this.lastX = 0;
    this.lastY = 0;
    /** Facing, for the view. Held through a stop. */
    this.fx = 0;
    this.fy = -1;
    /** Field position, refreshed every step. Read by bots and the view's camera. */
    this.px = cellX(PLAYER_START);
    this.py = cellY(PLAYER_START);
    this.alive = true;
    /** Frozen at the instant of elimination. The number the score is made of. */
    this.aliveFor = 0;
    this.outAt = Infinity;
    this._warned = false;
    this._events = [{ type: 'start' }];
  }

  /**
   * Build a rival's hop list, once, in init.
   *
   * A ghost hops to whichever neighbour lasts longest, `lag` seconds before its
   * own tile goes; a better rival has a shorter lag. It is read off the same
   * schedule the player sees, so it looks alive because it is reacting to the
   * same floor. Returned as knots (t, x, y): equal positions are a stand, a
   * change of position is a hop, so a position at any time is one lerp.
   *
   * `SeededRivals.outAt(id)` is the published elimination time and is honoured
   * as a cap: a ghost still standing when it comes misjudges a hop into the
   * void and lands at exactly that time. Whichever comes first, the trap or the
   * cap, is `rivalOut`, and that is what the score reads and the view shows.
   */
  #walkGhost(id) {
    const r = this.rivals.roster()[id];
    const skill = r ? r.skill : 0.5;
    const lag = 0.34 + (1 - skill) * 0.62;
    const capped = this.rivals.outAt(id);
    const slipAt = capped - HOP;

    let cell = RIVAL_STARTS[id];
    const t = [0];
    const xs = [cellX(cell)];
    const ys = [cellY(cell)];
    const hop = (t0, x, y) => {
      t.push(t0, t0 + HOP);
      xs.push(xs[xs.length - 1], x);
      ys.push(ys[ys.length - 1], y);
    };
    const nb = new Int32Array(8);
    let now = 0;
    let out = Infinity;

    for (let k = 0; k < MAX_HOPS; k++) {
      const g = this.gone[cell];
      const depart = Math.max(now, g - lag);
      if (depart + HOP > slipAt) {
        // The cap comes before the next hop would finish. Ride the tile down if
        // it goes first, else misjudge one hop into the void at the cap.
        const s = Math.max(now, slipAt);
        if (g <= s) { out = g; break; }
        this.#voidHop(cell, s, nb);
        hop(s, this._vx, this._vy);
        t[t.length - 1] = Math.max(s, capped);
        out = t[t.length - 1];
        break;
      }
      if (g > this.runLength) break;                              // outlasts the run
      if (depart >= g) { out = g; break; }

      let best = -1, bestGone = -Infinity;
      const n = neighbours(cell, nb);
      for (let j = 0; j < n; j++) {
        if (this.gone[nb[j]] > bestGone) { bestGone = this.gone[nb[j]]; best = nb[j]; }
      }
      hop(depart, cellX(best), cellY(best));
      const land = depart + HOP;
      if (bestGone <= land) { out = land; break; }                // hopped into a hole
      now = land;
      cell = best;
    }

    this.rivalOut[id] = out > this.runLength ? Infinity : out;
    return { t: Float64Array.from(t), x: Float64Array.from(xs), y: Float64Array.from(ys) };
  }

  /**
   * Where a ghost's fatal misjudged hop from `cell` at time `s` lands, into
   * `_vx/_vy`: a neighbouring hole if there is one by then, else just past the
   * nearest edge of the floor. Never a live tile, which would read as a ghost
   * falling through solid stone.
   */
  #voidHop(cell, s, nb) {
    const n = neighbours(cell, nb);
    for (let j = 0; j < n; j++) {
      if (this.gone[nb[j]] <= s + HOP) { this._vx = cellX(nb[j]); this._vy = cellY(nb[j]); return; }
    }
    const c = colOf(cell), r = rowOf(cell);
    const left = c + 1, right = COLS - c, up = r + 1, down = ROWS - r;
    const m = Math.min(left, right, up, down);
    this._vx = cellX(cell) + (m === left ? -left : m === right ? right : 0) * PITCH;
    this._vy = cellY(cell) + (m === left || m === right ? 0 : m === up ? up : -down) * PITCH;
  }

  /**
   * A ghost at `time`: writes `out.x`, `out.y` (field) and `out.h` (hop height,
   * 0..1 of the peak). Pure and allocation-free, so the view calls it per frame.
   */
  ghostAt(id, time, out) {
    const p = this.paths[id];
    const n = p.t.length;
    out.h = 0;
    if (time <= p.t[0]) { out.x = p.x[0]; out.y = p.y[0]; return out; }
    for (let k = 1; k < n; k++) {
      if (time <= p.t[k]) {
        const span = p.t[k] - p.t[k - 1];
        const u = span > 1e-6 ? (time - p.t[k - 1]) / span : 1;
        out.x = lerp(p.x[k - 1], p.x[k], u);
        out.y = lerp(p.y[k - 1], p.y[k], u);
        if (p.x[k] !== p.x[k - 1] || p.y[k] !== p.y[k - 1]) out.h = arc(u);
        return out;
      }
    }
    out.x = p.x[n - 1]; out.y = p.y[n - 1];
    return out;
  }

  /**
   * The player at `time` (>= the last step): the same shape as `ghostAt`.
   * Between steps this extrapolates the hop in flight, which is what lets the
   * view draw at the render rate without the rite stepping.
   */
  playerAt(time, out) {
    if (this.state === HOPPING) {
      const u = clamp((time - this.hopAt) / HOP, 0, 1);
      out.x = lerp(cellX(this.cell), cellX(this.to), u);
      out.y = lerp(cellY(this.cell), cellY(this.to), u);
      out.h = arc(u);
    } else {
      out.x = this.px; out.y = this.py; out.h = 0;
    }
    return out;
  }

  update(dt, input) {
    this.t += dt;
    const t = this.t;

    for (let i = 0; i < RIVAL_COUNT; i++) {
      if (this._outEmitted[i] || this.rivalOut[i] > t) continue;
      this._outEmitted[i] = 1;
      const p = this.paths[i];
      this._events.push({ type: 'claim', x: p.x[p.x.length - 1], i });
    }

    if (this.alive) this.#stepPlayer(t, input);

    // Tiles dropping near you are heard; the other twenty are scenery.
    for (let i = 0; i < TILES; i++) {
      const g = this.gone[i];
      if (g > t - dt && g <= t
        && Math.abs(cellX(i) - this.px) <= HEAR_CELLS * PITCH
        && Math.abs(cellY(i) - this.py) <= HEAR_CELLS * PITCH) {
        this._events.push({ type: 'break', x: cellX(i), y: cellY(i), i });
      }
    }

    if (!this.alive && t >= this.outAt + OUT_HOLD) return true;
    if (t >= this.runLength) {
      if (this.alive) this.aliveFor = this.runLength;
      return true;
    }
  }

  #stepPlayer(t, input) {
    const ax = input.axis?.x ?? 0;
    const ay = input.axis?.y ?? 0;

    // A press that STARTS mid-air is queued for the landing; a key merely held
    // through the hop is not, or one long press would be two hops.
    const pressed = (ax || ay) && (ax !== this.lastX || ay !== this.lastY);
    this.lastX = ax; this.lastY = ay;

    if (this.state === HOPPING) {
      if (pressed) { this.queueX = ax; this.queueY = ay; }
      if (t - this.hopAt < HOP - 1e-9) {
        const u = (t - this.hopAt) / HOP;
        this.px = lerp(cellX(this.cell), cellX(this.to), u);
        this.py = lerp(cellY(this.cell), cellY(this.to), u);
        return;
      }
      this.cell = this.to;
      this.to = -1;
      this.state = STAND;
      this.px = cellX(this.cell);
      this.py = cellY(this.cell);
      this._warned = this.gone[this.cell] - this.shake[this.cell] <= t;
      if (this.gone[this.cell] <= t) { this.#fall(t); return; }
    }

    // Standing. A tile that has gone takes you with it.
    if (this.gone[this.cell] <= t) { this.#fall(t); return; }

    const hx = ax || ay ? ax : this.queueX;
    const hy = ax || ay ? ay : this.queueY;
    this.queueX = 0; this.queueY = 0;
    const to = hx || hy ? hopTarget(this.cell, hx, hy) : -1;
    if (to >= 0) {
      const left = this.gone[this.cell] - t;
      if (left < CLUTCH) {
        this._events.push({ type: left < CLUTCH / 2 ? 'perfect' : 'good', x: this.px, y: this.py });
      }
      this.state = HOPPING;
      this.to = to;
      this.hopAt = t;
      this.fx = Math.sign(cellX(to) - cellX(this.cell));
      this.fy = Math.sign(cellY(to) - cellY(this.cell));
      return;
    }

    if (!this._warned && this.gone[this.cell] - this.shake[this.cell] <= t) {
      // Your own tile just started to shake. Silent-bodied cue: once per tile.
      this._warned = true;
      this._events.push({ type: 'tick', x: this.px, y: this.py });
    }
  }

  #fall(t) {
    this.alive = false;
    this.state = OUT;
    this.aliveFor = t;
    this.outAt = t;
    this._events.push({ type: 'fail', x: this.px, y: this.py });
  }

  // ---- scoring --------------------------------------------------------------

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

  /** Tiles still standing at `time`. */
  standing(time = this.t) {
    let n = 0;
    for (let i = 0; i < TILES; i++) if (this.gone[i] > time) n++;
    return n;
  }

  /**
   * `0.75 x (alive / runLength) + 0.25 x (outlived / 3)`. The first term is
   * "the longer you stay up, the more it pays"; the second is the only thing
   * that makes the rivals more than scenery.
   */
  score() {
    const alive = this.aliveTime();
    const outlived = this.outlived(alive);
    const survival = clamp(alive / this.runLength, 0, 1);
    const ratio = clamp(0.75 * survival + 0.25 * (outlived / RIVAL_COUNT), 0, 1);
    return {
      ratio,
      headline: ratio >= 0.9 ? 'Last one standing'
        : ratio >= 0.66 ? 'Sure-footed'
          : ratio >= 0.4 ? 'Kept hopping'
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
  hint: 'Hop off a tile before it drops: the longer you stay up, the more it pays',
  rules: [
    'Hop from tile to tile; hold two arrows to hop diagonally.',
    'Tiles shake and glow red, then drop: hop off before yours goes.',
    'A hole drops you too, but the edge of the floor is a wall.',
    'Stay up longest and outlast your three rivals.',
  ],
  keys: [
    { keys: ['↑', '←', '↓', '→'], action: 'Hop' },
    { keys: ['W/Z', 'A/Q', 'S', 'D'], action: 'Hop (letters)' },
  ],
  duration: DURATION,
  theme: 'platforms',
  eyebrow: 'Party',
  abandonNote: 'You stepped off before the floor did',
  // Steered, not aimed. A crosshair over a character is a promise the controls
  // do not keep.
  cursor: 'default',
  create: () => new PlatformsRite(),
  view: () => import('./PlatformsView.js'),
};

export {
  PlatformsRite, RAND_CALLS, COLS, ROWS, TILES, RIVAL_COUNT, PITCH, HOP, STRESS_LEAD,
  STAND, HOPPING, OUT, OUT_HOLD,
  cellX, cellY, cellAt, neighbours, hopTarget,
};
