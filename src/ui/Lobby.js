/**
 * Pre-game lobby overlay.
 *
 * This is the only screen in the game that renders text typed on a *different
 * machine*, so every player name and room code goes through `esc` before it
 * touches innerHTML. See #roster and #renderCode.
 *
 * WHY THE OVERLAY IS NEVER A GATE
 *
 * The multiplayer server is optional (docs/MULTIPLAYER.md: `npm run dev` with no
 * server must still give a fully playable game). So "Play solo" is a sibling of
 * Create/Join, not a fallback buried behind a failed connection: it is present
 * in every state, including `offline`, where it becomes the primary button. A
 * player who cannot reach the server should never have to read an error to work
 * out that the game still works.
 *
 * The class owns no game state and imports nothing from src/game/ — it reports
 * intent through `callbacks` and is told what to display through its setters.
 * Construction is the only thing that touches the DOM, so importing the module
 * is side-effect free (tools/scratch/lobbycheck.mjs asserts exactly that,
 * because a top-level `document.querySelector` here would break node-side
 * parse checks and, worse, the boot sequence's import order).
 */

import { esc } from './uikit.js';

/** Contract: max 6 players per room. Empty seats are drawn to invite a fill. */
const MAX_PLAYERS = 6;

/** Contract: 4 chars, no I/O/0/1 — players read these aloud. */
const CODE_LEN = 4;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Contract: names are 1–16 characters after cleaning. Mirrored, not guessed. */
const NAME_MIN = 1;
const NAME_MAX = 16;

/** Namespaced so it cannot collide with anything else on localhost:5273. */
const NAME_KEY = 'etd3d.lobby.name';

/**
 * The six contract error codes as sentences a player can act on. The server
 * sends a `msg` too, but that message is written for a log line; a code the UI
 * knows about deserves the sentence that names the fix.
 */
const ERRORS = {
  NO_ROOM:     'No room with that code. Codes are four characters and never contain I, O, 0 or 1.',
  ROOM_FULL:   'That room is full — six players is the limit.',
  IN_PROGRESS: 'That run has already begun, and joining a run in progress is not possible. Ask for a fresh room, or play solo.',
  BAD_NAME:    'The server refused that name. One to sixteen characters, and nothing invisible.',
  NOT_HOST:    'Only the host can begin the run.',
  RATE_LIMIT:  'Too many requests too quickly. Wait a moment and try again.',
};

/**
 * ROOM_FULL means two different things and the code alone cannot tell them apart.
 * On a `join` it is the room's six seats; on a `create` it is server/index.js:260,
 * the 4-character code space being exhausted, and no room was ever made. The
 * hardcoded sentence used to win over the server's accurate msg in both cases, so
 * a player who clicked "Create room" was told a room they had never joined was
 * full of six players — the module's justification for hardcoding sentences is
 * that a known code "deserves the sentence that names the fix", and that one
 * named the wrong fix. The last button pressed is what disambiguates.
 */
const ROOM_FULL_ON_CREATE = 'The server has no free room codes right now. Wait a moment and try again, or play solo.';

/**
 * Connection label → what the player is told. Anything unknown falls through to a
 * neutral line in setConnection rather than rendering a raw enum, so the transport
 * gaining a state cannot break this module.
 *
 * Every key here has a live caller, and the list was pruned to make that true:
 * `reconnecting`, `closed` and `error` used to sit here as dead branches that read
 * like live states. NetClient has no such state (its JSDoc at NetClient.js:63 and
 * :87 enumerates exactly 'offline' | 'connecting' | 'online'), emits no
 * 'reconnecting' event, and main.js's net.on('close') handler passes `net.state`,
 * which is still 'online' at the moment 'close' is emitted (NetClient.js:284-290).
 * The three were unreachable from every caller in the repo.
 *
 * `idle` is not a NetClient state either — it is this module's own pre-connect
 * label, set by the constructor before anything has been attempted.
 */
