/**
 * The hunt's theme colours, read off the root's CSS tokens. Three-free, so the
 * jsdom theme test can read exactly what HuntView paints with.
 */
export function readPalette() {
  const cs = typeof getComputedStyle === 'function' && typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement) : null;
  const tok = (n, f) => (cs?.getPropertyValue(n) || '').trim() || f;
  return {
    accent: tok('--rite-hunt-accent', '#86c294'),
    ink: tok('--ink', '#e9ebf3'),
    gold: tok('--gold', '#e5bd79'),
    goldHi: tok('--gold-hi', '#f7dfae'),
    danger: tok('--danger', '#ff5f57'),
  };
}
