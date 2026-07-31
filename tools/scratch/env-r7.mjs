#!/usr/bin/env node
/**
 * env-r7.mjs — surround vs board value/chroma, from a capture.
 *
 *   node tools/scratch/env-r7.mjs shots/shot.png
 *
 * Samples hand-picked boxes (1920x1080 frame, UI avoided) in the surround and
 * on the board, and reports mean luminance, saturation and hue for each, plus
 * the surround:board ratio the Art Bible law 4 / law 8 are stated in, and the
 * p10-p90 luminance SPREAD inside the surround (which is what "one flat green"
 * is a complaint about).
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(file) {
  const buf = readFileSync(file);
  let p = 8, W = 0, H = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * ch;
  const out = Buffer.alloc(H * stride);
  let ro = 0;
  for (let y = 0; y < H; y++) {
    const ft = raw[ro++];
    const line = raw.subarray(ro, ro + stride); ro += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
  }
  return { W, H, ch, data: out };
}

const L = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function hs(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = 60 * ((((g - b) / d) % 6) + 6) % 360;
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: mx > 0 ? d / mx : 0 };
}

// [label, x, y, w, h] in a 1920x1080 frame.
const BOXES = [
  ['sur.NW',      60, 430, 130, 110],
  ['sur.W',      120, 640, 120, 110],
  ['sur.SW',     150, 880, 140,  90],
  ['sur.N',      640, 120, 160,  90],
  ['sur.NE',    1490, 110, 130, 100],
  ['sur.E',     1770, 500, 120, 130],
  ['sur.SE',    1700, 810, 140, 100],
  ['sur.road',  1580, 180,  90, 120],
  ['board.W',    480, 620, 100,  90],
  ['board.S',    900, 865, 120,  70],
  ['board.E',   1420, 600, 100,  90],
  ['board.N',   1150, 300,  90,  70],
];

const file = process.argv[2] || 'shots/shot.png';
const img = decodePNG(file);
const { W, ch, data } = img;

const groups = { sur: [], board: [] };
const rows = [];
for (const [name, x, y, w, h] of BOXES) {
  let n = 0, sr = 0, sg = 0, sb = 0, sl = 0, ss = 0, sh = 0, shx = 0, shy = 0;
  const lums = [];
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const o = (j * W + i) * ch;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const l = L(r, g, b);
      const { h: hh, s } = hs(r, g, b);
      sr += r; sg += g; sb += b; sl += l; ss += s;
      shx += Math.cos(hh * Math.PI / 180); shy += Math.sin(hh * Math.PI / 180);
      lums.push(l); n++;
    }
  }
  lums.sort((a, b) => a - b);
  const p = (q) => lums[Math.floor(q * (lums.length - 1))];
  const hue = (Math.atan2(shy / n, shx / n) * 180 / Math.PI + 360) % 360;
  rows.push({ name, L: sl / n, sat: ss / n * 100, hue, p10: p(0.10), p90: p(0.90),
    rgb: [sr / n, sg / n, sb / n] });
  const key = name.split('.')[0];
  groups[key].push(...lums);
}

const fmt = (v, d = 1) => v.toFixed(d).padStart(6);
console.log(`\n${file}`);
console.log('box              mean     p10    p90  spread   sat%   hue   rgb');
for (const r of rows) {
  console.log(`${r.name.padEnd(14)} ${fmt(r.L)} ${fmt(r.p10)} ${fmt(r.p90)} ${fmt(r.p90 - r.p10)} ${fmt(r.sat)} ${fmt(r.hue, 0)}   ${r.rgb.map((v) => Math.round(v)).join(',')}`);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sm = mean(groups.sur), bm = mean(groups.board);
const sall = groups.sur.slice().sort((a, b) => a - b);
const sp = (q) => sall[Math.floor(q * (sall.length - 1))];
console.log(`\nsurround mean ${sm.toFixed(1)}   board mean ${bm.toFixed(1)}   ratio ${(sm / bm).toFixed(3)}  (law 4/8 target 0.55-0.65)`);
console.log(`surround p10 ${sp(0.10).toFixed(1)}  p90 ${sp(0.90).toFixed(1)}  spread ${(sp(0.90) - sp(0.10)).toFixed(1)}`);
