/** Test whether the dark wedge is the key light's shadow-camera frustum edge. */
import { chromium } from 'playwright';

const HMR_STUB = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.route('**/@vite/client', (r) =>
  r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR_STUB }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.evaluate(async () => {
  window.__game.hud.closeElementPicker();
  window.__game.state.phase = 'prep';
  await new Promise((r) => setTimeout(r, 500));
});

console.log(JSON.stringify(await page.evaluate(() => {
  const k = window.__game.lighting.key;
  const c = k.shadow.camera;
  return {
    lightPos: k.position.toArray().map((v) => +v.toFixed(1)),
    targetPos: k.target.position.toArray(),
    frustum: { l: c.left, r: c.right, t: c.top, b: c.bottom, near: c.near, far: c.far },
    mapSize: [k.shadow.mapSize.x, k.shadow.mapSize.y],
    shadowType: window.__game.pipeline.renderer.shadowMap.type,
  };
}), null, 1));

const shot = async (n) => { await page.waitForTimeout(600); await page.screenshot({ path: `shots/band3-${n}.png` }); console.log('shot', n); };

await shot('a-baseline');

// 1. Turn the key light's shadow off entirely.
await page.evaluate(() => { window.__game.lighting.key.castShadow = false; });
await shot('b-no-key-shadow');
await page.evaluate(() => { window.__game.lighting.key.castShadow = true; });

// 2. Massively widen the shadow frustum.
await page.evaluate(() => {
  const c = window.__game.lighting.key.shadow.camera;
  c.left = -120; c.right = 120; c.top = 120; c.bottom = -120; c.far = 400;
  c.updateProjectionMatrix();
  window.__game.lighting.key.shadow.needsUpdate = true;
});
await shot('c-wide-frustum');

// 3. Stop the arena rim casting.
await page.evaluate(() => {
  window.__game.scene.traverse((o) => { if (o.name === 'rim') o.castShadow = false; });
});
await shot('d-wide-plus-no-rim');

await browser.close();
