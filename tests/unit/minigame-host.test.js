// @vitest-environment jsdom
/**
 * MinigameHost, in a DOM but without a GPU.
 *
 * The host is deliberately importable here: it depends on Config, Waves, the
 * contract, the registry and one 2D context, and on NOTHING from three.js or
 * Game.js. That is not an accident of the import graph, it is the property that
 * lets the two guarantees below — no leaked listeners, never a second gold
 * credit — be tested at all rather than asserted in a docblock.
 *
 * jsdom has no canvas backend, so `getContext('2d')` returns null and every
 * element measures 0x0. MinigameHost.#render bails on a zero-sized canvas before
 * it touches the painter, which is exactly the same path a real browser takes on
 * a display:none overlay — so what is exercised here is the LOGIC of the host:
 * the loop, the clock, the input plumbing, the settle guard and the teardown.
 * Anything pixel-shaped is tests/e2e's job.
 *
 * PROVE THE INSTRUMENT CAN FAIL (docs/TESTING.md §4). Three mutations were
 * planted in the source and each one was watched go red before being reverted:
 *   - `#hold(window, 'blur', ...)` rewritten as a bare addEventListener fails
 *     BOTH teardown tests with a non-zero platform count. This one caught a real
 *     defect in the test itself first — see the census helper.
 *   - deleting `if (this._credited) return;` from #settle fails "will not pay a
 *     second time even if it is put back into play" with two calls. It fails
 *     NOTHING ELSE, which is why that test drives the state directly rather than
 *     only pressing keys; the honest note is in its own docblock.
 *   - swapping ctx.rand() for Math.random() in the rite fails
 *     "same seed, same occurrence, same inputs -> same payout".
 *
 * IT RUNS AGAINST ITS OWN RITE, NOT A REAL ONE (wave 0.5). Every claim in this
 * file is about the HOST — the loop, the clock, the click queue, the settle
 * guard, the teardown — and none of them is about any particular game. Binding
 * them to a shipped rite is how this suite ended up needing `inst.band()` and
 * `inst.hammerX`, which meant deleting one rite broke twenty tests that had
 * nothing to do with it. The synthetic below is registered into RITES for the
 * duration of the file, exactly as `tests/unit/rite-contract.test.js` argues:
 * a harness whose only proof of life leaves with the rite it was written
 * against is a harness nobody can trust afterwards.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MINIGAMES } from '../../src/core/Config.js';
import { waveDef } from '../../src/game/Waves.js';
import { minigameReward } from '../../src/minigames/contract.js';
import { MinigameHost } from '../../src/minigames/MinigameHost.js';
import { RITES } from '../../src/minigames/registry.js';

const DT = MINIGAMES.dt;

// ---------------------------------------------------------------------------
// The rite this file plays.
//
// Deliberately the smallest thing that is still a game: a window that opens and
// shuts on a fixed cycle, six commits to spend, one point for each that lands
// inside it. That is enough to exercise every host path — a perfect run that
// ends early, an idle run the clock has to end, a score in [0,1] and a seeded
// draw that a Math.random() would visibly break — and nothing more.
const HOST_RITE_ID = '__host-test-rite';
const HITS_NEEDED = 6;
/** Seconds per open/shut cycle, and how much of it is open. */
const CYCLE = 1.2;
const WINDOW = 0.5;

class HostTestRite {
  init(ctx) {
    this.t = 0;
    this.results = [];
    this._events = [];
    // The one seeded draw, and it MATTERS: the phase of the window is what makes
    // "same seed -> same payout" a real claim rather than a tautology.
    this.offset = ctx.rand() * CYCLE;
  }

  /** True while a commit would score. Pure, so `draw` could read it. */
  get armed() {
    if (this.results.length >= HITS_NEEDED) return false;
    return (this.t + this.offset) % CYCLE < WINDOW;
  }

  update(dt, input) {
    this.t += dt;
    if (this.results.length >= HITS_NEEDED) return true;
    if (input.action > 0) {
      const hit = this.armed;
      this.results.push(hit ? 'hit' : 'miss');
      this._events.push({ type: hit ? 'hit' : 'miss', x: 0 });
      if (this.results.length >= HITS_NEEDED) return true;
    }
  }

  draw() {}

