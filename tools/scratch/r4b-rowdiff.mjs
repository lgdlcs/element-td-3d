#!/usr/bin/env node
/** Diff every ablation in shots/row against the base, over the off-board grass. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

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

const R = { x: 90, y: 430, w: 340, h: 520 };   // off-board grass, left of the board
const base = decodePNG('shots/row2/00-base.png');
const files = readdirSync('shots/row2').filter((f) => f.startsWith('ab-'));
const rows = [];
for (const f of files) {
  const img = decodePNG('shots/row2/' + f);
  let dr = 0, dg = 0, db = 0, n = 0, hot = 0;
  for (let y = R.y; y < R.y + R.h; y++) {
    for (let x = R.x; x < R.x + R.w; x++) {
      const i = (y * base.W + x) * base.ch;
      const a = base.data[i] - img.data[i];
      const b = base.data[i + 1] - img.data[i + 1];
      const c = base.data[i + 2] - img.data[i + 2];
      dr += a; dg += b; db += c; n++;
      if (Math.abs(a) + Math.abs(b) + Math.abs(c) > 24) hot++;
    }
  }
  rows.push({ f: f.replace(/^ab-|\.png$/g, ''), dR: +(dr / n).toFixed(2), dG: +(dg / n).toFixed(2), dB: +(db / n).toFixed(2), hotPct: +(hot / n * 100).toFixed(1) });
}
rows.sort((a, b) => b.hotPct - a.hotPct);
console.log('region', JSON.stringify(R));
console.log('(positive d = this object was ADDING that channel here)');
for (const r of rows) console.log(r.f.padEnd(16), 'dR', String(r.dR).padStart(7), 'dG', String(r.dG).padStart(7), 'dB', String(r.dB).padStart(7), 'hot%', r.hotPct);
