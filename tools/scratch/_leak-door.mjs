import { chromium } from 'playwright';
const ARGS = ['--enable-unsafe-swiftshader','--mute-audio','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-frame-rate-limit','--use-angle=metal'];
const b = await chromium.launch({ args: ARGS });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:5273/?solo&q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
console.log(JSON.stringify(await p.evaluate(async () => {
  const g = window.__game; const wait = ms => new Promise(r => setTimeout(r, ms));
  g.hud.closeElementPicker(); g.state.phase = 'combat'; g.state.gold = 999999;
  g.waves.start(1); await wait(2500);
  const cr = g.creeps, grid = g.grid;
  const live = []; for (let n = 0; n < cr._liveCount; n++) { const i = cr._live[n]; if (cr.alive[i] && !cr.flying[i]) live.push(i); }
  if (live.length < 2) return { error: 'pas assez de creeps', live: live.length };
  const bottomZ = (grid.rows / 2) * grid.cell - grid.cell * 0.5 + 0.05;
  // A: loin du portail (colonne 2). B: dans le portail.
  const a = live[0], bI = live[1];
  const lives0 = g.state.lives;
  const uidA = cr.uid[a], uidB = cr.uid[bI];
  const xFar = grid.cellToWorld(2, grid.rows - 1, {}).x;
  const xGate = grid.cellToWorld(grid.goal.c, grid.rows - 1, {}).x + grid.cell * 0.5;
  cr.x[a] = xFar; cr.z[a] = bottomZ;
  cr.x[bI] = xGate; cr.z[bI] = bottomZ;
  await wait(700);
  return {
    horsPortail_encoreVivant: !!cr.alive[a] && cr.uid[a] === uidA,
    horsPortail_seDeplaceVersLePortail: Math.abs(cr.x[a] - xFar) > 0.01,
    dansPortail_aFuite: !(cr.alive[bI] && cr.uid[bI] === uidB),
    viesPerdues: lives0 - g.state.lives,
    goalCols: [grid.goal.c, grid.goal.c + 1], cols: grid.cols,
  };
}), null, 1));
await b.close();
