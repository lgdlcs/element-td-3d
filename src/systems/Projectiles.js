import * as THREE from 'three';
import { ProjectileRenderer } from '../fx/ProjectileVisuals.js';
import { RibbonSystem } from '../fx/Ribbons.js';
import { resolveFamily, archetypeOf, ARCH, FAMILY_FX } from '../fx/ElementLang.js';
import { COMBAT } from '../core/Config.js';

/**
 * Homing projectiles.
 *
 * Each projectile is: a procedural core+glow billboard (or a lit tumbling rock
 * for the earth family), a camera-facing tapered ribbon trail sampled in world
 * space so it reads as a long sweeping arc, and a light contribution at spawn
 * and impact. Element identity drives all three.
 *
 * Impact resolution (direct damage, splash falloff, chain, slow/burn/poison,
 * execute) lives here so towers stay declarative. That logic is unchanged from
 * the original implementation — only the presentation around it was rebuilt.
 */
const MAX = 1400;
const TRAIL_LEN = 20;          // ribbon nodes per projectile
const RIBBON_SLOTS = 384;      // concurrent trails we can draw (incl. fading)
const FADE_SLOTS = 64;         // trails that linger briefly after impact

export class ProjectileManager {
  constructor(scene, creeps, fx) {
    this.scene = scene;
    this.creeps = creeps;
    this.fx = fx;
    // Let the effect system drive burning/frozen/poisoned creep VFX itself.
    fx?.attachCreeps?.(creeps);

    this.alive = new Uint8Array(MAX);
    this.x = new Float32Array(MAX);
    this.y = new Float32Array(MAX);
    this.z = new Float32Array(MAX);
    this.vx = new Float32Array(MAX);
    this.vy = new Float32Array(MAX);
    this.vz = new Float32Array(MAX);
    this.speed = new Float32Array(MAX);
    this.target = new Int32Array(MAX);
    this.life = new Float32Array(MAX);
    this.age = new Float32Array(MAX);
    this.arc = new Float32Array(MAX);
    this.towerId = new Int32Array(MAX);
    this.colors = new Float32Array(MAX * 3);
    this.accents = new Float32Array(MAX * 3);
    this.stats = new Array(MAX);
    this.family = new Array(MAX);
    this.archetype = new Uint8Array(MAX);
    this.seed = new Float32Array(MAX);
    this.spinX = new Float32Array(MAX);
    this.spinY = new Float32Array(MAX);
    this.spinZ = new Float32Array(MAX);
    this.shadowT = new Float32Array(MAX);
    this.emitT = new Float32Array(MAX);

    this.trail = new Float32Array(MAX * TRAIL_LEN * 3);
    this.trailCount = new Uint8Array(MAX);
    this.trailStep = new Float32Array(MAX);

    this.free = [];
    for (let i = MAX - 1; i >= 0; i--) this.free.push(i);

    this.onDamage = null; // (towerId, amount, creepIdx) -> void

    this.renderer = new ProjectileRenderer(scene, MAX);
    this.ribbons = new RibbonSystem(scene, {
      slots: RIBBON_SLOTS, nodes: TRAIL_LEN, renderOrder: 8, softness: 1.15, gain: 2.5,
    });

    // Trails that keep glowing for a beat after the projectile is gone.
    this.fade = [];
    this.fadePts = new Float32Array(FADE_SLOTS * TRAIL_LEN * 3);
    for (let i = 0; i < FADE_SLOTS; i++) {
      this.fade.push({ idx: i, live: false, t: 0, dur: 0.22, n: 0, w: 0.2, r: 0, g: 0, b: 0 });
    }
    this.fadeCursor = 0;

    this._time = 0;
    this._hitList = [];
  }

