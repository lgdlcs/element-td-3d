// @vitest-environment jsdom
/**
 * The Lottery surface, in a DOM but without a GPU.
 *
 * `src/ui/Lottery.js` is importable here because it depends on Config, Waves,
 * the pure rules, Rng, Painter and one 2D context — and on nothing from three.js
 * or Game.js. That is the property that makes the guarantees below testable
 * rather than merely asserted in a docblock.
 *
 * jsdom has no canvas backend, so `getContext('2d')` is null and every element
 * measures 0x0. `#render` bails on a zero-sized canvas before it touches the
 * painter, which is the same path a real browser takes on an overlay that is
 * still transitioning in — so what is exercised here is the LOGIC: the
 * transaction, the single credit, the escape hatches, the phase restore and the
 * teardown. Anything pixel-shaped is tests/e2e's job.
 *
 * PROVE THE INSTRUMENT CAN FAIL (docs/TESTING.md §4). Three mutations were
 * planted in the source and each was watched go red before being reverted:
 *   - deleting `if (this._credited) return;` from `#settle` fails "credits
 *     exactly once however many ways it is closed" with two addGold calls.
 *   - rewriting one `#hold(...)` as a bare `addEventListener` fails the listener
 *     census with a non-zero balance after close.
 *   - moving the `rngFor` call from `#wager` into `#reveal` fails "the outcome
 *     is decided before the animation, not by it": the escape path then
 *     resolves a different draw from the one the timeline would have produced.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Lottery } from '../../src/ui/Lottery.js';
import {
  FIRST_WAGER_WAVE, LOTTERY_OUTCOMES, potContribution, resolveLottery, stakeFor,
} from '../../src/game/lottery.js';
import { rngFor } from '../../src/core/Rng.js';

/**
 * A global listener census, taken from the platform rather than from the object
 * under test — counting `lottery.listenerCount` would only prove the class
 * agrees with itself. jsdom installs addEventListener directly on `window` and
 * `document`, so patching EventTarget.prototype alone misses both.
 */
function census() {
  let live = 0;
  const undo = [];
  for (const target of [EventTarget.prototype, window, document]) {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    target.addEventListener = function (...a) { live++; return add.apply(this, a); };
    target.removeEventListener = function (...a) { live--; return remove.apply(this, a); };
    undo.push(() => { target.addEventListener = add; target.removeEventListener = remove; });
  }
  return { get live() { return live; }, restore() { for (const f of undo) f(); } };
}

/** The narrowest thing the Lottery will accept as a Game. */
function fakeGame(over = {}) {
  const { state: stateOver, ...rest } = over;
  const state = {
    gold: 5000, wave: 29, phase: 'prep', speed: 1,
    goldEarned: {}, goldSpent: {},
    ...(stateOver ?? {}),
  };
  return {
    seed: 20260806,
    state,
    audio: { play: vi.fn() },
    hud: { warn: vi.fn(), floatText: vi.fn() },
    addGold: vi.fn((n, reason) => {
      state.gold += Math.floor(n);
      state.goldEarned[reason] = (state.goldEarned[reason] ?? 0) + Math.floor(n);
      return Math.floor(n);
    }),
    spendGold: vi.fn((n, reason) => {
      const g = Math.floor(n);
      if (state.gold < g) return false;
      state.gold -= g;
      state.goldSpent[reason] = (state.goldSpent[reason] ?? 0) + g;
      return true;
    }),
    ...rest,
  };
}

let root;
let lot;
let game;

function mount(over) {
  root = document.createElement('div');
  root.id = 'ui-root';
  document.body.appendChild(root);
  game = fakeGame(over);
  lot = new Lottery(game, root);
  return lot;
}

/** Run the overlay's clock forward, in 16 ms frames, like Game.frame does. */
function run(seconds) {
  const n = Math.ceil(seconds / (1 / 60));
  for (let i = 0; i < n && lot.isOpen; i++) lot.update(1 / 60);
}

/**
 * Run until the overlay closes on its own.
 *
 * A fixed `run(6)` is NOT enough and that cost a confusing failure: a
 * Convergence holds its card for 3.4 s on top of the 3.62 s draw, so a six
 * second budget left the overlay open, the next `invoke()` refused, and the
 * test then asserted against the PREVIOUS draw. Loop on the actual state.
 */
