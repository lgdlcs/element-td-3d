/**
 * Browser-side transport for the room protocol in docs/MULTIPLAYER.md.
 *
 * THE ONE RULE THIS FILE EXISTS TO OBEY: it must be impossible for the network
 * to break single-player.
 *
 * `npm run dev` with no server running has to give a fully playable game, so
 * every entry point here is written on the assumption that there is nothing on
 * the other end. Concretely, and each of these is a real failure mode rather than
 * defensive habit:
 *
 *  - `connect()` never rejects. It resolves `false`. An awaited promise that
 *    rejects during boot takes the boot sequence with it, and `new WebSocket()`
 *    to a dead host reports failure asynchronously via an `error` event, i.e. at
 *    a moment when nobody is left in a try/catch to hear it.
 *  - `connect()` settles on a timer, not only on socket events. A host that
 *    accepts the TCP connection and never completes the WebSocket handshake
 *    (a captive portal, a proxy, an unrelated server on 5274) leaves the socket
 *    in CONNECTING indefinitely; without the timer, `await net.connect()` hangs
 *    forever and the game never boots.
 *  - Every send helper is a no-op when offline. Callers are game code — `status`
 *    is called from the frame loop — and a transport that throws once per frame
 *    when nobody is hosting is worse than no transport.
 *  - Reconnect attempts are bounded. An infinite backoff loop against a server
 *    that will never exist is a background tab burning battery and a console
 *    filling with errors that make every other bug harder to find.
 *
 * WHAT THIS DOES NOT DO
 *
 * No queueing of messages sent while offline or reconnecting. The protocol is a
 * lobby plus a ~2 Hz status feed: a `ready` toggle or a status frame that arrives
 * five seconds late is worse than one that was dropped, and replaying a queued
 * `start` after a reconnect would launch a run the host has since abandoned.
 * Dropping is the honest behaviour, and `lobby` broadcasts resync the UI anyway.
 */

/** Contract default. The page is served from 5273 by vite; the ws server is 5274. */
const DEFAULT_PORT = 5274;

/** Must match WS_PATH in server/index.js. */
const WS_PATH = '/ws';

/** Ports that mean "vite is serving this page" — dev (5273) and preview (4173). */
const VITE_PORTS = new Set(['5273', '4173']);

/**
 * How long a connection attempt may sit unresolved. Short on purpose: this
 * number is added to the boot time of a single-player game whenever no server is
 * running, and on localhost a refused connection lands in single-digit
 * milliseconds anyway — the timeout only ever fires for a host that is hanging.
 */
const OPEN_TIMEOUT_MS = 2500;

/** Bounded backoff, in ms. Length of the array is the attempt limit. */
const BACKOFF_MS = [400, 900, 2000, 4000];

/** ~2 Hz, per the contract. The server rate-limits and answers RATE_LIMIT. */
const STATUS_INTERVAL_MS = 500;

/**
 * The nominal spectate snapshot period: 10 Hz, per docs/MULTIPLAYER.md. Exported
 * so the streamer paces itself off the same number the transport enforces rather
 * than a second copy that can drift from it.
 */
export const SNAP_INTERVAL_MS = 100;

/**
 * The FLOOR `snap()` enforces, deliberately below SNAP_INTERVAL_MS.
 *
 * A caller aiming at 10 Hz off a 60 fps frame loop lands on 100 ms +/- one frame
 * (16.7 ms); a floor set exactly at 100 would silently eat every early frame and
 * turn a 10 Hz stream into ~8 Hz with a visible hitch. 90 ms passes an honest
 * 10 Hz caller untouched while clamping a caller that forgot to throttle at all
 * to ~11 Hz - under the server's 12/s snap bucket, so a bug in the streamer
 * cannot earn a RATE_LIMIT that also throttles the lobby.
 */
const SNAP_MIN_INTERVAL_MS = 90;

/**
 * Skip a snapshot when this much is already queued in the socket.
 *
 * Snapshots are cosmetic and self-healing (the format carries a periodic
 * keyframe), so on a slow uplink the right failure is a picture that drops
 * frames, never a send queue that grows without bound and eventually delays the
 * `finished` frame that decides the standings.
 */
const SNAP_BACKPRESSURE_BYTES = 48 * 1024;

/** Server message types, so an unknown `t` can be ignored rather than dispatched. */
const SERVER_TYPES = new Set([
  'welcome', 'joined', 'lobby', 'go', 'scores', 'over', 'error', 'leaderboard',
  'watching', 'watched', 'snap', 'unwatch',
]);

