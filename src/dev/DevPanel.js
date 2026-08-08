/**
 * THE DEV PANEL — the DEV button in the top bar, or F9 / ², and only on a dev
 * machine.
 *
 * A run takes forty minutes to reach wave 55 honestly, which makes the late game
 * the least-tested part of the game by a wide margin: every primal, the boss
 * waves, the victory card and the whole "I have gold and no board left" shape of
 * the end game sit behind an hour of play. This panel is how you get there in a
 * second.
 *
 * IT CANNOT SHIP. main.js imports this module inside `if (import.meta.env.DEV)`,
 * and Vite replaces that expression with the literal `false` in a production
 * build — the branch is dead code, so the bundler drops both it and this file.
 * There is no runtime flag to leave switched on by accident, no query parameter
 * to guess, and nothing in `dist/` to find. `npm run check:nodev` proves it
 * against a real build — and the check was itself verified by planting the
 * string in dist/index.html and watching it go red, so it is not passing
 * vacuously.
 *
 * IT IS NOT ON THE KEY SHEET, and that is deliberate rather than an oversight.
 * help.spec.js asserts that the sheet advertises every key the game binds, by
 * reading a fixed list of source files — src/dev/ is not among them, because a
 * key that exists only on a dev machine is not part of the contract the player's
 * key sheet describes. Advertising it would be advertising a key that does not
 * exist in the build they are holding. The panel advertises itself instead: the
 * DEV button in the top bar opens it, and its header prints the key.
 *
 * EVERYTHING HERE GOES THROUGH PUBLIC STATE AND PUBLIC METHODS. No private field
 * is touched and nothing is monkey-patched except `creeps.onLeak`, which is
 * wrapped rather than replaced (see #setInvincible) so the real handler still
 * runs and only its consequence is undone. That is the rule that keeps this file
 * from silently rotting when the game changes underneath it: if a public entry
 * point disappears, this breaks loudly instead of cheating differently.
 */

import { ECONOMY, PRIMAL } from '../core/Config.js';
import { ELEMENT_IDS } from '../game/Elements.js';
import { TOTAL_WAVES, waveDef, isAirWave } from '../game/Waves.js';
import { isTypingTarget } from '../util/dom.js';
import { MINIGAME_IDS, RITES } from '../minigames/registry.js';
import { riteOccurrence } from '../minigames/schedule.js';

/**
 * What opens the panel.
 *
 * NOT F8, which is the first thing this reached for and which PerfHud has bound
 * since before this file existed (PerfHud.js:55, alongside G). Two listeners on
 * one key would have opened the frame graph every time the dev panel was
 * summoned, and nothing would have said why.
 *
 * F9 is the nearest free key. Backquote is the alias that actually gets used on
 * this machine: it is `²` on a French AZERTY layout, the key every game with a
 * console puts its console on, and it needs no Fn on a Mac keyboard where the
 * F-row is media by default.
 */
const OPEN_KEYS = new Set(['F9', 'Backquote']);

/** Every gold/lives top-up is a whole number the HUD can tween to. */
const GOLD_STEP = 1000;
const GOLD_BIG = 10000;
const LIVES_STEP = 10;

/**
 * How often the "infinite" toggles top their resource back up.
 *
 * 4 Hz, and not a per-frame hook, because this file must not sit in the render
 * loop: a dev tool that costs frame time changes the thing it is used to
 * inspect. Gold is only ever spent by a click, so a quarter of a second of
 * staleness is invisible; lives are handled by the leak wrapper instead of by
 * this timer, precisely because a leak CAN kill you between two ticks.
 */
const TOPUP_MS = 250;

const html = String.raw;

/**
 * The panel's styling, injected from here rather than added to src/ui/ui.css.
 *
 * ui.css ships. Every rule put there is bytes in the player's download and one
 * more thing to keep out of the way of the real HUD; a dev tool has no business
 * in either. Injected from this module, the CSS is dropped by the same
 * tree-shake that drops the module.
 *
 * Sits bottom-LEFT because the dock owns the bottom band, the top bar owns the
 * top, and #threat owns the top-left down to about 500px — the lower left corner
 * is the one place a panel can stand without covering a control this panel
 * exists to exercise.
 */
