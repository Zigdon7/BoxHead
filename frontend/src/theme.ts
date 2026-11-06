/**
 * Design tokens shared by the HTML UI and the canvas HUD.
 *
 * The CSS custom properties at the top of index.html are the single source of
 * truth. The HUD reads them here, so menus and in-game panels can't drift apart.
 *
 * Color meanings (used the same way everywhere):
 *   accent  red   brand, primary actions, enemies, damage, danger
 *   health  green health only (and the "online" dot)
 *   money   gold  credits, prices, reward multipliers
 *   you     blue  the local player and the current selection
 *   neutral       everything else (text, borders, ammo, score)
 */

const styles = getComputedStyle(document.documentElement);
const token = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;

/** `#rrggbb` → `rgba(r, g, b, alpha)`; other formats are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const theme = {
  font: token('--font-ui', '"Segoe UI", system-ui, sans-serif'),
  surface: token('--surface', '#14171d'),
  surfaceRaised: token('--surface-raised', '#1b1f27'),
  surfaceHover: token('--surface-hover', '#242a35'),
  field: token('--field', '#0f1217'),
  border: token('--border', '#2b313c'),
  borderStrong: token('--border-strong', '#3b4351'),
  text: token('--text', '#f2f3f5'),
  textSecondary: token('--text-secondary', '#b3b9c4'),
  textMuted: token('--text-muted', '#8b919d'),
  accent: token('--accent', '#e5483b'),
  health: token('--health', '#40c97a'),
  money: token('--money', '#f2b53c'),
  you: token('--you', '#4f9dff'),
};

export type Tone = 'accent' | 'health' | 'money' | 'you' | 'neutral';

export function toneColor(tone: Tone): string {
  return tone === 'neutral' ? theme.textSecondary : theme[tone];
}

/** Canvas font shorthand in the UI typeface. */
export function font(size: number, weight = 600): string {
  return `${weight} ${size}px ${theme.font}`;
}
