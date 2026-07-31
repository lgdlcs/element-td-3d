/**
 * The GTAO AO buffer came back essentially WHITE (shots/r7/ao-raw-4.png):
 * hairline outlines at silhouette edges and nothing at any tower base. The pass
 * is enabled and firing; it is producing no occlusion.
 *
 * Sweep its parameters against the RAW AO buffer, with the downstream passes
 * (godrays / bloom / dof / grade) disabled so nothing washes the reading.
 * Lower mean = more occlusion. A parameter that does not move this number
 * cannot be the fix, whatever it looks like in the composite.
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
  // Raw AO buffer, nothing downstream.
  const ps = g.pipeline.passes;
  for (const k of ['godrays', 'bloom', 'dof', 'grade']) if (ps[k]) ps[k].enabled = false;
  ps.gtao.output = 4;                      // GTAOPass.OUTPUT.AO
  await new Promise((r) => setTimeout(r, 2500));
});

const aoStats = async (file) => {
  await p.waitForTimeout(450);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  if (file) writeFileSync(`shots/r7/${file}`, buf);
  return p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    // The board region, clear of both HUD panels.
    const px = cx.getImageData(Math.round(cv.width * 0.30), Math.round(cv.height * 0.20),
                               Math.round(cv.width * 0.55), Math.round(cv.height * 0.55)).data;
    let s = 0, n = 0, occl = 0;
    for (let i = 0; i < px.length; i += 4) {
      const v = px[i]; s += v; n++;
      if (v < 216) occl++;                 // pixel carries real occlusion
    }
    return { meanAO: +(s / n).toFixed(1), pctOccluded: +(100 * occl / n).toFixed(1) };
  }, buf.toString('base64'));
};

const set = (o) => p.evaluate((o) => {
  window.__game.pipeline.passes.gtao.updateGtaoMaterial(o);
}, o);

const BASE = { radius: 1.15, distanceExponent: 1.6, thickness: 0.6, scale: 1.3,
               samples: 12, distanceFallOff: 0.9, screenSpaceRadius: false };

await set(BASE);
console.log('baseline'.padEnd(46), JSON.stringify(await aoStats('ao-sweep-base.png')));

const trials = [
  { thickness: 1.5 }, { thickness: 3.0 }, { thickness: 8.0 },
  { radius: 2.0 }, { radius: 3.0 }, { radius: 4.5 },
  { distanceExponent: 1.0 }, { distanceExponent: 0.6 },
  { scale: 2.0 }, { scale: 3.0 },
  { distanceFallOff: 0.3 },
  { radius: 3.0, thickness: 3.0 },
  { radius: 3.0, thickness: 3.0, distanceExponent: 1.0, scale: 2.0 },
  { radius: 4.0, thickness: 6.0, distanceExponent: 1.0, scale: 2.2, samples: 20 },
];
for (const t of trials) {
  await set({ ...BASE, ...t });
  const label = Object.entries(t).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(label.padEnd(46), JSON.stringify(await aoStats()));
}

// Keep an image of the most promising combination.
await set({ ...BASE, radius: 4.0, thickness: 6.0, distanceExponent: 1.0, scale: 2.2, samples: 20 });
await aoStats('ao-sweep-best.png');
await b.close();
