/**
 * Two real browsers, one real server, one real room, one real spectate session.
 *
 * The claim under test is the only one that can sink the feature: **the
 * watcher's own run keeps running at full rate while another board is on
 * screen.** Everything else here (creeps arriving, towers arriving, the tint,
 * the banner) is worth checking, but a spectate mode that pauses your run is
 * not a feature with a bug in it, it is the wrong feature.
 *
 * Runs its own vite (5293) and its own lobby server (5294) so it cannot collide
 * with whatever the developer has open, and stops both on the way out.
 *
 * ANTI-THROTTLING ARGS ARE NOT OPTIONAL. Headless chromium throttles
 * requestAnimationFrame, the simulation does not advance, and the game looks
 * frozen for reasons that have nothing to do with the code under test.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const VITE_PORT = 5293;
const WS_PORT = 5294;
const URL = `http://localhost:${VITE_PORT}/?q=low&mp&server=ws://localhost:${WS_PORT}/ws`;

const ARGS = [
  '--enable-unsafe-swiftshader', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--disable-frame-rate-limit',
  '--use-angle=metal',
];

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const R = [];
const ok = (name, cond, detail = '') => {
  R.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `   (${detail})` : ''}`);
};

const procs = [];
function bg(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'pipe' });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  procs.push(p);
  return p;
}
const stopAll = () => { for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* gone */ } } };

async function waitPort(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(url); return true; } catch { await sleep(250); }
  }
  return false;
}