const CSS = `
#devpanel {
  position: fixed; left: 12px; bottom: 96px; z-index: 9999;
  width: 258px; padding: 10px 12px 12px;
  background: rgba(10, 12, 18, 0.93);
  border: 1px solid rgba(255, 90, 31, 0.55); border-radius: 8px;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #d9dde6; box-shadow: 0 10px 34px rgba(0, 0, 0, 0.55);
}
#devpanel[hidden] { display: none; }
#devpanel .dev-head { display: flex; justify-content: space-between; align-items: baseline; }
#devpanel .dev-head b { color: #ff5a1f; letter-spacing: 0.14em; font-size: 11px; }
#devpanel .dev-key {
  font-size: 10px; color: #8b93a3; border: 1px solid #3a4152;
  border-radius: 3px; padding: 0 4px;
}
#devpanel .dev-note { color: #6f7789; font-size: 10px; margin: 2px 0 9px; }
#devpanel .dev-row { display: flex; align-items: center; gap: 4px; margin-bottom: 5px; }
#devpanel .dev-k { width: 62px; flex: none; color: #9aa2b3; }
#devpanel button {
  flex: 1; min-width: 0; padding: 4px 6px; cursor: pointer;
  background: #1b2030; color: #d9dde6;
  border: 1px solid #333b4d; border-radius: 4px;
  font: inherit; font-size: 11px;
}
#devpanel button:hover { background: #262d42; border-color: #4a5468; }
#devpanel button.on { background: #ff5a1f; border-color: #ff5a1f; color: #120a06; font-weight: 700; }
#devpanel input {
  width: 46px; flex: none; text-align: center; padding: 4px 2px;
  background: #11151f; color: #d9dde6;
  border: 1px solid #333b4d; border-radius: 4px; font: inherit; font-size: 11px;
}
#devpanel select {
  flex: 1; min-width: 0; padding: 4px 2px;
  background: #11151f; color: #d9dde6;
  border: 1px solid #333b4d; border-radius: 4px; font: inherit; font-size: 11px;
}
#devpanel .dev-status { margin-top: 8px; min-height: 14px; color: #63bd76; font-size: 11px; }

/* The top-bar button. Inherits .icon-btn's box from ui.css and only overrides
   what makes it read as NOT part of the shipping HUD: the orange of the panel,
   and a letterspaced label instead of a glyph.

   THE Z-INDEX IS LOAD-BEARING. #topbar sets neither z-index nor a transform, so
   it creates no stacking context and its children stack inside #ui-root (10)
   alongside the codex (20), the cursor hint (26), the element picker (30) and
   the key sheet (44). Without a z-index of its own the button sat UNDER the
   picker's full-bleed veil — measured, the click timed out with "picker-veil
   intercepts pointer events" — and the picker is open on the very first frame
   of a run, which is exactly when "give me every element" is the thing you
   want. 50 clears all four.

   It does NOT clear the lobby, which is z-index 60 and outside #ui-root
   entirely, so nothing set here can reach over it. That is what F9 is for, and
   F9 is verified to work with the lobby up and its name field focused. */
#dev-btn {
  position: relative;
  z-index: 50;
  /* .icon-btn is a 30x30 square built for ONE glyph, and a three-letter label
     overflowed it — the first build shipped a button reading "DE" with the V
     spilling past the border. Same escape ui.css already makes for .icon-btn.keyed
     ("a 30px box cannot hold a glyph and a cap without one of them turning into
     a smudge"): give up the square, become a pill. */
  width: auto;
  padding: 0 8px;
  color: #ff5a1f;
  border-color: rgba(255, 90, 31, 0.45);
  font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.12em;
}
#dev-btn:hover { border-color: rgba(255, 90, 31, 0.9); }
#dev-btn.on { background: #ff5a1f; border-color: #ff5a1f; color: #120a06; }
`;

