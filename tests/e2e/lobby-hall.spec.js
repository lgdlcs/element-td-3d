import { test, expect } from '@playwright/test';
import { bootGame, settle } from './fixtures.js';

/**
 * THE HALL OF RECORDS — the scoreboard beside the lobby plate.
 *
 * THE CASE THIS FILE IS REALLY ABOUT IS THE ONE WITH NO SERVER. That is the
 * normal state of a dev machine and of anyone's first evening with the game, and
 * a panel whose whole subject is "the global board" has to read as a fact about
 * the world rather than as something broken. So: no exception, no spinner that
 * never ends, no `undefined` on screen, and the local record — the one number
 * that exists without a network — as the headline.
 *
 * Reaching the lobby at all takes `?mp`: under Playwright main.js skips it
 * (navigator.webdriver) and boots straight into a solo run.
 *
 * As in lobby.spec.js, whether something answers on 5274 is a property of the
 * machine and not of the build, so the server-specific branch is only asserted
 * once it is known which branch was taken.
 */

/** Chromium logs the refused handshake itself; NetClient's contract is to survive it. */
const appErrors = (errors) => errors.filter((e) => !/WebSocket connection to .* failed/i.test(e));

/** BestScore.js's storage key and record shape. */
const BEST_KEY = 'elementtd.best.v1';

/** Seed a personal best BEFORE the page loads — Lobby reads it in its constructor. */
const seedBest = (page, best) =>
  page.addInitScript(([k, v]) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ }
  }, [BEST_KEY, best]);

/** Wait for NetClient to stop deciding, whichever way it lands. */
const settleConnection = (page) => expect.poll(
  () => page.evaluate(() => window.__lobby?.state),
  { message: 'the lobby never left the connecting state', timeout: 20000 },
).not.toBe('connecting');

