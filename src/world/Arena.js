import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GRID } from '../core/Config.js';
import {
  makeFlagstoneMaps, makeRoadMaps, makeDecayMaps, makeMacroMaps,
  makeRuneBand, makeGlowSprite, fbm,
} from '../assets/ProceduralTextures.js';
import { PathMask } from './terrain/PathMask.js';
import {
  createGroundUniforms, createGroundMaterial, createGroundDepthMaterial,
  createRimStoneMaterial,
} from './terrain/GroundMaterial.js';
import { rectPath, sweepProfile, sweepBand } from './terrain/Sweep.js';
import { Tufts } from './terrain/Tufts.js';

const PLATEAU_Y = 0.20;      // buildable stone sits this far above nominal 0
// ROUND 4b. The rim used to be a 2.4-unit-thick moulding whose centreline sat
// 1.2 units outside the play field, so the coping's top slab spanned ~1.8 units
// in plan. At a 52-degree camera that slab projects to 1.4 units of screen
// extent against 0.78 for the retaining wall below it — MEASURED with the
// rimMaterial's uDebugTag (red = wall, green = coping): the coping was ~2/3 of
// the rim's pixels and the wall read as a stripe. The board's edge is now a
// WALL with a kerb on top, not a kerb with a wall under it, so the whole
// assembly is pulled in tight against the play field.
const RIM_OUT = 0.45;        // rim path centreline, outside the play field
const GROUND_OVER = 0.60;    // ground plane overshoot, hidden under the kerb
const TALUS_AXIS = new THREE.Vector3(0, 1, 0);   // scratch, #buildTalus

/**
 * ROUND 5 — WHERE THE WALL IS BROKEN.  (Art Bible §0 law 6)
 *
 * The round-4b wall was, by the coordinator's own account, well built. Three
 * independent blind critics failed the frame anyway and all three named the
 * same thing: it is CONTINUOUS. "A single unbroken extruded rectangle with a
 * flat top and perfectly straight silhouette running the full perimeter."
 * "The highest-contrast edge in the frame, so the eye goes to a decorative
 * frame instead of the combat." A wall is allowed; a border is not.
 *
 * Law 6 also states the acceptance test: terrain must read as continuous
 * ACROSS the boundary at at least TWO POINTS PER SIDE. These are those points,
 * chosen rather than scattered (law 5 — a density function is not composition):
 *
 *  - The two LANE MOUTHS. The creep road runs to the board edge at x = 0 on
 *    both the north and south sides (grid.spawn.c / goal.c are both 12 on a
 *    26-wide board). Collapsing the wall exactly there means the road visibly
 *    ENTERS AND EXITS the board instead of dead-ending into masonry, which is
 *    the same authored gesture the environment agent is building outboard of
 *    us and the one every reference frame has.
 *  - Six further collapses at asymmetric, non-repeating positions, deliberately
 *    unequal in width so no two sides read the same.
 *
 * Expressed in WORLD space, not in arc length, because three consumers need
 * the same field and only one of them has a path: the sweep (geometry), the
 * ground shader (drift and rubble spilling through, so the floor material
 * crosses the line too) and Tufts (vegetation straddling the wall).
 *
 * `hx`/`hz` are the wall LINE. `half` is the half-length of the collapse along
 * the side. `axisX = 1` for the north/south sides, which run along X.
 */
function makeBreaches(hx, hz) {
  return [
    // north (z = -hz)
    { x: 0.0, z: -hz, half: 3.6, axisX: 1 },    // the spawn road, through the wall
    { x: -15.5, z: -hz, half: 2.6, axisX: 1 },
    // east (x = +hx)
    { x: hx, z: -9.0, half: 2.9, axisX: 0 },
    { x: hx, z: 7.6, half: 1.9, axisX: 0 },
    // south (z = +hz)
    { x: 0.0, z: hz, half: 3.6, axisX: 1 },     // the goal road
    { x: 12.8, z: hz, half: 2.2, axisX: 1 },
    // west (x = -hx)
    { x: -hx, z: -12.2, half: 2.0, axisX: 0 },
    { x: -hx, z: 5.4, half: 3.1, axisX: 0 },
  ];
}

/**
 * The collapse amount at a world position. `reach` is how far inboard/outboard
 * of the wall line the breach still has an influence — 0 for the geometry
 * (which is evaluated on the line itself) and several units for the material,
 * where the point is precisely that the spill carries onto the board floor.
 */
function breachField(breaches, x, z, reach = 0) {
  let b = 0;
  for (const B of breaches) {
    const along = B.axisX ? Math.abs(x - B.x) : Math.abs(z - B.z);
    const across = B.axisX ? Math.abs(z - B.z) : Math.abs(x - B.x);
    // Flat through the middle, shoulders over the outer 45% of the width.
    const a = 1 - smoothstep(B.half * 0.55, B.half, along);
    const c = reach > 0 ? 1 - smoothstep(reach * 0.25, reach, across) : 1;
    b = Math.max(b, a * c);
  }
  return b;
}

/**
 * The play space: a raised arcane flagstone plateau cut by a sunken creep
 * lane, ringed by a crafted stone coping, with two arcane gates anchoring the
 * composition.
 */
export class Arena {
  constructor(scene, grid, aniso = 8) {
    this.scene = scene;
    this.grid = grid;
    this.group = new THREE.Group();
    this.group.name = 'arena';
    scene.add(this.group);

    const t0 = performance.now();
    const parts = {};
    const step = (name, fn) => { const t = performance.now(); const r = fn(); parts[name] = +(performance.now() - t).toFixed(1); return r; };
    this.mask = step('mask', () => new PathMask(grid, 8));
    this.tex = {
      flag: step('flag', () => makeFlagstoneMaps(640, aniso)),
      road: step('road', () => makeRoadMaps(320, aniso)),
      decay: step('decay', () => makeDecayMaps(320, aniso)),
      macro: step('macro', () => makeMacroMaps(256, aniso)),
      runes: step('runes', () => makeRuneBand(768, 96, { density: 22, seed: 11 })),
      // A second, COARSER band for the rim. The portals' band is 22 glyphs per
      // 768px tile; wrapped around a 194-unit perimeter at the repeat the kerb
      // needs, its glyphs land ~3px apart and alias into a dotted line, which
      // is PITFALLS #6 exactly. 10 glyphs on a 1024x112 tile puts them ~13px
      // apart at gameplay framing, and the tile's 9:1 aspect matches the
      // chamfer band's length:height so the glyphs are not stretched.
      runesRim: step('runesRim', () => makeRuneBand(1024, 112,
        { density: 8, seed: 23, stroke: 0.34, blurR: 4 })),
      glow: step('glow', () => makeGlowSprite(96, 2.6)),
    };
    this.forgeMs = performance.now() - t0;
    this.forgeParts = parts;
    if (typeof window !== 'undefined') {
      window.__terrainForgeMs = this.forgeMs;
      window.__terrainForgeParts = parts;
    }

    this.uniforms = createGroundUniforms({
      flag: this.tex.flag,
      road: this.tex.road,
      decay: this.tex.decay,
      macro: this.tex.macro.texture,
      mask: this.mask.texture,
      maskSize: { x: this.mask.w, y: this.mask.h },
    });

    this.#buildGround();
    this.#buildRim();
    this.#buildTalus();
    this.#buildPortals();
    this.#buildGridOverlay();

    this.tufts = step('tufts', () => new Tufts(this, { max: 620 }));
    this.group.add(this.tufts.mesh);

    this._pathDirty = false;
    this._t = 0;
  }

  // =========================================================================
  // Ground
  // =========================================================================

  #buildGround() {
    const w = GRID.width, h = GRID.height;
    // Overshoot the play field so the rim can overlap it — no crack, ever (G9).
    const ow = w + GROUND_OVER * 2, oh = h + GROUND_OVER * 2;
    // TESSELLATION AND THE TRIANGLE BUDGET.
    //
    // Round 4 took this to 12/cell (150k tris) so the 1.0-unit retaining wall
    // would land across ~1.7 quads instead of one stretched quad. It worked,
    // and it was 84k triangles for a wall the camera sees edge-on at 55 degrees
    // — the frame went over the 900k budget and terrain was the reason.
    //
    // Back to 8. The wall face is paid for in the MATERIAL instead: the courses,
    // mortar and chipped corners were always analytic (there is no per-block
    // geometry anywhere in this tree), and the face's normal is now derived by
    // differentiating the sink field rather than read off vertex normals, so
    // its SHADING does not depend on tessellation at all. What tessellation
    // buys is only the plan-view silhouette of the terrace edge, and that is
    // bought back for free by widening the kerb band from 0.060 to 0.085 of
    // mask value (~0.20 -> ~0.29 world units of run). The wall is then 1.35
    // quads deep and still 74 degrees steep — visually indistinguishable from
    // the 12/cell version at gameplay framing, verified by capture.
    const segX = GRID.cols * 8, segZ = GRID.rows * 8;

