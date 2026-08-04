#!/usr/bin/env node
/** Is the occupancy texture actually carrying lane/blocked flags to the shader? */
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const out = await page.evaluate(() => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep';
  g.build('fire', 10, 3); g.build('water', 8, 5);
  const d = g.arena.occupancyData;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i]) r++; if (d[i + 1]) gg++; if (d[i + 2]) b++; }
  // What does the shader actually sample for a known lane cell and a known tower cell?
  const at = (c, rr) => { const i = (rr * g.grid.cols + c) * 4; return [d[i], d[i + 1], d[i + 2]]; };
  return {
    cells: d.length / 4, blockedR: r, laneG: gg, sealB: b,
    spawn: g.grid.spawn, goal: g.grid.goal,
    laneCell: at(g.grid.spawn.c, 0), towerCell: at(10, 3), freeCell: at(2, 2),
    texNeedsUpdate: g.arena.occupancyTex.needsUpdate,
    matHasTex: !!g.arena.gridMaterial.uniforms.uOccupancy.value,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
