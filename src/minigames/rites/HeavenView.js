/**
 * ESCAPE FROM GAY HEAVEN, IN 3D: a floating cloud arena at golden hour, seen
 * from high behind, with a little winged light dodging pink strikes.
 *
 * Follows LuckyShotView (the reference) and docs/MINIGAMES.md §8.1:
 *  - `render` only READS the rite. Strike geometry comes from the rite's own
 *    hazard records and its pure helpers (`wallAt`, `ringAt`), sampled at
 *    `t = rite.t + alpha * dt`, so the picture and the hit test cannot part.
 *  - Every hit footprint is drawn ON the gameplay plane in field units: a heart
 *    decal is exactly the disc the rite tests, a wall is exactly its slab, a
 *    wedge is exactly its gap. Height (falling hearts, walls, the mote's
 *    hover) is decoration above that plane, and the mote's shadow marks the
 *    point the rite tests.
 *  - Built once. Strikes draw from fixed pools; render moves, scales and
 *    fades. One warm-up pass makes every pooled mesh visible for the host's
 *    compile draw, so no program or texture is created mid-rite.
 *  - Fixed lights: hemisphere, sun (the one shadow caster), a light on the
 *    mote, and a warm light that follows the latest strike at intensity 0
 *    when idle.
 */

import * as THREE from 'three';
import { MINIGAMES } from '../../core/Config.js';
import { mulberry32 } from '../../core/Rng.js';
import { clamp, FIELD } from '../contract.js';
import { RiteView, FRAMES, addStandardLights, Bursts } from '../Stage3D.js';
import {
  HAZARDS, HEART, BEAM, RING, HEART_SLOTS, HEART_LIVE, BEAM_TH,
} from './HeavenRite.js';

/** How many strikes of one kind can be on screen at once. The schedule never overlaps more. */
const POOL = 3;
const MOTE_H = 0.38;
const WALL_H = 1.5;
const FALL_FROM = 11;
const POPS = 6;

function canvasTexture(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Lie a flat XY geometry on the floor: field angle 0 points along +X. */
function flat(geo) { return geo.rotateX(-Math.PI / 2); }

function heartGeometry() {
  const s = new THREE.Shape();
  s.moveTo(5, 5);
  s.bezierCurveTo(5, 5, 4, 0, 0, 0);
  s.bezierCurveTo(-6, 0, -6, 7, -6, 7);
  s.bezierCurveTo(-6, 11, -3, 15.4, 5, 19);
  s.bezierCurveTo(12, 15.4, 16, 11, 16, 7);
  s.bezierCurveTo(16, 7, 16, 0, 10, 0);
  s.bezierCurveTo(7, 0, 5, 5, 5, 5);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 5, bevelEnabled: true, bevelThickness: 2, bevelSize: 1.6, bevelSegments: 4, curveSegments: 14,
  });
  g.center();
  g.scale(1 / 11, 1 / 11, 1 / 11);
  g.rotateZ(Math.PI);
  return g;
}

function chevronGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-0.35, -0.42); s.lineTo(0.0, -0.42); s.lineTo(0.42, 0); s.lineTo(0.0, 0.42);
  s.lineTo(-0.35, 0.42); s.lineTo(0.07, 0); s.closePath();
  return flat(new THREE.ShapeGeometry(s));
}

class HeavenView extends RiteView {
  constructor(stage, rite) {
    super(stage, rite, { frame: FRAMES.ground, fov: 38, tilt: 50, margin: 0.05, background: 0x1b2450 });
    this.scene.environment = stage.environment();
    this.scene.environmentIntensity = 0.25;
    this.scene.fog = new THREE.Fog(0xe8d2b0, 26, 70);
    const pal = rite._palette;
    this.pink = new THREE.Color(pal.pink);
    this.pinkDeep = new THREE.Color(pal.pinkDeep);
    // The safe colour is the rite's accent, deepened so it holds on a cloud floor.
    this.blue = new THREE.Color(pal.accent).offsetHSL(0, 0.35, -0.12);
    this.white = new THREE.Color(0xffffff);
    this.P = pal;
    this.rnd = mulberry32(rite.fxSeed ^ 0x51ed27);
    this.clock = 0;
    this.hitFlash = 0;
    this.dodgeFlash = 0;
    this.trailAcc = 0;
    this._v = new THREE.Vector3();
    this._hud = { cleared: -1, burned: -1, seen: -1 };
    this.landed = new Uint8Array(HAZARDS);

    this.#buildTextures();
    this.#buildLights();
    this.#buildSky();
    this.#buildArena();
    this.#buildMote();
    this.#buildHearts();
    this.#buildBeams();
    this.#buildRings();
    this.#buildHud();
    this.#buildFx();
    this._built = true;
    this.layout(16 / 9);
    this.render(0, 0);
    this.#warm();
    stage.renderer.initTexture(this.popTex);
  }

