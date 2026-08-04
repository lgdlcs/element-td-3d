/**
 * Lobby layout + console-cleanliness probe for the "scoreboard in the lobby"
 * work (feature 6).
 *
 * The nominal dev case has NO game server, so the lobby lands in `offline` on
 * its own after NetClient gives up. That is the state this captures first, at
 * both of the two viewports the brief names, plus the connected/idle and the
 * populated-room states driven through the public setters (same technique as
 * lobbyshot.mjs — spinning up a real server here would test the server, not the
 * layout).
 *
 * Every page reports its console errors: "no exception in the console with no
 * backend" is an explicit acceptance criterion and it is the kind of thing that
 * is only true until someone adds a fetch.
 *
 *   node tools/scratch/ux-lobbyshots.mjs <outdir> [tag]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const OUT = process.argv[2] || 'shots';
const TAG = process.argv[3] || 'now';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { w: 1280, h: 720 },
  { w: 1920, h: 1080 },
];

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });

for (const v of VIEWPORTS) {
  const errs = [];
  const p = await b.newPage({ viewport: { width: v.w, height: v.h } });
  p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  await p.goto('http://localhost:5273/?q=low&mp', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby, null, { timeout: 90000 });

  // Let NetClient's connect() settle. With nothing on 5274 it resolves false
  // and the overlay goes to `offline` — the dev-machine default.
  await p.waitForFunction(() => window.__lobby.state === 'offline' || window.__lobby.state === 'idle',
    null, { timeout: 30000 });
  await p.waitForTimeout(1400);

  const shot = async (name) => {
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${OUT}/lobby-${TAG}-${name}-${v.w}x${v.h}.png` });
    const m = await p.evaluate(() => {
      const inner = document.querySelector('.lobby-inner');
      const hall = document.querySelector('#lobby-hall');
      const hr = hall.getBoundingClientRect();
      const ir = inner.getBoundingClientRect();
      const shown = getComputedStyle(hall).display !== 'none';
      return {
        state: window.__lobby.state,
        hall: document.querySelector('#lobby').dataset.hall,
        scrollH: inner.scrollHeight,
        clientH: inner.clientHeight,
        overflowing: inner.scrollHeight > inner.clientHeight + 1,
        hallShown: shown,
        // The two failure modes for a gutter panel: off the right edge, or
        // sitting on top of the plate it is supposed to sit beside.
        hallOffscreen: shown && (hr.right > window.innerWidth || hr.bottom > window.innerHeight || hr.top < 0),
        hallOverlapsPlate: shown && hr.left < ir.right - 1 && ir.left < hr.right - 1,
        hallRows: hall.querySelectorAll('.hall-row').length,
      };
    });
    console.log(`  ${v.w}x${v.h} ${name.padEnd(9)} state=${m.state} hall=${m.hall}(${m.hallRows}) inner=${m.scrollH}/${m.clientH}px`
      + ` overflow=${m.overflowing} hallShown=${m.hallShown} offscreen=${m.hallOffscreen} overlapsPlate=${m.hallOverlapsPlate}`);
  };

  console.log(`\n--- ${v.w}x${v.h} ---`);
  // 1. No backend at all — the nominal dev case, and the one that must not read
  //    as an error screen.
  await shot('offline');

  // 2. Connected, board not in yet: the loading state.
  await p.evaluate(() => { window.__lobby.setConnection('online'); window.__lobby.setState('idle'); });
  await shot('idle');

  // 3. A real board. Driven through hud.setLeaderboard because that is the
  //    method main.js wires the transport to — testing the actual seam rather
  //    than reaching into the lobby's fields. Hostile name included: it is
  //    rendered from a socket string like every other name here.
  await p.evaluate(() => {
    const l = window.__lobby;
    window.__game.hud.setLeaderboard([
      { name: 'Ada', score: 412300, wave: 50, won: true },
      { name: 'Grace', score: 288140, wave: 47 },
      { name: '<b>zap</b>', score: 190020, wave: 41 },
      { name: 'a-very-long-player-name', score: 98400, wave: 33 },
      { name: 'Alan', score: 41250, wave: 22 },
      { name: 'not shown', score: 10, wave: 2 },
    ]);
    l.best = { score: 128400, wave: 21, won: false, at: Date.now() };
    l.setConnection('online');
  });
  await shot('live');

  // 4. Connected, and the server answered with an empty board.
  await p.evaluate(() => { window.__game.hud.setLeaderboard([]); });
  await shot('empty');

  // 5. In a room, as host — the hall stays put beside a taller plate.
  await p.evaluate(() => {
    const l = window.__lobby;
    window.__game.hud.setLeaderboard([
      { name: 'Ada', score: 412300, wave: 50, won: true },
      { name: 'Grace', score: 288140, wave: 47 },
      { name: 'Alan', score: 41250, wave: 22 },
    ]);
    l.setState('lobby');
    l.setCode('WGNP');
    l.setPlayers([
      { id: 'p1', name: 'Ada', host: true, ready: true },
      { id: 'p2', name: 'Grace', host: false, ready: true },
      { id: 'p3', name: 'Alan', host: false, ready: false },
    ], 'p1');
  });
  await shot('room');

  // The hostile name must be inert here too.
  const tags = await p.evaluate(() =>
    [...document.querySelectorAll('#lobby-hall .hr-name')].reduce((a, n) => a + n.querySelectorAll('*').length, 0));
  console.log(`  ${tags === 0 ? 'ok  ' : 'FAIL'}  hall escapes hostile names`);

  console.log(errs.length ? `  ERRORS (${errs.length}):\n   ${errs.slice(0, 8).join('\n   ')}` : '  no console errors');
  await p.close();
}

await b.close();
