/**
 * Focused check: do crits and the buffed slows actually land in the simulation?
 *
 * Wave 1 dies too fast to observe anything, so this runs mid-game waves against
 * a handful of water towers — creeps survive long enough to be measured. The
 * crit path is proven twice: once at the shipped 18%, and once forced to 100% so
 * the multiplier and the float text are unambiguous.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5275';
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 30000 });
await page.waitForTimeout(1000);

const out = await page.evaluate(async () => {
  const g = window.__game;
  const cfg = await import('/src/core/Config.js');
  g.chooseElement('water');
  g.state.gold = 500000;

  // Towers have to be ON the route, and the route is generated — so find it by
  // watching where the creeps actually walk rather than guessing coordinates.
  g.state.wave = 0; g.state.phase = 'prep'; g.state.prepTimer = 0; g.state.lives = 5000;
  g.startWaveNow();
  await new Promise((r) => setTimeout(r, 2500));
  const route = [];
  for (let i = 0; i < g.creeps.capacity && route.length < 12; i++) {
    if (g.creeps.alive[i]) route.push({ x: g.creeps.x[i], z: g.creeps.z[i] });
  }
  let built = 0;
  for (const p of route) {
    if (built >= 4) break;
    const a = g.grid.worldToTowerAnchor(p.x, p.z, {});
    for (const [dc, dr] of [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, -3]]) {
      if (built >= 4) break;
      g.state.gold = 500000;
      if (g.build('water', a.c + dc, a.r + dr)) built++;
    }
  }
  for (const t of g.towers.towers) { g.state.gold = 500000; g.upgradeTower(t.id); g.upgradeTower(t.id); }
  // Let wave 1 finish so the runner is idle before the measured waves.
  await new Promise((r) => setTimeout(r, 3000));
  g.creeps.count && [...Array(g.creeps.capacity).keys()].forEach((i) => { if (g.creeps.alive[i]) g.creeps.kill(i, false); });

  const runWave = async (n, ms) => {
    g.state.wave = n - 1;
    g.state.phase = 'prep';
    g.state.prepTimer = 0;
    g.state.lives = 5000;
    g.startWaveNow();
    let maxSlow = 0;
    let crits = 0;
    const seen = new Set();
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const c = g.creeps;
      for (let i = 0; i < c.capacity; i++) if (c.alive[i] && c.slowAmt[i] > maxSlow) maxSlow = c.slowAmt[i];
      for (const el of document.querySelectorAll('.float-text')) {
        if (el.textContent.endsWith('!') && !seen.has(el)) { seen.add(el); crits++; }
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    return { maxSlow: Number(maxSlow.toFixed(3)), crits, spawned: g.waves.spawned, alive: g.creeps.count };
  };

  const natural = await runWave(16, 9000);
  cfg.COMBAT.critChance = 1;
  const forced = await runWave(17, 9000);
  cfg.COMBAT.critChance = 0.18;

  return {
    built, towerLevel: g.towers.towers[0]?.level,
    shippedCrit: { chance: 0.18, mult: cfg.COMBAT.critMult },
    naturalWave: natural,
    forcedCritWave: forced,
    killed: g.state.killed,
  };
});

console.log(JSON.stringify(out, null, 2));
console.log('pageErrors:', JSON.stringify(errors));
await browser.close();
