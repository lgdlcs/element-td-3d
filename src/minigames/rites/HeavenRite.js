/**
 * "escape from gay heaven": dodge everything pink.
 *
 * A glowing mote floats over a cloud arena. Pink strikes are aimed at it one
 * after another: a ring of falling hearts, a sweeping beam, an expanding ring.
 * Each one is telegraphed on the clouds first (pink where it will hit, blue
 * where it will not), then strikes. Every strike that passes without touching
 * the mote is a point. The name is kept verbatim: it is the name the map used.
 *
 * THE 2026-10 REWORK, AND WHY.
 *
 * The previous version was a side-scrolling corridor of gates, sweeps and orb
 * accordions. It scored well under the calibration gate, but it asked the
 * player to read three different geometries scrolling at them, and its idle
 * guarantee leaned on "no gap is ever on the centreline" rules. This version
 * keeps the score model (dodged out of presented, denominator fixed at init),
 * the actuator (the mote chases the pointer at a clamped speed, or `axis`
 * at the same speed) and the determinism budget, and changes the course:
 *
 *  1. EVERY STRIKE IS AIMED AT THE MOTE. A hazard reads the mote's position at
 *     the instant its telegraph appears and lays itself out relative to it,
 *     from rolls drawn at `init`. So an idle mote is hit by every strike (the
 *     idle score is 0 by construction, on every wave and every seed), and the
 *     move a strike demands is bounded by the rolls rather than by wherever the
 *     course happened to put a gap. Two players on one seed get the same
 *     sequence, the same timings and the same layouts RELATIVE TO THEMSELVES.
 *     `ctx.rand` is still drawn a fixed number of times and only in `init`.
 *  2. THE RULE IS ONE SENTENCE. Pink marks strike; blue is the way out. All
 *     three kinds say it the same way, so nothing needs a paragraph.
 *  3. NO I-FRAMES, NO LIVES. Touching a strike loses that strike and nothing
 *     else. Each strike can be lost once, so there is nothing for a grace
 *     window to protect.
 *
 * NO DOM (beyond one guarded token read), NO THREE, NO Math.random: the unit
 * suite imports this in node. The 3D picture is HeavenView.js.
 */

import { FIELD, clamp, lerp } from '../contract.js';

const TAU = Math.PI * 2;

/** Seconds. Also `HEAVEN_RITE.duration`. */
const DURATION = 20;

/**
 * World units per second, for BOTH control paths. The pointer path moves the
 * mote toward the cursor by at most this; `axis` is normalised first, so a
 * diagonal is not 1.41x faster. Without the clamp the pointer is a teleport.
 */
const MOVE_SPEED = 7;

/** The fraction of `MOVE_SPEED` the hardest strike may demand. The unit suite holds it. */
const SPEED_BUDGET = 0.75;

const MOTE_R = 0.15;
const START_X = 0;
const START_Y = -1;

/** Where the mote may go. Inset so the floor never ends under it. */
const PLAY_HW = FIELD.hw - 0.4;
const PLAY_HH = FIELD.hh - 0.4;

// ---------------------------------------------------------------------------
// The course
// ---------------------------------------------------------------------------

/**
 * How many strikes the course HOLDS. A low wave runs out of clock early and
 * never spawns the tail; the wave compresses the schedule, never the count,
 * so the number of `ctx.rand()` calls is the same on every wave.
 */
const HAZARDS = 30;
const PER_HAZARD_DRAWS = 4;
/** `HAZARDS * 4` for the course, plus one seed for the view's cosmetic noise. */
const RAND_CALLS = HAZARDS * PER_HAZARD_DRAWS + 1;

const HEART = 0;
const BEAM = 1;
const RING = 2;

/** Every three strikes is one of each kind, in an order the seed picks. The first triple opens on hearts. */
const PERMS = Object.freeze([
  Object.freeze([HEART, BEAM, RING]), Object.freeze([HEART, RING, BEAM]),
  Object.freeze([BEAM, HEART, RING]), Object.freeze([BEAM, RING, HEART]),
  Object.freeze([RING, HEART, BEAM]), Object.freeze([RING, BEAM, HEART]),
]);
const HEART_FIRST = Object.freeze([PERMS[0], PERMS[1]]);