  /**
   * @param {object} opts  {x,y,z, tx,ty,tz, target, speed, color, accent,
   *                        towerId, stats, arc, element?}
   *   `element` is optional — when absent the family is inferred from `color`.
   */
  spawn(opts) {
    if (!this.free.length) return -1;
    const i = this.free.pop();
    this.alive[i] = 1;
    this.x[i] = opts.x; this.y[i] = opts.y; this.z[i] = opts.z;
    const dx = opts.tx - opts.x, dy = opts.ty - opts.y, dz = opts.tz - opts.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    this.speed[i] = opts.speed;
    this.vx[i] = dx / l * opts.speed;
    this.vy[i] = dy / l * opts.speed + (opts.arc ?? 0) * opts.speed;
    this.vz[i] = dz / l * opts.speed;
    this.target[i] = opts.target;
    this.life[i] = 3.5;
    this.age[i] = 0;
    this.arc[i] = opts.arc ?? 0;
    this.towerId[i] = opts.towerId;
    this.stats[i] = opts.stats;

    const c = TMP.setHex(opts.color).convertSRGBToLinear();
    this.colors[i * 3] = c.r; this.colors[i * 3 + 1] = c.g; this.colors[i * 3 + 2] = c.b;
    const ac = TMP.setHex(opts.accent ?? opts.color).convertSRGBToLinear();
    this.accents[i * 3] = ac.r; this.accents[i * 3 + 1] = ac.g; this.accents[i * 3 + 2] = ac.b;

    const fam = resolveFamily(opts.element, opts.color);
    this.family[i] = fam;
    this.archetype[i] = archetypeOf(fam);
    this.seed[i] = Math.random();
    this.spinX[i] = (Math.random() - 0.5) * 9;
    this.spinY[i] = (Math.random() - 0.5) * 9;
    this.spinZ[i] = (Math.random() - 0.5) * 9;
    this.shadowT[i] = 0;
    this.emitT[i] = 0;

    // Seed the trail at the muzzle so the ribbon has a valid spine on frame 1.
    const base = i * TRAIL_LEN * 3;
    for (let k = 0; k < TRAIL_LEN; k++) {
      this.trail[base + k * 3] = opts.x;
      this.trail[base + k * 3 + 1] = opts.y;
      this.trail[base + k * 3 + 2] = opts.z;
    }
    this.trailCount[i] = 1;
    // World-space node spacing: fast projectiles draw longer arcs.
    this.trailStep[i] = Math.max(0.14, opts.speed * 0.0068);

    // Tell the effect system which way the barrel was pointing and which
    // element left it, so its muzzle flash can be directional and in-dialect.
    // Towers.js calls spawn() first and muzzleFlash() immediately after, so
    // the hint is always fresh. Purely advisory — nothing breaks without it.
    this.fx?.registerSpawnHint?.(
      opts.x, opts.y, opts.z,
      this.vx[i], this.vy[i], this.vz[i], fam,
    );
    return i;
  }