function finish() {
  for (let i = 0; i < 60 * 25 && lot.isOpen; i++) lot.update(1 / 60);
  expect(lot.isOpen).toBe(false);
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => { lot?.destroy?.(); document.body.innerHTML = ''; lot = null; });

// ---------------------------------------------------------------------------

describe('mounting', () => {
  it('builds both surfaces and touches nothing else', () => {
    mount();
    expect(root.querySelector('#lot')).toBeTruthy();
    expect(root.querySelector('#lotdraw')).toBeTruthy();
    expect(root.querySelector('#lotdraw').getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('#lotdraw').classList.contains('open')).toBe(false);
  });

  it('is a real dialog with a real veil', () => {
    mount();
    const el = root.querySelector('#lotdraw');
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(el.querySelector('.ld-veil')).toBeTruthy();
  });

  it('shows the wave-appropriate stake on the seal', () => {
    mount({ state: { wave: 29, phase: 'prep', gold: 5000 } });
    lot.update(1 / 60);
    // Preparing wave 30 -> the published rung is 150.
    expect(root.querySelector('#lot-stake-num').textContent).toBe('150');
    expect(lot.stake).toBe(stakeFor(30));
  });

  it('renders the whole payout table into the fold, once', () => {
    mount();
    const rows = root.querySelectorAll('.lot-table li');
    expect(rows).toHaveLength(LOTTERY_OUTCOMES.length);
    expect([...rows].map((r) => r.dataset.out))
      .toEqual(LOTTERY_OUTCOMES.map((o) => o.id));
  });
});

describe('the seal is dark for exactly the documented reasons', () => {
  const btn = () => root.querySelector('#lot-go');

  it('is live during a prep past the wave floor', () => {
    mount({ state: { wave: 29, phase: 'prep', gold: 5000 } });
    lot.update(1 / 60);
    expect(btn().disabled).toBe(false);
    expect(root.querySelector('#lot').classList.contains('up')).toBe(true);
  });

  it('leaves the rail entirely outside a prep', () => {
    mount({ state: { wave: 29, phase: 'combat', gold: 5000 } });
    lot.update(1 / 60);
    expect(root.querySelector('#lot').classList.contains('up')).toBe(false);
    expect(root.querySelector('#lot').getAttribute('aria-hidden')).toBe('true');
  });

  it('is dark, with a reason, when the reserve is too thin', () => {
    mount({ state: { wave: 29, phase: 'prep', gold: 299 } });   // stake 150, needs 300
    lot.update(1 / 60);
    expect(btn().disabled).toBe(true);
    expect(root.querySelector('#lot-note').textContent).toMatch(/Reserve/);
    expect(lot.invoke()).toBe(false);
    expect(game.spendGold).not.toHaveBeenCalled();
  });

  it('is dark, and says so, once the wave has been wagered', () => {
    mount();
    expect(lot.invoke()).toBe(true);
    lot.close();
    lot.update(1 / 60);
    expect(btn().disabled).toBe(true);
    expect(root.querySelector('#lot-go-label').textContent).toBe('Spent');
    expect(lot.invoke()).toBe(false);
    expect(game.spendGold).toHaveBeenCalledTimes(1);
  });

  it('comes back for the NEXT prep, and only then', () => {
    mount();
    lot.invoke();
    lot.close();
    game.state.wave = 30;                     // the next wave was cleared
    lot.update(1 / 60);
    expect(btn().disabled).toBe(false);
    expect(lot.invoke()).toBe(true);
  });

  it('refuses a wave below the floor', () => {
    mount({ state: { wave: 0, phase: 'prep', gold: 5000 } });
    lot.update(1 / 60);
    expect(root.querySelector('#lot').classList.contains('up')).toBe(false);
    expect(lot.invoke()).toBe(false);
    expect(lot.preparingWave).toBeLessThan(FIRST_WAGER_WAVE);
  });
});

