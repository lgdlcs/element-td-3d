import * as THREE from 'three';
import { PART, MAT } from './geometry.js';
import { HOSTILE_GLSL } from './palette.js';

/**
 * The creep material.
 *
 * Two jobs:
 *
 * 1) ANIMATION (gate G6). A per-vertex "bone" id + joint pivot lets the vertex
 *    shader rotate limbs about their joints, so we get a gait, arm counter-
 *    swing, head bob, cape drag, wing flap, lean-into-turns, hit stagger and
 *    a slowed "settle" — for an entire 300-unit army — at zero CPU cost and
 *    still one draw call per archetype.
 *
 * 2) READABILITY (gate G4). The fresnel rim this file used to carry is gone —
 *    it failed three rounds running and the reason is geometric, not a tuning
 *    miss (creeps/silhouette.js documents it). The silhouette read lives in an
 *    inverted-hull outline pass.
 *
 *    ROUND 5 inverts what is left. Round 4 kept the INTERIOR bright: a
 *    saturated element-coloured emissive fill, on the theory that Element TD 2
 *    creeps are internally illuminated. Ablated on a real midgame board that
 *    body contributed almost nothing you could see, because a mid-value
 *    saturated mass is indistinguishable from the tower glow washes crossing
 *    the same floor. reference/etd2-06-graveyard-creep-rimlights.jpg shows the
 *    actual answer: the creeps are the DARKEST objects in the frame, wearing
 *    hot saturated edge lines, on pale ground. So the interior is now
 *    near-black, the fill is a tenth of what it was, and the only bright pixels
 *    on a creep are its eyes.
 *
 * Per-instance inputs:
 *   instanceColor vec3  hostile-red VALUE variant (creeps/palette.js). The hue
 *                       is NOT read from here; it is a constant.
 *   instanceExtra vec4  (hitFlash, hp01, phase, statusMask)
 *   instanceAnim  vec4  (speed01, lean, stagger, spawn01)
 */

export const COMMON = /* glsl */`
  mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
  mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
  mat3 rotZ(float a){ float c=cos(a), s=sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }
`;

export const ANIM = /* glsl */`
  attribute vec3 aPivot;
  attribute float aPart;
  attribute float aMat;
  attribute vec3 aTint;
  attribute vec3 instanceColor;
  attribute vec4 instanceExtra;
  attribute vec4 instanceAnim;

  varying vec3 vTint;
  varying float vMat;
  varying vec3 vICol;
  varying vec4 vExtra;
  varying vec4 vAnim;
  varying vec3 vWorldPos;
  varying float vObjY;
  varying vec3 vLocalN;

  mat3 cRot;
  vec3 cOff;

  void creepAnim() {
    float ph    = instanceExtra.z;
    float sp    = clamp(instanceAnim.x, 0.0, 1.6);
    float lean  = instanceAnim.y;
    float stag  = instanceAnim.z;
    float part  = aPart;

    // Gait amplitude scales with actual speed; a slowed creep settles into a
    // heavy, low-amplitude trudge rather than freezing mid-stride.
    float amp   = 0.18 + sp * 0.78;
    float swing = sin(ph) * amp;
    float swing2 = sin(ph + 1.9) * amp;      // offset pair for 6-legged units
    float bounce = cos(ph * 2.0);

    mat3 M = mat3(1.0);

    if (part < 0.5) {                        // TORSO — counter-rotates the legs
      M = rotY(-sin(ph) * 0.10 * amp) * rotX(-sp * 0.09 + bounce * 0.035 - stag * 0.30) * rotZ(lean * 0.35);
    } else if (part < 1.5) {                 // LEG_L
      M = rotX(swing);
    } else if (part < 2.5) {                 // LEG_R
      M = rotX(-swing);
    } else if (part < 3.5) {                 // HEAD — lags the body, then snaps
      M = rotX(-bounce * 0.05 - sp * 0.05 + stag * 0.55) * rotY(sin(ph * 0.47) * 0.13 - lean * 0.5) * rotZ(-lean * 0.30);
    } else if (part < 4.5) {                 // ARM_L — opposes LEG_L
      M = rotX(-swing * 0.62) * rotZ(0.06 + bounce * 0.05);
    } else if (part < 5.5) {                 // ARM_R
      M = rotX(swing * 0.62) * rotZ(-0.06 - bounce * 0.05);
    } else if (part < 6.5) {                 // CLOTH — drags back, flutters
      M = rotX(-sp * 0.55 - 0.06 - bounce * 0.05) * rotZ(sin(ph * 0.83) * 0.16 + lean * 0.9);
    } else if (part < 7.5) {                 // WING_L
      M = rotZ(sin(ph * 2.1) * 0.62 + 0.10) * rotY(sin(ph * 2.1 + 1.5) * 0.16);
    } else if (part < 8.5) {                 // WING_R
      M = rotZ(-sin(ph * 2.1) * 0.62 - 0.10) * rotY(-sin(ph * 2.1 + 1.5) * 0.16);
    } else if (part < 9.5) {                 // ORBIT
      M = rotY(ph * 0.55);
    } else if (part < 10.5) {                // STATIC
      M = mat3(1.0);
    } else if (part < 11.5) {                // TAIL
      M = rotX(sin(ph * 0.9) * 0.18 * amp - stag * 0.4) * rotY(sin(ph * 0.6) * 0.22);
    } else if (part < 12.5) {                // LEG_L2
      M = rotX(swing2);
    } else {                                 // LEG_R2
      M = rotX(-swing2);
    }

    // Whole-body: bank into turns, pitch with acceleration, recoil on hit.
    mat3 G = rotZ(lean * 0.55) * rotX(-stag * 0.22);
    cRot = G * M;
    cOff = G * aPivot;
    // Creep-local normal (before the instance's yaw). +Z is "the way it walks",
    // which is what lets the fragment shader light the leading edge and shade
    // the trailing one — the direction-of-travel cue.
    vLocalN = normalize(cRot * normal);
  }
`;

