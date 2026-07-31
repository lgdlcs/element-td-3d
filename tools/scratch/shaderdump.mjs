import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('console', m => { const t = m.text(); if (/ERROR|GLSL|WebGLProgram/i.test(t)) console.log('[GL]', t.slice(0, 600)); });
await p.route('**/@vite/client', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => { const g = window.__game;
  g.state.elements=['fire']; g.state.gold=999999; g.hud.closeElementPicker?.();
  g.towers.create('fire',0,8,8); });
await p.waitForTimeout(2500);
console.log(await p.evaluate(() => {
  const g = window.__game;
  let m = null;
  g.scene.traverse(o => { if (o.name === 'towerBatch') m = o.material; });
  const sh = (Array.isArray(m)?m[0]:m)?.userData?.shader;
  if (!sh) return 'NO SHADER CAPTURED';
  const f = sh.fragmentShader;
  return [
    'tdetail4 present : ' + f.includes('tdetail4'),
    'sampler3D present: ' + f.includes('sampler3D'),
    'old thash present: ' + f.includes('float thash('),
    'authoredH calls  : ' + (f.match(/authoredH\(/g) || []).length,
    'atan calls       : ' + (f.match(/atan\(/g) || []).length,
    'bhash calls      : ' + (f.match(/bhash\(/g) || []).length,
    'uNoiseVol bound  : ' + !!sh.uniforms.uNoiseVol?.value,
  ].join('\n');
}));
await b.close();
