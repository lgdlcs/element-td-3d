import { Grid } from '../Grid.js';
import { CreepManager, CREEP_TYPES } from '../Creeps.js';
import { ProjectileManager } from '../../systems/Projectiles.js';
import { towerDef } from '../TowerDefs.js';
import { IDLE_PULSE, FIRE_PULSE } from '../Towers.js';
import {
  validateSnapshot, MAX_SNAP_CREEPS, CREEP_STRIDE, QUANT, TYPE_KEYS,
} from './SpectateCodec.js';

/**
 * The watched player's board, rendered into the LOCAL scene.
 *
 * ARCHITECTURE, and why it is not a second Game
 * ---------------------------------------------
 * A second WebGLRenderer is a second GL context (browsers cap contexts and
 * evict the oldest — you would lose your own board's context), a second copy of
 * every shader program and roughly double the VRAM. A second THREE.Scene is
 * cheaper but needs a second Arena, Environment, Lighting and TowerBatch, and
 * the batch owns a pool of PointLights: adding eight more lights to a scene
 * changes NUM_POINT_LIGHTS and recompiles every material in it, at a cost this
 * repo measures at ~6 ms per light charged to every lit pixel.
 *
 * So there is ONE scene and ONE set of GPU objects, and what gets swapped is the
 * DATA SOURCE. Terrain, textures, light pool, composer, shadow map, environment
 * and the whole post chain are built once and shared. The watched board borrows:
 *
 *   - the SAME TowerBatch, re-tenanted with proxies (Game detaches the local
 *     towers first, and TowerBatch already skips anything with no `inst`)
 *   - the SAME EffectSystem, for muzzle flashes, impacts and death puffs
 *   - the SAME Arena, whose `grid` and `mask.grid` Game re-points at the grid
 *     below — PathMask checksums the grid every frame, so the painted road
 *     re-cuts itself onto the watched maze with no extra wiring
 *
 * and owns only what genuinely cannot be shared: a Grid, a small CreepManager,
 * and a cosmetic ProjectileManager.
 *
 * THE LOCAL RUN KEEPS RUNNING. Nothing in this file touches game.state,
 * game.grid, game.path, game.creeps or the real TowerManager. There is no code
 * path from a snapshot to a local gold, lives or score value, and the
 * spectator's projectiles are wired to a façade with no method that can write a
 * hit point — the authority boundary is structural, not a rule to remember.
 */

// -- playout ------------------------------------------------------------------

/** Matches the streamer's period. Only used to space a burst back out. */
const NOMINAL_MS = 100;

/**
 * How far behind real time the picture is played out.
 *
 * 1.6x the send interval. This is the de-jitter budget: a snapshot that arrives
 * up to 60 ms late still lands before its playout time, so the common case is
 * an interpolation between two frames rather than a stall. The honest statement
 * is that the watcher sees the board as it was 160 ms ago plus network latency —
 * invisible for watching, and the alternative is extrapolation artefacts on
 * every creep on every frame.
 */
const RENDER_DELAY_MS = 160;

/** Buffered snapshots. Beyond this the oldest is dropped rather than queued. */
const BUFFER_MAX = 8;

/** Consecutive rejected frames before the view gives up and unsubscribes. */
const MAX_BAD_FRAMES = 10;

/** Starved for this long before the banner admits it. */
const STALL_MS = 600;

/** Local slots. Matches the wire cap, so a legal frame can never overflow it. */
const CAP = MAX_SNAP_CREEPS;

/**
 * Stable per-creep hash in [0,1).
 *
 * NOT Math.random(): the simulation rolls a creep's size ONCE at spawn, so a
 * spectator that rerolled it per frame would strobe every unit on the board.
 * Keyed on uid, so it is stable for the creep's whole life and identical on
 * every spectator's screen.
 */
const hash01 = (uid) => ((Math.imul(uid, 2654435761) >>> 8) & 0xffff) / 65536;

