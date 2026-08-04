#!/usr/bin/env node
/**
 * Contact sheet of the six placementReason ghosts, side by side and labelled,
 * with a desaturated copy underneath.
 *
 *   node tools/scratch/f3-sheet.mjs --tag final
 *
 * Six crops judged one at a time is not the question the feature asks. The
 * question is whether a player can tell them APART, and that can only be judged
 * on one image with all six on it. The greyscale row is the cheap proxy for a
 * red/green-blind read: if two states are only a hue apart they collapse there.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TAG = arg('tag', 'final');
const NAMES = ['valid', 'occupied', 'creep', 'seal', 'stacks', 'poor'];
const data = NAMES.map((n) => 'data:image/png;base64,' + readFileSync(`shots/f3-${TAG}-${n}.png`).toString('base64'));

const W = 420, H = 320, PAD = 10, ROW = H + 34 + PAD;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 3 * (W + PAD) + PAD, height: 4 * ROW + PAD + 24 } });
await page.setContent(`<body style="margin:0;background:#0b0d12"><canvas id=c width=${3 * (W + PAD) + PAD} height=${4 * ROW + PAD + 24}></canvas></body>`);

await page.evaluate(async ({ names, data, W, H, PAD, ROW }) => {
  const cv = document.getElementById('c');
  const cx = cv.getContext('2d');
  cx.fillStyle = '#0b0d12'; cx.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < names.length; i++) {
    const img = new Image(); img.src = data[i]; await img.decode();
    const col = i % 3, row = (i / 3) | 0;
    const x = PAD + col * (W + PAD), y = PAD + row * ROW;
    // Centre crop: the pad sits at the centre of every capture by construction.
    cx.drawImage(img, (img.width - 440) / 2, (img.height - 336) / 2, 440, 336, x, y, W, H);
    cx.strokeStyle = '#2a3040'; cx.strokeRect(x + 0.5, y + 0.5, W, H);
    cx.fillStyle = '#dfe6f2'; cx.font = '600 17px system-ui,sans-serif';
    cx.fillText(names[i], x + 4, y + H + 22);
  }
  // Desaturated twin of the whole colour block.
  const g = cx.getImageData(0, PAD, cv.width, ROW * 2);
  for (let p = 0; p < g.data.length; p += 4) {
    const l = 0.2126 * g.data[p] + 0.7152 * g.data[p + 1] + 0.0722 * g.data[p + 2];
    g.data[p] = g.data[p + 1] = g.data[p + 2] = l;
  }
  cx.putImageData(g, 0, PAD + ROW * 2 + 24);
  cx.fillStyle = '#8fa0bd'; cx.font = '600 15px system-ui,sans-serif';
  cx.fillText('the same six, desaturated — colour-blind proxy', PAD, PAD + ROW * 2 + 16);
}, { names: NAMES, data, W, H, PAD, ROW });

writeFileSync(`shots/f3-${TAG}-sheet.png`, await page.screenshot({ type: 'png' }));
console.log(`wrote shots/f3-${TAG}-sheet.png`);
await browser.close();
