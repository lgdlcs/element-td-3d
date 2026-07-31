/**
 * Which fx tier darkens the barrage frame?
 *
 * Freezing this scene is not safe: `Game.frame()` calls `fx.update(dt)` outside
 * the pause gate, so pausing drains the particle population under the ablation
 * sequence; stubbing `fx.update` leaves RibbonSystem's draw range pointing at
 * unwritten vertices and blanks the frame; and driving it at dt = 0 still
 * produced intermittent black captures. So: ONE FRESH PAGE PER CONDITION, the
 * ablation installed before the wave starts, the same seeded RNG, captured at
 * the same sim time. Slower, but every condition is a real evolving frame.
 *
 *   node tools/scratch/vfx-r8-tier.mjs [tag]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const TAG = process.argv[2] ?? 'x';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/vfx-r8/tier', { recursive: true });

const CONDITIONS = [
  ['full', 'none'],
  ['no-matter', 'matter'],
  ['no-energy', 'energy'],
  ['no-decals', 'decals'],
  ['no-ribbons', 'ribbons'],
  ['no-fx', 'all'],
];

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const out = [];

for (const [label, ablate] of CONDITIONS) {
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

  await p.evaluate(async (ablate) => {
    const g = window.__game;
    let seed = 1337;
    Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    g.state.pendingElementPicks = 0; g.state.gold = 999999;
    g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
    const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark',
                  'steam', 'magma', 'ice', 'poison', 'void', 'magic',
                  'blaze', 'crystal', 'life', 'mud', 'abyss', 'gaia'];
    let n = 0;
    for (let r = 3; r <= 17 && n < 34; r += 2)
      for (let c = 6; c <= 18 && n < 34; c += 2) { g.build(keys[n % keys.length], c, r); n++; }
    for (const t of g.towers.towers) { g.state.gold = 999999; g.towers.upgrade(t.id); }

    const f = g.fx;
    if (ablate === 'matter' || ablate === 'all') f.matter.points.visible = false;
    if (ablate === 'energy' || ablate === 'all') f.energy.points.visible = false;
    if (ablate === 'decals' || ablate === 'all') { f.decals.glow.mesh.visible = false; f.decals.mark.mesh.visible = false; }
    if (ablate === 'ribbons' || ablate === 'all') { f.arcs.mesh.visible = false; f.muzzleRibbons.mesh.visible = false; }
    if (ablate === 'all') { for (const it of [...f.lights.items, ...f.lights.embers]) { it.peak = 0; it.light.intensity = 0; } }

    g.state.wave = 34; g.state.phase = 'combat';
    g.waves.start(35);
    await new Promise((r) => setTimeout(r, 4500));
  }, ablate);

  await p.waitForTimeout(400);
  const info = await p.evaluate(() => ({
    dc: window.__game.pipeline.renderer.info.render.calls,
    tri: window.__game.pipeline.renderer.info.render.triangles,
    live: window.__game.fx.liveCount,
  }));
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/vfx-r8/tier/${TAG}-${label}.png`, buf);
  const v = await p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(380, 250, 1180, 700).data;
    let sum = 0, n = 0, hot = 0, dark = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      sum += l; n++; if (l > 235) hot++; if (l < 64) dark++;
    }
    return { mean: +(sum / n).toFixed(1), hotPct: +(100 * hot / n).toFixed(2), darkPct: +(100 * dark / n).toFixed(2) };
  }, buf.toString('base64'));
  if (v.mean < 20) console.log('!! BLACK FRAME, discard:', label);
  out.push([label, { ...v, ...info }]);
  console.log(label.padEnd(12), JSON.stringify({ ...v, ...info }));
  await p.close();
}

const base = out[0][1];
console.log('\n--- board-crop mean, delta vs full ---');
for (const [l, v] of out.slice(1)) {
  console.log(l.padEnd(12), (v.mean - base.mean > 0 ? '+' : '') + (v.mean - base.mean).toFixed(1),
    'L   tri', v.tri - base.tri);
}
await b.close();
