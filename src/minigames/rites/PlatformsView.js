/**
 * FALLING PLATFORMS, IN 3D — floating tiles over a violet void.
 *
 * Read LuckyShotView.js first; this follows its rules (docs/MINIGAMES.md §8.1).
 * What is specific here:
 *
 *  1. THE FLOOR IS A GROUND FRAME. Field x is world +X, field y is world -Z, the
 *     tile tops are the y = 0 plane. Nothing is aimed, so nothing needs
 *     `placeOnRay`: the camera looks down at ~50 degrees and drifts a little
 *     toward the player, so the floor parallaxes against the void.
 *  2. A TILE SAYS HOW LONG IT HAS. Settled tiles bob. A tile darkens
 *     `STRESS_LEAD` x its shake ahead of the drop, then shakes with a tremble
 *     and a crack glow that both grow to the drop, then tumbles into the fog.
 *     The glow is an emissive crack map at intensity 0 when quiet, so no tile
 *     ever changes material or program.
 *  3. EVERY BODY READS THE RITE'S PURE FUNCTIONS. `playerAt` / `ghostAt` give
 *     position and hop height at any time, so characters arc between steps at
 *     the render rate. A fall starts at `outAt` / `rivalOut` and is drawn from
 *     the time since, so a paused frame is the same frame.
 *  4. THE HUD RIDES THE CAMERA. One CanvasTexture plane, child of the camera,
 *     repainted only when a count changes: tiles left, who is still up.
 */

import * as THREE from 'three';
import { mulberry32 } from '../../core/Rng.js';
import { MINIGAMES } from '../../core/Config.js';
import { clamp } from '../contract.js';
import { RiteView, FRAMES, addStandardLights, Bursts } from '../Stage3D.js';
import {
  TILES, COLS, RIVAL_COUNT, PITCH, STRESS_LEAD, STAND, cellX, cellY, cellAt,
} from './PlatformsRite.js';

/** World height of a hop's peak. */
const HOP_H = 1.05;
/** Gravity for everything that falls, world units / s^2. */
const G = 15;
/** Seconds of falling drawn before a tile or a body is hidden in the fog. */
const FALL_SHOWN = 2.6;
/** Tile top: side, slab thickness, corner radius. */
const TILE = 1.72;
const SLAB = 0.34;
const CORNER = 0.2;
/** How far a shaking tile has sunk at the instant it drops. */
const SINK = 0.16;
/** Characters are modelled about a metre tall; this is how big they stand on a 1.72 tile. */
const BODY_SCALE = 1.3;
/** How far a tag that slid off a body behind drops: from over the head to beside the eyes. */
const TAG_DROP = 0.75 * BODY_SCALE;
/** How far the camera drifts toward the player at the floor's edge, world units. */
const DRIFT = 0.9;
/**
 * Below this stage width (CSS px) the HUD and the name tags would be ~7 px text,
 * so they are painted and drawn bigger. A phone in landscape is ~455 px.
 */
const NARROW_PX = 640;

/** Body colours: you, then the three rivals. Art, not chrome. */
const BODY = [0xf4c04e, 0x4fd1c5, 0xff7d93, 0x9fd356];
const BODY_HEX = ['#f4c04e', '#4fd1c5', '#ff7d93', '#9fd356'];

