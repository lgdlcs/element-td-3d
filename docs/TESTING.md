# Testing

Two harnesses, two jobs.

| | `tests/unit` | `tests/e2e` |
|---|---|---|
| Runner | Vitest | `@playwright/test` |
| Config | `vitest.config.js` | `playwright.config.js` |
| Subject | pure modules (`Grid`, `Config`, `TowerDefs`, `Elements`, `Waves`, pathfinding) | the real game in a real GPU Chromium |
| Speed | ~150 ms | seconds per spec |
| Needs the dev server | no | yes (port 5273) |

---

## Running

```sh
npm run test:unit     # vitest run       — fast, no browser
npm run test:e2e      # playwright test  — boots the real game
npm test              # both, unit first (fail fast before spending GPU time)
npm run test:watch    # vitest in watch mode while writing unit tests
```

First E2E run on a fresh machine:

```sh
npx playwright install chromium
```

The Playwright config declares `webServer` with `reuseExistingServer: true`. If
a dev server is already listening on 5273 — and during development there almost
always is — the suite attaches to it. Otherwise it spawns `npm run dev` and
waits up to 120 s. **Do not kill port 5273 to "get a clean run"**; other agents
and open browser tabs share it.

---

## Philosophy: the net freezes the version that works

This suite is not here to find bugs in new code. It is here to make it
expensive to break the version of the game that currently works. The rule in
`CLAUDE.md` — *the game works well, no regression is acceptable* — is only
enforceable if the current behaviour is written down somewhere executable.

Three consequences for anything added here:

1. **Assert on observable state, not on implementation.** `window.__game`
   exposes the whole live game (`state`, `grid`, `arena`, `towers`, `creeps`,
   `hud`). Assert what a player would notice — gold went down, a tower exists at
   that anchor, the hint says *Blocked* — not that some private method was
   called.

2. **Prove the instrument can fail.** A test that only ever sees the passing
   value is not evidence. Before trusting an assertion, make the thing false
   once and watch the test go red. `docs/PITFALLS.md` §11 is the long version.

3. **Slow and trustworthy beats fast and flaky.** `playwright.config.js` runs
   `workers: 1`, `fullyParallel: false` on purpose: each page is a full WebGL
   scene with a procedural texture forge, and two on one GPU stretches frame
   times until timing-sensitive assertions start flapping. `retries: 1` exists
   to absorb genuine machine hiccups, not to paper over a flaky test — a spec
   that only passes on retry is a broken spec.

---

## The HMR trap

**Every E2E spec must boot through `bootGame()` from `tests/e2e/fixtures.js`.**

The dev server on 5273 is shared. When someone saves a file in `src/` while a
test is mid-run, Vite pushes a hot update, the module graph re-executes, and
`Game` is silently rebuilt — every piece of state the test set up is gone. The
failure does not look like a hot reload: it looks like an assertion failing on a
value that was correct two lines earlier, and it does not reproduce.

`bootGame()` intercepts `**/@vite/client` and fulfils it with a no-op stub, so
the page becomes a sealed snapshot of whatever was on disk when it loaded. This
is the same trick `tools/shot.mjs` and `tools/ui-contract.mjs` use, for the same
reason. `docs/PITFALLS.md` §11 records the round it cost.

`bootGame()` also:

