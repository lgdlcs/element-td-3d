# Post-chain ping-pong: where the missing ~44 ms lives

Analysis only. No source edited, no browser run (5 agents share the GPU).

## The claim, restated

`docs/PERF_BUDGET.md:34-50`: per-pass ablation sums to ~46 ms, disabling the whole
chain saves 90 ms. The gap is attributed to "intermediate render-target
ping-pong". That is the right neighbourhood but the wrong noun. The traffic is not
generic ping-pong — it is **4x MSAA RGBA16F ping-pong**, and every fullscreen quad
pass in the chain pays for it twice: once writing 4 samples per pixel, once being
implicitly resolved by three.js.

## Mechanism, from the source

1. `src/render/RenderPipeline.js:92-100` builds the composer's first buffer with
   `samples = this.q.msaa ?? 0` (**4** at ultra/high/medium — `src/core/Config.js:116,139,151`;
   0 at low, `:163`), `type: HalfFloatType`, `depthBuffer: true`.
2. `EffectComposer` constructor does `this.renderTarget2 = renderTarget.clone()`
   (`node_modules/three/examples/jsm/postprocessing/EffectComposer.js:80`), and
   `RenderTarget.copy()` copies `samples` (`node_modules/three/src/core/RenderTarget.js:383`)
   and `depthBuffer`. **Both** ping-pong buffers are therefore 4x multisampled
   RGBA16F with a 4x multisampled depth attachment. Only one of them ever receives
   geometry.
3. Every pass writes into one of those two buffers via `renderer.setRenderTarget(writeBuffer)`
   + a fullscreen quad (`ShaderPass.js:112`, `SMAAPass.js:169`, `OutputPass.js:127`,
   `GTAOPass.js:579`). A fully-covered quad shades once per pixel but **stores to all
   4 samples**: 4 x 8 B = 32 B/px written instead of 8 B.
4. `WebGLRenderer.render()` ends with
   `textures.updateMultisampleRenderTarget(_currentRenderTarget)`
   (`node_modules/three/src/renderers/WebGLRenderer.js:1765-1769`). So **every**
   `renderer.render()` into a multisampled target triggers a full-screen
   `blitFramebuffer` resolve (`webgl/WebGLTextures.js:2307-2345`), and because
   `resolveDepthBuffer` defaults to `true` (`RenderTarget.js:60`) and
   `depthBuffer` is true, the mask includes `DEPTH_BUFFER_BIT`
   (`WebGLTextures.js:2323-2326`) — a 4-sample **depth** resolve on top of the
   colour resolve. Multisample depth resolve is not a native blit on GL ES;
   ANGLE/Metal emulates it, which is exactly the kind of cost that does not appear
   in any shader-instruction count.

### Buffer trace, ultra, one frame

`RenderPass.needsSwap = false` and it renders into **readBuffer** (`RenderPass.js:95,156`).
`UnrealBloomPass.needsSwap = false` and it composites **in place into readBuffer**
(`UnrealBloomPass.js:94,365`). Everything else swaps.

| # | pass | destination | MSAA resolve fired |
|---|---|---|---|
| 1 | RenderPass | readBuffer (MSAA) | yes — the only necessary one |
| 2 | GTAOPass | writeBuffer (MSAA) | yes, waste |
| 3 | GodRaysPass (disabled) | — | none: `EffectComposer.js:234` `continue`s |
| 4 | UnrealBloomPass | readBuffer in place (MSAA) | yes, waste |
| 5 | DepthOfFieldPass | writeBuffer (MSAA) | yes, waste |
| 6 | ShaderPass(grade) | writeBuffer (MSAA) | yes, waste |
| 7 | SMAAPass | `_edgesRT`, `_weightsRT` (both non-MSAA, `SMAAPass.js:37,43`), then writeBuffer (MSAA) | yes, waste |
| 8 | OutputPass | screen (`null`) | no |

**Six full-screen MSAA resolves per frame, five of them pure waste**, plus five
wasted 4-sample colour writes. Bandwidth at 1600x900 (1.44 Mpx), RGBA16F:

- one resolve: colour 32 B read + 8 B write, depth ~16 B read + 4 B write = ~60 B/px = ~86 MB
- six resolves = ~518 MB/frame; five 4-sample writes = 5 x 32 B/px = ~230 MB/frame
- ~750 MB/frame of pure ping-pong traffic. At an achievable ~50 GB/s on an M1 that
  is **~15 ms floor**, and the emulated depth resolve can multiply it.

Without MSAA the same eight passes move 16 B/px each (~23 MB, ~0.5 ms). That is
why the passes are cheap and the chain is not.

