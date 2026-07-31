# Multiplayer

## The model: shared seed + live leaderboard

Every player runs **their own complete game on their own board**. The server
synchronises two things and nothing else:

1. **a room seed**, from which all clients derive identical element-pick offers,
   so everyone is solving the same puzzle with the same options;
2. **status broadcasts**, so everyone sees a live leaderboard of the others.

This is deliberately **not** lockstep and **not** authoritative simulation. It is
the Element TD multiplayer model: parallel boards, same waves, race to survive.

Why this and not lockstep: the simulation runs a fixed 60 Hz step over hundreds
of creeps with floating-point flow-field steering. Making that bit-identical
across machines is a months-long project (deterministic math, fixed-point or
rigorously ordered float ops, rollback, input delay), and it buys nothing the
game design actually needs — players never interact on the same board. The one
thing fairness requires is that nobody gets an easier wave or a better element
offer, and a shared seed delivers exactly that.

What this model therefore does NOT support, stated plainly so nobody builds on a
promise that isn't here: sending creeps to an opponent's board, shared boards, or
any cross-board interaction. Adding those means adding real state sync, not
extending this.

**Spectating is the one exception, and it is an exception on purpose.** It ships
as a *one-way, cosmetic, opt-in* stream (`watch`/`snap`, below): the watched board
is a picture, not a simulation you can influence, and the watcher's own run keeps
running at full rate underneath it. Nothing about it is authoritative and nothing
about it can change a hit point on either machine — see "Spectating" below.

### What is already deterministic

`waveDef(n)` in `src/game/Waves.js` is a pure function of the wave number — HP,
count, bounty, interval, boss-ness and element grants all derive from `n`. So the
wave schedule needs no syncing at all; it is the same for everyone by
construction.

The only gameplay randomness that affects fairness is
`Game.rollElementChoices()`, which must become a function of
`(roomSeed, pickIndex)`.

Spawn jitter and VFX randomness stay unseeded on purpose: they are cosmetic, they
never change an outcome, and seeding them would imply a determinism guarantee the
model does not make.

## Transport

WebSocket, JSON frames, one message per frame. Default endpoint
`ws://<page hostname>:5274/ws`, overridable with `?server=ws://host:port`.
Binary frames are rejected outright; a frame over **8 KB** is refused unparsed
(`TOO_BIG`), and `ws` itself will not buffer one over 16 KB.

The client **must degrade to offline single-player** if the server is
unreachable, and must never block the boot sequence waiting for it. Multiplayer
is an option, not a dependency: `npm run dev` with no server running has to give
a fully playable game.

## Message contract

`t` is the message type. Unknown types are ignored by both sides rather than
treated as errors, so one side can gain a message without breaking the other.

### Client to server

| message | payload | notes |
|---|---|---|
| `hello` | `name` | first message on every connection, including reconnects |
| `create` | — | creates a room, joins it, makes you host |
| `join` | `code` | case-insensitive |
| `leave` | — | |
| `ready` | `ready` (bool) | lobby only |
| `start` | — | **host only**; ignored from anyone else |
| `status` | `lives, score, wave, killed, leaked, towers` | ~2 Hz; server rate-limits |
| `finished` | `score, wave, won` (bool) | sent once when the run ends |
| `top` | — | request the global leaderboard; the only message allowed before `hello` |
| `best` | `score, wave, won` (bool) | offer a finished run to the global leaderboard |
| `watch` | `id` (player id, or `null` to stop) | subscribe to one player's board stream; at most one at a time |
| `snap` | one board snapshot | 10 Hz, **only while someone is watching**; dropped unrelayed otherwise |

### Server to client

| message | payload | notes |
|---|---|---|
| `welcome` | `id` | assigned player id |
| `joined` | `code, you, players[]` | you = your id |
| `lobby` | `code, players[]` | on every roster or ready change |
| `go` | `seed, at` | the run starts; `seed` is a uint32 |
| `scores` | `players[]` | relayed status, ~2 Hz |
| `over` | `standings[]` | every player has finished |
| `error` | `code, msg` | see codes below |
| `leaderboard` | `top[]` | global best runs; broadcast on change, sent on `top` |
| `watching` | `id, name` | ack of a successful `watch`; `name` is the server's copy from `hello` |
| `watched` | `n` (integer) | to the **streamer**: how many sockets are watching it. `n > 0` means start producing snapshots, `n === 0` means stop |
| `snap` | the streamer's frame + `from` (their id) | relayed only to that streamer's subscribers, never echoed to its author |
| `unwatch` | `id, reason` | the subscription is gone; cleared server-side at the same moment |

