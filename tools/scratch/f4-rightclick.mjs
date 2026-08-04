#!/usr/bin/env node
/**
 * Throwaway functional check for FEATURE 4 (right-click cancels the selection).
 *
 *   node tools/scratch/f4-rightclick.mjs
 *
 * Everything is driven through page.mouse, i.e. real pointer events on the real
 * canvas, so CameraRig and Game are both live and fighting over the same button
 * exactly as they do in the game. Each case asserts BOTH sides: what was
 * cancelled, and what the camera did.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;',
}));

// A real context menu cannot be observed from Playwright, so we watch for the
// event reaching the document with its default still intact. Installed before
// the page scripts run so it sees everything.
await page.addInitScript(() => {
  window.__ctxDefaults = 0;
  document.addEventListener('contextmenu', (e) => { if (!e.defaultPrevented) window.__ctxDefaults++; }, false);
});

await page.goto('http://localhost:5273/?q=high', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await page.evaluate(() => document.getElementById('boot')?.remove());

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

await page.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0;
  g.state.gold = 999999;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  g.hud.refreshBuildBar();
  await new Promise((r) => setTimeout(r, 300));
});

const read = () => page.evaluate(() => {
  const g = window.__game;
  return {
    build: g.selectedBuild,
    tower: g.selectedTower,
    gridTarget: g.arena._gridTargetOpacity ?? 0,
    range: g.arena.gridMaterial.uniforms.uRange.value,
    hover: g.arena.gridMaterial.uniforms.uHover.value.toArray(),
    hint: (document.getElementById('place-hint')?.className ?? ''),
    inspector: !!document.querySelector('#inspector.is-open, #inspector.open')
      || (document.getElementById('inspector')?.classList.contains('show') ?? false),
    inspectorCls: document.getElementById('inspector')?.className ?? '(none)',
    az: g.rig._azimuthGoal, polar: g.rig._polarGoal,
    tx: g.rig._targetGoal.x, tz: g.rig._targetGoal.z, dist: g.rig._distGoal,
    ctx: window.__ctxDefaults,
  };
});

/** Screen pixel for a 2x2 anchor. */
const cellPx = (c, r) => page.evaluate(([cc, rr]) => {
  const g = window.__game;
  const p = g.grid.towerCentreToWorld(cc, rr, {});
  const cam = g.rig.camera; cam.updateMatrixWorld(true);
  const V = new g.arena.group.position.constructor(p.x, 0.25, p.z);
  V.project(cam);
  return [(V.x * 0.5 + 0.5) * window.innerWidth, (-V.y * 0.5 + 0.5) * window.innerHeight];
}, [c, r]);

// ---------------------------------------------------------------------------
console.log('\n1. right-click TAP drops the tower in hand');
await page.evaluate(() => window.__game.setBuildSelection('fire'));
let [px, py] = await cellPx(6, 6);
await page.mouse.move(px, py);
await page.waitForTimeout(220);
let before = await read();
ok(before.build === 'fire', 'precondition: fire in hand', JSON.stringify(before.build));
ok(before.gridTarget === 1, 'precondition: grid on');
ok(before.range > 0, 'precondition: range ring on', String(before.range));

await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(250);
let after = await read();
ok(after.build === null, 'selectedBuild cleared', JSON.stringify(after.build));
ok(after.gridTarget === 0, 'grid overlay told to fade out', String(after.gridTarget));
ok(after.range === 0, 'range ring cleared', String(after.range));
ok(after.hover[0] === -99 && after.hover[1] === -99, 'ghost parked off-board', String(after.hover));
ok(!after.hint.includes('show'), 'placement hint hidden', after.hint);
ok(Math.abs(after.az - before.az) < 1e-6 && Math.abs(after.polar - before.polar) < 1e-6,
  'camera orbit untouched by the tap');
ok(after.ctx === 0, 'no browser context menu escaped preventDefault', String(after.ctx));

