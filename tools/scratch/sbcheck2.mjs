/**
 * Geometry + data-shape probe for the scoreboard, written for the review of
 * src/ui/Scoreboard.js and src/ui/scoreboard.css.
 *
 * WHY IT MEASURES AREA, NOT VERTICAL SPAN
 *
 * The review measured "vertical overlap with #threat", which reports a
 * collision at 900px wide even though the threat rail is translated off screen
 * by ui.css's `max-width: 900px` rule at that size — the two boxes share rows
 * of the viewport but no pixels. Every collision number below is the real
 * intersection AREA of the two client rects, so a rail that has slid away
 * scores 0 the way a player sees it. The vertical span is printed alongside for
 * comparison with the review's numbers.
 *
 * Run: node tools/scratch/sbcheck2.mjs [--rows=6]
 * Needs the vite dev server on 5273.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const ROWS = Number((process.argv.find((a) => a.startsWith('--rows=')) || '--rows=6').slice(7));

// The viewports the task names, plus the ones the review found broken and the
// band around the narrow breakpoint where the dock starts reaching the rail.
const VIEWS = [
  [1600, 900], [1440, 900], [1280, 800], [1100, 700], [1024, 640],
  [1440, 760], [1440, 698], [1440, 640], [1440, 600], [1440, 520],
  [1300, 650], [1200, 620], [1150, 700], [1101, 700], [1050, 700],
  [1000, 760], [1000, 640], [960, 700], [950, 700], [900, 700], [880, 620],
  [2200, 1200],
];

let fails = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { fails++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

const browser = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await page.goto('http://localhost:5273/?q=low&mp', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__scoreboard, null, { timeout: 90000 });

// ---------------------------------------------------------------------------
// PART 1 — data shape: the server's pre-first-status roster entry.
// Verbatim from what server/rooms.js publicPlayer() emits after resetRunState:
// lives 0, wave 0, finished false. Game.snapshot() clamps wave to >= 1, so
// wave 0 can ONLY mean "this player has never reported".
// ---------------------------------------------------------------------------
const seeded = (id, name) => ({ id, name, host: false, ready: false, lives: 0, score: 0, wave: 0, killed: 0, leaked: 0, towers: 0, finished: false, won: false });

const readRows = () => page.evaluate(() => [...document.querySelectorAll('#scoreboard li.sb-row')].map((x) => ({
  id: x.dataset.id,
  order: x.style.order,
  domIndex: [...x.parentNode.children].indexOf(x),
  out: x.classList.contains('out'),
  waiting: x.classList.contains('waiting'),
  lives: x.querySelector('.sb-lives')?.textContent,
  wave: x.querySelector('.sb-wave')?.textContent,
})));

console.log('\n== fresh roster (nobody has sent status) ==');
await page.evaluate((s) => { window.__scoreboard.show(); window.__scoreboard.update(s, 'p1'); },
  [seeded('p1', 'Ada'), seeded('p2', 'Grace'), seeded('p3', 'Lin')]);
let rows = await readRows();
console.log(JSON.stringify(rows));
ok(rows.every((r) => !r.out), 'nobody who has not reported is marked eliminated',
  `${rows.filter((r) => r.out).length}/${rows.length} out`);
ok(rows.every((r) => r.wave !== 'W1'), 'no fabricated "W1" for a relayed wave of 0',
  rows.map((r) => r.wave).join(' '));
ok(rows.every((r) => r.lives !== 'out'), 'lives column does not claim "out"',
  rows.map((r) => r.lives).join(' '));

console.log('\n== mixed: one reporting, one dead, one still silent ==');
await page.evaluate(() => window.__scoreboard.update([
  { id: 'p1', name: 'Ada', lives: 18, score: 1500, wave: 5, finished: false },
  { id: 'p2', name: 'Grace', lives: 0, score: 900, wave: 4, finished: false },
  { id: 'p3', name: 'Lin', lives: 0, score: 0, wave: 0, finished: false },
], 'p1'));
rows = await readRows();
console.log(JSON.stringify(rows));
const by = Object.fromEntries(rows.map((r) => [r.id, r]));
ok(!by.p1.out, 'a live reporter is not out');
ok(by.p2.out && by.p2.lives === 'out', 'a reporter at 0 lives IS out', JSON.stringify(by.p2));
ok(!by.p3.out, 'a silent player is still not out', JSON.stringify(by.p3));

// DOM order must track the ranking, not the build order (assistive tech and
// anything else that walks an <ol> reads DOM order).
console.log('\n== DOM order tracks rank after an overtake ==');
await page.evaluate(() => window.__scoreboard.update([
  { id: 'p1', name: 'Ada', lives: 18, score: 100, wave: 5 },
  { id: 'p2', name: 'Grace', lives: 20, score: 999, wave: 6 },
  { id: 'p3', name: 'Lin', lives: 20, score: 500, wave: 6 },
], 'p1'));
rows = await readRows();
console.log(JSON.stringify(rows.map((r) => `${r.id}@dom${r.domIndex}/order${r.order}`)));
ok(rows.map((r) => r.domIndex).join() === '0,1,2' && rows.map((r) => r.id).join() === 'p2,p3,p1',
  'DOM sequence equals leaderboard sequence', rows.map((r) => r.id).join());

// Reordering the DOM must MOVE the rows, not re-emit them. If an overtake went
// back through #build the <li>s would be new nodes, every score bar would jump
// to its new width with no animation, and the row cache would churn — which is
// the whole reason the old code reordered with the flex `order` property.
const identity = await page.evaluate(() => {
  const tag = (v) => [...document.querySelectorAll('#scoreboard li.sb-row')].forEach((li, i) => { li.__mark = `${v}${i}`; });
  tag('a');
  // Overtake in the other direction, twice, so rows move both up and down.
  window.__scoreboard.update([
    { id: 'p1', name: 'Ada', lives: 18, score: 9000, wave: 9 },
    { id: 'p2', name: 'Grace', lives: 20, score: 999, wave: 6 },
    { id: 'p3', name: 'Lin', lives: 20, score: 5000, wave: 8 },
  ], 'p1');
  const marks = [...document.querySelectorAll('#scoreboard li.sb-row')].map((li) => li.__mark);
  return { marks, ids: [...document.querySelectorAll('#scoreboard li.sb-row')].map((li) => li.dataset.id) };
});
console.log(JSON.stringify(identity));
ok(identity.ids.join() === 'p1,p3,p2', 'the new ranking is in the DOM', identity.ids.join());
ok(identity.marks.every((m) => typeof m === 'string'), 'rows were moved, not rebuilt',
  `marks ${JSON.stringify(identity.marks)}`);

// ---------------------------------------------------------------------------
// PART 2 — geometry. Six rows, every viewport, real rect intersection.
// Deliberately BEFORE the showFinal test: showFinal latches the panel, and an
// earlier draft of this probe ran it first and then measured a stale two-row
// panel at every viewport ("ROWS 2/6"), which made every geometry number a
// measurement of the wrong panel height.
// ---------------------------------------------------------------------------
const six = Array.from({ length: ROWS }, (_, i) => ({
  id: `q${i}`, name: `Player${i}`, lives: 20 - i * 3, score: 5000 - i * 700, wave: 12 - i,
}));

// The rail's height is a function of the WAVE, not of the viewport: measured
// across all 30 waves its bottom edge is 426px on a quiet wave and 530px on a
// boss wave (4/14/24), because the boss card grows. The review measured the
// quiet rail only, so every viewport is swept twice here.
const RAILS = [['quiet', 0], ['boss', 4]];

console.log('\n== geometry (intersection AREA px², and the review\'s vertical span) ==');
console.log('  viewport   rail   panel(x,y,w,h)          vs #threat        vs #dock       centre');
const geo = [];
for (const [w, h] of VIEWS) {
 for (const [railName, wave] of RAILS) {
  await page.setViewportSize({ width: w, height: h });
  // Threat has no refresh(): the rail is rebuilt from game state by the render
  // loop, one frame later. An earlier draft set state.wave and immediately
  // updated the scoreboard, so #fit() measured the PREVIOUS wave's rail and
  // every reading came out one step behind (quiet passes yielding, boss passes
  // showing and then overlapping once the rail grew).
  await page.evaluate((wv) => { window.__game.state.wave = wv; }, wave);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
  await page.evaluate((s) => { window.__scoreboard.show(); window.__scoreboard.update(s, 'q0'); }, six);
  // 400ms, not two rAFs: the panel's show/hide is a 320ms opacity transition, and
  // reading it 30ms after a state change reports a panel that is fading IN as
  // hidden. That artifact made half the sweep read "hidden" when the panel was
  // in fact on its way to fully visible.
  await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(r), 400)));
  const m = await page.evaluate(() => {
    const rc = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.02) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const inter = (a, b) => {
      if (!a || !b) return { area: 0, vspan: 0 };
      const ow = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oh = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      return { area: ow > 0 && oh > 0 ? Math.round(ow * oh) : 0, vspan: Math.max(0, Math.round(oh)) };
    };
    const sb = rc('#scoreboard');
    const panel = document.querySelector('#scoreboard');
    const hitCentre = document.elementsFromPoint(innerWidth / 2, innerHeight / 2).includes(panel);
    return {
      crowded: panel.classList.contains('crowded'),
      sb, threat: inter(sb, rc('#threat')), dock: inter(sb, rc('#dock')),
      inspector: inter(sb, rc('#inspector')), topbar: inter(sb, rc('#topbar')),
      hitCentre, pe: getComputedStyle(panel).pointerEvents,
      offTop: sb ? sb.y < 0 : false, offBottom: sb ? sb.bottom > innerHeight : false,
      rowsVisible: [...document.querySelectorAll('#scoreboard li.sb-row')]
        .filter((li) => li.getBoundingClientRect().height > 1).length,
      clipped: (() => {
        const list = document.querySelector('#sb-list');
        return list ? Math.round(list.scrollHeight - list.clientHeight) : 0;
      })(),
    };
  });
  geo.push([w, h, railName, m]);
  const s = m.sb;
  console.log(`  ${String(w).padStart(4)}x${String(h).padStart(4)}  ${railName.padEnd(6)}`
    + `${s ? `(${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.w)},${Math.round(s.h)})`.padEnd(22) : (m.crowded ? 'YIELDED' : 'hidden').padEnd(22)}`
    + `  area ${String(m.threat.area).padStart(6)} span ${String(m.threat.vspan).padStart(3)}`
    + `  area ${String(m.dock.area).padStart(5)} span ${String(m.dock.vspan).padStart(3)}`
    + `  ${m.hitCentre ? 'COVERED' : 'clear'}${m.clipped > 0 ? `  CLIPPED ${m.clipped}px` : ''}`
    + `${s && m.rowsVisible !== ROWS ? `  ROWS ${m.rowsVisible}/${ROWS}` : ''}`);
 }
}
await page.evaluate(() => { window.__game.state.wave = 0; });

// The hard invariant, at every size and at both rail heights: two glass cards
// may never share a pixel, and the panel may never enter the board centre.
console.log('');
for (const [w, h, rail, m] of geo) {
  ok(m.threat.area === 0, `${w}x${h} ${rail}: no pixel overlap with #threat`, `${m.threat.area}px²`);
}
for (const [w, h, rail, m] of geo) {
  ok(m.dock.area === 0, `${w}x${h} ${rail}: no pixel overlap with #dock`, `${m.dock.area}px²`);
}
for (const [w, h, rail, m] of geo) {
  ok(m.inspector.area === 0 && m.topbar.area === 0, `${w}x${h} ${rail}: clear of #inspector and #topbar`);
  ok(!m.hitCentre, `${w}x${h} ${rail}: board centre not covered`);
  ok(m.pe === 'none', `${w}x${h} ${rail}: pointer-events none`);
  if (m.sb) {
    ok(!m.offTop && !m.offBottom, `${w}x${h} ${rail}: panel fully on screen`,
      `y=${Math.round(m.sb.y)} bottom=${Math.round(m.sb.bottom)}`);
    ok(m.rowsVisible === ROWS && m.clipped === 0, `${w}x${h} ${rail}: all ${ROWS} rows rendered, nothing clipped`,
      `${m.rowsVisible} rows, ${m.clipped}px clipped`);
  }
}

// Separately: the panel has to be VISIBLE, not merely non-overlapping, at the
// sizes the task names. Yielding is the last resort, not the answer.
const MUST_SHOW = ['1600x900', '1440x900', '1280x800', '1100x700', '1024x640', '2200x1200'];
for (const [w, h, rail, m] of geo) {
  if (rail !== 'quiet' || !MUST_SHOW.includes(`${w}x${h}`)) continue;
  ok(!!m.sb && !m.crowded, `${w}x${h}: panel visible with all ${ROWS} rows on a quiet rail`,
    m.crowded ? 'yielded to the rail' : 'hidden');
}
const yielded = geo.filter(([, , , m]) => m.crowded).map(([w, h, r]) => `${w}x${h}/${r}`);
console.log(`\n  yielded to the rail at: ${yielded.length ? yielded.join(' ') : 'nowhere'}`);

// ---------------------------------------------------------------------------
// PART 3 — showFinal with a single standing must not wedge the panel.
// ---------------------------------------------------------------------------
await page.setViewportSize({ width: 1440, height: 900 });
console.log('\n== showFinal with one standing, then a later run ==');
const solo = await page.evaluate(() => {
  const sb = window.__scoreboard;
  sb.showFinal([{ id: 'p1', name: 'Ada', lives: 0, score: 4200, wave: 30, finished: true, won: true }], 'p1');
  const after = { on: sb.$el.classList.contains('on'), final: sb.$el.classList.contains('is-final'), rows: sb.$list.children.length };
  // A two-entry final must still paint, and must still latch against `scores`.
  sb.showFinal([
    { id: 'p1', name: 'Ada', lives: 0, score: 4200, wave: 30, finished: true, won: true },
    { id: 'p2', name: 'Grace', lives: 0, score: 3000, wave: 22, finished: true },
  ], 'p1');
  const pair = { on: sb.$el.classList.contains('on'), rows: sb.$list.children.length, title: sb.$title.textContent };
  sb.update([{ id: 'p1', name: 'Ada', lives: 5, score: 1, wave: 2 }, { id: 'p2', name: 'Grace', lives: 5, score: 1, wave: 2 }], 'p1');
  return { after, pair, latchedScore: sb.$list.querySelector('.sb-score')?.textContent };
});
console.log(JSON.stringify(solo));
ok(solo.pair.on && solo.pair.rows === 2, 'a real final still paints after a one-entry final',
  JSON.stringify(solo.pair));
ok(solo.latchedScore !== '1', 'final standings still latch against a late `scores`', String(solo.latchedScore));

// ---------------------------------------------------------------------------
// PART 4 — reduced motion must actually kill the panel's own transitions.
// ---------------------------------------------------------------------------
console.log('\n== prefers-reduced-motion ==');
await page.setViewportSize({ width: 1440, height: 900 });
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(r), 400)));
// ui.css:1290 already clamps EVERY transition-duration to 60ms !important under
// this query, so "is the duration 0" is the wrong question — the whole HUD fades
// at 60ms by policy. What the panel must not do is MOVE, so this asserts the
// transform is identical (and none) in all three of its states.
const rm = await page.evaluate(() => {
  const sb = document.querySelector('#scoreboard');
  const t = () => getComputedStyle(sb).transform;
  sb.classList.remove('crowded');
  const on = t();
  sb.classList.remove('on');
  const off = t();
  sb.classList.add('crowded');
  const crowded = t();
  sb.classList.remove('crowded');
  document.body.classList.add('codex-open');
  const codex = t();
  document.body.classList.remove('codex-open');
  sb.classList.add('on');
  return { on, off, crowded, codex, bar: getComputedStyle(document.querySelector('.sb-bar > s')).transitionProperty };
});
console.log(JSON.stringify(rm));
ok(rm.on === 'none' && rm.off === 'none' && rm.crowded === 'none' && rm.codex === 'none',
  'the panel never moves under reduced motion (no 8px slide, no fly-out)', JSON.stringify(rm));
ok(rm.bar === 'none', 'score bar transition is off', rm.bar);
await page.emulateMedia({ reducedMotion: 'no-preference' });

// ---------------------------------------------------------------------------
// PART 5 — eyeball the tiers. Numbers prove the panels do not touch; they say
// nothing about whether a 10px row is still readable, and the compact tiers buy
// their clearance with typography.
// ---------------------------------------------------------------------------
const OUT = process.env.SB_OUT || '/private/tmp/claude-501/-Users-pouetpouets-code/c57263d9-aa43-4151-90a5-60492452382f/scratchpad';
// Fresh page, and WITHOUT `?mp`: PART 3 latched the panel with showFinal (the
// first version of this block shot a stale two-row final table at every size),
// and the `?mp` lobby is a full-screen overlay that sits over the panel, so a
// clip of the panel's box under it came out solid black. The boot veil needs a
// moment on top of that.
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__scoreboard, null, { timeout: 90000 });
await page.waitForTimeout(3000);
// The element picker is a full-screen surface that covers the whole left rail for
// the first seconds of a run, so the clip came out as a corner of the picker
// instead of the panel. Same dismissal lobbyshot.mjs uses.
await page.evaluate(() => {
  const g = window.__game;
  g.beginRun(1234);
  g.chooseElement(g.rollElementChoices()[0].id);
  g.state.pendingElementPicks = 0;
  g.hud.closeElementPicker?.();
  g.waves.start(9);
});
await page.waitForTimeout(1500);
console.log('');
for (const [w, h] of [[1600, 900], [1440, 760], [1100, 700], [1024, 640]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate((s) => { window.__scoreboard.show(); window.__scoreboard.update(s, 'q2'); }, six);
  await page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(r), 400)));
  const el = await page.$('#scoreboard');
  const box = await el.boundingBox();
  if (!box) { console.log(`  ${w}x${h}: panel not visible, no shot`); continue; }
  const pad = 14;
  await page.screenshot({
    path: `${OUT}/sb-tier-${w}x${h}.png`,
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
  console.log(`  wrote sb-tier-${w}x${h}.png  (${Math.round(box.width)}x${Math.round(box.height)})`);
}

ok(errs.length === 0, 'no page errors', errs.join(' | '));
console.log(fails === 0 ? '\nall checks passed' : `\n${fails} check(s) failed`);
await browser.close();
process.exit(fails === 0 ? 0 : 1);
