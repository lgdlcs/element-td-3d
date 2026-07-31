/**
 * SCENARIO 1b - fair primal-vs-dual damage measurement.
 *
 * The first pass measured over a fixed wall-clock window, and the dual ran out
 * of creeps inside it: it was being charged for seconds in which no target
 * existed. This samples (time, totalDamage, liveCreeps) at 200 ms for the whole
 * wave and divides damage only by the time targets were actually on the board,
 * which is the quantity "DPS" is supposed to mean. Same tile, same wave number,
 * one tower at a time.
 *
 * Usage: node tools/scratch/v1b-dps.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5296';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const errors = [];
const log = (k, v) => console.log(`${k}: ${JSON.stringify(v)}`);

const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 45000 });
await page.waitForTimeout(1500);

await page.evaluate(() => {
  const g = window.__game;
  g.state.pendingElementPicks = 4;
  g.chooseElement('fire'); g.chooseElement('fire');
  g.chooseElement('fire'); g.chooseElement('water');
  g.state.gold = 500000; g.state.lives = 99999;
  g.setSpeed(3);
  if (g.state.phase === 'prep') g.startWaveNow();
});

// Learn the real creep route, then pick the tile with the most coverage.
const samples = [];
for (let i = 0; i < 50; i++) {
  samples.push(...await page.evaluate(() => {
    const c = window.__game.creeps; const o = [];
    for (let n = 0; n < c._liveCount; n++) { const i = c._live[n]; o.push([c.x[i], c.z[i]]); }
    return o;
  }));
  await page.waitForTimeout(100);
}
const tile = await page.evaluate((pts) => {
  const g = window.__game; let best = null; const s = {};
  for (let c = 1; c < g.grid.cols - 2; c++) for (let r = 1; r < g.grid.rows - 2; r++) {
    if (g.placementReason(c, r) !== 'valid') continue;
    const p = g.grid.towerCentreToWorld(c, r, s);
    let n = 0;
    for (const [x, z] of pts) { const dx = x - p.x, dz = z - p.z; if (dx * dx + dz * dz < 64) n++; }
    if (!best || n > best.n) best = { c, r, n };
  }
  return best;
}, samples);
log('tile', tile);
await page.waitForFunction(() => !window.__game.waves.inProgress, null, { timeout: 120000 });

const WAVE = 14;

/** One tower alone on `tile`, one full replay of wave WAVE, sampled in-page. */
async function run(key) {
  await page.evaluate(({ key, c, r, WAVE }) => {
    const g = window.__game;
    for (const t of [...g.towers.towers]) g.towers.remove(t.id);
    g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
    g.state.gold = 500000; g.state.lives = 99999;
    while (g.elementCount('fire') < 3) g.state.elements.push('fire');
    if (!g.build(key, c, r)) throw new Error(`build ${key} refused`);
    g.state.phase = 'prep'; g.state.wave = WAVE - 1; g.state.prepTimer = 999;
    g.startWaveNow();

    // In-page sampler: a node-side poll would alias against the render loop.
    const t = g.towers.towers[0];
    const rec = { rows: [], t0: performance.now(), key };
    window.__rec = rec;
    rec.timer = setInterval(() => {
      g.state.lives = 99999;   // a leak must not end the run mid-measurement
      rec.rows.push([performance.now() - rec.t0, t.totalDamage, g.creeps._liveCount, t.kills]);
    }, 200);
  }, { key, ...tile, WAVE });

  await page.waitForFunction(() => !window.__game.waves.inProgress, null, { timeout: 180000 });
  await page.waitForTimeout(500);

  return page.evaluate(() => {
    const rec = window.__rec; clearInterval(rec.timer);
    const g = window.__game; const t = g.towers.towers[0];
    // Only intervals whose START had a live target count toward the clock.
    let armedMs = 0, dmg = 0, totalMs = 0;
    for (let i = 1; i < rec.rows.length; i++) {
      const dt = rec.rows[i][0] - rec.rows[i - 1][0];
      totalMs += dt;
      if (rec.rows[i - 1][2] > 0) { armedMs += dt; dmg += rec.rows[i][1] - rec.rows[i - 1][1]; }
    }
    return {
      key: rec.key,
      level: t.level,
      totalDamage: Math.round(t.totalDamage),
      kills: t.kills,
      wallSeconds: +(totalMs / 1000).toFixed(1),
      secondsWithTargets: +(armedMs / 1000).toFixed(1),
      dps_measured: Math.round(dmg / (armedMs / 1000)),
      dps_paper: Math.round(t.def.levels[t.level].damage / t.def.levels[t.level].cooldown),
      cost: t.def.levels[0].cost,
      samples: rec.rows.length,
    };
  });
}

const dualKey = await page.evaluate(async () => {
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  return availableTowers(window.__game.state.elements).find((x) => x.kind === 'dual').key;
});

const p = await run('primal_fire'); log('primal', p);
const d = await run(dualKey);       log('dual', d);
// Second pass in the opposite order, to prove the result is not an artefact of
// which tower went first (creep RNG differs per wave instance).
const d2 = await run(dualKey);      log('dual_again', d2);
const p2 = await run('primal_fire'); log('primal_again', p2);

log('VERDICT', {
  primal_dps: [p.dps_measured, p2.dps_measured],
  dual_dps: [d.dps_measured, d2.dps_measured],
  primal_totalDamage: [p.totalDamage, p2.totalDamage],
  dual_totalDamage: [d.totalDamage, d2.totalDamage],
  ratio_dps: +(((p.dps_measured + p2.dps_measured) / (d.dps_measured + d2.dps_measured))).toFixed(2),
  ratio_totalDamage: +(((p.totalDamage + p2.totalDamage) / (d.totalDamage + d2.totalDamage))).toFixed(2),
  gold_ratio: +(p.cost / d.cost).toFixed(2),
});
log('errors', errors);
await browser.close();