  // ---- construction -------------------------------------------------------

  #buildTextures() {
    const rnd = this.rnd;
    this.glowTex = this.own(canvasTexture(64, 64, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)');
      r.addColorStop(0.3, 'rgba(255,255,255,0.45)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    }));
    this.floorTex = canvasTexture(512, 512, (g, w, h) => {
      g.fillStyle = '#aeb8d2'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 260; i++) {
        const x = rnd() * w, y = rnd() * h, r = 18 + rnd() * 70;
        const shade = rnd() < 0.55;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, shade ? 'rgba(120,132,170,0.30)' : 'rgba(236,240,250,0.45)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
          g.save(); g.translate(ox, oy); g.fillRect(x - r, y - r, r * 2, r * 2); g.restore();
        }
      }
    });
    this.floorTex.wrapS = this.floorTex.wrapT = THREE.RepeatWrapping;
    this.floorTex.repeat.set(2.2, 1.3);
    this.laneTex = canvasTexture(16, 64, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.2, 'rgba(255,255,255,0.9)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.55)');
      gr.addColorStop(0.8, 'rgba(255,255,255,0.9)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    this.wedgeTex = canvasTexture(128, 128, (g, w) => {
      const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      r.addColorStop(0, 'rgba(255,255,255,0.95)');
      r.addColorStop(0.55, 'rgba(255,255,255,0.6)');
      r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, w, w);
    });
    this.wingTex = canvasTexture(128, 64, (g, w, h) => {
      g.fillStyle = '#ffffff';
      for (let k = 0; k < 4; k++) {
        g.beginPath();
        g.ellipse(w * (0.3 + k * 0.16), h * (0.52 + k * 0.05), w * (0.32 - k * 0.05), h * (0.22 - k * 0.025), -0.25 - k * 0.12, 0, Math.PI * 2);
        g.globalAlpha = 0.95 - k * 0.12;
        g.fill();
      }
    });
    this.popTex = canvasTexture(128, 64, (g, w, h) => {
      g.font = '700 50px Georgia, serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 8; g.strokeStyle = 'rgba(20,24,48,0.8)';
      g.strokeText('+1', w / 2, h / 2 + 2);
      g.fillStyle = '#f7dfae'; g.fillText('+1', w / 2, h / 2 + 2);
    });
  }

  #buildLights() {
    const { hemi, key } = addStandardLights(this.scene, {
      sky: 0xbcd0ff, ground: 0xd8b48a, hemi: 0.75, keyColor: 0xffdcae, key: 2.1,
      keyFrom: new THREE.Vector3(-7, 14, 4), shadow: this.stage.shadows, shadowPad: 3,
    });
    this.hemi = hemi; this.key = key;
    this.moteLight = new THREE.PointLight(0xfff1d0, 2.5, 4.5, 1.6);
    // Warm, never pink: a pink pool on the floor would read as a strike.
    this.strikeLight = new THREE.PointLight(0xffe2b0, 0, 9, 1.5);
    this.scene.add(this.moteLight, this.strikeLight);
  }

  #buildSky() {
    const geo = new THREE.SphereGeometry(120, 32, 16);
    const col = new Float32Array(geo.attributes.position.count * 3);
    const top = new THREE.Color(0x1d2b66), mid = new THREE.Color(0x6f86c8), low = new THREE.Color(0xf4d6a6);
    const c = new THREE.Color();
    for (let i = 0; i < geo.attributes.position.count; i++) {
      const y = geo.attributes.position.getY(i) / 120;
      if (y > 0.25) c.copy(mid).lerp(top, clamp((y - 0.25) / 0.6, 0, 1));
      else c.copy(low).lerp(mid, clamp((y + 0.1) / 0.35, 0, 1));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    const sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffe2a8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
    }));
    sun.position.set(-38, 22, -80);
    sun.scale.setScalar(46);
    this.scene.add(sun);
  }

  #buildArena() {
    const rnd = this.rnd;
    const cloud = new THREE.MeshStandardMaterial({ color: 0xf3f5fb, roughness: 0.95, metalness: 0 });
    const puff = new THREE.IcosahedronGeometry(1, 2);

    // The floor: the gameplay plane, a little larger than the field.
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(FIELD.w + 2.2, FIELD.h + 2.0),
      new THREE.MeshStandardMaterial({ map: this.floorTex, roughness: 1, metalness: 0 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    // The rim: puffs all round the floor's edge, swelling up over it, so the
    // arena reads as a cloud you could fall off.
    const rim = [];
    const hw = FIELD.hw + 1.0, hh = FIELD.hh + 0.9;
    const per = 2 * (2 * hw + 2 * hh);
    for (let s = 0; s < per; s += 0.75) {
      let x, y;
      if (s < 2 * hw) { x = -hw + s; y = -hh; }
      else if (s < 2 * hw + 2 * hh) { x = hw; y = -hh + (s - 2 * hw); }
      else if (s < 4 * hw + 2 * hh) { x = hw - (s - 2 * hw - 2 * hh); y = hh; }
      else { x = -hw; y = hh - (s - 4 * hw - 2 * hh); }
      const r = 0.7 + rnd() * 0.5;
      rim.push([x * 1.03 + (rnd() - 0.5) * 0.3, -0.55 - rnd() * 0.2, -y * 1.04 + (rnd() - 0.5) * 0.3, r, r * 0.6]);
      if (rnd() < 0.6) {
        const r2 = 0.8 + rnd() * 0.8;
        rim.push([x * 1.05 + (rnd() - 0.5), -1.1 - rnd() * 0.6, -y * 1.08 + (rnd() - 0.5), r2, r2 * 0.7]);
      }
    }
    // Underneath: the belly of the island.
    for (let i = 0; i < 40; i++) {
      const r = 1.6 + rnd() * 1.6;
      rim.push([(rnd() * 2 - 1) * hw * 0.9, -0.15 - r * 0.55 - rnd() * 1.2, (rnd() * 2 - 1) * hh * 0.9, r, r * 0.55]);
    }
    // The sea of cloud far below, fading into the fog.
    for (let i = 0; i < 90; i++) {
      const a = rnd() * Math.PI * 2, d = 16 + rnd() * 50;
      const r = 3 + rnd() * 5;
      rim.push([Math.cos(a) * d, -16 - rnd() * 6, Math.sin(a) * d - 14, r, r * 0.32]);
    }
    this.puffs = new THREE.InstancedMesh(puff, cloud, rim.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    rim.forEach(([x, y, z, r, ry], i) => {
      p.set(x, y, z); sc.set(r, ry, r * (0.9 + rnd() * 0.2));
      m.compose(p, q, sc);
      this.puffs.setMatrixAt(i, m);
    });
    this.puffs.receiveShadow = true;
    this.scene.add(this.puffs);

    // Golden columns at the corners: depth cues, shadow casters, and heaven.
    const marble = new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.5, metalness: 0.05 });
    const gilt = new THREE.MeshStandardMaterial({ color: 0xd9b26a, roughness: 0.32, metalness: 0.85 });
    this.columns = new THREE.Group();
    const shaft = new THREE.CylinderGeometry(0.32, 0.38, 3.2, 20);
    const base = new THREE.CylinderGeometry(0.55, 0.6, 0.3, 20);
    const cap = new THREE.BoxGeometry(0.95, 0.22, 0.95);
    const orb = new THREE.SphereGeometry(0.26, 18, 12);
    // Far corners only: a column in front would stand over the arena.
    for (const [cx, cz] of [[-1, -1], [1, -1]]) {
      const g = new THREE.Group();
      g.position.set(cx * (FIELD.hw + 0.55), 0, cz * (FIELD.hh + 0.45));
      const s = new THREE.Mesh(shaft, marble); s.position.y = 1.6; s.castShadow = true;
      const b = new THREE.Mesh(base, gilt); b.position.y = 0.15;
      const c = new THREE.Mesh(cap, gilt); c.position.y = 3.3; c.castShadow = true;
      const o = new THREE.Mesh(orb, gilt); o.position.y = 3.62;
      g.add(s, b, c, o);
      this.columns.add(g);
    }
    this.scene.add(this.columns);
  }

  #buildMote() {
    this.mote = new THREE.Group();
    this.coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 14), this.coreMat);
    this.core.castShadow = true;
    // A gold rim, so the white light still separates from the pale marble.
    this.rim = new THREE.Mesh(new THREE.SphereGeometry(0.245, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xc07f12, side: THREE.BackSide }));
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xfff0c8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.75,
    }));
    this.glow.scale.setScalar(1.3);
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.04, 10, 32),
      new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0xc08a20, emissiveIntensity: 1.2, metalness: 0.8, roughness: 0.25 }));
    this.halo.rotation.x = 1.15;
    this.halo.position.y = 0.36;
    const wingMat = new THREE.MeshBasicMaterial({ map: this.wingTex, color: 0xfff1cf, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const wingGeo = new THREE.PlaneGeometry(0.8, 0.4).translate(0.42, 0, 0);
    this.wingL = new THREE.Mesh(wingGeo, wingMat);
    this.wingR = new THREE.Mesh(wingGeo, wingMat);
    this.wingR.scale.x = -1;
    this.wingL.position.set(0.08, 0.04, 0.02);
    this.wingR.position.set(-0.08, 0.04, 0.02);
    this.mote.add(this.rim, this.core, this.glow, this.halo, this.wingL, this.wingR);
    this.scene.add(this.mote);

    this.shadow = new THREE.Mesh(flat(new THREE.CircleGeometry(0.34, 24)),
      new THREE.MeshBasicMaterial({ map: this.glowTex, color: 0x141a3a, transparent: true, opacity: 0.55, depthWrite: false }));
    this.shadow.renderOrder = 2;
    this.scene.add(this.shadow);

    this.reticle = new THREE.Mesh(flat(new THREE.RingGeometry(0.2, 0.27, 32)),
      new THREE.MeshBasicMaterial({ color: this.blue, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false }));
    this.reticle.renderOrder = 3;
    this.scene.add(this.reticle);
  }

  #decalMat(color, opacity, additive = false) {
    return new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, toneMapped: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
  }

  #buildHearts() {
    const heartGeo = heartGeometry();
    const disc = flat(new THREE.CircleGeometry(1, 48));
    const ring = flat(new THREE.RingGeometry(0.9, 1, 48));
    const chev = chevronGeometry();
    this.heartMat = new THREE.MeshStandardMaterial({
      color: this.pink, emissive: this.pinkDeep, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.1,
    });
    this.heartPool = [];
    for (let s = 0; s < POOL; s++) {
      const fillMat = this.#decalMat(this.pink, 0.2);
      const ringMat = this.#decalMat(this.pink, 0.9);
      const arrowMat = this.#decalMat(this.blue, 0.9);
      const slot = { hearts: [], fills: [], rings: [], fillMat, ringMat, arrowMat, used: -1 };
      for (let k = 0; k < HEART_SLOTS; k++) {
        const h = new THREE.Mesh(heartGeo, this.heartMat);
        h.castShadow = true;
        const f = new THREE.Mesh(disc, fillMat); f.renderOrder = 1;
        const r = new THREE.Mesh(ring, ringMat); r.renderOrder = 1;
        this.scene.add(h, f, r);
        slot.hearts.push(h); slot.fills.push(f); slot.rings.push(r);
      }
      slot.arrow = new THREE.Mesh(chev, arrowMat);
      slot.arrow.renderOrder = 2;
      this.scene.add(slot.arrow);
      this.heartPool.push(slot);
    }
  }

  #buildBeams() {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const lane = flat(new THREE.PlaneGeometry(1, 1));
    this.beamPool = [];
    for (let s = 0; s < POOL; s++) {
      const wallMat = new THREE.MeshBasicMaterial({
        color: this.pink, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false,
      });
      const coreMat = new THREE.MeshBasicMaterial({ color: 0xffe3f6, toneMapped: false });
      const laneMat = new THREE.MeshBasicMaterial({
        map: this.laneTex, color: this.blue, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const slot = {
        walls: [new THREE.Mesh(box, wallMat), new THREE.Mesh(box, wallMat)],
        cores: [new THREE.Mesh(box, coreMat), new THREE.Mesh(box, coreMat)],
        lane: new THREE.Mesh(lane, laneMat),
        wallMat, laneMat, used: -1,
      };
      slot.lane.renderOrder = 1;
      for (const w of slot.walls) { w.renderOrder = 4; this.scene.add(w); }
      for (const c of slot.cores) this.scene.add(c);
      this.scene.add(slot.lane);
      this.beamPool.push(slot);
    }
  }

  #buildRings() {
    const alpha = this.rite.params.ringAlpha;
    // A cylinder wall open across the gap. Cylinder theta 0 is world +Z, which
    // is field angle -90deg; the gap is centred on field angle 0 before rotation.
    const band = new THREE.CylinderGeometry(1, 1, 1, 128, 1, true, Math.PI / 2 + alpha, Math.PI * 2 - 2 * alpha)
      .translate(0, 0.5, 0);
    const wedge = flat(new THREE.CircleGeometry(9, 48, -alpha, 2 * alpha));
    const crystal = new THREE.OctahedronGeometry(0.42, 0);
    const pulse = flat(new THREE.RingGeometry(0.85, 1, 48));
    this.crystalMat = new THREE.MeshStandardMaterial({
      color: this.pink, emissive: this.pink, emissiveIntensity: 0.8, roughness: 0.2, metalness: 0.2, flatShading: true,
    });
    this.ringPool = [];
    for (let s = 0; s < POOL; s++) {
      const bandMat = new THREE.MeshBasicMaterial({
        color: this.pink, transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false, depthWrite: false,
      });
      const wedgeMat = new THREE.MeshBasicMaterial({
        map: this.wedgeTex, color: this.blue, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const pulseMat = this.#decalMat(this.pink, 0.8);
      const slot = {
        band: new THREE.Mesh(band, bandMat),
        wedge: new THREE.Mesh(wedge, wedgeMat),
        crystal: new THREE.Mesh(crystal, this.crystalMat),
        pulse: new THREE.Mesh(pulse, pulseMat),
        bandMat, wedgeMat, pulseMat, used: -1,
      };
      slot.band.renderOrder = 4;
      slot.wedge.renderOrder = 1;
      slot.pulse.renderOrder = 2;
      slot.crystal.castShadow = true;
      this.scene.add(slot.band, slot.wedge, slot.crystal, slot.pulse);
      this.ringPool.push(slot);
    }
  }

  #buildHud() {
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 1024; this.hudCanvas.height = 160;
    this.hudTex = new THREE.CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = THREE.SRGBColorSpace;
    this.hudTex.anisotropy = 4;
    this.hud = new THREE.Mesh(new THREE.PlaneGeometry(1, 160 / 1024),
      new THREE.MeshBasicMaterial({ map: this.hudTex, transparent: true, toneMapped: false, depthWrite: false, fog: false }));
    this.hud.renderOrder = 6;
    this.scene.add(this.hud);
  }

  #buildFx() {
    const seed = this.rite.fxSeed >>> 0;
    this.sparks = new Bursts({ count: 320, size: 0.14, gravity: -6, seed });
    this.trail = new Bursts({ count: 140, size: 0.09, gravity: 0.6, drag: 0.96, seed: seed ^ 0x9e3779b9 });
    this.scene.add(this.sparks.points, this.trail.points);
    this.pops = [];
    for (let k = 0; k < POPS; k++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.popTex, transparent: true, depthTest: false, toneMapped: false }));
      s.visible = false;
      s.renderOrder = 9;
      s.scale.set(1.1, 0.55, 1);
      this.scene.add(s);
      this.pops.push({ s, life: 0, x: 0, y: 0 });
    }
    this.popAt = 0;
  }

  /** Show every pooled mesh for the host's compile draw; the next render hides what is idle. */
  #warm() {
    for (const s of this.heartPool) {
      for (const o of [...s.hearts, ...s.fills, ...s.rings, s.arrow]) o.visible = true;
    }
    for (const s of this.beamPool) for (const o of [...s.walls, ...s.cores, s.lane]) o.visible = true;
    for (const s of this.ringPool) for (const o of [s.band, s.wedge, s.crystal, s.pulse]) o.visible = true;
    for (const p of this.pops) p.s.visible = true;
  }

  // ---- layout -------------------------------------------------------------

  layout(aspect) {
    super.layout(aspect);
    if (!this._built) return;
    // The scoreboard hangs over the far edge, facing the camera.
    this.world(0, FIELD.hh + 1.2, this.hud.position);
    this.hud.position.y = 2.1;
    this.hud.quaternion.copy(this.camera.quaternion);
    this.hud.scale.setScalar(11);
  }

  // ---- cues ---------------------------------------------------------------

  cue(ev) {
    const v = this._v;
    if (!Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return;
    this.world(ev.x, ev.y, v);
    v.y = MOTE_H;
    if (ev.type === 'gold') {
      this.dodgeFlash = 1;
      this.sparks.emit(v, 18, { color: 0xffe4a0, speed: 2.6, life: 0.6, up: 2 });
      this.sparks.emit(v, 10, { color: this.blue, speed: 2.0, life: 0.5, up: 1.4 });
      const p = this.pops[this.popAt];
      this.popAt = (this.popAt + 1) % POPS;
      p.life = 0.9; p.x = ev.x; p.y = ev.y;
    } else if (ev.type === 'break') {
      this.hitFlash = 1;
      this.sparks.emit(v, 40, { color: this.pink, speed: 4.2, life: 0.7, up: 2.2 });
      this.kick.y = 0.12;
      this.kick.pitch = 0.012;
    } else if (ev.type === 'tick') {
      this.sparks.emit(v, 8, { color: this.blue, speed: 1.6, life: 0.4, up: 1 });
    } else if (ev.type === 'perfect') {
      this.sparks.emit(v, 70, { color: 0xffd27a, speed: 5, life: 1.0, up: 3 });
    }
  }

  // ---- the frame ----------------------------------------------------------

  render(alpha, dt) {
    const R = this.rite;
    const t = R.t + alpha * MINIGAMES.dt;
    this.clock += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.2);
    this.dodgeFlash = Math.max(0, this.dodgeFlash - dt * 3);
    this.kick.y *= 0.82;
    this.kick.pitch *= 0.82;

    const a = Number.isFinite(alpha) ? clamp(alpha, 0, 1) : 0;
    const mx = R.pmx + (R.mx - R.pmx) * a;
    const my = R.pmy + (R.my - R.pmy) * a;

    // No camera drift: the host re-picks a resting pointer every frame, so a
    // drifting camera would read as pointer motion and steal the mote from the keys.
    this.#renderMote(mx, my, dt);
    this.#renderStrikes(t);
    this.#paintHud(t);

    for (const p of this.pops) {
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.life -= dt;
      const f = clamp(p.life / 0.9, 0, 1);
      p.s.visible = true;
      this.world(p.x, p.y, p.s.position);
      p.s.position.y = MOTE_H + 0.6 + (1 - f) * 1.0;
      p.s.material.opacity = Math.min(1, f * 1.8);
    }

    this.sparks.update(dt);
    this.trail.update(dt);
  }

  #renderMote(mx, my, dt) {
    const R = this.rite;
    const bob = Math.sin(this.clock * 3.1) * 0.06;
    this.world(mx, my, this.mote.position);
    this.mote.position.y = MOTE_H + bob;
    this.mote.quaternion.copy(this.camera.quaternion);
    this.world(mx, my, this.shadow.position);
    this.shadow.position.y = 0.012;
    this.shadow.scale.setScalar(1 - bob);
    this.moteLight.position.copy(this.mote.position);

    const flap = Math.sin(this.clock * 14) * 0.5;
    this.wingL.rotation.y = 0.35 + flap;
    this.wingR.rotation.y = -0.35 - flap;
    this.halo.position.y = 0.36 + Math.sin(this.clock * 2.3) * 0.02;

    const hf = this.hitFlash;
    this.coreMat.color.copy(this.white).lerp(this.pink, hf);
    this.glow.material.color.setRGB(1, 0.94, 0.78).lerp(this.pink, hf);
    this.glow.scale.setScalar(1.3 + this.dodgeFlash * 0.8 + Math.sin(this.clock * 5) * 0.06);
    this.moteLight.intensity = 2.5 + this.dodgeFlash * 3;

    this.reticle.visible = R.steering && Math.hypot(R.tx - mx, R.ty - my) > 0.35;
    if (this.reticle.visible) {
      this.world(R.tx, R.ty, this.reticle.position);
      this.reticle.position.y = 0.02;
    }

    this.trailAcc += dt;
    if (this.trailAcc > 0.03) {
      this.trailAcc = 0;
      this._v.copy(this.mote.position);
      this._v.y -= 0.05;
      this.trail.emit(this._v, 1, { color: 0xfff0c0, speed: 0.25, life: 0.55, up: 0.2 });
    }
  }

  #renderStrikes(t) {
    const R = this.rite;
    for (const s of this.heartPool) s.used = -1;
    for (const s of this.beamPool) s.used = -1;
    for (const s of this.ringPool) s.used = -1;
    let strikeI = 0;
    let hp = 0, bp = 0, rp = 0;
    for (let i = 0; i < R.nextAim; i++) {
      const h = R.hazards[i];
      if (t > h.end + 0.6) continue;
      if (h.kind === HEART && hp < POOL) { this.#heart(this.heartPool[hp++], i, h, t); strikeI = Math.max(strikeI, this.#heat(h, t)); }
      else if (h.kind === BEAM && bp < POOL) { this.#beam(this.beamPool[bp++], i, h, t); strikeI = Math.max(strikeI, this.#heat(h, t)); }
      else if (h.kind === RING && rp < POOL) { this.#ring(this.ringPool[rp++], i, h, t); strikeI = Math.max(strikeI, this.#heat(h, t)); }
    }
    for (; hp < POOL; hp++) this.#hideHeart(this.heartPool[hp]);
    for (; bp < POOL; bp++) this.#hideBeam(this.beamPool[bp]);
    for (; rp < POOL; rp++) this.#hideRing(this.ringPool[rp]);
    this.strikeLight.intensity = strikeI * 10;
  }

  /** 0..1: how hot a strike is right now, for the strike light. */
  #heat(h, t) {
    if (t < h.strike) return 0.3 * clamp((t - h.t0) / (h.strike - h.t0), 0, 1);
    return t <= h.end ? 1 : 0;
  }

  #hideHeart(s) {
    for (let k = 0; k < HEART_SLOTS; k++) { s.hearts[k].visible = false; s.fills[k].visible = false; s.rings[k].visible = false; }
    s.arrow.visible = false;
  }

  #heart(s, i, h, t) {
    const P = this.rite.params;
    const r = P.heartR;
    const warn = h.strike - h.t0;
    const p = clamp((t - h.t0) / warn, 0, 1);
    const live = t >= h.strike && t <= h.strike + HEART_LIVE;
    const after = t > h.strike + HEART_LIVE ? clamp((t - h.strike - HEART_LIVE) / 0.5, 0, 1) : 0;
    // The decal is the hit disc, exactly. It fills as the hearts fall.
    s.fillMat.opacity = live ? 0.9 : (0.3 + 0.45 * p) * (1 - after);
    s.ringMat.opacity = (live ? 1 : 0.8 + 0.2 * Math.sin(this.clock * 16)) * (1 - after);
    s.arrowMat.opacity = t < h.strike ? 0.75 + 0.25 * Math.sin(this.clock * 10) : 0;
    // Falling: still high for the first third, then accelerating onto the mark.
    const fall = clamp((p - 0.25) / 0.75, 0, 1);
    const hgt = FALL_FROM * (1 - fall * fall);
    for (let k = 0; k < HEART_SLOTS; k++) {
      const f = s.fills[k], ring = s.rings[k], heart = s.hearts[k];
      f.visible = ring.visible = after < 1;
      this.world(h.hx[k], h.hy[k], f.position);
      f.position.y = 0.015;
      f.scale.setScalar(r);
      ring.position.copy(f.position);
      ring.position.y = 0.02;
      ring.scale.setScalar(r);
      heart.visible = after < 1 && p > 0.05;
      heart.position.copy(f.position);
      const squash = live ? 1 - 0.35 * Math.sin(((t - h.strike) / HEART_LIVE) * Math.PI) : 1;
      heart.position.y = hgt + r * 0.62 * squash;
      heart.scale.set(r * 0.7 * (2 - squash), r * 0.7 * squash, r * 0.7).multiplyScalar(1 - after);
      heart.rotation.set(0, this.clock * 1.6 + k, 0);
    }
    if (live) {
      this.world(h.ax, h.ay, this.strikeLight.position);
      this.strikeLight.position.y = 1;
    }
    if (t >= h.strike && !this.landed[i]) {
      this.landed[i] = 1;
      for (let k = 0; k < HEART_SLOTS; k++) {
        this.world(h.hx[k], h.hy[k], this._v);
        this._v.y = 0.3;
        this.sparks.emit(this._v, 9, { color: this.pink, speed: 3, life: 0.5, up: 1.6 });
      }
      this.kick.y = Math.max(this.kick.y, 0.05);
    }
    s.arrow.visible = t < h.strike;
    if (s.arrow.visible) {
      const d = r + 0.55 + Math.sin(this.clock * 8) * 0.08;
      this.world(h.ax + Math.cos(h.gap) * d, h.ay + Math.sin(h.gap) * d, s.arrow.position);
      s.arrow.position.y = 0.03;
      s.arrow.rotation.y = h.gap;
      s.arrow.scale.setScalar(0.9);
    }
  }

  #hideBeam(s) {
    for (const o of s.walls) o.visible = false;
    for (const o of s.cores) o.visible = false;
    s.lane.visible = false;
  }

  #beam(s, i, h, t) {
    const R = this.rite;
    const P = R.params;
    const p = clamp((t - h.t0) / (h.strike - h.t0), 0, 1);
    const firing = t >= h.strike;
    const along = h.axis === 0;                 // the wall runs along field y and sweeps along x
    const E = (along ? FIELD.hh : FIELD.hw) + 0.4;
    const w = R.wallAt(i, Math.max(t, h.strike));
    const fade = t > h.end ? clamp(1 - (t - h.end) / 0.4, 0, 1) : 1;
    const lo0 = -E, lo1 = h.gc - P.beamGap;
    const hi0 = h.gc + P.beamGap, hi1 = E;
    const rise = firing ? 1 : 0.08 + 0.92 * p * p;
    s.wallMat.opacity = (firing ? 0.85 : 0.35 + 0.2 * Math.sin(this.clock * 18)) * fade;
    for (let k = 0; k < 2; k++) {
      const a = k === 0 ? lo0 : hi0;
      const b = k === 0 ? lo1 : hi1;
      const len = Math.max(0.001, b - a);
      const mid = (a + b) / 2;
      const wall = s.walls[k], core = s.cores[k];
      wall.visible = len > 0.01 && fade > 0;
      core.visible = wall.visible && firing;
      if (along) this.world(w, mid, wall.position); else this.world(mid, w, wall.position);
      wall.position.y = 0;
      if (along) wall.scale.set(BEAM_TH * 2, WALL_H * rise, len);
      else wall.scale.set(len, WALL_H * rise, BEAM_TH * 2);
      core.position.copy(wall.position);
      if (along) core.scale.set(0.08, WALL_H * rise * 1.02, len);
      else core.scale.set(len, WALL_H * rise * 1.02, 0.08);
    }
    // The lane is the way out: blue, across the whole field, until the wall has passed.
    s.lane.visible = fade > 0;
    s.laneMat.opacity = (0.45 + 0.3 * Math.sin(this.clock * 6)) * fade;
    if (along) {
      this.world(0, h.gc, s.lane.position);
      s.lane.scale.set(FIELD.w + 0.8, 1, P.beamGap * 2);
    } else {
      this.world(h.gc, 0, s.lane.position);
      s.lane.scale.set(P.beamGap * 2, 1, FIELD.h + 0.8);
    }
    s.lane.position.y = 0.012;
    if (firing && t <= h.end) {
      if (along) this.world(w, h.gc, this.strikeLight.position); else this.world(h.gc, w, this.strikeLight.position);
      this.strikeLight.position.y = 1;
    }
  }

  #hideRing(s) {
    s.band.visible = false; s.wedge.visible = false; s.crystal.visible = false; s.pulse.visible = false;
  }

  #ring(s, i, h, t) {
    const R = this.rite;
    const p = clamp((t - h.t0) / (h.strike - h.t0), 0, 1);
    const firing = t >= h.strike;
    const fade = t > h.end ? clamp(1 - (t - h.end) / 0.4, 0, 1) : 1;
    const rad = R.ringAt(i, t);
    s.crystal.visible = fade > 0;
    this.world(h.sx, h.sy, s.crystal.position);
    s.crystal.position.y = 0.9 + Math.sin(this.clock * 4) * 0.1;
    s.crystal.rotation.y = this.clock * (firing ? 1.5 : 4 + p * 8);
    s.crystal.scale.setScalar((firing ? 0.8 : 0.6 + 0.6 * p) * fade);

    s.pulse.visible = !firing;
    if (s.pulse.visible) {
      this.world(h.sx, h.sy, s.pulse.position);
      s.pulse.position.y = 0.02;
      const ph = (this.clock * 2.2) % 1;
      s.pulse.scale.setScalar(0.3 + ph * 1.6);
      s.pulseMat.opacity = 0.9 * (1 - ph);
    }

    s.wedge.visible = fade > 0;
    this.world(h.sx, h.sy, s.wedge.position);
    s.wedge.position.y = 0.011;
    s.wedge.rotation.y = h.gap;
    s.wedgeMat.opacity = (firing ? 0.45 : 0.3 + 0.35 * p + 0.1 * Math.sin(this.clock * 9)) * fade;

    s.band.visible = firing && rad > 0.05 && fade > 0;
    if (s.band.visible) {
      this.world(h.sx, h.sy, s.band.position);
      s.band.rotation.y = h.gap;
      s.band.scale.set(rad, 1.1, rad);
      s.bandMat.opacity = 0.85 * fade * clamp(1.2 - rad / 20, 0.3, 1);
      if (t <= h.end) {
        this.world(h.sx, h.sy, this.strikeLight.position);
        this.strikeLight.position.y = 1.2;
      }
    }
  }

  /** Repainted only when the count changes. */
  #paintHud(t) {
    const R = this.rite;
    let seen = 0;
    for (let i = 0; i < R.nextAim; i++) if (R.inCourse[i] && t >= R.hazards[i].strike) seen++;
    const h = this._hud;
    if (h.cleared === R.cleared && h.burned === R.burned && h.seen === seen) return;
    h.cleared = R.cleared; h.burned = R.burned; h.seen = seen;
    const g = this.hudCanvas.getContext('2d');
    const W = this.hudCanvas.width, H = this.hudCanvas.height;
    g.clearRect(0, 0, W, H);
    // A dark plate under the text: the set behind it is cream and white.
    const n = R.presented;
    const span = Math.min(W - 160, n * 44);
    const plateW = Math.max(span + 70, 560);
    g.fillStyle = 'rgba(22, 28, 64, 0.62)';
    g.beginPath();
    g.roundRect((W - plateW) / 2, 4, plateW, H - 8, 34);
    g.fill();
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    g.font = '700 96px Georgia, serif';
    g.fillStyle = this.P.gold;
    g.fillText(`${R.cleared}`, W / 2 - 12, 58);
    g.textAlign = 'left';
    g.font = '600 50px ui-monospace, Menlo, monospace';
    g.fillStyle = '#fff6e2';
    g.fillText(`/ ${n} DODGED`, W / 2 + 8, 62);
    // One pip per strike in the course: blue dodged, pink touched, pale still to come.
    let idx = 0;
    for (let i = 0; i < HAZARDS && idx < n; i++) {
      if (!R.inCourse[i]) continue;
      const x = W / 2 - span / 2 + (span * (idx + 0.5)) / n;
      g.beginPath();
      g.arc(x, 124, R.touched[i] || R.passed[i] ? 14 : 10, 0, Math.PI * 2);
      g.fillStyle = R.touched[i] ? this.P.pink : R.passed[i] ? this.P.accent : 'rgba(255,255,255,0.35)';
      g.fill();
      idx++;
    }
    this.hudTex.needsUpdate = true;
  }

  dispose() {
    this.own(this.hudTex);
    super.dispose();
  }
}

export function createView(stage, rite) {
  return new HeavenView(stage, rite);
}

