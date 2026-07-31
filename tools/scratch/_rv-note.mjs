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
for (const [w, h] of [[1600, 900], [1024, 640], [560, 800], [2200, 1200]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => {
    const n = document.querySelector('#lobby-name');
    n.value = '​​​'; n.dispatchEvent(new Event('input', { bubbles: true }));
    const note = document.querySelector('#lobby-name-note');
    const card = document.querySelector('#lobby-entry');
    const nb = note.getBoundingClientRect(); const cb = card.getBoundingClientRect();
    return {
      note: note.textContent.trim().slice(0, 30),
      noteRight: +(nb.x + nb.width).toFixed(1),
      cardRight: +(cb.x + cb.width).toFixed(1),
      overflowRight: +((nb.x + nb.width) - (cb.x + cb.width)).toFixed(1),
      scrollOverflow: note.scrollWidth - note.clientWidth,
      bodyHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  console.log(`${w}x${h} :: ` + JSON.stringify(r));
}
console.log('errs :: ' + JSON.stringify(errs));
await b.close();
