/** Visual smoke test: picker echo card, dock rail, and six primals on the board. */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 5291;
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite timeout')), 25000);
  vite.stdout.on('data', (d) => { if (String(d).includes('ready in')) { clearTimeout(t); res(); } });
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(`http://localhost:${PORT}/?solo=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.hud, null, { timeout: 20000 });

// Picker with two fire already held: the middle card should be the echo.
await page.evaluate(() => {
  const g = window.__game;
  g.state.elements = ['fire', 'fire'];
  g.state.pickIndex = 2;
  g.state.pendingElementPicks = 1;
  g.hud.openElementPicker();
});
await page.waitForTimeout(700);
await page.screenshot({ path: 'tools/scratch/out-primal-picker.png' });
console.log('picker cards:', await page.evaluate(() =>
  [...document.querySelectorAll('.pcard')].map((c) => `${c.dataset.id}${c.className.replace('pcard', '')}`)));

// Board: one of each primal, so all six geometries render at once.
await page.evaluate(async () => {
  const g = window.__game;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  g.state.gold = 999999;
  g.state.elements = [];
  for (const el of ['fire', 'water', 'nature', 'earth', 'light', 'dark']) {
    for (let k = 0; k < 3; k++) g.state.elements.push(el);
  }
  const want = ['primal_fire', 'primal_water', 'primal_nature', 'primal_earth', 'primal_light', 'primal_dark'];
  let n = 0;
  for (let c = 4; c < g.grid.cols - 4 && n < want.length; c += 3) {
    for (let rr = 4; rr < g.grid.rows - 4 && n < want.length; rr += 3) {
      g.selectedBuild = want[n];
      if (g.placementReason(c, rr) !== 'valid') continue;
      if (g.build(want[n], c, rr)) { n++; for (const el of ['fire','water','nature','earth','light','dark']) { while (g.elementCount(el) < 3) g.state.elements.push(el); } }
    }
  }
  g.selectedBuild = null;
  g.hud.refreshBuildBar();
  g.rig.dist = 46;
});
await page.waitForTimeout(2200);
await page.screenshot({ path: 'tools/scratch/out-primal-board.png' });
console.log('towers:', await page.evaluate(() => window.__game.towers.towers.map((t) => t.key).join(', ')));
console.log('dock primal rail:', await page.evaluate(() => document.querySelector('#dock-primal').textContent.trim()));

await browser.close();
vite.kill('SIGTERM');
