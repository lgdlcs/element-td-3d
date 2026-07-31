#!/usr/bin/env node
/** Measures how many draw calls the tower group is responsible for. */
import { chromium } from 'playwright';

const URL = 'http://localhost:5273/';
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${URL}?q=ultra`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });

const out = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase = 'prep'; g.hud.refreshBuildBar();
  const MAZE = [
    ['fire', 10, 3], ['fire', 14, 3], ['water', 8, 5], ['nature', 12, 5],
    ['earth', 16, 5], ['light', 6, 7], ['dark', 10, 7], ['steam', 14, 7],
    ['ice', 18, 7], ['magma', 8, 9], ['poison', 12, 9], ['crystal', 16, 9],
    ['blaze', 6, 11], ['void', 10, 11], ['magic', 14, 11], ['life', 18, 11],
    ['water', 8, 13], ['nature', 12, 13], ['earth', 16, 13], ['light', 10, 15],
    ['dark', 14, 15],
  ];
  for (const [k, c, r] of MAZE) g.build(k, c, r);
  await wait(1500);
  const calls = () => g.pipeline.renderer.info.render.calls;
  const withTowers = calls();
  g.towers.group.visible = false;
  await wait(500);
  const withoutTowers = calls();
  g.towers.group.visible = true;
  await wait(300);
  let meshCount = 0, lightCount = 0;
  g.towers.group.traverse((o) => { if (o.isMesh) meshCount++; if (o.isLight) lightCount++; });
  return { withTowers, withoutTowers, towerCalls: withTowers - withoutTowers, meshCount, lightCount, towers: g.towers.towers.length,
    hasBatchedMesh: !!(window.THREE_TEST ?? true) };
});

console.log(JSON.stringify({ out, errors: logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')) }, null, 2));
await browser.close();
