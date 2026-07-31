/**
 * Seeded RNG shared by the browser and the node server.
 *
 * The multiplayer model (docs/MULTIPLAYER.md) syncs a single uint32 room seed and
 * nothing else about gameplay. Fairness therefore rests entirely on this file:
 * if two machines disagree by one value, one player is offered a different
 * element than the other and the "same puzzle" claim is a lie. So the rules here
 * are stricter than they look.
 *
 * WHY MULBERRY32 AND NOT Math.random OR A LIBRARY
 *
 * `Math.random` cannot be seeded, which ends the discussion. Beyond that this
 * needed to be a generator whose entire state is one uint32 and whose every
 * operation is expressible in `|0`/`>>>` integer math, because those are the only
 * JS numeric operations specified to be bit-exact on every engine. Anything using
 * float accumulation (a Lehmer/LCG written with `%` on doubles, xorshift via
 * multiplication of large floats) is exact today and a cross-machine desync the
 * first time an engine reorders a multiply. Mulberry32 is a dozen tokens, has no
 * dependencies, and passes gjrand/PractRand at this stream length — far more than
 * a tower defence needs from three element picks per run.
 *
 * NO DOM, NO NODE APIs, EVER
 *
 * `server/index.js` imports this file. A single `window`, `performance` or
 * `crypto` reference here would crash the server at import time, and — worse than
 * crashing — a `Date.now()` or `crypto.getRandomValues()` fallback anywhere in
 * this file would silently break determinism instead. Keep it pure.
 */

/**
 * Mulberry32. `seed` is coerced to uint32, so a negative or fractional seed is a
 * valid seed rather than a source of NaN that would poison every draw.
 * @param {number} seed
 * @returns {() => number} successive floats in [0,1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // >>> 0 before the divide: `t ^ (t >>> 14)` is a *signed* int32 in JS, and
    // dividing that by 2^32 hands out negative "probabilities" about half the
    // time. Callers doing `arr[Math.floor(rand() * arr.length)]` then read
    // undefined, which is exactly the kind of bug that only shows up in the one
    // seed nobody tested.
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a, 32-bit. Not a cryptographic hash and not trying to be — it exists to
 * turn a label like 'elements' into a stable uint32 that mixes into a seed.
 *
 * `Math.imul` rather than `* 16777619`: the FNV prime times a 32-bit value
 * exceeds 2^53, so plain multiplication loses low bits to double rounding and the
 * result depends on how the engine chose to round. `imul` is defined as exact
 * 32-bit wrapping multiplication and is the only portable way to write this.
 *
 * Iterates UTF-16 code units, which is fine because the only requirement is that
 * the same string maps to the same number everywhere, not that surrogate pairs
 * are handled as characters.
 * @param {string} s
 * @returns {number} uint32
 */
export function hashStr(s) {
  const str = String(s);
  let h = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A generator derived from a numeric seed plus arbitrary labelling parts, so
 * independent uses of one room seed cannot correlate or share a stream.
 *
 *   rngFor(seed, 'elements', 3)   // pick 3's offer
 *   rngFor(seed, 'elements', 4)   // pick 4's offer — unrelated to pick 3's
 *
 * WHY NOT ONE SHARED GENERATOR PER RUN
 *
 * A single stream makes every draw depend on how many draws happened before it,
 * which means any client that consults the RNG one extra time — for a cosmetic
 * effect, a debug tool, a feature added later — desyncs every subsequent draw for
 * that player only. Deriving a fresh generator per (seed, purpose, index) makes
 * each draw addressable and order-independent, which is the property that
 * actually survives future edits to the game.
 *
 * Parts are separated by  so that ('a','bc') and ('ab','c') cannot hash to
 * the same key — without a separator they are the same byte sequence, and two
 * different call sites would quietly share a stream.
 * @param {number} seed
 * @param {...(string|number)} parts
 * @returns {() => number}
 */
export function rngFor(seed, ...parts) {
  let h = (seed >>> 0) ^ 0x9E3779B9;
  for (const p of parts) {
    // Mix, then combine: a bare XOR of the part hash would let two parts that
    // are equal cancel each other out, so rngFor(s,'a','a') === rngFor(s).
    h = (Math.imul(h ^ hashStr(p), 0x85EBCA6B) >>> 0);
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return mulberry32(h);
}

/**
 * `n` distinct items from `arr`, deterministic for a given `rand`.
 *
 * Partial Fisher-Yates over a COPY. Two things this deliberately is not:
 *
 *  - It does not mutate `arr`. Callers pass module-level constants
 *    (ELEMENT_IDS), and shuffling one of those in place would reorder it for
 *    every other reader in the process — including, on the server, every other
 *    room.
 *  - It does not "draw and retry until unique", which is unbounded work and, with
 *    n close to arr.length, is where a plausible-looking implementation starts
 *    consuming a different number of values on different machines.
 *
 * n is clamped to the array length, so pickN(rand, xs, 99) is a full shuffle
 * rather than an array padded with undefined.
 * @template T
 * @param {() => number} rand
 * @param {readonly T[]} arr
 * @param {number} n
 * @returns {T[]}
 */
export function pickN(rand, arr, n) {
  const pool = Array.from(arr);
  const take = Math.max(0, Math.min(n | 0, pool.length));
  for (let i = 0; i < take; i++) {
    // Index over the remaining tail only. Picking over the whole array and
    // rejecting collisions is the same distribution but a different, input-
    // dependent number of rand() calls, which breaks stream addressability.
    const j = i + Math.floor(rand() * (pool.length - i));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  pool.length = take;
  return pool;
}
