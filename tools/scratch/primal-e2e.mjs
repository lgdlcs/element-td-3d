/**
 * End-to-end acceptance for Primal towers, against the real Game object.
 *
 *   node tools/scratch/primal-e2e.mjs        (from the repo root)
 *
 * Spins its own vite on 5290 so it can never touch a dev server the user has
 * running. The chromium args are the mandatory anti-throttling set: without them
 * requestAnimationFrame is starved in headless and the simulation never advances,
 * which looks exactly like a frozen game.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 5290;
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite did not start')), 25000);
  vite.stdout.on('data', (d) => { if (String(d).includes('ready in') || String(d).includes('Local:')) { clearTimeout(t); res(); } });
  vite.stderr.on('data', (d) => process.stderr.write(d));
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails++; });
await page.goto(`http://localhost:${PORT}/?solo=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.hud, null, { timeout: 20000 });

const r = await page.evaluate(() => {
  const g = window.__game;
  const out = {};

  // Bypass the picker modal: chooseElement is the same entry point it uses.
  g.state.pendingElementPicks = 3;
  g.chooseElement('fire'); g.chooseElement('fire'); g.chooseElement('fire');
  g.state.pendingElementPicks = 1;
  g.chooseElement('water');
  g.state.phase = 'prep';
  g.state.gold = 9999;

  const keys = () => g.availableTowers.map((d) => d.key);
  out.unlocked = keys().includes('primal_fire');
  out.fusionBefore = keys().includes('vapor');
  out.count3 = g.elementCount('fire');

  // Dock rendering: the primal card must actually be in the DOM.
  g.hud.refreshBuildBar();
  out.dockCard = !!document.querySelector('#dock-primal [data-tower="primal_fire"]');
  out.stackBadge = !!document.querySelector('#dock-primal .tc-stacks');

  g.selectedBuild = 'primal_fire';

  // Find two legal tiles: one to occupy with a foundation, one for the primal.
  const legal = [];
  for (let c = 2; c < g.grid.cols - 3 && legal.length < 2; c += 2) {
    for (let rr = 2; rr < g.grid.rows - 3 && legal.length < 2; rr += 2) {
      if (g.placementReason(c, rr) === 'valid') legal.push([c, rr]);
    }
  }
  // A REFUSED build must not eat stacks: block a tile, then aim the primal at
  // it. This is the ordering guarantee — every structural check runs before
  // #spendStacks, so an 'occupied' refusal leaves the holding untouched.
  g.build('foundation', legal[0][0], legal[0][1]);
  out.refusalReason = g.placementReason(legal[0][0], legal[0][1]);
  out.refused = g.build('primal_fire', legal[0][0], legal[0][1]);
  out.countAfterRefusal = g.elementCount('fire');

  const placed = legal[1];
  out.placed = placed;
  out.built = placed ? g.build('primal_fire', placed[0], placed[1]) : false;
  out.countAfterBuild = g.elementCount('fire');
  out.fusionAfter = keys().includes('vapor');
  out.relocked = !keys().includes('primal_fire');
  const t = g.towers.towers[g.towers.towers.length - 1];
  out.builtKey = t?.key;
  out.builtLevel = t?.level;

  // The 2/3 progress card. At 1/3 the rail deliberately shows NOTHING — six
  // permanently-dead cards would teach the player to ignore the rail — so this
  // asserts both halves of that rule.
  g.hud.refreshBuildBar();
  out.cardAt1 = !!document.querySelector('#dock-primal [data-progress="fire"]');
  g.state.elements.push('fire');            // 1 -> 2
  g.hud.refreshBuildBar();
  out.cardAt2 = !!document.querySelector('#dock-primal [data-progress="fire"]');
  out.pipsAt2 = document.querySelectorAll('#dock-primal [data-progress="fire"] .tc-prog i.on').length;
  g.state.elements.splice(g.state.elements.lastIndexOf('fire'), 1);   // back to 1

  // Sell returns the stacks.
  g.sellTower(t.id);
  out.countAfterSell = g.elementCount('fire');
  out.reUnlocked = g.availableTowers.map((d) => d.key).includes('primal_fire');

  // Codex must render 27 cells including six primals.
  g.hud.build.setCodex(true);
  out.codexPrimals = document.querySelectorAll('.cx-cell.primal').length;
  out.codexCells = document.querySelectorAll('.cx-cell').length;
  g.hud.build.setCodex(false);

  // Every primal spec must build without throwing (geometry is cached per
  // key:level, so this is the only place the 12 specs are exercised).
  out.specErrors = [];
  for (const el of ['fire', 'water', 'nature', 'earth', 'light', 'dark']) {
    for (const lvl of [0, 1]) {
      try { g.towers.batch.specFor?.(`primal_${el}`, lvl); } catch (e) { out.specErrors.push(e.message); }
    }
  }
  return out;
});

console.log('\nPrimal build transaction');
ok(r.unlocked, '3 stacks of fire unlock primal_fire');
ok(r.count3 === 3, `elementCount(fire) === 3 (got ${r.count3})`);
ok(r.dockCard, 'primal card renders in #dock-primal');
ok(r.stackBadge, 'stack-cost badge renders on the card');
ok(r.refusalReason === 'occupied' && r.refused === false, `the blocked tile refuses (${r.refusalReason})`);
ok(r.countAfterRefusal === 3, `a refused build eats no stacks (got ${r.countAfterRefusal})`);
ok(r.built === true, `legal build succeeds at ${JSON.stringify(r.placed)}`);
ok(r.builtKey === 'primal_fire' && r.builtLevel === 0, `tower is primal_fire L0 (got ${r.builtKey}/${r.builtLevel})`);
ok(r.countAfterBuild === 1, `build spends 2 stacks, 1 left (got ${r.countAfterBuild})`);
ok(r.relocked, 'primal re-locks after the build');
ok(r.fusionBefore && r.fusionAfter, 'vapor survives the primal build');
ok(!r.cardAt1, 'no progress card at 1 of 3 (the rail stays quiet)');
ok(r.cardAt2, 'a progress card appears at 2 of 3');
ok(r.pipsAt2 === 2, `the progress card lights 2 pips (got ${r.pipsAt2})`);
ok(r.countAfterSell === 3, `sell returns both stacks (got ${r.countAfterSell})`);
ok(r.reUnlocked, 'primal is buildable again after the sell');
ok(r.codexPrimals === 6, `codex shows 6 primal cells (got ${r.codexPrimals})`);
ok(r.codexCells === 27, `codex shows 27 cells (got ${r.codexCells})`);
ok(r.specErrors.length === 0, `primal geometry specs build: ${r.specErrors.join('; ')}`);

// --- inspector + the foundation arming route --------------------------------
const insp = await page.evaluate(() => {
  const g = window.__game;
  const out = {};
  g.state.gold = 9999;
  g.state.phase = 'prep';

  let cell = null;
  g.selectedBuild = 'foundation';
  for (let c = 2; c < g.grid.cols - 3 && !cell; c += 2) {
    for (let rr = 2; rr < g.grid.rows - 3; rr += 2) {
      if (g.placementReason(c, rr) === 'valid') { cell = [c, rr]; break; }
    }
  }
  g.build('foundation', cell[0], cell[1]);
  const f = g.towers.towers[g.towers.towers.length - 1];
  g.selectTower(f.id);
  // The foundation panel must offer the primal at the standard armed price.
  out.armOption = !!document.querySelector('[data-convert="primal_fire"]');
  out.armCost = g.convertCost('primal_fire');

  const before = g.state.gold;
  out.armed = g.convertTower(f.id, 'primal_fire');
  out.goldSpent = before - g.state.gold;
  out.stacksAfterArm = g.elementCount('fire');

  // convertTower selects the new tower, so the inspector is already showing it.
  const t = g.towers.byId(g.selectedTower);
  out.inspKey = t?.key;
  out.inspTitle = document.querySelector('#inspector .insp-id b')?.textContent ?? '';
  out.inspUpgrade = document.querySelector('#inspector #insp-upgrade em')?.textContent ?? '';
  out.inspLineage = document.querySelector('#inspector .insp-lineage')?.textContent.trim() ?? '';

  // Arming with no stacks left must be refused and cost nothing.
  g.build('foundation', cell[0] + 4, cell[1]);
  const f2 = g.towers.towers[g.towers.towers.length - 1];
  const gold2 = g.state.gold;
  out.refusedArm = g.convertTower(f2.id, 'primal_fire');
  out.goldUnchanged = g.state.gold === gold2;
  return out;
});

console.log('\nInspector + foundation arming');
ok(insp.armOption, 'the foundation panel lists the primal');
ok(insp.armCost === 660, `armed price is 660 (got ${insp.armCost})`);
ok(insp.armed && insp.goldSpent === 660, `arming charges 660 (got ${insp.goldSpent})`);
ok(insp.stacksAfterArm === 1, `arming spends 2 stacks (got ${insp.stacksAfterArm})`);
ok(insp.inspKey === 'primal_fire', `inspector holds the new primal (got ${insp.inspKey})`);
ok(insp.inspTitle === 'Cataclysm Tower', `panel title (got "${insp.inspTitle}")`);
ok(insp.inspUpgrade.replace(/\s/g, '') === '2200', `upgrade quotes 2200 (got "${insp.inspUpgrade}")`);
ok(/Fire/.test(insp.inspLineage), `lineage names the element (got "${insp.inspLineage}")`);
ok(insp.refusedArm === false && insp.goldUnchanged, 'arming with 1 stack is refused and free');

// --- leech, driven through the real projectile path -------------------------
const leech = await page.evaluate(async () => {
  const g = window.__game;
  const out = {};
  g.state.pendingElementPicks = 3;
  g.chooseElement('dark'); g.chooseElement('dark'); g.chooseElement('dark');
  g.state.phase = 'prep';
  g.state.gold = 9999;
  g.state.lives = 40;

  let cell = null;
  for (let c = 2; c < g.grid.cols - 3 && !cell; c += 2) {
    for (let rr = 2; rr < g.grid.rows - 3; rr += 2) {
      g.selectedBuild = 'primal_dark';
      if (g.placementReason(c, rr) === 'valid') { cell = [c, rr]; break; }
    }
  }
  g.build('primal_dark', cell[0], cell[1]);
  const t = g.towers.towers[g.towers.towers.length - 1];
  const c = g.creeps;

  /**
   * Drive one real impact: park a 1-HP creep beside the tower and fire the
   * tower's own stats at it through ProjectileManager, so the leech travels the
   * production path (#impact -> onLeech -> Game) rather than a stub.
   */
  const shoot = () => {
    const i = c.spawn('normal', 1, 0);
    c.x[i] = t.x + 2; c.z[i] = t.z; c.y[i] = 0.4; c.hp[i] = 1; c.maxHp[i] = 1;
    g.projectiles.spawn({
      x: t.x, y: 2.5, z: t.z, tx: c.x[i], ty: c.y[i], tz: c.z[i], target: i,
      speed: 20, color: t.def.color, accent: t.def.accent, towerId: t.id,
      stats: t.def.levels[0], arc: 0.05,
    });
    for (let k = 0; k < 120 && c.alive[i]; k++) g.projectiles.update(1 / 60);
    return !c.alive[i];
  };

  // Count only the LEECH float. The kill also emits a bounty float from
  // creeps.onDeath, which is unrelated and must keep firing at the cap.
  const hearts = () => g.hud.floats.filter((f) => f.el.textContent.includes('♥')).length;

  const heartsBefore = hearts();
  out.dead = shoot();
  out.lives = g.state.lives;
  out.heartsUnderCap = hearts() - heartsBefore;

  // Same again at the cap: lives must not move and nothing must be announced.
  g.state.lives = 50;
  const atCapBefore = hearts();
  out.deadAtCap = shoot();
  out.livesAtCap = g.state.lives;
  out.heartsAtCap = hearts() - atCapBefore;
  return out;
});

