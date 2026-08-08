# Pitfalls found the hard way

Every entry here cost at least one full agent round and was invisible to code
review. They are recorded because each is a *class* of bug, not a one-off, and
several were found only because someone rendered the thing and looked at it.

---

## 1. Canvas-backed textures are PREMULTIPLIED

`ctx.putImageData()` into a 2D canvas, then `new THREE.CanvasTexture(canvas)`,
multiplies RGB by alpha — irrecoverably where alpha is 0.

This is fatal if alpha carries **data** rather than opacity. The terrain's packed
maps used alpha for an engraving mask, ambient occlusion and dampness:

| Map | Alpha held | What actually shipped |
|---|---|---|
| flagstone albedo | engraving mask | RGB survived only along the engraving |
| road + decay albedo | `0` | RGB entirely black |
| normal / rough / AO | AO | normal.xy and roughness scaled by AO |
| macro variation | dampness | RGB scaled by dampness |

**The arena floor had effectively no albedo for three rounds.** Two separate
rounds of albedo art moved nothing, because nothing was being sampled.

*Diagnosis that worked:* force `uAlbedoGain = 0`. The board moved only
L=101.7 → 89.9. Then kill every light but the key: no change. If removing the
albedo doesn't change the image, the albedo was never there.

**Rule:** if alpha is data, write raw bytes into a `DataTexture`. Never a canvas.
Canvas is only safe when alpha is 255 everywhere, or when the shader samples
`.a` alone (our glow/smoke sprites do, which is why they were unaffected).

---

## 2. A ground decal wound in XZ faces −Y and is back-face culled

```js
// face normal points at -Y; invisible from an overhead camera
(-r,-r) → (r,-r) → (r,r)
```

The per-tower coloured ground glow was **never drawn**, from the day it was
written. Two rounds of `glowIntensity` tuning were performed against an
invisible object, and a blind reviewer independently reported "nothing casts
coloured light; the floor beneath them is uniformly grey".

*Diagnosis that worked:* force `depthTest:false` + `NormalBlending` +
`renderOrder 9999`. Still invisible ⇒ not a depth problem, not a blend problem,
therefore culling. Fix: `side: THREE.DoubleSide`.

**Rule:** when something is invisible, first prove *which* stage is dropping it.
Disable depth, disable blending, force render order. What survives tells you
where to look.

---

## 3. GTAO's prepass ignores transparency

`GTAOPass` builds its depth/normal G-buffer by re-rendering the scene with an
**override material**, which ignores `transparent`, `depthWrite:false` and
blending mode. A large translucent mesh spanning the board therefore lands in
the G-buffer as solid geometry and paints a hard dark wedge over everything
behind it.

Cost us a very visible diagonal band across the arena. Also, without a clip box
GTAO evaluates the sky dome as back-facing shells reporting full occlusion and
crushes it to black (`rgb(47,78,107)` → `rgb(0,0,3)`).

**Convention adopted (userData, deliberately NOT layers):** objects are excluded
from the AO G-buffer automatically when `transparent`, non-Normal blending,
`depthWrite:false`, or Points/Line/Sprite. Force-exclude an opaque object with
`userData.noAO = true`; force-include a translucent one with
`userData.aoOccluder = true`.

Layers were rejected because `object.layers.set()` *also* removes an object from
raycasting and from every shadow camera — a silent, far-reaching side effect.

---

## 4. Screen-space god rays cannot anchor to this key light

Not a tuning miss, a geometric impossibility. The camera pitches ~52° down, so
the sun would have to sit **below −7.5° elevation** to appear in frame — i.e.
underneath the horizon, lighting the board from below. Measured live, the key
projected to uv `(36.8, 114.85)`: 36 screen-widths right, 114 frame-heights up.
The pass was enabled and firing zero pixels.

Anchored instead to `environment.godRayAnchor` — a genuine in-frame emitter.

Two separate bugs in the pass itself, both invisible while it was disabled:
- `clamp(uv, 0, 1)` re-reads the border texel on every remaining march step,
  smearing the frame edge into hard repeating streaks. Use a validity mask so
  off-screen samples contribute nothing.
