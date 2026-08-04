import { describe, it, expect } from 'vitest';
import { Grid } from '../../src/game/Grid.js';
import { Pathfinder } from '../../src/systems/Pathfinder.js';
import { CELL } from '../../src/core/Config.js';

/**
 * Pathfinder — flow field, seal detection and seal preview.
 *
 * FREEZE TEST. The single most important behaviour here is `wouldBlock`: it is
 * the only thing standing between a player and an unwinnable board, and it is a
 * pure function of the grid, so it can be proved exactly rather than eyeballed.
 *
 * Board geometry it relies on: 26x20, spawn corridor at columns 12-13 of rows
 * 0-1, exit corridor at columns 12-13 of rows 18-19. Movement is 8-connected
 * and diagonals may not cut a tower corner, which is why a diagonal gap does
 * NOT count as a passage (asserted below).
 */

/** Lay a horizontal wall of 2x2 towers from column `c0` to `c1` inclusive. */
function wall(g, c0, c1, row) {
  for (let c = c0; c <= c1; c += 2) g.setTower(c, row, c + row * 100);
}

describe('Pathfinder — construction', () => {
  it('builds a field the size of the grid and bumps its version on rebuild', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    expect(p.n).toBe(520);
    expect(p.dist.length).toBe(520);
    expect(p.flowX.length).toBe(520);
    expect(p.flowZ.length).toBe(520);
    expect(p.version).toBe(1);          // the constructor's own rebuild
    p.rebuild();
    expect(p.version).toBe(2);
    p.rebuild();
    expect(p.version).toBe(3);
  });

  it('costs the goal cells zero and everything else more', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    expect(p.dist[g.idx(12, 19)]).toBe(0);
    expect(p.dist[g.idx(13, 19)]).toBe(0);
    expect(p.dist[g.idx(12, 18)]).toBeGreaterThan(0);
    expect(p.dist[g.idx(12, 0)]).toBeGreaterThan(p.dist[g.idx(12, 10)]);
  });

  it('pushes the flow off the board edge at the goal instead of stalling', () => {
    // The docblock in #buildFlow explains this: a creep that reached the exit
    // and stopped never crossed the leak plane, so it cost no life and never
    // despawned, and the whole wave piled up behind it.
    const g = new Grid();
    const p = new Pathfinder(g);
    for (const c of [12, 13]) {
      expect(p.flowX[g.idx(c, 19)]).toBe(0);
      expect(p.flowZ[g.idx(c, 19)]).toBe(1);     // +Z is "down" the board
    }
  });

  it('leaves the flow at zero inside a tower footprint', () => {
    const g = new Grid();
    g.setTower(10, 8, 1);
    const p = new Pathfinder(g);
    for (const [c, r] of [[10, 8], [11, 8], [10, 9], [11, 9]]) {
      expect(p.flowX[g.idx(c, r)]).toBe(0);
      expect(p.flowZ[g.idx(c, r)]).toBe(0);
    }
  });

  it('steers a creep on an empty board towards the exit', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    const out = { x: 0, z: 0 };
    // Standing at the spawn on an empty board, the cheapest way out is straight
    // down the middle.
    const w = g.cellToWorld(12, 2);
    p.sample(w.x, w.z, out);
    expect(out.z).toBeGreaterThan(0.5);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(1, 5);   // always normalised
  });

  it('falls back to +Z rather than a zero vector outside the board', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    const out = { x: 9, z: 9 };
    p.sample(1e4, 1e4, out);
    expect(out).toEqual({ x: 0, z: 1 });
  });

  it('reports Infinity as the remaining cost off the board', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    expect(p.costAt(1e4, 1e4)).toBe(Infinity);
    const near = g.cellToWorld(12, 18);
    const far = g.cellToWorld(12, 1);
    expect(p.costAt(far.x, far.z)).toBeGreaterThan(p.costAt(near.x, near.z));
  });

  it('penalises hugging a wall, so a corridor cell costs more than open ground', () => {
    // #cellCost adds 0.12 per non-walkable neighbour. Two boards, one tower's
    // difference, measured the same way.
    const open = new Pathfinder(new Grid());
    const g = new Grid();
    g.setTower(10, 8, 1);
    const walled = new Pathfinder(g);
    const w = g.cellToWorld(9, 8);
    expect(walled.costAt(w.x, w.z)).toBeGreaterThan(open.costAt(w.x, w.z));
  });
});

