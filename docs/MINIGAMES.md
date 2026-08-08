# The Rites — between-wave minigames

The **rite** is a short, skippable, seeded minigame that runs between two waves
and pays gold. This document is the contract: read it before writing one, and
treat any disagreement between it and the code as a bug in one of them.

There are six of them, and they are not inventions. They are Warcraft III's
Ryoko TD interludes, rebuilt from the description of someone who played them:
escape from gay heaven, falling platforms, lucky shot, offroad racing, game hunt,
fishing. An earlier pass invented four rites (Forge, Verdict, Coulée, Hearth)
because the real contents were not documented anywhere; they were deleted
outright, in one commit, and everything below describes what replaced them.

| rite | id | clock | verb | scores on | `RAND_CALLS` | rivals |
|---|---|---:|---|---|---:|:--:|
| escape from gay heaven | `heaven` | 20 s | steer a mote, pointer or `axis` | seconds survived | 121 | — |
| Falling Platforms | `platforms` | 24 s | steer a marker, `axis` only | survival + who you outlasted | 41 | yes |
| Lucky Shot | `luckyshot` | 20 s | aim and fire, 24 rounds | points against a fixed PAR | 24 | — |
| Offroad Racing | `offroad` | 26 s | steer, boost, bomb | gates + gold + placing | 58 | yes |
| Game Hunt | `hunt` | 20 s | reaction shot | animals taken out of 8 | 69 | yes |
| Fishing | `fishing` | 20 s | leading shot (cast) | points against a fixed PAR | 94 | yes |

Full write-ups in §13. Files:

| Path | What it is |
|---|---|
| `src/minigames/contract.js` | Field, input record, reward formula, typedefs. **Pure.** |
| `src/minigames/schedule.js` | Which rite, which wave, which seed. **Pure.** |
| `src/minigames/registry.js` | The one place a rite is announced. **Pure.** |
| `src/minigames/rivals.js` | Deterministic opponents. **Pure.** |
| `src/minigames/Painter.js` | The world-unit drawing API. Takes a 2D context. |
| `src/minigames/MinigameHost.js` | Overlay, veil, keyboard shield, loop, clock, click queue, result, payout. |
| `src/minigames/rites/HeavenRite.js` | `heaven` — dodge everything pink. |
| `src/minigames/rites/PlatformsRite.js` | `platforms` — 28 dalles, they all fall. |
| `src/minigames/rites/LuckyShotRite.js` | `luckyshot` — the shooting gallery. **The reference rite.** |
| `src/minigames/rites/OffroadRite.js` | `offroad` — top-down rally, boost and bomb. |
| `src/minigames/rites/HuntRite.js` | `hunt` — the reaction shot. |
| `src/minigames/rites/FishingRite.js` | `fishing` — the leading shot. |
| `src/ui/minigames.css` | The overlay's styling. Tokens only, plus one `[data-rite]` block per rite. |
| `tests/unit/minigames.test.js` | Contract, schedule, registry, reward curve. `node` env. |
| `tests/unit/rivals.test.js` | The rival model on its own. `node` env. |
| `tests/unit/rite-theme.test.js` | Theme tokens reach the canvas. **`jsdom` env.** |
| `tests/unit/helpers/rite-contract.js` | `assertRiteContract(def)` — the checklist every rite passes. |
| `tests/unit/<id>-rite.test.js` | One per rite: the shared checklist plus what is specific to it. |
| `tests/unit/minigame-host.test.js` | Host: leaks, credit, clock, click queue, shield. `jsdom` env. |

---

## 1. The interface

A rite module exports a **definition**. The definition's `create()` returns a
fresh **instance**. Nothing else is exported to the rest of the game.

```js
/** @type {import('../contract.js').MinigameDef} */
export const LUCKY_SHOT_RITE = {
  id: 'luckyshot',             // stable; feeds the RNG label
  name: 'Lucky Shot',          // display title
  hint: 'Shoot the rows — left, right or Space, and count your rounds',
  duration: 20,                // seconds on the clock
  create: () => new LuckyShotRite(),
  // All optional. See §8's "Dressing" and the MinigameDef typedef in contract.js.
  theme: 'luckyshot',          // selects the [data-rite] block in minigames.css
  eyebrow: 'Gallery',          // overline; the host appends ' · before wave N'
  abandonNote: 'You left the gallery',               // result card, on a skip
  // cursor: 'none',           // omit to keep the stylesheet's crosshair
};
```

```js
interface MinigameInstance {
  init(ctx: MinigameCtx): void;

  /** Called at a FIXED dt. Return true to end the rite early. */
  update(dt: number, input: MinigameInput): boolean | void;

  /** Variable rate. MUST NOT mutate state. `alpha` is the step interpolation fraction. */
  draw(g: Painter, alpha: number): void;

  /** Pure. Safe to call at any time, any number of times. */
  score(): { ratio: number, headline: string, detail: string };

  teardown?(): void;

  /** Optional. Returns AND CLEARS presentation cues; the host turns them into sound and shake. */
  drainEvents?(): Array<{ type: string, x?: number, y?: number }>;
}
```

```js
type MinigameCtx = {
  rand: () => number,   // seeded — THE ONLY randomness a rite may use
  wave: number,         // the wave about to be prepared — THE difficulty axis
  occurrence: number,   // 0 for the first rite of the run — SHAPE, never difficulty
  width: 16,            // FIELD.w — always
  height: 9,            // FIELD.h — always
  quality: 'low' | 'medium' | 'high' | 'ultra',   // advisory, never gameplay
};

type MinigameInput = {
  x: number, y: number,     // pointer, in FIELD world units, at the END of the step
  inside: boolean,          // pointer is over the field
  down: boolean,            // primary pointer held at the end of this step
  action: number,           // COUNT of PRIMARY commits this step (left click / Space / Enter)
  altAction: number,        // COUNT of SECONDARY commits this step (right button)
  axis: { x: -1|0|1, y: -1|0|1 },   // held direction; +y is UP
  slots: number[6],         // per-choice press COUNTS this step, from keys 1-6
  clicks: PointerClick[],   // ordered, THIS STEP ONLY — read §1.1 before touching it
};

type PointerClick = {
  x: number, y: number,               // FIELD units, CAPTURED AT THE PRESS
  button: 0 | 2,                      // primary | secondary
  source: 'pointer' | 'key',          // a Space/Enter commit enqueues one too
};
```

### 1.1 The click queue, and its two sharp edges

`clicks` is the one part of the input record that will bite silently, so it gets
the same billing as the API itself.

**Why it exists at all.** `input.x/y` is where the pointer **is** at the end of
the step. `clicks[k].x/y` is where it **was** when the button went down. A press
on the target at A followed by a `pointermove` to B before the next fixed step
used to resolve at B — a hit became a miss, or a hit on the wrong animal. At
60 Hz with a fast hand that is a couple of world units, which is most of a
target. The position is now taken inside the `pointerdown` handler, from the
event, and carried to the step in a record.

**Edge 1 — the queue belongs to SUB-STEP 1 of a frame.** The host runs a fixed
step and a slow frame runs several of them. Everything that arrived since the
last frame is handed to sub-step 1; sub-steps 2..n see an **empty array**. Same
rule as `action`, for the same reason — handing the same three clicks to three
sub-steps turns one shot into three. So a rite may never assume it sees a click
every step, and may never accumulate `clicks.length` outside the step it was
handed.

**Edge 2 — the records are POOLED AND REUSED.** The host pre-allocates
`MINIGAMES.maxClicksPerStep` (12) records and refills the same objects on the
next `pointerdown`; the array handed to the rite is the same array identity every
step. That is what keeps a reaction game at zero allocation per frame, and it
means a rite that stores a `PointerClick` and reads it two steps later is reading
a shot the player took **afterwards**. **Copy what you keep** — `{ x: c.x, y: c.y }`,
never the record. This is the `Painter.ppu` of the input side: no runtime check,
and a failure mode that looks like a physics bug.

