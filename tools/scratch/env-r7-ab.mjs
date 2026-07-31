#!/usr/bin/env node
/**
 * env-r7-ab.mjs — PAIRED measurement of the round-7 ground-variety terms.
 *
 * PITFALLS 12's measurement rule: in a parallel fan-out the frame moves under
 * you continuously, so a before/after claim has to come from two measurements
 * on the SAME build, minutes apart, with the change toggled at runtime. This
 * boots once and captures twice — the round-7 albedo variety ON, then with
 * uDryAmt / uWearAmt / uPatchAmt forced to 0 and the greens restored to the
 * round-6 values, which is the "one flat high-chroma green" the critics saw.
 *
 * Reports, over the visible surround only (ground pixels, board masked out by
 * a luminance+saturation heuristic-free hand box list), the mean, the p10-p90
 * spread and the standard deviation of luminance and hue. "One flat green" is
 * a claim about spread, so spread is what has to move.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const URL = 'http://localhost:5273/';
const OUT = process.argv[2] || '/tmp/env-r7-ab';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.route('**/@vite/client', (route) =>
  route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' }));
await page.goto(`${URL}?q=ultra`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

// Drive the same 'empty' state shot.mjs would: the title screen renders BLACK
// and both halves of an A/B against a black frame are identical, which looks
// exactly like 'the change did nothing'. Empty (no towers, no VFX) is the
// right board for a surround measurement anyway - no tower glow spilling into
// the boxes.
await page.evaluate(() => {
  const g = window.__game;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
});
await page.waitForTimeout(4000);

async function shot(tag) {
  await page.waitForTimeout(900);
  const buf = await page.screenshot({ type: 'png' });
  writeFileSync(`${OUT}/${tag}.png`, buf);
  return `${OUT}/${tag}.png`;
}

const a = await shot('on');

// Force the round-6 state: one green, no dry variant, no wear, no tone patches.
const ok = await page.evaluate(() => {
  let hit = 0;
  window.__game.scene.traverse((o) => {
    const m = o.material;
    if (!m || m.name !== 'ground') return;
    const u = m.userData.uniforms;
    if (!u) return;
    u.uDryAmt.value = 0;
    u.uWearAmt.value = 0;
    u.uPatchAmt.value = 0;
    u.uLow.value.setHex(0x0f4038);
    u.uMid.value.setHex(0x293c1d);
    u.uHigh.value.setHex(0x172c46);
    u.uSat.value = 1.9;
    hit++;
  });
  return hit;
});
console.log('ground materials patched:', ok);
const b = await shot('off');
await browser.close();

console.log(`\nA = ${a}   (round 7, four albedos + wear + tone patches)`);
console.log(`B = ${b}   (same build, forced back to the round-6 single green)`);
console.log('\nnode tools/scratch/env-r7.mjs <file> for the box table.');
