/**
 * Global tuning constants. Single source of truth shared by every subsystem.
 * Keep this file dependency-free.
 */

export const GRID = {
  cols: 26,
  rows: 20,
  cell: 2.0,          // world units per cell
  get width() { return this.cols * this.cell; },
  get height() { return this.rows * this.cell; },
};

/** Cell occupancy flags. */
export const CELL = {
  FREE: 0,
  TOWER: 1,
  BLOCKED: 2,   // permanent terrain / out of play
  PATH_ONLY: 3, // creeps walk, cannot build (spawn + exit corridors)
};

export const SIM = {
  hz: 60,
  dt: 1 / 60,
  maxSubSteps: 5,
};

/**
 * Economy, matched to verified Element TD canon (docs/REFERENCE.md):
 *  - 2% interest on unspent gold every 15 seconds
 *  - leaking a creep DISABLES interest for the remainder of that wave, which is
 *    what makes leaks hurt far beyond the life lost
 *  - 11 element picks: one at the start, then one every 5 waves through wave 50
 *  - 50 lives (the Warcraft III original; ETD2 co-op uses 200)
 */
export const ECONOMY = {
  startGold: 275,
  startLives: 50,
  interestRate: 0.02,        // fraction of banked gold, per tick
  interestTick: 15,          // seconds between interest payouts
  interestCap: 6000,         // gold above this earns nothing (anti-turtle)
  sellRefund: 0.75,
  elementEveryWaves: 5,      // a pick at start, then every 5 waves
  lastElementWave: 50,
  /**
   * Extra discount on arming a foundation, on top of the foundation's cost being
   * credited in full (see FOUNDATION in TowerDefs.js). Arming is now strictly
   * CHEAPER than building the element tower outright, so mazing with blocks and
   * deciding later is the rewarded line rather than the merely cost-neutral one.
   */
  armDiscount: 0.25,
  /**
   * Life ceiling. Nothing in the game moved lives upward until Primal Dark's
   * leech; without a cap a board of Oblivions turns the life counter into a
   * second, unbounded currency and leaks stop meaning anything.
   */
  maxLives: 50,
};

/**
 * Element picker offer shape.
 *
 * rollElementChoices() used to offer only elements you did NOT own, which made
 * three copies of one element unreachable before wave 30 and Primal towers
 * therefore unreachable at all. The "echo slot" is the fix: from the second
 * draw onward one of the three cards may repeat an element you already hold.
 *
 * Every value here feeds a function of (seed, pickIndex, owned counts) only.
 * Changing them changes the offer for EVERY player in a room identically, which
 * is the only property that has to hold.
 */
export const ELEMENT_PICK = {
  slots: 3,          // cards on the picker; the roll always returns exactly this many
  echoFromPick: 1,   // pickIndex at which the echo slot opens (0 = the free opening pick)
  echoSlots: 1,      // how many of the `slots` cards may repeat an owned element
};

/**
 * Primal towers. One per element, unlocked by holding `stacksRequired` copies of
 * that element, and each BUILD spends `stacksConsumed` of them — so the tower
 * re-locks the moment you raise one and you must draw the element again.
 *
 * Selling returns the spent stacks in full (see Game.sellTower). Without that a
 * player could permanently strand themselves below a fusion they had already
 * earned, which is a trap, not a cost.
 */
export const PRIMAL = {
  stacksRequired: 3,
  stacksConsumed: 2,
};

/**
 * Wave pacing.
 *
 * `prep` is the countdown you get before a wave leaves the portal. It opens at a
 * full minute on wave 1 — enough room to actually lay out a maze — and tightens
 * by 5s per wave down to a 30s floor, so the late game is fought on a clock.
 *
 * `airEvery` puts a flying wave on a fixed, learnable cadence instead of the old
 * "wherever the ORDER array happened to land it". A fixed period is what makes
 * the one-wave-early warning meaningful: you can plan anti-air, not react to it.
 */
export const WAVES = {
  prepFirst: 60,
  prepStep: 5,
  prepFloor: 30,
  bossPrepBonus: 6,      // boss waves get a little more room, as before
  airEvery: 7,
};

/**
 * Combat modifiers applied on top of the per-tower stat tables.
 *
 * Crits are a global rule rather than a per-tower special: every armed tower
 * rolls on every direct hit. Splash, chain and damage-over-time deliberately do
 * NOT crit — a crit that multiplied a 30-target splash would swing a wave on one
 * dice roll, and the read on screen ("that shot hit hard") would be lost.
 */
