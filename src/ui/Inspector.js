/**
 * Tower inspector.
 *
 * Hierarchy: identity → the one number that matters (DPS) → the stat ledger
 * with an explicit before→after for the next upgrade → what it actually did on
 * this board → how it picks targets → what it is worth if sold.
 */

import { ECONOMY } from '../core/Config.js';
import {
  ELEMENTS, hex, num, compact, dps, dotDps, effectiveDps, specialsOf, summarise,
  TARGET_MODES, esc,
} from './uikit.js';

export class Inspector {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.tower = null;

    root.insertAdjacentHTML('beforeend',
      '<aside id="inspector" aria-live="polite" aria-hidden="true"></aside>');
    this.$el = root.querySelector('#inspector');

    this.$el.addEventListener('click', (e) => {
      const t = this.tower;
      if (!t) return;
      if (e.target.closest('.insp-close')) { this.game.selectTower(null); return; }
      if (e.target.closest('#insp-upgrade')) { this.game.upgradeTower(t.id); return; }
      if (e.target.closest('#insp-sell')) { this.game.sellTower(t.id); return; }
      const conv = e.target.closest('[data-convert]');
      if (conv && !conv.disabled) { this.game.convertTower(t.id, conv.dataset.convert); return; }
      const mode = e.target.closest('[data-mode]');
      if (mode) {
        t.mode = mode.dataset.mode;
        this.$el.querySelectorAll('[data-mode]').forEach((b) => {
          const on = b.dataset.mode === t.mode;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', String(on));
        });
      }
    });
  }

  show(t) {
    this.tower = t;
    // A foundation has no element, no weapon and no upgrade ladder, so the
    // normal panel cannot render it at all: the lineage line would dereference
    // ELEMENTS[null] and the hero number is 0/0. It gets its own panel, whose
    // job is the one decision a foundation offers — what to turn it into.
    if (t.def.kind === 'inert') return this.#showFoundation(t);

    const def = t.def;
    const s = def.levels[t.level];
    const next = def.levels[t.level + 1];
    const maxed = !next;

    let spent = 0;
    for (let l = 0; l <= t.level; l++) spent += def.levels[l].cost;
    const refund = Math.floor(spent * ECONOMY.sellRefund);

    // Share of the board's damage — the single most useful "is this tower
    // pulling its weight" number, and nothing else in the game shows it.
    const total = this.game.towers.towers.reduce((a, x) => a + (x.totalDamage || 0), 0);
    const share = total > 0 ? (t.totalDamage / total) * 100 : 0;

    const parts = def.kind === 'dual' ? def.parts : [def.element];
    const lineage = parts.map((p) =>
      `<em style="color:${hex(ELEMENTS[p].color)}">${ELEMENTS[p].glyph} ${ELEMENTS[p].name}</em>`).join('<s>+</s>');

    const pips = def.levels.map((_, i) =>
      `<i class="${i <= t.level ? 'on' : ''}"></i>`).join('');

    const row = (label, cur, nxt, hint, better) => {
      const delta = nxt != null && nxt !== cur;
      return `<div class="ir"${hint ? ` title="${esc(hint)}"` : ''}>
        <span class="ir-k">${label}</span>
        <b class="ir-v">${cur}</b>
        ${delta ? `<span class="ir-d ${better === false ? 'down' : 'up'}">→ ${nxt}</span>` : '<span class="ir-d"></span>'}
      </div>`;
    };

    const dotNow = dotDps(s);
    const dotNext = next ? dotDps(next) : 0;

    this.$el.innerHTML = /* html */`
      <header class="insp-head" style="--c:${hex(def.color)};--a:${hex(def.accent)}">
        <span class="insp-glyph">${def.kind === 'dual' ? '◆' : def.glyph}</span>
        <div class="insp-id">
          <b>${esc(def.name)}</b>
          <span class="insp-lineage">${lineage}</span>
        </div>
        <button class="insp-close" aria-label="Close (Esc)">✕</button>
      </header>

      <div class="insp-hero" style="--c:${hex(def.color)}">
        <div class="ih-main">
          <b>${num(dps(s))}</b><u>DPS</u>
          ${next ? `<span class="ih-next">→ ${num(dps(next))}</span>` : '<span class="ih-max">MAX</span>'}
        </div>
        <div class="ih-sub">${num(s.damage)} × ${(1 / s.cooldown).toFixed(2)}/s${dotNow ? ` &nbsp;·&nbsp; +${num(dotNow)}/s over time` : ''}</div>
        <div class="ih-level"><span class="insp-pips">${pips}</span><i>Level ${t.level + 1} of ${def.levels.length}</i></div>
      </div>

      <div class="insp-rows">
        ${row('Damage', num(s.damage), next && num(next.damage), 'Damage per projectile, before armour.')}
        ${row('Fire rate', `${(1 / s.cooldown).toFixed(2)}/s`, next && `${(1 / next.cooldown).toFixed(2)}/s`, `One shot every ${s.cooldown.toFixed(2)}s.`)}
        ${row('Range', s.range.toFixed(1), next && next.range.toFixed(1), 'Radius in world units — about 2.5 grid cells per 10.')}
        ${row('Effective', num(effectiveDps(s)), next && num(effectiveDps(next)), 'Direct DPS plus sustained damage over time, splash and chain value.')}
        ${dotNow || dotNext ? row('Over time', `${num(dotNow)}/s`, next && `${num(dotNext)}/s`, 'Burn and poison ticking on the target after the hit.') : ''}
      </div>

      ${(() => {
        const sp = specialsOf(s);
        return sp.length ? `<div class="insp-specials">${sp.map((x) =>
          `<span class="sp sp-${x.k}"><b>${x.label}</b>${x.value}</span>`).join('')}</div>` : '';
      })()}

      <div class="insp-section">
        <div class="insp-legend">Targeting</div>
        <div class="seg" role="radiogroup" aria-label="Targeting priority">
          ${TARGET_MODES.map((m) => `
            <button data-mode="${m.id}" role="radio" class="${(t.mode || 'first') === m.id ? 'on' : ''}"
              aria-checked="${(t.mode || 'first') === m.id}" title="${esc(m.hint)}">${m.label}</button>`).join('')}
        </div>
      </div>

      <div class="insp-section">
        <div class="insp-legend">Contribution</div>
        <div class="insp-contrib">
          <div><b>${compact(t.totalDamage || 0)}</b><u>damage</u></div>
          <div><b>${num(t.kills || 0)}</b><u>kills</u></div>
          <div><b>${share.toFixed(share >= 10 ? 0 : 1)}%</b><u>of board</u></div>
        </div>
        <div class="insp-meter"><i style="width:${Math.min(100, share).toFixed(1)}%;background:${hex(def.color)}"></i></div>
      </div>

      <footer class="insp-actions">
        <button id="insp-upgrade" class="primary" ${maxed ? 'disabled' : ''}>
          ${maxed ? 'Fully forged' : `<span>Upgrade</span><em>${num(next.cost)}</em>`}
          ${maxed ? '' : '<kbd>U</kbd>'}
        </button>
        <button id="insp-sell" class="ghost"><span>Sell</span><em>+${num(refund)}</em><kbd>X</kbd></button>
      </footer>`;

    this.$el.classList.add('open');
    this.$el.setAttribute('aria-hidden', 'false');
    this.tick();
  }

  /**
   * The foundation panel: what this block is, and every tower it can become.
   *
   * The conversion list is the feature's whole payoff, so it shows the DIFFERENCE
   * you pay, not the tower's sticker price — the foundation's cost is credited in
   * full (see Game.convertTower), and showing 60 next to a block you already paid
   * 20 for would read as being charged twice.
   */
  #showFoundation(t) {
    const def = t.def;
    const g = this.game;
    const refund = Math.floor(def.levels[0].cost * ECONOMY.sellRefund);
    const options = g.availableTowers;

    const opt = (d) => {
      const cost = g.convertCost(d.key);
      const poor = g.state.gold < cost;
      const parts = d.kind === 'dual' ? d.parts : [d.element];
      const glyphs = parts.map((p) =>
        `<b style="color:${hex(ELEMENTS[p].color)}">${ELEMENTS[p].glyph}</b>`).join('');
      return `<button class="arm-opt${poor ? ' poor' : ''}" data-convert="${d.key}"
          style="--c:${hex(d.color)}" ${poor ? 'disabled' : ''}
          title="${esc(d.name)} — ${poor ? `needs ${num(cost - Math.floor(g.state.gold))} more gold` : `${num(cost)} gold`}">
        <span class="ao-glyph">${glyphs}</span>
        <span class="ao-name">${esc(d.name.replace(' Tower', ''))}</span>
        <span class="ao-cost">${num(cost)}</span>
      </button>`;
    };

    this.$el.innerHTML = /* html */`
      <header class="insp-head" style="--c:${hex(def.color)};--a:${hex(def.accent)}">
        <span class="insp-glyph">${def.glyph}</span>
        <div class="insp-id">
          <b>${esc(def.name)}</b>
          <span class="insp-lineage"><em>Groundwork · unarmed</em></span>
        </div>
        <button class="insp-close" aria-label="Close (Esc)">✕</button>
      </header>

      <div class="insp-inert">
        <p>${esc(def.tagline)}</p>
        <p class="ii-note">It blocks the creep route exactly like a tower, and it
        shoots nothing. Arm it whenever you like — the ${num(def.levels[0].cost)}
        gold you spent here comes off the price.</p>
      </div>

      <div class="insp-section">
        <div class="insp-legend">Arm with</div>
        ${options.length
          ? `<div class="insp-arm">${options.map(opt).join('')}</div>`
          : '<p class="ii-empty">No element bound yet. Clear a wave to earn your first pick.</p>'}
      </div>

      <footer class="insp-actions">
        <button id="insp-sell" class="ghost"><span>Sell</span><em>+${num(refund)}</em><kbd>X</kbd></button>
      </footer>`;

    this.$el.classList.add('open');
    this.$el.setAttribute('aria-hidden', 'false');
  }

  hide() {
    this.tower = null;
    this.$el.classList.remove('open');
    this.$el.setAttribute('aria-hidden', 'true');
  }

  /** Cheap per-frame: keep upgrade affordability honest as gold moves. */
  tick() {
    const t = this.tower;
    if (!t || !this.$el.classList.contains('open')) return;

    // A foundation has no upgrade button; what has to stay honest is which of
    // its arm options you can currently pay for. Without this the buttons keep
    // whatever affordability they had when the panel opened, so a player who
    // banks the gold while watching the panel sees the option stay greyed out.
    if (t.def.kind === 'inert') {
      const gold = this.game.state.gold;
      for (const b of this.$el.querySelectorAll('[data-convert]')) {
        const cost = this.game.convertCost(b.dataset.convert);
        const poor = gold < cost;
        b.classList.toggle('poor', poor);
        b.disabled = poor;
      }
      return;
    }

    const next = t.def.levels[t.level + 1];
    const btn = this.$el.querySelector('#insp-upgrade');
    if (!btn || !next) return;
    const poor = this.game.state.gold < next.cost;
    btn.classList.toggle('poor', poor);
    btn.title = poor ? `Needs ${num(next.cost - this.game.state.gold)} more gold` : '';
  }
}
