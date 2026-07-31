# Lever: lit pixels & dynamic light count

Analysis only. No source touched. Every claim below is a source citation, not a
measurement — the numbers in the "predicted" columns are extrapolations from the
one measured constant we have (`~6 ms per dynamic light`, PERF_BUDGET.md) and are
labelled as predictions.

## 1. The complete light census (this has never been written down)

Enumerated by grepping `src/` for every three.js light constructor. There are
**exactly six construction sites**.

| # | Light | Type | Shadows | Where |
|---|---|---|---|---|
| 1 | `key` | DirectionalLight 0xffdcaa @ 34.0 | **YES** (VSM, 4096 at ultra) | `src/world/Lighting.js:101-121` |
| 2 | `fill` | DirectionalLight 0x9fbdf2 @ 0.85 | no | `src/world/Lighting.js:131-134` |
| 3 | `rim` | DirectionalLight 0x63b0ff @ ~1.70 | no | `src/world/Lighting.js:141-144` |
| 4 | `ember` | DirectionalLight 0xff9a48 @ 1.10 | no | `src/world/Lighting.js:150-153` |
| 5 | `hemi` | HemisphereLight @ 1.25 | n/a | `src/world/Lighting.js:168-170` |
| 6 | `amb` | AmbientLight @ 0.35 | n/a | `src/world/Lighting.js:178-180` |
| 7-8 | portal gates | **2x PointLight** @ 16, dist 20, decay 2 | no | `src/world/Arena.js:991-993`, created twice from `#buildPortals` at `src/world/Arena.js:773-774` |
| 9-14 | fx pool | **6x PointLight** (4 flash + 2 ember) | no (`castShadow = false`) | `src/fx/EffectSystem.js:86` -> `LightPool` ctor `src/fx/EffectSystem.js:1075-1090` |
| 15+ | tower pool | **`quality.towerLights` x PointLight** @ dist 20, decay 2 | no | `src/game/towers/TowerBatch.js:120-129`, count from `src/core/Config.js:133/145/157/172` = 4 / 3 / 2 / 0 |

Totals actually submitted to `WebGLLights` every frame:

| preset | point | directional | hemi | ambient | **lighting-loop iterations** |
|---|---|---|---|---|---|
| ultra | 12 | 4 | 1 | 1 | **16** |
| high | 11 | 4 | 1 | 1 | 15 |
| medium | 10 | 4 | 1 | 1 | 14 |
| low | **8** | 4 | 1 | 1 | **12** |

`low` — the preset that is supposed to be the safety net — still shades every lit
pixel with **12** light iterations, because it only zeroes the tower pool. The 6
fx lights and the 2 portal lights are not gated by any preset knob anywhere.

## 2. The finding: the 8 unaudited point lights are structurally invisible to
every ablation done so far

`PERF_BUDGET.md` records "fx costs 0" and "creeps cost 0", measured by
`tools/scratch/overdraw.mjs:68-84`, which does `g.fx.group.visible = false`.

The fx `LightPool` lights are **not in `fx.group`**. `EffectSystem` builds
`this.group` at `src/fx/EffectSystem.js:111-113` (`group.name = 'fx'`), but
`LightPool` adds its lights straight to the scene: `scene.add(l)` at
`src/fx/EffectSystem.js:1081` and `:1087`. So hiding `fx.group` removed the
ribbons, decals and particles and left all six point lights in the frame.

"fx costs 0" is therefore true of fx *geometry* and says nothing about the six
point lights fx owns. The same hole applies to the two portal lights: they live
inside the portal groups under `arena.group` (`src/world/Arena.js:993` ->
`group.add(light)`), so they were only ever removed by the `arena` ablation,
which hit the vsync clamp at 16.7 ms and produced a lower bound, not a value
(PERF_BUDGET, "Corrected scene attribution").

Note the comment already in the source at `src/fx/EffectSystem.js:78-84`: *"this
scene already carries 16 of them"*. Someone counted 16 point lights (8 tower +
6 fx + 2 portal) and wrote it down as a reason not to add more, but never
proposed removing the ones that were already there.

### Mechanism, in terms of what the GPU does per pixel

