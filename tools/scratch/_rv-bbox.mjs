import { chromium } from 'playwright';
const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';
const b = await chromium.launch({ args: ['--use-angle=metal', '--mute-audio'] });
const errs = [];
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
await p.goto('http://localhost:5273/?q=low&mp', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__lobby, null, { timeout: 120000 });
await p.waitForTimeout(2000);

// host-with-no-name blocker sentence, seen as a NON-host
console.log('startBlocker as non-host, host name missing :: ' + await p.evaluate(() => {
  const l = window.__lobby; l.setState('lobby'); l.setConnection('online');
  l.setPlayers([{ id: 'h', host: true }, { id: 'me', name: 'Bo' }], 'me');
  return JSON.stringify(document.querySelector('#lobby-start-note').textContent.trim());
}));
console.log('startBlocker host name object :: ' + await p.evaluate(() => {
  window.__lobby.setPlayers([{ id: 'h', host: true, name: {} }, { id: 'me', name: 'Bo' }], 'me');
  return JSON.stringify(document.querySelector('#lobby-start-note').textContent.trim());
}));

// leave the lobby so the game surfaces show, then measure
await p.evaluate(() => { window.__lobby.hide(); });
await p.waitForTimeout(300);
for (const [w, h] of [[1600, 900], [1280, 800], [1100, 700], [1024, 640]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.evaluate(() => {
    const sb = window.__scoreboard; sb.show();
    sb.update([
      { id: 'p1', name: 'Ada', score: 48210, lives: 44, wave: 9, killed: 210, leaked: 6 },
      { id: 'p2', name: 'Grace', score: 31980, lives: 50, wave: 9, killed: 180, leaked: 0 },
      { id: 'p3', name: 'Alan', score: 12040, lives: 7, wave: 8, killed: 90, leaked: 43 },
      { id: 'p4', name: 'Mira', score: 8800, lives: 0, wave: 6, killed: 51, leaked: 50, finished: true },
    ], 'p2');
  });
  await p.waitForTimeout(1400);
  const r = await p.evaluate(() => {
    const g = (s) => { const n = document.querySelector(s); if (!n) return null; const b = n.getBoundingClientRect(); const st = getComputedStyle(n); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), disp: st.display, vis: st.visibility, op: st.opacity }; };
    return { sb: g('#scoreboard'), th: g('#threat') };
  });
  let ov = 'n/a';
  if (r.sb && r.th) {
    const ox = Math.max(0, Math.min(r.sb.x + r.sb.w, r.th.x + r.th.w) - Math.max(r.sb.x, r.th.x));
    const oy = Math.max(0, Math.min(r.sb.y + r.sb.h, r.th.y + r.th.h) - Math.max(r.sb.y, r.th.y));
    ov = { overlapX: +ox.toFixed(1), overlapY: +oy.toFixed(1), overlapArea: +(ox * oy).toFixed(1) };
  }
  console.log(`${w}x${h} :: ` + JSON.stringify({ ...r, overlap: ov }));
}
console.log('errs :: ' + JSON.stringify(errs));
await b.close();
