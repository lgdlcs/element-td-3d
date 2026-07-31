import { GRID } from '../../core/Config.js';
import { ALL_TOWERS } from '../TowerDefs.js';
import { CREEP_TYPES } from '../Creeps.js';

/**
 * The spectate snapshot wire format, and the hard validation gate in front of
 * it.
 *
 * The server relays a `snap` frame opaquely — it never reads past `t`, because
 * parsing an attacker-supplied body would put the room's CPU under the sender's
 * control (docs/MULTIPLAYER.md). So EVERY structural guarantee this file's
 * consumers rely on has to be established here, on the receiving machine.
 *
 * ------------------------------------------------------------------ the frame
 *
 *   { t:'snap', v, n, ts, w, l, g, sc, ph, pt, c[], tf?, ta?, tr?, from }
 *
 *   v    protocol version. A mismatch drops the frame; there is no negotiation.
 *   n    sequence, +1 per snapshot, reset when a new run starts.
 *   ts   the streamer's elapsed time in ms. Diagnostics and ordering only —
 *        playout is scheduled off LOCAL arrival time (see SpectateView), because
 *        two machines' clocks have no agreed relationship and never will.
 *   w l g sc   wave, lives, gold, score — the banner's readout.
 *   ph   phase, 0 prep | 1 combat | 2 pickElement | 3 ended
 *   pt   prep timer remaining, in TENTHS of a second (0 outside prep)
 *   c[]  creeps, flat, CREEP_STRIDE numbers each (below)
 *   tf   FULL tower list — a keyframe
 *   ta   towers added or level-changed since the last snapshot
 *   tr   tower ids removed since the last snapshot
 *
 * ------------------------------------------------------------------- creeps
 *
 *   [ uid, ty, qx, qz, hp100, st,  uid, ty, ... ]
 *
 *   uid    CreepManager.uid — identity that survives a slot recycle. The slot
 *          index would NOT do: it comes off a free list and two different units
 *          share index 7 inside one wave, so a spectator keyed on it lerps a
 *          dead Mite into a freshly spawned Colossus.
 *   ty     index into CREEP_TYPES
 *   qx qz  position * QUANT. 1/16 of a world unit is 1.3px at the default
 *          camera, which is under the SMAA edge width; 1/8 is 2.6px and reads
 *          as a wobble on a slow creep. The cost of the extra bit is at most one
 *          character per coordinate.
 *   hp100  hp/maxHp as an integer percent — only the RATIO is ever rendered
 *   st     bitmask: 1 slow, 2 burn, 4 poison. Boss and flight are NOT bits:
 *          both are properties of `ty`, and a second copy on the wire is a
 *          second thing that can disagree with the first.
 *
 * A flat array rather than objects because `{"uid":123,"ty":0,...}` costs ~45
 * bytes of key names per creep and buys one line of indexing.
 *
 * DELIBERATELY NOT SENT, because the spectator re-derives them exactly from
 * position, time and type: y, yaw, lean, stagger, phase, spawnT, hpGhost,
 * hitFlash, scale, vx, vz, groundY, tint, progress. That is 14 of the 20
 * per-creep fields, and sending them would roughly quadruple the payload to
 * reproduce values that are pure functions of what is already on the wire.
 *
 * Nothing about projectiles, muzzle flashes, impacts, chains or death
 * explosions is on the wire either: the spectator has tower positions, the same
 * stat tables, and creep positions, so it re-fires the board locally.
 */

/** Bump only for an incompatible change; a mismatched frame is dropped whole. */
export const SNAP_VERSION = 1;

/** Numbers per creep in `c[]`. */
export const CREEP_STRIDE = 6;

/**
 * Hard cap on creeps per snapshot, selected by highest `progress` (nearest the
 * exit — the ones the eye follows).
 *
 * Waves.js caps a wave at 30 units and WaveRunner will not start wave n+1 until
 * the board is empty, so this is never reached today. It exists so a future
 * endless mode cannot turn spectating into an amplification attack: 64 creeps
 * bounds a snapshot at ~1.7 KB, or ~3 KB on a keyframe, against the server's
 * 8 KB relay limit.
 */
export const MAX_SNAP_CREEPS = 64;

/** Position quantisation: world units -> integers. */
export const QUANT = 16;

/** Phase ids. Kept numeric on the wire; the banner is the only consumer. */
export const PH = { prep: 0, combat: 1, pick: 2, ended: 3 };

const PH_OF = { prep: PH.prep, combat: PH.combat, pickElement: PH.pick, gameover: PH.ended, victory: PH.ended, lobby: PH.prep };

/** @param {string} phase Game.state.phase @returns {number} */
export const phaseId = (phase) => PH_OF[phase] ?? PH.prep;

/** Bounds for qx/qz, derived from the board so a bad frame cannot place a creep off-world. */
const QX_MAX = GRID.width * QUANT;
const QZ_MAX = GRID.height * QUANT;

/** Wire type ids index this, so it is also the legal range for `ty`. */
export const TYPE_KEYS = Object.keys(CREEP_TYPES);

