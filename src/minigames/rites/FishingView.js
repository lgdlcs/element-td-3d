/**
 * FISHING, IN 3D — a lake at dawn seen from the end of a pier, for FishingRite.
 *
 * Read LuckyShotView.js first; this view follows its five rules. What is
 * specific here:
 *
 *  1. THE FIELD IS THE WATER SURFACE (FRAMES.ground). The pick lands on the
 *     surface, the lure splashes down on it, and every fish is drawn under it
 *     ON THE CAMERA RAY through its field position at its own depth
 *     (`placeOnRay`). So a deep fish looks deep (smaller, bluer, its shadow
 *     further from it on the lake bed) and still covers the pixels its catch
 *     ellipse is tested against. The depth is cosmetic and never reaches the rite.
 *  2. THE LEAD IS DRAWN. Every fish trails a wake on the surface exactly as
 *     long as the distance it swims during one flight of the lure; the first
 *     casts also show a ring where the lure should land (`ghostCasts`).
 *  3. THE FLIGHT IS VISIBLE. The lure arcs from the rod tip to the reticle in
 *     FLIGHT seconds, splashes, and either comes back with a fish flying out of
 *     the water toward you or is reeled in empty. A rival's float appears over
 *     the fish it is about to take, on a line from its boat, and at the deadline
 *     the fish is yanked out of the water toward that boat.
 *  4. Everything is built once; render() reads the rite and moves meshes.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MINIGAMES } from '../../core/Config.js';
import { mulberry32 } from '../../core/Rng.js';
import { clamp, FIELD } from '../contract.js';
import { RiteView, FRAMES, placeOnRay, addStandardLights, Bursts } from '../Stage3D.js';
import { FISH, FLIGHT, PAR, GOLD_VALUE, SWIMMING, KEPT, LOST } from './FishingRite.js';

/** How far the camera drifts toward the aim at the field's edge, in world units. */
const SWAY = 0.7;
/** A rival's float shows over its fish for this long before the deadline. */
const CONTEST = 1.5;
/** Seconds a claimed fish takes to fly to the rival's boat. */
const YANK = 0.8;
/** Seconds your catch takes to leap out of the water and land in the creel. Presentation only. */
const LAND = 0.9;
/**
 * Drawn size of a fish against its length in the rite. A little larger than the
 * body the rite measures, still well inside the catch ellipse (half-length plus
 * the lure's radius), so a fish never looks caught by a lure that missed it.
 */
const FISH_LOOK = 1.25;
/** Points on each fishing line. */
const LINE_PTS = 16;
const RINGS = 10;
const POPS = 5;
const SPARKLE = Object.freeze({ color: 0xffe08a, speed: 0.6, life: 0.6, up: 0.9 });
/** Where the rival boats float, in field units: beyond the far edge, never over a fish. */
const BOATS = [[-6.4, 6.2], [0.6, 6.9], [6.8, 6.0]];
const RIVAL_COLOR = [0xe0573f, 0x4f9be6, 0xa77be0];
const RIVAL_CSS = ['#e0573f', '#4f9be6', '#a77be0'];
/** The lake's half-extent, in world units: the terrain bowl rises to the shore past it. */
const LAKE_X = 11;
const LAKE_FAR = 8.6;
const LAKE_NEAR = 6.5;

/** Height of the lake bed (and of the shore around it) at world (x, z). */
function bedY(x, z) {
  const zn = z < 0 ? -z / LAKE_FAR : z / LAKE_NEAR;
  const e = Math.sqrt(Math.sqrt((x / LAKE_X) ** 4 + zn ** 4));
  const d = clamp((e - 0.62) / 0.42, 0, 1);
  const s = d * d * (3 - 2 * d);
  return -1.75 + 2.15 * s + 0.06 * Math.sin(x * 1.3) * Math.sin(z * 1.1);
}

