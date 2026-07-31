/**
 * Does the drift exist, and how much of the plate does it cover?
 * A/B the same frame with uDrift 0 and 1, classify board pixels by the mask,
 * and report the fraction that moved plus the value spread before/after.
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
const browser = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('pageerror', (e) => logs.push(e.message));
await page.route('**/@vite/client', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await page.evaluate(async () => {
  const g = window.__game; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let n = 0; n < 200 && document.getElementById('boot'); n++) await wait(150);
  let seed = 1337; Math.random = () => { seed = (seed*1664525+1013904223)%4294967296; return seed/4294967296; };
  g.state.elements=['fire','water','nature','earth','light','dark']; g.state.pendingElementPicks=0; g.state.gold=999999;
  g.hud.closeElementPicker(); g.state.phase='prep'; g.hud.refreshBuildBar();
  const MAZE=[['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of MAZE) g.build(k,c,r);
  await wait(1500);
});
const shots = {};
for (const v of [0, 1]) {
  await page.evaluate((val) => { window.__game.arena.uniforms.uDrift.value = val; }, v);
  await page.waitForTimeout(700);
  const b = await page.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`/tmp/drift_${v}.png`, b);
  shots[v] = `/tmp/drift_${v}.png`;
}
await page.evaluate(() => { window.__game.arena.uniforms.uDrift.value = 1; });
await browser.close();
function dec(file){const b=readFileSync(file);let p=8,W=0,H=0,ct=0;const idat=[];while(p<b.length){const len=b.readUInt32BE(p),t=b.toString('ascii',p+4,p+8),d=b.subarray(p+8,p+8+len);if(t==='IHDR'){W=d.readUInt32BE(0);H=d.readUInt32BE(4);ct=d[9];}else if(t==='IDAT')idat.push(d);else if(t==='IEND')break;p+=12+len;}const ch=ct===6?4:3;const raw=inflateSync(Buffer.concat(idat));const st=W*ch,out=Buffer.alloc(H*st);let ro=0;for(let y=0;y<H;y++){const ft=raw[ro++];const line=raw.subarray(ro,ro+st);ro+=st;const cur=out.subarray(y*st,(y+1)*st),prev=y>0?out.subarray((y-1)*st,y*st):null;for(let i=0;i<st;i++){const A=i>=ch?cur[i-ch]:0,B=prev?prev[i]:0,C=(prev&&i>=ch)?prev[i-ch]:0;let v=line[i];if(ft===1)v+=A;else if(ft===2)v+=B;else if(ft===3)v+=(A+B)>>1;else if(ft===4){const pp=A+B-C,pa=Math.abs(pp-A),pb=Math.abs(pp-B),pc=Math.abs(pp-C);v+=(pa<=pb&&pa<=pc)?A:(pb<=pc?B:C);}cur[i]=v&255;}}return{W,H,ch,data:out};}
const a=dec(shots[0]), b=dec(shots[1]);
let moved=0,tot=0,sum=0;const LA=[],LB=[];
for(let y=120;y<940;y+=2)for(let x=320;x<1600;x+=2){
  const i=(y*a.W+x)*a.ch;
  const la=0.2126*a.data[i]+0.7152*a.data[i+1]+0.0722*a.data[i+2];
  const lb=0.2126*b.data[i]+0.7152*b.data[i+1]+0.0722*b.data[i+2];
  tot++; const d=Math.abs(la-lb); sum+=d; if(d>3)moved++; LA.push(la);LB.push(lb);
}
const sd=(L)=>{const m=L.reduce((p,c)=>p+c,0)/L.length;return Math.sqrt(L.reduce((p,c)=>p+(c-m)**2,0)/L.length);};
console.log(JSON.stringify({sampled:tot,pctPixelsMoved:+(100*moved/tot).toFixed(1),meanDeltaL:+(sum/tot).toFixed(2),sd_noDrift:+sd(LA).toFixed(1),sd_drift:+sd(LB).toFixed(1),errors:logs},null,1));
