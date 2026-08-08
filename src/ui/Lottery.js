/**
 * THE RITE OF FORTUNE — the rail seal, the draw overlay, and the single credit.
 *
 * Rules live in `src/game/lottery.js` and are pure. This file owns pixels,
 * listeners and gold movement, and nothing else. Read docs/LOTTERY.md first.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE DESIGN RULE THE REST OF THIS FILE HANGS OFF
 *
 * THE RESULT IS DECIDED AND STORED BEFORE THE ANIMATION STARTS. `#wager()`
 * spends the stake, consumes exactly one `rand()`, resolves the table and writes
 * `this._draw`. The 3.6 s that follow are an interpolation TOWARD a number that
 * already exists. Escape, a click on the veil, a tab blur and a browser stall
 * therefore all resolve to the same outcome, instantly and without ceremony,
 * because there is nothing left to compute. An animation that decides a result
 * is not a slow animation, it is a design bug: it makes every escape hatch a
 * fairness question and every stall a possible refund.
 *
 * WHY IT IS NOT A RITE. `MinigameHost` pays `minigameReward(ratio, gross)` off a
 * skill score, runs a clock, offers a Skip and grants a rite the field. None of
 * those apply to a wager: there is no ratio, the payout comes from a table, and
 * skipping a transaction you have already paid for is not a thing that can
 * exist. What IS reused is everything that made the host safe — the full-bleed
 * veil, the capture-phase keyboard shield, the single guarded credit, the
 * disposer list, the 2D canvas over a CSS-darkened viewport, and `Painter`
 * itself, verbatim. See docs/MINIGAMES.md §5; the guarantees below are the same
 * list, honoured by different code because the shapes genuinely differ.
 *
 * WHY A CANVAS AND NOT THREE. docs/PERF_BUDGET.md: the frame is fragment-bound
 * at 16.6 ms median and the CPU sits near-idle. A ring drawn in 2D over a
 * CSS-darkened viewport adds no light, no pass and no transparent full-bleed
 * surface to the three.js pipeline. Same reasoning as MinigameHost, same answer.
 *
 * WHY THE PHASE FREEZES. The draw takes ~3.6 s and a late-game prep is 30 s. A
 * wager invoked with four seconds left would otherwise send the wave from behind
 * the veil — the exact incident HUD's key shield exists for, one layer up. So
 * the draw sets `state.phase = 'lottery'`, which is in `FROZEN_PHASES`, and puts
 * it back on close. There are no creeps alive during a prep, so freezing costs
 * the player nothing but the prep clock they are not watching.
 */

import { rngFor, mulberry32 } from '../core/Rng.js';
import { TOTAL_WAVES } from '../game/Waves.js';
import {
  FIRST_WAGER_WAVE, POT_FEED, RESERVE_MULT,
  outcomeBands, payoutFor, potContribution, resolveLottery, stakeFor, wagerBlock, waveGross,
} from '../game/lottery.js';
import { Painter } from '../minigames/Painter.js';
import { isTypingTarget } from '../util/dom.js';
import { key, num } from './uikit.js';

const html = String.raw;
const TAU = Math.PI * 2;
/** Twelve o'clock, in Painter angles (+y up, so a quarter turn from +x). */
const TOP = Math.PI / 2;

/**
 * THE TIMELINE, in seconds from `open()`. Every number is a token-scale duration
 * (180/240/320 ms) or a multiple of one, and the shape is deliberate:
 *
 *   0.00  the veil fades in and the stake has ALREADY left the gold counter.
 *         The price is paid before the suspense; the order is not negotiable.
 *   0.20  the ring draws itself, arc by arc, longest first.
 *   0.50  the needle accelerates. Seven turns. Illegible on purpose — that is
 *         what earns the right to slow down afterwards.
 *   2.00  a long deceleration. The needle passes in front of every arc, and
 *         because Convergence sits immediately before twelve o'clock it is the
 *         last thing crossed before the needle comes to rest. That near-miss is
 *         geometry, not theatre: the needle really is over it.
 *   3.40  overshoot and settle, clamped so it can never cross into the wrong arc.
 *   3.62  the result.
 */
const T_RING = 0.20;
const T_SPIN = 0.50;
const T_ACCEL = 1.50;
const T_DECEL = 1.40;
const T_SETTLE = 0.22;
const T_REVEAL = T_SPIN + T_ACCEL + T_DECEL + T_SETTLE;   // 3.62
/** Whole turns before the needle starts hunting for `u`. */
const TURNS = 7;
/** Overshoot past the resting angle, in turns (4 degrees), before it settles. */
const OVERSHOOT = 4 / 360;

/**
 * How long the result card sits before it leaves on its own.
 *
 * Longer than the spec's 0.95 s, and that is a deliberate departure: 0.95 s is
 * not enough to read an outcome name, a multiplier, an amount AND the pot line,
 * and a card that leaves mid-sentence reads as a glitch. A loss is still the
 * shortest of the three — the point of a graceful loss is to be over — and every
 * one of them can be dismissed instantly with Escape, Enter, Space or a click,
 * so nobody is held.
 */
const HOLD_LOSS = 1.4;
const HOLD_WIN = 2.2;
const HOLD_POT = 3.4;

/** A stuck overlay would freeze the run. Nothing survives this long. */
const HARD_STOP = 30;

/** Keys that mean "now". Same set as the rite host, for the same reason. */
const COMMIT_KEYS = new Set(['Space', 'Enter', 'NumpadEnter']);

