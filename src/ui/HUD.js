import * as THREE from 'three';
import { ELEMENTS, ELEMENT_ORDER, PRIMALS, PRIMAL, hex, num, clamp, esc, PLACEMENT_TEXT } from './uikit.js';
import { waveDef, TOTAL_WAVES } from '../game/Waves.js';
import { towerDef } from '../game/TowerDefs.js';
import { CREEP_TYPES } from '../game/Creeps.js';
import { BuildBar } from './BuildBar.js';
import { Picker } from './Picker.js';
import { Inspector } from './Inspector.js';
import { Threat } from './Threat.js';

/**
 * DOM overlay HUD.
 *
 * Layout contract (Art Bible G10): the interface lives on the four edges —
 * a 54px status bar at the top, a threat rail on the left, the tower
 * inspector on the right, and a shallow build dock at the bottom. The
 * playable centre of the board is never covered by resting UI; only
 * player-invoked surfaces (tower table, element picker, end card) enter it.
 *
 * Everything that changes per-frame writes through cached nodes; nothing here
 * touches innerHTML in the hot path.
 */
export class HUD {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('ui-root');
    this.root.innerHTML = TEMPLATE;

    this.$ = (sel) => this.root.querySelector(sel);
    this.nodes = {
      gold: this.$('#stat-gold'),
      lives: this.$('#stat-lives'),
      wave: this.$('#stat-wave'),
      waveTotal: this.$('#stat-wave-total'),
      score: this.$('#stat-score'),
      livesBox: this.$('#lives-box'),
      goldBox: this.$('#gold-box'),
      toast: this.$('#toast'),
      announce: this.$('#announce'),
      speed: this.$('#speed-buttons'),
      float: this.$('#float-layer'),
      endcard: this.$('#endcard'),
      elements: this.$('#owned-elements'),
      pause: this.$('#pause-btn'),
      vignette: this.$('#damage-vignette'),
      placeHint: this.$('#place-hint'),
      airAlert: this.$('#air-alert'),
      held: this.$('#held-piece'),
      best: this.$('#stat-best'),
    };

    /** Personal best, injected by main.js from local storage. */
    this.best = 0;
    /** Global top scores, injected from the server when one is reachable. */
    this.leaderboard = [];
    this._heldSig = '';

    this.build = new BuildBar(game, this.root);
    this.picker = new Picker(game, this.root);
    this.inspector = new Inspector(game, this.root);
    this.threat = new Threat(game, this.root);

    this.floats = [];
    this._v = new THREE.Vector3();
    this._toastTimer = 0;
    this._announceTimer = 0;
    this._goldShown = game.state.gold;
    this._livesShown = game.state.lives;
    this._elSig = '';

