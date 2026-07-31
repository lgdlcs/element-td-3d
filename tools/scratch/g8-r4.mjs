/**
 * G8, measured instead of asserted.
 *
 * "The maze is legible" is exactly the kind of claim that survived three rounds
 * of tuning against a mask that was never rebuilt. So: classify a lattice of
 * world points by the SAME wear field the shader uses, project them through the
 * live camera, sample the rendered frame at those pixels, and report the
 * separation between the two populations.
 *
 * A path you cannot see is a path whose pixels have the same distribution as
 * the stone beside it.
 *
 *   node tools/scratch/g8-r4.mjs [--js "..."]
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('out', '/tmp/g8.png');
const JS = arg('js', '');

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
// Neutralise Vite HMR. With five agents writing source concurrently, a hot
// reload mid-measurement either destroys the execution context outright or,
// worse, silently re-boots the game so the numbers describe a different build
// than the one under test. Same stub tools/shot.mjs uses.
await page.route('**/@vite/client', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' }));
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
  const MAZE = [
    ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
    ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
    ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
    ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
    ['dark', 14, 15],
  ];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  g.state.wave = 21; g.state.phase = 'prep';
  await wait(1500);
});
if (JS) await page.evaluate((s) => { const g = window.__game; eval(s); }, JS);
await page.waitForTimeout(900);

// Classify + project. Prep phase, no creeps, no projectiles: the only thing in
// these pixels is terrain.
const pts = await page.evaluate(() => {
  const g = window.__game, a = g.arena, cam = g.pipeline.camera ?? g.rig.camera;
  const THREE = window.THREE;
  const u = a.uniforms;
  const lo = u.uKerbLo.value, hi = u.uKerbHi.value;
  const W = 52, H = 40;
  const lane = [], deck = [];
  const v = new (cam.position.constructor)();
  for (let z = -H / 2 + 2; z < H / 2 - 2; z += 0.6) {
    for (let x = -W / 2 + 2; x < W / 2 - 2; x += 0.6) {
      const mk = a.sampleMask(x, z);
      const wear = mk[0];
      // Only unambiguous samples, and only away from the wall itself, so the
      // measurement is lane-floor vs terrace-top and not a blur of the two.
      let cls = null;
      if (wear > hi + 0.16) cls = lane;
      else if (wear < lo - 0.16) cls = deck;
      if (!cls) continue;
      const y = a.surfaceHeightAt(x, z);
      v.set(x, y, z);
      v.project(cam);
      if (v.z > 1 || Math.abs(v.x) > 0.98 || Math.abs(v.y) > 0.98) continue;
      const px = Math.round((v.x * 0.5 + 0.5) * 1920);
      const py = Math.round((-v.y * 0.5 + 0.5) * 1080);
      // Stay out of the HUD panels.
      if (py < 90 || py > 940 || px < 300 || px > 1620) continue;
      cls.push([px, py]);
    }
  }
  return { lane, deck };
});

const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(OUT, buf);
await browser.close();

// ---- decode + measure ------------------------------------------------------
function decodePNG(file) {
  const b = readFileSync(file);
  let p = 8, W = 0, H = 0, ct = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    const d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * ch, out = Buffer.alloc(H * stride);
  let ro = 0;
  for (let y = 0; y < H; y++) {
    const ft = raw[ro++]; const line = raw.subarray(ro, ro + stride); ro += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const A = i >= ch ? cur[i - ch] : 0, B = prev ? prev[i] : 0;
      const C = (prev && i >= ch) ? prev[i - ch] : 0;
      let vv = line[i];
      if (ft === 1) vv += A; else if (ft === 2) vv += B; else if (ft === 3) vv += (A + B) >> 1;
      else if (ft === 4) { const pp = A + B - C, pa = Math.abs(pp - A), pb = Math.abs(pp - B), pc = Math.abs(pp - C); vv += (pa <= pb && pa <= pc) ? A : (pb <= pc ? B : C); }
      cur[i] = vv & 255;
    }
  }
  return { W, H, ch, data: out };
}
const img = decodePNG(OUT);
function stats(list) {
  const L = [], hs = [];
  for (const [x, y] of list) {
    const i = (y * img.W + x) * img.ch;
    const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
    L.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
    let h = 0;
    if (d > 2) {
      if (mx === R) h = 60 * (((G - B) / d) % 6);
      else if (mx === G) h = 60 * ((B - R) / d + 2);
      else h = 60 * ((R - G) / d + 4);
      if (h < 0) h += 360;
    } else h = NaN;
    if (!isNaN(h)) hs.push(h);
    hs.sat = 0;
  }
  const m = L.reduce((a, b) => a + b, 0) / L.length;
  const sd = Math.sqrt(L.reduce((a, b) => a + (b - m) ** 2, 0) / L.length);
  return { n: L.length, mean: +m.toFixed(1), sd: +sd.toFixed(1) };
}
const lane = stats(pts.lane), deck = stats(pts.deck);
// Cohen's d: how many standard deviations apart the two populations are. This
// is the number that matters — a big mean gap inside a noisy plate is not a
// path you can see.
const pooled = Math.sqrt((lane.sd ** 2 + deck.sd ** 2) / 2);
const d = Math.abs(lane.mean - deck.mean) / pooled;
console.log(JSON.stringify({
  out: OUT,
  laneFloor: lane, terraceTop: deck,
  meanGapL: +(deck.mean - lane.mean).toFixed(1),
  cohensD: +d.toFixed(2),
  errors: logs.filter((l) => /\[error\]|\[pageerror\]/.test(l)),
}, null, 1));
