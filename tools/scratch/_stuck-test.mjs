/**
 * Regression test for "creeps get stuck".
 *
 * 1. Building a tower on top of a walking creep must be refused.
 * 2. A creep that is somehow already inside a wall must walk itself back out.
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:5275/';

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader','--mute-audio','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--disable-frame-rate-limit','--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${URL}?q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const res = {};

  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0;
  g.state.gold = 999999;
  g.hud.closeElementPicker();
  g.state.phase = 'combat';
  g.hud.refreshBuildBar();
  g.waves.start(1);
  await wait(2500);

  const cr = g.creeps;
  const live = [];
  for (let n = 0; n < cr._liveCount; n++) {
    const i = cr._live[n];
    if (cr.alive[i] && !cr.flying[i]) live.push(i);
  }
  res.liveAfterSpawn = live.length;
  if (!live.length) return res;

  // --- 1. refuse a tower on a creep -----------------------------------------
  // Find a live creep whose cell sits inside a legal 2x2 anchor.
  let i = -1, anchor = null;
  for (const k of live) {
    const a = g.grid.worldToTowerAnchor(cr.x[k], cr.z[k], {});
    if (g.grid.canPlaceTower(a.c, a.r)) { i = k; anchor = a; break; }
  }
  if (!anchor && live.length) {
    // Still in the unbuildable spawn lane: walk one out to open ground.
    i = live[0];
    for (let r = 5; r < g.grid.rows - 5 && !anchor; r++) {
      for (let c = 3; c < g.grid.cols - 5; c++) {
        if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) {
          const w = g.grid.cellToWorld(c, r, {});
          cr.x[i] = w.x; cr.z[i] = w.z;
          anchor = { c, r };
          break;
        }
      }
    }
  }
  res.foundAnchor = !!anchor;
  if (anchor) {
    const cell = g.grid.worldToCell(cr.x[i], cr.z[i], {});
    res.reason = g.placementReason(anchor.c, anchor.r);
    res.built = g.build('fire', anchor.c, anchor.r);
    res.stillWalkable = g.grid.isWalkable(cell.c, cell.r);
  }

  // --- 2. a creep already inside a wall walks out ----------------------------
  // Teleport one onto an existing tower's footprint (or stamp one far from it).
  const j = live[live.length - 1];
  const free = [];
  for (let r = 4; r < g.grid.rows - 4 && free.length < 1; r++) {
    for (let c = 2; c < g.grid.cols - 4; c++) {
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)
          && !g.creeps.blockedByFootprint(c, r)) { free.push([c, r]); break; }
    }
  }
  if (!free.length) { res.trapSkipped = true; return res; }
  const [tc, tr] = free[0];
  g.build('water', tc, tr);
  const w = g.grid.cellToWorld(tc, tr, {});
  cr.x[j] = w.x; cr.z[j] = w.z; cr.vx[j] = 0; cr.vz[j] = 0;
  const before = g.grid.worldToCell(cr.x[j], cr.z[j], {});
  res.trappedIn = !g.grid.isWalkable(before.c, before.r);
  await wait(1500);
  const after = g.grid.worldToCell(cr.x[j], cr.z[j], {});
  res.escaped = !cr.alive[j] || g.grid.isWalkable(after.c, after.r);
  res.movedBy = Math.hypot(cr.x[j] - w.x, cr.z[j] - w.z).toFixed(2);
  return res;
});

console.log(JSON.stringify(out, null, 2));
if (errs.length) console.log('PAGE ERRORS:', errs.slice(0, 5));
await browser.close();
