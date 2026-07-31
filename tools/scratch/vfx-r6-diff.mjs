#!/usr/bin/env node
/** Pixel diff two PNGs via a headless canvas. node vfx-r6-diff.mjs a.png b.png [out.png] */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [A, B, OUT] = process.argv.slice(2);
const b64 = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const res = await page.evaluate(async ([a, b]) => {
  const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
  const ia = await load(a), ib = await load(b);
  const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
  const x = c.getContext('2d');
  x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, c.width, c.height);
  x.clearRect(0, 0, c.width, c.height); x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, c.width, c.height);
  const o = x.createImageData(c.width, c.height);
  let sum = 0, n = 0;
  for (let i = 0; i < da.data.length; i += 4) {
    const d = Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2]);
    sum += d; if (d > 12) n++;
    const v = Math.min(255, d * 3);
    o.data[i] = v; o.data[i + 1] = v; o.data[i + 2] = v; o.data[i + 3] = 255;
  }
  x.putImageData(o, 0, 0);
  return { mean: sum / (da.data.length / 4), pct: n / (da.data.length / 4) * 100, url: c.toDataURL('image/png') };
}, [b64(A), b64(B)]);
if (OUT) writeFileSync(OUT, Buffer.from(res.url.split(',')[1], 'base64'));
await browser.close();
console.log('meanDiff', res.mean.toFixed(2), 'pct>12', res.pct.toFixed(2) + '%');
