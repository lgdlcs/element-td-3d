# Frame budget

## Why this file exists

Eight rounds of visual iteration ran without anyone measuring a frame time. The
blind-critic loop that drove every decision scores **still frames**, and a still
frame costs nothing to look at, so nothing in the loop could ever report that
the game does not reach interactive frame rates. It does not. On an Apple M1 it
renders at **6 fps at `ultra` and 12 fps at `low`**.

The `low` preset was not the safety net it appeared to be. It cuts SSAO, MSAA,
DOF, grain and decals and caps pixelRatio at 1 — the entire post stack — and
buys only a 2x improvement, because the post stack was never where the money
went.

## The target

**16.6 ms median, 25 ms p95, at 1600x900, on an Apple M1, at `high`.**

p95 is part of the target, not a footnote. A 60 fps median with a 90 ms p95 is a
stuttering game, and a median alone cannot say so.

## Measured baseline (2026-07-29, M1, headless Chromium / ANGLE Metal, 1600x900)

Scenario is the one every visual round uses: 21 towers, wave 21 live.

| Preset | empty board | loaded board | tris | draw calls |
|---|---|---|---|---|
| ultra | 161 ms (6 fps) | 160 ms (6 fps) | 788k | 159 |
| high | 132 ms (8 fps) | 141 ms (7 fps) | 788k | 159 |
| medium | 124 ms (8 fps) | 123 ms (8 fps) | 788k | 158 |
| low | 85 ms (12 fps) | 92 ms (11 fps) | 399k | 105 |

### Attribution — post stack (ultra, ablated one pass at a time)

| Pass | Cost |
|---|---|
| GTAOPass | **35.3 ms** |
| ShaderPass (grade) | 3.5 ms |
| SMAAPass | 3.6 ms |
| UnrealBloomPass | 1.4 ms |
| OutputPass | 1.4 ms |
| DepthOfFieldPass | 1.0 ms |
| GodRaysPass | ~0 (disabled, but still in the composer) |
| **all post off** | **saves 90 ms** |

The total (90 ms) far exceeds the sum of the parts (~46 ms). Disabling every
pass lets the composer skip intermediate render-target ping-pong altogether, so
the bandwidth cost of the chain is real but invisible to per-pass ablation.
Cutting *one* pass is worth much less than cutting the *chain*.

### Attribution — scene, post disabled (baseline 81.6 ms)

| Hidden | Saves |
|---|---|
| towers (21 of them) | 41.7 ms |
| environment | 32.8 ms |
| arena / ground | 32.4 ms |
| shadow map | 7.9 ms |
| creeps | 0 |
| fx | 0 |

**This table is misleading and is kept only because acting on it was the
mistake.** See the correction below.

### Correction — the cost belongs to lights, not to objects

Hiding `towers.group` saves 40.5 ms. Hiding the `towerBatch` mesh *inside* that
group saves **3.6 ms**. The other ~37 ms is eight `PointLight`s that also live
in the group:

| Hidden | Saves |
|---|---|
| towerBatch (all 21 towers, 53k tris) | 3.6 ms |
| ground-glow decal | 0 |
| rune mesh | 0 |
| each PointLight, individually | 5.2 – 6.9 ms |
| **all 8 PointLights at once** | **40.2 ms** (81.3 → 41.2 ms) |

A dynamic light in three.js adds one iteration of the per-fragment lighting loop
to **every lit pixel in the scene**. Eight of them double the cost of shading
every surface the camera can see. That is why the frame is fragment-bound, and
why hiding the ground, the environment or the towers each appeared to "save"
30–40 ms: those ablations were not measuring the cost of those objects, they
were removing pixels that the eight lights were being charged for.

`LIGHT_POOL` in `TowerBatch.js` was **4**, and a visual round raised it to 8 with
this rationale, recorded in the source:

> "Four was not enough across a 21-tower board: the Art Director's verdict was
> *nothing casts coloured light... in a shipped build those cores would be the
> primary light source of the frame*."

One aesthetic verdict, acted on without a frame-time measurement, cost ~20 ms.

### What did not work, and why it is recorded here

The first fix attempt targeted `TowerMaterial`, which evaluated 64 hash
functions per fragment (two octaves of value noise, sampled four times for a
bump gradient). That was replaced with a baked `Data3DTexture` carrying the
field and its gradient — 64 hashes down to 2 texture fetches. The runtime shader
was verified to have changed (`tdetail4` present, `sampler3D` present, old
`thash` gone, uniform bound).

