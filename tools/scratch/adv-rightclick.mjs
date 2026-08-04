/**
 * ADVERSARIAL PROBE — right-click cancel vs. the camera.
 * Throwaway. Prints a JSON report; writes nothing to the repo.
 */
import { chromium } from 'playwright';

const OUT = process.env.OUT || '/private/tmp/claude-501/-Users-pouetpouets/026630db-b7b9-4e91-805a-b7d7caf27667/scratchpad';
const VITE_STUB =
  'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });'
  + 'export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;'
  + 'export const createHotContextLegacy = () => ({ accept(){}, dispose(){}, invalidate(){}, on(){}, send(){} });';

const log = (...a) => console.log(...a);

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });

await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await page.evaluate(() => document.getElementById('boot')?.remove());

// bind fire + freeze
await page.evaluate(() => {
  const g = window.__game;
  g.state.pendingElementPicks = 1; g.chooseElement('fire');
  g.state.pendingElementPicks = 1; g.chooseElement('water');
  g.state.gold = 5000; g.hud._goldShown = 5000;
  g.state.paused = true;
  g.hud.refreshTop(); g.hud.refreshBuildBar();
});
await page.waitForFunction(() => !document.getElementById('picker')?.classList.contains('open'));

// Record every contextmenu with its prevented flag + target.
await page.evaluate(() => {
  window.__menus = [];
  document.addEventListener('contextmenu', (e) => {
    // run last: queue a microtask-free read at the end of dispatch
    setTimeout(() => window.__menus.push({
      prevented: e.defaultPrevented,
      target: e.target?.id || e.target?.className || e.target?.tagName,
    }), 0);
  });
});

const aim = () => page.evaluate(() => {
  const r = window.__game.rig || window.__game.camera?.userData?.rig;
  const rig = window.__game.rig ?? window.__game.cameraRig ?? null;
  const R = rig || r;
  return R ? {
    azGoal: R._azimuthGoal, poGoal: R._polarGoal, distGoal: R._distGoal,
    az: R.azimuth, po: R.polar, dist: R.dist,
    tx: R._targetGoal.x, tz: R._targetGoal.z,
  } : null;
});

const rigName = await page.evaluate(() => {
  const g = window.__game;
  return Object.keys(g).filter((k) => g[k] && typeof g[k] === 'object' && '_azimuthGoal' in g[k]);
});
log('rig field:', JSON.stringify(rigName));

const report = { errors, steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); log('\n##', name, JSON.stringify(data, null, 1)); };

const centre = { x: 800, y: 420 };

// ---- 1. right-DRAG orbits, does not cancel -------------------------------
await page.click('#dock-pure .tcard[data-tower="fire"]');
const held0 = await page.evaluate(() => window.__game.selectedBuild);
const a0 = await aim();
await page.mouse.move(centre.x, centre.y);
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 10; i++) await page.mouse.move(centre.x + i * 20, centre.y + i * 6);
await page.mouse.up({ button: 'right' });
const a1 = await aim();
step('right-drag 200x60', {
  held0, heldAfter: await page.evaluate(() => window.__game.selectedBuild),
  dAzGoal: +(a1.azGoal - a0.azGoal).toFixed(5), expectedDAz: -(200 * 0.005),
  dPoGoal: +(a1.poGoal - a0.poGoal).toFixed(5), expectedDPo: -(60 * 0.004),
});

// ---- 2. orbit out and back ------------------------------------------------
const a2 = await aim();
await page.mouse.move(centre.x, centre.y);
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 8; i++) await page.mouse.move(centre.x + i * 21, centre.y);
for (let i = 7; i >= 0; i--) await page.mouse.move(centre.x + i * 21, centre.y);
await page.mouse.up({ button: 'right' });
const a3 = await aim();
step('orbit-and-return', {
  heldAfter: await page.evaluate(() => window.__game.selectedBuild),
  netAz: +(a3.azGoal - a2.azGoal).toFixed(5),
});

// ---- 3. right TAP cancels -------------------------------------------------
const a4 = await aim();
await page.mouse.move(centre.x, centre.y);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
const a5 = await aim();
step('right-tap on canvas', {
  heldAfter: await page.evaluate(() => window.__game.selectedBuild),
  azMoved: +(a5.azGoal - a4.azGoal).toFixed(5),
  towers: await page.evaluate(() => window.__game.towers.towers.length),
});

// ---- 4. right tap over the DOCK ------------------------------------------
await page.click('#dock-pure .tcard[data-tower="fire"]');
const dock = await page.locator('#dock').boundingBox();
await page.mouse.move(dock.x + 20, dock.y + 10);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
step('right-tap on #dock', {
  heldAfter: await page.evaluate(() => window.__game.selectedBuild),
});

