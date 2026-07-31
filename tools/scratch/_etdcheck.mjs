/**
 * Drives a real run in a real browser and asserts the seven gameplay changes.
 * Usage: node tools/scratch/_etdcheck.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5275';
const URL = `${BASE}/?solo&q=low&server=ws://localhost:5280`;

const errors = [];
const browser = await chromium.launch({
  // Same flags the project's own probes use: without a real GPU path the rAF
  // loop never runs in headless and the simulation sits frozen at boot.
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('crash', () => console.log('!!! page crashed'));

const step = async (name, fn) => {
  try {
    console.log(`${name}: ${JSON.stringify(await fn())}`);
  } catch (err) {
    console.log(`${name}: FAILED ${err.message.split('\n')[0]}`);
  }
};

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 30000 });
await page.waitForTimeout(1200);

await step('schedule', () => page.evaluate(async () => {
  const m = await import('/src/game/Waves.js');
  return [1, 2, 6, 7, 8, 10, 14, 21, 70].map((n) => {
    const d = m.waveDef(n);
    return `w${n} ${d.type} air=${d.isAir} boss=${d.isBoss} prep=${d.prepTime}`;
  });
}));

await step('pick', () => page.evaluate(() => {
  const g = window.__game;
  if (g.state.phase !== 'pickElement') return 'not-picking';
  g.chooseElement('water');
  return g.state.elements;
}));
await page.waitForTimeout(400);

await step('heldChip', () => page.evaluate(async () => {
  window.__game.setBuildSelection('water');
  await new Promise((r) => setTimeout(r, 250));
  const el = document.querySelector('#held-piece');
  return { on: el?.classList.contains('on'), text: el?.textContent.replace(/\s+/g, ' ').trim() };
}));

await step('foundation', () => page.evaluate(() => {
  const g = window.__game;
  g.setBuildSelection(null);
  let placed = null;
  for (let c = 2; c < 20 && !placed; c += 2) {
    for (let r = 2; r < 14 && !placed; r += 2) if (g.build('foundation', c, r)) placed = { c, r };
  }
  if (!placed) return 'no legal placement';
  const t = g.towers.towers[g.towers.towers.length - 1];
  g.selectTower(t.id);
  return { placed, heldFoundation: !!g.heldFoundation, convertCostWater: g.convertCost('water') };
}));
await page.waitForTimeout(350);

await step('dockArming', () => page.evaluate(() => ({
  dockArming: document.querySelector('#dock')?.classList.contains('arming'),
  waterCard: document.querySelector('#dock [data-tower="water"]')?.textContent.replace(/\s+/g, ' ').trim(),
  chip: document.querySelector('#held-piece')?.textContent.replace(/\s+/g, ' ').trim(),
})));

await step('armClick', () => page.evaluate(async () => {
  const g = window.__game;
  const gold = g.state.gold;
  document.querySelector('#dock [data-tower="water"]').click();
  await new Promise((r) => setTimeout(r, 250));
  const t = g.selectedTower !== null ? g.towers.byId(g.selectedTower) : null;
  return {
    nowIs: t?.key, stillInert: t?.def.kind === 'inert',
    spent: gold - g.state.gold, buildQueued: g.selectedBuild,
  };
}));

await step('combat', () => page.evaluate(async () => {
  const [defs, cfg] = await Promise.all([
    import('/src/game/TowerDefs.js'), import('/src/core/Config.js'),
  ]);
  return {
    waterSlow: defs.PURE_TOWERS.water.levels.map((l) => `${l.slow.amt}/${l.slow.dur}s`),
    crit: cfg.COMBAT, armDiscount: cfg.ECONOMY.armDiscount,
  };
}));

// crit + slow are measured in _etdcombat.mjs, which puts towers on the real route.
await step('airAlert', () => page.evaluate(async () => {
  const g = window.__game;
  g.hud.setAirAlert(7);
  await new Promise((r) => setTimeout(r, 250));
  const el = document.querySelector('#air-alert');
  return { on: el.classList.contains('on'), text: el.textContent.replace(/\s+/g, ' ').trim() };
}));

await step('bestLocal', () => page.evaluate(async () => {
  const { saveBest, loadBest } = await import('/src/net/BestScore.js');
  const a = saveBest({ score: 5400, wave: 11, won: false });
  const b = saveBest({ score: 100, wave: 2, won: false });
  window.__game.hud.setBest(loadBest().score);
  return {
    firstIsRecord: a.record, worseIsRecord: b.record, stored: loadBest().score,
    topbar: document.querySelector('#stat-best')?.textContent,
  };
}));

await step('bestServer', () => page.evaluate(async () => {
  const net = window.__net;
  const online = await net.connect();
  if (!online) return { online: false };
  net.hello('CheckBot');
  await new Promise((r) => setTimeout(r, 300));
  net.best({ score: 7777, wave: 21, won: false });
  return await new Promise((resolve) => {
    const fn = (m) => { net.off('leaderboard', fn); resolve({ online: true, top: m.top }); };
    net.on('leaderboard', fn);
    setTimeout(() => resolve({ online: true, top: 'timeout' }), 2500);
  });
}));

await step('endcard', () => page.evaluate(async () => {
  const g = window.__game;
  g.hud.setLeaderboard([{ name: 'CheckBot', score: 7777, wave: 21 }, { name: 'Lucas', score: 5400, wave: 11 }]);
  g.state.score = 9100;
  g.hud.showEnd(false);
  await new Promise((r) => setTimeout(r, 300));
  return {
    best: document.querySelector('.end-best')?.textContent.replace(/\s+/g, ' ').trim(),
    board: document.querySelector('.end-board')?.textContent.replace(/\s+/g, ' ').trim(),
  };
}));

console.log(`consoleErrors: ${JSON.stringify(errors)}`);
await browser.close();
