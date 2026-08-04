import { describe, it, expect } from 'vitest';
import { Leaderboard, TOP_N } from '../../server/leaderboard.js';

/**
 * The global board, server side.
 *
 * `server/` had no automated coverage of any kind — every defect in it so far
 * was found by hand (docs/STATUS.md records a run of them). This file takes the
 * half that needs neither a socket nor a browser: Leaderboard is pure Node, its
 * whole contract is sorting and sanitising, and its own docblock is explicit
 * that "sanitising is about keeping the data well-formed and the file small, NOT
 * about trust". That makes every rule below a claim worth pinning, because the
 * only thing standing between a hostile client and every player's lobby panel is
 * this class plus Lobby's own clamping.
 *
 * `file: null` throughout: in-memory mode is a documented constructor option, so
 * none of this touches the disk or the debounce timer.
 */

const fresh = () => new Leaderboard({ file: null });

describe('Leaderboard — sanitising', () => {
  it('rejects a run with no usable name', () => {
    const lb = fresh();
    for (const bad of [undefined, null, {}, { score: 100 }, { name: '', score: 100 },
      { name: '   ', score: 100 }, { name: 42, score: 100 }]) {
      expect(lb.submit(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(lb.top()).toEqual([]);
  });

  it('rejects a run with no usable score', () => {
    const lb = fresh();
    for (const bad of [{ name: 'Ember' }, { name: 'Ember', score: 0 },
      { name: 'Ember', score: -5 }, { name: 'Ember', score: NaN },
      { name: 'Ember', score: 'lots' }, { name: 'Ember', score: Infinity }]) {
      expect(lb.submit(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(lb.top()).toEqual([]);
  });

  it('REFUSES an absurd score rather than clamping it onto the board', () => {
    // MAX_SCORE is 100 000 000 and the rule is rejection, not saturation — which
    // is the stronger of the two: clamping a forged 9e15 to the cap would still
    // put the forger at the top and would still need an honest run to beat the
    // cap to displace them. The boundary is asserted from both sides so nobody
    // "simplifies" this into a Math.min.
    const lb = fresh();
    expect(lb.submit({ name: 'Forger', score: 9e15, wave: 50, won: true })).toBe(false);
    expect(lb.submit({ name: 'Forger', score: 100_000_001, wave: 50, won: true })).toBe(false);
    expect(lb.top()).toEqual([]);
    expect(lb.submit({ name: 'Honest', score: 100_000_000, wave: 50, won: true })).toBe(true);
    expect(lb.top()[0].score).toBe(100_000_000);
  });

  it('coerces the fields it keeps to the shapes the client will render', () => {
    const lb = fresh();
    lb.submit({ name: '  Tide  ', score: '1234.7', wave: '18.9', won: 'yes' });
    const [e] = lb.top();
    expect(e.name).toBe('Tide');
    expect(Number.isInteger(e.score)).toBe(true);
    expect(Number.isInteger(e.wave)).toBe(true);
    expect(typeof e.won).toBe('boolean');
    expect(e.score).toBeGreaterThan(0);
  });

  it('never returns a negative score or a negative wave', () => {
    // Lobby.js clamps these again on the way in, and this is the other end of
    // the same rule: the hall rendered "Mireward -5" once.
    const lb = fresh();
    lb.submit({ name: 'Mireward', score: 100, wave: -9, won: false });
    for (const e of lb.top()) {
      expect(e.score).toBeGreaterThanOrEqual(0);
      expect(e.wave).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Leaderboard — the board itself', () => {
  it('sorts by score, highest first', () => {
    const lb = fresh();
    for (const [name, score] of [['A', 10], ['B', 900], ['C', 300]]) {
      lb.submit({ name, score, wave: 5, won: false });
    }
    expect(lb.top().map((e) => e.name)).toEqual(['B', 'C', 'A']);
  });

  it('breaks a score tie by wave, then by who got there first', () => {
    const lb = fresh();
    lb.submit({ name: 'First', score: 500, wave: 20, won: false });
    lb.submit({ name: 'Deeper', score: 500, wave: 31, won: false });
    lb.submit({ name: 'Later', score: 500, wave: 20, won: false });
    expect(lb.top().map((e) => e.name)).toEqual(['Deeper', 'First', 'Later']);
  });

  it('keeps ONE entry per name, and only the better run', () => {
    const lb = fresh();
    expect(lb.submit({ name: 'Ember', score: 100, wave: 4, won: false })).toBe(true);
    expect(lb.submit({ name: 'Ember', score: 900, wave: 22, won: false })).toBe(true);
    // A worse run from the same player changes nothing at all.
    expect(lb.submit({ name: 'Ember', score: 50, wave: 2, won: false })).toBe(false);
    // ...and a TIE is not an improvement either, so the recorded wave survives.
    expect(lb.submit({ name: 'Ember', score: 900, wave: 1, won: false })).toBe(false);
    expect(lb.top()).toHaveLength(1);
    expect(lb.top()[0]).toMatchObject({ score: 900, wave: 22 });
  });

  it('matches names case-insensitively, so one player cannot farm slots', () => {
    const lb = fresh();
    lb.submit({ name: 'Ember', score: 100, wave: 4, won: false });
    lb.submit({ name: 'EMBER', score: 200, wave: 8, won: false });
    lb.submit({ name: 'eMbEr', score: 300, wave: 9, won: false });
    expect(lb.top()).toHaveLength(1);
    expect(lb.top()[0].score).toBe(300);
  });

  it(`holds at most ${TOP_N} entries and drops the worst`, () => {
    const lb = fresh();
    for (let i = 0; i < TOP_N + 12; i++) {
      lb.submit({ name: `P${i}`, score: (i + 1) * 10, wave: 3, won: false });
    }
    expect(lb.entries).toHaveLength(TOP_N);
    // The board is full, so a run below the floor is refused outright — the
    // early return that also stops a pointless disk write.
    expect(lb.submit({ name: 'Nobody', score: 1, wave: 1, won: false })).toBe(false);
    // ...and one above it displaces the current last place.
    expect(lb.submit({ name: 'Somebody', score: 999_999, wave: 50, won: true })).toBe(true);
    expect(lb.top(1)[0].name).toBe('Somebody');
    expect(lb.entries).toHaveLength(TOP_N);
  });

  it('hands out a COPY, so a caller cannot edit the live board', () => {
    const lb = fresh();
    lb.submit({ name: 'Tide', score: 400, wave: 6, won: false });
    const a = lb.top();
    a[0].score = 999999;
    a.push({ name: 'injected', score: 1, wave: 1, won: false });
    expect(lb.top()).toHaveLength(1);
    expect(lb.top()[0].score).toBe(400);
  });

  it('clamps how many rows it will hand out', () => {
    const lb = fresh();
    for (let i = 0; i < 15; i++) lb.submit({ name: `P${i}`, score: 100 + i, wave: 2, won: false });
    expect(lb.top(0)).toHaveLength(0);
    expect(lb.top(-3)).toHaveLength(0);
    expect(lb.top(5)).toHaveLength(5);
    expect(lb.top(9999).length).toBeLessThanOrEqual(TOP_N);
  });

  it('exposes only the four public fields, never the timestamp it sorts on', () => {
    const lb = fresh();
    lb.submit({ name: 'Tide', score: 400, wave: 6, won: true });
    expect(Object.keys(lb.top()[0]).sort()).toEqual(['name', 'score', 'wave', 'won']);
  });
});
