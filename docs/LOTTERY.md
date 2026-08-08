# The Rite of Fortune — the wager

An optional gold wager placed during a prep phase, resolved by a single seeded
draw against a fixed six-outcome table. It is a **design original**: neither
Element TD 2 nor Ryoko TD has a lottery, so every number below is derived from
*this* game's economy and nothing is copied.

This document is the contract. Treat any disagreement between it and the code as
a bug in one of them.

| Path | What it is |
|---|---|
| `src/game/lottery.js` | The table, the stake ladder, the payout maths, the block predicate. **Pure.** |
| `src/ui/Lottery.js` | The rail seal, the draw overlay, the ring, the single gold credit. |
| `src/ui/lottery.css` | Both surfaces' styling. Tokens only. |
| `tests/unit/lottery.test.js` | Rules, economics, determinism. `node` env. |
| `tests/unit/lottery-host.test.js` | Transaction, one credit, leaks, shield. `jsdom` env. |
| `tests/e2e/lottery.spec.js` | Rail geometry, real capture order, real pixels. |

---

## 1. The shape, in one table

| | |
|---|---|
| **When** | Phase `prep` only, from wave 3. **One wager per prep**, so at most 53 in a run. |
| **How much** | A **pure function of the wave** — never a percentage of gold. Ladder 25 → 800. |
| **The draw** | One `rand()` call, one table, six outcomes, no sub-roll and no reroll. |
| **EV** | **0.8865x** excluding the pot. Ceiling including it: **0.9865x**. |
| **The floor** | **0.25x, never 0.** You never walk away empty-handed. |
| **Pot** | Personal. Fed 10 % of every stake, paid in full on Convergence (2.5 %). |
| **Non-gold rewards** | **None.** Three candidates, three refusals — §6. |
| **Determinism** | `rngFor(seed, 'lottery', wave)` — index is the **wave number**. |
| **Entry point** | Rail seal under `#threat`, hotkey `L`. Dev: `game.lottery.devOpen(wave)`. |

---

## 2. The invariant

```
evBase() + POT_FEED  <  1
```

**This is the whole safety argument, and it is a unit test.** If it stops
holding, "wager every prep" becomes the dominant line, the tower economy is
decided by who clicked the most, and the run stops being a tower defence. The
pot cannot rescue a broken table: every coin it pays out was fed to it by a
stake, so `evBase() + POT_FEED` is the ceiling of the *entire system* including a
player who claims 100 % of the pots they personally fund. It is **0.9865**.

`tests/unit/lottery.test.js` asserts it, and — per `docs/PITFALLS.md` rule 4 —
also asserts that the same expression **fails** on two other tables: the design's
rejected first iteration (ceiling 1.25) and a variant where the 0.25x floor is
lifted to 1.0x. An invariant nobody has watched go red is a comment.

> One consequence worth knowing: `potContribution` uses `Math.floor`, not
> `Math.round`. With rounding, the 25 and 75 rungs fed 3 and 8 instead of 2.5 and
> 7.5, the realised feed across the window came out at 10.06 %, and the measured
> ceiling landed at 0.98706 — above the 0.9865 this document publishes. Still
> under 1, so nothing was broken, but a published ceiling the code can exceed is
> a published ceiling nobody should trust. **The test found this, not review.**

---

## 3. The payout table

| Outcome | Glyph | Probability | Payout | EV contribution |
|---|:--:|---:|---|---:|
| **Ash** | ● | 46.0 % | 0.25 x M | 0.1150 |
| **Shard** | ◆ | 28.0 % | 0.80 x M | 0.2240 |
| **Vein** | ◈ | 15.5 % | 1.5 x M | 0.2325 |
| **Lode** | ✦ | 7.5 % | 3 x M | 0.2250 |
| **Geyser** | ✷ | 0.5 % | 8 x M | 0.0400 |
| **Convergence** | ⬢ | 2.5 % | 2 x M **+ the whole pot** | 0.0500 |
| | | **100 %** | | **0.8865** |

Standard deviation per stake: **0.930x**. Draws that hand back at least the
stake: **26.0 %**.

Three decisions carry this table:

**The floor is 0.25x, never 0.** A zero outcome makes 46 % of draws *empty*, and
an empty draw on an 800-gold stake is humiliating rather than dramatic. The
result screen needs a number to land on.

**26 % feels like "about one in four", and is the maximum reachable at this EV.**
Every extra point of win rate has to be paid for by flattening the right tail.