Beyond the cap the host **drops** clicks silently rather than growing the queue.
Twelve primary commits inside one frame is a macro or a stuck button, not a
player, and an unbounded queue is an unbounded frame.

All four shooting-shaped rites (`luckyshot`, `hunt`, `fishing`, and `offroad`'s
mines only indirectly) read `clicks` and **never** `action`/`altAction` for the
same press — counting both fires twice.

### 1.2 Right-click is an alias, never a requirement

The original map used right-click, and right-click works everywhere here for that
reason. It is **required nowhere**.

In `luckyshot`, `hunt` and `fishing`, **left, right and Space/Enter are one
verb**: all three enqueue a `PointerClick`, the rites iterate `clicks` and never
look at `button`. A keyboard commit enqueues a click at the last known pointer
position, so aiming with the pointer and firing with Space is a complete control
path.

The reason is a platform-fairness argument, and it is the reason not to
"simplify" this away: on a macOS trackpad the secondary click is a two-finger
press with a settling delay. In a game measured in tens of milliseconds, making
the secondary button the only route to the primary verb is a handicap applied to
one platform and to nobody else.

`offroad` is the single exception, and it is an exception because the two buttons
there are **two genuinely different decisions**, not two ways to say the same
thing: primary = **boost**, secondary = **bomb**. Neither is time-critical to the
millisecond, and — note, because it is stronger than the rule requires — **both
are still keyboard-reachable**: boost takes `action` (so Space/Enter), bomb takes
`altAction` **or** `slots[0]` (Digit1). So even in `offroad` the secondary button
is a convenience, not a gate.

### `slots` is for rites whose verb is *choose*

`axis` covers continuous verbs and `action` covers "now". Neither can say WHICH
of several a player picked. The host translates `Digit1..Digit6` and
`Numpad1..Numpad6` (by `e.code`, so the same six physical keys on AZERTY) into
six counters, in the same shape and for the same reason as `action`. A rite that
does not care never reads the field. `SLOT_COUNT` is 6 because six is the number
of elements, which is the only fixed-arity choice this game has. Today exactly
one rite reads it: `offroad`, for the bomb.

The letters `A S D F G H` were rejected: `A`, `S`, `D`, `W`, `Z` and `Q` are all
in the host's `AXIS_KEYS`, so a rite using them would be steering at the same
time.

### `score().ratio` is the only number that pays

`ratio` is `0..1`. The host owns the gold formula (`minigameReward` in
`contract.js`), so two rites played equally well are worth the same and a new
rite cannot accidentally be three times more lucrative than its neighbours.
`headline` and `detail` are strings for the result card and nothing else — but
write `detail` as **evidence**, especially for a blended ratio: `offroad`'s
`9/12 gates · 21 gold · 2nd of 4` is the difference between a score and a number.

### `action` is a count, not a boolean

The host runs a fixed step; a fast player can commit twice inside one 16.6 ms
slice. Collapsing that to a boolean silently eats an input, and eating an input
in a reaction game is the worst bug available. What a rite *does* with a count
above one is its own decision — `hunt` lets its recoil lock absorb the extras,
`fishing` casts exactly once and discards the rest — but it must at least *see*
it.

---

## 2. The coordinate space — read this one twice

**A rite never sees a pixel.** It works in a fixed **16 × 9 rectangle**, origin at
the **centre**: `x ∈ [-8, 8]`, `y ∈ [-4.5, 4.5]`, **+y is up**. The host
letterboxes that rectangle onto whatever canvas the player has, at their DPR.

Consequences, all of them load-bearing:

- Resizing the window changes the letterbox and **nothing else**. Difficulty,
  hit windows and travel distances are identical on every screen.
- A test at 1600×900 therefore proves something about every other screen. A rite
  written in pixels makes every measurement local to one monitor.
- `Painter` deliberately has **no accessor for the raw `CanvasRenderingContext2D`**.
  If a primitive is missing, add it to `Painter` in world units, for everyone.
  `blob`, `ellipse`, `capsule`, `clipRect` and `linearFill` were all added that
  way for the six rites; `blob` is the one that matters, because a canopy, a
  deer, a boar, a fish and a car body are all "a smooth closed silhouette" and
  `poly` only does straight segments.
- **`linearFill` is the one hole in "no raw context".** It returns a
  `CanvasGradient`, an opaque handle that escapes the class. The rule is written
  rather than enforced: call it from `draw` only, and pass the result straight
  back into a `fill`. The alternative — twenty stacked translucent rectangles —
  is worse and slower.
- `Painter.text`'s `size` and `tracking` are in world units too. Passing a
  pixel-sized tracking there renders one word across the whole field with the
  rest of the sentence clipped off — that happened, on the first screenshot.

---

## 3. Randomness — the determinism contract

Two players in the same room must get **the same rite, on the same wave, with the
same layout**. The server simulates nothing (`server/index.js`), so the seed is
the only thing holding two boards together. `src/core/Rng.js` states the rules;
they apply here without exception.

```js
import { riteRng } from '../schedule.js';
const rand = riteRng(seed, 'luckyshot', occurrence);  // rngFor(seed, 'minigame:luckyshot', occurrence)
```

The host builds this and hands it to you as `ctx.rand`. You never construct one.

**Both halves of the contract, or the room desyncs:**

1. **A constant number of `rand()` calls.** Always. Never inside a branch or a
   loop whose bound depends on anything but a module constant. Write the count
   down as a module constant named `RAND_CALLS`, as the arithmetic rather than as
   a literal (`ROWS + TARGETS + 3`, not `24`), and pass it to `assertRiteContract`
   as `randCalls`, which pins it on three different waves.
2. **A pure function of `(seed, id, occurrence)`.** No clock, no `performance.now`,
   no player state, no DOM measurement.

**`ctx.wave` may move the numbers and never the count.** That is the whole rule in
one sentence, and each of the six shows a different way to honour it: `heaven`
draws all 30 hazard bands on every wave and makes a late wave harder by
*compressing the spawn schedule*, so a low wave simply runs out of clock around
band 10; `luckyshot` scales row speeds only; `offroad` scales the track's
amplitude and the rival pressure; `SeededRivals` takes `wave` and spends exactly
`count * PER_RIVAL` draws regardless.

**`Math.random()` is banned in a rite**, including for particles. If you need
presentation noise, spend **one** `ctx.rand()` in `init` on a private
`mulberry32` seed and draw from that. All six do exactly this, and the reason is
sharper than "tidiness": a particle count or a wavelet phase drawn from
`ctx.rand` starts depending on the **quality preset**, and every value drawn
after that point differs between two players in the same room.

**The order of the draws is part of the seed contract too.** Moving the rival
draw ahead of `platforms`' tile shuffle rerolls every existing run's floor. Same
rule as `MINIGAME_IDS` (§8) and `rivals.js`'s `NAMES`.

---

## 4. Fixed timestep

`update(dt, input)` is always called with `dt === MINIGAMES.dt` (1/60), from an
accumulator, exactly like `Game.frame`. `draw` is called once per rendered frame
at a variable rate. A rite stepped at the display's refresh rate is a *different
game* on a 60 Hz panel and on a 144 Hz one, and that is not negotiable.

Corollaries:

- Do not read `performance.now()`. Accumulate `dt`.
- Do not store a direction flag you flip at a boundary — over a few hundred steps
  two clients accumulate different rounding. Accumulate a *phase* and derive
  position from it with a pure function (`contract.js` exports `tri` for this).
  `offroad`'s centreline is the strongest form of this: `centreAt(s)` is a sum of
  three sines of the distance travelled, so the road's shape is a pure function
  of `s` with no integrated state and no per-step noise to drift.
