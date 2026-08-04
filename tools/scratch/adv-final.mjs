/** ADVERSARIAL PROBE — layout/fit + codex escape ordering. Throwaway. */
import { chromium } from 'playwright';
const OUT = '/private/tmp/claude-501/-Users-pouetpouets/026630db-b7b9-4e91-805a-b7d7caf27667/scratchpad';
const VITE_STUB = 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export const createHotContextLegacy=()=>({accept(){},dispose(){},invalidate(){},on(){},send(){}});';
const say = (n, o) => console.log(`\n## ${n}\n${JSON.stringify(o, null, 1)}`);
const REWRITE = `(() => { const OW = window.WebSocket; function W(u,p){ const s=String(u).replace(':5274',':5275'); return p===undefined?new OW(s):new OW(s,p);} W.prototype=OW.prototype; for(const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) W[k]=OW[k]; window.WebSocket=W; })();`;

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });

// ---- A. worst legitimate leaderboard row (MAX_SCORE + 16-char name) -------
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
  await p.addInitScript(REWRITE);
  await p.addInitScript(() => { try { localStorage.setItem('elementtd.best.v1', JSON.stringify({ score: 99999999, wave: 55, won: true, at: 1 })); } catch { /* */ } });
  await p.goto('http://localhost:5273/?q=low&mp', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__lobby, null, { timeout: 90000 });
  await p.evaluate(() => document.getElementById('boot')?.remove());
  await p.waitForTimeout(2200);
  await p.evaluate(() => {
    window.__lobby.setConnection('online');
    window.__game.hud.setLeaderboard([
      { name: 'Wolfhardt Grimm', score: 100000000, wave: 10000 },
      { name: 'Æthelstan Vīrsų', score: 99999999, wave: 999 },
      { name: 'x', score: 1, wave: 1 },
    ]);
  });
  await p.waitForTimeout(500);
  say('worst legit row 1280x720', await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.hall-row')];
    const hall = document.getElementById('lobby-hall');
    const hr = hall.getBoundingClientRect();
    return {
      rows: rows.map((n) => ({
        text: n.textContent.replace(/\s+/g, ' ').trim(),
        nameW: Math.round(n.querySelector('.hr-name').getBoundingClientRect().width),
        h: Math.round(n.getBoundingClientRect().height),
        overflows: n.getBoundingClientRect().right > hr.right - 15,
      })),
      note: document.getElementById('lobby-hall-note').textContent.trim(),
      bestLine: document.getElementById('lobby-hall-best').textContent.replace(/\s+/g, ' ').trim(),
      bestVW: Math.round(document.querySelector('.hb-v').getBoundingClientRect().width),
      hallW: Math.round(hr.width),
    };
  }));
  await p.screenshot({ path: `${OUT}/lobby-worstrow-1280x720.png` });
  await ctx.close();
}

// ---- B. topbar + help sheet fit in a running game -------------------------
for (const [w, h] of [[1280, 720], [1024, 768], [1440, 620], [1920, 1080]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[err] ${m.text()}`); });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
  await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
  await p.evaluate(() => document.getElementById('boot')?.remove());
  await p.evaluate(() => {
    const g = window.__game;
    for (const id of ['fire', 'water', 'nature', 'earth', 'light', 'dark']) { g.state.pendingElementPicks = 1; g.chooseElement(id); }
    g.state.gold = 9999; g.hud._goldShown = 9999; g.state.paused = true;
    g.hud.refreshTop(); g.hud.refreshBuildBar();
  });
  await p.waitForTimeout(700);
  const bar = await p.evaluate(() => {
    const el = document.querySelector('#topbar, header');
    const ctr = document.querySelector('.controls');
    const stats = document.querySelector('.stats, #stat-gold')?.closest('div');
    const dock = document.getElementById('dock');
    return {
      barW: el ? Math.round(el.getBoundingClientRect().width) : null,
      ctrl: ctr ? ctr.getBoundingClientRect().toJSON() : null,
      ctrlScroll: ctr ? { sw: ctr.scrollWidth, cw: ctr.clientWidth } : null,
      dock: { l: Math.round(dock.getBoundingClientRect().left), r: Math.round(dock.getBoundingClientRect().right), sw: dock.scrollWidth, cw: dock.clientWidth },
      docBodyOverflow: document.documentElement.scrollWidth > innerWidth,
      sendWave: (() => { const s = document.getElementById('send-wave'); const k = s.querySelector('kbd'); const l = s.querySelector('.sw-label'); const bo = document.getElementById('sw-bonus');
        return { btn: s.getBoundingClientRect().toJSON(), kbdR: Math.round(k.getBoundingClientRect().right), labelR: Math.round(l.getBoundingClientRect().right), bonusR: Math.round(bo.getBoundingClientRect().right) }; })(),
    };
  });
  await p.keyboard.press('KeyH');
  await p.waitForTimeout(400);
  const sheet = await p.evaluate(() => {
    const s = document.querySelector('.help-sheet');
    const r = s.getBoundingClientRect();
    return {
      scrolls: s.scrollHeight > s.clientHeight + 1, sh: s.scrollHeight, ch: s.clientHeight,
      top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight,
      cols: getComputedStyle(document.querySelector('.help-cols')).gridTemplateColumns,
      lastRowVisible: (() => { const li = [...document.querySelectorAll('.help-group li')].pop(); const rr = li.getBoundingClientRect(); return rr.bottom <= r.bottom && rr.top >= r.top; })(),
    };
  });
  say(`run ${w}x${h}`, {
    dock: bar.dock, sendWave: {
      right: Math.round(bar.sendWave.btn.right), width: Math.round(bar.sendWave.btn.width),
      kbdR: bar.sendWave.kbdR, labelR: bar.sendWave.labelR, bonusR: bar.sendWave.bonusR,
      capClipped: bar.sendWave.kbdR > Math.round(bar.sendWave.btn.right),
      bonusOutside: bar.sendWave.bonusR > Math.round(bar.sendWave.btn.right),
    },
    dockClipped: bar.dock.sw > bar.dock.cw, bodyOverflow: bar.docBodyOverflow,
    ctrlClipped: bar.ctrlScroll && bar.ctrlScroll.sw > bar.ctrlScroll.cw,
    sheet, errors,
  });
  await p.screenshot({ path: `${OUT}/run-help-${w}x${h}.png` });

  // codex escape ordering, with a piece in hand
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.evaluate(() => { window.__game.setBuildSelection('fire'); window.__game.hud.build.setCodex(true); });
  await p.waitForTimeout(200);
  const s1 = await p.evaluate(() => ({ codex: document.getElementById('codex').classList.contains('open'), build: window.__game.selectedBuild }));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  const s2 = await p.evaluate(() => ({ codex: document.getElementById('codex').classList.contains('open'), build: window.__game.selectedBuild }));
  say(`codex escape ${w}x${h}`, { before: s1, afterEsc: s2 });
  await ctx.close();
}

await b.close();
