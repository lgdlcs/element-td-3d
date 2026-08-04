/**
 * The key sheet, photographed.
 *
 * Three frames, because the feature is three claims and each has to be seen:
 *   1. the sheet open over a real midgame board (does it read? does it fit?)
 *   2. the same board with the sheet closed  — the CONTROL. Without the pair,
 *      "the sheet is up" is not evidence of anything (PITFALLS §11).
 *   3. the top bar cropped, so the key caps on speed/pause/help are legible at
 *      the size they actually ship at rather than as 8px of mush in a 1080p PNG.
 *
 * Also asserts the two behaviours a screenshot cannot show: H toggles, Escape
 * and an outside click close it, and a wave starting takes it away.
 *
 *   node tools/scratch/ux-helpshot.mjs <outdir> [tag]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const OUT = process.argv[2] || 'shots';
const TAG = process.argv[3] || 'now';
const W = Number(process.argv[4] || 1920);
const H = Number(process.argv[5] || 1080);
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const errs = [];
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());

// A real board underneath, so the veil is judged against content and not black.
await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  g.state.gold = 4820; g.state.wave = 21; g.state.lives = 43; g.state.score = 128400;
  for (const [k, c, r] of [['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7], ['ice', 18, 7],
    ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9], ['blaze', 6, 11], ['void', 10, 11],
    ['magic', 14, 11], ['life', 18, 11]]) g.build(k, c, r);
  g.hud.refreshBuildBar();
  await new Promise((r) => setTimeout(r, 1200));
});
await p.waitForTimeout(1500);

const shot = (n) => p.screenshot({ path: `${OUT}/help-${TAG}-${n}-${W}x${H}.png` });

// CONTROL first: the same frame with no sheet.
await shot('closed');
await p.screenshot({ path: `${OUT}/help-${TAG}-topbar-${W}x${H}.png`, clip: { x: W - 560, y: 0, width: 560, height: 62 } });

await p.keyboard.press('h');
await p.waitForTimeout(500);
const opened = await p.evaluate(() => window.__game.hud.helpOpen);
await shot('open');

const box = await p.evaluate(() => {
  const s = document.querySelector('.help-sheet');
  const r = s.getBoundingClientRect();
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    scrolls: s.scrollHeight > s.clientHeight + 1,
    rows: document.querySelectorAll('#help .help-group li').length,
    groups: document.querySelectorAll('#help .help-group').length,
    caps: document.querySelectorAll('#help kbd').length,
  };
});

// Escape closes.
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
const afterEsc = await p.evaluate(() => window.__game.hud.helpOpen);

// The topbar button opens it, and a click on the veil closes it again.
await p.click('#help-btn');
await p.waitForTimeout(350);
const afterBtn = await p.evaluate(() => window.__game.hud.helpOpen);
await p.mouse.click(60, Math.round(H * 0.5));
await p.waitForTimeout(350);
const afterOutside = await p.evaluate(() => window.__game.hud.helpOpen);
// The outside click must NOT have leaked to the board.
const towersAfter = await p.evaluate(() => window.__game.towers.towers.length);

// F (tower table) evicts it, and it evicts the tower table.
await p.keyboard.press('h');
await p.waitForTimeout(250);
await p.keyboard.press('f');
await p.waitForTimeout(250);
const bothA = await p.evaluate(() => ({ help: window.__game.hud.helpOpen, codex: window.__game.hud.build.codexOpen }));
await p.keyboard.press('h');
await p.waitForTimeout(250);
const bothB = await p.evaluate(() => ({ help: window.__game.hud.helpOpen, codex: window.__game.hud.build.codexOpen }));

// Combat takes it away.
await p.evaluate(() => { window.__game.hud.setHelp(true); window.__game.startWaveNow(); });
await p.waitForTimeout(400);
const afterWave = await p.evaluate(() => ({ help: window.__game.hud.helpOpen, phase: window.__game.state.phase }));

// Typing in a field must not toggle it (the guard every other listener has).
const inField = await p.evaluate(async () => {
  const i = document.createElement('input');
  document.body.appendChild(i); i.focus();
  i.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', key: 'h', bubbles: true }));
  const on = window.__game.hud.helpOpen;
  i.remove();
  return on;
});

const line = (ok, s) => console.log(`${ok ? 'ok  ' : 'FAIL'}  ${s}`);
console.log(`sheet ${box.w}x${box.h}px  groups=${box.groups} rows=${box.rows} caps=${box.caps} scrolls=${box.scrolls}`);
line(opened, 'H opens the sheet');
line(!afterEsc, 'Escape closes it');
line(afterBtn, 'the topbar button opens it');
line(!afterOutside, 'a click outside closes it');
line(towersAfter === 16, `the outside click did not reach the board (towers ${towersAfter})`);
line(!box.scrolls, 'the sheet fits without scrolling');
line(!bothA.help && bothA.codex, 'F swaps the tower table in');
line(bothB.help && !bothB.codex, 'H swaps the sheet back in');
line(!afterWave.help && afterWave.phase === 'combat', 'a wave starting closes it');
line(!inField, 'typing h in a text field does not open it');
console.log(errs.length ? `\nERRORS:\n${errs.slice(0, 8).join('\n')}` : '\nno console errors');
await b.close();
