#!/usr/bin/env node
/**
 * TRUE silhouette test. Towers become pure black on pure white, no post,
 * no lights, no glow/rune layers, at a chosen camera distance.
 *
 *   node sil.mjs --out x.png --set pure --dist 60
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const OUT = resolve(arg('out', 'sil.png'));
const SET = arg('set', 'pure');
const DIST = Number(arg('dist', 60));
const POLAR = Number(arg('polar', 0.72));
const SPACING = Number(arg('spacing', 3));
mkdirSync(dirname(OUT), { recursive: true });

const SETS = {
  pure:  [['fire', 0], ['water', 0], ['nature', 0], ['earth', 0], ['light', 0], ['dark', 0]],
  tiers: [['fire', 0], ['fire', 1], ['fire', 2], ['water', 0], ['water', 1], ['water', 2]],
  tiers2:[['earth', 0], ['earth', 1], ['earth', 2], ['dark', 0], ['dark', 1], ['dark', 2]],
  dualA: [['vapor', 0], ['solar', 0], ['blacksmith', 0], ['lightning', 0], ['infernal', 0], ['well', 0]],
};

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.route('**/@vite/client', (route) =>
  route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' }));
await page.addInitScript(`window.__silKeep = ${flag('keep')}; window.__silBg = ${flag('bg')}`);
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const stats = await page.evaluate(async ({ list, dist, polar, spacing, sil }) => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 9e9;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  for (const t of [...g.towers.towers]) g.towers.remove(t.id);
  const r = 9;
  list.forEach(([key, lvl], i) => {
    const c = 4 + i * spacing;
    const t = g.towers.create(key, 0, c, r);
    for (let k = 0; k < lvl; k++) g.towers.upgrade(t.id);
    t.rise = 1; t.baseDirty = true;
  });
  const avg = (a, k) => a.reduce((s, t) => s + t[k], 0) / a.length;
  await wait(600);
  g.rig.focus(avg(g.towers.towers, 'x'), avg(g.towers.towers, 'z'), dist);
  if (g.rig._polarGoal !== undefined) g.rig._polarGoal = polar;
  if (g.rig.polarGoal !== undefined) g.rig.polarGoal = polar;
  await wait(1600);

  if (sil) {
    const mat = g.towers.batch.mesh.material;
    const Color = mat.color.constructor;
    g.scene.traverse((o) => {
      if ((o.isMesh || o.isPoints || o.isLine || o.isSprite) && o !== g.towers.batch.mesh) o.visible = false;
      if (o.isLight) o.intensity = 0;
    });
    g.towers.batch.glowMesh.visible = false;
    g.towers.batch.runeMesh.visible = false;
    g.scene.background = new Color(0x000000); g.scene.environment = null; g.scene.fog = null;
    g.towers.batch.mesh.castShadow = false;
    g.towers.batch.mesh.receiveShadow = false;
    mat.onBeforeCompile = () => {};
    mat.customProgramCacheKey = () => 'silFlat';
    mat.vertexColors = false;
    mat.color.setRGB(0, 0, 0);
    mat.emissive.setRGB(1, 1, 1);
    mat.emissiveIntensity = 1;
    mat.metalness = 0; mat.roughness = 1;
    mat.envMapIntensity = 0;
    mat.needsUpdate = true;
    for (const k of ['bloom','gtao','dof','godrays','vignette','grain','ca']) {
      const p = g.pipeline.passes?.[k];
      if (p && 'enabled' in p) p.enabled = false;
    }
    await wait(900);
  }
  await wait(500);
  const info = g.pipeline.renderer.info;
  const cam = g.rig.camera || g.camera;
  return { drawCalls: info.render.calls, triangles: info.render.triangles, towers: g.towers.towers.length, cam: cam && cam.position.toArray(), t0: [g.towers.towers[0].x, g.towers.towers[0].z], rigKeys: Object.keys(g.rig) };
}, { list: SETS[SET], dist: DIST, polar: POLAR, spacing: SPACING, sil: !flag('lit') });

await page.waitForTimeout(400);
writeFileSync(OUT, await page.screenshot({ type: 'png' }));
await browser.close();
console.log(JSON.stringify({ out: OUT, set: SET, stats, errors: logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')) }, null, 2));
