import * as THREE from 'three';
import {
  ELEMENTS, ELEMENT_ORDER, PRIMALS, PRIMAL, hex, num, clamp, esc, PLACEMENT_TEXT,
  key, keyRow, SHORTCUTS,
} from './uikit.js';
import { isTypingTarget } from '../util/dom.js';
import { waveDef, TOTAL_WAVES } from '../game/Waves.js';
import { towerDef } from '../game/TowerDefs.js';
import { CREEP_TYPES } from '../game/Creeps.js';
import { BuildBar } from './BuildBar.js';
import { Picker } from './Picker.js';
import { Inspector } from './Inspector.js';
import { Threat } from './Threat.js';
import { publishTop } from './globalTop.js';

/**
 * DOM overlay HUD.
 *
 * Layout contract (Art Bible G10): the interface lives on the four edges —
 * a 54px status bar at the top, a threat rail on the left, the tower
 * inspector on the right, and a shallow build dock at the bottom. The
 * playable centre of the board is never covered by resting UI; only
 * player-invoked surfaces (tower table, element picker, end card) enter it.
 *
 * Everything that changes per-frame writes through cached nodes; nothing here
 * touches innerHTML in the hot path.
 */
export class HUD {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('ui-root');
    this.root.innerHTML = TEMPLATE;

    this.$ = (sel) => this.root.querySelector(sel);
    this.nodes = {
      gold: this.$('#stat-gold'),
      lives: this.$('#stat-lives'),
      wave: this.$('#stat-wave'),
      waveTotal: this.$('#stat-wave-total'),
      score: this.$('#stat-score'),
      livesBox: this.$('#lives-box'),
      goldBox: this.$('#gold-box'),
      toast: this.$('#toast'),
      announce: this.$('#announce'),
      speed: this.$('#speed-buttons'),
      float: this.$('#float-layer'),
      endcard: this.$('#endcard'),
      elements: this.$('#owned-elements'),
      pause: this.$('#pause-btn'),
      vignette: this.$('#damage-vignette'),
      placeHint: this.$('#place-hint'),
      airAlert: this.$('#air-alert'),
      held: this.$('#held-piece'),
      best: this.$('#stat-best'),
      pauseGlyph: this.$('#pause-btn .ib-glyph'),
      help: this.$('#help'),
      helpBtn: this.$('#help-btn'),
    };

    /** Personal best, injected by main.js from local storage. */
    this.best = 0;
    /** Global top scores, injected from the server when one is reachable. */
    this.leaderboard = [];
    this._heldSig = '';

    this.build = new BuildBar(game, this.root);
    this.picker = new Picker(game, this.root);
    this.inspector = new Inspector(game, this.root);
    this.threat = new Threat(game, this.root);

    this.floats = [];
    this._v = new THREE.Vector3();
    this._toastTimer = 0;
    this._announceTimer = 0;
    this._goldShown = game.state.gold;
    this._livesShown = game.state.lives;
    this._elSig = '';

