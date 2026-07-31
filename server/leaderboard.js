/**
 * The global leaderboard: a top-N list of best runs, shared by every client that
 * can reach this server.
 *
 * WHY IT IS A FILE AND NOT A DATABASE
 *
 * The list is bounded at TOP_N entries of five short fields. That is a few
 * hundred bytes; anything with a connection string would be more moving parts
 * than the data justifies, and the lobby server already has no persistence story
 * to fit into. The file is written atomically (tmp + rename) so a crash mid-write
 * cannot leave a truncated JSON that refuses to parse on the next boot.
 *
 * WHY WRITES ARE DEBOUNCED
 *
 * `submit` is called once per finished run, but six players finishing a room
 * together is six calls inside a second. Debouncing collapses that burst into one
 * write while keeping the in-memory list immediately correct — readers never see
 * the delay, only the disk does.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not authenticate anything. A client reports its own score, exactly as
 * it already does for the in-room scoreboard (see docs/MULTIPLAYER.md), so the
 * list is only as honest as the clients on it. Sanitising is about keeping the
 * data well-formed and the file small, NOT about trust: names are clamped and
 * stripped, numbers are coerced to non-negative integers, and one name holds at
 * most one entry so a single player cannot occupy the whole board.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanName } from './rooms.js';

export const TOP_N = 20;

/** Ceiling on a single reported run. Anything above it is a broken or forged
 *  client, and letting it in would permanently wedge the top of the board. */
const MAX_SCORE = 100_000_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(HERE, 'leaderboard.json');

const WRITE_DEBOUNCE_MS = 750;

export class Leaderboard {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] where to persist. Pass null to stay in memory
   *        (tests, and any deployment with a read-only filesystem).
   * @param {(...a:any[]) => void} [opts.log]
   */
  constructor(opts = {}) {
    this.file = opts.file === null ? null : (opts.file || DEFAULT_FILE);
    this.log = opts.log || (() => {});
    /** @type {{name:string,score:number,wave:number,won:boolean,at:number}[]} */
    this.entries = [];
    this._timer = null;
    this.#load();
  }

  #load() {
    if (!this.file) return;
    let raw;
    try { raw = readFileSync(this.file, 'utf8'); } catch { return; }   // first boot
    let v;
    try { v = JSON.parse(raw); } catch {
      this.log('leaderboard file is not valid JSON; starting empty');
      return;
    }
    const list = Array.isArray(v) ? v : v?.entries;
    if (!Array.isArray(list)) return;
    this.entries = list.map(clean).filter(Boolean);
    this.#sort();
    this.entries.length = Math.min(this.entries.length, TOP_N);
  }

  #sort() {
    // Score, then how far they got, then who did it first — so a tie does not
    // reshuffle every time the file is re-read.
    this.entries.sort((a, b) => b.score - a.score || b.wave - a.wave || a.at - b.at);
  }

  /** The public list. Always a fresh array: callers must not mutate our state. */
  top(n = 10) {
    return this.entries.slice(0, Math.max(0, Math.min(n, TOP_N))).map((e) => ({
      name: e.name, score: e.score, wave: e.wave, won: e.won,
    }));
  }

  /**
   * Offer a finished run. Returns true if it changed the board.
   *
   * One entry per name, keeping the better run: without that, a player on a good
   * streak fills every slot and the board stops being a leaderboard.
   */
  submit(raw) {
    const e = clean(raw);
    if (!e) return false;

    const i = this.entries.findIndex((x) => x.name.toLowerCase() === e.name.toLowerCase());
    if (i >= 0) {
      if (e.score <= this.entries[i].score) return false;
      this.entries[i] = e;
    } else {
      // Not better than the worst entry on a full board — nothing to do, and in
      // particular nothing to write to disk.
      if (this.entries.length >= TOP_N
          && e.score <= this.entries[this.entries.length - 1].score) return false;
      this.entries.push(e);
    }

    this.#sort();
    this.entries.length = Math.min(this.entries.length, TOP_N);
    this.#schedulePersist();
    return true;
  }

  #schedulePersist() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.persist(); }, WRITE_DEBOUNCE_MS);
    this._timer.unref?.();
  }

  /** Write now. Safe to call at any time; never throws. */
  persist() {
    if (!this.file) return false;
    const tmp = `${this.file}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2));
      // Atomic on the same filesystem: readers see either the old file or the
      // new one, never a half-written array.
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // A read-only or full disk must not take the lobby server down — the board
      // simply stops surviving restarts.
      this.log('leaderboard persist failed', err && err.message);
      return false;
    }
  }

  /** Flush any debounced write and stop the timer. */
  close() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; this.persist(); }
  }
}

/** Coerce and validate one submitted run, or null if it is not usable. */
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanName(raw.name);
  if (!name) return null;
  const score = int(raw.score);
  if (score <= 0 || score > MAX_SCORE) return null;
  return {
    name,
    score,
    wave: Math.min(int(raw.wave), 10_000),
    won: !!raw.won,
    at: int(raw.at) || Date.now(),
  };
}

function int(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
