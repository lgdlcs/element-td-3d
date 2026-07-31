#!/usr/bin/env node
/** Prints the rig's actual framing numbers + a per-pass GPU timing sample. */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const Q = arg('q', 'ultra');

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5273/?q=${Q}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.waitForTimeout(2500);

const out = await page.evaluate(async () => {
  const g = window.__game;
  const r = g.rig;
  const f = r.measureFraction();
  const deg = (x) => (x * 180 / Math.PI).toFixed(1);
  const p = g.pipeline;

  // Per-pass cost: time N composer renders with each pass individually off.
  const names = Object.keys(p.passes);
  const gl = p.renderer.getContext();
  const buf = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const bench = (n = 60) => {
    sync();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) p.render(i * 0.016, 0.016);
    sync();
    return (performance.now() - t0) / n;
  };
  bench(40);                       // warm up: compile, allocate, settle clocks
  const base = bench(60);
  const per = {};
  for (const n of names) {
    const pass = p.passes[n];
    if (n === 'render' || n === 'output' || !pass.enabled) continue;
    pass.enabled = false;
    const off = bench(60);
    pass.enabled = true;
    const again = bench(60);
    per[n] = +(((base + again) * 0.5) - off).toFixed(3);
  }
  // scene-only reference: everything off but RenderPass + Output
  const off = [];
  for (const n of names) {
    if (n === 'render' || n === 'output') continue;
    if (p.passes[n].enabled) { p.passes[n].enabled = false; off.push(n); }
  }
  const sceneOnly = bench(60);
  for (const n of off) p.passes[n].enabled = true;

  return {
    quality: p.quality,
    fov: r.camera.fov,
    dist: +r.dist.toFixed(2),
    polarRad: +r.polar.toFixed(3),
    pitchDeg: +(90 - +deg(r.polar)).toFixed(1),
    azimuthDeg: +deg(r.azimuth),
    boardWidthPctOfFrame: f ? +(f.widthPct * 1).toFixed(1) : null,
    ndcTop: f ? +f.topNdc.toFixed(3) : null,
    ndcBottom: f ? +f.botNdc.toFixed(3) : null,
    frameMs_total: +base.toFixed(3),
    frameMs_sceneOnly: +sceneOnly.toFixed(3),
    frameMs_composerChain: +(base - sceneOnly).toFixed(3),
    perPassMs: per,
    passes: names,
  };
});

await browser.close();
console.log(JSON.stringify(out, null, 2));
const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
if (errs.length) console.log('ERRORS', errs);