    this.#wire();
    this.refreshTop();
    this.refreshBuildBar();
  }

  #wire() {
    this.nodes.speed.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => this.game.setSpeed(Number(b.dataset.speed)));
    });
    this.nodes.pause.addEventListener('click', () => {
      this.game.state.paused = !this.game.state.paused;
      this.refreshTop();
    });
    this.$('#restart-btn').addEventListener('click', () => window.location.reload());

    // ---- key sheet ------------------------------------------------------
    this.nodes.help.innerHTML = HELP_TEMPLATE;
    this.nodes.helpBtn.addEventListener('click', () => this.toggleHelp());
    // Any click that is not on the sheet itself dismisses it. The full-bleed
    // veil is what makes that safe: without it, "outside" means the board, and
    // dismissing the sheet would also queue a build on whatever tile was under
    // the cursor. The veil eats the click instead.
    this.nodes.help.addEventListener('click', (e) => {
      if (!e.target.closest('.help-sheet') || e.target.closest('.help-close')) this.setHelp(false);
    });

    /**
     * THE MODAL SHIELD — what `aria-modal="true"` actually costs.
     *
     * #help declares role="dialog" aria-modal="true", traps Tab, takes focus and
     * lays a full-bleed veil that eats every click. All of that was true for the
     * MOUSE and none of it was true for the keyboard: this listener consumed
     * H, ?, Escape and Tab and returned, so BuildBar's window listener and
     * Game.js's switch went on running behind the veil. Measured with the sheet
     * open and focus on .help-close: Space sent wave 1 and moved state.phase
     * from 'prep' to 'combat', P un-paused, 3 set the speed, Q armed a Fire
     * Tower — and NONE of it was visible, because the veil (z-index 44) covers
     * #held-piece and the dock. Sending a wave early is irreversible. The panel
     * built to MAKE THE SHORTCUTS OBVIOUS was the one panel that fired them
     * while you were reading it.
     *
     * Capture on document, exactly like Lobby.js's shield and for the same
     * reason. A `stopImmediatePropagation` from the listener below cannot work:
     * BuildBar is constructed BEFORE HUD.#wire runs, so its window listener is
     * registered first and has already fired by the time this one is reached.
     * Capture on document precedes every bubble-phase listener on window
     * whatever the order they were added in.
     *
     * WHAT STILL GETS THROUGH, and the line the list is drawn on: keys that only
     * decide WHICH REFERENCE PANEL IS ON SCREEN. H and ? toggle this sheet, Esc
     * closes it, Tab is its own focus trap, and F swaps it for the Tower Table —
     * which the sheet itself advertises two rows above, and which BuildBar.
     * setCodex already resolves by closing this panel, so the two can never
     * share the screen. A cap that promises a dead key is worse than no cap.
     * Everything else is swallowed, INCLUDING its default action, because those
     * keys spend gold, sell towers and send waves. Space would also scroll the
     * veil.
     */
    this._onKeyShield = (e) => {
      if (!this.helpOpen) return;
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyH' || e.key === '?' || e.code === 'Escape'
        || e.key === 'Tab' || e.code === 'KeyF') return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    document.addEventListener('keydown', this._onKeyShield, true);

    /**
     * The sheet's own key listener.
     *
     * Deliberately a fourth listener rather than a case in Game.js's switch:
     * Game owns the simulation's keys, BuildBar owns the dock's, CameraRig owns
     * the camera's, and none of them may reach into a panel. The typing guard is
     * the shared `isTypingTarget` (util/dom.js) rather than a fifth private copy of
     * `instanceof HTMLInputElement`: this is the first of the four listeners to
     * preventDefault a PRINTABLE letter, so it is the first that would eat a
     * keystroke out of a textarea nobody has written yet.
     *
     * ESCAPE IS CONSUMED WHEN THE SHEET IS OPEN. It did not used to be, and two
     * strings on screen at the same moment each promised the whole key: the
     * sheet's footer says "Esc closes it" and the #held-piece chip says "Esc or
     * right-click to cancel". One press did both — closed the sheet AND dropped
     * the piece — and the sheet is precisely the surface a player opens WHILE
     * holding something, to check a key before placing it. First Escape closes
     * the panel, second Escape drops the piece.
     */
    window.addEventListener('keydown', (e) => {
      if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      // `?` is the key everyone tries first and it is Shift+/ on a US layout,
      // Shift+, on a French one — a physical code cannot describe it, so this is
      // the one place a `key` test is the correct test. `KeyH` is the physical
      // fallback that works on every layout.
      if (e.code === 'KeyH' || e.key === '?') {
        e.preventDefault();
        this.toggleHelp();
        return;
      }
      if (!this.helpOpen) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        // stopImmediatePropagation, NOT stopPropagation: Game.js's switch is a
        // second listener on the SAME target (window), and stopPropagation only
        // stops other NODES. It has to be this listener that runs first, which
        // it does — Game's constructor is `this.hud = new HUD(this)` and then
        // `#wirePointer()`, so HUD (and BuildBar, built inside HUD) register
        // ahead of it. That ordering is a real dependency and it is asserted, not
        // assumed: tests/e2e/help.spec.js presses Escape with a piece in hand and
        // requires the piece to survive the first press.
        e.stopImmediatePropagation();
        this.setHelp(false);
        return;
      }
      // The Tab trap `aria-modal="true"` promises. Without it the attribute was a
      // lie: measured, six Tabs from the open sheet walked focus onto the three
      // speed buttons, #pause-btn, #restart-btn and #help-btn — all behind the
      // veil, all Space/Enter-activatable, and #restart-btn reloads the page. A
      // keyboard player reading the shortcut sheet could destroy their own run
      // with Tab x5 + Enter. Lobby.js solves the identical problem the identical
      // way (its #onKey Tab trap); this is that pattern, minus the ring, because
      // the sheet has exactly one focusable child.
      if (e.key === 'Tab') {
        e.preventDefault();
        this.nodes.help.querySelector('.help-close')?.focus();
      }
    });
  }

  // ---- key sheet ---------------------------------------------------------

  get helpOpen() { return this.nodes.help.classList.contains('open'); }

  toggleHelp() { this.setHelp(!this.helpOpen); }
  closeHelp() { this.setHelp(false); }

  setHelp(open) {
    // A MODAL THAT DEMANDS AN ANSWER OUTRANKS A REFERENCE SHEET.
    //
    // The comment over #help in ui.css claimed the stack put it "under the
    // tooltip (45) and the end card (50-ish)". Measured, #endcard is z-index 40
    // and #picker is 30 — so the sheet went OVER both, and its veil swallowed
    // their clicks: after a defeat, H put the sheet on top of the end card and
    // `document.elementFromPoint` at the centre of "Play again" returned
    // .help-cols. Same during the wave-1 element offer, which is a forced
    // choice. Recoverable (Esc / H / a click outside) but it is a reference
    // panel blocking a decision panel.
    //
    // Refusing the open is the half that was missing: showEnd() has always
    // closed the sheet on the way in, so the other direction was the asymmetry.
    // The z-index is deliberately NOT the fix — raising #endcard past 44 would
    // leave the picker, and PITFALLS §10 is exactly about one file asserting
    // another file's constant.
    if (open && (this.nodes.endcard.classList.contains('show') || this.picker.open)) return;
    // Two full-bleed sheets at once is one too many, and the codex is the one
    // with an owner: it stays the surface you were reading, this one steps back.
    if (open) this.build.setCodex(false);
    const was = this.helpOpen;
    this.nodes.help.classList.toggle('open', open);
    this.nodes.help.setAttribute('aria-hidden', String(!open));
    this.nodes.helpBtn.classList.toggle('active', open);
    this.nodes.helpBtn.setAttribute('aria-expanded', String(open));

    // The other half of the modality promise (see the Tab trap in #wire): put
    // focus INSIDE the dialog on the way in and give it back on the way out.
    // Only on a real transition — setHelp(false) runs on every codex open, and
    // stealing focus back to #help-btn from wherever the player actually is
    // would be its own bug.
    if (open && !was) {
      // Flush the style change first. #help is `visibility: hidden` when closed,
      // and focus() consults the RENDERED state: called in the same task as the
      // class toggle it sees the stale `hidden` and silently does nothing, so
      // focus stayed on <body> and the Tab trap had nothing to trap. Reading
      // offsetWidth forces the recalc, same trick as pulseLives.
      void this.nodes.help.offsetWidth;
      this.nodes.help.querySelector('.help-close')?.focus();
    } else if (!open && was) {
      // ALWAYS the button that owns the panel, never "wherever focus was".
      //
      // Restoring the previous element is the textbook move and it is wrong
      // here: the sheet is opened by a GLOBAL shortcut, so "the previous
      // element" is usually <body> (i.e. nowhere, which leaves the next Tab
      // starting from the top of the page) or a leftover control on a panel
      // that has since been dismissed — measured, a sheet opened just after the
      // wave-1 element offer handed focus back to a .pcard behind a closed
      // picker, and neither `isConnected` nor `checkVisibility` reliably called
      // that one dead. #help-btn is always rendered, always focusable, and is
      // the control the panel belongs to, so it is both the safe answer and the
      // discoverable one.
      this.nodes.helpBtn.focus();
    }
  }

  // ---- top bar ---------------------------------------------------------

  refreshTop() {
    const s = this.game.state;

    this.nodes.lives.textContent = Math.max(0, s.lives);
    this.nodes.livesBox.classList.toggle('critical', s.lives <= 10);
    this.nodes.wave.textContent = Math.max(1, s.wave);
    this.nodes.waveTotal.textContent = `/ ${TOTAL_WAVES}`;
    this.nodes.score.textContent = num(s.score);

    this.nodes.speed.querySelectorAll('button').forEach((b) => {
      const on = Number(b.dataset.speed) === s.speed;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    this.nodes.pause.classList.toggle('paused', s.paused);
    // The GLYPH node, not the button: the button also carries its `P` key cap
    // and this runs every frame, so writing innerHTML on the button would delete
    // the cap on the first tick and nobody would ever see it.
    this.nodes.pauseGlyph.textContent = s.paused ? '▶' : '❚❚';
    this.nodes.pause.setAttribute('aria-label', s.paused ? 'Resume' : 'Pause');

    const want = s.elements.join(',');
    if (this._elSig !== want) {
      this._elSig = want;
      const counts = new Map();
      for (const id of s.elements) counts.set(id, (counts.get(id) ?? 0) + 1);
      // The persistent 1/3 - 2/3 - 3/3 readout. The dock rail is the actionable
      // surface; this is the one that is always on screen, so the stack count is
      // legible from the top bar without opening anything.
      this.nodes.elements.innerHTML = ELEMENT_ORDER.map((id) => {
        const e = ELEMENTS[id];
        const n = counts.get(id) ?? 0;
        const ready = n >= PRIMAL.stacksRequired;
        const title = !n ? `${e.name} — not bound`
          : ready ? `${e.name} ×${n} — ${PRIMALS[id].name} unlocked`
          : `${e.name} ×${n} — ${PRIMAL.stacksRequired - n} more for ${PRIMALS[id].name}`;
        return `<span class="el-pip${n ? ' on' : ''}${ready ? ' primal-ready' : ''}" style="--c:${hex(e.color)}"
                  title="${esc(title)}" aria-label="${esc(title)}">
          ${e.glyph}${n > 1 ? `<i>${n}</i>` : ''}</span>`;
      }).join('');
    }
  }

  pulseLives() {
    const b = this.nodes.livesBox;
    b.classList.remove('hit');
    void b.offsetWidth;
    b.classList.add('hit');
    const v = this.nodes.vignette;
    v.classList.remove('flash');
    void v.offsetWidth;
    v.classList.add('flash');
  }

  // ---- build bar -------------------------------------------------------

  refreshBuildBar() { this.build.refresh(); }

  // ---- inspector -------------------------------------------------------

  openInspector(t) { this.inspector.show(t); }
  closeInspector() { this.inspector.hide(); }

  /**
   * Open the morph sheet on a tower id. The seam for the `M` hotkey: Game knows
   * tower ids and nothing about panels, Inspector knows panels and is handed
   * tower objects, so the id -> object resolution belongs here alongside
   * openInspector. Silently does nothing on a stale id or an inert block.
   */
  openMorph(id) {
    const t = this.game.towers.byId(id);
    if (t) this.inspector.showMorph(t);
  }

  // ---- element picker --------------------------------------------------

  openElementPicker() { this.picker.show(); }
  closeElementPicker() { this.picker.hide(); }

  // ---- transient messaging ---------------------------------------------

  /**
   * The placement hint that rides next to the cursor while a tower is queued.
   *
   * This exists because the only feedback for an illegal placement used to be a
   * red pad under the cursor plus a toast that appeared 250px away AFTER a click
   * was refused — so the player learned the rule by being denied, one click at a
   * time. Naming the problem before the click, at the cursor, is the whole point.
   *
   * Silent on the valid case: a hint that is always on stops being read, and the
   * green pad already says yes. `reason === null` hides it entirely.
   *
   * `label` overrides the canned headline. Only the primal commit hint uses it,
   * because that headline names an element and a stack count that PLACEMENT_TEXT
   * cannot know. It is part of the cache signature or the panel would keep the
   * first element's text after the player queues a different primal.
   */
  showPlacementHint(reason, pointer, label = null) {
    const el = this.nodes.placeHint;
    if (!reason || reason === 'valid') {
      el.classList.remove('on');
      this._hintFor = null;
      return;
    }
    const t = PLACEMENT_TEXT[reason] ?? PLACEMENT_TEXT.occupied;
    const sig = label ? `${reason}:${label}` : reason;
    if (this._hintFor !== sig) {
      this._hintFor = sig;
      el.className = `on h-${t.tone}`;
      el.innerHTML = `<b>${esc(label ?? t.label)}</b>${t.hint ? `<i>${esc(t.hint)}</i>` : ''}`;
    }
    if (pointer) {
      // Offset up-right of the cursor, then flipped near the right edge so the
      // panel never runs off screen and never sits under the cursor itself.
      const w = el.offsetWidth || 150;
      const flip = pointer.x + 22 + w > window.innerWidth;
      el.style.transform =
        `translate(${Math.round(flip ? pointer.x - 18 - w : pointer.x + 22)}px, ${Math.round(pointer.y - 14)}px)`;
    }
  }

  warn(msg, tone = 'warn') {
    this.nodes.toast.className = `t-${tone}`;
    this.nodes.toast.textContent = msg;
    this.nodes.toast.classList.add('show');
    this._toastTimer = 1.9;
  }

  announceWave(def) {
    const t = CREEP_TYPES[def.type];
    this.nodes.announce.innerHTML = `
      <span class="an-rule"></span>
      <span class="an-mid">
        <span class="an-kicker">${def.isBoss ? 'Boss wave' : 'Wave'}</span>
        <span class="an-wave">${String(def.n).padStart(2, '0')}</span>
        <span class="an-type">${def.count} × ${t.name}${t.flying ? ' · flying' : ''}</span>
      </span>
      <span class="an-rule"></span>`;
    this.nodes.announce.classList.toggle('boss', !!def.isBoss);
    this.nodes.announce.classList.remove('show');
    void this.nodes.announce.offsetWidth;
    this.nodes.announce.classList.add('show');
    this._announceTimer = 2.6;
  }

  /**
   * The standing air-wave banner. `n` is the wave that flies, or 0 to clear.
   *
   * Separate from `warn()` on purpose: a toast is a moment and this is a
   * condition. It stays up for the whole build phase, which is the window in
   * which the player can still do something about it.
   */
  setAirAlert(n) {
    const el = this.nodes.airAlert;
    if (!n) { el.classList.remove('on'); this._airFor = 0; return; }
    if (this._airFor !== n) {
      this._airFor = n;
      el.innerHTML = `<b>✈ Air wave incoming</b><i>Wave ${n} flies — make sure it is covered</i>`;
    }
    el.classList.add('on');
  }

  /** Personal best score, shown in the status bar and on the end card. */
  setBest(score) {
    this.best = Math.max(0, Math.round(score) || 0);
    this.nodes.best.textContent = this.best ? num(this.best) : '—';
  }

  /**
   * Global top scores from the server: [{ name, score, wave }].
   *
   * Also republished on the shared feed, because the lobby shows the same board
   * before the run and main.js routes the transport to exactly this method. See
   * the docblock in globalTop.js for why the lobby cannot simply be handed a
   * callback.
   */
  setLeaderboard(list) {
    this.leaderboard = Array.isArray(list) ? list : [];
    publishTop(this.leaderboard);
  }

  /**
   * "You are holding a piece" — the missing confirmation for a dock click.
   *
   * Selection used to be a 1px border change on a card at the bottom of the
   * screen while the player's eyes were on the board, so the only feedback that
   * a click registered arrived when a tower appeared (or didn't). This is a chip
   * in the player's field of view that names what is in hand and how to drop it.
   *
   * Driven from update() off game state rather than from the six call sites that
   * can change a selection, so it cannot go stale when one of them is missed.
   */
  #syncHeld() {
    const g = this.game;
    const el = this.nodes.held;
    const held = g.selectedTower !== null ? g.towers.byId(g.selectedTower) : null;
    const arming = held && held.def.kind === 'inert';
    const buildKey = g.selectedBuild;
    const sig = arming ? `arm:${held.id}` : buildKey ? `build:${buildKey}` : '';
    if (sig === this._heldSig) return;
    this._heldSig = sig;

    if (!sig) { el.classList.remove('on'); return; }
    if (arming) {
      el.style.setProperty('--c', hex(held.def.color));
      el.innerHTML = `<span class="hp-glyph">${held.def.glyph}</span>
        <span class="hp-text"><b>Foundation selected</b>
        <i>Click any tower in the bar below to arm it — discounted, or ${key('Esc')} to let it be</i></span>`;
    } else {
      const def = towerDef(buildKey);
      if (!def) { el.classList.remove('on'); return; }
      el.style.setProperty('--c', hex(def.color));
      // CANCEL_HINT names two ways out because the chip is the only place either
      // is written down. Right-click is the neighbouring change in Game.js's
      // pointer wiring (button 2, below the 5px drag threshold, so it does not
      // fight CameraRig's orbit); if that ever comes back out, this string is
      // the one line to edit.
      el.innerHTML = `<span class="hp-glyph">${def.glyph}</span>
        <span class="hp-text"><b>${esc(def.name)} in hand</b>
        <i>Click the board to place &nbsp;·&nbsp; ${key('Esc')} or right-click to cancel</i></span>`;
    }
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  announceInterest(gold) { if (gold > 0) this.warn(`Interest banked · +${num(gold)} gold`, 'good'); }
  announceBonus(gold) { this.warn(`Early send bonus · +${num(gold)} gold`, 'good'); }

  /**
   * Fold the build/inspect surfaces away while another player's board is on
   * screen. A dock that offers to build on someone else's maze is a lie, and
   * every click it accepts would be refused by a Game that is not looking.
   *
   * A class on the root, not per-panel state: each of those panels owns its own
   * visibility for its own reasons (the codex, the inspector's selection, the
   * threat rail's collapse), and reaching into four of them from here would mean
   * restoring four things correctly on the way out.
   */
  setSpectating(on) {
    this.root.classList.toggle('spectating', !!on);
    // The two full-bleed panels are the exception to the class-only rule above,
    // and the codex is here because leaving it out cost an Escape press. The
    // .spectating rule in spectate.css takes #codex to opacity 0 and leaves
    // BuildBar.codexOpen true, so BuildBar's Escape branch — which consumes the
    // event with stopImmediatePropagation, and is registered BEFORE Game's
    // window listener — went on closing an already-invisible panel. Measured:
    // open the Tower Table, click a scoreboard row to spectate, press Escape,
    // and nothing happens on screen while the SpectateBar says "Back to your
    // board [Esc]". It took two presses. Closing it here restores one.
    if (on) { this.showPlacementHint(null); this.setHelp(false); this.build.setCodex(false); }
  }

  floatText(x, y, z, text, color) {
    // Your own +42 gold labels must not float over someone else's board. The
    // local simulation keeps producing them the whole time you are watching.
    if (this.game.spectating) return;
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = text;
    el.style.color = color;
    this.nodes.float.appendChild(el);
    this.floats.push({ el, pos: new THREE.Vector3(x, y, z), life: 1.1, max: 1.1 });
    if (this.floats.length > 60) this.floats.shift().el.remove();
  }

  showEnd(won) {
    const s = this.game.state;
    // The two reference surfaces step aside for the result. This used to happen
    // by accident for the key sheet — HUD.update closed it on every non-prep
    // frame — and that accident was the blocker fixed in this round, so the two
    // panels now stand down HERE, where the reason is "the run is over" rather
    // than "the phase changed". Without it a full-bleed sheet would sit under the
    // end card with nothing but a z-index between them.
    this.setHelp(false);
    this.build.setCodex(false);
    // `best` is whatever was loaded at boot, so a run that beat it is a new
    // record even though the store is written by main.js after this renders.
    const record = s.score > this.best;
    const board = this.leaderboard.slice(0, 5);
    this.nodes.endcard.innerHTML = `
      <div class="end-inner ${won ? 'win' : 'lose'}">
        <span class="end-kicker">${won ? 'Convergence complete' : 'The convergence fails'}</span>
        <h1>${won ? 'The Elements Hold' : 'The Line Is Broken'}</h1>
        <p>${won ? `All ${TOTAL_WAVES} waves repelled.` : `You fell on wave ${s.wave} of ${TOTAL_WAVES}.`}</p>
        <div class="end-best ${record ? 'record' : ''}">
          ${record
            ? `<b>New personal best</b><span>${num(s.score)} · previous ${this.best ? num(this.best) : 'none'}</span>`
            : `<b>Personal best</b><span>${this.best ? num(this.best) : '—'}</span>`}
        </div>
        ${board.length ? `<div class="end-board">
          <u>Global top ${board.length}</u>
          <ol>${board.map((p) => `<li><span>${esc(String(p.name ?? '?'))}</span><b>${num(p.score)}</b><i>wave ${num(p.wave)}</i></li>`).join('')}</ol>
        </div>` : ''}
        <div class="end-stats">
          <div><b>${num(s.score)}</b><span>Score</span></div>
          <div><b>${num(s.killed)}</b><span>Kills</span></div>
          <div><b>${num(s.leaked)}</b><span>Leaked</span></div>
          <div><b>${this.game.towers.towers.length}</b><span>Towers</span></div>
          <div><b>${new Set(s.elements).size}</b><span>Elements</span></div>
        </div>
        <button id="end-again">Play again</button>
      </div>`;
    this.nodes.endcard.classList.add('show');
    this.nodes.endcard.querySelector('#end-again')
      .addEventListener('click', () => window.location.reload());
  }

  // ---- per-frame -------------------------------------------------------

  update(dt) {
    const s = this.game.state;
    this.refreshTop();
    this.refreshBuildBar();
    this.threat.update();
    this.inspector.tick();
    this.#syncHeld();

    // Gold counts up rather than jumping — the single cheapest way to make an
    // economy feel like it has weight.
    const target = Math.floor(s.gold);
    if (this._goldShown !== target) {
      const diff = target - this._goldShown;
      const step = Math.max(1, Math.abs(diff) * Math.min(1, dt * 9));
      this._goldShown += Math.sign(diff) * Math.min(Math.abs(diff), step);
      const shown = Math.round(this._goldShown);
      this.nodes.gold.textContent = num(shown);
      this.nodes.goldBox.classList.toggle('rising', diff > 0);
      this.nodes.goldBox.classList.toggle('falling', diff < 0);
    } else {
      this.nodes.goldBox.classList.remove('rising', 'falling');
    }

    const prep = s.phase === 'prep';
    this.build.setPrep(prep, prep ? Math.round(s.prepTimer * 2) : 0);

    // NO PHASE GUARD HERE, AND THAT IS THE FIX FOR A SHIPPED BLOCKER.
    //
    // This used to close the sheet on every frame whose phase was not prep /
    // lobby / pickElement, on the theory that it is a between-waves surface.
    // `combat` is where a run spends most of its time, so during a wave H and
    // the ? button both put the sheet up for exactly one frame and then tore it
    // down again: measured `open` immediately, `false` 120ms later. That does
    // not read as a refusal, it reads as a crash — and it made the panel built
    // to answer "the shortcuts are not visible enough" unreachable for most of
    // the game. The codex (F) has never had such a guard and stays up through a
    // wave, so the two reference surfaces disagreed as well.
    //
    // A player who opens a full-bleed sheet mid-fight asked for it and has three
    // ways out (H, Escape, a click anywhere outside). Taking the decision off
    // them one frame later is the worse of the two failures.

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.nodes.toast.classList.remove('show');
    }
    if (this._announceTimer > 0) {
      this._announceTimer -= dt;
      if (this._announceTimer <= 0) this.nodes.announce.classList.remove('show');
    }

    this.#updateFloats(dt);
  }

  #updateFloats(dt) {
    const cam = this.game.camera;
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.life -= dt;
      if (f.life <= 0) { f.el.remove(); this.floats.splice(i, 1); continue; }
      f.pos.y += dt * 1.4;
      this._v.copy(f.pos).project(cam);
      const x = (this._v.x * 0.5 + 0.5) * w;
      const y = (-this._v.y * 0.5 + 0.5) * h;
      const t = f.life / f.max;
      f.el.style.transform = `translate(-50%,-50%) translate(${x}px, ${y}px) scale(${0.85 + t * 0.25})`;
      f.el.style.opacity = String(Math.min(1, t * 2.2));
      f.el.style.display = this._v.z > 1 ? 'none' : '';
    }
  }
}

