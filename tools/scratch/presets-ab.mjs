/**
 * The only comparison that answers the user's question: what does a player
 * actually get, before and after?
 *
 * Three presets matter here:
 *   medium — what autodetect handed an 8-core machine BEFORE this branch
 *            (`if (cores >= 8) return 'medium'`). The reference M1 has 8 cores
 *            and took that branch itself, as does every mid-range laptop with
 *            integrated graphics.
 *   low    — what autodetect hands the same machine now.
 *   potato — the new floor, and what an integrated GPU is now detected into.
 *
 * WHY IT ALTERNATES INSTEAD OF RUNNING EACH PRESET ONCE
 *
 * A preset is fixed at construction, so each cell needs its own page load and
 * the arms cannot be interleaved within one page the way an ablation can. That
 * makes this run maximally exposed to the drift that voided three earlier
 * probes in this directory: on this machine two readings of the SAME cell,
 * minutes apart, came out at 47.5 ms and 24.1 ms (tools/scratch/potato3.mjs).
 *
 * So the presets are visited round-robin for N passes — medium, low, potato,
 * medium, low, potato, ... — and each preset's result is the MEDIAN over its
 * passes. Drift that rises or falls across the session hits all three presets
 * roughly equally and comes out in the ranking, which is the claim being made.
 * The per-preset spread is printed: if a preset's own passes disagree by more
 * than the gap between presets, this run has not established an ordering and
 * says so.
 *
 * The adaptive controller is left ON, deliberately — unlike every ablation
 * probe here. The question is not "what does this preset cost at a fixed
 * resolution" but "what does a player experience", and the controller is part
 * of what a player experiences. Both frame time and the resolution scale it
 * settled at are reported, because 60 fps reached by halving the resolution is
 * a different outcome from 60 fps at full resolution and the number alone
 * cannot tell them apart.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const PRESETS = ['medium', 'low', 'potato'];
const PASSES = 4;
const FRAMES = 180;

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const results = Object.fromEntries(PRESETS.map((q) => [q, []]));

for (let pass = 0; pass < PASSES; pass++) {
  for (const q of PRESETS) {
    const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
    await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
    let err = null;
    p.on('pageerror', (e) => { err = e.message; });
    await p.goto(`http://localhost:5273/?solo&q=${q}`, { waitUntil: 'load' });
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
      // Long enough for the adaptive controller to converge AND for the
      // governor's patience window to have had its say.
      await new Promise((r) => setTimeout(r, 12000));
      return n;
    });
    // An empty board renders fast and flatters whatever preset is under test.
    if (placed < 21) { console.log(`  (skipped ${q}: only ${placed}/21 towers)`); await p.close(); continue; }

    const r = await p.evaluate((n) => new Promise((res) => {
      let i = 0, t0 = performance.now(); const times = [];
      const tick = () => {
        const t = performance.now(); times.push(t - t0); t0 = t;
        if (++i < n) requestAnimationFrame(tick);
        else {
          times.sort((a, c) => a - c);
          const g = window.__game;
          const gl = g.pipeline.renderer.getContext();
          res({
            median: +times[n >> 1].toFixed(1),
            p95: +times[Math.floor(n * 0.95)].toFixed(1),
            scale: +g.pipeline.renderer.getPixelRatio().toFixed(2),
            buf: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
            cut: window.__governor ? window.__governor.removed.length : -1,
          });
        }
      };
      requestAnimationFrame(tick);
    }), FRAMES);

    if (err) { console.log(`  (skipped ${q}: page error ${err})`); await p.close(); continue; }
    results[q].push(r);
    await p.close();
  }
  process.stdout.write(`  pass ${pass + 1}/${PASSES} done\n`);
}

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

console.log(`\nviewport 1600x900, 21 towers + wave 21, adaptive ON (as a player gets it)`);
console.log(`${PASSES} alternating passes per preset, ${FRAMES} frames each; value = median of passes\n`);
console.log('preset    median    fps     p95   px ratio  buffer       rungs cut   spread');
for (const q of PRESETS) {
  const rs = results[q];
  if (!rs.length) { console.log(`${q.padEnd(9)} no valid passes`); continue; }
  const m = med(rs.map((r) => r.median));
  const p95 = med(rs.map((r) => r.p95));
  const scale = med(rs.map((r) => r.scale));
  const spread = Math.max(...rs.map((r) => r.median)) - Math.min(...rs.map((r) => r.median));
  const cut = med(rs.map((r) => r.cut));
  console.log(
    `${q.padEnd(9)} ${String(m).padStart(6)}  ${String((1000 / m).toFixed(0)).padStart(4)}  ${String(p95).padStart(6)}  ` +
    `${String(scale).padStart(7)}  ${rs[rs.length - 1].buf.padEnd(11)} ${String(cut).padStart(6)}     ${spread.toFixed(1).padStart(6)}`,
  );
}

await b.close();