Frame time moved from 41.7 ms to 40.5 ms: **nothing**. The tower shader was
never ALU-bound. The optimisation is kept because it is strictly better and
costs nothing, but it bought no time, and the analysis that motivated it was
wrong. Counting instructions in a shader predicts nothing until you have
confirmed the shader is where the time goes.

## Root cause

Not geometry. 788k triangles in 159 draw calls should cost ~2 ms on an M1; we
measure 81.6. Not overdraw either — the scene holds only three translucent
surfaces of any size (`boardContactShadow` 3111 u², `rimRunes` 2083 u², and one
994 u² mesh).

It is **per-fragment shading cost**, measured at ~59 ns/px for the scene alone
where 1–2 ns/px is normal:

- **`TowerMaterial` samples zero textures** and evaluates ~87 expressions per
  fragment. The project's "fully procedural, zero binary assets" rule leaked out
  of load time and into the render loop: work that should be computed once per
  texel is recomputed 60 times a second per pixel. 21 towers = 41.7 ms.
- **`GroundMaterial` samples 32 textures per fragment.** A normal PBR material
  samples 4–6.

Both are fixable without changing the look, by baking to textures at load —
which `ProceduralTextures.js` already does for the rest of the game.

### 16.7 ms is vsync, not a floor — every probe here saturates at the target

`floor.mjs` hid the scene groups cumulatively and reported that a completely
empty scene — 5 draw calls, 0 triangles, post off, shadows off — still cost
**16.7 ms**. Read naively that is a catastrophic fixed floor: the entire 60 fps
budget spent before drawing anything, and no art reduction could ever touch it.

It is an artefact. `floorwhy.mjs` varied the one thing such a cost would have to
depend on:

| empty scene, post off, shadows off | ms |
|---|---|
| pixelRatio 2 (3200x1800) | 16.7 |
| pixelRatio 1.5 (2400x1350) | 16.7 |
| pixelRatio 1 (1600x900) | 16.7 |
| pixelRatio 0.5 (800x450) | 16.7 |
| direct to screen, composer bypassed | 16.7 |
| **`render()` replaced by `clear()`** | **16.7** |

A 16x range in pixel count moves it by nothing, and it survives deleting the
render call entirely. 16.7 ms is 1/60 s: it is **vsync**. Every probe in this
directory measures the rAF interval, so all of them clamp at 60 fps.

Two consequences, and both matter:

1. **Any measurement that reads 16.7 means "at or above 60 fps", not "16.7 ms of
   work".** An ablation that lands on 16.7 gives a LOWER BOUND on what it
   removed, never the value. The `arena` row below is such a bound.
2. **The instrument saturates exactly at the goal.** Hitting the target looks
   like every probe reading 16.7. There is no headroom visible past it, so
   "we reached 60" can be confirmed but "we reached 90" cannot.

Corrected scene attribution (cumulative, ultra, post off, 21 towers + wave 21):

| removed | ms | own cost |
|---|---|---|
| baseline | 58.0 | — |
| fx | 58.9 | ~0 |
| + creeps | 59.2 | ~0 |
| + towers | 40.5 | 18.7 |
| + environment | 26.0 | 14.5 |
| + arena | 16.7 | >= 9.3 (hit vsync) |

Note `fx` and `creeps` cost nothing measurable. Rounds of creep and VFX art
optimisation would have bought zero frame time.

### The frame is fragment-bound and the CPU is free

`cpubound.mjs`, preset `low`, loaded scenario, full pipeline:

| pixelRatio | drawing buffer | frame |
|---|---|---|
| 2.0 | 3200x1800 | 80.7 ms |
| 1.5 | 2400x1350 | 56.7 ms |
| 1.0 | 1600x900 | 34.1 ms |
| 0.5 | 800x450 | 17.9 ms |
| 0.25 | 400x225 | 16.6 ms (vsync) |

Linear in pixel AREA at ~12 ns/px across a 64x range, and `game.frame()` with
`render()` stubbed out costs **0.20 ms median / 0.40 ms p95**. There is no CPU
problem. There is no geometry problem. Every millisecond is fragment shading,
and ~12 ns/px is 6-10x what this content should cost.

