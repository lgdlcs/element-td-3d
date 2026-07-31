#!/usr/bin/env node
/**
 * Lighting/grade sweep. Boots ONE midgame session, then applies a list of
 * live tweaks and screenshots each, so a dozen candidate grades cost one boot
 * instead of a dozen. Prints the lum-vs-ref row for each variant.
 *
 *   node tools/scratch/lg-sweep.mjs
 *
 * Variants are edited in VARIANTS below. `apply` runs with `g` = window.__game.
 * Every variant must set EVERY knob it cares about — they are applied on top of
 * each other in one session, so nothing resets between them.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const VARIANTS = JSON.parse(process.argv[2] ?? '[]');

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push('[error] ' + m.text()); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;',
}));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let n = 0; n < 200 && document.getElementById('boot'); n++) await wait(150);
  let seed = 1337;
  Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  for (const [k, c, r] of [
    ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
    ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
    ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
    ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
    ['dark', 14, 15],
  ]) g.build(k, c, r);
  g.state.wave = 21; g.state.gold = 4820; g.state.lives = 43;
  g.state.phase = 'combat';
  g.waves.start(22);
  await wait(3600);
});

mkdirSync('shots/sweep', { recursive: true });
const outs = [];
for (const v of VARIANTS) {
  await page.evaluate((src) => {
    const g = window.__game;
    const L = g.lighting ?? g.world?.lighting ?? g.env?.lighting;
    const P = g.pipeline, GR = P.passes.grade.uniforms, R = P.renderer;
    // NOT indirect eval: `(0,eval)(src)` runs in GLOBAL scope, where none of
    // these locals exist, so every variant throws ReferenceError on `GR`.
    new Function('g', 'L', 'GR', 'P', 'R', src)(g, L, GR, P, R);
  }, v.apply);
  await page.waitForTimeout(900);
  const out = `shots/sweep/${v.name}.png`;
  writeFileSync(out, await page.screenshot({ type: 'png', timeout: 120000 }));
  outs.push(out);
  console.log('captured', out);
}
console.log(JSON.stringify({ errors: logs }));
await browser.close();
