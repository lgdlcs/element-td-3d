/**
 * Shadow sweep — runtime-only, no source edits, so it cannot race Vite.
 *
 * Law 9 says shadow LENGTH and SOFTNESS must both stay under tower spacing
 * (4.0). This sweeps sun elevation x shadow-map type x filter width and reports
 * the board crop's mean AND standard deviation, paired against shadows-off on
 * the SAME build (PITFALLS §12).
 *
 * The acceptance number is the sd delta: mean says "shadows darken things",
 * sd says "shadows draw shapes".
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
mkdirSync('shots/shadow', { recursive: true });

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

await p.evaluate(async () => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 999999; g.hud.closeElementPicker?.();
  const keys = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n % 6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  await new Promise((r) => setTimeout(r, 5000));
  // DO NOT set state.paused here. TowerBatch writes its instance matrices from
  // Game.update(), so pausing leaves the BatchedMesh reporting 84 visible
  // instances while drawing nothing: the board renders EMPTY, with no error and
  // no change to `visible`. One whole sweep was measured on a towerless board
  // and read as "high sun kills tower shadows". Drift is handled instead by
  // keeping each config's ON/OFF pair adjacent, so it cancels in the delta.
});

// --- runtime config application -------------------------------------------
await p.evaluate(() => {
  window.__applyShadow = (cfg) => {
    const g = window.__game;
    const key = g.lighting.key;
    const r = g.pipeline.renderer;
    const T = { vsm: 3, pcfsoft: 2, pcf: 1, basic: 0 };

    if (cfg.elev != null) {
      // preserve the horizontal radius and azimuth, change elevation only
      const bp = g.lighting._basePos;
      const h = Math.hypot(bp.x, bp.z);
      const y = h * Math.tan(cfg.elev * Math.PI / 180);
      bp.y = y; key.position.y = y;
    }
    if (cfg.intensity != null) key.intensity = cfg.intensity;
    // Ambient-to-key ratio: the depth of a cast shadow in the final image is
    // set by what still lights the shadowed floor, not by the shadow map.
    const L = g.lighting;
    if (L.__base === undefined) L.__base = {
      fill: L.fill.intensity, rim: L._rimBase, ember: L.ember.intensity,
      hemi: L.hemi.intensity, amb: L.ambient.intensity,
      env: g.scene.environmentIntensity,
    };
    if (cfg.amb != null) {
      const k = cfg.amb, B = L.__base;
      L.fill.intensity = B.fill * k;
      L._rimBase = B.rim * k;
      L.ember.intensity = B.ember * k;
      L.hemi.intensity = B.hemi * k;
      L.ambient.intensity = B.amb * k;
      g.scene.environmentIntensity = B.env * (cfg.env != null ? cfg.env : k);
    }
    if (cfg.radius != null) key.shadow.radius = cfg.radius;
    if (cfg.blurSamples != null) key.shadow.blurSamples = cfg.blurSamples;
    if (cfg.bias != null) key.shadow.bias = cfg.bias;
    if (cfg.normalBias != null) key.shadow.normalBias = cfg.normalBias;
    if (cfg.ext != null) {
      const c = key.shadow.camera;
      c.left = -cfg.ext; c.right = cfg.ext; c.top = cfg.ext; c.bottom = -cfg.ext;
      c.updateProjectionMatrix();
    }
    if (cfg.type != null) {
      const t = T[cfg.type];
      if (r.shadowMap.type !== t) {
        r.shadowMap.type = t;
        if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
        if (key.shadow.mapPass) { key.shadow.mapPass.dispose(); key.shadow.mapPass = null; }
        g.scene.traverse((o) => { if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
        } });
      }
    }
    r.shadowMap.needsUpdate = true;
    key.shadow.needsUpdate = true;
    g.lighting.group.updateMatrixWorld(true);
  };
  // Turn OFF only the towers' shadow casting; they stay visible, so the only
  // pixels that move are the shadows they were drawing.
  window.__towerCast = (on) => {
    const g = window.__game;
    const root = g.towers.group || g.towers.root;
    // Snapshot the ORIGINAL flags once. Blindly setting castShadow=true on the
    // way back promotes glow decals and sprites into casters and permanently
    // darkens the board — it cost one whole sweep.
    root.traverse((o) => {
      if (o.userData.__cs === undefined) o.userData.__cs = !!o.castShadow;
      if (o.isMesh || o.isBatchedMesh || o.isInstancedMesh) o.castShadow = on ? o.userData.__cs : false;
    });
    g.pipeline.renderer.shadowMap.needsUpdate = true;
  };
  window.__setShadowsEnabled = (on) => {
    const g = window.__game;
    g.pipeline.renderer.shadowMap.enabled = on;
    g.scene.traverse((o) => { if (o.material) {
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
    } });
  };
});

const crop = async (file) => {
  await p.waitForTimeout(1100);
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  if (file) writeFileSync(`shots/shadow/${file}`, buf);
  return p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    const stat = (x, y, w, h) => {
      const px = cx.getImageData(x, y, w, h).data;
      const L = [];
      for (let i = 0; i < px.length; i += 4)
        L.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
      const mean = L.reduce((a, c) => a + c, 0) / L.length;
      const sd = Math.sqrt(L.reduce((a, c) => a + (c - mean) ** 2, 0) / L.length);
      return { mean: +mean.toFixed(1), sd: +sd.toFixed(1) };
    };
    const a = stat(400, 250, 1150, 650);         // acceptance crop (shadow-probe)
    const t = stat(1120, 420, 380, 400);         // tight open floor, right of the towers
    return { mean: a.mean, sd: a.sd, tmean: t.mean, tsd: t.sd };
  }, buf.toString('base64'));
};

const CONFIGS = JSON.parse(process.env.CFG || '[]');

for (const cfg of CONFIGS) {
  await p.evaluate((c) => window.__applyShadow(c), cfg);
  await p.evaluate(() => window.__setShadowsEnabled(true));
  const on = await crop(`sw-${cfg.name}-on.png`);
  await p.evaluate(() => window.__setShadowsEnabled(false));
  const off = await crop(null);
  await p.evaluate(() => window.__setShadowsEnabled(true));
  const f = (n) => String(n).padStart(5);
  console.log(`${cfg.name.padEnd(24)} ACC on ${f(on.mean)}/${f(on.sd)} off ${f(off.mean)}/${f(off.sd)} dSd ${f(+(on.sd - off.sd).toFixed(1))} | TIGHT on ${f(on.tmean)}/${f(on.tsd)} off ${f(off.tmean)}/${f(off.tsd)} dSd ${f(+(on.tsd - off.tsd).toFixed(1))}`);
}
await b.close();