- The host clamps a frame to `MINIGAMES.maxFrameDt` (100 ms) before it
  accumulates, so a stall replays at most 100 ms, never the whole stall.

---

## 5. What the host guarantees

- **Five seconds before anything happens.** The host opens in `mode:
  'countdown'` and announces the rite by name over its own opening position —
  five, four, three, two, one, *Go* — and only then starts the clock and the
  first fixed step. Your `init()` has already run, so what is announced over is
  the field the player is about to be handed; your `update()` has not, so the
  hunt's animals are not already crossing while the hint is still being read.
  Nothing about it reaches you: the pre-roll spends no `dt`, no `duration`, and
  no `rand()`. It is **skippable** by the same commit that plays the rite
  (Space / Enter / a press on the stage), and that press is **not delivered as
  a commit** — it starts the game, it does not fire the first shot. A blur
  during the count suspends it exactly as it suspends play, and Escape (twice)
  abandons a rite that never began, for nothing.
- **A veil and a keyboard shield.** Every game key is swallowed at capture on
  `document` while a rite is up. Without it, Space — this overlay's primary verb
  — sends the next wave from behind the veil. That is a real, measured incident
  in this repo (see `HUD.js` `_onKeyShield`).
- **A click resolves where it was pressed.** §1.1. The queue is also **cleared on
  suspend**: the click that gave the window its focus back is not a shot.
- **One gold credit, ever.** `#settle` is guarded by `_credited`. Escape spam, a
  Skip click during the result animation, and a rite finishing on the same step
  the clock expires all converge there.
- **No leaked listeners.** Everything is registered through `#hold`; `close()`
  runs every disposer. `host.listenerCount` is 0 whenever the overlay is shut,
  and a unit test measures it from the platform, not from the host's own count.
- **No context menu.** `contextmenu` is `preventDefault`ed on the whole overlay,
  not just the stage, so a right-click on the veil does not open a menu over a
  running clock.
- **A blur costs nothing.** `blur` / `visibilitychange` / `pagehide` suspend the
  clock and the logic; coming back costs a visible 1.2 s grace and no score. The
  keypress that wakes it is discarded, not counted as a commit.
- **Resize safety.** The canvas resizes (observed, not polled) and the letterbox
  is recomputed. Your logic never notices.
- **1× speed.** The rite runs from the variable-rate half of `Game.frame`, so
  `state.speed` (1×/2×/3×) does not reach it.
- **A crash is contained.** An exception from your `update` or `draw` is caught,
  reported through `console.error`, and the rite is abandoned with zero reward —
  the run continues. Without that wall, a throw propagates into main.js's rAF
  loop and *kills the whole game*. It is caught, not swallowed: the e2e suite
  asserts an empty console, so a throwing rite still fails the build.

## What the host does NOT guarantee

- **No pause.** `P` is swallowed. A rite is 20–26 seconds; it is not pausable.
- **No spectating, no networking.** No message crosses the wire for a rite. Each
  player plays their own instance and banks their own gold; fairness is the seed.
  §14 and §15 say what that costs and why it is still the trade.
- **No `alpha` interpolation for free.** `draw(g, alpha)` gives you the fraction
  into the next step; interpolating with it is your job, and most rites do not
  need to (16.6 ms of positional lag is invisible at these speeds).
- **No guarantee `draw` is called at all.** A 0×0 canvas (an overlay still
  transitioning in, a `display:none` ancestor) skips rendering entirely. Never
  put logic in `draw`.
- **No cleanup of your own timers.** Do not create any. Accumulate `dt`.

---

## 6. Scheduling and reward

A rite follows the clearing of wave `n` when `n % 5 === 3`, from wave 3 to wave
53 — **11 rites**, one per five waves, exactly matching the 11 element picks.

The period is a multiple of `ECONOMY.elementEveryWaves` with a non-zero offset,
which makes a collision with an element-pick wave **arithmetically impossible**.
That matters: a wave that granted both would put a rite on top of the element
picker, and two stacked full-bleed dialogs is the one shape this feature must
never produce. `schedule.js` throws at import time if someone edits the cadence
into a collision, and if a rite is somehow forced onto a pick wave anyway (the
dev panel can), `Game.#advanceAfterWave` runs them **sequentially**: picker
first, rite second, prep last.

Which rite is a **seeded shuffle of the registry, dealt one per occurrence**, so
each rite appears exactly once per cycle of `MINIGAME_IDS.length` and the order
is the seed's rather than the code's. It does *not* guarantee a change across a
cycle boundary; that is stated in `schedule.js` rather than papered over.

**11 rites over 6 ids therefore means every run plays all six** — five of them
twice, one exactly once. Occurrences 0–5 are cycle 0 (the full shuffle), 6–10 are
cycle 1's slots 0–4. Nothing special-cases this; the existing cycle arithmetic
produces it for free.

### The reward curve

```
perfect = max(MINIGAMES.minPerfect, nextWaveGross * MINIGAMES.perfectFrac)
reward  = round(perfect * ratio ** MINIGAMES.payCurve)
```

with `nextWaveGross = waveDef(wave).count * waveDef(wave).bounty`. Currently
`minPerfect = 40`, `perfectFrac = 0.24`, `payCurve = 1.25`. In one line:

```
reward = round(max(40, gross × 0.24) × ratio ** 1.25)
```

**One curve. No floor, no threshold.** `floorFrac` and `payThreshold` are not
zeroed, they are **deleted** — a constant sitting at zero is an invitation to
turn it back on. What they built between them was a cliff: at wave 53 a ratio of
**0.119 paid 0 and 0.121 paid 262**. Nothing on screen marks that edge (the
player never sees `ratio`), so the difference between "nothing happened" and "a
fifth of a wave" was two thousandths of an invisible number. And the threshold
had to be re-measured against every new rite's do-nothing score to stay correct,
which is a constant that rots silently.

Measured over a full 55-wave run — **62 210 gold of bounty income, 11 rites** —
playing every rite at a constant ratio is worth:

| ratio | rite gold | share of run income |
|---:|---:|---:|
| 1.00 | 3 224 | 5.2 % |
| 0.75 *(a competent player)* | 2 251 | 3.6 % |
| 0.30 | 717 | 1.2 % |
| 0.10 | 180 | 0.3 % |
| 0.02 *(idle, over an entire run)* | 24 | 0.04 % |

A competent player lands within ~1.4 % of the old curve's total, so nothing about
the economy moves. An idle one earns **24 gold across a whole game**, less than a
single tick of interest. `tests/unit/minigames.test.js` pins the 3 224 and the
62 210 against the real wave table rather than trusting this page.

**The property that matters.** Skipping pays 0 (`MinigameHost.#settle` returns
before the formula) and a ratio of 0 pays 0. Those two used to agree only because
a tuned constant sat above every measured idle score. They now agree **by
construction** — `0 ** 1.25` is 0 — for any rite anyone ever writes, with nobody
having to remember to re-measure. There is no strategy in choosing between Escape
and looking away, because they are worth the same.

**And there is no discontinuity anywhere.** `payCurve > 1` makes the bottom of
the range cheap (a ratio of 0.02 pays 2 % of perfect, not 21 %) while leaving the
top untouched, and the function is continuous over the whole domain.
`minigames.test.js` sweeps 1 000 adjacent ratios at two wave grosses and asserts
no pair ever jumps — the one assertion that would have caught the old cliff.

Playing badly still pays *something*, which is the design intent that did not
change: never punish someone for having tried.

---

## 7. Escape, and why it asks twice

Escape is the panic key everywhere else in this game (`Game.#cancelSelection`).
A reflex that silently forfeits a wave's worth of gold is a trap, so the first
Escape *arms* — the Skip button relabels itself "Escape again to abandon" — and
a second Escape within 2.4 s confirms.

