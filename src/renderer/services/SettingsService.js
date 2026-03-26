/**
 * Settings Service
 * Handles settings operations and UI interactions
 */

const { BaseService } = require('../core/BaseService');
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

class SettingsService extends BaseService {
  async initializeSettings() {
    await loadSettings();
    const accentColor = getSetting('accentColor');
    if (accentColor) applyAccentColor(accentColor);
  }

  setAccentColor(color) {
    setSetting('accentColor', color);
    applyAccentColor(color);
  }

  getAccentColor() {
    return getSetting('accentColor') || '#d97706';
  }

  setEditor(editor) {
    setSetting('editor', editor);
  }

  getEditor() {
    return getSetting('editor') || 'code';
  }

  setSkipPermissions(skip) {
    setSetting('skipPermissions', skip);
  }

  getSkipPermissions() {
    return getSetting('skipPermissions') || false;
  }

  getEditorOptions() {
    return EDITOR_OPTIONS;
  }

  getAccentColorOptions() {
    return ACCENT_COLORS;
  }

  async getLaunchAtStartup() {
    return await this.api.app.getLaunchAtStartup();
  }

  async setLaunchAtStartup(enabled) {
    return await this.api.app.setLaunchAtStartup(enabled);
  }

  updateWindowTitle(taskTitle, projectName) {
    const fullTitle = taskTitle ? `${taskTitle} - ${projectName}` : projectName;
    const titleElement = document.querySelector('.titlebar-title');
    if (titleElement) titleElement.textContent = fullTitle;
    document.title = fullTitle;
    this.api.window.setTitle(fullTitle);
  }

  extractTitleFromInput(input) {
    let text = input.trim();
    if (text.startsWith('/') || text.length < 5) return null;

    const words = text
      .toLowerCase()
      .replace(/[^\w\sàâäéèêëïîôùûüç-]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !TITLE_STOP_WORDS.has(word));

    if (words.length === 0) return null;
    return words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
}

const TITLE_STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'a', 'à', 'en', 'dans', 'sur', 'pour', 'par', 'avec',
  'the', 'a', 'an', 'and', 'or', 'in', 'on', 'for', 'with', 'to', 'of', 'is', 'are', 'it', 'this', 'that',
  'me', 'moi', 'mon', 'ma', 'mes', 'ce', 'cette', 'ces', 'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles',
  'can', 'you', 'please', 'help', 'want', 'need', 'like', 'would', 'could', 'should',
  'peux', 'veux', 'fais', 'fait', 'faire', 'est', 'sont', 'ai', 'as', 'avez', 'ont'
]);

// ── Lazy singleton + legacy exports ──

let _instance = null;

function _getInstance() {
  if (!_instance) {
    const { getApiProvider, getContainer } = require('../core');
    _instance = new SettingsService(getApiProvider(), getContainer());
  }
  return _instance;
}

module.exports = {
  SettingsService,
  getInstance: _getInstance,
  initializeSettings: (...a) => _getInstance().initializeSettings(...a),
  setAccentColor: (...a) => _getInstance().setAccentColor(...a),
  getAccentColor: (...a) => _getInstance().getAccentColor(...a),
  setEditor: (...a) => _getInstance().setEditor(...a),
  getEditor: (...a) => _getInstance().getEditor(...a),
  setSkipPermissions: (...a) => _getInstance().setSkipPermissions(...a),
  getSkipPermissions: (...a) => _getInstance().getSkipPermissions(...a),
  getEditorOptions: (...a) => _getInstance().getEditorOptions(...a),
  getAccentColorOptions: (...a) => _getInstance().getAccentColorOptions(...a),
  getLaunchAtStartup: (...a) => _getInstance().getLaunchAtStartup(...a),
  setLaunchAtStartup: (...a) => _getInstance().setLaunchAtStartup(...a),
  updateWindowTitle: (...a) => _getInstance().updateWindowTitle(...a),
  extractTitleFromInput: (...a) => _getInstance().extractTitleFromInput(...a),
  // Re-exported state helpers (unchanged)
  getSettings, getSetting, updateSettings, setSetting, isNotificationsEnabled
};
