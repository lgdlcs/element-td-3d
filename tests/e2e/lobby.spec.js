import { test, expect } from '@playwright/test';
import { bootGame, settle } from './fixtures.js';

/**
 * The lobby as it stands TODAY, before any leaderboard work lands on it.
 *
 * Reaching it at all takes `?mp`: under Playwright main.js skips the lobby
 * (navigator.webdriver) and boots straight into a solo run, and `?mp` is the
 * documented override that keeps the overlay testable.
 *
 * WHAT THIS SPEC WILL AND WILL NOT ASSERT. Whether a multiplayer server answers
 * on 5274 is a property of the machine the suite runs on, not of the build, so
 * nothing here asserts "offline". It asserts the parts that hold either way: the
 * markup, that the run has NOT begun while the overlay is up, that the
 * connection attempt settles out of 'connecting', that the state class matches
 * whichever way it settled, and that Play solo works regardless. The
 * server-specific branch is asserted only once it is known which branch was
 * taken.
 */

/**
 * Console errors that are the app's fault.
 *
 * When nothing is listening on 5274, Chromium itself logs the refused handshake
 * at error level ("WebSocket connection to '...' failed"). That line is emitted
 * by the network stack, not by any code in this repo, and NetClient's whole
 * contract is that it survives it — connect() resolves false and the lobby shows
 * the offline card. Filtering it is the only way "no JS errors" can mean
 * anything on a machine with no server; every other error still fails the test.
 */
const appErrors = (errors) =>
  errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));

