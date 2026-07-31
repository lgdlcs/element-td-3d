#!/usr/bin/env node
/** A/B a single post pass: writes <out>-on.png and <out>-off.png. */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PASS = arg('pass', 'gtao');
const OUT = resolve(arg('out', `shots/ab-${PASS}`));
const SC = arg('scenario', 'midgame');
mkdirSync(dirname(OUT), { recursive: true });
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = []; p.on('pageerror', (e) => logs.push(e.message));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await p.evaluate(async (sc) => {
  const g = window.__game; let s = 1337; Math.random = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  g.state.elements = ['fire','water','nature','earth','light','dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const M = [['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of M) g.build(k,c,r);
  g.state.wave = 21;
  if (sc === 'combat') { g.state.phase = 'combat'; g.waves.start(22); }
  await new Promise(r => setTimeout(r, 2500));
}, SC);
// Freeze absolutely everything so the A/B differs only by the pass.
await p.evaluate(() => {
  const g = window.__game;
  g.state.paused = true;
  for (const k of ['rig', 'arena', 'environment', 'lighting', 'fx']) {
    if (g[k] && g[k].update) g[k].update = () => {};
  }
  g.pipeline.passes.grade.uniforms.uGrain.value = 0;
});
await p.waitForTimeout(500);
writeFileSync(`${OUT}-on.png`, await p.screenshot({ type: 'png' }));
await p.evaluate((n) => { window.__game.pipeline.setPass(n, false); }, PASS);
await p.waitForTimeout(600);
writeFileSync(`${OUT}-off.png`, await p.screenshot({ type: 'png' }));
await p.evaluate((n) => { window.__game.pipeline.setPass(n, true); }, PASS);
await b.close();
console.log(JSON.stringify({ pass: PASS, on: `${OUT}-on.png`, off: `${OUT}-off.png`, errors: logs }));
