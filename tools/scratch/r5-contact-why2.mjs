import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
console.log(JSON.stringify(await p.evaluate(async () => {
  const g = window.__game; const wait = (ms) => new Promise(r => setTimeout(r, ms));
  g.hud.closeElementPicker(); g.state.phase = 'combat';
  const c = g.creeps;
  for (let k = 0; k < 5; k++) { const i = c.spawn('normal', 1e6, 1, 0); if (i>=0){ c.x[i]=-12+k*6; c.z[i]=2; c.speed[i]=0; c.baseSpeed[i]=0; c.spawnT[i]=1; } }
  await wait(1500);
  const arch = Object.entries(c.archetypes).map(([k,a]) => [k, a.indices.length, a.mesh.count]);
  return {
    liveCount: c._liveCount, count: c.count,
    arch,
    contactInstances: c.contact.geo.instanceCount,
    hbInstances: c.healthBars.geo ? c.healthBars.geo.instanceCount : 'n/a',
    contactIsSame: c.contact.mesh.geometry === c.contact.geo,
    aPsum: c.contact.aP.array.reduce((s,v)=>s+Math.abs(v),0),
    setSrc: c.contact.set.toString().slice(0,120),
  };
}, null), null, 1));
await b.close();