  score() {
    const hits = this.results.filter((r) => r === 'hit').length;
    const ratio = hits / HITS_NEEDED;
    return { ratio, headline: ratio >= 1 ? 'Clean' : 'Ragged', detail: `${hits}/${HITS_NEEDED}` };
  }

  drainEvents() { return this._events.splice(0, this._events.length); }
}

/** @type {import('../../src/minigames/contract.js').MinigameDef} */
const HOST_RITE = {
  id: HOST_RITE_ID,
  name: 'Host Test Rite',
  hint: 'Commit while the window is open',
  // Long enough that an idle run is ended by the CLOCK (which several tests
  // below depend on) and short enough that 3 000 steps comfortably reach it.
  duration: 18,
  create: () => new HostTestRite(),
};

/**
 * A global listener census.
 *
 * Counting the host's own `listenerCount` would only prove that the host agrees
 * with itself. This wraps EventTarget so the number is taken from the platform:
 * whatever the host added to `document`, `window` and its own nodes has to come
 * back off, or the balance is non-zero.
 */
function census() {
  let live = 0;
  const undo = [];
  // PATCHING EventTarget.prototype ALONE IS NOT ENOUGH, and finding that out is
  // most of why this helper is written the long way. jsdom installs
  // addEventListener directly on `window` and on `document`, so a listener bound
  // to either goes straight past a patched prototype — the first version of this
  // census reported a perfectly balanced zero while the host was leaking a
  // window 'blur' handler on every single open. Verified by planting exactly
  // that leak and watching this go red.
  for (const target of [EventTarget.prototype, window, document]) {
    if (!Object.prototype.hasOwnProperty.call(target, 'addEventListener')
        && target !== EventTarget.prototype) continue;
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    target.addEventListener = function (...a) { live++; return add.apply(this, a); };
    target.removeEventListener = function (...a) { live--; return remove.apply(this, a); };
    undo.push(() => { target.addEventListener = add; target.removeEventListener = remove; });
  }
  return {
    get live() { return live; },
    restore() { for (const f of undo) f(); },
  };
}

/** The narrowest thing the host will accept as a Game. */
function fakeGame() {
  return {
    seed: 20260806,
    pipeline: { quality: 'high' },
    audio: { play: vi.fn() },
    addGold: vi.fn(),
    hud: { floatText: vi.fn(), warn: vi.fn() },
  };
}

function key(code, type = 'keydown') {
  document.dispatchEvent(new window.KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
}

/**
 * A pointer event on the stage, in CLIENT pixels.
 *
 * jsdom has no layout, so getBoundingClientRect() is all zeros and Painter.ppu
 * is whatever the last layout() left it at (1, since #render bails on a 0x0
 * canvas before it ever calls layout). That is not a limitation here — it makes
 * client pixels and world units the SAME NUMBERS, which is exactly what a test
 * about "which position was recorded" wants: no transform to reason about, so a
 * failure is about the queue and never about the letterbox. The letterbox itself
 * is tests/e2e's job.
 */
function pointer(type, x, y, button = 0) {
  const el = root.querySelector('#rite-stage');
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX: x, clientY: y, button });
  (type === 'pointerdown' || type === 'pointerleave' ? el : window).dispatchEvent(e);
  return e;
}

/**
 * A no-op 2D context.
 *
 * jsdom's getContext() is not implemented and reports itself through the virtual
 * console on EVERY construction — 25 identical "Not implemented" lines for this
 * file alone. tests/unit/setup.js exists because a suite whose output is noise
 * trains everyone to stop reading the output; adding to that noise rather than
 * removing its cause would be the exact mistake that file argues against. This
 * removes the cause: the host gets a context-shaped object, never calls it
 * (#render bails on a 0x0 canvas first), and jsdom has nothing to complain about.
 */
function stub2d() {
  const noop = () => stub;
  const stub = new Proxy({ canvas: { width: 0, height: 0 } }, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: () => true,
  });
  return stub;
}

/**
 * Open a rite AND stand through its five-second announcement.
 *
 * Every test below this line is about what happens once the field is live —
 * the loop, the clock, the click queue, the settle guard — and none of them is
 * about the pre-roll, which has its own describe block. Burning it here rather
 * than in each test keeps that separation, and it burns it the way the game
 * does: real frames through `update`, never by writing `mode` from outside.
 *
 * Frames are clamped to MINIGAMES.maxFrameDt, so this is ~50 iterations and
 * the loop cannot hang on a countdown that stopped counting — `open` returning
 * false skips it entirely and the mode check exits the moment play begins.
 */
