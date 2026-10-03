/**
 * THE 3D STAGE — one WebGL renderer for every rite, and the helpers a rite view
 * needs to put the 16x9 FIELD into a three.js scene.
 *
 * Read docs/MINIGAMES.md §2 and §8 ("Writing a 3D view") before using this.
 *
 * OWNERSHIP. MinigameHost creates ONE Stage3D, lazily, the first time a rite
 * with a `view` opens, and keeps it for the session: a WebGL context per rite
 * would leak contexts (browsers cap them at ~16 and drop the oldest, which can
 * be the board's). A view owns its scene, camera and GPU resources and disposes
 * them; the stage owns the renderer and nothing else.
 *
 * THE FIELD FRAME. A rite's logic lives on the 16x9 field (contract.js FIELD,
 * origin at the centre, +y up). A view says where that rectangle sits in its
 * world with a FieldFrame `{ origin, ux, uy }`:
 *
 *     world(x, y) = origin + ux * x + uy * y
 *
 * `ux` and `uy` are orthogonal and of equal length (world units per field
 * unit). The plane they span is the GAMEPLAY PLANE: the pointer is raycast onto
 * it and the hit is converted back to field units, so hit tests stay in field
 * units and a rite is equally hard on every screen. Two presets cover the six
 * rites: FRAMES.upright (field on the XY plane, camera on +Z — a gallery, a
 * side view) and FRAMES.ground (field on the XZ ground, +y toward -Z — a
 * top-down or tilted arena).
 *
 * This module imports three.js, so it must never be imported by rite LOGIC
 * (src/minigames/rites/*Rite.js) or anything tests/unit runs in node.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { QUALITY_PRESETS } from '../core/Config.js';
import { FIELD } from './contract.js';

/** @typedef {{ origin: THREE.Vector3, ux: THREE.Vector3, uy: THREE.Vector3 }} FieldFrame */

export const FRAMES = Object.freeze({
  /** Field on the XY plane at z = 0, facing +Z. x -> X, y -> Y. */
  upright: Object.freeze({
    origin: new THREE.Vector3(0, 0, 0),
    ux: new THREE.Vector3(1, 0, 0),
    uy: new THREE.Vector3(0, 1, 0),
  }),
  /** Field on the ground (y = 0), facing +Y. x -> X, y -> -Z. */
  ground: Object.freeze({
    origin: new THREE.Vector3(0, 0, 0),
    ux: new THREE.Vector3(1, 0, 0),
    uy: new THREE.Vector3(0, 0, -1),
  }),
});

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();

/** Unit normal of the gameplay plane, on the side the camera looks from. */
function frameNormal(frame, out) {
  return out.crossVectors(frame.ux, frame.uy).normalize();
}

/** Field (x, y) -> world, on the gameplay plane. */
export function fieldToWorld(frame, x, y, out = new THREE.Vector3()) {
  return out.copy(frame.origin).addScaledVector(frame.ux, x).addScaledVector(frame.uy, y);
}

/** World point (assumed on or near the plane) -> field {x, y}. */
export function worldToField(frame, p, out = { x: 0, y: 0 }) {
  _v.copy(p).sub(frame.origin);
  out.x = _v.dot(frame.ux) / frame.ux.lengthSq();
  out.y = _v.dot(frame.uy) / frame.uy.lengthSq();
  return out;
}

/**
 * Where to put something `depth` world units BEHIND the gameplay plane (negative
 * = in front of it) so that it covers field point (x, y) exactly as seen from
 * `camera`. Returns the scale factor `k` to apply to its size: an object of
 * field radius r placed here with world radius r * |ux| * k projects onto the
 * same screen disc the hit test uses.
 *
 * This is how a view gives rows of targets real depth (parallax, occlusion,
 * lighting) without moving the hit test off the field: the logic says "a disc
 * at (x, y)", the view puts a 3D object on the camera ray through it.
 */
export function placeOnRay(camera, frame, x, y, depth, out) {
  fieldToWorld(frame, x, y, out);
  const n = frameNormal(frame, _n);
  const h = _w.copy(camera.position).sub(frame.origin).dot(n);
  const k = 1 + depth / h;
  out.sub(camera.position).multiplyScalar(k).add(camera.position);
  return k;
}

