/**
 * Node-side checks for src/ui/Scoreboard.js.
 *
 * There is no DOM here, so this cannot and does not verify rendering. What it
 * CAN prove is the set of things that break silently in a browser:
 *
 *  1. importing the module is side-effect free — it must not touch `document`
 *     at import time (it would throw here) and must not add globals;
 *  2. the public API the HUD integrates against is actually present;
 *  3. ranking is total and deterministic, so rows do not swap on every 2 Hz
 *     relay frame when scores tie;
 *  4. every player-supplied string in the markup path goes through esc(), and
 *     the module imports nothing from src/game/ — both checked against source,
 *     because a regression here is a security bug, not a cosmetic one.
 *
 * Run: node tools/scratch/scorecheck.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../src/ui/Scoreboard.js');
const CSS = resolve(here, '../../src/ui/scoreboard.css');

let fails = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

// 1. import side effects -----------------------------------------------------
const before = new Set(Object.keys(globalThis));
ok(typeof globalThis.document === 'undefined', 'no document in this environment (import must not need one)');
const mod = await import(SRC);
const added = Object.keys(globalThis).filter((k) => !before.has(k));
ok(added.length === 0, 'import added no globals', added.join(','));

// 2. public API --------------------------------------------------------------
const { Scoreboard, rankPlayers } = mod;
ok(typeof Scoreboard === 'function', 'exports class Scoreboard');
ok(Scoreboard.length === 1, 'constructor takes (root)', `arity ${Scoreboard.length}`);
for (const m of ['show', 'hide', 'update', 'showFinal', 'setVisible']) {
  ok(typeof Scoreboard.prototype[m] === 'function', `prototype.${m}()`);
}
ok(Scoreboard.prototype.update.length === 2, 'update(players, youId)');
ok(Scoreboard.prototype.showFinal.length === 2, 'showFinal(standings, youId)');
ok(typeof rankPlayers === 'function', 'exports rankPlayers for testing');

// 3. ranking -----------------------------------------------------------------
const roster = [
  { id: 'c', name: 'Cara', score: 400, lives: 20, wave: 8 },
  { id: 'a', name: 'Ann', score: 900, lives: 5, wave: 12 },
  { id: 'b', name: 'Bo', score: 400, lives: 20, wave: 11 },
  { id: 'd', name: 'Dee', score: 0, lives: 0, wave: 3, finished: true },
];
const r1 = rankPlayers(roster);
ok(r1.map((p) => p.id).join('') === 'abcd', 'sorted by score desc, wave breaks the 400 tie',
  r1.map((p) => `${p.id}:${p.score}`).join(' '));
ok(r1.map((p) => p.rank).join('') === '1234', 'ranks are 1..n');

// Determinism across input permutations: a leaderboard that reorders when the
// server happens to relay the roster in a different order is unreadable.
const perms = [roster, [...roster].reverse(), [roster[2], roster[0], roster[3], roster[1]]];
const keys = perms.map((p) => rankPlayers(p).map((x) => x.id).join(''));
ok(new Set(keys).size === 1, 'ranking independent of input order', keys.join(' | '));

const allTied = rankPlayers([
  { id: 'z', name: 'Z', score: 0, lives: 20, wave: 1 },
  { id: 'y', name: 'Y', score: 0, lives: 20, wave: 1 },
]);
ok(allTied.map((p) => p.id).join('') === 'yz', 'fully tied players fall back to id, stably');

ok(rankPlayers(undefined).length === 0, 'rankPlayers(undefined) is empty, not a throw');
ok(rankPlayers([{ id: 1 }])[0].score === 0, 'missing fields coerce to 0');
ok(rankPlayers([{ id: 1, score: null, lives: undefined, wave: NaN }])[0].wave === 0, 'NaN/null never leak through');

// 4. source invariants -------------------------------------------------------
const src = readFileSync(SRC, 'utf8');
ok(!/from\s+['"][^'"]*\/game\//.test(src), 'imports nothing from src/game/');
ok(/import\s*\{[^}]*\besc\b[^}]*\}\s*from\s*'\.\/uikit\.js'/.test(src), 'esc comes from ./uikit.js');

// Any interpolation inside a MARKUP template literal (one containing a tag)
// that mentions name/id must be wrapped in esc(...). Blunt and textual on
// purpose: it fails loudly if someone later interpolates a name without
// escaping it. Non-markup templates — the roster signature string — are not
// DOM and are excluded by the `<` test.
const markup = (src.match(/`[^`]*`/g) ?? []).filter((t) => t.includes('<'));
ok(markup.length >= 2, 'found the markup templates to audit', `${markup.length}`);
const interps = markup.flatMap((t) => t.match(/\$\{[^}]*\}/g) ?? []);
const risky = interps.filter((s) => /\b(name|\.id)\b/.test(s) && !s.includes('esc('));
ok(risky.length === 0, 'every name/id interpolation is escaped', risky.join(' '));
ok(!/innerHTML\s*\+=/.test(src), 'no incremental innerHTML concatenation');

const css = readFileSync(CSS, 'utf8');
ok(/#scoreboard\s*\{[^}]*position:\s*absolute/.test(css), 'panel is absolutely positioned');
ok(/pointer-events:\s*none/.test(css), 'panel never eats a build click');
ok(css.includes('prefers-reduced-motion'), 'reduced-motion branch present');

console.log(fails === 0 ? '\nall checks passed' : `\n${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
