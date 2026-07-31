import * as THREE from 'three';
import { towerDef } from './TowerDefs.js';
import { TowerBatch } from './towers/TowerBatch.js';

/**
 * Towers: targeting, firing and animation state.
 *
 * All rendering lives in TowerBatch — one BatchedMesh for every tower on the
 * board plus two additive overlay layers — so this class owns pure simulation
 * data and the animation *drivers* (yaw, charge, recoil, spin-up), never any
 * scene-graph nodes.
 */
/**
 * The emissive multiplier a tower sits at when it is doing nothing, and the
 * value the firing frame spikes to. Everything the tower material emits is
 * scaled by this, so the ratio between the two IS the dynamic range a muzzle
 * flash gets to work in. Exported so the art bench can assert the ratio instead
 * of guessing it.
 *
 * History, because these two numbers have been wrong in both directions:
 *   round 1  0.72 -> 3.30  (4.6x)   idle far too hot, flash invisible
 *   round 2  0.34 -> 5.30  (15.6x)  flash fine, but the terrain premultiply fix
 *                                   and the key-light move landed the same day
 *                                   and made the board 2.4x brighter — so the
 *                                   towers became dark objects on a light floor
 *                                   with no light of their own.
 *   round 3  1.05 -> 11.0  (10.5x)  both raised together.
 *
 * Sizing against the post chain: bloom threshold is 1.05 scene-referred linear.
 * A hero core (geometry emissive ~1.86 linear x albedo ~0.8) idles at ~1.6 —
 * just over threshold, so a resting tower reads as a light source — and fires at
 * ~16.4, an order of magnitude clear of it. That is the whole design: idle
 * *touches* bloom, firing *dominates* it.
 */
export const IDLE_PULSE = 1.05;
export const FIRE_PULSE = 11.0;

/** Fallback ground height for the glow decal until Game.js wires the Arena. */
const DEFAULT_SURFACE_Y = 0.24;

export class TowerManager {
  constructor(scene, grid, creeps, projectiles, fx, quality = {}) {
    this.scene = scene;
    this.grid = grid;
    this.creeps = creeps;
    this.projectiles = projectiles;
    this.fx = fx;

    // `quality` must reach the batch: its point-light pool is the single most
    // expensive setting in the renderer (~6ms per light, charged to every lit
    // pixel in the scene). It was previously constructed as `new
    // TowerBatch(scene)`, so the preset value was silently ignored and the pool
    // always fell back to its 8-light default.
    this.batch = new TowerBatch(scene, quality);
    this.group = this.batch.group;

    /**
     * Terrain height provider, `(x, z) => number`, returning the world Y of the
     * arena surface under a point. Settable because the manager's constructor
     * signature is fixed and it is handed a `grid`, not an `Arena`; Game.js is
     * expected to assign `towers.surfaceHeightAt = (x, z) => arena.surfaceHeightAt(x, z)`
     * right after construction. Reassigning it at any time is safe — the change
     * is detected on the next update and the glow layer rebuilds itself.
     */
    this.surfaceHeightAt = () => DEFAULT_SURFACE_Y;

    this.towers = [];
    this.nextId = 0;
    this._elapsed = 0;

    /**
     * When false, update() targets and fires as usual but writes nothing to the
     * batch. The spectate view borrows the SAME TowerBatch for the watched
     * player's towers, so the local board must stop driving it for as long as
     * someone else's towers are tenanting it — otherwise both boards write
     * matrices into the same instances on the same frame and the batch renders
     * whichever of them ran last.
     */
    this.renderEnabled = true;
  }

  create(key, level, anchorC, anchorR) {
    const def = towerDef(key);
    if (!def) return null;

    const pos = this.grid.towerCentreToWorld(anchorC, anchorR, {});
    const id = this.nextId++;

    const t = {
      id, key, def, level,
      c: anchorC, r: anchorR,
      x: pos.x, z: pos.z,
      cooldown: 0,
      target: -1,
      view: null,
      yaw: Math.random() * Math.PI * 2,
      recoil: 0,
      charge: 0,
      pulse: 1,
      spinup: 0,
      rise: 0,
      riseY: 0,
      totalDamage: 0,
      kills: 0,
      birth: performance.now() * 0.001,
      mode: 'first',
      // How many times this TILE has been morphed. Declared here rather than
      // left undefined so the morph tax is visible state on every tower object;
      // Game.morphTower carries it across the remove/create pair by hand,
      // because create() legitimately hands back a fresh object each time.
      morphCount: 0,
    };
    this.batch.attach(t);
    this.towers.push(t);
    this.grid.setTower(anchorC, anchorR, id);
    this.#placementFx(t);
    return t;
  }

  byId(id) { return this.towers.find((t) => t.id === id) ?? null; }

  remove(id) {
    const i = this.towers.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const t = this.towers[i];
    this.towers.splice(i, 1);
    this.grid.clearTower(t.c, t.r);
    this.batch.detach(t);
    return t;
  }

  upgrade(id) {
    const t = this.byId(id);
    if (!t || t.level >= t.def.levels.length - 1) return null;
    this.batch.detach(t);
    t.level += 1;
    this.batch.attach(t);
    t.rise = 0.42;          // a surge, not a full re-emergence
    t.recoil = 1;
    this.#placementFx(t, 1.4);
    return t;
  }

