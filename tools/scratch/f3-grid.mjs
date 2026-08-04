#!/usr/bin/env node
/**
 * Throwaway capture harness for FEATURE 3 (grid + placement preview legibility).
 *
 *   node tools/scratch/f3-grid.mjs --tag before
 *
 * Writes shots/f3-<tag>-*.png:
 *   gridoff   control: no build selected. The grid MUST be absent here, or every
 *             other frame in this set is measuring the ground texture.
 *   grid      build selected, cursor parked off-board -> lines only.
 *   gridfar   same, camera pulled to CAMERA.maxDist (moire / thin-line test).
 *   valid / occupied / creep / poor / stacks / seal
 *             one crop per placementReason outcome, cursor on the real cell,
 *             driven through the REAL pointermove path (page.mouse.move), so the
 *             ghost we photograph is the one a player would see.
 *
 * Each hover frame is only written after the in-page assertion that
 * `game.hover.reason` is the outcome we asked for; a mislabelled crop is worse
 * than no crop.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TAG = arg('tag', 'x');
const W = Number(arg('w', 1600));
const H = Number(arg('h', 900));
const DIR = resolve('shots');
mkdirSync(DIR, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

// PITFALLS §11: a hot reload mid-capture reconstructs Game and resets the grid.
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;',
}));

await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 60000 })
  .catch(() => page.evaluate(() => document.getElementById('boot')?.remove()));

const setup = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0;
  g.state.gold = 999999;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  g.hud.refreshBuildBar();
  const MAZE = [
    ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
    ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
    ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
    ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
    ['dark', 14, 15],
  ];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  g.state.wave = 21;
  await wait(500);
  return { towers: g.towers.towers.length };
});
console.log('setup', setup);

const shot = async (name, clip) => {
  const buf = await page.screenshot({ type: 'png', timeout: 120000, ...(clip ? { clip } : {}) });
  const out = `${DIR}/f3-${TAG}-${name}.png`;
  writeFileSync(out, buf);
  console.log('wrote', out);
};

/** Project a world XZ onto client pixels through the live camera. */
const project = (wx, wz) => page.evaluate(([x, z]) => {
  const g = window.__game;
  const cam = g.rig.camera; cam.updateMatrixWorld(true);
  const V = new g.arena.group.position.constructor(x, 0.25, z);
  V.project(cam);
  return [(V.x * 0.5 + 0.5) * window.innerWidth, (-V.y * 0.5 + 0.5) * window.innerHeight];
}, [wx, wz]);

const centreOf = (c, r) => page.evaluate(([cc, rr]) => {
  const p = window.__game.grid.towerCentreToWorld(cc, rr, {});
  return [p.x, p.z];
}, [c, r]);

/** Move the real cursor onto an anchor, assert the outcome, crop around it. */
const hoverShot = async (name, c, r, expect) => {
  const [wx, wz] = await centreOf(c, r);
  const [px, py] = await project(wx, wz);
  await page.mouse.move(px, py, { steps: 3 });
  await page.waitForTimeout(500);
  const got = await page.evaluate(() => window.__game.hover?.reason ?? null);
  if (expect && got !== expect) {
    console.error(`!! ${name}: expected reason '${expect}', got '${got}' — NOT writing`);
    return false;
  }
  // The DOM hint rides next to the cursor and lands square on the ghost in a
  // tight crop. It is not what is under test here, and leaving it in produced
  // two crops where the pad was simply behind a tooltip.
  await page.evaluate(() => { const e = document.getElementById('place-hint'); if (e) e.style.visibility = 'hidden'; });
  const cw = 620, ch = 460;
  await shot(name, {
    x: Math.max(0, Math.min(W - cw, Math.round(px - cw / 2))),
    y: Math.max(0, Math.min(H - ch, Math.round(py - ch / 2))),
    width: cw, height: ch,
  });
  await page.evaluate(() => { const e = document.getElementById('place-hint'); if (e) e.style.visibility = ''; });
  return true;
};

// --- control: nothing selected. If the grid shows here, the instrument lies. --
await page.evaluate(() => { window.__game.setBuildSelection(null); window.__game.selectTower(null); });
await page.mouse.move(W * 0.5, H * 0.5);
await page.waitForTimeout(700);
console.log('control gridTarget =', await page.evaluate(() => window.__game.arena._gridTargetOpacity ?? 0),
  'uOpacity =', await page.evaluate(() => window.__game.arena.gridMaterial.uniforms.uOpacity.value.toFixed(3)));
await shot('gridoff');

// --- lines only ------------------------------------------------------------
await page.evaluate(() => window.__game.setBuildSelection('fire'));
await page.mouse.move(W * 0.5, H * 0.12);            // over the sky, off the board
await page.waitForTimeout(700);
console.log('grid uOpacity =', await page.evaluate(() => window.__game.arena.gridMaterial.uniforms.uOpacity.value.toFixed(3)));
await shot('grid');

