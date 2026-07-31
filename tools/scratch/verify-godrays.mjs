/**
 * Two things at once:
 *   1. shipping config (godrays off) — is the off-board row actually gone?
 *   2. pass force-enabled — does the guarded shader still COMPILE, and does the
 *      source-radius mask suppress the tower smear?
 *
 * (2) matters because a shader that fails to compile renders nothing and throws
 * nothing (PITFALLS §9), so "no errors" is not evidence the guard is sound.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const ROI = { x: 0, y: 260, width: 470, height: 520 };
mkdirSync('shots/ss', { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
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

console.log('godrays enabled in shipping config:',
  await p.evaluate(() => window.__game.pipeline.passes.godrays.enabled));

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
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    let chroma = 0, lum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], bl = px[i + 2];
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      if (mx - mn > 42 && mx > 60) chroma++;
    }
    return { chromaPx: chroma, meanLum: +(lum / (px.length / 4)).toFixed(1) };
  }, buf.toString('base64'));
  console.log(label.padEnd(30), JSON.stringify(v));
  return v;
};

const ship = await measure('SHIPPING (godrays off)', 'h-shipping.png');

// Force the pass on to exercise the guarded shader.
await p.evaluate(() => { window.__game.pipeline.setGodRays(true); });
const forced = await measure('forced on (guard active)', 'i-forced-guarded.png');

// Prove the guard is what is suppressing it, not a dead pass: widening the disc
// to cover the frame should bring the smear back.
await p.evaluate(() => {
  window.__game.pipeline.passes.godrays.uniforms.uSourceRadius.value = 3.0;
});
const wide = await measure('forced on, radius 3.0', 'j-forced-wide.png');

// Full frame for eyeballing the shipping state.
await p.evaluate(() => { window.__game.pipeline.setGodRays(false); });
await p.waitForTimeout(800);
writeFileSync('shots/ss/k-shipping-full.png', await p.screenshot({ type: 'png', timeout: 120000 }));

console.log('\nguard suppression: radius0.34 vs radius3.0 chroma =',
  forced.chromaPx, 'vs', wide.chromaPx);
console.log('errors:', errs.length ? errs.slice(0, 8) : 'none');
await b.close();