const lerp = (a, b, u) => a + (b - a) * u;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The read surface ProjectileManager needs, with every write neutered.
 *
 * The watched board is a picture: its projectiles must fly, splash, chain and
 * flash, and must not be able to change a single hit point — not because a rule
 * says so, but because there is no method here that can. Verified against every
 * member Projectiles.js touches: alive, x, y, z, hp, maxHp, damage, applySlow,
 * applyBurn, applyPoison, query.
 */
function cosmeticCreeps(c) {
  return {
    alive: c.alive, x: c.x, y: c.y, z: c.z, hp: c.hp, maxHp: c.maxHp,
    query: (x, z, r, out) => c.query(x, z, r, out),
    /** Returns 0 dealt, and only lights the impact flash the shader already reads. */
    damage: (i) => { c.hitFlash[i] = 1; return 0; },
    applySlow() {}, applyBurn() {}, applyPoison() {},
  };
}

export class SpectateView {
  /**
   * Built ONCE and retargeted with begin()/end(), never one per watched player.
   *
   * Construction compiles four creep shader programs plus the projectile
   * billboard and ribbon programs. Rebuilding the view every time the player
   * clicks a different row would pay that again on every click, and the compile
   * is exactly the kind of hitch that reads as "this feature is heavy".
   *
   * @param {import('../Game.js').Game} game
   */
  constructor(game) {
    this.game = game;
    /** @type {?string} the watched player's id, or null while idle. */
    this.id = null;
    this.name = '';
    this.color = 0x4aa3ff;

    /** Live board numbers straight off the last accepted snapshot. */
    this.stats = { w: 1, l: 0, g: 0, sc: 0, ph: 0, pt: 0 };
    /** No snapshot has reached its playout time yet. */
    this.loading = true;
    /** Ran out of future frames — holding, not extrapolating. */
    this.stalled = false;
    this.badFrames = 0;
    /** Set when the frame stream is unusable; main.js unsubscribes on it. */
    this.onProtocolError = null;

    this.grid = new Grid();

    // capacity CAP, not MAX_CREEPS: 900 slots of typed arrays plus six
    // InstancedMeshes sized for them is a lot of memory for a board the wire
    // format caps at 64 units.
    this.creeps = new CreepManager(game.scene, this.grid, null, { capacity: CAP });
    this.creeps.surfaceHeightAt = (x, z) => game.arena.surfaceHeightAt(x, z);
    this.creeps.setVisible(false);

    // The façade is what makes the shots structurally unable to hurt anything.
    // ProjectileManager's constructor also calls fx.attachCreeps(), which would
    // point the status-VFX layer at an object with no burnT array; Game
    // re-attaches the right one on every enterSpectate, which covers both this
    // construction and every later switch.
    this.projectiles = new ProjectileManager(game.scene, cosmeticCreeps(this.creeps), game.fx);

    /** @type {Array<object>} tower proxies, attached to the SHARED batch. */
    this.towers = [];
    this._towerById = new Map();
    /** Deltas are ignored until one keyframe has landed — see #applyTowers. */
    this._haveKeyframe = false;

    // -- playout buffers ----------------------------------------------------
    this._buf = [];
    this._pool = [];
    for (let i = 0; i < BUFFER_MAX + 3; i++) this._pool.push(makeFrame());
    this._lastN = 0;
    this._a = null;
    this._b = null;
    this._dtAB = 0;
    this._starvedSince = 0;

    // -- slot bookkeeping ---------------------------------------------------
    // uid -> local slot. A flat table rather than a Map because this is read
    // once per creep per snapshot forever and must not allocate; 128 KB is
    // nothing next to one extra shader program.
    this._slotOf = new Int16Array(0x10000).fill(-1);
    this._slotUid = new Uint16Array(CAP);
    this._slots = [];
    this._free = [];
    for (let i = CAP - 1; i >= 0; i--) this._free.push(i);

    this._aValid = new Uint8Array(CAP);
    this._aX = new Float32Array(CAP);
    this._aZ = new Float32Array(CAP);
    this._aHp = new Float32Array(CAP);
    this._bX = new Float32Array(CAP);
    this._bZ = new Float32Array(CAP);
    this._bHp = new Float32Array(CAP);
    this._bTy = new Uint8Array(CAP);
    this._bSt = new Uint8Array(CAP);
    this._inB = new Uint8Array(CAP);
    this._prevHp = new Float32Array(CAP);
  }

