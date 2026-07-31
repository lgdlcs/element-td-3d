#!/usr/bin/env node
/**
 * The off-board coloured row: attribute it by ABLATION, one object at a time.
 *
 * Same scenario as tools/scratch/diag-row.mjs so the captures are comparable.
 * For every candidate we hide exactly one thing, re-measure the mean linear
 * energy inside the suspect region (and a control region on the opposite side
 * of the board), and write a crop. Whatever kills the row owns it.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(file) {
  const b = readFileSync(file);
  let p = 8, W = 0, H = 0, ct = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    const d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = W * ch, out = Buffer.alloc(H * stride);
  let ro = 0;
  for (let y = 0; y < H; y++) {
    const ft = raw[ro++]; const line = raw.subarray(ro, ro + stride); ro += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const A = i >= ch ? cur[i - ch] : 0, B = prev ? prev[i] : 0;
      const C = (prev && i >= ch) ? prev[i - ch] : 0;
      let vv = line[i];
      if (ft === 1) vv += A; else if (ft === 2) vv += B; else if (ft === 3) vv += (A + B) >> 1;
      else if (ft === 4) { const pp = A + B - C, pa = Math.abs(pp - A), pb = Math.abs(pp - B), pc = Math.abs(pp - C); vv += (pa <= pb && pa <= pc) ? A : (pb <= pc ? B : C); }
      cur[i] = vv & 255;
    }
  }
  return { W, H, ch, data: out };
}
function regionStat(img, R) {
  let r = 0, g = 0, bb = 0, sat = 0, n = 0;
  for (let y = R.y; y < R.y + R.h; y++) {
    for (let x = R.x; x < R.x + R.w; x++) {
      const i = (y * img.W + x) * img.ch;
      const A = img.data[i], B = img.data[i + 1], C = img.data[i + 2];
      r += A; g += B; bb += C;
      const mx = Math.max(A, B, C), mn = Math.min(A, B, C);
      sat += mx > 0 ? (mx - mn) / mx : 0;
      n++;
    }
  }
  return { r: +(r / n).toFixed(2), g: +(g / n).toFixed(2), b: +(bb / n).toFixed(2), sat: +(sat / n * 100).toFixed(1) };
}

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/row2', { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
p.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') logs.push('[error] ' + m.text()); });
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
  // Freeze so every ablation photographs the same instant.
  g.state.speed = 0; if (g.setSpeed) g.setSpeed(0);
});

// Suspect band (left of the board, on the grass) and a control band above it.
const REG = { x: 180, y: 340, w: 250, h: 400 };
const CTL = { x: 1640, y: 120, w: 260, h: 300 };

async function measure(label) {
  await p.waitForTimeout(700);
  const f = `shots/row2/${label}.png`;
  writeFileSync(f, await p.screenshot({ type: 'png', timeout: 120000 }));
  const img = decodePNG(f);
  return { reg: regionStat(img, REG), ctl: regionStat(img, CTL) };
}

const results = {};
results.base = await measure('00-base');

const CANDS = [
  ['motes', 'g.environment.motes.points.visible=false'],
  ['groundFog', 'g.environment.groundFog.mesh.visible=false'],
  ['breach', 'g.environment.breach.group.visible=false'],
  ['bdProps', 'for (const m of g.environment.backdrop.meshes) if (m.name!=="surround-ground") m.visible=false'],
  ['towersAll', 'g.towers.group.visible=false'],
];

for (const [name, js] of CANDS) {
  const ok = await p.evaluate((s) => {
    const g = window.__game;
    try { eval(s); return true; } catch (e) { return String(e); }
  }, js);
  results[name] = { applied: ok, ...(await measure(`ab-${name}`)) };
  // restore
  await p.evaluate(() => {
    const g = window.__game;
    g.arena.group.visible = true;
    g.arena.ground.visible = true; g.arena.rim.visible = true;
    g.arena.tufts.mesh.visible = true;
    const rr = g.arena.group.getObjectByName('rimRunes'); if (rr) rr.visible = true;
    g.arena.spawnPortal.visible = true; g.arena.goalPortal.visible = true;
    g.towers.group.visible = true; g.fx.group.visible = true;
    g.creeps.group.visible = true;
    g.creeps.healthBars.mesh.visible = true;
    g.creeps.particles.mesh.visible = true;
    g.creeps.contact.mesh.visible = true;
    g.creeps.gibs.mesh.visible = true;
    if (g.projectiles.group) g.projectiles.group.visible = true;
    else { g.projectiles.ribbons.mesh.visible = true; g.projectiles.renderer.billboards.visible = true; }
    g.fx.decals.glow.mesh.visible = true; g.fx.decals.mark.mesh.visible = true;
    g.environment.group.visible = true;
    g.environment.motes.points.visible = true;
    g.environment.groundFog.mesh.visible = true;
    g.environment.breach.group.visible = true;
    for (const m of g.environment.backdrop.meshes) m.visible = true;
    try { g.environment.backdrop.ground.visible = true; } catch (e) {}
  });
}

await b.close();
console.log(JSON.stringify({ region: REG, results, errors: logs }, null, 1));