export const COMBAT = {
  critChance: 0.18,
  critMult: 3.2,
};

/**
 * Camera. The board is GRID.width x GRID.height world units (52 x 40).
 *
 * There is deliberately no `startDist` magic number any more: the rig solves
 * for the distance that makes the board occupy `frameFillX` of the frame at
 * boot and on every resize (see CameraRig.frameBoard). Aspect-ratio changes
 * therefore keep the composition instead of breaking it.
 *
 * `polar` is measured from +Y, so pitch-from-horizontal = 90deg - polar.
 * startPolar 0.60 rad = 34.4deg from vertical = **55.6deg pitch**, inside the
 * Art Bible band of 52-58deg.
 */
export const CAMERA = {
  fov: 40,                 // Art Bible: 38-45, compressed diorama look
  near: 0.5,
  far: 600,

  minDist: 13,             // close inspection: one tower fills a third of frame
  maxDist: 118,            // full strategic board + generous background
  minPolar: 0.22,          // near top-down
  maxPolar: 1.10,          // low, dramatic (63deg pitch)
  maxEffPolar: 1.20,       // clamp after zoom-pitch coupling

  startAzimuth: -0.16,     // slight 3/4 so towers show two faces
  startPolar: 0.615,       // + zoom coupling at the framed distance => 53.0 deg pitch

  // --- auto-framing -------------------------------------------------------
  // Blind-critic finding: at 0.80 the board measured ~66% of frame width and
  // left large dead quadrants, which reads as "small asset in a big empty
  // room". Pushing the solver tighter puts tower detail on more pixels — the
  // cheapest available increase in apparent production value.
  frameFillX: 0.88,        // |ndc.x| the board footprint may reach
  frameTopY: 0.84,         // board must not climb above this ndc.y (sky headroom)
  frameBottomY: 0.98,      // the near rim corner stays just inside the frame
  frameMargin: 1.02,       // include the rim/parapet, not just the play field
  frameProbeHeight: 4.0,   // tallest thing on the board we still want in frame

  lookHeight: 2.2,         // aim above the floor: pushes board down, sky up

  // --- zoom / pitch coupling ---------------------------------------------
  pitchNear: 0.10,         // zoomed in -> polar opens up, towers gain height
  pitchFar: -0.02,         // zoomed out -> slightly more top-down for the map read

  // --- feel ---------------------------------------------------------------
  spring: 12.0,            // rad/s for target + orbit springs
  zoomSpring: 9.0,
  panFriction: 5.2,        // momentum decay after releasing a pan drag
  panMomentum: 0.85,
  wheelZoom: 0.0014,
  idleDelay: 1.4,          // seconds of no input before the drift ramps in
  idleRamp: 3.2,
  idleAzimuth: 0.020,
  idlePolar: 0.011,
  idleBreath: 0.012,       // fraction of dist
  shakeFreq: 23.0,
  shakeDecay: 6.0,
  shakeRoll: 0.5,
};

/**
 * Quality presets. Every knob here is consumed by RenderPipeline; nothing is
 * aspirational. `taa` is intentionally false everywhere - see the AA note in
 * RenderPipeline: hardware MSAA on the scene target + SMAA beats TAA on this
 * content because creeps move every frame.
 */
