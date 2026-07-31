import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 4000)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message, '\n', (e.stack || '').slice(0, 2000)));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForTimeout(20000);
console.log('game?', await page.evaluate(() => !!window.__game));
await browser.close();
