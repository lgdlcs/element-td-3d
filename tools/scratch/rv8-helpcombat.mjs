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
await page.waitForTimeout(800);
await page.evaluate(() => { document.querySelector('#picker .pc-card, #picker button')?.click(); });
await page.waitForTimeout(600);

const phase = () => page.evaluate(() => window.__game.state.phase);
const help = () => page.evaluate(() => document.getElementById('help').classList.contains('open'));
log('phase', await phase());

// start a wave and try to read the sheet
await page.evaluate(() => window.__game.startWaveNow());
await page.waitForTimeout(400);
log('phase after send:', await phase());

await page.keyboard.press('KeyH');
log('H pressed -> open immediately?', await help());
await page.waitForTimeout(120);
log('  +120ms:', await help(), 'phase=', await phase());
await page.waitForTimeout(600);
log('  +720ms:', await help(), 'phase=', await phase());
await page.screenshot({ path: 'shots/rv-help-during-combat.png' });

// same via the topbar button
await page.click('#help-btn');
await page.waitForTimeout(400);
log('button click during combat -> open?', await help(), ' btn aria-expanded=', await page.getAttribute('#help-btn', 'aria-expanded'));

// pause first, then try
await page.evaluate(() => { window.__game.state.paused = true; });
await page.waitForTimeout(200);
await page.keyboard.press('KeyH');
await page.waitForTimeout(500);
log('paused + H during combat -> open?', await help(), 'paused=', await page.evaluate(() => window.__game.state.paused));

// codex during combat, for comparison
await page.evaluate(() => { window.__game.state.paused = false; });
await page.keyboard.press('KeyF');
await page.waitForTimeout(500);
log('codex during combat -> open?', await page.evaluate(() => document.getElementById('codex').classList.contains('open')));
await page.keyboard.press('KeyF');

// what about the pause button's title/aria after pausing?
await page.evaluate(() => { window.__game.state.paused = true; window.__game.hud.refreshTop(); });
log('pause btn:', JSON.stringify(await page.evaluate(() => {
  const b = document.getElementById('pause-btn');
  return { title: b.title, aria: b.getAttribute('aria-label'), glyph: b.querySelector('.ib-glyph').textContent, html: b.innerHTML.replace(/\s+/g, ' ') };
})));

log('errors:', JSON.stringify(errs));
await b.close();
