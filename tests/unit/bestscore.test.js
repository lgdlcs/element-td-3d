// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBest, saveBest } from '../../src/net/BestScore.js';

/**
 * THE ONLY THING THE GAME REMEMBERS.
 *
 * `elementtd.best.v1` in localStorage is the single value that survives a
 * session: the status bar reads it, the end card reads it, and the lobby's Hall
 * of Records is built on it. It had no test at all — lobby-hall.spec.js SEEDS
 * localStorage and reads the panel back, so the write path was never exercised
 * in either direction.
 *
 * Every case below is one the module's own docblocks claim in prose:
 *   - ties are not records ("flashing new best at an identical number reads as
 *     a bug")
 *   - corrupt JSON reads as "no record" rather than throwing on boot
 *   - a localStorage that THROWS is swallowed (Safari private mode, quota)
 *
 * jsdom, because localStorage is the subject. `int()` is private, so it is
 * asserted through what it does to a stored record.
 */

const KEY = 'elementtd.best.v1';

describe('BestScore', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  describe('loadBest', () => {
    it('reads a zeroed record when nothing is stored', () => {
      expect(loadBest()).toEqual({ score: 0, wave: 0, won: false, at: 0 });
    });

    it('reads back what saveBest wrote', () => {
      saveBest({ score: 1234, wave: 17, won: false });
      const b = loadBest();
      expect(b.score).toBe(1234);
      expect(b.wave).toBe(17);
      expect(b.won).toBe(false);
      expect(b.at).toBeGreaterThan(0);
    });

    it('treats corrupt JSON as "no record" rather than throwing', () => {
      localStorage.setItem(KEY, '{not json at all');
      expect(() => loadBest()).not.toThrow();
      expect(loadBest().score).toBe(0);
    });

    it('treats a non-object payload as "no record"', () => {
      for (const raw of ['null', '42', '"hello"', '[1,2,3]']) {
        localStorage.setItem(KEY, raw);
        // An array IS an object, so it does not take the early return — it takes
        // the coercion path instead and every field lands on 0. Either way the
        // contract is the same: no throw, no record.
        expect(loadBest().score, raw).toBe(0);
      }
    });

    it('coerces a hostile record to zeroes instead of rendering it', () => {
      // The status bar and the end card print these straight out. A negative or
      // NaN score would be drawn verbatim.
      localStorage.setItem(KEY, JSON.stringify({ score: -5, wave: 'twelve', won: 'yes', at: NaN }));
      const b = loadBest();
      expect(b.score).toBe(0);
      expect(b.wave).toBe(0);
      expect(b.at).toBe(0);
      expect(b.won).toBe(true);      // `!!v.won` — a truthy string IS a win flag
    });

    it('survives a localStorage getter that throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
      expect(() => loadBest()).not.toThrow();
      expect(loadBest().score).toBe(0);
    });
  });

  describe('saveBest', () => {
    it('records a first run', () => {
      const { best, record } = saveBest({ score: 900, wave: 12, won: false });
      expect(record).toBe(true);
      expect(best.score).toBe(900);
      expect(loadBest().score).toBe(900);
    });

    it('records a better run and keeps the new numbers', () => {
      saveBest({ score: 900, wave: 12, won: false });
      const { best, record } = saveBest({ score: 2400, wave: 30, won: true });
      expect(record).toBe(true);
      expect(best).toMatchObject({ score: 2400, wave: 30, won: true });
      expect(loadBest().score).toBe(2400);
    });

    it('does NOT record a tie, and leaves the stored record untouched', () => {
      // The claim in the module docblock, and the reason it is worth pinning:
      // "flashing new best at an identical number reads as a bug".
      saveBest({ score: 2400, wave: 30, won: true });
      const before = loadBest();
      const { best, record } = saveBest({ score: 2400, wave: 45, won: false });
      expect(record).toBe(false);
      expect(best).toEqual(before);
      // ...and specifically, the WORSE run's wave did not overwrite the better
      // run's, which is what a naive "save the latest" would have done.
      expect(loadBest()).toEqual(before);
    });

    it('does not record a worse run', () => {
      saveBest({ score: 2400, wave: 30, won: true });
      expect(saveBest({ score: 10, wave: 1, won: false }).record).toBe(false);
      expect(loadBest().score).toBe(2400);
    });

    it('coerces junk to 0, so junk can never beat a real record', () => {
      saveBest({ score: 500, wave: 5, won: false });
      for (const bad of [undefined, null, {}, { score: NaN }, { score: -900 }, { score: 'lots' }]) {
        expect(saveBest(bad).record, JSON.stringify(bad)).toBe(false);
      }
      expect(loadBest().score).toBe(500);
    });

    it('accepts a numeric string, because that is what a wire value looks like', () => {
      expect(saveBest({ score: '750', wave: '9', won: 1 }).record).toBe(true);
      expect(loadBest()).toMatchObject({ score: 750, wave: 9, won: true });
    });

    it('returns without throwing when localStorage.setItem throws', () => {
      // Safari private mode and an exhausted quota both do this. A throw here
      // would take down the end card, which is the one moment it fires.
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
      let out;
      expect(() => { out = saveBest({ score: 5000, wave: 40, won: true }); }).not.toThrow();
      // It still reports the record to the caller: the end card's "new best"
      // banner is about this run, not about whether the disk cooperated.
      expect(out.record).toBe(true);
      expect(out.best.score).toBe(5000);
    });
  });
});