/**
 * Frame `camera` so the whole 16x9 field is visible, at any aspect.
 *
 * The camera looks at the field centre from the plane's normal, tilted by
 * `tilt` degrees: POSITIVE tilt moves the camera toward field -y (the bottom
 * edge) — the natural "behind the near edge" view of a ground frame; a NEGATIVE
 * tilt on an upright frame looks slightly down at it from above. `yaw` then
 * swings it around field +y: positive moves the camera toward field +x, so the
 * right-hand faces of everything turn toward the player. Distance is
 * found by bisection so all four field corners (inset by `margin` of NDC) are in
 * view; it is a property of the corners, not of a formula that assumes the
 * camera is square to the plane.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {FieldFrame} frame
 * @param {number} aspect  canvas width / height
 * @param {{ fov?: number, tilt?: number, yaw?: number, margin?: number, lookAt?: {x:number,y:number} }} [o]
 */
export function frameField(camera, frame, aspect, o = {}) {
  const fov = o.fov ?? 38;
  const tilt = THREE.MathUtils.degToRad(o.tilt ?? 0);
  const margin = o.margin ?? 0.0;
  camera.fov = fov;
  camera.aspect = aspect > 0 ? aspect : 16 / 9;
  camera.up.copy(frame.uy).normalize();

  const target = fieldToWorld(frame, o.lookAt?.x ?? 0, o.lookAt?.y ?? 0, new THREE.Vector3());
  const n = frameNormal(frame, new THREE.Vector3());
  const dir = n.clone().multiplyScalar(Math.cos(tilt))
    .addScaledVector(frame.uy.clone().normalize(), -Math.sin(tilt));
  if (o.yaw) dir.applyAxisAngle(frame.uy.clone().normalize(), THREE.MathUtils.degToRad(o.yaw));

  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
    .map(([sx, sy]) => fieldToWorld(frame, sx * FIELD.hw, sy * FIELD.hh));
  const lim = 1 - margin;
  const fits = (d) => {
    camera.position.copy(target).addScaledVector(dir, d);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    for (const c of corners) {
      _v.copy(c).project(camera);
      if (!(Math.abs(_v.x) <= lim && Math.abs(_v.y) <= lim && _v.z < 1)) return false;
    }
    return true;
  };
  const span = frame.ux.length() * FIELD.w;
  let lo = span * 0.05, hi = span * 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid; else lo = mid;
  }
  fits(hi);
  camera.near = Math.max(0.05, hi * 0.05);
  camera.far = hi * 6 + span * 4;
  camera.updateProjectionMatrix();
  return hi;
}

/**
 * The standard rig: one hemisphere fill and one key directional. Returns both so
 * a view can retint them. Two lights, never toggled on and off: three.js
 * compiles one program per light COUNT, and a count that changes mid-rite is a
 * shader compile mid-rite (docs/PERF_BUDGET.md, Round 11). Animate intensity.
 *
 * `shadow: true` makes the key the ONE shadow caster a rite may have: a 1024
 * map whose orthographic box covers the field plus `shadowPad` world units.
 * Pass `stage.shadows`, which is false on the cheap presets; then mark the few
 * meshes that matter `castShadow` / `receiveShadow`.
 */
export function addStandardLights(scene, o = {}) {
  const hemi = new THREE.HemisphereLight(o.sky ?? 0xdfe6ff, o.ground ?? 0x2a2018, o.hemi ?? 0.9);
  const key = new THREE.DirectionalLight(o.keyColor ?? 0xffffff, o.key ?? 2.2);
  key.position.copy(o.keyFrom ?? new THREE.Vector3(3, 8, 10));
  if (o.shadow) {
    const pad = o.shadowPad ?? 4;
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const c = key.shadow.camera;
    c.left = -(FIELD.hw + pad); c.right = FIELD.hw + pad;
    c.top = FIELD.hh + pad; c.bottom = -(FIELD.hh + pad);
    c.near = 0.5; c.far = key.position.length() * 2 + pad * 2;
    c.updateProjectionMatrix();
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
  }
  scene.add(hemi, key, key.target);
  return { hemi, key };
}

