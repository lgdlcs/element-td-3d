/**
 * Build dock + Fusion Codex.
 *
 * The 21-tower problem is solved by refusing to make it a list at all:
 *
 *  - The always-visible dock carries only the towers you can act on right now:
 *    your ≤6 elemental towers (one per element you own) plus up to four
 *    *affordable* fusions, on a single shallow row.
 *  - Everything else lives in the Fusion Codex — a 6×6 element matrix where the
 *    diagonal is the six elemental towers and the upper triangle is all fifteen
 *    fusions. It is a chart, not a row: you read a tower's identity from its
 *    coordinates, and locked cells tell you exactly which element you are
 *    missing. Two dimensions, twenty-one cells, no scrolling.
 */

import {
  ELEMENTS, ELEMENT_ORDER, PRIMALS, PRIMAL, PURE_TOWERS, TOWER_COLUMNS, TOWER_TOTAL,
  lockState, countElements,
  hex, num, dps, dotDps, specialsOf, summarise, esc,
} from './uikit.js';
import { isTypingTarget } from '../util/dom.js';
import { towerDef as towerDefOf, FOUNDATION } from '../game/TowerDefs.js';

const HOTKEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY'];
const HOTKEY_LABEL = ['Q', 'W', 'E', 'R', 'T', 'Y'];
// 18, not 15: Judgement reaches 17.5 and its ring would otherwise be drawn
// outside the tooltip SVG's viewBox.
const MAX_RANGE = 18;
let UID = 0;

export class BuildBar {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.codexOpen = false;
    this._sig = '';
    this._goldSig = -1;

    root.insertAdjacentHTML('beforeend', /* html */`
      <section id="codex" aria-hidden="true" aria-label="Tower table">
        <div class="codex-head">
          <div>
            <h3>Tower Table</h3>
            <p>All twenty-seven towers, filed under the element they damage with. Plan your picks here.</p>
          </div>
          <button class="codex-close" aria-label="Close tower table (Escape)">✕</button>
        </div>
        <div class="codex-grid" id="codex-grid"></div>
        <div class="codex-foot">
          <span><i class="key-dot afford"></i>buildable now</span>
          <span><i class="key-dot poor"></i>unlocked, too costly</span>
          <span><i class="key-dot lock"></i>element not bound</span>
        </div>
      </section>

      <footer id="dock" role="toolbar" aria-label="Build towers">
        <div class="dock-group" id="dock-base-group">
          <span class="dock-label">Groundwork</span>
          <div class="dock-rail" id="dock-base"></div>
        </div>
        <div class="dock-rule"></div>
        <div class="dock-group" id="dock-pure-group">
          <span class="dock-label">Elemental</span>
          <div class="dock-rail" id="dock-pure"></div>
        </div>
        <div class="dock-rule"></div>
        <div class="dock-group" id="dock-fusion-group">
          <span class="dock-label">Fusion</span>
          <div class="dock-rail" id="dock-fusion"></div>
        </div>
        <div class="dock-rule"></div>
        <div class="dock-group" id="dock-primal-group">
          <span class="dock-label">Primal</span>
          <div class="dock-rail" id="dock-primal"></div>
        </div>
        <div class="dock-rule"></div>
        <button id="codex-toggle" aria-expanded="false" aria-controls="codex" aria-keyshortcuts="F">
          <span class="ct-mark">▤</span>
          <span class="ct-text"><b>Tower Table</b><i id="ct-count">0 of ${TOWER_TOTAL}</i></span>
          <kbd>F</kbd>
        </button>
        <button id="send-wave" class="primary" aria-keyshortcuts="Space">
          <span class="sw-label">Send wave</span>
          <span class="sw-bonus" id="sw-bonus"></span>
          <kbd>Space</kbd>
        </button>
      </footer>
    `);

    this.$dock = root.querySelector('#dock');
    this.$base = root.querySelector('#dock-base');
    this.$pure = root.querySelector('#dock-pure');
    this.$fusion = root.querySelector('#dock-fusion');
    this.$fusionGroup = root.querySelector('#dock-fusion-group');
    this.$primal = root.querySelector('#dock-primal');
    this.$primalGroup = root.querySelector('#dock-primal-group');
    this.$toggle = root.querySelector('#codex-toggle');
    this.$count = root.querySelector('#ct-count');
    this.$codex = root.querySelector('#codex');
    this.$grid = root.querySelector('#codex-grid');
    this.$send = root.querySelector('#send-wave');
    this.$bonus = root.querySelector('#sw-bonus');

