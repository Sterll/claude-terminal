/**
 * ShortcutsManager Panel
 * Keyboard shortcuts configuration and capture UI
 */

const { BasePanel } = require('../../core/BasePanel');
const { t } = require('../../i18n');
const {
  initKeyboardShortcuts,
  registerShortcut,
  clearAllShortcuts,
  getKeyFromEvent,
  normalizeKey
} = require('../../features/KeyboardShortcuts');

const DEFAULT_SHORTCUTS = {
  openSettings: { key: 'Ctrl+,', labelKey: 'shortcuts.openSettings' },
  closeTerminal: { key: 'Ctrl+W', labelKey: 'shortcuts.closeTerminal' },
  showSessionsPanel: { key: 'Ctrl+Shift+E', labelKey: 'shortcuts.sessionsPanel' },
  newProject: { key: 'Ctrl+N', labelKey: 'shortcuts.newProject' },
  newTerminal: { key: 'Ctrl+T', labelKey: 'shortcuts.newTerminal' },
  toggleFileExplorer: { key: 'Ctrl+E', labelKey: 'shortcuts.toggleFileExplorer' }
};

const GLOBAL_SHORTCUTS = {
  globalQuickPicker: { key: 'Ctrl+Shift+P', labelKey: 'shortcuts.globalQuickPicker' },
  globalNewTerminal: { key: 'Ctrl+Shift+T', labelKey: 'shortcuts.globalNewTerminal' },
  globalNewWorktree: { key: 'Ctrl+Shift+W', labelKey: 'shortcuts.globalNewWorktree' }
};

const TERMINAL_SHORTCUTS = {
  ctrlC: { labelKey: 'shortcuts.terminalCopy', defaultEnabled: true },
  ctrlV: { labelKey: 'shortcuts.terminalPaste', defaultEnabled: true },
  ctrlArrow: { labelKey: 'shortcuts.terminalWordJump', defaultEnabled: false },
  ctrlTab: { labelKey: 'shortcuts.terminalTabSwitch', defaultEnabled: true },
  rightClickPaste: { labelKey: 'shortcuts.terminalRightClickPaste', defaultEnabled: true },
  rightClickCopyPaste: { labelKey: 'shortcuts.terminalRightClickCopyPaste', defaultEnabled: false }
};

class ShortcutsManager extends BasePanel {
  constructor(el, options = {}) {
    super(el, options);
    this._captureState = {
      active: false,
      shortcutId: null,
      overlay: null,
      keydownHandler: null
    };
    this._ctx = options.ctx || null;
  }

  getShortcutLabel(id) {
    const shortcut = DEFAULT_SHORTCUTS[id] || GLOBAL_SHORTCUTS[id];
    return shortcut ? t(shortcut.labelKey) : id;
  }

  getShortcutKey(id) {
    if (GLOBAL_SHORTCUTS[id]) {
      const globalOverrides = this._ctx.settingsState.get().globalShortcuts || {};
      return globalOverrides[id] || GLOBAL_SHORTCUTS[id].key;
    }
    const customShortcuts = this._ctx.settingsState.get().shortcuts || {};
    return customShortcuts[id] || DEFAULT_SHORTCUTS[id]?.key || '';
  }

  checkShortcutConflict(key, excludeId) {
    const normalizedKey = normalizeKey(key);
    for (const [id] of Object.entries(DEFAULT_SHORTCUTS)) {
      if (id === excludeId) continue;
      const currentKey = this.getShortcutKey(id);
      if (normalizeKey(currentKey) === normalizedKey) {
        return { id, label: this.getShortcutLabel(id) };
      }
    }
    for (const [id] of Object.entries(GLOBAL_SHORTCUTS)) {
      if (id === excludeId) continue;
      const currentKey = this.getShortcutKey(id);
      if (normalizeKey(currentKey) === normalizedKey) {
        return { id, label: this.getShortcutLabel(id) };
      }
    }
    return null;
  }

  applyShortcut(id, key) {
    if (GLOBAL_SHORTCUTS[id]) {
      this._applyGlobalShortcut(id, key);
      return;
    }
    const customShortcuts = this._ctx.settingsState.get().shortcuts || {};
    if (normalizeKey(key) === normalizeKey(DEFAULT_SHORTCUTS[id]?.key || '')) {
      delete customShortcuts[id];
    } else {
      customShortcuts[id] = key;
    }
    this._ctx.settingsState.setProp('shortcuts', customShortcuts);
    this._ctx.saveSettings();
    this.registerAllShortcuts();
  }

