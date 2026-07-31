/**
 * Pure-logic checks for Primal towers. No browser needed: everything under test
 * here (the roll, availableTowers, the stat tables) is dependency-free of three.js.
 *
 *   node tools/scratch/primal-logic.mjs
 */
import { ELEMENT_IDS, ELEMENTS, PRIMALS } from '../../src/game/Elements.js';
import { availableTowers, PRIMAL_TOWERS, towerDef } from '../../src/game/TowerDefs.js';
import { ELEMENT_PICK, PRIMAL, ECONOMY } from '../../src/core/Config.js';
import { rngFor, pickN } from '../../src/core/Rng.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL', msg); } };

/** Verbatim copy of Game.rollElementChoices, driven by a plain state object. */
function roll(seed, pickIndex, elements) {
  const counts = new Map();
  for (const id of elements) counts.set(id, (counts.get(id) ?? 0) + 1);
  const rand = rngFor(seed, 'elements', pickIndex);
  const order = pickN(rand, ELEMENT_IDS, ELEMENT_IDS.length);
  const rank = new Map(order.map((id, i) => [id, i]));
  const fresh = order.filter((id) => !counts.has(id));
  const echo = order.filter((id) => {
    const n = counts.get(id) ?? 0;
    return n >= 1 && n < PRIMAL.stacksRequired;
  }).sort((a, b) => (counts.get(b) - counts.get(a)) || (rank.get(a) - rank.get(b)));
  const spare = order.filter((id) => (counts.get(id) ?? 0) >= PRIMAL.stacksRequired);
  const echoSlots = pickIndex >= ELEMENT_PICK.echoFromPick ? ELEMENT_PICK.echoSlots : 0;
  const out = [];
  const take = (pool, n) => {
    for (const id of pool) {
      if (out.length >= ELEMENT_PICK.slots || n <= 0) break;
      if (out.includes(id)) continue;
      out.push(id); n--;
    }
  };
  take(fresh, ELEMENT_PICK.slots - echoSlots);
  take(echo, echoSlots);
  take(fresh, ELEMENT_PICK.slots);
  take(echo, ELEMENT_PICK.slots);
  take(spare, ELEMENT_PICK.slots);
  return out;
}

// --- 1. always exactly 3 distinct, for every reachable holding ---------------
{
  const shuffle = (a, s) => { const r = rngFor(s, 'x'); return a.slice().sort(() => r() - 0.5); };
  let n = 0;
  for (let seed = 1; seed <= 200; seed++) {
    for (let pick = 0; pick <= 10; pick++) {
      for (const held of [[], ['fire'], ['fire', 'fire'], ['fire', 'fire', 'fire'],
        ['fire', 'water', 'nature'], ['fire', 'fire', 'water', 'water', 'nature'],
        ELEMENT_IDS.slice(), [...ELEMENT_IDS, ...ELEMENT_IDS]]) {
        const a = roll(seed, pick, held);
        ok(a.length === ELEMENT_PICK.slots, `len ${a.length} seed ${seed} pick ${pick} held ${held}`);
        ok(new Set(a).size === a.length, `dupes ${a} seed ${seed} pick ${pick}`);
        // Permuting the multiset must not change the offer.
        const b = roll(seed, pick, shuffle(held, seed + pick));
        ok(a.join() === b.join(), `order-dependent: ${a} vs ${b} seed ${seed} pick ${pick}`);
        n++;
      }
    }
  }
  console.log(`1. roll shape + order-independence — ${n} cases`);
}

// --- 2. rand budget: exactly ELEMENT_IDS.length calls, always ----------------
{
  let n = 0;
  for (let seed = 1; seed <= 50; seed++) {
    for (const held of [[], ['fire'], ['fire', 'fire', 'fire'], ELEMENT_IDS.slice()]) {
      const real = rngFor(seed, 'elements', 3);
      let calls = 0;
      const counted = () => { calls++; return real(); };
      pickN(counted, ELEMENT_IDS, ELEMENT_IDS.length);
      ok(calls === ELEMENT_IDS.length, `rand budget ${calls} for held ${held}`);
      n++;
    }
  }
  console.log(`2. rand budget = ${ELEMENT_IDS.length} per roll — ${n} cases`);
}

