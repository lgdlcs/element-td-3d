/**
 * Is src/core/Rng.js actually deterministic, and is the generator actually a
 * generator?
 *
 * Determinism is the whole product: the multiplayer fairness claim is "same seed,
 * same element offers, on every machine". A test that only checks "returns a
 * number in [0,1)" would pass for `() => 0.5`, so this also runs a uniformity and
 * an independence check — a subtly broken mixer (a lost `>>> 0`, a `*` where
 * `imul` was needed) still produces plausible-looking floats.
 *
 *   node tools/scratch/rngcheck.mjs
 */
import { mulberry32, hashStr, rngFor, pickN } from '../../src/core/Rng.js';

let fails = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};
const take = (rand, n) => Array.from({ length: n }, () => rand());

// -- 1. same seed, same sequence ------------------------------------------
{
  const a = take(mulberry32(12345), 8);
  const b = take(mulberry32(12345), 8);
  ok('mulberry32 same seed same sequence', a.every((v, i) => v === b[i]));
  ok('mulberry32 different seed diverges', take(mulberry32(12346), 8)[0] !== a[0]);
  console.log(`      first 4 of seed 12345: ${a.slice(0, 4).map((v) => v.toFixed(9)).join(' ')}`);

  // Pinned output. Comparing the implementation to itself proves nothing, so
  // these three numbers were taken from the CANONICAL published mulberry32
  // (reproduced below) and not from src/core/Rng.js. If a future edit changes the
  // mixer, every seed in every existing room means something different; this
  // makes that loud instead of silent.
  const golden = [0.9797282677609473, 0.3067522644996643, 0.484205421525985];
  ok('mulberry32 matches pinned canonical output', a.slice(0, 3).every((v, i) => v === golden[i]),
    a.slice(0, 3).join(','));

  // Independent reference: the canonical snippet, verbatim, including its lack of
  // a `>>> 0` on the state update. Ours adds that, which is a deliberate
  // deviation — without it `a` is a double that stops being exact past 2^53, i.e.
  // after ~4.8M draws, at which point the stream is no longer reproducible.
  // Below that boundary the two must agree exactly, which is what this checks.
  const ref = (seed) => { let a = seed; return () => {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }; };
  let mismatch = -1;
  const mine = mulberry32(999), theirs = ref(999);
  for (let i = 0; i < 200000; i++) if (mine() !== theirs()) { mismatch = i; break; }
  ok('mulberry32 == canonical reference over 200k draws', mismatch === -1,
    mismatch === -1 ? '' : `first mismatch at ${mismatch}`);
}

