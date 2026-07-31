/**
 * Round 7. WHERE does the board's value come from, on TODAY's build?
 *
 * Round 3 measured "87% of the plate is the key's dielectric specular lobe" and
 * every subsequent round quoted that number. The relight of round 6 moved the
 * key, the ambient and the whole post chain, so that split is a rumour now.
 * Re-measure it, then sweep the levers that reach whichever term wins.
 *
 * Board pixels only: towers/creeps/fx hidden, sampled inside the play field.
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => {
  const g = window.__game;
  g.hud.closeElementPicker?.();
  g.towers.group.visible = false;
  g.creeps.group.visible = false;
  g.fx.group.visible = false;
});
await p.waitForTimeout(1500);

// Mean luminance over a centred crop that is board and only board.
const boardL = async () => {
  const buf = await p.screenshot({ type: 'png', timeout: 120000 });
  return p.evaluate(async (d) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + d; await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
    // Centre crop: entirely inside the slab at default framing.
    const x0 = Math.round(cv.width * 0.36), y0 = Math.round(cv.height * 0.36);
    const w = Math.round(cv.width * 0.28), h = Math.round(cv.height * 0.26);
    const px = cx.getImageData(x0, y0, w, h).data;
    let s = 0, n = 0, sd = 0;
    const L = [];
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      L.push(l); s += l; n++;
    }
    const m = s / n;
    for (const l of L) sd += (l - m) * (l - m);
    return { mean: +m.toFixed(1), sd: +Math.sqrt(sd / n).toFixed(1) };
  }, buf.toString('base64'));
};

const setDbg = async (v) => {
  await p.evaluate((v) => { window.__game.arena.uniforms.uDebug.value = v; }, v);
  await p.waitForTimeout(350);
};

console.log('--- lighting term split (board crop, uDebug probes) ---');
for (const [name, v] of [['directDiffuse', 20], ['directSpecular', 21],
                         ['indirectDiffuse', 22], ['indirectSpecular', 23],
                         ['emissive', 24]]) {
  await setDbg(v);
  console.log(name.padEnd(18), JSON.stringify(await boardL()));
}
await setDbg(0);
const base = await boardL();
console.log('composited      ', JSON.stringify(base));

console.log('\n--- lever sweep (board crop mean / sd) ---');
const sweep = async (label, apply, restore, arg) => {
  await p.evaluate(apply, arg);
  await p.waitForTimeout(350);
  const r = await boardL();
  console.log(label.padEnd(34), JSON.stringify(r),
    ' d=' + (r.mean - base.mean).toFixed(1));
  await p.evaluate(restore);
  await p.waitForTimeout(200);
};

for (const k of [0.75, 0.55, 0.40, 0.25]) {
  await sweep(`uSpecTint x${k}`,
    (k) => { const u = window.__game.arena.uniforms.uSpecTint.value;
             if (!window.__st) window.__st = u.clone(); u.copy(window.__st).multiplyScalar(k); },
    () => { window.__game.arena.uniforms.uSpecTint.value.copy(window.__st); }, k);
}
for (const k of [0.20, 0.12, 0.06, 0.0]) {
  await sweep(`uSpecF90 ${k}`,
    (k) => { const u = window.__game.arena.uniforms.uSpecF90;
             if (window.__f90 === undefined) window.__f90 = u.value; u.value = k; },
    () => { window.__game.arena.uniforms.uSpecF90.value = window.__f90; }, k);
}
for (const k of [0.70, 0.55, 0.42, 0.30]) {
  await sweep(`uAlbedoGain ${k}`,
    (k) => { const u = window.__game.arena.uniforms.uAlbedoGain;
             if (window.__ag === undefined) window.__ag = u.value; u.value = k; },
    () => { window.__game.arena.uniforms.uAlbedoGain.value = window.__ag; }, k);
}
await sweep('uAlbedoGain 0 (albedo ablation)',
  () => { const u = window.__game.arena.uniforms.uAlbedoGain;
          if (window.__ag === undefined) window.__ag = u.value; u.value = 0; },
  () => { window.__game.arena.uniforms.uAlbedoGain.value = window.__ag; });

await b.close();