The Skip **button** commits on the first click. A deliberate act on a labelled
control does not need a confirmation; a reflex does. That asymmetry is the whole
reason there is no confirmation dialog stacked on top of a dialog.

The result card's detail line on a skip comes from `def.abandonNote`, because the
literal used to be "You stepped away from the anvil", which was true of exactly
one rite and is now true of none.

---

## 8. Writing a rite

**Read `src/minigames/rites/LuckyShotRite.js` first.** It is the reference on
purpose, and the reasons are the reasons to copy it: it exercises the click queue
(the one part of the input contract with a sharp edge), it does **not** use
`rivals.js` (so nothing in it is about competition), its randomness budget is a
single flat list of draws in `init`, and it **ends early by returning `true`**
rather than waiting out the host's clock. Everything a new author needs and
nothing else.

Its shape, in miniature — a rite that asks you to hold the pointer inside a
circle:

```js
// src/minigames/rites/VigilRite.js
import { clamp } from '../contract.js';

const DURATION = 12;
const R = 1.4;
/** ctx.rand() calls made by init(). EXACTLY this many, every wave, always. */
const RAND_CALLS = 2;

class VigilRite {
  init(ctx) {
    // EXACTLY RAND_CALLS draws, unconditionally, in a frozen order.
    this.cx = (ctx.rand() * 2 - 1) * 5;
    this.cy = (ctx.rand() * 2 - 1) * 2.5;
    this.held = 0;
    this.t = 0;
    this._events = [];
    this._wasIn = false;
  }

  update(dt, input) {
    this.t += dt;
    const inside = input.inside && Math.hypot(input.x - this.cx, input.y - this.cy) <= R;
    if (inside) this.held += dt;
    if (inside !== this._wasIn) { this._events.push({ type: inside ? 'good' : 'miss' }); this._wasIn = inside; }
    if (this.t >= DURATION) return true;      // end early rather than wait for the clock
  }

  draw(g) {
    g.circle(this.cx, this.cy, R, { stroke: '#e5bd79', width: 0.05 });
    g.save().add();
    g.halo(this.cx, this.cy, R * 1.8, '229,189,121', 0.06 + 0.14 * this.score().ratio);
    g.restore();
    g.text(`${Math.round(this.score().ratio * 100)}%`, 0, -3.6, { size: 0.5, fill: '#a3a9bb' });
  }

  score() {
    const ratio = clamp(this.held / DURATION, 0, 1);
    return {
      ratio,
      headline: ratio > 0.9 ? 'Unwavering' : ratio > 0.5 ? 'Steady' : 'Distracted',
      detail: `${this.held.toFixed(1)}s of ${DURATION}s held`,
    };
  }

  drainEvents() { const e = this._events; this._events = []; return e; }
  teardown() { this._events = []; }
}

export const VIGIL_RITE = {
  id: 'vigil',
  name: 'The Vigil',
  hint: 'Keep the cursor inside the sigil',
  duration: DURATION,
  create: () => new VigilRite(),
};

export { VigilRite, RAND_CALLS, DURATION };
```

Export `RAND_CALLS` next to the class: the test file needs it, and a budget the
test re-derives is a budget that can drift from the draws.

Then, in `src/minigames/registry.js` — **two lines, nothing else in the codebase**:

```js
import { VIGIL_RITE } from './rites/VigilRite.js';
export const RITES = { /* ...the six... */ [VIGIL_RITE.id]: VIGIL_RITE };
export const MINIGAME_IDS = Object.freeze([
  'heaven', 'platforms', 'luckyshot', 'offroad', 'hunt', 'fishing',
  'vigil',                                                   // APPEND ONLY
]);
```

> **`MINIGAME_IDS` order is part of the seed contract.** It is fed to `pickN`,
> whose output depends on input order, so reordering it changes which rite every
> existing seed produces. **Append; never shuffle — from the six-id baseline
> above.** Same rule as `ELEMENT_IDS`.
>
> The rule was broken **exactly once, on purpose**: the four invented rites
> (`forge`, `verdict`, `coulee`, `hearth`) were deleted and the six replaced them
> in a **single commit**, never an intermediate state with ten ids — which would
> have shipped a build whose schedule could deal a rite that was about to stop
> existing.
>
> That was safe for one reason: **nothing persists a rite id.** Verified, not
> assumed — the only durable storage this game has is `localStorage`, holding the
> render preset (`main.js`), the display name (`ui/Lobby.js`) and the personal
> best `{score, wave, won, at}` (`net/BestScore.js`). No run state, no seed, no
> rite. Re-check that before ever breaking the rule again; the day something does
> persist a seed mid-run, "append only" stops being a style preference.
>
> The registry cross-checks itself at import: an id in `MINIGAME_IDS` with no
> entry in `RITES` (or the reverse) throws immediately, because the alternative
> is a silent 404 mid-run on someone else's seed.

**Grep trap, flagged because it was hit:** `forge` and `hearth` are also this
game's *art* vocabulary (`src/world/env/*`, `TowerDefs.js`, `ProceduralTextures.js`,
`Inspector.js`). None of those hits are minigames. A blind `sed` breaks the
rendering.

### Dressing: `data-rite` and the optional def fields

The host puts `data-rite="<theme ?? id>"` on `#rite` when the overlay opens and
**removes it on close** — a stale theme on a shut overlay bleeds into the next
rite's entry transition, after the swap but before it is visible.
`src/ui/minigames.css` defines the neutral defaults as tokens
(`--rite-stage-bg`, `--rite-veil`, `--rite-accent`) and one three-property block
per rite. Nothing about the stage gradient is hard-coded in JS.

