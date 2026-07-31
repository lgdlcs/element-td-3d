import * as THREE from 'three';
import { createTowerMaterial, createGroundGlowMaterial, createRuneMaterial } from '../../render/materials/TowerMaterial.js';
import { buildTowerSpec } from './TowerArchetypes.js';

/**
 * The tower renderer.
 *
 * Every tower on the board — foundations, shafts, collars, rotating heads,
 * upgrade halos and orbiting shards — is drawn by ONE THREE.BatchedMesh, so
 * the whole board costs a single draw call per pass no matter how many towers
 * exist or how many independently animated sub-parts each one has. That is
 * what buys us the moving-parts budget: an orbiting shard is free.
 *
 * Two more single-draw-call layers sit alongside it:
 *   - the additive ground glow (the element-coloured pool of light on the
 *     tower's own tile, which is how a maze's composition reads at a glance)
 *   - the floating element runes
 *
 * Coloured light spill is faked by that decal for every tower, and *promoted*
 * to a real PointLight for the four most active towers via a fixed-size pool,
 * so the shader's light count — and therefore the program count — is constant.
 */

/**
 * How many towers get a REAL point light at once.
 *
 * Four was not enough across a 21-tower board: the Art Director's verdict was
 * "nothing casts coloured light... in a shipped build those cores would be the
 * primary light source of the frame." Eight lights is still a constant, so the
 * shader program count does not move, and unlike the additive decal a real
 * light wraps the neighbouring towers' stonework as well as the floor — which
 * is what actually sells "the cores light the scene".
 *
 * ---------------------------------------------------------------------------
 * WHAT THAT VERDICT COST, MEASURED (2026-07-29)
 *
 * The raise from 4 to 8 was made on an art note, against still frames, with no
 * frame-time measurement anywhere in the loop. Each of these lights costs
 * **5.2-6.9 ms**, and all eight together cost **40.2 ms** — half of the entire
 * scene render (81.3 ms -> 41.2 ms on an M1 at 1600x900, post disabled).
 *
 * The reason is that a dynamic light is not charged to the object that owns it.
 * three.js compiles one lighting loop into every lit material, so each light
 * adds an iteration for **every lit pixel in the scene** — the ground, the
 * terrain, the backdrop, all of it. Eight lights doubled the shading cost of
 * every surface the camera can see, to illuminate 8 tiles.
 *
 * This is now a quality knob rather than a constant, so the trade is visible
 * and can be measured instead of assumed. See docs/PERF_BUDGET.md.
 */
const LIGHT_POOL_DEFAULT = 8;
/**
 * How far the additive glow decal floats above the terrain surface. Just enough
 * to clear the buildable plateau's raised tower kerbs without depth-fighting
 * them. This replaces round 1's hardcoded `GLOW_Y = 0.30`, which was tuned by
 * eye against terrain geometry that has changed twice since.
 */
const GLOW_LIFT = 0.14;
/**
 * The glow decal is a tessellated patch, not a single quad, and every vertex is
 * seated on the terrain by `heightAt`.
 *
 * Round 2 drew it as one flat quad at the height sampled under the tower's
 * centre. That was fine at a 3-unit radius on flat plateau; at the round-3
 * radius of 4.5-5.6 units the patch reaches well past the buildable tile onto
 * displaced ground, and a flat quad simply sank into the hillside — the pools
 * rendered as a few disconnected dashes where the terrain happened to dip below
 * them. 4x4 cells is 32 triangles per tower, ~670 for a full board, which is
 * noise against a 600k budget and is the difference between "no coloured light
 * anywhere" and a pool that follows the floor.
 */
const GLOW_CELLS = 8;
const RISE_TIME = 0.62;

export class TowerBatch {
  constructor(scene, quality = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'towers';
    scene.add(this.group);

    // Retuned after the key light moved (azimuth -48, elevation 40, 2.55 ->
    // 7.60) and the cool terms were halved. The board got 2.4x brighter but the
    // towers' shadow sides did not, so they were reading as flat black pawns;
    // the IBL term is what lifts an unlit facet back into readable value.
    this.material = createTowerMaterial(2.45);

    this._vertCap = 160000;
    this._instCap = 384;
    this._vertUsed = 0;
    this._instUsed = 0;

    this.mesh = new THREE.BatchedMesh(this._instCap, this._vertCap, 0, this.material);
    this.mesh.name = 'towerBatch';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.sortObjects = false;
    this.group.add(this.mesh);

    /** @type {Map<string, object>} spec + geometry ids per (key, level) */
    this.specs = new Map();

    // --- ground glow ------------------------------------------------------
    this.glowMat = createGroundGlowMaterial();
    this.glowMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.glowMat);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 3;
    this.glowMesh.visible = false;
    this.group.add(this.glowMesh);

