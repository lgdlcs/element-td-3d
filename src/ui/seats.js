/**
 * Per-player identity colours.
 *
 * ONE idea appearing in two places, never two unrelated decorations: the colour
 * that paints a scoreboard row's left border is the same colour that washes the
 * frame while you watch that player, so "the blue player" is a thing you learn
 * once. Split across files it would drift within a week.
 *
 * Indexed by SEAT — the player's position in the room roster — and not by rank,
 * score or any other quantity that moves. A colour that changed when someone
 * overtook someone else would be a colour that identifies nothing.
 *
 * Six entries because a room holds at most six players (server/rooms.js). They
 * are chosen to stay distinct against the board's warm desaturated stone and to
 * survive the grade pass, and none of them is the reserved hostile red that
 * creeps/palette.js owns.
 */
export const SEAT_COLORS = [0x4aa3ff, 0xff8a3d, 0x5fe08a, 0xc98bff, 0xffd45e, 0xff6b8a];

/**
 * Seat colour for a player id, given the roster order it arrived in.
 * Falls back to seat 0 for an id that is not in the roster — an unknown player
 * is better rendered in the first colour than in no colour.
 *
 * @param {string} id
 * @param {Array<{id: string}>} roster
 * @returns {number} sRGB hex
 */
export function seatColor(id, roster) {
  const i = Array.isArray(roster) ? roster.findIndex((p) => String(p.id) === String(id)) : -1;
  return SEAT_COLORS[(i < 0 ? 0 : i) % SEAT_COLORS.length];
}

/** The same value as a CSS colour string. */
export const seatCss = (hex) => `#${(hex >>> 0).toString(16).padStart(6, '0')}`;
