/** ADVERSARIAL PROBE 2 — badge inventory, dead caps, lobby shield. Throwaway. */
import { chromium } from 'playwright';
const OUT = '/private/tmp/claude-501/-Users-pouetpouets/026630db-b7b9-4e91-805a-b7d7caf27667/scratchpad';
const VITE_STUB = 'export const createHotContext = () => ({ accept(){}, acceptExports(){}, prune(){}, dispose(){}, decline(){}, invalidate(){}, on(){}, off(){}, send(){} });export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export const createHotContextLegacy=()=>({accept(){},dispose(){},invalidate(){},on(){},send(){}});';
const say = (n, o) => console.log(`\n## ${n}\n${JSON.stringify(o, null, 1)}`);

const b = await chromium.launch({ args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error') errors.push(`[err] ${m.text()}`); });
await p.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));

// ---------- A. THE LOBBY: does H / Space / F reach the game behind it? -----
await p.goto('http://localhost:5273/?q=ultra&mp', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game && !!window.__lobby, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());
await p.waitForTimeout(800);
await p.evaluate(() => document.activeElement?.blur?.());
await p.keyboard.press('KeyH');
await p.keyboard.press('KeyF');
await p.waitForTimeout(300);
say('lobby shield', {
  visible: await p.evaluate(() => window.__lobby.visible),
  help: await p.evaluate(() => document.getElementById('help').classList.contains('open')),
  codex: await p.evaluate(() => document.getElementById('codex').classList.contains('open')),
  lobbyKeysText: await p.evaluate(() => document.getElementById('lobby-keys').textContent.replace(/\s+/g, ' ').trim()),
  lobbyKeysVisible: await p.evaluate(() => {
    const n = document.querySelector('#lobby-keys i');
    return n ? getComputedStyle(n).display : 'missing';
  }),
  state: await p.evaluate(() => window.__lobby.state),
});
// right-click over the lobby: menu suppressed except on the fields?
await p.evaluate(() => {
  window.__menus = [];
  document.addEventListener('contextmenu', (e) => setTimeout(() => window.__menus.push({ prevented: e.defaultPrevented, t: e.target?.id || e.target?.className }), 0));
});
const nameBox = await p.locator('#lobby-name').boundingBox();
await p.mouse.move(nameBox.x + 20, nameBox.y + 10); await p.mouse.down({ button: 'right' }); await p.mouse.up({ button: 'right' });
await p.mouse.move(800, 200); await p.mouse.down({ button: 'right' }); await p.mouse.up({ button: 'right' });
await p.waitForTimeout(250);
say('lobby contextmenu', await p.evaluate(() => window.__menus));

// ---------- B. dead caps in the run ---------------------------------------
await p.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__game, null, { timeout: 90000 });
await p.evaluate(() => document.getElementById('boot')?.remove());
// ONE element only: a lone element has no morph target.
await p.evaluate(() => {
  const g = window.__game;
  g.state.pendingElementPicks = 1; g.chooseElement('fire');
  g.state.gold = 9000; g.hud._goldShown = 9000; g.state.paused = true;
  g.hud.refreshTop(); g.hud.refreshBuildBar();
  g.build('fire', 10, 8); g.setBuildSelection(null);
  g.selectTower(g.towers.towers[0].id);
});
await p.waitForTimeout(400);
say('morph button, single element', await p.evaluate(() => {
  const btn = document.getElementById('insp-morph');
  return { disabled: btn?.disabled, title: btn?.title, kbd: btn?.querySelector('kbd')?.textContent, aria: btn?.getAttribute('aria-keyshortcuts') };
}));
await p.keyboard.press('KeyM');
await p.waitForTimeout(400);
say('M pressed with morph disabled', {
  morphSheet: await p.evaluate(() => document.getElementById('inspector').classList.contains('morph')),
  html: await p.evaluate(() => document.querySelector('.morph-sheet')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) ?? null),
});
await p.screenshot({ path: `${OUT}/keys-morph-dead.png` });
await p.keyboard.press('Escape'); await p.waitForTimeout(200);

// maxed tower -> the U cap
await p.evaluate(() => {
  const g = window.__game;
  const t = g.towers.towers[0];
  g.upgradeTower(t.id); g.upgradeTower(t.id);
  g.selectTower(t.id);
});
await p.waitForTimeout(400);
say('maxed tower inspector', await p.evaluate(() => {
  const up = document.getElementById('insp-upgrade');
  return { lvl: window.__game.towers.towers[0].level, upDisabled: up?.disabled, upKbd: up?.querySelector('kbd')?.textContent ?? null, upAria: up?.getAttribute('aria-keyshortcuts') };
}));

// ---------- C. every kbd badge on screen ----------------------------------
await p.evaluate(() => { window.__game.hud.build.setCodex(true); });
await p.waitForTimeout(300);
say('kbd in codex', await p.evaluate(() => [...document.querySelectorAll('#codex kbd')].map((k) => k.textContent.trim())));
await p.evaluate(() => { window.__game.hud.build.setCodex(false); });
await p.waitForTimeout(300);
say('all kbd badges (visible)', await p.evaluate(() => [...document.querySelectorAll('kbd')]
  .filter((k) => k.offsetWidth || k.offsetHeight)
  .map((k) => ({ t: k.textContent.trim(), where: k.closest('[id]')?.id || k.parentElement.className, w: Math.round(k.getBoundingClientRect().width) }))));
say('#send-wave metrics', await p.evaluate(() => {
  const b = document.getElementById('send-wave');
  const k = b.querySelector('kbd');
  const l = b.querySelector('.sw-label');
  const dock = document.getElementById('dock');
  return {
    show: b.classList.contains('show'),
    btn: b.getBoundingClientRect().toJSON(), kbd: k.getBoundingClientRect().toJSON(),
    label: l.getBoundingClientRect().toJSON(), dock: dock.getBoundingClientRect().toJSON(),
  };
}));

// ---------- D. the picker: does Space double-fire? -------------------------
await p.evaluate(() => { const g = window.__game; g.state.paused = true; g.state.pendingElementPicks = 1; g.hud.picker.show(); g.hud.picker.open = true; });
await p.waitForTimeout(500);
const before = await p.evaluate(() => ({ wave: window.__game.state.wave, phase: window.__game.state.phase, els: [...window.__game.state.elements] }));
await p.keyboard.press('Space');
await p.waitForTimeout(700);
say('Space on a picker card', { before, after: await p.evaluate(() => ({ wave: window.__game.state.wave, phase: window.__game.state.phase, els: [...window.__game.state.elements] })) });

console.log('\n=== ERRORS ===', JSON.stringify(errors, null, 1));
await b.close();