**One `rand()`, one table.** No sub-roll, no reroll, no second wheel. That is what
makes the determinism contract checkable in one line, and it is also what makes
the animation legible: one needle, one stop.

**`LOTTERY_OUTCOMES` order is part of the seed contract.** The draw walks it
cumulatively and the ring is that same walk drawn as arc lengths, so reordering
or inserting changes what every existing seed pays.

---

## 4. The stake

```js
rawStake(n) = the ladder rung nearest 0.20 * (waveDef(n).count * waveDef(n).bounty)
stakeFor(n) = max(rawStake(1..n))        // monotone by construction
```

| Waves | Stake | Wave gross | Stake / gross |
|---|---:|---:|---:|
| 3 – 11 | 25 | 80 → 180 | 31 % → 14 % |
| 12 – 17 | 50 | 192 → 280 | 26 % → 18 % |
| 18 – 22 | 75 | 315 → 416 | 24 % → 18 % |
| 23 – 27 | 100 | 459 → 612 | 22 % → 16 % |
| 28 – 31 | 150 | 665 → 820 | 23 % → 18 % |
| 32 – 36 | 200 | 903 → 1 166 | 22 % → 17 % |
| 37 – 41 | 300 | 1 288 → 1 632 | 23 % → 18 % |
| 42 – 46 | 400 | 1 800 → 2 288 | 22 % → 17 % |
| 47 – 52 | 600 | 2 511 → 3 451 | 24 % → 17 % |
| 53 – 55 | 800 | 3 654 → 4 170 | 22 % → 19 % |

**Why a function of the wave and not of gold.** A percentage of the player's gold
asks the identical question every time — "do I risk 10 % again?" — which is a
question you answer once and then automate. It also reads `state.gold`, so two
players in one room would stake different amounts on the same wave and the shared
draw would stop meaning anything. Indexed on the wave, the same button asks a
different question each time, because what changed is the player's *situation*.

**Why the running maximum.** `rawStake` alone goes **down** on boss waves, because
a boss is a single unit: wave 19 grosses 330 and asks 75, wave 20 grosses 236 and
would ask 50. A stake that drops reads as a discount when it is only a dip in a
schedule the player cannot see.

**No slider.** A slider turns "do I play?" into "how much?", whose answer on a
−EV game is always *zero*. A slider on a −EV wager offers the informed player
only the freedom to lose more.

---

## 5. The reserve rule, and its honest status

The seal is dark when `stake * RESERVE_MULT > gold` — you can never wager more
than half your bank.

**This rule is proven inert, and it must not be presented as the protection.**
Gold in hand at the start of prep `n` is at least the gross of wave `n−1` — it
was just collected and cannot have been spent before it existed. Against that
floor the gold/stake ratio never falls below **2.88x** across all 55 waves (worst
case: wave 2), and 20 000 simulated runs across four spending policies blocked
**zero** wagers. `tests/unit/lottery.test.js` re-derives the 2.88x from
`waveDef` rather than quoting it.

**The real protection is the stake formula**: the stake is ~20 % of a wave's
gross, and the player collects that gross before every prep, so the ratio is
structurally ~5x and cannot collapse.

The rule stays because it costs one line, because it is assertable, and because
it will catch a future edit to the ladder. It bites in exactly one case, and it
is the right one: past ~31 % of a wave leaked, i.e. for a player who is already
losing the run. At that point the wager closes itself.

---

## 6. The pot, and what the wager does not pay

The pot is **personal**, necessarily: gold in this game is strictly per-player
and strictly client-side (the server simulates nothing and `status` does not
carry gold), so a room-wide pot would need an authority that does not exist.

It barely moves the expectation; it moves the *shape*. It shifts mass from the
median into the right tail, and — the reason it exists — it is **the only number
in the system that moves while you are not playing it**, which is what creates
anticipation between two draws. On a losing draw the result card's last line is
`Pot 480 → 495`: the stake made something grow.

Convergence was deliberately made **twice as frequent and half as generous**
(1.2 % @ 4x → 2.5 % @ 2x) after simulation showed the rarer version recycling
only 14 % of what it absorbed and never firing at all for half of all players. An
anticipation mechanic most players never see resolve is a dead mechanic. At
2.5 %, **~75 % of players who wager every prep break the pot at least once**.

