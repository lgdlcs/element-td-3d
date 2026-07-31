#!/usr/bin/env node
/** Shoot the standalone tower silhouette rig (see sil-standalone.html). */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(arg('out', 'shots/sil-standalone.png'));
const SET = arg('set', 'fire,water,nature,earth,light,dark');
const LEVEL = arg('level', '0');
const YAW = arg('yaw', '0.42');
mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 900 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5273/tools/scratch/sil-standalone.html?set=${SET}&level=${LEVEL}&yaw=${YAW}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__silReady === true, null, { timeout: 30000 });
const info = await page.evaluate(() => window.__silInfo);
writeFileSync(OUT, await page.locator('canvas').screenshot({ type: 'png' }));
await browser.close();
console.log(JSON.stringify({ out: OUT, info, errors: logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')) }, null, 2));
