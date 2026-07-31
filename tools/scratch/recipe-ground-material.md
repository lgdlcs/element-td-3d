# Lever: GroundMaterial — 29 fragment texture fetches x up to 16x anisotropy

## What the source actually says

`src/world/terrain/GroundMaterial.js:265` `createGroundMaterial()` is a
`MeshStandardMaterial` whose `<map_fragment>` chunk is replaced by ~950 lines of
compositing (`:351`-`:1342`). Every three.js map chunk that would normally do a
fetch is hijacked instead:

- `<roughnessmap_fragment>` -> `gRough` (`:1355`)
- `<normal_fragment_maps>` -> `gMapN` (`:1398`)
- `<aomap_fragment>` -> `gAO` (`:1400`)
- `<emissivemap_fragment>` -> `gEmissive` (`:1399`)

so the four textures declared on the constructor (`:266`-`:276`) are never
sampled by the stock chunks. All fetches are explicit. Counted from
`grep -n texture2D`:

| source | fetches | lines |
|---|---|---|
| `uMacro` mac0..mac4 | 5 | 358, 359, 360, 367, 372 |
| `uMask` mk + 4 gradient taps | 5 | 379, 383-386 |
| `uMask` drop-shadow march (`s < 4`) | 4 | 900-905 |
| `uFlagA`/`uFlagN` x 3 bombing variants | 6 | 441-446 |
| `uRoadA`/`uRoadN` | 2 | 477, 478 |
| `uDecayA`/`uDecayN` rubble islands | 2 | 537, 538 |
| `uDecayA`/`uDecayN` decayed rim | 2 | 550, 551 |
| `uDecayA` drift | 1 | 725 |
| `uDecayA` perimeter soil | 1 | 781 |
| **total** | **28** | |

Plus 2 more in the vertex shader (`KERB_GLSL:35,37`), which also runs on the
`customDepthMaterial` twin (`:1417`) and on the (hidden) grid overlay.

The `if (wRoad > 0.004)` / `if (wRubble > ...)` / `if (drift > ...)` /
`if (soil > ...)` / `if (wallW > ...)` guards do not help: they are per-fragment
branches over a smooth field, so at every zone boundary the whole wave takes
both sides, and on a 1600x900 ground plane a large fraction of waves straddle at
least one boundary. Budget for close to the unconditional count.

## The multiplier nobody has counted: anisotropy

This is the part that makes the fetch count matter, and it is not the
"instruction counting" mistake that PERF_BUDGET.md records twice — it is a
sampler configuration, not ALU.

Every ground map goes through `packedTexture()`
(`src/assets/ProceduralTextures.js:392`), which sets:

```
tex.minFilter = THREE.LinearMipmapLinearFilter;   // :396  trilinear
tex.generateMipmaps = true;                       // :397
tex.anisotropy = aniso;                           // :399
```

and `aniso` is threaded from the quality preset:
`RenderPipeline.js:74` -> `new Arena(scene, grid, this.q.anisotropy)` ->
`Arena.js:102` -> `makeFlagstoneMaps/RoadMaps/DecayMaps/MacroMaps` (`:114`-`:117`).
`src/core/Config.js` sets it to **16 / 8 / 4 / 2** for ultra / high / medium /
low (`:134, :146, :158, :173`).

Trilinear = 8 texel reads. Anisotropic 16 = up to 16 of those. So one
`texture2D` on a ground map costs up to **128 texel reads** at ultra and 16 at
low. The board is a near-ground plane viewed at ~55 degrees, i.e. exactly the
geometry that saturates the anisotropy ratio over the far half of the plate.

19 of the 28 fetches are on aniso-enabled mipmapped maps (macro 5, flag 6,
road 2, decay 6). Worst case:

- ultra: 19 x 128 = **~2400 texel reads per ground fragment**
- low:   19 x 16  = ~300

The mask taps (10) are cheap: `PathMask.js:41-42` sets Linear/Linear with no
mipmaps and no anisotropy.

The measured per-preset per-pixel cost is **127 / 92 / 76 / 35 ns/px** for
anisotropy **16 / 8 / 4 / 2**. That is monotone in anisotropy and it is the only
knob in the preset table that varies by exactly the same 8x range as the cost.
It is not proof — presets also move post, pixelRatioCap and tri count — but it
is the strongest unexplained correlation in PERF_BUDGET.md, and nothing in the
"three false hypotheses" list touches texture bandwidth. Both false hypotheses
were about **ALU** (fbm hashes, value noise); this is **texture units and L1/L2
bandwidth**, a different pipe.

## Why the first recipe is still a substitution

PERF_BUDGET.md rule: substitute, do not count. Recipe 1 replaces the ground
material with a `ShaderMaterial` that keeps the **exact** vertex displacement
(the same `terrainSink` code, the same uniforms) so the terrace silhouette,
depth buffer, vertex count and screen coverage are bit-identical, and outputs a
constant colour. That removes, in one shot:

- all 28 fragment fetches and their anisotropy multiplier,
- the 9-light `MeshStandardMaterial` PBR loop over the ground's pixels,
- the VSM shadow-map lookup (a `ShaderMaterial` ignores `receiveShadow`),
- fog.

So recipe 1 is an **upper bound on everything the ground fragment shader costs**,
not an attribution. Recipe 4 splits it: a stock `MeshStandardMaterial` with the
same vertex displacement and the flag maps bound normally keeps the lights, the
shadow and 4 fetches, so

- `baseline - recipe4` = the composite shader (fetches + analytic layers)
- `recipe4 - recipe1` = the ground's share of the 9-light PBR loop + shadow

Both numbers are needed. If `baseline - recipe4` is small, the whole sample-count
story is dead and the ground's cost is the light loop (already a known lever),
and the correct fix is lights, not pre-compositing splats.

Recipes 2 and 3 are the two independent halves of the fetch cost and they add:
2 attacks the **per-fetch** cost (anisotropy), 3 attacks the **fetch count**.
They are the two that could ship.

## If the numbers land where the mechanism predicts

Ordered by ratio of milliseconds to look cost:

1. **Anisotropy cap on ground maps only** (recipe 2 landed as a preset value in
   `Config.js` / `ProceduralTextures.packedTexture`). 16 -> 4 is nearly free
   visually on a plate whose detail is a domain-warped 3-variant bomb; 16 -> 2 is
   visible as far-field softening. This is a one-line change per preset.
2. **Pre-composite the splat set.** The three flag variants exist only to
   decorrelate (`:402`-`:439`). Bake the 3-variant bomb into ONE larger
   non-tiling flag pair at load (`ProceduralTextures` already bakes everything
   else): 6 fetches -> 2, zero look change if the bake is done at the same
   world scale. Same for `uDecayA` — it is fetched 6 times at 4 different UV
   scales for rubble / rim / drift / soil; two of those (drift `:725`, soil
   `:781`) use only `.rgb` at low amplitude and can read the rubble sample.
   Realistic target: 28 -> ~14 fetches.
3. **Drop the drop-shadow march from 4 mask taps to 1** (`:900`). The mask is
   unfiltered and cheap, so this is the smallest of the three; it is in recipe 3
   only because it is free to test.

## Honest failure mode of this analysis

If recipe 1 saves less than ~5 ms, the ground is not the cost centre regardless
of what the fetch count says, and this whole lever should be closed with a note
in PERF_BUDGET.md next to the Sky.js and TowerMaterial entries. The board covers
most of the frame, so a small number here would be genuinely surprising — but
that is precisely what the two recorded false hypotheses also felt like.