`top[]` entries: `{ name, score, wave, won }`, best first, at most 10.

### The global leaderboard

`best`/`leaderboard` are **room-independent**: a solo run posts to the same board
as a run played inside a room, which is the point — requiring a room would mean
the mode most people play in could never post a score. Two consequences worth
stating plainly:

- The name is the server's copy from `hello`, never a name inside the `best`
  frame. A client that could name itself there could overwrite another player's
  entry. `top` is exempt from the `hello` gate because it is a pure read; `best`
  is not, because it writes.
- Scores are self-reported, exactly like `status` already is. The board is only
  as honest as the clients on it. `server/leaderboard.js` sanitises for
  well-formedness and size (one entry per name, top 20, atomic file write), not
  for trust.

`players[]` entries: `{ id, name, host, ready, lives, score, wave, killed,
leaked, finished, won }`.

Error codes: `NO_ROOM`, `ROOM_FULL`, `IN_PROGRESS`, `BAD_NAME`, `NOT_HOST`,
`RATE_LIMIT`, `BAD_WATCH`, `NO_PLAYER`, `TOO_BIG`.

## Spectating

### The one design rule

**Nothing is sent unless someone is watching, and the server — not the client —
decides when that is true.** A player nobody is watching produces zero bytes: the
server answers `watched { n: 0 }`, the client stops encoding, and a client that
ignores that and streams anyway has its `snap` dropped before the server looks
past `t`. That is what makes the feature cost nothing in the common case, which is
nobody spectating.

### Subscribing

`watch { id }` subscribes to one player's board. It is refused unless **all** of:

- the target is in **your room** (`NO_PLAYER` otherwise — there is no message in
  this protocol that enumerates rooms or reaches into one you are not in, and
  `watch` is not the first);
- `room.phase === 'running'` (`BAD_WATCH`: there is no run to watch yet);
- the target is not you (`BAD_WATCH`);
- the target has not `finished` (`BAD_WATCH`: a finished board is a frozen
  picture).

At most **one subscription per socket**, by construction rather than by a check —
it is a single field. A second `watch` replaces the first, exactly as `create`
does an implicit `leave`. `watch { id: null }` stops. Re-watching the current
target is a **no-op**: no `watching` frame, no counter change, no `watched`
broadcast, so polling `watch` costs one bucket token and nothing else.

The server answers `watching { id, name }`. The name is the server's copy from
`hello`, never one the subscriber supplied — same rule as `best`, for the same
reason.

### Unsubscribing, and who does it

`unwatch { id, reason }` is sent whenever a subscription ends, and the server
clears it at the same moment so it can never linger:

| `reason` | when |
|---|---|
| `finished` | the watched player sent `finished` |
| `left` | the watched player left the room or its socket closed |
| `over` | the room reached `over`, or the host started a new round |
| `gone` | **you** stopped: an explicit `watch { id: null }`, or you left the room |

Two orderings are load-bearing. `unwatch` is emitted **before** `over`, so a
spectator is back on its own board when the end card lands. And a subscription is
cleared **before** `start()`, so a subscription from the previous round cannot
survive into the next one.

One deliberate asymmetry: **a watcher keeps its subscription across its own
finish.** An eliminated player watching the survivors race is the best moment this
feature has, so only the *streamer's* finish drops watchers.

### `watched` — the gate the streamer reads

`watched { n }` goes to the **streamer** whenever its watcher count changes,
coalesced on the same 60 ms timer as `lobby`. `n > 0` means start producing
snapshots; `n === 0` means stop. It is the only thing that should ever start a
snapshot encoder: encoding is the expensive half (a creep sweep plus a
`JSON.stringify` every 100 ms), and an unwatched `snap` is discarded server-side
before it is examined.

### `snap` — an opaque relay

The server **never reads a snapshot past `t`.** Parsing it would put the room's
CPU under the sender's control; bounding its size and its rate does not. It stamps
`from` with the sender's id (never trusted from the frame — a client that could
name its own `from` could impersonate another board) and forwards the frame
verbatim to that streamer's subscribers only. It is **never echoed to its author**.

