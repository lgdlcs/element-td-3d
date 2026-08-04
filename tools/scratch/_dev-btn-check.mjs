/** The top-bar DEV button: present, clickable, reflects state, reachable by Tab. */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {}' }));
await page.goto('http://localhost:5273/');
await page.waitForFunction(() => window.__dev, null, { timeout: 90000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.waitForTimeout(1500);

const read = () => page.evaluate(() => {
  const b = document.getElementById('dev-btn');
  const r = b?.getBoundingClientRect();
  return {
    exists: !!b,
    inTopbar: !!b?.closest('#topbar'),
    text: b?.textContent,
    tabIndex: b?.tabIndex,
    on: b?.classList.contains('on'),
    box: r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : null,
    panelOpen: !document.getElementById('devpanel').hidden,
  };
});

// The picker is open on the first frame of a run and its veil is full-bleed.
// This is the case the button failed: it must be clickable THROUGH it.
console.log('picker ouvert ?', await page.evaluate(() => document.getElementById('picker')?.classList.contains('open')));
console.log('au repos   ', JSON.stringify(await read()));
await page.click('#dev-btn');
console.log('1er clic   ', JSON.stringify(await read()));
await page.click('#dev-btn');
console.log('2e clic    ', JSON.stringify(await read()));

// The key and the button must agree on the same state.
await page.click('#dev-btn');
await page.keyboard.press('F9');
console.log('clic + F9  ', JSON.stringify(await read()), '(doit etre ferme, bouton off)');

// ui-contract's rule: every #topbar button is keyboard reachable.
const unreachable = await page.evaluate(() =>
  [...document.querySelectorAll('#topbar button')].filter((b) => b.tabIndex < 0 && !b.disabled).length);
console.log('boutons #topbar non atteignables au clavier:', unreachable);

await page.click('#dev-btn');
await page.click('#devpanel [data-act="elements"]');
await page.click('#devpanel [data-act="stacks"]');
await page.click('#devpanel [data-act="goldinf"]');
await page.waitForTimeout(900);
await page.screenshot({ path: process.argv[2] || 'shots/_devbtn.png' });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
