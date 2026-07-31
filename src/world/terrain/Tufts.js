import * as THREE from 'three';

/**
 * Organic invasion: moss and dry grass sprouting out of the terrace joints,
 * the retaining-wall courses and the crumbling rim.
 *
 * Why this exists, from the round-3 blind review and the reference plates:
 * every Element TD 2 frame has vegetation reclaiming the masonry, and *none*
 * of its stone edges are clean. Ours were surgically clean everywhere, which is
 * a large part of what reads as "unfinished — nobody looked at the corners".
 * It is also the cheapest authored detail available: a few hundred instanced
 * blades break every long straight edge in the image without touching a texture.
 *
 * The placement is not decorative — it is keyed to the same wear field that
 * cuts the terrace, so the tufts CLUSTER ALONG THE MAZE WALLS. That makes them
 * do double duty: they outline the route (G8) at exactly the distance where the
 * wall itself is only a few pixels tall, and they re-seed themselves whenever
 * the player rebuilds the maze.
 *
 * Deliberately NOT green. The board has to stay cool-neutral so it opposes the
 * warm backdrop (the frame currently holds ~224 degrees of hue opposition and
 * that is not being spent on weeds); these are ash-grey moss and bleached dead
 * stalks with only a trace of desaturated olive.
 */

const BLADES = 5;