    this.$toggle.addEventListener('click', () => this.toggleCodex());
    this.$codex.querySelector('.codex-close').addEventListener('click', () => this.setCodex(false));
    this.$send.addEventListener('click', () => this.game.startWaveNow());

    // Delegated: cards are re-rendered often, listeners are not.
    const pick = (e) => {
      const card = e.target.closest('[data-tower]');
      if (!card || card.classList.contains('locked')) return;
      const key = card.dataset.tower;
      // ARMING MODE. With a foundation selected on the board, a dock click is
      // "turn that block into this" rather than "queue a new build" — the
      // discounted price the cards are already showing is the one charged.
      // The foundation card itself is exempt: clicking it means you want to lay
      // another block, so it falls through to a normal selection.
      const held = this.game.heldFoundation;
      if (held && key !== FOUNDATION.key) {
        this.game.convertTower(held.id, key);
        if (this.codexOpen) this.setCodex(false);
        return;
      }
      this.game.setBuildSelection(this.game.selectedBuild === key ? null : key);
      if (this.codexOpen) this.setCodex(false);
    };
    this.$dock.addEventListener('click', pick);
    this.$grid.addEventListener('click', pick);

    // One shared tooltip node, positioned and clamped to the viewport on
    // demand. Beats 21 pre-rendered popovers that each clip at a screen edge.
    this.$tip = document.createElement('div');
    this.$tip.id = 'tip';
    this.$tip.setAttribute('role', 'tooltip');
    root.appendChild(this.$tip);
    this._tipFor = null;

    const enter = (e) => {
      const card = e.target.closest?.('[data-tower]');
      if (card) this.#showTip(card);
      else if (!this.$tip.contains(e.target)) this.#hideTip();
    };
    for (const host of [this.$dock, this.$grid]) {
      host.addEventListener('pointerover', enter);
      host.addEventListener('pointerleave', () => this.#hideTip());
      host.addEventListener('focusin', enter);
      host.addEventListener('focusout', () => this.#hideTip());
    }

    window.addEventListener('keydown', (e) => this.#onKey(e));
    document.addEventListener('pointerdown', (e) => {
      if (!this.codexOpen) return;
      if (this.$codex.contains(e.target) || this.$toggle.contains(e.target)) return;
      this.setCodex(false);
    }, true);
  }

  #onKey(e) {
    if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyF') { e.preventDefault(); this.toggleCodex(); return; }
    // Consumed, like HUD.setHelp's Escape: one press closes the panel you are
    // reading, the next drops the piece in hand. Letting it through to Game's
    // switch as well made a single Escape do two things the UI advertised
    // separately.
    if (e.code === 'Escape' && this.codexOpen) {
      // stopImmediatePropagation for the same reason as HUD's — Game.js listens
      // on the same target, and stopPropagation does not stop a sibling listener.
      e.preventDefault(); e.stopImmediatePropagation();
      this.setCodex(false);
      return;
    }
    if (e.code === 'KeyB') {
      e.preventDefault();
      const k = FOUNDATION.key;
      this.game.setBuildSelection(this.game.selectedBuild === k ? null : k);
      return;
    }
    const i = HOTKEYS.indexOf(e.code);
    if (i >= 0) {
      const id = ELEMENT_ORDER[i];
      if (!this.game.state.elements.includes(id)) return;
      e.preventDefault();
      // Same rule as a dock click while a foundation is selected — the hotkeys
      // are the dock, and having them disagree would be a trap.
      const held = this.game.heldFoundation;
      if (held) { this.game.convertTower(held.id, id); return; }
      this.game.setBuildSelection(this.game.selectedBuild === id ? null : id);
    }
  }

  // -- codex ---------------------------------------------------------------

  toggleCodex() { this.setCodex(!this.codexOpen); }

  setCodex(open) {
    // Both are full-bleed reference surfaces; whichever the player just asked
    // for is the one that stays. HUD.setHelp closes the codex on the way in for
    // the same reason, so the pair can never both be up.
    if (open) this.game.hud?.closeHelp?.();
    this.codexOpen = open;
    this.$codex.classList.toggle('open', open);
    this.$codex.setAttribute('aria-hidden', String(!open));
    this.$toggle.setAttribute('aria-expanded', String(open));
    this.$toggle.classList.toggle('active', open);
    // The table is a full-width plate; the side rails step out of its way so
    // it never has to fight them for space on a short or narrow screen.
    document.body.classList.toggle('codex-open', open);
    if (open) this.#renderCodex();
  }

  #renderCodex() {
    // Counts, not a Set: a primal cell is gated on holding three of an element
    // and a Set collapses three Fires to one, which would lock every primal in
    // the table forever.
    const counts = countElements(this.game.state.elements);
    const gold = this.game.state.gold;
    // The table is clickable and shares the dock's click handler, so it has to
    // quote the same price the click will charge.
    const arming = !!this.game.heldFoundation;

    this.$grid.innerHTML = TOWER_COLUMNS.map((col) => {
      const e = col.element;
      const n = counts.get(col.id) ?? 0;
      return `<div class="cx-col${n ? ' on' : ''}" style="--c:${hex(e.color)};--a:${hex(e.accent)}">
        <div class="cx-col-head">
          <span class="cx-orb">${e.glyph}</span>
          <b>${e.name}</b>
          <i>${n ? `bound ×${n}` : 'not bound'}</i>
        </div>
        <div class="cx-tier">Elemental</div>
        ${this.#cell(col.pure, counts, gold, arming)}
        <div class="cx-tier">Fusion</div>
        ${col.fusions.map((f) => this.#cell(f, counts, gold, arming)).join('')}
        <div class="cx-tier">Primal</div>
        ${this.#cell(col.primal, counts, gold, arming)}
      </div>`;
    }).join('');
  }

