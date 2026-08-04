import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ALL_TOWERS, PRIMAL_TOWERS, PURE_TOWERS, DUAL_TOWERS, FOUNDATION } from '../../src/game/TowerDefs.js';
import { buildTowerSpec, SHAPE } from '../../src/game/towers/TowerArchetypes.js';
import { GRID } from '../../src/core/Config.js';

/**
 * Tower SCALE — how big a tower is, as arithmetic.
 *
 * TWO THINGS TO KNOW BEFORE READING THIS FILE.
 *
 * 1. THE SCALE LOGIC IS NOT EXTRACTED. There is no `towerScale(def, level)` to
 *    call. Every lever — PRIMAL_SHAFT, PRIMAL_MASS, PRIMAL_CROWNK, PRIMAL_ORBIT,
 *    PRIMAL_RING_H, SHAFT, SHAFT_LEVEL, SHAPE, CROWNK — is a module-private
 *    constant consumed inline by buildTowerSpec, which also builds ~30 real
 *    BufferGeometries per call. So the only way to assert the ladder is to build
 *    the geometry and measure it. That is what the file does; extracting the
 *    dimensions into a pure function is a src/ change and is recorded as a
 *    follow-up rather than done here.
 *
 * 2. IT IMPORTS THREE, AND THE VITEST CONFIG SAYS NOT TO. The rule there is
 *    "anything importing three needs a GPU context". buildTowerSpec is the
 *    exception that proves it: it touches only BufferGeometry maths and no
 *    renderer, which is exactly why tools/probe-geo.mjs already runs it under
 *    plain `node`. Measured cost of the whole table below: ~250ms, once, cached
 *    at module scope. Anything that needs a canvas still belongs in tests/e2e.
 *
 * The measurements are structural, not aesthetic. "Is it beautiful" is a
 * screenshot's job (tools/shot.mjs, tools/tower-camsil.mjs). "Does an apex tower
 * outrank every ordinary tower in the silhouette, and does it still fit on its
 * own tile" are numbers, and numbers are what silently drift.
 */

/** Half a 2x2 tile: 2 cells x GRID.cell / 2. The footprint every tower gets. */
const HALF_TILE = GRID.cell;   // 2.0

/** Build every tower at every level exactly once. ~250ms, amortised over the file. */
const SPECS = [];
for (const def of Object.values(ALL_TOWERS)) {
  for (let level = 0; level < def.levels.length; level++) {
    SPECS.push({ key: def.key, kind: def.kind, def, level, spec: buildTowerSpec(def, level) });
  }
}
const primals = SPECS.filter((s) => s.kind === 'primal');
const ordinary = SPECS.filter((s) => s.kind !== 'primal' && s.kind !== 'inert');

/** Furthest any vertex of any part sits from the tower's own axis. */
function geometryRadius(spec) {
  let max = 0;
  const scan = (geo, offset = 0) => {
    if (!geo) return;
    const a = geo.attributes.position.array;
    let local = 0;
    for (let i = 0; i < a.length; i += 3) {
      const d = Math.hypot(a[i], a[i + 2]);
      if (d > local) local = d;
    }
    if (local + offset > max) max = local + offset;
  };
  scan(spec.base); scan(spec.head); scan(spec.collar); scan(spec.halo);
  for (const sh of spec.shards) scan(sh.geo, sh.radius);
  return max;
}

/**
 * Same, but ignoring everything at plinth height — the tower's AIRBORNE mass.
 *
 * geometryRadius alone answers the wrong question for "is the apex bulkier".
 * Its maximum on an ordinary tower is almost always the decorative ground apron
 * (mushroom L1's is 3.26, and the test below records that aprons oversail the
 * tile on every family by design), while a primal's is its crown or its shard
 * orbit, eight units up. Comparing those two is comparing a skirt with a hat.
 * Above the same 2.15 threshold the ground test uses, both sides are the part
 * of the tower a player actually reads as mass.
 */
function airborneRadius(spec) {
  let max = 0;
  const scan = (geo, offset = 0, baseY = 0) => {
    if (!geo) return;
    const a = geo.attributes.position.array;
    let local = 0;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i + 1] + baseY <= PLINTH_TOP) continue;
      const d = Math.hypot(a[i], a[i + 2]);
      if (d > local) local = d;
    }
    if (local > 0 && local + offset > max) max = local + offset;
  };
  scan(spec.base); scan(spec.head, 0, spec.headY); scan(spec.collar, 0, spec.collarY);
  scan(spec.halo, 0, spec.haloY);
  for (const sh of spec.shards) scan(sh.geo, sh.radius, sh.y);
  return max;
}

