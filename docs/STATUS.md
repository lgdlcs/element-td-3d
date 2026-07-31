# Status

Run `npm run dev` → http://localhost:5273/
Capture: `node tools/shot.mjs --out shots/x.png --scenario midgame`
Blind A/B: `node tools/compare.mjs --a <ours.png> --b reference/<etd2>.jpg --out cmp/x.png`

See also **docs/PITFALLS.md** — nine classes of bug found the hard way, every one
invisible to code review. Read it before debugging anything visual.

---

## Blind A/B history

The acceptance test: our frame beside a real Element TD 2 screenshot, unlabelled,
left/right randomised per image, critic denied access to the key file, the source,
`shots/`, `reference/` and `docs/STATUS.md`.

| Round | Result | Gate tally (ours) | Verdict |
|---|---|---|---|
| 1 | **Lost 2 / 2** | 3 PASS / 6 FAIL* | *"A very well-designed UI layered over an unfinished greybox."* |
| 2 | **Lost 3 / 3** | 3 PASS / 6 FAIL | *"An unfinished prototype with a shipped-quality UI bolted on top."* |
| 3 | **Lost 3 / 3** | **4 PASS** / 6 FAIL | *"Unfinished — not early, not stylised. Nobody looked at the corners."* |

Round 3's artifact hunt found the single most damaging thing in the frame, and
it was a **gameplay** bug, not an art one: `Waves.js` spawned creep *N* with a
cumulative `spawned * 0.4` offset along −Z. Arrivals were already staggered by
`interval`, so the offset was redundant — and it rendered the entire pending
wave as a rigid, perfectly-spaced queue standing off the board edge, health bars
and ground glows included. The critic described it as "a repeating sprite
lattice with zero positional jitter, zero scale variance" and said it
invalidated the frame. It was arithmetic, so of course it had none. Fixed.