const TEMPLATE = /* html */`
  <div id="float-layer"></div>
  <div id="damage-vignette" aria-hidden="true"></div>
  <div id="place-hint" role="status" aria-live="polite"></div>
  <div id="air-alert" role="status" aria-live="polite"></div>
  <div id="held-piece" role="status" aria-live="polite"></div>

  <header id="topbar">
    <div class="brand">
      <span class="brand-mark">◈</span>
      <span class="brand-name">Element<b>TD</b></span>
      <span class="brand-sub">Convergence</span>
    </div>

    <div class="stats" role="status" aria-live="off">
      <div class="stat gold" id="gold-box">
        <span class="stat-k">Gold</span>
        <b id="stat-gold" class="stat-v">0</b>
      </div>
      <div class="stat lives" id="lives-box">
        <span class="stat-k">Lives</span>
        <b id="stat-lives" class="stat-v">0</b>
      </div>
      <div class="stat">
        <span class="stat-k">Wave</span>
        <b class="stat-v"><span id="stat-wave">1</span><em id="stat-wave-total">/ 50</em></b>
      </div>
      <div class="stat">
        <span class="stat-k">Score</span>
        <b id="stat-score" class="stat-v">0</b>
      </div>
      <div class="stat best">
        <span class="stat-k">Best</span>
        <b id="stat-best" class="stat-v">—</b>
      </div>
    </div>

    <div class="controls">
      <div id="owned-elements" class="pips" aria-label="Bound elements"></div>
      <!-- The digit IS the key, so it wears the cap instead of being repeated
           beside one: the button reads "[1]×" and the cap is what says "this is
           on your keyboard". Same trick would not work on the pause button,
           whose glyph has no letter in it. -->
      <div id="speed-buttons" role="group" aria-label="Game speed">
        <button data-speed="1" class="active" aria-pressed="true" aria-keyshortcuts="1" title="Normal speed · key 1">${key('1', 'tight')}×</button>
        <button data-speed="2" aria-pressed="false" aria-keyshortcuts="2" title="Double speed · key 2">${key('2', 'tight')}×</button>
        <button data-speed="3" aria-pressed="false" aria-keyshortcuts="3" title="Triple speed · key 3">${key('3', 'tight')}×</button>
      </div>
      <button id="pause-btn" class="icon-btn keyed" aria-label="Pause" aria-keyshortcuts="P" title="Pause · key P">
        <span class="ib-glyph">❚❚</span>${key('P')}
      </button>
      <button id="restart-btn" class="icon-btn" aria-label="Restart run" title="Restart this run">⟳</button>
      <button id="help-btn" class="icon-btn keyed" aria-label="Keyboard shortcuts"
              aria-keyshortcuts="H" aria-expanded="false" aria-controls="help" title="Every shortcut · key H">
        <span class="ib-glyph">?</span>${key('H')}
      </button>
    </div>
  </header>

  <div id="announce" aria-live="polite"></div>
  <div id="toast" role="status"></div>
  <div id="help" aria-hidden="true"></div>
  <div id="endcard"></div>
`;