/** Above this, geometry oversails air rather than stonework. Shared with the ground test. */
const PLINTH_TOP = 2.15;

describe('tower scale — sanity of the whole table', () => {
  it('produces a finite height, glow radius and glow intensity for every tower and level', () => {
    // The NaN gate. A single non-finite vertex propagates through the bloom
    // pyramid and turns the entire frame black, with no exception thrown
    // anywhere (docs/PITFALLS.md §9) — which is why probe-geo.mjs exists and why
    // it is worth having the same check run on every `npm run test:unit`.
    expect(SPECS.length).toBe(67);
    for (const { key, level, spec } of SPECS) {
      const label = `${key} L${level}`;
      expect(Number.isFinite(spec.height), `${label} height`).toBe(true);
      expect(spec.height, `${label} height`).toBeGreaterThan(0);
      expect(Number.isFinite(spec.glowRadius), `${label} glowRadius`).toBe(true);
      expect(Number.isFinite(spec.glowIntensity), `${label} glowIntensity`).toBe(true);
      expect(Number.isFinite(spec.headY), `${label} headY`).toBe(true);
      expect(Number.isFinite(spec.runeY), `${label} runeY`).toBe(true);
      for (const sh of spec.shards) expect(Number.isFinite(sh.radius), `${label} shard radius`).toBe(true);
    }
  });

  it('is deterministic: the same def and level always measure the same', () => {
    // buildTowerSpec seeds its rng from the tower key (TowerParts.hashStr), so a
    // spec is a pure function of (def, level) even though it allocates. Every
    // assertion in this file depends on that; asserting it is cheaper than
    // discovering it from a flaky failure.
    for (const key of ['primal_dark', 'fire', 'vapor']) {
      const def = ALL_TOWERS[key];
      const lv = def.levels.length - 1;
      expect(buildTowerSpec(def, lv).height).toBe(buildTowerSpec(def, lv).height);
    }
  });

  it('grows with the level within every single tower', () => {
    for (const def of Object.values(ALL_TOWERS)) {
      if (def.levels.length < 2) continue;
      const h = def.levels.map((_, l) => buildTowerSpec(def, l).height);
      for (let i = 1; i < h.length; i++) {
        expect(h[i], `${def.key} L${i} (${h[i].toFixed(2)}) vs L${i - 1} (${h[i - 1].toFixed(2)})`)
          .toBeGreaterThan(h[i - 1]);
      }
    }
  });
});

