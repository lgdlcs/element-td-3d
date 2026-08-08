/**
 * The Rite of Fortune, in a real browser.
 *
 * The rules have a node suite (tests/unit/lottery.test.js) and the surface has a
 * jsdom one (tests/unit/lottery-host.test.js). What only a browser can answer:
 *
 *  - does the rail seal actually stack under #threat, at the same width, and
 *    does it leave the rail when the phase does;
 *  - does the keyboard shield really beat Game.js's own window listener in the
 *    live capture order — Space behind this veil sends the next wave otherwise,
 *    which is the incident documented at HUD.js's `_onKeyShield`;
 *  - does the ring actually draw pixels, which jsdom can never tell us because
 *    it has no canvas backend at all;
 *  - does 3.6 s of animation run without putting anything on the console.
 *
 * It deliberately does not re-test the payout maths, which is cheaper and far
 * stricter in node.
 */

import { test, expect } from '@playwright/test';
import { startRun, settle } from './helpers.js';

const host = (page, fn, arg) => page.evaluate(fn, arg);

/**
 * Wait for the draw to be SHUT.
 *
 * Not `waitForSelector('#lotdraw:not(.open)')`. That selector matches the moment
 * the class comes off, but Playwright's default state is `visible` and a shut
 * overlay is `display: none` — so the wait hangs for the full timeout on an
 * element that satisfied the selector 229 polls ago. Measured, and it cost two
 * minutes per retry before it was understood.
 */
const closed = (page, timeout = 10000) => page.waitForFunction(
  () => !document.getElementById('lotdraw').classList.contains('open'), null, { timeout });

/** Put the run into a prep the lottery will accept, with money in the bank. */
async function prep(page, { wave = 30, gold = 5000 } = {}) {
  await page.evaluate(({ wave, gold }) => {
    const g = window.__game;
    g.state.wave = wave - 1;
    g.state.phase = 'prep';
    g.state.gold = gold;
    g.hud._goldShown = gold;
    g.lottery._wageredWave = null;
  }, { wave, gold });
  await page.waitForSelector('#lot.up', { timeout: 5000 });
  // The class is on; the card is still sliding in for --t-slow. Every geometry
  // assertion below has to wait that out or it measures a card in flight.
  await settle(page, 500);
}

