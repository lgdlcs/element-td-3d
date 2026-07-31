/**
 * Is the blocked-terrain warning actually VISIBLE?
 *
 * foundations.mjs proved the logic (344 cells flagged, exit row among them, zero
 * flagged on a legal cell). That is a different claim from "the player sees it",
 * and the first attempt at this shot silently proved nothing: the probe searched
 * for a sealing anchor, found none on that board, and returned early — so the
 * screenshot showed a normal grid and would have been read as the wash failing.
 *
 * So: build a wall with exactly ONE gap left, assert the gap really is a sealing
 * placement before shooting, and measure the red in the frame rather than
 * eyeballing it.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const OUT = process.argv[2] || '/private/tmp/claude-501/-Users-pouetpouets-code/c57263d9-aa43-4151-90a5-60492452382f/scratchpad';

const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:5273/?q=high', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const setup = await p.evaluate(async () => {
  const g = window.__game;
  g.pipeline.adaptive.enabled = false;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0;
  g.state.phase = 'prep';
  g.state.prepTimer = 9999;
  g.state.gold = 9999999;
  g.hud.closeElementPicker?.();

  // Wall off row 8 completely except for one 2x2 gap on the right.
  const g4 = g.grid;
  const GAP = 22;
  let walls = 0;
  for (let c = 0; c < g4.cols - 1; c += 2) {
    if (c === GAP) continue;
    if (g4.canPlaceTower(c, 8) && !g.path.wouldBlock(c, 8)) { g.towers.create('foundation', 0, c, 8); walls++; }
  }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();

  // The gap must now be the ONLY route: placing there has to seal the board.
  const sealing = g4.canPlaceTower(GAP, 8) && g.path.wouldBlock(GAP, 8);
  if (!sealing) return { ok: false, walls, gap: GAP };

  // Frame the whole board so the cut-off region is entirely on screen.
  g.rig.dist = 96; g.rig._distGoal = 96;
  g.rig.polar = 0.42; g.rig._polarGoal = 0.42;

  g.setBuildSelection('fire');
  const flags = new Uint8Array(g4.cols * g4.rows);
  const n = g.path.sealPreview(GAP, 8, flags);
  g.arena.setSealPreview(flags);
  g.arena.setHover(GAP, 8, 'seal');
  g.arena.setGridVisible(true);
  g.hud.showPlacementHint('seal', { x: 1020, y: 300 });

  await new Promise((r) => setTimeout(r, 2600));
  return { ok: true, walls, gap: GAP, cutOff: n, hoverState: g.arena.gridMaterial.uniforms.uHoverState.value };
});

if (!setup.ok) {
  console.log(`ABORT: the gap at col ${setup.gap} is not a sealing placement (${setup.walls} walls). Nothing to shoot.`);
  await b.close();
  process.exit(1);
}
console.log(`wall of ${setup.walls} foundations, one gap at col ${setup.gap}`);
console.log(`sealPreview flags ${setup.cutOff} cells, uHoverState=${setup.hoverState} (2 = seal)`);

const shot = await p.screenshot({ path: `${OUT}/seal-live.png` });

// Count how much of the frame is dominated by the warning red. A wash that is
// present in the uniform but invisible on screen is the failure this catches.
const red = await p.evaluate(async (d) => {
  const img = await new Promise((res) => {
    const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + d;
  });
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0);
  const A = cx.getImageData(0, 0, cv.width, cv.height).data;
  let warn = 0, total = 0;
  for (let i = 0; i < A.length; i += 4) {
    total++;
    const r = A[i], gg = A[i + 1], bb = A[i + 2];
    // Strongly red-dominant pixels: the wash and the X, not the warm terrain.
    if (r > 90 && r > gg * 1.75 && r > bb * 1.75) warn++;
  }
  return { pct: +((warn / total) * 100).toFixed(2), warn, total };
}, shot.toString('base64'));

console.log(`red-dominant pixels: ${red.pct}% of the frame (${red.warn} px)`);
console.log(red.pct > 1.5
  ? 'PASS: the warning is unmistakably on screen.'
  : `FAIL: only ${red.pct}% — the wash is not reaching the frame.`);

// Control: clear the preview and re-measure. If the "warning red" is really the
// warning, it has to LEAVE when the warning does — otherwise the number above is
// just counting red creeps and warm stonework.
await p.evaluate(() => {
  const g = window.__game;
  g.arena.setSealPreview(null);
  g.arena.setHover(-99, -99, 'none');
  g.hud.showPlacementHint(null);
});
await p.waitForTimeout(1400);
const shot2 = await p.screenshot({ path: `${OUT}/seal-cleared.png` });
const red2 = await p.evaluate(async (d) => {
  const img = await new Promise((res) => {
    const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + d;
  });
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0);
  const A = cx.getImageData(0, 0, cv.width, cv.height).data;
  let warn = 0, total = 0;
  for (let i = 0; i < A.length; i += 4) {
    total++;
    const r = A[i], gg = A[i + 1], bb = A[i + 2];
    if (r > 90 && r > gg * 1.75 && r > bb * 1.75) warn++;
  }
  return +((warn / total) * 100).toFixed(2);
}, shot2.toString('base64'));

console.log(`\ncontrol, preview cleared: ${red2}%   delta ${(red.pct - red2).toFixed(2)} points`);
console.log(red.pct - red2 > 1.0
  ? 'PASS: the red belongs to the warning — it leaves when the warning does.'
  : 'FAIL: the red is background, not the warning. The number above proves nothing.');

console.log(errs.length ? `\nERRORS: ${errs.join('\n')}` : '\nno page errors');
console.log(`\nwrote seal-live.png and seal-cleared.png to ${OUT}`);
await b.close();
