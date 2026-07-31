import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--hide-scrollbars','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const st = await p.evaluate(async () => {
  const g = window.__game; const wait = (ms) => new Promise(r => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed*1664525+1013904223)%4294967296; return seed/4294967296; };
  g.state.elements=['fire','water','nature','earth','light','dark']; g.state.gold=999999;
  g.hud.closeElementPicker(); g.state.phase='prep'; g.hud.refreshBuildBar();
  const MAZE=[['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],
    ['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],
    ['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],
    ['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of MAZE) g.build(k,c,r);
  g.state.phase='combat'; g.waves.start(22);
  await wait(1800);
  g.state.speed=0; if (g.setSpeed) g.setSpeed(0);
  await wait(300);
  const c=g.creeps, cam=g.rig?.camera??g.camera; cam.updateMatrixWorld(true);
  const V=new g.arena.group.position.constructor(); const feet=[];
  for(let k=0;k<c._liveCount;k++){const i=c._live[k];V.set(c.x[i],c.groundY[i],c.z[i]);V.project(cam);
    feet.push([Math.round((V.x*.5+.5)*1920),Math.round((-V.y*.5+.5)*1080)]);}
  return { feet, live:c._liveCount, inst:c.contact.geo.instanceCount };
});
console.log(JSON.stringify(st));
// FORCE: opaque magenta, no depth test, drawn last.
await p.evaluate(() => {
  const m = window.__game.creeps.contact.mesh;
  m.renderOrder = 99999; m.material.depthTest = false; m.material.transparent = false;
  m.material.blending = 1; m.material.side = 2;
  m.material.fragmentShader = 'precision highp float;varying vec2 vUv;varying vec4 vC;varying float vH;void main(){gl_FragColor=vec4(1.0,0.0,1.0,1.0);}';
  m.material.needsUpdate = true;
});
await p.waitForTimeout(1200);
writeFileSync('shots/r5-ct-forced.png', await p.screenshot({ type: 'png', timeout: 120000 }));
await b.close();
console.log('wrote shots/r5-ct-forced.png');
