import { Game } from './game/Game.js';
import { PerfHud } from './ui/PerfHud.js';
import { NetClient } from './net/NetClient.js';
import { Lobby } from './ui/Lobby.js';
import { Scoreboard } from './ui/Scoreboard.js';
import { SpectateBar } from './ui/SpectateBar.js';
import { SpectateStreamer } from './game/spectate/SpectateStreamer.js';
import { SpectateView } from './game/spectate/SpectateView.js';
import { loadBest, saveBest } from './net/BestScore.js';
import { QUALITY_PRESETS } from './core/Config.js';
import { Settings } from './ui/Settings.js';
import { QualityGovernor } from './render/QualityGovernor.js';

/**
 * Entry point. Detects a quality tier, boots the game behind a loading veil,
 * and drives the render loop.
 */

/**
 * The preset to boot at, in priority order: `?q=` (explicit, wins over
 * everything), then the player's own saved choice, then autodetect.
 *
 * AUTODETECT AIMS AT `low`, AND THE BAR TO GO ABOVE IT IS HIGH.
 *
 * The previous rule ended `if (cores >= 8) return 'medium'`, which is how a
 * friend on an 8-thread laptop with integrated graphics was handed `medium`.
 * Core count is not a GPU: this renderer is fragment-bound with a measured CPU
 * cost of 0.20 ms per frame (docs/PERF_BUDGET.md), so `hardwareConcurrency`
 * predicts nothing at all about how it will run — and `medium` measures 62 ms
 * (16 fps) on the reference M1, which has exactly 8 cores and would have taken
 * that branch itself.
 *
 * So the floor is `low`, the only way up is a GPU string that names a discrete
 * part known to be fast, and even that is one tier below what it could hold.
 * The governor raises quality from below when the frame proves it can afford
 * it, which is a claim backed by a measurement instead of by a name.
 */
