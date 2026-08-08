/**
 * THE RITE REGISTRY — the single place a new minigame is announced.
 *
 * Adding a rite is one import and one entry in RITES. Nothing else in the
 * codebase names a rite: the schedule shuffles whatever is here, the host looks
 * up whatever is here, and the dev panel lists whatever is here.
 *
 * ORDER IS PART OF THE SEED CONTRACT. MINIGAME_IDS is fed to pickN inside
 * schedule.js, and pickN's output depends on the order of its input. Reordering
 * this array therefore changes which rite every existing seed produces. That is
 * harmless for a fresh run and fatal mid-room, so treat it the way you would
 * treat reordering ELEMENT_IDS: APPEND, DO NOT SHUFFLE — FROM THIS BASELINE.
 *
 * THE RULE WAS BROKEN EXACTLY ONCE, ON PURPOSE. The first four rites (forge,
 * verdict, coulee, hearth) were invented because the real contents of Ryoko TD's
 * interludes were not documented anywhere. They were not what had been asked
 * for, so they were deleted outright and the six below replaced them in a SINGLE
 * commit — never an intermediate state with ten ids, which would have shipped a
 * build whose schedule could deal a rite that was about to stop existing.
 *
 * That was safe for one reason and one reason only: NOTHING PERSISTS A RITE ID.
 * Verified rather than assumed — the only durable storage this game has is
 * `localStorage`, and it holds exactly three things: the render preset
 * (src/main.js), the player's display name (src/ui/Lobby.js) and the personal
 * best record `{score, wave, won, at}` (src/net/BestScore.js). No run state, no
 * seed, no rite. A returning player therefore cannot land on a dangling id.
 * Re-check that claim before ever breaking this rule again; the day something
 * does persist a seed mid-run, "append only" stops being a style preference.
 *
 * A PROPERTY WORTH KNOWING: a scripted run fires 11 rites (schedule.js, waves
 * 3..53 every 5) over 6 ids, and riteForWave deals from a fresh full shuffle per
 * cycle of `ids.length`. So occurrences 0-5 are cycle 0 — all six, in seed
 * order — and occurrences 6-10 are cycle 1, slots 0..4. EVERY RUN PLAYS ALL SIX:
 * five of them twice, one of them exactly once. This needs no special-casing
 * anywhere; schedule.js's existing cycle arithmetic produces it for free.
 *
 * Pure module. No DOM, no three.js — imported by tests/unit.
 */

import { HEAVEN_RITE } from './rites/HeavenRite.js';
import { PLATFORMS_RITE } from './rites/PlatformsRite.js';
import { LUCKY_SHOT_RITE } from './rites/LuckyShotRite.js';
import { OFFROAD_RITE } from './rites/OffroadRite.js';
import { HUNT_RITE } from './rites/HuntRite.js';
import { FISHING_RITE } from './rites/FishingRite.js';

/** @type {Record<string, import('./contract.js').MinigameDef>} */
export const RITES = {
  [HEAVEN_RITE.id]: HEAVEN_RITE,
  [PLATFORMS_RITE.id]: PLATFORMS_RITE,
  [LUCKY_SHOT_RITE.id]: LUCKY_SHOT_RITE,
  [OFFROAD_RITE.id]: OFFROAD_RITE,
  [HUNT_RITE.id]: HUNT_RITE,
  [FISHING_RITE.id]: FISHING_RITE,
};

/** Append-only from here on. See the docblock. */
export const MINIGAME_IDS = Object.freeze([
  'heaven', 'platforms', 'luckyshot', 'offroad', 'hunt', 'fishing',
]);

/** @returns {?import('./contract.js').MinigameDef} */
export function riteDef(id) {
  return RITES[id] ?? null;
}

// A registry whose id list has drifted from its table is a silent 404 at the
// worst possible moment — mid-run, on someone else's seed. Cheap to check here,
// impossible to notice later.
for (const id of MINIGAME_IDS) {
  if (!RITES[id]) throw new Error(`[minigames] MINIGAME_IDS lists '${id}' but RITES has no such entry`);
}
for (const id of Object.keys(RITES)) {
  if (!MINIGAME_IDS.includes(id)) throw new Error(`[minigames] RITES has '${id}' but MINIGAME_IDS does not list it`);
}
