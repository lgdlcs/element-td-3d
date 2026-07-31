#!/usr/bin/env node
/**
 * UI interaction harness (owned by the UI agent).
 *
 * Drives real pointer/keyboard interaction through the HUD and captures the
 * states the static scenarios in shot.mjs cannot reach: hover tooltips, the
 * tower table, a mid-run element picker with fusions to unlock, focus rings,
 * and narrow viewports.
 *
 *   node tools/ui-shots.mjs [--w 1920] [--h 1080] [--only picker]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const W = Number(arg('w', 1920));
const H = Number(arg('h', 1080));
const ONLY = arg('only', null);
const TAG = arg('tag', `${W}x${H}`);
const OUTDIR = 'shots';
mkdirSync(OUTDIR, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// Other agents are editing the scene concurrently; Vite's HMR client would
// reload the page mid-capture and destroy the execution context. Stub it out.
await page.route('**/@vite/client', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export const createHotContext = () => ({ accept(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){} }); export const injectQuery = (u) => u; export const removeStyle = () => {};' }));

await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'commit' });

// --- 0. boot veil, caught before the game object exists ---------------------
if (!ONLY || ONLY === 'boot') {
  await page.waitForSelector('#boot .boot-title');
  await page.waitForTimeout(160);
  writeFileSync(`${OUTDIR}/ui-boot-${TAG}.png`, await page.screenshot({ type: 'png' }));
  console.log(`  → ${OUTDIR}/ui-boot-${TAG}.png`);
}

await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());

const MAZE = [
  ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
  ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['vapor', 14, 7],
  ['ice', 18, 7], ['blacksmith', 8, 9], ['poison', 12, 9], ['atom', 16, 9],
  ['lightning', 6, 11], ['howitzer', 10, 11], ['trickery', 14, 11], ['mushroom', 18, 11],
  ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
  ['dark', 14, 15],
];

const setup = async (opts) => page.evaluate(async (o) => {
  const g = window.__game;
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = o.elements;
  g.state.pendingElementPicks = o.picks ?? 0;
  g.state.gold = o.gold;
  g.state.lives = o.lives ?? 43;
  g.state.score = o.score ?? 128400;
  g.state.wave = o.wave ?? 21;
  g.state.phase = o.phase ?? 'prep';
  g.state.prepTimer = o.prep ?? 11.4;
  g.hud.closeElementPicker();
  if (o.maze) for (const [k, c, r] of o.maze) g.build(k, c, r);
  g.hud.refreshBuildBar();
  await new Promise((r) => setTimeout(r, 400));
}, opts);

const shot = async (name) => {
  await page.waitForTimeout(700);
  writeFileSync(`${OUTDIR}/${name}.png`, await page.screenshot({ type: 'png' }));
  console.log(`  → ${OUTDIR}/${name}.png`);
};

const want = (n) => !ONLY || ONLY === n;

// --- 1. tower table over a live board ---------------------------------------
if (want('codex')) {
  await setup({ elements: ['fire', 'water', 'nature', 'light'], gold: 620, maze: MAZE.slice(0, 12) });
  await page.click('#codex-toggle');
  await shot(`ui-codex-${TAG}`);
  await page.keyboard.press('Escape');
}

// --- 2. dock card hover tooltip ---------------------------------------------
if (want('hover')) {
  await setup({ elements: ['fire', 'water', 'nature', 'earth', 'light', 'dark'], gold: 4820, maze: MAZE });
  // Below 900px the aspirational fusion slots are hidden by design.
  const fusion = page.locator('#dock-fusion .tcard').first();
  await (await fusion.isVisible() ? fusion : page.locator('#dock-pure .tcard').first()).hover();
  await shot(`ui-hover-${TAG}`);
}

// --- 3. mid-run element picker with real fusions to unlock ------------------
if (want('picker')) {
  await setup({ elements: ['fire', 'water', 'nature'], gold: 980, wave: 20, picks: 2, maze: MAZE.slice(0, 8) });
  await page.evaluate(() => { window.__game.state.phase = 'pickElement'; window.__game.hud.openElementPicker(); });
  await shot(`ui-picker-mid-${TAG}`);
  await page.evaluate(() => window.__game.hud.closeElementPicker());
}

// --- 4. inspector on an upgraded tower --------------------------------------
if (want('inspector')) {
  await setup({ elements: ['fire', 'water', 'nature', 'earth', 'light', 'dark'], gold: 4820, maze: MAZE });
  await page.evaluate(() => {
    const g = window.__game;
    const t = g.towers.towers[7];
    t.totalDamage = 184320; t.kills = 412;
    g.towers.towers.forEach((x, i) => { x.totalDamage = x.totalDamage || 20000 + i * 3100; x.kills = x.kills || 40 + i * 7; });
    g.towers.upgrade(t.id);
    g.selectTower(t.id);
  });
  await shot(`ui-inspector-${TAG}`);
}

// --- 5. keyboard focus ring on the dock -------------------------------------
if (want('focus')) {
  await setup({ elements: ['fire', 'water', 'nature', 'earth', 'light', 'dark'], gold: 4820, maze: MAZE });
  await page.evaluate(() => document.querySelector('#dock-pure .tcard:nth-child(3)').focus());
  await page.keyboard.press('Tab');
  await shot(`ui-focus-${TAG}`);
}

// --- 6. wave announcement ---------------------------------------------------
if (want('announce')) {
  await setup({ elements: ['fire', 'water', 'nature', 'earth', 'light', 'dark'], gold: 4820, maze: MAZE, phase: 'combat', wave: 29 });
  await page.evaluate(() => {
    const g = window.__game;
    g.hud.announceWave({ n: 30, type: 'boss', count: 2, isBoss: true });
    g.hud.pulseLives();
  });
  await page.waitForTimeout(450);
  writeFileSync(`${OUTDIR}/ui-announce-${TAG}.png`, await page.screenshot({ type: 'png' }));
  console.log(`  → ${OUTDIR}/ui-announce-${TAG}.png`);
}

const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
console.log(JSON.stringify({ viewport: `${W}x${H}`, errors }, null, 2));
await browser.close();
