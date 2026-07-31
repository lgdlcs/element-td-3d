import { chromium } from 'playwright';
const browser = await chromium.launch({ args:['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport:{width:1280,height:720} });
page.on('pageerror', e=>console.log('ERR',e.message));
await page.route('**/@vite/client', r=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await page.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await page.waitForFunction(()=>!!window.__game,null,{timeout:30000});
const out = await page.evaluate(async ()=>{
  const g=window.__game; const wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let n=0;n<120&&document.getElementById('boot');n++) await wait(150);
  await wait(400);
  g.state.phase='combat';
  const P=g.projectiles;
  P.spawn({x:0,y:3,z:15,tx:0,ty:0.6,tz:-12,target:-1,speed:36,color:0xff5a1f,accent:0xffd166,towerId:-1,stats:{damage:1},arc:0.05,element:'fire'});
  await wait(600);
  const res={ live:[], ribbonUsed:P.ribbons.used, slots:P.ribbons.slots, drawRange:P.ribbons.geo.drawRange.count };
  for(let i=0;i<P.alive.length;i++) if(P.alive[i]) res.live.push({i,x:P.x[i].toFixed(2),y:P.y[i].toFixed(2),z:P.z[i].toFixed(2),cnt:P.trailCount[i]});
  // dump first slot spine
  const pos=P.ribbons.pos; const N=P.ribbons.nodes;
  res.spine0=[]; for(let k=0;k<N;k++){const v=(0*N*2+k*2)*3;res.spine0.push([pos[v].toFixed(1),pos[v+1].toFixed(1),pos[v+2].toFixed(1)]);}
  res.widths0=[]; for(let k=0;k<N;k++){res.widths0.push(P.ribbons.param[(0*N*2+k*2)*2+1].toFixed(3));}
  // scene ribbon meshes
  res.meshes=[]; g.scene.traverse(o=>{ if(o.isMesh&&o.material&&o.material.type==='ShaderMaterial') res.meshes.push({name:o.name||o.type,ro:o.renderOrder,count:o.count??null,dr:o.geometry.drawRange.count}); });
  return res;
});
console.log(JSON.stringify(out,null,1));
await browser.close();