const CONNECTION = {
  idle:         { cls: 'off',  text: 'Not connected' },
  connecting:   { cls: 'wait', text: 'Reaching the server…' },
  // Two keys for one state, and both are genuinely used. 'online' is the state
  // NetClient's `state` getter reports and what main.js:192 passes; 'open' is the
  // name of the NetClient *event* that main.js:192 handles, and passing the event
  // name where a state name belongs is precisely the mistake that already shipped
  // here. Its symptom was silent and expensive: the unrecognised label fell
  // through to the unknown-state fallback, `live` stayed false, and Create/Join
  // sat DISABLED on a working connection with no error anywhere to contradict the
  // player's conclusion that multiplayer was broken. 'open' also has a live
  // caller today — tools/scratch/lobbycheck.mjs's DOM harness sets it — so the
  // alias is load-bearing, not vestigial. Anything that reaches CONNECTED_STATES
  // below must enable the buttons.
  open:         { cls: 'live', text: 'Connected' },
  online:       { cls: 'live', text: 'Connected' },
  offline:      { cls: 'off',  text: 'No server reachable' },
};

/**
 * The connection states in which Create and Join are meaningful. Kept as data
 * next to CONNECTION so adding a state cannot enable the buttons by accident, and
 * cannot forget to enable them either.
 */
const CONNECTED_STATES = new Set(['open', 'online']);

/** Two-part names so the default is evocative rather than "Player 7". */
const NAME_STEMS = ['Ember', 'Cinder', 'Tide', 'Frost', 'Bramble', 'Basalt',
  'Lumen', 'Umbra', 'Quartz', 'Gale', 'Mire', 'Solar', 'Thorn', 'Rime'];
const NAME_TAILS = ['kin', 'ward', 'wright', 'bane', 'song', 'mark', 'wake'];

/** Suggestion, not a mandate: short enough to leave room to edit it. */
function generatedName() {
  const a = NAME_STEMS[Math.floor(Math.random() * NAME_STEMS.length)];
  const b = NAME_TAILS[Math.floor(Math.random() * NAME_TAILS.length)];
  return `${a}${b}`;
}

/**
 * The server's cleaner (server/rooms.js cleanName) minus its final 16-character
 * clamp: the same character classes, stripped in the same order, then the same
 * whitespace collapse and trim.
 *
 * PARITY, AND THE ONE DELIBERATE DIVERGENCE. This docblock used to claim full
 * parity and did not have it. That cost three bugs, two of them a Create button
 * disabled forever with nothing visible to fix:
 *   - `abcdefghijklmnop` + U+200B counted 17, so the note read "17 characters —
 *     trim to 16." over a field that visibly held 16 characters, and Create never
 *     came back; the server strips U+200B and would have taken the name as it was.
 *   - `a` + 20 spaces + `b` counted 22 and blocked Create; the server collapses
 *     whitespace runs and reads that name as "a b", three characters.
 *   - three U+200B characters counted "3 / 16" with Create ENABLED; the server
 *     answered BAD_NAME and then dropped the following `create` on its hello gate
 *     (server/index.js:237), so the click did nothing at all.
 * Everything the server strips or collapses is therefore stripped and collapsed
 * here first, so the counter counts the characters the server will count.
 *
 * What still differs, deliberately: the server clamps a 20-character name to 16
 * and accepts it, this module refuses it and says so in the note. Silently
 * renaming a player is worse than telling them — the naming UI exists precisely
 * to let them choose which characters to lose (see #onNameInput on why there is
 * no maxlength), and tools/scratch/lobbycheck.mjs asserts that refusal. The
 * divergence is one-directional and safe in the direction that matters: every
 * name this module ENABLES survives the server's cleaner byte-identical, so no
 * enabled click can return BAD_NAME. Every name it refuses is refused visibly.
 */
function cleanName(raw) {
  // C0/C1 controls plus the invisibles the server strips (zero-width space and
  // friends, the bidi overrides, word joiner, BOM), written as escapes rather
  // than literal characters so this source file stays copy-pasteable and
  // greppable (it briefly contained a raw NUL, which made grep treat the whole
  // module as a binary file).
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    // Any run of whitespace — including the exotic Unicode spaces used to fake
    // indentation in a roster — collapses to one plain space, in the same order
    // the server does it: strip first, then collapse, then trim.
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drawn in a seat instead of a name the server should never have sent. */
const UNNAMED = 'unnamed';

/**
 * A remote player's name, as text, or UNNAMED.
 *
 * `esc` stringifies whatever it is handed instead of validating it, so a roster
 * entry with no `name` rendered the literal word "undefined" in a seat, `name:
 * null` rendered "null" (and server/index.js:358 really does assign null before
 * `hello` lands) and an object rendered "[object Object]". The type is checked
 * rather than trusted: one relaxed guard on the server and the table otherwise
 * seats a player called "null".
 */
function displayName(v) {
  if (typeof v !== 'string') return UNNAMED;
  return cleanName(v).slice(0, NAME_MAX).trim() || UNNAMED;
}

/**
 * Forgiving code normaliser. Players paste "abc-d", " AB CD ", or type with
 * caps lock off; all of those are the same code and refusing them teaches
 * nothing. Characters outside the alphabet are dropped rather than "corrected":
 * a code has no I/O/0/1, so a typed `O` has no single obvious intent (O→Q? →D?)
 * and a wrong guess would send the player to someone else's room.
 */
function normaliseCode(raw) {
  return String(raw ?? '')
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, CODE_LEN);
}

