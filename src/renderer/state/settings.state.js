/**
 * Settings State Module
 * Manages application settings
 */

// Use preload API for Node.js modules
const { fs } = window.electron_nodeModules;
const { State } = require('./State');
const { settingsFile } = require('../utils/paths');

// Default settings
const defaultSettings = {
  editor: 'code', // 'code', 'cursor', 'webstorm', 'idea'
  shortcut: typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? 'Cmd+Shift+P' : 'Ctrl+Shift+P',
  skipPermissions: false,
  accentColor: '#d97706',
  notificationsEnabled: true,
  closeAction: 'ask', // 'ask', 'minimize', 'quit'
  shortcuts: {}, // Custom keyboard shortcuts overrides
  language: null, // null = auto-detect, 'fr' = French, 'en' = English
  compactProjects: true, // Compact project list (only show name when not active)
  customPresets: [], // Custom quick action presets [{name, command, icon}]
  aiCommitMessages: true, // Use GitHub Models API for AI commit messages
  defaultTerminalMode: 'terminal', // 'terminal' or 'chat' - default mode for new Claude terminals
  hooksEnabled: false, // Hooks installed in ~/.claude/settings.json
  hooksConsentShown: false, // User has seen the hooks consent prompt
  chatModel: null, // null = CLI default, or model ID string (e.g. 'claude-sonnet-4-6')
  enable1MContext: false, // Enable 1M token context window via betas flag
  effortLevel: 'high', // Effort level for chat sessions: low, medium, high, max
  remoteEnabled: false, // Enable remote control via mobile PWA
  remotePort: 3712, // Port for the remote control WebSocket/HTTP server
  restoreTerminalSessions: true, // Restore terminal tabs from previous session on startup
  remoteSelectedIp: null, // Selected network interface IP for pairing URL (null = auto)
  showDotfiles: true, // true = show dotfiles in file explorer (default), false = hide them
  showTabModeToggle: true, // Show Chat/Terminal mode-switch button on terminal tabs
  tabRenameOnSlashCommand: false, // Rename terminal tab to slash command text when submitted
  aiTabNaming: true, // Use AI (Haiku) to generate short tab names from messages
  cloudServerUrl: '', // Cloud relay server URL (e.g. 'https://cloud.example.com')
  cloudApiKey: '', // Cloud API key (e.g. 'ctc_abc123...')
  cloudAutoConnect: true, // Auto-connect to cloud relay on startup
  terminalShortcuts: {}, // Terminal shortcut toggles (empty = all enabled by default)
  telemetryEnabled: false, // Opt-in anonymous telemetry
  telemetryUuid: null, // Random UUID for anonymous tracking
  telemetryCategories: { app: true, features: true, errors: true }, // Granular event categories
  telemetryConsentShown: false, // Whether consent prompt was shown
  agentColors: {}, // Custom colors per tool/agent name: { 'Grep': '#ff0000', 'my-agent': '#00ff00' }
  enableFollowupSuggestions: true, // Show AI-generated follow-up suggestion chips after Claude responds (uses Haiku)
  pinnedTabs: ['claude', 'git', 'database', 'mcp', 'plugins', 'skills', 'agents', 'workflows', 'dashboard', 'timetracking', 'memory', 'cloud-panel'], // Pinned sidebar tabs (rest go to More menu)
  tabsOrder: null, // null = canonical order, otherwise array of all tabIds in custom order
};

const settingsState = new State({ ...defaultSettings });

/**
 * Get all settings
 * @returns {Object}
 */
function getSettings() {
  return settingsState.get();
}

/**
 * Get a specific setting
 * @param {string} key
 * @returns {*}
 */
function getSetting(key) {
  return settingsState.get()[key];
}

/**
 * Update settings
 * @param {Object} updates
 */
function updateSettings(updates) {
  settingsState.set(updates);
  saveSettings();
}

/**
 * Update a specific setting
 * @param {string} key
 * @param {*} value
 */
function setSetting(key, value) {
  settingsState.setProp(key, value);
  saveSettings();
}

/**
 * Load settings from file
 */
async function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      const saved = JSON.parse(await fs.promises.readFile(settingsFile, 'utf8'));
      settingsState.set({ ...defaultSettings, ...saved });
    }
  } catch (e) {
    console.error('Error loading settings:', e);
  }
}

/**
 * Save settings to file (debounced)
 */
let saveSettingsTimer = null;
function saveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsImmediate();
  }, 500);
}

/**
 * Save settings to file immediately (no debounce)
 * Use before operations that destroy the renderer (e.g. location.reload)
 */
function saveSettingsImmediate() {
  clearTimeout(saveSettingsTimer);
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settingsState.get(), null, 2));
  } catch (e) {
    console.error('Error saving settings:', e);
  }
}

/**
 * Reset settings to defaults
 */
function resetSettings() {
  settingsState.set({ ...defaultSettings });
  saveSettings();
}

/**
 * Get editor command for a given editor type
 * @param {string} editor
 * @returns {string}
 */
function getEditorCommand(editor) {
  const commands = {
    code: 'code',
    cursor: 'cursor',
    webstorm: 'webstorm',
    idea: 'idea'
  };
  return commands[editor] || 'code';
}

/**
 * Available editor options
 */
const EDITOR_OPTIONS = [
  { value: 'code', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'webstorm', label: 'WebStorm' },
  { value: 'idea', label: 'IntelliJ IDEA' }
];

/**
 * Get notifications enabled state
 * @returns {boolean}
 */
function isNotificationsEnabled() {
  return settingsState.get().notificationsEnabled;
}

/**
 * Toggle notifications
 */
function toggleNotifications() {
  const current = settingsState.get().notificationsEnabled;
  setSetting('notificationsEnabled', !current);
}

module.exports = {
  settingsState,
  getSettings,
  getSetting,
  updateSettings,
  setSetting,
  loadSettings,
  saveSettings,
  saveSettingsImmediate,
  resetSettings,
  getEditorCommand,
  EDITOR_OPTIONS,
  isNotificationsEnabled,
  toggleNotifications
};
