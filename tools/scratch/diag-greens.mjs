/**
 * Do the green crescents off the left frame edge correspond to live creeps?
 * Projects every live creep to NDC through the live camera and captures the
 * same frame, so the two can be compared directly.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra&scenario=midgame', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.waitForTimeout(6000);

const dump = await p.evaluate(() => {
  const g = window.__game;
  const c = g.creeps;
  const cam = g.rig.camera ?? g.camera;
  cam.updateMatrixWorld(true);
  const V = new (g.arena.group.position.constructor)();
  const rows = [];
  for (let k = 0; k < c._liveCount; k++) {
    const i = c._live[k];
    V.set(c.x[i], c.y[i] + 1, c.z[i]);
    V.project(cam);
    rows.push({
      i,
      world: [+c.x[i].toFixed(1), +c.z[i].toFixed(1)],
      px: [Math.round((V.x * 0.5 + 0.5) * 1920), Math.round((-V.y * 0.5 + 0.5) * 1080)],
      alive: c.alive[i], hp: Math.round(c.hp[i]), type: c.typeKeys[c.typeIdx[i]],
    });
  }
  return {
    liveCount: c._liveCount,
    hudAlive: document.body.innerText.match(/(\d+)\s+alive/)?.[1] ?? null,
    rows,
  };
});
console.log(JSON.stringify(dump, null, 2));
writeFileSync('shots/diag-greens.png', await p.screenshot({ type: 'png' }));
await b.close();
