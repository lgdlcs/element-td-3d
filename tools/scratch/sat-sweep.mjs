/**
 * Sweep the grade's global chroma multiply and capture each value.
 *
 * Law 7 was hit on saturation (52.3%) with uSaturation = 2.95, and the frame
 * came out fluorescent — grass and road reading as coloured plastic. The
 * frame-mean number cannot see this, so this tool exists to produce IMAGES to
 * judge, with the numbers alongside rather than instead.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const VALUES = [1.35, 1.70, 2.05, 2.40, 2.95];
mkdirSync('shots/sat', { recursive: true });

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

// Confirm the uniform exists and we are driving the real thing.
const has = await p.evaluate(() => !!window.__game.pipeline.passes.grade?.uniforms?.uSaturation);
if (!has) { console.log('NO uSaturation uniform on grade pass — aborting'); await b.close(); process.exit(1); }

console.log('uSat   mean   p90  <64%  sat%');
for (const v of VALUES) {
  await p.evaluate((v) => { window.__game.pipeline.passes.grade.uniforms.uSaturation.value = v; }, v);
  await p.waitForTimeout(600);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/sat/sat-${v.toFixed(2)}.png`, buf);
  const s = await p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    const L = []; let sat = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], bl = px[i + 2];
      L.push(0.2126 * r + 0.7152 * g + 0.0722 * bl);
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      sat += mx === 0 ? 0 : (mx - mn) / mx;
    }
    L.sort((a, c) => a - c);
    return {
      mean: +(L.reduce((a, c) => a + c, 0) / L.length).toFixed(1),
      p90: L[Math.floor(0.9 * (L.length - 1))],
      dark: +(100 * L.filter((v) => v < 64).length / L.length).toFixed(1),
      sat: +(100 * sat / (px.length / 4)).toFixed(1),
    };
  }, buf.toString('base64'));
  console.log(String(v.toFixed(2)).padStart(4), String(s.mean).padStart(6),
    String(s.p90).padStart(5), String(s.dark).padStart(5), String(s.sat).padStart(5));
}
await b.close();
console.log('\nwrote shots/sat/sat-*.png — judge these by eye, not by the sat% column');
