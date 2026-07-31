import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const HIDE = process.argv[2] || 'none';
const browser = await chromium.launch({ args:['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport:{width:1280,height:720} });
page.on('pageerror', e=>console.log('ERR',e.message));
await page.route('**/@vite/client', r=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await page.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await page.waitForFunction(()=>!!window.__game,null,{timeout:30000});
await page.evaluate(async (hide)=>{
  const g=window.__game; const wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let n=0;n<120&&document.getElementById('boot');n++) await wait(150);
  await wait(400);
  let seed=1337; Math.random=()=>{seed=(seed*1664525+1013904223)%4294967296; return seed/4294967296;};
  g.state.elements=['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks=0; g.state.gold=999999; g.hud.closeElementPicker(); g.hud.refreshBuildBar();
  g.state.phase='combat';
  const P=g.projectiles;
  if(hide==='ribbon') P.ribbons.mesh.visible=false;
  if(hide==='bb') P.renderer.billboards.visible=false;
  if(hide==='pts'){ g.fx.energy.points.visible=false; g.fx.matter.points.visible=false; }
  if(hide==='arcs') g.fx.arcs.mesh.visible=false;
  const els=['fire','water','nature','earth','light','dark'];
  const COLOR={fire:0xff5a1f,water:0x2fa8ff,nature:0x4fe07a,earth:0xc08a4a,light:0xfff2c4,dark:0x8a4fd6};
  const ACC={fire:0xffd166,water:0xa8e8ff,nature:0xd6ff8f,earth:0xf0d6a8,light:0xffffff,dark:0xdca8ff};
  const pulse=()=>{ for(let k=0;k<6;k++){ g.fx.impactElemental(-15+k*6,0.6,-9,els[k],1.5); g.fx.explosion(-15+k*6,0.6,-1,2.6,[0.45,0.45,0.45],els[k]); }
    for(let k=0;k<3;k++) g.fx.lightning(-9+k*6,1.4,7,-5+k*6,1.6,11,[0.9,0.75,0.35]); };
  pulse(); const pulser=setInterval(pulse,320);
  const spawner=setInterval(()=>{ for(let k=0;k<6;k++){const e=els[k];
    P.spawn({x:-15+k*6,y:3,z:15,tx:-15+k*6,ty:0.6,tz:-12,target:-1,speed:e==='light'?90:e==='earth'?24:36,color:COLOR[e],accent:ACC[e],towerId:-1,stats:{damage:1},arc:e==='earth'?0.35:0.05,element:e});}},900);
  await wait(1450);
  clearInterval(spawner); clearInterval(pulser);
},HIDE);
await page.waitForTimeout(300);
writeFileSync(`/Users/pouetpouets/code/element-td-3d/shots/dbg-${HIDE}.png`, await page.screenshot({type:'png'}));
await browser.close();
console.log('ok',HIDE);
