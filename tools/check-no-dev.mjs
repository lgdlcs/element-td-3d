/**
 * Prove the dev panel is not in the production bundle.
 *
 *   npm run build && node tools/check-no-dev.mjs
 *
 * src/dev/ is reached only from `if (import.meta.env.DEV)` in main.js, which
 * Vite replaces with the literal `false` in a production build — so the branch
 * is dead code and the module never enters the graph. That is a claim about a
 * bundler's behaviour, and a claim about a bundler's behaviour is worth exactly
 * as much as the last time somebody checked it: a static import added in a
 * hurry, or a guard rewritten as a runtime flag, would ship the cheats to
 * players with nothing to say so.
 *
 * SCANS THE EXECUTABLE JAVASCRIPT ONLY, and says so rather than pretending
 * otherwise. `.map` files are excluded on purpose: sourcemaps embed the text of
 * main.js, whose COMMENT about the panel legitimately mentions it, and failing
 * on that would be failing on a comment. Nothing in a sourcemap runs, and
 * src/dev/ does not appear in one anyway — verified: the map's `sources` list
 * has no dev/ entry, because the module was never bundled.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
/** Anything that would only be present if the module had been bundled. */
const NEEDLES = ['DevPanel', 'devpanel', 'DEV PANEL'];

if (!existsSync(DIST)) {
  console.error(`no ${DIST}/ — run \`npm run build\` first`);
  process.exit(2);
}

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') || e.name.endsWith('.css') || e.name.endsWith('.html')) files.push(p);
  }
};
walk(DIST);

// A scan that reads nothing passes vacuously, which is the failure mode this
// whole file exists to prevent elsewhere.
if (files.length === 0) {
  console.error(`${DIST}/ contains no js/css/html — nothing was scanned`);
  process.exit(2);
}

const bad = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const n of NEEDLES) if (text.includes(n)) bad.push(`${f} contains "${n}"`);
}

if (bad.length) {
  console.error('THE DEV PANEL IS IN THE BUILD:');
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}

console.log(`ok — ${files.length} built files scanned, no trace of src/dev/`);