`MeshStandardMaterial` compiles `NUM_POINT_LIGHTS`/`NUM_DIR_LIGHTS` as
`#define`d loop bounds. Each point-light iteration is:
`getPointLightInfo` (distance, inverse-square + decay), then
`RE_Direct` = `BRDF_Lambert` + **`BRDF_GGX`** (a full V-GGX-SmithCorrelated +
D_GGX + F_Schlick). That is ~40-60 ALU ops and several transcendentals, executed
for **every lit fragment in the frame**, regardless of whether the light is
20 units away or has `intensity === 0`.

Intensity zero is the important part. `LightPool.update`
(`src/fx/EffectSystem.js:1138-1153`) sets `light.intensity = 0` when a slot is
idle, and idle is the steady state — the lights are never removed
(`src/fx/EffectSystem.js:1069-1071`: *"Every light is created in the constructor
and never added or removed, so NUM_POINT_LIGHTS is a constant"*). three.js pushes
a light to the lights list based on `object.visible`, not on intensity
(`node_modules/three/build/three.module.js:17826`, `projectObject`:
`if ( object.visible === false ) return;` before the `object.isLight` branch).
So a permanently-zero light costs its full per-pixel GGX on every frame of the
game. **On a typical frame, 4 of the 6 fx lights and often all 6 are at
intensity 0 and are still fully evaluated.**

Predicted, at the measured ~6 ms/light: the 6 fx lights are worth **~36 ms** and
cost approximately nothing visually on a frame with no explosion in it. This is
the single cheapest-look-cost millisecond in the whole budget if it holds.

### Why the light loop, not shader ALU, is the consistent explanation

It also retro-explains the three false hypotheses. `Sky.js` covers 100% of the
frame (`SphereGeometry(500)`, `BackSide`, `renderOrder = -1000`, `depthWrite:
true` — `src/world/env/Sky.js:25-32, 344-345`) and evaluates ~340 hashes, and
swapping it out saved 0.5 ms. Sky is a raw `ShaderMaterial`: **it has no
lighting loop.** Full-frame unlit procedural noise is nearly free here. Every
expensive surface in this game is expensive in proportion to (its screen area) x
(the light count), not to its own instruction count. That is a single mechanism
that fits all of: sky free, TowerMaterial bake free, hiding any large lit object
"saving" 30-40 ms, and cost being linear in pixel area.

## 3. Ablation shape: automatic recompilation, no `needsUpdate` needed here

Changing light **count** is the one shader change in this codebase that does not
need the PITFALLS §11 dance. `WebGLRenderer.setProgram` compares
`materialProperties.lightsStateVersion` against `lights.state.version` and
recompiles when it differs
(`node_modules/three/build/three.module.js:18191`, `:18232`, `:18386`). Setting
`light.visible = false` bumps the lights-state version, so every lit material
recompiles with the smaller `NUM_POINT_LIGHTS` on the next frame, for free.
Recipes 1-3 rely on this. Recipe 4 swaps a material and therefore *does* set
`needsUpdate` and vary `customProgramCacheKey`.

`visible = false` is also stable across frames: nothing re-asserts it.
`LightPool.update` only writes `intensity` (`src/fx/EffectSystem.js:1138-1153`);
`TowerBatch` sets `l.visible = true` once in the constructor
(`src/game/towers/TowerBatch.js:126`) and thereafter only writes
`position`/`color`/`intensity`/`distance`
(`src/game/towers/TowerBatch.js:508-521`); `Lighting.update` writes only
`key.position` and `rim.intensity` (`src/world/Lighting.js:212-225`).

## 4. Lit screen area: the surround

`Backdrop` builds the surround as `group.name = 'surround'`
(`src/world/env/Backdrop.js:691-692`), reachable at
`window.__game.environment.backdrop.group`. Its members:

- `surround-ground`, one large heightfield mesh, `makeSurroundMaterial`
  (`src/world/env/Backdrop.js:784-823`)
- 13 instanced/merged prop families (`boulder`, `outcrop`, `spire`, `growth`,
  `ruin`, `wall`, `slab`, `kerb`, `house`, `conifer`, `crate`, `barrel`, `lamp`,
  `fence`) each with its own `makeSurroundMaterial`
  (`src/world/env/Backdrop.js:1285-1372`, added at `:1447`)
- `surround-scrub` (`:1502-1555`), `surround-road` (`:1649-1679`),
  `surround-water` (`MeshStandardMaterial`, `:1730-1770`)
- `surround-window` — the only unlit one already (`MeshBasicMaterial`, `:1457`)

`makeSurroundMaterial` returns a real `MeshStandardMaterial`
(`src/world/env/Surround.js:446`) with a world-space procedural shader injected
via `onBeforeCompile` (`:479`) and `customProgramCacheKey = () =>
`surround-${name}`` (`:825`). The file states the intent explicitly at
`src/world/env/Surround.js:36-39`: *"Everything uses MeshStandardMaterial so it
receives the same key/fill/rim rig ... 'Same fidelity as the play area' ... is
achievable by being lit by the same lights."*

That is a deliberate art decision and it is also the decision that buys the
surround a full 16-iteration lighting loop on what the same file measures as the
majority of the frame: `src/world/env/Surround.js:11-17` computes that ground at
board level *"fills the frame all the way to the top edge"*. The board is
52 x 40 in a frame the camera fills to `frameFillX 0.88`
(`src/core/Config.js:78`), so the surround is roughly the frame minus the board
— call it 50-65% of all lit pixels, and it is drawn as pure overdraw on top of
sky, which already shaded 100% of them.

## 5. The prior non-additive result (sky alone free, surround alone free, both
together 10 ms)

