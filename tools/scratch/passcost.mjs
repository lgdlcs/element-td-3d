/**
 * What does each post pass cost, in milliseconds, on this content?
 *
 * The whole optimisation pass hangs off this table. Everything measured so far
 * says the frame is fragment-bound with a large resolution-independent floor,
 * and the composer is the only remaining suspect - but "the only remaining
 * suspect" is exactly the reasoning that misattributed the off-board colour
 * artifact four times in this project (PITFALLS §10). So attribute it properly:
 * disable one pass at a time and measure, then disable all of them and measure.
 *
 * Uses `pass.enabled = false`, which EffectComposer honours by skipping the
 * pass entirely - it does not merely neutralise the effect.
 *
 * Runs at ultra (the full stack) so every pass is present to be measured, and
 * at the real 1600x900 so the fragment cost is representative.
 */
import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

// Loaded board: 21 towers + a live wave, the scenario every visual round uses.
await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire','water','nature','earth','light','dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire','water','nature','earth','light','dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(21);
  await new Promise(r => setTimeout(r, 8000));
});

console.log('passes in the composer:',
  await p.evaluate(() => window.__game.pipeline.composer.passes.map(x => x.constructor.name).join(' -> ')));
console.log('');

const bench = () => p.evaluate(() => new Promise(res => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => { const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a,c)=>a-c); res(+t[70].toFixed(2)); } };
  requestAnimationFrame(tick);
}));

const setOnly = (names, on) => p.evaluate(([ns, v]) => {
  window.__game.pipeline.composer.passes.forEach(x => {
    if (ns.includes(x.constructor.name)) x.enabled = v;
  });
}, [names, on]);

const allNames = await p.evaluate(() =>
  window.__game.pipeline.composer.passes.map(x => x.constructor.name));

await p.waitForTimeout(900);
const base = await bench();
console.log(`baseline (all passes)          ${String(base).padStart(6)}ms  ${(1000/base).toFixed(0).padStart(3)}fps`);

// One at a time. RenderPass is not optional - skipping it draws nothing.
for (const name of allNames) {
  if (name === 'RenderPass') continue;
  await setOnly([name], false);
  await p.waitForTimeout(700);
  const ms = await bench();
  const saved = base - ms;
  console.log(`  - ${name.padEnd(28)} ${String(ms).padStart(6)}ms   saves ${saved >= 0 ? '+' : ''}${saved.toFixed(1)}ms`);
  await setOnly([name], true);
  await p.waitForTimeout(400);
}

// Everything off: the floor the scene alone imposes.
await setOnly(allNames.filter(n => n !== 'RenderPass'), false);
await p.waitForTimeout(900);
const bare = await bench();
console.log(`\nscene only, zero post          ${String(bare).padStart(6)}ms  ${(1000/bare).toFixed(0).padStart(3)}fps   (post costs ${(base-bare).toFixed(1)}ms total)`);
await b.close();