test.describe('lobby hall', () => {
  test('is on screen at load, with a clean empty state and no undefined anywhere', async ({ page }) => {
    await page.addInitScript((k) => { try { localStorage.removeItem(k); } catch { /* */ } }, BEST_KEY);
    const { errors } = await bootGame(page, { query: 'mp' });

    await expect(page.locator('#lobby')).toBeVisible();
    await expect(page.locator('#lobby-hall')).toBeVisible();
    await expect(page.locator('#lobby-hall-title')).toHaveText('Hall of Records');

    // The headline exists before anything has been played or connected.
    await expect(page.locator('#lobby-hall-best')).toBeVisible();
    await expect(page.locator('#lobby-hall-best .hb-k')).toHaveText('Your best');
    await expect(page.locator('#lobby-hall-best .hb-v')).toHaveText('—');
    await expect(page.locator('#lobby-hall-best .hb-v')).toHaveClass(/\bnone\b/);
    await expect(page.locator('#lobby-hall-best')).toContainText('no run finished on this machine yet');

    await settleConnection(page);
    // Give the panel a beat past the connection verdict; the note and the status
    // are rewritten from #hall() on that transition.
    await settle(page, 300);

    const hall = await page.evaluate(() => {
      const root = document.getElementById('lobby');
      const el = document.getElementById('lobby-hall');
      return {
        state: root.dataset.hall,
        status: document.getElementById('lobby-hall-status').textContent.trim(),
        note: document.getElementById('lobby-hall-note').textContent.trim(),
        rows: document.querySelectorAll('#lobby-hall-list .hall-row:not(.skel)').length,
        skeletons: document.querySelectorAll('#lobby-hall-list .hall-row.skel').length,
        text: el.textContent,
      };
    });

    // No placeholder ever reaches the screen, in any branch. This is the whole
    // "clean empty state" requirement: a missing field renders as a word, and
    // "undefined" is the word.
    expect(hall.text).not.toMatch(/undefined|NaN|\[object |null/);
    expect(hall.status.length, 'the status label is blank').toBeGreaterThan(0);
    expect(['loading', 'late', 'live', 'stale', 'empty', 'offline', 'unknown'])
      .toContain(hall.state);
    // Whatever state it settled in, it is not still pretending to load.
    expect(hall.state).not.toBe('loading');
    expect(hall.skeletons).toBe(0);

    if (hall.state === 'offline') {
      // The supported case: no server, so no global board, said once and calmly.
      expect(hall.status).toBe('local only');
      expect(hall.note).toContain('No server');
      expect(hall.note).toContain('kept on this machine');
      expect(hall.rows).toBe(0);
      // The offline card below the plate already says the same thing; neither is
      // an error, and nothing here is red.
      await expect(page.locator('#lobby-error')).toBeHidden();
    } else {
      expect(hall.status.length).toBeGreaterThan(0);
    }

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('shows the local personal best as its headline', async ({ page }) => {
    await seedBest(page, { score: 123456, wave: 27, won: false, at: Date.now() });
    const { errors } = await bootGame(page, { query: 'mp' });

    await expect(page.locator('#lobby-hall')).toBeVisible();
    // uikit.num formats with a thin space, not a comma.
    await expect(page.locator('#lobby-hall-best .hb-v')).toHaveText('123 456');
    await expect(page.locator('#lobby-hall-best .hb-v')).not.toHaveClass(/\bnone\b/);
    await expect(page.locator('#lobby-hall-best .hb-sub')).toHaveText('wave 27');

    // Control: it really came from storage rather than from a constant.
    expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).score, BEST_KEY))
      .toBe(123456);

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('marks a won run, and re-reads storage every time the overlay is shown', async ({ page }) => {
    await seedBest(page, { score: 9000, wave: 55, won: true, at: 1 });
    const { errors } = await bootGame(page, { query: 'mp' });

    await expect(page.locator('#lobby-hall-best .hb-sub')).toHaveText('wave 55 · survived');

    // Lobby.show() re-reads loadBest() rather than trusting the value it cached
    // in the constructor, because the overlay can come back up after a run that
    // wrote a new record.
    await page.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify({ score: 42000, wave: 61, won: false, at: 2 }));
      window.__lobby.show();
    }, BEST_KEY);

    await expect(page.locator('#lobby-hall-best .hb-v')).toHaveText('42 000');
    await expect(page.locator('#lobby-hall-best .hb-sub')).toHaveText('wave 61');

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('renders a board pushed through the shared feed, and escapes the names on it', async ({ page }) => {
    await seedBest(page, { score: 5000, wave: 12, won: false, at: 1 });
    const { errors } = await bootGame(page, { query: 'mp' });
    await settleConnection(page);

    /**
     * `leaderboard` frames land on HUD.setLeaderboard, which republishes them on
     * globalTop so the lobby can subscribe. Driving that method directly is the
     * only way to exercise the panel's populated states without standing a
     * server up, and it is the real entry point — main.js wires the socket
     * straight to it.
     *
     * Names come off a socket from another machine, so the hostile one below is
     * not paranoia: it is the same threat model as the roster.
     */
    await page.evaluate(() => window.__game.hud.setLeaderboard([
      { name: '<img src=x onerror=alert(1)>', score: 99999, wave: 40, won: true },
      { name: 'Ada', score: 8000, wave: 30 },
      { name: 'Bo', score: 4000, wave: 20 },
    ]));

    const list = page.locator('#lobby-hall-list .hall-row');
    await expect(list).toHaveCount(3);
    await expect(list.first()).toHaveClass(/\bfirst\b/);
    await expect(list.nth(1).locator('.hr-name')).toHaveText('Ada');
    await expect(list.nth(1).locator('.hr-score')).toHaveText('8 000');
    await expect(list.nth(1).locator('.hr-wave')).toHaveText('W30');
    await expect(list.first().locator('.hr-rank')).toHaveText('1');

    // The hostile row is inert text, not markup.
    expect(await page.evaluate(() => document.querySelectorAll('#lobby-hall img').length)).toBe(0);
    expect(await page.evaluate(() => document.getElementById('lobby-hall-list').innerHTML))
      .not.toContain('onerror');

    /**
     * The live/stale pair, driven from the connection label rather than left to
     * whether this machine happens to have a server. setConnection is the same
     * public method main.js calls off NetClient's events.
     *
     * This also pins the documented ordering inside #hallState: DATA FIRST,
     * connection second. A board that has already arrived keeps its rows when
     * the link drops and is labelled old, instead of being thrown away and
     * leaving a note about a board with no board under it.
     */
    await page.evaluate(() => window.__lobby.setConnection('online'));
    await expect(page.locator('#lobby')).toHaveAttribute('data-hall', 'live');
    await expect(page.locator('#lobby-hall-status')).toHaveText('top runs');
    const note = await page.locator('#lobby-hall-note').textContent();
    expect(note, 'the standing sentence never rendered')
      .toMatch(/would place|would take the top|more would put you/);
    expect(note).not.toMatch(/undefined|NaN/);

    await page.evaluate(() => window.__lobby.setConnection('offline'));
    await expect(page.locator('#lobby')).toHaveAttribute('data-hall', 'stale');
    await expect(page.locator('#lobby-hall-status')).toHaveText('last known');
    await expect(page.locator('#lobby-hall-note')).toContainText('no longer answering');
    await expect(list, 'the rows were thrown away when the link dropped').toHaveCount(3);

    // A malformed frame is an answer too: it must empty the board, not wedge it
    // on a spinner forever.
    await page.evaluate(() => window.__game.hud.setLeaderboard(null));
    await expect(list).toHaveCount(0);
    expect(await page.evaluate(() => document.getElementById('lobby').dataset.hall))
      .not.toBe('loading');

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });

  test('is read-only: it adds no focus stop to the lobby\'s Tab trap', async ({ page }) => {
    const { errors } = await bootGame(page, { query: 'mp' });
    await expect(page.locator('#lobby-hall')).toBeVisible();

    // Lobby.#focusables() sweeps `button, input, [href], [tabindex]` across the
    // whole overlay. A focusable row would silently join the modal's Tab cycle.
    const stops = await page.evaluate(() =>
      document.querySelectorAll('#lobby-hall button, #lobby-hall input, #lobby-hall a, #lobby-hall [tabindex]').length);
    expect(stops).toBe(0);

    // ...and the plate it sits beside is unchanged: three mutually exclusive
    // state cards, exactly as before. The hall is deliberately NOT one of them
    // (it is `.hall-card`), because it is visible across states.
    await expect(page.locator('#lobby .lobby-card')).toHaveCount(3);
    await expect(page.locator('#lobby-hall')).toHaveClass(/\bhall-card\b/);

    expect(appErrors(errors), errors.join('\n')).toEqual([]);
  });
});

/**
 * THE THREE STATES NOTHING COULD REACH.
 *
 * HALL_STATUS and HALL_NOTE define seven states; the suite drove three. `late`
 * was structurally unreachable: #armHallTimer only fires under
 * `CONNECTED_STATES.has(state) && !this.topReceived`, and the existing spec
 * publishes a board BEFORE calling setConnection('online'), so `topReceived` was
 * already true and the timer was never armed. HALL_TIMEOUT_MS and the whole
 * "the socket is open, no board is coming, stop claiming to load" path were
 * exercised by nothing — and it is the one state that only appears against a
 * real, mute server, i.e. the one nobody meets by accident and the only reason
 * the spinner is not infinite.
 *
 * page.clock is what makes that testable without an 8 second wall-clock wait.
 */
test.describe('lobby hall — the states with no board', () => {
  test('gives up claiming to load after the timeout, and says why', async ({ page }) => {
    const { errors } = await bootGame(page, { query: 'mp' });
    await expect(page.locator('#lobby')).toBeVisible();
    // NetClient has to have finished deciding BEFORE the connection is forced:
    // it emits its own verdict through main.js into setConnection, and a retry
    // landing mid-test would overwrite the state under measurement. Once the
    // backoff ladder is exhausted (_goOffline) nothing else fires.
    await settleConnection(page);

    // A live connection with NO board published: the only combination that arms
    // the timer.
    await page.evaluate(() => {
      window.__lobby.topReceived = false;
      window.__lobby.top = [];
      window.__lobby.setConnection('online');
    });
    await expect(page.locator('#lobby')).toHaveAttribute('data-hall', 'loading');
    await expect(page.locator('#lobby-hall-status')).toHaveText('reading…');
    // The skeleton is three inert bars so the panel keeps the height it will
    // have once a board lands.
    expect(await page.locator('#lobby-hall-list .hall-row.skel').count()).toBe(3);

    // Real time, not a faked clock: page.clock.install() would also freeze
    // NetClient's backoff, so the connection could never settle in the first
    // place. HALL_TIMEOUT_MS is 8s and the spec budget is 120s.
    await expect(page.locator('#lobby'))
      .toHaveAttribute('data-hall', 'late', { timeout: 20000 });
    await expect(page.locator('#lobby-hall-status')).toHaveText('no answer');
    await expect(page.locator('#lobby-hall-note')).toContainText('has not sent a board');
    expect(await page.locator('#lobby-hall-list .hall-row').count()).toBe(0);

    expect(appErrors(errors)).toEqual([]);
  });

  test('says "nobody yet" for a board that arrives empty', async ({ page }) => {
    const { errors } = await bootGame(page, { query: 'mp' });
    await expect(page.locator('#lobby')).toBeVisible();
    await page.waitForFunction(() => !!window.__lobby);

    await page.evaluate(() => {
      window.__game.hud.setLeaderboard([]);
      window.__lobby.setConnection('online');
    });

    await expect(page.locator('#lobby')).toHaveAttribute('data-hall', 'empty');
    await expect(page.locator('#lobby-hall-status')).toHaveText('nobody yet');
    await expect(page.locator('#lobby-hall-note')).toContainText('No score has been posted yet');

    expect(appErrors(errors)).toEqual([]);
  });

  test('clamps a hostile row instead of drawing it', async ({ page }) => {
    /**
     * `Number(x) || 0` neutralises NaN and undefined and lets a NEGATIVE through,
     * so the hall rendered "Mireward -5"; a missing wave printed the meaningless
     * "W0" beside it. The module already refuses to draw a name the server should
     * not have sent (displayName) — the numbers now follow the same rule.
     *
     * Also asserts the ORDER, because #standing() reads the list as if it were
     * sorted and only the server was making that true.
     */
    const { errors } = await bootGame(page, { query: 'mp' });
    await page.waitForFunction(() => !!window.__lobby);
    await page.evaluate(() => {
      window.__game.hud.setLeaderboard([
        { name: 'Ember', score: 10, wave: 3 },
        { name: 'Mireward', score: -5, wave: 3 },
        { name: 'Topper', score: 900, wave: 0 },
        { name: 'Nanner', score: NaN, wave: 12 },
      ]);
      window.__lobby.setConnection('online');
    });
    await expect(page.locator('#lobby')).toHaveAttribute('data-hall', 'live');

    const rows = await page.evaluate(() => [...document.querySelectorAll('#lobby-hall-list li')]
      .map((li) => ({
        name: li.querySelector('.hr-name').textContent.trim(),
        score: li.querySelector('.hr-score').textContent.trim(),
        wave: li.querySelector('.hr-wave')?.textContent?.trim() ?? null,
      })));

    // Sorted highest first, by construction rather than by trusting the frame.
    expect(rows.map((r) => r.name)).toEqual(['Topper', 'Ember', 'Mireward', 'Nanner']);
    // No negative score reaches the screen...
    for (const r of rows) expect(r.score.startsWith('-'), `${r.name} rendered ${r.score}`).toBe(false);
    expect(rows.find((r) => r.name === 'Mireward').score).toBe('0');
    // ...and a missing wave is omitted rather than printed as the meaningless W0.
    expect(rows.find((r) => r.name === 'Topper').wave, 'W0 is on screen').toBeNull();
    expect(rows.find((r) => r.name === 'Ember').wave).toBe('W3');

    expect(appErrors(errors)).toEqual([]);
  });

  test('stops listening once the overlay is hidden, and listens again when it is shown', async ({ page }) => {
    /**
     * destroy() unsubscribes correctly and NOTHING CALLS IT: main.js's openLobby
     * finishes with lobby.hide() and the overlay lives on for the rest of the
     * session, so every leaderboard frame the server pushed kept re-rendering a
     * list inside a hidden element, and setConnection could re-arm the 8s timer
     * after the run had started. Negligible at this scale — and indistinguishable
     * from live cleanup code, which is the actual defect.
     */
    const { errors } = await bootGame(page, { query: 'mp' });
    await page.waitForFunction(() => !!window.__lobby);
    await page.evaluate(() => {
      window.__game.hud.setLeaderboard([{ name: 'BeforeHide', score: 500, wave: 5 }]);
      window.__lobby.setConnection('online');
    });
    await expect(page.locator('#lobby-hall-list')).toContainText('BeforeHide');

    await page.evaluate(() => window.__lobby.hide());
    await expect(page.locator('#lobby')).toBeHidden();

    await page.evaluate(() =>
      window.__game.hud.setLeaderboard([{ name: 'AfterHide', score: 900, wave: 9 }]));
    await settle(page, 150);
    expect(await page.evaluate(() => document.getElementById('lobby-hall-list').textContent),
      'a hidden overlay is still rendering leaderboard frames').not.toContain('AfterHide');

    // ...and show() takes the subscription back, so this is a release and not a
    // one-way teardown.
    await page.evaluate(() => window.__lobby.show());
    await page.evaluate(() =>
      window.__game.hud.setLeaderboard([{ name: 'AfterShow', score: 1200, wave: 11 }]));
    await expect(page.locator('#lobby-hall-list')).toContainText('AfterShow');

    expect(appErrors(errors)).toEqual([]);
  });

  test('the footer only advertises Esc in the states where Esc does something', async ({ page }) => {
    // #onKey acts on Escape in 'lobby' and 'connecting' only. 'idle' and
    // 'offline' are the two states a solo player meets, and the cap promised the
    // key in both.
    const { errors } = await bootGame(page, { query: 'mp' });
    await page.waitForFunction(() => !!window.__lobby);
    await settleConnection(page);

    const escShown = () => page.evaluate(() => {
      const i = document.querySelector('#lobby-keys i');
      return !!i && getComputedStyle(i).display !== 'none';
    });

    for (const state of ['idle', 'offline']) {
      await page.evaluate((s) => window.__lobby.setState(s), state);
      expect(await escShown(), `"Esc back" is advertised in the ${state} state`).toBe(false);
    }
    for (const state of ['lobby', 'connecting']) {
      await page.evaluate((s) => window.__lobby.setState(s), state);
      expect(await escShown(), `"Esc back" is hidden in the ${state} state`).toBe(true);
    }
    // Enter is always live, so its half of the cap never goes away.
    await expect(page.locator('#lobby-keys')).toContainText('Enter');

    expect(appErrors(errors)).toEqual([]);
  });
});