// ---- 5. middle-drag pans --------------------------------------------------
const a6 = await aim();
await page.mouse.move(centre.x, centre.y);
await page.mouse.down({ button: 'middle' });
for (let i = 1; i <= 6; i++) await page.mouse.move(centre.x + i * 15, centre.y + i * 5);
await page.mouse.up({ button: 'middle' });
const a7 = await aim();
step('middle-drag pan', { dtx: +(a7.tx - a6.tx).toFixed(4), dtz: +(a7.tz - a6.tz).toFixed(4) });

// ---- 6. wheel zoom --------------------------------------------------------
const a8 = await aim();
await page.mouse.move(centre.x, centre.y);
await page.mouse.wheel(0, -240);
const a9 = await aim();
step('wheel zoom', { dDist: +(a9.distGoal - a8.distGoal).toFixed(4) });

// ---- 7. shift + left-drag orbits, builds nothing --------------------------
const t0 = await page.evaluate(() => window.__game.towers.towers.length);
await page.evaluate(() => window.__game.setBuildSelection('fire'));
const a10 = await aim();
await page.keyboard.down('Shift');
await page.mouse.move(centre.x, centre.y);
await page.mouse.down({ button: 'left' });
for (let i = 1; i <= 8; i++) await page.mouse.move(centre.x + i * 18, centre.y);
await page.mouse.up({ button: 'left' });
await page.keyboard.up('Shift');
const a11 = await aim();
step('shift+left-drag', {
  dAz: +(a11.azGoal - a10.azGoal).toFixed(5),
  towersBefore: t0, towersAfter: await page.evaluate(() => window.__game.towers.towers.length),
  heldAfter: await page.evaluate(() => window.__game.selectedBuild),
});

// ---- 8. context menus -----------------------------------------------------
// canvas / dock / topbar / help veil / a live <input>
await page.evaluate(() => { window.__menus = []; });
await page.mouse.move(centre.x, centre.y); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
await page.mouse.move(dock.x + 20, dock.y + 10); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
const hb = await page.locator('#help-btn').boundingBox();
await page.mouse.move(hb.x + 5, hb.y + 5); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
// help sheet open -> veil
await page.keyboard.press('KeyH');
await page.waitForTimeout(250);
await page.mouse.move(centre.x, centre.y); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
const helpStillOpen = await page.evaluate(() => document.getElementById('help').classList.contains('open'));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
// a real input
await page.evaluate(() => {
  const i = document.createElement('input');
  i.id = 'probe-input'; i.style.cssText = 'position:fixed;top:200px;left:200px;z-index:9999;width:200px;height:30px';
  document.body.appendChild(i);
});
await page.mouse.move(240, 210); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
step('contextmenu prevented?', { menus: await page.evaluate(() => window.__menus), helpStillOpenAfterRightClick: helpStillOpen });

// ---- 9. right-click while HOLDING, with help sheet open -------------------
await page.evaluate(() => { window.__game.setBuildSelection('fire'); window.__game.hud.setHelp(true); });
await page.waitForTimeout(250);
await page.mouse.move(centre.x, centre.y); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
step('right-tap through the help veil', {
  heldAfter: await page.evaluate(() => window.__game.selectedBuild),
  helpOpen: await page.evaluate(() => document.getElementById('help').classList.contains('open')),
});
await page.evaluate(() => window.__game.hud.setHelp(false));

// ---- 10. spectating -------------------------------------------------------
await page.evaluate(() => { window.__game.setBuildSelection('fire'); });
const specSet = await page.evaluate(() => {
  const g = window.__game;
  g.spectating = { fake: true };
  return !!g.spectating;
});
await page.mouse.move(centre.x, centre.y); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
const a12 = await aim();
await page.mouse.move(centre.x, centre.y);
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 8; i++) await page.mouse.move(centre.x + i * 18, centre.y);
await page.mouse.up({ button: 'right' });
const a13 = await aim();
step('spectating', {
  specSet,
  heldAfterTap: await page.evaluate(() => window.__game.selectedBuild),
  orbitStillWorks: +(a13.azGoal - a12.azGoal).toFixed(5),
});
await page.evaluate(() => { window.__game.spectating = null; });

// ---- 11. pointercancel hygiene: right-down then a LEFT click --------------
await page.evaluate(() => { window.__game.setBuildSelection('fire'); });
await page.mouse.move(centre.x, centre.y);
await page.mouse.down({ button: 'right' });
await page.evaluate(() => {
  // simulate the browser cancelling the gesture (drag out of window)
  document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
});
await page.mouse.up({ button: 'right' });
step('pointercancel then up', { heldAfter: await page.evaluate(() => window.__game.selectedBuild) });

log('\n=== ERRORS ===', JSON.stringify(errors, null, 1));
await page.screenshot({ path: `${OUT}/adv-rightclick-final.png` });
await browser.close();
