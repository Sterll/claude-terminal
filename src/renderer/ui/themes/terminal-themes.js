/**
 * Terminal Themes
 * Shared terminal theme configurations
 */

/**
 * Claude terminal theme - amber/orange accent
 */
const CLAUDE_TERMINAL_THEME = {
  background: '#0d0d0d',
  foreground: '#e0e0e0',
  cursor: '#d97706',
  selection: 'rgba(217, 119, 6, 0.3)',
  black: '#1a1a1a',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e0e0e0'
};

/**
 * FiveM console theme - VS Code inspired
 */
const FIVEM_TERMINAL_THEME = {
  background: '#0d0d0d',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#0d0d0d',
  selection: 'rgba(255, 255, 255, 0.2)',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#d7ba7d',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4'
};

/**
 * Terminal font configuration
 */
const TERMINAL_FONTS = {
  claude: {
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: 14
  },
  fivem: {
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 13
  }
};

module.exports = {
  CLAUDE_TERMINAL_THEME,
  FIVEM_TERMINAL_THEME,
  TERMINAL_FONTS
};
