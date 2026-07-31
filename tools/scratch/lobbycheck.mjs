/**
 * Node-side sanity check for src/ui/Lobby.js.
 *
 * There is no DOM here, so this cannot render the overlay — the caller
 * screenshots that. What it CAN prove is the two things that break silently:
 *
 *  1. importing the module touches no DOM (a top-level `document.*` would throw
 *     right here, and in the browser it would break boot import order);
 *  2. the public API is complete, so an integration written against
 *     docs/MULTIPLAYER.md cannot fail on a missing setter at runtime.
 *
 * It also lints the source for the two hazards that are invisible in a
 * screenshot: an unescaped remote string reaching innerHTML, and an import from
 * src/game/ (this module owns no game state).
 *
 * Run: node tools/scratch/lobbycheck.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../src/ui/Lobby.js');
const CSS = resolve(here, '../../src/ui/lobby.css');

let failures = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
};

// -- 1. import is side-effect free ------------------------------------------
// If the module (or anything it pulls in) touched document/window at import
// time, this line throws with a ReferenceError instead of resolving. `globalThis
// .document` is deliberately NOT stubbed: the point is to fail if it is needed.
console.log('import');
let Lobby;
try {
  ({ Lobby } = await import(SRC));
  ok(true, 'imports with no DOM present');
} catch (err) {
  ok(false, 'imports with no DOM present', err.message);
}
ok(typeof globalThis.document === 'undefined', 'no document was created as a side effect');
ok(typeof Lobby === 'function', 'exports class Lobby');

// -- 2. public API ----------------------------------------------------------
console.log('api');
const REQUIRED = ['show', 'hide', 'setState', 'setPlayers', 'setCode', 'setError', 'setConnection'];
for (const m of REQUIRED) {
  ok(typeof Lobby?.prototype?.[m] === 'function', `Lobby.prototype.${m}()`);
}
ok(Lobby?.length <= 2, 'constructor takes (root, callbacks)', `arity ${Lobby?.length}`);

// -- 3. source-level guarantees --------------------------------------------
console.log('source');
const src = readFileSync(SRC, 'utf8');

ok(!/from\s+['"][^'"]*\/game\//.test(src), 'imports nothing from src/game/');
ok(/import\s*\{[^}]*\besc\b[^}]*\}\s*from\s*'\.\/uikit\.js'/.test(src), 'imports esc from uikit.js');

// Every interpolation inside a template literal that is later assigned to
// innerHTML and carries player-supplied data must be wrapped in esc(). Rather
// than parse JS, check the two call sites by name and that no bare `p.name` or
// bare `this.code` interpolation exists.
const bareName = src.match(/\$\{\s*p\.name\s*\}/g);
ok(!bareName, 'no unescaped ${p.name} interpolation', bareName ? `${bareName.length} found` : '');
ok(/\$\{esc\(p\.name\)\}/.test(src), 'player names go through esc()');
ok(/esc\(c\)/.test(src), 'room-code characters go through esc()');

// The six contract error codes must each have a sentence, or setError falls
// through to the server's log-line wording.
for (const code of ['NO_ROOM', 'ROOM_FULL', 'IN_PROGRESS', 'BAD_NAME', 'NOT_HOST', 'RATE_LIMIT']) {
  ok(new RegExp(`\\b${code}\\s*:`).test(src), `error sentence for ${code}`);
}

// The contract's room rules, mirrored as constants rather than magic numbers.
ok(/MAX_PLAYERS\s*=\s*6/.test(src), 'MAX_PLAYERS is 6');
ok(/CODE_LEN\s*=\s*4/.test(src), 'CODE_LEN is 4');
ok(/NAME_MAX\s*=\s*16/.test(src), 'NAME_MAX is 16');
ok(!/[IO01]/.test(src.match(/CODE_ALPHABET\s*=\s*'([^']*)'/)?.[1] ?? 'I'),
  'code alphabet excludes I, O, 0 and 1');
// maxlength would truncate silently, which the brief forbids.
// The attribute, not the word: the source explains in a comment why it is
// absent, and that comment must not itself trip the check.
ok(!/maxlength\s*=/i.test(src), 'name field has no maxlength attribute (limit is shown, not enforced)');

// -- 4. css ----------------------------------------------------------------
console.log('css');
const css = readFileSync(CSS, 'utf8');
ok(/#lobby\[hidden\]\s*\{\s*display:\s*none/.test(css), '#lobby[hidden] beats display:grid');
ok(/#lobby\s+:focus-visible/.test(css), 'focus ring declared locally');
// Every state class the JS toggles needs a rule, or a state renders as all
// three cards stacked.
for (const s of ['s-idle', 's-connecting', 's-lobby', 's-offline']) {
  ok(css.includes(`.${s}`), `css handles .${s}`);
}
ok(!/--ink:|--gold:/.test(css), 'defines no palette tokens of its own (inherits ui.css)');

// -- 5. live DOM (optional: node tools/scratch/lobbycheck.mjs --dom) --------
//
// Everything above is text analysis. This part drives the real class in a real
// browser, because the three things most likely to be wrong are invisible to a
// linter: whether a hostile player name actually executes, whether the code
// field normalises as you type, and whether the name survives a reload.
//
// Files are served straight off disk through page.route rather than through
// vite: Lobby.js and its imports have no bare specifiers, so no transform is
// needed and there is no server process to leave running.
if (process.argv.includes('--dom')) {
  console.log('dom');
  const ROOT = resolve(here, '../..');
  const { chromium } = await import('playwright');
  const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

  const PAGE = /* html */`<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="/src/ui/ui.css"><link rel="stylesheet" href="/src/ui/lobby.css">
    </head><body><div id="app"><div id="ui-root"></div></div>
    <script type="module">
      import { Lobby } from '/src/ui/Lobby.js';
      window.__calls = [];
      window.lobby = new Lobby(document.getElementById('ui-root'), {
        onCreate: (n) => window.__calls.push(['create', n]),
        onJoin: (n, c) => window.__calls.push(['join', n, c]),
        onReady: (r) => window.__calls.push(['ready', r]),
        onStart: () => window.__calls.push(['start']),
        onSolo: (n) => window.__calls.push(['solo', n]),
        onLeave: () => window.__calls.push(['leave']),
      });
      window.lobby.setConnection('open');
      window.lobby.show();
      window.__ready = true;
    <\/script></body></html>`;

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/lobbytest.html') return route.fulfill({ contentType: 'text/html', body: PAGE });
    try {
      const body = readFileSync(resolve(ROOT, `.${path}`));
      const ext = path.slice(path.lastIndexOf('.'));
      return route.fulfill({ contentType: TYPES[ext] || 'application/octet-stream', body });
    } catch { return route.fulfill({ status: 404, body: 'nope' }); }
  });

  const load = async () => {
    await page.goto('http://lobby.test/lobbytest.html');
    await page.waitForFunction('window.__ready === true');
  };
  await load();

  ok(errors.length === 0, 'no page errors on construct', errors.join(' / '));
  ok(await page.isVisible('#lobby'), 'overlay is visible after show()');
  const prefilled = await page.inputValue('#lobby-name');
  ok(prefilled.length >= 1 && prefilled.length <= 16, 'name prefilled within 1–16', `"${prefilled}"`);

  // Forgiving code field: lowercase, a dash and a space, plus a character that
  // is not in the alphabet, and one too many.
  await page.fill('#lobby-code-in', '');
  await page.type('#lobby-code-in', 'a b-c3dz');
  const codeVal = await page.inputValue('#lobby-code-in');
  ok(codeVal === 'ABC3', 'code input normalises to 4 uppercase alphabet chars', `got "${codeVal}"`);

  // Over-limit name: shown, not truncated, and the actions lock.
  await page.fill('#lobby-name', 'x'.repeat(20));
  ok((await page.inputValue('#lobby-name')).length === 20, 'over-limit name is not silently truncated');
  ok(/trim to 16/.test(await page.textContent('#lobby-name-note')), 'the limit is stated when exceeded');
  ok(await page.isDisabled('#lobby-create'), 'create is blocked while the name is over the limit');

  // Persistence across a reload.
  await page.fill('#lobby-name', 'Zephyrbind');
  await load();
  ok(await page.inputValue('#lobby-name') === 'Zephyrbind', 'name persisted to localStorage and prefilled');

  // THE important one: a hostile name from another machine must render as text.
  await page.evaluate(() => {
    window.lobby.setState('lobby');
    window.lobby.setCode('ab2c');
    window.lobby.setPlayers([
      { id: 'a', name: '<img src=x onerror="window.__xss=1">', host: true, ready: false },
      { id: 'b', name: 'you & "them" <b>', host: false, ready: true },
    ], 'b');
  });
  await page.waitForTimeout(80);
  ok(await page.evaluate(() => window.__xss === undefined), 'hostile player name did not execute');
  ok(await page.evaluate(() => document.querySelectorAll('#lobby-roster .lb-name b, #lobby-roster img').length) === 0,
    'no markup from a player name reached the DOM');
  ok((await page.textContent('#lobby-roster')).includes('<img src=x'), 'the name is shown verbatim as text');
  ok(await page.evaluate(() => document.querySelectorAll('#lobby-roster li').length) === 6,
    'roster draws six seats');
  ok((await page.textContent('#lobby-code-chars')) === 'AB2C', 'lowercase room code is upper-cased and shown per character');

  // Start button: hidden for a non-host, and the note names who does start it.
  ok(await page.isHidden('#lobby-start'), 'non-host sees no Start button');
  ok(/is the host/.test(await page.textContent('#lobby-start-note')), 'note names the host');

  // As host with someone not ready, then everyone ready.
  await page.evaluate(() => window.lobby.setPlayers([
    { id: 'b', name: 'Me', host: true, ready: true },
    { id: 'a', name: 'Slowcoach', host: false, ready: false },
  ], 'b'));
  ok(await page.isVisible('#lobby-start'), 'host sees the Start button');
  ok(await page.isDisabled('#lobby-start'), 'Start is disabled while someone is not ready');
  ok(/Slowcoach/.test(await page.textContent('#lobby-start-note')), 'the block is explained by name');
  await page.evaluate(() => window.lobby.setPlayers([
    { id: 'b', name: 'Me', host: true, ready: true },
    { id: 'a', name: 'Slowcoach', host: false, ready: true },
  ], 'b'));
  ok(!(await page.isDisabled('#lobby-start')), 'Start enables once everyone is ready');

  // Escape leaves the room; solo works from every state including offline.
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => window.__calls.some((c) => c[0] === 'leave')), 'Escape in a room calls onLeave');
  await page.evaluate(() => { window.lobby.setConnection('offline'); window.lobby.setState('offline'); });
  ok(await page.isVisible('#lobby-solo'), 'Play solo is visible in the offline state');
  await page.click('#lobby-solo');
  ok(await page.evaluate(() => window.__calls.some((c) => c[0] === 'solo' && c[1])),
    'onSolo fires with a name even with no server');

  // Every contract error code renders a sentence, not a code.
  for (const code of ['NO_ROOM', 'ROOM_FULL', 'IN_PROGRESS', 'BAD_NAME', 'NOT_HOST', 'RATE_LIMIT']) {
    const txt = await page.evaluate((c) => {
      window.lobby.setError(c, 'raw log wording');
      return document.getElementById('lobby-error').textContent;
    }, code);
    ok(txt.length > 20 && !txt.includes(code), `${code} renders as a sentence`, txt);
  }

  ok(errors.length === 0, 'no page errors across the whole run', errors.join(' / '));
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