  // -- lifecycle -------------------------------------------------------------

  /**
   * Point the view at a player. Idempotent per target, and always starts from a
   * clean board so a previous target's towers cannot survive into the new one.
   * @param {{id: string, name: string, color: number}} who
   */
  begin(who) {
    this.end();
    this.id = who.id;
    this.name = who.name ?? '';
    this.color = who.color ?? 0x4aa3ff;
    this.stats.w = 1; this.stats.l = 0; this.stats.g = 0;
    this.stats.sc = 0; this.stats.ph = 0; this.stats.pt = 0;
    this.badFrames = 0;
    this.loading = true;
    this.projectiles.renderEnabled = true;
    this.creeps.setVisible(true);
  }

  /**
   * Give the shared batch back and empty the board.
   *
   * Skipping the batch detach leaks 384 instances per spectate — the batch's
   * entire instance budget — and the NEXT begin() then silently renders nothing.
   */
  end() {
    for (const t of this.towers) this.game.towers.batch.detach(t);
    this.towers.length = 0;
    this._towerById.clear();
    this._haveKeyframe = false;

    for (let i = this._slots.length - 1; i >= 0; i--) this.#release(this._slots[i], i);
    this.creeps.count = 0;
    this.creeps._liveCount = 0;
    this.creeps.rebuildHash();
    this.creeps.present();
    this.creeps.setVisible(false);

    // Retire every in-flight shot properly rather than letting it strand: with
    // update() no longer running, a live projectile would leave its billboard
    // and ribbon resident in the buffers, i.e. frozen streaks over your own
    // board for the rest of the run.
    const p = this.projectiles;
    for (let i = 0; i < p.alive.length; i++) {
      if (!p.alive[i]) continue;
      p.alive[i] = 0;
      p.stats[i] = null;
      p.free.push(i);
    }
    for (const f of p.fade) f.live = false;
    p.renderEnabled = false;
    p.update(0);                        // commits one empty frame

    this._buf.length = 0;
    this._a = null;
    this._b = null;
    this._lastN = 0;
    this._starvedSince = 0;
    this.loading = true;
    this.stalled = false;
    this.id = null;
  }

  // -- inbound ---------------------------------------------------------------

