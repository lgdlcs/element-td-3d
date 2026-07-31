# ELEMENT TD — Convergence · Art Bible & AAA Bar

This is the contract. Every implementation agent builds to it; every critic
agent judges against it. If a change does not move a screenshot closer to this
document, it is not worth making.

---

## 0. The one-sentence pitch

> **REVISED, ROUND 4.** The original pitch was *"a ruined arcane arena suspended
> over a starlit abyss… the board is the only lit thing in the world."* That
> sentence is why G1 could never be passed. It specifies a void, and a void is
> what three rounds of critics called unfinished. Superseded by the below.

*A ruined arcane arena built into a living landscape, where six elemental
forces are bound into stone weapons and hurled at an endless procession of
things trying to get through.*

Not "colourful mobile TD". Not "flat prototype greybox". **Weighty, saturated,
luminous, and continuous** — the camera shows a window onto a place that
obviously extends past all four edges of it.

### The six structural laws, taken from the reference frames

Verified against `reference/etd2-04-ruins-terraces-tower-glows.jpg` and
`reference/etd2-05-desert-lategame-maze.jpg`. Anything contradicting these is
wrong no matter how good it looks in isolation.

1. **There is no void.** The world is fully lit and fully textured to every
   frame edge — grass, cliffs, water, trees, ruins — at the same fidelity and
   saturation as the play area. The board is *embedded in a place*, never
   floating on a platform above nothing.
2. **Depth comes from overlap, not from fog.** Props run off the edges of frame
   and are cropped by them; foreground vegetation overlaps the near corner of
   the board. Being cut off by the frame is what proves the world continues.
3. **The maze is read from geometry, not from materials.** Buildable ground is a
   raised terrace with a thick masonry retaining wall; the creep path is the
   lower floor between terraces. Walls have silhouette and cast shadows. A
   texture mask has neither, which is why masks alone never fixed G8.
4. **Saturation carries readability; brightness does not.** The ground is always
   the lowest-saturation surface in frame. Creeps and towers are far more
   saturated than it and sit in hue opposition to it, each in a coloured ground
   pool of its own hue. High chroma at moderate luminance survives ACES; high
   luminance gets bleached to white.

5. **The world is composed, not scattered.** Added after round 4, when three
   independent blind critics all still called the frame "a game board on a
   table" *despite* law 1 being satisfied — ground did reach every frame edge.
   Covering the screen is not building a place. A density function distributes
   props evenly by construction, and "evenly distributed everywhere" is what the
   word *undifferentiated* means; you cannot tune scatter into composition.
   Every reference frame is authored: a road that **enters and exits** frame,
   houses with lit windows, a crenellated rampart, a water basin, a specific
   cliff. The surround needs named landmarks at chosen positions, with empty
   ground between them. Uneven density *is* the deliverable.
6. **No edge may announce that the level stops.** The board's border must not be
   a continuous unbroken rectangle of uniform material — that reads as a picture
   frame, and the eye goes to the frame instead of the combat. Reference walls
   are *interrupted*: collapsed sections, rubble spilling through, vegetation
   crossing them, foreground props occluding them, value varying along their
   length. A wall is allowed; a border is not. Terrain must read as continuous
   *across* the boundary at at least two points per side.

7. **The game is lit, not moody.** Measured after round 5, when three blind
   critics again independently said "no key light" / "lit almost entirely by
   ambient plus emissives" about a frame whose shadows are long, consistent and
   upper-left. I dismissed that twice as a misdiagnosis. It was not.

   | | ours (r5) | reference mean (9 frames) |
   |---|---|---|
   | mean luminance | **56.1** | **115.4** |
   | median | 46 | 95–169 |
   | 90th percentile | **105** | 192–234 |
   | frame below L=64 | **66.6%** | 26.5% |
   | mean saturation | **38%** | 55.2% |

   **Our brightest decile is darker than the reference's median in nine frames
   out of nine.** Even the darkest reference (`etd2-02`, lava, mean 67.3) is
   brighter than us, at 80% saturation against our 38%.

   Targets: **mean luminance 100–130, p90 above 185, under 30% of the frame
   below L=64.**

   **Saturation is deliberately NOT a target, and that is a correction.** The
   first version of this law demanded "mean saturation above 50%". An agent hit
   it exactly — 52.3% — with a global chroma multiply, and the result was
   fluorescent grass and a neon-orange road with no material read at all. Worse
   than the dark build it replaced.

   The reference's 55% comes from **content variety**: many differently-coloured
   materials in one frame (sand, timber, cloth, foliage, painted metal, stone).
   A global multiply raises large flat areas of ground uniformly, which produces
   fluorescence, not richness. The frame-mean saturation of the reference is a
   *symptom* of having many materials; it is not a dial, and treating it as one
   inverts cause and effect. Raise chroma by adding distinct material albedos,
   never by a global multiply — and judge it on the capture, not the number.

   This is the root cause of most of §0's other failures rather than a separate
   defect. Composition, silhouette and material work are all invisible inside a
   value range this narrow — you cannot read a material at L=46, and there is no
   headroom left to separate a unit from the floor. Verify every future change
   against these numbers with `tools/scratch/lum-vs-ref.mjs`, which compares a
   capture against the whole reference set.

