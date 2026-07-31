# Lever: MSAA + composer render-target format / bandwidth

Analysis only. No source under `src/` was touched. Nothing was measured (per the
brief: no browser runs while other agents hold the GPU).

## What the code actually does

`src/render/RenderPipeline.js:92-101` builds ONE render target and hands it to
`EffectComposer`:

```js
const samples = ... (this.q.msaa ?? 0);            // 4 at ultra/high/medium, 0 at low
const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
  type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace,
  samples, depthBuffer: true,
});
this.composer = new EffectComposer(this.renderer, rt);
```

Presets: `src/core/Config.js:116` (ultra `msaa: 4`), `:139` (high 4), `:151`
(medium 4), `:163` (low 0). `pixelRatioCap` 2 / 1.75 / 1.5 / 1 at
`Config.js:134,146,158,173`.

Three facts follow from three's own source, and together they are the whole
hypothesis:

1. **BOTH ping-pong buffers are multisampled.**
   `EffectComposer` constructor: `this.renderTarget1 = renderTarget;
   this.renderTarget2 = renderTarget.clone();`
   (`node_modules/three/examples/jsm/postprocessing/EffectComposer.js:77-79`)
   and `RenderTarget.copy()` copies `samples`
   (`node_modules/three/src/core/RenderTarget.js:381`). So rt2 is `samples: 4`
   too. MSAA is not "the scene target"; it is *the entire post chain's storage*.

2. **Every pass triggers a full-resolution MSAA resolve.** Each `ShaderPass`
   calls `renderer.setRenderTarget(writeBuffer)` then renders a fullscreen quad
   through `renderer.render()`
   (`ShaderPass.js` render body), and `WebGLRenderer.js:1765-1770` runs
   `textures.updateMultisampleRenderTarget(_currentRenderTarget)` at the end of
   **every** `renderer.render()` into a non-null target. That function
   (`WebGLTextures.js:2278-2342`) does an explicit
   `_gl.blitFramebuffer(... COLOR_BUFFER_BIT | DEPTH_BUFFER_BIT ...)` from the
   multisampled renderbuffer FBO into the single-sample texture FBO — unless
   `WEBGL_multisampled_render_to_texture` is available (`:2410`), which on
   Chrome/ANGLE-Metal it is not. Each recipe below returns that extension check
   so the assumption is verified rather than believed.

   Passes that write into a multisampled composer buffer at ultra:
   RenderPass, GTAO composite, bloom composite, DOF, grade, SMAA — six.
   (`OutputPass` is last, `renderToScreen`, target `null`: no MSAA.)
   So the frame pays **six MSAA stores + six explicit resolve blits**, five of
   them for fullscreen quads where multisampling cannot improve anything: a
   fully-covered quad has one fragment broadcast to four identical samples.

3. **Depth is resolved too, and nobody reads it.** `resolveDepthBuffer`
   defaults `true` (`RenderTarget.js:60`) and `depthBuffer: true` is explicit,
   so `DEPTH_BUFFER_BIT` is in the blit mask (`WebGLTextures.js:2323-2328`) on
   all six passes. Nothing in this pipeline samples the composer target's depth:
   GTAO builds its own depth+normal G-buffer
   (`GTAOPass.js:143,317-320`, its targets are `samples: 0`, i.e. GTAO's 35.3 ms
   is *not* MSAA), and `DepthOfFieldPass.js:7-14` documents that it deliberately
   uses screen-space Y instead of depth. Setting `resolveDepthBuffer = false`
   also makes three emit `invalidateFramebuffer` on the depth attachment
   (`WebGLTextures.js:2351-2356, 2388-2394`), which is how you tell a tiler not
   to store MS depth at all.

## Arithmetic, stated up front so it can be falsified

At 3200x1800 (5.76 Mpx), RGBA16F = 8 B/px/sample, D24 = 4 B/px/sample.

Per pass into a `samples: 4` target, versus the same pass into `samples: 0`:

| traffic | 4x | 0x |
|---|---|---|
| colour store | 32 B/px | 8 |
| colour resolve (read + write) | 32 + 8 | 0 |
| depth clear/store | 16 | 4 |
| depth resolve (read + write) | 16 + 4 | 0 |
| **total** | **108 B/px** | **12** |

Six passes: ~650 B/px of extra traffic, ~3.7 GB/frame at 3200x1800. M1 has
~68 GB/s, so **~9.5 ns/px, ~55 ms at 3200x1800 / ~5 ms at 960x540**.
The depth half of it alone is ~215 B/px => ~3.2 ns/px (~18 ms at 3200x1800).

Honest reading of that number: ~9.5 ns/px against a measured 127 ns/px at ultra
is **~7% of the frame** — it is resolution-scaling, linear-in-area cost, which
matches the established fact that the frame is linear in pixel area, but it is
NOT the 20-100x anomaly. It becomes a headline number only in absolute ms at
pixelRatio 2, where the whole frame is 160 ms. Two ways it could be much bigger
than the arithmetic, both plausible and both only settleable by measuring:
MSAA storage typically defeats the framebuffer compression the GPU applies to
single-sample targets, and an explicit cross-FBO blit forbids on-tile resolve
entirely on an Apple tiler. This is exactly the shape of the "sum of passes 46 ms
but killing the chain saves 90 ms" gap already in `docs/PERF_BUDGET.md` — MSAA
storage + resolve is a concrete mechanism for that missing ~44 ms, and it is
measurable in isolation, which is what the recipes do.