export class NetClient {
  constructor() {
    /** @type {WebSocket|null} */
    this._ws = null;
    this._url = '';
    this._name = '';
    /** 'offline' | 'connecting' | 'online' */
    this._state = 'offline';
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();

    this._attempt = 0;
    this._retryTimer = null;
    this._openTimer = null;
    /** In-flight connect() promise and its resolver, so connect() is idempotent. */
    this._pending = null;
    this._settle = null;
    /** Latched once the caller asks to disconnect, so backoff does not fight them. */
    this._wanted = false;

    this._lastStatusAt = 0;
    this._lastSnapAt = 0;
    /** @type {number|null} */
    this._latency = null;
    this._helloAt = 0;

    this.id = null;
    this.code = null;

    // -- spectate ------------------------------------------------------------
    //
    // Both of these are SERVER-DERIVED and never set optimistically. `watch()`
    // does not set `watching`; the `watching` frame does. The reason is the whole
    // point of the counter: a client that assumed it was being watched would
    // start producing snapshots the server then drops, which is precisely the
    // "costs nothing when nobody is looking" property the design is built on.

    /** @type {string|null} Player id whose board we are subscribed to. */
    this.watching = null;
    /** @type {string|null} That player's name, as the server knows it. */
    this.watchingName = null;
    /** How many players are watching OUR board. 0 means: do not build snapshots. */
    this.watchers = 0;

    /**
     * Convenience callbacks for the spectate layer, alongside the generic
     * on('snap') / on('watched') events - both fire, use whichever suits.
     * @type {?(snap: object) => void}
     */
    this.onBoardSnapshot = null;
    /** @type {?(n: number, streaming: boolean) => void} */
    this.onWatcherCountChanged = null;
    /** @type {?(info: {id: string, name: string}) => void} */
    this.onWatching = null;
    /** @type {?(info: {id: string|null, reason: string}) => void} */
    this.onUnwatch = null;
  }

  /**
   * True while at least one player is subscribed to our board.
   *
   * THE GATE THE STREAMER MUST READ. When this is false, do not encode a
   * snapshot - not "encode it and let send() drop it". Encoding is the expensive
   * half (a full creep sweep plus a JSON.stringify every 100 ms), and the server
   * discards an unwatched `snap` before it even looks at it, so a client that
   * streams unconditionally pays the entire cost for exactly nothing.
   * @returns {boolean}
   */
  get streaming() { return this.watchers > 0; }

  /**
   * Bytes queued in the socket and not yet on the wire. Used by the snapshot
   * backpressure rule; 0 when offline.
   * @returns {number}
   */
  get bufferedAmount() { return this._ws?.bufferedAmount ?? 0; }

  /** @returns {'offline'|'connecting'|'online'} */
  get state() { return this._state; }
  get online() { return this._state === 'online'; }

  /**
   * Round-trip time in ms, or null if it has never been measured.
   *
   * This is ONE honest sample per connection: the gap between sending `hello` and
   * receiving `welcome`, which is the only request/response pair the contract
   * has. There is no ping message, and inventing one would mean adding a message
   * type to a wire format I was told not to extend. `scores` cannot be used —
   * the server emits it on its own ~2 Hz timer, so the delay since our last
   * `status` is mostly the server's schedule and would read as 200ms of latency
   * on a loopback connection. A stale-but-real number beats a live fake one.
   * @returns {number|null}
   */
  get latency() { return this._latency; }

  // -- events --------------------------------------------------------------

