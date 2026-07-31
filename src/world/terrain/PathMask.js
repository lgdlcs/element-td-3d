import * as THREE from 'three';
import { CELL } from '../../core/Config.js';
import { fbm } from '../../assets/ProceduralTextures.js';

/**
 * Terrain zone mask, derived from the live grid topology.
 *
 * This is what makes gate G8 pass: the road exists in the material because the
 * creeps actually walk there, and it re-cuts itself the moment a tower changes
 * the maze. No dependency on Pathfinder.js — we run our own Dijkstra corridor
 * solve, which is a few hundred microseconds on a 26x20 board.
 *
 * Channels written into the RGBA data texture (sampled 1x across the arena):
 *
 *   R  road wear      1 = the trodden centre line, falling off across the
 *                     near-optimal corridor and to 0 in dead water
 *   G  edge decay     1 = crumbling arena rim
 *   B  build grime    1 = hard up against a tower footprint / blocked cell
 *   A  dampness       broad low-lying field, biased into the ruts
 */
export class PathMask {
  constructor(grid, sub = 4) {
    this.grid = grid;
    this.sub = sub;
    this.w = grid.cols * sub;
    this.h = grid.rows * sub;

    const n = grid.cols * grid.rows;
    this.wear = new Float32Array(n);
    this.grime = new Float32Array(n);
    this.decay = new Float32Array(n);
    this.damp = new Float32Array(n);
    this.scuff = new Float32Array(n);

    this._dS = new Float32Array(n);
    this._dG = new Float32Array(n);
    this._dP = new Float32Array(n);

    this.data = new Uint8Array(this.w * this.h * 4);
    this.texture = new THREE.DataTexture(this.data, this.w, this.h, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;

    this.#computeStatic();
    this.rebuild();
    this._sum = this.#checksum();
  }

  /**
   * ROUND 4 — THE MASK WAS NEVER REBUILT AFTER BOOT.
   *
   * `Arena.markPathDirty()` exists, `Arena.update()` honours it, and a grep of
   * the entire source tree finds **zero callers**. Nothing in the game ever
   * told the terrain that the maze had changed. So every zone mask shipped for
   * three rounds was the one computed in the Arena constructor — before a
   * single tower existed — i.e. a straight line down the middle of an empty
   * board. Once a player built a maze, the painted road and the route the
   * creeps actually walked had nothing to do with each other.
   *
   * That is why G8 could not be fixed by art: the road was in the wrong place.
   * This is the same class as every entry in PITFALLS.md — implemented,
   * reviewed, tuned, and never once executed.
   *
   * Rather than rely on an external caller that has never existed, the mask now
   * watches the grid itself. 520 bytes of FNV-1a per call is free next to a
   * Dijkstra solve, and it cannot be forgotten by a subsystem that does not
   * know terrain exists.
   */
  #checksum() {
    const c = this.grid.cells;
    let h = 2166136261;
    for (let i = 0; i < c.length; i++) { h ^= c[i]; h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /** Rebuild only if the grid topology actually changed. Returns true if so. */
  maybeRebuild() {
    const h = this.#checksum();
    if (h === this._sum) return false;
    this._sum = h;
    this.rebuild();
    return true;
  }

  /** Rim decay + the broad dampness field never change; do them once. */
  #computeStatic() {
    const g = this.grid;
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const i = r * g.cols + c;
        const dEdge = Math.min(c, r, g.cols - 1 - c, g.rows - 1 - r);
        // ragged rim: perturb the falloff with noise so it is not a neat frame
        const n = fbm(c * 0.28, r * 0.28, { period: 16, octaves: 3, seed: 313 });
        const d = dEdge + (n - 0.5) * 1.8;
        this.decay[i] = 1 - smooth01(d / 2.1);
        this.damp[i] = fbm(c * 0.16 + 3.3, r * 0.16 - 1.9, { period: 12, octaves: 4, seed: 77 });
      }
    }
  }

  /**
   * Dijkstra over walkable cells from a set of source indices (8-connected,
   * no corner cutting). Relaxation sweep with a flat Int32 ring queue — a real
   * heap is not worth it on 520 cells.
   */
  #field(out, sourceIdx) {
    const g = this.grid, cols = g.cols, rows = g.rows;
    const cells = g.cells;
    const walk = (i) => cells[i] === 0 || cells[i] === 3;
    out.fill(Infinity);

    const q = this._queue ?? (this._queue = new Int32Array(cols * rows * 24));
    let head = 0, tail = 0;
    for (let k = 0; k < sourceIdx.length; k++) {
      const i = sourceIdx[k];
      if (!walk(i)) continue;
      out[i] = 0;
      q[tail++] = i;
    }
    const DC = this._DC ?? (this._DC = Int8Array.from([1, -1, 0, 0, 1, 1, -1, -1]));
    const DR = this._DR ?? (this._DR = Int8Array.from([0, 0, 1, -1, 1, -1, 1, -1]));
    const DW = this._DW ?? (this._DW = Float32Array.from([1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142]));
    const QMAX = q.length;

    while (head < tail) {
      const i = q[head++];
      const c = i % cols, r = (i / cols) | 0;
      const d0 = out[i];
      for (let k = 0; k < 8; k++) {
        const nc = c + DC[k], nr = r + DR[k];
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (!walk(ni)) continue;
        if (k >= 4 && (!walk(r * cols + nc) || !walk(nr * cols + c))) continue;
        const nd = d0 + DW[k];
        if (nd < out[ni] - 1e-4) {
          out[ni] = nd;
          if (tail < QMAX) q[tail++] = ni;
        }
      }
      if (head > cols * rows * 8) { // compact the ring
        q.copyWithin(0, head, tail); tail -= head; head = 0;
      }
    }
  }

  /** Greedy descent along dG from the spawn: the line creeps actually walk. */
  #tracePath(startIdx) {
    const g = this.grid, cols = g.cols, rows = g.rows;
    const dG = this._dG;
    const out = [];
    let i = startIdx[0];
    for (const s of startIdx) if (dG[s] < dG[i]) i = s;
    const seen = new Set();
    for (let step = 0; step < cols * rows; step++) {
      if (seen.has(i)) break;
      seen.add(i);
      out.push(i);
      if (dG[i] === 0) break;
      const c = i % cols, r = (i / cols) | 0;
      let bi = -1, bd = dG[i];
      for (let k = 0; k < 8; k++) {
        const nc = c + this._DC[k], nr = r + this._DR[k];
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (dG[ni] < bd - 1e-6) { bd = dG[ni]; bi = ni; }
      }
      if (bi < 0) break;
      i = bi;
    }
    return out;
  }

  /** Recompute the wear + grime fields and re-upload the texture. */
  rebuild() {
    const g = this.grid, cols = g.cols, rows = g.rows;

    const srcS = [];
    for (let c = g.spawn.c; c <= g.spawn.c + 1; c++) srcS.push(0 * cols + c);
    const srcG = [];
    for (let c = g.goal.c; c <= g.goal.c + 1; c++) srcG.push((rows - 1) * cols + c);

    this.#field(this._dS, srcS);
    this.#field(this._dG, srcG);

    // Shortest full traversal length.
    let best = Infinity;
    for (const i of srcG) best = Math.min(best, this._dS[i]);

    // The lane creeps genuinely follow, plus a faint halo of alternate routes.
    const trace = this.#tracePath(srcS);
    this.#field(this._dP, trace);

    const CORRIDOR = 3.2;   // detour tolerance for the faint secondary traffic
    const LANE = 2.55;       // half-width of the trodden lane, in cells
    for (let i = 0; i < cols * rows; i++) {
      const total = this._dS[i] + this._dG[i];
      let alt = 0;
      if (isFinite(total) && isFinite(best)) {
        alt = 1 - smooth01((total - best) / CORRIDOR);
        alt = alt * alt;
      }
      const dp = this._dP[i];
      let lane = isFinite(dp) ? 1 - smooth01(dp / LANE) : 0;
      lane = lane * lane * (3 - 2 * lane);
      this.wear[i] = lane;
      this.scuff[i] = alt;
    }

    // ROUND 4 — smooth the wear field before it drives GEOMETRY.
    //
    // Dijkstra distance on an 8-connected lattice is octagonal, and the kerb
    // band is now only 0.08 wide on a field that used to feed a soft shader
    // gradient and now feeds a 1.0-unit vertical wall. The result, visible in
    // the first terrace capture, was a hard sawtooth zigzag along every lane
    // edge — a textbook G9 fail. Two binomial passes at cell resolution cost
    // ~4k float ops and turn the octagon into a curve.
    const blur = this._blurTmp ?? (this._blurTmp = new Float32Array(cols * rows));
    // ONE pass, not two. The sawtooth this was written for turned out to be
    // the shadow map (now replaced by an analytic drop shadow), and each
    // binomial pass widens the kerb band by roughly a cell — i.e. turns the
    // retaining wall back into the grassy bank it was supposed to stop being.
    // One pass is enough to round the Dijkstra octagon.
    for (let pass = 0; pass < 1; pass++) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let s = 0, wsum = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const nc = c + dc, nr = r + dr;
              if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
              const w = (dc === 0 ? 2 : 1) * (dr === 0 ? 2 : 1);
              s += this.wear[nr * cols + nc] * w; wsum += w;
            }
          }
          blur[r * cols + c] = s / wsum;
        }
      }
      this.wear.set(blur);
    }

    // Grime: proximity to a tower / blocked cell, so the road tucks in against
    // the bases instead of running under them.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let near = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const v = g.get(c + dc, r + dr);
            if (v === CELL.TOWER || v === CELL.BLOCKED) {
              near = Math.max(near, dc === 0 || dr === 0 ? 1.0 : 0.7);
            }
          }
        }
        // B channel = light surface soiling only. It must never gate the road:
        // the lane runs *between* towers, so multiplying it out erases the road.
        this.grime[i] = Math.max(near * 0.75, this.scuff[i] * 0.55);
      }
    }

    this.#upload();
    return this;
  }

  #upload() {
    const g = this.grid, cols = g.cols, rows = g.rows;
    const sub = this.sub, W = this.w, H = this.h;
    const d = this.data;

    const bil = (field, fx, fy) => {
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      // Smoothstep the interpolant, not the value: plain bilinear off a cell
      // lattice is only C0, and its diamond-shaped facets are exactly what the
      // narrow kerb band turns into visible geometry.
      let tx = fx - x0, ty = fy - y0;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const cx = (a) => (a < 0 ? 0 : a > cols - 1 ? cols - 1 : a);
      const cy = (a) => (a < 0 ? 0 : a > rows - 1 ? rows - 1 : a);
      const a0 = field[cy(y0) * cols + cx(x0)];
      const a1 = field[cy(y0) * cols + cx(x0 + 1)];
      const b0 = field[cy(y0 + 1) * cols + cx(x0)];
      const b1 = field[cy(y0 + 1) * cols + cx(x0 + 1)];
      return (a0 * (1 - tx) + a1 * tx) * (1 - ty) + (b0 * (1 - tx) + b1 * tx) * ty;
    };

    for (let y = 0; y < H; y++) {
      const fy = (y + 0.5) / sub - 0.5;
      for (let x = 0; x < W; x++) {
        const fx = (x + 0.5) / sub - 0.5;
        const i = (y * W + x) * 4;
        const wear = bil(this.wear, fx, fy);
        const grime = bil(this.grime, fx, fy);
        const decay = bil(this.decay, fx, fy);
        const damp = bil(this.damp, fx, fy);
        d[i] = Math.max(0, Math.min(255, wear * 255));
        d[i + 1] = Math.max(0, Math.min(255, decay * 255));
        d[i + 2] = Math.max(0, Math.min(255, grime * 255));
        d[i + 3] = Math.max(0, Math.min(255, damp * 255));
      }
    }
    this.texture.needsUpdate = true;
  }
}

function smooth01(t) {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
