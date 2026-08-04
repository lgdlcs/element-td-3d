import { ELEMENTS, DUALS, PRIMALS, LEGACY_DUAL_IDS, pairKey } from './Elements.js';
import { PRIMAL } from '../core/Config.js';

/**
 * Tower stat tables.
 *
 * Pure towers: 3 upgrade levels, cheap, available as soon as you own the element.
 * Dual towers: require one of each parent element, 2 levels, much stronger and
 * carry the signature mechanic of the pairing.
 *
 * `dps` is informational; the sim uses damage/cooldown.
 */

function pure(id, base) {
  const e = ELEMENTS[id];
  return {
    key: id,
    kind: 'pure',
    element: id,
    name: `${e.name} Tower`,
    color: e.color,
    accent: e.accent,
    glyph: e.glyph,
    tagline: e.tagline,
    levels: base,
  };
}

/** level = { cost, damage, cooldown, range, projectileSpeed, ...special } */
export const PURE_TOWERS = {
  fire: pure('fire', [
    { cost: 60,  damage: 22,  cooldown: 1.10, range: 9.5,  speed: 34, burn: { dps: 8,  dur: 3 } },
    { cost: 140, damage: 54,  cooldown: 1.05, range: 10.2, speed: 36, burn: { dps: 20, dur: 3 } },
    { cost: 320, damage: 128, cooldown: 1.00, range: 11.0, speed: 38, burn: { dps: 46, dur: 3.5 } },
  ]),
  water: pure('water', [
    { cost: 60,  damage: 16,  cooldown: 1.00, range: 9.0,  speed: 30, slow: { amt: 0.36, dur: 2.4 } },
    { cost: 140, damage: 40,  cooldown: 0.95, range: 9.8,  speed: 32, slow: { amt: 0.50, dur: 2.9 } },
    { cost: 320, damage: 96,  cooldown: 0.90, range: 10.6, speed: 34, slow: { amt: 0.64, dur: 3.4 } },
  ]),
  nature: pure('nature', [
    { cost: 60,  damage: 12,  cooldown: 0.45, range: 8.6,  speed: 44 },
    { cost: 140, damage: 30,  cooldown: 0.40, range: 9.2,  speed: 48 },
    { cost: 320, damage: 72,  cooldown: 0.34, range: 9.8,  speed: 52 },
  ]),
  earth: pure('earth', [
    { cost: 60,  damage: 30,  cooldown: 1.55, range: 8.2,  speed: 24, splash: { radius: 2.2, falloff: 0.5 } },
    { cost: 140, damage: 74,  cooldown: 1.50, range: 8.8,  speed: 25, splash: { radius: 2.7, falloff: 0.5 } },
    { cost: 320, damage: 176, cooldown: 1.45, range: 9.4,  speed: 26, splash: { radius: 3.3, falloff: 0.55 } },
  ]),
  light: pure('light', [
    { cost: 60,  damage: 20,  cooldown: 0.90, range: 12.5, speed: 90, armorPen: 3 },
    { cost: 140, damage: 50,  cooldown: 0.86, range: 13.4, speed: 95, armorPen: 6 },
    { cost: 320, damage: 118, cooldown: 0.82, range: 14.4, speed: 100, armorPen: 10 },
  ]),
  dark: pure('dark', [
    { cost: 60,  damage: 26,  cooldown: 1.20, range: 9.0,  speed: 30, execute: 0.06 },
    { cost: 140, damage: 64,  cooldown: 1.15, range: 9.7,  speed: 32, execute: 0.10 },
    { cost: 320, damage: 150, cooldown: 1.10, range: 10.4, speed: 34, execute: 0.15 },
  ]),
};

