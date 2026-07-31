/**
 * PITFALLS §12: a number from an earlier round is not a baseline. The other two
 * agents have moved the frame under me several times today, so the round-6
 * before/after has to be a PAIRED measurement on ONE build: boot once, measure,
 * revert my round-7 changes at runtime, measure again, restore.
 *
 * Reverted here = every lever I actually moved:
 *   uAlbedoGain 0.30 -> 0.86, uSpecTint x(1/0.55), rim colour -> 0x8f8d8c,
 *   talus belt hidden, GTAO back to radius 1.15 / thickness 0.6 / exp 1.6 /
 *   scale 1.3.
 * The per-slab batch variation is a shader constant and cannot be toggled; it
 * is measured separately by eye against shots/r7/*.
 *
 * Emits both instruments in one boot: the law-8 ablation (hiding gameplay
 * content must make the frame DARKER) and the law-7 frame stats.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/r7', { recursive: true });
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 8000));
});

const stats = async (file) => {
  await p.waitForTimeout(800);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  if (file) writeFileSync(`shots/r7/${file}`, buf);
  return p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 120, cv.width, cv.height - 300).data;
    const L = []; let satSum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], bl = px[i + 2];
      L.push(0.2126 * r + 0.7152 * g + 0.0722 * bl);
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      satSum += mx === 0 ? 0 : (mx - mn) / mx;
    }
    L.sort((a, c) => a - c);
    const q = (f) => L[Math.floor(f * (L.length - 1))];
    const top1 = L.slice(Math.floor(0.99 * L.length));
    return {
      mean: +(L.reduce((a, c) => a + c, 0) / L.length).toFixed(1),
      p10: q(0.10), p50: q(0.50), p90: q(0.90),
      dark64: +(100 * L.filter((v) => v < 64).length / L.length).toFixed(1),
      sat: +(100 * satSum / L.length).toFixed(1),
      top1: +(top1.reduce((a, c) => a + c, 0) / top1.length).toFixed(1),
    };
  }, buf.toString('base64'));
};

const hide = (v) => p.evaluate((v) => {
  const g = window.__game;
  g.towers.group.visible = v; g.creeps.group.visible = v; g.fx.group.visible = v;
}, v);

const R7 = () => p.evaluate(() => {
  const g = window.__game, u = g.arena.uniforms;
  u.uAlbedoGain.value = 0.30;
  u.uSpecTint.value.set(0.34, 0.36, 0.43);
  g.arena.rimMaterial.color.setHex(0x555349);
  if (g.arena.talus) g.arena.talus.visible = true;
  g.pipeline.passes.gtao.updateGtaoMaterial({
    radius: 3.0, distanceExponent: 1.0, thickness: 5.0, scale: 2.0,
    samples: 12, distanceFallOff: 0.9, screenSpaceRadius: false });
});
const R6 = () => p.evaluate(() => {
  const g = window.__game, u = g.arena.uniforms;
  u.uAlbedoGain.value = 0.86;
  u.uSpecTint.value.set(0.62, 0.66, 0.78);
  g.arena.rimMaterial.color.setHex(0x8f8d8c);
  if (g.arena.talus) g.arena.talus.visible = false;
  g.pipeline.passes.gtao.updateGtaoMaterial({
    radius: 1.15, distanceExponent: 1.6, thickness: 0.6, scale: 1.3,
    samples: 12, distanceFallOff: 0.9, screenSpaceRadius: false });
});

const run = async (label, apply, tag) => {
  await apply();
  await p.waitForTimeout(700);
  await hide(true);
  const full = await stats(`${tag}-full.png`);
  await hide(false);
  const board = await stats(`${tag}-boardonly.png`);
  await hide(true);
  console.log('\n===', label, '===');
  console.log('full frame     ', JSON.stringify(full));
  console.log('board only     ', JSON.stringify(board));
  console.log('LAW 8  mean delta (board-only minus full):',
    (board.mean - full.mean).toFixed(1),
    (board.mean < full.mean ? 'PASS (hiding content darkens the frame)'
                            : 'FAIL (hiding content BRIGHTENS the frame)'));
  console.log('LAW 8  top1% : board', board.top1, ' full', full.top1,
    '->', (full.top1 - board.top1).toFixed(1), 'L of headroom for content');
  console.log('LAW 7  mean', full.mean, '(100-130)  p90', full.p90,
    '(>185)  <64', full.dark64 + '% (<30%)  sat', full.sat + '%');
  return full;
};

await run('ROUND 6 (my changes reverted at runtime)', R6, 'r6');
await run('ROUND 7 (as committed)', R7, 'r7');

// Is the large dark pool on the board the new GTAO, or the lane?
await p.evaluate(() => { window.__game.pipeline.passes.gtao.enabled = false; });
const noao = await stats('r7-noao.png');
await p.evaluate(() => { window.__game.pipeline.passes.gtao.enabled = true; });
const withao = await stats(null);
console.log('\nGTAO on vs off, full frame mean:', withao.mean, 'vs', noao.mean,
  ' delta', (withao.mean - noao.mean).toFixed(2));
await b.close();
