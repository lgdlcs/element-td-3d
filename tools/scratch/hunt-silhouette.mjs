#!/usr/bin/env node
/**
 * HUNT: DOES THE CLICK MATCH THE PICTURE?
 *
 *   node tools/scratch/hunt-silhouette.mjs --port 5294 [--w 1600 --h 900] [--seconds 14]
 *
 * Two checks against the real view, through the real pick:
 *
 *   1. SILHOUETTE. A grid of field points around every running animal is
 *      raycast against its meshes; each point that lands on the animal is
 *      handed to the rite's own hit test (`rite.covers`). A refused point is a
 *      spot where the player sees the animal and the click misses. Prints the
 *      share covered per species, the worst offenders and the most-missed areas
 *      as (forward, up) offsets in lane units.
 *   2. RIFLE. The crosshair is swept over the field and the player's rifle is
 *      sampled (vertices plus points inside every triangle), picked onto the
 *      field and tested against the near and mid lanes' running bands. Any
 *      sample inside a band is the gun covering a runner.
 *
 * Exits 1 when the silhouette is under --min (default 0.96; the rest is thin leg and antler tips) for any species or
 * the rifle enters a band.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5294));
const W = Number(arg('w', 1600)), H = Number(arg('h', 900));
const SECONDS = Number(arg('seconds', 14));
const MIN = Number(arg('min', 0.96));
const WAVE = Number(arg('wave', 12));

const browser = await chromium.launch({
  args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`, '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext = () => ({ accept(){}, prune(){}, dispose(){}, invalidate(){}, on(){}, send(){} }); export const updateStyle = () => {}; export const removeStyle = () => {}; export const injectQuery = (u) => u;',
}));
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 120000 });
await page.evaluate(() => {
  const g = window.__game;
  g.hud.closeElementPicker(); g.state.pendingElementPicks = 0; g.state.phase = 'prep'; g.state.paused = true;
});
const raf = (n) => page.evaluate((k) => new Promise((res) => {
  let i = 0; const f = () => (++i >= k ? res() : requestAnimationFrame(f)); requestAnimationFrame(f);
}), n);

async function open(occurrence) {
  await page.evaluate(([w, o]) => window.__game.startMinigame('hunt', w, o), [WAVE, occurrence]);
  await page.waitForFunction(() => window.__game.minigames.ownsFrame, null, { timeout: 30000 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__game.minigames.mode === 'play' && !!window.__game.minigames._view, null, { timeout: 15000 });
}

// ---- 1. silhouette ---------------------------------------------------------
await open(0);
const species = {};
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  const rows = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const h = window.__game.minigames, v = h._view, R = h.instance, st = h._stage;
    if (!v || !R) return [];
    const rect = h.$gl.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const out = [];
    for (let i = 0; i < R.animals.length; i++) {
      const a = R.animals[i];
      if (a.state !== 'live') continue;
      v.items[i].root.updateMatrixWorld(true);
      const p = R.posAt(a, R.t, { x: 0, y: 0 });
      const step = 0.05 * a.scale, span = 1.9 * a.scale;
      let seen = 0, inside = 0;
      const miss = [];
      for (let fx = -span; fx <= span; fx += step) {
        for (let fy = -span; fy <= span; fy += step) {
          const c = st.fieldToClient(v, p.x + fx, p.y + fy, rect);
          ndc.set((c.x - rect.left) / rect.width * 2 - 1, 1 - (c.y - rect.top) / rect.height * 2);
          ray.setFromCamera(ndc, v.camera);
          if (!ray.intersectObject(v.items[i].root, true).length) continue;
          seen++;
          if (R.covers(a, p.x + fx, p.y + fy, R.t)) inside++;
          else miss.push([+((fx * a.dir) / a.scale).toFixed(1), +(fy / a.scale).toFixed(1)]);
        }
      }
      out.push({ sp: a.species, n: seen, inside, miss });
    }
    return out;
  });
  for (const r of rows) {
    const s = (species[r.sp] ??= { n: 0, inside: 0, miss: new Map() });
    s.n += r.n; s.inside += r.inside;
    for (const m of r.miss) { const key = m.join(','); s.miss.set(key, (s.miss.get(key) ?? 0) + 1); }
  }
  await page.waitForTimeout(250);
}
await page.evaluate(() => window.__game.minigames.close());
await page.waitForFunction(() => !window.__game.minigames.ownsFrame, null, { timeout: 15000 });
await raf(10);

let failed = false;
const NAMES = ['deer', 'boar', 'hare'];
for (const [sp, s] of Object.entries(species)) {
  const share = s.inside / s.n;
  if (share < MIN) failed = true;
  const far = [...s.miss.keys()].map((k) => k.split(',').map(Number))
    .sort((a, b) => Math.hypot(...b) - Math.hypot(...a)).slice(0, 6);
  const cells = new Map();
  for (const [k, c] of s.miss) {
    const [x, y] = k.split(',').map(Number);
    const key = `${(Math.round(x * 4) / 4).toFixed(2)},${(Math.round(y * 4) / 4).toFixed(2)}`;
    cells.set(key, (cells.get(key) ?? 0) + c);
  }
  const top = [...cells].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, c]) => `${k}:${(c / s.n * 100).toFixed(1)}%`);
  console.log(`silhouette ${NAMES[sp].padEnd(4)} covered ${(share * 100).toFixed(1)}% of ${s.n} visible samples  worst [fwd,up]: ${JSON.stringify(far)}`);
  console.log(`  missed areas [fwd,up]:share  ${top.join('  ')}`);
}
if (Object.keys(species).length < 3) { console.log('silhouette: not every species ran'); failed = true; }

// ---- 2. the rifle against the lanes ----------------------------------------
await open(0);
const lanes = await page.evaluate(async () => {
  const mod = await import('/src/minigames/rites/HuntRite.js');
  return { LANES: mod.LANES, SPECIES: mod.SPECIES, BUSH_R: mod.BUSH_R };
});
let worst = { inBand: 0 };
for (let ax = -7; ax <= 7; ax += 1.75) {
  for (let ay = -4; ay <= 3; ay += 1.75) {
    if (await page.evaluate(() => window.__game.minigames.mode !== 'play')) {
      await page.evaluate(() => window.__game.minigames.close());
      await page.waitForFunction(() => !window.__game.minigames.ownsFrame, null, { timeout: 15000 });
      await raf(10);
      await open(0);
    }
    const c = await page.evaluate(([x, y]) => window.__game.minigames.fieldToClient(x, y), [ax, ay]);
    await page.mouse.move(c.x, c.y);
    await raf(60);
    const r = await page.evaluate(({ L, S, B }) => {
      const h = window.__game.minigames, v = h._view, st = h._stage;
      const rect = h.$gl.getBoundingClientRect();
      v.rifle.updateMatrixWorld(true);
      const A = v.camera.position.clone(), Bv = A.clone(), C = A.clone(), P = A.clone();
      const f = { x: 0, y: 0 };
      const ext = (fn) => Math.max(...S.map(fn));
      const up = ext((s) => Math.max(s.hitR, ...s.parts.map(([, u, r]) => u + r)) + s.bob);
      const down = ext((s) => Math.max(s.hitR, ...s.parts.map(([, u, r]) => r - u)));
      const side = ext((s) => Math.max(s.hitR, ...s.parts.map(([f, , r]) => f + r)));
      const bands = [0, 1].map((i) => ({ i, lo: L[i].y - down * L[i].scale, hi: L[i].y + up * L[i].scale,
        x: L[i].cover[L[i].cover.length - 1] - B * L[i].scale + side * L[i].scale }));
      let inBand = 0, n = 0;
      const hits = [];
      v.rifle.traverse((m) => {
        if (!m.isMesh || !m.visible) return;
        const pos = m.geometry.attributes.position;
        const idx = m.geometry.index;
        const tri = idx ? idx.count / 3 : pos.count / 3;
        const at = (j) => (idx ? idx.getX(j) : j);
        for (let t = 0; t < tri; t++) {
          A.fromBufferAttribute(pos, at(t * 3)).applyMatrix4(m.matrixWorld);
          Bv.fromBufferAttribute(pos, at(t * 3 + 1)).applyMatrix4(m.matrixWorld);
          C.fromBufferAttribute(pos, at(t * 3 + 2)).applyMatrix4(m.matrixWorld);
          const D = 8;
          for (let u = 0; u <= D; u++) for (let w = 0; w <= D - u; w++) {
            P.set(0, 0, 0).addScaledVector(A, u / D).addScaledVector(Bv, w / D).addScaledVector(C, (D - u - w) / D).project(v.camera);
            const cx = rect.left + (P.x + 1) / 2 * rect.width, cy = rect.top + (1 - P.y) / 2 * rect.height;
            if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue;
            st.pick(v, cx, cy, rect, f);
            n++;
            for (const b of bands) {
              if (Math.abs(f.x) <= b.x && f.y >= b.lo && f.y <= b.hi) { inBand++; if (hits.length < 3) hits.push([b.i, +f.x.toFixed(2), +f.y.toFixed(2)]); break; }
            }
          }
        }
      });
      return { inBand, n, hits };
    }, { L: lanes.LANES, S: lanes.SPECIES, B: lanes.BUSH_R });
    if (r.inBand > worst.inBand) worst = { ...r, aim: [ax, ay] };
  }
}
await page.evaluate(() => window.__game.minigames.close());
console.log(`rifle: worst aim ${JSON.stringify(worst.aim ?? null)} puts ${worst.inBand} samples in a lane band ${JSON.stringify(worst.hits ?? [])}`);
if (worst.inBand > 0) failed = true;
if (errors.length) { console.log('errors', errors.slice(0, 5)); failed = true; }
console.log(failed ? 'FAIL' : 'OK');
await browser.close();
process.exit(failed ? 1 : 0);