/** Seconds of calm before the first telegraph. */
const LEAD_IN = 1.0;

/**
 * HEARTS: one lands on the mote, five more in a ring around it, and the sixth
 * ring slot is empty. That empty slot is the short way out. Ring radius is
 * twice the heart radius, so ring hearts touch each other and the centre one.
 */
const HEART_SLOTS = 6;
/** Seconds a landed heart stays lethal. */
const HEART_LIVE = 0.3;

/** BEAM: half-thickness of the wall, and how far outside the field it starts. */
const BEAM_TH = 0.25;
const BEAM_OUT = 0.5;

/** RING: half-thickness of the band, and the radius at which it has crossed any field. */
const RING_BAND = 0.3;
const RING_REACH = Math.hypot(FIELD.w, FIELD.h);
/** RING: the source never sits closer to the mote than this, so the wedge is wide where the mote is. */
const RING_MIN_DIST = 2.5;
/** RING: the most the way out may swing off the mote's bearing, past the wedge's own half-angle, in radians. */
const RING_SWING = 0.9;

/** Clearance under which a pass counts as a near miss and fires `tick`. Once per strike. */
const NEAR_MISS = 0.4;

/** Typical seconds between a strike starting and it being past the mote, per kind. Spaces the schedule. */
const BEAT = Object.freeze([HEART_LIVE, 0.5, 0.35]);

// ---------------------------------------------------------------------------
// Geometry, per kind. Pure functions of (hazard, params, point, time).
// ---------------------------------------------------------------------------

/** Signed clearance from the mote to the inside of a ring's gap wedge. Positive = safe. */
function wedgeClearance(h, P, x, y) {
  const dx = x - h.sx;
  const dy = y - h.sy;
  const d = Math.hypot(dx, dy);
  let a = Math.atan2(dy, dx) - h.gap;
  a = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  const v = P.ringAlpha - a;
  return (v < -Math.PI / 2 ? -d : d * Math.sin(v)) - MOTE_R;
}

/** Where a beam's wall is along its sweep axis at time t. */
function wallPos(h, P, t) {
  const ext = (h.axis === 0 ? FIELD.hw : FIELD.hh) + BEAM_OUT;
  return -h.dir * ext + h.dir * P.beamSpeed * (t - h.strike);
}

/** A ring's radius at time t. */
function ringRadius(h, P, t) {
  return Math.max(0, t - h.strike) * P.ringSpeed;
}

function heartDiscs(h, P, x, y) {
  let best = Infinity;
  for (let k = 0; k < HEART_SLOTS; k++) {
    const d = Math.hypot(x - h.hx[k], y - h.hy[k]) - P.heartR - MOTE_R;
    if (d < best) best = d;
  }
  return best;
}

/**
 * The kind table. `hit` is the instantaneous clearance (negative = touching).
 * `threat` is the clearance from everything this strike will still do after
 * `t`: what the telegraph shows and what a player plans against. Both return
 * Infinity once the strike can no longer touch that point.
 */
const KINDS = [
  {
    // HEART
    duration: () => HEART_LIVE,
    hit(h, P, x, y, t) {
      return t < h.strike || t > h.strike + HEART_LIVE ? Infinity : heartDiscs(h, P, x, y);
    },
    threat(h, P, x, y, t) {
      return t > h.strike + HEART_LIVE ? Infinity : heartDiscs(h, P, x, y);
    },
  },
  {
    // BEAM
    duration: (h, P) => (2 * ((h.axis === 0 ? FIELD.hw : FIELD.hh) + BEAM_OUT)) / P.beamSpeed,
    hit(h, P, x, y, t) {
      if (t < h.strike || t > h.end) return Infinity;
      const q = h.axis === 0 ? x : y;
      const p = h.axis === 0 ? y : x;
      return Math.max(Math.abs(q - wallPos(h, P, t)) - BEAM_TH - MOTE_R, P.beamGap - Math.abs(p - h.gc) - MOTE_R);
    },
    threat(h, P, x, y, t) {
      if (t > h.end) return Infinity;
      const q = h.axis === 0 ? x : y;
      const p = h.axis === 0 ? y : x;
      if (h.dir * (wallPos(h, P, Math.max(t, h.strike)) - q) > BEAM_TH + MOTE_R) return Infinity;
      return P.beamGap - Math.abs(p - h.gc) - MOTE_R;
    },
  },
  {
    // RING
    duration: (h, P) => RING_REACH / P.ringSpeed,
    hit(h, P, x, y, t) {
      if (t < h.strike || t > h.end) return Infinity;
      const d = Math.hypot(x - h.sx, y - h.sy);
      return Math.max(Math.abs(d - ringRadius(h, P, t)) - RING_BAND - MOTE_R, wedgeClearance(h, P, x, y));
    },
    threat(h, P, x, y, t) {
      if (t > h.end) return Infinity;
      if (ringRadius(h, P, t) - RING_BAND - MOTE_R > Math.hypot(x - h.sx, y - h.sy)) return Infinity;
      return wedgeClearance(h, P, x, y);
    },
  },
];

