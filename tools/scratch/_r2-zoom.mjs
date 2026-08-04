#!/usr/bin/env node
/**
 * Crop the same box out of N captures and stack them side by side, labelled.
 *
 *   node tools/scratch/_r2-zoom.mjs --box 860,300,1080,470 --out cmp/z.png a.png b.png
 *
 * Composed in a browser page because that is the only image toolkit this repo
 * already depends on (see tools/compare.mjs, which does the same trick).
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [bx, by, bw, bh] = arg('box', '860,300,220,180').split(',').map(Number);
const SCALE = Number(arg('scale', 3));
const SRCW = Number(arg('srcw', 1920));
const OUT = resolve(arg('out', 'cmp/zoom.png'));
mkdirSync(dirname(OUT), { recursive: true });

const imgs = files.map((f) => ({
  name: basename(f),
  uri: `data:image/png;base64,${readFileSync(resolve(f)).toString('base64')}`,
}));

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Math.max(320, imgs.length * (bw * SCALE + 16) + 16), height: bh * SCALE + 46 },
});
await page.setContent(`<body style="margin:0;background:#111;display:flex;gap:16px;padding:8px">
${imgs.map((im) => `<figure style="margin:0">
  <div style="width:${bw * SCALE}px;height:${bh * SCALE}px;overflow:hidden;position:relative">
    <img src="${im.uri}" style="position:absolute;left:${-bx * SCALE}px;top:${-by * SCALE}px;
         width:${SRCW * SCALE}px;image-rendering:pixelated">
  </div>
  <figcaption style="color:#ddd;font:12px system-ui;padding:4px 0">${im.name}</figcaption>
</figure>`).join('')}
</body>`);
writeFileSync(OUT, await page.screenshot({ type: 'png' }));
console.log(OUT);
await browser.close();