    this.#wire();
    this.refreshTop();
    this.refreshBuildBar();
  }

  #wire() {
    this.nodes.speed.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => this.game.setSpeed(Number(b.dataset.speed)));
    });
    this.nodes.pause.addEventListener('click', () => {
      this.game.state.paused = !this.game.state.paused;
      this.refreshTop();
    });
    this.$('#restart-btn').addEventListener('click', () => window.location.reload());
  }

  // ---- top bar ---------------------------------------------------------

  refreshTop() {
    const s = this.game.state;

    this.nodes.lives.textContent = Math.max(0, s.lives);
    this.nodes.livesBox.classList.toggle('critical', s.lives <= 10);
    this.nodes.wave.textContent = Math.max(1, s.wave);
    this.nodes.waveTotal.textContent = `/ ${TOTAL_WAVES}`;
    this.nodes.score.textContent = num(s.score);

    this.nodes.speed.querySelectorAll('button').forEach((b) => {
      const on = Number(b.dataset.speed) === s.speed;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    this.nodes.pause.classList.toggle('paused', s.paused);
    this.nodes.pause.innerHTML = s.paused ? '▶' : '❚❚';
    this.nodes.pause.setAttribute('aria-label', s.paused ? 'Resume' : 'Pause');

    const want = s.elements.join(',');
    if (this._elSig !== want) {
      this._elSig = want;
      const counts = new Map();
      for (const id of s.elements) counts.set(id, (counts.get(id) ?? 0) + 1);
      // The persistent 1/3 - 2/3 - 3/3 readout. The dock rail is the actionable
      // surface; this is the one that is always on screen, so the stack count is
      // legible from the top bar without opening anything.
      this.nodes.elements.innerHTML = ELEMENT_ORDER.map((id) => {
        const e = ELEMENTS[id];
        const n = counts.get(id) ?? 0;
        const ready = n >= PRIMAL.stacksRequired;
        const title = !n ? `${e.name} — not bound`
          : ready ? `${e.name} ×${n} — ${PRIMALS[id].name} unlocked`
          : `${e.name} ×${n} — ${PRIMAL.stacksRequired - n} more for ${PRIMALS[id].name}`;
        return `<span class="el-pip${n ? ' on' : ''}${ready ? ' primal-ready' : ''}" style="--c:${hex(e.color)}"
                  title="${esc(title)}" aria-label="${esc(title)}">
          ${e.glyph}${n > 1 ? `<i>${n}</i>` : ''}</span>`;
      }).join('');
    }
  }

  pulseLives() {
    const b = this.nodes.livesBox;
    b.classList.remove('hit');
    void b.offsetWidth;
    b.classList.add('hit');
    const v = this.nodes.vignette;
    v.classList.remove('flash');
    void v.offsetWidth;
    v.classList.add('flash');
  }

  // ---- build bar -------------------------------------------------------

  refreshBuildBar() { this.build.refresh(); }

  // ---- inspector -------------------------------------------------------

  openInspector(t) { this.inspector.show(t); }
  closeInspector() { this.inspector.hide(); }

  /**
   * Open the morph sheet on a tower id. The seam for the `M` hotkey: Game knows
   * tower ids and nothing about panels, Inspector knows panels and is handed
   * tower objects, so the id -> object resolution belongs here alongside
   * openInspector. Silently does nothing on a stale id or an inert block.
   */
  openMorph(id) {
    const t = this.game.towers.byId(id);
    if (t) this.inspector.showMorph(t);
  }

  // ---- element picker --------------------------------------------------

  openElementPicker() { this.picker.show(); }
  closeElementPicker() { this.picker.hide(); }

  // ---- transient messaging ---------------------------------------------

  /**
   * The placement hint that rides next to the cursor while a tower is queued.
   *
   * This exists because the only feedback for an illegal placement used to be a
   * red pad under the cursor plus a toast that appeared 250px away AFTER a click
   * was refused — so the player learned the rule by being denied, one click at a
   * time. Naming the problem before the click, at the cursor, is the whole point.
   *
   * Silent on the valid case: a hint that is always on stops being read, and the
   * green pad already says yes. `reason === null` hides it entirely.
   *
   * `label` overrides the canned headline. Only the primal commit hint uses it,
   * because that headline names an element and a stack count that PLACEMENT_TEXT
   * cannot know. It is part of the cache signature or the panel would keep the
   * first element's text after the player queues a different primal.
   */
  showPlacementHint(reason, pointer, label = null) {
    const el = this.nodes.placeHint;
    if (!reason || reason === 'valid') {
      el.classList.remove('on');
      this._hintFor = null;
      return;
    }
    const t = PLACEMENT_TEXT[reason] ?? PLACEMENT_TEXT.occupied;
    const sig = label ? `${reason}:${label}` : reason;
    if (this._hintFor !== sig) {
      this._hintFor = sig;
      el.className = `on h-${t.tone}`;
      el.innerHTML = `<b>${esc(label ?? t.label)}</b>${t.hint ? `<i>${esc(t.hint)}</i>` : ''}`;
    }
    if (pointer) {
      // Offset up-right of the cursor, then flipped near the right edge so the
      // panel never runs off screen and never sits under the cursor itself.
      const w = el.offsetWidth || 150;
      const flip = pointer.x + 22 + w > window.innerWidth;
      el.style.transform =
        `translate(${Math.round(flip ? pointer.x - 18 - w : pointer.x + 22)}px, ${Math.round(pointer.y - 14)}px)`;
    }
  }

  warn(msg, tone = 'warn') {
    this.nodes.toast.className = `t-${tone}`;
    this.nodes.toast.textContent = msg;
    this.nodes.toast.classList.add('show');
    this._toastTimer = 1.9;
  }

  announceWave(def) {
    const t = CREEP_TYPES[def.type];
    this.nodes.announce.innerHTML = `
      <span class="an-rule"></span>
      <span class="an-mid">
        <span class="an-kicker">${def.isBoss ? 'Boss wave' : 'Wave'}</span>
        <span class="an-wave">${String(def.n).padStart(2, '0')}</span>
        <span class="an-type">${def.count} × ${t.name}${t.flying ? ' · flying' : ''}</span>
      </span>
      <span class="an-rule"></span>`;
    this.nodes.announce.classList.toggle('boss', !!def.isBoss);
    this.nodes.announce.classList.remove('show');
    void this.nodes.announce.offsetWidth;
    this.nodes.announce.classList.add('show');
    this._announceTimer = 2.6;
  }

  /**
   * The standing air-wave banner. `n` is the wave that flies, or 0 to clear.
   *
   * Separate from `warn()` on purpose: a toast is a moment and this is a
   * condition. It stays up for the whole build phase, which is the window in
   * which the player can still do something about it.
   */
  setAirAlert(n) {
    const el = this.nodes.airAlert;
    if (!n) { el.classList.remove('on'); this._airFor = 0; return; }
    if (this._airFor !== n) {
      this._airFor = n;
      el.innerHTML = `<b>✈ Air wave incoming</b><i>Wave ${n} flies — make sure it is covered</i>`;
    }
    el.classList.add('on');
  }

  /** Personal best score, shown in the status bar and on the end card. */
  setBest(score) {
    this.best = Math.max(0, Math.round(score) || 0);
    this.nodes.best.textContent = this.best ? num(this.best) : '—';
  }

  /** Global top scores from the server: [{ name, score, wave }]. */
  setLeaderboard(list) {
    this.leaderboard = Array.isArray(list) ? list : [];
  }

  /**
   * "You are holding a piece" — the missing confirmation for a dock click.
   *
   * Selection used to be a 1px border change on a card at the bottom of the
   * screen while the player's eyes were on the board, so the only feedback that
   * a click registered arrived when a tower appeared (or didn't). This is a chip
   * in the player's field of view that names what is in hand and how to drop it.
   *
   * Driven from update() off game state rather than from the six call sites that
   * can change a selection, so it cannot go stale when one of them is missed.
   */
  #syncHeld() {
    const g = this.game;
    const el = this.nodes.held;
    const held = g.selectedTower !== null ? g.towers.byId(g.selectedTower) : null;
    const arming = held && held.def.kind === 'inert';
    const buildKey = g.selectedBuild;
    const sig = arming ? `arm:${held.id}` : buildKey ? `build:${buildKey}` : '';
    if (sig === this._heldSig) return;
    this._heldSig = sig;

    if (!sig) { el.classList.remove('on'); return; }
    if (arming) {
      el.style.setProperty('--c', hex(held.def.color));
      el.innerHTML = `<span class="hp-glyph">${held.def.glyph}</span>
        <span class="hp-text"><b>Foundation selected</b>
        <i>Click any tower in the bar below to arm it — discounted</i></span>`;
    } else {
      const def = towerDef(buildKey);
      if (!def) { el.classList.remove('on'); return; }
      el.style.setProperty('--c', hex(def.color));
      el.innerHTML = `<span class="hp-glyph">${def.glyph}</span>
        <span class="hp-text"><b>${esc(def.name)} in hand</b>
        <i>Click the board to place · Esc to drop</i></span>`;
    }
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  announceInterest(gold) { if (gold > 0) this.warn(`Interest banked · +${num(gold)} gold`, 'good'); }
  announceBonus(gold) { this.warn(`Early send bonus · +${num(gold)} gold`, 'good'); }

  floatText(x, y, z, text, color) {
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = text;
    el.style.color = color;
    this.nodes.float.appendChild(el);
    this.floats.push({ el, pos: new THREE.Vector3(x, y, z), life: 1.1, max: 1.1 });
    if (this.floats.length > 60) this.floats.shift().el.remove();
  }

  showEnd(won) {
    const s = this.game.state;
    // `best` is whatever was loaded at boot, so a run that beat it is a new
    // record even though the store is written by main.js after this renders.
    const record = s.score > this.best;
    const board = this.leaderboard.slice(0, 5);
    this.nodes.endcard.innerHTML = `
      <div class="end-inner ${won ? 'win' : 'lose'}">
        <span class="end-kicker">${won ? 'Convergence complete' : 'The convergence fails'}</span>
        <h1>${won ? 'The Elements Hold' : 'The Line Is Broken'}</h1>
        <p>${won ? `All ${TOTAL_WAVES} waves repelled.` : `You fell on wave ${s.wave} of ${TOTAL_WAVES}.`}</p>
        <div class="end-best ${record ? 'record' : ''}">
          ${record
            ? `<b>New personal best</b><span>${num(s.score)} · previous ${this.best ? num(this.best) : 'none'}</span>`
            : `<b>Personal best</b><span>${this.best ? num(this.best) : '—'}</span>`}
        </div>
        ${board.length ? `<div class="end-board">
          <u>Global top ${board.length}</u>
          <ol>${board.map((p) => `<li><span>${esc(String(p.name ?? '?'))}</span><b>${num(p.score)}</b><i>wave ${num(p.wave)}</i></li>`).join('')}</ol>
        </div>` : ''}
        <div class="end-stats">
          <div><b>${num(s.score)}</b><span>Score</span></div>
          <div><b>${num(s.killed)}</b><span>Kills</span></div>
          <div><b>${num(s.leaked)}</b><span>Leaked</span></div>
          <div><b>${this.game.towers.towers.length}</b><span>Towers</span></div>
          <div><b>${new Set(s.elements).size}</b><span>Elements</span></div>
        </div>
        <button id="end-again">Play again</button>
      </div>`;
    this.nodes.endcard.classList.add('show');
    this.nodes.endcard.querySelector('#end-again')
      .addEventListener('click', () => window.location.reload());
  }

  // ---- per-frame -------------------------------------------------------

  update(dt) {
    const s = this.game.state;
    this.refreshTop();
    this.refreshBuildBar();
    this.threat.update();
    this.inspector.tick();
    this.#syncHeld();

    // Gold counts up rather than jumping — the single cheapest way to make an
    // economy feel like it has weight.
    const target = Math.floor(s.gold);
    if (this._goldShown !== target) {
      const diff = target - this._goldShown;
      const step = Math.max(1, Math.abs(diff) * Math.min(1, dt * 9));
      this._goldShown += Math.sign(diff) * Math.min(Math.abs(diff), step);
      const shown = Math.round(this._goldShown);
      this.nodes.gold.textContent = num(shown);
      this.nodes.goldBox.classList.toggle('rising', diff > 0);
      this.nodes.goldBox.classList.toggle('falling', diff < 0);
    } else {
      this.nodes.goldBox.classList.remove('rising', 'falling');
    }

    const prep = s.phase === 'prep';
    this.build.setPrep(prep, prep ? Math.round(s.prepTimer * 2) : 0);

    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.nodes.toast.classList.remove('show');
    }
    if (this._announceTimer > 0) {
      this._announceTimer -= dt;
      if (this._announceTimer <= 0) this.nodes.announce.classList.remove('show');
    }

    this.#updateFloats(dt);
  }

  #updateFloats(dt) {
    const cam = this.game.camera;
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.life -= dt;
      if (f.life <= 0) { f.el.remove(); this.floats.splice(i, 1); continue; }
      f.pos.y += dt * 1.4;
      this._v.copy(f.pos).project(cam);
      const x = (this._v.x * 0.5 + 0.5) * w;
      const y = (-this._v.y * 0.5 + 0.5) * h;
      const t = f.life / f.max;
      f.el.style.transform = `translate(-50%,-50%) translate(${x}px, ${y}px) scale(${0.85 + t * 0.25})`;
      f.el.style.opacity = String(Math.min(1, t * 2.2));
      f.el.style.display = this._v.z > 1 ? 'none' : '';
    }
  }
}