  #release(i, keepTrail = true) {
    if (keepTrail && this.trailCount[i] > 2) this.#pushFade(i);
    this.alive[i] = 0;
    this.stats[i] = null;
    this.free.push(i);
  }

  #pushFade(i) {
    let it = null;
    for (let n = 0; n < FADE_SLOTS; n++) {
      const c = this.fade[this.fadeCursor];
      this.fadeCursor = (this.fadeCursor + 1) % FADE_SLOTS;
      if (!c.live) { it = c; break; }
    }
    if (!it) return;
    const src = i * TRAIL_LEN * 3;
    const dst = it.idx * TRAIL_LEN * 3;
    this.fadePts.set(this.trail.subarray(src, src + TRAIL_LEN * 3), dst);
    it.live = true; it.t = 0; it.dur = 0.24;
    it.n = this.trailCount[i];
    it.w = ribbonWidth(this.archetype[i]);
    it.r = this.colors[i * 3]; it.g = this.colors[i * 3 + 1]; it.b = this.colors[i * 3 + 2];
  }

  update(dt) {
    this._time += dt;
    const c = this.creeps;
    for (let i = 0; i < MAX; i++) {
      if (!this.alive[i]) continue;

      this.life[i] -= dt;
      this.age[i] += dt;
      if (this.life[i] <= 0) { this.#release(i); continue; }

      // Homing: steer toward the live target; if it died, keep flying straight.
      const ti = this.target[i];
      if (ti >= 0 && c.alive[ti]) {
        const dx = c.x[ti] - this.x[i];
        const dy = (c.y[ti] + 0.8) - this.y[i];
        const dz = c.z[ti] - this.z[i];
        const d = Math.hypot(dx, dy, dz);

        if (d < 0.55) { this.#impact(i, c.x[ti], c.y[ti] + 0.6, c.z[ti], ti); continue; }

        const s = this.speed[i];
        const k = 1 - Math.exp(-dt * 14);
        this.vx[i] += (dx / d * s - this.vx[i]) * k;
        this.vy[i] += (dy / d * s - this.vy[i]) * k;
        this.vz[i] += (dz / d * s - this.vz[i]) * k;
      }

      if (this.arc[i] > 0) this.vy[i] -= 26 * this.arc[i] * dt;

      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;

      if (this.y[i] < 0.05) { this.#impact(i, this.x[i], 0.1, this.z[i], -1); continue; }

      this.#advanceTrail(i);
      this.#inFlightFx(i, dt);
    }

    this.#updateFades(dt);
    this.#writeInstances();
  }

  /** World-space trail sampling: push a node only once we've actually moved. */
  #advanceTrail(i) {
    const base = i * TRAIL_LEN * 3;
    const hx = this.trail[base], hy = this.trail[base + 1], hz = this.trail[base + 2];
    const d = Math.hypot(this.x[i] - hx, this.y[i] - hy, this.z[i] - hz);
    if (d >= this.trailStep[i]) {
      this.trail.copyWithin(base + 3, base, base + (TRAIL_LEN - 1) * 3);
      if (this.trailCount[i] < TRAIL_LEN) this.trailCount[i]++;
    }
    this.trail[base] = this.x[i];
    this.trail[base + 1] = this.y[i];
    this.trail[base + 2] = this.z[i];
  }

  /** Per-element in-flight garnish: embers, dust, ground shadow. */
  #inFlightFx(i, dt) {
    const fx = this.fx;
    if (!fx) return;
    const arch = this.archetype[i];

    // Arcing bodies get a soft ground indicator so their height reads.
    if (this.arc[i] > 0.15) {
      this.shadowT[i] -= dt;
      if (this.shadowT[i] <= 0) {
        this.shadowT[i] = 0.09;
        const h = Math.max(0.2, this.y[i]);
        fx.groundShadow(this.x[i], this.z[i], 0.30 + h * 0.075, 0.13);
      }
    }

    this.emitT[i] -= dt;
    if (this.emitT[i] > 0) return;
    const th = fx.throttle ?? 1;
    this.emitT[i] = 0.05 / Math.max(0.25, th);

    const cr = this.colors[i * 3], cg = this.colors[i * 3 + 1], cb = this.colors[i * 3 + 2];
    const jx = (Math.random() - 0.5) * 0.3, jy = (Math.random() - 0.5) * 0.3, jz = (Math.random() - 0.5) * 0.3;

    if (arch === ARCH.BOLT) {
      fx.emit({
        x: this.x[i] + jx, y: this.y[i] + jy, z: this.z[i] + jz,
        vx: 0, vy: 1.2, vz: 0, life: 0.34,
        size: 0.17, sizeEnd: 0.01,
        color: [cr * 2.0, cg * 1.3, cb * 0.6],
        drag: 2.0, grav: 1.2, kind: 2, spin: Math.random() * 6.28,
      });
    } else if (arch === ARCH.ORB) {
      if (Math.random() < 0.5) {
        fx.emit({
          x: this.x[i] + jx, y: this.y[i] + jy, z: this.z[i] + jz,
          vx: 0, vy: -1.2, vz: 0, life: 0.35,
          size: 0.11, sizeEnd: 0.01,
          color: [cr * 1.8, cg * 1.9, cb * 2.2],
          drag: 1.0, grav: -6,
        });
      }
    } else if (arch === ARCH.BOULDER) {
      fx.emit({
        x: this.x[i] + jx, y: this.y[i] + jy, z: this.z[i] + jz,
        vx: 0, vy: 0.4, vz: 0, life: 0.55,
        size: 0.26, sizeEnd: 0.85,
        color: [0.10, 0.085, 0.065],
        drag: 1.6, grav: 0.2, kind: 1, spin: (Math.random() - 0.5) * 2,
      });
    } else if (arch === ARCH.VOID) {
      if (Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2;
        fx.emit({
          x: this.x[i] + Math.cos(a) * 0.7, y: this.y[i] + jy, z: this.z[i] + Math.sin(a) * 0.7,
          vx: -Math.cos(a) * 2.4, vy: 0, vz: -Math.sin(a) * 2.4, life: 0.3,
          size: 0.14, sizeEnd: 0.01,
          color: [cr * 2.0, cg * 1.4, cb * 2.4],
          drag: 0.5, grav: 0,
        });
      }
    } else if (arch === ARCH.SEED && Math.random() < 0.4) {
      fx.emit({
        x: this.x[i] + jx, y: this.y[i] + jy, z: this.z[i] + jz,
        vx: 0, vy: 0.3, vz: 0, life: 0.6,
        size: 0.10, sizeEnd: 0.01,
        color: [cr * 1.6, cg * 2.0, cb * 1.2],
        drag: 1.5, grav: 0.4, kind: 2, spin: Math.random() * 6.28,
      });
    }
  }

  #updateFades(dt) {
    for (const it of this.fade) {
      if (!it.live) continue;
      it.t += dt;
      if (it.t >= it.dur) it.live = false;
    }
  }

  // -------------------------------------------------------------------
  // Impact resolution — damage rules preserved verbatim.
  // -------------------------------------------------------------------
  #impact(i, x, y, z, directIdx) {
    const s = this.stats[i];
    const c = this.creeps;
    const towerId = this.towerId[i];
    const cr = this.colors[i * 3], cg = this.colors[i * 3 + 1], cb = this.colors[i * 3 + 2];
    const fam = this.family[i] ?? 'light';

    const deal = (idx, amount, crit = false) => {
      if (!c.alive[idx]) return;
      let dmg = amount;
      if (s.execute) {
        const missing = 1 - c.hp[idx] / c.maxHp[idx];
        dmg *= 1 + missing * s.execute * 6;
      }
      if (crit) dmg *= COMBAT.critMult;
      const dealt = c.damage(idx, dmg, { armorPen: s.armorPen ?? 0, type: s.damageType ?? 'physical' });
      if (this.onDamage) this.onDamage(towerId, dealt, idx, crit);
      if (s.slow) c.applySlow(idx, s.slow.amt, s.slow.dur);
      if (s.burn) c.applyBurn(idx, s.burn.dps, s.burn.dur);
      // Poison is its own status track (its own timer, its own world VFX).
      // Routing it through applyBurn made poison towers set creeps on fire.
      if (s.poison) c.applyPoison(idx, s.poison.dps, s.poison.dur);
    };

    // Crits are rolled once per impact and apply to the DIRECT hit only — see
    // COMBAT in Config.js for why splash/chain/DoT are deliberately excluded.
    const crit = directIdx >= 0 && Math.random() < COMBAT.critChance;
    if (directIdx >= 0) deal(directIdx, s.damage, crit);
    // A crit that looks the same as a normal hit is a number in a log file, not
    // a mechanic: give it its own flash so the player can see it land.
    if (crit) this.fx?.impact(x, y, z, [cr * 1.9 + 0.5, cg * 1.6 + 0.35, cb * 1.2], fam, 1.9);

    if (s.splash) {
      const list = c.query(x, z, s.splash.radius, this._hitList);
      for (const idx of list) {
        if (idx === directIdx) continue;
        const d = Math.hypot(c.x[idx] - x, c.z[idx] - z);
        const f = 1 - (d / s.splash.radius) * s.splash.falloff;
        deal(idx, s.damage * Math.max(0, f));
      }
      this.fx?.explosion(x, y, z, s.splash.radius, [cr, cg, cb], fam);
    } else {
      this.fx?.impact(x, y, z, [cr, cg, cb], fam, 1);
    }

    if (s.chain && directIdx >= 0) {
      let from = directIdx;
      let dmg = s.damage * s.chain.falloff;
      const hit = new Set([directIdx]);
      for (let n = 0; n < s.chain.count; n++) {
        const list = c.query(c.x[from], c.z[from], 5.5, this._hitList);
        let next = -1;
        for (const idx of list) if (!hit.has(idx)) { next = idx; break; }
        if (next < 0) break;
        this.fx?.lightning(c.x[from], c.y[from] + 0.8, c.z[from], c.x[next], c.y[next] + 0.8, c.z[next], [cr, cg, cb]);
        deal(next, dmg);
        hit.add(next);
        from = next;
        dmg *= s.chain.falloff;
      }
    }

    this.#release(i);
  }

  // -------------------------------------------------------------------

  #writeInstances() {
    const R = this.renderer;
    const rib = this.ribbons;
    R.begin();
    rib.begin();

    for (let i = 0; i < MAX; i++) {
      if (!this.alive[i]) continue;

      const arch = this.archetype[i];
      const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]) || 1;
      const nx = this.vx[i] / sp, ny = this.vy[i] / sp, nz = this.vz[i] / sp;
      const cr = this.colors[i * 3], cg = this.colors[i * 3 + 1], cb = this.colors[i * 3 + 2];
      const ar = this.accents[i * 3], ag = this.accents[i * 3 + 1], ab = this.accents[i * 3 + 2];
      // Fade in over the first instants so a spawn doesn't pop.
      const birth = Math.min(1, this.age[i] * 14);

      // --- body ---------------------------------------------------
      const radius = BODY_RADIUS[arch] * (0.7 + birth * 0.3);
      const stretch = 1 + Math.min(STRETCH_MAX[arch], sp * STRETCH_K[arch]);
      R.pushBillboard(
        this.x[i], this.y[i], this.z[i], radius,
        nx, ny, nz, arch, this.seed[i], this._time, stretch,
        TMP_A3(cr, cg, cb), TMP_B3(ar, ag, ab),
      );

      if (arch === ARCH.BOULDER) {
        const t = this._time;
        R.pushRock(
          this.x[i], this.y[i], this.z[i], 0.62,
          this.spinX[i] * t, this.spinY[i] * t, this.spinZ[i] * t,
          cr * 0.85 + 0.06, cg * 0.8 + 0.05, cb * 0.75 + 0.04,
        );
      }

      // --- trail --------------------------------------------------
      const cnt = this.trailCount[i];
      if (cnt >= 2) {
        const w = ribbonWidth(arch) * (0.55 + birth * 0.45);
        // Slightly hotter than the body so the ribbon is the brightest thing.
        rib.push(this.trail, i * TRAIL_LEN * 3, cnt,
          TMP_A3(cr * 1.15 + ar * 0.25, cg * 1.15 + ag * 0.25, cb * 1.15 + ab * 0.25),
          w, 1);
      }
    }

    // fading post-impact trails
    for (const it of this.fade) {
      if (!it.live) continue;
      const k = 1 - it.t / it.dur;
      rib.push(this.fadePts, it.idx * TRAIL_LEN * 3, it.n,
        TMP_A3(it.r, it.g, it.b), it.w * k, k * k);
    }

    R.end(this._time);
    rib.end();
  }
}

// ---------------------------------------------------------------------------

// Per-archetype presentation constants. Indexed by ARCH.*
const BODY_RADIUS = [0.62, 0.52, 0.42, 0.55, 0.70, 0.62];
const STRETCH_K = [0.020, 0.012, 0.010, 0.004, 0.045, 0.010];
const STRETCH_MAX = [1.6, 0.9, 0.6, 0.3, 5.0, 0.8];
const RIBBON_W = [0.48, 0.38, 0.24, 0.28, 0.34, 0.42];

function ribbonWidth(arch) { return RIBBON_W[arch] ?? 0.24; }

const TMP = new THREE.Color();
const _a3 = [0, 0, 0];
const _b3 = [0, 0, 0];
function TMP_A3(r, g, b) { _a3[0] = r; _a3[1] = g; _a3[2] = b; return _a3; }
function TMP_B3(r, g, b) { _b3[0] = r; _b3[1] = g; _b3[2] = b; return _b3; }

export { FAMILY_FX };
