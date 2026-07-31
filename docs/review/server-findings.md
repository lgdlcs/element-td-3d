# Review findings: server (NEEDS_WORK)

## Evidence the reviewer actually ran

Everything below was executed against the real `server/index.js` on spare ports with real `ws` clients (ws 8.21.1, node 22.22.0). Scripts: /private/tmp/claude-501/-Users-pouetpouets-code/c57263d9-aa43-4151-90a5-60492452382f/scratchpad/srvrev/srv-attack-{1,2,3,4}.mjs

RUN 1 (34 assertions, 0 failures) — two rooms with concurrent activity (distinct codes, per-room shared seeds, no cross-room leakage); 1000/s `status` flood from one client -> roommate received 1 `scores` frame in 3.4 s, so one client does NOT drive the room's broadcast rate (coalescing works as designed); 26 malformed frames (`{`, ``, `null`, `[]`, `[1,2,3]`, `42`, `"str"`, `{"t":123}`, `{"t":"__proto__"}`, `{"__proto__":{"polluted":1},...}`, `{"t":"constructor"}`, `{"t":"join","code":"__proto__"}`, `{"t":"join","code":{"a":1}}`, 4000-deep nested array, 4000-char name) -> client never disconnected, `Object.prototype` unpolluted, room still functional; 40 KB frame -> close 1009, server unaffected; 7th player -> ROOM_FULL; non-host `start` -> NOT_HOST and phase stayed 'lobby'; join after `go` -> IN_PROGRESS; double `finished` did not rewrite the score (stayed 100, not 99999); 30x `create` from one socket leaked at most 1 room; `close()` freed the port; all 11 documented `players[]` fields present (extra: `towers`, contractually ignorable).