export const QUALITY_PRESETS = {
  ultra: {
    shadowMapSize: 4096, csmCascades: 4,
    ssao: true, ssaoQuality: 'gtao', ssaoSamples: 20, ssaoRadius: 3.0, ssaoIntensity: 1.0,
    msaa: 4,
    bloom: true, bloomStrength: 0.55, bloomRadius: 0.62, bloomThreshold: 2.05,
    dof: true, dofStrength: 1.0,
    // OFF. See GodRaysPass.js: the pass brightpasses the whole composite, so it
    // rakes tower emissives across the surround. Measured at -83% of the
    // off-board chroma that three rounds of agents chased through world-space
    // ablations. Do not re-enable without the occlusion mask described there.
    godrays: false,
    grain: 0.026, aberration: 1.0,
    // `motionBlur` has no pass behind it anywhere in the pipeline. Kept only so
    // the preset shape stays uniform; it is read by nothing.
    ssr: false, taa: false, motionBlur: false,
    // The single most expensive knob in this file. Each tower point light costs
    // 5.2-6.9ms because three.js charges every light to every lit pixel in the
    // scene, not to the object that owns it. Measured: 8 lights = 40.2ms, half
    // the scene render. Do not raise this on an art note without re-running
    // tools/scratch/towergroup.mjs. See docs/PERF_BUDGET.md.
    towerLights: 4,
    particleBudget: 40000, decals: true, anisotropy: 16, pixelRatioCap: 2,
  },
  high: {
    shadowMapSize: 2048, csmCascades: 3,
    ssao: true, ssaoQuality: 'gtao', ssaoSamples: 12, ssaoRadius: 3.0, ssaoIntensity: 1.0,
    msaa: 4,
    bloom: true, bloomStrength: 0.55, bloomRadius: 0.60, bloomThreshold: 2.05,
    dof: true, dofStrength: 0.85,
    godrays: false,   // see ultra
    grain: 0.024, aberration: 0.9,
    ssr: false, taa: false, motionBlur: false,
    towerLights: 3,   // see ultra: ~6ms each, charged to every lit pixel
    particleBudget: 20000, decals: true, anisotropy: 8, pixelRatioCap: 1.75,
  },
  medium: {
    shadowMapSize: 1536, csmCascades: 2,
    ssao: true, ssaoQuality: 'gtao', ssaoSamples: 8, ssaoRadius: 3.0, ssaoIntensity: 0.85,
    msaa: 4,
    bloom: true, bloomStrength: 0.50, bloomRadius: 0.55, bloomThreshold: 2.10,
    dof: false, dofStrength: 0,
    godrays: false,
    grain: 0.020, aberration: 0.6,
    ssr: false, taa: false, motionBlur: false,
    towerLights: 2,   // see ultra: ~6ms each, charged to every lit pixel
    particleBudget: 9000, decals: true, anisotropy: 4, pixelRatioCap: 1.5,
  },
  low: {
    shadowMapSize: 1024, csmCascades: 1,
    ssao: false, ssaoQuality: 'none', ssaoSamples: 0, ssaoRadius: 1.3, ssaoIntensity: 0,
    msaa: 0,
    bloom: true, bloomStrength: 0.45, bloomRadius: 0.5, bloomThreshold: 2.20,
    dof: false, dofStrength: 0,
    godrays: false,
    grain: 0.0, aberration: 0.0,
    ssr: false, taa: false, motionBlur: false,
    // Zero. The additive ground-glow decal still runs and costs nothing
    // measurable, so towers keep a coloured pool of light on their own tile;
    // what is lost is the spill onto NEIGHBOURING stonework.
    towerLights: 0,
    particleBudget: 3000, decals: false, anisotropy: 2, pixelRatioCap: 1,
  },
};

export const LAYERS = {
  DEFAULT: 0,
  BLOOM_ONLY: 1,
  NO_SHADOW: 2,

  /**
   * ATMOSPHERE — translucent volumetrics that must never contribute ambient
   * occlusion: cloud strata, ground fog, abyss glow, light shafts, smoke
   * cards, ground decals, status-effect volumes.
   *
   * WHY THIS EXISTS: GTAOPass builds its depth/normal G-buffer by re-rendering
   * the scene with an *override material*, which ignores `transparent` and
   * `depthWrite: false`. A large translucent mesh spanning the board therefore
   * lands in the G-buffer as solid geometry, and the AO shader paints a
   * hard-edged dark wedge over everything behind it.
   *
   * HOW TO TAG (environment / VFX):
   *     mesh.layers.set(LAYERS.ATMOSPHERE);
   *     mesh.layers.enable(LAYERS.DEFAULT);   // keep it in the main render
   *
   * Either half of that pair is enough — RenderPipeline excludes an object
   * from the AO prepass if its layer mask contains ATMOSPHERE at all, and also
   * disables the layer on the prepass camera. Tagging with ATMOSPHERE alone
   * (no DEFAULT) additionally drops the mesh from raycasts and shadow casting,
   * which is usually what you want for fog but is your call.
   *
   * You do NOT have to tag anything whose material is already `transparent`,
   * uses non-Normal blending or has `depthWrite: false` — those are detected
   * automatically. The layer is the explicit escape hatch for the cases that
   * detection cannot see.
   */
  ATMOSPHERE: 3,
};
