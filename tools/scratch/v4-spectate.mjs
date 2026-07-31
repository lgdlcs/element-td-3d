/**
 * SCENARIO 4 - SPECTATE.
 * Two clients in one room. Page 2 watches page 1 and must see the REMOTE board:
 * remote creeps, remote towers, both moving. The colour filter must be on, Escape
 * must leave the mode, and - the requirement the whole feature rests on - page 2's
 * OWN simulation must keep advancing the entire time it is watching.
 *
 * Usage: node tools/scratch/v4-spectate.mjs [baseUrl]   (default http://localhost:5294)
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5294';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const log = (k, v) => console.log(`${k}: ${JSON.stringify(v)}`);
const errs = { host: [], watcher: [] };

const browser = await chromium.launch({ args: ARGS });
const ctx = await browser.newContext();
const mk = async (tag) => {
  const p = await ctx.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('console', (m) => { if (m.type() === 'error') errs[tag].push(m.text()); });
  p.on('pageerror', (e) => errs[tag].push(`pageerror: ${e.message}`));
  return p;
};
const host = await mk('host');       // page 1: the board being watched
const watcher = await mk('watcher'); // page 2: the spectator

// ---- room ------------------------------------------------------------------
await host.goto(`${BASE}/?mp&q=low`, { waitUntil: 'load' });
await host.waitForFunction(() => window.__game, null, { timeout: 45000 });
await host.waitForSelector('#lobby:not([hidden])', { timeout: 20000 });
await host.fill('#lobby-name', 'Streamer');
await host.click('#lobby-create');
await host.waitForFunction(
  () => (document.querySelector('#lobby-code-chars')?.textContent || '').trim().length >= 4,
  null, { timeout: 20000 });
const code = (await host.textContent('#lobby-code-chars')).trim();

await watcher.goto(`${BASE}/?mp&q=low`, { waitUntil: 'load' });
await watcher.waitForFunction(() => window.__game, null, { timeout: 45000 });
await watcher.waitForSelector('#lobby:not([hidden])', { timeout: 20000 });
await watcher.fill('#lobby-name', 'Watcher');
await watcher.fill('#lobby-code-in', code);
await watcher.click('#lobby-join');
await host.waitForFunction(() => document.querySelectorAll('#lobby-roster li').length >= 2,
  null, { timeout: 20000 });
await host.click('#lobby-ready');
await watcher.click('#lobby-ready');
await host.waitForTimeout(800);
await host.waitForSelector('#lobby-start:not([hidden])', { timeout: 20000 });
await host.click('#lobby-start');
for (const p of [host, watcher]) {
  await p.waitForFunction(() => window.__game.state.phase !== 'lobby', null, { timeout: 25000 });
}
log('room', { code, hostId: await host.evaluate(() => window.__net.id),
  watcherId: await watcher.evaluate(() => window.__net.id) });

// ---- both boards get towers and a live wave --------------------------------
const arm = async (p, element) => {
  await p.evaluate((el) => {
    const g = window.__game;
    g.state.pendingElementPicks = 1;
    g.chooseElement(el);
    g.state.gold = 500000; g.state.lives = 99999;
    g.setSpeed(2);
  }, element);
  await p.waitForTimeout(500);
  return p.evaluate((el) => {
    const g = window.__game;
    g.state.phase = 'prep'; g.state.prepTimer = 9999;
    let built = 0;
    // Spread towers over the board: some will sit on the lane whatever the maze
    // looks like, which is all this needs - it is a visibility test, not a build.
    for (let c = 2; c < g.grid.cols - 3 && built < 14; c += 2) {
      for (let r = 2; r < g.grid.rows - 3 && built < 14; r += 2) {
        if (g.placementReason(c, r) === 'valid' && g.build(el, c, r)) built++;
      }
    }
    g.state.wave = 15; g.state.prepTimer = 999;
    g.startWaveNow();
    return { built, towers: g.towers.towers.length, wave: g.state.wave };
  }, element);
};
log('hostBoard', await arm(host, 'fire'));
log('watcherBoard', await arm(watcher, 'water'));

// Keep both runs alive for the whole test: leaks must not end anyone's run, and
// each board must always have creeps so "it is moving" is testable.
const keepAlive = async (p) => p.evaluate(() => {
  const g = window.__game;
  window.__ka = setInterval(() => {
    g.state.lives = 99999;
    g.state.gold = 500000;
    if (g.state.phase === 'prep') g.startWaveNow();
  }, 500);
});
await keepAlive(host); await keepAlive(watcher);
await host.waitForTimeout(4000);

// ---- watcher subscribes, through the real scoreboard row -------------------
const hostId = await host.evaluate(() => window.__net.id);
await watcher.waitForFunction((id) => !!document.querySelector(`#scoreboard .sb-list li[data-id="${id}"]`),
  hostId, { timeout: 20000 });

const before = await watcher.evaluate(() => {
  const g = window.__game;
  return {
    spectating: g.spectating,
    wave: g.state.wave, score: g.state.score, elapsed: +g.elapsed.toFixed(2),
    ownTowers: g.towers.towers.length,
    ownDamage: Math.round(g.towers.towers.reduce((s, t) => s + t.totalDamage, 0)),
    ownCreeps: g.creeps._liveCount,
    localCreepsVisible: g.creeps.renderEnabled,
    spectateTint: g.pipeline._spectateTarget,
  };
});
log('watcher_before', before);

await watcher.click(`#scoreboard .sb-list li[data-id="${hostId}"]`);
await watcher.waitForFunction(() => window.__game.spectating === true, null, { timeout: 20000 });
await watcher.waitForFunction(() => window.__spectate.view && !window.__spectate.view.loading,
  null, { timeout: 25000 });

// ---- what the watcher can see of the REMOTE board --------------------------
const sample = () => watcher.evaluate(() => {
  const g = window.__game;
  const v = window.__spectate.view;
  const c = v.creeps;
  const pos = [];
  for (let n = 0; n < c._liveCount && n < 12; n++) { const i = c._live[n]; pos.push([+c.x[i].toFixed(3), +c.z[i].toFixed(3)]); }
  return {
    watchingId: window.__net.watching,
    watchingName: v.name,
    remoteCreeps: c._liveCount,
    remoteTowers: v.towers.length,
    remoteTowerKeys: [...new Set(v.towers.map((t) => t.key))],
    remoteStats: { wave: v.stats.w, lives: v.stats.l, score: v.stats.sc },
    creepPositions: pos,
    towerYaws: v.towers.slice(0, 6).map((t) => +(t.yaw ?? 0).toFixed(4)),
    stalled: v.stalled,
    // Local presentation is handed over while spectating.
    localCreepsRenderEnabled: g.creeps.renderEnabled,
    localTowersRenderEnabled: g.towers.renderEnabled,
    arenaGridIsRemote: g.arena.grid === v.grid,
    // Colour filter.
    spectateTarget: g.pipeline._spectateTarget,
    spectateColor: g.pipeline.passes.grade
      ? [...g.pipeline.passes.grade.uniforms.uSpectateColor.value.toArray()].map((x) => +x.toFixed(4))
      : null,
    spectateMix: g.pipeline.passes.grade?.uniforms.uSpectate?.value ?? null,
    barVisible: !document.querySelector('#spectate-bar')?.hidden,
    // Local simulation, which must NOT have stopped.
    localWave: g.state.wave, localScore: g.state.score, localElapsed: +g.elapsed.toFixed(2),
    localCreeps: g.creeps._liveCount,
    localDamage: Math.round(g.towers.towers.reduce((s, t) => s + t.totalDamage, 0)),
  };
});

const s1 = await sample();
log('spectate_t0', s1);
await watcher.waitForTimeout(2000);
const s2 = await sample();
log('spectate_t2s', s2);

const movedCreeps = s1.creepPositions.filter((p, i) =>
  s2.creepPositions[i] && (p[0] !== s2.creepPositions[i][0] || p[1] !== s2.creepPositions[i][1])).length;
log('MOVEMENT', {
  remoteCreepsMoved: `${movedCreeps}/${Math.min(s1.creepPositions.length, s2.creepPositions.length)}`,
  remoteTowerYawsChanged: s1.towerYaws.filter((y, i) => y !== s2.towerYaws[i]).length,
  remoteWaveOrScoreChanged: s1.remoteStats.score !== s2.remoteStats.score
    || s1.remoteStats.wave !== s2.remoteStats.wave,
});

// A longer watch, to make "the local run kept going" unambiguous.
await watcher.waitForTimeout(6000);
const s3 = await sample();
log('spectate_t8s', s3);
log('LOCAL_SIM_DURING_SPECTATE', {
  elapsed: [before.elapsed, s1.localElapsed, s3.localElapsed],
  wave: [before.wave, s1.localWave, s3.localWave],
  score: [before.score, s1.localScore, s3.localScore],
  ownDamage: [before.ownDamage, s1.localDamage, s3.localDamage],
  advancedWhileSpectating: s3.localElapsed > s1.localElapsed && s3.localDamage > s1.localDamage,
});

// ---- Escape leaves the mode ------------------------------------------------
await watcher.keyboard.press('Escape');
await watcher.waitForTimeout(1200);
log('AFTER_ESCAPE', await watcher.evaluate(() => {
  const g = window.__game;
  const v = window.__spectate.view;
  return {
    spectating: g.spectating,
    netWatching: window.__net.watching,
    viewCreeps: v ? v.creeps._liveCount : null,
    viewTowers: v ? v.towers.length : null,
    localCreepsRenderEnabled: g.creeps.renderEnabled,
    localTowersRenderEnabled: g.towers.renderEnabled,
    arenaGridIsLocal: g.arena.grid === g.grid,
    spectateTarget: g.pipeline._spectateTarget,
    barHidden: document.querySelector('#spectate-bar')?.hidden ?? 'no-bar',
    localWave: g.state.wave, localElapsed: +g.elapsed.toFixed(2),
    localDamage: Math.round(g.towers.towers.reduce((s, t) => s + t.totalDamage, 0)),
  };
}));

await watcher.waitForTimeout(2500);
log('AFTER_ESCAPE_STILL_RUNNING', await watcher.evaluate(() => {
  const g = window.__game;
  return {
    localElapsed: +g.elapsed.toFixed(2),
    localDamage: Math.round(g.towers.towers.reduce((s, t) => s + t.totalDamage, 0)),
    localCreeps: g.creeps._liveCount,
  };
}));

log('errors', errs);
await browser.close();