8. **The board is never the brightest thing in frame.** Raising the frame into
   the reference's value range (law 7) is necessary and was a breakthrough. It
   also inverted the value hierarchy, and three blind critics caught it in the
   very next round: *"the floor is blown out and it is the brightest, largest
   area in the frame, so the eye lands on empty pavement rather than on the
   towers or the fight."*

   Measured with `tools/scratch/value-hierarchy.mjs`, and worse than they said:
   hiding **every** tower, creep and VFX makes the frame *brighter* — mean 143.6
   vs 138.4, median 151.5 vs 140.4 — and the empty board's brightest 1% (239.2)
   equals the full frame's (240.6). All gameplay content is darker than the
   pavement it stands on.

   Rule: the play surface is a **mid-tone**. Towers, units and effects own the
   top of the value range; the board owns the middle; the surround owns the
   bottom. Law 7 sets the frame's overall range — this law sets who occupies
   which end of it. Verify with the ablation, not by eye: hiding gameplay
   content must make the frame *darker*.

9. **On a packed board, shadow length must stay under tower spacing.**
   `shadowLength = height / tan(sunElevation)`. Above the spacing, 21 towers'
   shadows overlap into one continuous dark region and the board reads as a
   soft directionless blob — which is what three blind critics described, three
   rounds running, as "no key light" and "nothing casts a shadow".

   Measured at round 7: sun 40°, tower height 5.84 → **6.97-unit shadow against
   4.0-unit spacing**. Ablating the shadow map moved the board's mean by 12.2 L
   but its standard deviation by only 1.5 — shadows were darkening the floor
   almost uniformly instead of drawing shapes on it. Shadows existed; they
   carried no information.

   Note this **inverts the obvious note**. Every critic asked for a *lower*,
   more raking sun (~35°), which is correct for a sparse hero shot and wrong
   here — it lengthens shadows and merges them further. Element TD 2's dense
   boards use short, crisp shadows. Prefer a higher sun plus a tighter shadow
   filter over a low dramatic one.

   The companion trap is the filter: VSM at `radius 2.6 / blurSamples 16` makes
   each shadow soft enough that overlapping ones dissolve into a wash. Length
   and softness both have to stay under the spacing.

   Same family as the tower-height ceiling in §5 — `spacing`, `height` and
   `angle` are bound by arithmetic, and no amount of art direction overrides it.
   When a readability complaint keeps recurring, look for the closed form first.

Corollary, learned expensively: **nothing meets the ground with a clean seam.**
Grass in the wall joints, dirt drifted into the corners, vegetation reclaiming
the stone. Clean seams are the single most reliable "unfinished" tell, and they
are cheap to break up.

---

## 1. Non-negotiable quality gates

A frame FAILS review if any of these are true:

| # | Gate |
|---|------|
| G1 | The world stops. The play area ends at a rim, a skirt, a drop-off, a fog band or a backdrop plane. Terrain and props must run off **all four** edges of frame at full fidelity, with something cropped by the bottom edge in the foreground. |
| G2 | Ground reads as one tiling texture with visible repetition at gameplay camera distance. |
| G3 | Towers are unreadable as distinct silhouettes at default zoom — you cannot tell fire from water from 60 units out. |
| G4 | Creeps are indistinct blobs; you cannot tell how many there are or what type. |
| G5 | The image has no atmospheric depth — no fog gradient, no haze, no light shafts, no floating motes. |
| G6 | Nothing in frame is in motion when the game is idle (dead frame). |
| G7 | Highlights blow out to pure white mush, or shadows crush to pure black with no detail. |
| G8 | The maze path the creeps take is not visually legible. Material contrast alone does not pass this — buildable ground must be raised, walled, and casting shadow. |
| G9 | Any visible z-fighting, popping, seams, texture stretching, or peter-panning shadows. |
| G10 | UI floats without hierarchy, or overlaps/occludes critical board area. |

---

## 2. Composition & camera

- Default framing puts the arena at **~70–80% of frame width**. The current
  build is far too zoomed out — the board reads as a postage stamp.
