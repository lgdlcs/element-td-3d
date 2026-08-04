/** ADVERSARIAL PROBE — the lobby hall (scoreboard). Throwaway. */
import { chromium } from 'playwright';
const OUT = '/private/tmp/claude-501/-Users-pouetpouets/026630db-b7b9-4e91-805a-b7d7caf27667/scratchpad';
const VITE_STUB = 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export const createHotContextLegacy=()=>({accept(){},dispose(){},invalidate(){},on(){},send(){}});';
const say = (n, o) => console.log(`\n## ${n}\n${JSON.stringify(o, null, 1)}`);
const TAG = process.argv[2] || 'noserver';
const BEST = process.env.BEST || '';

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });

const sizes = [
  [1280, 720], [1920, 1080], [1100, 700], [1180, 720], [1366, 768], [2560, 1440],
];

for (const [w, h] of sizes) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[err] ${m.text()}`); });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
  if (BEST) {
    await p.addInitScript((v) => { try { localStorage.setItem('elementtd.best.v1', v); } catch { /* */ } }, BEST);
  }
  await p.goto('http://localhost:5273/?q=low&mp', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby, null, { timeout: 90000 });
  await p.evaluate(() => document.getElementById('boot')?.remove());
  // let connect() settle (dead port -> offline) and the 8s hall timer expire
  await p.waitForTimeout(TAG === 'noserver' ? 3000 : 4000);

  const info = await p.evaluate(() => {
    const L = window.__lobby;
    const el = document.getElementById('lobby');
    const hall = document.getElementById('lobby-hall');
    const plate = document.querySelector('.lobby-inner');
    const mini = document.getElementById('lobby-hall-mini');
    const rect = (n) => (n ? n.getBoundingClientRect().toJSON() : null);
    const txt = (id) => document.getElementById(id)?.textContent.replace(/\s+/g, ' ').trim();
    return {
      state: L.state, connection: L.connection, hallState: el.dataset.hall,
      topReceived: L.topReceived, topLen: L.top.length,
      status: txt('lobby-hall-status'), best: txt('lobby-hall-best'),
      list: txt('lobby-hall-list'), note: txt('lobby-hall-note'), mini: txt('lobby-hall-mini'),
      keys: txt('lobby-keys'),
      keysEscShown: (() => { const i = document.querySelector('#lobby-keys i'); return i ? getComputedStyle(i).display : 'missing'; })(),
      hallVisible: hall ? getComputedStyle(hall).display !== 'none' : false,
      miniVisible: mini ? getComputedStyle(mini).display !== 'none' : false,
      hallRect: rect(hall), plateRect: rect(plate),
      vw: innerWidth, vh: innerHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth,
      bodyText: document.getElementById('lobby').innerText,
      errBox: (() => { const e = document.getElementById('lobby-error'); return { hidden: e.hidden, text: e.textContent.trim() }; })(),
      timerLive: !!L._hallTimer,
    };
  });
  const bad = /undefined|NaN|null|\[object/i.exec(info.bodyText || '');
  say(`${TAG} ${w}x${h}`, {
    state: info.state, connection: info.connection, hallState: info.hallState,
    topReceived: info.topReceived, topLen: info.topLen,
    status: info.status, best: info.best, list: info.list, note: info.note,
    mini: info.mini, miniVisible: info.miniVisible, hallVisible: info.hallVisible,
    keys: info.keys, keysEscShown: info.keysEscShown,
    hallRight: info.hallRect ? Math.round(info.hallRect.right) : null,
    hallTop: info.hallRect ? Math.round(info.hallRect.top) : null,
    hallBottom: info.hallRect ? Math.round(info.hallRect.bottom) : null,
    hallLeft: info.hallRect ? Math.round(info.hallRect.left) : null,
    plateRight: info.plateRect ? Math.round(info.plateRect.right) : null,
    plateTop: info.plateRect ? Math.round(info.plateRect.top) : null,
    plateBottom: info.plateRect ? Math.round(info.plateRect.bottom) : null,
    overflowX: info.overflowX,
    offscreenRight: info.hallRect ? Math.round(info.hallRect.right) > info.vw : null,
    overlapsPlate: info.hallRect && info.plateRect ? Math.round(info.hallRect.left) < Math.round(info.plateRect.right) : null,
    clippedVertically: info.hallRect ? (info.hallRect.top < 0 || info.hallRect.bottom > info.vh) : null,
    suspectText: bad ? bad[0] : null,
    errBox: info.errBox, timerLive: info.timerLive,
    errors,
  });
  await p.screenshot({ path: `${OUT}/lobby-${TAG}-${w}x${h}.png` });
  await ctx.close();
}
await b.close();
