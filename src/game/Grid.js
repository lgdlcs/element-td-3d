import { GRID, CELL } from '../core/Config.js';

/**
 * The build grid. Pure data + coordinate maths, no Three.js.
 * World origin is the centre of the arena; +X is right, +Z is "down" the board.
 */
export class Grid {
  constructor(cols = GRID.cols, rows = GRID.rows, cell = GRID.cell) {
    this.cols = cols;
    this.rows = rows;
    this.cell = cell;
    this.cells = new Uint8Array(cols * rows);
    this.towerId = new Int32Array(cols * rows).fill(-1);

    // Entrance (top edge) and exit (bottom edge), 2 cells wide each.
    this.spawn = { c: Math.floor(cols * 0.5) - 1, r: 0 };
    this.goal = { c: Math.floor(cols * 0.5) - 1, r: rows - 1 };

    this.#carveCorridors();
  }

  #carveCorridors() {
    // Two-wide protected corridors so players can never seal the entry/exit.
    for (let c = this.spawn.c; c <= this.spawn.c + 1; c++) {
      this.set(c, 0, CELL.PATH_ONLY);
      this.set(c, 1, CELL.PATH_ONLY);
    }
    for (let c = this.goal.c; c <= this.goal.c + 1; c++) {
      this.set(c, this.rows - 1, CELL.PATH_ONLY);
      this.set(c, this.rows - 2, CELL.PATH_ONLY);
    }
  }

  idx(c, r) { return r * this.cols + c; }
  inBounds(c, r) { return c >= 0 && r >= 0 && c < this.cols && r < this.rows; }
  get(c, r) { return this.inBounds(c, r) ? this.cells[this.idx(c, r)] : CELL.BLOCKED; }
  set(c, r, v) { if (this.inBounds(c, r)) this.cells[this.idx(c, r)] = v; }

  isWalkable(c, r) {
    const v = this.get(c, r);
    return v === CELL.FREE || v === CELL.PATH_ONLY;
  }

  isBuildable(c, r) { return this.get(c, r) === CELL.FREE; }

  /** Towers are 2x2. Anchor is the top-left cell. */
  canPlaceTower(c, r) {
    return this.isBuildable(c, r) && this.isBuildable(c + 1, r)
        && this.isBuildable(c, r + 1) && this.isBuildable(c + 1, r + 1);
  }

  setTower(c, r, id) {
    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
      const i = this.idx(c + dc, r + dr);
      this.cells[i] = CELL.TOWER;
      this.towerId[i] = id;
    }
  }

  clearTower(c, r) {
    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
      const i = this.idx(c + dc, r + dr);
      this.cells[i] = CELL.FREE;
      this.towerId[i] = -1;
    }
  }

  towerAtWorld(x, z) {
    const { c, r } = this.worldToCell(x, z);
    if (!this.inBounds(c, r)) return -1;
    return this.towerId[this.idx(c, r)];
  }

  // ---- coordinate conversion -------------------------------------------
  cellToWorld(c, r, out = { x: 0, z: 0 }) {
    out.x = (c - this.cols / 2 + 0.5) * this.cell;
    out.z = (r - this.rows / 2 + 0.5) * this.cell;
    return out;
  }

  /** Centre of a 2x2 tower footprint anchored at (c,r). */
  towerCentreToWorld(c, r, out = { x: 0, z: 0 }) {
    out.x = (c - this.cols / 2 + 1.0) * this.cell;
    out.z = (r - this.rows / 2 + 1.0) * this.cell;
    return out;
  }

  worldToCell(x, z, out = { c: 0, r: 0 }) {
    out.c = Math.floor(x / this.cell + this.cols / 2);
    out.r = Math.floor(z / this.cell + this.rows / 2);
    return out;
  }

  /** Snap a world position to the nearest legal 2x2 tower anchor. */
  worldToTowerAnchor(x, z, out = { c: 0, r: 0 }) {
    // Anchor grid is offset by half a cell because footprints are even-sized.
    out.c = Math.round(x / this.cell + this.cols / 2 - 1.0);
    out.r = Math.round(z / this.cell + this.rows / 2 - 1.0);
    return out;
  }
}