The unclaimed residue is a real part of the house edge, and it is honest because
the counter is on screen the whole time.

### Non-gold rewards: three candidates, three refusals

**An element stack — REFUSED.** `rollElementChoices()` is documented as a pure
function of `(seed, pickIndex, the MULTISET of state.picks)`. A stack won at the
lottery mutates that multiset. Determinism would survive — a player who diverged
has diverged — but the *product promise* would not: today the only source of
divergence between two players in a room is a **choice**. A lottery stack lets
chance into the picker through the back door, which is precisely what three
docblocks in `Game.js` exist to prevent.

**A life — REFUSED.** `maxLives: 50` exists because an uncapped life counter is a
second unbounded currency and leaks stop meaning anything. Worse, a leak in this
game disables interest for the rest of the wave — that is the real economic
lever. A life bought at random refunds a strategic error.

**A discount on the next purchase — DEFERRED, not rejected.** The only defensible
one: disguised gold, capped, non-hoardable, nowhere near the picker or the lives.
But its value depends on what the player buys next, so it turns an exact EV into
an EV conditional on purchasing behaviour. Shipping a wager whose EV cannot be
published contradicts the rule this whole design is built on. Reopen it when
there is a *measured* purchase model rather than a postulated one.

**So the wager pays gold and nothing else.** That is a constraint, and it is also
what makes it inspectable in one line.

---

## 7. Determinism

```js
const u = rngFor(this.game.seed, 'lottery', wave)();   // exactly one call
const outcome = resolveLottery(u);                     // pure, takes a NUMBER
```

Both halves of `src/core/Rng.js`'s contract:

1. **A constant number of calls** — exactly one, never inside a branch that
   depends on player state. `resolveLottery` takes a `number`, not a generator,
   so it is *structurally incapable* of consuming a second value.
2. **A pure function of `(seed, 'lottery', wave)`** — no gold, no picks, no
   towers, no clock. `Math.random()` appears nowhere, including in the sparks,
   which are seeded from `u` itself.

### `drawIndex` is the wave number. Why, plainly.

Wave 12's draw is wave 12's draw for the whole room, whether or not you wagered.

> **What that guarantees, and nothing more:** at wave N everyone in the room
> faces the same draw. If you and your opponent both wager, you get the same
> multiplier. The only thing that separates you is having wagered, and on which
> waves.

The corollary is true and worth stating: someone who wagers every prep realises
the true EV (−11 %); someone who wagers rarely gets a *sample* of it, with much
more variance around it.

**The alternative — indexing on a personal wager counter — is defensible and is
rejected for one precise reason.** It would guarantee something stronger-sounding
(equal wager counts ⇒ identical multiplier sequences, nobody luckier than
anybody) at the price of making luck **movable**: the stream is computable
client-side, so a player would advance their counter on cheap waves to land the
big multiplier on an expensive one. With a global index, **the outcome and the
price are welded together** — the Geyser on wave 43 is worth wave 43's price and
nothing can move it. It also makes skipping genuinely free: skipping wave 12
skips a draw rather than banking one, so there is never a reason to wager "to
advance".

### On cheating, honestly

The seed is client-side and `rngFor` is pure, so anyone with a console can
precompute all 53 draws and wager only on the good ones. **This is not a
regression introduced by this feature**: gold in this game is already
client-authoritative, so `__game.state.gold = 999999` is strictly simpler and
more effective. The lottery is exactly as cheatable as gold itself, for the same
reason. No fix preserves the fairness promise — any term added to `rngFor` must
be identical for the whole room for the promise to hold, and therefore computable
by everyone. Stated, not papered over.

---

## 8. The surfaces

### The seal — left rail, under `#threat`

**Not in the top bar.** `HUD.js` already carries 5 stats and 6 controls there and
`--topbar-h` leaves no margin. The seal is a cadet card on the same rail: same
242 px, same `--r-l`, same `--shadow-1`, positioned by measuring `#threat`'s
height through a `ResizeObserver` (its run-ahead changes size, so a hard-coded
offset would overlap it on half the waves) and following it off the rail under
`body.codex-open`.

The **pot** lives permanently in the header — it is the only figure that must be
visible without interaction. The **payout table** is a `<details>`, folded,
opened in the rail and never as a modal.

