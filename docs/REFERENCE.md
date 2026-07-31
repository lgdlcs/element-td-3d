# Element TD — Canonical Reference

Research date: 2026-07-28. Target of study: **Element TD 2** (Steam appid `1018830`, Kirin Studios / Karawasa) and its ancestor, the Warcraft III custom map **Element TD**.

Confidence conventions used here: facts pulled from a primary/authoritative source are stated plainly with a citation. Anything I could not confirm is explicitly marked **UNVERIFIED**.

---

## 1. The six elements

Canonical and confirmed: there are exactly **six** elements, plus one pseudo-element.

| Element | Deals 2× to | Deals 0.5× to | Takes 2× from | Takes 0.5× from |
|---|---|---|---|---|
| Light | Darkness | Earth | Earth | Darkness |
| Darkness | Water | Light | Light | Water |
| Water | Fire | Darkness | Darkness | Fire |
| Fire | Nature | Water | Water | Nature |
| Nature | Earth | Fire | Fire | Earth |
| Earth | Light | Nature | Nature | Light |

The damage wheel is a clean 6-cycle: **Light → Darkness → Water → Fire → Nature → Earth → Light**. Each element hard-counters the next in the cycle and is soft-countered by it in reverse.

**Composite** is a seventh, special damage/armor type: it deals **full** damage to everything and **takes 90%** damage from every element (full from Composite). Only three towers deal Composite: Arrow, Cannon, Periodic.

**Boss armor** is a further special type used only by the "Ronald" boss creeps after wave 55; it takes **10%** damage from any source.

