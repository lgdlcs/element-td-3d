import { chromium } from 'playwright';
const HMR='export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b=await chromium.launch({args:['--use-angle=metal','--mute-audio']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('PAGEERROR',e.message));
await p.route('**/@vite/client',r=>r.fulfill({status:200,contentType:'application/javascript',body:HMR}));
await p.goto('http://localhost:5273/?q=low&mp',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__scoreboard,null,{timeout:90000});

const SIX=[...Array(6)].map((_,i)=>({id:'p'+(i+1),name:'Player'+(i+1),lives:20-i,score:5000-i*700,wave:12,finished:false,won:false}));

async function feed(){ await p.evaluate((L)=>{ const sb=window.__scoreboard; sb.show(); sb.update(L,'p1'); },SIX); }

// how tall is the rail right now / can we grow it?
const railInfo = await p.evaluate(()=>{
  const r=document.querySelector('#threat');
  return r? {found:true, html:r.innerHTML.length, h:r.offsetHeight, top:r.offsetTop, op:getComputedStyle(r).opacity}:{found:false};
});
console.log('rail', JSON.stringify(railInfo));

const sizes=[[1600,900],[1280,800],[1100,700],[1024,640]];
for(const [w,h] of sizes){
  await p.setViewportSize({width:w,height:h});
  await feed();
  await p.waitForTimeout(700);
  const m=await p.evaluate(()=>{
    const s=document.querySelector('#scoreboard'), t=document.querySelector('#threat');
    const A=s.getBoundingClientRect(), B=t.getBoundingClientRect();
    const ox=Math.max(0,Math.min(A.right,B.right)-Math.max(A.left,B.left));
    const oy=Math.max(0,Math.min(A.bottom,B.bottom)-Math.max(A.top,B.top));
    const cs=getComputedStyle(s);
    const list=document.querySelector('#sb-list');
    return {sb:[Math.round(A.left),Math.round(A.top),Math.round(A.right),Math.round(A.bottom)],
      threat:[Math.round(B.left),Math.round(B.top),Math.round(B.right),Math.round(B.bottom)],
      overlapArea:Math.round(ox*oy), overlapY:Math.round(oy), overlapX:Math.round(ox),
      visible:cs.visibility+'/'+cs.opacity, crowded:s.classList.contains('crowded'),
      on:s.classList.contains('on'), pe:cs.pointerEvents,
      rows:list.children.length, clipped: list.scrollHeight>list.clientHeight+1,
      railOp:getComputedStyle(t).opacity};
  });
  console.log(`${w}x${h}`, JSON.stringify(m));
}

// DOM order check: does the <ol> read in rank order?
await p.setViewportSize({width:1600,height:900});
await p.evaluate(()=>{const sb=window.__scoreboard;sb.show();sb.update([
 {id:'p1',name:'A',lives:5,score:100,wave:3},{id:'p2',name:'B',lives:5,score:900,wave:3},{id:'p3',name:'C',lives:5,score:500,wave:3}],'p1');});
await p.waitForTimeout(100);
console.log('order-before', JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#sb-list li')].map((l,i)=>l.dataset.id+'@'+i+'/order='+(l.style.order||'')))));
// tag nodes then reverse ranking; nodes must be MOVED not rebuilt
await p.evaluate(()=>{[...document.querySelectorAll('#sb-list li')].forEach((l,i)=>l.__mark='m'+i);});
await p.evaluate(()=>{window.__scoreboard.update([
 {id:'p1',name:'A',lives:5,score:9000,wave:3},{id:'p2',name:'B',lives:5,score:100,wave:3},{id:'p3',name:'C',lives:5,score:400,wave:3}],'p1');});
await p.waitForTimeout(100);
console.log('order-after', JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#sb-list li')].map(l=>l.dataset.id+':'+(l.__mark??'REBUILT')))));

// mixed isOut
console.log('mixed', JSON.stringify(await p.evaluate(()=>{
  window.__scoreboard.update([
    {id:'a',name:'live',lives:10,score:500,wave:5,finished:false},
    {id:'b',name:'dead',lives:0,score:300,wave:7,finished:false},
    {id:'c',name:'silent',lives:0,score:0,wave:0,finished:false},
    {id:'d',name:'fin',lives:0,score:900,wave:0,finished:true},
  ],'a');
  return [...document.querySelectorAll('#sb-list li')].map(l=>({n:l.querySelector('.sb-name').textContent,out:l.classList.contains('out'),wait:l.classList.contains('waiting'),lead:l.classList.contains('lead'),lives:l.querySelector('.sb-lives').textContent,wave:l.querySelector('.sb-wave').textContent}));
})));

// showFinal with ONE standing (fresh page needed since _final latches)
const p2=await b.newPage({viewport:{width:1600,height:900}});
p2.on('pageerror',e=>console.log('PAGEERROR2',e.message));
await p2.route('**/@vite/client',r=>r.fulfill({status:200,contentType:'application/javascript',body:HMR}));
await p2.goto('http://localhost:5273/?q=low&mp',{waitUntil:'load'});
await p2.waitForFunction(()=>!!window.__scoreboard,null,{timeout:90000});
console.log('final-1', JSON.stringify(await p2.evaluate(()=>{
  const sb=window.__scoreboard;
  sb.showFinal([{id:'x',name:'Solo',lives:0,score:4200,wave:30,finished:true,won:true}],'x');
  const el=document.querySelector('#scoreboard');
  const r={on:el.classList.contains('on'),final:el.classList.contains('is-final'),rows:document.querySelectorAll('#sb-list li').length,n:document.querySelector('#sb-n').textContent,title:document.querySelector('#sb-title').textContent,score:document.querySelector('.sb-score')?.textContent,lives:document.querySelector('.sb-lives')?.textContent};
  sb.update([{id:'x',name:'Solo',lives:1,score:1,wave:1}],'x');
  r.afterLateScores=document.querySelector('.sb-score')?.textContent;
  return r;
})));

// reduced motion
const p3=await b.newPage({viewport:{width:1600,height:900},reducedMotion:'reduce'});
await p3.route('**/@vite/client',r=>r.fulfill({status:200,contentType:'application/javascript',body:HMR}));
await p3.goto('http://localhost:5273/?q=low&mp',{waitUntil:'load'});
await p3.waitForFunction(()=>!!window.__scoreboard,null,{timeout:90000});
console.log('rm', JSON.stringify(await p3.evaluate(()=>{
  const el=document.querySelector('#scoreboard');
  const sb=window.__scoreboard; sb.show();
  sb.update([{id:'a',name:'A',lives:5,score:5,wave:2},{id:'b',name:'B',lives:5,score:2,wave:2}],'a');
  const g=(cls)=>{el.className=cls;return {t:getComputedStyle(el).transform,d:getComputedStyle(el).transitionDuration};};
  const off=g(''),on=g('on'),cr=g('on crowded');
  document.body.classList.add('codex-open');
  const cx=g('on');
  document.body.classList.remove('codex-open');
  return {off,on,cr,cx,bar:getComputedStyle(document.querySelector('.sb-bar > s')).transitionDuration};
})));
await b.close();