export class DevPanel {
  /** @param {import('../game/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.open = false;
    this.infiniteGold = false;
    this.invincible = false;
    /** The original creeps.onLeak, held while invincibility is on. */
    this._leak = null;
    this._timer = 0;

    this.$style = document.createElement('style');
    this.$style.id = 'devpanel-css';
    this.$style.textContent = CSS;
    document.head.appendChild(this.$style);

    this.$el = document.createElement('div');
    this.$el.id = 'devpanel';
    this.$el.hidden = true;
    // aria-hidden and no tab stops: this is not part of the game's focus order
    // and must not appear in the lobby's Tab trap or in any accessibility audit
    // of the shipping UI.
    this.$el.setAttribute('aria-hidden', 'true');
    this.$el.innerHTML = html`
      <div class="dev-head">
        <b>DEV PANEL</b>
        <span class="dev-key">F9 · ²</span>
      </div>
      <div class="dev-note">Local only — absent from any build.</div>

      <div class="dev-row">
        <span class="dev-k">Or</span>
        <button data-act="gold1">+1k</button>
        <button data-act="gold10">+10k</button>
        <button data-act="goldinf" class="dev-toggle">∞</button>
      </div>

      <div class="dev-row">
        <span class="dev-k">Vies</span>
        <button data-act="lives">+${LIVES_STEP}</button>
        <button data-act="invincible" class="dev-toggle">∞</button>
      </div>

      <div class="dev-row">
        <span class="dev-k">Éléments</span>
        <button data-act="elements">Tous</button>
        <button data-act="stacks">+${PRIMAL.stacksRequired} stacks</button>
      </div>

      <div class="dev-row">
        <span class="dev-k">Vague</span>
        <button data-act="waveminus">◀</button>
        <input id="dev-wave" type="number" min="1" max="${TOTAL_WAVES}" value="${TOTAL_WAVES}">
        <button data-act="waveplus">▶</button>
        <button data-act="wavego">Go</button>
      </div>

      <div class="dev-row">
        <span class="dev-k">Creeps</span>
        <button data-act="killall">Tuer tout</button>
      </div>

      <div class="dev-row">
        <span class="dev-k">Rite</span>
        <select id="dev-rite">${MINIGAME_IDS.map((id) =>
          `<option value="${id}">${RITES[id].name}</option>`).join('')}</select>
        <button data-act="rite">Lancer</button>
      </div>

      <div class="dev-row">
        <span class="dev-k">Loterie</span>
        <button data-act="lottery">Ouvrir</button>
      </div>

      <div class="dev-status" id="dev-status"></div>`;

    document.body.appendChild(this.$el);
    this.$wave = this.$el.querySelector('#dev-wave');
    this.$rite = this.$el.querySelector('#dev-rite');
    this.$status = this.$el.querySelector('#dev-status');

    // One delegated listener rather than one per button: the actions are data,
    // and a new row should not need a second place to register it.
    this.$el.addEventListener('click', (e) => {
      const act = e.target?.closest?.('button')?.dataset?.act;
      if (act) this.#run(act);
    });

