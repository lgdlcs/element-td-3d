/**
 * The multiplayer lobby server: WebSocket transport, protocol dispatch, and the
 * two timers that keep a room's bandwidth bounded. Room rules live in rooms.js.
 *
 * The contract is docs/MULTIPLAYER.md and it is authoritative. Nothing here
 * simulates the game: the server hands out a shared seed and relays scoreboards.
 *
 * WHY BROADCASTS ARE COALESCED AND NOT RELAYED
 *
 * The obvious implementation of `status` is "forward it to the other five
 * players". At the documented ~2 Hz with 6 players that is 6 x 2 x 5 = 60
 * frames/second out of the room, and it scales as O(players^2 * rate) with a
 * rate the *client* chooses. One client with a while-loop then decides the
 * bandwidth of five innocent ones. So status never sends anything: it writes
 * into the player and sets `scoresDirty`, and a single room timer emits one
 * `scores` frame per player per tick at a rate the server owns. 6 players is
 * then 12 frames/second regardless of what any client does.
 *
 * The same trap applies to `ready`, which also triggers a room-wide broadcast,
 * so lobby frames are coalesced too - on a much shorter fuse, because a roster
 * change that takes half a second to appear feels broken.
 *
 * WHY THE HEARTBEAT EXISTS
 *
 * A browser tab killed by the OS (or a laptop lid closing) does not send a close
 * frame. Without a ping/pong sweep those sockets stay `OPEN` forever, the player
 * sits in the roster, and `allFinished()` can never be true again - the room
 * hangs waiting for a corpse to finish its run. The sweep is what turns a dead
 * TCP connection into a `leave`.
 *
 * It only covers dead TCP, though, and that gap was mistaken for the whole
 * problem: a tab left open on a desk keeps answering pings, so a player who
 * walked away wedged `over` for everyone else permanently. sweepIdle is the other
 * half, and it rides the same timer.
 */

import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';
import { Rooms, cleanName, intCount } from './rooms.js';
import { Leaderboard } from './leaderboard.js';
import { serveStatic } from './static.js';

const DEFAULT_PORT = Number(process.env.PORT) || 5274;
export const WS_PATH = '/ws';

/** Server-owned broadcast rates. Clients cannot influence these. */
const SCORES_MS = 500;   // the documented ~2 Hz leaderboard
const LOBBY_MS = 60;     // just long enough to collapse a burst of ready-spam

/** Heartbeat. 15s x 2 misses is ~30s to evict a dead tab. */
const PING_MS = 15000;

/** How long a connected-but-silent player may block `over`. See sweepIdle. */
const IDLE_MS = 60000;

/**
 * Two buckets per client, because the two abuse shapes are different.
 *
 * `status` has a documented rate (~2 Hz), so its bucket can be tight and any
 * violation is genuinely the client misbehaving. Everything else is
 * user-driven - a player mashing the ready button legitimately produces a short
 * burst - so the general bucket is loose and only exists to stop a script.
 */
const STATUS_BURST = 12, STATUS_PER_SEC = 5;
const MSG_BURST = 40, MSG_PER_SEC = 20;

/**
 * A RATE_LIMIT error is itself a frame, so replying to every dropped message
 * would turn a flood into an amplifier pointed back at us. Tell the client once
 * per interval; the drops continue silently in between.
 */
const RATE_NOTIFY_MS = 2000;

/**
 * A client that keeps hammering after being told to stop is not a buggy client,
 * it is hostile: it gets closed and then IGNORED (see `player.evicted`), because
 * close() alone does not stop the message handler - frames already buffered keep
 * arriving after it.
 *
 * THE COUNTER LEAKS, IT DOES NOT RESET ON A GAP, and that distinction ejected a
 * live player from their game. The old rule was "reset if the last violation was
 * more than 5 s ago", sold as "only violations inside one continuous burst
 * count". A continuously overspeed client never produces a 5 s gap, so the window
 * could never elapse and the counter only ever went up: measured, `status` at
 * 8 Hz - 4x the documented ~2 Hz, the rate a client bug that ticks status off a
 * sim frame produces - closed the socket with 1008 after 107.7 s, mid-run, and
 * partRoom then computed `over` for the survivors without that player. At 15 Hz
 * it took 36 s. Excess rate is what RATE_LIMIT is for; the contract does not
 * sanction ejection for it.
 *
 * So violations drain at VIOLATION_LEAK_PER_SEC and eviction now needs a
 * violation rate above the leak, i.e. a sustained ~205+ frames/second. Anything a
 * misbehaving-but-real client does (60 Hz sim-frame status is 60/s) drains faster
 * than it accumulates and gets throttled forever instead of disconnected, while a
 * while-loop flood still trips MAX_VIOLATIONS in its first batch.
 */
