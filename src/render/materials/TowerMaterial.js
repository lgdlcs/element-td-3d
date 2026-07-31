import * as THREE from 'three';
import { noiseVolume, NOISE_VOLUME_GLSL } from './NoiseVolume.js';

/**
 * Materials for the batched tower renderer.
 *
 * Everything a tower is made of lives in ONE MeshStandardMaterial so that the
 * whole board can be drawn by a single THREE.BatchedMesh. Per-surface material
 * identity is carried by geometry attributes instead of by separate materials:
 *
 *   color  (vec3) : linear albedo (for emissive parts, the emission tint)
 *   aMat   (vec4) : x = metalness
 *                   y = roughness
 *                   z = emissive intensity (0 for non-emissive surfaces)
 *                   w = edge-wear amount (baked from geometry curvature)
 *   aDet   (vec4) : xyz = element colour x carved-channel strength (0 = none)
 *                   w   = authored-detail style (0 none, 1 masonry, 2 fluted,
 *                         3 timber) — see MAT in TowerParts.js
 *
 * The per-instance BatchedMesh colour is repurposed as an *emissive multiplier*
 * (pulse / spin-up / firing flash) rather than an albedo tint, so a shared
 * geometry can still breathe independently per tower.
 *
 * Surface detail is procedural in object space: no UVs, no texture fetches, no
 * atlas. It is built in two layers, and the split is the point:
 *
 *   AUTHORED (low frequency, directional, world-scaled) — masonry courses with
 *   running-bond joints, per-block tint, a lit chamfer on every course, carved
 *   flutes, chipped corners, and channels the element energy runs along. This
 *   is what makes a tower read as a designed object rather than a placeholder,
 *   and it survives gameplay distance precisely because it is low frequency.
 *
 *   GRAIN (high frequency) — pitting on stone, brushed streaking on metal, plus
 *   a cavity/exposure term that dirties the bottoms and polishes worn edges
 *   back to bare metal. This layer alone averages to flat grey at range, which
 *   is why three rounds of tuning it moved nothing.
 *
 * Both are free in triangles, which is the binding budget.
 */
