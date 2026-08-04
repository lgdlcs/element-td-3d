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
// key caps
// ---------------------------------------------------------------------------

/**
 * One key cap, as markup.
 *
 * Every surface that mentions a shortcut goes through here so a cap looks the
 * same on the dock, in the inspector, in the topbar and in the help sheet. The
 * element is a real `<kbd>`, so the single style rule in ui.css keeps carrying
 * the look and screen readers keep announcing it as keyboard input; this helper
 * only exists to make the escaping and the modifier class impossible to forget.
 *
 * `variant` is the modifier appended to `kbd`: 'tight' for caps embedded inside
 * a button label, 'corner' for the badge pinned to a card corner.
 */
export const key = (label, variant = '') =>
  `<kbd${variant ? ` class="k-${variant}"` : ''}>${esc(label)}</kbd>`;

/** Several caps in a row — `keyRow(['1','2','3'])`. */
export const keyRow = (labels, variant = '') => labels.map((k) => key(k, variant)).join('');

/**
 * The whole keyboard, as data, for the help sheet.
 *
 * It lives here rather than in HUD.js because three different modules own the
 * listeners it documents — Game.js (Esc/Space/P/1-3/U/M/X), BuildBar.js
 * (F/B/QWERTY) and CameraRig.js (WASD/QE/mouse) — so there is no single owner
 * whose file this could belong to. Keeping it next to PLACEMENT_TEXT at least
 * makes it one grep away from every other player-facing string.
 *
 * CAUTION: this is a TRANSCRIPT of listeners that live in files the UI does not
 * own. It is the classic comment-that-asserts-another-file's-value (PITFALLS
 * §10), so every row below names the file and the key CODE it mirrors, and the
 * sheet is deliberately written against `e.code` names (physical keys) because
 * that is what those listeners match.
 *
 * THE POSITIONS ARE CORRECT ON EVERY LAYOUT. THE LABELS ARE QWERTY'S. This
 * paragraph used to conclude "the labels are therefore correct on AZERTY too,
 * where KeyQ is the key printed A", which contradicts itself in its own second
 * clause: if that key is printed A, then a cap that reads "Q" is wrong for the
 * player holding it. A French player reads Q, presses the key printed Q (code
 * KeyA) and nothing happens; the key they want is the one printed A. Same for
 * W/A/S/D, which is Z/Q/S/D over there, and the same for BuildBar's
 * HOTKEY_LABEL, which is the other transcript of this table.
 *
 * The fix, when someone takes it, is ONE derivation point in `key()` below:
 * `navigator.keyboard.getLayoutMap()` (Chromium ships it, and this game is a
 * WebGL2 title) returns the printed glyph for a code, which would correct the
 * sheet, the dock caps and the inspector caps in one place, with these
 * constants as the fallback. It is not done here because the API is async and
 * every cap in the repo is rendered synchronously from a string — that is a
 * real refactor, not a comment fix, and shipping it half-applied would leave
 * two dialects on screen at once.
 *
 * IT IS NOT A KEYBOARD-ONLY SHEET. It shipped once claiming to be "every key on
 * the board" while omitting three live POINTER bindings, one of which — the
 * right-click that drops what you are holding — was added in the very same
 * change as the sheet. The only place it was mentioned was the transient
 * `#held-piece` chip, which disappears the instant the piece is dropped. Mouse
 * gestures are bindings like any other and they live here; tests/e2e/help.spec.js
 * checks them against the source of the listeners, not against this list.
 */
export const SHORTCUTS = [
  {
    title: 'Building',
    rows: [
      // BuildBar.js HOTKEYS — KeyQ..KeyY, in ELEMENT_ORDER.
      { keys: ['Q', 'W', 'E', 'R', 'T', 'Y'], label: 'Take an elemental tower', note: 'in element order — only the ones you have bound' },
      { keys: ['B'], label: 'Take a Foundation block', note: 'the cheap wall you can arm later' },
      { keys: ['F'], label: 'Open the Tower Table', note: 'all twenty-seven towers' },
      { keys: ['Esc'], label: 'Drop what you are holding', note: 'also closes any open panel' },
      // Game.js #wirePointer — pointerup, button 2, under the drag threshold.
      { keys: ['Right-click'], label: 'Drop what you are holding',
        note: 'a right-DRAG orbits the camera instead', wide: true },
    ],
  },
  {
    title: 'The selected tower',
    rows: [
      // Game.js #wireKeys — KeyU / KeyM / KeyX.
      { keys: ['U'], label: 'Upgrade it' },
      { keys: ['M'], label: 'Open the morph sheet' },
      { keys: ['X'], label: 'Sell it' },
    ],
  },
  {
    title: 'The run',
    rows: [
      { keys: ['Space'], label: 'Send the next wave now', note: 'the earlier you send, the bigger the bonus' },
      { keys: ['P'], label: 'Pause and resume' },
      { keys: ['1', '2', '3'], label: 'Game speed' },
    ],
  },
  {
    title: 'Camera',
    rows: [
      // CameraRig.js — key handling plus the three pointer buttons.
      { keys: ['W', 'A', 'S', 'D'], label: 'Pan across the board', note: 'the arrow keys do the same' },
      { keys: ['Q', 'E'], label: 'Rotate around the board', note: 'these two also take a tower — both happen at once, by design' },
      // CameraRig.js #bind pointerdown: button 2, or button 0 with Shift, both
      // start an orbit; button 1 starts a pan.
      { keys: ['Right-drag'], label: 'Orbit', wide: true },
      { keys: ['Shift', 'Left-drag'], label: 'Orbit without the right button', wide: true },
      { keys: ['Middle-drag'], label: 'Pan across the board', wide: true },
      { keys: ['Wheel'], label: 'Zoom towards the cursor', wide: true },
    ],
  },
  {
    title: 'Elsewhere',
    rows: [
      { keys: ['H'], label: 'This sheet', note: '? works too' },
      // PerfHud.js — KeyG / F8. BOTH are listed: F8 is a real binding and the
      // sheet's own title is "every key on the board", but help.spec.js's
      // extractor only knew Key*/Digit*/Space/Escape/Arrow*, so an F-key was
      // invisible to the equality check and the omission passed for a round.
      { keys: ['G', 'F8'], label: 'Frame-time readout' },
      // Picker.js #onKey — ArrowLeft/Right (and Up/Down) plus Enter/Space, live
      // only while the element offer is up. The picker prints the same caps in
      // its own footer; they are here so the sheet is not silent about a modal
      // the player meets on wave 1.
      { keys: ['←', '→', 'Enter'], label: 'Choose an element offer', note: 'while the offer is up' },
    ],
  },
];

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
