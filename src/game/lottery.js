/**
 * THE RITE OF FORTUNE — the wager's whole rulebook, and nothing that draws.
 *
 * Pure: no DOM, no three, no Game. `tests/unit` imports it directly, which is
 * the point — every number below is asserted rather than believed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE INVARIANT THIS FILE EXISTS TO PROTECT
 *
 *     evBase() + POT_FEED  <  1
 *
 * If that ever stops holding, "wager every prep" becomes the dominant line, the
 * tower economy is decided by who clicked the most, and the run stops being a
 * tower defence. The pot cannot rescue a broken table either: every coin the pot
 * pays out was fed to it by a stake, so the expression above is the ceiling of
 * the whole system INCLUDING a player who claims every pot they ever fund. It is
 * 0.9865. `tests/unit/lottery.test.js` asserts it, and also proves the assertion
 * is capable of failing — an invariant nobody has watched go red is a comment.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE THE NUMBERS COME FROM
 *
 * The stake ladder is ~20 % of a wave's gross bounty (`count * bounty`, a pure
 * function of n in Waves.js), snapped to a readable rung and then made monotone.
 * The payout table was calibrated against a Monte-Carlo of this game's real
 * economy — 20 000 runs x 55 waves x 3 spending profiles — and the retained
 * table costs the maximal user 1 075 gold across a full run: 1.75 % of a 67 093
 * gold economy, while ~28 % of "wager always" runs still finish ahead. The
 * simulators are design artefacts and live with the spec rather than in the
 * repo; what survives here is the table they validated, plus the invariant and
 * the monotonicity check that keep an edit from quietly undoing them.
 */

import { waveDef } from './Waves.js';

/**
 * The six outcomes, in cumulative order.
 *
 * ORDER IS PART OF THE CONTRACT. The draw maps a single uniform `u` onto this
 * list by cumulative probability, and the ring the player watches is that same
 * cumulative walk drawn as arc lengths — the needle physically comes to rest at
 * the angle `u` names. Two clients must therefore agree on this array exactly;
 * reordering it changes what every existing seed pays, and so does inserting.
 *
 * `mult` is what comes back per unit staked. THE FLOOR IS 0.25, NEVER 0: 46 % of
 * draws ending in literally nothing is humiliating on an 800-gold stake rather
 * than dramatic, and a result screen needs a number to land on. You never walk
 * away from this table empty-handed.
 *
 * `pot` marks the one outcome that also empties the pot. `win` means the payout
 * is at least the stake — it is presentation only, and the tests derive the win
 * rate from `mult` rather than trusting the flag.
 */
export const LOTTERY_OUTCOMES = Object.freeze([
  Object.freeze({ id: 'ash',    name: 'Ash',         glyph: '●', p: 0.460, mult: 0.25, pot: false, win: false }),
  Object.freeze({ id: 'shard',  name: 'Shard',       glyph: '◆', p: 0.280, mult: 0.80, pot: false, win: false }),
  Object.freeze({ id: 'vein',   name: 'Vein',        glyph: '◈', p: 0.155, mult: 1.50, pot: false, win: true  }),
  Object.freeze({ id: 'lode',   name: 'Lode',        glyph: '✦', p: 0.075, mult: 3.00, pot: false, win: true  }),
  Object.freeze({ id: 'geyser', name: 'Geyser',      glyph: '✷', p: 0.005, mult: 8.00, pot: false, win: true  }),
  Object.freeze({ id: 'conv',   name: 'Convergence', glyph: '⬢', p: 0.025, mult: 2.00, pot: true,  win: true  }),
]);

/** Fraction of every stake set aside into the player's own pot. */
export const POT_FEED = 0.10;

/**
 * The first wave that may be wagered on.
 *
 * Not 1. On wave 1 the player has not placed a tower yet and does not know what
 * gold is for; offering a bet before the loop is understood is a trap, not a
 * choice.
 */
export const FIRST_WAGER_WAVE = 3;