/** How far (x, y) sits inside the play area. Negative = outside. */
function inside(x, y) {
  return Math.min(PLAY_HW - Math.abs(x), PLAY_HH - Math.abs(y));
}

// ---------------------------------------------------------------------------
// Aiming: lay a strike out around the mote, from the rolls drawn at init.
// No `ctx.rand` here: the rolls are already on the hazard.
// ---------------------------------------------------------------------------

const AIM = [
  function aimHearts(h, P) {
    const rho = 2 * P.heartR;
    const step = TAU / HEART_SLOTS;
    // The empty slot must open into the arena. Try the rolled angle, then the
    // other slots in order, and keep the first whose way out is on the floor.
    const reach = P.heartR + 0.6;
    let gap = h.r1 * TAU;
    let bestM = -Infinity;
    let best = gap;
    for (let k = 0; k < HEART_SLOTS; k++) {
      const a = gap + k * step;
      const m = inside(h.ax + Math.cos(a) * reach, h.ay + Math.sin(a) * reach);
      if (m >= 0) { best = a; break; }
      if (m > bestM) { bestM = m; best = a; }
    }
    gap = best;
    h.gap = gap;
    h.hx[0] = h.ax;
    h.hy[0] = h.ay;
    for (let k = 1; k < HEART_SLOTS; k++) {
      const a = gap + k * step;
      h.hx[k] = h.ax + Math.cos(a) * rho;
      h.hy[k] = h.ay + Math.sin(a) * rho;
    }
  },
  function aimBeam(h, P) {
    const q = Math.min(3, Math.floor(h.r1 * 4));
    h.axis = q >> 1;
    h.dir = q & 1 ? -1 : 1;
    // The gap is off the mote by more than its own half-width, so standing
    // still is always a hit, and by at most BEAM_REACH, so it is always reachable.
    const off = lerp(P.beamGap + 0.35, P.beamGap + P.beamReach, h.r2);
    const sign = h.r3 < 0.5 ? -1 : 1;
    const p = h.axis === 0 ? h.ay : h.ax;
    const lim = (h.axis === 0 ? PLAY_HH : PLAY_HW) - P.beamGap * 0.5;
    let gc = p + sign * off;
    if (Math.abs(gc) > lim) gc = p - sign * off;
    h.gc = clamp(gc, -lim, lim);
  },
  function aimRing(h, P) {
    for (let flip = 0; flip < 2; flip++) {
      const phi = h.r1 * TAU + flip * Math.PI;
      const dS = lerp(3.5, 5.5, h.r2);
      h.sx = clamp(h.ax + Math.cos(phi) * dS, -FIELD.hw, FIELD.hw);
      h.sy = clamp(h.ay + Math.sin(phi) * dS, -FIELD.hh, FIELD.hh);
      if (Math.hypot(h.ax - h.sx, h.ay - h.sy) >= RING_MIN_DIST) break;
    }
    const dist = Math.hypot(h.ax - h.sx, h.ay - h.sy);
    const bearing = Math.atan2(h.ay - h.sy, h.ax - h.sx);
    // Off the mote's bearing by more than the wedge's half-angle (standing
    // still is a hit), toward whichever side keeps the way out on the floor.
    const delta = lerp(P.ringAlpha + 0.35, P.ringAlpha + RING_SWING, (h.r3 * 2) % 1);
    const sign = h.r3 < 0.5 ? -1 : 1;
    const g1 = bearing + sign * delta;
    const g2 = bearing - sign * delta;
    const m1 = inside(h.sx + Math.cos(g1) * dist, h.sy + Math.sin(g1) * dist);
    const m2 = inside(h.sx + Math.cos(g2) * dist, h.sy + Math.sin(g2) * dist);
    h.gap = m1 >= 0 || m1 >= m2 ? g1 : g2;
  },
];