  /**
   * @param {string} type any server message type, or 'open' | 'close' | 'offline' | 'error'
   * @param {(payload: any) => void} fn
   */
  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) this._handlers.set(type, set = new Set());
    set.add(fn);
    return this;
  }

  off(type, fn) {
    this._handlers.get(type)?.delete(fn);
    return this;
  }

  /** Invoke one of the convenience callbacks with the same isolation as _emit. */
  _call(name, ...args) {
    const fn = this[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (err) { console.error(`[net] ${name} threw`, err); }
  }

  _emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    // Iterate a copy: a handler that calls off() (a one-shot 'go' listener, say)
    // would otherwise mutate the set mid-iteration.
    for (const fn of Array.from(set)) {
      // One throwing UI handler must not stop the remaining handlers, and must
      // never propagate into a socket event handler, where the exception would
      // surface as an unattributable "Uncaught (in promise)" with no stack into
      // game code.
      try { fn(payload); } catch (err) { console.error(`[net] handler for "${type}" threw`, err); }
    }
  }

  // -- connection ----------------------------------------------------------

  /**
   * The endpoint, in three cases and in this order.
   *
   *   1. `?server=` wins, always. It is the only escape hatch for pointing a
   *      phone at a laptop, or a prod page at a local server.
   *   2. Production is SAME ORIGIN with the scheme upgraded. The page and the
   *      socket are one node process behind one Render certificate, so
   *      `https:` -> `wss:` is not a guess, it is the deployment. Deriving it
   *      from `location` is also the only thing that makes a Render PREVIEW
   *      deploy work: those get a fresh hostname per branch and nothing is
   *      configured for them.
   *   3. Dev is the exception, and the test is the PORT, not the protocol.
   *      Under `npm run dev` the page comes from vite on 5273 while the lobby
   *      server is a separate process on 5274; same-origin there would send the
   *      upgrade to vite, which answers 400 and leaves the player silently
   *      offline. Only the two vite ports get redirected.
   *
   * Reads `location` defensively because this module is also loaded by node in
   * tools/scratch/netcheck.mjs, where `location` does not exist.
   * @returns {string}
   */
  static defaultUrl() {
    const loc = typeof location !== 'undefined' ? location : null;
    if (loc?.search) {
      const q = new URLSearchParams(loc.search).get('server');
      if (q) return q;
    }
    if (!loc) return `ws://localhost:${DEFAULT_PORT}${WS_PATH}`;

    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    // `location.hostname` and not 'localhost': the game is regularly opened
    // from a phone on the LAN, and hardcoding localhost points the client at
    // the phone itself.
    const host = loc.hostname || 'localhost';
    if (VITE_PORTS.has(loc.port)) return `${scheme}//${host}:${DEFAULT_PORT}${WS_PATH}`;

    // `loc.host`, not `loc.hostname`: it carries the port when it is not the
    // scheme default, which is what makes `node server/index.js` + browsing to
    // http://localhost:5274/ work with no special case.
    return `${scheme}//${loc.host}${WS_PATH}`;
  }

  /**
   * Open a connection. NEVER throws, NEVER rejects, and always settles within
   * roughly OPEN_TIMEOUT_MS.
   * @param {string} [url]
   * @returns {Promise<boolean>} true if online, false if it fell back to offline
   */
  connect(url) {
    this._wanted = true;
    this._url = url || this._url || NetClient.defaultUrl();

    if (this._state === 'online') return Promise.resolve(true);
    // A second connect() while the first is in flight must not open a second
    // socket; hand back the same pending settle instead.
    if (this._pending) return this._pending;

    // An explicit connect() is a fresh intent, so it gets the full attempt
    // budget back even if a previous run exhausted it.
    this._attempt = 0;
    this._pending = new Promise((resolve) => { this._settle = resolve; });
    this._open();
    return this._pending;
  }

  /** Deliberate disconnect: no reconnect, no 'offline' retry storm. */
  disconnect() {
    this._wanted = false;
    this._clearTimers();
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      // Drop the handlers first, or close() re-enters _onClose and schedules a
      // reconnect for a connection the caller just asked us to abandon.
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* already dead; nothing to salvage */ }
    }
    this._setState('offline');
    this._settleWith(false);
  }

  _open() {
    const WS = typeof WebSocket !== 'undefined' ? WebSocket : globalThis.WebSocket;
    if (!WS) {
      // No WebSocket at all (an old embedded webview, a node run without a
      // polyfill). Not an error the player can act on — just no multiplayer.
      this._goOffline('no-websocket');
      return;
    }

    this._setState('connecting');
    let ws;
    try {
      ws = new WS(this._url);
    } catch (err) {
      // Synchronous throw: malformed URL, or a mixed-content block on an https
      // page (ws:// from https:// is refused by the browser before any I/O).
      this._goOffline(String(err?.message || err));
      return;
    }
    this._ws = ws;

    // Last-resort bound on a socket that is neither opening nor failing.
    this._openTimer = setTimeout(() => {
      this._openTimer = null;
      if (this._ws !== ws || this._state === 'online') return;
      this._fail(ws, 'timeout');
    }, OPEN_TIMEOUT_MS);

    ws.onopen = () => {
      if (this._ws !== ws) return;
      this._clearTimer('_openTimer');
      this._attempt = 0;
      this._setState('online');
      // The contract says hello is first on EVERY connection, reconnects
      // included, and the server assigns an id per connection — so a reconnect
      // that skips this leaves us connected and anonymous, with the server
      // holding no name for us.
      if (this._name) this._sendHello();
      this._emit('open', { url: this._url });
      this._settleWith(true);
    };

    ws.onmessage = (ev) => {
      if (this._ws !== ws) return;
      this._onFrame(ev.data);
    };

    // Neither event carries a useful reason (by design: a script must not be able
    // to tell a refused port from a filtered one), so both are treated as the
    // same thing — this attempt is over.
    //
    // WHY ERROR DRIVES THE STATE MACHINE AND NOT JUST CLOSE
    //
    // Measured: node 22's built-in WebSocket (undici) fires `error` on a refused
    // connection and then NEVER fires `close`, leaving readyState at CONNECTING
    // (0) permanently — tools/scratch/netcheck.mjs caught exactly this. With
    // close as the only failure path, every attempt cost the full
    // OPEN_TIMEOUT_MS, so "settles fast" degraded to 2.5s per attempt and giving
    // up took 17s. Browsers do fire close, so this is belt-and-braces there, but
    // it is load-bearing on any implementation that does not. `_fail` detaches
    // the socket first, so the close that may follow hits the identity guard
    // instead of being counted as a second failed attempt.
    ws.onerror = () => {
      if (this._ws !== ws) return;
      this._emit('error', { code: 'TRANSPORT', msg: 'socket error' });
      // readyState 1 (OPEN) means a live connection reported something advisory;
      // anything else means the socket is gone whether or not close ever comes.
      if (ws.readyState !== 1) this._fail(ws, this._state === 'online' ? 'closed' : 'refused');
    };

    ws.onclose = () => {
      if (this._ws !== ws) return;
      this._fail(ws, this._state === 'online' ? 'closed' : 'refused');
    };
  }

  /** End one attempt: detach the socket, announce a lost session, then retry. */
  _fail(ws, reason) {
    this._clearTimer('_openTimer');
    if (this._ws === ws) this._ws = null;
    try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch { /* noop */ }
    // Close a socket that may still be half-open: undici leaves a failed
    // connection in CONNECTING forever, and an abandoned one keeps its handle.
    try { ws.close(); } catch { /* already dead */ }

    const wasOnline = this._state === 'online';
    if (wasOnline) {
      // Both are per-connection facts assigned by the server. Keeping a stale id
      // across a reconnect means the scoreboard filters "me" by an id nobody has.
      this.id = null;
      this.code = null;
      // A reconnect gets a NEW player id and, per the contract, comes back
      // outside its old room - so every subscription in both directions is gone
      // whether or not we hear about it. Latching `watchers` at its last value
      // would leave a streamer encoding snapshots for nobody, forever.
      this._resetWatch();
      this._emit('close', { reason });
    }
    this._retryOrOffline(reason);
  }

  _onFrame(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      // A malformed frame is the server's problem, not a reason to tear down a
      // working connection or to throw inside an event handler.
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    // Unknown types are ignored by both sides on purpose, so the server can gain
    // a message type without this client breaking.
    if (!SERVER_TYPES.has(msg.t)) return;

    if (msg.t === 'welcome') {
      this.id = msg.id ?? null;
      // Only trust the sample if this welcome answers a hello we actually timed.
      if (this._helloAt) {
        this._latency = Math.max(0, Math.round(now() - this._helloAt));
        this._helloAt = 0;
      }
    } else if (msg.t === 'joined') {
      this.code = msg.code ?? null;
      // A room change cannot carry a subscription with it: `watch` is scoped to
      // one room and the server has already dropped it.
      this._resetWatch();
    } else if (msg.t === 'lobby') {
      this.code = msg.code ?? this.code;
    } else if (msg.t === 'watching') {
      this.watching = msg.id ?? null;
      this.watchingName = typeof msg.name === 'string' ? msg.name : null;
      // Untrusted: a name from another machine. Every consumer must escape it
      // before it reaches the DOM (uikit.js `esc`), same rule as the roster.
      this._call('onWatching', { id: this.watching, name: this.watchingName });
    } else if (msg.t === 'unwatch') {
      // Idempotent on purpose. `leave()` tears the subscription down locally and
      // the server's `unwatch` arrives a moment later saying the same thing; a
      // second onUnwatch would make the spectate view unwind twice.
      if (this.watching) {
        this.watching = null;
        this.watchingName = null;
        this._call('onUnwatch', { id: msg.id ?? null, reason: typeof msg.reason === 'string' ? msg.reason : 'gone' });
      }
    } else if (msg.t === 'watched') {
      const n = Number.isFinite(msg.n) ? Math.max(0, msg.n | 0) : 0;
      // Fire only on a real change: the server coalesces, but a reconnect or a
      // duplicate must not restart a streamer that is already running.
      if (n !== this.watchers) {
        this.watchers = n;
        this._call('onWatcherCountChanged', n, n > 0);
      }
    } else if (msg.t === 'snap') {
      this._call('onBoardSnapshot', msg);
    }

    this._emit(msg.t, msg);
  }

  _retryOrOffline(reason) {
    if (!this._wanted) { this._setState('offline'); this._settleWith(false); return; }
    if (this._attempt >= BACKOFF_MS.length) { this._goOffline(reason); return; }

    const wait = BACKOFF_MS[this._attempt++];
    this._setState('connecting');
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._open(); }, wait);

    // Settle the ORIGINAL connect() promise now rather than holding it across
    // the whole backoff ladder. The caller asked "can I go online right now" as
    // part of booting; making them wait ~7s for the last retry is exactly the
    // boot-blocking this file is meant to prevent. Reconnect continues in the
    // background and announces itself with 'open'.
    this._settleWith(false);
  }

  _goOffline(reason) {
    this._clearTimers();
    this._setState('offline');
    this._emit('offline', { reason, url: this._url });
    this._settleWith(false);
  }

  _setState(s) {
    if (this._state === s) return;
    this._state = s;
  }

  /** Resolve the pending connect() exactly once; later calls are no-ops. */
  _settleWith(ok) {
    const settle = this._settle;
    this._settle = null;
    this._pending = null;
    if (settle) settle(ok);
  }

  _clearTimer(key) {
    if (this[key] != null) { clearTimeout(this[key]); this[key] = null; }
  }

  _clearTimers() {
    this._clearTimer('_openTimer');
    this._clearTimer('_retryTimer');
  }

  // -- sending -------------------------------------------------------------

  /**
   * The single choke point through which every helper below sends, so "safe to
   * call while offline" is one guard rather than eight.
   * @returns {boolean} whether it actually went out
   */
  send(t, payload) {
    const ws = this._ws;
    if (this._state !== 'online' || !ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ t, ...payload }));
      return true;
    } catch {
      // send() throws if the socket died between the readyState check and here.
      // Callers are in a frame loop and have no useful response to this.
      return false;
    }
  }

  /**
   * Remembered even when offline: the name is needed to re-send hello on every
   * future reconnect, and the lobby UI collects it before the socket exists.
   */
  hello(name) {
    if (typeof name === 'string' && name.trim()) this._name = name.trim().slice(0, 16);
    return this._sendHello();
  }

  _sendHello() {
    if (!this._name) return false;
    const t = now();
    const ok = this.send('hello', { name: this._name });
    // Only start the latency clock if the frame left, otherwise the next
    // `welcome` would be measured against a hello that was never sent.
    this._helloAt = ok ? t : 0;
    return ok;
  }

  create() { return this.send('create', {}); }

  /**
   * Codes are case-insensitive per the contract, but uppercasing here keeps the
   * value we echo into our own UI consistent with what the server sends back.
   */
  join(code) { return this.send('join', { code: String(code || '').trim().toUpperCase() }); }

  leave() {
    const ok = this.send('leave', {});
    this.code = null;
    // Subscriptions are room-scoped. The server says the same thing a moment
    // later; doing it here means the spectate view is gone by the time the lobby
    // overlay reappears rather than one round trip after it.
    this._resetWatch();
    return ok;
  }

  ready(ready) { return this.send('ready', { ready: !!ready }); }

  start() { return this.send('start', {}); }

  /**
   * Throttled to ~2 Hz here, not at the call site, because the call site is the
   * frame loop: at 60 fps an unthrottled status is 30x the contract rate, which
   * earns a RATE_LIMIT error and, on a busy room, gets the whole client throttled
   * for everyone's benefit but ours. Game code should be free to call this every
   * frame without knowing any of that.
   * @param {{lives:number,score:number,wave:number,killed:number,leaked:number,towers:number}} obj
   */
  status(obj) {
    const t = now();
    if (t - this._lastStatusAt < STATUS_INTERVAL_MS) return false;
    // Stamp before the send attempt: if we are offline, the send is a no-op, and
    // stamping only on success would re-test the socket 60 times a second.
    this._lastStatusAt = t;
    return this.send('status', {
      lives: obj?.lives | 0,
      score: obj?.score | 0,
      wave: obj?.wave | 0,
      killed: obj?.killed | 0,
      leaked: obj?.leaked | 0,
      towers: obj?.towers | 0,
    });
  }

  /**
   * Sent once when the run ends. Deliberately NOT throttled — it is the frame
   * that decides the standings, and dropping it because a status went out 100ms
   * ago would leave this player permanently "still playing" and stop the room
   * from ever reaching `over`.
   * @param {{score:number,wave:number,won:boolean}} obj
   */
  finished(obj) {
    return this.send('finished', {
      score: obj?.score | 0,
      wave: obj?.wave | 0,
      won: !!obj?.won,
    });
  }

  // -- spectate --------------------------------------------------------------

  /**
   * Drop both directions of the subscription locally and tell the listeners.
   * Never sends: it is used on paths where the socket is already gone or where
   * the server has already made the same decision.
   */
  _resetWatch() {
    const hadWatchers = this.watchers > 0;
    if (this.watching) {
      const id = this.watching;
      this.watching = null;
      this.watchingName = null;
      this._call('onUnwatch', { id, reason: 'gone' });
    }
    this.watchers = 0;
    this._lastSnapAt = 0;
    if (hadWatchers) this._call('onWatcherCountChanged', 0, false);
  }

  /**
   * Subscribe to another player's board.
   *
   * Does NOT set `this.watching` - the server's `watching` frame does, and until
   * it lands nothing has been agreed. The subscription is refused (`error`
   * `BAD_WATCH` / `NO_PLAYER`) unless the target is in your room, the run is
   * live, and the target has not finished. At most one at a time: a second
   * `watch` replaces the first, server-side, with no extra frame from you.
   *
   * @param {string} id player id, from a `scores`/`lobby` roster entry
   * @returns {boolean} whether the request left this machine
   */
  watch(id) {
    if (typeof id !== 'string' || !id) return false;
    return this.send('watch', { id });
  }

  /**
   * Stop watching. Answered with `unwatch { reason: 'gone' }`, so the teardown
   * path is the same one an involuntary stop takes and there is only one place
   * the spectate view is dismantled.
   */
  unwatch() { return this.send('watch', { id: null }); }

  /**
   * Send one board snapshot to whoever is watching us.
   *
   * Three guards, all of them the transport's job rather than the caller's:
   *
   *  1. Nobody is watching -> nothing is sent. Callers should ALSO check
   *     `net.streaming` before encoding, because the expensive half is building
   *     the payload, not sending it. This is the backstop, not the optimisation.
   *  2. A floor of SNAP_MIN_INTERVAL_MS, for the same reason `status()` throttles
   *     at the transport: the call site is a frame loop, and an unthrottled 60 Hz
   *     snap earns a RATE_LIMIT that throttles the whole client, lobby included.
   *  3. Backpressure. A snapshot is cosmetic and the format resyncs itself with a
   *     periodic keyframe, so a slow uplink must drop frames rather than grow a
   *     queue that eventually delays `finished`.
   *
   * The payload is relayed opaquely; the server stamps `from` and never reads
   * further. Keep it under 8 KB serialised or the server drops the frame and
   * answers `TOO_BIG`.
   *
   * @param {object} payload the snapshot body, per docs/MULTIPLAYER.md
   * @returns {boolean} whether it actually went out
   */
  snap(payload) {
    if (this.watchers === 0) return false;
    const t = now();
    if (t - this._lastSnapAt < SNAP_MIN_INTERVAL_MS) return false;
    if (this.bufferedAmount > SNAP_BACKPRESSURE_BYTES) return false;
    // Stamped before the attempt, exactly like status(): when offline the send is
    // a no-op and stamping only on success would re-test the socket every frame.
    this._lastSnapAt = t;
    return this.send('snap', payload);
  }

  /** Ask for the global top scores. The reply is a `leaderboard` frame. */
  requestTop() { return this.send('top', {}); }

  /**
   * Offer a finished run to the GLOBAL leaderboard — a different thing from
   * `finished`, which only settles the standings inside a room.
   *
   * No name is sent: the server posts under the name it already holds from
   * `hello`, so this cannot be used to write into someone else's entry.
   */
  best(obj) {
    return this.send('best', {
      score: obj?.score | 0,
      wave: obj?.wave | 0,
      won: !!obj?.won,
    });
  }
}

/**
 * Monotonic where available. `performance.now()` cannot be moved by an NTP step
 * or a user changing the clock, either of which would make a throttle window
 * measured with Date.now() either never elapse or elapse forever.
 */
function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
