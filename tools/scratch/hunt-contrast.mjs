// Usage: node tools/scratch/hunt-contrast.mjs <port>. How much the runners stand out from
// what is behind them, per mood: every few frames the scene is drawn twice off screen,
// runners shown and hidden, and the pixels the runners cover are compared (sRGB-ish
// luma, 0-1). `pop` is the mean luma difference on those pixels, `px` their mean count.
// `popNoRim` is the same frames drawn with the view's rim uniform zeroed: a paired
// comparison, so where the runners happened to be cannot move it.
import { chromium } from 'playwright';
const [port = '5299'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=gl', '--enable-gpu', '--mute-audio'] });
const out = {};
for (const occ of [0, 1]) {
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await p.goto(`http://localhost:${port}/rites.html?rite=hunt&wave=12&seed=4242&occ=${occ}&q=high`);
  await p.waitForFunction(() => window.__sandbox?.host?.ownsFrame, null, { timeout: 60000 });
  await p.waitForTimeout(400);
  await p.keyboard.press('Space');
  await p.waitForFunction(() => window.__sandbox.host.mode === 'play');
  out[occ ? 'night' : 'dusk'] = await p.evaluate(async () => {
    const h = window.__sandbox.host, v = h._view, R = h._stage.renderer;
    const W = 640, H = 360;
    // The page's own three, as Vite served it, so the target belongs to the same build.
    const url = performance.getEntriesByType('resource').map((e) => e.name).find((u) => /\/deps\/three\.js/.test(u));
    const rt = new (await import(url)).WebGLRenderTarget(W, H);
    const a = new Uint8Array(W * H * 4), c = new Uint8Array(W * H * 4);
    const luma = (u, i) => (0.2126 * u[i] + 0.7152 * u[i + 1] + 0.0722 * u[i + 2]) / 255;
    const nr = new Uint8Array(W * H * 4);
    let sum = 0, sumNr = 0, n = 0, samples = 0, pxTotal = 0;
    for (let f = 0; f < 240 && h.mode === 'play'; f++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (f % 8) continue;
      const roots = v.items.map((it) => it.root).filter((r) => r.visible);
      if (!roots.length) continue;
      const cast = [];
      for (const r of roots) r.traverse((o) => { if (o.isMesh) { cast.push([o, o.castShadow]); o.castShadow = false; } });
      R.setRenderTarget(rt); R.render(v.scene, v.camera); R.readRenderTargetPixels(rt, 0, 0, W, H, a);
      const keep = v.rim?.value.clone();
      if (keep) { v.rim.value.setRGB(0, 0, 0); R.render(v.scene, v.camera); R.readRenderTargetPixels(rt, 0, 0, W, H, nr); v.rim.value.copy(keep); }
      for (const r of roots) r.visible = false;
      R.render(v.scene, v.camera); R.readRenderTargetPixels(rt, 0, 0, W, H, c);
      for (const r of roots) r.visible = true;
      for (const [o, s] of cast) o.castShadow = s;
      R.setRenderTarget(null);
      let px = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.abs(Math.pow(luma(a, i), 1 / 2.2) - Math.pow(luma(c, i), 1 / 2.2));
        if (a[i] !== c[i] || a[i + 1] !== c[i + 1] || a[i + 2] !== c[i + 2]) {
          sum += d; n++; px++;
          sumNr += Math.abs(Math.pow(luma(keep ? nr : a, i), 1 / 2.2) - Math.pow(luma(c, i), 1 / 2.2));
        }
      }
      pxTotal += px; samples++;
    }
    rt.dispose();
    return { pop: +(sum / Math.max(1, n)).toFixed(3), popNoRim: +(sumNr / Math.max(1, n)).toFixed(3), px: Math.round(pxTotal / Math.max(1, samples)), samples };
  });
  await p.close();
}
console.log(JSON.stringify(out));
await b.close();