describe('the transaction', () => {
  it('takes the stake BEFORE any suspense, and only the stake', () => {
    mount({ state: { wave: 29, phase: 'prep', gold: 5000 } });
    lot.invoke();
    expect(game.spendGold).toHaveBeenCalledWith(150, 'lottery');
    expect(game.state.gold).toBe(5000 - 150);
    // Nothing has been paid yet: the overlay is still spinning.
    expect(game.addGold).not.toHaveBeenCalled();
    expect(lot.isOpen).toBe(true);
  });

  it('feeds the pot out of the stake, whatever the outcome', () => {
    mount();
    const before = lot.pot;
    lot.invoke();
    expect(lot.pot).toBe(before + potContribution(150));
  });

  it('freezes the phase so the prep clock cannot send the wave', () => {
    mount();
    lot.invoke();
    expect(game.state.phase).toBe('lottery');
    lot.close();
    expect(game.state.phase).toBe('prep');
  });

  it('refuses to open twice', () => {
    mount();
    expect(lot.invoke()).toBe(true);
    expect(lot.invoke()).toBe(false);
    expect(game.spendGold).toHaveBeenCalledTimes(1);
  });

  it('does not open at all if the debit is refused', () => {
    mount({ state: { wave: 29, phase: 'prep', gold: 5000 } });
    game.spendGold = vi.fn(() => false);
    expect(lot.invoke()).toBe(false);
    expect(lot.isOpen).toBe(false);
    expect(game.state.phase).toBe('prep');
    expect(lot.pot).toBe(0);
  });
});

describe('the outcome is decided before the animation, not by it', () => {
  /** What the pure rules say wave `n` pays on this seed. */
  const expected = (seed, n) => resolveLottery(rngFor(seed, 'lottery', n)());

  it('matches the pure resolution on every wave of the window', () => {
    for (const wave of [3, 12, 30, 44, 55]) {
      mount({ state: { wave: wave - 1, phase: 'prep', gold: 200000 } });
      lot.invoke();
      expect(lot._draw.outcome.id).toBe(expected(game.seed, wave).id);
      lot.destroy();
    }
  });

  it('escaping at frame one gives the same result as watching all 3.6 s', () => {
    const play = (escapeEarly) => {
      mount({ state: { wave: 29, phase: 'prep', gold: 5000 } });
      lot.invoke();
      const id = lot._draw.outcome.id;
      if (escapeEarly) {
        document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
      } else {
        run(4);
      }
      const gold = game.state.gold;
      lot.destroy();
      return { id, gold };
    };
    const fast = play(true);
    const slow = play(false);
    expect(fast.id).toBe(slow.id);
    expect(fast.gold).toBe(slow.gold);
  });

  it('a blur mid-spin resolves rather than stalling a frozen phase', () => {
    mount();
    lot.invoke();
    run(1.0);
    expect(lot.mode).toBe('spin');
    window.dispatchEvent(new Event('blur'));
    expect(lot.mode).toBe('result');
    expect(game.addGold).toHaveBeenCalledTimes(1);
  });

  it('the animation never consumes randomness of its own', () => {
    // Every frame of the spin is an interpolation toward a stored number. If a
    // future edit reached for the generator inside the loop, this would notice:
    // the needle's travel is a pure function of the clock and `u`.
    mount();
    lot.invoke();
    const u = lot._draw.u;
    run(2);
    expect(lot._draw.u).toBe(u);
    run(4);
    expect(lot._draw ?? { u }).toBeTruthy();
  });
});

describe('one credit, ever', () => {
  it('credits exactly once however many ways it is closed', () => {
    mount();
    lot.invoke();
    const payout = lot._draw.payout;
    // Every exit path, fired at once, in the order a panicking player produces.
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    root.querySelector('.ld-veil').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    lot.close();
    lot.close();
    expect(game.addGold).toHaveBeenCalledTimes(1);
    expect(game.addGold).toHaveBeenCalledWith(payout, 'lottery');
  });

  it('survives a click storm on the veil', () => {
    mount();
    lot.invoke();
    const veil = root.querySelector('.ld-veil');
    for (let i = 0; i < 40; i++) veil.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(game.addGold).toHaveBeenCalledTimes(1);
  });

  it('pays even when the overlay is closed mid-animation', () => {
    // The worst version of the bug: a stake taken and no payout given. There is
    // no exit from this overlay that does not settle first.
    mount();
    lot.invoke();
    const payout = lot._draw.payout;
    run(0.8);
    lot.close();
    expect(game.addGold).toHaveBeenCalledTimes(1);
    expect(game.addGold).toHaveBeenCalledWith(payout, 'lottery');
  });

  it('two wagers are two credits — no more, and no fewer', () => {
    // The complement of the tests above: the guard must stop a SECOND credit for
    // one draw without ever stopping the FIRST credit for the next one. A
    // `_credited` that failed to reset on open would pass every other test in
    // this block and silently eat every payout after the first.
    mount({ state: { wave: 29, phase: 'prep', gold: 500000 } });
    lot.invoke();
    const first = lot._draw.payout;
    finish();
    game.state.wave = 30;
    lot.invoke();
    const second = lot._draw.payout;
    finish();
    expect(game.addGold).toHaveBeenCalledTimes(2);
    expect(game.addGold.mock.calls.map((c) => c[0])).toEqual([first, second]);
  });

  it('a settle reached while the card is still up cannot pay twice', () => {
    // Escape reveals and credits; the card then sits there and every further
    // dismissal, click and auto-advance passes back through #settle.
    mount();
    lot.invoke();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    expect(lot.mode).toBe('result');
    expect(game.addGold).toHaveBeenCalledTimes(1);
    run(0.4);
    root.querySelector('.ld-veil').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    lot.close();
    expect(game.addGold).toHaveBeenCalledTimes(1);
  });

  it('the payout is exactly what the rules say, base plus pot', () => {
    mount({ state: { wave: 29, phase: 'prep', gold: 200000 } });
    lot.invoke();
    const d = lot._draw;
    expect(d.payout).toBe(d.base + d.potPaid);
    expect(d.base).toBe(Math.round(d.stake * d.outcome.mult));
    finish();
    expect(game.state.gold).toBe(200000 - d.stake + d.payout);
  });
});

