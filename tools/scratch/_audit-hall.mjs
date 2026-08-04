/**
 * Probe: why lobby-hall.spec.js:242 needs a live server on :5274.
 *
 * The test forces setConnection('online') to arm the 8s hall timer, then waits
 * for data-hall to turn 'late'. This records every setConnection call that
 * arrives AFTER the forced one, plus the timer's state, so the overwrite is
 * visible rather than inferred.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {}' }));
await page.goto('http://localhost:5273/?mp');
await page.waitForFunction(() => window.__lobby, null, { timeout: 90000 });

// settleConnection, verbatim from the spec: "wait until the lobby is not connecting"
const t0 = Date.now();
for (let i = 0; i < 200; i++) {
  const s = await page.evaluate(() => window.__lobby?.state);
  if (s !== 'connecting') { console.log(`settleConnection returned after ${Date.now() - t0}ms with state="${s}"`); break; }
  await page.waitForTimeout(100);
}

// Instrument setConnection from this point on.
await page.evaluate(() => {
  window.__calls = [];
  const l = window.__lobby;
  const orig = l.setConnection.bind(l);
  l.setConnection = (s) => {
    window.__calls.push({ at: Math.round(performance.now()), state: s });
    return orig(s);
  };
});

// The test's own forcing.
await page.evaluate(() => {
  window.__lobby.topReceived = false;
  window.__lobby.top = [];
  window.__lobby.setConnection('online');
});
console.log('forced online; data-hall =', await page.getAttribute('#lobby', 'data-hall'));

for (const ms of [2000, 4000, 6000, 8000, 10000, 12000]) {
  await page.waitForTimeout(ms === 2000 ? 2000 : 2000);
  const st = await page.evaluate(() => ({
    hall: document.getElementById('lobby').dataset.hall,
    cls: document.getElementById('lobby').className,
    timer: window.__lobby._hallTimer,
    late: window.__lobby._hallLate,
    conn: window.__lobby.connection,
  }));
  console.log(`t+${ms}ms`, JSON.stringify(st));
}

console.log('\nsetConnection calls after the forced one:');
console.log(JSON.stringify(await page.evaluate(() => window.__calls), null, 1));

await browser.close();