- `Vector3.project()` divides by w, so a light *behind* the camera returns
  mirrored x/y and the shafts radiate from a plausible-looking but wrong origin.
  Reject via a forward-vector dot product first.

**Rule:** a feature that has never been switched on has never been tested.

---

## 5. Correct changes can compose into a regression

Towers cut idle emissive 3.7× to give muzzle flashes dynamic range — correct.
Terrain fixed the premultiply bug and environment moved the key light into the
visible window — both correct, and together they made the floor far brighter.

Net effect: towers became dark objects on a bright floor at the exact moment
they lost their glow. A blind reviewer read them as "twenty identical dark cones
with beads on top", even though the flat-black silhouette test still passed in
isolation.

**Rule:** with parallel agents owning disjoint files but sharing one image, no
agent can see the composition. Someone must judge the integrated frame after
every round, and per-domain tests passing is not evidence that the frame works.

---

## 6. Geometry bugs that read as art problems

Found only by looking at renders, never by reading code:

- `shard()` had **inverted tapers**, so every "crystal" was an hourglass — which
  photographs as a flat bowtie.
- The upgrade halo's torus was built in the **XY plane while its teeth were laid
  out in XZ**; the teeth never touched the band they belonged to.
- A rune shader drew a hard ring + 12 discrete ticks + a 3-lobed spoke term. Up
  close it composited into a ceiling fan; at range the spokes **aliased into an
  asterisk**. One bug, two symptoms, initially filed as two separate problems
  against two different agents.
- Emissive surfaces painted their element colour *and* emitting it, doubling
  into flat fluorescent card.
- `smoothstep(edge0 > edge1)` — undefined behaviour in GLSL, silent.
- `Arena.surfaceHeightAt()` called `clamp01`/`smoothstep`, **neither defined**;
  it threw on every call.

**Rule:** anything with angular symmetry (ticks, spokes, radial cracks) will
alias into a pinwheel at gameplay distance. Prefer continuous fields, and give
small decals a distance LOD that dissolves them to a soft point before they can
alias into geometry that was never there.

---

## 7. Gameplay bugs hide in plausible-looking code

`if (s.poison) c.applyBurn(idx, s.poison.dps, s.poison.dur);`

Poison and Disease towers set creeps **on fire** and never applied poison.
`poisonT` stayed 0 while `burnT` was double-applied. It survived review because
the line reads correctly at a glance.

Caught by tracing damage end-to-end numerically instead of inspecting:
splash 1000/808/616/424 across measured spacing, chain 1000→600→360→216,
execute 3400 at 20% HP = exactly `1 + 0.8×0.5×6`.

**Rule:** assert the numbers, don't read the code.

---

## 8. A feature nobody calls is a feature that does not exist

`Arena.markPathDirty()` existed. `Arena.update()` honoured it correctly. A grep
of the entire tree found **zero callers.**

So every zone mask ever shipped was the one computed in the `Arena`
constructor — before a single tower existed — a straight line down an empty
board. The moment a player built a maze, the painted road and the route the
creeps actually walk had nothing to do with each other. Three rounds of critics
failed us on G8 (maze legibility) and three rounds of agents responded by
making the road material *prettier*.

**G8 was never an art problem.** No amount of material contrast can help when
the road is painted in the wrong place.

Caught by `uDebug=1` at midgame: the green road channel was absent board-wide.

**Rule:** for any "apply this change" method, grep for its call sites before
trusting that the pipeline runs. Then remove the need to remember — `PathMask`
now FNV-hashes `grid.cells` and re-solves on change, so it cannot be defeated
by a subsystem that doesn't know terrain exists. The explicit calls in
`Game.buildTower`/`sellTower` are the fast path, not the mechanism.

Related, same class: `tools/tower-sheet.mjs --silhouette` set
`scene.background = null`, which renders **black**, and drew **black** towers
on it. It had never once produced a usable silhouette — and it existed
specifically to validate G3, the gate we kept failing.

## 9. One NaN fragment blanks the whole frame, with zero JS errors

