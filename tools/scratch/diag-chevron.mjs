/** Identify the chevron lattice appearing off the board edges. */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999;
  g.hud.closeElementPicker();
  g.state.phase = 'prep';
  await new Promise((r) => setTimeout(r, 1500));
});

const shot = async (n) => { await p.waitForTimeout(900); await p.screenshot({ path: `shots/chev-${n}.png` }); console.log('shot', n); };
await shot('0-baseline');

// Environment children, one at a time.
const kids = await p.evaluate(() => window.__game.environment.group.children.map((o, i) => ({ i, n: o.name || o.type })));
console.log(JSON.stringify(kids));
for (const k of kids) {
  await p.evaluate((i) => {
    window.__game.environment.group.children.forEach((o, j) => { o.visible = j !== i; });
  }, k.i);
  await shot(`env-${k.i}-${k.n.replace(/\W/g, '')}`);
}
await p.evaluate(() => window.__game.environment.group.children.forEach((o) => { o.visible = true; }));

// Whole layers.
for (const [label, expr] of [
  ['no-fx', 'window.__game.fx.group.visible = false'],
  ['no-creeps', 'window.__game.creeps.group.visible = false'],
  ['no-towers', 'window.__game.towers.group.visible = false'],
]) {
  await p.evaluate((e) => { // eslint-disable-next-line no-new-func
    new Function(e)(); }, expr);
  await shot(label);
}

await b.close();
