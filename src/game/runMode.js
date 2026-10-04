/**
 * What a run is allowed to do, by how it was started.
 *
 * A run is 'solo' or 'online', decided once in Game.beginRun and never changed.
 * Online, everyone in the room races on the same wall clock: one player at 3x
 * makes the others wait for `over`, and one player on pause holds the room open
 * forever (the server only gives up on a player after 60 s without a status,
 * and a paused client keeps sending them).
 *
 * The run keeps its mode when the socket drops mid-run, so losing the
 * connection does not unlock 3x halfway through a race.
 */
export const RUN_RULES = Object.freeze({
  solo:   Object.freeze({ speed: true,  pause: true }),
  online: Object.freeze({ speed: false, pause: false }),
});

/** @param {string} mode @returns {{speed: boolean, pause: boolean}} */
export function rulesFor(mode) {
  const rules = RUN_RULES[mode];
  if (!rules) throw new Error(`unknown run mode: ${mode}`);
  return rules;
}