class HeavenRite {
  init(ctx) {
    /**
     * Difficulty, entirely from `ctx.wave`, as continuous lerps. `** 0.66`
     * front-loads the ramp so every ten waves cost about the same; linear left
     * the first half flat, which the calibration gate's "later is never
     * easier" rule then read as noise.
     */
    const waveT = Math.pow(clamp((ctx.wave - 3) / 50, 0, 1), 0.5);
    this.waveT = waveT;
    // Per kind. A heart lands where its telegraph is. A ring still travels to
    // the mote after it fires, so it warns for less. A beam can fire from the
    // edge the mote is standing on, so its warning is the time its worst move
    // takes inside the speed budget, and not a second less.
    const warn = lerp(0.82, 0.46, waveT);
    const beamReach = lerp(1.8, 2.6, waveT);
    this.params = Object.freeze({
      warn: Object.freeze([warn, (beamReach + MOTE_R) / (MOVE_SPEED * SPEED_BUDGET), warn * 0.7]),
      interval: lerp(0.3, 0.0, waveT),
      heartR: lerp(1.0, 1.25, waveT),
      beamGap: lerp(0.9, 0.7, waveT),
      beamReach,
      beamSpeed: lerp(9, 12, waveT),
      ringSpeed: lerp(8, 9.5, waveT),
      ringAlpha: lerp(0.5, 0.38, waveT),
    });

    this.t = 0;
    this.over = false;
    this.started = false;
    this.cleared = 0;
    this.burned = 0;
    this.mx = START_X;
    this.my = START_Y;
    this.pmx = START_X;
    this.pmy = START_Y;
    /** The pointer target the mote is chasing, for the view's reticle. Never gameplay. */
    this.tx = START_X;
    this.ty = START_Y;
    this.steering = false;
    this.nextAim = 0;

    this._events = [];
    this.touched = new Uint8Array(HAZARDS);
    this.passed = new Uint8Array(HAZARDS);
    this.ticked = new Uint8Array(HAZARDS);
    this.inCourse = new Uint8Array(HAZARDS);

    this.#buildCourse(ctx);
    /** The view's cosmetic noise seed. The last draw, so presentation never shifts the course. */
    this.fxSeed = Math.floor(ctx.rand() * 0xffffffff) >>> 0;
    this._palette = this.#palette();
  }

  /**
   * EXACTLY `HAZARDS * PER_HAZARD_DRAWS` draws, unconditionally, then a second
   * pass for the schedule that draws nothing. A `rand()` inside a kind branch
   * would make the count depend on the seed.
   */
  #buildCourse(ctx) {
    const P = this.params;
    this.hazards = [];
    let perm = PERMS[0];
    for (let i = 0; i < HAZARDS; i++) {
      const kindRoll = ctx.rand();
      const r1 = ctx.rand();
      const r2 = ctx.rand();
      const r3 = ctx.rand();
      if (i % 3 === 0) {
        const set = i === 0 ? HEART_FIRST : PERMS;
        perm = set[Math.min(set.length - 1, Math.floor(kindRoll * set.length))];
      }
      this.hazards.push({
        kind: perm[i % 3], r1, r2, r3, jitter: kindRoll,
        t0: 0, strike: 0, end: 0, aimed: 0, ax: 0, ay: 0,
        hx: new Float64Array(HEART_SLOTS), hy: new Float64Array(HEART_SLOTS), gap: 0,
        axis: 0, dir: 1, gc: 0,
        sx: 0, sy: 0,
      });
    }