function readPalette() {
  const cs = typeof getComputedStyle === 'function' && typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement) : null;
  const tok = (n, f) => (cs?.getPropertyValue(n) || '').trim() || f;
  return {
    accent: tok('--rite-fishing-accent', '#6cc3dd'),
    gold: tok('--gold', '#e5bd79'),
    goldHi: tok('--gold-hi', '#f7dfae'),
    ink: tok('--ink', '#e9ebf3'),
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

class FishingView extends RiteView {
  constructor(stage, rite) {
    // From the end of the pier, well above the water: the lake bed and the
    // fish read through the surface, the far shore and the boats stand up
    // behind it. The margin is the room the sway needs.
    super(stage, rite, { frame: FRAMES.ground, fov: 40, tilt: 60, yaw: 0, margin: 0.03, background: 0xe9b48f });
    this.scene.environment = stage.environment();
    this.scene.environmentIntensity = 0.5;
    this.scene.fog = new THREE.Fog(0xe9b896, 45, 140);
    this.P = readPalette();
    this.rng = mulberry32(rite.fxSeed >>> 0);
    this.clock = 0;
    this.sway = 0;
    this.flick = 0;
    this.joy = 0;
    this.sparkleAt = 0;
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._lure = new THREE.Vector3();
    this._camBase = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._basket = new THREE.Vector3();
    this._boatTip = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this._hud = { points: -1, w: 0 };
    this._labels = [-1, -1, -1];
    this.labelK = 1;
    this.textures = [];

    this.#buildLights();
    this.#buildTextures();
    this.#buildWorld();
    this.#buildFish();
    this.#buildBoats();
    this.#buildRod();
    this.#buildMarks();
    this.#buildFx();
    this.#buildHud();
    this._built = true;
    this.layout(16 / 9);
    this.render(0, 0);
    for (const t of this.textures) stage.renderer.initTexture(t);
    // Pooled effects are hidden until a cue needs them, and the host's compile
    // only sees visible objects. Shown for that one compile; every render
    // decides each one's visibility again, so no program is built mid-rite.
    for (const o of this.pooled) o.visible = true;
    this.dial.geometry.setDrawRange(0, Infinity);
  }

  #tex(t) { this.textures.push(t); return this.own(t); }

  // ---- construction -------------------------------------------------------

  #buildLights() {
    // A low dawn sun across the far shore, so the water throws a glint back at
    // the pier and the fish backs catch a rim of warm light.
    const { hemi, key } = addStandardLights(this.scene, {
      sky: 0xc4d4f0, ground: 0x2c3a24, hemi: 0.8, keyColor: 0xffcf9a, key: 2.6,
      keyFrom: new THREE.Vector3(-9, 9, -12), shadow: this.stage.shadows, shadowPad: 5,
    });
    this.hemi = hemi; this.key = key;
    this.baseHemi = hemi.intensity;
  }

  #buildTextures() {
    this.skyTex = this.#tex(canvasTexture(8, 256, (g, w, h) => {
      const v = g.createLinearGradient(0, 0, 0, h);
      v.addColorStop(0, '#26355e');
      v.addColorStop(0.32, '#5d6f9e');
      v.addColorStop(0.44, '#d79a8c');
      v.addColorStop(0.5, '#f6c896');
      v.addColorStop(0.56, '#e9b896');
      v.addColorStop(1, '#3a4a3a');
      g.fillStyle = v; g.fillRect(0, 0, w, h);
    }));
    // What the water reflects: the dawn sky with the sun low on the left, not
    // the shared studio room (whose light panels read as white blotches).
    this.skyEnv = this.#tex(canvasTexture(256, 128, (g, w, h) => {
      const v = g.createLinearGradient(0, 0, 0, h);
      v.addColorStop(0, '#2a3a66');
      v.addColorStop(0.3, '#6d7fae');
      v.addColorStop(0.46, '#f1b98e');
      v.addColorStop(0.5, '#ffd9a6');
      v.addColorStop(0.53, '#4f6a4a');
      v.addColorStop(1, '#1d2a1c');
      g.fillStyle = v; g.fillRect(0, 0, w, h);
      const sun = g.createRadialGradient(w * 0.62, h * 0.47, 0, w * 0.62, h * 0.47, w * 0.12);
      sun.addColorStop(0, 'rgba(255,240,210,1)');
      sun.addColorStop(1, 'rgba(255,200,140,0)');
      g.fillStyle = sun; g.fillRect(0, 0, w, h);
    }));
    this.skyEnv.mapping = THREE.EquirectangularReflectionMapping;
    this.glowTex = this.#tex(canvasTexture(64, 64, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.3, 'rgba(255,230,170,0.55)');
      r.addColorStop(1, 'rgba(255,200,120,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    }));
    this.blobTex = this.#tex(canvasTexture(64, 64, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(0,0,0,0.75)');
      r.addColorStop(0.55, 'rgba(0,0,0,0.35)');
      r.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    }));
    // A V of ripples, fish at the right edge, closed by a ripple at the left:
    // the tail end is the lead, so it must read, not fade out.
    this.wakeTex = this.#tex(canvasTexture(256, 64, (g, w, h) => {
      const fade = g.createLinearGradient(0, 0, w, 0);
      fade.addColorStop(0, 'rgba(255,255,255,0.5)');
      fade.addColorStop(0.75, 'rgba(255,255,255,0.75)');
      fade.addColorStop(1, 'rgba(255,255,255,0.95)');
      g.strokeStyle = fade;
      g.lineCap = 'round';
      for (const s of [-1, 1]) {
        g.lineWidth = 5;
        g.beginPath(); g.moveTo(w - 8, h / 2); g.lineTo(0, h / 2 + s * (h / 2 - 4)); g.stroke();
        g.lineWidth = 3;
        g.beginPath(); g.moveTo(w * 0.62, h / 2 + s * 4); g.lineTo(0, h / 2 + s * (h / 4)); g.stroke();
      }
      g.fillStyle = fade;
      g.globalAlpha = 0.35;
      g.fillRect(0, h / 2 - 3, w, 6);
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineWidth = 6;
      g.beginPath(); g.moveTo(12, 3); g.quadraticCurveTo(-4, h / 2, 12, h - 3); g.stroke();
    }));
    this.wakeTex.anisotropy = 8;
    this.ringTex = this.#tex(canvasTexture(128, 128, (g, w) => {
      g.strokeStyle = '#ffffff'; g.lineWidth = 7;
      g.setLineDash([14, 10]);
      g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 6, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(w / 2, w / 2, 7, 0, Math.PI * 2); g.fill();
    }));
    const skin = (back, side, belly, spot) => canvasTexture(128, 64, (g, w, h) => {
      const v = g.createLinearGradient(0, 0, 0, h);
      v.addColorStop(0, back); v.addColorStop(0.35, side); v.addColorStop(0.7, belly); v.addColorStop(1, belly);
      g.fillStyle = v; g.fillRect(0, 0, w, h);
      const r = mulberry32(7);
      g.fillStyle = spot;
      for (let i = 0; i < 70; i++) {
        g.beginPath(); g.arc(r() * w, r() * h * 0.45, 1 + r() * 2.2, 0, Math.PI * 2); g.fill();
      }
    });
    this.skinTex = this.#tex(skin('#3e5a3c', '#8fa27a', '#e8e4cf', 'rgba(30,40,24,0.55)'));
    this.goldTex = this.#tex(skin('#b0661a', '#ffbe3d', '#fff0b8', 'rgba(150,70,10,0.5)'));
    this.waterNormal = this.#tex(this.#normalTexture(256));
    this.waterNormal.colorSpace = THREE.NoColorSpace;
    this.waterNormal.wrapS = this.waterNormal.wrapT = THREE.RepeatWrapping;
    this.waterNormal.repeat.set(4, 3);
  }

  /** A tiling ripple normal map from a sum of sines, so the surface moves without a shader of its own. */
  #normalTexture(n) {
    return canvasTexture(n, n, (g) => {
      const img = g.createImageData(n, n);
      const waves = [];
      for (let i = 0; i < 6; i++) {
        waves.push({ kx: Math.round(1 + this.rng() * 5), ky: Math.round(this.rng() * 6 - 3), a: 0.4 + this.rng() * 0.6, p: this.rng() * 6.283 });
      }
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let dx = 0, dy = 0;
          for (const w of waves) {
            const ph = ((w.kx * x + w.ky * y) / n) * 6.283 + w.p;
            const c = Math.cos(ph) * w.a;
            dx += c * w.kx; dy += c * w.ky;
          }
          const len = Math.hypot(dx * 0.05, dy * 0.05, 1);
          const o = (y * n + x) * 4;
          img.data[o] = 128 + (dx * 0.05 / len) * 127;
          img.data[o + 1] = 128 + (dy * 0.05 / len) * 127;
          img.data[o + 2] = 128 + (1 / len) * 127;
          img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    });
  }

  #buildWorld() {
    const S = this.scene;
    // Sky dome and the low sun.
    const sky = new THREE.Mesh(new THREE.SphereGeometry(110, 24, 16),
      new THREE.MeshBasicMaterial({ map: this.skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
    sky.renderOrder = -10;
    S.add(sky);
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffd9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
    }));
    this.sun.position.set(-38, 6, -90);
    this.sun.scale.setScalar(34);
    S.add(this.sun);

    // Ground and lake bed in one mesh: a bowl that rises to the shore.
    const geo = new THREE.PlaneGeometry(110, 80, 110, 80).rotateX(-Math.PI / 2).translate(0, 0, -14);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const deep = new THREE.Color(0x0c2a2b), silt = new THREE.Color(0x3d4a33), wet = new THREE.Color(0x7a6a46);
    const sand = new THREE.Color(0xc2a874);
    const grass = new THREE.Color(0x5b7a37), grass2 = new THREE.Color(0x3f5c2b), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const y = bedY(x, z);
      pos.setY(i, y);
      const n = 0.5 + 0.5 * Math.sin(x * 0.9 + z * 0.4) * Math.sin(z * 0.7 - x * 0.3);
      if (y < -0.9) c.copy(deep).lerp(silt, clamp((y + 1.75) / 0.85, 0, 1) * 0.6);
      else if (y < 0.05) c.copy(silt).lerp(wet, clamp((y + 0.9) / 0.95, 0, 1));
      else if (y < 0.2) c.copy(sand);
      else c.copy(grass).lerp(grass2, n);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    ground.receiveShadow = true;
    S.add(ground);

    // The water. Translucent, so the bed and the fish read through it.
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(2 * LAKE_X + 6, LAKE_FAR + LAKE_NEAR + 6).rotateX(-Math.PI / 2)
      .translate(0, 0, (LAKE_NEAR - LAKE_FAR) / 2),
    new THREE.MeshStandardMaterial({
      color: 0x2f7f8c, transparent: true, opacity: 0.5, roughness: 0.14, metalness: 0.15,
      normalMap: this.waterNormal, normalScale: new THREE.Vector2(0.22, 0.22), depthWrite: false,
      envMap: this.skyEnv, envMapIntensity: 1.1,
    }));
    this.water.renderOrder = 1;
    S.add(this.water);

    // Distant hills, then pines on the shores.
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x4a5d5a, roughness: 1, flatShading: true });
    for (let i = 0; i < 9; i++) {
      const h = new THREE.Mesh(new THREE.ConeGeometry(14 + this.rng() * 12, 9 + this.rng() * 10, 7), hillMat);
      h.position.set(-70 + i * 17 + this.rng() * 6, 0, -48 - this.rng() * 18);
      S.add(h);
    }
    const pine = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.16, 0.8, 6).translate(0, 0.4, 0).toNonIndexed(),
      new THREE.ConeGeometry(0.9, 2.0, 7).translate(0, 1.6, 0).toNonIndexed(),
      new THREE.ConeGeometry(0.7, 1.6, 7).translate(0, 2.4, 0).toNonIndexed(),
    ], false);
    const spots = [];
    for (let i = 0; i < 160 && spots.length < 90; i++) {
      const side = this.rng();
      const x = side < 0.6 ? -26 + this.rng() * 52 : (side < 0.8 ? -1 : 1) * (13 + this.rng() * 12);
      const z = side < 0.6 ? -11 - this.rng() * 14 : -12 + this.rng() * 16;
      if (bedY(x, z) < 0.3) continue;
      spots.push([x, z, 0.8 + this.rng() * 0.9]);
    }
    const trees = new THREE.InstancedMesh(pine, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    spots.forEach(([x, z, k], i) => {
      p.set(x, bedY(x, z) - 0.1, z); s.setScalar(k);
      m.compose(p, q, s);
      trees.setMatrixAt(i, m);
      trees.setColorAt(i, c.setHSL(0.3 + this.rng() * 0.08, 0.45, 0.13 + this.rng() * 0.08));
    });
    trees.castShadow = true;
    S.add(trees);

    // Reeds along the side shores: they hide the seam where a fish leaves and
    // comes back, so the shoal swims in and out of cover.
    const reed = new THREE.ConeGeometry(0.035, 1.2, 4).translate(0, 0.6, 0);
    const reedSpots = [];
    for (let i = 0; i < 240 && reedSpots.length < 140; i++) {
      const sx = this.rng() < 0.5 ? -1 : 1;
      const x = sx * (9.3 + this.rng() * 1.6);
      const z = -6.5 + this.rng() * 11.5;
      reedSpots.push([x, z]);
    }
    for (let i = 0; i < 40; i++) reedSpots.push([-9 + this.rng() * 18, -8 - this.rng() * 0.9]);
    const reeds = new THREE.InstancedMesh(reed, new THREE.MeshStandardMaterial({ color: 0x8a9a4a, roughness: 0.8 }), reedSpots.length);
    reedSpots.forEach(([x, z], i) => {
      p.set(x, Math.max(bedY(x, z), -0.6), z);
      q.setFromEuler(new THREE.Euler((this.rng() - 0.5) * 0.3, 0, (this.rng() - 0.5) * 0.3));
      s.set(1, 0.7 + this.rng() * 0.8 + Math.max(0, -bedY(x, z)), 1);
      m.compose(p, q, s);
      reeds.setMatrixAt(i, m);
    });
    q.identity();
    S.add(reeds);
    this.reeds = reeds;

    // Lily pads at the edges, outside the field.
    const pad = new THREE.CircleGeometry(0.32, 14, 0.4, Math.PI * 2 - 0.5).rotateX(-Math.PI / 2);
    const pads = new THREE.InstancedMesh(pad, new THREE.MeshStandardMaterial({ color: 0x4f8a3a, roughness: 0.6 }), 18);
    for (let i = 0; i < 18; i++) {
      const sx = i % 2 ? -1 : 1;
      const x = sx * (8.7 + this.rng() * 0.9);
      const z = -6 + this.rng() * 11;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.rng() * 6.28);
      p.set(x, 0.02, z); s.setScalar(0.7 + this.rng() * 0.6);
      m.compose(p, q, s);
      pads.setMatrixAt(i, m);
    }
    S.add(pads);

    // The pier under you: planks running back from the near edge.
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a5434, roughness: 0.85 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x3c2817, roughness: 0.9 });
    this.pier = new THREE.Group();
    for (let k = 0; k < 14; k++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.12, 0.42), k % 3 ? wood : darkWood);
      plank.position.set(0, 0.55, 5.6 + k * 0.46);
      plank.rotation.y = (this.rng() - 0.5) * 0.02;
      plank.receiveShadow = true;
      this.pier.add(plank);
    }
    for (const x of [-1.45, 1.45]) {
      for (let k = 0; k < 3; k++) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 2.4, 8), darkWood);
        post.position.set(x, -0.5, 5.7 + k * 2.4);
        this.pier.add(post);
      }
    }
    // The creel the catch lands in.
    const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.4, 0.55, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xa47a42, roughness: 0.9, side: THREE.DoubleSide }));
    basket.position.set(-0.9, 0.88, 6.2);
    this.pier.add(basket);
    this.basketMesh = basket;
    S.add(this.pier);
  }

  #buildFish() {
    const body = new THREE.SphereGeometry(0.5, 18, 12).scale(1, 0.3, 0.38);
    const head = new THREE.SphereGeometry(0.5, 12, 8).scale(0.42, 0.26, 0.33).translate(0.3, 0.01, 0);
    const fin = (...pts) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pts.length * 2).fill(0.5), 2));
      g.computeVertexNormals();
      return g;
    };
    const parts = [
      body.toNonIndexed(), head.toNonIndexed(),
      fin([0.12, 0.1, 0], [-0.18, 0.1, 0], [-0.1, 0.24, 0]),
      fin([0.18, -0.03, -0.12], [0.0, -0.04, -0.13], [0.02, -0.06, -0.3]),
      fin([0.18, -0.03, 0.12], [0.0, -0.04, 0.13], [0.02, -0.06, 0.3]),
    ];
    this.fishGeo = mergeGeometries(parts, false);
    for (const g of [body, head, ...parts]) g.dispose();
    this.tailGeo = fin([0, 0, 0], [-0.3, 0.16, 0], [-0.24, 0, 0], [0, 0, 0], [-0.24, 0, 0], [-0.3, -0.14, 0]);
    this.wakeGeo = new THREE.PlaneGeometry(1, 1).translate(-0.5, 0, 0).rotateX(-Math.PI / 2);
    this.blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.wakeMat = new THREE.MeshBasicMaterial({
      map: this.wakeTex, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, color: 0xe8fbff,
    });
    this.blobMat = new THREE.MeshBasicMaterial({ map: this.blobTex, transparent: true, depthWrite: false, opacity: 0.5 });

    const R = this.rite;
    this.fish = [];
    const deepTint = new THREE.Color(0x6f9fa6);
    for (let i = 0; i < FISH; i++) {
      const f = R.fish[i];
      // Cosmetic depth below the surface: never read by the rite. The golden
      // fish swims shallow so its shine is the brightest thing in the lake.
      const depth = f.gold ? 0.22 : 0.22 + this.rng() * 0.55;
      const shade = (depth - 0.22) / 0.55;
      const mat = f.gold
        ? new THREE.MeshStandardMaterial({ map: this.goldTex, roughness: 0.3, metalness: 0.4, emissive: 0xb86a10, emissiveIntensity: 0.55, side: THREE.DoubleSide })
        : new THREE.MeshStandardMaterial({ map: this.skinTex, roughness: 0.45, metalness: 0.15, side: THREE.DoubleSide });
      if (!f.gold) mat.color.set(0xffffff).lerp(deepTint, shade * 0.75);
      const group = new THREE.Group();
      const mesh = new THREE.Mesh(this.fishGeo, mat);
      const tail = new THREE.Mesh(this.tailGeo, mat);
      tail.position.x = -0.46;
      group.add(mesh, tail);
      this.scene.add(group);
      const wake = new THREE.Mesh(this.wakeGeo, this.wakeMat);
      wake.renderOrder = 2;
      this.scene.add(wake);
      const blob = new THREE.Mesh(this.blobGeo, this.blobMat);
      blob.renderOrder = 0;
      this.scene.add(blob);
      this.fish.push({ group, tail, wake, blob, depth, phase: this.rng() * 6.28 });
    }
    this.goldGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffc94a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8,
    }));
    this.goldGlow.renderOrder = 3;
    this.scene.add(this.goldGlow);
  }

  #buildBoats() {
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x6d4a2c, roughness: 0.8 });
    const hullShape = new THREE.Shape();
    hullShape.moveTo(-1.1, 0.25); hullShape.quadraticCurveTo(-1.2, -0.2, -0.6, -0.28);
    hullShape.lineTo(0.7, -0.28); hullShape.quadraticCurveTo(1.25, -0.15, 1.35, 0.3); hullShape.lineTo(-1.1, 0.25);
    const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 0.9, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 })
      .translate(0, 0, -0.45);
    const skin = new THREE.MeshStandardMaterial({ color: 0xe8c39e, roughness: 0.7 });
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.5 });
    this.lineMats = RIVAL_COLOR.map((c) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.9 }));
    this.floatMats = RIVAL_COLOR.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, emissive: c, emissiveIntensity: 0.35 }));
    this.boats = BOATS.map(([fx, fy], r) => {
      const g = new THREE.Group();
      this.world(fx, fy, g.position);
      g.rotation.y = (r - 1) * 0.5 + 0.2;
      const hull = new THREE.Mesh(hullGeo, hullMat);
      hull.castShadow = true;
      const coat = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.38, 4, 10), this.floatMats[r]);
      coat.position.set(-0.3, 0.55, 0);
      const headM = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), skin);
      headM.position.set(-0.3, 1.02, 0);
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.18, 12), hullMat);
      hat.position.set(-0.3, 1.18, 0);
      const arm = new THREE.Group();
      arm.position.set(-0.15, 0.7, 0);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, 2.6, 6).translate(0, 1.3, 0), rodMat);
      rod.rotation.z = -0.9;
      arm.add(rod);
      const tip = new THREE.Object3D();
      tip.position.set(0, 2.6, 0);
      rod.add(tip);
      g.add(hull, coat, headM, hat, arm);
      this.scene.add(g);
      // The name over the boat: a canvas repainted only when the tally moves.
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 64;
      const tex = this.#tex(new THREE.CanvasTexture(canvas));
      tex.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
      label.position.set(fx, 2.2, -fy);
      label.scale.set(2.6, 0.65, 1);
      label.renderOrder = 6;
      this.scene.add(label);
      return { g, arm, rod, tip, canvas, tex, label, fx, fy, phase: r * 2.1 };
    });
    // One float and one line per fish, shown while a rival is about to take it.
    this.contest = [];
    const floatGeo = new THREE.SphereGeometry(0.11, 12, 8);
    for (let i = 0; i < FISH; i++) {
      const who = Math.max(0, this.rite.claimBy[i]);
      const float = new THREE.Mesh(floatGeo, this.floatMats[who]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINE_PTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const line = new THREE.Line(geo, this.lineMats[who]);
      line.frustumCulled = false;
      this.scene.add(float, line);
      this.contest.push({ float, line, who });
    }
  }

  #buildRod() {
    this.rod = new THREE.Group();
    const cork = new THREE.MeshStandardMaterial({ color: 0xb8875a, roughness: 0.8 });
    const blank = new THREE.MeshStandardMaterial({ color: 0x1d2a3a, roughness: 0.35, metalness: 0.3 });
    const reelMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.25, metalness: 0.85 });
    this.rodLen = 2.6;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.9, 10).rotateX(Math.PI / 2).translate(0, 0, 0.45), cork);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.05, this.rodLen - 0.9, 8).rotateX(Math.PI / 2)
      .translate(0, 0, 0.9 + (this.rodLen - 0.9) / 2), blank);
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 16).rotateZ(Math.PI / 2), reelMat);
    reel.position.set(0, -0.16, 0.7);
    this.reelSpin = reel;
    this.rodTip = new THREE.Object3D();
    this.rodTip.position.set(0, 0, this.rodLen);
    this.rod.add(grip, shaft, reel, this.rodTip);
    this.scene.add(this.rod);

    this.lure = new THREE.Group();
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xe0362a, roughness: 0.4 }));
    const bottom = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.4 }));
    this.lure.add(top, bottom);
    this.scene.add(this.lure);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINE_PTS * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf4f1e8, transparent: true, opacity: 0.85 }));
    this.line.frustumCulled = false;
    this.scene.add(this.line);
  }

  #buildMarks() {
    const flat = (inner, outer, segs, start = 0) => new THREE.RingGeometry(inner, outer, segs, 1, start).rotateX(-Math.PI / 2);
    const mat = (color, opacity) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, depthTest: false, toneMapped: false,
    });
    this.reticle = new THREE.Group();
    this.retHalo = new THREE.Mesh(flat(0.3, 0.46, 48), mat(0x0a1418, 0.45));
    this.retRingMat = mat(0xfff4dc, 0.95);
    this.retRing = new THREE.Mesh(flat(0.34, 0.41, 48), this.retRingMat);
    // The reel dial: a second ring whose draw range is the share of the reel done.
    this.dialMat = mat(0xffd27a, 0.95);
    this.dial = new THREE.Mesh(flat(0.48, 0.55, 48, Math.PI / 2), this.dialMat);
    this.retDot = new THREE.Mesh(new THREE.CircleGeometry(0.05, 12).rotateX(-Math.PI / 2), this.retRingMat);
    this.retHalo.renderOrder = 10; this.retRing.renderOrder = 11; this.dial.renderOrder = 11; this.retDot.renderOrder = 11;
    this.reticle.add(this.retHalo, this.retRing, this.dial, this.retDot);
    this.scene.add(this.reticle);

    this.ghost = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      map: this.ringTex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, color: 0xbff4ff,
    }));
    this.ghost.renderOrder = 9;
    this.scene.add(this.ghost);
  }

  #buildFx() {
    const seed = this.rite.fxSeed >>> 0;
    this.drops = new Bursts({ count: 240, size: 0.1, gravity: -11, drag: 0.99, seed });
    this.sparks = new Bursts({ count: 120, size: 0.12, gravity: -2, seed: seed ^ 0x5bd1e995 });
    this.scene.add(this.drops.points, this.sparks.points);
    const ringGeo = new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2);
    this.rings = [];
    for (let k = 0; k < RINGS; k++) {
      const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
      }));
      mesh.renderOrder = 3;
      mesh.visible = false;
      this.scene.add(mesh);
      this.rings.push({ mesh, life: 0, max: 1, size: 1 });
    }
    this.ringAt = 0;
    this.popTex = new Map();
    for (const v of [1, GOLD_VALUE]) {
      this.popTex.set(v, this.#tex(canvasTexture(128, 64, (g, w, h) => {
        g.font = '700 50px Georgia, serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 8; g.strokeStyle = 'rgba(6,16,20,0.85)';
        g.strokeText(`+${v}`, w / 2, h / 2 + 2);
        g.fillStyle = v > 1 ? this.P.goldHi : '#ffffff';
        g.fillText(`+${v}`, w / 2, h / 2 + 2);
      })));
    }
    this.pops = [];
    for (let k = 0; k < POPS; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.popTex.get(1), transparent: true, depthTest: false, toneMapped: false,
      }));
      s.visible = false;
      s.renderOrder = 12;
      this.scene.add(s);
      this.pops.push({ s, life: 0, x: 0, y: 0 });
    }
    this.popAt = 0;
    this.pooled = [
      ...this.rings.map((r) => r.mesh), ...this.pops.map((p) => p.s),
      ...this.contest.flatMap((c) => [c.float, c.line]), this.ghost, this.goldGlow, this.reticle, this.dial,
    ];
  }

  #buildHud() {
    // Pinned to the camera, so it sits in the same corner at every aspect.
    this.scene.add(this.camera);
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 512; this.hudCanvas.height = 128;
    this.hudTex = this.#tex(new THREE.CanvasTexture(this.hudCanvas));
    this.hudTex.colorSpace = THREE.SRGBColorSpace;
    this.hud = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.25), new THREE.MeshBasicMaterial({
      map: this.hudTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    }));
    this.hud.renderOrder = 30;
    this.camera.add(this.hud);
  }

  // ---- layout -------------------------------------------------------------

  layout(aspect) {
    super.layout(aspect);
    if (!this._built) return;
    const cam = this.camera;
    this._camBase.copy(cam.position);
    this.world(0, 0, this._camLook);
    // The rod rests low in the right corner, below the near edge of the field,
    // so it never covers a fish. The catch flies into the creel on the pier.
    const k = placeOnRay(cam, this.frame, 4.6, -6.6, -2.4, this._v);
    this.rodBase = (this.rodBase ?? new THREE.Vector3()).copy(this._v);
    this.rod.scale.setScalar(k * 1.1);
    this.pier.updateMatrixWorld();
    this.basketMesh.getWorldPosition(this._basket);
    this._basket.y += 0.35;
    // HUD: bottom-left, 1 unit in front of the lens. A share of the view
    // height, grown on a short screen so its text stays readable on a phone;
    // the boat tags grow with it.
    const cssH = this.stage.cssH || 900;
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const w = h * cam.aspect;
    const size = Math.min(h * clamp(230 / cssH, 0.34, 0.6), w * 0.36);
    this.labelK = clamp(600 / cssH, 1, 1.8);
    this.hud.scale.set(size, size, 1);
    this.hud.position.set(-w / 2 + size * 0.55, -h / 2 + size * 0.16, -1);
  }

  // ---- cues ---------------------------------------------------------------

  cue(ev) {
    if (ev.x === undefined) return;
    const v = this.world(ev.x, ev.y ?? 0, this._v);
    if (ev.type === 'tick') { this.flick = 1; return; }
    if (ev.type === 'miss') {
      this.#ring(v, 0.9, 0.9);
      this.drops.emit(v, 14, { color: 0xcfe9ee, speed: 1.8, life: 0.5, up: 2.2 });
      return;
    }
    if (ev.type === 'good' || ev.type === 'perfect') {
      const gold = ev.type === 'perfect';
      this.#ring(v, gold ? 2.0 : 1.4, 0.8);
      this.#ring(v, gold ? 1.2 : 0.8, 0.5);
      this.drops.emit(v, gold ? 50 : 30, { color: 0xe6f7fb, speed: 3.2, life: 0.75, up: 3.4 });
      if (gold) this.sparks.emit(v, 50, { color: 0xffd25a, speed: 3.5, life: 1.0, up: 2.5 });
      this.kick.pitch = gold ? 0.012 : 0.006;
      this.joy = gold ? 1 : 0.5;
      const p = this.pops[this.popAt];
      this.popAt = (this.popAt + 1) % POPS;
      p.s.material.map = this.popTex.get(ev.value) ?? p.s.material.map;
      p.life = 1.0; p.x = ev.x; p.y = ev.y;
      return;
    }
    if (ev.type === 'claim') {
      this.#ring(v, 1.1, 0.7);
      this.drops.emit(v, 22, { color: 0xe6f7fb, speed: 2.6, life: 0.6, up: 3 });
    }
  }

  #ring(at, size, life) {
    const r = this.rings[this.ringAt];
    this.ringAt = (this.ringAt + 1) % RINGS;
    r.mesh.position.set(at.x, 0.03, at.z);
    r.life = r.max = life;
    r.size = size;
  }

  // ---- the frame ----------------------------------------------------------

  render(alpha, dt) {
    const R = this.rite;
    const t = R.t + alpha * MINIGAMES.dt;
    const cam = this.camera;
    const f = this.frame;
    this.clock += dt;
    this.flick = Math.max(0, this.flick - dt * 3.2);
    this.joy = Math.max(0, this.joy - dt * 1.5);
    this.kick.pitch *= Math.max(0, 1 - dt * 10);

    const want = R.aimed ? clamp(R.aimX / FIELD.hw, -1, 1) : 0;
    this.sway += (want - this.sway) * Math.min(1, dt * 2);
    cam.position.copy(this._camBase).addScaledVector(f.ux, this.sway * SWAY);
    cam.lookAt(this._camLook);
    cam.updateMatrixWorld();

    this.waterNormal.offset.set(this.clock * 0.012, this.clock * 0.02);
    this.hemi.intensity = this.baseHemi * (1 + this.joy * 0.25);

    this.#renderFish(R, t);
    this.#renderBoats(R, t);
    this.#renderRod(R, t);
    this.#renderMarks(R, t);

    for (const r of this.rings) {
      if (r.life <= 0) { r.mesh.visible = false; continue; }
      r.life -= dt;
      const u = 1 - Math.max(0, r.life) / r.max;
      r.mesh.visible = true;
      r.mesh.scale.setScalar(0.15 + u * r.size);
      r.mesh.material.opacity = (1 - u) * 0.8;
    }
    for (const p of this.pops) {
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.life -= dt;
      const a = clamp(p.life, 0, 1);
      p.s.visible = true;
      this.world(p.x, p.y, p.s.position);
      p.s.position.y = 0.9 + (1 - a) * 1.4;
      p.s.material.opacity = Math.min(1, a * 2);
      p.s.scale.set(1.4, 0.7, 1);
    }
    this.drops.update(dt);
    this.sparks.update(dt);
    this.#paintHud();
  }

  /** Swimming fish under the surface, and the ones on their way out of the water. */
  #renderFish(R, t) {
    const cam = this.camera;
    const f = this.frame;
    const v = this._v;
    let goldShown = false;
    for (let i = 0; i < FISH; i++) {
      const F = R.fish[i];
      const it = this.fish[i];
      const g = it.group;
      it.wake.visible = false;
      it.blob.visible = false;
      if (F.state === SWIMMING) {
        const x = R.fishX(F, t);
        const y = R.fishY(F, t);
        const ax = Math.abs(x);
        if (ax > 9.9) { g.visible = false; continue; }
        // Past the field's edge the fish dives into the reeds rather than
        // popping out of existence at the wrap.
        const dive = ax > 8.6 ? (ax - 8.6) * 0.9 : 0;
        const depth = it.depth + dive;
        const k = placeOnRay(cam, f, x, y, depth, v);
        g.visible = true;
        g.position.copy(v);
        const vy = 0.2 * F.bobW * Math.cos(F.bobW * t + F.bobP);
        g.rotation.set(0, Math.atan2(vy, F.v), 0);
        g.scale.setScalar(F.len * k * FISH_LOOK);
        it.tail.rotation.y = Math.sin(this.clock * (6 + Math.abs(F.v) * 1.6) + it.phase) * 0.45;
        if (dive === 0) {
          // The wake: on the surface, as long as one flight of the lure.
          it.wake.visible = true;
          this.world(x, y, it.wake.position);
          it.wake.position.y = 0.015;
          it.wake.rotation.y = g.rotation.y;
          it.wake.scale.set(Math.abs(F.v) * FLIGHT, 1, F.len * 0.95);
          it.blob.visible = true;
          // The shadow on the bed, pushed away from the low sun.
          const bx = v.x + 0.35 * depth, bz = v.z + 0.4 * depth;
          it.blob.position.set(bx, Math.min(-0.2, bedY(bx, bz)) + 0.02, bz);
          it.blob.scale.set(F.len * 1.2, 1, F.len * 0.6);
          it.blob.rotation.y = g.rotation.y;
        }
        if (F.gold) {
          goldShown = true;
          this.goldGlow.position.set(v.x, 0.12, v.z);
          this.goldGlow.scale.setScalar(1.6 + 0.25 * Math.sin(this.clock * 6));
          if (this.clock > this.sparkleAt) {
            this.sparkleAt = this.clock + 0.12;
            this.sparks.emit(this.goldGlow.position, 2, SPARKLE);
          }
        }
        continue;
      }
      // Out of the water: an arc to the creel (yours) or to a boat (theirs).
      const kept = F.state === KEPT;
      const dur = kept ? LAND : YANK;
      const u = (t - F.endAt) / dur;
      if (u >= 1 || u < 0) { g.visible = false; continue; }
      const sx = R.fishX(F, F.endAt), sy = R.fishY(F, F.endAt);
      this.world(sx, sy, this._a);
      if (kept) this._b.copy(this._basket);
      else { const b = this.boats[Math.max(0, R.claimBy[i])]; this._b.copy(b.g.position); this._b.y += 0.6; }
      // A beat of thrashing at the surface, then the flight.
      const hold = 0.12;
      const s = clamp((u - hold) / (1 - hold), 0, 1);
      const e = s * s * (3 - 2 * s);
      g.visible = true;
      g.position.lerpVectors(this._a, this._b, e);
      g.position.y += (kept ? 3.0 : 1.8) * 4 * e * (1 - e) + (u < hold ? -0.1 : 0);
      g.rotation.set(0, Math.atan2(this._a.z - this._b.z, this._b.x - this._a.x), Math.sin(this.clock * 30) * 0.5 + (kept ? 0.9 : 0.6) * (1 - 2 * e));
      g.scale.setScalar(F.len * FISH_LOOK * (1 + (kept ? 0.3 : 0) * e));
      it.tail.rotation.y = Math.sin(this.clock * 34) * 0.7;
      if (F.gold && kept) {
        goldShown = true;
        this.goldGlow.position.copy(g.position);
        this.goldGlow.scale.setScalar(2.2);
      }
    }
    this.goldGlow.visible = goldShown;
    this.goldGlow.material.opacity = 0.75;
  }

  #renderBoats(R, t) {
    for (let r = 0; r < this.boats.length; r++) {
      const b = this.boats[r];
      b.g.position.y = 0.05 + Math.sin(this.clock * 1.3 + b.phase) * 0.05;
      b.g.rotation.z = Math.sin(this.clock * 1.1 + b.phase) * 0.05;
      // The angler strikes when it takes a fish: find its latest claim.
      let last = -9;
      for (let i = 0; i < FISH; i++) {
        if (R.claimBy[i] === r && R.fish[i].state === LOST && R.fish[i].endAt > last) last = R.fish[i].endAt;
      }
      const strike = clamp(1 - (t - last) / 0.6, 0, 1);
      b.rod.rotation.z = -0.9 + strike * 0.7;
      b.g.updateMatrixWorld();
      b.tip.getWorldPosition(this._boatTip[r]);
      b.label.material.opacity = 0.85 + strike * 0.15;
      const grow = this.labelK * (1 + strike * 0.15);
      b.label.scale.set(2.6 * grow, 0.65 * grow, 1);
      if (R.tally[r] !== this._labels[r]) this.#paintLabel(r);
    }
    // A rival's float and line over the fish it is about to take.
    for (let i = 0; i < FISH; i++) {
      const c = this.contest[i];
      const F = R.fish[i];
      const left = R.claimAt[i] - t;
      const on = F.state === SWIMMING && left > 0 && left < CONTEST;
      c.float.visible = on;
      c.line.visible = on;
      if (!on) continue;
      const x = R.fishX(F, t), y = R.fishY(F, t);
      if (Math.abs(x) > 9.4) { c.float.visible = false; c.line.visible = false; continue; }
      const urgency = 1 - left / CONTEST;
      this.world(x, y, c.float.position);
      c.float.position.y = 0.04 + Math.abs(Math.sin(this.clock * (5 + urgency * 14))) * 0.12 * (0.4 + urgency);
      c.float.scale.setScalar(1 + urgency * 0.6);
      this.#sag(c.line, this._boatTip[Math.max(0, R.claimBy[i])], c.float.position, 0.6);
    }
  }

  #renderRod(R, t) {
    // Aim the rod over the reticle, raised, with a flick on every cast.
    this.rod.position.copy(this.rodBase);
    if (R.aimed) this.world(R.aimX, R.aimY, this._w); else this.world(0, 0, this._w);
    this._w.y += 3.2 - this.flick * this.flick * 2.4 + Math.sin(this.flick * Math.PI) * 1.5;
    this.rod.lookAt(this._w);
    this.rod.updateMatrixWorld();
    this.rodTip.getWorldPosition(this._tip);

    const L = R.last;
    const lure = this._lure;
    let sag = 0.25;
    let reeling = false;
    if (L && t < L.landAt) {
      // In the air: a parabola from the tip to the landing point.
      const s = clamp((t - L.t0) / FLIGHT, 0, 1);
      this.world(L.x, L.y, this._a);
      lure.lerpVectors(this._tip, this._a, s);
      lure.y += (1.2 + 0.12 * this._tip.distanceTo(this._a)) * 4 * s * (1 - s);
      sag = 0.05;
    } else if (L && t < L.readyAt) {
      reeling = true;
      const u = (t - L.landAt) / Math.max(0.01, L.readyAt - L.landAt);
      if (L.hit >= 0) {
        const g = this.fish[L.hit].group;
        if (g.visible) lure.copy(g.position); else lure.copy(this._basket);
        sag = 0.02;
      } else {
        this.world(L.x, L.y, this._a);
        const s = clamp((u - 0.3) / 0.7, 0, 1);
        lure.lerpVectors(this._a, this._tip, s * s);
        lure.y = Math.max(lure.y, 0.04 + Math.sin(this.clock * 9) * 0.02 * (1 - s));
        sag = 0.4 * (1 - s);
      }
    } else {
      lure.copy(this._tip);
      lure.y -= 0.7;
      lure.x += Math.sin(this.clock * 1.7) * 0.05;
    }
    this.lure.position.copy(lure);
    this.reelSpin.rotation.x += reeling ? 0.6 : 0;
    this.#sag(this.line, this._tip, lure, sag);
  }

  /** Write a sagging line from a to b into a pooled Line, without allocating. */
  #sag(line, a, b, sag) {
    const arr = line.geometry.attributes.position.array;
    const d = a.distanceTo(b);
    for (let k = 0; k < LINE_PTS; k++) {
      const s = k / (LINE_PTS - 1);
      arr[k * 3] = a.x + (b.x - a.x) * s;
      arr[k * 3 + 1] = a.y + (b.y - a.y) * s - sag * d * 0.12 * 4 * s * (1 - s);
      arr[k * 3 + 2] = a.z + (b.z - a.z) * s;
    }
    line.geometry.attributes.position.needsUpdate = true;
  }

  #renderMarks(R, t) {
    const ready = !R.hook && t >= R.readyAt;
    this.reticle.visible = R.aimed;
    if (R.aimed) {
      this.world(clamp(R.aimX, -FIELD.hw + 0.2, FIELD.hw - 0.2), clamp(R.aimY, -FIELD.hh + 0.2, FIELD.hh - 0.2), this.reticle.position);
      this.reticle.position.y = 0.03;
      const denied = clamp(1 - (t - R.deniedAt) / 0.3, 0, 1);
      if (ready) {
        this.retRingMat.color.setRGB(1, 0.96, 0.86);
        this.retRingMat.opacity = 0.95;
        this.dial.visible = false;
        this.reticle.scale.setScalar(1 + 0.06 * Math.sin(this.clock * 5));
      } else {
        this.retRingMat.color.setRGB(0.75 + denied * 0.25, 0.8 - denied * 0.45, 0.82 - denied * 0.45);
        this.retRingMat.opacity = 0.55;
        const L = R.last;
        let u = 0;
        if (L && L.readyAt < Infinity) u = clamp((t - L.landAt) / Math.max(0.01, L.readyAt - L.landAt), 0, 1);
        this.dial.visible = u > 0;
        this.dial.geometry.setDrawRange(0, 6 * Math.round(u * 48));
        this.reticle.scale.setScalar(1 + denied * 0.15);
      }
    }
    // The ghost: for the first casts, where the lure must land to catch the
    // fish nearest the pointer.
    this.ghost.visible = false;
    if (R.ghostCasts > 0 && R.aimed && ready) {
      const i = R.nearestFish(R.aimX, R.aimY, t);
      if (i >= 0) {
        const F = R.fish[i];
        const x = R.leadX(F, t);
        if (Math.abs(x) < FIELD.hw - 0.3) {
          this.ghost.visible = true;
          this.world(x, R.leadY(F, t), this.ghost.position);
          this.ghost.position.y = 0.025;
          this.ghost.scale.setScalar(F.len + 0.4 + 0.08 * Math.sin(this.clock * 6));
        }
      }
    }
  }

  #paintLabel(r) {
    const R = this.rite;
    this._labels[r] = R.tally[r];
    const b = this.boats[r];
    const g = b.canvas.getContext('2d');
    const W = b.canvas.width, H = b.canvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8,14,18,0.72)';
    g.beginPath(); g.roundRect(4, 8, W - 8, H - 16, 22); g.fill();
    g.fillStyle = RIVAL_CSS[r];
    g.beginPath(); g.arc(30, H / 2, 10, 0, Math.PI * 2); g.fill();
    g.font = '600 28px ui-sans-serif, system-ui, sans-serif';
    g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillStyle = '#f2efe6';
    g.fillText(R.roster[r]?.name ?? '', 50, H / 2 + 1);
    g.textAlign = 'right';
    g.fillStyle = RIVAL_CSS[r];
    g.font = '700 30px ui-sans-serif, system-ui, sans-serif';
    g.fillText(String(R.tally[r]), W - 22, H / 2 + 1);
    b.tex.needsUpdate = true;
  }

  /** Redrawn only when the creel changes. */
  #paintHud() {
    const R = this.rite;
    if (this._hud.points === R.points) return;
    this._hud.points = R.points;
    const g = this.hudCanvas.getContext('2d');
    const W = this.hudCanvas.width, H = this.hudCanvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8,16,20,0.62)';
    g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, 26); g.fill();
    g.textBaseline = 'alphabetic';
    g.font = '600 26px ui-monospace, Menlo, monospace';
    g.fillStyle = 'rgba(233,235,243,0.7)';
    g.textAlign = 'left';
    g.fillText('CREEL', 30, 50);
    g.font = '700 54px Georgia, serif';
    g.fillStyle = this.P.goldHi;
    g.textAlign = 'right';
    const par = String(Math.ceil(PAR));
    g.font = '600 28px ui-monospace, Menlo, monospace';
    const pw = g.measureText(` / ${par}`).width;
    g.fillStyle = 'rgba(233,235,243,0.6)';
    g.fillText(` / ${par}`, W - 30, 54);
    g.font = '700 56px Georgia, serif';
    g.fillStyle = this.P.goldHi;
    g.fillText(String(R.points), W - 30 - pw, 56);
    const ratio = clamp(R.points / PAR, 0, 1);
    g.fillStyle = 'rgba(233,235,243,0.14)';
    g.beginPath(); g.roundRect(30, 80, W - 60, 18, 9); g.fill();
    if (ratio > 0) {
      const grad = g.createLinearGradient(30, 0, W - 30, 0);
      grad.addColorStop(0, this.P.accent);
      grad.addColorStop(1, this.P.gold);
      g.fillStyle = grad;
      g.beginPath(); g.roundRect(30, 80, Math.max(18, (W - 60) * ratio), 18, 9); g.fill();
    }
    this.hudTex.needsUpdate = true;
  }
}

export function createView(stage, rite) {
  return new FishingView(stage, rite);
}

