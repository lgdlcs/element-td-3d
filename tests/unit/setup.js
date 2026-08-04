/**
 * Unit-suite console filter — ONE known warning, counted, never silenced.
 *
 * `npm run test:unit` emitted 2 506 identical lines of
 *
 *     THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed.
 *
 * out of 2 544 lines of output: 98.5% noise, with "198 passed" as the very last
 * line. tower-scale.test.js builds all 67 tower specs, each of which runs ~30
 * BufferGeometries through toNonIndexed(), and three.js warns once per already
 * non-indexed geometry. Nothing is wrong; the call is a no-op.
 *
 * A suite whose output is almost entirely noise trains everyone to stop reading
 * the output, and then a REAL console.error from the code under test — or a new
 * three warning about a geometry that genuinely is broken — arrives invisibly.
 * docs/TESTING.md principle 2 is "prove the instrument can fail"; an instrument
 * nobody reads cannot.
 *
 * So: this filter matches ONE exact prefix and lets absolutely everything else
 * through untouched, then prints a single summary line at the end. It is not a
 * mute. If you find yourself adding a second pattern here, fix the cause
 * instead — the standing candidate is to make TowerParts call toNonIndexed()
 * only when `geometry.index !== null`, which is a src/ change and was left out
 * of a test-hygiene fix on purpose.
 */

const KNOWN = 'THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed.';

const realWarn = console.warn;
let suppressed = 0;

console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith(KNOWN)) {
    suppressed++;
    return;
  }
  realWarn(...args);
};

process.on('exit', () => {
  if (suppressed > 0) {
    realWarn(`[setup] ${suppressed} x "BufferGeometry is already non-indexed" from three.js, collapsed to this line.`);
  }
});
