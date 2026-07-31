import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
try { await p.waitForFunction(() => !!window.__game, null, { timeout: 60000 }); }
catch { console.log('BOOT FAIL'); console.log(errs.join('\n')); await b.close(); process.exit(1); }
await p.waitForTimeout(3000);
const info = await p.evaluate(() => {
  const g = window.__game, r = g.pipeline.renderer.info;
  return { calls: r.render.calls, tris: r.render.triangles, wave: g.state?.wave, gold: g.state?.gold };
});
console.log('BOOT OK', JSON.stringify(info), 'errors:', errs.length ? errs : '[]');
await b.close();
