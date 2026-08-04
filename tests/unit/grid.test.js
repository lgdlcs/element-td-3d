import { describe, it, expect } from 'vitest';
import { Grid } from '../../src/game/Grid.js';
import { GRID, CELL } from '../../src/core/Config.js';

/**
 * Grid — pure coordinate maths and 2x2 occupancy.
 *
 * FREEZE TEST. Every number below was read off the current build, not derived
 * from a spec: the point is to notice when a future change moves them, not to
 * argue that they are the right numbers.
 *
 * The board is 26x20 cells of 2.0 world units, centred on the world origin, so
 * cell (0,0) sits at world (-25,-19) and cell (25,19) at (+25,+19).
 */
describe('Grid — geometry', () => {
  it('is the configured 26x20 board of 2.0-unit cells', () => {
    const g = new Grid();
    expect([g.cols, g.rows, g.cell]).toEqual([26, 20, 2.0]);
    expect([GRID.cols, GRID.rows, GRID.cell]).toEqual([26, 20, 2.0]);
    expect(g.cells.length).toBe(520);
    expect(g.towerId.length).toBe(520);
    // Nothing is owned by a tower on a fresh board.
    expect([...g.towerId].every((v) => v === -1)).toBe(true);
  });

  it('places the spawn and goal on the centre columns of the short edges', () => {
    const g = new Grid();
    expect(g.spawn).toEqual({ c: 12, r: 0 });
    expect(g.goal).toEqual({ c: 12, r: 19 });
  });

  it('maps the four corner cells to known world positions', () => {
    const g = new Grid();
    expect(g.cellToWorld(0, 0)).toEqual({ x: -25, z: -19 });
    expect(g.cellToWorld(25, 0)).toEqual({ x: 25, z: -19 });
    expect(g.cellToWorld(0, 19)).toEqual({ x: -25, z: 19 });
    expect(g.cellToWorld(25, 19)).toEqual({ x: 25, z: 19 });
  });

  it('writes into the caller-supplied out object rather than allocating', () => {
    const g = new Grid();
    const out = { x: 999, z: 999 };
    const ret = g.cellToWorld(3, 4, out);
    expect(ret).toBe(out);
    expect(out).toEqual({ x: -19, z: -11 });
  });

  it('round-trips every cell of the board through world coordinates', () => {
    const g = new Grid();
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const w = g.cellToWorld(c, r);
        expect(g.worldToCell(w.x, w.z)).toEqual({ c, r });
      }
    }
  });

  it('resolves any point inside a cell to that cell, not just its centre', () => {
    const g = new Grid();
    const w = g.cellToWorld(7, 5);              // (-11, -9)
    // A cell spans [centre-1, centre+1). Probe just inside both edges.
    expect(g.worldToCell(w.x - 0.999, w.z - 0.999)).toEqual({ c: 7, r: 5 });
    expect(g.worldToCell(w.x + 0.999, w.z + 0.999)).toEqual({ c: 7, r: 5 });
    // One step further and we are in the neighbours.
    expect(g.worldToCell(w.x - 1.001, w.z)).toEqual({ c: 6, r: 5 });
    expect(g.worldToCell(w.x, w.z + 1.001)).toEqual({ c: 7, r: 6 });
  });

  it('round-trips every 2x2 anchor through its footprint centre', () => {
    const g = new Grid();
    for (let r = 0; r < g.rows - 1; r++) {
      for (let c = 0; c < g.cols - 1; c++) {
        const w = g.towerCentreToWorld(c, r);
        expect(g.worldToTowerAnchor(w.x, w.z)).toEqual({ c, r });
      }
    }
  });

  it('snaps a world point to the NEAREST anchor, half a cell either side', () => {
    const g = new Grid();
    // Anchor (12,9) is centred at world (0,0) — the middle of the board.
    expect(g.towerCentreToWorld(12, 9)).toEqual({ x: 0, z: 0 });
    expect(g.worldToTowerAnchor(0, 0)).toEqual({ c: 12, r: 9 });
    expect(g.worldToTowerAnchor(0.99, 0.99)).toEqual({ c: 12, r: 9 });
    expect(g.worldToTowerAnchor(-0.99, -0.99)).toEqual({ c: 12, r: 9 });
    // Past one full cell the anchor moves by one (Math.round, so the flip is at
    // exactly +/- one cell = 2.0 world units).
    expect(g.worldToTowerAnchor(2.01, 0)).toEqual({ c: 13, r: 9 });
    expect(g.worldToTowerAnchor(-2.01, 0)).toEqual({ c: 11, r: 9 });
    expect(g.worldToTowerAnchor(0, 2.01)).toEqual({ c: 12, r: 10 });
  });

  it('returns anchors outside the board for points off the board', () => {
    const g = new Grid();
    // OBSERVED BEHAVIOUR, not a guarantee: worldToTowerAnchor does no clamping.
    // Game.build() is what rejects these, via canPlaceTower -> get() -> BLOCKED.
    const a = g.worldToTowerAnchor(1000, 1000);
    expect(a).toEqual({ c: 512, r: 509 });
    expect(g.inBounds(a.c, a.r)).toBe(false);
    expect(g.canPlaceTower(a.c, a.r)).toBe(false);
  });
});

