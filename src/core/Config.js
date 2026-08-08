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

  /**
   * Morph. The source tower is credited into the target at `morphCredit` — the
   * same 0.75 as sellRefund, deliberately, so morphing is never worse than
   * sell-then-rebuild — and the remainder is then discounted by an amount that
   * grows with the SOURCE tower's level. Investing in a tower must make
   * re-purposing it cheaper, not dearer.
   */
  morphCredit: 0.75,
  /** Indexed by the SOURCE tower's level index: 10% / 20% / 30%. */
  morphDiscount: [0.10, 0.20, 0.30],
  /**
   * Per-tile morph tax. Each morph of the same tile multiplies the next one by
   * (1 + morphTax * morphCount). This exists for exactly one exploit: morph into
   * the boss counter, morph back after. Prep-phase gating alone does not stop it
   * (there is a prep before every wave); a flat tax alone lets a player buy the
   * perfect tower every wave. Both together price the flip-flop honestly.
   */
  morphTax: 0.5,
  morphTaxCap: 4,      // tax saturates at 3.0x
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
 * THE RITES — the between-wave minigames. See docs/MINIGAMES.md.
 *
 * WHY THE CADENCE IS "PERIOD 5, OFFSET 3" AND NOT A ROUNDER NUMBER.
 *
 * Element picks land on `n % 5 === 0` (ECONOMY.elementEveryWaves). Any rite
 * period that is not itself a multiple of 5 eventually lands on a multiple of 5
 * — period 6 collides at wave 30, period 7 at wave 35 — and a collision means
 * the player answers the element picker and is immediately handed a second
 * modal. Stacking two full-bleed surfaces back to back is the one shape this
 * feature must never produce, and arithmetic is a better guarantee than a
 * runtime check. Period 5 with a non-zero offset provably never collides.
 *
 * Offset 3 puts the rite two waves after each pick and three before the next,
 * so the run reads as an alternation: a DECISION every five waves (which
 * element), a TEST every five waves (the rite), never on the same breath. It
 * yields 11 rites over 55 waves, exactly matching the 11 element picks.
 *
 * WHY IT IS SKIPPABLE AND WHY THAT IS NOT A CONTRADICTION. A mandatory
 * interruption every five waves is a toll booth by its eighth occurrence. Escape
 * (twice) or the "Skip" button leaves immediately and forfeits the gold; the
 * rite therefore costs a player who does not want it about one second, and pays
 * a player who does. That asymmetry is the whole design.
 *
 * REWARD SHAPE — ONE CONTINUOUS CURVE, AND WHY IT REPLACED TWO CONSTANTS.
 *
 *   perfect = max(minPerfect, nextWaveGross * perfectFrac)
 *   reward  = round(perfect * ratio ** payCurve)
 *
 * `perfect` is the payout for a flawless run: floored so it is not beneath
 * notice on wave 3 (a tier-1 tower costs 60), and otherwise a fixed fraction of
 * the gross bounty of the wave about to be prepared, so it stays proportionate
 * for the whole run instead of being decisive at wave 3 and invisible at 48.
 *
 * The shape before this was `floorFrac + (1 - floorFrac) * ratio`, gated by a
 * `payThreshold` below which it paid nothing. Both are gone, and the reason is
 * the cliff they built between them: at wave 53 a ratio of 0.119 paid 0 and
 * 0.121 paid 262 gold. Nothing on screen marks that edge — the player never sees
 * `ratio` — so the difference between "nothing happened" and "a fifth of a wave"
 * was two thousandths of an invisible number. And the threshold had to be
 * RE-MEASURED against every new rite's do-nothing score to stay correct, which
 * is a constant that silently rots.
 *
 * `payCurve` at 1.25 does the same job without an edge anywhere. It is convex,
 * so the bottom of the range is worth very little (a ratio of 0.02 pays 2% of
 * perfect, not 21%) while the top is untouched. Measured over a full 55-wave run
 * — 62 210 gold of bounty income, 11 rites, seed 1234 — playing every rite at a
 * constant ratio is worth:
 *
 *   ratio | rite gold | share of run income
 *   ------+-----------+--------------------
 *    1.00 |     3 224 |  5.2%
 *    0.75 |     2 251 |  3.6%   <- a competent player
 *    0.30 |       717 |  1.2%
 *    0.10 |       180 |  0.3%
 *    0.02 |        24 |  0.04%  <- an idle player, over an entire run
 *
 * A competent player lands within ~1.4% of the old curve's total, so nothing
 * about the economy moves. An idle one earns 24 gold across a whole game, less
 * than one tick of interest.
 *
 * THE PROPERTY THAT MATTERS: skipping pays 0 (MinigameHost.#settle returns
 * before the formula) and a ratio of 0 pays 0. Those two used to agree only
 * because a tuned constant sat above every measured idle score. They now agree
 * BY CONSTRUCTION — 0 ** anything positive is 0 — for any rite anyone writes,
 * without anyone having to remember to re-measure. There is no strategy in
 * choosing between Escape and looking away, because they are worth the same.
 */