    // Bound on `window` at CAPTURE, so the panel opens from anywhere including
    // over the lobby overlay and the key sheet — both of which swallow keydown
    // for the game's own listeners, and neither of which should be able to lock
    // a developer out of this.
    this._onKey = (e) => {
      if (!OPEN_KEYS.has(e.code)) return;
      // Never steal a browser or OS combination: Ctrl+` is VS Code's terminal
      // and Cmd+` is macOS's window cycle, and a dev tool that eats either is
      // worse than no dev tool.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // THE TYPING GUARD APPLIES TO BACKQUOTE ONLY, and the first version of
      // this file applied it to both — which made the panel unopenable for a
      // human being. Measured: main.js only skips the lobby under
      // navigator.webdriver, so every automated check started with focus
      // nowhere, while a person starts with the lobby up and #lobby-name
      // focused (Lobby.#focusFirst). Both keys reached this listener and both
      // were dropped by the guard; blurring the field made F9 work instantly.
      //
      // F9 is a function key. It cannot type a character, so there is nothing
      // for it to steal from a text field and no reason to refuse it there.
      // Backquote can and does type one — `²` on AZERTY, a backtick elsewhere —
      // and a room code or a player name containing it must reach the field.
      if (e.code === 'Backquote' && isTypingTarget(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    };
    window.addEventListener('keydown', this._onKey, true);

    // A number field inside a game that binds Space, F, H, U, X and the digits:
    // without this, typing "3" into the wave box also sets the simulation speed.
    // The game's own listeners already exempt typing targets (util/dom.js), so
    // this only has to stop the event reaching anything that does not.
    this.$wave.addEventListener('keydown', (e) => e.stopPropagation());

    this.#mountButton();
    this._tick = setInterval(() => this.#topUp(), TOPUP_MS);
  }

  /**
   * The top-bar button — the way in that cannot fail.
   *
   * A KEY IS NOT ENOUGH ON A MAC, which is how this came to exist. F9 is Mission
   * Control on macOS and needs Fn on any keyboard whose F-row defaults to media,
   * and the AZERTY `²` sits under a layout the browser reports differently
   * depending on the keyboard. A button has no layout, no Fn row and no OS
   * shortcut sitting on top of it: you can see it, and clicking it works.
   *
   * INJECTED FROM HERE, not added to HUD.js's template. HUD.js ships. A dev
   * control written into it would be a control the bundler cannot remove, one
   * more element in the layout contract, and one more thing to hide by hand on
   * every capture. Appended to #topbar .controls so it inherits the real HUD's
   * button styling and sits with the other controls; a no-op if the topbar is
   * not there, because this must never be the thing that stops the game booting.
   *
   * DELIBERATELY WITHOUT `aria-keyshortcuts` and without a <kbd> cap, unlike
   * every neighbouring button. Those two are what help.spec.js reads to check
   * that a control advertises the key it answers to — and this control's key is
   * not on the key sheet, on purpose (see the file docblock). Wearing a cap here
   * would be promising the sheet a row it must not have.
   */
  #mountButton() {
    const controls = document.querySelector('#topbar .controls');
    if (!controls) return;
    const b = document.createElement('button');
    b.id = 'dev-btn';
    b.className = 'icon-btn';
    b.type = 'button';
    b.textContent = 'DEV';
    b.title = 'Dev panel · F9 (² on AZERTY)';
    b.setAttribute('aria-label', 'Dev panel');
    b.addEventListener('click', () => this.toggle());
    controls.appendChild(b);
    this.$btn = b;
  }

  // -- lifecycle -----------------------------------------------------------

  toggle() { this.open ? this.hide() : this.show(); }

  show() {
    this.open = true;
    this.$el.hidden = false;
    this.#status('');
  }

  hide() {
    this.open = false;
    this.$el.hidden = true;
    this.#paint();
  }

  /** Undo everything, including the leak wrapper. Used by tests and by HMR. */
  destroy() {
    clearInterval(this._tick);
    window.removeEventListener('keydown', this._onKey, true);
    if (this.invincible) this.#setInvincible(false);
    this.$el.remove();
    this.$btn?.remove();
    this.$style.remove();
  }

  // -- actions -------------------------------------------------------------

  #run(act) {
    switch (act) {
      case 'gold1':      this.gold(GOLD_STEP); break;
      case 'gold10':     this.gold(GOLD_BIG); break;
      case 'goldinf':    this.#setInfiniteGold(!this.infiniteGold); break;
      case 'lives':      this.lives(LIVES_STEP); break;
      case 'invincible': this.#setInvincible(!this.invincible); break;
      case 'elements':   this.giveElements(1); break;
      case 'stacks':     this.giveElements(PRIMAL.stacksRequired); break;
      case 'waveminus':  this.#nudgeWave(-1); break;
      case 'waveplus':   this.#nudgeWave(1); break;
      case 'wavego':     this.jumpToWave(Number(this.$wave.value)); break;
      case 'killall':    this.killAll(); break;
      case 'rite':       this.rite(this.$rite.value, Number(this.$wave.value)); break;
      case 'lottery':    this.lottery(Number(this.$wave.value)); break;
      default: break;
    }
    this.#paint();
  }

