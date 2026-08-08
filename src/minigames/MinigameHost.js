/**
 * THE RITE HOST — the overlay every minigame is played inside.
 *
 * It owns the veil, the keyboard shield, the one 2D canvas, the fixed-step loop,
 * the clock, the skip affordance, the result card and the single gold credit.
 * A rite owns none of those and cannot reach any of them; see docs/MINIGAMES.md.
 *
 * WHY 2D CANVAS AND NOT THREE. docs/PERF_BUDGET.md: the frame is fragment-bound
 * at 16.6 ms median and the CPU sits at 0.20 ms. A full-bleed transparent
 * surface, an extra light or an extra pass is spent out of the budget that is
 * already tight; a 2D canvas over a CSS-darkened viewport is spent out of the
 * budget that is empty. The three.js scene keeps rendering behind the veil at
 * its usual cost and nothing is added to it.
 *
 * WHAT THIS FILE GUARANTEES, and what the tests hold it to:
 *
 *  1. ONE CREDIT. `#settle` is the only place gold is added and it is guarded by
 *     `_credited`. Escape spam, a click on Skip during the result animation, and
 *     a rite finishing on the same step the clock expires all converge on it.
 *  2. NO LEAKS. Every listener and every observer is registered through `#hold`,
 *     which returns nothing and stores a disposer. `close()` runs them all and
 *     empties the array. `listenerCount` is 0 whenever the overlay is shut, and
 *     a unit test asserts exactly that after an open/close cycle.
 *  3. NO PIXEL GAMEPLAY. The rite is handed field coordinates (contract.js
 *     FIELD) and a fixed dt. Resizing the window changes the letterbox and
 *     nothing else.
 *  4. NO PENALTY FOR LOSING FOCUS. A blur or a tab switch suspends the clock and
 *     the logic; coming back costs a short, visible grace and no score.
 *  5. FIXED TIMESTEP. Exactly like Game.frame (Game.js), and for the same
 *     reason: a rite stepped at the display's refresh rate is a different game
 *     on a 60 Hz panel and on a 144 Hz one.
 *  6. A CLICK RESOLVES WHERE IT WAS PRESSED. The position is captured inside the
 *     pointerdown handler and carried to the step in a pooled record, so a press
 *     at A followed by a move to B before the next step is still a press at A.
 *     `input.x/y` is where the pointer IS; `input.clicks` is where it WAS when it
 *     mattered, and the two are different numbers on any frame with movement in
 *     it. See contract.js NEUTRAL_INPUT for the two edges that come with the
 *     pool, and tests/unit/minigame-host.test.js for the A-then-B case.
 */

import { MINIGAMES } from '../core/Config.js';
import { waveDef } from '../game/Waves.js';
import { FIELD, SLOT_COUNT, makeInput, minigameReward } from './contract.js';
/**
 * WHAT A RITE EVENT SOUNDS LIKE, AS A TABLE.
 *
 * This was a `switch` with five arms, which quietly published a closed
 * vocabulary of five cues to every rite author — while AudioEngine.CUE holds
 * fourteen. A rite that wanted "the player just died" or "you picked up gold"
 * had to misuse 'break' or go silent, and both of those are worse than adding a
 * row here. The five original rows behave exactly as they did; the five new ones
 * are the verbs the six real minigames actually have.
 *
 * `kick` is the stage shake, 0 for none. The rule it encodes: a cue that can
 * fire forty times in twenty seconds must not shake, or the result is nausea
 * rather than impact — that is why 'tick' and 'gold' are silent-bodied.
 *
 * An unknown type is IGNORED, deliberately and without a warning: `drainEvents`
 * is presentation, and a rite must never be able to spam the console (or crash
 * the frame) with a typo in a string.
 */
const CUES = Object.freeze({
  perfect: { sfx: 'upgrade',   kick: 1 },
  good:    { sfx: 'build',     kick: 0.55 },
  miss:    { sfx: 'deny',      kick: 0.3 },
  /**
   * A FREQUENT, LOW-STAKES POSITIVE. A rite can resolve forty times in twenty
   * seconds; mapping each of those onto 'perfect' would kick the stage forty
   * times. 'tick' is the same reward with the shake removed, so a rite can
   * spend 'perfect' on the handful of moments that have earned a jolt.
   */
  tick:    { sfx: 'build',     kick: 0 },
  /** The heaviest negative available: something the player was protecting broke. */
  break:   { sfx: 'deny',      kick: 1 },
  /** Death, elimination, falling off the last platform. 'leak' is the game's own "you lost something irreversible". */
  fail:    { sfx: 'leak',      kick: 0.9 },
  /** A coin, a nugget, a pickup. Frequent by design, so no shake and the shortest cue in the set. */
  gold:    { sfx: 'select',    kick: 0 },
  /** A bomb, a crash, a wipeout. The only cue with a real explosion in it. */
  boom:    { sfx: 'bossDeath', kick: 1 },
  /** The go signal. Once per rite, at the top. */
  start:   { sfx: 'waveStart', kick: 0 },
  /** A rival got there first — the target is gone and it was not yours. Descending, not punishing. */
  claim:   { sfx: 'sell',      kick: 0.2 },
});
import { Painter } from './Painter.js';
import { riteDef } from './registry.js';
import { riteRng } from './schedule.js';
import { isTypingTarget } from '../util/dom.js';

/** Held-direction keys, mapped to the field's axes (+y is UP). */
const AXIS_KEYS = {
  ArrowLeft: ['x', -1], KeyA: ['x', -1], KeyQ: ['x', -1],
  ArrowRight: ['x', 1], KeyD: ['x', 1],
  ArrowUp: ['y', 1], KeyW: ['y', 1], KeyZ: ['y', 1],
  ArrowDown: ['y', -1], KeyS: ['y', -1],
};

