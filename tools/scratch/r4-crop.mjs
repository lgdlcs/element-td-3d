#!/usr/bin/env node
// Crop + upscale a PNG so creeps can actually be inspected.
//   node tools/scratch/r4-crop.mjs in.png out.png x y w h [scale]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [inp, outp, x, y, w, h, scale = 3] = process.argv.slice(2);
const b64 = readFileSync(resolve(inp)).toString('base64');
const browser = await chromium.launch();
const page = await browser.newPage();
const data = await page.evaluate(async ({ b64, x, y, w, h, s }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * s; c.height = h * s;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, w, h, 0, 0, w * s, h * s);
  return c.toDataURL('image/png');
}, { b64, x: +x, y: +y, w: +w, h: +h, s: +scale });
await browser.close();
writeFileSync(resolve(outp), Buffer.from(data.split(',')[1], 'base64'));
console.log('wrote', outp, `${w * scale}x${h * scale}`);
