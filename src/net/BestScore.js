/**
 * Personal best, cached on this machine.
 *
 * The store is deliberately tiny and deliberately local-first: a run must record
 * its best score with no server, no account and no network round trip, because
 * that is how the game is played most of the time. The multiplayer leaderboard
 * (see NetClient.best / server/leaderboard.js) is a SECOND, independent sink for
 * the same result — it is never read back into this one, so a server that is
 * down, slow or absent cannot lose or rewrite a local record.
 *
 * Every entry point swallows storage failures. `localStorage` throws outright in
 * Safari private mode and when a site's storage quota is exhausted, and a thrown
 * getter during boot would take the whole game with it over a scoreboard.
 */

const KEY = 'elementtd.best.v1';

/** @typedef {{ score: number, wave: number, won: boolean, at: number }} BestRecord */

const EMPTY = { score: 0, wave: 0, won: false, at: 0 };

function readRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeRaw(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

/** @returns {BestRecord} the stored best, or a zeroed record. */
export function loadBest() {
  const raw = readRaw(KEY);
  if (!raw) return { ...EMPTY };
  let v;
  // Corrupt JSON is treated as "no record" rather than as an error: the only
  // alternative is refusing to boot over a value nobody can recover anyway.
  try { v = JSON.parse(raw); } catch { return { ...EMPTY }; }
  if (!v || typeof v !== 'object') return { ...EMPTY };
  return {
    score: int(v.score),
    wave: int(v.wave),
    won: !!v.won,
    at: int(v.at),
  };
}

/**
 * Record a finished run. Returns `{ best, record }` — `record` is true only when
 * this run actually beat the stored score, which is what the end card reports.
 *
 * Ties do NOT count as a record: equalling your best is not beating it, and
 * flashing "new best" at an identical number reads as a bug.
 */
export function saveBest(result) {
  const prev = loadBest();
  const score = int(result?.score);
  if (score <= prev.score) return { best: prev, record: false };
  const next = { score, wave: int(result?.wave), won: !!result?.won, at: Date.now() };
  writeRaw(KEY, JSON.stringify(next));
  return { best: next, record: true };
}

function int(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
