import * as THREE from 'three';
import { CAMERA, GRID } from './Config.js';

const _v = new THREE.Vector3();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ray = new THREE.Ray();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();

/**
 * RTS orbit rig.
 *
 * Design notes
 * ------------
 * - **No magic start distance.** `frameBoard()` solves for the distance that
 *   puts the board footprint at CAMERA.frameFillX of the frame width while
 *   leaving sky headroom above and clearance for the build bar below. It runs
 *   once the aspect ratio is known and again on resize, until the player
 *   zooms manually.
 * - **Inertia everywhere.** Pan drags build momentum that coasts out under
 *   friction; every goal is chased by an exponential spring so nothing snaps.
 * - **Zoom goes to the cursor**, not to the centre, so inspecting a corner
 *   tower is one gesture instead of zoom-then-pan.
 * - **Pitch is coupled to zoom**: close in, the camera drops toward eye level
 *   and towers gain height; far out it flattens toward a map read.
 * - **Idle drift**: after a second of no input a very slow orbit/breath ramps
 *   in so the frame is never dead (gate G6). Any input kills it instantly.
 */
export class CameraRig {
  constructor(domElement) {
    this.dom = domElement;
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
    this._probe = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);

    this.target = new THREE.Vector3(0, 0, 0);
    this._targetGoal = this.target.clone();

    this.dist = 64;
    this._distGoal = this.dist;
    this.azimuth = CAMERA.startAzimuth;
    this._azimuthGoal = this.azimuth;
    this.polar = CAMERA.startPolar;
    this._polarGoal = this.polar;

    this.shake = 0;
    this._shakeSeed = Math.random() * 1000;
    this._offset = new THREE.Vector3();

    this._panVel = new THREE.Vector2();   // world units/s, coasting after a drag
    this._idle = 0;
    this._t = 0;
    this._autoFrame = true;               // until the player zooms themselves
    this._framedAspect = -1;              // re-solve whenever the aspect changes

    this._dragging = null;                // 'pan' | 'orbit' | null
    this._last = new THREE.Vector2();
    this._lastMoveT = 0;
    this._keys = new Set();
    this.enabled = true;

