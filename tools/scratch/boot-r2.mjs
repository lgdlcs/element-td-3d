import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader']});
const p = await b.newPage({viewport:{width:800,height:600}});
p.on('console',m=>console.log('['+m.type()+']',m.text().slice(0,300)));
p.on('pageerror',e=>console.log('[pageerror]',e.message.slice(0,400)));
await p.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await p.waitForTimeout(8000);
console.log('game?', await p.evaluate(()=>!!window.__game));
await b.close();
