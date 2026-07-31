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
promise that isn't here: sending creeps to an opponent's board, shared boards,
spectating another player's board, or any cross-board interaction. Adding those
later means adding real state sync, not extending this.

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
`ws://<page hostname>:5274`, overridable with `?server=ws://host:port`.

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
`RATE_LIMIT`.

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
