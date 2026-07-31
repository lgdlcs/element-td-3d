/**
 * In-game live leaderboard.
 *
 * WHY IT SITS BOTTOM-LEFT
 *
 * The HUD layout contract (see the docblock in HUD.js) gives every edge an
 * owner: 54px status bar on top, threat rail top-left, tower inspector
 * top-right, build dock bottom-centre. The bottom-left corner is the only
 * region with no resting occupant, and it is adjacent to the threat rail so the
 * left side reads as one column — "what is coming" above, "who is winning"
 * below — without inheriting the threat panel's variable height (it collapses,
 * and its card grows on boss waves, so anything stacked under it would move).
 * Bottom-left also keeps the board centre clear, which the contract requires.
 * The dock is centred and grows toward both edges on narrow viewports, so the
 * panel gives up WIDTH to stay clear of it. It used to lift above the dock's
 * height below 1100px instead, and that lift put it 71px inside the threat rail
 * — see the note on `.crowded` in scoreboard.css for the measurements.
 *
 * The variable-height rail is still the hard constraint: it collapses, and its
 * card grows on boss waves (bottom edge 426px on a quiet wave, 530px on a boss
 * wave), so on a short viewport it can grow down into a panel that fitted a
 * moment ago. scoreboard.css shrinks the panel by tiers, and #fit() is the last
 * line of defence — the panel stands down rather than share pixels with it.
 *
 * WHY IT OWNS NO GAME STATE
 *
 * Every number here arrives from another machine via the `scores` relay. There
 * is no local truth to reconcile against, and pulling the local player's row out
 * of `game.state` instead of the relay would make your own row disagree with how
 * the other five players see you — the one number in the panel that must match
 * everyone else's view of it.
 *
 * WHY THERE IS NO PER-FRAME UPDATE
 *
 * `update()` is driven by `scores` at ~2 Hz, not by the render loop. Score
 * movement is animated by CSS transitions on a fill bar whose width is a custom
 * property; a JS tween would run 60 times a second to animate a value that only
 * changes twice a second.
 */

import { num, esc } from './uikit.js';

/**
 * Sort into leaderboard order and attach a rank. Exported because it is the
 * only interesting logic in the file and it is testable without a DOM
 * (tools/scratch/scorecheck.mjs).
 *
 * Ties are broken by wave, then lives, then id. Without the id fallback two
 * players sitting on 0 score during wave 1 — the normal state for the first
 * thirty seconds of every run — swap places on every relay, because Array#sort
 * is only stable with respect to the *input* order and the server does not
 * promise a stable roster order.
 */
