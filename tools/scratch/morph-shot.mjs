/**
 * Screenshot the morph sheet at its worst case: a level-3 pure with all six
 * elements bound, i.e. all twenty targets rendered at once.
 *
 *   node tools/scratch/morph-shot.mjs        (from the repo root)
 *
 * The panel is 296px wide, anchored to the top of the viewport, and has no
 * height of its own — ten rows of cards is exactly the case that would run it
 * off the bottom of the screen, so this exists to prove the sheet scrolls
 * instead. Writes tools/scratch/out/morph-*.png.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 5292;
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

mkdirSync('tools/scratch/out', { recursive: true });

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite did not start')), 25000);
  vite.stdout.on('data', (d) => { if (String(d).includes('ready in') || String(d).includes('Local:')) { clearTimeout(t); res(); } });
});
await new Promise((r) => setTimeout(r, 900));

// One browser per viewport, deliberately: a second page in the same swiftshader
// process takes long enough to get a WebGL context that the boot wait times out.
for (const [w, h] of [[1600, 950], [1280, 720]]) {
  const browser = await chromium.launch({ args: ARGS });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`http://localhost:${PORT}/?solo=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game?.hud, null, { timeout: 20000 });

  const box = await page.evaluate(() => {
    const g = window.__game;
    g.state.pendingElementPicks = 20;
    for (const e of ['fire', 'water', 'nature', 'earth', 'light', 'dark']) g.chooseElement(e);
    g.state.pendingElementPicks = 0;
    g.hud.closeElementPicker();     // the loop above leaves it open on pick 7
    g.state.phase = 'prep';
    g.state.gold = 1200;   // deliberately mid-range so both poor and payable cards show

    for (let c = 2; c < g.grid.cols - 3; c += 2) {
      for (let r = 2; r < g.grid.rows - 3; r += 2) {
        if (g.placementReason(c, r) === 'valid') {
          const t = g.towers.create('fire', 2, c, r);
          g.selectTower(t.id);
          g.hud.inspector.showMorph(t);
          const el = document.querySelector('#inspector');
          const b = el.getBoundingClientRect();
          const sheet = document.querySelector('.morph-sheet');
          return {
            bottom: Math.round(b.bottom), vh: window.innerHeight,
            cards: document.querySelectorAll('[data-morph]').length,
            scrolls: sheet.scrollHeight > sheet.clientHeight + 1,
          };
        }
      }
    }
    return null;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `tools/scratch/out/morph-${w}x${h}.png` });
  console.log(`${w}x${h}`, JSON.stringify(box), '-> panel bottom', box.bottom, 'of', box.vh,
    box.bottom <= box.vh ? 'INSIDE' : 'OVERFLOWS');

  // Now drive one morph through the real click path and let the sim run, so the
  // shot also proves the new tower actually attached to the BatchedMesh rather
  // than leaving a hole where the old one was.
  await page.click('[data-morph="blacksmith"]');
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => {
    const g = window.__game;
    const t = g.towers.byId(g.selectedTower);
    return { key: t?.key, level: t?.level, morphCount: t?.morphCount, gold: Math.floor(g.state.gold) };
  });
  console.log(`  after click:`, JSON.stringify(after));
  await page.screenshot({ path: `tools/scratch/out/morph-after-${w}x${h}.png` });
  await browser.close();
}
vite.kill('SIGTERM');