function openRite(opts, h = host) {
  const ok = h.open(opts);
  for (let i = 0; i < 400 && ok && h.mode === 'countdown'; i++) h.update(0.1);
  return ok;
}

let root; let game; let host;

beforeEach(() => {
  RITES[HOST_RITE_ID] = HOST_RITE;
  window.HTMLCanvasElement.prototype.getContext = stub2d;
  document.body.innerHTML = '<div id="ui-root"></div>';
  root = document.getElementById('ui-root');
  game = fakeGame();
  host = new MinigameHost(game, root);
});

afterEach(() => {
  host?.destroy();
  document.body.innerHTML = '';
  delete RITES[HOST_RITE_ID];
});

// ===========================================================================
describe('mounting', () => {
  it('builds an inert, hidden dialog with a veil and no listeners', () => {
    const el = root.querySelector('#rite');
    expect(el).toBeTruthy();
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.classList.contains('open')).toBe(false);
    // The full-bleed click eater. Without it, "outside the panel" is the board.
    expect(el.querySelector('.rite-veil')).toBeTruthy();
    // Nothing is bound until something is played.
    expect(host.listenerCount).toBe(0);
    expect(host.isOpen).toBe(false);
  });

  it('refuses an unknown rite instead of opening an empty one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(host.open({ id: 'no-such-rite', wave: 9, occurrence: 0 })).toBe(false);
    expect(host.isOpen).toBe(false);
    expect(host.listenerCount).toBe(0);
    warn.mockRestore();
  });

  it('refuses to open a second rite over the first', () => {
    expect(host.open({ id: HOST_RITE_ID, wave: 9, occurrence: 0 })).toBe(true);
    const bound = host.listenerCount;
    expect(host.open({ id: HOST_RITE_ID, wave: 9, occurrence: 0 })).toBe(false);
    expect(host.listenerCount).toBe(bound);
  });
});

// ===========================================================================
/**
 * The five-second announcement, which is the only part of a rite the PLAYER
 * gets for free: the clock does not run and the rite is not stepped.
 *
 * The number 5 is hard-coded here rather than imported, on purpose. COUNTDOWN
 * is private to the host and a test that reads the same constant as the code
 * asserts nothing — it would keep passing if the pre-roll silently became one
 * second. These tests fail if the length changes, which is the point: five
 * seconds is a design decision and changing it should require saying so.
 */