describe('tower scale — the primal ladder', () => {
  it('puts the FLOOR of the primal band above the CEILING of everything else', () => {
    /**
     * The one claim the apex round exists to make, and the one a re-tune breaks
     * first. The bug it replaced: Maelstrom L0 stood 6.08 against a plain Light
     * tower's 7.09, so the most expensive object in the game was one of the
     * shorter things on the board and "is that an ultimate" was unanswerable
     * from the silhouette.
     *
     * Written as floor-vs-ceiling rather than as literals so it survives a
     * re-tune of any individual family; the literals are pinned separately below
     * so a re-tune has to look at them.
     */
    const tallestOrdinary = Math.max(...ordinary.map((s) => s.spec.height));
    const shortestPrimal = Math.min(...primals.map((s) => s.spec.height));
    expect(tallestOrdinary).toBeCloseTo(8.11, 1);        // light L2
    expect(shortestPrimal).toBeCloseTo(8.66, 1);         // Maelstrom L0
    expect(shortestPrimal).toBeGreaterThan(tallestOrdinary);
  });

  it('steps the three primal bands upward — but they OVERLAP, which is a real caveat', () => {
    /**
     * OBSERVED, and recorded rather than wished away. The three bands are
     * ordered by both their floor and their ceiling, exactly as the PRIMAL_SHAFT
     * docblock lists them (8.66-10.32 / 9.90-11.88 / 11.25-13.56), but
     * consecutive bands OVERLAP: a Judgement L1 at 11.88 stands taller than a
     * Maelstrom L2 at 11.25, and a Judgement L0 at 10.32 taller than a Maelstrom
     * L1 at 9.90.
     *
     * So "which primal LEVEL is that" is NOT answerable from height alone across
     * elements — only within one element, where the ladder is strictly
     * increasing (asserted above and again per-family below). The cross-element
     * level cue is carried by the obelisk ring, the shard count and the ground
     * pool, all of which ARE level-monotone and family-blind. Frozen here so a
     * future round cannot believe the stronger claim by accident.
     */
    const band = (lv) => {
      const h = primals.filter((s) => s.level === lv).map((s) => s.spec.height);
      return { lo: Math.min(...h), hi: Math.max(...h) };
    };
    const b0 = band(0), b1 = band(1), b2 = band(2);
    expect([b0.lo, b0.hi].map((v) => +v.toFixed(2))).toEqual([8.66, 10.32]);
    expect([b1.lo, b1.hi].map((v) => +v.toFixed(2))).toEqual([9.90, 11.88]);
    expect([b2.lo, b2.hi].map((v) => +v.toFixed(2))).toEqual([11.25, 13.56]);

    expect(b1.lo).toBeGreaterThan(b0.lo);
    expect(b2.lo).toBeGreaterThan(b1.lo);
    expect(b1.hi).toBeGreaterThan(b0.hi);
    expect(b2.hi).toBeGreaterThan(b1.hi);

    // The overlap, asserted as the fact it is.
    expect(b1.lo).toBeLessThan(b0.hi);
    expect(b2.lo).toBeLessThan(b1.hi);

    // Within one element the ladder is unambiguous, which is what the player
    // reads when they look at THEIR tower.
    for (const def of Object.values(PRIMAL_TOWERS)) {
      const h = def.levels.map((_, l) => buildTowerSpec(def, l).height);
      expect(h[1], def.key).toBeGreaterThan(h[0]);
      expect(h[2], def.key).toBeGreaterThan(h[1]);
    }
  });

  it('compresses the family height spread instead of multiplying it', () => {
    /**
     * SHAPE[el].h runs 0.58 (earth) to 1.70 (light), a 2.9x spread. A flat
     * primal multiplier on that gives two tiers, not one — Judgement towering
     * over Tectonic by 80%. PRIMAL_H_SPREAD keeps 22% of the delta, so the six
     * primals span ~1.2x. Measured at L2: 11.25 .. 13.56 = 1.21x.
     */
    for (const lv of [0, 1, 2]) {
      const h = primals.filter((s) => s.level === lv).map((s) => s.spec.height);
      expect(Math.max(...h) / Math.min(...h), `L${lv} spread`).toBeLessThan(1.3);
    }
    // The control: the ORDINARY towers keep the full family spread, so the line
    // above is measuring something that could have come out differently.
    // Measured 1.46 for the six pures at L2 against < 1.21 for the six primals.
    const pureL2 = Object.values(PURE_TOWERS).map((d) => buildTowerSpec(d, 2).height);
    expect(Math.max(...pureL2) / Math.min(...pureL2)).toBeGreaterThan(1.4);
  });

  it('states the family spread it is compressing, and the docblock agrees', () => {
    /**
     * The 2.9x above is quoted from another file, which is the failure docs/
     * PITFALLS.md §10 is about — and it had already happened: the docblock over
     * SHAPE said "0.74 (earth) to 1.46 (light), a 2.0x height difference" and
     * "footprints run 4.9 units (earth) to 1.1", against a table that has read
     * 0.58 / 1.70 and 2.30 / 0.96 since the round-7 rewrite. Both are numbers a
     * primal re-tune leans on directly. SHAPE is exported for this line alone.
     */
    const hs = Object.values(SHAPE).map((s) => s.h);
    const foots = Object.values(SHAPE).map((s) => s.foot);
    expect(Math.min(...hs)).toBeCloseTo(0.58, 2);
    expect(Math.max(...hs)).toBeCloseTo(1.70, 2);
    expect(Math.max(...hs) / Math.min(...hs)).toBeCloseTo(2.93, 1);
    expect(Math.min(...foots)).toBeCloseTo(0.96, 2);
    expect(Math.max(...foots)).toBeCloseTo(2.30, 2);
    expect(Math.max(...foots) / Math.min(...foots)).toBeCloseTo(2.40, 1);
    // WHICH families sit at the extremes, which a pair of extrema cannot tell
    // you — and the widest foot is water, not earth, by 0.04. The old docblock
    // named earth for both, so the check is written per family.
    expect(SHAPE.earth.h).toBe(Math.min(...hs));
    expect(SHAPE.light.h).toBe(Math.max(...hs));
    expect(SHAPE.light.foot).toBe(Math.min(...foots));
    expect(SHAPE.water.foot).toBe(Math.max(...foots));
  });

  it('grows UP and not OUT: the ladder never widens the footprint at ground level', () => {
    /**
     * The footprint is 2x2 (4.0 units) and Grid, the pathfinder and the click
     * test all depend on it, so the ladder is only allowed to grow upward.
     *
     * NOTE WHAT IS ACTUALLY BEING ASSERTED, because the obvious version is
     * wrong. Plinths OVERSAIL the tile on every tower in the game and always
     * have: they are decorative aprons that merge with the neighbours', and the
     * ordinary maximum is 3.15 axis-units (mushroom L1) against the tile's 2.0
     * half-width. So "stays inside the tile" is not the rule and never was. The
     * rule is that a primal must not be WIDER AT THE GROUND THAN AN ORDINARY
     * TOWER ALREADY IS — measured 3.173 (Maelstrom L2) against 3.152, i.e. 0.7%.
     *
     * Extent is measured on each axis, not as a radius: the tile is a square, so
     * a corner sits at 2.83 while its edge sits at 2.0, and a radius test would
     * flag geometry that is comfortably inside.
     */
    const groundExtent = (spec) => {
      const a = spec.base.attributes.position.array;
      let m = 0;
      for (let i = 0; i < a.length; i += 3) {
        if (a[i + 1] > PLINTH_TOP) continue;      // above this it oversails air
        m = Math.max(m, Math.abs(a[i]), Math.abs(a[i + 2]));
      }
      return m;
    };
    const primalWidest = Math.max(...primals.map((s) => groundExtent(s.spec)));
    const ordinaryWidest = Math.max(...SPECS.filter((s) => s.kind !== 'primal')
      .map((s) => groundExtent(s.spec)));

    expect(primalWidest).toBeCloseTo(3.17, 1);
    expect(ordinaryWidest).toBeCloseTo(3.15, 1);
    expect(primalWidest, 'a primal is spreading over its neighbours\' tiles')
      .toBeLessThan(ordinaryWidest * 1.05);
    // The tile half-width, kept in view so the numbers above stay readable as
    // "aprons overlap, on purpose" rather than as a footprint bug.
    expect(HALF_TILE).toBe(2.0);
  });

  it('keeps the widest primal crown inside the documented worst case', () => {
    // Oblivion L2's crown is a ball of spikes; at 4.45 it is the widest thing on
    // the board and it sits at ~9.3 units, clear of the tallest crown any
    // neighbour can have (light L2 at 8.11), so it oversails air rather than
    // stonework. Pinned because the round-4 accident was exactly this number
    // creeping up unwatched.
    const widest = Math.max(...primals.map((s) => geometryRadius(s.spec)));
    expect(widest).toBeCloseTo(4.45, 1);
    expect(Math.max(...ordinary.map((s) => geometryRadius(s.spec)))).toBeLessThan(widest);
  });

  it('is BULKIER at the floor, not merely at the ceiling', () => {
    /**
     * THE OTHER HALF OF "bigger AND bulkier", and the half a ceiling-vs-ceiling
     * test cannot see.
     *
     * The assertion above compares the widest primal with the widest ordinary
     * tower, and 4.45 > 3.26 stays true even if five of the six primals shrink
     * below every ordinary tower. It did not stay true in spirit: measured on the
     * real table, the THINNEST primal was Judgement L0 at 2.82, narrower than
     * mushroom L1 (3.26), howitzer L1 (3.22), blacksmith L1 (3.21) and atom L0
     * (3.20) — a freshly placed 900-gold-plus-two-stacks apex was slimmer than a
     * fully forged fusion. PRIMAL_ORBIT's floor moved 1.90 -> 2.24 to fix it.
     *
     * Written floor-vs-ceiling, the same shape as the height assertion at the top
     * of this block, on BOTH axes:
     *
     *  - airborne radius is the honest one. An ordinary tower's geometryRadius
     *    maximum is its decorative ground APRON, which the "grows UP and not OUT"
     *    test below records as oversailing the tile on every family by design; a
     *    primal's is its crown or its shard orbit, eight units up. Above the
     *    plinth both sides are the mass a player actually reads.
     *  - raw geometryRadius is kept as the weaker claim, with its literals pinned
     *    next to it, because its margin is only 1.2% and anyone re-tuning the
     *    orbit should see how little room there is.
     */
    const primalFloorAir = Math.min(...primals.map((s) => airborneRadius(s.spec)));
    const ordinaryCeilAir = Math.max(...ordinary.map((s) => airborneRadius(s.spec)));
    expect(ordinaryCeilAir).toBeCloseTo(3.12, 1);      // nature / solar canopy
    expect(primalFloorAir).toBeCloseTo(3.30, 1);       // Judgement + Maelstrom L0
    expect(primalFloorAir, 'the thinnest primal is thinner than the fattest ordinary tower')
      .toBeGreaterThan(ordinaryCeilAir);

    const primalFloorRaw = Math.min(...primals.map((s) => geometryRadius(s.spec)));
    const ordinaryCeilRaw = Math.max(...ordinary.map((s) => geometryRadius(s.spec)));
    expect(ordinaryCeilRaw).toBeCloseTo(3.26, 1);      // mushroom L1, an apron
    expect(primalFloorRaw).toBeCloseTo(3.30, 1);
    expect(primalFloorRaw).toBeGreaterThan(ordinaryCeilRaw);
  });

  it('gives a primal more orbiting debris at every level, and more than any other tower', () => {
    // Round 8 hard-coded seven shards regardless of level, so a fully-forged
    // primal orbited no more debris than a freshly built one and the upgrade had
    // nothing to show above the crown.
    for (const def of Object.values(PRIMAL_TOWERS)) {
      const n = def.levels.map((_, l) => buildTowerSpec(def, l).shards.length);
      expect(n, `${def.key}`).toEqual([7, 9, 11]);
    }
    const cap = Math.max(...ordinary.map((s) => s.spec.shards.length));
    expect(cap).toBe(5);
  });

  it('gives a primal the biggest ground pool, as a ladder', () => {
    // The pool is the element cue that survives the tower being occluded by the
    // row in front (the camera sits at ~51.5 degrees of pitch), so it is the one
    // scale lever that must never be beaten by an ordinary tower.
    //
    // RADIUS is the element-blind half and is where "bigger" actually lives.
    for (const def of Object.values(PRIMAL_TOWERS)) {
      // toFixed: these are accumulated floats (6.20 + step * 0.65 lands on
      // 6.8500000000000005), and an exact toEqual would be asserting IEEE
      // rounding rather than the ladder.
      expect(def.levels.map((_, l) => +buildTowerSpec(def, l).glowRadius.toFixed(3)))
        .toEqual([6.200, 6.850, 7.500]);
    }
    expect(Math.max(...ordinary.map((s) => s.spec.glowRadius))).toBeLessThan(6.20);

    // INTENSITY is NOT element-blind, and the next test is why: the pool is
    // tinted with the element colour, so one number of watts is six wildly
    // different numbers of pixels. What every primal owes is the ladder SHAPE.
    for (const def of Object.values(PRIMAL_TOWERS)) {
      const gi = def.levels.map((_, l) => buildTowerSpec(def, l).glowIntensity);
      expect(gi[1], `${def.key} L1 pool`).toBeGreaterThan(gi[0]);
      expect(gi[2], `${def.key} L2 pool`).toBeGreaterThan(gi[1]);
    }
    // Five of the six carry the raw ladder; exactly one is damped. Written as a
    // partition rather than as "light is special" so that damping a second
    // element is a decision somebody has to come here and make.
    const raw = Object.values(PRIMAL_TOWERS).filter((def) =>
      def.levels.map((_, l) => +buildTowerSpec(def, l).glowIntensity.toFixed(3))
        .every((v, i) => v === [0.455, 0.505, 0.555][i]));
    expect(raw.length, 'the undamped primal pool ladder').toBe(5);
    expect(Object.keys(PRIMAL_TOWERS).length - raw.length).toBe(1);
  });

  it('earns the apex read from size, not from out-radiating the whole board', () => {
    /**
     * THE LADDER HAS TO BE TRUE IN PIXELS, NOT ONLY IN UNITS OF GLOW.
     *
     * Every other assertion in this block measures geometry, which is honest
     * because a metre is a metre whatever colour it is painted. Brightness is
     * not: what reaches the frame is `vColor.rgb * vMat.z` (TowerMaterial's
     * emissivemap_fragment) and `aColor * aParam.z` for the pool, i.e. the
     * element's ALBEDO times the authored intensity. ELEMENTS.light's albedo is
     * 3.5x fire's and 17x dark's, so an element-blind multiplier on the apex tier
     * is a 3.5x multiplier on light and a 1x on everything else.
     *
     * It shipped that way for a round, and the result is in the PRIMAL RADIANCE
     * DAMPING docblock: Judgement L2 painted 28.7% of its own column as blown
     * white against Cataclysm L2's 4.3%, lost its silhouette, socle and crown
     * inside one blob, and erased the two towers standing behind it. Nothing in
     * this file went red, because 0.555 is 0.555 for all six.
     *
     * So the ceiling is asserted in radiance. Both halves are read off the built
     * geometry rather than off a constant: `color` is the linear albedo the
     * shader samples and `aMat.z` is the emissive intensity it multiplies by, so
     * this is the shader's own expression evaluated in node.
     */
    const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const lumHex = (hex) => {
      const c = new THREE.Color().setHex(hex).convertSRGBToLinear();
      return lum(c.r, c.g, c.b);
    };
    const peakRadiance = (spec) => {
      let peak = 0;
      const scan = (geo) => {
        if (!geo) return;
        const c = geo.attributes.color.array;   // vec4: linear albedo + height
        const m = geo.attributes.aMat.array;    // vec4: z is emissive intensity
        for (let i = 0; i < geo.attributes.position.count; i++) {
          const e = m[i * 4 + 2];
          if (e <= 0) continue;
          const v = lum(c[i * 4], c[i * 4 + 1], c[i * 4 + 2]) * e;
          if (v > peak) peak = v;
        }
      };
      scan(spec.base); scan(spec.head); scan(spec.collar); scan(spec.halo);
      for (const sh of spec.shards) scan(sh.geo);
      return peak;
    };

    // Emissive surfaces. Measured: brightest primal 3.485 (Cataclysm L2),
    // brightest ordinary tower 3.312 (Vapor L1) — 1.05x. Undamped, Judgement L2
    // sat at 4.785, i.e. 1.44x, which is the state this test exists to reject.
    const priPeak = Math.max(...primals.map((s) => peakRadiance(s.spec)));
    const ordPeak = Math.max(...ordinary.map((s) => peakRadiance(s.spec)));
    expect(ordPeak).toBeGreaterThan(3);           // the instrument is reading something
    expect(priPeak / ordPeak, 'a primal is out-radiating the whole board')
      .toBeLessThan(1.15);

    // Ground pools, same claim on the other layer. Measured 0.2375 (Judgement
    // L2) against 0.2840 (pure Light L2) = 0.84x — a primal pool is DIMMER per
    // pixel than the brightest ordinary one and covers 2.6x the area, which is
    // the whole trade. Undamped it was 0.4318, i.e. 1.52x.
    const pool = (s) => s.spec.glowIntensity * lumHex(s.def.color);
    const priPool = Math.max(...primals.map(pool));
    const ordPool = Math.max(...ordinary.map(pool));
    expect(priPool / ordPool, 'a primal pool is out-radiating an ordinary one')
      .toBeLessThan(1.05);

    // The control, and the reason the two bounds above are not vacuous: the
    // damping only ever REMOVES light, so five of the six elements must come out
    // bit-identical to the undamped ladder. If a future edit damps everything,
    // the ratios above stay small and this line is what goes red.
    for (const s of primals) {
      if (s.def.element === 'light') continue;
      expect(+s.spec.glowIntensity.toFixed(3), `${s.key} must be undamped`)
        .toBe(+(0.455 + Math.min(s.level, 2) * 0.05).toFixed(3));
    }
  });
});

describe('tower scale — the ordinary towers are untouched', () => {
  it('leaves the pure and dual height bands where they were', () => {
    // The apex round is supposed to have moved primals and nothing else. These
    // are the numbers a stray edit to SHAFT or SHAPE would move.
    const heights = (defs, lv) => Object.values(defs).map((d) => buildTowerSpec(d, lv).height);
    expect(Math.min(...heights(PURE_TOWERS, 0))).toBeCloseTo(4.87, 1);
    expect(Math.max(...heights(PURE_TOWERS, 2))).toBeCloseTo(8.11, 1);
    expect(Math.min(...heights(DUAL_TOWERS, 0))).toBeGreaterThan(4.5);
    expect(Math.max(...heights(DUAL_TOWERS, 1))).toBeLessThan(8.11);
  });

  it('keeps the foundation the flat block it has to be', () => {
    // A foundation is a wall you walk a maze around; if it grew a silhouette it
    // would be read as a tower that had stopped shooting.
    const f = buildTowerSpec(FOUNDATION, 0);
    expect(f.height).toBeCloseTo(1.85, 2);
    expect(f.shards.length).toBe(0);
    expect(f.height).toBeLessThan(Math.min(...ordinary.map((s) => s.spec.height)));
  });
});