  /** @param {number} amount */
  gold(amount) {
    // Through the public credit door like everything else here, so dev gold is
    // labelled in state.goldEarned and a reading taken with the panel open is
    // visibly not a real run's economy.
    this.game.addGold(amount, 'dev');
    this.game.hud.refreshTop();
    this.#status(`+${amount} or`);
  }

  /**
   * @param {number} amount clamped to ECONOMY.maxLives, the same ceiling
   *   Oblivion's lifesteal is held to — going past it would put the HUD in a
   *   state no real run can produce.
   */
  lives(amount) {
    const s = this.game.state;
    s.lives = Math.min(ECONOMY.maxLives, s.lives + amount);
    this.game.hud.refreshTop();
    this.#status(`vies : ${s.lives}`);
  }

  /**
   * Bind every element `copies` times.
   *
   * Copies are how stacks work: availableTowers counts duplicates in
   * state.elements and unlocks a primal at PRIMAL.stacksRequired of one element,
   * so `giveElements(3)` is what puts the six primal cards on the dock. The
   * element picker is closed and its debt cleared, or the game would stop to ask
   * a question that has already been answered.
   */
  giveElements(copies = 1) {
    const s = this.game.state;
    s.elements = ELEMENT_IDS.flatMap((id) => Array(copies).fill(id));
    s.pendingElementPicks = 0;
    this.game.hud.closeElementPicker();
    // The picker is a PHASE, not just a panel. Closing the panel without moving
    // the phase leaves the game owing an answer to a question nothing is asking:
    // startWaveNow() refuses outside 'prep', so Space and the Send wave button
    // both go quiet with no visible cause.
    if (s.phase === 'pickElement') s.phase = 'prep';
    this.game.hud.refreshBuildBar();
    this.#status(copies > 1 ? `6 éléments × ${copies}` : '6 éléments');
  }

  /**
   * Restart the run at wave `n`, in its prep phase.
   *
   * The board, the towers and the gold are left exactly as they are — this is
   * "take me to the late game with what I have built", not a reset. What it does
   * clear is the wave in flight: creeps are removed UNCREDITED (no bounty, no
   * score) because being paid for a wave you skipped would quietly invalidate
   * every economy reading taken afterwards.
   *
   * Mirrors Game.#beginPrep, which is private. Deliberately not reached through
   * a hack: the three fields it writes are public state, and writing them here
   * means this file breaks visibly if the shape of a prep phase ever changes,
   * rather than putting the game into a state that no longer exists.
   */
  jumpToWave(n) {
    const wave = Math.max(1, Math.min(TOTAL_WAVES, Math.round(n) || 1));
    const g = this.game;
    const s = g.state;

    this.#clearCreeps(false);
    g.waves.spawning = false;
    g.waves.def = null;
    g.waves.wave = wave - 1;

    s.phase = 'prep';
    s.wave = wave - 1;
    s.prepTimer = waveDef(wave).prepTime;
    s.interestActive = true;
    g.hud.setAirAlert(isAirWave(wave) ? wave : 0);
    g.hud.refreshTop();
    this.$wave.value = String(wave);
    this.#status(`vague ${wave} — prêt`);
  }

  /**
   * Open a rite on demand, as if wave `n - 1` had just been cleared.
   *
   * The occurrence index is derived from the wave with the SAME function the
   * real schedule uses, so a rite launched from here has exactly the layout the
   * player would have got on that wave with this seed — which is the whole point
   * of being able to launch it. Passing 0 would have made the dev panel show a
   * rite nobody will ever play.
   *
   * Goes through Game.startMinigame, the public entry point published in
   * docs/MINIGAMES.md, so this file cannot drift from what the game does: if the
   * phase handling changes underneath, this breaks loudly.
   */
  rite(id, n) {
    const wave = Math.max(1, Math.min(TOTAL_WAVES, Math.round(n) || 1));
    const ok = this.game.startMinigame(id, wave, Math.max(0, riteOccurrence(wave - 1)));
    this.#status(ok ? `rite « ${id} » — vague ${wave}` : `rite « ${id} » refusé`);
  }

