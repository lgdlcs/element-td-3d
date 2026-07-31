import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const HIDE=process.argv[2]||'none';
const b = await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage({viewport:{width:1920,height:1080}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.route('**/@vite/client', r=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await p.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
const r = await p.evaluate(async (hide)=>{
  const g=window.__game, wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let n=0;n<120&&document.getElementById('boot');n++) await wait(150);
  await wait(400);
  let seed=1337; Math.random=()=>{seed=(seed*1664525+1013904223)%4294967296; return seed/4294967296;};
  g.state.elements=['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks=0; g.state.gold=999999; g.hud.closeElementPicker(); g.hud.refreshBuildBar();
  g.state.phase='combat';
  if(hide==='ptrail') g.projectiles.ribbons.mesh.visible=false;
  if(hide==='muzrib') g.fx.muzzleRibbons.mesh.visible=false;
  if(hide==='arcs') g.fx.arcs.mesh.visible=false;
  if(hide==='pts'){g.fx.energy.points.visible=false;g.fx.matter.points.visible=false;}
  const P=g.projectiles;
  const els=['fire','water','nature','earth','light','dark'];
  const COLOR={fire:0xff5a1f,water:0x2fa8ff,nature:0x4fe07a,earth:0xc08a4a,light:0xfff2c4,dark:0x8a4fd6};
  const pulse=()=>{ for(let k=0;k<6;k++){ g.fx.impactElemental(-15+k*6,0.6,-9,els[k],1.5); g.fx.explosion(-15+k*6,0.6,-1,2.6,[0.45,0.45,0.45],els[k]); }
    for(let k=0;k<3;k++) g.fx.lightning(-9+k*6,1.4,7,-5+k*6,1.6,11,[0.9,0.75,0.35]); };
  pulse(); setInterval(pulse,320);
  setInterval(()=>{ for(let k=0;k<6;k++){const e=els[k];
    P.spawn({x:-15+k*6,y:3,z:15,tx:-15+k*6,ty:0.6,tz:-12,target:-1,speed:e==='light'?90:e==='earth'?24:36,color:COLOR[e],accent:COLOR[e],towerId:-1,stats:{damage:1},arc:e==='earth'?0.35:0.05,element:e});}},900);
  await wait(1900);
  const stat=(rs)=>{const n=rs.used*rs.nodes*2; let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];
    for(let v=0;v<n;v++) for(let c=0;c<3;c++){const val=rs.pos[v*3+c]; if(val<mn[c])mn[c]=val; if(val>mx[c])mx[c]=val;}
    return {used:rs.used,min:mn.map(x=>+x.toFixed(1)),max:mx.map(x=>+x.toFixed(1))};};
  return {ptrail:stat(P.ribbons), muz:stat(g.fx.muzzleRibbons), arcs:stat(g.fx.arcs), fades:P.fade.filter(f=>f.live).length};
}, HIDE);
console.log(HIDE, JSON.stringify(r));
writeFileSync(`/Users/pouetpouets/code/element-td-3d/shots/strk-${HIDE}.png`, await p.screenshot({type:'png'}));
await b.close();
