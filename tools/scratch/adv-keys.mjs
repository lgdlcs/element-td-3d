/** ADVERSARIAL PROBE — keyboard shortcuts / help sheet. Throwaway. */
import { chromium } from 'playwright';

const OUT = '/private/tmp/claude-501/-Users-pouetpouets/026630db-b7b9-4e91-805a-b7d7caf27667/scratchpad';
const VITE_STUB = 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export const createHotContextLegacy=()=>({accept(){},dispose(){},invalidate(){},on(){},send(){}});';

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error') errors.push(`[err] ${m.text()}`); });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());
await p.evaluate(() => {
  const g = window.__game;
  for (const id of ['fire', 'water']) { g.state.pendingElementPicks = 1; g.chooseElement(id); }
  g.state.gold = 5000; g.hud._goldShown = 5000; g.state.paused = true;
  g.hud.refreshTop(); g.hud.refreshBuildBar();
});
await p.waitForFunction(() => !document.getElementById('picker')?.classList.contains('open'));

const S = () => p.evaluate(() => {
  const g = window.__game;
  return {
    build: g.selectedBuild, tower: g.selectedTower, speed: g.state.speed,
    paused: g.state.paused, wave: g.state.wave, phase: g.state.phase,
    help: document.getElementById('help').classList.contains('open'),
    codex: document.getElementById('codex')?.classList.contains('open'),
    insp: document.getElementById('inspector')?.classList.contains('open'),
    towers: g.towers.towers.length,
    active: document.activeElement?.className || document.activeElement?.id || document.activeElement?.tagName,
  };
});
const say = (n, o) => console.log(`\n## ${n}\n${JSON.stringify(o, null, 1)}`);

// ---- 1. every kbd badge on screen ----------------------------------------
await p.evaluate(() => { window.__game.hud.build.setCodex(true); });
await p.waitForTimeout(200);
await p.evaluate(() => { window.__game.hud.build.setCodex(false); window.__game.build('fire', 10, 8); window.__game.setBuildSelection(null); window.__game.selectTower(window.__game.towers.towers[0].id); });
await p.waitForTimeout(300);
say('kbd badges in DOM (run, inspector open)', await p.evaluate(() => [...document.querySelectorAll('kbd')].map((k) => ({
  t: k.textContent.trim(), in: k.closest('[id]')?.id || k.parentElement?.className,
  vis: !!(k.offsetWidth || k.offsetHeight), w: k.getBoundingClientRect().width,
}))));
say('aria-keyshortcuts', await p.evaluate(() => [...document.querySelectorAll('[aria-keyshortcuts]')].map((n) => ({
  id: n.id || n.className, k: n.getAttribute('aria-keyshortcuts'), disabled: n.disabled === true,
}))));

// ---- 2. M on a tower with no morph targets --------------------------------
say('inspector morph button', await p.evaluate(() => {
  const btn = document.getElementById('insp-morph');
  return { disabled: btn?.disabled, title: btn?.title, hasKbd: !!btn?.querySelector('kbd') };
}));
await p.keyboard.press('KeyM');
await p.waitForTimeout(250);
say('after pressing M', { morphSheet: await p.evaluate(() => document.getElementById('inspector')?.classList.contains('morph')) });
await p.keyboard.press('Escape');
await p.waitForTimeout(150);

// ---- 3. help sheet is "aria-modal" — do game keys still fire? ------------
await p.evaluate(() => { const g = window.__game; g.selectTower(null); g.setBuildSelection(null); g.state.paused = true; g.setSpeed(1); });
await p.keyboard.press('KeyH');
await p.waitForTimeout(300);
const beforeModal = await S();
const leaks = {};
await p.keyboard.press('KeyQ'); await p.waitForTimeout(80); leaks.afterQ = (await S()).build;
await p.keyboard.press('Digit3'); await p.waitForTimeout(80); leaks.afterDigit3_speed = (await S()).speed;
await p.keyboard.press('KeyP'); await p.waitForTimeout(80); leaks.afterP_paused = (await S()).paused;
await p.keyboard.press('Space'); await p.waitForTimeout(300); const sp = await S(); leaks.afterSpace = { wave: sp.wave, phase: sp.phase };
await p.keyboard.press('KeyG'); await p.waitForTimeout(80); leaks.afterG_perf = await p.evaluate(() => !!document.querySelector('#perf-hud, .perf-hud, #perf')?.offsetParent);
say('keys that pierce the aria-modal help sheet', { beforeModal, leaks, stillOpen: (await S()).help });

