/**
 * The off-board coloured row: is it screen-space, not geometry?
 *
 * Every ablation so far has hidden WORLD objects, and the row died only when
 * the tower batch (the scene's brightest emissives) was hidden. That is the
 * signature of a screen-space pass smearing bright sources, not of geometry
 * sitting off-board. `ultra` enables BOTH godrays and motionBlur; the
 * GodRaysPass docblock wrongly claims godrays are off by default, which is
 * presumably why the pass was never ablated.
 *
 * Toggles each post pass individually with the towers left in place.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const ROI = { x: 0, y: 260, width: 470, height: 520 };   // the offending band

mkdirSync('shots/ss', { recursive: true });

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
  for (let r = 4; r < 14 && n < 18; r += 3)
    for (let c = 4; c < 22 && n < 18; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  await new Promise((r) => setTimeout(r, 4000));
});

// What passes actually exist and are enabled?
console.log('passes:', JSON.stringify(await p.evaluate(() => {
  const ps = window.__game.pipeline.passes;
  return Object.fromEntries(Object.entries(ps).map(([k, v]) => [k, v?.enabled]));
}), null, 2));

/** Mean colour energy in the ROI, measured in-page (no image lib here). */
const measure = async (label, file) => {
  await p.waitForTimeout(700);
  const buf = await p.screenshot({ type: 'png', clip: ROI, timeout: 120000 });
  writeFileSync(`shots/ss/${file}`, buf);
  const v = await p.evaluate(async (d) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + d;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    // "Chromatic" = a pixel whose max-min channel spread is wide. The blobs are
    // element-coloured; the surround is near-neutral green-grey. Spread finds
    // them without assuming a hue.
    let chroma = 0, sum = 0, n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], bl = px[i + 2];
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      sum += mx - mn;
      if (mx - mn > 42 && mx > 60) chroma++;
    }
    return { chromaPx: chroma, meanSpread: +(sum / n).toFixed(2) };
  }, buf.toString('base64'));
  console.log(label.padEnd(24), JSON.stringify(v));
  return v;
};

const base = await measure('baseline (all on)', 'a-baseline.png');

const toggle = async (name, file) => {
  const ok = await p.evaluate((n) => {
    const pass = window.__game.pipeline.passes[n];
    if (!pass) return false;
    pass.enabled = false;
    return true;
  }, name);
  if (!ok) { console.log(`no pass "${name}"`); return; }
  const v = await measure(`without ${name}`, file);
  await p.evaluate((n) => { window.__game.pipeline.passes[n].enabled = true; }, name);
  const d = (100 * (v.chromaPx - base.chromaPx) / Math.max(1, base.chromaPx)).toFixed(0);
  console.log(`   -> chroma ${d}%`);
};

await toggle('godrays', 'b-no-godrays.png');
await toggle('bloom', 'c-no-bloom.png');
await toggle('motionBlur', 'd-no-motionblur.png');
await toggle('dof', 'e-no-dof.png');
await toggle('grade', 'f-no-grade.png');

// Control: the ablation that has always worked, for comparison.
await p.evaluate(() => { window.__game.towers.group.visible = false; });
await measure('towers hidden (ctrl)', 'g-no-towers.png');

await b.close();