export function createTowerMaterial(envMapIntensity = 1.3) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 1.0,
    roughness: 1.0,
    envMapIntensity,
    dithering: true,
  });

  // PITFALLS §11: a CONSTANT cache key makes every runtime shading ablation
  // silently impossible — three.js hands back the compiled program and the
  // injections survive whatever you cleared. The key must vary with every
  // property that changes the generated program, which for this material is
  // `vertexColors` and whether `onBeforeCompile` is still installed.
  mat.customProgramCacheKey = () =>
    `towerMat-v11|${mat.vertexColors ? 1 : 0}|${mat.onBeforeCompile === onCompile ? 1 : 0}`;

  // Ablation uniforms. These exist so the *instrument* can isolate one layer of
  // the tower read at a time without rebuilding the material — see
  // tools/tower-camsil.mjs. They are inert at their defaults.
  //
  //   uSilMode  0 = ship, 1 = flat black (no albedo, no emission, no specular),
  //             2 = flat black body but emission kept at ship strength.
  //   uEmisScale multiplies every emissive term, so the emissive budget can be
  //             swept against the bloom threshold without editing source.
  const uSilMode = { value: 0 };
  const uEmisScale = { value: 1 };
  const uNoiseVol = { value: noiseVolume() };
  mat.userData.uSilMode = uSilMode;
  mat.userData.uEmisScale = uEmisScale;

  const onCompile = (shader) => {
    mat.userData.shader = shader;
    shader.uniforms.uSilMode = uSilMode;
    shader.uniforms.uEmisScale = uEmisScale;
    shader.uniforms.uNoiseVol = uNoiseVol;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute vec4 aMat;
        attribute vec4 aDet;
        varying vec4 vDet;
        varying vec4 vMat;
        varying vec4 vTint;
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        varying vec3 vAx;
        varying vec3 vAy;
        varying vec3 vAz;
      `)
      // Split the two colour channels: vColor stays the baked albedo, vTint
      // carries the per-instance batching colour (our emissive multiplier).
      .replace('#include <color_vertex>', /* glsl */`
        vColor = vec4( 1.0 );
        #ifdef USE_COLOR_ALPHA
          vColor *= color;
        #elif defined( USE_COLOR )
          vColor.rgb *= color;
        #endif
        vTint = vec4( 1.0 );
        #ifdef USE_BATCHING_COLOR
          vTint = getBatchingColor( getIndirectIndex( gl_DrawID ) );
        #endif
        vMat = aMat;
        vDet = aDet;
        vLocalPos = position;
        vLocalNrm = normal;
      `)
      // Object-space -> view-space basis so the fragment stage can rotate its
      // procedural bump gradient into the space `normal` lives in.
      .replace('#include <defaultnormal_vertex>', /* glsl */`
        #include <defaultnormal_vertex>
        {
          mat3 o2v = normalMatrix;
          #ifdef USE_BATCHING
            mat3 bm = mat3( batchingMatrix );
            bm[0] = normalize( bm[0] ); bm[1] = normalize( bm[1] ); bm[2] = normalize( bm[2] );
            o2v = o2v * bm;
          #endif
          vAx = o2v[0]; vAy = o2v[1]; vAz = o2v[2];
        }
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying vec4 vMat;
        varying vec4 vDet;
        varying vec4 vTint;
        varying vec3 vLocalPos;
        varying vec3 vLocalNrm;
        varying vec3 vAx;
        varying vec3 vAy;
        varying vec3 vAz;
        uniform float uSilMode;
        uniform float uEmisScale;

        // The detail field is BAKED. It used to be two octaves of hand-rolled
        // trilinear value noise, evaluated four times per fragment (once for the
        // value, three more for a forward-difference bump gradient) — 64 hash
        // evaluations per pixel, measured at 41.7ms for 21 towers on an M1.
        // NoiseVolume.js stores the same lattice with its gradient baked in, so
        // one fetch returns what four calls used to compute. See PERF_BUDGET.md.
        ${NOISE_VOLUME_GLSL}

        // -------------------------------------------------------------------
        // AUTHORED STRUCTURE
        // -------------------------------------------------------------------
        // Procedural is the generator; the OUTPUT has to look like something a
        // builder made. That means regular where a mason would be regular
        // (course height, block width, joint width all fixed in WORLD units, so
        // they stay constant across a tower's parts and across tiers) and
        // irregular only where wear would be (per-block tint, chipped corners).
        //
        // Everything here is deliberately LOW frequency. A 0.34-unit course on
        // a 3.2-unit plinth is ~9 courses; that reads from the play camera.
        // The old grain field, at 3.2 cycles per unit, averaged to flat grey at
        // the same distance — which is exactly the "material placeholder" note.

        const float COURSE = 0.345;   // world height of one masonry course
        const float BLOCKW = 0.62;    // world width of one block along the face
        const float JOINT  = 0.052;   // world width of the mortar joint

        float bhash( vec2 c ) {
          return fract( sin( dot( c, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
        }

        /**
         * Surface coordinates for a face. Vertical faces are laid out
         * (arc length around the axis, height); up/down faces fall back to a
         * plain XZ grid so a plinth cap reads as flagstones, not as smeared
         * courses converging on the axis.
         */
        vec2 faceUV( vec3 p, vec3 nl ) {
          float up = smoothstep( 0.55, 0.86, abs( nl.y ) );
          float rad = max( 0.16, length( p.xz ) );
          float arc = atan( p.z, p.x ) * rad;
          return vec2( mix( arc, p.x, up ), mix( p.y, p.z, up ) );
        }

        /** Signed relief height, in world units, of the authored structure. */
        float authoredH( vec3 p, vec3 nl, float style ) {
          if ( style < 0.5 ) return 0.0;

          if ( style > 2.5 ) {
            // Timber: long vertical grain plus the odd knot. One frequency, so
            // it stays directional instead of dissolving into noise.
            float g = sin( ( atan( p.z, p.x ) * max( 0.14, length( p.xz ) ) ) * 26.0 )
                    + 0.5 * sin( p.y * 3.1 + 1.7 );
            return g * 0.010;
          }

          vec2 uv = faceUV( p, nl );

          if ( style > 1.5 ) {
            // Fluted / turned stone: vertical carved channels, no courses.
            // Cast, not laid — the language for water, glass and precise work.
            float f = cos( uv.x * ( 6.2831853 / 0.30 ) );
            return -0.030 * pow( max( 0.0, f ), 3.0 );
          }

          // Coursed ashlar.
          float cy = uv.y / COURSE;
          float course = floor( cy );
          float fy = fract( cy );
          // Running bond: every course slides by a fixed-ish fraction of a block.
          float off = bhash( vec2( course, 3.0 ) ) * BLOCKW;
          float bx = ( uv.x + off ) / BLOCKW;
          float block = floor( bx );
          float fx = fract( bx );

          // Distance to the nearest joint, in world units.
          float dY = min( fy, 1.0 - fy ) * COURSE;
          float dX = min( fx, 1.0 - fx ) * BLOCKW;
          float d  = min( dY, dX );

          // The joint is a recess with a chamfered lip, not a painted line.
          float h = -0.026 * ( 1.0 - smoothstep( 0.0, JOINT, d ) );
          // Individual blocks sit slightly proud or slightly sunk.
          h += ( bhash( vec2( course, block ) ) - 0.5 ) * 0.014;
          // A chipped corner every few blocks, where a real wall gets knocked.
          float chip = bhash( vec2( block, course * 1.7 + 5.0 ) );
          h -= step( 0.86, chip ) * 0.030 * ( 1.0 - smoothstep( 0.0, 0.16, d ) );
          return h;
        }

        /** Per-block albedo/roughness variation + the lit top chamfer. */
        void authoredShade( vec3 p, vec3 nl, float style, out float tint, out float lip ) {
          tint = 1.0; lip = 0.0;
          if ( style < 0.5 || style > 1.5 ) return;
          vec2 uv = faceUV( p, nl );
          float cy = uv.y / COURSE;
          float course = floor( cy );
          float fy = fract( cy );
          float off = bhash( vec2( course, 3.0 ) ) * BLOCKW;
          float block = floor( ( uv.x + off ) / BLOCKW );
          // Quarried blocks are never one colour. +-16% is enough to count them.
          tint = mix( 0.84, 1.16, bhash( vec2( course, block ) ) );
          // Light rakes the top chamfer of every course and misses the underside
          // of the one above it. This single term is most of the "carved" read.
          lip = smoothstep( 0.70, 0.98, fy ) - smoothstep( 0.30, 0.02, fy );
        }
      `)
      // grain / wear must be ready before color_fragment, which runs first.
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        float metalRaw = vMat.x;
        // .a is the old tdetail() value; .rgb is its local-space gradient, which
        // the bump block below consumes instead of re-sampling three times.
        vec4 grainS = tdetail4( vLocalPos, metalRaw );
        float grain = grainS.a;
        // Wear only survives where the surface is actually exposed: broken up
        // by the grain so it reads as chipping, not as a uniform outline.
        float wearMask = clamp( vMat.w * smoothstep( 0.44, 0.88, grain * 0.7 + 0.34 ), 0.0, 1.0 );

        // vDet.w packs (authored style 0..3) + 8 when this surface carries a
        // carved element channel. vDet.rgb is now the family colour on EVERY
        // vertex, so the rim term below always has a hue to work with.
        float dChan  = step( 4.0, vDet.w );
        float dStyle = vDet.w - dChan * 8.0;
        vec3 dNrmL = normalize( vLocalNrm );
        vec2 dUV = faceUV( vLocalPos, dNrmL );
        float blockTint, courseLip;
        authoredShade( vLocalPos, dNrmL, dStyle, blockTint, courseLip );
        float authored = authoredH( vLocalPos, dNrmL, dStyle );
        // Joint darkness: the mortar recess is in shadow and holds dirt.
        float jointDark = clamp( -authored / 0.026, 0.0, 1.0 );

        // Carved channel the element energy runs along. Four of them, cut into
        // the shaft. Kept WIDE (cos^9, not a knife edge) because narrow radial
        // features alias into a pinwheel at gameplay distance — PITFALLS 6.
        float chanF = pow( max( 0.0, cos( atan( vLocalPos.z, vLocalPos.x ) * 4.0 + 0.7 ) ), 9.0 );
        // Only on shaft-scale surfaces; a 0.13-unit stud must not glow.
        chanF *= smoothstep( 0.30, 0.55, length( vLocalPos.xz ) );
        chanF *= dChan * step( 0.5, dStyle ) * step( dStyle, 2.5 ) * ( 1.0 - abs( dNrmL.y ) );
        // The energy runs in the JOINTS between courses, not as an unbroken
        // strip. A continuous bar photographs as a fluorescent tube taped to
        // the tower — the same shape on every element, which made the towers
        // read as MORE alike, not less. Quantised to the masonry it becomes a
        // ladder of light in the mortar: unmistakably part of the stonework.
        float dFy = fract( dUV.y / COURSE );
        float rung = 1.0 - smoothstep( 0.0, 0.34, min( dFy, 1.0 - dFy ) );
        float isMason = step( dStyle, 1.5 );
        chanF *= mix( 0.50, 0.22 + 0.78 * rung, isMason );
      `)
      .replace('#include <color_fragment>', /* glsl */`
        {
          // Grime gradient: soot and dust pool low, tops are washed clean.
          float emissiveOn = step( 0.001, vMat.z );
          // vColor.a is the vertex's baked height above the board (0..1).
          float grime = mix( mix( 0.88, 1.12, smoothstep( 0.02, 0.72, vColor.a ) ), 1.0, emissiveOn );
          // Grain is now the FINE layer under the authored structure, so its
          // contrast is pulled back: at +-36% it was competing with the course
          // lines and the two together read as noise again.
          vec3 albedo = vColor.rgb * mix( 0.82, 1.18, grain ) * grime;
          // Authored layer: per-block tint, dark mortar, lit top chamfer.
          albedo *= blockTint;
          albedo *= mix( 1.0, 0.40, jointDark );
          albedo *= 1.0 + courseLip * 0.26 * ( 1.0 - emissiveOn );
          // The carved channel is a dark recess; the glow inside it is emissive.
          // The recess is darker, but only mildly on fluted stone: there the
          // channel covers much of a curved face, and at 0.34 a whole water
          // shaft went to near-black on its shadow side.
          albedo *= mix( 1.0, mix( 0.58, 0.34, isMason ), chanF );
          // Exposed edges reveal the bare warm metal underneath.
          albedo = mix( albedo, mix( albedo, vec3( 0.46, 0.38, 0.29 ), 0.8 ), wearMask * ( 1.0 - emissiveOn ) );
          // Metal is a DARK value carrying a hot highlight, never a light grey
          // surface — at equal value the specular has nothing to sit against,
          // which is why the bands read as painted-on trim rather than as metal.
          albedo *= mix( 1.0, 0.70, metalRaw );
          // Contact occlusion. All three blind critics reported that pieces
          // "look like they're hovering a few pixels off the tile": the bottom
          // of a tower was rendering at the same value as its top, so nothing
          // in the image said the two surfaces were touching. vColor.a is the
          // baked height / 9.8, so a board-level vertex sits at 0.041.
          float contact = smoothstep( 0.041, 0.104, vColor.a );
          albedo *= mix( 0.30, 1.0, contact );
          // A glowing part used to be painted its element colour AND emit it,
          // so it doubled up into flat fluorescent card. Let the emission carry
          // the colour and leave the surface a dark tinted glass that still
          // takes a specular highlight.
          albedo = mix( albedo, albedo * 0.26, emissiveOn );
          diffuseColor.rgb *= albedo;
          // Ablation: flatten the body to pure black so only the OUTLINE (and,
          // in mode 2, the emission) survives.
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.0 ), step( 0.5, uSilMode ) );
        }
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        // The authored ladder in MAT is only as separable as this block leaves
        // it. Round 4 added up to +-0.10 of grain, +0.16 of joint darkening and
        // then clamped at 0.17, which compressed nine authored values into a
        // band about 0.35 wide and is half the reason the set photographed as
        // one shader. Every perturbation below is now weighted by (1 - metal),
        // so stone keeps its dirt and metal keeps its mirror.
        float roughnessFactor = vMat.y;
        roughnessFactor += ( grain - 0.5 ) * mix( 0.18, 0.025, metalRaw );
        // Mortar is rough and dusty; a block face is comparatively polished.
        roughnessFactor += jointDark * 0.16 * ( 1.0 - metalRaw );
        roughnessFactor -= courseLip * 0.06;
        roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.70 + 0.20, wearMask * ( 1.0 - metalRaw ) );
        roughnessFactor = clamp( roughnessFactor, 0.045, 1.0 );
      `)
      .replace('#include <metalnessmap_fragment>', /* glsl */`
        float metalnessFactor = clamp( mix( metalRaw, 0.90, wearMask * 0.55 ), 0.0, 1.0 );
        // Silhouette ablation: no specular lobe, or the outline fills with
        // highlight and stops being a silhouette.
        metalnessFactor *= 1.0 - step( 0.5, uSilMode );
      `)
      // Procedural bump via a forward-difference gradient of the same field.
      .replace('#include <normal_fragment_maps>', /* glsl */`
        {
          vec3 nl = normalize( vLocalNrm );
          // Was three extra tdetail() calls forward-differenced at a 0.03-0.075
          // unit step. The gradient now arrives baked in grainS.rgb, which is
          // both free and sharper: the old step was wider than the features it
          // was resolving, so it smeared exactly the pitting it existed to show.
          vec3 g = grainS.rgb;
          vec3 surf = g - dot( g, nl ) * nl;
          vec3 vsurf = vAx * surf.x + vAy * surf.y + vAz * surf.z;
          float amp = mix( 0.085, 0.030, metalRaw ) * ( 1.0 - step( 0.001, vMat.z ) * 0.92 );
          normal = normalize( normal - vsurf * amp );

          // Authored relief on top of the fine grain. Sampled at a wider step
          // than the grain (0.022 world units) because the features it is
          // resolving — joints, chamfers, flutes — are ~0.05 units across; a
          // 0.03 step would land inside a single joint and return zero.
          if ( dStyle > 0.5 ) {
            float ea = 0.022;
            vec3 ga = vec3(
              authoredH( vLocalPos + vec3( ea, 0.0, 0.0 ), nl, dStyle ) - authored,
              authoredH( vLocalPos + vec3( 0.0, ea, 0.0 ), nl, dStyle ) - authored,
              authoredH( vLocalPos + vec3( 0.0, 0.0, ea ), nl, dStyle ) - authored
            ) / ea;
            vec3 sa = ga - dot( ga, nl ) * nl;
            vec3 va = vAx * sa.x + vAy * sa.y + vAz * sa.z;
            normal = normalize( normal - va * 0.80 );
          }
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        {
          // A purely emissive surface has no shading gradient, so a flat 4-sided
          // shard renders as one solid colour and reads as a 2D sticker — the
          // "bowtie" artefact. Weighting emission by facing fixes both halves of
          // that: adjacent facets of a gem now differ in value, and a plate seen
          // edge-on fades out instead of stamping a hard triangle on the frame.
          vec3 vDir = normalize( vViewPosition );
          float face = abs( dot( normal, vDir ) );
          float facet = mix( 0.36, 1.20, pow( face, 0.95 ) );
          totalEmissiveRadiance = vColor.rgb * vMat.z * vTint.rgb * facet;
          // Element energy in the carved channels. It breathes and flares with
          // the firing pulse (vTint), so a shot lights the tower's own masonry
          // rather than only the crown — which is the cue that reads at zoom.
          totalEmissiveRadiance += vDet.rgb * chanF * 0.62 * vTint.r;

          // ---------------------------------------------------------------
          // RIM / EDGE PASS
          // ---------------------------------------------------------------
          // Asked for verbatim by two of the three round-6 critics ("no edge
          // highlight — they read as vertex-coloured primitives", "give each
          // family ... a rim or edge-wear pass so silhouettes catch light"),
          // and by Art Bible §8 ("rim/back: strong and cool, separating every
          // silhouette from the floor"). We cannot add a real rim LIGHT: a
          // frame-time cliff was measured at 9 simultaneous point lights and
          // the scene already runs 6. This is the shader-side equivalent and
          // costs nothing.
          //
          // Three deliberate choices:
          //  - It is tinted with the FAMILY colour, not white. Law 4: chroma
          //    carries readability, luminance gets bleached by ACES. A white
          //    rim on twenty towers is twenty white outlines; a family-hued rim
          //    is the element read, restated on every surface of the tower
          //    rather than only on the crown gem.
          //  - It peaks at ~0.42, well under the 2.05 bloom threshold, so it
          //    adds SEPARATION without entering the bloom pyramid. The round-6
          //    note was that bloom is eating the geometry; the answer is not a
          //    brighter tower, it is a tower that is legible below threshold.
          //  - Exponent 3.4 keeps it to the grazing band. Widening it turns the
          //    tower into a flat fluorescent card, which is the exact mistake
          //    §6 of PITFALLS records for the emissive surfaces.
          //
          // clamp() before pow(): a varying-derived value can leave [0,1] under
          // perspective interpolation and one NaN fragment blanks the whole
          // frame through the bloom downsample chain (PITFALLS §9).
          float rimNdV = clamp( abs( dot( normalize( normal ), vDir ) ), 0.0, 1.0 );
          float rim = pow( 1.0 - rimNdV, 3.4 );
          // Not on the glowing parts (they already own the top of the range),
          // and stronger up the tower so the crown separates from the board
          // while the footing stays anchored to it.
          float rimH = mix( 0.55, 1.0, clamp( vColor.a * 1.6, 0.0, 1.0 ) );
          totalEmissiveRadiance += vDet.rgb * rim * 0.42 * rimH * ( 1.0 - step( 0.001, vMat.z ) );
          // uSilMode 1 kills emission (pure shape); 2 keeps it (shape + glow).
          totalEmissiveRadiance *= uEmisScale * ( 1.0 - step( 0.5, uSilMode ) * step( uSilMode, 1.5 ) );
        }
      `);
  };

  mat.onBeforeCompile = onCompile;

  return mat;
}

/**
 * Additive ground decal: one merged quad-soup mesh carrying every tower's
 * light spill. Far cheaper than a PointLight per tower and it stays at a
 * single draw call regardless of how many towers are on the board.
 */
export function createGroundGlowMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // DoubleSide is not cosmetic here, it is the bug fix.
    //
    // The decal quads are wound (-r,-r) -> (r,-r) -> (r,r) in the XZ plane,
    // whose cross product points at -Y. With the default FrontSide the entire
    // ground-glow layer was therefore back-face culled from a camera looking
    // down at it — it had never once been drawn, in any round. That is the real
    // reason the Art Director measured "the floor beneath them is uniformly
    // grey" while the code claimed every tower had a coloured pool. Verified by
    // forcing depthTest:false + NormalBlending + renderOrder 9999: still
    // invisible, which no depth or blend problem can explain.
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute vec3 aParam;   // x unused, y = seed, z = intensity
      varying vec2 vQ;
      varying vec3 vCol;
      varying vec2 vP;
      void main() {
        vQ = uv * 2.0 - 1.0;
        vCol = aColor;
        vP = aParam.yz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vQ;
      varying vec3 vCol;
      varying vec2 vP;
      uniform float uTime;
      void main() {
        float r = length( vQ );
        if ( r > 1.0 ) discard;
        // Wide pool + a hot spill ring where light escapes under the plinth.
        //
        // Round 3: the pool is the primary evidence that a tower is a light
        // source, so its shape matters as much as its strength. The core term
        // is flattened (exponent 1.30 -> 1.85 with a broad pedestal) because a
        // sharp centre peak is wasted — the tower's own footing covers it — and
        // what has to be visible is the ring OUTSIDE the plinth and the wash
        // between neighbouring towers. The spill gaussian is widened to sit
        // just past the footing at the new plinth radius.
        // The exponent is the whole argument. At 1.30 (round 2) and again at
        // 1.85 the pool had collapsed to a bright ring hugging the plinth with
        // nothing between towers, which measures as zero coloured light on the
        // floor. Below 1.0 the ramp is concave — it stays bright most of the way
        // out and only lets go near the rim, which is what a real pool of spill
        // light on a flat floor actually looks like.
        float fall = pow( max( 0.0, 1.0 - r ), 0.85 ) * 0.85;
        float spill = exp( - pow( ( r - 0.32 ) / 0.26, 2.0 ) ) * 0.60;
        float breathe = 0.80 + 0.20 * sin( uTime * 1.9 + vP.x * 6.283 );
        float a = atan( vQ.y, vQ.x );
        // Kept deliberately weak and low-frequency: at 6 lobes and 12% depth
        // this read as a star stamped on the floor rather than as a pool.
        float ripple = 0.94 + 0.06 * sin( a * 3.0 + uTime * 0.8 + vP.x * 10.0 );
        gl_FragColor = vec4( vCol * ( fall + spill ) * breathe * ripple * vP.y, 1.0 );
      }
    `,
  });
}

/**
 * One additive billboard soup for every tower's floating arcane band.
 *
 * This used to draw a hard ring, twelve discrete ticks and three hard spokes.
 * At close range that composited into a literal cartwheel; at gameplay range
 * the spokes aliased down to a thin purple asterisk. Both were the same
 * primitive at two scales. The replacement has no spoke, no tick and no hard
 * edge anywhere: two gaussian annuli lit by a smooth rotating sweep, which
 * reads as an orbiting band of light rather than a machined part.
 *
 * It also carries its own LOD. Band structure is only resolvable near the
 * camera, so past ~34 units it dissolves into a soft point of element-coloured
 * light — the shape a viewer can actually resolve at that size — instead of
 * aliasing into geometry that was never there.
 */
export function createRuneMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 aCentre;
      attribute vec3 aColor;
      attribute vec3 aParam;   // x = size, y = seed, z = intensity
      varying vec2 vQ;
      varying vec3 vCol;
      varying vec2 vP;
      varying float vNear;
      void main() {
        vQ = uv * 2.0 - 1.0;
        vCol = aColor;
        vP = aParam.yz;
        vec4 mv = modelViewMatrix * vec4( aCentre, 1.0 );
        mv.xy += position.xy * aParam.x;
        // GLSL smoothstep is undefined for edge0 >= edge1, so the near/far
        // ramp is written the legal way round and inverted.
        vNear = 1.0 - smoothstep( 26.0, 46.0, -mv.z );
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vQ;
      varying vec3 vCol;
      varying vec2 vP;
      varying float vNear;
      uniform float uTime;
      void main() {
        float r = length( vQ );
        if ( r > 1.0 ) discard;
        float a = atan( vQ.y, vQ.x );
        float t = uTime * 0.30 + vP.x * 6.283;

        // Two soft annuli. A gaussian section has no edge to alias.
        float band  = exp( - pow( ( r - 0.70 ) / 0.135, 2.0 ) );
        float band2 = exp( - pow( ( r - 0.46 ) / 0.085, 2.0 ) ) * 0.40;

        // Continuous angular sweep: a comet head chasing round the band. This
        // is the motion cue the ticks used to provide, with nothing countable.
        float sweep = 0.34 + 0.66 * pow( 0.5 + 0.5 * cos( a - t * 1.7 ), 2.5 );
        float sweep2 = 0.40 + 0.60 * pow( 0.5 + 0.5 * cos( a + t * 1.1 + 2.0 ), 3.0 );

        float core = exp( - pow( r / 0.20, 2.0 ) );

        // Near the camera the band must out-weigh the core, or the whole thing
        // collapses into a soft green smudge with no structure at all.
        float structure = ( band * sweep * 1.55 + band2 * sweep2 ) * vNear;
        float alpha = structure + core * ( 0.34 - 0.16 * vNear );
        alpha *= 0.70 + 0.30 * sin( uTime * 1.5 + vP.x * 9.0 );
        alpha *= smoothstep( 1.0, 0.80, r );
        if ( alpha < 0.004 ) discard;
        gl_FragColor = vec4( vCol * 1.15, alpha * vP.y );
      }
    `,
  });
}
