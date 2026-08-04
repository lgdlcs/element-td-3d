import * as THREE from 'three';
import { ELEMENTS, ELEMENT_IDS } from '/Users/pouetpouets/code/element-td-3d/src/game/Elements.js';
import { buildTowerSpec } from '/Users/pouetpouets/code/element-td-3d/src/game/towers/TowerArchetypes.js';
import { PRIMAL_TOWERS, PURE_TOWERS } from '/Users/pouetpouets/code/element-td-3d/src/game/TowerDefs.js';

const lum = (hex) => {
  const c = new THREE.Color().setHex(hex).convertSRGBToLinear();
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

console.log('--- element albedo luminance (double-convert path) + radiance ---');
for (const el of ELEMENT_IDS) {
  const L = lum(ELEMENTS[el].color);
  console.log(el.padEnd(7), 'lum', L.toFixed(4), 'emis', ELEMENTS[el].emissive, 'radiance', (L * ELEMENTS[el].emissive).toFixed(4));
}

console.log('\n--- PAL.nature dapple ---');
const stone = 0x2e7a2c, stone2 = 0x66bc44, trim = 0x4f874d, oldTrim = 0x7bb45e, oldOldTrim = 0xaadd3a;
for (const [n, h] of [['stone', stone], ['stone2', stone2], ['trim', trim], ['oldTrim(0x7bb45e)', oldTrim], ['round6(0xaadd3a)', oldOldTrim]]) {
  console.log(n.padEnd(20), '0x' + h.toString(16), 'lum', lum(h).toFixed(4));
}
console.log('trim/stone ratio', (lum(trim) / lum(stone)).toFixed(3));
console.log('oldTrim/stone ratio', (lum(oldTrim) / lum(stone)).toFixed(3));
console.log('stone2/trim ratio', (lum(stone2) / lum(trim)).toFixed(3));

console.log('\n--- crown radii (max XZ of spec.head) ---');
function headRadius(spec) {
  let max = 0;
  const a = spec.head.attributes.position.array;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.hypot(a[i], a[i + 2]);
    if (d > max) max = d;
  }
  return max;
}
for (const def of Object.values(PRIMAL_TOWERS)) {
  const row = [];
  for (let lv = 0; lv < def.levels.length; lv++) row.push(headRadius(buildTowerSpec(def, lv)).toFixed(2));
  console.log(def.key.padEnd(16), def.name?.padEnd(12) ?? '', row.join(' / '));
}

console.log('\n--- glowIntensity / glowRadius ---');
for (const def of Object.values(PRIMAL_TOWERS)) {
  const row = [];
  for (let lv = 0; lv < def.levels.length; lv++) {
    const s = buildTowerSpec(def, lv);
    row.push(`${s.glowIntensity.toFixed(3)}@${s.glowRadius.toFixed(2)}`);
  }
  console.log(def.key.padEnd(16), row.join('  '));
}
console.log('pure L2:');
for (const def of Object.values(PURE_TOWERS)) {
  const s = buildTowerSpec(def, def.levels.length - 1);
  console.log(' ', def.key.padEnd(16), s.glowIntensity.toFixed(3), '@', s.glowRadius.toFixed(2));
}

console.log('\n--- CROWNK mass maths ---');
const CROWNK = { fire: 1.05, water: 1.00, nature: 1.00, earth: 1.20, light: 0.78, dark: 1.12 };
const PRIMAL_MASS = [1.98, 2.20, 2.44];
const PRIMAL_CROWNK = [0.55, 0.42, 0.32];
for (const el of ELEMENT_IDS) {
  const row = [];
  for (let s = 0; s < 3; s++) {
    const k = 1 + (CROWNK[el] - 1) * PRIMAL_CROWNK[s];
    row.push((PRIMAL_MASS[s] * k).toFixed(3));
  }
  console.log(el.padEnd(7), 'damped crown mass', row.join(' / '), ' undamped L2', (PRIMAL_MASS[2] * CROWNK[el]).toFixed(3));
}
