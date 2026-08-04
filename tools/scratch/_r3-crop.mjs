#!/usr/bin/env node
/** node tools/scratch/_r3-crop.mjs <in.png> <x> <y> <w> <h> <scale> <out.png> */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, x, y, w, h, s, out] = process.argv.slice(2);
const b64 = readFileSync(inp).toString('base64');
const br = await chromium.launch({ args: ['--hide-scrollbars'] });
const pg = await br.newPage({ viewport: { width: Math.round(+w * +s), height: Math.round(+h * +s) } });
await pg.setContent(`<style>*{margin:0;padding:0}canvas{display:block}</style><canvas id="c"></canvas>
<script>
window.done=new Promise(res=>{const i=new Image();i.onload=()=>{const c=document.getElementById('c');
c.width=${Math.round(+w * +s)};c.height=${Math.round(+h * +s)};const x=c.getContext('2d');
x.imageSmoothingEnabled=false;x.drawImage(i,${x},${y},${w},${h},0,0,c.width,c.height);res(1)};
i.src='data:image/png;base64,${b64}';});
</script>`);
await pg.evaluate(() => window.done);
writeFileSync(out, await pg.screenshot());
await br.close();
console.log(out);
