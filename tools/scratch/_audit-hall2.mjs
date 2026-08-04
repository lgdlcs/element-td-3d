/** Probe: why does the injected board render 0 rows after quiesceNet? */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {}' }));
await page.goto('http://localhost:5273/?mp');
await page.waitForFunction(() => window.__lobby && window.__game, null, { timeout: 90000 });
await page.waitForTimeout(1500);

const snap = (tag) => page.evaluate((t) => ({
  tag: t,
  visible: window.__lobby.visible,
  hidden: window.__lobby.$el.hidden,
  sub: !!window.__lobby._unsubscribeTop,
  conn: window.__lobby.connection,
  topReceived: window.__lobby.topReceived,
  topLen: window.__lobby.top?.length,
  hall: document.getElementById('lobby').dataset.hall,
  rows: document.querySelectorAll('#lobby-hall-list .hall-row').length,
}), tag);

console.log(JSON.stringify(await snap('after boot')));
await page.evaluate(() => window.__net?.disconnect?.());
console.log(JSON.stringify(await snap('after disconnect')));
await page.evaluate(() => window.__game.hud.setLeaderboard([
  { name: 'X', score: 99999, wave: 40, won: true },
  { name: 'Ada', score: 8000, wave: 30 },
  { name: 'Bo', score: 4000, wave: 20 },
]));
await page.waitForTimeout(300);
console.log(JSON.stringify(await snap('after inject')));

await browser.close();