// --- 3. echo slot opens at echoFromPick, and never before --------------------
{
  const p0 = roll(7, 0, ['fire']);
  ok(!p0.includes('fire'), 'pick 0 must not echo');
  const p1 = roll(7, 1, ['fire']);
  ok(p1.includes('fire'), 'pick 1 must echo the only holding');
  // Rush line: three picks of the same element must be reachable.
  let held = [];
  for (let k = 0; k < 3; k++) {
    const offer = roll(4242, k, held);
    const want = k === 0 ? offer[0] : held[0];
    ok(offer.includes(want), `pick ${k} must offer ${want}, got ${offer}`);
    held.push(want);
  }
  ok(held.filter((x) => x === held[0]).length === 3, `rush reached 3: ${held}`);
  ok(availableTowers(held).some((d) => d.key === PRIMALS[held[0]].id), 'rush unlocks the primal');
  console.log(`3. echo timing + wave-11 rush line (${held.join(',')})`);
}

// --- 4. the "never chased" floor: forced echoes from pick 6 ------------------
{
  for (const seed of [1, 99, 31337]) {
    const held = [];
    for (let k = 0; k <= 7; k++) held.push(roll(seed, k, held)[0]);
    const counts = new Map();
    for (const id of held) counts.set(id, (counts.get(id) ?? 0) + 1);
    ok([...counts.values()].some((v) => v >= PRIMAL.stacksRequired),
      `seed ${seed}: no primal by pick 7 — ${held.join(',')}`);
  }
  console.log('4. always-fresh player still reaches a primal by pick 7 (wave 36)');
}

// --- 5. availableTowers: unlock, fusion survival, count-blindness of a Set ---
{
  ok(!availableTowers(['fire', 'fire']).some((d) => d.kind === 'primal'), '2 stacks must not unlock');
  ok(availableTowers(['fire', 'fire', 'fire']).some((d) => d.key === 'primal_fire'), '3 stacks unlock');
  const after = availableTowers(['fire', 'water']);        // post-build holding
  ok(after.some((d) => d.key === 'vapor'), 'fusion survives a primal build');
  ok(!after.some((d) => d.kind === 'primal'), 'primal re-locks after a build');
  ok(availableTowers(new Set(['fire', 'fire', 'fire'])).every((d) => d.kind !== 'primal'),
    'a Set collapses counts — documented, and this asserts the trap is real');
  ok(availableTowers([...ELEMENT_IDS, ...ELEMENT_IDS, ...ELEMENT_IDS]).length === 27, 'all 27');
  console.log('5. availableTowers unlock / re-lock / fusion survival');
}

// --- 6. stat tables ---------------------------------------------------------
{
  const dps = (l) => l.damage / l.cooldown;
  const l0 = [], l1 = [];
  for (const el of ELEMENT_IDS) {
    const d = PRIMAL_TOWERS[PRIMALS[el].id];
    ok(!!d && d.kind === 'primal', `${el} primal exists`);
    ok(d.levels.length === 2, `${el} has 2 levels`);
    ok(d.color === ELEMENTS[el].color, `${el} keeps the element hex (VFX family)`);
    ok(d.levels[0].cost === 900 && d.levels[1].cost === 2200, `${el} costs 900/2200`);
    ok(towerDef(PRIMALS[el].id) === d, `${el} resolves through towerDef`);
    l0.push(dps(d.levels[0])); l1.push(dps(d.levels[1]));
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const spread = (a) => (Math.max(...a) - Math.min(...a)) / mean(a);
  ok(spread(l1) < 0.09, `L1 DPS spread ${(spread(l1) * 100).toFixed(1)}% must stay under ~8%`);
  console.log(`6. tables — mean L0 ${mean(l0).toFixed(1)} DPS, L1 ${mean(l1).toFixed(1)} DPS,`
    + ` L1 spread ${(spread(l1) * 100).toFixed(1)}%`);
}

// --- 7. foundation route economics ------------------------------------------
{
  const C = 900;
  const armed = 20 + Math.max(0, Math.round((C - 20) * (1 - ECONOMY.armDiscount)));
  const refund = Math.floor(C * ECONOMY.sellRefund);
  ok(armed - refund === 5, `arm-then-sell delta ${armed - refund} must be the usual 5`);
  console.log(`7. foundation route — paid ${armed}, refund ${refund}`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall green');
process.exit(fails ? 1 : 0);
