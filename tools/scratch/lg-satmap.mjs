#!/usr/bin/env node
/**
 * Where is the saturation missing? A whole-frame mean hides this completely.
 *
 *   node tools/scratch/lg-satmap.mjs shots/x.png reference/etd2-04-*.jpg
 *
 * Bins each image into a 4x3 grid and prints mean luminance + mean saturation
 * per cell, plus a five-bucket saturation histogram. Written during the round-6
 * day relight, when the frame mean said "8 points of saturation short" and the
 * grid said something much more actionable: our mid-ground cells ran S35-48
 * where the reference runs S51-70, while our >80% chroma bucket was already AT
 * reference level. That is the difference between "turn saturation up" (which
 * made the emitters fluorescent) and "boost mid chroma only" (which worked).
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 300 } });
const run = async (path) => {
  const ext = path.endsWith('.jpg') ? 'jpeg' : 'png';
  const d = readFileSync(path).toString('base64');
  return p.evaluate(async ([d, ext]) => {
    const img = new Image(); img.src = `data:image/${ext};base64,`+d; await img.decode();
    const cv=document.createElement('canvas'); cv.width=img.width; cv.height=img.height;
    const cx=cv.getContext('2d'); cx.drawImage(img,0,0);
    const px=cx.getImageData(0,0,cv.width,cv.height).data;
    const W=cv.width,H=cv.height;
    // 4x3 grid of cells: mean L and mean sat per cell
    const rows=3, cols=4; const out=[];
    for(let r=0;r<rows;r++){ const line=[];
      for(let c=0;c<cols;c++){
        let n=0,Ls=0,Ss=0;
        for(let y=Math.floor(r*H/rows); y<Math.floor((r+1)*H/rows); y+=2)
        for(let x=Math.floor(c*W/cols); x<Math.floor((c+1)*W/cols); x+=2){
          const i=(y*W+x)*4, R=px[i],G=px[i+1],B=px[i+2];
          Ls+=0.2126*R+0.7152*G+0.0722*B;
          const mx=Math.max(R,G,B),mn=Math.min(R,G,B); Ss+=mx===0?0:(mx-mn)/mx; n++;
        }
        line.push(`L${(Ls/n).toFixed(0).padStart(3)}/S${(100*Ss/n).toFixed(0).padStart(2)}`);
      } out.push(line.join(' | ')); }
    // saturation histogram
    let hist=[0,0,0,0,0];
    for(let i=0;i<px.length;i+=4){const mx=Math.max(px[i],px[i+1],px[i+2]),mn=Math.min(px[i],px[i+1],px[i+2]);
      const s=mx===0?0:(mx-mn)/mx; hist[Math.min(4,Math.floor(s*5))]++;}
    const t=px.length/4;
    return {grid:out, hist:hist.map(v=>+(100*v/t).toFixed(1))};
  }, [d, ext]);
};
for (const f of process.argv.slice(2)) {
  const r = await run(f);
  console.log('\n== '+f);
  for (const l of r.grid) console.log('  '+l);
  console.log('  sat buckets 0-20/20-40/40-60/60-80/80-100%:', r.hist.join(' '));
}
await b.close();
