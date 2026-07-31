import { Game } from './game/Game.js';
import { PerfHud } from './ui/PerfHud.js';
import { NetClient } from './net/NetClient.js';
import { Lobby } from './ui/Lobby.js';
import { Scoreboard } from './ui/Scoreboard.js';
import { loadBest, saveBest } from './net/BestScore.js';

/**
 * Entry point. Detects a quality tier, boots the game behind a loading veil,
 * and drives the render loop.
 */

function detectQuality() {
  const forced = new URLSearchParams(location.search).get('q');
  if (forced) return forced;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return 'low';

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 4;

  if (mobile) return 'medium';

  // `ultra` is opt-in only.
  //
  // This used to read `/Apple M[1-9]|RTX [3-9]0|.../` -> 'ultra', which matched
  // EVERY Apple Silicon part, a base M1 exactly like an M4 Max, and handed them
  // all the heaviest preset. The only mechanism meant to protect modest machines
  // was routing them to the most expensive path. A base M1 measured 4 fps under
  // it (docs/PERF_BUDGET.md).
  //
  // No string of GPU names can be trusted to predict frame time on this content,
  // so autodetect now aims one tier low and lets the player raise it with ?q=.
  // A game that runs is worth more than a game that looks its best in a
  // screenshot and stutters in the hand.
  if (/RTX [4-9]0[7-9]0|RX 7[89]00/i.test(renderer)) return 'high';
  if (cores >= 8) return 'medium';
  return 'low';
}

const boot = document.getElementById('boot');
const bootBar = boot.querySelector('.boot-bar i');
const bootStatus = boot.querySelector('.boot-status');

function progress(p, label) {
  bootBar.style.width = `${p * 100}%`;
  if (label) bootStatus.textContent = label;
}