/** Signature mechanics for each of the 15 dual towers. */
const DUAL_STATS = {
  'fire+water':   [{ cost: 450, damage: 130, cooldown: 0.80, range: 10.5, speed: 40, splash: { radius: 2.4, falloff: 0.6 }, burn: { dps: 55, dur: 3 } },
                   { cost: 1100, damage: 320, cooldown: 0.75, range: 11.5, speed: 42, splash: { radius: 3.0, falloff: 0.6 }, burn: { dps: 130, dur: 3 } }],
  'fire+nature':  [{ cost: 450, damage: 62,  cooldown: 0.32, range: 9.6,  speed: 55, burn: { dps: 40, dur: 2.5 } },
                   { cost: 1100, damage: 152, cooldown: 0.28, range: 10.4, speed: 60, burn: { dps: 96, dur: 2.5 } }],
  'earth+fire':   [{ cost: 450, damage: 210, cooldown: 1.40, range: 9.2,  speed: 26, splash: { radius: 3.6, falloff: 0.45 }, burn: { dps: 60, dur: 4 } },
                   { cost: 1100, damage: 520, cooldown: 1.35, range: 10.0, speed: 28, splash: { radius: 4.2, falloff: 0.45 }, burn: { dps: 145, dur: 4 } }],
  'fire+light':   [{ cost: 450, damage: 120, cooldown: 0.60, range: 13.5, speed: 110, armorPen: 8, chain: { count: 3, falloff: 0.7 } },
                   { cost: 1100, damage: 295, cooldown: 0.55, range: 14.5, speed: 115, armorPen: 14, chain: { count: 4, falloff: 0.72 } }],
  'dark+fire':    [{ cost: 450, damage: 148, cooldown: 0.95, range: 10.0, speed: 36, burn: { dps: 70, dur: 4 }, execute: 0.12 },
                   { cost: 1100, damage: 365, cooldown: 0.90, range: 10.8, speed: 38, burn: { dps: 168, dur: 4 }, execute: 0.18 }],
  'nature+water': [{ cost: 450, damage: 92,  cooldown: 0.70, range: 10.2, speed: 42, slow: { amt: 0.66, dur: 3.4 }, splash: { radius: 2.0, falloff: 0.7 } },
                   { cost: 1100, damage: 228, cooldown: 0.65, range: 11.0, speed: 45, slow: { amt: 0.80, dur: 4.0 }, splash: { radius: 2.5, falloff: 0.7 } }],
  'earth+water':  [{ cost: 450, damage: 105, cooldown: 1.10, range: 9.4,  speed: 28, splash: { radius: 3.2, falloff: 0.5 }, slow: { amt: 0.58, dur: 3.2 } },
                   { cost: 1100, damage: 262, cooldown: 1.05, range: 10.2, speed: 30, splash: { radius: 3.8, falloff: 0.5 }, slow: { amt: 0.74, dur: 3.8 } }],
  'light+water':  [{ cost: 450, damage: 84,  cooldown: 0.55, range: 13.0, speed: 100, slow: { amt: 0.50, dur: 2.8 }, armorPen: 6 },
                   { cost: 1100, damage: 205, cooldown: 0.50, range: 14.0, speed: 105, slow: { amt: 0.62, dur: 3.4 }, armorPen: 11 }],
  // Poison — Darkness + Water. Heavy damage-over-time, light direct hit.
  'dark+water':   [{ cost: 450, damage: 58,  cooldown: 0.40, range: 10.0, speed: 48, poison: { dps: 85, dur: 5, stack: true } },
                   { cost: 1100, damage: 142, cooldown: 0.36, range: 10.8, speed: 52, poison: { dps: 205, dur: 5, stack: true } }],
  'earth+nature': [{ cost: 450, damage: 78,  cooldown: 0.42, range: 9.8,  speed: 46, splash: { radius: 2.2, falloff: 0.6 }, lifesteal: 1 },
                   { cost: 1100, damage: 192, cooldown: 0.38, range: 10.6, speed: 50, splash: { radius: 2.7, falloff: 0.6 }, lifesteal: 2 }],
  'light+nature': [{ cost: 450, damage: 70,  cooldown: 0.30, range: 12.0, speed: 105, armorPen: 6 },
                   { cost: 1100, damage: 174, cooldown: 0.26, range: 13.0, speed: 110, armorPen: 12 }],
  // Disease — Darkness + Nature. Contagion: a weaker DoT that also splashes to
  // neighbours, so it scales with pack density rather than single-target time.
  'dark+nature':  [{ cost: 450, damage: 66,  cooldown: 0.55, range: 10.2, speed: 44, poison: { dps: 52, dur: 6, stack: true }, splash: { radius: 2.6, falloff: 0.35 } },
                   { cost: 1100, damage: 162, cooldown: 0.50, range: 11.0, speed: 48, poison: { dps: 126, dur: 6, stack: true }, splash: { radius: 3.2, falloff: 0.35 } }],
  'earth+light':  [{ cost: 450, damage: 175, cooldown: 1.00, range: 12.6, speed: 70, splash: { radius: 2.8, falloff: 0.55 }, armorPen: 9 },
                   { cost: 1100, damage: 430, cooldown: 0.95, range: 13.6, speed: 75, splash: { radius: 3.4, falloff: 0.55 }, armorPen: 16 }],
  'dark+earth':   [{ cost: 450, damage: 230, cooldown: 1.30, range: 9.6,  speed: 30, splash: { radius: 3.4, falloff: 0.5 }, execute: 0.16 },
                   { cost: 1100, damage: 570, cooldown: 1.25, range: 10.4, speed: 32, splash: { radius: 4.0, falloff: 0.5 }, execute: 0.24 }],
  'dark+light':   [{ cost: 450, damage: 160, cooldown: 0.70, range: 12.8, speed: 120, damageType: 'pure', chain: { count: 3, falloff: 0.8 } },
                   { cost: 1100, damage: 395, cooldown: 0.65, range: 13.8, speed: 125, damageType: 'pure', chain: { count: 5, falloff: 0.82 } }],
};