/** Fallbacks match the stylesheet; read once, never per frame. */
function readPalette() {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const tok = (n, f) => (cs?.getPropertyValue(n) || '').trim() || f;
  return {
    accent: tok('--rite-platforms-accent', '#b79cf0'),
    goldHi: tok('--gold-hi', '#f7dfae'),
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

function roundedRect(s, w, h, r) {
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}

class PlatformsView extends RiteView {
  constructor(stage, rite) {
    super(stage, rite, {
      frame: FRAMES.ground, fov: 32, tilt: 52, yaw: 0, margin: 0.07, background: 0x0c0818,
    });
    this.scene.environment = stage.environment();
    this.scene.environmentIntensity = 0.25;
    this.scene.fog = new THREE.Fog(0x0c0818, 18, 46);
    this.P = readPalette();
    this.rng = mulberry32(rite.fxSeed >>> 0);
    this.clock = 0;
    this._lastT = 0;
    this._v = new THREE.Vector3();
    this._at = { x: 0, y: 0, h: 0 };
    this._camBase = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this.drift = new THREE.Vector2();
    this.flash = 0;
    this.alarm = 0;
    this._hud = { left: -1, mask: -1 };
    this._occ = new Uint8Array(TILES);

    this.#buildLights();
    this.#buildTextures();
    this.#buildVoid();
    this.#buildTiles();
    this.#buildBodies();
    this.#buildHud();
    this.#buildFx();
    this._built = true;
    this.layout(16 / 9);
    this.render(0, 0);
    stage.renderer.initTexture(this.alertTex);
  }

  // ---- construction -------------------------------------------------------

  #buildLights() {
    const { hemi, key } = addStandardLights(this.scene, {
      sky: 0xd9ccff, ground: 0x2a1640, hemi: 0.75, keyColor: 0xfff0dc, key: 2.1,
      keyFrom: new THREE.Vector3(-6, 14, 9),
    });
    this.hemi = hemi; this.key = key;
    // Underglow from the void: the rocky undersides catch it, and it is what
    // makes the floor read as hanging over something.
    // In the stage accent, so the void and the chrome around it are one purple.
    this.under = new THREE.PointLight(this.P.accent, 70, 30, 1.6);
    this.under.position.set(0, -6, -1);
    // The danger lamp: sits over YOUR shaking tile, intensity 0 otherwise.
    this.danger = new THREE.PointLight(0xff5a2a, 0, 6, 2);
    this.scene.add(this.under, this.danger);
  }

  #buildTextures() {
    const r = mulberry32(0x51ab);
    this.topTex = this.own(canvasTexture(256, 256, (g, w) => {
      g.fillStyle = '#d9d2e6'; g.fillRect(0, 0, w, w);
      for (let i = 0; i < 900; i++) {
        const a = 0.05 + r() * 0.08;
        g.fillStyle = r() < 0.5 ? `rgba(60,40,90,${a})` : `rgba(255,255,255,${a})`;
        g.fillRect(r() * w, r() * w, 2 + r() * 5, 2 + r() * 5);
      }
      g.strokeStyle = 'rgba(70,50,110,0.35)'; g.lineWidth = 6;
      g.strokeRect(22, 22, w - 44, w - 44);
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
      g.strokeRect(28, 28, w - 56, w - 56);
      g.fillStyle = 'rgba(80,55,130,0.22)';
      g.beginPath(); g.moveTo(w / 2, w / 2 - 34); g.lineTo(w / 2 + 34, w / 2);
      g.lineTo(w / 2, w / 2 + 34); g.lineTo(w / 2 - 34, w / 2); g.closePath(); g.fill();
    }));
    // The cracks: black everywhere but the seams, used as an EMISSIVE map so a
    // quiet tile shows nothing and a dying one glows along its fractures.
    this.crackTex = this.own(canvasTexture(256, 256, (g, w) => {
      g.fillStyle = '#000'; g.fillRect(0, 0, w, w);
      g.strokeStyle = '#fff'; g.lineCap = 'round';
      const branch = (x, y, a, len, width) => {
        if (len < 10 || width < 0.8) return;
        const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
        g.lineWidth = width;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
        branch(x2, y2, a + (r() - 0.5) * 1.1, len * 0.72, width * 0.75);
        if (r() < 0.45) branch(x2, y2, a + (r() < 0.5 ? 1 : -1) * (0.6 + r() * 0.6), len * 0.5, width * 0.6);
      };
      for (let k = 0; k < 6; k++) branch(w / 2, w / 2, k * (Math.PI / 3) + r() * 0.6, 34 + r() * 18, 6);
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 3;
      g.strokeRect(26, 26, w - 52, w - 52);
    }));
    this.glowTex = this.own(canvasTexture(128, 128, (g, w) => {
      const rg = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      rg.addColorStop(0, 'rgba(255,255,255,1)');
      rg.addColorStop(0.3, 'rgba(255,255,255,0.45)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, w);
    }));
    this.shadowTex = this.own(canvasTexture(64, 64, (g, w) => {
      const rg = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      rg.addColorStop(0, 'rgba(10,4,20,0.75)');
      rg.addColorStop(0.6, 'rgba(10,4,20,0.35)');
      rg.addColorStop(1, 'rgba(10,4,20,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, w);
    }));
    this.alertTex = this.own(canvasTexture(64, 96, (g, w, h) => {
      g.fillStyle = '#ff5f57';
      g.beginPath(); g.arc(w / 2, h / 2, 28, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = '900 52px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('!', w / 2, h / 2 + 3);
    }));
  }

  /** The void: a glow far below, drifting motes, and a few far islands for parallax. */
  #buildVoid() {
    const S = this.scene;
    const pit = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: this.glowTex, color: 0x6a3cc8, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
    }));
    pit.rotation.x = -Math.PI / 2;
    pit.position.set(0, -14, -2);
    pit.scale.set(60, 40, 1);
    S.add(pit);

    const N = 220;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (this.rng() - 0.5) * 44;
      pos[i * 3 + 1] = -2 - this.rng() * 18;
      pos[i * 3 + 2] = (this.rng() - 0.5) * 30 - 3;
      c.setHSL(0.72 + this.rng() * 0.2, 0.7, 0.55 + this.rng() * 0.3);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.motes = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.16, vertexColors: true, transparent: true, depthWrite: false, opacity: 0.85,
      blending: THREE.AdditiveBlending, map: this.glowTex, fog: false,
    }));
    S.add(this.motes);

    const rock = new THREE.MeshStandardMaterial({ color: 0x4a3a66, roughness: 0.9, flatShading: true });
    this.islands = [];
    const spots = [[-17, -7, -12], [16, -9, -14], [-14, -12, 2], [18, -6, -2], [3, -14, -18], [-21, -4, -20]];
    for (const [x, y, z] of spots) {
      const s = 0.7 + this.rng() * 1.1;
      const geo = new THREE.DodecahedronGeometry(1, 0);
      const m = new THREE.Mesh(geo, rock);
      m.position.set(x, y, z);
      m.scale.set(s * 1.4, s * 0.7, s);
      m.rotation.set(this.rng() * 3, this.rng() * 3, this.rng() * 3);
      S.add(m);
      this.islands.push({ m, y, ph: this.rng() * 6.28 });
    }
  }

  #buildTiles() {
    const shape = roundedRect(new THREE.Shape(), TILE, TILE, CORNER);
    const slab = new THREE.ExtrudeGeometry(shape, {
      depth: SLAB, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 5,
    });
    // Extruded along +z; lay it flat with its top face at y = 0. UVs from the
    // shape are in shape units, so remap them to 0..1 across the tile.
    slab.rotateX(-Math.PI / 2);
    slab.translate(0, -SLAB, 0);
    const uv = slab.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / TILE + 0.5, uv.getY(i) / TILE + 0.5);

    // Five rock undersides, jittered once from the cosmetic seed: a floating
    // island, not a box, and no two neighbours obviously the same.
    this.rockGeo = [];
    for (let v = 0; v < 5; v++) {
      const geo = new THREE.ConeGeometry(TILE * 0.5, 1.2 + this.rng() * 0.6, 7, 2);
      geo.rotateX(Math.PI);
      const p = geo.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        if (y < 0.55) {
          p.setX(i, p.getX(i) * (0.85 + this.rng() * 0.3));
          p.setZ(i, p.getZ(i) * (0.85 + this.rng() * 0.3));
          p.setY(i, y + (this.rng() - 0.5) * 0.18);
        }
      }
      geo.computeVertexNormals();
      geo.translate(0, -SLAB - geo.parameters.height / 2 + 0.05, 0);
      this.rockGeo.push(geo);
    }
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x5a4380, roughness: 0.92, flatShading: true });
    this.rockMat = rockMat;

    this.tiles = [];
    for (let i = 0; i < TILES; i++) {
      const checker = ((i % COLS) + Math.floor(i / COLS)) % 2 === 0;
      const base = new THREE.Color(checker ? 0xe8e0f4 : 0xc9bde0);
      const mat = new THREE.MeshStandardMaterial({
        color: base.clone(), map: this.topTex, roughness: 0.62, metalness: 0.05,
        emissive: new THREE.Color(0xff5a1e), emissiveMap: this.crackTex, emissiveIntensity: 0,
      });
      const pivot = new THREE.Group();
      const top = new THREE.Mesh(slab, mat);
      const rock = new THREE.Mesh(this.rockGeo[i % 5], rockMat);
      rock.rotation.y = this.rng() * Math.PI * 2;
      pivot.add(top, rock);
      this.world(cellX(i), cellY(i), pivot.position);
      this.scene.add(pivot);
      const spin = new THREE.Vector3(this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5).normalize();
      this.tiles.push({
        pivot, mat, base, home: pivot.position.clone(), spin,
        rate: 1.5 + this.rng() * 2.5, ph: this.rng() * Math.PI * 2, drift: (this.rng() - 0.5) * 2,
      });
    }
    this._dark = new THREE.Color(0x6f6488);
  }

  #buildBodies() {
    const bodyGeo = new THREE.CapsuleGeometry(0.3, 0.32, 6, 14);
    bodyGeo.translate(0, 0.46, 0);
    const eyeGeo = new THREE.SphereGeometry(0.085, 12, 10);
    const pupilGeo = new THREE.SphereGeometry(0.045, 10, 8);
    const hatGeo = new THREE.ConeGeometry(0.17, 0.36, 14);
    const bobbleGeo = new THREE.SphereGeometry(0.06, 10, 8);
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const black = new THREE.MeshBasicMaterial({ color: 0x120a18 });
    const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.shadowTex, transparent: true, depthWrite: false, toneMapped: false,
    });

    this.bodies = [];
    for (let k = 0; k < 1 + RIVAL_COUNT; k++) {
      const root = new THREE.Group();
      const yawG = new THREE.Group();
      const squash = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: BODY[k], roughness: 0.45, metalness: 0.05, emissive: BODY[k], emissiveIntensity: k === 0 ? 0.12 : 0.04,
      });
      const body = new THREE.Mesh(bodyGeo, mat);
      squash.add(body);
      for (const s of [-1, 1]) {
        const eye = new THREE.Mesh(eyeGeo, white);
        eye.position.set(s * 0.12, 0.66, 0.25);
        const pupil = new THREE.Mesh(pupilGeo, black);
        pupil.position.set(0, 0, 0.06);
        eye.add(pupil);
        squash.add(eye);
      }
      const hat = new THREE.Mesh(hatGeo, new THREE.MeshStandardMaterial({
        color: k === 0 ? 0xff5f8a : 0xf7f1ff, roughness: 0.5,
      }));
      hat.position.set(0.04, 1.02, -0.02);
      hat.rotation.z = -0.22;
      const bobble = new THREE.Mesh(bobbleGeo, new THREE.MeshStandardMaterial({
        color: k === 0 ? 0xffe066 : BODY[k], roughness: 0.4, emissive: k === 0 ? 0x6a5000 : 0x000000,
      }));
      bobble.position.set(0, 0.2, 0);
      hat.add(bobble);
      squash.add(hat);
      yawG.add(squash);
      root.add(yawG);
      root.scale.setScalar(BODY_SCALE);
      this.scene.add(root);

      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.renderOrder = 1;
      this.scene.add(shadow);

      const name = k === 0 ? 'YOU' : this.rite.rivals.roster()[k - 1]?.name ?? '?';
      const { tex: tagTex, pill } = this.#tagTexture(name, BODY_HEX[k], k === 0);
      this.own(tagTex);
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tagTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      }));
      tag.renderOrder = k === 0 ? 22 : 20;
      tag.scale.set(1.5, 0.47, 1);
      this.scene.add(tag);

      this.bodies.push({
        root, yawG, squash, mat, shadow, tag, pill, tagShift: 0, tagDrop: 0, yaw: 0, land: 0, air: false,
        lx: 0, ly: 0, at: { x: 0, y: 0, h: 0 }, out: Infinity, cell: -1, slot: 0, ox: 0,
      });
    }

    this.alert = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.alertTex, transparent: true, depthTest: false, toneMapped: false,
    }));
    this.alert.renderOrder = 21;
    this.alert.scale.set(0.42, 0.63, 1);
    this.scene.add(this.alert);
  }

  /**
   * Tags draw over everything, so a tag hovering over someone a row behind
   * hides that body. Fading it was not enough: a 40 % "YOU" still sat on the
   * rival's face. The tag slides sideways, away from the body it covers, just
   * far enough that its pill clears that silhouette, and eases back once the
   * way is clear. Sliding by the whole sprite moved "YOU" a tile away, over
   * nobody, and left the player's own body under the rival's name. A slid tag
   * also drops to its owner's eye line (TAG_DROP), so it sits beside the face
   * it names and not beside the face behind.
   */
  #clearTagsOffBodies(dt) {
    const cam = this.camera;
    const tp = this._tp ??= new THREE.Vector3();
    const bp = this._bp ??= new THREE.Vector3();
    const k = this._tagK;
    const r = 0.4 * BODY_SCALE;
    for (const a of this.bodies) {
      let goal = 0;
      const half = 0.75 * k * a.pill;
      if (a.tag.visible) {
        tp.copy(a.tag.position).project(cam);
        const near = cam.position.distanceToSquared(a.root.position);
        for (const b of this.bodies) {
          if (b === a || !b.root.visible) continue;
          if (cam.position.distanceToSquared(b.root.position) <= near) continue;
          // NDC per world unit at b, from a one-unit vertical step.
          bp.copy(b.root.position);
          bp.y += 1 + 0.5 * BODY_SCALE;
          bp.project(cam);
          const top = bp.y;
          bp.copy(b.root.position);
          bp.y += 0.5 * BODY_SCALE;
          bp.project(cam);
          const u = top - bp.y;
          // x in NDC is stretched by the inverse aspect relative to y.
          if (Math.abs(tp.x - bp.x) < u * (r + half) / cam.aspect
            && Math.abs(tp.y - bp.y) < u * (0.9 * BODY_SCALE + 0.25 * k)) {
            const side = tp.x >= bp.x ? 1 : -1;
            goal = b.root.position.x + side * (r + half) - a.root.position.x;
            break;
          }
        }
      }
      const ease = Math.min(1, dt * 14);
      a.tagShift += (goal - a.tagShift) * ease;
      a.tagDrop += ((goal ? TAG_DROP : 0) - a.tagDrop) * ease;
      a.tag.position.x += a.tagShift;
      a.tag.position.y -= a.tagDrop;
    }
  }

  /** The tag texture, and how much of its width the drawn pill takes (0..1). */
  #tagTexture(label, hex, you) {
    let pill = 1;
    const tex = canvasTexture(256, 80, (g, w, h) => {
      g.font = `800 ${you ? 46 : 40}px system-ui, -apple-system, Segoe UI, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = Math.min(w - 8, g.measureText(label).width + 36);
      pill = tw / w;
      g.fillStyle = 'rgba(12,8,24,0.72)';
      g.beginPath(); g.roundRect((w - tw) / 2, 12, tw, h - 24, 18); g.fill();
      g.strokeStyle = hex; g.lineWidth = 4; g.stroke();
      g.fillStyle = you ? '#fff4d6' : '#f2eefa';
      g.fillText(label, w / 2, h / 2 + 2);
    });
    return { tex, pill };
  }

  #buildHud() {
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 2048; this.hudCanvas.height = 128;
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;
    this.hud = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: this.hudTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    }));
    this.hud.renderOrder = 30;
    this.camera.add(this.hud);
    this.scene.add(this.camera);
  }

  #buildFx() {
    const seed = this.rite.fxSeed >>> 0;
    this.chips = new Bursts({ count: 260, size: 0.14, gravity: -9, drag: 0.985, seed });
    this.sparks = new Bursts({ count: 160, size: 0.12, gravity: -6, seed: seed ^ 0x9e3779b9 });
    this.scene.add(this.chips.points, this.sparks.points);
  }

  // ---- layout -------------------------------------------------------------

  layout(aspect) {
    super.layout(aspect);
    if (!this._built) return;
    this.#fitFloor();
    this._camBase.copy(this.camera.position);
    // Fog starts just past the far edge of the floor, so the floor is crisp
    // and everything that falls is swallowed within a couple of seconds.
    const dist = this._camBase.distanceTo(this._camLook);
    this.scene.fog.near = dist + 5;
    this.scene.fog.far = dist + 30;
    const narrow = (this.stage.cssW || 1600) < NARROW_PX;
    if (narrow !== this._narrow) { this._narrow = narrow; this._hud.left = -1; }
    this._tagK = narrow ? 1.7 : 1;
    for (const b of this.bodies) b.tag.scale.set(1.5 * this._tagK, 0.47 * this._tagK, 1);
    // HUD across the top of the screen, 2 units in front of the camera.
    const d = 2;
    const hh = d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const hw = hh * this.camera.aspect;
    const w = hw * 2 * 0.96;
    const h = w * (128 / 2048);
    this.hud.scale.set(w, h, 1);
    this.hud.position.set(0, hh - h * 0.62, -d);
  }

  /**
   * Pull the camera in until the FLOOR fills the stage, not the 16 x 9 field.
   *
   * `frameField` keeps the four field corners on screen because a pointer rite
   * needs every pickable point visible. Nothing here is picked (the input is
   * the arrows), so the frame is the floor plus a character's height, below
   * the HUD strip, with room for the drift. Same direction as frameField's, so
   * the angle is the one the constructor asked for.
   */
  #fitFloor() {
    const cam = this.camera;
    const look = this._camLook;
    this.world(0, -0.35, look);
    const dir = this._v.copy(cam.position).sub(this.world(0, 0, this._look)).normalize();
    const hudTop = 1 - 2 * Math.min(0.2, cam.aspect * 0.06) - 0.03;
    const hx = (COLS * PITCH) / 2, hz = 4.25;
    const pts = this._fitPts ??= [
      [-hx, -0.3, -hz], [hx, -0.3, -hz], [-hx, 2.1, -hz], [hx, 2.1, -hz],
      [-hx, -0.5, hz], [hx, -0.5, hz], [-hx, 1.6, hz], [hx, 1.6, hz],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const q = new THREE.Vector3();
    const fits = (d) => {
      cam.position.copy(look).addScaledVector(dir, d);
      cam.lookAt(look);
      cam.updateMatrixWorld(true);
      for (const p of pts) {
        q.copy(p).project(cam);
        if (Math.abs(q.x) > 0.96 || q.y > hudTop || q.y < -0.95 || q.z > 1) return false;
      }
      return true;
    };
    let lo = 2, hi = 200;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    fits(hi * 1.02);
    cam.near = 0.1;
    cam.far = 400;
    cam.updateProjectionMatrix();
  }

  // ---- cues ---------------------------------------------------------------

  cue(ev) {
    const v = this._v;
    if (ev.type === 'tick') {
      this.alarm = 1;
    } else if (ev.type === 'good' || ev.type === 'perfect') {
      this.world(ev.x, ev.y, v);
      v.y += 0.2;
      this.sparks.emit(v, ev.type === 'perfect' ? 40 : 22, { color: 0xffd36a, speed: 3.4, life: 0.6, up: 2.2 });
      this.flash = ev.type === 'perfect' ? 1 : 0.6;
    } else if (ev.type === 'fail') {
      this.world(ev.x, ev.y, v);
      this.sparks.emit(v, 30, { color: 0xff5f57, speed: 3, life: 0.7, up: 1.5 });
      this.kick.y = -0.12;
    } else if (ev.type === 'break') {
      this.kick.y = -0.05;
    } else if (ev.type === 'claim') {
      const p = this.rite.paths[ev.i];
      if (!p) return;
      this.world(p.x[p.x.length - 1], p.y[p.y.length - 1], v);
      this.sparks.emit(v, 26, { color: BODY[1 + ev.i], speed: 3.2, life: 0.8, up: 2.5 });
    }
  }

  // ---- the frame ----------------------------------------------------------

  render(alpha, dt) {
    const R = this.rite;
    const t = R.t + alpha * MINIGAMES.dt;
    this.clock += dt;
    this.flash = Math.max(0, this.flash - dt * 3);
    this.alarm = Math.max(0, this.alarm - dt * 1.4);
    this.kick.y *= Math.max(0, 1 - dt * 12);

    this.#renderCamera(t, dt);
    this.#renderTiles(t);
    this.#renderBodies(t, dt);
    this.#renderVoid();
    this.#paintHud(t);

    this.chips.update(dt);
    this.sparks.update(dt);
    this._lastT = t;
  }

  #renderCamera(t, dt) {
    const R = this.rite;
    const cam = this.camera;
    const at = R.playerAt(t, this._at);
    const wx = clamp(at.x / (COLS * PITCH / 2), -1, 1);
    const wy = clamp(at.y / 4, -1, 1);
    const k = Math.min(1, dt * 2);
    this.drift.x += (wx - this.drift.x) * k;
    this.drift.y += (wy - this.drift.y) * k;
    cam.position.copy(this._camBase);
    cam.position.x += this.drift.x * DRIFT;
    cam.position.z -= this.drift.y * DRIFT * 0.6;
    this._look.copy(this._camLook);
    this._look.x += this.drift.x * DRIFT * 0.7;
    this._look.z -= this.drift.y * DRIFT * 0.5;
    cam.lookAt(this._look);
    cam.updateMatrixWorld();
  }

  /** Where a tile's top is at `t`, and whether it is still drawn. Writes into `tl.pivot`. */
  #renderTiles(t) {
    const R = this.rite;
    const v = this._v;
    let mine = -1;
    if (R.alive && R.state === STAND) mine = R.cell;
    for (let i = 0; i < TILES; i++) {
      const tl = this.tiles[i];
      const p = tl.pivot;
      const gone = R.gone[i];
      const left = gone - t;
      const shake = R.shake[i];
      if (left <= 0) {
        const f = -left;
        if (f > FALL_SHOWN) { p.visible = false; continue; }
        if (this._lastT < gone && t >= gone) {
          this.world(cellX(i), cellY(i), v);
          this.chips.emit(v, 22, { color: 0x9a86d0, speed: 3.0, life: 0.9, up: 1.0 });
          this.chips.emit(v, 12, { color: 0xff7a3a, speed: 2.6, life: 0.55, up: 1.8 });
        }
        p.visible = true;
        p.position.set(tl.home.x + tl.drift * f * 0.4, -SINK - 0.5 * G * f * f, tl.home.z);
        p.quaternion.setFromAxisAngle(tl.spin, f * tl.rate);
        tl.mat.emissiveIntensity = Math.max(0, 1.6 - f * 2);
        continue;
      }
      p.visible = true;
      let ox = 0, oz = 0, oy = Math.sin(this.clock * 1.4 + tl.ph) * 0.03, rx = 0, rz = 0;
      let glow = 0;
      if (left <= shake) {
        const k = 1 - left / shake;
        const amp = 0.025 + 0.07 * k * k;
        const fq = 22 + 30 * k;
        ox = Math.sin(t * fq + tl.ph) * amp;
        oz = Math.cos(t * fq * 1.27 + tl.ph * 1.7) * amp;
        rx = Math.sin(t * fq * 0.9 + tl.ph) * amp * 0.5;
        rz = Math.cos(t * fq * 1.1) * amp * 0.5;
        oy = -SINK * k * k;
        glow = 0.25 + 2.4 * k * k * (0.8 + 0.2 * Math.sin(t * (10 + 20 * k)));
        tl.mat.color.copy(this._dark).lerp(tl.base, 0.35 * (1 - k));
      } else if (left <= shake * STRESS_LEAD) {
        const k = 1 - (left - shake) / (shake * (STRESS_LEAD - 1));
        tl.mat.color.copy(tl.base).lerp(this._dark, 0.75 * k);
        ox = Math.sin(t * 7 + tl.ph) * 0.01 * k;
      } else {
        tl.mat.color.copy(tl.base);
      }
      tl.mat.emissiveIntensity = glow;
      p.position.set(tl.home.x + ox, oy, tl.home.z + oz);
      p.rotation.set(rx, 0, rz);
      if (i === mine && left <= shake) {
        this.danger.position.set(tl.home.x, 1.2, tl.home.z);
        this.danger.intensity = 6 + 18 * (1 - left / shake);
      }
    }
    if (mine < 0 || R.gone[mine] - t > R.shake[mine]) this.danger.intensity = 0;
  }

  /** Height of the floor surface under a field point at `t`: the tile's bob and sink, or NaN over a hole. */
  #floorAt(x, y, t) {
    const c = cellAt(x, y);
    if (c < 0 || this.rite.gone[c] <= t) return NaN;
    return this.tiles[c].pivot.position.y;
  }

  #renderBodies(t, dt) {
    const R = this.rite;
    const occ = this._occ;
    occ.fill(0);
    for (let k = 0; k < this.bodies.length; k++) {
      const b = this.bodies[k];
      const at = b.at;
      if (k === 0) {
        R.playerAt(t, at);
        if (!R.alive) at.h = 0;
        b.out = R.alive ? Infinity : R.outAt;
      } else {
        b.out = R.rivalOut[k - 1];
        R.ghostAt(k - 1, Math.min(t, b.out), at);
      }
      // Two bodies resting on one tile stand side by side instead of inside
      // each other: a slot per occupant, eased so an arrival shuffles rather
      // than snaps. You take the left-most slot.
      b.cell = at.h > 0 || t > b.out ? -1 : cellAt(at.x, at.y);
      b.slot = b.cell >= 0 ? occ[b.cell]++ : 0;
    }
    for (let k = 0; k < this.bodies.length; k++) {
      const b = this.bodies[k];
      const n = b.cell >= 0 ? occ[b.cell] : 1;
      if (t > b.out) continue;   // a fall keeps the slot it had, or two bodies merge on the way down
      const want = n > 1 ? (b.slot - (n - 1) / 2) * 0.62 : 0;
      b.ox += (want - b.ox) * Math.min(1, dt * 10);
    }
    for (let k = 0; k < this.bodies.length; k++) {
      const b = this.bodies[k];
      const at = b.at;
      const out = b.out;
      at.x += b.ox;
      const f = t - out;
      const fallen = f > 0;
      if (fallen && f > FALL_SHOWN) {
        b.root.visible = false; b.shadow.visible = false; b.tag.visible = false;
        continue;
      }
      b.root.visible = true;

      // Facing: toward the hop, easing back to the camera when standing.
      const mx = at.x - b.lx, my = at.y - b.ly;
      b.lx = at.x; b.ly = at.y;
      const moving = !fallen && (mx * mx + my * my) > 1e-6;
      const want = moving ? Math.atan2(mx, -my) : 0;
      let dy = want - b.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      b.yaw += dy * Math.min(1, dt * (moving ? 14 : 3));
      b.yawG.rotation.y = b.yaw;

      // Landing squash, started by the view when the arc reaches the floor.
      const air = at.h > 0;
      if (b.air && !air && !fallen) {
        b.land = 1;
        this.world(at.x, at.y, this._v);
        this.chips.emit(this._v, 6, { color: 0x8c7cc0, speed: 1.3, life: 0.35, up: 0.5 });
      }
      b.air = air;
      b.land = Math.max(0, b.land - dt * 7);

      const floor = this.#floorAt(at.x, at.y, Math.min(t, out));
      const base = Number.isNaN(floor) ? 0 : floor;
      this.world(at.x, at.y, b.root.position);
      b.root.position.y = base + at.h * HOP_H;

      let sy = 1 + 0.16 * at.h - 0.28 * b.land;
      if (fallen) {
        b.root.position.y = base - SINK - 0.5 * G * f * f + 0.6 * Math.min(f, 0.15);
        b.squash.rotation.set(f * 5.5, 0, f * 3.1);
        sy = 1;
      } else {
        // Nervous on a shaking tile: a tremble that grows with the tile's.
        const c = cellAt(at.x, at.y);
        let nerves = 0;
        if (!air && c >= 0) {
          const left = R.gone[c] - t;
          if (left > 0 && left <= R.shake[c]) nerves = 1 - left / R.shake[c];
        }
        const breathe = Math.sin(this.clock * 3.2 + k * 1.7) * 0.025;
        b.squash.rotation.set(0, 0, Math.sin(t * 38 + k) * 0.08 * nerves);
        sy += breathe;
      }
      const sxz = 1 / Math.sqrt(Math.max(0.5, sy));
      b.squash.scale.set(sxz, sy, sxz);

      // Blob shadow on the tile below, gone over a hole or once falling.
      const sh = b.shadow;
      sh.visible = !fallen && !Number.isNaN(floor);
      if (sh.visible) {
        this.world(at.x, at.y, sh.position);
        sh.position.y = floor + 0.012;
        const s = 0.95 * BODY_SCALE * (1 - 0.45 * at.h);
        sh.scale.set(s, 1, s);
      }

      // Name tag over the head; fades out with a fall.
      const tag = b.tag;
      tag.visible = true;
      tag.position.copy(b.root.position);
      tag.position.y += 1.62 * BODY_SCALE;
      tag.material.opacity = fallen ? Math.max(0, 1 - f * 1.5) : 1;
    }
    this.#clearTagsOffBodies(dt);

    // The "!" over your head when your own tile starts shaking.
    const me = this.bodies[0];
    this.alert.visible = this.alarm > 0 && R.alive;
    if (this.alert.visible) {
      // Beside your tag rather than above it: straight up lands on whoever
      // stands in the row behind you.
      this.alert.position.copy(me.tag.position);
      this.alert.position.x += 1.0 * this._tagK;
      this.alert.position.y += 0.1 + (1 - this.alarm) * 0.2;
      const s = 0.8 + 0.4 * Math.min(1, (1 - this.alarm) * 6);
      this.alert.scale.set(0.42 * s, 0.63 * s, 1);
      this.alert.material.opacity = Math.min(1, this.alarm * 2.5);
    }
  }

  #renderVoid() {
    this.motes.rotation.y = this.clock * 0.02;
    this.motes.position.y = Math.sin(this.clock * 0.3) * 0.4;
    for (const it of this.islands) it.m.position.y = it.y + Math.sin(this.clock * 0.5 + it.ph) * 0.3;
    this.under.intensity = 70 + 18 * Math.sin(this.clock * 0.9) + this.flash * 40;
    this.hemi.intensity = 0.75 + this.flash * 0.35;
  }

  /** Repainted only when a count changes. */
  #paintHud(t) {
    const R = this.rite;
    const left = R.standing(t);
    let mask = R.alive ? 1 : 0;
    for (let i = 0; i < RIVAL_COUNT; i++) if (R.rivalOut[i] > t) mask |= 2 << i;
    const h = this._hud;
    if (h.left === left && h.mask === mask) return;
    h.left = left; h.mask = mask;
    const g = this.hudCanvas.getContext('2d');
    const W = this.hudCanvas.width, H = this.hudCanvas.height;
    g.clearRect(0, 0, W, H);
    g.textBaseline = 'middle';

    const pill = (x, w) => {
      g.fillStyle = 'rgba(12,8,24,0.62)';
      g.beginPath(); g.roundRect(x, 10, w, H - 20, 36); g.fill();
    };
    // On a narrow stage the plane is ~450 px wide: same canvas, bigger type.
    const small = this._narrow ? 56 : 34;
    const dot = this._narrow ? 22 : 15;
    const label = `700 ${small}px system-ui, -apple-system, Segoe UI, sans-serif`;
    g.font = '800 72px system-ui, -apple-system, Segoe UI, sans-serif';
    const nw = g.measureText(`${left}`).width;
    g.font = label;
    pill(0, 34 + Math.max(nw, 84) + 20 + g.measureText('TILES LEFT').width + 40);
    g.textAlign = 'left';
    g.fillStyle = 'rgba(233,235,243,0.78)';
    g.fillText('TILES LEFT', 34 + Math.max(nw, 84) + 20, H / 2 + 6);
    g.font = '800 72px system-ui, -apple-system, Segoe UI, sans-serif';
    g.fillStyle = this.P.goldHi;
    g.fillText(`${left}`, 34, H / 2 + 4);

    // Who is still up: four dots in the body colours, crossed when they fall.
    const names = ['YOU', ...R.rivals.roster().map((r) => r.name)];
    g.font = label;
    let total = 0;
    const widths = names.map((n) => { const w = g.measureText(n).width + 44 + 2 * dot; total += w; return w; });
    let x = W - total - 30;
    pill(x - 16, total + 46);
    for (let k = 0; k < names.length; k++) {
      const up = (mask >> k) & 1;
      g.globalAlpha = up ? 1 : 0.38;
      g.fillStyle = BODY_HEX[k];
      g.beginPath(); g.arc(x + 7 + dot, H / 2, dot, 0, Math.PI * 2); g.fill();
      g.fillStyle = k === 0 ? '#fff4d6' : '#f2eefa';
      g.textAlign = 'left';
      g.fillText(names[k], x + 16 + 2 * dot, H / 2 + 2);
      if (!up) {
        g.strokeStyle = this.P.danger; g.lineWidth = 5;
        g.beginPath(); g.moveTo(x + 4, H / 2 + 2); g.lineTo(x + widths[k] - 18, H / 2 + 2); g.stroke();
      }
      x += widths[k];
    }
    g.globalAlpha = 1;
    this.hudTex.needsUpdate = true;
  }

  dispose() {
    this.own(this.hudTex);
    super.dispose();
  }
}

export function createView(stage, rite) {
  return new PlatformsView(stage, rite);
}
