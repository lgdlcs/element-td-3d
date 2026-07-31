/**
 * REGRESSION: SpectateView's frame pool must survive an unbounded number of
 * begin()/end() cycles.
 *
 * end() used to do `this._buf.length = 0`, which dropped the two or three
 * pooled frames that are always in flight. The pool is fixed-size and never
 * refilled, so the 6th spectate started with it empty, onSnapshot's
 * `_pool.pop() ?? _buf.shift()` returned undefined, and the resulting TypeError
 * was swallowed by NetClient's try/catch — towers visible, no creeps, banner
 * stuck on "loading" for the rest of the run.
 *
 * Usage: node tools/scratch/fix-spectate-framepool.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5291';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const errs = [];
const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.state, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const g = window.__game;
  const { SpectateView } = await import('/src/game/spectate/SpectateView.js');
  const { SNAP_VERSION } = await import('/src/game/spectate/SpectateCodec.js');

  const view = new SpectateView(g);
  const total = view._pool.length;             // BUFFER_MAX + 3
  const thrown = [];
  let n = 0;
  const snap = () => ({
    v: SNAP_VERSION, from: 'peer', n: ++n,
    w: 3, l: 20, g: 200, sc: 10, ph: 0, pt: 0,
    tf: n === 1 ? [] : undefined,
    c: [1, 0, 0, 0, 100, 0, 2, 0, 100, 100, 100, 0],
  });

  const settle = (k) => new Promise((res) => {
    let i = k;
    const tick = () => (--i <= 0 ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

  const poolPerSession = [];
  for (let s = 0; s < 12; s++) {
    view.begin({ id: 'peer', name: 'Peer', color: 0x44ff88 });
    n = 0; view._lastN = 0;
    for (let i = 0; i < 6; i++) {
      try { view.onSnapshot(snap()); } catch (e) { thrown.push(`s${s}i${i}: ${e.message}`); }
      view.update(1 / 60);
      await settle(2);
    }
    poolPerSession.push(view._pool.length + view._buf.length);
    view.end();
  }

  return {
    total, poolPerSession, thrown,
    finalPool: view._pool.length, finalBuf: view._buf.length,
    conserved: poolPerSession.every((v) => v === total) && view._pool.length === total,
  };
});

console.log(JSON.stringify(out, null, 2));
console.log(`console_errors: ${JSON.stringify(errs)}`);
const ok = out.conserved && out.thrown.length === 0;
console.log(`VERDICT: ${ok ? 'PASS' : 'FAIL'}`);
await browser.close();
process.exit(ok ? 0 : 1);
