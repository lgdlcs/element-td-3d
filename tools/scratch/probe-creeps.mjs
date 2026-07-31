import { chromium } from 'playwright';
const OUT = process.argv[2] || 'shots/_probe.png';
const b = await chromium.launch({ args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--use-angle=swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.route('**/@vite/client', r => r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const info = await p.evaluate(async () => {
  const g = window.__game, wait = ms => new Promise(r=>setTimeout(r,ms));
  let s=1337; Math.random=()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};
  g.state.elements = ['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase='prep'; g.hud.refreshBuildBar();
  const MAZE = [
    ['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],
    ['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],
    ['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],
    ['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],
    ['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of MAZE) { try { g.build(k,c,r); } catch(_){} }
  g.state.phase='combat'; g.state.wave=21;
  const c = g.creeps;
  await wait(300);
  // A legible column marching down the lane, frozen in place at known spots.
  const plan = [];
  const types=['normal','normal','normal','normal','normal','normal','normal','normal'];
  for (let k=0;k<8;k++) plan.push([types[k], -18 + k*0.0, -14 + k*2.6]);
  const extra=[['fast',-6,-8],['fast',-6,-4],['armored',6,-8],['armored',6,-4],
               ['swarm',-12,4],['swarm',-11,6],['swarm',-13,6],['flying',10,2],['flying',11,5]];
  const made=[];
  for (const [t,x,z] of plan.concat(extra)) {
    const i=c.spawn(t,3000,10,0); if(i<0) continue;
    c.x[i]=x; c.z[i]=z; c.spawnT[i]=1; c.yaw[i]=0;
    c.speed[i]=0; c.baseSpeed[i]=0; c.vx[i]=0.0001; c.vz[i]=0.0001;
    made.push([i,t,x,z]);
  }
  await wait(1200);
  return { alive: c.count, made, cam: [g.rig.camera.position.x,g.rig.camera.position.y,g.rig.camera.position.z] };
});
await p.waitForTimeout(500);
await p.screenshot({ path: OUT, timeout: 180000, animations: 'disabled' });
console.log(JSON.stringify({alive:info.alive, cam:info.cam, errs}));
await b.close();
