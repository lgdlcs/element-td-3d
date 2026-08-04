/**
 * Adversarial review probe — feature 6 (right-click cancels).
 * Throwaway. Does not touch src/.
 */
import { chromium } from 'playwright';

const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--mute-audio', '--hide-scrollbars'];

const log = (...a) => console.log(...a);

const b = await chromium.launch({ args: ARGS });
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto('http://localhost:5273/?q=ultra');
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.waitForTimeout(1200);

// instrument contextmenu at document level so we can see defaultPrevented
await page.evaluate(() => {
  window.__ctx = [];
  document.addEventListener('contextmenu', (e) => {
    window.__ctx.push({ tag: e.target?.id || e.target?.className || e.target?.tagName, prevented: e.defaultPrevented });
  }, false);
});

const st = () => page.evaluate(() => ({
  build: window.__game.selectedBuild,
  tower: window.__game.selectedTower,
  phase: window.__game.state.phase,
  spect: !!window.__game.spectating,
  hintOn: document.getElementById('held-piece')?.classList.contains('on'),
  gridVis: !!window.__game.arena?.gridVisible,
}));

const cam = () => page.evaluate(() => {
  const r = window.__game.rig;
  return { az: r._azimuthGoal, po: r._polarGoal, dist: r._distGoal, tx: r._targetGoal.x, tz: r._targetGoal.z };
});

log('--- initial ---', JSON.stringify(await st()));

// ---------------------------------------------------------------- A: cancel build
await page.evaluate(() => window.__game.setBuildSelection('fire'));
log('A after select :', JSON.stringify(await st()));
const cx = 720, cy = 480;
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(120);
log('A after rclick :', JSON.stringify(await st()));

// ---------------------------------------------------------------- B: cancel tower selection
await page.evaluate(() => {
  const g = window.__game;
  g.state.gold = 9999;
  g.setBuildSelection('fire');
});
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
log('B after build :', JSON.stringify(await st()), 'towers=', await page.evaluate(() => window.__game.towers.towers.length));
// select it
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(200);
log('B after click :', JSON.stringify(await st()));
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(150);
log('B after rclick:', JSON.stringify(await st()));

// ---------------------------------------------------------------- C: orbit still works
const c0 = await cam();
await page.mouse.move(600, 500);
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 10; i++) await page.mouse.move(600 + i * 12, 500 + i * 3);
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(150);
const c1 = await cam();
log('C orbit  d-az=', (c1.az - c0.az).toFixed(4), ' d-po=', (c1.po - c0.po).toFixed(4));
log('C expected d-az=', (-120 * 0.005).toFixed(4), ' d-po=', (-30 * 0.004).toFixed(4));

// ---------------------------------------------------------------- D: orbit that RETURNS to origin
await page.evaluate(() => window.__game.setBuildSelection('fire'));
log('D armed       :', JSON.stringify(await st()));
const d0 = await cam();
await page.mouse.move(700, 500);
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 12; i++) await page.mouse.move(700 + Math.round(Math.sin(i / 12 * Math.PI) * 140), 500);
await page.mouse.move(700, 500);            // back to the start pixel
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(150);
const d1 = await cam();
log('D after loop  :', JSON.stringify(await st()), ' d-az=', (d1.az - d0.az).toFixed(4));

// ---------------------------------------------------------------- E: right-click over HUD surfaces
await page.evaluate(() => { window.__ctx = []; });
const probes = await page.evaluate(() => {
  const out = [];
  const add = (label, sel) => {
    const n = document.querySelector(sel);
    if (!n) { out.push({ label, missing: true }); return; }
    const r = n.getBoundingClientRect();
    if (!r.width) { out.push({ label, hidden: true }); return; }
    out.push({ label, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  };
  add('dock', '#dock');
  add('topbar-btn', '#pause-btn');
  add('threat', '#threat');
  add('canvas', '#viewport');
  return out;
});
for (const p of probes) {
  if (p.missing || p.hidden) { log('E probe', p.label, 'unavailable'); continue; }
  await page.evaluate(() => window.__ctx = []);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(60);
  const ctx = await page.evaluate(() => window.__ctx);
  log('E contextmenu on', p.label, JSON.stringify(ctx));
}

// ---------------------------------------------------------------- F: right-click on the help sheet veil
await page.keyboard.press('KeyH');
await page.waitForTimeout(400);
const helpOpen = await page.evaluate(() => document.getElementById('help').classList.contains('open'));
log('F help open   :', helpOpen);
await page.evaluate(() => { window.__ctx = []; });
await page.evaluate(() => window.__game.setBuildSelection('fire'));
await page.mouse.move(120, 820);   // bottom-left, over the veil, away from the sheet
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(150);
log('F ctx on veil :', JSON.stringify(await page.evaluate(() => window.__ctx)), JSON.stringify(await st()),
  'helpStillOpen=', await page.evaluate(() => document.getElementById('help').classList.contains('open')));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ---------------------------------------------------------------- G: middle-drag pan + wheel zoom
const g0 = await cam();
await page.mouse.move(700, 500);
await page.mouse.down({ button: 'middle' });
for (let i = 1; i <= 8; i++) await page.mouse.move(700 - i * 10, 500);
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(120);
const g1 = await cam();
log('G pan  dtx=', (g1.tx - g0.tx).toFixed(3), 'dtz=', (g1.tz - g0.tz).toFixed(3));
const z0 = await cam();
await page.mouse.move(700, 500);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(120);
const z1 = await cam();
log('G zoom dist', z0.dist.toFixed(2), '->', z1.dist.toFixed(2));

// shift+left drag orbit
await page.evaluate(() => window.__game.setBuildSelection('fire'));
const s0 = await cam();
await page.keyboard.down('Shift');
await page.mouse.move(700, 500);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(700 + i * 10, 500);
await page.mouse.up();
await page.keyboard.up('Shift');
await page.waitForTimeout(120);
const s1 = await cam();
log('G shift-orbit d-az=', (s1.az - s0.az).toFixed(4), JSON.stringify(await st()));

// ---------------------------------------------------------------- H: spectating
await page.evaluate(() => { window.__game.spectating = true; window.__game.setBuildSelection('fire'); });
log('H armed while spectating:', JSON.stringify(await st()));
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(120);
log('H after rclick          :', JSON.stringify(await st()));
await page.evaluate(() => { window.__game.spectating = false; });

// ---------------------------------------------------------------- I: pointercancel / stale down point
await page.evaluate(() => window.__game.setBuildSelection('fire'));
await page.mouse.move(500, 400);
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 15; i++) await page.mouse.move(500 + i * 20, 400);   // 300px away
// release far away: must NOT cancel
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(120);
log('I far release keeps build:', JSON.stringify(await st()));

log('--- page errors ---', JSON.stringify(errs, null, 1));
await b.close();
