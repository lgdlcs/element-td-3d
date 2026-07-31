import { chromium } from 'playwright';
for (const args of [
  ['--use-angle=metal','--enable-unsafe-swiftshader','--mute-audio'],
  ['--use-angle=metal','--mute-audio'],
]) {
  const b = await chromium.launch({ args });
  const p = await b.newPage();
  const r = await p.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'NO WEBGL2';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log(JSON.stringify(args), '->', r);
  await b.close();
}
