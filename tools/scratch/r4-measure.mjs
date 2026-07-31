#!/usr/bin/env node
/**
 * Measures the thing that actually decides gate G4: creep chroma vs floor
 * chroma. Captures a midgame frame, then samples the brightest N% of pixels in
 * a box around every alive creep (the creep itself) and a set of bare-floor
 * boxes, and reports mean HSV for each.
 *   node tools/scratch/r4-measure.mjs [out.png]
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const OUT = process.argv[2] || 'shots/r4-measure.png';
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
const pts = await page.evaluate(async () => {
  const g = window.__game;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let seed = 1337; Math.random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  g.state.elements = ['fire','water','nature','earth','light','dark']; g.state.pendingElementPicks = 0; g.state.gold = 999999;
  g.hud.closeElementPicker(); g.state.phase='prep'; g.hud.refreshBuildBar();
  const MAZE=[['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for (const [k,c,r] of MAZE) g.build(k,c,r);
  g.state.wave=21; g.state.phase='combat'; g.waves.start(22);
  await wait(3600); await wait(2200);
  const c = g.creeps;
  const cam = g.pipeline?.camera ?? g.camera ?? g.rig?.camera;
  cam.updateMatrixWorld();
  const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse); const e = m.elements;
  const px = (x, y, z) => { const w = e[3]*x+e[7]*y+e[11]*z+e[15];
    return [Math.round(((e[0]*x+e[4]*y+e[8]*z+e[12])/w*0.5+0.5)*innerWidth),
            Math.round((1-((e[1]*x+e[5]*y+e[9]*z+e[13])/w*0.5+0.5))*innerHeight)]; };
  const creeps = [];
  for (let i = 0; i < c.capacity; i++) {
    if (!c.alive[i]) continue;
    const t = c.typeKeys[c.typeIdx[i]];
    const h = 1.85 * c.scale[i];
    const foot = px(c.x[i], c.y[i], c.z[i]);
    const head = px(c.x[i], c.y[i] + h, c.z[i]);
    creeps.push({ i, type: t, sx: foot[0], sy: (foot[1] + head[1]) / 2, pxH: Math.abs(foot[1] - head[1]) });
  }
  // Bare floor samples: walkable cells with no tower and no creep nearby.
  const floor = [];
  for (const [cx, cz] of [[-6, -2], [-2, 6], [6, 2], [2, -6], [-10, 6], [10, -2]]) {
    const p = px(cx, g.creeps.surfaceHeightAt(cx, cz) + 0.02, cz);
    floor.push({ sx: p[0], sy: p[1] });
  }
  return { creeps, floor, alive: c.count };
});
const buf = await page.screenshot({ type: 'png', timeout: 120000 });
writeFileSync(resolve(OUT), buf);
const b64 = buf.toString('base64');
const res = await page.evaluate(async ({ b64, pts }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  const hsv = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return [h, mx ? d / mx : 0, mx];
  };
  const sample = (sx, sy, half, topFrac) => {
    const x0 = Math.max(0, sx - half), y0 = Math.max(0, sy - half);
    const w = Math.min(img.width - x0, half * 2), h = Math.min(img.height - y0, half * 2);
    if (w <= 0 || h <= 0) return null;
    const d = ctx.getImageData(x0, y0, w, h).data;
    const list = [];
    for (let k = 0; k < d.length; k += 4) list.push([d[k], d[k + 1], d[k + 2]]);
    // rank by saturation*value so the creep wins over the floor inside its box
    list.sort((a, b) => { const A = hsv(...a), B = hsv(...b); return (B[1] * B[2]) - (A[1] * A[2]); });
    const take = list.slice(0, Math.max(4, Math.round(list.length * topFrac)));
    let H = 0, S = 0, V = 0, sx2 = 0, sy2 = 0;
    for (const [r, g, b] of take) { const [hh, ss, vv] = hsv(r, g, b); sx2 += Math.cos(hh * Math.PI / 180); sy2 += Math.sin(hh * Math.PI / 180); S += ss; V += vv; }
    H = (Math.atan2(sy2 / take.length, sx2 / take.length) * 180 / Math.PI + 360) % 360;
    return { hue: +H.toFixed(0), sat: +(S / take.length * 100).toFixed(1), val: +(V / take.length * 100).toFixed(1) };
  };
  return {
    creeps: pts.creeps.map((c) => ({ ...c, ...sample(c.sx, c.sy, Math.max(12, Math.round(c.pxH * 0.42)), 0.10) })),
    floor: pts.floor.map((f) => ({ ...f, ...sample(f.sx, f.sy, 26, 1.0) })),
  };
}, { b64, pts });
await browser.close();
const mean = (a, k) => +(a.reduce((s, x) => s + (x[k] ?? 0), 0) / a.length).toFixed(1);
console.log(JSON.stringify({
  alive: pts.alive, out: OUT,
  creeps: res.creeps,
  floor: res.floor,
  creepMean: { sat: mean(res.creeps, 'sat'), val: mean(res.creeps, 'val') },
  floorMean: { sat: mean(res.floor, 'sat'), val: mean(res.floor, 'val') },
  errs,
}, null, 2));