## MEASUREMENT TRAP — the control run must pin the resolution

`AdaptiveResolution` is constructed enabled (`RenderPipeline.js:245`,
`AdaptiveResolution.js:55`) and holds 16.6 ms by trading pixels. **Any recipe
that makes the frame cheaper will be absorbed by the controller and read as "no
change".** Every recipe below therefore starts with:

```js
p.adaptive.enabled = false;
r.setPixelRatio(p.adaptive.maxScale);   // = the preset cap captured at build
p.resize();
```

`maxScale` is `renderer.getPixelRatio()` at construction time
(`AdaptiveResolution.js:53`), i.e. the preset's cap, so this restores the
un-degraded resolution deterministically. **The baseline/control run must
execute those three lines and nothing else**, or the A/B compares different
pixel counts and is worthless.

## Why the targets must be rebuilt, not mutated

`renderer.setRenderTarget()` only calls `textures.setupRenderTarget()` when
`__webglFramebuffer === undefined`, so assigning `rt.samples = 0` or
`rt.texture.type = ...` on a live target changes nothing on the GL side —
the silent-no-op failure mode of PITFALLS §11, in render-target form. The
recipes go through `composer.reset(newTarget)`
(`EffectComposer.js:283-303`), which disposes rt1/rt2 and re-clones from the
target passed in; the clone is taken *before* the dispose and is structural
(`RenderTarget.js:340-388`), so no GPU resource is shared. `reset()` does not
resize, hence the `p.resize()` first — the clone then already carries the
correct effective size.

**No recipe here changes any shader source.** Render-target sample count and
texture type are FBO/allocation state, not `#define`s, and no material in the
chain branches on them, so there is no program to invalidate and no
`customProgramCacheKey` to vary. The equivalent hazard for this lever is the
FBO-cache no-op above, which `composer.reset()` handles. (Recipe 2 does flip
`copyPass.material.depthTest/depthWrite`, and sets `needsUpdate` there, since
those are material state on a live program.)

## Recipes, cheapest look cost first

1. **`resolveDepthBuffer = false` on both composer buffers.** Zero look cost,
   provably: no pass samples that depth. Drops `DEPTH_BUFFER_BIT` from six
   resolve blits and enables the depth invalidate. Predicted ~3.2 ns/px
   (~18 ms at 3200x1800, ~1.6 ms at 960x540). No rebuild needed — the flag is
   read at resolve time. **If this reads zero, the resolve path is not the cost
   and recipes 3/4 will be small too.**
2. **Confine MSAA to the scene render.** Composer ping-pong buffers become
   `samples: 0`; `RenderPass` is redirected into a private `samples: 4` target
   and copied in via `composer.copyPass`. Geometric AA on rings/runes/grid lines
   is preserved exactly (still 4 coverage samples, still resolved intra-frame),
   so this is the zero-look-cost version of the whole lever, at the price of one
   extra fullscreen copy (~16 B/px). Predicted ~7.9 ns/px (5 of the 6 passes).
   This is the recipe that should actually ship if the lever is real.
3. **`samples: 4 -> 0` everywhere.** The total MSAA cost, and the ceiling for
   recipe 2. Predicted ~9.5 ns/px (~55 ms at 3200x1800). Look cost is REAL:
   SMAA becomes the sole AA, and `RenderPipeline.js:26-45` records that MSAA was
   chosen specifically because SMAA alone does not fix thin geometry — tower
   rings, rim runes, grid lines, projectile trails will crawl in motion. If
   recipe 3 is large and recipe 2 captures most of it, ship 2 and never ship 3.
   `samples: 2` is the obvious interpolation (roughly half the traffic, edge
   quality between the two) and is a one-character variant of recipe 3 if a
   middle point is wanted.
4. **`HalfFloat -> UnsignedByte` (RGBA16F -> RGBA8), samples left at 4.**
   Isolates format from sample count: halves colour traffic everywhere. Look
   cost is SEVERE and it is a diagnostic, not a candidate — the chain is
   scene-referred linear with values above 1.0 by design (bloom threshold 2.05
   at `RenderPipeline.js:206`/Config, and the grade's shoulder at 0.60 exists to
   roll off values ACES would clip). Clamping to [0,1] kills the bloom brightpass
   outright and bands the graded gradients. Run it to attribute bandwidth, then
   throw it away.

Recipes 2-4 reallocate render targets; the first few frames after
`composer.reset()` pay the allocation, so discard a warm-up window before taking
the median of ~140 rAF intervals. And per `docs/PERF_BUDGET.md`, a reading of
16.7 ms means ">= 60 fps", not "16.7 ms of work" — if a recipe lands there the
saving is a lower bound only.