describe('Grid — bounds', () => {
  it('reports out-of-board coordinates as out of bounds', () => {
    const g = new Grid();
    expect(g.inBounds(0, 0)).toBe(true);
    expect(g.inBounds(25, 19)).toBe(true);
    expect(g.inBounds(-1, 0)).toBe(false);
    expect(g.inBounds(0, -1)).toBe(false);
    expect(g.inBounds(26, 0)).toBe(false);
    expect(g.inBounds(0, 20)).toBe(false);
  });

  it('reads out-of-board cells as BLOCKED, never FREE', () => {
    const g = new Grid();
    expect(g.get(-1, 0)).toBe(CELL.BLOCKED);
    expect(g.get(26, 19)).toBe(CELL.BLOCKED);
    expect(g.get(0, 20)).toBe(CELL.BLOCKED);
    expect(g.isWalkable(-1, 0)).toBe(false);
    expect(g.isBuildable(-1, 0)).toBe(false);
  });

  it('ignores writes outside the board instead of corrupting neighbours', () => {
    const g = new Grid();
    const before = [...g.cells];
    g.set(-1, 0, CELL.TOWER);
    g.set(26, 0, CELL.TOWER);
    g.set(0, 20, CELL.TOWER);
    expect([...g.cells]).toEqual(before);
  });

  it('reports no tower at a world position off the board', () => {
    const g = new Grid();
    expect(g.towerAtWorld(1e4, 1e4)).toBe(-1);
    expect(g.towerAtWorld(-1e4, -1e4)).toBe(-1);
  });
});

describe('Grid — cell states', () => {
  it('separates walkable from buildable', () => {
    const g = new Grid();
    g.set(5, 5, CELL.FREE);
    expect([g.isWalkable(5, 5), g.isBuildable(5, 5)]).toEqual([true, true]);
    g.set(5, 5, CELL.PATH_ONLY);
    expect([g.isWalkable(5, 5), g.isBuildable(5, 5)]).toEqual([true, false]);
    g.set(5, 5, CELL.TOWER);
    expect([g.isWalkable(5, 5), g.isBuildable(5, 5)]).toEqual([false, false]);
    g.set(5, 5, CELL.BLOCKED);
    expect([g.isWalkable(5, 5), g.isBuildable(5, 5)]).toEqual([false, false]);
  });
});

describe('Grid — protected corridors', () => {
  it('carves exactly eight PATH_ONLY cells, two wide and two deep at each end', () => {
    const g = new Grid();
    const carved = [];
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        if (g.cells[g.idx(c, r)] === CELL.PATH_ONLY) carved.push(`${c},${r}`);
      }
    }
    expect(carved).toEqual([
      '12,0', '13,0', '12,1', '13,1',
      '12,18', '13,18', '12,19', '13,19',
    ]);
  });

  it('makes corridor cells walkable but never buildable', () => {
    const g = new Grid();
    for (const [c, r] of [[12, 0], [13, 0], [12, 1], [13, 1], [12, 18], [13, 18], [12, 19], [13, 19]]) {
      expect(g.isWalkable(c, r)).toBe(true);
      expect(g.isBuildable(c, r)).toBe(false);
    }
  });

  it('refuses every 2x2 anchor that touches a corridor cell', () => {
    const g = new Grid();
    const corridor = new Set(['12,0', '13,0', '12,1', '13,1', '12,18', '13,18', '12,19', '13,19']);
    let refused = 0;
    for (let r = 0; r < g.rows - 1; r++) {
      for (let c = 0; c < g.cols - 1; c++) {
        const touches = [[c, r], [c + 1, r], [c, r + 1], [c + 1, r + 1]]
          .some(([cc, rr]) => corridor.has(`${cc},${rr}`));
        expect(g.canPlaceTower(c, r)).toBe(!touches);
        if (touches) refused++;
      }
    }
    // Three anchor columns (11,12,13) x two legal anchor rows per block, twice.
    expect(refused).toBe(12);
  });
});