`pow(vH, 0.8)` on a varying that goes very slightly negative under perspective
interpolation → `NaN` → a single fragment enters the bloom pyramid → the
downsample chain spreads it across every mip → **the entire 3D frame renders
black.**

No exception. No shader compile error. `tools/shot.mjs` reports `errors: []`.

The trap is attribution: two captures came back black during a round where four
agents were writing concurrently, and they looked exactly like somebody else's
breakage. Found by bisection on the instance count — `count=1` fine,
`count=282` black. Fixed with a `clamp`.

**Rule:** clamp anything feeding `pow`, `sqrt`, `log` or a divide in a shader,
especially varyings — interpolation does not respect the range your vertex
shader wrote. And when the frame goes black during a parallel round, bisect
your own work before blaming a neighbour.

**Corollary:** a shader that fails to compile does not render *and does not
throw*. It surfaces as a console error, so a capture can come back "clean"
while an entire subsystem is missing. Check the errors array explicitly, and
check that the triangle count moved the way you expected.

---

## §10 If the ablation only tests world objects, a post pass is invisible to it

A row of element-coloured blobs sat on the surround, outside the board, in every
capture for **four rounds**. It was attributed in turn to:

1. the ground fog (round 2)
2. the creeps (round 3, and again by the environment agent in round 4)
3. the tower ground-glow pools (my own round-4 arbitration)
4. the batched tower geometry itself (terrain agent, round 4b)

Every one of those was wrong, and every one was reached by a *methodologically
sound* ablation. The reason they converged on the towers is that the towers were
genuinely load-bearing: hiding `towers.group` did make the blobs disappear. What
nobody tested was the thing standing between the towers and the framebuffer.

It was `GodRaysPass`. Ablating post passes instead of scene objects:

| ablation | off-board chroma |
|---|---|
| baseline | 6729 |
| without bloom | 5191 |
| without grade | 5881 |
| **without godrays** | **1173 (−83%)** |
| towers hidden (the "answer" from four rounds) | 2624 (−61%) |

**Turning off the post pass removed more of the artifact than deleting every
tower in the scene.** The towers were the source; the pass was the brush.

Two compounding causes, both worth naming separately:

**(a) The docblock and the config disagreed, and everyone believed the
docblock.** `GodRaysPass.js` opened with "DISABLED BY DEFAULT
(`QUALITY_PRESETS.*.godrays === false`)". `Config.js` said `godrays: true` for
`ultra` and `high`. We capture at `?q=ultra`. Four agents read the docblock,
concluded the pass was off, and never put it in an ablation list. A comment that
asserts a value in another file is a comment that will eventually lie.

**(b) The pass is structurally wrong, not mistuned.** A screen-space radial
god-ray pass is only valid if its source buffer contains the light and nothing
else. This one brightpasses `tDiffuse` — the whole composite — so the brightest
pixels in frame (tower emissives, by a wide margin) became ray sources and were
raked outward along the breach vector. No value of `uThreshold`, `uWeight` or
`uExposure` fixes that; they only make the wrong thing fainter. The real fix is
an occlusion-masked source buffer. That distinction — *mistuned* vs *structurally
incapable* — is the one worth learning, because three rounds of agents tried to
tune their way out of an artifact that no uniform could reach.

**Rules:**
- Your ablation list must include the post stack, not just the scene graph.
  `pipeline.passes` is enumerable; iterate it.
- When an ablation implicates an object, check what *processes* that object
  before you conclude the object is at fault. "Hiding X removes the artifact"
  proves X is the source, **not** that X is the bug.
- A config flag is the truth; a comment describing a config flag is a rumour.
  Assert it in code or don't write it down.
- While you are in there, check the flags actually do something. `motionBlur`
  was `true` in `ultra` for four rounds with **no pass implementing it anywhere
  in the pipeline** — another entry for the tally in §8.

---

## §11 A constant `customProgramCacheKey` makes shader ablation silently impossible

Yesterday I "fixed" `tools/tower-sheet.mjs --silhouette`, which had drawn black
towers on a black background since the day it was written and had therefore
never once produced a usable image (§8). The fix was real: white background,
drawables hidden.

