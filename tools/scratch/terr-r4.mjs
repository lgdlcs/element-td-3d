/**
 * Terrain r4 probe. Boots the midgame scenario, then applies an arbitrary
 * expression against window.__game before capturing. Also reports mean Lab of
 * a rect so ablations can be measured, not argued about.
 *
 *   node tools/scratch/terr-r4.mjs --out shots/x.png --js "g.arena.uniforms.uDebug.value=1"
 *   node tools/scratch/terr-r4.mjs --out shots/x.png --crop 700,400,600,400
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('out', 'shots/terr-r4.png');
const JS = arg('js', '');
const CROP = arg('crop', '');
const SCEN = arg('scenario', 'midgame');
const CAM = arg('cam', '');

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await page.evaluate(async ({ scen }) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let n = 0; n < 200 && document.getElementById('boot'); n++) await wait(150);
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [
    ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
    ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
    ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
    ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
    ['dark', 14, 15],
  ];
  if (scen !== 'empty') for (const [k, c, r] of MAZE) g.build(k, c, r);
  g.state.wave = 21; g.state.gold = 4820; g.state.lives = 43; g.state.score = 128400;
  if (scen === 'midgame') { g.state.phase = 'combat'; g.waves.start(22); await wait(3600); }
  await wait(700);
}, { scen: SCEN });

if (CAM) {
  const [x, z, d, p] = CAM.split(',').map(Number);
  await page.evaluate(([x, z, d, p]) => {
    window.__game.rig.focus(x, z, d);
    if (p) window.__game.rig._polarGoal = p;
  }, [x, z, d, p]);
  await page.waitForTimeout(1400);
}
if (JS) { await page.evaluate((src) => { const g = window.__game; eval(src); }, JS); }
await page.waitForTimeout(900);

const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(OUT, buf);

const stats = await page.evaluate(() => {
  const i = window.__game.pipeline.renderer.info;
  return { drawCalls: i.render.calls, triangles: i.render.triangles };
});
await browser.close();
console.log(JSON.stringify({ OUT, stats, errors: logs.filter((l) => /error/i.test(l)) }, null, 2));
