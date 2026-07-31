/**
 * What does a foundation cost per frame, against the alternative?
 *
 * The wrong comparison is "board with foundations" vs "empty board" — nobody
 * builds a maze out of nothing. A foundation exists to be placed where the
 * player would otherwise have placed an element tower, so the paired question is
 * 14 foundations vs 14 pure towers, same anchors, same scenario, same session.
 *
 * Both rows freeze the adaptive controller at a FIXED scale before benching, or
 * the two medians differ by whatever resolution the controller happened to pick
 * for each — which is a measurement of the controller, not of the towers.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const ANCHORS = [];
for (let r = 4; r < 14 && ANCHORS.length < 14; r += 3)
  for (let c = 4; c < 22 && ANCHORS.length < 14; c += 3) ANCHORS.push([c, r]);

const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:5273/?q=high', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(() => {
  const g = window.__game;
  g.pipeline.adaptive.enabled = false;
  g.pipeline.renderer.setPixelRatio(1);
  g.pipeline.resize();
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 9999999;
  g.hud.closeElementPicker?.();
  g.setBuildSelection(null);
});

const bench = (frames = 200) => p.evaluate((f) => new Promise((res) => {
  let i = 0, t0 = performance.now(); const t = [];
  const tick = () => {
    const x = performance.now(); t.push(x - t0); t0 = x;
    if (++i < f) requestAnimationFrame(tick);
    else { t.sort((a, c) => a - c); res({ med: +t[f >> 1].toFixed(2), p95: +t[Math.floor(f * 0.95)].toFixed(2) }); }
  };
  requestAnimationFrame(tick);
}), frames);

const place = (kind, anchors) => p.evaluate(([k, an]) => {
  const g = window.__game;
  // Clear every tower first so the rows never stack.
  for (const t of [...g.towers.towers]) g.towers.remove(t.id);
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let n = 0;
  for (let i = 0; i < an.length; i++) {
    const [c, r] = an[i];
    if (!g.grid.canPlaceTower(c, r) || g.path.wouldBlock(c, r)) continue;
    g.towers.create(k === 'foundation' ? 'foundation' : keys[i % 6], 0, c, r);
    n++;
  }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  return n;
}, [kind, anchors]);

const state = () => p.evaluate(() => {
  const g = window.__game;
  const lights = g.towers.batch.lights.filter((s) => s.light.intensity > 0.01).length;
  return {
    towers: g.towers.towers.length,
    inert: g.towers.towers.filter((t) => t.def.kind === 'inert').length,
    glowVerts: g.towers.batch.glowMesh.geometry.attributes.position?.count ?? 0,
    litLights: lights,
    calls: g.pipeline.renderer.info.render.calls,
    tris: g.pipeline.renderer.info.render.triangles,
    scale: g.pipeline.renderer.getPixelRatio(),
  };
});

const rows = [];
for (const kind of ['pure', 'foundation', 'pure']) {
  const n = await place(kind, ANCHORS);
  await p.waitForTimeout(2500);
  const s = await state();
  const t = await bench();
  rows.push({ kind, n, s, t });
  console.log(`${kind.padEnd(11)} n=${n}  towers=${s.towers} inert=${s.inert}  glowVerts=${String(s.glowVerts).padStart(5)}  litLights=${s.litLights}  ${s.calls} calls  ${s.tris} tris  dpr=${s.scale}`);
  console.log(`            median ${String(t.med).padStart(6)}ms   p95 ${String(t.p95).padStart(6)}ms`);
}

// Two `pure` rows bracket the foundation row: if they disagree with each other by
// more than the effect being measured, the effect is drift and not the towers.
const [a, f, c] = rows;
const drift = Math.abs(a.t.med - c.t.med);
const effect = ((a.t.med + c.t.med) / 2) - f.t.med;
console.log(`\n--- result -------------------------------------------`);
console.log(`pure->pure drift          ${drift.toFixed(1)} ms`);
console.log(`14 foundations vs 14 pure ${effect >= 0 ? '-' : '+'}${Math.abs(effect).toFixed(1)} ms  (negative = foundations cost MORE)`);
console.log(drift > Math.abs(effect)
  ? 'VERDICT: drift exceeds the effect — inconclusive, do not quote a number.'
  : `VERDICT: foundations are ${effect >= 0 ? 'CHEAPER' : 'MORE EXPENSIVE'} by ${Math.abs(effect).toFixed(1)} ms.`);
console.log(errs.length ? `\nERRORS: ${errs.join('\n')}` : '\nno page errors');
await b.close();
