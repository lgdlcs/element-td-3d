import { describe, it, expect } from 'vitest';
import { Grid } from '../../src/game/Grid.js';
import { GRID, CELL } from '../../src/core/Config.js';

/**
 * Smoke test for the unit harness itself.
 *
 * Grid is the right subject: it is the only gameplay module that is pure maths
 * with no Three.js import, so it proves the runner can load real src/ code
 * without a DOM or a GL context. If this file fails, the harness is broken --
 * not the game.
 */
describe('Grid (unit harness smoke)', () => {
  it('builds a board of the configured size', () => {
    const g = new Grid();
    expect(g.cols).toBe(GRID.cols);
    expect(g.rows).toBe(GRID.rows);
    expect(g.cells.length).toBe(GRID.cols * GRID.rows);
  });

  it('carves protected spawn and exit corridors', () => {
    const g = new Grid();
    // Two-wide, two-deep at each end: creeps walk them, nobody builds there.
    expect(g.get(g.spawn.c, 0)).toBe(CELL.PATH_ONLY);
    expect(g.get(g.spawn.c + 1, 1)).toBe(CELL.PATH_ONLY);
    expect(g.get(g.goal.c, g.rows - 1)).toBe(CELL.PATH_ONLY);
    expect(g.isBuildable(g.spawn.c, 0)).toBe(false);
    expect(g.isWalkable(g.spawn.c, 0)).toBe(true);
  });

  it('round-trips a cell through world coordinates', () => {
    const g = new Grid();
    const w = g.cellToWorld(7, 5);
    const back = g.worldToCell(w.x, w.z);
    expect(back).toEqual({ c: 7, r: 5 });
  });

  it('snaps the centre of a 2x2 footprint back to its anchor', () => {
    const g = new Grid();
    const centre = g.towerCentreToWorld(10, 8);
    expect(g.worldToTowerAnchor(centre.x, centre.z)).toEqual({ c: 10, r: 8 });
  });

  it('refuses a 2x2 footprint that overlaps an existing tower', () => {
    const g = new Grid();
    expect(g.canPlaceTower(10, 8)).toBe(true);
    g.setTower(10, 8, 42);
    expect(g.canPlaceTower(10, 8)).toBe(false);
    expect(g.canPlaceTower(9, 7)).toBe(false);   // overlaps by one cell
    const centre = g.towerCentreToWorld(10, 8);
    expect(g.towerAtWorld(centre.x, centre.z)).toBe(42);
    g.clearTower(10, 8);
    expect(g.canPlaceTower(10, 8)).toBe(true);
  });
});
