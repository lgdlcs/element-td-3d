/**
 * Where do the STUTTERS come from? (as opposed to the low average frame rate)
 *
 * The report that prompted this branch was "énormément de freeze et peu de
 * FPS" — two complaints, not one. Every probe in this directory measures the
 * second. This one measures the first.
 *
 * THE HYPOTHESIS, AND WHY IT IS THE FIRST ONE TO TEST
 *
 * EffectSystem's LightPool arms and disarms its point lights per effect, and
 * its own docblock flags the consequence and declines to measure it:
 *
 *   "the recompile the original design avoided is real, but it is bounded:
 *    three.js caches one program variant per light count, so each variant
 *    compiles once and is a cache hit thereafter. A median win of this size is
 *    worth a handful of first-use compiles — but it is a p95 risk, and p95 is
 *    half the budget target, so it must be measured and not assumed."
 *
 * That is exactly the shape of a freeze: a shader link is a synchronous,
 * multi-hundred-millisecond stall on a weak driver, it happens mid-combat when
 * the light count first reaches a new value, and it is invisible to a median.
 * `renderer.compile()` at boot cannot pre-empt it, because at boot the pool is
 * disarmed and only the zero-light variant exists.
 *
 * WHAT THIS RECORDS
 *
 * Every frame over a combat window: the frame time, three.js's program count,
 * and the number of visible lights. Then it lines the three up. A spike that
 * coincides with the program count increasing is a compile; a spike with no new
 * program is something else, and knowing WHICH is the entire point — the fix
 * for a compile stall (warm the variants) is useless against a GC pause and
 * vice versa.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const q = process.argv[2] ?? 'low';
const extra = process.argv[3] ? `&${process.argv[3]}` : '';
const SECONDS = 30;

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
let pageErr = null;
p.on('pageerror', (e) => { pageErr = e.message; });
await p.goto(`http://localhost:5273/?solo&q=${q}${extra}`, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

const atBoot = await p.evaluate(() => ({
  programs: window.__game.pipeline.renderer.info.programs.length,
  lights: (() => { let n = 0; window.__game.scene.traverse((o) => { if (o.isLight && o.visible) n++; }); return n; })(),
}));
console.log(`preset ${q}${extra ? ' ' + extra : ' (shader warm-up ON)'}`);
console.log(`after boot + renderer.compile(): ${atBoot.programs} programs, ${atBoot.lights} visible lights\n`);

// Build a board and start a live wave, then record every frame while it fights.
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
});

// Optional arm: hold the fx light pool at a CONSTANT visible-light count for
// the whole window. If the mid-combat compiles are new materials multiplied by
// the light counts they first appear under, pinning the count collapses the
// multiplier and program growth should fall sharply. If growth barely moves,
// the compiles are per-material and the light pool is not the lever.
if (process.argv.includes('suspend')) {
  await p.evaluate(() => {
    const pool = window.__game.fx.lights;
    pool.suspended = true;
    for (const it of [...pool.items, ...pool.embers]) it.light.visible = false;
  });
}

const trace = await p.evaluate((secs) => new Promise((res) => {
  const g = window.__game;
  const rows = [];
  let t0 = performance.now();
  const end = t0 + secs * 1000;
  // Start the wave INSIDE the recording so the first shots — the first time
  // the light pool arms anything — are captured rather than warmed away.
  g.waves.start(21);
  const tick = () => {
    const t = performance.now();
    const dt = t - t0; t0 = t;
    let lights = 0;
    g.scene.traverse((o) => { if (o.isLight && o.visible) lights++; });
    rows.push([+dt.toFixed(1), g.pipeline.renderer.info.programs.length, lights]);
    if (t < end) requestAnimationFrame(tick);
    else res(rows);
  };
  requestAnimationFrame(tick);
}), SECONDS);

if (pageErr) { console.log('ABORT: frame loop threw: ' + pageErr); await b.close(); process.exit(1); }

const times = trace.map((r) => r[0]);
const sorted = times.slice().sort((a, c) => a - c);
const median = sorted[sorted.length >> 1];
const p95 = sorted[Math.floor(sorted.length * 0.95)];
const p99 = sorted[Math.floor(sorted.length * 0.99)];

console.log(`${trace.length} frames over ${SECONDS}s`);
console.log(`median ${median.toFixed(1)} ms   p95 ${p95.toFixed(1)} ms   p99 ${p99.toFixed(1)} ms   max ${Math.max(...times).toFixed(1)} ms\n`);

// A hitch is a frame several times the median — the thing a player calls a
// freeze, as distinct from the game merely being slow throughout.
const HITCH = Math.max(50, median * 3);
const hitches = [];
for (let i = 1; i < trace.length; i++) {
  if (trace[i][0] < HITCH) continue;
  hitches.push({
    at: (trace.slice(0, i).reduce((a, r) => a + r[0], 0) / 1000).toFixed(1),
    ms: trace[i][0],
    newPrograms: trace[i][1] - trace[i - 1][1],
    programs: trace[i][1],
    lights: trace[i][2],
    lightsDelta: trace[i][2] - trace[i - 1][2],
  });
}

console.log(`frames over ${HITCH.toFixed(0)} ms (3x median): ${hitches.length}`);
if (hitches.length) {
  console.log('\n  at(s)     ms    new programs   total   lights (delta)');
  for (const h of hitches.slice(0, 40)) {
    console.log(`  ${h.at.padStart(5)}  ${String(h.ms).padStart(6)}   ${String(h.newPrograms).padStart(6)}        ${String(h.programs).padStart(5)}   ${String(h.lights).padStart(3)} (${h.lightsDelta >= 0 ? '+' : ''}${h.lightsDelta})`);
  }
  const withCompile = hitches.filter((h) => h.newPrograms > 0).length;
  console.log(`\n  ${withCompile} of ${hitches.length} hitches coincide with a NEW SHADER PROGRAM.`);
  console.log(`  ${hitches.length - withCompile} do not — those are not compile stalls.`);
}

const first = trace[0][1];
const last = trace[trace.length - 1][1];
console.log(`\nprograms: ${first} at wave start -> ${last} at end (+${last - first} compiled during combat)`);
const lightCounts = [...new Set(trace.map((r) => r[2]))].sort((a, c) => a - c);
console.log(`distinct visible-light counts seen during combat: ${lightCounts.join(', ')}`);

await b.close();