/** The hotkey. Chosen because it is free: Q/W/E/R/T/Y are the build bar's. */
const HOTKEY = 'KeyL';

/**
 * Why the button is dark, in the player's words.
 *
 * `reserve` is phrased as a rule of the world rather than as a refusal, and it
 * names the number, because "unavailable" with no reason is the kind of dead
 * control docs/PITFALLS.md rule 1 is about.
 */
const BLOCK_TEXT = {
  phase: 'The lot is drawn between waves',
  tooEarly: `The lot opens on wave ${FIRST_WAGER_WAVE}`,
  spent: 'The lot is spent for this wave',
  reserve: 'Reserve too thin — the lot asks double the stake',
};

export class Lottery {
  /**
   * @param {import('../game/Game.js').Game} game
   * @param {HTMLElement} root  #ui-root, same as every other overlay
   */
  constructor(game, root) {
    this.game = game;
    this.root = root;

    /**
     * The player's own pot. PERSONAL, NOT SHARED, and it has to be: gold in this
     * game is strictly per-player and strictly client-side (the server simulates
     * nothing, and `status` does not carry gold), so a room-wide pot would need
     * an authoritative server that does not exist. It is fed by this player's
     * stakes and paid to this player alone.
     */
    this._pot = 0;
    /** Books, for the conservation test: fed === paid + pot, always. */
    this._potFed = 0;
    this._potPaid = 0;
    /** The wave a stake has already been placed on, or null. One per prep. */
    this._wageredWave = null;

    /** @type {null | object} The decided draw. Written before the animation. */
    this._draw = null;
    this.isOpen = false;
    /** 'spin' | 'result' */
    this.mode = 'spin';
    this._t = 0;
    this._credited = false;
    this._goldShown = 0;
    this._potShown = 0;
    this._tickIdx = -1;
    this._centreSig = '';
    this._restorePhase = null;
    this._cssW = 0; this._cssH = 0; this._dpr = 0;
    this._railSig = '';
    this._railTop = 0;
    /** @type {Array<() => void>} Disposers for everything bound while open. */
    this._disposers = [];

    const bands = outcomeBands();

    root.insertAdjacentHTML('beforeend', html`
      <aside id="lot" aria-label="The Rite of Fortune">
        <div class="lot-inner">
          <header class="lot-head">
            <span class="lot-eyebrow">The Lot</span>
            <span class="lot-pot" id="lot-pot" title="Your pot — fed by every stake, paid on Convergence">
              <i>⬢</i><b id="lot-pot-num">0</b>
            </span>
          </header>
          <div class="lot-stake">
            <span>Stake</span><b id="lot-stake-num">0</b><u>gold</u>
          </div>
          <button type="button" class="lot-go" id="lot-go" data-act="invoke">
            <span class="lot-sigil">⟡</span><span id="lot-go-label">Invoke</span>${key('L', 'tight')}
          </button>
          <p class="lot-note" id="lot-note"></p>
          <details class="lot-table">
            <summary>Payout table</summary>
            <p class="lot-fine">${(POT_FEED * 100).toFixed(0)}% of every stake feeds your
              pot. Over a run the lot gives back less than it takes.</p>
            <ol>
              ${bands.map(({ o }) => html`
                <li data-out="${o.id}">
                  <i>${o.glyph}</i><span>${o.name}</span>
                  <em>${(o.p * 100).toFixed(1)}%</em>
                  <b>x${o.mult}${o.pot ? ' +pot' : ''}</b>
                </li>`).join('')}
            </ol>
          </details>
        </div>
      </aside>

      <div id="lotdraw" role="dialog" aria-modal="true" aria-labelledby="lotdraw-title" aria-hidden="true">
        <div class="ld-veil" data-act="dismiss"></div>
        <div class="ld-shell" tabindex="-1">
          <header class="ld-head">
            <span class="ld-eyebrow" id="lotdraw-eyebrow"></span>
            <h2 id="lotdraw-title">The Rite of Fortune</h2>
            <p class="ld-sub" id="lotdraw-sub"></p>
          </header>
          <div class="ld-stage" id="lotdraw-stage">
            <canvas id="lotdraw-canvas"></canvas>
            <!-- THE CENTRE READOUT IS DOM, NOT CANVAS, and that is not a
                 preference. Painter.text at a 0.7-world-unit size hands the
                 canvas a 0.72px font; Chrome's metrics quantise at that size and
                 the advance widths come back too small, so "15" rendered as a 1
                 and a 5 on top of each other. Caught in a screenshot. In the DOM
                 it gets --font-num with real tabular figures, which is the same
                 call MinigameHost made for its clock and for the same reason.
                 The arc labels stay on the canvas: they are small, they have to
                 sit at computed angles, and they render correctly. -->
            <div class="ld-centre" id="lotdraw-centre">
              <span id="lotdraw-centre-k">Pot</span>
              <b id="lotdraw-centre-v">0</b>
            </div>
            <div class="ld-result" id="lotdraw-result" hidden>
              <span class="lr-kicker" id="lotdraw-kicker"></span>
              <h3 class="lr-mult" id="lotdraw-mult"></h3>
              <div class="lr-gold"><b id="lotdraw-gold">0</b><u id="lotdraw-goldlabel">gold</u></div>
              <p class="lr-pot" id="lotdraw-potline"></p>
            </div>
          </div>
          <footer class="ld-foot">
            <span class="ld-hint" id="lotdraw-hint">${key('Esc', 'tight')} reveal now</span>
          </footer>
        </div>
      </div>`);

    const q = (sel) => root.querySelector(sel);
    this.$rail = q('#lot');
    this.$railPot = q('#lot-pot-num');
    this.$railStake = q('#lot-stake-num');
    this.$go = q('#lot-go');
    this.$goLabel = q('#lot-go-label');
    this.$note = q('#lot-note');
    this.$el = q('#lotdraw');
    this.$shell = q('#lotdraw .ld-shell');
    this.$canvas = q('#lotdraw-canvas');
    this.$eyebrow = q('#lotdraw-eyebrow');
    this.$sub = q('#lotdraw-sub');
    this.$centre = q('#lotdraw-centre');
    this.$centreV = q('#lotdraw-centre-v');
    this.$result = q('#lotdraw-result');
    this.$kicker = q('#lotdraw-kicker');
    this.$mult = q('#lotdraw-mult');
    this.$gold = q('#lotdraw-gold');
    this.$goldLabel = q('#lotdraw-goldlabel');
    this.$potline = q('#lotdraw-potline');
    this.$hint = q('#lotdraw-hint');

    this.painter = new Painter(this.$canvas.getContext('2d', { alpha: true }));
    this._bands = bands;
    this._palette = this.#readPalette();

    // Delegated, permanently: the rail seal is not modal and has no lifecycle.
    this.$rail.addEventListener('click', (e) => {
      if (e.target?.closest?.('[data-act="invoke"]')) this.invoke();
    });

    /**
     * The hotkey lives on WINDOW at the bubble phase on purpose. Every modal in
     * this game shields at document-capture and calls stopPropagation, so an
     * open rite, key sheet or lobby silently disarms this listener without any
     * of them having to know the lottery exists. The phase guard inside
     * `invoke()` is the belt to that pair of braces.
     */
    this._onHotkey = (e) => {
      if (e.code !== HOTKEY || isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (this.isOpen) return;
      e.preventDefault();
      this.invoke();
    };
    window.addEventListener('keydown', this._onHotkey);

    /**
     * The seal sits under #threat, whose height changes with the wave run-ahead.
     * Observed rather than polled, and read through offsetTop/offsetHeight rather
     * than getBoundingClientRect: #threat carries a translateX when collapsed
     * and another under body.codex-open, and a rect would fold those transforms
     * into a number that has nothing to do with vertical stacking.
     */
    this.$threat = root.querySelector('#threat');
    if (this.$threat && typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.#placeRail());
      this._ro.observe(this.$threat);
    }
    this.#placeRail();
    this.#refreshRail();
  }

  /** Live count of things that must be released. 0 whenever the draw is shut. */
  get listenerCount() { return this._disposers.length; }

  /** The player's pot, in gold. Read by the tests and by the end card one day. */
  get pot() { return this._pot; }

  /** Books for the conservation assertion. */
  get potBooks() { return { fed: this._potFed, paid: this._potPaid, held: this._pot }; }

  /** The wave currently being prepared. `state.wave` is the one just cleared. */
  get preparingWave() { return Math.min(TOTAL_WAVES, this.game.state.wave + 1); }

  /** The stake this prep is asking for. */
  get stake() { return stakeFor(this.preparingWave); }

  /** Why the wager is refused right now, or null. */
  get block() {
    return wagerBlock({
      phase: this.game.state.phase,
      gold: this.game.state.gold,
      wave: this.preparingWave,
      wageredWave: this._wageredWave,
    });
  }

  // ---- the wager ---------------------------------------------------------

  /**
   * Place the stake and open the draw. The player's whole interaction.
   *
   * @returns {boolean} true if a wager was actually placed.
   */
  invoke() {
    if (this.isOpen) return false;
    const why = this.block;
    if (why) {
      this.game.audio?.play('deny');
      this.game.hud?.warn?.(BLOCK_TEXT[why] ?? 'The lot is closed');
      return false;
    }
    return this.#wager(this.preparingWave);
  }

  /**
   * The dev panel's entry point, published in docs/MINIGAMES.md §10.
   *
   * Bypasses the phase, the wave floor and the one-per-prep rule, because the
   * point of a dev hook is to reach a state the schedule would make you play
   * twenty minutes for. It does NOT bypass the gold: a wager that pays out of an
   * empty bank would be a lie about the one thing this feature moves, and the
   * panel has a Gold button two rows up.
   */
  devOpen(wave) {
    if (this.isOpen) return false;
    const n = Math.max(1, Math.min(TOTAL_WAVES, Math.round(wave) || 1));
    if (this.game.state.gold < stakeFor(n)) {
      this.game.hud?.warn?.('Not enough gold for that stake');
      return false;
    }
    return this.#wager(n);
  }

  /**
   * THE TRANSACTION. Everything irreversible happens here, in this order, and
   * the order is the design:
   *
   *   1. the stake leaves the bank      — the price is paid before the suspense
   *   2. the pot is fed                 — a losing stake still grows something
   *   3. ONE rand() call, unconditional — the determinism contract, §8 of the spec
   *   4. the outcome is stored          — from here nothing can change it
   *
   * `rngFor(seed, 'lottery', wave)` indexes on the WAVE NUMBER and not on a
   * personal wager counter. A personal counter would guarantee something
   * stronger-sounding — equal wager counts, identical multiplier sequences — at
   * the price of making luck movable: a player who precomputes their stream
   * would advance the counter on cheap waves so the big multiplier lands on an
   * expensive one. With a global index the outcome and the price are welded
   * together, and skipping a wave skips a draw rather than banking it.
   */
  #wager(wave) {
    const stake = stakeFor(wave);
    if (!this.game.spendGold(stake, 'lottery')) return false;

    const fed = potContribution(stake);
    this._pot += fed;
    this._potFed += fed;
    const potBefore = this._pot - fed;

    // EXACTLY ONE CALL. Unconditional, outside every branch, and the generator
    // is discarded immediately so a later edit cannot quietly take a second.
    const u = rngFor(this.game.seed, 'lottery', wave)();
    const outcome = resolveLottery(u);
    const res = payoutFor(outcome, stake, this._pot);

    this._draw = {
      wave, stake, u, outcome,
      base: res.base,
      payout: res.payout,
      potPaid: res.potPaid,
      potBefore,
      potAfterFeed: this._pot,
      fed,
    };
    this._wageredWave = wave;
    this.#open();
    return true;
  }