// ---- 4. Escape ordering ---------------------------------------------------
await p.evaluate(() => { window.__game.state.paused = true; window.__game.setBuildSelection('fire'); });
await p.waitForTimeout(120);
const eOrder = [];
eOrder.push({ stage: 'help open + piece', ...(await S()) });
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
eOrder.push({ stage: 'after Esc #1', ...(await S()) });
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
eOrder.push({ stage: 'after Esc #2', ...(await S()) });
say('escape ordering', eOrder.map((s) => ({ stage: s.stage, help: s.help, build: s.build })));

// ---- 5. Tab trap in the help sheet ---------------------------------------
await p.keyboard.press('KeyH'); await p.waitForTimeout(300);
const tabs = [];
for (let i = 0; i < 6; i++) { await p.keyboard.press('Tab'); tabs.push((await S()).active); }
say('tab trap', { tabs, help: (await S()).help });
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
say('focus after close', { active: (await S()).active });

// ---- 6. typing guard ------------------------------------------------------
await p.evaluate(() => {
  const i = document.createElement('input');
  i.id = 'probe-in'; i.style.cssText = 'position:fixed;top:150px;left:150px;z-index:9999;width:240px;height:28px';
  document.body.appendChild(i); i.focus();
  const ta = document.createElement('textarea');
  ta.id = 'probe-ta'; ta.style.cssText = 'position:fixed;top:190px;left:150px;z-index:9999;width:240px;height:60px';
  document.body.appendChild(ta);
});
await p.evaluate(() => { window.__game.setBuildSelection(null); window.__game.state.paused = true; window.__game.setSpeed(1); });
await p.keyboard.type('hu qx p 3');
await p.waitForTimeout(200);
say('typing into <input>', {
  value: await p.evaluate(() => document.getElementById('probe-in').value),
  ...(await S()),
});
await p.evaluate(() => document.getElementById('probe-ta').focus());
await p.keyboard.type('hu qx p 3');
await p.waitForTimeout(200);
say('typing into <textarea>', {
  value: await p.evaluate(() => document.getElementById('probe-ta').value),
  ...(await S()),
});
await p.evaluate(() => { document.getElementById('probe-in').remove(); document.getElementById('probe-ta').remove(); document.activeElement?.blur?.(); });

// ---- 7. H while the element PICKER is up ---------------------------------
await p.evaluate(() => { const g = window.__game; g.state.pendingElementPicks = 1; g.hud.picker.show(); g.hud.picker.open = true; });
await p.waitForTimeout(400);
await p.keyboard.press('KeyH'); await p.waitForTimeout(400);
await p.screenshot({ path: `${OUT}/keys-help-over-picker.png` });
say('H during the element offer', {
  help: (await S()).help,
  pickerOpen: await p.evaluate(() => document.getElementById('picker').classList.contains('open')),
  helpZ: await p.evaluate(() => getComputedStyle(document.getElementById('help')).zIndex),
  pickerZ: await p.evaluate(() => getComputedStyle(document.getElementById('picker')).zIndex),
});
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
await p.evaluate(() => { window.__game.hud.picker.hide(); window.__game.hud.picker.open = false; });

// ---- 8. H after the end card ---------------------------------------------
await p.evaluate(() => { window.__game.hud.showEnd(false); });
await p.waitForTimeout(600);
say('endcard shown', { help: (await S()).help });
await p.keyboard.press('KeyH'); await p.waitForTimeout(500);
await p.screenshot({ path: `${OUT}/keys-help-over-endcard.png` });
say('H after the run ended', {
  help: (await S()).help,
  endZ: await p.evaluate(() => getComputedStyle(document.getElementById('endcard')).zIndex),
  helpZ: await p.evaluate(() => getComputedStyle(document.getElementById('help')).zIndex),
  endBtnHittable: await p.evaluate(() => {
    const btn = document.querySelector('#endcard button');
    if (!btn) return 'no button';
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return el?.className || el?.id || el?.tagName;
  }),
});

console.log('\n=== ERRORS ===', JSON.stringify(errors, null, 1));
await b.close();