- waits for `window.__game` with a **90 s** timeout (a cold module graph plus
  the texture forge routinely blows past Playwright's 30 s default);
- removes `#boot`, which otherwise covers the canvas and swallows every pointer
  event;
- returns `{ errors, warnings, logs }` — live arrays the listeners keep pushing
  into, so `expect(errors).toEqual([])` at the end of a test covers the whole
  run, not just the boot.

Skeleton:

```js
import { test, expect } from '@playwright/test';
import { bootGame, settle } from './fixtures.js';

test('placing a tower spends gold', async ({ page }) => {
  const { errors } = await bootGame(page);
  // … drive window.__game, assert …
  expect(errors).toEqual([]);
});
```

---

## Writing unit tests

Default environment is `node`. A file that needs a DOM opts in with a pragma on
its **first line**:

```js
// @vitest-environment jsdom
```

Only `tests/unit/**/*.test.js` is collected. Keep `three` out of this directory:
anything that imports it (or `src/main.js`) needs a real GL context and belongs
in `tests/e2e`. `tower-scale.test.js` is the documented exception and explains
itself: `buildTowerSpec` touches only BufferGeometry maths, never a renderer.

### One shared checklist, six subjects: the rites

`tests/unit/helpers/rite-contract.js` exports `assertRiteContract(def, { randCalls,
skilled })` — eight rules that must hold of **any** minigame (a fixed rand budget
on three waves, determinism, an idle run that terminates and scores under 0.15,
mashing beaten by real play, 1 500 fuzz steps staying finite and bounded, a pure
`score()`, a `drainEvents` that empties). Every `tests/unit/<id>-rite.test.js`
calls it in one `it()`, then adds only what is specific to that rite.

It is a helper, **not a suite** — vitest only collects `*.test.js` — and the
helper itself is tested by `tests/unit/rite-contract.test.js`, which feeds it
deliberately broken rites and asserts each rule fires. That is the "prove the
instrument can fail" rule above, applied to a harness rather than to an
assertion. The full description of what each rule buys is `docs/MINIGAMES.md` §9.

Two habits it enforces that generalise beyond minigames: `randCalls` is required
to be a **literal the author wrote down** (the assertion is "this number", not
"some fixed number", so a stray draw inside a loop bound is caught rather than
absorbed), and every failure message names the subject and the rule — a bare
"expected 0.3 to be less than 0.15" in a six-rite run tells the reader nothing.

`tests/unit/setup.js` runs before every file and collapses ONE known three.js
warning — `BufferGeometry is already non-indexed`, which tower-scale emits 2 506
times — into a single counted line. It is a filter on one exact prefix, not a
mute: everything else on `console.warn` goes straight through, because that is
the channel a real problem would arrive on. Do not add a second pattern to it;
fix the cause instead.

---

## Traps specific to this codebase

Read `docs/PITFALLS.md` before writing anything visual. The three that bite
tests hardest:

- **Deferred visual state.** `arena.setGridVisible(true)` does not set
  `gridOverlay.visible`; it sets a target opacity that `Arena.update()` eases
  toward over the next few frames. Reading `gridOverlay.visible` immediately
  after reads `false`. Assert on `arena._gridTargetOpacity`, or call
  `settle(page)` first. (§10)
- **Four features share one shader.** The grid, the range ring, the 2×2 ghost
  and the seal preview all live in the grid overlay's fragment shader and share
  `uOpacity`. A test that changes grid visibility changes the other three.
  Judge the integrated frame. (§5)
- **A failed shader compile does not throw.** It yields a black or missing
  object and a silent `errors` array on the program. Do not read "the page did
  not crash" as "the shader linked". (§9, §12.2)
- **A shader that compiles can still paint the wrong thing**, and no amount of
  uniform-reading catches it. `samplePixels`/`cellClip`/`pixelDistance` in
  `helpers.js` read the composited frame through `page.screenshot`, and
  `grid-preview.spec.js` uses them to prove the six refusal ghosts are six
  different *pictures* rather than six different uniforms. Every assertion built
  on them is a DELTA between two reads of the same board — absolute colour moves
  with the driver, the preset and two seconds of a breathing camera, which is why
  this repo has no golden images.
- **Headless wall-clock time is not the game's time.** A GPU Chromium under
  Playwright renders at a handful of frames per second, and both `Game.frame` and
  `MinigameHost` clamp a frame before accumulating it (`MINIGAMES.maxFrameDt`,
  100 ms) — so a rite's own clock advances at a *fraction* of real time and a
  20-second rite does not finish in 20 seconds of `performance.now()`. Any wait
  must be on **observable state** (`#rite.open`, the instance's own counters) and
  any loop must be bounded in **frames**, never in milliseconds.
  `tests/e2e/minigame.spec.js` marks the frame-bounded loops that exist because
  of this. Converting world units to client pixels has the same shape: use
  `Painter.toClient` plus `getBoundingClientRect`, never a second copy of the
  letterbox maths inside the spec.
- **Nothing is still, even when the game is paused.** `state.paused` stops the
  simulation and nothing else: every shader's `uTime` keeps advancing, the camera
  idles, the environment breathes and the grade pass lays down per-frame film
  grain. Measured, that moves the mean RGB of a 48px box by ~16 units. Call
  `freezeFrame(page)` before any pixel comparison — and note it also freezes the
  grid overlay's opacity ease, so freeze *after* whatever ramp you are waiting on
  (`freezeFrame(page, ['arena'])` keeps the arena running).

---

## Existing harnesses (not part of `npm test`)

`tools/` predates this suite and is still the right tool for visual work:

- `tools/shot.mjs` — deterministic PNG capture of a named scenario. Two of the
  scenarios exist because nothing else could photograph the feature: `holding`
  freezes the whole build cursor (grid + 2x2 ghost + range ring + cursor hint),
  which only exists while a tower is queued, and `primal` puts two level-3
  ultimates next to ordinary towers, which `giveAll()` alone cannot reach because
  a primal needs three copies of one element.
- `tools/ui-contract.mjs` — 27 live assertions on HUD, picker, inspector, dock,
  plus a layout contract (no resting UI over the centre of the board). It asserts
  the tower count against `TOWER_TOTAL` rather than a literal; it spent a round
  red because the literal said 21 after the primals took the table to 27, and a
  stale number in the safety net is worse than no net.
- `tools/scratch/*` — one-off probes kept for reference

They use raw `playwright`, not `@playwright/test`, and are run by hand. Anything
in `tools/` that proves a durable invariant is a candidate for promotion into
`tests/e2e`.
