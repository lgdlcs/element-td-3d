#!/usr/bin/env node
/**
 * Frame time of the board alone, then of a rite on top of it, same page, same
 * build — the paired measurement docs/PERF_BUDGET.md asks every visual round for.
 *
 *   node tools/scratch/rite-frametime.mjs --rite luckyshot --port 5281 --q high
 *
 * Prints median / p95 of rAF intervals over N frames for each phase, plus
 * whether the board's pipeline rendered during the rite (it should not while a
 * 3D rite owns the frame).
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const RITE = arg('rite', 'luckyshot');
const PORT = Number(arg('port', 5273));
const Q = arg('q', 'high');
const N = Number(arg('frames', 240));

const browser = await chromium.launch({
  args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`, '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit', '--disable-gpu-vsync', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;',
}));
await page.goto(`http://localhost:${PORT}/?q=${Q}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await page.evaluate(() => {
  document.getElementById('boot')?.remove();
  const g = window.__game;
  g.hud.closeElementPicker();
  g.state.pendingElementPicks = 0;
  g.state.phase = 'prep';
  g.state.paused = true;
  window.__boardRenders = 0;
  const render = g.pipeline.render.bind(g.pipeline);
  g.pipeline.render = (...a) => { window.__boardRenders++; return render(...a); };
});

const sample = (n) => page.evaluate(async (count) => {
  const d = [];
  let last = performance.now();
  for (let i = 0; i < count; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    d.push(now - last);
    last = now;
  }
  d.sort((a, b) => a - b);
  return { median: +d[d.length >> 1].toFixed(2), p95: +d[Math.floor(d.length * 0.95)].toFixed(2) };
}, n);

await sample(60);
const board = await sample(N);
await page.evaluate((id) => window.__game.startMinigame(id, 20, 0), RITE);
await page.waitForFunction(() => {
  const h = window.__game.minigames;
  return h.isOpen && (!h.def.view || h.ownsFrame);
}, null, { timeout: 20000 });
await page.keyboard.press('Space');
await sample(30);
const renders0 = await page.evaluate(() => window.__boardRenders);
const rite = await sample(N);
const renders1 = await page.evaluate(() => window.__boardRenders);
console.log(JSON.stringify({ q: Q, id: RITE, board, rite, boardRendersDuringRite: renders1 - renders0 }, null, 2));
await browser.close();