function detectQuality() {
  const forced = new URLSearchParams(location.search).get('q');
  if (forced && QUALITY_PRESETS[forced]) return forced;

  const saved = loadQualityPref();
  if (saved && saved !== 'auto' && QUALITY_PRESETS[saved]) return saved;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  // No WebGL2 means a software rasteriser or a very old driver, and `low` is
  // still a composer with a bloom pyramid. Start at the bottom.
  if (!gl) return 'potato';
  if (!(gl instanceof WebGL2RenderingContext)) return 'potato';

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

  // A phone gets the cheapest preset there is. `medium` here was the same
  // mistake as the core-count branch, applied to weaker hardware.
  if (mobile) return 'potato';

  // Integrated parts, named explicitly. These are the machines the report of
  // "freezes and low fps" came from, and they must never be guessed upward.
  if (/Intel|UHD Graphics|HD Graphics|Iris|Vega \d|Radeon Graphics|Microsoft Basic|SwiftShader|llvmpipe|ANGLE \(Software/i.test(renderer)) {
    return 'potato';
  }

  // Discrete and recent. Still one tier below what these could hold: the
  // governor will raise it within a few seconds if the frame allows.
  if (/RTX [3-9]0[6-9]0|RTX [3-9][0-9]0 Ti|RX 7[6-9]00|RX 6[89]00/i.test(renderer)) return 'medium';

  return 'low';
}

const QUALITY_KEY = 'etd.quality';

/** The player's saved preset, or 'auto'. Never throws — storage can be denied. */
function loadQualityPref() {
  try { return localStorage.getItem(QUALITY_KEY); } catch { return null; }
}

function saveQualityPref(v) {
  try { localStorage.setItem(QUALITY_KEY, v); } catch { /* private mode */ }
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

  // THE DEV PANEL — F9, or ² on AZERTY. Gold, lives, every element, jump to any
  // wave, invincibility, clear the board.
  //
  // The guard is `import.meta.env.DEV` and not a query parameter or a flag,
  // because that is the only form Vite can PROVE at build time: it replaces the
  // expression with the literal `false` in a production build, the branch
  // becomes dead code, and src/dev/ is dropped from the bundle entirely. There
  // is nothing to leave switched on by accident and nothing in dist/ to find.
  //
  // Dynamic import for the same reason — a static one would put the module in
  // the graph whether or not the branch survives. Not awaited: the panel is
  // summoned by a key, so nothing on the boot path should wait for it, and a
  // failure to load it must not take the game down with it.
  if (import.meta.env.DEV) {
    import('./dev/DevPanel.js')
      .then(({ DevPanel }) => { window.__dev = new DevPanel(game); })
      .catch((e) => console.warn('[dev] panel unavailable:', e));
  }

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

  // GRAPHICS: the governor that adapts, and the panel that overrules it.
  //
  // The governor only ever acts once AdaptiveResolution has spent its range —
  // resolution is the smoother instrument and gets first refusal on every
  // slowdown. See QualityGovernor for why it is a ladder of live knobs and not
  // a preset switch.
  const governor = new QualityGovernor({
    pipeline: game.pipeline,
    environment: game.environment,
    lighting: game.lighting,
    fx: game.fx,
    onChange: (g) => {
      settings.refresh();
      // Said once, on the first cut only. A toast per rung would be four
      // interruptions during the wave that is already going badly.
      if (g.step === 1) {
        game.hud.warn('Qualité réduite automatiquement pour garder le jeu fluide · ⚙', 'info');
      }
    },
  });
  window.__governor = governor;

  const settings = new Settings(document.getElementById('ui-root'), {
    current: quality,
    saved: loadQualityPref() ?? 'auto',
    governor,
    onPreset: (q) => {
      saveQualityPref(q);
      // A preset is a property of a BUILT world (see Settings' docblock), so it
      // is applied by reloading rather than by mutating half of one. `?q=` is
      // stripped on the way out: it outranks the stored preference by design,
      // so leaving it on would make the panel appear to do nothing.
      const url = new URL(location.href);
      url.searchParams.delete('q');
      location.replace(url.toString());
    },
  });
  settings.adaptive = game.pipeline.adaptive;
  settings.attachButton(document.getElementById('settings-btn'));
  window.__settings = settings;

  const scoreboard = new Scoreboard(document.getElementById('ui-root'));
  window.__scoreboard = scoreboard;
  let multiplayer = false;

  const spectate = wireSpectate(game, net, scoreboard);
  window.__spectate = spectate;

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
  // The panel's live readouts repaint at ~4Hz. A number that changes every
  // frame is unreadable exactly when someone is trying to judge whether a
  // setting helped — the same reasoning as PerfHud's own throttle.
  let settingsRepaint = 0;
  function settingsTick(now) {
    if (now - settingsRepaint < 250) return;
    settingsRepaint = now;
    settings.refresh(perf.fps);
  }

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
    // AFTER the resolution controller, and fed the same real wall-clock
    // interval: the governor's first question is whether resolution has already
    // been spent, and asking that before the controller has had its turn on
    // this frame reads a stale answer.
    governor.update(dt);
    if (settings.open) settingsTick(now);
    // NetClient throttles this to ~2 Hz internally and no-ops when offline, which
    // is exactly why it is safe to call from here: the frame loop should not have
    // to know the wire rate, and a rate decision made here would drift from the
    // one the transport already enforces.
    if (multiplayer) net.status(game.snapshot());
    // Deliberately NOT guarded by `multiplayer`: the honest guard is
    // `net.streaming`, which the streamer checks first and which can only be
    // true inside a running room anyway. One condition, owned by the transport,
    // instead of two that can disagree.
    spectate.tick(now);
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
 * Couple the spectate feature to the transport, the game and the leaderboard.
 *
 * Like openLobby below, this is the ONLY place that knows both halves.
 * Game.js knows how to put another board on screen but nothing about rooms or
 * sockets; NetClient knows how to subscribe but nothing about rendering; the
 * scoreboard knows who is in the room but not what a snapshot is. All three
 * stay ignorant of each other, and the coupling is these forty lines.
 *
 * @returns {{tick(nowMs: number): void, view: ?SpectateView}}
 */
function wireSpectate(game, net, scoreboard) {
  const bar = new SpectateBar(document.getElementById('ui-root'));
  const streamer = new SpectateStreamer(game);

  // LAZY. Constructing the view compiles four creep shader programs plus the
  // projectile billboard and ribbon programs; a solo player, and a multiplayer
  // player who never clicks a row, must not pay for any of it. Built on the
  // first `watching` ack and reused for every target after that.
  let view = null;
  const ensureView = () => {
    if (view) return view;
    view = new SpectateView(game);
    view.onProtocolError = (why) => {
      console.warn('[spectate] dropping subscription:', why);
      game.exitSpectate('protocol');
    };
    return view;
  };

  // Toggle: clicking the row you are already watching stops. The scoreboard
  // cannot decide that on its own — only the transport knows what is subscribed
  // — which is why it reports the click rather than acting on it.
  scoreboard.onWatch = (id) => {
    if (net.watching === id) net.unwatch();
    else net.watch(id);
  };
  bar.onExit = () => game.exitSpectate('button');

  net.onWatching = ({ id, name }) => {
    const v = ensureView();
    const color = scoreboard.seatColor(id);
    // begin() before enterSpectate(): enterSpectate short-circuits when it is
    // already spectating precisely so a target switch does not tear down the
    // board that has just been prepared here.
    v.begin({ id, name, color });
    game.enterSpectate(v);
    scoreboard.setWatching(id);
    bar.show(name, color);
  };

  // Every involuntary end — the streamer finished, left, or the room ended —
  // arrives here. Game.exitSpectate is idempotent, and its own exits (Escape,
  // the button, the local run ending) come back through onSpectateExit, so
  // there is exactly one teardown path however the mode ends.
  net.onUnwatch = ({ reason }) => game.exitSpectate(reason);

  net.onBoardSnapshot = (m) => view?.onSnapshot(m);

  game.onSpectateExit = (reason) => {
    // 'switch' never reaches here (see enterSpectate), but a future caller
    // might: dropping the subscription on a switch would cancel the one that is
    // being set up in the same tick.
    if (reason === 'switch') return;
    bar.hide();
    scoreboard.setWatching(null);
    // Already null when the SERVER ended it — NetClient clears it before it
    // calls onUnwatch — so this only fires for the exits we initiated.
    if (net.watching) net.unwatch();
  };

  // A new round reuses the socket and the ids, so a streamer that does not
  // forget what the previous round's watchers were told would send deltas
  // against a board that no longer exists.
  net.on('go', () => streamer.reset());

  return {
    get view() { return view; },
    tick(nowMs) {
      streamer.tick(net, nowMs);
      if (!game.spectating || !view) return;
      bar.update(view.stats, view.loading);
      bar.setStalled(view.stalled);
    },
  };
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
