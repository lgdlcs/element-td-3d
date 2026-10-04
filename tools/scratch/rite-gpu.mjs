#!/usr/bin/env node
/**
 * RITE GPU LEDGER: does a 3D rite leak, and does it compile mid-play?
 *
 *   node tools/scratch/rite-gpu.mjs --rite luckyshot --port 5281 [--q high] [--dpr 1] [--cycles 3]
 *
 * Opens the rite, starts it, fires real clicks at the field for a second, closes
 * it, and repeats. Reads the STAGE renderer's info after each phase:
 *
 *   - programs must not grow between "ready" (the intro card, after the host's
 *     compile) and "played": a new program during play is a shader compile
 *     mid-rite (docs/PERF_BUDGET.md, Round 11).
 *   - textures must not grow either: a texture first used during play is an
 *     upload on a played frame.
 *   - textures and programs after close must be the same on every cycle: growth
 *     there is a leak on the session-long context.
 *
 * Exits 1 and says which rule broke.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const RITE = arg('rite', 'luckyshot');
const PORT = Number(arg('port', 5273));
const Q = arg('q', 'high');
const DPR = Number(arg('dpr', 1));
const CYCLES = Number(arg('cycles', 3));

const browser = await chromium.launch({
  args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`, '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: DPR });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;',
}));
await page.goto(`http://localhost:${PORT}/?q=${Q}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 120000 });
await page.evaluate(() => {
  const g = window.__game;
  g.hud.closeElementPicker(); g.state.pendingElementPicks = 0; g.state.phase = 'prep'; g.state.paused = true;
});

const raf = (n) => page.evaluate((k) => new Promise((res) => {
  let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f);
}), n);
const info = () => page.evaluate(() => {
  const s = window.__game.minigames._stage;
  if (!s) return null;
  const r = s.renderer;
  return { tex: r.info.memory.textures, geo: r.info.memory.geometries, prog: r.info.programs?.length ?? 0,
    buf: `${s.canvas.width}x${s.canvas.height}`, dpr: r.getPixelRatio() };
});

const rows = [];
for (let c = 0; c < CYCLES; c++) {
  await page.evaluate((id) => window.__game.startMinigame(id, 20, 0), RITE);
  await page.waitForFunction(() => window.__game.minigames.ownsFrame, null, { timeout: 30000 });
  await raf(5);
  const ready = await info();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game.minigames.mode === 'play', null, { timeout: 15000 });
  for (const [x, y] of [[0, -2], [3, -0.6], [-4, 1], [6, -2], [-6, -0.6], [1, 1], [-2, -2], [4, 1]]) {
    const p = await page.evaluate(([fx, fy]) => window.__game.minigames.fieldToClient(fx, fy), [x, y]);
    await page.mouse.click(p.x, p.y);
    await raf(4);
  }
  await raf(20);
  const played = await info();
  await page.evaluate(() => window.__game.minigames.close());
  await raf(5);
  const closed = await info();
  rows.push({ ready, played, closed });
  console.log(`cycle ${c}  ready ${JSON.stringify(ready)}  played ${JSON.stringify(played)}  closed ${JSON.stringify(closed)}`);
}
await browser.close();

const broke = [];
rows.forEach((r, c) => {
  if (r.played.prog > r.ready.prog) broke.push(`cycle ${c}: ${r.played.prog - r.ready.prog} program(s) compiled during play`);
  if (r.played.tex > r.ready.tex) broke.push(`cycle ${c}: ${r.played.tex - r.ready.tex} texture(s) first uploaded during play`);
  if (c > 0 && (r.closed.tex !== rows[0].closed.tex || r.closed.prog !== rows[0].closed.prog)) {
    broke.push(`cycle ${c}: after close tex/prog ${r.closed.tex}/${r.closed.prog}, cycle 0 had ${rows[0].closed.tex}/${rows[0].closed.prog}`);
  }
});
if (errors.length) broke.push(`console errors: ${errors.slice(0, 5).join(' | ')}`);
console.log(broke.length ? `FAIL\n  ${broke.join('\n  ')}` : 'OK: no mid-play compile or upload, nothing left behind on close');
process.exit(broke.length ? 1 : 0);
