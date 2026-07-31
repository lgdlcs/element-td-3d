/**
 * End-to-end acceptance for tower Morph, against the real Game object.
 *
 *   node tools/scratch/morph-e2e.mjs        (from the repo root)
 *
 * Spins its own vite on 5291 so it can never touch a dev server the user has
 * running. The chromium args are the mandatory anti-throttling set: without them
 * requestAnimationFrame is starved in headless and the simulation never
 * advances, which looks exactly like a frozen game.
 *
 * The load-bearing checks are (a) the seven cost rows of the spec table, (b) the
 * printed price equals the debit, and (c) the grid is bit-for-bit identical
 * across a morph, which is what licenses skipping path.rebuild().
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 5291;
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails++; };
const eq = (got, want, msg) => ok(got === want, `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite did not start')), 25000);
  vite.stdout.on('data', (d) => { if (String(d).includes('ready in') || String(d).includes('Local:')) { clearTimeout(t); res(); } });
  vite.stderr.on('data', (d) => process.stderr.write(d));
});
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on('pageerror', (e) => { console.log('  PAGE ERROR', e.message); fails++; });
await page.goto(`http://localhost:${PORT}/?solo=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.hud, null, { timeout: 20000 });

const r = await page.evaluate(() => {
  const g = window.__game;
  const out = {};

  // Bind every element so the whole 21-target grid is legal, and give fire a
  // third stack so a primal source/target is available to be refused.
  g.state.pendingElementPicks = 20;
  for (const e of ['fire', 'water', 'nature', 'earth', 'light', 'dark', 'fire', 'fire']) g.chooseElement(e);
  g.state.pendingElementPicks = 0;
  // The loop above leaves the picker open on pick 9. Its full-screen veil eats
  // every pointer event, so a real mouse hover would never reach the inspector.
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  g.state.gold = 99999;

  const legal = [];
  for (let c = 2; c < g.grid.cols - 3 && legal.length < 8; c += 3) {
    for (let rr = 2; rr < g.grid.rows - 3 && legal.length < 8; rr += 3) {
      if (g.placementReason(c, rr) === 'valid') legal.push([c, rr]);
    }
  }
  out.legalCount = legal.length;

  // --- 1. the cost table, all seven rows of the spec ----------------------
  const at = (i) => legal[i];
  const mk = (key, level, i) => {
    const [c, rr] = at(i);
    const t = g.towers.create(key, level, c, rr);
    return t;
  };
  const dark2 = mk('dark', 1, 0);
  const fire3 = mk('fire', 2, 1);
  const fire1 = mk('fire', 0, 2);
  const vapor1 = mk('vapor', 0, 3);
  const vapor2 = mk('vapor', 1, 4);
  const howi2 = mk('howitzer', 1, 5);

  out.costs = {
    darkness2_to_poison: g.morphCost(dark2, 'poison'),
    fire3_to_vapor: g.morphCost(fire3, 'vapor'),
    fire1_to_water1: g.morphCost(fire1, 'water'),
    vapor1_to_howitzer: g.morphCost(vapor1, 'howitzer'),
    vapor2_to_trickery: g.morphCost(vapor2, 'trickery'),
    howitzer2_to_nature: g.morphCost(howi2, 'nature'),
    fire3_to_light: g.morphCost(fire3, 'light'),
  };
  // Kept level: pure L3 into a two-level fusion lands at the fusion's max.
  out.keptFire3Vapor = Math.min(fire3.level, 1);

  // Tax ladder on one tile — the flip-flop price.
  out.taxLadder = [0, 1, 2, 3, 4, 5].map((n) => {
    vapor2.morphCount = n;
    return g.morphCost(vapor2, 'trickery');
  });
  vapor2.morphCount = 0;

  // --- 2. printed price == debit ------------------------------------------
  g.selectTower(dark2.id);
  g.hud.inspector.showMorph(dark2);
  const cardOf = (key) => document.querySelector(`#inspector [data-morph="${key}"]`);
  const poisonCard = cardOf('poison');
  out.sheetOpen = !!document.querySelector('#inspector.morph .morph-sheet');
  out.cardCount = document.querySelectorAll('#inspector [data-morph]').length;
  out.selfExcluded = !cardOf('dark');
  out.primalExcluded = !cardOf('primal_fire');
  out.foundationExcluded = !cardOf('foundation');
  // num() groups with a thin space (U+2009); normalise so the assertion below
  // is about the digits, not about which space character the file happens to use.
  out.printedPrice = poisonCard?.querySelector('.ao-cost')?.textContent.trim().replace(/\s/g, ' ');
  out.printedLevel = poisonCard?.querySelector('.ao-lv')?.textContent.trim();
  // The free down-morph must announce the forfeit rather than read as a bargain.
  g.hud.inspector.showMorph(howi2);
  const natureCard = cardOf('nature');
  out.freeCard = natureCard?.querySelector('.ao-cost')?.textContent.trim();
  out.freeMarked = natureCard?.classList.contains('morph-loss');
  out.freeTitle = natureCard?.getAttribute('title');

  // --- 3. the morph itself: identity, grid, no path rebuild ---------------
  g.hud.inspector.showMorph(dark2);
  const goldBefore = g.state.gold;
  dark2.mode = 'strong'; dark2.totalDamage = 4242; dark2.kills = 17;
  const gridBefore = Array.from(g.grid.cells).join('');
  let rebuilds = 0;
  const realRebuild = g.path.rebuild.bind(g.path);
  g.path.rebuild = () => { rebuilds++; return realRebuild(); };

  out.morphed = g.morphTower(dark2.id, 'poison');
  out.debited = goldBefore - g.state.gold;
  out.rebuilds = rebuilds;
  g.path.rebuild = realRebuild;

  const nt = g.towers.byId(g.selectedTower);
  out.newKey = nt?.key;
  out.samePos = nt ? (nt.c === dark2.c && nt.r === dark2.r) : false;
  out.newLevel = nt?.level;
  out.mode = nt?.mode;
  out.totalDamage = nt?.totalDamage;
  out.kills = nt?.kills;
  out.morphCount = nt?.morphCount;
  out.oldGone = !g.towers.byId(dark2.id);
  out.gridIdentical = Array.from(g.grid.cells).join('') === gridBefore;
  out.towerIdAtCell = g.grid.towerId[g.grid.idx(nt.c, nt.r)] === nt.id;
  // The panel must now be pointing at the NEW object, not the dead one.
  out.inspectorRepointed = g.hud.inspector.tower?.id === nt.id;
  // The second morph of the same tile is taxed.
  out.secondCost = g.morphCost(nt, 'disease');
  nt.morphCount = 0;
  out.secondUntaxed = g.morphCost(nt, 'disease');
  nt.morphCount = 1;

  // --- 4. gating ----------------------------------------------------------
  const goldNow = g.state.gold;
  g.state.phase = 'combat';
  out.refusedInCombat = g.morphTower(nt.id, 'disease');
  g.state.phase = 'prep';

  const prim = mk('primal_fire', 0, 6);
  out.refusedPrimalSource = g.morphTower(prim.id, 'fire');
  out.refusedPrimalTarget = g.morphTower(nt.id, 'primal_fire');
  out.refusedFoundationTarget = g.morphTower(nt.id, 'foundation');
  out.refusedSelf = g.morphTower(nt.id, 'poison');

  const found = g.towers.create('foundation', 0, at(7)[0], at(7)[1]);
  out.refusedInertSource = g.morphTower(found.id, 'fire');

  // A locked target: drop every element but fire, then aim at a water fusion.
  const held = g.state.elements.slice();
  g.state.elements = ['fire', 'fire', 'fire'];
  out.lockedTargets = g.morphTargets.map((d) => d.key);
  out.refusedLocked = g.morphTower(nt.id, 'well');
  g.state.elements = held;

  // Not enough gold.
  g.state.gold = 0;
  out.refusedPoor = g.morphTower(nt.id, 'trickery');
  g.state.gold = goldNow;
  out.goldUntouchedByRefusals = g.state.gold === goldNow;

  // --- 5. the button in the default panel ---------------------------------
  g.selectTower(nt.id);
  out.morphBtn = !!document.querySelector('#insp-morph');
  out.morphBtnEnabled = !document.querySelector('#insp-morph')?.disabled;
  g.selectTower(prim.id);
  out.primalMorphBtnDisabled = !!document.querySelector('#insp-morph')?.disabled;
  // Mid-wave the button stays LIVE (the sheet is a planning view) but says so,
  // and every card in it is aria-disabled. A disabled button would hide its own
  // explanation, since Chrome fires no mouse events on one.
  g.state.phase = 'combat';
  g.selectTower(nt.id);
  out.combatMorphBtnLive = !document.querySelector('#insp-morph')?.disabled;
  out.combatMorphTitle = document.querySelector('#insp-morph')?.getAttribute('title');
  g.hud.inspector.showMorph(nt);
  g.hud.inspector.tick();
  out.combatCardsBlocked = [...document.querySelectorAll('[data-morph]')]
    .every((b) => b.getAttribute('aria-disabled') === 'true');
  g.state.phase = 'prep';

  // --- 6. the sheet still works after a wave of towers exist --------------
  g.selectTower(nt.id);
  g.hud.inspector.showMorph(nt);
  g.hud.inspector.tick();
  out.tickSurvived = document.querySelectorAll('#inspector [data-morph]').length > 0;

  return out;
});

// The sticky comparison strip, driven by a REAL pointer: the whole reason 20
// cards are tractable is that one number tracks the cursor, and that number is
// written by a delegated pointerover listener that a synthetic call would not
// exercise.
const hover = await page.evaluate(() => {
  const g = window.__game;
  g.state.phase = 'prep';
  g.state.gold = 99999;
  const t = g.towers.towers.find((x) => x.def.kind === 'dual' && x.def.key !== 'poison')
         ?? g.towers.towers.find((x) => x.def.kind === 'pure');
  g.selectTower(t.id);
  g.hud.inspector.showMorph(t);
  const cards = [...document.querySelectorAll('[data-morph]')];
  const pick = cards[cards.length - 1];
  pick.scrollIntoView({ block: 'center' });   // the sheet scrolls; the last card starts below the fold
  const b = pick.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, key: pick.dataset.morph, dps: pick.dataset.dps };
});
await page.mouse.move(hover.x, hover.y);
await page.waitForTimeout(120);
const strip = await page.evaluate(([x, y]) => {
  const n = document.querySelector('.mc-next');
  const at = document.elementFromPoint(x, y);
  return { text: n.textContent.replace(/\s/g, ' '), cls: n.className,
           at: at ? `${at.tagName}.${at.className}` : 'null' };
}, [hover.x, hover.y]);

console.log('\nmorph — the sticky comparison strip');
ok(strip.text !== '—', `hovering a card writes its effective DPS into the strip (${strip.text}, cursor over ${strip.at})`);
ok(/up|down/.test(strip.cls), `the strip is coloured against the current tower (${strip.cls})`);

console.log('\nmorph — cost table (spec B.3)');
eq(r.costs.darkness2_to_poison, 1120, 'Darkness Lv2 -> Poison = 1120');
eq(r.costs.fire3_to_vapor, 812, 'Fire Lv3 -> Vapor = 812');
eq(r.costs.fire1_to_water1, 14, 'Fire Lv1 -> Water Lv1 = 14');
eq(r.costs.vapor1_to_howitzer, 101, 'Vapor Lv1 -> Howitzer Lv1 = 101');
eq(r.costs.vapor2_to_trickery, 310, 'Vapor Lv2 -> Trickery Lv2 = 310');
eq(r.costs.howitzer2_to_nature, 0, 'Howitzer Lv2 -> Nature = 0 (floor)');
eq(r.costs.fire3_to_light, 91, 'Fire Lv3 -> Light Lv3 = 91');
eq(r.taxLadder.join(','), '310,465,620,775,930,930', 'tax ladder 310/465/620/775/930, capped');

console.log('\nmorph — the price you see is the price you pay');
eq(r.printedPrice, '1 120', 'card prints 1 120 for Darkness Lv2 -> Poison');
eq(r.debited, 1120, 'exactly 1 120 debited');
eq(r.printedLevel, 'Lv 2', 'card prints the level it lands at');
eq(r.freeCard, 'Free', 'down-morph card prints Free');
ok(r.freeMarked, 'down-morph card carries .morph-loss');
ok(/walk away from/.test(r.freeTitle ?? ''), 'down-morph title names the forfeited refund');

console.log('\nmorph — sheet contents');
ok(r.sheetOpen, 'the sheet renders');
eq(r.cardCount, 20, '20 cards (6 pures + 15 fusions - self)');
ok(r.selfExcluded, "the source's own key is not offered");
ok(r.primalExcluded, 'no primal target');
ok(r.foundationExcluded, 'no foundation target');

console.log('\nmorph — identity and the grid');
ok(r.morphed, 'morphTower returned true');
eq(r.newKey, 'poison', 'the tile is now a Poison tower');
ok(r.samePos, 'same anchor cell');
eq(r.newLevel, 1, 'kept level 2 (index 1)');
eq(r.mode, 'strong', 'targeting mode carried over');
eq(r.totalDamage, 4242, 'damage record carried over');
eq(r.kills, 17, 'kill record carried over');
eq(r.morphCount, 1, 'morphCount incremented');
ok(r.oldGone, 'the old tower object is gone');
ok(r.gridIdentical, 'grid.cells bit-for-bit identical across the morph');
ok(r.towerIdAtCell, 'grid.towerId points at the new tower');
eq(r.rebuilds, 0, 'path.rebuild() was NOT called');
ok(r.inspectorRepointed, 'the inspector re-points at the new tower object');
eq(r.secondCost, Math.round(r.secondUntaxed * 1.5), 'the second morph of a tile is taxed 50%');

console.log('\nmorph — gating');
ok(r.refusedInCombat === false, 'refused during combat');
ok(r.refusedPrimalSource === false, 'refused: primal source');
ok(r.refusedPrimalTarget === false, 'refused: primal target');
ok(r.refusedFoundationTarget === false, 'refused: foundation target');
ok(r.refusedSelf === false, 'refused: same key');
ok(r.refusedInertSource === false, 'refused: foundation source');
ok(r.refusedLocked === false, 'refused: target not unlocked');
ok(!r.lockedTargets.includes('well'), 'morphTargets excludes unbound fusions');
ok(!r.lockedTargets.some((k) => k.startsWith('primal_')), 'morphTargets excludes primals even at 3 stacks');
ok(r.refusedPoor === false, 'refused: not enough gold');
ok(r.goldUntouchedByRefusals, 'no refusal moved gold');

console.log('\nmorph — the button');
ok(r.morphBtn, 'Morph button exists in the default panel');
ok(r.morphBtnEnabled, 'enabled during prep on a dual');
ok(r.primalMorphBtnDisabled, 'disabled on a primal');
ok(r.combatMorphBtnLive, 'still clickable during combat (the sheet is a planning view)');
ok(/between waves/.test(r.combatMorphTitle ?? ''), 'and its tooltip names the restriction');
ok(r.combatCardsBlocked, 'every card is aria-disabled during combat');
ok(r.tickSurvived, 'tick() over the sheet does not blow it away');

await browser.close();
vite.kill('SIGTERM');
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
