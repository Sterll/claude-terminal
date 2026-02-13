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
  shortcut: 'Ctrl+Shift+P',
  skipPermissions: false,
  accentColor: '#d97706',
  notificationsEnabled: true,
  closeAction: 'ask', // 'ask', 'minimize', 'quit'
  shortcuts: {}, // Custom keyboard shortcuts overrides
  language: null, // null = auto-detect, 'fr' = French, 'en' = English
  compactProjects: true, // Compact project list (only show name when not active)
  customPresets: [], // Custom quick action presets [{name, command, icon}]
  aiCommitMessages: true // Use GitHub Models API for AI commit messages
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
function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
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
