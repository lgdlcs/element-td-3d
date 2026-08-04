/**
 * Probe: what is still moving after freezeFrame()?
 *
 * grid-preview.spec.js:364 fails on its own CONTROL — the same hover state read
 * twice comes back as two different pictures. This reproduces the test's exact
 * sequence and reports, at every step, the three things freezeFrame does not
 * touch: game.elapsed, the renderer's pixel ratio (AdaptiveResolution lives in
 * main.js's loop, not in Game.frame) and the drawing buffer size.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {}' }));
await page.goto('http://localhost:5273/');
await page.waitForFunction(() => window.__game, null, { timeout: 90000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.evaluate(() => {
  const g = window.__game;
  g.lobby?.hide?.();
  window.__lobby?.hide?.();
  g.state.phase = 'prep';
  g.state.gold = 5000;
  g.giveAll?.();
});
await page.waitForTimeout(2000);

const probe = () => page.evaluate(() => ({
  elapsed: +window.__game.elapsed.toFixed(3),
  dpr: window.__game.pipeline.renderer.getPixelRatio(),
  scale: window.__game.pipeline.adaptive?.scale,
  buf: [window.__game.pipeline.renderer.domElement.width, window.__game.pipeline.renderer.domElement.height],
  grain: window.__game.pipeline.passes.grade?.uniforms.uGrain.value,
}));

// freezeFrame, verbatim from tests/e2e/helpers.js
await page.evaluate(() => {
  const g = window.__game;
  g.state.paused = true;
  for (const k of ['rig', 'arena', 'environment', 'lighting', 'fx']) {
    if (g[k] && g[k].update) g[k].update = () => {};
  }
  const grade = g.pipeline?.passes?.grade;
  if (grade?.uniforms?.uGrain) grade.uniforms.uGrain.value = 0;
});

console.log('after freezeFrame ', JSON.stringify(await probe()));

// The test's own sequence: six states, each a screenshot, then the control.
const clip = { x: 700, y: 400, width: 48, height: 48 };
const shot = async () => (await page.screenshot({ clip, animations: 'disabled' })).toString('base64');
const shots = {};
for (const s of ['valid', 'occupied', 'creep', 'seal', 'stacks', 'poor']) {
  await page.evaluate((st) => {
    const g = window.__game;
    g.arena.gridMaterial.uniforms.uTime.value = 0;
    g.arena.setHover(10, 8, st);
  }, s);
  shots[s] = await shot();
  console.log(`after ${s.padEnd(9)}`, JSON.stringify(await probe()));
}

// twelve clipDistance evaluations happen here in the real test; emulate the wall time
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const g = window.__game;
  g.arena.gridMaterial.uniforms.uTime.value = 0;
  g.arena.setHover(10, 8, 'seal');
});
const sealTwice = await shot();
console.log('at the control  ', JSON.stringify(await probe()));

const dist = await page.evaluate(async ([a, b]) => {
  const load = async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    return cx.getImageData(0, 0, cv.width, cv.height).data;
  };
  const A = await load(a), B = await load(b);
  let sum = 0, n = 0;
  for (let i = 0; i < A.length; i += 4) {
    sum += (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3;
    n++;
  }
  return sum / n;
}, [shots.seal, sealTwice]);

console.log('\nseal vs seal (the control, bar is < 2):', dist.toFixed(3));

// Now the same control with the ONE thing freezeFrame misses also disabled.
await page.evaluate(() => { window.__game.pipeline.adaptive.enabled = false; });
const a = await shot();
await page.waitForTimeout(1500);
const b = await shot();
const dist2 = await page.evaluate(async ([x, y]) => {
  const load = async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    return cx.getImageData(0, 0, cv.width, cv.height).data;
  };
  const A = await load(x), B = await load(y);
  let sum = 0, n = 0;
  for (let i = 0; i < A.length; i += 4) {
    sum += (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3;
    n++;
  }
  return sum / n;
}, [a, b]);
console.log('with adaptive OFF, same state twice:', dist2.toFixed(3));
console.log('final          ', JSON.stringify(await probe()));

await browser.close();
