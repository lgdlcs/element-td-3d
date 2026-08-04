import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--mute-audio','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await p.goto(process.env.PROD_URL || 'http://localhost:5299/');
await p.waitForFunction(() => window.__game, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());
await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(() => ({
  devPanelPresent: !!window.__dev,
  devButtonPresent: !!document.getElementById('dev-btn'),
  canvas: [document.getElementById('viewport').width, document.getElementById('viewport').height],
  wave: window.__game.state.wave,
  towers: window.__game.towers.towers.length,
  towerTable: document.querySelector('#codex-toggle')?.textContent?.replace(/\s+/g,' ').trim(),
  primalL3: (() => { const g = window.__game; return g.state ? 'ok' : 'no'; })(),
}))));
await p.screenshot({ path: process.argv[2] });
console.log('errors:', errors.length ? errors : 'none');
await b.close();