- Default pitch ~**52–58°** from horizontal. Enough to read tower silhouettes
  against the ground, not so flat that the maze becomes unreadable.
- Slight **perspective compression** (FOV 38–45) so the arena reads as a
  physical diorama, not a wide-angle map.
- **The upper third is filled with cropped terrain, not sky.** This line used to
  read "the horizon must be visible in the upper third", which was wrong twice.
  Geometrically it contradicts the 52–58° pitch two bullets up: at that pitch the
  top-of-frame depression is 34.2°, so ground at board level fills the frame to
  the top edge at ~94 units and no crest can clear it without absurd amplitude.
  And the reference disagrees — the top edge of `etd2-05` is a crenellated
  rampart, the top edge of `etd2-04` is a treeline. Rising ground cropped by the
  frame is the target. That is law 2 (depth from overlap), not law 1.
- Vignette + DOF gently push the eye to board centre. Never so strong it reads
  as a filter.

## 3. Terrain

**Terracing comes first.** Buildable ground is a raised terrace roughly ⅓–½ a
cell high, edged with a thick masonry retaining wall of 3–4 courses of
individually readable blocks; the creep path is the lower floor between them.
This is what actually satisfies G8 — the walls have silhouette and cast
shadows, so the maze reads instantly at any zoom. The material zones below
reinforce that read; they have never been able to carry it alone. If the
triangle budget forces a choice, the terracing outranks the third material.

Masonry must be **low-frequency and directional**: discrete blocks large enough
to count at gameplay zoom, visible mortar gaps, chipped corners, per-block tint
variation. High-frequency noise averages to flat grey at distance and is the
signature of a placeholder material.

- **Three material zones**, blended by mask, never a single tile:
  1. **Buildable stone** — cut arcane flagstones, tight joints, engraved
     channels that glow faintly along the seams.
  2. **The walked path** — worn dirt/ash where creeps travel. Darker, rougher,
     scuffed, with wheel/foot polish down the centre line. This is how G8 is
     satisfied: *you can see the road because it looks walked on.*
  3. **Edge decay** — chipped, crumbling, moss/ash accumulation near the rim.
- Detail must survive close inspection: **triplanar or multi-scale UV blend**
  (a 1× macro variation layer over a 8–12× detail layer) so there is no
  visible tiling at any zoom.
- Real height variation. Displaced or tessellated, catching raking key light.
- Puddles / wet patches in low areas with genuine roughness contrast — the
  single cheapest way to make a floor look expensive.

## 4. Environment (fixes G1 + G5)

> **REWRITTEN, ROUND 4.** This section used to open *"the arena is a platform in
> a void, but the void must be furnished"*, and everything built to it failed
> G1. A furnished void is still a void. There is no platform and there is no
> void — see the four structural laws in §0.

The arena is **built into continuous terrain**:
- Ground runs off all four edges of frame at the same material fidelity and
  saturation as the play area. No skirt, no rim-of-the-world, no drop-off.
- **Surround landscape** populated with clustered props — rock outcrops,
  vegetation, ruined architecture, water — placed aperiodically and instanced
  for cost. Clusters, never even spacing.
- **At least one foreground cluster** overlapping the near corner of the board
  and cropped by the bottom edge of frame. This is law 2 and it is the cheapest
  depth cue available.
- Distant terrain and sky read as *far away in the same world*, not as a
  backdrop plane. Aerial perspective, not a painted band.
- Volumetric haze from the key light. **In-scene only** — the screen-space
  `GodRaysPass` is off and must stay off until it has an occlusion-masked source
  buffer; unmasked, it rakes tower emissives across the surround. See
  PITFALLS §10.
- Ambient drifting motes and embers in the air, in elemental hues.
- Ground fog pooling in the low ground *between* terraces, not spilling off an
  edge.

## 5. Towers

- **Scale**: a tower occupies a 2×2 cell footprint (4×4 world units). **Height
  must stay under `spacing × tan(camera pitch)`** — at the 4-unit tower pitch
  and ~51.5° pitch that is **5.04 world units**. Above it, a tower covers the
  base of the one behind it and a packed board stops being N silhouettes and
  becomes one mass.

  This line used to read "height should read at 2.5–3.5× cell size", which is
  ambiguous — `cell` is 2 units, the footprint is 4 — and an agent reasonably
  read the larger one, producing 8–13-unit towers, every single one of them
  1.6–2.6× over the occlusion threshold. Three blind critics then reported
  "cylinder plus a glowing orb" three rounds running, which was a literal and
  accurate description of the only part of each tower still visible. Meanwhile
  the silhouettes validated perfectly in an elevation sheet, because in
  elevation nothing occludes anything.

  Reference check: an ETD2 tower is ~1.0–1.3× its footprint tall (`etd2-05`,
  `etd2-11`). A tower is a **big characterful head on a short body**, not a
  column. Vary height *within* the ceiling for silhouette spread — the spread is
  what reads, never the absolute scale.
