/** Raycast through the dark wedge and name whatever object is actually there. */
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
  await new Promise((r) => setTimeout(r, 800));
});

// Sample a line of pixels straight through the wedge, in NDC.
const hits = await page.evaluate(async () => {
  const g = window.__game;
  // Reuse the game's own raycaster/vector rather than importing three into the
  // page — the bundler mangles the specifier and there is no global.
  const rc = g._raycaster;
  const ndc = g._ndc;
  rc.far = 1000;
  const out = [];
  // Points sampled along the visible dark wedge (measured off the 1280x720 shot):
  // roughly (640,370) -> (960,265). Convert to NDC.
  const pts = [[640, 370], [700, 350], [780, 325], [860, 300], [940, 272], [560, 430], [820, 460]];
  for (const [px, py] of pts) {
    ndc.set((px / 1280) * 2 - 1, -(py / 720) * 2 + 1);
    rc.setFromCamera(ndc, g.camera);
    const list = rc.intersectObjects(g.scene.children, true).slice(0, 3).map((h) => ({
      obj: h.object.name || h.object.type,
      parent: h.object.parent?.name || '',
      dist: +h.distance.toFixed(1),
      point: h.point.toArray().map((v) => +v.toFixed(1)),
      mat: h.object.material?.type,
      transparent: h.object.material?.transparent,
      opacity: h.object.material?.opacity,
      color: h.object.material?.color?.getHexString?.(),
    }));
    out.push({ px, py, list });
  }
  return out;
});

for (const h of hits) {
  console.log(`--- pixel ${h.px},${h.py}`);
  for (const l of h.list) console.log('   ', JSON.stringify(l));
}

await browser.close();
