/**
 * `low` measures 31.5ms. The target is 16.7ms (vsync). What are the missing
 * ~15ms made of, with the FULL pipeline on — post included, nothing disabled
 * except the thing under test?
 *
 * Ablates cumulatively, cheapest-to-cut first, so the run doubles as a plan:
 * the first row that reads 16.7 is the set of cuts that reaches 60 fps.
 * Anything below that row is cost we do not need to pay.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const placed = await p.evaluate(async () => {
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
  return n;
});
if (placed < 21) { console.log(`ABORT: only ${placed} towers placed`); await b.close(); process.exit(1); }

const bench = () => p.evaluate(() => new Promise((res) => {
  let n = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++n < 140) requestAnimationFrame(tick);
    else { t.sort((a, c) => a - c); res(+t[70].toFixed(2)); }
  };
  requestAnimationFrame(tick);
}));

const row = async (label) => {
  await p.waitForTimeout(800);
  const ms = await bench();
  const hit = ms <= 17.4 ? '   <-- 60 FPS' : '';
  console.log(`${label.padEnd(38)} ${String(ms).padStart(6)}ms  ${String(Math.round(1000 / ms)).padStart(3)}fps${hit}`);
  return ms;
};

console.log('preset low, 21 towers, wave 21, full pipeline\n');
await row('baseline');

const CUTS = [
  ['post: everything but RenderPass', () => {
    window.__game.pipeline.composer.passes.forEach((x) => {
      if (x.constructor.name !== 'RenderPass') x.enabled = false;
    });
  }],
  ['+ shadow map', () => { window.__game.pipeline.renderer.shadowMap.enabled = false; }],
  ['+ environment (all off-board decor)', () => {
    const g = window.__game.environment; const grp = g?.group || g;
    if (grp) grp.visible = false;
  }],
  ['+ towers', () => {
    const g = window.__game.towers; const grp = g?.group || g;
    if (grp) grp.visible = false;
  }],
  ['+ arena', () => {
    const g = window.__game.arena; const grp = g?.group || g;
    if (grp) grp.visible = false;
  }],
];

for (const [label, fn] of CUTS) {
  await p.evaluate(fn);
  await row(label);
}

await b.close();