This also settles a run of non-additive material ablations (sky alone free,
surround alone free, both together 10 ms) that had suggested a `max(CPU, GPU)`
relationship. It is not that — the CPU is 0.2 ms. Those results are not
explained, and they are not load-bearing for anything here.

Two consequences:

1. **Resolution is a near-perfect control knob.** Cost is proportional to pixel
   count with no fixed CPU component to hide behind, so halving area halves the
   frame. That is what `AdaptiveResolution.js` exploits.
2. **Scaling resolution is mitigation, not repair.** At `low` the game needs
   ~0.5x scale (800x450 from a 1600x900 viewport) to hold 60 fps on an M1, which
   is a visibly soft image. The fix is the ~12 ns/px, not the pixel count.

Per-preset per-pixel cost, measured at 960x540 with the adaptive controller at
its clamp:

| preset | frame at 960x540 | ns/px |
|---|---|---|
| ultra | 65.9 ms | ~127 |
| high | 47.6 ms | ~92 |
| medium | 39.5 ms | ~76 |
| low | 21.0 ms (at 1040x585) | ~35 |

### The composer never heard about pixel-ratio changes

`EffectComposer` keeps its own pixel ratio, captured once at construction, and
sizes every intermediate target by it. `RenderPipeline.resize()` called
`composer.setSize()` but never `composer.setPixelRatio()`, so changing the
renderer's pixel ratio at runtime rescaled **only the final blit to the canvas**.
The scene, the AO prepass and the entire post chain kept rendering at the
original resolution.

The adaptive controller walked all the way down to its 0.6 clamp for **zero**
milliseconds of gain, at every preset, and the canvas backing store shrank to
960x540 while the frame time did not move — which is what exposed it. The
initial preset `pixelRatioCap` was unaffected (it is applied before the composer
is built); only runtime changes were silently dropped.

### Round 9 — fan-out: 24 levers benchmarked serially, and what died

A 6-agent fan-out analysed every measured cost centre; one agent then benchmarked
all 24 runtime-patch recipes **serially** (GPU timings cannot be parallelised) at
preset `high`, 1600x900, pixelRatio 1, adaptive disabled. Paired baselines
82.1 ms at the start and 82.5 ms at the end — 0.4 ms drift, so the run is valid.
Probe: `tools/scratch/levers.mjs`, raw rows in `tools/scratch/levers-out.json`.

**Correction to this document, found by that run:** "fx costs ~0" was true of fx
GEOMETRY only. Every fx ablation ever run here used `fx.group.visible = false`,
and `LightPool`'s six point lights are `scene.add`ed directly, not parented to
that group — so they were never in any ablation. See `EffectSystem.js`.

Landed and verified paired, same session (`tools/scratch/fxlights2.mjs`):

| fx LightPool arm/disarm | median | p95 |
|---|---|---|
| old: 6 slots pinned visible at intensity 0, idle | 63.9 ms | 86.3 ms |
| new: spent slots disarmed, idle | 58.2 ms | **62.2 ms** |
| old, under heavy continuous fx | 86.9 ms | 110.5 ms |
| new, under heavy continuous fx | 85.9 ms | 105.4 ms |

So it saves **5.7 ms median and 24.1 ms p95 at idle**, and is never worse under
load. It is NOT the 24.9 ms the fan-out reported for this lever; that figure came
from hiding the lights in a differently-conditioned scene. The p95 result is the
valuable half and is the first p95 evidence this project has.

A first attempt at that probe omitted `waves.start(21)` and measured a 57.8 ms
scene against an 82.1 ms claim, concluding the lever was worth nothing. It was
measuring a different scene, not refuting anything. Scenario parity is part of
pairing.

**Cross-checked, look-free, not yet landed:** confining MSAA to the scene render
so the post chain stops being multisampled — measured twice by independent
implementations, +12.5 ms (A2) and +13.0 ms (D2). Full MSAA off is +23.5 ms
(A3/D4) but SMAA alone does not fix coverage aliasing on thin geometry, so that
one belongs behind a preset knob.

#### Dead ends — measured at ~0 ms, do not retry