I cannot explain it from the source and I am not going to pretend to. What I can
say is that the draw order rules out the obvious occlusion story: sky has
`renderOrder = -1000` and `depthWrite: true` (`src/world/env/Sky.js:32, 345`),
so sky shades every pixel *first* and surround overdraws it. Removing either one
cannot make the other cover pixels it was not already covering, so the two costs
should be additive. The most likely mundane explanation is that both individual
readings were at or near the 60 fps vsync clamp and were therefore lower bounds
being read as values — exactly the failure PERF_BUDGET.md rule 3 warns about.
The recipes below are built **cumulatively** so that a stage can only ever be
compared against the stage before it on the same run, which makes this class of
error impossible to repeat. Recipe 4's own delta (R4 minus R3) is the surround
number, taken with the light count already collapsed so nothing is hiding
behind the clamp.

## 6. Recipes, cheapest look cost first

Each recipe returns a census object so the run is self-documenting; a run whose
returned `after` counts do not match expectation should be discarded rather than
recorded.

**R1 — fx pool point lights off (6 lights).** Look cost: on a frame with no
explosion landing, *nothing*. During an explosion, the flash no longer tints
tower faces or cobbles; the additive quads, ribbons and decals are untouched
because they are separate objects in `fx.group`. Predicted ~36 ms.

**R2 — R1 + portal lights + tower pool (all point lights off).** Look cost: the
two gates lose their coloured spill onto the surrounding stonework (the vortex
cone, ground scar, rings and motes at `src/world/Arena.js:886-989` all remain,
so the gates still glow — they just stop lighting their neighbours). Towers lose
neighbour spill; each keeps its own additive ground-glow decal, which
`src/core/Config.js:169-171` already records as costing nothing. Predicted a
further ~12 ms at ultra / ~36 ms total for R2's own 6.

**R3 — R2 + fill/rim/ember directionals off.** Keeps key (and its shadows),
hemi, ambient. Look cost: real and visible. Shadow interiors go warm-neutral
instead of blue, silhouettes lose their cool rim separation, and the up-light
that makes the platform rim and shard undersides read amber is gone — i.e. it
undoes the specific things `src/world/Lighting.js:47-55` and `:123-154` were
written to achieve. Predicted ~18 ms. Worth measuring precisely because 3 of the
6 directional/ambient terms are decorative and 3 of them are structural.

**R4 — R3 + surround unlit.** Swaps all `surround-*` MeshStandardMaterials for
flat `MeshBasicMaterial` carrying each material's own `uMid` colour. Look cost:
**this deletes the surround art.** No procedural albedo, no slope-driven rock,
no shadows, no fog/haze term, no key. It is a measurement, and if it is large it
argues for a *cheap lit* surround (a hand-rolled 1-2 light shader, or
MeshLambert), not for shipping this. Reported honestly as such.

### Follow-up measurements this deliberately does not spend a recipe on

- key light alone (it is the shadow caster; its cost is entangled with the
  20.9 ms shadow map and needs its own paired run)
- MeshLambert instead of MeshBasic for the surround — the interesting middle
  point, which isolates GGX + IBL from the loop itself
- `scene.environment = null` (`src/world/Lighting.js:198`,
  `environmentIntensity = 1.05` at `:205`) — PMREM `textureCubeUV` is several
  dependent texture fetches per lit fragment on every standard material in the
  frame, and it is not in anybody's census either
