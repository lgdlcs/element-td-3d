#!/usr/bin/env node
/** Cumulative ablation: hide one more thing per shot until the off-board row dies. */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/rowc', { recursive: true });
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  for (let n = 0; n < 200 && document.getElementById('boot'); n++) await new Promise((r) => setTimeout(r, 150));
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 18; r += 3)
    for (let c = 4; c < 22 && n < 18; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(21);
  await new Promise((r) => setTimeout(r, 8000));
  g.state.speed = 0; if (g.setSpeed) g.setSpeed(0);
});

const STEPS = [
  ['0-base', ''],
  ['1-nofog', 'g.environment.groundFog.mesh.visible=false'],
  ['2-notowers', 'g.towers.group.visible=false'],
  ['3-nocreeps', 'g.creeps.group.visible=false'],
  ['4-nofx', 'g.fx.group.visible=false'],
  ['5-noproj', 'g.projectiles.ribbons.mesh.visible=false; g.projectiles.renderer.billboards.visible=false; g.projectiles.renderer.rocks.visible=false'],
  ['6-noarena', 'g.arena.group.visible=false'],
  ['7-nomotes', 'g.environment.motes.points.visible=false'],
  ['8-nobreach', 'g.environment.breach.group.visible=false'],
  ['9-nobdprops', 'for (const m of g.environment.backdrop.meshes) if (m.name!=="surround-ground") m.visible=false'],
];
for (const [label, js] of STEPS) {
  if (js) await p.evaluate((s) => { const g = window.__game; eval(s); }, js);
  await p.waitForTimeout(650);
  writeFileSync(`shots/rowc/${label}.png`, await p.screenshot({ type: 'png', timeout: 120000 }));
  console.log('wrote', label);
}
await b.close();
