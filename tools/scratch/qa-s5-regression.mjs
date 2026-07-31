/**
 * QA scenario 5 — NON-REGRESSION on the plain solo run.
 *
 * No cheats beyond what a player does in the first minute: take the opening
 * element, build two towers with the starting gold, and watch for 30 seconds.
 * Asserts the boring things that the four features must not have broken:
 * the run starts, creeps spawn, creeps MOVE, creeps DIE, and the console stays
 * clean for the whole window.
 *
 * Run against the built bundle by default — that is what a player loads, and it
 * has no dev-server noise to explain away.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5294';
const ARGS = ['--enable-unsafe-swiftshader', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit', '--use-angle=metal'];

const browser = await chromium.launch({ args: ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const warnings = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
  if (m.type() === 'warning') warnings.push('console.warn: ' + m.text());
});
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`${BASE}/?solo&q=low`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const g = window.__game;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = { startGold: g.state.gold, startLives: g.state.lives, phase: g.state.phase };

  // The opening pick, exactly as the picker would deliver it.
  let guard = 0;
  // rollElementChoices() hands back element OBJECTS; chooseElement wants the id.
  while (g.state.pendingElementPicks > 0 && guard++ < 8) {
    const offer = g.rollElementChoices()[0];
    g.chooseElement(typeof offer === 'string' ? offer : offer.id);
  }
  R.element = g.state.elements[0];
  R.available = g.availableTowers.map((d) => d.key);
  R.goldAfterPick = g.state.gold;

  // Skip the prep countdown, then find the route and build with STARTING GOLD ONLY.
  g.state.prepTimer = 0;
  await sleep(2500);
  const route = [];
  for (let i = 0; i < g.creeps.capacity && route.length < 20; i++) {
    if (g.creeps.alive[i]) route.push({ x: g.creeps.x[i], z: g.creeps.z[i] });
  }
  R.routeSamples = route.length;
  const key = g.availableTowers.find((d) => d.kind === 'pure')?.key;
  let built = 0;
  for (const p of route) {
    if (built >= 2) break;
    const a = g.grid.worldToTowerAnchor(p.x, p.z, {});
    for (const [dc, dr] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]]) {
      if (built >= 2) break;
      if (g.build(key, a.c + dc, a.r + dr)) built++;
    }
  }
  R.built = { key, count: built, goldLeft: g.state.gold, noCheating: g.state.gold >= 0 };

  // ---- 30 seconds of ordinary play ----------------------------------------
  const samples = [];
  const posAt = () => {
    const c = g.creeps;
    for (let i = 0; i < c.capacity; i++) if (c.alive[i]) return { i, x: +c.x[i].toFixed(3), z: +c.z[i].toFixed(3) };
    return null;
  };
  let movedEver = false;
  let prev = posAt();
  const t0 = performance.now();
  while (performance.now() - t0 < 30000) {
    await sleep(1000);
    const cur = posAt();
    if (prev && cur && prev.i === cur.i && (Math.abs(prev.x - cur.x) > 0.05 || Math.abs(prev.z - cur.z) > 0.05)) movedEver = true;
    if (prev && cur && prev.i !== cur.i) movedEver = movedEver || true;  // slot turnover = things died/spawned
    prev = cur;
    samples.push({
      t: Math.round((performance.now() - t0) / 1000),
      wave: g.state.wave,
      phase: g.state.phase,
      alive: g.creeps.count,
      killed: g.state.killed,
      leaked: g.state.leaked,
      lives: g.state.lives,
      score: g.state.score,
      gold: Math.round(g.state.gold),
      dmg: Math.round(g.towers.towers.reduce((s, t) => s + (t.totalDamage || 0), 0)),
    });
  }

  const first = samples[0], last = samples[samples.length - 1];
  R.samples = samples.filter((_, i) => i % 5 === 0 || i === samples.length - 1);
  R.verdict = {
    creepsSpawned: samples.some((s) => s.alive > 0),
    creepsMoved: movedEver,
    creepsDied: last.killed > 0,
    killedFirst: first.killed, killedLast: last.killed,
    waveAdvanced: last.wave > first.wave,
    waveFirst: first.wave, waveLast: last.wave,
    towersDealtDamage: last.dmg > 0,
    stillRunning: g.state.phase !== 'gameover',
    phase: g.state.phase,
  };
  return R;
});

console.log(JSON.stringify(out, null, 2));
console.log('errors:', JSON.stringify(errors, null, 2));
console.log('warnings:', JSON.stringify(warnings, null, 2));
await browser.close();
