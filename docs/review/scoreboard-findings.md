# Review findings: scoreboard (NEEDS_WORK)

## Evidence the reviewer actually ran

RAN, not just read.

1) `node tools/scratch/scorecheck.mjs` — all 27 checks pass (side-effect-free import, full API/arities, rank determinism across permutations, NaN/null coercion, esc-audit, CSS invariants).

2) Real server attack for the data shape: wrote a throwaway script importing `createServer` from server/index.js on port 5951, connected 3 real `ws` clients (one named `<img src=x onerror="window.__pwned=1">`), created/joined/readied/started, then had ONLY the host send `status`. Captured the actual relayed frame: p1 `{lives:20,score:1500,wave:5}`, p2 and p3 `{lives:0,score:0,wave:0,finished:false}`. Also confirmed the server truncates the hostile name to 16 chars (`"<img src=x onerr"`).

3) Live app: started `npx vite --port 5299 --strictPort`, drove `http://localhost:5299/?solo` with Playwright (chromium, real page, real index.html which does link scoreboard.css at line 14 and main.js which constructs it at line 105). Fed the captured server frame into `window.__scoreboard.update(...)`.
   - XSS: INERT. `el.querySelectorAll('img').length === 0`, `window.__pwned` false, name rendered as literal text, `Cora "Q" & co` intact in row and `title`. `esc` covers & < > "; every attribute in the template is double-quoted, so the missing `'` escape is not reachable. Only innerHTML/insertAdjacentHTML sites are Scoreboard.js:82 (static markup) and :198 (all interpolations wrapped in esc). No finding.
   - The "out" rendering of the two living players: `class="sb-row out"`, lives text `out`, `line-through`, opacity 0.46 (finding 3).
   - Geometry sweep, 6 rows, 14 viewports, measuring real overlap area against #threat and #dock: 1440x900 0/0, 1440x760 0/0, 1440x698 0/0, 1440x640 12/0, 1440x600 52/0, 1300x650 15/0, 1200x620 45/0, 1150x700 0/0, 1101x700 0/0, 1100x700 71/0, 1000x760 21/0, 950x700 71/0, 900x700 71/0, 1440x520 132/0 (px vertical overlap with #threat / with #dock).
   - `pointer-events: none` computed at every size; `document.elementsFromPoint(centre)` never returns the panel — board centre is clear, HUD contract respected.
   - codex-open DOES work (transform translateX(-262px), opacity 0) and single-player DOES turn the panel off (`.on` removed). My first readings suggested otherwise; that was headless-chromium frame starvation (~2.7s per rAF under software WebGL) making getComputedStyle lag a step. Retested with a 12-sample rAF poll and both settle correctly. Not findings.
   - Final standings: `is-final` set, title "Final standings", winner row `you out won` with lives text `won`, and a subsequent `update()` was correctly ignored (latched).
   - Zero pageerrors in every run.

NOT run / not verified: no visual screenshot review of the overlap (the app boots into the element-picker overlay at `?solo`, which covers the rails, so the overlap is proven by measured rects rather than by eye); no test of an actual 6-client multiplayer run through NetClient (only hand-fed frames plus one real server relay frame); no reduced-motion or 2200px+ visual pass.

Other checks: no new dependencies (package.json still three + ws, vite/playwright devDeps); no TypeScript anywhere. index.html:14 and src/main.js:5,105,140-142 do reference the scoreboard, which contradicts the report's "no other file touched" — but wiring is main.js's job, another agent plausibly did it, and the wiring is correct, so I raise it as an observation, not a defect. src/game/Game.js and src/ui/ui.css contain no scoreboard symbols. Ordering is safe: HUD's `root.innerHTML = TEMPLATE` (HUD.js:26) runs inside the Game constructor before main.js:105 inserts the panel, so the panel is not wiped.

## Findings

### [major] src/ui/scoreboard.css:215

**The `@media (max-width: 1100px)` lift (`bottom: 122px`) drives the panel 106px up into #threat, producing a measured 71px overlap of two glass panels at 1100x700 — while the dock collision it was written to avoid does not exist at that width.**