/** Keys that mean "now". */
const COMMIT_KEYS = new Set(['Space', 'Enter', 'NumpadEnter']);

/**
 * Keys that mean "that one" — the six discrete choices of contract.js SLOT_COUNT.
 *
 * `e.code`, not `e.key`, so the six keys are the same six PHYSICAL keys on every
 * layout: on AZERTY the unshifted glyphs of Digit1..Digit6 are `&é"'(-`, and a
 * rite that read `e.key` would be unplayable there.
 *
 * NO LETTER ALIASES. The obvious second row is A S D F G H, and it is a trap:
 * A, S, D, W, Z and Q are all in AXIS_KEYS above, so a rite that used them would
 * simultaneously be steering. The digits are the only six keys on the board with
 * no other meaning inside an overlay that swallows everything.
 */
const SLOT_KEYS = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5,
  Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4, Numpad6: 5,
};

/**
 * Seconds the first Escape stays armed.
 *
 * ESCAPE ASKS TWICE, THE BUTTON DOES NOT. Escape is a reflex — it is the panic
 * key everywhere else in this game (Game.#cancelSelection) — and a reflex that
 * silently forfeits a wave's worth of gold is a trap. The Skip BUTTON is a
 * deliberate act on a labelled control and commits on the first click; that
 * asymmetry is the whole justification for not putting a confirmation dialog
 * over a dialog, which is the thing docs/PITFALLS.md and the Art Bible both
 * refuse.
 */
const ESC_ARM = 2.4;

/** Grace after regaining focus, in seconds, before the rite resumes. */
const RESUME_GRACE = 1.2;

/**
 * THE PRE-ROLL, IN SECONDS — five, counted down over the field.
 *
 * A rite arrives unannounced, on a wave boundary, over a board the player was
 * looking at for another reason entirely, and several of the six start scoring
 * on their first fixed step: the hunt's animals are already crossing, the
 * lucky-shot targets are already up. Without this, the first second of every
 * rite is spent reading the hint that is printed above it — which is a second
 * of the CLOCK, so the announcement was being paid for out of the reward.
 *
 * Counted in REAL seconds off the raw frame delta, not in fixed steps: nothing
 * is simulated here, so there is nothing that needs a deterministic tick, and a
 * rite's own clock must not have started before the player has.
 *
 * IT IS SKIPPABLE, and by the same key that plays the rite. A player on their
 * eighth rite knows what a fishing boat looks like, and five seconds they
 * cannot cut short is the toll booth the Skip button exists to refuse.
 */
const COUNTDOWN = 5;

/** How long "Go" stays on screen after the rite has actually started. */
const GO_FLASH = 0.45;

/** How long the result card sits before it advances on its own. */
const RESULT_HOLD = 5.5;

const html = String.raw;