Because the server does not validate, **the spectator must**, and its validation
is a hard gate: a frame failing any check is dropped **whole**, never partially
applied — a half-applied snapshot corrupts the interpolation state and the failure
then looks like a rendering bug. The snapshot body is the client's own contract
and is documented with the spectate renderer, not here: see the docblock and
`validateSnapshot()` in `src/game/spectate/SpectateCodec.js`, which is the single
place both the encoder and the gate are written down.

Two properties of that body are worth knowing from this side, because they are
what keep the bandwidth figures above true. Fourteen of the twenty per-creep
fields are **not sent** — they are pure functions of position, time and type, and
the watcher re-derives them with the simulation's own constants. And nothing
about projectiles, muzzle flashes, impacts, chains or death explosions is on the
wire at all: the watcher has tower positions, the same stat tables and creep
positions, so it re-fires the board locally (`SpectateView`). That is where
"essentially the entire visual life of a board, for zero bytes" comes from.

### Bounds

| bound | value | why |
|---|---|---|
| frame size | **8 KB**, checked before `JSON.parse` | `maxPayload` (16 KB) is what `ws` will buffer; this is what the protocol accepts. 16 KB × 12 Hz × 5 subscribers is ~950 KB/s of egress out of one room; the budgeted snapshot is ~1.7 KB and ~3 KB on a keyframe. Over it: `TOO_BIG`, unparsed. |
| `snap` rate | 24 burst / 12 per second | the documented rate is 10 Hz, so this bucket is tight like `status`'. Over it: `RATE_LIMIT`. |
| general rate | 60 burst / 40 per second | **raised from 40/20 when `snap` landed.** A watched player legitimately produces 10 `snap` + 2 `status` = 12 frames/s before touching the keyboard; at 20/s the general bucket became the binding constraint and an honest streamer collected `RATE_LIMIT` for playing the game. |
| fan-out | ≤5, bounded and known | one subscription per socket × ≤6 sockets per room. |

At the documented rate one watched board is **≈9 KB/s**, hard-capped at ~17 KB/s,
and exactly **0 KB/s when nobody is watching**.

### What spectating does and does not widen

It does **not** widen the trust model. The payload is cosmetic: room standings and
the global leaderboard are still driven by `status`/`finished`/`best`, which are
self-reported and unchanged. A malicious client can stream a board with 400 towers
and a million gold — and the entire consequence is that the people watching them
see a lie. The spectator's reconstructed projectiles are wired to a read-only
façade with no method that can write a hit point, so the authority boundary is
structural rather than a rule someone has to remember.

Exactly one new remote string reaches the DOM — the watched player's name in the
spectate banner — and it goes through `esc()` in text position, same discipline as
the roster.

### Client API (`src/net/NetClient.js`)

```js
net.watch(playerId)   // subscribe; does NOT set net.watching (the ack does)
net.unwatch()         // stop; answered with unwatch { reason: 'gone' }
net.snap(payload)     // one snapshot; no-op when net.watchers === 0
net.streaming         // boolean: is anyone watching us? check BEFORE encoding
net.watchers          // how many
net.watching          // id we are subscribed to, or null
net.watchingName      // their name, untrusted, escape before it reaches the DOM
net.bufferedAmount    // bytes queued in the socket

net.onBoardSnapshot        = (snap) => {}          // also fires as on('snap')
net.onWatcherCountChanged  = (n, streaming) => {}  // also fires as on('watched')
net.onWatching             = ({ id, name }) => {}
net.onUnwatch              = ({ id, reason }) => {}
```

`net.watching` / `net.watchers` are **server-derived and never set
optimistically**: `watch()` does not set `watching`, the `watching` frame does. A
client that assumed it was being watched would start producing snapshots the
server then drops, which is exactly the property the design is built on.

`snap()` carries three transport-level guards so no caller has to remember them:
it refuses when nobody is watching, it enforces a **90 ms floor** (below the 100 ms
nominal, so an honest 10 Hz caller passes untouched while one that forgot to
throttle is clamped to ~11 Hz — under the server's bucket, so a streamer bug
cannot earn a `RATE_LIMIT` that also throttles the lobby), and it drops the frame
when more than 48 KB is already queued. A slow uplink must degrade the picture,
never grow a send queue that eventually delays the `finished` frame that decides
the standings.

## Room rules

- Codes are 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — no `I`, `O`,
  `0` or `1`, because players read these codes aloud and type them from memory.