  #cell(def, counts, gold, arming = false) {
    const { parts, missing, unlocked, have, need } = lockState(def, counts);
    const cost = arming ? this.game.convertCost(def.key) : def.levels[0].cost;
    const afford = unlocked && gold >= cost;
    const cls = ['cx-cell', def.kind];
    if (!unlocked) cls.push('locked');
    else if (afford) cls.push('afford');
    else cls.push('poor');
    if (this.game.selectedBuild === def.key) cls.push('selected');

    const name = def.name.replace(' Tower', '');
    const glyphs = parts.map((p) =>
      `<b class="${counts.has(p) ? 'have' : ''}" style="color:${hex(ELEMENTS[p].color)}">${ELEMENTS[p].glyph}</b>`).join('');

    // A locked primal is not missing an element — it is missing STACKS of one it
    // may well already hold, so "needs Fire" would be a lie to a player looking
    // at their own Fire tower. It gets the progress fraction instead.
    const why = unlocked ? `${num(cost)} gold`
      : def.kind === 'primal' ? `${have} of ${need} ${ELEMENTS[def.element].name} bound`
      : `needs ${missing.map((m) => ELEMENTS[m].name).join(' + ')}`;

    return `<button class="${cls.join(' ')}" data-tower="${def.key}" data-cost="${cost}"
        style="--c:${hex(def.color)}" ${unlocked ? '' : 'aria-disabled="true" tabindex="-1"'}
        title="${esc(name)} — ${esc(why)}">
      <span class="cx-pair">${glyphs}</span>
      <span class="cx-name">${name}</span>
      <span class="cx-cost">${unlocked ? num(cost)
        : def.kind === 'primal' ? `${have} / ${need}` : `<s>${num(cost)}</s>`}</span>
    </button>`;
  }

  // -- dock ----------------------------------------------------------------

  refresh() {
    const st = this.game.state;
    const owned = st.elements;
    const all = this.game.availableTowers;
    const fusions = all.filter((t) => t.kind === 'dual');

    // Progress cards: an element you are ONE pick away from turning into a
    // primal. Below stacksRequired - 1 we show nothing — six permanently-dead
    // cards would teach the player to ignore the whole rail, which is the
    // opposite of the point.
    const counts = countElements(owned);
    const pending = ELEMENT_ORDER.filter((id) => (counts.get(id) ?? 0) === PRIMAL.stacksRequired - 1);

    // Capped at four, exactly like the fusion rail, and for a harder reason: the
    // dock is a single row with a max-width, and six primal cards on top of six
    // elemental and four fusion ones pushes the Tower Table and Send Wave
    // buttons off the right edge at 1600px. Eleven picks make three primals the
    // realistic ceiling anyway, so the cap only fires in a debug board.
    const primals = all
      .filter((t) => t.kind === 'primal')
      .sort((a, b) => (st.gold >= a.levels[0].cost ? 0 : 1) - (st.gold >= b.levels[0].cost ? 0 : 1))
      .slice(0, 4);
    const progress = pending.slice(0, Math.max(0, 4 - primals.length));

    // Dock fusion slots: affordable first, then the priciest — i.e. aspiration.
    const slots = fusions
      .slice()
      .sort((a, b) => {
        const aa = st.gold >= a.levels[0].cost ? 0 : 1;
        const bb = st.gold >= b.levels[0].cost ? 0 : 1;
        return aa - bb || b.levels[0].cost - a.levels[0].cost;
      })
      .slice(0, 4);

    // Arming re-prices every card, so it has to be part of the render signature
    // or the dock would keep showing build prices while charging arming ones.
    const arming = !!this.game.heldFoundation;
    this.$dock.classList.toggle('arming', arming);

    const sig = `${owned.join(',')}|${slots.map((s) => s.key).join(',')}`
      + `|${primals.map((p) => p.key).join(',')}|${progress.join(',')}|${arming ? 'arm' : ''}`;
    if (sig !== this._sig) {
      this._sig = sig;
      // The foundation never changes and never locks — it is the one thing you
      // can always build, including on wave 1 before any element is bound, which
      // is also what stops the dock booting as an empty row telling you to go
      // away and choose something.
      this.$base.innerHTML = this.#card(FOUNDATION, 'B', false);
      this.$pure.innerHTML = ELEMENT_ORDER
        .map((id, i) => (owned.includes(id) ? this.#card(PURE_TOWERS[id], HOTKEY_LABEL[i], arming) : ''))
        .join('') || '<span class="dock-empty">choose an element to begin</span>';
      this.$fusion.innerHTML = slots.map((d) => this.#card(d, null, arming)).join('')
        || `<span class="dock-empty">${owned.length < 2 ? 'two elements unlock a fusion' : 'saving up…'}</span>`;
      this.$fusionGroup.classList.toggle('empty', slots.length === 0);
      this.$primal.innerHTML =
        primals.map((d) => this.#card(d, null, arming)).join('')
        + progress.map((id) => this.#progressCard(id, counts.get(id))).join('')
        || '<span class="dock-empty">bind one element three times</span>';
      this.$primalGroup.classList.toggle('empty', primals.length === 0 && progress.length === 0);
      if (this.codexOpen) this.#renderCodex();
    }

    // Cheap per-frame restyle: affordability + selection, dock and codex both.
    const g = Math.floor(st.gold);
    const sel = this.game.selectedBuild;
    if (g !== this._goldSig || sel !== this._selSig) {
      this._goldSig = g;
      this._selSig = sel;
      const scope = this.codexOpen ? this.root : this.$dock;
      for (const el of scope.querySelectorAll('[data-tower][data-cost]')) {
        const on = sel === el.dataset.tower;
        if (!el.classList.contains('locked')) {
          const poor = st.gold < Number(el.dataset.cost);
          el.classList.toggle('poor', poor);
          el.classList.toggle('afford', !poor && el.classList.contains('cx-cell'));
        }
        el.classList.toggle('selected', on);
        el.setAttribute('aria-pressed', String(on));
      }
    }

    this.$count.textContent = `${all.length} of ${TOWER_TOTAL} unlocked`;
  }

  #card(def, key, arming = false) {
    const lv = def.levels[0];
    // While arming, the number on the card is what the click will actually cost.
    const cost = arming ? this.game.convertCost(def.key) : lv.cost;
    const parts = def.kind === 'dual' ? def.parts : [def.element];
    const glyph = def.kind === 'dual'
      ? parts.map((p) => `<b style="color:${hex(ELEMENTS[p].color)}">${ELEMENTS[p].glyph}</b>`).join('<s>+</s>')
      : `<b>${def.glyph}</b>`;

    return `<button class="tcard ${def.kind}${arming ? ' arm' : ''}" data-tower="${def.key}" data-cost="${cost}"
        style="--c:${hex(def.color)};--a:${hex(def.accent)}" aria-pressed="false">
      <span class="tc-glyph">${glyph}</span>
      <span class="tc-name">${def.name.replace(' Tower', '')}</span>
      <span class="tc-cost">${num(cost)}</span>
      ${def.kind === 'primal'
        ? `<span class="tc-stacks" title="Spends ${PRIMAL.stacksConsumed} of your ${PRIMAL.stacksRequired} ${ELEMENTS[def.element].name} stacks — returned in full if you sell"
             >−${ELEMENTS[def.element].glyph.repeat(PRIMAL.stacksConsumed)}</span>`
        : ''}
      ${key ? `<kbd class="tc-key">${key}</kbd>` : ''}
    </button>`;
  }

  /**
   * A primal you are one bind away from. Not clickable and deliberately not a
   * `[data-tower]` node, so it can never enter the delegated pick handler or the
   * per-frame affordability sweep — there is no price to be poor for.
   */
  #progressCard(id, have) {
    const e = ELEMENTS[id];
    const p = PRIMALS[id];
    const pips = Array.from({ length: PRIMAL.stacksRequired },
      (_, i) => `<i class="${i < have ? 'on' : ''}"></i>`).join('');
    return `<button class="tcard primal locked" data-progress="${id}" aria-disabled="true" tabindex="-1"
        style="--c:${hex(e.color)};--a:${hex(e.accent)}"
        title="${esc(p.name)} — bind one more ${e.name} to unlock">
      <span class="tc-glyph"><b>${e.glyph}</b></span>
      <span class="tc-name">${esc(p.name)}</span>
      <span class="tc-prog">${pips}</span>
      <span class="tc-cost">${have} / ${PRIMAL.stacksRequired}</span>
    </button>`;
  }

  #showTip(card) {
    const key = card.dataset.tower;
    if (this._tipFor === card) return;
    this._tipFor = card;

    const def = towerDefOf(key);
    if (!def) return;
    // Counts, not a Set — lockState needs them to resolve a primal.
    const { missing, have } = lockState(def, this.game.state.elements);

    this.$tip.style.setProperty('--c', hex(def.color));
    this.$tip.innerHTML = this.#tip(def, missing, have);
    this.$tip.classList.add('on');

    // Measure, then clamp horizontally to the viewport and flip vertically if
    // there is not enough room above the card.
    const r = card.getBoundingClientRect();
    const t = this.$tip.getBoundingClientRect();
    const m = 10;
    const x = Math.min(Math.max(m, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - m);
    const above = r.top - t.height - 12;
    const y = above >= m ? above : Math.min(r.bottom + 12, window.innerHeight - t.height - m);
    this.$tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.$tip.classList.toggle('below', above < m);
    // Arrow tracks the card even when the panel has been pushed off-centre.
    this.$tip.style.setProperty('--arrow', `${Math.round(r.left + r.width / 2 - x)}px`);
  }

  #hideTip() {
    this._tipFor = null;
    this.$tip.classList.remove('on');
  }

  #tip(def, missing = [], have = 0) {
    // The foundation has no weapon, so every stat the normal panel shows is
    // either zero or a division by zero (dps = damage / cooldown = 0 / 0). It
    // gets a panel about what it is FOR instead — which is the information the
    // player actually needs, since nothing else on the dock is a wall.
    if (def.kind === 'inert') {
      return /* html */`
        <span class="tip-head">
          <span class="tip-title">${def.name}</span>
          <span class="tip-kind">Groundwork · no weapon</span>
        </span>
        <span class="tip-lore">${esc(def.tagline)}</span>
        <span class="tip-specials">
          <i class="sp"><b>Blocks</b> shapes the creep route like any tower</i>
          <i class="sp"><b>${num(def.levels[0].cost)} gold</b> the cheapest thing on the board</i>
          <i class="sp"><b>Refunded in full</b> when you arm it with an element</i>
        </span>
        <span class="tip-foot">
          <i>select it, then click the block to choose an element</i>
        </span>`;
    }

    const lv = def.levels[0];
    const top = def.levels[def.levels.length - 1];
    const parts = def.kind === 'dual' ? def.parts : [def.element];
    const uid = `rg${++UID}`;
    const kindLine = def.kind === 'dual'
      ? parts.map((p) => `<em style="color:${hex(ELEMENTS[p].color)}">${ELEMENTS[p].name}</em>`).join(' <s>+</s> ')
      : `<em style="color:${hex(def.color)}">${ELEMENTS[def.element].name}</em> · ${ELEMENTS[def.element].role}`;

    const specials = specialsOf(lv);
    // Top-down footprint diagram: 4-unit grid cells, the tower's 2×2 pad, and
    // the range ring drawn to the same scale — so "10.5" means something.
    const px = 44 / MAX_RANGE;               // world units → svg px
    const rp = (lv.range * px).toFixed(1);
    const cell = (4 * px).toFixed(2);
    const splashR = lv.splash ? (lv.splash.radius * px).toFixed(1) : 0;

    return /* html */`
      <span class="tip-head">
        <span class="tip-title">${def.name}</span>
        <span class="tip-kind">${kindLine}</span>
      </span>
      ${missing.length && def.kind !== 'primal'
        ? `<span class="tip-locked">Requires ${missing.map((m) =>
            `<b style="color:${hex(ELEMENTS[m].color)}">${ELEMENTS[m].glyph} ${ELEMENTS[m].name}</b>`).join(' and ')}</span>`
        : ''}
      ${def.kind === 'primal'
        ? `<span class="tip-locked tip-stacks">${missing.length
            ? `Bind <b style="color:${hex(def.color)}">${PRIMAL.stacksRequired - have} more ${ELEMENTS[def.element].name}</b>
               (${have} of ${PRIMAL.stacksRequired}). `
            : ''}Spends <b style="color:${hex(def.color)}">${PRIMAL.stacksConsumed} ${ELEMENTS[def.element].name}</b> stacks.
            The Primal re-locks until you bind ${ELEMENTS[def.element].name} again. Selling returns both.</span>`
        : ''}
      <span class="tip-lore">${summarise(def)}</span>
      <span class="tip-body">
        <span class="tip-stats">
          <i><u>DPS</u><b>${num(dps(lv))}</b></i>
          <i><u>Damage</u><b>${num(lv.damage)}</b></i>
          <i><u>Rate</u><b>${(1 / lv.cooldown).toFixed(2)}/s</b></i>
          <i><u>Range</u><b>${lv.range.toFixed(1)}</b></i>
        </span>
        <svg class="tip-preview" viewBox="0 0 104 116" aria-hidden="true">
          <defs>
            <radialGradient id="${uid}">
              <stop offset="30%" stop-color="var(--c)" stop-opacity="0.22"/>
              <stop offset="100%" stop-color="var(--c)" stop-opacity="0.02"/>
            </radialGradient>
            <pattern id="g${uid}" width="${cell}" height="${cell}" patternUnits="userSpaceOnUse">
              <path d="M ${cell} 0 L 0 0 0 ${cell}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="0.6"/>
            </pattern>
            <clipPath id="c${uid}"><circle cx="52" cy="50" r="${rp}"/></clipPath>
          </defs>
          <rect x="0" y="0" width="104" height="100" fill="url(#g${uid})"/>
          <circle cx="52" cy="50" r="46" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="0.7"/>
          <circle cx="52" cy="50" r="${rp}" fill="url(#${uid})"/>
          <circle cx="52" cy="50" r="${rp}" fill="none" stroke="var(--c)" stroke-opacity="0.85" stroke-width="1.2" stroke-dasharray="3 3"/>
          ${splashR ? `<circle cx="52" cy="50" r="${splashR}" fill="var(--c)" fill-opacity="0.16" stroke="var(--c)" stroke-opacity="0.4" stroke-width="0.8"/>` : ''}
          <rect x="${52 - 2 * px}" y="${50 - 2 * px}" width="${4 * px}" height="${4 * px}" rx="1.5"
                fill="var(--c)" fill-opacity="0.95" stroke="rgba(255,255,255,0.45)" stroke-width="0.6"/>
          <text x="52" y="110" text-anchor="middle" class="tp-cap">
            <tspan>${lv.range.toFixed(1)} range</tspan>${splashR
              ? `<tspan x="52" dy="-9" class="tp-cap2">${lv.splash.radius.toFixed(1)} splash</tspan>` : ''}
          </text>
        </svg>
      </span>
      ${specials.length ? `<span class="tip-specials">${specials.map((s) =>
        `<i class="sp sp-${s.k}"><b>${s.label}</b> ${s.value}</i>`).join('')}</span>` : ''}
      <span class="tip-foot">
        <i>${def.levels.length} levels</i>
        <i>max ${num(dps(top))} DPS${dotDps(top) ? ` · +${num(dotDps(top))}/s DoT` : ''}</i>
        <i>${num(def.levels.reduce((a, l) => a + l.cost, 0))} fully forged</i>
      </span>`;
  }

  /** Prep-phase send button + early bonus readout. */
  setPrep(active, bonus) {
    this.$send.classList.toggle('show', active);
    this.$send.disabled = !active;
    this.$bonus.textContent = active && bonus > 0 ? `+${num(bonus)}` : '';
  }
}
