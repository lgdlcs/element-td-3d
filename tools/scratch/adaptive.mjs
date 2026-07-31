/**
 * Does the adaptive resolution controller actually reach and HOLD 60 fps?
 *
 * Runs the loaded scenario at each preset and samples frame time + the scale it
 * settled on. Two things must both be true, and reporting only the first would
 * be dishonest:
 *   - it converges to ~16.7ms (vsync = 60fps)
 *   - it does so at a scale that is still worth looking at (>= minScale, and it
 *     must not be sitting ON the clamp, which would mean it gave up)
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });

for (const preset of ['ultra', 'high', 'medium', 'low']) {
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://localhost:5273/?q=${preset}`, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

  const placed = await p.evaluate(async () => {
    const g = window.__game;
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    g.state.gold = 999999; g.hud.closeElementPicker?.();
    const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    let n = 0;
    for (let r = 4; r < 14 && n < 21; r += 3)
      for (let c = 4; c < 22 && n < 21; c += 3)
        if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
    g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
    g.waves.start(21);
    await new Promise((r) => setTimeout(r, 10000));
    return n;
  });
  if (placed < 21) { console.log(`${preset}: ABORT, only ${placed} towers`); await p.close(); continue; }

  // Let the controller converge, then FREEZE it. Benching while it is still
  // adjusting mixes several resolutions into one median and reports a number
  // that describes no actual state of the game.
  await p.waitForTimeout(9000);
  const traj = await p.evaluate(() => {
    const a = window.__game.pipeline.adaptive;
    a.enabled = false;
    return a.scale;
  });

  const r = await p.evaluate(() => new Promise((res) => {
    let n = 0, t0 = performance.now(); const t = [];
    const tick = () => {
      const x = performance.now(); t.push(x - t0); t0 = x;
      if (++n < 180) requestAnimationFrame(tick);
      else {
        t.sort((a, c) => a - c);
        const a = window.__game.pipeline.adaptive;
        const rr = window.__game.pipeline.renderer;
        res({
          med: +t[90].toFixed(2), p95: +t[170].toFixed(2),
          scale: a?.scale, min: a?.minScale, max: a?.maxScale,
          buf: `${rr.domElement.width}x${rr.domElement.height}`,
        });
      }
    };
    requestAnimationFrame(tick);
  }));

  const at60 = r.med <= 17.4;
  const gaveUp = Math.abs(r.scale - r.min) < 1e-6;
  console.log(
    `${preset.padEnd(7)} median ${String(r.med).padStart(6)}ms (${String(Math.round(1000 / r.med)).padStart(3)}fps)  `
    + `p95 ${String(r.p95).padStart(6)}ms  scale ${String(traj).padEnd(5)} (max ${r.max}, min ${r.min})  ${r.buf.padEnd(11)}  `
    + `${at60 ? '60FPS' : 'MISS '}${gaveUp ? '  CLAMPED — controller gave up' : ''}`
    + (errs.length ? `  ERRORS: ${errs[0]}` : ''),
  );
  await p.close();
}

await b.close();