export function rankPlayers(players) {
  const list = (Array.isArray(players) ? players : []).map((p) => ({
    id: String(p.id),
    name: p.name ?? '?',
    score: Number(p.score) || 0,
    lives: Number(p.lives) || 0,
    wave: Number(p.wave) || 0,
    finished: !!p.finished,
    won: !!p.won,
  }));
  list.sort((a, b) =>
    b.score - a.score || b.wave - a.wave || b.lives - a.lives || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  list.forEach((p, i) => { p.rank = i + 1; });
  return list;
}

/**
 * Has this player's machine ever reported? Nothing on the wire says so — the
 * `players[]` entry in docs/MULTIPLAYER.md has no such flag — so it is derived
 * from `wave`, which is the one field the two producers of a frame both clamp:
 * `Game.snapshot()` sends `wave: Math.max(1, s.wave)` and the run-end payload
 * does the same (src/game/Game.js:307 and :617). Every frame a client has ever
 * produced therefore arrives with wave >= 1, and wave 0 is only ever the value
 * `resetRunState()` seeds a roster entry with (server/rooms.js:174) — i.e.
 * "connected, in the run, nothing heard from them yet".
 */
const hasReported = (p) => p.finished || p.wave >= 1;

/**
 * Out of the run: it sent `finished`, or it has reported and has no lives left.
 *
 * The second clause was a bare `p.lives <= 0`, and that declared the whole
 * table dead for the first seconds of every multiplayer run. The server seeds
 * every roster entry with lives 0 and only broadcasts `scores` once ONE player
 * is dirty, so the first client to report made all five other rows render
 * struck-through, dimmed to 0.46, with a `lives` column reading "out" — six
 * connected, alive players, five of them shown as eliminated. Verified against
 * a real relay frame: `{id:'p2', lives:0, score:0, wave:0, finished:false}`.
 * It was not transient either: a tab whose rAF loop stopped (backgrounded) or
 * a tab the OS killed with the socket still open never sends a status, and its
 * row stayed dead on everyone's board for the rest of the run.
 */
const isOut = (p) => p.finished || (hasReported(p) && p.lives <= 0);

export class Scoreboard {
  constructor(root) {
    this.root = root;

    // Two independent reasons the panel can be off screen, kept apart on
    // purpose: `_wanted` is what the caller asked for (show/hide around the
    // lobby and the end card), `_enough` is whether there is anyone to compare
    // against. A one-row leaderboard is noise, so single-player never shows it
    // even if the caller calls show().
    this._wanted = false;
    this._enough = false;

    this._rosterSig = '';
    this._final = false;
    this.rows = new Map();

    root.insertAdjacentHTML('beforeend', /* html */`
      <aside id="scoreboard" aria-label="Live leaderboard" aria-live="off">
        <div class="sb-head">
          <span class="sb-title" id="sb-title">Leaderboard</span>
          <span class="sb-n" id="sb-n"></span>
        </div>
        <ol class="sb-list" id="sb-list"></ol>
      </aside>`);

    this.$el = root.querySelector('#scoreboard');
    this.$list = root.querySelector('#sb-list');
    this.$title = root.querySelector('#sb-title');
    this.$n = root.querySelector('#sb-n');

    // The one thing this panel has to know about a neighbour. scoreboard.css
    // sizes the panel so it clears the threat rail AT REST, but the rail is not
    // a fixed-height box: measured across all 30 waves its bottom edge sits at
    // 426px on a quiet wave and 530px on a boss wave (wave 4/14/24), because the
    // boss card grows. No media query can see that, so on a short viewport the
    // rail can still grow down into a panel that fitted a moment earlier. #fit()
    // is what guarantees the two glass cards never actually overlap.
    this.$rail = root.querySelector('#threat');
    // Height is the whole constraint here, so a resize has to re-run the test
    // even when no `scores` frame is due (paused, or between runs).
    window.addEventListener('resize', () => this.#fit());
    // aria-live is off deliberately: a polite region that rewrites five rows
    // twice a second turns a screen reader into a metronome. The panel is a
    // glanceable instrument, and the end-of-run standings are announced by the
    // end card instead.
  }

  // ---- visibility --------------------------------------------------------

  show() { this._wanted = true; this.#apply(); }
  hide() { this._wanted = false; this.#apply(); }
  setVisible(v) { this._wanted = !!v; this.#apply(); }

  #apply() {
    this.$el.classList.toggle('on', this._wanted && this._enough);
    this.#fit();
  }

  /**
   * Stand down while the threat rail needs the room.
   *
   * The HUD contract (docblock in HUD.js) gives each edge one owner and forbids
   * resting UI in the playable centre, so when the left column cannot hold both
   * the rail and the leaderboard there is nowhere for the loser to go. The rail
   * wins: "what is coming" is actionable, "who is winning" is a glance. Measured
   * with six rows, this fires nowhere at 660px of viewport height or more; at
   * 650px and below a boss-wave rail takes the whole column and the panel fades
   * out for those three waves. It is the same exit it already makes for the
   * codex — not a new behaviour, just a new trigger.
   *
   * The panel keeps its layout box while yielding (`visibility`/`opacity`, never
   * `display`), so the measurement below is stable: hiding it does not change
   * its height and cannot make the test flip back.
   */
  #fit() {
    const rail = this.$rail;
    if (!rail) return;
    // A rail that is faded out (codex open) is not something to collide with,
    // and its box is still on the left where the panel is, so testing rects
    // alone would make the panel yield to an invisible neighbour and come back
    // wrong-looking for half a second after the codex closes.
    if (Number(getComputedStyle(rail).opacity) < 0.05) { this.$el.classList.remove('crowded'); return; }

    // Vertically: LAYOUT boxes (offsetTop/offsetHeight), never
    // getBoundingClientRect. Both elements animate with transforms — the panel's
    // hidden state is a translateY and the rail's collapse is a translateX — and
    // a rect read mid-transition returns the interpolated position. Measuring the
    // panel's transformed rect would also read it 8px lower exactly while it was
    // standing down, which is enough to flip the answer back in a narrow band and
    // then flip it again once the transform came off: a panel blinking at the
    // relay rate. A translate does not touch offsetTop or offsetHeight, so these
    // are the boxes the two cards will occupy once everything settles.
    const top = this.$el.offsetTop;
    const railBottom = rail.offsetTop + rail.offsetHeight;
    // Horizontally the transform is exactly what matters: below 900px wide
    // ui.css slides the rail off to a 4px handle, and a rail that no longer
    // shares the column is not something to yield to. `offsetLeft` is safe on
    // this side of the comparison because the only transform the panel carries
    // horizontally is the codex exit, and the codex fades the rail out — which
    // the opacity test above has already returned on.
    const b = rail.getBoundingClientRect();
    const left = this.$el.offsetLeft;
    const right = left + this.$el.offsetWidth;
    const sameColumn = b.right > left + 1 && b.left < right - 1;
    // 8px of air, not 0: two backdrop-filter cards that merely touch read as one
    // smeared card. The 1px insets keep a shared edge from counting as contact.
    this.$el.classList.toggle('crowded', sameColumn && railBottom + 8 > top);
  }

  // ---- data --------------------------------------------------------------

  /**
   * @param {Array} players entries from a `scores` message
   * @param {string} youId  your own player id, from `joined`
   */
  update(players, youId) {
    // Once the run is over the standings are frozen. A `scores` frame can still
    // arrive after `over` (they are relayed on separate timers), and letting it
    // through would repaint the final table with pre-final numbers — the panel
    // would appear to un-finish the run.
    if (this._final) return;
    this.#render(rankPlayers(players), youId, false);
  }

  /**
   * Final standings from `over`. Latches: nothing repaints after this.
   */
  showFinal(standings, youId) {
    this._final = true;
    this.#render(rankPlayers(standings), youId, true);
    this.$el.classList.add('is-final');
    this.$title.textContent = 'Final standings';
    this._wanted = true;
    this.#apply();
  }

  #render(list, youId, final) {
    // A one-row leaderboard is noise DURING a run, but at the end of one it is
    // the result. showFinal used to go through the same `>= 2` test: an `over`
    // payload with a single standing — a two-player room whose other socket
    // dropped before its last `finished` — set `_enough` false, returned here
    // before writing anything, and then `_final` made every later update() a
    // no-op. The panel latched hidden with no code path left that could ever
    // show the standings again.
    this._enough = list.length >= (final ? 1 : 2);
    this.#apply();
    if (!this._enough) return;

    const you = youId == null ? '' : String(youId);

    // Rebuild markup only when the roster itself changes. Membership is
    // order-independent here on purpose: an overtake MOVES the existing <li>
    // nodes rather than re-emitting them, which keeps their CSS transitions
    // alive. Rebuilding on every overtake would reset every bar to its new
    // width with no animation.
    const sig = `${list.map((p) => p.id).slice().sort().join(',')}|${you}`;
    if (sig !== this._rosterSig) {
      this._rosterSig = sig;
      this.#build(list, you);
    }

    const top = Math.max(1, list[0].score);
    // Pluralised because a one-entry table is now reachable: allowing a single
    // final standing through (see above) also made "1 players" reachable.
    this.$n.textContent = `${list.length} player${list.length === 1 ? '' : 's'}`;

    // `slot` walks the <ol>'s real children so the DOM sequence ends up equal to
    // the leaderboard sequence. This used to be `li.style.order = rank`, which
    // moves rows visually and leaves the DOM frozen in build order — a screen
    // reader, or anything else that walks an <ol> and takes its promise of
    // sequence at face value, read p6 before p5 and announced a ranking that
    // had not been true since the first overtake. `aria-live` is off, so nothing
    // ever corrected it.
    let slot = 0;

    for (const p of list) {
      const r = this.rows.get(p.id);
      if (!r) continue;                       // roster changed under us; next frame fixes it
      const out = isOut(p);
      const seen = hasReported(p);

      if (this.$list.children[slot] !== r.li) {
        this.$list.insertBefore(r.li, this.$list.children[slot] ?? null);
      }
      slot++;
      // The rank number stays a number even for a winner — the ★ that marks a
      // won run is a separate mark in CSS, because replacing the rank with a
      // glyph loses the one column the panel is sorted by.
      this.#text(r.rank, String(p.rank));
      this.#text(r.score, num(p.score));
      // An em dash, not a number, for a player nobody has heard from. `W1` here
      // was a fabrication: combined with the old isOut it rendered a connected
      // player who had simply not reported yet as "died on wave 1 with 0
      // points", which is a specific false claim rather than an absent value.
      this.#text(r.wave, seen ? `W${p.wave}` : '—');
      this.#text(r.lives, out ? (final && p.won ? 'won' : 'out') : (seen ? num(p.lives) : '—'));

      r.li.classList.toggle('out', out);
      r.li.classList.toggle('waiting', !seen);
      r.li.classList.toggle('won', !!p.won);
      // `seen` guards the gold leader mark too: on a roster where nobody has
      // reported, every score is 0 and rank 1 falls to whoever has the lowest
      // id, so without this the panel crowns an arbitrary player at 0 points.
      r.li.classList.toggle('lead', p.rank === 1 && !out && seen);
      r.li.classList.toggle('low', !out && p.lives > 0 && p.lives <= 10);
      // Gaining, not gained-once: the class stays on while the relay keeps
      // reporting a higher score, so the highlight is a state rather than an
      // event needing a timer to clear it.
      r.li.classList.toggle('gain', p.score > r.last);
      r.last = p.score;

      // The bar is the score animation. Setting a custom property lets the CSS
      // transition do the interpolation between two relay frames.
      r.bar.style.setProperty('--frac', (p.score / top).toFixed(4));
    }

    // After the writes, not before: the row count that just changed is what
    // decides whether the panel still clears the rail.
    this.#fit();
  }

  /** textContent writes are cheap, but not free, and most ticks change nothing. */
  #text(node, v) { if (node.textContent !== v) node.textContent = v; }

  #build(list, you) {
    // esc() on the name: this string came off a WebSocket from another player's
    // machine. It is the most obvious XSS vector in the project, and it is
    // rendered twice here (row body and the title attribute), so both go
    // through esc. The id is escaped too — it also arrives from the network,
    // and it lands in an attribute.
    this.$list.innerHTML = list.map((p) => {
      const mine = p.id === you;
      // Emitted in rank order, and #render keeps the DOM in rank order from
      // then on, so no `style="order:"` is needed and the <ol> never lies.
      return `<li class="sb-row${mine ? ' you' : ''}" data-id="${esc(p.id)}">
        <span class="sb-rank">${p.rank}</span>
        <span class="sb-name" title="${esc(p.name)}">${esc(p.name)}</span>
        ${mine ? '<span class="sb-mine">you</span>' : ''}
        <span class="sb-wave">—</span>
        <span class="sb-lives">—</span>
        <b class="sb-score">0</b>
        <i class="sb-bar" aria-hidden="true"><s></s></i>
      </li>`;
    }).join('');

    this.rows.clear();
    for (const li of this.$list.children) {
      this.rows.set(li.dataset.id, {
        li,
        rank: li.querySelector('.sb-rank'),
        score: li.querySelector('.sb-score'),
        wave: li.querySelector('.sb-wave'),
        lives: li.querySelector('.sb-lives'),
        bar: li.querySelector('.sb-bar'),
        // Infinity, not 0: on the frame a row is created nothing has *changed*
        // yet, and seeding with 0 would flag every player who is already on a
        // positive score as gaining the moment they joined the panel.
        last: Number.POSITIVE_INFINITY,
      });
    }
  }
}