    // --- runes ------------------------------------------------------------
    this.runeMat = createRuneMaterial();
    this.runeMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.runeMat);
    this.runeMesh.frustumCulled = false;
    this.runeMesh.renderOrder = 9;
    this.runeMesh.visible = false;
    this.group.add(this.runeMesh);

    // --- real light pool --------------------------------------------------
    this.lights = [];
    const poolSize = quality.towerLights ?? LIGHT_POOL_DEFAULT;
    for (let i = 0; i < poolSize; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 20, 2.0);
      l.castShadow = false;
      l.visible = true;
      l.position.set(0, -50, 0);
      this.group.add(l);
      this.lights.push({ light: l, towerId: -1, score: -1, level: 0 });
    }

    /** @type {?(x:number, z:number) => number} set via setHeightProvider */
    this.heightAt = null;

    // scratch
    this._m = new THREE.Matrix4();
    this._m2 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this._col = new THREE.Color();
  }

  /**
   * Install the terrain height query used to seat the ground glow. Swapping it
   * invalidates the baked decal layer, so the change takes effect on the next
   * frame without the caller having to know that.
   */
  setHeightProvider(fn) {
    if (fn === this.heightAt) return;
    this.heightAt = typeof fn === 'function' ? fn : null;
    this._layoutDirty = true;
  }

  // -------------------------------------------------------------------------
  // Geometry registry
  // -------------------------------------------------------------------------
  #ensureVertexRoom(n) {
    if (this._vertUsed + n <= this._vertCap) return;
    while (this._vertUsed + n > this._vertCap) this._vertCap *= 2;
    this.mesh.setGeometrySize(this._vertCap, 0);
  }

  #addGeo(geo) {
    if (!geo) return -1;
    const n = geo.attributes.position.count;
    this.#ensureVertexRoom(n);
    const id = this.mesh.addGeometry(geo);
    this._vertUsed += n;
    return id;
  }

  #spec(def, level) {
    const key = `${def.key}:${level}`;
    let s = this.specs.get(key);
    if (s) return s;
    const raw = buildTowerSpec(def, level);
    s = {
      ...raw,
      gBase: this.#addGeo(raw.base),
      gHead: this.#addGeo(raw.head),
      gCollar: this.#addGeo(raw.collar),
      gHalo: this.#addGeo(raw.halo),
      gShards: raw.shards.map((sh) => this.#addGeo(sh.geo)),
    };
    // The source geometries are now copied into the batch buffer.
    raw.base?.dispose(); raw.head?.dispose(); raw.collar?.dispose(); raw.halo?.dispose();
    for (const sh of raw.shards) sh.geo.dispose();
    this.specs.set(key, s);
    return s;
  }

  #addInstance(geoId) {
    if (geoId < 0) return -1;
    if (this._instUsed + 1 > this._instCap) {
      this._instCap *= 2;
      this.mesh.setInstanceCount(this._instCap);
    }
    this._instUsed++;
    const id = this.mesh.addInstance(geoId);
    this.mesh.setColorAt(id, this._col.setRGB(1, 1, 1));
    return id;
  }

  // -------------------------------------------------------------------------
  // Tower lifecycle
  // -------------------------------------------------------------------------
  attach(t) {
    const s = this.#spec(t.def, t.level);
    t.spec = s;
    t.inst = {
      base: this.#addInstance(s.gBase),
      head: this.#addInstance(s.gHead),
      collar: this.#addInstance(s.gCollar),
      halo: this.#addInstance(s.gHalo),
      shards: s.gShards.map((g) => this.#addInstance(g)),
    };
    // Foundations get a quarter-turn keyed to their grid position, so one cached
    // geometry yields four distinct blocks and a wall stops reading as a tiled
    // texture. Keyed on (c,r) rather than on `t.id` so a block keeps its
    // orientation across a save, a sell-and-rebuild, or an id renumbering —
    // orientation that shuffles when an unrelated tower is sold looks like a
    // glitch. Only quarter-turns: the footprint is square and the shadows have to
    // stay aligned with the tile.
    t.baseYaw = s.inert
      ? (((t.c * 73856093) ^ (t.r * 19349663)) & 3) * Math.PI * 0.5
      : 0;
    t.rise = 0;
    t.baseDirty = true;
    this._layoutDirty = true;
  }

  /**
   * Seat a tower's base instance at height `y`.
   *
   * Was a bare makeTranslation in two places. It has to be able to carry the
   * foundation's quarter-turn as well, and doing that inline twice is how the
   * rise animation and the settled state end up disagreeing about orientation —
   * the block would spin as it finished rising.
   */
  #seatBase(t, y) {
    if (t.inst.base < 0) return;
    if (t.baseYaw) {
      this._e.set(0, t.baseYaw, 0, 'YXZ');
      this._q.setFromEuler(this._e);
      this._v.set(t.x, y, t.z);
      this._s.setScalar(1);
      this._m.compose(this._v, this._q, this._s);
    } else {
      this._m.makeTranslation(t.x, y, t.z);
    }
    this.mesh.setMatrixAt(t.inst.base, this._m);
  }

  detach(t) {
    if (!t.inst) return;
    const rm = (id) => { if (id >= 0) { this.mesh.deleteInstance(id); this._instUsed--; } };
    rm(t.inst.base); rm(t.inst.head); rm(t.inst.collar); rm(t.inst.halo);
    for (const id of t.inst.shards) rm(id);
    t.inst = null;
    this._layoutDirty = true;
  }

  /** Rebuild the additive decal + rune layers. Cheap; only on board changes. */
  rebuildOverlays(allTowers) {
    this._layoutDirty = false;
    // Foundations carry no glow pool and no floating rune (see
    // buildFoundationSpec), so they are excluded from both layers rather than
    // emitted with zero intensity — a zero-intensity patch still costs 4 world
    // units of additive fill per block, and a maze is dozens of blocks.
    //
    // Excluding them means the overlay buffers are indexed by a DIFFERENT
    // sequence than `towers`, so each tower carries the slot it was given here
    // and the per-frame loop uses that instead of its position in the array.
    // Without this the intensity written for tower i would land on whichever
    // lit tower happens to sit at index i.
    for (const t of allTowers) t.overlaySlot = -1;
    const towers = allTowers.filter((t) => !t.spec?.inert);
    for (let i = 0; i < towers.length; i++) towers[i].overlaySlot = i;

    const n = towers.length;
    this.glowMesh.visible = n > 0;
    this.runeMesh.visible = n > 0;
    if (!n) return;

    const GV = GLOW_CELLS + 1;          // vertices per side of a glow patch
    const GVERTS = GV * GV;
    const gPos = new Float32Array(n * GVERTS * 3);
    const gUv = new Float32Array(n * GVERTS * 2);
    const gCol = new Float32Array(n * GVERTS * 3);
    const gPar = new Float32Array(n * GVERTS * 3);
    const gIdx = new Uint16Array(n * GLOW_CELLS * GLOW_CELLS * 6);
    const rPos = new Float32Array(n * 4 * 3);
    const rUv = new Float32Array(n * 4 * 2);
    const rCen = new Float32Array(n * 4 * 3);
    const rCol = new Float32Array(n * 4 * 3);
    const rPar = new Float32Array(n * 4 * 3);
    const idx = new Uint16Array(n * 6);

    const c = new THREE.Color();
    const hAt = this.heightAt;
    for (let i = 0; i < n; i++) {
      const t = towers[i];
      const s = t.spec;
      const r = s.glowRadius;
      const seed = (t.id * 0.618) % 1;
      c.setHex(t.def.color).convertSRGBToLinear();
      const a = c.clone().multiplyScalar(1.0);
      c.setHex(t.def.accent).convertSRGBToLinear();
      const acc = c;

      // --- ground glow: terrain-conforming patch ---------------------------
      //
      // Every vertex sits on the terrain. A tower's pool reaches 4 units out,
      // which is well past the raised buildable tile and down the kerb onto the
      // sunken creep lane, so a flat quad would visibly float over the road and
      // cut a rectangle out of the pool where it crossed the step.
      const vBase = i * GVERTS;
      for (let gy = 0; gy < GV; gy++) {
        for (let gx = 0; gx < GV; gx++) {
          const o = vBase + gy * GV + gx;
          const u = gx / GLOW_CELLS, v = gy / GLOW_CELLS;
          const px = t.x + (u * 2 - 1) * r;
          const pz = t.z + (v * 2 - 1) * r;
          gPos[o * 3] = px;
          gPos[o * 3 + 1] = (hAt ? hAt(px, pz) : 0.24) + GLOW_LIFT;
          gPos[o * 3 + 2] = pz;
          gUv[o * 2] = u; gUv[o * 2 + 1] = v;
          gCol[o * 3] = a.r; gCol[o * 3 + 1] = a.g; gCol[o * 3 + 2] = a.b;
          gPar[o * 3] = r; gPar[o * 3 + 1] = seed; gPar[o * 3 + 2] = s.glowIntensity;
        }
      }
      let io = i * GLOW_CELLS * GLOW_CELLS * 6;
      for (let gy = 0; gy < GLOW_CELLS; gy++) {
        for (let gx = 0; gx < GLOW_CELLS; gx++) {
          const q = vBase + gy * GV + gx;
          gIdx[io++] = q; gIdx[io++] = q + 1; gIdx[io++] = q + GV + 1;
          gIdx[io++] = q; gIdx[io++] = q + GV + 1; gIdx[io++] = q + GV;
        }
      }

      // --- rune: billboarded quad, expanded in view space by aParam.x -------
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (let k = 0; k < 4; k++) {
        const o = (i * 4 + k);
        rPos[o * 3] = corners[k][0]; rPos[o * 3 + 1] = corners[k][1]; rPos[o * 3 + 2] = 0;
        rUv[o * 2] = uvs[k][0]; rUv[o * 2 + 1] = uvs[k][1];
        rCen[o * 3] = t.x; rCen[o * 3 + 1] = s.runeY; rCen[o * 3 + 2] = t.z;
        rCol[o * 3] = acc.r * 0.4 + a.r * 0.6;
        rCol[o * 3 + 1] = acc.g * 0.4 + a.g * 0.6;
        rCol[o * 3 + 2] = acc.b * 0.4 + a.b * 0.6;
        rPar[o * 3] = 0.40 + t.level * 0.05; rPar[o * 3 + 1] = seed; rPar[o * 3 + 2] = 0.8;
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(gUv, 2));
    g.setAttribute('aColor', new THREE.BufferAttribute(gCol, 3));
    const gParAttr = new THREE.BufferAttribute(gPar, 3);
    gParAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aParam', gParAttr);
    g.setIndex(new THREE.BufferAttribute(gIdx, 1));
    this.glowMesh.geometry.dispose();
    this.glowMesh.geometry = g;
    this._glowParam = gParAttr;

    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
    rg.setAttribute('uv', new THREE.BufferAttribute(rUv, 2));
    rg.setAttribute('aCentre', new THREE.BufferAttribute(rCen, 3));
    rg.setAttribute('aColor', new THREE.BufferAttribute(rCol, 3));
    const rParAttr = new THREE.BufferAttribute(rPar, 3);
    rParAttr.setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute('aParam', rParAttr);
    rg.setIndex(new THREE.BufferAttribute(idx.slice(), 1));
    this.runeMesh.geometry.dispose();
    this.runeMesh.geometry = rg;
    this._runeParam = rParAttr;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------
  update(towers, dt, elapsed) {
    if (this._layoutDirty) this.rebuildOverlays(towers);
    this.glowMat.uniforms.uTime.value = elapsed;
    this.runeMat.uniforms.uTime.value = elapsed;

    const gp = this._glowParam;
    const rp = this._runeParam;

    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (!t.inst) continue;
      const s = t.spec;
      const heat = t.pulse;

      // --- foundation: rise-from-the-ground on placement ------------------
      if (t.rise < 1) {
        t.rise = Math.min(1, t.rise + dt / RISE_TIME);
        const e = easeOutBack(t.rise);
        const drop = -(s.height + 0.8) * (1 - e);
        this.#seatBase(t, drop);
        t.riseY = drop;
        if (t.rise >= 1) t.riseY = 0;
      } else if (t.baseDirty) {
        t.baseDirty = false;
        t.riseY = 0;
        this.#seatBase(t, 0);
      }
      const ry = t.riseY || 0;

      // --- head: yaw, recoil, breathing ----------------------------------
      const rec = t.recoil;
      // Anticipation pulls the head back and down; the shot snaps it forward.
      const kick = rec > 0 ? Math.exp(-9 * (1 - rec) * 0.6) : 0;
      const back = -0.34 * kick + t.charge * 0.09;
      const pitch = (s.pitch ? 0 : 1) * (-0.20 * kick + t.charge * 0.10);
      const bob = Math.sin(elapsed * 1.25 + t.id * 1.7) * 0.035;
      const sway = Math.sin(elapsed * 0.6 + t.id) * 0.018 * (1 - t.spinup);

      this._e.set(pitch, t.yaw + sway, 0, 'YXZ');
      this._q.setFromEuler(this._e);
      this._v.set(
        t.x - Math.sin(t.yaw) * back,
        ry + s.headY + bob - kick * 0.06,
        t.z - Math.cos(t.yaw) * back,
      );
      this._s.setScalar(1 + kick * 0.05);
      this._m.compose(this._v, this._q, this._s);
      if (t.inst.head >= 0) this.mesh.setMatrixAt(t.inst.head, this._m);

      // --- collar: slow counter-rotation ---------------------------------
      if (t.inst.collar >= 0) {
        this._e.set(0, -elapsed * 0.45 - t.id, 0, 'YXZ');
        this._q.setFromEuler(this._e);
        this._v.set(t.x, ry + s.collarY, t.z);
        this._s.setScalar(1);
        this._m.compose(this._v, this._q, this._s);
        this.mesh.setMatrixAt(t.inst.collar, this._m);
      }

      // --- halo: counter-rotating toothed ring ---------------------------
      if (t.inst.halo >= 0) {
        const spin = elapsed * (0.8 + t.spinup * 2.2) + t.id;
        this._e.set(Math.sin(elapsed * 0.7 + t.id) * 0.09, spin, Math.cos(elapsed * 0.5 + t.id) * 0.07, 'YXZ');
        this._q.setFromEuler(this._e);
        this._v.set(t.x, ry + s.haloY + Math.sin(elapsed * 1.1 + t.id) * 0.07, t.z);
        this._s.setScalar(1 + rec * 0.10);
        this._m.compose(this._v, this._q, this._s);
        this.mesh.setMatrixAt(t.inst.halo, this._m);
      }

      // --- orbiting shards ------------------------------------------------
      for (let k = 0; k < t.inst.shards.length; k++) {
        const id = t.inst.shards[k];
        if (id < 0) continue;
        const sh = s.shards[k];
        const a = sh.phase + elapsed * sh.speed * (1 + t.spinup * 0.9);
        const rr = sh.radius * (1 + rec * 0.22);
        this._e.set(elapsed * sh.spin * 0.5, a, elapsed * sh.spin * 0.3, 'YXZ');
        this._q.setFromEuler(this._e);
        this._v.set(
          t.x + Math.cos(a) * rr,
          ry + sh.y + Math.sin(elapsed * 1.6 + sh.phase) * sh.bob,
          t.z + Math.sin(a) * rr,
        );
        this._s.setScalar(1 + rec * 0.3);
        this._m.compose(this._v, this._q, this._s);
        this.mesh.setMatrixAt(id, this._m);
      }

      // --- emissive breathing, per instance -------------------------------
      const glow = heat;
      this._col.setRGB(glow, glow, glow);
      if (t.inst.head >= 0) this.mesh.setColorAt(t.inst.head, this._col);
      if (t.inst.collar >= 0) this.mesh.setColorAt(t.inst.collar, this._col);
      if (t.inst.halo >= 0) this.mesh.setColorAt(t.inst.halo, this._col);
      if (t.inst.base >= 0) this.mesh.setColorAt(t.inst.base, this._col);
      for (const id of t.inst.shards) if (id >= 0) this.mesh.setColorAt(id, this._col);

      // --- overlays -------------------------------------------------------
      // Both overlays follow the same contract as the emissive: a low resting
      // level that identifies the element and tints its tile, and a firing
      // spike that is unmistakably an event.
      // `overlaySlot`, not `i` — foundations are absent from these buffers, so
      // the two sequences diverge as soon as one is on the board.
      const os = t.overlaySlot ?? -1;
      if (gp && os >= 0) {
        const v = s.glowIntensity * (0.78 + rec * 2.6 + t.spinup * 0.18) * Math.min(1, t.rise * 1.6);
        const nv = (GLOW_CELLS + 1) * (GLOW_CELLS + 1);
        for (let k = 0; k < nv; k++) gp.array[(os * nv + k) * 3 + 2] = v;
      }
      if (rp && os >= 0) {
        const v = 0.36 * (0.55 + rec * 2.0) * Math.min(1, t.rise * 1.6);
        for (let k = 0; k < 4; k++) rp.array[(os * 4 + k) * 3 + 2] = v;
      }
    }
    if (gp) gp.needsUpdate = true;
    if (rp) rp.needsUpdate = true;

    this.#updateLights(towers, dt);
  }

  /**
   * Coloured light spill without 30 point lights: a fixed-size pool of real
   * lights chases the highest-activity towers, everything else relies on the
   * additive decal. Swap only when a challenger clearly wins, and cross-fade
   * intensity so a reassignment never pops.
   *
   * Pool size comes from the quality preset (`towerLights`) and **may be zero**
   * — that is the `low` preset, where the whole pool is the single most
   * expensive thing the renderer does. The guard below is not defensive
   * padding: without it `pool[worst]` is `undefined` on an empty pool and the
   * frame loop throws every tick, which silently renders an EMPTY BOARD at a
   * flattering 60fps. That is a worse failure than a slow frame, because it
   * looks like a result.
   */
  #updateLights(towers, dt) {
    const pool = this.lights;
    if (pool.length === 0) return;
    for (const slot of pool) slot.score = -1;

    // Score = how much this tower deserves a real light right now.
    // A foundation emits nothing, so it must never win a slot. It would
    // otherwise score 0 — beating an empty slot's -1 — and park the single most
    // expensive resource in the renderer on a grey block to light nothing.
    for (const t of towers) {
      if (!t.inst) continue;
      t._lscore = t.spec?.inert
        ? -1
        : t.recoil * 3.0 + t.spinup * 0.6 + t.level * 0.15 + (t.def.kind === 'dual' ? 0.3 : 0);
    }

    // Keep current holders, then let challengers take the weakest slot.
    for (const slot of pool) {
      const cur = towers.find((t) => t.id === slot.towerId && t.inst);
      slot.score = cur ? cur._lscore + 0.25 : -1;
      slot.tower = cur ?? null;
    }
    for (const t of towers) {
      if (!t.inst || t.spec?.inert) continue;
      if (pool.some((s) => s.towerId === t.id)) continue;
      let worst = 0;
      for (let i = 1; i < pool.length; i++) if (pool[i].score < pool[worst].score) worst = i;
      if (t._lscore > pool[worst].score) {
        pool[worst].towerId = t.id;
        pool[worst].tower = t;
        pool[worst].score = t._lscore;
      }
    }

    for (const slot of pool) {
      const t = slot.tower;
      if (!t) { slot.light.intensity = Math.max(0, slot.light.intensity - dt * 30); continue; }
      // Seated at 45% of the shaft, not at the head. With towers now ~9 units
      // tall a light parked at the crown is 9 units of inverse-square away from
      // the floor and lands nothing on it; this trades a little crown wrap for
      // an actual pool of colour underneath.
      slot.light.position.set(t.x, (t.riseY || 0) + t.spec.headY * 0.45 + 0.8, t.z);
      this._col.setHex(t.def.color).convertSRGBToLinear();
      slot.light.color.copy(this._col);
      // Resting term raised 0.16 -> 0.62: an idle tower must light its own tile,
      // not only a firing one. The recoil term is raised in step so the shot is
      // still the event.
      const want = (15 + t.level * 7) * (0.55 + t.recoil * 3.2 + t.spinup * 0.35);
      slot.light.intensity += (want - slot.light.intensity) * Math.min(1, dt * 14);
      slot.light.distance = 17 + t.level * 2.0;
    }
  }

  dispose() {
    this.mesh.dispose();
    this.material.dispose();
    this.glowMesh.geometry.dispose();
    this.glowMat.dispose();
    this.runeMesh.geometry.dispose();
    this.runeMat.dispose();
  }
}

function easeOutBack(u) {
  const c1 = 1.9, c3 = c1 + 1;
  const p = u - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}
