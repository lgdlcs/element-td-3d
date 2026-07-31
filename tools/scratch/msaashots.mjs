/**
 * Does MSAAScenePass change the IMAGE?
 *
 * The pass adds a fullscreen copy between the scene render and the post chain,
 * and the chain at that point is scene-referred linear HDR with a bloom
 * brightpass threshold of 2.05. A copy that clamped to [0,1] — the default for
 * an 8-bit target, or any shader doing encoding — would silently delete every
 * bloom highlight while still looking plausible in a thumbnail.
 *
 * So: capture the same frame through the new path and through the emulated old
 * path in ONE session, and diff them numerically. A mean absolute difference of
 * a few units is MSAA sample-position noise; a large difference in the bright
 * regions specifically means the HDR range was lost.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const OUT = process.argv[2] || '/private/tmp/claude-501/-Users-pouetpouets-code/c57263d9-aa43-4151-90a5-60492452382f/scratchpad';

const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=high', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  g.pipeline.adaptive.enabled = false;
  g.pipeline.renderer.setPixelRatio(1);
  g.pipeline.resize();
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let k = 0;
  for (let r = 4; r < 14 && k < 21; r += 3)
    for (let c = 4; c < 22 && k < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[k % 6], 0, c, r); k++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  // Freeze everything that moves so the two captures are the same frame:
  // no wave, no camera drift, fx pool held disarmed.
  g.camera.updateProjectionMatrix();
  const lp = g.fx.lights;
  setInterval(() => [...lp.items, ...lp.embers].forEach((i) => {
    i.light.visible = false; i.light.intensity = 0; i.t = i.dur;
  }), 16);
  await new Promise((r) => setTimeout(r, 8000));
});

// Pin the camera so drift cannot masquerade as a rendering difference.
await p.evaluate(() => {
  const g = window.__game;
  const c = g.camera;
  const pos = c.position.clone(), q = c.quaternion.clone();
  setInterval(() => { c.position.copy(pos); c.quaternion.copy(q); c.updateMatrixWorld(); }, 8);
});
await p.waitForTimeout(1200);

const newShot = await p.screenshot();
writeFileSync(`${OUT}/msaa-new.png`, newShot);

const ok = await p.evaluate(() => {
  const c = window.__game.pipeline.composer;
  const pass = c.passes[0];
  if (!pass.target) return false;
  for (const rt of [c.renderTarget1, c.renderTarget2]) { rt.samples = 4; rt.dispose(); }
  pass.render = function (renderer, writeBuffer, readBuffer) {
    const old = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = old;
  };
  return true;
});
if (!ok) { console.log('preset has msaa=0, nothing to compare'); await b.close(); process.exit(0); }
await p.waitForTimeout(1800);
const oldShot = await p.screenshot();
writeFileSync(`${OUT}/msaa-old.png`, oldShot);

// Numeric diff, overall and restricted to the bright regions where losing HDR
// range would show up first.
const stats = await p.evaluate(async ([a, c]) => {
  const load = (d) => new Promise((res) => {
    const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + d;
  });
  const [ia, ib] = await Promise.all([load(a), load(c)]);
  const cv = document.createElement('canvas');
  cv.width = ia.width; cv.height = ia.height;
  const g2 = cv.getContext('2d');
  g2.drawImage(ia, 0, 0);
  const A = g2.getImageData(0, 0, cv.width, cv.height).data;
  g2.clearRect(0, 0, cv.width, cv.height);
  g2.drawImage(ib, 0, 0);
  const B = g2.getImageData(0, 0, cv.width, cv.height).data;
  let sum = 0, n = 0, brightSum = 0, brightN = 0, maxd = 0;
  let lumA = 0, lumB = 0;
  for (let i = 0; i < A.length; i += 4) {
    const la = (A[i] * 0.2126 + A[i + 1] * 0.7152 + A[i + 2] * 0.0722);
    const lb = (B[i] * 0.2126 + B[i + 1] * 0.7152 + B[i + 2] * 0.0722);
    lumA += la; lumB += lb;
    const d = (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3;
    sum += d; n++;
    if (d > maxd) maxd = d;
    if (la > 200 || lb > 200) { brightSum += d; brightN++; }
  }
  return {
    meanAbsDiff: +(sum / n).toFixed(2),
    maxAbsDiff: maxd,
    brightMeanAbsDiff: brightN ? +(brightSum / brightN).toFixed(2) : null,
    brightPixels: brightN,
    meanLumNew: +(lumA / n).toFixed(2),
    meanLumOld: +(lumB / n).toFixed(2),
  };
}, [newShot.toString('base64'), oldShot.toString('base64')]);

console.log('new vs old (emulated), same frozen frame, 1280x720:');
console.log(`  mean |diff| per channel      ${stats.meanAbsDiff}   (MSAA sample-position noise lives here)`);
console.log(`  max  |diff| per channel      ${stats.maxAbsDiff}`);
console.log(`  mean |diff| in bright areas  ${stats.brightMeanAbsDiff}   over ${stats.brightPixels} px with luma > 200`);
console.log(`  mean luma  new ${stats.meanLumNew}  vs old ${stats.meanLumOld}   delta ${(stats.meanLumNew - stats.meanLumOld).toFixed(2)}`);
console.log(Math.abs(stats.meanLumNew - stats.meanLumOld) > 2
  ? '  VERDICT: overall brightness SHIFTED — the copy is altering colour, investigate.'
  : '  VERDICT: no brightness shift. HDR range preserved through the copy.');
console.log(`\nwrote ${OUT}/msaa-new.png and ${OUT}/msaa-old.png`);
await b.close();