    let t0 = LEAD_IN;
    let presented = 0;
    for (let i = 0; i < HAZARDS; i++) {
      const h = this.hazards[i];
      h.t0 = t0;
      h.strike = t0 + P.warn[h.kind];
      // A beam's duration depends on its axis, which comes off `r1` the same
      // way the aim reads it, so the schedule is fixed before anything is aimed.
      h.axis = Math.min(3, Math.floor(h.r1 * 4)) >> 1;
      h.end = h.strike + KINDS[h.kind].duration(h, P);
      if (h.end <= DURATION) { this.inCourse[i] = 1; presented++; }
      t0 = h.strike + BEAT[h.kind] + P.interval * (1 + 0.3 * h.jitter);
    }
    /** Fixed here and never touched again: dying to a strike never shrinks the denominator. */
    this.presented = Math.max(1, presented);
  }

  /**
   * Paint tokens, read once with literal fallbacks. The two pinks are the KILL
   * RULE and deliberately have no token: "pink is the only saturated magenta
   * on the stage" is an accessibility claim, and a value another theme block
   * could redefine is a claim nothing enforces (rite-theme.test.js holds it).
   */
  #palette() {
    const cs = (typeof document !== 'undefined' && typeof getComputedStyle === 'function')
      ? getComputedStyle(document.documentElement)
      : null;
    const tok = (name, fallback) => (cs?.getPropertyValue(name) || '').trim() || fallback;
    return {
      pink: '#ff4fd8',
      pinkDeep: '#b81590',
      outline: tok('--bg', '#05060a'),
      cloud: tok('--ink', '#e9ebf3'),
      cloud2: tok('--ink-2', '#a3a9bb'),
      cloud3: tok('--ink-3', '#6d7488'),
      accent: tok('--rite-heaven-accent', '#9fc4e8'),
      gold: tok('--gold', '#e5bd79'),
      good: tok('--good', '#56d99a'),
    };
  }

  /**
   * Instantaneous signed clearance from every aimed strike at (x, y), at time
   * `at` (default now). Negative = touching. Strikes not yet aimed are unknown
   * and ignored, exactly as a player cannot see them yet.
   */
  clearanceAt(x, y, at = this.t) {
    const P = this.params;
    let best = Infinity;
    for (let i = 0; i < this.nextAim; i++) {
      const c = KINDS[this.hazards[i].kind].hit(this.hazards[i], P, x, y, at);
      if (c < best) best = c;
    }
    return best;
  }

  /**
   * Clearance from everything the aimed strikes will still do after `at`:
   * the picture the telegraphs paint. A competent player (and the reference
   * bot) moves to wherever this is positive.
   */
  threatAt(x, y, at = this.t) {
    const P = this.params;
    let best = Infinity;
    for (let i = 0; i < this.nextAim; i++) {
      const c = KINDS[this.hazards[i].kind].threat(this.hazards[i], P, x, y, at);
      if (c < best) best = c;
    }
    return best;
  }

  /** Where beam `i`'s wall is at time t, along its sweep axis. For the view. */
  wallAt(i, t) { return wallPos(this.hazards[i], this.params, t); }

  /** Ring `i`'s radius at time t. For the view. */
  ringAt(i, t) { return ringRadius(this.hazards[i], this.params, t); }

  // -------------------------------------------------------------------------

  update(dt, input) {
    if (this.over) return true;
    if (!this.started) {
      this.started = true;
      this._events.push({ type: 'start' });
    }
    this.t += dt;

    // ---- the actuator: keys win while held, else chase the pointer --------
    this.pmx = this.mx;
    this.pmy = this.my;
    const ax = input.axis?.x || 0;
    const ay = input.axis?.y || 0;
    if (ax || ay) {
      const inv = 1 / Math.hypot(ax, ay);
      this.mx += ax * inv * MOVE_SPEED * dt;
      this.my += ay * inv * MOVE_SPEED * dt;
      this.steering = false;
    } else if (input.inside && Number.isFinite(input.x) && Number.isFinite(input.y)) {
      this.tx = clamp(input.x, -PLAY_HW, PLAY_HW);
      this.ty = clamp(input.y, -PLAY_HH, PLAY_HH);
      this.steering = true;
      const dx = this.tx - this.mx;
      const dy = this.ty - this.my;
      const d = Math.hypot(dx, dy);
      const step = Math.min(d, MOVE_SPEED * dt);
      if (d > 1e-6) { this.mx += (dx / d) * step; this.my += (dy / d) * step; }
    } else {
      this.steering = false;
    }
    this.mx = clamp(this.mx, -PLAY_HW, PLAY_HW);
    this.my = clamp(this.my, -PLAY_HH, PLAY_HH);

    // ---- telegraphs appear, aimed at where the mote is now ----------------
    const P = this.params;
    while (this.nextAim < HAZARDS && this.t >= this.hazards[this.nextAim].t0) {
      const h = this.hazards[this.nextAim++];
      h.ax = this.mx;
      h.ay = this.my;
      h.aimed = 1;
      AIM[h.kind](h, P);
    }

    // ---- strikes -----------------------------------------------------------
    for (let i = 0; i < this.nextAim; i++) {
      if (this.passed[i]) continue;
      const h = this.hazards[i];
      if (this.t < h.strike) continue;
      const K = KINDS[h.kind];
      const c = K.hit(h, P, this.mx, this.my, this.t);
      if (c < 0 && !this.touched[i]) {
        this.touched[i] = 1;
        this.burned++;
        this._events.push({ type: 'break', x: this.mx, y: this.my, i });
      } else if (c < NEAR_MISS && !this.ticked[i] && !this.touched[i]) {
        this.ticked[i] = 1;
        this._events.push({ type: 'tick', x: this.mx, y: this.my, i });
      }
      // Passed is final: walls and rings outrun the mote, hearts expire.
      if (K.threat(h, P, this.mx, this.my, this.t) === Infinity) {
        this.passed[i] = 1;
        if (!this.touched[i] && this.inCourse[i]) {
          this.cleared++;
          this._events.push({ type: 'gold', x: this.mx, y: this.my, i });
        }
      }
    }

    if (this.t >= DURATION) {
      this.over = true;
      this._events.push({ type: this.burned === 0 ? 'perfect' : 'good', x: this.mx, y: this.my });
      return true;
    }
    return false;
  }

  /** DODGED OUT OF PRESENTED. Clamped: a strike that passes early is credited only if it is in the course. */
  score() {
    const ratio = clamp(this.cleared / this.presented, 0, 1);
    const headline = ratio >= 1 ? 'Escaped'
      : ratio >= 0.8 ? 'Barely touched'
        : ratio >= 0.55 ? 'Grazed'
          : ratio >= 0.3 ? 'Blushing'
            : ratio > 0 ? 'Smothered in pink'
              : 'Never left';
    return {
      ratio,
      headline,
      detail: `${this.cleared}/${this.presented} strikes dodged`,
    };
  }

  drainEvents() { return this._events.splice(0, this._events.length); }
  teardown() { this._events.length = 0; }
}