Source: [Element TD 2 Wiki — Elements](https://eletd2.fandom.com/wiki/Elements)

---

## 2. The dual tower table (the important one)

All 15 element pairs, with the real in-game tower name. **Every row below was verified individually** against that tower's own wiki page, reading the `elements=` field of its infobox — not inferred.

| # | Element pair | Tower name | Damage type | Signature ability |
|---|---|---|---|---|
| 1 | Light + Darkness | **Trickery** | Light | *Mirror* — buff tower; clones a nearby non-buff tower |
| 2 | Light + Water | **Ice** | Water | *Freeze* — micro-stuns the primary target |
| 3 | Light + Fire | **Lightning** | Light | *Chain Lightning* — attack bounces between creeps |
| 4 | Light + Nature | **Bloom** | Nature | *Photosynthesis* — recharges attack speed while idle |
| 5 | Light + Earth | **Atom** | Light | *Quantum Focus* — +10% dmg per consecutive hit on same target |
| 6 | Darkness + Water | **Poison** | Darkness | *Contagion* — stacking damage-over-time in an AoE |
| 7 | Darkness + Fire | **Infernal** | Fire | *Convergence* — keeps firing at its target even out of range |
| 8 | Darkness + Nature | **Disease** | Darkness | *Decay* — more damage the lower the target's HP |
| 9 | Darkness + Earth | **Howitzer** | Earth | *Artillery* — 1500 range; AoE grows with distance, damage with proximity |
| 10 | Water + Fire | **Vapor** | Water | *Evaporate* — hits everything in range, splits damage, scales with target count |
| 11 | Water + Nature | **Well** | Water | *Spring Forward* — buff tower; grants attack speed |
| 12 | Water + Earth | **Geyser** | Earth | *Erupt* — every 4th attack becomes a 300 AoE |
| 13 | Fire + Nature | **Solar** | Fire | *Ignite* — stacking burn that also damages around the target |
| 14 | Fire + Earth | **Blacksmith** | Fire | *Power Up* — buff tower; grants bonus damage |
| 15 | Nature + Earth | **Mushroom** | Nature | *Spore* — more damage the slower the target |

Sources (one per tower, all `eletd2.fandom.com/wiki/<Name>_Tower`):
[Trickery](https://eletd2.fandom.com/wiki/Trickery_Tower) ·
[Ice](https://eletd2.fandom.com/wiki/Ice_Tower) ·
[Lightning](https://eletd2.fandom.com/wiki/Lightning_Tower) ·
[Bloom](https://eletd2.fandom.com/wiki/Bloom_Tower) ·
[Atom](https://eletd2.fandom.com/wiki/Atom_Tower) ·
[Poison](https://eletd2.fandom.com/wiki/Poison_Tower) ·
[Infernal](https://eletd2.fandom.com/wiki/Infernal_Tower) ·
[Disease](https://eletd2.fandom.com/wiki/Disease_Tower) ·
[Howitzer](https://eletd2.fandom.com/wiki/Howitzer_Tower) ·
[Vapor](https://eletd2.fandom.com/wiki/Vapor_Tower) ·
[Well](https://eletd2.fandom.com/wiki/Well_Tower) ·
[Geyser](https://eletd2.fandom.com/wiki/Geyser_Tower) ·
[Solar](https://eletd2.fandom.com/wiki/Solar_Tower) ·
[Blacksmith](https://eletd2.fandom.com/wiki/Blacksmith_Tower) ·
[Mushroom](https://eletd2.fandom.com/wiki/Mushroom_Tower)

Cross-check: the in-game **Tower Table** panel (visible in `etd2-09-hud-tower-table.jpg`) lists exactly these 15 names in the Dual row of the six element columns — Atom/Lightning/Trickery under Light, Poison/Disease under Darkness, Vapor/Ice/Well under Water, Solar/Infernal/Blacksmith under Fire, Mushroom/Bloom under Nature, Howitzer/Geyser under Earth. 3+2+3+3+2+2 = 15. The screenshot and the wiki agree exactly.

Note on a bad source: `gamingph.com`'s "List of All Towers in Element TD 2" scrambles duals and triples together and gets several combinations wrong. Do not use it.

### Original Warcraft III Element TD

The WC3 original also had **15 dual towers and 20 triple towers** built from the same six elements ([ModDB](https://www.moddb.com/mods/element-tower-defense)). Two dual names are directly confirmed as identical to ETD2: **Vapor = Fire+Water** and **Poison = Darkness+Water** (same ModDB page, which also gives the alternate upgrade names Vapor/Mist/Steam and Poison/Pollution/Pestilence for the three levels).

**UNVERIFIED:** whether the full 15-name original WC3 table matches ETD2 one-for-one. The historical sources (eletd.com forums, the original map's own docs) are dead or Cloudflare-walled. Given the two confirmed matches and that Karawasa authored both, the ETD2 table is the safest canon to build against — but do not claim the WC3 map used identical names for all 15.

---

## 3. Higher tiers — triples, quads, composites

Towers are tiered by **how many distinct elements you must have unlocked**, not by upgrade level.

| Tier | Count | Max upgrade level | Notes |
|---|---|---|---|
| Basic (Composite) | 2 — Arrow, Cannon | — | Always unlocked, no element required |
| Single Element | 6 | Level 4 (L4 costs **Essence**) | One per element |
| Dual Element | 15 | Level 3 | The table above |
| Triple Element | 20 | Level 2 (one upgrade) | e.g. Astral, Laser, Nova, Runic, Ethereal, Jinx, Flooding, Wisp, Windstorm, Polar, Flamethrower, Haste, Corrosion, Impulse, Golem, Root, Incantation, Quake, Money, Muck |
| Quad Element | 15 | None | e.g. Railgun, Singularity, Plague, Doom, Phantom Zone, Tsunami, Crystal Spire, Obelisk, Rage, Archdruid, Tesla Tree, Life Altar, Shredder, Nuclear, Gravity Cannon |
| Periodic | 1 | None | Requires **all six** elements + Essence; deals Composite; 15000 gold |

Upgrade path: a level-1 Single can be upgraded *into* any Dual containing that element. A level-1 Dual can be upgraded into a Triple containing both its elements. A level-1 Triple can be upgraded into a Quad. So the tree is a genuine graph, not a linear chain.

Every tower keeps the damage type of one parent element — e.g. Ice is a Light+Water tower but deals **Water** damage; Lightning is Light+Fire but deals **Light**. The Tower Table groups by *damage type* first, tier second.

**"Elemental" vs "Composite":** in ETD2, "Composite" is the neutral damage type (Arrow, Cannon, Periodic) — full damage to everything, no wheel bonuses, and it takes 10% less from everything. It's the safe generalist, not a super-tower. The three genuinely top-end towers are Level-4 Singles, Quads, and Periodic — all Essence-gated. (The WC3 original had a separate concept of "elemental" creeps/guardians you had to kill to level up an element; ETD2 replaced that with the element pick + Essence economy.)

Source: [Element TD 2 Wiki — Towers](https://eletd2.fandom.com/wiki/Towers)

---

## 4. Core game loop

### Element picks
- You get a pick **at the start of the game and then every 5 waves, up to wave 50** → **11 picks total** in a full game.
- Each pick spends on one of: **one element level** (raising that element from 0→1→2→3 unlocks stronger single-element tiers and enables combos), **Income/Interest**, or **Essence**.
- Essence is the hard-gated currency for Level-4 Singles and Periodic. One Essence pick = enough for 2 level-4 Singles or Periodics. A free Essence is awarded after wave 50.
- Pick modes: *Pick* (free choice, towers sell for 80%), *Same Pick* (turn-based drafting, 80%), *All Random* / *Same Random* (random picks, towers sell for **100%**).

Sources: [Interface](https://eletd2.fandom.com/wiki/Interface), [Map Settings](https://eletd2.fandom.com/wiki/Map_Settings), [Beginner's Guide (Steam)](https://steamcommunity.com/sharedfiles/filedetails/?id=2360427994)

### Waves
- **55 unique scripted waves.** After wave 55 it becomes an endless boss phase ("Ronald" / Doom Lords) and the objective flips to score.
- Each wave has one element (or Composite) and often one **ability modifier**: Fast, Healing, Cursed, Bulky, Undead, Temporal, Shield. The default wave-element order is fixed and previewable (Chaos mode randomises it).
- **30 creeps per wave** normally; Bulky waves have half the count with 250% HP, double bounty, and each costs **2 lives**.
- Wave 12 and 18 are the early Bulky waves; Composite waves fall on 7, 14, 27, 33, 40, 51, 55.
- Next wave spawns **3 seconds after any player clears** the current one — in FFA that means a fast opponent pushes tempo onto you. (Extreme mode: 5s after the wave finishes spawning, regardless.)
- Game-length options start you at wave 1 (250g), 11 (1200g), 26 (6000g) or 56 (120000g).

### Interest / economy
- **2% interest on unspent gold every 15 seconds**, shown as a filling golden bar top-right.
- The Income pick raises it to **2.6%** and can only be taken once (post-1.7).
- **Leaking a creep disables interest for the rest of that wave** — this is the core risk/greed tension.
- Interest is **disabled entirely after wave 55**.
- Selling refunds **80%** (100% in random modes).
- Creep bounty scales hard: 2g at wave 1 → 345g at wave 55.

Source: [Gold](https://eletd2.fandom.com/wiki/Gold)

### Lives
- Each leaked creep costs **1 life** (Bulky creeps cost 2).
- Original WC3 Element TD started you with **50 lives** ([gaming-tools.com](https://gaming-tools.com/warcraft-3/element-td/)).
- **UNVERIFIED for ETD2:** the standard FFA starting life count is not documented on the wiki. The one HUD screenshot I have (`etd2-09-hud-tower-table.jpg`) shows a Co-op/Boss-Hunt game at **200** lives, so 200 is at least one valid configuration. Do not treat 50 as ETD2 canon without in-game confirmation.

### Mazing
- **The base game is not a maze-builder.** Standard ETD2 maps have a **fixed creep path** and dedicated raised build platforms flanking it — you choose *where along the path* and *what*, not the route.
- **Mazing Mode** is a separate mode (first public alpha 2022-09-10), inherited from the StarCraft II version, with its own maps and a dedicated **blocker** building type.
- Every map exposes a fixed number of build slots (the HUD shows `used / total`; the Co-op map in `etd2-09-hud-tower-table.jpg` shows `0/1006`).

Sources: [Mazing](https://eletd2.fandom.com/wiki/Mazing), [Game Modes](https://eletd2.fandom.com/wiki/Game_Modes)

### Modes
FFA (up to 8, own field each), Teams (2v2v2v2, shared field, separate gold), Co-op (up to 8 on one big shared map, 6 maps, 4/8-lane or balanced pathing), War (shared map, your towers heal your creeps and damage the opponent's), Team War. Difficulty scales creep HP: Easy 75% / Normal 100% / Hard 130% / **Very Hard 160% (the balance target, used for Ranked)** / Insane 200%.

---

## 5. How Element TD 2 actually looks

Written from the 12 official 1920×1080 screenshots in `../reference/`.

### Camera and framing
Fixed three-quarter perspective, not orthographic — you can clearly see convergence on the long stone kerbs and vertical tower bodies lean outward toward the frame edges. Pitch reads as roughly **50–60° down from horizontal**; yaw is a consistent **~45°**, so the square build grid always presents as diamonds and no wall ever hides another. FOV is narrowish (long-lens feel, maybe 30–40°), which keeps the whole play area feeling flat-ish and legible rather than fisheyed.

Default gameplay zoom frames roughly **12–18 grid tiles across the screen width**. The camera never tilts to horizon: the top of the frame is always more terrain, never sky. There is a free-camera / cinematic mode used for some marketing shots (`etd2-12-groundlevel-cannon-fire-wave.jpg` is nearly at ground level, `etd2-10-closeup-fire-tower-aoe.jpg` is a tight orbit on a single tower) but the playable camera is the fixed high-angle one.

### Arena and terrain
The play space is a **hard-edged plateau of stacked flagstone terraces** sitting inside a much larger, purely decorative diorama. The buildable surface is unambiguous: flat tiled flagstone, subdivided into visible square cells. Build slots sit on **raised stone kerbs / low walls about a third of a tile high**, running as long parallel strips alongside the sunken creep lanes. That height offset is the single most important readability trick in the whole game — towers are physically above the creeps, so nothing ever occludes anything.

The creep path itself is a lower, wider, dirt-or-worn-stone channel that snakes back on itself in tight switchbacks. Entrance and exit are marked by **portal discs**: a spinning **blue** vortex ring where creeps spawn and a spinning **red** vortex ring where they leak. Both are large (2–3 tiles), animated, and self-illuminated — impossible to miss.

Around the arena is a **decorative frame you never interact with**: forest canopy and boulders (`etd2-01-forest-arena-water-wave.jpg`), palm groves and shallow water (`etd2-10-closeup-fire-tower-aoe.jpg`), snowbanks and frozen pines (`etd2-03-snow-tower-rows-projectiles.jpg`), gravestones and iron fencing (`etd2-06-graveyard-creep-rimlights.jpg`), desert ruins and stepped ziggurats (`etd2-05-desert-lategame-maze.jpg`), lava fissures (`etd2-02-lava-chain-lightning.jpg`). The map themes are distinct enough to be instantly recognisable in a thumbnail. That decorative ring is dense — props every few metres: lanterns on posts, barrels, wooden carts, tufts of grass, small flowering plants, broken masonry. Nothing is bare.

Terrain material language is **stylised-realistic**: chunky bevelled stone with strong normal-map relief, hand-painted-feeling colour variation, no PBR grit or micro-detail. Bricks are large and readable at gameplay zoom. Edges of terraces are chamfered, never razor-sharp.

### Lighting mood
One dominant directional key with **long, soft, quite dark shadows** — shadow direction is consistent per map and shadows fall across the grid, which helps sell the terrace heights. Ambient fill is strongly tinted by the biome: cool blue in the snow and graveyard maps, warm amber in the desert, saturated green bounce in the forest.

Critically, **the map lighting is a low-key backdrop and the gameplay is the light source.** Towers, projectiles, auras and creep rim-lights are all emissive and heavily bloomed; on a busy wave (`etd2-11-multiplayer-max-density.jpg`, `etd2-02-lava-chain-lightning.jpg`) the arena is lit more by spell VFX than by the sun. Bloom is generous. There's clear tonemapping headroom — bright cores blow out to white while the surrounding terrain stays mid-grey. Some maps run near-black terrain (`etd2-02-lava-chain-lightning.jpg` lava, `etd2-06-graveyard-creep-rimlights.jpg` graveyard night) purely so the VFX pop harder.

### Tower silhouette and scale
Each tower occupies **exactly one grid cell** and sits on a visible square plinth/base that matches the cell footprint. Total height is roughly **0.8–1.5 cell widths** — squat, wider at the base than the top, reading as a chess piece more than a spire. Nothing is tall enough to occlude a neighbour.

Silhouettes are **short, heavy, and thematically obvious**: Cannon is a fat multi-barrel gun on a cog-toothed ring base (`etd2-12-groundlevel-cannon-fire-wave.jpg`, `etd2-05-desert-lategame-maze.jpg`); Nature towers are a low plinth sprouting a single stylised plant; Water towers are ringed basins or tiered discs; Fire towers are dark iron drums with glowing vents; Light towers are pale obelisks/crystals; Darkness towers are black cauldrons or claw-like spikes. The family read comes from **colour and emissive treatment, not from shape complexity**.

Every built tower carries an **element-coloured emissive glow at its base** — a soft coloured pool of light on its own tile. That's how you read a maze's element composition at a glance without selecting anything. Upgrade level is signalled by added geometry (more barrels, more rings, a bigger crown) plus a brighter, larger glow.

Buff towers (Well, Blacksmith, Trickery) and range display use **flat ground-projected rings**: a thin bright circle decal on the terrain, colour-matched to the tower. Selected-tower range is one such ring. The big sweeping orange arcs in `etd2-10-closeup-fire-tower-aoe.jpg` and `etd2-11-multiplayer-max-density.jpg` are ability-range animations, not persistent.

### Creeps — scale and readability
Creeps are **noticeably smaller than towers**, roughly **0.5–0.8 of a tile wide** and about a tile tall for humanoids. Three or four walk abreast in a lane. They spawn in packs of 30 and travel as a loose, staggered column rather than a rigid single file, with slight per-unit spacing jitter.

Their readability system is the key idea worth stealing: **every creep gets a hard emissive rim-light / outline in its wave's element colour**, plus a small matching ground decal or aura beneath it. In `etd2-01-forest-arena-water-wave.jpg` an entire wave of blue Water wolves reads as a single glowing blue river through a green forest. In `etd2-04-ruins-terraces-tower-glows.jpg` blue Water creeps sit against warm sandstone with zero ambiguity. The base creep meshes are conventional fantasy fare (wolves, ogres, harpies, demons, golems, robots) but the elemental tint layer is what makes the game parseable at speed.

Health is not shown as a bar over every creep by default in these shots — damage feedback is carried by hit flashes and floating numbers instead, which keeps the field clean.

### VFX style
This is the loudest part of the presentation and clearly the game's identity.

- **Projectiles** are long, bright **ribbon trails** — thick emissive streaks with a hot white core and an element-coloured falloff, curving in visible arcs from tower to target. Slow projectiles (Howitzer, Cannon) leave grey-white **smoke trails**. Fast ones (Lightning, Astral) are near-instant beams with a persistent afterimage.
- **Chains and beams**: chain attacks draw jagged forked lightning between multiple creeps simultaneously (`etd2-02-lava-chain-lightning.jpg`, `etd2-03-snow-tower-rows-projectiles.jpg`) — several targets connected by one continuous crackling polyline. Laser-type towers draw straight persistent beams.
- **Impacts** are short-lived radial bursts: a white-hot flash core, an expanding element-coloured spark ring, and a handful of directional shard/ember particles thrown outward. Roughly 0.2–0.4s life. They're big — an impact reads as about half a tile.
- **Auras and ground effects** are flat, additively-blended **ring and disc decals** projected on the terrain, animated by rotation and pulsing scale. Burn/poison patches are soft coloured discs. Buff and range indicators are thin bright outlines.
- **Element pool light**: every active tower casts a coloured light pool. In a full late-game maze (`etd2-11-multiplayer-max-density.jpg`) these overlap into a continuous glowing carpet.
- Overall: **additive blending everywhere, heavy bloom, extremely saturated, no subtlety.** The design bet is that pure colour + brightness communicates faster than any icon.

### UI layout and chrome
Style is unmistakably **Warcraft III-descended**: warm brown wood-and-parchment panels, riveted dark iron frames, beveled brick-red buttons with gold edging that turn gold-outlined on hover, all-caps condensed white sans-serif headers with a hard drop shadow.

In-game HUD (from `etd2-09-hud-tower-table.jpg`):
- **Top-left** — player list table: `PLAYER NAME | NETWORTH | LIVES | ELEMENTS | CREEP`. Each row carries a level badge, Steam avatar, colour-coded name, and six small circular element roundels with a numeral for that player's level in each element. Toggled with Tab.
- **Top-centre** — wave preview: current and next wave shown as creep portrait plates with the wave numbers (`56` / `57`), element and ability icons, plus the wave countdown timer and a `Boss Score` readout.
- **Top-right** — the personal status stack: a wide **green lives bar** with the number centred; gold total with a coin icon; the same six element roundels with your pick levels plus an Essence counter (`0/1`); and a tower-slot counter (`0/1006`).
- **Right column** — damage table panel with `CURRENT / PREVIOUS / TOTAL` tabs listing per-tower damage contribution. Below it, multiplier readouts (`Difficulty Multiplier`, `Speed Multiplier`, `Perfection Bonus`) in gold text.
- **Bottom-right** — minimap with a cyan camera-frustum rectangle, game-speed control above it, elapsed timer with score multiplier.
- **Bottom-centre** — the build bar: ten square icon buttons with hotkey letters in the corner — `A` Arrow, `C` Cannon, then `L D W F N E` for the six single-element towers, `P` Periodic, and `Space` to open the full Tower Table.
- **Tower Table modal** — six full-height vertical columns, one per element, each tinted with its element colour and headed by that element's roundel showing your current level. Within a column, towers are stacked by tier (Dual → Triple → Quad), each as a name label above a square icon with a level numeral. Footer has `RANGE: 750 / 900 / 1150 / 1500` and `SUPPORT: BUFF / SLOW / AMPLIFY` filter buttons.
- Menus (`etd2-07-ui-leaderboard.jpg` Leaderboard, `etd2-08-ui-profile-customize.jpg` Profile) use the same chrome: a large centred framed dialog over a live blurred 3D map background, left-hand vertical button rail, tabbed content grid, right-hand detail/preview pane.

### Colour palette per element
Read off the tower-table roundels, tower glows and creep rims:

| Element | Core / emissive | Column tint | Character |
|---|---|---|---|
| Light | hot white core → warm gold `#FFD24A` | amber-brown | radiant sunburst, warmest highlight in the game |
| Darkness | magenta-violet `#B04ACF` → deep purple | plum / aubergine | shrieking-face iconography, cold purple bloom |
| Water | cyan `#2FA8FF` → pale ice-white | navy blue | the coolest, most desaturated element |
| Fire | orange-red `#FF4A20` → yellow core | deep maroon-red | the highest-intensity, most blown-out VFX |
| Nature | leaf green `#4ACF52` → yellow-green | forest green | often paired with small ember/spore particles |
| Earth | tan / clay brown `#A8763C` | ochre-brown | the only low-chroma element; reads as mass, not light |
| Composite | prismatic rainbow gradient | neutral grey | multi-hued streak, deliberately "all elements at once" |

Backgrounds are always tuned to *contrast* the active elements: green forest for blue Water waves, red lava for blue/purple towers, white snow for magenta and gold beams.

---

## 6. Reference image inventory

Location: `/Users/pouetpouets/code/element-td-3d/reference/`
All 12 verified as real **JPEG, 1920×1080, 675 KB – 1.07 MB**. Source: official Steam store screenshots for appid 1018830, `shared.fastly.steamstatic.com`.

| File | What it shows |
|---|---|
| `etd2-01-forest-arena-water-wave.jpg` | Forest map, bright day. Blue-rimmed Water wolf wave streaming through a stone-kerb maze; blue spawn portal and red leak portal both visible; green Nature and blue Water tower glows. The single best shot for terrain/grid/portal layout. |
| `etd2-02-lava-chain-lightning.jpg` | Lava/hellscape map, near-black terrain. Massive chain-lightning fork across a packed creep column, plus a huge orange buff-aura ring. Best example of VFX-as-lighting and additive bloom. |
| `etd2-03-snow-tower-rows-projectiles.jpg` | Snow map, high-key white. Two dense rows of ~14 identical Water towers firing pink-violet ribbon projectiles at armoured creeps. Best shot for projectile trail language and tower-row density. |
| `etd2-04-ruins-terraces-tower-glows.jpg` | Sandstone ruins at dusk, lower camera angle. Red Fire and blue Water towers on raised kerbs above a Water creep pack. Best shot for terrace height offset and tower-base glow pools. |
| `etd2-05-desert-lategame-maze.jpg` | Desert/oasis map, late game. Very large maze fully built out, Cannon towers with white smoke trails, purple/pink towers, portals in the background. Best shot for late-game board density and build-slot layout. |
| `etd2-06-graveyard-creep-rimlights.jpg` | Graveyard map at night. Red-rimmed demon creeps and green-rimmed goblins against cold blue snow; magenta and yellow beams. Best shot for creep rim-light readability against a dark background. |
| `etd2-07-ui-leaderboard.jpg` | **UI** — Leaderboard menu over a blurred snow map. Shows the frame/button/table chrome, per-run element-pick summary roundels, Pick/Random/Coop/Team rail. |
| `etd2-08-ui-profile-customize.jpg` | **UI** — Profile / Customize Builder screen. Icon grid, tabs (Builders/Hats/Trails/Wings), right-hand 3D preview pane, shop points. |
| `etd2-09-hud-tower-table.jpg` | **The most valuable single reference.** Full in-game HUD with the Tower Table modal open — all six element columns with every Dual/Triple/Quad name legible, plus player list, wave preview, lives/gold/elements panel, damage table, build bar with hotkeys, minimap. |
| `etd2-10-closeup-fire-tower-aoe.jpg` | Cinematic close orbit on one Fire tower firing a wide orange sweep at green spider creeps, oasis map. Best shot for tower-to-tile scale and ability-arc VFX. |
| `etd2-11-multiplayer-max-density.jpg` | Multiplayer late game, extremely busy. Dozens of towers, overlapping orange/blue/green auras, floating player nametags. Best shot for peak visual density and how the game stays readable at maximum chaos. |
| `etd2-12-groundlevel-cannon-fire-wave.jpg` | Near-ground cinematic: a Cannon tower in the foreground against a charging Fire creep wave. Best shot for tower and creep mesh detail, material treatment, and creep silhouette. |

---

## 7. Open items

- **ETD2 standard FFA starting lives** — UNVERIFIED. Observed 200 in a Co-op/Boss-Hunt HUD screenshot; the WC3 original used 50.
- **Full original WC3 Element TD dual-tower name table** — UNVERIFIED beyond Vapor (Fire+Water) and Poison (Darkness+Water). Historical sources are offline or bot-walled.
- **The 20 Triple / 15 Quad element combinations** — names captured (§3) but the specific element triplets/quads per tower were not individually verified. Do that the same way the duals were done (per-tower wiki page, `elements=` field) before relying on them.
