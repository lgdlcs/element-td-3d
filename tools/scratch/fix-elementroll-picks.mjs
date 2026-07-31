/**
 * REGRESSION: the element offer must be a function of (seed, pickIndex, picks)
 * and of NOTHING ELSE — in particular not of what the player has built.
 *
 * rollElementChoices used to count state.elements, which is a SPENDABLE pool:
 * building a primal removes PRIMAL.stacksConsumed copies. So the element fell
 * out of the `spare` bucket (n >= stacksRequired) back into `echo`
 * (1 <= n < stacksRequired) and displaced a fresh element from the offer. Two
 * players in the same room with identical picks saw different cards purely
 * because one of them had placed a tower — the exact opposite of what the
 * docblock promises. It now counts state.picks, the append-only ledger.
 *
 * Usage: node tools/scratch/fix-elementroll-picks.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5291';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const errs = [];
const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.state, null, { timeout: 60000 });
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const g = window.__game;
  const R = {};
  const roll = () => g.rollElementChoices().map((e) => e.id);

  // Three picks of one element: the primal is unlocked and `fire` sits in the
  // `spare` bucket, which is the state the bug needed.
  g.state.pendingElementPicks = 3;
  g.chooseElement('fire');
  g.chooseElement('fire');
  g.chooseElement('fire');
  R.seed = g.seed;
  R.pickIndex = g.state.pickIndex;
  R.offerBeforeBuild = roll();

  // Find any anchor that accepts the primal.
  g.state.gold = 900000;
  let anchor = null;
  for (let c = 2; c < 40 && !anchor; c += 2) {
    for (let r = 2; r < 40; r += 2) {
      if (g.build('primal_fire', c, r)) { anchor = { c, r }; break; }
    }
  }
  R.anchor = anchor;
  if (!anchor) return R;

  const built = g.towers.towers[g.towers.towers.length - 1];
  R.afterBuild = {
    elements: [...g.state.elements],       // spent: one fire left
    picks: [...g.state.picks],             // untouched: three fire
    pickIndex: g.state.pickIndex,
    offer: roll(),
  };

  g.sellTower(built.id);
  R.afterSell = {
    elements: [...g.state.elements],
    picks: [...g.state.picks],
    offer: roll(),
  };

  // Sanity in the other direction: the offer must still MOVE when a real pick
  // is committed, otherwise this test would pass on a constant.
  g.state.pendingElementPicks = 1;
  g.chooseElement('water');
  R.offerAfterNewPick = roll();

  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  R.invariantToBuild = same(R.offerBeforeBuild, R.afterBuild.offer);
  R.invariantToSell = same(R.offerBeforeBuild, R.afterSell.offer);
  R.picksUnchangedByBuild = same(R.afterBuild.picks, ['fire', 'fire', 'fire']);
  R.elementsSpentByBuild = R.afterBuild.elements.filter((e) => e === 'fire').length === 1;
  R.offerMovesOnPick = !same(R.offerBeforeBuild, R.offerAfterNewPick)
    || R.pickIndex !== g.state.pickIndex;
  return R;
});

console.log(JSON.stringify(out, null, 2));
console.log('console_errors:', JSON.stringify(errs));
const pass = out.invariantToBuild && out.invariantToSell && out.picksUnchangedByBuild
  && out.elementsSpentByBuild && out.offerMovesOnPick && errs.length === 0;
console.log('VERDICT:', pass ? 'PASS' : 'FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
