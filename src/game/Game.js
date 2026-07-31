import * as THREE from 'three';
import { GRID, ECONOMY, SIM, QUALITY_PRESETS, ELEMENT_PICK, PRIMAL } from '../core/Config.js';
import { CameraRig } from '../core/CameraRig.js';
import { RenderPipeline } from '../render/RenderPipeline.js';
import { Lighting } from '../world/Lighting.js';
import { Arena } from '../world/Arena.js';
import { Environment } from '../world/Environment.js';
import { Grid } from './Grid.js';
import { Pathfinder } from '../systems/Pathfinder.js';
import { CreepManager, CREEP_TYPES } from './Creeps.js';
import { ProjectileManager } from '../systems/Projectiles.js';
import { TowerManager } from './Towers.js';
import { EffectSystem } from '../fx/EffectSystem.js';
import { WaveRunner, waveDef, isAirWave, TOTAL_WAVES } from './Waves.js';
import { towerDef, availableTowers, morphTargets, FOUNDATION } from './TowerDefs.js';
import { ELEMENT_IDS, ELEMENTS } from './Elements.js';
import { rngFor, pickN } from '../core/Rng.js';
import { HUD } from '../ui/HUD.js';
import { PLACEMENT_TEXT } from '../ui/uikit.js';
import { AudioEngine } from '../audio/AudioEngine.js';

/** Scratch vector for world→screen projection (audio panning). */
const _sound = new THREE.Vector3();

/** Phases in which the simulation does not advance. */
const FROZEN_PHASES = new Set(['lobby', 'gameover', 'victory']);

/**
 * Top-level orchestrator: owns the scene, the fixed-step simulation, the
 * player's economy/state machine, and all pointer interaction.
 */
export class Game {
  /**
   * @param opts.seed  uint32 run seed. In a multiplayer room this is the room
   *        seed from the server, so every player faces the same draws; solo it
   *        is random. See rollElementChoices.
   * @param opts.onRunEnd  called once with { score, wave, won } when the run
   *        ends. The hook exists so main.js can report a result to the server
   *        without Game.js knowing a server exists.
   */
  constructor(canvas, quality = 'ultra', opts = {}) {
    this.canvas = canvas;
    this.seed = (opts.seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
    this.onRunEnd = opts.onRunEnd ?? null;
    this.pipeline = new RenderPipeline(canvas, quality);
    this.q = this.pipeline.q;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0a0c14, 0.0062);
    this.scene.background = new THREE.Color(0x05070c);

    this.rig = new CameraRig(canvas);
    this.camera = this.rig.camera;

    this.lighting = new Lighting(this.scene, this.q);
    this.lighting.buildEnvironment(this.pipeline.renderer);

    this.grid = new Grid();
    this.path = new Pathfinder(this.grid);
    this.environment = new Environment(this.scene, this.q);
    this.arena = new Arena(this.scene, this.grid, this.pipeline.maxAnisotropy);
    this.arena.refreshOccupancy();

    this.creeps = new CreepManager(this.scene, this.grid, this.path);
    this.fx = new EffectSystem(this.scene, this.camera, this.q.particleBudget);
    this.projectiles = new ProjectileManager(this.scene, this.creeps, this.fx);
    this.towers = new TowerManager(this.scene, this.grid, this.creeps, this.projectiles, this.fx, this.q);
    // Ground decals follow the real terrain surface instead of a hardcoded Y.
    // The tower batch has no Arena reference by design, so the height provider
    // is injected here, where both objects are in scope.
    this.towers.surfaceHeightAt = (x, z) => this.arena.surfaceHeightAt(x, z);
    // Same injection for creeps: routes feet, flyer altitude, contact shadows,
    // footfall dust, scorch decals and settled gibs onto the real surface.
    this.creeps.surfaceHeightAt = (x, z) => this.arena.surfaceHeightAt(x, z);
    // Same injection for the VFX layer: ground decals and the sustained pool
    // lights they parent are seated on the real terrace surface, not on y=0.
    this.fx.setHeightProvider((x, z) => this.arena.surfaceHeightAt(x, z));

    this.waves = new WaveRunner(this.creeps, this.fx);
    this.audio = new AudioEngine();

    // Art Bible §7: "splash impacts shake the camera slightly". The effect
    // system deliberately owns no camera reference and the rig owns no effect
    // reference, so the coupling lives here, at the layer that knows both.
    // Decorating rather than editing either file keeps both contracts clean.
    const emitExplosion = this.fx.explosion.bind(this.fx);
    this.fx.explosion = (x, y, z, radius, color) => {
      emitExplosion(x, y, z, radius, color);
      // Scale with blast size but saturate hard — a busy wave must never turn
      // into continuous camera noise.
      this.rig.addShake(Math.min(0.20, 0.045 * radius));
    };

    this.pipeline.build(this.scene, this.camera);
    // Screen-space light shafts radiate from the breach, the one genuine
    // emitter inside the camera frustum — the key light is geometrically
    // never on screen at this pitch. See RenderPipeline.render().
    this.pipeline.godRayAnchor = this.environment.godRayAnchor ?? null;

    // --- player state ---
    this.state = {
      gold: ECONOMY.startGold,
      lives: ECONOMY.startLives,
      wave: 0,
      elements: [],          // owned element ids
      pendingElementPicks: 0,
      // Advances only when a pick is committed — see rollElementChoices.
      pickIndex: 0,
      phase: 'prep',         // prep | combat | pickElement | gameover | victory
      prepTimer: waveDef(1).prepTime,
      speed: 1,
      paused: false,
      score: 0,
      leaked: 0,
      killed: 0,
      // Interest: paid every ECONOMY.interestTick seconds on banked gold, but
      // switched off for the remainder of a wave the moment you leak.
      interestTimer: ECONOMY.interestTick,
      interestActive: true,
      totalInterest: 0,
    };

    this.selectedBuild = null;   // tower key queued for placement
    this.selectedTower = null;   // inspected tower id
    this.hover = { c: -99, r: -99, valid: false };

    this.hud = new HUD(this);
    this.#wireCallbacks();
    this.#wirePointer();

    this.accumulator = 0;
    this.elapsed = 0;
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();

    window.addEventListener('resize', () => this.#onResize());
    this.#onResize();

    // `autoStart: false` builds the whole game but does not begin the run, so the
    // lobby can sit over a live, already-warmed 3D scene instead of over a black
    // screen while terrain generates. The alternative — lobby first, then
    // construct — makes the player wait twice.
    if (opts.autoStart !== false) this.beginRun(this.seed);
    // Otherwise park the state machine. Leaving it in 'prep' would run the prep
    // timer down behind the lobby veil and send wave 1 at a player still typing
    // their name — the simulation does not know the overlay is there.
    else this.state.phase = 'lobby';
  }

  /**
   * Begin the run. Separate from the constructor so the lobby can decide the seed
   * after the scene exists (see `autoStart`).
   *
   * Idempotent: calling it twice must not hand out a second free element pick.
   */
  beginRun(seed = this.seed) {
    if (this._begun) return false;
    this._begun = true;
    this.seed = seed >>> 0;
    // First element pick is free and immediate.
    this.state.pendingElementPicks = 1;
    this.state.phase = 'pickElement';
    this.hud.openElementPicker();
    return true;
  }

  #onResize() {
    this.pipeline.resize();
    this.fx.setViewport(window.innerWidth, window.innerHeight, this.pipeline.renderer.getPixelRatio());
  }

