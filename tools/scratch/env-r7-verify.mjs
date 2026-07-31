import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio']});
const p = await b.newPage({viewport:{width:1280,height:720}});
const errs=[];
p.on('console', m => { if(m.type()==='error') errs.push(m.text().slice(0,200)); });
await p.route('**/@vite/client', r => r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await p.goto('http://localhost:5273/?q=ultra', {waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
await p.waitForTimeout(3500);
const out = await p.evaluate(()=>{
  const rows=[]; let tris=0, dc=0;
  window.__game.scene.traverse(o=>{
    if(!o.isMesh) return;
    if(!/^surround/.test(o.name||'')) return;
    const g=o.geometry; const n=g.index?g.index.count/3:g.attributes.position.count/3;
    const c=o.isInstancedMesh?o.count:1;
    rows.push([o.name, c, Math.round(n*c)]);
    tris+=n*c; dc++;
  });
  return {rows, tris:Math.round(tris), dc};
});
console.log('surround meshes:', out.dc, ' triangles:', out.tris);
for(const r of out.rows) console.log(r[0].padEnd(20), String(r[1]).padStart(5), String(r[2]).padStart(8));
console.log('console errors:', errs.length ? errs : 'none');
await b.close();