describe('the pre-roll', () => {
  const num = () => root.querySelector('#rite-count-num').textContent;
  const shown = () => !root.querySelector('#rite-count').hidden;

  it('opens onto the announcement, not onto the game', () => {
    host.open({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    expect(host.mode).toBe('countdown');
    expect(shown()).toBe(true);
    expect(num()).toBe('5');
    // And the heading — which the announcement deliberately does not repeat —
    // is already naming what is about to start.
    expect(root.querySelector('#rite-title').textContent).toBe(HOST_RITE.name);
  });

  it('spends no rite time and no clock while it counts', () => {
    host.open({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    for (let i = 0; i < 31; i++) host.update(0.1);      // 3.1 seconds
    expect(host.mode).toBe('countdown');
    expect(num()).toBe('2');
    // The rite's own clock has not moved, and neither has the host's.
    expect(host.instance.t).toBe(0);
    expect(host._remaining).toBe(HOST_RITE.duration);
  });

  it('hands over after five seconds and starts the clock then', () => {
    host.open({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    for (let i = 0; i < 49; i++) host.update(0.1);      // 4.9s
    expect(host.mode).toBe('countdown');
    // Two frames rather than one: 49 x 0.1 is 4.899999... in binary floating
    // point, so the exact boundary frame is not a claim worth making.
    host.update(0.1); host.update(0.1);
    expect(host.mode).toBe('play');
    for (let i = 0; i < 10; i++) host.update(0.1);      // one second of play
    expect(host.instance.t).toBeGreaterThan(0.9);
    expect(host._remaining).toBeLessThan(HOST_RITE.duration);
  });

  /**
   * THE PRESS THAT SKIPS IS NOT ALSO A SHOT. Under the obvious implementation
   * (start on any commit, then fall through to the normal handler) the first
   * frame of every impatiently-started rite carries a commit the player aimed
   * at the word "Go" — a wasted strike in a rite scored on six of them.
   */
  it('a commit key starts it now, and is not delivered as a commit', () => {
    host.open({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    key('Space');
    expect(host.mode).toBe('play');
    host.update(DT);
    expect(host.instance.results).toEqual([]);
  });

  it('a press on the stage starts it now, and is not delivered as a click', () => {
    host.open({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    pointer('pointerdown', 3, 2);
    expect(host.mode).toBe('play');
    host.update(DT);
    expect(host.instance.results).toEqual([]);
  });

  it('can be abandoned before it ever starts, for nothing', () => {
    const onDone = vi.fn();
    host.open({ id: HOST_RITE_ID, wave: 20, occurrence: 0, onDone });
    key('Escape');
    key('Escape');
    expect(host.mode).toBe('result');
    expect(game.addGold).not.toHaveBeenCalled();
    host.close();
    expect(onDone.mock.calls[0][0]).toMatchObject({ reward: 0, skipped: true });
  });

  /**
   * A rite that arrives while the window is in the background must not spend
   * its announcement to an empty chair — that is the same claim the suspension
   * makes about play, and the pre-roll is worth more per second.
   */
  it('is suspended by a lost window, exactly as play is', () => {
    host.open({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    window.dispatchEvent(new window.Event('blur'));
    for (let i = 0; i < 60; i++) host.update(0.1);      // six seconds away
    expect(host.mode).toBe('countdown');
    expect(num()).toBe('5');
  });
});

// ===========================================================================
describe('teardown', () => {
  it('releases every listener it took, measured from the platform', () => {
    const c = census();
    try {
      const before = c.live;
      openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
      expect(host.listenerCount).toBeGreaterThan(5);
      expect(c.live).toBeGreaterThan(before);
      host.close();
      expect(host.listenerCount).toBe(0);
      expect(c.live).toBe(before);
    } finally { c.restore(); }
  });

  it('stays balanced over many open/close cycles', () => {
    const c = census();
    try {
      const before = c.live;
      for (let i = 0; i < 12; i++) {
        openRite({ id: HOST_RITE_ID, wave: 9 + i, occurrence: i });
        host.update(DT);
        host.close();
      }
      expect(c.live).toBe(before);
      expect(host.listenerCount).toBe(0);
    } finally { c.restore(); }
  });

  it('close() is idempotent and calls back exactly once', () => {
    const onDone = vi.fn();
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0, onDone });
    host.close();
    host.close();
    host.close();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a shut host ignores the keyboard entirely', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    host.close();
    // If the shield were still bound this would be swallowed (defaultPrevented).
    const e = new window.KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('update() after close is a no-op, not a crash', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    host.close();
    expect(() => { for (let i = 0; i < 100; i++) host.update(DT); }).not.toThrow();
  });
});

// ===========================================================================
describe('the keyboard shield', () => {
  beforeEach(() => openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 }));

  it('swallows the game keys that would otherwise act behind the veil', () => {
    // THE INCIDENT THIS EXISTS FOR (HUD.js `_onKeyShield`): Space sent the next
    // wave from behind a full-bleed panel. Space is this overlay's primary verb.
    for (const code of ['Space', 'KeyP', 'Digit1', 'Digit3', 'KeyX', 'KeyU', 'KeyM']) {
      const e = new window.KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
      document.dispatchEvent(e);
      expect(e.defaultPrevented, code).toBe(true);
    }
  });

  it('never steals a browser or OS combination, or a function key', () => {
    for (const init of [
      { code: 'KeyR', metaKey: true }, { code: 'KeyW', ctrlKey: true },
      { code: 'Tab', altKey: true }, { code: 'F9' }, { code: 'F5' }, { code: 'F12' },
    ]) {
      const e = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      document.dispatchEvent(e);
      expect(e.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
  });
});

// ===========================================================================
/**
 * THE CLICK QUEUE — the reason this whole section exists.
 *
 * Every test below is about ONE claim: a click is resolved where and when it
 * happened, not where the pointer ended up. That claim cannot be made by a rite
 * (it only sees what it is handed) and cannot be made by the contract (it is
 * only a shape), so it is made here or nowhere.
 */
describe('the click queue', () => {
  /**
   * Record every input record the rite is handed, DEEP-COPIED.
   *
   * Copied because the records are pooled and reused (contract.js
   * NEUTRAL_INPUT): a test that kept references would end up asserting on the
   * last click of the run, several times over, and would pass no matter what
   * the host did. This helper is the test-side demonstration of the rule rite
   * authors are told to follow.
   */
  function record(h) {
    const seen = [];
    const inner = h.instance.update.bind(h.instance);
    h.instance.update = (dt, input) => {
      seen.push({
        action: input.action,
        altAction: input.altAction,
        clicks: input.clicks.map((c) => ({ ...c })),
      });
      return inner(dt, input);
    };
    return seen;
  }

  it('a right-click is a positioned click and is NOT a primary commit', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);
    pointer('pointerdown', 3, -2, 2);
    host.update(DT);

    expect(seen[0].clicks).toEqual([{ x: 3, y: 2, button: 2, source: 'pointer' }]);
    expect(seen[0].altAction).toBe(1);
    // THE COMPATIBILITY CLAIM. `action` counts primary commits and nothing else,
    // so every rite written before the second button existed is untouched by it.
    expect(seen[0].action).toBe(0);
  });

  it('a left-click still counts as an action, and is queued as well', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);
    pointer('pointerdown', 1, -1, 0);
    host.update(DT);
    expect(seen[0].action).toBe(1);
    expect(seen[0].altAction).toBe(0);
    expect(seen[0].clicks).toEqual([{ x: 1, y: 1, button: 0, source: 'pointer' }]);
  });

  /**
   * THE EXACT BUG THE QUEUE EXISTS FOR.
   *
   * Press at A, keep moving to B, then let a step run. Before the queue, the
   * rite resolved the press against `input.x/y` — which by then was B — so a
   * shot fired at one target was credited to wherever the hand had travelled a
   * frame later. At 60 Hz with a fast hand that is a couple of world units, i.e.
   * most of a target. If this test ever goes green with the capture moved back
   * out of the pointerdown handler, it is not testing anything.
   */
  it('resolves a click at the position it was PRESSED, not where the pointer went', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);

    pointer('pointerdown', 2, -1, 0);      // A
    pointer('pointermove', -6, -4);        // B, before the step
    host.update(DT);

    expect(seen[0].clicks[0].x).toBe(2);   // A, not B
    expect(seen[0].clicks[0].y).toBe(1);
    // ...and the pointer position itself DID follow to B, which is what makes
    // the assertion above meaningful rather than accidental.
    expect(host._input.x).toBe(-6);
    expect(host._input.y).toBe(4);
  });

  it('keeps the arrival order of several clicks in one frame', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);
    pointer('pointerdown', 1, 0, 0);
    pointer('pointerdown', 2, 0, 2);
    pointer('pointerdown', 3, 0, 0);
    host.update(DT);
    expect(seen[0].clicks.map((c) => [c.x, c.button])).toEqual([[1, 0], [2, 2], [3, 0]]);
    expect(seen[0].action).toBe(2);
    expect(seen[0].altAction).toBe(1);
  });

  it('delivers the queue to the FIRST sub-step only', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);
    pointer('pointerdown', 4, 0, 0);
    host.update(DT * 5);                   // one frame, five fixed steps

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0].clicks.length).toBe(1);
    // Handing the same click to every sub-step would turn one press into five
    // shots — the same bug `action` was shaped to avoid, in a new field.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].clicks, `sub-step ${i + 1}`).toEqual([]);
      expect(seen[i].action, `sub-step ${i + 1}`).toBe(0);
    }
  });

  it('drops clicks past the cap instead of growing the queue', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);
    for (let i = 0; i < MINIGAMES.maxClicksPerStep + 8; i++) pointer('pointerdown', i, 0, 0);
    host.update(DT);
    expect(seen[0].clicks.length).toBe(MINIGAMES.maxClicksPerStep);
    // The ones that survived are the FIRST ones: a queue that dropped the head
    // would resolve the newest press and discard the one the player made first.
    expect(seen[0].clicks[0].x).toBe(0);
  });

  it('a keyboard commit is a click too, at the last known pointer position', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);
    pointer('pointermove', 5, -3);
    key('Space');
    host.update(DT);
    // Space is the accessible alternative to a mouse button, so a shooting rite
    // is playable without one — and on a trackpad, without the two-finger delay.
    expect(seen[0].clicks).toEqual([{ x: 5, y: 3, button: 0, source: 'key' }]);
    expect(seen[0].action).toBe(1);
  });

  it('a blur empties the queue: a click that refocused the window is not a shot', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);
    pointer('pointerdown', 7, 0, 0);
    window.dispatchEvent(new window.Event('blur'));
    expect(host._pendingClicks.length).toBe(0);
    expect(host._pendingAlt).toBe(0);
    key('Space');                            // resumes, does not fire
    for (let i = 0; i < 120; i++) host.update(DT);
    for (const s of seen) expect(s.clicks).toEqual([]);
  });

  it('the context menu never opens over the rite, veil included', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    for (const sel of ['#rite', '#rite .rite-veil', '#rite-stage', '#rite-skip']) {
      const e = new window.Event('contextmenu', { bubbles: true, cancelable: true });
      root.querySelector(sel).dispatchEvent(e);
      // Bound on #rite rather than on the stage: a right-click that misses the
      // field by four pixels must not be the one that raises an OS menu — which
      // would cover the field, eat the next click, and blur the page on the way
      // out, which the host reads as "the player looked away".
      expect(e.defaultPrevented, sel).toBe(true);
    }
  });

  it('releasing the right button does not release a held left button', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    pointer('pointerdown', 0, 0, 0);
    expect(host._input.down).toBe(true);
    pointer('pointerup', 0, 0, 2);
    expect(host._input.down).toBe(true);
    pointer('pointerup', 0, 0, 0);
    expect(host._input.down).toBe(false);
  });

  it('ignores buttons that are not a game verb', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    const seen = record(host);
    pointer('pointerdown', 1, 0, 1);        // middle
    pointer('pointerdown', 2, 0, 3);        // back
    host.update(DT);
    expect(seen[0].clicks).toEqual([]);
    expect(seen[0].action + seen[0].altAction).toBe(0);
  });
});

