import * as THREE from 'three';

/**
 * The arena floor material.
 *
 * A MeshStandardMaterial with its map / roughness / normal / AO plumbing
 * hijacked via onBeforeCompile so we can composite three material zones
 * (flagstone plateau, sunken walked lane, decayed rim) driven by a live
 * grid-derived mask — each broken up by a 1x macro variation layer plus a
 * second, rotated, non-integer-ratio detail scale.
 *
 * Two things do the heavy lifting:
 *
 *  G2  nothing repeats on a lattice, because every detail sample is modulated
 *      by fields that only repeat once across the whole board.
 *  G8  the creep lane is a *physically sunken channel with a kerb*, not a
 *      darker texture. That is the Element TD 2 readability trick: buildable
 *      stone sits a step above the road, so nothing ever occludes anything.
 */

// Shared by the ground shader and its shadow-depth twin so the silhouette the
// light sees is exactly the silhouette the camera sees.
export const KERB_GLSL = /* glsl */`
  uniform sampler2D uMask, uMacro;
  uniform float uRoadDepth, uKerbLo, uKerbHi;

  // wear -> 0..1 step with a tight shoulder: a kerb, not a soft dip.
  float kerbProfile(float wear) {
    float k = smoothstep(uKerbLo, uKerbHi, wear);
    return k;
  }

  // Returns vec3(sink, roadWeight, decayWeight) for a world XZ + arena UV.
  vec3 terrainSink(vec2 wxz, vec2 auv) {
    vec4 mc2 = texture2D(uMacro, wxz * 0.052 + vec2(0.37, 0.11));
    vec2 warp = (vec2(mc2.r, mc2.b) - 0.5) * 0.05;
    vec4 mk = texture2D(uMask, clamp(auv + warp, vec2(0.002), vec2(0.998)));
    float roadRaw = mk.r;
    float k = kerbProfile(roadRaw);
    float decay = smoothstep(0.40, 0.94, mk.g + (mc2.r - 0.5) * 0.42);
    float sink = k * uRoadDepth + decay * 0.16 * (0.4 + mc2.g);
    return vec3(sink, k, decay);
  }
`;

const VERT_COMMON = /* glsl */`
  #include <common>
  ${KERB_GLSL}
  varying vec2 vTUv;
  varying vec3 vTWorld;
`;