  /**
   * One relayed `snap`. Validated as a hard gate: a frame that fails ANY check
   * is dropped whole, never partially applied.
   */
  onSnapshot(m) {
    if (!m || m.from !== this.id) return;      // a frame for a board we left
    const why = validateSnapshot(m, this.grid);
    if (why) {
      if (++this.badFrames >= MAX_BAD_FRAMES) {
        this.badFrames = 0;
        this.onProtocolError?.(why);
      }
      return;
    }
    this.badFrames = 0;
    // Over TCP this only happens across a reconnect, but a duplicate applied out
    // of order walks the playout head backwards and the picture judders.
    if (m.n <= this._lastN) return;
    this._lastN = m.n;

    this.stats.w = m.w | 0;
    this.stats.l = m.l | 0;
    this.stats.g = m.g | 0;
    this.stats.sc = m.sc | 0;
    this.stats.ph = m.ph | 0;
    this.stats.pt = m.pt | 0;

    // Towers are applied on ARRIVAL rather than at playout time. They do not
    // move, so a 160 ms discrepancy against the creeps is invisible, and it
    // keeps grid writes, batch attach/detach and the occupancy upload out of the
    // 60 Hz playout loop entirely.
    this.#applyTowers(m);

    const f = this._pool.pop() ?? this._buf.shift();
    const c = m.c;
    const n = Math.min(MAX_SNAP_CREEPS, c.length / CREEP_STRIDE) | 0;
    f.n = n;
    for (let k = 0; k < n; k++) {
      const o = k * CREEP_STRIDE;
      f.uid[k] = c[o];
      f.ty[k] = c[o + 1];
      f.x[k] = c[o + 2] / QUANT;
      f.z[k] = c[o + 3] / QUANT;
      f.hp[k] = c[o + 4] / 100;
      f.st[k] = c[o + 5];
    }

    // Playout time = de-jitter. A burst of three frames arriving in the same
    // millisecond is played out NOMINAL_MS apart instead of all at once.
    const ta = performance.now();
    const last = this._buf.length ? this._buf[this._buf.length - 1].pb : 0;
    f.pb = this._buf.length === 0 ? ta : Math.max(ta, last + NOMINAL_MS);
    // Drift guard. Without it a burst, or a streamer running a slightly fast
    // clock, slides the playout head further and further behind real time and
    // the view ends up seconds late with no way back.
    if (f.pb - ta > 400) f.pb = ta + NOMINAL_MS;

    this._buf.push(f);
    while (this._buf.length > BUFFER_MAX) this._pool.push(this._buf.shift());
  }

  // -- per rendered frame ----------------------------------------------------

  update(dt) {
    const now = performance.now();
    const renderAt = now - RENDER_DELAY_MS;

    let a = null;
    let b = null;
    for (let i = 0; i < this._buf.length; i++) {
      const f = this._buf[i];
      if (f.pb <= renderAt) a = f;
      else if (!b) b = f;
    }

    if (!a) {
      // Nothing due yet — the first ~160 ms after subscribing.
      this.loading = true;
      this.#present(dt);
      return;
    }
    this.loading = false;

    if (!b) {
      // Ran out of future. HOLD at `a`; do NOT extrapolate. Overshoot-then-snap
      // on every creep reads far worse than a 100 ms freeze.
      b = a;
      if (!this._starvedSince) this._starvedSince = now;
      this.stalled = now - this._starvedSince > STALL_MS;
    } else {
      this._starvedSince = 0;
      this.stalled = false;
    }

    if (a !== this._a || b !== this._b) this.#setPair(a, b);

    // Everything strictly older than `a` is spent.
    while (this._buf.length && this._buf[0] !== a) this._pool.push(this._buf.shift());

    const u = this._dtAB > 0 ? clamp01((renderAt - a.pb) / (b.pb - a.pb)) : 1;
    this.#reconstruct(dt, u);
    this.#fire(dt);
    this.#present(dt);
  }

  /**
   * Bind a new (a, b) pair: resolve slots, retire creeps that vanished between
   * the two, and cache the per-slot endpoints the 60 Hz loop interpolates.
   *
   * Runs at the SNAPSHOT rate (10 Hz), not the frame rate. That split is the
   * point: the expensive, branchy, allocation-shaped work happens ten times a
   * second and the frame loop reads flat arrays.
   */
  #setPair(a, b) {
    this._a = a;
    this._b = b;
    this._dtAB = b === a ? 0 : (b.pb - a.pb) / 1000;

    this._inB.fill(0);
    for (let k = 0; k < b.n; k++) {
      const s = this.#slotFor(b.uid[k], b.ty[k]);
      if (s < 0) continue;                      // pool full; drop this unit
      this._inB[s] = 1;
      this._bX[s] = b.x[k];
      this._bZ[s] = b.z[k];
      this._bHp[s] = b.hp[k];
      this._bTy[s] = b.ty[k];
      this._bSt[s] = b.st[k];
    }

