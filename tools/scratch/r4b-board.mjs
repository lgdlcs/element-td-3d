#!/usr/bin/env node
/**
 * Board luminance + saturation, measured through the live camera.
 *
 * Law 4: the ground is the lowest-saturation surface in frame, and the board
 * must NOT be brightened to meet the surround. So any change to the flagstone
 * map has to be checked against these two numbers, not against how it looks.
 *
 * Samples world points classified as terrace (not lane, not wall) by the same
 * wear field the shader uses, projects them, and reads the rendered pixels.
 * Prep phase, no creeps, no projectiles: only terrain is in these pixels.
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = arg('out', '/tmp/board.png');
const JS = arg('js', '');

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push('[error] ' + m.text()); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
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
  await wait(1600);
});
if (JS) await page.evaluate((s) => { const g = window.__game; eval(s); }, JS);
await page.waitForTimeout(900);

const pts = await page.evaluate(() => {
  const g = window.__game, a = g.arena, cam = g.pipeline.camera ?? g.rig.camera;
  const u = a.uniforms, lo = u.uKerbLo.value;
  const deck = [], sur = [];
  const v = new (cam.position.constructor)();
  const project = (x, y, z, into) => {
    v.set(x, y, z); v.project(cam);
    if (v.z > 1 || Math.abs(v.x) > 0.98 || Math.abs(v.y) > 0.98) return;
    const px = Math.round((v.x * 0.5 + 0.5) * 1920), py = Math.round((-v.y * 0.5 + 0.5) * 1080);
    if (py < 90 || py > 940 || px < 300 || px > 1620) return;
    into.push([px, py]);
  };
  for (let z = -18; z < 18; z += 0.6) {
    for (let x = -24; x < 24; x += 0.6) {
      if (a.sampleMask(x, z)[0] < lo - 0.16) project(x, a.surfaceHeightAt(x, z), z, deck);
    }
  }
  // Surround control ring, for the board:surround ratio.
  const SH = window.__surroundHeight ?? null;
  for (let ang = 0; ang < 6.283; ang += 0.05) {
    for (let r = 34; r < 60; r += 1.5) {
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      project(x, -1.2, z, sur);
    }
  }
  return { deck, sur };
});

const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(OUT, buf);
await browser.close();

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
function stat(list) {
  let L = [], S = [], hx = 0, hy = 0;
  for (const [x, y] of list) {
    const i = (y * img.W + x) * img.ch;
    const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
    L.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
    S.push(mx > 0 ? d / mx : 0);
    if (d > 2) {
      let h = mx === R ? 60 * (((G - B) / d) % 6) : mx === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
      if (h < 0) h += 360;
      const rad = h * Math.PI / 180; hx += Math.cos(rad); hy += Math.sin(rad);
    }
  }
  const m = (a) => a.reduce((p, q) => p + q, 0) / a.length;
  const mean = m(L);
  const sd = Math.sqrt(m(L.map((v) => (v - mean) ** 2)));
  let hue = Math.atan2(hy, hx) * 180 / Math.PI; if (hue < 0) hue += 360;
  return { n: L.length, L: +mean.toFixed(1), sd: +sd.toFixed(1), satPct: +(m(S) * 100).toFixed(1), hue: +hue.toFixed(0) };
}
const deck = stat(pts.deck), sur = stat(pts.sur);
let dh = Math.abs(deck.hue - sur.hue); if (dh > 180) dh = 360 - dh;
console.log(JSON.stringify({
  out: OUT, terrace: deck, surround: sur,
  boardOverSurround: +(deck.L / sur.L).toFixed(2),
  hueOpposition: +dh.toFixed(0),
  errors: logs,
}, null, 1));