console.log('\nLifesteal');
ok(leech.dead && leech.deadAtCap, 'the test creeps died to the Oblivion hit');
ok(leech.lives === 41, `lives 40 -> 41 on a leech kill (got ${leech.lives})`);
ok(leech.livesAtCap === 50, `lives stay capped at 50 (got ${leech.livesAtCap})`);
ok(leech.heartsUnderCap === 1, `one leech float under the cap (got ${leech.heartsUnderCap})`);
ok(leech.heartsAtCap === 0, `no leech float at the cap (got ${leech.heartsAtCap})`);

// --- frame budget with primals on the board ---------------------------------
const perf = await page.evaluate(async () => {
  const g = window.__game;
  g.state.gold = 999999;
  g.state.phase = 'prep';
  // 40 towers, four of them primals (fire and dark are both at 3+ by now only if
  // refunded; top the stacks back up so the builds are legal).
  for (const el of ['fire', 'dark']) {
    while (g.elementCount(el) < 9) g.state.elements.push(el);
  }
  let built = 0, primals = 0;
  for (let c = 2; c < g.grid.cols - 2 && built < 40; c += 2) {
    for (let rr = 2; rr < g.grid.rows - 2 && built < 40; rr += 2) {
      const key = primals < 4 ? (primals % 2 ? 'primal_dark' : 'primal_fire') : 'fire';
      g.selectedBuild = key;
      if (g.placementReason(c, rr) !== 'valid') continue;
      if (g.build(key, c, rr)) { built++; if (key.startsWith('primal')) primals++; }
    }
  }
  g.state.phase = 'combat';
  g.waves.start(12);
  for (let k = 0; k < 120; k++) g.creeps.update(1 / 60), g.waves.update(1 / 60);
  const t0 = performance.now();
  for (let k = 0; k < 300; k++) {
    g.creeps.update(1 / 60); g.towers.update(1 / 60, k / 60); g.projectiles.update(1 / 60);
  }
  return { built, primals, ms: (performance.now() - t0) / 300, creeps: g.creeps.aliveCount ?? -1 };
});

console.log('\nFrame budget');
console.log(`  ${perf.built} towers (${perf.primals} primal), sim step ${perf.ms.toFixed(3)} ms`);
ok(perf.ms < 4, `sim step under 4 ms (got ${perf.ms.toFixed(3)})`);

await browser.close();
vite.kill('SIGTERM');
console.log(fails ? `\n${fails} FAILURES` : '\nall green');
process.exit(fails ? 1 : 0);