describe('pot bookkeeping is conservative', () => {
  it('fed === paid + held after a full run of wagers', () => {
    mount({ state: { wave: FIRST_WAGER_WAVE - 1, phase: 'prep', gold: 5_000_000 } });
    for (let n = FIRST_WAGER_WAVE; n <= 55; n++) {
      game.state.wave = n - 1;
      expect(lot.invoke()).toBe(true);
      finish();
    }
    const b = lot.potBooks;
    expect(b.fed).toBe(b.paid + b.held);
    expect(b.held).toBeGreaterThanOrEqual(0);
    expect(b.fed).toBeGreaterThan(0);
  });

  it('empties the pot only on Convergence, and in full', () => {
    // SEED 7 IS CHOSEN, NOT ARBITRARY. Convergence is 2.5 % over 53 draws, so
    // roughly one run in four never sees one — the file's default seed is one of
    // those, and with it the pot-break branch below would be silently untested
    // while the test still passed. Seed 7 breaks the pot twice.
    mount({ seed: 7, state: { wave: FIRST_WAGER_WAVE - 1, phase: 'prep', gold: 5_000_000 } });
    let sawPot = false;
    for (let n = FIRST_WAGER_WAVE; n <= 55; n++) {
      game.state.wave = n - 1;
      const potBefore = lot.pot;
      lot.invoke();
      const d = lot._draw;
      const isPot = d.outcome.pot;
      finish();
      if (isPot) {
        sawPot = true;
        expect(lot.pot).toBe(0);
        expect(d.potPaid).toBe(potBefore + potContribution(d.stake));
      } else {
        expect(lot.pot).toBe(potBefore + potContribution(d.stake));
      }
    }
    // This seed does break the pot at least once; if it stopped doing so the
    // branch above would be silently untested, which is the failure this line
    // exists to prevent.
    expect(sawPot).toBe(true);
  });

  it('a run of wagers never leaves the player with negative gold', () => {
    mount({ state: { wave: FIRST_WAGER_WAVE - 1, phase: 'prep', gold: 5_000_000 } });
    for (let n = FIRST_WAGER_WAVE; n <= 55; n++) {
      game.state.wave = n - 1;
      lot.invoke();
      finish();
      expect(game.state.gold).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the keyboard shield', () => {
  it('swallows every game key while the draw is up', () => {
    mount();
    const seen = [];
    // Bound on window at the bubble phase, exactly like Game's own key handler
    // and BuildBar's — the layer the shield has to beat.
    const spy = (e) => seen.push(e.code);
    window.addEventListener('keydown', spy);
    lot.invoke();
    for (const code of ['Space', 'KeyP', 'Digit1', 'Digit2', 'KeyQ', 'KeyB', 'KeyF']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
    }
    window.removeEventListener('keydown', spy);
    expect(seen).toEqual([]);
  });

  it('lets modified keys and function keys through untouched', () => {
    mount();
    const seen = [];
    const spy = (e) => seen.push(e.code);
    window.addEventListener('keydown', spy);
    lot.invoke();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', metaKey: true, bubbles: true }));
    window.removeEventListener('keydown', spy);
    expect(seen).toEqual(['F9', 'KeyR']);
  });

  it('the hotkey opens the draw and is inert while it is open', () => {
    mount();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', bubbles: true, cancelable: true }));
    expect(lot.isOpen).toBe(true);
    expect(game.spendGold).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', bubbles: true, cancelable: true }));
    expect(game.spendGold).toHaveBeenCalledTimes(1);
  });

  it('the hotkey does nothing outside a prep', () => {
    mount({ state: { wave: 29, phase: 'combat', gold: 5000 } });
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', bubbles: true, cancelable: true }));
    expect(lot.isOpen).toBe(false);
    expect(game.spendGold).not.toHaveBeenCalled();
  });
});

describe('teardown', () => {
  it('leaves no listener behind after an open/close cycle', () => {
    mount();
    const c = census();
    try {
      lot.invoke();
      expect(lot.listenerCount).toBeGreaterThan(0);
      finish();
      expect(lot.isOpen).toBe(false);
      expect(lot.listenerCount).toBe(0);
      expect(c.live).toBe(0);
    } finally { c.restore(); }
  });

  it('leaves none behind across ten cycles either', () => {
    mount({ state: { wave: 29, phase: 'prep', gold: 500000 } });
    const c = census();
    try {
      for (let i = 0; i < 10; i++) {
        game.state.wave = 29 + i;
        lot.invoke();
        finish();
      }
      expect(c.live).toBe(0);
      expect(lot.listenerCount).toBe(0);
    } finally { c.restore(); }
  });

  it('destroy removes both surfaces and the hotkey', () => {
    mount();
    lot.invoke();
    lot.destroy();
    expect(root.querySelector('#lotdraw')).toBeNull();
    expect(root.querySelector('#lot')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', bubbles: true }));
    expect(game.spendGold).toHaveBeenCalledTimes(1);
    lot = null;
  });
});

describe('the dev hook published in docs/MINIGAMES.md', () => {
  it('exists with the exact shape the dev panel duck-types', () => {
    mount();
    expect(typeof lot.devOpen).toBe('function');
  });

  it('forces a draw for an arbitrary wave, past every gate', () => {
    mount({ state: { wave: 40, phase: 'combat', gold: 100000 } });
    expect(lot.devOpen(7)).toBe(true);
    expect(lot._draw.wave).toBe(7);
    expect(lot._draw.stake).toBe(stakeFor(7));
    expect(lot._draw.outcome.id).toBe(resolveLottery(rngFor(game.seed, 'lottery', 7)()).id);
    lot.close();
    expect(game.state.phase).toBe('combat');   // put back exactly what it took
  });

  it('still refuses to pay out of an empty bank', () => {
    mount({ state: { wave: 40, phase: 'prep', gold: 3 } });
    expect(lot.devOpen(40)).toBe(false);
    expect(lot.isOpen).toBe(false);
    expect(game.hud.warn).toHaveBeenCalled();
  });

  it('clamps a nonsense wave rather than throwing', () => {
    mount({ state: { wave: 10, phase: 'prep', gold: 100000 } });
    expect(lot.devOpen(9999)).toBe(true);
    expect(lot._draw.wave).toBe(55);
  });
});

describe('the clock', () => {
  it('reveals on its own and closes on its own', () => {
    mount();
    lot.invoke();
    run(3.0);
    expect(lot.mode).toBe('spin');
    run(1.0);
    expect(lot.mode).toBe('result');
    run(4.0);
    expect(lot.isOpen).toBe(false);
  });

  it('a two-second stall advances at most 100 ms, like Game.frame', () => {
    mount();
    lot.invoke();
    lot.update(2.0);
    expect(lot.mode).toBe('spin');
    expect(lot._t).toBeLessThanOrEqual(0.1);
  });

  it('never runs at 2x because the speed buttons are on 2x', () => {
    // The overlay is driven from the variable-rate half of Game.frame with the
    // raw dt, so state.speed cannot reach it. Asserted by construction: update
    // takes seconds and reads nothing from state.
    mount({ state: { wave: 29, phase: 'prep', gold: 5000, speed: 3 } });
    lot.invoke();
    run(3.0);
    expect(lot.mode).toBe('spin');
  });
});
