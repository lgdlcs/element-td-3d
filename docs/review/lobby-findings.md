# Review findings: lobby (NEEDS_WORK)

## Evidence the reviewer actually ran

RAN, all against the real files (no stubs):

1) `node tools/scratch/lobbycheck.mjs` — exit 0, 34 assertions pass. Its claims hold, but note what it cannot see: it never constructs the class against a DOM, so none of the 8 failures below are in its reach.

2) Cleaner-parity harness (node, imports the REAL `server/rooms.js` cleanName and a byte-copy of Lobby's): 5 of 9 adversarial names disagree. `16 chars + U+200B` -> client BLOCKED / server "abcdefghijklmnop"; `a`+20 spaces+`b` -> client BLOCKED / server "a b"; 3x U+200B -> client accepts the zero-width string / server null; 20 chars -> client BLOCKED / server clamps to 16.

3) Real browser suite (Playwright chromium, real vite dev server on :5290, real `server/index.js` on :5274, driven through actual main.js wiring with `?mp`). 24 checks; output verbatim in /private/tmp/claude-501/-Users-pouetpouets-code/c57263d9-aa43-4151-90a5-60492452382f/tasks/bgt45nyqp.output. Script: /private/tmp/claude-501/-Users-pouetpouets/rev2.mjs.
   PASSED: `no element created from any remote string` (errImgs 0, codeImgs 0, rosterImgs 0); `no injected handler ran` (__xss/__x2/__x3 all undefined); `hostile name rendered verbatim as text` (`<img src=x onerror="window.__xss=1">` came back as textContent); `hidden overlay does not cover the board centre` (elementFromPoint at viewport centre = #viewport, display:none); `game keybinds reach window once the lobby is hidden` (1 keydown through); `Escape is inert in idle and leaves in a room` (idleLeaves 0, lobbyLeaves 1); zero page errors and zero console errors for the whole run.
   FAILED (8): the ZW/space/invisible name cases; setState focus theft lobby-code-in -> lobby-name; 9 focusables outside #lobby; "undefined"/"null"/"[object Object]" names; "9 / 6" with 9 rows; .open stuck at {"open":true,"hidden":true}.

4) Raw `ws` client against the live server: `hello` with a zero-width name -> `{"t":"error","code":"BAD_NAME"}`, and the following `create` produced no `joined` (server/index.js:237 hello gate). This is what makes finding 1(c) a dead click, not just a wasted round trip.

