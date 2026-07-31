/**
 * SCENARIO 2b - the per-tile morph tax, on a price that is not floored at zero.
 *
 * v2-morph's second morph was a down-morph (dual -> pure), which the documented
 * floor prices at 0, so the 1.5x factor was multiplying nothing and the tax went
 * unverified. Here two IDENTICAL towers are morphed into the same target, one
 * with morphCount 0 and one with morphCount 1, and the two quotes are compared.
 *
 * Usage: node tools/scratch/v2b-morphtax.mjs [baseUrl]
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

log('taxCheck', await page.evaluate(async () => {
  const g = window.__game;
  const { ECONOMY } = await import('/src/core/Config.js');
  g.state.pendingElementPicks = 2;
  g.chooseElement('fire'); g.chooseElement('water');
  g.state.gold = 500000; g.state.lives = 99999;
  g.state.phase = 'prep'; g.state.prepTimer = 9999;

  // Two identical pure-fire towers on two free tiles.
  const tiles = [];
  for (let c = 2; c < g.grid.cols - 3 && tiles.length < 2; c += 3) {
    for (let r = 2; r < g.grid.rows - 3 && tiles.length < 2; r += 3) {
      if (g.placementReason(c, r) === 'valid' && g.build('fire', c, r)) tiles.push({ c, r });
    }
  }
  if (tiles.length < 2) throw new Error('need two free tiles');
  const at = ({ c, r }) => g.towers.towers.find((t) => t.c === c && t.r === r);

  // Tower B is taxed by being morphed once first: fire -> water -> (quote vapor).
  const virgin = at(tiles[0]);
  const taxed = at(tiles[1]);
  g.morphTower(taxed.id, 'water');
  const taxedNow = at(tiles[1]);
  // Put it back on fire so both towers are the SAME source def at quote time.
  g.morphTower(taxedNow.id, 'fire');
  const taxed2 = at(tiles[1]);

  const qVirgin = g.morphCost(virgin, 'vapor');
  const qTaxed = g.morphCost(taxed2, 'vapor');
  const factor = 1 + ECONOMY.morphTax * Math.min(taxed2.morphCount, ECONOMY.morphTaxCap);
  return {
    virgin: { key: virgin.key, level: virgin.level, morphCount: virgin.morphCount ?? 0, quoteVapor: qVirgin },
    taxed: { key: taxed2.key, level: taxed2.level, morphCount: taxed2.morphCount, quoteVapor: qTaxed },
    expectedFactor: factor,
    observedFactor: +(qTaxed / qVirgin).toFixed(3),
    matches: qTaxed === Math.max(0, Math.round(
      (qVirgin / (1 + ECONOMY.morphTax * (virgin.morphCount ?? 0))) * factor)),
  };
}));

log('errors', errors);
await browser.close();
