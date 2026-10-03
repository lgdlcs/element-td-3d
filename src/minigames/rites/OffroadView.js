/**
 * OFFROAD RACING, IN 3D — a rally stage seen from behind the car.
 *
 * Read docs/MINIGAMES.md §8.1 and LuckyShotView.js first; this file follows the
 * same rules (read the rite, never write it; build everything once; effects
 * start from cues; fixed lights; jolts go in `kick`). What is particular here:
 *
 *  1. THE WORLD IS THE TRACK. The rite's own coordinates are already a world:
 *     world X is the rite's lateral `x`, world -Z is the distance `s`, so the
 *     road, the gates, the gold and the rivals are built once at their true
 *     places and only the camera moves. `centreAt` is a pure function of `s`,
 *     so the whole course (terrain, road, gates) is meshed in the constructor.
 *  2. A CHASE CAMERA, AND A FIELD FRAME THAT RIDES WITH THE CAR. The gameplay
 *     plane is the ground, with its origin on the centreline level with the
 *     car, so a pointer pick lands in the rite as a lateral offset from the
 *     road, which is what the rite's pointer steering compares against `u`.
 *     The host re-picks every frame, so the camera may follow freely.
 *  3. THE HUD IS IN THE SCENE, PARENTED TO THE CAMERA. Three small canvas
 *     textures repainted only when their numbers change, and a progress bar
 *     made of meshes so the markers can move every frame without an upload.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MINIGAMES } from '../../core/Config.js';
import { mulberry32 } from '../../core/Rng.js';
import { clamp, lerp } from '../contract.js';
import { RiteView, addStandardLights, Bursts } from '../Stage3D.js';
import {
  TRACK_LEN, FLAG_AT, GATE_COUNT, COIN_COUNT, RIVAL_COUNT, BOOST_CHARGES, HALF_W,
} from './OffroadRite.js';

const DT = MINIGAMES.dt;

/** Chase camera, in world units behind / above the car, and where it looks. */
const CAM_BACK = 4.3;
const CAM_UP = 1.6;
const CAM_LOOK = 7.5;
const FOV = 58;
/** How much of the car's offset from the centreline the camera follows. */
const CAM_FOLLOW = 0.55;

/** The meshed course runs a little past both ends so the horizon is never bare. */
const S_MIN = -40;
const S_MAX = TRACK_LEN + 90;
const ROW = 1.25;
const ROAD_Y = 0.03;
const ROAD_HW = HALF_W + 0.22;
/** Lateral samples of the terrain ribbon, denser near the road. */
const TERRAIN_U = [-70, -48, -34, -25, -18, -13, -9.5, -7, -5.2, -3.9, -3.0, -2.4, -1.2, 0,
  1.2, 2.4, 3.0, 3.9, 5.2, 7, 9.5, 13, 18, 25, 34, 48, 70];

const TREES = 320;
const ROCKS = 170;
const BALES = 46;
const POLE_STEP = 5;
const DUST = 260;

const RIVAL_COLOURS = [0x2f7fe0, 0x35b65a, 0xb052e0];
const RIVAL_CSS = ['#5aa2ff', '#5fd67f', '#cf86ff'];

/** Banner height: well above the chase camera, which drives under every arch. */
const GATE_Y = 2.55;

/** Gate states, the index into the banner materials. */
const G_AHEAD = 0, G_NEXT = 1, G_GOOD = 2, G_MISS = 3;

/** Emission settings, made once so `render` and `cue` never build an object. */
const FX = {
  gold: { color: 0xffd25a, speed: 3.2, life: 0.55, up: 2.2 },
  goldWhite: { color: 0xfff4d0, speed: 2.0, life: 0.4, up: 1.6 },
  gate: { color: 0x7dffa0, speed: 4.2, life: 0.8, up: 3.0 },
  gateGold: { color: 0xffe08a, speed: 3.6, life: 0.7, up: 3.4 },
  miss: { color: 0xff5040, speed: 3.6, life: 0.6, up: 1.4 },
  flame: { color: 0xff9a3a, speed: 1.2, life: 0.22, up: 0.2 },
  flameHot: { color: 0x9ad8ff, speed: 1.4, life: 0.24, up: 0.2 },
  flag: { color: 0xffffff, speed: 6, life: 1.2, up: 4 },
};

function readPalette() {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const tok = (n, f) => (cs?.getPropertyValue(n) || '').trim() || f;
  return {
    ink: tok('--ink', '#e9ebf3'),
    ink2: tok('--ink-2', '#a3a9bb'),
    gold: tok('--gold', '#e5bd79'),
    goldHi: tok('--gold-hi', '#f7dfae'),
    danger: tok('--danger', '#ff5f57'),
    accent: tok('--rite-offroad-accent', '#d98b4a'),
  };
}

function canvasTexture(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Soft round particles with a real alpha channel. `Bursts` fades its colour to
 * black, which is right for additive sparks and wrong for dust: dust has to
 * fade out, not go dark. Same pooling rules: a ring of slots, no allocation.
 */
class Dust {
  constructor(n, map) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n).fill(1);
    this.a0 = new Float32Array(n);
    this.at = 0;
    this.seed = 0x51ed2701;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.55, map, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.idle = true;
  }

  rnd() {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  emit(x, y, z, r, g, b, alpha, vx, vz) {
    const i = this.at; this.at = (this.at + 1) % this.n;
    this.pos[i * 3] = x + (this.rnd() - 0.5) * 0.2;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z + (this.rnd() - 0.5) * 0.2;
    this.vel[i * 3] = vx + (this.rnd() - 0.5) * 1.4;
    this.vel[i * 3 + 1] = 0.5 + this.rnd() * 0.9;
    this.vel[i * 3 + 2] = vz + (this.rnd() - 0.5) * 1.0;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b;
    this.a0[i] = alpha;
    this.max[i] = this.life[i] = 0.7 + this.rnd() * 0.6;
    this.idle = false;
  }

  update(dt) {
    if (this.idle) return;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.col[i * 4 + 3] = 0; continue; }
      any = true;
      this.life[i] -= dt;
      const f = Math.max(0, this.life[i] / this.max[i]);
      for (let c = 0; c < 3; c++) {
        this.vel[i * 3 + c] *= 0.96;
        this.pos[i * 3 + c] += this.vel[i * 3 + c] * dt;
      }
      this.col[i * 4 + 3] = this.a0[i] * f * Math.min(1, (1 - f) * 6);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    this.idle = !any;
  }
}

// ---------------------------------------------------------------------------

