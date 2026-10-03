/**
 * GAME HUNT, IN 3D — a clearing at dusk, seen from a hunting blind, for HuntRite.
 *
 * Read docs/MINIGAMES.md §8.1 and LuckyShotView.js first; this file follows the
 * same five rules (read the rite only, depth through `placeOnRay`, effects from
 * cues, build everything once, a camera that may sway).
 *
 * WHAT IS HERE THAT LUCKY SHOT DOES NOT HAVE:
 *
 *  - THE LANES ARE A FLOOR, NOT SHELVES. Each lane's depth is chosen in
 *    `layout` so that its field scale is one world size seen from further away
 *    (`K_NEAR / scale`), and the camera looks down steeply enough that the
 *    three lanes' foot lines land on one gently rising ground. The terrain is
 *    bent through those three lines, so every animal runs ON the grass.
 *  - THE RIVALS ARE IN THE PICTURE. Three stands at the treeline, each with a
 *    hunter, a lantern in the rival's colour and a name plate with a tally. The
 *    hunter swings to follow its runner, its lantern brightens as the deadline
 *    nears (the "they are about to fire" tell), and a claim is a muzzle flash
 *    and a tracer from that stand. The deadline has a face, and the face shoots.
 *  - THE BUSH RUSTLES before an animal breaks from it: a fair tell, a quarter
 *    second early, so the player watches the cover rather than the whole field.
 *
 * NOTHING HERE MUTATES THE RITE. The e2e purity test serialises it around
 * render, layout and cue.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MINIGAMES } from '../../core/Config.js';
import { mulberry32 } from '../../core/Rng.js';
import { clamp, FIELD } from '../contract.js';
import { RiteView, FRAMES, placeOnRay, addStandardLights, Bursts } from '../Stage3D.js';
import { ANIMALS, LANES, RECOIL, EXPECTED, BUSH_R, RIVAL_COUNT } from './HuntRite.js';
import { readPalette } from './HuntPalette.js';

/** The near lane's placeOnRay factor. The other lanes are `K_NEAR / scale`: one world size, further away. */
const K_NEAR = 0.75;
/**
 * The models are drawn in field units at scale 1 and then enlarged by MODEL, so
 * the body fills the rite's body disc, and the head and forelegs its `parts`
 * discs (HuntRite SPECIES). Change a model and re-run tools/scratch/hunt-silhouette.mjs.
 */
const MODEL = 1.32;
/** Field units from an animal's hit centre down to its hooves, at scale 1. The lane's ground line. */
const FOOT = 0.55 * MODEL;
/** Bush height above the ground, field units at scale 1. Under the next lane's lowest disc. */
const BUSH_H = 0.82;
/** Seconds of rustle before an animal breaks cover. */
const RUSTLE = 0.28;
/** Seconds a downed animal lies before it sinks away. */
const LIE = 1.25;
const SINK = 0.35;
const FALL = 0.3;

/** The stands, in field units: x, and a height above the far lane. */
const STAND_X = Object.freeze([-5.3, 0.3, 5.5]);
const STAND_Y = 2.75;
/** How far behind the far lane the stands sit, in world units. */
const STAND_BACK = 4.5;

/** Canvas height (css px) at and above which the name plates keep their drawn size. */
const PLATE_PX = 440;

/** Camera drift toward the aim at the field's edge, world units. */
const SWAY = 0.9;

/** The puff of leaves a bush throws as its animal is about to break. Built once: render() emits it. */
const LEAF_PUFF = Object.freeze({ color: 0x8fcf5a, speed: 1.6, life: 0.5, up: 1.4 });

const POPS = 6;
const TICKS = 24;
const MOTES = 70;

/** Colours of the three rivals. The first is the theme accent (read from CSS). */
const RIVAL_TINTS = ['#86c294', '#e8a15f', '#93b8f0'];

/** The two moods. `rite.night` picks one; nothing else differs. */
const MOODS = Object.freeze({
  dusk: Object.freeze({
    skyTop: 0x27365c, skyMid: 0xb7728a, horizon: 0xf6b071, fog: 0xc98d72, fogNear: 22, fogFar: 78,
    hemiSky: 0xffd8b0, hemiGround: 0x2c3a20, hemi: 1.05, key: 0xffc58a, keyI: 3.0,
    keyFrom: [-14, 11, -4], sun: 0xffd29a, sunSize: 16, grass: [0x6c8a3a, 0x97a048, 0x4a632c],
    mote: 0xffd58a, lit: 0xfff2d6, dim: 0x6f7a58,
  }),
  night: Object.freeze({
    skyTop: 0x050916, skyMid: 0x17223f, horizon: 0x34486e, fog: 0x1c2945, fogNear: 16, fogFar: 64,
    hemiSky: 0x9db4e8, hemiGround: 0x1a2430, hemi: 1.15, key: 0xbccfff, keyI: 2.4,
    keyFrom: [10, 12, -6], sun: 0xe4ecff, sunSize: 7, grass: [0x2e4a33, 0x3d5a3c, 0x1e3326],
    mote: 0xc8ff9a, lit: 0xd6e4ff, dim: 0x56637a,
  }),
});

function canvasTexture(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function hex(n) { return `#${n.toString(16).padStart(6, '0')}`; }

// ---- the animals, in field units at scale 1: hit centre at the origin, facing +x, hooves at y = -FOOT

/** A leg: a pivot at the hip with a tapered cylinder hanging to the ground. */
function leg(mat, x, z, hipY, r, len) {
  const pivot = new THREE.Group();
  pivot.position.set(x, hipY, z);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.7, len, 6).translate(0, -len / 2, 0), mat);
  m.castShadow = true;
  pivot.add(m);
  return pivot;
}

function part(geo, mat, x, y, z, sx = 1, sy = 1, sz = 1, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.rotation.z = rz;
  m.castShadow = true;
  return m;
}

/** Names the head, so a browser test can click exactly where the player sees it. */
function markHead(m) { m.name = 'head'; return m; }

/**
 * Three species built from a handful of primitives each, flat shaded. Every
 * call makes a fresh group (the meshes are per animal) but the geometries and
 * materials passed in are shared.
 */