describe('Pathfinder — wouldBlock()', () => {
  it('accepts any legal wall on an empty board', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    expect(p.wouldBlock(2, 2)).toBe(false);
    expect(p.wouldBlock(12, 10)).toBe(false);     // dead centre of the lane
    expect(p.wouldBlock(0, 0)).toBe(false);
    expect(p.wouldBlock(24, 18)).toBe(false);
  });

  it('refuses the block that closes the last gap in a wall', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    wall(g, 0, 22, 10);                            // columns 0..23 of rows 10-11
    expect(p.wouldBlock(2, 14)).toBe(false);       // elsewhere: still fine
    expect(p.wouldBlock(24, 10)).toBe(true);       // the last gap: sealed
  });

  it('refuses a block that seals via the no-corner-cutting rule', () => {
    // With the wall at rows 10-11 columns 0..23, placing at (24,12) leaves the
    // gap at rows 10-11 open but strands it: the only way out of (24,11) would
    // be the diagonal to (23,12), and diagonals may not cut a tower corner.
    const g = new Grid();
    const p = new Pathfinder(g);
    wall(g, 0, 22, 10);
    expect(p.wouldBlock(24, 12)).toBe(true);
  });

  it('restores the grid exactly, whether it refused or accepted', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    wall(g, 0, 22, 10);
    const before = [...g.cells];
    expect(p.wouldBlock(24, 10)).toBe(true);
    expect([...g.cells]).toEqual(before);
    expect(p.wouldBlock(2, 2)).toBe(false);
    expect([...g.cells]).toEqual(before);
  });

  it('is not fooled by a one-cell-wide passage — that is still a passage', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    // Wall of 2x2 blocks leaving columns 24-25 open, then a second wall lower
    // down leaving columns 0-1 open. A long serpentine, but connected.
    wall(g, 0, 22, 6);
    wall(g, 2, 24, 12);
    expect(p.wouldBlock(4, 16)).toBe(false);
    // ...and closing the remaining gap on the lower wall does seal it.
    expect(p.wouldBlock(0, 12)).toBe(true);
  });

  it('reports the same verdict as an independent rebuild of the flow field', () => {
    // Instrument control: prove wouldBlock agrees with actually placing the
    // tower and re-running Dijkstra, on both a sealing and a non-sealing move.
    for (const [c, r, expected] of [[24, 10, true], [2, 14, false]]) {
      const g = new Grid();
      const p = new Pathfinder(g);
      wall(g, 0, 22, 10);
      expect(p.wouldBlock(c, r)).toBe(expected);
      g.setTower(c, r, 999);
      p.rebuild();
      const spawn = g.cellToWorld(12, 0);
      const sealed = p.costAt(spawn.x, spawn.z) === Infinity;
      expect(sealed).toBe(expected);
    }
  });
});

describe('Pathfinder — sealPreview()', () => {
  it('paints nothing when the placement is legal', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    const out = new Uint8Array(p.n);
    out.fill(1);                                   // dirty it first
    expect(p.sealPreview(12, 10, out)).toBe(0);
    expect(out.some((v) => v !== 0)).toBe(false);   // and it cleared the buffer
  });

  it('paints the ground that would be cut off, and returns how much', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    wall(g, 0, 22, 10);
    const out = new Uint8Array(p.n);
    const n = p.sealPreview(24, 10, out);
    expect(n).toBe(208);
    expect(out.reduce((s, v) => s + v, 0)).toBe(n);
    // Everything painted is below the wall and walkable.
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) continue;
      const c = i % g.cols;
      const r = (i - c) / g.cols;
      expect(r).toBeGreaterThan(11);
      expect(g.isWalkable(c, r)).toBe(true);
    }
    // The exit corridor is exactly the ground being stranded.
    expect(out[g.idx(12, 19)]).toBe(1);
    expect(out[g.idx(13, 18)]).toBe(1);
  });

  it('excludes the four cells of the wall itself', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    wall(g, 0, 22, 10);
    const out = new Uint8Array(p.n);
    p.sealPreview(24, 10, out);
    for (const [c, r] of [[24, 10], [25, 10], [24, 11], [25, 11]]) {
      expect(out[g.idx(c, r)]).toBe(0);
    }
  });

  it('never paints a cell already occupied by a tower', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    wall(g, 0, 22, 10);
    const out = new Uint8Array(p.n);
    p.sealPreview(24, 10, out);
    for (let i = 0; i < out.length; i++) {
      if (out[i]) expect(g.cells[i]).not.toBe(CELL.TOWER);
    }
  });

  it('restores the grid exactly', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    wall(g, 0, 22, 10);
    const before = [...g.cells];
    p.sealPreview(24, 10, new Uint8Array(p.n));
    expect([...g.cells]).toEqual(before);
  });

  it('agrees with wouldBlock: painted > 0 exactly when the move is refused', () => {
    const g = new Grid();
    const p = new Pathfinder(g);
    wall(g, 0, 22, 10);
    const out = new Uint8Array(p.n);
    for (const [c, r] of [[24, 10], [24, 12], [2, 14], [12, 14], [0, 2]]) {
      const blocked = p.wouldBlock(c, r);
      expect(p.sealPreview(c, r, out) > 0).toBe(blocked);
    }
  });
});
