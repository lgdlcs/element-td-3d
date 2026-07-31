import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
p.on('console', m => { const t = m.text(); if (/error|Error|warn/i.test(t)) console.log('CONSOLE', t.slice(0, 4000)); });
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForTimeout(9000);
console.log('game?', await p.evaluate(() => !!window.__game));
await b.close();