  #wireCallbacks() {
    this.creeps.onLeak = (i, type) => {
      const dmg = CREEP_TYPES[type].boss ? 10 : 1;
      this.state.lives -= dmg;
      this.state.leaked++;
      // Leaking costs you the rest of this wave's interest — usually the more
      // expensive half of the punishment.
      if (this.state.interestActive) {
        this.state.interestActive = false;
        this.hud.warn('Interest lost for this wave');
      }
      this.pipeline.flash(0.7);
      this.rig.addShake(0.4);
      this.audio.play('leak');
      this.hud.pulseLives();
      if (this.state.lives <= 0) this.#gameOver();
    };

    this.creeps.onDeath = (i, x, y, z, bounty, type) => {
      this.state.gold += bounty;
      this.state.killed++;
      this.state.score += Math.round(bounty * 1.5);
      this.fx.death(x, y, z, CREEP_TYPES[type].color);
      this.audio.play(CREEP_TYPES[type].boss ? 'bossDeath' : 'death');
      if (CREEP_TYPES[type].boss) this.rig.addShake(0.5);
      this.hud.floatText(x, y + 1.4, z, `+${bounty}`, '#ffd766');
    };

    this.projectiles.onDamage = (towerId, amount, creepIdx, crit) => {
      const t = this.towers.byId(towerId);
      if (!t) return;
      t.totalDamage += amount;
      // The crit's readout. Projectiles owns the roll but has no HUD reference,
      // and the creep it landed on is addressed by index — this is the one layer
      // that can turn both into a number over a body.
      if (crit && creepIdx >= 0 && this.creeps.alive[creepIdx]) {
        const c = this.creeps;
        this.hud.floatText(c.x[creepIdx], c.y[creepIdx] + 2.0, c.z[creepIdx],
          `${Math.round(amount)}!`, '#ffcf5a');
        this.rig.addShake(0.05);
      }
      // Element-flavoured impact cue. The audio mixer throttles and voice-caps
      // this itself, so firing it on every hit is safe.
      const pan = this.#panFor(creepIdx);
      this.audio.playImpact(t.key, Math.min(1, amount / 260), { pan });
    };

    /**
     * `lifesteal` resolved. Projectiles accumulates the leech over one impact
     * and fires this once, so a 5.4-radius Tectonic splash that kills twenty
     * bodies is one call and one float, not twenty.
     */
    this.projectiles.onLeech = (towerId, lives) => {
      const before = this.state.lives;
      this.state.lives = Math.min(ECONOMY.maxLives, this.state.lives + lives);
      const gained = this.state.lives - before;
      if (gained <= 0) return;        // at the cap: no float text, no toast, no noise
      const t = this.towers.byId(towerId);
      if (t) this.hud.floatText(t.x, 3.2, t.z, `+${gained} ♥`, '#7ad62a');
    };

    this.waves.onWaveStart = (def) => {
      this.audio.play(def.isBoss ? 'bossHorn' : 'waveStart');
      this.hud.announceWave(def);
      if (def.isBoss) this.pipeline.flash(0.4, [0.9, 0.4, 0.15]);
      if (def.isAir) this.pipeline.flash(0.3, [0.35, 0.7, 1.0]);
      // THE ONE-WAVE-EARLY WARNING. Air is on a fixed cadence precisely so this
      // is actionable: it fires as the CURRENT wave leaves the portal, which is
      // the last moment you can still spend a wave's income on coverage before
      // the flyers arrive. Warning at prep time would be a countdown, not notice.
      if (isAirWave(def.n + 1)) {
        this.hud.warn(`Air wave next — wave ${def.n + 1} flies`, 'bad');
        this.audio.play('deny');
      }
    };