The card is height-capped against the dock (`--lot-top`, published by
`#placeRail`), so on a 900 px viewport under the tallest `#threat` the open fold
does not quite fit. **The −EV disclosure is therefore printed above the rows, not
below them.** `ui.css` says it plainly about the key sheet: the last line of a
scrolled panel is a line nobody reads. The line that says the lot gives back less
than it takes must not be that line; the payout rows can be, because they are
also drawn around the ring — at arc length — on every single draw.

| State | Rendering |
|---|---|
| available | `--gold-dim` fill, `--line-2` border, `--gold-hi` text |
| hover | `--line-3`, `translateY(-1px)`, `--t-fast` |
| already wagered | label "Spent", `--ink-3`, opacity 0.55 |
| reserve too thin | note in `--warn`, tooltip naming the figure |
| outside `prep` | the whole card slides off the rail, same transition as `#threat` |

### The draw — 3.6 s

Full-bleed veil, `role="dialog" aria-modal="true"`, **keyboard shield at capture
on `document`**, DOM plus one 2D canvas. Nothing is added to the three.js
pipeline: no light, no pass, no full-bleed transparent surface.

The figure is a **ring of six arcs whose lengths are exactly proportional to
their probabilities**. The player sees the table: Ash is nearly half the circle,
Geyser is a scratch. The rarer the outcome, the more golden the arc — a player
learns the odds by watching, without reading a number.

**The needle comes to rest at the angle `u` names.** The ring is the cumulative
walk and `resolveLottery` is the cumulative walk, so the picture *is* the
algorithm rather than a dramatisation of it. Peak speed is solved so total travel
lands exactly on `TURNS + u`; the needle is launched at the answer, not steered
toward it.

| t | What happens |
|---|---|
| 0.00 | Veil fades in. The stake has **already** left the gold counter. |
| 0.20 | The arcs draw themselves in. |
| 0.50 → 2.00 | Acceleration, ~7 turns, illegible on purpose. A tick at every arc boundary. |
| 2.00 → 3.40 | Long deceleration. Convergence sits immediately before twelve o'clock, so it is the **last arc crossed** before the needle rests — a near-miss that is geometry, not theatre. |
| 3.40 → 3.62 | Overshoot and settle, **clamped to the winning arc's remaining span** so the flourish can never park the needle over the wrong outcome, even for one frame. |
| 3.62 | Result. |

**Losing is graceful, never humiliating.** The multiplier renders in `--ink-2`,
**never `--danger`** — this game's error colour stays reserved for a leak. The
label is `gold returned`, and the amount returned is the number in the largest
type. Underneath, the pot line. No low sound, no shake, no failure animation.

**No camera shake anywhere**, against the design spec's 0.15 amplitude: the board
is behind a heavy veil for the whole draw, so `rig.addShake` spends real shake
budget on something nobody can see. Same call `MinigameHost` made. The ring gets
the impact instead — glow and sparks, density proportional to the multiplier.

### Five things only a screenshot found

None of these were caught by a test, and each is commented at the site.

1. **The result card was painted over the spinning ring for the whole draw.**
   `.ld-result { display: grid }` beats the UA stylesheet's
   `[hidden] { display: none }` — a specificity fight a class always wins. Fixed
   with an explicit `.ld-result[hidden]`.
2. **The needle had a hub dot at the origin**, which sat exactly on the centre
   readout: "15" looked like a 1 and a 5 printed on top of each other. The needle
   never travels inward past the ring, so the hub decorated an axle that does not
   exist. Removed.
3. **The centre number was drawn on the canvas.** `Painter.text` at a 0.7-world
   size hands the canvas a `0.72px` font and the metrics quantise. It is DOM now,
   with `--font-num` and real tabular figures — the same call `MinigameHost`
   made for its clock.
4. **The ring and the result card collided.** The card is bottom-anchored inside
   the stage on purpose, so the whole figure now lifts 0.85 world units over
   320 ms on reveal and the arc labels fade out.
5. **The winning arc is marked by WIDTH, not brightness.** The rarity gradient
   makes Ash the darkest arc, so "light up the winner in its own colour" left the
   46 % outcome as the least visible thing on screen at the exact moment it had
   to be identified. A stroke 1.5–1.9x thicker is hue-independent. The halo is
   win-only: a losing arc lit up like a beacon celebrates the player's loss,
   which is the tone this feature exists to avoid.

---

## 9. What the code guarantees

