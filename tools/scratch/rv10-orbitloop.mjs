import { chromium } from 'playwright';
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const log = (...a) => console.log(...a);
const b = await chromium.launch({ args: ARGS });
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://localhost:5273/?q=low');
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.waitForTimeout(700);
await page.evaluate(() => { document.querySelector('#picker .pc-card, #picker button')?.click(); });
await page.waitForTimeout(700);

const az = () => page.evaluate(() => window.__game.rig._azimuthGoal);
const sel = () => page.evaluate(() => ({ build: window.__game.selectedBuild, tower: window.__game.selectedTower, hint: document.getElementById('held-piece').classList.contains('on') }));

// Arm a tower via the dock so the state is exactly the player's.
await page.click('#dock-pure .tcard');
log('armed:', JSON.stringify(await sel()));

const x0 = 700, y0 = 470;
await page.mouse.move(x0, y0);
await page.mouse.down({ button: 'right' });
log('az at press  :', (await az()).toFixed(4));
for (let i = 1; i <= 14; i++) await page.mouse.move(x0 + i * 12, y0);       // swing right 168px
log('az at apex   :', (await az()).toFixed(4), ' selection:', JSON.stringify(await sel()));
for (let i = 13; i >= 0; i--) await page.mouse.move(x0 + i * 12, y0);       // swing back
log('az back home :', (await az()).toFixed(4));
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
log('AFTER RELEASE:', JSON.stringify(await sel()), ' az=', (await az()).toFixed(4));

// A tower selection is dropped the same way.
await page.evaluate(() => { const g = window.__game; g.state.gold = 5000; g.build(g.state.elements[0], 10, 8); g.setBuildSelection(null); g.selectTower(g.towers.towers[0].id); });
await page.waitForTimeout(200);
log('\ntower selected:', JSON.stringify(await sel()), 'insp=', await page.evaluate(() => document.getElementById('inspector').classList.contains('open')));
await page.mouse.move(x0, y0);
await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 14; i++) await page.mouse.move(x0, y0 + i * 8);   // vertical orbit
for (let i = 13; i >= 0; i--) await page.mouse.move(x0, y0 + i * 8);
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
log('AFTER vertical loop:', JSON.stringify(await sel()), 'insp=', await page.evaluate(() => document.getElementById('inspector').classList.contains('open')));

log('errors:', JSON.stringify(errs));
await b.close();
