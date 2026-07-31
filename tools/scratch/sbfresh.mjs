/**
 * Does a freshly-joined roster read as ELIMINATED?
 *
 * The reviewer's claim: `isOut = p.finished || p.lives <= 0` fires for every
 * player the server has seeded with `lives: 0`, i.e. everyone who has not yet
 * sent a `status`. That is the first second of every multiplayer run, and
 * mplive.mjs missed it because it only looked after scores had flowed.
 *
 * Reproduced against the real server's actual roster shape, not a hand-made one.
 */
import { chromium } from 'playwright';
const HMR='export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b=await chromium.launch({args:['--use-angle=metal','--mute-audio']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.route('**/@vite/client',r=>r.fulfill({status:200,contentType:'application/javascript',body:HMR}));
await p.goto('http://localhost:5273/?q=low&mp',{waitUntil:'load'});
await p.waitForFunction(()=>!!window.__scoreboard,null,{timeout:90000});

// Exactly what server/rooms.js roster() emits for players who have not reported:
// lives 0, wave 0, finished false. Taken verbatim from the lobbybcast.mjs capture.
const r=await p.evaluate(()=>{
  const sb=window.__scoreboard;
  sb.show();
  sb.update([
    {id:'p1',name:'Ada',host:true,ready:false,lives:0,score:0,wave:0,killed:0,leaked:0,towers:0,finished:false,won:false},
    {id:'p2',name:'Grace',host:false,ready:false,lives:0,score:0,wave:0,killed:0,leaked:0,towers:0,finished:false,won:false},
  ],'p1');
  const rows=[...document.querySelectorAll('#scoreboard li.sb-row')];
  return rows.map(x=>({
    name:x.querySelector('.sb-name')?.textContent,
    out:x.classList.contains('out'),
    lives:x.querySelector('.sb-lives')?.textContent,
    wave:x.querySelector('.sb-wave')?.textContent,
  }));
});
console.log(JSON.stringify(r,null,1));
const bad=r.filter(x=>x.out).length;
console.log(bad>0
  ? `CONFIRMED: ${bad}/${r.length} players read as eliminated before sending a single status.`
  : 'NOT REPRODUCED: fresh players do not read as eliminated.');
const fabricated=r.filter(x=>x.wave==='W1').length;
console.log(fabricated>0 ? `ALSO CONFIRMED: ${fabricated} rows display "W1" for a relayed wave of 0.` : 'wave display ok');
await b.close();
