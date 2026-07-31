/**
 * Round 7, defect 2: "no ambient occlusion / no contact anywhere", all three
 * critics, on a build where GTAO is ENABLED in the ultra preset.
 *
 * §10 says: before adding a second AO system, prove which stage is dropping it.
 * So: ablate the pass, and separately dump its raw AO buffer. Three outcomes,
 * three different fixes:
 *   - raw AO buffer is flat        -> the G-buffer or the radius is wrong
 *   - raw AO buffer is good but the composite barely moves
 *                                  -> the multiply is being eaten downstream
 *   - both fine                    -> the critics are describing the ground
 *                                     material's own AO, not the pass
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/r7', { recursive: true });
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
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
  await new Promise((r) => setTimeout(r, 2500));
});

const shot = async (name) => {
  await p.waitForTimeout(600);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/r7/${name}.png`, buf);
  return buf.toString('base64');
};

const diff = async (a, c) => p.evaluate(async ([a, c]) => {
  const load = async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    return cx.getImageData(0, 120, cv.width, cv.height - 300);
  };
  const A = (await load(a)).data, C = (await load(c)).data;
  let sum = 0, n = 0, worst = 0;
  for (let i = 0; i < A.length; i += 4) {
    const la = 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
    const lc = 0.2126 * C[i] + 0.7152 * C[i + 1] + 0.0722 * C[i + 2];
    const d = la - lc; sum += d; n++;
    if (Math.abs(d) > Math.abs(worst)) worst = d;
  }
  return { meanDelta: +(sum / n).toFixed(2), maxDelta: +worst.toFixed(1) };
}, [a, c]);

const withAO = await shot('ao-on');
await p.evaluate(() => { window.__game.pipeline.passes.gtao.enabled = false; });
const noAO = await shot('ao-off');
await p.evaluate(() => { window.__game.pipeline.passes.gtao.enabled = true; });

console.log('AO on vs off (positive = AO darkens):');
console.log(JSON.stringify(await diff(noAO, withAO)));

// Raw AO buffer.
await p.evaluate(() => {
  const g = window.__game.pipeline.passes.gtao;
  g.output = 1; // GTAOPass.OUTPUT.Diffuse is 1; Denoise/AO indices vary by ver.
});
await shot('ao-raw-1');
for (const o of [2, 3, 4]) {
  await p.evaluate((o) => { window.__game.pipeline.passes.gtao.output = o; }, o);
  await shot('ao-raw-' + o);
}
await p.evaluate(() => { window.__game.pipeline.passes.gtao.output = 0; });

// What the pass thinks its params are.
console.log(await p.evaluate(() => {
  const g = window.__game.pipeline.passes.gtao;
  return {
    enabled: g.enabled, blendIntensity: g.blendIntensity,
    output: g.output,
    gtaoUniforms: Object.fromEntries(Object.entries(g.gtaoMaterial?.uniforms ?? {})
      .map(([k, v]) => [k, typeof v.value === 'object' ? '<obj>' : v.value])),
  };
}));

await b.close();