It was still lying.

The silhouette mode also cleared `onBeforeCompile` and `vertexColors` to strip
the tower shading. But `TowerMaterial` overrides `customProgramCacheKey()` to
return a **constant** string. That key is what three.js hashes to decide whether
it can reuse an already-compiled program. Constant key ⇒ same key before and
after the material was stripped ⇒ **three.js handed back the cached program and
every shader injection survived.** The "silhouette" sheet was the full lit tower
shader rendered in dark brown.

So the instrument built to validate the gate we kept failing was wrong twice, in
two independent ways, and the second failure looked plausible enough to pass
review — dark shapes on white *read* like silhouettes.

The consequence, measured once the tool actually worked: the six element
families were the same mass. Same height within 15%, all bottom-heavy, all
widest at the ground, no negative space in any of them. Three blind critics had
independently reported exactly this ("eight variations on the same tapered
chess-pawn"), and four rounds of agents had been unable to see it, because the
one tool that would have shown it was broken.

**Rules:**
- `customProgramCacheKey()` must vary with **every** property that changes the
  generated program. A constant return value is a correctness bug, not an
  optimisation — it silently defeats any attempt to swap a material's shading
  at runtime, which is what most visual ablation does.
- When an instrument's output looks plausible, that is not evidence it works.
  Prove it can produce the *wrong* answer: force the state it is supposed to
  detect and confirm the output changes. (This is the same control that settled
  §10 — widening the god-ray disc to bring the artifact *back* is what proved
  the guard was doing the suppressing rather than the pass being dead.)
- Two further traps from the same round, both of which produce a capture that
  reports `errors: []` and is completely wrong:
  - **HMR reloads mid-capture.** During a parallel round another agent's edit
    triggers Vite HMR while a capture is in flight; the tool screenshots the
    title screen while reporting stats gathered before the reload. Stub
    `@vite/client` in every capture harness.
  - **A neighbour's parse error takes the whole app down.** Any tool that boots
    the full game inherits every other agent's syntax errors. Build ablation
    instruments that import the narrowest possible slice (see
    `tools/scratch/sil-standalone.html`), so your instrument survives a
    parallel round.

---

## §12 Four more silent failures, and one measurement rule

All four of these produce no exception. Three produce no console output either.

**1. A backtick inside a `/* glsl */` template literal ends the literal.**
Hit at least six times now across three different agents' trees — a comment
containing `` `depthFunc` `` or `` `src.a` `` terminates the JS template string
and the file becomes a parse error. This takes down the **whole app**, not just
the offending module: `window.__game` never appears and every capture in the
repo times out, including other agents' instruments. In a parallel round this
reads exactly like someone else's breakage. **Never use backticks in comments
inside GLSL template literals.** Use single quotes.

**2. GLSL reserved words compile to nothing.** `cast` is reserved. A variable
named `cast` fails compilation, so the geometry is present, the draw call is
issued, and nothing appears. The `errors` array was the only evidence.

**3. `THREE.MultiplyBlending` silently does nothing without
`premultipliedAlpha: true`** — three never configures the blend equation, so the
material renders as if unblended.

**4. `customProgramCacheKey()` returning a constant** — see §11.

### The measurement rule

Terrain re-measured G8 on today's build with round-4 settings and got
**0.61–0.64**, against the **0.68–0.69** recorded for those same settings last
round. Nothing in the terrain tree had changed. The *surround* got much darker,
which moved the whole plate's ACES and bloom response, which moved the pixel
populations G8 is computed over.

**A metric recorded in an earlier round is not a baseline for this round.** In a
parallel fan-out the frame moves under you continuously, so any before/after
claim must come from **paired measurements on the same build, minutes apart** —
toggle your change, measure both, report the pair. Comparing today's number
against a number written in a doc last round measures the other agents' work,
not yours. Every stored number in `docs/STATUS.md` carries this caveat.

---

## §13 A silhouette test at the wrong camera is not a silhouette test

Round 6 lost 3/3 with all three blind art directors saying the same thing for
the third round running: *"the towers are indistinguishable — the same
barrel/keg silhouette with a coloured glow on top"*. The six element families
had just been rewritten into genuinely distinct masses, and the elevation
contact sheet proved it: 1.6x height spread, 2.1x width spread, 3.4x aspect
spread, an arch with a hole through it, a 4.7:1 needle, a skeletal tripod. Both
statements were true at once.

They were true because **the elevation is not the image being judged.**
`tools/tower-camsil.mjs` photographs the towers under the gameplay camera, at
the gameplay board, at gameplay spacing, and there the towers do not have
individual silhouettes at all. They form one continuous mass. Twenty-one
towers, one blob.

The cause is a single line of arithmetic that nobody had written down:

| | |
|---|---|
| camera pitch | 51.5° below horizontal |
| tower pitch on the board | 4.0 units (a 2×2 footprint) |
| height at which a tower stops covering the BASE of the one behind it, `4·tan(51.5°)` | **5.04 units** |
| actual heights | 7.93 – 13.03, mean 9.91 |
| towers over the threshold | **21 of 21**, by 1.6× to 2.6× |

So the only part of any tower that reached the frame was its crown and the top
of the drum under it — *precisely* the "cylinder plus glowing orb" that three
critics kept describing. No amount of reshaping could have fixed it, because
the shapes were already there and the frame could not show them. Four rounds of
work went into the invisible 60% of every tower.

The reference agrees independently, and could have been read off a screenshot
at any point: an Element TD 2 tower is roughly as tall as its footprint is wide
(~1.0–1.3×), sits fully inside its tile, and at maximum density you can still
see floor between the rows. Ours were ~2.5×. Art Bible §5 says "2.5–3.5× cell
size"; an earlier agent read *cell* as the 4-unit footprint rather than the
2-unit cell and doubled every tower. One ambiguous noun, four rounds.

**Rules:**
- A readability gate must be measured **in the framing the gate is about**. An
  orthographic elevation, a turntable, a contact sheet and an inspector zoom
  are all different images from the shipped one, and passing on them is not
  evidence.
- Before blaming the art, check the geometry of the *arrangement*. `spacing`,
  `camera pitch` and `object height` are three numbers with a closed-form
  relationship, and if that relationship is violated no art direction reaches
  the frame.
- When two ablations differ in exactly one variable and the verdict flips, that
  is the cause. `--modes sil,spread` differ only in tower spacing.
- The control that keeps this tool honest: `full`, `sil` and `silglow` are
  three values of one uniform and must yield three visibly different images. If
  two of them match, the uniform never reached the shader (§11) and nothing the
  tool says is evidence.

---

## §14 Three ways a fix can be real and still not reach the player

All three came out of one round, and all three passed review.

**1. `transition: all` silently swallows `visibility`, and `focus()` is a no-op
on a hidden element.** The key sheet declared `role="dialog" aria-modal="true"`
and moved focus into itself on open. It did not work, and there was no error:
`#help` flips `visibility: hidden -> visible` on the `.open` class, its close
button inherits that — and the button also carried `transition: all`, which
includes `visibility`. Measured in one `getComputedStyle` pass, the parent read
`visible` while the child still read `hidden`, so `focus()` did nothing at all
and the Tab trap had nothing to hold. Six Tabs then walked onto `#restart-btn`
behind the veil, which calls `location.reload()`.

*Rules:* never `transition: all` on anything whose visibility is inherited from a
panel; force the style flush (`void el.offsetWidth`) before focusing something
you just revealed; and do not restore focus to "whatever had it before" in a UI
that dismisses panels with opacity — `isConnected` says yes, `checkVisibility`
says yes for two of the three ways this codebase hides things, and the honest
answer is to return focus to the control that owns the panel.

**2. A metric can measure a population instead of a thing.** "The yellow-green
band is the brightest on the board" was true, reproducible, and not about the
nature towers: the band is thresholded (`S>0.45 V>0.55`), so it selects the
brightest lit faces of anything in that hue range, and roughly a third of it was
the *light* towers and the lanterns. A 52% cut in the nature canopy's authored
albedo moved the band's mean by 3 units, which reads as "the fix did nothing".

*Diagnosis that worked:* repaint the suspect family's palette entry pure magenta
and re-measure. Attribution is then arithmetic — the band lost 7 000 of its
10 000 pixels, so 3 000 were never nature's. Do that before concluding a colour
change failed. (Same shape as §10: hiding X proves X is the source, not that X
is the bug.)

**3. A displacement test is not a movement test.** Right-click was "cancel the
build unless it was a camera orbit", implemented as `hypot(up - down) <= 5`. The
commonest camera gesture there is — spin the board to look, spin it back —
releases within a pixel of its own origin, so a 48-degree orbit was read as a tap
and dropped the tower in hand mid-gesture. The test that was supposed to cover it
only ever dragged *away* and never came home.

*Rule:* when a threshold is meant to ask "did this gesture move", accumulate the
PATH, not the endpoints — and write the test for the gesture that returns, because
that is the one a hand actually makes.

---

## §15 A field can shadow a method of the same name, and the error blames the method

`Painter` had `this.scale` (the letterbox factor, a number) since it was written.
Adding a `scale(x, y)` method to the same class made every instance's own
property shadow the prototype's method, so `g.scale(1, 0.3)` became *"call the
number 1.0"*.

Three things made this cost far more than it should have:

1. **The error names the method, not the field.**
   `translate(...).scale is not a function` sends you to look at `scale()` —
   which exists, is exported, and is correct. Probing
   `Object.getOwnPropertyNames(Object.getPrototypeOf(painter))` showed `scale`
   present, which reads as "the code is fine" and wastes another pass. The
   question that resolved it in one line was `typeof painter.scale` → `"number"`.
2. **The thrower was inside `requestAnimationFrame`.** `main.js`'s loop has no
   try/catch, so an exception from a subsystem's draw does not degrade that
   subsystem — it kills the render loop and freezes the entire game. The symptom
   was "the overlay is stuck on its first frame", not "the drawing looks wrong".
3. **No test could see it.** The unit suites run the logic without a canvas and
   the painter is never touched; the e2e suites did not cover the new surface
   yet. It was found by running the thing and reading the console, which is the
   only instrument that was ever going to catch it.

*Rules:* never give a field the name of a method on the same class — prefer a
name that says what the number IS (`ppu`, "pixels per unit") over one that says
what it does. And any subsystem whose `update`/`draw` is reached from the rAF
loop and is not essential to the game continuing should be wrapped so that a
throw costs that subsystem and not the run — re-reported through `console.error`,
never swallowed, so the e2e console assertion still fails the build.

---

## §16 A pooled input record is a time bomb, and a queue is not a per-step field

Two edges from the minigame input contract (`src/minigames/contract.js`
`NEUTRAL_INPUT`, full write-up in `docs/MINIGAMES.md` §1.1). Neither has a
runtime check, both fail silently, and both look like a bug somewhere else.

**1. The click records are pooled and refilled.** `MinigameHost` pre-allocates
`MINIGAMES.maxClicksPerStep` (12) `PointerClick` objects and rewrites the same
objects on the next `pointerdown` — that is what keeps a reaction game at zero
allocation per frame. A rite that stores one and reads it two steps later is
reading **a shot the player took afterwards**. The symptom is a hit resolving in
the wrong place a fraction of a second late, which reads as a physics or an
interpolation bug in the rite's own code, and every line you would suspect is
correct.

*Rule:* copy what you keep — `{ x: c.x, y: c.y }`, or just read the two numbers
into locals inside the step. `LuckyShotRite.#fire(cx, cy)` takes two numbers
rather than a record for exactly this reason, and `FishingRite` says so at the
line where it clamps the hook's position.

**2. The queue is handed to sub-step 1 only.** The host runs a fixed step and a
slow frame runs several of them; the clicks that arrived since the last frame go
to sub-step 1 and sub-steps 2..n see an **empty array** — the same rule as
`action`, and for the same reason: three sub-steps that each see the same click
fire three shots. So any logic shaped like *"no clicks this step, therefore the
player is idle"* fires spuriously the moment a frame runs long, which on a
headless run at ~4 fps is every frame.

*Rule:* a rite reads the queue and never reasons from its absence. Accumulate
time, not gaps.

The same shape bites in the other direction on the host side: the queue is also
cleared on `#suspend`, because the click that restored the window's focus is not
a shot.

---

## §17 A CSS custom property is scoped to the element that declares it, and a canvas has no element

`src/ui/minigames.css` shipped each rite's palette as
`#rite[data-rite="hunt"] { --rite-accent: #86c294; }`. Every rite read its
colours with the `Lottery.js:722-734` pattern — one `getComputedStyle` in
`init`, off `document.documentElement`, with literal fallbacks. That is the
right pattern and it was reading the wrong element: `--rite-accent` is declared
on `#rite`, not on `:root`, so `getPropertyValue` returned `''` **every single
time** and the literal fallback is what actually painted.

**Nothing looks wrong.** The fallback was copied from the stylesheet, so the
colours were correct on screen; the code merely claimed to be reading a token it
had never once resolved. Four of the six rite authors found it independently,
which is the tell that this is a shape rather than a slip: the failure is silent
by construction, because a token lookup that misses is indistinguishable from a
token lookup that hits a value equal to the fallback.

Two things make it worse than dead code:

- The stylesheet and the canvas can drift apart with nothing to catch it — the
  next person retunes the theme block and half the surface moves.
- Retuning the *other* half means editing a hex literal in a JS file whose
  docblock says the colour comes from CSS.

*Rule, and it is a naming rule before it is a scoping one:* **a generic name
cannot live on `:root`.** `--rite-accent` is one name and there are six accents,
so hoisting it as-is is not available. Every colour a canvas reads is declared
on `:root` under a name prefixed by its owner (`--rite-hunt-canopy-far`), the
scoped block becomes a pure alias for the chrome
(`--rite-accent: var(--rite-hunt-accent);`), and the module reads the prefixed
name.

*How to prove it, since "it looks right" cannot:* `tests/unit/rite-theme.test.js`
(jsdom) sets a property on the root and asserts the value comes back out of the
rite's palette, then loads the **shipped stylesheet** and asserts the value the
canvas would paint with is the value written in the file. The first half proves
the wiring; the second proves the wiring is attached to something. A synthetic
test alone passes happily against a token nobody declares.

## §18 A published deadline without a published claimant is a name that means nothing

`RivalSource` exposed `claimTime(i)` — when contested target `i` is taken — and
no way to ask **who** took it. Because each rival's offset was independent of
`i`, the arithmetically correct answer was that the same rival won every target:
all fourteen animals of a `hunt`, all thirteen fish of a `fishing`. Both authors
noticed and both worked around it in presentation — one rolled the displayed
name from the rite's cosmetic RNG, the other rotated `i % 3` — and both said so
honestly in a comment.

That is worse than it sounds, because the workaround is invisible and
self-consistent: the round *looks* like four anglers competing, and a player who
worked out that the deadline never actually changes hands would be right to
conclude the whole roster is a lie.

*Rule:* when a module publishes a decision, publish **who made it**, from the
same arithmetic. `claimTimeFor(id, i)` is now the primitive; `claimTime` is its
min and `claimant` its argmin, so the two cannot disagree. The variation that
makes the claimant move lives in **how the offsets vary with the target** — a
seeded, skill-weighted permutation of the field across a fixed arrival ladder,
hashed from `(seed, target, k)` rather than drawn — and not in a lookup table
bolted on afterwards.

*The property that made it cheap:* a permutation cannot move a minimum. Dealing
the same ladder in a different order leaves `claimTime` bit-for-bit unchanged, so
no existing seed's deadlines moved and `hunt`'s "exactly one animal contested at
a time" — which is sized against `CLAIM_SPACING` — held without retuning. An
independent per-target jitter would have been the obvious implementation and
would have broken that spacing on the first unlucky seed.