  // ---- the overlay -------------------------------------------------------

  #open() {
    const d = this._draw;
    this.isOpen = true;
    this.mode = 'spin';
    this._t = 0;
    this._credited = false;
    this._goldShown = 0;
    this._potShown = d.potAfterFeed;
    this._tickIdx = -1;
    this._centreSig = '';
    this._cssW = 0; this._cssH = 0; this._dpr = 0;
    this._palette = this.#readPalette();
    // Cosmetic noise, seeded from the draw itself: no Math.random anywhere in
    // this feature, not even in the sparks. `u` is already a shared value, so
    // two clients on one seed get the same sparks as well as the same outcome.
    this._fx = mulberry32(Math.floor(d.u * 0xffffffff) ^ (d.wave * 0x9e3779b1));
    this._sparks = null;

    this.$eyebrow.textContent = `The lot · wave ${d.wave}`;
    this.$sub.textContent = `${num(d.stake)} gold staked`;
    this.$result.hidden = true;
    this.$el.classList.remove('resolved', 'win', 'loss', 'pot');
    this.$hint.hidden = false;
    this.$el.classList.add('open');
    this.$el.setAttribute('aria-hidden', 'false');

    // A decision about YOUR gold needs your board behind it. Same call
    // Game.startMinigame makes before a rite, and for the same reason: a full
    // veil over a tinted opponent's maze is incoherent, and the dock is folded
    // away under the spectate class anyway.
    this.game.exitSpectate?.('lottery');

