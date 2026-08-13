/**
 * Color Utilities
 * Helper functions for color manipulation and theme management
 */

// Use preload API instead of direct ipcRenderer
const api = window.electron_api;

/**
 * Convert hex color to RGB object
 * @param {string} hex - Hex color string (e.g., '#d97706')
 * @returns {{r: number, g: number, b: number}|null}
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

/**
 * Convert RGB to hex color
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {string} - Hex color string
 */
function rgbToHex(r, g, b) {
  return '#' + [r, g, b]
    .map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Lighten a color by a percentage
 * @param {string} hex - Hex color string
 * @param {number} percent - Percentage to lighten (0-100)
 * @returns {string} - Lightened hex color
 */
function lightenColor(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const r = Math.min(255, Math.floor(rgb.r + (255 - rgb.r) * percent / 100));
  const g = Math.min(255, Math.floor(rgb.g + (255 - rgb.g) * percent / 100));
  const b = Math.min(255, Math.floor(rgb.b + (255 - rgb.b) * percent / 100));

  return rgbToHex(r, g, b);
}

/**
 * Darken a color by a percentage
 * @param {string} hex - Hex color string
 * @param {number} percent - Percentage to darken (0-100)
 * @returns {string} - Darkened hex color
 */
function darkenColor(hex, percent) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const r = Math.floor(rgb.r * (100 - percent) / 100);
  const g = Math.floor(rgb.g * (100 - percent) / 100);
  const b = Math.floor(rgb.b * (100 - percent) / 100);

  return rgbToHex(r, g, b);
}

/**
 * Apply accent color to CSS custom properties
 * @param {string} color - Hex color string
 */
function applyAccentColor(color) {
  const root = document.documentElement;
  const rgb = hexToRgb(color);

  // Main accent color
  root.style.setProperty('--accent', color);

  // Hover state (lighter)
  root.style.setProperty('--accent-hover', lightenColor(color, 30));

  // Dimmed version (transparent)
  if (rgb) {
    root.style.setProperty('--accent-dim', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`);
    // RGB components for rgba() usage in CSS (e.g. rgba(var(--accent-rgb), .08)).
    // Both names must stay in sync: stylesheets use --accent-rgb and --accent-color-rgb
    // interchangeably. base.css aliases the latter to the former so it also works
    // before this runs, but the inline alias would shadow it, so we set both here.
    const rgbTriplet = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
    root.style.setProperty('--accent-rgb', rgbTriplet);
    root.style.setProperty('--accent-color-rgb', rgbTriplet);
  }

  // Notify main process to update tray icon
  api.tray.updateAccentColor(color);
}

/**
 * Predefined accent color palette
 */
const ACCENT_COLORS = [
  { name: 'Orange', hex: '#d97706' },
  { name: 'Red', hex: '#dc2626' },
  { name: 'Pink', hex: '#db2777' },
  { name: 'Purple', hex: '#9333ea' },
  { name: 'Indigo', hex: '#4f46e5' },
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Cyan', hex: '#0891b2' },
  { name: 'Teal', hex: '#0d9488' },
  { name: 'Green', hex: '#16a34a' },
  { name: 'Lime', hex: '#65a30d' }
];

/**
 * Sanitize a color value for safe injection into CSS style attributes.
 * Only allows strict hex colors (#rgb, #rrggbb, #rrggbbaa).
 * Returns empty string for any invalid/suspicious value.
 * @param {string} color
 * @returns {string}
 */
function sanitizeColor(color) {
  if (typeof color !== 'string') return '';
  const trimmed = color.trim();
  if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  if (theme === 'system' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

function applyTheme(theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

let _systemThemeMql = null;
let _systemThemeHandler = null;
function watchSystemTheme(getThemeSetting, onApplied) {
  if (typeof window.matchMedia !== 'function') return;
  if (_systemThemeMql && _systemThemeHandler) {
    _systemThemeMql.removeEventListener('change', _systemThemeHandler);
  }
  _systemThemeMql = window.matchMedia('(prefers-color-scheme: light)');
  _systemThemeHandler = () => {
    if (getThemeSetting() !== 'system') return;
    const resolved = applyTheme('system');
    if (typeof onApplied === 'function') onApplied(resolved);
  };
  _systemThemeMql.addEventListener('change', _systemThemeHandler);
}

module.exports = {
  hexToRgb,
  rgbToHex,
  lightenColor,
  darkenColor,
  applyAccentColor,
  sanitizeColor,
  ACCENT_COLORS,
  resolveTheme,
  applyTheme,
  watchSystemTheme
};
