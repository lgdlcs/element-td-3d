import { test, expect } from '@playwright/test';
import { bootGame, settle, fakeRoomServer } from './fixtures.js';

/**
 * The lobby as it stands TODAY, before any leaderboard work lands on it.
 *
 * Reaching it at all takes `?mp`: under Playwright main.js skips the lobby
 * (navigator.webdriver) and boots straight into a solo run, and `?mp` is the
 * documented override that keeps the overlay testable.
 *
 * No spec here talks to a real server. The 'lobby' describe answers through
 * fakeRoomServer, so it always settles on 'idle'; 'lobby offline' closes every
 * socket at once, so it always settles on 'offline'. Whatever is listening on
 * 5274 (often someone's live game) is never contacted.
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
  // Hermetic: whatever server is listening on 5274 (often someone's live game)
  // is never contacted, and the lobby settles on 'idle' in one round trip.
  test.beforeEach(({ page }) => fakeRoomServer(page));

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

    expect(await page.evaluate(() => window.__lobby.state)).toBe('idle');
    await expect(page.locator('#lobby')).toHaveClass(/\bs-idle\b/);
    await expect(page.locator('#lobby-create')).toBeEnabled();

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

test.describe('lobby offline', () => {
  // Every socket is closed the moment it opens, which NetClient.connect
  // resolves as offline (see the instant-close case in main.js openLobby).
  test.beforeEach(({ page }) => page.routeWebSocket('**/ws', (ws) => ws.close()));

  test('with no server the offline card explains itself and solo stays reachable', async ({ page }) => {
    const { errors } = await bootGame(page, { query: 'mp' });
    await expect.poll(
      () => page.evaluate(() => window.__lobby?.state),
      { message: 'the lobby never settled offline', timeout: 20000 },
    ).toBe('offline');
    await expect(page.locator('#lobby')).toHaveClass(/\bs-offline\b/);
    await expect(page.locator('#lobby-offline')).toBeVisible();
    await expect(page.locator('#lobby-offline')).toContainText('npm run server');
    await expect(page.locator('#lobby-create')).toBeDisabled();
    await expect(page.locator('#lobby-solo')).toBeEnabled();

    await page.click('#lobby-solo');
    await expect(page.locator('#lobby')).toBeHidden();
    expect(await page.evaluate(() => window.__game.mode)).toBe('solo');

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });
});

/**
 * Speed and pause are solo only (src/game/runMode.js). Online, one player at 3x
 * makes the room wait for `over`, and one player on pause holds it open for
 * good. These reach a real online run through fakeRoomServer, so no server on
 * the machine is needed or touched.
 */