export class MinigameHost {
  /**
   * @param {import('../game/Game.js').Game} game
   * @param {HTMLElement} root  #ui-root, same as every other overlay
   */
  constructor(game, root) {
    this.game = game;
    this.root = root;

    root.insertAdjacentHTML('beforeend', html`
      <div id="rite" role="dialog" aria-modal="true" aria-labelledby="rite-title" aria-hidden="true">
        <div class="rite-veil"></div>
        <div class="rite-shell" tabindex="-1">
          <header class="rite-head">
            <span class="rite-eyebrow" id="rite-eyebrow"></span>
            <h2 id="rite-title"></h2>
            <p class="rite-hint" id="rite-hint"></p>
          </header>

          <div class="rite-stage" id="rite-stage">
            <canvas id="rite-canvas"></canvas>
            <!-- THE PRE-ROLL. Sits over the field it is about to hand over, so
                 the player reads the board (where the targets are, which way
                 the boat is facing) while the number runs down. -->
            <!-- NO RITE NAME IN HERE. It is already six lines up, in the
                 heading, at twice the size; printing it twice on one surface
                 spends the centre of the field on something the player has
                 just read. The announcement is the verb and the number. -->
            <div class="rite-count" id="rite-count" hidden>
              <span class="rc-ready">Get ready</span>
              <b id="rite-count-num" aria-live="assertive">5</b>
            </div>

            <div class="rite-suspend" id="rite-suspend" hidden>
              <b>Suspended</b>
              <span id="rite-suspend-note">Focus lost — press any key to resume</span>
            </div>

            <!-- INSIDE the stage, not the shell. Over the shell it covered the
                 title and the clock, which then showed through the card as
                 ghost text and read as a rendering bug. Here the heading stays
                 legible and the anvil you just struck stays visible behind the
                 number you earned. -->
            <div class="rite-result" id="rite-result" hidden>
              <span class="rr-kicker" id="rite-result-kicker"></span>
              <h3 id="rite-result-headline"></h3>
              <p id="rite-result-detail"></p>
              <div class="rr-gold"><i>+</i><b id="rite-result-gold">0</b><u>gold</u></div>
              <button type="button" class="rr-go" id="rite-continue" data-act="continue">
                Continue <kbd>Enter</kbd>
              </button>
            </div>
          </div>

          <footer class="rite-foot">
            <div class="rite-clock" id="rite-clock">
              <span class="rc-track"><i id="rite-clock-fill"></i></span>
              <b id="rite-clock-num">0.0</b>
            </div>
            <button type="button" class="rite-skip" id="rite-skip" data-act="skip">
              <span id="rite-skip-label">Skip</span> <kbd>Esc</kbd>
            </button>
          </footer>
        </div>
      </div>`);

    const q = (id) => root.querySelector(id);
    this.$el = q('#rite');
    this.$shell = q('#rite .rite-shell');
    this.$stage = q('#rite-stage');
    this.$canvas = q('#rite-canvas');
    this.$eyebrow = q('#rite-eyebrow');
    this.$title = q('#rite-title');
    this.$hint = q('#rite-hint');
    this.$clockFill = q('#rite-clock-fill');
    this.$clockNum = q('#rite-clock-num');
    this.$skip = q('#rite-skip');
    this.$skipLabel = q('#rite-skip-label');
    this.$count = q('#rite-count');
    this.$countNum = q('#rite-count-num');
    this.$suspend = q('#rite-suspend');
    this.$suspendNote = q('#rite-suspend-note');
    this.$result = q('#rite-result');
    this.$resKicker = q('#rite-result-kicker');
    this.$resHeadline = q('#rite-result-headline');
    this.$resDetail = q('#rite-result-detail');
    this.$resGold = q('#rite-result-gold');
    this.$continue = q('#rite-continue');

    this.painter = new Painter(this.$canvas.getContext('2d', { alpha: true }));

    /** @type {Array<() => void>} Disposers for everything bound while open. */
    this._disposers = [];
    this.isOpen = false;
    this.def = null;
    this.instance = null;
    /** 'countdown' | 'play' | 'result' */
    this.mode = 'play';

    this._input = makeInput();
    this._pendingActions = 0;
    /** Secondary (right-button) commits queued since the last fixed step. */
    this._pendingAlt = 0;
    /** Per-slot press counts queued since the last fixed step. Never reallocated. */
    this._pendingSlots = new Array(SLOT_COUNT).fill(0);

    /**
     * THE CLICK QUEUE, AND THE POOL BEHIND IT.
     *
     * `_clickPool` is allocated once and never grows; `_pendingClicks` holds
     * references INTO it, in arrival order, and is truncated rather than
     * replaced on every step. A shooting rite fires a few times a second for
     * twenty seconds — allocating a record per press would be a few hundred
     * short-lived objects per rite, which is not a lot, but it is a garbage
     * collection inside a game measured in reaction time, and the whole overlay
     * exists inside a frame budget the 3D scene has already spent.
     *
     * The cost is the edge documented in contract.js NEUTRAL_INPUT: a rite that
     * keeps a record past its step is reading a later click. Copy what you keep.
     */
    this._clickPool = Array.from({ length: MINIGAMES.maxClicksPerStep },
      () => ({ x: 0, y: 0, button: 0, source: 'pointer' }));
    /** Arrived since the last fixed step. @type {Array<object>} */
    this._pendingClicks = [];
    /**
     * What sub-step 1 is handed. A SECOND array rather than the pending one, so
     * "deliver, then clear the queue" needs no allocation and sub-steps 2..n get
     * an empty list without anyone reallocating `input.clicks` eight times a
     * frame. The rite always sees the same array identity — which is the other
     * half of "do not keep it".
     */
    this._stepClicks = [];
    this._held = new Set();
    this._acc = 0;
    this._remaining = 0;
    this._elapsed = 0;
    this._escArm = 0;
    this._suspended = false;
    this._grace = 0;
    this._resultAge = 0;
    this._credited = false;
    this._reward = 0;
    this._goldShown = 0;
    /** Seconds left on the pre-roll, and the integer currently painted. */
    this._count = 0;
    this._countShown = 0;
    /** Seconds of "Go" left AFTER the rite has started. Presentation only. */
    this._goFlash = 0;
    this._cssW = 0; this._cssH = 0; this._dpr = 0;
    this._onDone = null;
  }

  /** Live count of things that must be released. 0 whenever the overlay is shut. */
  get listenerCount() { return this._disposers.length; }

  // ---- lifecycle ---------------------------------------------------------

