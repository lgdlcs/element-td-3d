// Usage: node tools/scratch/offroad-posts.mjs <port>. For each steering style (none, held
// Left, held Right), the widest share of the frame any VISIBLE gate or arch post covered,
// weighted by its opacity (a post at half opacity counts half).
import { chromium } from 'playwright';
const [port = '5299'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=gl', '--enable-gpu'] });
const out = {};
for (const hold of ['none', 'ArrowLeft', 'ArrowRight']) {
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await p.goto(`http://localhost:${port}/rites.html?rite=offroad&wave=12&seed=4242&q=high`);
  await p.waitForFunction(() => window.__sandbox?.host?.isOpen && !window.__sandbox.host._viewPending, null, { timeout: 60000 });
  await p.waitForTimeout(500);
  await p.keyboard.press('Space');
  await p.waitForFunction(() => window.__sandbox.host.mode === 'play');
  if (hold !== 'none') await p.keyboard.down(hold);
  out[hold] = await p.evaluate(() => new Promise((done) => {
    const v = window.__sandbox.host._view;
    const cam = v.camera;
    let worst = 0, at = null;
    const tick = () => {
      cam.updateMatrixWorld();
      const tanH = Math.tan((cam.fov * Math.PI) / 360) * cam.aspect;
      v.scene.traverse((o) => {
        const g = o.geometry;
        const post = o.isMesh && ((g?.type === 'BoxGeometry' && g.parameters.height === 3.2)
          || (g?.type === 'CylinderGeometry' && g.parameters.height === 2.75));
        if (!post) return;
        let vis = true; for (let q = o; q; q = q.parent) vis &&= q.visible;
        if (!vis) return;
        const w = o.getWorldPosition(o.position.clone()).applyMatrix4(cam.matrixWorldInverse);
        w.y += 1.4;
        const z = -w.z;
        if (z <= 0.05) return;
        const r = g.type === 'BoxGeometry' ? 0.11 : 0.08;
        if (Math.abs(w.x) - r > z * tanH) return;
        const frac = (r / (z * tanH)) * (o.material.opacity ?? 1);
        if (frac > worst) worst = frac, at = { s: +window.__sandbox.host.instance.s.toFixed(2), z: +z.toFixed(2), kind: g.type };
      });
      if (window.__sandbox.host.mode === 'play') requestAnimationFrame(tick); else done({ worstPct: +(100 * worst).toFixed(2), at });
    };
    tick();
  }));
  await p.close();
}
console.log(JSON.stringify(out));
await b.close();