Measured in the live app with 6 rows: at 1101x700 (rule off, bottom:16px) overlap with #threat = 0 and overlap with #dock = 0; at 1100x700 (rule on) overlap with #threat = 71px, overlap with #dock still 0. Same at 950x700 and 900x700 (71px). The dock's left edge at 1000px wide is x=243 against a panel right edge of 236, so the dock only starts reaching the panel around ~930px. The breakpoint is set ~170px too wide and the "fix" is what causes the collision: two backdrop-filter glass cards and their text stack on top of each other at the top-left, which the file's own comment claims cannot happen ("clears the rail with room to spare").

### [major] src/ui/scoreboard.css:11

**On any viewport shorter than ~660px the bottom-left panel collides with the threat rail regardless of width, because bottom:16px + 211px of rows reaches above #threat's fixed bottom edge (426–438px).**

Measured: 1440x640 -> 12px overlap with #threat; 1440x600 -> 52px; 1440x520 -> 132px; 1300x650 -> 15px; 1200x620 -> 45px. #threat's bottom is essentially fixed (426px at >=1360px wide, 438px below), so shrinking the window vertically walks the leaderboard straight into it. The implementer only measured 1440x698 and 1440x960, i.e. exactly the two heights where it happens to clear. 1200x620 and 1300x650 are ordinary laptop-with-browser-chrome and split-screen sizes.

### [major] src/ui/Scoreboard.js:64

**`isOut = p.finished || p.lives <= 0` marks every player who has not yet sent a `status` as eliminated, because the server seeds roster entries with `lives: 0`.**

End-to-end verified. I ran the real server (server/index.js, port 5951) with three real ws clients, started the room, and let only one client send `status`. The actual `scores` frame the server relayed contains `{id:'p2', lives:0, score:0, wave:0, finished:false}` and `{id:'p3', lives:0, ...}` for two connected, alive players (server/index.js:368 initialises `lives: 0`). Feeding that exact frame into the live page produced `class="sb-row out"`, `lives` text `"out"`, `text-decoration: line-through`, `opacity: 0.46` for both — the panel declares two living opponents dead. `scores` is only broadcast once someone is dirty, so this is guaranteed at the start of every multiplayer run: the first client to report makes all five other rows render struck-through as eliminated until each one's own first status lands. It persists indefinitely for any client that never reports a status (main.js only calls `net.status()` from the rAF loop, which a hidden tab stops running, and a tab killed by the OS keeps the socket open — server/index.js:25 documents exactly that case). `players[]` has no eliminated flag, so the fix belongs on one side or the other, but the wrong output is here.

### [minor] src/ui/Scoreboard.js:170

**`W${Math.max(1, p.wave)}` fabricates "W1" for a player whose relayed wave is 0.**

Combined with the finding above, a connected player who has not yet reported renders as `W1` + `out` + struck-through name — a specific, false claim ("died on wave 1 with 0 points") rather than an absent value. Confirmed against the real relay frame, where `wave: 0` is what the server sends for a player pre-first-status.

### [minor] src/ui/Scoreboard.js:88

**Reordering by the flex `order` property leaves the <ol> DOM order frozen at build time, so assistive tech reads a stale ranking.**

Verified in the live DOM: after ranking, `#sb-list` children stay in their build-time sequence while `style.order` carries the live rank (e.g. p6 at order 5 sitting before p5 at order 6 in the source). A screen reader or any DOM-order consumer walks the list in the original order, so an <ol> semantically promising sequence reports the wrong one. The rank digit in each row is the only recovery, and `aria-live="off"` means nothing corrects it on update.

### [minor] src/ui/Scoreboard.js:139

**`showFinal` with a single standing latches the panel hidden forever: `_enough` goes false, `_final` blocks all further repaints.**

If the `over` payload carries one entry (a 2-player room where the other player's socket dropped before the last `finished`), `#render` sets `_enough = false`, returns before writing anything, and `_final = true` makes every subsequent `update()` a no-op. The player finishes a multiplayer run and the final standings never appear, with no code path left that can show them.

### [minor] src/ui/scoreboard.css:231

**The reduced-motion branch disables an `animation` the panel never had, and leaves the panel's actual opacity/transform transitions running.**

`#scoreboard.on { animation: none; opacity: 1; transform: none; }` — the panel is animated by `transition` (opacity/transform, 320ms, line 43), which the branch never overrides, so a `prefers-reduced-motion: reduce` user still gets the 8px slide and fade. Only `.sb-bar > s` actually honours the preference.