  /**
   * Open a rite.
   *
   * @param {{id: string, wave: number, occurrence: number,
   *          onDone?: (r: {reward: number, ratio: number, skipped: boolean}) => void}} o
   * @returns {boolean} false if the id is unknown or one is already open — the
   *   caller must treat that as "no rite happened" and carry on, never as a
   *   reason to stall the state machine.
   */
  open(o) {
    if (this.isOpen) return false;
    const def = riteDef(o.id);
    if (!def) { console.warn(`[rite] unknown minigame '${o.id}'`); return false; }

    this.def = def;
    this.wave = o.wave;
    this.occurrence = o.occurrence ?? 0;
    this._onDone = o.onDone ?? null;

    this.instance = def.create();
    this.instance.init({
      rand: riteRng(this.game.seed, def.id, this.occurrence),
      wave: this.wave,
      // Passed as well as consumed. It already reseeds the rite's generator; a
      // rite that wants its SECOND appearance to be a different shape rather
      // than the same shape re-rolled needs to be able to read it. Structural
      // variation only — see MinigameCtx in contract.js.
      occurrence: this.occurrence,
      width: FIELD.w,
      height: FIELD.h,
      quality: this.game.pipeline?.quality ?? 'high',
    });

    this.mode = 'countdown';
    this._count = COUNTDOWN;
    this._countShown = Math.ceil(COUNTDOWN);
    this._goFlash = 0;
    this._input = makeInput();
    this._pendingActions = 0;
    this._pendingAlt = 0;
    this._pendingClicks.length = 0;
    this._stepClicks.length = 0;
    this._pendingSlots.fill(0);
    this._held.clear();
    this._acc = 0;
    this._remaining = def.duration;
    this._elapsed = 0;
    this._escArm = 0;
    this._suspended = false;
    this._grace = 0;
    this._resultAge = 0;
    this._credited = false;
    this._aborted = false;
    this._reward = 0;
    this._ratio = 0;
    this._skipped = false;
    this._goldShown = 0;
    // Force a first layout even if the canvas happens to match its last size.
    this._cssW = 0; this._cssH = 0; this._dpr = 0;

    /**
     * PER-RITE PAINT, VIA ONE ATTRIBUTE.
     *
     * `data-rite` selects the stage gradient, the veil and the accent in
     * ui/minigames.css. It is set here and removed in close() rather than left
     * behind, because a stale theme on a shut overlay is the kind of thing that
     * shows up as "the wrong colours for a quarter of a second" on the NEXT
     * rite's entry transition — after the theme has been swapped but before the
     * 240 ms fade has finished.
     *
     * `theme` defaults to `id`, and is a separate field because `id` is part of
     * the seed contract (schedule.js feeds it to the RNG label) while paint is
     * not: two rites may legitimately share a look, and neither may share a seed.
     */
    this.$el.dataset.rite = def.theme ?? def.id;
    // Inline, so it beats the stylesheet's default crosshair, and cleared on
    // close so it cannot survive into a rite that never asked for it.
    this.$canvas.style.cursor = def.cursor ?? '';
    this.$eyebrow.textContent = `${def.eyebrow ?? 'Interlude'} · before wave ${this.wave}`;
    this.$title.textContent = def.name;
    this.$hint.textContent = def.hint;
    this.$skipLabel.textContent = 'Skip';
    this.$skip.classList.remove('armed');
    this.$result.hidden = true;
    this.$suspend.hidden = true;
    this.$countNum.textContent = String(this._countShown);
    this.$count.classList.remove('go');
    this.$count.hidden = false;
    this.$el.classList.remove('resolved');
    this.$el.classList.add('open');
    this.$el.setAttribute('aria-hidden', 'false');
    this.isOpen = true;

    this.#bind();
    // offsetWidth before focus, per docs/PITFALLS.md: focusing a node whose
    // visibility is still inherited from a hidden ancestor silently does
    // nothing, and then the keyboard shield has nothing to shield.
    void this.$shell.offsetWidth;
    this.$shell.focus({ preventScroll: true });
    // DELIBERATELY NOT RENDERING HERE. A first frame drawn from inside open()
    // can, if the rite throws, run #guard -> close() -> onDone -> the caller's
    // "the rite is over" handler, all BEFORE open() has returned true — and the
    // caller then sets the phase it was about to leave. The overlay's entry
    // transition is 240 ms; one blank frame inside it is invisible, and the
    // first real render arrives from update() a few milliseconds later.
    return true;
  }

  /**
   * Register a listener/observer AND its disposer in one breath.
   *
   * The two-array version of this (add here, remove there) is how a listener
   * gets left behind: the removal site drifts from the addition site, the
   * options object differs by a `capture` nobody noticed, and removeEventListener
   * silently does nothing. One call, one closure, no way to disagree.
   */
  #hold(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  #bind() {
    /**
     * THE KEYBOARD SHIELD — capture, on document, exactly like HUD's key sheet
     * and Lobby's, and for the incident documented at HUD.js's `_onKeyShield`:
     * with a full-bleed veil up and no shield, Space still sent the next wave,
     * P still toggled pause and 1-3 still changed the simulation speed, all
     * invisibly. Space is this rite's PRIMARY VERB, so without the shield the
     * first thing a player does inside a minigame is start the next wave.
     *
     * Capture on document beats every bubble-phase listener on window whatever
     * the registration order, which matters because BuildBar and Game both bind
     * on window and both were constructed long before this.
     *
     * WHAT STILL GETS THROUGH: modified keys (Cmd/Ctrl/Alt — never steal a
     * browser shortcut), F-keys, and typing targets. The dev panel's own
     * listener is on WINDOW at capture, which fires before document capture, so
     * F9 still opens it from inside a rite.
     */
    this.#hold(document, 'keydown', (e) => this.#onKeyDown(e), true);
    this.#hold(document, 'keyup', (e) => this.#onKeyUp(e), true);

