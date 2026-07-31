# Shadow map — 20.9 ms, and it is mostly NOT the blur

Analysis only. No source edited. Nothing measured (5 agents in parallel; GPU
timings cannot be shared).

## What the rig actually is

- One shadow caster in the whole scene: the key `DirectionalLight`
  (`src/world/Lighting.js:101-121`). `castShadow = true` at :103.
- No CSM anywhere. `csmCascades` appears in `src/core/Config.js:114,137,149,161`
  and **nowhere else in the repo** (`grep -rn csmCascades .` → 4 hits, all
  Config). It is dead config. **"Fewer cascades" is a no-op recipe** and is not
  offered. It is also a §8/§10-class defect in its own right: a preset key that
  no code reads.
- `THREE.VSMShadowMap` set at `src/render/RenderPipeline.js:70`.
- `mapSize` = `quality.shadowMapSize` (`Lighting.js:104`): ultra 4096, high 2048,
  medium 1536, low 1024.
- Ortho frustum ±46 on both axes → **92 × 92 world units** (`Lighting.js:107-113`).
- `shadow.radius = 2.6`, `shadow.blurSamples = 16` (`Lighting.js:117-118`).

## Finding 1 — the penumbra VSM was chosen for does not exist

`shadow.radius` is in **shadow-map texels**, both for the VSM blur
(`node_modules/three/src/renderers/shaders/ShaderLib/vsm.glsl.js`, offsets are
`vec2(uvOffset,0) * radius / resolution`) and for PCF
(`shadowmap_pars_fragment.glsl.js:132`, `radius = shadowRadius * texelSize.x`).

At ultra: 4096 texels over 92 world units = 44.5 texels/unit. A 2.6-texel blur
radius is **0.058 world units** of penumbra on a 2.0-unit grid cell. That is
sub-pixel on screen. At low (1024) it is 0.23 units — still under a tenth of a
cell.

So the "soft contact shadow" justification for VSM is not being delivered at any
preset. VSM here is producing a hard shadow with a slightly anti-aliased edge.
That is a much weaker reason to keep it than the task assumed, and it means the
filter-swap recipes cost far less look than they appear to.

## Finding 2 — under VSM, three.js rasterises every RECEIVER into the depth map

`node_modules/three/src/renderers/webgl/WebGLShadowMap.js:515`:

```js
if ( ( object.castShadow || ( object.receiveShadow && type === VSMShadowMap ) ) && ... )
```

That `type === VSMShadowMap` clause is the whole story. Objects with
`castShadow = false, receiveShadow = true` are drawn into the shadow map anyway,
**only** under VSM. In this scene that set is large and, crucially, includes the
two biggest surfaces in the game:

| object | file:line | castShadow | receiveShadow | frustumCulled |
|---|---|---|---|---|
| `surround-ground` | `Backdrop.js:818-821` | false | **true** | **false** |
| `ground` (board) | `Arena.js:226,241,242` | false | **true** | default |
| `tufts` (InstancedMesh) | `Tufts.js:156-158` | false | **true** | **false** |
| 3 more backdrop meshes | `Backdrop.js:1539,1672,1763` | false | true | — |

Fragment arithmetic at ultra, shadow map 4096² = 16.78 Mtexel:

- `surround-ground` has `frustumCulled = false` and spans far more than 92 units,
  so after clipping it covers **the entire 16.78 M texels**.
- the board ground is 52 × 40 of 92 × 92 = ~25% → **~4.1 M texels**, drawn with
  its own `customDepthMaterial` (`Arena.js:242`, built at
  `GroundMaterial.js:1417-1433`).
- plus tufts, backdrop, towers, rim, monolith, creeps.

That is **> 21 M depth fragments per frame** — roughly 15 full 1600×900 viewports
of extra rasterisation, on a frame that PERF_BUDGET has established is purely
fragment-bound. 20.9 ms for that is entirely unsurprising.

By comparison the blur is 2 × 16.78 M × 16 taps = 537 M texture fetches of RG16F.
Real, but on an M1 (~80 Gtexel/s bilinear) that is ~6-7 ms, i.e. **the minority
share**. Expect the split to be roughly raster 60-70% / blur 30-40%. R1 and R3
are designed to decompose it.

### Finding 2b — a recorded ablation is now wrong

`Arena.js:227-241` records that ground `castShadow` was flipped to true, produced
"a hard sawtooth ~half a cell across… every lane edge", and was set back to false
— replaced by an analytic terrace shadow in the ground shader. Per
`WebGLShadowMap.js:515` the board ground **is still rendered into the depth map**
because `receiveShadow` is true and the type is VSM. So either that sawtooth is
still in the frame and being read as texture, or the analytic shadow is
double-drawing over it. Switching off VSM removes the ground from the depth pass
for real, which by their own ablation is a look *improvement*. This is flagged
as "likely" — the visual phase must confirm it, not me.

## Finding 3 — `PCFSoftShadowMap` does not exist in r185

