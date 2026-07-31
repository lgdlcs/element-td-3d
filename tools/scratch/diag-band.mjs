/**
 * Isolate the hard diagonal band crossing the arena by toggling one suspect
 * at a time and re-photographing the identical framing.
 */
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
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  await new Promise((r) => setTimeout(r, 500));
});

// What in the scene casts a shadow, and how big is it?
const casters = await page.evaluate(() => {
  const g = window.__game;
  const rows = [];
  g.scene.traverse((o) => {
    if (!o.castShadow || !o.geometry) return;
    o.geometry.computeBoundingSphere?.();
    const r = o.geometry.boundingSphere?.radius ?? 0;
    const s = Math.max(o.scale.x, o.scale.y, o.scale.z);
    rows.push({
      name: o.name || o.type,
      parent: o.parent?.name || '',
      worldRadius: +(r * s).toFixed(1),
      y: +o.position.y.toFixed(1),
      instances: o.isInstancedMesh ? o.count : 1,
    });
  });
  rows.sort((a, b) => b.worldRadius - a.worldRadius);
  return rows.slice(0, 25);
});
console.log('=== shadow casters (largest first) ===');
console.log(JSON.stringify(casters, null, 1));

const shot = async (label) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `shots/diag-${label}.png` });
  console.log('shot:', label);
};

await shot('00-baseline');

// Suspect 1: environment geometry casting shadows onto the board.
await page.evaluate(() => {
  window.__saved = [];
  window.__game.environment.group.traverse((o) => {
    if (o.castShadow) { window.__saved.push(o); o.castShadow = false; }
  });
  return window.__saved.length;
}).then((n) => console.log('env casters disabled:', n));
await shot('01-no-env-shadows');

// Suspect 2: the whole environment group.
await page.evaluate(() => { window.__game.environment.group.visible = false; });
await shot('02-no-environment');
await page.evaluate(() => { window.__game.environment.group.visible = true; });

// Suspect 3: post passes.
for (const key of ['godrays', 'dof', 'gtao', 'bloom']) {
  const had = await page.evaluate((k) => {
    const p = window.__game.pipeline.passes[k];
    if (!p) return false;
    p.enabled = false;
    return true;
  }, key);
  if (had) await shot(`03-no-${key}`);
}

await browser.close();
