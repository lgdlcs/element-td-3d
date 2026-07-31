#!/usr/bin/env node
/** Round-4 env ablation probe: midgame scenario + arbitrary JS mutation, then shoot. */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(arg('out', '/tmp/r4probe.png'));
const CODE = arg('code', '');
mkdirSync(dirname(OUT), { recursive: true });
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
p.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') logs.push('[console] ' + m.text()); });
await p.route('**/@vite/client', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(async () => {
  const g = window.__game; let s = 1337; Math.random = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  g.state.elements = ['fire','water','nature','earth','light','dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const M = [['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of M) g.build(k,c,r);
  g.state.wave = 21; g.state.gold = 4820; g.state.lives = 43; g.state.score = 128400;
  g.state.phase = 'combat'; g.waves.start(22);
  await new Promise(r => setTimeout(r, 3600));
});
let res = '';
if (CODE) {
  res = await p.evaluate(async (c) => { try { return String(await eval(c)); } catch (e) { return 'ERR ' + e.message + '\n' + e.stack; } }, CODE);
}
await p.waitForTimeout(900);
writeFileSync(OUT, await p.screenshot({ type: 'png' }));
const stats = await p.evaluate(() => {
  const r = window.__game.renderer ?? window.__game.pipeline?.renderer;
  return r ? { drawCalls: r.info.render.calls, triangles: r.info.render.triangles, programs: r.info.programs?.length } : null;
});
await b.close();
console.log(JSON.stringify({ out: OUT, probe: res, stats, errors: logs }, null, 1));