test.describe('run mode', () => {
  const speedOf = (page) => page.evaluate(() => window.__game.state.speed);
  const pausedOf = (page) => page.evaluate(() => window.__game.state.paused);

  async function enterRoom(page) {
    const server = await fakeRoomServer(page);
    const handles = await bootGame(page, { query: 'mp' });
    await expect.poll(() => page.evaluate(() => window.__lobby?.state), { timeout: 20000 }).toBe('idle');
    await page.click('#lobby-create');
    await expect.poll(() => page.evaluate(() => window.__lobby.state)).toBe('lobby');
    return { server, ...handles };
  }

  async function startOnline(page) {
    await page.click('#lobby-ready');
    await page.click('#lobby-start');
    await expect.poll(() => page.evaluate(() => window.__game.mode)).toBe('online');
  }

  // Binds the first element through the game, like helpers.startRun, so the
  // keys below reach Game rather than the element picker.
  async function bindFire(page) {
    await page.evaluate(() => {
      const g = window.__game;
      g.state.pendingElementPicks = 1;
      g.chooseElement('fire');
    });
    await expect(page.locator('#picker')).not.toHaveClass(/\bopen\b/);
  }

  test('online: 1/2/3, the speed buttons and P do nothing', async ({ page }) => {
    const { server, errors } = await enterRoom(page);
    await startOnline(page);
    await bindFire(page);

    const buttons = page.locator('#speed-buttons button');
    await expect(buttons).toHaveCount(3);
    for (const n of [1, 2, 3]) {
      const b = page.locator(`#speed-buttons button[data-speed="${n}"]`);
      await expect(b).toBeDisabled();
      await expect(b).toHaveAttribute('title', /^Solo only/);
    }
    await expect(page.locator('#pause-btn')).toBeDisabled();
    await expect(page.locator('#pause-btn')).toHaveAttribute('title', /^Solo only/);

    await page.keyboard.press('3');
    await page.keyboard.press('2');
    await page.keyboard.press('p');
    await settle(page, 200);
    expect(await speedOf(page)).toBe(1);
    expect(await pausedOf(page)).toBe(false);
    // The console is a caller too.
    expect(await page.evaluate(() => window.__game.setSpeed(3))).toBe(false);
    expect(await page.evaluate(() => window.__game.togglePause())).toBe(false);
    expect(await speedOf(page)).toBe(1);

    // The page told the server it was racing: status frames flow while unpaused.
    await expect.poll(() => server.received.some((m) => m.t === 'status')).toBe(true);

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('online: a lost connection says so, hides the scoreboard, and keeps 1x', async ({ page }) => {
    const { server, errors } = await enterRoom(page);
    await startOnline(page);
    await bindFire(page);
    const rival = { id: 'p2', name: 'Rival', host: false, ready: true, lives: 50, score: 0, wave: 1, killed: 0, leaked: 0 };
    const me = { ...rival, id: 'p1', name: 'Me', host: true };
    server.send({ t: 'scores', players: [me, rival] });
    await expect(page.locator('#scoreboard')).toBeVisible();

    await server.drop();

    await expect(page.locator('#toast')).toContainText('Connection lost');
    await expect(page.locator('#scoreboard')).toBeHidden();
    expect(await page.evaluate(() => window.__game.mode)).toBe('online');
    await page.keyboard.press('3');
    await settle(page, 100);
    expect(await speedOf(page)).toBe(1);

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('online: a drop after over keeps the final standings on screen', async ({ page }) => {
    const { server, errors } = await enterRoom(page);
    await startOnline(page);
    await bindFire(page);
    const rival = { id: 'p2', name: 'Rival', host: false, ready: true, lives: 50, score: 10, wave: 3, killed: 0, leaked: 0 };
    const me = { ...rival, id: 'p1', name: 'Me', host: true, score: 20 };
    server.send({ t: 'over', standings: [me, rival] });
    await expect(page.locator('#scoreboard')).toContainText('Final standings');
    await expect(page.locator('#scoreboard')).toBeVisible();

    await server.drop();
    await settle(page, 500);

    await expect(page.locator('#scoreboard')).toHaveClass(/\bon\b/);
    await expect(page.locator('#scoreboard')).toContainText('Final standings');
    await expect(page.locator('#toast')).not.toContainText('Connection lost');

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('Play solo from inside a room leaves it, and speed and pause work', async ({ page }) => {
    const { server, errors } = await enterRoom(page);
    await page.click('#lobby-solo');
    await expect(page.locator('#lobby')).toBeHidden();
    await expect.poll(() => server.received.map((m) => m.t)).toContain('leave');
    expect(await page.evaluate(() => window.__game.mode)).toBe('solo');
    await bindFire(page);

    await expect(page.locator('#speed-buttons button[data-speed="3"]')).toBeEnabled();
    await expect(page.locator('#speed-buttons button[data-speed="3"]')).toHaveAttribute('title', 'Triple speed · key 3');
    await page.keyboard.press('3');
    await expect.poll(() => speedOf(page)).toBe(3);
    await page.locator('#speed-buttons button[data-speed="2"]').click();
    await expect.poll(() => speedOf(page)).toBe(2);
    await page.keyboard.press('p');
    await expect.poll(() => pausedOf(page)).toBe(true);
    await page.locator('#pause-btn').click();
    await expect.poll(() => pausedOf(page)).toBe(false);

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });
});
