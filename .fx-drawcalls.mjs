import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = []; page.on('pageerror', e => logs.push('ERR ' + e.message));
page.on('console', m => { if (m.type()==='error') logs.push('CERR ' + m.text()); });
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
const r = await page.evaluate(async (scn) => {
  const g = window.__game; const wait = ms => new Promise(r=>setTimeout(r,ms));
  for (let n=0;n<120 && document.getElementById('boot');n++) await wait(150);
  g.state.elements=['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks=0; g.state.gold=999999; g.hud.closeElementPicker();
  g.state.phase='prep'; g.hud.refreshBuildBar();
  const keys=['fire','water','nature','earth','light','dark','steam','magma','ice','poison','void','magic','blaze','crystal','life','mud','abyss','gaia'];
  let n=0;
  for (let row=3; row<=17 && n<34; row+=2) for (let col=6; col<=18 && n<34; col+=2) { g.build(keys[n%keys.length], col, row); n++; }
  for (const t of g.towers.towers) { g.state.gold=999999; g.towers.upgrade(t.id); }
  g.state.phase='combat'; g.waves.start(35);
  await wait(5000);
  // Collect every object that belongs to the VFX layer.
  const fxRoots = [];
  g.scene.traverse(o => { if (o.name === 'fx' || o.name === 'projectile-bodies') fxRoots.push(o); });
  const owned = [];
  g.scene.traverse(o => { if (o.userData && o.userData.__fx) owned.push(o); });
  const uniq = [...new Set(owned)];
  const rr = g.pipeline.renderer;
  const measure = () => { rr.info.reset(); g.pipeline.render(g.scene, g.camera); return rr.info.render.calls; };
  const withFx = measure();
  const vis = uniq.map(o => o.visible);
  uniq.forEach(o => o.visible = false);
  const withoutFx = measure();
  uniq.forEach((o,i) => o.visible = vis[i]);
  const again = measure();
  return { withFx, withoutFx, fxDrawCalls: withFx - withoutFx, again,
           objects: uniq.map(o => ({ name: o.name || o.type, count: o.count ?? null, visible: o.visible })),
           particles: g.fx.liveCount, creeps: g.creeps.count, towers: g.towers.towers.length,
           tri: rr.info.render.triangles };
});
await browser.close();
console.log(JSON.stringify({ r, logs }, null, 2));
