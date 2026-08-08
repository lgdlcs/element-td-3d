/**
 * WHEN A RITE HAPPENS, AND WHICH ONE.
 *
 * A pure function of (seed, wave) and nothing else. Two players in the same room
 * must be handed the same rite on the same wave with the same layout — that is
 * the entire fairness claim of this feature (docs/MULTIPLAYER.md: the server
 * simulates nothing, so the seed is the only thing holding two boards together).
 * Nothing in this file may read player state, the clock, or Math.random.
 *
 * No DOM, no three.js: `tests/unit/minigames.test.js` imports it directly.
 */

import { MINIGAMES, ECONOMY } from '../core/Config.js';
import { TOTAL_WAVES } from '../game/Waves.js';
import { rngFor, pickN } from '../core/Rng.js';
import { MINIGAME_IDS } from './registry.js';

/**
 * Does clearing wave `n` open a rite?
 *
 * The offset is what keeps this off the element-pick waves — see the MINIGAMES
 * docblock in Config.js. The assertion below is not decoration: someone will one
 * day "tidy" everyWaves to 6, and the resulting collision (wave 30 grants an
 * element AND a rite) produces two stacked modals, which is exactly the failure
 * this cadence was chosen to make impossible. Fail at import time instead.
 */
if (MINIGAMES.everyWaves % ECONOMY.elementEveryWaves !== 0
    || MINIGAMES.waveOffset % ECONOMY.elementEveryWaves === 0) {
  throw new Error(
    '[minigames] cadence would collide with element picks: everyWaves must be a '
    + 'multiple of ECONOMY.elementEveryWaves and waveOffset must not be.');
}

/** True when wave `n`, once cleared, is followed by a rite. */
export function isRiteWave(n) {
  if (!Number.isFinite(n) || n < MINIGAMES.firstWave) return false;
  // The last wave ends the run in victory before any interlude can run, so a
  // rite scheduled there would be scheduled into a screen nobody sees.
  if (n >= TOTAL_WAVES) return false;
  return n % MINIGAMES.everyWaves === MINIGAMES.waveOffset % MINIGAMES.everyWaves;
}

/**
 * How many rites have come before this one. 0 for the first.
 * Feeds the RNG index, so it must advance by exactly one per rite and must be
 * derivable from the wave alone — never from a counter on the player's state,
 * which would diverge the moment one player skipped a rite the other played.
 */
export function riteOccurrence(n) {
  return Math.floor((n - MINIGAMES.waveOffset) / MINIGAMES.everyWaves);
}

/**
 * The rite due after wave `n`, or null.
 *
 * ROTATION BY SEEDED SHUFFLE, not by `occurrence % ids.length`.
 *
 * A plain modulo gives every player in every room the same rite order forever,
 * which makes the third run of the day a rerun. A fresh draw per occurrence goes
 * too far the other way: independent draws over three ids produce a doubled rite
 * about a third of the time, and "the same one three times running" is how a
 * bonus becomes a chore. Shuffling the whole registry once per cycle and dealing
 * from it gives both properties — each rite appears exactly once per cycle, and
 * the order is the seed's, not the code's.
 *
 * The one thing it does NOT guarantee is a change across a cycle boundary: the
 * last rite of one shuffle can equal the first of the next, so a back-to-back
 * repeat happens on roughly 1 in N cycle boundaries. Fixing that would mean
 * making the draw depend on the previous cycle's result, i.e. a chain, i.e.
 * exactly the "one stream for the whole run" hazard Rng.js's docblock warns
 * against. Stated rather than papered over.
 *
 * @param {number} seed uint32 run seed
 * @param {number} n    the wave just cleared
 * @returns {?{id: string, wave: number, occurrence: number}} `wave` is the wave
 *   about to be prepared, i.e. n + 1.
 */
export function riteForWave(seed, n) {
  if (!isRiteWave(n)) return null;
  const occurrence = riteOccurrence(n);
  const ids = MINIGAME_IDS;
  if (ids.length === 0) return null;

  const cycle = Math.floor(occurrence / ids.length);
  const slot = occurrence - cycle * ids.length;
  // Exactly ids.length rand() calls, always — pickN with n === length is a full
  // shuffle and consumes a fixed count regardless of anything about the player.
  const order = pickN(rngFor(seed, 'minigame-select', cycle), ids, ids.length);
  return { id: order[slot], wave: n + 1, occurrence };
}

/**
 * The generator a rite's own logic draws from.
 *
 * Labelled with the rite id so that adding, removing or reordering rites cannot
 * shift another rite's stream, and indexed by occurrence so the same rite played
 * twice in a run is two different layouts.
 */
export function riteRng(seed, id, occurrence) {
  return rngFor(seed, `minigame:${id}`, occurrence);
}
