/**
 * My own verification of the scoreboard fixes, because the workflow's independent
 * recheck agent died on an API error mid-response and left them unverified.
 *
 * Two claims, both of which were MEASURED to be broken and must now be measured
 * to be fixed:
 *
 *   1. A fresh roster (lives 0, wave 0, finished false — exactly what the server
 *      seeds) must not read as eliminated. Reproduced at 2/2 before the fix.
 *   2. #scoreboard must not overlap #threat. The reviewer measured a 71px overlap
 *      of two glass panels at 1100x700, and a collision at any height under
 *      ~660px regardless of width. Overlap is computed from real bounding boxes
 *      at four viewport sizes — reading the CSS is what let this ship.
 *
 * Plus the two latching bugs, which are the kind that only appear on the second
 * use and so never appear in a screenshot.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const R = [];
const ok = (name, cond, detail = '') => {
  R.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`);
};

const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const errs = [];

// Exactly what server/rooms.js roster() emits for a player who has not reported,
// taken from a real captured frame rather than invented.
const FRESH = (id, name) => ({
  id, name, host: false, ready: false,
  lives: 0, score: 0, wave: 0, killed: 0, leaked: 0, towers: 0,
  finished: false, won: false,
});

const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=low&mp', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__scoreboard, null, { timeout: 90000 });

// --- 1. the fresh-roster elimination bug -------------------------------------
const fresh = await p.evaluate((rows) => {
  const sb = window.__scoreboard;
  sb.show();
  sb.update(rows, 'p1');
  return [...document.querySelectorAll('#scoreboard li.sb-row')].map((x) => ({
    name: x.querySelector('.sb-name')?.textContent,
    out: x.classList.contains('out'),
    lives: x.querySelector('.sb-lives')?.textContent,
    wave: x.querySelector('.sb-wave')?.textContent,
  }));
}, [FRESH('p1', 'Ada'), FRESH('p2', 'Grace'), FRESH('p3', 'Alan')]);
ok('a fresh roster reads as alive', fresh.every((r) => !r.out),
  fresh.map((r) => `${r.name}:${r.out ? 'OUT' : 'alive'}/${r.lives}/${r.wave}`).join(' '));
ok('no fabricated wave for an unreported player', !fresh.some((r) => r.wave === 'W1'),
  fresh.map((r) => r.wave).join(','));

// A player who HAS reported and then hit zero must still read as eliminated —
// the fix must not have bought rule 1 by never showing elimination at all.
const dead = await p.evaluate(() => {
  const sb = window.__scoreboard;
  sb.update([
    { id: 'p1', name: 'Ada', lives: 40, score: 900, wave: 5, killed: 20, leaked: 1, finished: false, won: false },
    { id: 'p2', name: 'Grace', lives: 0, score: 300, wave: 4, killed: 9, leaked: 50, finished: true, won: false },
  ], 'p1');
  return [...document.querySelectorAll('#scoreboard li.sb-row')].map((x) => ({
    name: x.querySelector('.sb-name')?.textContent,
    out: x.classList.contains('out'),
  }));
});
ok('a genuinely eliminated player still reads as out',
  dead.find((r) => r.name === 'Grace')?.out === true && dead.find((r) => r.name === 'Ada')?.out === false,
  dead.map((r) => `${r.name}:${r.out}`).join(' '));

// --- 2. DOM order carries the ranking (the screen-reader fix) ----------------
const order = await p.evaluate(() => {
  window.__scoreboard.update([
    { id: 'p1', name: 'Low', lives: 50, score: 10, wave: 2, finished: false },
    { id: 'p2', name: 'High', lives: 50, score: 9000, wave: 9, finished: false },
    { id: 'p3', name: 'Mid', lives: 50, score: 500, wave: 5, finished: false },
  ], 'p1');
  return [...document.querySelectorAll('#scoreboard li.sb-row')].map((x) => ({
    name: x.querySelector('.sb-name')?.textContent,
    rank: x.querySelector('.sb-rank')?.textContent,
    inlineOrder: x.style.order,
  }));
});
ok('DOM order matches the ranking',
  order.map((r) => r.name).join(',') === 'High,Mid,Low',
  order.map((r) => `${r.rank}:${r.name}`).join(' '));
ok('ranking no longer relies on inline CSS order',
  order.every((r) => !r.inlineOrder),
  `inline order values: [${order.map((r) => r.inlineOrder || '-').join(',')}]`);

// --- 3. showFinal with one standing must not latch the panel hidden ---------
const latch = await p.evaluate(async () => {
  const sb = window.__scoreboard;
  sb.showFinal([{ id: 'p1', name: 'Solo', lives: 0, score: 77, wave: 3, finished: true, won: false }], 'p1');
  await new Promise((r) => setTimeout(r, 400));
  const afterSolo = {
    on: document.querySelector('#scoreboard').classList.contains('on'),
    rows: document.querySelectorAll('#scoreboard li.sb-row').length,
  };
  // Then a multi-player final — the panel must be able to come back.
  sb.showFinal([
    { id: 'p1', name: 'Ada', lives: 0, score: 900, wave: 9, finished: true, won: false },
    { id: 'p2', name: 'Grace', lives: 12, score: 1200, wave: 12, finished: true, won: true },
  ], 'p1');
  await new Promise((r) => setTimeout(r, 400));
  return {
    afterSolo,
    afterPair: {
      on: document.querySelector('#scoreboard').classList.contains('on'),
      rows: document.querySelectorAll('#scoreboard li.sb-row').length,
    },
  };
});
ok('a solo final does not wedge the panel forever',
  latch.afterPair.on && latch.afterPair.rows === 2,
  `solo:{on:${latch.afterSolo.on},rows:${latch.afterSolo.rows}} pair:{on:${latch.afterPair.on},rows:${latch.afterPair.rows}}`);

// --- 4. panel collisions, MEASURED at four viewports ------------------------
console.log('\n--- layout, measured bounding boxes ---');
const SIZES = [[1600, 900], [1280, 800], [1100, 700], [1024, 640]];
for (const [w, h] of SIZES) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(700);
  const m = await p.evaluate(() => {
    const sb = document.querySelector('#scoreboard');
    const th = document.querySelector('#threat');
    const dock = document.querySelector('#dock');
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { x: r.x, y: r.y, w: r.width, h: r.height, shown: cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 }; };
    const over = (a, c) => {
      if (!a || !c || !a.shown || !c.shown) return 0;
      const ox = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x);
      const oy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
      return ox > 0 && oy > 0 ? Math.round(Math.min(ox, oy)) : 0;
    };
    const s = box(sb), t = box(th), d = box(dock);
    return { sb: s, threat: t, dock: d, vsThreat: over(s, t), vsDock: over(s, d) };
  });
  const okThreat = m.vsThreat === 0;
  const okDock = m.vsDock === 0;
  ok(`${w}x${h}: no overlap with the threat rail`, okThreat, `${m.vsThreat}px`);
  ok(`${w}x${h}: no overlap with the build dock`, okDock, `${m.vsDock}px`);
  console.log(`      scoreboard ${m.sb ? `${Math.round(m.sb.w)}x${Math.round(m.sb.h)} at ${Math.round(m.sb.x)},${Math.round(m.sb.y)} shown=${m.sb.shown}` : 'absent'}`);
}

await p.setViewportSize({ width: 1600, height: 900 });
await p.waitForTimeout(600);

const fail = R.filter((r) => !r.pass).length;
console.log(`\n${errs.length ? `PAGE ERRORS:\n${errs.slice(0, 8).join('\n')}` : 'no page errors'}`);
console.log(`${fail === 0 && errs.length === 0 ? 'ALL GREEN' : `${fail} failed, ${errs.length} page errors`}`);
await b.close();
process.exit(fail || errs.length ? 1 : 0);
