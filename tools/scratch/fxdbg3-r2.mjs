import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const HIDE = process.argv[2] || 'none';
const browser = await chromium.launch({ args:['--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport:{width:1920,height:1080} });
page.on('pageerror', e=>console.log('ERR',e.message));
await page.route('**/@vite/client', r=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await page.goto('http://localhost:5273/?q=ultra',{waitUntil:'load'});
await page.waitForFunction(()=>!!window.__game,null,{timeout:30000});
await page.evaluate(async (hide)=>{
  const g=window.__game; const wait=ms=>new Promise(r=>setTimeout(r,ms));
  let seed=1337; Math.random=()=>{seed=(seed*1664525+1013904223)%4294967296; return seed/4294967296;};
  g.state.elements=['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks=0; g.state.gold=999999; g.hud.closeElementPicker(); g.hud.refreshBuildBar();
  const MAZE=[['fire',10,3],['fire',14,3],['water',8,5],['nature',12,5],['earth',16,5],['light',6,7],['dark',10,7],['steam',14,7],['ice',18,7],['magma',8,9],['poison',12,9],['crystal',16,9],['blaze',6,11],['void',10,11],['magic',14,11],['life',18,11],['water',8,13],['nature',12,13],['earth',16,13],['light',10,15],['dark',14,15]];
  for(const [k,c,r] of MAZE) g.build(k,c,r);
  if(hide==='muzzle') g.fx.muzzleFlash=()=>{};
  if(hide==='glowdecal') g.fx.decals.glow.mesh.visible=false;
  if(hide==='markdecal') g.fx.decals.mark.mesh.visible=false;
  if(hide==='bb') g.projectiles.renderer.billboards.visible=false;
  if(hide==='pts'){ g.fx.energy.points.visible=false; g.fx.matter.points.visible=false; }
  if(hide==='muzrib') g.fx.muzzleRibbons.mesh.visible=false;
  if(hide==='allfx'){ g.fx.muzzleRibbons.mesh.visible=false; g.fx.arcs.mesh.visible=false; g.fx.energy.points.visible=false; g.fx.matter.points.visible=false; g.projectiles.ribbons.mesh.visible=false; g.projectiles.renderer.billboards.visible=false; g.projectiles.renderer.rocks.visible=false; g.fx.decals.glow.mesh.visible=false; g.fx.decals.mark.mesh.visible=false; }
  g.state.phase='combat'; g.waves.start(18);
  await wait(3200);
  const t=g.towers.towers[10]; g.rig.focus(t.x,t.z,22); g.rig._polarGoal=0.95;
  await wait(2500);
},HIDE);
await page.waitForTimeout(400);
writeFileSync(`/Users/pouetpouets/code/element-td-3d/shots/dbgm-${HIDE}.png`, await page.screenshot({type:'png'}));
await browser.close();
console.log('ok',HIDE);
