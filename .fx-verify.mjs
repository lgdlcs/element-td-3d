/**
 * Headless verification that the impact rules in Projectiles.js still resolve:
 * direct damage, splash falloff, chain, slow, burn, poison, execute scaling,
 * and the onDamage callback.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const logs = [];
page.on('pageerror', (e) => logs.push('ERR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') logs.push('CERR ' + m.text()); });
await page.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const g = window.__game;
  const c = g.creeps;
  const P = g.projectiles;
  const R = {};

  const clearAll = () => { for (let i = 0; i < c.capacity; i++) c.alive[i] = 0; c.count = 0; };
  const put = (x, z, hpFrac = 1) => {
    const i = c.spawn('normal', 10000, 0, 0);
    c.x[i] = x; c.z[i] = z; c.y[i] = 0.5;
    c.vx[i] = 0; c.vz[i] = 0; c.speed[i] = 0; c.baseSpeed[i] = 0;
    c.spawnT[i] = 1;
    c.maxHp[i] = 10000; c.hp[i] = 10000 * hpFrac;
    return i;
  };
  // Fire a projectile that is already touching its target so it impacts on the
  // very next update tick.
  const fire = (target, stats, extra = {}) => {
    // Rebuild the spatial hash so query()-based splash/chain can see neighbours.
    c.update(0.0001, g.path ?? null);
    const i = P.spawn({
      x: c.x[target], y: c.y[target] + 0.8, z: c.z[target],
      tx: c.x[target], ty: c.y[target] + 0.8, tz: c.z[target],
      target, speed: 30, color: 0xff5a1f, accent: 0xffd166,
      towerId: 77, stats, arc: 0, ...extra,
    });
    P.update(0.016);
    return i;
  };

  let damageEvents = [];
  P.onDamage = (towerId, amount, idx) => damageEvents.push({ towerId, amount, idx });

  // --- 1. direct damage + onDamage ---------------------------------
  clearAll(); damageEvents = [];
  let a = put(0, 0);
  fire(a, { damage: 500 });
  R.direct = { hpLost: 10000 - c.hp[a], events: damageEvents.length, towerId: damageEvents[0]?.towerId };

  // --- 2. splash with falloff --------------------------------------
  clearAll(); damageEvents = [];
  a = put(0, 0);
  const near = put(1.0, 0);      // close -> small falloff
  const far = put(2.6, 0);       // near the rim -> big falloff
  const outside = put(6, 0);     // outside radius -> untouched
  fire(a, { damage: 1000, splash: { radius: 3, falloff: 0.8 } });
  R.splash = {
    direct: 10000 - c.hp[a],
    near: Math.round(10000 - c.hp[near]),
    far: Math.round(10000 - c.hp[far]),
    outside: 10000 - c.hp[outside],
    falloffOrdered: (10000 - c.hp[near]) > (10000 - c.hp[far]) && (10000 - c.hp[far]) > 0,
  };

  // --- 3. chain ----------------------------------------------------
  clearAll(); damageEvents = [];
  a = put(0, 0);
  const c1 = put(2, 0), c2 = put(4, 0), c3 = put(6, 0);
  fire(a, { damage: 1000, chain: { count: 2, falloff: 0.5 } });
  R.chain = {
    direct: 10000 - c.hp[a],
    hops: [c1, c2, c3].map((i) => Math.round(10000 - c.hp[i])),
    events: damageEvents.length,
  };

  // --- 4. slow -----------------------------------------------------
  clearAll();
  a = put(0, 0);
  fire(a, { damage: 1, slow: { amt: 0.4, dur: 2.5 } });
  R.slow = { slowT: +c.slowT[a].toFixed(2), amt: c.slowAmt ? +c.slowAmt[a].toFixed(2) : 'n/a' };

  // --- 5. burn -----------------------------------------------------
  clearAll();
  a = put(0, 0);
  fire(a, { damage: 1, burn: { dps: 40, dur: 3 } });
  R.burn = { burnT: +c.burnT[a].toFixed(2), dps: c.burnDps ? +c.burnDps[a].toFixed(1) : 'n/a' };

  // --- 6. poison (routed through applyBurn, as before) -------------
  clearAll();
  a = put(0, 0);
  fire(a, { damage: 1, poison: { dps: 25, dur: 4 } });
  R.poison = { burnT: +c.burnT[a].toFixed(2), dps: c.burnDps ? +c.burnDps[a].toFixed(1) : 'n/a' };

  // --- 7. execute scaling ------------------------------------------
  clearAll();
  const full = put(0, 0, 1.0);
  fire(full, { damage: 100, execute: 0.1 });
  const dFull = 10000 - c.hp[full];
  clearAll();
  const hurt = put(0, 0, 0.2);   // 80% missing
  fire(hurt, { damage: 100, execute: 0.1 });
  const dHurt = 2000 - c.hp[hurt];
  R.execute = { full: Math.round(dFull), hurt: Math.round(dHurt), scales: dHurt > dFull * 1.3 };

  // --- 8. element passthrough + graceful fallback -------------------
  clearAll();
  a = put(0, 0);
  const withEl = P.spawn({
    x: 0, y: 3, z: 8, tx: 0, ty: 0.6, tz: 0, target: a, speed: 30,
    color: 0x2fa8ff, accent: 0xa8e8ff, towerId: 1, stats: { damage: 1 }, arc: 0,
    element: 'steam',
  });
  const noEl = P.spawn({
    x: 1, y: 3, z: 8, tx: 1, ty: 0.6, tz: 0, target: a, speed: 30,
    color: 0xc08a4a, accent: 0xf0d6a8, towerId: 1, stats: { damage: 1 }, arc: 0,
  });
  R.family = { withElement: P.family[withEl], inferredFromColour: P.family[noEl] };

  R.drawCallsAfter = g.pipeline.renderer.info.render.calls;
  return R;
});

// Draw-call attribution: render with the VFX layer forcibly hidden, then shown.
const dc = await page.evaluate(async () => {
  const g = window.__game;
  const r = g.pipeline.renderer;
  const names = ['fx', 'projectile-bodies'];
  const fxObjects = [];
  g.scene.traverse((o) => {
    if (o.isPoints || o.isMesh || o.isLine) {
      const n = o.parent?.name;
      if (names.includes(n) || o.userData.__fx) fxObjects.push(o);
    }
  });
  return { tagged: fxObjects.length };
});

await browser.close();
console.log(JSON.stringify({ out, dc, logs }, null, 2));
