/** Does holding D actually pan? Throwaway. */
import { chromium } from 'playwright';
const VITE_STUB = 'export const createHotContext=()=>({accept(){},acceptExports(){},prune(){},dispose(){},decline(){},invalidate(){},on(){},off(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());
await p.evaluate(() => {
  const g = window.__game;
  for (const id of ['fire', 'water']) { g.state.pendingElementPicks = 1; g.chooseElement(id); }
  g.state.paused = true;
});
const read = () => p.evaluate(() => {
  const r = window.__game.rig;
  return { tx: +r._targetGoal.x.toFixed(3), tz: +r._targetGoal.z.toFixed(3), az: +r._azimuthGoal.toFixed(4), autoFrame: r._autoFrame, settle: r._settleFrames, keys: [...r._keys] };
});
console.log('before', JSON.stringify(await read()));
await p.keyboard.down('d');
await p.waitForTimeout(120);
console.log('mid   ', JSON.stringify(await read()));
await p.waitForTimeout(400);
await p.keyboard.up('d');
console.log('after ', JSON.stringify(await read()));
await p.keyboard.down('q');
await p.waitForTimeout(400);
await p.keyboard.up('q');
console.log('afterQ', JSON.stringify(await read()));
await b.close();