/**
 * Dispose every geometry, material, texture and light under `root`. Lights
 * count: a shadow-casting light's dispose() is the only thing that frees its
 * shadow map, which otherwise outlives the view on the session-long context.
 */
export function disposeObject(root) {
  const seen = new Set();
  const drop = (r) => { if (r && !seen.has(r)) { seen.add(r); r.dispose?.(); } };
  root.traverse((o) => {
    if (o.isLight) drop(o);
    drop(o.geometry);
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of Object.keys(m)) if (m[k]?.isTexture) drop(m[k]);
      drop(m);
    }
  });
}

/**
 * A pooled particle burst: one THREE.Points, a fixed number of slots, a ring
 * cursor. Emitting never allocates and the draw call count never changes.
 * Simulated in the VIEW at the frame rate — it is presentation, it reads
 * nothing back into the rite, so it is not bound by the fixed step.
 */
export class Bursts {
  /**
   * @param {{ count?: number, size?: number, gravity?: number, additive?: boolean, drag?: number, seed?: number }} [o]
   */
  constructor(o = {}) {
    this.n = o.count ?? 160;
    this.gravity = o.gravity ?? -9;
    this.drag = o.drag ?? 0.985;
    this.pos = new Float32Array(this.n * 3);
    this.col = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.base = new Float32Array(this.n * 3);
    this.life = new Float32Array(this.n);
    this.max = new Float32Array(this.n).fill(1);
    this.at = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({
      size: o.size ?? 0.12, vertexColors: true, sizeAttenuation: true, depthWrite: false,
      transparent: true, blending: o.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this._c = new THREE.Color();
    this._seed = o.seed ?? 0x9e3779b9;
    /** True once every particle is dead AND that state has been uploaded: update() is then free. */
    this._idle = true;
  }

  /** Cheap deterministic noise; presentation only, so it need not be seeded per run. */
  #rnd() {
    let t = (this._seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * @param {THREE.Vector3} at   world position
   * @param {number} count
   * @param {{ color?: THREE.ColorRepresentation, speed?: number, life?: number, up?: number, spread?: THREE.Vector3 }} [o]
   */
  emit(at, count, o = {}) {
    this._c.set(o.color ?? 0xffd27a);
    this._idle = false;
    const speed = o.speed ?? 3;
    for (let k = 0; k < count; k++) {
      const i = this.at; this.at = (this.at + 1) % this.n;
      const a = this.#rnd() * Math.PI * 2;
      const b = (this.#rnd() - 0.5) * Math.PI;
      const s = speed * (0.4 + 0.6 * this.#rnd());
      this.pos[i * 3] = at.x; this.pos[i * 3 + 1] = at.y; this.pos[i * 3 + 2] = at.z;
      this.vel[i * 3] = Math.cos(a) * Math.cos(b) * s;
      this.vel[i * 3 + 1] = Math.sin(b) * s + (o.up ?? 1.5);
      this.vel[i * 3 + 2] = Math.sin(a) * Math.cos(b) * s;
      this.base[i * 3] = this._c.r; this.base[i * 3 + 1] = this._c.g; this.base[i * 3 + 2] = this._c.b;
      this.max[i] = this.life[i] = (o.life ?? 0.55) * (0.6 + 0.4 * this.#rnd());
    }
  }

  update(dt) {
    if (this._idle) return;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        if (this.col[i * 3] !== 0 || this.col[i * 3 + 1] !== 0) {
          this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0;
        }
        continue;
      }
      this.life[i] -= dt;
      any = true;
      const f = Math.max(0, this.life[i] / this.max[i]);
      this.vel[i * 3 + 1] += this.gravity * dt;
      for (let c = 0; c < 3; c++) {
        this.vel[i * 3 + c] *= this.drag;
        this.pos[i * 3 + c] += this.vel[i * 3 + c] * dt;
        this.col[i * 3 + c] = this.base[i * 3 + c] * f;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    this._idle = !any;
  }
}

/**
 * The base every rite view extends. It owns a scene and a camera, frames the
 * field on layout, and disposes the scene on teardown. Subclasses build their
 * scene in the constructor and override `render(alpha, dt)`.
 *
 * THE CONTRACT A SUBCLASS KEEPS (the host relies on it):
 *  - `render(alpha, dt)` READS the rite and never writes to it. It may mutate
 *    its own scene objects and its own presentation state freely.
 *  - `camera` is the LOGICAL camera. Never shake it: put transient offsets in
 *    `this.kick` and the stage applies them only for the draw, so the pointer
 *    raycast always uses the steady camera and a recoil cannot move a shot.
 *  - Effects that need "something just happened" come through `cue(ev)` — the
 *    same events the rite's drainEvents() returned, forwarded by the host after
 *    it has played their sounds.
 */
export class RiteView {
  /**
   * @param {Stage3D} stage
   * @param {object} rite   the live MinigameInstance; read-only from here
   * @param {{ frame?: FieldFrame, fov?: number, tilt?: number, yaw?: number, margin?: number, background?: THREE.ColorRepresentation }} [o]
   */
  constructor(stage, rite, o = {}) {
    this.stage = stage;
    this.rite = rite;
    this.frame = o.frame ?? FRAMES.upright;
    this.framing = { fov: o.fov ?? 38, tilt: o.tilt ?? 0, yaw: o.yaw ?? 0, margin: o.margin ?? 0 };
    this.scene = new THREE.Scene();
    if (o.background !== undefined) this.scene.background = new THREE.Color(o.background);
    this.camera = new THREE.PerspectiveCamera(this.framing.fov, 16 / 9, 0.1, 500);
    /** Transient camera offset for THIS draw only: world-space position and pitch/yaw in radians. */
    this.kick = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 };
    this._owned = [];
    this.layout(16 / 9);
  }

  /**
   * Register a GPU resource that may not be reachable from the scene graph at
   * teardown (a material swapped out mid-rite, a texture cache). Returns it.
   */
  own(resource) { this._owned.push(resource); return resource; }

  /** Called by the host whenever the canvas changes size. */
  layout(aspect) {
    frameField(this.camera, this.frame, aspect, this.framing);
  }

  /** Field -> world on the gameplay plane. */
  world(x, y, out = new THREE.Vector3()) { return fieldToWorld(this.frame, x, y, out); }

  /** Optional: presentation cue from the rite's drainEvents(). */
  cue(_ev) {}

  /** Sync the scene to the rite's state. Override. */
  render(_alpha, _dt) {}

  dispose() {
    disposeObject(this.scene);
    for (const r of this._owned) r.dispose?.();
    this._owned.length = 0;
  }
}

/**
 * The renderer, the canvas size, the pick. One per host.
 */
export class Stage3D {
  /**
   * @returns {?Stage3D} null when WebGL2 cannot be had; the host then plays the
   *   rite blind rather than throwing.
   */
  static create(canvas, opts = {}) {
    try {
      return new Stage3D(canvas, opts);
    } catch (err) {
      console.warn('[rite] 3D stage unavailable:', err?.message ?? err);
      return null;
    }
  }

  constructor(canvas, { quality = 'high', boardDpr } = {}) {
    this.canvas = canvas;
    // MSAA is the one setting fixed for the context's life; everything else
    // follows the preset on every open (setQuality).
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: quality !== 'potato', alpha: false, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.cssW = 0; this.cssH = 0; this.dpr = 0;
    this._env = null;
    this.setQuality(quality, boardDpr);
  }

  /**
   * Follow the board's preset. Called by the host on every open, BEFORE the
   * view is built, because views read `shadows` in their constructor.
   *
   * @param {string} quality   a QUALITY_PRESETS key
   * @param {number} [boardDpr] the board renderer's current pixel ratio, which
   *   already carries AdaptiveResolution's verdict on this machine
   */
  setQuality(quality, boardDpr) {
    /**
     * One small shadow map is affordable on a scene this size, except on the two
     * presets that exist because the machine could not afford the board.
     * Views read this and pass it to addStandardLights.
     */
    this.shadows = quality !== 'potato' && quality !== 'low';
    this.renderer.shadowMap.enabled = this.shadows;
    /**
     * DPR ceiling: never more pixels per CSS pixel than the board is allowed
     * (its preset cap, and its live adaptive ratio), and never above 1.5 even
     * on ultra: a rite is a small scene, but a 4K panel at DPR 2 is 8 Mpx of it.
     */
    const cap = QUALITY_PRESETS[quality]?.pixelRatioCap ?? 1.5;
    this.maxDpr = Math.min(1.5, cap, boardDpr > 0 ? boardDpr : Infinity);
    this.dpr = 0;
  }

  /**
   * Drop the drawing buffer to 1x1 while no rite is up: the hidden canvas would
   * otherwise hold a full-size (MSAA, at high) buffer through every wave.
   */
  release() {
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(1, 1, false);
    this.cssW = 0; this.cssH = 0; this.dpr = 0;
  }

  /**
   * A prefiltered room environment for reflections, built once per stage and
   * shared by every view (set `scene.environment = stage.environment()`).
   * Without one, a metal material reflects nothing and renders near-black.
   * The stage owns it: views must not dispose it.
   */
  environment() {
    if (!this._env) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this._env = pm.fromScene(room, 0.04).texture;
      room.dispose?.();
      pm.dispose();
    }
    return this._env;
  }

  get aspect() { return this.cssH > 0 ? this.cssW / this.cssH : 16 / 9; }

  /** @returns {boolean} true when the size actually changed */
  setSize(cssW, cssH, dpr) {
    const d = Math.min(this.maxDpr, dpr || 1);
    if (cssW === this.cssW && cssH === this.cssH && d === this.dpr) return false;
    this.cssW = cssW; this.cssH = cssH; this.dpr = d;
    this.renderer.setPixelRatio(d);
    this.renderer.setSize(cssW, cssH, false);
    return true;
  }

  /**
   * Do the first frame's one-off GPU work now, behind the intro card: compile
   * every material, then draw once so every texture in the scene is uploaded
   * and the shadow map exists. compile() alone does neither of the last two,
   * and a player who pressed Space during the load gets a first frame that is
   * already a played one.
   */
  compile(view) {
    this.renderer.compile(view.scene, view.camera);
    this.renderer.render(view.scene, view.camera);
  }

  render(view) {
    const cam = view.camera;
    const k = view.kick;
    const shaken = k && (k.x || k.y || k.z || k.pitch || k.yaw);
    if (shaken) {
      // Saved and copied back, not undone by inverse rotations: those round
      // differently every frame and would walk the steady camera, and with it
      // the pick, a little further on every shot.
      _pos.copy(cam.position); _quat.copy(cam.quaternion);
      cam.position.x += k.x; cam.position.y += k.y; cam.position.z += k.z;
      cam.rotateX(k.pitch); cam.rotateY(k.yaw);
      cam.updateMatrixWorld();
    }
    this.renderer.render(view.scene, cam);
    if (shaken) {
      cam.position.copy(_pos); cam.quaternion.copy(_quat);
      cam.updateMatrixWorld();
    }
  }

  /**
   * Client pixel -> FIELD units, by raycasting onto the view's gameplay plane
   * with its steady camera.
   *
   * @param {DOMRect} rect  the canvas's client rect
   * @returns {?{x: number, y: number}} null when the ray misses the plane
   */
  pick(view, clientX, clientY, rect, out = { x: 0, y: 0 }) {
    if (!(rect.width > 0 && rect.height > 0)) return null;
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    _ray.setFromCamera(_ndc, view.camera);
    const n = frameNormal(view.frame, _n);
    const denom = _ray.ray.direction.dot(n);
    if (Math.abs(denom) < 1e-6) return null;
    const t = _w.copy(view.frame.origin).sub(_ray.ray.origin).dot(n) / denom;
    if (!(t > 0)) return null;
    _ray.ray.at(t, _v);
    return worldToField(view.frame, _v, out);
  }

  /** FIELD units -> client pixels. The inverse of pick; for tests and tools. */
  fieldToClient(view, x, y, rect) {
    fieldToWorld(view.frame, x, y, _v).project(view.camera);
    return { x: rect.left + (_v.x + 1) / 2 * rect.width, y: rect.top + (1 - _v.y) / 2 * rect.height };
  }

  dispose() {
    this._env?.dispose();
    this._env = null;
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}
