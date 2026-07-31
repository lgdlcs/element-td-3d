import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.__game; const L = [];
  g.scene.traverse(o => { if (o.isLight) L.push({ t: o.type, i: +o.intensity.toFixed(2), d: o.distance ?? null, sh: !!o.castShadow }); });
  return { lights: L, n: L.length };
}), null, 1));
await b.close();
