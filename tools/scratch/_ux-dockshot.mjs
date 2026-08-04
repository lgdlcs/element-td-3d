import { chromium } from 'playwright';
const HMR='export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const OUT=process.argv[2]||'shots', TAG=process.argv[3]||'now';
const b=await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio','--hide-scrollbars']});
for (const [W,H] of [[1280,720],[1920,1080]]) {
  const p=await b.newPage({viewport:{width:W,height:H}});
  await p.route('**/@vite/client',(r)=>r.fulfill({status:200,contentType:'application/javascript',body:HMR}));
  await p.goto('http://localhost:5273/?q=low',{waitUntil:'load'});
  await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
  await p.evaluate(()=>document.getElementById('boot')?.remove());
  await p.evaluate(()=>{const g=window.__game;g.state.elements=['fire','water','nature','earth','light','dark'];g.state.pendingElementPicks=0;g.hud.closeElementPicker();g.state.phase='prep';g.state.gold=99999;
    for(const [k,c,r] of [['fire',10,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7]]) g.build(k,c,r);
    g.hud.refreshBuildBar();g.hud.build.setPrep(true,116);g.setBuildSelection('fire');});
  await p.waitForTimeout(1200);
  const d=await p.evaluate(()=>{const r=document.querySelector('#dock').getBoundingClientRect();return{x:Math.max(0,Math.round(r.left)-6),y:Math.round(r.top)-70,width:Math.min(window.innerWidth,Math.round(r.width)+12),height:Math.round(r.height)+80};});
  await p.screenshot({path:`${OUT}/dock-${TAG}-${W}x${H}.png`, clip:d});
  await p.screenshot({path:`${OUT}/hud-${TAG}-${W}x${H}.png`});
  console.log(`${W}x${H} dock clip ${JSON.stringify(d)}`);
  await p.close();
}
await b.close();
