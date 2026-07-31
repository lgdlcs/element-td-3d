import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const p = await b.newPage({viewport:{width:1280,height:720}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.route('**/@vite/client', r=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await p.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const g=window.__game, wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let n=0;n<120&&document.getElementById('boot');n++) await wait(150);
  await wait(400);
  g.state.elements=['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks=0; g.state.gold=999999; g.hud.closeElementPicker(); g.hud.refreshBuildBar();
  for (const [k,c,r] of [['fire',8,7],['water',10,7],['light',16,7]]) g.build(k,c,r);
  g.state.phase='combat';
  const c=g.creeps, held=[];
  for (const tw of g.towers.towers){ const i=c.spawn('armored',4e7,6,0); if(i<0) continue; held.push(i);
    c.x[i]=tw.x; c.z[i]=tw.z+3.2; c.vx[i]=1e-4; c.vz[i]=1e-4; c.speed[i]=0; c.baseSpeed[i]=0; c.spawnT[i]=1; }
  setInterval(()=>{for(const i of held){ if(c.alive[i]){c.hp[i]=c.maxHp[i]; c.speed[i]=0;} }},60);
  const log=[]; const fx=g.fx;
  const origAlloc=fx.muzzles.alloc.bind(fx.muzzles);
  fx.muzzles.alloc=(x,y,z,dx,dy,dz,...rest)=>{ if(log.length<12) log.push({dx:+dx.toFixed(2),dy:+dy.toFixed(2),dz:+dz.toFixed(2)}); return origAlloc(x,y,z,dx,dy,dz,...rest); };
  let hintHits=0, hintMiss=0;
  const origMF=fx.muzzleFlash.bind(fx);
  fx.muzzleFlash=(x,y,z,col,s)=>{ const h=fx._hints.find(h=>fx.time-h.t<=0.12 && (h.x-x)**2+(h.y-y)**2+(h.z-z)**2<2.25); if(h) hintHits++; else hintMiss++; return origMF(x,y,z,col,s); };
  await wait(2500);
  return {log, hintHits, hintMiss, towers:g.towers.towers.length};
}),null,1));
await b.close();
