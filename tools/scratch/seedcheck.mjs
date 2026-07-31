import { chromium } from 'playwright';
const HMR='export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b=await chromium.launch({args:['--use-angle=metal','--mute-audio']});
const p=await b.newPage({viewport:{width:1280,height:720}});
await p.route('**/@vite/client',r=>r.fulfill({status:200,contentType:'application/javascript',body:HMR}));
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://localhost:5273/?q=low',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
await p.waitForTimeout(2000);
const r=await p.evaluate(()=>{
  const g=window.__game;
  // Same seed must give the same offer; a different seed must not.
  const offers=(seed)=>{ g.seed=seed; g.state.pickIndex=0; g.state.elements=[]; return g.rollElementChoices().map(e=>e.id); };
  const a1=offers(12345), a2=offers(12345), b1=offers(999);
  return {a1,a2,b1, snap:g.snapshot(), calls:g.pipeline.renderer.info.render.calls};
});
console.log('seed 12345 ->', r.a1.join(','));
console.log('seed 12345 ->', r.a2.join(','), r.a1.join()===r.a2.join()?'STABLE':'UNSTABLE');
console.log('seed 999   ->', r.b1.join(','), r.b1.join()!==r.a1.join()?'DIFFERS':'COLLIDES');
console.log('snapshot:', JSON.stringify(r.snap));
console.log('calls:', r.calls, 'errors:', errs.length?errs:'none');
await b.close();
