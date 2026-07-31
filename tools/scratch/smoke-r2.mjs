import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader']});
const p = await b.newPage({viewport:{width:900,height:600}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.route('**/@vite/client', r=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await p.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const g=window.__game, wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let n=0;n<120&&document.getElementById('boot');n++) await wait(150);
  g.state.elements=['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks=0; g.hud.closeElementPicker(); g.state.phase='combat';
  await wait(400);
  const fx=g.fx, THREE_NORMAL=1, THREE_ADD=2;
  for (const e of ['fire','water','nature','earth','light','dark']) {
    fx.impactElemental(0,0.6,0,e,2.0);
    fx.explosion(0,0.6,0,3.0,[0.5,0.5,0.5],e);
    fx.registerSpawnHint(0,2,0,1,0,0,e); fx.muzzleFlash(0,2,0,0xff5a1f,1.4);
  }
  await wait(120);
  // scan every live smoke particle's colour
  let maxSmoke=0, smokeCount=0, maxEnergy=0;
  for(let i=0;i<fx.max;i++){
    if(fx.life[i]<=0) continue;
    const c=Math.max(fx.col[i*3],fx.col[i*3+1],fx.col[i*3+2]);
    if(fx.kind[i]===1){ smokeCount++; if(c>maxSmoke) maxSmoke=c; }
    else if(c>maxEnergy) maxEnergy=c;
  }
  return {
    energyBlending: fx.energy.mat.blending, matterBlending: fx.matter.mat.blending,
    
    matterDepthWrite: fx.matter.mat.depthWrite,
    smokeCount, maxSmokeLinear:+maxSmoke.toFixed(4), maxEnergyLinear:+maxEnergy.toFixed(3),
    bloomThreshold: 1.05,
    smokeCanBloom: maxSmoke > 1.05,
  };
}),null,1));
await b.close();
