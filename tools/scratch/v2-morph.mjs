/**
 * SCENARIO 2 - MORPH.
 * Build, upgrade, morph to another element. Asserts: the level carries over per
 * the min(srcLevel, targetMaxLevel) rule, the gold debit equals the quoted
 * price, the price the Inspector RENDERS equals the price morphCost computes
 * equals the price the documented formula gives, the per-tile tax applies to a
 * second morph, and the morphed tower actually shoots (totalDamage climbs
 * during a live wave).
 *
 * Usage: node tools/scratch/v2-morph.mjs [baseUrl]
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

// Two elements => pure fire, pure water and the fire+water dual are all legal
// morph targets, which is enough to exercise both the same-tier and the
// cross-tier (L3 pure -> L2 dual) level-carry rules.
await page.evaluate(() => {
  const g = window.__game;
  g.state.pendingElementPicks = 2;
  g.chooseElement('fire'); g.chooseElement('water');
  g.state.gold = 500000; g.state.lives = 99999;
  g.setSpeed(3);
});
await page.waitForTimeout(600);

// Learn the creep route so the morphed tower is somewhere it can actually fire.
await page.evaluate(() => { if (window.__game.state.phase === 'prep') window.__game.startWaveNow(); });
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

// ---- A. build + upgrade ----------------------------------------------------
log('A_buildUpgrade', await page.evaluate(({ c, r }) => {
  const g = window.__game;
  g.state.gold = 500000;
  g.state.phase = 'prep'; g.state.prepTimer = 9999;
  if (!g.build('fire', c, r)) throw new Error('build fire refused');
  const t = g.towers.towers[g.towers.towers.length - 1];
  const l0 = t.level;
  g.upgradeTower(t.id);
  g.upgradeTower(t.id);            // fire has 3 levels -> land on index 2
  window.__t = t.id;
  const now = g.towers.byId(t.id);
  return {
    id: t.id, levelAfterBuild: l0, levelAfterUpgrades: now.level,
    maxLevelIndex: now.def.levels.length - 1,
    goldPaid: 500000 - g.state.gold,
    expectedPaid: now.def.levels[0].cost + now.def.levels[1].cost + now.def.levels[2].cost,
  };
}, tile));

// ---- B. quoted price: formula vs morphCost vs rendered DOM -----------------
const quote = await page.evaluate(async () => {
  const g = window.__game;
  const t = g.towers.byId(window.__t);
  const { ECONOMY } = await import('/src/core/Config.js');
  const { towerDef } = await import('/src/game/TowerDefs.js');

  g.selectTower(t.id);
  g.hud.openMorph(t.id);          // renders the morph sheet, same path as the M key

  const rows = g.morphTargets.filter((d) => d.key !== t.key).map((d) => {
    const tgt = towerDef(d.key);
    // The documented formula, recomputed here from ECONOMY rather than reused
    // from Game, so a bug in morphCost cannot hide behind itself.
    const kept = Math.min(t.level, tgt.levels.length - 1);
    let paid = 0; for (let l = 0; l <= t.level; l++) paid += t.def.levels[l].cost;
    let want = 0; for (let l = 0; l <= kept; l++) want += tgt.levels[l].cost;
    const disc = ECONOMY.morphDiscount[Math.min(t.level, ECONOMY.morphDiscount.length - 1)];
    const tax = 1 + ECONOMY.morphTax * Math.min(t.morphCount ?? 0, ECONOMY.morphTaxCap);
    const spec = Math.max(0, Math.round((want - paid * ECONOMY.morphCredit) * (1 - disc) * tax));

    const btn = document.querySelector(`[data-morph="${CSS.escape(d.key)}"]`);
    const shown = btn?.querySelector('.ao-cost')?.textContent.trim();
    return {
      key: d.key, kind: tgt.kind, kept,
      spec, morphCost: g.morphCost(t, d.key),
      domCost: shown,
      domLevel: btn?.querySelector('.ao-lv')?.textContent.trim(),
    };
  });
  return { srcLevel: t.level, srcKey: t.key, rows };
});
log('B_quotes', quote);

// ---- C. commit the morph ---------------------------------------------------
const targetKey = quote.rows.find((r) => r.kind === 'dual')?.key ?? quote.rows[0].key;
log('C_morph', await page.evaluate((key) => {
  const g = window.__game;
  const t = g.towers.byId(window.__t);
  const before = {
    gold: g.state.gold, level: t.level, key: t.key,
    c: t.c, r: t.r, totalDamage: t.totalDamage, morphCount: t.morphCount ?? 0,
    quoted: g.morphCost(t, key),
  };
  const ok = g.morphTower(t.id, key);
  // morphTower creates a NEW tower object, so re-resolve through the grid tile.
  const nt = g.towers.towers.find((x) => x.c === before.c && x.r === before.r);
  window.__t = nt?.id;
  return {
    accepted: ok,
    from: before.key, to: nt?.key,
    levelBefore: before.level, levelAfter: nt?.level,
    targetMaxLevelIndex: nt ? nt.def.levels.length - 1 : null,
    expectedKept: Math.min(before.level, nt ? nt.def.levels.length - 1 : 0),
    quoted: before.quoted,
    goldBefore: before.gold, goldAfter: g.state.gold,
    goldDebited: before.gold - g.state.gold,
    sameTile: nt?.c === before.c && nt?.r === before.r,
    morphCountBefore: before.morphCount, morphCountAfter: nt?.morphCount,
    totalDamageCarried: nt?.totalDamage === before.totalDamage,
  };
}, targetKey));

// ---- D. the per-tile tax on a second morph ---------------------------------
log('D_secondMorphTax', await page.evaluate(async () => {
  const g = window.__game;
  const { ECONOMY } = await import('/src/core/Config.js');
  const t = g.towers.byId(window.__t);
  const back = g.morphTargets.find((d) => d.key === 'fire');
  if (!back) return 'fire not a legal target';
  const cost = g.morphCost(t, 'fire');
  // Same call with the tax factor divided out must equal the untaxed price.
  const tax = 1 + ECONOMY.morphTax * Math.min(t.morphCount ?? 0, ECONOMY.morphTaxCap);
  return { morphCount: t.morphCount, taxFactor: tax, quotedWithTax: cost, untaxedEquivalent: Math.round(cost / tax) };
}));

// ---- E. morph refused during combat ----------------------------------------
log('E_prepOnly', await page.evaluate(() => {
  const g = window.__game;
  const t = g.towers.byId(window.__t);
  const savedPhase = g.state.phase;
  g.state.phase = 'combat';
  const refused = g.morphTower(t.id, 'fire');
  g.state.phase = savedPhase;
  return { duringCombat: refused, expected: false };
}));

// ---- F. the morphed tower actually shoots ----------------------------------
log('F_fires', await page.evaluate(({ c, r }) => {
  const g = window.__game;
  const t = g.towers.towers.find((x) => x.c === c && x.r === r);
  window.__before = { key: t.key, dmg: t.totalDamage, kills: t.kills };
  g.state.gold = 500000; g.state.lives = 99999;
  g.state.phase = 'prep'; g.state.wave = 11; g.state.prepTimer = 999;
  g.startWaveNow();
  return window.__before;
}, tile));

await page.waitForFunction(() => window.__game.creeps._liveCount > 2, null, { timeout: 60000 });
for (let i = 0; i < 25; i++) {
  await page.evaluate(() => { window.__game.state.lives = 99999; });
  await page.waitForTimeout(800);
}
log('F_after', await page.evaluate(({ c, r }) => {
  const g = window.__game;
  const t = g.towers.towers.find((x) => x.c === c && x.r === r);
  return {
    key: t.key, level: t.level,
    damageBefore: Math.round(window.__before.dmg),
    damageAfter: Math.round(t.totalDamage),
    delta: Math.round(t.totalDamage - window.__before.dmg),
    killsDelta: t.kills - window.__before.kills,
  };
}, tile));

log('errors', errors);
await browser.close();
