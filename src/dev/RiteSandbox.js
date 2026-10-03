/**
 * THE RITE SANDBOX: /rites.html, dev server only.
 *
 * Plays one rite at a time through the real MinigameHost with no board behind
 * it, so a rite boots in a second instead of after the whole TD scene. The host
 * reads five things off Game (seed, audio, addGold, pipeline.quality and,
 * optionally, pipeline.renderer); the stub below supplies them and nothing else,
 * so the host runs unchanged.
 *
 * NO GOLD GOES ANYWHERE. `addGold` is a sink; the would-be reward comes back in
 * the host's onDone result and is printed on the panel.
 *
 * IT CANNOT SHIP. Only rites.html loads this module, and `vite build` bundles
 * index.html alone. tools/check-no-dev.mjs fails the build check if the
 * RITE SANDBOX marker or a rites.html ever shows up in dist/.
 */

import { QUALITY_PRESETS } from '../core/Config.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { TOTAL_WAVES } from '../game/Waves.js';
import { MinigameHost } from '../minigames/MinigameHost.js';
import { MINIGAME_IDS, RITES } from '../minigames/registry.js';
import { riteOccurrence } from '../minigames/schedule.js';

const html = String.raw;
const QUALITIES = Object.keys(QUALITY_PRESETS);
const randomSeed = () => Math.floor(Math.random() * 0xffffffff) >>> 0;
const clampWave = (n) => Math.max(1, Math.min(TOTAL_WAVES, Math.round(n) || 1));

/**
 * The URL is the only input, parsed once here. Anything malformed falls back to
 * a default rather than an error: this is a dev page, and a typo in the query
 * should still land on something playable.
 */
function parseRun(search) {
  const p = new URLSearchParams(search);
  const id = MINIGAME_IDS.includes(p.get('rite')) ? p.get('rite') : null;
  const wave = clampWave(Number(p.get('wave') ?? 10));
  const occRaw = p.get('occ');
  const occ = occRaw !== null && Number.isFinite(Number(occRaw))
    ? Math.max(0, Math.floor(Number(occRaw)))
    : Math.max(0, riteOccurrence(wave - 1));
  const seedRaw = Number(p.get('seed'));
  const seed = p.get('seed') !== null && Number.isFinite(seedRaw) ? seedRaw >>> 0 : randomSeed();
  const quality = QUALITIES.includes(p.get('q')) ? p.get('q') : 'high';
  return { id, wave, occ, seed, quality, occPinned: occRaw !== null };
}

function writeUrl(run) {
  const p = new URLSearchParams();
  if (run.id) {
    p.set('rite', run.id);
    p.set('wave', String(run.wave));
    if (run.occPinned) p.set('occ', String(run.occ));
    p.set('seed', String(run.seed));
  }
  if (run.quality !== 'high') p.set('q', run.quality);
  const qs = p.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
}

const root = document.getElementById('ui-root');
const run = parseRun(location.search);

const game = {
  seed: run.seed,
  audio: new AudioEngine(),
  pipeline: { quality: run.quality },
  addGold() {},
};
const host = new MinigameHost(game, root);