- Max 6 players per room.
- Joining is refused **while** a run is in progress (`IN_PROGRESS`), not after one.
  A room between rounds is joinable: it has returned to the lobby, `ready` works
  there, and the host can start the next round. Refusing an ended run told a
  player the opposite of the truth and locked them out of that room forever.
- A `join` for the room you are already in re-sends `joined` rather than being
  ignored, so a client whose reply was lost can retry.
- A player who has neither finished nor sent `status` for 60 s stops blocking
  `over`, but only once someone else has finished and only if no other unfinished
  player is still reporting — a live run is never cut short.
- If the host leaves, the longest-present remaining player becomes host.
- Empty rooms are collected.
- Names: trimmed, control characters stripped, 1–16 characters after cleaning,
  and **never** interpolated into HTML without escaping — a player name is
  untrusted input from another machine, which makes it the single most obvious
  XSS vector in the whole project.

## Files

| file | owns |
|---|---|
| `server/index.js` | the ws server, rooms, protocol |
| `src/net/NetClient.js` | client transport, reconnect, offline fallback |
| `src/core/Rng.js` | seeded RNG shared by client and server |
| `src/ui/Lobby.js` + `lobby.css` | pre-game overlay |
| `src/ui/Scoreboard.js` + `scoreboard.css` | in-game leaderboard |
| `server/leaderboard.js` | global top-20, persisted to `server/leaderboard.json` |
| `src/net/BestScore.js` | personal best in `localStorage`, works with no server |

Run the server with `npm run server`. `npm run dev` remains standalone; `npm run
dev:mp` starts both.

## Boot behaviour, and the automation bypass

A real player boots into the lobby, where "Play solo" is always one keypress away
— including, and especially, when no server answers.

**Automation boots straight into a solo run.** `main.js` checks
`navigator.webdriver`, which is true under Playwright and false for a player. The
reason is blunt: every visual and performance probe in `tools/scratch` drives
`window.__game` directly and expects a live run, and putting a lobby in front of
them would have meant editing fifty probes to keep the harness working. A harness
that needs a migration to keep passing is a harness that quietly stops being run.

That bypass would also mean the lobby is never tested, so:

- `?mp` forces the lobby even under automation. `tools/scratch/mplive.mjs` and
  `tools/scratch/lobbyshot.mjs` both use it.
- `?solo` is the manual bypass for a human.

`Game` takes `autoStart: false` in the lobby case and parks its phase at `'lobby'`,
which `FROZEN_PHASES` excludes from the simulation. The render loop still runs, so
the overlay sits over a live scene rather than a frozen first frame — and, more
importantly, the prep timer does not run down behind the veil and send wave 1 at a
player still typing their name.

## What was measured, not assumed

`tools/scratch/mplive.mjs` drives two real browsers against a real server through
the actual DOM — clicking Create, typing a code, pressing Start — because the
wiring between Lobby, NetClient, `main.js` and the server is exactly what no
component test covers. 23 assertions, including:

- both clients receive the **same seed** and therefore the same element offers;
- the host sees a player arrive (via the server's debounced `lobby` broadcast, not
  via the joiner's own `joined`);
- a hostile player name (`<b>zap</b>`, 10 chars so it survives the 16-char limit)
  is rendered as literal text with **zero** child elements in the name span;
- an eliminated player reads as eliminated instead of vanishing.

Two ways that XSS test can pass while proving nothing, both hit on the way here:
a payload longer than 16 characters is rejected as `BAD_NAME` and never reaches
anyone's DOM, and a join attempted after `go` is refused as `IN_PROGRESS`. The
probe now asserts the name **arrived** before asserting it was escaped.

`tools/scratch/mpspectate.mjs` does the same for the spectate protocol: a real
server on a free port and real sockets, plus one section driving `NetClient`
itself. 53 assertions, and the four that the feature would be broken without:

- **B receives nothing before it subscribes**, while A is already streaming — the
  path that makes the feature free when nobody is looking;
- **B receives nothing after it unsubscribes**, and A is told `watched { n: 0 }`;
- a **12 KB** frame (under `maxPayload`, over the protocol's 8 KB) is refused
  `TOO_BIG` **unparsed**, and a normal snapshot still flows immediately after, so
  the connection was not poisoned by the rejection;
- a 60-frame burst is **throttled, not relayed**, and the sender is told.

The trap that section 8 walked into first: an oversized frame built at 50 KB never
proves anything, because `maxPayload` makes `ws` drop the connection before the
protocol ever sees it. The test frame has to sit **between** the two limits.
