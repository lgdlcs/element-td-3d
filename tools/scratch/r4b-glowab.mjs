import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const HMR='export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b=await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.route('**/@vite/client',(r)=>r.fulfill({status:200,contentType:'application/javascript',body:HMR}));
await p.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
await p.evaluate(async()=>{const g=window.__game;
 for(let n=0;n<200&&document.getElementById('boot');n++)await new Promise(r=>setTimeout(r,150));
 g.state.elements=['fire','water','nature','earth','light','dark'];g.state.gold=999999;g.hud.closeElementPicker?.();
 const keys=['fire','water','nature','earth','light','dark'];let n=0;
 for(let r=4;r<14&&n<18;r+=3)for(let c=4;c<22&&n<18;c+=3)if(g.grid.canPlaceTower(c,r)&&!g.path.wouldBlock(c,r)){g.towers.create(keys[n%6],0,c,r);n++;}
 g.path.rebuild();g.arena.markPathDirty();g.arena.refreshOccupancy();g.waves.start(21);
 await new Promise(r=>setTimeout(r,8000)); g.state.speed=0; if(g.setSpeed)g.setSpeed(0);
 g.environment.groundFog.mesh.visible=false;});
await p.waitForTimeout(700);
writeFileSync('/tmp/gl-0-fogoff.png',await p.screenshot({type:'png',timeout:120000}));
const names=await p.evaluate(()=>{const g=window.__game;const out=[];let i=0;g.towers.group.traverse(o=>{
 if(o===g.towers.group)return;
 const bb=o.geometry?(o.geometry.computeBoundingBox(),o.geometry.boundingBox):null;
 out.push({i:i++,n:o.name||'',t:o.type,geo:o.geometry?.type,mat:o.material?.name||o.material?.type,
  tris:o.geometry?.index?o.geometry.index.count/3:(o.geometry?.attributes?.position?.count??0)/3,
  bb:bb?[bb.min.toArray().map(v=>+v.toFixed(1)),bb.max.toArray().map(v=>+v.toFixed(1))]:null,
  pos:o.position.toArray().map(v=>+v.toFixed(1)), scale:o.scale.toArray().map(v=>+v.toFixed(2)),
  transparent:o.material?.transparent, blending:o.material?.blending, side:o.material?.side});});return out;});
console.log(JSON.stringify(names,null,1));
const meshes=await p.evaluate(()=>{const g=window.__game;const out=[];g.towers.group.traverse(o=>{if(o.isMesh)out.push(o);});window.__tm=out;return out.length;});
for(let k=0;k<meshes;k++){
 await p.evaluate((k)=>{window.__tm.forEach((o,i)=>o.visible=(i!==k));},k);
 await p.waitForTimeout(650);
 writeFileSync(`/tmp/gl-mesh${k}.png`,await p.screenshot({type:'png',timeout:120000}));
 console.log('hid mesh',k);
}
await b.close();
