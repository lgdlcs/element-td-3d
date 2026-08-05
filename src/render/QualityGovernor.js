/**
 * What happens after AdaptiveResolution runs out of pixels to give.
 *
 * THE GAP THIS FILLS
 *
 * `AdaptiveResolution` holds 60 fps by trading resolution, and it is right to
 * be the first line: cost on this renderer is linear in pixel area, so pixels
 * map almost exactly onto milliseconds. But it is deliberately clamped, and its
 * own docblock says why — a controller that will do anything to hit its target
 * renders the game at 160x90 rather than admit it cannot cope.
 *
 * The consequence went unhandled. Once the controller reaches `minScale` it has
 * nothing left to do, so it does nothing, every frame, forever. On the machines
 * this was reported from that is the whole experience: the game pins at the
 * clamp within two seconds of loading and then sits at 15 fps for the rest of
 * the session, with no mechanism that will ever improve it and — before the
 * settings panel — no control the player could reach either.
 *
 * So this takes over where resolution stops. It steps down a ladder of things
 * that can be changed on a LIVE scene, cheapest-looking first, and it steps back
 * up when the frame proves it can afford them again.
 *
 * WHY A LADDER OF LIVE KNOBS AND NOT A PRESET SWITCH
 *
 * A preset is baked at construction: Lighting, Environment, Arena, EffectSystem
 * and TowerManager all read `quality` in their constructors, so changing the
 * preset properly means rebuilding the world, which means losing the run or
 * reloading the page. Mid-run, that is not a fix, it is a second failure. Every
 * rung below is something that can be toggled on the scene that already exists.
 *
 * WHY IT ANNOUNCES ITSELF
 *
 * Quality that changes silently reads as the game glitching. Each step reports
 * through `onChange`, and the settings panel shows what the governor has taken
 * away and offers to stop it — because a player who would rather have the
 * pretty version at 30 fps is making a legitimate choice, and the governor has
 * no way to know that on their behalf.
 *
 * HONEST LIMITS
 *
 * The ladder ORDER is a judgement about how much each rung costs to look at,
 * informed by docs/PERF_BUDGET.md. The per-rung milliseconds are NOT measured
 * on this branch and are not claimed here: an attempt to measure them at `low`
 * on the development machine produced 23 ms of drift between two readings of
 * the same cell and a resolution sweep that ran backwards, which is to say it
 * measured the machine's other occupants and not this game (see
 * tools/scratch/potato3.mjs). What IS relied on is only the direction — every
 * rung removes work and none adds any — and the closed loop: the governor keeps
 * stepping while the frame is over budget and stops when it is not, so a rung
 * that turns out to be worth nothing costs one step, not a wrong permanent
 * state.
 */

/** Over this, for `PATIENCE` consecutive windows, and the governor steps down. */
const DEMOTE_MS = 22;      // ~45 fps. Below the 16.6 target, above "fine".
/** Under this, for `RECOVER` consecutive windows, and it gives a rung back. */
const PROMOTE_MS = 13.0;   // comfortably inside 60 fps, with room for the rung.
const WINDOW = 45;         // frames per decision (~0.75s at 60fps, ~1.5s at 30)
const PATIENCE = 3;        // sustained slowness, not one bad wave
const RECOVER = 8;         // climb back reluctantly: a rung restored and then
                           // removed again is the flicker we are avoiding.

/**
 * The ladder, cheapest-looking loss first. Each rung is {apply, revert}, both
 * idempotent, both safe on a live scene mid-frame.
 */
