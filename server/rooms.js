/**
 * Room state for the lobby server: no `ws`, no sockets, no JSON.
 *
 * WHY THIS IS SPLIT OUT
 *
 * Every rule in docs/MULTIPLAYER.md that is easy to get subtly wrong lives here
 * — code generation, the 6-player cap, host succession, name hygiene, phase
 * gating — and none of it needs a socket to be exercised. index.js is then only
 * transport: parse, dispatch, serialise. When a bug is "the host did not move to
 * the right player", it is reproducible without opening a port.
 *
 * A `player` is a plain object with a `send(msg)` the transport layer installs.
 * This module never touches anything else on it, so a test double is two lines.
 */

/**
 * No I, O, 0 or 1 — see docs/MULTIPLAYER.md. Players read these codes aloud and
 * type them from memory, and I/1 and O/0 are the pairs that make that fail.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

export const MAX_PLAYERS = 6;
export const NAME_MAX = 16;

/**
 * Clean a name arriving from another machine.
 *
 * Returns null when nothing usable survives, which the caller turns into
 * BAD_NAME. Callers must NOT fall back to a default name: a player who managed
 * to send 16 zero-width spaces gets told no, rather than silently becoming
 * "Player 3" and wondering why.
 *
 * Control characters are stripped rather than escaped because they have no
 * legitimate use in a display name and they wreck terminal logs on the way to
 * the DOM. The C1 range (U+0080-U+009F) goes for the same reason plus one more:
 * it is invisible in every font, so it is exactly what you would use to pad a
 * name past a length check while still looking empty in the roster.
 *
 * Zero-width and bidi-format characters go too, and that is not cosmetic: an
 * all-U+200B name renders as a blank row nobody can attribute a score to, and a
 * single U+202E flips the reading direction of every name printed after it in the
 * scoreboard. Stripping them is what makes the BAD_NAME below reachable at all.
 *
 * The DOM side still has to escape the result (uikit.js `esc`) - this function
 * makes a name *sane*, it does not make it *safe*.
 */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    // Any run of whitespace (including the exotic Unicode spaces used to fake
    // indentation in a roster) collapses to one plain space.
    .replace(/\s+/g, ' ')
    .trim();
  // Clamp before the final trim so "  a<15 spaces>b " cannot smuggle a trailing
  // space past the 16-char limit.
  const clamped = stripped.slice(0, NAME_MAX).trim();
  return clamped.length ? clamped : null;
}

/**
 * The ONE coercion for every per-run counter a client claims about itself.
 *
 * It lives here, and it is used both at ingest (index.js) and in publicPlayer,
 * because the two used to disagree and the leaderboard contradicted its own
 * numbers: ingest kept any finite number via `Math.trunc`, while publicPlayer
 * emitted `p.wave | 0`. A player who sent `finished {score:1e308, wave:1e308}`
 * was therefore SORTED on 1e308 and DISPLAYED as 0, so `over` came back as
 * `standings: [["Q1",0,0],["Q2",5,5]]` — rank #1 showing 0/0 above 5/5. The same
 * wrap made `status {score:4294967303, wave:2147483648}` relay as
 * `{"score":7,"wave":-2147483648}`, i.e. a negative wave in the scoreboard.
 *
 * 0..2^31-1: these are counts (lives, score, wave, kills), nothing here is ever
 * legitimately negative, and the top of the int32 range is far past any reachable
 * score. Idempotent on purpose — applying it twice is a no-op, which is what lets
 * ranking and display be provably the same value.
 */
export function intCount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(0x7fffffff, Math.max(0, Math.trunc(n)));
}

/** uint32, which is what `go.seed` is contractually required to be. */
function randomSeed() {
  return (Math.random() * 0x100000000) >>> 0;
}

export class Room {
  constructor(code) {
    this.code = code;
    /**
     * Insertion-ordered, and that order is load-bearing: host succession is
     * "longest-present remaining player", which is just players[0] once the
     * departing host has been spliced out. Never sort this array in place.
     */
    this.players = [];
    this.hostId = null;
    /**
     * 'lobby' | 'running'. There is deliberately no 'over' STATE — `over` is a
     * frame, not a phase.
     *
     * It used to be a third stored phase, and because nothing ever left it, a
     * room that had finished a run was unjoinable forever: `join` answered
     * IN_PROGRESS / "That game has already started" about a game that was over,
     * and the roster stayed at 1 while a friend retyped the code. Meanwhile
     * `start` was allowed from 'over', so those rooms really did play round 2 —
     * only nobody new could ever be in it. Two guards (`join`, `ready`) also each
     * had to spell out which of three values counted as "not playing", and one of
     * them got it wrong. Between rounds IS the lobby, so that is the value.
     */
    this.phase = 'lobby';
    this.seed = 0;
    this.startedAt = 0;

    /**
     * Set by `status`, cleared by the server's own 2 Hz sweep. A room never
     * broadcasts from inside a message handler, so no single client's send rate
     * can drive the room's. Pending *lobby* broadcasts are tracked by index.js
     * instead: this used to be a `lobbyDirty` flag here as well, set by add() and
     * remove() only, and the result was that `ready` changes were queued for
     * broadcast and then dropped by a flag nothing had set. One owner per flag.
     */
    this.scoresDirty = false;
  }

