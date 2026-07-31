import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-angle=metal','--enable-unsafe-swiftshader']});
const p = await b.newPage({viewport:{width:900,height:600}});
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.route('**/@vite/client', r=>r.fulfill({status:200,contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=u=>u;'}));
await p.goto('http://localhost:5273/?q=low',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__game,null,{timeout:90000});
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const g=window.__game, wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let n=0;n<120&&document.getElementById('boot');n++) await wait(150);
  await wait(300);
  g.state.elements=['fire','water','nature','earth','light','dark'];
  g.state.pendingElementPicks=0; g.hud.closeElementPicker(); g.state.phase='combat';
  const c=g.creeps, P=g.projectiles;
  const out={};
  const place=(n,x0,z0,gap)=>{const ids=[];for(let k=0;k<n;k++){const i=c.spawn('normal',100000,6,0);if(i<0)continue;ids.push(i);
    c.x[i]=x0+k*gap;c.z[i]=z0;c.vx[i]=1e-4;c.vz[i]=1e-4;c.speed[i]=0;c.baseSpeed[i]=0;c.spawnT[i]=1;c.hp[i]=100000;c.maxHp[i]=100000;}
    return ids;};
  const hit=(stats, ids, tx, tz)=>{
    const before=ids.map(i=>c.hp[i]);
    let dealtTotal=0; P.onDamage=(tid,amt)=>{dealtTotal+=amt;};
    const j=P.spawn({x:tx,y:4,z:tz,tx,ty:c.y[ids[0]]+0.6,tz,target:ids[0],speed:8,color:0xff5a1f,accent:0xffd166,towerId:7,stats,arc:0});
    return {j, before, get after(){return ids.map(i=>c.hp[i]);}, get dealt(){return dealtTotal;}};
  };
  // --- direct + splash falloff
  {
    const ids=place(4,-14,-12,1.2);
    const h=hit({damage:1000, splash:{radius:5, falloff:0.8}}, ids, c.x[ids[0]], c.z[ids[0]]);
    await wait(900);
    out.splash={damageEach:h.before.map((b,k)=>Math.round(b-c.hp[ids[k]])), onDamageTotal:Math.round(h.dealt)};
  }
  // --- chain
  {
    const ids=place(4,-4,-12,3.0);
    const h=hit({damage:1000, chain:{count:3, falloff:0.6}}, ids, c.x[ids[0]], c.z[ids[0]]);
    out.chainDbg={ids, j:h.j, alive:ids.map(i=>c.alive[i]), pos:ids.map(i=>[+c.x[i].toFixed(1),+c.y[i].toFixed(1),+c.z[i].toFixed(1)])};
    await wait(900);
    out.chain={damageEach:ids.map((i,k)=>Math.round(h.before[k]-c.hp[i])), aliveAfter:ids.map(i=>c.alive[i]), hpAfter:ids.map(i=>Math.round(c.hp[i]))};
  }
  // --- statuses
  {
    const ids=place(1,10,-12,1);
    const i=ids[0];
    hit({damage:10, slow:{amt:0.5,dur:5}, burn:{dps:50,dur:5}, poison:{dps:40,dur:5}}, ids, c.x[i], c.z[i]);
    await wait(900);
    out.status={slowT:+c.slowT[i].toFixed(2), burnT:+c.burnT[i].toFixed(2), poisonT:+c.poisonT[i].toFixed(2)};
  }
  // --- execute scaling: full-hp vs 20%-hp target
  {
    const a=place(1,-14,4,1)[0], bb=place(1,-8,4,1)[0];
    c.hp[bb]=c.maxHp[bb]*0.2;
    const ha=hit({damage:1000, execute:0.5},[a],c.x[a],c.z[a]);
    const hb=hit({damage:1000, execute:0.5},[bb],c.x[bb],c.z[bb]);
    await wait(900);
    out.execute={fullHp:Math.round(ha.before[0]-c.hp[a]), lowHp:Math.round(hb.before[0]-c.hp[bb])};
  }
  return out;
}),null,1));
await b.close();