export const DUAL_TOWERS = {};
for (const [key, def] of Object.entries(DUALS)) {
  DUAL_TOWERS[def.id] = {
    key: def.id,
    kind: 'dual',
    pair: key,
    parts: key.split('+'),
    name: `${def.name} Tower`,
    color: def.color,
    accent: def.accent,
    glyph: '◆',
    tagline: '',
    levels: DUAL_STATS[key],
  };
}

/**
 * The foundation — a cheap, inert 2x2 block of cut stone.
 *
 * Element TD's actual build flow is "raise a plain tower, THEN decide what it
 * becomes", and that flow is what makes mazing approachable: you shape the
 * route with something you can afford on wave 1 and commit an element to it
 * later. We had no such piece, so every wall segment cost 60 gold AND a
 * permanent element decision, which is why the board kept coming out as a
 * scatter of towers rather than a maze.
 *
 * It never acquires a target and never fires — see the `inert` guard in
 * TowerManager.update. Its only job is to occupy four cells.
 *
 * PRICING IS DELIBERATELY COST-NEUTRAL. Game.convertTower credits the
 * foundation's full cost against the element tower, so foundation (20) then
 * convert (60 - 20 = 40) totals exactly the 60 that building the element tower
 * outright would have cost. Mazing with foundations is therefore free in the
 * limit; you only ever pay the 20 for blocks you choose never to arm. Anything
 * less generous makes the feature a trap — a tool for shaping the maze that
 * quietly taxes you for using it would be worse than not having it.
 */
export const FOUNDATION = {
  key: 'foundation',
  kind: 'inert',
  element: null,
  name: 'Foundation',
  color: 0x9aa2ae,
  accent: 0xd2d8e2,
  glyph: '▣',
  tagline: 'Shapes the maze. Becomes anything.',
  levels: [{ cost: 20, damage: 0, cooldown: 0, range: 0, speed: 0 }],
};

