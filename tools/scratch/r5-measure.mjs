#!/usr/bin/env node
/**
 * Measure creep pixels against their own local background in a REAL frame.
 *
 *   node tools/scratch/r5-measure.mjs shots/x.png '[[px,py],...]'
 *
 * For each creep, samples an inner box (the unit) and an annulus 3x wider (the
 * board around it), and reports mean HSV of each. The point of the annulus is
 * that a global board average is not what a viewer's eye compares against —
 * they compare a unit to what it is standing on, which is different in every
 * part of the board.
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

const hsv = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx > 0 ? d / mx : 0, mx];
};

const img = decodePNG(process.argv[2]);
const pts = JSON.parse(process.argv[3]);
const IN = 26, OUT = 78;

const box = (cx, cy, r0, r1) => {
  let n = 0, sr = 0, sg = 0, sb = 0, sat = 0, hx = 0, hy = 0;
  for (let y = cy - r1; y <= cy + r1; y++) {
    for (let x = cx - r1; x <= cx + r1; x++) {
      if (x < 0 || y < 0 || x >= img.W || y >= img.H) continue;
      const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
      const d = Math.max(dx, dy);
      if (d < r0 || d > r1) continue;
      const i = (y * img.W + x) * img.ch;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const [h, s, v] = hsv(r, g, b);
      sr += r; sg += g; sb += b; sat += s;
      hx += Math.cos(h * Math.PI / 180) * s; hy += Math.sin(h * Math.PI / 180) * s;
      n++;
    }
  }
  let mh = Math.atan2(hy, hx) * 180 / Math.PI; if (mh < 0) mh += 360;
  return { n, rgb: [sr / n, sg / n, sb / n].map((v) => Math.round(v)), sat: +(sat / n).toFixed(3), hue: Math.round(mh) };
};

let dSum = 0;
for (const [x, y] of pts) {
  const inn = box(x, y, 0, IN);
  const ann = box(x, y, OUT - 22, OUT);
  // Chroma margin: how much more saturated the unit is than what it stands on.
  const margin = +(inn.sat / Math.max(ann.sat, 0.01)).toFixed(2);
  dSum += margin;
  console.log(`(${x},${y})  unit rgb=${inn.rgb} hue=${inn.hue} sat=${inn.sat}` +
    `   bg rgb=${ann.rgb} hue=${ann.hue} sat=${ann.sat}   chroma margin x${margin}`);
}
console.log('mean chroma margin', (dSum / pts.length).toFixed(2));
