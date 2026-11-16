/**
 * Palette derivation - turns the handful of colours a theme declares into the
 * full set of design tokens base.css defines, so a theme author picks four
 * colours and never has to hand-tune twenty.
 *
 * Pure functions only (no DOM): tested in isolation and shared by the engine
 * and the Theme Studio previews.
 *
 * The text ramp keeps the guarantee base.css documents: every step clears WCAG
 * AA (4.5:1) against the surfaces it sits on. A derived step that falls short
 * is pushed towards the text colour until it passes, so a user-made palette
 * cannot quietly make muted labels unreadable.
 */

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}/.test(h)) return null;
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Mix two hex colours; t = 0 gives `a`, t = 1 gives `b`. */
function mixHex(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return a;
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

function luminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Walk `color` towards `target` until it reaches `ratio` against every
 * background. If `target` itself is not far enough from them, keep going to
 * white (dark backgrounds) or black (light ones), so the guarantee holds even
 * for a palette whose text colour was the problem.
 */
function ensureContrast(color, target, backgrounds, ratio = 4.5) {
  const fails = (c) => backgrounds.some((bg) => contrast(c, bg) < ratio);
  const dark = backgrounds.reduce((sum, bg) => sum + luminance(bg), 0) / Math.max(1, backgrounds.length) < 0.4;
  let c = color;
  for (const goal of [target, dark ? '#ffffff' : '#000000']) {
    for (let i = 0; i < 24 && fails(c); i++) c = mixHex(c, goal, 0.15);
  }
  return c;
}

const rgbTriplet = (hex) => { const c = hexToRgb(hex) || { r: 0, g: 0, b: 0 }; return `${c.r}, ${c.g}, ${c.b}`; };

/**
 * @param {{ bg: string, surface: string, text: string, accent: string,
 *           border?: string, success?: string, warning?: string, danger?: string, info?: string }} p
 * @returns {Record<string, string>} CSS custom properties, names without values validation
 */
function deriveTokens(p) {
  const bg = hexToRgb(p.bg) ? p.bg : '#0d0d0d';
  const surface = hexToRgb(p.surface) ? p.surface : mixHex(bg, '#ffffff', 0.05);
  const text = hexToRgb(p.text) ? p.text : '#e0e0e0';
  const accent = hexToRgb(p.accent) ? p.accent : '#d97706';

  const tertiary = mixHex(surface, text, 0.045);
  const hover = mixHex(surface, text, 0.09);
  const active = mixHex(surface, text, 0.12);
  const border = hexToRgb(p.border) ? p.border : mixHex(surface, text, 0.14);
  const surfaces = [bg, surface, tertiary];

  // The primary text is fixed first, so the dimmer steps derive from (and
  // fall back towards) a colour that is already readable.
  const primary = ensureContrast(text, '#ffffff', surfaces, 7);
  const secondary = ensureContrast(mixHex(primary, bg, 0.28), primary, surfaces);
  const tertiaryText = ensureContrast(mixHex(primary, bg, 0.36), primary, surfaces);
  const muted = ensureContrast(mixHex(primary, bg, 0.44), primary, surfaces);

  const tokens = {
    '--bg-primary': bg,
    '--bg-secondary': surface,
    '--bg-tertiary': tertiary,
    '--bg-hover': hover,
    '--bg-active': active,
    '--border-color': border,
    '--text-primary': primary,
    '--text-secondary': secondary,
    '--text-tertiary': tertiaryText,
    '--text-muted': muted,
    '--theme-bg-rgb': rgbTriplet(bg),
    '--theme-surface-rgb': rgbTriplet(surface),
    '--theme-text-rgb': rgbTriplet(text),
    '--theme-accent': accent,
    // Solid copies under names nothing else redefines. ambience.css turns the
    // --bg-* tokens translucent inside the app's panes by mixing these: a
    // token cannot be defined from itself on the same element.
    '--ct-bg': bg,
    '--ct-surface': surface,
    '--ct-surface-2': tertiary,
    '--ct-text': text,
  };
  if (hexToRgb(p.success)) tokens['--success'] = p.success;
  if (hexToRgb(p.warning)) tokens['--warning'] = p.warning;
  if (hexToRgb(p.danger)) { tokens['--danger'] = p.danger; tokens['--danger-rgb'] = rgbTriplet(p.danger); }
  if (hexToRgb(p.info)) { tokens['--info'] = p.info; tokens['--info-rgb'] = rgbTriplet(p.info); }
  return tokens;
}

/**
 * An xterm theme in the colours of the palette, so a terminal tab belongs to
 * the scene instead of sitting on it as a grey slab. ANSI colours are nudged
 * towards the text colour so they stay legible on the derived background.
 */
function deriveTerminalTheme(p, name = 'Ambient') {
  const bg = mixHex(p.bg, p.surface, 0.5);
  const fg = p.text;
  const tint = (hex) => ensureContrast(mixHex(hex, p.accent, 0.12), fg, [bg], 4.5);
  const bright = (hex) => mixHex(tint(hex), '#ffffff', 0.25);
  const base = {
    red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee',
  };
  const theme = {
    name,
    background: bg,
    foreground: fg,
    cursor: p.accent,
    cursorAccent: bg,
    selection: `rgba(${rgbTriplet(p.accent)}, 0.32)`,
    selectionBackground: `rgba(${rgbTriplet(p.accent)}, 0.32)`,
    black: mixHex(bg, fg, 0.15),
    white: mixHex(fg, bg, 0.1),
    brightBlack: ensureContrast(mixHex(bg, fg, 0.45), fg, [bg], 3),
    brightWhite: '#ffffff',
  };
  for (const [k, v] of Object.entries(base)) {
    theme[k] = tint(v);
    theme[`bright${k[0].toUpperCase()}${k.slice(1)}`] = bright(v);
  }
  return theme;
}

module.exports = {
  hexToRgb,
  rgbToHex,
  mixHex,
  luminance,
  contrast,
  ensureContrast,
  rgbTriplet,
  deriveTokens,
  deriveTerminalTheme,
};
