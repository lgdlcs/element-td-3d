/**
 * Element picker — the signature decision of Element TD.
 *
 * Three cards, each with its own elemental motion field, and — the thing that
 * was missing — an explicit read-out of *what this choice unlocks*: the pure
 * tower, and every new fusion the pick would make buildable, computed from the
 * elements you already own.
 */

import {
  ELEMENTS, PRIMALS, PRIMAL, PRIMAL_TOWERS, PURE_TOWERS,
  hex, num, dps, esc, newFusionsFor, specialsOf,
} from './uikit.js';
import { ELEMENT_PICK } from '../core/Config.js';
import { TOTAL_WAVES } from '../game/Waves.js';

/** Per-element particle recipes: count, shape class, drift direction. */
const MOTION = {
  fire:   { n: 34, cls: 'p-rise',  dur: [2.0, 3.8] },
  water:  { n: 30, cls: 'p-fall',  dur: [2.4, 4.4] },
  nature: { n: 28, cls: 'p-drift', dur: [3.2, 5.8] },
  earth:  { n: 22, cls: 'p-heavy', dur: [2.8, 5.0] },
  light:  { n: 36, cls: 'p-flare', dur: [1.8, 3.4] },
  dark:   { n: 32, cls: 'p-suck',  dur: [2.2, 4.2] },
};

export class Picker {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this.open = false;

    root.insertAdjacentHTML('beforeend', /* html */`
      <div id="picker" role="dialog" aria-modal="true" aria-labelledby="picker-title" aria-hidden="true">
        <div class="picker-veil"></div>
        <div class="picker-inner">
          <div class="picker-eyebrow" id="picker-eyebrow"></div>
          <h2 id="picker-title">Convergence</h2>
          <p class="picker-sub">Bind one element. Every pair you hold forges a fusion tower.</p>
          <div class="picker-cards" id="picker-cards" role="radiogroup" aria-labelledby="picker-title"></div>
          <div class="picker-hint"><kbd>←</kbd><kbd>→</kbd> choose · <kbd>Enter</kbd> bind</div>
        </div>
      </div>`);

    this.$el = root.querySelector('#picker');
    this.$cards = root.querySelector('#picker-cards');
    this.$eyebrow = root.querySelector('#picker-eyebrow');

    this.$cards.addEventListener('click', (e) => {
      const c = e.target.closest('.pcard');
      if (c) this.#choose(c.dataset.id);
    });
    window.addEventListener('keydown', (e) => this.#onKey(e));
  }

