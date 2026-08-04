/** Smoke: drive every button of the dev panel and read the game state back. */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {}' }));
await page.goto('http://localhost:5273/');
await page.waitForFunction(() => window.__game && window.__dev, null, { timeout: 90000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.waitForTimeout(1200);

const st = () => page.evaluate(() => ({
  gold: window.__game.state.gold,
  lives: window.__game.state.lives,
  wave: window.__game.state.wave,
  phase: window.__game.state.phase,
  elements: window.__game.state.elements.length,
  towers: window.__game.hud ? document.querySelectorAll('#dock .build-card').length : -1,
  creeps: window.__game.creeps.count,
  panelOpen: !document.getElementById('devpanel').hidden,
}));

console.log('start        ', JSON.stringify(await st()));

// The key.
await page.keyboard.press('F9');
console.log('after F9     ', JSON.stringify(await st()));
await page.keyboard.press('Backquote');
console.log('after Backquote (close)', JSON.stringify(await st()));
await page.keyboard.press('F9');

const click = async (act) => {
  await page.click(`#devpanel [data-act="${act}"]`);
  await page.waitForTimeout(150);
  console.log(`${act.padEnd(11)}`, JSON.stringify(await st()), '|', await page.textContent('#dev-status'));
};

await click('gold10');
await click('elements');
await click('stacks');
await click('wavego');           // input defaults to TOTAL_WAVES
await click('goldinf');
await page.waitForTimeout(600);
console.log('gold inf tick', JSON.stringify(await st()));

// Send the last wave and check invincibility survives a leak.
await click('invincible');
await page.evaluate(() => window.__game.startWaveNow());
await page.waitForTimeout(1500);
console.log('wave running ', JSON.stringify(await st()));
const livesBefore = (await st()).lives;
// Force a leak on every creep currently alive.
await page.evaluate(() => {
  const c = window.__game.creeps;
  for (let i = 0; i < c.alive.length; i++) if (c.alive[i]) c.onLeak?.(i, c.typeKeys[c.typeIdx[i]]);
});
await page.waitForTimeout(200);
const livesAfter = (await st()).lives;
console.log(`leaks forced : lives ${livesBefore} -> ${livesAfter} (invincible: doit etre egal)`);

await click('killall');
await click('lives');

console.log('\nerrors:', errors.length ? errors : 'none');
await browser.close();