RUN 2 — REAL half-open TCP (raw net socket, hand-written HTTP/1.1 101 handshake, masked text frames, then `pause()` so protocol-level pongs stop): zombie joined the roster and was evicted 200 ms after the missed ping round trip, host succession fired, `partRoom` ran. This reproduces the scenario the implementer listed as "not verified"; it works. Also: 20,000 codes generated, alphabet exactly `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, no I/O/0/1, no collisions; `cleanName` edge cases all correct (`"​​"` -> null, 40 chars -> 16, U+202E stripped, emoji clamped by UTF-16 units to 16).

RUN 2/3/4 produced the eight findings above; each finding's `why_it_matters` quotes the actual printed output.

Ownership/dependency check: `grep -n "createServer|rooms.js|server/index|cleanName|publicPlayer|MAX_PLAYERS" src/main.js src/game/Game.js src/ui/ui.css index.html package.json` matched only the two pre-existing `server` / `dev:mp` npm scripts. dependencies are exactly `{three, ws}`; no `.ts`/`.d.ts` under server/. `import('./server/index.js')` has no side effect (guarded by `isEntryPoint()`); verified indirectly by every test importing `createServer` without the default port 5274 ever being seized.

NOT verified: behaviour above ~300 concurrent sockets; actual code-space exhaustion (would need ~1.05M rooms); production PING_MS=15000 timing (tested at 400 ms via `opts.pingMs`); TLS/wss; anything about how src/ui/* renders these frames beyond confirming src/main.js's `lobby` handler does not re-open the overlay mid-run.

## Findings

### [major] server/rooms.js:195

**`int()` accepts any finite number but `publicPlayer` truncates with `|0`, so `standings()` ranks on the raw value while every client displays the truncated one — a client can take rank #1 while showing score 0 / wave 0, and legitimate-looking values render negative.**

Ran it: two players finish, one sends `finished {score:1e308, wave:1e308, won:false}`, the other `{score:5, wave:5, won:false}`. The broadcast `over` is `standings: [["Q1",0,0],["Q2",5,5]]` — Q1 is ranked FIRST while displaying 0/0 above Q2's 5/5, so the leaderboard order contradicts its own numbers. Same defect in `scores`: `status {score:4294967303, wave:2147483648}` is relayed as `{"score":7,"wave":-2147483648}`. `standings()` sorts on `b.wave - a.wave` / `b.score - a.score` (rooms.js:152-157) using the untruncated values stored by `int()` (index.js:227-229), then maps through `publicPlayer`'s `p.wave | 0`. The two must use the same clamp; `int()` should clamp to 0..2^31-1.

### [major] server/index.js:275

**A room whose run has ended (`phase === 'over'`) is permanently unjoinable and answers `IN_PROGRESS` / "That game has already started" for a game that is finished. Nothing ever returns the phase to 'lobby'.**

Ran it: solo host creates + starts + sends `finished`; room phase is `over`. A second client sending `join` with that code gets `{"t":"error","code":"IN_PROGRESS","msg":"That game has already started."}` and is not added (roster stays at 1). Since `start` is explicitly allowed from `over` (index.js:307 only blocks 'running'), the room plays round 2, 3, … but a friend who wants to join between rounds is locked out forever and told the opposite of what is true. The contract only sanctions refusing joins "once a run has started"; an ended run is not a started one.

### [major] server/index.js:186

**Eviction logging is unbounded: every message buffered after `ws.close(1008)` re-enters `rateLimited`, exceeds MAX_VIOLATIONS again, and writes another `evicting …` line — one log line per hostile frame.**

Ran it with a capturing `log`: a single 20,000-frame `status` burst from one socket produced **19,688** `evicting p1 after N rate violations` lines (total log lines 19,688). The header comment at index.js:57-61 correctly identifies this amplification shape for RATE_LIMIT frames and guards it with RATE_NOTIFY_MS, then reintroduces it on the eviction path. An attacker reconnecting in a loop writes megabytes to stdout/journald per second and fills the disk; the comment's claim "Close rather than spend the rest of the process's life parsing its JSON" is also false — `close()` does not stop the message handler, so the frames are still parsed and dispatched.

### [major] server/index.js:182

**Any *sustained* rate above STATUS_PER_SEC=5 eventually hard-disconnects the player with 1008, however mild, because the 5 s decay window can never elapse — `player.lastViolation` is refreshed on every violation.**

Ran it against the real server on a spare port: `status` at 8 Hz (4x the documented ~2 Hz, the sort of rate a client bug that ticks status off a sim frame produces) → socket closed with code 1008 after **150.7 s**, mid-run, after 61 RATE_LIMIT frames. At 15 Hz → closed after 36.3 s. The player is ejected from their game and from the room; the survivors then get `over` computed without them. `if (now - player.lastViolation > VIOLATION_WINDOW_MS) player.violations = 0` only resets after a quiet gap, and a continuously-overspeed client never produces one, so the implementer's stated rationale ("Only violations inside one continuous burst count") does not hold for any steady overspeed. The contract sanctions `RATE_LIMIT` for excess rate, not disconnection. Decay should be time-based (leak the counter), not gap-based.

### [minor] server/index.js:271

**`join` for a room the socket is already in returns silently with no frame, unlike `create`, which explicitly handles the same lost-reply retry.**

Ran it: client creates room, then sends `join` with its own code — zero frames received in 200 ms. index.js:255-258 documents exactly this hazard for `create` ("A client that lost a `joined` reply and retried would otherwise be wedged in a room it does not believe it is in") and fixes it there. On the `join` path a client whose `joined` frame was lost, or whose handler threw, retries and gets nothing back, leaving the Lobby overlay stuck in its joining state with no error to display. Re-sending `joined` costs one frame.

### [minor] server/index.js:97

**No connection, per-IP, or room ceiling: every socket can hold a room, and the 32^4 code space is a global resource that exhaustion turns into `ROOM_FULL` for all legitimate users.**

Ran it: 300 sockets each sending `hello`+`create` produced 304 live rooms and 305 clients with no throttling beyond the per-socket message bucket. `WebSocketServer` is constructed with only `maxPayload`; there is no `maxConnections` and no room TTL, so ~1.05M concurrent sockets makes `Rooms.create()` return null and every real player then receives `ROOM_FULL` (index.js:260) — a code that also misdescribes the cause, since the room is not full, the code space is.

### [minor] server/index.js:438

**A bind failure is logged but not surfaced: the entry point prints "lobby server listening on …" and then exits with status 0.**

Ran `PORT=5719 node server/index.js` twice. The second process printed `[mp] lobby server listening on ws://localhost:5719`, then `[mp] server error listen EADDRINUSE: address already in use :::5719`, then exited with **code 0**. `createServer` returns a normal-looking object whose `wss` never listened, so `npm run server` reports success on a port conflict and any supervisor configured with restart-on-failure sees a clean shutdown. The listening line should come from the `listening` event and the `error` handler should exit non-zero for EADDRINUSE.

### [minor] server/index.js:219

**A player who is alive but idle (tab left open, player walked away) wedges `over` for the whole room indefinitely; the heartbeat cannot help because that client still pongs.**

Ran it: two players, host sends `finished`, the second stays connected and never finishes. After 3 s (7+ heartbeat rounds at pingMs=400) the room is still `phase === 'running'` and the finished player has received no `over` — this state is permanent. Terminating that socket immediately released `over`, confirming the only exit is a dead socket. The header comment at index.js:23-29 sells the heartbeat as the thing that stops "the room hangs waiting for a corpse to finish its run", but it only covers dead TCP, not an idle live client. A run deadline (or an `over` that fires once every *non-idle* player has finished) is missing.
