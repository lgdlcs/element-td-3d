/**
 * What does each quality preset actually cost?
 *
 * The user reports the game is unplayable even at `low`. `low` disables SSAO,
 * MSAA, DOF, grain and decals and caps pixelRatio at 1 — so if `low` is still
 * slow, the cost is not in the post stack, and no amount of preset tuning will
 * reach it. Measure per-preset frame time on a loaded board, and report the
 * geometry alongside it so the two can be told apart.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio'] });

for (const q of ['ultra', 'high', 'medium', 'low']) {
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await p.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  p.on('pageerror', e => p.evaluate(m => { window.__frameErr = m; }, e.message).catch(() => {}));
  await p.goto(`http://localhost:5273/?q=${q}`, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

  // Empty board first, then the loaded scenario, so the delta attributes cost.
  const empty = await p.evaluate(() => new Promise(res => {
    let n = 0, t0 = performance.now(); const times = [];
    const tick = () => { const t = performance.now(); times.push(t - t0); t0 = t;
      if (++n < 120) requestAnimationFrame(tick);
      else { times.sort((a,c)=>a-c);
        const r = window.__game.pipeline.renderer.info.render;
        res({ median: +times[60].toFixed(2), p95: +times[113].toFixed(2), tris: r.triangles, calls: r.calls }); } };
    requestAnimationFrame(tick);
  }));

  await p.evaluate(async () => {
    const g = window.__game;
    g.state.elements = ['fire','water','nature','earth','light','dark'];
    g.state.gold = 999999; g.hud.closeElementPicker?.();
    const keys = ['fire','water','nature','earth','light','dark'];
    let n = 0;
    for (let r = 4; r < 14 && n < 21; r += 3)
      for (let c = 4; c < 22 && n < 21; c += 3)
        if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
    g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
    g.waves.start(21);
    await new Promise(r => setTimeout(r, 8000));
    // A crash in the frame loop leaves a plausible, well-exposed, EMPTY board
    // and a flattering frame time. Refuse to report that as a result: the
    // `low` preset did exactly this once towerLights hit 0.
    if (n < 21) throw new Error(`only ${n}/21 towers placed`);
    if (window.__frameErr) throw new Error('frame loop threw: ' + window.__frameErr);
  });

  const loaded = await p.evaluate(() => new Promise(res => {
    let n = 0, t0 = performance.now(); const times = [];
    const tick = () => { const t = performance.now(); times.push(t - t0); t0 = t;
      if (++n < 180) requestAnimationFrame(tick);
      else { times.sort((a,c)=>a-c);
        const r = window.__game.pipeline.renderer.info.render;
        res({ median: +times[90].toFixed(2), p95: +times[170].toFixed(2), tris: r.triangles, calls: r.calls }); } };
    requestAnimationFrame(tick);
  }));

  const fps = ms => (1000 / ms).toFixed(0);
  console.log(`${q.padEnd(7)} empty ${String(empty.median).padStart(6)}ms (${fps(empty.median).padStart(3)}fps) ${String(empty.tris/1000|0).padStart(4)}k tri ${String(empty.calls).padStart(4)} calls  |  loaded ${String(loaded.median).padStart(6)}ms (${fps(loaded.median).padStart(3)}fps) p95 ${String(loaded.p95).padStart(6)}ms ${String(loaded.tris/1000|0).padStart(4)}k tri ${String(loaded.calls).padStart(4)} calls`);
  await p.close();
}
await b.close();