    // Frozen so the prep clock cannot send the wave from behind the veil.
    this._restorePhase = this.game.state.phase;
    this.game.state.phase = 'lottery';

    this.#bind();
    // offsetWidth before focus, per docs/PITFALLS.md: focusing a node whose
    // visibility is still inherited from a hidden ancestor silently does
    // nothing, and then the keyboard shield has nothing to shield.
    void this.$shell.offsetWidth;
    this.$shell.focus({ preventScroll: true });
    this.game.audio?.play('select');
    this.#refreshRail();
  }

  /** Register a listener AND its disposer in one breath. Same as the rite host. */
  #hold(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  #bind() {
    /**
     * THE KEYBOARD SHIELD — capture, on document, exactly like the rite host's
     * and the HUD key sheet's, and for the incident documented at HUD's
     * `_onKeyShield`: with a full-bleed veil up and no shield, Space still sent
     * the next wave, P still toggled pause and 1-3 still changed the simulation
     * speed, all invisibly. Modified keys, function keys and typing targets pass
     * through untouched — never steal a browser shortcut, and F9 must still open
     * the dev panel from in here.
     */
    this.#hold(document, 'keydown', (e) => {
      if (!this.isOpen) return;
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^F\d/.test(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape' || COMMIT_KEYS.has(e.code)) this.#dismiss();
    }, true);
    this.#hold(document, 'keyup', (e) => {
      if (this.isOpen && !isTypingTarget(e) && !/^F\d/.test(e.code)) e.stopPropagation();
    }, true);

    this.#hold(this.$el, 'click', (e) => {
      // The veil and the shell both dismiss: there is nothing to click INSIDE
      // this dialog, so a click anywhere means "get on with it".
      void e;
      this.#dismiss();
    });

    /**
     * FOCUS LOSS RESOLVES, it does not suspend.
     *
     * The rite host suspends its clock because a rite is a test of skill and
     * time stolen by the operating system is a score stolen. A draw is a
     * transaction that has already happened; there is no skill to protect and
     * nothing to be robbed of. Suspending it would leave a paid-for result
     * sitting behind a hidden tab with the game phase frozen — a stalled run for
     * the sake of an animation nobody is watching.
     */
    this.#hold(window, 'blur', () => this.#reveal());
    this.#hold(window, 'pagehide', () => this.#reveal());
    this.#hold(document, 'visibilitychange', () => { if (document.hidden) this.#reveal(); });

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { this._cssW = 0; });
      ro.observe(this.$canvas);
      this._disposers.push(() => ro.disconnect());
    }
  }

  /** Escape, Enter, Space, or a click: reveal if spinning, close if revealed. */
  #dismiss() {
    if (this.mode === 'result') this.close();
    else this.#reveal();
  }

  /**
   * Close, release, restore. Safe to call twice — the `isOpen` guard is what
   * lets the auto-advance, the click and the key all race for it.
   *
   * It settles first, unconditionally. A close that skipped the credit would be
   * a stake taken and a payout never given, which is the single worst bug this
   * feature can have; there is no path out of this overlay that does not pay.
   */
  close() {
    if (!this.isOpen) return;
    this.#settle();
    this.isOpen = false;
    for (const dispose of this._disposers) dispose();
    this._disposers.length = 0;

    this.$el.classList.remove('open', 'resolved', 'win', 'loss', 'pot');
    this.$el.setAttribute('aria-hidden', 'true');
    this.$result.hidden = true;

    if (this._restorePhase !== null) {
      // Only put back what we took. If something else moved the phase while the
      // veil was up (nothing can, but this is the one assumption worth not
      // making) we leave it alone rather than resurrecting a stale state.
      if (this.game.state.phase === 'lottery') this.game.state.phase = this._restorePhase;
      this._restorePhase = null;
    }
    this._draw = null;
    this.#refreshRail();
  }

  /** Tear the whole surface out of the DOM. For HMR and for tests. */
  destroy() {
    this.close();
    window.removeEventListener('keydown', this._onHotkey);
    this._ro?.disconnect();
    this.$el.remove();
    this.$rail.remove();
  }

  // ---- resolution --------------------------------------------------------

  /**
   * Show the result. Idempotent; reachable from the timeline, from Escape, from
   * a click on the veil and from a blur, all of which can genuinely race.
   */
  #reveal() {
    if (!this.isOpen || this.mode === 'result') return;
    this.mode = 'result';
    this._t = Math.max(this._t, T_REVEAL);
    this.#settle();

    const d = this._draw;
    const won = d.outcome.mult >= 1;
    this.$kicker.textContent = `${d.outcome.glyph}  ${d.outcome.name}`;
    this.$mult.textContent = `x${d.outcome.mult}`;
    this.$gold.textContent = '0';
    this.$goldLabel.textContent = won ? 'gold won' : 'gold returned';
    this.$potline.textContent = d.outcome.pot
      ? `The pot breaks — ${num(d.potPaid)} gold poured out`
      : `Pot ${num(d.potBefore)} → ${num(d.potAfterFeed)}`;
    this.$result.hidden = false;
    this.$hint.hidden = true;
    this.$el.classList.add('resolved');
    this.$el.classList.toggle('win', won && !d.outcome.pot);
    this.$el.classList.toggle('pot', !!d.outcome.pot);
    // --ink-2, never --danger. Losing a wager is not an error, and the error
    // colour of this game stays reserved for a leak.
    this.$el.classList.toggle('loss', !won);
  }

  /**
   * THE ONE PLACE GOLD IS CREDITED.
   *
   * Guarded rather than trusted. Four paths reach here — the timeline, Escape, a
   * veil click, a blur — plus `close()`, which calls it defensively so that no
   * exit can drop a payout. A second credit would be silent, permanent and
   * unattributable, so it is made impossible rather than unlikely.
   */
  #settle() {
    if (this._credited || !this._draw) return;
    this._credited = true;
    const d = this._draw;

    if (d.potPaid > 0) {
      this._pot = Math.max(0, this._pot - d.potPaid);
      this._potPaid += d.potPaid;
    }
    this.game.addGold(d.payout, 'lottery');
    /**
     * NO CAMERA SHAKE, deliberately, and against the spec's 0.15 amplitude. The
     * board is behind a heavy veil for the whole draw, so `rig.addShake` would
     * spend real shake budget on something nobody can see while leaving the
     * thing they ARE looking at perfectly still. Same call MinigameHost made,
     * same reasoning, and the ring gets the impact instead (glow + sparks).
     *
     * `elementPick` rather than `victory` on a Convergence: `victory` is the
     * run-won stinger and hearing it mid-run reads as the game ending.
     */
    this.game.audio?.play(d.outcome.pot ? 'elementPick' : d.outcome.mult >= 1 ? 'waveClear' : 'sell');
  }

  // ---- the loop ----------------------------------------------------------

  /**
   * Driven from Game.frame at the VARIABLE rate, next to the rite host and for
   * the same reason: 'lottery' is a frozen phase, so the fixed-step block did
   * nothing this frame, and the draw must not run at 2x because the player left
   * the speed buttons on 2x.
   */
  update(dt) {
    this.#refreshRail();
    if (!this.isOpen) return;

    // Same clamp as Game.frame: a two-second stall must not replay as two
    // seconds of animation the player never saw.
    const raw = Math.min(Math.max(0, dt), 0.1);
    this._t += raw;

    if (this.mode === 'spin') {
      if (this._t >= T_REVEAL) this.#reveal();
    } else {
      this.#tweenNumbers(raw);
      const hold = this._draw?.outcome.pot ? HOLD_POT
        : this._draw?.outcome.mult >= 1 ? HOLD_WIN : HOLD_LOSS;
      if (this._t >= T_REVEAL + hold) { this.close(); return; }
    }

    // A frozen phase plus a stuck overlay is an unplayable run. Nothing here
    // takes ten seconds; if it has, something is wrong and the safe failure is
    // to pay the player and get out of their way.
    if (this._t > HARD_STOP) { this.close(); return; }

    this.#render();
  }

  /** The count-up. Presentation only — the gold was banked at #settle. */
  #tweenNumbers(dt) {
    const d = this._draw;
    if (!d) return;
    if (this._goldShown < d.payout) {
      const diff = d.payout - this._goldShown;
      this._goldShown = Math.min(d.payout, this._goldShown + Math.max(1, diff * Math.min(1, dt * 5)));
      this.$gold.textContent = num(this._goldShown);
    }
    // Convergence: the two numbers cross. The pot drains to zero in the middle
    // of the ring at the same time as the payout climbs, which is the only
    // moment in this feature that is allowed to take its time.
    if (d.potPaid > 0 && this._potShown > 0) {
      this._potShown = Math.max(0, this._potShown - Math.max(1, this._potShown * Math.min(1, dt * 4)));
    }
  }

  // ---- geometry ----------------------------------------------------------

  /**
   * How far the needle has travelled, in turns, at time `t`.
   *
   * Piecewise and integrated in closed form rather than stepped, so it is a pure
   * function of the clock: a dropped frame costs a frame of smoothness and never
   * a fraction of a turn. Quadratic ease in, quadratic ease out, and the peak
   * speed V is SOLVED so that the total distance lands exactly on `TURNS + u` —
   * the needle is not steered toward the answer, it is launched at it.
   *
   *   accel:  v = V(x)^2  over T_ACCEL  →  distance V*T_ACCEL/3
   *   decel:  v = V(1-x)^2 over T_DECEL →  distance V*T_DECEL/3
   *   D = V*(T_ACCEL + T_DECEL)/3
   */
  #travel(t) {
    const D = TURNS + this._draw.u;
    const V = (3 * D) / (T_ACCEL + T_DECEL);
    if (t <= T_SPIN) return 0;
    const a = t - T_SPIN;
    if (a < T_ACCEL) {
      const x = a / T_ACCEL;
      return (V * T_ACCEL * x * x * x) / 3;
    }
    const accelDist = (V * T_ACCEL) / 3;
    const b = a - T_ACCEL;
    if (b < T_DECEL) {
      const x = b / T_DECEL;
      const k = 1 - x;
      return accelDist + (V * T_DECEL * (1 - k * k * k)) / 3;
    }
    // Settle: overshoot past the resting angle and come back. Clamped to the
    // remaining span of the winning arc, so the flourish can never park the
    // needle — even for a frame — over an outcome that did not happen.
    const band = this._bands.find((x) => this._draw.u >= x.from && this._draw.u < x.to) ?? this._bands[0];
    const room = Math.max(0, (band.to - this._draw.u) * 0.5);
    const amp = Math.min(OVERSHOOT, room);
    const s = Math.min(1, (b - T_DECEL) / T_SETTLE);
    return D + amp * Math.sin(Math.PI * s) * (1 - s);
  }

  /** Which band a fraction of a turn falls in. */
  #bandAt(frac) {
    const f = frac - Math.floor(frac);
    for (let i = 0; i < this._bands.length; i++) if (f < this._bands[i].to) return i;
    return this._bands.length - 1;
  }

  // ---- rendering ---------------------------------------------------------

  /**
   * Canvas colours come from the stylesheet, not from this file.
   *
   * A canvas cannot resolve `var(--gold)`, so the tokens are read once per open
   * off the document element. That keeps the ring on the same palette as every
   * other surface and keeps this file free of hex literals, which is the actual
   * rule (ui.css §tokens) rather than "no strings that look like colours".
   */
  #readPalette() {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
    const tok = (name, fallback) => (cs?.getPropertyValue(name) || '').trim() || fallback;
    return {
      ink4: tok('--ink-4', '#4a5064'),
      ink3: tok('--ink-3', '#6d7488'),
      ink2: tok('--ink-2', '#a3a9bb'),
      ink: tok('--ink', '#e9ebf3'),
      gold: tok('--gold', '#e5bd79'),
      goldHi: tok('--gold-hi', '#f7dfae'),
      line: tok('--line-2', 'rgba(255,255,255,0.14)'),
    };
  }

  /**
   * The rarity gradient, and it is the only chromatic decision in this feature:
   * the rarer the outcome, the more golden its arc. A player learns the table by
   * watching the circle — the Ash arc is nearly half of it, the Geyser arc is a
   * scratch — without reading a single number.
   *
   * `--gold-dim` is deliberately NOT used here despite being the token the spec
   * named: it is `rgba(gold, 0.16)`, which is a fill for a button behind text and
   * is invisible as a 5-pixel stroke on a dark stage. Lode gets `--gold` at
   * reduced alpha instead — the same hue, dimmed by the painter, no new colour.
   */
  #arcStyle(id) {
    const p = this._palette;
    switch (id) {
      case 'ash': return { color: p.ink4, alpha: 1 };
      case 'shard': return { color: p.ink3, alpha: 1 };
      case 'vein': return { color: p.ink2, alpha: 1 };
      case 'lode': return { color: p.gold, alpha: 0.62 };
      case 'conv': return { color: p.gold, alpha: 1 };
      default: return { color: p.goldHi, alpha: 1 };
    }
  }

  #render() {
    const cvs = this.$canvas;
    const cssW = cvs.clientWidth;
    const cssH = cvs.clientHeight;
    if (cssW === 0 || cssH === 0) return;   // still transitioning in, or hidden
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cssW !== this._cssW || cssH !== this._cssH || dpr !== this._dpr) {
      this._cssW = cssW; this._cssH = cssH; this._dpr = dpr;
      cvs.width = Math.max(1, Math.round(cssW * dpr));
      cvs.height = Math.max(1, Math.round(cssH * dpr));
    }
    const g = this.painter;
    g.layout(cssW, cssH, dpr);
    g.clear();

    const d = this._draw;
    if (!d) return;
    const p = this._palette;
    const R = 3.05;
    const W = 0.30;

    // Arcs draw themselves in over T_RING, longest first, so the first thing the
    // eye gets is the shape of the odds.
    const grow = clamp01((this._t - T_RING) / 0.3);
    const travel = this.#travel(Math.min(this._t, T_REVEAL));
    const live = this.mode === 'spin';
    const restingBand = this.#bandAt(d.u);
    const hotBand = live ? this.#bandAt(travel) : restingBand;

    /**
     * THE RING RISES OUT OF THE WAY WHEN THE RESULT ARRIVES.
     *
     * The result card is bottom-anchored inside the stage — deliberately, so the
     * wheel that just stopped stays behind the number it produced — and at the
     * ring's spinning position the two collided: "x0.25" was printed across the
     * SHARD label. Lifting the whole figure by 0.85 world units over 320 ms hands
     * the bottom third of the stage to the card and keeps the wheel readable
     * above it. Caught in a screenshot; there is no test that could have.
     */
    const lift = live ? 0 : 0.85 * clamp01((this._t - T_REVEAL) / 0.32);
    const cy = lift;

    g.circle(0, cy, R, { stroke: p.line, width: 0.01 });

    for (let i = 0; i < this._bands.length; i++) {
      const b = this._bands[i];
      const st = this.#arcStyle(b.o.id);
      const pad = 0.004;
      const a0 = TOP - TAU * (b.from * grow) - pad;
      const a1 = TOP - TAU * (b.to * grow) + pad;
      if (a0 <= a1) continue;
      const lit = i === (live ? hotBand : restingBand);
      const dim = !live && !lit ? 0.18 : 1;
      /**
       * THE WINNER IS MARKED BY WIDTH, NOT BY BRIGHTNESS, and that is the whole
       * reason this is not a one-liner. The rarity gradient makes Ash the
       * DARKEST arc, so "light up the winner in its own colour" leaves the 46 %
       * outcome — the one a player sees most — as the least visible thing on the
       * screen at the exact moment it has to be identified. A stroke twice as
       * thick reads instantly and is independent of hue, so a loss is
       * unmistakable without being dressed up as a win.
       */
      const won = b.o.mult >= 1;
      const w = lit && !live ? W * (won ? 1.9 : 1.5) : W;
      g.save().alpha(st.alpha * dim);
      // The halo is for a WIN only. A losing arc lit up like a beacon is a
      // celebration of the player's loss, which is precisely the tone this
      // feature is supposed to avoid; the extra width is enough to identify it.
      if (lit) g.glow(st.color, live ? 0.35 : (won ? 0.9 : 0.2));
      g.arc(0, cy, R, a1, a0, st.color, w, 'butt');
      g.noGlow().restore();
    }

    // Labels, outside the ring, upright. Only the four common ones are labelled
    // in place — Geyser's arc is 1.8 degrees wide and a label on it would point
    // at nothing — so those two share a line under the ring. They fade out on
    // reveal: the table has done its teaching and the card is the subject now.
    const labelAlpha = live ? 1 : 1 - clamp01((this._t - T_REVEAL) / 0.28);
    if (grow >= 1 && labelAlpha > 0.02) this.#drawLabels(g, R, cy, labelAlpha);

    // The needle. Drawn last so nothing overlaps it.
    const ang = TOP - TAU * travel;
    const nx = Math.cos(ang), ny = Math.sin(ang);
    g.save().glow(p.goldHi, 0.5);
    g.line(nx * (R - W), cy + ny * (R - W), nx * (R + W * 0.9), cy + ny * (R + W * 0.9), p.goldHi, 0.07, 'round');
    g.noGlow().restore();
    // NO HUB DOT AT THE ORIGIN. There was one, and at a glance it read as a
    // rendering fault: it sits exactly on the centre readout, so "15" looked
    // like a 1 and a 5 printed on top of each other. The needle never travels
    // inward past the ring, so a hub was decorating an axle that does not exist.

    // The centre: the pot while spinning, the outcome once it has landed.
    this.#syncCentre(d);

    if (!live) this.#drawSparks(g, d, cy);

    // The tick. One per arc boundary crossed; the audio engine's own throttle
    // (AudioEngine SOUNDS.select.thr) is what keeps seven turns a second from
    // becoming a buzz, which is cheaper and steadier than rate-limiting here.
    if (live && this._t > T_SPIN) {
      const idx = Math.floor(travel) * this._bands.length + hotBand;
      if (this._tickIdx >= 0 && idx !== this._tickIdx) this.game.audio?.play('select');
      this._tickIdx = idx;
    }
  }

  #drawLabels(g, R, cy, alpha) {
    const p = this._palette;
    for (const b of this._bands) {
      if (b.o.p < 0.05) continue;
      const mid = TOP - TAU * ((b.from + b.to) / 2);
      const rx = Math.cos(mid) * (R + 0.62);
      const ry = cy + Math.sin(mid) * (R + 0.62);
      const style = this.#arcStyle(b.o.id);
      g.save().alpha(0.85 * alpha);
      g.text(b.o.name.toUpperCase(), rx, ry + 0.12, { size: 0.30, fill: style.color, tracking: 0.04 });
      g.text(`x${b.o.mult}`, rx, ry - 0.28, { size: 0.26, fill: p.ink4 });
      g.restore();
    }
    const rare = this._bands.filter((b) => b.o.p < 0.05).map((b) => `${b.o.glyph} ${b.o.name} x${b.o.mult}`);
    g.save().alpha(0.7 * alpha);
    g.text(rare.join('   ·   '), 0, -4.05, { size: 0.26, fill: p.gold, tracking: 0.05 });
    g.restore();
  }

  /**
   * The centre readout — DOM, driven from here so it stays in step with the ring.
   *
   * Written through a cached signature rather than every frame: this runs at the
   * display's refresh rate and the pot only changes once per draw. Only the
   * Convergence countdown actually moves, and it moves every frame on purpose.
   */
  #syncCentre(d) {
    /**
     * The centre says POT and nothing else.
     *
     * It used to show the winning glyph once the wheel stopped. Two problems, one
     * screenshot: a 46px filled circle is what "Ash" looks like, so a loss was
     * announced by a large gold blob in the middle of the screen; and the result
     * card one line below already carries the glyph AND the name AND the
     * multiplier. Saying it twice in two type sizes is not emphasis, it is noise.
     * On a Convergence the pot is still the subject, so it stays and drains.
     */
    const spinning = this.mode === 'spin';
    const off = !spinning && d.potPaid === 0;
    const v = num(spinning ? d.potAfterFeed : this._potShown);
    const sig = `${off}|${v}|${d.potPaid > 0}|${spinning}`;
    if (sig === this._centreSig) return;
    this._centreSig = sig;
    this.$centreV.textContent = v;
    this.$centre.classList.toggle('off', off);
    this.$centre.classList.toggle('breaking', d.potPaid > 0 && !spinning);
  }

  /**
   * Sparks, density proportional to the multiplier — a 1.5x is a brief spray, an
   * 8x fills the ring. Simulated from the clock rather than stepped, so they are
   * a pure function of `_t` and cannot drift, and seeded from the draw so they
   * are identical on two clients.
   */
  #drawSparks(g, d, cy = 0) {
    if (d.outcome.mult < 1) return;
    const n = Math.min(120, Math.round(10 * d.outcome.mult * (d.outcome.pot ? 2.5 : 1)));
    if (!this._sparks || this._sparks.length !== n) {
      this._sparks = Array.from({ length: n }, () => ({
        a: this._fx() * TAU,
        v: 1.4 + this._fx() * 3.2,
        s: 0.03 + this._fx() * 0.05,
        d: 0.6 + this._fx() * 0.9,
      }));
    }
    const age = Math.max(0, this._t - T_REVEAL);
    const p = this._palette;
    g.save().add();
    for (const sp of this._sparks) {
      const life = age / sp.d;
      if (life >= 1) continue;
      const r = 0.4 + sp.v * age;
      const x = Math.cos(sp.a) * r;
      const y = cy + Math.sin(sp.a) * r - 1.6 * age * age;
      g.alpha((1 - life) * 0.9);
      g.circle(x, y, sp.s, { fill: p.goldHi });
    }
    g.alpha(1).restore();
  }

  // ---- the rail seal -----------------------------------------------------

  /** Stack the seal under #threat, whose height depends on the run-ahead. */
  #placeRail() {
    const t = this.$threat;
    if (!t) return;
    const top = t.offsetTop + t.offsetHeight + 10;
    if (top === this._railTop) return;
    this._railTop = top;
    this.$rail.style.top = `${top}px`;
    // Published to CSS so the card can bound its own height against the dock.
    // The unfolded payout table is tall enough to reach it on a 900px viewport
    // when #threat is showing a boss wave with a full run-ahead — measured.
    this.$rail.style.setProperty('--lot-top', `${top}px`);
  }

  /**
   * Repaint the seal, guarded by a signature.
   *
   * Called every frame from `update`, so it does what `Threat.update` does: build
   * a short string out of everything visible and return early when it has not
   * moved. Nothing touches innerHTML in the hot path — the table below the fold
   * was written once, in the constructor.
   *
   * IT DOES NOT CALL #placeRail. That reads `offsetTop`/`offsetHeight` on
   * #threat, which forces a style-and-layout flush; doing it once per frame is a
   * synchronous reflow sixty times a second for a number that changes when a
   * wave clears. Placement is driven by the ResizeObserver on #threat instead —
   * observed, not polled, exactly as MinigameHost handles its canvas.
   */
  #refreshRail() {
    const s = this.game.state;
    const wave = this.preparingWave;
    const stake = stakeFor(wave);
    const why = this.block;
    // The seal stays up through its own draw: sliding the panel out from behind
    // its own veil is motion nobody asked for and nobody can see the point of.
    const show = (s.phase === 'prep' || (s.phase === 'lottery' && this.isOpen))
      && wave >= FIRST_WAGER_WAVE;

    const sig = `${show}|${stake}|${this._pot}|${why ?? ''}`;
    if (sig === this._railSig) return;
    this._railSig = sig;

    // A class and not `hidden`: the seal slides off the rail with the same
    // transition #threat uses, and `hidden` would make it teleport. `aria-hidden`
    // and `inert`-by-pointer-events are handled in the stylesheet.
    this.$rail.classList.toggle('up', show);
    this.$rail.setAttribute('aria-hidden', String(!show));
    this.$railStake.textContent = num(stake);
    this.$railPot.textContent = num(this._pot);
    this.$rail.classList.toggle('has-pot', this._pot > 0);

    const blocked = why !== null && why !== 'phase';
    this.$go.disabled = blocked;
    this.$go.classList.toggle('spent', why === 'spent');
    this.$goLabel.textContent = why === 'spent' ? 'Spent' : 'Invoke';
    this.$note.textContent = why && why !== 'phase' ? BLOCK_TEXT[why] : '';
    this.$note.classList.toggle('warn', why === 'reserve');
    this.$go.title = why === 'reserve'
      ? `Needs ${num(stake * RESERVE_MULT)} gold in hand for a ${num(stake)} stake`
      : `Stake ${num(stake)} — about ${Math.round(100 * stake / waveGross(wave))}% of what wave ${wave} pays`;
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