- **Ground texture fetches.** Anisotropy 8 -> 1 on all 7 maps: -0.2 ms. Cutting
  28 fetches to 21 (verified landed): +0.3 ms. **Pre-compositing the splat maps
  is wasted work.** Ground cost is analytic-layer program complexity: stock
  `MeshStandardMaterial` on the ground is +10.2 ms, flat colour +16.4 ms.
- **The whole GTAO lever.** Freezing the G-buffer entirely: +3.2 ms. Half-res AO:
  +2.9. Fewer samples: +1.5. The 35.3 ms recorded above for GTAOPass was measured
  at `ultra` by disabling the pass, which also removed two composer target
  writes — most of it was MSAA ping-pong, now correctly attributed to A/D.
- **The whole shadow lever is ~5 ms, not 20.9.** Throttling shadow generation to
  1 frame in 4 removes ~75% of it for +4.0 ms; 2048 -> 1024 is +4.6. VSM -> PCF
  is **-0.2 ms** even though it genuinely drops 8 receive-only meshes from the
  depth pass. VSM blur samples 16 -> 6: +1.0. The 20.9 figure above is stale.
- **Depth/stencil resolve.** +1.7 and +1.3, both inside noise, cross-confirmed.
  The MSAA money is colour store/resolve bandwidth.
- Removing the disabled `GodRaysPass`: exactly 0 — the composer skips it before
  touching a target. Bloom at half res: already builds its pyramid from w/2.

#### The cost model that keeps being wrong

**Counting shader instructions or texture fetches predicts nothing here.** Four
independent falsifications: Sky's 15 fbm3 / ~340 hashes per pixel (+0.5 ms),
TowerMaterial's 64 hashes baked to a 3D texture (+1.2 of 41.7), the ground fetch
diet (+0.3), GTAO sample counts (+1.5). Always substitute the material or pass
for a trivial one and measure the difference.

#### Verdict on 60 fps at `high`

**Not reachable on measured levers.** From 82.1 ms the target needs 65.5 ms
removed. Everything look-free lands at 37-45 ms (22-27 fps). Adding every
art-deleting lever — all 11 point lights, the fill/rim/ember directionals, all
coverage AA, shadows at 1024 — lands at 19-28 ms under a *generously additive*
assumption that the data itself refutes: the largest rows sum to 79.1 ms of an
82.1 ms frame, which would leave 3.0 ms to render a sky, 788k triangles and a
post chain. The lights rows and the ground rows measure the same pixels.

The deepest configuration anyone actually measured is **50.0 ms**. Everything
below that is extrapolation.

Two experiments must run before any further planning:
1. **F1 + A2 together.** Lights (ALU per lit fragment) and MSAA (bytes per pass)
   are the two large levers that are plausibly independent, and they were never
   measured in combination. Additive gives ~40 ms; interacting the way sky and
   surround did gives ~55.
2. **A real unlit-surround swap against the untouched baseline.** The recipe
   designed to size the lit-screen-area term silently fell back to an emissive
   hack and left the lighting loop compiled in, so its number is meaningless —
   and this is the single largest unmeasured term in the residual.

### Round 10 — the two decisive experiments, and 60 fps at `low`

#### Lights x MSAA: a 2x2 factorial, because a before/after cannot answer it

`tools/scratch/interact.mjs`, preset `high`, 1600x900, pixelRatio 1, adaptive off,
21 towers + wave 21 live. Each cell on a fresh page; every light-count program
variant pre-warmed so no cell pays a first-use compile.

| | lights disarmed | lights pinned visible |
|---|---|---|
| **MSAA 4x** | 59.6 ms | 83.2 ms |
| **MSAA off** | **40.5 ms** | 59.0 ms |

- light cost with MSAA 4x: **23.6 ms**
- light cost with MSAA off: 18.5 ms
- MSAA cost: 24.2 ms
- **overlap only 5.1 ms — the two levers are very nearly additive.** 83.2 -> 40.5.

R2 (83.2 ms) independently reproduces the fan-out's 82.1 ms baseline, which is a
useful cross-check on the whole apparatus.

**This corrects a claim made in round 9 of this document.** The fx light change
was reported here as 5.7 ms median. It is **23.6 ms**. The round-9 probe emulated
the old behaviour with a `setInterval` setting `light.visible = true`, which loses
the race against `LightPool.update()` inside the rAF callback — so its
"old behaviour" row had the lights off much of the time and understated the gain.
The fan-out's 24.9 ms was right and doubting it was wrong.

