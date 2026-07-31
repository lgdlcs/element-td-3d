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

/** Server message types, so an unknown `t` can be ignored rather than dispatched. */
const SERVER_TYPES = new Set(['welcome', 'joined', 'lobby', 'go', 'scores', 'over', 'error', 'leaderboard']);

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
    /** @type {number|null} */
    this._latency = null;
    this._helloAt = 0;

    this.id = null;
    this.code = null;
  }

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
   * Default endpoint, per the contract: `ws://<page hostname>:5274`, overridable
   * with `?server=ws://host:port`.
   *
   * Reads `location` defensively because this module is also loaded by node in
   * tools/scratch/netcheck.mjs, where `location` does not exist; a bare
   * `location.hostname` here would be a TypeError at import-adjacent time.
   * @returns {string}
   */
  static defaultUrl() {
    const loc = typeof location !== 'undefined' ? location : null;
    if (loc?.search) {
      const q = new URLSearchParams(loc.search).get('server');
      if (q) return q;
    }
    // `location.hostname` and not 'localhost': the game is regularly opened from
    // a phone on the LAN, and hardcoding localhost there points the client at the
    // phone itself.
    const host = loc?.hostname || 'localhost';
    return `ws://${host}:${DEFAULT_PORT}`;
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
    } else if (msg.t === 'lobby') {
      this.code = msg.code ?? this.code;
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
