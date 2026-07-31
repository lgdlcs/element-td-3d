#!/usr/bin/env node
/**
 * Prove the contact shadow renders. PITFALLS §2 and §8 are both "a feature that
 * was tuned for rounds and had never drawn a pixel", so this asserts it instead
 * of trusting the code.
 *
 * Freezes a board with units on open floor, captures with ContactField visible
 * and hidden, and reports the mean luminance of a disc under each creep's feet.
 * If hiding it does not brighten that disc, there is no shadow.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

// A row of units standing still on OPEN floor, no towers to occlude the ground.
const feet = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.hud.closeElementPicker();
  g.state.phase = 'combat';
  const c = g.creeps;
  const types = ['normal', 'fast', 'armored', 'swarm', 'boss'];
  const made = [];
  for (let k = 0; k < types.length; k++) {
    const i = c.spawn(types[k], 1e6, 1, 0);
    if (i < 0) continue;
    made.push(i);
    c.x[i] = -12 + k * 6.0; c.z[i] = 2;
    c.vx[i] = 0.0001; c.vz[i] = 0.0001;
    c.speed[i] = 0; c.baseSpeed[i] = 0; c.yaw[i] = 0.2; c.spawnT[i] = 1;
  }
  await wait(1200);
  g.state.speed = 0; if (g.setSpeed) g.setSpeed(0);
  await wait(400);
  const cam = g.rig?.camera ?? g.camera;
  cam.updateMatrixWorld(true);
  const V = new g.arena.group.position.constructor();
  return made.map((i) => {
    // project the point ON THE GROUND at the unit's feet, not its centre
    V.set(c.x[i], c.groundY[i] + 0.05, c.z[i]);
    V.project(cam);
    return [Math.round((V.x * 0.5 + 0.5) * 1920), Math.round((-V.y * 0.5 + 0.5) * 1080)];
  });
});

const grab = async (name, hide) => {
  await page.evaluate((h) => { window.__game.creeps.contact.mesh.visible = !h; }, hide);
  await page.waitForTimeout(500);
  const buf = await page.screenshot({ type: 'png', timeout: 120000 });
  writeFileSync(`shots/r5-contact-${name}.png`, buf);
};
await grab('on', false);
await grab('off', true);
await browser.close();

// Sample both PNGs at the feet.
const { execSync } = await import('node:child_process');
console.log('feet px', JSON.stringify(feet));
for (const n of ['on', 'off']) {
  console.log(n, execSync(
    `node tools/scratch/r5-measure.mjs shots/r5-contact-${n}.png '${JSON.stringify(feet)}'`,
  ).toString().split('\n').slice(0, feet.length).join('\n'));
}