function readStoredName() {
  // Safari in private mode throws on localStorage access rather than returning
  // null. An unguarded read here took the whole overlay down with it.
  try { return cleanName(localStorage.getItem(NAME_KEY) || ''); } catch { return ''; }
}

function storeName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* nothing to do */ }
}

export class Lobby {
  /**
   * @param {HTMLElement} root element to append the overlay into
   * @param {{
   *   onCreate?: (name: string) => void,
   *   onJoin?: (name: string, code: string) => void,
   *   onReady?: (ready: boolean) => void,
   *   onStart?: () => void,
   *   onSolo?: (name: string) => void,
   *   onLeave?: () => void,
   * }} callbacks
   */
  constructor(root, callbacks = {}) {
    this.root = root;
    this.cb = callbacks;

    this.visible = false;
    this.state = 'idle';
    this.connection = 'idle';
    this.code = '';
    this.players = [];
    this.youId = null;
    /**
     * Which door the player last knocked on: 'create' | 'join' | null. The
     * server's `error` frames carry no request context, so this is the only way
     * setError can tell "this room is full" from "there are no rooms left" —
     * both arrive as ROOM_FULL. See ROOM_FULL_ON_CREATE.
     */
    this.intent = null;

    const stored = readStoredName();
    // A return visitor gets their own name back; a first-timer gets a plausible
    // one already in the field, so the whole flow is Enter-Enter and nobody has
    // to invent an identity before they are allowed to play.
    const initialName = stored || generatedName();

    root.insertAdjacentHTML('beforeend', /* html */`
      <div id="lobby" class="s-idle" role="dialog" aria-modal="true" aria-labelledby="lobby-title" hidden>
        <div class="lobby-veil"></div>
        <div class="lobby-inner">

          <header class="lobby-head">
            <div class="boot-sigil lobby-sigil" aria-hidden="true">
              <span class="boot-ring"></span>
              <span class="boot-ring inner"></span>
              <span class="boot-orbit">
                <i style="--c:#ff5a1f; --a:0deg;   --dl:0s"     >ƒ</i>
                <i style="--c:#2fa8ff; --a:60deg;  --dl:-0.55s" >≈</i>
                <i style="--c:#4fe07a; --a:120deg; --dl:-1.1s"  >❀</i>
                <i style="--c:#c08a4a; --a:180deg; --dl:-1.7s"  >◈</i>
                <i style="--c:#fff2c4; --a:240deg; --dl:-2.25s" >✦</i>
                <i style="--c:#8a4fd6; --a:300deg; --dl:-2.8s"  >●</i>
              </span>
              <span class="boot-core"></span>
            </div>
            <p class="lobby-eyebrow">Element TD · Convergence</p>
            <h2 id="lobby-title">Shared Convergence</h2>
            <!-- No wave count in this line on purpose: the number lives in
                 TOTAL_WAVES, this module may not import from src/game/, and a
                 hardcoded "fifty" would rot silently the day it changes. -->
            <p class="lobby-sub">
              Same waves, same element offers, separate boards. Everyone solves the
              identical puzzle at the same time — last one standing wins the table.
            </p>
          </header>

          <p class="lobby-conn" id="lobby-conn" aria-live="polite">
            <i class="lc-dot"></i><span id="lobby-conn-text">Not connected</span>
          </p>

          <p class="lobby-error" id="lobby-error" role="alert" aria-live="assertive" hidden></p>

          <section class="lobby-card" id="lobby-entry">
            <div class="lobby-field">
              <label class="lobby-legend" for="lobby-name">Your name</label>
              <input id="lobby-name" class="lobby-input" type="text" autocomplete="nickname"
                     spellcheck="false" aria-describedby="lobby-name-note" />
              <span class="lobby-note" id="lobby-name-note">Up to ${NAME_MAX} characters.</span>
            </div>

            <div class="lobby-split">
              <div class="lobby-half">
                <span class="lobby-legend">Start a table</span>
                <button id="lobby-create" class="lobby-btn primary">
                  <b>Create room</b><span>you become the host</span>
                </button>
              </div>
              <div class="lobby-or" aria-hidden="true"><span>or</span></div>
              <div class="lobby-half">
                <label class="lobby-legend" for="lobby-code-in">Join with a code</label>
                <div class="lobby-joinrow">
                  <input id="lobby-code-in" class="lobby-input code" type="text" inputmode="text"
                         spellcheck="false" autocomplete="off" placeholder="————"
                         aria-describedby="lobby-code-note" />
                  <button id="lobby-join" class="lobby-btn">Join</button>
                </div>
                <span class="lobby-note" id="lobby-code-note">Four characters. Spaces and dashes are ignored.</span>
              </div>
            </div>
          </section>

          <section class="lobby-card" id="lobby-room">
            <div class="lobby-codeblock">
              <span class="lobby-legend">Room code</span>
              <button id="lobby-copy" class="lobby-code" aria-describedby="lobby-copy-note">
                <span class="lobby-code-chars" id="lobby-code-chars"></span>
                <span class="lobby-copy-hint">copy</span>
              </button>
              <span class="lobby-note" id="lobby-copy-note" aria-live="polite">Click the code to copy it, then send it to a friend.</span>
            </div>

            <div class="lobby-rosterwrap">
              <div class="lobby-rosterhead">
                <span class="lobby-legend">Table</span>
                <span class="lobby-count" id="lobby-count"></span>
              </div>
              <ul class="lobby-roster" id="lobby-roster"></ul>
            </div>

            <div class="lobby-actions">
              <button id="lobby-ready" class="lobby-btn" aria-pressed="false">Ready</button>
              <button id="lobby-start" class="lobby-btn primary" hidden>Begin the run</button>
              <button id="lobby-leave" class="lobby-btn ghost">Leave</button>
            </div>
            <p class="lobby-note wide" id="lobby-start-note" aria-live="polite"></p>
          </section>

          <section class="lobby-card offline-only" id="lobby-offline">
            <p class="lobby-offline-line">
              No multiplayer server answered. Nothing is broken — multiplayer is an
              option, not a dependency, and the full game is right here.
            </p>
            <p class="lobby-note wide">Run <code>npm run server</code> on this machine to host a table.</p>
          </section>

          <footer class="lobby-foot">
            <button id="lobby-solo" class="lobby-btn solo">
              <b>Play solo</b><span>no server needed</span>
            </button>
            <span class="lobby-keys"><kbd>Enter</kbd> confirm · <kbd>Esc</kbd> back</span>
          </footer>
        </div>
      </div>`);

    const q = (sel) => root.querySelector(sel);
    this.$el = q('#lobby');
    this.$name = q('#lobby-name');
    this.$nameNote = q('#lobby-name-note');
    this.$codeIn = q('#lobby-code-in');
    this.$create = q('#lobby-create');
    this.$join = q('#lobby-join');
    this.$solo = q('#lobby-solo');
    this.$ready = q('#lobby-ready');
    this.$start = q('#lobby-start');
    this.$startNote = q('#lobby-start-note');
    this.$leave = q('#lobby-leave');
    this.$copy = q('#lobby-copy');
    this.$copyNote = q('#lobby-copy-note');
    this.$codeChars = q('#lobby-code-chars');
    this.$roster = q('#lobby-roster');
    this.$rosterCount = q('#lobby-count');
    this.$conn = q('#lobby-conn');
    this.$connText = q('#lobby-conn-text');
    this.$error = q('#lobby-error');

    this.$name.value = initialName;

    this.$name.addEventListener('input', () => this.#onNameInput());
    this.$codeIn.addEventListener('input', () => {
      // Rewriting the value on every keystroke is what makes the field
      // forgiving: the player sees the canonical code appear as they type
      // instead of being told afterwards that their code was malformed.
      const before = this.$codeIn.value;
      const after = normaliseCode(before);
      if (after !== before) this.$codeIn.value = after;
      this.#sync();
    });

    this.$create.addEventListener('click', () => this.#create());
    this.$join.addEventListener('click', () => this.#join());
    this.$solo.addEventListener('click', () => this.#solo());
    this.$ready.addEventListener('click', () => this.#toggleReady());
    this.$start.addEventListener('click', () => { this.setError(null); this.cb.onStart?.(); });
    this.$leave.addEventListener('click', () => this.#leave());
    this.$copy.addEventListener('click', () => this.#copyCode());

    // Capture on document, and swallow every key while the overlay is up.
    // Without the swallow, Space and F reach BuildBar's window listener behind
    // the veil: typing a name that contains an "f" toggled the Tower Table
    // under the lobby, and Space queued a wave before the run existed.
    this._onKey = (e) => this.#onKey(e);
    document.addEventListener('keydown', this._onKey, true);

    this.#onNameInput();
    this.setConnection('idle');
    this.#sync();
  }

  // -- lifecycle -----------------------------------------------------------

  show() {
    this.visible = true;
    this.$el.hidden = false;
    // One frame of `hidden` removal before the class, or the entrance
    // transition never runs — the element goes from display:none straight to
    // its final state and the overlay appears to snap in.
    //
    // The visibility re-check is not belt-and-braces: hide() inside that one
    // frame (a `go` or a solo click landing in the same frame as a show(), which
    // is reachable) left the overlay at {open:true, hidden:true}, and because
    // .open was already on the element the NEXT show() had no class to add and
    // no transition to run — reintroducing exactly the snap-in this rAF exists
    // to prevent.
    requestAnimationFrame(() => { if (this.visible) this.$el.classList.add('open'); });
    this.#focusFirst();
  }

  hide() {
    this.visible = false;
    this.$el.classList.remove('open');
    this.$el.hidden = true;
  }

  /** Drop the document-level key shield. Call before discarding the overlay. */
  destroy() {
    document.removeEventListener('keydown', this._onKey, true);
    this.$el.remove();
    this.visible = false;
  }

  // -- setters -------------------------------------------------------------

  /** @param {'idle'|'connecting'|'lobby'|'offline'} s */
  setState(s) {
    // Only a real transition moves focus. main.js legitimately sets the same
    // state more than once — setState('idle') runs on every NetClient 'open',
    // which is re-emitted on every reconnect, and again when connect() settles —
    // and the unconditional #focusFirst() meant a socket blip while a player was
    // typing a room code moved the caret from #lobby-code-in to #lobby-name
    // mid-word, so the rest of the code went into the name field. Measured:
    // {"before":"lobby-code-in","after":"lobby-name"} from one redundant call.
    const changed = s !== this.state;
    this.state = s;
    for (const k of ['idle', 'connecting', 'lobby', 'offline']) {
      this.$el.classList.toggle(`s-${k}`, k === s);
    }
    // Arriving in a room or falling back to offline both invalidate whatever
    // the previous state was complaining about.
    if (s === 'lobby' || s === 'offline') this.setError(null);
    this.#sync();
    if (this.visible && changed) this.#focusFirst();
  }

  /**
   * @param {Array<{id:string,name:string,host?:boolean,ready?:boolean}>} players
   * @param {string|null} youId
   */
  setPlayers(players, youId = this.youId) {
    this.players = Array.isArray(players) ? players : [];
    this.youId = youId ?? null;
    this.#roster();
    this.#sync();
  }

  setCode(code) {
    this.code = normaliseCode(code);
    this.#renderCode();
  }

  /**
   * @param {string|null} code one of the six contract codes, or null to clear
   * @param {string} [msg] the server's own wording, used only for codes we do
   *                       not recognise — so a future error code still says
   *                       something rather than vanishing silently.
   */
  setError(code, msg = '') {
    if (!code) {
      this.$error.hidden = true;
      this.$error.textContent = '';
      return;
    }
    const sentence = (code === 'ROOM_FULL' && this.intent === 'create')
      ? ROOM_FULL_ON_CREATE
      : ERRORS[code] || cleanName(msg) || 'Something went wrong talking to the server.';
    // textContent, not innerHTML: `msg` is server-supplied and this is the one
    // place an error string could smuggle markup in.
    this.$error.textContent = sentence;
    this.$error.hidden = false;
  }

  /** @param {string} state a NetClient state name */
  setConnection(state) {
    this.connection = state;
    const info = CONNECTION[state] || { cls: 'off', text: 'Connection state unknown' };
    this.$conn.dataset.conn = info.cls;
    this.$connText.textContent = info.text;
    this.#sync();
  }

  // -- intent --------------------------------------------------------------

  /** The cleaned name, or '' if what is in the field is not usable. */
  get name() {
    const n = cleanName(this.$name.value);
    return n.length >= NAME_MIN && n.length <= NAME_MAX ? n : '';
  }

  #onNameInput() {
    const n = cleanName(this.$name.value);
    const over = n.length > NAME_MAX;
    // A name that cleans away to nothing is the case that used to be silent:
    // three zero-width characters counted "3 / 16", Create looked available, and
    // the server refused the name. Now the field says why it is refusing, so
    // there is never a disabled Create with no visible cause.
    const emptied = n.length === 0 && this.$name.value.length > 0;
    // The field has no maxlength on purpose. maxlength silently eats the
    // keystroke, which reads as a broken keyboard; a visible count that turns
    // gold at the limit tells the player what the rule is and lets them choose
    // which characters to lose.
    this.$nameNote.textContent = over
      ? `${n.length} characters — trim to ${NAME_MAX}.`
      : emptied
        ? 'Nothing visible in that name — spaces and invisible characters do not count.'
        : `${n.length} / ${NAME_MAX} characters.`;
    this.$name.classList.toggle('over', over || emptied);
    this.$nameNote.classList.toggle('bad', over || emptied);
    if (n && !over) storeName(n);
    this.#sync();
  }

  #create() {
    if (!this.name) return this.#nudgeName();
    this.setError(null);
    this.intent = 'create';
    this.cb.onCreate?.(this.name);
  }

  #join() {
    if (!this.name) return this.#nudgeName();
    const code = normaliseCode(this.$codeIn.value);
    if (code.length !== CODE_LEN) {
      this.$codeIn.focus();
      this.$codeIn.classList.add('shake');
      setTimeout(() => this.$codeIn.classList.remove('shake'), 400);
      return;
    }
    this.setError(null);
    this.intent = 'join';
    this.cb.onJoin?.(this.name, code);
  }

  #solo() {
    // Deliberately does NOT require a valid name: solo has no roster to render
    // a name into, and refusing to start a single-player game over a text
    // field would be the most annoying bug in the project.
    this.cb.onSolo?.(this.name || generatedName());
  }

  #toggleReady() {
    const you = this.#you();
    const next = !(you && you.ready);
    // Optimism is deliberate: the button reflects the intent immediately and
    // the next `lobby` broadcast is the authority. Waiting for the round trip
    // made the toggle feel broken on a 120 ms link.
    this.$ready.setAttribute('aria-pressed', String(next));
    this.$ready.classList.toggle('on', next);
    this.cb.onReady?.(next);
  }

  #leave() {
    // The local state flips without waiting for the server. If the socket is
    // already dead there is no broadcast coming, and an overlay stuck showing a
    // room you have left is worse than being one frame ahead of the truth.
    this.setError(null);
    this.cb.onLeave?.();
    if (this.state === 'lobby' || this.state === 'connecting') this.setState('idle');
  }

  #nudgeName() {
    this.$name.focus();
    this.$name.select();
    this.$name.classList.add('shake');
    setTimeout(() => this.$name.classList.remove('shake'), 400);
  }