  #onKey(e) {
    if (!this.open) return;
    const cards = [...this.$cards.querySelectorAll('.pcard')];
    if (!cards.length) return;
    const i = cards.indexOf(document.activeElement);
    if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
      e.preventDefault(); cards[(Math.max(0, i) + 1) % cards.length].focus();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
      e.preventDefault(); cards[(Math.max(0, i) - 1 + cards.length) % cards.length].focus();
    } else if (e.code === 'Enter' || e.code === 'Space') {
      if (i >= 0) { e.preventDefault(); e.stopPropagation(); this.#choose(cards[i].dataset.id); }
    }
  }

  #choose(id) {
    if (!this.open) return;
    const card = this.$cards.querySelector(`.pcard[data-id="${id}"]`);
    if (card) {
      this.$el.classList.add('committing');
      card.classList.add('chosen');
      this.$cards.querySelectorAll('.pcard').forEach((c) => { if (c !== card) c.classList.add('dismissed'); });
    }
    // Let the commit animation read before the game advances.
    setTimeout(() => {
      this.$el.classList.remove('committing');
      this.game.chooseElement(id);
    }, 260);
  }

  show() {
    const st = this.game.state;
    const owned = st.elements;
    const choices = this.#choices();

    // DISTINCT elements, not stacks: `owned` can now hold three Fires and
    // "3 of 6 elements bound" would be false.
    this.$eyebrow.innerHTML = `Wave ${Math.max(1, st.wave)} / ${TOTAL_WAVES}`
      + ` &middot; ${new Set(owned).size} of 6 elements bound`
      + (st.pendingElementPicks > 1 ? ` &middot; <b>${st.pendingElementPicks} picks remaining</b>` : '');

    this.$cards.innerHTML = choices.map((e, i) => this.#card(e, owned, i)).join('');
    this.$el.classList.add('open');
    this.$el.setAttribute('aria-hidden', 'false');
    this.open = true;
    requestAnimationFrame(() => this.$cards.querySelector('.pcard')?.focus());
  }

  /**
   * The roll, verbatim.
   *
   * This used to top up a short bag from the UNSEEDED module-level
   * ELEMENT_ORDER, which was a live multiplayer determinism hazard the moment it
   * fired: two clients in the same room would have rendered different offers.
   * rollElementChoices() now provably returns exactly ELEMENT_PICK.slots distinct
   * ids for every possible holding (three fill passes over six elements into
   * three slots cannot under-fill), so there is nothing left to top up and no
   * unseeded path to fall down.
   */
  #choices() {
    return (this.game.rollElementChoices() ?? []).slice(0, ELEMENT_PICK.slots);
  }

  hide() {
    this.$el.classList.remove('open', 'committing');
    this.$el.setAttribute('aria-hidden', 'true');
    this.open = false;
  }

  #card(e, owned, index) {
    // How many copies you already hold — the whole card now branches on this,
    // not on a boolean, because a repeat is no longer a wasted pick: it is one
    // step toward a Primal.
    let have = 0;
    for (const id of owned) if (id === e.id) have++;
    const isNew = have === 0;
    const willHave = have + 1;
    const primalReady = willHave === PRIMAL.stacksRequired;
    const unlocks = newFusionsFor(owned, e.id);
    const pure = PURE_TOWERS[e.id];
    const lv = pure.levels[0];

    const chips = unlocks.map((f) => `
      <li style="--c:${hex(f.color)}">
        <span class="uf-pair">${f.parents.map((p) =>
          `<b style="color:${hex(ELEMENTS[p].color)}">${ELEMENTS[p].glyph}</b>`).join('')}</span>
        <span class="uf-name">${f.name.replace(' Tower', '')}</span>
        <span class="uf-cost">${num(f.levels[0].cost)}</span>
      </li>`).join('');

    const unlockBlock = isNew ? `
      <div class="pc-unlocks">
        <div class="pc-unlock-head">
          <span>Unlocks</span>
          <i>${1 + unlocks.length} tower${unlocks.length ? 's' : ''}</i>
        </div>
        <ul class="pc-fusions">
          <li class="prime" style="--c:${hex(e.color)}">
            <span class="uf-pair"><b style="color:${hex(e.color)}">${e.glyph}</b></span>
            <span class="uf-name">${e.name} Tower</span>
            <span class="uf-cost">${num(lv.cost)}</span>
          </li>
          ${chips}
        </ul>
        ${unlocks.length === 0 ? '<p class="pc-note">No fusions yet — your first pairing comes next.</p>' : ''}
      </div>`
      : this.#primalBlock(e, have, willHave, primalReady);

    const m = MOTION[e.id];
    const motes = Array.from({ length: m.n }, (_, k) => {
      const x = Math.round((k * 137.5) % 100);
      const dur = (m.dur[0] + ((k * 0.37) % 1) * (m.dur[1] - m.dur[0])).toFixed(2);
      const delay = ((k * 0.61) % 1 * -Number(dur)).toFixed(2);
      const s = (0.5 + ((k * 0.23) % 1) * 1.6).toFixed(2);
      return `<i class="${m.cls}" style="left:${x}%;--d:${dur}s;--dl:${delay}s;--s:${s}"></i>`;
    }).join('');

    const specials = specialsOf(pure.levels[2]).slice(0, 3);

    const cls = isNew ? '' : primalReady ? ' primal-ready' : ' dup';

    return /* html */`
      <button class="pcard${cls}" data-id="${e.id}" role="radio" aria-checked="false"
              style="--c:${hex(e.color)};--a:${hex(e.accent)};--i:${index}">
        <span class="pc-field" aria-hidden="true">${motes}</span>
        <span class="pc-halo" aria-hidden="true"></span>
        <span class="pc-body">
          <span class="pc-glyph">${e.glyph}</span>
          <span class="pc-name">${e.name}</span>
          <span class="pc-role">${e.role}</span>
          <span class="pc-tagline">${e.tagline}</span>
          <span class="pc-stats">
            <i><u>DPS</u><b>${num(dps(lv))}</b></i>
            <i><u>Range</u><b>${lv.range.toFixed(1)}</b></i>
            <i><u>Cost</u><b>${num(lv.cost)}</b></i>
          </span>
          ${specials.length ? `<span class="pc-specials">${specials.map((s) => `<i>${s.label}</i>`).join('')}</span>` : ''}
        </span>
        ${unlockBlock}
        <span class="pc-cta">Bind ${e.name}</span>
      </button>`;
  }

  /**
   * The repeat card's payload — the discovery moment for Primal towers.
   *
   * Taking an element twice used to be flatly worthless ("unlocks nothing"), so
   * the picker taught the player to never do it. It is now the only route to a
   * Primal, and the card has to say so at the moment the choice is live, in the
   * same shape the fusion chips use so the comparison is direct: this card is
   * offering you ONE tower instead of several, and that one is the strongest
   * thing on the board.
   */
  #primalBlock(e, have, willHave, ready) {
    const p = PRIMALS[e.id];
    const def = PRIMAL_TOWERS[p.id];
    const lv = def.levels[0];
    const sig = specialsOf(lv).slice(0, 2).map((s) => s.label).join(' · ');
    const pips = Array.from({ length: PRIMAL.stacksRequired }, (_, i) =>
      `<i class="${i < have ? 'on' : i === have ? 'next' : ''}"></i>`).join('');

    // Already at three or beyond: nothing more to earn here, but it is not
    // worthless either — a spare stack is the rebuild after you spend a Primal.
    if (have >= PRIMAL.stacksRequired) {
      return `<div class="pc-unlocks owned-already">
        <div class="pc-unlock-head"><span>Primal progress</span><i>${have} of ${PRIMAL.stacksRequired}</i></div>
        <p class="pc-note">You already hold ${PRIMAL.stacksRequired} ${e.name}. A fourth banks the
          rebuild after you spend ${esc(p.name)}.</p>
      </div>`;
    }

    return `<div class="pc-unlocks primal-progress${ready ? ' ready' : ''}">
      <div class="pc-unlock-head">
        <span>Primal progress</span>
        <i>${ready ? `${willHave} of ${PRIMAL.stacksRequired} · unlocks`
          : `${have} → ${willHave} of ${PRIMAL.stacksRequired}`}</i>
      </div>
      <span class="pc-pips">${pips}</span>
      ${ready
        ? `<ul class="pc-fusions">
            <li class="prime" style="--c:${hex(def.color)}">
              <span class="uf-pair"><b style="color:${hex(def.color)}">${def.glyph}</b></span>
              <span class="uf-name">${esc(p.name)}</span>
              <span class="uf-cost">${num(lv.cost)}</span>
            </li>
          </ul>
          <p class="pc-note">${num(dps(lv))} DPS · ${esc(sig)}. Building it spends
            ${PRIMAL.stacksConsumed} of the ${PRIMAL.stacksRequired}.</p>`
        : `<p class="pc-note">One more ${e.name} unlocks ${esc(p.name)}.</p>`}
    </div>`;
  }
}