### Why per-pass ablation could never see it

"All post off" leaves only `RenderPass` enabled, which then becomes
`isLastEnabledPass` (`EffectComposer.js:236`) and renders with
`renderToScreen = true` → `setRenderTarget(null)` (`RenderPass.js:156`). The scene
goes straight to the **default framebuffer**, which is 8-bit, single-sampled
(`antialias: false`, `RenderPipeline.js:54`) and never resolved. So the whole-chain
ablation removes 6 resolves + 6 MSAA writes + the HalfFloat store as well as the
passes. Disabling one pass removes one resolve. Sum-of-parts vs whole is not a
mystery; it is the MSAA scene target plus the resolve per pass.

### Two things on the brief that are worth zero

- **Removing the disabled `GodRaysPass` from the composer**: exactly 0 ms.
  `EffectComposer.js:234` skips disabled passes before touching a target, and
  `GodRaysPass extends ShaderPass` (`src/render/GodRaysPass.js:121`) so it owns no
  render target. PERF_BUDGET already measured ~0; the source explains why. Do it
  for hygiene, not for time.
- **"Run bloom at half resolution"**: `UnrealBloomPass` already builds its pyramid
  from `w/2` down; the only full-res work is the bright-pass read and the in-place
  additive composite. Its 1.4 ms is not a target. Its *resolve* is.

## Recipes (cheapest look cost first)

1. **`resolveDepthBuffer = false` on both composer buffers.** One line, no
   reallocation needed (the flag is read at resolve time only —
   `WebGLTextures.js:2323`; the `__autoAllocateDepthBuffer` use at
   `WebGLRenderer.js:2857` is the external-texture path, not ours). Nothing in the
   chain samples depth from these buffers: DOF is a tilt-shift on screen-space Y
   (`src/render/DepthOfFieldPass.js:49-62`) and GTAO builds its own depth/normal
   G-buffer. Removes the 4-sample depth resolve from all six resolves. Zero look
   cost. No-op at preset `low` (samples 0).

2. **Three-buffer routing: resolve the MSAA target once, run the chain
   single-sampled.** Keep `renderTarget2` as the MSAA scene target `S`, add two
   `samples: 0, depthBuffer: false` buffers `A`/`B`, pin `readBuffer = S,
   writeBuffer = A` at the top of every frame, and override `swapBuffers` so `S` is
   never a write target again. Result: 1 resolve instead of 6, 1 four-sample write
   instead of 6, same eight passes, same MSAA on geometry, same shaders. This is
   the recipe with the best ms/look ratio and it subsumes most of recipe 1.
   Caveat worth stating: bloom's in-place additive composite lands in a
   single-sample buffer instead of an MSAA renderbuffer that three had just
   invalidated (`WebGLTextures.js:2347-2358` pushes `COLOR_ATTACHMENT0` into the
   read-invalidate list unconditionally). Bit-different, visually a smooth additive
   glow either way — and arguably the more correct of the two.

3. **Fold `OutputPass` into the grade shader.** One fewer full-screen traversal and
   one fewer resolve. `renderer.toneMapping` is *not* applied by scene materials
   when drawing into a render target, so the ACES + exposure + sRGB encode must be
   replicated verbatim in `GradeShader` and `passes.output.enabled = false`.
   Requires `material.needsUpdate = true` **and** a changed
   `customProgramCacheKey` (PITFALLS §11). Look cost: SMAA becomes the last pass
   and therefore runs on display-encoded rather than linear HDR values — a real
   change to edge detection, generally an improvement, but it is a change.

4. **`samples = 0` on both composer buffers (MSAA off, SMAA kept).** The diagnostic
   upper bound on the entire mechanism, and the number that tells you how much of
   the 44 ms recipes 1-3 can ever reach. **Real look cost**: the docblock at
   `RenderPipeline.js:26-45` chose MSAA specifically for thin geometry — tower
   rings, rim runes, grid lines, projectile trails. Those will alias; SMAA cleans
   shader aliasing, not coverage. Run it as a measurement, ship it only as a
   preset knob.

## What to expect

If the mechanism is right, recipe 2 alone should recover the majority of the ~44 ms
gap at ultra/high/medium and nothing at `low` (which already runs `samples: 0` —
and is, note, the one preset measured at ~35 ns/px against medium's ~76). If
recipe 4 recovers no more than recipe 2, MSAA ping-pong was the whole story. If
recipe 4 recovers far more than recipe 2, the remainder is the *scene* render into
a HalfFloat MSAA target rather than the chain, and the next probe is the target
format, not the pass count.
