import * as THREE from 'three';
import { buildTowerSpec } from '/Users/pouetpouets/code/element-td-3d/src/game/towers/TowerArchetypes.js';
import { ALL_TOWERS, PRIMAL_TOWERS, PURE_TOWERS, DUAL_TOWERS } from '/Users/pouetpouets/code/element-td-3d/src/game/TowerDefs.js';

const L = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function peakRadiance(spec) {
  let peak = 0;
  const scan = (geo) => {
    if (!geo) return;
    const c = geo.attributes.color.array;      // vec4 linear albedo (+ height in w)
    const m = geo.attributes.aMat.array;       // vec4, z = emissive intensity
    const n = geo.attributes.position.count;
    for (let i = 0; i < n; i++) {
      const e = m[i * 4 + 2];
      if (e <= 0) continue;
      const v = L(c[i * 4], c[i * 4 + 1], c[i * 4 + 2]) * e;
      if (v > peak) peak = v;
    }
  };
  scan(spec.base); scan(spec.head); scan(spec.collar); scan(spec.halo);
  for (const sh of spec.shards) scan(sh.geo);
  return peak;
}

const rows = [];
for (const def of Object.values(ALL_TOWERS)) {
  for (let lv = 0; lv < def.levels.length; lv++) {
    const s = buildTowerSpec(def, lv);
    rows.push({ key: def.key, kind: def.kind, lv, peak: peakRadiance(s), gi: s.glowIntensity, col: def.color });
  }
}
const lumHex = (h) => { const c = new THREE.Color().setHex(h).convertSRGBToLinear(); return L(c.r, c.g, c.b); };

console.log('--- peak emissive radiance (albedo lum x aMat.z) ---');
for (const r of rows.filter((r) => r.kind === 'primal')) {
  console.log('PRIMAL', r.key.padEnd(15), 'L' + r.lv, r.peak.toFixed(3));
}
const ord = rows.filter((r) => r.kind !== 'primal' && r.kind !== 'inert');
ord.sort((a, b) => b.peak - a.peak);
console.log('top ordinary:');
for (const r of ord.slice(0, 6)) console.log(' ', r.kind, r.key.padEnd(15), 'L' + r.lv, r.peak.toFixed(3));
const ordMax = Math.max(...ord.map((r) => r.peak));
const priMax = Math.max(...rows.filter((r) => r.kind === 'primal').map((r) => r.peak));
console.log('ordinary max', ordMax.toFixed(3), ' primal max', priMax.toFixed(3), ' ratio', (priMax / ordMax).toFixed(3));

console.log('\n--- pool radiance (glowIntensity x colour luminance) ---');
for (const r of rows.filter((r) => r.kind === 'primal')) {
  console.log('PRIMAL', r.key.padEnd(15), 'L' + r.lv, (r.gi * lumHex(r.col)).toFixed(4));
}
const ordPool = Math.max(...ord.map((r) => r.gi * lumHex(r.col)));
const priPool = Math.max(...rows.filter((r) => r.kind === 'primal').map((r) => r.gi * lumHex(r.col)));
console.log('ordinary max pool', ordPool.toFixed(4), ' primal max pool', priPool.toFixed(4), ' ratio', (priPool / ordPool).toFixed(3));