// -- 2. range and sign ----------------------------------------------------
{
  let lo = 1, hi = 0, bad = 0;
  for (const seed of [0, 1, -1, 2 ** 31, 4294967295, 987654321]) {
    for (const v of take(mulberry32(seed), 20000)) {
      if (!(v >= 0 && v < 1) || Number.isNaN(v)) bad++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  ok('every draw in [0,1) across 6 seeds x 20k', bad === 0,
    `min ${lo.toFixed(7)} max ${hi.toFixed(7)}`);
}

// -- 3. hashStr -----------------------------------------------------------
{
  ok('hashStr stable', hashStr('elements') === hashStr('elements'));
  ok('hashStr uint32', ['', 'a', 'elements', 'ÿ€𝄞'].every((s) => {
    const h = hashStr(s);
    return Number.isInteger(h) && h >= 0 && h <= 0xFFFFFFFF;
  }), `hashStr('elements') = ${hashStr('elements')}`);
  const seen = new Map();
  let coll = 0;
  for (let i = 0; i < 20000; i++) {
    const h = hashStr(`elements:${i}`);
    if (seen.has(h)) coll++; else seen.set(h, i);
  }
  // ~0.05 expected by birthday over 2^32; anything more means the mix is broken.
  ok('hashStr collisions over 20k labels', coll <= 2, `${coll} collisions`);
}

// -- 4. rngFor: stable, and independent per part --------------------------
{
  const s = 0xC0FFEE;
  const a = take(rngFor(s, 'elements', 3), 6);
  const a2 = take(rngFor(s, 'elements', 3), 6);
  ok('rngFor same parts same stream', a.every((v, i) => v === a2[i]));

  const variants = {
    "(s,'elements',4)": take(rngFor(s, 'elements', 4), 6),
    "(s,'elements',3,0)": take(rngFor(s, 'elements', 3, 0), 6),
    "(s,'element',3)": take(rngFor(s, 'element', 3), 6),
    "(s+1,'elements',3)": take(rngFor(s + 1, 'elements', 3), 6),
    '(s)': take(rngFor(s), 6),
    "(s,'a','a')": take(rngFor(s, 'a', 'a'), 6),
  };
  for (const [label, v] of Object.entries(variants)) {
    ok(`rngFor ${label} diverges from (s,'elements',3)`, v[0] !== a[0]);
  }
  // Separator check: without one, ('a','bc') and ('ab','c') are the same bytes
  // and two unrelated call sites would share a stream.
  ok("rngFor ('a','bc') != ('ab','c')",
    take(rngFor(s, 'a', 'bc'), 4)[0] !== take(rngFor(s, 'ab', 'c'), 4)[0]);
  ok("rngFor ('a','a') != (s) alone",
    variants["(s,'a','a')"][0] !== variants['(s)'][0]);

  // Numeric and string parts must agree on how they hash, or the server keying
  // on 3 and the client keying on '3' would silently disagree.
  ok("rngFor numeric part == its string form",
    take(rngFor(s, 'elements', 3), 4)[0] === take(rngFor(s, 'elements', '3'), 4)[0]);
}

// -- 5. pickN -------------------------------------------------------------
{
  const IDS = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  const frozen = IDS.join(',');

  const p = pickN(rngFor(7, 'elements', 0), IDS, 3);
  ok('pickN returns n items', p.length === 3, p.join(','));
  ok('pickN items distinct', new Set(p).size === p.length);
  ok('pickN items all from input', p.every((x) => IDS.includes(x)));
  ok('pickN does not mutate input', IDS.join(',') === frozen, IDS.join(','));

  const p2 = pickN(rngFor(7, 'elements', 0), IDS, 3);
  ok('pickN stable for fixed seed', p.join(',') === p2.join(','));
  ok('pickN differs across pickIndex',
    pickN(rngFor(7, 'elements', 1), IDS, 3).join(',') !== p.join(','));

  const full = pickN(rngFor(7, 'elements', 0), IDS, IDS.length);
  ok('pickN n=len is a permutation', new Set(full).size === 6 && full.length === 6, full.join(','));
  ok('pickN prefix property (first 3 of full == pick 3)', full.slice(0, 3).join(',') === p.join(','));
  ok('pickN clamps n>len', pickN(rngFor(7), IDS, 99).length === 6);
  ok('pickN n=0 is empty', pickN(rngFor(7), IDS, 0).length === 0);
  ok('pickN n<0 is empty', pickN(rngFor(7), IDS, -3).length === 0);
  ok('pickN on empty array', pickN(rngFor(7), [], 3).length === 0);
  ok('pickN never yields undefined over 5k seeds', (() => {
    for (let s = 0; s < 5000; s++) {
      const q = pickN(rngFor(s, 'elements', s % 11), IDS, 3);
      if (q.length !== 3 || q.some((x) => x === undefined) || new Set(q).size !== 3) return false;
    }
    return true;
  })());

  // Every element must be reachable in slot 0, or the "nobody's draw is luckier"
  // claim fails: a shuffle biased to leave index 0 alone is a classic partial
  // Fisher-Yates bug and produces distinct-looking output regardless.
  const firstCount = new Map(IDS.map((k) => [k, 0]));
  const N = 60000;
  for (let s = 0; s < N; s++) firstCount.set(pickN(rngFor(s, 'elements', 0), IDS, 3)[0],
    firstCount.get(pickN(rngFor(s, 'elements', 0), IDS, 3)[0]) + 1);
  const counts = [...firstCount.values()];
  const exp = N / 6;
  const worst = Math.max(...counts.map((c) => Math.abs(c - exp) / exp));
  ok('pickN slot 0 covers all 6 elements ~uniformly', worst < 0.05,
    `worst deviation ${(worst * 100).toFixed(2)}%  ${[...firstCount].map(([k, v]) => `${k}:${v}`).join(' ')}`);
}

// -- 6. uniformity + independence of the raw stream -----------------------
{
  const N = 1_000_000;
  const BINS = 20;
  const bins = new Array(BINS).fill(0);
  const rand = mulberry32(0xABCDEF);
  let sum = 0, prev = rand(), serial = 0;
  for (let i = 0; i < N; i++) {
    const v = rand();
    bins[Math.floor(v * BINS)]++;
    sum += v;
    // Lag-1 correlation: catches a generator whose successive outputs march
    // upward, which a histogram alone reports as perfectly uniform.
    serial += (v - 0.5) * (prev - 0.5);
    prev = v;
  }
  const mean = sum / N;
  const exp = N / BINS;
  const chi2 = bins.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
  const corr = (serial / N) / (1 / 12);
  ok('mean ~0.5 over 1M', Math.abs(mean - 0.5) < 0.002, `mean ${mean.toFixed(6)}`);
  // chi2 with 19 df: 43.8 is p=0.001. Well clear of it or the bins are skewed.
  ok('chi-square uniform over 20 bins', chi2 < 43.8, `chi2 ${chi2.toFixed(2)} (df 19, crit 43.82)`);
  ok('lag-1 correlation ~0', Math.abs(corr) < 0.005, `r ${corr.toFixed(6)}`);
  const uniq = new Set();
  const r2 = mulberry32(1);
  for (let i = 0; i < 100000; i++) uniq.add(r2());
  ok('no short cycle in 100k draws', uniq.size > 99900, `${uniq.size} distinct`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall checks passed');
process.exit(fails ? 1 : 0);
