/**
 * QA scenario 1 — PRIMAL TOWERS.
 *
 * Proves by execution, not by reading the defs:
 *   a) three picks of one element unlock the primal in availableTowers,
 *   b) building it spends PRIMAL.stacksConsumed stacks and RE-LOCKS the card,
 *   c) it out-damages a fusion by a wide margin using MEASURED totalDamage
 *      accumulated over live waves, never the number printed on the card,
 *   d) selling it hands the two stacks back.
 *
 * The DPS half is a same-tile A/B: the primal and the fusion are built on the
 * SAME anchor across two runs of the SAME wave numbers, because two towers on
 * two different tiles see different creeps and the comparison would be noise.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5298';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 40000 });
await page.waitForTimeout(1200);

const out = await page.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = {};

  // ---- a) unlock -----------------------------------------------------------
  const keys = () => g.availableTowers.map((d) => d.key);
  R.beforePicks = { elements: [...g.state.elements], primalOffered: keys().includes('primal_fire') };

  g.state.pendingElementPicks = 3;
  g.chooseElement('fire');
  R.afterPick1 = { count: g.elementCount('fire'), primalOffered: keys().includes('primal_fire') };
  g.chooseElement('fire');
  R.afterPick2 = { count: g.elementCount('fire'), primalOffered: keys().includes('primal_fire') };
  g.chooseElement('fire');
  R.afterPick3 = { count: g.elementCount('fire'), primalOffered: keys().includes('primal_fire') };

  // A second element so a FUSION exists to compare the primal against.
  g.state.pendingElementPicks = 1;
  g.chooseElement('water');
  // Dual ids are names ('vapor'), not composite strings — resolve by kind.
  const dualKeyOf = () => g.availableTowers.find((d) => d.kind === 'dual')?.key ?? null;
  R.dualOffered = g.availableTowers.filter((d) => d.kind === 'dual').map((d) => d.key);

  // ---- find a tile on the route -------------------------------------------
  // The route is generated, so it is discovered by watching where creeps walk
  // rather than hard-coded.
  g.state.gold = 900000;
  g.state.lives = 100000;
  g.state.wave = 0; g.state.phase = 'prep'; g.state.prepTimer = 0;
  g.startWaveNow();
  await sleep(2500);
  const route = [];
  for (let i = 0; i < g.creeps.capacity && route.length < 24; i++) {
    if (g.creeps.alive[i]) route.push({ x: g.creeps.x[i], z: g.creeps.z[i] });
  }
  R.routeSamples = route.length;

  // Probe for an anchor that actually accepts a build, then free it again.
  let anchor = null;
  outer: for (const p of route) {
    const a = g.grid.worldToTowerAnchor(p.x, p.z, {});
    for (const [dc, dr] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [3, 0], [0, 3]]) {
      const c = a.c + dc, r = a.r + dr;
      g.state.gold = 900000;
      if (g.build('foundation', c, r)) {
        const t = g.towers.towers[g.towers.towers.length - 1];
        g.sellTower(t.id);
        anchor = { c, r };
        break outer;
      }
    }
  }
  R.anchor = anchor;
  if (!anchor) return R;

  // Clear the board and the wave before the measured phase.
  for (const t of [...g.towers.towers]) g.sellTower(t.id);
  for (let i = 0; i < g.creeps.capacity; i++) if (g.creeps.alive[i]) g.creeps.kill(i, false);
  await sleep(600);

  // ---- b) build spends stacks and re-locks ---------------------------------
  const elementsBefore = [...g.state.elements];
  const fireBefore = g.elementCount('fire');
  g.state.gold = 900000;
  const goldBefore = g.state.gold;
  const built = g.build('primal_fire', anchor.c, anchor.r);
  const primal = g.towers.towers[g.towers.towers.length - 1];
  R.build = {
    ok: built,
    kind: primal?.def?.kind,
    key: primal?.key,
    goldSpent: goldBefore - g.state.gold,
    declaredCost: primal?.def?.levels?.[0]?.cost,
    fireBefore,
    fireAfter: g.elementCount('fire'),
    stacksConsumed: fireBefore - g.elementCount('fire'),
    // Fusions must survive a primal build: fire+water is still unlocked.
    stillOffersDual: dualKeyOf() !== null,
    reLocked: !keys().includes('primal_fire'),
    // The build path itself must now refuse a second primal.
    secondBuildRefused: (() => {
      g.state.gold = 900000;
      const okSecond = g.build('primal_fire', anchor.c + 3, anchor.r + 3);
      if (okSecond) { const t = g.towers.towers[g.towers.towers.length - 1]; g.sellTower(t.id); }
      return !okSecond;
    })(),
    placementReason: g.placementReason(anchor.c + 3, anchor.r + 3),
  };
  R.elementsBefore = elementsBefore;
  R.elementsAfterBuild = [...g.state.elements];

  // ---- c) MEASURED damage, same tile, same waves ---------------------------
  // Lives are pinned high and the wave list is fixed, so the only variable is
  // which tower stands on `anchor`.
  const measure = async (waves, ms) => {
    const t = g.towers.towers.find((x) => x.c === anchor.c && x.r === anchor.r);
    if (!t) return null;
    t.totalDamage = 0; t.kills = 0;
    const t0 = performance.now();
    for (const n of waves) {
      g.state.wave = n - 1; g.state.phase = 'prep'; g.state.prepTimer = 0;
      g.state.lives = 100000;
      g.startWaveNow();
      await sleep(ms);
    }
    const secs = (performance.now() - t0) / 1000;
    return { key: t.key, level: t.level, damage: Math.round(t.totalDamage), kills: t.kills, secs: +secs.toFixed(2), dps: Math.round(t.totalDamage / secs) };
  };

  const WAVES = [18, 19, 20];
  const MS = 6000;
  R.primalMeasured = await measure(WAVES, MS);

  // Swap in the fusion on the exact same tile.
  const p2 = g.towers.towers.find((x) => x.c === anchor.c && x.r === anchor.r);
  const goldPreSell = g.state.gold;
  const fireBeforeSell = g.elementCount('fire');
  g.sellTower(p2.id);
  // ---- d) sell returns the stacks -----------------------------------------
  R.sell = {
    fireBeforeSell,
    fireAfterSell: g.elementCount('fire'),
    stacksReturned: g.elementCount('fire') - fireBeforeSell,
    goldRefunded: g.state.gold - goldPreSell,
    primalUnlockedAgain: keys().includes('primal_fire'),
    elementsAfterSell: [...g.state.elements],
  };

  for (let i = 0; i < g.creeps.capacity; i++) if (g.creeps.alive[i]) g.creeps.kill(i, false);
  await sleep(600);

  const dualKey = dualKeyOf();
  g.state.gold = 900000;
  const dualBuilt = g.build(dualKey, anchor.c, anchor.r);
  R.dualBuild = { key: dualKey, ok: dualBuilt };
  R.dualMeasured = dualBuilt ? await measure(WAVES, MS) : null;

  if (R.primalMeasured && R.dualMeasured) {
    R.ratio = +(R.primalMeasured.damage / Math.max(1, R.dualMeasured.damage)).toFixed(2);
    R.dpsRatio = +(R.primalMeasured.dps / Math.max(1, R.dualMeasured.dps)).toFixed(2);
  }
  return R;
});

console.log(JSON.stringify(out, null, 2));
console.log('pageErrors:', JSON.stringify(errors, null, 2));
await browser.close();