describe('Grid — 2x2 tower footprint', () => {
  it('claims all four cells and both diagonals of the footprint', () => {
    const g = new Grid();
    expect(g.canPlaceTower(10, 8)).toBe(true);
    g.setTower(10, 8, 42);
    for (const [c, r] of [[10, 8], [11, 8], [10, 9], [11, 9]]) {
      expect(g.get(c, r)).toBe(CELL.TOWER);
      expect(g.towerId[g.idx(c, r)]).toBe(42);
    }
    // Cells just outside the footprint are untouched.
    for (const [c, r] of [[9, 8], [12, 8], [10, 7], [10, 10], [12, 10]]) {
      expect(g.get(c, r)).toBe(CELL.FREE);
      expect(g.towerId[g.idx(c, r)]).toBe(-1);
    }
  });

  it('refuses all nine anchors that overlap an existing tower', () => {
    const g = new Grid();
    g.setTower(10, 8, 42);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        expect(g.canPlaceTower(10 + dc, 8 + dr)).toBe(false);
      }
    }
    // ...and accepts the ring immediately outside it.
    expect(g.canPlaceTower(8, 8)).toBe(true);
    expect(g.canPlaceTower(12, 8)).toBe(true);
    expect(g.canPlaceTower(10, 6)).toBe(true);
    expect(g.canPlaceTower(10, 10)).toBe(true);
  });

  it('resolves any of the four cells of a footprint back to the tower id', () => {
    const g = new Grid();
    g.setTower(10, 8, 42);
    for (const [c, r] of [[10, 8], [11, 8], [10, 9], [11, 9]]) {
      const w = g.cellToWorld(c, r);
      expect(g.towerAtWorld(w.x, w.z)).toBe(42);
    }
    const centre = g.towerCentreToWorld(10, 8);
    expect(g.towerAtWorld(centre.x, centre.z)).toBe(42);
    expect(g.towerAtWorld(...Object.values(g.cellToWorld(9, 8)))).toBe(-1);
  });

  it('restores the footprint to FREE and unowned on clear', () => {
    const g = new Grid();
    g.setTower(10, 8, 42);
    g.clearTower(10, 8);
    for (const [c, r] of [[10, 8], [11, 8], [10, 9], [11, 9]]) {
      expect(g.get(c, r)).toBe(CELL.FREE);
      expect(g.towerId[g.idx(c, r)]).toBe(-1);
    }
    expect(g.canPlaceTower(10, 8)).toBe(true);
  });

  it('leaves the board byte-identical after a build/sell cycle', () => {
    const g = new Grid();
    const before = [...g.cells];
    g.setTower(4, 4, 1);
    g.clearTower(4, 4);
    expect([...g.cells]).toEqual(before);
  });

  it('lets two towers sit edge to edge without stealing each others cells', () => {
    const g = new Grid();
    g.setTower(4, 4, 1);
    expect(g.canPlaceTower(6, 4)).toBe(true);
    g.setTower(6, 4, 2);
    expect(g.towerId[g.idx(5, 4)]).toBe(1);
    expect(g.towerId[g.idx(6, 4)]).toBe(2);
    g.clearTower(4, 4);
    // Clearing the left one must not have freed the right one.
    expect(g.get(6, 4)).toBe(CELL.TOWER);
    expect(g.towerId[g.idx(6, 4)]).toBe(2);
  });

  /**
   * KNOWN LATENT BUG, frozen as observed behaviour (reported, not fixed).
   *
   * setTower/clearTower do NO bounds checking: they write idx(c+1, r) directly.
   * On the last column that index is r*cols + 26, which is idx(0, r+1) — the
   * write WRAPS onto column 0 of the next row instead of being discarded.
   *
   * It is unreachable through gameplay because canPlaceTower(25, r) is always
   * false (isBuildable(26, r) reads BLOCKED), and Game.build() checks it first.
   * The test below pins both halves: the guard holds, and the unguarded call
   * still corrupts.
   */
  it('is guarded against the last-column wrap only by canPlaceTower', () => {
    const g = new Grid();
    expect(g.canPlaceTower(25, 5)).toBe(false);   // the guard that saves us
    g.setTower(25, 5, 99);                        // bypassing it wraps:
    expect(g.get(0, 6)).toBe(CELL.TOWER);
    expect(g.towerId[g.idx(0, 6)]).toBe(99);
  });
});
