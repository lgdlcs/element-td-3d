import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio']});
const p = await b.newPage({viewport:{width:1280,height:720}});
p.on('console', m => console.log('['+m.type()+']', m.text()));
p.on('pageerror', e => console.log('[pageerror]', e.message, '\n', (e.stack||'').split('\n').slice(0,6).join('\n')));
await p.goto('http://localhost:5273/?q=ultra', {waitUntil:'load'});
await p.waitForTimeout(6000);
console.log('hasGame:', await p.evaluate(()=>!!window.__game));
await b.close();