`theme` is separate from `id` because **`id` is part of the seed contract** —
renaming it rerolls every existing run — while a theme is only paint, and two
rites are allowed to share one. `eyebrow` (default `'Interlude'`, the host
appends ` · before wave N`), `abandonNote` (default `'You walked away'`) and
`cursor` (default: the stylesheet's crosshair) are the other three. `heaven` sets
`cursor: 'none'` because the mote *is* the pointer; `platforms` and `offroad` set
`'default'`, because a crosshair over a car is a promise the controls do not
keep.

Rites read their palette tokens the way `Lottery.js:722-734` does: one
`getComputedStyle` in `init`, guarded for jsdom and node, with literal fallbacks —
**never per frame**, and never as hard-coded hex in the draw code.

#### The token a rite reads is `--rite-<id>-<thing>`, on `:root`. Never the generic one.

> **A rite has no DOM.** It is handed a `Painter` and nothing else, so the only
> element it can call `getComputedStyle` on is `document.documentElement`. The
> three generic names above are declared **inside `#rite[data-rite="x"]`**, which
> a rite never sees — so reading `--rite-accent` from a rite silently misses and
> the literal fallback is what actually paints. Six rites shipped that way and
> four of their authors reported it.
>
> The generic names cannot move to `:root` — `--rite-accent` is one name and
> there are six accents. So:
>
> - **every flat colour a rite's canvas paints with is declared on `:root`** in
>   `minigames.css` under a prefixed name (`--rite-hunt-canopy-far`,
>   `--rite-fishing-deep`, …);
> - the `[data-rite]` block **aliases** what the chrome needs
>   (`--rite-accent: var(--rite-hunt-accent);`) and declares no colour of its own;
> - the rite reads the **prefixed** name, with the same value as its literal
>   fallback so it still runs in node.
>
> `tests/unit/rite-theme.test.js` (jsdom) pins both halves: setting a property on
> the root moves what the canvas paints, and the value the canvas paints is the
> value written in the shipped stylesheet.
>
> **Two values deliberately stay literal, and both are arguments about kind
> rather than convenience.** `HeavenRite`'s two pinks are the KILL RULE, not
> paint — "pink is the only saturated magenta on the stage" is an accessibility
> claim, and a value another theme block can redefine is a claim nothing
> enforces. `LuckyShotRite.BOOTH_INK` tracks the dark end of `--rite-stage-bg`,
> which is a multi-stop gradient no canvas can resolve. Same for `HuntRite`'s
> pelt and ember: they are the SUBJECT, and retuning the room must not move the
> thing you are aiming at.

### Presentation cues

`drainEvents()` is how a rite gets sound and impact without knowing the host
exists. The host maps the cue types onto sound and a proportional CSS kick on the
stage, from a table (`CUES` in `MinigameHost.js`):

| type | sound | kick | for |
|---|---|---|---|
| `perfect` | `upgrade` | 1.0 | the handful of moments that earned a jolt |
| `good` | `build` | 0.55 | an ordinary success |
| `miss` | `deny` | 0.3 | an ordinary failure |
| `tick` | `build` | **none** | a frequent, low-stakes positive |
| `break` | `deny` | 1.0 | something you were protecting gave way |
| `fail` | `leak` | 0.9 | death, elimination, the last platform |
| `gold` | `select` | **none** | a coin, a nugget, a pickup |
| `boom` | `bossDeath` | 1.0 | a bomb, a crash, a wipeout |
| `start` | `waveStart` | **none** | the go signal, once per rite |
| `claim` | `sell` | 0.2 | a rival got there first |

The rule the table encodes: a cue that can fire forty times in twenty seconds
must not shake, or the result is nausea rather than impact — which is why `tick`
and `gold` are silent-bodied and frees `perfect` for the moments that matter.

`ev.x` biases the kick horizontally (a hit on the right of the stage throws the
stage right); absent or off-field, the kick is vertical.

Unknown types are **ignored, deliberately and silently** — `drainEvents` is
presentation, and a typo in a string must never be able to spam the console or
crash a frame. Extend `CUES` if you need a new one.

Note the kick is a **CSS animation on the stage**, not `CameraRig.addShake`: the
3D board is behind a heavy veil during a rite, so shaking the camera spends real
shake budget on something nobody can see.

---

## 9. Testing a rite

Unit tests live in `tests/unit` with `environment: 'node'`. **You may not import
`three` or `src/main.js` there**, which is exactly why the logic is separated
from the rendering. A rite module imports only `contract.js`, `Rng.js`, `Config.js`
and (if competitive) `rivals.js`, so it drops straight into a node test.

### `assertRiteContract` — the checklist, once, for everybody

`tests/unit/helpers/rite-contract.js` exports `assertRiteContract(def, opts)`.
Call it from inside an `it()` in your rite's test file; it is a helper, not a
suite (vitest only collects `*.test.js`). Every failure message names the rite
and the rule, because "expected 0.3 to be less than 0.15" in a six-rite run tells
the reader nothing.

```js
import { assertRiteContract } from './helpers/rite-contract.js';
import { VIGIL_RITE, RAND_CALLS } from '../../src/minigames/rites/VigilRite.js';

it('passes assertRiteContract', () => {
  assertRiteContract(VIGIL_RITE, { randCalls: RAND_CALLS, skilled });
});
```

What it guarantees, in order:

0. **The published shape.** `create` is a function, `duration` is positive,
   `init`/`update`/`draw`/`score` all exist, and `create()` returns a *fresh*
   instance each time.
1. **A fixed rand budget**, checked at waves **3, 28 and 53** against the exact
   number you passed. `randCalls` is required and required to be a literal the
   author wrote down — the assertion is "this number", not "some fixed number",
   so a stray draw inside a loop bound is caught rather than absorbed.
2. **Determinism.** Same seed, same scripted inputs (from a *separate* generator,
   so the two runs agree by construction and not by reading the rite's own
   state), twice — identical `score()` and identical step count.
3. **An idle run terminates, and is worth nothing.** It must end inside its own
   clock and score under **0.15**. Both halves matter: a rite that waits for an
   input it never gets hands the player a full clock of nothing, and since the
   reward curve has no gate any more (§6), the rite's own idle score is the only
   thing keeping "start it and look away" unprofitable.
4. **Mashing is not a strategy.** Pressing everything every frame must stay under
   **0.6** — a deliberately generous floor under "there is some skill here", not
   a tuning knob. Pass `skilled` (a strategy that plays properly) and the claim
   upgrades from a ceiling to a direct comparison: mashing must score *strictly
   less* than playing. Pass `mashCeiling` only with a comment saying why; today
   `offroad` is the rite that would need it, because its throttle is automatic.
5. **Fuzz: finite and bounded.** 1 500 steps of adversarial input — longer than
   any rite's clock on purpose — must leave `score()` finite and in range, and
   the instance's total array load under `max(4000, 25 × initial)`. A rite that
   stays finite only because something else stopped it is one refactor from a
   NaN, and one NaN in a draw call is a blank frame with no error attached
   (`docs/PITFALLS.md` §9).
6. **`score()` is pure.** Two consecutive calls agree, and neither mutates the
   instance (structural snapshot, depth-limited). A `score()` that drains a queue
   or lazily resolves the last target is a payout that depends on how many times
   the host happened to ask — and the host asks once, the result card asks again,
   and tests ask constantly.
7. **`drainEvents` empties.** Optional method, mandatory behaviour if present: a
   queue read without being cleared plays the same sound every frame for the rest
   of the rite.

The harness itself is tested — `tests/unit/rite-contract.test.js` feeds it
deliberately broken rites and asserts each rule fires.

### What your own file still owes

The checklist proves a rite is *legal*. It cannot prove it is the game you meant.
Add, per rite:

- **Different seeds produce a different layout** (otherwise determinism and the
  rand budget both pass on a rite that ignores the seed entirely).
- **The one geometric or arithmetic fact the design rests on.** `luckyshot`
  searches for a real overlap between its front two rows, because "the frontmost
  target wins" is a rule with teeth only if the ranks actually touch. `fishing`
  asserts that the slowest, longest fish still out-swims its own catch ellipse
  during one sink — if it did not, aiming *at* a fish would work and the rite
  would silently collapse back into `hunt`.
- **The `skilled` strategy**, which is what turns rule 4 into a real claim.

### The calibration gate — the cross-rite half, which no rite suite can hold

`tests/unit/calibration.test.js` is not a regression test and **is expected to
fail**. Its failures are the tuning work list, and it goes green on the day the
six rites agree with each other.

Everything above validates a rite against *itself*: perfect scores ~1, idle
scores ~0. Nothing in a per-rite suite can notice that one competent player
scores **0.148 in `heaven` and 0.973 in `platforms` on wave 3** — a tenfold
difference in gold decided by which rite the seed dealt, in direct contradiction
of the promise `minigameReward` makes out loud.

`tests/unit/helpers/reference-player.js` is the instrument: one parameterised
simulated player (`{ reactionLag, aimSd, decisionNoise, pointerSpeed }`) that
drives any of the six through the real fixed step. It splits into a **brain per
rite** — lifted from the strongest bot that rite's own suite already had, so the
ceiling is honest — and **one body for all six**, which applies the degradation.
Because the body is shared, the only variable left between two rites' scores is
the rite. Read its docblock before using it; it names its own blind spots.

The gate asserts, for every rite:

1. the **target curve** — `0.82 / 0.68 / 0.54 ± 0.12` at waves 3 / 28 / 53 for
   the reference player, averaged over five seeds;
2. **idle is strictly worse than trying**, by at least 0.15, at every wave;
3. **a mid-band exists** — a clumsy player lands between the ends rather than
   snapping to one of them, i.e. the ratio is not a pass/fail switch;
4. **monotonic in skill** — more skill never scores less;
5. **monotonic in wave** — a fixed player never scores higher on a later wave;
6. **the ceiling stays reachable** — flawless play still reaches 0.75 at wave 53.

If you are tuning a rite: `npx vitest run tests/unit/calibration.test.js -t <id>`.
Every message names the rite, the wave, the measurement and the requirement. Do
not tune by scaling `score()` — that moves the problem onto the result card,
where the headline says "Flawless" over a 0.54. Tune the game.

The host's own guarantees are covered by `tests/unit/minigame-host.test.js` and
do not need repeating per rite: the click queue reaching sub-step 1 only, a
right-click producing `button: 2` without touching `action`, `contextmenu` being
`defaultPrevented`, the press-at-A-move-to-B case resolving at **A**, the queue
being cleared by `#suspend`, and `listenerCount === 0` after close.

---

## 10. Running one from the dev panel

`F9` (or `²` on AZERTY, or the **DEV** button in the top bar) → the **Rite** row.
Pick the rite, set the wave in the **Vague** field, press **Lancer**. It goes
through `Game.startMinigame(id, wave, occurrence)`, the same public entry point
the real schedule uses, with the occurrence index the real schedule would have
computed for that wave — so what you see is what a player on this seed would get.

The **Loterie** row calls `game.lottery.devOpen(wave)` if such a method exists and
reports "pas encore branchée" if it does not. **That hook is now live** —
`src/ui/Lottery.js` exposes it, and the wager is documented in `docs/LOTTERY.md`.
The duck-typed call is kept as written: it costs nothing and it is what let the
button ship before the method existed.

The wager is **not a rite** and does not go through this host. It pays from a
table rather than from a skill ratio, it has no clock and no Skip, and a
transaction you have already paid for cannot be abandoned. What it reuses is
every safety property listed in §5 — veil, capture-phase keyboard shield, one
guarded credit, disposer list, 2D canvas over a CSS-darkened viewport — plus
`Painter` verbatim.

`src/dev/` never ships (`npm run check:nodev`); do not add a rite hook anywhere
outside `DevPanel.js`.

---

## 11. Pitfalls

**Never give a Painter field the name of a Painter method.** `this.scale` (the
letterbox factor) shadowed a newly added `scale(x, y)` method, `g.scale(1, 0.3)`
became "call the number 1.0", every `draw()` threw, and — because the rAF loop in
`main.js` has no try/catch — the whole game froze on the rite's first frame. The
error message points at the method, not the field, which is why it cost twenty
minutes. The field is now `ppu`, and the host now contains a throwing rite.
(`docs/PITFALLS.md` §15.)

**Never keep a `PointerClick`.** §1.1, restated here because this is where people
look after the fact: the records are pooled and refilled, so a stored one starts
reporting a later shot's coordinates. Read `c.x`/`c.y` into locals inside the
step. The symptom is a hit registering in the wrong place a fraction of a second
later, which reads as a physics bug in your own code.

**Never assume a click arrives every step.** The queue is handed to sub-step 1
of a frame and sub-steps 2..n get an empty array, so any logic of the form "if no
clicks this step, then…" fires spuriously on a slow frame.

**Do not put gameplay in `draw`.** It is skipped on a zero-sized canvas and
called a variable number of times per step. Keep particle simulation in
`update` for exactly this reason, even though particles are purely cosmetic. If
you need per-frame scratch space, put the buffer at **module** scope, not on
`this` — `draw` must not mutate the instance, and a test proves it. That is legal
only because the host draws exactly one rite at a time, on one thread; both
`luckyshot` and `offroad` say so at the buffer's declaration rather than leaving
it to be discovered.

**Do not read `input.x/y` when `input.inside` is false.** The host leaves the
last known position there rather than resetting it, deliberately — a reset to the
origin is a *jump* that a rite would read as real movement — so what you get is
stale, not neutral. Guard it for finiteness too: one NaN position becomes a blank
frame with no error attached.

**A `duration` shorter than your own worst case truncates the rite.** If every
step of your rite can time out, `duration` must exceed
`steps × (per-step timeout + resolve hold)`, or a player who does nothing sees
fewer results than the UI promised. Derive the number rather than feeling it, and
assert in a unit test that the idle run finishes inside it. `platforms` shows the
honest version of the other direction: its own schedule wants 25.99 s at wave 3
and gets 24, so the score's denominator is `runLength`, the *shorter* of the two,
and both cases are scored out of the run the player actually got.

**Escape and the result card race by design.** Never assume `close()` happens
after `#settle()`; both are idempotent and both can be reached from three places.
If you add a fourth, guard it the same way.

---

## 12. Design rules that outlive any one rite

**Colour is never the only channel.** Hazard and value identity must be carried
redundantly — position, shape, size, outline, motion — or the rite is unplayable
for a colour-blind player. `heaven` is the load-bearing case, because "avoid the
pink" on one colour channel is otherwise a colour test with a timer: every pink
mass gets a **hard black outline** and a **4 Hz pulse**, the safe route is drawn
*positively* in the cool accent, chevrons point at the way through, and pink is
the only saturated magenta anywhere on the stage. `luckyshot` encodes a row's
value three ways at once — height, size and speed — so the back row reads as
worth more before anyone has read a number. `platforms` gives its crack warning
four channels: a fuse bar whose *length* is the time left, a colour flip, an
accelerating shake and widening seams.

**A pulse goes on the glow, never on the silhouette.** A shape that breathes is a
shape whose hitbox appears to breathe, and a hitbox that lies is worse than no
second signal at all. The filled silhouette is the collision volume, every frame.

**Never `CameraRig.addShake`.** The 3D board sits behind a heavy veil during a
rite, so camera shake spends real shake budget on something nobody can see. The
host's CSS kick on the stage is the impact channel.

**Every rite needs an anti-mash rule, and it should come from the fiction.**
`luckyshot` has a hard ammo cap (24 rounds, spent on a miss too) — that one is
*the rite*, not tuning, and softening it makes spraying the field optimal.
`hunt` does it better for its own shape: a shot that hits nothing **spooks the
animal**, which punishes exactly the behaviour the rite is about resisting and
says "you scared it off" instead of "you have run out". `fishing` uses the reel
(1.05 s per empty cycle against 0.65 s for a landed one). `offroad` makes boost
in the scrub a net loss. `platforms` and `heaven` do not need one: their verb is
position, and there is nothing to mash.

**Scale one thing with the wave, not two.** A rite's payout already scales with
the wave, because `minigameReward` multiplies by the next wave's gross. Indexing
the rite's own PAR to the wave as well charges the player twice for the same
wave — harder targets *and* a higher bar, for gold they were going to get for the
same quality of play. `luckyshot`'s PAR is deliberately constant.

**`ctx.occurrence` varies the shape. `ctx.wave` varies the difficulty. Never
swap them.** Five of the six rites appear twice in a full run, and until
`occurrence` reached the ctx no rite could tell the two apart: the second visit
was the same world with a different roll of the same dice — the same count of the
same things, arranged by the same rule. `occurrence` (0 for the first rite of the
run, from `riteOccurrence(wave)`) is how a rite says *the second time, the belt
runs the other way* or *the second time, the gates are diagonal*. A different
**shape**, at the same difficulty.

The prohibition is not stylistic. `tests/unit/calibration.test.js` states one
target curve as a function of `wave` and holds all six rites to it. A rite that
also stiffened on `occurrence` would score two different things at the same wave
depending on where the run happened to place it, and that makes the curve
unmeasurable for *every* rite, not only the one that cheated — the calibration
harness would be reading a difficulty it cannot see or control. It is
determinism-safe (two players on one seed see the same occurrence); what it
breaks is the comparison, silently.

Constraints, all inherited from §3: it may not change the **number** of
`ctx.rand()` calls (`assertRiteContract` pins that at three waves), and a rite
that ignores `occurrence` entirely is completely correct.

---

## 13. The six rites

Every one of these files opens with a substantial design docblock. What follows
is the index, not the argument — go read the file before changing a number in it.

### `heaven` — "escape from gay heaven" · 20 s · 121 draws · no rivals

A bone-white cloud corridor scrolls right to left; you are a mote of soul-light
threading through it. **Everything pink kills on contact, instantly.** The name
is kept verbatim, because it is the name the map used.

- **Controls.** The mote **chases** the cursor at a clamped `MOVE_SPEED` of
  7 u/s rather than *being* the cursor — without the clamp the pointer is a
  teleport and no dodging game survives an instantaneous actuator. `axis`
  (arrows / WASD / ZQSD) is normalised to the *same* top speed, so a diagonal is
  not 1.41× faster and the keyboard path is exactly as good as the pointer — the
  only honest way to offer two. Held keys win over the pointer. `cursor: 'none'`.
- **Course.** 30 hazard bands (gates, sweeps, bobbing orb accordions), all drawn
  on every wave; difficulty compresses the *schedule*, never the count (§3). The
  **first band is always a sweep**, and a sweep covers the whole column — which
  is both the idle guarantee (stand anywhere, die in ~2 s) and the tutorial: it
  says FOLLOW THE GAP in one gesture and no words.
- **Score.** `ratio = survived / 20`. Detail names the seconds and the bands
  cleared. Near misses under 0.42 u fire a `tick`, once per band.
- **Known, accepted edge**, named in the file rather than left for a reviewer:
  hanging back at the far left buys ~0.7 s of extra lookahead. It makes the rite
  calmer, not easier — you still have to be at the gap's y when the band arrives
  — and fixing it needs a scrolling camera or a chasing wall, which is more
  machinery than a 20-second rite should own.

### `platforms` — Falling Platforms · 24 s · 41 draws · rivals

Twenty-eight stone dalles over a void, 7 × 4. They crack, they shake, they go.
You and three rivals stand on them and **the only verb is where you stand**.

- **Controls.** `axis` only, continuous at 4.4 u/s, diagonals normalised. **The
  marker is not snapped to tiles**: a tile-snapped marker turns every decision
  into a keypress that lands or does not, and all the pressure of a falling-floor
  game is in the half second where you are committed and not yet across. The cost
  is named: cell boundaries are invisible mid-move, so the drawn gaps between
  plates are **paint only** — you fall because the cell under you is gone or off
  the grid, never because you were over a seam.
- **Three legibility tiers**, because the warning *is* the game: settled →
  stressed (desaturated, hairline seam, slow tremble, `STRESS_LEAD` × the warning
  ahead of it) → cracking (loud, four redundant channels). The warning-to-interval
  ratio is ~2.8 so about three plates are live at once. A first pass at 1.0 s
  against a 0.85 s interval was **measured wrong**: with one doomed plate among
  four neighbours, moving anywhere was correct, and a scripted player who could
  see nothing beyond the loud tier scored 0.92 — identical to an omniscient one.
- **Score.** `0.75 × (alive / runLength) + 0.25 × (rivals outlasted / 3)`.
  `runLength` is the shorter of the clock and the schedule, so both the wave-3
  case (the floor never quite empties) and the wave-53 case (the floor runs out
  at ~13.9 s and the rite ends there) are scored out of the run the player got.

### `luckyshot` — Lucky Shot · 20 s · 24 draws · no rivals · **the reference**

A carnival booth. You do not move. Three rows of creep cut-outs track across at
different speeds and depths; the back rows are smaller, faster and worth more
(1 / 2 / 3). One of the eighteen is **golden** (×3, and it stays down nearly
three times as long, or the optimal line would be to camp its respawn) and one is
a **bystander** (−1, the only way to lose points).

- **Controls.** Aim with the pointer, fire with **left, right or Space** — one
  verb, three inputs (§1.2). It reads `input.clicks` and nothing else, never
  `button`, never `action`/`altAction`.
- **24 rounds, spent on a hit and a miss alike**, and running out ends the rite
  after a 0.45 s beat so the last shot is seen to land. This is the rite, not a
  tuning number: without it the optimal play is to spray the field at 60 clicks a
  second, which is a benchmark of the player's mouse. Do not soften it, do not
  refund a miss, do not top it up on a streak.
- **Score.** `ratio = points / PAR`, `PAR = 38` — nineteen hits at the average
  value of 2, i.e. 79 % accuracy on moving targets. A good run, not a perfect
  one: a ceiling nobody reaches is decoration. PAR does **not** move with the
  wave (§12); the wave speeds up the rows and the reward already scales.
- The front two rows deliberately **overlap** (gap 1.35 against summed radii
  1.50), which is what makes "the frontmost target wins" a rule with teeth; the
  targets array is built front-first so the hit test is two lines and not a sort.

### `offroad` — Offroad Racing · 26 s · 58 draws · rivals · **the two-button rite**

Twelve gates, thirty nuggets, three boosts, two bombs, one dirt track. The
longest clock of the six, because a race under 20 s is not a race.

- **Top-down, not pseudo-3D**, and that is a decision rather than a shortcut.
  This Painter has no perspective texture mapping and no path primitive, so an
  Out Run road would be flat-shaded quads whose seams pop as they scroll — it
  reads as a rendering bug, not as a road receding. The speed comes from the
  ground rushing past, which top-down gets for free.
- **Controls.** `axis.x` steers, or the pointer's x if no key is held (keys win —
  mixing the two produces a car that fights itself). The throttle is automatic.
  **Primary = boost** ×3 (`action`, so Space/Enter too), **secondary = bomb** ×2
  (`altAction` *or* Digit1). The car does not self-centre: understeer pushes you
  *outward* from the racing line and every corner slides you to its outside, so
  holding the line is continuous work — and, measured, that is also what makes
  the idle score a property of the *rite* rather than of the seed. Without those
  two terms an unattended car drove dead straight and one seed in twenty paid
  over 0.15.
