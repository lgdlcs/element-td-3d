import * as THREE from 'three';
import { GRID } from '../core/Config.js';
import { ARCHETYPE_BUILDERS } from './creeps/geometry.js';
import { makeCreepMaterial, makeCreepDepthMaterial } from './creeps/material.js';
import { HealthBarField } from './creeps/healthbars.js';
import { ParticleField, GibField, ContactField, PK } from './creeps/effects.js';
import { makeOutlineMaterial, makeXrayMaterial, makeShells } from './creeps/silhouette.js';
import { HOSTILE } from './creeps/palette.js';

/**
 * Data-oriented creep manager.
 *
 * All creep state lives in flat typed arrays; rendering is one InstancedMesh
 * per archetype (6), plus health bars, ground contact, particles and gibs —
 * ten draw calls for the entire army and everything it leaves behind.
 *
 * Animation is done entirely in the vertex shader (see creeps/material.js):
 * each vertex knows which "bone" it belongs to and where that bone's joint is,
 * so limbs swing, capes drag, wings beat and bodies bank into turns without a
 * single CPU-side matrix per limb.
 *
 * Readability (gate G4) follows the Element TD 2 model. As of round 5 it is
 * four redundant cues, and every one of them speaks the SAME reserved hostile
 * hue (creeps/palette.js) — no tower, no terrain and no VFX may use it:
 *   1. a near-black BODY, which is a value slot nothing else in frame occupies
 *   2. a constant-screen-width hull OUTLINE in hostile red around it
 *   3. a depth-fail XRAY silhouette, so a tower cannot hide a unit
 *   4. a hard dark ground SHADOW with a hostile-red rim, so it sits on the board
 * A wave reads as one dark, red-edged mass on pale desaturated stone.
 */

/**
 * ROUND 5 — COLOUR IS NO LONGER PER-ARCHETYPE.
 *
 * Round 2 reasoned that the floor is warm desaturated stone, so the creeps
 * should be cold and high-chroma. That is correct as far as it goes, and it is
 * why five archetypes were cyan / spring green / lime / violet / magenta.
 *
 * What it missed is that the floor is not the only thing on the board. Cyan is
 * the water tower. Lime is nature. Violet is dark. Magenta is trickery. Every
 * archetype was wearing a tower's colour, and a midgame board spills those same
 * colours across the floor as glow pools and VFX washes — so an enemy was a
 * coloured shape among a hundred coloured shapes, all of them friendly. Three
 * blind critics independently reported that they could not find a single unit,
 * and two of them independently prescribed the fix: one saturated hue reserved
 * exclusively for enemies.
 *
 * That reservation lives in `creeps/palette.js`, which is now the ONLY place a
 * creep colour may be authored. All six archetypes are the same hostile red;
 * they vary in value inside that hue, never across it. Identity comes from
 * silhouette, size and gait, which is where Element TD 2 puts it too.
 *
 * SCALE. Up ~35-45% on round 1 (which was itself up 55%). At the default
 * camera the board is ~21px per world unit, so a round-1 Grunt limb was 5px
 * wide and averaged into the floor by MSAA. Scale costs zero triangles. Big
 * units now cosmetically clip tower bases in tight corridors; that trade is
 * deliberate — overlap is a nuisance, invisibility is a failed gate.
 */
export const CREEP_TYPES = {
  normal: {
    name: 'Grunt', hpMul: 1.00, speed: 4.2, armor: 0, scale: 2.72,
    mesh: 'grunt', color: HOSTILE.normal, height: 1.85, radius: 0.44,
  },
  fast: {
    name: 'Stalker', hpMul: 0.72, speed: 7.4, armor: 0, scale: 2.48,
    mesh: 'runner', color: HOSTILE.fast, height: 1.78, radius: 0.36,
  },
  armored: {
    name: 'Bulwark', hpMul: 1.35, speed: 3.6, armor: 6, scale: 3.00,
    mesh: 'brute', color: HOSTILE.armored, height: 1.90, radius: 0.66,
  },
  swarm: {
    name: 'Mite', hpMul: 0.34, speed: 5.6, armor: 0, scale: 2.48,
    mesh: 'mite', color: HOSTILE.swarm, height: 0.78, radius: 0.36,
  },
  flying: {
    name: 'Wisp', hpMul: 0.85, speed: 5.8, armor: 2, scale: 2.60,
    mesh: 'wisp', color: HOSTILE.flying, height: 1.85, radius: 0.48,
    flying: true,
  },
  boss: {
    name: 'Colossus', hpMul: 9.50, speed: 3.0, armor: 10, scale: 4.25,
    mesh: 'colossus', color: HOSTILE.boss, height: 2.55, radius: 1.05,
    boss: true,
  },
};

const MAX_CREEPS = 900;
const UP = new THREE.Vector3(0, 1, 0);