const VERT_BEGIN = /* glsl */`
  #include <begin_vertex>
  vTUv = uv;
  vec2 wxz0 = (modelMatrix * vec4(position, 1.0)).xz;
  vec3 sk = terrainSink(wxz0, uv);
  transformed.y -= sk.x;
  vTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

export function createGroundUniforms({ flag, road, decay, macro, mask, maskSize }) {
  return {
    uFlagA: { value: flag.albedo },
    uFlagN: { value: flag.nra },
    uRoadA: { value: road.albedo },
    uRoadN: { value: road.nra },
    uDecayA: { value: decay.albedo },
    uDecayN: { value: decay.nra },
    uMacro: { value: macro },
    uMask: { value: mask },
    uMaskTexel: { value: new THREE.Vector2(1 / maskSize.x, 1 / maskSize.y) },
    uTime: { value: 0 },
        // 0.175 put a flagstone course at roughly 0.5 world units once the third
    // worley subdivision is counted, which reads as gravel. 0.118 puts a large
    // slab at ~2 build cells, which is the scale the eye calls "cut stone".
    uDetail: { value: 0.118 },
    // ROUND 4 — THE TERRACE.
    //
    // 0.46 was a gutter: a quarter of a cell, shaded with a bright "arris"
    // line to try to make it read. It did not. Element TD 2 solves maze
    // legibility GEOMETRICALLY — the buildable ground is a raised terrace
    // about half a cell high with a masonry retaining wall around it, and you
    // read the maze from the walls and the shadows they throw. A mask has no
    // silhouette and casts no shadow; a 1.0-unit wall does both.
    //
    // 1.00 = half a build cell (CELL = 2.0), matching the reference plates.
    uRoadDepth: { value: 1.00 },
    // Tightened from 0.30/0.46. The wear field falls off at roughly 0.3 per
    // world unit through this range, so a 0.30-wide band was a 1.0-unit ramp —
    // a grassy bank, not a wall. 0.08 wide is ~0.27 world units, which at 12
    // segments per cell (0.167 u) is under two quads: a genuine near-vertical
    // face. The masonry below is analytic in world space, so the fact that the
    // face is only two stretched quads never shows.
    uKerbLo: { value: 0.375 },
    uKerbHi: { value: 0.460 },
    uPlateauY: { value: 0.20 },
    // --- analytic masonry ---------------------------------------------------
    // 1.55 world units = 0.78 of a build cell. At the default framing the board
    // spans ~1100px, so a slab is ~33px: big enough to count, which is exactly
    // what the reference does and what "authored, not noise" means.
    uSlab: { value: new THREE.Vector2(1.55, 1.15) },
    uJoint: { value: 0.052 },
    uSlabGain: { value: 1.0 },
    // ROUND 4b: 0.70 -> 0. This uniform existed only to survive the old
    // flagstone map. That map carried a Worley joint lattice, so once the
    // analytic world-space slab lattice below took over the structure, the two
    // lattices were multiplied together and the texture's veins showed through
    // every slab. `uGrainFlat` mixed the map toward pow(albF, 0.62) * 0.78 — a
    // gamma lift that hid the veins by crushing the map's contrast, and paid
    // for it with all of the grain's contrast headroom as well.
    //
    // makeFlagstoneMaps no longer has a lattice at all (see the header comment
    // there), so there is nothing to hide and the grain gets its full range
    // back. The map's mean value was re-authored down to compensate, and the
    // board's measured luminance is held: law 4 makes the ground the
    // lowest-saturation, and it must not be brightened to meet the surround.
    uGrainFlat: { value: 0.0 },
    // How much of the ash map's value reaches the lane. Promoted to a uniform in
    // round 4b so G8 can be swept instead of guessed; see the block that uses it.
    uRoadGain: { value: 0.44 },
    // SWEPT, not chosen. tools/scratch/g8-r4.mjs, Cohen's d between the lane and
    // terrace pixel populations sampled through the live camera:
    //   1.00 -> 0.61 | 0.55 -> 0.64 | 0.30 -> 0.72 | 0.15 -> 0.67
    // Below ~0.2 the lane loses its own key highlight entirely and starts to
    // read as a flat hole rather than as a floor, which costs more sd than the
    // extra mean gap buys.
    uRoadSpec: { value: 0.30 },
    // Direct-light survival inside the terrace's own drop shadow. Swept against
    // G8 (0.40 -> d 0.66 | 0.26 -> 0.70 | 0.16 -> 0.67); below ~0.2 the shadow
    // stops reading as shadow and starts reading as a hole, which costs more
    // population sd than the mean gap it buys. Ambient and fill are untouched,
    // so G7's "shadows never crush to black" still holds.
    uKerbShadowK: { value: 0.26 },
    // How much of the key survives in the lane. The lane is a one-unit channel
    // with walls on both sides, so it genuinely sees less sky and less of the
    // key's grazing response than the open terrace. Swept against G8:
    //   0.55 -> d 0.66 | 0.44 -> 0.69 | 0.36 -> 0.69.
    // Beyond ~0.4 the mean gap stops growing and only the lane's sd does, and
    // this term attenuates DIRECT light only — ambient, fill and sky bounce are
    // untouched, so the lane keeps detail in its darks (G7).
    //
    // RE-SWEPT, ROUND 5, and the optimum MOVED. The round-4b sweep found a flat
    // plateau at 0.36-0.44 and settled on 0.42. Re-run against the round-5 frame
    // (the surround is far darker and the whole plate's exposure has shifted,
    // and the corner drift adds terrace variance):
    //   0.42 -> d 0.64 | 0.34 -> 0.68 | 0.28 -> 0.69 | 0.22 -> 0.71 | 0.16 -> 0.60
    // 0.22 is the peak; at 0.16 the lane's own sd jumps 36.4 -> 39.6 and it
    // starts reading as a hole rather than a floor, which is the same failure
    // mode the round-4b note predicted, just at a lower value.
    //
    // This is also the ONLY lever that could pay for the drift. Adding the
    // corner drift cost 0.06 of Cohen's d on its own (0.64 -> 0.58 against a
    // matched control), and round 4b already established that albedo work on the
    // lane cannot move G8 at all — sweeping uRoadGain 0.44 -> 0.26 moved the
    // lane's rendered mean by 0.2 L, because ~87% of this plate's value is the
    // key's dielectric specular lobe. Light-side terms, or nothing.
    uLaneSky: { value: 0.22 },
    // Three courses over a 1.0 wall = 0.33 each, matching the 3-4 courses of
    // the reference retaining walls.
    uCourseH: { value: 0.335 },
    uBlockLen: { value: 0.95 },
    uWallGain: { value: 1.0 },
    // Direction the terrace's shadow travels across the lane, in world XZ,
    // and how far. Driven live from the key light by Arena.update() — the key
    // drifts, so a baked constant would slowly desync from every other shadow
    // in the frame. See the TERRACE DROP SHADOW block.
    uSunXZ: { value: new THREE.Vector2(0.74, 0.67) },
    uKerbShadow: { value: 1.2 },
    uSeamColor: { value: new THREE.Color(0x3b8bff).convertSRGBToLinear() },
    // Dressed kerb stone. Cooled from 0xb6b2ac: under a 7.6-intensity amber key
    // a warm-grey dressed block was the single brightest, warmest thing on the
    // plate and it ran the whole length of the lane like a strip of tape.
    uKerbColor: { value: new THREE.Color(0xa8adba).convertSRGBToLinear() },
    uSeamGain: { value: 0.11 },
    uNormalGain: { value: 0.80 },
    uDebug: { value: 0 },
    // ROUND 3 MEASURED "the plate is 87% dielectric specular, albedo work cannot
    // move it". THAT IS NO LONGER TRUE AND EVERY ROUND SINCE HAS QUOTED IT.
    // The round-6 day relight tripled the key; re-measured on today's build with
    // tools/scratch/r7-board-terms.mjs, over a board-only centre crop:
    //
    //   composited                189.7      uSpecTint x0.25   -6.7 L
    //   directDiffuse alone       173.1      uSpecF90 -> 0.0   -0.6 L
    //   directSpecular alone      121.8      uAlbedoGain 0.42 -17.9 L
    //   uAlbedoGain = 0           121.7      uAlbedoGain 0.30 -26.6 L
    //
    // Killing the albedo outright removes 68 of the plate's 190 L. The plate is
    // now DIFFUSE-dominated and uAlbedoGain is the only lever with real
    // authority; uSpecF90 has become inert and uSpecTint is worth a few L.
    // PITFALLS §12: a number from an earlier round is not a baseline.
    //
    // The specular tint is still pulled down (0.62/0.66/0.78 -> x0.55): under a
    // 3x brighter key the same F0 puts a sheen on the plate that reads as wet
    // laminate, and law 8 spends every L it can get.
    uSpecTint: { value: new THREE.Vector3(0.34, 0.36, 0.43) },
    // Grazing Fresnel. three hard-sets this to 1.0 for MeshStandardMaterial;
    // a dusty, ash-loaded weathered floor does not have a mirror-white grazing
    // response, and leaving it at 1.0 is what made the plate read as laminated
    // card. 0.30 keeps a believable sheen at the very grazing angles (the far
    // edge of the board) without the whole plate sitting in one.
    uSpecF90: { value: 0.34 },
    uAOGain: { value: 1.0 },
    // The composition pass below is a long chain of soiling multipliers — soot,
    // traffic haze, damp, bloom, rim decay — and their product removes about
    // three quarters of the incoming stone value. This is the exposure that
    // puts the plate back where a lit granite floor belongs afterwards, so the
    // texture itself can keep honest 0.055-0.33 linear granite values instead
    // of being pre-brightened to compensate. MEASURED against board L.
    //
    // ROUND 7 — 0.86 -> 0.30. ART BIBLE LAW 8, and it is a BOOKKEEPING ERROR,
    // not a taste call.
    //
    // 0.86 was solved for against the round-5 night key. Round 6 relit the game
    // for law 7 and, in RenderPipeline's own words, "the day relight raised lit
    // stone roughly 3x in linear" — the bloom threshold was re-derived for that
    // (1.05 -> 2.05) and this exposure was not. The floor was therefore running
    // ~3x over its own reference for a full round, which is precisely what all
    // three blind critics reported: "the stone floor is near-white and is the
    // brightest, largest area in the frame". 0.86 / 3 = 0.29.
    //
    // MEASURED, board-only centre crop, paired on one build: 189.7 -> 163.1 L at
    // 0.30, and the full-frame law-7 numbers stay inside the reference band. The
    // response is strongly compressive above ~180 (ACES), which is also why the
    // per-slab value variation authored below had become invisible: every slab
    // was sitting on the flat top of the curve. Bringing the plate back to a
    // mid-tone is what makes tile-to-tile value legible again — the two round-6
    // defects, "blown out" and "no variation between tiles", have one cause.
    uAlbedoGain: { value: 0.30 },
    // --- composition / focal hierarchy -------------------------------------
    // The board is not one value: it is lit like a stage. `uFocus` is the
    // centre of mass the eye should land on, `uArenaHalf` normalises world XZ
    // to a 0..1 radius so the falloff is elliptical, matching the 26x20 board.
    uFocus: { value: new THREE.Vector2(0, -1.5) },
    uArenaHalf: { value: new THREE.Vector2(26, 20) },
    // WHERE THE PERIMETER WALL IS BROKEN (law 6). vec4(x, z, halfLength, axisX)
    // filled in by Arena.#buildRim from the same authored table the sweep uses,
    // so the rubble the floor material spills through a breach lands in the
    // same place as the collapsed geometry. A third copy of the field would
    // drift from the wall it is supposed to be spilling out of.
    uBreach: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    // How much sand/ash has drifted into the corners and banked against the
    // perimeter. The blind critics: "the entire slab is the same cool grey tile
    // at the same value from edge to edge, so the lower two-thirds of the board
    // has no focal hierarchy and the eye has nothing to travel along."
    uDrift: { value: 1.0 },
    // Spread chosen so the mean over the plate stays ~1.0 — the goal is
    // CONTRAST, not a darker board. Round 2's first pass dropped the mean and
    // simply made the whole thing muddy.
    //
    // Round 3 softens the radial stage (0.60/1.46 -> 0.72/1.34) because the
    // gobo now supplies the large-scale value story. Two full-strength
    // board-scale gradients multiplied together drove the corners to mud.
    uRimDark: { value: 0.70 },   // albedo multiplier out at the rim
    uCentreLift: { value: 1.16 }, // albedo multiplier at the focus
    // ROUND 3 — the albedo is COLD everywhere; the key supplies the warmth.
    // uWarmCentre is now near-neutral rather than +22% red-over-blue, and
    // uCoolRim is pushed further violet so unlit stone falls to the Art Bible's
    // grey-violet arcane granite instead of to grey.
    uWarmCentre: { value: new THREE.Color(1.020, 1.010, 1.000) },
    uCoolRim: { value: new THREE.Color(0.60, 0.72, 1.10) },
  };
}

export function createGroundMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    map: uniforms.uFlagA.value,
    normalMap: uniforms.uFlagN.value,
    roughnessMap: uniforms.uFlagN.value,
    aoMap: uniforms.uFlagN.value,
    roughness: 1.0,
    metalness: 0.0,
    emissive: new THREE.Color(0x000000),
    envMapIntensity: 1.25,
    dithering: true,
  });
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_COMMON)
      .replace('#include <begin_vertex>', VERT_BEGIN);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform sampler2D uFlagA, uFlagN, uRoadA, uRoadN, uDecayA, uDecayN;
        uniform sampler2D uMacro, uMask;
        uniform vec2 uMaskTexel;
        uniform float uTime, uDetail, uSeamGain, uNormalGain, uDebug, uAOGain, uAlbedoGain;
        uniform float uRoadDepth, uKerbLo, uKerbHi;
        uniform float uPlateauY, uJoint, uSlabGain, uCourseH, uBlockLen, uWallGain, uGrainFlat;
        uniform float uRoadGain, uRoadSpec, uKerbShadowK, uLaneSky;
        uniform vec2 uSlab, uSunXZ;
        uniform float uKerbShadow;
        uniform float uRimDark, uCentreLift;
        uniform vec3 uSpecTint;
        uniform float uSpecF90;
        uniform vec2 uFocus, uArenaHalf;
        uniform vec3 uSeamColor, uKerbColor, uWarmCentre, uCoolRim;
        varying vec2 vTUv;
        varying vec3 vTWorld;

        vec3 gMapN = vec3(0.0, 0.0, 1.0);
        float gRough = 1.0;
        // Lane weight, written in <map_fragment>, consumed in
        // <lights_physical_fragment>. See uRoadSpec.
        float gRoadW = 0.0;
        float gAO = 1.0;
        vec3 gEmissive = vec3(0.0);
        // Gobo shadow term, written in <map_fragment>, consumed in
        // <lights_fragment_end>. See the GOBO block for why it has to attenuate
        // the LIGHT and not merely the albedo.
        float gShadow = 1.0;
        vec3 gShadowTint = vec3(1.0);

        const mat2 ROT_A  = mat2( 0.8387,  0.5446, -0.5446,  0.8387);
        const mat2 ROT_Ai = mat2( 0.8387, -0.5446,  0.5446,  0.8387);
        const mat2 ROT_B  = mat2( 0.4067,  0.9135, -0.9135,  0.4067);
        const mat2 ROT_Bi = mat2( 0.4067, -0.9135,  0.9135,  0.4067);
        const mat2 ROT_C  = mat2(-0.2079,  0.9781, -0.9781, -0.2079);
        const mat2 ROT_Ci = mat2(-0.2079, -0.9781,  0.9781, -0.2079);

        uniform vec4 uBreach[8];
        uniform float uDrift;

        float th1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
        float th2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

        // 1 inside a collapsed section of the perimeter wall, falling off over
        // "reach" world units inboard of it. Note the max() guards on every
        // smoothstep: an unused slot has halfLength 0, and smoothstep with
        // edge0 >= edge1 is UNDEFINED behaviour in GLSL and silent with it
        // (PITFALLS 6). Two of the ten entries in that file are this exact bug.
        float breachAt(vec2 p, float reach) {
          float b = 0.0;
          for (int i = 0; i < 8; i++) {
            vec4 B = uBreach[i];
            float half_ = max(B.z, 1e-3);
            float along  = mix(abs(p.y - B.y), abs(p.x - B.x), B.w);
            float across = mix(abs(p.x - B.x), abs(p.y - B.y), B.w);
            float a = 1.0 - smoothstep(half_ * 0.55, half_, along);
            float c = 1.0 - smoothstep(reach * 0.25, max(reach, 0.2), across);
            b = max(b, a * c * step(1e-3, B.z));
          }
          return b;
        }
      `)
      .replace('#include <map_fragment>', /* glsl */`
        vec2 wxz = vTWorld.xz;

        // ---- macro layers, THREE distinct scales ----------------------------
        // mac0 is deliberately sub-1x: a single soft blob across the whole
        // board. It is the slowest value in the image and is what gives the
        // composition somewhere for the eye to land.
        vec4 mac0 = texture2D(uMacro, vTUv * 0.34 + vec2(0.61, 0.28));
        vec4 mac1 = texture2D(uMacro, vTUv);
        vec4 mac2 = texture2D(uMacro, wxz * 0.052 + vec2(0.37, 0.11));
        // ROUND 3, fourth scale (~6 tiles across the board). Its only job is to
        // DECORRELATE. Round 2's variant selector was driven by mac0/mac1,
        // which are arena-scale, so one of them inevitably won at low frequency
        // and split the plate into a smooth left page and a coarse right page
        // with the seam running near the lane. mac3 breaks each selector field
        // into island-sized patches that cannot align with the board axes.
        vec4 mac3 = texture2D(uMacro, wxz * 0.118 + vec2(0.19, 0.63));
        // ROUND 5, fifth scale (~22 tiles across the board, i.e. roughly a
        // build cell). Everything above it is board-scale or bigger; there was no
        // field in this shader between "one cell" and "the packed detail map",
        // which is the band footfall scuffing and drift edges live in.
        vec4 mac4 = texture2D(uMacro, wxz * 0.415 + vec2(0.77, 0.34));
        // How far into a collapsed section of the perimeter wall we are.
        float brch = breachAt(wxz, 7.5);

        // ---- zone mask, boundary warped to match the displaced geometry -----
        vec2 warp = (vec2(mac2.r, mac2.b) - 0.5) * 0.05;
        vec2 muv = clamp(vTUv + warp, vec2(0.002), vec2(0.998));
        vec4 mk = texture2D(uMask, muv);

        // Mask gradient, needed early: it is both the kerb-face normal AND the
        // wall's run direction for the analytic masonry below.
        float hL = texture2D(uMask, muv - vec2(uMaskTexel.x, 0.0)).r;
        float hR = texture2D(uMask, muv + vec2(uMaskTexel.x, 0.0)).r;
        float hD = texture2D(uMask, muv - vec2(0.0, uMaskTexel.y)).r;
        float hU = texture2D(uMask, muv + vec2(0.0, uMaskTexel.y)).r;

        float roadRaw = mk.r;
        float wRoad  = smoothstep(uKerbLo, uKerbHi, roadRaw);
        gRoadW = wRoad;
        float wDecay = smoothstep(0.40, 0.94, mk.g + (mac2.r - 0.5) * 0.42);
        wRoad *= 1.0 - wDecay * 0.75;
        float wFlag = max(0.0, 1.0 - wRoad - wDecay);
        float wsum = max(1e-4, wRoad + wDecay + wFlag);
        wRoad /= wsum; wDecay /= wsum; wFlag /= wsum;

        // The kerb face: the narrow band where the plateau drops to the lane.
        float kerb = (1.0 - abs(smoothstep(uKerbLo, uKerbHi, roadRaw) * 2.0 - 1.0));
        kerb *= step(uKerbLo * 0.6, roadRaw);
        kerb = pow(clamp(kerb, 0.0, 1.0), 1.6);

        // ---- flagstone: texture bombing, not layering ------------------------
        // Round 1 cross-faded two scales at a fixed 0..0.6 ratio, so layer 1 was
        // ALWAYS at least 40% present — its lattice therefore survived
        // everywhere and the critic could still count tiles (G2 fail).
        //
        // Now: a low-frequency selector picks *one* variant almost everywhere,
        // cross-fading only in narrow bands. Each variant has its own rotation,
        // its own non-integer scale and its own phase offset, and every UV is
        // domain-warped by a field whose wavelength is ~1/3 of the board. There
        // is no position at which the same texel neighbourhood recurs.
        vec2 dwarp = (vec2(mac1.r, mac1.b) - 0.5) * 3.4
                   + (vec2(mac2.b, mac2.g) - 0.5) * 0.85;

        vec2 uvF1 = (wxz + dwarp) * uDetail;
        vec2 uvF2 = ROT_A * (wxz + dwarp * 0.7) * (uDetail * 0.617) + vec2(0.31, 0.74);
        vec2 uvF3 = ROT_C * (wxz - dwarp * 1.3) * (uDetail * 1.463) + vec2(0.58, 0.19);

        // Selector: two independent fields -> 3 regions. Note mac2 in the mix.
        // With only the arena-scale fields the plate split into three
        // continent-sized blocks with a visible border, which trades a tiling
        // artefact for a patchwork artefact. Folding in the ~2.7x world field
        // breaks each region into many smaller islands instead.
        // The mid-frequency field must DOMINATE. Weighted the other way the
        // arena-scale blob wins and the plate splits into two hemispheres of
        // different stone butted together down the middle — which reads every
        // bit as synthetic as the tiling it replaced.
        //
        // Round 2 got the weighting right in principle but left 20-24% of each
        // selector on an arena-scale field, and 20% of a field with a full-board
        // wavelength is still enough to bias one half of the plate toward one
        // variant. Round 3 removes the arena-scale terms from the selectors
        // entirely and mixes the two *world*-scale fields instead, so the
        // lowest frequency present in the selector is ~2.7 tiles, not 1.
        float sel1 = smoothstep(0.36, 0.66, mac2.r * 0.58 + mac3.g * 0.42);
        float sel2 = smoothstep(0.38, 0.68, mac2.g * 0.55 + mac3.b * 0.45);
        float w1 = (1.0 - sel1);
        float w2 = sel1 * (1.0 - sel2);
        float w3 = sel1 * sel2;

        vec4 aF  = texture2D(uFlagA, uvF1);
        vec4 nF  = texture2D(uFlagN, uvF1);
        vec4 aF2 = texture2D(uFlagA, uvF2);
        vec4 nF2 = texture2D(uFlagN, uvF2);
        vec4 aF3 = texture2D(uFlagA, uvF3);
        vec4 nF3 = texture2D(uFlagN, uvF3);

        vec3 albF = aF.rgb * w1 + aF2.rgb * w2 + aF3.rgb * w3;
        // ROUND 4 — demote the packed map from STRUCTURE to GRAIN.
        // Captured close up, this texture resolves as a network of thin dark
        // veins over pale plaster: crazed dry mud, which is precisely the "one
        // crazed-vein texture" the blind critic named three rounds running. The
        // structure is now the analytic slab lattice further down. A gamma
        // below 1 lifts the vein darks while leaving the mids where they were
        // (0.2 -> 0.29, 0.5 -> 0.51), so the map keeps supplying grit and
        // colour variation without drawing a crack across every slab.
        albF = mix(albF, pow(max(albF, vec3(1e-4)), vec3(0.62)) * 0.78, uGrainFlat);
        vec2 nxyF = (nF.rg * 2.0 - 1.0) * w1
                  + (ROT_Ai * (nF2.rg * 2.0 - 1.0)) * w2
                  + (ROT_Ci * (nF3.rg * 2.0 - 1.0)) * w3;
        float rgF = nF.b * w1 + nF2.b * w2 + nF3.b * w3;
        float aoF = nF.a * w1 + nF2.a * w2 + nF3.a * w3;
        // Chamfered-stone read: the joints are where the AO lives. Crushing the
        // low end of the baked AO is what makes the slabs look bevelled rather
        // than printed on.
        aoF = pow(clamp(aoF, 0.0, 1.0), 1.28);
        float seam = aF.a * w1 + aF2.a * w2 + aF3.a * w3;

        vec3 albedoT = albF * wFlag;
        vec2 nxyT = nxyF * wFlag;
        float roughT = rgF * wFlag;
        float aoT = mix(1.0, aoF, wFlag);

        // ---- sunken road ----------------------------------------------------
        if (wRoad > 0.004) {
          vec2 uvR = ROT_B * (wxz + dwarp * 0.55) * (uDetail * 0.83);
          vec4 aR = texture2D(uRoadA, uvR);
          vec4 nR = texture2D(uRoadN, uvR);
          // ROUND 4: the lane is TRODDEN. Darker and markedly less saturated
          // than the flagstone it runs between — that value/chroma gap is the
          // other half of the maze read, and at 1.0 gain the ash was landing
          // within a few percent of the stone. Desaturating rather than only
          // darkening matters: the terrace keeps its cool violet cast, the lane
          // goes to neutral ash, so the two separate in hue as well as value
          // and survive being lit by a coloured tower.
          // MEASURED, and the number moved twice. Classifying a 0.6-unit world
          // lattice by the wear field, projecting it through the live camera and
          // sampling the rendered pixels (tools/scratch/g8-r4.mjs) gives lane vs
          // terrace populations. At 1.0 gain: mean gap 9 L, Cohen's d 0.25 — a
          // road you cannot see. Sinking the lane a full unit actually LIFTS its
          // mean (47 -> 61 L with everything else held), because a sunken floor
          // sits deeper in the fill and reads less of the gobo, so the terrace
          // bought silhouette at the cost of the value contrast the flat version
          // happened to have. This gain buys the value contrast back on top of
          // the silhouette instead of instead of it.
          vec3 roadA = aR.rgb * uRoadGain;
          roadA = mix(roadA, vec3(dot(roadA, vec3(0.30, 0.52, 0.18))), 0.52);
          albedoT += roadA * wRoad;
          nxyT += (ROT_Bi * (nR.rg * 2.0 - 1.0)) * wRoad * 0.7;
          roughT += nR.b * wRoad;
          aoT *= mix(1.0, nR.a, wRoad);
        }

        // ---- broken ground OUT IN THE FIELD ---------------------------------
        // Everything else on this plate is a smooth gradient, and a floor made
        // only of smooth gradients still reads as one surface however many
        // octaves you stack on it. What the references have and we did not is
        // HARD-EDGED macro features: a run of rubble, a collapsed patch, a spill
        // of gravel with a boundary you can point at. So we pull the decay
        // material inboard in tightly-thresholded islands. Fragment-only — the
        // geometry does not sink here, so nothing desyncs from surfaceHeightAt.
        //
        // ROUND 5 — and the rubble now has a REASON as well as a distribution.
        // Law 6 asks that terrain read as continuous ACROSS the board boundary
        // at two points per side. The wall geometry collapses at those eight
        // places (Arena.makeBreaches); this is the other half of the same
        // gesture — the fill from the collapsed courses spills INBOARD onto the
        // board floor, so the material runs across the line as well as the
        // silhouette. "brch" raises the field rather than painting a shape, so
        // the spill keeps the same hard-thresholded island edges as the rest of
        // the rubble and cannot read as a decal.
        float rubbleF = mac3.a * 0.26 + mac1.b * 0.20 + mac2.a * 0.54
                      + brch * 0.30;
        float wRubble = smoothstep(0.568, 0.700, rubbleF) * wFlag
                      * (0.34 + brch * 0.66);
        wRubble *= 1.0 - wRoad;
        wFlag -= wRubble;
        // The island's own contact shadow. Round 2's rubble read as paint
        // because it had a boundary but no THICKNESS: the flagstone ran up to
        // the gravel and stopped. A dark fringe on the outboard side of the
        // threshold — where a real spill would bank against the slab it sits on
        // — plus a stronger normal inside it, is what turns a decal into a pile.
        float rubEdge = smoothstep(0.540, 0.572, rubbleF)
                      * (1.0 - smoothstep(0.572, 0.626, rubbleF));
        if (wRubble > 0.004) {
          vec2 uvU = ROT_B * (wxz - dwarp * 0.4) * (uDetail * 1.05) + vec2(0.83, 0.41);
          vec4 aU = texture2D(uDecayA, uvU);
          vec4 nU = texture2D(uDecayN, uvU);
          albedoT = albedoT - albF * wRubble + aU.rgb * wRubble * 1.02;
          nxyT = nxyT - nxyF * wRubble + (ROT_Bi * (nU.rg * 2.0 - 1.0)) * wRubble * 1.5;
          roughT = roughT - rgF * wRubble + nU.b * wRubble;
          aoT *= mix(1.0, nU.a * 0.84, wRubble);
        }
        aoT *= 1.0 - rubEdge * 0.26;
        albedoT *= 1.0 - rubEdge * 0.13;

        // ---- decayed rim ----------------------------------------------------
        if (wDecay > 0.004) {
          vec2 uvD = ROT_C * (wxz + dwarp * 0.9) * (uDetail * 1.24);
          vec4 aD = texture2D(uDecayA, uvD);
          vec4 nD = texture2D(uDecayN, uvD);
          albedoT += aD.rgb * wDecay;
          nxyT += (ROT_Ci * (nD.rg * 2.0 - 1.0)) * wDecay;
          roughT += nD.b * wDecay;
          aoT *= mix(1.0, nD.a, wDecay);
        }

        // =====================================================================
        // ANALYTIC CUT FLAGSTONE  (round 4 — G2 and "authored, not noise")
        // ---------------------------------------------------------------------
        // Everything above this line is texture. Three rounds of texture work,
        // three rounds of the critic reading the floor as "one crazed-vein
        // texture at one UV scale" — and a close capture proves him right: the
        // packed flagstone map resolves as a network of thin dark cracks over
        // pale plaster. Dry mud, not cut stone. No slab, no joint, no course.
        //
        // The lattice is now analytic and lives in WORLD space, which has three
        // consequences worth the shader cost:
        //   * it cannot tile, ever, at any zoom (G2 by construction, not by
        //     bombing a texture hard enough to hide its period);
        //   * the joint width is expressible in world units, so it can be
        //     antialiased against its own screen-space derivative instead of
        //     shimmering (PITFALLS #6);
        //   * per-slab value, hue, roughness and height are a hash away, which
        //     is what makes a floor read as laid rather than printed.
        // The packed maps survive as GRAIN inside each slab — the ~10x detail
        // layer under a 1x macro. They are no longer carrying the structure.
        vec2 slabScale = uSlab;
        vec2 sUv = wxz / slabScale;
        // Organic warp: courses that are dead straight read as a tiled decal.
        sUv += (vec2(mac2.b, mac2.r) - 0.5) * 0.26 + (vec2(mac3.r, mac3.b) - 0.5) * 0.13;
        float srow = floor(sUv.y);
        float rowH = th1(srow * 1.37 + 4.1);
        // Running bond + a per-course width so no two courses share a rhythm.
        vec2 sc = vec2(sUv.x * (0.86 + rowH * 0.34) + srow * 0.5 + rowH * 1.7, sUv.y);
        vec2 sid = floor(sc);
        vec2 sf = fract(sc);
        vec2 sd = min(sf, 1.0 - sf);
        float sAA = max(fwidth(sc.x), fwidth(sc.y)) * 0.9 + 1e-4;
        float jw = uJoint;
        float gJx = 1.0 - smoothstep(jw - sAA, jw + sAA, sd.x);
        float gJy = 1.0 - smoothstep(jw - sAA, jw + sAA, sd.y);
        float joint = max(gJx, gJy);
        // Chamfer: four times the joint width, and it is the chamfer — not the
        // dark line — that makes the slab read as a solid block with thickness
        // when the key rakes across it.
        float bw = jw * 4.2 + sAA;
        float cx = 1.0 - smoothstep(0.0, bw, sd.x);
        float cy = 1.0 - smoothstep(0.0, bw, sd.y);
        // Tangent space here is literally world XZ (the plane's uv is x/w, z/h),
        // so a chamfer that falls away toward the joint tilts the normal back
        // toward the slab centre.
        vec2 chamf = vec2(-sign(sf.x - 0.5) * cx * cx, -sign(sf.y - 0.5) * cy * cy);

        float sh1 = th2(sid + 0.5);
        float sh2 = th2(sid * 1.7 + 9.3);
        float sh3 = th2(sid * 0.31 - 3.1);
        // A minority of slabs sit proud or sunk; those are the ones the eye
        // uses to decide the floor is made of separate pieces.
        float proud = (sh3 - 0.5) * 2.0;

        float slabAmt = clamp(wFlag * uSlabGain, 0.0, 1.0);
        // The joint itself: dark, dusty, and it owns the AO.
        albedoT *= 1.0 - joint * 0.62 * slabAmt;
        aoT *= 1.0 - joint * 0.55 * slabAmt;
        aoT *= 1.0 - max(cx, cy) * 0.14 * slabAmt;
        roughT = mix(roughT, 0.97, joint * 0.6 * slabAmt);
        // Per-slab value + hue + roughness. Kept COOL: the board must stay
        // opposed to the warm backdrop (224 deg of hue opposition to protect).
        //
        // ROUND 7, all three critics: "add real value variation between tiles".
        // There WAS variation here (0.74..1.26) and it was invisible for two
        // reasons, both now fixed:
        //
        // (a) the plate was 3x over-exposed, so every slab sat on the flat top
        //     of the ACES curve and a +-26% albedo spread compressed to nothing.
        //     uAlbedoGain 0.86 -> 0.30 puts it back on the responsive part.
        // (b) a PER-SLAB hash is high-frequency by construction. At gameplay
        //     framing a slab is ~33px, so per-slab noise averages out to a flat
        //     field over any area the eye actually reads as "a region of floor"
        //     — the same failure the drift block above diagnoses for gradients,
        //     in the other direction. Real paving is laid in BATCHES: courses
        //     cut from one block, replaced patches, differently weathered runs.
        //
        // So the spread is widened (0.62..1.38) and multiplied by a PATCH term
        // hashed on a 4x3-slab superblock, which gives groups of adjacent tiles
        // a shared value. Superblock and slab hashes are deliberately different
        // scales so the batch boundaries do not land on the same lines twice.
        //
        // NAMED 'batchA', NOT 'patch'. PITFALLS §12.2 again, new word: 'patch'
        // is a GLSL ES reserved keyword. It does not warn — the fragment shader
        // simply fails to compile, three reports it on the console, the draw
        // call is still issued and the surface renders as untextured default.
        // Cost one capture. Add it to the list next to 'cast'.
        // (And writing this note cost a SECOND capture, to §12.1: the first
        // draft quoted those words in backticks, which ended this template
        // literal and took the whole app down. Single quotes in GLSL comments.)
        float batchA = th2(floor(sc / vec2(4.0, 3.0)) * 2.13 + 7.7);
        float batchB = th2(floor(sc / vec2(9.0, 7.0)) * 0.61 - 2.3);
        albedoT *= mix(1.0, 0.62 + sh1 * 0.76, slabAmt);
        albedoT *= mix(1.0, 0.80 + batchA * 0.40, slabAmt);
        albedoT *= mix(1.0, 0.88 + batchB * 0.24, slabAmt);
        // Weathering follows the batch as well: an older batch is rougher and
        // has lost more of its chroma, so the value break reads as MATERIAL
        // rather than as a light patch (law 4 — the board keeps the lowest
        // saturation in frame, so variation must be spent on value, not chroma).
        roughT = clamp(roughT + (batchA - 0.5) * 0.26 * slabAmt, 0.05, 1.0);
        albedoT = mix(albedoT,
                      vec3(dot(albedoT, vec3(0.30, 0.52, 0.18))),
                      max(0.0, 0.62 - batchA) * 0.45 * slabAmt);
        albedoT *= mix(vec3(1.0),
                       vec3(0.96 + sh2 * 0.10, 0.99 + sh2 * 0.04, 1.06 - sh2 * 0.06),
                       slabAmt);
        roughT = clamp(roughT + (sh2 - 0.5) * 0.20 * slabAmt, 0.05, 1.0);
        // Proud slabs catch a touch more light, sunk ones sit in their own AO.
        albedoT *= 1.0 + proud * 0.09 * slabAmt;
        aoT *= 1.0 - max(0.0, -proud) * 0.16 * slabAmt;
        nxyT += chamf * 0.62 * slabAmt;
        nxyT += vec2(proud * 0.05) * slabAmt;

        // =====================================================================
        // DRIFT  (round 5 — focal hierarchy, and the "clean seam" corollary)
        // ---------------------------------------------------------------------
        // Three blind critics, independently: "the tile grid is a uniform repeat
        // with zero large-scale variation… the lower two-thirds of the board has
        // no focal hierarchy and the eye has nothing to travel along. Fix: sand
        // drift accumulating in the corners."
        //
        // Everything this shader had for large-scale variation was a GRADIENT —
        // the gobo, the radial stage, three octaves of stain. A floor made only
        // of gradients still reads as one surface, which is the same argument
        // that produced the hard-edged rubble islands above and it applies with
        // more force here. Drift is a DIFFERENT MATERIAL with a boundary: it
        // buries the joints, flattens the normal, kills the grain and takes the
        // chroma out. Where it stops, you can point at the line.
        //
        // Placed by accumulation physics rather than by noise: sand piles up in
        // the corners and banks against the windward faces of the perimeter
        // wall, which is also the corollary in §0 ("nothing meets the ground
        // with a clean seam; dirt drifted into the corners") — from the INSIDE
        // this time. The tufts already did the outside.
        //
        // It must not brighten the board on average: law 4 makes the ground the
        // lowest-saturation surface in frame and the towers are spending that
        // contrast. Drift is +6% in value and about -45% in chroma, so it reads
        // as a change of MATERIAL, not as a light patch.
        vec2 nb = wxz / uArenaHalf;
        float cornerness = pow(clamp(abs(nb.x), 0.0, 1.0), 2.4)
                         * pow(clamp(abs(nb.y), 0.0, 1.0), 1.8);
        float bank = max(smoothstep(0.74, 1.02, abs(nb.x)),
                         smoothstep(0.72, 1.02, abs(nb.y)));
        float driftF = cornerness * 1.55 + bank * 0.50
                     + (mac2.a - 0.5) * 0.62 + (mac3.b - 0.5) * 0.40
                     + (mac4.g - 0.5) * 0.16;
        float drift = smoothstep(0.40, 0.72, driftF) * uDrift;
        drift *= 1.0 - wRoad * 0.85;      // the lane is swept clean by traffic
        // TRIED AND REJECTED, MEASURED. The obvious protection for G8 is to keep
        // the pale drift away from the kerb — traffic sweeps a margin either
        // side of a walked route — so this line was
        //     drift *= 1.0 - smoothstep(0.02, 0.34, roadRaw) * 0.80;
        // It made G8 WORSE, not better: d fell 0.58 -> 0.53 against a matched
        // drift-off control that moved only 0.64 -> 0.61. Keeping drift OFF the
        // near-lane terrace removes the one place where drift was raising the
        // terrace mean directly opposite the lane, which is precisely where the
        // two populations are compared. Left in as a comment because it is a
        // plausible-looking change that a future round will otherwise re-derive.
        drift = clamp(drift, 0.0, 1.0);
        // The leading edge of the pile: a thin dark line where the drift banks
        // against the stone it is burying. Round 2's rubble taught this — a
        // boundary without thickness reads as paint.
        float driftEdge = smoothstep(0.355, 0.408, driftF)
                        * (1.0 - smoothstep(0.408, 0.470, driftF));
        if (drift > 0.004) {
          vec2 uvS = ROT_A * (wxz + dwarp * 0.25) * (uDetail * 2.15) + vec2(0.44, 0.92);
          vec4 aS = texture2D(uDecayA, uvS);
          // Windblown fines: the packed map is used only for grain, at low
          // amplitude, because a drift has no structure — that is what makes it
          // read as a different material next to cut stone.
          vec3 sand = mix(vec3(dot(albedoT, vec3(0.32, 0.50, 0.18))),
                          aS.rgb * 0.62, 0.34) * 1.06;
          sand = mix(sand, vec3(dot(sand, vec3(0.31, 0.51, 0.18))), 0.46);
          albedoT = mix(albedoT, sand, drift * 0.86);
          // Buried joints. Without this the lattice shows straight through the
          // pile and the drift looks like a stain rather than like depth.
          albedoT *= 1.0 + joint * 0.44 * slabAmt * drift;
          aoT = mix(aoT, mix(aoT, 1.0, 0.55), drift);
          roughT = mix(roughT, 0.96, drift * 0.80);
          nxyT *= 1.0 - drift * 0.78;
          nxyT += (vec2(mac4.r, mac4.b) - 0.5) * 0.10 * drift;
        }
        albedoT *= 1.0 - driftEdge * 0.20;
        aoT *= 1.0 - driftEdge * 0.30;

        // =====================================================================
        // PERIMETER SOIL INCURSION — the slab does not END, it is BURIED
        // ---------------------------------------------------------------------
        // ROUND 7, ranked #1 by all three blind critics and by all three in the
        // same terms: "there is a hard rectangular seam where slab meets grass";
        // "sink the slab into terrain"; "bury the slab into the terrain, let
        // grass, dirt and rubble overrun the edges".
        //
        // Round 5 broke the WALL and that is landed: its silhouette is
        // interrupted at eight authored places. This is a different edge. What
        // is still a perfect rectangle is the GROUND-PLANE TRANSITION: standing
        // wall or collapsed, the flagstone runs at full strength right up to the
        // boundary and then stops, so the board reads as a rectangle set down on
        // a lawn. Arena.#buildTalus answers the outboard half of it with spoil
        // straddling the line; this is the inboard half, and it is the half that
        // has to be a MATERIAL change rather than props, because what the eye is
        // reading as "a clean seam" is a material discontinuity, not a silhouette.
        //
        // The boundary is deliberately RAGGED, not offset. Moving a straight
        // line inward buys nothing — it is still a rectangle, just a smaller one.
        // Three octaves of macro noise are added to the perimeter coordinate
        // BEFORE the threshold, so the soil advances several units in some
        // places and barely reaches the wall in others, and there is nowhere
        // along the run where you can point at a straight edge.
        //
        // It also pays for itself twice: this is the outer third of the board,
        // which under law 8 is exactly where the plate should be surrendering
        // value to the towers in the middle of it.
        float perR = max(abs(nb.x), abs(nb.y));
        float ragged = (mac3.g - 0.5) * 0.44 + (mac2.b - 0.5) * 0.28
                     + (mac4.r - 0.5) * 0.16;
        float soil = smoothstep(0.86, 1.04, perR + ragged * 0.34);
        // Traffic keeps the lane mouths scoured; soil banks up on the terraces
        // either side of them instead, which is what a walked route looks like.
        soil *= 1.0 - wRoad * 0.55;
        if (soil > 0.004) {
          vec2 uvE = ROT_A * (wxz + dwarp * 0.4) * (uDetail * 1.35) + vec2(3.1, 1.7);
          vec4 aE = texture2D(uDecayA, uvE);
          // Earth, not dust: less chromatic and slightly darker than the stone,
          // so it reads as ground washed over the slab rather than as a light
          // stain. The drift block above is the opposite move (+6% value) in the
          // corners; the two must not converge on the same tone or the board
          // ends up with one uniform ring of "edge material".
          //
          // MEASURED, and the first version was too dark. At 0.60x the soil cost
          // G8 0.67 -> 0.60: the band covers the outer sixth of the board, which
          // is ~a quarter of the terrace pixel population the gate is computed
          // over, so a 15 L drop there pulled the terrace mean down 141.1 -> 137
          // and closed the gap against the lane. Held near the stone's own value
          // (0.86x) instead. That is the right build anyway — this is supposed
          // to be a MATERIAL boundary, and everything that sells it as one is
          // already carried by the other four terms below (buried joints,
          // roughness, flattened normal, lost chroma). Value was never doing the
          // work here; it was only spending G8.
          vec3 earth = mix(vec3(dot(albedoT, vec3(0.31, 0.51, 0.18))) * 0.86,
                           aE.rgb * 0.70, 0.55);
          albedoT = mix(albedoT, earth, soil * 0.72);
          // Joints silt up before the faces do, so the lattice dies out from the
          // grout inward — the slab visibly DISAPPEARS under the soil instead of
          // being tinted by it.
          albedoT *= 1.0 + joint * 0.34 * slabAmt * soil;
          roughT = mix(roughT, 0.98, soil * 0.85);
          aoT = mix(aoT, aoT * 0.84, soil);
          nxyT = mix(nxyT, nxyT * 0.34 + (vec2(mac4.b, mac4.g) - 0.5) * 0.20, soil);
        }

        // =====================================================================
        // ANALYTIC RETAINING WALL  (round 4 — G8)
        // ---------------------------------------------------------------------
        // The terrace face. uRoadDepth is now half a build cell, so this is a
        // real wall with a real silhouette that throws a real shadow across the
        // lane — which is how Element TD 2 makes a maze readable in one glance
        // and why no amount of mask tinting was ever going to get there.
        //
        // Courses run off WORLD Y (so they stay level however the face is
        // tessellated, and the plateau's own relief gives them a slight,
        // welcome wobble). Blocks run off the mask gradient's perpendicular, so
        // the coursing follows the wall around every turn of the maze; where
        // the wall turns a corner the run coordinate jumps, which reads as a
        // quoin rather than as an error.
        float wallW = clamp(kerb * uWallGain, 0.0, 1.0);
        if (wallW > 0.004) {
          vec2 gdir = vec2(hR - hL, hU - hD);
          float glen = length(gdir);
          vec2 gn = glen > 1e-5 ? gdir / glen : vec2(0.0, 1.0);
          vec2 tang = vec2(-gn.y, gn.x);

          float depthY = (uPlateauY - vTWorld.y);
          float crs = depthY / uCourseH;
          float cid = floor(crs);
          float cf = fract(crs);
          float srun = dot(wxz, tang) / uBlockLen + th1(cid * 2.7 + 1.3) * 4.7 + cid * 0.5;
          float bid = floor(srun);
          float bf = fract(srun);

          float mAA = max(fwidth(crs), fwidth(srun)) * 0.9 + 1e-4;
          // Ragged mortar: a clean 6% line is a CAD drawing. The threshold is
          // pushed around by the macro fields so blocks lose corners.
          float ragged = (mac2.a - 0.5) * 0.055 + (mac3.r - 0.5) * 0.035;
          float mv = 1.0 - smoothstep(0.075 + ragged - mAA, 0.075 + ragged + mAA,
                                      min(bf, 1.0 - bf));
          float mh = 1.0 - smoothstep(0.085 + ragged - mAA, 0.085 + ragged + mAA,
                                      min(cf, 1.0 - cf));
          float mortar = max(mv, mh);

          float bh1 = th2(vec2(bid, cid) + 0.5);
          float bh2 = th2(vec2(bid, cid) * 1.9 + 7.7);
          // Dressed capstone: the top course is cleaner and lighter, which is
          // what draws the eye ALONG the terrace edge at gameplay distance.
          float cap = 1.0 - smoothstep(0.0, 0.55, crs);

          // The face is DRESSED STONE, not road dirt. This matters: halfway up
          // the face wRoad is ~0.5, so without an override the retaining wall
          // came out the colour of the ash lane it retains — a brown smear
          // exactly where the strongest value boundary in the image needs to
          // be. Rebuild it off the flagstone albedo (albF), which is the only
          // sample here that has never seen the road.
          vec3 wallAlb = albF * (0.72 + bh1 * 0.66);
          wallAlb *= mix(vec3(1.0), vec3(0.93, 0.98, 1.10), 0.5 + bh2 * 0.5);
          wallAlb *= 1.0 + cap * 0.46;
          albedoT = mix(albedoT, wallAlb, wallW);
          albedoT *= 1.0 - mortar * 0.72 * wallW;
          aoT *= 1.0 - mortar * 0.62 * wallW;
          // The lane floor is shaded tight against the foot of the wall.
          aoT *= 1.0 - smoothstep(1.05, 1.55, crs) * wRoad * 0.35;
          roughT = mix(roughT, clamp(0.80 + (bh2 - 0.5) * 0.26 - cap * 0.26, 0.1, 1.0),
                       wallW * 0.8);

          // Block relief. The course grooves run along tang, so their normal
          // perturbation is along gn; the block joints are the transpose.
          float cbev = -sign(cf - 0.5) * (1.0 - smoothstep(0.0, 0.26, min(cf, 1.0 - cf)));
          float bbev = -sign(bf - 0.5) * (1.0 - smoothstep(0.0, 0.19, min(bf, 1.0 - bf)));
          vec2 wallN = gn * cbev * 0.52 + tang * bbev * 0.34
                     + gn * (bh1 - 0.5) * 0.18;
          nxyT = mix(nxyT, nxyT * 0.25 + wallN, wallW);
        }

        // =====================================================================
        // TERRACE DROP SHADOW  (round 4 — G8, and G9 by not using a shadow map)
        // ---------------------------------------------------------------------
        // In the reference plates you read the maze from the retaining walls
        // AND from the shadows they throw into the lane. Enabling castShadow on
        // the ground produced exactly that shadow — plus a half-cell sawtooth
        // down every lane edge, because a 46-unit ortho frustum cannot resolve
        // a 0.27-unit silhouette. Ablation confirmed the sawtooth was the
        // shadow map and nothing else (see Arena.#buildGround).
        //
        // The shader does not need a shadow map for this. It knows the wall
        // height (uRoadDepth), it knows the sun (uSunXZ, live from the key), and
        // it can read the zone mask anywhere it likes. So: march up-sun through
        // the mask; if the ground that way is terrace, this lane fragment is in
        // its shadow. Continuous, correctly directed, and it cannot alias.
        float kerbShade = 0.0;
        if (wRoad > 0.02) {
          vec2 duv = uSunXZ * uKerbShadow / (uArenaHalf * 2.0);
          float occ = 0.0;
          for (int s = 0; s < 4; s++) {
            float t = (float(s) + 0.55) * 0.25;
            vec4 mm = texture2D(uMask, clamp(muv + duv * t, vec2(0.002), vec2(0.998)));
            float up = 1.0 - smoothstep(uKerbLo, uKerbHi, mm.r);
            occ = max(occ, up * (1.0 - t * 0.5));
          }
          kerbShade = occ * smoothstep(0.02, 0.35, wRoad);
        }

        // =====================================================================
        // COMPOSITION PASS — the focal hierarchy
        // ---------------------------------------------------------------------
        // Everything above produces *material*. Everything below produces
        // *picture*: a stage-lit plate that is brightest and warmest through
        // the centre of mass and recedes into cool, dry, crumbling dark at the
        // rim, with three separate scales of staining on top so no region of
        // the plate holds the same value as its neighbour.
        // =====================================================================

        // Elliptical radius from the composition focus. 0 at the focus, 1 at
        // the middle of a long edge, ~1.4 in the corners.
        vec2 fr = (wxz - uFocus) / uArenaHalf;
        float rad = length(fr);
        // Ragged, not a clean vignette: break the isocurve with two noise scales
        // so it never reads as a post-process circle sitting on the art.
        rad += (mac1.r - 0.5) * 0.30 + (mac2.g - 0.5) * 0.13;
        float centre = 1.0 - smoothstep(0.10, 1.02, rad);   // 1 centre -> 0 rim
        float rimness = smoothstep(0.62, 1.16, rad);         // 0 centre -> 1 rim

        // =====================================================================
        // THE GOBO — large-scale value break  (round 3, critic action #4)
        // ---------------------------------------------------------------------
        // Round 2 answered "the board is one value edge to edge" with three
        // octaves of multiplicative noise deliberately tuned to preserve a mean
        // of 1.0. Preserving the mean was correct; the amplitudes were not. The
        // slowest octave came off a *texture* sampled at 0.34x, which is a
        // gentle swell, and after the highlight rolloff the whole plate landed
        // inside a ~15% value band. Both the environment agent and the blind
        // critic read the result as flat cardboard, independently.
        //
        // The fix is not more noise. It is a deliberately AUTHORED shadow
        // pattern with a wavelength comparable to the board itself — broken
        // cloud, or the ground-shadow of architecture standing off-frame. Three
        // non-commensurate plane waves, each rotated to a different heading and
        // domain-warped by the two world-scale macro fields, so the isolines are
        // organic and asymmetric but the SCALE is under our control instead of
        // being whatever the noise texture happened to contain.
        //
        // Computed analytically: three sin() are cheaper than another texture
        // fetch, and unlike a texture the wavelength cannot drift when the
        // board is resized.
        // MEASURED, and it changed the design. With uAlbedoGain forced to 0 the
        // board still renders at L=75.5 against a full-albedo L=86.7 — the
        // ground's DIFFUSE term owns only ~13% of the final pixel. It is not
        // the env map (L=75.5 with envMapIntensity 0) and it is not the fog
        // (L=74.9 with scene.fog null). It is the 4% dielectric specular lobe
        // of a 7.60-intensity key: at that intensity F0=0.04 outshines a
        // 0.2-albedo stone. Which means an albedo-only value break — round 2's
        // approach, and this round's first attempt — is mathematically incapable
        // of moving the plate more than a few L. Both critics were describing a
        // flatness that lives in the LIGHTING response, not in the texture.
        //
        // So the gobo attenuates the light itself, at <lights_fragment_end>,
        // exactly as a real gobo in front of the key would. Same field also
        // drives albedo/roughness/hue below so the shadow has material
        // consequences (damp in the shade, bleached drift in the sun) rather
        // than reading as a multiply layer.
        vec2 gp = wxz * 0.030;
        // The warp amplitudes matter more than they look. gp spans only +-0.78
        // across the board, so the 0.66 warp the first attempt used displaced
        // the field by up to 22 world units — the "gobo" was then just noise at
        // the macro texture's own scale, which is what produced the blotchy
        // continent-map read. Kept to 0.15/0.07 the wave layout survives and
        // the noise only ragged-edges it.
        gp += (vec2(mac2.r, mac2.b) - 0.5) * 0.15;   // ~2.7-tile organic warp
        gp += (vec2(mac3.g, mac3.a) - 0.5) * 0.07;   // ~6-tile ragged edges
        // The phase on the leading wave is not arbitrary: it parks the largest
        // shadow mass over the board's RIGHT half, which is where the azimuth
        // -48 key's specular lobe peaks (measured, with the ground albedo
        // zeroed: L=84.6 on the right against L=50.7 on the left). The gobo
        // therefore does double duty — it supplies the value structure AND
        // takes the top off the lighting's own left/right ramp, which is the
        // residual asymmetry round 2 flagged and could not explain.
        // Phase 1.40 was chosen by evaluating the field on a 51x39 world
        // lattice: mean 0.58, sd 0.25, centre 0.73, left 0.54, right 0.46,
        // near 0.58, far 0.60. Lit through the middle where the eye lands and
        // through the near-left, falling away to the far corners and the right.
        //
        // An earlier phase (1.95) parked a much heavier mass over the right
        // half to cancel the key's specular hotspot there. Once uSpecF90 fixed
        // that hotspot at source the correction became an over-correction and
        // simply flipped the asymmetry (board halves went 93.9 vs 56.0 the
        // other way). 1.40 is the balanced one: measured board halves L=81.2
        // left vs L=63.4 right, a gentle 1.28:1 that reads as raking light —
        // against 50.7 vs 84.6 (1:1.67 the other way) for round 2's lighting.
        float gW = sin(dot(gp, vec2( 0.83,  0.56)) * 3.10 + 1.40) * 0.42
                 + sin(dot(gp, vec2(-0.42,  0.91)) * 2.05 - 1.87) * 0.34
                 + sin(dot(gp, vec2( 0.97, -0.24)) * 1.33 + 2.44) * 0.30;
        // 0 = deep in shadow, 1 = full sun. Sampled on a 3x3 lattice across the
        // board this lands at mean 0.503, min 0.04, max 0.87.
        float gobo = smoothstep(0.0, 1.0, clamp(gW * 0.66 + 0.5, 0.0, 1.0));
        // Keep the road legible: the lane's read comes from its kerb and its
        // hue, and dropping a 2.9:1 shadow across it would cost more than the
        // value structure buys. It still gets 55% of the effect so the shadow
        // does not visibly stop at the kerb.
        float goboRoad = mix(gobo, mix(0.5, gobo, 0.55), wRoad);

        // THE LIGHT TERM. Symmetric about 1.0 so the plate's mean brightness —
        // and therefore the 2.42x board-vs-backdrop separation the environment
        // agent just won — is preserved exactly, while the extremes open to a
        // genuine 3.3:1. Floored at 0.44 so the darkest pools still hold
        // chromatic detail rather than crushing (G7).
        gShadow = max(0.54, 1.0 + (goboRoad - 0.5) * 0.98);
        // Shadow is where the sky, not the sun, is doing the lighting: what the
        // gobo removes is the amber key, so what remains is violet. Tinting the
        // surviving light rather than the albedo is what makes this read as
        // shadow instead of as a dark patch of stone.
        gShadowTint = mix(vec3(0.72, 0.83, 1.18), vec3(1.10, 1.01, 0.90),
                          smoothstep(0.0, 1.0, goboRoad));
        // The terrace's own shadow, applied to the LIGHT for the same reason
        // the gobo is: 87% of this plate's value comes from the specular lobe,
        // so an albedo-side darkening would barely move. Floored well above
        // black — the fill and the sky bounce still reach the lane (G7).
        gShadow *= mix(1.0, uKerbShadowK, kerbShade);
        // SKY OCCLUSION IN THE CHANNEL.
        //
        // ~87% of this plate's value is the dielectric specular lobe of the key
        // (measured in round 3, see uSpecF90), which is why albedo work on the
        // lane kept failing to move it: at 0.44 road gain the lane vs terrace
        // separation was still only Cohen's d 0.43. The lane is a one-unit-deep
        // channel with walls on both sides — it genuinely sees less sky and less
        // of the key's grazing response than the open terrace does, and that is
        // a LIGHT term, so it is the one that can actually shift the pixels.
        gShadow *= mix(1.0, uLaneSky, wRoad);
        aoT *= 1.0 - wRoad * 0.14;
        gShadowTint = mix(gShadowTint, gShadowTint * vec3(0.80, 0.88, 1.16),
                          kerbShade * 0.85);

        // A smaller albedo-side component. Real shadowed ground is not only
        // darker-lit, it is also materially different — damper, less dusty —
        // and that difference survives when the eye discounts the illuminant.
        float goboVal = mix(0.70, 1.18, goboRoad);
        // Deep shadow = damp: pooled water and wet ash have a specular sheen,
        // and that sheen is what stops a dark region reading as "turned down"
        // rather than as "in shadow".
        float goboDamp = smoothstep(0.34, 0.0, goboRoad);
        // Full sun = dry: bleached ash drift, higher roughness, lower contrast.
        float goboDry = smoothstep(0.70, 1.0, goboRoad);

        // Remaining noise octaves, at reduced amplitude. Their job is now only
        // to keep the gobo's own isolines from reading as bands.
        float macroVal = (mac0.g - 0.5) * 2.0;
        float midVal   = (mac1.g - 0.5) * 2.0;
        float fineVal  = (mac3.g - 0.5) * 2.0;
        float stain = macroVal * 0.13 + midVal * 0.12 + fineVal * 0.10;
        float valMul = (1.0 + stain) * goboVal;

        // Stage falloff. Softened from round 2 (0.60/1.46) because the gobo now
        // carries the value story; leaving both at full strength stacked two
        // large-scale gradients and the corners went to mud.
        float stage = mix(uRimDark, uCentreLift, centre);
        valMul *= stage;
        albedoT *= valMul;

        // Colour temperature travels with the falloff AND with value: what is
        // lit is warm, what is in shadow is cold. That coupling is the single
        // thing that separates "graded" from "tinted".
        //
        // NOTE the polarity change in round 3. uWarmCentre is now barely warm
        // and uCoolRim is strongly violet, because the #ffd096 key at 7.6 is
        // doing the warming. The albedo only has to make sure that where the
        // key does NOT reach, the stone is cold.
        float warmth = clamp(centre * 0.72 + (goboRoad - 0.5) * 0.90 + stain * 0.45 + 0.12, 0.0, 1.0);
        albedoT *= mix(uCoolRim, uWarmCentre, warmth);
        // ...plus per-region hue drift from the macro texture's own warm/cool
        // split, so the temperature gradient is not a single clean ramp either.
        vec3 tint = (mac1.rgb - 0.5) * 2.0;
        albedoT *= 1.0 + tint * vec3(0.13, 0.11, 0.19);
        albedoT *= 1.0 + (mac0.rgb - 0.5) * 0.16;

        // Damp pooled in the gobo shadows, bleached ash drifted in the sun.
        // Kept deliberately light. Roughness is the OTHER lever on the specular
        // term that dominates this surface, so a big roughness drop in the
        // shadows would hand back in specular exactly what gShadow just took
        // away — the two levers fight.
        roughT = mix(roughT, 0.44, goboDamp * 0.40);
        albedoT *= mix(vec3(1.0), vec3(0.78, 0.84, 0.98), goboDamp * 0.55);
        aoT *= 1.0 - goboDamp * 0.16;
        roughT = mix(roughT, 0.97, goboDry * 0.22);
        albedoT = mix(albedoT, albedoT * 0.80 + vec3(0.055, 0.054, 0.058), goboDry * 0.34);

        // Hard-edged soot fields. Same argument as the rubble islands: the plate
        // needs boundaries, not only ramps. Two thresholds at two scales give
        // large burnt sheets with smaller scorches inside them.
        float soot = smoothstep(0.520, 0.660, mac1.a * 0.30 + mac3.r * 0.26 + mac2.b * 0.44)
                   + smoothstep(0.63, 0.74, mac2.a) * 0.40;
        soot = clamp(soot, 0.0, 1.0) * (1.0 - wRoad * 0.7);
        // Soot is carbon: cold, slightly blue-black, never the warm brown-black
        // round 2 used — a warm dark on a warm plate is just another beige.
        albedoT = mix(albedoT, albedoT * vec3(0.50, 0.52, 0.60) + vec3(0.004, 0.004, 0.006),
                      soot * 0.30);
        roughT = mix(roughT, 0.97, soot * 0.42);


        // Traffic haze: dust thrown off the lane greys the flagstone beside it.
        // This is wear concentrated where traffic converges, and it is what
        // makes the maze read as a *used* route rather than a painted stripe.
        float halo = smoothstep(0.02, 0.42, roadRaw) * (1.0 - wRoad);
        albedoT *= mix(1.0, 0.74, halo * 0.85);
        albedoT.rgb = mix(albedoT.rgb, vec3(dot(albedoT.rgb, vec3(0.34, 0.42, 0.24))),
                          halo * 0.30);

        // Rim: drier, dustier, more broken. Roughness goes up, AO goes down,
        // and the stone loses saturation as it crumbles.
        roughT = clamp(roughT
          + (mac1.r - 0.5) * 0.30
          + (mac2.b - 0.5) * 0.16
          + rimness * 0.16
          - centre * 0.10, 0.05, 1.0);
        aoT *= 1.0 - rimness * 0.26;
        albedoT *= mix(0.90 + mac2.r * 0.26, 1.0, wRoad * 0.5);

        // Local stone value, used to express the accents below as RATIOS of the
        // surrounding plate rather than as absolute colours. Absolutes do not
        // survive an exposure change: at uAlbedoGain 9.6 a "light dressed
        // stone" constant that was sensible at gain 1 became a blown white
        // ribbon running the length of the lane.
        float stoneV = dot(albedoT, vec3(0.30, 0.42, 0.28)) + 0.004;

        // ---- THE TERRACE EDGE LINE -------------------------------------------
        // At the gameplay camera the wall face itself is only a handful of
        // pixels and is occluded entirely on the near side of every terrace.
        // What actually carries the maze at that distance is a two-tone EDGE:
        // a lit capping course on top, a dark line immediately below it. Every
        // reference plate has exactly this, and it is why you can read an ETD2
        // maze at a glance from any zoom.
        float capLine = smoothstep(uKerbLo - 0.075, uKerbLo - 0.005, roadRaw)
                      * (1.0 - smoothstep(uKerbLo - 0.005, uKerbLo + 0.055, roadRaw));
        float footLine = smoothstep(uKerbHi - 0.01, uKerbHi + 0.06, roadRaw)
                       * (1.0 - smoothstep(uKerbHi + 0.06, uKerbHi + 0.20, roadRaw));

        // ---- dressed capping course along the terrace edge -------------------
        // Round 3 painted the whole kerb band as a bright dressed block plus a
        // white "arris" line — a strip of tape running the length of the lane,
        // trying to fake a step that was only 0.23 of a cell deep. The step is
        // now real geometry with real masonry on it (see the wall block above),
        // so all that is left to do here is lift the very top edge, where a
        // capstone genuinely catches the key.
        albedoT = mix(albedoT, uKerbColor * stoneV * 3.4, capLine * 0.62);
        roughT = mix(roughT, 0.38, capLine * 0.65);
        // ...and the shaded reveal directly under it. Dark-under-light is the
        // whole trick; either half alone reads as a smudge.
        albedoT *= 1.0 - footLine * 0.42;
        aoT *= 1.0 - footLine * 0.45;
        roughT = mix(roughT, 0.95, footLine * 0.4);

        // ---- road polish: the centre line is burnished by traffic ------------
        float polish = smoothstep(0.62, 1.0, mk.r) * wRoad;
        roughT = mix(roughT, 0.32, polish * 0.8);
        albedoT *= 1.0 - polish * 0.13;

        // ---- footfall scuffing along the route the creeps actually walk ------
        // "A worn path along the actual enemy route — darker, polished,
        // footfall-scuffed." The route is correct now (PathMask re-solves on
        // every maze change; markPathDirty had zero callers for three rounds and
        // that is fixed), and it is already a sunken channel with a kerb, so
        // what is missing is only the surface story of being walked on.
        //
        // Deliberately NOT another albedo term for the lane as a whole: round 4b
        // swept uRoadGain 0.44 -> 0.26 and moved the lane's rendered mean by
        // 0.2 L, because ~87% of this plate's value is the key's dielectric
        // specular lobe. Albedo cannot move G8. So the scuffs are expressed in
        // ROUGHNESS — the other lever on that same specular term — as a fine,
        // broken pattern of dulled and burnished patches. It costs no mean
        // separation at all (it is symmetric about the lane's own roughness),
        // it only adds the texture the critics said was absent at this distance.
        float scuffN = mac4.a * 0.55 + mac4.r * 0.25 + mac2.b * 0.20;
        float scuff = smoothstep(0.44, 0.66, scuffN) * wRoad;
        float burnish = smoothstep(0.42, 0.24, scuffN) * wRoad;
        roughT = clamp(mix(roughT, 0.99, scuff * 0.55), 0.05, 1.0);
        roughT = clamp(mix(roughT, 0.30, burnish * 0.45), 0.05, 1.0);
        aoT *= 1.0 - scuff * 0.10;

        // ---- grime banked against tower footprints --------------------------
        albedoT *= 1.0 - mk.b * 0.13;
        aoT *= 1.0 - mk.b * 0.22;

        // ---- the apron each tower stands in ---------------------------------
        // The critic read our per-tower glow pools as "loud rings sitting ON the
        // art rather than light falling INTO it". The fix is not in the decal,
        // it is here: the stone around a tower base has to be able to RECEIVE
        // coloured light. Mask.b is a proximity-to-tower field, so we use it to
        // lay down a damp, part-polished apron whose roughness drops toward the
        // plinth. Low roughness -> a real specular lobe -> the tower's point
        // light produces a soft elemental sheen on the flagstone instead of a
        // flat additive disc. It also darkens the albedo slightly, so the light
        // reads as sitting in a dark pool rather than washing out pale stone.
        float apron = smoothstep(0.14, 0.78, mk.b) * (1.0 - wRoad * 0.8);
        roughT = mix(roughT, 0.42, apron * 0.55);
        albedoT *= mix(1.0, 0.93, apron);
        // damp fringe: a slightly bluer, darker collar right at the base
        float collar = smoothstep(0.52, 0.92, mk.b);
        albedoT *= mix(vec3(1.0), vec3(0.86, 0.90, 1.0), collar * 0.7);
        nxyT *= 1.0 - apron * 0.32;

        // ---- mineral bloom in the damp lows ---------------------------------
        // Pale efflorescent crust creeping out of the low, wet ground. Cheap,
        // and it puts a genuinely different hue on the plate at a third scale.
        float bloom = smoothstep(0.44, 0.86, mk.a * 0.7 + mac1.a * 0.5)
                    * (1.0 - wRoad) * (0.35 + rimness * 0.75);
        albedoT = mix(albedoT, vec3(0.86, 0.97, 1.09) * stoneV * (0.9 + mac2.g * 1.1), bloom * 0.42);
        roughT = mix(roughT, 0.94, bloom * 0.5);

        // ---- standing water in the lows -------------------------------------
        // Tight threshold on purpose. Water is a punctuation mark: a few small
        // bright specular hits in genuine lows. Opened up even slightly it
        // becomes a sheet across a third of the plate that flattens every
        // normal it touches, which is exactly what happened first time round.
        float pool = smoothstep(0.86, 0.98, mac1.a * 0.58 + mk.a * 0.46 + mac2.a * 0.20);
        pool *= 1.0 - wDecay * 0.95;
        pool *= 1.0 - bloom * 0.6;
        pool *= 0.85;
        roughT = mix(roughT, 0.06, pool);
        albedoT *= mix(1.0, 0.55, pool);
        nxyT *= 1.0 - pool * 0.85;
        nxyT += vec2(sin(wxz.x * 5.3 + uTime * 0.7), cos(wxz.y * 4.7 - uTime * 0.55))
                * 0.014 * pool;

        // ---- macro relief from the mask itself -------------------------------
        // NOTE: this used to be the ONLY thing telling the shader that the kerb
        // existed, at a gain of 0.40 on a raw one-texel difference — about 0.05
        // of normal tilt on a step that is now a full world unit deep. The real
        // slope is computed analytically below (see TERRACE SLOPE NORMAL); this
        // stays only as a light macro undulation.
        nxyT += vec2(hR - hL, hU - hD) * 0.18;

        albedoT = max(albedoT, vec3(0.0025));
        gRough = roughT;
        gAO = clamp(mix(1.0, aoT, uAOGain * 0.95), 0.04, 1.0);
        // Exposure, applied last so it scales the whole plate uniformly and
        // preserves every value relationship the composition pass established.
        // The accents that this used to blow out — the kerb arris and the
        // engraved channels — were fixed by lowering THEIR weights rather than
        // by moving the exposure ahead of them, which merely traded a pair of
        // white stripes for a plate that had gone 35% dark.
        albedoT *= uAlbedoGain;
        // Guard rail.
        //
        // In round 2 it sat mid-shader with a 0.42 knee, and with the old
        // 0.88-peak flagstone the entire sunlit half of the plate arrived above
        // 0.9 and left between 0.59 and 0.65 — a 3:1 input range squeezed into
        // 1.1:1. Every large-scale value difference produced upstream was being
        // deleted by this one line. That is the mechanical half of the
        // "cardboard" read; the specular half is documented at uSpecF90.
        albedoT = albedoT / (1.0 + max(vec3(0.0), albedoT - 2.20) * 0.45);
        // =====================================================================
        // TERRACE SLOPE NORMAL — the wall was displaced but never SHADED
        // ---------------------------------------------------------------------
        // PlaneGeometry.computeVertexNormals() runs on the flat plane, and the
        // kerb displacement happens afterwards in the vertex shader. So every
        // vertex normal on the board points straight up, including the ones on
        // a one-unit vertical wall. The wall was being lit as though it were
        // floor: no light/dark break at the terrace edge at all, which is
        // exactly why the maze still would not read after the geometry existed.
        //
        // Differentiate the sink field instead. sink = D * smoothstep(lo,hi,r),
        // so d(sink)/dxz = D * s'(r) * dr/dxz, with s'(t) = 6t(1-t)/(hi-lo) and
        // dr/dxz from the same mask taps the drop shadow already uses. Exact,
        // one multiply, and it tracks uRoadDepth automatically.
        vec2 texelW = (uArenaHalf * 2.0) * uMaskTexel;
        vec2 dRoad = vec2(hR - hL, hU - hD) / max(vec2(1e-4), 2.0 * texelW);
        float kSpan = max(1e-4, uKerbHi - uKerbLo);
        float tK = clamp((roadRaw - uKerbLo) / kSpan, 0.0, 1.0);
        float dK = 6.0 * tK * (1.0 - tK) / kSpan;
        vec2 slope = dRoad * dK * uRoadDepth;
        // Clamped: past ~4:1 the face is vertical for shading purposes anyway,
        // and an unclamped derivative on a bilinear field spikes at texel edges.
        float sl = length(slope);
        if (sl > 4.0) slope *= 4.0 / sl;
        vec3 baseN = normalize(vec3(slope, 1.0));

        vec2 nfin = nxyT * uNormalGain;
        float nlen2 = min(0.92, dot(nfin, nfin));
        vec3 detN = normalize(vec3(nfin, sqrt(1.0 - nlen2)));
        // UDN blend: detail rides on the macro slope without cancelling it.
        gMapN = normalize(vec3(baseN.xy + detN.xy * baseN.z, baseN.z));

        // ---- emissive engraved channels -------------------------------------
        float breathe = 0.5 + 0.5 * sin(uTime * 0.8 - length(wxz) * 0.05);
        // Distance LOD. The engraving is a sub-texel feature at gameplay zoom,
        // and a sub-texel emissive feature is an aliasing machine: it flickers,
        // and it resolves into whatever shape the sampler happens to pick. So
        // it is dissolved to nothing well before it stops being resolvable,
        // using the detail UV's own screen-space derivative — which means it
        // fades correctly at any camera distance, FOV or resolution rather than
        // at a hard-coded range.
        float seamLod = 1.0 - smoothstep(0.0030, 0.0115,
                                         max(fwidth(uvF1.x), fwidth(uvF1.y)));
        gEmissive = uSeamColor * seam * wFlag * uSeamGain * (0.28 + breathe * 0.8) * seamLod;
        gEmissive *= 1.0 - pool * 0.4;
        // The channels are part of the composition too: brightest through the
        // focus, guttering out toward the crumbling rim.
        gEmissive *= mix(0.30, 1.35, centre);

        diffuseColor.rgb = albedoT;

        if (uDebug > 10.5 && uDebug < 11.5) {
          // Composition probe: the gobo field itself, unlit and unbloomed.
          diffuseColor.rgb = vec3(0.0);
          gEmissive = vec3(gobo * 0.22) + vec3(0.10, 0.0, 0.0) * step(0.0, wxz.x);
          gRough = 1.0; gAO = 1.0; gMapN = vec3(0.0, 0.0, 1.0);
        } else if (uDebug > 9.5 && uDebug < 10.5) {
          // Neutral reference for the albedo probe. The post chain applies a
          // warm grade, so an absolute hue reading off uDebug=9 is meaningless;
          // what is meaningful is uDebug=9 measured AGAINST this known-neutral
          // patch pushed through the identical chain.
          diffuseColor.rgb = vec3(0.0);
          gEmissive = vec3(0.22);
          gRough = 1.0; gAO = 1.0; gMapN = vec3(0.0, 0.0, 1.0);
        } else if (uDebug > 8.5 && uDebug < 9.5) {
          // ALBEDO PROBE. Emits the final diffuse albedo unlit, so tools/sample
          // can measure the plate's true base hue/saturation independently of
          // the key light. Round 3's whole premise is that these two must now
          // point in OPPOSITE directions: cold albedo, warm render.
          diffuseColor.rgb = vec3(0.0);
          gEmissive = albedoT;
          gRough = 1.0; gAO = 1.0; gMapN = vec3(0.0, 0.0, 1.0);
        } else if (uDebug > 7.5 && uDebug < 8.5) {
          // reference probe: a plain 50% grey lambert-ish surface
          diffuseColor.rgb = vec3(0.5);
          gRough = 0.7; gAO = 1.0; gMapN = vec3(0.0, 0.0, 1.0); gEmissive = vec3(0.0);
        } else if (uDebug > 0.5 && uDebug < 19.5) {
          if (uDebug < 1.5)      diffuseColor.rgb = vec3(wFlag, wRoad, wDecay);
          else if (uDebug < 2.5) diffuseColor.rgb = vec3(pool, kerb, mk.a);
          else if (uDebug < 3.5) diffuseColor.rgb = vec3(gRough);
          else if (uDebug < 4.5) diffuseColor.rgb = vec3(gAO);
          else if (uDebug < 5.5) diffuseColor.rgb = mk.rgb;
          else if (uDebug < 6.5) diffuseColor.rgb = texture2D(uMask, vTUv).rgb;
          else                   diffuseColor.rgb = vec3(vTUv, 0.0);
          gEmissive = diffuseColor.rgb * 2.0;
          gRough = 1.0; gAO = 1.0; gMapN = vec3(0.0, 0.0, 1.0);
        }
      `)
      .replace('#include <opaque_fragment>', `
        #include <opaque_fragment>
        if (uDebug > 19.5) {
          vec3 dbg = vec3(0.0);
          if (uDebug < 20.5) dbg = reflectedLight.directDiffuse;
          else if (uDebug < 21.5) dbg = reflectedLight.directSpecular;
          else if (uDebug < 22.5) dbg = reflectedLight.indirectDiffuse;
          else if (uDebug < 23.5) dbg = reflectedLight.indirectSpecular;
          else dbg = totalEmissiveRadiance;
          gl_FragColor = vec4(dbg, 1.0);
        }
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness;')
      .replace('#include <lights_physical_fragment>', /* glsl */`
        #include <lights_physical_fragment>
        // NOTE for anyone who repeats this: three r185 splits the old
        // material.specularColor into specularColor (indirect / IBL) and
        // material.specularColorBlended (what BRDF_GGX actually uses as f0 for
        // DIRECT light — lights_physical_pars_fragment.glsl.js:155). Writing
        // only specularColor, as every pre-r18x snippet does, silently changes
        // nothing about the direct highlight. It cost an hour to find.
        //
        // And the reason this matters here: for a MeshStandardMaterial the same
        // chunk hard-sets material.specularF90 = 1.0, so every dielectric in
        // the scene has a grazing Fresnel that runs all the way to WHITE. At a
        // 55 deg camera pitch over a normal-mapped floor, under a 7.60 amber
        // key, that white-hot rim response is what was painting the plate
        // beige from edge to edge, and it is completely deaf to albedo.
        //
        // THE LANE IS NOT DRESSED STONE (round 4b, G8).
        //
        // Sweeping uRoadGain from 0.44 to 0.26 moved the lane's rendered mean by
        // 0.2 L. That is the round-3 finding again, in its second location: the
        // plate's value is coming out of the dielectric specular lobe of a 7.6
        // amber key, not out of the albedo, so ALBEDO WORK ON THE ROAD CANNOT
        // MOVE G8 EITHER. Trodden ash scatters and does not reflect; giving the
        // lane its own, much lower F0 is both the physical truth and the only
        // lever that reaches it.
        float roadSpec = mix(1.0, uRoadSpec, clamp(gRoadW, 0.0, 1.0));
        material.specularColor *= uSpecTint * roadSpec;
        material.specularColorBlended *= uSpecTint * roadSpec;
        material.specularF90 *= uSpecF90 * roadSpec;
      `)
      // The gobo. Direct light takes the full attenuation and the full colour
      // shift; indirect specular takes 60% of it (the sky is still open above a
      // cloud shadow, so the env reflection does not vanish with the sun);
      // indirect diffuse is left alone, which is what keeps the deepest pools
      // off the crush floor.
      .replace('#include <lights_fragment_end>', /* glsl */`
        #include <lights_fragment_end>
        reflectedLight.directDiffuse  *= gShadow * gShadowTint;
        reflectedLight.directSpecular *= gShadow * gShadowTint;
        reflectedLight.indirectSpecular *= mix(1.0, gShadow, 0.60);
      `)
      .replace('#include <normal_fragment_maps>', 'normal = normalize( tbn * gMapN );')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += gEmissive;')
      .replace('#include <aomap_fragment>', /* glsl */`
        float ambientOcclusion = gAO;
        reflectedLight.indirectDiffuse *= ambientOcclusion;
        #if defined( USE_ENVMAP ) && defined( STANDARD )
          float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
          reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
        #endif
      `);

    mat.userData.shader = shader;
  };

  mat.customProgramCacheKey = () => 'arena-ground-v14';
  return mat;
}

/** Depth twin so the kerb casts the shadow its real silhouette implies. */
export function createGroundDepthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_COMMON)
      .replace('#include <begin_vertex>', VERT_BEGIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec2 vTUv;
        varying vec3 vTWorld;
      `);
  };
  mat.customProgramCacheKey = () => 'arena-ground-depth-v4';
  return mat;
}

