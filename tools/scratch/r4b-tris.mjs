import { chromium } from 'playwright';
const HMR='export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b=await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.route('**/@vite/client',(r)=>r.fulfill({status:200,contentType:'application/javascript',body:HMR}));
await p.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
await p.evaluate(async()=>{for(let n=0;n<200&&document.getElementById('boot');n++)await new Promise(r=>setTimeout(r,150));});
console.log(JSON.stringify(await p.evaluate(()=>{
  const g=window.__game; const out=[]; let tot=0;
  g.arena.group.traverse(o=>{ if(!o.isMesh&&!o.isInstancedMesh) return;
    const geo=o.geometry; const t=(geo.index?geo.index.count:geo.attributes.position.count)/3;
    const n=t*(o.isInstancedMesh?o.count:1); tot+=n;
    out.push({name:o.name||o.type,tris:Math.round(n)});});
  return {parts:out,arenaTotal:Math.round(tot),
    forgeMs:+(window.__terrainForgeMs??0).toFixed(0), forge:window.__terrainForgeParts};
}),null,1));
await b.close();
