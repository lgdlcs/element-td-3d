/**
 * QA scenario 2 — MORPH.
 *
 * Build -> upgrade -> morph, and check four independent things:
 *   a) the level survives the morph (clamped to what the target can hold),
 *   b) gold is debited by exactly morphCost,
 *   c) the number the INSPECTOR PRINTS equals the spec formula recomputed here
 *      from the raw defs — not equals g.morphCost(), which would be circular,
 *   d) the morphed tower actually shoots: its totalDamage climbs during a wave.
 *
 * Also exercises the two rules that make morph non-abusable: prep-only, and the
 * per-tile tax that multiplies the second morph of the same tile.
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
  const { ECONOMY } = await import('/src/core/Config.js');
  const { ALL_TOWERS } = await import('/src/game/TowerDefs.js');
  const R = { economy: { credit: ECONOMY.morphCredit, disc: ECONOMY.morphDiscount, tax: ECONOMY.morphTax } };

  /** The docblock formula, recomputed from the raw def tables. Independent of Game.morphCost. */
  const specCost = (srcKey, srcLevel, tgtKey, morphCount) => {
    const src = ALL_TOWERS[srcKey], tgt = ALL_TOWERS[tgtKey];
    const kept = Math.min(srcLevel, tgt.levels.length - 1);
    let paid = 0; for (let l = 0; l <= srcLevel; l++) paid += src.levels[l].cost;
    let want = 0; for (let l = 0; l <= kept; l++) want += tgt.levels[l].cost;
    const disc = ECONOMY.morphDiscount[Math.min(srcLevel, ECONOMY.morphDiscount.length - 1)];
    const tax = 1 + ECONOMY.morphTax * Math.min(morphCount, ECONOMY.morphTaxCap);
    return { cost: Math.max(0, Math.round((want - paid * ECONOMY.morphCredit) * (1 - disc) * tax)), kept };
  };

  // Two elements => a pure each plus one fusion to morph between.
  g.state.pendingElementPicks = 2;
  g.chooseElement('fire');
  g.chooseElement('water');
  R.available = g.availableTowers.map((d) => d.key);
  R.morphTargets = g.morphTargets.map((d) => d.key);

  // Discover a buildable tile on the creep route.
  g.state.gold = 900000; g.state.lives = 100000;
  g.state.wave = 0; g.state.phase = 'prep'; g.state.prepTimer = 0;
  g.startWaveNow();
  await sleep(2500);
  const route = [];
  for (let i = 0; i < g.creeps.capacity && route.length < 24; i++) {
    if (g.creeps.alive[i]) route.push({ x: g.creeps.x[i], z: g.creeps.z[i] });
  }
  let anchor = null;
  outer: for (const p of route) {
    const a = g.grid.worldToTowerAnchor(p.x, p.z, {});
    for (const [dc, dr] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [3, 0], [0, 3]]) {
      const c = a.c + dc, r = a.r + dr;
      g.state.gold = 900000;
      if (g.build('foundation', c, r)) {
        g.sellTower(g.towers.towers[g.towers.towers.length - 1].id);
        anchor = { c, r }; break outer;
      }
    }
  }
  R.anchor = anchor;
  if (!anchor) return R;
  for (const t of [...g.towers.towers]) g.sellTower(t.id);
  for (let i = 0; i < g.creeps.capacity; i++) if (g.creeps.alive[i]) g.creeps.kill(i, false);
  await sleep(400);

  // ---- build + upgrade -----------------------------------------------------
  g.state.gold = 900000;
  g.build('fire', anchor.c, anchor.r);
  let t = g.towers.towers.find((x) => x.c === anchor.c && x.r === anchor.r);
  g.state.gold = 900000;
  g.upgradeTower(t.id);           // level 0 -> 1
  t = g.towers.byId(t.id);
  R.beforeMorph = { key: t.key, level: t.level, morphCount: t.morphCount ?? 0 };

  // ---- morph is refused OUTSIDE prep --------------------------------------
  g.state.phase = 'combat';
  const refusedInWave = !g.morphTower(t.id, 'water');
  R.refusedDuringWave = { refused: refusedInWave, keyUnchanged: g.towers.byId(t.id)?.key === 'fire' };

  // Back to prep — with a LONG timer. #step auto-starts the wave the moment
  // prepTimer hits 0, so leaving it at 0 silently flips the phase to 'combat'
  // on the very next frame and every morph below is refused.
  const enterPrep = () => { g.state.phase = 'prep'; g.state.prepTimer = 9999; };
  enterPrep();
  await sleep(120);
  R.phaseBeforeMorph = g.state.phase;

  // ---- c) displayed cost vs spec ------------------------------------------
  // Open the real morph sheet and read the numbers off the DOM.
  g.selectTower(t.id);
  g.hud.openMorph(t.id);
  await sleep(150);
  const fmt = (v) => Math.round(v).toLocaleString('en-US').replace(/,/g, ' ');
  R.displayed = [...document.querySelectorAll('#inspector [data-morph]')].map((b) => {
    const key = b.dataset.morph;
    const spec = specCost(t.key, t.level, key, t.morphCount ?? 0);
    const shownCost = b.querySelector('.ao-cost')?.textContent.trim();
    const shownLv = b.querySelector('.ao-lv')?.textContent.trim();
    return {
      key,
      shownCost,
      shownLv,
      specCost: spec.cost,
      specLv: `Lv ${spec.kept + 1}`,
      gameCost: g.morphCost(t, key),
      expectString: spec.cost === 0 ? 'Free' : fmt(spec.cost),
      shownCodes: [...(shownCost ?? '')].map((ch) => ch.charCodeAt(0)),
      costMatchesSpec: shownCost === (spec.cost === 0 ? 'Free' : fmt(spec.cost)),
      // Whitespace-insensitive compare: the separator is cosmetic, the digits are not.
      digitsMatchSpec: (shownCost ?? '').replace(/\s/g, '') === (spec.cost === 0 ? 'Free' : String(spec.cost)),
      levelMatchesSpec: shownLv === `Lv ${spec.kept + 1}`,
      gameMatchesSpec: g.morphCost(t, key) === spec.cost,
    };
  });

  // ---- a) + b) the morph itself -------------------------------------------
  const target = 'water';
  const expected = specCost(t.key, t.level, target, t.morphCount ?? 0);
  g.state.gold = 900000;
  const goldBefore = g.state.gold;
  const srcLevel = t.level;
  const ok = g.morphTower(t.id, target);
  const nt = g.towers.towers.find((x) => x.c === anchor.c && x.r === anchor.r);
  R.morph = {
    ok,
    from: 'fire', to: nt?.key,
    srcLevel,
    newLevel: nt?.level,
    expectedKeptLevel: expected.kept,
    levelPreserved: nt?.level === expected.kept,
    goldDebited: goldBefore - g.state.gold,
    expectedCost: expected.cost,
    goldMatchesSpec: (goldBefore - g.state.gold) === expected.cost,
    morphCountAfter: nt?.morphCount,
    sameTile: nt?.c === anchor.c && nt?.r === anchor.r,
  };

  // ---- the per-tile tax ----------------------------------------------------
  const t2 = g.towers.byId(nt.id);
  const secondSpec = specCost(t2.key, t2.level, 'fire', t2.morphCount ?? 0);
  const untaxedSpec = specCost(t2.key, t2.level, 'fire', 0);
  R.tax = {
    morphCount: t2.morphCount,
    gameCost: g.morphCost(t2, 'fire'),
    specCostTaxed: secondSpec.cost,
    specCostUntaxed: untaxedSpec.cost,
    matches: g.morphCost(t2, 'fire') === secondSpec.cost,
    taxIsCharged: secondSpec.cost > untaxedSpec.cost,
  };

  // ---- d) the morphed tower really fires ----------------------------------
  const fire = async (ms) => {
    const tt = g.towers.towers.find((x) => x.c === anchor.c && x.r === anchor.r);
    tt.totalDamage = 0;
    const before = tt.totalDamage;
    g.state.wave = 17; g.state.phase = 'prep'; g.state.prepTimer = 0; g.state.lives = 100000;
    g.startWaveNow();
    const mid = [];
    for (let k = 0; k < 4; k++) { await sleep(ms / 4); mid.push(Math.round(g.towers.byId(tt.id).totalDamage)); }
    return { key: tt.key, level: tt.level, before, samples: mid };
  };
  R.morphedFires = await fire(8000);
  R.morphedFires.increased = R.morphedFires.samples[3] > 0
    && R.morphedFires.samples[3] > R.morphedFires.samples[0];

  return R;
});

console.log(JSON.stringify(out, null, 2));
console.log('pageErrors:', JSON.stringify(errors, null, 2));
await browser.close();