  stats(t) { return t.def.levels[t.level]; }

  /** Dust + a shockwave so a tower appearing has physical weight. */
  #placementFx(t, scale = 1) {
    const fx = this.fx;
    if (!fx) return;
    const dust = 0x8f8272;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + Math.random();
      fx.impact?.(t.x + Math.cos(a) * 1.8 * scale, 0.18, t.z + Math.sin(a) * 1.8 * scale, dust);
    }
    fx.explosion?.(t.x, 0.12, t.z, 3.0 * scale, dust);
    // No muzzle flash for a foundation: it is a coloured light bloom, which is
    // the exact cue that says "this thing is armed", and it would also arm a
    // slot in the fx light pool — the single most expensive lever in the
    // renderer — once per block while the player lays out a maze.
    if (t.def.kind !== 'inert') fx.muzzleFlash?.(t.x, 1.1, t.z, t.def.color, 1.1 * scale);
  }

  update(dt, elapsed) {
    this._elapsed = elapsed;
    this.batch.setHeightProvider(this.surfaceHeightAt);
    const creeps = this.creeps;

    for (const t of this.towers) {
      // Foundations are walls. They never acquire a target, never fire, never
      // spin up and never pulse — the whole targeting block below would also
      // divide by a zero cooldown and call findTarget with range 0 every frame
      // for every block in the maze.
      if (t.def.kind === 'inert') {
        t.target = -1;
        t.pulse = 1;
        t.recoil = Math.max(0, t.recoil - dt * 5.2);   // placement thump only
        continue;
      }

      const s = this.stats(t);
      t.cooldown -= dt;

      // --- retarget ---
      if (t.target < 0 || !creeps.alive[t.target]
          || dist2(creeps.x[t.target], creeps.z[t.target], t.x, t.z) > s.range * s.range) {
        t.target = creeps.findTarget(t.x, t.z, s.range, { mode: t.mode });
      }

      // --- aim ---
      if (t.target >= 0) {
        const lead = this.#predict(t, s, t.target);
        const targetYaw = Math.atan2(lead.x - t.x, lead.z - t.z);
        let d = targetYaw - t.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        t.yaw += d * (1 - Math.exp(-dt * 11));
        t.spinup = Math.min(1, t.spinup + dt * 2.2);
        // Anticipation: the last 0.28s before the shot winds the tower up.
        t.charge = clamp01(1 - t.cooldown / 0.28);

        if (t.cooldown <= 0 && Math.abs(d) < 0.35) {
          this.#fire(t, s, lead);
          t.cooldown = s.cooldown;
          t.recoil = 1;
          t.charge = 0;
        }
      } else {
        t.spinup = Math.max(0, t.spinup - dt * 1.4);
        t.charge = Math.max(0, t.charge - dt * 3);
        // Idle sweep so towers never look frozen.
        t.yaw += Math.sin(elapsed * 0.35 + t.id * 1.7) * dt * 0.35;
      }

      // Recoil decays fast, then the follow-through rides the tail out.
      t.recoil = Math.max(0, t.recoil - dt * 5.2);
      // The breathe / spin-up / anticipation terms are held at a constant
      // fraction of IDLE_PULSE, so raising the resting level does not silently
      // flatten the tower's idle animation into invisibility.
      t.pulse = IDLE_PULSE
        + Math.sin(elapsed * 2.6 + t.id * 2.1) * IDLE_PULSE * 0.20
        + t.spinup * IDLE_PULSE * 0.41
        + t.charge * IDLE_PULSE * 1.18
        + t.recoil * t.recoil * (FIRE_PULSE - IDLE_PULSE);
    }

    if (this.renderEnabled) this.batch.update(this.towers, dt, elapsed);
  }

  /** First-order intercept so fast creeps aren't perpetually missed. */
  #predict(t, s, ci) {
    const c = this.creeps;
    const px = c.x[ci] - t.x, pz = c.z[ci] - t.z;
    const d = Math.hypot(px, pz);
    const tt = d / s.speed;
    return {
      x: c.x[ci] + c.vx[ci] * tt,
      y: c.y[ci] + 0.8,
      z: c.z[ci] + c.vz[ci] * tt,
    };
  }

  #muzzleWorld(t, out) {
    const m = t.spec?.muzzle ?? [0, 0, 0.8];
    const cs = Math.cos(t.yaw), sn = Math.sin(t.yaw);
    out.set(
      t.x + m[0] * cs + m[2] * sn,
      (t.riseY || 0) + (t.spec?.headY ?? 6.8) + m[1],
      t.z - m[0] * sn + m[2] * cs,
    );
    return out;
  }

  #fire(t, s, lead) {
    const world = this.#muzzleWorld(t, _v);

    this.projectiles.spawn({
      x: world.x, y: world.y, z: world.z,
      tx: lead.x, ty: lead.y, tz: lead.z,
      target: t.target,
      speed: s.speed,
      color: t.def.color,
      accent: t.def.accent,
      towerId: t.id,
      stats: s,
      arc: s.splash ? 0.35 : 0.05,
    });

    this.fx?.muzzleFlash(world.x, world.y, world.z, t.def.color, s.splash ? 1.5 : 1.0);
  }
}

const _v = new THREE.Vector3();
function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