- **The result is decided and stored before the animation starts.** `#wager()`
  spends the stake, consumes one `rand()`, resolves the table and writes
  `_draw`. The 3.6 s that follow interpolate toward a number that already exists,
  so Escape, a veil click, a tab blur and a browser stall all resolve to the same
  outcome instantly. *An animation that decides a result is a design bug*: it
  makes every escape hatch a fairness question.
- **One gold credit, ever.** `#settle` is guarded by `_credited`, and `close()`
  calls it defensively — **there is no exit from this overlay that does not
  pay**. A stake taken with no payout is the worst bug available here.
- **No leaked listeners.** Everything goes through `#hold`; `listenerCount` is 0
  whenever the overlay is shut, measured from the platform in a unit test.
- **The phase freezes.** `state.phase = 'lottery'` is in `FROZEN_PHASES`, so the
  prep clock cannot send the wave from behind the veil during the draw, and the
  interest clock cannot pay for staring at a result card. Restored on close.
- **1x speed.** Driven from the variable-rate half of `Game.frame`, so
  `state.speed` never reaches it. A frame is clamped to 100 ms.
- **A blur resolves; it does not suspend.** Unlike a rite, there is no skill to
  protect — suspending would leave a paid-for result behind a hidden tab with the
  game phase frozen.
- **A hard stop.** If anything ever holds the overlay past 30 s it pays and
  closes: a frozen phase plus a stuck overlay is an unplayable run.

## What it does not do

- **No networking.** No message crosses the wire. Fairness is the seed.
- **No pause.** `P` is swallowed; the draw is 3.6 s.
- **No skip.** You cannot skip a transaction you have already paid for. Escape
  reveals; it does not refund and it does not cancel.
- **No "instant draw" setting.** The design spec asked for one in `Settings.js`;
  it is not built. Escape and a veil click already collapse the draw to zero, and
  a fourth way to skip an animation nobody is forced to watch twice was not worth
  a shared-file edit. **Reopen if playtesting says otherwise.**

---

## 10. Running one from the dev panel

`F9` → the **Loterie** row → **Ouvrir**, with the wave from the **Vague** field.
It calls `game.lottery.devOpen(wave)`, which bypasses the phase, the wave floor
and the one-per-prep rule — the point of a dev hook is to reach a state the
schedule makes you play twenty minutes for. It does **not** bypass the gold: a
wager paid out of an empty bank would be a lie about the one thing this feature
moves, and the panel has a Gold button two rows up.

---

## 11. The objection: a lottery in a serious strategy TD

**It was commissioned. That is the first reason and it should be said.** Absent
the request, a pure draw is not what this game wants: morph is taxed, the
picker's fairness has a fifty-line docblock, and combat RNG is one global 18 %
crit. Chance here is bounded and documented everywhere.

**The framing that makes it defensible is real, though.** This game already pays
for risk taken against gold: the send-early bonus is **2 gold per second of prep
abandoned** — literally a bet on your own board — and the interest cap punishes
idle gold. "Risk for gold" is already in the vocabulary. The wager is its purest
form, and it is calibrated to stay the **least** important: 1.75 % of the economy
at worst, against several hundred gold for one aggressive send-early.

**What makes it acceptable is that it is expensive and rare.** One wager per prep,
53 at most, EV published in the fold, and a panel that never asks for anything.
It is not an engagement system; it is an object in the world you can ignore for a
whole run.

### The variant that is arguably better — the Augur's Wager

Not built. Recorded here because it is the honest comparison.

Instead of drawing, the player **bets on the wave they are about to send** and
the combat resolves it: *Rampart* (zero leaks), *Celerity* (cleared under 0.7x
nominal spawn time), *Bound Hands* (build nothing during combat), *Composure*
(Rampart and Bound Hands together).

It is better on four counts: **zero `rand()`** — the whole determinism section
disappears, along with the precompute exploit; it is an **informed decision**
rather than a draw, which is this game's actual register; its **EV is
self-regulating through skill**, which no table can be; and it gives the player a
reason to *watch the wave* instead of the ring.

What it loses is real: the staging. No ring, no compressed suspense, no pot
climbing. The suspense lasts twenty seconds and is called "the wave".

**It is not calibrated, and it cannot be from a desk.** The success rate of each
contract is not a parameter, it is a *measured rate*: you have to instrument
leaks per wave, clear time versus nominal, and actions during combat over a
sample of real runs, then set the payouts to hit the same 0.89 EV. Any number
written today would be an invention. See the report accompanying this feature for
a cost estimate.
