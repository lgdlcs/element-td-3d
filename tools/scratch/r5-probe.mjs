import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await page.waitForTimeout(2500);
const r = await page.evaluate(() => {
  const a = window.__game.arena;
  const out = {};
  const rim = a.rim;
  const br = rim.geometry.getAttribute('aBreach');
  let mx = 0, nHot = 0;
  for (let i = 0; i < br.count; i++) { const v = br.getX(i); if (v > mx) mx = v; if (v > 0.5) nHot++; }
  out.rimVerts = br.count;
  out.breachMax = +mx.toFixed(3);
  out.breachVertsAbove50pct = nHot;
  out.breachFrac = +(nHot / br.count).toFixed(3);
  const cs = a.contactShadow;
  out.contactShadow = !!cs && cs.visible;
  out.contactTris = cs ? cs.geometry.index.count / 3 : 0;
  out.contactPremul = cs ? cs.material.premultipliedAlpha : null;
  out.tufts = a.tufts.count;
  // rune band live fraction
  const band = a.group.children.find((o) => o.name === 'rimRunes');
  const lv = band?.geometry.getAttribute('aLive');
  let live = 0; if (lv) for (let i = 0; i < lv.count; i++) if (lv.getX(i) > 0.05) live++;
  out.runeLiveFrac = lv ? +(live / lv.count).toFixed(3) : null;
  // breach field sanity, sampled on the wall line
  out.breachSamplesN = [-20,-15.5,-8,0,8,12.8,20].map((x) => +a.breachAt(x, -20.45).toFixed(2));
  // geometry: min Y of coping vertices inside vs outside a breach
  const pos = rim.geometry.getAttribute('position');
  const cop = rim.geometry.getAttribute('aCoping');
  let topBreach = -99, topSolid = -99;
  for (let i = 0; i < pos.count; i++) {
    if (cop.getX(i) < 0.5) continue;
    const y = pos.getY(i);
    if (br.getX(i) > 0.85) topBreach = Math.max(topBreach, y);
    if (br.getX(i) < 0.02) topSolid = Math.max(topSolid, y);
  }
  out.copingTopSolid = +topSolid.toFixed(3);
  out.copingTopInBreach = +topBreach.toFixed(3);
  out.plateauTop = a.plateauTop; out.laneFloor = a.laneFloor;
  // footprint check: max |x|,|z| of the rim
  let mxx = 0, mzz = 0;
  for (let i = 0; i < pos.count; i++) { mxx = Math.max(mxx, Math.abs(pos.getX(i))); mzz = Math.max(mzz, Math.abs(pos.getZ(i))); }
  out.rimMaxX = +mxx.toFixed(3); out.rimMaxZ = +mzz.toFixed(3);
  return out;
});
console.log(JSON.stringify(r, null, 1));
console.log('errors', logs.filter((l) => /error/.test(l)).slice(0,5));
await browser.close();