test.describe('the lottery', () => {
  test('the seal sits on the rail, under #threat, at the same width', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 5000 });
    await prep(page);

    const box = await page.evaluate(() => {
      const t = document.getElementById('threat').getBoundingClientRect();
      const l = document.getElementById('lot').getBoundingClientRect();
      return { t: { x: t.x, w: t.width, bottom: t.bottom }, l: { x: l.x, w: l.width, top: l.top } };
    });
    // Same column, same width, below and not overlapping. Art Bible: the edges,
    // never the middle, at rest.
    expect(box.l.w).toBe(box.t.w);
    expect(box.l.x).toBe(box.t.x);
    expect(box.l.top).toBeGreaterThanOrEqual(box.t.bottom);
    expect(box.l.top - box.t.bottom).toBeLessThan(24);
    expect(errors).toEqual([]);
  });

  test('the seal leaves the rail outside a prep, and comes back', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 5000 });
    await prep(page);
    expect(await host(page, () => document.getElementById('lot').classList.contains('up'))).toBe(true);

    await page.evaluate(() => { window.__game.state.phase = 'combat'; });
    await page.waitForFunction(() => !document.getElementById('lot').classList.contains('up'));
    // The class comes off instantly, the card takes --t-slow to leave. Reading
    // the rect on the same tick catches it mid-flight at x=+58, which is a real
    // measurement of a real transition and not a bug — so wait it out.
    await settle(page, 500);
    // It really is off the rail, not merely faded: the transform takes it out.
    const off = await host(page, () => document.getElementById('lot').getBoundingClientRect().right);
    expect(off).toBeLessThanOrEqual(0);

    await page.evaluate(() => { window.__game.state.phase = 'prep'; });
    await page.waitForSelector('#lot.up');
    expect(errors).toEqual([]);
  });

  test('the dev hook opens the draw at an arbitrary wave', async ({ page }) => {
    // The exact call DevPanel duck-types, published in docs/MINIGAMES.md §10.
    const { errors } = await startRun(page, { gold: 20000 });
    const opened = await host(page, () => window.__game.lottery.devOpen(44));
    expect(opened).toBe(true);
    await page.waitForSelector('#lotdraw.open');
    expect(await host(page, () => window.__game.lottery._draw.wave)).toBe(44);
    expect(await host(page, () => window.__game.lottery._draw.stake)).toBe(400);
    await page.evaluate(() => window.__game.lottery.close());
    expect(errors).toEqual([]);
  });

  test('clicking Invoke takes the stake, opens the veil, freezes the phase', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 5000, freeze: false });
    await prep(page, { wave: 30, gold: 5000 });

    await page.click('#lot-go');
    await page.waitForSelector('#lotdraw.open');

    const s = await host(page, () => ({
      phase: window.__game.state.phase,
      gold: window.__game.state.gold,
      spent: window.__game.state.goldSpent.lottery,
      earned: window.__game.state.goldEarned.lottery,
      pot: window.__game.lottery.pot,
    }));
    // The price is paid before the suspense; nothing has been credited yet.
    expect(s.phase).toBe('lottery');
    expect(s.spent).toBe(150);
    expect(s.gold).toBe(5000 - 150);
    expect(s.earned).toBeUndefined();
    expect(s.pot).toBe(15);
    // A frozen phase is what stops the prep clock sending the wave from behind
    // the veil during the 3.6 s draw.
    const t0 = await host(page, () => window.__game.state.prepTimer);
    await settle(page, 700);
    expect(await host(page, () => window.__game.state.prepTimer)).toBe(t0);

    await closed(page, 15000);
    expect(await host(page, () => window.__game.state.phase)).toBe('prep');
    expect(errors).toEqual([]);
  });

  test('the ring is really drawn — the canvas is not blank', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 20000 });
    await host(page, () => window.__game.lottery.devOpen(44));
    await page.waitForSelector('#lotdraw.open');
    await settle(page, 700);

    const ink = await page.evaluate(() => {
      const c = document.getElementById('lotdraw-canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++;
      return { lit, total: d.length / 4, w: c.width, h: c.height };
    });
    expect(ink.w).toBeGreaterThan(100);
    // A ring plus a needle plus labels: a few per cent of the stage, not zero
    // and not a filled rectangle. Both bounds matter — a cleared canvas and a
    // canvas painted solid by a bad transform both look like "it drew" to a
    // test that only checks for non-zero.
    expect(ink.lit / ink.total).toBeGreaterThan(0.005);
    expect(ink.lit / ink.total).toBeLessThan(0.5);
    await page.evaluate(() => window.__game.lottery.close());
    expect(errors).toEqual([]);
  });

  test('the needle stops on the arc the seed named', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 200000 });
    // The presentation claim in one assertion: the ring is the cumulative walk,
    // so the needle's resting fraction of a turn IS `u`, and the arc it lands in
    // is the outcome the pure resolver returns for that same `u`.
    const r = await page.evaluate(async () => {
      const l = window.__game.lottery;
      l.devOpen(44);
      const { resolveLottery, outcomeBands } = await import('/src/game/lottery.js');
      const u = l._draw.u;
      const band = outcomeBands().find((b) => u >= b.from && u < b.to);
      return { landed: band.o.id, resolved: resolveLottery(u).id, drawn: l._draw.outcome.id };
    });
    expect(r.landed).toBe(r.resolved);
    expect(r.drawn).toBe(r.resolved);
    await page.evaluate(() => window.__game.lottery.close());
    expect(errors).toEqual([]);
  });

  test('the keyboard shield beats Game.js — Space does not send the wave', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 20000, freeze: false });
    await prep(page, { wave: 30, gold: 20000 });
    await host(page, () => window.__game.lottery.devOpen(30));
    await page.waitForSelector('#lotdraw.open');

    const before = await host(page, () => ({
      wave: window.__game.state.wave,
      speed: window.__game.state.speed,
      paused: window.__game.state.paused,
    }));
    // Every key that does something destructive from behind a veil.
    for (const k of ['Space', 'p', '2', '3']) await page.keyboard.press(k);
    await settle(page, 250);
    const after = await host(page, () => ({
      wave: window.__game.state.wave,
      speed: window.__game.state.speed,
      paused: window.__game.state.paused,
      phase: window.__game.state.phase,
    }));
    expect(after.wave).toBe(before.wave);
    expect(after.speed).toBe(before.speed);
    expect(after.paused).toBe(before.paused);
    // Space also means "reveal now" in here, so the draw resolved instead.
    expect(await host(page, () => window.__game.lottery.mode)).toBe('result');
    await page.evaluate(() => window.__game.lottery.close());
    expect(errors).toEqual([]);
  });

  test('Escape resolves immediately and pays exactly what the seed decided', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 20000 });
    const gold0 = await host(page, () => window.__game.state.gold);
    await host(page, () => window.__game.lottery.devOpen(44));
    await page.waitForSelector('#lotdraw.open');
    const draw = await host(page, () => ({ ...window.__game.lottery._draw, outcome: undefined }));

    await page.keyboard.press('Escape');
    await page.waitForSelector('#lotdraw-result:not([hidden])');
    const gold1 = await host(page, () => window.__game.state.gold);
    expect(gold1).toBe(gold0 - draw.stake + draw.payout);

    // Escape again closes; neither press can pay twice.
    await page.keyboard.press('Escape');
    await closed(page);
    expect(await host(page, () => window.__game.state.gold)).toBe(gold1);
    expect(await host(page, () => window.__game.state.goldEarned.lottery)).toBe(draw.payout);
    expect(errors).toEqual([]);
  });

  test('a click storm on the veil pays exactly once', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 20000 });
    const gold0 = await host(page, () => window.__game.state.gold);
    await host(page, () => window.__game.lottery.devOpen(44));
    await page.waitForSelector('#lotdraw.open');
    const draw = await host(page, () => ({ stake: window.__game.lottery._draw.stake,
      payout: window.__game.lottery._draw.payout }));

    // Dispatched rather than driven through page.click, and the reason is the
    // behaviour under test: click one reveals, click two closes, and from click
    // three the veil is display:none — so a real click storm can only land two
    // clicks before Playwright refuses an invisible target. Dispatching hits the
    // same delegated listener twelve times regardless of what is on screen,
    // which is the harsher version of the same question.
    await page.evaluate(() => {
      const veil = document.querySelector('#lotdraw .ld-veil');
      for (let i = 0; i < 12; i++) veil.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle(page, 300);
    expect(await host(page, () => window.__game.state.goldEarned.lottery)).toBe(draw.payout);
    expect(await host(page, () => window.__game.state.gold)).toBe(gold0 - draw.stake + draw.payout);
    expect(errors).toEqual([]);
  });

  test('one wager per prep, and the seal says so', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 20000 });
    await prep(page, { wave: 30, gold: 20000 });
    await page.click('#lot-go');
    await page.waitForSelector('#lotdraw.open');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await closed(page);

    await expect(page.locator('#lot-go')).toBeDisabled();
    await expect(page.locator('#lot-go-label')).toHaveText('Spent');
    const spentOnce = await host(page, () => window.__game.state.goldSpent.lottery);
    // The hotkey must not find a way past the button's own refusal.
    await page.keyboard.press('l');
    await settle(page, 200);
    expect(await host(page, () => window.__game.state.goldSpent.lottery)).toBe(spentOnce);
    expect(await host(page, () => document.getElementById('lotdraw').classList.contains('open'))).toBe(false);

    // Next prep, next wager.
    await page.evaluate(() => { window.__game.state.wave = 30; });
    await expect(page.locator('#lot-go')).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test('the seal refuses when the reserve is thin, and says why', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 20000 });
    await prep(page, { wave: 30, gold: 299 });     // stake 150, needs 300
    await expect(page.locator('#lot-go')).toBeDisabled();
    await expect(page.locator('#lot-note')).toContainText('Reserve');
    await page.keyboard.press('l');
    await settle(page, 200);
    expect(await host(page, () => window.__game.state.goldSpent.lottery)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('the full 3.6 s draw runs clean and leaves no listeners behind', async ({ page }) => {
    // `warnings` is deliberately NOT asserted empty: the page already emits a
    // pre-existing "THREE.Clock has been deprecated" on boot, which has nothing
    // to do with the wager. `errors` is the assertion that does work here.
    const { errors } = await startRun(page, { gold: 20000, freeze: false });
    await host(page, () => window.__game.lottery.devOpen(44));
    await page.waitForSelector('#lotdraw.open');
    // Watch the whole thing, including the result card's auto-advance.
    await closed(page, 20000);
    expect(await host(page, () => window.__game.lottery.listenerCount)).toBe(0);
    expect(await host(page, () => window.__game.state.phase)).toBe('prep');
    expect(errors).toEqual([]);
  });

  test('a whole run of wagers never double-credits and never desyncs', async ({ page }) => {
    const { errors } = await startRun(page, { gold: 500000, freeze: false });
    const r = await page.evaluate(async () => {
      const g = window.__game;
      const l = g.lottery;
      const { resolveLottery, stakeFor, potContribution } = await import('/src/game/lottery.js');
      const { rngFor } = await import('/src/core/Rng.js');
      let staked = 0, expectedPayout = 0, pot = 0;
      for (let n = 3; n <= 55; n++) {
        l.devOpen(n);
        const d = l._draw;
        // Independently recompute what the rules say, from the seed, in page.
        const o = resolveLottery(rngFor(g.seed, 'lottery', n)());
        pot += potContribution(stakeFor(n));
        const want = Math.round(stakeFor(n) * o.mult) + (o.pot ? pot : 0);
        if (o.pot) pot = 0;
        if (d.outcome.id !== o.id || d.payout !== want) {
          return { mismatch: { n, got: d.outcome.id, want: o.id, gotPay: d.payout, wantPay: want } };
        }
        staked += d.stake;
        expectedPayout += d.payout;
        l.close();          // settles on the way out
      }
      const b = l.potBooks;
      return {
        staked, expectedPayout,
        spent: g.state.goldSpent.lottery,
        earned: g.state.goldEarned.lottery,
        books: b,
      };
    });
    expect(r.mismatch).toBeUndefined();
    // 53 wagers, 53 debits, 53 credits, no more.
    expect(r.spent).toBe(r.staked);
    expect(r.earned).toBe(r.expectedPayout);
    // Nothing created, nothing lost.
    expect(r.books.fed).toBe(r.books.paid + r.books.held);
    // And the house edge is real, over the whole run.
    expect(r.earned).toBeLessThan(r.spent);
    expect(errors).toEqual([]);
  });

  test('two games on one seed draw the identical 53-wager sequence', async ({ page }) => {
    const { errors } = await startRun(page);
    const seq = await page.evaluate(async () => {
      const { resolveLottery } = await import('/src/game/lottery.js');
      const { rngFor } = await import('/src/core/Rng.js');
      const run = (seed) => Array.from({ length: 53 }, (_, i) =>
        resolveLottery(rngFor(seed, 'lottery', i + 3)()).id);
      return { a: run(4242), b: run(4242), c: run(4243) };
    });
    expect(seq.a).toEqual(seq.b);
    expect(seq.a).not.toEqual(seq.c);
    expect(errors).toEqual([]);
  });
});
