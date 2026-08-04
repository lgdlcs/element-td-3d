#!/usr/bin/env node
/**
 * HUD public-contract check.
 *
 * Game.js calls a fixed set of HUD methods and the HUD calls back into a fixed
 * set of Game methods. This drives every one of them for real — through the
 * live page, with real clicks and keys where a user would use them — and
 * asserts the DOM actually changed. Any regression here breaks the game.
 */
import { chromium } from 'playwright';
// The tower count is asserted against the constant that DEFINES it, not against
// a literal. This check spent a round red because it still demanded 21 after the
// six primals landed and took the table to 27 — a stale number in the safety net
// is worse than no net, because a real failure hides behind a FAIL everyone has
// learned to ignore. uikit.js imports nothing that needs a DOM or a GL context,
// so plain node can load it.
import { TOWER_TOTAL } from '../src/ui/uikit.js';

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

await page.route('**/@vite/client', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export const createHotContext = () => ({ accept(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){} }); export const injectQuery = (u) => u; export const removeStyle = () => {};' }));
await page.goto('http://localhost:5273/?q=ultra', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await page.evaluate(() => document.getElementById('boot')?.remove());

const results = [];
const check = async (name, fn) => {
  try {
    const ok = await fn();
    results.push([ok === true, name, ok === true ? '' : String(ok)]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
};

const ev = (fn, arg) => page.evaluate(fn, arg);

// ---------------------------------------------------------------- HUD API ---

await check('openElementPicker() opens, renders 3 cards', () => ev(() => {
  const g = window.__game;
  g.state.elements = ['fire', 'water'];
  g.state.pendingElementPicks = 2;
  g.hud.openElementPicker();
  const el = document.querySelector('#picker');
  const n = el.querySelectorAll('.pcard').length;
  return (el.classList.contains('open') && n === 3) || `open=${el.classList.contains('open')} cards=${n}`;
}));

await check('picker shows unlocked fusions for a pick', () => ev(() => {
  const li = document.querySelectorAll('#picker-cards .pcard .pc-fusions li');
  return li.length > 0 || 'no unlock rows rendered';
}));

await check('chooseElement() via card click advances the game', async () => {
  const before = await ev(() => window.__game.state.elements.length);
  await page.click('#picker-cards .pcard');
  await page.waitForTimeout(450);
  const after = await ev(() => window.__game.state.elements.length);
  return after === before + 1 || `elements ${before} -> ${after}`;
});

await check('closeElementPicker() closes', () => ev(() => {
  const g = window.__game;
  g.state.pendingElementPicks = 0;
  g.hud.closeElementPicker();
  return !document.querySelector('#picker').classList.contains('open') || 'still open';
}));

await check('refreshTop() writes gold/lives/wave/score', () => ev(() => {
  const g = window.__game;
  g.state.gold = 1234; g.state.lives = 37; g.state.wave = 9; g.state.score = 55500;
  g.hud._goldShown = 1234;
  g.hud.refreshTop();
  document.querySelector('#stat-gold').textContent = '1 234';
  const q = (s) => document.querySelector(s).textContent.replace(/\s+/g, ' ').trim();
  return (q('#stat-lives') === '37' && q('#stat-wave') === '9' && q('#stat-score') === '55 500')
    || `${q('#stat-lives')}|${q('#stat-wave')}|${q('#stat-score')}`;
}));

await check('refreshBuildBar() renders one card per owned element', () => ev(() => {
  const g = window.__game;
  g.state.elements = ['fire', 'water', 'nature', 'earth', 'light', 'dark'];
  g.state.gold = 9000;
  g.hud.refreshBuildBar();
  const pure = document.querySelectorAll('#dock-pure .tcard').length;
  const fus = document.querySelectorAll('#dock-fusion .tcard').length;
  return (pure === 6 && fus === 4) || `pure=${pure} fusion=${fus}`;
}));

await check('setBuildSelection() via card click', async () => {
  await page.click('#dock-pure .tcard[data-tower="earth"]');
  const sel = await ev(() => window.__game.selectedBuild);
  const styled = await ev(() => document.querySelector('#dock-pure .tcard[data-tower="earth"]').classList.contains('selected'));
  return (sel === 'earth' && styled) || `selected=${sel} styled=${styled}`;
});

await check('build hotkey (E = nature) selects', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('e');
  const sel = await ev(() => window.__game.selectedBuild);
  return sel === 'nature' || `selectedBuild=${sel}`;
});

await check('F toggles the tower table, Escape closes it', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const open = await ev(() => document.querySelector('#codex').classList.contains('open'));
  const cells = await ev(() => document.querySelectorAll('#codex-grid .cx-cell').length);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closed = await ev(() => !document.querySelector('#codex').classList.contains('open'));
  return (open && closed && cells === TOWER_TOTAL)
    || `open=${open} closed=${closed} cells=${cells} (want ${TOWER_TOTAL})`;
});

await check('openInspector() renders stats and upgrade delta', async () => {
  const r = await ev(() => {
    const g = window.__game;
    g.setBuildSelection(null);
    g.build('fire', 10, 3);
    const t = g.towers.towers[g.towers.towers.length - 1];
    t.totalDamage = 51200; t.kills = 88;
    g.selectTower(t.id);
    const el = document.querySelector('#inspector');
    return {
      open: el.classList.contains('open'),
      rows: el.querySelectorAll('.ir').length,
      deltas: el.querySelectorAll('.ir-d.up').length,
      dps: el.querySelector('.ih-main b')?.textContent,
      modes: el.querySelectorAll('[data-mode]').length,
    };
  });
  return (r.open && r.rows >= 4 && r.deltas > 0 && r.modes === 4)
    || JSON.stringify(r);
});

await check('targeting mode control writes tower.mode', async () => {
  await page.click('#inspector [data-mode="strong"]');
  const mode = await ev(() => window.__game.towers.byId(window.__game.selectedTower).mode);
  const on = await ev(() => document.querySelector('#inspector [data-mode="strong"]').classList.contains('on'));
  return (mode === 'strong' && on) || `mode=${mode} on=${on}`;
});

await check('upgradeTower() via inspector button', async () => {
  const before = await ev(() => window.__game.towers.byId(window.__game.selectedTower).level);
  await page.click('#inspector #insp-upgrade');
  await page.waitForTimeout(120);
  const after = await ev(() => window.__game.towers.byId(window.__game.selectedTower).level);
  return after === before + 1 || `level ${before} -> ${after}`;
});

await check('closeInspector() closes', () => ev(() => {
  window.__game.hud.closeInspector();
  return !document.querySelector('#inspector').classList.contains('open') || 'still open';
}));

await check('sellTower() via inspector button', async () => {
  await ev(() => window.__game.selectTower(window.__game.towers.towers[window.__game.towers.towers.length - 1].id));
  const before = await ev(() => window.__game.towers.towers.length);
  await page.click('#inspector #insp-sell');
  await page.waitForTimeout(120);
  const after = await ev(() => window.__game.towers.towers.length);
  return after === before - 1 || `towers ${before} -> ${after}`;
});

await check('warn() shows a toast', () => ev(() => {
  window.__game.hud.warn('Not enough gold');
  const t = document.querySelector('#toast');
  return (t.classList.contains('show') && t.textContent === 'Not enough gold') || t.textContent;
}));

await check('announceInterest() / announceBonus()', () => ev(() => {
  const h = window.__game.hud;
  h.announceInterest(96);
  const a = document.querySelector('#toast').textContent;
  h.announceBonus(24);
  const b = document.querySelector('#toast').textContent;
  return (a.includes('96') && b.includes('24')) || `${a} | ${b}`;
}));

await check('announceWave() renders wave + type, boss styling', () => ev(() => {
  const h = window.__game.hud;
  h.announceWave({ n: 30, type: 'boss', count: 2, isBoss: true });
  const el = document.querySelector('#announce');
  const boss = el.classList.contains('boss');
  const txt = el.textContent.replace(/\s+/g, ' ').trim();
  h.announceWave({ n: 7, type: 'fast', count: 12, isBoss: false });
  const notBoss = !document.querySelector('#announce').classList.contains('boss');
  return (boss && notBoss && txt.includes('30')) || `boss=${boss} notBoss=${notBoss} "${txt}"`;
}));

await check('pulseLives() re-triggers the hit animation', () => ev(() => {
  const h = window.__game.hud;
  h.pulseLives();
  const a = document.querySelector('#lives-box').classList.contains('hit');
  h.pulseLives();
  const b = document.querySelector('#lives-box').classList.contains('hit');
  const vig = document.querySelector('#damage-vignette').classList.contains('flash');
  return (a && b && vig) || `a=${a} b=${b} vignette=${vig}`;
}));

await check('floatText() projects and update() advances it', async () => {
  const r = await ev(async () => {
    const h = window.__game.hud;
    h.floatText(0, 2, 0, '+250', '#ffd766');
    const all = document.querySelectorAll('.float-text');
    const el = all[all.length - 1];
    const created = !!el && el.textContent === '+250';
    h.update(0.016);
    const moved = !!el.style.transform;
    for (let i = 0; i < 8; i++) h.update(0.3);   // outlive it
    const gone = ![...document.querySelectorAll('.float-text')].some((n) => n.textContent === '+250');
    return { created, moved, gone };
  });
  return (r.created && r.moved && r.gone) || JSON.stringify(r);
});

await check('update(dt) tweens gold instead of jumping', async () => {
  const r = await ev(async () => {
    const g = window.__game;
    g.state.gold = 1000; g.hud._goldShown = 1000; g.hud.update(0.016);
    g.state.gold = 5000;
    g.hud.update(0.016);
    const mid = document.querySelector('#stat-gold').textContent;
    for (let i = 0; i < 400; i++) g.hud.update(0.016);
    const end = document.querySelector('#stat-gold').textContent;
    return { mid, end };
  });
  const midN = Number(r.mid.replace(/\s/g, ''));
  return (midN > 1000 && midN < 5000 && r.end.replace(/\s/g, '') === '5000') || JSON.stringify(r);
});

await check('setSpeed() via speed buttons', async () => {
  await page.click('#speed-buttons button[data-speed="3"]');
  const s = await ev(() => window.__game.state.speed);
  const on = await ev(() => document.querySelector('#speed-buttons button[data-speed="3"]').classList.contains('active'));
  await page.click('#speed-buttons button[data-speed="1"]');
  return (s === 3 && on) || `speed=${s} active=${on}`;
});

await check('pause button toggles state', async () => {
  await page.click('#pause-btn');
  const p = await ev(() => window.__game.state.paused);
  await page.click('#pause-btn');
  const q = await ev(() => window.__game.state.paused);
  return (p === true && q === false) || `${p} -> ${q}`;
});

await check('startWaveNow() via Send wave button', async () => {
  await ev(() => { const g = window.__game; g.state.phase = 'prep'; g.state.wave = 4; g.state.prepTimer = 6; g.hud.update(0.016); });
  await page.click('#send-wave');
  const r = await ev(() => ({ phase: window.__game.state.phase, wave: window.__game.state.wave }));
  return (r.phase === 'combat' && r.wave === 5) || JSON.stringify(r);
});

await check('threat rail shows composition and a run-ahead', () => ev(() => {
  const g = window.__game;
  g.state.phase = 'prep'; g.state.wave = 19; g.state.prepTimer = 9;
  g.hud.update(0.016);
  const card = document.querySelector('#th-next .th-card');
  const ahead = document.querySelectorAll('#th-ahead li').length;
  return (!!card && ahead === 4) || `card=${!!card} ahead=${ahead}`;
}));

await check('showEnd(true) / showEnd(false)', () => ev(() => {
  const h = window.__game.hud;
  h.showEnd(true);
  const win = document.querySelector('#endcard .end-inner').classList.contains('win');
  const shown = document.querySelector('#endcard').classList.contains('show');
  h.showEnd(false);
  const lose = document.querySelector('#endcard .end-inner').classList.contains('lose');
  document.querySelector('#endcard').classList.remove('show');
  return (win && shown && lose) || `win=${win} shown=${shown} lose=${lose}`;
}));

await check('every interactive control is keyboard reachable', () => ev(() => {
  const sel = '#dock button, #topbar button, #inspector button, #threat button, #codex button:not([tabindex="-1"])';
  const all = [...document.querySelectorAll(sel)];
  const bad = all.filter((b) => b.tabIndex < 0 && !b.disabled);
  return bad.length === 0 || `${bad.length} unreachable`;
}));

await check('no resting HUD covers the central 46% of the board', () => ev(() => {
  const w = innerWidth, h = innerHeight;
  const box = { x0: w * 0.27, x1: w * 0.73, y0: h * 0.18, y1: h * 0.80 };
  const resting = ['#topbar', '#threat', '#inspector', '#dock'];
  const hits = [];
  for (const s of resting) {
    const el = document.querySelector(s);
    if (!el || getComputedStyle(el).opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.right > box.x0 && r.left < box.x1 && r.bottom > box.y0 && r.top < box.y1) {
      hits.push(`${s} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  return hits.length === 0 || hits.join('; ');
}));

// ------------------------------------------------------------------ report --

await browser.close();
const failed = results.filter(([ok]) => !ok);
for (const [ok, name, why] of results) console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}${why ? `  — ${why}` : ''}`);
const errors = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (errors.length) console.log('console errors:\n' + errors.join('\n'));
process.exit(failed.length || errors.length ? 1 : 0);
