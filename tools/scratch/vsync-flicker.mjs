/**
 * Reproduces the periodic black board frames a player saw on a 100 Hz display
 * (screen recording 2026-10-04: board black for 1-4 frames every ~0.82 s).
 *
 * Headless rAF is not vsync-locked the way a real compositor is, so a plain
 * probe never sees the bug. This wraps requestAnimationFrame so the game gets
 * the timestamps a vsync'd display hands out: each frame advances a virtual
 * clock by a whole number of refresh intervals, enough to cover a synthetic GPU
 * cost proportional to the board's drawing-buffer area (the renderer is
 * fragment-bound, see AdaptiveResolution.js), plus jitter and the odd missed
 * vsync. Real wall time only paces the loop.
 *
 * Every frame in which the board rendered, the drawing buffer is read back
 * before the browser composites it. preserveDrawingBuffer is false, so what is
 * read is exactly what gets presented: a resize after the render leaves a
 * cleared (black) buffer, and this counts it.
 *
 *   node tools/scratch/vsync-flicker.mjs --port 5340 --hz 100 --q potato \
 *     [--cost 1.1] [--secs 60] [--w 1664] [--h 1390]
 *
 * --secs is VIRTUAL display time, so a starved headless run still covers the
 * same number of refreshes as a fast one.
 *
 * --cost is the full-resolution GPU cost in refresh intervals. 1.1 is a frame
 * that just misses vsync at full scale and just makes it 5% lower, which is the
 * user's situation. 3 is a genuinely slow machine.
 */
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5340));
const HZ = Number(arg('hz', 100));
const Q = arg('q', 'potato');
const COST = Number(arg('cost', 1.1));
const SECS = Number(arg('secs', 60));
const W = Number(arg('w', 1664));
const H = Number(arg('h', 1390));

const browser = await chromium.launch({ args: ['--use-angle=gl', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.route('**/@vite/client', (r) => r.fulfill({
  status: 200, contentType: 'application/javascript',
  body: 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;',
}));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.addInitScript(({ hz, cost }) => {
  const interval = 1000 / hz;
  const realRaf = window.requestAnimationFrame.bind(window);
  let queue = new Map();
  let nextId = 1;
  let scheduled = false;
  let vt = performance.now();
  let refArea = 0;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

  const rec = window.__vsync = {
    armed: false, vms: 0, frames: 0, rendered: 0, black: 0, resizedAfterRender: 0, blackAt: [], lum: [],
    scaleChanges: 0, govChanges: 0, sizeChanges: 0, ms: [], scales: [],
  };
  let lastScale, lastGov, lastSize;

  function luminance(gl, w, h) {
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const px = new Uint8Array(w * 4);
    gl.readPixels(0, h >> 1, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    let s = 0;
    for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return s / w;
  }

  function tick() {
    scheduled = false;
    const g = window.__game;
    const canvas = g?.pipeline?.renderer?.domElement;
    const area = canvas ? canvas.width * canvas.height : 0;
    if (!refArea && area > 1) refArea = area;
    const work = cost * interval * (refArea ? area / refArea : 1) + 0.04 * interval * gauss();
    let vsyncs = Math.max(1, Math.ceil(work / interval));
    if (rand() < 0.01) vsyncs++;
    vt += vsyncs * interval;

    let renders = 0;
    let resizedAfterRender = false;
    const p = g?.pipeline;
    if (p && !p.__wrapped) {
      p.__wrapped = true;
      const render = p.render.bind(p);
      p.render = (...a) => { p.__renders = (p.__renders ?? 0) + 1; p.__resizedAfter = false; return render(...a); };
      const resize = p.resize.bind(p);
      p.resize = (...a) => { p.__resizedAfter = true; return resize(...a); };
    }
    if (p) { p.__renders = 0; p.__resizedAfter = false; }

    const cbs = queue; queue = new Map();
    for (const cb of cbs.values()) cb(vt);

    if (!rec.armed || !p) return;
    renders = p.__renders;
    resizedAfterRender = renders > 0 && p.__resizedAfter;
    rec.frames++;
    rec.vms += vsyncs * interval;
    rec.ms.push(+(vsyncs * interval).toFixed(1));
    const a = p.adaptive;
    if (a && lastScale !== undefined && a.scale !== lastScale) rec.scaleChanges++;
    lastScale = a?.scale;
    rec.scales.push(a?.scale);
    const gov = window.__governor?.step;
    if (lastGov !== undefined && gov !== lastGov) rec.govChanges++;
    lastGov = gov;
    const size = `${canvas.width}x${canvas.height}`;
    if (lastSize !== undefined && size !== lastSize) rec.sizeChanges++;
    lastSize = size;
    if (renders === 0) return;
    rec.rendered++;
    const lum = luminance(p.renderer.getContext(), canvas.width, canvas.height);
    rec.lum.push(lum);
    if (resizedAfterRender) rec.resizedAfterRender++;
    if (lum < 2) { rec.black++; if (rec.blackAt.length < 40) rec.blackAt.push(rec.frames); }
  }

  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.set(id, cb);
    if (!scheduled) { scheduled = true; realRaf(tick); }
    return id;
  };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
}, { hz: HZ, cost: COST });

await page.goto(`http://localhost:${PORT}/?q=${Q}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game && !!window.__governor, null, { timeout: 120000 });

const res = await page.evaluate(async (secs) => {
  const g = window.__game;
  const pick = () => {
    if (g.state.pendingElementPicks > 0 || g.state.phase === 'pickElement') {
      g.state.pendingElementPicks = 1;
      try { g.chooseElement(['fire', 'water', 'earth', 'light', 'nature', 'dark'][Math.floor(Math.random() * 6)]); } catch {}
    }
  };
  const rec = window.__vsync;
  rec.armed = true;
  pick(); pick();
  g.state.paused = false;
  try { g.startWaveNow(); } catch {}
  while (rec.vms < secs * 1000) {
    pick();
    g.state.lives = Math.max(g.state.lives, 40);
    if (g.state.phase === 'prep') { try { g.startWaveNow(); } catch {} }
    await new Promise((r) => setTimeout(r, 250));
  }
  rec.armed = false;
  const ms = rec.ms.slice().sort((x, y) => x - y);
  const lum = rec.lum.slice().sort((x, y) => x - y);
  const hist = {};
  for (const m of rec.ms) hist[m] = (hist[m] ?? 0) + 1;
  const scales = [...new Set(rec.scales)];
  return {
    frames: rec.frames, virtualSecs: +(rec.vms / 1000).toFixed(1), rendered: rec.rendered, black: rec.black, resizedAfterRender: rec.resizedAfterRender, blackAt: rec.blackAt.slice(0, 12),
    scaleChanges: rec.scaleChanges, govChanges: rec.govChanges, sizeChanges: rec.sizeChanges,
    medianMs: ms[ms.length >> 1], frameMsHist: hist, lumMedian: +lum[lum.length >> 1]?.toFixed(1),
    scalesVisited: scales, finalScale: g.pipeline.adaptive?.scale, governorStep: window.__governor.step,
    wave: g.state.wave, phase: g.state.phase,
  };
}, SECS);

console.log(JSON.stringify({ hz: HZ, q: Q, cost: COST, ...res, errors: errors.slice(0, 3) }));
await browser.close();