async function start() {
  progress(0.1, 'reading the runes…');
  await frame();

  const canvas = document.getElementById('viewport');
  const quality = detectQuality();

  progress(0.3, 'forging terrain…');
  await frame();

  const params = new URLSearchParams(location.search);
  // AUTOMATION BOOTS STRAIGHT INTO A SOLO RUN.
  //
  // Every visual and perf probe in tools/scratch drives `window.__game` directly
  // and expects a live run. Putting a lobby in front of them would have meant
  // editing fifty probes to keep the harness working, and a harness that needs a
  // migration to keep passing is a harness that quietly stops being run.
  // `navigator.webdriver` is true under Playwright and false for a real player,
  // so the bypass is exact rather than heuristic.
  //
  // `?mp` forces the lobby regardless, which is how the lobby itself stays
  // testable — see tools/scratch/lobbylive.mjs. `?solo` is the manual bypass.
  const forceLobby = params.has('mp');
  const skipLobby = !forceLobby && (params.has('solo') || navigator.webdriver === true);

  const net = new NetClient();
  const game = new Game(canvas, quality, {
    autoStart: skipLobby,
    onRunEnd: (result) => {
      // THREE SINKS, IN ORDER OF HOW MUCH HAS TO WORK FOR THEM TO MATTER.
      //
      // The local cache is first and unconditional: it is the only one that
      // still works with no server, and it is what the status bar and the end
      // card read. The room result and the global leaderboard are both no-ops
      // when offline (see NetClient), so neither can hold up the end card.
      const { best } = saveBest(result);
      game.hud.setBest(best.score);
      net.finished(result);
      net.best(result);
    },
  });
  window.__game = game;   // handy for debugging + automated visual checks
  window.__net = net;

  progress(0.8, 'binding the elements…');
  await frame();

  // Warm up shader compilation before the veil lifts so the first frame is smooth.
  game.pipeline.renderer.compile(game.scene, game.camera);
  game.frame(0.016);

  progress(1, 'ready');
  await new Promise((r) => setTimeout(r, 220));
  boot.classList.add('done');
  setTimeout(() => boot.remove(), 900);

  // Toggle with G (F8 also works, but is a media key on macOS). Auto-shown when
  // `?perf` is in the URL so a capture tool can ask for it explicitly; never on
  // by default, because it would land in comparison shots.
  const perf = new PerfHud(game.pipeline.renderer);
  window.__perf = perf;
  if (new URLSearchParams(location.search).has('perf')) perf.toggle(true);

  const scoreboard = new Scoreboard(document.getElementById('ui-root'));
  window.__scoreboard = scoreboard;
  let multiplayer = false;

  // The cached best is available before any network exists, so the status bar is
  // correct on frame one whether or not a server is ever reached.
  game.hud.setBest(loadBest().score);
  // The global board arrives whenever it arrives: it is broadcast on every
  // change and answered on request, and the end card simply omits the section
  // if nothing ever came.
  net.on('leaderboard', (m) => game.hud.setLeaderboard(m.top ?? []));
  net.on('open', () => net.requestTop());

  // The render loop starts BEFORE the lobby is awaited, so the overlay sits over
  // a live, drifting 3D scene rather than over a frozen first frame. Game.frame
  // does not simulate while the phase is 'lobby', so nothing advances underneath.
  let last = performance.now();
  function loop(now) {
    const dt = (now - last) / 1000;
    last = now;
    game.frame(dt);
    // Fed from here rather than from inside Game.frame() because it must see
    // the REAL wall-clock interval between presented frames — the same quantity
    // the player experiences — not a simulation step that may be clamped or
    // sub-stepped.
    game.pipeline.adaptive?.update(dt);
    // NetClient throttles this to ~2 Hz internally and no-ops when offline, which
    // is exactly why it is safe to call from here: the frame loop should not have
    // to know the wire rate, and a rate decision made here would drift from the
    // one the transport already enforces.
    if (multiplayer) net.status(game.snapshot());
    perf.update(dt);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  if (!skipLobby) {
    const chosen = await openLobby(net);
    multiplayer = chosen.multiplayer;
    game.beginRun(chosen.seed);
    if (multiplayer) {
      // `chosen.you` rather than something read off the transport: the id is
      // assigned in `welcome` and the lobby is what observed it, so passing it
      // out is honest about where it came from.
      scoreboard.show();
      net.on('scores', (m) => scoreboard.update(m.players ?? [], chosen.you));
      net.on('over', (m) => scoreboard.showFinal(m.standings ?? [], chosen.you));
    }
  }
}

/**
 * Run the lobby and resolve once the player has committed to a run.
 *
 * Resolves `{ seed, multiplayer }`. A solo choice mints its own seed, so the
 * seeded element draw behaves identically in both modes and there is no
 * "multiplayer only" code path inside the game to go stale.
 *
 * This function is the ONLY place that knows both the lobby and the transport.
 * Game.js is deliberately not in scope here.
 */
function openLobby(net) {
  return new Promise((resolve) => {
    let you = null;
    let done = false;

    const lobby = new Lobby(document.getElementById('app'), {
      onCreate: (name) => { net.hello(name); net.create(); },
      onJoin: (name, code) => { net.hello(name); net.join(code); },
      onReady: (r) => net.ready(r),
      onStart: () => net.start(),
      onLeave: () => { net.leave(); lobby.setState(net.online ? 'idle' : 'offline'); },
      // The hello is what lets a SOLO run post to the global leaderboard: the
      // server posts under the name it holds, and without this it holds none.
      // It is also harmless when no server is listening — every send is a no-op
      // while offline.
      onSolo: (name) => { net.hello(name); finish(Math.floor(Math.random() * 0xffffffff) >>> 0, false, null); },
    });
    window.__lobby = lobby;

    function finish(seed, multiplayer, id = you) {
      if (done) return;      // 'go' can race a solo click; first commit wins
      done = true;
      lobby.hide();
      resolve({ seed: seed >>> 0, multiplayer, you: id });
    }

    net.on('welcome', (m) => { you = m.id ?? you; });
    net.on('joined', (m) => {
      you = m.you ?? you;
      lobby.setCode(m.code);
      lobby.setPlayers(m.players ?? [], you);
      lobby.setState('lobby');
    });
    net.on('lobby', (m) => {
      if (m.code) lobby.setCode(m.code);
      lobby.setPlayers(m.players ?? [], you);
    });
    net.on('error', (m) => lobby.setError(m.code, m.msg));
    net.on('go', (m) => finish(m.seed, true));
    net.on('open', () => { lobby.setConnection('online'); if (!done) lobby.setState('idle'); });
    // A close is not necessarily the end — NetClient may be mid-backoff — so this
    // reports the transport's own view. The 'offline' event below is what says
    // "stop waiting", and it is the only thing that flips the panel.
    net.on('close', () => lobby.setConnection(net.state === 'online' ? 'online' : 'closed'));
    net.on('offline', () => {
      lobby.setConnection('offline');
      if (!done) lobby.setState('offline');
    });

    lobby.show();
    lobby.setState('connecting');
    lobby.setConnection('connecting');
    // connect() never rejects and always settles (NetClient's contract), so this
    // cannot leave the lobby stuck on "connecting" and cannot strand the player
    // with no way into the game — solo stays available in every state.
    net.connect().then((online) => {
      // The RESOLVED boolean, not `net.state`. Measured in
      // tools/scratch/netaudit.mjs: against a dead port, a mute TCP socket, an
      // instant close and an HTTP 200, connect() correctly resolves false while
      // `state` still reads 'connecting' — it has already scheduled a retry, so
      // 'connecting' is truthful about the transport and misleading about what to
      // show the player. Reading it here made the connection pill say "Reaching
      // the server…" underneath a panel that had already given up.
      lobby.setConnection(online ? 'online' : 'offline');
      if (!done) lobby.setState(online ? 'idle' : 'offline');
    });
  });
}

function frame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

start().catch((err) => {
  console.error(err);
  bootStatus.textContent = `failed to start: ${err.message}`;
  bootStatus.style.color = '#ff5a52';
});
