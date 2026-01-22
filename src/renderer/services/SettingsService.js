/**
 * Settings Service
 * Handles settings operations and UI interactions
 */

const { ipcRenderer } = require('electron');
const {
  getSettings,
  getSetting,
  updateSettings,
  setSetting,
  loadSettings,
  saveSettings,
  EDITOR_OPTIONS,
  isNotificationsEnabled,
  toggleNotifications
} = require('../state');
const { applyAccentColor, ACCENT_COLORS } = require('../utils/color');

/**
 * Initialize settings
 */
function initializeSettings() {
  loadSettings();

  // Apply accent color
  const accentColor = getSetting('accentColor');
  if (accentColor) {
    applyAccentColor(accentColor);
  }
}

/**
 * Set accent color and apply it
 * @param {string} color - Hex color string
 */
function setAccentColor(color) {
  setSetting('accentColor', color);
  applyAccentColor(color);
}

/**
 * Get current accent color
 * @returns {string}
 */
function getAccentColor() {
  return getSetting('accentColor') || '#d97706';
}

/**
 * Set editor preference
 * @param {string} editor - Editor type ('code', 'cursor', etc.)
 */
function setEditor(editor) {
  setSetting('editor', editor);
}

/**
 * Get editor preference
 * @returns {string}
 */
function getEditor() {
  return getSetting('editor') || 'code';
}

/**
 * Set skip permissions preference
 * @param {boolean} skip
 */
function setSkipPermissions(skip) {
  setSetting('skipPermissions', skip);
}

/**
 * Get skip permissions preference
 * @returns {boolean}
 */
function getSkipPermissions() {
  return getSetting('skipPermissions') || false;
}

/**
 * Toggle notifications and update UI
 * @returns {boolean} - New state
 */
function toggleNotificationsWithUI() {
  toggleNotifications();
  const enabled = isNotificationsEnabled();

  // Request permission if enabling
  if (enabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  return enabled;
}

/**
 * Show notification via main process
 * @param {string} title
 * @param {string} body
 * @param {number} terminalId
 */
function showNotification(title, body, terminalId) {
  if (!isNotificationsEnabled()) return;

  // Don't notify if window is focused and terminal is active
  const { getActiveTerminal } = require('../state');
  if (document.hasFocus() && getActiveTerminal() === terminalId) return;

  ipcRenderer.send('show-notification', { title, body, terminalId });
}

/**
 * Get editor options for settings UI
 * @returns {Array}
 */
function getEditorOptions() {
  return EDITOR_OPTIONS;
}

/**
 * Get launch at startup setting
 * @returns {Promise<boolean>}
 */
async function getLaunchAtStartup() {
  return await ipcRenderer.invoke('get-launch-at-startup');
}

/**
 * Set launch at startup
 * @param {boolean} enabled
 * @returns {Promise<boolean>}
 */
async function setLaunchAtStartup(enabled) {
  return await ipcRenderer.invoke('set-launch-at-startup', enabled);
}

/**
 * Get accent color options for settings UI
 * @returns {Array}
 */
function getAccentColorOptions() {
  return ACCENT_COLORS;
}

/**
 * Update window title
 * @param {string} taskTitle
 * @param {string} projectName
 */
function updateWindowTitle(taskTitle, projectName) {
  const fullTitle = taskTitle ? `${taskTitle} - ${projectName}` : projectName;

  // Update DOM titlebar
  const titleElement = document.querySelector('.titlebar-title');
  if (titleElement) {
    titleElement.textContent = fullTitle;
  }

  // Update document title
  document.title = fullTitle;

  // Send to main process
  ipcRenderer.send('set-window-title', fullTitle);
}

/**
 * Stop words for title extraction
 */
const TITLE_STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'a', 'à', 'en', 'dans', 'sur', 'pour', 'par', 'avec',
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'for', 'with', 'to', 'of', 'is', 'are', 'it', 'this', 'that',
  'me', 'moi', 'mon', 'ma', 'mes', 'ce', 'cette', 'ces', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'can', 'you', 'please', 'help', 'want', 'need', 'like', 'would', 'could', 'should',
  'peux', 'veux', 'fais', 'fait', 'faire', 'est', 'sont', 'ai', 'as', 'avez', 'ont'
]);

/**
 * Extract title from user input
 * @param {string} input
 * @returns {string|null}
 */
function extractTitleFromInput(input) {
  let text = input.trim();

  // Skip if it looks like a command or is very short
  if (text.startsWith('/') || text.length < 5) {
    return null;
  }

  // Remove punctuation and split into words
  const words = text
    .toLowerCase()
    .replace(/[^\w\sàâäéèêëïîôùûüç-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !TITLE_STOP_WORDS.has(word));

  if (words.length === 0) return null;

  // Take first 2 significant words, capitalize them
  const titleWords = words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1));

  return titleWords.join(' ');
}

module.exports = {
  initializeSettings,
  setAccentColor,
  getAccentColor,
  setEditor,
  getEditor,
  setSkipPermissions,
  getSkipPermissions,
  toggleNotificationsWithUI,
  showNotification,
  getEditorOptions,
  getAccentColorOptions,
  getLaunchAtStartup,
  setLaunchAtStartup,
  updateWindowTitle,
  extractTitleFromInput,
  getSettings,
  getSetting,
  updateSettings,
  setSetting,
  isNotificationsEnabled
};
