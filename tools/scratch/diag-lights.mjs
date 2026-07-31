/** Is the off-board coloured row tower point-lights spilling onto the surround? */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
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
  await new Promise((r) => setTimeout(r, 4000));
});

const lightInfo = await p.evaluate(() => {
  const ls = window.__game.towers.batch?.lights ?? [];
  return ls.slice(0, 4).map((l) => ({
    intensity: +l.light.intensity.toFixed(2),
    distance: l.light.distance,
    decay: l.light.decay,
    pos: [+l.light.position.x.toFixed(1), +l.light.position.y.toFixed(1), +l.light.position.z.toFixed(1)],
    color: l.light.color.getHexString(),
  })).concat([{ total: ls.length }]);
});
console.log('tower lights:', JSON.stringify(lightInfo, null, 2));

await p.waitForTimeout(400);
writeFileSync('shots/diag-lights-on.png', await p.screenshot({ type: 'png', timeout: 120000 }));
await p.evaluate(() => { window.__game.towers.batch.lights.forEach((l) => { l.light.intensity = 0; }); });
await p.waitForTimeout(900);
writeFileSync('shots/diag-lights-off.png', await p.screenshot({ type: 'png', timeout: 120000 }));
await b.close();
console.log('wrote diag-lights-{on,off}.png');
