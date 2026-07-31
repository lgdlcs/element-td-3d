#!/usr/bin/env node
/**
 * AT-CAMERA tower silhouette / read instrument.
 *
 *   node tools/tower-camsil.mjs --tag r7a
 *
 * Why this exists, and why `tools/tower-sheet.mjs --silhouette` is not enough.
 *
 * The sheet renders an ORTHO-ish side elevation of six isolated towers at
 * dist 34 / polar 1.02. Under that framing the six families are unmistakable —
 * verified. Three blind critics looking at the SHIPPED frame nonetheless said
 * "all the same barrel with a coloured glow on top", three rounds running. So
 * the elevation is not the image being judged, and a test that passes on an
 * image nobody sees is not a test.
 *
 * This tool photographs the towers under the ONLY framing that matters — the
 * gameplay camera, the gameplay board, gameplay spacing, gameplay distance —
 * and then peels one layer off at a time. The whole point is the ablation set,
 * not any single image:
 *
 *   full       as shipped. The control.
 *   sil        towers only, flat black, no emission, no specular, no lights, no
 *              bloom, white background. THE silhouette test. If the shapes are
 *              not separable here, no material or colour work can save them.
 *   silglow    same, but emission at ship strength with bloom running. The
 *              delta between `sil` and `silglow` is exactly how much of each
 *              tower's outline the glow is eating.
 *   spread     `sil`, but six pure towers on a 6-cell lattice instead of the
 *              21-tower maze. Isolates PACKING/OCCLUSION from PROJECTION: if
 *              this reads and `sil` does not, the towers are eating each other;
 *              if neither reads, the 53-degree camera is collapsing the profile.
 *   noemis     full render with every tower emissive forced to 0.
 *   nobloom    full render with the bloom pass disabled.
 *
 * Instrument-integrity notes (PITFALLS §8, §11 — this tool's predecessor lied
 * twice):
 *   - `sil` is driven by the material's own `uSilMode` uniform, NOT by
 *     stripping `onBeforeCompile`. A uniform cannot be defeated by the program
 *     cache, which is what silently broke the previous silhouette tool.
 *     `customProgramCacheKey` was also made to vary (it was constant).
 *   - The instrument carries its own falsification controls, because an
 *     instrument that has never been shown to produce a DIFFERENT answer has
 *     not been shown to work:
 *       * `full` / `sil` / `silglow` are three values of the same uniform and
 *         must produce three visibly different images. If two of them match,
 *         the uniform is not reaching the shader and nothing below is evidence.
 *       * `sil` vs `spread` changes ONE variable (spacing) and must change the
 *         verdict. On the round-6 build it did, decisively, which is how the
 *         collapse was attributed to packing rather than to the profiles.
 *   - `@vite/client` is stubbed: a neighbour's save mid-capture otherwise
 *     screenshots the title screen while reporting pre-reload stats.
 *   - `measure` reports on the board already on screen, so it must never be the
 *     first mode in `--modes`.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const TAG = arg('tag', 'camsil');
const DIR = resolve(arg('dir', 'shots/camsil'));
const MODES = arg('modes', 'full,sil,silglow,spread,noemis,nobloom').split(',');
const W = Number(arg('w', 1920));
const H = Number(arg('h', 1080));
mkdirSync(DIR, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;',
}));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

// The exact board `tools/shot.mjs --scenario midgame` builds, so every image
// here is directly comparable with the shipped capture.
const MAZE = [
  ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
  ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
  ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
  ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
  ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
  ['dark', 14, 15],
];
// Six pure families, one per column, on the same board at the same camera.
const SPREAD = [
  ['fire', 5, 9], ['water', 8, 9], ['nature', 11, 9],
  ['earth', 14, 9], ['light', 17, 9], ['dark', 20, 9],
];

await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let n = 0; n < 120 && document.getElementById('boot'); n++) await wait(150);
  document.querySelectorAll('.hud, #hud, #ui').forEach((e) => { e.style.display = 'none'; });
  window.__camsil = {
    hidden: [],
    bg: g.scene.background,
    fog: g.scene.fog,
    lights: [],
  };
});

// ---------------------------------------------------------------------------
// The measurement that turns "they occlude each other" into a number.
//
// At a camera pitch t (from horizontal) a tower of height H covers H*cos(t) of
// screen-vertical, while a neighbour one row (d units) further from the camera
// sits d*sin(t) higher up the screen. So a tower hides the BASE of the tower
// behind it exactly when H > d*tan(t). With d = 4 (the 2x2 tower pitch) that
// threshold is the whole ballgame, and it is a property of the camera, not of
// taste.
// ---------------------------------------------------------------------------
const measure = async () => page.evaluate(() => {
  const g = window.__game;
  const cam = g.rig?.camera ?? g.camera;
  cam.updateMatrixWorld(true);
  const d = cam.getWorldDirection(new g.arena.group.position.constructor());
  const pitch = Math.asin(-d.y) * 180 / Math.PI;   // degrees below horizontal
  const t = Math.abs(pitch) * Math.PI / 180;
  const rows = [];
  for (const tw of g.towers.towers) {
    rows.push({ key: tw.def.key, level: tw.level, height: +tw.spec.height.toFixed(2) });
  }
  const hs = rows.map((r) => r.height);
  return {
    pitchDeg: +Math.abs(pitch).toFixed(2),
    fov: cam.fov,
    occlusionThreshold: +(4 * Math.tan(t)).toFixed(2),
    heightMin: Math.min(...hs), heightMax: Math.max(...hs),
    heightMean: +(hs.reduce((a, b) => a + b, 0) / hs.length).toFixed(2),
    overThreshold: hs.filter((h) => h > 4 * Math.tan(t)).length,
    n: hs.length,
    perFamily: Object.fromEntries(rows.map((r) => [r.key, r.height])),
  };
});

const out = [];
for (const mode of MODES) {
  // `measure` reports on whatever board is currently up, so it must not be the
  // first mode in the list — there would be no towers to measure.
  if (mode === 'measure') { out.push({ mode, ...(await measure()) }); continue; }
  const stats = await page.evaluate(async ({ mode, MAZE, SPREAD }) => {
    const g = window.__game;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const S = window.__camsil;

    // ---- restore anything a previous mode changed -------------------------
    for (const o of S.hidden) o.visible = true;
    S.hidden.length = 0;
    for (const [l, i] of S.lights) l.intensity = i;
    S.lights.length = 0;
    g.scene.background = S.bg;
    g.scene.fog = S.fog;
    const bm = g.towers.batch.mesh.material;
    bm.userData.uSilMode.value = 0;
    bm.userData.uEmisScale.value = 1;
    if (g.pipeline.passes.bloom) g.pipeline.passes.bloom.enabled = true;

    // ---- board ------------------------------------------------------------
    const want = mode === 'spread' ? SPREAD : MAZE;
    const key = want.map((s) => s.join()).join('|');
    if (S.boardKey !== key) {
      S.boardKey = key;
      for (const t of [...g.towers.towers]) g.towers.remove(t.id);
      g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
      g.state.pendingElementPicks = 0;
      g.state.gold = 999999;
      g.hud.closeElementPicker();
      g.state.phase = 'prep';
      g.hud.refreshBuildBar();
      for (const [k, c, r] of want) g.build(k, c, r);
      for (const t of g.towers.towers) { t.rise = 1; t.baseDirty = true; }
      await wait(900);
    }

    const hideAllButTowers = () => {
      g.scene.traverse((o) => {
        const drawable = o.isMesh || o.isPoints || o.isSprite || o.isLine;
        if (drawable && o !== g.towers.batch.mesh && o.visible) { o.visible = false; S.hidden.push(o); }
      });
      g.scene.traverse((o) => { if (o.isLight) { S.lights.push([o, o.intensity]); o.intensity = 0; } });
      const Color = g.towers.batch.mesh.material.color.constructor;
      g.scene.background = new Color(1, 1, 1);
      g.scene.fog = null;
    };

    switch (mode) {
      case 'full':
        break;
      case 'sil':
      case 'spread':
        hideAllButTowers();
        bm.userData.uSilMode.value = 1;
        if (g.pipeline.passes.bloom) g.pipeline.passes.bloom.enabled = false;
        break;
      case 'silglow':
        hideAllButTowers();
        bm.userData.uSilMode.value = 2;
        break;
      case 'noemis':
        bm.userData.uEmisScale.value = 0;
        break;
      case 'nobloom':
        if (g.pipeline.passes.bloom) g.pipeline.passes.bloom.enabled = false;
        break;
      default:
        break;
    }
    await wait(1200);
    const info = g.pipeline.renderer.info;
    return { drawCalls: info.render.calls, triangles: info.render.triangles, towers: g.towers.towers.length };
  }, { mode, MAZE, SPREAD });

  await page.waitForTimeout(500);
  const file = `${DIR}/${TAG}-${mode}.png`;
  writeFileSync(file, await page.screenshot({ type: 'png', timeout: 120000 }));
  out.push({ mode, file, ...stats });
}

await browser.close();
console.log(JSON.stringify({
  out,
  errors: logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')),
}, null, 2));
