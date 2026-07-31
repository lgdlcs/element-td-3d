import { esc, num } from './uikit.js';
import { seatCss } from './seats.js';

/**
 * The "you are watching someone else" banner.
 *
 * WHERE IT SITS AND WHY THAT IS ALLOWED
 *
 * Directly under the 54px status bar, top-centre, full width, 34px tall. The
 * HUD layout contract (HUD.js) forbids resting UI in the playable centre — and
 * this is not resting UI: it is a MODE INDICATOR, it exists only while the mode
 * does, and the mode it indicates is one in which the centre of the screen is
 * not yours to click. It sits above the threat rail and clear of the inspector,
 * both of which the spectating class folds away anyway.
 *
 * WHY A BANNER AT ALL, GIVEN THE COLOUR WASH
 *
 * The wash says "this is not your board". Only the banner can say WHOSE it is,
 * and only the banner can carry the way out. A mode with no visible exit is a
 * trap, and the one exit everyone tries first is Escape, so Escape is printed
 * on the button rather than left to be discovered.
 */
export class SpectateBar {
  /** @param {HTMLElement} root #ui-root */
  constructor(root) {
    root.insertAdjacentHTML('beforeend', /* html */`
      <div id="spectate-bar" role="status" aria-live="polite">
        <span class="sp-dot" aria-hidden="true"></span>
        <span class="sp-text">Watching <b></b></span>
        <span class="sp-stat"></span>
        <span class="sp-warn" hidden>stalled</span>
        <button class="sp-exit" type="button">Back to your board <kbd>Esc</kbd></button>
      </div>`);

    this.$el = root.querySelector('#spectate-bar');
    this.$dot = this.$el.querySelector('.sp-dot');
    this.$name = this.$el.querySelector('.sp-text b');
    this.$stat = this.$el.querySelector('.sp-stat');
    this.$warn = this.$el.querySelector('.sp-warn');
    this.$exit = this.$el.querySelector('.sp-exit');

    /** @type {?() => void} */
    this.onExit = null;
    this.$exit.addEventListener('click', () => this.onExit?.());

    this._stat = '';
    this._warn = false;
  }

  /**
   * @param {string} name the watched player's name — from another machine, so
   *   it goes through esc() in TEXT position. Never into an attribute: esc()
   *   does not escape single quotes (see the note in Lobby.js).
   * @param {number} color seat colour, sRGB hex
   */
  show(name, color) {
    this.$name.innerHTML = esc(name || 'player');
    this.$dot.style.setProperty('--c', seatCss(color));
    this.$el.style.setProperty('--c', seatCss(color));
    this.$stat.textContent = 'loading their board…';
    this._stat = '';
    this.setStalled(false);
    this.$el.classList.add('on');
  }

  hide() { this.$el.classList.remove('on'); }

  /**
   * @param {{w:number, l:number, sc:number}} s straight off the last snapshot
   * @param {boolean} loading nothing has reached its playout time yet
   */
  update(s, loading) {
    const text = loading
      ? 'loading their board…'
      : `W${s.w} · ${num(s.l)} lives · ${num(s.sc)}`;
    // textContent writes are cheap but not free, and this is called 60 times a
    // second against a string that changes twice.
    if (text !== this._stat) { this._stat = text; this.$stat.textContent = text; }
  }

  setStalled(on) {
    if (on === this._warn) return;
    this._warn = on;
    this.$warn.hidden = !on;
  }
}
