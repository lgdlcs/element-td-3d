#!/usr/bin/env node
/**
 * RITE CAPTURE HARNESS — photographs the minigame overlay and the lottery.
 *
 *   node tools/rite-shots.mjs --rite luckyshot --out shots/rite/
 *
 * tools/shot.mjs could not photograph any of this: its scenarios all end in a
 * board state, and its black-frame guard (mean L < 25) aborts on a veiled
 * overlay, which is legitimately dark. This script boots the same way, opens a
 * rite through the same public entry point the dev panel uses
 * (`game.startMinigame`), and writes a numbered series of PNGs at named
 * instants: the entry transition, the first playable frame, mid-session, a
 * success beat, a miss beat, the result card in both variants, and the exit.
 *
 * Flags:
 *   --rite    heaven | platforms | luckyshot | offroad | hunt | fishing | lottery
 *   --board   loaded | empty     what is behind the veil
 *   --w --h --dpr                viewport
 *   --tag                        filename prefix
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const RITE = arg('rite', 'luckyshot');
const BOARD = arg('board', 'loaded');
const OUTDIR = resolve(arg('out', 'shots/rite'));
const W = Number(arg('w', 1600));
const H = Number(arg('h', 900));
const DPR = Number(arg('dpr', 1));
const TAG = arg('tag', `${RITE}-${W}x${H}${DPR !== 1 ? `@${DPR}x` : ''}`);
const WAVE = Number(arg('wave', 12));

mkdirSync(OUTDIR, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.route('**/@vite/client', (route) => route.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;',
}));

