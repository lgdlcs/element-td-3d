/**
 * What draws the green crescent row off the LEFT frame edge?
 * Measures green energy inside a fixed left-edge rectangle, ablating one
 * subsystem at a time. Numbers, not eyeballs.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const ROI = { x: 0, y: 300, width: 460, height: 480 };   // the offending region

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

// Drive to the same busy state shot.mjs uses.
await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999;
  g.hud.closeElementPicker?.();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 21; r += 3) {
    for (let c = 4; c < 22 && n < 21; c += 3) {
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) {
        g.buildTower?.(keys[n % 6], c, r) ?? g.towers.create(keys[n % 6], 0, c, r);
        n++;
      }
    }
  }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 9000));
});

const measure = async (label) => {
  await p.waitForTimeout(700);
  const buf = await p.screenshot({ type: 'png', clip: ROI, timeout: 120000 });
  // decode via the page (no image lib available here)
  const b64 = buf.toString('base64');
  const v = await p.evaluate(async (d) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + d;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    let greenish = 0, sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], bl = px[i + 2];
      sum += g;
      if (g > 70 && g > r * 1.35 && g > bl * 1.15) greenish++;
    }
    return { greenPx: greenish, meanG: +(sum / (px.length / 4)).toFixed(1) };
  }, b64);
  console.log(label.padEnd(26), JSON.stringify(v));
  return v;
};

await measure('baseline');

const ablate = async (label, fn) => {
  await p.evaluate(fn);
  await measure(label);
  await p.evaluate(() => window.__game.__restore?.());
};

// Each ablation hides one thing, measures, restores.
await p.evaluate(() => { window.__hidden = []; window.__game.__restore = () => { (window.__hidden || []).forEach((o) => { o.visible = true; }); window.__hidden = []; }; });

await ablate('no fx.group', () => { const o = window.__game.fx.group; o.visible = false; window.__hidden.push(o); });
await ablate('no creeps.group', () => { const o = window.__game.creeps.group; o.visible = false; window.__hidden.push(o); });
await ablate('no towers.group', () => { const o = window.__game.towers.group; o.visible = false; window.__hidden.push(o); });
await ablate('no environment', () => { const o = window.__game.environment.group; o.visible = false; window.__hidden.push(o); });
await ablate('no arena', () => { const o = window.__game.arena.group; o.visible = false; window.__hidden.push(o); });

// fx sub-systems, if the group is the culprit
const fxKids = await p.evaluate(() => window.__game.fx.group.children.map((o, i) => ({ i, n: o.name || o.type })));
console.log('fx children:', JSON.stringify(fxKids));
for (const k of fxKids) {
  await ablate(`no fx[${k.i}] ${k.n}`.slice(0, 26), (i) => {
    const o = window.__game.fx.group.children[i]; o.visible = false; window.__hidden.push(o);
  });
}

await b.close();