/**
 * Primal towers. Six entries, THREE levels each.
 *
 * BALANCE STATEMENT, so nobody re-tunes these blind. Every figure below was
 * recomputed from this table, not carried over — run
 * `node tools/scratch/primal-logic.mjs` or recompute from `levels` directly;
 * a number in a comment is a rumour until it is derived from the array under it.
 *
 *   direct DPS (damage/cooldown), mean of the six
 *     L0   375.2  vs mean fusion L0  167.1  =  2.25x
 *     L1   981.9  vs mean fusion L1  447.7  =  2.19x
 *     L2  1949.4  vs mean fusion L1  447.7  =  4.35x   (and 1.99x its own L1)
 *   gold efficiency (dps per gold of cumulative cost)
 *     L1   981.9/3100 = 0.3167  vs fusion 447.7/1550 = 0.2889  =  +9.6%
 *     L2  1949.4/6200 = 0.3144  vs the same fusion baseline    =  +8.8%
 *
 * A primal is therefore 2.2x a fusion PER TILE at L1 and 4.4x at L2, while
 * staying inside 1.1x per gold at every level. That asymmetry is the whole
 * design: late-game boards run out of tiles with good coverage long before they
 * run out of gold, so the primal is the answer to "I have three good tiles left
 * and a boss inbound" and NOT to "how do I out-economy the board". Raising the
 * gold efficiency turns it into the only correct purchase in the game.
 *
 * NOTE THE SIGN ON THE THIRD LEVEL: gold efficiency goes DOWN, 0.3167 -> 0.3144.
 * It is the only upgrade in the game that does. That is deliberate and it is the
 * entire justification for the tier existing — you buy it because you have run
 * out of board, never because it is the best use of the next 3 100 gold. If a
 * future re-tune makes L2 the efficiency peak as well, the tier has stopped
 * being a tile decision and the design is gone.
 *
 * Cumulative cost is 900 + 2200 + 3100 = 6 200, exactly 4x a fully-forged fusion
 * (1 550), and the L2 step alone (3 100) costs exactly what the whole two-level
 * primal used to. The mental model to ship is "a primal costs two fusions and
 * two element stacks to raise, and two more fusions to finish".
 *
 * The six are close to each other on direct DPS ON PURPOSE — they are separated
 * by their signature effect, never by raw numbers, so the choice of which primal
 * to chase is a choice about the wave you are facing. MEASURED spread, because
 * this is the one claim in this docblock that has been wrong before:
 *     L0  -7.9% (Maelstrom) .. +6.6% (Tectonic)   <- historical, NOT +/-4%
 *     L1  -4.3% (Maelstrom) .. +3.2% (Tectonic)
 *     L2  -0.3% (Oblivion)  .. +0.4% (Maelstrom)
 * L0's spread predates this table's current form and is left alone: retuning the
 * entry price of six towers to chase a comment is a worse trade than recording
 * what is actually there. The new tier is authored to the rule.
 *
 * Levels beyond the build cost GOLD ONLY. PRIMAL.stacksConsumed is the entry
 * price of the tile, not a per-level price, and Game.sellTower refunds it in
 * full at any level — see the note on PRIMAL in Config.js.
 */