export function makeCreepMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.75,
    metalness: 0.1,
    // Low: the sky env is bright and warm, and at 0.6 it washed the element
    // albedo straight back out to the floor's own hue.
    envMapIntensity: 0.22,
    color: 0xffffff,
    // Capes, banners, scarves and wing membranes are single quads — without
    // this they vanish the moment a creep turns away from camera.
    side: THREE.DoubleSide,
  });
  mat.defines = { CREEP: 1 };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    mat.userData.shader = shader;

    shader.vertexShader = COMMON + ANIM + shader.vertexShader
      .replace('#include <beginnormal_vertex>', /* glsl */`
        creepAnim();
        vec3 objectNormal = vLocalN;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        vec3 transformed = cRot * (position - aPivot) + cOff;
        vTint = aTint;
        vMat = aMat;
        vICol = instanceColor;
        vExtra = instanceExtra;
        vAnim = instanceAnim;
        vObjY = position.y;
        vWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      `);

    shader.fragmentShader = /* glsl */`
      varying vec3 vTint;
      varying float vMat;
      varying vec3 vICol;
      varying vec4 vExtra;
      varying vec4 vAnim;
      varying vec3 vWorldPos;
      varying float vObjY;
      varying vec3 vLocalN;
      uniform float uTime;

      ${HOSTILE_GLSL}

      // Hue-normalised element colour: every wave colour arrives at the same
      // brightness, so a green wave is not dimmer than a cyan one.
      vec3 elemHue(vec3 c) {
        return c / max(max(max(c.r, c.g), c.b), 1e-3);
      }
    ` + shader.fragmentShader
      // Material class drives roughness ...
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = roughness;
        if (vMat < 0.5)      roughnessFactor = 0.88;   // hide
        else if (vMat < 1.5) roughnessFactor = 0.34;   // iron
        else if (vMat < 2.5) roughnessFactor = 0.55;   // bone
        else if (vMat < 3.5) roughnessFactor = 1.0;    // cloth
        else                 roughnessFactor = 0.25;   // glow
        // Frozen creeps get a slick ice glaze.
        float frozenR = step(0.5, mod(vExtra.w, 2.0));
        roughnessFactor = mix(roughnessFactor, 0.12, frozenR * 0.7);
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        float metalnessFactor = metalness;
        // Round 1 ran the plate at 0.85 metal. Against the *new*, much brighter
        // arena floor a metal creep just mirrors the floor's warm brown and the
        // unit dissolves into it. Half-metal keeps the spec highlight but lets
        // the element-tinted albedo survive.
        if (vMat > 0.5 && vMat < 1.5) metalnessFactor = 0.45;
        else metalnessFactor = 0.03;
      `)
      // ... and albedo.
      //
      // ROUND 2 REVERSAL. Round 1 used a near-neutral mid albedo (~0.30) on the
      // assumption of a dark floor. The floor is now ~rgb(102,83,82) and the key
      // light went 2.55 -> 7.60, so those bodies rendered at floor luminance in
      // the floor's own hue: measured rgb(127,107,112), sat 15%, hue 344 against
      // a floor at hue ~0. No luminance separation, no hue separation.
      //
      // The one axis the stone floor cannot compete on is CHROMA (it sits at
      // 17-21% saturation everywhere). So the body is now heavily element-tinted
      // and darker: a wave reads as one saturated coloured mass on warm stone.
      // ROUND 5. The albedo goes DARK, and this is the single biggest change in
      // the file.
      //
      // Round 4's body was `mix(near-black, elementHue*0.30, 0.90)` — a mid,
      // saturated, element-coloured mass. Ablated on a real midgame board
      // (tools/scratch/r5-creep-ablate.mjs) that body contributed almost
      // nothing you could see, because it sat at the same value as the pale
      // flagstone AND in the same hue family as the tower glow washes crossing
      // it. Two cues, both cancelled.
      //
      // reference/etd2-06-graveyard-creep-rimlights.jpg is the answer and it is
      // not subtle: Element TD 2's creeps are the DARKEST objects in the frame —
      // near-black bodies carrying hot saturated edge lines, standing on pale
      // ground. Nothing else on our board is a solid dark mass: the floor is
      // pale, towers are mid-value with bright emissive, the surround is
      // mid-dark but out of the play area. Dark is an unoccupied slot in the
      // frame's value hierarchy, and it costs nothing to take it.
      //
      // Note this is NOT in tension with law 4. Law 4 says do not spend
      // BRIGHTNESS on readability, because ACES takes it back. Darkness is the
      // other direction and ACES protects it.
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        float isGlow = step(3.5, vMat);
        vec3 hostile = hostileHue(vICol);
        // Per-part tint only modulates value, never pushes a part pale — the
        // old T_PALE (1.18) bone parts were the brightest thing on the creep.
        float tl = clamp(dot(vTint, vec3(0.3333)), 0.0, 1.25);
        // The per-part value spread is kept (plate/hide/bone/cloth separate
        // ~1.8x) but the whole ladder now lives between 0.012 and 0.075, i.e.
        // charcoal to dark leather, so the creep is a mass rather than a set of
        // differently-coloured panels.
        float shade = 0.30 + 0.70 * tl;
        vec3 body = mix(vec3(0.0210, 0.0165, 0.0195), hostile * 0.135, 0.75) * shade;
        // vertical gradient: dark, occluded feet -> slightly relieved shoulders.
        // This is what plants the unit on the ground when read as a 40px shape.
        body *= 0.42 + 0.72 * clamp(vObjY * 0.62, 0.0, 1.0);
        // Frozen bodies pale out under an ice crust; burnt ones char. Both stay
        // dark — a status must not be able to lift a creep out of the value
        // slot the whole read depends on.
        float fFrozen = step(0.5, mod(vExtra.w, 2.0));
        float fBurn   = step(0.5, mod(floor(vExtra.w / 2.0), 2.0));
        body = mix(body, vec3(0.045, 0.085, 0.135), fFrozen * 0.65);
        body = mix(body, vec3(0.022, 0.014, 0.012), fBurn * 0.75);
        diffuseColor.rgb = mix(body, hostile * 0.22, isGlow);
      `)
      // ROUND 2: all of this used to run at `#include <dithering_fragment>`,
      // i.e. AFTER tonemapping and colour-space conversion. On the current
      // pipeline the scene target is HalfFloat/linear so that happened to be a
      // no-op — but it also meant the rim was never *composed* with the lit
      // body, it was pasted on top of it. Running it here, on `outgoingLight`,
      // puts the rim inside the ACES rolloff where it keeps its hue instead of
      // bleaching, and it is now correct if this material is ever drawn direct
      // to screen.
      .replace('#include <opaque_fragment>', /* glsl */`
        {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewPosition);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float dist = length(vViewPosition);

        float frozen  = step(0.5, mod(vExtra.w, 2.0));
        float burning = step(0.5, mod(floor(vExtra.w / 2.0), 2.0));
        float poison  = step(0.5, mod(floor(vExtra.w / 4.0), 2.0));
        float isBoss  = step(0.5, mod(floor(vExtra.w / 8.0), 2.0));

        // The reserved hostile red. Status effects are allowed to bend it a
        // little but never out of the band — a burning creep is still visibly
        // an enemy, and in a midgame frame nearly every creep has a status, so
        // a strong override is a wave-wide repaint. (Round 4 let status win at
        // 0.80-0.85 and the whole wave went the colour of the floor.)
        vec3 hostile = hostileHue(vICol);
        vec3 eHue = hostile;
        eHue = mix(eHue, hostile * vec3(0.55, 1.55, 2.60), frozen * 0.42);
        eHue = mix(eHue, hostile * vec3(1.15, 2.40, 0.40), burning * 0.40);
        eHue = mix(eHue, hostile * vec3(0.65, 2.60, 1.00), poison * 0.38);
        vec3 rimCol = mix(eHue, vec3(1.0), 0.12);

        // --- ROUND 4: the rim is gone; the body carries its own light --------
        //
        // Rounds 1-3 tried to make a creep readable with a fresnel term and
        // failed three times, for reasons that are geometric rather than
        // tuneable. "pow(1-NdV, 3.4)" is a band a fraction of a pixel wide on a
        // body 54px tall, so it cannot survive; widening it to a flood puts a
        // 5px limb at high luminance where ACES bleaches every element to the
        // same near-white and throws away the ONE axis warm desaturated stone
        // cannot compete on, which is chroma.
        //
        // reference/etd2-04-ruins-terraces-tower-glows.jpg shows what the
        // shipped game actually does: the creeps are internally illuminated.
        // A saturated fill covers the WHOLE body, its luminance stays modest,
        // and a hard constant-width outline (see creeps/silhouette.js) does the
        // edge separation a fresnel term was being asked to do. Saturation
        // carries the read, not brightness — that is exactly why it survives
        // tonemapping.
        //
        // ROUND 5. eSat was the element hue at full chroma. It is now simply
        // the hostile red, which is already at full chroma by construction.
        vec3 eSat = eHue;

        float pulse = 0.92 + 0.08 * sin(uTime * 2.4 + vExtra.z * 0.6);
        float up   = clamp(N.y, 0.0, 1.0);
        float body01 = clamp(vObjY * 0.52 + 0.10, 0.0, 1.0);

        // --- the body stays DARK ---------------------------------------------
        // Round 4 flooded the body with a saturated fill peaking near 0.55 and
        // the unit came out mid-value — the same value as the flagstone it was
        // standing on. The fill is now a tenth of that. Its only job is to keep
        // the mass from going to literal black, so the FORM still reads inside
        // the silhouette; the silhouette itself is the outline shell's job and
        // the outline shell is the thing that got fixed.
        float fill = (0.022 + 0.052 * body01) * (0.40 + 1.20 * up) * pulse;
        fill *= mix(1.0, 1.5, isBoss);
        outgoingLight += eSat * fill;

        // --- the rim that survives ACES --------------------------------------
        // This is a CONTOUR term, and it is deliberately not load-bearing: a
        // pow(1-NdV, k) band is a fraction of a pixel wide on a 54px body and
        // three rounds proved it cannot carry a silhouette (see
        // creeps/silhouette.js). What makes it usable at all now is the hue.
        // Red at full chroma is luminance 0.21, so it can run at 4x a cyan's
        // amplitude and still sit below the ACES shoulder — 0.55 here is a hot
        // saturated crimson edge on screen, where 0.55 of the old spring-cyan
        // was already halfway to white.
        float far01 = smoothstep(18.0, 68.0, dist);
        float rim = pow(1.0 - ndv, mix(2.6, 1.5, far01));
        outgoingLight += eSat * rim * 0.40 * pulse;

        // --- self-lit floor --------------------------------------------------
        // Half the board is in a tower's shadow. Without a light-independent
        // term a creep walking through shadow drops to the shadow's own value
        // and becomes a hole. This is NOT a garnish and it was measured: the
        // dark-body plan works because the arena floor is pale, and roughly a
        // third of the floor at midgame is not — it is under a 3.5-cell tower's
        // shadow. A creep crossing one has to keep a floor of its own or the
        // whole strategy inverts on it. 0.085 of pure red is luminance 0.018,
        // which is invisible on the lit half and is the difference between a
        // shape and a hole on the shadowed half.
        outgoingLight += eSat * 0.085 * (0.30 + 0.70 * up);

        // --- direction of travel ---------------------------------------------
        // vLocalN is the creep-local normal; +Z is the way it is walking. The
        // leading surfaces catch a hostile-red wash, the trailing ones are
        // pushed down, so a column has a visibly hot front rank and a dark
        // back — the cue the critic could read on the competitors and not here.
        float fwd  = clamp(vLocalN.z, 0.0, 1.0);
        float back = clamp(-vLocalN.z, 0.0, 1.0);
        outgoingLight += eSat * fwd * fwd * 0.10;
        outgoingLight *= 1.0 - back * back * 0.34;

        // --- glowing eyes / cores / runes ------------------------------------
        // These are now the ONLY high-luminance pixels on a creep, and against
        // a body an order of magnitude darker than round 4's they read as
        // points of light rather than as part of a coloured mass. Element TD 2
        // does exactly this: a black shape with two hot eyes in it.
        // Kept below ~2.2: past that the bloom pass eats the hue and an eye
        // reads as a generic white spark instead of a hostile one.
        float isGlowP = step(3.5, vMat);
        outgoingLight = mix(outgoingLight,
          mix(eHue, vec3(1.0), 0.14) * (1.70 + 0.50 * pulse), isGlowP);

        // Burning: molten crawl over up-facing surfaces + ember shimmer.
        // ("up" is declared with the body fill above.)
        float crawl = sin(vWorldPos.x * 7.0 + uTime * 5.0) * sin(vWorldPos.z * 6.0 - uTime * 4.0);
        outgoingLight += burning * vec3(1.00, 0.30, 0.05) * (0.12 + 0.20 * up) * (0.5 + 0.5 * crawl);

        // Frozen: a crystalline glaze. Pulled well down from round 4's 0.55 +
        // 1.2 spike — an ice status must not be able to turn the darkest object
        // in the frame into the brightest one, which is what it was doing on
        // every creep a water tower had touched, i.e. most of them.
        outgoingLight += frozen * vec3(0.30, 0.52, 0.90) * pow(up, 1.5) * 0.22;
        float ice = sin(vWorldPos.x * 22.0) * sin(vWorldPos.y * 19.0) * sin(vWorldPos.z * 21.0);
        outgoingLight += frozen * vec3(0.55, 0.72, 1.0) * smoothstep(0.72, 0.95, ice) * 0.45;

        // Poison: slow sickly pulse through the body.
        outgoingLight += poison * vec3(0.14, 0.26, 0.06) * (0.5 + 0.5 * sin(uTime * 3.4 + vObjY * 3.0));

        // Hit flash. ROUND 1 pushed vec3(1.9,1.6,1.35) over the whole body, and
        // in a real midgame frame the creeps under fire are re-flashed faster
        // than the 0.22s decay — so the units you most need to see were the ones
        // permanently bleached to white. It is now weaker, edge-weighted, and
        // carries the element hue so a flashing creep is still an identifiable
        // creep.
        // ROUND 4: the outline shell now carries most of the flash, so the body
        // term only has to say "this one is being hit" without erasing it.
        // Same rule as the outline: hue gain, not a white push. Under sustained
        // fire this term is effectively always on.
        float hf = clamp(vExtra.x, 0.0, 1.0);
        outgoingLight += eSat * hf * hf * (0.22 + rim * 0.55)
                       + vec3(1.0, 0.96, 0.92) * hf * hf * 0.06;

        // Spawn-in: creeps materialise instead of popping.
        float sp01 = clamp(vAnim.w, 0.0, 1.0);
        outgoingLight += rimCol * (1.0 - sp01) * 2.0;
        }
        #include <opaque_fragment>
      `);
  };

  return mat;
}

/**
 * Matching depth material so the shadow matches the animated pose — without it
 * a creep's shadow walks with stiff legs while the creep itself strides (G9).
 */
export function makeCreepDepthMaterial() {
  const mat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = COMMON + ANIM + shader.vertexShader
      .replace('#include <begin_vertex>', /* glsl */`
        creepAnim();
        vec3 transformed = cRot * (position - aPivot) + cOff;
        vTint = aTint; vMat = aMat; vICol = instanceColor;
        vExtra = instanceExtra; vAnim = instanceAnim;
        vObjY = position.y; vWorldPos = vec3(0.0);
      `);
  };
  return mat;
}

export { PART, MAT };
