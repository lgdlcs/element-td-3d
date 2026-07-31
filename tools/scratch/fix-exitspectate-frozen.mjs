/**
 * REGRESSION: leaving spectate during a FROZEN phase (gameover / victory) must
 * leave every local tower seated at its own tile, not stacked at the world
 * origin on an identity matrix.
 *
 * Why it can only be tested in a browser: the fault lives in BatchedMesh's
 * per-instance matrices, which are only written by TowerBatch.update() — and
 * that call is only reachable from Game.#step(), which FROZEN_PHASES skips.
 *
 * Usage: node tools/scratch/fix-exitspectate-frozen.mjs [baseUrl]
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

  // Bind an element so a pure tower is buildable, then raise a few.
  g.state.elements = ['fire']; g.state.picks = ['fire'];
  g.state.pendingElementPicks = 0;
  g.state.phase = 'prep';
  g.state.gold = 5000;
  const built = [];
  for (const [c, r] of [[6, 6], [10, 6], [14, 6]]) {
    g.setBuildSelection?.('fire');
    g.selectedBuild = 'fire';
    if (g.build('fire', c, r)) built.push([c, r]);
  }
  g.selectedBuild = null;

  const settle = (n) => new Promise((res) => {
    let k = n;
    const tick = () => (--k <= 0 ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  await settle(60);            // let the rise animation finish

  // Where the batch says each tower's base sits, before anything happens.
  const readBases = () => g.towers.towers.map((t) => {
    const m = new (window.__three?.Matrix4 ?? Object.getPrototypeOf(g.towers.batch._m).constructor)();
    g.towers.batch.mesh.getMatrixAt(t.inst.base, m);
    return { id: t.id, x: +m.elements[12].toFixed(3), z: +m.elements[14].toFixed(3),
      tx: +t.x.toFixed(3), tz: +t.z.toFixed(3) };
  });
  const before = readBases();

  // The exact nominal scenario: dead player watches an opponent, opponent
  // finishes, server unwatches.
  const view = new SpectateView(g);
  view.begin({ id: 'peer', name: 'Peer', color: 0xff8844 });
  g.enterSpectate(view);
  g.state.phase = 'gameover';                 // frozen: #step no longer runs
  await settle(10);
  g.exitSpectate('over');
  await settle(10);

  const after = readBases();
  const atOrigin = after.filter((b) => b.x === 0 && b.z === 0).length;
  const misplaced = after.filter((b) => Math.abs(b.x - b.tx) > 0.01 || Math.abs(b.z - b.tz) > 0.01);
  return { built: built.length, phase: g.state.phase, before, after, atOrigin, misplaced };
});

console.log(JSON.stringify(out, null, 2));
const ok = out.built === 3 && out.atOrigin === 0 && out.misplaced.length === 0;
console.log(`console_errors: ${JSON.stringify(errs)}`);
console.log(`VERDICT: ${ok ? 'PASS' : 'FAIL'}`);
await browser.close();
process.exit(ok ? 0 : 1);