const PRIMAL_STATS = {
  // CATACLYSM — a burning field. Fire's pure identity (burn) at 2.5x its best
  // fusion (Blacksmith L1 burns 145/s; this burns 380/s) plus splash, so the
  // burn is applied to the whole pack rather than to one body.
  // L2 takes the burn to 720/s over a 4.4 radius and holds it half a second
  // longer: the ground stops being something creeps cross and becomes something
  // they survive.
  fire: [
    { cost: 900,  damage: 260, cooldown: 0.70, range: 11.5, speed: 44,
      splash: { radius: 3.2, falloff: 0.50 }, burn: { dps: 150, dur: 4 } },
    { cost: 2200, damage: 640, cooldown: 0.65, range: 12.4, speed: 48,
      splash: { radius: 3.8, falloff: 0.50 }, burn: { dps: 380, dur: 4 } },
    { cost: 3100, damage: 1170, cooldown: 0.60, range: 13.3, speed: 52,
      splash: { radius: 4.4, falloff: 0.50 }, burn: { dps: 720, dur: 4.5 } },
  ],
  // MAELSTROM — control, taken to its limit. 0.85 slow is the hardest on the
  // board (Well L1 is 0.80) and chain 6 is the widest, so it is the only tower
  // that applies its slow to a whole column at once.
  // L2 is 0.90 for five seconds across eight targets — 10% of walking speed,
  // held for longer than most waves take to cross the tower's range. It is
  // deliberately NOT 1.0: a real stun would delete the pathing read entirely.
  water: [
    { cost: 900,  damage: 190, cooldown: 0.55, range: 12.0, speed: 60,
      slow: { amt: 0.72, dur: 3.5 }, chain: { count: 4, falloff: 0.75 } },
    { cost: 2200, damage: 470, cooldown: 0.50, range: 13.0, speed: 65,
      slow: { amt: 0.85, dur: 4.2 }, chain: { count: 6, falloff: 0.78 } },
    { cost: 3100, damage: 900, cooldown: 0.46, range: 14.0, speed: 70,
      slow: { amt: 0.90, dur: 5.0 }, chain: { count: 8, falloff: 0.80 } },
  ],
  // WORLDROOT — 5.9 shots/s, the fastest weapon in the game (Bloom L1 is 3.8),
  // with a stacking poison. Its damage is in the DoT it keeps re-applying, not
  // in the hit, which makes it the anti-swarm answer and terrible against one
  // fat boss. That is the intended weakness.
  // L2 fires every 0.15s — 6.7 shots/s, and still the fastest thing on the
  // board by a wide margin. The weakness is untouched on purpose: 292 per hit
  // against a boss is nothing, the tower lives on the 580/s stacking poison it
  // re-applies to a pack.
  nature: [
    { cost: 900,  damage: 76,  cooldown: 0.20, range: 10.6, speed: 70,
      poison: { dps: 120, dur: 5, stack: true }, splash: { radius: 1.8, falloff: 0.75 } },
    { cost: 2200, damage: 165, cooldown: 0.17, range: 11.4, speed: 76,
      poison: { dps: 300, dur: 5, stack: true }, splash: { radius: 2.2, falloff: 0.75 } },
    { cost: 3100, damage: 292, cooldown: 0.15, range: 12.2, speed: 82,
      poison: { dps: 580, dur: 5, stack: true }, splash: { radius: 2.7, falloff: 0.75 } },
  ],
  // TECTONIC — 1520 in one shell, 2.7x Howitzer's 570, over a 5.4 radius, and
  // it strips 22 armour. The slowest cadence in the game (0.67 shots/s) so it
  // is a siege piece: devastating on a packed lane, wasted on stragglers.
  // L2 is 2 820 in one shell over a 6.2 radius — three tiles in every direction
  // — and strips 34 armour. Still the slowest cadence in the game.
  earth: [
    { cost: 900,  damage: 620,  cooldown: 1.55, range: 10.4, speed: 30,
      splash: { radius: 4.6, falloff: 0.40 }, armorPen: 12 },
    { cost: 2200, damage: 1520, cooldown: 1.50, range: 11.2, speed: 32,
      splash: { radius: 5.4, falloff: 0.40 }, armorPen: 22 },
    { cost: 3100, damage: 2820, cooldown: 1.45, range: 12.0, speed: 34,
      splash: { radius: 6.2, falloff: 0.40 }, armorPen: 34 },
  ],
  // JUDGEMENT — 17.5 range (the board is 52x40; nothing else exceeds 14.5),
  // pure damage so armour is irrelevant, and the strongest execute in the game.
  // Projectiles.#impact computes dmg *= 1 + missing * execute * 6, so at 90%
  // missing HP this multiplies by 3.6x.
  // L2 reaches 19.0 — over a third of the board's 52-unit width from one tile —
  // and its execute multiplies by 1 + 0.9*0.42*6 = 3.27x on a creep at 10% HP.
  light: [
    { cost: 900,  damage: 235, cooldown: 0.62, range: 16.0, speed: 130,
      damageType: 'pure', execute: 0.20, chain: { count: 2, falloff: 0.85 } },
    { cost: 2200, damage: 570, cooldown: 0.58, range: 17.5, speed: 140,
      damageType: 'pure', execute: 0.30, chain: { count: 3, falloff: 0.88 } },
    { cost: 3100, damage: 1055, cooldown: 0.54, range: 19.0, speed: 150,
      damageType: 'pure', execute: 0.42, chain: { count: 4, falloff: 0.90 } },
  ],
  // OBLIVION — execute plus the only life recovery in the game. `lifesteal` was
  // declared on earth+nature and implemented NOWHERE; shipping this tower meant
  // implementing it in Projectiles.#impact, which retroactively makes
  // Mushroom's advertised "Leech" true as well.
  // L2's execute is 4.13x on a creep at 10% HP, the hardest finisher in the
  // game, and it returns 3 lives a kill. ECONOMY.maxLives (50) is what stops
  // that being a second unbounded currency — see the note there.
  dark: [
    { cost: 900,  damage: 300, cooldown: 0.80, range: 11.0, speed: 40,
      execute: 0.28, lifesteal: 1, poison: { dps: 90,  dur: 6, stack: true } },
    { cost: 2200, damage: 760, cooldown: 0.76, range: 11.8, speed: 44,
      execute: 0.42, lifesteal: 2, poison: { dps: 230, dur: 6, stack: true } },
    { cost: 3100, damage: 1400, cooldown: 0.72, range: 12.7, speed: 48,
      execute: 0.58, lifesteal: 3, poison: { dps: 440, dur: 6, stack: true } },
  ],
};