  _applyGlobalShortcut(id, key) {
    const globalShortcuts = { ...(this._ctx.settingsState.get().globalShortcuts || {}) };
    if (normalizeKey(key) === normalizeKey(GLOBAL_SHORTCUTS[id].key)) {
      delete globalShortcuts[id];
    } else {
      globalShortcuts[id] = key;
    }
    this._ctx.settingsState.setProp('globalShortcuts', globalShortcuts);
    this._ctx.saveSettings();
    this.syncGlobalShortcutsToMain();
  }

  resetShortcut(id) {
    if (GLOBAL_SHORTCUTS[id]) {
      const globalShortcuts = { ...(this._ctx.settingsState.get().globalShortcuts || {}) };
      delete globalShortcuts[id];
      this._ctx.settingsState.setProp('globalShortcuts', globalShortcuts);
      this._ctx.saveSettings();
      this.syncGlobalShortcutsToMain();
      return;
    }
    const customShortcuts = this._ctx.settingsState.get().shortcuts || {};
    delete customShortcuts[id];
    this._ctx.settingsState.setProp('shortcuts', customShortcuts);
    this._ctx.saveSettings();
    this.registerAllShortcuts();
  }

  resetAllShortcuts() {
    this._ctx.settingsState.setProp('shortcuts', {});
    this._ctx.settingsState.setProp('terminalShortcuts', {});
    this._ctx.settingsState.setProp('globalShortcuts', {});
    this._ctx.settingsState.setProp('globalShortcutsEnabled', true);
    this._ctx.saveSettings();
    this.registerAllShortcuts();
    this.syncGlobalShortcutsToMain();
  }

  syncGlobalShortcutsToMain() {
    if (this.api?.tray?.updateGlobalShortcuts) {
      this.api.tray.updateGlobalShortcuts({
        overrides: this._ctx.settingsState.get().globalShortcuts || {},
        enabled: this._ctx.settingsState.get().globalShortcutsEnabled !== false
      });
    }
  }

  formatKeyForDisplay(key) {
    if (!key) return '';
    return key.split('+').map(part => {
      const p = part.trim();
      if (p.toLowerCase() === 'ctrl') return 'Ctrl';
      if (p.toLowerCase() === 'alt') return 'Alt';
      if (p.toLowerCase() === 'shift') return 'Shift';
      if (p.toLowerCase() === 'meta') return 'Win';
      if (p.toLowerCase() === 'tab') return 'Tab';
      if (p.toLowerCase() === 'escape') return 'Esc';
      return p.charAt(0).toUpperCase() + p.slice(1);
    }).join(' + ');
  }

