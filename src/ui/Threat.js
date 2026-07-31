/**
 * Incoming-threat rail.
 *
 * Answers the three questions a TD player actually asks between waves:
 * what is coming, how hard is it, and what should I be building for.
 * The run-ahead makes boss waves and flying waves visible far enough out
 * that you can spend gold on the right answer.
 */

import { waveDef, TOTAL_WAVES } from '../game/Waves.js';
import { CREEP_TYPES } from '../game/Creeps.js';
import { num, compact, CREEP_LORE, esc } from './uikit.js';

const TYPE_GLYPH = {
  normal: '◇', fast: '➤', armored: '▣', swarm: '⁘', flying: '▲', boss: '☠',
};

export class Threat {
  constructor(game, root) {
    this.game = game;
    this.root = root;
    this._sig = '';

    root.insertAdjacentHTML('beforeend', /* html */`
      <aside id="threat" aria-label="Incoming waves">
        <button class="th-collapse" aria-label="Collapse wave panel" aria-expanded="true">‹</button>
        <div class="th-inner">
          <div class="th-timer" id="th-timer">
            <div class="th-timer-row">
              <span id="th-phase">Preparing</span>
              <b id="th-count">—</b>
            </div>
            <div class="th-bar"><i id="th-fill"></i></div>
          </div>
          <div id="th-next"></div>
          <div class="th-legend">Coming up</div>
          <ol id="th-ahead"></ol>
        </div>
      </aside>`);

    this.$el = root.querySelector('#threat');
    this.$phase = root.querySelector('#th-phase');
    this.$count = root.querySelector('#th-count');
    this.$fill = root.querySelector('#th-fill');
    this.$next = root.querySelector('#th-next');
    this.$ahead = root.querySelector('#th-ahead');
    this.$timer = root.querySelector('#th-timer');

    const btn = this.$el.querySelector('.th-collapse');
    btn.addEventListener('click', () => {
      const c = this.$el.classList.toggle('collapsed');
      btn.setAttribute('aria-expanded', String(!c));
      btn.textContent = c ? '›' : '‹';
    });
  }

  update() {
    const st = this.game.state;
    const inCombat = st.phase === 'combat';
    const n = inCombat ? st.wave : st.wave + 1;
    const d = waveDef(Math.min(TOTAL_WAVES, Math.max(1, n)));

    this.$el.classList.toggle('combat', inCombat);
    this.$el.classList.toggle('boss', !!d.isBoss);

    if (inCombat) {
      this.$phase.textContent = 'Wave in progress';
      this.$count.textContent = `${this.game.creeps.count} alive`;
      this.$fill.style.transform = 'scaleX(1)';
      this.$timer.classList.add('live');
    } else if (st.phase === 'prep') {
      const total = waveDef(Math.min(TOTAL_WAVES, st.wave + 1)).prepTime;
      this.$phase.textContent = 'Next wave in';
      this.$count.textContent = `${Math.max(0, Math.ceil(st.prepTimer))}s`;
      this.$fill.style.transform = `scaleX(${Math.max(0, Math.min(1, st.prepTimer / total))})`;
      this.$timer.classList.remove('live');
    } else {
      this.$phase.textContent = 'Choosing element';
      this.$count.textContent = '—';
      this.$timer.classList.remove('live');
    }

    const sig = `${n}|${inCombat}|${st.phase}`;
    if (sig === this._sig) return;
    this._sig = sig;

    this.$next.innerHTML = this.#card(d, inCombat);
    const ahead = [];
    for (let k = 1; k <= 4 && n + k <= TOTAL_WAVES; k++) ahead.push(waveDef(n + k));
    this.$ahead.innerHTML = ahead.map((w) => {
      const t = CREEP_TYPES[w.type];
      return `<li class="${w.isBoss ? 'boss' : ''}${t.flying ? ' fly' : ''}" title="${esc(CREEP_LORE[w.type])}">
        <span class="ah-n">${w.n}</span>
        <span class="ah-g">${TYPE_GLYPH[w.type]}</span>
        <span class="ah-t">${t.name}</span>
        <span class="ah-hp">${compact(w.hp * w.count)}</span>
        ${w.grantsElement ? '<span class="ah-pick" title="Grants an element pick">◈</span>' : ''}
      </li>`;
    }).join('');
  }

  #card(d, live) {
    const t = CREEP_TYPES[d.type];
    const tags = [];
    if (t.flying) tags.push('<i class="tg fly">Flying — ignores your maze</i>');
    if (t.armor > 0) tags.push(`<i class="tg armor">${t.armor} armour</i>`);
    if (t.speed >= 5.5) tags.push('<i class="tg fast">Fast</i>');
    if (d.isBoss) tags.push('<i class="tg boss">Boss — 10 lives</i>');
    if (d.grantsElement) tags.push('<i class="tg pick">Grants an element</i>');

    return `<div class="th-card${d.isBoss ? ' is-boss' : ''}">
      <div class="th-card-top">
        <span class="th-wn"><u>Wave</u><b>${d.n}</b></span>
        <span class="th-type"><span class="th-glyph">${TYPE_GLYPH[d.type]}</span>${t.name}</span>
      </div>
      <div class="th-grid">
        <div><b>${d.count}</b><u>units</u></div>
        <div><b>${compact(d.hp)}</b><u>hp each</u></div>
        <div><b>${compact(d.hp * d.count)}</b><u>total hp</u></div>
      </div>
      <p class="th-lore">${CREEP_LORE[d.type]}</p>
      ${tags.length ? `<div class="th-tags">${tags.join('')}</div>` : ''}
      <div class="th-bounty">${live ? 'Bounty' : 'Pays'} <b>${num(d.bounty)}</b> per kill</div>
    </div>`;
  }
}
