import { encodeCreeps, phaseId, SNAP_VERSION } from './SpectateCodec.js';

/**
 * Produces this player's board snapshots — and produces NOTHING when nobody is
 * watching.
 *
 * That is the whole economics of the feature and it is enforced twice, on
 * purpose. `net.streaming` is checked HERE, before a single array is touched,
 * because encoding is the expensive half (a creep sweep plus a JSON.stringify);
 * `NetClient.snap()` checks it again as a backstop before the send. A client
 * that only had the second check would pay the entire cost of a feature nobody
 * asked it for, for the whole run.
 */

/** Nominal period. Matches SNAP_HZ = 10 in the design; NetClient floors at 90ms. */
const SNAP_INTERVAL_MS = 100;

/**
 * A full tower list is resent every this many snapshots (5 s at 10 Hz).
 *
 * ~1.3 KB / 5 s = 264 B/s buys a stream that heals itself after any dropped or
 * rejected delta, with no ack machinery, no retransmit queue and no state on
 * the server. The alternative — deltas only — means one rejected frame leaves
 * the watcher's board missing half its towers for the rest of the run, and
 * nothing on either machine can notice.
 */
const KEYFRAME_EVERY = 50;

export class SpectateStreamer {
  /** @param {import('../Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this._lastAt = 0;
    this._seq = 0;
    this._sinceKey = 0;

    /** Tower id -> level, as the watchers last saw it. */
    this._sent = new Map();

    // Every buffer below is reused for the life of the run. At 10 Hz forever,
    // a fresh array per snapshot is a steady drip of garbage for no reason.
    this._creeps = [];
    this._scratch = [];
    this._added = [];
    this._removed = [];
    this._full = [];
    /** The payload object handed to net.snap(). NetClient spreads it into a new
     *  object before stringifying, so reusing this one is safe. */
    this._msg = {
      v: SNAP_VERSION, n: 0, ts: 0, w: 0, l: 0, g: 0, sc: 0, ph: 0, pt: 0, c: this._creeps,
      tf: undefined, ta: undefined, tr: undefined,
    };
  }

  /**
   * Called once per rendered frame. Cheap and early-returning in the common
   * case, which is that nobody is watching.
   *
   * @param {import('../../net/NetClient.js').NetClient} net
   * @param {number} nowMs performance.now()
   */
  tick(net, nowMs) {
    if (!net.streaming) {
      // Not "return": a watcher who arrives mid-run must get a keyframe on the
      // very first snapshot, and the cheapest way to guarantee that is to forget
      // what the previous watcher had been told the moment the last one leaves.
      if (this._sent.size) this.reset();
      return false;
    }
    if (nowMs - this._lastAt < SNAP_INTERVAL_MS) return false;
    this._lastAt = nowMs;
    return net.snap(this.#build());
  }

  /** Forget everything the watchers were told. Call on `go` and on watcher zero. */
  reset() {
    this._sent.clear();
    this._seq = 0;
    this._sinceKey = 0;
    this._lastAt = 0;
  }

  #build() {
    const g = this.game;
    const s = g.state;
    const m = this._msg;

    m.n = ++this._seq;
    m.ts = Math.round(g.elapsed * 1000);
    m.w = Math.max(1, s.wave);
    m.l = Math.max(0, s.lives);
    m.g = Math.round(s.gold);
    m.sc = s.score;
    m.ph = phaseId(s.phase);
    // Tenths, not seconds: the banner shows one decimal at most, and a float
    // here costs up to 17 characters per snapshot to carry noise.
    m.pt = s.phase === 'prep' ? Math.max(0, Math.round(s.prepTimer * 10)) : 0;

    encodeCreeps(g.creeps, this._creeps, this._scratch);
    this.#towers(m);
    return m;
  }

  /**
   * Tower delta, with a periodic keyframe.
   *
   * The key is a STRING and not an index into ALL_TOWERS. `Object.keys` is
   * deterministic, so an index would work — right up until someone reorders
   * PURE_TOWERS, at which point every tower on every spectated board silently
   * becomes a different tower, with no compile error and no test that fails.
   * 22 keys averaging 9 characters, sent only on change, is the cheapest
   * possible insurance against that.
   */
  #towers(m) {
    const towers = this.game.towers.towers;
    const keyframe = this._sinceKey <= 0;
    this._sinceKey = keyframe ? KEYFRAME_EVERY : this._sinceKey - 1;

    // `undefined` and not `delete`: JSON.stringify omits an undefined value, so
    // the wire is identical, and the payload object keeps ONE hidden class for
    // the life of the run instead of reshaping twice per snapshot.
    if (keyframe) {
      const full = this._full;
      full.length = 0;
      this._sent.clear();
      for (const t of towers) {
        full.push([t.id, t.key, t.level, t.c, t.r]);
        this._sent.set(t.id, t.level);
      }
      m.tf = full;
      m.ta = undefined;
      m.tr = undefined;
      return;
    }

    const added = this._added;
    const removed = this._removed;
    added.length = 0;
    removed.length = 0;

    for (const t of towers) {
      // A level change is an ADD with the same id: the applier detaches and
      // re-attaches, which is exactly what TowerManager.upgrade does locally.
      if (this._sent.get(t.id) !== t.level) {
        added.push([t.id, t.key, t.level, t.c, t.r]);
        this._sent.set(t.id, t.level);
      }
    }
    for (const [id] of this._sent) {
      if (!towers.some((x) => x.id === id)) removed.push(id);
    }
    for (const id of removed) this._sent.delete(id);

    m.tf = undefined;
    // Absent rather than empty: in the steady state both are empty on every
    // snapshot, and an empty array is four characters plus a branch far side.
    m.ta = added.length ? added : undefined;
    m.tr = removed.length ? removed : undefined;
  }
}