- **Silhouette first**: each of the 6 elements must be identifiable as a black
  shape with no colour. Fire = jagged/asymmetric. Water = smooth/curved.
  Nature = branching/organic. Earth = blocky/heavy. Light = tall/thin/precise.
  Dark = spiked/inverted.
- Duals read as *fusions*: the base of parent A, the crown of parent B.
- **Materials must be layered**: dark metal + carved stone + a glowing
  elemental core. Real metalness/roughness contrast; visible edge wear on
  corners; anisotropic-feeling brushed metal on the shell.
- Upgrade tiers must be **visually obvious at a glance** — more mass, more
  emissive, more moving parts, not just a ring.
- Every tower has **continuous secondary motion**: floating rings, orbiting
  shards, pulsing cores, drifting runes.
- Towers cast and receive real contact-hardening shadows and spill coloured
  light onto the floor around them.

## 6. Creeps

**The readability rule, from the reference (law 4).** Creeps are *self-lit*: a
saturated, full-body emissive fill modulated by the normal — not a thin fresnel
rim. A `pow(1-NdV, k)` band is too thin to survive on a 40px body, and a bright
full-body flood gets bleached to white by ACES. What survives is **high chroma
at moderate luminance**. Creep saturation must sit far above the floor's, in
hue opposition to it, and every creep sits in a coloured ground pool of its own
hue — wide enough to read *even when the body is occluded by a tower*.

Acceptance test, not a guideline: from a normal gameplay screenshot, count the
living creeps from the image alone and match the HUD number.

- Readable at default zoom: distinct silhouette per archetype, clear scale
  hierarchy (swarm << normal << armored << boss).
- Bosses are **event-scale**: 2–3× normal, with unique treatment (aura,
  trailing smoke, ground cracks, screen presence).
- Animation must convey weight — procedural gait, lean into turns, squash on
  landing, stagger on hit. No sliding.
- Damage state readable: hit flash, status tinting (frozen/burning/poisoned),
  and health bars that are legible but not visually noisy.
- Death is an **event**: dissolve/shatter/burst appropriate to how it died,
  with a lingering decal or ash.

## 7. VFX

- Projectiles have a **core + glow + trail + light**, not a flat sphere.
- Impacts: flash, radial spark burst, shockwave decal on the ground, secondary
  smoke, and a brief point light. Splash impacts shake the camera slightly.
- Element-specific language:
  - Fire → embers rising, heat shimmer, lingering flame decal
  - Water → droplet spray, frost crystals, chilled ground patch
  - Nature → leaf/spore burst, vines
  - Earth → rock chunks, dust plume, ground crack decal
  - Light → lens-flare bloom, chained beams, holy motes
  - Dark → void implosion, tendrils, desaturation pulse
- **Restraint**: at 30 towers firing, the screen must still be readable.
  Bloom threshold must not turn combat into white soup.

## 8. Lighting & grade

- Key: warm, ~45° elevation, casting long readable shadows across the board.
- Fill: cool sky bounce, low intensity, no shadows.
- Rim/back: strong and cool, separating every silhouette from the floor.
- Tower cores are **real light sources** that colour the ground.
- ACES filmic tonemap. Highlights roll off; **no clipped white**.
- Shadows retain colour (cool blue-violet), never pure black.
- Subtle chromatic aberration and grain — perceptible at 200% zoom, invisible
  at 100%.

## 9. UI

- Obsidian glass, hairline rules, arcane gold accent. Generous negative space.
- Tabular numerals, tight optical alignment, no text touching an edge.
- Every interactive element has hover, active, disabled and focus states.
- Transitions are 180–320ms on an ease-out curve. Nothing snaps.
- 21 build cards in a flat row is a failure — group by element, collapse
  duals, or use a two-tier layout.
- The HUD must never cover the arena's playable centre.

## 10. Performance budget

| Metric | Ultra | Notes |
|---|---|---|
| Draw calls | **< 220** | Currently 934. Towers must be batched/merged per archetype. |
| Triangles | < 900k | |
| Frame time | < 8ms @1080p on M-series | |
| Shader programs | < 60 | |
| First interactive | < 2.5s | |

---

## 11. The blind test

The final acceptance test: place a screenshot of this game next to a
screenshot of **Element TD 2** at the same resolution, unlabelled, and ask a
reviewer which looks like the more expensive, more modern game.

**We must win that test, not tie it.**