function bladeGeometry() {
  // One tuft: BLADES tapered quads fanned around the origin, each leaning out
  // and curling over. Two triangles per blade, no alpha, no sorting, no
  // alpha-test shimmer at distance — a blade small enough to alias is a blade
  // small enough to be a solid sliver, which is much better behaved.
  const pos = [];
  const nrm = [];
  const hgt = [];   // 0 at the base, 1 at the tip: drives wind + tip colour
  const idx = [];
  let v = 0;
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + (b * 2.399);
    const lean = 0.30 + ((b * 37) % 11) / 11 * 0.45;
    const len = 0.55 + ((b * 53) % 7) / 7 * 0.55;
    const w = 0.048 + ((b * 17) % 5) / 5 * 0.030;
    const dx = Math.cos(a), dz = Math.sin(a);
    // 3 segments so the blade can curl rather than reading as a spike.
    // 2, not 3. At 900 instances every extra segment is 9k triangles for a
    // curl that is two pixels wide at gameplay framing.
    const SEG = 2;
    const ring = [];
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const y = len * (t - 0.18 * t * t);
      const out = lean * len * t * t;
      const hw = w * (1 - t * 0.86);
      ring.push({ x: dx * out, y, z: dz * out, hw, t });
    }
    // Quad strip, width across the blade perpendicular to its lean.
    const px = -dz, pz = dx;
    for (let s = 0; s <= SEG; s++) {
      const r = ring[s];
      pos.push(r.x - px * r.hw, r.y, r.z - pz * r.hw);
      pos.push(r.x + px * r.hw, r.y, r.z + pz * r.hw);
      nrm.push(-dx * 0.3, 1, -dz * 0.3, -dx * 0.3, 1, -dz * 0.3);
      hgt.push(r.t, r.t);
    }
    for (let s = 0; s < SEG; s++) {
      const a0 = v + s * 2;
      idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
    }
    v += (SEG + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aH', new THREE.Float32BufferAttribute(hgt, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export class Tufts {
  /**
   * @param {object} opts
   *  arena     the Arena (for surfaceHeightAt + the zone mask)
   *  max       instance cap; the geometry is allocated once at this size
   */
  constructor(arena, { max = 620, outer = 420, cross = 150 } = {}) {
    this.arena = arena;
    this.max = max + outer + cross;
    this.inner = max;
    this.outer = outer;
    this.cross = cross;

    const geo = bladeGeometry();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.0,
      side: THREE.DoubleSide,
      vertexColors: false,
    });
    // Wind + a tip gradient, both driven off aH. Vertex-side so it costs one
    // sin per vertex on ~90k verts worst case and nothing per fragment.
    const uniforms = { uTime: { value: 0 } };
    this.uniforms = uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `
          #include <common>
          attribute float aH;
          uniform float uTime;
          varying float vH;
        `)
        .replace('#include <begin_vertex>', `
          #include <begin_vertex>
          vH = aH;
          // Wind: two non-commensurate waves phased by world position, so a
          // field of tufts ripples instead of nodding in unison (G6).
          vec3 wp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float ph = wp.x * 0.42 + wp.z * 0.31;
          float sway = sin(uTime * 1.35 + ph) * 0.55 + sin(uTime * 0.61 - ph * 1.7) * 0.45;
          transformed.xz += vec2(0.62, 0.28) * sway * 0.16 * aH * aH;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
          #include <common>
          varying float vH;
        `)
        // Ash-grey at the root, bleached and slightly warmer at the tip. Kept
        // low-chroma on purpose: this must not become a green board.
        .replace('#include <color_fragment>', `
          #include <color_fragment>
          // clamp() is NOT cosmetic. pow() of a negative base is undefined in
          // GLSL and returns NaN on every driver we tested; vH is a varying, so
          // it goes slightly negative under perspective interpolation at the
          // silhouette of a blade. One NaN fragment enters the bloom pyramid,
          // the downsample spreads it across the whole mip chain, and the
          // ENTIRE 3D frame renders black — with zero JS errors, because
          // nothing threw. That is exactly how this bug presented: tufts
          // visible -> black frame, tufts hidden -> correct frame, count=1 ->
          // correct frame (too few pixels to land on a negative varying).
          // MEASURED against the board: at (0.30,0.29,0.21) linear the tips
          // were brighter than the flagstone they grow out of and, after bloom,
          // read as a sprinkle of bright confetti over the whole plate. Weeds
          // are DARK against lit stone. Roughly a third of that value now.
          diffuseColor.rgb *= mix(vec3(0.030, 0.036, 0.030),
                                  vec3(0.115, 0.108, 0.080),
                                  pow(clamp(vH, 0.0, 1.0), 0.80));
        `);
    };
    mat.customProgramCacheKey = () => 'arena-tufts-v3';
    this.material = mat;

    const mesh = new THREE.InstancedMesh(geo, mat, this.max);
    mesh.count = 0;
    mesh.castShadow = false;      // a 0.6-unit blade casts nothing readable
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;   // one draw call either way; the board is small
    mesh.name = 'tufts';
    mesh.userData.noAO = true;    // thin geometry poisons the GTAO G-buffer
    this.mesh = mesh;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this.rebuild();
  }

  /**
   * Re-seed. Called on construction and whenever the maze changes, so tufts
   * follow the terrace edges the player just cut.
   */
  rebuild() {
    const a = this.arena;
    const u = a.uniforms;
    const lo = u.uKerbLo.value, hi = u.uKerbHi.value;
    const mid = (lo + hi) * 0.5;
    const halfW = a.grid.cols * a.grid.cell * 0.5;
    const halfH = a.grid.rows * a.grid.cell * 0.5;

    // Deterministic: the same maze must always grow the same weeds, or every
    // capture differs from the last for reasons nothing to do with the change
    // being tested.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) / 4294967296);
    };

    let n = 0;
    const ATTEMPTS = this.inner * 7;
    for (let k = 0; k < ATTEMPTS && n < this.inner; k++) {
      const x = (rnd() * 2 - 1) * (halfW - 0.35);
      const z = (rnd() * 2 - 1) * (halfH - 0.35);
      const mk = a.sampleMask(x, z);
      const wear = mk[0], decay = mk[1];
      // Hard up against the wall line, where a real weed finds a joint and
      // some shelter. 0.085 of mask value is about 0.3 world units.
      const edge = Math.max(0, 1 - Math.abs(wear - mid) / 0.085);
      const p = edge * edge * 0.95          // the terrace edge, overwhelmingly
              + decay * decay * 0.16;       // and the crumbling rim
      // Nothing out on open flagstone. A weed needs a joint; scattering them
      // across the plate reads as confetti and costs the plate its cleanliness,
      // which is the contrast the terrace edge is spending.
      if (rnd() > p) continue;

      const y = a.surfaceHeightAt(x, z);
      const sc = 0.55 + rnd() * 0.75;
      this._p.set(x, y - 0.04, z);
      this._q.setFromAxisAngle(UP, rnd() * Math.PI * 2);
      this._s.set(sc, sc * (0.7 + rnd() * 0.7), sc);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      n++;
    }
    // ------------------------------------------------------------------
    // THE OUTER BAND — the foot of the perimeter retaining wall.
    //
    // Art Bible corollary: "nothing meets the ground with a clean seam. Clean
    // seams are the single most reliable 'unfinished' tell." Round 4b replaced
    // the platform edge with a retaining wall standing on the environment
    // agent's surround, and that joint is a dead-straight line 188 units long
    // — the single longest clean seam in the frame and, per the coordinator,
    // the likeliest place in it for a G9 artefact. Weeds at the foot of a wall
    // are what a real one looks like and they break the line for ~2.4k tris.
    //
    // These sit OUTSIDE the ground plane, so surfaceHeightAt() cannot answer
    // for them (its relief cache stops at the board's overshoot). They are
    // pinned to laneFloor, which is exactly where the environment agent has
    // been told to meet us (Surround.SHELF), and the surround's relief ramps in
    // from zero over the first 14 units so it is flat to within a centimetre
    // here.
    const wallX = halfW + 0.75, wallZ = halfH + 0.75;   // Arena.#buildRim foot
    const yOut = a.laneFloor;
    const perim = 2 * (wallX + wallZ) * 2;
    // Capped on its OWN count, not on the shared instance budget. The interior
    // pass is highly selective (it only seeds within ~0.3 units of a terrace
    // edge) and typically places ~130 of its 620, so bounding this loop by the
    // shared cap would hand the wall band whatever the maze happened to leave
    // over — and change the whole outer band every time the player builds.
    const outerStart = n;
    for (let k = 0; k < this.outer * 9 && n - outerStart < this.outer && n < this.max; k++) {
      // Walk the perimeter by arc length so the four sides are sampled evenly
      // and the corners are not over-weighted the way a rejection box would.
      const u = rnd() * perim;
      let x, z, ox, oz;
      if (u < 2 * wallX) { x = -wallX + u; z = -wallZ; ox = 0; oz = -1; }
      else if (u < 2 * wallX + 2 * wallZ) { x = wallX; z = -wallZ + (u - 2 * wallX); ox = 1; oz = 0; }
      else if (u < 4 * wallX + 2 * wallZ) { x = wallX - (u - 2 * wallX - 2 * wallZ); z = wallZ; ox = 0; oz = 1; }
      else { x = -wallX; z = wallZ - (u - 4 * wallX - 2 * wallZ); ox = -1; oz = 0; }
      // Clustered, never evenly spaced (Art Bible sec 4). A long-wavelength
      // hash along the run gates whole stretches of wall in or out, so the band
      // reads as drifts of weed rather than as a fringe.
      const clump = Math.sin(u * 0.71) * 0.5 + Math.sin(u * 0.23 + 2.1) * 0.5;
      if (rnd() > 0.20 + Math.max(0, clump) * 0.85) continue;
      const outw = 0.02 + rnd() * rnd() * 0.62;      // biased hard against the wall
      const sc = 0.5 + rnd() * 0.8;
      this._p.set(x + ox * outw, yOut - 0.05, z + oz * outw);
      this._q.setFromAxisAngle(UP, rnd() * Math.PI * 2);
      this._s.set(sc, sc * (0.7 + rnd() * 0.8), sc);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      n++;
    }

    // ------------------------------------------------------------------
    // THE CROSSING BAND — vegetation growing THROUGH the collapsed sections.
    //
    // Art Bible §0 law 6, added after round 4b's blind test failed 3-for-3:
    // "Reference walls are interrupted: collapsed sections, rubble spilling
    // through, VEGETATION CROSSING THEM… Terrain must read as continuous across
    // the boundary at at least two points per side."
    //
    // The wall geometry is already down at the eight authored breaches and the
    // floor material already spills rubble inboard through them. What actually
    // sells "continuous" to the eye, though, is a single population of the same
    // plants standing on both sides of where the line used to be — a weed does
    // not know the board ends. So these straddle the wall from 0.6 units inside
    // the play field to 0.9 outside, and their density is driven by the same
    // breach field, so they exist only where the wall genuinely is not.
    //
    // Heights: inboard of o = +0.15 the ground plane still exists and
    // surfaceHeightAt() is authoritative. Outboard of it the collapsed profile
    // is a talus bank running from the ground plane's own skirted edge
    // (y = -0.07 at o = 0.15, derived in Arena.#buildRim) down to the footing at
    // laneFloor, so the height is interpolated along that bank. Nothing here
    // hardcodes a Y.
    const RIM_OUT = 0.45;
    const hxLine = halfW + RIM_OUT, hzLine = halfH + RIM_OUT;
    const EDGE_O = 0.15, EDGE_Y = a.plateauTop - (RIM_OUT + EDGE_O) * 0.45;
    const FOOT_O = 0.75;
    const perim2 = 2 * (hxLine + hzLine) * 2;
    const crossStart = n;
    for (let k = 0; k < this.cross * 26 && n - crossStart < this.cross && n < this.max; k++) {
      const u = rnd() * perim2;
      let x, z, ox, oz;
      if (u < 2 * hxLine) { x = -hxLine + u; z = -hzLine; ox = 0; oz = -1; }
      else if (u < 2 * hxLine + 2 * hzLine) { x = hxLine; z = -hzLine + (u - 2 * hxLine); ox = 1; oz = 0; }
      else if (u < 4 * hxLine + 2 * hzLine) { x = hxLine - (u - 2 * hxLine - 2 * hzLine); z = hzLine; ox = 0; oz = 1; }
      else { x = -hxLine; z = hzLine - (u - 4 * hxLine - 2 * hzLine); ox = -1; oz = 0; }
      const b = a.breachAt(x, z);
      if (b < 0.12 || rnd() > b * 0.92) continue;
      // Biased outward: the far side of a breach is where the spill lands.
      const o = -0.60 + rnd() * 1.50;
      const px = x + ox * o, pz = z + oz * o;
      let y;
      if (o <= EDGE_O) y = a.surfaceHeightAt(px, pz);
      else {
        const t = Math.min(1, (o - EDGE_O) / (FOOT_O - EDGE_O));
        y = EDGE_Y + (a.laneFloor - EDGE_Y) * t * t;
      }
      const sc = 0.5 + rnd() * 0.9;
      this._p.set(px, y - 0.05, pz);
      this._q.setFromAxisAngle(UP, rnd() * Math.PI * 2);
      this._s.set(sc, sc * (0.7 + rnd() * 0.8), sc);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      n++;
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.count = n;
  }

  update(elapsed) { this.uniforms.uTime.value = elapsed; }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