  get full() { return this.players.length >= MAX_PLAYERS; }
  get empty() { return this.players.length === 0; }

  add(player) {
    this.players.push(player);
    player.room = this;
    resetRunState(player);
    if (this.hostId === null) this.hostId = player.id;
  }

  /** Returns true if the room is now empty and should be collected. */
  remove(player) {
    const i = this.players.indexOf(player);
    if (i < 0) return this.empty;
    this.players.splice(i, 1);
    player.room = null;
    // Host succession: players[0] is by construction the longest-present
    // remaining player. Doing this before the empty check would leave a
    // hostId pointing at a gone player in a room about to be collected, which
    // is harmless but reads like a leak in a heap dump.
    if (this.hostId === player.id) this.hostId = this.players.length ? this.players[0].id : null;
    return this.empty;
  }

  isHost(player) { return this.hostId === player.id; }

  /**
   * Begin a run. Every client gets the SAME seed in the same broadcast, because
   * the whole fairness argument of this model is that the element offers derive
   * from one shared number.
   */
  start() {
    this.seed = randomSeed();
    this.startedAt = Date.now();
    this.phase = 'running';
    for (const p of this.players) resetRunState(p);
    this.scoresDirty = false;
    return { t: 'go', seed: this.seed, at: this.startedAt };
  }

  /**
   * True once every player still present has reported `finished`. An empty room
   * is not "over" — there is nobody left to send `over` to, and reporting it
   * would race with collection.
   */
  allFinished() {
    return this.players.length > 0 && this.players.every((p) => p.finished);
  }

  /**
   * Ranking: survivors first, then further, then higher score. `won` outranks
   * score deliberately — a player who cleared wave 50 with a low score beat the
   * player who died on wave 50 with a high one, and any other order makes the
   * scoreboard argue with the game's own win condition.
   *
   * The sort keys are the STORED fields while the output is publicPlayer's, so
   * the two must be the same number. They are because both ends go through
   * intCount and it is idempotent — if you ever add an ingest path that skips it,
   * this sort silently starts ranking on a value nobody can see.
   */
  standings() {
    return this.players
      .slice()
      .sort((a, b) =>
        (b.won ? 1 : 0) - (a.won ? 1 : 0) ||
        b.wave - a.wave ||
        b.score - a.score ||
        // Stable tail so two identical results do not reorder between the
        // `scores` the client last saw and the final `over`.
        a.seq - b.seq)
      .map((p) => publicPlayer(p, this.hostId));
  }

  roster() {
    return this.players.map((p) => publicPlayer(p, this.hostId));
  }
}

/**
 * Per-run counters. Called on join AND on start, so a room that plays a second
 * round does not inherit the first round's leaderboard.
 */
export function resetRunState(player) {
  player.ready = false;
  player.lives = 0;
  player.score = 0;
  player.wave = 0;
  player.killed = 0;
  player.leaked = 0;
  player.towers = 0;
  player.finished = false;
  player.won = false;
}

/**
 * The exact `players[]` entry shape from docs/MULTIPLAYER.md, plus `towers`,
 * which `status` carries and which would otherwise be received and thrown away.
 * Unknown fields are contractually ignored, so a client that does not want it
 * costs nothing.
 */
export function publicPlayer(p, hostId) {
  return {
    id: p.id,
    name: p.name,
    host: p.id === hostId,
    ready: !!p.ready,
    // intCount, never `| 0`: see the comment on intCount. `| 0` here is what let
    // standings() sort on a value no client ever saw.
    lives: intCount(p.lives),
    score: intCount(p.score),
    wave: intCount(p.wave),
    killed: intCount(p.killed),
    leaked: intCount(p.leaked),
    towers: intCount(p.towers),
    finished: !!p.finished,
    won: !!p.won,
  };
}

export class Rooms {
  constructor() {
    /** @type {Map<string, Room>} keyed by the canonical UPPERCASE code. */
    this.map = new Map();
  }

  get size() { return this.map.size; }

  /**
   * A fresh code that is not in use. 32^4 is ~1.05M codes against at most a few
   * hundred live rooms, so the retry loop is a formality; the bound exists so a
   * pathological state (or a broken Math.random in some embedded runtime) fails
   * loudly instead of spinning the event loop forever.
   */
  create() {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LEN; i++) {
        code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
      }
      if (this.map.has(code)) continue;
      const room = new Room(code);
      this.map.set(code, room);
      return room;
    }
    return null;
  }

  /** Case-insensitive by contract; players type codes however they like. */
  get(code) {
    if (typeof code !== 'string') return null;
    return this.map.get(code.trim().toUpperCase()) || null;
  }

  collect(room) {
    if (room && room.empty) this.map.delete(room.code);
  }
}