  async #copyCode() {
    if (!this.code) return;
    try {
      await navigator.clipboard.writeText(this.code);
      this.$copyNote.textContent = `${this.code} copied — send it to a friend.`;
      this.$copy.classList.add('copied');
      setTimeout(() => this.$copy.classList.remove('copied'), 1400);
    } catch {
      // clipboard-write is refused on insecure origins and without a user
      // gesture in some browsers. Selecting the text is the honest fallback:
      // the player finishes the job with one keystroke instead of reading an
      // apology.
      const r = document.createRange();
      r.selectNodeContents(this.$codeChars);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      this.$copyNote.textContent = 'Code selected — press ⌘C / Ctrl-C to copy.';
    }
  }

  // -- keyboard ------------------------------------------------------------

  #onKey(e) {
    if (!this.visible) return;
    // Shield first, decide second (see the listener comment in the ctor).
    e.stopPropagation();

    if (e.key === 'Escape') {
      e.preventDefault();
      // In a room or mid-connect, Escape means "back out of this". In `idle`
      // there is nothing to back out of and the overlay is the boot gate, so
      // Escape must not dismiss it into a game that has not been chosen yet.
      if (this.state === 'lobby' || this.state === 'connecting') this.#leave();
      return;
    }

    // The Tab trap that aria-modal="true" promises. Without it the attribute was
    // a lie: with the lobby open, four Tab presses from "Play solo" walked focus
    // onto #pause-btn, #send-wave, #codex-toggle and a speed button — invisible
    // controls under the veil, all of them Space/Enter-activatable, so a
    // keyboard-only player could pause or queue a wave before the run existed.
    // The ctor's keydown shield could not catch this one because Tab needs no
    // listener to leak; the browser moves focus by itself.
    if (e.key === 'Tab') {
      const items = this.#focusables();
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement);
      // at === -1 means focus is already outside the overlay (a stale focus from
      // before show(), or a click on the veil): pull it back to the near end.
      const next = e.shiftKey
        ? (at <= 0 ? items.length - 1 : at - 1)
        : (at === -1 || at === items.length - 1 ? 0 : at + 1);
      items[next].focus();
      return;
    }

    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;

    // Buttons already do the right thing with Enter; intercepting would double
    // fire the action. Only the text fields need a submit mapping.
    if (e.target === this.$name) {
      e.preventDefault();
      // Enter on the name field means "the obvious next thing": join if a
      // complete code is already sitting there, otherwise host.
      if (normaliseCode(this.$codeIn.value).length === CODE_LEN) this.#join();
      else if (this.state === 'offline') this.#solo();
      else this.#create();
    } else if (e.target === this.$codeIn) {
      e.preventDefault();
      this.#join();
    }
  }

  /**
   * The overlay's own tab ring, in document order.
   *
   * `offsetParent === null` is the cheap test that rules out the two cards the
   * current state hides: three of the four sections are display:none at any
   * moment (see the .s-* rules in lobby.css), and trapping Tab onto a Ready
   * button inside a display:none card would be a worse bug than the leak this
   * replaces — focus would vanish with nothing on screen to show where it went.
   * Disabled controls are excluded by the selector for the same reason.
   */
  #focusables() {
    const sel = 'button:not([disabled]), input:not([disabled]), select:not([disabled]),'
      + ' textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    return [...this.$el.querySelectorAll(sel)].filter((n) => n.offsetParent !== null);
  }

  #focusFirst() {
    // Focus what the player is most likely to act on next, not the first
    // tabbable node: in a room that is the ready toggle, not the room code.
    const target = this.state === 'lobby' ? this.$ready
      : this.state === 'offline' ? this.$solo
        : this.$name;
    // A focus() during the same frame as `hidden = false` is dropped by
    // Chrome, so it waits for the element to actually be laid out.
    requestAnimationFrame(() => { if (this.visible) target.focus(); });
  }

  // -- rendering -----------------------------------------------------------

  #you() {
    return this.players.find((p) => p.id === this.youId) || null;
  }

  /**
   * Room code, one character per cell.
   *
   * The code is server-generated from a 32-character alphabet, so in practice it
   * cannot contain markup — but it arrives over a socket from another machine,
   * and "in practice" is not a security property. It goes through `esc` like
   * every other remote string.
   */
  #renderCode() {
    this.$codeChars.innerHTML = this.code
      ? this.code.split('').map((c) => `<i>${esc(c)}</i>`).join('')
      : '<i class="pending">·</i>'.repeat(CODE_LEN);
    this.$copy.disabled = !this.code;
    this.$copy.setAttribute('aria-label', this.code
      ? `Copy room code ${this.code.split('').join(' ')}`
      : 'Room code not assigned yet');
  }

  /**
   * The roster.
   *
   * EVERY player name here goes through `esc` before it reaches innerHTML — a
   * name is untrusted input from another machine and is the single most obvious
   * XSS vector in the project (docs/MULTIPLAYER.md says so explicitly). Note
   * also that no name is interpolated into an attribute: `esc` does not escape
   * the single quote, so a name in a `title='…'` would still be an escape
   * hatch. Names go in text position only.
   */
  #roster() {
    // Clamped to the contract. A roster of 9 rendered 9 rows and a count reading
    // "9 / 6" — a table that contradicts the limit printed beside it, from a
    // module whose stated job is to render untrusted remote input safely. The
    // server caps rooms at 6, so this needs a non-conforming or future server;
    // that is exactly the input this module is not allowed to trust.
    const seated = this.players.slice(0, MAX_PLAYERS);
    const rows = seated.map((raw, i) => {
      // The name is validated into a string before anything renders it, so the
      // only thing `esc` still has to do is escape. It used to do both, badly:
      // esc() stringifies, so a seat with no name printed "undefined".
      const p = { ...raw, name: displayName(raw?.name) };
      const you = p.id === this.youId;
      const cls = ['lb-row'];
      if (you) cls.push('you');
      if (p.ready) cls.push('ready');
      return `<li class="${cls.join(' ')}">
        <span class="lb-slot">${i + 1}</span>
        <span class="lb-name">${esc(p.name)}</span>
        ${p.host ? '<span class="lb-tag host">host</span>' : ''}
        ${you ? '<span class="lb-tag you">you</span>' : ''}
        <span class="lb-state">${p.ready ? 'ready' : 'waiting'}</span>
      </li>`;
    });

    // Empty seats are drawn rather than left blank: the gap is what makes the
    // room code above read as an invitation instead of a serial number.
    for (let i = seated.length; i < MAX_PLAYERS; i++) {
      rows.push(`<li class="lb-row open"><span class="lb-slot">${i + 1}</span>
        <span class="lb-name">open seat</span></li>`);
    }

    this.$roster.innerHTML = rows.join('');
    this.$rosterCount.textContent = `${seated.length} / ${MAX_PLAYERS}`;
  }

  /**
   * Why the run cannot begin yet, as a sentence, or '' when it can.
   *
   * There is deliberately no "you need at least two players" rule here. The
   * contract does not have one, and inventing a stricter client rule would
   * disable a button for an action the server would happily accept — which the
   * player experiences as a bug, not as guidance.
   */
  #startBlocker() {
    const you = this.#you();
    if (!you) return 'Waiting for the server to seat you.';
    if (!you.host) {
      const host = this.players.find((p) => p.host);
      // displayName here for the same reason as in #roster: "undefined is the
      // host and starts the run." is a sentence this used to be able to print.
      return host ? `${displayName(host.name)} is the host and starts the run.` : 'The host starts the run.';
    }
    const waiting = this.players.filter((p) => !p.ready);
    if (waiting.length) {
      return waiting.length === 1
        ? `Waiting on ${displayName(waiting[0].name)}.`
        : `Waiting on ${waiting.length} players.`;
    }
    return '';
  }

  /** Re-derive every enabled/visible/label state from the fields we hold. */
  #sync() {
    const nameOk = !!this.name;
    const codeOk = normaliseCode(this.$codeIn.value).length === CODE_LEN;
    const busy = this.state === 'connecting';
    const live = CONNECTED_STATES.has(this.connection);

    // Create/Join are pointless without a socket, and a button that fires into
    // a dead socket produces a silence the player has to interpret.
    this.$create.disabled = busy || !nameOk || !live;
    this.$join.disabled = busy || !nameOk || !codeOk || !live;
    // The text fields stay live through the whole connection attempt. They were
    // disabled while `busy`, and main.js sets 'connecting' before it calls
    // net.connect(), whose OPEN_TIMEOUT_MS is 2500 ms with retries behind it —
    // so for seconds after boot the player could not type the two things that
    // never need a server. Multiplayer is an option, not a dependency
    // (docs/MULTIPLAYER.md); a socket attempt must not gate local input. The
    // buttons above still wait, because those genuinely need the socket.

    const you = this.#you();
    const isHost = !!(you && you.host);
    this.$ready.classList.toggle('on', !!(you && you.ready));
    this.$ready.setAttribute('aria-pressed', String(!!(you && you.ready)));
    this.$ready.textContent = you && you.ready ? 'Ready ✓' : 'Ready';

    // Non-hosts never see the Start button: a permanently disabled control
    // reads as "this is your job and it is broken". The note tells them whose
    // job it actually is.
    this.$start.hidden = !isHost;
    const blocker = this.state === 'lobby' ? this.#startBlocker() : '';
    this.$start.disabled = !!blocker;
    // Sentences here are built from player names, so this must stay
    // textContent — see #roster on why names never touch innerHTML.
    this.$startNote.textContent = this.state === 'lobby' ? blocker : '';

    // Solo is the primary action the moment multiplayer is not on offer.
    this.$solo.classList.toggle('primary', this.state === 'offline' || !live);
  }
}
