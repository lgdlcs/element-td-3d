/**
 * Who owns the blown-out green puddles?
 *
 * The round-7 critics and the towers agent both attributed them to the VFX
 * layer. `vfx-r8-abl.mjs` turned the ENTIRE fx layer off (points, decals,
 * ribbons, projectiles, and the point lights that live outside fx.group) and
 * the puddles did not move. PITFALLS §10 says: check what else is in the chain.
 * So this ablates the towers and every post pass as well.
 *
 * Live frame, not frozen, so nothing transient is missing.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/vfx-r8/attrib', { recursive: true });

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
  const MAZE = [
    ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
    ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
    ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
    ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
    ['dark', 14, 15],
  ];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  g.state.wave = 21; g.state.phase = 'combat';
  g.waves.start(22);
  await new Promise((r) => setTimeout(r, 3600));
});

const PASSES = await p.evaluate(() =>
  Object.entries(window.__game.pipeline.passes).map(([k, x]) => k + (x.enabled === false ? '(off)' : '')));
console.log('pipeline passes:', PASSES);

// The two green puddles, measured directly. Windows picked off the capture.
const GREEN = [[905, 355, 130, 100], [925, 600, 130, 110]];

const stats = async (label, file) => {
  await p.waitForTimeout(600);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/vfx-r8/attrib/${file}`, buf);
  const v = await p.evaluate(async ([d, wins]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const out = [];
    for (const [x, y, w, h] of wins) {
      const px = cx.getImageData(x, y, w, h).data;
      let sum = 0, n = 0, blown = 0, maxL = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        sum += l; n++; if (l > maxL) maxL = l;
        if (px[i] > 200 && px[i + 1] > 245 && px[i + 2] > 190) blown++;
      }
      out.push({ mean: +(sum / n).toFixed(1), max: +maxL.toFixed(0), blownPct: +(100 * blown / n).toFixed(1) });
    }
    return out;
  }, [buf.toString('base64'), GREEN]);
  console.log(label.padEnd(30), JSON.stringify(v));
};

await stats('baseline (live)', '0-base.png');

await p.evaluate(() => {
  const f = window.__game.fx;
  f.group.visible = false;
  f.decals.glow.mesh.visible = false; f.decals.mark.mesh.visible = false;
  f.arcs.mesh.visible = false; f.muzzleRibbons.mesh.visible = false;
  for (const it of [...f.lights.items, ...f.lights.embers]) { it.peak = 0; it.light.intensity = 0; }
  window.__game.fx.muzzleFlash = () => {};
  window.__game.fx.impactCore = () => {};
});
await stats('ALL fx off', '1-nofx.png');

await p.evaluate(() => { window.__game.towers.group.visible = false; });
await stats('ALL fx off + towers off', '2-nofx-notowers.png');
await p.evaluate(() => { window.__game.towers.group.visible = true; });

// Post passes, one at a time, with fx still off.
for (const key of Object.keys(await p.evaluate(() => window.__game.pipeline.passes))) {
  if (key === 'render' || key === 'output') continue;
  await p.evaluate((k) => {
    const ps = window.__game.pipeline.passes;
    for (const n of Object.keys(ps)) { if (ps[n].__was === undefined) ps[n].__was = ps[n].enabled; ps[n].enabled = ps[n].__was; }
    ps[k].enabled = false;
  }, key);
  await stats(`fx off + no ${key}`, `3-nopass-${key}.png`);
}
await p.evaluate(() => { const ps = window.__game.pipeline.passes; for (const n of Object.keys(ps)) ps[n].enabled = ps[n].__was; });

await b.close();
