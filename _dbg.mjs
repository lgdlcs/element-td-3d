import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const b = await chromium.launch({ args: ['--use-angle=metal','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs=[]; p.on('pageerror', e=>errs.push(e.message));
const t0=Date.now();
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(()=>!!window.__game, null, {timeout:30000});
const boot = Date.now()-t0;
const info = await p.evaluate(async ()=>{
  const g = window.__game;
  g.state.elements=['fire','water','nature','earth','light','dark']; g.state.gold=999999;
  g.hud.closeElementPicker(); g.state.phase='prep'; g.hud.refreshBuildBar();
  const MAZE=[['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  const t=performance.now(); for (const [k,c,r] of MAZE) g.build(k,c,r);
  const buildMs = performance.now()-t;
  const t2=performance.now(); g.arena.mask.rebuild(); const maskMs = performance.now()-t2;
  await new Promise(r=>setTimeout(r,1500));
  return { parts: window.__terrainForgeParts, forge: window.__terrainForgeMs, buildMs, maskMs,
           arenaDraws: (()=>{ let n=0; g.arena.group.traverse(o=>{ if((o.isMesh||o.isPoints)&&o.visible) n++; }); return n; })() };
});
console.log(JSON.stringify({...info, bootMs: boot}));
const variants = { A_base:{}, G_isolated:{_iso:1}, R_grey:{_iso:1,uDebug:8}, S_greyNoShadow:{_iso:1,uDebug:8,_ns:1}, T_greyNoAO:{_iso:1,uDebug:8,_nossao:1} };
for (const [name, u] of Object.entries(variants)) {
  await p.evaluate((u)=>{ const g=window.__game;
    if (u._iso) { g.scene.traverse(o=>{ if(o.isMesh||o.isPoints||o.isSprite||o.isLine) o.visible=false; }); g.arena.group.traverse(o=>{o.visible=true;}); }
    const un = g.arena.uniforms; un.uDebug.value = 0;
    g.arena.ground.receiveShadow = !u._ns; g.arena.ground.material.needsUpdate = true;
    if (u._nossao && g.pipeline.ssaoPass) g.pipeline.ssaoPass.enabled = false;
    if (u._nossao && g.pipeline.gtao) g.pipeline.gtao.enabled = false;
    window.__pipeKeys = Object.keys(g.pipeline);
    for (const k in u) if (un[k]) un[k].value = u[k];
    if (false) {
      const T = window.THREE || g.arena.ground.material.constructor.__proto__ ;
      const m = new (g.arena.ground.material.constructor)({ color: 0x808080, roughness: 0.7, metalness: 0 });
      const geo = new (g.arena.ground.geometry.constructor)();
      const pl = g.arena.ground.clone();
      pl.material = m; pl.customDepthMaterial = null; pl.position.y = 1.2;
      g.scene.add(pl); window.__ref = pl;
    }
  }, u);
  await p.waitForTimeout(700);
  writeFileSync(`/tmp/v_${name}.png`, await p.screenshot({type:'png'}));
}
console.log('pipe', await p.evaluate(()=>window.__pipeKeys));
console.log('errors', errs.slice(0,3));
await b.close();