Two measurement traps, both hit, both worth remembering:

1. **A one-shot disarm does not hold.** Wave 21 is live and every muzzle flash
   re-arms a slot. The first factorial printed `poolVisible=6/6` in all four
   cells — it never varied the factor it claimed to vary — and produced *negative*
   light costs, which is physically impossible and is the tell.
2. **You cannot win a race with the frame loop; remove its trigger instead.**
   Pinning lights on required `dur = Infinity` so `t >= dur` is never true, not an
   interval fighting `update()`.

The probe now re-reads the condition *after* benching and marks the cell INVALID
if it did not hold for the whole window.

#### Lit off-board decor: 4-9 ms, not 31

A real `MeshBasicMaterial` swap on all 19 `surround` meshes (18 of them lit),
against the untouched baseline: **4.1 ms** in one run, 8.6 ms in another. The
fan-out's 31.2 ms for this was void — its recipe looked for `window.THREE`, did
not find it, and silently fell back to moving albedo into emissive, which leaves
the lighting loop compiled in. Real but modest; the biggest unmeasured term in the
residual turns out to be small.

#### Landed: MSAA confined to the scene render

`MSAAScenePass.js`. Composer buffers single-sampled; scene rendered into a private
4x target and resolved once. Paired in one session against the emulated old path
(`tools/scratch/msaa.mjs`): **58.1 -> 47.2 ms, saves 10.9 ms**, p95 unchanged.
Costs one extra draw call.

Image verified, not assumed (`tools/scratch/msaashots.mjs`): mean luma 103.58 vs
103.51, **delta 0.07** — the copy carries scene-referred linear HDR through
unclamped, so the 2.05 bloom threshold still sees values above 1. A copy that
clamped would have deleted every highlight while still looking plausible.

#### Where the presets now stand

With `AdaptiveResolution` active, as a player gets it:

| preset | median | p95 | scale | verdict |
|---|---|---|---|---|
| ultra | 46.7 ms | 57.3 ms | 0.60 (clamp) | 21 fps |
| high | 29.7 ms | 39.6 ms | 0.60 (clamp) | 34 fps |
| medium | 24.6 ms | 27.1 ms | 0.60 (clamp) | 41 fps |
| **low** | **16.7 ms** | **17.6 ms** | 0.65 | **60 fps, p95 inside 25 ms** |

`low` meets both halves of the target and is not against its clamp, so it has
headroom. `low` over this session: 92 ms -> 31.5 -> 21 -> **16.7**.

The other three are pinned against the `minScale` clamp, which is deliberate:
resolution scaling stops before the image stops being worth looking at. Reaching
60 fps at `high` needs the per-pixel cost to come down, not more pixels removed.

## Rules

1. **A preset must scale the thing that is expensive.** `low` scaled the post
   stack because the post stack is what presets conventionally scale, not
   because anyone had measured it. Before adding a knob to a preset, ablate the
   thing it controls and record the milliseconds here.
2. **Procedural means procedural at load.** Per-fragment procedural detail with
   no texture fetch is the most expensive way to draw anything. If a material
   samples no textures, that is a defect, not a feature.
3. **A number that does not move is not a cost.** Before attributing time to a
   thing, ablate it. 16.7 ms looked like a fixed rendering floor for exactly as
   long as nobody tried deleting the render call.
4. **Paired measurements only.** A number from an earlier round is not a
   baseline for this round (PITFALLS §12). Any before/after claim must come from
   two runs of the same probe on the same build, minutes apart.
5. **Every visual round must report a frame time.** Press F8 in-game, or add
   `?perf` to the URL. A visual change that costs 10 ms is not free just because
   the still frame looks better.

## Instruments

| Tool | Answers |
|---|---|
| `tools/scratch/perf.mjs` | frame time per quality preset, empty vs loaded |
| `tools/scratch/fragbound.mjs` | does cost scale with pixels? (fragment-bound?) |
| `tools/scratch/passcost.mjs` | ms per post pass, ablated individually |
| `tools/scratch/overdraw.mjs` | ms per scene group + transparent-surface inventory |
| `tools/scratch/fixedcost.mjs` | resolution-independent floor, by ablation |
| `src/ui/PerfHud.js` | in-game median/p95/calls/tris (F8) |