class OffroadView extends RiteView {
  constructor(stage, rite) {
    const frame = {
      origin: new THREE.Vector3(),
      ux: new THREE.Vector3(1, 0, 0),
      uy: new THREE.Vector3(0, 0, -1),
    };
    super(stage, rite, { frame, fov: FOV, background: 0x9cc4e8 });
    this.P = readPalette();
    this.scene.environment = stage.environment();
    this.scene.environmentIntensity = 0.35;
    this.scene.fog = new THREE.Fog(0xc9d4d8, 55, 210);
    this.camera.near = 0.1;
    this.camera.far = 420;
    this.scene.add(this.camera);

    const seed = (rite.fxSeed >>> 0) || 1;
    this.noise = mulberry32(seed);
    this.ph = [0, 0, 0, 0, 0, 0].map(() => this.noise() * Math.PI * 2);

    this.clock = 0;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camReady = false;
    this.yaw = 0;
    this.roll = 0;
    this.shake = 0;
    this.boostGlow = 0;
    this.goldPulse = 0;
    this.missPulse = 0;
    this.dustAcc = 0;
    this.flameAcc = 0;
    this.gateHitAt = new Float64Array(GATE_COUNT).fill(-10);
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._hud = { gates: -1, gold: -1, place: -1, boost: -1, armed: -1, missed: -1, gp: -1, mp: -1 };

    this.#buildLights();
    this.#buildTextures();
    this.#buildSky();
    this.#buildTerrain();
    this.#buildRoad();
    this.#buildScenery();
    this.#buildGates();
    this.#buildArches();
    this.#buildGold();
    this.#buildCars();
    this.#buildFx();
    this.#buildHud();
    this._built = true;
    this.layout(16 / 9);
    this.render(0, 0);
  }

  // ---- the track's shape, as the view needs it ---------------------------

  /** Ground height at distance `s`, lateral offset `u` from the centreline. Presentation only. */
  height(s, u) {
    const a = Math.abs(u);
    const p = this.ph;
    const n1 = 0.5 + 0.5 * Math.sin(s * 0.061 + u * 0.23 + p[0]) * Math.cos(s * 0.037 - u * 0.11 + p[1]);
    const n2 = 0.5 + 0.5 * Math.sin(s * 0.021 + u * 0.05 + p[2]);
    const n3 = Math.sin(s * 0.33 + u * 0.71 + p[3]) * Math.sin(s * 0.19 - u * 0.47 + p[4]);
    return smooth(2.4, 3.6, a) * 0.22
      + smooth(4.5, 16, a) * (0.6 + 3.2 * n1)
      + smooth(18, 60, a) * (4 + 14 * n2)
      + smooth(3.0, 6, a) * 0.12 * n3;
  }

  // ---- construction -------------------------------------------------------

