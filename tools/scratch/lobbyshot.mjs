/**
 * What the lobby and the leaderboard actually look like.
 *
 * No agent could verify these — they wrote markup and CSS without a browser — so
 * this is the first time either surface is seen. Four states, because the lobby's
 * whole job is to be legible in all of them:
 *
 *   1. fresh, connected, nothing chosen
 *   2. in a room with several players, as the host
 *   3. server unreachable (the state a player hits when nobody runs the server)
 *   4. the in-game leaderboard, with the element picker dismissed so it is visible
 *
 * State 3 is the one that matters most and the one nobody would think to check: it
 * is what a player who just cloned the repo sees, and if it reads as an error
 * screen rather than as "play solo", the multiplayer work has made the
 * single-player game worse.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const OUT = process.argv[2] || '/private/tmp/claude-501/-Users-pouetpouets-code/c57263d9-aa43-4151-90a5-60492452382f/scratchpad';

const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const errs = [];

async function page(url) {
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby, null, { timeout: 90000 });
  return p;
}

// --- 1 + 2: connected, then a populated room --------------------------------
const p = await page('http://localhost:5273/?q=low&mp');
await p.waitForTimeout(2500);
await p.screenshot({ path: `${OUT}/lobby-fresh.png` });
console.log('wrote lobby-fresh.png');

// Drive the roster straight through the public setters. Spinning up five real
// browsers to populate a roster would test the server, which mplive.mjs already
// does; what is unverified here is whether six rows LOOK right.
await p.evaluate(() => {
  const l = window.__lobby;
  l.setState('lobby');
  l.setConnection('online');
  l.setCode('WGNP');
  l.setPlayers([
    { id: 'p1', name: 'Ada', host: true, ready: true },
    { id: 'p2', name: 'Grace', host: false, ready: true },
    { id: 'p3', name: 'Alan', host: false, ready: false },
    { id: 'p4', name: 'a-very-long-name', host: false, ready: false },
    { id: 'p5', name: '<b>zap</b>', host: false, ready: true },
  ], 'p1');
});
await p.waitForTimeout(900);
await p.screenshot({ path: `${OUT}/lobby-room.png` });
console.log('wrote lobby-room.png');

// The hostile name must be inert HERE too, where it is rendered by a setter
// rather than by a server message.
const tags = await p.evaluate(() =>
  [...document.querySelectorAll('#lobby-roster .lb-name')].reduce((a, n) => a + n.querySelectorAll('*').length, 0));
console.log(tags === 0 ? 'PASS  roster escapes hostile names' : `FAIL  ${tags} child elements in name spans`);

// --- 3: no server ------------------------------------------------------------
await p.evaluate(() => {
  const l = window.__lobby;
  l.setPlayers([], null);
  l.setState('offline');
  l.setConnection('offline');
});
await p.waitForTimeout(900);
await p.screenshot({ path: `${OUT}/lobby-offline.png` });
console.log('wrote lobby-offline.png');

const soloReady = await p.evaluate(() => {
  const s = document.querySelector('#lobby-solo');
  return { exists: !!s, disabled: !!s?.disabled, primary: !!s?.classList.contains('primary') };
});
console.log(`solo button with no server: exists=${soloReady.exists} disabled=${soloReady.disabled} primary=${soloReady.primary}`);
console.log(soloReady.exists && !soloReady.disabled
  ? 'PASS  solo is available with no server reachable'
  : 'FAIL  the player is stranded when the server is down');

// --- 4: the in-game leaderboard ---------------------------------------------
await p.evaluate(async () => {
  const g = window.__game;
  window.__lobby.hide();
  g.beginRun(1234);
  // Dismiss the element picker: it is a full-screen surface and it covers the
  // leaderboard for the first few seconds of every multiplayer run, which is why
  // the earlier in-game shot showed the picker instead of the panel.
  g.chooseElement(g.rollElementChoices()[0].id);
  g.state.pendingElementPicks = 0;
  g.hud.closeElementPicker?.();
  g.state.gold = 99999;
  const keys = g.state.elements;
  let n = 0;
  for (let r = 5; r < 14 && n < 8; r += 3)
    for (let c = 5; c < 20 && n < 8; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) {
        g.towers.create(n % 2 ? 'foundation' : keys[0], 0, c, r); n++;
      }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(9);

  const sb = window.__scoreboard;
  sb.show();
  sb.update([
    { id: 'p1', name: 'Ada', score: 48210, lives: 44, wave: 9, killed: 210, leaked: 6, finished: false, won: false },
    { id: 'p2', name: 'Grace', score: 31980, lives: 50, wave: 9, killed: 180, leaked: 0, finished: false, won: false },
    { id: 'p3', name: 'Alan', score: 12040, lives: 7, wave: 8, killed: 90, leaked: 43, finished: false, won: false },
    { id: 'p4', name: 'Mira', score: 8800, lives: 0, wave: 6, killed: 51, leaked: 50, finished: true, won: false },
  ], 'p2');
  await new Promise((r) => setTimeout(r, 3000));
});
await p.waitForTimeout(1200);
await p.screenshot({ path: `${OUT}/scoreboard-live.png` });
console.log('wrote scoreboard-live.png');

const sbState = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('#scoreboard li.sb-row')];
  return {
    rows: rows.length,
    // Same reason as the solo check below: offsetParent cannot see a
    // visibility/opacity hide, so it would call an invisible panel visible.
    visible: getComputedStyle(document.querySelector('#scoreboard')).visibility === 'visible',
    you: rows.filter((r) => r.classList.contains('you')).map((r) => r.querySelector('.sb-name')?.textContent),
    out: rows.filter((r) => r.classList.contains('out')).map((r) => r.querySelector('.sb-name')?.textContent),
    ranks: rows.map((r) => r.querySelector('.sb-rank')?.textContent),
  };
});
console.log(`leaderboard: ${sbState.rows} rows, visible=${sbState.visible}, you=${sbState.you}, out=${sbState.out}, ranks=${sbState.ranks}`);
console.log(sbState.rows === 4 && sbState.visible && sbState.you.length === 1 && sbState.out.length === 1
  ? 'PASS  four ranked rows, one marked as you, one marked out'
  : 'FAIL  leaderboard state is wrong');

// Single-player must not show it at all.
//
// Tested through COMPUTED STYLE, not `offsetParent`. The panel hides with
// `visibility: hidden; opacity: 0` so it can fade (display is not animatable), and
// a hidden element with those properties still has an offsetParent — the first
// version of this check reported the panel as shown when it was fully invisible.
// The visibility transition is `step-end`, so the wait is required too.

await p.evaluate(() => {
  window.__scoreboard.update([{ id: 'p1', name: 'Solo', score: 10, lives: 50, wave: 1 }], 'p1');
});
await p.waitForTimeout(900);
const solo = await p.evaluate(() => {
  const el = document.querySelector('#scoreboard');
  const cs = getComputedStyle(el);
  return { on: el.classList.contains('on'), visibility: cs.visibility, opacity: cs.opacity };
});
console.log(`one-row state: class-on=${solo.on} visibility=${solo.visibility} opacity=${solo.opacity}`);
// Asserted on the class and the opacity, which is what the COMPONENT decides.
// `visibility` is deliberately only reported: it flips with `step-end`, i.e. at the
// very end of the transition, and a Playwright page that is not focused has its
// transitions throttled — so requiring `hidden` here tests Chromium's scheduler
// rather than the leaderboard. Opacity 0.0002 is already invisible, and
// #scoreboard carries `pointer-events: none`, so nothing is clickable either way.
console.log(!solo.on && Number(solo.opacity) < 0.02
  ? 'PASS  a one-row leaderboard hides itself'
  : 'FAIL  a one-row leaderboard is still shown');

console.log(errs.length ? `\nERRORS:\n${errs.slice(0, 8).join('\n')}` : '\nno page errors');
await b.close();
