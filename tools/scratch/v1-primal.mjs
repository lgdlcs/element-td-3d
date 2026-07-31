/**
 * SCENARIO 1 - PRIMALES.
 * Three stacks of one element unlock a primal; building it eats two stacks and
 * re-locks the card; selling it hands them back. Then a MEASURED damage
 * comparison primal vs dual on the SAME tile against the SAME wave number.
 *
 * Usage: node tools/scratch/v1-primal.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5296';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const errors = [];
const out = {};
const log = (k, v) => { out[k] = v; console.log(`${k}: ${JSON.stringify(v)}`); };

const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 45000 });
await page.waitForTimeout(1500);

// ---- A. unlock gating ------------------------------------------------------
log('A0_boot', await page.evaluate(() => ({
  phase: window.__game.state.phase,
  picks: window.__game.state.pendingElementPicks,
  elements: window.__game.state.elements.slice(),
})));

// Two fire stacks: primal must still be locked, and build() must refuse.
log('A1_twoStacks', await page.evaluate(async () => {
  const g = window.__game;
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  g.state.pendingElementPicks = 4;
  g.chooseElement('fire');
  g.chooseElement('fire');
  return {
    elements: g.state.elements.slice(),
    fireCount: g.elementCount('fire'),
    primalUnlocked: availableTowers(g.state.elements).some((d) => d.key === 'primal_fire'),
  };
}));

// Third fire + one water (water gives us a dual partner for the damage test).
log('A2_threeStacks', await page.evaluate(async () => {
  const g = window.__game;
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  g.chooseElement('fire');
  g.chooseElement('water');
  const avail = availableTowers(g.state.elements).map((d) => d.key);
  return {
    elements: g.state.elements.slice(),
    fireCount: g.elementCount('fire'),
    primalUnlocked: avail.includes('primal_fire'),
    available: avail,
  };
}));

await page.waitForTimeout(600);

// ---- B. find a tile the creeps actually walk past ---------------------------
await page.evaluate(() => {
  const g = window.__game;
  g.state.gold = 500000;
  g.state.lives = 99999;
  g.setSpeed(3);
  if (g.state.phase === 'prep') g.startWaveNow();
});

const samples = [];
for (let i = 0; i < 60; i++) {
  const s = await page.evaluate(() => {
    const c = window.__game.creeps;
    const o = [];
    for (let n = 0; n < c._liveCount; n++) { const i = c._live[n]; o.push([c.x[i], c.z[i]]); }
    return o;
  });
  samples.push(...s);
  await page.waitForTimeout(100);
}
log('B_pathSamples', samples.length);

const tile = await page.evaluate((pts) => {
  const g = window.__game;
  let best = null;
  const scratch = {};
  for (let c = 1; c < g.grid.cols - 2; c++) {
    for (let r = 1; r < g.grid.rows - 2; r++) {
      if (g.placementReason(c, r) !== 'valid') continue;
      const p = g.grid.towerCentreToWorld(c, r, scratch);
      let n = 0;
      for (const [x, z] of pts) {
        const dx = x - p.x, dz = z - p.z;
        if (dx * dx + dz * dz < 64) n++;   // within 8 units, inside every range here
      }
      if (!best || n > best.n) best = { c, r, n, x: p.x, z: p.z };
    }
  }
  return best;
}, samples);
log('B_tile', tile);

// Let the sampling wave finish so the measurement starts from a clean board.
await page.waitForFunction(() => !window.__game.waves.inProgress, null, { timeout: 120000 });

// ---- C. build the primal: stacks spent, card re-locked ----------------------
log('C_build', await page.evaluate(async ({ c, r }) => {
  const g = window.__game;
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  const before = { elements: g.state.elements.slice(), gold: g.state.gold };
  const ok = g.build('primal_fire', c, r);
  const t = g.towers.towers[g.towers.towers.length - 1];
  return {
    built: ok,
    key: t?.key,
    cost: t?.def.levels[0].cost,
    goldBefore: before.gold, goldAfter: g.state.gold,
    elementsBefore: before.elements,
    elementsAfter: g.state.elements.slice(),
    fireBefore: before.elements.filter((e) => e === 'fire').length,
    fireAfter: g.elementCount('fire'),
    primalStillUnlocked: availableTowers(g.state.elements).some((d) => d.key === 'primal_fire'),
    dockHasPrimalCard: !!document.querySelector('#dock [data-tower="primal_fire"]'),
  };
}, tile));

// ---- D. MEASURED damage, primal alone on the tile --------------------------
const WAVE = 18;
const measure = async (key, label) => {
  // Replay the SAME wave number with the SAME tile occupied by `key` only.
  await page.evaluate(async ({ key, c, r, WAVE }) => {
    const g = window.__game;
    for (const t of [...g.towers.towers]) g.towers.remove(t.id);
    g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
    g.state.gold = 500000;
    g.state.lives = 99999;
    // primal_fire re-locks after a build, so top the stacks back up first.
    while (g.elementCount('fire') < 3) g.state.elements.push('fire');
    const ok = g.build(key, c, r);
    if (!ok) throw new Error(`build ${key} refused`);
    g.state.phase = 'prep';
    g.state.wave = WAVE - 1;
    g.state.prepTimer = 999;
    g.startWaveNow();
  }, { key, ...tile, WAVE });

  // Wait for creeps to reach the tower, then measure a fixed window.
  await page.waitForFunction(() => window.__game.creeps._liveCount > 3, null, { timeout: 60000 });
  await page.waitForTimeout(4000);
  const t0 = await page.evaluate(() => {
    const g = window.__game; const t = g.towers.towers[0];
    return { d: t.totalDamage, k: t.kills, ms: performance.now() };
  });
  // Keep lives topped up so a leak cannot end the run mid-measurement.
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => { window.__game.state.lives = 99999; });
    await page.waitForTimeout(1000);
  }
  const t1 = await page.evaluate(() => {
    const g = window.__game; const t = g.towers.towers[0];
    return {
      d: t.totalDamage, k: t.kills, ms: performance.now(),
      level: t.level, key: t.key,
      liveCreeps: g.creeps._liveCount,
      defDamage: t.def.levels[t.level].damage, defCooldown: t.def.levels[t.level].cooldown,
    };
  });
  const secs = (t1.ms - t0.ms) / 1000;
  const res = {
    key: t1.key, window_s: +secs.toFixed(1),
    damage: Math.round(t1.d - t0.d), kills: t1.k - t0.k,
    dps_measured: Math.round((t1.d - t0.d) / secs),
    dps_paper: Math.round(t1.defDamage / t1.defCooldown),
    creepsStillAlive: t1.liveCreeps,
  };
  log(label, res);
  return res;
};

// The dual key is DUALS[...].id, not the pair string — derive it rather than guess.
const dualKey = await page.evaluate(async () => {
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  const d = availableTowers(window.__game.state.elements).find((x) => x.kind === 'dual');
  return d ? { key: d.key, name: d.name, cost: d.levels[0].cost } : null;
});
log('D_dualKey', dualKey);

const primal = await measure('primal_fire', 'D_primal');
const dual = await measure(dualKey.key, 'D_dual');
log('D_ratio', {
  measured: +(primal.dps_measured / Math.max(1, dual.dps_measured)).toFixed(2),
  paper: +(primal.dps_paper / Math.max(1, dual.dps_paper)).toFixed(2),
});

// ---- E. sell the primal: stacks come back ----------------------------------
log('E_sell', await page.evaluate(async ({ c, r }) => {
  const g = window.__game;
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  for (const t of [...g.towers.towers]) g.towers.remove(t.id);
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  // Rebuild a primal from an exact 3-stack state so the accounting is readable.
  g.state.elements = ['fire', 'fire', 'fire', 'water'];
  g.state.gold = 500000;
  g.build('primal_fire', c, r);
  const t = g.towers.towers[g.towers.towers.length - 1];
  const afterBuild = { elements: g.state.elements.slice(), gold: g.state.gold, fire: g.elementCount('fire') };
  g.sellTower(t.id);
  return {
    afterBuild,
    afterSellElements: g.state.elements.slice(),
    afterSellFire: g.elementCount('fire'),
    goldAfterSell: g.state.gold,
    primalUnlockedAgain: availableTowers(g.state.elements).some((d) => d.key === 'primal_fire'),
  };
}, tile));

log('errors', errors);
await browser.close();