/** @type {import('../contract.js').MinigameDef} */
export const HEAVEN_RITE = {
  id: 'heaven',
  name: 'escape from gay heaven',
  hint: 'Dodge everything pink. Blue is the way out',
  rules: [
    'Pink marks light up the clouds, then strike. Get off them in time.',
    'Hearts fall, beams sweep, rings spread. Blue shows the way out.',
    'Every strike you dodge scores. One that touches you is lost.',
  ],
  keys: [
    { keys: ['Mouse'], action: 'Steer' },
    { keys: ['↑', '←', '↓', '→'], action: 'Steer' },
    { keys: ['W/Z', 'A/Q', 'S', 'D'], action: 'Steer' },
  ],
  duration: DURATION,
  theme: 'heaven',
  eyebrow: 'Ascent',
  abandonNote: 'You stayed in heaven',
  // The mote is the avatar and the view draws a ring where it is headed.
  cursor: 'none',
  create: () => new HeavenRite(),
  view: () => import('./HeavenView.js'),
};

export {
  HeavenRite, RAND_CALLS, DURATION, HAZARDS, MOVE_SPEED, MOTE_R, START_X, START_Y,
  HEART, BEAM, RING, HEART_SLOTS, HEART_LIVE, BEAM_TH, RING_BAND, RING_SWING, SPEED_BUDGET,
  PLAY_HW, PLAY_HH,
};
