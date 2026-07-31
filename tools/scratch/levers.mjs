/**
 * levers.mjs — paired A/B measurement of 24 runtime-patch recipes at preset `high`.
 *
 * Rules this probe obeys, because PERF_BUDGET.md says every one of them was
 * violated at least once already:
 *
 *  - PAIRED ONLY. A fresh baseline is measured in THIS run before the recipes and
 *    again after them. Nothing is compared against a number in a doc.
 *  - RESOLUTION IS PINNED in the baseline and in every recipe run.
 *    AdaptiveResolution is on by default and trades pixels to hold 16.6 ms, so
 *    left alone it silently absorbs whatever a recipe saves and every row reads
 *    "no effect". Pinning is part of the control, not part of a recipe.
 *  - 16.7 ms is VSYNC. Any median <= 17.4 is reported as `hit-vsync`, which means
 *    the saving is a LOWER BOUND, never the value.
 *  - +-2 ms is the run-to-run noise floor on this machine, so a delta inside that
 *    band is reported as `no-effect` rather than as a small win.
 *
 * Usage: node tools/scratch/levers.mjs [preset] [--only=substr]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const PRESET = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'high';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const VSYNC = 17.4;
const NOISE = 2.0;
const FRAMES = 140;
const SETTLE_MS = 1500;   // >= 1200 required for shader recompilation

// ---------------------------------------------------------------- the recipes
// Source is verbatim from the analysis agents. String.raw so that the \n escapes
// inside the shader-string surgery survive into the page unchanged.
const RECIPES = [

// ============================================================ LEVER A: MSAA / composer target format
{ lever: 'A msaa-target-format', label: 'A1 resolveDepthBuffer=false on both composer buffers', js: String.raw`
const g = window.__game, p = g.pipeline, r = p.renderer, c = p.composer;
if (p.adaptive) { p.adaptive.enabled = false; r.setPixelRatio(p.adaptive.maxScale); }
p.resize();
c.renderTarget1.resolveDepthBuffer = false;
c.renderTarget2.resolveDepthBuffer = false;
const gl = r.getContext();
return {
  recipe: 'resolveDepthBuffer=false',
  samples: [c.renderTarget1.samples, c.renderTarget2.samples],
  resolveDepth: [c.renderTarget1.resolveDepthBuffer, c.renderTarget2.resolveDepthBuffer],
  type: c.renderTarget1.texture.type,
  rtSize: [c.renderTarget1.width, c.renderTarget1.height],
  pixelRatio: r.getPixelRatio(),
  drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
  msaaRTTextension: r.extensions.has('WEBGL_multisampled_render_to_texture'),
  passes: c.passes.filter(x => x.enabled).map(x => x.constructor.name),
};
` },

{ lever: 'A msaa-target-format', label: 'A2 MSAA scene-only (post buffers samples=0 + private 4x target)', js: String.raw`
const g = window.__game, p = g.pipeline, r = p.renderer, c = p.composer;
if (p.adaptive) { p.adaptive.enabled = false; r.setPixelRatio(p.adaptive.maxScale); }
p.resize();
const ms = c.renderTarget1.clone();
ms.texture.name = 'sceneMS';
const flat = c.renderTarget1.clone();
flat.samples = 0;
flat.texture.name = 'EffectComposer.flat';
c.reset(flat);
const rp = p.passes.render;
const cp = c.copyPass;
cp.clear = true;
cp.material.depthTest = false;
cp.material.depthWrite = false;
cp.material.needsUpdate = true;
if (!rp.__msPatched) {
  rp.__msPatched = true;
  const inner = rp.render.bind(rp);
  rp.render = (renderer, writeBuffer, readBuffer, dt, maskActive) => {
    if (rp.renderToScreen) { inner(renderer, writeBuffer, readBuffer, dt, maskActive); return; }
    if (ms.width !== readBuffer.width || ms.height !== readBuffer.height) ms.setSize(readBuffer.width, readBuffer.height);
    inner(renderer, ms, ms, dt, maskActive);
    cp.render(renderer, readBuffer, ms, dt);
  };
}
const gl = r.getContext();
return {
  recipe: 'MSAA scene-only',
  sceneSamples: ms.samples,
  postSamples: [c.renderTarget1.samples, c.renderTarget2.samples],
  type: c.renderTarget1.texture.type,
  rtSize: [c.renderTarget1.width, c.renderTarget1.height],
  pixelRatio: r.getPixelRatio(),
  drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
  msaaRTTextension: r.extensions.has('WEBGL_multisampled_render_to_texture'),
};
` },

{ lever: 'A msaa-target-format', label: 'A3 samples 4 -> 0 on both composer buffers (composer.reset)', js: String.raw`
const g = window.__game, p = g.pipeline, r = p.renderer, c = p.composer;
if (p.adaptive) { p.adaptive.enabled = false; r.setPixelRatio(p.adaptive.maxScale); }
p.resize();
const rt = c.renderTarget1.clone();
rt.samples = 0;
rt.texture.name = 'EffectComposer.rt1.noMSAA';
c.reset(rt);
const gl = r.getContext();
return {
  recipe: 'samples=0',
  samples: [c.renderTarget1.samples, c.renderTarget2.samples],
  type: c.renderTarget1.texture.type,
  maxSamples: r.capabilities.maxSamples,
  rtSize: [c.renderTarget1.width, c.renderTarget1.height],
  pixelRatio: r.getPixelRatio(),
  drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
  msaaRTTextension: r.extensions.has('WEBGL_multisampled_render_to_texture'),
};
` },

{ lever: 'A msaa-target-format', label: 'A4 HalfFloat -> UnsignedByte (RGBA8), samples kept at 4 [DIAGNOSTIC]', js: String.raw`
const g = window.__game, p = g.pipeline, r = p.renderer, c = p.composer;
if (p.adaptive) { p.adaptive.enabled = false; r.setPixelRatio(p.adaptive.maxScale); }
p.resize();
const rt = c.renderTarget1.clone();
rt.samples = c.renderTarget1.samples;
rt.texture.type = 1009;
rt.texture.internalFormat = null;
rt.texture.name = 'EffectComposer.rt1.rgba8';
c.reset(rt);
const gl = r.getContext();
return {
  recipe: 'RGBA8 (LDR) diagnostic',
  samples: [c.renderTarget1.samples, c.renderTarget2.samples],
  type: [c.renderTarget1.texture.type, c.renderTarget2.texture.type],
  colorSpace: c.renderTarget1.texture.colorSpace,
  rtSize: [c.renderTarget1.width, c.renderTarget1.height],
  pixelRatio: r.getPixelRatio(),
  drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
};
` },

// ============================================================ LEVER B: GTAOPass
{ lever: 'B gtao', label: 'B1 skip duplicated shadow-map render inside GTAO prepass', js: String.raw`
const p = window.__game && window.__game.pipeline;
const gtao = p && p.passes && p.passes.gtao;
if (!gtao) return 'no gtao pass (preset has ssao:false?)';
if (gtao.__shadowSkipPatched) return 'already patched';
const renderer = p.renderer;
const inner = gtao.render.bind(gtao);
gtao.render = function (r, writeBuffer, readBuffer, deltaTime, maskActive) {
  const sm = renderer.shadowMap;
  const au = sm.autoUpdate, nu = sm.needsUpdate;
  sm.autoUpdate = false; sm.needsUpdate = false;
  try { inner(r, writeBuffer, readBuffer, deltaTime, maskActive); }
  finally { sm.autoUpdate = au; sm.needsUpdate = nu; }
};
gtao.__shadowSkipPatched = true;
return 'gtao prepass will no longer re-render shadow maps; renderGBuffer=' + gtao._renderGBuffer + ' shadowType=' + renderer.shadowMap.type;
` },

{ lever: 'B gtao', label: 'B2 half-resolution AO (prepass + AO + denoise at 0.5x)', js: String.raw`
const p = window.__game && window.__game.pipeline;
const gtao = p && p.passes && p.passes.gtao;
if (!gtao) return 'no gtao pass';
if (gtao.__halfResPatched) return 'already patched';
const orig = gtao.setSize.bind(gtao);
const SC = 0.5;
gtao.setSize = function (w, h) {
  orig(Math.max(1, Math.round(w * SC)), Math.max(1, Math.round(h * SC)));
};
gtao.setSize(gtao.width, gtao.height);
gtao.__halfResPatched = true;
return 'AO targets now ' + gtao.width + 'x' + gtao.height + ' (gtaoRT ' + gtao.gtaoRenderTarget.width + 'x' + gtao.gtaoRenderTarget.height + ', normalRT ' + gtao.normalRenderTarget.width + 'x' + gtao.normalRenderTarget.height + ')';
` },

{ lever: 'B gtao', label: 'B3 ssaoSamples -> 6, pdSamples -> 4', js: String.raw`
const p = window.__game && window.__game.pipeline;
const gtao = p && p.passes && p.passes.gtao;
if (!gtao) return 'no gtao pass';
const before = { ao: gtao.gtaoMaterial.defines.SAMPLES, pd: gtao.pdSamples };
gtao.updateGtaoMaterial({ samples: 6 });
gtao.updatePdMaterial({ samples: 4 });
gtao.gtaoMaterial.customProgramCacheKey = function () { return 'gtao-s6-probe'; };
gtao.gtaoMaterial.needsUpdate = true;
gtao.pdMaterial.customProgramCacheKey = function () { return 'pd-s4-probe'; };
gtao.pdMaterial.needsUpdate = true;
return 'SAMPLES ' + before.ao + '->' + gtao.gtaoMaterial.defines.SAMPLES + ', pdSamples ' + before.pd + '->' + gtao.pdSamples;
` },

{ lever: 'B gtao', label: 'B4 freeze the G-buffer (_renderGBuffer=false) [DIAGNOSTIC]', js: String.raw`
const p = window.__game && window.__game.pipeline;
const gtao = p && p.passes && p.passes.gtao;
if (!gtao) return 'no gtao pass';
gtao._renderGBuffer = false;
return 'prepass off; normalRT ' + gtao.normalRenderTarget.width + 'x' + gtao.normalRenderTarget.height + ' frozen, AO+denoise+copy+blend still running';
` },

// ============================================================ LEVER C: shadow map
{ lever: 'C shadows', label: 'C1 blurSamples 16 -> 6 (VSM kept, map size kept)', js: String.raw`
const g = window.__game;
const k = g.lighting.key;
const r = g.pipeline.renderer;
const before = k.shadow.blurSamples;
k.shadow.blurSamples = 6;
r.shadowMap.needsUpdate = true;
k.shadow.needsUpdate = true;
return { before, after: k.shadow.blurSamples, radiusTexels: k.shadow.radius, mapSize: k.shadow.mapSize.x, shadowMapType: r.shadowMap.type };
` },

{ lever: 'C shadows', label: 'C2 VSM -> PCF (map size kept)', js: String.raw`
const g = window.__game;
const r = g.pipeline.renderer;
const k = g.lighting.key;
r.shadowMap.type = 1;
if (k.shadow.map) {
  if (k.shadow.map.depthTexture) { k.shadow.map.depthTexture.dispose(); k.shadow.map.depthTexture = null; }
  k.shadow.map.dispose(); k.shadow.map = null;
}
if (k.shadow.mapPass) { k.shadow.mapPass.dispose(); k.shadow.mapPass = null; }
let patched = 0, dirty = 0;
const touch = (m) => {
  if (!m || m.__pcfPatched) return;
  const prev = m.customProgramCacheKey;
  if (typeof prev === 'function') {
    const base = String(prev.call(m));
    m.customProgramCacheKey = () => base + '|pcf1';
    patched++;
  } else {
    m.customProgramCacheKey = () => 'pcf1';
    patched++;
  }
  m.__pcfPatched = true;
  m.needsUpdate = true;
  dirty++;
};
g.scene.traverse((o) => {
  if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(touch);
  if (o.customDepthMaterial) touch(o.customDepthMaterial);
  if (o.customDistanceMaterial) touch(o.customDistanceMaterial);
});
r.shadowMap.needsUpdate = true;
k.shadow.needsUpdate = true;
const dropped = [];
g.scene.traverse((o) => {
  if ((o.isMesh || o.isInstancedMesh || o.isBatchedMesh) && !o.castShadow && o.receiveShadow) {
    dropped.push({ name: o.name || o.type, frustumCulled: o.frustumCulled, count: o.isInstancedMesh ? o.count : undefined, customDepth: !!o.customDepthMaterial });
  }
});
return { shadowMapType: r.shadowMap.type, mapSize: k.shadow.mapSize.x, radiusTexels: k.shadow.radius, materialsPatched: patched, materialsDirty: dirty, droppedFromDepthPass: dropped };
` },

{ lever: 'C shadows', label: 'C3 shadow map -> 1024 (VSM kept, blurSamples 6)', js: String.raw`
const g = window.__game;
const r = g.pipeline.renderer;
const k = g.lighting.key;
const before = k.shadow.mapSize.x;
k.shadow.mapSize.set(1024, 1024);
if (k.shadow.map) {
  if (k.shadow.map.depthTexture) { k.shadow.map.depthTexture.dispose(); k.shadow.map.depthTexture = null; }
  k.shadow.map.dispose(); k.shadow.map = null;
}
if (k.shadow.mapPass) { k.shadow.mapPass.dispose(); k.shadow.mapPass = null; }
k.shadow.blurSamples = 6;
r.shadowMap.needsUpdate = true;
k.shadow.needsUpdate = true;
return { before, after: k.shadow.mapSize.x, blurSamples: k.shadow.blurSamples, shadowMapType: r.shadowMap.type, texelsPerWorldUnit: +(1024 / 92).toFixed(2), penumbraWorldUnits: +(k.shadow.radius * 92 / 1024).toFixed(3) };
` },

{ lever: 'C shadows', label: 'C4 shadowMap.autoUpdate=false, invalidate every 4th frame [MEDIAN-ONLY]', js: String.raw`
const g = window.__game;
const r = g.pipeline.renderer;
r.shadowMap.autoUpdate = false;
r.shadowMap.needsUpdate = true;
const PERIOD = 4;
let n = 0, updates = 0;
if (!g.__origFrame) {
  g.__origFrame = g.frame.bind(g);
  g.frame = (dt) => {
    if ((n++ % PERIOD) === 0) { r.shadowMap.needsUpdate = true; updates++; }
    return g.__origFrame(dt);
  };
}
g.__shadowThrottleStats = () => ({ frames: n, shadowUpdates: updates, period: PERIOD });
return { autoUpdate: r.shadowMap.autoUpdate, period: PERIOD, patchedFrame: true, warning: 'MEDIAN-ONLY: 1 frame in 4 still pays the full shadow cost' };
` },

// ============================================================ LEVER D: post-chain ping-pong
{ lever: 'D pingpong', label: 'D1 resolveDepthBuffer=false + resolveStencilBuffer=false', js: String.raw`
const p = window.__game.pipeline, c = p.composer;
const rts = [c.renderTarget1, c.renderTarget2];
const before = rts.map(r => r.samples + '/' + r.depthBuffer + '/' + r.resolveDepthBuffer).join(' ');
for (const rt of rts) { rt.resolveDepthBuffer = false; rt.resolveStencilBuffer = false; }
window.__recipe = { name: 'resolveDepthBuffer=false', before, noop: rts.every(r => r.samples === 0), samples: rts.map(r => r.samples) };
return window.__recipe;
` },

{ lever: 'D pingpong', label: 'D2 three-buffer routing: resolve MSAA scene target once, chain single-sampled', js: String.raw`
const p = window.__game.pipeline, c = p.composer;
if (c.renderTarget2.samples === 0) { window.__recipe = { name: '3-buffer', noop: true, why: 'samples already 0' }; return window.__recipe; }
const S = c.renderTarget2;
S.texture.name = 'pp.S(msaa)';
const A = S.clone(); A.samples = 0; A.depthBuffer = false; A.resolveDepthBuffer = false; A.texture.name = 'pp.A';
const B = S.clone(); B.samples = 0; B.depthBuffer = false; B.resolveDepthBuffer = false; B.texture.name = 'pp.B';
try { c.renderTarget1.dispose(); } catch (e) {}
c.renderTarget1 = A;
c.renderTarget2 = S;
c.swapBuffers = function () {
  this.readBuffer = this.writeBuffer;
  this.writeBuffer = (this.readBuffer === A) ? B : A;
};
const innerRender = c.render.bind(c);
c.render = function (dt) { c.readBuffer = S; c.writeBuffer = A; innerRender(dt); };
const oldResize = p.resize.bind(p);
p.resize = function () { oldResize(); if (B.width !== A.width || B.height !== A.height) B.setSize(A.width, A.height); };
window.__recipe = { name: '3-buffer routing', S: [S.width, S.height, S.samples], A: [A.width, A.height, A.samples], passes: c.passes.map(x => x.constructor.name + (x.enabled ? '' : '(off)')).join(' -> ') };
return window.__recipe;
` },

{ lever: 'D pingpong', label: 'D3 fold OutputPass (ACES+exposure+sRGB) into the grade shader', js: String.raw`
const p = window.__game.pipeline;
const grade = p.passes.grade, out = p.passes.output;
if (!grade || !out || out.enabled === false) { window.__recipe = { name: 'fold output', noop: true }; return window.__recipe; }
const m = grade.material;
m.uniforms.uExposure = { value: p.renderer.toneMappingExposure };
let fs = m.fragmentShader;
const head = 'uniform sampler2D tDiffuse;';
if (fs.indexOf(head) < 0) throw new Error('grade shader shape changed');
fs = fs.replace(head, head + '\nuniform float uExposure;\n' +
  'vec3 rrtOdtFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }\n' +
  'vec3 acesFilmic(vec3 c){\n' +
  '  const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);\n' +
  '  const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);\n' +
  '  c *= uExposure / 0.6;\n' +
  '  c = ACESIn * c; c = rrtOdtFit(c); c = ACESOut * c;\n' +
  '  return clamp(c, 0.0, 1.0);\n' +
  '}\n' +
  'vec3 srgbOETF(vec3 v){ return mix(pow(v, vec3(0.41666)) * 1.055 - vec3(0.055), v * 12.92, vec3(lessThanEqual(v, vec3(0.0031308)))); }');
const tail = 'gl_FragColor = vec4(max(col, 0.0), 1.0);';
if (fs.indexOf(tail) < 0) throw new Error('grade shader tail changed');
fs = fs.replace(tail, 'gl_FragColor = vec4(srgbOETF(acesFilmic(max(col, 0.0))), 1.0);');
m.fragmentShader = fs;
m.needsUpdate = true;
m.customProgramCacheKey = function () { return 'grade+aces+srgb-v1'; };
out.enabled = false;
window.__recipe = { name: 'fold output into grade', exposure: m.uniforms.uExposure.value, hasAces: m.fragmentShader.indexOf('acesFilmic') > 0, outputEnabled: out.enabled };
return window.__recipe;
` },

{ lever: 'D pingpong', label: 'D4 samples=0 on both composer buffers via rt.dispose() [DIAGNOSTIC]', js: String.raw`
const c = window.__game.pipeline.composer;
const was = [c.renderTarget1.samples, c.renderTarget2.samples];
if (was[0] === 0 && was[1] === 0) { window.__recipe = { name: 'msaa off', noop: true }; return window.__recipe; }
for (const rt of [c.renderTarget1, c.renderTarget2]) {
  rt.samples = 0;
  rt.resolveDepthBuffer = false;
  rt.dispose();
}
window.__recipe = { name: 'msaa off (upper bound on the whole mechanism)', was, now: [c.renderTarget1.samples, c.renderTarget2.samples] };
return window.__recipe;
` },

// ============================================================ LEVER E: GroundMaterial
{ lever: 'E ground', label: 'E1 ground -> constant-colour ShaderMaterial (displacement kept) [DIAGNOSTIC]', js: String.raw`
const g = window.__game; const a = g.arena; const mesh = a.ground;
if (!mesh) return 'FAIL: no arena.ground';
let SM = a.gridMaterial && a.gridMaterial.constructor;
if (!SM) { g.scene.traverse((o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!SM && m && m.isShaderMaterial && !m.isRawShaderMaterial) SM = m.constructor; }); }
if (!SM) return 'FAIL: no ShaderMaterial ctor in scene';
const U = a.uniforms;
const vert = [
  'uniform sampler2D uMask, uMacro;',
  'uniform float uRoadDepth, uKerbLo, uKerbHi;',
  'void main() {',
  '  vec2 wxz0 = (modelMatrix * vec4(position, 1.0)).xz;',
  '  vec4 mc2 = texture2D(uMacro, wxz0 * 0.052 + vec2(0.37, 0.11));',
  '  vec2 warp = (vec2(mc2.r, mc2.b) - 0.5) * 0.05;',
  '  vec4 mk = texture2D(uMask, clamp(uv + warp, vec2(0.002), vec2(0.998)));',
  '  float k = smoothstep(uKerbLo, uKerbHi, mk.r);',
  '  float decay = smoothstep(0.40, 0.94, mk.g + (mc2.r - 0.5) * 0.42);',
  '  vec3 tp = position;',
  '  tp.y -= k * uRoadDepth + decay * 0.16 * (0.4 + mc2.g);',
  '  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(tp, 1.0);',
  '}'
].join('\n');
const frag = 'void main() { gl_FragColor = vec4(0.055, 0.058, 0.068, 1.0); }';
const cheap = new SM({
  uniforms: { uMask: U.uMask, uMacro: U.uMacro, uRoadDepth: U.uRoadDepth, uKerbLo: U.uKerbLo, uKerbHi: U.uKerbHi },
  vertexShader: vert, fragmentShader: frag,
});
cheap.name = 'ground-stub';
cheap.customProgramCacheKey = () => 'ground-stub-const-v1';
mesh.__origMat = mesh.material;
mesh.material = cheap;
mesh.material.needsUpdate = true;
return 'ground -> constant ShaderMaterial';
` },

{ lever: 'E ground', label: 'E2 anisotropy -> 1 on the 7 ground maps', js: String.raw`
const t = window.__game.arena.tex;
const list = [
  ['flag.albedo', t.flag && t.flag.albedo], ['flag.nra', t.flag && t.flag.nra],
  ['road.albedo', t.road && t.road.albedo], ['road.nra', t.road && t.road.nra],
  ['decay.albedo', t.decay && t.decay.albedo], ['decay.nra', t.decay && t.decay.nra],
  ['macro', t.macro && t.macro.texture],
];
const before = [];
let n = 0;
for (const [name, tx] of list) {
  if (!tx) { before.push(name + '=MISSING'); continue; }
  before.push(name + '=' + tx.anisotropy);
  tx.anisotropy = 1;
  tx.needsUpdate = true;
  n++;
}
window.__anisoBefore = before.join(' ');
return 'anisotropy -> 1 on ' + n + ' ground maps; was: ' + before.join(' ');
` },

{ lever: 'E ground', label: 'E3 fetch-count diet: flag variants 3->1, shadow march 4->1 taps, mac4=mac3', js: String.raw`
const mat = window.__game.arena.groundMaterial;
if (!mat || !mat.onBeforeCompile) return 'FAIL: no arena.groundMaterial.onBeforeCompile';
const orig = mat.onBeforeCompile;
const rep = [
  ['vec4 aF2 = texture2D(uFlagA, uvF2);', 'vec4 aF2 = aF;'],
  ['vec4 nF2 = texture2D(uFlagN, uvF2);', 'vec4 nF2 = nF;'],
  ['vec4 aF3 = texture2D(uFlagA, uvF3);', 'vec4 aF3 = aF;'],
  ['vec4 nF3 = texture2D(uFlagN, uvF3);', 'vec4 nF3 = nF;'],
  ['for (int s = 0; s < 4; s++)', 'for (int s = 0; s < 1; s++)'],
  ['vec4 mac4 = texture2D(uMacro, wxz * 0.415 + vec2(0.77, 0.34));', 'vec4 mac4 = mac3;'],
];
const miss = [];
mat.onBeforeCompile = function (shader, renderer) {
  orig.call(this, shader, renderer);
  let fs = shader.fragmentShader;
  for (const pair of rep) {
    if (fs.indexOf(pair[0]) < 0) { miss.push(pair[0]); continue; }
    fs = fs.split(pair[0]).join(pair[1]);
  }
  shader.fragmentShader = fs;
  window.__dietMiss = miss.slice();
  window.__dietFetches = (fs.match(/texture2D\(/g) || []).length;
};
mat.customProgramCacheKey = () => 'arena-ground-diet-v1';
mat.needsUpdate = true;
window.__dietMiss = 'pending-compile';
return 'ground shader patched';
` },

{ lever: 'E ground', label: 'E4 stock MeshStandardMaterial on ground (lights+shadow kept) [DIAGNOSTIC]', js: String.raw`
const g = window.__game; const a = g.arena; const mesh = a.ground;
if (!mesh) return 'FAIL: no arena.ground';
const MS = a.groundMaterial.constructor;
const U = a.uniforms;
const KERB = [
  'uniform sampler2D uMask, uMacro;',
  'uniform float uRoadDepth, uKerbLo, uKerbHi;',
  'vec3 terrainSink(vec2 wxz, vec2 auv) {',
  '  vec4 mc2 = texture2D(uMacro, wxz * 0.052 + vec2(0.37, 0.11));',
  '  vec2 warp = (vec2(mc2.r, mc2.b) - 0.5) * 0.05;',
  '  vec4 mk = texture2D(uMask, clamp(auv + warp, vec2(0.002), vec2(0.998)));',
  '  float k = smoothstep(uKerbLo, uKerbHi, mk.r);',
  '  float decay = smoothstep(0.40, 0.94, mk.g + (mc2.r - 0.5) * 0.42);',
  '  float sink = k * uRoadDepth + decay * 0.16 * (0.4 + mc2.g);',
  '  return vec3(sink, k, decay);',
  '}'
].join('\n');
const m = new MS({
  map: U.uFlagA.value, normalMap: U.uFlagN.value,
  roughnessMap: U.uFlagN.value, aoMap: U.uFlagN.value,
  roughness: 1.0, metalness: 0.0, envMapIntensity: 1.25, dithering: true,
});
m.name = 'ground-stock';
m.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, {
    uMask: U.uMask, uMacro: U.uMacro, uRoadDepth: U.uRoadDepth,
    uKerbLo: U.uKerbLo, uKerbHi: U.uKerbHi,
  });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + KERB)
    .replace('#include <begin_vertex>',
      '#include <begin_vertex>\n vec2 wxz0 = (modelMatrix * vec4(position, 1.0)).xz;\n transformed.y -= terrainSink(wxz0, uv).x;');
};
m.customProgramCacheKey = () => 'ground-stock-standard-v1';
mesh.__origMat = mesh.material;
mesh.material = m;
m.needsUpdate = true;
return 'ground -> stock MeshStandardMaterial';
` },

// ============================================================ LEVER F: lights
{ lever: 'F lights', label: 'F1 fx pool point lights off (6 lights)', js: String.raw`
const g = window.__game;
const scene = g.scene;
const census = () => {
  const c = { point: 0, dir: 0, dirShadow: 0, hemi: 0, ambient: 0, spot: 0, list: [] };
  scene.traverseVisible((o) => {
    if (!o.isLight) return;
    let t = 'other';
    if (o.isPointLight) { c.point++; t = 'point'; }
    else if (o.isDirectionalLight) { c.dir++; t = 'dir'; if (o.castShadow) c.dirShadow++; }
    else if (o.isHemisphereLight) { c.hemi++; t = 'hemi'; }
    else if (o.isAmbientLight) { c.ambient++; t = 'ambient'; }
    else if (o.isSpotLight) { c.spot++; t = 'spot'; }
    c.list.push({ type: t, name: o.name || '(unnamed)', intensity: o.intensity, shadow: !!o.castShadow, parent: o.parent && o.parent.name });
  });
  return c;
};
const before = census();
const pool = g.fx && g.fx.lights;
let off = 0;
if (pool) {
  for (const it of (pool.items || [])) { it.light.visible = false; off++; }
  for (const it of (pool.embers || [])) { it.light.visible = false; off++; }
}
scene.traverse((o) => { const m = o.material; if (!m) return; (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; }); });
return { recipe: 'F1', lightsHidden: off, before, after: census() };
` },

{ lever: 'F lights', label: 'F2 cumulative: all point lights off (fx + portals + towers)', js: String.raw`
const g = window.__game;
const scene = g.scene;
const census = () => {
  const c = { point: 0, dir: 0, dirShadow: 0, hemi: 0, ambient: 0, list: [] };
  scene.traverseVisible((o) => {
    if (!o.isLight) return;
    if (o.isPointLight) c.point++;
    else if (o.isDirectionalLight) { c.dir++; if (o.castShadow) c.dirShadow++; }
    else if (o.isHemisphereLight) c.hemi++;
    else if (o.isAmbientLight) c.ambient++;
  });
  return c;
};
const before = census();
const hidden = { fx: 0, portal: 0, tower: 0, other: 0 };
const pool = g.fx && g.fx.lights;
if (pool) {
  for (const it of (pool.items || [])) { it.light.visible = false; hidden.fx++; }
  for (const it of (pool.embers || [])) { it.light.visible = false; hidden.fx++; }
}
for (const p of [g.arena && g.arena.spawnPortal, g.arena && g.arena.goalPortal]) {
  const l = p && p.userData && p.userData.light;
  if (l) { l.visible = false; hidden.portal++; }
}
const tb = g.towers && (g.towers.batch || g.towers.towerBatch);
for (const slot of ((tb && tb.lights) || [])) { slot.light.visible = false; hidden.tower++; }
scene.traverse((o) => { if (o.isPointLight && o.visible) { o.visible = false; hidden.other++; } });
scene.traverse((o) => { const m = o.material; if (!m) return; (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; }); });
return { recipe: 'F2', hidden, before, after: census() };
` },

{ lever: 'F lights', label: 'F3 cumulative: F2 + fill/rim/ember directionals off', js: String.raw`
const g = window.__game;
const scene = g.scene;
const census = () => {
  const c = { point: 0, dir: 0, dirShadow: 0, hemi: 0, ambient: 0 };
  scene.traverseVisible((o) => {
    if (!o.isLight) return;
    if (o.isPointLight) c.point++;
    else if (o.isDirectionalLight) { c.dir++; if (o.castShadow) c.dirShadow++; }
    else if (o.isHemisphereLight) c.hemi++;
    else if (o.isAmbientLight) c.ambient++;
  });
  return c;
};
const before = census();
const hidden = { point: 0, dir: 0 };
const pool = g.fx && g.fx.lights;
if (pool) {
  for (const it of (pool.items || [])) { it.light.visible = false; hidden.point++; }
  for (const it of (pool.embers || [])) { it.light.visible = false; hidden.point++; }
}
for (const p of [g.arena && g.arena.spawnPortal, g.arena && g.arena.goalPortal]) {
  const l = p && p.userData && p.userData.light;
  if (l) { l.visible = false; hidden.point++; }
}
const tb = g.towers && (g.towers.batch || g.towers.towerBatch);
for (const slot of ((tb && tb.lights) || [])) { slot.light.visible = false; hidden.point++; }
scene.traverse((o) => { if (o.isPointLight && o.visible) { o.visible = false; hidden.point++; } });
const L = g.lighting || (g.environment && g.environment.lighting);
for (const name of ['fill', 'rim', 'ember']) {
  const l = L && L[name];
  if (l && l.isDirectionalLight) { l.visible = false; hidden.dir++; }
}
scene.traverse((o) => { const m = o.material; if (!m) return; (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; }); });
return { recipe: 'F3', hidden, before, after: census() };
` },

{ lever: 'F lights', label: 'F4 cumulative: F3 + surround made unlit [DIAGNOSTIC, deletes surround art]', js: String.raw`
const g = window.__game;
const scene = g.scene;
const census = () => {
  const c = { point: 0, dir: 0, hemi: 0, ambient: 0 };
  scene.traverseVisible((o) => {
    if (!o.isLight) return;
    if (o.isPointLight) c.point++;
    else if (o.isDirectionalLight) c.dir++;
    else if (o.isHemisphereLight) c.hemi++;
    else if (o.isAmbientLight) c.ambient++;
  });
  return c;
};
const pool = g.fx && g.fx.lights;
if (pool) {
  for (const it of (pool.items || [])) it.light.visible = false;
  for (const it of (pool.embers || [])) it.light.visible = false;
}
for (const p of [g.arena && g.arena.spawnPortal, g.arena && g.arena.goalPortal]) {
  const l = p && p.userData && p.userData.light; if (l) l.visible = false;
}
const tb = g.towers && (g.towers.batch || g.towers.towerBatch);
for (const slot of ((tb && tb.lights) || [])) slot.light.visible = false;
scene.traverse((o) => { if (o.isPointLight) o.visible = false; });
const L = g.lighting || (g.environment && g.environment.lighting);
for (const name of ['fill', 'rim', 'ember']) { const l = L && L[name]; if (l) l.visible = false; }
let grp = (g.environment && g.environment.backdrop && g.environment.backdrop.group) || null;
if (!grp) scene.traverse((o) => { if (!grp && o.isGroup && o.name === 'surround') grp = o; });
const swapped = [];
let skipped = 0;
let usedFallback = 0;
if (grp) {
  grp.traverse((o) => {
    const m = o.material;
    if (!m || Array.isArray(m)) { if (m) skipped++; return; }
    if (!m.isMeshStandardMaterial) { skipped++; return; }
    const u = m.userData && m.userData.uniforms;
    const src = (u && u.uMid && u.uMid.value) || (u && u.uLow && u.uLow.value) || m.color;
    let basic = null;
    if (window.THREE && window.THREE.MeshBasicMaterial) {
      basic = new window.THREE.MeshBasicMaterial({
        name: m.name + '-unlit', color: src.clone ? src.clone() : src,
        vertexColors: m.vertexColors, side: m.side, transparent: m.transparent,
        opacity: m.opacity, alphaTest: m.alphaTest, fog: m.fog, dithering: true,
      });
    }
    if (!basic) {
      m.color.setRGB(0, 0, 0);
      m.emissive.copy(src);
      m.emissiveIntensity = 1.0;
      m.envMapIntensity = 0;
      m.needsUpdate = true;
      m.customProgramCacheKey = () => 'surround-unlit-fallback-' + m.name;
      usedFallback++;
      return;
    }
    basic.needsUpdate = true;
    basic.customProgramCacheKey = () => 'surround-unlit-' + m.name;
    o.material = basic;
    swapped.push(o.name || '(unnamed)');
  });
}
scene.traverse((o) => { const m = o.material; if (!m) return; (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; }); });
return { recipe: 'F4', swappedCount: swapped.length, usedFallback, skipped, foundGroup: !!grp, after: census() };
` },

];

// ---------------------------------------------------------------- harness
const SETUP = async () => {};

const scenario = `
  const g = window.__game;
  g.state.elements = ['fire','water','nature','earth','light','dark'];
  g.state.gold = 999999; g.hud.closeElementPicker && g.hud.closeElementPicker();
  const keys = ['fire','water','nature','earth','light','dark'];
  let n = 0;
  for (let r = 4; r < 14 && n < 21; r += 3)
    for (let c = 4; c < 22 && n < 21; c += 3)
      if (g.grid.canPlaceTower(c, r) && !g.path.wouldBlock(c, r)) { g.towers.create(keys[n%6], 0, c, r); n++; }
  g.path.rebuild(); g.arena.markPathDirty(); g.arena.refreshOccupancy();
  g.waves.start(21);
  return n;
`;

const browser = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });

// GPU sanity: a SwiftShader number is worthless.
{
  const p = await browser.newPage();
  const gpu = await p.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'NO WEBGL2';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  await p.close();
  console.log('GPU: ' + gpu);
  if (/swiftshader|software|llvmpipe/i.test(gpu)) {
    console.log('ABORT: software renderer, numbers would be worthless.');
    await browser.close();
    process.exit(1);
  }
}

async function run(recipe) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  await page.goto(`http://localhost:5273/?q=${PRESET}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 90000 });

  const towers = await page.evaluate(new Function(scenario));
  await page.waitForTimeout(8000);

  // PIN RESOLUTION. Part of the control, applied identically to baseline and
  // every recipe: AdaptiveResolution would otherwise eat the saving.
  const pinned = await page.evaluate(() => {
    const g = window.__game, p = g.pipeline, r = p.renderer;
    if (p.adaptive) { p.adaptive.enabled = false; r.setPixelRatio(p.adaptive.maxScale); }
    p.resize();
    const gl = r.getContext();
    return { pixelRatio: r.getPixelRatio(), buf: [gl.drawingBufferWidth, gl.drawingBufferHeight] };
  });

  let applied = null;
  if (recipe) {
    applied = await page.evaluate((src) => {
      const trim = (v, d) => {
        if (v === null || typeof v !== 'object') return v;
        if (d > 3) return '[deep]';
        if (Array.isArray(v)) return v.slice(0, 24).map((x) => trim(x, d + 1));
        const o = {};
        for (const k of Object.keys(v).slice(0, 24)) { try { o[k] = trim(v[k], d + 1); } catch (e) { o[k] = '[err]'; } }
        return o;
      };
      try {
        const r = new Function(src)();
        return { ok: true, ret: trim(r === undefined ? null : r, 0) };
      } catch (e) {
        return { ok: false, err: String((e && e.stack) || e).slice(0, 600) };
      }
    }, recipe.js);
  }

  let median = null, p95 = null, buf2 = null, extra = null;
  if (!applied || applied.ok) {
    await page.waitForTimeout(SETTLE_MS);
    const m = await page.evaluate((frames) => new Promise((res) => {
      let n = 0, t0 = performance.now(); const t = [];
      const tick = () => {
        const x = performance.now(); t.push(x - t0); t0 = x;
        if (++n < frames) requestAnimationFrame(tick);
        else {
          t.sort((a, c) => a - c);
          res({ median: +t[Math.floor(frames / 2)].toFixed(2), p95: +t[Math.floor(frames * 0.95)].toFixed(2) });
        }
      };
      requestAnimationFrame(tick);
    }), FRAMES);
    median = m.median; p95 = m.p95;
    const post = await page.evaluate(() => {
      const g = window.__game, r = g.pipeline.renderer, gl = r.getContext();
      return {
        buf: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        pixelRatio: r.getPixelRatio(),
        diet: window.__dietMiss !== undefined ? { miss: window.__dietMiss, fetches: window.__dietFetches } : undefined,
        shadowThrottle: g.__shadowThrottleStats ? g.__shadowThrottleStats() : undefined,
      };
    });
    buf2 = post.buf; extra = post;
  }

  await page.close();
  return { towers, pinned, applied, median, p95, buf2, extra, errors: errors.slice(0, 6) };
}

const out = [];
console.log(`preset ${PRESET}, 1600x900, 21 towers + wave 21, ${FRAMES} rAF intervals, resolution pinned\n`);

const base0 = await run(null);
console.log(`BASELINE(start): median ${base0.median} ms   p95 ${base0.p95} ms   buf ${base0.buf2.join('x')} pr ${base0.pinned.pixelRatio} towers ${base0.towers}`);
if (base0.errors.length) console.log('  errors: ' + JSON.stringify(base0.errors));

for (const rec of RECIPES) {
  if (ONLY && !(rec.label + rec.lever).toLowerCase().includes(ONLY.toLowerCase())) continue;
  const r = await run(rec);
  const rec2 = { lever: rec.lever, label: rec.label, ...r };
  out.push(rec2);
  if (r.applied && !r.applied.ok) {
    console.log(`${rec.label}\n   THREW: ${r.applied.err.split('\n')[0]}`);
  } else {
    const d = +(base0.median - r.median).toFixed(2);
    const st = r.median <= VSYNC ? 'hit-vsync' : (Math.abs(d) <= NOISE ? 'no-effect' : 'ok');
    console.log(`${rec.label}\n   median ${r.median} ms  p95 ${r.p95} ms  saved ${d >= 0 ? '+' : ''}${d} ms  [${st}]  buf ${r.buf2.join('x')}`);
    console.log('   ret: ' + JSON.stringify(r.applied && r.applied.ret).slice(0, 400));
    if (r.errors.length) console.log('   errors: ' + JSON.stringify(r.errors).slice(0, 400));
    if (r.extra && r.extra.diet) console.log('   diet: ' + JSON.stringify(r.extra.diet).slice(0, 200));
    if (r.extra && r.extra.shadowThrottle) console.log('   throttle: ' + JSON.stringify(r.extra.shadowThrottle));
  }
}

const base1 = await run(null);
console.log(`\nBASELINE(end):   median ${base1.median} ms   p95 ${base1.p95} ms`);
const drift = +(base1.median - base0.median).toFixed(2);
console.log(`baseline drift: ${drift} ms  ${Math.abs(drift) > 3 ? '*** > 3ms: RUN IS SUSPECT ***' : '(ok, <= 3ms)'}`);

fs.writeFileSync(new URL('./levers-out.json', import.meta.url), JSON.stringify({ preset: PRESET, base0, base1, out }, null, 1));
await browser.close();
