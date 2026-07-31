/**
 * Is the board floor the brightest thing in frame?
 *
 * A round-6 critic's top defect: "the floor is blown out and it is the
 * brightest thing in frame; the near-white slab pulls the eye to empty pavement
 * instead of to the towers." That is a claim about a value HIERARCHY, which is
 * measurable — so measure it rather than argue about it.
 *
 * Method: sample the rendered frame, then ablate to attribute. Board pixels are
 * isolated by hiding towers/creeps/fx and diffing against the full frame.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/vh', { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 8000));
});

/** Luminance percentiles over a screenshot, plus the top-1% mean (the "brightest thing"). */
const grab = async (label, file) => {
  await p.waitForTimeout(700);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/vh/${file}`, buf);
  const v = await p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    // Crop out the HUD strips so they cannot skew the hierarchy.
    const px = cx.getImageData(0, 120, cv.width, cv.height - 300).data;
    const L = [];
    for (let i = 0; i < px.length; i += 4)
      L.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
    L.sort((a, c) => a - c);
    const top1 = L.slice(Math.floor(0.99 * L.length));
    return {
      mean: +(L.reduce((a, c) => a + c, 0) / L.length).toFixed(1),
      p50: L[Math.floor(0.5 * L.length)],
      p99: L[Math.floor(0.99 * L.length)],
      top1mean: +(top1.reduce((a, c) => a + c, 0) / top1.length).toFixed(1),
    };
  }, buf.toString('base64'));
  console.log(label.padEnd(30), JSON.stringify(v));
  return v;
};

const full = await grab('full frame', 'a-full.png');

// Board alone: hide everything that sits on it.
await p.evaluate(() => {
  const g = window.__game;
  g.towers.group.visible = false;
  g.creeps.group.visible = false;
  g.fx.group.visible = false;
});
const board = await grab('board only (no towers/fx)', 'b-board.png');

await p.evaluate(() => {
  const g = window.__game;
  g.towers.group.visible = true;
  g.creeps.group.visible = true;
  g.fx.group.visible = true;
});

console.log('\n--- verdict ---');
console.log('board-only top1% mean :', board.top1mean);
console.log('full-frame top1% mean :', full.top1mean);
console.log(board.top1mean >= full.top1mean - 4
  ? 'CRITIC IS RIGHT: the floor is at or above the brightest content in frame.'
  : 'Critic overstated: towers/VFX out-peak the floor by ' +
    (full.top1mean - board.top1mean).toFixed(1) + ' L.');
console.log('board median:', board.p50, ' full median:', full.p50);
await b.close();