/**
 * The reserve rule: a stake may never exceed half the bank.
 *
 * HONESTY NOTE, AND IT IS LOAD-BEARING. This rule is PROVEN INERT under normal
 * play. Gold in hand at the start of a prep is at least the previous wave's
 * gross — it was just collected, and you cannot have spent what you did not have
 * — the stake is ~20 % of a wave's gross, so the gold/stake ratio never falls
 * below 2.88x across all 55 waves (worst case: wave 2), and 20 000 simulated
 * runs across four spending policies blocked zero wagers. It is kept because it
 * costs one line, because it is assertable, and because it will catch a future
 * edit to the ladder. It must NOT be described to anyone as the protection
 * against a death spiral: THE STAKE FORMULA IS THAT PROTECTION. The rule only
 * bites once more than 31 % of a wave has leaked — that is, for a player who is
 * already losing the run, which is the one moment it should bite.
 */
export const RESERVE_MULT = 2;

/**
 * The readable rungs. Every rung is a number a player can hold in their head and
 * compare against a tower price (60 / 450 / 900), which a computed
 * `0.2 * gross` — 14, 19, 26, 33 — is not.
 */
export const STAKE_LADDER = Object.freeze([25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1000, 1400]);

/** Target fraction of a wave's gross bounty that a stake represents. */
export const STAKE_FRAC = 0.20;

/** How far up the ladder is precomputed. The scripted run ends at 55. */
const LADDER_MAX_WAVE = 120;

/** Gross bounty of wave `n`: what the wave pays if nothing leaks. */
export function waveGross(n) {
  const d = waveDef(n);
  return d.count * d.bounty;
}

/** The rung nearest STAKE_FRAC of the wave's gross. Not monotone on its own. */
function rawStake(n) {
  const target = STAKE_FRAC * waveGross(n);
  let best = STAKE_LADDER[0];
  for (const v of STAKE_LADDER) {
    if (Math.abs(v - target) < Math.abs(best - target)) best = v;
  }
  return best;
}

/**
 * MONOTONE BY CONSTRUCTION — a running maximum of `rawStake`.
 *
 * `rawStake` alone goes DOWN on boss waves, because a boss is a single unit:
 * wave 19 grosses 330 and asks 75, wave 20 grosses 236 and would ask 50. A stake
 * that drops reads as a discount, and there is no discount — only a dip in a
 * schedule the player cannot see. The running max erases the dip and touches
 * nothing else.
 */
const _STAKES = (() => {
  const a = new Array(LADDER_MAX_WAVE + 1).fill(0);
  let m = 0;
  for (let n = 1; n <= LADDER_MAX_WAVE; n++) { m = Math.max(m, rawStake(n)); a[n] = m; }
  return Object.freeze(a);
})();

/**
 * The stake for wave `n`. A PURE FUNCTION OF n, and deliberately not of gold.
 *
 * A percentage of the player's gold would ask the identical question every time
 * ("do I risk 10 % again?"), which is a question one answers once and then
 * automates. Worse, it would read `state.gold`, so two players in a room would
 * stake different amounts on the same wave and the shared draw would stop
 * meaning anything. Indexed on the wave, the same button asks a different
 * question every time — because what changed is the player's situation, not the
 * price.
 */
export function stakeFor(n) {
  const w = Math.max(1, Math.min(LADDER_MAX_WAVE, Math.round(n) || 1));
  return _STAKES[w];
}

/**
 * What this stake adds to the pot. Whole gold; the pot never holds a fraction.
 *
 * FLOOR, NOT ROUND, and a test is why. With `Math.round` the 25 and 75 rungs
 * feed 3 and 8 instead of 2.5 and 7.5, so the realised feed across the wager
 * window comes out at 10.06 % rather than 10 % and the measured ceiling lands at
 * 0.98706 — above the 0.9865 this file publishes. It is still under 1, so
 * nothing was ever broken, but a published ceiling the code can exceed is a
 * published ceiling nobody should trust. Flooring makes `feed <= POT_FEED *
 * stake` true for every rung, which is what turns `evBase() + POT_FEED < 1` from
 * an approximation into a bound.
 */
export function potContribution(stake) {
  return Math.floor(Math.max(0, stake) * POT_FEED);
}

/**
 * Map a uniform `u` in [0,1) onto the table by cumulative probability.
 *
 * TAKES A NUMBER, NOT A GENERATOR, and that is the whole determinism argument:
 * it cannot consume a second value because it was never handed the ability to.
 * There is no sub-roll, no reroll and no second wheel anywhere in this feature.
 *
 * Out-of-range and NaN clamp into the table rather than falling off the end. A
 * draw returning `undefined` would be a crash in the middle of a paid
 * transaction, which is the one place this codebase cannot afford one.
 */