// ===========================================================================
describe('per-rite dressing', () => {
  it('themes the overlay on open and takes it off on close', () => {
    const el = root.querySelector('#rite');
    expect(el.dataset.rite).toBeUndefined();
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    // Defaults to the id; a def that declares `theme` overrides it.
    expect(el.dataset.rite).toBe(HOST_RITE_ID);
    host.close();
    // Removed, not left behind: a stale theme would paint the NEXT rite's
    // 240 ms entry transition in the previous one's colours.
    expect(el.dataset.rite).toBeUndefined();
  });

  it('uses the def-supplied eyebrow and abandon note, with sane defaults', () => {
    openRite({ id: HOST_RITE_ID, wave: 12, occurrence: 0 });
    expect(root.querySelector('#rite-eyebrow').textContent).toBe('Interlude · before wave 12');
    root.querySelector('#rite-skip').click();
    // The literal here used to be 'You stepped away from the anvil', which is
    // true of exactly one rite out of six.
    expect(root.querySelector('#rite-result-detail').textContent).toBe('You walked away');
  });

  /**
   * The four optional fields, read through the real open() path.
   *
   * The def is added to the registry table for the duration of the test and
   * removed after. That is a mutation of a module singleton and it is the honest
   * way to test this: asserting the same four lines the host runs, inline in the
   * test, would prove only that the test can copy code.
   */
  it('a themed def overrides every dressing hook', () => {
    const inert = {
      init() {}, update() {}, draw() {},
      score: () => ({ ratio: 0, headline: 'h', detail: 'd' }),
    };
    RITES.__themed = {
      id: '__themed', name: 'Themed', hint: 'h', duration: 5,
      theme: 'fishing', eyebrow: 'Cast', abandonNote: 'You left the water',
      cursor: 'grab', create: () => ({ ...inert }),
    };
    try {
      openRite({ id: '__themed', wave: 9, occurrence: 0 });
      expect(host.$el.dataset.rite).toBe('fishing');
      expect(root.querySelector('#rite-eyebrow').textContent).toBe('Cast · before wave 9');
      expect(host.$canvas.style.cursor).toBe('grab');
      root.querySelector('#rite-skip').click();
      expect(root.querySelector('#rite-result-detail').textContent).toBe('You left the water');
      host.close();
      // The cursor is inline style, so it MUST be cleared or it survives into a
      // rite that never asked to be steered.
      expect(host.$canvas.style.cursor).toBe('');
    } finally {
      delete RITES.__themed;
    }
  });
});

