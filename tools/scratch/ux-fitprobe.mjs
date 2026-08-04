/**
 * Did the key caps push anything off an edge?
 *
 * The top bar and the dock are single rows with a max-width, so widening a
 * control by a few pixels is exactly the kind of change that silently clips the
 * last thing on the right — and a screenshot of a 1920px frame renders that as
 * eight pixels of missing letter that nobody reads.
 *
 * PAIRED, not absolute (PITFALLS §12): every number is measured twice on the
 * SAME page, once as shipped and once with the new `kbd` rule neutralised back
 * to what it was. A difference is mine; an identical pair is pre-existing.
 *
 *   node tools/scratch/ux-fitprobe.mjs [w] [h]
 */
import { chromium } from 'playwright';

const HMR = 'export const createHotContext=()=>({accept(){},prune(){},dispose(){},invalidate(){},on(){},send(){}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;';

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });

for (const [W, H] of [[1280, 720], [1600, 900], [1920, 1080]]) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: HMR }));
  await p.goto('http://localhost:5273/?q=low', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
  await p.evaluate(() => document.getElementById('boot')?.remove());
  await p.evaluate(() => {
    const g = window.__game;
    g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
    g.state.pendingElementPicks = 0;
    g.hud.closeElementPicker();
    g.state.phase = 'prep';
    g.state.gold = 99999;
    g.hud.refreshBuildBar();
    g.hud.build.setPrep(true, 116);
  });
  await p.waitForTimeout(600);

  const measure = () => p.evaluate(() => {
    const out = {};
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width),
        over: Math.round(r.right) > window.innerWidth };
    };
    out.topbarControls = box('#topbar .controls');
    out.dock = box('#dock');
    out.send = box('#send-wave');
    out.sendKbd = box('#send-wave kbd');
    const d = document.querySelector('#dock');
    out.dockOverflow = d.scrollWidth - d.clientWidth;
    // Does the last thing in the dock actually fit inside the dock's own box?
    const k = document.querySelector('#send-wave kbd');
    out.kbdInsideDock = k ? Math.round(k.getBoundingClientRect().right) <= Math.round(d.getBoundingClientRect().right) : null;
    return out;
  });

  const now = await measure();
  // Neutralise the new cap rule back to the old one.
  await p.addStyleTag({ content: 'kbd{display:inline!important;min-width:0!important;font-weight:400!important;box-shadow:none!important;border-color:rgba(255,255,255,.075)!important;background:rgba(255,255,255,.055)!important;}kbd.k-tight{padding:3px 5px 4px!important}' });
  await p.waitForTimeout(300);
  const old = await measure();

  const cmp = (k) => {
    const a = JSON.stringify(now[k]); const o = JSON.stringify(old[k]);
    console.log(`  ${k.padEnd(16)} new=${a}\n  ${''.padEnd(16)} old=${o}  ${a === o ? '(identical)' : '(MOVED)'}`);
  };
  console.log(`\n=== ${W}x${H} ===`);
  for (const k of ['topbarControls', 'dock', 'send', 'sendKbd']) cmp(k);
  console.log(`  dockOverflow new=${now.dockOverflow}px old=${old.dockOverflow}px   kbdInsideDock new=${now.kbdInsideDock} old=${old.kbdInsideDock}`);
  await p.close();
}

await b.close();
