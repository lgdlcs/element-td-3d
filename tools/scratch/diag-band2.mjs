/** Hide each environment child in turn to find what draws over the arena. */
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
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  await new Promise((r) => setTimeout(r, 500));
});

const children = await page.evaluate(() =>
  window.__game.environment.group.children.map((o, i) => ({
    i, name: o.name || o.type, type: o.type,
    children: o.children.length,
    renderOrder: o.renderOrder,
    depthWrite: o.material?.depthWrite ?? null,
    depthTest: o.material?.depthTest ?? null,
    blending: o.material?.blending ?? null,
  })));
console.log('=== environment children ===');
for (const c of children) console.log(JSON.stringify(c));

for (const c of children) {
  await page.evaluate((i) => {
    const g = window.__game;
    g.environment.group.children.forEach((o, k) => { o.visible = k !== i; });
  }, c.i);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/band-hide-${c.i}-${(c.name || 'x').replace(/\W/g, '')}.png` });
  console.log('captured without child', c.i, c.name);
}

await browser.close();
