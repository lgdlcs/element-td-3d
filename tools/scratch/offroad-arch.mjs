// Usage: node tools/scratch/offroad-arch.mjs <port>. Prints the closest the camera came to a visible arch post.
// Holds Left so the car rides the rope, and records, every frame, how close the
// chase camera gets to a VISIBLE arch post (in the post's own plane).
import { chromium } from 'playwright';
const [port = '5299'] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=gl', '--enable-gpu'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto(`http://localhost:${port}/rites.html?rite=offroad&wave=12&seed=4242&q=high`);
await p.waitForFunction(() => window.__sandbox?.host?.isOpen && !window.__sandbox.host._viewPending, null, { timeout: 60000 });
await p.waitForTimeout(500);
await p.keyboard.press('Space');
await p.waitForFunction(() => window.__sandbox.host.mode === 'play');
await p.keyboard.down('ArrowLeft');
const res = await p.evaluate(() => new Promise((done) => {
  const v = window.__sandbox.host._view;
  let worst = Infinity, at = null;
  const tick = () => {
    const cam = v.camera.position;
    v.scene.traverse((o) => {
      if (!o.isMesh || o.geometry?.type !== 'BoxGeometry' || o.geometry.parameters.height !== 3.2) return;
      let vis = true; for (let q = o; q; q = q.parent) vis &&= q.visible;
      if (!vis) return;
      const w = o.getWorldPosition(o.position.clone());
      const d = Math.hypot(cam.x - w.x, cam.z - w.z);
      if (d < worst) { worst = d; at = { s: window.__sandbox.host.instance.s }; }
    });
    if (window.__sandbox.host.instance.s < 14) requestAnimationFrame(tick); else done({ worst, at });
  };
  tick();
}));
console.log(JSON.stringify(res));
await b.close();
