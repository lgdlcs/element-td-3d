/**
 * LUCKY SHOT, IN 3D — the carnival booth for LuckyShotRite. THE REFERENCE VIEW.
 *
 * Read docs/MINIGAMES.md §8 ("Writing a 3D view") first; this file is the
 * worked example it points at. What it demonstrates, in order of importance:
 *
 *  1. IT ONLY READS THE RITE. Every frame `render(alpha, dt)` samples the rite's
 *     pure functions (`xAt`, `aliveAt`) and fields (`targets`, `ammo`, `points`)
 *     at `t = rite.t + alpha * dt` and moves its own meshes to match. Nothing
 *     here writes to the rite, and nothing the rite does depends on this file.
 *  2. DEPTH WITHOUT MOVING THE HIT TEST. The three rows sit at three real
 *     depths (they occlude, they parallax, the lamp falls off across them), but
 *     each target is placed ON THE CAMERA RAY through its field position with
 *     `placeOnRay`, scaled by the factor it returns. So the disc the rite tests
 *     a click against and the target the player sees cover the same pixels.
 *  3. EFFECTS COME FROM CUES. A shot arrives as one `cue(ev)` carrying where it
 *     landed and what it hit; the muzzle flash, the recoil, the sparks, the
 *     shattered plate, the bullet hole and the floating score all start there.
 *  4. EVERYTHING IS BUILT ONCE. Meshes, textures and particle pools are made in
 *     the constructor and only moved, shown or hidden afterwards: no allocation
 *     per frame, no material created mid-rite (each new one is a shader compile,
 *     docs/PERF_BUDGET.md), and one `dispose()` returns all of it.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MINIGAMES } from '../../core/Config.js';
import { clamp } from '../contract.js';
import { RiteView, FRAMES, placeOnRay, addStandardLights, Bursts } from '../Stage3D.js';
import {
  ROW_TABLE, TARGETS, AMMO, PAR, RESET_SPIN, LOW_AMMO, GOLDEN_MULT,
} from './LuckyShotRite.js';

/**
 * Depth of each row BEHIND the gameplay plane, front row first (negative is in
 * front of it). Presentation only: the hit test never sees these numbers.
 */
const ROW_DEPTH = [-1.6, 0.9, 3.2];
const WALL_DEPTH = 4.6;
const AWNING_DEPTH = -2.2;
const COUNTER_DEPTH = -3.2;

/** Seconds a hit target takes to fall flat. The rite knocks it down instantly; the eye needs a beat. */
const FALL_TIME = 0.12;
/** Flat on the rail, in radians: just past 80 degrees, so the face stays a sliver and never inverts. */
const DOWN_TILT = 1.42;

const BULBS = 17;
const HOLES = 24;
const POPS = 6;