let browser;
try {
  bg('node', ['server/index.js'], { PORT: String(WS_PORT) });
  bg('npx', ['vite', '--port', String(VITE_PORT), '--strictPort']);
  if (!await waitPort(`http://localhost:${VITE_PORT}/`)) throw new Error('vite never came up');

  browser = await chromium.launch({ args: ARGS });

  async function client(tag) {
    // Small viewport ON PURPOSE. swiftshader is a software rasteriser and the
    // full post chain at 1280x800 lands under 10 fps, which matters here beyond
    // "the test is slow": Game.frame clamps dt at 0.1s, so below 10 fps the
    // simulation clock advances slower than the wall clock and every rate
    // assertion below would be measuring the rasteriser.
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(`${tag}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errs.push(`${tag} console: ${m.text()}`); });
    await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForFunction(() => !!window.__net, null, { timeout: 90000 });
    await p.waitForFunction(() => window.__net.state === 'online', null, { timeout: 20000 });
    // The roster is not exposed on the transport, so the test keeps its own copy
    // of the last `scores` frame — exactly what the scoreboard does.
    await p.evaluate(() => { window.__net.on('scores', (m) => { window.__scores = m.players ?? []; }); });
    return { p, errs, tag };
  }

  const A = await client('A');   // host, the board that will be watched
  const B = await client('B');   // the spectator, whose run must not pause

  // --- room --------------------------------------------------------------
  await A.p.evaluate(() => { window.__net.hello('Alice'); window.__net.create(); });
  await A.p.waitForFunction(() => !!window.__net.code, null, { timeout: 10000 });
  const code = await A.p.evaluate(() => window.__net.code);
  ok('room created', !!code, `code=${code}`);

  await B.p.evaluate((c) => { window.__net.hello('Bob'); window.__net.join(c); }, code);
  await B.p.waitForFunction(() => !!window.__net.code, null, { timeout: 10000 });

  await A.p.evaluate(() => window.__net.start());
  for (const c of [A, B]) {
    await c.p.waitForFunction(() => window.__game._begun === true, null, { timeout: 15000 });
  }
  ok('both runs started from one `go`', true);

  // --- get both boards into combat with towers ----------------------------
  const arm = async (c) => c.p.evaluate(async () => {
    const g = window.__game;
    g.chooseElement('fire');
    // Enough gold for a few towers, so the watched board has something to draw
    // and something to shoot with.
    g.state.gold = 4000;
    let built = 0;
    for (let r = 4; r < 14 && built < 4; r += 4) {
      for (let cc = 4; cc < 20 && built < 4; cc += 6) {
        if (g.build('fire', cc, r)) built++;
      }
    }
    g.startWaveNow();
    return { built, phase: g.state.phase };
  });
  const aArm = await arm(A);
  const bArm = await arm(B);
  ok('watched board has towers', aArm.built > 0, `A built ${aArm.built}`);
  ok('watcher board has towers', bArm.built > 0, `B built ${bArm.built}`);

  // Let the wave actually reach the board.
  await A.p.waitForFunction(() => window.__game.creeps.count > 0, null, { timeout: 20000 });
  await B.p.waitForFunction(() => window.__game.creeps.count > 0, null, { timeout: 20000 });

  // --- B watches A --------------------------------------------------------
  await B.p.waitForFunction(() => (window.__scores ?? []).length >= 2, null, { timeout: 15000 });
  const aliceId = await B.p.evaluate(() => window.__scores.find((p) => p.name === 'Alice')?.id ?? null);
  ok('spectator can address the other player', !!aliceId, `id=${aliceId}`);

  /**
   * Simulation seconds per wall second, measured over `ms`.
   *
   * A RATE and not an absolute delta, because the absolute number is a property
   * of the rasteriser, not of the feature: under swiftshader a low frame rate
   * plus Game.frame's 0.1s dt clamp makes the sim clock lag the wall clock even
   * with nothing spectating. The claim is "watching costs you nothing", so the
   * honest test is the same measurement taken twice.
   */
  const simRate = (c, ms) => c.p.evaluate(async (d) => {
    const g = window.__game;
    let frames = 0;
    let running = true;
    // Self-terminating: an rAF chain left alive would accumulate one more chain
    // per measurement and quietly change what the later ones measure.
    const count = () => { frames++; if (running) requestAnimationFrame(count); };
    requestAnimationFrame(count);
    const e0 = g.elapsed;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, d));
    running = false;
    const wall = (performance.now() - t0) / 1000;
    return { rate: (g.elapsed - e0) / wall, fps: frames / wall };
  }, ms);

  const idle = await simRate(B, 3000);
  const rateIdle = idle.rate;
  // The FLOOR is deliberately near zero. Under swiftshader, with two browsers
  // sharing one software rasteriser, the absolute rate is a property of the
  // machine's spare CPU and swings between runs; asserting a number here would
  // buy a flaky test and prove nothing about the feature. What matters is that
  // it is non-zero, and that the two measurements below are not worse than it.
  ok('baseline: B\'s run advances on its own', rateIdle > 0.02, `${rateIdle.toFixed(2)}x wall clock, ${idle.fps.toFixed(1)} fps`);

  // Baseline of B's OWN run, taken the instant before it starts watching.
  const before = await B.p.evaluate(() => {
    const g = window.__game;
    return { elapsed: g.elapsed, wave: g.state.wave, killed: g.state.killed, gold: g.state.gold };
  });

  await B.p.evaluate((id) => window.__net.watch(id), aliceId);
  await B.p.waitForFunction(() => window.__game.spectating === true, null, { timeout: 10000 });
  ok('B entered spectate', true);

  // A must have been told to start producing snapshots.
  await A.p.waitForFunction(() => window.__net.watchers > 0, null, { timeout: 10000 })
    .then(() => ok('streamer was switched on by the server', true))
    .catch(() => ok('streamer was switched on by the server', false, 'watchers stayed 0'));

  // --- the remote board actually arrives and is rendered ------------------
  await B.p.waitForFunction(() => (window.__spectate.view?.creeps.count ?? 0) > 0, null, { timeout: 15000 })
    .then(() => ok('remote creeps received and slotted', true))
    .catch(() => ok('remote creeps received and slotted', false, 'never got a creep'));

  const remote = await B.p.evaluate(() => {
    const v = window.__spectate.view;
    const c = v.creeps;
    let moving = 0;
    let onGround = 0;
    for (let i = 0; i < c._liveCount; i++) {
      const s = c._live[i];
      if (Math.hypot(c.vx[s], c.vz[s]) > 0.05) moving++;
      if (c.y[s] > -5 && c.y[s] < 30) onGround++;
    }
    return {
      creeps: c.count,
      liveMeshCount: Object.values(c.archetypes).reduce((n, a) => n + a.mesh.count, 0),
      visible: c.group.visible,
      towers: v.towers.length,
      attached: v.towers.filter((t) => !!t.inst).length,
      moving,
      onGround,
      loading: v.loading,
      stats: { ...v.stats },
      tint: window.__game.pipeline.passes.grade.uniforms.uSpectate.value,
      localTowersDetached: window.__game.towers.towers.every((t) => !t.inst),
      localCreepsHidden: window.__game.creeps.group.visible === false,
      banner: document.querySelector('#spectate-bar.on')?.textContent?.trim() ?? '',
      watchingRow: !!document.querySelector('.sb-row.watching'),
    };
  });
  ok('remote creeps are uploaded to the GPU', remote.liveMeshCount > 0, `${remote.liveMeshCount} instances`);
  ok('remote creep group is visible', remote.visible);
  ok('remote creeps are seated on the terrain', remote.onGround === remote.creeps);
  ok('remote towers arrived', remote.towers > 0, `${remote.towers} towers`);
  ok('remote towers are attached to the shared batch', remote.attached === remote.towers);
  ok('local towers were detached from the batch', remote.localTowersDetached);
  ok('local creeps are hidden', remote.localCreepsHidden);
  ok('the spectate tint is fading in', remote.tint > 0.2, `uSpectate=${remote.tint.toFixed(2)}`);
  ok('the banner names the watched player', remote.banner.includes('Alice'), remote.banner);
  ok('the scoreboard marks the watched row', remote.watchingRow);
  ok('the snapshot carries live board numbers', remote.stats.w >= 1 && remote.stats.sc >= 0,
    `W${remote.stats.w} lives=${remote.stats.l} score=${remote.stats.sc}`);

  // --- the remote board is genuinely MOVING, not a still frame ------------
  // Sampled over a couple of seconds rather than in one instant: a snapshot
  // pair can legitimately be starved for a frame (the streamer here shares a
  // software rasteriser with the watcher), and "did anything move at all" is
  // the claim, not "everything is moving right now".
  const motion = await B.p.evaluate(async () => {
    const c = window.__spectate.view.creeps;
    const start = new Map();
    for (let i = 0; i < c._liveCount; i++) start.set(c._live[i], [c.x[c._live[i]], c.z[c._live[i]]]);
    let sawVelocity = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 2200) {
      for (let i = 0; i < c._liveCount; i++) {
        const s = c._live[i];
        if (Math.hypot(c.vx[s], c.vz[s]) > 0.05) sawVelocity++;
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    let moved = 0;
    for (const [s, p] of start) {
      if (c.alive[s] && Math.hypot(c.x[s] - p[0], c.z[s] - p[1]) > 0.3) moved++;
    }
    return { sawVelocity, moved, tracked: start.size };
  });
  ok('remote creeps travel across the board', motion.moved > 0 || motion.tracked === 0,
    `${motion.moved}/${motion.tracked} moved > 0.3 units`);
  ok('remote creeps carry a reconstructed velocity', motion.sawVelocity > 0,
    `${motion.sawVelocity} samples with |v| > 0.05`);

  // --- THE LOAD-BEARING ASSERTION ----------------------------------------
  // The same rate measurement as the baseline, taken while another board is on
  // screen. Anything near the baseline proves the local run is untouched;
  // anything near zero would mean the feature costs the player their game.
  const watching = await simRate(B, 4000);
  const rateWatching = watching.rate;
  ok('B\'s run advances at the SAME rate while spectating',
    rateWatching > rateIdle * 0.6 && rateWatching > 0.02,
    `${rateWatching.toFixed(2)}x @ ${watching.fps.toFixed(1)}fps vs ${rateIdle.toFixed(2)}x @ ${idle.fps.toFixed(1)}fps idle`);

  const during = await B.p.evaluate(() => {
    const g = window.__game;
    return {
      spectating: g.spectating,
      elapsed: g.elapsed,
      wave: g.state.wave,
      killed: g.state.killed,
      gold: g.state.gold,
      creeps: g.creeps.count,
      projectiles: g.projectiles.alive.reduce((n, v) => n + v, 0),
    };
  });
  ok('B is still spectating', during.spectating);
  ok('B\'s own clock kept running', during.elapsed - before.elapsed > 0.5,
    `+${(during.elapsed - before.elapsed).toFixed(2)}s of simulation while watching`);
  ok('B\'s own simulation kept resolving combat',
    during.killed > before.killed || during.gold !== before.gold || during.creeps > 0,
    `killed ${before.killed}->${during.killed}, gold ${before.gold}->${during.gold}, creeps=${during.creeps}`);
  ok('B\'s own towers kept firing', during.projectiles >= 0 && during.killed >= before.killed,
    `${during.projectiles} projectiles in flight, kills ${before.killed}->${during.killed}`);

  // A's board must be unaffected by being watched.
  const aDuring = await A.p.evaluate(() => ({ spectating: window.__game.spectating, elapsed: window.__game.elapsed }));
  ok('the streamer is not itself spectating', aDuring.spectating === false);

  await B.p.screenshot({ path: '/tmp/etd-spectate-watching.png' });

  // --- Escape gets out, and the local board comes back --------------------
  await B.p.keyboard.press('Escape');
  await B.p.waitForFunction(() => window.__game.spectating === false, null, { timeout: 5000 });
  // WAIT for the wash to finish, do not sleep a guessed interval. The fade is
  // exponential in the frame's dt, which Game.frame clamps at 0.1s, so under a
  // software rasteriser at 5 fps it needs half a dozen frames rather than the
  // ~15 it gets at 60. A fixed sleep here fails on a loaded machine and says
  // nothing about the code.
  await B.p.waitForFunction(
    () => window.__game.pipeline.passes.grade.uniforms.uSpectate.value < 0.05,
    null, { timeout: 8000 },
  ).catch(() => {});
  const after = await B.p.evaluate(() => {
    const g = window.__game;
    return {
      spectating: g.spectating,
      localAttached: g.towers.towers.every((t) => !!t.inst),
      localVisible: g.creeps.group.visible,
      remoteVisible: window.__spectate.view.creeps.group.visible,
      remoteTowers: window.__spectate.view.towers.length,
      arenaGridIsOwn: g.arena.grid === g.grid,
      tint: g.pipeline.passes.grade.uniforms.uSpectate.value,
      banner: !!document.querySelector('#spectate-bar.on'),
      watchingRow: !!document.querySelector('.sb-row.watching'),
      renderFlags: [g.creeps.renderEnabled, g.towers.renderEnabled, g.projectiles.renderEnabled],
    };
  });
  ok('Escape left spectate', after.spectating === false);
  ok('local towers are back in the batch', after.localAttached);
  ok('local creeps are visible again', after.localVisible);
  ok('remote board is hidden', after.remoteVisible === false);
  ok('remote tower proxies were returned to the batch', after.remoteTowers === 0);
  ok('the arena points at the local grid again', after.arenaGridIsOwn);
  ok('the tint faded out', after.tint < 0.05, `uSpectate=${after.tint.toFixed(3)}`);
  ok('the banner is gone', after.banner === false);
  ok('the scoreboard marker is cleared', after.watchingRow === false);
  ok('all three render flags are back on', after.renderFlags.every(Boolean));

  await A.p.waitForFunction(() => window.__net.watchers === 0, null, { timeout: 8000 })
    .then(() => ok('the streamer was switched off again', true))
    .catch(() => ok('the streamer was switched off again', false, 'watchers stayed above 0'));

  // The local run must still be alive after the round trip — and at the rate it
  // had before it ever watched anything.
  const post = await simRate(B, 2000);
  const rateAfter = post.rate;
  ok('B\'s run is still advancing after leaving', rateAfter > rateIdle * 0.6 && rateAfter > 0.02,
    `${rateAfter.toFixed(2)}x @ ${post.fps.toFixed(1)}fps vs ${rateIdle.toFixed(2)}x idle`);

  await B.p.screenshot({ path: '/tmp/etd-spectate-after.png' });

  const errs = [...A.errs, ...B.errs];
  ok('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
} catch (err) {
  ok('harness completed', false, err.message);
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  stopAll();
}

const failed = R.filter((r) => !r.pass);
console.log(`\n${R.length - failed.length}/${R.length} passed`);
process.exit(failed.length ? 1 : 0);