    const geo = new THREE.PlaneGeometry(ow, oh, segX, segZ);
    geo.rotateX(-Math.PI / 2);

    // Cache of the static relief so surfaceHeightAt() can answer exactly what
    // the vertex shader computed, without re-running fbm per query.
    this._relief = {
      nx: segX + 1, nz: segZ + 1, ow, oh,
      data: new Float32Array((segX + 1) * (segZ + 1)),
    };

    // Rewrite UV so u -> +X and v -> +Z, matching the mask texture's layout.
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      uv.setXY(i, x / w + 0.5, z / h + 0.5);

      // Static macro relief. Kept modest on the plateau so tower plinths seat
      // flat; the sunken lane gets its character from the shader displacement.
      const u = (x / ow + 0.5) * 5, v = (z / oh + 0.5) * 5;
      const n = fbm(u, v, { period: 5, octaves: 4, seed: 101 });
      const fine = fbm(u * 6.3, v * 6.3, { period: 30, octaves: 3, seed: 211 });
      // Fall away toward the rim so the platform reads as a slab, not a sheet.
      const dEdge = Math.min(w / 2 - Math.abs(x), h / 2 - Math.abs(z));
      const edge = Math.min(1, Math.max(0, dEdge) / 2.4);
      // The overshoot beyond the play field dives under the rim coping.
      const skirt = Math.max(0, -dEdge) * 0.45;
      const y = PLATEAU_Y
        + ((n - 0.5) * 0.16 + (fine - 0.5) * 0.05) * Math.max(0.18, edge)
        - skirt;
      pos.setY(i, y);
      this._relief.data[i] = y;
    }
    geo.computeVertexNormals();
    geo.setAttribute('uv1', geo.attributes.uv);
    this.groundGeo = geo;

    const mat = createGroundMaterial(this.uniforms);
    this.groundMaterial = mat;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    // ROUND 4, TRIED AND REJECTED — MEASURED, not assumed.
    //
    // The terrace throwing a shadow across the lane is half of what makes the
    // maze readable, so this was flipped to true. Captured: a hard sawtooth
    // ~half a cell across ran the entire length of every lane edge, plainly a
    // G9 fail. Ablation — set castShadow=false, recapture the identical crop —
    // the sawtooth vanished completely and nothing else in the frame moved. So
    // it was the ground's own silhouette aliasing in a 46-unit-wide ortho
    // shadow frustum, exactly what the original comment predicted.
    //
    // The shadow is now generated ANALYTICALLY in the ground shader instead
    // (see the TERRACE DROP SHADOW block in GroundMaterial): the shader already
    // knows the wall height and can read the mask up-sun, so it can produce the
    // same shadow with no shadow map, no resolution limit and no aliasing.
    mesh.castShadow = false;
    mesh.customDepthMaterial = createGroundDepthMaterial(this.uniforms);
    mesh.name = 'ground';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.ground = mesh;
  }

  // =========================================================================
  // Rim: a built object, not a box
  // =========================================================================

  /**
   * ROUND 4b — THE RIM STOPS BEING A PLATFORM EDGE.
   *
   * What was here: a coping, an outward-facing rune fascia, a moulding band, a
   * battered wall running down to y = -5.60, an underside turn-in at -6.55 and
   * a 5.4-unit black box under all of it. Every one of those elements exists to
   * describe the edge of something *suspended*. The Art Bible's founding
   * sentence specified a starlit abyss; it has been deleted (law 1: there is no
   * void, the world is lit and textured to every frame edge and the board is
   * embedded in a place).
   *
   * What is here now: a LOW RETAINING WALL of exactly the same height as an
   * interior terrace wall — the plateau is at +0.20, the wall foot meets the
   * surround at lane-floor level (-0.80), so the perimeter step is `uRoadDepth`
   * to the unit, the same 1.00 the maze is cut with. The board reads as ground
   * that somebody levelled, not as a plinth. The coping is KEPT: it is the
   * strongest horizontal line in the frame and against a landscape it reads as
   * a kerb rather than as a parapet.
   *
   * The environment agent owns everything beyond the wall and meets us at
   * `Surround.SHELF = -0.80`, measured from `laneFloor`. The footing splays out
   * and turns under BELOW that level, so the joint stays sealed even where the
   * surround's coarse polar mesh dips a little under -0.80.
   *
   * Cheaper as well as more correct: the battered wall and the underbelly were
   * ~7k triangles of pure loss, drawn only to hide a hole we no longer have.
   */
  #buildRim() {
    const hx = GRID.width / 2 + RIM_OUT;
    const hz = GRID.height / 2 + RIM_OUT;
    const STONE = 2.05;
    const path = rectPath(hx, hz, 0.5, STONE);
    this.breaches = makeBreaches(hx, hz);
    const breachOnLine = (x, z) => breachField(this.breaches, x, z, 0);
    // Same table, three consumers: the sweep (geometry), the ground shader
    // (rubble spilling inboard) and Tufts (vegetation straddling the line). A
    // second copy of these numbers anywhere would drift from the wall it is
    // supposed to be spilling out of.
    const ub = this.uniforms.uBreach.value;
    for (let i = 0; i < ub.length; i++) {
      const B = this.breaches[i];
      if (B) ub[i].set(B.x, B.z, B.half, B.axisX);
      else ub[i].set(0, 0, 0, 0);
    }
    // Never hardcode a Y (docs/STATUS conventions): the lane floor is where the
    // surround has been told to meet us, and it is derived, not chosen.
    const LANE = PLATEAU_Y - this.uniforms.uRoadDepth.value;   // -0.80
    const WALL_TOP = PLATEAU_Y - 0.06;                         // +0.14, under the drip

    // Profile: buried under the floor, up the kerb's inner face, over the
    // coping, down the fascia, down the coursed retaining wall to the
    // landscape, then a buried footing that turns in and closes the shell.
    // BREACH TARGETS (bY/bO). Derived, not eyeballed: the ground plane
    // overshoots the play field by GROUND_OVER and dives on a 0.45 skirt, so at
    // rim offset `o` its surface sits at PLATEAU_Y - (RIM_OUT + o) * 0.45 and it
    // ENDS at o = GROUND_OVER - RIM_OUT = +0.15, y = -0.07. Every collapsed
    // vertex inboard of that is placed a few centimetres BELOW the floor above
    // it, so a breach can never open a hole through the board (which would show
    // the surround straight through the play field — far worse than the border
    // it is meant to fix), and from o = 0.15 outward the profile runs as a
    // progressively steepening talus bank down to the untouched footing.
    const P = (o, y, opts = {}) => ({ o, y, ...opts });
    const profile = [
      // The buried apron is taken BELOW lane level: where the maze runs out to
      // the board edge the ground sinks by uRoadDepth, and an apron pitched for
      // the plateau would surface straight through the lane floor.
      P(-1.05, LANE - 0.30),                                 // buried, under the floor
      P(-0.62, LANE - 0.10, { hard: true }),
      P(-0.58, PLATEAU_Y + 0.26, { cop: true, bY: 0.06 }),   // inner face of the kerb
      P(-0.42, PLATEAU_Y + 0.40, { cop: true, hard: true, bY: 0.04 }), // inner chamfer
      P(0.30, PLATEAU_Y + 0.44, { cop: true, bY: -0.19, bO: 0.34 }),  // coping top
      P(0.42, PLATEAU_Y + 0.33, { cop: true, hard: true, bY: -0.30, bO: 0.46 }),
      P(0.46, WALL_TOP, { cop: true, hard: true, bY: -0.36, bO: 0.52 }), // fascia / drip
      // --- the retaining wall: three courses, BATTERED OUTWARD --------------
      //
      // MEASURED, and it invalidated the first version of this profile. The
      // wall originally battered INWARD (o 1.152 -> 1.020 over the drop), under
      // a coping that projected to o = 1.152. At the gameplay pitch of ~52 deg
      // the sight line past the coping's outer arris falls 1.19 units for every
      // unit inward, so a point on the wall face clears the coping only if
      //     y + (1.152 - o) * 1.19 > 0.14
      // which, along that batter, reduces to y > 0.14 — i.e. NEVER. The entire
      // retaining wall was occluded by its own coping in every frame, and the
      // capture showed exactly that: coping, a two-pixel dark line, grass.
      //
      // A retaining wall batters outward at the foot anyway (that is what makes
      // it retain), so this is the correct build as well as the visible one.
      // The 0.03 the fascia still projects is a drip: enough for a shadow line
      // under the kerb, 0.036 units of hidden wall.
      //
      // The 0.006 step exists so the wall's TOP row of vertices carries
      // aWall = 1: `hard` duplicates a profile point with its own tags, so
      // without it the masonry would ramp in from zero over the whole top
      // course instead of starting under the drip.
      // Tagged `cop` as well as `wall` so the per-stone jitter moves it WITH the
      // fascia above it. Without that a crumbled coping block drops 0.2 while
      // the wall top stays put, the sliver between them inverts, and you get a
      // hairline crack straight through the rim (G9).
      P(0.43, WALL_TOP - 0.006, { wall: true, cop: true, bY: -0.34, bO: 0.50 }),
      P(0.60, LANE + 0.42, { wall: true, bY: -0.58, bO: 0.66 }),
      P(0.75, LANE - 0.02, { wall: true }),                  // meets the surround
      // --- buried below the surround from here down ------------------------
      P(0.92, LANE - 0.32, { wall: true, hard: true }),      // footing splay
      P(-1.05, LANE - 0.44, { hard: true }),                 // turn in, closed
    ];

    // Per-block variation: heights, slight lean, and a handful of ruined blocks.
    const jitter = (s) => {
      const r1 = hash(s, 17), r2 = hash(s, 91), r3 = hash(s, 313);
      // Capped at 5.5 -> 2.2. The old crumble could drop a coping block 0.55
      // units; against a 0.44-proud kerb that punches a notch clean through to
      // the ground's cut edge, and against the wall top it inverts the drip.
      // Max total drop is now ~0.22, which still reads as a ruined block.
      const ruined = r3 > 0.86 ? (r3 - 0.86) * 2.2 : 0;
      return {
        dy: (r1 - 0.5) * 0.075 - ruined * 0.30,
        doff: (r2 - 0.5) * 0.10 - ruined * 0.12,
        crumble: ruined,
      };
    };

    const geo = sweepProfile(path, profile, { jitter, uvScale: 0.30, breach: breachOnLine });
    // Cooled and DARKENED from 0xb9b2ad. That colour was chosen when the rim was
    // read as craft; measured against the round-4b capture it is the brightest
    // large object in the frame, and the critics' verdict was unanimous — "a
    // bright hard bar". The stone is now a shade under the board floor it edges,
    // so the wall no longer out-values the combat happening inside it.
    //
    // ROUND 7 — 0x8f8d8c -> 0x66645f. The floor's exposure came down 0.86 ->
    // 0.30 for law 8 (see GroundMaterial.uAlbedoGain). The rim does NOT go
    // through uAlbedoGain, so leaving this colour alone would have handed the
    // brightest-object title straight from the floor to the wall that edges it
    // — the exact defect this line already records from round 4b, one round
    // later. Tracked as a ratio, not re-eyeballed: the floor lost ~0.35x of its
    // linear albedo, and 0x8f8d8c at 0.35x lands near 0x59.
    //
    // The first attempt at this opened it back up to 0x66645f, reasoning that a
    // wall is vertical and takes less key than a floor. CAPTURED, and wrong:
    // most of the rim's PIXELS are the coping, which is horizontal and takes
    // exactly as much key as the floor does — that is the same measurement
    // round 4b recorded three paragraphs above (the coping is ~2/3 of the rim's
    // screen area). At 0x66645f the perimeter came straight back as the
    // brightest large object in the frame. Held at the derived ratio instead.
    const mat = createRimStoneMaterial(this.tex.flag.albedo, this.tex.flag.nra, {
      color: 0x555349, normalGain: 1.15, roughBias: 0.04, envMapIntensity: 0.42,
      uvScale: 1.0, courseH: 0.335, blockLen: 0.95, stoneLen: STONE,
      wallTop: WALL_TOP,
    });
    this.rimMaterial = mat;
    const rim = new THREE.Mesh(geo, mat);
    rim.castShadow = true;
    rim.receiveShadow = true;
    rim.name = 'rim';
    rim.matrixAutoUpdate = false;
    rim.updateMatrix();
    this.group.add(rim);
    this.rim = rim;

    // --- emissive rune frieze, on the coping's INNER face --------------------
    //
    // ROUND 4b. These runes lived on `sweepBand(path, -0.80, -1.72, +0.804)` —
    // the OUTER fascia, below the coping, on a vertical surface facing away
    // from a camera pitched 55 degrees down. They have never once appeared in a
    // capture, in any round. (House pitfall: a feature that has never been
    // switched on has never been tested; this one was rendered every frame into
    // pixels no camera could reach, which is the same thing.)
    //
    // The coping's inner chamfer is the opposite case: it faces up and inward,
    // so it presents 0.49-0.98 of its area to this camera on ALL FOUR edges of
    // the board, and it frames the play area instead of pointing at the
    // landscape. The band runs from just above the plateau, up the kerb's inner
    // face and across the chamfer, floated 0.02 proud of both.
    const runeTop = { o: -0.42 - 0.012, y: PLATEAU_Y + 0.40 + 0.020 };
    const runeBot = { o: -0.58 - 0.028, y: PLATEAU_Y + 0.02 };
    // `breach` + the segment gate inside sweepBand are the whole point here.
    // A continuous glowing line all the way round the board is the literal
    // definition of the picture frame law 6 forbids, and the critics measured
    // it as the single highest-contrast edge in the image.
    const bandGeo = sweepBand(path, runeTop.y, runeBot.y, runeTop.o,
      { uvRepeat: 34, offsetBot: runeBot.o, breach: breachOnLine });
    const runeTex = this.tex.runesRim;
    runeTex.wrapS = THREE.RepeatWrapping;
    const runeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: runeTex },
        uColor: { value: new THREE.Color(0x3d8dff).convertSRGBToLinear() },
      },
      vertexShader: /* glsl */`
        attribute float aLive;
        varying vec2 vUv;
        varying float vLive;
        void main() {
          vUv = uv;
          vLive = aLive;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        varying float vLive;
        uniform sampler2D uMap;
        uniform vec3 uColor;
        uniform float uTime;
        void main() {
          if (vLive < 0.004) discard;
          float g = texture2D(uMap, vec2(vUv.x, clamp(vUv.y, 0.06, 0.94))).a;
          // a charge travelling around the rim keeps the frame alive (G6)
          float sweep = 0.55 + 0.45 * sin(vUv.x * 6.2831 * 2.0 - uTime * 0.55);
          float breathe = 0.7 + 0.3 * sin(uTime * 1.3);
          // CONTINUOUS CHANNEL + GLYPHS, in that order of importance.
          //
          // The glyphs alone were the whole signal, and at gameplay framing this
          // band is ~11px tall: the strokes mip-average away and the inlay read
          // as a featureless hairline. So the base layer is now a smooth groove
          // of light that survives any resolution, with the glyphs riding on top
          // of it — the same LOD discipline the ground's engraving uses, and the
          // opposite of PITFALLS 6 (a feature that degrades into an artefact
          // instead of into a wash).
          float groove = smoothstep(0.0, 0.34, vUv.y) * smoothstep(1.0, 0.62, vUv.y);
          // ROUND 5. Halved, and gated by vLive. At full strength this frieze
          // was measured by three blind critics as the highest-contrast edge in
          // the whole frame — brighter than the towers it is supposed to be
          // framing. It survives as a dim charge in surviving fragments of the
          // coping, and it dies wherever the wall has collapsed.
          float a = (groove * 0.22 + g * 0.70) * (0.22 + sweep * 0.34) * breathe;
          a *= smoothstep(0.0, 0.55, vLive);
          gl_FragColor = vec4(uColor * (0.55 + sweep * 0.75), a);
        }`,
    });
    const band = new THREE.Mesh(bandGeo, runeMat);
    band.name = 'rimRunes';
    band.renderOrder = 2;
    this.group.add(band);
    this.runeMaterial = runeMat;

    this.#buildContactShadow(path, LANE);

    // The dark underbelly slab (5.4 units tall, top at -1.4) used to live here,
    // "so the void never shows through". There is no void: the surround's
    // heightfield runs continuously under the board at SHELF = laneFloor, so
    // anything that could see past the retaining wall sees landscape. Deleting
    // it costs nothing and removes the one genuinely black object in the frame.
  }

  /**
   * THE TALUS BELT — spoil, gravel and rubble overrunning the ground-plane seam.
   *
   * ROUND 7. All three blind critics ranked this their #1 defect, and all three
   * described the same fix: "sink the slab into terrain — sunken lip, sloped
   * earth shoulder, GRAVEL SCATTER breaking the seam"; "bury the slab into the
   * terrain, let grass, dirt and RUBBLE overrun the edges"; "there is a hard
   * rectangular seam where slab meets grass".
   *
   * This is NOT the round-5 breach work repeating itself. Round 5 broke the
   * WALL — its silhouette is interrupted at eight authored places and that is
   * landed and correct. What is still a perfect rectangle is the GROUND-PLANE
   * TRANSITION underneath it: whether the wall is standing or collapsed, board
   * stops and lawn starts along one dead-straight line, 188 units long, with
   * nothing lying across it. Tufts already put weeds on that line; a weed is
   * three pixels of silhouette and cannot carry a material transition.
   *
   * So: a belt of spoil straddling the foot. Three things make it break the
   * seam rather than decorate it —
   *
   *  - it STRADDLES. Every stone is placed on an outward offset drawn from
   *    -0.55 (inside the board, on the flagstone) to +2.6 (out on the grass),
   *    so the same population of objects stands on both materials. That is what
   *    makes an eye read one continuous ground rather than two abutting slabs;
   *    it is the same argument Tufts records for its crossing band, applied to
   *    the material transition instead of to the silhouette.
   *  - it is UNEVEN. Density is gated by a long-wavelength clump hash along the
   *    run and boosted hard at the breaches, so there are banks of spoil where
   *    the wall has fallen and clean stretches elsewhere. Law 5: even
   *    distribution is the definition of undifferentiated, and a continuous
   *    fringe of gravel would just be a second border drawn parallel to the
   *    first one.
   *  - stones SINK. Scale is biased small and each is dropped 20-55% of its own
   *    radius below the surface it stands on, so they read as half-buried spoil
   *    rather than as props set down on a lawn (§0 corollary: nothing meets the
   *    ground with a clean seam).
   *
   * Heights are derived exactly the way Tufts derives them — surfaceHeightAt()
   * while the ground plane still exists, then interpolated down the collapsed
   * talus bank to laneFloor. Nothing hardcodes a Y.
   *
   * Cost: one draw call, ~8.6k triangles at 430 instances (icosahedron, 20
   * faces). Shares this.rimMaterial, so it is the same stone as the wall it
   * fell off, with no second texture set and no extra material.
   */
  #buildTalus() {
    // Three rounded lumps, merged into one instanced geometry with a random
    // pick per instance via a vertex-attribute-free trick: the instance matrix
    // carries a non-uniform scale and a rotation, which is enough variety at
    // this size. A single icosahedron kept the triangle cost at 20 faces.
    const base = new THREE.IcosahedronGeometry(0.5, 0);
    // Push the vertices around so it is a broken lump of masonry, not a d20.
    const bp = base.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i);
      const n = hash(Math.round((x + 2) * 71) + Math.round((z + 2) * 131), Math.round((y + 2) * 197));
      const k = 0.72 + n * 0.56;
      bp.setXYZ(i, x * k, y * k * 0.66, z * k);
    }
    base.computeVertexNormals();
    base.setAttribute('uv1', base.attributes.uv);

    const MAX = 430;
    const mesh = new THREE.InstancedMesh(base, this.rimMaterial, MAX);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = 'talus';
    mesh.matrixAutoUpdate = false;

    const halfW = GRID.width / 2, halfH = GRID.height / 2;
    const hxLine = halfW + RIM_OUT, hzLine = halfH + RIM_OUT;
    // Same derivation as Tufts' crossing band: the ground plane's skirted edge,
    // then the talus bank down to the footing.
    const EDGE_O = GROUND_OVER - RIM_OUT, EDGE_Y = PLATEAU_Y - (RIM_OUT + EDGE_O) * 0.45;
    const FOOT_O = 0.75;
    const laneY = PLATEAU_Y - this.uniforms.uRoadDepth.value;

    let seed = 0x2545f491;
    const rnd = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) / 4294967296);
    };

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const perim = 2 * (hxLine + hzLine) * 2;
    let n = 0;
    for (let k = 0; k < MAX * 14 && n < MAX; k++) {
      const u = rnd() * perim;
      let x, z, ox, oz;
      if (u < 2 * hxLine) { x = -hxLine + u; z = -hzLine; ox = 0; oz = -1; }
      else if (u < 2 * hxLine + 2 * hzLine) { x = hxLine; z = -hzLine + (u - 2 * hxLine); ox = 1; oz = 0; }
      else if (u < 4 * hxLine + 2 * hzLine) { x = hxLine - (u - 2 * hxLine - 2 * hzLine); z = hzLine; ox = 0; oz = 1; }
      else { x = -hxLine; z = hzLine - (u - 4 * hxLine - 2 * hzLine); ox = -1; oz = 0; }

      // Uneven by construction. Two incommensurate wavelengths along the run
      // gate whole stretches in or out; the breach field then piles spoil where
      // the wall actually came down.
      const clump = Math.sin(u * 0.41 + 1.3) * 0.5 + Math.sin(u * 0.137 - 0.6) * 0.5;
      const br = this.breachAt(x, z);
      const density = Math.max(0, clump) * 0.72 + br * 0.95 + 0.11;
      if (rnd() > density) continue;

      // Outward offset: negative is inboard, on the flagstone.
      const o = -0.85 + Math.pow(rnd(), 0.80) * 3.70;   // inboard limit keeps stones clear of the outermost build cells
      const px = x + ox * o + (rnd() - 0.5) * 0.5;
      const pz = z + oz * o + (rnd() - 0.5) * 0.5;
      let y;
      if (o <= EDGE_O) y = this.surfaceHeightAt(px, pz);
      else if (o <= FOOT_O) {
        const t = (o - EDGE_O) / (FOOT_O - EDGE_O);
        y = EDGE_Y + (laneY - EDGE_Y) * t * t;
      } else y = laneY;

      // Small and biased smaller: this is spoil, not scenery. The few large
      // ones land at the breaches, where a collapsed course genuinely would.
      const sc = 0.26 + Math.pow(rnd(), 2.1) * (0.42 + br * 0.72);
      q.setFromAxisAngle(TALUS_AXIS.set(rnd() - 0.5, 1.0, rnd() - 0.5).normalize(),
                         rnd() * Math.PI * 2);
      s.set(sc * (0.8 + rnd() * 0.6), sc * (0.55 + rnd() * 0.5), sc * (0.8 + rnd() * 0.6));
      // Half-buried: dropped by a fraction of its own height.
      p.set(px, y - s.y * (0.20 + rnd() * 0.35), pz);
      m.compose(p, q, s);
      mesh.setMatrixAt(n, m);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.talus = mesh;
  }

  /**
   * CONTACT OCCLUSION + CAST SHADOW AT THE FOOT OF THE BOARD  (round 5)
   *
   * All three blind critics wrote the same sentence in different words: "the
   * board floats on nothing… no cast shadow, no ambient occlusion at its base,
   * and no transition geometry to the surrounding plane." The transition
   * geometry is the breached talus banks above. This is the other two.
   *
   * It cannot be done with a shadow map. The wall is one unit tall, the key is
   * high, and the surround's shadow frustum spans the whole landscape — the
   * same 46-unit ortho resolution problem that made the terrace's own shadow a
   * sawtooth in round 4 (see #buildGround). So it is drawn: a flat, multiplied,
   * ground-hugging skirt around the outside of the footing, made of two
   * superposed terms —
   *
   *   1. AMBIENT OCCLUSION. Symmetric, tight (~1.2 units), strongest right in
   *      the joint. This is the term that stops the wall reading as a decal
   *      standing on grass.
   *   2. A CAST SHADOW, thrown down-sun, length driven live from the key light
   *      by the same #syncSun() that steers the terrace's analytic shadow, so
   *      it can never disagree with the tower shadows lying beside it.
   *
   * Blending is Multiply with depthWrite off, which per PITFALLS §3 excludes it
   * from the GTAO prepass automatically — a large translucent plane in that
   * G-buffer would paint a hard dark wedge over everything behind it, which is
   * exactly the artefact that cost us a round.
   */
  #buildContactShadow(path, laneY) {
    const REACH = 4.6;                 // outer extent of the longest shadow
    const P = path.length;
    const pos = new Float32Array((P + 1) * 3 * 3);
    const off = new Float32Array((P + 1) * 3);      // 0 at the wall -> 1 outside
    const nrm = new Float32Array((P + 1) * 3 * 2);  // outward XZ normal
    const idx = [];
    const rings = [0.55, 1.35, REACH];
    for (let i = 0; i <= P; i++) {
      const p = path[i % P];
      for (let j = 0; j < 3; j++) {
        const k = i * 3 + j;
        pos[k * 3] = p.x + p.nx * rings[j];
        pos[k * 3 + 1] = laneY + 0.035;
        pos[k * 3 + 2] = p.z + p.nz * rings[j];
        off[k] = rings[j];
        nrm[k * 2] = p.nx;
        nrm[k * 2 + 1] = p.nz;
      }
    }
    for (let i = 0; i < P; i++) {
      for (let j = 0; j < 2; j++) {
        const a = i * 3 + j, b = (i + 1) * 3 + j;
        idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aOff', new THREE.BufferAttribute(off, 1));
    geo.setAttribute('aNrm', new THREE.BufferAttribute(nrm, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.MultiplyBlending,
      // three refuses to set up MultiplyBlending without this and logs
      // "MultiplyBlending requires material.premultipliedAlpha = true" once per
      // frame. It is not cosmetic: without it the blend equation is never
      // configured and the skirt draws as flat colour over the surround.
      premultipliedAlpha: true,
      uniforms: {
        uSunXZ: this.uniforms.uSunXZ,
        uReach: { value: REACH },
        uShadowLen: { value: 1.9 },
      },
      vertexShader: /* glsl */`
        attribute float aOff;
        attribute vec2 aNrm;
        varying float vOff;
        varying vec2 vN;
        varying vec2 vW;
        void main() {
          vOff = aOff; vN = aNrm; vW = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying float vOff;
        varying vec2 vN;
        varying vec2 vW;
        uniform vec2 uSunXZ;
        uniform float uReach, uShadowLen;
        void main() {
          // 1. contact AO — tight, symmetric, in the joint.
          float ao = 1.0 - smoothstep(0.0, 1.25, vOff - 0.55);
          ao *= ao;
          // 2. cast shadow — only on the side the shadow actually travels to.
          //    uSunXZ already points AWAY from the sun (Arena.#syncSun).
          float lit = dot(normalize(vN), uSunXZ);
          // NB: not named "cast". That is a RESERVED WORD in GLSL ES and the
          // shader silently failed to compile — the whole skirt was absent from
          // the frame with nothing thrown, PITFALLS 9's corollary to the letter.
          float thr = uShadowLen * max(0.0, lit);
          float shd = 1.0 - smoothstep(thr * 0.35, thr + 0.35, vOff - 0.55);
          shd *= smoothstep(0.0, 0.30, lit);
          // Ragged edge: a perfectly parallel shadow band around a rectangle is
          // a second picture frame, which is the defect we are here to remove.
          float rag = sin(vW.x * 0.83 + vW.y * 0.51) * 0.5
                    + sin(vW.x * 0.29 - vW.y * 1.13) * 0.5;
          shd *= 0.72 + rag * 0.28;
          float dark = clamp(ao * 0.62 + shd * 0.46, 0.0, 0.86);
          // Shadows keep colour (Art Bible §8): cool violet, never neutral black.
          gl_FragColor = vec4(mix(vec3(1.0), vec3(0.34, 0.38, 0.52), dark), 1.0);
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'boardContactShadow';
    mesh.renderOrder = 1;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.noAO = true;
    this.group.add(mesh);
    this.contactShadow = mesh;
  }

  // =========================================================================
  // Portals
  // =========================================================================

  #buildPortals() {
    const g = this.grid;
    const spawn = g.cellToWorld(g.spawn.c + 0.5, 1.0, {});
    const goal = g.cellToWorld(g.goal.c + 0.5, g.rows - 2.0, {});

    this.spawnPortal = this.#portal(spawn.x, spawn.z, 0x63d8ff, 'spawn', -1);
    this.goalPortal = this.#portal(goal.x, goal.z, 0xff4a52, 'goal', 1);
    this.spawnWorld = new THREE.Vector3(spawn.x, 0, spawn.z);
    this.goalWorld = new THREE.Vector3(goal.x, 0, goal.z);
  }

  #portal(x, z, colorHex, name, facing) {
    const group = new THREE.Group();
    // Portals sit in the sunken corridor.
    group.position.set(x, PLATEAU_Y - this.uniforms.uRoadDepth.value, z);
    group.name = name;
    const color = new THREE.Color(colorHex).convertSRGBToLinear();

    // --- standing stones: real geometry that anchors the gate ---------------
    const parts = [];
    const COUNT = 7;
    for (let i = 0; i < COUNT; i++) {
      // leave the lane mouth open
      // Arc them around the inner half of the gate so the lane mouth stays open.
      const a = Math.PI * (0.12 + (i / (COUNT - 1)) * 0.76);
      const side = facing < 0 ? 1 : -1;
      const rad = 3.55 + hash(i, 3) * 0.35;
      const hgt = 1.5 + hash(i, 9) * 2.3;
      const wdt = 0.5 + hash(i, 21) * 0.34;
      const gx = Math.cos(a) * rad, gz = Math.sin(a) * rad * side;
      const mono = new THREE.BoxGeometry(wdt, hgt, wdt * 0.72, 1, 3, 1);
      // taper + erode
      const p = mono.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const ty = (p.getY(k) / hgt) + 0.5;
        const s = 1 - ty * 0.28;
        const n = fbm(p.getX(k) * 3 + i, p.getY(k) * 3, { period: 8, octaves: 3, seed: 40 + i });
        p.setX(k, p.getX(k) * s * (0.9 + n * 0.22));
        p.setZ(k, p.getZ(k) * s * (0.9 + n * 0.22));
      }
      mono.computeVertexNormals();
      mono.translate(0, hgt / 2 - 0.15, 0);
      mono.rotateY(-a + hash(i, 55) * 0.5);
      mono.rotateX((hash(i, 77) - 0.5) * 0.13);
      mono.rotateZ((hash(i, 88) - 0.5) * 0.13);
      mono.translate(gx, 0, gz);
      parts.push(mono);
    }
    const monoGeo = mergeGeometries(parts, false);
    // The rim material is shared with these standing stones. aWall = 0 keeps
    // the analytic coursing off them (they are single eroded monoliths, not
    // built masonry); aCoping = 0 keeps the dressed-slab jointing off too.
    const nMono = monoGeo.attributes.position.count;
    monoGeo.setAttribute('aCoping', new THREE.BufferAttribute(new Float32Array(nMono), 1));
    monoGeo.setAttribute('aWall', new THREE.BufferAttribute(new Float32Array(nMono), 1));
    monoGeo.setAttribute('aU', new THREE.BufferAttribute(new Float32Array(nMono), 1));
    monoGeo.setAttribute('aBreach', new THREE.BufferAttribute(new Float32Array(nMono), 1));
    const monoMesh = new THREE.Mesh(monoGeo, this.rimMaterial);
    monoMesh.castShadow = true;
    monoMesh.receiveShadow = true;
    group.add(monoMesh);

    const glowMat = (frag, extra = {}) => new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: color },
        uMap: { value: this.tex.runes },
        ...extra,
      },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vPos;
        void main() {
          vUv = uv; vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: frag,
    });

    const NOISE = /* glsl */`
      float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x),
                   mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
      }
      float fbm2(vec2 p){
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { s += vnoise(p) * a; p *= 2.03; a *= 0.5; }
        return s;
      }`;

    // --- ground scar: cracked, glowing floor around the gate ----------------
    const scarGeo = new THREE.RingGeometry(0.4, 4.6, 96, 3);
    scarGeo.rotateX(-Math.PI / 2);
    const scarMat = glowMat(/* glsl */`
      precision highp float;
      varying vec2 vUv; varying vec3 vPos;
      uniform float uTime; uniform vec3 uColor;
      ${NOISE}
      void main() {
        float r = length(vPos.xz) / 4.6;
        float a = atan(vPos.z, vPos.x);
        float cracks = fbm2(vec2(a * 6.0, r * 7.0 - uTime * 0.05));
        cracks = pow(smoothstep(0.46, 0.72, cracks), 1.4);
        float fall = smoothstep(1.0, 0.12, r);
        float pulse = 0.6 + 0.4 * sin(uTime * 1.6 - r * 5.0);
        float alpha = cracks * fall * pulse * 0.85 + fall * fall * 0.16;
        gl_FragColor = vec4(uColor * (1.2 + cracks * 2.4), alpha);
      }`);
    const scar = new THREE.Mesh(scarGeo, scarMat);
    scar.position.y = 0.035;
    scar.renderOrder = 3;
    group.add(scar);

    // --- the gate mouth: an inverted cone of turbulent light -----------------
    const vortGeo = new THREE.CylinderGeometry(3.05, 1.55, 4.4, 64, 12, true);
    const vortMat = glowMat(/* glsl */`
      precision highp float;
      varying vec2 vUv; varying vec3 vPos;
      uniform float uTime; uniform vec3 uColor;
      ${NOISE}
      void main() {
        float h = vUv.y;
        float swirl = fbm2(vec2(vUv.x * 9.0 + uTime * 0.22 + h * 2.4, h * 5.0 - uTime * 0.75));
        float strands = smoothstep(0.42, 0.86, swirl);
        float rise = smoothstep(0.0, 0.30, h) * smoothstep(1.0, 0.42, h);
        float a = strands * rise * 0.62;
        a += rise * 0.055;
        gl_FragColor = vec4(uColor * (0.9 + strands * 2.6), a);
      }`);
    const vortex = new THREE.Mesh(vortGeo, vortMat);
    vortex.position.y = 2.25;
    vortex.renderOrder = 4;
    group.add(vortex);

    // --- two counter-rotating rune rings -------------------------------------
    const rings = [];
    for (let i = 0; i < 2; i++) {
      const rIn = i === 0 ? 2.30 : 1.62;
      const rOut = i === 0 ? 3.05 : 2.18;
      const rg = new THREE.RingGeometry(rIn, rOut, 96, 1);
      rg.rotateX(-Math.PI / 2);
      // remap uv so the rune band wraps around the annulus
      const p = rg.attributes.position, uvA = rg.attributes.uv;
      for (let k = 0; k < p.count; k++) {
        const px = p.getX(k), pz = p.getZ(k);
        const ang = (Math.atan2(pz, px) / (Math.PI * 2)) + 0.5;
        const rr = Math.hypot(px, pz);
        uvA.setXY(k, ang * (i === 0 ? 9 : 7), (rr - rIn) / (rOut - rIn));
      }
      const rm = glowMat(/* glsl */`
        precision highp float;
        varying vec2 vUv; varying vec3 vPos;
        uniform float uTime; uniform vec3 uColor; uniform sampler2D uMap;
        void main() {
          float g = texture2D(uMap, vec2(vUv.x, clamp(vUv.y, 0.08, 0.92))).a;
          float edge = smoothstep(0.0, 0.14, vUv.y) * smoothstep(1.0, 0.86, vUv.y);
          float pulse = 0.55 + 0.45 * sin(uTime * 2.0 + vUv.x * 18.0);
          float a = g * (0.35 + pulse * 0.9) * 0.9 + edge * 0.10;
          gl_FragColor = vec4(uColor * (1.3 + pulse * 1.9), a);
        }`);
      const ring = new THREE.Mesh(rg, rm);
      ring.position.y = i === 0 ? 0.45 : 1.55;
      ring.renderOrder = 4;
      ring.userData.spin = i === 0 ? 0.16 : -0.27;
      group.add(ring);
      rings.push(ring);
    }

    // --- the event horizon ----------------------------------------------------
    const coreGeo = new THREE.CircleGeometry(1.62, 64);
    coreGeo.rotateX(-Math.PI / 2);
    const coreMat = glowMat(/* glsl */`
      precision highp float;
      varying vec2 vUv; varying vec3 vPos;
      uniform float uTime; uniform vec3 uColor;
      ${NOISE}
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        if (r > 1.0) discard;
        float a0 = atan(p.y, p.x);
        // spiral inflow: angle shears with radius so it reads as depth
        float shear = a0 + (1.0 - r) * 3.4 - uTime * 0.9;
        float swirl = fbm2(vec2(shear * 1.5, (1.0 - r) * 4.0 + uTime * 0.35));
        float depth = pow(1.0 - r, 1.8);
        float body = swirl * (0.35 + depth * 1.5);
        float lip = smoothstep(0.14, 0.0, abs(r - 0.93));
        float alpha = clamp(body * smoothstep(1.0, 0.55, r) + lip * 0.9, 0.0, 1.6);
        vec3 col = mix(uColor * 0.8, vec3(1.0), depth * 0.55 * swirl);
        gl_FragColor = vec4(col * (1.1 + body * 2.0), alpha);
      }`);
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.y = 0.09;
    core.renderOrder = 5;
    group.add(core);

    // --- particulate rising out of the gate -----------------------------------
    const N = 90;
    const pp = new Float32Array(N * 3);
    const ph = new Float32Array(N * 3);   // radius, angle, speed
    for (let i = 0; i < N; i++) {
      ph[i * 3] = 0.5 + Math.random() * 2.6;
      ph[i * 3 + 1] = Math.random() * Math.PI * 2;
      ph[i * 3 + 2] = 0.25 + Math.random() * 0.85;
      pp[i * 3 + 1] = Math.random() * 5;
    }
    const ptGeo = new THREE.BufferGeometry();
    ptGeo.setAttribute('position', new THREE.BufferAttribute(pp, 3));
    const ptMat = new THREE.PointsMaterial({
      size: 0.22, map: this.tex.glow, color: colorHex,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      sizeAttenuation: true, opacity: 0.9,
    });
    const motes = new THREE.Points(ptGeo, ptMat);
    motes.frustumCulled = false;
    motes.renderOrder = 5;
    group.add(motes);

    const light = new THREE.PointLight(colorHex, 16, 20, 2);
    light.position.y = 1.8;
    group.add(light);

    group.userData = {
      materials: [scarMat, vortMat, coreMat, ...rings.map((r) => r.material)],
      rings, light, motes, ptGeo, ph, N,
    };
    this.group.add(group);
    return group;
  }

  // =========================================================================
  // Build grid overlay — arcane surveying lines
  // =========================================================================

  #buildGridOverlay() {
    const data = new Uint8Array(this.grid.cols * this.grid.rows * 4);
    const tex = new THREE.DataTexture(data, this.grid.cols, this.grid.rows, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this.occupancyTex = tex;
    this.occupancyData = data;

    const u = this.uniforms;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: {
        uTime: { value: 0 },
        uOccupancy: { value: tex },
        uGridSize: { value: new THREE.Vector2(this.grid.cols, this.grid.rows) },
        uArena: { value: new THREE.Vector2(GRID.width, GRID.height) },
        uOpacity: { value: 0.0 },
        uHover: { value: new THREE.Vector2(-99, -99) },
        // 0 valid · 1 occupied · 2 would seal the maze · 3 cannot afford.
        // Was a 0/1 "valid" flag; see setHover for why it is no longer a boolean.
        uHoverState: { value: 0 },
        uRangeCentre: { value: new THREE.Vector2(0, 0) },
        uRange: { value: 0 },
        uRangeColor: { value: new THREE.Color(0x66ccff) },
        uMask: u.uMask,
        uMacro: u.uMacro,
        uRoadDepth: u.uRoadDepth,
        uKerbLo: u.uKerbLo,
        uKerbHi: u.uKerbHi,
      },
      vertexShader: /* glsl */`
        uniform sampler2D uMask, uMacro;
        uniform float uRoadDepth, uKerbLo, uKerbHi;
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec3 tp = position;
          vec2 wxz0 = (modelMatrix * vec4(position, 1.0)).xz;
          vec4 mc2 = texture2D(uMacro, wxz0 * 0.052 + vec2(0.37, 0.11));
          vec2 warp = (vec2(mc2.r, mc2.b) - 0.5) * 0.05;
          vec4 mk = texture2D(uMask, clamp(uv + warp, vec2(0.002), vec2(0.998)));
          float k = smoothstep(uKerbLo, uKerbHi, mk.r);
          float decay = smoothstep(0.40, 0.94, mk.g + (mc2.r - 0.5) * 0.42);
          tp.y -= k * uRoadDepth + decay * 0.16 * (0.4 + mc2.g);
          tp.y += 0.035;
          vec4 wp = modelMatrix * vec4(tp, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        varying vec3 vWorld;
        uniform sampler2D uOccupancy;
        uniform vec2 uGridSize, uHover, uRangeCentre, uArena;
        uniform float uTime, uOpacity, uHoverState, uRange;
        uniform vec3 uRangeColor;

        void main() {
          // Grid coordinates are anchored to world space, not to the oversized
          // ground quad, so the lines land exactly on the build cells.
          vec2 cell = (vWorld.xz / uArena + 0.5) * uGridSize;
          vec2 f = fract(cell);
          vec2 d = min(f, 1.0 - f);
          float aa = max(fwidth(cell.x), fwidth(cell.y));

          // hairline + a softer outer bloom, so it reads as scribed light
          float core = 1.0 - smoothstep(0.0, aa * 1.1, min(d.x, d.y));
          float halo = 1.0 - smoothstep(0.0, aa * 5.5, min(d.x, d.y));

          // intersection nodes
          float node = (1.0 - smoothstep(0.0, aa * 3.2, length(d)));

          // ignition sweep: the lines light up outward from board centre
          float rad = length(vWorld.xz) / (length(uArena) * 0.5);
          float ign = clamp((uOpacity * 2.3 - rad * 1.0), 0.0, 1.0);
          float shimmer = 0.82 + 0.18 * sin(uTime * 2.2 - rad * 9.0);

          vec2 ci = floor(cell);
          vec4 occ = texture2D(uOccupancy, (ci + 0.5) / uGridSize);
          vec3 base = mix(vec3(0.35, 0.68, 1.0), vec3(1.0, 0.42, 0.22), occ.r);
          base = mix(base, vec3(1.0, 0.78, 0.32), occ.g * 0.85);

          float alpha = (core * 0.42 + halo * 0.10 + node * 0.30) * ign * shimmer;
          vec3 col = base * (0.9 + core * 1.5 + node * 1.2);

          // clip cleanly to the play field (the mesh overshoots under the rim)
          vec2 inF = step(vec2(0.0), cell) * step(cell, uGridSize);
          alpha *= inF.x * inF.y;

          // --- cut-off ground -------------------------------------------------
          // occ.b flags every cell that would lose its route to the spawn if the
          // hovered tower were placed (Pathfinder.sealPreview). Painted as a
          // barred red wash so the consequence is visible on the BOARD, not just
          // asserted by a label: the player sees the ground going dark.
          //
          // Diagonal bars, not a flat tint. A flat red over a third of the board
          // reads as a rendering fault; bars read as "barred off", and they also
          // survive being drawn over the amber road and the blue free cells,
          // which a wash of either hue would not.
          if (occ.b > 0.5) {
            float bars = sin((vWorld.x + vWorld.z) * 1.9 - uTime * 2.6);
            bars = smoothstep(0.0, 0.55, bars);
            float breathe = 0.72 + 0.28 * sin(uTime * 3.4);
            col = mix(col, vec3(1.0, 0.16, 0.13), 0.86);
            alpha = max(alpha, (0.20 + bars * 0.34) * breathe) * inF.x * inF.y;
          }

          // 2x2 hover footprint
          vec2 hd = ci - uHover;
          if (hd.x >= 0.0 && hd.x < 2.0 && hd.y >= 0.0 && hd.y < 2.0) {
            // One colour per refusal, so the ghost says WHICH rule it broke.
            // A single red for "no" is what forced the player to guess between
            // "something is already here", "I am too poor" and "this closes the
            // maze" — three problems with three different fixes.
            vec3 hc = vec3(0.40, 1.0, 0.60);                              // valid
            if (uHoverState > 2.5)      hc = vec3(1.0, 0.80, 0.24);       // poor
            else if (uHoverState > 1.5) hc = vec3(1.0, 0.14, 0.11);       // seal
            else if (uHoverState > 0.5) hc = vec3(0.82, 0.78, 0.72);      // occupied
            float pulse = 0.7 + 0.3 * sin(uTime * 6.0);
            float inner = min(min(hd.x < 1.0 ? f.x : 1.0, hd.x > 0.0 ? 1.0 - f.x : 1.0),
                              min(hd.y < 1.0 ? f.y : 1.0, hd.y > 0.0 ? 1.0 - f.y : 1.0));
            float border = 1.0 - smoothstep(0.0, 0.14, inner);
            col = hc * (1.2 + border * 1.6);
            alpha = max(alpha * 0.5, max(0.26 * pulse, border * 0.9 * pulse));

            // A sealing placement additionally gets a hard X across the pad and
            // a fast pulse. This is the one refusal the player cannot fix by
            // waiting or by clicking elsewhere nearby, so it is the one that
            // earns a symbol rather than only a hue.
            if (uHoverState > 1.5 && uHoverState < 2.5) {
              vec2 q = (hd + f) * 0.5;              // 0..1 across the 2x2 pad
              float x1 = abs(q.x - q.y);
              float x2 = abs(q.x + q.y - 1.0);
              float cross = 1.0 - smoothstep(0.0, 0.075, min(x1, x2));
              float fast = 0.55 + 0.45 * sin(uTime * 11.0);
              col = mix(col, vec3(1.0, 0.94, 0.90), cross * 0.85);
              alpha = max(alpha, cross * 0.95 * fast);
            }
          }

          // range ring
          if (uRange > 0.0) {
            float rd = distance(vWorld.xz, uRangeCentre);
            float ring = 1.0 - smoothstep(0.0, 0.26, abs(rd - uRange));
            float dash = 0.55 + 0.45 * sin(atan(vWorld.z - uRangeCentre.y, vWorld.x - uRangeCentre.x) * 44.0 + uTime * 1.2);
            float fill = smoothstep(uRange, uRange - 1.6, rd) * 0.05;
            col = mix(col, uRangeColor * (1.0 + ring), max(ring, step(0.001, fill)));
            alpha = max(alpha, ring * (0.45 + dash * 0.6) + fill);
          }

          gl_FragColor = vec4(col, alpha * uOpacity);
        }
      `,
    });

    // Shares the ground geometry, so the overlay hugs every displacement
    // exactly — no floating lines over the kerb, no z-fighting (G9).
    const mesh = new THREE.Mesh(this.groundGeo, mat);
    mesh.renderOrder = 6;
    mesh.name = 'gridOverlay';
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this.gridOverlay = mesh;
    this.gridMaterial = mat;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Keep the analytic terrace shadow pointed the same way as every real shadow
   * in the frame. The key light drifts (Lighting.update rotates it on a ~6min
   * cycle), so this is read live rather than baked; a constant would slowly
   * desync and the terrace shadows would end up disagreeing with the tower
   * shadows lying next to them, which is the sort of thing nobody can name but
   * everybody sees. Read-only — lighting belongs to another tree.
   */
  #syncSun() {
    let key = this._keyLight;
    if (key === undefined) {
      key = null;
      this.scene.traverse((o) => {
        if (!key && o.isDirectionalLight && o.castShadow) key = o;
      });
      this._keyLight = key;
    }
    if (!key) return;
    const p = key.position;
    const hx = p.x, hz = p.z;
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-3 || p.y <= 0.01) return;
    // Shadow travels away from the sun...
    this.uniforms.uSunXZ.value.set(-hx / hl, -hz / hl);
    // ...for wallHeight / tan(elevation), clamped so a low sun cannot smear a
    // shadow half way across the board.
    const len = this.uniforms.uRoadDepth.value * (hl / p.y);
    this.uniforms.uKerbShadow.value = Math.min(3.0, len);
  }

  /**
   * How collapsed the perimeter wall is at a world position, 0..1.
   * `reach` is how far inboard/outboard of the wall line the influence carries.
   * Public because Tufts has to plant vegetation ACROSS the boundary at exactly
   * the places the wall is down (law 6), and a second approximation of this
   * field would put weeds where there is no breach.
   */
  breachAt(x, z, reach = 0) {
    return this.breaches ? breachField(this.breaches, x, z, reach) : 0;
  }

  /** Flag the terrain zone mask for regeneration on the next frame. */
  markPathDirty() {
    this._pathDirty = true;
  }

  // ---- terrain height queries ---------------------------------------------
  // Nothing outside this file should ever hardcode a floor height. These are
  // the authority: decals, ground glows, footstep puffs and creep feet should
  // all place themselves with surfaceHeightAt().

  /** Nominal Y of the raised buildable plateau (where towers stand). */
  get plateauTop() { return PLATEAU_Y; }

  /** Nominal Y of the sunken creep lane floor. */
  get laneFloor() { return PLATEAU_Y - this.uniforms.uRoadDepth.value; }

  /** How far the lane sits below the plateau — the kerb step height. */
  get kerbHeight() { return this.uniforms.uRoadDepth.value; }

  /**
   * World Y of the walkable/buildable surface at a world position.
   *
   * Reproduces exactly what the ground vertex shader does: the cached static
   * relief plus the live mask-driven kerb sink. Two bilinear lookups and a
   * couple of smoothsteps — cheap enough to call per creep per frame.
   */
  surfaceHeightAt(x, z) {
    const R = this._relief;
    if (!R) return PLATEAU_Y;

    // --- static relief (bilinear over the geometry's own vertex heights) ----
    const fx = (x / R.ow + 0.5) * (R.nx - 1);
    const fz = (z / R.oh + 0.5) * (R.nz - 1);
    const x0 = Math.max(0, Math.min(R.nx - 2, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(R.nz - 2, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const tz = Math.max(0, Math.min(1, fz - z0));
    const d = R.data, nx = R.nx;
    const a = d[z0 * nx + x0], b = d[z0 * nx + x0 + 1];
    const c = d[(z0 + 1) * nx + x0], e = d[(z0 + 1) * nx + x0 + 1];
    const base = (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;

    return base - this.#sinkAt(x, z);
  }

  /** Mask-driven displacement at a world position (mirrors terrainSink()). */
  #sinkAt(x, z) {
    const u = this.uniforms;
    const mc = this.#macroAt(x * 0.052 + 0.37, z * 0.052 + 0.11);
    const au = x / GRID.width + 0.5 + (mc[0] - 0.5) * 0.05;
    const av = z / GRID.height + 0.5 + (mc[2] - 0.5) * 0.05;
    const mk = this.#maskAt(clamp01(au), clamp01(av));
    const k = smoothstep(u.uKerbLo.value, u.uKerbHi.value, mk[0]);
    const decay = smoothstep(0.40, 0.94, mk[1] + (mc[0] - 0.5) * 0.42);
    return k * u.uRoadDepth.value + decay * 0.16 * (0.4 + mc[1]);
  }

  /** Bilinear sample of the macro texture's bytes, repeat-wrapped. */
  #macroAt(u, v) {
    const m = this.tex.macro, N = m.size, D = m.data;
    const fx = u * N - 0.5, fy = v * N - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const w = (a) => ((a % N) + N) % N;
    const out = this._mtmp ?? (this._mtmp = [0, 0, 0, 0]);
    for (let ch = 0; ch < 4; ch++) {
      const p = (yy, xx) => D[(w(yy) * N + w(xx)) * 4 + ch] / 255;
      out[ch] = (p(y0, x0) * (1 - tx) + p(y0, x0 + 1) * tx) * (1 - ty)
              + (p(y0 + 1, x0) * (1 - tx) + p(y0 + 1, x0 + 1) * tx) * ty;
    }
    return out;
  }

  /**
   * Zone mask at a WORLD position — [wear, decay, grime, damp].
   * Public because scatter systems (Tufts) need to key off exactly the same
   * field the shader uses; a second, approximate copy of the wear function
   * would drift from the wall it is supposed to be growing out of.
   * The returned array is reused: copy it if you need to keep it.
   */
  sampleMask(x, z) {
    return this.#maskAt(
      clamp01(x / GRID.width + 0.5),
      clamp01(z / GRID.height + 0.5),
    );
  }

  /** Bilinear sample of the zone mask, clamped. */
  #maskAt(u, v) {
    const M = this.mask, W = M.w, H = M.h, D = M.data;
    const fx = u * W - 0.5, fy = v * H - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const cx = (a) => (a < 0 ? 0 : a > W - 1 ? W - 1 : a);
    const cy = (a) => (a < 0 ? 0 : a > H - 1 ? H - 1 : a);
    const out = this._ktmp ?? (this._ktmp = [0, 0, 0, 0]);
    for (let ch = 0; ch < 4; ch++) {
      const p = (yy, xx) => D[(cy(yy) * W + cx(xx)) * 4 + ch] / 255;
      out[ch] = (p(y0, x0) * (1 - tx) + p(y0, x0 + 1) * tx) * (1 - ty)
              + (p(y0 + 1, x0) * (1 - tx) + p(y0 + 1, x0 + 1) * tx) * ty;
    }
    return out;
  }

  refreshOccupancy() {
    const g = this.grid;
    const d = this.occupancyData;
    for (let i = 0; i < g.cells.length; i++) {
      const v = g.cells[i];
      d[i * 4] = v === 1 || v === 2 ? 255 : 0;
      d[i * 4 + 1] = v === 3 ? 255 : 0;
      d[i * 4 + 2] = 0;   // seal preview — see setSealPreview
      d[i * 4 + 3] = 255;
    }
    // This loop just wiped the seal-preview channel, so the cached flag has to
    // follow or the next clear() would be skipped as a no-op.
    this._sealPainted = false;
    this.occupancyTex.needsUpdate = true;
    // The road re-cuts itself whenever the maze changes. ~0.4ms on this board.
    this.mask.rebuild();
    this._pathDirty = false;
  }

  setGridVisible(on) {
    this._gridTargetOpacity = on ? 1 : 0;
  }

  /**
   * Move the 2x2 placement ghost and say what is wrong with it.
   *
   * `state` is a NAME, not a boolean, and unknown names resolve to 'occupied'
   * rather than to 'valid'. This used to take `valid` as a boolean, and the
   * failure mode of quietly reinterpreting it is the worst one available: a
   * stale `false` would land on 0 in the new encoding and paint an illegal cell
   * green — the UI telling the player to click somewhere the game will refuse.
   * Erring toward "invalid" makes any missed call site an annoyance instead of
   * a lie.
   */
  setHover(c, r, state = 'none') {
    const S = { valid: 0, occupied: 1, creep: 1, seal: 2, poor: 3 };
    this.gridMaterial.uniforms.uHover.value.set(c, r);
    this.gridMaterial.uniforms.uHoverState.value = S[state] ?? S.occupied;
  }

  /**
   * Paint (or clear) the ground that a hovered placement would cut off.
   * `flags` is one byte per cell from Pathfinder.sealPreview, or null to clear.
   *
   * Writes the blue channel of the occupancy texture, which nothing else uses.
   * The texture is 26x20 — a 2KB upload — so driving this from pointermove is
   * cheaper than the raycast that produced the hover in the first place.
   */
  setSealPreview(flags) {
    const d = this.occupancyData;
    if (!flags) {
      if (!this._sealPainted) return;          // already clear; skip the upload
      for (let i = 0; i < d.length; i += 4) d[i + 2] = 0;
      this._sealPainted = false;
      this.occupancyTex.needsUpdate = true;
      return;
    }
    for (let i = 0; i < flags.length; i++) d[i * 4 + 2] = flags[i] ? 255 : 0;
    this._sealPainted = true;
    this.occupancyTex.needsUpdate = true;
  }

  setRangeIndicator(x, z, range, color) {
    const u = this.gridMaterial.uniforms;
    u.uRangeCentre.value.set(x, z);
    u.uRange.value = range;
    if (color !== undefined) u.uRangeColor.value.setHex(color).convertSRGBToLinear();
  }

  update(dt, elapsed) {
    this._t = elapsed;
    // markPathDirty() is kept as an explicit fast path, but the mask no longer
    // depends on being told: nothing in the game has ever called it (see the
    // note on PathMask.maybeRebuild), so the mask watches the grid itself.
    let remasked = false;
    if (this._pathDirty) { this.mask.rebuild(); this._pathDirty = false; remasked = true; }
    else remasked = this.mask.maybeRebuild();
    // Weeds follow the terrace edges, so they re-seed with the maze.
    if (remasked && this.tufts) this.tufts.rebuild();
    if (this.tufts) this.tufts.update(elapsed);

    this.uniforms.uTime.value = elapsed;
    this.#syncSun();
    this.runeMaterial.uniforms.uTime.value = elapsed;

    const gm = this.gridMaterial.uniforms;
    gm.uTime.value = elapsed;
    const target = this._gridTargetOpacity ?? 0;
    gm.uOpacity.value += (target - gm.uOpacity.value) * (1 - Math.exp(-dt * 12));
    this.gridOverlay.visible = gm.uOpacity.value > 0.004;

    for (const p of [this.spawnPortal, this.goalPortal]) {
      const ud = p.userData;
      for (const m of ud.materials) m.uniforms.uTime.value = elapsed;
      ud.rings[0].rotation.y = elapsed * ud.rings[0].userData.spin;
      ud.rings[1].rotation.y = elapsed * ud.rings[1].userData.spin;
      ud.light.intensity = 13 + Math.sin(elapsed * 2.4) * 4;

      // rising motes
      const pos = ud.ptGeo.attributes.position.array;
      const ph = ud.ph;
      for (let i = 0; i < ud.N; i++) {
        let y = pos[i * 3 + 1] + dt * ph[i * 3 + 2] * 1.4;
        if (y > 5.2) y -= 5.2;
        const t = y / 5.2;
        const rad = ph[i * 3] * (1.0 - t * 0.55);
        const a = ph[i * 3 + 1] + elapsed * 0.5 * ph[i * 3 + 2];
        pos[i * 3] = Math.cos(a) * rad;
        pos[i * 3 + 1] = y;
        pos[i * 3 + 2] = Math.sin(a) * rad;
      }
      ud.ptGeo.attributes.position.needsUpdate = true;
    }
  }
}

// GLSL-equivalent helpers used by surfaceHeightAt()'s CPU mirror of the ground
// vertex shader. These were referenced but never defined: every call that
// reached #sinkAt() — i.e. every tower overlay rebuild — threw
// "clamp01 is not defined" and aborted the frame's update loop. Caught by the
// shot harness's error channel during round 3.
function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

function hash(a, b) {
  let h = a * 374761393 + b * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