export class CreepManager {
  constructor(scene, grid, pathfinder) {
    this.scene = scene;
    this.grid = grid;
    this.path = pathfinder;

    this.capacity = MAX_CREEPS;
    this.count = 0;
    this.time = 0;

    // --- state arrays ---
    this.alive = new Uint8Array(this.capacity);
    this.x = new Float32Array(this.capacity);
    this.y = new Float32Array(this.capacity);
    this.z = new Float32Array(this.capacity);
    this.vx = new Float32Array(this.capacity);
    this.vz = new Float32Array(this.capacity);
    this.hp = new Float32Array(this.capacity);
    this.maxHp = new Float32Array(this.capacity);
    this.hpGhost = new Float32Array(this.capacity);
    this.speed = new Float32Array(this.capacity);
    this.baseSpeed = new Float32Array(this.capacity);
    this.armor = new Float32Array(this.capacity);
    this.scale = new Float32Array(this.capacity);
    this.yaw = new Float32Array(this.capacity);
    this.lean = new Float32Array(this.capacity);
    this.stagger = new Float32Array(this.capacity);
    this.spawnT = new Float32Array(this.capacity);
    this.phase = new Float32Array(this.capacity);
    this.stepPhase = new Float32Array(this.capacity);
    this.typeIdx = new Uint8Array(this.capacity);
    this.flying = new Uint8Array(this.capacity);
    this.bounty = new Float32Array(this.capacity);
    this.slowT = new Float32Array(this.capacity);
    this.slowAmt = new Float32Array(this.capacity);
    this.burnT = new Float32Array(this.capacity);
    this.burnDps = new Float32Array(this.capacity);
    this.poisonT = new Float32Array(this.capacity);
    this.poisonDps = new Float32Array(this.capacity);
    this.hitFlash = new Float32Array(this.capacity);
    this.progress = new Float32Array(this.capacity);
    this.groundY = new Float32Array(this.capacity);
    this.tint = new Float32Array(this.capacity * 3);   // linear rgb rim colour

    this.freeList = [];
    for (let i = this.capacity - 1; i >= 0; i--) this.freeList.push(i);

    // Dense list of live indices — the update loop never touches dead slots.
    this._live = new Int32Array(this.capacity);
    this._liveCount = 0;

    this.typeKeys = Object.keys(CREEP_TYPES);
    this._typeColorLinear = this.typeKeys.map((k) => {
      const c = new THREE.Color(CREEP_TYPES[k].color).convertSRGBToLinear();
      return [c.r, c.g, c.b];
    });
    this.onLeak = null;
    this.onDeath = null;

    /**
     * PUBLIC, SETTABLE. Ground height at a world XZ. Defaults to a flat plane
     * so this module stays standalone; Game.js should overwrite it with
     *   creeps.surfaceHeightAt = (x, z) => arena.surfaceHeightAt(x, z);
     * Everything that touches the floor routes through here: creep feet,
     * contact shadows, footfall dust and settled gibs. Without it, units and
     * their debris sit at y=0 and float over raised terrain.
     * @type {(x:number, z:number) => number}
     */
    this.surfaceHeightAt = () => 0;

    this.#buildMeshes();

    this._dir = { x: 0, z: 0 };
    this._tmpMat = new THREE.Matrix4();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpPos = new THREE.Vector3();
    this._tmpScale = new THREE.Vector3();

    // Spatial hash (integer keys — string keys were the single biggest
    // per-frame allocation at 300+ units).
    this.cellSize = 3.0;
    this.hash = new Map();
    this._usedKeys = [];
    this._neighbours = [];
  }

  #buildMeshes() {
    this.group = new THREE.Group();
    this.group.name = 'creeps';
    this.scene.add(this.group);

    // One shared material instance => one shader program for the whole army.
    this.material = makeCreepMaterial();
    this.depthMaterial = makeCreepDepthMaterial();
    // Two shared shell materials => two shader programs for the whole army,
    // regardless of how many archetypes are on the board.
    this.outlineMaterial = makeOutlineMaterial();
    this.xrayMaterial = makeXrayMaterial();
    // View-space inflation per unit of view depth. At the default camera
    // (~60 units out) this is the outline's width in world units per unit of
    // depth; the *point* of scaling by depth is that the outline stays the same
    // number of pixels wide at every zoom. Verified by capture, not by algebra.
    this.outlineMaterial.uniforms.uInflate.value = 0.0029;
    // NEGATIVE = pushed AWAY from the camera, and this is what makes the shell
    // an outline instead of a coat of paint. The inflation is view-XY only, so
    // on a THIN primitive — and a creep is full of them: blades, spikes, capes,
    // wing membranes — the displaced back face lands at the same view Z as the
    // body's front face, or nearer. The body then loses (or ties) the LessEqual
    // depth test and the shell covers it, which is why round 5's first pass
    // photographed as red wireframe scribbles with the board visible through
    // them. Biasing the shell half a body-radius further away guarantees the
    // body always wins its own interior, so the shell survives only where the
    // body does not cover it — which is the definition of a silhouette.
    this.outlineMaterial.uniforms.uZBias.value = -0.55;
    // ZERO, AND IT MUST STAY ZERO. Round 4 ran the x-ray hull at 0.0013 and
    // that single number is why three blind critics could not see a unit:
    // inflating a hull outward moves every fragment toward its own silhouette,
    // which on a convex surface is its FARTHEST point, so an inflated hull is
    // behind its own body at every pixel and `depthFunc = GreaterDepth` passes
    // over the whole creep whether or not anything is occluding it. The pass
    // was painting a translucent coloured sheet over every unit on the board.
    // Full writeup in creeps/silhouette.js. The bias below replaces it: it
    // pushes the shell a hair toward the camera so equal depth reliably FAILS
    // and only a genuine occluder lets the pass through.
    this.xrayMaterial.uniforms.uInflate.value = 0.0;
    this.xrayMaterial.uniforms.uZBias.value = 0.06;

    this.archetypes = {};
    for (const [key, build] of Object.entries(ARCHETYPE_BUILDERS)) {
      const geo = build();
      const mesh = new THREE.InstancedMesh(geo, this.material, this.capacity);
      mesh.customDepthMaterial = this.depthMaterial;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.count = 0;

      const colors = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
      const extra = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
      for (const a of [colors, extra, anim]) a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('instanceColor', colors);
      geo.setAttribute('instanceExtra', extra); // hitFlash, hp01, phase, statusMask
      geo.setAttribute('instanceAnim', anim);   // speed01, lean, stagger, spawn01

      // Silhouette shells. They share `geo` and `mesh.instanceMatrix`, so the
      // only per-frame work they add is keeping `.count` in step.
      const { outline, xray } = makeShells(mesh, this.outlineMaterial, this.xrayMaterial);

      this.archetypes[key] = { mesh, outline, xray, colors, extra, anim, indices: [] };
      this.group.add(outline);
      this.group.add(mesh);
      this.group.add(xray);
    }

