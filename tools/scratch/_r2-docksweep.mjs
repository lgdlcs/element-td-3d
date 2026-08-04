#!/usr/bin/env node
/**
 * Dock fit sweep: at every width that matters, does #send-wave stay inside the
 * dock, does its label stay inside the button, and does the early-send bonus
 * land on screen? Measured, not computed — ui.css got this wrong once by doing
 * the arithmetic instead (see the #send-wave block).
 */
import { chromium } from 'playwright';

const ARGS = ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'];
const WIDTHS = process.argv.slice(2).map(Number);
const b = await chromium.launch({ args: ARGS });
let bad = 0;
for (const w of (WIDTHS.length ? WIDTHS : [1280, 1366, 1440, 1500, 1600, 1728, 1920, 2560])) {
  const page = await b.newPage({ viewport: { width: w, height: 800 } });
  await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export default {};export function createHotContext(){return {on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){},decline(){}}}' }));
  await page.goto('http://localhost:5273/?q=low');
  await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
  await page.evaluate(() => document.getElementById('boot')?.remove());
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const g = window.__game;
    g.state.pendingElementPicks = 0;
    g.hud.closeElementPicker();
    g.state.gold = 5000;
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    g.state.phase = 'prep';
    g.hud.refreshBuildBar();
    g.hud.build.setPrep(true, 59);
  });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const R = (n) => { const r = n.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; };
    const dock = R(document.getElementById('dock'));
    const sw = R(document.getElementById('send-wave'));
    const lbl = R(document.querySelector('.sw-label'));
    const bon = R(document.getElementById('sw-bonus'));
    const cards = [...document.querySelectorAll('#dock .tcard')].map(R);
    return {
      dock, sw, lbl, bon,
      btnOutsideDock: sw.r > dock.r + 1 || sw.l < dock.l - 1,
      labelClipped: lbl.r > sw.r - 1,
      bonusOffDock: bon.w > 0 && (bon.r > dock.r || bon.l < dock.l),
      cardClipped: cards.some((c) => c.l < dock.l - 1 || c.r > dock.r + 1),
      dockOffScreen: dock.l < 0 || dock.r > window.innerWidth,
    };
  });
  const fail = m.btnOutsideDock || m.labelClipped || m.bonusOffDock || m.cardClipped || m.dockOffScreen;
  if (fail) bad++;
  console.log(`${String(w).padStart(5)}  dock ${m.dock.w}  btn ${m.sw.w}  ` +
    `${fail ? 'FAIL' : 'ok  '} ` +
    `${m.btnOutsideDock ? 'btn-outside-dock ' : ''}${m.labelClipped ? 'label-clipped ' : ''}` +
    `${m.bonusOffDock ? 'bonus-off-dock ' : ''}${m.cardClipped ? 'card-clipped ' : ''}` +
    `${m.dockOffScreen ? 'dock-off-screen' : ''}`);
  await page.close();
}
await b.close();
console.log(bad ? `${bad} width(s) FAIL` : 'all widths ok');
process.exit(bad ? 1 : 0);
