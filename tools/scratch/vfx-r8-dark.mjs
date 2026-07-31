/**
 * The fx layer makes the barrage frame DARKER by 5.3 L (paired, same build).
 * Law 8 says effects own the top of the value range, so that is backwards.
 * Which tier is doing it — matter, energy, decals or ribbons?
 *
 * Also reports the triangle cost of each tier, since the barrage scenario
 * measured 948k against a 900k budget and nobody has attributed that either.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/vfx-r8/dark', { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
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
  g.state.wave = 34; g.state.phase = 'combat';
  g.waves.start(35);
  await new Promise((r) => setTimeout(r, 4500));
  // REAL freeze. `Game.frame()` calls `fx.update(dt)` OUTSIDE the paused/speed
  // gate, so pausing the sim only stops new spawns while the existing particle
  // population keeps ageing out from under the ablation sequence. The first run
  // of this tool drained 149 -> 147 draw calls across seven captures and
  // reported 'no smoke' and 'no energy' as bit-identical, which is impossible.
  //
  // Stubbing fx.update() outright is NOT the fix: RibbonSystem.end() then never
  // runs, the draw range keeps pointing at slots whose vertices were never
  // written, and the frame goes BLACK (mean 0.9) with errors: [] -- PITFALLS §9
  // exactly. Drive it at dt = 0 instead, which re-pushes the identical geometry
  // every frame and advances nothing.
  g.state.paused = true;
  const step = g.fx.update.bind(g.fx);
  g.fx.update = () => step(0);
});

const stats = async (label, file) => {
  await p.waitForTimeout(450);
  const info = await p.evaluate(() => ({
    dc: window.__game.pipeline.renderer.info.render.calls,
    tri: window.__game.pipeline.renderer.info.render.triangles,
  }));
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/vfx-r8/dark/${file}`, buf);
  const v = await p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(380, 250, 1180, 700).data;
    let sum = 0, n = 0, hot = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      sum += l; n++; if (l > 235) hot++;
    }
    return { mean: +(sum / n).toFixed(1), hotPct: +(100 * hot / n).toFixed(2) };
  }, buf.toString('base64'));
  console.log(label.padEnd(28), JSON.stringify({ ...v, ...info }));
  return v;
};

const base = await stats('baseline (frozen)', '0-base.png');

const toggle = async (label, file, on, off) => {
  await p.evaluate(off);
  const v = await stats(label, file);
  await p.evaluate(on);
  console.log('    -> delta vs baseline:', (v.mean - base.mean).toFixed(1), 'L');
};

await toggle('no SMOKE (matter tier)', '1-nosmoke.png',
  () => { window.__game.fx.matter.points.visible = true; },
  () => { window.__game.fx.matter.points.visible = false; });

await toggle('no ENERGY particles', '2-noenergy.png',
  () => { window.__game.fx.energy.points.visible = true; },
  () => { window.__game.fx.energy.points.visible = false; });

await toggle('no MARK decals', '3-nomark.png',
  () => { window.__game.fx.decals.mark.mesh.visible = true; },
  () => { window.__game.fx.decals.mark.mesh.visible = false; });

await toggle('no GLOW decals', '4-noglow.png',
  () => { window.__game.fx.decals.glow.mesh.visible = true; },
  () => { window.__game.fx.decals.glow.mesh.visible = false; });

await toggle('no ribbons', '5-noribbon.png',
  () => { const f = window.__game.fx; f.arcs.mesh.visible = true; f.muzzleRibbons.mesh.visible = true; },
  () => { const f = window.__game.fx; f.arcs.mesh.visible = false; f.muzzleRibbons.mesh.visible = false; });

await toggle('no projectile bodies', '6-noproj.png',
  () => { const r = window.__game.projectiles?.renderer; if (r) r.group.visible = true; },
  () => { const r = window.__game.projectiles?.renderer; if (r) r.group.visible = false; });

await toggle('no TOWERS (control)', '7-notowers.png',
  () => { window.__game.towers.group.visible = true; },
  () => { window.__game.towers.group.visible = false; });

await b.close();