- **The bomb is the only write in the whole rival interface.** A mine dropped
  2 u behind the car calls `applyPenalty(id, 1.5)` and shifts that rival's entire
  future — every position, every claim — with nothing re-simulated. That is what
  makes "block your opponents" mean something. (Denominated in *rival* seconds,
  so ≈1.3 s of wall clock at this rite's `RIVAL_CLOCK` of 0.87.)
- **Score.** `0.45 × gates + 0.35 × gold + 0.20 × rivals beaten`, and the result
  card **itemises the blend** (`9/12 gates · 21 gold · 2nd of 4`) — a blended
  ratio with an unitemised card is an opaque score.

### `hunt` — Game Hunt · 20 s · 69 draws · rivals

A forest clearing at dusk. An animal steps out, freezes for a beat, and bolts.
Fourteen of them over the round.

- **"First to click wins", stated plainly.** There is no network (§15). Every
  animal instead carries a **pre-drawn deadline with a name on it**: land a valid
  hit at `t < claimAt` and it is yours, otherwise Kavi's name flashes over it and
  it is gone. Strictly `<`, so a tie is not a state this rite can be in. Both
  players in a room face the same three rivals with the same names and the same
  deadlines. It is not a duel; it is a duel's arithmetic, played by both people
  separately.
- **Controls.** Left, right and Space are one verb; it reads `input.clicks`.
  Unlimited ammo, but **0.45 s of recoil** after every shot and **a shot that
  hits nothing spooks the live animal** — it bolts immediately. That second brake
  is the anti-mash rule and it is better than an ammo cap here, because it
  punishes precisely the behaviour the rite is about resisting: panic-clicking at
  an animal you have not acquired.
- **The reaction window is derived, not typed.** It reads `claimTime(0)` once and
  maps it through a gain of 0.55 onto a window clamped to [0.34, 1.25] s. The
  compression is the point: `claimTime(0)` swings ~0.9 s across plausible rosters,
  which is wider than the band a reaction game can live in, and an unlucky roster
  at wave 53 would otherwise publish a deadline no human can reach.
- **Score.** `ratio = taken / 8` (60 % of the field). A denominator of 14 would
  put a good player at 0.7 and a great one at 0.95, compressing every human into
  the top third of the curve.

### `fishing` — Fishing · 20 s · 94 draws · rivals

A lake at dawn, seen side-on, four anglers on one water, sixteen fish. Same
competitive rule as `hunt`, same clock, **deliberately not the same game**.

- **The verb is the whole design.** `hunt` is a *reaction* shot; `fishing` is a
  *leading* shot. A click drops a hook at the pointer, it sinks for **0.35 s**,
  and it catches whatever it overlaps **at the moment it lands** — not on the way
  down. The fish never stop moving, so the question is not "where is it" but
  "where will it be". Without this split, two of the eleven rites in a run are one
  game with different sprites, which was the single largest design risk in the
  batch. **Nothing in that file may drift toward reaction, and nothing in `hunt`
  toward prediction.**
- The lead is made **visible**, because a lead you cannot see is a coin flip with
  extra steps: every fish trails a wake exactly as long as the distance it covers
  in one sink ("cast one wake ahead of the nose"), and the fish nearest the
  pointer shows a dashed ghost where it will be when the hook arrives.
- **The sink is a constant, not a function of depth.** Physically wrong, and
  right: a per-lane lead could never be *learned*, and the rite would reward
  arithmetic instead of reading the water. Depth is spent on legibility instead
  (deep fish are dimmer).
- **Controls.** Left, right and Space are one verb; **exactly one cast per step**
  however many clicks arrive, and the extras are not queued for later. Reeling is
  0.7 s after an empty cast against 0.3 s after a catch — the anti-mash rule,
  expressed in the fiction instead of in a counter.
- **Score.** `ratio = points / PAR`, `PAR = 0.55 × (15 + 3) = 9.9` — the golden
  fish is worth 3 and is confined to indices 4..11, because the index also sets
  the deadline and a golden fish at 0 is gone before the player has read the
  water.

---

## 14. The rivals — the other players, without a network

`src/minigames/rivals.js`. Pure: no DOM, no sockets, no clock. Four of the six
rites use it (`platforms`, `offroad`, `hunt`, `fishing`); `heaven` and
`luckyshot` do not, which is part of why `luckyshot` is the reference rite.

**The model in one sentence:** a rival is a **pure function of (t, skill, a
schedule drawn once at construction)**, plus a single mutable penalty accumulator
the player is allowed to push on.

```js
RivalSource {
  roster(),                      // [{ id, name, skill }] — the display list
  claimTimeFor(id, targetIndex), // THE SCHEDULE: when rival `id` reaches target i
  claimTime(targetIndex),        // its minimum — when the target is gone
  claimant(targetIndex),         // its argmin — WHO took it, or null
  positionAt(id, t),             // 0..1 of the course, a pure function of t
  applyPenalty(id, seconds),     // THE ONE WRITE
  outAt(id),                     // when this rival is eliminated, or Infinity
}
```

Everything falls out of that:

- Every competitive question in every rite reduces to **one comparison**: does
  the player's instant beat the rival's published function? `claimTime` answers
  it for a contested target, `positionAt` for a race, `outAt` for an elimination.
  Nothing to step, nothing to keep in sync.
- **The deadline and the name are two views of ONE schedule.** `claimTimeFor` is
  the primitive; `claimTime` is its min and `claimant` its argmin, so the name
  over a claimed animal is the rival who actually got there first and the two
  cannot drift. The interface shipped without `claimant`, and because the
  per-rival offsets were index-independent the same rival was arithmetically
  first to **all fourteen** animals of a `hunt` — so `hunt` rolled a name out of
  its presentation RNG and `fishing` rotated `i % 3`. Both were honest and both
  meant the name on screen had no relationship to the number beside it.
  `SeededRivals` now deals the field across a **fixed arrival ladder** per target
  — a seeded, skill-weighted permutation, hashed from `(seed, target, k)` rather
  than drawn, so it costs no `rand()`. A permutation cannot move a minimum, so
  **`claimTime` is bit-for-bit what it always was**: consecutive targets stay
  exactly `CLAIM_SPACING` apart, which is the spacing `hunt` sizes its contest
  window against.
- **Zero allocation and zero randomness per frame.** The constructor consumes
  exactly `count * PER_RIVAL` (4) values — name, skill, reaction jitter, pace
  jitter — and nothing at runtime. `wave` moves the difficulty (`pressure` runs
  0.42 → 0.78, saturating, because a roster uniformly better than any human is a
  "you lose" screen with extra steps) and never the number of draws.
- Uniqueness of names comes from a **partial Fisher-Yates over an index list**,
  which is exactly one draw per rival however the numbers land. A retry loop
  ("draw again if we already used that name") is variable-length and is the
  classic way to desync a room. `NAMES`' order is part of the seed contract for
  the same reason `MINIGAME_IDS`' is: append, never shuffle.
- The tuning constants (`CLAIM_BASE`, `COURSE_SECONDS`, …) are **shared on
  purpose** — that shared rhythm is most of why the six rites feel like one game.
  A rite that wants a different rhythm scales the **result** (`offroad`'s
  `RIVAL_CLOCK`), and must not reach in and change a constant for everybody.

### What this honestly is not

A ghost **never bluffs**, never camps a spot because you are near it, never
changes plan because you took the lead or because you showed up at all. The one
exception is `offroad`'s bomb — the single write in the interface — and it is
deterministic: seconds added to that rival's entire future.

Beating "Kavi" is beating a number. **"The first one who clicks wins" has become
"beat a deadline that has a name on it."** That is a real loss and it is worth
naming rather than dressing up.

What survives is the property that makes the feature worth having: **every player
in a room faces the same rivals, with the same names and the same deadlines,
because the seed is shared.** Whatever the rite says about you, it says the same
thing to the person next to you — which is what makes two players' scores
comparable afterwards. It flavours a solo score; it does not rank two people in
real time.

---

## 15. Why there is no real-time shared arena

Stated once and properly, so nobody rediscovers it the hard way.

**The transport could not carry a duel today.** The server is a **pure relay**:
score broadcast at ~2 Hz, **no clock synchronisation, no authority, no
reconnection** (`server/index.js`, `docs/MULTIPLAYER.md`). "First to click" over
that resolves on **ping, not reflex**, and the loser is always whoever has the
worse connection. `docs/MULTIPLAYER.md:26` already puts shared boards out of
scope: adding them "means adding real state sync, not extending this".

**But the wire format is not the blocker — the rendezvous is.** Rites fire on
**each player's own wave progression**. Two players never enter the same rite at
the same wall-clock time, because they clear wave 13 at different moments, and
**no rendezvous barrier exists anywhere in this codebase**. Adding a message
channel would not fix that. Adding a barrier would mean stalling whoever cleared
their wave first — parking a player who is playing well in front of a "waiting
for…" spinner, which is precisely the interruption the whole rite cadence was
designed to avoid (§6: a mandatory interruption every five waves is a toll booth
by its eighth occurrence).

So the honest summary is: a shared arena is not one message away. It is a
synchronisation model this game has deliberately never had.

**The seam for later is already in place.** Every rite talks only to the
`RivalSource` interface. A future `NetworkRivals` implements those **seven
methods** and **not one line of any rite changes** — which is the right shape for
a decision to be arbitrated later, on something concrete, rather than guessed at
now.