root.insertAdjacentHTML('beforeend', html`
  <style>
    #sbx { position: absolute; inset: 0; overflow: auto; padding: 32px 16px; display: grid; place-items: start center; }
    #sbx[hidden], #sbx [hidden] { display: none; }
    .sbx-card { width: min(640px, 100%); display: grid; gap: 14px; }
    .sbx-card h1 { margin: 0; font-size: 20px; letter-spacing: .04em; }
    .sbx-card h1 small { font-size: 12px; color: var(--ink-dim, #999); margin-left: 8px; font-weight: 400; }
    .sbx-opts { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; font-size: 13px; }
    .sbx-opts input, .sbx-opts select { width: 80px; background: var(--solid-2); color: inherit; border: 1px solid var(--line, #333); border-radius: 6px; padding: 4px 6px; font: inherit; }
    .sbx-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .sbx-list button, .sbx-acts button {
      width: 100%; text-align: left; padding: 10px 14px; border-radius: 8px;
      background: var(--glass-hi) !important; border: 1px solid var(--line, #333) !important;
    }
    .sbx-list button:hover, .sbx-acts button:hover { border-color: var(--gold, #d4b46a) !important; }
    .sbx-list b { margin-right: 6px; }
    .sbx-list code { font-size: 12px; color: var(--gold, #d4b46a); }
    .sbx-list span { display: block; font-size: 12px; opacity: .7; margin-top: 2px; }
    .sbx-res { margin: 0 0 8px; padding: 12px 14px; border-radius: 8px; background: var(--glass); border: 1px solid var(--line, #333); font-size: 14px; }
    .sbx-res b { color: var(--gold, #d4b46a); }
    .sbx-acts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .sbx-acts button { text-align: center; }
  </style>
  <div id="sbx" data-mode="pick">
    <div class="sbx-card">
      <h1>Rite sandbox <small>dev only, gold is never credited</small></h1>
      <div class="sbx-opts">
        <label>Wave <input id="sbx-wave" type="number" min="1" max="${TOTAL_WAVES}"></label>
        <label>Quality <select id="sbx-q">${QUALITIES.map((q) => `<option>${q}</option>`).join('')}</select></label>
        <span id="sbx-seed"></span>
      </div>
      <div id="sbx-done" hidden>
        <p class="sbx-res" id="sbx-res"></p>
        <div class="sbx-acts">
          <button type="button" data-act="replay">Replay <kbd>R</kbd></button>
          <button type="button" data-act="reseed">New seed <kbd>N</kbd></button>
          <button type="button" data-act="back">Back to list <kbd>B</kbd></button>
        </div>
      </div>
      <ul class="sbx-list" id="sbx-list">${MINIGAME_IDS.map((id) => html`
        <li><button type="button" data-rite="${id}">
          <b>${RITES[id].name}</b><code>${id}</code><span>${RITES[id].hint}</span>
        </button></li>`).join('')}
      </ul>
    </div>
  </div>`);

const $ = (sel) => root.querySelector(sel);
const $panel = $('#sbx');
const $wave = $('#sbx-wave');
const $q = $('#sbx-q');
const $done = $('#sbx-done');
const $res = $('#sbx-res');
const $list = $('#sbx-list');
const $seed = $('#sbx-seed');

/** Last finished run, for the result line. */
let last = null;

function show(mode) {
  $panel.dataset.mode = mode;
  $panel.hidden = mode === 'playing';
  $done.hidden = mode !== 'done';
  $list.hidden = mode === 'done';
  $wave.value = String(run.wave);
  $q.value = run.quality;
  $seed.textContent = `seed ${run.seed}`;
  if (mode === 'done' && last) {
    const name = RITES[last.id]?.name ?? last.id;
    $res.innerHTML = last.skipped
      ? `${name}, wave ${run.wave}: abandoned, would have paid <b>0</b> gold.`
      : `${name}, wave ${run.wave}, occurrence ${run.occ}: ratio ${last.ratio.toFixed(2)}, would have paid <b>${last.reward}</b> gold.`;
  }
}

function launch() {
  game.seed = run.seed;
  game.pipeline.quality = run.quality;
  writeUrl(run);
  const ok = host.open({
    id: run.id,
    wave: run.wave,
    occurrence: run.occ,
    onDone: (r) => { last = r; show('done'); },
  });
  if (ok) show('playing');
}

/** Picker values win over the URL from here on: they are what the user just typed. */
function readOptions() {
  run.wave = clampWave(Number($wave.value));
  run.quality = QUALITIES.includes($q.value) ? $q.value : 'high';
  if (!run.occPinned) run.occ = Math.max(0, riteOccurrence(run.wave - 1));
}

const ACTS = {
  replay: () => launch(),
  reseed: () => { run.seed = randomSeed(); launch(); },
  back: () => { run.id = null; writeUrl(run); show('pick'); },
};

$panel.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-rite]');
  if (pick) { readOptions(); run.id = pick.dataset.rite; launch(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act && ACTS[act]) { readOptions(); ACTS[act](); }
});

const KEY_ACTS = { KeyR: 'replay', KeyN: 'reseed', KeyB: 'back' };
window.addEventListener('keydown', (e) => {
  if (host.isOpen || $panel.dataset.mode !== 'done' || e.target instanceof HTMLInputElement) return;
  const act = KEY_ACTS[e.code];
  if (act) { readOptions(); ACTS[act](); }
});

let prev = performance.now();
function frame(now) {
  host.update((now - prev) / 1000);
  prev = now;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__sandbox = { host, run };

if (run.id) launch();
else show('pick');