/**
 * Is `v` a finite number? `typeof` alone is not enough: `JSON.parse` happily
 * produces NaN-free numbers but a hand-built frame can carry 1e400 (Infinity),
 * and an Infinity in a position lerp poisons every subsequent frame's easing
 * with NaN — a failure that then looks like a rendering bug, three files away.
 */
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate one relayed `snap` frame.
 *
 * A frame failing ANY check is dropped WHOLE, never partially applied: a
 * half-applied snapshot corrupts the interpolation state, and the resulting
 * mess looks like a renderer bug rather than a bad frame.
 *
 * @param {*} m the parsed message
 * @param {{cols:number, rows:number}} bounds tower anchor bounds (a Grid)
 * @returns {?string} null when the frame is good, otherwise a short reason
 */
export function validateSnapshot(m, bounds) {
  if (!m || typeof m !== 'object') return 'not an object';
  if (m.v !== SNAP_VERSION) return `version ${m.v}`;
  if (!fin(m.n)) return 'no sequence';

  const c = m.c;
  if (!Array.isArray(c)) return 'creeps not an array';
  if (c.length % CREEP_STRIDE !== 0) return 'creep array length';
  if (c.length > CREEP_STRIDE * MAX_SNAP_CREEPS) return 'too many creeps';
  for (let i = 0; i < c.length; i += CREEP_STRIDE) {
    if (!fin(c[i]) || c[i] < 1 || c[i] > 0xffff) return 'creep uid';
    if (!Number.isInteger(c[i + 1]) || c[i + 1] < 0 || c[i + 1] >= TYPE_KEYS.length) return 'creep type';
    if (!fin(c[i + 2]) || Math.abs(c[i + 2]) > QX_MAX) return 'creep x';
    if (!fin(c[i + 3]) || Math.abs(c[i + 3]) > QZ_MAX) return 'creep z';
    if (!fin(c[i + 4]) || c[i + 4] < 0 || c[i + 4] > 100) return 'creep hp';
    if (!fin(c[i + 5]) || c[i + 5] < 0 || c[i + 5] > 15) return 'creep status';
  }

  for (const list of [m.tf, m.ta]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) return 'tower list';
    // The keyframe is the only unbounded field, and 384 is the tower batch's
    // instance ceiling — a board cannot legally hold more.
    if (list.length > 384) return 'too many towers';
    for (const e of list) {
      if (!Array.isArray(e) || e.length !== 5) return 'tower entry';
      const [id, key, level, cc, rr] = e;
      if (!fin(id) || id < 0) return 'tower id';
      // `Object.hasOwn`, not `in`: `'constructor' in ALL_TOWERS` is true, and a
      // frame naming it would hand a function to towerDef and crash the view.
      if (typeof key !== 'string' || !Object.hasOwn(ALL_TOWERS, key)) return 'tower key';
      const def = ALL_TOWERS[key];
      if (!Number.isInteger(level) || level < 0 || level >= def.levels.length) return 'tower level';
      if (!Number.isInteger(cc) || !Number.isInteger(rr)) return 'tower anchor';
      if (cc < 0 || rr < 0 || cc + 1 >= bounds.cols || rr + 1 >= bounds.rows) return 'tower anchor';
    }
  }

  if (m.tr !== undefined) {
    if (!Array.isArray(m.tr) || m.tr.length > 384) return 'removed list';
    for (const id of m.tr) if (!fin(id)) return 'removed id';
  }
  return null;
}

/**
 * Write the streamer's creeps into a flat wire array.
 *
 * Reuses `out` and the caller's scratch index array — this runs 10 times a
 * second forever, and the whole point of the cap above is that it is bounded,
 * not that it is cheap to allocate.
 *
 * @param {import('../Creeps.js').CreepManager} creeps
 * @param {Array<number>} out reused; its length is set, never re-created
 * @param {Array<number>} scratch reused index buffer
 */
export function encodeCreeps(creeps, out, scratch) {
  scratch.length = 0;
  for (let n = 0; n < creeps._liveCount; n++) {
    const i = creeps._live[n];
    if (creeps.alive[i]) scratch.push(i);
  }
  // Over the cap: keep the ones nearest the exit. Sorting only in the branch
  // that can never fire today keeps the common path a straight sweep.
  if (scratch.length > MAX_SNAP_CREEPS) {
    scratch.sort((a, b) => creeps.progress[b] - creeps.progress[a]);
    scratch.length = MAX_SNAP_CREEPS;
  }

  out.length = scratch.length * CREEP_STRIDE;
  for (let k = 0; k < scratch.length; k++) {
    const i = scratch[k];
    const o = k * CREEP_STRIDE;
    const maxHp = creeps.maxHp[i] || 1;
    let st = 0;
    if (creeps.slowT[i] > 0) st |= 1;
    if (creeps.burnT[i] > 0) st |= 2;
    if (creeps.poisonT[i] > 0) st |= 4;
    out[o] = creeps.uid[i];
    out[o + 1] = creeps.typeIdx[i];
    out[o + 2] = Math.round(creeps.x[i] * QUANT);
    out[o + 3] = Math.round(creeps.z[i] * QUANT);
    out[o + 4] = Math.round((creeps.hp[i] / maxHp) * 100);
    out[o + 5] = st;
  }
  return scratch.length;
}
