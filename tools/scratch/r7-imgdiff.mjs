/** Offline luminance diff between two PNGs: node r7-imgdiff.mjs a.png b.png */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [A, B] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
const r = await p.evaluate(async ([a, c]) => {
  const load = async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    return { d: cx.getImageData(0, 120, cv.width, cv.height - 300).data, w: cv.width };
  };
  const A = await load(a), C = await load(c);
  let sum = 0, n = 0, worst = 0, over2 = 0;
  for (let i = 0; i < A.d.length; i += 4) {
    const la = 0.2126 * A.d[i] + 0.7152 * A.d[i + 1] + 0.0722 * A.d[i + 2];
    const lc = 0.2126 * C.d[i] + 0.7152 * C.d[i + 1] + 0.0722 * C.d[i + 2];
    const dd = la - lc; sum += dd; n++;
    if (Math.abs(dd) > Math.abs(worst)) worst = dd;
    if (Math.abs(dd) > 2) over2++;
  }
  return { meanDelta: +(sum / n).toFixed(2), maxDelta: +worst.toFixed(1),
           pctOver2L: +(100 * over2 / n).toFixed(1) };
}, [readFileSync(A).toString('base64'), readFileSync(B).toString('base64')]);
console.log(A, 'minus', B, JSON.stringify(r));
await b.close();