  #buildLights() {
    const { hemi, key } = addStandardLights(this.scene, {
      sky: 0xcfe2ff, ground: 0x4a3a24, hemi: 0.7, keyColor: 0xffe1b5, key: 2.1,
      keyFrom: new THREE.Vector3(-7, 11, 5), shadow: this.stage.shadows, shadowPad: 5,
    });
    this.hemi = hemi; this.key = key;
    this.keyOffset = key.position.clone();
    this.baseKey = key.intensity;
    // Always in the scene, intensity 0 at rest: a light that appears is a recompile.
    this.exhaustLight = new THREE.PointLight(0xff8a3a, 0, 6, 1.8);
    this.scene.add(this.exhaustLight);
  }

  #buildTextures() {
    this.glowTex = canvasTexture(64, 64, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.3, 'rgba(255,255,255,0.55)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    });
    this.puffTex = canvasTexture(64, 64, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,0.9)');
      r.addColorStop(0.55, 'rgba(255,255,255,0.45)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    });
    const rnd = mulberry32(0xd1a7);
    this.dirtTex = canvasTexture(256, 512, (g, w, h) => {
      g.fillStyle = '#8a5a34'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        const v = rnd();
        g.fillStyle = v < 0.5 ? `rgba(70,45,25,${0.08 + rnd() * 0.12})` : `rgba(235,200,150,${0.06 + rnd() * 0.1})`;
        const s = 1 + rnd() * 3;
        g.fillRect(rnd() * w, rnd() * h, s, s);
      }
      // Two worn ruts where every car before you drove.
      for (const cx of [0.3, 0.7]) {
        const grad = g.createLinearGradient(cx * w - 26, 0, cx * w + 26, 0);
        grad.addColorStop(0, 'rgba(60,38,20,0)');
        grad.addColorStop(0.5, 'rgba(60,38,20,0.32)');
        grad.addColorStop(1, 'rgba(60,38,20,0)');
        g.fillStyle = grad; g.fillRect(cx * w - 26, 0, 52, h);
      }
      // The edges fray into gravel.
      for (const side of [0, 1]) {
        const grad = g.createLinearGradient(side ? w : 0, 0, side ? w - 34 : 34, 0);
        grad.addColorStop(0, 'rgba(84,72,40,0.95)');
        grad.addColorStop(1, 'rgba(84,72,40,0)');
        g.fillStyle = grad; g.fillRect(side ? w - 34 : 0, 0, 34, h);
      }
    });
    this.dirtTex.wrapS = this.dirtTex.wrapT = THREE.RepeatWrapping;
    this.chevronTex = canvasTexture(128, 128, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 20; g.lineCap = 'round'; g.lineJoin = 'round';
      for (const y0 of [36, 84]) {
        g.beginPath();
        g.moveTo(18, y0 + 26); g.lineTo(w / 2, y0 - 10); g.lineTo(w - 18, y0 + 26);
        g.stroke();
      }
    });
    this.bannerTex = canvasTexture(256, 64, (g, w, h) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(0,0,0,0.78)';
      for (let x = -h; x < w + h; x += 44) {
        g.beginPath(); g.moveTo(x, h); g.lineTo(x + 20, h); g.lineTo(x + 20 + h, 0); g.lineTo(x + h, 0); g.closePath(); g.fill();
      }
      g.fillStyle = 'rgba(0,0,0,0.85)';
      g.fillRect(0, 0, w, 5); g.fillRect(0, h - 5, w, 5);
    });
    this.checkerTex = canvasTexture(128, 32, (g, w, h) => {
      for (let i = 0; i < 16; i++) {
        for (let j = 0; j < 4; j++) {
          g.fillStyle = (i + j) % 2 ? '#111111' : '#f4f4f4';
          g.fillRect(i * 8, j * 8, 8, 8);
        }
      }
    });
    this.checkerTex.wrapS = THREE.RepeatWrapping;
    const label = (text) => canvasTexture(512, 96, (g, w, h) => {
      g.fillStyle = '#16120e'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#f2e6cf';
      g.font = "italic 900 64px 'Trebuchet MS', system-ui, sans-serif";
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 3);
      g.fillStyle = '#d98b4a'; g.fillRect(0, 0, w, 7); g.fillRect(0, h - 7, w, 7);
    });
    this.startTex = label('START');
    this.finishTex = label('FINISH');
  }

  #buildSky() {
    // The background is not reachable from the scene graph's materials, so it is owned.
    this.scene.background = this.own(canvasTexture(4, 256, (g, w, h) => {
      const v = g.createLinearGradient(0, 0, 0, h);
      v.addColorStop(0, '#2c64ad');
      v.addColorStop(0.4, '#7fb0dc');
      v.addColorStop(0.58, '#d9e1e2');
      v.addColorStop(1, '#c9d4d8');
      g.fillStyle = v; g.fillRect(0, 0, w, h);
    }));
    // Two rings of mountains that ride with the camera: a horizon with no
    // parallax, which is what a horizon is.
    this.mountains = new THREE.Group();
    const ring = (radius, base, peak, top, bottom, seed) => {
      const rnd = mulberry32(seed);
      const N = 96;
      const pos = [], col = [];
      const cT = new THREE.Color(top), cB = new THREE.Color(bottom);
      let h0 = peak * (0.4 + 0.6 * rnd());
      const hs = [];
      for (let i = 0; i <= N; i++) {
        h0 = clamp(h0 + (rnd() - 0.5) * peak * 0.5, peak * 0.15, peak);
        hs.push(i === N ? hs[0] : h0);
      }
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
        const x0 = Math.sin(a0) * radius, z0 = Math.cos(a0) * radius;
        const x1 = Math.sin(a1) * radius, z1 = Math.cos(a1) * radius;
        pos.push(x0, base, z0, x1, base, z1, x1, hs[i + 1], z1, x0, base, z0, x1, hs[i + 1], z1, x0, hs[i], z0);
        for (const c of [cB, cB, cT, cB, cT, cT]) col.push(c.r, c.g, c.b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
      m.renderOrder = -2;
      return m;
    };
    this.mountains.add(ring(300, -30, 74, 0x8a9cba, 0xc4cfd6, 0x1234));
    this.mountains.add(ring(230, -30, 44, 0x5e7a66, 0xb7c4c4, 0x9876));
    this.scene.add(this.mountains);
  }

  #buildTerrain() {
    const R = this.rite;
    const rows = Math.ceil((S_MAX - S_MIN) / ROW) + 1;
    const cols = TERRAIN_U.length;
    const pos = new Float32Array(rows * cols * 3);
    const col = new Float32Array(rows * cols * 3);
    const c = new THREE.Color();
    const dust = new THREE.Color(0x6e4a2c), grassA = new THREE.Color(0x4f7a26), grassB = new THREE.Color(0x3b6a2a);
    const dry = new THREE.Color(0x9a8a3a), rock = new THREE.Color(0x6f655a);
    for (let r = 0; r < rows; r++) {
      const s = S_MIN + r * ROW;
      const cx = R.centreAt(s);
      for (let k = 0; k < cols; k++) {
        const u = TERRAIN_U[k];
        const h = this.height(s, u);
        const i = (r * cols + k) * 3;
        pos[i] = cx + u; pos[i + 1] = h; pos[i + 2] = -s;
        const a = Math.abs(u);
        const n = 0.5 + 0.5 * Math.sin(s * 0.17 + u * 0.9 + this.ph[5]);
        c.copy(grassA).lerp(grassB, n);
        c.lerp(dry, smooth(8, 30, a) * 0.6 * (1 - n));
        c.lerp(rock, smooth(6, 14, h) * 0.8);
        c.lerp(dust, 1 - smooth(2.2, 3.4, a));
        col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b;
      }
    }
    const idx = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = r * cols + k, b = a + 1, d = a + cols, e = d + 1;
        idx.push(a, b, d, b, e, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.terrain = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
  }

  /** A strip laid on the road between distances s0 and s1, lateral [u0, u1], v running along `s / vScale`. */
  #strip(s0, s1, u0, u1, y, step, vScale) {
    const R = this.rite;
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      const c = R.centreAt(s);
      pos.push(c + u0, y, -s, c + u1, y, -s);
      uv.push(0, s / vScale, 1, s / vScale);
      if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  #buildRoad() {
    const R = this.rite;
    this.road = new THREE.Mesh(this.#strip(S_MIN, S_MAX, -ROAD_HW, ROAD_HW, ROAD_Y, 0.8, 6),
      new THREE.MeshStandardMaterial({ map: this.dirtTex, roughness: 0.92 }));
    this.road.receiveShadow = true;
    this.scene.add(this.road);

    // The fast stretches: arrows painted up the road, one quad per arrow.
    const geos = [];
    for (const z of R.fastZones) {
      for (let s = Math.ceil(z.s0 / 2.6) * 2.6; s < Math.min(z.s1, FLAG_AT) - 1.2; s += 2.6) {
        geos.push(this.#strip(s - 1.0, s + 1.0, -HALF_W * 0.62, HALF_W * 0.62, ROAD_Y + 0.012, 0.5, 2.0));
      }
    }
    // Every geometry carries its own v; the arrow texture wants v in [0, 1] per quad.
    for (const g of geos) {
      const uv = g.attributes.uv;
      let lo = Infinity;
      for (let i = 0; i < uv.count; i++) lo = Math.min(lo, uv.getY(i));
      for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) - lo);
    }
    const merged = geos.length ? mergeGeometries(geos, false) : new THREE.PlaneGeometry(0.001, 0.001);
    for (const g of geos) g.dispose();
    this.arrowMat = new THREE.MeshBasicMaterial({
      map: this.chevronTex, color: 0xffcf3a, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2,
    });
    this.arrows = new THREE.Mesh(merged, this.arrowMat);
    this.arrows.renderOrder = 1;
    this.scene.add(this.arrows);

    // Marker poles down both edges, red and white: the speedometer you see.
    const poles = Math.ceil((S_MAX - S_MIN) / POLE_STEP) * 2;
    const poleGeo = new THREE.CylinderGeometry(0.03, 0.035, 0.5, 6).translate(0, 0.25, 0);
    this.poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), poles);
    const white = new THREE.Color(0xf2efe8), red = new THREE.Color(0xd8332a);
    let k = 0;
    for (let s = S_MIN; s < S_MAX && k < poles; s += POLE_STEP) {
      for (const side of [-1, 1]) {
        const u = side * (HALF_W + 0.75);
        this._v.set(R.centreAt(s) + u, this.height(s, u), -s);
        this._m.makeTranslation(this._v.x, this._v.y, this._v.z);
        this.poles.setMatrixAt(k, this._m);
        this.poles.setColorAt(k, (Math.round(s / POLE_STEP) & 1) ? red : white);
        k++;
      }
    }
    this.poles.count = k;
    this.poles.castShadow = true;
    this.scene.add(this.poles);
  }

  #buildScenery() {
    const R = this.rite;
    const rnd = mulberry32(((R.fxSeed >>> 0) ^ 0x7f4a7c15) >>> 0);
    const trunk = new THREE.CylinderGeometry(0.08, 0.12, 0.7, 6).translate(0, 0.35, 0);
    const crown1 = new THREE.ConeGeometry(0.62, 1.3, 7).translate(0, 1.2, 0);
    const crown2 = new THREE.ConeGeometry(0.45, 1.0, 7).translate(0, 1.85, 0);
    const paint = (g, hex) => {
      const c = new THREE.Color(hex);
      const n = g.attributes.position.count;
      const a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g.toNonIndexed();
    };
    const treeGeo = mergeGeometries([paint(trunk, 0x6b4a2e), paint(crown1, 0x3f6b35), paint(crown2, 0x4c7d3c)], false);
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
    this.trees = new THREE.InstancedMesh(treeGeo, treeMat, TREES);
    const tint = new THREE.Color();
    const place = (mesh, i, s, u, sc, yaw, sy = sc) => {
      this._v.set(R.centreAt(s) + u, this.height(s, u) - 0.05, -s);
      this._q.setFromAxisAngle(this._w.set(0, 1, 0), yaw);
      this._s.set(sc, sy, sc);
      this._m.compose(this._v, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
    };
    for (let i = 0; i < TREES; i++) {
      const s = S_MIN + rnd() * (S_MAX - S_MIN);
      const side = rnd() < 0.5 ? -1 : 1;
      const u = side * (4.6 + Math.pow(rnd(), 1.4) * 40);
      const sc = 0.8 + rnd() * 1.1;
      place(this.trees, i, s, u, sc, rnd() * 6.28, sc * (0.9 + rnd() * 0.5));
      tint.setHSL(0.24 + rnd() * 0.08, 0.35, 0.55 + rnd() * 0.35);
      this.trees.setColorAt(i, tint);
    }
    this.trees.castShadow = true;
    this.trees.receiveShadow = true;

    const rockGeo = new THREE.DodecahedronGeometry(0.5, 0);
    this.rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), ROCKS);
    for (let i = 0; i < ROCKS; i++) {
      const s = S_MIN + rnd() * (S_MAX - S_MIN);
      const side = rnd() < 0.5 ? -1 : 1;
      const u = side * (3.2 + Math.pow(rnd(), 1.8) * 30);
      const sc = 0.25 + rnd() * 0.75;
      place(this.rocks, i, s, u, sc, rnd() * 6.28, sc * (0.5 + rnd() * 0.4));
      tint.setHSL(0.08, 0.12 + rnd() * 0.1, 0.42 + rnd() * 0.2);
      this.rocks.setColorAt(i, tint);
    }
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;

    const baleGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.8, 12).rotateZ(Math.PI / 2).translate(0, 0.4, 0);
    this.bales = new THREE.InstancedMesh(baleGeo, new THREE.MeshStandardMaterial({ color: 0xd9b45a, roughness: 0.95 }), BALES);
    for (let i = 0; i < BALES; i++) {
      const s = (i / BALES) * TRACK_LEN + rnd() * 3;
      const side = (i & 1) ? -1 : 1;
      const u = side * (HALF_W + 3.0 + rnd() * 2.5);
      place(this.bales, i, s, u, 1, rnd() * 0.6 - 0.3);
    }
    this.bales.castShadow = true;
    this.scene.add(this.trees, this.rocks, this.bales);
  }

  #buildGates() {
    const R = this.rite;
    const tint = [0xff9a3c, 0xffd23a, 0x4fe07a, 0xff4a3a];
    this.bannerMat = tint.map((c, k) => new THREE.MeshStandardMaterial({
      map: this.bannerTex, color: c, emissive: c, emissiveIntensity: k === G_NEXT ? 0.55 : 0.25, roughness: 0.6,
    }));
    this.lineMat = tint.map((c) => new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false,
    }));
    for (const m of [...this.bannerMat, ...this.lineMat]) this.own(m);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.45, metalness: 0.6 });
    const postGeo = new THREE.CylinderGeometry(0.07, 0.08, 2.75, 8).translate(0, 1.375, 0);
    const capGeo = new THREE.SphereGeometry(0.12, 10, 8);
    const bannerGeo = new THREE.BoxGeometry(1, 0.42, 0.06);
    const lineGeo = new THREE.PlaneGeometry(1, 0.22).rotateX(-Math.PI / 2);
    this.gateMeshes = R.gates.map((gt) => {
      const g = new THREE.Group();
      const cx = R.centreAt(gt.s);
      g.position.set(cx, 0, -gt.s);
      g.rotation.y = -Math.atan(R.slopeAt(gt.s));
      const posts = [-1, 1].map((side) => {
        const p = new THREE.Mesh(postGeo, postMat);
        p.position.set(side * (gt.hw + 0.1), 0, 0);
        p.castShadow = true;
        const cap = new THREE.Mesh(capGeo, this.bannerMat[G_AHEAD]);
        cap.position.set(side * (gt.hw + 0.1), 2.8, 0);
        g.add(p, cap);
        return cap;
      });
      const banner = new THREE.Mesh(bannerGeo, this.bannerMat[G_AHEAD]);
      banner.position.set(0, GATE_Y, 0);
      banner.scale.set(2 * gt.hw + 0.34, 1, 1);
      banner.castShadow = true;
      const line = new THREE.Mesh(lineGeo, this.lineMat[G_AHEAD]);
      line.position.set(0, ROAD_Y + 0.02, 0);
      line.scale.set(2 * gt.hw, 1, 1);
      line.renderOrder = 1;
      g.add(banner, line);
      this.scene.add(g);
      return { group: g, banner, line, caps: posts, state: -1 };
    });
  }

  #buildArches() {
    const R = this.rite;
    const arch = (s, tex) => {
      const g = new THREE.Group();
      g.position.set(R.centreAt(s), 0, -s);
      g.rotation.y = -Math.atan(R.slopeAt(s));
      const postMat = new THREE.MeshStandardMaterial({ color: 0x1d1d22, roughness: 0.5, metalness: 0.4 });
      const postGeo = new THREE.BoxGeometry(0.22, 3.2, 0.22).translate(0, 1.6, 0);
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(postGeo, postMat);
        p.position.x = side * (ROAD_HW + 0.5);
        p.castShadow = true;
        g.add(p);
      }
      const board = new THREE.Mesh(new THREE.BoxGeometry(2 * ROAD_HW + 1.2, 0.62, 0.1),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 }));
      board.position.y = 2.95;
      board.castShadow = true;
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(2 * ROAD_HW, 0.7).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ map: this.checkerTex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }));
      stripe.position.y = ROAD_Y + 0.01;
      stripe.receiveShadow = true;
      g.add(board, stripe);
      this.scene.add(g);
      return g;
    };
    arch(4.5, this.startTex);
    this.finishArch = arch(FLAG_AT, this.finishTex);
  }

  #buildGold() {
    const R = this.rite;
    this.goldMat = new THREE.MeshStandardMaterial({
      color: 0xffc23a, metalness: 0.85, roughness: 0.22, emissive: 0x7a4a00, emissiveIntensity: 0.7, flatShading: true,
    });
    this.nuggets = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.22, 0), this.goldMat, COIN_COUNT);
    this.nuggets.castShadow = true;
    this.nuggets.frustumCulled = false;
    this.coinPos = new Float32Array(COIN_COUNT * 3);
    for (let i = 0; i < COIN_COUNT; i++) {
      const c = R.coins[i];
      this.coinPos[i * 3] = R.centreAt(c.s) + c.u;
      this.coinPos[i * 3 + 1] = 0.5;
      this.coinPos[i * 3 + 2] = -c.s;
    }
    const gPos = new Float32Array(COIN_COUNT * 3);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(gPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.halo = new THREE.Points(gg, new THREE.PointsMaterial({
      map: this.glowTex, color: 0xffc860, size: 1.3, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this.halo.frustumCulled = false;
    this.scene.add(this.nuggets, this.halo);
  }

  #makeCar(body, trim, player) {
    const ghost = !player;
    const mats = [];
    const mat = (m) => {
      // A rival is a ghost: it fades when it is level with you or behind,
      // so it never parks between the camera and your own car. Transparent
      // from construction, because flipping it later is a new program.
      if (ghost) { m.transparent = true; }
      mats.push(m);
      return m;
    };
    const car = new THREE.Group();
    const tilt = new THREE.Group();
    car.add(tilt);
    const paint = mat(new THREE.MeshStandardMaterial({ color: body, roughness: 0.38, metalness: 0.35 }));
    const stripe = mat(new THREE.MeshStandardMaterial({ color: trim, roughness: 0.4, metalness: 0.2 }));
    const glass = mat(new THREE.MeshStandardMaterial({ color: 0x18202c, roughness: 0.12, metalness: 0.7 }));
    const dark = mat(new THREE.MeshStandardMaterial({ color: 0x1b1b1e, roughness: 0.8 }));
    const lamp = mat(new THREE.MeshBasicMaterial({ color: 0xfff3d0, toneMapped: false }));
    const add = (geo, mat, x, y, z, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.x = rx;
      m.castShadow = true;
      tilt.add(m);
      return m;
    };
    add(new THREE.BoxGeometry(0.66, 0.2, 1.18), paint, 0, 0.32, 0);
    add(new THREE.BoxGeometry(0.62, 0.12, 0.42), paint, 0, 0.45, -0.36, 0.12);
    add(new THREE.BoxGeometry(0.54, 0.24, 0.5), glass, 0, 0.53, 0.06);
    add(new THREE.BoxGeometry(0.56, 0.05, 0.46), paint, 0, 0.67, 0.07);
    add(new THREE.BoxGeometry(0.16, 0.012, 1.2), stripe, 0, 0.425, 0.0);
    add(new THREE.BoxGeometry(0.16, 0.012, 0.46), stripe, 0, 0.697, 0.07);
    add(new THREE.BoxGeometry(0.7, 0.04, 0.16), stripe, 0, 0.66, 0.56);
    add(new THREE.BoxGeometry(0.04, 0.12, 0.08), dark, -0.24, 0.58, 0.55);
    add(new THREE.BoxGeometry(0.04, 0.12, 0.08), dark, 0.24, 0.58, 0.55);
    add(new THREE.BoxGeometry(0.7, 0.1, 0.12), dark, 0, 0.25, -0.6);
    add(new THREE.BoxGeometry(0.7, 0.1, 0.12), dark, 0, 0.25, 0.6);
    for (const x of [-0.2, 0.2]) add(new THREE.BoxGeometry(0.13, 0.07, 0.03), lamp, x, 0.37, -0.6);
    if (player) for (const x of [-0.15, -0.05, 0.05, 0.15]) add(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 10).rotateX(Math.PI / 2), lamp, x, 0.72, -0.12);
    const wheelGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.16, 14).rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.17, 8).rotateZ(Math.PI / 2);
    const rubber = mat(new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }));
    const hub = mat(new THREE.MeshStandardMaterial({ color: 0xbfc3c9, roughness: 0.3, metalness: 0.8 }));
    const wheels = [];
    for (const [x, z] of [[-0.36, -0.38], [0.36, -0.38], [-0.36, 0.4], [0.36, 0.4]]) {
      const w = new THREE.Group();
      w.position.set(x, 0.18, z);
      const tyre = new THREE.Mesh(wheelGeo, rubber);
      tyre.castShadow = true;
      w.add(tyre, new THREE.Mesh(hubGeo, hub));
      car.add(w);
      wheels.push(w);
    }
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.glowTex, color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
    blob.position.y = 0.02;
    blob.renderOrder = 1;
    car.add(blob);
    this.scene.add(car);
    return { car, tilt, wheels, paint, mats, blob, fade: 1 };
  }

  #buildCars() {
    const R = this.rite;
    this.player = this.#makeCar(new THREE.Color(this.P.accent), 0xfff1dc, true);
    this.rivalCars = [];
    const roster = R.rivals.roster();
    for (let id = 0; id < RIVAL_COUNT; id++) {
      const c = this.#makeCar(RIVAL_COLOURS[id], 0xf4f4f4, false);
      const name = roster[id]?.name ?? `Rival ${id + 1}`;
      const tex = canvasTexture(256, 64, (g, w, h) => {
        g.font = "italic 800 34px 'Trebuchet MS', system-ui, sans-serif";
        g.textAlign = 'center'; g.textBaseline = 'middle';
        const tw = g.measureText(name).width + 28;
        g.fillStyle = 'rgba(12,10,8,0.62)';
        g.beginPath(); g.roundRect((w - tw) / 2, 10, tw, h - 20, 12); g.fill();
        g.fillStyle = RIVAL_CSS[id];
        g.fillText(name, w / 2, h / 2 + 1);
      });
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      tag.scale.set(1.6, 0.4, 1);
      tag.position.y = 1.25;
      c.car.add(tag);
      c.tag = tag;
      this.rivalCars.push(c);
    }
  }

  #buildFx() {
    const seed = (this.rite.fxSeed >>> 0) || 7;
    this.sparks = new Bursts({ count: 260, size: 0.22, gravity: -7, seed });
    this.sparks.points.material.map = this.glowTex;
    this.flame = new Bursts({ count: 120, size: 0.32, gravity: 1.5, drag: 0.9, seed: seed ^ 0x9e3779b9 });
    this.flame.points.material.map = this.glowTex;
    this.dust = new Dust(DUST, this.puffTex);
    this.scene.add(this.dust.points, this.sparks.points, this.flame.points);
  }

  #buildHud() {
    const mk = (w, h) => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
      }));
      mesh.renderOrder = 20;
      this.camera.add(mesh);
      return { canvas, tex, mesh, w, h };
    };
    this.hudL = mk(512, 200);
    this.hudR = mk(512, 200);
    this.hudB = mk(1024, 150);
    const flat = (color, opacity) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    });
    this.bar = new THREE.Group();
    const track = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.1), flat(0x0d0b09, 0.55));
    track.renderOrder = 21;
    this.barFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.1).translate(0.5, 0, 0), flat(new THREE.Color(this.P.accent), 0.95));
    this.barFill.renderOrder = 22;
    this.barFill.position.x = -0.5;
    const dot = new THREE.CircleGeometry(0.11, 16);
    this.barRivals = RIVAL_COLOURS.map((c) => {
      const m = new THREE.Mesh(dot, flat(c, 1));
      m.renderOrder = 23;
      return m;
    });
    this.barMe = new THREE.Mesh(new THREE.CircleGeometry(0.16, 18), flat(0xfff1dc, 1));
    this.barMe.renderOrder = 24;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), new THREE.MeshBasicMaterial({
      map: this.checkerTex, depthTest: false, depthWrite: false, toneMapped: false, fog: false, transparent: true,
    }));
    flag.position.x = 0.5;
    flag.renderOrder = 23;
    this.barMarks = [...this.barRivals, this.barMe, flag];
    this.bar.add(track, this.barFill, ...this.barMarks);
    this.camera.add(this.bar);
  }

  // ---- layout: the camera's lens and the HUD ------------------------------

  layout(aspect) {
    const cam = this.camera;
    cam.fov = FOV;
    cam.aspect = aspect > 0 ? aspect : 16 / 9;
    cam.updateProjectionMatrix();
    if (!this._built) return;
    // The HUD sits one unit in front of the lens and is sized off the view
    // height, so it keeps its proportions on a phone and on a wide monitor.
    const d = 1;
    const H = 2 * d * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const W = H * cam.aspect;
    const m = H * 0.035;
    const place = (hud, hFrac, ax, ay) => {
      const h = H * hFrac;
      const w = h * (hud.w / hud.h);
      hud.mesh.scale.set(w, h, 1);
      hud.mesh.position.set(ax * (W / 2 - m - w / 2), ay * (H / 2 - m - h / 2), -d);
      return w;
    };
    place(this.hudL, 0.17, -1, 1);
    place(this.hudR, 0.17, 1, 1);
    place(this.hudB, 0.105, 0, -1);
    const bw = Math.min(W * 0.5, H * 1.1);
    this.bar.position.set(0, -H / 2 + m + H * 0.105 + H * 0.03, -d);
    this.bar.scale.set(bw, H * 0.12, 1);
    // Keep the dots round on a stretched bar.
    const sx = (H * 0.12) / bw;
    for (const c of this.barMarks) c.scale.x = sx;
  }

  // ---- cues ---------------------------------------------------------------

  cue(ev) {
    const R = this.rite;
    const v = this._v;
    if (ev.what === 'coin' && ev.i >= 0 && ev.i < COIN_COUNT) {
      v.set(this.coinPos[ev.i * 3], 0.55, this.coinPos[ev.i * 3 + 2]);
      this.sparks.emit(v, 26, FX.gold);
      this.sparks.emit(v, 10, FX.goldWhite);
      this.goldPulse = 1;
    } else if (ev.what === 'gate' && ev.i >= 0 && ev.i < GATE_COUNT) {
      const gt = R.gates[ev.i];
      v.set(R.centreAt(gt.s), GATE_Y, -gt.s);
      if (ev.type === 'miss') {
        this.sparks.emit(v, 34, FX.miss);
        this.shake = 1;
        this.missPulse = 1;
      } else {
        this.gateHitAt[ev.i] = this.clock;
        for (const side of [-1, 1]) {
          this._w.set(v.x + side * gt.hw, GATE_Y + 0.2, v.z);
          this.sparks.emit(this._w, 18, FX.gate);
          this.sparks.emit(this._w, 8, FX.gateGold);
        }
      }
    } else if (ev.what === 'boost') {
      this.boostGlow = 1;
      this.shake = Math.max(this.shake, 0.35);
    } else if (ev.what === 'flag') {
      v.set(R.centreAt(FLAG_AT), 3, -FLAG_AT);
      this.sparks.emit(v, 80, FX.flag);
      this.sparks.emit(v, 50, FX.gold);
    }
  }

  // ---- the frame ----------------------------------------------------------

  render(alpha, dt) {
    const R = this.rite;
    const a = clamp(alpha ?? 0, 0, 1);
    this.clock += dt;
    const s = lerp(R._prevS, R.s, a);
    const x = lerp(R._prevX, R.x, a);
    const t = Math.max(0, R.t - DT + a * DT);
    const cx = R.centreAt(s);
    const u = x - cx;
    const boosting = R.boostT > 0;

    this.shake = Math.max(0, this.shake - dt * 2.8);
    this.boostGlow = Math.max(0, this.boostGlow - dt * 1.6);
    this.goldPulse = Math.max(0, this.goldPulse - dt * 3);
    this.missPulse = Math.max(0, this.missPulse - dt * 1.5);

    // ---- the player's car
    const span = R.s - R._prevS;
    const dxds = span > 1e-6 ? (R.x - R._prevX) / span : R.slopeAt(s);
    const k = Math.min(1, dt * 10);
    this.yaw += (-Math.atan(clamp(dxds, -1.2, 1.2)) - this.yaw) * k;
    this.roll += (clamp(-R.vx * 0.035, -0.12, 0.12) - this.roll) * k;
    const P = this.player;
    const groundY = Math.abs(u) <= ROAD_HW ? ROAD_Y : this.height(s, u);
    P.car.position.set(x, groundY, -s);
    P.car.rotation.y = this.yaw;
    P.tilt.rotation.z = this.roll;
    P.tilt.rotation.x = boosting ? -0.05 : 0;
    P.tilt.position.y = Math.abs(u) > HALF_W ? Math.sin(this.clock * 31) * 0.015 : 0;
    for (const w of P.wheels) w.rotation.x = -s / 0.18;

    // ---- rivals
    for (let id = 0; id < RIVAL_COUNT; id++) {
      const C = this.rivalCars[id];
      const d = R.rivalDist(id, t);
      const ru = R.rivalLateral(id, t) * 0.75;
      C.car.position.set(R.centreAt(d) + ru, ROAD_Y, -d);
      C.car.rotation.y = -Math.atan(R.slopeAt(d));
      for (const w of C.wheels) w.rotation.x = -d / 0.18;
      C.tag.visible = d > s + 1.5 && d < s + 60;
      const fade = clamp((d - s + 0.6) / 2.2, 0, 1);
      C.car.visible = fade > 0.04;
      if (Math.abs(fade - C.fade) > 0.01) {
        C.fade = fade;
        for (const mm of C.mats) { mm.opacity = fade; mm.depthWrite = fade > 0.99; }
        C.blob.material.opacity = 0.45 * fade;
      }
    }

    // ---- the chase camera
    const lat = cx + u * CAM_FOLLOW;
    const sb = s - CAM_BACK - (boosting ? 0.8 : 0);
    const want = this._w.set(lerp(R.centreAt(sb), lat, 0.6), CAM_UP + groundY * 0.6, -sb);
    const look = this._v.set(lerp(R.centreAt(s + CAM_LOOK), x, 0.35), 0.35, -(s + CAM_LOOK));
    if (!this.camReady || dt <= 0) {
      this.camPos.copy(want);
      this.camLook.copy(look);
      this.camReady = true;
    } else {
      const kc = Math.min(1, dt * 7);
      this.camPos.lerp(want, kc);
      this.camLook.lerp(look, Math.min(1, dt * 9));
    }
    const cam = this.camera;
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
    cam.updateMatrixWorld();
    this.frame.origin.set(cx, 0, -s);
    this.mountains.position.set(cam.position.x, 0, cam.position.z);

    // A jolt for the draw only: the pick keeps the steady camera.
    const sh = this.shake * this.shake;
    this.kick.x = Math.sin(this.clock * 53) * 0.07 * sh;
    this.kick.y = Math.sin(this.clock * 61) * 0.05 * sh;
    this.kick.pitch = Math.sin(this.clock * 47) * 0.012 * sh;

    // The sun follows the car so its one shadow map always covers the action.
    this.key.position.set(x + this.keyOffset.x, this.keyOffset.y, -s + this.keyOffset.z - 4);
    this.key.target.position.set(x, 0, -s - 4);
    this.key.target.updateMatrixWorld();

    // ---- gates
    const next = R.nextGate;
    const camS = -this.camPos.z;
    for (let i = 0; i < GATE_COUNT; i++) {
      const G = this.gateMeshes[i];
      // Gone once the camera reaches it, so a car run wide never drags the
      // camera through a post.
      G.group.visible = R.gates[i].s > camS + 2.0;
      let st = G_AHEAD;
      if (i < next) st = R.missedGates.includes(i) ? G_MISS : G_GOOD;
      else if (i === next) st = G_NEXT;
      if (st !== G.state) {
        G.state = st;
        G.banner.material = this.bannerMat[st];
        G.line.material = this.lineMat[st];
        for (const c of G.caps) c.material = this.bannerMat[st];
      }
      const since = this.clock - this.gateHitAt[i];
      const bounce = since < 0.6 ? Math.sin(since * 16) * (0.6 - since) * 0.5 : 0;
      G.banner.position.y = GATE_Y + bounce;
      G.banner.scale.y = 1 + Math.max(0, bounce);
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 7);
    this.bannerMat[G_NEXT].emissiveIntensity = 0.35 + 0.5 * pulse;
    this.lineMat[G_NEXT].opacity = 0.5 + 0.4 * pulse;

    // ---- the boost arrows: bright while there is a charge to spend
    const armed = R.boostLeft > 0 && !boosting && R.isFast(R.s);
    const arrowA = R.boostLeft > 0 ? 0.55 + 0.4 * (armed ? pulse : 0.3) : 0.18;
    this.arrowMat.opacity = arrowA;
    this.arrowMat.color.setRGB(1, 0.78 + 0.2 * (armed ? pulse : 0), 0.2);

    // ---- gold
    const m = this._m, q = this._q, sc = this._s, v = this._v;
    const hp = this.halo.geometry.attributes.position.array;
    for (let i = 0; i < COIN_COUNT; i++) {
      // A nugget you drove past is gone from the picture too: left on the road
      // behind the car it would sit right in front of the camera.
      const taken = R.coins[i].taken || R.coins[i].s < s - 1.2;
      const bob = Math.sin(this.clock * 3 + i) * 0.08;
      v.set(this.coinPos[i * 3], this.coinPos[i * 3 + 1] + bob, this.coinPos[i * 3 + 2]);
      this._e.set(0.4, this.clock * 2.4 + i, 0.2);
      q.setFromEuler(this._e);
      const z = taken ? 0 : 1;
      sc.set(z, z, z);
      m.compose(v, q, sc);
      this.nuggets.setMatrixAt(i, m);
      hp[i * 3] = v.x; hp[i * 3 + 1] = taken ? -50 : v.y; hp[i * 3 + 2] = v.z;
    }
    this.nuggets.instanceMatrix.needsUpdate = true;
    this.halo.geometry.attributes.position.needsUpdate = true;
    this.halo.material.size = 1.2 + 0.25 * Math.sin(this.clock * 5);

    // ---- dust, flame, sparks
    const speed = R.speed || 0;
    const off = Math.abs(u) > HALF_W;
    this.dustAcc += dt * speed * (off ? 5.5 : 2.6);
    const back = this._w;
    while (this.dustAcc >= 1) {
      this.dustAcc -= 1;
      const side = (this.dust.at & 1) ? 0.33 : -0.33;
      back.set(side, 0.12, 0.5).applyAxisAngle(this._s.set(0, 1, 0), this.yaw);
      if (off) this.dust.emit(x + back.x, groundY + 0.15, -s + back.z, 0.36, 0.42, 0.2, 0.75, 0, 1.2);
      else this.dust.emit(x + back.x, groundY + 0.15, -s + back.z, 0.78, 0.6, 0.42, 0.55, 0, 1.6);
    }
    if (boosting) {
      this.flameAcc += dt * 70;
      back.set(0, 0.3, 0.68).applyAxisAngle(this._s.set(0, 1, 0), this.yaw);
      v.set(x + back.x, groundY + back.y, -s + back.z);
      while (this.flameAcc >= 1) {
        this.flameAcc -= 1;
        this.flame.emit(v, 1, R.boostHot ? FX.flameHot : FX.flame);
      }
      this.exhaustLight.position.copy(v);
      this.exhaustLight.color.setHex(R.boostHot ? 0x8ac8ff : 0xff8a3a);
      this.exhaustLight.intensity = 6 + 3 * Math.sin(this.clock * 40);
    } else {
      this.exhaustLight.intensity = 0;
    }
    this.dust.update(dt);
    this.sparks.update(dt);
    this.flame.update(dt);

    // ---- HUD
    this.#paintHud(armed, pulse);
    const prog = clamp(s / FLAG_AT, 0, 1);
    this.barFill.scale.x = Math.max(0.0001, prog);
    this.barMe.position.x = prog - 0.5;
    for (let id = 0; id < RIVAL_COUNT; id++) {
      this.barRivals[id].position.x = clamp(R.rivalDist(id, t) / FLAG_AT, 0, 1) - 0.5;
    }
  }

  /** Repainted only when a number on it changed: a canvas upload per frame is the one cost here worth avoiding. */
  #paintHud(armed, pulse) {
    const R = this.rite;
    const h = this._hud;
    const gp = this.goldPulse > 0.3 ? 1 : 0;
    const mp = this.missPulse > 0.3 ? 1 : 0;
    const ap = armed ? (pulse > 0.5 ? 2 : 1) : 0;
    const P = this.P;
    const panel = (g, w, hh) => {
      g.clearRect(0, 0, w, hh);
      g.fillStyle = 'rgba(14,11,8,0.58)';
      g.beginPath(); g.roundRect(4, 4, w - 8, hh - 8, 26); g.fill();
    };
    const big = "italic 900 84px 'Trebuchet MS', system-ui, sans-serif";
    const small = "800 30px 'Trebuchet MS', system-ui, sans-serif";

    if (h.gates !== R.gatesHit || h.gold !== R.coinsTaken || h.missed !== R.missedGates.length || h.gp !== gp || h.mp !== mp) {
      h.gates = R.gatesHit; h.gold = R.coinsTaken; h.missed = R.missedGates.length; h.gp = gp; h.mp = mp;
      const { canvas, tex, w, h: hh } = this.hudL;
      const g = canvas.getContext('2d');
      panel(g, w, hh);
      g.textBaseline = 'alphabetic';
      g.textAlign = 'left';
      g.font = small; g.fillStyle = 'rgba(233,235,243,0.7)';
      g.fillText('GATES', 30, 52);
      g.font = big; g.fillStyle = mp ? P.danger : P.ink;
      g.fillText(`${R.gatesHit}`, 30, 140);
      const gw = g.measureText(`${R.gatesHit}`).width;
      g.font = small; g.fillStyle = 'rgba(233,235,243,0.6)';
      g.fillText(`/ ${GATE_COUNT}`, 38 + gw, 140);
      g.font = small; g.fillStyle = gp ? P.goldHi : 'rgba(229,189,121,0.85)';
      g.fillText('GOLD', 300, 52);
      g.font = big; g.fillStyle = gp ? '#fff4d0' : P.gold;
      g.fillText(`${R.coinsTaken}`, 300, 140);
      g.beginPath(); g.fillStyle = gp ? '#fff4d0' : P.gold;
      const nx = 300 + g.measureText(`${R.coinsTaken}`).width + 30;
      g.moveTo(nx, 108); g.lineTo(nx + 14, 92); g.lineTo(nx + 28, 108); g.lineTo(nx + 14, 126); g.closePath(); g.fill();
      if (R.missedGates.length) {
        g.font = "800 26px 'Trebuchet MS', system-ui, sans-serif";
        g.fillStyle = mp ? P.danger : 'rgba(255,95,87,0.75)';
        g.fillText(`${R.missedGates.length} MISSED`, 30, 178);
      }
      tex.needsUpdate = true;
    }

    if (h.place !== R.place) {
      h.place = R.place;
      const { canvas, tex, w, h: hh } = this.hudR;
      const g = canvas.getContext('2d');
      panel(g, w, hh);
      g.textAlign = 'right';
      g.font = small; g.fillStyle = 'rgba(233,235,243,0.7)';
      g.fillText('POSITION', w - 30, 52);
      const ord = ['1st', '2nd', '3rd', '4th'][clamp(R.place - 1, 0, 3)];
      g.font = small; g.fillStyle = 'rgba(233,235,243,0.6)';
      g.fillText(`of ${RIVAL_COUNT + 1}`, w - 30, 140);
      const ow = g.measureText(`of ${RIVAL_COUNT + 1}`).width;
      g.font = "italic 900 96px 'Trebuchet MS', system-ui, sans-serif";
      g.fillStyle = R.place === 1 ? P.goldHi : P.ink;
      g.fillText(ord, w - 42 - ow, 144);
      tex.needsUpdate = true;
    }

    const boostKey = R.boostLeft * 10 + (R.boostT > 0 ? 5 : 0) + (R.boostHot ? 1 : 0);
    if (h.boost !== boostKey || h.armed !== ap) {
      h.boost = boostKey; h.armed = ap;
      const { canvas, tex, w, h: hh } = this.hudB;
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, w, hh);
      const lit = ap === 2;
      g.fillStyle = armed ? (lit ? 'rgba(80,58,10,0.78)' : 'rgba(40,30,8,0.7)') : 'rgba(14,11,8,0.58)';
      g.beginPath(); g.roundRect(262, 8, 500, hh - 16, 30); g.fill();
      if (armed) { g.strokeStyle = lit ? '#ffd23a' : 'rgba(255,210,58,0.6)'; g.lineWidth = 5; g.stroke(); }
      g.textBaseline = 'middle'; g.textAlign = 'left';
      g.font = "italic 900 46px 'Trebuchet MS', system-ui, sans-serif";
      const label = R.boostT > 0 ? (R.boostHot ? 'BOOST!' : 'BOOST') : armed ? 'BOOST NOW' : R.boostLeft > 0 ? 'BOOST' : 'NO BOOST';
      g.fillStyle = armed || (R.boostT > 0 && R.boostHot) ? '#ffd23a' : R.boostLeft > 0 ? P.ink : 'rgba(233,235,243,0.4)';
      g.fillText(label, 300, hh / 2 + 2);
      for (let i = 0; i < BOOST_CHARGES; i++) {
        const cx = 630 + i * 46, cy = hh / 2;
        g.beginPath();
        // Flame-shaped pips: a charge you still hold is filled.
        g.moveTo(cx, cy - 22); g.quadraticCurveTo(cx + 18, cy, cx + 12, cy + 14);
        g.quadraticCurveTo(cx, cy + 24, cx - 12, cy + 14); g.quadraticCurveTo(cx - 18, cy, cx, cy - 22);
        if (i < R.boostLeft) { g.fillStyle = armed ? '#ffd23a' : '#ff9a3c'; g.fill(); }
        else { g.strokeStyle = 'rgba(233,235,243,0.35)'; g.lineWidth = 4; g.stroke(); }
      }
      tex.needsUpdate = true;
    }
  }
}

export function createView(stage, rite) {
  return new OffroadView(stage, rite);
}