  startShortcutCapture(id) {
    this._captureState.active = true;
    this._captureState.shortcutId = id;

    const overlay = document.createElement('div');
    overlay.className = 'shortcut-capture-overlay';
    overlay.innerHTML = `
      <div class="shortcut-capture-box">
        <div class="shortcut-capture-title">${t('shortcuts.pressKeys')}</div>
        <div class="shortcut-capture-preview">${t('shortcuts.waiting')}</div>
        <div class="shortcut-capture-hint">${t('shortcuts.pressEscapeToCancel')}</div>
        <div class="shortcut-capture-conflict" style="display: none;"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._captureState.overlay = overlay;

    const handleKeydown = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const key = getKeyFromEvent(e);
      const preview = overlay.querySelector('.shortcut-capture-preview');
      const conflictDiv = overlay.querySelector('.shortcut-capture-conflict');

      if (e.key === 'Escape') {
        this._endShortcutCapture();
        return;
      }

      const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
      const isFunctionKey = /^f\d+$/i.test(e.key);

      if (!hasModifier && !isFunctionKey) {
        preview.textContent = this.formatKeyForDisplay(key);
        conflictDiv.style.display = 'block';
        conflictDiv.textContent = t('shortcuts.modifierRequired');
        conflictDiv.className = 'shortcut-capture-conflict warning';
        return;
      }

      if (['ctrl', 'alt', 'shift', 'meta', 'control'].includes(e.key.toLowerCase())) {
        preview.textContent = this.formatKeyForDisplay(key) + '...';
        return;
      }

      preview.textContent = this.formatKeyForDisplay(key);

      const conflict = this.checkShortcutConflict(key, id);
      if (conflict) {
        conflictDiv.style.display = 'block';
        conflictDiv.textContent = t('shortcuts.conflictWith', { label: conflict.label });
        conflictDiv.className = 'shortcut-capture-conflict error';
        return;
      }

      conflictDiv.style.display = 'none';
      this._endShortcutCapture();
      this.applyShortcut(id, key);

      const btn = document.querySelector(`[data-shortcut-id="${id}"] .shortcut-key-btn`);
      if (btn) {
        btn.textContent = this.formatKeyForDisplay(key);
      }
    };

    document.addEventListener('keydown', handleKeydown, true);
    this._captureState.keydownHandler = handleKeydown;
  }

  _endShortcutCapture() {
    if (this._captureState.overlay) {
      this._captureState.overlay.remove();
    }
    if (this._captureState.keydownHandler) {
      document.removeEventListener('keydown', this._captureState.keydownHandler, true);
    }
    this._captureState = { active: false, shortcutId: null, overlay: null, keydownHandler: null };
  }

  renderShortcutsPanel() {
    const customShortcuts = this._ctx.settingsState.get().shortcuts || {};

    let html = `
      <div class="settings-group">
        <div class="settings-group-title">${t('shortcuts.title')}</div>
        <div class="settings-card">
        <div class="shortcuts-list">
    `;

    for (const [id] of Object.entries(DEFAULT_SHORTCUTS)) {
      const currentKey = this.getShortcutKey(id);
      const isCustom = customShortcuts[id] !== undefined;

      html += `
        <div class="shortcut-row" data-shortcut-id="${id}">
          <div class="shortcut-label">${this.getShortcutLabel(id)}</div>
          <div class="shortcut-controls">
            <button type="button" class="shortcut-key-btn ${isCustom ? 'custom' : ''}" title="${t('shortcuts.clickToEdit')}">
              ${this.formatKeyForDisplay(currentKey)}
            </button>
            ${isCustom ? `<button type="button" class="shortcut-reset-btn" title="${t('shortcuts.reset')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>` : ''}
          </div>
        </div>
      `;
    }

    html += `
        </div>
        <div class="shortcuts-actions">
          <button type="button" class="btn-reset-shortcuts" id="btn-reset-all-shortcuts">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
            ${t('shortcuts.resetAll')}
          </button>
        </div>
        </div>
      </div>
    `;

    const globalOverrides = this._ctx.settingsState.get().globalShortcuts || {};
    const globalEnabled = this._ctx.settingsState.get().globalShortcutsEnabled !== false;

    html += `
      <div class="settings-group">
        <div class="settings-group-title">
          ${t('shortcuts.globalShortcutsTitle')}
          <label class="settings-toggle" style="margin-left: auto;">
            <input type="checkbox" id="toggle-global-shortcuts" ${globalEnabled ? 'checked' : ''}>
            <span class="settings-toggle-slider"></span>
          </label>
        </div>
        <div class="settings-group-description">${t('shortcuts.globalShortcutsDescription')}</div>
        <div class="settings-card ${!globalEnabled ? 'disabled' : ''}" id="global-shortcuts-card">
          <div class="shortcuts-list">
    `;

    for (const [id] of Object.entries(GLOBAL_SHORTCUTS)) {
      const currentKey = this.getShortcutKey(id);
      const isCustom = globalOverrides[id] !== undefined;

      html += `
        <div class="shortcut-row" data-shortcut-id="${id}">
          <div class="shortcut-label">${this.getShortcutLabel(id)}</div>
          <div class="shortcut-controls">
            <button type="button" class="shortcut-key-btn ${isCustom ? 'custom' : ''}" title="${t('shortcuts.clickToEdit')}">
              ${this.formatKeyForDisplay(currentKey)}
            </button>
            ${isCustom ? `<button type="button" class="shortcut-reset-btn" title="${t('shortcuts.reset')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>` : ''}
          </div>
        </div>
      `;
    }

    html += `
          </div>
        </div>
      </div>
    `;

    const terminalShortcuts = this._ctx.settingsState.get().terminalShortcuts || {};

    html += `
      <div class="settings-group">
        <div class="settings-group-title">${t('shortcuts.terminalShortcutsTitle')}</div>
        <div class="settings-card">
          <div class="shortcuts-list">
    `;

    for (const [id, config] of Object.entries(TERMINAL_SHORTCUTS)) {
      const isEnabled = terminalShortcuts[id]?.enabled !== undefined
        ? terminalShortcuts[id].enabled
        : config.defaultEnabled;

      html += `
        <div class="shortcut-row">
          <div class="shortcut-label">${t(config.labelKey)}</div>
          <div class="shortcut-controls">
            <label class="settings-toggle">
              <input type="checkbox" class="terminal-shortcut-toggle" data-shortcut-id="${id}" ${isEnabled ? 'checked' : ''}>
              <span class="settings-toggle-slider"></span>
            </label>
          </div>
        </div>
      `;
    }

    html += `
          </div>
        </div>
      </div>
    `;

    return html;
  }

  setupShortcutsPanelHandlers() {
    document.querySelectorAll('.shortcut-key-btn').forEach(btn => {
      btn.onclick = (e) => {
        const row = e.target.closest('.shortcut-row');
        const id = row.dataset.shortcutId;
        this.startShortcutCapture(id);
      };
    });

    document.querySelectorAll('.shortcut-reset-btn').forEach(btn => {
      btn.onclick = (e) => {
        const row = e.target.closest('.shortcut-row');
        const id = row.dataset.shortcutId;
        this.resetShortcut(id);
        const panel = document.querySelector('[data-panel="shortcuts"]');
        if (panel) {
          panel.innerHTML = this.renderShortcutsPanel();
          this.setupShortcutsPanelHandlers();
        }
      };
    });

    const globalToggle = document.getElementById('toggle-global-shortcuts');
    if (globalToggle) {
      globalToggle.onchange = () => {
        this._ctx.settingsState.setProp('globalShortcutsEnabled', globalToggle.checked);
        this._ctx.saveSettings();
        this.syncGlobalShortcutsToMain();
        const panel = document.querySelector('[data-panel="shortcuts"]');
        if (panel) {
          panel.innerHTML = this.renderShortcutsPanel();
          this.setupShortcutsPanelHandlers();
        }
      };
    }

    document.querySelectorAll('.terminal-shortcut-toggle').forEach(toggle => {
      toggle.onchange = () => {
        const id = toggle.dataset.shortcutId;
        const terminalShortcuts = { ...(this._ctx.settingsState.get().terminalShortcuts || {}) };
        terminalShortcuts[id] = { ...terminalShortcuts[id], enabled: toggle.checked };
        this._ctx.settingsState.setProp('terminalShortcuts', terminalShortcuts);
        this._ctx.saveSettings();
        if (id === 'ctrlTab') {
          if (this.api?.window?.setCtrlTabEnabled) {
            this.api.window.setCtrlTabEnabled(toggle.checked);
          }
        }
      };
    });

    const resetAllBtn = document.getElementById('btn-reset-all-shortcuts');
    if (resetAllBtn) {
      resetAllBtn.onclick = () => {
        this.resetAllShortcuts();
        const panel = document.querySelector('[data-panel="shortcuts"]');
        if (panel) {
          panel.innerHTML = this.renderShortcutsPanel();
          this.setupShortcutsPanelHandlers();
        }
      };
    }
  }

  registerAllShortcuts() {
    clearAllShortcuts();
    initKeyboardShortcuts();

    registerShortcut(this.getShortcutKey('openSettings'), () => this._ctx.switchToSettingsTab(), { global: true });

    registerShortcut(this.getShortcutKey('closeTerminal'), () => {
      const currentId = this._ctx.terminalsState.get().activeTerminal;
      if (currentId) {
        this._ctx.TerminalManager.closeTerminal(currentId);
      }
    }, { global: true });

    registerShortcut(this.getShortcutKey('showSessionsPanel'), () => {
      const selectedFilter = this._ctx.projectsState.get().selectedProjectFilter;
      const projects = this._ctx.projectsState.get().projects;
      if (selectedFilter !== null && projects[selectedFilter]) {
        this._ctx.showSessionsModal(projects[selectedFilter]);
      } else if (projects.length > 0) {
        this._ctx.setSelectedProjectFilter(0);
        this._ctx.ProjectList.render();
        this._ctx.showSessionsModal(projects[0]);
      }
    }, { global: true });

    registerShortcut(this.getShortcutKey('newProject'), () => {
      document.getElementById('btn-new-project').click();
    }, { global: true });

    registerShortcut(this.getShortcutKey('newTerminal'), () => {
      const selectedFilter = this._ctx.projectsState.get().selectedProjectFilter;
      const projects = this._ctx.projectsState.get().projects;
      if (selectedFilter !== null && projects[selectedFilter]) {
        this._ctx.createTerminalForProject(projects[selectedFilter]);
      }
    }, { global: true });

    registerShortcut(this.getShortcutKey('toggleFileExplorer'), () => {
      this._ctx.FileExplorer.toggle();
    }, { global: true });
  }

  destroy() {
    this._endShortcutCapture();
    super.destroy();
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function init(context) {
  const { getApiProvider, getContainer } = require('../../core');
  _instance = new ShortcutsManager(null, {
    api: getApiProvider(),
    container: getContainer(),
    ctx: context
  });
}

module.exports = {
  ShortcutsManager,
  init,
  renderShortcutsPanel: (...a) => _instance.renderShortcutsPanel(...a),
  setupShortcutsPanelHandlers: (...a) => _instance.setupShortcutsPanelHandlers(...a),
  registerAllShortcuts: (...a) => _instance.registerAllShortcuts(...a),
  getShortcutKey: (...a) => _instance.getShortcutKey(...a),
  formatKeyForDisplay: (...a) => _instance.formatKeyForDisplay(...a),
  syncGlobalShortcutsToMain: (...a) => _instance.syncGlobalShortcutsToMain(...a)
};
