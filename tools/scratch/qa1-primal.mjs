/**
 * QA SCENARIO 1 — PRIMAL TOWERS.
 *
 * Executed, not reasoned about:
 *   A. 2 stacks of one element => primal still locked, build() refuses, reason 'stacks'.
 *   B. 3rd stack => primal appears in availableTowers.
 *   C. build => 2 stacks consumed, card re-locked, gold debited by levels[0].cost.
 *   D. MEASURED damage: primal vs dual, SAME tile, SAME wave number, same window.
 *   E. sell => the 2 stacks come back and the card reappears.
 *
 * Usage: node tools/scratch/qa1-primal.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5297';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const R = {};
const errs = [];
const put = (k, v) => { R[k] = v; console.log(`[${k}] ${JSON.stringify(v)}`); };

const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state, null, { timeout: 60000 });
await page.waitForTimeout(1200);

put('boot', await page.evaluate(() => ({
  phase: window.__game.state.phase,
  picks: window.__game.state.pendingElementPicks,
  elements: window.__game.state.elements.slice(),
  gold: window.__game.state.gold,
})));

// ---------------------------------------------------------------- A: 2 stacks
put('A_twoStacks', await page.evaluate(async () => {
  const g = window.__game;
  const { availableTowers, towerDef } = await import('/src/game/TowerDefs.js');
  g.state.pendingElementPicks = 2;
  g.chooseElement('fire');
  g.chooseElement('fire');
  g.state.gold = 100000;
  // find a legal 2x2 anchor
  let tile = null;
  for (let r = 2; r < g.grid.rows - 3 && !tile; r += 1) {
    for (let c = 2; c < g.grid.cols - 3; c += 1) {
      if (g.placementReason(c, r) === 'valid') { tile = { c, r }; break; }
    }
  }
  window.__tile = tile;
  g.setBuildSelection('primal_fire');
  const reason = g.placementReason(tile.c, tile.r);
  const built = g.build('primal_fire', tile.c, tile.r);
  return {
    elements: g.state.elements.slice(),
    unlocked: availableTowers(g.state.elements).some((d) => d.key === 'primal_fire'),
    placementReason: reason,
    buildReturned: built,
    towerCount: g.towers.towers.length,
    defExists: !!towerDef('primal_fire'),
    tile,
  };
}));

// ---------------------------------------------------------------- B: 3rd stack
put('B_thirdStack', await page.evaluate(async () => {
  const g = window.__game;
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  g.state.pendingElementPicks = 2;
  g.chooseElement('fire');
  g.chooseElement('water');   // needed later for the dual comparison
  return {
    elements: g.state.elements.slice(),
    unlocked: availableTowers(g.state.elements).some((d) => d.key === 'primal_fire'),
    reasonNow: g.placementReason(window.__tile.c, window.__tile.r),
    dockKeys: g.hud.buildBar ? undefined : undefined,
  };
}));

// ---------------------------------------------------------------- C: build
put('C_build', await page.evaluate(async () => {
  const g = window.__game;
  const { availableTowers, towerDef } = await import('/src/game/TowerDefs.js');
  const t = window.__tile;
  g.state.gold = 100000;
  const goldBefore = g.state.gold;
  const elemBefore = g.state.elements.slice();
  g.setBuildSelection('primal_fire');
  const ok = g.build('primal_fire', t.c, t.r);
  const tw = g.towers.towers.find((x) => x.c === t.c && x.r === t.r);
  window.__primalId = tw ? tw.id : null;
  return {
    buildReturned: ok,
    goldBefore, goldAfter: g.state.gold,
    goldSpent: goldBefore - g.state.gold,
    expectedCost: towerDef('primal_fire').levels[0].cost,
    elemBefore, elemAfter: g.state.elements.slice(),
    fireBefore: elemBefore.filter((x) => x === 'fire').length,
    fireAfter: g.state.elements.filter((x) => x === 'fire').length,
    stillUnlocked: availableTowers(g.state.elements).some((d) => d.key === 'primal_fire'),
    builtKey: tw ? tw.key : null,
    buildSelectionAfter: g.selectedBuild,
  };
}));

// ---------------------------------------------------------------- E: sell first
// (done before the DPS run so the tile is free; re-checked at the end too)
put('E_sell', await page.evaluate(async () => {
  const g = window.__game;
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  const before = { gold: g.state.gold, fire: g.state.elements.filter((x) => x === 'fire').length };
  g.sellTower(window.__primalId);
  return {
    goldBefore: before.gold, goldAfter: g.state.gold, refund: g.state.gold - before.gold,
    expectedRefund: Math.floor(900 * 0.75),
    fireBefore: before.fire, fireAfter: g.state.elements.filter((x) => x === 'fire').length,
    relocked: availableTowers(g.state.elements).some((d) => d.key === 'primal_fire'),
    towersLeft: g.towers.towers.length,
  };
}));

// ---------------------------------------------------------------- D: measured damage
// Same tile, same wave number, same duration, one after the other.
const WAVE = 40;
const WINDOW_MS = 26000;

async function runOne(key, level) {
  await page.evaluate(async ({ key, level, WAVE }) => {
    const g = window.__game;
    const t = window.__tile;
    // clear the board
    for (const tw of [...g.towers.towers]) g.towers.remove(tw.id);
    g.creeps.count = 0; g.creeps._liveCount = 0; g.creeps.rebuildHash?.();
    g.waves.spawning = false;
    g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();

    g.state.gold = 1000000;
    g.state.lives = 1000000;
    g.state.phase = 'prep';
    g.setBuildSelection(key);
    g.build(key, t.c, t.r);
    const tw = g.towers.towers.find((x) => x.c === t.c && x.r === t.r);
    while (tw.level < level) g.towers.upgrade(tw.id);
    tw.totalDamage = 0;
    window.__probeId = tw.id;

    g.state.wave = WAVE - 1;
    g.state.phase = 'combat';
    g.state.wave = WAVE;
    g.waves.start(WAVE);
  }, { key, level, WAVE });

  await page.waitForTimeout(WINDOW_MS);

  return page.evaluate(() => {
    const g = window.__game;
    const tw = g.towers.byId(window.__probeId);
    const s = g.towers.stats(tw);
    return {
      key: tw.key, level: tw.level,
      totalDamage: Math.round(tw.totalDamage),
      kills: tw.kills,
      statedDamage: s.damage, statedCooldown: s.cooldown, statedRange: s.range,
      theoreticalDps: Math.round(s.damage / s.cooldown),
      creepsAlive: g.creeps.count,
    };
  });
}

const dualKey = await page.evaluate(async () => {
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  const g = window.__game;
  const d = availableTowers(g.state.elements).find((x) => x.kind === 'dual');
  return d ? d.key : null;
});
put('D_dualKey', dualKey);

const dual = await runOne(dualKey, 1);
put('D_dual_L1', dual);

const primal = await runOne('primal_fire', 1);
put('D_primal_L1', primal);

put('D_ratio', {
  measuredDamageRatio: +(primal.totalDamage / Math.max(1, dual.totalDamage)).toFixed(2),
  theoreticalDpsRatio: +(primal.theoreticalDps / Math.max(1, dual.theoreticalDps)).toFixed(2),
  windowSeconds: WINDOW_MS / 1000,
  wave: WAVE,
});

// re-verify the stack accounting survived the DPS run (primal is still standing)
put('E2_sellAfterDps', await page.evaluate(async () => {
  const g = window.__game;
  const { availableTowers } = await import('/src/game/TowerDefs.js');
  const id = window.__probeId;
  const t = g.towers.byId(id);
  const fireBefore = g.state.elements.filter((x) => x === 'fire').length;
  const unlockedBefore = availableTowers(g.state.elements).some((d) => d.key === 'primal_fire');
  g.sellTower(id);
  return {
    soldKey: t.key,
    fireBefore, fireAfter: g.state.elements.filter((x) => x === 'fire').length,
    unlockedBefore,
    unlockedAfter: availableTowers(g.state.elements).some((d) => d.key === 'primal_fire'),
  };
}));

put('consoleErrors', errs);
await browser.close();
console.log('\n=== RAW ===\n' + JSON.stringify(R, null, 2));
