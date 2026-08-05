/**
 * Does any of this actually work in the running game?
 *
 * Four claims, each verified against the live page rather than against the
 * source that asserts it:
 *
 *  1. `?q=potato` boots, renders a NON-BLACK, non-uniform image, and runs its
 *     frame loop without throwing. The direct render path skips OutputPass, and
 *     a colour-management mistake there would produce a plausible-looking build
 *     that is black, blown out, or flat grey on the player's screen. A frame
 *     time is not evidence of an image.
 *  2. `potato` really is on the direct path (composer null) and really did drop
 *     the shadow map, the decor and the extra lights.
 *  3. The settings panel exists, opens, and lists every preset — the whole
 *     point being that a player can reach it without editing a URL.
 *  4. The governor steps down when the frame is over budget, restores on
 *     reset(), and — the part most likely to be wrong — every rung is
 *     REVERSIBLE: applying all of them and then reverting all of them must
 *     return the scene to exactly the state it started in.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};

async function open(q) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://localhost:5273/?solo&q=${q}`, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
  await p.waitForTimeout(3000);
  return { p, errs };
}

// ---------------------------------------------------------------- 1 + 2
console.log('\n[potato] boots, renders and is on the direct path');
{
  const { p, errs } = await open('potato');

  const state = await p.evaluate(() => {
    const g = window.__game;
    return {
      quality: g.pipeline.quality,
      composer: g.pipeline.composer === null,
      shadowMap: g.pipeline.renderer.shadowMap.enabled,
      keyShadow: g.lighting.key.castShadow,
      fill: g.lighting.fill.visible,
      rim: g.lighting.rim.visible,
      ember: g.lighting.ember.visible,
      hemi: g.lighting.hemi.visible,
      sky: g.environment.sky.mesh.visible,
      backdrop: g.environment.backdrop.group.visible,
      motes: g.environment.motes.points.visible,
    };
  });

  check('boots at the potato preset', state.quality === 'potato', state.quality);
  check('composer is not built at all', state.composer === true);
  check('key light casts no shadow', state.keyShadow === false);
  check('fill / rim / ember are off', !state.fill && !state.rim && !state.ember);
  check('hemisphere is KEPT (readability)', state.hemi === true);
  check('sky is KEPT (horizon)', state.sky === true);
  check('backdrop and motes are off', !state.backdrop && !state.motes);

  // The image itself. A direct render bypasses OutputPass, so this is the claim
  // most likely to be silently wrong.
  const shot = await p.screenshot({ clip: { x: 0, y: 90, width: 1280, height: 560 } });
  const { createCanvas, loadImage } = await import('canvas').catch(() => ({}));
  if (createCanvas) {
    const img = await loadImage(shot);
    const c = createCanvas(img.width, img.height);
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const d = cx.getImageData(0, 0, img.width, img.height).data;
    let sum = 0, min = 255, max = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722);
      sum += l; if (l < min) min = l; if (l > max) max = l;
    }
    const mean = sum / n;
    check('frame is not black and not blown out', mean > 12 && mean < 235, `mean luma ${mean.toFixed(1)}`);
    check('frame has real contrast (not flat grey)', (max - min) > 60, `range ${(max - min).toFixed(0)}`);
  } else {
    // No `canvas` module: fall back to the renderer's own evidence.
    const drew = await p.evaluate(() => window.__game.pipeline.renderer.info.render.triangles);
    check('frame draws geometry (luma check skipped, no `canvas` module)', drew > 1000, `${drew} tris`);
  }

  check('no page errors during the run', errs.length === 0, errs[0] ?? '');
  await p.close();
}

// ---------------------------------------------------------------- 3
console.log('\n[settings] the player can reach it');
{
  const { p, errs } = await open('low');
  const btn = await p.$('#settings-btn');
  check('the gear button exists in the top bar', !!btn);
  await btn?.click();
  await p.waitForTimeout(400);
  const panel = await p.evaluate(() => {
    const el = document.getElementById('settings');
    return {
      open: el?.classList.contains('open'),
      visible: el ? getComputedStyle(el).visibility : 'none',
      presets: [...(el?.querySelectorAll('.set-q') ?? [])].map((b) => b.dataset.q),
    };
  });
  check('clicking it opens the panel', panel.open === true && panel.visible === 'visible');
  check('every preset is listed, plus auto', JSON.stringify(panel.presets) ===
    JSON.stringify(['auto', 'potato', 'low', 'medium', 'high', 'ultra']), panel.presets.join(','));

  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  check('Escape closes it', await p.evaluate(() => !document.getElementById('settings').classList.contains('open')));
  check('no page errors', errs.length === 0, errs[0] ?? '');
  await p.close();
}

// ---------------------------------------------------------------- 4
console.log('\n[governor] steps down, and every rung is reversible');
{
  const { p, errs } = await open('high');

  const snapshot = () => p.evaluate(() => {
    const g = window.__game;
    return JSON.stringify({
      dof: g.pipeline.passes.dof?.enabled ?? null,
      gtao: g.pipeline.passes.gtao?.enabled ?? null,
      backdrop: g.environment.backdrop.group.visible,
      fog: g.environment.groundFog.mesh.visible,
      motes: g.environment.motes.points.visible,
      fill: g.lighting.fill.visible,
      rim: g.lighting.rim.visible,
      ember: g.lighting.ember.visible,
      poolSuspended: g.fx.lights.suspended,
      keyShadow: g.lighting.key.castShadow,
      shadowMap: g.pipeline.renderer.shadowMap.enabled,
      bypassed: g.pipeline.composerBypassed,
    });
  });

  const before = await snapshot();
  const rungs = await p.evaluate(() => window.__governor.rungs.length);
  check('the ladder has rungs', rungs > 0, `${rungs} rungs`);

  // Drive it directly rather than waiting for a slow machine: apply every rung.
  await p.evaluate(() => {
    const g = window.__governor;
    while (!g.exhausted) g.rungs[g.step++].apply();
    g.onChange?.(g);
  });
  await p.waitForTimeout(600);

  const bottom = await p.evaluate(() => ({
    removed: window.__governor.removed,
    bypassed: window.__game.pipeline.composerBypassed,
    shadow: window.__game.pipeline.renderer.shadowMap.enabled,
    fill: window.__game.lighting.fill.visible,
  }));
  check('at the bottom, the composer is bypassed', bottom.bypassed === true);
  check('at the bottom, shadows are off', bottom.shadow === false);
  check('at the bottom, extra lights are off', bottom.fill === false);
  check('it can name what it removed', bottom.removed.length === rungs, bottom.removed.join(' · '));

  // The frame loop must survive the bottom rung — a bypassed composer that
  // throws would look like a win in every frame-time probe.
  const advanced = await p.evaluate(() => new Promise((res) => {
    const a = window.__game.pipeline.renderer.info.render.frame;
    setTimeout(() => res(window.__game.pipeline.renderer.info.render.frame !== a), 500);
  }));
  check('the frame loop still runs while fully degraded', advanced === true);

  await p.evaluate(() => window.__governor.reset());
  await p.waitForTimeout(600);
  const after = await snapshot();
  check('reset() restores the scene exactly', after === before,
    after === before ? '' : `\n      before ${before}\n      after  ${after}`);
  check('no page errors', errs.length === 0, errs[0] ?? '');
  await p.close();
}

await b.close();
console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