    // Delegated, so a new control in the template needs no new listener.
    this.#hold(this.$el, 'click', (e) => {
      const act = e.target?.closest?.('[data-act]')?.dataset?.act;
      if (act === 'skip') this.#skip();
      else if (act === 'continue') this.close();
    });

    // Pointer. Down is bound on the STAGE so a click on the chrome (skip button,
    // heading) is not also a strike; move and up are bound on the window so a
    // drag that leaves the stage still resolves instead of leaving `down` stuck.
    this.#hold(this.$stage, 'pointerdown', (e) => {
      /**
       * TWO BUTTONS, TWO VERBS, ONE QUEUE.
       *
       * Button 0 is the primary commit and still — and only — feeds `action`,
       * so every rite written before the secondary button existed behaves
       * identically. Button 2 feeds `altAction`. BOTH push a record onto the
       * click queue, because a rite that cares about WHERE reads `clicks` and
       * filters on `button`; a rite that only cares about HOW MANY reads the
       * two counters and never learns that a queue exists.
       *
       * Middle-click, back and forward are dropped: they are chorded on some
       * mice and bound to navigation on others, and neither is a game verb.
       */
      if (e.button !== 0 && e.button !== 2) return;
      if (this._suspended) { this.#resume(); return; }
      // A press during the pre-roll STARTS the rite and is not also a strike:
      // it is the "I have read it, go" click, and crediting it as the first
      // shot would fire it at wherever the player happened to be impatient.
      if (this.mode === 'countdown') { this.#beginPlay(); return; }
      if (this.mode !== 'play') return;
      // ORDER MATTERS: sync first so the position pushed below is the position
      // of THIS press. See #pushClick — this is the entire point of the queue.
      this.#syncPointer(e);
      if (e.button === 0) {
        this._input.down = true;
        this._pendingActions++;
      } else {
        this._pendingAlt++;
      }
      this.#pushClick(e.button, 'pointer');
    });
    this.#hold(window, 'pointermove', (e) => this.#syncPointer(e));
    // `pointerup` filters on button 0: releasing the RIGHT button must not clear
    // the state of a primary button that is still physically held down.
    this.#hold(window, 'pointerup', (e) => { if (e.button === 0) this._input.down = false; });
    // `pointercancel` does NOT filter, and that asymmetry is deliberate: a
    // cancel reports button -1 (no button changed state), so filtering it the
    // same way would leave `down` stuck true forever after a gesture the OS
    // took away — which is the exact failure the window-level binding exists
    // to prevent.
    this.#hold(window, 'pointercancel', () => { this._input.down = false; });
    this.#hold(this.$stage, 'pointerleave', () => { this._input.inside = false; });

    /**
     * THE CONTEXT MENU, KILLED ON `$el` AND NOT ON `$stage`.
     *
     * Right-click is a game verb here, and the OS menu it normally raises would
     * cover the field, eat the next click and — on the way out — hand the page a
     * blur, which #suspend reads as "the player looked away". Bound on the whole
     * overlay rather than on the stage so the veil, the heading and the footer
     * are covered too: a right-click that misses the field by four pixels must
     * not be the one that opens a menu over the rite.
     */
    this.#hold(this.$el, 'contextmenu', (e) => e.preventDefault());

    /**
     * FOCUS LOSS. Three events rather than one, because they do not overlap:
     * `blur` catches alt-tab and a click into the dev tools, `visibilitychange`
     * catches a tab switch and a minimised window (which need not fire blur),
     * and `pagehide` catches a bfcache suspend on Safari. Missing any of them
     * means a rite that kept running while nobody was looking, which is a
     * player robbed of a reward by their own operating system.
     *
     * Note this is BELT AND BRACES on top of the dt clamp: even with no
     * suspension at all, `Math.min(dt, MINIGAMES.maxFrameDt)` in update() means
     * a thirty-second tab-out advances the rite by at most 100 ms. The
     * suspension exists so that the 100 ms is not spent either.
     */
    this.#hold(window, 'blur', () => this.#suspend());
    this.#hold(window, 'pagehide', () => this.#suspend());
    this.#hold(document, 'visibilitychange', () => { if (document.hidden) this.#suspend(); });

    // Resize is handled by observation rather than by a resize listener: the
    // canvas can change size without the WINDOW changing size (a devtools dock,
    // a CSS media query, a zoom), and one observer covers all of it.
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { this._cssW = 0; });
      ro.observe(this.$canvas);
      this._disposers.push(() => ro.disconnect());
    }
  }

  /**
   * Release everything, restore the game, tell the caller.
   *
   * Safe to call twice: the `isOpen` guard makes double-close a no-op, which is
   * what lets Escape, the Continue button and the auto-advance timer all race
   * for it without anyone checking who got there first.
   */
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const dispose of this._disposers) dispose();
    this._disposers.length = 0;

    this.instance?.teardown?.();
    const result = {
      id: this.def?.id ?? null,
      wave: this.wave,
      reward: this._reward,
      ratio: this._ratio ?? 0,
      skipped: !!this._skipped,
    };
    this.instance = null;
    this.def = null;

    this.$el.classList.remove('open', 'resolved');
    delete this.$el.dataset.rite;
    this.$canvas.style.cursor = '';
    this.$el.setAttribute('aria-hidden', 'true');
    this.$result.hidden = true;
    this.$suspend.hidden = true;
    this.$count.hidden = true;
    this.$count.classList.remove('go');

    const done = this._onDone;
    this._onDone = null;
    done?.(result);
  }

  /** Tear the whole surface out of the DOM. For HMR and for tests. */
  destroy() {
    this.close();
    this.$el.remove();
  }

  // ---- input -------------------------------------------------------------

  #syncPointer(e) {
    const r = this.$canvas.getBoundingClientRect();
    const p = this.painter.toField(e.clientX - r.left, e.clientY - r.top);
    // Kept even when outside, deliberately — see NEUTRAL_INPUT's docblock.
    this._input.x = p.x;
    this._input.y = p.y;
    this._input.inside = e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  /**
   * Queue one click AT THE POSITION IT HAPPENED.
   *
   * THE BUG THIS EXISTS TO KILL. A rite used to resolve a press by reading
   * `input.x/y` on the next fixed step — but `input.x/y` is the LATEST pointer
   * position, and pointermove fires between a press and the step that follows
   * it. Press on the target at A, keep moving to B, and the shot is credited at
   * B: a hit becomes a miss, or worse, a hit on the wrong animal. At 60 Hz with
   * a fast hand that is a couple of world units of error, which is most of a
   * target. The position is therefore taken here, inside the handler, from the
   * event itself — `#syncPointer` has just run on the same event — and carried
   * to the step in a record.
   *
   * Over the cap the click is DROPPED, silently and without growing anything.
   * Losing the twelfth press of a single frame costs a player nothing real; an
   * unbounded queue costs everyone a frame.
   */
  #pushClick(button, source) {
    const n = this._pendingClicks.length;
    if (n >= this._clickPool.length) return;
    const rec = this._clickPool[n];
    rec.x = this._input.x;
    rec.y = this._input.y;
    rec.button = button;
    rec.source = source;
    this._pendingClicks.push(rec);
  }

  #onKeyDown(e) {
    if (!this.isOpen) return;
    if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    // Function keys belong to the browser and to the dev panel. Never eaten.
    if (/^F\d/.test(e.code)) return;

    if (this._suspended) {
      e.preventDefault(); e.stopPropagation();
      this.#resume();
      return;
    }

    // Everything below this line is swallowed. See #bind's docblock: these keys
    // send waves, change speed and spend gold on the board behind the veil.
    e.preventDefault();
    e.stopPropagation();

    if (e.code === 'Escape') { this.#escape(); return; }

    if (this.mode === 'result') {
      if (COMMIT_KEYS.has(e.code)) this.close();
      return;
    }

    /**
     * The pre-roll answers to the commit keys and to nothing else. Steering
     * keys are deliberately still collected into `_held` below, so a player who
     * is already leaning on Left when the number hits zero is moving on the
     * first step rather than on the one after they noticed.
     */
    if (this.mode === 'countdown') {
      if (COMMIT_KEYS.has(e.code) && !e.repeat) { this.#beginPlay(); return; }
      const held = AXIS_KEYS[e.code];
      if (held) this._held.add(e.code);
      return;
    }

    // Tab is trapped rather than allowed: the only focusable thing inside the
    // overlay is the Skip button, and letting Tab out would put focus on the
    // build dock behind a veil that swallows the clicks it invites.
    if (e.code === 'Tab') return;

    if (COMMIT_KEYS.has(e.code)) {
      // `repeat` dropped: holding Space must not be worth one commit per key
      // repeat interval. A rite that wants held state reads `input.down`.
      if (!e.repeat) {
        this._pendingActions++;
        /**
         * A KEY COMMIT IS ALSO A CLICK, at the last known pointer position.
         *
         * Without this the three shooting rites are mouse-only, which is a
         * platform tax rather than a design: on a macOS trackpad the secondary
         * click is a two-finger press with a settle delay, and a game measured
         * in tens of milliseconds must not hand one input device a handicap.
         * Aim with the pointer, fire with whichever of the three feels right.
         */
        this.#pushClick(0, 'key');
      }
      return;
    }
    const slot = SLOT_KEYS[e.code];
    if (slot !== undefined) {
      // `repeat` dropped for the same reason as a commit: holding 3 must not be
      // worth one answer per key-repeat interval.
      if (!e.repeat) this._pendingSlots[slot]++;
      return;
    }

    const ax = AXIS_KEYS[e.code];
    if (ax) this._held.add(e.code);
  }

  #onKeyUp(e) {
    if (!this.isOpen) return;
    if (AXIS_KEYS[e.code]) { this._held.delete(e.code); e.stopPropagation(); }
  }

  #axis() {
    let x = 0, y = 0;
    for (const code of this._held) {
      const [axis, dir] = AXIS_KEYS[code];
      if (axis === 'x') x += dir; else y += dir;
    }
    return { x: Math.sign(x), y: Math.sign(y) };
  }

  #escape() {
    if (this.mode === 'result') { this.close(); return; }
    if (this._escArm > 0) { this.#skip(); return; }
    this._escArm = ESC_ARM;
    this.$skipLabel.textContent = 'Escape again to abandon';
    this.$skip.classList.add('armed');
    this.game.audio?.play('deny');
  }

  #skip() {
    // 'countdown' is skippable for the same reason 'play' is: a player who does
    // not want this rite must not have to wait five seconds to say so.
    if (this.mode !== 'play' && this.mode !== 'countdown') return;
    this._skipped = true;
    this.#settle();
  }

  // ---- the pre-roll ------------------------------------------------------

  /**
   * Run the announcement down. Real seconds in, one cue per whole number out.
   *
   * The cue is fired on the CHANGE and not on the frame the number is drawn,
   * so a frame that swallowed two seconds (a stall, a slow first frame while
   * the rite's textures land) ticks once rather than twice — a countdown that
   * beeps twice in a row reads as a bug in a way a silent second never does.
   */
  #tickCountdown(dt) {
    this._count -= dt;
    const n = Math.max(0, Math.ceil(this._count));
    if (n !== this._countShown) {
      this._countShown = n;
      if (n > 0) {
        this.$countNum.textContent = String(n);
        this.game.audio?.play('select');
        // Restart the pop, same forced reflow as #kick and for the same reason.
        this.$count.classList.remove('tick');
        void this.$count.offsetWidth;
        this.$count.classList.add('tick');
      }
    }
    if (this._count <= 0) this.#beginPlay();
  }

  /**
   * Hand the field over: the clock starts HERE and not in open().
   *
   * The queued input is dropped on the way through, because everything that
   * arrived during the announcement was aimed at the announcement — the press
   * that skipped it, the double-click of a player who was still clicking on the
   * board behind the veil when the rite arrived. A rite must never open on a
   * shot nobody meant to take.
   */
  #beginPlay() {
    if (this.mode !== 'countdown') return;
    this.mode = 'play';
    this._count = 0;
    this._acc = 0;
    this._pendingActions = 0;
    this._pendingAlt = 0;
    this._pendingClicks.length = 0;
    this._pendingSlots.fill(0);
    this._goFlash = GO_FLASH;
    this.$countNum.textContent = 'Go';
    this.$count.classList.remove('tick');
    this.$count.classList.add('go');
    this.game.audio?.play('waveStart');
  }

  // ---- suspension --------------------------------------------------------

  #suspend() {
    if (!this.isOpen || this._suspended) return;
    if (this.mode !== 'play' && this.mode !== 'countdown') return;
    this._suspended = true;
    this._input.down = false;
    this._held.clear();
    // Discard queued commits: a click that focused the window is not a strike,
    // and — since the queue carries a POSITION — it is not a shot at whatever
    // happened to be under the cursor when the player alt-tabbed back either.
    this._pendingActions = 0;
    this._pendingAlt = 0;
    this._pendingClicks.length = 0;
    this._pendingSlots.fill(0);
    this.$suspend.hidden = false;
    this.$suspendNote.textContent = 'Focus lost — the clock is stopped. Press any key to resume.';
  }

  #resume() {
    this._suspended = false;
    this._grace = RESUME_GRACE;
    this._pendingActions = 0;
    this._pendingAlt = 0;
    this._pendingClicks.length = 0;
    this._pendingSlots.fill(0);
    this.$suspend.hidden = false;
  }

  // ---- the loop ----------------------------------------------------------

  /**
   * Driven from Game.frame at the VARIABLE rate, outside the fixed-step block.
   *
   * That placement is what lets 'minigame' sit in FROZEN_PHASES without freezing
   * the rite itself, and it is also what keeps state.speed (1x/2x/3x) out of the
   * rite: a player who left the game on 3x must not get a minigame at triple
   * speed, and one who left it on 1x must not get an easier one.
   */
  update(dt) {
    if (!this.isOpen) return;
    // Same clamp and the same reason as Game.frame: a frame that took two
    // seconds (a stall, a GC pause, a tab that was never told it was hidden)
    // must not be replayed as two seconds of gameplay the player never saw.
    const raw = Math.min(dt, MINIGAMES.maxFrameDt);
    this._elapsed += raw;

    if (this._escArm > 0) {
      this._escArm -= raw;
      if (this._escArm <= 0) {
        this.$skipLabel.textContent = 'Skip';
        this.$skip.classList.remove('armed');
      }
    }

    if (this.mode === 'result') {
      this._resultAge += raw;
      this.#tweenGold(raw);
      if (this._resultAge >= RESULT_HOLD) { this.close(); return; }
      this.#render(raw);
      return;
    }

    if (this._suspended) { this.#render(raw); return; }

    if (this._grace > 0) {
      this._grace -= raw;
      this.$suspendNote.textContent = `Resuming in ${Math.max(1, Math.ceil(this._grace))}…`;
      if (this._grace <= 0) this.$suspend.hidden = true;
      this.#render(raw);
      return;
    }

    if (this.mode === 'countdown') {
      this.#tickCountdown(raw);
      // Drawn, never stepped: the field is shown exactly as the rite laid it
      // out in init(), which is the whole point of announcing over it.
      this.#render(raw);
      return;
    }

    if (this._goFlash > 0) {
      this._goFlash -= raw;
      if (this._goFlash <= 0) {
        this.$count.hidden = true;
        this.$count.classList.remove('go');
      }
    }

    // ---- fixed timestep, exactly as Game.frame does it -------------------
    const step = MINIGAMES.dt;
    this._acc += raw;
    let n = 0;
    while (this._acc >= step && n < 8 && this.mode === 'play') {
      // The queued commits belong to the FIRST step of this frame. Handing the
      // same count to every sub-step would multiply one click into three.
      const input = this._input;
      input.action = this._pendingActions;
      input.altAction = this._pendingAlt;
      this._pendingActions = 0;
      this._pendingAlt = 0;
      /**
       * The queue is handed to THIS sub-step and then emptied, so sub-steps
       * 2..n of the same frame see none of it — same rule as `action`, same
       * reason: three sub-steps that each see the same click fire three shots.
       * The references are moved rather than the records copied; the pool
       * behind them is what makes that safe and what makes it dangerous to
       * keep one (contract.js NEUTRAL_INPUT).
       */
      this._stepClicks.length = 0;
      for (let i = 0; i < this._pendingClicks.length; i++) {
        this._stepClicks.push(this._pendingClicks[i]);
      }
      this._pendingClicks.length = 0;
      input.clicks = this._stepClicks;
      // Copied in place and then zeroed, never swapped for a fresh array: this
      // runs up to eight times a frame for the whole session and the rite is
      // allowed to read the record but not to keep it.
      for (let i = 0; i < SLOT_COUNT; i++) {
        input.slots[i] = this._pendingSlots[i];
        this._pendingSlots[i] = 0;
      }
      input.axis = this.#axis();

      const ended = this.#guard(() => this.instance.update(step, input));
      if (this._aborted) return;
      this._acc -= step;
      this._remaining -= step;
      n++;

      /**
       * ORDER MATTERS AND IS THE DOUBLE-CREDIT CASE. A rite can finish on the
       * exact step the clock runs out. `ended` is tested first so the player is
       * credited for the run they completed rather than for a timeout, and
       * either way #settle's `_credited` guard means the second branch cannot
       * pay a second time.
       */
      if (ended) { this.#settle(); break; }
      if (this._remaining <= 0) { this._remaining = 0; this.#settle(); break; }
    }
    if (this._acc > step * 8) this._acc = 0;

    this.#drainEvents();
    this.#render(raw);
  }

  /**
   * THE CONTAINMENT WALL between a buggy rite and the player's run.
   *
   * This is not defensive decoration. MinigameHost.update is called from
   * Game.frame, which is called from main.js's requestAnimationFrame loop, and
   * that loop has no try/catch: an exception thrown inside a rite's draw()
   * propagates all the way out and KILLS THE RENDER LOOP. Measured, first time
   * this file was run for real — a one-character name collision in Painter made
   * draw() throw, and the result was not "the minigame looks wrong", it was a
   * frozen game with an overlay stuck on frame one and no way out. A tower
   * defence must not be endable by a bonus round.
   *
   * So a rite that throws loses its rite, loudly, and the run continues. The
   * error is re-reported through console.error rather than swallowed, because
   * the e2e suite asserts `expect(errors).toEqual([])` and a rite that throws
   * must still fail the build.
   */
  #guard(fn) {
    try {
      return fn();
    } catch (err) {
      this._aborted = true;
      console.error(`[rite] '${this.def?.id}' threw and was abandoned:`, err);
      this._skipped = true;
      this.#settle();
      this.close();
      return undefined;
    }
  }

  #drainEvents() {
    const events = this.instance?.drainEvents?.();
    if (!events || events.length === 0) return;
    for (const ev of events) {
      const cue = CUES[ev.type];
      if (!cue) continue;                       // unknown type: ignored, see CUES
      this.game.audio?.play(cue.sfx);
      if (cue.kick > 0) this.#kick(cue.kick, ev.x);
    }
  }

  /**
   * Impact, as a CSS animation on the STAGE rather than as CameraRig.addShake.
   *
   * The 3D board is behind a heavy veil during a rite, so shaking the camera
   * would spend real shake budget on something nobody can see while leaving the
   * thing they ARE looking at perfectly still. Restarting the animation needs
   * the class off, a forced reflow, and the class back on — the same
   * `void offsetWidth` trick HUD.pulseLives uses, for the same reason.
   *
   * `ev.x` FINALLY DOES SOMETHING. It has been in the drainEvents typedef since
   * the first rite and was read by nothing, which made the typedef a lie — the
   * worst kind of documentation, because it is checked by no one and believed by
   * everyone. Normalised by FIELD.hw it is the event's side of the field in
   * [-1, 1], and it biases the shake horizontally: a hit on the right of the
   * stage throws the stage right. Absent or off-field, the kick is vertical
   * exactly as before, so no existing rite changes.
   */
  #kick(strength, x) {
    const el = this.$stage;
    el.classList.remove('kick');
    void el.offsetWidth;
    el.style.setProperty('--kick', String(strength));
    const bias = Number.isFinite(x) ? Math.max(-1, Math.min(1, x / FIELD.hw)) : 0;
    el.style.setProperty('--kick-x', bias.toFixed(3));
    el.classList.add('kick');
  }

  /**
   * THE ONE PLACE GOLD IS CREDITED.
   *
   * Guarded rather than trusted: the four paths into here (rite ended, clock
   * expired, Escape confirmed, Skip clicked) can genuinely race — Escape during
   * the last step of a rite that was about to finish is one keystroke away — and
   * a second credit would be silent, permanent and unattributable.
   */
  #settle() {
    if (this._credited) return;
    this._credited = true;
    this.mode = 'result';
    this._resultAge = 0;

    const s = this._skipped
      ? {
        ratio: 0,
        headline: 'Rite abandoned',
        // Per-def, because the literal here used to be 'You stepped away from
        // the anvil' — true of one rite out of six, and quietly false on a
        // fishing boat.
        detail: this.def?.abandonNote ?? 'You walked away',
      }
      : (this.instance?.score?.() ?? { ratio: 0, headline: '—', detail: '' });
    this._ratio = Math.max(0, Math.min(1, Number(s.ratio) || 0));

    if (this._skipped) {
      // Short-circuited rather than left to the formula, so the two never have
      // to be kept in agreement by hand. They agree anyway — `minigameReward`
      // pays 0 for a ratio of 0 by construction now — but a reader should be
      // able to see "walking away pays nothing" without leaving this file.
      this._reward = 0;
    } else {
      const next = waveDef(this.wave);
      this._reward = minigameReward(this._ratio, next.count * next.bounty);
    }

    if (this._reward > 0) {
      this.game.addGold(this._reward, 'minigame');
      this.game.audio?.play('waveClear');
    }

    this.$resKicker.textContent = this.def?.name ?? 'Rite';
    this.$resHeadline.textContent = s.headline ?? '';
    this.$resDetail.textContent = s.detail ?? '';
    this.$resGold.textContent = '0';
    this._goldShown = 0;
    this.$result.hidden = false;
    this.$el.classList.add('resolved');
    this.$suspend.hidden = true;
    // A rite skipped during its own announcement still has the "Go" up.
    this.$count.hidden = true;
    this._goFlash = 0;
    this.$result.classList.toggle('empty', this._reward === 0);
    void this.$continue.offsetWidth;
    this.$continue.focus({ preventScroll: true });
  }

  /** The count-up on the result card. Presentation only; the gold is already banked. */
  #tweenGold(dt) {
    if (this._goldShown >= this._reward) return;
    const diff = this._reward - this._goldShown;
    this._goldShown = Math.min(this._reward, this._goldShown + Math.max(1, diff * Math.min(1, dt * 6)));
    this.$resGold.textContent = String(Math.round(this._goldShown));
  }

  // ---- rendering ---------------------------------------------------------

  #render(dt) {
    const cvs = this.$canvas;
    const cssW = cvs.clientWidth;
    const cssH = cvs.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const dpr = Math.min(MINIGAMES.maxDpr, window.devicePixelRatio || 1);

    if (cssW !== this._cssW || cssH !== this._cssH || dpr !== this._dpr) {
      this._cssW = cssW; this._cssH = cssH; this._dpr = dpr;
      cvs.width = Math.max(1, Math.round(cssW * dpr));
      cvs.height = Math.max(1, Math.round(cssH * dpr));
    }
    // Recomputed every frame: setTransform is three multiplies, and remembering
    // whether the transform survived someone's save/restore is not worth it.
    this.painter.layout(cssW, cssH, dpr);
    this.painter.clear();

    if (this.instance) {
      const alpha = Math.min(1, this._acc / MINIGAMES.dt);
      this.#guard(() => this.instance.draw(this.painter, alpha));
      if (this._aborted) return;
    }

    // The clock. Rendered in the DOM rather than on the canvas so it uses the
    // game's own type tokens and tabular figures instead of a canvas font.
    const frac = this.def ? Math.max(0, this._remaining) / this.def.duration : 0;
    this.$clockFill.style.transform = `scaleX(${frac.toFixed(4)})`;
    this.$clockNum.textContent = Math.max(0, this._remaining).toFixed(1);
    this.$clockNum.classList.toggle('low', this._remaining < 4 && this.mode === 'play');
    void dt;
  }
}