const MAX_VIOLATIONS = 300;
const VIOLATION_LEAK_PER_SEC = 200;

let NEXT_ID = 0;

class Bucket {
  constructor(burst, perSec) {
    this.tokens = burst;
    this.burst = burst;
    this.perSec = perSec;
    this.last = Date.now();
  }
  /** True if a message may proceed. */
  take(now) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export function createServer(opts = {}) {
  const rooms = new Rooms();
  // `leaderboardFile: null` keeps the board in memory — that is what tests use,
  // and what a read-only deployment gets.
  const board = new Leaderboard({
    file: opts.leaderboardFile,
    log: opts.log === false ? undefined : (...a) => console.log('[mp]', ...a),
  });
  const wss = opts.wss || new WebSocketServer({
    port: opts.port ?? DEFAULT_PORT,
    host: opts.host,
    // The lobby is small JSON. A client claiming a megabyte frame is either
    // broken or probing, and either way we do not want it in memory.
    maxPayload: 16 * 1024,
  });
  const log = opts.log === false ? () => {} : (opts.log || ((...a) => console.log('[mp]', ...a)));
  // Overridable so a test can watch a heartbeat sweep evict a dead socket in a
  // second instead of thirty. Production never passes these.
  const scoresMs = opts.scoresMs ?? SCORES_MS;
  const pingMs = opts.pingMs ?? PING_MS;
  const idleMs = opts.idleMs ?? IDLE_MS;

  /**
   * Rooms with a pending coalesced `lobby` broadcast. A Set, so N roster/ready
   * changes inside one LOBBY_MS window cost exactly one broadcast, and it is the
   * single owner of "this room owes a lobby frame".
   */
  const dirty = new Set();
  let lobbyTimer = null;

  function markDirty(room) {
    if (!room) return;
    dirty.add(room);
    if (!lobbyTimer) lobbyTimer = setTimeout(flushLobby, LOBBY_MS);
  }

  function flushLobby() {
    lobbyTimer = null;
    for (const room of dirty) {
      dirty.delete(room);
      // Collected between the mark and the flush: there is nobody to tell.
      if (room.empty) continue;
      broadcast(room, { t: 'lobby', code: room.code, players: room.roster() });
    }
  }

  const scoresTimer = setInterval(() => {
    for (const room of rooms.map.values()) {
      // Only while a run is live, and only if someone actually reported. An idle
      // lobby of 6 must cost zero frames per second, or the server spends its
      // whole life talking to people who are not playing.
      if (room.phase !== 'running' || !room.scoresDirty) continue;
      room.scoresDirty = false;
      broadcast(room, { t: 'scores', players: room.roster() });
    }
  }, scoresMs);

  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      const p = ws._player;
      // Missed the previous round trip: the socket is gone even if `readyState`
      // still says OPEN. terminate() (not close()) because a half-open TCP
      // connection will never complete a closing handshake.
      if (p && p.alive === false) { ws.terminate(); continue; }
      if (p) p.alive = false;
      try { ws.ping(); } catch { /* about to fail its own close path anyway */ }
    }
    // Piggybacked on the heartbeat because it is the same job - turning a
    // non-participant into something the room can stop waiting for - and because
    // the scores sweep skips any room with `scoresDirty` false, which is exactly
    // the wedged room this has to look at.
    const now = Date.now();
    for (const room of rooms.map.values()) sweepIdle(room, now);
  }, pingMs);
  // Timers must not be the reason `node server/index.js` refuses to exit, and in
  // tests they must not keep the runner alive after close().
  pingTimer.unref?.();
  scoresTimer.unref?.();

  function send(player, msg) {
    // OPEN check first: writing to a CLOSING socket throws, and that throw would
    // otherwise propagate out of a broadcast and skip the remaining players.
    if (player.ws.readyState !== 1) return;
    try { player.ws.send(JSON.stringify(msg)); } catch { /* peer died mid-write */ }
  }

  function broadcast(room, msg) {
    const frame = JSON.stringify(msg);
    for (const p of room.players) {
      if (p.ws.readyState !== 1) continue;
      try { p.ws.send(frame); } catch { /* see send() */ }
    }
  }

  /** Every connected socket, room or not — the leaderboard is global. */
  function broadcastAll(msg) {
    const frame = JSON.stringify(msg);
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      try { ws.send(frame); } catch { /* see send() */ }
    }
  }

  function fail(player, code, msg) {
    send(player, { t: 'error', code, msg });
  }

  /** Throttled RATE_LIMIT, and eviction if the client will not take the hint. */
  function rateLimited(player, now) {
    // Evicted clients cost nothing more: no counting, no log line, no frame. One
    // 20,000-frame burst used to produce 19,688 `evicting ...` lines - one per
    // frame that arrived after the close, because every one of them re-entered
    // here and exceeded MAX_VIOLATIONS again. That is a log amplifier an attacker
    // aims at your disk, and RATE_NOTIFY_MS existed to prevent exactly this shape
    // one branch further down.
    if (player.evicted) return;
    // Drain first, then charge. See the MAX_VIOLATIONS comment: a gap-based reset
    // never fires for a steadily overspeed client.
    const drained = ((now - player.lastViolation) / 1000) * VIOLATION_LEAK_PER_SEC;
    player.violations = Math.max(0, player.violations - drained) + 1;
    player.lastViolation = now;
    if (player.violations > MAX_VIOLATIONS) {
      player.evicted = true;
      log('evicting', player.id, 'after', Math.round(player.violations), 'rate violations');
      try { player.ws.close(1008, 'rate limit'); } catch { /* already gone */ }
      return;
    }
    if (now - player.notifiedAt < RATE_NOTIFY_MS) return;
    player.notifiedAt = now;
    fail(player, 'RATE_LIMIT', 'Slow down.');
  }

  /**
   * Detach a player from whatever room it is in and tell the survivors.
   *
   * Shared by `leave` and by socket close on purpose: a disconnect and an
   * explicit leave must leave the room in the same state, or host succession
   * works when tested with a button and not when a tab closes.
   */
  function partRoom(player) {
    const room = player.room;
    if (!room) return;
    const wasHost = room.isHost(player);
    const empty = room.remove(player);
    if (empty) {
      rooms.collect(room);
      dirty.delete(room);
      return;
    }
    if (wasHost) log('host moved to', room.hostId, 'in', room.code);
    markDirty(room);
    // The player who left may have been the last one still playing. Without this
    // check the survivors, who all finished, would wait forever for `over`.
    maybeOver(room);
  }

  /**
   * Release a room wedged by a player who is connected but not playing.
   *
   * The heartbeat only converts DEAD TCP into a leave. A tab left open on a desk
   * still pongs, so a player who walks away mid-run holds `allFinished()` false
   * forever: measured, two players, one finishes, the other never does, and after
   * 3 s (7+ heartbeat rounds) the room is still 'running' and the finished player
   * has received no `over` - permanently. Killing that socket was the only exit.
   *
   * Two conditions, and both exist to make it impossible to cut a LIVE run short:
   *
   * 1. Someone has already finished. A run where nobody is done yet is never
   *    touched, so this can only ever unblock a room that is already blocked, and
   *    a solo player who wanders off is left alone entirely.
   * 2. EVERY unfinished player is stale. If one of them is still reporting, the
   *    room is progressing and `over` is legitimately waiting for them - we do
   *    nothing, and re-check on the next sweep.
   *
   * Why 60 s and not 5: a backgrounded browser tab stops rAF outright, so an
   * alt-tabbed player sends no `status` at all while the tab is hidden. At the
   * documented ~2 Hz, 60 s is 120 consecutive missing frames - long past a GC
   * pause, a tab switch or a mobile screen lock, and still short enough that the
   * players who finished are not staring at a leaderboard that will not resolve.
   * The idle player keeps their last reported score and `won: false`, which is
   * more honest than dropping them out of the standings.
   */
  function sweepIdle(room, now) {
    if (room.phase !== 'running') return;
    if (!room.players.some((p) => p.finished)) return;
    const stale = room.players.filter((p) => !p.finished);
    if (!stale.length) return;
    if (!stale.every((p) => now - Math.max(p.lastStatus, room.startedAt) >= idleMs)) return;
    for (const p of stale) {
      p.finished = true;
      log('idle', p.id, 'in', room.code, 'declared finished: no status for', idleMs, 'ms');
    }
    room.scoresDirty = true;
    maybeOver(room);
  }

  function maybeOver(room) {
    if (room.phase !== 'running' || !room.allFinished()) return;
    // Back to 'lobby', not to a third 'over' state - see Room#phase. The phase
    // flips BEFORE the broadcast so this cannot fire twice for one run, which is
    // the only thing the old 'over' value was actually load-bearing for.
    room.phase = 'lobby';
    broadcast(room, { t: 'over', standings: room.standings() });
  }

  /**
   * Whole-number coercion for anything a client claims about its own run. Shared
   * with publicPlayer via rooms.js so ingest and display cannot disagree; see the
   * comment on intCount for the leaderboard that used to contradict itself.
   */
  const int = intCount;

  function handle(player, msg) {
    const now = Date.now();
    const t = msg.t;

    // hello gates everything: `player.name` is null until it lands, and a
    // roster entry with a null name is what puts `null` in the scoreboard DOM.
    //
    // `top` is exempt because it is a pure read that names nobody: a client asks
    // for the board the moment the socket opens, which is before it has any
    // reason to have introduced itself. `best` is NOT exempt — it writes, and it
    // writes under the name hello established.
    if (!player.name && t !== 'hello' && t !== 'top') return;

    switch (t) {
      case 'hello': {
        const name = cleanName(msg.name);
        if (!name) { fail(player, 'BAD_NAME', 'Pick a name with at least one visible character.'); return; }
        const renamed = player.name !== null;
        player.name = name;
        // welcome is idempotent: `hello` is documented as the first message of
        // every connection *including reconnects*, so a second one is a rename,
        // not an error. Re-announcing the id keeps a reconnecting client from
        // having to remember whether it already knew it.
        send(player, { t: 'welcome', id: player.id });
        if (renamed && player.room) markDirty(player.room);
        return;
      }

      case 'create': {
        // An implicit leave rather than an error. A client that lost a `joined`
        // reply and retried would otherwise be wedged in a room it does not
        // believe it is in.
        partRoom(player);
        const room = rooms.create();
        if (!room) { fail(player, 'ROOM_FULL', 'No room codes available.'); return; }
        room.add(player);
        log(player.name, 'created', room.code);
        send(player, { t: 'joined', code: room.code, you: player.id, players: room.roster() });
        markDirty(room);
        return;
      }

      case 'join': {
        const room = rooms.get(msg.code);
        if (!room) { fail(player, 'NO_ROOM', 'No room with that code.'); return; }
        // Already in it: re-send `joined` rather than returning silently, for the
        // same reason `create` does an implicit leave. A client whose `joined` was
        // lost (or whose handler threw) retries; it used to get back exactly zero
        // frames, which left the Lobby overlay stuck in its joining state with no
        // error to show and no way out but a reload.
        if (room === player.room) {
          send(player, { t: 'joined', code: room.code, you: player.id, players: room.roster() });
          return;
        }
        // 'running', not "not lobby": a room between rounds is joinable. Order
        // matters - a full room that is also mid-run must report IN_PROGRESS,
        // because "come back when they finish" is actionable and "it is full" is
        // not; the run ending is what unblocks the player.
        if (room.phase === 'running') { fail(player, 'IN_PROGRESS', 'That game has already started.'); return; }
        if (room.full) { fail(player, 'ROOM_FULL', 'That room is full.'); return; }
        partRoom(player);
        room.add(player);
        send(player, { t: 'joined', code: room.code, you: player.id, players: room.roster() });
        markDirty(room);
        return;
      }

      case 'leave':
        partRoom(player);
        return;

      case 'ready': {
        const room = player.room;
        // Lobby only, per the contract. Silently ignored mid-run rather than
        // erroring: there is no error code for it and the client has no repair
        // to make.
        if (!room || room.phase !== 'lobby') return;
        const next = !!msg.ready;
        if (next === player.ready) return;   // no frame for a no-op toggle
        player.ready = next;
        markDirty(room);
        return;
      }

      case 'start': {
        const room = player.room;
        if (!room) return;
        // Host check BEFORE the phase check, so a non-host always gets NOT_HOST
        // and never learns anything else about the room's state from the reply.
        if (!room.isHost(player)) { fail(player, 'NOT_HOST', 'Only the host can start.'); return; }
        if (room.phase === 'running') { fail(player, 'IN_PROGRESS', 'The run is already going.'); return; }
        const go = room.start();
        log('start', room.code, 'seed', go.seed, room.players.length, 'players');
        broadcast(room, go);
        // The roster's per-run fields were just zeroed; without this the lobby
        // the client last saw still shows last round's scores.
        markDirty(room);
        return;
      }

      /**
       * The global leaderboard. Deliberately room-independent: a solo run on a
       * machine that happens to reach the server belongs on the board exactly
       * like a run played inside a room, and requiring a room would mean the
       * mode most people play in could never post a score.
       */
      case 'top':
        send(player, { t: 'leaderboard', top: board.top(10) });
        return;

      case 'best': {
        // The name is the SERVER's copy from `hello`, never the one in this
        // frame: a client that could name itself here could post under someone
        // else's entry and overwrite it.
        const changed = board.submit({
          name: player.name,
          score: msg.score,
          wave: msg.wave,
          won: msg.won,
        });
        const frame = { t: 'leaderboard', top: board.top(10) };
        // A change is everyone's business; a rejected submission is only the
        // sender's, and must not cost a broadcast.
        if (changed) broadcastAll(frame); else send(player, frame);
        return;
      }

      case 'status': {
        const room = player.room;
        if (!room || room.phase !== 'running' || player.finished) return;
        if (!player.statusBucket.take(now)) { rateLimited(player, now); return; }
        player.lives = int(msg.lives);
        player.score = int(msg.score);
        player.wave = int(msg.wave);
        player.killed = int(msg.killed);
        player.leaked = int(msg.leaked);
        player.towers = int(msg.towers);
        player.lastStatus = now;
        // Nothing is sent here on purpose - see the header comment.
        room.scoresDirty = true;
        return;
      }

      case 'finished': {
        const room = player.room;
        if (!room || room.phase !== 'running') return;
        // Documented as sent once. A client that sends it twice must not be able
        // to rewrite its final score after seeing everyone else's.
        if (player.finished) return;
        player.finished = true;
        player.won = !!msg.won;
        player.score = int(msg.score);
        player.wave = int(msg.wave);
        room.scoresDirty = true;
        maybeOver(room);
        return;
      }

      default:
        // Unknown types are ignored by contract, so one side can gain a message
        // without breaking the other. Do not answer with an error.
        return;
    }
  }

  wss.on('connection', (ws) => {
    const player = {
      id: `p${++NEXT_ID}`,
      seq: NEXT_ID,
      name: null,
      ws,
      room: null,
      alive: true,
      violations: 0,
      lastViolation: 0,
      notifiedAt: 0,
      /** Closed for abuse; every later frame from it is dropped unparsed. */
      evicted: false,
      /**
       * When `status` last landed. 0 until the first one, which is why every read
       * is max(lastStatus, room.startedAt) - see sweepIdle.
       */
      lastStatus: 0,
      msgBucket: new Bucket(MSG_BURST, MSG_PER_SEC),
      statusBucket: new Bucket(STATUS_BURST, STATUS_PER_SEC),
      ready: false,
      lives: 0, score: 0, wave: 0, killed: 0, leaked: 0, towers: 0,
      finished: false, won: false,
    };
    ws._player = player;

    ws.on('pong', () => { player.alive = true; });

    ws.on('message', (data, isBinary) => {
      // FIRST, before the bucket and before any parse. `ws.close()` does not stop
      // this listener: the frames already in the receive buffer are still decoded
      // and delivered, so an evicted flooder went on being JSON.parse'd and
      // dispatched for the rest of the burst. This line is what makes "close
      // rather than spend the rest of the process's life parsing its JSON" true.
      if (player.evicted) return;
      const now = Date.now();
      if (!player.msgBucket.take(now)) { rateLimited(player, now); return; }
      // Binary frames are not part of the contract at all; a client sending them
      // is not our client.
      if (isBinary) return;

      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      // `typeof null === 'object'` and arrays are objects, so both need ruling
      // out explicitly before any property read. A bare JSON array is the first
      // thing a fuzzer sends.
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (typeof msg.t !== 'string') return;

      // One client's bug must not be a room-wide outage. Everything above this
      // line is cheap validation; everything below can touch shared state, so a
      // throw from it is caught, logged and confined to the sender.
      try {
        handle(player, msg);
      } catch (err) {
        log('handler threw on', msg.t, 'from', player.id, err && err.stack ? err.stack : err);
      }
    });

    ws.on('close', () => {
      try { partRoom(player); } catch (err) { log('close cleanup failed', err); }
      ws._player = null;
    });

    // Without this, a socket-level error (RST mid-write, TLS abort) reaches the
    // 'error' event with no listener, and ws rethrows it as an uncaught
    // exception that takes the whole server down with it.
    ws.on('error', (err) => { log('socket error', player.id, err && err.message); });
  });

  wss.on('error', (err) => { log('server error', err && err.message); });

  function close() {
    // Flush any debounced write before the process can exit, or the last run of
    // the session is the one that never makes it to disk.
    board.close();
    clearInterval(scoresTimer);
    clearInterval(pingTimer);
    if (lobbyTimer) { clearTimeout(lobbyTimer); lobbyTimer = null; }
    dirty.clear();
    for (const ws of wss.clients) { try { ws.terminate(); } catch { /* already gone */ } }
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  return { wss, rooms, board, close, port: wss.options?.port ?? opts.port ?? DEFAULT_PORT };
}

