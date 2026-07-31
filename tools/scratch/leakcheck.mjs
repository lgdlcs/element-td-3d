/**
 * Does a creep that walks the whole path actually leak?
 *
 * Builds NO towers, starts a wave, and lets it run. Asserts both halves of the
 * reported bug independently:
 *   1. lives must DROP   (onLeak fired at all)
 *   2. live creeps must return to 0 (they despawned instead of piling up at the
 *      exit)
 *
 * Reports the max Z any creep reached, because "stuck at the end" and "never
 * spawned" both show 0 live creeps and only that number tells them apart.
 */
import { chromium } from 'playwright';

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
await p.waitForTimeout(1500);

const before = await p.evaluate(() => {
  const g = window.__game;
  // The game boots into the element picker, not into 'prep', and startWaveNow()
  // silently returns unless phase === 'prep'. Clear the picks first or the probe
  // measures a wave that was never sent.
  while (g.state.pendingElementPicks > 0) g.chooseElement(g.rollElementChoices()[0].id);
  g.state.prepTimer = 0;
  g.startWaveNow();
  return { lives: g.state.lives, leaked: g.state.leaked, phase: g.state.phase, wave: g.state.wave };
});
console.log('wave started:', JSON.stringify(before));
if (before.phase !== 'combat') { console.log('ABORT: wave did not start'); await b.close(); process.exit(1); }

// Poll rather than sleep blindly, so we can report peak Z even on failure.
let peakZ = -Infinity;
let live = -1;
for (let t = 0; t < 60; t++) {
  await p.waitForTimeout(1000);
  const s = await p.evaluate(() => {
    const c = window.__game.creeps;
    let n = 0, mz = -Infinity;
    for (let k = 0; k < c._liveCount; k++) {
      const i = c._live[k];
      if (!c.alive[i]) continue;
      n++;
      if (c.z[i] > mz) mz = c.z[i];
    }
    return { n, mz, lives: window.__game.state.lives, leaked: window.__game.state.leaked };
  });
  if (s.mz > peakZ) peakZ = s.mz;
  live = s.n;
  if (s.leaked > before.leaked && s.n === 0) {
    console.log(`PASS  t=${t + 1}s  lives ${before.lives} -> ${s.lives}  leaked ${s.leaked}  live creeps 0  peakZ ${peakZ.toFixed(2)}`);
    await b.close();
    process.exit(errs.length ? 1 : 0);
  }
  if (t % 5 === 4) console.log(`  t=${t + 1}s live=${s.n} lives=${s.lives} leaked=${s.leaked} peakZ=${peakZ.toFixed(2)}`);
}

console.log(`FAIL  after 60s: live creeps ${live}, peakZ ${peakZ.toFixed(2)} (leak plane is 19.0)`);
if (errs.length) console.log('errors:', errs.join('\n'));
await b.close();
process.exit(1);
