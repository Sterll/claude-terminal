/**
 * Terminal Themes
 * Shared terminal theme configurations
 */

/**
 * All available terminal themes
 */
const TERMINAL_THEMES = {
  claude: {
    name: 'Claude',
    background: '#0d0d0d',
    foreground: '#e0e0e0',
    cursor: '#d97706',
    cursorAccent: '#0d0d0d',
    selection: 'rgba(217, 119, 6, 0.3)',
    black: '#1a1a1a',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#f59e0b',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#e0e0e0',
    brightBlack: '#404040',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#fbbf24',
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#ffffff'
  },

  dracula: {
    name: 'Dracula',
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selection: 'rgba(68, 71, 90, 0.5)',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff'
  },

  monokai: {
    name: 'Monokai',
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    cursorAccent: '#272822',
    selection: 'rgba(73, 72, 62, 0.5)',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5'
  },

  nord: {
    name: 'Nord',
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selection: 'rgba(67, 76, 94, 0.5)',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4'
  },

  oneDark: {
    name: 'One Dark',
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selection: 'rgba(62, 68, 81, 0.5)',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff'
  },

  gruvbox: {
    name: 'Gruvbox',
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selection: 'rgba(146, 131, 116, 0.4)',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2'
  },

  tokyoNight: {
    name: 'Tokyo Night',
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selection: 'rgba(41, 46, 66, 0.5)',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5'
  },

  catppuccin: {
    name: 'Catppuccin',
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selection: 'rgba(88, 91, 112, 0.5)',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8'
  },

  synthwave: {
    name: 'Synthwave',
    background: '#262335',
    foreground: '#ffffff',
    cursor: '#ff7edb',
    cursorAccent: '#262335',
    selection: 'rgba(255, 126, 219, 0.3)',
    black: '#262335',
    red: '#fe4450',
    green: '#72f1b8',
    yellow: '#fede5d',
    blue: '#03edf9',
    magenta: '#ff7edb',
    cyan: '#03edf9',
    white: '#ffffff',
    brightBlack: '#614d85',
    brightRed: '#fe4450',
    brightGreen: '#72f1b8',
    brightYellow: '#f97e72',
    brightBlue: '#03edf9',
    brightMagenta: '#ff7edb',
    brightCyan: '#03edf9',
    brightWhite: '#ffffff'
  },

  matrix: {
    name: 'Matrix',
    background: '#0d0208',
    foreground: '#00ff41',
    cursor: '#00ff41',
    cursorAccent: '#0d0208',
    selection: 'rgba(0, 255, 65, 0.2)',
    black: '#0d0208',
    red: '#ff0000',
    green: '#00ff41',
    yellow: '#ffff00',
    blue: '#0000ff',
    magenta: '#ff00ff',
    cyan: '#00ffff',
    white: '#00ff41',
    brightBlack: '#003b00',
    brightRed: '#ff5555',
    brightGreen: '#33ff77',
    brightYellow: '#ffff55',
    brightBlue: '#5555ff',
    brightMagenta: '#ff55ff',
    brightCyan: '#55ffff',
    brightWhite: '#ffffff'
  }
};

/**
 * Get theme by ID
 * @param {string} themeId - Theme identifier
 * @returns {Object} Theme configuration
 */
function getTerminalTheme(themeId) {
  return TERMINAL_THEMES[themeId] || TERMINAL_THEMES.claude;
}

/**
 * Get all theme options for UI
 * @returns {Array} Array of {id, name} objects
 */
function getThemeOptions() {
  return Object.entries(TERMINAL_THEMES).map(([id, theme]) => ({
    id,
    name: theme.name
  }));
}

// Legacy exports for compatibility
const CLAUDE_TERMINAL_THEME = TERMINAL_THEMES.claude;
const FIVEM_TERMINAL_THEME = TERMINAL_THEMES.claude;

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
  TERMINAL_THEMES,
  getTerminalTheme,
  getThemeOptions,
  CLAUDE_TERMINAL_THEME,
  FIVEM_TERMINAL_THEME,
  TERMINAL_FONTS
};
