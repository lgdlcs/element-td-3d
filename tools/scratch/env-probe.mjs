#!/usr/bin/env node
/** Environment ablation probe: shoot midgame with a JS mutation applied. */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('out', '/tmp/env-probe.png');
const CODE = arg('code', '');
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = []; p.on('pageerror', (e) => logs.push(e.message));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
await p.evaluate(async () => {
  const g = window.__game; let s = 1337; Math.random = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  g.state.elements = ['fire','water','nature','earth','light','dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const M = [['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of M) g.build(k,c,r);
  g.state.wave = 21;
  await new Promise(r => setTimeout(r, 2000));
});
if (CODE) {
  const res = await p.evaluate((c) => {
    try { return String(eval(c)); } catch (e) { return 'ERR ' + e.message; }
  }, CODE);
  console.log('probe:', res);
}
await p.waitForTimeout(900);
writeFileSync(OUT, await p.screenshot({ type: 'png' }));
await b.close();
console.log(JSON.stringify({ out: OUT, errors: logs }));
