/**
 * What does a foundation maze actually LOOK like, and is the glow layer really
 * off for it?
 *
 * foundcost.mjs reported glowVerts=1134 on the all-foundation row, which reads
 * like the exclusion failing. The suspicion to test is that rebuildOverlays
 * returns early on an empty lit set and leaves the PREVIOUS row's buffer in
 * place while hiding the mesh — harmless, but indistinguishable from a broken
 * filter if you only look at the vertex count. So check `.visible`, not the
 * count, and then look at the frame.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const OUT = process.argv[2] || '/private/tmp/claude-501/-Users-pouetpouets-code/c57263d9-aa43-4151-90a5-60492452382f/scratchpad';

const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:5273/?q=high', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

// A real serpentine maze: alternating rows of foundations with a gap at each end,
// which is how a player actually mazes. Then a few armed towers inside it, so the
// shot shows the thing that matters — can you tell walls from weapons?
const info = await p.evaluate(async () => {
  const g = window.__game;
  g.pipeline.adaptive.enabled = false;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 9999999;
  g.hud.closeElementPicker?.();
  g.setBuildSelection(null);

  let walls = 0;
  for (let r = 4; r <= 14; r += 4) {
    const leftGap = ((r / 4) & 1) === 1;
    for (let c = 2; c < 24; c += 2) {
      const nearGap = leftGap ? c < 5 : c > 19;
      if (nearGap) continue;
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) {
        g.towers.create('foundation', 0, c, r);
        walls++;
      }
    }
  }
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let armed = 0;
  for (let r = 6; r <= 12 && armed < 6; r += 2) {
    for (let c = 6; c < 20 && armed < 6; c += 4) {
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) {
        g.towers.create(keys[armed % 6], 0, c, r);
        armed++;
      }
    }
  }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(12);
  await new Promise((r) => setTimeout(r, 3500));

  const batch = g.towers.batch;
  return {
    walls, armed,
    glowVisible: batch.glowMesh.visible,
    runeVisible: batch.runeMesh.visible,
    glowVerts: batch.glowMesh.geometry.attributes.position?.count ?? 0,
    slots: g.towers.towers.map((t) => ({ inert: !!t.spec.inert, slot: t.overlaySlot })),
    solvable: g.path.costAt(0, -19) < Infinity,
  };
});

const lit = info.slots.filter((s) => !s.inert);
const inert = info.slots.filter((s) => s.inert);
console.log(`maze: ${info.walls} foundations + ${info.armed} armed towers, solvable=${info.solvable}`);
console.log(`glow layer visible=${info.glowVisible} verts=${info.glowVerts}  (expected verts = 81 x ${lit.length} = ${81 * lit.length})`);
console.log(`slots: ${lit.length} lit -> [${lit.map((s) => s.slot).join(',')}]`);
console.log(`       ${inert.length} inert -> all -1: ${inert.every((s) => s.slot === -1)}`);

// All-foundation board: the case where the lit set is empty.
const empty = await p.evaluate(async () => {
  const g = window.__game;
  for (const t of [...g.towers.towers]) if (t.def.kind !== 'inert') g.towers.remove(t.id);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const batch = g.towers.batch;
  return {
    glowVisible: batch.glowMesh.visible,
    runeVisible: batch.runeMesh.visible,
    glowVerts: batch.glowMesh.geometry.attributes.position?.count ?? 0,
    towers: g.towers.towers.length,
  };
});
console.log(`\nall-foundation board (${empty.towers} blocks): glowVisible=${empty.glowVisible} runeVisible=${empty.runeVisible} verts=${empty.glowVerts}`);
console.log(empty.glowVisible || empty.runeVisible
  ? 'FAIL: an all-foundation board is still drawing the additive layers.'
  : 'PASS: both additive layers are off when nothing on the board is armed.');

// Restore the mixed board and shoot it.
await p.evaluate(async () => {
  const g = window.__game;
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let armed = 0;
  for (let r = 6; r <= 12 && armed < 6; r += 2) {
    for (let c = 6; c < 20 && armed < 6; c += 4) {
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[armed % 6], 0, c, r); armed++; }
    }
  }
  await new Promise((r) => setTimeout(r, 2500));
});
await p.screenshot({ path: `${OUT}/maze-wide.png` });

// Close on the wall/weapon boundary — the read this feature lives or dies on.
await p.evaluate(() => {
  const g = window.__game;
  g.rig.dist = 34; g.rig._distGoal = 34;
  g.rig.polar = 0.72; g.rig._polarGoal = 0.72;
});
await p.waitForTimeout(2200);
await p.screenshot({ path: `${OUT}/maze-close.png` });

// The blocked-terrain notification, on screen, with the hint panel showing.
await p.evaluate(() => {
  const g = window.__game;
  g.setBuildSelection('fire');
  const g4 = g.grid;
  let anchor = null;
  for (let c = 0; c < g4.cols - 1 && !anchor; c++)
    for (let r = 0; r < g4.rows - 1; r++)
      if (g4.canPlaceTower(c, r) && g.path.wouldBlock(c, r)) { anchor = [c, r]; break; }
  if (!anchor) return;
  const flags = new Uint8Array(g4.cols * g4.rows);
  g.path.sealPreview(anchor[0], anchor[1], flags);
  g.arena.setSealPreview(flags);
  g.arena.setHover(anchor[0], anchor[1], 'seal');
  g.arena.setGridVisible(true);
  g.hud.showPlacementHint('seal', { x: 820, y: 430 });
  g.rig.dist = 78; g.rig._distGoal = 78;
});
await p.waitForTimeout(2200);
await p.screenshot({ path: `${OUT}/seal-warning.png` });

console.log(errs.length ? `\nERRORS: ${errs.join('\n')}` : '\nno page errors');
console.log(`\nwrote maze-wide.png, maze-close.png, seal-warning.png to ${OUT}`);
await b.close();