// ===========================================================================
describe('the clock', () => {
  it('counts down in real seconds and is not scaled by anything', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    for (let i = 0; i < 60; i++) host.update(DT);
    expect(host._remaining).toBeCloseTo(HOST_RITE.duration - 1, 1);
  });

  it('clamps a monstrous frame instead of replaying it', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    host.update(30);   // a thirty-second stall
    // At most MINIGAMES.maxFrameDt of the rite may have happened.
    expect(HOST_RITE.duration - host._remaining).toBeLessThanOrEqual(MINIGAMES.maxFrameDt + DT);
  });

  it('a blur stops it, and coming back costs a grace rather than a score', () => {
    openRite({ id: HOST_RITE_ID, wave: 9, occurrence: 0 });
    host.update(DT);
    const at = host._remaining;
    window.dispatchEvent(new window.Event('blur'));
    for (let i = 0; i < 120; i++) host.update(DT);   // two seconds away
    expect(host._remaining).toBe(at);
    expect(host.mode).toBe('play');

    key('Space');                                    // any key resumes
    for (let i = 0; i < 30; i++) host.update(DT);    // half a second of grace
    expect(host._remaining).toBe(at);                // still not running
    for (let i = 0; i < 60; i++) host.update(DT);
    expect(host._remaining).toBeLessThan(at);        // now it is
    // And the keypress that woke it up was not counted as a strike.
    expect(host.instance.results.length).toBe(0);
  });
});

