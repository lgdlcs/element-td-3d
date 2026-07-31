#!/usr/bin/env node
/**
 * Tower art contact sheet.
 *
 *   node tools/tower-sheet.mjs --out shots/sheet.png --set pure
 *   node tools/tower-sheet.mjs --out shots/sil.png  --set pure --silhouette
 *
 * Clears the board, lays out a chosen tower set on a fixed lattice and shoots
 * it from a low, readable angle. `--silhouette` flattens everything to black on
 * a white sky so shape alone can be judged (Art Bible G3).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

const OUT = resolve(arg('out', 'shots/sheet.png'));
const SET = arg('set', 'pure');
const DIST = Number(arg('dist', 34));
const POLAR = Number(arg('polar', 1.02));
mkdirSync(dirname(OUT), { recursive: true });

const SETS = {
  // key, level  — laid out left to right
  pure:  [['fire', 0], ['water', 0], ['nature', 0], ['earth', 0], ['light', 0], ['dark', 0]],
  tiers: [['fire', 0], ['fire', 1], ['fire', 2], ['light', 0], ['light', 1], ['light', 2]],
  tiers2:[['earth', 0], ['earth', 1], ['earth', 2], ['dark', 0], ['dark', 1], ['dark', 2]],
  dualA: [['vapor', 0], ['solar', 0], ['blacksmith', 0], ['lightning', 0], ['infernal', 0], ['well', 0]],
  dualB: [['geyser', 0], ['ice', 0], ['poison', 0], ['mushroom', 0], ['bloom', 0], ['disease', 0]],
  dualC: [['atom', 0], ['howitzer', 0], ['trickery', 0], ['atom', 1], ['howitzer', 1], ['trickery', 1]],
};

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
// Stub out the HMR client. During a parallel round another agent saving a file
// triggers a full reload mid-capture, which either destroys the evaluate
// context or writes a screenshot of the title screen while still reporting the
// stats gathered before the reload — a capture that looks clean and is wrong.
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;',
}));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });

const stats = await page.evaluate(async ({ list, sil, dist, polar }) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 9e9;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  for (const t of [...g.towers.towers]) g.towers.remove(t.id);

  const r = 9;
  list.forEach(([key, lvl], i) => {
    const c = 4 + i * 3;
    const t = g.towers.create(key, 0, c, r);
    for (let k = 0; k < lvl; k++) g.towers.upgrade(t.id);
    t.rise = 1; t.baseDirty = true;
  });
  g.rig.focus(0, 0, dist);
  g.rig._polarGoal = polar;
  if (g.rig.polarGoal !== undefined) g.rig.polarGoal = polar;
  await wait(1400);
  g.rig.focus(g.towers.towers.length ? avg(g.towers.towers, 'x') : 0, avg(g.towers.towers, 'z') - 2, dist);
  function avg(a, k) { return a.reduce((s, t) => s + t[k], 0) / a.length; }
  await wait(1600);

  if (sil) {
    const THREE = g.THREE ?? null;
    g.scene.traverse((o) => {
      // Points/Sprites/Lines too — motes and ribbons are not `isMesh` and used
      // to survive into the sheet as speckle over the silhouettes.
      const drawable = o.isMesh || o.isPoints || o.isSprite || o.isLine;
      if (drawable && o !== g.towers.batch.mesh) o.visible = false;
    });
    g.towers.batch.glowMesh.visible = false;
    g.towers.batch.runeMesh.visible = false;
    // Black towers on a WHITE background. This used to set `background = null`,
    // which renders black — so the whole sheet came out uniformly black and the
    // mode had never once produced a usable silhouette. Reach the Color class
    // through an existing instance; `THREE` is not exported onto the game.
    const Color = g.towers.batch.mesh.material.color.constructor;
    g.scene.background = new Color(1, 1, 1);
    g.scene.fog = null;
    const m = g.towers.batch.mesh.material;
    m.color.setRGB(0, 0, 0); m.emissiveIntensity = 0;
    m.onBeforeCompile = () => {};
    m.vertexColors = false; m.metalness = 0; m.roughness = 1;
    m.envMapIntensity = 0; m.envMap = null;
    if (m.emissive) m.emissive.setRGB(0, 0, 0);
    // `customProgramCacheKey` returns a CONSTANT on the tower material, so
    // clearing `onBeforeCompile` and `vertexColors` above reuses the cached
    // program and every injection survives — the sheet came back shaded brown,
    // not black. Force a fresh key so the recompile actually happens.
    m.customProgramCacheKey = () => `towerSil-${Math.random()}`;
    m.needsUpdate = true;
    // Kill every light so nothing can lift the shape off pure black; the white
    // background is the scene background, which is not lit.
    g.scene.traverse((o) => { if (o.isLight) o.intensity = 0; });
    for (const k of ['bloom', 'godrays', 'gtao', 'ao', 'ssao', 'dof']) {
      const pp = g.pipeline?.passes?.[k];
      if (pp && 'enabled' in pp) pp.enabled = false;
    }
    if (g.pipeline?.passes?.bloom) g.pipeline.passes.bloom.enabled = false;
    for (const l of g.towers.batch.lights) l.light.intensity = 0;
    await wait(700);
  }
  await wait(600);
  const info = g.pipeline.renderer.info;
  return { drawCalls: info.render.calls, triangles: info.render.triangles, towers: g.towers.towers.length };
}, { list: SETS[SET], sil: flag('silhouette'), dist: DIST, polar: POLAR });

await page.waitForTimeout(400);
writeFileSync(OUT, await page.screenshot({ type: 'png' }));
await browser.close();
console.log(JSON.stringify({ out: OUT, set: SET, stats, errors: logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')) }, null, 2));