// Close crop on the protected exit corridor. It is the one place where the
// PATH_ONLY hatch has to be unmistakable against the free cells beside it, and
// the goal end is nearest the camera so it is the honest test. The whole DOM UI
// comes off for this one: half the earlier crops were judging a tooltip.
{
  await page.evaluate(() => { const r = document.getElementById('ui-root'); if (r) r.style.visibility = 'hidden'; });
  await page.waitForTimeout(250);
  const [wx, wz] = await page.evaluate(() => {
    const p = window.__game.grid.cellToWorld(13, 18, {});
    return [p.x, p.z];
  });
  const [px, py] = await project(wx, wz);
  await shot('corridor', {
    x: Math.max(0, Math.min(W - 760, Math.round(px - 380))),
    y: Math.max(0, Math.min(H - 520, Math.round(py - 300))),
    width: 760, height: 520,
  });
  await shot('gridnoui');
  await page.evaluate(() => { const r = document.getElementById('ui-root'); if (r) r.style.visibility = ''; });
  await page.waitForTimeout(200);
}

// --- lines at maximum zoom-out (aliasing / moire) --------------------------
await page.evaluate(() => {
  const g = window.__game;
  g.rig._autoFrame = false;
  g.rig._distGoal = 150;
  g.rig.dist = 150;
});
await page.waitForTimeout(900);
await shot('gridfar');
await page.evaluate(() => { const g = window.__game; g.rig._autoFrame = true; g.rig._framedAspect = -1; g.rig._settleFrames = 30; });
await page.waitForTimeout(900);

// --- one crop per refusal --------------------------------------------------
// Pick the free anchor from the live board rather than hardcoding one: the maze
// moves, and a stale coordinate silently degrades every crop to 'occupied'.
const FREE = await page.evaluate(() => {
  const g = window.__game;
  for (let r = 14; r >= 2; r -= 1) {
    for (let c = 2; c <= 22; c += 1) {
      if (!g.grid.canPlaceTower(c, r)) continue;
      if (g.path.wouldBlock(c, r)) continue;
      if (g.creeps.blockedByFootprint(c, r)) continue;
      return [c, r];
    }
  }
  return null;
});
console.log('free anchor', FREE);
await hoverShot('valid', FREE[0], FREE[1], 'valid');
await hoverShot('occupied', 10, 3, 'occupied');

// poor: same free cell, no gold
await page.evaluate(() => { window.__game.state.gold = 10; window.__game.hud.refreshTop(); });
await hoverShot('poor', FREE[0], FREE[1], 'poor');
await page.evaluate(() => { window.__game.state.gold = 999999; window.__game.hud.refreshTop(); });

// stacks: a primal needs 3 of its element; we hold one of each.
await page.evaluate(() => window.__game.setBuildSelection('primal_fire'));
await hoverShot('stacks', FREE[0], FREE[1], 'stacks');
await page.evaluate(() => window.__game.setBuildSelection('fire'));

// creep: pin a live creep inside the footprint
await page.evaluate(() => {
  const g = window.__game;
  const p = g.grid.towerCentreToWorld(20, 15, {});
  const i = g.creeps.spawn('armored', 4e6, 6, 0);
  if (i >= 0) {
    g.creeps.x[i] = p.x; g.creeps.z[i] = p.z;
    g.creeps.vx[i] = 0.0001; g.creeps.vz[i] = 0.0001;
    g.creeps.speed[i] = 0; g.creeps.baseSpeed[i] = 0; g.creeps.spawnT[i] = 1;
    window.__pinned = i;
    setInterval(() => {
      if (!g.creeps.alive[i]) return;
      g.creeps.x[i] = p.x; g.creeps.z[i] = p.z; g.creeps.speed[i] = 0; g.creeps.hp[i] = g.creeps.maxHp[i];
    }, 50);
  }
});
await page.waitForTimeout(400);
await hoverShot('creep', 20, 15, 'creep');

// seal: wall the board across row 11 (the MAZE already holds 6/10/14/18 there),
// leave the 12-13 gap, hover it.
await page.evaluate(() => {
  const g = window.__game;
  g.state.gold = 9999999;
  for (const c of [0, 2, 4, 8, 16, 20, 22, 24]) { g.build('earth', c, 11); g.state.gold = 9999999; }
  g.hud.refreshBuildBar();
});
await page.waitForTimeout(500);
await page.evaluate(() => window.__game.setBuildSelection('fire'));
// Ask the board where the chokepoint actually IS rather than assuming the gap
// we left is it: a 2x2 gap can be a dead end (its exits blocked diagonally) and
// then filling it seals nothing.
const SEAL = await page.evaluate(() => {
  const g = window.__game;
  let best = null, bd = 1e9;
  for (let r = 2; r <= 16; r++) {
    for (let c = 0; c <= 24; c++) {
      if (!g.grid.canPlaceTower(c, r)) continue;
      if (!g.path.wouldBlock(c, r)) continue;
      // Prefer a chokepoint near the middle of the board: half a pad hanging off
      // the rim is clipped by the shader and photographs as half a ghost.
      const d = Math.abs(c - 12) + Math.abs(r - 9);
      if (d < bd) { bd = d; best = [c, r]; }
    }
  }
  return best;
});
console.log('seal anchor', SEAL);
await hoverShot('seal', SEAL[0], SEAL[1], 'seal');
await shot('sealwide');

const health = await page.evaluate(() => {
  const g = window.__game;
  return { calls: g.pipeline.renderer.info.render.calls, tris: g.pipeline.renderer.info.render.triangles };
});
await browser.close();
const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
console.log(JSON.stringify({ health, errors }, null, 2));