    // Board footprint probe points (corners of the rim, floor + tower height).
    this._pts = [];
    const mw = GRID.width * 0.5 * CAMERA.frameMargin;
    const mh = GRID.height * 0.5 * CAMERA.frameMargin;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (const y of [0, CAMERA.frameProbeHeight]) {
          this._pts.push(new THREE.Vector3(sx * mw, y, sz * mh));
        }
      }
    }

    this.#bind();
    this.update(0);
  }

  // --------------------------------------------------------------------- input

  #bind() {
    const dom = this.dom;
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (e.button === 2 || (e.button === 0 && e.shiftKey)) this._dragging = 'orbit';
      else if (e.button === 1) this._dragging = 'pan';
      else return;
      dom.setPointerCapture(e.pointerId);
      this._last.set(e.clientX, e.clientY);
      this._panVel.set(0, 0);
      this.#wake();
    });

    dom.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._last.x;
      const dy = e.clientY - this._last.y;
      this._last.set(e.clientX, e.clientY);
      this.#wake();

      if (this._dragging === 'orbit') {
        this._azimuthGoal -= dx * 0.005;
        this._polarGoal = THREE.MathUtils.clamp(
          this._polarGoal - dy * 0.004, CAMERA.minPolar, CAMERA.maxPolar,
        );
      } else {
        this.#panScreen(-dx, -dy, true);
      }
    });

    const end = (e) => {
      if (this._dragging) {
        this._dragging = null;
        try { dom.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      }
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);

    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.#wake();
      this._autoFrame = false;

      const before = this._distGoal;
      const scale = Math.exp(e.deltaY * CAMERA.wheelZoom);
      this._distGoal = THREE.MathUtils.clamp(before * scale, CAMERA.minDist, CAMERA.maxDist);

      // Zoom toward whatever is under the cursor, like a map app.
      const f = this._distGoal / before;
      if (f < 0.999 && this.#groundUnderPointer(e.clientX, e.clientY, _hit)) {
        const k = (1 - f) * 0.85;
        this._targetGoal.x += (_hit.x - this._targetGoal.x) * k;
        this._targetGoal.z += (_hit.z - this._targetGoal.z) * k;
      }
      this.#clampTarget();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this._keys.add(e.code);
      this.#wake();
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    window.addEventListener('blur', () => this._keys.clear());
  }

  #wake() { this._idle = 0; }

  /** World point on the y=0 plane under a client-space pixel. */
  #groundUnderPointer(cx, cy, out) {
    const r = this.dom.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    _v.set(_ndc.x, _ndc.y, 0.5).unproject(this.camera);
    _ray.origin.copy(this.camera.position);
    _ray.direction.copy(_v).sub(this.camera.position).normalize();
    return !!_ray.intersectPlane(_plane, out);
  }

  #panScreen(dx, dy, record = false) {
    // Screen delta -> world-plane delta, scaled so a pixel drags a pixel.
    const scale = this.dist * 0.0016;
    const cos = Math.cos(this.azimuth), sin = Math.sin(this.azimuth);
    const wx = (cos * dx + sin * dy) * scale;
    const wz = (-sin * dx + cos * dy) * scale;
    this._targetGoal.x += wx;
    this._targetGoal.z += wz;
    if (record) {
      // Blend into the momentum accumulator (per-second units, 60Hz assumed).
      this._panVel.x = this._panVel.x * 0.6 + wx * 60 * 0.4;
      this._panVel.y = this._panVel.y * 0.6 + wz * 60 * 0.4;
    }
    this.#clampTarget();
  }

  /**
   * Keep the board on screen. The roam budget shrinks as you zoom out, so at
   * max distance the board is locked centred and can never be pushed off frame.
   */
  #clampTarget() {
    const t = THREE.MathUtils.clamp(
      1 - (this.dist - CAMERA.minDist) / (CAMERA.maxDist - CAMERA.minDist), 0, 1,
    );
    const mx = GRID.width * 0.30 * t + 1.5;
    const mz = GRID.height * 0.30 * t + 1.5;
    this._targetGoal.x = THREE.MathUtils.clamp(this._targetGoal.x, -mx, mx);
    this._targetGoal.z = THREE.MathUtils.clamp(this._targetGoal.z, -mz, mz);
  }

  // ------------------------------------------------------------------ framing

  /** Effective polar after the zoom/pitch coupling. */
  #pitch(base, dist) {
    const t = THREE.MathUtils.smoothstep(dist, CAMERA.minDist, CAMERA.maxDist);
    const off = THREE.MathUtils.lerp(CAMERA.pitchNear, CAMERA.pitchFar, t);
    return THREE.MathUtils.clamp(base + off, CAMERA.minPolar, CAMERA.maxEffPolar);
  }

  #place(cam, dist, polar, azimuth, tx, tz) {
    const sp = Math.sin(polar);
    cam.position.set(tx + Math.sin(azimuth) * sp * dist,
      Math.cos(polar) * dist,
      tz + Math.cos(azimuth) * sp * dist);
    cam.lookAt(tx, CAMERA.lookHeight, tz);
    cam.updateMatrixWorld();
  }

  /** NDC bounds of the board footprint for a candidate distance. */
  #bounds(dist) {
    const c = this._probe;
    c.fov = this.camera.fov;
    c.aspect = this.camera.aspect;
    c.near = this.camera.near;
    c.far = this.camera.far;
    c.updateProjectionMatrix();
    this.#place(c, dist, this.#pitch(this._polarGoal, dist), this._azimuthGoal, 0, 0);
    let x = 0, top = -9, bot = -9;
    for (const p of this._pts) {
      _v.copy(p).project(c);
      if (!Number.isFinite(_v.x) || !Number.isFinite(_v.y)) return null;
      x = Math.max(x, Math.abs(_v.x));
      top = Math.max(top, _v.y);
      bot = Math.max(bot, -_v.y);
    }
    return { x, top, bot };
  }

  /**
   * Solve for the distance that frames the whole board to the Art Bible
   * composition. NDC extent is ~proportional to 1/dist, so multiplying the
   * distance by the overshoot ratio converges in a handful of steps.
   */
  frameBoard(fill = 1) {
    if (!Number.isFinite(this.camera.aspect) || this.camera.aspect <= 0) return false;
    let d = THREE.MathUtils.clamp(this._distGoal, CAMERA.minDist, CAMERA.maxDist);
    for (let i = 0; i < 12; i++) {
      const b = this.#bounds(d);
      if (!b) return false;
      const s = Math.max(
        b.x / (CAMERA.frameFillX * fill),
        b.top / (CAMERA.frameTopY * fill),
        b.bot / (CAMERA.frameBottomY * fill),
      );
      if (!Number.isFinite(s) || s <= 0) return false;
      const next = THREE.MathUtils.clamp(d * s, CAMERA.minDist, CAMERA.maxDist);
      if (Math.abs(next - d) < 0.01) { d = next; break; }
      d = next;
    }
    this._distGoal = d;
    this._targetGoal.set(0, 0, 0);
    return true;
  }

  /** Debug/report helper: what fraction of frame width the board covers. */
  measureFraction() {
    const b = this.#bounds(this.dist);
    return b ? { widthPct: b.x * 100, topNdc: b.top, botNdc: b.bot } : null;
  }

  // -------------------------------------------------------------------- public

  focus(x, z, dist) {
    this._targetGoal.set(x, 0, z);
    if (dist) {
      this._autoFrame = false;
      this._distGoal = THREE.MathUtils.clamp(dist, CAMERA.minDist, CAMERA.maxDist);
    }
    this.#clampTarget();
    this.#wake();
  }

  /**
   * @param {number} amount
   *
   * `shakeMuted` is set around the LOCAL simulation while the player is
   * watching another board: an explosion on a board that is not on screen must
   * not shake the frame someone else's board is being drawn into. It is a
   * property rather than a parameter because the callers (creep death, leak,
   * splash impact) have no idea a spectate mode exists, and should not.
   */
  addShake(amount) {
    if (this.shakeMuted) return;
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /**
   * Capture the framing GOALS, not the current interpolated pose.
   *
   * Restoring the pose would fight the springs for a frame and read as a jolt;
   * restoring the goals lets the same springs walk the camera home, which is
   * the motion the player already associates with every other camera change.
   */
  save() {
    return {
      x: this._targetGoal.x, y: this._targetGoal.y, z: this._targetGoal.z,
      dist: this._distGoal, azimuth: this._azimuthGoal, polar: this._polarGoal,
      auto: this._autoFrame,
    };
  }

  restore(s) {
    if (!s) return;
    this._targetGoal.set(s.x, s.y, s.z);
    this._distGoal = s.dist;
    this._azimuthGoal = s.azimuth;
    this._polarGoal = s.polar;
    this._autoFrame = s.auto;
    this.#wake();
  }

  update(dt) {
    this._t += dt;

    // Boot / resize auto-framing, until the player takes over the zoom.
    // The `_settleFrames` countdown re-solves for the first second of life as
    // well as on aspect change: some layouts (canvas sized from CSS, a late
    // font/HUD reflow) only report their final size a few frames in, and a
    // stale aspect would otherwise be latched forever.
    if (this._settleFrames === undefined) this._settleFrames = 60;
    if (this._settleFrames > 0) this._settleFrames--;
    if (this._autoFrame
        && (this._settleFrames > 0 || this.camera.aspect !== this._framedAspect)) {
      if (this.frameBoard()) {
        this._framedAspect = this.camera.aspect;
        // Snap, don't spring: booting or resizing the window should not read
        // as a zoom animation, and it keeps screenshots deterministic.
        this.dist = this._distGoal;
        this.target.copy(this._targetGoal);
      }
    }

    // ------------------------------------------------------------- keyboard
    const k = this._keys;
    let kx = 0, kz = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) kx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) kx += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) kz -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) kz += 1;
    if (kx || kz) {
      const speed = this.dist * 1.15 * dt;
      const cos = Math.cos(this.azimuth), sin = Math.sin(this.azimuth);
      this._targetGoal.x += (cos * kx + sin * kz) * speed;
      this._targetGoal.z += (-sin * kx + cos * kz) * speed;
      this.#clampTarget();
      this._panVel.set(0, 0);
      this.#wake();
    }
    if (k.has('KeyQ')) { this._azimuthGoal += dt * 1.1; this.#wake(); }
    if (k.has('KeyE')) { this._azimuthGoal -= dt * 1.1; this.#wake(); }

    // ------------------------------------------------------------- momentum
    if (!this._dragging && this._panVel.lengthSq() > 1e-4) {
      this._targetGoal.x += this._panVel.x * dt * CAMERA.panMomentum;
      this._targetGoal.z += this._panVel.y * dt * CAMERA.panMomentum;
      this._panVel.multiplyScalar(Math.exp(-dt * CAMERA.panFriction));
      this.#clampTarget();
      this.#wake();
    } else if (this._dragging) {
      this.#wake();
    }

    // -------------------------------------------------------------- springs
    const s = 1 - Math.exp(-dt * CAMERA.spring);
    const sz = 1 - Math.exp(-dt * CAMERA.zoomSpring);
    this.target.lerp(this._targetGoal, s);
    this.dist += (this._distGoal - this.dist) * sz;
    this.azimuth += (this._azimuthGoal - this.azimuth) * s;
    this.polar += (this._polarGoal - this.polar) * s;

    // ------------------------------------------------------------ idle life
    this._idle += dt;
    const idle = THREE.MathUtils.smoothstep(this._idle, CAMERA.idleDelay, CAMERA.idleRamp);
    const t = this._t;
    const azDrift = Math.sin(t * 0.107) * CAMERA.idleAzimuth * idle;
    const poDrift = Math.sin(t * 0.081 + 1.3) * CAMERA.idlePolar * idle;
    const breath = (Math.sin(t * 0.063 + 2.1) * 0.6 + Math.sin(t * 0.151 + 0.4) * 0.4)
      * CAMERA.idleBreath * idle;

    const dist = this.dist * (1 + breath);
    const polar = THREE.MathUtils.clamp(
      this.#pitch(this.polar, dist) + poDrift, CAMERA.minPolar, CAMERA.maxEffPolar,
    );
    const azimuth = this.azimuth + azDrift;

    this.#place(this.camera, dist, polar, azimuth, this.target.x, this.target.z);

    // ----------------------------------------------------------- impact shake
    if (this.shake > 0.0005) {
      this.shake *= Math.exp(-dt * CAMERA.shakeDecay);
      const e = this.shake * this.shake;                 // quadratic envelope
      const ts = t + this._shakeSeed;
      const f = CAMERA.shakeFreq;
      // Two detuned bands per axis: reads as a thump, not a vibration.
      const n = (a, b, p) => Math.sin(ts * f * a + p) * 0.65 + Math.sin(ts * f * b + p * 1.7) * 0.35;
      const amp = e * Math.min(dist, 60) * 0.014;        // scale with zoom
      this.camera.position.x += n(1.00, 1.61, 0.0) * amp;
      this.camera.position.y += n(0.87, 1.39, 1.7) * amp * 0.55;
      this.camera.position.z += n(1.13, 0.71, 3.1) * amp;
      this.camera.updateMatrixWorld();
      // Rotational component: the weight is in the roll, not the translation.
      this.camera.rotateZ(n(0.79, 1.27, 2.2) * e * CAMERA.shakeRoll * 0.03);
      this.camera.rotateX(n(1.07, 0.63, 4.4) * e * CAMERA.shakeRoll * 0.02);
      this.camera.updateMatrixWorld();
    } else {
      this.shake = 0;
    }
  }
}