// ---------------------------------------------------------------------------
console.log('\n2. right-click DRAG orbits and does NOT cancel');
await page.evaluate(() => window.__game.setBuildSelection('water'));
[px, py] = await cellPx(6, 6);
await page.mouse.move(px, py);
await page.waitForTimeout(200);
before = await read();
await page.mouse.down({ button: 'right' });
await page.mouse.move(px + 120, py + 40, { steps: 8 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(250);
after = await read();
ok(after.build === 'water', 'tower still in hand after an orbit drag', JSON.stringify(after.build));
ok(Math.abs(after.az - before.az) > 0.2, 'azimuth actually moved',
  `${before.az.toFixed(3)} -> ${after.az.toFixed(3)}`);
ok(Math.abs(after.polar - before.polar) > 0.05, 'polar actually moved',
  `${before.polar.toFixed(3)} -> ${after.polar.toFixed(3)}`);
ok(after.ctx === 0, 'still no context menu', String(after.ctx));

// A 4px twitch is a tap, not a drag: prove the threshold is where we think.
console.log('\n2b. a 4px wobble still counts as a tap');
[px, py] = await cellPx(6, 6);
await page.mouse.move(px, py);
await page.mouse.down({ button: 'right' });
await page.mouse.move(px + 3, py + 2, { steps: 2 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(250);
after = await read();
ok(after.build === null, 'sub-threshold movement cancels', JSON.stringify(after.build));

// ---------------------------------------------------------------------------
console.log('\n3. with no tower in hand, right-click deselects the inspected tower');
await page.evaluate(() => {
  const g = window.__game;
  g.setBuildSelection(null);
  g.build('fire', 8, 8);
  g.selectTower(g.towers.towers[g.towers.towers.length - 1].id);
});
await page.waitForTimeout(250);
before = await read();
ok(before.tower !== null, 'precondition: a tower is selected', String(before.tower));
ok(before.range > 0, 'precondition: its range ring is up', String(before.range));
console.log('   inspector class:', before.inspectorCls);
[px, py] = await cellPx(14, 14);
await page.mouse.move(px, py);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(250);
after = await read();
ok(after.tower === null, 'selectedTower cleared', String(after.tower));
ok(after.range === 0, 'range ring cleared', String(after.range));
ok(after.gridTarget === 0, 'grid overlay off', String(after.gridTarget));
console.log('   inspector class after:', after.inspectorCls);
ok(after.inspectorCls !== before.inspectorCls || !after.inspectorCls.includes('open'),
  'inspector closed', `${before.inspectorCls} -> ${after.inspectorCls}`);

// ---------------------------------------------------------------------------
console.log('\n4. build in hand wins over the inspected tower (one click, one undo)');
await page.evaluate(() => {
  const g = window.__game;
  g.selectTower(g.towers.towers[0].id);
  g.selectedBuild = 'earth';        // force the both-set state the UI cannot reach
});
await page.waitForTimeout(150);
[px, py] = await cellPx(14, 14);
await page.mouse.move(px, py);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(250);
after = await read();
ok(after.build === null, 'build dropped first', JSON.stringify(after.build));
ok(after.tower !== null, 'inspected tower survives the first cancel', String(after.tower));
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(250);
after = await read();
ok(after.tower === null, 'second right-click clears the tower', String(after.tower));

// ---------------------------------------------------------------------------
console.log('\n5. middle-button pan and wheel zoom still work');
await page.evaluate(() => window.__game.selectTower(null));
before = await read();
[px, py] = await cellPx(12, 9);
await page.mouse.move(px, py);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(px + 100, py, { steps: 6 });
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(200);
after = await read();
ok(Math.hypot(after.tx - before.tx, after.tz - before.tz) > 0.5, 'middle-drag panned',
  `${before.tx.toFixed(2)},${before.tz.toFixed(2)} -> ${after.tx.toFixed(2)},${after.tz.toFixed(2)}`);
before = after;
await page.mouse.wheel(0, -400);
await page.waitForTimeout(200);
after = await read();
ok(Math.abs(after.dist - before.dist) > 0.5, 'wheel zoomed',
  `${before.dist.toFixed(2)} -> ${after.dist.toFixed(2)}`);

console.log('\n6. shift + left-drag still orbits');
before = await read();
[px, py] = await cellPx(12, 9);
await page.mouse.move(px, py);
await page.keyboard.down('Shift');
await page.mouse.down({ button: 'left' });
await page.mouse.move(px + 140, py, { steps: 8 });
await page.mouse.up({ button: 'left' });
await page.keyboard.up('Shift');
await page.waitForTimeout(200);
after = await read();
ok(Math.abs(after.az - before.az) > 0.2, 'shift+left orbited',
  `${before.az.toFixed(3)} -> ${after.az.toFixed(3)}`);

console.log('\n7. spectating: right-click is inert');
const spec = await page.evaluate(async () => {
  const g = window.__game;
  g.setBuildSelection('fire');
  // Minimal stand-in for a SpectateView; enterSpectate only reads these fields.
  const view = { grid: g.grid, creeps: g.creeps, color: 0x66ccff, end() {}, update() {} };
  g.enterSpectate(view);
  await new Promise((r) => setTimeout(r, 200));
  return { spectating: g.spectating, build: g.selectedBuild };
});
console.log('   after enterSpectate:', JSON.stringify(spec));
await page.evaluate(() => { window.__game.selectedBuild = 'fire'; });   // force a stale selection
[px, py] = await cellPx(12, 9);
await page.mouse.move(px, py);
await page.mouse.down({ button: 'right' });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(250);
after = await read();
ok(after.build === 'fire', 'right-click did nothing while spectating', JSON.stringify(after.build));
const stillSpec = await page.evaluate(() => window.__game.spectating);
ok(stillSpec === true, 'still spectating (right-click is not an exit)', String(stillSpec));
await page.evaluate(() => { window.__game.exitSpectate('test'); window.__game.selectedBuild = null; });

// ---------------------------------------------------------------------------
console.log('\n8. control: prove the instrument can fail');
// Left-click on a legal cell must still BUILD - if the right-button branch had
// swallowed the left button, everything above would pass while the game broke.
// Sections 2/5/6 deliberately left the camera orbited, panned and zoomed, and
// section 7 restored a saved pose on top. Re-frame before this one: a cell that
// has drifted under the dock is a Playwright miss, not a game bug, and it would
// read as 'left-click stopped working'.
await page.evaluate(() => {
  const g = window.__game;
  g.state.gold = 999999;
  g.rig._autoFrame = true; g.rig._framedAspect = -1; g.rig._settleFrames = 40;
  g.setBuildSelection('light');
});
await page.waitForTimeout(900);
const anchor = await page.evaluate(() => {
  const g = window.__game;
  for (let r = 4; r <= 12; r++) for (let c = 4; c <= 20; c++) {
    if (g.placementReason(c, r) === 'valid') return [c, r];
  }
  return null;
});
const nBefore = await page.evaluate(() => window.__game.towers.towers.length);
[px, py] = await cellPx(anchor[0], anchor[1]);
await page.mouse.move(px, py);
await page.waitForTimeout(220);
const probe = await page.evaluate(([x, y]) => ({
  reason: window.__game.hover?.reason ?? null,
  under: document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.tagName,
}), [px, py]);
console.log(`   anchor ${anchor} at ${px.toFixed(0)},${py.toFixed(0)} reason=${probe.reason} under=${probe.under}`);
ok(probe.reason === 'valid' && probe.under === 'viewport',
  'the click actually lands on a legal cell of the canvas', JSON.stringify(probe));
await page.mouse.down({ button: 'left' });
await page.mouse.up({ button: 'left' });
await page.waitForTimeout(300);
const nAfter = await page.evaluate(() => window.__game.towers.towers.length);
ok(nAfter === nBefore + 1, 'left-click still builds', `${nBefore} -> ${nAfter}`);

const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
await browser.close();
console.log(`\n${pass} ok, ${fail} FAIL`);
if (errors.length) console.log('console errors:\n' + errors.join('\n'));
process.exit(fail || errors.length ? 1 : 0);