Gates newly PASSING at round 3: G5 (atmospheric depth), G6 (dead frame),
G7 (tonemap — *"the frame's real strength"*, and cleaner than the shipped
comparison, which clips to white), G10 (UI — *"better than anything the shipped
game shows"*).

Still FAILING: G1, G2, G3, G4, G8, G9.

\* round 1 tally was 6 fails of 10 gates judged.

Consistent across both rounds: our **UI scored 8/10 against all three shipped
games**, and our **highlight roll-off was cleaner than either commercial frame**
(both competitors hard-clipped to 255 white; we passed G7 where they failed).
Everything from the camera outward was the problem.

---

## Round 2 → 3 work, and what it actually found

Every item below was dispatched from the blind critic's ranked list. The
recurring theme is that **four separate features had never actually rendered** —
they were implemented, reviewed, and tuned against nothing.

| Agent | Headline finding |
|---|---|
| Terrain r3 | Canvas textures are **premultiplied**; alpha-as-data was destroying RGB. **The arena floor had no albedo for three rounds.** Also `Arena.surfaceHeightAt()` called two undefined functions and threw on every call |
| Towers r3 | The per-tower coloured ground glow was wound in XZ → face normal at −Y → **back-face culled from an overhead camera since round 1.** Never once drawn |
| Environment r3 | `flatShading: true` on domes/tori was the greybox tell (not brightness); motes computed `gl_PointSize` with a constant tuned for an 8-unit camera and **rendered as single clamped pixels**; sky break-up noise was sampled against a unit vector → one feature per ~1500px, real and invisible |
| VFX r2 | `if (s.poison) c.applyBurn(...)` — poison towers **set creeps on fire** and never poisoned. The "pinwheel" the critic blamed on muzzle flashes was actually a frost decal using `sin(ang*9)` radial spokes |
| Towers r2 | `shard()` had inverted tapers — every crystal was an hourglass, which photographs as a bowtie. Halo torus built in XY while its teeth were laid out in XZ |

## Measured now

| Metric | Budget | Now |
|---|---|---|
| Draw calls | < 220 | **99** |
| Triangles | < 900k | **~600k** ← binding constraint |
| JS errors | 0 | **0** |
| Board : backdrop luminance | — | **2.29× / 2.79×** (was 1.09×) |
| Board ↔ backdrop hue opposition | — | **224°** (was ~0°) |
| Tower height ÷ cell footprint | 2.5–3.5× | **2.26–2.55×** (L2 ≈ 3.0×) |
| Tower idle → firing emissive | — | 1.05 → 9.85, **11.7×** |
| Clipped white / crushed black | 0 | 0.037% / 0.027% (UI text only) |

Frame time remains **unverified** — headless Chromium software-rasterises, so
its 70–270ms figures are meaningless. Run `tools/cam-probe.mjs` on real hardware
before making any ms claim.

---

## Round 4 — the structural correction

Round 4 opened by reading the reference frames properly for the first time
(`etd2-04`, `etd2-05`). They invalidated the Art Bible's own founding sentence,
which had specified *"a platform suspended over a starlit abyss… the board is
the only lit thing in the world"*. **That sentence is why G1 was never
passable** — it mandates a void, and three rounds of critics called the void
unfinished. Every fix we dispatched was a variation on keeping it, including
the round-3 critic's own top-ranked *"ship a black void for a day"*, which I
overrode mid-flight.

Art Bible §0 now carries four structural laws taken from the reference, and
§3/§4/§6 plus gates G1 and G8 were rewritten to match:

1. **No void.** World fully lit and textured to every frame edge.
2. **Depth from overlap, not fog.** Props cropped by the frame edge; a
   foreground cluster overlapping the near corner.
3. **The maze is geometry.** Raised terraces + masonry retaining walls that
   cast shadow. A mask has no silhouette, which is why 4 rounds of material
   work never moved G8.
4. **Saturation carries readability, not brightness.** Ground is the
   lowest-saturation surface in frame. High chroma at moderate luminance
   survives ACES; high luminance gets bleached.

This was available in `reference/` since round 1. The blind critic is denied
reference access by design, so it could only ever say what looked wrong, never
what the target was — going back to the source material was mine to do.

### Towers r4 (landed)

- Authored detail is now **coursed masonry in world units** — 0.345u courses,
  0.62u blocks in running bond, recessed mortar, lit top chamfer, chipped
  corners on ~14%. Old high-frequency grain pulled back ±36% → ±18%; it was
  competing with the courses and the pair re-read as noise.
- Element channels **quantised to the courses**, so the glow is a ladder of
  light in the mortar rather than an unbroken neon tube.
- Saturation 8–14% → **29–74%**, against a 15–22% floor. Law 4 satisfied.
- Height ÷ footprint **2.13–2.55 → 2.32–3.48** (target 2.5–3.5), bought with
  shaft height only; all added width is at ground level or above crown height,
  so the creep-occlusion regression is not worsened.
- **G3 verified independently by me**, not taken on report: `shots/r4-sil-verify.png`.
- Reservation for the critic: water and light still read a little "chess
  piece". Distinct ≠ characterful.

`tools/tower-sheet.mjs --silhouette` **had never once produced a silhouette** —
it set `scene.background = null`, which renders black, and drew black towers on
it. Another instance of the house pitfall: a mode that had never worked, used
to justify decisions. Fixed (white background via the Color class reached
through an existing instance; also hides Points/Sprites/Lines, which are not
`isMesh` and were speckling the sheet).

### Terrain r4 (landed) — and the find of the round

**`Arena.markPathDirty()` had zero callers tree-wide.** See PITFALLS §8. The
painted road was the one solved in the `Arena` constructor before any tower
existed, so it and the route creeps actually walk were unrelated for three
rounds. **G8 was never an art problem** — three rounds of agents made a road
that was in the wrong place progressively prettier. `PathMask.maybeRebuild()`
now FNV-hashes `grid.cells`; I added explicit `arena.markPathDirty()` calls at
both mutation sites in `Game.js` as the fast path.

- Terrace: `uRoadDepth` 0.46 → 1.00, half a build cell. Law 3.
- Wall normals were never shaded: `computeVertexNormals()` ran on the flat
  plane and the sink happens later in the vertex shader, so every normal on a
  1-unit vertical wall pointed straight **up**. Now differentiated analytically
  and UDN-blended.
- **Analytic** cut flagstone and wall masonry in world space — G2 by
  construction rather than by bombing a texture hard enough to hide its period.
  Coursing follows the mask gradient, so corners read as quoins. Zero per-block
  geometry.
- `castShadow` on the terrace gave a half-cell sawtooth (G9); rejected after
  ablation, replaced with an analytic drop shadow driven live from the key
  light so it agrees with every real shadow in frame.
- `Tufts.js`: ~620 instanced wind-swayed tufts on the terrace edge, 1 draw call.

**G8 measured, not asserted** (`tools/scratch/g8-r4.mjs` — Cohen's *d* between
lane and terrace pixel populations sampled through the live camera):
flat 0.92 → terrace first pass **0.25** → final **0.70**. Sinking the lane
initially *raised* its mean by ~14 L: the terrace bought silhouette at the cost
of the value contrast the flat version happened to have. Recovered via road
albedo **and** a channel sky-occlusion term on the light — albedo alone moved
*d* only 0.25→0.43, because 87% of that plate is the specular lobe.

Budget paid back and then some: **1,042k → 691,296 triangles**, 124 draw calls,
0 JS errors. Tessellation 12→8/cell, with the wall's plan-view silhouette
bought back by widening the kerb band instead.

### Environment r4 (landed)

Deleted the entire round-3 backdrop — `brokenPillar`, `rockIsland`, `ziggurat`,
`archRuin` (**the "large untextured torus"**), `chainRun`, `monolith`,
`brokenBridge`, `collapsedDome`, `colonnade`, `aqueduct`, `fallenColossus`,
`gateArch`, 3 merged ruin rings, the shard field and the distant-lights Points.
26,608 triangles, 5 draw objects, 3 shader programs.

The agent independently proved the silhouette-parallax brief was **unbuildable**:
at pitch 54.2° the top-of-frame depression is 34.2°, so **any ground at board
level fills the frame to the top edge at 87 units out**. Nothing beyond that can
be on screen. Every old ruin (r=172–372) was visible *only* because it hung in
the void below the horizon — which is exactly why it read as floating cardboard.
Independent confirmation of the law-1 override.

Replaced by `src/world/env/Surround.js`: a continuous heightfield from under the
rim to r=300 with clustered aperiodic props, all `MeshStandardMaterial`, lit by
the same rig and tonemap as the board.

- Board:surround luminance **93.4 : 51.7–61.1** → surround **0.55–0.65× board**,
  which is the direction I arbitrated for. Hue opposition **166–253°**.
- Surround saturation 17–28% vs board 12% — the surround is *more* saturated and
  *darker*, per law 4.
- Repeated PITFALLS §2 verbatim: polar index winding gave the ground a −Y face
  normal and **the entire surround was back-face culled**. Also rewrote the
  albedo twice chasing "camo blotching" that turned out to be a lighting bug —
  the bump finite-difference epsilon (0.22) was larger than the noise field's
  period, so the gradient was uncorrelated noise.

Also removed by me: `Forge` (molten sea) and `CloudStrata`, 3,552 triangles and
2 draw calls rendering **zero pixels** now that opaque ground occludes them.

### Creeps r4 (landed) — G4 met

| | HUD | countable from the image alone |
|---|---|---|
| Before | 6 | **2** |
| After | 7 | **7** |

Chroma is what decided it: creeps went from **sat 15% / val 48%** — *lower*
saturation than the floor — to **sat 57.5% / val 75.8%** against a floor at
42.2% / 47.3%. Law 4.

**The fresnel rim is gone**, and the agent correctly diagnosed why three rounds
of tuning it failed: the failure is geometric, not a tuning miss.
`pow(1-NdV, 3.4)` is sub-pixel on a 54px body, and widening it puts a 5px limb
at a luminance where ACES discards the one axis stone cannot compete on.
Replaced by `src/game/creeps/silhouette.js` — two inverted-hull passes sharing
the body geometry *and* its `instanceMatrix`:

- **OUTLINE** — BackSide, inflated in *view* space scaled by depth, so it is a
  constant pixel width at any zoom. Amplitude measured *down* 1.40 → 1.02,
  because ACES + bloom desaturate above ~1.2.
- **XRAY** — FrontSide, `depthFunc = GreaterDepth`, drawing only where something
  nearer already wrote depth. This is the tower-occlusion answer.

Hit flash, third attempt: now a *gain on the element colour* rather than a lerp
to white, because under sustained fire the term is permanently on.

### Arbitrations I made this round

- **The rim stops being a platform edge.** Battered wall and −6.5-unit
  underbelly slab deleted; replaced by a low coursed retaining wall with ground
  continuing outward at lane-floor level. Terrain authoritative up to and
  including the wall, environment beyond it. That seam is the likeliest G9 in
  the frame.
- **Rim runes move to the coping's inner face.** They sat on the outer fascia
  below the coping, facing outward and down — never visible at 55° pitch. The
  tenth never-once-seen feature.
- **Composition inversion is the environment agent's to fix, not terrain's.**
  Board:surround collapsed 2.29× → **1.31×** with hue opposition gone; the
  board is now cooler and *darker* than its surround, which is backwards. The
  reference has the play area as the brightest, warmest region with the
  surround supporting it. Terrain holds its cool low-saturation board (law 4
  requires it, and towers at 29–74% saturation now depend on it); environment
  drops the surround to ~0.6–0.75× board luminance, cooler and greener —
  saturated dark foliage, *not* a desaturated grey band.
- **`ProceduralTextures.js` assigned to terrain** — the crazed-vein flagstone
  map is the source of the "one texture at one UV scale" verdict.

## Open

- **Creeps r2 in flight** — gate G4 still FAIL. Critic: *"The HUD says 8 alive.
  I found two."* Round 1 did implement an element-colour fresnel rim; it stopped
  reading once the floor got much brighter, and `pow(1-NdV, 3.4)` is a band too
  thin to survive below ~40px.
- **Residual rim-following dot pattern** off the board edge — the mote *lattice*
  is fixed (was an axis-aligned `floor(x/11)` hash; now a continuous blended
  hue field) but a row of bright dots still tracks the platform perimeter.
  Suspect the ground-fog billboards rendering as sprites rather than soft fog.
- **Emissive rune strip on the platform rim** — from the critic's top-6, never
  done; the rim is terrain geometry and terrain was live at the time.
- **Shaft occlusion is a knife edge** — needs the depth texture for a soft
  particle fade, which lives in RenderPipeline.
- **Tower surfaces are procedural noise, not authored detail** — no masonry
  courses, no carved channels. Art Bible §5 half-delivered.
- **Warm-element light pools barely register** on a warm floor (measured hue
  18 → 18); only luminance moves. Cool elements read strongly.

## Conventions

- **AO exclusion is `userData`, not layers.** Auto-excluded when `transparent`,
  non-Normal blending, `depthWrite:false`, or Points/Line/Sprite. Force with
  `userData.noAO` / `userData.aoOccluder`. Layers were rejected because
  `object.layers.set()` also drops an object from raycasts and shadow cameras.
- **Never hardcode a Y.** Use `arena.surfaceHeightAt(x,z)` / `plateauTop` /
  `laneFloor`. Injected into towers as `towers.surfaceHeightAt`.
- **God rays anchor to `environment.godRayAnchor`**, never the key light — the
  sun is geometrically never on screen at this camera pitch.
- **Dual tower names are canon-verified** (docs/REFERENCE.md); legacy ids from an
  early wrong draft still resolve via `LEGACY_DUAL_IDS`.

---

# Round 4 — the blind A/B, and what it actually told us

## Result: lost 3/3, all decisive

| comparison | verdict | confidence | ours was |
|---|---|---|---|
| vs `etd2-04-ruins-terraces-tower-glows` | reference | 96% | B |
| vs `etd2-05-desert-lategame-maze` | reference | 92% | B |
| vs `etd2-11-multiplayer-max-density` | reference | 96% | B |

Three independent critics, randomised sides, no access to the key, the source,
`shots/`, `reference/` or this file. None hesitated. `MARGIN: decisive` on all
three.

## The convergence is the finding

Six defects were named independently by two or three of the three judges. That
is a far stronger signal than any single round-3 critique, because none of them
saw each other's answers:

| defect | c-04 | c-05 | c-11 |
|---|---|---|---|
| board floats / world does not continue | #1 | #1, #2 | #1 |
| no material differentiation, one shader look | #2 | #4 | #2 |
| towers are interchangeable chess pieces | #4 | #6 | (praised ref's profiles) |
| units invisible against ground | #5 | #7 | #3 |
| VFX are undisciplined washes, not light | #6 | #8 | #4 |
| HUD out-contrasts the 3D scene | #9 | #9 | #9 |

All three also independently gave the SAME highest-leverage fix:
- "Build a real environment around the arena and light it."
- "Commit to a real key light and ground the board."
- "Stop lighting and texturing the board as an object and start building an
  environment around it."

## The diagnosis I got wrong, and the correction

Round 4's whole thesis was "there is no void" (law 1). It shipped: ground now
reaches every frame edge, measured, verified. **All three critics still called
it a floating slab on a plane.**

The error is mine and it is worth stating precisely, because it is the same
shape as the round-3 error. Law 1 was implemented as *cover the screen in
ground*. The critics were never objecting to the absence of pixels; they were
objecting to the absence of a *place*. Our surround is procedurally SCATTERED —
props distributed by a density function over a noise plane. A density function
produces even density by construction, and "evenly dense everywhere" is exactly
what "undifferentiated" means. There is no scatter parameter whose value is
composition.

Every reference frame is authored: a road that enters and exits frame, houses
with lit windows, a crenellated rampart, a water basin, a specific cliff, with
deliberately EMPTY ground between them. Uneven density is the deliverable.

That is now **law 5** in the Art Bible.

## The one place the critics are wrong

Two of three wrote "no key light direction is legible" / "lighting is one key
with dead fill". The shadows are in fact correct, long, and consistent from
upper-left across the entire slab — visible in any capture. What they are
reading is the SURROUND returning a constant, because it is flat and has no
geometry to shade. This is a content defect misdiagnosed as a lighting defect,
and dispatching a lighting fix for it would have burned round 5. Recorded here
so nobody re-derives it.

## Also settled this round: the off-board coloured row

Four rounds, four wrong attributions (fog, creeps, tower glow pools, tower
geometry). It was `GodRaysPass`, which the presets had enabled while the file's
own docblock claimed it was disabled. Turning off the post pass removed MORE of
the artifact (-83%) than deleting every tower in the scene (-61%). Full writeup
in PITFALLS §10. The pass is now off, and guarded so it is not a landmine if
re-enabled. `motionBlur: true` in the ultra preset turned out to have no
implementing pass at all.

## Round 5 fan-out (dispatched)

| agent | owns | brief |
|---|---|---|
| Environment | `src/world/env/**` | law 5: authored landmarks, road entering AND exiting frame, foreground occluder cropped by bottom edge, surround elevation, distant silhouette layer |
| Towers | `src/game/towers/**` | silhouette identity — element readable as a solid black shape; three distinguishable roughness values |
| Creeps | `src/game/creeps/**` | reserved hostile hue, contact shadow, rim that survives ACES; verified on a real frame, not a probe |
| VFX | fx tree | emitters emit LIGHT; small hot core, fast falloff; occluded by towers |
| Terrain | `src/world/terrain/**`, `Arena.js` | law 6: break the continuous border, terrain crossing it at 2+ points/side, contact AO at the slab base, worn path in the floor |

Unassigned, flagged by all three at rank #9: the HUD out-contrasts the scene.
Deliberately held — it is the lowest-ranked defect and the frame's value
hierarchy will move under four concurrent agents. Fixing it now would be tuning
against a frame that is about to change.

# Gameplay round: foundations, blocked-terrain warning, multiplayer

Three features, one of which changed how the board is played.

## Foundations — the mazing piece that was missing

Element TD's real build flow is "raise a plain tower, THEN decide what it
becomes". We had no equivalent, so every wall segment cost 60 gold *and* a
permanent element decision — which is why the board kept coming out as a scatter
of towers rather than a maze. A 20-gold inert 2x2 block fixes it.

Pricing is cost-neutral by design: converting credits the foundation's full cost,
so 20 + 40 equals the 60 a fire tower costs outright. Mazing with foundations is
free in the limit and you only pay for blocks you never arm. Anything less
generous makes the tool a tax on using it.

The block withholds **every** cue that says "this shoots": no emissive, no crown,
no collar, no halo, no orbiting shards, no floating rune, no ground glow, and it
is excluded from the point-light pool. That last one is not aesthetics — an
inert block scored 0 against an empty slot's -1 and would have parked the most
expensive resource in the renderer on a grey box.

Two mechanical traps found while building it:

- **The additive overlay buffers are indexed by a different sequence than
  `towers`** once a foundation exists, because foundations are filtered out of
  them. Each tower now carries the slot it was assigned (`overlaySlot`). Without
  that, tower *i*'s glow intensity lands on whichever *lit* tower sits at index
  *i* — invisible in a screenshot, wrong in motion.
- **A shared geometry needs an asymmetric shape to benefit from per-instance
  rotation.** The first block was near 4-fold symmetric, so the quarter-turn
  keyed to grid position produced four identical results and a wall read as a
  tiled texture — because it was one. The capstone is now off-centre and there is
  one corner buttress and one broken corner.

Measured against the alternative — 14 foundations vs 14 pure towers, same
anchors, same session, bracketed by two `pure` rows to bound drift:

| row | median | lit point lights |
|---|---|---|
| 14 pure | 43.9 ms | 3 |
| 14 foundations | 43.6 ms | 0 |
| 14 pure (repeat) | 44.1 ms | 3 |

Drift 0.2 ms, effect 0.4 ms in favour of foundations. Small, but the sign is
right and the mechanism is visible in the light count.

## Blocked terrain — show the consequence, not the refusal

The only feedback for an illegal placement was a red pad plus a toast that
appeared 250 px away *after* a click was refused, so the player learned the rules
by being denied one click at a time. Worse, one red covered three different
problems with three different fixes: something is already there, I cannot afford
it, and this closes the maze.

Now: four named outcomes with four colours, a hint panel at the cursor naming the
reason *before* the click, and — for the sealing case only — the ground that
would be cut off is painted with animated red bars plus an X on the pad.

`Arena.setHover` takes a **name**, not a boolean, and unknown names resolve to
`occupied` rather than to `valid`. A stale `false` under the new encoding would
have landed on 0 and painted an illegal cell green: the UI telling the player to
click somewhere the game will refuse. Erring toward "invalid" makes a missed call
site an annoyance instead of a lie.

The cut-off set rides the **blue channel of the occupancy texture**, which nothing
else used. It is 26x20, so a 2 KB upload per pointermove — cheaper than the
raycast that produced the hover.

`Pathfinder.#floodReachable` used to early-exit on touching the exit row. That was
right for `wouldBlock` alone and useless for `sealPreview`, which needs the
complete reachable set — a flood that stops early reports perfectly connected
ground as cut off. One full flood over 520 cells is cheaper than the pointermove,
so there is no reason to keep two versions.

Verified on a real frame with a control, not by eye: with a wall of 12 foundations
and one gap left, red-dominant pixels are **2.49%** of the frame, and **0.25%**
with the preview cleared. The 2.24-point delta is what proves the red belongs to
the warning rather than to red creeps and warm stonework.

The new shader branch costs **-0.2 ms**, i.e. nothing: the grid overlay was
already shading those pixels.

## Multiplayer — shared seed, not lockstep

See `docs/MULTIPLAYER.md`. Every player runs their own complete board; the server
syncs a room seed and relays status for a live leaderboard. Deliberately not
authoritative simulation and not lockstep — boards never interact, so the only
thing fairness needs is that nobody gets an easier wave or a luckier element
offer, and `waveDef(n)` is already a pure function of the wave number.

`Game.js` knows nothing about WebSockets. It takes a `seed`, exposes
`snapshot()`, and fires `onRunEnd`. `main.js` is the only file that couples the
game to a transport, so single-player carries no networking path at all and a
wire-protocol change cannot reach gameplay.

## Verification outcome, and what the reviewers found that my own tests did not

Every component was built against a fixed wire contract and then attacked by an
independent reviewer that had to RUN it, not read it. All three returned
`NEEDS_WORK` — 24 reproduced defects — against an end-to-end test of mine that was
already green on 23 assertions. Three of those defects were invisible to it:

- **The leaderboard marked every player as eliminated before their first status.**
  The server seeds roster entries with `lives: 0`, so `isOut = finished || lives <= 0`
  fired for everyone. That is the first seconds of every multiplayer run: the whole
  table reads as dead. My test missed it because it only looked *after* scores had
  flowed. Reproduced at 2/2 before believing it (`tools/scratch/sbfresh.mjs`). The
  same root cause made the wave column fabricate "W1" for a relayed wave of 0.
- **A room whose run had ENDED was permanently unjoinable**, answering
  `IN_PROGRESS` / "that game has already started" — the opposite of the truth.
  Rooms did play further rounds; a friend simply could never join between them.
- **A sustained mild overspeed ejected a live player.** 8 Hz status — a plausible
  client bug, status ticked off a sim frame — closed the socket with 1008 after
  150 s, mid-run. The gap-based decay could never elapse for a continuously
  overspeed client. Now a leak rate, and genuine floods are still evicted in 0.55 s.

Plus: the server ranked on the raw value while clients displayed `| 0`, so a player
could be ranked #1 while showing score 0; and one 20,000-frame burst wrote **19,688**
log lines, because `ws.close()` does not stop the message handler — contrary to that
file's own comment.

Post-fix: lobby **CLEAN** on all 9, server 7 of 8 confirmed (no connection/room
ceiling deferred, with reasoning), scoreboard verified by me after its recheck agent
died mid-response — including **zero** overlap with the threat rail measured at
1600x900, 1280x800, 1100x700 and 1024x640, where the reviewer had measured 71px.

`NetClient` and `Rng` had no independent reviewer either (that agent also died), so
`tools/scratch/netaudit.mjs` is that audit: 41 assertions. `connect()` never throws
and always settles, against a dead port, a **mute TCP server that accepts and then
never speaks** (2.5 s), an instant close, and an HTTP 200 instead of a 101. Status
throttles to exactly 2.00/s. The generator is uniform over 200k samples with zero
negative draws.

That audit found one defect in my own integration: `connect()` resolves `false`
while `state` still reads `'connecting'`, because a retry is already scheduled.
`main.js` was reading `net.state` at that moment, so the connection pill said
"Reaching the server…" underneath a panel that had already given up. It now reads
the resolved boolean.

### One assertion that has now been wrong in both directions

`mplive.mjs` first read `rows[0]` as the leader — wrong, because the panel sorted
visually with CSS `order`, so DOM order was join order. It was changed to assert
`order === '1'`, which then became wrong when the scoreboard review found that flex
`order` leaves the `<ol>` frozen and assistive tech reads a stale ranking. The fix
replaced inline order with real DOM reordering, and the probe was left asserting the
behaviour that had just been removed for accessibility. It now asserts the property
the code actually promises: DOM order **is** the ranking, and no inline order
remains.

### Frame budget: no regression

Measured after all three features landed, controller allowed to converge
(`tools/scratch/adaptive.mjs`), against the figures from earlier in the session:

| preset | before | after | verdict |
|---|---|---|---|
| ultra | 46.7 / 57.3 ms | 47.8 / 55.8 ms | unchanged |
| high | 29.7 / 39.6 ms | 30.5 / 39.6 ms | unchanged |
| medium | 24.6 / 27.1 ms | 25.9 / 28.0 ms | unchanged |
| **low** | 16.7 / 17.6 ms | **16.7 / 17.9 ms** | **still 60 fps** |

Everything is inside 1.3 ms, i.e. noise. Foundations, the seal-preview shader branch
and the multiplayer status pump cost nothing measurable.

**A measurement trap hit twice on the way to that table.** A first pass reported
110.9 ms at ultra — four verification agents, two dev servers and a browser were
competing for the machine, so it measured contention, not the game. And
`foundations.mjs` reported 23 ms and then 35 ms for the same build across two runs:
it froze the adaptive controller at whatever scale it had drifted to, and the frame
is linear in pixel AREA. It now pins the resolution and prints it, because an
uninterpretable absolute number in a probe's output is a regression report waiting
to happen.