/** Fallbacks match the stylesheet; read once, never per frame. */
function readPalette() {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const tok = (n, f) => (cs?.getPropertyValue(n) || '').trim() || f;
  return {
    ink: tok('--ink', '#e9ebf3'),
    ink3: tok('--ink-3', '#6d7488'),
    gold: tok('--gold', '#e5bd79'),
    goldHi: tok('--gold-hi', '#f7dfae'),
    warn: tok('--warn', '#ffb454'),
    danger: tok('--danger', '#ff5f57'),
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

// ---- silhouettes, in a unit circle (the hit disc), facing +x ---------------

function ellipseShape(cx, cy, rx, ry, rot = 0) {
  const s = new THREE.Shape();
  s.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false, rot);
  return s;
}

function polyShape(pts) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

function extrudeAll(shapes, depth = 0.14) {
  const geos = shapes.map((sh) => new THREE.ExtrudeGeometry(sh, {
    depth, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2, curveSegments: 18,
  }).translate(0, 0, -depth / 2));
  const g = mergeGeometries(geos, false);
  for (const x of geos) x.dispose();
  return g;
}

const SILHOUETTES = {
  duck: () => extrudeAll([
    ellipseShape(-0.08, -0.40, 0.88, 0.55),
    ellipseShape(0.46, 0.30, 0.36, 0.36),
    polyShape([[0.74, 0.40], [1.08, 0.27], [0.74, 0.17]]),
    polyShape([[-0.80, -0.22], [-1.0, 0.22], [-0.60, -0.06]]),
  ]),
  rabbit: () => extrudeAll([
    ellipseShape(0, -0.42, 0.62, 0.55),
    ellipseShape(0.12, 0.24, 0.34, 0.31),
    ellipseShape(-0.04, 0.70, 0.11, 0.33, 0.12),
    ellipseShape(0.26, 0.68, 0.10, 0.31, -0.18),
    ellipseShape(-0.64, -0.44, 0.16, 0.16),
  ]),
  plate: () => new THREE.CylinderGeometry(0.95, 0.95, 0.12, 40).rotateX(Math.PI / 2),
  figure: () => extrudeAll([
    ellipseShape(0, -0.36, 0.48, 0.56),
    ellipseShape(0, 0.36, 0.29, 0.29),
    polyShape([[-0.30, -0.12], [-0.46, -0.02], [-0.86, 0.66], [-0.70, 0.76]]),
    polyShape([[0.30, -0.12], [0.46, -0.02], [0.86, 0.66], [0.70, 0.76]]),
    ellipseShape(-0.80, 0.78, 0.14, 0.14),
    ellipseShape(0.80, 0.78, 0.14, 0.14),
  ]),
};

/** Where the value badge sits on each silhouette, and its radius. */
const BADGE = {
  duck: { x: -0.12, y: -0.40, r: 0.36 },
  rabbit: { x: 0.0, y: -0.42, r: 0.36 },
  plate: { x: 0, y: 0, r: 0.56 },
  figure: { x: 0, y: -0.36, r: 0.32 },
};
const EYE = { duck: [0.58, 0.40], rabbit: [0.24, 0.30] };

const ROW_KIND = ['duck', 'rabbit', 'plate'];

// ---------------------------------------------------------------------------

class LuckyShotView extends RiteView {
  constructor(stage, rite) {
    super(stage, rite, { frame: FRAMES.upright, fov: 42, tilt: -9, background: 0x0d0805 });
    this.scene.environment = stage.environment();
    this.scene.environmentIntensity = 0.3;
    this.P = readPalette();
    this.clock = 0;
    this.recoil = 0;
    this.flash = 0;
    this.golden = 0;
    this.hitAt = new Float64Array(TARGETS).fill(-1e9);
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._hudKey = '';

    this.#buildLights();
    this.#buildTextures();
    this.#buildBooth();
    this.#buildTargets();
    this.#buildRifle();
    this.#buildCrosshair();
    this.#buildFx();
    this._built = true;
    this.layout(16 / 9);
  }

  // ---- construction -------------------------------------------------------

  #buildLights() {
    const { hemi, key } = addStandardLights(this.scene, {
      sky: 0xffd9a8, ground: 0x1c100a, hemi: 0.45, keyColor: 0xffe2b8, key: 2.3,
      keyFrom: new THREE.Vector3(-5, 9, 14), shadow: this.stage.shadows, shadowPad: 6,
    });
    this.hemi = hemi; this.key = key;
    this.baseHemi = hemi.intensity; this.baseKey = key.intensity;
    // Always present, intensity 0 when idle: toggling `visible` would change the
    // light count and recompile every lit material on the first shot.
    this.muzzleLight = new THREE.PointLight(0xffc070, 0, 14, 1.6);
    this.scene.add(this.muzzleLight);
  }

  #buildTextures() {
    const tex = (label, bg, fg, ring) => canvasTexture(128, 128, (g, w, h) => {
      g.fillStyle = ring; g.beginPath(); g.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); g.fill();
      g.fillStyle = bg; g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = fg;
      g.font = `700 ${label.length > 1 ? 54 : 74}px Georgia, 'Times New Roman', serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, w / 2, h / 2 + 4);
    });
    this.badgeTex = {
      1: tex('1', '#fbf3df', '#2a1a10', '#8a2a22'),
      2: tex('2', '#fbf3df', '#2a1a10', '#8a2a22'),
      3: tex('3', '#fbf3df', '#2a1a10', '#8a2a22'),
      golden: tex(`${GOLDEN_MULT}x`, '#2a1a08', '#ffd76a', '#ffd76a'),
      bystander: tex('-1', '#fbf3df', '#c0261d', '#c0261d'),
    };
    this.badgeMat = {};
    for (const [k, t] of Object.entries(this.badgeTex)) {
      this.own(t);
      this.badgeMat[k] = this.own(new THREE.MeshBasicMaterial({ map: t, toneMapped: false }));
    }
    this.plateFace = canvasTexture(256, 256, (g, w) => {
      const c = w / 2;
      const rings = ['#f4ede0', '#c8322a', '#f4ede0', '#c8322a', '#f4ede0'];
      rings.forEach((col, i) => {
        g.fillStyle = col; g.beginPath(); g.arc(c, c, c * (1 - i * 0.17), 0, Math.PI * 2); g.fill();
      });
    });
    this.wallTex = canvasTexture(512, 256, (g, w, h) => {
      for (let i = 0; i < 16; i++) {
        g.fillStyle = i % 2 ? '#3b1712' : '#45201a';
        g.fillRect(i * (w / 16), 0, w / 16, h);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(i * (w / 16), 0, 2, h);
      }
      const star = (x, y, r) => {
        g.beginPath();
        for (let k = 0; k < 10; k++) {
          const a = -Math.PI / 2 + k * Math.PI / 5;
          const rr = k % 2 ? r * 0.45 : r;
          g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        g.closePath(); g.fill();
      };
      g.fillStyle = 'rgba(240, 196, 110, 0.18)';
      for (let i = 0; i < 9; i++) star(28 + i * 57, 40 + (i % 2) * 30, 9);
      const v = g.createLinearGradient(0, 0, 0, h);
      v.addColorStop(0, 'rgba(0,0,0,0.0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
      g.fillStyle = v; g.fillRect(0, 0, w, h);
    });
    this.wallTex.wrapS = THREE.RepeatWrapping;
    this.glowTex = canvasTexture(64, 64, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.25, 'rgba(255,220,150,0.6)');
      r.addColorStop(1, 'rgba(255,180,80,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    });
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 2048; this.hudCanvas.height = 112;
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;
    this.hudTex.anisotropy = 4;
  }

  #buildBooth() {
    const S = this.scene;
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b3f22, roughness: 0.75, metalness: 0.0 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x2c1a0f, roughness: 0.85 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a050, roughness: 0.3, metalness: 0.9 });
    this.mats = { wood, darkWood, brass };

    this.wall = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial({ map: this.wallTex, roughness: 0.95 }));
    this.wall.receiveShadow = true;
    S.add(this.wall);

    // Rails and the boards hung under them, one per row. A real gallery hides
    // the target stalks behind a painted board; the board's top edge is the
    // rail, so it never covers a target's own silhouette (which IS its hitbox).
    const boardMat = [
      new THREE.MeshStandardMaterial({ color: 0x2e6aa8, roughness: 0.6 }),
      new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 0.7 }),
      darkWood,
    ];
    const crest = [new THREE.MeshStandardMaterial({ color: 0x7fb4e0, roughness: 0.5 }), null, null];
    this.rows = ROW_TABLE.map((R, row) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), brass);
      const board = new THREE.Mesh(this.#boardGeometry(row), boardMat[row]);
      board.receiveShadow = true;
      S.add(rail, board);
      let crestMesh = null;
      if (crest[row]) {
        crestMesh = new THREE.Mesh(this.#boardGeometry(row, 0.5), crest[row]);
        S.add(crestMesh);
      }
      return { rail, board, crest: crestMesh };
    });

    // The awning: stripes, a scalloped hem, and a string of bulbs.
    const red = new THREE.MeshStandardMaterial({ color: 0xa8232b, roughness: 0.8 });
    const cream = new THREE.MeshStandardMaterial({ color: 0xecdcb8, roughness: 0.8 });
    this.awning = new THREE.Group();
    const stripes = 12;
    for (let k = 0; k < stripes; k++) {
      const m = k % 2 ? cream : red;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.08), m);
      panel.position.set(-11 + (k + 0.5) * (22 / stripes), 0.45, 0);
      panel.scale.set(22 / stripes, 0.9, 1);
      const hem = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20, Math.PI, Math.PI), m);
      hem.position.set(panel.position.x, 0.0, 0.041);
      hem.scale.set(22 / stripes, 0.55, 1);
      this.awning.add(panel, hem);
    }
    S.add(this.awning);

    this.bulbMat = [];
    this.bulbs = new THREE.Group();
    for (let k = 0; k < BULBS; k++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, toneMapped: false });
      this.bulbMat.push(mat);
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), mat);
      b.position.set(-8 + (k / (BULBS - 1)) * 16, 0, 0);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: 0xffc46a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55,
      }));
      glow.scale.setScalar(0.65);
      b.add(glow);
      this.bulbs.add(b);
    }
    S.add(this.bulbs);

    // The counter in front, the scoreboard painted on its face, the rounds
    // standing on top of it. One spent per shot: the ammo count is an object
    // on the counter, not a number in a corner.
    this.counter = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wood);
    this.counterTop = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), darkWood);
    this.hud = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.hudTex, transparent: true, toneMapped: false }));
    S.add(this.counter, this.counterTop, this.hud);

    const shell = mergeGeometries([
      new THREE.CylinderGeometry(0.07, 0.07, 0.34, 10).translate(0, 0.17, 0).toNonIndexed(),
      new THREE.ConeGeometry(0.06, 0.14, 10).translate(0, 0.41, 0).toNonIndexed(),
    ], false);
    this.shells = new THREE.InstancedMesh(shell, brass, AMMO);
    this.shells.frustumCulled = false;
    S.add(this.shells);

    this.holeMat = new THREE.MeshBasicMaterial({ color: 0x050302 });
    this.holes = [];
    this.holeAt = 0;
    for (let k = 0; k < HOLES; k++) {
      const h = new THREE.Mesh(new THREE.CircleGeometry(0.06, 10), this.holeMat);
      h.visible = false;
      S.add(h);
      this.holes.push(h);
    }
  }

  /** A painted board under a rail: waves for the ducks, grass for the rabbits, a plank for the plates. Unit height, hangs down from y = 0. */
  #boardGeometry(row, lift = 0) {
    const s = new THREE.Shape();
    const W = 13;
    s.moveTo(-W, -1);
    // Every crest stays at or below y = 0, the rail: a board that rose over a
    // target's feet would hide part of the disc the rite tests the click
    // against, and a hitbox that is partly invisible is a lie.
    if (row === 0) {
      for (let k = 0; k <= 104; k++) {
        const x = -W + (k / 104) * 2 * W;
        s.lineTo(x, -0.13 - lift * 0.25 + 0.12 * Math.sin(x * 2.2 + lift * 1.6));
      }
    } else if (row === 1) {
      for (let k = 0; k <= 120; k++) {
        const x = -W + (k / 120) * 2 * W;
        s.lineTo(x, k % 2 ? 0 : -0.16);
      }
    } else {
      s.lineTo(-W, 0); s.lineTo(W, 0);
    }
    s.lineTo(W, -1);
    s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: false, curveSegments: 4 });
  }

  #buildTargets() {
    this.geo = Object.fromEntries(Object.entries(SILHOUETTES).map(([k, f]) => [k, f()]));
    this.badgeGeo = new THREE.CircleGeometry(1, 28);
    this.eyeGeo = new THREE.CircleGeometry(0.06, 10);
    const tin = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.34, metalness: 0.5 });
    this.bodyMat = {
      duck: tin(0xf0bd2c),
      rabbit: tin(0xa9b8c8),
      plate: [
        new THREE.MeshStandardMaterial({ color: 0xe9e0cc, roughness: 0.6 }),
        new THREE.MeshStandardMaterial({ map: this.plateFace, roughness: 0.55 }),
        new THREE.MeshStandardMaterial({ color: 0xbdb3a0, roughness: 0.7 }),
      ],
      golden: new THREE.MeshStandardMaterial({
        color: 0xffc642, roughness: 0.2, metalness: 0.95, emissive: 0x7a4a00, emissiveIntensity: 0.55,
      }),
      figure: new THREE.MeshStandardMaterial({ color: 0xf1e6d0, roughness: 0.85 }),
    };
    for (const m of Object.values(this.bodyMat)) [].concat(m).forEach((x) => this.own(x));
    this.bodyMat.goldenPlate = [this.bodyMat.golden, this.bodyMat.golden, this.bodyMat.golden];
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0x140b06 });

    this.items = [];
    for (let i = 0; i < TARGETS; i++) {
      const tg = this.rite.targets[i];
      const kind = tg.kind === 'bystander' ? 'figure' : ROW_KIND[tg.row];
      const pivot = new THREE.Group();
      const body = new THREE.Group();
      body.position.y = 1;
      const mesh = new THREE.Mesh(this.geo[kind], this.bodyMat.duck);
      mesh.castShadow = true;
      const b = BADGE[kind];
      const badge = new THREE.Mesh(this.badgeGeo, this.badgeMat[1]);
      badge.position.set(b.x, b.y, kind === 'plate' ? 0.065 : 0.11);
      badge.scale.setScalar(b.r);
      body.add(mesh, badge);
      if (EYE[kind]) {
        const eye = new THREE.Mesh(this.eyeGeo, this.eyeMat);
        eye.position.set(EYE[kind][0], EYE[kind][1], 0.11);
        body.add(eye);
      }
      pivot.add(body);
      this.scene.add(pivot);
      this.items.push({ pivot, body, mesh, badge, kind, look: '' });
    }

    this.star = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffd25a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this.scene.add(this.star);
  }

  #buildRifle() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.28, metalness: 0.85 });
    const stock = new THREE.MeshStandardMaterial({ color: 0x7a4220, roughness: 0.5 });
    this.rifle = new THREE.Group();
    this.rifleBody = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 2.6, 14).rotateX(Math.PI / 2), metal);
    barrel.position.z = 1.4;
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.3, 0.9), metal);
    receiver.position.z = 0.0;
    const butt = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 1.2), stock);
    butt.position.set(0, -0.12, -0.95);
    butt.rotation.x = 0.12;
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 1.1), stock);
    fore.position.set(0, -0.14, 0.8);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.06), metal);
    sight.position.set(0, 0.11, 2.62);
    this.rifleBody.add(barrel, receiver, butt, fore, sight);
    this.rifle.add(this.rifleBody);
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, 2.78);
    this.rifleBody.add(this.muzzle);
    this.flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffd58a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
    }));
    this.muzzle.add(this.flashSprite);
    this.scene.add(this.rifle);
  }

  #buildCrosshair() {
    const m = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this.P.goldHi), depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
    });
    this.crossMat = m;
    this.cross = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.31, 40), m);
    this.cross.add(ring);
    for (let q = 0; q < 4; q++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.2), m);
      const a = q * Math.PI / 2;
      tick.position.set(Math.cos(a) * 0.46, Math.sin(a) * 0.46, 0);
      tick.rotation.z = a + Math.PI / 2;
      this.cross.add(tick);
    }
    this.cross.add(new THREE.Mesh(new THREE.CircleGeometry(0.03, 10), m));
    this.cross.renderOrder = 10;
    this.cross.traverse((o) => { o.renderOrder = 10; });
    this.scene.add(this.cross);
  }

  #buildFx() {
    this.sparks = new Bursts({ count: 220, size: 0.09, gravity: -8 });
    this.shards = new Bursts({ count: 160, size: 0.11, gravity: -14, additive: false, drag: 0.99 });
    this.scene.add(this.sparks.points, this.shards.points);
    this.popTex = new Map();
    this.pops = [];
    for (let k = 0; k < POPS; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, toneMapped: false }));
      s.visible = false;
      s.renderOrder = 9;
      this.scene.add(s);
      this.pops.push({ s, life: 0, x: 0, y: 0 });
    }
    this.popAt = 0;
  }

  #popTexture(value) {
    const label = value > 0 ? `+${value}` : `${value}`;
    let t = this.popTex.get(label);
    if (!t) {
      const col = value < 0 ? this.P.danger : value > 3 ? this.P.goldHi : this.P.gold;
      t = canvasTexture(128, 64, (g, w, h) => {
        g.font = '700 50px Georgia, serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 8; g.strokeStyle = 'rgba(10,6,3,0.85)';
        g.strokeText(label, w / 2, h / 2 + 2);
        g.fillStyle = col; g.fillText(label, w / 2, h / 2 + 2);
      });
      this.popTex.set(label, t);
    }
    return t;
  }

  // ---- layout: everything that depends on where the camera ended up ------

  layout(aspect) {
    super.layout(aspect);
    if (!this._built) return;
    const cam = this.camera;
    const f = this.frame;
    const v = this._tmp;

    let k = placeOnRay(cam, f, 0, 0.6, WALL_DEPTH, v);
    this.wall.position.copy(v);
    this.wall.scale.set(24 * k, 12 * k, 1);
    this.wallTex.repeat.set(1.5, 1);

    this.rowK = [];
    ROW_TABLE.forEach((R, row) => {
      const r = this.rite.rowR[row];
      const foot = R.y - r * 1.02;
      const kk = placeOnRay(cam, f, 0, foot, ROW_DEPTH[row] - 0.25, v);
      this.rowK[row] = placeOnRay(cam, f, 0, 0, ROW_DEPTH[row], this._tmp2);
      const { rail, board, crest } = this.rows[row];
      rail.position.copy(v);
      rail.scale.set(26 * kk, 0.07 * kk, 0.12 * kk);
      const below = row === 0 ? foot - (-3.45) : row === 1 ? 0.95 : 0.85;
      placeOnRay(cam, f, 0, foot, ROW_DEPTH[row] - 0.32, v);
      board.position.copy(v);
      board.scale.set(kk, below * kk, kk);
      if (crest) {
        placeOnRay(cam, f, 0, foot, ROW_DEPTH[row] - 0.55, v);
        crest.position.copy(v);
        crest.scale.set(kk, below * kk * 0.6, kk);
      }
    });

    k = placeOnRay(cam, f, 0, 3.72, AWNING_DEPTH, v);
    this.awning.position.copy(v);
    this.awning.scale.setScalar(k);
    k = placeOnRay(cam, f, 0, 3.5, AWNING_DEPTH + 0.1, v);
    this.bulbs.position.copy(v);
    this.bulbs.scale.setScalar(k);

    // Box depths are in world units along the plane normal (world z here), so
    // the counter's front face sits at COUNTER_DEPTH - 0.6 and the scoreboard
    // is painted just in front of it, below the lip of the top slab.
    k = placeOnRay(cam, f, 0, -4.2, COUNTER_DEPTH, v);
    this.counter.position.copy(v);
    this.counter.scale.set(26 * k, 1.7 * k, 1.2);
    k = placeOnRay(cam, f, 0, -3.36, COUNTER_DEPTH, v);
    this.counterTop.position.copy(v);
    this.counterTop.scale.set(26 * k, 0.1 * k, 1.3);
    k = placeOnRay(cam, f, 0, -4.08, COUNTER_DEPTH - 0.62, v);
    this.hud.position.copy(v);
    this.hud.scale.set(15.0 * k, 15.0 * k * (112 / 2048), 1);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    for (let s = 0; s < AMMO; s++) {
      const x = 7.4 - s * 0.25;
      const kk = placeOnRay(cam, f, x, -3.31, COUNTER_DEPTH - 0.1, v);
      m.compose(v, q, new THREE.Vector3(kk, kk, kk));
      this.shells.setMatrixAt(s, m);
    }
    this.shells.instanceMatrix.needsUpdate = true;
    this.shellK = placeOnRay(cam, f, 0, 0, COUNTER_DEPTH, v);

    this.wallK = placeOnRay(cam, f, 0, 0, WALL_DEPTH, v);
    this.rifleK = placeOnRay(cam, f, 5.6, -4.4, -6.2, v);
    this.rifleBase = v.clone();
    this.rifle.scale.setScalar(this.rifleK * 1.45);
    this._ammoShown = -1;
  }

  // ---- cues: where every effect starts -----------------------------------

  cue(ev) {
    if (ev.type === 'start' || ev.i === undefined) return;
    this.recoil = 1;
    this.flash = 1;
    const v = this._tmp;
    if (ev.i < 0) {
      // The round flew on to the back wall: a dust puff and a hole that stays.
      placeOnRay(this.camera, this.frame, ev.x, ev.y, WALL_DEPTH - 0.02, v);
      const h = this.holes[this.holeAt];
      this.holeAt = (this.holeAt + 1) % HOLES;
      h.position.copy(v);
      h.scale.setScalar(this.wallK);
      h.visible = true;
      this.sparks.emit(v, 8, { color: 0x8a7056, speed: 1.6, life: 0.45, up: 0.6 });
      return;
    }
    this.hitAt[ev.i] = this.rite.t;
    const row = this.rite.targets[ev.i].row;
    placeOnRay(this.camera, this.frame, ev.x, ev.y, ROW_DEPTH[row] - 0.2, v);
    if (ev.type === 'break') {
      this.sparks.emit(v, 26, { color: 0xff4a3a, speed: 3.6, life: 0.6 });
    } else if (ev.type === 'perfect') {
      this.golden = 1;
      this.sparks.emit(v, 60, { color: 0xffd25a, speed: 5, life: 0.9, up: 2.5 });
    } else if (row === 2) {
      this.shards.emit(v, 30, { color: 0xf0e6d4, speed: 3.6, life: 0.8, up: 2 });
      this.shards.emit(v, 16, { color: 0xc8322a, speed: 3.2, life: 0.8, up: 2 });
    } else {
      this.sparks.emit(v, 22, { color: 0xffdb8a, speed: 3.2, life: 0.5 });
    }
    const p = this.pops[this.popAt];
    this.popAt = (this.popAt + 1) % POPS;
    p.s.material.map = this.#popTexture(ev.value);
    p.s.material.needsUpdate = true;
    p.life = 0.9; p.x = ev.x; p.y = ev.y;
  }

  // ---- the frame ----------------------------------------------------------

  render(alpha, dt) {
    const R = this.rite;
    const t = R.t + alpha * MINIGAMES.dt;
    const cam = this.camera;
    const f = this.frame;
    const v = this._tmp;
    this.clock += dt;
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.flash = Math.max(0, this.flash - dt * 14);
    this.golden = Math.max(0, this.golden - dt * 2.4);

    // Targets.
    let goldenItem = -1;
    for (let i = 0; i < TARGETS; i++) {
      const tg = R.targets[i];
      const it = this.items[i];
      const x = R.xAt(i, t);
      if (x < -9.6 || x > 9.6) { it.pivot.visible = false; continue; }
      it.pivot.visible = true;
      const r = R.rowR[tg.row];
      const kk = placeOnRay(cam, f, x, ROW_TABLE[tg.row].y - r, ROW_DEPTH[tg.row], v);
      it.pivot.position.copy(v);
      it.pivot.scale.setScalar(r * kk);

      const down = t < tg.downUntil;
      const rise = down ? clamp(1 - (tg.downUntil - t) / RESET_SPIN, 0, 1) : 1;
      const fall = clamp((t - this.hitAt[i]) / FALL_TIME, 0, 1);
      const lying = down ? Math.min(fall, 1 - rise) : 0;
      const shattered = it.kind === 'plate' && down && rise === 0 && fall >= 1;
      it.body.visible = !shattered;
      it.pivot.rotation.x = -lying * DOWN_TILT;
      it.pivot.rotation.z = Math.sin(this.clock * 3 + i) * 0.03 * (1 - lying);

      const look = tg.kind === 'creep' ? `c${tg.value}` : tg.kind;
      if (look !== it.look) this.#dress(it, tg, look);
      if (tg.kind === 'golden' && !down) goldenItem = i;
    }

    if (goldenItem >= 0) {
      const it = this.items[goldenItem];
      const r = R.rowR[R.targets[goldenItem].row];
      this.star.visible = true;
      it.pivot.updateMatrixWorld();
      v.set(0, 2.15, 0.2);
      it.pivot.localToWorld(v);
      this.star.position.copy(v);
      const pulse = 0.75 + 0.25 * Math.sin(this.clock * 7);
      this.star.scale.setScalar(r * 2.0 * pulse * this.rowK[R.targets[goldenItem].row]);
      this.star.material.rotation = this.clock * 1.5;
    } else {
      this.star.visible = false;
    }

    // Bulbs chase along the awning, faster for a beat after the golden.
    for (let k = 0; k < BULBS; k++) {
      const on = 0.55 + 0.45 * Math.max(0, Math.sin(this.clock * (3 + this.golden * 9) - k * 0.9));
      this.bulbMat[k].color.setRGB(1.0 * on + 0.2, 0.86 * on + 0.1, 0.55 * on);
    }

    // The rounds on the counter.
    if (R.ammo !== this._ammoShown) {
      this._ammoShown = R.ammo;
      this.shells.count = Math.max(0, R.ammo);
    }
    this.#paintHud();

    // Crosshair, on the gameplay plane, facing the camera.
    this.cross.visible = R.aimed && R.ammo > 0;
    if (this.cross.visible) {
      this.world(R.aimX, R.aimY, this.cross.position);
      this.cross.quaternion.copy(cam.quaternion);
      this.cross.scale.setScalar(1 + this.recoil * 0.5);
      this.crossMat.opacity = 0.8 + 0.2 * this.recoil;
    }

    // The rifle swings to the crosshair and kicks.
    this.rifle.position.copy(this.rifleBase);
    this.world(R.aimed ? R.aimX : 0, R.aimed ? R.aimY : -0.6, v);
    this.rifle.lookAt(v);
    this.rifleBody.position.set(0, 0, -this.recoil * 0.45);
    this.rifleBody.rotation.x = -this.recoil * 0.16;
    this.flashSprite.material.opacity = this.flash;
    this.flashSprite.scale.setScalar(0.6 + this.flash * 1.4);
    this.muzzle.getWorldPosition(this.muzzleLight.position);
    this.muzzleLight.intensity = this.flash * 60;

    // The whole booth flares when the golden goes down; recoil nods the camera.
    this.hemi.intensity = this.baseHemi * (1 + this.golden * 0.9);
    this.key.intensity = this.baseKey * (1 + this.golden * 0.6);
    this.kick.pitch = this.recoil * 0.006;
    this.kick.y = -this.recoil * 0.03;

    // Floating scores.
    for (const p of this.pops) {
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.life -= dt;
      const a = clamp(p.life / 0.9, 0, 1);
      p.s.visible = true;
      this.world(p.x, p.y + 0.6 + (1 - a) * 0.9, p.s.position);
      p.s.position.z += 0.5;
      p.s.material.opacity = Math.min(1, a * 1.8);
      p.s.scale.set(1.3, 0.65, 1);
    }

    this.sparks.update(dt);
    this.shards.update(dt);
  }

  #dress(it, tg, look) {
    it.look = look;
    const golden = tg.kind === 'golden';
    if (it.kind === 'plate') it.mesh.material = golden ? this.bodyMat.goldenPlate : this.bodyMat.plate;
    else if (it.kind === 'figure') it.mesh.material = this.bodyMat.figure;
    else it.mesh.material = golden ? this.bodyMat.golden : this.bodyMat[it.kind];
    it.badge.material = golden ? this.badgeMat.golden
      : tg.kind === 'bystander' ? this.badgeMat.bystander
        : this.badgeMat[tg.value] ?? this.badgeMat[1];
    // Ducks and rabbits face the way their belt runs.
    const dir = ROW_TABLE[tg.row].dir * this.rite.dirFlip;
    it.body.scale.x = it.kind === 'duck' || it.kind === 'rabbit' ? dir : 1;
    it.badge.scale.x = Math.abs(it.badge.scale.x) * (it.body.scale.x < 0 ? -1 : 1);
  }

  /** Redrawn only when something on it changed. A CanvasTexture upload per frame is the one cost here worth avoiding. */
  #paintHud() {
    const R = this.rite;
    const low = R.ammo <= LOW_AMMO;
    const pulse = low && R.ammo > 0 ? Math.round((Math.sin(this.clock * 9) * 0.5 + 0.5) * 3) : 0;
    const key = `${R.points}|${R.ammo}|${R.bestStreak}|${pulse}`;
    if (key === this._hudKey) return;
    this._hudKey = key;
    const g = this.hudCanvas.getContext('2d');
    const W = this.hudCanvas.width, H = this.hudCanvas.height;
    g.clearRect(0, 0, W, H);
    const P = this.P;
    g.textBaseline = 'middle';
    g.font = '600 88px Georgia, serif';
    g.textAlign = 'left';
    g.fillStyle = P.goldHi;
    g.fillText(`${R.points}`, 24, H / 2 + 4);
    const w = g.measureText(`${R.points}`).width;
    g.font = '600 38px ui-monospace, Menlo, monospace';
    g.fillStyle = 'rgba(236, 220, 184, 0.75)';
    g.fillText(`/ ${PAR} PTS`, 24 + w + 18, H / 2 + 10);
    // Rounds in the MIDDLE, not the right: the rifle rests over the right of
    // the counter and the one number a player glances at mid-volley must not
    // be under it.
    const col = R.ammo <= 0 ? P.danger : low ? P.warn : P.goldHi;
    const label = R.ammo <= 0 ? 'OUT OF ROUNDS' : 'ROUNDS';
    g.font = '600 88px Georgia, serif';
    const aw = g.measureText(`${R.ammo}`).width;
    g.font = '600 38px ui-monospace, Menlo, monospace';
    const lw = g.measureText(label).width;
    const x0 = W * 0.47 - (aw + 18 + lw) / 2;
    g.textAlign = 'left';
    g.globalAlpha = low && R.ammo > 0 ? 0.7 + pulse * 0.1 : 1;
    g.fillStyle = col;
    g.fillText(label, x0, H / 2 + 10);
    g.font = '600 88px Georgia, serif';
    g.fillText(`${R.ammo}`, x0 + lw + 18, H / 2 + 4);
    g.globalAlpha = 1;
    if (R.bestStreak > 1) {
      g.font = '600 38px ui-monospace, Menlo, monospace';
      g.fillStyle = 'rgba(236, 220, 184, 0.75)';
      g.fillText(`STREAK ${R.bestStreak}`, 24 + w + 18 + g.measureText(`/ ${PAR} PTS`).width + 40, H / 2 + 10);
    }
    g.globalAlpha = 1;
    this.hudTex.needsUpdate = true;
  }

  dispose() {
    for (const t of this.popTex.values()) this.own(t);
    super.dispose();
  }
}

export function createView(stage, rite) {
  return new LuckyShotView(stage, rite);
}