5) Static audit: all three HTML sinks in Lobby.js (ctor insertAdjacentHTML:166, #renderCode:569, #roster:610) read and confirmed — remote strings only ever reach text position via `esc`, never an attribute (uikit.js:18 `esc` does not escape `'`, and the module's comment correctly flags that). Lobby.js imports only `./uikit.js`; nothing from src/game/. `package.json` deps are exactly three + ws, devDeps playwright + vite; no .ts/.tsx anywhere in src/server/tools. No CSS class leakage: every lobby.css selector is `#lobby`/`.lobby-`/`.lb-` scoped except `.shake`, and `.shake`/`.lb-*` appear nowhere else in src.
   `prefers-reduced-motion`: the implementer listed this as untested; it is in fact covered by ui.css:1290's blanket `*` rule with `!important`, so not a defect.
   Start-with-one-player: the implementer's contract reading is correct — server/index.js:300-313 has no minimum-player check, so an enabled Start at 1/6 is accepted. Not a finding.

NOT RUN / could not verify:
- Ownership of main.js / index.html / ui.css / Game.js / package.json. main.js:4 imports Lobby and index.html:13 links lobby.css, so both DO mention this component's symbols; with no git in the directory I cannot attribute those lines. mtimes are main.js 13:50:19 and index.html 13:50:33 vs Lobby.js 13:54:26, consistent with the implementer's claim but not proof.
- `navigator.clipboard.writeText` and the selection fallback (no gesture-driven copy exercised).
- The >=2200px / <=560px media queries; screen-reader announcement of the aria-live regions.
- The machine was under load average 12-20 from other concurrent sessions; three earlier browser runs timed out at 30s waiting for boot, and one probe showed NetClient stuck at 'connecting' with "WebSocket is closed before the connection is established" against a server I proved reachable from raw ws. That is a NetClient OPEN_TIMEOUT_MS(2500) symptom, not a lobby one, but it is why finding 8's window is not hypothetical.

## Findings

### [major] src/ui/Lobby.js:103

**cleanName() claims parity with the server's cleaner in its own docblock but does not have it; three concrete divergences, two of which permanently disable Create with no visible cause.**

Ran both cleaners side by side (imported the real server/rooms.js cleanName) and reproduced all three in a real browser against the live server. (a) `abcdefghijklmnop` + U+200B: note reads "17 characters — trim to 16." and Create is disabled forever — the field looks like 16 characters and there is nothing visible to delete; the server strips U+200B and would have accepted it unchanged. (b) `a` + 20 spaces + `b`: note reads "22 characters — trim to 16.", Create disabled; the server collapses whitespace runs and accepts it as "a b" (3 chars). (c) three U+200B characters: counter says "3 / 16 characters.", Create ENABLED, `lobby.name` returns the zero-width string; server replies BAD_NAME and then silently drops the following `create` via its hello gate (server/index.js:237), so the player gets an error message that contradicts the counter and a click that does nothing. The server clamps to 16 and only rejects empties; the client rejects >16 outright. The docblock's promise ("so the client's idea of 'too long' cannot disagree with the server's and produce a BAD_NAME for a name the UI just told the player was fine") is exactly what happens.

### [major] src/ui/Lobby.js:356

**setState() has no same-state early-out and calls #focusFirst() unconditionally, so a redundant state set yanks focus out of whatever the player is typing.**

main.js:192 calls lobby.setState('idle') on every NetClient 'open' — which NetClient re-emits on every reconnect (NetClient.js:237 inside _open()) — and main.js:212 sets it again when connect() settles. Measured in a real browser: with focus in #lobby-code-in after typing "AB", a single setState('idle') moved focus to #lobby-name ({"before":"lobby-code-in","after":"lobby-name"}). A socket blip while a player types a room code therefore sends the remaining characters into the name field, silently corrupting both fields. #focusFirst should fire on an actual state transition, not on every call.

### [major] src/ui/Lobby.js:167

**The overlay declares aria-modal="true" but implements no focus trap; 9 focusable controls behind the veil are reachable by Tab.**

Enumerated live focusables in the booted page with the lobby open: 13 total, 9 of them outside #lobby (#pause-btn, the speed buttons, #codex-toggle, #send-wave …). aria-modal="true" tells assistive tech the rest of the document is inert, which is false, and a keyboard-only player tabbing past "Play solo" lands on invisible game buttons under the veil and can pause or queue a wave before the run exists. The constructor already shields keydown from the game's window listeners for exactly this class of bug (Space/F reaching BuildBar) — Tab was missed because Tab needs no listener to leak.

### [minor] src/ui/Lobby.js:336

**show() adds .open from a rAF with no visibility guard, so hide() during that frame leaves .open stuck on a hidden overlay and kills the entrance transition on the next show().**

Measured: hide(); show(); hide() then two frames later the element is {"open":true,"hidden":true}. The rAF exists solely so the opacity/transform transition runs; once .open is already present the next show() goes straight to its final state and the overlay snaps in — the exact defect the rAF was added to prevent. Reachable whenever a 'go' or solo click lands in the same frame as a show().

### [minor] src/ui/Lobby.js:611

**#roster() does not clamp to MAX_PLAYERS: a roster of 9 renders 9 rows and the count reads "9 / 6".**

setPlayers with 9 entries produced overCount "9 / 6" and 9 rows in the browser. The server caps rooms at 6 so this needs a non-conforming or future server, but the module's stated job is to render untrusted remote input safely and it prints a count that contradicts its own documented contract (MAX_PLAYERS = 6, "Max 6 players per room").

### [minor] src/ui/Lobby.js:596

**esc(p.name) stringifies rather than validating, so a missing or non-string name renders as the literal text "undefined", "null" or "[object Object]".**

Confirmed in the browser: names ["<img …>","undefined","null","[object Object]"]. server/index.js:358 does initialise `name: null` and server/rooms.js:188 publicPlayer passes `name: p.name` straight through; the only thing preventing "null" in the roster today is the single hello gate at server/index.js:237. One relaxed guard on the server and the lobby names a player "null".

### [minor] src/ui/Lobby.js:48

**The hardcoded ROOM_FULL sentence overrides the server's accurate msg and is wrong on the create path.**

server/index.js:260 sends ROOM_FULL with msg "No room codes available." when the 4-char code space is exhausted on a `create`. ERRORS[ROOM_FULL] wins over msg in setError, so the player who clicked "Create room" is told "That room is full — six players is the limit." about a room that was never created. The module's own justification for the hardcoded sentences is that a known code "deserves the sentence that names the fix"; here it names the wrong fix and discards the correct one.

### [minor] src/ui/Lobby.js:650

**The name input is disabled for the whole duration of the connection attempt (`this.$name.disabled = busy`).**

main.js:201 sets state 'connecting' before calling net.connect(); NetClient's OPEN_TIMEOUT_MS is 2500 ms with retries, and I measured netstate still 'connecting' at the moment __lobby appeared. For that window the player cannot type the one thing that never needs a server. The contract is explicit that multiplayer is an option and not a dependency; disabling the name field on a socket attempt makes the socket a gate on local input. Disabling Create/Join is defensible, disabling the text field is not.

### [minor] src/ui/Lobby.js:71

**Four of the eight CONNECTION entries are unreachable, and the report's stated reason for the 'open'/'online' collision is false.**

NetClient.js:63 and :86 both explicitly document the state set as 'offline' | 'connecting' | 'online'. The implementer's report says "the doc gives no enumeration of NetClient states, so setConnection had to guess names" — the enumeration is in the JSDoc of the module it is wired to. The cost is `open`, `reconnecting`, `closed` and `error` sitting in CONNECTION as dead branches that a future reader will assume are live states, plus the duplicated `open`/`online` pair the module now has to carry forever.