function buildAnimal(species, G, M) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const legs = [];
  const hip = -0.08;
  if (species === 0) {
    // DEER: a long tan body, a raised neck, antlers.
    body.add(part(G.sphere, M.deer, 0, 0.02, 0, 0.56, 0.27, 0.22));
    body.add(part(G.sphere, M.belly, 0.02, -0.1, 0, 0.42, 0.13, 0.18));
    body.add(part(G.cyl, M.deer, 0.42, 0.3, 0, 0.11, 0.42, 0.11, -0.55));
    body.add(markHead(part(G.sphere, M.deer, 0.62, 0.5, 0, 0.17, 0.1, 0.1, -0.3)));
    body.add(part(G.cone, M.dark, 0.78, 0.44, 0, 0.05, 0.08, 0.05, -1.9));
    body.add(part(G.cone, M.deer, 0.52, 0.64, 0.07, 0.05, 0.12, 0.03, 0.4));
    body.add(part(G.cone, M.deer, 0.52, 0.64, -0.07, 0.05, 0.12, 0.03, 0.4));
    for (const s of [1, -1]) {
      body.add(part(G.cyl, M.antler, 0.56, 0.78, 0.06 * s, 0.022, 0.3, 0.022, 0.35));
      body.add(part(G.cyl, M.antler, 0.47, 0.92, 0.08 * s, 0.018, 0.16, 0.018, 1.0));
      body.add(part(G.cyl, M.antler, 0.62, 0.9, 0.07 * s, 0.018, 0.14, 0.018, -0.4));
    }
    body.add(part(G.sphere, M.belly, -0.56, 0.12, 0, 0.07, 0.09, 0.07));
    body.add(part(G.sphere, M.eye, 0.68, 0.54, 0.075, 0.025, 0.025, 0.025));
    body.add(part(G.sphere, M.eye, 0.68, 0.54, -0.075, 0.025, 0.025, 0.025));
    for (const [x, z] of [[0.36, 0.1], [0.36, -0.1], [-0.38, 0.1], [-0.38, -0.1]]) legs.push(leg(M.deer, x, z, hip, 0.045, 0.55 + hip));
  } else if (species === 1) {
    // BOAR: a heavy dark wedge, a ridge of bristle, a pale tusk.
    body.add(part(G.sphere, M.boar, 0, 0.04, 0, 0.6, 0.33, 0.29));
    body.add(part(G.sphere, M.bristle, -0.05, 0.27, 0, 0.5, 0.12, 0.12));
    body.add(markHead(part(G.cone, M.boar, 0.68, 0.0, 0, 0.21, 0.36, 0.21, -Math.PI / 2)));
    body.add(part(G.cyl, M.snout, 0.86, -0.04, 0, 0.08, 0.06, 0.08, Math.PI / 2));
    body.add(part(G.cone, M.boar, 0.5, 0.24, 0.12, 0.06, 0.12, 0.03, -0.3));
    body.add(part(G.cone, M.boar, 0.5, 0.24, -0.12, 0.06, 0.12, 0.03, -0.3));
    body.add(part(G.cone, M.tusk, 0.8, 0.04, 0.08, 0.02, 0.12, 0.02, -0.5));
    body.add(part(G.cone, M.tusk, 0.8, 0.04, -0.08, 0.02, 0.12, 0.02, -0.5));
    body.add(part(G.sphere, M.eye, 0.66, 0.12, 0.13, 0.025, 0.025, 0.025));
    body.add(part(G.sphere, M.eye, 0.66, 0.12, -0.13, 0.025, 0.025, 0.025));
    for (const [x, z] of [[0.36, 0.13], [0.36, -0.13], [-0.36, 0.13], [-0.36, -0.13]]) legs.push(leg(M.dark, x, z, -0.18, 0.06, 0.55 - 0.18));
  } else {
    // HARE: small, a big haunch, long ears, a white scut.
    body.add(part(G.sphere, M.hare, -0.04, -0.06, 0, 0.36, 0.24, 0.2));
    body.add(part(G.sphere, M.hare, -0.2, -0.12, 0, 0.2, 0.2, 0.2));
    body.add(markHead(part(G.sphere, M.hare, 0.3, 0.1, 0, 0.16, 0.14, 0.13)));
    body.add(part(G.sphere, M.hare, 0.24, 0.42, 0.05, 0.05, 0.22, 0.035, 0.25));
    body.add(part(G.sphere, M.hare, 0.2, 0.42, -0.05, 0.05, 0.22, 0.035, 0.35));
    body.add(part(G.sphere, M.dark, 0.17, 0.6, 0.05, 0.03, 0.06, 0.025, 0.25));
    body.add(part(G.sphere, M.belly, -0.4, -0.02, 0, 0.09, 0.09, 0.09));
    body.add(part(G.sphere, M.eye, 0.38, 0.14, 0.09, 0.022, 0.022, 0.022));
    body.add(part(G.sphere, M.eye, 0.38, 0.14, -0.09, 0.022, 0.022, 0.022));
    for (const [x, z, r] of [[0.22, 0.07, 0.03], [0.22, -0.07, 0.03], [-0.22, 0.1, 0.045], [-0.22, -0.1, 0.045]]) {
      legs.push(leg(M.hare, x, z, -0.16, r, 0.55 - 0.16));
    }
  }
  for (const l of legs) body.add(l);
  return { root, body, legs };
}

// ---------------------------------------------------------------------------

class HuntView extends RiteView {
  constructor(stage, rite) {
    // Looked down into the clearing from a high blind, a little from the right:
    // steep enough that the three lanes stand on one ground, low enough that
    // the treeline and the sky still close the top of the frame.
    super(stage, rite, { frame: FRAMES.upright, fov: 40, tilt: -24, yaw: 8, margin: 0.05 });
    this.mood = rite.night ? MOODS.night : MOODS.dusk;
    this.P = readPalette();
    this.rng = mulberry32(rite.fxSeed >>> 0);
    this.tints = RIVAL_TINTS.map((c, i) => new THREE.Color(i === 0 ? this.P.accent : c));
    this.scene.background = new THREE.Color(this.mood.fog);
    this.scene.fog = new THREE.Fog(this.mood.fog, this.mood.fogNear, this.mood.fogFar);
    this.scene.environment = stage.environment();
    this.scene.environmentIntensity = 0.12;

    this.clock = 0;
    this.recoil = 0;
    this.flash = 0;
    this.sway = 0;
    this._tmp = new THREE.Vector3();
    this._tmp3 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._pos = { x: 0, y: 0 };
    this._camBase = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this.laneK = [1, 1, 1];
    this.laneDepth = [0, 0, 0];
    this.laneFoot = [0, 0, 0];
    this.laneZ = [0, 0, 0];
    this._hudTaken = -1;
    this._plates = new Int32Array(RIVAL_COUNT).fill(-1);
    this.rivalFire = new Float32Array(RIVAL_COUNT);
    /** Which animals' bushes already threw their leaves. View state, never the rite's. */
    this.rustled = new Uint8Array(ANIMALS);

    this.#buildLights();
    this.#buildTextures();
    this.#buildSky();
    this.#buildGround();
    this.#buildForest();
    this.#buildBushes();
    this.#buildStands();
    this.#buildAnimals();
    this.#buildBlind();
    this.#buildRifle();
    this.#buildCrosshair();
    this.#buildFx();
    this._built = true;
    this.layout(16 / 9);
    this.render(0, 0);
    for (const t of this.popTex) stage.renderer.initTexture(t);
    // Everything that is hidden until play reveals it is shown for the one
    // draw the host makes behind the intro card, so its buffers upload there
    // and not on the frame the first deer breaks cover. The next render()
    // hides it again.
    for (const it of this.items) it.root.visible = true;
    for (const b of this.blobs) b.visible = true;
    for (const T of this.tracers) T.m.visible = true;
    for (const p of this.pops) p.s.visible = true;
    this.cross.visible = true;
  }

  // ---- construction -------------------------------------------------------

