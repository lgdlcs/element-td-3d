#!/usr/bin/env node
/** Which stage is eating the contact decal? PITFALLS §2 recipe. */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const info = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  g.hud.closeElementPicker();
  g.state.phase = 'combat';
  const c = g.creeps;
  for (let k = 0; k < 5; k++) {
    const i = c.spawn('normal', 1e6, 1, 0);
    if (i < 0) continue;
    c.x[i] = -12 + k * 6.0; c.z[i] = 2;
    c.vx[i] = 0.0001; c.vz[i] = 0.0001;
    c.speed[i] = 0; c.baseSpeed[i] = 0; c.spawnT[i] = 1;
  }
  await wait(1200);
  const f = c.contact;
  return {
    instanceCount: f.geo.instanceCount,
    visible: f.mesh.visible,
    inScene: !!f.mesh.parent,
    groupVisible: c.group.visible,
    groupPos: c.group.position.toArray(),
    aP: Array.from(f.aP.array.slice(0, 12)).map((v) => +v.toFixed(3)),
    aC: Array.from(f.aC.array.slice(0, 8)).map((v) => +v.toFixed(3)),
    aX: Array.from(f.aX.array.slice(0, 8)).map((v) => +v.toFixed(3)),
    hasIndex: !!f.geo.index,
    posCount: f.geo.attributes.position.count,
    drawRange: JSON.stringify(f.geo.drawRange),
    bounding: f.geo.boundingSphere ? f.geo.boundingSphere.radius : null,
    frustumCulled: f.mesh.frustumCulled,
  };
});
console.log(JSON.stringify(info, null, 1));

// Force it loud: no depth test, opaque magenta, on top of everything.
await page.evaluate(() => {
  const f = window.__game.creeps.contact;
  f.mesh.renderOrder = 9999;
  f.mesh.material.depthTest = false;
  f.mesh.material.transparent = false;
  f.mesh.material.blending = 0; // NoBlending
  f.mesh.material.fragmentShader = `
    precision highp float;
    varying vec2 vUv; varying vec4 vC; varying float vH;
    void main(){ gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); }`;
  f.mesh.material.needsUpdate = true;
});
await page.waitForTimeout(1200);
writeFileSync('shots/r5-contact-forced.png', await page.screenshot({ type: 'png', timeout: 120000 }));
console.log('wrote shots/r5-contact-forced.png');
await browser.close();