// ===========================================================================
describe('gold, credited exactly once', () => {
  /** Drive the host to a finish with a player who commits only inside the window. */
  function playPerfectly(h) {
    for (let i = 0; i < 3000 && h.mode === 'play'; i++) {
      if (h.instance?.armed) key('Space');
      h.update(DT);
    }
  }

  it('pays the contract reward for a perfect run, on one call', () => {
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0 });
    playPerfectly(host);
    expect(host.mode).toBe('result');
    expect(host._ratio).toBe(1);
    const w = waveDef(20);
    expect(game.addGold).toHaveBeenCalledTimes(1);
    expect(game.addGold).toHaveBeenCalledWith(minigameReward(1, w.count * w.bounty), 'minigame');
  });

  /**
   * THE `_credited` GUARD, DRIVEN DIRECTLY — and the reason this test looks like
   * cheating.
   *
   * On a real board no sequence of keys and clicks reaches #settle twice: the
   * update loop breaks the moment it settles, its `while` condition re-tests the
   * mode, and #skip refuses outside 'play'. So a test that only ever presses
   * keys can pass with the guard deleted — measured, it does. That makes the
   * guard look like dead code, and the next person to read it will delete it.
   *
   * Same shape as Game.placementReason's 'stacks' branch, which is unreachable
   * by clicking and is driven directly by tests/e2e/grid-preview.spec.js for
   * exactly this reason: putting the host back into 'play' after it has settled
   * is what a mishandled mode transition would do, and the point of the guard is
   * the day something else can produce one. Deleting `_credited` makes this go
   * red with two calls; that is verified, not assumed.
   */
  it('will not pay a second time even if it is put back into play', () => {
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0 });
    playPerfectly(host);
    expect(game.addGold).toHaveBeenCalledTimes(1);
    host.mode = 'play';
    host._remaining = 0;      // the clock, arriving at a rite already settled
    host.update(DT);
    expect(game.addGold).toHaveBeenCalledTimes(1);
  });

  it('cannot be made to pay twice by Escape spam during the result animation', () => {
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0 });
    playPerfectly(host);
    for (let i = 0; i < 20; i++) key('Escape');
    root.querySelector('#rite-skip').click();
    root.querySelector('#rite-continue').click();
    expect(game.addGold).toHaveBeenCalledTimes(1);
  });

  it('skipping pays nothing at all — not even the participation floor', () => {
    const onDone = vi.fn();
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0, onDone });
    key('Escape');                       // arms
    expect(host.mode).toBe('play');
    key('Escape');                       // confirms
    expect(host.mode).toBe('result');
    expect(game.addGold).not.toHaveBeenCalled();
    key('Enter');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toMatchObject({ reward: 0, skipped: true, wave: 20 });
  });

  it('a single Escape never forfeits the rite, and disarms itself', () => {
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0 });
    key('Escape');
    for (let i = 0; i < 60 * 4; i++) host.update(DT);   // wait out the arming
    key('Escape');                                      // arms again, not skips
    expect(host.mode).toBe('play');
    expect(game.addGold).not.toHaveBeenCalled();
  });

  it('the Skip BUTTON commits on one click — a deliberate act, unlike a reflex', () => {
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0 });
    root.querySelector('#rite-skip').click();
    expect(host.mode).toBe('result');
    expect(game.addGold).not.toHaveBeenCalled();
  });

  /**
   * OPENING THE RITE AND LOOKING AWAY IS WORTH EXACTLY WHAT SKIPPING IS WORTH.
   *
   * This test used to assert the opposite — "still gets paid the floor" — and it
   * was right about the code and wrong about the design. `floorFrac` paid 20% of
   * a perfect run for a ratio of zero while Escape paid nothing, so the
   * dominant line at wave 48 was "start it, do nothing, collect 92 gold". Both
   * `floorFrac` and the threshold that patched it are gone: `minigameReward` is
   * now a single continuous curve (contract.js), so a ratio of 0 pays 0 BY
   * CONSTRUCTION rather than because a constant was tuned to sit above every
   * measured do-nothing score.
   */
  it('a player who does nothing is paid nothing at all — the floor is not a wage', () => {
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0 });
    for (let i = 0; i < 3000 && host.mode === 'play'; i++) host.update(DT);
    expect(host.mode).toBe('result');
    expect(host._ratio).toBe(0);
    expect(host._reward).toBe(0);
    expect(game.addGold).not.toHaveBeenCalled();
    // ...and a rite that WAS played still pays through the same path.
    const w = waveDef(20);
    expect(minigameReward(1, w.count * w.bounty)).toBeGreaterThan(0);
  });

  it('the clock expiring and the rite finishing cannot both pay', () => {
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0 });
    // A do-nothing run scores zero, and the reward curve pays zero for zero — so
    // the double-credit race needs a rite that is actually worth something
    // before it can be observed at all.
    host.instance.score = () => ({ ratio: 1, headline: 'x', detail: '' });
    // Park the clock one step from zero, then let the rite resolve into it.
    host._remaining = DT;
    host.update(DT * 2);
    expect(host.mode).toBe('result');
    expect(game.addGold).toHaveBeenCalledTimes(1);
  });

  it('hands the outcome back to the caller when it closes, once', () => {
    const onDone = vi.fn();
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0, onDone });
    playPerfectly(host);
    expect(onDone).not.toHaveBeenCalled();      // the result card is still up
    key('Enter');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toMatchObject({ id: HOST_RITE_ID, wave: 20, skipped: false });
    expect(onDone.mock.calls[0][0].reward).toBeGreaterThan(0);
  });

  it('advances on its own if the player walks away from the result card', () => {
    const onDone = vi.fn();
    openRite({ id: HOST_RITE_ID, wave: 20, occurrence: 0, onDone });
    root.querySelector('#rite-skip').click();
    for (let i = 0; i < 60 * 8; i++) host.update(DT);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(host.isOpen).toBe(false);
  });
});

// ===========================================================================
describe('determinism through the host', () => {
  it('same seed, same occurrence, same inputs -> same payout', () => {
    const run = () => {
      const g = fakeGame();
      const h = new MinigameHost(g, root);
      openRite({ id: HOST_RITE_ID, wave: 33, occurrence: 4 }, h);
      // A blind, fixed rhythm — no reading of the rite's internals, so this is
      // the same input sequence in both runs by construction.
      for (let i = 0; i < 2000 && h.mode === 'play'; i++) {
        if (i % 37 === 0) key('Space');
        h.update(DT);
      }
      const paid = g.addGold.mock.calls.map((c) => c[0]);
      const ratio = h._ratio;
      h.destroy();
      return { paid, ratio };
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });
});