test.describe('lobby', () => {
  test('shows the entry screen and holds the run back until a choice is made', async ({ page }) => {
    const { errors } = await bootGame(page, { query: 'mp' });

    // The overlay is up...
    await expect(page.locator('#lobby')).toBeVisible();
    await expect(page.locator('#lobby')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#lobby-title')).toHaveText('Shared Convergence');

    // ...and nothing has started behind it.
    const s = await page.evaluate(() => {
      const g = window.__game;
      return {
        phase: g.state.phase,
        wave: g.state.wave,
        elements: g.state.elements.length,
        pending: g.state.pendingElementPicks,
        begun: !!g._begun,
      };
    });
    expect(s.phase).toBe('lobby');
    expect(s.wave).toBe(0);
    expect(s.elements).toBe(0);
    expect(s.pending).toBe(0);
    expect(s.begun).toBe(false);
    await expect(page.locator('#picker')).not.toHaveClass(/\bopen\b/);

    // The controls the entry screen offers today.
    await expect(page.locator('#lobby-name')).toHaveCount(1);
    await expect(page.locator('#lobby-create')).toHaveCount(1);
    await expect(page.locator('#lobby-code-in')).toHaveCount(1);
    await expect(page.locator('#lobby-join')).toHaveCount(1);
    await expect(page.locator('#lobby-solo')).toBeVisible();
    await expect(page.locator('#lobby-conn')).toHaveCount(1);
    // A name is pre-filled so the whole flow is Enter-Enter.
    expect((await page.inputValue('#lobby-name')).length).toBeGreaterThan(0);
    await expect(page.locator('#lobby-name-note')).toContainText('characters');

    // FREEZE MARK, UPDATED. This used to assert that no scoreboard existed on
    // the lobby; the Hall of Records now does, so the mark records what the
    // overlay is made of instead. The distinction matters: `.lobby-card` is the
    // set of MUTUALLY EXCLUSIVE state cards that the `.s-*` rules show one of at
    // a time, and the hall is none of them — it is `.hall-card`, visible across
    // states, sitting in the gutter beside the plate. Adding a fourth state card
    // is a change to the state machine and should fail here; adding a panel
    // beside the plate is not. tests/e2e/lobby-hall.spec.js owns the hall itself.
    await expect(page.locator('#lobby .lobby-card')).toHaveCount(3);   // entry, room, offline
    await expect(page.locator('#lobby .hall-card')).toHaveCount(1);    // the hall
    await expect(page.locator('#lobby-hall')).toBeVisible();

    // The connection attempt always settles (NetClient.connect never hangs).
    await expect.poll(
      () => page.evaluate(() => window.__lobby?.state),
      { message: 'the lobby never left the connecting state', timeout: 20000 },
    ).not.toBe('connecting');

    const settledState = await page.evaluate(() => window.__lobby.state);
    expect(['idle', 'offline', 'lobby']).toContain(settledState);
    await expect(page.locator('#lobby')).toHaveClass(new RegExp(`\\bs-${settledState}\\b`));

    if (settledState === 'offline') {
      // No server on 5274: the offline card explains itself and multiplayer is
      // shut off, but solo stays reachable.
      await expect(page.locator('#lobby-offline')).toBeVisible();
      await expect(page.locator('#lobby-offline')).toContainText('npm run server');
      await expect(page.locator('#lobby-create')).toBeDisabled();
      await expect(page.locator('#lobby-solo')).toBeEnabled();
    } else {
      await expect(page.locator('#lobby-create')).toBeEnabled();
    }

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('the lobby swallows game hotkeys while it is up', async ({ page }) => {
    const { errors } = await bootGame(page, { query: 'mp' });
    await expect(page.locator('#lobby')).toBeVisible();

    // Focus always starts inside the overlay (Lobby.#focusFirst), which is what
    // makes the aria-modal claim true.
    //
    // POLLED, AND THE ONE FRAME IS THE WHOLE REASON. #focusFirst does not call
    // focus() — it schedules it: `requestAnimationFrame(() => target.focus())`,
    // because "a focus() during the same frame as `hidden = false` is dropped by
    // Chrome" (Lobby.js:862). toBeVisible() resolves as soon as the element is
    // laid out, which is exactly the frame BEFORE the one that focuses, so a
    // one-shot read was racing a deferral the source documents. It lost about
    // one run in three and passed on retry, which docs/TESTING.md is explicit is
    // a broken spec rather than an acceptable one.
    //
    // The claim is unchanged and can still fail: focus that never lands inside
    // the overlay still red-lines this line. Only "lands one frame later than
    // the assertion looked" stops counting as a failure. #focusFirst also
    // re-targets on the connection verdict ($solo when offline, $name otherwise),
    // which is a second, later frame in which activeElement legitimately moves —
    // and it moves between two nodes that are both inside #lobby, so the
    // predicate below holds across it.
    await expect.poll(
      () => page.evaluate(() => document.activeElement?.closest('#lobby') !== null),
      { message: 'focus never landed inside the lobby overlay' },
    ).toBe(true);

    // Then drop it, so what is measured below is the document-level key shield
    // and not ordinary button behaviour. NOTE, because it surprises people: the
    // shield calls stopPropagation but not preventDefault, so while the offline
    // state has "Play solo" focused, pressing Space genuinely activates that
    // button and starts the run. That is the browser doing what a focused button
    // does — it is not a hotkey leaking through.
    await page.evaluate(() => document.activeElement?.blur());

    // F would toggle the tower table and Space would queue a wave if either
    // reached the listeners behind the veil.
    await page.keyboard.press('f');
    await page.keyboard.press('Space');
    await settle(page, 250);

    await expect(page.locator('#codex')).not.toHaveClass(/\bopen\b/);
    await expect(page.locator('#lobby')).toBeVisible();
    expect(await page.evaluate(() => window.__game.state.phase)).toBe('lobby');
    expect(await page.evaluate(() => window.__game.state.wave)).toBe(0);

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('Play solo starts the run and takes the overlay away', async ({ page }) => {
    const { errors } = await bootGame(page, { query: 'mp' });

    // Wait for the connection attempt to settle first, or the click races the
    // state machine that is still deciding what to show.
    await expect.poll(
      () => page.evaluate(() => window.__lobby?.state),
      { timeout: 20000 },
    ).not.toBe('connecting');

    await page.click('#lobby-solo');

    await expect(page.locator('#lobby')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__game.state.phase)).toBe('pickElement');
    // The run opens on the free element pick, exactly as it does in solo.
    await expect(page.locator('#picker')).toHaveClass(/\bopen\b/);
    await expect(page.locator('#picker-cards .pcard')).toHaveCount(3);
    expect(await page.evaluate(() => window.__game.state.pendingElementPicks)).toBe(1);
    expect(await page.evaluate(() => window.__game.state.gold)).toBe(275);

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });
});
