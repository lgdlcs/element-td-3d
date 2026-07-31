import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const AGE = Number(process.argv[2] ?? 0.05);
const b = await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.route('**/@vite/client', r=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await p.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
await p.evaluate(async (age)=>{
  const g=window.__game, wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let n=0;n<120&&document.getElementById('boot');n++) await wait(150);
  await wait(500);
  g.state.elements=['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks=0; g.hud.closeElementPicker(); g.state.phase='combat';
  g.rig.focus(0,0,20); g.rig._polarGoal=1.05;
  await wait(1200);
  const els=['fire','water','nature','earth','light','dark'];
  const COLOR={fire:0xff5a1f,water:0x2fa8ff,nature:0x4fe07a,earth:0xc08a4a,light:0xfff2c4,dark:0x8a4fd6};
  // fire one family every 60ms so the row is staggered in age, then freeze.
  const fire=()=>{ for(let k=0;k<6;k++){
    const x=-11+k*4.4,y=2.2,z=0;
    g.fx.registerSpawnHint(x,y,z, 0.25,0.05,-1, els[k]);
    g.fx.muzzleFlash(x,y,z,COLOR[els[k]],1.4);
  }};
  fire(); setInterval(fire, 45);
  await wait(600);
}, AGE);

writeFileSync(`/Users/pouetpouets/code/element-td-3d/shots/muz-age-${AGE}.png`, await p.screenshot({type:'png'}));
await b.close();
console.log('ok',AGE);
