# GTAOPass — 35.3 ms at ultra. What is actually inside that number.

Analysis only. Nothing measured here (5 agents share the GPU); all numbers quoted
are from `docs/PERF_BUDGET.md`.

## What one GTAO pass does per frame

`node_modules/three/examples/jsm/postprocessing/GTAOPass.js:498-588` — five GPU
jobs, all at FULL drawing-buffer resolution (`GTAOPass.js:143-144`,
`:317-322`, sized by `EffectComposer.addPass` -> `pass.setSize(w*dpr, h*dpr)`,
`EffectComposer.js:152`):

1. **G-buffer prepass** (`GTAOPass.js:502-508`): `scene.overrideMaterial =
   MeshNormalMaterial` then `renderer.render(scene, camera)`
   (`GTAOPass.js:641-643`). A second full scene traversal + draw of every mesh
   into a half-float normal RT with a depth texture.
2. **AO shader** (`:517`), full-res fullscreen quad.
3. **Poisson denoise** (`:522`), full-res fullscreen quad.
4. **Copy of readBuffer into writeBuffer** (`:573-575`) — a pure full-res
   half-float blit.
5. **Blend AO over it** (`:577-579`) — another full-res pass.

### The unattributed item is a SECOND SHADOW MAP RENDER

`renderer.render()` calls `shadowMap.render(shadowsArray, scene, camera)`
unconditionally (`three.module.js:17702`), and `WebGLShadowMap.render` only
early-outs when `autoUpdate === false && needsUpdate === false`
(`three.module.js:9143-9144`). Nothing in this project touches
`renderer.shadowMap.autoUpdate` (grep over `src/`: no hits), and
`RenderPipeline.js:69-70` enables VSM.

So every frame renders the key light's shadow map **twice**: once for
`RenderPass`, once again inside the GTAO prepass. The shadow render ignores
`scene.overrideMaterial` (it uses its own depth materials), so it is the full
job: all casters, plus the two VSM blur passes at `blurSamples = 16`
(`src/world/Lighting.js:104-118`, one shadow-casting DirectionalLight,
`shadow.radius 2.6`).

`docs/PERF_BUDGET.md` records "shadow map ~20.9 ms", and `shadow-probe.mjs:85`
obtained it with `r.shadowMap.enabled = false` — which kills BOTH renders. So
~10 ms of the 35.3 ms attributed to GTAO is very likely a duplicate shadow map,
removable with **zero** look cost. This is the one recipe here that changes no
pixels.

### The AO shader's fetch count

`GTAOShader.js:202-203`: `DIRECTIONS = SAMPLES < 30 ? 3 : 5`, `STEPS =
ceil(SAMPLES/DIRECTIONS)`. The inner loop fetches `tDepth` twice per step
(`:222`, `:231`, via `getSceneUvAndDepth` -> `getDepth` -> `texture2D(tDepth)`,
`:104`, `:297-301`).

| preset | ssaoSamples (`Config.js:115/138/150`) | DIRECTIONS x STEPS | dependent depth fetches / px |
|---|---|---|---|
| ultra | 20 | 3 x 7 | 42 |
| high | 12 | 3 x 4 | 24 |
| medium | 8 | 3 x 3 | 18 |

Plus one normal, one depth, one noise fetch. Denoise adds `SAMPLES = 8`
(`RenderPipeline.js:167`) x (diffuse + normal + depth) = 24 more
(`PoissonDenoiseShader.js:187`). So the AO stage alone is ~45 scattered texture
reads per pixel and the denoise ~25, at 1600x900xdpr. That is a bandwidth
profile, not an ALU one — consistent with the established fact that this frame is
fragment/bandwidth bound at ~12 ns/px.

Note the quantisation: `samples` only matters in multiples of 3. 20 and 21 both
give STEPS = 7; 9 -> 3, 6 -> 2. Lowering `samples` without lowering `radius`
moves the surviving steps OUTWARD (step j sits at
`pow((j+1)/STEPS, distanceExponent) * radius`, `GTAOShader.js:220`), which is
exactly the failure mode documented in `RenderPipeline.js:124-143`: the near-
contact samples disappear and the contact darkening the pass exists for goes with
them. If samples drop for real, `radius` must drop with them — do NOT ship a
samples cut without re-shooting `tools/scratch/r7-ao-sweep.mjs`.

### Budget guess (to be confirmed by the recipes, not trusted)

duplicate shadow ~10 | prepass geometry ~2 | AO shader ~12 | denoise ~5 |
copy+blend ~3-6. Sums to ~35.

## Recipes, cheapest look-cost first

1. **skip the duplicate shadow render** — no visual change at all.
2. **half-res AO chain** — softer AO, mild bilinear halo at silhouettes. Cuts
   stages 1(fragment)/2/3 by 4x; stages 4/5 stay full-res.
3. **samples 20 -> 6, pd 8 -> 4** — real look risk (see the radius coupling
   above). Measure it, but treat a win here as needing an AO-coverage re-check.
4. **freeze the G-buffer (`_renderGBuffer = false`)** — DIAGNOSTIC ONLY. Isolates
   the whole prepass; subtracting recipe 1 from it gives the geometry share.
   Visually the AO lags reality (creeps, camera) so it is not shippable.

Upper bound needs no recipe: it is already measured at 35.3 ms (whole pass off),
and turning the pass off is the Round 7 regression — towers read as stickers
(`RenderPipeline.js:113-122`).

None of 1, 2, 4 touch shader source, so no cache-key work is needed. Recipe 3
does change defines; it goes through `updateGtaoMaterial` /
`updatePdMaterial`, which set `needsUpdate` (`GTAOPass.js:407-411`, `:477-482`),
and the recipe additionally installs `customProgramCacheKey` per PITFALLS §11.