three 0.185.1 (`node_modules/three/package.json`).
`WebGLProgram.js:344-352`: only `PCFShadowMap → SHADOWMAP_TYPE_PCF` and
`VSMShadowMap → SHADOWMAP_TYPE_VSM` are mapped; everything else falls through to
`SHADOWMAP_TYPE_BASIC`. And `WebGLShadowMap.js:99-104` warns
"PCFSoftShadowMap has been deprecated" and rewrites it to `PCFShadowMap`.
**So the requested VSM → PCFSoft → PCF ladder has only one rung.** The real
ladder is VSM → PCF → BASIC.

Per-fragment cost in the MAIN pass, for the one shadowed light:

| type | taps per lit fragment | source |
|---|---|---|
| VSM | 1 × `texture2D` + Chebyshev | `shadowmap_pars_fragment.glsl.js:174` |
| PCF | 5 × `sampler2DShadow` (hw 4-tap each) | `:137-143` |
| BASIC | 1 × `texture2D` + `step` | `:241-250` |

At 1600×900 that difference is ~5 M extra hardware-filtered taps ≈ 0.07 ms.
**Negligible.** The shadow cost is essentially all map generation, which is
resolution-independent — consistent with `cpubound.mjs` finding clean linearity
in screen pixel area at preset low (where the map is only 1024² and generation
hides in the noise).

## Program-cache compliance (PITFALLS §11)

`WebGLPrograms.js:483` pushes `parameters.shadowMapType` into the program cache
key, and `WebGLShadowMap.js:130-154` traverses the scene setting
`material.needsUpdate = true` on a type change. So three *would* recompile on its
own. But every custom material in this project returns a **constant**
`customProgramCacheKey` (`TowerMaterial.js`, `GroundMaterial.js` ×4,
`Surround.js`, `Backdrop.js`, `Tufts.js`), which is the exact §11 trap, so R2
also bumps every key explicitly and sets `needsUpdate`. Belt and braces.

## Runtime-patch gotcha: `mapSize` alone does nothing

`WebGLShadowMap.js:203` recreates the render target only when
`shadow.map === null || typeChanged`. Writing `shadow.mapSize.set(n,n)` at
runtime changes the *viewport* three uses (`:178`, `_viewportSize`) but leaves a
4096² render target allocated, so you get a 1024² image in the corner of a 4096²
target and the blur (`:391`, `mapPass` sized from `_shadowMapSize`) reads the
wrong resolution. R3 therefore disposes and nulls `shadow.map`,
`shadow.map.depthTexture` and `shadow.mapPass`. This is the same idiom
`tools/scratch/shadow-sweep.mjs` already uses for type changes.

## `blurSamples` needs no manual invalidation

`WebGLShadowMap.js:379-387` compares `shadowMaterialVertical.defines.VSM_SAMPLES`
against `shadow.blurSamples` every frame and sets `needsUpdate` on its own two
internal blur materials. R1 is a one-line assignment and it really takes effect.

Sample spacing at `radius = 2.6`, `uvStride = 2/(n-1)` (`vsm.glsl.js`):
16 samples → 0.35 texel apart (3× oversampled, wasted work);
6 samples → 1.04 texel apart (≈ Nyquist for a `LinearFilter` source — clean);
4 samples → 1.73 texel apart (a comb; slight ripple on shadow edges).
**6 is the honest zero-look-cost value.**

## `autoUpdate = false` is a median-only trick and must be labelled as one

The gate is `WebGLShadowMap.js:95`
(`if (scope.autoUpdate === false && scope.needsUpdate === false) return;`).
What genuinely moves per frame:

- the key light drifts `sin(t*0.017)*2.4` units (`Lighting.js:216-221`) — that is
  2.4 units over ~370 s. Invisible if frozen.
- creeps (`Creeps.js:224` castShadow) and tower heads. Small, and the board is busy.

So the *still-frame* look cost of updating every 4th frame is zero and the motion
cost is a creep shadow lagging ~0.13 world units. Cheap. **But**: PERF_BUDGET's
target is "16.6 ms median AND 25 ms p95", and amortisation moves the median while
leaving one frame in four carrying the full 20.9 ms. It improves the median and
does nothing for the p95 — it converts a slow game into a stuttering game. It is
listed last for that reason, and it is most useful as an *instrument*: the median
it reports is "frame time with zero shadow-map generation", which combined with
R1/R3 decomposes raster vs blur.

## Recipes, cheapest look cost first

1. **`blurSamples` 16 → 6** — zero look cost, cuts 62% of the blur only.
2. **VSM → PCF** — low look cost (probably an improvement, Finding 2b); cuts both
   blur passes AND every `receiveShadow`-only depth draw, i.e. the ~17 M
   texels of `surround-ground`. Expected the largest single win.
3. **4096 → 1024** — medium look cost, but it is the *shipped* low-preset value,
   so the look is already approved somewhere. 16× area cut on raster + blur.
4. **`autoUpdate = false`, invalidate every 4th frame** — median-only, p95
   unchanged. Instrument as much as fix.

Not offered: fewer cascades (dead config, Finding 1 of the grep);
`BasicShadowMap` (removes the same generation work as PCF but adds hard
pixel-staircase edges with no filtering at all — strictly worse look than PCF for
the same saving, so PCF dominates it).