/**
 * Auto-start only when this file IS the entry point. Importing it from a test
 * (or from a future combined dev server) must not seize port 5274 as a side
 * effect of the import.
 */
function isEntryPoint() {
  const argv = process.argv[1];
  if (!argv) return false;
  // pathToFileURL, not string concatenation: it is the only thing that agrees
  // with import.meta.url about percent-encoding and about Windows drive letters.
  try { return import.meta.url === pathToFileURL(argv).href; } catch { return false; }
}

if (isEntryPoint()) {
  const port = Number(process.env.PORT) || 5274;

  // noServer: ws must not open its own listener. One process, one port, one
  // certificate — which is the entire reason CORS and mixed-content cannot
  // happen to this deployment.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const srv = createServer({ wss, leaderboardFile: process.env.LEADERBOARD_FILE || null });

  const http = createHttpServer((req, res) => serveStatic(req, res));

  http.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* falls through to 400 */ }
    if (pathname !== WS_PATH) {
      // A bare destroy() leaves the client waiting for the handshake timeout.
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // 0.0.0.0, not localhost: Render routes to the container's external
  // interface, and a server bound to 127.0.0.1 answers nothing and reports no
  // error — the health check just times out.
  http.listen(port, '0.0.0.0', () => console.log(`[mp] listening on :${port} (ws ${WS_PATH})`));
  http.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') { console.error(`[mp] port ${port} in use; not starting`); process.exit(1); }
  });

  const bye = () => { srv.close().then(() => http.close(() => process.exit(0))); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
