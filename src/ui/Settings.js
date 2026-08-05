import { QUALITY_ORDER, QUALITY_LABELS } from '../core/Config.js';

/**
 * The graphics panel.
 *
 * WHY IT EXISTS
 *
 * Until this file there was no in-game quality control of any kind. The only
 * way to change preset was to append `?q=low` to the URL by hand, which is a
 * developer's affordance: a player handed a link has no way to discover it, and
 * a player whose machine cannot run the preset autodetect chose for them had no
 * way out at all. That is the reported failure — a shared link, friends whose
 * machines could not run it, and nothing in the product that let them say so.
 *
 * WHAT IT PROMISES, AND WHAT IT CANNOT
 *
 * Changing the preset RELOADS the page, and the panel says so before it does.
 * That is not laziness: Lighting, Environment, Arena, EffectSystem and
 * TowerManager all read `quality` in their constructors, so a preset is a
 * property of a built world, not a runtime setting. Pretending otherwise —
 * applying the half of a preset that happens to be live-mutable and leaving the
 * rest stale — would give the player a control that half-works and no way to
 * tell which half. A reload is honest and it is instant.
 *
 * Mid-run adaptation is the GOVERNOR's job (QualityGovernor.js), and that one
 * never reloads anything. The two are complementary and the panel shows both:
 * the preset you chose, and what the governor has had to take away to hold a
 * frame rate. The player can overrule the governor from here, because
 * preferring the pretty version at 30 fps is a legitimate choice that no
 * frame-time threshold can make on their behalf.
 */
export class Settings {
  /**
   * @param root       element to mount into (#ui-root)
   * @param opts.current   preset the game actually booted with
   * @param opts.saved     the stored preference: a preset id, or 'auto'
   * @param opts.governor  QualityGovernor, or null
   * @param opts.onPreset  (preset) => void — persist and reload
   */
  constructor(root, opts = {}) {
    this.current = opts.current;
    this.saved = opts.saved ?? 'auto';
    this.governor = opts.governor ?? null;
    this.onPreset = opts.onPreset ?? (() => {});

    const el = document.createElement('div');
    el.id = 'settings';
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Graphismes et performances');
    root.appendChild(el);
    this.el = el;

    this.#render();

    // Escape closes, like every other panel in this HUD.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) { e.preventDefault(); this.hide(); }
    });

    this.governor?.onChange;   // documented dependency; wiring is in main.js
  }

  get open() { return this.el.classList.contains('open'); }

  show() { this.#setOpen(true); }
  hide() { this.#setOpen(false); }
  toggle() { this.#setOpen(!this.open); }

  #setOpen(on) {
    this.el.classList.toggle('open', on);
    this.el.setAttribute('aria-hidden', String(!on));
    this.btn?.classList.toggle('active', on);
    this.btn?.setAttribute('aria-expanded', String(on));
    if (on) {
      this.refresh();
      // #settings is `visibility: hidden` when closed and focus() consults the
      // RENDERED state, so the class change has to be flushed first or focus
      // silently stays on <body>. Same trick as HUD.setHelp.
      void this.el.offsetWidth;
      this.el.querySelector('.set-close')?.focus();
    } else {
      this.btn?.focus();
    }
  }

  /** Called by main.js so the panel can own its own button. */
  attachButton(btn) {
    this.btn = btn;
    btn.addEventListener('click', () => this.toggle());
  }

  #render() {
    const rows = QUALITY_ORDER.map((q) => `
      <button class="set-q" data-q="${q}" role="radio" aria-checked="false">
        <span class="set-q-name">${QUALITY_LABELS[q] ?? q}</span>
        <span class="set-q-tag"></span>
      </button>`).join('');

    this.el.innerHTML = `
      <div class="set-veil"></div>
      <div class="set-panel">
        <header class="set-head">
          <h2>Graphismes</h2>
          <button class="set-close" aria-label="Fermer">✕</button>
        </header>

        <p class="set-note">
          Si le jeu saccade, descendez d'un cran. Le choix est retenu sur cette
          machine et la page se recharge pour l'appliquer.
        </p>

        <div class="set-group" role="radiogroup" aria-label="Niveau de qualité">
          <button class="set-q" data-q="auto" role="radio" aria-checked="false">
            <span class="set-q-name">Automatique</span>
            <span class="set-q-tag">recommandé</span>
          </button>
          ${rows}
        </div>

        <div class="set-live">
          <div class="set-live-row">
            <span class="set-live-label">Images par seconde</span>
            <span class="set-live-val" id="set-fps">—</span>
          </div>
          <div class="set-live-row">
            <span class="set-live-label">Résolution de rendu</span>
            <span class="set-live-val" id="set-scale">—</span>
          </div>
          <p class="set-gov" id="set-gov"></p>
          <button class="set-restore" id="set-restore" hidden>
            Tout remettre (et accepter moins d'images/s)
          </button>
        </div>
      </div>`;

    this.el.querySelector('.set-close').addEventListener('click', () => this.hide());
    this.el.querySelector('.set-veil').addEventListener('click', () => this.hide());

    for (const b of this.el.querySelectorAll('.set-q')) {
      b.addEventListener('click', () => {
        const q = b.dataset.q;
        if (q === this.saved) { this.hide(); return; }
        this.onPreset(q);
      });
    }

    this.el.querySelector('#set-restore').addEventListener('click', () => {
      // Standing down, not just reverting: a governor that reapplies the rung
      // two seconds later has not honoured the request.
      if (!this.governor) return;
      this.governor.reset();
      this.governor.enabled = false;
      this.refresh();
    });

    this.nodes = {
      fps: this.el.querySelector('#set-fps'),
      scale: this.el.querySelector('#set-scale'),
      gov: this.el.querySelector('#set-gov'),
      restore: this.el.querySelector('#set-restore'),
    };
  }

  /** Repaint the selection + the live readouts. Cheap; called on open and ~2Hz. */
  refresh(fps = null) {
    for (const b of this.el.querySelectorAll('.set-q')) {
      const on = b.dataset.q === this.saved;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      // Autodetect resolves to a real preset, and which one is worth showing:
      // "Automatique" alone does not tell a player on a struggling machine that
      // they are already at the bottom and the problem is elsewhere.
      if (b.dataset.q === 'auto') {
        b.querySelector('.set-q-tag').textContent =
          this.saved === 'auto' ? `détecté : ${QUALITY_LABELS[this.current] ?? this.current}` : 'recommandé';
      }
    }

    if (fps != null) this.nodes.fps.textContent = `${Math.round(fps)}`;

    const adaptive = this.adaptive;
    if (adaptive) {
      const pct = Math.round((adaptive.scale / (adaptive.maxScale || 1)) * 100);
      this.nodes.scale.textContent = adaptive.scale <= adaptive.minScale + 1e-6
        ? `${pct}% (minimum atteint)`
        : `${pct}%`;
    }

    const g = this.governor;
    if (!g) return;
    if (!g.enabled) {
      this.nodes.gov.textContent = 'Réglage automatique désactivé pour cette session.';
      this.nodes.restore.hidden = true;
      return;
    }
    const removed = g.removed;
    if (!removed.length) {
      this.nodes.gov.textContent = 'Aucun effet n\'a eu besoin d\'être coupé.';
      this.nodes.restore.hidden = true;
    } else {
      this.nodes.gov.textContent =
        `Coupé automatiquement pour tenir la fluidité : ${removed.join(', ')}.`;
      this.nodes.restore.hidden = false;
    }
  }
}
