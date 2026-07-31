/**
 * Shared UI vocabulary: colour helpers, number formatting, derived stat maths,
 * and the small amount of *presentational* data (fusion lore, targeting modes)
 * that belongs to the interface rather than the simulation.
 *
 * Nothing here touches the game object — everything is pure.
 */

import { ELEMENTS, DUALS, PRIMALS, pairKey } from '../game/Elements.js';
import { PURE_TOWERS, DUAL_TOWERS, PRIMAL_TOWERS } from '../game/TowerDefs.js';
import { PRIMAL } from '../core/Config.js';

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

export const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 1234 -> "1 234" using a thin space so columns stay optically tight. */
export function num(v) {
  const n = Math.round(v);
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

/** Compact for big HP figures: 12 400 -> "12.4k". */
export function compact(v) {
  const n = Math.round(v);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return num(n);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------------------
// tower stat maths
// ---------------------------------------------------------------------------

/** Direct-hit DPS (what the projectile does on impact). */
export const dps = (lv) => lv.damage / lv.cooldown;

/** Damage-over-time attached to one hit, expressed per second while it runs. */
export function dotDps(lv) {
  let d = 0;
  if (lv.burn) d += lv.burn.dps;
  if (lv.poison) d += lv.poison.dps;
  return d;
}

/**
 * Rough "effective" DPS against a single target: direct DPS plus sustained DoT
 * (capped at one refreshing application) plus splash/chain multi-hit value.
 */
export function effectiveDps(lv) {
  let d = dps(lv);
  d += dotDps(lv);
  if (lv.chain) d += dps(lv) * (lv.chain.count - 1) * (lv.chain.falloff ?? 0.7) * 0.5;
  if (lv.splash) d += dps(lv) * clamp(lv.splash.radius / 6, 0, 0.9);
  return d;
}

/** Human-readable special effects on a level. */
export function specialsOf(lv) {
  const out = [];
  if (lv.splash) out.push({ k: 'splash', label: 'Splash', value: `${lv.splash.radius.toFixed(1)} radius` });
  if (lv.slow) out.push({ k: 'slow', label: 'Slow', value: `${Math.round(lv.slow.amt * 100)}% · ${lv.slow.dur}s` });
  if (lv.burn) out.push({ k: 'burn', label: 'Burn', value: `${lv.burn.dps}/s · ${lv.burn.dur}s` });
  if (lv.poison) out.push({ k: 'poison', label: 'Poison', value: `${lv.poison.dps}/s${lv.poison.stack ? ' · stacks' : ''}` });
  if (lv.chain) out.push({ k: 'chain', label: 'Chain', value: `${lv.chain.count} targets` });
  if (lv.armorPen) out.push({ k: 'pierce', label: 'Pierce', value: `${lv.armorPen} armour` });
  if (lv.execute) out.push({ k: 'execute', label: 'Execute', value: `below ${Math.round(lv.execute * 100)}%` });
  if (lv.lifesteal) out.push({ k: 'life', label: 'Leech', value: `${lv.lifesteal} life / kill` });
  if (lv.damageType === 'pure') out.push({ k: 'pure', label: 'Pure', value: 'ignores armour' });
  return out;
}

/** One-line summary of what a tower *does*, for cards with no tagline. */
export function summarise(def) {
  if (def.kind === 'pure' || def.kind === 'primal') return def.tagline;
  return FUSION_LORE[def.key] ?? specialsOf(def.levels[0]).map((s) => s.label).join(' · ');
}

// ---------------------------------------------------------------------------
// presentational data
// ---------------------------------------------------------------------------

export const FUSION_LORE = {
  vapor: 'Scalding cloud — splash that keeps on burning.',
  solar: 'Relentless cinders; burns faster than armour sheds.',
  blacksmith: 'Hammer-blows that leave the ground alight.',
  lightning: 'Arcs between three targets and ignores armour.',
  infernal: 'Burns the wounded, then claims them.',
  well: 'Drowns a pack and halves its pace.',
  geyser: 'Erupting mud — wide, heavy and slowing.',
  ice: 'Piercing shards that chill everything they touch.',
  poison: 'Stacking venom; it scales with how long they live.',
  mushroom: 'Fast spores that pay you back in lives.',
  bloom: 'The fastest sustained fire on the board.',
  disease: 'Contagion — poison that spreads through the pack.',
  atom: 'Long-range artillery that shrugs off armour.',
  howitzer: 'The heaviest shell in the game, plus an execute.',
  trickery: 'Pure damage, chained. Nothing resists it.',
};

export const TARGET_MODES = [
  { id: 'first', label: 'First', hint: 'Closest to your base — stops leaks.' },
  { id: 'strong', label: 'Strong', hint: 'Highest current HP — good vs bosses.' },
  { id: 'weak', label: 'Weak', hint: 'Lowest current HP — maximises kills.' },
  { id: 'close', label: 'Close', hint: 'Nearest to the tower — least travel time.' },
];

export const ELEMENT_ORDER = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];

/**
 * The four outcomes of a placement, in one place, because the hover ghost, the
 * cursor hint and the failed-click toast all have to say the same thing. They
 * used to disagree — the ghost went red for every refusal while the toast said
 * "Blocked" for two different problems — which taught the player that the red
 * square meant "try again somewhere else" rather than anything specific.
 *
 * `label` is the short form that rides next to the cursor; `msg` is the sentence
 * used when a click actually fails; `hint` is the fix.
 */
export const PLACEMENT_TEXT = {
  valid:    { tone: 'ok',   label: 'Build here',       msg: '',                            hint: '' },
  occupied: { tone: 'warn', label: 'Occupied',         msg: 'Something is already there',   hint: 'this ground is already taken' },
  creep:    { tone: 'warn', label: 'Creeps in the way',  msg: 'A creep is standing there',    hint: 'wait for it to walk on' },
  seal:     { tone: 'bad',  label: 'Seals the maze',   msg: 'That would seal the maze',     hint: 'the creeps would have no route left' },
  stacks:   { tone: 'bad',  label: 'Stacks spent',     msg: 'You no longer hold three of that element',
              hint: `a Primal needs ${PRIMAL.stacksRequired} stacks and spends ${PRIMAL.stacksConsumed}` },
  poor:     { tone: 'gold', label: 'Not enough gold',  msg: 'Not enough gold',              hint: '' },
  // The only *valid* placement that still speaks up — a primal click spends two
  // element stacks and nothing else on the board does. The label is written by
  // the caller (it names the element), so this entry carries only the tone.
  commit:   { tone: 'gold', label: 'Commit stacks',    msg: '',                             hint: 'returned in full if you sell it' },
};

/** Short, evocative creep descriptions for the threat panel. */
export const CREEP_LORE = {
  normal: 'Rank and file. No tricks.',
  fast: 'Sprints the maze — slows are essential.',
  armored: 'Flat damage reduction. Bring pierce.',
  swarm: 'Many, weak, fast. Splash them.',
  flying: 'Ignores your maze. Flies the short line.',
  boss: 'Ten lives if it gets through.',
};

// ---------------------------------------------------------------------------
// element / fusion graph
// ---------------------------------------------------------------------------

/** Fusion tower defs unlocked *in addition* if `candidate` were added. */
export function newFusionsFor(owned, candidate) {
  const set = new Set(owned);
  if (set.has(candidate)) return [];
  const out = [];
  for (const other of set) {
    const d = DUALS[pairKey(other, candidate)];
    if (d) out.push({ ...DUAL_TOWERS[d.id], parents: [other, candidate] });
  }
  return out;
}

/**
 * The Tower Table's spine: every tower filed under the element it deals damage
 * as — exactly how the reference game organises its table. Each column holds
 * one elemental tower plus the fusions whose damage type is that element.
 */
export const TOWER_COLUMNS = ELEMENT_ORDER.map((id) => ({
  id,
  element: ELEMENTS[id],
  pure: PURE_TOWERS[id],
  fusions: Object.entries(DUALS)
    .filter(([, d]) => d.damage === id)
    .map(([key, d]) => ({ ...DUAL_TOWERS[d.id], pair: key, parts: key.split('+') }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  primal: PRIMAL_TOWERS[PRIMALS[id].id],
}));

/** Total towers in the game — the Tower Table's denominator. */
export const TOWER_TOTAL =
  Object.keys(PURE_TOWERS).length + Object.keys(DUAL_TOWERS).length + Object.keys(PRIMAL_TOWERS).length;

/**
 * Element id -> how many copies are held. Accepts the raw `state.elements`
 * array (which can contain duplicates), a Set, or an already-built Map.
 *
 * Every lock test in the UI goes through this because a Set collapses three
 * copies of Fire to one, which reads as "primal not unlocked" forever.
 */
export function countElements(list) {
  if (list instanceof Map) return list;
  const m = new Map();
  for (const id of list) m.set(id, (m.get(id) ?? 0) + 1);
  return m;
}

/**
 * Lock state of a tower given what the player holds.
 *
 * A primal is gated on a COUNT, not on membership, so `owned` must carry counts
 * — pass the array or a Map, never a Set built from it. `have`/`need` are only
 * meaningful for primals and are what the codex renders as "2 / 3".
 */
export function lockState(def, owned) {
  const counts = countElements(owned);
  const parts = def.kind === 'dual' ? def.parts : [def.element];
  if (def.kind === 'primal') {
    const have = counts.get(def.element) ?? 0;
    const unlocked = have >= PRIMAL.stacksRequired;
    return { parts, missing: unlocked ? [] : [def.element], unlocked, have, need: PRIMAL.stacksRequired };
  }
  const missing = parts.filter((p) => !counts.has(p));
  return { parts, missing, unlocked: missing.length === 0 };
}

export function elementCss(id) {
  const e = ELEMENTS[id];
  return `--c:${hex(e.color)};--a:${hex(e.accent)}`;
}

export { ELEMENTS, DUALS, PRIMALS, PURE_TOWERS, DUAL_TOWERS, PRIMAL_TOWERS, PRIMAL, pairKey };