export const MINIGAMES = {
  everyWaves: 5,         // period — MUST stay a multiple of ECONOMY.elementEveryWaves
  waveOffset: 3,         // ...and this MUST stay non-zero modulo that period
  firstWave: 3,
  perfectFrac: 0.24,     // of the NEXT wave's gross bounty (count x bounty)
  minPerfect: 40,
  payCurve: 1.25,        // exponent on ratio. >1 makes the bottom cheap without a gate.
  /**
   * Clicks the host will queue for a single fixed step before it starts
   * dropping them. Twelve inside one 16.6 ms slice is a macro or a stuck
   * button, not a hand; an unbounded queue is an unbounded frame, and the pool
   * behind it (MinigameHost._clickPool) is sized from exactly this number.
   */
  maxClicksPerStep: 12,
  /** Fixed-step rate of every minigame's logic. Independent of SIM.hz on purpose. */
  hz: 60,
  get dt() { return 1 / this.hz; },
  /** Real seconds the host will let a single frame advance. Mirrors Game.frame. */
  maxFrameDt: 0.1,
  /** Devicepixel ratio ceiling for the overlay canvas — a 3x retina fill is free real estate nobody sees. */
  maxDpr: 2,
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

  /**
   * `potato` — the preset for a machine that cannot run `low`.
   *
   * It exists because `low` was the floor, and `low` is not a floor: measured
   * on the reference M1 it renders the loaded scenario at 40 ms (25 fps) with
   * the adaptive controller already pinned against its clamp. A machine weaker
   * than an M1 — which is most laptops with integrated graphics — had nothing
   * left to fall back to, and no way to ask for it (see `?q=` in main.js: until
   * the settings panel there was no in-game control at all).
   *
   * The one knob here that is not a smaller number is `post: false`. Every other
   * preset runs the EffectComposer, and PERF_BUDGET's attribution table records
   * that disabling every pass saves far more (90 ms) than the passes sum to
   * (~46 ms), because an empty chain lets the composer skip intermediate
   * render-target ping-pong altogether. `post: false` is that: no composer, no
   * intermediate targets, the scene rendered straight to the canvas.
   *
   * What it costs, and it is not nothing: no bloom, and no grade pass — so the
   * lift/gamma/gain, saturation, vignette and the gameplay flash are gone. Tone
   * mapping and the sRGB conversion survive, because those are the renderer's
   * own and apply to a direct render too, so the image is flatter and cooler
   * rather than broken. That is the deal this preset offers: the game looks
   * plainer and it runs.
   */
  potato: {
    shadowMapSize: 512, csmCascades: 1,
    ssao: false, ssaoQuality: 'none', ssaoSamples: 0, ssaoRadius: 1.3, ssaoIntensity: 0,
    msaa: 0,
    bloom: false, bloomStrength: 0, bloomRadius: 0, bloomThreshold: 99,
    dof: false, dofStrength: 0,
    godrays: false,
    grain: 0.0, aberration: 0.0,
    ssr: false, taa: false, motionBlur: false,
    towerLights: 0,
    particleBudget: 1200, decals: false, anisotropy: 1, pixelRatioCap: 1,
    // Read only by RenderPipeline. Absent on every other preset, and absent
    // means true — the composer is the default path.
    post: false,
    // The key light's shadow is the single most expensive thing left once the
    // post chain is gone, and a hard-edged 512 map looks worse than none.
    shadows: false,
    // Backdrop, ground fog and motes off; sky and breach kept, because they are
    // the horizon and the frame would read as a void without them.
    envDetail: false,
    // Key + hemisphere only. Each additional light is charged to every lit pixel
    // in the scene rather than to the object it appears to light.
    extraLights: false,
  },
};

/**
 * Presets ordered cheapest-first. The settings panel renders in this order and
 * the governor steps along it, so neither has to hold its own copy of the
 * ordering — adding a preset to QUALITY_PRESETS and to this array is enough.
 */
export const QUALITY_ORDER = ['potato', 'low', 'medium', 'high', 'ultra'];

/** Human labels for the settings panel. */
export const QUALITY_LABELS = {
  potato: 'Minimum',
  low: 'Bas',
  medium: 'Moyen',
  high: 'Élevé',
  ultra: 'Ultra',
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
