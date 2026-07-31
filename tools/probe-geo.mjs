#!/usr/bin/env node
/** Offline sanity + cost report for the procedural tower geometry. */
import { ALL_TOWERS } from '../src/game/TowerDefs.js';
import { buildTowerSpec } from '../src/game/towers/TowerArchetypes.js';

let totalV = 0;
const rows = [];
for (const def of Object.values(ALL_TOWERS)) {
  for (let lvl = 0; lvl < def.levels.length; lvl++) {
    const s = buildTowerSpec(def, lvl);
    let v = 0; let nan = [];
    const check = (g, name) => {
      if (!g) return;
      v += g.attributes.position.count;
      const a = g.attributes.position.array;
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) { nan.push(name); break; }
      for (const key of ['normal', 'color', 'aMat']) {
        const at = g.attributes[key];
        if (!at) { nan.push(`${name}:missing-${key}`); continue; }
        for (let i = 0; i < at.array.length; i++) if (!Number.isFinite(at.array[i])) { nan.push(`${name}.${key}`); break; }
      }
    };
    check(s.base, 'base'); check(s.head, 'head'); check(s.collar, 'collar'); check(s.halo, 'halo');
    s.shards.forEach((sh, i) => check(sh.geo, `shard${i}`));
    totalV += v;
    rows.push({ key: def.key, lvl, verts: v, tris: Math.round(v / 3), h: +s.height.toFixed(2), nan: nan.join(',') });
  }
}
rows.sort((a, b) => b.verts - a.verts);
console.log('worst 12 by vertex count:');
for (const r of rows.slice(0, 12)) console.log(` ${r.key}:${r.lvl}  v=${r.verts} tris=${r.tris} h=${r.h} ${r.nan ? 'NaN=' + r.nan : ''}`);
console.log('\nNaN offenders:');
for (const r of rows) if (r.nan) console.log(` ${r.key}:${r.lvl} -> ${r.nan}`);
console.log('\nheights:', [...new Set(rows.map((r) => `${r.key}:${r.lvl}=${r.h}`))].join(' '));
console.log(`\ntotal storage verts (all 21 towers x all levels) = ${totalV}`);
