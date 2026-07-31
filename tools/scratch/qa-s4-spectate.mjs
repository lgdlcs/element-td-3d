/**
 * QA scenario 4 — SPECTATE.
 *
 * Two real browsers, one room on the node server, both running. Page 2 watches
 * page 1 and the following are checked by observation, never by assumption:
 *
 *   a) the spectator's board carries REMOTE CREEPS and REMOTE TOWERS,
 *   b) it is animated: two samples 2s apart differ in creep positions,
 *   c) the colour filter is on (the grade pass's uSpectate uniform left 0),
 *   d) Escape leaves the mode and the filter unwinds,
 *   e) THE SPECTATOR'S OWN RUN KEPT SIMULATING while it was watching — the
 *      single property that makes the feature usable — measured on its own
 *      elapsed / score / kill counters across the watch window.
 *
 * Pages are served by vite (readable source) but the socket is the node server
 * on 5294, passed explicitly with ?server=.
 */
import { chromium } from 'playwright';

const PAGE_BASE = process.argv[2] || 'http://localhost:5298';
const WS = process.argv[3] || 'ws://localhost:5294/ws';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const browser = await chromium.launch({ args: ARGS });
const errors = [];
const mk = async (tag) => {
  const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
  await p.goto(`${PAGE_BASE}/?mp&q=low&server=${encodeURIComponent(WS)}`, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby && !!window.__net, null, { timeout: 60000 });
  await p.waitForFunction(() => window.__net.state === 'online', null, { timeout: 25000 });
  return p;
};

const A = await mk('P1');   // streamer
const B = await mk('P2');   // spectator

// ---- room ------------------------------------------------------------------
const named = (p, n) => p.evaluate((v) => {
  const el = document.querySelector('#lobby-name');
  el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
}, n);
await named(A, 'Streamer');
await A.click('#lobby-create');
await A.waitForFunction(() => document.querySelector('#lobby-code-chars')?.textContent.trim().length === 4,
  null, { timeout: 20000 });
const code = (await A.textContent('#lobby-code-chars')).trim();
await named(B, 'Watcher');
await B.evaluate((c) => {
  const el = document.querySelector('#lobby-code-in');
  el.value = c; el.dispatchEvent(new Event('input', { bubbles: true }));
}, code);
await B.click('#lobby-join');
await A.waitForFunction(() => [...document.querySelectorAll('#lobby-roster li')]
  .filter((li) => !li.textContent.includes('open seat')).length === 2, null, { timeout: 20000 });
await B.click('#lobby-ready');
await A.waitForTimeout(300);
await A.click('#lobby-ready');
await A.waitForTimeout(400);
await A.click('#lobby-start');
for (const p of [A, B]) {
  await p.waitForFunction(() => window.__game && window.__game.state.phase !== 'lobby', null, { timeout: 25000 });
}

// ---- put both boards into a live wave with towers ---------------------------
// Both pages run the SAME seed, so the same map and the same route.
const arm = async (p) => p.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Clear the element picker so the run is not sitting on a modal.
  let guard = 0;
  while (g.state.pendingElementPicks > 0 && guard++ < 12) g.chooseElement('fire');
  g.state.gold = 900000;
  g.state.lives = 100000;
  g.state.phase = 'prep'; g.state.prepTimer = 0; g.state.wave = 0;
  g.startWaveNow();
  await sleep(2500);
  const route = [];
  for (let i = 0; i < g.creeps.capacity && route.length < 20; i++) {
    if (g.creeps.alive[i]) route.push({ x: g.creeps.x[i], z: g.creeps.z[i] });
  }
  let built = 0;
  for (const pt of route) {
    if (built >= 4) break;
    const a = g.grid.worldToTowerAnchor(pt.x, pt.z, {});
    for (const [dc, dr] of [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, -3]]) {
      if (built >= 4) break;
      g.state.gold = 900000;
      if (g.build('fire', a.c + dc, a.r + dr)) built++;
    }
  }
  // A long wave so there is something to look at for the whole window.
  g.state.wave = 15; g.state.phase = 'prep'; g.state.prepTimer = 0; g.state.lives = 100000;
  g.startWaveNow();
  return { built, towers: g.towers.towers.length, phase: g.state.phase, seed: g.seed };
});
const armA = await arm(A);
const armB = await arm(B);
await A.waitForTimeout(2500);

