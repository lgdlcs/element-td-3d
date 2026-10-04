import { test, expect } from '@playwright/test';
import { bootGame } from './fixtures.js';

/**
 * A resolution step must never be presented as a black board.
 *
 * Changing the pixel ratio resizes the canvas, and resizing a canvas clears its
 * drawing buffer. If the step lands after the frame's render, the browser
 * presents that cleared buffer: the periodic black frames of the 2026-10-04
 * screen recording. main.js runs the controller before game.frame() so the
 * render always follows the resize.
 *
 * requestAnimationFrame is replaced so every frame lasts 25 ms of page time,
 * which drives the controller down one step every 48 frames. After the frame
 * callbacks run, and before the browser composites, the default framebuffer is
 * read back. preserveDrawingBuffer is false, so that read is what gets shown.
 */
test('resolution steps never present a black board', async ({ page }) => {
  await page.addInitScript(() => {
    const realRaf = window.requestAnimationFrame.bind(window);
    let queue = new Map();
    let nextId = 1;
    let scheduled = false;
    let now = performance.now();
    const rec = window.__presented = { armed: false, rendered: 0, black: 0, steps: 0 };
    let lastScale;

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
      now += rec.armed ? 25 : 1000 / 60;
      const p = window.__game?.pipeline;
      if (p && !p.__counted) {
        p.__counted = true;
        const render = p.render.bind(p);
        p.render = (...a) => { p.__renders++; return render(...a); };
      }
      if (p) p.__renders = 0;

      const cbs = queue;
      queue = new Map();
      for (const cb of cbs.values()) cb(now);

      if (!rec.armed || !p?.__renders) return;
      const scale = p.adaptive.scale;
      if (lastScale !== undefined && scale !== lastScale) rec.steps++;
      lastScale = scale;
      rec.rendered++;
      const canvas = p.renderer.domElement;
      if (luminance(p.renderer.getContext(), canvas.width, canvas.height) < 2) rec.black++;
    }

    window.requestAnimationFrame = (cb) => {
      const id = nextId++;
      queue.set(id, cb);
      if (!scheduled) { scheduled = true; realRaf(tick); }
      return id;
    };
    window.cancelAnimationFrame = (id) => { queue.delete(id); };
  });

  const { errors } = await bootGame(page, { quality: 'potato' });
  const start = await page.evaluate(() => {
    window.__presented.armed = true;
    return window.__game.pipeline.adaptive.scale;
  });

  await page.waitForFunction(() => window.__presented.steps >= 3, null, { timeout: 60_000 });
  const rec = await page.evaluate(() => ({ ...window.__presented, scale: window.__game.pipeline.adaptive.scale }));

  expect(rec.scale).toBeLessThan(start);
  expect(rec.rendered).toBeGreaterThan(100);
  expect(rec.black).toBe(0);
  expect(errors).toEqual([]);
});
