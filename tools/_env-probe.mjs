import { chromium } from 'playwright';
const browser = await chromium.launch({ args:['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport:{width:1920,height:1080} });
await page.route('**/@vite/client', (r)=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;'}));
await page.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await page.waitForFunction(()=>!!window.__game,null,{timeout:90000});
await page.waitForTimeout(4000);
const out = await page.evaluate(()=>{
  const g=window.__game; const THREE=g.THREE ?? null;
  const cam=g.rig?.camera ?? g.camera; cam.updateMatrixWorld(true);
  const inv = cam.matrixWorld.clone();
  const camPos={x:cam.position.x,y:cam.position.y,z:cam.position.z};
  // unproject screen uv onto plane y=Y
  const V = new (g.arena.group.position.constructor)();
  function ray(ux,uy,Y){
    const V3=g.arena.group.position.constructor;
    const p=new V3(ux*2-1, -(uy*2-1), 0.5);
    p.unproject(cam);
    const d=p.clone().sub(cam.position).normalize();
    if(Math.abs(d.y)<1e-6) return null;
    const t=(Y-cam.position.y)/d.y;
    if(t<0) return {behind:true};
    return {x:+(cam.position.x+d.x*t).toFixed(1), z:+(cam.position.z+d.z*t).toFixed(1), dist:+t.toFixed(1)};
  }
  const pts={};
  const grid=[['TL',0,0],['TC',0.5,0],['TR',1,0],['ML',0,0.5],['MR',1,0.5],['BL',0,1],['BC',0.5,1],['BR',1,1],
    ['B-HUD-L',0,0.885],['B-HUD-R',1,0.885],['B-HUD-C',0.5,0.885],
    ['L-25',0,0.25],['R-25',1,0.25],['T-25',0.25,0],['T-75',0.75,0]];
  for(const [n,u,v] of grid) pts[n]=ray(u,v,-0.8);
  // project a set of world probes
  function proj(x,y,z){const V3=g.arena.group.position.constructor;const p=new V3(x,y,z);p.project(cam);return [Math.round((p.x*.5+.5)*1920),Math.round((-p.y*.5+.5)*1080)];}
  return {camPos, fov:cam.fov, pts,
    boardCorners:{ nw:proj(-27,-0.8,-21), ne:proj(27,-0.8,-21), sw:proj(-27,-0.8,21), se:proj(27,-0.8,21) },
    horizonTest: { p60:proj(0,-0.8,-60), p90:proj(0,-0.8,-90) },
  };
});
console.log(JSON.stringify(out,null,1));
await browser.close();