    this.healthBars = new HealthBarField(this.capacity);
    this.group.add(this.healthBars.mesh);

    this.contact = new ContactField(this.capacity);
    this.group.add(this.contact.mesh);

    this.particles = new ParticleField(1100);
    this.group.add(this.particles.mesh);

    this.gibs = new GibField(420);
    this.group.add(this.gibs.mesh);
  }

  // ---- lifecycle ---------------------------------------------------------

  /**
   * @param {string} typeKey
   * @param {number} hp
   * @param {number} bounty
   * @param {number} offset spawn stagger along -Z
   * @param {number} [tint] optional sRGB hex overriding the archetype colour.
   *   Waves.js can pass the wave's element colour so a whole wave reads as one
   *   glowing mass (the Element TD 2 trick). Omit for the archetype default.
   */
  spawn(typeKey, hp, bounty, offset = 0, tint) {
    if (!this.freeList.length) return -1;
    const i = this.freeList.pop();
    const t = CREEP_TYPES[typeKey];
    const g = this.grid;

    const sx = (g.spawn.c - g.cols / 2 + 1.0) * g.cell + (Math.random() - 0.5) * 2.2;
    const sz = (-g.rows / 2 + 0.4) * g.cell - offset;

    this.alive[i] = 1;
    this.x[i] = sx;
    this.z[i] = sz;
    this.y[i] = t.flying ? 2.8 : 0;
    this.vx[i] = 0; this.vz[i] = t.speed;
    this.maxHp[i] = hp; this.hp[i] = hp; this.hpGhost[i] = 1;
    this.baseSpeed[i] = t.speed * (0.95 + Math.random() * 0.1);
    this.speed[i] = this.baseSpeed[i];
    this.armor[i] = t.armor;
    this.scale[i] = t.scale * (0.94 + Math.random() * 0.12);
    this.yaw[i] = 0;
    this.lean[i] = 0;
    this.stagger[i] = 0;
    this.spawnT[i] = 0;
    this.phase[i] = Math.random() * Math.PI * 2;
    this.stepPhase[i] = 0;
    const ti = this.typeKeys.indexOf(typeKey);
    this.typeIdx[i] = ti;
    this.flying[i] = t.flying ? 1 : 0;
    this.bounty[i] = bounty;
    this.slowT[i] = 0; this.slowAmt[i] = 0;
    this.burnT[i] = 0; this.burnDps[i] = 0;
    this.poisonT[i] = 0; this.poisonDps[i] = 0;
    this.hitFlash[i] = 0;
    this.progress[i] = 0;

    if (tint === undefined) {
      const c = this._typeColorLinear[ti];
      this.tint[i * 3] = c[0]; this.tint[i * 3 + 1] = c[1]; this.tint[i * 3 + 2] = c[2];
    } else {
      TMP_COLOR.setHex(tint).convertSRGBToLinear();
      this.tint[i * 3] = TMP_COLOR.r;
      this.tint[i * 3 + 1] = TMP_COLOR.g;
      this.tint[i * 3 + 2] = TMP_COLOR.b;
    }

    this._live[this._liveCount++] = i;
    this.count++;

    // Arrival puff so nothing pops into existence.
    this.#emitSpawnFx(i, t);
    return i;
  }

  kill(i, credited = true) {
    if (!this.alive[i]) return;
    this.#emitDeathFx(i, credited);
    this.alive[i] = 0;
    this.count--;
    this.freeList.push(i);
    if (credited && this.onDeath) {
      this.onDeath(i, this.x[i], this.y[i], this.z[i], this.bounty[i], this.typeKeys[this.typeIdx[i]]);
    }
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.flash=true] set false for damage-over-time ticks —
   *   otherwise a burning creep re-flashes every frame and blows out to a
   *   featureless white blob.
   */
  damage(i, amount, { armorPen = 0, type = 'physical', flash = true } = {}) {
    if (!this.alive[i]) return 0;
    const armor = Math.max(0, this.armor[i] - armorPen);
    const mult = type === 'pure' ? 1 : 1 - (armor * 0.06) / (1 + armor * 0.06);
    const dealt = Math.min(this.hp[i], amount * mult);
    this.hp[i] -= dealt;
    if (flash) {
      this.hitFlash[i] = 1;
      // Weight: a real hit knocks the body back. Big units shrug it off.
      const impact = Math.min(0.9, (dealt / this.maxHp[i]) * 6);
      this.stagger[i] = Math.min(1, this.stagger[i] + impact / (0.6 + this.scale[i]));
    }
    if (this.hp[i] <= 0) this.kill(i);
    return dealt;
  }

  applySlow(i, amount, duration) {
    if (!this.alive[i]) return;
    if (amount >= this.slowAmt[i] || this.slowT[i] <= 0) {
      this.slowAmt[i] = Math.max(this.slowAmt[i], amount);
      this.slowT[i] = Math.max(this.slowT[i], duration);
    }
  }

  applyBurn(i, dps, duration) {
    if (!this.alive[i]) return;
    this.burnDps[i] = Math.max(this.burnDps[i], dps);
    this.burnT[i] = Math.max(this.burnT[i], duration);
  }

  /** Additive status (green pulse + drip). Safe to ignore by callers. */
  applyPoison(i, dps, duration) {
    if (!this.alive[i]) return;
    this.poisonDps[i] = Math.max(this.poisonDps[i], dps);
    this.poisonT[i] = Math.max(this.poisonT[i], duration);
  }

  // ---- spatial hash ------------------------------------------------------
  #key(cx, cz) { return (cx + 2048) * 4096 + (cz + 2048); }

  rebuildHash() {
    for (const k of this._usedKeys) {
      const a = this.hash.get(k);
      if (a) a.length = 0;
    }
    this._usedKeys.length = 0;
    const cs = this.cellSize;
    for (let n = 0; n < this._liveCount; n++) {
      const i = this._live[n];
      const k = this.#key(Math.floor(this.x[i] / cs), Math.floor(this.z[i] / cs));
      let arr = this.hash.get(k);
      if (!arr) { arr = []; this.hash.set(k, arr); }
      if (arr.length === 0) this._usedKeys.push(k);
      arr.push(i);
    }
  }

  /** Collect creep indices within `radius` of (x,z). */
  query(x, z, radius, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    const cs = this.cellSize;
    const c0 = Math.floor((x - radius) / cs), c1 = Math.floor((x + radius) / cs);
    const r0 = Math.floor((z - radius) / cs), r1 = Math.floor((z + radius) / cs);
    for (let cr = r0; cr <= r1; cr++) {
      for (let cc = c0; cc <= c1; cc++) {
        const arr = this.hash.get(this.#key(cc, cr));
        if (!arr || arr.length === 0) continue;
        for (let n = 0; n < arr.length; n++) {
          const i = arr[n];
          const dx = this.x[i] - x, dz = this.z[i] - z;
          if (dx * dx + dz * dz <= r2) out.push(i);
        }
      }
    }
    return out;
  }

  /**
   * Is a walking creep standing inside the 2x2 tower footprint anchored at
   * (c,r)? Placement asks before stamping the cells as wall.
   *
   * A ground creep whose CENTRE ends up inside a tower is trapped for good: the
   * flow field is zero on unwalkable cells, and the collision guard in update()
   * refuses every move whose destination is unwalkable — including the move
   * that would carry it back out. It never reaches the leak plane, never
   * despawns, and the wave never ends. Flyers are exempt: they ignore both the
   * field and the guard, so a tower under one is harmless.
   */
  blockedByFootprint(c, r) {
    const g = this.grid;
    const cell = {};
    for (let n = 0; n < this._liveCount; n++) {
      const i = this._live[n];
      if (!this.alive[i] || this.flying[i]) continue;
      g.worldToCell(this.x[i], this.z[i], cell);
      if (cell.c >= c && cell.c < c + 2 && cell.r >= r && cell.r < r + 2) return true;
    }
    return false;
  }

  /**
   * Steer a creep that is standing on unwalkable ground back to the nearest
   * walkable cell. Returns false when there is nothing to escape.
   *
   * Placement now refuses to wall a creep in, so this should never fire — but
   * "should never" is exactly how the last two jams read, and the failure mode
   * is a frozen wave rather than a cosmetic glitch. Any future path into a wall
   * (a terrain edit, a rounding case on a footprint boundary) self-heals in a
   * few frames instead of ending the run.
   */
  #escape(i, out) {
    const g = this.grid;
    const cell = g.worldToCell(this.x[i], this.z[i], {});
    if (g.isWalkable(cell.c, cell.r)) return false;

    let bestD2 = Infinity, bx = 0, bz = 0;
    const target = {};
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (!dc && !dr) continue;
        const nc = cell.c + dc, nr = cell.r + dr;
        if (!g.isWalkable(nc, nr)) continue;
        g.cellToWorld(nc, nr, target);
        const ox = target.x - this.x[i], oz = target.z - this.z[i];
        const d2 = ox * ox + oz * oz;
        if (d2 < bestD2) { bestD2 = d2; bx = ox; bz = oz; }
      }
    }
    if (bestD2 === Infinity) return false;
    const l = Math.hypot(bx, bz) || 1;
    out.x = bx / l; out.z = bz / l;
    return true;
  }

  // ---- simulation --------------------------------------------------------

  update(dt) {
    const g = this.grid;
    // The far edge of the board. Flying creeps steer at it; nothing may be
    // asked to REACH it (see leakZ).
    const exitZ = (g.rows / 2) * g.cell;
    // The plane a creep crosses to count as leaked: the centre of the last row.
    //
    // This used to be `exitZ` itself, one full half-cell further out, and that
    // is a place a creep can never legally stand. The out-of-bounds guard below
    // resolves `worldToCell(x, exitZ).r` to `rows`, which is not walkable, so it
    // clamps the creep back inside — the leak test sat beyond a wall the same
    // update loop enforces. Combined with the zero flow vector on the goal cells
    // (fixed in Pathfinder.#buildFlow), creeps parked at the exit forever: no
    // life lost, no despawn, and the queue behind them jammed.
    const leakZ = exitZ - g.cell * 0.5;
    const neighbours = this._neighbours;
    this.time += dt;

    for (let n = 0; n < this._liveCount; n++) {
      const i = this._live[n];
      if (!this.alive[i]) continue;
      const t = CREEP_TYPES[this.typeKeys[this.typeIdx[i]]];

      // --- status effects ---
      if (this.slowT[i] > 0) {
        this.slowT[i] -= dt;
        if (this.slowT[i] <= 0) this.slowAmt[i] = 0;
      }
      if (this.burnT[i] > 0) {
        this.burnT[i] -= dt;
        this.damage(i, this.burnDps[i] * dt, { type: 'pure', flash: false });
        if (!this.alive[i]) continue;
        if (this.burnT[i] <= 0) this.burnDps[i] = 0;
      }
      if (this.poisonT[i] > 0) {
        this.poisonT[i] -= dt;
        this.damage(i, this.poisonDps[i] * dt, { type: 'pure', flash: false });
        if (!this.alive[i]) continue;
        if (this.poisonT[i] <= 0) this.poisonDps[i] = 0;
      }
      this.hitFlash[i] = Math.max(0, this.hitFlash[i] - dt * 4.5);
      this.stagger[i] = Math.max(0, this.stagger[i] - dt * 3.4);
      this.spawnT[i] = Math.min(1, this.spawnT[i] + dt * 2.6);
      this.speed[i] = this.baseSpeed[i] * (1 - this.slowAmt[i]);

      // Health bar damage-lag ghost.
      const hp01 = this.hp[i] / this.maxHp[i];
      this.hpGhost[i] = Math.max(hp01, this.hpGhost[i] - dt * 0.55);

      // --- steering ---
      let dx, dz;
      const escaping = !this.flying[i] && this.#escape(i, this._dir);
      if (this.flying[i]) {
        const tx = (g.goal.c - g.cols / 2 + 1.0) * g.cell;
        dx = tx - this.x[i];
        dz = exitZ - this.z[i];
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
      } else if (escaping) {
        // Standing in a wall: head straight for open ground, no flow field and
        // no separation — those are what keep it pinned.
        dx = this._dir.x; dz = this._dir.z;
      } else {
        this.path.sample(this.x[i], this.z[i], this._dir);
        dx = this._dir.x; dz = this._dir.z;

        this.query(this.x[i], this.z[i], 1.5, neighbours);
        let sx = 0, sz = 0;
        for (let q = 0; q < neighbours.length; q++) {
          const j = neighbours[q];
          if (j === i) continue;
          const ox = this.x[i] - this.x[j];
          const oz = this.z[i] - this.z[j];
          const d2 = ox * ox + oz * oz;
          if (d2 < 1e-4) continue;
          const w = 1 / d2;
          sx += ox * w; sz += oz * w;
        }
        const sl = Math.hypot(sx, sz);
        if (sl > 1e-4) { dx += (sx / sl) * 0.55; dz += (sz / sl) * 0.55; }
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
      }

      const targetVx = dx * this.speed[i];
      const targetVz = dz * this.speed[i];
      const k = 1 - Math.exp(-dt * 9);
      this.vx[i] += (targetVx - this.vx[i]) * k;
      this.vz[i] += (targetVz - this.vz[i]) * k;

      let nx = this.x[i] + this.vx[i] * dt;
      let nz = this.z[i] + this.vz[i] * dt;

      if (escaping) {
        // The guard below refuses any step whose destination is unwalkable —
        // which, for a creep already inside a wall, includes every step of the
        // half-cell walk back to open ground. Escaping moves are allowed as long
        // as they stay on the board; they cannot make things worse.
        const cell = g.worldToCell(nx, nz, {});
        if (!g.inBounds(cell.c, cell.r)) { nx = this.x[i]; nz = this.z[i]; }
      } else if (!this.flying[i]) {
        const cell = g.worldToCell(nx, nz, {});
        if (!g.isWalkable(cell.c, cell.r)) {
          const cellX = g.worldToCell(nx, this.z[i], {});
          const cellZ = g.worldToCell(this.x[i], nz, {});
          if (g.isWalkable(cellX.c, cellX.r)) { nz = this.z[i]; this.vz[i] *= -0.2; }
          else if (g.isWalkable(cellZ.c, cellZ.r)) { nx = this.x[i]; this.vx[i] *= -0.2; }
          else { nx = this.x[i]; nz = this.z[i]; }
        }
      }

      this.x[i] = nx;
      this.z[i] = nz;

      // --- gait -----------------------------------------------------------
      const actual = Math.hypot(this.vx[i], this.vz[i]);
      const speed01 = actual / (t.speed || 1);
      // Stride frequency follows real ground speed, so slowed creeps trudge
      // and nothing ever slides.
      const strideHz = this.flying[i]
        ? 4.4 + speed01 * 2.4
        : (7.4 + speed01 * 4.2) / Math.max(0.55, this.scale[i]);
      const prevPhase = this.phase[i];
      this.phase[i] += dt * strideHz;

      const groundY = this.surfaceHeightAt(this.x[i], this.z[i]);
      this.groundY[i] = groundY;
      if (this.flying[i]) {
        this.y[i] = groundY + 2.8 + Math.sin(this.phase[i] * 0.42) * 0.34
          + Math.sin(this.phase[i]) * 0.06;
      } else {
        // Two footfalls per stride: |sin| bob, low on contact.
        this.y[i] = groundY
          + Math.abs(Math.sin(this.phase[i])) * 0.10 * this.scale[i] * (0.4 + speed01);
      }

      // Footfall detection -> dust + heavy-unit ground marks.
      if (!this.flying[i]) {
        const a = Math.floor(prevPhase / Math.PI);
        const b = Math.floor(this.phase[i] / Math.PI);
        if (b !== a) this.#footfall(i, t, speed01);
      }

      // Face travel direction, smoothed; bank into the turn.
      const targetYaw = Math.atan2(this.vx[i], this.vz[i]);
      let diff = targetYaw - this.yaw[i];
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const turn = diff * (1 - Math.exp(-dt * 12));
      this.yaw[i] += turn;
      const leanTarget = THREE.MathUtils.clamp(
        (turn / Math.max(dt, 1e-4)) * (this.flying[i] ? 0.30 : 0.11), -0.8, 0.8,
      );
      this.lean[i] += (leanTarget - this.lean[i]) * (1 - Math.exp(-dt * 7));

      this.progress[i] = -this.path.costAt(this.x[i], this.z[i]);

      // --- boss presence ---------------------------------------------------
      if (t.boss) this.#bossAmbience(i, dt);
      else if (Math.random() < dt * 2.4) this.#moteTick(i, t);
      if (this.burnT[i] > 0 && Math.random() < dt * 22) this.#emberTick(i, t);

      if (this.z[i] >= leakZ) {
        if (this.onLeak) this.onLeak(i, this.typeKeys[this.typeIdx[i]]);
        this.kill(i, false);
      }
    }

    // Compact the live list.
    let w = 0;
    for (let n = 0; n < this._liveCount; n++) {
      const i = this._live[n];
      if (this.alive[i]) this._live[w++] = i;
    }
    this._liveCount = w;

    this.rebuildHash();
    this.#writeInstances();

    this.particles.update(dt);
    this.gibs.update(dt);

    const sh = this.material.userData.shader;
    if (sh) sh.uniforms.uTime.value = this.time;
    this.outlineMaterial.uniforms.uTime.value = this.time;
    this.xrayMaterial.uniforms.uTime.value = this.time;
  }

  // ---- FX ---------------------------------------------------------------

  #emitSpawnFx(i, t) {
    const r = this.tint[i * 3], g = this.tint[i * 3 + 1], b = this.tint[i * 3 + 2];
    const s = this.scale[i];
    const n = t.boss ? 14 : 4;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * 6.283;
      this.particles.emit(
        PK.EMBER,
        this.x[i] + Math.cos(a) * 0.4 * s, this.y[i] + 0.3 + Math.random() * t.height * s,
        this.z[i] + Math.sin(a) * 0.4 * s,
        Math.cos(a) * 1.2, 1.2 + Math.random() * 2, Math.sin(a) * 1.2,
        0.10 * s, 0.45 + Math.random() * 0.3, r, g, b,
      );
    }
  }

  #footfall(i, t, speed01) {
    if (speed01 < 0.15) return;
    const heavy = t.boss || t.mesh === 'brute';
    if (!heavy && Math.random() > 0.7) return;
    const s = this.scale[i];
    const r = this.tint[i * 3], g = this.tint[i * 3 + 1], b = this.tint[i * 3 + 2];
    const gy = this.groundY[i];
    // Dust is kicked BACKWARD along the direction of travel and left behind, so
    // a marching column drags a visible wake. The wake is a second, redundant
    // direction cue that works even when the unit itself is a 40px shape.
    const vl = Math.hypot(this.vx[i], this.vz[i]) || 1;
    const bx = -this.vx[i] / vl, bz = -this.vz[i] / vl;
    this.particles.emit(
      PK.SMOKE,
      this.x[i] + bx * 0.35 * s, gy + 0.10, this.z[i] + bz * 0.35 * s,
      bx * 1.5 + (Math.random() - 0.5) * 0.5, 0.30,
      bz * 1.5 + (Math.random() - 0.5) * 0.5,
      0.22 * s * (heavy ? 2.0 : 1.0), heavy ? 0.95 : 0.60,
      // Pale, warm dust: it has to be lighter than the stone to be seen at all.
      0.62, 0.55, 0.47, 0.85 * s,
    );
    if (t.boss) {
      // Cracked ground: a dark scorch print plus a rune flash.
      this.particles.emit(
        PK.SCORCH, this.x[i], gy + 0.03, this.z[i], 0, 0, 0,
        1.1 * s, 5.5, 0.10, 0.08, 0.08,
      );
      this.particles.emit(
        PK.RUNE, this.x[i], gy + 0.04, this.z[i], 0, 0, 0,
        1.4 * s, 0.6, r, g, b, 2.4,
      );
    }
  }

  /**
   * A slow drift of element-coloured motes off every living creep. Third
   * countability cue after the outline and the ground pool, and the cheapest:
   * the shipped game surrounds its creeps with small bright sparks, and a mote
   * that has drifted clear of a tower is still evidence of a unit behind it.
   * ~2.4/s per creep, ~0.9s life => under 70 live particles at a 30-unit wave.
   */
  #moteTick(i, t) {
    const s = this.scale[i];
    const r = this.tint[i * 3], g = this.tint[i * 3 + 1], b = this.tint[i * 3 + 2];
    const a = Math.random() * 6.283;
    this.particles.emit(
      PK.EMBER,
      this.x[i] + Math.cos(a) * 0.42 * s,
      this.y[i] + 0.25 + Math.random() * t.height * s * 0.9,
      this.z[i] + Math.sin(a) * 0.42 * s,
      Math.cos(a) * 0.25, 0.9 + Math.random() * 1.1, Math.sin(a) * 0.25,
      0.075 * s, 0.7 + Math.random() * 0.5, r * 1.5, g * 1.5, b * 1.5,
    );
  }

  #bossAmbience(i, dt) {
    const s = this.scale[i];
    const r = this.tint[i * 3], g = this.tint[i * 3 + 1], b = this.tint[i * 3 + 2];
    if (Math.random() < dt * 26) {
      this.particles.emit(
        PK.SMOKE,
        this.x[i] + (Math.random() - 0.5) * 1.2 * s,
        0.6 + Math.random() * 2.4 * s,
        this.z[i] + (Math.random() - 0.5) * 1.2 * s,
        (Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.7, (Math.random() - 0.5) * 0.5,
        0.55 * s, 1.5 + Math.random(), 0.16, 0.14, 0.16, 0.7 * s,
      );
    }
    if (Math.random() < dt * 14) {
      const a = Math.random() * 6.283;
      this.particles.emit(
        PK.EMBER,
        this.x[i] + Math.cos(a) * 0.9 * s, 0.4 + Math.random() * 2.2 * s,
        this.z[i] + Math.sin(a) * 0.9 * s,
        Math.cos(a) * 0.3, 1.4 + Math.random() * 1.6, Math.sin(a) * 0.3,
        0.13 * s, 1.0 + Math.random() * 0.6, r, g, b,
      );
    }
  }

  #emberTick(i, t) {
    const s = this.scale[i];
    this.particles.emit(
      PK.EMBER,
      this.x[i] + (Math.random() - 0.5) * 0.5 * s,
      this.y[i] + Math.random() * t.height * s,
      this.z[i] + (Math.random() - 0.5) * 0.5 * s,
      (Math.random() - 0.5) * 0.6, 1.6 + Math.random() * 1.8, (Math.random() - 0.5) * 0.6,
      0.09 * s, 0.5 + Math.random() * 0.4, 1.6, 0.55, 0.12,
    );
  }

  /**
   * Death is an event, not a disappearance. The treatment follows how the unit
   * died and what it was: frozen units shatter into ice, burning units come
   * apart in embers and smoke, armour throws heavy plate shards, swarm units
   * burst, flyers dissolve upward into motes.
   */
  #emitDeathFx(i, credited) {
    const t = CREEP_TYPES[this.typeKeys[this.typeIdx[i]]];
    const s = this.scale[i];
    const x = this.x[i], y = this.y[i], z = this.z[i];
    const r = this.tint[i * 3], g = this.tint[i * 3 + 1], b = this.tint[i * 3 + 2];
    const frozen = this.slowT[i] > 0;
    const burning = this.burnT[i] > 0;
    const h = t.height * s;

    if (!credited) return; // leaked: it walked off the board, no corpse

    // Shard colour: ice reads white-blue, everything else keeps its rim colour.
    const sr = frozen ? 0.55 : r, sg = frozen ? 0.85 : g, sb = frozen ? 1.35 : b;

    let shards = 6;
    let speedUp = 3.2, spread = 2.6, shardSize = 0.13;
    if (t.boss) { shards = 34; speedUp = 6.5; spread = 5.5; shardSize = 0.30; }
    else if (t.mesh === 'brute') { shards = 14; shardSize = 0.19; }
    else if (t.mesh === 'mite') { shards = 5; shardSize = 0.09; spread = 3.4; }
    else if (t.flying) { shards = 4; shardSize = 0.10; }
    if (frozen) shards = Math.round(shards * 1.7);
    if (burning) shards = Math.round(shards * 0.6);

    const gy = this.groundY[i];
    for (let k = 0; k < shards; k++) {
      const a = Math.random() * 6.283;
      const rr = Math.random();
      this.gibs.emit(
        x + Math.cos(a) * 0.25 * s, y + 0.25 + Math.random() * h * 0.8, z + Math.sin(a) * 0.25 * s,
        Math.cos(a) * spread * (0.35 + rr), speedUp * (0.4 + Math.random()), Math.sin(a) * spread * (0.35 + rr),
        shardSize * s * (0.7 + Math.random() * 0.7), 1.1 + Math.random() * 0.9,
        sr, sg, sb, gy,
      );
    }

    // Burst of light at the moment of death.
    const motes = t.boss ? 40 : t.mesh === 'mite' ? 7 : 14;
    for (let k = 0; k < motes; k++) {
      const a = Math.random() * 6.283;
      const up = t.flying ? 2.4 + Math.random() * 2.6 : 1.4 + Math.random() * 3.2;
      this.particles.emit(
        PK.EMBER,
        x + Math.cos(a) * 0.3 * s, y + 0.3 + Math.random() * h * 0.9, z + Math.sin(a) * 0.3 * s,
        Math.cos(a) * (t.boss ? 4.5 : 2.6) * Math.random(), up, Math.sin(a) * (t.boss ? 4.5 : 2.6) * Math.random(),
        (t.boss ? 0.24 : 0.11) * s, 0.55 + Math.random() * 0.7,
        burning ? 1.8 : sr, burning ? 0.6 : sg, burning ? 0.12 : sb,
      );
    }

    // Smoke / dust body.
    const puffs = t.boss ? 16 : t.mesh === 'mite' ? 2 : 5;
    for (let k = 0; k < puffs; k++) {
      this.particles.emit(
        PK.SMOKE,
        x + (Math.random() - 0.5) * 0.7 * s, y + 0.2 + Math.random() * h * 0.6, z + (Math.random() - 0.5) * 0.7 * s,
        (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.8, (Math.random() - 0.5) * 1.2,
        0.30 * s * (t.boss ? 2.2 : 1), (t.boss ? 2.2 : 1.1) + Math.random() * 0.6,
        0.22, 0.20, 0.21, 0.9 * s,
      );
    }

    // Lingering ground mark. Flyers leave nothing — they never touched it.
    if (!t.flying) {
      this.particles.emit(
        PK.SCORCH, x, gy + 0.03, z, 0, 0, 0,
        (t.boss ? 2.6 : 0.62) * s, t.boss ? 14 : 7, 0.09, 0.07, 0.07,
      );
      this.particles.emit(
        PK.RUNE, x, gy + 0.045, z, 0, 0, 0,
        (t.boss ? 3.4 : 0.9) * s, t.boss ? 1.1 : 0.5, sr, sg, sb, t.boss ? 7 : 2.6,
      );
    }
  }

  // ---- rendering ---------------------------------------------------------

  #writeInstances() {
    for (const a of Object.values(this.archetypes)) a.indices.length = 0;

    for (let n = 0; n < this._liveCount; n++) {
      const i = this._live[n];
      const t = CREEP_TYPES[this.typeKeys[this.typeIdx[i]]];
      this.archetypes[t.mesh].indices.push(i);
    }

    let barCount = 0;
    let contactCount = 0;
    for (const a of Object.values(this.archetypes)) {
      const { mesh, outline, xray, colors, extra, anim, indices } = a;
      const cArr = colors.array, eArr = extra.array, aArr = anim.array;
      for (let n = 0; n < indices.length; n++) {
        const i = indices[n];
        const t = CREEP_TYPES[this.typeKeys[this.typeIdx[i]]];
        const s = this.scale[i];
        const sp = this.spawnT[i];
        // Ease-out-back spawn pop, then settle.
        const spawnScale = sp >= 1 ? 1 : 0.25 + 0.75 * (1 - Math.pow(1 - sp, 3));

        this._tmpPos.set(this.x[i], this.y[i], this.z[i]);
        this._tmpQuat.setFromAxisAngle(UP, this.yaw[i]);

        // Squash-and-stretch coupled to the actual bob: compress on contact,
        // stretch at the top of the stride.
        const bob = Math.sin(this.phase[i] * 2) * 0.055
          * (this.flying[i] ? 0.4 : 1) * Math.min(1, this.speed[i] / (t.speed || 1) + 0.25);
        const sc = s * spawnScale;
        this._tmpScale.set(sc * (1 - bob * 0.55), sc * (1 + bob), sc * (1 - bob * 0.55));
        this._tmpMat.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
        mesh.setMatrixAt(n, this._tmpMat);

        const r = this.tint[i * 3], gg = this.tint[i * 3 + 1], bb = this.tint[i * 3 + 2];
        cArr[n * 3] = r; cArr[n * 3 + 1] = gg; cArr[n * 3 + 2] = bb;

        const hp01 = this.hp[i] / this.maxHp[i];
        let mask = 0;
        if (this.slowT[i] > 0) mask += 1;
        if (this.burnT[i] > 0) mask += 2;
        if (this.poisonT[i] > 0) mask += 4;
        if (t.boss) mask += 8;
        eArr[n * 4] = this.hitFlash[i];
        eArr[n * 4 + 1] = hp01;
        eArr[n * 4 + 2] = this.phase[i];
        eArr[n * 4 + 3] = mask;

        aArr[n * 4] = Math.hypot(this.vx[i], this.vz[i]) / (t.speed || 1);
        aArr[n * 4 + 1] = this.lean[i];
        aArr[n * 4 + 2] = this.stagger[i];
        aArr[n * 4 + 3] = sp;

        // Ground contact: a soft dark shadow pool with an element-coloured
        // leading crescent. Two jobs — it plants the unit on the floor, and
        // its bright end points the way the unit is walking.
        // ROUND 4: the pool is the occlusion-proof half of gate G4 — towers are
        // now 2.5-3.5 cells tall and a creep behind one is gone, but its pool is
        // on the ground plane and wider than its body, so it still reads.
        const glow = 1.75 + this.hitFlash[i] * 1.0 + (t.boss ? 1.1 : 0);
        const vl = Math.hypot(this.vx[i], this.vz[i]);
        const dxn = vl > 1e-3 ? this.vx[i] / vl : Math.sin(this.yaw[i]);
        const dzn = vl > 1e-3 ? this.vz[i] / vl : Math.cos(this.yaw[i]);
        // ROUND 5: the radius comes DOWN hard (2.9x -> 1.15x the body radius).
        // A shadow that is three times wider than the thing casting it is a
        // haze, not a contact — it reads as one more coloured wash on a board
        // that already has twenty of them, which is exactly how the round-4
        // version was described. A hard ellipse roughly the width of the unit's
        // stance is what says "this object is resting on that surface".
        this.contact.set(
          contactCount++, this.x[i], this.y[i], this.z[i],
          t.radius * s * (t.boss ? 1.05 : 1.30), r, gg, bb, glow,
          dxn, dzn, 1.0 + Math.min(0.85, vl / (t.speed || 1) * 0.75), this.groundY[i],
        );

        // Health bar: only once damaged, fading back out when healed/topped.
        if (hp01 < 0.995 || this.hpGhost[i] > hp01 + 0.01) {
          const alpha = THREE.MathUtils.clamp((1 - hp01) * 6, 0, 1);
          this.healthBars.set(
            barCount++, this.x[i], this.y[i] + t.height * s + 0.42, this.z[i],
            hp01, this.hpGhost[i], t.boss ? 1 : 0, alpha,
          );
        }
      }
      mesh.count = indices.length;
      outline.count = indices.length;
      // Triangle budget guard. Shipped waves cap at 30 units (Waves.js), where
      // the two shells cost ~44k triangles of a 900k budget — measured. The
      // `creepstress` bench pushes 320 units, an order of magnitude past
      // anything the game can produce, and there the third pass is the
      // difference between fitting and not. The outline is never dropped: it is
      // the primary G4 cue. The x-ray only matters when a tower hides a unit,
      // and at 150+ units on the board there is no hiding anything.
      xray.count = this._liveCount > 150 ? 0 : indices.length;
      mesh.instanceMatrix.needsUpdate = true;
      colors.needsUpdate = true;
      extra.needsUpdate = true;
      anim.needsUpdate = true;
    }
    this.healthBars.commit(barCount);
    this.contact.commit(contactCount);
  }

  /** Highest-progress creep in range — the classic "first" targeting rule. */
  findTarget(x, z, range, { allowGround = true, allowAir = true, mode = 'first' } = {}) {
    const list = this.query(x, z, range, []);
    let best = -1, bestScore = -Infinity;
    for (const i of list) {
      if (this.flying[i] && !allowAir) continue;
      if (!this.flying[i] && !allowGround) continue;
      let score;
      switch (mode) {
        case 'strong': score = this.hp[i]; break;
        case 'weak': score = -this.hp[i]; break;
        case 'close': score = -((this.x[i] - x) ** 2 + (this.z[i] - z) ** 2); break;
        default: score = this.progress[i];
      }
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }
}

const TMP_COLOR = new THREE.Color();
