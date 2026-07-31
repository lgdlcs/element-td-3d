/**
 * Value-range comparison: ours vs every reference frame.
 *
 * Three blind critics independently reported "no key light" / "lit almost
 * entirely by ambient plus emissives" on a frame whose shadows are demonstrably
 * long, consistent and upper-left. I dismissed that twice as a misdiagnosis of
 * a flat surround. This measures whether the real difference is simply that we
 * are a night scene and the reference is a day scene.
 */
import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 300 } });

const stats = async (path) => {
  const ext = path.endsWith('.jpg') ? 'jpeg' : 'png';
  const d = readFileSync(path).toString('base64');
  return p.evaluate(async ([d, ext]) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,` + d;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    const L = [];
    let satSum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], bl = px[i + 2];
      L.push(0.2126 * r + 0.7152 * g + 0.0722 * bl);
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      satSum += mx === 0 ? 0 : (mx - mn) / mx;
    }
    L.sort((a, c) => a - c);
    const q = (f) => L[Math.floor(f * (L.length - 1))];
    const mean = L.reduce((a, c) => a + c, 0) / L.length;
    // Fraction of frame in the bottom quarter of the value range.
    const dark = L.filter((v) => v < 64).length / L.length;
    return {
      mean: +mean.toFixed(1),
      p10: +q(0.10).toFixed(0), p50: +q(0.50).toFixed(0), p90: +q(0.90).toFixed(0),
      darkFrac: +(dark * 100).toFixed(1),
      sat: +(100 * satSum / (px.length / 4)).toFixed(1),
    };
  }, [d, ext]);
};

// Any capture paths given on the command line are measured; default is the
// stored r5 candidate. Paired measurements: pass before + after together.
const OURS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!OURS.length) OURS.push('shots/r5-candidate.png');

console.log('image'.padEnd(42), 'mean  p10  p50  p90  <64%  sat%');
let ours = null;
for (const path of OURS) {
  const s = await stats(path);
  if (!ours) ours = s;
  console.log(('OURS ' + path).padEnd(42),
    String(s.mean).padStart(5), String(s.p10).padStart(4),
    String(s.p50).padStart(4), String(s.p90).padStart(4),
    String(s.darkFrac).padStart(5), String(s.sat).padStart(5));
}

let n = 0, mSum = 0, dSum = 0, sSum = 0;
for (const f of readdirSync('reference').filter((f) => /^etd2-(0[1-6]|1[0-2])/.test(f))) {
  const s = await stats('reference/' + f);
  n++; mSum += s.mean; dSum += s.darkFrac; sSum += s.sat;
  console.log(f.padEnd(42),
    String(s.mean).padStart(5), String(s.p10).padStart(4),
    String(s.p50).padStart(4), String(s.p90).padStart(4),
    String(s.darkFrac).padStart(5), String(s.sat).padStart(5));
}
console.log('\nREFERENCE MEAN:', (mSum / n).toFixed(1),
  ' dark<64:', (dSum / n).toFixed(1) + '%',
  ' sat:', (sSum / n).toFixed(1) + '%');
console.log('OURS         :', ours.mean,
  ' dark<64:', ours.darkFrac + '%',
  ' sat:', ours.sat + '%');
await b.close();
