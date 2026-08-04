import { chromium } from 'playwright';
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const log = (...a) => console.log(...a);
const b = await chromium.launch({ args: ARGS });
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://localhost:5273/?q=ultra');
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.waitForTimeout(1000);

// pick an element for real: click the first picker card
const picked = await page.evaluate(() => {
  const c = document.querySelector('#picker .pc-card, #picker button');
  if (!c) return 'no card';
  c.click(); return c.className;
});
await page.waitForTimeout(700);
log('picked', picked, 'phase=', await page.evaluate(() => window.__game.state.phase));

// place a tower straight through the API so the test does not depend on projection
const placed = await page.evaluate(() => {
  const g = window.__game;
  g.state.gold = 99999;
  g.setBuildSelection('fire');
  // find a valid cell by scanning
  for (let c = 0; c < g.grid.cols - 1; c++) {
    for (let r = 0; r < g.grid.rows - 1; r++) {
      if (g.placementReason(c, r) === 'valid') { g.buildAt?.(c, r); return { c, r, n: g.towers.towers.length }; }
    }
  }
  return null;
});
log('placed', JSON.stringify(placed), 'towers=', await page.evaluate(() => window.__game.towers.towers.length));

const st = () => page.evaluate(() => ({ build: window.__game.selectedBuild, tower: window.__game.selectedTower, insp: document.getElementById('inspector')?.classList.contains('open') }));

// select via API then right-click on the canvas
await page.evaluate(() => { window.__game.setBuildSelection(null); window.__game.selectTower(0); });
await page.waitForTimeout(200);
log('tower selected  :', JSON.stringify(await st()));
await page.mouse.move(1200, 200);       // canvas, far from the board & panels
await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
log('after right tap :', JSON.stringify(await st()));

// two-step: build armed AND tower selected -> one right-click drops only the build
await page.evaluate(() => { window.__game.selectTower(0); window.__game.setBuildSelection('fire'); });
await page.waitForTimeout(150);
log('both armed      :', JSON.stringify(await st()));
await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
log('after rtap 1    :', JSON.stringify(await st()));
await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
log('after rtap 2    :', JSON.stringify(await st()));

// ---- inventory every kbd badge on screen -------------------------------
const badges = await page.evaluate(() => {
  const out = [];
  for (const k of document.querySelectorAll('kbd')) {
    const host = k.closest('button, li, [id]');
    const r = k.getBoundingClientRect();
    const cs = getComputedStyle(k);
    out.push({
      text: k.textContent,
      host: host?.id || host?.className || host?.tagName,
      w: Math.round(r.width), h: Math.round(r.height),
      vis: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden',
      clipped: (() => { const p = k.parentElement?.getBoundingClientRect(); return p ? (r.right > p.right + 0.6 || r.left < p.left - 0.6) : false; })(),
    });
  }
  return out;
});
log('--- kbd badges (game HUD, sheet closed) ---');
for (const x of badges) log('  ', JSON.stringify(x));

// open the sheet, list the rows
await page.keyboard.press('KeyH');
await page.waitForTimeout(400);
const rows = await page.evaluate(() => [...document.querySelectorAll('#help .help-group')].map((g) => ({
  title: g.querySelector('.legend')?.textContent,
  rows: [...g.querySelectorAll('li')].map((li) => ({
    keys: [...li.querySelectorAll('kbd')].map((k) => k.textContent),
    label: li.querySelector('.hk-label')?.childNodes[0]?.textContent?.trim(),
    note: li.querySelector('.hk-label i')?.textContent,
    twoLine: li.getBoundingClientRect().height > 40,
  })),
})));
log('--- help sheet ---');
log(JSON.stringify(rows, null, 1));

// focus ring while the sheet is open
const tabs = [];
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('Tab');
  tabs.push(await page.evaluate(() => {
    const a = document.activeElement;
    const r = a?.getBoundingClientRect();
    return { id: a?.id, cls: a?.className, txt: (a?.textContent || '').trim().slice(0, 24), inHelp: !!a?.closest('#help'), y: Math.round(r?.top ?? -1) };
  }));
}
log('--- Tab ring while the sheet is open ---');
for (const t of tabs) log('  ', JSON.stringify(t));

// sheet geometry
log('sheet box:', JSON.stringify(await page.evaluate(() => {
  const s = document.querySelector('.help-sheet').getBoundingClientRect();
  return { w: Math.round(s.width), h: Math.round(s.height), top: Math.round(s.top), bottom: Math.round(s.bottom),
    scrollH: document.querySelector('.help-sheet').scrollHeight, clientH: document.querySelector('.help-sheet').clientHeight };
})));
await page.screenshot({ path: 'shots/rv-help-1440.png' });

// narrow viewport
await page.setViewportSize({ width: 1280, height: 720 });
await page.waitForTimeout(500);
await page.screenshot({ path: 'shots/rv-help-1280.png' });
log('sheet box @1280:', JSON.stringify(await page.evaluate(() => {
  const el = document.querySelector('.help-sheet'); const s = el.getBoundingClientRect();
  return { w: Math.round(s.width), h: Math.round(s.height), top: Math.round(s.top), scrollH: el.scrollHeight, clientH: el.clientHeight, cols: getComputedStyle(document.querySelector('.help-cols')).gridTemplateColumns };
})));

log('--- errors ---', JSON.stringify(errs));
await b.close();
