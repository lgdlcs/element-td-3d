import { CELL } from '../core/Config.js';

/**
 * Flow-field pathfinder.
 *
 * We build an integration field with a Dijkstra sweep from the goal using
 * 8-connected movement (diagonals cost √2 and are forbidden when they would
 * cut a tower corner). Creeps then steer down the gradient, which gives
 * smooth, organic, shared-cost movement for hundreds of agents at ~zero cost
 * per agent — no per-creep A* re-planning when the maze changes.
 *
 * `version` bumps on every rebuild so agents can invalidate cached samples.
 */
const SQRT2 = Math.SQRT2;
const UNREACHABLE = Infinity;

const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

export class Pathfinder {
  constructor(grid) {
    this.grid = grid;
    this.n = grid.cols * grid.rows;
    this.dist = new Float32Array(this.n);
    this.flowX = new Float32Array(this.n);
    this.flowZ = new Float32Array(this.n);
    this.version = 0;
    this.rebuild();
  }

  /**
   * Cost of standing in a cell. A soft penalty next to towers keeps creeps
   * from hugging walls, which reads far better visually.
   */
  #cellCost(c, r) {
    let cost = 1;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        if (!this.grid.isWalkable(c + dc, r + dr)) { cost += 0.12; }
      }
    }
    return cost;
  }

  rebuild() {
    const g = this.grid;
    const { cols, rows } = g;
    const dist = this.dist;
    dist.fill(UNREACHABLE);

    // Bucketed priority queue (Dijkstra with small integer-ish costs).
    // A simple binary heap is plenty at this grid size.
    const heap = new MinHeap(this.n);

    for (let c = g.goal.c; c <= g.goal.c + 1; c++) {
      const i = g.idx(c, rows - 1);
      dist[i] = 0;
      heap.push(i, 0);
    }

    while (heap.size) {
      const i = heap.pop();
      const d = dist[i];
      const c = i % cols;
      const r = (i - c) / cols;

      for (let k = 0; k < 8; k++) {
        const [dc, dr, base] = NEIGHBOURS[k];
        const nc = c + dc, nr = r + dr;
        if (!g.isWalkable(nc, nr)) continue;
        // No corner-cutting through tower corners.
        if (dc && dr && (!g.isWalkable(c + dc, r) || !g.isWalkable(c, r + dr))) continue;

        const ni = nr * cols + nc;
        const nd = d + base * this.#cellCost(nc, nr);
        if (nd < dist[ni] - 1e-4) {
          dist[ni] = nd;
          heap.push(ni, nd);
        }
      }
    }

    this.#buildFlow();
    this.version++;
    return this;
  }

  #buildFlow() {
    const g = this.grid;
    const { cols, rows } = g;
    const dist = this.dist;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!g.isWalkable(c, r) || dist[i] === UNREACHABLE) {
          this.flowX[i] = 0; this.flowZ[i] = 0;
          continue;
        }
        // The goal cells are the fixed point of the Dijkstra sweep: their cost
        // is 0, so no neighbour can be strictly cheaper and steepest descent
        // below would leave the flow at exactly (0,0). A creep that reached the
        // exit then STOPPED there — it never crossed the leak plane, so it cost
        // no lives and never despawned, and every subsequent creep piled up
        // behind it. The field has to keep pushing off the board edge.
        if (dist[i] === 0) {
          this.flowX[i] = 0; this.flowZ[i] = 1;
          continue;
        }
        // Steepest descent over the 8 neighbours, weighted so the field is
        // continuous rather than snapping to 8 directions.
        let bx = 0, bz = 0, best = dist[i];
        for (let k = 0; k < 8; k++) {
          const [dc, dr] = NEIGHBOURS[k];
          const nc = c + dc, nr = r + dr;
          if (!g.isWalkable(nc, nr)) continue;
          if (dc && dr && (!g.isWalkable(c + dc, r) || !g.isWalkable(c, r + dr))) continue;
          const nd = dist[nr * cols + nc];
          if (nd < best) { best = nd; bx = dc; bz = dr; }
        }
        const len = Math.hypot(bx, bz) || 1;
        this.flowX[i] = bx / len;
        this.flowZ[i] = bz / len;
      }
    }
  }

  /** Bilinear-sampled flow direction at a world position. Writes into `out`. */
  sample(x, z, out) {
    const g = this.grid;
    const fx = x / g.cell + g.cols / 2 - 0.5;
    const fz = z / g.cell + g.rows / 2 - 0.5;
    const c0 = Math.floor(fx), r0 = Math.floor(fz);
    const tx = fx - c0, tz = fz - r0;

    let vx = 0, vz = 0, wsum = 0;
    for (let dr = 0; dr <= 1; dr++) {
      for (let dc = 0; dc <= 1; dc++) {
        const c = c0 + dc, r = r0 + dr;
        if (!g.inBounds(c, r) || !g.isWalkable(c, r)) continue;
        const w = (dc ? tx : 1 - tx) * (dr ? tz : 1 - tz);
        if (w <= 0) continue;
        const i = r * g.cols + c;
        vx += this.flowX[i] * w;
        vz += this.flowZ[i] * w;
        wsum += w;
      }
    }
    if (wsum > 1e-5) { vx /= wsum; vz /= wsum; }
    const len = Math.hypot(vx, vz);
    if (len > 1e-5) { out.x = vx / len; out.z = vz / len; }
    else { out.x = 0; out.z = 1; }
    return out;
  }

  /** Remaining path cost from a world position — used for target priority. */
  costAt(x, z) {
    const { c, r } = this.grid.worldToCell(x, z);
    if (!this.grid.inBounds(c, r)) return UNREACHABLE;
    return this.dist[this.grid.idx(c, r)];
  }

  /** Would placing a 2x2 tower at (c,r) fully seal the maze? */
  wouldBlock(c, r) {
    const g = this.grid;
    const saved = this.#occupy(c, r);
    const reachable = this.#reachesGoal(this.#flood());
    for (const [i, v] of saved) g.cells[i] = v;
    return !reachable;
  }

  /**
   * The evidence behind a "that would seal the maze" refusal: every cell that
   * would lose its connection to the spawn if a 2x2 tower were placed at (c,r),
   * written into `out` as 1/0. Returns how many.
   *
   * A red square tells the player "no". This tells them WHY — the ground about
   * to be cut off lights up, so the wall they are one block away from closing is
   * visible instead of having to be inferred from a failed click.
   *
   * The footprint itself is excluded: those four cells are the wall, not a
   * victim of it, and painting them as cut-off ground would read as if the
   * tower were the thing being stranded.
   */
  sealPreview(c, r, out) {
    const g = this.grid;
    out.fill(0);
    const saved = this.#occupy(c, r);
    const seen = this.#flood();
    for (const [i, v] of saved) g.cells[i] = v;

    let n = 0;
    for (let i = 0; i < this.n; i++) {
      if (seen[i]) continue;
      const cc = i % g.cols;
      const rr = (i - cc) / g.cols;
      if (!g.isWalkable(cc, rr)) continue;
      if (cc >= c && cc < c + 2 && rr >= r && rr < r + 2) continue;
      out[i] = 1; n++;
    }
    return n;
  }

  /** Stamp a 2x2 footprint as TOWER, returning the cells to restore. */
  #occupy(c, r) {
    const g = this.grid;
    const saved = [];
    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
      const i = g.idx(c + dc, r + dr);
      saved.push([i, g.cells[i]]);
      g.cells[i] = CELL.TOWER;
    }
    return saved;
  }

  /**
   * Cheap BFS from the spawn over the CURRENT grid, returning the full seen set.
   *
   * This used to early-exit the moment it touched the last row, which was the
   * right shape for `wouldBlock` alone but cannot serve `sealPreview` — that
   * needs the complete reachable set, and a flood that stops early reports
   * perfectly connected ground as cut off. One full flood over 520 cells is
   * cheaper than the pointermove that triggered it, so there is nothing to
   * reclaim by keeping two versions.
   */
  #flood() {
    const g = this.grid;
    const seen = new Uint8Array(this.n);
    const queue = new Int32Array(this.n);
    let head = 0, tail = 0;
    const start = g.idx(g.spawn.c, 0);
    queue[tail++] = start; seen[start] = 1;

    while (head < tail) {
      const i = queue[head++];
      const c = i % g.cols;
      const r = (i - c) / g.cols;
      for (let k = 0; k < 8; k++) {
        const [dc, dr] = NEIGHBOURS[k];
        const nc = c + dc, nr = r + dr;
        if (!g.isWalkable(nc, nr)) continue;
        if (dc && dr && (!g.isWalkable(c + dc, r) || !g.isWalkable(c, r + dr))) continue;
        const ni = nr * g.cols + nc;
        if (seen[ni]) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
    }
    return seen;
  }

  /** Did the flood touch the exit edge? Matches the old early-exit test. */
  #reachesGoal(seen) {
    const g = this.grid;
    const last = (g.rows - 1) * g.cols;
    for (let c = 0; c < g.cols; c++) if (seen[last + c]) return true;
    return false;
  }
}

/** Minimal binary min-heap over integer ids with float keys. */
class MinHeap {
  constructor(cap) {
    this.ids = new Int32Array(cap * 4);
    this.keys = new Float32Array(cap * 4);
    this.size = 0;
  }
  push(id, key) {
    if (this.size >= this.ids.length) this.#grow();
    let i = this.size++;
    this.ids[i] = id; this.keys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.#swap(p, i); i = p;
    }
  }
  pop() {
    const top = this.ids[0];
    this.size--;
    if (this.size > 0) {
      this.ids[0] = this.ids[this.size];
      this.keys[0] = this.keys[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.#swap(m, i); i = m;
      }
    }
    return top;
  }
  #swap(a, b) {
    const ti = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = ti;
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
  }
  #grow() {
    const ids = new Int32Array(this.ids.length * 2);
    const keys = new Float32Array(this.keys.length * 2);
    ids.set(this.ids); keys.set(this.keys);
    this.ids = ids; this.keys = keys;
  }
}