export const PRIMAL_TOWERS = {};
for (const [el, p] of Object.entries(PRIMALS)) {
  const e = ELEMENTS[el];
  PRIMAL_TOWERS[p.id] = {
    key: p.id,
    kind: 'primal',
    element: el,
    name: `${p.name} Tower`,
    color: e.color,        // see the note in Elements.js — must be the element hex
    accent: e.accent,
    glyph: e.glyph,
    tagline: p.tagline,
    levels: PRIMAL_STATS[el],
  };
}

export const ALL_TOWERS = { ...PURE_TOWERS, ...DUAL_TOWERS, ...PRIMAL_TOWERS, foundation: FOUNDATION };

/**
 * Resolve a tower key. Accepts the canonical id and also the ids used by an
 * earlier incorrect naming draft, so tooling and saved boards keep working.
 */
export function towerDef(key) {
  return ALL_TOWERS[key] ?? ALL_TOWERS[LEGACY_DUAL_IDS[key]] ?? null;
}

/**
 * Which towers can the player build given the elements they hold?
 *
 * `ownedElements` is Game.state.elements, an array that CAN NOW CONTAIN
 * DUPLICATES. Everything below that only cares about presence still reads the
 * distinct keys; the primal branch reads the counts. Passing a Set into this
 * function silently disables primals forever — every count collapses to 1.
 *
 * A PRIMAL BUILD CAN NEVER BREAK A FUSION. Spending PRIMAL.stacksConsumed of
 * three copies leaves one, and the fusion loops below are derived from
 * `counts.keys()`, so the element is still held and every pairing survives.
 * Only the primal itself re-locks. That is why chooseElement/build/sellTower
 * only ever need hud.refreshBuildBar() and never a fusion rebuild.
 */
export function availableTowers(ownedElements) {
  const list = Array.isArray(ownedElements) ? ownedElements : [...ownedElements];
  const counts = new Map();
  for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
  const owned = [...counts.keys()];

  const out = [];
  for (const id of owned) if (PURE_TOWERS[id]) out.push(PURE_TOWERS[id]);
  for (let i = 0; i < owned.length; i++) {
    for (let j = i + 1; j < owned.length; j++) {
      const d = DUALS[pairKey(owned[i], owned[j])];
      if (d) out.push(DUAL_TOWERS[d.id]);
    }
  }
  for (const id of owned) {
    if ((counts.get(id) ?? 0) >= PRIMAL.stacksRequired) out.push(PRIMAL_TOWERS[PRIMALS[id].id]);
  }
  return out;
}

/**
 * Legal MORPH targets: everything buildable except primals.
 *
 * A primal's real price is two element stacks, and a gold formula cannot quote
 * that: charging stacks inside Game.morphCost would make both illegible, and a
 * discounted route into the game's ceiling collapses the ceiling. Build one, or
 * arm a foundation. Foundations are excluded for the mirror-image reason — they
 * already have convertTower, and two mechanics for one action is how the two
 * prices end up disagreeing.
 *
 * The gate is otherwise the same as convertTower's: a target you could not have
 * built is a target the element picker never gave you, and morph must not be a
 * back door around it. Maximum size 6 pures + 15 fusions = 21 (the caller drops
 * the source's own key, so at most 20 cards ever render).
 */
export function morphTargets(ownedElements) {
  return availableTowers(ownedElements).filter((d) => d.kind !== 'primal');
}
