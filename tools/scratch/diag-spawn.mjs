/** Where do creeps actually stand relative to the board? */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const out = await p.evaluate(async () => {
  const g = window.__game;
  const gr = g.grid;
  const half = { x: (gr.cols / 2) * gr.cell, z: (gr.rows / 2) * gr.cell };

  // spawn a handful and read their world positions
  g.state.phase = 'combat';
  for (let i = 0; i < 6; i++) g.creeps.spawn('normal', 500, 5, Math.random() * 0.8);
  await new Promise((r) => setTimeout(r, 60));

  const c = g.creeps;
  const pos = [];
  for (let k = 0; k < c._liveCount; k++) {
    const i = c._live[k];
    pos.push({ x: +c.x[i].toFixed(2), z: +c.z[i].toFixed(2) });
  }
  return {
    gridCols: gr.cols, gridRows: gr.rows, cell: gr.cell,
    boardHalfX: half.x, boardHalfZ: half.z,
    spawnCell: { c: gr.spawn.c, r: gr.spawn.r },
    goalCell: gr.goal ? { c: gr.goal.c, r: gr.goal.r } : null,
    creeps: pos.slice(0, 12),
    plateauTop: g.arena.plateauTop, laneFloor: g.arena.laneFloor,
    rimOuter: g.arena.rimOuterRadius ?? null,
  };
});
console.log(JSON.stringify(out, null, 2));
await b.close();
