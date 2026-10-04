/**
 * Runs vsync-flicker.mjs over refresh rates x presets x machine speeds and
 * prints one line per cell. Needs a dev server on --port.
 *
 *   node tools/scratch/vsync-sweep.mjs --port 5340 [--secs 60] [--jobs 4] [--out dir]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PORT = arg('port', '5340');
const SECS = arg('secs', '60');
const JOBS = Number(arg('jobs', 4));
const OUT = arg('out', null);
const probe = fileURLToPath(new URL('./vsync-flicker.mjs', import.meta.url));

const cells = [];
for (const hz of [60, 100, 144]) {
  for (const q of ['potato', 'low', 'high']) cells.push({ hz, q, cost: 1.1 });
  cells.push({ hz, q: 'potato', cost: 0.5 });
  cells.push({ hz, q: 'potato', cost: 3 });
}

function run({ hz, q, cost }) {
  return new Promise((resolve) => {
    const child = spawn('node', [probe, '--port', PORT, '--hz', hz, '--q', q, '--cost', cost, '--secs', SECS]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve({ hz, q, cost, failed: out.slice(-400) }); }
    });
  });
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: JOBS }, async () => {
  while (next < cells.length) results.push(await run(cells[next++]));
}));
results.sort((a, b) => a.hz - b.hz || a.cost - b.cost || a.q.localeCompare(b.q));
if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/sweep.json`, JSON.stringify(results, null, 1)); }
for (const r of results) {
  if (r.failed) { console.log(`${r.hz}Hz ${r.q} cost=${r.cost} FAILED ${r.failed}`); continue; }
  console.log(`${r.hz}Hz ${r.q.padEnd(6)} cost=${String(r.cost).padEnd(3)} frames=${r.frames} black=${r.black} resizeAfterRender=${r.resizedAfterRender} scaleChanges=${r.scaleChanges} govChanges=${r.govChanges} sizeChanges=${r.sizeChanges} final=${r.finalScale} gov=${r.governorStep} medianMs=${r.medianMs} errors=${r.errors.length}`);
}
