import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const out = await p.evaluate(async () => {
  const g = window.__game;
  const { buildTowerSpec } = await import('/src/game/towers/TowerArchetypes.js');
  const mod = await import('/src/game/TowerDefs.js');
  const table = mod.ALL_TOWERS;
  const res = [];
  for (const key of ['fire','water','nature','earth','light','dark']) {
    const def = table[key];
    if (!def) { res.push([key, 'MISSING']); continue; }
    for (const lvl of [0,1,2]) {
      const s = buildTowerSpec(def, lvl);
      res.push([key, lvl, +s.height.toFixed(2), +(s.height/4).toFixed(2)]);
    }
  }
  return res;
});
console.log(out.map(r => r.join('\t')).join('\n'));
await b.close();
