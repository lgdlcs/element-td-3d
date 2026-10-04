/**
 * Tiny DOM predicates shared across layers.
 *
 * This module has no imports on purpose. Five window-level `keydown` listeners
 * need the same guard — HUD.js, BuildBar.js, PerfHud.js (src/ui), Game.js
 * (src/game) and CameraRig.js (src/core) — and the only place all five can
 * reach without inverting the layering is a leaf with no dependencies of its
 * own. Putting it in ui/uikit.js would have made a camera rig import the tower
 * table.
 */

/**
 * Is this keyboard event going into something the player is TYPING in?
 *
 * Each of the five listeners carried its own copy of
 * `e.target instanceof HTMLInputElement`, and every copy missed the same three
 * cases: `<textarea>`, `<select>` and anything `contenteditable`. Measured with
 * a textarea focused, typing "hu x" left the value "ux" — the `h` was
 * preventDefault'd into toggling the key sheet and the space reached Game.js
 * and launched a wave.
 *
 * No such field exists in the game today, which is exactly why this is worth
 * centralising: the trap is armed for whoever adds a room chat or a table-name
 * field, and four divergent copies is how it stays armed.
 */
export function isTypingTarget(e) {
  const t = e?.target;
  return t instanceof HTMLInputElement
    || t instanceof HTMLTextAreaElement
    || t instanceof HTMLSelectElement
    || (t instanceof HTMLElement && t.isContentEditable);
}

/**
 * The quiet window an overlay leaves behind when it closes, so the board does
 * not read the tail of a mash as a commit. A player mashing Space through a
 * result card closes it on one press and, with no window, sends the next wave
 * on the next one. Each press inside the window renews it, because a measured
 * mash (6 presses through Playwright) lasts over a second. A timestamp and not
 * a listener, so an overlay holds nothing once it shuts.
 */
export class CommitSettle {
  static MS = 500;
  #closedAt = -Infinity;

  /** The overlay just closed. */
  arm() { this.#closedAt = performance.now(); }

  /** True while the player is still mashing out; a swallowed press renews the window. */
  swallows() {
    const now = performance.now();
    if (now - this.#closedAt >= CommitSettle.MS) return false;
    this.#closedAt = now;
    return true;
  }
}
