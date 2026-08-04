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
    /** 'tower' | 'inert' | 'morph' — which body is currently rendered. */
    this.view = 'tower';
    /** Effective DPS of the tower the open morph sheet belongs to. */
    this._morphNow = 0;

    root.insertAdjacentHTML('beforeend',
      '<aside id="inspector" aria-live="polite" aria-hidden="true"></aside>');
    this.$el = root.querySelector('#inspector');

    this.$el.addEventListener('click', (e) => {
      const t = this.tower;
      if (!t) return;
      if (e.target.closest('.insp-close')) { this.game.selectTower(null); return; }
      if (e.target.closest('.morph-back')) { this.show(t); return; }
      if (e.target.closest('#insp-morph')) { this.showMorph(t); return; }
      if (e.target.closest('#insp-upgrade')) { this.game.upgradeTower(t.id); return; }
      if (e.target.closest('#insp-sell')) { this.game.sellTower(t.id); return; }
      const conv = e.target.closest('[data-convert]');
      if (conv && !conv.disabled) { this.game.convertTower(t.id, conv.dataset.convert); return; }
      // Deliberately not gated on the card's own state: morphTower re-checks the
      // phase, the unlock and the gold and warns with the exact reason. Swallowing
      // the click here would turn an unaffordable card into a button that does
      // nothing and explains nothing.
      const m = e.target.closest('[data-morph]');
      if (m) { this.game.morphTower(t.id, m.dataset.morph); return; }
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

    /**
     * The sticky comparison strip. Twenty morph targets cannot each carry a
     * before/after DPS pair without turning the panel into a spreadsheet, so
     * exactly one number tracks the cursor instead: you sweep the grid and read
     * a single figure. `pointerover` bubbles (unlike pointerenter), so one
     * delegated listener covers every card and survives every re-render.
     */
    const preview = (e) => {
      if (this.view !== 'morph') return;
      const b = e.target.closest?.('[data-morph]');
      const out = this.$el.querySelector('.mc-next');
      if (!b || !out) return;
      const next = Number(b.dataset.dps);
      out.textContent = num(next);
      out.classList.toggle('up', next >= this._morphNow);
      out.classList.toggle('down', next < this._morphNow);
    };
    this.$el.addEventListener('pointerover', preview);
    this.$el.addEventListener('focusin', preview);
  }

  /**
   * Where this tower could go, and the ONE place that question is answered.
   *
   * The footer button's `disabled`, its <kbd> cap, its aria-keyshortcuts and the
   * M hotkey all depend on it, and for a round they disagreed: the button was
   * greyed with "Nothing else is unlocked to morph into yet" while M happily
   * opened the sheet on an empty target list. An empty array is the whole
   * answer — inert blocks and primals return one too, since neither has
   * anywhere to go.
   */
  morphTargetsFor(t) {
    if (!t || t.def.kind === 'inert' || t.def.kind === 'primal') return [];
    return this.game.morphTargets.filter((d) => d.key !== t.def.key);
  }

  show(t) {
    this.tower = t;
    this.view = 'tower';
    this.$el.classList.remove('morph');
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

    // Disabled ONLY for the two reasons that leave nothing to show. Being mid-
    // wave is not one of them: the sheet is worth reading during combat — it is
    // where you decide what to spend the prep on — and morphTower refuses the
    // commit anyway. Chrome fires no mouse events on a disabled button, so a
    // greyed control's `title` never renders, which would make "Morph only
    // between waves" a rule the player could only discover by it not happening.
    const targets = this.morphTargetsFor(t);
    const prep = this.game.state.phase === 'prep';
    const morphOff = targets.length === 0;
    // A CAP THAT PROMISES A DEAD KEY IS WORSE THAN NO CAP — and that applies to
    // the invisible cap as well. The <kbd>U</kbd> was already dropped on a
    // fully-forged tower while aria-keyshortcuts="U" stayed on the disabled
    // button, so a screen reader went on announcing a shortcut for an action no
    // sighted player was being offered; #insp-morph did the same with M AND kept
    // its visible cap. Both attributes below are conditional on the same flag as
    // the button's own `disabled`, and showMorph now refuses an empty target
    // list — pressing M with one element bound used to render a degenerate card
    // ("28 DPS NOW -> — AFTER", no destination) over the unavailability message.
    const morphWhy = def.kind === 'primal'
      ? 'A Primal cannot morph — its two element stacks would have to be destroyed or laundered. Sell it and they come back in full.'
      : targets.length === 0 ? 'Nothing else is unlocked to morph into yet'
      : !prep ? 'Compare targets now — morphing itself is only possible between waves'
      : `Re-key this tower in place — ${targets.length} targets, level carries over`;

    this.$el.innerHTML = /* html */`
      <header class="insp-head" style="--c:${hex(def.color)};--a:${hex(def.accent)}">
        <span class="insp-glyph">${def.kind === 'dual' ? '◆' : def.glyph}</span>
        <div class="insp-id">
          <b>${esc(def.name)}</b>
          <span class="insp-lineage">${lineage}</span>
        </div>
        <button class="insp-close" aria-label="Close (Esc)" aria-keyshortcuts="Escape">✕</button>
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

      <footer class="insp-actions insp-actions-3">
        <button id="insp-upgrade" class="primary" ${maxed ? 'disabled' : 'aria-keyshortcuts="U"'}>
          ${maxed ? 'Fully forged' : `<span>Upgrade</span><em>${num(next.cost)}</em>`}
          ${maxed ? '' : '<kbd>U</kbd>'}
        </button>
        <button id="insp-morph" class="ghost" ${morphOff ? 'disabled' : 'aria-keyshortcuts="M"'} title="${esc(morphWhy)}">
          <span>Morph</span>${morphOff ? '' : '<kbd>M</kbd>'}
        </button>
        <button id="insp-sell" class="ghost" aria-keyshortcuts="X"><span>Sell</span><em>+${num(refund)}</em><kbd>X</kbd></button>
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
    this.view = 'inert';
    this.$el.classList.remove('morph');
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
        <button class="insp-close" aria-label="Close (Esc)" aria-keyshortcuts="Escape">✕</button>
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
        <button id="insp-sell" class="ghost" aria-keyshortcuts="X"><span>Sell</span><em>+${num(refund)}</em><kbd>X</kbd></button>
      </footer>`;

    this.$el.classList.add('open');
    this.$el.setAttribute('aria-hidden', 'false');
  }

  /**
   * The morph sheet: every tower this one may become, and what each costs.
   *
   * It replaces the panel BODY and keeps the header and the footer, so the
   * player never loses track of which tile they are editing. Nothing new is
   * invented visually either — it reuses the `.insp-arm` / `.arm-opt` grid the
   * foundation panel already ships, which already carries 21 options in this
   * column without drowning.
   *
   * Cards carry four fields and no DPS pair. The delta lives in the single
   * sticky strip above them (see the `preview` listener in the constructor):
   * twenty cards each showing a before/after is a spreadsheet, one number that
   * tracks the cursor is a comparison.
   *
   * Cards you cannot pay for are NOT `disabled`. A disabled button dispatches no
   * pointer events in Chrome, so it would drop out of the comparison sweep —
   * precisely when you are deciding what to save up for. They are dimmed, they
   * announce themselves via aria-disabled, and clicking one gets the honest
   * refusal from Game.morphTower.
   */
  showMorph(t) {
    // Reachable from the M hotkey with anything selected, so it has to defend
    // exactly the cases the footer button greys out — ALL of them. It used to
    // check `inert` and `primal` and not "nothing is unlocked yet", so a fresh
    // run with one element bound answered M with a card whose destination
    // column was an em dash.
    if (!t) return;
    if (this.morphTargetsFor(t).length === 0) return this.show(t);

    const g = this.game;
    const def = t.def;
    const gold = g.state.gold;
    const prep = g.state.phase === 'prep';

    this.tower = t;
    this.view = 'morph';
    this._morphNow = effectiveDps(def.levels[t.level]);

    let paid = 0; for (let l = 0; l <= t.level; l++) paid += def.levels[l].cost;
    const sellRefund = Math.floor(paid * ECONOMY.sellRefund);

    const opts = g.morphTargets.filter((d) => d.key !== def.key).map((d) => {
      const kept = Math.min(t.level, d.levels.length - 1);
      let want = 0; for (let l = 0; l <= kept; l++) want += d.levels[l].cost;
      return {
        d, kept,
        cost: g.morphCost(t, d.key),
        // A free morph is not a bargain: it means the target is worth less than
        // the credit, and the difference is investment walked away from. The
        // panel must say so — this is the one case the price alone hides.
        loss: want < paid * ECONOMY.morphCredit,
        next: effectiveDps(d.levels[kept]),
      };
    }).sort((a, b) => a.cost - b.cost || a.d.name.localeCompare(b.d.name));

    const card = (o) => {
      const d = o.d;
      const poor = gold < o.cost;
      const parts = d.kind === 'dual' ? d.parts : [d.element];
      const glyphs = parts.map((p) =>
        `<b style="color:${hex(ELEMENTS[p].color)}">${ELEMENTS[p].glyph}</b>`).join('');
      const title = o.loss
        ? `${d.name} — free, but you walk away from the ${num(sellRefund)} gold selling this tower would refund`
        : poor ? `${d.name} — needs ${num(o.cost - Math.floor(gold))} more gold`
        : `${d.name} — ${num(o.cost)} gold, lands at level ${o.kept + 1} of ${d.levels.length}`;
      return `<button class="arm-opt morph-opt${o.loss ? ' morph-loss' : ''}${poor ? ' poor' : ''}"
          data-morph="${d.key}" data-dps="${Math.round(o.next)}" style="--c:${hex(d.color)}"
          aria-disabled="${poor || !prep}" title="${esc(title)}">
        <span class="ao-glyph">${glyphs}</span>
        <span class="ao-name">${esc(d.name.replace(' Tower', ''))}</span>
        <span class="ao-lv">Lv ${o.kept + 1}</span>
        <span class="ao-cost">${o.cost === 0 ? 'Free' : num(o.cost)}</span>
      </button>`;
    };

    const group = (legend, list) => (list.length
      ? `<div class="insp-legend sub">${legend}</div><div class="insp-arm">${list.map(card).join('')}</div>`
      : '');

    const taxed = (t.morphCount ?? 0) > 0;
    const parts = def.kind === 'dual' ? def.parts : [def.element];
    const lineage = parts.map((p) =>
      `<em style="color:${hex(ELEMENTS[p].color)}">${ELEMENTS[p].glyph} ${ELEMENTS[p].name}</em>`).join('<s>+</s>');

    this.$el.innerHTML = /* html */`
      <header class="insp-head" style="--c:${hex(def.color)};--a:${hex(def.accent)}">
        <span class="insp-glyph">${def.kind === 'dual' ? '◆' : def.glyph}</span>
        <div class="insp-id">
          <b>${esc(def.name)}</b>
          <span class="insp-lineage">${lineage}</span>
        </div>
        <button class="insp-close" aria-label="Close (Esc)" aria-keyshortcuts="Escape">✕</button>
      </header>

      <div class="insp-section morph-sheet">
        <div class="insp-legend"><button class="morph-back" aria-label="Back">←</button> Morph into</div>

        <div class="morph-compare" style="--c:${hex(def.color)}"
             title="Effective DPS: direct damage plus sustained damage over time, splash and chain.">
          <b>${num(this._morphNow)}</b><u>DPS now</u>
          <span class="mc-arrow">→</span>
          <b class="mc-next">—</b><u>after</u>
        </div>

        <p class="ii-note">Level carries as far as the target can hold it — each card says
        where. Targeting, damage and kills carry over.${taxed
          ? ` <b>Morph #${(t.morphCount ?? 0) + 1} here</b>: prices include a
             ${Math.round(ECONOMY.morphTax * 100)}% tax per earlier morph.` : ''}</p>
        ${prep ? '' : '<p class="ii-note bad">Combat has started. Morph is only available between waves.</p>'}

        ${group('Elemental', opts.filter((o) => o.d.kind === 'pure'))}
        ${group('Fusion', opts.filter((o) => o.d.kind === 'dual'))}
        ${opts.length ? '' : '<p class="ii-empty">Nothing else is unlocked to morph into yet.</p>'}
      </div>

      <footer class="insp-actions">
        <button class="primary morph-back"><span>Back to stats</span></button>
        <button id="insp-sell" class="ghost" aria-keyshortcuts="X"><span>Sell</span><em>+${num(sellRefund)}</em><kbd>X</kbd></button>
      </footer>`;

    this.$el.classList.add('open', 'morph');
    this.$el.setAttribute('aria-hidden', 'false');
    this.tick();
  }

  hide() {
    this.tower = null;
    this.view = 'tower';
    this.$el.classList.remove('open', 'morph');
    this.$el.setAttribute('aria-hidden', 'true');
  }

  /** Cheap per-frame: keep upgrade affordability honest as gold moves. */
  tick() {
    const t = this.tower;
    if (!t || !this.$el.classList.contains('open')) return;

    // The morph sheet, same contract as the arm list below: which cards you can
    // act on right now, re-derived from the SAME morphCost call the click will
    // charge, so the printed price and the debit can never drift apart. The
    // phase is re-read too — a wave can start while the sheet is open, and the
    // grid has to grey itself out the moment it does.
    if (this.view === 'morph') {
      const gold = this.game.state.gold;
      const prep = this.game.state.phase === 'prep';
      for (const b of this.$el.querySelectorAll('[data-morph]')) {
        const poor = gold < this.game.morphCost(t, b.dataset.morph);
        b.classList.toggle('poor', poor);
        b.setAttribute('aria-disabled', String(poor || !prep));
      }
      return;
    }

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