    this._aValid.fill(0);
    if (b !== a) {
      for (let k = 0; k < a.n; k++) {
        const s = this._slotOf[a.uid[k]];
        if (s < 0 || !this._inB[s]) continue;   // died between the two frames
        this._aValid[s] = 1;
        this._aX[s] = a.x[k];
        this._aZ[s] = a.z[k];
        this._aHp[s] = a.hp[k];
      }
    }

    // Gone: it died or leaked between the two snapshots. This is where the
    // watched board's death explosions come from — no network event carries
    // them, and none needs to.
    for (let i = this._slots.length - 1; i >= 0; i--) {
      const s = this._slots[i];
      if (this._inB[s]) continue;
      const c = this.creeps;
      this.game.fx.death(c.x[s], c.y[s], c.z[s], CREEP_TYPES[TYPE_KEYS[c.typeIdx[s]]].color);
      this.#release(s, i);
    }
  }

  #slotFor(uid, ty) {
    let s = this._slotOf[uid];
    if (s >= 0) return s;
    s = this._free.length ? this._free.pop() : -1;
    if (s < 0) return -1;
    this._slotOf[uid] = s;
    this._slotUid[s] = uid;
    this._slots.push(s);

    const c = this.creeps;
    const T = CREEP_TYPES[TYPE_KEYS[ty]];
    c.alive[s] = 1;
    c.uid[s] = uid;
    c.typeIdx[s] = ty;
    c.flying[s] = T.flying ? 1 : 0;
    // Same 0.94..1.06 spread the simulation rolls at spawn, keyed on uid so it
    // is stable and identical on every watcher's screen.
    c.scale[s] = T.scale * (0.94 + hash01(uid) * 0.12);
    c.speed[s] = T.speed;
    c.baseSpeed[s] = T.speed;
    c.maxHp[s] = 1;                             // only the RATIO is ever rendered
    c.hp[s] = 1;
    c.hpGhost[s] = 1;
    c.yaw[s] = 0;
    c.lean[s] = 0;
    c.stagger[s] = 0;
    c.spawnT[s] = 0;
    c.phase[s] = hash01(uid) * Math.PI * 2;
    c.hitFlash[s] = 0;
    c.slowT[s] = 0; c.burnT[s] = 0; c.poisonT[s] = 0;
    const col = c._typeColorLinear[ty];
    c.tint[s * 3] = col[0]; c.tint[s * 3 + 1] = col[1]; c.tint[s * 3 + 2] = col[2];
    this._prevHp[s] = 1;
    return s;
  }

  /** @param {number} at index of `s` inside this._slots, or -1 to search */
  #release(s, at = -1) {
    const i = at >= 0 ? at : this._slots.indexOf(s);
    if (i >= 0) this._slots.splice(i, 1);
    this._slotOf[this._slotUid[s]] = -1;
    this.creeps.alive[s] = 0;
    this._free.push(s);
  }

  /**
   * Rebuild every per-creep render field from position, time and type.
   *
   * Every constant below is COPIED FROM CreepManager.update(). None of it is
   * invented: the point is that the watched board's units walk, bank, bob and
   * flash exactly like the local ones, which is what lets 14 of the 20 per-creep
   * fields stay off the wire.
   */
  #reconstruct(dt, u) {
    const c = this.creeps;
    const dtAB = this._dtAB;

    for (let n = 0; n < this._slots.length; n++) {
      const s = this._slots[n];
      const T = CREEP_TYPES[TYPE_KEYS[this._bTy[s]]];

      let x, z, vx, vz, hp01;
      if (this._aValid[s] && dtAB > 0) {
        x = lerp(this._aX[s], this._bX[s], u);
        z = lerp(this._aZ[s], this._bZ[s], u);
        // Constant over the interval, which is exactly what makes the gait,
        // the yaw and the ground contact crescent agree with the motion.
        vx = (this._bX[s] - this._aX[s]) / dtAB;
        vz = (this._bZ[s] - this._aZ[s]) / dtAB;
        hp01 = lerp(this._aHp[s], this._bHp[s], u);
      } else {
        // Spawned between the two frames, or holding on a starved buffer.
        x = this._bX[s]; z = this._bZ[s];
        vx = 0; vz = 0;
        hp01 = this._bHp[s];
      }

      c.x[s] = x; c.z[s] = z;
      c.vx[s] = vx; c.vz[s] = vz;
      c.hp[s] = hp01;

      c.spawnT[s] = Math.min(1, c.spawnT[s] + dt * 2.6);
      const actual = Math.hypot(vx, vz);
      const speed01 = actual / (T.speed || 1);
      c.speed[s] = actual;

      if (actual > 1e-3) {
        const targetYaw = Math.atan2(vx, vz);
        let diff = targetYaw - c.yaw[s];
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const turn = diff * (1 - Math.exp(-dt * 12));
        c.yaw[s] += turn;
        const leanTarget = clampAbs((turn / Math.max(dt, 1e-4)) * (T.flying ? 0.30 : 0.11), 0.8);
        c.lean[s] += (leanTarget - c.lean[s]) * (1 - Math.exp(-dt * 7));
      } else {
        c.lean[s] += (0 - c.lean[s]) * (1 - Math.exp(-dt * 7));
      }

      const scale = c.scale[s];
      const strideHz = T.flying
        ? 4.4 + speed01 * 2.4
        : (7.4 + speed01 * 4.2) / Math.max(0.55, scale);
      c.phase[s] += dt * strideHz;

      const groundY = c.surfaceHeightAt(x, z);
      c.groundY[s] = groundY;
      c.y[s] = T.flying
        ? groundY + 2.8 + Math.sin(c.phase[s] * 0.42) * 0.34 + Math.sin(c.phase[s]) * 0.06
        : groundY + Math.abs(Math.sin(c.phase[s])) * 0.10 * scale * (0.4 + speed01);

      // Damage feedback for free: a drop in the health ratio IS the hit. No
      // event on the wire, no per-hit message, and it cannot desync because
      // there is nothing to desync from.
      c.hitFlash[s] = Math.max(0, c.hitFlash[s] - dt * 4.5);
      if (hp01 < this._prevHp[s] - 1e-4) {
        c.hitFlash[s] = 1;
        c.stagger[s] = Math.min(1, c.stagger[s] + 0.35 / (0.6 + scale));
      }
      this._prevHp[s] = hp01;
      c.stagger[s] = Math.max(0, c.stagger[s] - dt * 3.4);
      c.hpGhost[s] = Math.max(hp01, c.hpGhost[s] - dt * 0.55);

      // The render path and the status VFX only ever test `> 0`, so a bit is
      // enough — the remaining duration is not on the wire and is not missed.
      const st = this._bSt[s];
      c.slowT[s] = st & 1 ? 1 : 0;
      c.burnT[s] = st & 2 ? 1 : 0;
      c.poisonT[s] = st & 4 ? 1 : 0;

      // Targeting order. The simulation ranks by flow-field cost; the watcher
      // has no flow field and does not need one — creeps travel toward +Z, so
      // depth down the board is the same ordering to within the odd doubling
      // back inside a maze, and a tower aimed two metres off for 200 ms is not
      // observable.
      c.progress[s] = z;
    }

    // The manager is never update()d, so the live list it renders from and the
    // spatial hash the cosmetic targeting queries are maintained here.
    c._liveCount = this._slots.length;
    for (let i = 0; i < this._slots.length; i++) c._live[i] = this._slots[i];
    c.count = this._slots.length;
    c.rebuildHash();
  }

  // -- cosmetic combat -------------------------------------------------------

  /**
   * Re-fire the watched board locally.
   *
   * This is a DELIBERATE DUPLICATE of the targeting/aim/fire block in
   * TowerManager.update(), not a parameterised version of it. The two differ in
   * exactly one property that matters — one can change the game, one must not —
   * and a shared function with an `authoritative` boolean is precisely the
   * mechanism by which a cosmetic path later acquires the ability to mutate the
   * real board. Forty-five lines of duplication is the price of that boundary
   * being structural.
   *
   * What it buys: zero bytes for yaw, targets, cooldowns, projectile spawns,
   * muzzle flashes, impacts, splash radii, chain arcs and death explosions —
   * which together are essentially the entire visual life of a board.
   */
  #fire(dt) {
    const c = this.creeps;
    const fx = this.game.fx;

    for (const t of this.towers) {
      if (t.def.kind === 'inert') {
        t.target = -1;
        t.pulse = 1;
        t.recoil = Math.max(0, t.recoil - dt * 5.2);
        continue;
      }

      const s = t.def.levels[t.level];
      t.cooldown -= dt;

      if (t.target < 0 || !c.alive[t.target]
          || dist2(c.x[t.target], c.z[t.target], t.x, t.z) > s.range * s.range) {
        t.target = c.findTarget(t.x, t.z, s.range, { mode: 'first' });
      }

      if (t.target >= 0) {
        const ti = t.target;
        const px = c.x[ti] - t.x, pz = c.z[ti] - t.z;
        const tt = Math.hypot(px, pz) / s.speed;
        const lx = c.x[ti] + c.vx[ti] * tt;
        const ly = c.y[ti] + 0.8;
        const lz = c.z[ti] + c.vz[ti] * tt;

        const targetYaw = Math.atan2(lx - t.x, lz - t.z);
        let d = targetYaw - t.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        t.yaw += d * (1 - Math.exp(-dt * 11));
        t.spinup = Math.min(1, t.spinup + dt * 2.2);
        t.charge = clamp01(1 - t.cooldown / 0.28);

        if (t.cooldown <= 0 && Math.abs(d) < 0.35) {
          const m = t.spec?.muzzle ?? [0, 0, 0.8];
          const cs = Math.cos(t.yaw), sn = Math.sin(t.yaw);
          const mx = t.x + m[0] * cs + m[2] * sn;
          const my = (t.riseY || 0) + (t.spec?.headY ?? 6.8) + m[1];
          const mz = t.z - m[0] * sn + m[2] * cs;
          this.projectiles.spawn({
            x: mx, y: my, z: mz, tx: lx, ty: ly, tz: lz,
            target: ti, speed: s.speed,
            color: t.def.color, accent: t.def.accent,
            towerId: t.id, stats: s, arc: s.splash ? 0.35 : 0.05,
          });
          fx.muzzleFlash(mx, my, mz, t.def.color, s.splash ? 1.5 : 1.0);
          t.cooldown = s.cooldown;
          t.recoil = 1;
          t.charge = 0;
        }
      } else {
        t.spinup = Math.max(0, t.spinup - dt * 1.4);
        t.charge = Math.max(0, t.charge - dt * 3);
        t.yaw += Math.sin(this.game.elapsed * 0.35 + t.id * 1.7) * dt * 0.35;
      }

      t.recoil = Math.max(0, t.recoil - dt * 5.2);
      t.pulse = IDLE_PULSE
        + Math.sin(this.game.elapsed * 2.6 + t.id * 2.1) * IDLE_PULSE * 0.20
        + t.spinup * IDLE_PULSE * 0.41 + t.charge * IDLE_PULSE * 1.18
        + t.recoil * t.recoil * (FIRE_PULSE - IDLE_PULSE);
    }

    this.projectiles.update(dt);
  }

  #present(dt) {
    const c = this.creeps;
    // The vertex shader animates off uTime, and nothing else advances it here
    // because update() — which normally does — is never called on this manager.
    c.time += dt;
    const sh = c.material.userData.shader;
    if (sh) sh.uniforms.uTime.value = c.time;
    c.outlineMaterial.uniforms.uTime.value = c.time;
    c.xrayMaterial.uniforms.uTime.value = c.time;
    c.present();
    // BEFORE game.fx.update, which Game.frame calls a few lines later: the
    // muzzle flashes and impacts emitted above are then integrated in the same
    // frame they are spawned.
    this.game.towers.batch.update(this.towers, dt, this.game.elapsed);
  }

  // -- towers ----------------------------------------------------------------

  /**
   * Apply `tf` (keyframe) or `ta`/`tr` (delta).
   *
   * A delta applied to nothing is how a board ends up missing half its towers
   * for the rest of a run with nothing on either machine able to notice, so
   * deltas are ignored outright until one keyframe has landed.
   */
  #applyTowers(m) {
    let changed = false;

    if (Array.isArray(m.tf)) {
      const seen = new Set();
      for (const [id, key, level, cc, rr] of m.tf) {
        seen.add(id);
        changed = this.#put(id, key, level, cc, rr) || changed;
      }
      for (const t of [...this.towers]) {
        if (!seen.has(t.id)) { this.#drop(t.id); changed = true; }
      }
      this._haveKeyframe = true;
    } else if (this._haveKeyframe) {
      if (Array.isArray(m.tr)) for (const id of m.tr) changed = this.#drop(id) || changed;
      if (Array.isArray(m.ta)) {
        for (const [id, key, level, cc, rr] of m.ta) {
          changed = this.#put(id, key, level, cc, rr) || changed;
        }
      }
    }

    // One upload per batch of changes, and only while this view is the one on
    // screen — Game re-points arena.grid at ours on enterSpectate.
    if (changed && this.game.arena.grid === this.grid) this.game.arena.refreshOccupancy();
  }

  /** @returns {boolean} whether the board actually changed */
  #put(id, key, level, cc, rr) {
    const existing = this._towerById.get(id);
    if (existing) {
      if (existing.level === level && existing.c === cc && existing.r === rr) return false;
      // Same remove/re-add pair TowerManager.upgrade uses: the batch caches one
      // geometry set per (key, level), so a level change is a new tenancy.
      this.#drop(id);
    }
    const def = towerDef(key);
    if (!def) return false;

    const pos = this.grid.towerCentreToWorld(cc, rr, {});
    const t = {
      id, key, def, level,
      c: cc, r: rr, x: pos.x, z: pos.z,
      cooldown: 0, target: -1,
      yaw: Math.random() * Math.PI * 2,
      recoil: 0, charge: 0, pulse: 1, spinup: 0,
      rise: 0, riseY: 0,
      spec: null, inst: null, baseYaw: 0, baseDirty: true,
      overlaySlot: -1,
      birth: performance.now() * 0.001,
      totalDamage: 0, kills: 0, mode: 'first',
    };
    this.game.towers.batch.attach(t);       // sets spec, inst, baseYaw, rise = 0
    this.towers.push(t);
    this._towerById.set(id, t);
    this.grid.setTower(cc, rr, id);
    return true;
  }

  /** @returns {boolean} whether the board actually changed */
  #drop(id) {
    const t = this._towerById.get(id);
    if (!t) return false;
    this.game.towers.batch.detach(t);
    this.grid.clearTower(t.c, t.r);
    this._towerById.delete(id);
    const i = this.towers.indexOf(t);
    if (i >= 0) this.towers.splice(i, 1);
    return true;
  }

}

// -----------------------------------------------------------------------------

/** One pooled snapshot. Typed arrays sized to the wire cap; never re-allocated. */
function makeFrame() {
  return {
    pb: 0, n: 0,
    uid: new Uint16Array(CAP),
    ty: new Uint8Array(CAP),
    x: new Float32Array(CAP),
    z: new Float32Array(CAP),
    hp: new Float32Array(CAP),
    st: new Uint8Array(CAP),
  };
}

function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function clampAbs(v, m) { return v < -m ? -m : v > m ? m : v; }
