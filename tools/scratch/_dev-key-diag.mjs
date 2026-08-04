/**
 * Diagnose why F9 / Backquote does not open the panel in a REAL browser.
 *
 * Playwright sets navigator.webdriver, which main.js uses to skip the lobby — so
 * every automated check so far started with focus nowhere. A human starts with
 * the lobby up and its name field focused (Lobby.#focusFirst), which is a very
 * different keyboard situation.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
// Look like a human: no webdriver flag, so main.js shows the lobby.
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
});
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {}' }));
await page.goto('http://localhost:5273/');
await page.waitForFunction(() => window.__dev, null, { timeout: 90000 });
await page.evaluate(() => document.getElementById('boot')?.remove());
await page.waitForTimeout(2500);

// Record every keydown that reaches window at capture, before anything can eat it.
await page.evaluate(() => {
  window.__keys = [];
  window.addEventListener('keydown', (e) => {
    window.__keys.push({
      code: e.code,
      target: e.target?.id || e.target?.tagName,
      typing: e.target instanceof HTMLInputElement,
    });
  }, true);
});

const state = () => page.evaluate(() => ({
  lobbyOpen: !document.getElementById('lobby')?.hidden,
  focus: document.activeElement?.id || document.activeElement?.tagName,
  panelOpen: !document.getElementById('devpanel').hidden,
}));

console.log('avant     ', JSON.stringify(await state()));
await page.keyboard.press('F9');
console.log('apres F9  ', JSON.stringify(await state()));
await page.keyboard.press('Backquote');
console.log('apres `   ', JSON.stringify(await state()));
console.log('touches vues au capture window:', JSON.stringify(await page.evaluate(() => window.__keys)));

// Now with focus taken off the field, to isolate the cause.
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('F9');
console.log('apres blur + F9', JSON.stringify(await state()));

await browser.close();