// ---- who is who ------------------------------------------------------------
const targetId = await B.evaluate(async () => {
  const me = window.__net.id;
  for (let i = 0; i < 60; i++) {
    const rows = [...document.querySelectorAll('#scoreboard .sb-list li')].map((li) => li.dataset.id);
    const other = rows.find((id) => id && id !== me);
    if (other) return other;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
});

const R = { code, armA, armB, targetId, seedsMatch: armA.seed === armB.seed };

// ---- local baseline BEFORE the watch ---------------------------------------
const localSnap = (p) => p.evaluate(() => {
  const g = window.__game;
  return {
    elapsed: +g.elapsed.toFixed(2),
    wave: g.state.wave,
    phase: g.state.phase,
    score: g.state.score,
    killed: g.state.killed,
    localCreeps: g.creeps.count,
    localTowerDamage: Math.round(g.towers.towers.reduce((s, t) => s + (t.totalDamage || 0), 0)),
    spectating: g.spectating,
  };
});
R.localBefore = await localSnap(B);

// ---- subscribe -------------------------------------------------------------
await B.evaluate((id) => window.__net.watch(id), targetId);
const entered = await B.waitForFunction(() => window.__game.spectating === true, null, { timeout: 20000 })
  .then(() => true).catch(() => false);
R.enteredSpectate = entered;

// Give the playout buffer time to fill past its delay.
await B.waitForTimeout(2500);

const remoteSnap = (p) => p.evaluate(() => {
  const g = window.__game;
  const v = window.__spectate.view;
  const c = v.creeps;
  const pos = [];
  for (let i = 0; i < c.capacity && pos.length < 12; i++) {
    if (c.alive[i]) pos.push(+c.x[i].toFixed(3), +c.z[i].toFixed(3));
  }
  let liveCreeps = 0;
  for (let i = 0; i < c.capacity; i++) if (c.alive[i]) liveCreeps++;
  return {
    watching: window.__net.watching,
    name: v.name,
    loading: v.loading,
    stalled: v.stalled,
    stats: { ...v.stats },
    remoteCreeps: liveCreeps,
    remoteTowers: v.towers.length,
    remoteTowerKeys: v.towers.map((t) => t.key).slice(0, 8),
    creepSample: pos,
    // The colour filter: the grade pass ramps this toward 1 while spectating.
    uSpectate: +g.pipeline.passes.grade.uniforms.uSpectate.value.toFixed(3),
    uSpectateColor: [...g.pipeline.passes.grade.uniforms.uSpectateColor.value.toArray()].map((n) => +n.toFixed(3)),
    barVisible: !!document.querySelector('.spectate-bar, #spectate-bar')
      && getComputedStyle(document.querySelector('.spectate-bar, #spectate-bar')).display !== 'none',
    // Local board must be muted on screen but still simulating.
    localCreepsRenderEnabled: g.creeps.renderEnabled,
    localTowersRenderEnabled: g.towers.renderEnabled,
  };
});

R.sample1 = await remoteSnap(B);
await B.waitForTimeout(2000);
R.sample2 = await remoteSnap(B);

// Did the remote board actually move between the two samples?
const s1 = R.sample1.creepSample, s2 = R.sample2.creepSample;
const n = Math.min(s1.length, s2.length);
let moved = 0, maxDelta = 0;
for (let i = 0; i < n; i++) {
  const d = Math.abs(s1[i] - s2[i]);
  if (d > 0.05) moved++;
  if (d > maxDelta) maxDelta = d;
}
R.movement = { comparedValues: n, changed: moved, maxDelta: +maxDelta.toFixed(3), animated: moved > 0 };

// ---- e) the local run never stopped ----------------------------------------
R.localDuring = await localSnap(B);

// ---- d) Escape exits -------------------------------------------------------
await B.bringToFront();
await B.keyboard.press('Escape');
await B.waitForTimeout(1200);
R.afterEscape = await B.evaluate(() => {
  const g = window.__game;
  return {
    spectating: g.spectating,
    netWatching: window.__net.watching,
    uSpectate: +g.pipeline.passes.grade.uniforms.uSpectate.value.toFixed(3),
    localCreepsRenderEnabled: g.creeps.renderEnabled,
    localTowersRenderEnabled: g.towers.renderEnabled,
    viewTowers: window.__spectate.view?.towers.length,
  };
});
await B.waitForTimeout(1500);
R.localAfter = await localSnap(B);
R.afterEscapeSettled = await B.evaluate(() =>
  +window.__game.pipeline.passes.grade.uniforms.uSpectate.value.toFixed(3));

R.localKeptSimulating = {
  elapsedBefore: R.localBefore.elapsed,
  elapsedDuring: R.localDuring.elapsed,
  elapsedAfter: R.localAfter.elapsed,
  elapsedAdvancedDuringWatch: R.localDuring.elapsed > R.localBefore.elapsed,
  damageBefore: R.localBefore.localTowerDamage,
  damageDuring: R.localDuring.localTowerDamage,
  damageAdvancedDuringWatch: R.localDuring.localTowerDamage > R.localBefore.localTowerDamage,
  scoreBefore: R.localBefore.score,
  scoreDuring: R.localDuring.score,
  killedBefore: R.localBefore.killed,
  killedDuring: R.localDuring.killed,
};

R.errors = errors;
console.log(JSON.stringify(R, null, 2));
await browser.close();