/**
 * The key sheet.
 *
 * Built once from SHORTCUTS and never re-rendered — the keyboard does not
 * change during a run. It is a player-invoked surface, so it is allowed into
 * the playable centre (same licence as the tower table and the element picker),
 * and it takes a full-bleed veil for one reason: an "outside click" that lands
 * on the board would otherwise place a tower on the way out.
 */
const HELP_TEMPLATE = /* html */`
  <div class="help-veil" aria-hidden="true"></div>
  <section class="help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-title">
    <header class="help-head">
      <div>
        <span class="legend">Controls</span>
        <h3 id="help-title">Every key on the board</h3>
      </div>
      <button class="help-close" aria-label="Close (Escape)">✕</button>
    </header>
    <div class="help-cols">
      ${SHORTCUTS.map((g) => `<div class="help-group">
        <div class="legend">${esc(g.title)}</div>
        <ul>
          ${g.rows.map((r) => `<li${r.wide ? ' class="wide"' : ''}>
            <span class="hk-keys">${keyRow(r.keys)}</span>
            <span class="hk-label">${esc(r.label)}${r.note ? `<i>${esc(r.note)}</i>` : ''}</span>
          </li>`).join('')}
        </ul>
      </div>`).join('')}
    </div>
    <footer class="help-foot">
      ${key('H')} opens and closes this sheet &nbsp;·&nbsp; ${key('Esc')} closes it &nbsp;·&nbsp;
      or click anywhere outside
    </footer>
  </section>
`;