/**
 * Compact material for everything else built from the same packed maps
 * (albedo RGBA + normal.xy/rough/AO). Keeps the rim on the exact same stone as
 * the floor without generating a second texture set.
 */
export function createPackedStoneMaterial(albedo, nra, {
  color = 0xffffff, normalGain = 1.0, roughBias = 0.0, envMapIntensity = 0.5,
  emissive = 0x000000, emissiveIntensity = 1.0, uvScale = 1.0,
} = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: nra,
    roughnessMap: nra,
    aoMap: nra,
    color: new THREE.Color(color),
    roughness: 1.0,
    metalness: 0.0,
    emissive: new THREE.Color(emissive),
    emissiveIntensity,
    envMapIntensity,
  });
  const uniforms = {
    uNGain: { value: normalGain },
    uRBias: { value: roughBias },
    uUvScale: { value: uvScale },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying float vCoping;\n attribute float aCoping;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vCoping = aCoping;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uNGain, uRBias, uUvScale;
        varying float vCoping;
        float gR2 = 1.0; float gAO2 = 1.0; vec3 gN2 = vec3(0.0,0.0,1.0);
      `)
      .replace('#include <map_fragment>', /* glsl */`
        vec2 puv = vMapUv * uUvScale;
        vec4 pa = texture2D(map, puv);
        vec4 pn = texture2D(normalMap, puv);
        diffuseColor.rgb *= pa.rgb;
        // coping blocks are dressed stone: lighter and cleaner than the fabric
        diffuseColor.rgb *= mix(1.0, 1.28, vCoping);
        gR2 = clamp(pn.b + uRBias - vCoping * 0.12, 0.04, 1.0);
        gAO2 = pn.a;
        vec2 nxy = (pn.rg - 0.5) * 2.0 * uNGain;
        gN2 = normalize(vec3(nxy, sqrt(max(0.05, 1.0 - dot(nxy, nxy)))));
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gR2;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( tbn * gN2 );')
      .replace('#include <aomap_fragment>', /* glsl */`
        float ambientOcclusion = gAO2;
        reflectedLight.indirectDiffuse *= ambientOcclusion;
        #if defined( USE_ENVMAP ) && defined( STANDARD )
          float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
          reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
        #endif
      `);
  };
  mat.customProgramCacheKey = () => `packed-stone-${uvScale}`;
  return mat;
}