  #buildLights() {
    const m = this.mood;
    const { hemi, key } = addStandardLights(this.scene, {
      sky: m.hemiSky, ground: m.hemiGround, hemi: m.hemi, keyColor: m.key, key: m.keyI,
      keyFrom: new THREE.Vector3(...m.keyFrom), shadow: this.stage.shadows, shadowPad: 7,
    });
    this.hemi = hemi; this.key = key;
    // Both always present, intensity 0 when idle: a changing light count is a
    // recompile of every lit material (docs/PERF_BUDGET.md, Round 11).
    this.muzzleLight = new THREE.PointLight(0xffc070, 0, 16, 1.6);
    this.rivalLight = new THREE.PointLight(0xffc070, 0, 14, 1.6);
    this.scene.add(this.muzzleLight, this.rivalLight);
  }

  #buildTextures() {
    const rnd = this.rng;
    const g3 = this.mood.grass;
    this.grassTex = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = hex(g3[0]); g.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) {
        g.fillStyle = hex(g3[i % 3]);
        g.globalAlpha = 0.18 + rnd() * 0.3;
        const x = rnd() * w, y = rnd() * h;
        g.fillRect(x, y, 1 + rnd() * 2, 3 + rnd() * 6);
      }
      g.globalAlpha = 1;
    });
    this.grassTex.wrapS = this.grassTex.wrapT = THREE.RepeatWrapping;
    this.grassTex.repeat.set(26, 24);
    this.glowTex = canvasTexture(64, 64, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.3, 'rgba(255,230,180,0.55)');
      r.addColorStop(1, 'rgba(255,200,120,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    });
    this.rayTex = canvasTexture(64, 256, (g, w, h) => {
      const v = g.createLinearGradient(0, 0, 0, h);
      v.addColorStop(0, 'rgba(255,240,210,0.0)');
      v.addColorStop(0.25, 'rgba(255,240,210,0.6)');
      v.addColorStop(1, 'rgba(255,240,210,0)');
      g.fillStyle = v; g.fillRect(0, 0, w, h);
      const hgr = g.createLinearGradient(0, 0, w, 0);
      hgr.addColorStop(0, 'rgba(0,0,0,1)'); hgr.addColorStop(0.5, 'rgba(0,0,0,0)'); hgr.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = hgr; g.fillRect(0, 0, w, h);
    });
  }

  /** A gradient dome and a low sun behind the treeline. Unfogged: it IS the haze. */
  #buildSky() {
    const m = this.mood;
    const geo = new THREE.SphereGeometry(160, 24, 16);
    const col = new Float32Array(geo.attributes.position.count * 3);
    const top = new THREE.Color(m.skyTop), mid = new THREE.Color(m.skyMid), hor = new THREE.Color(m.horizon);
    const c = new THREE.Color();
    for (let i = 0; i < geo.attributes.position.count; i++) {
      const y = geo.attributes.position.getY(i) / 160;
      if (y < 0.08) c.copy(hor);
      else if (y < 0.35) c.copy(hor).lerp(mid, (y - 0.08) / 0.27);
      else c.copy(mid).lerp(top, Math.min(1, (y - 0.35) / 0.5));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    }));
    this.sky.renderOrder = -10;
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: m.sun, fog: false, depthWrite: false, transparent: true,
      blending: THREE.AdditiveBlending,
    }));
    this.sun.renderOrder = -9;
    this.scene.add(this.sky, this.sun);
  }

  /**
   * The ground: one wide sheet with vertex colours (a lit clearing fading into
   * the forest floor), bent in `layout` so the three lanes' foot lines lie on it.
   */
  #buildGround() {
    const geo = new THREE.PlaneGeometry(150, 130, 60, 64).rotateX(-Math.PI / 2).translate(0, 0, -45);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    this.groundBump = new Float32Array(n);
    const lit = new THREE.Color(this.mood.lit), dim = new THREE.Color(this.mood.dim), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x = geo.attributes.position.getX(i), z = geo.attributes.position.getZ(i);
      const d = Math.hypot(x / 16, (z + 1) / 7);
      c.copy(dim).lerp(lit, clamp(1.15 - d * 0.6, 0, 1));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      // Rolling ground away from the clearing; flat where the animals run.
      const wild = clamp((Math.abs(x) - 11) / 10, 0, 1) + clamp((-z - 8) / 14, 0, 1);
      this.groundBump[i] = wild * (0.6 * Math.sin(x * 0.21 + z * 0.13) + 0.5 * Math.sin(z * 0.27 - x * 0.07) + 0.8);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: this.grassTex, vertexColors: true, roughness: 0.95, metalness: 0,
    }));
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  /** Ground height at world z (and x, for the hills). Valid after layout. */
  groundY(x, z) {
    const zs = this.laneZ, ys = this.laneFoot;
    let y;
    if (z >= zs[0]) y = ys[0];
    else if (z >= zs[1]) y = ys[1] + (ys[0] - ys[1]) * (z - zs[1]) / (zs[0] - zs[1]);
    else if (z >= zs[2]) y = ys[2] + (ys[1] - ys[2]) * (z - zs[2]) / (zs[1] - zs[2]);
    else y = ys[2] + (zs[2] - z) * 0.05;
    const wild = clamp((Math.abs(x) - 11) / 10, 0, 1) + clamp((-z - 8) / 14, 0, 1);
    return y + wild * (0.6 * Math.sin(x * 0.21 + z * 0.13) + 0.5 * Math.sin(z * 0.27 - x * 0.07) + 0.8);
  }

  /** Pines and autumn broadleaves, instanced, placed on the ground in layout. */
  #buildForest() {
    const rnd = this.rng;
    const pine = mergeGeometries([
      new THREE.ConeGeometry(1.5, 2.4, 7).translate(0, 2.2, 0),
      new THREE.ConeGeometry(1.2, 2.1, 7).translate(0, 3.5, 0),
      new THREE.ConeGeometry(0.85, 1.8, 7).translate(0, 4.7, 0),
    ]);
    const leaf = new THREE.IcosahedronGeometry(1.6, 0).translate(0, 3.2, 0);
    const trunk = new THREE.CylinderGeometry(0.16, 0.26, 3.2, 6).translate(0, 1.6, 0);
    const N = 150;
    const crownMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 });
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 1 });
    this.pines = new THREE.InstancedMesh(pine, crownMat, N);
    this.leaves = new THREE.InstancedMesh(leaf, crownMat, N);
    this.trunks = new THREE.InstancedMesh(trunk, trunkMat, N * 2);
    this.pines.castShadow = this.leaves.castShadow = true;
    const pineCols = [0x23402c, 0x2c4a2e, 0x1d3626, 0x34532f];
    const leafCols = [0xc9762e, 0xd99a3a, 0xa6452a, 0x8a8a34, 0xe0b14a];
    const dim = this.rite.night ? 0.45 : 1;
    this.treeSpots = [];
    for (let i = 0; i < N * 2; i++) {
      // Two belts: a ring hugging the clearing (sides and back) and the deep
      // forest climbing away behind it. Never in front of the near lane.
      const deep = i >= N;
      let x, z;
      if (!deep) {
        const a = rnd();
        if (a < 0.62) { x = (rnd() * 2 - 1) * 26; z = -8.5 - rnd() * 9; }
        else { const sd = a < 0.81 ? -1 : 1; x = sd * (12.5 + rnd() * 12); z = 5 - rnd() * 14; }
      } else { x = (rnd() * 2 - 1) * 60; z = -15 - rnd() * 50; }
      const sc = (deep ? 1.1 : 0.85) + rnd() * 0.65;
      const isPine = rnd() < (this.rite.night ? 0.75 : 0.55);
      const color = new THREE.Color(isPine ? pineCols[i % pineCols.length] : leafCols[i % leafCols.length]);
      if (!isPine) color.multiplyScalar(dim);
      this.treeSpots.push({ x, z, s: sc, isPine, color, rot: rnd() * 6.28, lean: (rnd() - 0.5) * 0.08 });
    }
    // Every colour slot filled now, so both meshes carry the attribute from the
    // first compile; layout() rewrites them in placement order.
    for (let k = 0; k < N; k++) {
      this.pines.setColorAt(k, this.treeSpots[k].color);
      this.leaves.setColorAt(k, this.treeSpots[k].color);
    }
    this.scene.add(this.pines, this.leaves, this.trunks);
  }

  /** One bush per cover point of every lane: three lumps, flat shaded. */
  #buildBushes() {
    const rnd = this.rng;
    const lumps = [];
    for (let v = 0; v < 3; v++) {
      const parts = [];
      for (let k = 0; k < 4; k++) {
        const r = 0.24 + rnd() * 0.12;
        parts.push(new THREE.IcosahedronGeometry(r, 0)
          .translate((k - 1.5) * 0.2 + (rnd() - 0.5) * 0.08, r * 0.9 + rnd() * 0.08, (rnd() - 0.5) * 0.25));
      }
      // Normalised to a unit box standing on y = 0, so render() sizes it in field units.
      const geo = mergeGeometries(parts);
      geo.computeBoundingBox();
      const b = geo.boundingBox;
      geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
      geo.scale(1 / (b.max.x - b.min.x), 1 / (b.max.y - b.min.y), 1 / (b.max.z - b.min.z));
      lumps.push(geo);
    }
    // Greens only: anything brown in the clearing is a target, never cover.
    this.bushMat = [
      new THREE.MeshStandardMaterial({ color: 0x3f6a2c, flatShading: true, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ color: 0x55712e, flatShading: true, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ color: 0x2f5a34, flatShading: true, roughness: 0.9 }),
    ];
    if (this.rite.night) for (const m of this.bushMat) m.color.multiplyScalar(0.6);
    this.bushes = LANES.map((L, lane) => L.cover.map((x, j) => {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(lumps[(lane + j) % 3], this.bushMat[(lane * 2 + j) % 3]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      this.scene.add(g);
      return { g, mesh, x, lane };
    }));
  }

  #buildStands() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a3e28, roughness: 0.95 });
    const post = new THREE.CylinderGeometry(0.05, 0.06, 1, 6).translate(0, -0.5, 0);
    const plank = new THREE.BoxGeometry(1, 1, 1);
    this.plateCanvas = [];
    this.plateTex = [];
    this.stands = [];
    for (let k = 0; k < RIVAL_COUNT; k++) {
      const g = new THREE.Group();
      const posts = [];
      for (const [x, z] of [[-0.5, 0.35], [0.5, 0.35], [-0.5, -0.35], [0.5, -0.35]]) {
        const p = new THREE.Mesh(post, wood);
        p.position.set(x, 0, z);
        p.castShadow = true;
        g.add(p);
        posts.push(p);
      }
      const floor = new THREE.Mesh(plank, wood);
      floor.scale.set(1.25, 0.08, 0.9);
      const rail = new THREE.Mesh(plank, wood);
      rail.scale.set(1.25, 0.32, 0.06);
      rail.position.set(0, 0.2, 0.42);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.95, 0.5, 4).rotateY(Math.PI / 4), wood);
      roof.position.y = 1.45;
      g.add(floor, rail, roof);
      for (const x of [-0.55, 0.55]) {
        const pole = new THREE.Mesh(post, wood);
        pole.position.set(x, 1.25, 0.38);
        pole.scale.y = 1.25;
        g.add(pole);
      }
      // The hunter: a coat in the rival's colour, a head, a hat, a rifle.
      const coat = new THREE.MeshStandardMaterial({ color: this.tints[k].clone().multiplyScalar(0.55), roughness: 0.8 });
      const hunter = new THREE.Group();
      hunter.position.set(0, 0.05, 0);
      const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.32, 3, 8), coat);
      torso.position.y = 0.38;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshStandardMaterial({ color: 0xd9a07a, roughness: 0.7 }));
      head.position.y = 0.78;
      const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.12, 8), wood);
      hat.position.y = 0.9;
      const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6).rotateX(Math.PI / 2), wood);
      gun.position.set(0, 0.6, 0.38);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0.6, 0.86);
      hunter.add(torso, head, hat, gun, muzzle);
      g.add(hunter);
      // The lantern: the rival's colour, brightening as their deadline nears.
      const lampMat = new THREE.MeshBasicMaterial({ color: this.tints[k], toneMapped: false });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), lampMat);
      lamp.position.set(0.5, 0.95, 0.38);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: this.tints[k], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5,
      }));
      glow.scale.setScalar(0.9);
      lamp.add(glow);
      g.add(lamp);
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: 0xffd58a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
      }));
      flash.scale.setScalar(1.6);
      muzzle.add(flash);
      // The name plate, with the tally.
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 96;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.plateCanvas.push(cv);
      this.plateTex.push(tex);
      const plate = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false, toneMapped: false }));
      plate.position.set(0, 2.05, 0);
      plate.scale.set(1.9, 0.71, 1);
      plate.renderOrder = 5;
      g.add(plate);
      this.scene.add(g);
      this.stands.push({ g, posts, hunter, muzzle, flash, glow, lampMat, plate });
    }
    // Tracers: one per rival and one for the player. A thin additive bar.
    const barGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 5).translate(0, 0.5, 0);
    this.tracers = [];
    for (let k = 0; k <= RIVAL_COUNT; k++) {
      const m = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({
        color: k < RIVAL_COUNT ? this.tints[k] : 0xffe2a8, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      m.visible = false;
      this.scene.add(m);
      this.tracers.push({ m, life: 0, from: new THREE.Vector3(), to: new THREE.Vector3() });
    }
  }

  #buildAnimals() {
    const G = {
      sphere: new THREE.IcosahedronGeometry(1, 1),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 6),
      cone: new THREE.ConeGeometry(1, 1, 6),
    };
    const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8, ...o });
    const M = {
      deer: std(0xb3743f), belly: std(0xeadcc4), antler: std(0xdccaa4), dark: std(0x2a1d14),
      // The boar is the dark one: a little self-light keeps it off the shade and the night grass.
      boar: std(0x6a5240, { emissive: 0x2a1a10 }), bristle: std(0x463428, { emissive: 0x1c120a }), snout: std(0x8a5e4c), tusk: std(0xf1e6cc),
      hare: std(0xa48766), eye: new THREE.MeshBasicMaterial({ color: 0x0c0806 }),
    };
    this.items = [];
    for (let i = 0; i < ANIMALS; i++) {
      const a = this.rite.animals[i];
      const built = buildAnimal(a.species, G, M);
      built.root.visible = false;
      this.scene.add(built.root);
      this.items.push(built);
    }
    // A soft contact shadow under each runner, so it is planted even on the
    // presets without a shadow map.
    this.blobMat = new THREE.MeshBasicMaterial({ map: this.glowTex, color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false });
    const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.blobs = [];
    for (let i = 0; i < ANIMALS; i++) {
      const b = new THREE.Mesh(blobGeo, this.blobMat);
      b.visible = false;
      this.scene.add(b);
      this.blobs.push(b);
    }
  }

  /** The front of the blind: a log rail across the bottom of the frame, the tally carved into its face. */
  #buildBlind() {
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.85 });
    this.rail = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 14).rotateZ(Math.PI / 2), wood);
    this.rail.castShadow = false;
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 1400; this.hudCanvas.height = 128;
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;
    this.hudTex.anisotropy = 4;
    this.hud = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.hudTex, transparent: true, toneMapped: false, fog: false }));
    this.hud.renderOrder = 8;
    this.scene.add(this.rail, this.hud);
  }

  #buildRifle() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x5e636b, roughness: 0.3, metalness: 0.85 });
    const stock = new THREE.MeshStandardMaterial({ color: 0x7a4220, roughness: 0.55 });
    this.rifle = new THREE.Group();
    this.rifleBody = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.065, 1.9, 12).rotateX(Math.PI / 2), metal);
    barrel.position.z = 1.05;
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 0.9), metal);
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 12).rotateX(Math.PI / 2), metal);
    scope.position.set(0, 0.24, 0.2);
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 6).rotateZ(Math.PI / 2), metal);
    bolt.position.set(0.2, 0.05, -0.15);
    const butt = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 1.2), stock);
    butt.position.set(0, -0.12, -0.95);
    butt.rotation.x = 0.12;
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 1.0), stock);
    fore.position.set(0, -0.14, 0.75);
    this.rifleBody.add(barrel, receiver, scope, bolt, butt, fore);
    this.bolt = bolt;
    this.rifle.add(this.rifleBody);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, 2.08);
    this.rifleBody.add(this.muzzle);
    this.flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffd58a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
    }));
    this.muzzle.add(this.flashSprite);
    this.scene.add(this.rifle);
  }

  /** The reticle of Lucky Shot, plus a ring of ticks that refills with the reload. */
  #buildCrosshair() {
    const mat = (color, opacity = 1) => new THREE.MeshBasicMaterial({
      color, depthTest: false, depthWrite: false, transparent: true, toneMapped: false, opacity, fog: false,
    });
    const halo = mat(0x0a0604, 0.8);
    const m = mat(0xfff6e2);
    this.crossMat = m;
    this.tickMat = mat(0xffffff, 0.95);
    this.cross = new THREE.Group();
    const add = (geo, material, order) => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.renderOrder = order;
      this.cross.add(mesh);
      return mesh;
    };
    add(new THREE.RingGeometry(0.235, 0.345, 40), halo, 10);
    add(new THREE.RingGeometry(0.265, 0.315, 40), m, 11);
    for (let q = 0; q < 4; q++) {
      const a = q * Math.PI / 2;
      for (const [w, h, material, order] of [[0.085, 0.25, halo, 10], [0.035, 0.2, m, 11]]) {
        const tick = add(new THREE.PlaneGeometry(w, h), material, order);
        tick.position.set(Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0);
        tick.rotation.z = a + Math.PI / 2;
      }
    }
    add(new THREE.CircleGeometry(0.06, 12), halo, 10);
    add(new THREE.CircleGeometry(0.03, 10), m, 11);
    const tickGeo = new THREE.PlaneGeometry(0.05, 0.11);
    this.ticks = [];
    for (let k = 0; k < TICKS; k++) {
      // Clockwise from the top, like every reload dial.
      const a = Math.PI / 2 - (k + 0.5) * (Math.PI * 2 / TICKS);
      const t = add(tickGeo, this.tickMat, 12);
      t.position.set(Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0);
      t.rotation.z = a + Math.PI / 2;
      this.ticks.push(t);
    }
    this.scene.add(this.cross);
  }

  #buildFx() {
    const seed = this.rite.fxSeed >>> 0;
    this.sparks = new Bursts({ count: 200, size: 0.1, gravity: -7, seed });
    this.dust = new Bursts({ count: 160, size: 0.2, gravity: -3, drag: 0.95, seed: seed ^ 0x5bd1e995 });
    this.scene.add(this.sparks.points, this.dust.points);

    // Every pop a cue can show, made now: +1, a snap +1, and each rival's name.
    const label = (text, color, w = 256) => canvasTexture(w, 80, (g, cw, ch) => {
      g.font = '700 50px Georgia, serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 9; g.strokeStyle = 'rgba(10,6,3,0.85)';
      g.strokeText(text, cw / 2, ch / 2 + 2);
      g.fillStyle = color; g.fillText(text, cw / 2, ch / 2 + 2);
    });
    const roster = this.rite.rivals.roster();
    this.popTex = [label('+1', this.P.gold), label('+1 SNAP', this.P.goldHi, 320)];
    for (let k = 0; k < RIVAL_COUNT; k++) this.popTex.push(label(roster[k].name.toUpperCase(), `#${this.tints[k].getHexString()}`));
    for (const t of this.popTex) this.own(t);
    this.pops = [];
    for (let k = 0; k < POPS; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.popTex[0], transparent: true, depthTest: false, toneMapped: false, fog: false,
      }));
      s.visible = false;
      s.renderOrder = 9;
      this.scene.add(s);
      this.pops.push({ s, life: 0, x: 0, y: 0, depth: 0, w: 1 });
    }
    this.popAt = 0;

    // Motes in the last light (fireflies at night): a fixed cloud, drifting.
    const geo = new THREE.BufferGeometry();
    this.motePos = new Float32Array(MOTES * 3);
    this.moteSeed = new Float32Array(MOTES * 4);
    for (let i = 0; i < MOTES; i++) {
      this.moteSeed[i * 4] = (this.rng() * 2 - 1) * 14;
      this.moteSeed[i * 4 + 1] = 0.3 + this.rng() * 3.2;
      this.moteSeed[i * 4 + 2] = 4 - this.rng() * 12;
      this.moteSeed[i * 4 + 3] = this.rng() * 6.28;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.motes = new THREE.Points(geo, new THREE.PointsMaterial({
      map: this.glowTex, color: this.mood.mote, size: this.rite.night ? 0.16 : 0.11, sizeAttenuation: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: this.rite.night ? 0.95 : 0.6,
    }));
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);

    // Light shafts through the canopy, dusk only (kept at night at opacity 0
    // so the program set is the same either way).
    this.shafts = [];
    for (let k = 0; k < 4; k++) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: this.rayTex, color: this.mood.sun, transparent: true, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending, opacity: this.rite.night ? 0 : 0.07 + 0.03 * k, side: THREE.DoubleSide,
      }));
      this.scene.add(s);
      this.shafts.push(s);
    }
  }

  // ---- layout: everything that depends on where the camera ended up ------

  layout(aspect) {
    super.layout(aspect);
    if (!this._built) return;
    const cam = this.camera;
    const f = this.frame;
    const v = this._tmp;
    const h = cam.position.z;

    for (let lane = 0; lane < LANES.length; lane++) {
      const L = LANES[lane];
      const k = K_NEAR / L.scale;
      this.laneK[lane] = k;
      this.laneDepth[lane] = (k - 1) * h;
      placeOnRay(cam, f, 0, L.y - FOOT * L.scale, this.laneDepth[lane], v);
      this.laneFoot[lane] = v.y;
      this.laneZ[lane] = v.z;
    }

    // Bend the ground through the three foot lines.
    const pos = this.ground.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.groundY(pos.getX(i), pos.getZ(i)) - 0.01);
    pos.needsUpdate = true;
    this.ground.geometry.computeVertexNormals();

    // Trees, on that ground.
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const e = new THREE.Euler();
    let np = 0, nl = 0;
    for (let i = 0; i < this.treeSpots.length; i++) {
      const T = this.treeSpots[i];
      p.set(T.x, this.groundY(T.x, T.z) - 0.1, T.z);
      q.setFromEuler(e.set(T.lean, T.rot, T.lean * 0.5));
      s.setScalar(T.s);
      m.compose(p, q, s);
      this.trunks.setMatrixAt(i, m);
      if (T.isPine) { this.pines.setColorAt(np, T.color); this.pines.setMatrixAt(np++, m); }
      else { this.leaves.setColorAt(nl, T.color); this.leaves.setMatrixAt(nl++, m); }
    }
    this.pines.count = np; this.leaves.count = nl;
    this.trunks.count = this.treeSpots.length;
    this.pines.instanceMatrix.needsUpdate = this.leaves.instanceMatrix.needsUpdate = true;
    this.trunks.instanceMatrix.needsUpdate = true;
    this.pines.instanceColor.needsUpdate = this.leaves.instanceColor.needsUpdate = true;

    // The stands, behind the far lane, legs down to the ground.
    const standDepth = this.laneDepth[2] + STAND_BACK;
    // On a small canvas (a phone on its side) the name plates would be 6 px
    // text: grow them, within the room between the stands.
    const plateGrow = clamp(PLATE_PX / Math.max(1, this.stage.cssH || PLATE_PX), 1, 1.7);
    for (let k = 0; k < RIVAL_COUNT; k++) {
      const S = this.stands[k];
      const kk = placeOnRay(cam, f, STAND_X[k], STAND_Y, standDepth, v);
      S.g.position.copy(v);
      S.g.scale.setScalar(kk * 1.05);
      S.g.rotation.y = -0.15 * Math.sign(STAND_X[k]);
      S.plate.scale.set(1.9 * plateGrow, 0.71 * plateGrow, 1);
      // Top edge pinned (it already sits near the frame's top): it grows down over the roof.
      S.plate.position.y = 2.05 - 0.355 * (plateGrow - 1);
      const drop = (v.y - this.groundY(v.x, v.z)) / (kk * 1.05);
      for (const post of S.posts) post.scale.y = Math.max(0.1, drop);
    }

    // Sky, sun and shafts: far away and up-left, behind the treeline.
    this.sky.position.copy(cam.position);
    this.sun.position.set(cam.position.x - 38, this.laneFoot[2] + 13, -95);
    this.sun.scale.setScalar(this.mood.sunSize * 2.2);
    for (let k = 0; k < this.shafts.length; k++) {
      const sh = this.shafts[k];
      sh.position.set(-9 + k * 4.2, 6.5, -6 - k * 1.5);
      sh.scale.set(2.2 + k * 0.6, 20, 1);
      sh.rotation.set(0, 0.2, 0.55);
    }

    // The blind's rail and the tally carved on it, at the bottom of the frame.
    // Close to the camera, so it stands above the ground that runs under it,
    // and square to the view so it is a sill along the bottom edge rather than
    // a log slanting across the near lane.
    let kk = placeOnRay(cam, f, 0, -4.85, -9.2, v);
    this.rail.position.copy(v);
    this.rail.quaternion.copy(cam.quaternion);
    this.rail.scale.set(30 * kk, 0.5 * kk, 0.5 * kk);
    kk = placeOnRay(cam, f, -2.0, -4.2, -9.6, v);
    this.hud.position.copy(v);
    this.hud.scale.set(10 * kk, 10 * kk * (128 / 1400), 1);
    this.hud.quaternion.copy(cam.quaternion);

    // Low in the right corner, mostly under the sill and with a short barrel:
    // wherever it points, it never covers a near or mid lane run
    // (tools/scratch/hunt-silhouette.mjs sweeps the aim and checks).
    this.rifleK = placeOnRay(cam, f, 9.9, -6.3, -7.0, v);
    this.rifleBase = v.clone();
    this.rifle.scale.setScalar(this.rifleK * 1.45);

    this._camBase.copy(cam.position);
    this.world(0, 0, this._camLook);
  }

  // ---- cues: where every effect starts -----------------------------------

  cue(ev) {
    if (ev.type === 'start') return;
    const v = this._tmp;
    if (ev.type === 'claim') {
      const a = this.rite.animals[ev.i];
      const k = ev.rival;
      placeOnRay(this.camera, this.frame, ev.x, ev.y, this.laneDepth[a.lane], v);
      if (k >= 0) {
        this.rivalFire[k] = 1;
        const S = this.stands[k];
        S.muzzle.getWorldPosition(this.rivalLight.position);
        this.#tracer(k, this.rivalLight.position, v);
        this.#pop(2 + k, ev.x, ev.y, this.laneDepth[a.lane], 1.5);
      }
      this.dust.emit(v, 14, { color: 0x6b5a44, speed: 1.4, life: 0.7, up: 0.6 });
      return;
    }
    this.recoil = 1;
    this.flash = 1;
    if (ev.type === 'miss') {
      // The round lands in the grass at roughly the depth the field y implies.
      const d = this.#missDepth(ev.y);
      placeOnRay(this.camera, this.frame, ev.x, ev.y, d, v);
      this.#tracer(RIVAL_COUNT, this.muzzleWorld(), v);
      this.dust.emit(v, 10, { color: 0x7d6a4c, speed: 1.6, life: 0.55, up: 0.9 });
      return;
    }
    const a = this.rite.animals[ev.i];
    placeOnRay(this.camera, this.frame, ev.x, ev.y, this.laneDepth[a.lane], v);
    this.#tracer(RIVAL_COUNT, this.muzzleWorld(), v);
    const snap = ev.type === 'perfect';
    this.sparks.emit(v, snap ? 46 : 26, { color: snap ? 0xffe08a : 0xffc66a, speed: snap ? 4.2 : 3, life: 0.7, up: 1.6 });
    this.dust.emit(v, 16, { color: 0x8a6a48, speed: 1.8, life: 0.6, up: 0.8 });
    this.#pop(snap ? 1 : 0, ev.x, ev.y, this.laneDepth[a.lane], snap ? 2.0 : 1.0);
  }

  muzzleWorld() {
    this.muzzle.getWorldPosition(this._tmp3);
    return this._tmp3;
  }

  #missDepth(y) {
    const L = LANES;
    if (y <= L[0].y) return this.laneDepth[0];
    if (y <= L[1].y) return this.laneDepth[0] + (this.laneDepth[1] - this.laneDepth[0]) * (y - L[0].y) / (L[1].y - L[0].y);
    if (y <= L[2].y) return this.laneDepth[1] + (this.laneDepth[2] - this.laneDepth[1]) * (y - L[1].y) / (L[2].y - L[1].y);
    return this.laneDepth[2] + Math.min(8, (y - L[2].y) * 3);
  }

  #tracer(k, from, to) {
    const T = this.tracers[k];
    T.from.copy(from);
    T.to.copy(to);
    T.life = 1;
  }

  #pop(tex, x, y, depth, w) {
    const p = this.pops[this.popAt];
    this.popAt = (this.popAt + 1) % POPS;
    p.s.material.map = this.popTex[tex];
    p.life = 1; p.x = x; p.y = y; p.depth = depth; p.w = w;
  }

  // ---- the frame ----------------------------------------------------------

  render(alpha, dt) {
    const R = this.rite;
    const t = R.t + alpha * MINIGAMES.dt;
    const cam = this.camera;
    const f = this.frame;
    const v = this._tmp;
    this.clock += dt;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.flash = Math.max(0, this.flash - dt * 14);

    // The sway, first: everything below is placed through this camera.
    const want = R.aimed ? clamp(R.aimX / FIELD.hw, -1, 1) : 0;
    this.sway += (want - this.sway) * Math.min(1, dt * 2);
    cam.position.copy(this._camBase).addScaledVector(f.ux, this.sway * SWAY);
    cam.lookAt(this._camLook);
    cam.updateMatrixWorld();
    this.sky.position.copy(cam.position);

    // Bushes, on the camera ray of their cover point; a rustle before a break.
    for (let lane = 0; lane < this.bushes.length; lane++) {
      const L = LANES[lane];
      for (const B of this.bushes[lane]) {
        const kk = placeOnRay(cam, f, B.x, L.y - FOOT * L.scale, this.laneDepth[lane] - 0.3, v);
        B.g.position.copy(v);
        B.g.scale.set(BUSH_R * 2.3 * L.scale * kk, BUSH_H * L.scale * kk, BUSH_R * 1.6 * L.scale * kk);
        B.g.rotation.z = 0;
      }
    }

    // Animals.
    for (let i = 0; i < ANIMALS; i++) {
      const a = R.animals[i];
      const it = this.items[i];
      const blob = this.blobs[i];
      const L = LANES[a.lane];
      const k = this.laneK[a.lane];
      const depth = this.laneDepth[a.lane];

      // The rustle: the bush it is about to leave shivers.
      if (a.state === 'wait' && t > a.appearAt - RUSTLE) {
        const B = this.#bushAt(a);
        if (B) {
          const r = 1 - (a.appearAt - t) / RUSTLE;
          B.g.rotation.z = Math.sin(this.clock * 38 + i) * 0.2 * r;
          B.g.scale.y *= 1 + 0.14 * r * Math.abs(Math.sin(this.clock * 31));
          if (!this.rustled[i]) {
            this.rustled[i] = 1;
            v.copy(B.g.position);
            v.y += B.g.scale.y * 0.8;
            this.dust.emit(v, 14, LEAF_PUFF);
          }
        }
      }

      const gone = a.endedAt >= 0 ? t - a.endedAt : -1;
      if (a.state === 'wait' || gone > LIE + SINK) { it.root.visible = false; blob.visible = false; continue; }
      it.root.visible = true;

      let x, y, fall = 0, sink = 0;
      if (gone < 0) {
        R.posAt(a, t, this._pos);
        x = this._pos.x; y = this._pos.y;
      } else {
        x = a.endX;
        fall = clamp(gone / FALL, 0, 1);
        sink = clamp((gone - LIE) / SINK, 0, 1);
        // A small hop up as it is hit, then down onto its side.
        y = a.endY + Math.sin(fall * Math.PI) * 0.18 * L.scale - fall * 0.28 * L.scale - sink * 0.5 * L.scale;
      }
      const kk = placeOnRay(cam, f, x, y, depth, v);
      it.root.position.copy(v);
      it.root.scale.setScalar(L.scale * kk * MODEL);
      // Facing the way it runs, turned a little toward the blind so it reads in 3/4.
      it.root.rotation.y = a.dir > 0 ? -0.32 : Math.PI + 0.32;
      it.body.rotation.x = -fall * 1.45;
      it.body.rotation.z = gone < 0 ? 0 : fall * 0.3;

      // The gait: legs swing at the stride the rite bobs at.
      if (gone < 0) {
        const since = Math.max(0, t - a.appearAt);
        const ph = since * Math.PI * 2 * (a.species === 1 ? 4.2 : a.species === 0 ? 2.4 : 3.4);
        const amp = a.species === 2 ? 0.9 : 0.65;
        for (let l = 0; l < it.legs.length; l++) {
          it.legs[l].rotation.z = Math.sin(ph + (l < 2 ? 0 : Math.PI) + (l % 2) * 0.4) * amp;
        }
        it.body.rotation.z = Math.sin(ph) * 0.06;
      } else {
        for (let l = 0; l < it.legs.length; l++) it.legs[l].rotation.z = 0.3 * fall * (l % 2 ? 1 : -1);
      }

      // The contact shadow, on the lane's ground line.
      placeOnRay(cam, f, x, L.y - FOOT * L.scale, depth, v);
      blob.visible = true;
      blob.position.set(v.x, v.y + 0.02, v.z);
      const air = gone < 0 ? (y - L.y) / L.scale : 0;
      const bs = L.scale * k * MODEL * (1.3 - air * 0.8) * (1 - sink);
      blob.scale.set(bs * 1.5, 1, bs * 0.7);
    }

    // The stands: hunters track their runner; lanterns warm as their deadline nears.
    for (let k = 0; k < RIVAL_COUNT; k++) {
      const S = this.stands[k];
      let urgency = 0;
      let target = null;
      for (let i = 0; i < ANIMALS; i++) {
        const a = R.animals[i];
        if (a.rival !== k || a.state !== 'live') continue;
        const u = clamp((t - a.appearAt) / (a.claimAt - a.appearAt), 0, 1);
        if (u >= urgency) { urgency = u; target = a; }
      }
      if (target) {
        R.posAt(target, t, this._pos);
        placeOnRay(cam, f, this._pos.x, this._pos.y, this.laneDepth[target.lane], v);
        S.g.worldToLocal(v);
        S.hunter.rotation.y = Math.atan2(v.x, v.z);
      }
      const heat = urgency * urgency;
      S.glow.material.opacity = 0.35 + 0.65 * heat + 0.25 * heat * Math.sin(this.clock * 20);
      S.glow.scale.setScalar(0.9 + 1.4 * heat);
      this.rivalFire[k] = Math.max(0, this.rivalFire[k] - dt * 9);
      S.flash.material.opacity = this.rivalFire[k];
      S.flash.scale.setScalar(1.2 + 1.6 * this.rivalFire[k]);
      if (this._plates[k] !== R.rivalKills[k]) this.#paintPlate(k);
    }
    let fire = 0;
    for (let k = 0; k < RIVAL_COUNT; k++) fire = Math.max(fire, this.rivalFire[k]);
    this.rivalLight.intensity = fire * 40;

    // Tracers.
    for (let k = 0; k < this.tracers.length; k++) {
      const T = this.tracers[k];
      if (T.life <= 0) { T.m.visible = false; continue; }
      T.life = Math.max(0, T.life - dt * 7);
      T.m.visible = true;
      T.m.position.copy(T.from);
      v.copy(T.to).sub(T.from);
      const len = v.length();
      T.m.quaternion.setFromUnitVectors(this._up, v.multiplyScalar(1 / Math.max(1e-6, len)));
      T.m.scale.set(1 + T.life, len, 1 + T.life);
      T.m.material.opacity = T.life * 0.9;
    }

    this.#paintHud();

    // Crosshair, on the gameplay plane, facing the camera, with the reload dial.
    this.cross.visible = R.aimed;
    if (this.cross.visible) {
      this.world(R.aimX, R.aimY, this.cross.position);
      this.cross.quaternion.copy(cam.quaternion);
      this.cross.scale.setScalar(1 + this.recoil * 0.4);
      const ready = 1 - clamp(R.recoil / RECOIL, 0, 1);
      const lit = Math.round(ready * TICKS);
      for (let k = 0; k < TICKS; k++) this.ticks[k].visible = k < lit;
      const blocked = clamp(1 - (R.t - R.blockedAt) / 0.25, 0, 1);
      if (blocked > 0) this.tickMat.color.setRGB(1, 0.37, 0.34);
      else if (ready >= 1) this.tickMat.color.setRGB(0.98, 0.84, 0.5);
      else this.tickMat.color.setRGB(0.9, 0.92, 0.95);
      this.tickMat.opacity = ready >= 1 ? 0.55 : 0.95;
    }

    // The rifle swings to the crosshair and kicks; the bolt cycles with the reload.
    this.rifle.position.copy(this.rifleBase);
    this.world(R.aimed ? R.aimX : 0, R.aimed ? R.aimY : -0.6, v);
    this.rifle.lookAt(v);
    this.rifleBody.position.set(0, 0, -this.recoil * 0.5);
    this.rifleBody.rotation.x = -this.recoil * 0.2;
    const cycle = clamp(R.recoil / RECOIL, 0, 1);
    this.bolt.position.z = -0.15 - Math.sin(cycle * Math.PI) * 0.35;
    this.flashSprite.material.opacity = this.flash;
    this.flashSprite.scale.setScalar(0.6 + this.flash * 1.6);
    this.muzzle.getWorldPosition(this.muzzleLight.position);
    this.muzzleLight.intensity = this.flash * 60;
    this.kick.pitch = this.recoil * 0.007;
    this.kick.y = -this.recoil * 0.035;

    // Pops.
    for (const p of this.pops) {
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.life -= dt / 1.0;
      const a = clamp(p.life, 0, 1);
      p.s.visible = true;
      placeOnRay(cam, f, p.x, p.y + 0.9 + (1 - a) * 0.8, p.depth - 0.5, p.s.position);
      p.s.material.opacity = Math.min(1, a * 2);
      const sc = this.laneK[0] * (0.75 + 0.25 * Math.min(1, (1 - a) * 6));
      p.s.scale.set(2.6 * p.w * sc, 0.84 * sc, 1);
    }

    // Motes.
    for (let i = 0; i < MOTES; i++) {
      const s0 = this.moteSeed[i * 4 + 3];
      const x = this.moteSeed[i * 4] + Math.sin(this.clock * 0.3 + s0) * 1.2;
      const z = this.moteSeed[i * 4 + 2] + Math.cos(this.clock * 0.23 + s0 * 2) * 0.9;
      this.motePos[i * 3] = x;
      this.motePos[i * 3 + 1] = this.laneFoot[1] + this.moteSeed[i * 4 + 1] + Math.sin(this.clock * 0.9 + s0 * 3) * 0.25;
      this.motePos[i * 3 + 2] = z;
    }
    this.motes.geometry.attributes.position.needsUpdate = true;
    this.motes.material.opacity = (this.rite.night ? 0.7 : 0.45) + 0.25 * Math.sin(this.clock * 2.1);

    this.sparks.update(dt);
    this.dust.update(dt);
  }

  #bushAt(a) {
    const L = LANES[a.lane];
    const x = a.x0 - a.dir * BUSH_R * L.scale;
    for (const B of this.bushes[a.lane]) if (Math.abs(B.x - x) < 1e-6) return B;
    return null;
  }

  #paintPlate(k) {
    const R = this.rite;
    this._plates[k] = R.rivalKills[k];
    const cv = this.plateCanvas[k];
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = 'rgba(12,10,8,0.72)';
    g.beginPath();
    g.roundRect(6, 10, cv.width - 12, cv.height - 20, 18);
    g.fill();
    g.strokeStyle = `#${this.tints[k].getHexString()}`;
    g.lineWidth = 4;
    g.stroke();
    g.textBaseline = 'middle';
    g.font = '700 40px Georgia, serif';
    g.fillStyle = `#${this.tints[k].getHexString()}`;
    g.textAlign = 'left';
    g.fillText(R.rivals.roster()[k].name, 24, cv.height / 2 + 2);
    g.textAlign = 'right';
    g.fillStyle = '#f3ead8';
    g.fillText(`${R.rivalKills[k]}`, cv.width - 26, cv.height / 2 + 2);
    this.plateTex[k].needsUpdate = true;
  }

  /**
   * The tally on the blind's rail: the count, then EXPECTED slots that fill
   * gold as animals are taken (the full prize is a full row), and a "+n" for
   * takes past it. Redrawn only when the count changes.
   */
  #paintHud() {
    const R = this.rite;
    if (this._hudTaken === R.taken) return;
    this._hudTaken = R.taken;
    const g = this.hudCanvas.getContext('2d');
    const W = this.hudCanvas.width, H = this.hudCanvas.height;
    const P = this.P;
    const full = R.taken >= EXPECTED;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(14,10,7,0.66)';
    g.beginPath();
    g.roundRect(4, 6, W - 8, H - 12, 52);
    g.fill();
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = '700 96px Georgia, serif';
    g.fillStyle = full ? P.goldHi : P.gold;
    g.fillText(`${R.taken}`, 44, H / 2 + 6);
    const w = g.measureText(`${R.taken}`).width;
    g.font = '600 60px Georgia, serif';
    g.fillStyle = 'rgba(236,220,184,0.75)';
    g.fillText(`/ ${EXPECTED}`, 44 + w + 14, H / 2 + 10);
    const x0 = 330, x1 = W - 190, gap = (x1 - x0) / (EXPECTED - 1);
    for (let k = 0; k < EXPECTED; k++) {
      g.beginPath();
      g.arc(x0 + k * gap, H / 2, 24, 0, Math.PI * 2);
      if (k < R.taken) { g.fillStyle = full ? P.goldHi : P.gold; g.fill(); }
      else { g.strokeStyle = 'rgba(236,220,184,0.45)'; g.lineWidth = 6; g.stroke(); }
    }
    if (R.taken > EXPECTED) {
      g.font = '700 72px Georgia, serif';
      g.fillStyle = P.goldHi;
      g.fillText(`+${R.taken - EXPECTED}`, x1 + 50, H / 2 + 6);
    }
    this.hudTex.needsUpdate = true;
  }
}

export function createView(stage, rite) {
  return new HuntView(stage, rite);
}