  /**
   * The lottery, if the lottery exists yet.
   *
   * DELIBERATELY A DUCK-TYPED CALL. The lottery is being built by another agent
   * against the contract in docs/MINIGAMES.md, which asks it to expose
   * `game.lottery.devOpen(wave)`. Wiring the button now means the day that
   * method lands there is nothing to remember; until then it says so instead of
   * throwing. A dev button that reports "not built yet" is honest — a dev button
   * that silently does nothing is the bug docs/PITFALLS.md rule 1 is about.
   */
  lottery(n) {
    const wave = Math.max(1, Math.min(TOTAL_WAVES, Math.round(n) || 1));
    const l = this.game.lottery;
    if (typeof l?.devOpen !== 'function') { this.#status('loterie : pas encore branchée'); return; }
    l.devOpen(wave);
    this.#status(`loterie — vague ${wave}`);
  }

  /** Clear the board, WITH bounty: this is "I have seen enough of this wave". */
  killAll() {
    const n = this.#clearCreeps(true);
    this.game.hud.refreshTop();
    this.#status(`${n} creeps tués`);
  }

  // -- internals -----------------------------------------------------------

  /**
   * @param {boolean} credited pay bounty and score, or remove silently.
   * @returns {number} how many were alive.
   */
  #clearCreeps(credited) {
    const c = this.game.creeps;
    let n = 0;
    // Downwards, because kill() pushes the slot onto freeList and mutates
    // `count` as it goes; iterating the alive array by index is the only read
    // that does not depend on either.
    for (let i = c.alive.length - 1; i >= 0; i--) {
      if (c.alive[i]) { c.kill(i, credited); n++; }
    }
    return n;
  }

  #nudgeWave(d) {
    const next = Math.max(1, Math.min(TOTAL_WAVES, (Number(this.$wave.value) || 1) + d));
    this.$wave.value = String(next);
  }

  #setInfiniteGold(on) {
    this.infiniteGold = on;
    this.#status(on ? 'or infini' : 'or normal');
  }

  /**
   * Invincibility, as a WRAPPER around creeps.onLeak rather than a replacement.
   *
   * The original still runs — the flash, the shake, the sound, the lost interest
   * and the leak counter are all things you want to see while testing — and only
   * its one irreversible consequence is undone: the lives it took, restored on
   * the same tick so the `lives <= 0` test inside it cannot end the run.
   *
   * Restored EXACTLY, not topped up to full: a run where lives stay at whatever
   * they were is still readable, and a HUD that silently climbs back to 50 hides
   * how much you were actually leaking.
   */
  #setInvincible(on) {
    const c = this.game.creeps;
    if (on && !this._leak) {
      const original = c.onLeak;
      this._leak = original;
      c.onLeak = (i, type) => {
        const before = this.game.state.lives;
        original?.(i, type);
        this.game.state.lives = before;
        this.game.hud.refreshTop();
      };
    } else if (!on && this._leak) {
      c.onLeak = this._leak;
      this._leak = null;
    }
    this.invincible = on;
    this.#status(on ? 'invincible' : 'vulnérable');
  }

  #topUp() {
    if (!this.infiniteGold) return;
    const s = this.game.state;
    if (s.gold < 500000) { s.gold = 999999; this.game.hud.refreshTop(); }
  }

  #status(text) {
    if (text) this.$status.textContent = text;
    this.#paint();
  }

  #paint() {
    this.$el.querySelector('[data-act="goldinf"]').classList.toggle('on', this.infiniteGold);
    this.$el.querySelector('[data-act="invincible"]').classList.toggle('on', this.invincible);
    // The button follows the panel, so "is it open" is answerable from the top
    // bar alone -- the panel itself can be off screen on a short window.
    this.$btn?.classList.toggle('on', this.open);
  }
}