function buildRungs(ctx) {
  const { pipeline, environment, lighting, fx } = ctx;
  const rungs = [];

  // 1. Depth of field. A defocus on a top-down strategy board is the most
  //    decorative thing in the chain and the least missed.
  if (pipeline.passes?.dof) {
    rungs.push({
      name: 'profondeur de champ',
      apply: () => { pipeline.passes.dof.enabled = false; },
      revert: () => { pipeline.passes.dof.enabled = true; },
    });
  }

  // 2. Ambient occlusion. PERF_BUDGET measured the GTAO lever at ~3 ms once
  //    MSAA was correctly attributed away from it, so this is a small rung —
  //    but it is also a small visual loss, which is what the ordering is for.
  if (pipeline.passes?.gtao) {
    rungs.push({
      name: 'occlusion ambiante',
      apply: () => { pipeline.passes.gtao.enabled = false; },
      revert: () => { pipeline.passes.gtao.enabled = true; },
    });
  }

  // 3. Decor: backdrop, ground fog, motes. Sky and breach are deliberately not
  //    here — see Environment, they are the horizon.
  const decor = [
    environment?.backdrop?.group,
    environment?.groundFog?.mesh,
    environment?.motes?.points,
  ].filter(Boolean);
  if (decor.length) {
    rungs.push({
      name: 'décor de fond',
      apply: () => { for (const o of decor) o.visible = false; },
      revert: () => { for (const o of decor) o.visible = true; },
    });
  }

  // 4. Secondary lights. Each is one more iteration of the per-fragment
  //    lighting loop over every lit pixel in the frame; the fx light pool cost
  //    23.6 ms of an 82.1 ms frame for exactly this reason (PERF_BUDGET round
  //    10). Key and hemisphere stay: without them nothing has a lit side.
  const extras = [lighting?.fill, lighting?.rim, lighting?.ember].filter(Boolean);
  if (extras.length) {
    rungs.push({
      name: 'lumières d\'appoint',
      apply: () => { for (const l of extras) l.visible = false; },
      revert: () => { for (const l of extras) l.visible = true; },
    });
  }

  // 5. The fx light pool. Same mechanism, applied to the muzzle flashes and
  //    ember glows. `visible`, never `intensity`: three.js compiles a light in
  //    on `visible` alone and charges it whether or not it contributes.
  const pool = fx?.lights;
  if (pool) {
    rungs.push({
      name: 'lueurs de tir',
      // `suspended` only — the pool's own #syncVisibility owns `visible` and
      // tracks its state in `_lit`. Setting the lights here as well would leave
      // that flag disagreeing with the scene, and the next effect would find the
      // pool already "lit" and never turn it back on.
      apply: () => { pool.suspended = true; },
      revert: () => { pool.suspended = false; },
    });
  }

  // 6. Shadows. ~5 ms by PERF_BUDGET's own correction of its earlier 20.9 claim,
  //    and a large, obvious change to the image — hence this far down.
  if (lighting?.key) {
    rungs.push({
      name: 'ombres',
      apply: () => { lighting.key.castShadow = false; pipeline.renderer.shadowMap.enabled = false; },
      revert: () => { lighting.key.castShadow = true; pipeline.renderer.shadowMap.enabled = true; },
    });
  }

  // 7. The whole post chain, by BYPASSING the composer rather than emptying it.
  //    An emptied composer still allocates and still blits through both
  //    ping-pong targets; PERF_BUDGET records the difference between the sum of
  //    the passes (~46 ms) and turning them all off (90 ms) as exactly that
  //    target traffic. Last rung because it takes the grade with it, and the
  //    grade is most of what the game looks like.
  rungs.push({
    name: 'effets d\'image',
    apply: () => { pipeline.bypassComposer(true); },
    revert: () => { pipeline.bypassComposer(false); },
  });

  return rungs;
}

export class QualityGovernor {
  /**
   * @param ctx.pipeline    RenderPipeline (for passes, renderer, adaptive)
   * @param ctx.environment Environment, or null
   * @param ctx.lighting    Lighting, or null
   * @param ctx.fx          EffectSystem, or null
   * @param ctx.onChange    (state) => void, called after every step
   */
  constructor(ctx) {
    this.pipeline = ctx.pipeline;
    this.onChange = ctx.onChange ?? null;
    this.rungs = buildRungs(ctx);
    /** How many rungs are currently applied. */
    this.step = 0;
    /** Player opt-out. The panel sets this; nothing else does. */
    this.enabled = true;

    this._samples = [];
    this._slow = 0;
    this._fast = 0;
  }

  /** Names of the rungs currently applied, cheapest first. For the UI. */
  get removed() { return this.rungs.slice(0, this.step).map((r) => r.name); }

  get exhausted() { return this.step >= this.rungs.length; }

  /** Undo every rung and stand down. The panel calls this for "keep it pretty". */
  reset() {
    while (this.step > 0) this.rungs[--this.step].revert();
    this._slow = this._fast = 0;
    this._samples.length = 0;
    this.onChange?.(this);
  }

  /** @param {number} dt seconds since the previous PRESENTED frame */
  update(dt) {
    if (!this.enabled) return;

    const ms = dt * 1000;
    // A backgrounded tab produces one enormous dt, and a governor that reads it
    // as evidence would strip the game bare while nobody is looking.
    if (ms > 500) { this._samples.length = 0; return; }
    this._samples.push(ms);
    if (this._samples.length < WINDOW) return;

    // Median, not mean: one GC pause or one shader compile must not cost the
    // player a rung. Same reasoning as AdaptiveResolution.
    const sorted = this._samples.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this._samples.length = 0;

    // RESOLUTION FIRST, ALWAYS.
    //
    // While the adaptive controller still has pixels to give, it is the better
    // instrument — it degrades one axis smoothly instead of deleting a feature —
    // so the governor stays out of the way until that is exhausted. Without this
    // gate the two controllers chase the same milliseconds and the frame gets
    // both softer AND plainer for a slowdown either one could have absorbed.
    const adaptive = this.pipeline.adaptive;
    const resolutionSpent = !adaptive || !adaptive.enabled || adaptive.scale <= adaptive.minScale + 1e-6;

    if (median > DEMOTE_MS && resolutionSpent) {
      this._fast = 0;
      if (++this._slow >= PATIENCE && !this.exhausted) {
        this._slow = 0;
        this.rungs[this.step++].apply();
        this.onChange?.(this);
      }
      return;
    }

    if (median < PROMOTE_MS && this.step > 0) {
      this._slow = 0;
      if (++this._fast >= RECOVER) {
        this._fast = 0;
        this.rungs[--this.step].revert();
        this.onChange?.(this);
      }
      return;
    }

    this._slow = 0;
    this._fast = 0;
  }
}
