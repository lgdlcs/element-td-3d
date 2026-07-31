/**
 * Two real browsers, one real server, one real room.
 *
 * The component tests each proved their own half. This proves the only thing that
 * matters to a player: that two people can get into a room and see each other's
 * scores. It is deliberately end-to-end and deliberately UI-driven where it can
 * be — clicking the actual buttons, not calling the callbacks — because the wiring
 * between Lobby, NetClient, main.js and the server is exactly what no component
 * test could cover.
 *
 * Assumes `node server/index.js` is already listening on 5274.
 *
 * `?mp` forces the lobby: main.js bypasses it under `navigator.webdriver` so the
 * rest of the probe harness keeps working, which means the lobby is the ONE thing
 * that has to be asked for explicitly.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const OUT = process.argv[2] || '/private/tmp/claude-501/-Users-pouetpouets-code/c57263d9-aa43-4151-90a5-60492452382f/scratchpad';
const URL = 'http://localhost:5273/?q=low&mp';

const R = [];
const ok = (name, cond, detail = '') => {
  R.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`);
};

const browser = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });

async function newClient(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(`${tag}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`${tag} console: ${m.text()}`); });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby, null, { timeout: 90000 });
  return { p, errs, tag };
}

const A = await newClient('A');
const B = await newClient('B');

// --- the lobby is actually on screen, and the run has NOT started -------------
const aState = await A.p.evaluate(() => ({
  visible: !!document.querySelector('#lobby')?.offsetParent,
  phase: window.__game.state.phase,
  begun: !!window.__game._begun,
}));
ok('lobby is visible', aState.visible);
ok('the run has not started behind it', aState.phase === 'lobby' && !aState.begun,
  `phase=${aState.phase} begun=${aState.begun}`);

// The scene must be live behind the overlay, not a frozen first frame.
const drifted = await A.p.evaluate(async () => {
  const g = window.__game;
  const a = g.elapsed;
  await new Promise((r) => setTimeout(r, 500));
  return g.elapsed - a;
});
ok('the world renders behind the lobby', drifted > 0.2, `elapsed advanced ${drifted.toFixed(2)}s`);

// --- connection reached the server -------------------------------------------
await A.p.waitForFunction(() => window.__net?.state === 'online', null, { timeout: 15000 })
  .then(() => ok('client A reached the server', true))
  .catch(() => ok('client A reached the server', false, 'never went online'));

// --- A creates a room, by clicking ------------------------------------------
await A.p.fill('#lobby-name', 'Ada');
await A.p.click('#lobby-create');
await A.p.waitForFunction(() => /^[A-Z0-9]{4}$/.test(document.querySelector('#lobby-code-chars')?.textContent?.trim() || ''), null, { timeout: 15000 });
const code = (await A.p.textContent('#lobby-code-chars')).trim();
ok('A created a room with a 4-char code', /^[A-Z0-9]{4}$/.test(code), `code ${code}`);
ok('the code avoids ambiguous characters', !/[IO01]/.test(code), `code ${code}`);

// --- B joins by typing the code ---------------------------------------------
await B.p.fill('#lobby-name', 'Grace');
await B.p.fill('#lobby-code-in', code.toLowerCase());   // lowercase must work
await B.p.click('#lobby-join');
await B.p.waitForFunction(() => (document.querySelectorAll('#lobby-roster li.lb-row:not(.open)').length >= 2), null, { timeout: 15000 })
  .then(() => ok('B joined and sees two players', true))
  .catch(async () => ok('B joined and sees two players', false,
    `roster had ${await B.p.evaluate(() => document.querySelectorAll('#lobby-roster li.lb-row:not(.open)').length)}`));

// A learns about B through the server's DEBOUNCED `lobby` broadcast, not through
// B's own `joined`. Reading A's roster the instant B's shows two rows is a race
// the probe loses, and it loses it in the direction that looks like a real bug —
// the first version of this reported "A never sees B arrive" for a server that was
// broadcasting correctly. Wait for A specifically.
await A.p.waitForFunction(
  () => document.querySelectorAll('#lobby-roster li.lb-row:not(.open)').length >= 2,
  null, { timeout: 15000 },
).catch(() => {});
const rosterA = await A.p.evaluate(() =>
  [...document.querySelectorAll('#lobby-roster li.lb-row:not(.open)')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()));
ok('A also sees both players', rosterA.length >= 2, rosterA.join(' | ').slice(0, 120));
ok('both names appear', rosterA.some((t) => t.includes('Ada')) && rosterA.some((t) => t.includes('Grace')),
  rosterA.join(' | ').slice(0, 120));

// --- a name from another machine cannot inject -------------------------------
//
// Done HERE, while the room is still in its lobby phase. The first version ran it
// after the host pressed Start, where the server correctly refuses the join with
// IN_PROGRESS — so the payload never reached anyone's DOM and the "escaped"
// result was vacuous. The probe's own guard caught that, which is the only reason
// it is not still passing for the wrong reason.
//
// The payload must also fit the contract's 16-character name limit or the server
// rejects it as BAD_NAME, which is the other way this test can pass while proving
// nothing. `<b>zap</b>` is 10 characters and fails observably: unescaped, a real
// <b> element appears in the row.
const XSS = '<b>zap</b>';
const C = await newClient('C');
await C.p.fill('#lobby-name', XSS);
await C.p.fill('#lobby-code-in', code);
await C.p.waitForFunction(() => !document.querySelector('#lobby-join')?.disabled, null, { timeout: 15000 })
  .then(() => ok('a 10-char hostile name is accepted by the form', true))
  .catch(() => ok('a 10-char hostile name is accepted by the form', false,
    'join stayed disabled — payload never sent, so escaping is untested'));
await C.p.click('#lobby-join');
await A.p.waitForFunction(
  () => document.querySelectorAll('#lobby-roster li.lb-row:not(.open)').length >= 3,
  null, { timeout: 15000 },
).catch(() => {});

const injected = await A.p.evaluate(() => {
  const names = [...document.querySelectorAll('#lobby-roster .lb-name')];
  return {
    literal: names.some((n) => n.textContent.includes('<b>zap</b>')),
    // If the name were interpolated raw, the <b> would be a child ELEMENT of the
    // name span. Counting elements is the direct test; counting text is not.
    tags: names.reduce((a, n) => a + n.querySelectorAll('*').length, 0),
  };
});
ok('the hostile name reached A\'s UI', injected.literal,
  'if false, the escaping result below proves nothing');
ok('the hostile name was escaped, not parsed', injected.tags === 0,
  `${injected.tags} child elements inside name spans`);
await C.p.close();

// --- the host starts; both clients must get the SAME seed --------------------
await B.p.click('#lobby-ready').catch(() => {});
await A.p.click('#lobby-ready').catch(() => {});
await A.p.waitForTimeout(600);
await A.p.click('#lobby-start');

for (const c of [A, B]) {
  await c.p.waitForFunction(() => !!window.__game?._begun, null, { timeout: 15000 })
    .then(() => ok(`${c.tag} started the run`, true))
    .catch(() => ok(`${c.tag} started the run`, false, 'never begun'));
}
const seedA = await A.p.evaluate(() => window.__game.seed);
const seedB = await B.p.evaluate(() => window.__game.seed);
ok('both clients share one seed', seedA === seedB && seedA > 0, `${seedA} vs ${seedB}`);

// The whole point of the shared seed: identical element offers.
const offerA = await A.p.evaluate(() => window.__game.rollElementChoices().map((e) => e.id));
const offerB = await B.p.evaluate(() => window.__game.rollElementChoices().map((e) => e.id));
ok('both clients are offered the same elements', offerA.join() === offerB.join(),
  `${offerA.join(',')} vs ${offerB.join(',')}`);

ok('the lobby is gone once the run starts',
  !(await A.p.evaluate(() => !!document.querySelector('#lobby')?.offsetParent)));

// --- scores flow both ways ---------------------------------------------------
// Diverge the two boards so the leaderboard has something to rank.
await A.p.evaluate(() => { window.__game.state.score = 4321; window.__game.state.lives = 44; });
await B.p.evaluate(() => { window.__game.state.score = 111; });

// `num()` formats with a NARROW NO-BREAK SPACE, so 4321 renders as "4 321" with
// U+202F and a regex written with an ASCII space silently never matches. Strip all
// whitespace classes before comparing rather than guessing which separator the
// formatter chose.
const sawBoth = async (c) => c.p.waitForFunction(() => {
  const rows = [...document.querySelectorAll('#scoreboard li.sb-row')];
  const flat = (s) => s.replace(/[\s   ]/g, '');
  return rows.length >= 2 && rows.some((r) => flat(r.textContent).includes('4321'));
}, null, { timeout: 20000 }).then(() => true).catch(() => false);

ok('A sees a two-player leaderboard with the live score', await sawBoth(A));
ok('B sees the same leaderboard', await sawBoth(B));

// This assertion has now been wrong in BOTH directions, which is worth recording.
//
// Round 1 read `rows[0]` and called it the leader. That was wrong: the panel was
// sorted visually with the CSS `order` property, so DOM order was join order and a
// correctly sorted board reported "the leader is ranked second".
//
// Round 2 asserted `leader.order === '1'` instead. That then became wrong when the
// scoreboard's own review found that flex `order` leaves the <ol> frozen at build
// time, so assistive technology reads a stale ranking — the fix replaced inline
// order with real DOM reordering, and this probe was left asserting the very
// behaviour that was removed for accessibility.
//
// So the check is now: DOM order IS the ranking, and there is no inline order left.
// That is the property the code actually promises.
const rowsB = await B.p.evaluate(() =>
  [...document.querySelectorAll('#scoreboard li.sb-row')].map((n) => ({
    rank: n.querySelector('.sb-rank')?.textContent?.trim(),
    inlineOrder: n.style.order,
    text: n.textContent.replace(/\s+/g, ' ').trim(),
  })));
console.log(`    B's board: ${rowsB.map((r) => `#${r.rank} ${r.text}`).join('  //  ').slice(0, 180)}`);
ok('the highest score is ranked 1', /Ada/.test(rowsB[0]?.text ?? ''),
  rowsB[0]?.text ?? '(empty)');
ok('DOM order carries the ranking', rowsB[0]?.rank === '1',
  `first row is rank ${rowsB[0]?.rank}`);
ok('no inline CSS order is left to go stale for screen readers',
  rowsB.every((r) => !r.inlineOrder),
  `[${rowsB.map((r) => r.inlineOrder || '-').join(',')}]`);

await A.p.screenshot({ path: `${OUT}/mp-ingame.png` });

// --- the run end is reported -------------------------------------------------
await B.p.evaluate(() => { window.__game.state.lives = 0; window.__game.creeps.onLeak?.(0, 'normal'); });
await B.p.waitForTimeout(1500);
const bEnded = await B.p.evaluate(() => window.__game.state.phase);
ok('B is eliminated', bEnded === 'gameover', `phase ${bEnded}`);
const aSeesElim = await A.p.waitForFunction(() => {
  const rows = [...document.querySelectorAll('#scoreboard li.sb-row')];
  return rows.some((r) => /out|elim|dead|✕|—/i.test(r.className + ' ' + r.textContent));
}, null, { timeout: 15000 }).then(() => true).catch(() => false);
ok('A sees B as eliminated rather than vanished', aSeesElim);

const errs = [...A.errs, ...B.errs, ...C.errs];
const fail = R.filter((r) => !r.pass).length;
console.log(`\n${errs.length ? `PAGE ERRORS:\n${errs.slice(0, 10).join('\n')}` : 'no page errors'}`);
console.log(`\n${fail === 0 && errs.length === 0 ? 'ALL GREEN' : `${fail} failed, ${errs.length} page errors`}`);
console.log(`wrote ${OUT}/mp-ingame.png`);
await browser.close();
process.exit(fail || errs.length ? 1 : 0);
