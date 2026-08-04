/**
 * The server's global top scores, as a one-slot broadcast.
 *
 * WHY THIS EXISTS AT ALL
 *
 * `leaderboard` frames land in exactly one place — main.js hands them to
 * `HUD.setLeaderboard` — and until now the only surface that read them was the
 * end card. The lobby wants the same list, and the lobby is constructed by
 * main.js with a fixed callback object it does not get to extend. Reaching for
 * the HUD from Lobby.js is not an option either: HUD.js pulls in three.js and
 * half of src/game, and the lobby is deliberately importable in node (see the
 * docblock in Lobby.js and tools/scratch/lobbycheck.mjs).
 *
 * So: one tiny module both sides may import, with no DOM and no imports of its
 * own. The HUD publishes what the transport gave it; the lobby subscribes.
 * Nothing here talks to the network, and nothing here is a cache with a policy —
 * it holds the last frame and says whether one ever arrived, which is the
 * distinction the lobby needs to tell "still loading" from "the board is empty".
 *
 * Import is side-effect free (module state only), so it costs nothing to anyone
 * who does not use it.
 */

/** @typedef {{ name: string, score: number, wave: number, won?: boolean }} TopEntry */

/** @type {TopEntry[]} */
let list = [];
/**
 * Has a frame EVER arrived? An empty list is a real answer — a fresh server
 * with nobody on the board — and it must not read as "still waiting", which is
 * the difference between a spinner that ends and one that does not.
 */
let received = false;
/** @type {Set<(list: TopEntry[], received: boolean) => void>} */
const listeners = new Set();

/** The last board the server sent, plus whether it ever sent one. */
export function getTop() {
  return { list, received };
}

/**
 * Publish a `leaderboard` frame. Called by HUD.setLeaderboard, which is where
 * main.js routes the transport.
 *
 * A non-array is treated as an empty board rather than ignored: the frame did
 * arrive, and pretending otherwise would leave every subscriber on a spinner
 * forever because of one malformed message.
 */
export function publishTop(next) {
  list = Array.isArray(next) ? next : [];
  received = true;
  for (const fn of listeners) {
    // One bad subscriber must not stop the others being told.
    try { fn(list, received); } catch { /* a panel's problem, not the feed's */ }
  }
}

/**
 * Subscribe. Fires immediately with whatever is already held, so a panel built
 * after the frame arrived is not blank until the next one.
 *
 * @returns {() => void} unsubscribe
 */
export function subscribeTop(fn) {
  listeners.add(fn);
  try { fn(list, received); } catch { /* as above */ }
  return () => listeners.delete(fn);
}
