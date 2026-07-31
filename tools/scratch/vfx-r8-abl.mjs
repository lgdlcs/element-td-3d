/**
 * VFX round 8 — attribute the blown-out green/blue puddles.
 *
 * PITFALLS §10: hiding an object proves it is the SOURCE, not the bug. So we
 * ablate each sub-system of the fx layer independently, including the point
 * lights (which live on the scene, NOT inside fx.group, and are therefore
 * invisible to every `fx.group.visible = false` ablation ever run here).
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/vfx-r8/abl', { recursive: true });

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
  g.state.speed = 0; if (g.setSpeed) g.setSpeed(0);   // freeze: paired ablation
});

const stats = async (label, file) => {
  await p.waitForTimeout(500);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/vfx-r8/abl/${file}`, buf);
  const v = await p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    // Board region only, HUD excluded.
    const px = cx.getImageData(380, 250, 1180, 700).data;
    let clipped = 0, n = 0, sum = 0, greenBlow = 0;
    const L = [];
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], bl = px[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      L.push(l); sum += l; n++;
      // "clipped to pure white": all three channels near ceiling
      if (r > 246 && g > 246 && bl > 246) clipped++;
      if (g > 235 && l > 200) greenBlow++;
    }
    L.sort((a, c) => a - c);
    return {
      mean: +(sum / n).toFixed(1),
      p99: +L[Math.floor(0.99 * n)].toFixed(0),
      clippedPct: +(100 * clipped / n).toFixed(3),
      hotPct: +(100 * greenBlow / n).toFixed(3),
    };
  }, buf.toString('base64'));
  console.log(label.padEnd(34), JSON.stringify(v));
  return v;
};

await stats('baseline', '0-base.png');

// --- ablate the fx POINT LIGHTS only (they are not in fx.group) -------------
await p.evaluate(() => {
  const L = window.__game.fx.lights;
  window.__abl = { on: false };
  for (const it of [...L.items, ...L.embers]) { it.__peak = it.peak; it.peak = 0; it.light.intensity = 0; }
});
await stats('no fx point lights', '1-nolights.png');
await p.evaluate(() => {
  const L = window.__game.fx.lights;
  for (const it of [...L.items, ...L.embers]) it.peak = it.__peak ?? 0;
});

// --- ablate the additive GLOW DECALS ---------------------------------------
await p.evaluate(() => { window.__game.fx.decals.glow.mesh.visible = false; });
await stats('no glow decals', '2-noglowdecal.png');
await p.evaluate(() => { window.__game.fx.decals.glow.mesh.visible = true; });

// --- ablate the additive PARTICLES -----------------------------------------
await p.evaluate(() => { window.__game.fx.energy.points.visible = false; });
await stats('no energy particles', '3-nopoints.png');
await p.evaluate(() => { window.__game.fx.energy.points.visible = true; });

// --- ablate the RIBBONS ----------------------------------------------------
await p.evaluate(() => {
  const f = window.__game.fx;
  f.arcs.mesh.visible = false; f.muzzleRibbons.mesh.visible = false;
});
await stats('no ribbons', '4-noribbons.png');
await p.evaluate(() => {
  const f = window.__game.fx;
  f.arcs.mesh.visible = true; f.muzzleRibbons.mesh.visible = true;
});

// --- everything the fx layer owns ------------------------------------------
await p.evaluate(() => {
  const f = window.__game.fx;
  f.group.visible = false;
  f.decals.glow.mesh.visible = false; f.decals.mark.mesh.visible = false;
  f.arcs.mesh.visible = false; f.muzzleRibbons.mesh.visible = false;
  for (const it of [...f.lights.items, ...f.lights.embers]) { it.peak = 0; it.light.intensity = 0; }
  if (window.__game.projectiles?.renderer) window.__game.projectiles.renderer.group.visible = false;
});
await stats('fx layer entirely off', '5-nofx.png');

await b.close();
