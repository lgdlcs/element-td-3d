#!/usr/bin/env node
/**
 * Blind side-by-side comparison harness.
 *
 *   node tools/compare.mjs --a shots/final.png --b reference/etd2-01.jpg --out cmp/round1.png
 *
 * Composites two images into one frame at matched height, in a RANDOMISED
 * left/right order, labelled only "A" and "B". Writes a sidecar JSON recording
 * which side is which so the answer can be revealed AFTER a critic has judged.
 *
 * The point is that the critic agent looking at the PNG cannot tell which image
 * is ours — it has to judge on craft alone.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { randomInt } from 'node:crypto';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const A = resolve(arg('a', 'shots/01-midgame.png'));   // ours
const B = resolve(arg('b', ''));                        // reference
const OUT = resolve(arg('out', 'cmp/compare.png'));
const HEIGHT = Number(arg('h', 900));

if (!B || !existsSync(B)) {
  console.error(`Reference image not found: ${B}\nUsage: --a <ours.png> --b <reference.jpg> --out <out.png>`);
  process.exit(1);
}
if (!existsSync(A)) {
  console.error(`Our image not found: ${A}`);
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });

const mime = (p) => (extname(p).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg');
const dataUri = (p) => `data:${mime(p)};base64,${readFileSync(p).toString('base64')}`;

// Randomise which side ours lands on.
const oursOnLeft = randomInt(0, 2) === 0;
const left = oursOnLeft ? A : B;
const right = oursOnLeft ? B : A;

const html = `<!doctype html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#101013; font-family: system-ui, sans-serif; }
  .wrap { display:flex; gap:2px; background:#2a2a30; }
  .pane { position:relative; background:#000; }
  .pane img { display:block; height:${HEIGHT}px; width:auto; }
  .tag {
    position:absolute; top:14px; left:14px;
    width:38px; height:38px; border-radius:8px;
    background:rgba(0,0,0,.72); color:#fff;
    font-size:20px; font-weight:700;
    display:flex; align-items:center; justify-content:center;
    border:1px solid rgba(255,255,255,.28);
  }
</style></head><body>
  <div class="wrap">
    <div class="pane"><img src="${dataUri(left)}"><div class="tag">A</div></div>
    <div class="pane"><img src="${dataUri(right)}"><div class="tag">B</div></div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 3200, height: HEIGHT + 40 } });
await page.setContent(html, { waitUntil: 'load' });
const el = await page.$('.wrap');
const buf = await el.screenshot({ type: 'png' });
writeFileSync(OUT, buf);
await browser.close();

const key = { out: OUT, A: oursOnLeft ? 'ours' : 'reference', B: oursOnLeft ? 'reference' : 'ours', oursPath: A, referencePath: B };
writeFileSync(OUT.replace(/\.png$/, '.key.json'), JSON.stringify(key, null, 2));

console.log(JSON.stringify({ out: OUT, keyFile: OUT.replace(/\.png$/, '.key.json'), note: 'Do NOT read the key file before judging.' }, null, 2));