export function resolveLottery(u) {
  const x = Number.isFinite(u) ? Math.min(0.9999999999, Math.max(0, u)) : 0;
  let acc = 0;
  for (const o of LOTTERY_OUTCOMES) {
    acc += o.p;
    if (x < acc) return o;
  }
  return LOTTERY_OUTCOMES[LOTTERY_OUTCOMES.length - 1];
}

/**
 * Cumulative bounds [from, to) of each outcome as fractions of the circle.
 *
 * The ring renderer and `resolveLottery` read the SAME walk, which is why the
 * needle can be drawn landing at exactly `u` instead of being animated toward a
 * result it was told about separately. The picture is the algorithm.
 */
export function outcomeBands() {
  const out = [];
  let acc = 0;
  for (const o of LOTTERY_OUTCOMES) { out.push({ o, from: acc, to: acc + o.p }); acc += o.p; }
  return out;
}

/** The sum of the probabilities. Should be exactly 1; the test checks the float. */
export function probabilitySum() {
  return LOTTERY_OUTCOMES.reduce((s, o) => s + o.p, 0);
}

/** Expected return per unit staked, EXCLUDING the pot. 0.8865. */
export function evBase() {
  return LOTTERY_OUTCOMES.reduce((s, o) => s + o.p * o.mult, 0);
}

/**
 * The theoretical ceiling: base return plus every coin the pot could ever pay.
 *
 * The pot is not free money — it is fed out of the stakes — so a player who
 * claimed 100 % of what they personally fed would realise exactly
 * `evBase() + POT_FEED`. That number has to stay under 1.
 */
export function evCeiling() {
  return evBase() + POT_FEED;
}

/** Standard deviation of one stake's return, excluding the pot. 0.930. */
export function returnStdDev() {
  const mean = evBase();
  const varr = LOTTERY_OUTCOMES.reduce((s, o) => s + o.p * (o.mult - mean) ** 2, 0);
  return Math.sqrt(varr);
}

/** Share of draws that hand back at least the stake. 26 %. */
export function winRate() {
  return LOTTERY_OUTCOMES.reduce((s, o) => s + (o.mult >= 1 ? o.p : 0), 0);
}

/**
 * The payout of a resolved draw, and what it does to the pot.
 *
 * THE BOOKKEEPING IS CONSERVATIVE AND A TEST PROVES IT: the pot only ever grows
 * by `potContribution` and only ever empties in full, so across a whole run
 * `Σ fed === Σ paid + pot`. Nothing is created here and nothing evaporates.
 *
 * @param {object} outcome  from resolveLottery
 * @param {number} stake
 * @param {number} pot      the pot AFTER this stake's contribution went in
 * @returns {{payout: number, base: number, potPaid: number, potAfter: number}}
 */
export function payoutFor(outcome, stake, pot) {
  const held = Math.max(0, Math.round(pot));
  const base = Math.round(stake * outcome.mult);
  const potPaid = outcome.pot ? held : 0;
  return { base, payout: base + potPaid, potPaid, potAfter: held - potPaid };
}

/**
 * Why the wager is unavailable, or null if it is available.
 *
 * A pure predicate over a plain record, so the button, the dev panel and the
 * tests all ask one function the same question. It returns a machine key and not
 * a sentence: the wording belongs to the UI, and a rules file is not a place to
 * keep a phrasebook.
 *
 * @param {{phase: string, gold: number, wave: number, wageredWave: number|null}} s
 *   `wave` is the wave being PREPARED (state.wave + 1), not the one just cleared.
 * @returns {null | 'phase' | 'tooEarly' | 'spent' | 'reserve'}
 */
export function wagerBlock(s) {
  if (s.phase !== 'prep') return 'phase';
  if (s.wave < FIRST_WAGER_WAVE) return 'tooEarly';
  if (s.wageredWave === s.wave) return 'spent';
  if (stakeFor(s.wave) * RESERVE_MULT > s.gold) return 'reserve';
  return null;
}
