import { chromium } from 'playwright';
const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const log = (...a) => console.log(...a);
const b = await chromium.launch({ args: ARGS });
const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto('http://localhost:5273/?q=ultra');
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.waitForTimeout(1000);

// dismiss the element picker properly
await page.evaluate(() => { const el = document.querySelector('#picker .pc-card'); if (el) el.click(); });
await page.waitForTimeout(600);
const st = () => page.evaluate(() => ({ build: window.__game.selectedBuild, tower: window.__game.selectedTower, phase: window.__game.state.phase, inspOpen: document.getElementById('inspector')?.classList.contains('open') }));
log('phase after pick:', JSON.stringify(await st()));
log('errors so far   :', JSON.stringify(errs));

// build a tower for real
await page.evaluate(() => { window.__game.state.gold = 9999; });
const cell = await page.evaluate(() => {
  const g = window.__game;
  g.setBuildSelection('fire');
  // project cell (10,10) centre to screen
  const p = g.grid.cellToWorld ? g.grid.cellToWorld(10, 10) : null;
  return p ? { x: p.x, z: p.z } : null;
});
log('cell helper:', JSON.stringify(cell));
// just click near the middle of the board
await page.mouse.move(720, 470); await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(300);
log('after place :', JSON.stringify(await st()), 'towers=', await page.evaluate(() => window.__game.towers.towers.length));

// select the tower (click the same spot with nothing in hand)
await page.evaluate(() => window.__game.setBuildSelection(null));
await page.mouse.move(720, 470); await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(300);
log('after select:', JSON.stringify(await st()));

// right-click tap → should clear tower selection
await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
log('after rtap  :', JSON.stringify(await st()));

// ------- D bug, minimal version: 30px out and back
await page.evaluate(() => window.__game.setBuildSelection('fire'));
await page.mouse.move(700, 500);
await page.mouse.down({ button: 'right' });
await page.mouse.move(730, 500);
await page.mouse.move(760, 500);
await page.mouse.move(730, 500);
await page.mouse.move(702, 500);   // 2px from origin
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(150);
log('D 60px out+back:', JSON.stringify(await st()));

// ------- Escape while the help sheet is open also drops the piece in hand
await page.evaluate(() => window.__game.setBuildSelection('water'));
await page.keyboard.press('KeyH');
await page.waitForTimeout(350);
log('help open   :', await page.evaluate(() => document.getElementById('help').classList.contains('open')), JSON.stringify(await st()));
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
log('after Esc   :', 'helpOpen=', await page.evaluate(() => document.getElementById('help').classList.contains('open')), JSON.stringify(await st()));

// ------- F/codex mutual exclusion + Escape
await page.evaluate(() => window.__game.setBuildSelection('water'));
await page.keyboard.press('KeyF');
await page.waitForTimeout(300);
log('codex open  :', await page.evaluate(() => ({ codex: document.getElementById('codex').classList.contains('open'), help: document.getElementById('help').classList.contains('open') })));
await page.keyboard.press('KeyH');
await page.waitForTimeout(300);
log('H over codex:', await page.evaluate(() => ({ codex: document.getElementById('codex').classList.contains('open'), help: document.getElementById('help').classList.contains('open') })));
await page.keyboard.press('KeyF');
await page.waitForTimeout(300);
log('F over help :', await page.evaluate(() => ({ codex: document.getElementById('codex').classList.contains('open'), help: document.getElementById('help').classList.contains('open') })));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// ------- does the help sheet swallow gameplay keys? (space / digits while open)
await page.evaluate(() => { window.__game.state.paused = false; });
await page.keyboard.press('KeyH');
await page.waitForTimeout(300);
const before = await page.evaluate(() => ({ speed: window.__game.state.speed, paused: window.__game.state.paused, wave: window.__game.state.wave, phase: window.__game.state.phase }));
await page.keyboard.press('Digit3');
await page.keyboard.press('KeyP');
await page.waitForTimeout(200);
const after = await page.evaluate(() => ({ speed: window.__game.state.speed, paused: window.__game.state.paused, wave: window.__game.state.wave, phase: window.__game.state.phase }));
log('keys while help open:', JSON.stringify(before), '->', JSON.stringify(after));
await page.keyboard.press('KeyP');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// ------- typing "h" / "?" into an input must not open the sheet.  Only the lobby has inputs; simulate one.
await page.evaluate(() => {
  const i = document.createElement('input'); i.id = 'probe-input'; i.style.cssText = 'position:fixed;top:0;left:0;z-index:9999';
  document.body.appendChild(i); i.focus();
});
await page.keyboard.type('h?');
await page.waitForTimeout(200);
log('typed h? in input -> helpOpen=', await page.evaluate(() => document.getElementById('help').classList.contains('open')),
  'value=', await page.evaluate(() => document.getElementById('probe-input').value));
await page.evaluate(() => document.getElementById('probe-input').remove());

// ------- textarea / contenteditable guard
await page.evaluate(() => {
  const t = document.createElement('textarea'); t.id = 'probe-ta'; t.style.cssText = 'position:fixed;top:0;left:0;z-index:9999';
  document.body.appendChild(t); t.focus();
});
await page.keyboard.type('hu x');
await page.waitForTimeout(200);
log('typed in TEXTAREA -> helpOpen=', await page.evaluate(() => document.getElementById('help').classList.contains('open')),
  ' value=', JSON.stringify(await page.evaluate(() => document.getElementById('probe-ta').value)),
  ' state=', JSON.stringify(await st()));
await page.evaluate(() => document.getElementById('probe-ta').remove());
await page.keyboard.press('Escape');

// ------- help sheet focus behaviour
await page.keyboard.press('KeyH');
await page.waitForTimeout(350);
log('focus after open:', await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName));
await page.keyboard.press('Tab');
await page.waitForTimeout(120);
log('focus after Tab :', await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName));
await page.keyboard.press('Tab');
log('focus after Tab2:', await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName));

log('--- errors ---', JSON.stringify(errs, null, 1));
await b.close();
