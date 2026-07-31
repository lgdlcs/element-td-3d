// Sample regions of a PNG (RGB8/RGBA8, non-interlaced). Zero deps.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(file) {
  const buf = readFileSync(file);
  let p = 8, W = 0, H = 0, bd = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('bit depth ' + bd);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error('color type ' + ct); })();
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
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  return { W, H, ch, data: out };
}

const img = decodePNG(process.argv[2]);
const { W, H, ch, data } = img;
function box(name, x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
  let r = 0, g = 0, b = 0, n = 0, clip = 0, crush = 0; const lums = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * ch;
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r += R; g += G; b += B; n++;
    lums.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
    if (R >= 254 && G >= 254 && B >= 254) clip++;
    if (R <= 2 && G <= 2 && B <= 2) crush++;
  }
  lums.sort((a, z) => a - z);
  const q = (t) => lums[Math.floor(t * (lums.length - 1))].toFixed(1);
  const mr = r / n, mg = g / n, mb = b / n;
  const mx = Math.max(mr, mg, mb), mn = Math.min(mr, mg, mb);
  const sat = mx > 0 ? ((mx - mn) / mx * 100).toFixed(0) : 0;
  // hue in degrees (0 red, 60 yellow, 120 green, 180 cyan, 240 blue, 300 magenta)
  let hue = 0; const dd = mx - mn;
  if (dd > 0.5) {
    if (mx === mr) hue = 60 * (((mg - mb) / dd) % 6);
    else if (mx === mg) hue = 60 * ((mb - mr) / dd + 2);
    else hue = 60 * ((mr - mg) / dd + 4);
    if (hue < 0) hue += 360;
  } else hue = NaN;
  console.log(`${name.padEnd(20)} rgb(${mr.toFixed(0)},${mg.toFixed(0)},${mb.toFixed(0)}) hue=${isNaN(hue)?' --':hue.toFixed(0).padStart(3)} L=${(0.2126*mr+0.7152*mg+0.0722*mb).toFixed(1)} sat=${sat}% p50=${q(.5)} p95=${q(.95)} p99=${q(.99)} clip=${(100*clip/n).toFixed(2)}% crush=${(100*crush/n).toFixed(2)}%`);
}
// strict G7 audit over the whole frame
{
  let z0 = 0, z255 = 0, n = 0, minc = 255, maxc = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * ch;
    for (let k = 0; k < 3; k++) { const v = data[o + k]; if (v === 0) z0++; if (v === 255) z255++; if (v < minc) minc = v; if (v > maxc) maxc = v; n++; }
  }
  console.log(`G7 AUDIT  channels==0: ${(100*z0/n).toFixed(3)}%   channels==255: ${(100*z255/n).toFixed(3)}%   min=${minc} max=${maxc}`);
}
const A = process.argv.slice(3);
if (A.length) for (let i = 0; i < A.length; i += 5) box(A[i], +A[i+1], +A[i+2], +A[i+3], +A[i+4]);
else {
  box('BOARD centre', 800, 470, 1200, 740);
  box('BOARD near-lower', 640, 620, 900, 800);
  box('BOARD far-upper', 620, 330, 900, 440);
  box('SKY above board', 950, 60, 1500, 200);
  box('BACKDROP left', 280, 130, 620, 400);
  box('BACKDROP right', 1500, 180, 1870, 520);
  box('VOID lower-left', 250, 780, 480, 960);
  box('FULL FRAME', 0, 0, W, H);
}