const TEMPLATE = /* html */`
  <div id="float-layer"></div>
  <div id="damage-vignette" aria-hidden="true"></div>
  <div id="place-hint" role="status" aria-live="polite"></div>
  <div id="air-alert" role="status" aria-live="polite"></div>
  <div id="held-piece" role="status" aria-live="polite"></div>

  <header id="topbar">
    <div class="brand">
      <span class="brand-mark">◈</span>
      <span class="brand-name">Element<b>TD</b></span>
      <span class="brand-sub">Convergence</span>
    </div>

    <div class="stats" role="status" aria-live="off">
      <div class="stat gold" id="gold-box">
        <span class="stat-k">Gold</span>
        <b id="stat-gold" class="stat-v">0</b>
      </div>
      <div class="stat lives" id="lives-box">
        <span class="stat-k">Lives</span>
        <b id="stat-lives" class="stat-v">0</b>
      </div>
      <div class="stat">
        <span class="stat-k">Wave</span>
        <b class="stat-v"><span id="stat-wave">1</span><em id="stat-wave-total">/ 50</em></b>
      </div>
      <div class="stat">
        <span class="stat-k">Score</span>
        <b id="stat-score" class="stat-v">0</b>
      </div>
      <div class="stat best">
        <span class="stat-k">Best</span>
        <b id="stat-best" class="stat-v">—</b>
      </div>
    </div>

    <div class="controls">
      <div id="owned-elements" class="pips" aria-label="Bound elements"></div>
      <div id="speed-buttons" role="group" aria-label="Game speed">
        <button data-speed="1" class="active" aria-pressed="true">1×</button>
        <button data-speed="2" aria-pressed="false">2×</button>
        <button data-speed="3" aria-pressed="false">3×</button>
      </div>
      <button id="pause-btn" class="icon-btn" aria-label="Pause">❚❚</button>
      <button id="restart-btn" class="icon-btn" aria-label="Restart run">⟳</button>
    </div>
  </header>

  <div id="announce" aria-live="polite"></div>
  <div id="toast" role="status"></div>
  <div id="endcard"></div>
`;
