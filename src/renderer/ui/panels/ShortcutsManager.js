/**
 * ShortcutsManager Panel
 * Keyboard shortcuts configuration and capture UI
 * Extracted from renderer.js
 */

const { t } = require('../../i18n');
const {
  initKeyboardShortcuts,
  registerShortcut,
  clearAllShortcuts,
  getKeyFromEvent,
  normalizeKey
} = require('../../features/KeyboardShortcuts');

let ctx = null;

const DEFAULT_SHORTCUTS = {
  openSettings: { key: 'Ctrl+,', labelKey: 'shortcuts.openSettings' },
  closeTerminal: { key: 'Ctrl+W', labelKey: 'shortcuts.closeTerminal' },
  showSessionsPanel: { key: 'Ctrl+Shift+E', labelKey: 'shortcuts.sessionsPanel' },
  openQuickPicker: { key: 'Ctrl+Shift+P', labelKey: 'shortcuts.quickPicker' },
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

let shortcutCaptureState = {
  active: false,
  shortcutId: null,
  overlay: null
};

function init(context) {
  ctx = context;
}

function getShortcutLabel(id) {
  const shortcut = DEFAULT_SHORTCUTS[id] || GLOBAL_SHORTCUTS[id];
  return shortcut ? t(shortcut.labelKey) : id;
}

function getShortcutKey(id) {
  if (GLOBAL_SHORTCUTS[id]) {
    const globalOverrides = ctx.settingsState.get().globalShortcuts || {};
    return globalOverrides[id] || GLOBAL_SHORTCUTS[id].key;
  }
  const customShortcuts = ctx.settingsState.get().shortcuts || {};
  return customShortcuts[id] || DEFAULT_SHORTCUTS[id]?.key || '';
}

function checkShortcutConflict(key, excludeId) {
  const normalizedKey = normalizeKey(key);
  // Check app shortcuts
  for (const [id] of Object.entries(DEFAULT_SHORTCUTS)) {
    if (id === excludeId) continue;
    const currentKey = getShortcutKey(id);
    if (normalizeKey(currentKey) === normalizedKey) {
      return { id, label: getShortcutLabel(id) };
    }
  }
  // Check global shortcuts
  for (const [id] of Object.entries(GLOBAL_SHORTCUTS)) {
    if (id === excludeId) continue;
    const currentKey = getShortcutKey(id);
    if (normalizeKey(currentKey) === normalizedKey) {
      return { id, label: getShortcutLabel(id) };
    }
  }
  return null;
}

function applyShortcut(id, key) {
  if (GLOBAL_SHORTCUTS[id]) {
    applyGlobalShortcut(id, key);
    return;
  }
  const customShortcuts = ctx.settingsState.get().shortcuts || {};
  if (normalizeKey(key) === normalizeKey(DEFAULT_SHORTCUTS[id]?.key || '')) {
    delete customShortcuts[id];
  } else {
    customShortcuts[id] = key;
  }
  ctx.settingsState.setProp('shortcuts', customShortcuts);
  ctx.saveSettings();
  registerAllShortcuts();
}

function applyGlobalShortcut(id, key) {
  const globalShortcuts = { ...(ctx.settingsState.get().globalShortcuts || {}) };
  if (normalizeKey(key) === normalizeKey(GLOBAL_SHORTCUTS[id].key)) {
    delete globalShortcuts[id];
  } else {
    globalShortcuts[id] = key;
  }
  ctx.settingsState.setProp('globalShortcuts', globalShortcuts);
  ctx.saveSettings();
  syncGlobalShortcutsToMain();
}

function resetShortcut(id) {
  if (GLOBAL_SHORTCUTS[id]) {
    const globalShortcuts = { ...(ctx.settingsState.get().globalShortcuts || {}) };
    delete globalShortcuts[id];
    ctx.settingsState.setProp('globalShortcuts', globalShortcuts);
    ctx.saveSettings();
    syncGlobalShortcutsToMain();
    return;
  }
  const customShortcuts = ctx.settingsState.get().shortcuts || {};
  delete customShortcuts[id];
  ctx.settingsState.setProp('shortcuts', customShortcuts);
  ctx.saveSettings();
  registerAllShortcuts();
}

function resetAllShortcuts() {
  ctx.settingsState.setProp('shortcuts', {});
  ctx.settingsState.setProp('terminalShortcuts', {});
  ctx.settingsState.setProp('globalShortcuts', {});
  ctx.settingsState.setProp('globalShortcutsEnabled', true);
  ctx.saveSettings();
  registerAllShortcuts();
  syncGlobalShortcutsToMain();
}

/**
 * Send current global shortcut config to the main process for re-registration
 */
function syncGlobalShortcutsToMain() {
  const api = window.electron_api;
  if (api?.tray?.updateGlobalShortcuts) {
    api.tray.updateGlobalShortcuts({
      overrides: ctx.settingsState.get().globalShortcuts || {},
      enabled: ctx.settingsState.get().globalShortcutsEnabled !== false
    });
  }
}

function formatKeyForDisplay(key) {
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

function startShortcutCapture(id) {
  shortcutCaptureState.active = true;
  shortcutCaptureState.shortcutId = id;

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
  shortcutCaptureState.overlay = overlay;

  const handleKeydown = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const key = getKeyFromEvent(e);
    const preview = overlay.querySelector('.shortcut-capture-preview');
    const conflictDiv = overlay.querySelector('.shortcut-capture-conflict');

    if (e.key === 'Escape') {
      endShortcutCapture();
      return;
    }

    const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
    const isFunctionKey = /^f\d+$/i.test(e.key);

    if (!hasModifier && !isFunctionKey) {
      preview.textContent = formatKeyForDisplay(key);
      conflictDiv.style.display = 'block';
      conflictDiv.textContent = t('shortcuts.modifierRequired');
      conflictDiv.className = 'shortcut-capture-conflict warning';
      return;
    }

    if (['ctrl', 'alt', 'shift', 'meta', 'control'].includes(e.key.toLowerCase())) {
      preview.textContent = formatKeyForDisplay(key) + '...';
      return;
    }

    preview.textContent = formatKeyForDisplay(key);

    const conflict = checkShortcutConflict(key, id);
    if (conflict) {
      conflictDiv.style.display = 'block';
      conflictDiv.textContent = t('shortcuts.conflictWith', { label: conflict.label });
      conflictDiv.className = 'shortcut-capture-conflict error';
      return;
    }

    conflictDiv.style.display = 'none';
    endShortcutCapture();
    applyShortcut(id, key);

    const btn = document.querySelector(`[data-shortcut-id="${id}"] .shortcut-key-btn`);
    if (btn) {
      btn.textContent = formatKeyForDisplay(key);
    }
  };

  document.addEventListener('keydown', handleKeydown, true);
  shortcutCaptureState.keydownHandler = handleKeydown;
}

function endShortcutCapture() {
  if (shortcutCaptureState.overlay) {
    shortcutCaptureState.overlay.remove();
  }
  if (shortcutCaptureState.keydownHandler) {
    document.removeEventListener('keydown', shortcutCaptureState.keydownHandler, true);
  }
  shortcutCaptureState = { active: false, shortcutId: null, overlay: null };
}

function renderShortcutsPanel() {
  const customShortcuts = ctx.settingsState.get().shortcuts || {};

  let html = `
    <div class="settings-group">
      <div class="settings-group-title">${t('shortcuts.title')}</div>
      <div class="settings-card">
      <div class="shortcuts-list">
  `;

  for (const [id] of Object.entries(DEFAULT_SHORTCUTS)) {
    const currentKey = getShortcutKey(id);
    const isCustom = customShortcuts[id] !== undefined;

    html += `
      <div class="shortcut-row" data-shortcut-id="${id}">
        <div class="shortcut-label">${getShortcutLabel(id)}</div>
        <div class="shortcut-controls">
          <button type="button" class="shortcut-key-btn ${isCustom ? 'custom' : ''}" title="${t('shortcuts.clickToEdit')}">
            ${formatKeyForDisplay(currentKey)}
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

  // Global shortcuts section
  const globalOverrides = ctx.settingsState.get().globalShortcuts || {};
  const globalEnabled = ctx.settingsState.get().globalShortcutsEnabled !== false;

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
    const currentKey = getShortcutKey(id);
    const isCustom = globalOverrides[id] !== undefined;

    html += `
      <div class="shortcut-row" data-shortcut-id="${id}">
        <div class="shortcut-label">${getShortcutLabel(id)}</div>
        <div class="shortcut-controls">
          <button type="button" class="shortcut-key-btn ${isCustom ? 'custom' : ''}" title="${t('shortcuts.clickToEdit')}">
            ${formatKeyForDisplay(currentKey)}
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

  // Terminal shortcuts section
  const terminalShortcuts = ctx.settingsState.get().terminalShortcuts || {};

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

function setupShortcutsPanelHandlers() {
  document.querySelectorAll('.shortcut-key-btn').forEach(btn => {
    btn.onclick = (e) => {
      const row = e.target.closest('.shortcut-row');
      const id = row.dataset.shortcutId;
      startShortcutCapture(id);
    };
  });

  document.querySelectorAll('.shortcut-reset-btn').forEach(btn => {
    btn.onclick = (e) => {
      const row = e.target.closest('.shortcut-row');
      const id = row.dataset.shortcutId;
      resetShortcut(id);
      const panel = document.querySelector('[data-panel="shortcuts"]');
      if (panel) {
        panel.innerHTML = renderShortcutsPanel();
        setupShortcutsPanelHandlers();
      }
    };
  });

  // Global shortcuts master toggle
  const globalToggle = document.getElementById('toggle-global-shortcuts');
  if (globalToggle) {
    globalToggle.onchange = () => {
      ctx.settingsState.setProp('globalShortcutsEnabled', globalToggle.checked);
      ctx.saveSettings();
      syncGlobalShortcutsToMain();
      // Re-render to update disabled state
      const panel = document.querySelector('[data-panel="shortcuts"]');
      if (panel) {
        panel.innerHTML = renderShortcutsPanel();
        setupShortcutsPanelHandlers();
      }
    };
  }

  document.querySelectorAll('.terminal-shortcut-toggle').forEach(toggle => {
    toggle.onchange = () => {
      const id = toggle.dataset.shortcutId;
      const terminalShortcuts = { ...(ctx.settingsState.get().terminalShortcuts || {}) };
      terminalShortcuts[id] = { ...terminalShortcuts[id], enabled: toggle.checked };
      ctx.settingsState.setProp('terminalShortcuts', terminalShortcuts);
      ctx.saveSettings();
      // Sync Ctrl+Tab enabled state to main process
      if (id === 'ctrlTab') {
        const api = window.electron_api;
        if (api?.window?.setCtrlTabEnabled) {
          api.window.setCtrlTabEnabled(toggle.checked);
        }
      }
    };
  });

  const resetAllBtn = document.getElementById('btn-reset-all-shortcuts');
  if (resetAllBtn) {
    resetAllBtn.onclick = () => {
      resetAllShortcuts();
      const panel = document.querySelector('[data-panel="shortcuts"]');
      if (panel) {
        panel.innerHTML = renderShortcutsPanel();
        setupShortcutsPanelHandlers();
      }
    };
  }
}

function registerAllShortcuts() {
  clearAllShortcuts();
  initKeyboardShortcuts();

  registerShortcut(getShortcutKey('openSettings'), () => ctx.switchToSettingsTab(), { global: true });

  registerShortcut(getShortcutKey('closeTerminal'), () => {
    const currentId = ctx.terminalsState.get().activeTerminal;
    if (currentId) {
      ctx.TerminalManager.closeTerminal(currentId);
    }
  }, { global: true });

  registerShortcut(getShortcutKey('showSessionsPanel'), () => {
    const selectedFilter = ctx.projectsState.get().selectedProjectFilter;
    const projects = ctx.projectsState.get().projects;
    if (selectedFilter !== null && projects[selectedFilter]) {
      ctx.showSessionsModal(projects[selectedFilter]);
    } else if (projects.length > 0) {
      ctx.setSelectedProjectFilter(0);
      ctx.ProjectList.render();
      ctx.showSessionsModal(projects[0]);
    }
  }, { global: true });

  registerShortcut(getShortcutKey('openQuickPicker'), () => {
    const { projects, selectedProjectFilter } = ctx.projectsState.get();
    const currentProject = selectedProjectFilter !== null ? projects[selectedProjectFilter] : null;
    ctx.openQuickPicker(document.body, {
      currentProject,
      onSelectProject: (project) => {
        const projectIndex = ctx.getProjectIndex(project.id);
        ctx.setSelectedProjectFilter(projectIndex);
        ctx.ProjectList.render();
        ctx.TerminalManager.filterByProject(projectIndex);
        ctx.createTerminalForProject(project);
      },
    });
  }, { global: true });

  registerShortcut(getShortcutKey('newProject'), () => {
    document.getElementById('btn-new-project').click();
  }, { global: true });

  registerShortcut(getShortcutKey('newTerminal'), () => {
    const selectedFilter = ctx.projectsState.get().selectedProjectFilter;
    const projects = ctx.projectsState.get().projects;
    if (selectedFilter !== null && projects[selectedFilter]) {
      ctx.createTerminalForProject(projects[selectedFilter]);
    }
  }, { global: true });

  registerShortcut(getShortcutKey('toggleFileExplorer'), () => {
    ctx.FileExplorer.toggle();
  }, { global: true });
}

module.exports = {
  init,
  renderShortcutsPanel,
  setupShortcutsPanelHandlers,
  registerAllShortcuts,
  getShortcutKey,
  formatKeyForDisplay,
  syncGlobalShortcutsToMain
};