    this.waves.onWaveCleared = (def) => {
      this.state.score += def.n * 100;
      // A clean wave restores interest for the next one.
      this.state.interestActive = true;
      this.audio.play('waveClear');

      if (def.n >= TOTAL_WAVES) { this.#victory(); return; }

      if (def.grantsElement) {
        this.state.pendingElementPicks++;
      }
      if (this.state.pendingElementPicks > 0) {
        this.state.phase = 'pickElement';
        this.hud.openElementPicker();
      } else {
        this.#beginPrep(def.n + 1);
      }
    };
  }

  #beginPrep(nextWave) {
    this.state.phase = 'prep';
    this.state.wave = nextWave - 1;
    this.state.prepTimer = waveDef(nextWave).prepTime;
    // The standing banner for the whole build phase, so a player who tabbed away
    // during the toast still sees what is queued up.
    this.hud.setAirAlert(isAirWave(nextWave) ? nextWave : 0);
  }

  chooseElement(id) {
    if (this.state.pendingElementPicks <= 0) return false;
    this.state.elements.push(id);
    this.state.pendingElementPicks--;
    this.state.pickIndex++;
    this.audio.play('elementPick');

    if (this.state.pendingElementPicks > 0) {
      this.hud.openElementPicker();
    } else {
      this.hud.closeElementPicker();
      this.#beginPrep(this.state.wave + 1);
    }
    this.hud.refreshBuildBar();
    return true;
  }

  /**
   * The element picker's three offers, derived from the run seed.
   *
   * SEEDED, not random, because in a multiplayer room every player must be
   * solving the same puzzle — a run where one player is offered Light on pick one
   * and another is offered nothing but Earth is not a contest, it is a coin toss.
   *
   * The seed drives a full priority ordering of all six elements, and the offer
   * is drawn from that order. That gives the guarantee that is actually
   * achievable here: two players who have made the same choices see the same
   * three options, and no player's draw is ever luckier than another's.
   *
   * It does NOT guarantee that two players see the same options regardless of
   * what they own — it cannot, because the pools below are derived from what you
   * hold, so a player who diverged has genuinely diverged. Stating that plainly
   * matters more than pretending to a stronger property: the fairness claim this
   * supports is "the same draw", not "the same offer forever".
   *
   * Keyed on `pickIndex`, which advances only when a choice is actually made, so
   * reopening the picker cannot reroll a decision the player is looking at.
   *
   * THE ECHO SLOT. From ELEMENT_PICK.echoFromPick onward, one of the three cards
   * repeats an element you already hold. This is the only route to the three
   * stacks a Primal tower needs, and it is a real cost: an echo card is a card
   * that is not offering you a new element, and therefore not offering you the
   * fusions that element would unlock. Before this existed a duplicate was only
   * ever offered once you owned all six, i.e. pick index 5 at the earliest, so
   * three copies of one element were unreachable before wave 30 and Primals were
   * unreachable at all.
   *
   * WHY THE ECHO PREFERS YOUR HIGHEST STACK. With the pool sorted by count
   * descending, the FIRST echo you take is the seed's choice among your holdings,
   * but every echo after it is guaranteed to be the same element. So the seed
   * decides which primal you are being offered, and you decide whether to chase
   * it — which is a decision, whereas "roll until the seed repeats itself" is a
   * lottery.
   *
   * DETERMINISM CONTRACT — do not break either half:
   *  1. Exactly ELEMENT_IDS.length rand() calls are consumed, always, through the
   *     single pickN below. Never call rand() inside a branch that depends on
   *     player state, or two clients with different holdings desync every draw
   *     after the first.
   *  2. The result is a pure function of (seed, pickIndex, the MULTISET of owned
   *     elements). It must not depend on the ORDER of state.elements: two players
   *     who took fire-then-water and water-then-fire hold the same thing and must
   *     see the same offer.
   */
  rollElementChoices() {
    const counts = new Map();
    for (const id of this.state.elements) counts.set(id, (counts.get(id) ?? 0) + 1);

    const rand = rngFor(this.seed, 'elements', this.state.pickIndex);
    const order = pickN(rand, ELEMENT_IDS, ELEMENT_IDS.length);   // exactly 6 rand() calls
    const rank = new Map(order.map((id, i) => [id, i]));

    // Pool 1: never held. Pool 2: held, but not yet at a full primal. Pool 3:
    // already at three or more — dead value right now, so last-resort filler only.
    const fresh = order.filter((id) => !counts.has(id));
    const echo = order.filter((id) => {
      const n = counts.get(id) ?? 0;
      return n >= 1 && n < PRIMAL.stacksRequired;
    }).sort((a, b) => (counts.get(b) - counts.get(a)) || (rank.get(a) - rank.get(b)));
    const spare = order.filter((id) => (counts.get(id) ?? 0) >= PRIMAL.stacksRequired);

    const echoSlots = this.state.pickIndex >= ELEMENT_PICK.echoFromPick ? ELEMENT_PICK.echoSlots : 0;
    const out = [];
    const take = (pool, n) => {
      for (const id of pool) {
        if (out.length >= ELEMENT_PICK.slots || n <= 0) break;
        if (out.includes(id)) continue;   // slots must be DISTINCT ids — see Picker.#choose
        out.push(id); n--;
      }
    };

    take(fresh, ELEMENT_PICK.slots - echoSlots);
    take(echo, echoSlots);
    // Top-up, in order of usefulness, so the picker always renders exactly three.
    // With six elements and at most three slots these three passes can never
    // under-fill, which is what lets Picker render the roll verbatim.
    take(fresh, ELEMENT_PICK.slots);
    take(echo, ELEMENT_PICK.slots);
    take(spare, ELEMENT_PICK.slots);

    return out.map((id) => ELEMENTS[id]);
  }

  /** How many of `id` the player holds. */
  elementCount(id) {
    let n = 0;
    for (const e of this.state.elements) if (e === id) n++;
    return n;
  }

  /**
   * Remove PRIMAL.stacksConsumed copies of `id` from state.elements.
   * MUST be called only after every placement check has passed — a refused build
   * that has already eaten two stacks is unrecoverable and invisible.
   */
  #spendStacks(id) {
    for (let k = 0; k < PRIMAL.stacksConsumed; k++) {
      const i = this.state.elements.lastIndexOf(id);
      if (i >= 0) this.state.elements.splice(i, 1);
    }
  }

  #refundStacks(id) {
    for (let k = 0; k < PRIMAL.stacksConsumed; k++) this.state.elements.push(id);
  }

  /**
   * The public status of this run — what a leaderboard needs and nothing more.
   *
   * Deliberately a plain snapshot with no reference to any transport. Game.js
   * knows nothing about WebSockets, rooms or players; main.js is the only place
   * that couples this to the network, so single-player carries no networking
   * code path at all and a change to the wire protocol cannot reach gameplay.
   */
  snapshot() {
    const s = this.state;
    return {
      lives: Math.max(0, s.lives),
      score: s.score,
      wave: Math.max(1, s.wave),
      killed: s.killed,
      leaked: s.leaked,
      towers: this.towers.towers.length,
    };
  }

  startWaveNow() {
    if (this.state.phase !== 'prep') return;
    const next = this.state.wave + 1;
    if (next > TOTAL_WAVES) return;
    // Send-early bonus rewards aggression, like the original.
    const bonus = Math.round(this.state.prepTimer * 2);
    if (bonus > 0) {
      this.state.gold += bonus;
      this.hud.announceBonus(bonus);
    }
    this.state.wave = next;
    this.state.phase = 'combat';
    this.hud.setAirAlert(0);
    this.waves.start(next);
  }

  // ---- build interaction -----------------------------------------------

  #wirePointer() {
    const el = this.canvas;

    el.addEventListener('pointermove', (e) => {
      this._ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
      this._ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
      // Kept in CSS pixels for the DOM placement hint, which has to sit next to
      // the real cursor rather than next to the projected cell centre.
      this._pointer = { x: e.clientX, y: e.clientY };
      this.#updateHover();
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.shiftKey) return;
      this._pointerDownAt = { x: e.clientX, y: e.clientY };
    });

    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || e.shiftKey) return;
      const d = this._pointerDownAt;
      if (!d) return;
      // Ignore drags (camera pan) — only treat as a click if the pointer barely moved.
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) { this._pointerDownAt = null; return; }
      this._pointerDownAt = null;
      this.#onClick();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      switch (e.code) {
        case 'Escape': this.setBuildSelection(null); this.selectTower(null); break;
        case 'Space': e.preventDefault(); this.startWaveNow(); break;
        case 'KeyP': this.state.paused = !this.state.paused; this.hud.refreshTop(); break;
        case 'Digit1': this.setSpeed(1); break;
        case 'Digit2': this.setSpeed(2); break;
        case 'Digit3': this.setSpeed(3); break;
        case 'KeyU': if (this.selectedTower !== null) this.upgradeTower(this.selectedTower); break;
        // Opens the morph sheet; it never commits anything on its own. Routed
        // through the HUD rather than straight into Inspector because Game must
        // not reach into a panel's internals — HUD already owns that delegation
        // (openInspector, refreshBuildBar).
        case 'KeyM': if (this.selectedTower !== null) this.hud.openMorph(this.selectedTower); break;
        case 'KeyX': if (this.selectedTower !== null) this.sellTower(this.selectedTower); break;
        default: break;
      }
    });
  }

  #groundPoint() {
    this._raycaster.setFromCamera(this._ndc, this.camera);
    if (!this._raycaster.ray.intersectPlane(this._plane, this._hit)) return null;
    return this._hit;
  }

  /**
   * Why can't a tower go at (c,r)? One of
   * 'valid' | 'occupied' | 'creep' | 'seal' | 'stacks' | 'poor'.
   *
   * Order matters and is not arbitrary: the reasons are ranked by how
   * fundamental they are, so the player is told about the wall before the price.
   * Being told "not enough gold" about a cell that also happens to be sealed
   * would send them off to earn gold for a placement that will still be refused.
   * A stack shortfall sits above 'poor' for the same reason and one stronger: no
   * amount of gold fixes it, so quoting a price would be a lie.
   */
  placementReason(c, r) {
    if (!this.grid.canPlaceTower(c, r)) return 'occupied';
    // Before the maze test, because a creep standing here is a fact about this
    // instant that the player can wait out — walling one in strands it inside
    // the tower forever and the wave never ends.
    if (this.creeps.blockedByFootprint(c, r)) return 'creep';
    if (this.path.wouldBlock(c, r)) return 'seal';
    const def = towerDef(this.selectedBuild);
    if (def?.kind === 'primal'
        && this.elementCount(def.element) < PRIMAL.stacksRequired) return 'stacks';
    if (def && this.state.gold < def.levels[0].cost) return 'poor';
    return 'valid';
  }

  #updateHover() {
    const p = this.#groundPoint();
    if (!p) return;

    if (this.selectedBuild) {
      const a = this.grid.worldToTowerAnchor(p.x, p.z, {});
      const def = towerDef(this.selectedBuild);
      const reason = this.placementReason(a.c, a.r);
      this.hover = { c: a.c, r: a.r, valid: reason === 'valid', reason };
      this.arena.setHover(a.c, a.r, reason);
      this.arena.setGridVisible(true);

      // Only a sealing placement gets the cut-off ground painted, and only while
      // it is actually hovered — this is a per-pointermove flood fill plus a
      // texture upload, so it must not run for the other three outcomes.
      if (reason === 'seal') {
        this._sealFlags ??= new Uint8Array(this.grid.cols * this.grid.rows);
        this.path.sealPreview(a.c, a.r, this._sealFlags);
        this.arena.setSealPreview(this._sealFlags);
      } else {
        this.arena.setSealPreview(null);
      }
      // THE SECOND CONFIRMATION FOR A PRIMAL, and deliberately not a modal: a
      // modal inside a prep countdown is hostile. A valid primal placement is
      // the one 'valid' outcome that still gets a hint, because the click is
      // about to spend two element stacks and nothing else on the board does
      // that. The card and the tooltip say it too; this says it under the cursor
      // at the instant of the click.
      const commit = reason === 'valid' && def.kind === 'primal'
        ? `Commit ${PRIMAL.stacksConsumed}× ${ELEMENTS[def.element].glyph}`
        : null;
      this.hud.showPlacementHint(commit ? 'commit' : reason, this._pointer, commit);

      const centre = this.grid.towerCentreToWorld(a.c, a.r, {});
      this.arena.setRangeIndicator(centre.x, centre.z, def.levels[0].range, def.color);
    } else if (this.selectedTower === null) {
      this.arena.setGridVisible(false);
      this.arena.setRangeIndicator(0, 0, 0);
      this.arena.setHover(-99, -99, 'none');
      this.arena.setSealPreview(null);
      this.hud.showPlacementHint(null);
    }
  }

  setBuildSelection(key) {
    this.selectedBuild = key;
    if (key) {
      this.selectTower(null);
      this.arena.setGridVisible(true);
      this.audio.play('select');
    } else {
      this.arena.setGridVisible(false);
      this.arena.setRangeIndicator(0, 0, 0);
      this.arena.setHover(-99, -99, 'none');
      this.arena.setSealPreview(null);
      this.hud.showPlacementHint(null);
    }
    this.hud.refreshBuildBar();
  }

  #onClick() {
    const p = this.#groundPoint();
    if (!p) return;

    if (this.selectedBuild) {
      const a = this.grid.worldToTowerAnchor(p.x, p.z, {});
      this.build(this.selectedBuild, a.c, a.r);
      return;
    }

    const id = this.grid.towerAtWorld(p.x, p.z);
    this.selectTower(id >= 0 ? id : null);
  }

  build(key, c, r) {
    const def = towerDef(key);
    if (!def) return false;
    const cost = def.levels[0].cost;
    // Same ranking as placementReason, and the same words the hover ghost used —
    // a click that fails must not explain itself differently from the hover that
    // predicted it.
    if (!this.grid.canPlaceTower(c, r)) { this.hud.warn(PLACEMENT_TEXT.occupied.msg); this.audio.play('deny'); return false; }
    if (this.creeps.blockedByFootprint(c, r)) { this.hud.warn(PLACEMENT_TEXT.creep.msg); this.audio.play('deny'); return false; }
    if (this.path.wouldBlock(c, r)) {
      this.hud.warn(PLACEMENT_TEXT.seal.msg, 'bad');
      this.audio.play('deny');
      this.pipeline.flash(0.22, [0.9, 0.15, 0.12]);
      return false;
    }
    if (this.state.gold < cost) { this.hud.warn(PLACEMENT_TEXT.poor.msg); this.audio.play('deny'); return false; }

    // Last, and only once every structural refusal above has passed: a build
    // that is going to be denied must never have eaten two stacks on the way.
    if (def.kind === 'primal') {
      if (this.elementCount(def.element) < PRIMAL.stacksRequired) {
        this.hud.warn(PLACEMENT_TEXT.stacks.msg, 'bad'); this.audio.play('deny'); return false;
      }
      this.#spendStacks(def.element);
    }

    this.state.gold -= cost;
    const t = this.towers.create(key, 0, c, r);
    this.path.rebuild();
    // Repaint the road THIS frame. PathMask now checksums the grid and would
    // catch this on its own, but that costs a frame of the painted road
    // disagreeing with the route — and the checksum exists precisely because
    // this call site was missing for three rounds. Belt and braces: the mask
    // must never again depend on someone remembering terrain exists.
    this.arena.markPathDirty();
    this.arena.refreshOccupancy();
    this.audio.play('build');
    this.rig.addShake(0.08);
    const centre = this.grid.towerCentreToWorld(c, r, {});
    this.fx.explosion(centre.x, 0.3, centre.z, 1.2, [0.6, 0.55, 0.45]);
    // Mandatory rather than cosmetic for a primal: the card must disappear on
    // the same frame the stacks are spent.
    this.hud.refreshBuildBar();

    // A primal always re-locks itself (3 - 2 = 1), so the piece in hand is now
    // unbuildable and must be dropped rather than left queued on the cursor.
    if (def.kind === 'primal' || !this.#canAfford(key)) this.setBuildSelection(null);
    return !!t;
  }

  #canAfford(key) {
    const d = towerDef(key);
    return d && this.state.gold >= d.levels[0].cost;
  }

  /**
   * Gold to arm a foundation with `key` — the difference, discounted, never
   * below zero.
   *
   * The foundation's own cost is credited in full (see FOUNDATION in
   * TowerDefs.js), and ECONOMY.armDiscount then takes a further cut of what is
   * left, so block-then-arm is cheaper than building the element tower outright
   * rather than merely break-even.
   */
  convertCost(key) {
    const def = towerDef(key);
    if (!def) return 0;
    const diff = def.levels[0].cost - FOUNDATION.levels[0].cost;
    return Math.max(0, Math.round(diff * (1 - ECONOMY.armDiscount)));
  }

  /**
   * Arm a foundation: replace it in place with an element tower, crediting the
   * foundation's full cost. See FOUNDATION in TowerDefs.js for why the credit is
   * total rather than partial.
   */
  convertTower(id, key) {
    const t = this.towers.byId(id);
    if (!t || t.def.kind !== 'inert') return false;
    const def = towerDef(key);
    if (!def || def.kind === 'inert') return false;
    // You may only arm a foundation with a tower you could have built outright,
    // so this cannot become a back door around the element picker.
    if (!this.availableTowers.some((d) => d.key === def.key)) {
      this.hud.warn('Element not bound'); this.audio.play('deny'); return false;
    }
    const cost = this.convertCost(key);
    if (this.state.gold < cost) { this.hud.warn('Not enough gold'); this.audio.play('deny'); return false; }

    // Arming a foundation into a primal is allowed and needs no new economics:
    // (900 - 20) * 0.75 = 660, so the route costs 20 + 660 = 680 and selling
    // refunds 0.75 * 900 = 675. The 5-gold loss is the identical constant every
    // tower already pays on this route (paid = 0.75C + 5, refund = 0.75C).
    if (def.kind === 'primal') {
      if (this.elementCount(def.element) < PRIMAL.stacksRequired) {
        this.hud.warn(PLACEMENT_TEXT.stacks.msg, 'bad'); this.audio.play('deny'); return false;
      }
      this.#spendStacks(def.element);
    }

    const { c, r } = t;
    this.state.gold -= cost;
    this.towers.remove(id);
    const nt = this.towers.create(key, 0, c, r);

    // No path rebuild and no remask, deliberately. The new tower occupies the
    // same 2x2 anchor, so those four cells go TOWER -> FREE -> TOWER inside this
    // call with nothing observing the intermediate state: the maze the creeps
    // walk is bit-for-bit identical, so the flow field and the road mask cannot
    // differ. This is the one placement path where skipping them is a fact
    // rather than a bet.
    this.audio.play('upgrade');
    this.fx.explosion(nt.x, 1.6, nt.z, 1.7, [1, 0.9, 0.55]);
    this.rig.addShake(0.10);
    this.selectTower(nt.id);
    this.hud.refreshBuildBar();
    return true;
  }

  /**
   * Gold to morph tower `t` into `key`.
   *
   *   cost = max(0, round( (Ctgt(kept) - Csrc(level) * morphCredit)
   *                        * (1 - morphDiscount[level]) * (1 + morphTax * morphCount) ))
   *
   *   Csrc(level)  everything the player has actually put into this tower,
   *                including any level the target cannot hold.
   *   Ctgt(kept)   what the target would have cost to raise to the kept level.
   *   morphCredit  0.75, the same rate as sellRefund. That is the coherence
   *                anchor: morphing can never be worse than sell-then-rebuild,
   *                because it credits the source at exactly the price a sale
   *                would have paid and then discounts on top of it.
   *   discount     keyed on the SOURCE level, NOT on `kept`: a heavily invested
   *                tower has to be cheaper to repurpose, and a pure L3 -> dual
   *                keeps only level 2, so keying on `kept` would silently deny
   *                that tower the tier-3 rate it had already paid for.
   *
   * THE FLOOR IS AT ZERO AND THERE IS NO REFUND PATH. A morph that paid out
   * would be a gold pump — build cheap, morph down, repeat. Free down-morphs are
   * already strictly worse than selling (a Howitzer L2 -> Nature costs 0 and
   * forfeits the 1 162 a sale would have refunded), so the floor needs no second
   * guard; the Inspector's job is to make that forfeit visible, not to hide it.
   *
   * Pure and side-effect free: the Inspector renders this number before the
   * click and morphTower charges this same call, so the two can never disagree.
   */
  morphCost(t, key) {
    const tgt = towerDef(key);
    if (!tgt || !tgt.levels) return Infinity;
    const kept = Math.min(t.level, tgt.levels.length - 1);
    let paid = 0; for (let l = 0; l <= t.level; l++) paid += t.def.levels[l].cost;
    let want = 0; for (let l = 0; l <= kept; l++) want += tgt.levels[l].cost;
    const disc = ECONOMY.morphDiscount[Math.min(t.level, ECONOMY.morphDiscount.length - 1)];
    const tax = 1 + ECONOMY.morphTax * Math.min(t.morphCount ?? 0, ECONOMY.morphTaxCap);
    return Math.max(0, Math.round((want - paid * ECONOMY.morphCredit) * (1 - disc) * tax));
  }

  /**
   * Re-key a tower in place, keeping as much of its level as the target can hold.
   *
   * PREP ONLY, AND TAXED PER TILE — one rule with two clauses, because either
   * half alone is broken. Prep-only does not stop the boss flip-flop (there is a
   * prep phase before wave 30 AND before wave 31), and a tax alone would allow a
   * mid-boss emergency re-spec, which is the single most wave-trivialising move
   * available. Together they price the flip-flop at 775 gold, half a fusion.
   */
  morphTower(id, key) {
    const t = this.towers.byId(id);
    if (!t) return false;
    if (this.state.phase !== 'prep') { this.hud.warn('Morph only between waves'); this.audio.play('deny'); return false; }
    // A foundation has convertTower, which is cheaper and purpose-built. A
    // primal cannot morph OUT at all: the two stacks it ate would have to be
    // either destroyed (theft) or returned (raise a primal, morph it into a
    // cheap fusion, keep both the stacks and the fusion). Sell already does the
    // right thing and hands them back.
    if (t.def.kind === 'inert' || t.def.kind === 'primal') {
      this.hud.warn('This tower cannot morph'); this.audio.play('deny'); return false;
    }
    const tgt = towerDef(key);
    if (!tgt || tgt.key === t.key || tgt.kind === 'inert' || tgt.kind === 'primal') return false;
    if (!this.morphTargets.some((d) => d.key === tgt.key)) {
      this.hud.warn('Element not bound'); this.audio.play('deny'); return false;
    }
    const cost = this.morphCost(t, key);
    if (this.state.gold < cost) { this.hud.warn('Not enough gold'); this.audio.play('deny'); return false; }

    // Snapshot everything that belongs to the TILE rather than to the tower def,
    // because towers.create() hands back a brand-new object with a new id.
    // Losing `mode` silently resets targeting to 'first', a behaviour change the
    // player did not ask for; losing totalDamage/kills zeroes the Contribution
    // panel and skews the board-share percentage for every other tower.
    const { c, r } = t;
    const kept = Math.min(t.level, tgt.levels.length - 1);
    const carry = { mode: t.mode, totalDamage: t.totalDamage, kills: t.kills, morphCount: (t.morphCount ?? 0) + 1 };

    this.state.gold -= cost;
    this.towers.remove(id);
    const nt = this.towers.create(key, kept, c, r);
    Object.assign(nt, carry);

    // NO path.rebuild(), NO arena.markPathDirty(), NO arena.refreshOccupancy().
    // Same 2x2 anchor: grid.clearTower() and grid.setTower() both run inside this
    // call with nothing observing the gap, so those four cells go TOWER -> FREE
    // -> TOWER and the maze the creeps walk is bit-for-bit identical. It is also
    // exactly four cells in both directions, because canPlaceTower only ever
    // accepts CELL.FREE, so clearTower cannot be restoring a PATH_ONLY cell as
    // FREE. Same argument convertTower already makes, and it is a fact here too
    // rather than a bet. (arena.refreshOccupancy only reads grid.cells, which is
    // unchanged; PathMask additionally checksums the grid on its own.)
    this.audio.play('upgrade');
    this.fx.explosion(nt.x, 2.0, nt.z, 2.1, [0.95, 0.85, 0.6]);
    this.rig.addShake(0.12);
    // MANDATORY. Inspector.tower holds a reference to the OLD object: without
    // this the panel keeps rendering a dead tower and its Sell/Upgrade buttons
    // fire against an id byId() resolves to null, i.e. a button that does
    // nothing and explains nothing. It also re-seats the range indicator, which
    // changes on almost every morph.
    this.selectTower(nt.id);
    this.hud.refreshBuildBar();
    return true;
  }

  selectTower(id) {
    this.selectedTower = id;
    if (id === null) {
      this.hud.closeInspector();
      if (!this.selectedBuild) {
        this.arena.setRangeIndicator(0, 0, 0);
        this.arena.setGridVisible(false);
      }
      return;
    }
    const t = this.towers.byId(id);
    if (!t) return;
    const s = this.towers.stats(t);
    this.arena.setRangeIndicator(t.x, t.z, s.range, t.def.color);
    this.arena.setGridVisible(true);
    this.hud.openInspector(t);
    this.audio.play('select');
  }

  upgradeTower(id) {
    const t = this.towers.byId(id);
    if (!t) return;
    if (t.level >= t.def.levels.length - 1) { this.hud.warn('Max level'); return; }
    const cost = t.def.levels[t.level + 1].cost;
    if (this.state.gold < cost) { this.hud.warn('Not enough gold'); this.audio.play('deny'); return; }
    this.state.gold -= cost;
    this.towers.upgrade(id);
    this.audio.play('upgrade');
    this.fx.explosion(t.x, 2.2, t.z, 1.0, [1, 0.9, 0.5]);
    const s = this.towers.stats(t);
    this.arena.setRangeIndicator(t.x, t.z, s.range, t.def.color);
    this.hud.openInspector(t);
  }

  sellTower(id) {
    const t = this.towers.byId(id);
    if (!t) return;
    let spent = 0;
    for (let l = 0; l <= t.level; l++) spent += t.def.levels[l].cost;
    const refund = Math.floor(spent * ECONOMY.sellRefund);
    this.state.gold += refund;
    this.fx.explosion(t.x, 1.2, t.z, 1.4, [0.9, 0.8, 0.6]);
    // Returning the stacks is not generosity. Without it, a player who raises a
    // primal and later needs the tile back is permanently two stacks poorer,
    // which can strand them below a fusion they had already earned.
    if (t.def.kind === 'primal') {
      this.#refundStacks(t.def.element);
      this.hud.warn(`+${PRIMAL.stacksConsumed} ${ELEMENTS[t.def.element].name} stacks returned`, 'good');
    }
    this.towers.remove(id);
    this.path.rebuild();
    this.arena.markPathDirty();   // see buildTower — repaint the road this frame
    this.arena.refreshOccupancy();
    this.selectTower(null);
    this.audio.play('sell');
    this.hud.floatText(t.x, 2.5, t.z, `+${refund}`, '#ffd766');
    // Missing until primals existed. A refunded primal's card has to reappear on
    // the dock in the same frame the stacks come back, not on the next hover.
    this.hud.refreshBuildBar();
  }

  setSpeed(v) { this.state.speed = v; this.hud.refreshTop(); }

  #gameOver() {
    this.state.phase = 'gameover';
    this.hud.showEnd(false);
    this.audio.play('gameover');
    this.#reportEnd(false);
  }

  #victory() {
    this.state.phase = 'victory';
    this.hud.showEnd(true);
    this.audio.play('victory');
    this.#reportEnd(true);
  }

  /** Fire onRunEnd exactly once, however the run ended. */
  #reportEnd(won) {
    if (this._ended) return;
    this._ended = true;
    this.onRunEnd?.({ score: this.state.score, wave: Math.max(1, this.state.wave), won });
  }

  // ---- main loop --------------------------------------------------------

  frame(rawDt) {
    const dt = Math.min(rawDt, 0.1);
    this.elapsed += dt;

    // 'lobby' is in this list for the same reason as the end states: the world
    // still renders and the camera still drifts, but nothing simulates.
    if (!this.state.paused && !FROZEN_PHASES.has(this.state.phase)) {
      const steps = this.state.speed;
      this.accumulator += dt * steps;
      let n = 0;
      while (this.accumulator >= SIM.dt && n < SIM.maxSubSteps * steps) {
        this.#step(SIM.dt);
        this.accumulator -= SIM.dt;
        n++;
      }
      if (this.accumulator > SIM.dt * 4) this.accumulator = 0;
    }

    this.rig.update(dt);
    this.arena.update(dt, this.elapsed);
    this.environment.update(dt, this.elapsed, this.camera);
    this.lighting.update(dt);
    this.fx.update(dt);
    this.hud.update(dt);
    this.pipeline.render(this.elapsed, dt);
  }

  #step(dt) {
    this.#tickInterest(dt);

    if (this.state.phase === 'prep') {
      this.state.prepTimer -= dt;
      if (this.state.prepTimer <= 0) this.startWaveNow();
    }

    this.creeps.update(dt);
    this.towers.update(dt, this.elapsed);
    this.projectiles.update(dt);
    this.waves.update(dt);
  }

  /**
   * Stereo pan for a world event, derived from where it sits in the frame.
   * The audio engine exposes a `pan` argument but cannot compute it — the
   * camera lives here, so this is the missing half.
   */
  #panFor(creepIdx) {
    if (creepIdx === undefined || creepIdx < 0) return 0;
    const c = this.creeps;
    if (!c.alive[creepIdx]) return 0;
    _sound.set(c.x[creepIdx], c.y[creepIdx], c.z[creepIdx]).project(this.camera);
    // Behind the camera projects to a mirrored x — ignore those rather than
    // panning a sound to the wrong ear.
    if (_sound.z > 1) return 0;
    return THREE.MathUtils.clamp(_sound.x, -1, 1) * 0.7;
  }

  /** Compounding interest on unspent gold, paid on a fixed clock. */
  #tickInterest(dt) {
    const s = this.state;
    s.interestTimer -= dt;
    if (s.interestTimer > 0) return;
    s.interestTimer += ECONOMY.interestTick;

    if (!s.interestActive) return;
    const base = Math.min(s.gold, ECONOMY.interestCap);
    const payout = Math.floor(base * ECONOMY.interestRate);
    if (payout <= 0) return;

    s.gold += payout;
    s.totalInterest += payout;
    this.hud.announceInterest(payout);
  }

  /** Seconds until the next interest payout — for the HUD's banking readout. */
  get interestCountdown() { return Math.max(0, this.state.interestTimer); }

  get nextInterestPayout() {
    if (!this.state.interestActive) return 0;
    return Math.floor(Math.min(this.state.gold, ECONOMY.interestCap) * ECONOMY.interestRate);
  }

  get availableTowers() { return availableTowers(this.state.elements); }

  /** Every tower a morph may land on — see morphTargets in TowerDefs.js. */
  get morphTargets() { return morphTargets(this.state.elements); }

  /**
   * The selected tower, if it is an unarmed foundation — otherwise null.
   *
   * This is what turns the build dock into an arming palette (see BuildBar): the
   * inspector's "Arm with" list is on the far right of the screen, while the
   * player's hand and attention are already on the dock at the bottom. Same
   * decision, reachable from where they are looking.
   */
  get heldFoundation() {
    if (this.selectedTower === null) return null;
    const t = this.towers.byId(this.selectedTower);
    return t && t.def.kind === 'inert' ? t : null;
  }
}