await page.goto('http://localhost:5273/?q=high', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const shots = [];
const snap = async (name) => {
  const file = `${OUTDIR}/${TAG}-${String(shots.length).padStart(2, '0')}-${name}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png', timeout: 120000 }));
  shots.push(file);
  return file;
};

// ---- set the board up behind the veil -------------------------------------
await page.evaluate(async (board) => {
  const g = window.__game;
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  if (board === 'loaded') {
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    g.state.pendingElementPicks = 0;
    g.state.gold = 999999;
    g.hud.refreshBuildBar();
    const MAZE = [
      ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
      ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
      ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
      ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
      ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
      ['dark', 14, 15],
    ];
    for (const [k, c, r] of MAZE) g.build(k, c, r);
    g.state.wave = 20;
  }
  await new Promise((r) => setTimeout(r, 2200));
}, BOARD);

await snap('board-before');

if (RITE === 'lottery') {
  await snap('rail-seal');
  await page.evaluate((w) => { window.__game.lottery?.devOpen?.(w); }, WAVE);
  await page.waitForTimeout(300);
  await snap('open');
  await page.waitForTimeout(900);
  await snap('spinning');
  await page.evaluate(() => window.__game.lottery.close?.());
  await page.waitForTimeout(300);

  // Which waves, on this seed, produce which outcome? Use the real path — the
  // draw is a pure function of (seed, wave) — rather than forcing a field.
  const byOutcome = await page.evaluate(async () => {
    const l = window.__game.lottery;
    const m = {};
    for (let w = 3; w <= 55; w++) {
      const before = window.__game.state.gold;
      window.__game.state.gold = 999999;
      l._wageredWave = -1;
      if (!l.devOpen(w)) continue;
      const o = l._draw?.outcome; const id = typeof o === 'string' ? o : (o?.id ?? o?.key ?? o?.name);
      if (id && !m[id]) m[id] = w;
      l.close?.();
      window.__game.state.gold = before;
      await new Promise((r) => setTimeout(r, 10));
    }
    return m;
  });
  for (const [id, w] of Object.entries(byOutcome)) {
    await page.evaluate((wv) => {
      const l = window.__game.lottery;
      l.close?.(); window.__game.state.gold = 999999; l._wageredWave = -1; l.devOpen(wv);
    }, w);
    await page.waitForTimeout(1600);
    await snap(`spin-${id}`);
    await page.keyboard.press('Escape');   // reveal now
    await page.waitForTimeout(220);
    await snap(`reveal-${id}`);
    await page.waitForTimeout(700);
    await snap(`card-${id}`);
    await page.evaluate(() => window.__game.lottery.close?.());
    await page.waitForTimeout(250);
  }
  console.error('outcome waves:', JSON.stringify(byOutcome));
  await page.evaluate(() => window.__game.lottery.close?.());
  await page.waitForTimeout(300);
  await snap('after-close');
} else {
  const box = { x: 0, y: 0, w: 0, h: 0 };

  await page.evaluate(({ id, wave }) => {
    window.__game.startMinigame(id, wave, 0);
  }, { id: RITE, wave: WAVE });

  // The entry transition. --t-base 240ms / --t-slow 320ms.
  await page.waitForTimeout(80);
  await snap('enter-080ms');
  await page.waitForTimeout(80);
  await snap('enter-160ms');
  await page.waitForTimeout(180);
  await snap('enter-340ms-settled');

  const stage = await page.locator('#rite-stage').boundingBox();
  Object.assign(box, { x: stage.x, y: stage.y, w: stage.width, h: stage.height });

  // ---- play it. Generic input that suits every rite: pointer sweeping the
  // stage plus commits and slot presses, so something is always happening.
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(400);
  await snap('t0.7-hover-centre');

  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx + Math.sin(i) * box.w * 0.32, cy + Math.cos(i * 1.7) * box.h * 0.3);
    await page.keyboard.press('Space');
    await page.keyboard.press(`Digit${1 + (i % 6)}`);
    await page.waitForTimeout(120);
    if (i === 1) await snap('t1.2-first-commits');
    if (i === 5) await snap('t2.0-mid');
  }
  await snap('t2.6-after-input');

  // Hover + focus states on the chrome.
  await page.hover('#rite-skip');
  await page.waitForTimeout(260);
  await snap('skip-hover');
  await page.evaluate(() => document.querySelector('#rite-skip').focus());
  await page.waitForTimeout(200);
  await snap('skip-focus');
  await page.mouse.move(cx, cy);

  // Let it run to roughly half the clock, sweeping.
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(cx + Math.sin(i * 0.6) * box.w * 0.36, cy + Math.cos(i * 0.9) * box.h * 0.34);
    if (i % 3 === 0) await page.keyboard.press('Space');
    if (i % 4 === 0) await page.keyboard.press(`Digit${1 + (i % 6)}`);
    await page.waitForTimeout(140);
  }
  await snap('t7-midsession');

  // The armed-escape state.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await snap('escape-armed');
  await page.waitForTimeout(2600); // let it disarm
  await snap('escape-disarmed');

  // Suspension.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(300);
  await snap('suspended');
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await snap('resuming-grace');
  await page.waitForTimeout(1200);

  // Low clock.
  await page.evaluate(() => { window.__game.minigames._remaining = 3.2; });
  await page.waitForTimeout(400);
  await snap('clock-low');

  // A real result card: force a strong score, then let the clock expire.
  await page.evaluate(() => {
    const h = window.__game.minigames;
    const inner = h.instance;
    const real = inner.score.bind(inner);
    inner.score = () => { const s = real(); return { ...s, ratio: 0.94 }; };
    h._remaining = 0.05;
  });
  await page.waitForTimeout(120);
  await snap('result-in-120ms');
  await page.waitForTimeout(260);
  await snap('result-settled');
  await page.waitForTimeout(1400);
  await snap('result-gold-tweened');
  await page.hover('#rite-continue');
  await page.waitForTimeout(240);
  await snap('result-continue-hover');

  // Exit transition.
  await page.evaluate(() => window.__game.minigames.close());
  await page.waitForTimeout(90);
  await snap('exit-090ms');
  await page.waitForTimeout(250);
  await snap('exit-340ms');

  // And the empty (abandoned) card.
  await page.evaluate(({ id, wave }) => {
    window.__game.state.phase = 'prep';
    window.__game.startMinigame(id, wave, 0);
  }, { id: RITE, wave: WAVE });
  await page.waitForTimeout(600);
  await page.click('#rite-skip');
  await page.waitForTimeout(500);
  await snap('result-empty-skipped');
  await page.evaluate(() => window.__game.minigames.close());
}

await browser.close();
console.log(JSON.stringify({ tag: TAG, shots, errors: logs.filter((l) => /error/.test(l)) }, null, 2));