/**
 * THE BOARD'S PERIMETER RETAINING WALL  (round 4b).
 *
 * Until now the board's edge was a platform edge: a coping, a rune fascia, a
 * moulding, a battered wall running down to y = -5.6 and a black underbelly
 * slab at -6.5. That geometry only makes sense over a void, and the void was
 * deleted from the Art Bible (law 1). The edge is now a LOW retaining wall of
 * the same height as an interior terrace wall, with the landscape continuing
 * outward from its foot at lane-floor level.
 *
 * It is therefore built in the same visual language as the terrace walls in
 * createGroundMaterial: coursed masonry, analytic, in world units, with zero
 * per-block geometry. Courses run off WORLD Y so they stay level whatever the
 * per-stone jitter does to the profile; blocks run off the path's own ARC
 * LENGTH (the `aU` attribute) so the coursing is continuous around the loop and
 * agrees exactly with the coping blocks laid on top of it.
 *
 * `aWall` gates the masonry so the same material can still be used for the
 * portal monoliths (which carry aWall = 0 and get plain dressed stone).
 */
export function createRimStoneMaterial(albedo, nra, {
  color = 0xffffff, normalGain = 1.0, roughBias = 0.0, envMapIntensity = 0.5,
  uvScale = 1.0, courseH = 0.335, blockLen = 0.95, stoneLen = 2.05,
  wallTop = 0.14,
} = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: nra,
    roughnessMap: nra,
    aoMap: nra,
    color: new THREE.Color(color),
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity,
  });
  const uniforms = {
    uNGain: { value: normalGain },
    uRBias: { value: roughBias },
    uUvScale: { value: uvScale },
    uCourseH: { value: courseH },
    uBlockLen: { value: blockLen },
    uStoneLen: { value: stoneLen },
    uWallTop: { value: wallTop },
    // Diagnostic. Nine features in this project were implemented, reviewed and
    // TUNED while never actually rendering; "the wall is there, it is just
    // subtle" is exactly the claim that hides that. 1 paints the tag fields
    // (red = coursed wall face, green = coping) so the question becomes a pixel
    // count instead of an opinion.
    uDebugTag: { value: 0 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aCoping;
        attribute float aWall;
        attribute float aU;
        attribute float aBreach;
        varying float vCoping;
        varying float vWall;
        varying float vArc;
        varying float vBreach;
        varying vec3 vRimWorld;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vCoping = aCoping;
        vWall = aWall;
        vArc = aU;
        vBreach = aBreach;
        vRimWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uNGain, uRBias, uUvScale;
        uniform float uCourseH, uBlockLen, uStoneLen, uWallTop, uDebugTag;
        varying float vCoping;
        varying float vWall;
        varying float vArc;
        varying float vBreach;
        varying vec3 vRimWorld;
        float rh1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
        float rh2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gR2 = 1.0; float gAO2 = 1.0; vec3 gN2 = vec3(0.0,0.0,1.0);
      `)
      .replace('#include <map_fragment>', /* glsl */`
        vec2 puv = vMapUv * uUvScale;
        vec4 pa = texture2D(map, puv);
        vec4 pn = texture2D(normalMap, puv);
        diffuseColor.rgb *= pa.rgb;
        gR2 = clamp(pn.b + uRBias - vCoping * 0.12, 0.04, 1.0);
        gAO2 = pn.a;
        vec2 nxy = (pn.rg - 0.5) * 2.0 * uNGain;

        // =====================================================================
        // VALUE ALONG THE RUN  (round 5 — law 6)
        // ---------------------------------------------------------------------
        // "Value varying along their length" is one of the four things law 6
        // names, and it is the one that costs nothing. Four non-commensurate
        // waves on the ARC COORDINATE (which is continuous around the loop and
        // does not care where the corners are) plus a hard-thresholded soiling
        // field give the wall long stretches of dark, damp, lichened stone
        // between the lit ones. Before this, every metre of the perimeter held
        // the same value, which is precisely what turns a wall into a bar.
        float rs = vArc;
        float runW = sin(rs * 0.071 + 0.6) * 0.42
                   + sin(rs * 0.163 - 2.1) * 0.31
                   + sin(rs * 0.417 + 1.3) * 0.18
                   + sin(rs * 1.070 - 0.7) * 0.09;
        float runV = clamp(runW * 0.62 + 0.5, 0.0, 1.0);
        // Hard-edged soiling: a boundary you can point at, not another ramp.
        // Threshold measured off a capture: at 0.50 only ~28% of the run went
        // dark and the wall still read as one bar with faint mottling. At 0.58
        // it is roughly half lit, half filthy, which is what an interrupted
        // wall looks like and what stops the eye tracking along it.
        float soil = smoothstep(0.58, 0.32, runV);
        // Damp shade at the wall foot, driest along the coping. The rim is the
        // LOWEST-saturation family of surfaces in frame (law 4), so this is a
        // value + neutrality move, never a hue move.
        float wet = clamp((uWallTop - vRimWorld.y) / 1.10, 0.0, 1.0);

        // ---- coursed masonry, analytic, world units -------------------------
        // Tangent space on a swept profile is exactly (along the path, down the
        // profile), because the uv is (arc length, profile arc length). So the
        // course grooves perturb .y and the block joints perturb .x, with no
        // basis juggling at all.
        float wallW = clamp(vWall, 0.0, 1.0);
        if (wallW > 0.004) {
          float crs = (uWallTop - vRimWorld.y) / uCourseH;
          float cid = floor(crs);
          float cf  = fract(crs);
          float srun = vArc / uBlockLen + rh1(cid * 2.7 + 1.3) * 4.7 + cid * 0.5;
          float bid = floor(srun);
          float bf  = fract(srun);

          float mAA = max(fwidth(crs), fwidth(srun)) * 0.9 + 1e-4;
          // Ragged mortar. A clean line is a CAD drawing; the threshold wanders
          // on a hash of the block so corners are lost and courses breathe.
          float rag = (rh2(vec2(bid, cid) * 3.1 - 2.0) - 0.5) * 0.055;
          float mv = 1.0 - smoothstep(0.078 + rag - mAA, 0.078 + rag + mAA, min(bf, 1.0 - bf));
          float mh = 1.0 - smoothstep(0.090 + rag - mAA, 0.090 + rag + mAA, min(cf, 1.0 - cf));
          float mortar = max(mv, mh);

          float bh1 = rh2(vec2(bid, cid) + 0.5);
          float bh2 = rh2(vec2(bid, cid) * 1.9 + 7.7);

          vec3 wallAlb = pa.rgb * (0.74 + bh1 * 0.62);
          // Kept COOL. Law 4: the ground and everything built out of it is the
          // lowest-saturation surface in frame.
          wallAlb *= mix(vec3(1.0), vec3(0.93, 0.98, 1.10), 0.5 + bh2 * 0.5);
          diffuseColor.rgb = mix(diffuseColor.rgb, wallAlb, wallW);
          diffuseColor.rgb *= 1.0 - mortar * 0.70 * wallW;
          gAO2 *= 1.0 - mortar * 0.60 * wallW;
          gR2 = mix(gR2, clamp(0.82 + (bh2 - 0.5) * 0.26, 0.1, 1.0), wallW * 0.8);

          float cbev = -sign(cf - 0.5) * (1.0 - smoothstep(0.0, 0.26, min(cf, 1.0 - cf)));
          float bbev = -sign(bf - 0.5) * (1.0 - smoothstep(0.0, 0.19, min(bf, 1.0 - bf)));
          vec2 wallN = vec2(bbev * 0.34, cbev * 0.52) + vec2(0.0, (bh1 - 0.5) * 0.18);
          nxy = mix(nxy, nxy * 0.25 + wallN, wallW);
        }

        // ---- coping: dressed slabs, jointed on the laid stone rhythm --------
        if (vCoping > 0.004) {
          float sp = vArc / uStoneLen;
          float sf = fract(sp);
          float sAA = fwidth(sp) * 0.9 + 1e-4;
          float sj = 1.0 - smoothstep(0.020 - sAA, 0.020 + sAA, min(sf, 1.0 - sf));
          float sh = rh1(floor(sp) * 5.3 + 0.7);
          // ROUND 5: the dressed-coping lift is 1.28 -> 1.06, and what is left
          // of it is modulated by the run field. That constant was the mechanism
          // by which the coping became "a bright hard bar": it lifted a
          // 200-unit-long, perfectly straight, camera-facing slab a flat 28%
          // above the stone under it, uniformly, all the way round.
          diffuseColor.rgb *= mix(1.0, 1.06 * (0.80 + sh * 0.34) * (0.78 + runV * 0.46),
                                  vCoping);
          diffuseColor.rgb *= 1.0 - sj * 0.55 * vCoping;
          gAO2 *= 1.0 - sj * 0.50 * vCoping;
          nxy.x += -sign(sf - 0.5) * (1.0 - smoothstep(0.0, 0.10, min(sf, 1.0 - sf))) * 0.40 * vCoping;
        }

        // ---- the run field, applied ------------------------------------------
        diffuseColor.rgb *= 0.62 + runV * 0.64;
        // Soot / lichen / damp: cold, low-chroma, and it lands in patches with
        // edges. Law 4 holds — this only ever reduces saturation.
        diffuseColor.rgb = mix(diffuseColor.rgb,
                               diffuseColor.rgb * vec3(0.52, 0.56, 0.60),
                               soil * 0.72);
        diffuseColor.rgb *= 1.0 - wet * 0.26;
        gR2 = clamp(gR2 + soil * 0.10 - wet * 0.16, 0.05, 1.0);
        gAO2 *= 1.0 - wet * 0.22;

        // =====================================================================
        // COLLAPSED SECTIONS  (round 5 — law 6)
        // ---------------------------------------------------------------------
        // The geometry has already dropped these stretches below the board's
        // own floor line and turned them into a talus bank (see Sweep.js). What
        // is left is to stop them looking like a smoothly bent wall: the
        // coursing dissolves, the dressed stone goes to broken fill, the value
        // drops into the surround's range so the eye does not find an edge, and
        // a high-frequency normal break turns the bank into rubble.
        if (vBreach > 0.004) {
          float b = clamp(vBreach, 0.0, 1.0);
          float rub = rh2(floor(vec2(vArc * 2.6, vRimWorld.y * 3.4)) + 0.5);
          float rub2 = rh2(floor(vec2(vArc * 6.1, vRimWorld.y * 8.3)) - 3.0);
          vec3 fill = pa.rgb * (0.42 + rub * 0.50);
          // Earth, not masonry — but desaturated earth. The ground has to stay
          // the lowest-saturation family in frame whatever it is made of.
          fill = mix(fill, vec3(dot(fill, vec3(0.32, 0.50, 0.18))) * 0.92, 0.45);
          diffuseColor.rgb = mix(diffuseColor.rgb, fill, b * 0.88);
          gR2 = mix(gR2, clamp(0.92 + (rub2 - 0.5) * 0.16, 0.1, 1.0), b * 0.85);
          gAO2 *= 1.0 - b * 0.30 * (0.4 + rub2 * 0.9);
          nxy = mix(nxy, vec2(rub - 0.5, rub2 - 0.5) * 1.25, b * 0.80);
        }

        gN2 = normalize(vec3(nxy, sqrt(max(0.05, 1.0 - dot(nxy, nxy)))));
        if (uDebugTag > 0.5) {
          diffuseColor.rgb = vec3(clamp(vWall, 0.0, 1.0), clamp(vCoping, 0.0, 1.0), 0.12);
        }
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gR2;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize( tbn * gN2 );')
      .replace('#include <aomap_fragment>', /* glsl */`
        float ambientOcclusion = gAO2;
        reflectedLight.indirectDiffuse *= ambientOcclusion;
        #if defined( USE_ENVMAP ) && defined( STANDARD )
          float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
          reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
        #endif
      `);
  };
  mat.customProgramCacheKey = () => `rim-stone-v2-${uvScale}`;
  return mat;
}
