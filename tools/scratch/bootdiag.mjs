import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
p.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 500)); });
p.on('requestfailed', r => console.log('[reqfail]', r.url().slice(-90), r.failure()?.errorText));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForTimeout(8000);
await b.close();
