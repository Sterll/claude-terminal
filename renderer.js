/**
 * Claude Terminal - Renderer Process
 * Main entry point - orchestrates all modules
 */

// With contextIsolation: true, we use the preload API
// The API is exposed via contextBridge in preload.js
const api = window.electron_api;
const { path, fs, process: nodeProcess, __dirname } = window.electron_nodeModules;

// Pause all CSS animations when window is hidden to reduce CPU usage
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('background-paused', document.hidden);
});

// Import all modules from src/renderer
const {
  // Utils
  escapeHtml,
  applyAccentColor,
  ensureDirectories,
  dataDir,
  skillsDir,
  agentsDir,
  claudeSettingsFile,
  claudeConfigFile,

  // State
  projectsState,
  terminalsState,
  settingsState,
  fivemState,
  contextMenuState,
  dragState,
  getFolder,
  getProject,
  getProjectIndex,
  getVisualProjectOrder,
  countProjectsRecursive,
  toggleFolderCollapse,
  loadProjects,
  saveProjects,
  loadSettings,
  saveSettings,
  saveSettingsImmediate,
  createFolder,
  deleteFolder,
  renameFolder,
  renameProject,
  setSelectedProjectFilter,
  generateProjectId,
  initializeState,

  // Services
  services: { DashboardService, FivemService, TimeTrackingDashboard, GitTabService },

  // UI Components
  ProjectList,
  TerminalManager,
  FileExplorer,
  showContextMenu,
  hideContextMenu,

  // Features
  initKeyboardShortcuts,
  registerShortcut,
  clearAllShortcuts,
  getKeyFromEvent,
  normalizeKey,
  openQuickPicker,

  // i18n
  t,
  initI18n,
  setLanguage,
  getCurrentLanguage,
  getAvailableLanguages,
  onLanguageChange,

  // Time Tracking
  getProjectTimes,

  // Themes
  TERMINAL_THEMES,

  // Quick Actions
  QuickActions
} = require('./src/renderer');

const registry = require('./src/project-types/registry');
const { mergeTranslations } = require('./src/renderer/i18n');

// ========== LOCAL MODAL FUNCTIONS ==========
// These work with the existing HTML modal elements in index.html
function showModal(title, content, footer = '') {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = content;
  const footerEl = document.getElementById('modal-footer');
  footerEl.innerHTML = footer;
  footerEl.style.display = footer ? 'flex' : 'none';
  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}

// ========== LOCAL STATE ==========
const localState = {
  skills: [],
  agents: [],
  mcps: [],
  mcpProcesses: {},
  selectedMcp: null,
  mcpLogsCollapsed: false,
  mcpActiveSubTab: 'local',
  mcpRegistryInitialized: false,
  mcpRegistry: {
    servers: [],
    searchResults: [],
    searchQuery: '',
    searchCache: new Map()
  },
  notificationsEnabled: true,
  fivemServers: new Map(),
  gitOperations: new Map(),
  gitRepoStatus: new Map(),
  selectedDashboardProject: -1,
  pluginsActiveSubTab: 'discover',
  pluginsInitialized: false,
  pluginsData: {
    catalog: [],
    installed: [],
    marketplaces: [],
    searchQuery: '',
    activeCategory: 'all'
  },
  skillsActiveSubTab: 'local',
  skillsInitialized: false,
  marketplace: {
    searchResults: [],
    featured: [],
    installed: [],
    loading: false,
    searchQuery: '',
    searchCache: new Map()
  }
};

// ========== I18N STATIC TEXT UPDATES ==========
// Update all elements with data-i18n attribute
function updateStaticTranslations() {
  // Text content: data-i18n="key"
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });

  // Title attribute: data-i18n-title="key"
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.title = t(key);
  });

  // Placeholder attribute: data-i18n-placeholder="key"
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key);
  });
}

// Listen for language changes
onLanguageChange(() => {
  updateStaticTranslations();
});

// ========== DEFAULT KEYBOARD SHORTCUTS ==========
// Labels will be resolved using t() when needed
const DEFAULT_SHORTCUTS = {
  openSettings: { key: 'Ctrl+,', labelKey: 'shortcuts.openSettings' },
  closeTerminal: { key: 'Ctrl+W', labelKey: 'shortcuts.closeTerminal' },
  showSessionsPanel: { key: 'Ctrl+Shift+E', labelKey: 'shortcuts.sessionsPanel' },
  openQuickPicker: { key: 'Ctrl+Shift+P', labelKey: 'shortcuts.quickPicker' },
  newProject: { key: 'Ctrl+N', labelKey: 'shortcuts.newProject' },
  newTerminal: { key: 'Ctrl+T', labelKey: 'shortcuts.newTerminal' },
  toggleFileExplorer: { key: 'Ctrl+E', labelKey: 'shortcuts.toggleFileExplorer' }
};

/**
 * Get label for a shortcut (translated)
 */
function getShortcutLabel(id) {
  const shortcut = DEFAULT_SHORTCUTS[id];
  return shortcut ? t(shortcut.labelKey) : id;
}

// Shortcut capture state
let shortcutCaptureState = {
  active: false,
  shortcutId: null,
  overlay: null
};

/**
 * Get the current key for a shortcut (custom or default)
 */
function getShortcutKey(id) {
  const customShortcuts = settingsState.get().shortcuts || {};
  return customShortcuts[id] || DEFAULT_SHORTCUTS[id]?.key || '';
}

/**
 * Check if a key combination conflicts with another shortcut
 */
function checkShortcutConflict(key, excludeId) {
  const normalizedKey = normalizeKey(key);
  for (const [id, shortcut] of Object.entries(DEFAULT_SHORTCUTS)) {
    if (id === excludeId) continue;
    const currentKey = getShortcutKey(id);
    if (normalizeKey(currentKey) === normalizedKey) {
      return { id, label: getShortcutLabel(id) };
    }
  }
  return null;
}

/**
 * Apply a new shortcut
 */
function applyShortcut(id, key) {
  const customShortcuts = settingsState.get().shortcuts || {};
  // If key is same as default, remove the override
  if (normalizeKey(key) === normalizeKey(DEFAULT_SHORTCUTS[id]?.key || '')) {
    delete customShortcuts[id];
  } else {
    customShortcuts[id] = key;
  }
  settingsState.setProp('shortcuts', customShortcuts);
  saveSettings();
  // Re-register all shortcuts
  registerAllShortcuts();
}

/**
 * Reset a shortcut to default
 */
function resetShortcut(id) {
  const customShortcuts = settingsState.get().shortcuts || {};
  delete customShortcuts[id];
  settingsState.setProp('shortcuts', customShortcuts);
  saveSettings();
  registerAllShortcuts();
}

/**
 * Reset all shortcuts to defaults
 */
function resetAllShortcuts() {
  settingsState.setProp('shortcuts', {});
  saveSettings();
  registerAllShortcuts();
}

/**
 * Format key for display
 */
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

/**
 * Start shortcut capture mode
 */
function startShortcutCapture(id) {
  shortcutCaptureState.active = true;
  shortcutCaptureState.shortcutId = id;

  // Create overlay
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

  // Handle keydown
  const handleKeydown = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const key = getKeyFromEvent(e);
    const preview = overlay.querySelector('.shortcut-capture-preview');
    const conflictDiv = overlay.querySelector('.shortcut-capture-conflict');

    // Escape cancels
    if (e.key === 'Escape') {
      endShortcutCapture();
      return;
    }

    // Need at least one modifier for non-function keys
    const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
    const isFunctionKey = /^f\d+$/i.test(e.key);

    if (!hasModifier && !isFunctionKey) {
      preview.textContent = formatKeyForDisplay(key);
      conflictDiv.style.display = 'block';
      conflictDiv.textContent = t('shortcuts.modifierRequired');
      conflictDiv.className = 'shortcut-capture-conflict warning';
      return;
    }

    // Check only modifier pressed
    if (['ctrl', 'alt', 'shift', 'meta', 'control'].includes(e.key.toLowerCase())) {
      preview.textContent = formatKeyForDisplay(key) + '...';
      return;
    }

    preview.textContent = formatKeyForDisplay(key);

    // Check for conflicts
    const conflict = checkShortcutConflict(key, id);
    if (conflict) {
      conflictDiv.style.display = 'block';
      conflictDiv.textContent = t('shortcuts.conflictWith', { label: conflict.label });
      conflictDiv.className = 'shortcut-capture-conflict error';
      return;
    }

    // Valid key combination - apply it
    conflictDiv.style.display = 'none';
    endShortcutCapture();
    applyShortcut(id, key);

    // Update the button in settings if modal is open
    const btn = document.querySelector(`[data-shortcut-id="${id}"] .shortcut-key-btn`);
    if (btn) {
      btn.textContent = formatKeyForDisplay(key);
    }
  };

  document.addEventListener('keydown', handleKeydown, true);
  shortcutCaptureState.keydownHandler = handleKeydown;
}

/**
 * End shortcut capture mode
 */
function endShortcutCapture() {
  if (shortcutCaptureState.overlay) {
    shortcutCaptureState.overlay.remove();
  }
  if (shortcutCaptureState.keydownHandler) {
    document.removeEventListener('keydown', shortcutCaptureState.keydownHandler, true);
  }
  shortcutCaptureState = { active: false, shortcutId: null, overlay: null };
}

/**
 * Render shortcuts panel content
 */
function renderShortcutsPanel() {
  const customShortcuts = settingsState.get().shortcuts || {};

  let html = `
    <div class="settings-section">
      <div class="settings-title">${t('shortcuts.title')}</div>
      <div class="shortcuts-list">
  `;

  for (const [id, shortcut] of Object.entries(DEFAULT_SHORTCUTS)) {
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
  `;

  return html;
}

/**
 * Setup shortcuts panel event handlers
 */
function setupShortcutsPanelHandlers() {
  // Click on shortcut key button to edit
  document.querySelectorAll('.shortcut-key-btn').forEach(btn => {
    btn.onclick = (e) => {
      const row = e.target.closest('.shortcut-row');
      const id = row.dataset.shortcutId;
      startShortcutCapture(id);
    };
  });

  // Click on reset button
  document.querySelectorAll('.shortcut-reset-btn').forEach(btn => {
    btn.onclick = (e) => {
      const row = e.target.closest('.shortcut-row');
      const id = row.dataset.shortcutId;
      resetShortcut(id);
      // Update UI
      const panel = document.querySelector('[data-panel="shortcuts"]');
      if (panel) {
        panel.innerHTML = renderShortcutsPanel();
        setupShortcutsPanelHandlers();
      }
    };
  });

  // Reset all button
  const resetAllBtn = document.getElementById('btn-reset-all-shortcuts');
  if (resetAllBtn) {
    resetAllBtn.onclick = () => {
      resetAllShortcuts();
      // Update UI
      const panel = document.querySelector('[data-panel="shortcuts"]');
      if (panel) {
        panel.innerHTML = renderShortcutsPanel();
        setupShortcutsPanelHandlers();
      }
    };
  }
}

/**
 * Register all keyboard shortcuts based on settings
 */
function registerAllShortcuts() {
  // Clear existing shortcuts
  clearAllShortcuts();

  // Re-initialize the keyboard shortcut system
  initKeyboardShortcuts();

  // Register settings shortcut
  registerShortcut(getShortcutKey('openSettings'), () => switchToSettingsTab(), { global: true });

  // Close current terminal
  registerShortcut(getShortcutKey('closeTerminal'), () => {
    const currentId = terminalsState.get().activeTerminal;
    if (currentId) {
      TerminalManager.closeTerminal(currentId);
    }
  }, { global: true });

  // Show sessions panel
  registerShortcut(getShortcutKey('showSessionsPanel'), () => {
    const selectedFilter = projectsState.get().selectedProjectFilter;
    const projects = projectsState.get().projects;
    if (selectedFilter !== null && projects[selectedFilter]) {
      showSessionsModal(projects[selectedFilter]);
    } else if (projects.length > 0) {
      setSelectedProjectFilter(0);
      ProjectList.render();
      showSessionsModal(projects[0]);
    }
  }, { global: true });

  // Quick picker
  registerShortcut(getShortcutKey('openQuickPicker'), () => {
    openQuickPicker(document.body, (project) => {
      const projectIndex = getProjectIndex(project.id);
      setSelectedProjectFilter(projectIndex);
      ProjectList.render();
      TerminalManager.filterByProject(projectIndex);
      createTerminalForProject(project);
    });
  }, { global: true });

  // New project
  registerShortcut(getShortcutKey('newProject'), () => {
    document.getElementById('btn-new-project').click();
  }, { global: true });

  // New terminal for current project
  registerShortcut(getShortcutKey('newTerminal'), () => {
    const selectedFilter = projectsState.get().selectedProjectFilter;
    const projects = projectsState.get().projects;
    if (selectedFilter !== null && projects[selectedFilter]) {
      createTerminalForProject(projects[selectedFilter]);
    }
  }, { global: true });

  // Toggle file explorer
  registerShortcut(getShortcutKey('toggleFileExplorer'), () => {
    FileExplorer.toggle();
  }, { global: true });
}

// ========== INITIALIZATION ==========
ensureDirectories();
initializeState(); // This loads settings, projects AND initializes time tracking
initI18n(settingsState.get().language); // Initialize i18n with saved language preference

// Initialize project types registry
registry.discoverAll();
registry.loadAllTranslations(mergeTranslations);
registry.injectAllStyles();

// Preload dashboard data in background at startup
DashboardService.loadAllDiskCaches();
setTimeout(() => DashboardService.preloadAllProjects(), 1000);
updateStaticTranslations(); // Apply translations to static HTML elements
applyAccentColor(settingsState.get().accentColor || '#d97706');
if (settingsState.get().compactProjects !== false) {
  document.body.classList.add('compact-projects');
}
if (settingsState.get().reduceMotion) {
  document.body.classList.add('reduce-motion');
}

// ========== NOTIFICATIONS ==========
function showNotification(type, title, body, terminalId) {
  if (!localState.notificationsEnabled) return;
  if (document.hasFocus() && terminalsState.get().activeTerminal === terminalId) return;
  const labels = { show: t('terminals.notifBtnShow') };
  api.notification.show({ type: 'done', title, body, terminalId, autoDismiss: 8000, labels });
}

api.notification.onClicked(({ terminalId }) => {
  if (terminalId) {
    // 1. Switch to claude tab first so terminal containers are visible
    document.querySelector('[data-tab="claude"]')?.click();
    // 2. Switch to the terminal's project so it becomes visible
    const termData = terminalsState.get().terminals.get(terminalId);
    if (termData && termData.projectIndex != null) {
      setSelectedProjectFilter(termData.projectIndex);
      ProjectList.render();
      TerminalManager.filterByProject(termData.projectIndex);
    }
    // 3. Activate the specific terminal (needs tab + project to be set first)
    TerminalManager.setActiveTerminal(terminalId);
  }
});


// ========== GIT STATUS ==========
async function checkAllProjectsGitStatus() {
  const projects = projectsState.get().projects;
  // Check all projects in parallel (batches of 5 to avoid overwhelming IPC)
  const BATCH_SIZE = 5;
  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (project) => {
      try {
        const result = await api.git.statusQuick({ projectPath: project.path });
        const status = { isGitRepo: result.isGitRepo };
        if (result.isGitRepo) {
          try {
            status.branch = await api.git.currentBranch({ projectPath: project.path });
          } catch (_) {}
        }
        localState.gitRepoStatus.set(project.id, status);
      } catch (e) {
        localState.gitRepoStatus.set(project.id, { isGitRepo: false });
      }
    }));
  }
  ProjectList.render();

  // Update filter git actions if a project is selected
  const selectedFilter = projectsState.get().selectedProjectFilter;
  if (selectedFilter !== null && projects[selectedFilter]) {
    // Will be called by showFilterGitActions
    const filterGitActions = document.getElementById('filter-git-actions');
    if (filterGitActions) {
      const project = projects[selectedFilter];
      const gitStatus = localState.gitRepoStatus.get(project.id);
      if (gitStatus && gitStatus.isGitRepo) {
        filterGitActions.style.display = 'flex';
        // Update branch name
        try {
          const branch = await api.git.currentBranch({ projectPath: project.path });
          const branchNameEl = document.getElementById('filter-branch-name');
          if (branchNameEl) branchNameEl.textContent = branch || 'main';
        } catch (e) { /* ignore */ }
      }
    }
  }
}

async function checkProjectGitStatus(project) {
  try {
    const result = await api.git.statusQuick({ projectPath: project.path });
    const status = { isGitRepo: result.isGitRepo };
    if (result.isGitRepo) {
      try {
        status.branch = await api.git.currentBranch({ projectPath: project.path });
      } catch (_) {}
    }
    localState.gitRepoStatus.set(project.id, status);
  } catch (e) {
    localState.gitRepoStatus.set(project.id, { isGitRepo: false });
  }
  ProjectList.render();

  // Update filter if this project is selected
  const selectedFilter = projectsState.get().selectedProjectFilter;
  const projects = projectsState.get().projects;
  if (selectedFilter !== null && projects[selectedFilter]?.id === project.id) {
    showFilterGitActions(project.id);
  }
}

// ========== TOAST NOTIFICATIONS ==========
const toastContainer = document.getElementById('toast-container');

/**
 * Show a toast notification
 * @param {Object} options - Toast options
 * @param {string} options.type - 'success' | 'error' | 'warning' | 'info'
 * @param {string} options.title - Toast title
 * @param {string} options.message - Toast message
 * @param {number} options.duration - Duration in ms (0 for no auto-hide)
 */
function showToast({ type = 'info', title, message, duration = 5000 }) {
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const displayMessage = message && message.length > 200 ? message.substring(0, 200) + '...' : message;
  // Escape HTML then convert newlines to <br> for proper display
  const formattedMessage = displayMessage ? escapeHtml(displayMessage).replace(/\n/g, '<br>') : '';

  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${formattedMessage ? `<div class="toast-message">${formattedMessage}</div>` : ''}
    </div>
    <button class="toast-close" aria-label="Fermer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  // Progress bar for auto-hide
  if (duration > 0) {
    const progressBar = document.createElement('div');
    progressBar.className = 'toast-progress';
    progressBar.style.animationDuration = `${duration}ms`;
    toast.appendChild(progressBar);
  }

  toastContainer.appendChild(toast);

  // Close button handler
  const closeToast = () => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  };

  toast.querySelector('.toast-close').onclick = closeToast;

  // Auto hide
  if (duration > 0) {
    setTimeout(closeToast, duration);
  }

  return toast;
}

// Backward compatible wrapper for showGitToast
function showGitToast({ success, title, message, details = [], duration = 5000 }) {
  // Format details into the message if available
  let fullMessage = message || '';
  if (details && Array.isArray(details) && details.length > 0) {
    const detailsText = details.map(d => `${d.icon} ${d.text}`).join('  •  ');
    fullMessage = fullMessage ? `${fullMessage}\n${detailsText}` : detailsText;
  }

  return showToast({
    type: success ? 'success' : 'error',
    title,
    message: fullMessage,
    duration
  });
}

// Parse git output to extract useful info
function parseGitPullOutput(output) {
  const details = [];

  if (!output) return { message: 'Déjà à jour', details };

  // Already up to date
  if (output.includes('Already up to date') || output.includes('Déjà à jour')) {
    return { message: 'Déjà à jour', details: [{ icon: '✓', text: 'Aucune modification' }] };
  }

  // Fast-forward merge
  const filesChanged = output.match(/(\d+) files? changed/);
  const insertions = output.match(/(\d+) insertions?\(\+\)/);
  const deletions = output.match(/(\d+) deletions?\(-\)/);
  const commits = output.match(/(\d+) commits?/);

  if (filesChanged) {
    details.push({ icon: '📄', text: `${filesChanged[1]} fichier${filesChanged[1] > 1 ? 's' : ''} modifié${filesChanged[1] > 1 ? 's' : ''}` });
  }
  if (insertions) {
    details.push({ icon: '+', text: `${insertions[1]} insertion${insertions[1] > 1 ? 's' : ''}` });
  }
  if (deletions) {
    details.push({ icon: '-', text: `${deletions[1]} suppression${deletions[1] > 1 ? 's' : ''}` });
  }

  return { message: '', details };
}

function parseGitPushOutput(output) {
  const details = [];

  if (!output) return { message: 'Modifications envoyées', details };

  // Everything up-to-date
  if (output.includes('Everything up-to-date')) {
    return { message: 'Déjà synchronisé', details: [{ icon: '✓', text: 'Aucune modification à envoyer' }] };
  }

  // Extract branch info
  const branchMatch = output.match(/(\w+)\.\.(\w+)\s+(\S+)\s+->\s+(\S+)/);
  if (branchMatch) {
    details.push({ icon: '↑', text: `${branchMatch[3]} → ${branchMatch[4]}` });
  }

  return { message: 'Modifications envoyées', details };
}

// ========== GIT OPERATIONS ==========

// Refresh dashboard async (stale-while-revalidate pattern)
function refreshDashboardAsync(projectId) {
  const projects = projectsState.get().projects;
  const projectIndex = projects.findIndex(p => p.id === projectId);

  // Only refresh if dashboard tab is active and this project is selected
  const dashboardTab = document.querySelector('[data-tab="dashboard"]');
  const isDashboardActive = dashboardTab?.classList.contains('active');
  const isProjectSelected = localState.selectedDashboardProject === projectIndex;

  if (isDashboardActive && isProjectSelected && projectIndex !== -1) {
    // Invalidate cache to force refresh, but keep old data visible
    DashboardService.invalidateCache(projectId);

    // Re-render - will show old data immediately then update when new data loads
    const content = document.getElementById('dashboard-content');
    const project = projects[projectIndex];
    if (content && project) {
      const terminalCount = TerminalManager.countTerminalsForProject(projectIndex);
      const fivemStatus = localState.fivemServers.get(projectIndex)?.status || 'stopped';

      DashboardService.renderDashboard(content, project, {
        terminalCount,
        fivemStatus,
        onOpenFolder: (p) => api.dialog.openInExplorer(p),
        onOpenClaude: (proj) => {
          createTerminalForProject(proj);
          document.querySelector('[data-tab="claude"]')?.click();
        },
        onGitPull: (pid) => gitPull(pid),
        onGitPush: (pid) => gitPush(pid),
        onMergeAbort: (pid) => gitMergeAbort(pid),
        onCopyPath: () => {}
      });
    }
  }
}

async function gitPull(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pulling: true });
  ProjectList.render();
  try {
    const result = await api.git.pull({ projectPath: project.path });

    // Handle merge conflicts
    if (result.hasConflicts) {
      localState.gitOperations.set(projectId, {
        ...localState.gitOperations.get(projectId),
        pulling: false,
        mergeInProgress: true,
        conflicts: result.conflicts || [],
        lastResult: result
      });
      ProjectList.render();

      showGitToast({
        success: false,
        title: 'Conflits de merge',
        message: `${result.conflicts?.length || 0} fichier(s) en conflit — Résolvez les conflits ou annulez le merge depuis le dashboard`,
        duration: 8000
      });

      // Refresh dashboard to show conflict UI
      refreshDashboardAsync(projectId);
      return;
    }

    localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pulling: false, lastResult: result });
    ProjectList.render();

    if (result.success) {
      const parsed = parseGitPullOutput(result.output);
      showGitToast({
        success: true,
        title: 'Pull réussi',
        message: parsed.message,
        details: parsed.details,
        duration: 4000
      });

      // Refresh dashboard async - keep old data, load new in background
      refreshDashboardAsync(projectId);
    } else {
      showGitToast({
        success: false,
        title: 'Erreur lors du pull',
        message: result.error || 'Une erreur est survenue',
        duration: 6000
      });
    }
  } catch (e) {
    localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pulling: false });
    ProjectList.render();
    showGitToast({
      success: false,
      title: 'Erreur lors du pull',
      message: e.message || 'Une erreur est survenue',
      duration: 6000
    });
  }
}

async function gitPush(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pushing: true });
  ProjectList.render();
  try {
    const result = await api.git.push({ projectPath: project.path });
    localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pushing: false, lastResult: result });
    ProjectList.render();

    if (result.success) {
      const parsed = parseGitPushOutput(result.output);
      showGitToast({
        success: true,
        title: 'Push réussi',
        message: parsed.message,
        details: parsed.details,
        duration: 4000
      });

      // Refresh dashboard async - keep old data, load new in background
      refreshDashboardAsync(projectId);
    } else {
      showGitToast({
        success: false,
        title: 'Erreur lors du push',
        message: result.error || 'Une erreur est survenue',
        duration: 6000
      });
    }
  } catch (e) {
    localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pushing: false });
    ProjectList.render();
    showGitToast({
      success: false,
      title: 'Erreur lors du push',
      message: e.message || 'Une erreur est survenue',
      duration: 6000
    });
  }
}

async function gitMergeAbort(projectId) {
  const project = getProject(projectId);
  if (!project) return;

  try {
    const result = await api.git.mergeAbort({ projectPath: project.path });

    if (result.success) {
      // Clear merge state
      localState.gitOperations.set(projectId, {
        ...localState.gitOperations.get(projectId),
        mergeInProgress: false,
        conflicts: [],
        lastResult: result
      });
      ProjectList.render();

      showGitToast({
        success: true,
        title: 'Merge annulé',
        message: 'Le merge a été annulé avec succès',
        duration: 4000
      });

      // Refresh dashboard
      refreshDashboardAsync(projectId);
    } else {
      showGitToast({
        success: false,
        title: 'Erreur lors de l\'annulation',
        message: result.error || 'Une erreur est survenue',
        duration: 6000
      });
    }
  } catch (e) {
    showGitToast({
      success: false,
      title: 'Erreur lors de l\'annulation',
      message: e.message || 'Une erreur est survenue',
      duration: 6000
    });
  }
}

// ========== FIVEM ==========
async function startFivemServer(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;
  localState.fivemServers.set(projectIndex, { status: 'starting', logs: [] });
  ProjectList.render();
  try {
    await api.fivem.start({
      projectIndex,
      projectPath: project.path,
      runCommand: project.fivemConfig?.runCommand || project.runCommand
    });
    localState.fivemServers.set(projectIndex, { status: 'running', logs: [] });
  } catch (e) {
    localState.fivemServers.set(projectIndex, { status: 'stopped', logs: [] });
  }
  ProjectList.render();
}

async function stopFivemServer(projectIndex) {
  await api.fivem.stop({ projectIndex });
  localState.fivemServers.set(projectIndex, { status: 'stopped', logs: localState.fivemServers.get(projectIndex)?.logs || [] });
  ProjectList.render();
}

function openFivemConsole(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  // Create FiveM console as a terminal tab (same location as other terminals)
  TerminalManager.createFivemConsole(project, projectIndex);
}

// Register FiveM listeners - write to TerminalManager's FiveM console
api.fivem.onData(({ projectIndex, data }) => {
  // Update local state logs
  const server = localState.fivemServers.get(projectIndex) || { status: 'running', logs: [] };
  server.logs.push(data);
  if (server.logs.join('').length > 10000) server.logs = [server.logs.join('').slice(-10000)];
  localState.fivemServers.set(projectIndex, server);

  // Write to TerminalManager's FiveM console
  TerminalManager.writeFivemConsole(projectIndex, data);
});

api.fivem.onExit(({ projectIndex, code }) => {
  localState.fivemServers.set(projectIndex, { status: 'stopped', logs: localState.fivemServers.get(projectIndex)?.logs || [] });

  // Write exit message to console
  TerminalManager.writeFivemConsole(projectIndex, `\r\n[Server exited with code ${code}]\r\n`);

  ProjectList.render();
});

// Legacy FiveM listeners via the service (kept for compatibility)
FivemService.registerFivemListeners(
  // onData callback - update local state
  (projectIndex, data) => {
    const server = localState.fivemServers.get(projectIndex) || { status: 'running', logs: [] };
    server.logs.push(data);
    if (server.logs.join('').length > 10000) server.logs = [server.logs.join('').slice(-10000)];
    localState.fivemServers.set(projectIndex, server);
  },
  // onExit callback - update status
  (projectIndex, code) => {
    localState.fivemServers.set(projectIndex, { status: 'stopped', logs: localState.fivemServers.get(projectIndex)?.logs || [] });
    ProjectList.render();
  },
  // onError callback - update error UI
  (projectIndex, error) => {
    TerminalManager.addFivemErrorToConsole(projectIndex, error);
  }
);

// ========== WEBAPP ==========
async function startWebAppServer(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  const { startDevServer } = require('./src/project-types/webapp/renderer/WebAppRendererService');
  await startDevServer(projectIndex);
  ProjectList.render();
}

async function stopWebAppServer(projectIndex) {
  const { stopDevServer } = require('./src/project-types/webapp/renderer/WebAppRendererService');
  await stopDevServer(projectIndex);
  ProjectList.render();
}

function openWebAppConsole(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  TerminalManager.createWebAppConsole(project, projectIndex);
}

function refreshWebAppInfoPanel(projectIndex) {
  // Find webapp console wrapper and re-render info if the Info tab is active
  const consoleTerminal = TerminalManager.getWebAppConsoleTerminal(projectIndex);
  if (!consoleTerminal) return;
  const wrappers = document.querySelectorAll('.terminal-wrapper.webapp-wrapper');
  wrappers.forEach(wrapper => {
    const activeTab = wrapper.querySelector('.webapp-view-tab.active');
    if (activeTab && activeTab.dataset.view === 'info') {
      const projects = projectsState.get().projects;
      const project = projects[projectIndex];
      if (project) {
        const { renderInfoView } = require('./src/project-types/webapp/renderer/WebAppTerminalPanel');
        renderInfoView(wrapper, projectIndex, project, { t });
      }
    }
  });
}

// Register WebApp listeners - write to TerminalManager's WebApp console
api.webapp.onData(({ projectIndex, data }) => {
  TerminalManager.writeWebAppConsole(projectIndex, data);
});

api.webapp.onExit(({ projectIndex, code }) => {
  TerminalManager.writeWebAppConsole(projectIndex, `\r\n[Dev server exited with code ${code}]\r\n`);
  ProjectList.render();
});

api.webapp.onPortDetected(({ projectIndex, port }) => {
  ProjectList.render();
  // Re-render Info panel if currently visible
  refreshWebAppInfoPanel(projectIndex);
});

// ========== DELETE PROJECT ==========
function deleteProjectUI(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const projectIndex = getProjectIndex(projectId);
  if (!confirm(`Supprimer "${project.name}" ?`)) return;

  // Stop any type-specific running processes (e.g., FiveM server)
  const deleteTypeHandler = registry.get(project.type);
  if (deleteTypeHandler.onProjectDelete) {
    deleteTypeHandler.onProjectDelete(project, projectIndex);
  }

  const projects = projectsState.get().projects.filter(p => p.id !== projectId);
  let rootOrder = projectsState.get().rootOrder;
  if (project.folderId === null) {
    rootOrder = rootOrder.filter(id => id !== projectId);
  }

  projectsState.set({ projects, rootOrder });
  saveProjects();

  if (projectsState.get().selectedProjectFilter === projectIndex) {
    setSelectedProjectFilter(null);
  }
  ProjectList.render();
  TerminalManager.filterByProject(projectsState.get().selectedProjectFilter);
}

// ========== TERMINAL CREATION WRAPPER ==========
function createTerminalForProject(project) {
  TerminalManager.createTerminal(project, {
    skipPermissions: settingsState.get().skipPermissions
  });
}

function createBasicTerminalForProject(project) {
  TerminalManager.createTerminal(project, {
    runClaude: false
  });
}

// ========== SESSIONS MODAL ==========
async function showSessionsModal(project) {
  if (!project) return;

  try {
    const sessions = await api.claude.sessions(project.path);

    if (!sessions || sessions.length === 0) {
      showModal(`Sessions - ${project.name}`, `
        <div class="sessions-modal-empty">
          <p>Aucune session sauvegardee pour ce projet</p>
          <button class="modal-btn primary" onclick="closeModal(); createTerminalForProject(projectsState.get().projects[${getProjectIndex(project.id)}])">
            Nouvelle conversation
          </button>
        </div>
      `);
      return;
    }

    const formatRelativeTime = (dateString) => {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      if (diffMins < 1) return "a l'instant";
      if (diffMins < 60) return `il y a ${diffMins}min`;
      if (diffHours < 24) return `il y a ${diffHours}h`;
      if (diffDays < 7) return `il y a ${diffDays}j`;
      return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    };

    const truncateText = (text, maxLength) => {
      if (!text) return '';
      return text.length <= maxLength ? text : text.slice(0, maxLength) + '...';
    };

    const cleanPromptAsTitle = (prompt) => {
      if (!prompt) return 'Sans titre';
      let clean = prompt
        .replace(/```[\s\S]*?```/g, '')       // remove code blocks
        .replace(/`[^`]+`/g, '')              // remove inline code
        .replace(/<[^>]+>/g, '')              // remove HTML/XML tags
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) -> text
        .replace(/https?:\/\/\S+/g, '')       // remove URLs
        .replace(/[#*_~>|]/g, '')             // remove markdown symbols
        .replace(/\n+/g, ' ')                 // newlines to spaces
        .replace(/\s+/g, ' ')                 // collapse whitespace
        .trim();
      // Take first sentence or chunk
      const firstSentence = clean.match(/^[^.!?\n]+[.!?]?/);
      if (firstSentence) clean = firstSentence[0].trim();
      // Capitalize first letter
      if (clean.length > 0) clean = clean[0].toUpperCase() + clean.slice(1);
      // Truncate
      if (clean.length > 80) clean = clean.slice(0, 77) + '...';
      return clean || 'Sans titre';
    };

    const sessionsHtml = sessions.map(session => {
      const title = session.summary || cleanPromptAsTitle(session.firstPrompt);
      const showPrompt = session.summary && session.firstPrompt;
      return `
      <div class="session-card-modal" data-session-id="${session.sessionId}">
        <div class="session-header">
          <span class="session-icon">💬</span>
          <span class="session-title">${escapeHtml(title)}</span>
        </div>
        ${showPrompt ? `<div class="session-prompt">${escapeHtml(truncateText(session.firstPrompt, 100))}</div>` : ''}
        <div class="session-meta">
          ${session.messageCount ? `<span class="session-messages">${session.messageCount} msgs</span>` : ''}
          <span class="session-time">${formatRelativeTime(session.modified)}</span>
          ${session.gitBranch ? `<span class="session-branch">${escapeHtml(session.gitBranch)}</span>` : ''}
        </div>
      </div>`;
    }).join('');

    showModal(`Reprendre - ${project.name}`, `
      <div class="sessions-modal">
        <div class="sessions-modal-actions">
          <button class="modal-btn primary sessions-new-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Nouvelle conversation
          </button>
        </div>
        <div class="sessions-modal-list">
          ${sessionsHtml}
        </div>
      </div>
    `);

    // Add click handlers after rendering
    document.querySelectorAll('.session-card-modal').forEach(card => {
      card.onclick = async () => {
        const sessionId = card.dataset.sessionId;
        closeModal();
        // Resume session via TerminalManager with skipPermissions setting
        TerminalManager.resumeSession(project, sessionId, {
          skipPermissions: settingsState.get().skipPermissions
        });
      };
    });

    document.querySelector('.sessions-new-btn')?.addEventListener('click', () => {
      closeModal();
      createTerminalForProject(project);
    });

  } catch (error) {
    console.error('Error showing sessions modal:', error);
    showModal('Erreur', `<p>Impossible de charger les sessions</p>`);
  }
}

// Make functions available globally for inline handlers
window.closeModal = closeModal;
window.createTerminalForProject = createTerminalForProject;
window.projectsState = projectsState;

// ========== SETUP COMPONENTS ==========
// Setup ProjectList
ProjectList.setExternalState({
  fivemServers: localState.fivemServers,
  gitOperations: localState.gitOperations,
  gitRepoStatus: localState.gitRepoStatus
});

ProjectList.setCallbacks({
  onCreateTerminal: createTerminalForProject,
  onCreateBasicTerminal: createBasicTerminalForProject,
  onStartFivem: startFivemServer,
  onStopFivem: stopFivemServer,
  onOpenFivemConsole: openFivemConsole,
  onStartWebApp: startWebAppServer,
  onStopWebApp: stopWebAppServer,
  onOpenWebAppConsole: openWebAppConsole,
  onGitPull: gitPull,
  onGitPush: gitPush,
  onDeleteProject: deleteProjectUI,
  onRenameProject: renameProjectUI,
  onRenderProjects: () => ProjectList.render(),
  onFilterTerminals: (idx) => TerminalManager.filterByProject(idx),
  countTerminalsForProject: TerminalManager.countTerminalsForProject,
  getTerminalStatsForProject: TerminalManager.getTerminalStatsForProject
});

// Setup TerminalManager
TerminalManager.setCallbacks({
  onNotification: showNotification,
  onRenderProjects: () => ProjectList.render(),
  onCreateTerminal: createTerminalForProject,
  onSwitchTerminal: (direction) => {
    const allTerminals = terminalsState.get().terminals;
    const currentId = terminalsState.get().activeTerminal;
    const currentFilter = projectsState.get().selectedProjectFilter;
    const projects = projectsState.get().projects;
    const filterProject = projects[currentFilter];

    // Get only visible terminals (respecting project filter)
    const visibleTerminals = [];
    allTerminals.forEach((termData, id) => {
      const isVisible = currentFilter === null ||
        (filterProject && termData.project && termData.project.path === filterProject.path);
      if (isVisible) {
        visibleTerminals.push(id);
      }
    });

    if (visibleTerminals.length === 0) return;

    const currentIndex = visibleTerminals.indexOf(currentId);
    let targetIndex;

    if (currentIndex === -1) {
      // Current terminal not in visible list, pick first
      targetIndex = 0;
    } else if (direction === 'left') {
      targetIndex = (currentIndex - 1 + visibleTerminals.length) % visibleTerminals.length;
    } else {
      targetIndex = (currentIndex + 1) % visibleTerminals.length;
    }

    TerminalManager.setActiveTerminal(visibleTerminals[targetIndex]);
  },
  onSwitchProject: (direction) => {
    const projects = projectsState.get().projects;
    const terminals = terminalsState.get().terminals;

    // Get projects in visual (sidebar) order, filtered to those with open terminals
    const visualOrder = getVisualProjectOrder();
    const projectsWithTerminals = visualOrder.filter(project => {
      for (const [, t] of terminals) {
        if (t.project && t.project.path === project.path) return true;
      }
      return false;
    });

    if (projectsWithTerminals.length <= 1) return;

    // Find current project by path for stable comparison
    const currentFilter = projectsState.get().selectedProjectFilter;
    const currentProject = projects[currentFilter];
    const currentIdx = currentProject
      ? projectsWithTerminals.findIndex(p => p.path === currentProject.path)
      : -1;

    let targetIdx;
    if (currentIdx === -1) {
      targetIdx = 0;
    } else if (direction === 'up') {
      targetIdx = (currentIdx - 1 + projectsWithTerminals.length) % projectsWithTerminals.length;
    } else {
      targetIdx = (currentIdx + 1) % projectsWithTerminals.length;
    }

    const targetProject = projectsWithTerminals[targetIdx];
    const targetIndex = getProjectIndex(targetProject.id);
    setSelectedProjectFilter(targetIndex);
    ProjectList.render();
    TerminalManager.filterByProject(targetIndex);
  }
});

// Setup FileExplorer
FileExplorer.setCallbacks({
  onOpenInTerminal: (folderPath) => {
    const selectedFilter = projectsState.get().selectedProjectFilter;
    const projects = projectsState.get().projects;
    if (selectedFilter !== null && projects[selectedFilter]) {
      const project = { ...projects[selectedFilter], path: folderPath };
      TerminalManager.createTerminal(project, { runClaude: false });
    }
  },
  onOpenFile: (filePath) => {
    const selectedFilter = projectsState.get().selectedProjectFilter;
    const projects = projectsState.get().projects;
    const project = selectedFilter !== null ? projects[selectedFilter] : null;
    TerminalManager.openFileTab(filePath, project);
  }
});
FileExplorer.init();

// Toggle explorer button
const btnToggleExplorer = document.getElementById('btn-toggle-explorer');
if (btnToggleExplorer) {
  btnToggleExplorer.onclick = () => FileExplorer.toggle();
}

// Subscribe to project selection changes for FileExplorer
projectsState.subscribe(() => {
  const state = projectsState.get();
  const selectedFilter = state.selectedProjectFilter;
  const projects = state.projects;

  if (selectedFilter !== null && projects[selectedFilter]) {
    FileExplorer.setRootPath(projects[selectedFilter].path);
  } else {
    FileExplorer.hide();
  }
});

// ========== WINDOW CONTROLS ==========
document.getElementById('btn-minimize').onclick = () => api.window.minimize();
document.getElementById('btn-maximize').onclick = () => api.window.maximize();
document.getElementById('btn-close').onclick = () => handleWindowClose();

/**
 * Handle window close with user choice
 */
function handleWindowClose() {
  const closeAction = settingsState.get().closeAction || 'ask';

  if (closeAction === 'minimize') {
    api.window.close(); // This will minimize to tray
    return;
  }

  if (closeAction === 'quit') {
    api.app.quit(); // Force quit
    return;
  }

  // Show choice dialog
  showCloseDialog();
}

/**
 * Show close action dialog
 */
function showCloseDialog() {
  const content = `
    <div class="close-dialog-content">
      <p>Que souhaitez-vous faire ?</p>
      <div class="close-dialog-options">
        <button class="close-option-btn" id="close-minimize">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
            <path d="M19 13H5v-2h14v2z"/>
          </svg>
          <span>Minimiser dans le tray</span>
          <small>L'application reste accessible depuis la barre des tâches</small>
        </button>
        <button class="close-option-btn close-option-quit" id="close-quit">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
          <span>Quitter complètement</span>
          <small>Ferme l'application et tous les terminaux</small>
        </button>
      </div>
      <label class="close-dialog-remember">
        <input type="checkbox" id="close-remember">
        <span class="close-dialog-toggle"></span>
        <span class="close-dialog-remember-text">Se souvenir de mon choix</span>
      </label>
    </div>
  `;

  showModal('Fermer l\'application', content);

  // Add event handlers
  document.getElementById('close-minimize').onclick = () => {
    const remember = document.getElementById('close-remember').checked;
    if (remember) {
      settingsState.setProp('closeAction', 'minimize');
      saveSettings();
    }
    closeModal();
    api.window.close();
  };

  document.getElementById('close-quit').onclick = () => {
    const remember = document.getElementById('close-remember').checked;
    if (remember) {
      settingsState.setProp('closeAction', 'quit');
      saveSettings();
    }
    closeModal();
    api.app.quit();
  };
}

document.getElementById('btn-notifications').onclick = () => {
  localState.notificationsEnabled = !localState.notificationsEnabled;
  document.getElementById('btn-notifications').classList.toggle('active', localState.notificationsEnabled);
  if (localState.notificationsEnabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
};

document.getElementById('btn-settings').onclick = () => switchToSettingsTab();

// Sidebar collapse toggle
const sidebarEl = document.querySelector('.sidebar');
const btnCollapseSidebar = document.getElementById('btn-collapse-sidebar');
if (localStorage.getItem('sidebar-collapsed') === 'true') {
  sidebarEl.classList.add('collapsed');
}
btnCollapseSidebar.onclick = () => {
  sidebarEl.classList.toggle('collapsed');
  localStorage.setItem('sidebar-collapsed', sidebarEl.classList.contains('collapsed'));
};

// ========== TAB NAVIGATION ==========
// Set ARIA roles on all nav-tabs
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
});

document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.onclick = () => {
    const tabId = tab.dataset.tab;
    document.querySelectorAll('.nav-tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById('btn-settings').classList.remove('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    if (tabId === 'plugins') loadPlugins();
    if (tabId === 'skills') loadSkills();
    if (tabId === 'agents') loadAgents();
    if (tabId === 'mcp') loadMcps();
    if (tabId === 'git') {
      GitTabService.initGitTab();
      GitTabService.renderProjectsList();
    }
    if (tabId === 'dashboard') {
      populateDashboardProjects();
      if (localState.selectedDashboardProject === -1) {
        renderOverviewDashboard();
      } else if (localState.selectedDashboardProject >= 0) {
        renderDashboardContent(localState.selectedDashboardProject);
      }
    }
    if (tabId === 'memory') loadMemory();
    // Cleanup TimeTrackingDashboard interval when leaving the tab
    if (tabId !== 'timetracking') {
      TimeTrackingDashboard.cleanup();
    }
    if (tabId === 'timetracking') {
      const container = document.getElementById('timetracking-container');
      if (container) TimeTrackingDashboard.init(container);
    }
    if (tabId === 'claude') {
      const activeId = terminalsState.get().activeTerminal;
      if (activeId) {
        const termData = terminalsState.get().terminals.get(activeId);
        if (termData) termData.fitAddon.fit();
      }
    }
  };
});

// ========== CONTEXT MENU ==========
function setupContextMenuHandlers() {
  const list = document.getElementById('projects-list');

  list.addEventListener('contextmenu', (e) => {
    const folderItem = e.target.closest('.folder-item');
    const projectItem = e.target.closest('.project-item');

    if (folderItem) {
      e.preventDefault();
      e.stopPropagation();
      showContextMenuForFolder(e.clientX, e.clientY, folderItem.dataset.folderId);
    } else if (projectItem) {
      e.preventDefault();
      e.stopPropagation();
      showContextMenuForProject(e.clientX, e.clientY, projectItem.dataset.projectId);
    } else if (e.target === list || e.target.classList.contains('drop-zone-root')) {
      e.preventDefault();
      showContextMenuEmpty(e.clientX, e.clientY);
    }
  });
}

function showContextMenuForFolder(x, y, folderId) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = `
    <div class="context-menu-item" data-action="new-subfolder">Nouveau sous-dossier</div>
    <div class="context-menu-item" data-action="rename">Renommer</div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" data-action="delete">Supprimer le dossier</div>`;
  showContextMenuAt(menu, x, y, { type: 'folder', id: folderId });
}

function showContextMenuForProject(x, y, projectId) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = `
    <div class="context-menu-item" data-action="move-to-root">Deplacer a la racine</div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" data-action="delete">Supprimer</div>`;
  showContextMenuAt(menu, x, y, { type: 'project', id: projectId });
}

function showContextMenuEmpty(x, y) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = `
    <div class="context-menu-item" data-action="new-folder">Nouveau dossier</div>
    <div class="context-menu-item" data-action="new-project">Nouveau projet</div>`;
  showContextMenuAt(menu, x, y, { type: 'empty', id: null });
}

let contextTarget = null;
function showContextMenuAt(menu, x, y, target) {
  contextTarget = target;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.add('active');

  menu.querySelectorAll('.context-menu-item').forEach(item => {
    item.onclick = () => {
      handleContextAction(item.dataset.action);
      hideContextMenuUI();
    };
  });
}

function hideContextMenuUI() {
  document.getElementById('context-menu').classList.remove('active');
}

document.addEventListener('click', () => hideContextMenuUI());

async function handleContextAction(action) {
  if (!contextTarget) return;
  switch (action) {
    case 'new-folder': await promptCreateFolder(null); break;
    case 'new-subfolder': if (contextTarget.type === 'folder') await promptCreateFolder(contextTarget.id); break;
    case 'rename': if (contextTarget.type === 'folder') await promptRenameFolder(contextTarget.id); break;
    case 'delete':
      if (contextTarget.type === 'folder') {
        if (confirm('Supprimer ce dossier ? Les elements seront deplaces vers le parent.')) {
          deleteFolder(contextTarget.id);
          ProjectList.render();
        }
      } else if (contextTarget.type === 'project') {
        deleteProjectUI(contextTarget.id);
      }
      break;
    case 'move-to-root':
      if (contextTarget.type === 'project') {
        const { moveItemToFolder } = require('./src/renderer');
        moveItemToFolder('project', contextTarget.id, null);
        ProjectList.render();
      }
      break;
    case 'new-project': document.getElementById('btn-new-project').click(); break;
  }
}

// ========== INPUT MODAL ==========
function showInputModal(title, defaultValue = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('input-modal');
    const titleEl = document.getElementById('input-modal-title');
    const input = document.getElementById('input-modal-input');
    const confirmBtn = document.getElementById('input-modal-confirm');
    const cancelBtn = document.getElementById('input-modal-cancel');

    titleEl.textContent = title;
    input.value = defaultValue;
    modal.classList.add('active');
    input.focus();
    input.select();

    const cleanup = () => {
      modal.classList.remove('active');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      input.onkeydown = null;
    };
    confirmBtn.onclick = () => { cleanup(); resolve(input.value); };
    cancelBtn.onclick = () => { cleanup(); resolve(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { cleanup(); resolve(input.value); }
      if (e.key === 'Escape') { cleanup(); resolve(null); }
    };
  });
}

async function promptCreateFolder(parentId) {
  const name = await showInputModal('Nom du dossier:');
  if (name && name.trim()) {
    createFolder(name.trim(), parentId);
    ProjectList.render();
  }
}

async function promptRenameFolder(folderId) {
  const folder = getFolder(folderId);
  if (!folder) return;
  const name = await showInputModal('Nouveau nom:', folder.name);
  if (name && name.trim()) {
    renameFolder(folderId, name.trim());
    ProjectList.render();
  }
}

async function renameProjectUI(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const name = await showInputModal('Nouveau nom du projet:', project.name);
  if (name && name.trim()) {
    renameProject(projectId, name.trim());
    ProjectList.render();
  }
}

// ========== SETTINGS TAB ==========
function switchToSettingsTab(initialSubTab = 'general') {
  // Deactivate all nav-tabs, activate settings button
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('btn-settings').classList.add('active');
  // Hide all tab-contents, show settings tab
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-settings').classList.add('active');
  // Cleanup time tracking if leaving that tab
  TimeTrackingDashboard.cleanup();
  // Render settings content
  renderSettingsTab(initialSubTab);
}

async function renderSettingsTab(initialTab = 'general') {
  const container = document.getElementById('tab-settings');
  const settings = settingsState.get();

  // Get launch at startup setting
  let launchAtStartup = false;
  try {
    launchAtStartup = await api.app.getLaunchAtStartup();
  } catch (e) {
    console.error('Error getting launch at startup:', e);
  }

  // Get GitHub auth status
  let githubStatus = { authenticated: false };
  try {
    githubStatus = await api.github.authStatus();
  } catch (e) {
    console.error('Error getting GitHub status:', e);
  }

  const availableLanguages = getAvailableLanguages();
  const currentLang = getCurrentLanguage();

  container.innerHTML = `
    <div class="settings-inline-wrapper">
      <div class="settings-inline-header">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
        <h2>${t('settings.title')}</h2>
      </div>
      <div class="settings-tabs">
        <button class="settings-tab ${initialTab === 'general' ? 'active' : ''}" data-tab="general">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
          General
        </button>
        <button class="settings-tab ${initialTab === 'claude' ? 'active' : ''}" data-tab="claude">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg>
          Claude
        </button>
        <button class="settings-tab ${initialTab === 'github' ? 'active' : ''}" data-tab="github">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
          GitHub
        </button>
        <button class="settings-tab ${initialTab === 'themes' ? 'active' : ''}" data-tab="themes">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
          Themes
        </button>
        <button class="settings-tab ${initialTab === 'shortcuts' ? 'active' : ''}" data-tab="shortcuts">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/></svg>
          Raccourcis
        </button>
        ${(() => {
          const registry = require('./src/project-types/registry');
          const dynamicTabs = registry.collectAllSettingsFields();
          let tabsHtml = '';
          dynamicTabs.forEach((tabData, tabId) => {
            tabsHtml += `<button class="settings-tab ${initialTab === tabId ? 'active' : ''}" data-tab="${tabId}">
              ${tabData.icon}
              ${tabData.label}
            </button>`;
          });
          return tabsHtml;
        })()}
      </div>
      <div class="settings-content">
        <!-- General Tab -->
        <div class="settings-panel ${initialTab === 'general' ? 'active' : ''}" data-panel="general">
          <div class="settings-section">
            <div class="settings-title">Apparence</div>
            <div class="settings-row">
              <div class="settings-label">
                <div>${t('settings.language')}</div>
                <div class="settings-desc">Change the interface language</div>
              </div>
              <select id="language-select" class="settings-select">
                ${availableLanguages.map(lang =>
                  `<option value="${lang.code}" ${currentLang === lang.code ? 'selected' : ''}>${lang.name}</option>`
                ).join('')}
              </select>
            </div>
            <div class="settings-row">
              <div class="settings-label">
                <div>Couleur d'accent</div>
                <div class="settings-desc">Personnalisez la couleur principale de l'interface</div>
              </div>
            </div>
            <div class="color-picker">
              ${['#d97706', '#dc2626', '#db2777', '#9333ea', '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d'].map(c =>
                `<button class="color-swatch ${settings.accentColor === c ? 'selected' : ''}" style="background:${c}" data-color="${c}"></button>`
              ).join('')}
              <div class="color-swatch-custom ${!['#d97706', '#dc2626', '#db2777', '#9333ea', '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d'].includes(settings.accentColor) ? 'selected' : ''}" style="background:${!['#d97706', '#dc2626', '#db2777', '#9333ea', '#4f46e5', '#2563eb', '#0891b2', '#0d9488', '#16a34a', '#65a30d'].includes(settings.accentColor) ? settings.accentColor : 'var(--bg-tertiary)'}">
                <input type="color" id="custom-color-input" value="${settings.accentColor}" title="Choisir une couleur personnalisee">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              </div>
            </div>
            <div class="settings-row" style="margin-top: 16px;">
              <div class="settings-label">
                <div>Theme du terminal</div>
                <div class="settings-desc">Changez les couleurs du terminal</div>
              </div>
              <button type="button" class="btn-outline" id="btn-go-themes">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>
                ${TERMINAL_THEMES[settings.terminalTheme || 'claude']?.name || 'Claude'}
              </button>
            </div>
          </div>
          <div class="settings-section">
            <div class="settings-title">Systeme</div>
            <div class="settings-toggle-row">
              <div class="settings-toggle-label">
                <div>Lancer au demarrage</div>
                <div class="settings-toggle-desc">Demarrer automatiquement avec Windows</div>
              </div>
              <label class="settings-toggle">
                <input type="checkbox" id="launch-at-startup-toggle" ${launchAtStartup ? 'checked' : ''}>
                <span class="settings-toggle-slider"></span>
              </label>
            </div>
            <div class="settings-toggle-row">
              <div class="settings-toggle-label">
                <div>Vue compacte des projets</div>
                <div class="settings-toggle-desc">Afficher uniquement le nom des projets non selectionnes</div>
              </div>
              <label class="settings-toggle">
                <input type="checkbox" id="compact-projects-toggle" ${settings.compactProjects !== false ? 'checked' : ''}>
                <span class="settings-toggle-slider"></span>
              </label>
            </div>
            <div class="settings-toggle-row">
              <div class="settings-toggle-label">
                <div>${t('settings.reduceMotion')}</div>
                <div class="settings-toggle-desc">${t('settings.reduceMotionDesc')}</div>
              </div>
              <label class="settings-toggle">
                <input type="checkbox" id="reduce-motion-toggle" ${settings.reduceMotion ? 'checked' : ''}>
                <span class="settings-toggle-slider"></span>
              </label>
            </div>
            <div class="settings-toggle-row">
              <div class="settings-toggle-label">
                <div>${t('settings.aiCommitMessages')}</div>
                <div class="settings-toggle-desc">${t('settings.aiCommitMessagesDesc')}</div>
              </div>
              <label class="settings-toggle">
                <input type="checkbox" id="ai-commit-toggle" ${settings.aiCommitMessages !== false ? 'checked' : ''}>
                <span class="settings-toggle-slider"></span>
              </label>
            </div>
            <div class="settings-row">
              <div class="settings-label">
                <div>Fermeture de la fenetre</div>
                <div class="settings-desc">Action quand vous cliquez sur fermer</div>
              </div>
              <select id="close-action-select" class="settings-select">
                <option value="ask" ${settings.closeAction === 'ask' || !settings.closeAction ? 'selected' : ''}>Demander</option>
                <option value="minimize" ${settings.closeAction === 'minimize' ? 'selected' : ''}>Minimiser</option>
                <option value="quit" ${settings.closeAction === 'quit' ? 'selected' : ''}>Quitter</option>
              </select>
            </div>
          </div>
          <!-- Quick Action Presets Section -->
          <div class="settings-section">
            <div class="settings-title">${t('settings.quickActionPresets') || 'Quick Action Presets'}</div>
            <div class="settings-desc" style="margin-bottom: 10px;">${t('settings.quickActionPresetsDesc') || 'Presets personnalises affiches dans la configuration des actions rapides'}</div>
            <div class="custom-presets-list" id="custom-presets-list">
              ${(settings.customPresets || []).map((p, i) => `
                <div class="custom-preset-item" data-index="${i}">
                  <span class="custom-preset-icon">${QuickActions.QUICK_ACTION_ICONS[p.icon] || QuickActions.QUICK_ACTION_ICONS.play}</span>
                  <span class="custom-preset-name">${escapeHtml(p.name)}</span>
                  <code class="custom-preset-cmd">${escapeHtml(p.command)}</code>
                  <button class="custom-preset-delete" data-index="${i}" title="${t('common.delete') || 'Supprimer'}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
              `).join('') || `<div class="custom-presets-empty">${t('settings.noCustomPresets') || 'Aucun preset personnalise'}</div>`}
            </div>
            <div class="custom-preset-add" id="custom-preset-add-area">
              <div class="custom-preset-add-row" id="custom-preset-form" style="display:none;">
                <input type="text" id="new-preset-name" placeholder="${t('quickActions.namePlaceholder') || 'Nom'}" class="settings-input-sm">
                <input type="text" id="new-preset-command" placeholder="${t('quickActions.commandPlaceholder') || 'Commande'}" class="settings-input-sm" style="flex:2;">
                <select id="new-preset-icon" class="settings-select-sm">
                  ${Object.keys(QuickActions.QUICK_ACTION_ICONS).map(icon => `<option value="${icon}">${icon}</option>`).join('')}
                </select>
                <button class="btn-accent-sm" id="btn-save-preset">${t('common.save') || 'OK'}</button>
                <button class="btn-ghost-sm" id="btn-cancel-preset">${t('common.cancel') || 'Annuler'}</button>
              </div>
              <button class="quick-action-add-btn" id="btn-add-preset" style="width:100%;">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                <span>${t('settings.addPreset') || 'Ajouter un preset'}</span>
              </button>
            </div>
          </div>
        </div>
        <!-- Claude Tab -->
        <div class="settings-panel ${initialTab === 'claude' ? 'active' : ''}" data-panel="claude">
          <div class="settings-section">
            <div class="settings-title">Mode d'execution</div>
            <div class="execution-mode-selector">
              <div class="execution-mode-card ${!settings.skipPermissions ? 'selected' : ''}" data-mode="safe">
                <div class="execution-mode-icon safe">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>
                </div>
                <div class="execution-mode-content">
                  <div class="execution-mode-title">Mode securise</div>
                  <div class="execution-mode-desc">Claude demande confirmation avant chaque action</div>
                </div>
                <div class="execution-mode-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
              </div>
              <div class="execution-mode-card ${settings.skipPermissions ? 'selected' : ''}" data-mode="dangerous">
                <div class="execution-mode-icon dangerous">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>
                </div>
                <div class="execution-mode-content">
                  <div class="execution-mode-title">Mode autonome</div>
                  <div class="execution-mode-desc">Claude execute sans confirmation</div>
                  <div class="execution-mode-flag">--dangerously-skip-permissions</div>
                </div>
                <div class="execution-mode-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
              </div>
            </div>
            <div class="settings-warning" id="dangerous-warning" style="display: ${settings.skipPermissions ? 'flex' : 'none'};">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 3.99L19.53 19H4.47L12 5.99zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z"/></svg>
              <span>Ce mode permet a Claude d'executer des commandes sans validation.</span>
            </div>
          </div>
        </div>
        <!-- GitHub Tab -->
        <div class="settings-panel ${initialTab === 'github' ? 'active' : ''}" data-panel="github">
          <div class="settings-section">
            <div class="settings-title">Compte GitHub</div>
            <div class="github-account-card" id="github-account-card">
              ${githubStatus.authenticated ? `
                <div class="github-account-connected">
                  <div class="github-account-info">
                    <img src="${githubStatus.avatar_url || ''}" alt="" class="github-avatar" onerror="this.style.display='none'">
                    <div class="github-account-details">
                      <div class="github-account-name">${githubStatus.name || githubStatus.login}</div>
                      <div class="github-account-login">@${githubStatus.login}</div>
                    </div>
                  </div>
                  <button type="button" class="btn-outline-danger btn-sm" id="btn-github-disconnect">Deconnecter</button>
                </div>
              ` : `
                <div class="github-account-disconnected">
                  <div class="github-account-message">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                    <div>
                      <div class="github-account-title">Connectez votre compte GitHub</div>
                      <div class="github-account-desc">Entrez un Personal Access Token pour cloner vos repos prives</div>
                    </div>
                  </div>
                </div>
                <div class="github-token-form">
                  <div class="github-token-input-group">
                    <input type="password" id="github-token-input" class="github-token-input" placeholder="ghp_xxxxxxxxxxxx">
                    <button type="button" class="btn-github-connect" id="btn-github-connect">Connecter</button>
                  </div>
                  <div class="github-token-help">
                    <a href="#" id="github-token-help-link">Comment creer un token ?</a>
                  </div>
                </div>
              `}
            </div>
            <div class="github-device-flow-container" id="github-device-flow" style="display: none;"></div>
          </div>
        </div>
        <!-- Themes Tab -->
        <div class="settings-panel ${initialTab === 'themes' ? 'active' : ''}" data-panel="themes">
          <div class="settings-section">
            <div class="settings-title">Theme du terminal</div>
            <div class="settings-desc" style="margin-bottom: 12px;">Choisissez un theme pour personnaliser les couleurs de vos terminaux</div>
            <div class="theme-grid" id="theme-grid">
              ${Object.entries(TERMINAL_THEMES).map(([id, theme]) => {
                const isSelected = settings.terminalTheme === id || (!settings.terminalTheme && id === 'claude');
                const colors = [theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan];
                return `<div class="theme-card ${isSelected ? 'selected' : ''}" data-theme-id="${id}">
                  <div class="theme-card-preview" style="background:${theme.background}">
                    <span class="theme-card-cursor" style="background:${theme.cursor}"></span>
                    <span class="theme-card-text" style="color:${theme.foreground}">~$&nbsp;</span>
                    <span class="theme-card-text" style="color:${theme.green}">node</span>
                  </div>
                  <div class="theme-card-colors">
                    ${colors.map(c => `<span class="theme-card-swatch" style="background:${c}"></span>`).join('')}
                  </div>
                  <div class="theme-card-name">${theme.name}</div>
                </div>`;
              }).join('')}
            </div>
          </div>
        </div>
        <!-- Shortcuts Tab -->
        <div class="settings-panel ${initialTab === 'shortcuts' ? 'active' : ''}" data-panel="shortcuts">
          ${renderShortcutsPanel()}
        </div>
        ${(() => {
          const registry = require('./src/project-types/registry');
          const dynamicTabs = registry.collectAllSettingsFields();
          let panelsHtml = '';
          dynamicTabs.forEach((tabData, tabId) => {
            let sectionsHtml = '';
            tabData.sections.forEach((section) => {
              const sectionName = section.typeName.includes('.') ? t(section.typeName) || section.typeName : section.typeName;
              let fieldsHtml = '';
              for (const field of section.fields) {
                const fieldLabel = field.labelKey ? t(field.labelKey) || field.label : field.label;
                const fieldDesc = field.descKey ? t(field.descKey) || field.description : field.description;
                const currentValue = settingsState.get()[field.key];
                const value = currentValue !== undefined ? currentValue : field.default;
                if (field.type === 'toggle') {
                  fieldsHtml += `
                    <div class="settings-toggle-row">
                      <div class="settings-toggle-label">
                        <div>${fieldLabel}</div>
                        ${fieldDesc ? `<div class="settings-toggle-desc">${fieldDesc}</div>` : ''}
                      </div>
                      <label class="settings-toggle">
                        <input type="checkbox" class="dynamic-setting-toggle" data-setting-key="${field.key}" ${value ? 'checked' : ''}>
                        <span class="settings-toggle-slider"></span>
                      </label>
                    </div>`;
                }
              }
              sectionsHtml += `
                <div class="settings-section">
                  <div class="settings-title">
                    <span class="settings-title-icon">${section.typeIcon}</span>
                    ${sectionName}
                  </div>
                  ${fieldsHtml}
                </div>`;
            });
            panelsHtml += `
              <div class="settings-panel ${initialTab === tabId ? 'active' : ''}" data-panel="${tabId}">
                ${sectionsHtml}
              </div>`;
          });
          return panelsHtml;
        })()}
      </div>
      <div class="settings-inline-footer">
        <button type="button" class="btn-primary" id="btn-save-settings">Sauvegarder</button>
      </div>
    </div>
  `;

  // Tab switching
  container.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
      container.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      container.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      container.querySelector(`.settings-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
    };
  });

  // Setup shortcuts panel handlers
  setupShortcutsPanelHandlers();

  // Custom presets management
  const addPresetBtn = document.getElementById('btn-add-preset');
  const presetForm = document.getElementById('custom-preset-form');
  const cancelPresetBtn = document.getElementById('btn-cancel-preset');
  const savePresetBtn = document.getElementById('btn-save-preset');

  if (addPresetBtn) {
    addPresetBtn.onclick = () => {
      presetForm.style.display = 'flex';
      addPresetBtn.style.display = 'none';
      document.getElementById('new-preset-name').focus();
    };
  }

  if (cancelPresetBtn) {
    cancelPresetBtn.onclick = () => {
      presetForm.style.display = 'none';
      addPresetBtn.style.display = '';
    };
  }

  if (savePresetBtn) {
    savePresetBtn.onclick = () => {
      const name = document.getElementById('new-preset-name').value.trim();
      const command = document.getElementById('new-preset-command').value.trim();
      const icon = document.getElementById('new-preset-icon').value;
      if (!name || !command) return;

      const currentPresets = settingsState.get().customPresets || [];
      const updated = [...currentPresets, { name, command, icon }];
      settingsState.set({ ...settingsState.get(), customPresets: updated });
      saveSettings();
      renderSettingsTab('general');
    };
  }

  // Delete custom preset buttons
  container.querySelectorAll('.custom-preset-delete').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.index);
      const currentPresets = [...(settingsState.get().customPresets || [])];
      currentPresets.splice(idx, 1);
      settingsState.set({ ...settingsState.get(), customPresets: currentPresets });
      saveSettings();
      renderSettingsTab('general');
    };
  });

  // Execution mode cards
  container.querySelectorAll('.execution-mode-card').forEach(card => {
    card.onclick = () => {
      container.querySelectorAll('.execution-mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('dangerous-warning').style.display = card.dataset.mode === 'dangerous' ? 'flex' : 'none';
    };
  });

  // Color swatches
  container.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.onclick = () => {
      container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      container.querySelector('.color-swatch-custom')?.classList.remove('selected');
      swatch.classList.add('selected');
    };
  });

  // Custom color picker
  const customColorInput = document.getElementById('custom-color-input');
  const customSwatch = container.querySelector('.color-swatch-custom');
  if (customColorInput && customSwatch) {
    customColorInput.oninput = (e) => {
      const color = e.target.value;
      customSwatch.style.background = color;
      container.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      customSwatch.classList.add('selected');
    };
    customSwatch.onclick = (e) => {
      if (e.target === customColorInput) return;
      customColorInput.click();
    };
  }

  // Theme card selection with live preview
  container.querySelectorAll('.theme-card').forEach(card => {
    card.onclick = () => {
      container.querySelectorAll('.theme-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      // Live preview: apply theme immediately to open terminals
      const themeId = card.dataset.themeId;
      TerminalManager.updateAllTerminalsTheme(themeId);
      // Update the button label in general tab
      const btn = document.getElementById('btn-go-themes');
      if (btn) {
        const themeName = TERMINAL_THEMES[themeId]?.name || themeId;
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg> ${themeName}`;
      }
    };
  });

  // Navigate to themes tab from general tab button
  const btnGoThemes = document.getElementById('btn-go-themes');
  if (btnGoThemes) {
    btnGoThemes.onclick = () => {
      container.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      container.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      container.querySelector('.settings-tab[data-tab="themes"]')?.classList.add('active');
      container.querySelector('.settings-panel[data-panel="themes"]')?.classList.add('active');
    };
  }

  // GitHub connect button
  async function setupGitHubAuth() {
    const connectBtn = document.getElementById('btn-github-connect');
    const disconnectBtn = document.getElementById('btn-github-disconnect');
    const tokenInput = document.getElementById('github-token-input');
    const helpLink = document.getElementById('github-token-help-link');

    if (connectBtn && tokenInput) {
      connectBtn.onclick = async () => {
        const token = tokenInput.value.trim();
        if (!token) {
          tokenInput.focus();
          tokenInput.classList.add('error');
          setTimeout(() => tokenInput.classList.remove('error'), 1000);
          return;
        }

        connectBtn.disabled = true;
        connectBtn.innerHTML = '<span class="btn-spinner"></span>';

        try {
          const result = await api.github.setToken(token);
          if (result.success && result.authenticated) {
            renderSettingsTab('github');
          } else {
            tokenInput.classList.add('error');
            tokenInput.value = '';
            tokenInput.placeholder = 'Token invalide';
            setTimeout(() => {
              tokenInput.classList.remove('error');
              tokenInput.placeholder = 'ghp_xxxxxxxxxxxx';
            }, 2000);
            connectBtn.disabled = false;
            connectBtn.innerHTML = 'Connecter';
          }
        } catch (e) {
          connectBtn.disabled = false;
          connectBtn.innerHTML = 'Connecter';
        }
      };

      // Allow Enter key to submit
      tokenInput.onkeydown = (e) => {
        if (e.key === 'Enter') connectBtn.click();
      };
    }

    if (helpLink) {
      helpLink.onclick = (e) => {
        e.preventDefault();
        api.github.openAuthUrl('https://github.com/settings/tokens/new?scopes=repo&description=Claude%20Terminal');
      };
    }

    if (disconnectBtn) {
      disconnectBtn.onclick = async () => {
        await api.github.logout();
        renderSettingsTab('github');
      };
    }
  }
  setupGitHubAuth();

  // Save settings
  document.getElementById('btn-save-settings').onclick = async () => {
    const selectedMode = container.querySelector('.execution-mode-card.selected');
    const closeActionSelect = document.getElementById('close-action-select');
    const selectedThemeCard = container.querySelector('.theme-card.selected');
    const languageSelect = document.getElementById('language-select');
    const newTerminalTheme = selectedThemeCard?.dataset.themeId || 'claude';
    const newLanguage = languageSelect?.value || getCurrentLanguage();

    // Get accent color from preset swatch or custom picker
    let accentColor = settings.accentColor;
    const selectedSwatch = container.querySelector('.color-swatch.selected');
    const customSwatchSelected = container.querySelector('.color-swatch-custom.selected');
    if (selectedSwatch) {
      accentColor = selectedSwatch.dataset.color;
    } else if (customSwatchSelected) {
      accentColor = document.getElementById('custom-color-input')?.value || settings.accentColor;
    }

    const compactProjectsToggle = document.getElementById('compact-projects-toggle');
    const newCompactProjects = compactProjectsToggle ? compactProjectsToggle.checked : true;
    const reduceMotionToggle = document.getElementById('reduce-motion-toggle');
    const newReduceMotion = reduceMotionToggle ? reduceMotionToggle.checked : false;
    const aiCommitToggle = document.getElementById('ai-commit-toggle');
    const newAiCommitMessages = aiCommitToggle ? aiCommitToggle.checked : true;

    const newSettings = {
      editor: settings.editor || 'code',
      skipPermissions: selectedMode?.dataset.mode === 'dangerous',
      accentColor,
      closeAction: closeActionSelect?.value || 'ask',
      terminalTheme: newTerminalTheme,
      language: newLanguage,
      compactProjects: newCompactProjects,
      reduceMotion: newReduceMotion,
      aiCommitMessages: newAiCommitMessages
    };

    // Collect dynamic settings from project types
    container.querySelectorAll('.dynamic-setting-toggle').forEach(toggle => {
      newSettings[toggle.dataset.settingKey] = toggle.checked;
    });

    settingsState.set(newSettings);

    // Update language if changed - must save synchronously before reload
    if (newLanguage !== getCurrentLanguage()) {
      saveSettingsImmediate();
      setLanguage(newLanguage);
      location.reload();
      return;
    }

    saveSettings();

    // Apply compact mode
    document.body.classList.toggle('compact-projects', newCompactProjects);

    // Apply reduce motion
    document.body.classList.toggle('reduce-motion', newReduceMotion);
    applyAccentColor(newSettings.accentColor);

    // Update terminal themes if changed
    if (newTerminalTheme !== settings.terminalTheme) {
      TerminalManager.updateAllTerminalsTheme(newTerminalTheme);
    }

    // Save launch at startup setting
    const launchAtStartupToggle = document.getElementById('launch-at-startup-toggle');
    if (launchAtStartupToggle) {
      try {
        await api.app.setLaunchAtStartup(launchAtStartupToggle.checked);
      } catch (e) {
        console.error('Error setting launch at startup:', e);
      }
    }

    // Show confirmation toast
    showToast({ type: 'info', title: t('settings.saved') || 'Settings saved', message: '' });
  };
}

window.closeModal = closeModal;
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };

// ========== SKILLS & AGENTS ==========
async function loadSkills() {
  if (!localState.skillsInitialized) {
    localState.skillsInitialized = true;
    setupSkillsSubTabs();
  }

  if (localState.skillsActiveSubTab === 'local') {
    await loadLocalSkills();
  } else {
    await loadMarketplaceContent();
  }
}

async function loadLocalSkills() {
  localState.skills = [];
  try {
    await fs.promises.access(skillsDir);
    const items = await fs.promises.readdir(skillsDir);
    for (const item of items) {
      const itemPath = path.join(skillsDir, item);
      try {
        const stat = await fs.promises.stat(itemPath);
        if (stat.isDirectory()) {
          const skillFile = path.join(itemPath, 'SKILL.md');
          try {
            const content = await fs.promises.readFile(skillFile, 'utf8');
            const parsed = parseSkillMd(content);
            localState.skills.push({
              id: item,
              name: parsed.name || item,
              description: parsed.description || 'Aucune description',
              path: itemPath
            });
          } catch { /* SKILL.md not found, skip */ }
        }
      } catch { /* can't stat, skip */ }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error loading skills:', e);
  }
  renderSkills();
}

function setupSkillsSubTabs() {
  document.querySelectorAll('.skills-sub-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.skills-sub-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      localState.skillsActiveSubTab = btn.dataset.subtab;

      const newSkillBtn = document.getElementById('btn-new-skill');
      const searchContainer = document.getElementById('skills-marketplace-search');

      if (btn.dataset.subtab === 'local') {
        newSkillBtn.style.display = '';
        searchContainer.style.display = 'none';
      } else {
        newSkillBtn.style.display = 'none';
        searchContainer.style.display = 'flex';
      }

      loadSkills();
    };
  });

  // Setup marketplace search
  const input = document.getElementById('marketplace-search-input');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(marketplaceSearchTimeout);
      const query = input.value.trim();
      localState.marketplace.searchQuery = query;

      marketplaceSearchTimeout = setTimeout(() => {
        if (query.length >= 2) {
          searchMarketplace(query);
        } else if (query.length === 0) {
          loadMarketplaceFeatured();
        }
      }, 300);
    });
  }
}

/**
 * Parse a SKILL.md file to extract name and description
 * Supports formats:
 * - # Name\nDescription text
 * - # Name\n\nDescription text\n\n## Section
 * - YAML frontmatter with description field
 */
function parseSkillMd(content) {
  let name = null;
  let description = null;

  // Check for YAML frontmatter
  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const yaml = yamlMatch[1];
    const descMatch = yaml.match(/description\s*:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch) description = descMatch[1].trim();
    const nameMatch = yaml.match(/name\s*:\s*["']?(.+?)["']?\s*$/m);
    if (nameMatch) name = nameMatch[1].trim();
  }

  // Get title from first # heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  if (titleMatch && !name) {
    name = titleMatch[1].trim();
  }

  // Get description: text between title and first ## or end of intro
  if (!description) {
    // Remove YAML frontmatter if present
    let body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

    // Find content after the first # heading
    const afterTitle = body.replace(/^#\s+.+\n/, '');

    // Get text until next ## heading or significant section
    const untilNextSection = afterTitle.split(/\n##\s/)[0];

    // Get first non-empty paragraph
    const paragraphs = untilNextSection.split(/\n\n+/);
    for (const p of paragraphs) {
      const cleaned = p.trim();
      // Skip empty, headers, or very short lines
      if (cleaned && !cleaned.startsWith('#') && !cleaned.startsWith('```') && cleaned.length > 10) {
        // Take first line if multi-line paragraph
        description = cleaned.split('\n')[0].trim();
        break;
      }
    }
  }

  return { name, description };
}

async function loadAgents() {
  localState.agents = [];
  try {
    await fs.promises.access(agentsDir);
    const items = await fs.promises.readdir(agentsDir);
    for (const item of items) {
      const itemPath = path.join(agentsDir, item);
      try {
        const stat = await fs.promises.stat(itemPath);

        // Handle .md files directly in agents directory (new format)
        if (stat.isFile() && item.endsWith('.md')) {
          const content = await fs.promises.readFile(itemPath, 'utf8');
          const parsed = parseAgentMd(content);
          const id = item.replace(/\.md$/, '');
          localState.agents.push({
            id,
            name: parsed.name || id,
            description: parsed.description || 'Aucune description',
            tools: parsed.tools || [],
            path: itemPath
          });
        }
        // Handle subdirectories with AGENT.md (legacy format)
        else if (stat.isDirectory()) {
          const agentFile = path.join(itemPath, 'AGENT.md');
          try {
            const content = await fs.promises.readFile(agentFile, 'utf8');
            const parsed = parseAgentMd(content);
            localState.agents.push({
              id: item,
              name: parsed.name || item,
              description: parsed.description || 'Aucune description',
              tools: parsed.tools || [],
              path: itemPath
            });
          } catch { /* AGENT.md not found, skip */ }
        }
      } catch { /* can't stat, skip */ }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Error loading agents:', e);
  }
  renderAgents();
}

/**
 * Parse an AGENT.md file to extract name, description and tools
 * Supports formats:
 * - # Name\ndescription: "..."\ntools: [...]
 * - YAML frontmatter
 * - # Name\n\nDescription paragraph
 */
function parseAgentMd(content) {
  let name = null;
  let description = null;
  let tools = [];

  // Check for YAML frontmatter
  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (yamlMatch) {
    const yaml = yamlMatch[1];
    const descMatch = yaml.match(/description\s*:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch) description = descMatch[1].trim();
    const nameMatch = yaml.match(/name\s*:\s*["']?(.+?)["']?\s*$/m);
    if (nameMatch) name = nameMatch[1].trim();
    const toolsMatch = yaml.match(/tools\s*:\s*\[([^\]]+)\]/);
    if (toolsMatch) tools = toolsMatch[1].split(',').map(t => t.trim().replace(/["']/g, ''));
  }

  // Get title from first # heading
  const titleMatch = content.match(/^#\s+(.+)/m);
  if (titleMatch && !name) {
    name = titleMatch[1].trim();
  }

  // Try to find description in body (key: value format)
  if (!description) {
    const descInBody = content.match(/description\s*:\s*["']([^"']+)["']/i) ||
                       content.match(/description\s*:\s*(.+)$/im);
    if (descInBody) {
      description = descInBody[1].trim().replace(/^["']|["']$/g, '');
    }
  }

  // Try to find tools in body
  if (tools.length === 0) {
    const toolsInBody = content.match(/tools\s*:\s*\[([^\]]+)\]/i);
    if (toolsInBody) {
      tools = toolsInBody[1].split(',').map(t => t.trim().replace(/["']/g, ''));
    }
  }

  // Fallback: get description from first paragraph after title
  if (!description) {
    let body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const afterTitle = body.replace(/^#\s+.+\n/, '');
    const untilNextSection = afterTitle.split(/\n##\s/)[0];

    // Skip lines that look like metadata (key: value)
    const paragraphs = untilNextSection.split(/\n\n+/);
    for (const p of paragraphs) {
      const cleaned = p.trim();
      if (cleaned &&
          !cleaned.startsWith('#') &&
          !cleaned.startsWith('```') &&
          !cleaned.match(/^\w+\s*:/) && // Skip key: value lines
          cleaned.length > 10) {
        description = cleaned.split('\n')[0].trim();
        break;
      }
    }
  }

  return { name, description, tools };
}

function renderSkills() {
  const list = document.getElementById('skills-list');
  if (localState.skills.length === 0) {
    list.innerHTML = `<div class="empty-list"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg><h3>Aucun skill</h3><p>Creez votre premier skill</p></div>`;
    return;
  }

  // Group by source
  const localSkills = localState.skills.filter(s => !s.isPlugin);
  const pluginSkills = localState.skills.filter(s => s.isPlugin);

  // Group plugin skills by sourceLabel
  const pluginsBySource = {};
  pluginSkills.forEach(s => {
    if (!pluginsBySource[s.sourceLabel]) pluginsBySource[s.sourceLabel] = [];
    pluginsBySource[s.sourceLabel].push(s);
  });

  let html = '';

  // Local skills section
  if (localSkills.length > 0) {
    html += `<div class="list-section">
      <div class="list-section-title">Local <span class="list-section-count">${localSkills.length}</span></div>
      <div class="list-section-grid">`;
    html += localSkills.map(s => {
      const desc = (s.description && s.description !== '---' && s.description !== 'Aucune description') ? escapeHtml(s.description) : '';
      const initial = escapeHtml((s.name || '?').charAt(0).toUpperCase());
      return `
      <div class="list-card" data-path="${s.path.replace(/"/g, '&quot;')}" data-is-plugin="false">
        <div class="card-initial">${initial}</div>
        <div class="list-card-header">
          <div class="list-card-title">${escapeHtml(s.name)}</div>
          <div class="list-card-badge">Skill</div>
        </div>
        ${desc ? `<div class="list-card-desc">${desc}</div>` : ''}
        <div class="list-card-footer">
          <button class="btn-sm btn-secondary btn-open">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            ${t('marketplace.openFolder') || 'Ouvrir'}
          </button>
          <button class="btn-sm btn-delete btn-del" title="${t('common.delete') || 'Supprimer'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
    html += `</div></div>`;
  }

  // Plugin skills sections
  Object.entries(pluginsBySource).forEach(([source, skills]) => {
    html += `<div class="list-section">
      <div class="list-section-title"><span class="plugin-badge">Plugin</span> ${escapeHtml(source)} <span class="list-section-count">${skills.length}</span></div>
      <div class="list-section-grid">`;
    html += skills.map(s => {
      const desc = (s.description && s.description !== '---' && s.description !== 'Aucune description') ? escapeHtml(s.description) : '';
      const initial = escapeHtml((s.name || '?').charAt(0).toUpperCase());
      return `
      <div class="list-card plugin-card" data-path="${s.path.replace(/"/g, '&quot;')}" data-is-plugin="true">
        <div class="card-initial">${initial}</div>
        <div class="list-card-header">
          <div class="list-card-title">${escapeHtml(s.name)}</div>
          <div class="list-card-badge plugin">Plugin</div>
        </div>
        ${desc ? `<div class="list-card-desc">${desc}</div>` : ''}
        <div class="list-card-footer">
          <button class="btn-sm btn-secondary btn-open">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            ${t('marketplace.openFolder') || 'Ouvrir'}
          </button>
        </div>
      </div>`;
    }).join('');
    html += `</div></div>`;
  });

  list.innerHTML = html;

  list.querySelectorAll('.list-card').forEach(card => {
    card.querySelector('.btn-open').onclick = () => api.dialog.openInExplorer(card.dataset.path);
    const delBtn = card.querySelector('.btn-del');
    if (delBtn) {
      delBtn.onclick = async () => { if (confirm('Supprimer ce skill ?')) { await fs.promises.rm(card.dataset.path, { recursive: true, force: true }); loadSkills(); } };
    }
  });
}

function renderAgents() {
  const list = document.getElementById('agents-list');
  if (localState.agents.length === 0) {
    list.innerHTML = `<div class="empty-list"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM8 17.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5zM9.5 8c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5S9.5 9.38 9.5 8zm6.5 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg><h3>Aucun agent</h3><p>Creez votre premier agent</p></div>`;
    return;
  }

  let html = `<div class="list-section">
    <div class="list-section-title">Agents <span class="list-section-count">${localState.agents.length}</span></div>
    <div class="list-section-grid">`;
  html += localState.agents.map(a => {
    const desc = (a.description && a.description !== '---' && a.description !== 'Aucune description') ? escapeHtml(a.description) : '';
    const initial = escapeHtml((a.name || '?').charAt(0).toUpperCase());
    return `
    <div class="list-card agent-card" data-path="${a.path.replace(/"/g, '&quot;')}">
      <div class="card-initial">${initial}</div>
      <div class="list-card-header">
        <div class="list-card-title">${escapeHtml(a.name)}</div>
        <div class="list-card-badge agent">Agent</div>
      </div>
      ${desc ? `<div class="list-card-desc">${desc}</div>` : ''}
      <div class="list-card-footer">
        <button class="btn-sm btn-secondary btn-open">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
          ${t('marketplace.openFolder') || 'Ouvrir'}
        </button>
        <button class="btn-sm btn-delete btn-del" title="${t('common.delete') || 'Supprimer'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
  html += `</div></div>`;

  list.innerHTML = html;

  list.querySelectorAll('.list-card').forEach(card => {
    card.querySelector('.btn-open').onclick = () => api.dialog.openInExplorer(card.dataset.path);
    card.querySelector('.btn-del').onclick = async () => { if (confirm('Supprimer cet agent ?')) { await fs.promises.rm(card.dataset.path, { recursive: true, force: true }); loadAgents(); } };
  });
}

// ========== PLUGINS ==========

const PLUGIN_CATEGORIES = {
  all: { label: 'All', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg>' },
  development: { label: 'Dev', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>' },
  productivity: { label: 'Productivity', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>' },
  testing: { label: 'Testing', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19.8 18.4L14 10.67V6.5l1.35-1.69c.26-.33.03-.81-.39-.81H9.04c-.42 0-.65.48-.39.81L10 6.5v4.17L4.2 18.4c-.49.66-.02 1.6.8 1.6h14c.82 0 1.29-.94.8-1.6z"/></svg>' },
  security: { label: 'Security', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>' },
  design: { label: 'Design', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 22C6.49 22 2 17.51 2 12S6.49 2 12 2s10 4.04 10 9c0 3.31-2.69 6-6 6h-1.77c-.28 0-.5.22-.5.5 0 .12.05.23.13.33.41.47.64 1.06.64 1.67A2.5 2.5 0 0112 22zm0-18c-4.41 0-8 3.59-8 8s3.59 8 8 8c.28 0 .5-.22.5-.5a.54.54 0 00-.14-.35c-.41-.46-.63-1.05-.63-1.65a2.5 2.5 0 012.5-2.5H16c2.21 0 4-1.79 4-4 0-3.86-3.59-7-8-7z"/><circle cx="6.5" cy="11.5" r="1.5"/><circle cx="9.5" cy="7.5" r="1.5"/><circle cx="14.5" cy="7.5" r="1.5"/><circle cx="17.5" cy="11.5" r="1.5"/></svg>' },
  database: { label: 'Database', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm6 14c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-5c0 .5-2.13 2-6 2s-6-1.5-6-2V9.77C7.61 10.55 9.72 11 12 11s4.39-.45 6-1.23V12zm-6-3c-3.87 0-6-1.5-6-2s2.13-2 6-2 6 1.5 6 2-2.13 2-6 2z"/></svg>' },
  deployment: { label: 'Deploy', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>' },
  monitoring: { label: 'Monitor', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>' },
  learning: { label: 'Learning', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3L1 9l11 6 9-4.91V17h2V9L12 3z"/></svg>' },
  other: { label: 'Other', icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>' }
};

async function loadPlugins() {
  if (!localState.pluginsInitialized) {
    localState.pluginsInitialized = true;
    setupPluginsSubTabs();
    setupPluginsSearch();
    renderPluginCategoryFilter();
  }

  const content = document.getElementById('plugins-content');
  content.innerHTML = `<div class="plugins-loading"><div class="spinner"></div>${t('common.loading')}</div>`;

  try {
    const [catalogRes, installedRes, mpRes] = await Promise.all([
      api.plugins.catalog(),
      api.plugins.installed(),
      api.plugins.marketplaces()
    ]);

    if (catalogRes.success) localState.pluginsData.catalog = catalogRes.catalog;
    if (installedRes.success) localState.pluginsData.installed = installedRes.installed;
    if (mpRes.success) localState.pluginsData.marketplaces = mpRes.marketplaces;

    renderPluginsContent();
  } catch (e) {
    content.innerHTML = `<div class="plugins-empty-state"><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function setupPluginsSubTabs() {
  document.querySelectorAll('.plugins-sub-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.plugins-sub-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      localState.pluginsActiveSubTab = btn.dataset.subtab;

      const searchContainer = document.getElementById('plugins-search-container');
      const catFilter = document.getElementById('plugins-category-filter');
      if (btn.dataset.subtab === 'discover') {
        searchContainer.style.display = 'flex';
        catFilter.style.display = 'flex';
      } else {
        searchContainer.style.display = btn.dataset.subtab === 'installed' ? 'flex' : 'none';
        catFilter.style.display = 'none';
      }

      renderPluginsContent();
    };
  });
}

function setupPluginsSearch() {
  let timeout;
  const input = document.getElementById('plugins-search-input');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        localState.pluginsData.searchQuery = input.value.trim().toLowerCase();
        renderPluginsContent();
      }, 200);
    });
  }
}

function renderPluginCategoryFilter() {
  const container = document.getElementById('plugins-category-filter');
  if (!container) return;

  let html = '';
  for (const [key, cat] of Object.entries(PLUGIN_CATEGORIES)) {
    const active = key === localState.pluginsData.activeCategory ? 'active' : '';
    html += `<button class="plugin-cat-pill ${active}" data-category="${key}">${cat.label}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('.plugin-cat-pill').forEach(btn => {
    btn.onclick = () => {
      container.querySelectorAll('.plugin-cat-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      localState.pluginsData.activeCategory = btn.dataset.category;
      renderPluginsContent();
    };
  });
}

function renderPluginsContent() {
  const tab = localState.pluginsActiveSubTab;
  if (tab === 'discover') renderPluginsDiscover();
  else if (tab === 'installed') renderPluginsInstalled();
  else if (tab === 'marketplaces') renderPluginsMarketplaces();
}

function formatPluginInstalls(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

function renderPluginsDiscover() {
  const content = document.getElementById('plugins-content');
  let plugins = [...localState.pluginsData.catalog];

  // Filter by search
  const query = localState.pluginsData.searchQuery;
  if (query) {
    plugins = plugins.filter(p =>
      p.name.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query) ||
      (p.category || '').toLowerCase().includes(query)
    );
  }

  // Filter by category
  const cat = localState.pluginsData.activeCategory;
  if (cat !== 'all') {
    plugins = plugins.filter(p => (p.category || 'other') === cat);
  }

  if (plugins.length === 0) {
    content.innerHTML = `<div class="plugins-empty-state">
      <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48" opacity="0.3"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>
      <h3>${t('plugins.noResults') || 'No plugins found'}</h3>
      <p>${t('plugins.trySearch') || 'Try a different search or category'}</p>
    </div>`;
    return;
  }

  // Find max installs for relative bar width
  const maxInstalls = Math.max(...plugins.map(p => p.installs || 0), 1);

  let html = `<div class="plugins-grid">`;
  html += plugins.map((plugin, i) => {
    const catInfo = PLUGIN_CATEGORIES[plugin.category] || PLUGIN_CATEGORIES.other;
    const installPct = Math.max(((plugin.installs || 0) / maxInstalls) * 100, 2);
    const isInstalled = plugin.installed;
    const tags = (plugin.tags || []).map(t => `<span class="plugin-tag">${escapeHtml(t)}</span>`).join('');
    const lspBadge = plugin.hasLsp ? '<span class="plugin-tag lsp">LSP</span>' : '';

    const initial = escapeHtml(plugin.name.charAt(0).toUpperCase());
    return `<div class="plugin-card ${isInstalled ? 'is-installed' : ''}" data-plugin-name="${escapeHtml(plugin.name)}" data-marketplace="${escapeHtml(plugin.marketplace)}" data-category="${plugin.category}" style="animation-delay: ${Math.min(i * 25, 500)}ms">
      <div class="plugin-card-top">
        <div class="plugin-card-icon" data-category="${plugin.category}"><span class="plugin-card-initial">${initial}</span></div>
        <div class="plugin-card-meta">
          <div class="plugin-card-name">${escapeHtml(plugin.name)}</div>
          <div class="plugin-card-author">${plugin.author ? escapeHtml(plugin.author.name || '') : escapeHtml(plugin.marketplace)}</div>
        </div>
        ${isInstalled ? `<span class="plugin-installed-badge">${t('plugins.installedBadge')}</span>` : ''}
      </div>
      <div class="plugin-card-desc">${escapeHtml(plugin.description)}</div>
      <div class="plugin-card-footer">
        <div class="plugin-card-tags">${lspBadge}${tags}<span class="plugin-cat-badge" data-category="${plugin.category}">${escapeHtml(catInfo.label)}</span></div>
        <div class="plugin-card-right">
          <div class="plugin-card-installs">
            <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11" opacity="0.5"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            <span class="plugin-installs-count">${formatPluginInstalls(plugin.installs)}</span>
          </div>
          ${!isInstalled ? `<button class="btn-plugin-install" data-name="${escapeHtml(plugin.name)}" data-marketplace="${escapeHtml(plugin.marketplace)}">${t('plugins.install')}</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  html += `</div>`;

  content.innerHTML = html;
  bindPluginCardHandlers();
}

function renderPluginsInstalled() {
  const content = document.getElementById('plugins-content');
  let plugins = [...localState.pluginsData.installed];

  const query = localState.pluginsData.searchQuery;
  if (query) {
    plugins = plugins.filter(p =>
      p.name.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query)
    );
  }

  if (plugins.length === 0) {
    content.innerHTML = `<div class="plugins-empty-state">
      <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48" opacity="0.3"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>
      <h3>${t('plugins.noInstalled') || 'No plugins installed'}</h3>
      <p>${t('plugins.installHint') || 'Discover and install plugins from the catalog'}</p>
    </div>`;
    return;
  }

  let html = `<div class="plugins-installed-list">`;
  html += plugins.map((plugin, i) => {
    const installDate = plugin.installedAt ? new Date(plugin.installedAt).toLocaleDateString() : '';
    const updateDate = plugin.lastUpdated ? new Date(plugin.lastUpdated).toLocaleDateString() : '';
    const { skills, agents, commands, hooks } = plugin.contents || {};

    const contentBadges = [];
    if (skills) contentBadges.push(`<span class="plugin-content-badge skills">${skills} skill${skills > 1 ? 's' : ''}</span>`);
    if (agents) contentBadges.push(`<span class="plugin-content-badge agents">${agents} agent${agents > 1 ? 's' : ''}</span>`);
    if (commands) contentBadges.push(`<span class="plugin-content-badge commands">${commands} cmd${commands > 1 ? 's' : ''}</span>`);
    if (hooks) contentBadges.push(`<span class="plugin-content-badge hooks">hooks</span>`);

    return `<div class="plugin-installed-item" data-plugin-name="${escapeHtml(plugin.pluginName)}" data-marketplace="${escapeHtml(plugin.marketplace)}" data-path="${escapeHtml(plugin.installPath)}" style="animation-delay: ${i * 50}ms">
      <div class="plugin-installed-main">
        <div class="plugin-installed-icon">${escapeHtml(plugin.name.charAt(0).toUpperCase())}</div>
        <div class="plugin-installed-info">
          <div class="plugin-installed-name-row">
            <span class="plugin-installed-name">${escapeHtml(plugin.name)}</span>
            <span class="plugin-installed-version">v${escapeHtml(plugin.version)}</span>
            <span class="plugin-installed-marketplace">${escapeHtml(plugin.marketplace)}</span>
          </div>
          <div class="plugin-installed-desc">${escapeHtml(plugin.description)}</div>
          <div class="plugin-installed-meta">
            <div class="plugin-installed-contents">${contentBadges.join('')}</div>
            <span class="plugin-installed-date" title="${t('plugins.installedOn')}: ${installDate}${updateDate ? ' | ' + t('plugins.updatedOn') + ': ' + updateDate : ''}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
              ${installDate}
            </span>
            ${plugin.installs ? `<span class="plugin-installed-downloads">${formatPluginInstalls(plugin.installs)} ${t('plugins.installs')}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="plugin-installed-actions">
        <button class="btn-sm btn-secondary btn-plugin-folder" title="${t('plugins.openFolder')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        </button>
        ${plugin.homepage ? `<button class="btn-sm btn-secondary btn-plugin-homepage" title="Homepage" data-url="${escapeHtml(plugin.homepage)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>` : ''}
      </div>
    </div>`;
  }).join('');
  html += `</div>`;

  content.innerHTML = html;
  bindPluginInstalledHandlers();
}

function renderPluginsMarketplaces() {
  const content = document.getElementById('plugins-content');
  const mps = localState.pluginsData.marketplaces;

  // Add marketplace form (always shown)
  let html = `<div class="plugin-add-marketplace-bar">
    <div class="plugin-add-mp-input-group">
      <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" opacity="0.4"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      <input type="text" id="plugin-mp-url-input" placeholder="${t('plugins.addMarketplacePlaceholder')}" spellcheck="false">
    </div>
    <button class="btn-plugin-add-mp" id="btn-add-marketplace">${t('plugins.addMarketplace')}</button>
  </div>`;

  if (mps.length === 0) {
    html += `<div class="plugins-empty-state">
      <h3>${t('plugins.noMarketplaces')}</h3>
      <p>${t('plugins.addMarketplaceHint')}</p>
    </div>`;
  } else {
    html += `<div class="plugins-marketplaces-grid">`;
    html += mps.map((mp, i) => {
      const isOfficial = mp.name === 'claude-plugins-official';
      return `<div class="plugin-marketplace-card ${isOfficial ? 'official' : ''}" style="animation-delay: ${i * 80}ms">
        <div class="plugin-mp-header">
          <div class="plugin-mp-icon">${isOfficial ? '<svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.18l6 3.33v6.98l-6 3.33-6-3.33V7.51l6-3.33z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>'}</div>
          <div class="plugin-mp-info">
            <div class="plugin-mp-name">${escapeHtml(mp.name)}</div>
            <div class="plugin-mp-stats">${mp.pluginCount} ${t('plugins.plugins')}</div>
          </div>
          ${isOfficial ? `<span class="plugin-mp-official-badge">${t('plugins.official')}</span>` : ''}
        </div>
        <div class="plugin-mp-details">
          ${mp.repoUrl ? `<div class="plugin-mp-repo">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
            <span>${escapeHtml(mp.repoUrl)}</span>
          </div>` : ''}
          <div class="plugin-mp-updated">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
            ${t('plugins.lastSynced')}: ${mp.lastUpdated ? new Date(mp.lastUpdated).toLocaleDateString() : t('plugins.never')}
          </div>
        </div>
      </div>`;
    }).join('');
    html += `</div>`;
  }

  content.innerHTML = html;
  bindAddMarketplaceHandler();
}

function bindAddMarketplaceHandler() {
  const btn = document.getElementById('btn-add-marketplace');
  const input = document.getElementById('plugin-mp-url-input');
  if (!btn || !input) return;

  const doAdd = async () => {
    const url = input.value.trim();
    if (!url) return;

    btn.disabled = true;
    btn.textContent = t('plugins.adding');
    input.disabled = true;

    try {
      const result = await api.plugins.addMarketplace(url);
      if (result.success) {
        showToast({ type: 'success', title: t('plugins.addMarketplaceSuccess') });
        input.value = '';
        await loadPlugins();
      } else {
        showToast({ type: 'error', title: t('plugins.addMarketplaceError'), message: result.error || '' });
        btn.disabled = false;
        btn.textContent = t('plugins.addMarketplace');
        input.disabled = false;
      }
    } catch (e) {
      showToast({ type: 'error', title: t('plugins.addMarketplaceError'), message: e.message });
      btn.disabled = false;
      btn.textContent = t('plugins.addMarketplace');
      input.disabled = false;
    }
  };

  btn.onclick = doAdd;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAdd();
  });
}

function bindPluginCardHandlers() {
  document.querySelectorAll('.plugin-card').forEach(card => {
    card.onclick = async () => {
      const pluginName = card.dataset.pluginName;
      const marketplace = card.dataset.marketplace;
      const plugin = localState.pluginsData.catalog.find(p => p.name === pluginName && p.marketplace === marketplace);
      if (plugin) showPluginDetail(plugin);
    };
  });

  // Install buttons on cards
  document.querySelectorAll('.btn-plugin-install').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      handlePluginInstall(btn.dataset.name, btn.dataset.marketplace, btn);
    };
  });
}

function bindPluginInstalledHandlers() {
  document.querySelectorAll('.plugin-installed-item').forEach(item => {
    const folderBtn = item.querySelector('.btn-plugin-folder');
    if (folderBtn) {
      folderBtn.onclick = (e) => {
        e.stopPropagation();
        api.dialog.openInExplorer(item.dataset.path);
      };
    }
    const homepageBtn = item.querySelector('.btn-plugin-homepage');
    if (homepageBtn) {
      homepageBtn.onclick = (e) => {
        e.stopPropagation();
        require('electron').shell.openExternal(homepageBtn.dataset.url);
      };
    }
  });
}

async function handlePluginInstall(pluginName, marketplace, btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('plugins.installing');
  btn.classList.add('installing');

  try {
    const result = await api.plugins.install(marketplace, pluginName);
    if (result.success) {
      showToast({ type: 'success', title: t('plugins.installSuccess') });
      await loadPlugins();
    } else {
      showToast({ type: 'error', title: t('plugins.installError'), message: result.error || '' });
      btn.disabled = false;
      btn.textContent = originalText;
      btn.classList.remove('installing');
    }
  } catch (e) {
    showToast({ type: 'error', title: t('plugins.installError'), message: e.message });
    btn.disabled = false;
    btn.textContent = originalText;
    btn.classList.remove('installing');
  }
}


async function showPluginDetail(plugin) {
  const isInstalled = localState.pluginsData.installed.some(p => p.pluginName === plugin.name);
  const installedInfo = localState.pluginsData.installed.find(p => p.pluginName === plugin.name);
  const catInfo = PLUGIN_CATEGORIES[plugin.category] || PLUGIN_CATEGORIES.other;

  const modalContent = `
    <div class="plugin-detail">
      <div class="plugin-detail-header">
        <div class="plugin-detail-icon" data-category="${plugin.category}">${catInfo.icon}</div>
        <div>
          <div class="plugin-detail-name">${escapeHtml(plugin.name)}</div>
          <div class="plugin-detail-author">${plugin.author ? escapeHtml(plugin.author.name || '') : ''} &middot; ${escapeHtml(plugin.marketplace)}</div>
          <div class="plugin-detail-stats">
            <span>${formatPluginInstalls(plugin.installs)} ${t('plugins.installs')}</span>
            ${plugin.version ? `<span>v${escapeHtml(plugin.version)}</span>` : ''}
            <span class="plugin-cat-badge" data-category="${plugin.category}">${escapeHtml(catInfo.label)}</span>
            ${plugin.hasLsp ? '<span class="plugin-tag lsp">LSP</span>' : ''}
            ${(plugin.tags || []).map(t => `<span class="plugin-tag">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
      </div>
      <div class="plugin-detail-desc">${escapeHtml(plugin.description)}</div>
      ${isInstalled && installedInfo ? `
        <div class="plugin-detail-installed-info">
          <div class="plugin-detail-installed-badge">${t('plugins.installedBadge')}</div>
          <span>v${escapeHtml(installedInfo.version)} &middot; ${new Date(installedInfo.installedAt).toLocaleDateString()}</span>
          ${installedInfo.contents ? `<div class="plugin-installed-contents-detail">
            ${installedInfo.contents.skills ? `<span>${installedInfo.contents.skills} skills</span>` : ''}
            ${installedInfo.contents.agents ? `<span>${installedInfo.contents.agents} agents</span>` : ''}
            ${installedInfo.contents.commands ? `<span>${installedInfo.contents.commands} commands</span>` : ''}
            ${installedInfo.contents.hooks ? `<span>hooks</span>` : ''}
          </div>` : ''}
        </div>
      ` : ''}
      <div class="plugin-detail-readme" id="plugin-detail-readme">
        <div class="plugins-loading"><div class="spinner"></div>${t('plugins.loadingReadme')}</div>
      </div>
      <div class="plugin-detail-actions">
        ${isInstalled
          ? `<button class="btn-secondary btn-plugin-open-folder-detail">${t('plugins.openFolder')}</button>`
          : `<button class="btn-primary btn-plugin-install-detail" data-name="${escapeHtml(plugin.name)}" data-marketplace="${escapeHtml(plugin.marketplace)}">${t('plugins.install')}</button>`
        }
        ${plugin.homepage ? `<button class="btn-secondary btn-plugin-homepage-detail" data-url="${escapeHtml(plugin.homepage)}">${t('plugins.viewOnGithub')}</button>` : ''}
      </div>
    </div>
  `;

  showModal(plugin.name, modalContent);

  // Load README async
  try {
    const result = await api.plugins.readme(plugin.marketplace, plugin.name);
    const readmeEl = document.getElementById('plugin-detail-readme');
    if (readmeEl) {
      if (result.success && result.readme) {
        readmeEl.textContent = result.readme;
        readmeEl.style.whiteSpace = 'pre-wrap';
      } else {
        readmeEl.innerHTML = `<em>${t('plugins.noReadme')}</em>`;
      }
    }
  } catch {
    const readmeEl = document.getElementById('plugin-detail-readme');
    if (readmeEl) readmeEl.innerHTML = `<em>${t('plugins.readmeError')}</em>`;
  }

  // Bind detail action buttons
  const folderBtn = document.querySelector('.btn-plugin-open-folder-detail');
  if (folderBtn && installedInfo) {
    folderBtn.onclick = () => api.dialog.openInExplorer(installedInfo.installPath);
  }
  const homepageBtn = document.querySelector('.btn-plugin-homepage-detail');
  if (homepageBtn) {
    homepageBtn.onclick = () => require('electron').shell.openExternal(homepageBtn.dataset.url);
  }
  const installDetailBtn = document.querySelector('.btn-plugin-install-detail');
  if (installDetailBtn) {
    installDetailBtn.onclick = () => handlePluginInstall(installDetailBtn.dataset.name, installDetailBtn.dataset.marketplace, installDetailBtn);
  }
}

// ========== MARKETPLACE ==========
let marketplaceSearchTimeout = null;

async function loadMarketplaceContent() {
  if (localState.marketplace.searchQuery) {
    await searchMarketplace(localState.marketplace.searchQuery);
  } else {
    await loadMarketplaceFeatured();
  }
}

async function searchMarketplace(query) {
  const list = document.getElementById('skills-list');

  // Show cached results instantly if available
  const cachedResults = localState.marketplace.searchCache.get(query);
  if (cachedResults) {
    localState.marketplace.searchResults = cachedResults;
    renderMarketplaceCards(cachedResults, t('marketplace.searchResults'));
  } else {
    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  }

  try {
    const [result, installedResult] = await Promise.all([
      api.marketplace.search(query, 30),
      api.marketplace.installed()
    ]);
    if (!result.success) throw new Error(result.error);

    const newSkills = result.skills || [];
    if (installedResult.success) {
      localState.marketplace.installed = installedResult.installed || [];
    }

    // Update local search cache
    localState.marketplace.searchCache.set(query, newSkills);

    // Re-render only if data changed
    if (JSON.stringify(newSkills) !== JSON.stringify(localState.marketplace.searchResults)) {
      localState.marketplace.searchResults = newSkills;
      renderMarketplaceCards(newSkills, t('marketplace.searchResults'));
    }
  } catch (e) {
    if (!cachedResults) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

async function loadMarketplaceFeatured() {
  const list = document.getElementById('skills-list');

  // Show cached data instantly if available
  if (localState.marketplace.featured.length > 0) {
    renderMarketplaceCards(localState.marketplace.featured, t('marketplace.featured'));
  } else {
    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  }

  try {
    const [result, installedResult] = await Promise.all([
      api.marketplace.featured(30),
      api.marketplace.installed()
    ]);
    if (!result.success) throw new Error(result.error);

    const newSkills = result.skills || [];
    if (installedResult.success) {
      localState.marketplace.installed = installedResult.installed || [];
    }

    // Re-render only if data changed
    if (JSON.stringify(newSkills) !== JSON.stringify(localState.marketplace.featured)) {
      localState.marketplace.featured = newSkills;
      renderMarketplaceCards(localState.marketplace.featured, t('marketplace.featured'));
    }
  } catch (e) {
    // Only show error if no cached data
    if (localState.marketplace.featured.length === 0) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}


function isSkillInstalled(skillId) {
  // Check if skill folder exists on disk (installed via marketplace, npx skills, or manually)
  try {
    const skillPath = path.join(skillsDir, skillId);
    return fs.existsSync(skillPath) && fs.existsSync(path.join(skillPath, 'SKILL.md'));
  } catch { return false; }
}

function isSkillFromMarketplace(skillId) {
  return localState.marketplace.installed.some(s => s.skillId === skillId);
}

function formatInstallCount(n) {
  if (!n || n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toString();
}

function renderMarketplaceCards(skills, sectionTitle) {
  const list = document.getElementById('skills-list');

  if (!skills || skills.length === 0) {
    list.innerHTML = `<div class="marketplace-empty">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <h3>${t('marketplace.noResults')}</h3>
      <p>${t('marketplace.searchHint')}</p>
    </div>`;
    return;
  }

  let html = `<div class="list-section">
    <div class="list-section-title">${escapeHtml(sectionTitle)} <span class="list-section-count">${skills.length}</span></div>
    <div class="list-section-grid">`;

  html += skills.map(skill => {
    const installed = isSkillInstalled(skill.skillId || skill.name);
    const cardClass = installed ? 'list-card marketplace-card installed' : 'list-card marketplace-card';
    const skillName = skill.name || skill.skillId;
    const initial = escapeHtml((skillName || '?').charAt(0).toUpperCase());
    return `
    <div class="${cardClass}" data-skill-id="${escapeHtml(skill.skillId || skill.name)}" data-source="${escapeHtml(skill.source || '')}" data-name="${escapeHtml(skillName)}" data-installs="${skill.installs || 0}">
      <div class="card-initial">${initial}</div>
      <div class="list-card-header">
        <div class="list-card-title">${escapeHtml(skillName)}</div>
        <div class="list-card-badge marketplace">${installed ? t('marketplace.installedBadge') : 'Skill'}</div>
      </div>
      <div class="marketplace-card-info">
        <div class="marketplace-card-stats">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          ${formatInstallCount(skill.installs)} ${t('marketplace.installs')}
        </div>
        ${skill.source ? `<div class="marketplace-card-source">${escapeHtml(skill.source)}</div>` : ''}
      </div>
      <div class="list-card-footer">
        <button class="btn-sm btn-secondary btn-details">${t('marketplace.details')}</button>
        ${installed
          ? (isSkillFromMarketplace(skill.skillId || skill.name)
              ? `<button class="btn-sm btn-uninstall">${t('marketplace.uninstall')}</button>`
              : `<span class="marketplace-installed-badge">${t('marketplace.installedBadge')}</span>`)
          : `<button class="btn-sm btn-install">${t('marketplace.install')}</button>`
        }
      </div>
    </div>`;
  }).join('');

  html += `</div></div>`;
  list.innerHTML = html;
  bindMarketplaceCardHandlers();
}


function bindMarketplaceCardHandlers() {
  const list = document.getElementById('skills-list');

  list.querySelectorAll('.marketplace-card').forEach(card => {
    const skillId = card.dataset.skillId;
    const source = card.dataset.source;
    const name = card.dataset.name;
    const installs = parseInt(card.dataset.installs) || 0;

    const detailsBtn = card.querySelector('.btn-details');
    if (detailsBtn) {
      detailsBtn.onclick = () => showMarketplaceDetail({ skillId, source, name, installs });
    }

    const installBtn = card.querySelector('.btn-install');
    if (installBtn) {
      installBtn.onclick = async () => {
        installBtn.disabled = true;
        installBtn.textContent = t('marketplace.installing');

        try {
          const result = await api.marketplace.install({ source, skillId, name, installs });
          if (!result.success) throw new Error(result.error);

          // Refresh marketplace view
          await loadMarketplaceContent();
        } catch (e) {
          installBtn.disabled = false;
          installBtn.textContent = t('marketplace.install');
          alert(`${t('marketplace.installError')}: ${e.message}`);
        }
      };
    }

    const uninstallBtn = card.querySelector('.btn-uninstall');
    if (uninstallBtn) {
      uninstallBtn.onclick = async () => {
        if (!confirm(t('marketplace.confirmUninstall', { name: name || skillId }))) return;

        try {
          const result = await api.marketplace.uninstall(skillId);
          if (!result.success) throw new Error(result.error);

          // Refresh marketplace view
          await loadMarketplaceContent();
        } catch (e) {
          alert(e.message);
        }
      };
    }

    const openFolderBtn = card.querySelector('.btn-open-folder');
    if (openFolderBtn) {
      const skillPath = path.join(skillsDir, skillId);
      openFolderBtn.onclick = () => api.dialog.openInExplorer(skillPath);
    }
  });
}

async function showMarketplaceDetail(skill) {
  const { skillId, source, name, installs } = skill;
  const installed = isSkillInstalled(skillId);

  let readmeHtml = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;

  const content = `
    <div class="marketplace-detail-header">
      <div>
        <div class="marketplace-detail-title">${escapeHtml(name || skillId)}</div>
        <div class="marketplace-detail-source">${escapeHtml(source)}</div>
        <div class="marketplace-detail-stats">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          ${formatInstallCount(installs)} ${t('marketplace.installs')}
        </div>
      </div>
    </div>
    <div class="marketplace-detail-readme" id="marketplace-readme-content">${readmeHtml}</div>
    <div class="marketplace-detail-actions">
      ${installed
        ? (isSkillFromMarketplace(skillId)
            ? `<button class="btn-primary btn-uninstall-detail" style="background: var(--danger);">${t('marketplace.uninstall')}</button>
               <button class="btn-secondary btn-open-folder-detail">${t('marketplace.openFolder')}</button>`
            : `<span class="marketplace-installed-badge">${t('marketplace.installedBadge')}</span>
               <button class="btn-secondary btn-open-folder-detail">${t('marketplace.openFolder')}</button>`)
        : `<button class="btn-primary btn-install-detail">${t('marketplace.install')}</button>`
      }
    </div>
  `;

  showModal(t('marketplace.details'), content);

  // Load README async
  try {
    const result = await api.marketplace.readme(source, skillId);
    const readmeEl = document.getElementById('marketplace-readme-content');
    if (readmeEl) {
      if (result.success && result.readme) {
        readmeEl.textContent = result.readme;
      } else {
        readmeEl.innerHTML = `<em>${t('marketplace.noReadme')}</em>`;
      }
    }
  } catch (e) {
    const readmeEl = document.getElementById('marketplace-readme-content');
    if (readmeEl) readmeEl.innerHTML = `<em>${t('marketplace.readmeError')}</em>`;
  }

  // Bind modal action buttons
  const installDetailBtn = document.querySelector('.btn-install-detail');
  if (installDetailBtn) {
    installDetailBtn.onclick = async () => {
      installDetailBtn.disabled = true;
      installDetailBtn.textContent = t('marketplace.installing');
      try {
        const result = await api.marketplace.install({ source, skillId, name, installs });
        if (!result.success) throw new Error(result.error);
        closeModal();
        loadMarketplaceContent();
      } catch (e) {
        installDetailBtn.disabled = false;
        installDetailBtn.textContent = t('marketplace.install');
        alert(`${t('marketplace.installError')}: ${e.message}`);
      }
    };
  }

  const uninstallDetailBtn = document.querySelector('.btn-uninstall-detail');
  if (uninstallDetailBtn) {
    uninstallDetailBtn.onclick = async () => {
      if (!confirm(t('marketplace.confirmUninstall', { name: name || skillId }))) return;
      try {
        await api.marketplace.uninstall(skillId);
        closeModal();
        loadMarketplaceContent();
      } catch (e) {
        alert(e.message);
      }
    };
  }

  const openFolderDetailBtn = document.querySelector('.btn-open-folder-detail');
  if (openFolderDetailBtn) {
    openFolderDetailBtn.onclick = () => api.dialog.openInExplorer(path.join(skillsDir, skillId));
  }
}

// ========== MCP ==========
let mcpRegistrySearchTimeout = null;

function loadMcps() {
  if (!localState.mcpRegistryInitialized) {
    localState.mcpRegistryInitialized = true;
    setupMcpSubTabs();
  }

  if (localState.mcpActiveSubTab === 'local') {
    loadLocalMcps();
  } else {
    loadMcpRegistryContent();
  }
}

function setupMcpSubTabs() {
  document.querySelectorAll('.mcp-sub-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.mcp-sub-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      localState.mcpActiveSubTab = btn.dataset.subtab;

      const searchContainer = document.getElementById('mcp-registry-search');

      if (btn.dataset.subtab === 'local') {
        searchContainer.style.display = 'none';
      } else {
        searchContainer.style.display = 'flex';
      }

      loadMcps();
    };
  });

  // Setup registry search
  const input = document.getElementById('mcp-registry-search-input');
  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(mcpRegistrySearchTimeout);
      const query = input.value.trim();
      localState.mcpRegistry.searchQuery = query;

      mcpRegistrySearchTimeout = setTimeout(() => {
        if (query.length >= 2) {
          searchMcpRegistry(query);
        } else if (query.length === 0) {
          loadMcpRegistryBrowse();
        }
      }, 300);
    });
  }
}

function loadLocalMcps() {
  localState.mcps = [];

  // Load global MCPs from ~/.claude.json (main Claude Code config)
  try {
    if (fs.existsSync(claudeConfigFile)) {
      const config = JSON.parse(fs.readFileSync(claudeConfigFile, 'utf8'));
      if (config.mcpServers) {
        Object.entries(config.mcpServers).forEach(([name, mcpConfig]) => {
          localState.mcps.push({
            id: `global-${name}`,
            name,
            command: mcpConfig.command || '',
            args: mcpConfig.args || [],
            env: mcpConfig.env || {},
            source: 'global',
            sourceLabel: 'Global'
          });
        });
      }
    }
  } catch (e) { console.error('Error loading MCPs from ~/.claude.json:', e); }

  // Also check ~/.claude/settings.json for additional MCPs
  try {
    if (fs.existsSync(claudeSettingsFile)) {
      const settings = JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf8'));
      if (settings.mcpServers) {
        Object.entries(settings.mcpServers).forEach(([name, config]) => {
          // Avoid duplicates
          if (!localState.mcps.find(m => m.name === name)) {
            localState.mcps.push({
              id: `global-${name}`,
              name,
              command: config.command || '',
              args: config.args || [],
              env: config.env || {},
              source: 'global',
              sourceLabel: 'Global'
            });
          }
        });
      }
    }
  } catch (e) { console.error('Error loading MCPs from ~/.claude/settings.json:', e); }

  // Load project-specific MCPs from each project's .claude/settings.local.json
  const projects = projectsState.get().projects;
  projects.forEach(project => {
    try {
      const projectMcpFile = path.join(project.path, '.claude', 'settings.local.json');
      if (fs.existsSync(projectMcpFile)) {
        const projectSettings = JSON.parse(fs.readFileSync(projectMcpFile, 'utf8'));
        if (projectSettings.mcpServers) {
          Object.entries(projectSettings.mcpServers).forEach(([name, config]) => {
            // Avoid duplicates if same MCP exists globally
            const existingGlobal = localState.mcps.find(m => m.name === name && m.source === 'global');
            if (!existingGlobal) {
              localState.mcps.push({
                id: `project-${project.id}-${name}`,
                name,
                command: config.command || '',
                args: config.args || [],
                env: config.env || {},
                source: 'project',
                sourceLabel: project.name,
                projectId: project.id
              });
            }
          });
        }
      }
    } catch (e) { /* ignore project-specific errors */ }
  });

  // Initialize process tracking
  localState.mcps.forEach(mcp => {
    if (!localState.mcpProcesses[mcp.id]) {
      localState.mcpProcesses[mcp.id] = { status: 'stopped', logs: [] };
    }
  });

  renderMcps();
}

function renderMcps() {
  const list = document.getElementById('mcp-list');
  if (localState.mcps.length === 0) {
    list.innerHTML = `<div class="empty-list"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 16l-4-4V8.82C14.16 8.4 15 7.3 15 6c0-1.66-1.34-3-3-3S9 4.34 9 6c0 1.3.84 2.4 2 2.82V12l-4 4H3v5h5v-3.05l4-4.2 4 4.2V21h5v-5h-4z"/></svg><h3>Aucun serveur MCP</h3><p>Configurez des MCPs dans ~/.claude/settings.json</p></div>`;
    return;
  }

  // Group by source
  const globalMcps = localState.mcps.filter(m => m.source === 'global');
  const projectMcps = localState.mcps.filter(m => m.source === 'project');

  let html = '';

  if (globalMcps.length > 0) {
    html += `<div class="mcp-section"><div class="mcp-section-title">Global</div>`;
    html += globalMcps.map(mcp => renderMcpCard(mcp)).join('');
    html += `</div>`;
  }

  if (projectMcps.length > 0) {
    // Group project MCPs by project
    const byProject = {};
    projectMcps.forEach(mcp => {
      if (!byProject[mcp.sourceLabel]) byProject[mcp.sourceLabel] = [];
      byProject[mcp.sourceLabel].push(mcp);
    });

    Object.entries(byProject).forEach(([projectName, mcps]) => {
      html += `<div class="mcp-section"><div class="mcp-section-title">${escapeHtml(projectName)}</div>`;
      html += mcps.map(mcp => renderMcpCard(mcp)).join('');
      html += `</div>`;
    });
  }

  list.innerHTML = html;
}

function renderMcpCard(mcp) {
  return `<div class="mcp-card" data-id="${mcp.id}">
    <div class="mcp-card-header">
      <div class="mcp-card-info">
        <div class="mcp-card-title">${escapeHtml(mcp.name)}</div>
      </div>
    </div>
    <div class="mcp-card-details"><code>${escapeHtml(mcp.command)}${mcp.args?.length ? ' ' + mcp.args.join(' ') : ''}</code></div>
  </div>`;
}

// ========== MCP REGISTRY ==========

function isMcpInstalled(serverName) {
  return localState.mcps.some(m => m.name === serverName);
}

function getMcpServerType(server) {
  if (server.packages && server.packages.length > 0) {
    return server.packages[0].registryType || 'npm';
  }
  if (server.remotes && server.remotes.length > 0) {
    return 'http';
  }
  return null;
}

function getMcpServerIcon(server) {
  // Try icons array
  if (server.icons && server.icons.length > 0) {
    return `<img src="${escapeHtml(server.icons[0])}" onerror="this.parentElement.textContent='${escapeHtml((server.title || server.name || '?').charAt(0).toUpperCase())}'">`;
  }
  // Try GitHub avatar from repository
  if (server.repository && server.repository.url) {
    const ghMatch = server.repository.url.match(/github\.com\/([^/]+)/);
    if (ghMatch) {
      return `<img src="https://github.com/${ghMatch[1]}.png?size=64" onerror="this.parentElement.textContent='${escapeHtml((server.title || server.name || '?').charAt(0).toUpperCase())}'">`;
    }
  }
  return escapeHtml((server.title || server.name || '?').charAt(0).toUpperCase());
}

async function loadMcpRegistryContent() {
  if (localState.mcpRegistry.searchQuery) {
    await searchMcpRegistry(localState.mcpRegistry.searchQuery);
  } else {
    await loadMcpRegistryBrowse();
  }
}

async function searchMcpRegistry(query) {
  const list = document.getElementById('mcp-list');

  // Show cached results instantly
  const cachedResults = localState.mcpRegistry.searchCache.get(query);
  if (cachedResults) {
    localState.mcpRegistry.searchResults = cachedResults;
    renderMcpRegistryCards(cachedResults, t('mcpRegistry.searchResults'));
  } else {
    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  }

  try {
    const result = await api.mcpRegistry.search(query, 30);
    if (!result.success) throw new Error(result.error);

    const newServers = result.servers || [];
    localState.mcpRegistry.searchCache.set(query, newServers);

    if (JSON.stringify(newServers) !== JSON.stringify(localState.mcpRegistry.searchResults)) {
      localState.mcpRegistry.searchResults = newServers;
      renderMcpRegistryCards(newServers, t('mcpRegistry.searchResults'));
    }
  } catch (e) {
    if (!cachedResults) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

async function loadMcpRegistryBrowse() {
  const list = document.getElementById('mcp-list');

  // Show cached data instantly
  if (localState.mcpRegistry.servers.length > 0) {
    renderMcpRegistryCards(localState.mcpRegistry.servers, t('mcpRegistry.available'));
  } else {
    list.innerHTML = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  }

  try {
    const result = await api.mcpRegistry.browse(50);
    if (!result.success) throw new Error(result.error);

    const newServers = result.servers || [];
    if (JSON.stringify(newServers) !== JSON.stringify(localState.mcpRegistry.servers)) {
      localState.mcpRegistry.servers = newServers;
      renderMcpRegistryCards(newServers, t('mcpRegistry.available'));
    }
  } catch (e) {
    if (localState.mcpRegistry.servers.length === 0) {
      list.innerHTML = `<div class="marketplace-empty"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

function renderMcpRegistryCards(servers, sectionTitle) {
  const list = document.getElementById('mcp-list');

  // Reload local MCPs to check installed status
  loadLocalMcpsQuiet();

  if (!servers || servers.length === 0) {
    list.innerHTML = `<div class="marketplace-empty">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <h3>${t('mcpRegistry.noResults')}</h3>
      <p>${t('mcpRegistry.searchHint')}</p>
    </div>`;
    return;
  }

  let html = `<div class="list-section">
    <div class="list-section-title">${escapeHtml(sectionTitle)} <span class="list-section-count">${servers.length}</span></div>
    <div class="list-section-grid">`;

  html += servers.map(server => {
    const serverName = server.name || '';
    const displayName = server.title || serverName;
    const installed = isMcpInstalled(serverName);
    const serverType = getMcpServerType(server);
    const icon = getMcpServerIcon(server);
    const description = server.description || t('mcpRegistry.noDescription');
    const cardClass = installed ? 'mcp-registry-card installed' : 'mcp-registry-card';

    return `
    <div class="${cardClass}" data-server-name="${escapeHtml(serverName)}">
      <div class="mcp-registry-card-header">
        <div class="mcp-registry-icon">${icon}</div>
        <div class="mcp-registry-card-info">
          <div class="mcp-registry-card-title">${escapeHtml(displayName)}</div>
          <div class="mcp-registry-card-desc">${escapeHtml(description)}</div>
        </div>
      </div>
      <div class="mcp-registry-card-footer">
        <div class="mcp-registry-card-badges">
          ${serverType ? `<span class="mcp-registry-badge ${serverType}">${serverType}</span>` : ''}
          ${installed ? `<span class="mcp-registry-badge installed-badge">${t('mcpRegistry.installed')}</span>` : ''}
        </div>
        <div class="mcp-registry-card-actions">
          <button class="btn-sm btn-secondary btn-mcp-details">${t('mcpRegistry.details')}</button>
          ${installed ? '' : `<button class="btn-sm btn-install btn-mcp-install">${t('mcpRegistry.install')}</button>`}
        </div>
      </div>
    </div>`;
  }).join('');

  html += `</div></div>`;
  list.innerHTML = html;
  bindMcpRegistryCardHandlers();
}

function bindMcpRegistryCardHandlers() {
  const list = document.getElementById('mcp-list');

  list.querySelectorAll('.mcp-registry-card').forEach(card => {
    const serverName = card.dataset.serverName;

    const detailsBtn = card.querySelector('.btn-mcp-details');
    if (detailsBtn) {
      detailsBtn.onclick = (e) => {
        e.stopPropagation();
        showMcpRegistryDetail(serverName);
      };
    }

    const installBtn = card.querySelector('.btn-mcp-install');
    if (installBtn) {
      installBtn.onclick = async (e) => {
        e.stopPropagation();
        installBtn.disabled = true;
        installBtn.textContent = t('mcpRegistry.installing');
        try {
          await installMcpFromRegistry(serverName);
          loadMcpRegistryContent();
        } catch (err) {
          installBtn.disabled = false;
          installBtn.textContent = t('mcpRegistry.install');
          alert(`${t('mcpRegistry.installError')}: ${err.message}`);
        }
      };
    }
  });
}

async function showMcpRegistryDetail(serverName) {
  const installed = isMcpInstalled(serverName);

  let content = `<div class="marketplace-loading"><div class="spinner"></div>${t('common.loading')}</div>`;
  showModal(t('mcpRegistry.details'), content);

  try {
    const result = await api.mcpRegistry.detail(serverName);
    if (!result.success) throw new Error(result.error);
    const server = result.server;

    const displayName = server.title || server.name || serverName;
    const description = server.description || t('mcpRegistry.noDescription');
    const serverType = getMcpServerType(server);
    const icon = getMcpServerIcon(server);
    const version = server.version_detail?.version || server.version || '';

    let metaHtml = '';
    if (version) {
      metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.version')}</span><span class="mcp-detail-meta-value">${escapeHtml(version)}</span></div>`;
    }
    if (serverType) {
      metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.serverType')}</span><span class="mcp-detail-meta-value"><span class="mcp-registry-badge ${serverType}">${serverType}</span></span></div>`;
    }
    if (server.packages && server.packages.length > 0) {
      const pkg = server.packages[0];
      metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.packages')}</span><span class="mcp-detail-meta-value">${escapeHtml(pkg.name || pkg.package_name || '')}</span></div>`;
    }
    if (server.repository && server.repository.url) {
      metaHtml += `<div class="mcp-detail-meta-row"><span class="mcp-detail-meta-label">${t('mcpRegistry.repository')}</span><span class="mcp-detail-meta-value"><a href="#" onclick="api.dialog.openExternal('${escapeHtml(server.repository.url)}'); return false;" style="color: var(--accent);">${escapeHtml(server.repository.url)}</a></span></div>`;
    }

    const detailContent = `
      <div class="mcp-detail-header">
        <div class="mcp-detail-icon">${icon}</div>
        <div class="mcp-detail-info">
          <div class="mcp-detail-title">${escapeHtml(displayName)}</div>
          <div class="mcp-detail-name">${escapeHtml(serverName)}</div>
        </div>
      </div>
      <div class="mcp-detail-desc">${escapeHtml(description)}</div>
      ${metaHtml ? `<div class="mcp-detail-meta">${metaHtml}</div>` : ''}
      <div class="mcp-detail-actions">
        ${installed
          ? `<span class="mcp-registry-badge installed-badge" style="font-size: 13px; padding: 6px 16px;">${t('mcpRegistry.installed')}</span>`
          : `<button class="btn-primary btn-mcp-install-detail">${t('mcpRegistry.install')}</button>`
        }
      </div>
    `;

    document.getElementById('modal-body').innerHTML = detailContent;

    const installDetailBtn = document.querySelector('.btn-mcp-install-detail');
    if (installDetailBtn) {
      installDetailBtn.onclick = async () => {
        installDetailBtn.disabled = true;
        installDetailBtn.textContent = t('mcpRegistry.installing');
        try {
          await installMcpFromRegistry(serverName);
          closeModal();
          loadMcpRegistryContent();
        } catch (err) {
          installDetailBtn.disabled = false;
          installDetailBtn.textContent = t('mcpRegistry.install');
          alert(`${t('mcpRegistry.installError')}: ${err.message}`);
        }
      };
    }
  } catch (e) {
    document.getElementById('modal-body').innerHTML = `<div class="marketplace-empty"><h3>${t('common.error')}</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

async function installMcpFromRegistry(serverName) {
  // 1. Get server detail
  const result = await api.mcpRegistry.detail(serverName);
  if (!result.success) throw new Error(result.error);
  const server = result.server;

  // 2. Determine install type
  let mcpConfig = null;
  let serverType = null;
  let envVarsSpec = [];
  let argsSpec = [];

  if (server.packages && server.packages.length > 0) {
    const pkg = server.packages[0];
    serverType = pkg.registryType || 'npm';
    const identifier = pkg.name || pkg.package_name || '';

    // Gather env vars and args from package
    if (pkg.environment_variables && pkg.environment_variables.length > 0) {
      envVarsSpec = pkg.environment_variables;
    }
    if (pkg.arguments && pkg.arguments.length > 0) {
      argsSpec = pkg.arguments;
    }

    if (serverType === 'npm') {
      mcpConfig = { command: 'npx', args: ['-y', identifier] };
    } else if (serverType === 'pypi') {
      mcpConfig = { command: 'uvx', args: [identifier] };
    }
  } else if (server.remotes && server.remotes.length > 0) {
    const remote = server.remotes[0];
    serverType = 'http';

    if (remote.environment_variables && remote.environment_variables.length > 0) {
      envVarsSpec = remote.environment_variables;
    }

    mcpConfig = { type: 'url', url: remote.url };
  }

  if (!mcpConfig) {
    throw new Error(t('mcpRegistry.cannotInstall'));
  }

  // 3. If env vars or args are needed, show the form
  if (envVarsSpec.length > 0 || argsSpec.length > 0) {
    const formResult = await showMcpEnvForm(server, envVarsSpec, argsSpec);
    if (!formResult) return; // User cancelled

    if (formResult.env && Object.keys(formResult.env).length > 0) {
      mcpConfig.env = formResult.env;
    }
    if (formResult.args && formResult.args.length > 0) {
      if (mcpConfig.args) {
        mcpConfig.args = [...mcpConfig.args, ...formResult.args];
      }
    }
  }

  // 4. Write to ~/.claude.json
  saveMcpToConfig(serverName, mcpConfig);

  // 5. Refresh local MCPs
  loadLocalMcpsQuiet();

  // 6. Show success toast
  if (typeof showToast === 'function') {
    showToast({ type: 'success', title: t('mcpRegistry.installSuccess', { name: server.title || serverName }) });
  }
}

function showMcpEnvForm(server, envVarsSpec, argsSpec) {
  return new Promise((resolve) => {
    const displayName = server.title || server.name || '';

    let fieldsHtml = '';

    if (envVarsSpec.length > 0) {
      fieldsHtml += `<div class="mcp-env-section-title">${t('mcpRegistry.environmentVariables')}</div>`;
      envVarsSpec.forEach(envVar => {
        const name = envVar.name || envVar;
        const desc = envVar.description || '';
        const required = envVar.required !== false;
        const isSecret = envVar.isSecret || name.toLowerCase().includes('key') || name.toLowerCase().includes('token') || name.toLowerCase().includes('secret') || name.toLowerCase().includes('password');
        fieldsHtml += `
          <div class="mcp-env-field">
            <label>${escapeHtml(name)} ${required ? `<span class="mcp-env-required">${t('mcpRegistry.requiredField')}</span>` : ''}</label>
            <input type="${isSecret ? 'password' : 'text'}" data-env-name="${escapeHtml(name)}" data-required="${required}" placeholder="${escapeHtml(name)}">
            ${desc ? `<div class="mcp-env-hint">${escapeHtml(desc)}</div>` : ''}
          </div>`;
      });
    }

    if (argsSpec.length > 0) {
      fieldsHtml += `<div class="mcp-env-section-title">${t('mcpRegistry.arguments')}</div>`;
      argsSpec.forEach((arg, i) => {
        const name = arg.name || arg.description || `Arg ${i + 1}`;
        const desc = arg.description || '';
        const required = arg.required !== false;
        fieldsHtml += `
          <div class="mcp-env-field">
            <label>${escapeHtml(name)} ${required ? `<span class="mcp-env-required">${t('mcpRegistry.requiredField')}</span>` : ''}</label>
            <input type="text" data-arg-index="${i}" data-required="${required}" placeholder="${escapeHtml(name)}">
            ${desc ? `<div class="mcp-env-hint">${escapeHtml(desc)}</div>` : ''}
          </div>`;
      });
    }

    const content = `
      <div class="mcp-env-form">
        <div class="mcp-env-form-desc">${t('mcpRegistry.envFormDescription')}</div>
        ${fieldsHtml}
      </div>
    `;

    const footer = `
      <button class="btn-secondary" id="mcp-env-cancel">${t('modal.cancel')}</button>
      <button class="btn-primary" id="mcp-env-confirm">${t('mcpRegistry.install')}</button>
    `;

    showModal(t('mcpRegistry.configureServer') + ' - ' + escapeHtml(displayName), content, footer);

    document.getElementById('mcp-env-cancel').onclick = () => {
      closeModal();
      resolve(null);
    };

    document.getElementById('mcp-env-confirm').onclick = () => {
      const env = {};
      const args = [];
      let valid = true;

      // Collect env vars
      document.querySelectorAll('.mcp-env-form input[data-env-name]').forEach(input => {
        const name = input.dataset.envName;
        const val = input.value.trim();
        const required = input.dataset.required === 'true';
        if (required && !val) {
          input.style.borderColor = 'var(--danger, #ef4444)';
          valid = false;
        } else {
          input.style.borderColor = '';
          if (val) env[name] = val;
        }
      });

      // Collect args
      document.querySelectorAll('.mcp-env-form input[data-arg-index]').forEach(input => {
        const val = input.value.trim();
        const required = input.dataset.required === 'true';
        if (required && !val) {
          input.style.borderColor = 'var(--danger, #ef4444)';
          valid = false;
        } else {
          input.style.borderColor = '';
          if (val) args.push(val);
        }
      });

      if (!valid) return;

      closeModal();
      resolve({ env, args });
    };
  });
}

function saveMcpToConfig(serverName, mcpConfig) {
  try {
    let config = {};
    if (fs.existsSync(claudeConfigFile)) {
      config = JSON.parse(fs.readFileSync(claudeConfigFile, 'utf8'));
    }
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
    config.mcpServers[serverName] = mcpConfig;
    fs.writeFileSync(claudeConfigFile, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving MCP to config:', e);
    throw new Error('Failed to save configuration: ' + e.message);
  }
}

function loadLocalMcpsQuiet() {
  localState.mcps = [];
  try {
    if (fs.existsSync(claudeConfigFile)) {
      const config = JSON.parse(fs.readFileSync(claudeConfigFile, 'utf8'));
      if (config.mcpServers) {
        Object.entries(config.mcpServers).forEach(([name, mcpConfig]) => {
          localState.mcps.push({ id: `global-${name}`, name, command: mcpConfig.command || '', args: mcpConfig.args || [], env: mcpConfig.env || {}, source: 'global', sourceLabel: 'Global' });
        });
      }
    }
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(claudeSettingsFile)) {
      const settings = JSON.parse(fs.readFileSync(claudeSettingsFile, 'utf8'));
      if (settings.mcpServers) {
        Object.entries(settings.mcpServers).forEach(([name, config]) => {
          if (!localState.mcps.find(m => m.name === name)) {
            localState.mcps.push({ id: `global-${name}`, name, command: config.command || '', args: config.args || [], env: config.env || {}, source: 'global', sourceLabel: 'Global' });
          }
        });
      }
    }
  } catch { /* ignore */ }
}

// ========== DASHBOARD ==========
function populateDashboardProjects() {
  const list = document.getElementById('dashboard-projects-list');
  if (!list) return;
  const state = projectsState.get();
  const { projects, folders, rootOrder } = state;

  if (projects.length === 0) {
    list.innerHTML = `<div class="dashboard-projects-empty">Aucun projet</div>`;
    return;
  }

  // Overview item
  const overviewHtml = `
    <div class="dashboard-project-item overview-item ${localState.selectedDashboardProject === -1 ? 'active' : ''}" data-index="-1">
      <div class="dashboard-project-icon">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
      </div>
      <div class="dashboard-project-info">
        <div class="dashboard-project-name">${t('dashboard.overview')}</div>
      </div>
    </div>
  `;

  function renderFolderItem(folder, depth) {
    const projectCount = countProjectsRecursive(folder.id);
    const isCollapsed = folder.collapsed;
    const indent = depth * 16;

    const colorIndicator = folder.color
      ? `<span class="dash-folder-color" style="background: ${folder.color}"></span>`
      : '';

    const folderIcon = folder.icon
      ? `<span class="dash-folder-emoji">${folder.icon}</span>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>`;

    let childrenHtml = '';
    const children = folder.children || [];
    for (const childId of children) {
      const childFolder = folders.find(f => f.id === childId);
      if (childFolder) {
        childrenHtml += renderFolderItem(childFolder, depth + 1);
      } else {
        const childProject = projects.find(p => p.id === childId);
        if (childProject && childProject.folderId === folder.id) {
          childrenHtml += renderProjectItem(childProject, depth + 1);
        }
      }
    }

    return `
      <div class="dash-folder-item" data-folder-id="${folder.id}">
        <div class="dash-folder-header" style="padding-left: ${indent + 8}px">
          <span class="dash-folder-chevron ${isCollapsed ? 'collapsed' : ''}">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
          </span>
          ${colorIndicator}
          <span class="dash-folder-icon">${folderIcon}</span>
          <span class="dash-folder-name">${escapeHtml(folder.name)}</span>
          <span class="dash-folder-count">${projectCount}</span>
        </div>
        <div class="dash-folder-children ${isCollapsed ? 'collapsed' : ''}">
          ${childrenHtml}
        </div>
      </div>
    `;
  }

  function renderProjectItem(project, depth) {
    const index = getProjectIndex(project.id);
    const isActive = localState.selectedDashboardProject === index;
    const indent = depth * 16;

    const colorIndicator = project.color
      ? `<span class="dash-folder-color" style="background: ${project.color}"></span>`
      : '';

    const dashTypeHandler = registry.get(project.type);
    const dashTypeIcon = dashTypeHandler.getDashboardIcon ? dashTypeHandler.getDashboardIcon(project) : null;
    const iconHtml = project.icon
      ? `<span class="dashboard-project-emoji">${project.icon}</span>`
      : (dashTypeIcon || '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>');

    return `
      <div class="dashboard-project-item ${isActive ? 'active' : ''}" data-index="${index}" style="padding-left: ${indent}px">
        <div class="dashboard-project-icon">${colorIndicator}${iconHtml}</div>
        <div class="dashboard-project-info">
          <div class="dashboard-project-name">${escapeHtml(project.name)}</div>
          <div class="dashboard-project-path">${escapeHtml(project.path)}</div>
        </div>
      </div>
    `;
  }

  let itemsHtml = '';
  for (const itemId of (rootOrder || [])) {
    const folder = folders.find(f => f.id === itemId);
    if (folder) {
      itemsHtml += renderFolderItem(folder, 0);
    } else {
      const project = projects.find(p => p.id === itemId);
      if (project) {
        itemsHtml += renderProjectItem(project, 0);
      }
    }
  }

  list.innerHTML = overviewHtml + itemsHtml;

  // Click handlers for projects
  list.querySelectorAll('.dashboard-project-item').forEach(item => {
    item.onclick = () => {
      const index = parseInt(item.dataset.index);
      localState.selectedDashboardProject = index;
      populateDashboardProjects();
      if (index === -1) {
        renderOverviewDashboard();
      } else {
        renderDashboardContent(index);
      }
    };
  });

  // Click handlers for folder headers (toggle collapse)
  list.querySelectorAll('.dash-folder-header').forEach(header => {
    header.onclick = (e) => {
      e.stopPropagation();
      const folderItem = header.closest('.dash-folder-item');
      const folderId = folderItem.dataset.folderId;
      toggleFolderCollapse(folderId);
      populateDashboardProjects();
    };
  });
}

function renderOverviewDashboard() {
  const content = document.getElementById('dashboard-content');
  if (!content) return;

  const projects = projectsState.get().projects;
  const dataMap = {};
  const timesMap = {};
  let hasMissing = false;

  for (const project of projects) {
    const cached = DashboardService.getCachedData(project.id);
    if (cached) dataMap[project.id] = cached;
    else hasMissing = true;
    timesMap[project.id] = getProjectTimes(project.id);
  }

  DashboardService.renderOverview(content, projects, {
    dataMap,
    timesMap,
    onCardClick: (index) => {
      localState.selectedDashboardProject = index;
      populateDashboardProjects();
      renderDashboardContent(index);
    }
  });

  // Trigger preload for missing data (debounced)
  if (hasMissing && !renderOverviewDashboard._preloading) {
    renderOverviewDashboard._preloading = true;
    DashboardService.preloadAllProjects().finally(() => {
      renderOverviewDashboard._preloading = false;
    });
  }
}

// Refresh overview when preload data becomes available
window.addEventListener('dashboard-preload-progress', () => {
  const dashboardTab = document.querySelector('[data-tab="dashboard"]');
  const isDashboardActive = dashboardTab?.classList.contains('active');
  if (isDashboardActive && localState.selectedDashboardProject === -1) {
    renderOverviewDashboard();
  }
});

async function renderDashboardContent(projectIndex) {
  const content = document.getElementById('dashboard-content');
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  const terminalCount = TerminalManager.countTerminalsForProject(projectIndex);
  const fivemStatus = localState.fivemServers.get(projectIndex)?.status || 'stopped';

  await DashboardService.renderDashboard(content, project, {
    terminalCount,
    fivemStatus,
    onOpenFolder: (p) => api.dialog.openInExplorer(p),
    onOpenClaude: (proj) => {
      createTerminalForProject(proj);
      document.querySelector('[data-tab="claude"]')?.click();
    },
    onGitPull: (projectId) => gitPull(projectId),
    onGitPush: (projectId) => gitPush(projectId),
    onMergeAbort: (projectId) => gitMergeAbort(projectId),
    onCopyPath: () => {}
  });
}

// ========== MEMORY ==========
const memoryState = {
  currentSource: 'global',
  currentProject: null,
  content: '',
  isEditing: false,
  listenersAttached: false,
  fileExists: false,
  searchQuery: ''
};

// Templates for CLAUDE.md files
const MEMORY_TEMPLATES = {
  minimal: {
    name: 'Minimal',
    icon: '📝',
    content: `# {PROJECT_NAME}

## Description
Decrivez votre projet ici.

## Instructions
- Preferez TypeScript a JavaScript
- Utilisez des noms de variables explicites
`
  },
  fullstack: {
    name: 'Fullstack',
    icon: '🚀',
    content: `# {PROJECT_NAME}

## Architecture
- Frontend: React/Vue/Svelte
- Backend: Node.js/Express
- Database: PostgreSQL/MongoDB

## Conventions de code
- Utilisez ESLint et Prettier
- Commits en francais avec emojis
- Tests unitaires obligatoires

## Structure des dossiers
\`\`\`
src/
  components/   # Composants UI
  services/     # Logique metier
  utils/        # Fonctions utilitaires
  types/        # Types TypeScript
\`\`\`

## Commandes utiles
\`\`\`bash
npm run dev     # Developpement
npm run build   # Production
npm run test    # Tests
\`\`\`
`
  },
  fivem: {
    name: 'FiveM Resource',
    icon: '🎮',
    content: `# {PROJECT_NAME}

## Type de Resource
Resource FiveM (client/server/shared)

## Framework
- ESX / QBCore / Standalone

## Structure
\`\`\`
client/     # Code client (NUI, events)
server/     # Code serveur (database, callbacks)
shared/     # Code partage (config, utils)
html/       # Interface NUI (HTML/CSS/JS)
\`\`\`

## Conventions FiveM
- Prefixer les events: \`{resource}:{event}\`
- Utiliser les callbacks pour les requetes serveur
- Optimiser les threads (pas de Wait(0) sans raison)
- Nettoyer les entities au stop de la resource

## Database
- Utiliser oxmysql pour les requetes async
- Preparer les statements pour eviter les injections
`
  },
  api: {
    name: 'API REST',
    icon: '🔌',
    content: `# {PROJECT_NAME}

## Type
API REST

## Endpoints
Document your endpoints here:
- \`GET /api/v1/...\`
- \`POST /api/v1/...\`

## Authentication
- JWT / API Keys / OAuth2

## Conventions
- Versionning des endpoints (/v1/, /v2/)
- Reponses JSON standardisees
- Gestion des erreurs coherente
- Rate limiting

## Documentation
Generer la doc Swagger/OpenAPI
`
  },
  library: {
    name: 'Librairie/Package',
    icon: '📦',
    content: `# {PROJECT_NAME}

## Type
Package NPM / Librairie

## Installation
\`\`\`bash
npm install {PROJECT_NAME}
\`\`\`

## API publique
Documentez les fonctions exportees ici.

## Conventions
- Exports nommes preferes aux exports default
- Types TypeScript inclus
- Tests avec couverture > 80%
- Changelog maintenu
- Semver respecte
`
  }
};

function getClaudeDir() {
  return path.join(nodeProcess.env.USERPROFILE || nodeProcess.env.HOME, '.claude');
}

function getGlobalClaudeMd() {
  return path.join(getClaudeDir(), 'CLAUDE.md');
}

function getClaudeSettingsJson() {
  return path.join(getClaudeDir(), 'settings.json');
}

function getClaudeCommandsJson() {
  return path.join(getClaudeDir(), 'settings.json');
}

function loadMemory() {
  renderMemorySources();
  loadMemoryContent('global');
  setupMemoryEventListeners();
}

function renderMemorySources(filter = '') {
  const projectsList = document.getElementById('memory-projects-list');
  const projects = projectsState.get().projects;
  const searchQuery = filter.toLowerCase();

  if (projects.length === 0) {
    projectsList.innerHTML = `<div class="memory-no-projects">Aucun projet</div>`;
    return;
  }

  const filteredProjects = projects.map((p, i) => ({ ...p, index: i }))
    .filter(p => !searchQuery || p.name.toLowerCase().includes(searchQuery));

  if (filteredProjects.length === 0) {
    projectsList.innerHTML = `<div class="memory-no-projects">Aucun resultat pour "${escapeHtml(filter)}"</div>`;
    return;
  }

  projectsList.innerHTML = filteredProjects.map(p => {
    const claudeMdPath = path.join(p.path, 'CLAUDE.md');
    const hasClaudeMd = fs.existsSync(claudeMdPath);
    const claudeIgnorePath = path.join(p.path, '.claudeignore');
    const hasClaudeIgnore = fs.existsSync(claudeIgnorePath);
    const localClaudeDir = path.join(p.path, '.claude');
    const hasLocalSettings = fs.existsSync(path.join(localClaudeDir, 'settings.json'));

    return `
      <div class="memory-source-item ${memoryState.currentSource === 'project' && memoryState.currentProject === p.index ? 'active' : ''}"
           data-source="project" data-project="${p.index}">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
        </svg>
        <span>${escapeHtml(p.name)}</span>
        <div class="memory-source-badges">
          ${hasClaudeMd ? '<span class="memory-badge" title="CLAUDE.md">MD</span>' : ''}
          ${hasClaudeIgnore ? '<span class="memory-badge ignore" title=".claudeignore">IG</span>' : ''}
          ${hasLocalSettings ? '<span class="memory-badge settings" title="Settings locaux">⚙</span>' : ''}
        </div>
      </div>
    `;
  }).join('');

  // Update active states for global, settings, and commands
  document.querySelectorAll('#memory-sources-list > .memory-source-item').forEach(item => {
    const source = item.dataset.source;
    const isActive = source === memoryState.currentSource &&
      (memoryState.currentSource !== 'project' || parseInt(item.dataset.project) === memoryState.currentProject);
    item.classList.toggle('active', isActive);
  });
}

function loadMemoryContent(source, projectIndex = null) {
  memoryState.currentSource = source;
  memoryState.currentProject = projectIndex;
  memoryState.isEditing = false;

  const titleEl = document.getElementById('memory-title');
  const pathEl = document.getElementById('memory-path');
  const contentEl = document.getElementById('memory-content');
  const statsEl = document.getElementById('memory-stats');
  const editBtn = document.getElementById('btn-memory-edit');
  const createBtn = document.getElementById('btn-memory-create');
  const templateBtn = document.getElementById('btn-memory-template');

  let filePath = '';
  let title = '';
  let content = '';
  let fileExists = false;

  try {
    if (source === 'global') {
      filePath = getGlobalClaudeMd();
      title = 'Memoire Globale';
      fileExists = fs.existsSync(filePath);
      if (fileExists) {
        content = fs.readFileSync(filePath, 'utf8');
      } else {
        content = '';
      }
    } else if (source === 'settings') {
      filePath = getClaudeSettingsJson();
      title = 'Settings Claude';
      fileExists = fs.existsSync(filePath);
      if (fileExists) {
        const jsonContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        content = JSON.stringify(jsonContent, null, 2);
      } else {
        content = '{}';
      }
    } else if (source === 'commands') {
      filePath = getClaudeSettingsJson();
      title = 'Commandes Autorisees';
      fileExists = fs.existsSync(filePath);
      if (fileExists) {
        const jsonContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        content = JSON.stringify(jsonContent.allowedCommands || jsonContent.permissions || {}, null, 2);
      } else {
        content = '{}';
      }
    } else if (source === 'project' && projectIndex !== null) {
      const project = projectsState.get().projects[projectIndex];
      if (project) {
        filePath = path.join(project.path, 'CLAUDE.md');
        title = project.name;
        fileExists = fs.existsSync(filePath);
        if (fileExists) {
          content = fs.readFileSync(filePath, 'utf8');
        } else {
          content = '';
        }
      }
    }
  } catch (e) {
    content = `Erreur lors du chargement: ${e.message}`;
  }

  memoryState.content = content;
  memoryState.fileExists = fileExists;

  titleEl.textContent = title;
  pathEl.textContent = filePath.replace(nodeProcess.env.USERPROFILE || nodeProcess.env.HOME, '~');

  // Show/hide buttons based on context
  const isMarkdownSource = source === 'global' || source === 'project';
  editBtn.style.display = (isMarkdownSource && fileExists) ? 'flex' : 'none';
  createBtn.style.display = (isMarkdownSource && !fileExists) ? 'flex' : 'none';
  templateBtn.style.display = (isMarkdownSource && memoryState.isEditing) ? 'flex' : 'none';

  if (isMarkdownSource) {
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg> Editer`;
  }

  // Render stats
  if (fileExists && content) {
    const stats = calculateMemoryStats(content, source);
    statsEl.innerHTML = stats;
    statsEl.style.display = 'flex';
  } else {
    statsEl.style.display = 'none';
  }

  renderMemoryContent(content, source, fileExists);
  renderMemorySources(memoryState.searchQuery);
}

function calculateMemoryStats(content, source) {
  if (source === 'settings' || source === 'commands') {
    try {
      const json = JSON.parse(content);
      const keys = Object.keys(json).length;
      return `<span class="memory-stat"><span class="stat-value">${keys}</span> cles</span>`;
    } catch {
      return '';
    }
  }

  const lines = content.split('\n').length;
  const words = content.split(/\s+/).filter(w => w.length > 0).length;
  const sections = (content.match(/^##\s/gm) || []).length;
  const codeBlocks = (content.match(/```/g) || []).length / 2;

  let html = `
    <span class="memory-stat"><span class="stat-value">${lines}</span> lignes</span>
    <span class="memory-stat"><span class="stat-value">${words}</span> mots</span>
  `;

  if (sections > 0) {
    html += `<span class="memory-stat"><span class="stat-value">${sections}</span> sections</span>`;
  }
  if (codeBlocks > 0) {
    html += `<span class="memory-stat"><span class="stat-value">${Math.floor(codeBlocks)}</span> blocs code</span>`;
  }

  return html;
}

function renderMemoryContent(content, source, fileExists = true) {
  const contentEl = document.getElementById('memory-content');

  if (!fileExists) {
    const isProject = source === 'project';
    const projectName = isProject && memoryState.currentProject !== null
      ? projectsState.get().projects[memoryState.currentProject]?.name || 'Projet'
      : 'Global';

    contentEl.innerHTML = `
      <div class="memory-empty-state">
        <div class="memory-empty-icon">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        </div>
        <h3>Aucun fichier CLAUDE.md</h3>
        <p>Creez un fichier memoire pour ${escapeHtml(projectName)} afin de personnaliser le comportement de Claude.</p>
        <div class="memory-empty-templates">
          <p class="template-hint">Choisissez un template pour commencer :</p>
          <div class="template-grid">
            ${Object.entries(MEMORY_TEMPLATES).map(([key, tpl]) => `
              <button class="template-card" data-template="${key}">
                <span class="template-icon">${tpl.icon}</span>
                <span class="template-name">${tpl.name}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    // Attach template click handlers
    contentEl.querySelectorAll('.template-card').forEach(card => {
      card.onclick = () => createMemoryFromTemplate(card.dataset.template);
    });
    return;
  }

  if (source === 'settings' || source === 'commands') {
    contentEl.innerHTML = `<pre class="memory-json">${escapeHtml(content)}</pre>`;
    return;
  }

  // Parse markdown and render with search highlighting
  let html = parseMarkdownToHtml(content);

  // Highlight search terms if any
  if (memoryState.searchQuery) {
    const regex = new RegExp(`(${escapeHtml(memoryState.searchQuery)})`, 'gi');
    html = html.replace(regex, '<mark class="search-highlight">$1</mark>');
  }

  contentEl.innerHTML = `<div class="memory-markdown">${html}</div>`;
}

function parseMarkdownToHtml(md) {
  // Extract code blocks before escaping HTML to preserve their content
  const codeBlocks = [];
  let processed = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang, code });
    return `\n%%CODEBLOCK_${idx}%%\n`;
  });

  // Extract inline code before escaping
  const inlineCodes = [];
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `%%INLINE_${idx}%%`;
  });

  // Now escape HTML on the remaining text
  let html = escapeHtml(processed);

  // Restore code blocks with escaped content
  codeBlocks.forEach((block, idx) => {
    html = html.replace(
      `%%CODEBLOCK_${idx}%%`,
      `</p><pre class="code-block"><code class="lang-${block.lang}">${escapeHtml(block.code)}</code></pre><p>`
    );
  });

  // Restore inline code with escaped content
  inlineCodes.forEach((code, idx) => {
    html = html.replace(`%%INLINE_${idx}%%`, `<code class="inline-code">${escapeHtml(code)}</code>`);
  });

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="memory-link">$1</a>');

  // Horizontal rules
  html = html.replace(/^---+$/gm, '<hr>');

  // Lists - handle nested with indentation
  html = html.replace(/^(\s*)- (.+)$/gm, (_, indent, text) => {
    const depth = Math.floor(indent.length / 2);
    return `<li class="list-depth-${depth}">${text}</li>`;
  });
  html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Numbered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // Tables: basic support
  html = html.replace(/^\|(.+)\|$/gm, (match, row) => {
    const cells = row.split('|').map(c => c.trim());
    if (cells.every(c => /^[-:]+$/.test(c))) return '%%TABLE_SEP%%';
    const tag = 'td';
    return `<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
  });
  html = html.replace(/((?:<tr>.*<\/tr>\n?%%TABLE_SEP%%\n?)?(?:<tr>.*<\/tr>\n?)+)/g, (match) => {
    let table = match.replace(/%%TABLE_SEP%%\n?/g, '');
    // First row becomes header
    table = table.replace(/<tr>(.*?)<\/tr>/, (_, cells) => {
      return `<thead><tr>${cells.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>')}</tr></thead><tbody>`;
    });
    return `<table class="memory-table">${table}</tbody></table>`;
  });
  html = html.replace(/%%TABLE_SEP%%/g, '');

  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs and fix nesting
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<h[1-4]>)/g, '$1');
  html = html.replace(/(<\/h[1-4]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<pre)/g, '$1');
  html = html.replace(/(<\/pre>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');
  html = html.replace(/<p>(<hr>)/g, '$1');
  html = html.replace(/(<hr>)<\/p>/g, '$1');
  html = html.replace(/<p>(<table)/g, '$1');
  html = html.replace(/(<\/table>)<\/p>/g, '$1');

  return html;
}

function createMemoryFromTemplate(templateKey) {
  const template = MEMORY_TEMPLATES[templateKey];
  if (!template) return;

  let projectName = 'Mon Projet';
  if (memoryState.currentSource === 'project' && memoryState.currentProject !== null) {
    const project = projectsState.get().projects[memoryState.currentProject];
    if (project) projectName = project.name;
  } else if (memoryState.currentSource === 'global') {
    projectName = 'Instructions Globales Claude';
  }

  const content = template.content.replace(/\{PROJECT_NAME\}/g, projectName);

  // Determine file path
  let filePath = '';
  if (memoryState.currentSource === 'global') {
    filePath = getGlobalClaudeMd();
    const claudeDir = getClaudeDir();
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
  } else if (memoryState.currentSource === 'project' && memoryState.currentProject !== null) {
    const project = projectsState.get().projects[memoryState.currentProject];
    if (project) filePath = path.join(project.path, 'CLAUDE.md');
  }

  if (filePath) {
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      loadMemoryContent(memoryState.currentSource, memoryState.currentProject);
    } catch (e) {
      alert(`Erreur lors de la creation: ${e.message}`);
    }
  }
}

function setupMemoryEventListeners() {
  if (memoryState.listenersAttached) return;
  memoryState.listenersAttached = true;

  // Search input
  const searchInput = document.getElementById('memory-search-input');
  if (searchInput) {
    searchInput.oninput = (e) => {
      memoryState.searchQuery = e.target.value;
      renderMemorySources(e.target.value);
      // Also re-render content to highlight matches
      if (memoryState.fileExists) {
        renderMemoryContent(memoryState.content, memoryState.currentSource, memoryState.fileExists);
      }
    };
  }

  // Source navigation
  document.getElementById('memory-sources-list').onclick = (e) => {
    const item = e.target.closest('.memory-source-item');
    if (!item) return;

    const source = item.dataset.source;
    const projectIndex = item.dataset.project !== undefined ? parseInt(item.dataset.project) : null;
    loadMemoryContent(source, projectIndex);
  };

  // Refresh button
  document.getElementById('btn-memory-refresh').onclick = () => {
    loadMemoryContent(memoryState.currentSource, memoryState.currentProject);
  };

  // Open in explorer
  document.getElementById('btn-memory-open').onclick = () => {
    let filePath = '';
    if (memoryState.currentSource === 'global') {
      filePath = getGlobalClaudeMd();
    } else if (memoryState.currentSource === 'settings' || memoryState.currentSource === 'commands') {
      filePath = getClaudeSettingsJson();
    } else if (memoryState.currentSource === 'project' && memoryState.currentProject !== null) {
      const project = projectsState.get().projects[memoryState.currentProject];
      if (project) filePath = path.join(project.path, 'CLAUDE.md');
    }

    if (filePath) {
      // If file doesn't exist, open parent directory
      if (!fs.existsSync(filePath)) {
        filePath = path.dirname(filePath);
      }
      api.dialog.openInExplorer(filePath);
    }
  };

  // Create button
  document.getElementById('btn-memory-create').onclick = () => {
    // Show template selection via modal or directly create with minimal template
    createMemoryFromTemplate('minimal');
  };

  // Template button (shown in edit mode)
  document.getElementById('btn-memory-template').onclick = () => {
    showTemplateModal();
  };

  // Edit button
  document.getElementById('btn-memory-edit').onclick = () => {
    if (memoryState.currentSource === 'settings' || memoryState.currentSource === 'commands') {
      // For settings, just open in explorer
      const filePath = getClaudeSettingsJson();
      if (fs.existsSync(filePath)) {
        api.dialog.openInExplorer(filePath);
      }
      return;
    }

    if (memoryState.isEditing) {
      saveMemoryEdit();
    } else {
      enterMemoryEditMode();
    }
  };
}

function showTemplateModal() {
  const templatesHtml = Object.entries(MEMORY_TEMPLATES).map(([key, tpl]) => `
    <div class="template-option" data-template="${key}">
      <span class="template-icon">${tpl.icon}</span>
      <div class="template-info">
        <div class="template-name">${tpl.name}</div>
        <div class="template-preview">${tpl.content.split('\n').slice(0, 3).join(' ').substring(0, 80)}...</div>
      </div>
    </div>
  `).join('');

  showModal('Inserer un Template', `
    <p style="margin-bottom: 16px; color: var(--text-secondary);">Le template sera insere a la position du curseur.</p>
    <div class="template-list">${templatesHtml}</div>
  `);

  document.querySelectorAll('.template-option').forEach(opt => {
    opt.onclick = () => {
      const template = MEMORY_TEMPLATES[opt.dataset.template];
      if (template) {
        const editor = document.getElementById('memory-editor');
        if (editor) {
          const pos = editor.selectionStart;
          const before = editor.value.substring(0, pos);
          const after = editor.value.substring(pos);
          editor.value = before + template.content + after;
          editor.focus();
        }
      }
      closeModal();
    };
  });
}

function enterMemoryEditMode() {
  memoryState.isEditing = true;
  const contentEl = document.getElementById('memory-content');
  const editBtn = document.getElementById('btn-memory-edit');

  contentEl.innerHTML = `
    <textarea class="memory-editor" id="memory-editor">${escapeHtml(memoryState.content)}</textarea>
  `;

  editBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    Sauvegarder
  `;

  document.getElementById('memory-editor').focus();
}

function saveMemoryEdit() {
  const editor = document.getElementById('memory-editor');
  if (!editor) return;

  const newContent = editor.value;
  let filePath = '';

  if (memoryState.currentSource === 'global') {
    filePath = getGlobalClaudeMd();
    // Ensure .claude directory exists
    const claudeDir = getClaudeDir();
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
  } else if (memoryState.currentSource === 'project' && memoryState.currentProject !== null) {
    const project = projectsState.get().projects[memoryState.currentProject];
    if (project) filePath = path.join(project.path, 'CLAUDE.md');
  }

  if (filePath) {
    try {
      fs.writeFileSync(filePath, newContent, 'utf8');
      memoryState.content = newContent;
    } catch (e) {
      alert(`Erreur lors de la sauvegarde: ${e.message}`);
      return;
    }
  }

  memoryState.isEditing = false;
  const editBtn = document.getElementById('btn-memory-edit');
  editBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
    Editer
  `;

  renderMemoryContent(newContent, memoryState.currentSource);
}

// ========== NEW PROJECT ==========
document.getElementById('btn-new-project').onclick = () => {
  const projectTypes = registry.getAll();
  const categoriesGrouped = registry.getByCategory();

  const buildTypeRows = () => categoriesGrouped.map(({ category: cat, types }) => `
      <div class="project-type-category">${t(cat.nameKey)}</div>
      ${types.map(tp => `
        <div class="project-type-row${tp.id === 'standalone' ? ' selected' : ''}" data-type="${tp.id}">
          <div class="project-type-icon${tp.id !== 'standalone' ? ' ' + tp.id : ''}">${tp.icon}</div>
          <div class="project-type-info">
            <div class="project-type-name">${t(tp.nameKey)}</div>
            <div class="project-type-desc">${t(tp.descKey)}</div>
          </div>
          <div class="project-type-check"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
        </div>
      `).join('')}
    `).join('');

  showModal(t('newProject.title'), `
    <form id="form-project">
      <div class="wizard-step active" data-step="1">
        <div class="wizard-step-header">${t('newProject.stepType')}</div>
        <div class="project-type-list">
          ${buildTypeRows()}
        </div>
        <div class="form-actions">
          <button type="button" class="btn-cancel" onclick="closeModal()">${t('common.cancel')}</button>
          <button type="button" class="btn-primary" id="btn-next-step">${t('newProject.next')}</button>
        </div>
      </div>
      <div class="wizard-step" data-step="2">
        <div class="wizard-step-header">${t('newProject.stepConfig')}</div>
        <div class="wizard-type-badge" id="wizard-type-badge"></div>
        <div class="form-group">
          <label>${t('newProject.source')}</label>
          <div class="source-selector">
            <div class="source-option selected" data-source="folder">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
              <span>${t('newProject.sourceFolder')}</span>
            </div>
            <div class="source-option" data-source="create">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3H9v-2h3V9h2v3h3v2z"/></svg>
              <span>${t('newProject.sourceCreate')}</span>
            </div>
            <div class="source-option" data-source="clone">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>
              <span>${t('newProject.sourceClone')}</span>
            </div>
          </div>
        </div>
        <div class="form-group clone-config" style="display: none;">
          <label>${t('newProject.repoUrl')}</label>
          <input type="text" id="inp-repo-url" placeholder="https://github.com/user/repo.git">
          <div class="github-status-hint" id="github-status-hint"></div>
        </div>
        <div class="form-group">
          <label>${t('newProject.projectName')}</label>
          <input type="text" id="inp-name" placeholder="${t('newProject.projectNamePlaceholder')}" required>
        </div>
        <div class="form-group">
          <label id="label-path">${t('newProject.projectPath')}</label>
          <div class="input-with-btn">
            <input type="text" id="inp-path" placeholder="C:\\chemin\\projet" required>
            <button type="button" class="btn-browse" id="btn-browse">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
            </button>
          </div>
        </div>
        <div class="form-group create-git-config" style="display: none;">
          <label class="checkbox-label">
            <input type="checkbox" id="chk-init-git" checked>
            <span>${t('newProject.initGit')}</span>
          </label>
        </div>
        <div class="type-specific-fields">${projectTypes.map(tp => tp.getWizardFields()).filter(Boolean).join('')}</div>
        <div class="form-group clone-status" style="display: none;">
          <div class="clone-progress">
            <span class="clone-progress-text">${t('newProject.cloning')}</span>
            <div class="clone-progress-bar"><div class="clone-progress-fill"></div></div>
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-cancel" id="btn-prev-step">${t('newProject.back')}</button>
          <button type="submit" class="btn-primary" id="btn-create-project">${t('newProject.create')}</button>
        </div>
      </div>
    </form>
  `);

  let selectedType = 'standalone';
  let selectedSource = 'folder';
  let githubConnected = false;

  // Wizard navigation
  function goToStep(step) {
    document.querySelectorAll('.wizard-step').forEach(s => s.classList.remove('active'));
    document.querySelector(`.wizard-step[data-step="${step}"]`).classList.add('active');
    if (step === 2) {
      const tp = registry.get(selectedType);
      const badge = document.getElementById('wizard-type-badge');
      if (tp && badge) {
        badge.innerHTML = `<span class="wizard-type-badge-icon${tp.id !== 'standalone' ? ' ' + tp.id : ''}">${tp.icon}</span><span>${t(tp.nameKey)}</span>`;
      }
      // Show/hide type-specific config fields
      const form = document.getElementById('form-project');
      projectTypes.forEach(handler => {
        if (handler.onWizardTypeSelected) {
          handler.onWizardTypeSelected(form, handler.id === selectedType);
        }
      });
      // Bind type-specific events
      const currentType = registry.get(selectedType);
      if (currentType.bindWizardEvents) {
        currentType.bindWizardEvents(form, api);
      }
    }
  }

  document.getElementById('btn-next-step').onclick = () => goToStep(2);
  document.getElementById('btn-prev-step').onclick = () => goToStep(1);

  // Type selection (step 1)
  document.querySelectorAll('.project-type-row').forEach(row => {
    row.onclick = () => {
      document.querySelectorAll('.project-type-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      selectedType = row.dataset.type;
    };
  });

  // Check GitHub auth status (simple hint)
  async function updateGitHubHint() {
    const hintEl = document.getElementById('github-status-hint');
    if (!hintEl) return;

    try {
      const result = await api.github.authStatus();
      githubConnected = result.authenticated;
      if (result.authenticated) {
        hintEl.innerHTML = `<span class="hint-success"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> GitHub connecte (${result.login})</span>`;
      } else {
        hintEl.innerHTML = `<span class="hint-warning"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> Repos prives inaccessibles - <a href="#" id="link-github-settings">connecter GitHub</a></span>`;
        document.getElementById('link-github-settings')?.addEventListener('click', (e) => {
          e.preventDefault();
          closeModal();
          switchToSettingsTab('github');
        });
      }
    } catch (e) {
      hintEl.innerHTML = '';
    }
  }

  // Source selector (folder vs clone)
  document.querySelectorAll('.source-option').forEach(opt => {
    opt.onclick = () => {
      document.querySelectorAll('.source-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedSource = opt.dataset.source;
      const isClone = selectedSource === 'clone';
      const isCreate = selectedSource === 'create';
      document.querySelector('.clone-config').style.display = isClone ? 'block' : 'none';
      document.querySelector('.create-git-config').style.display = isCreate ? 'block' : 'none';
      if (isClone) {
        document.getElementById('label-path').textContent = t('newProject.destFolder');
        document.getElementById('inp-path').placeholder = 'C:\\chemin\\destination';
        updateGitHubHint();
      } else if (isCreate) {
        document.getElementById('label-path').textContent = t('newProject.parentFolder');
        document.getElementById('inp-path').placeholder = 'C:\\chemin\\parent';
      } else {
        document.getElementById('label-path').textContent = t('newProject.projectPath');
        document.getElementById('inp-path').placeholder = 'C:\\chemin\\projet';
      }
    };
  });

  // Auto-fill name from repo URL
  document.getElementById('inp-repo-url')?.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    if (url && !document.getElementById('inp-name').value) {
      // Extract repo name from URL
      const match = url.match(/\/([^\/]+?)(\.git)?$/);
      if (match) document.getElementById('inp-name').value = match[1];
    }
  });

  document.getElementById('btn-browse').onclick = async () => {
    const folder = await api.dialog.selectFolder();
    if (folder) {
      document.getElementById('inp-path').value = folder;
      if (!document.getElementById('inp-name').value && selectedSource === 'folder') {
        document.getElementById('inp-name').value = path.basename(folder);
      }
    }
  };

  document.getElementById('form-project').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('inp-name').value.trim();
    let projPath = document.getElementById('inp-path').value.trim();
    const repoUrl = document.getElementById('inp-repo-url')?.value.trim();

    if (!name || !projPath) return;

    // If using existing folder, ensure the directory exists
    if (selectedSource === 'folder') {
      if (!fs.existsSync(projPath)) {
        try {
          fs.mkdirSync(projPath, { recursive: true });
        } catch (err) {
          showToast('Impossible de creer le dossier: ' + err.message, 'error');
          return;
        }
      }
    }

    // If creating new, create the directory
    if (selectedSource === 'create') {
      projPath = path.join(projPath, name);
      try {
        if (fs.existsSync(projPath)) {
          showToast('Ce dossier existe deja', 'error');
          return;
        }
        fs.mkdirSync(projPath, { recursive: true });

        // Init git repo if checked
        if (document.getElementById('chk-init-git')?.checked) {
          const { execSync } = window.electron_nodeModules.child_process;
          try {
            execSync('git init', { cwd: projPath, stdio: 'ignore' });
            fs.writeFileSync(path.join(projPath, '.gitignore'), [
              'node_modules/',
              'dist/',
              'build/',
              '.env',
              '.env.local',
              '*.log',
              '.DS_Store',
              'Thumbs.db',
              ''
            ].join('\n'));
          } catch (gitErr) {
            showToast('Dossier cree mais erreur git init: ' + gitErr.message, 'error');
          }
        }
      } catch (err) {
        showToast('Impossible de creer le dossier: ' + err.message, 'error');
        return;
      }
    }

    // If cloning, append project name to path and clone
    if (selectedSource === 'clone' && repoUrl) {
      projPath = path.join(projPath, name);

      // Show progress
      const submitBtn = document.getElementById('btn-create-project');
      const cloneStatus = document.querySelector('.clone-status');
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span> Clonage...';
      cloneStatus.style.display = 'block';

      try {
        const result = await api.git.clone({ repoUrl, targetPath: projPath });

        if (!result.success) {
          cloneStatus.innerHTML = `<div class="clone-error">${result.error}</div>`;
          submitBtn.disabled = false;
          submitBtn.textContent = t('newProject.create');
          return;
        }
      } catch (err) {
        cloneStatus.innerHTML = `<div class="clone-error">${err.message}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = t('newProject.create');
        return;
      }
    }

    const project = { id: generateProjectId(), name, path: projPath, type: selectedType, folderId: null };
    // Merge type-specific wizard config
    const typeHandler = registry.get(selectedType);
    const typeConfig = typeHandler.getWizardConfig(document.getElementById('form-project'));
    Object.assign(project, typeConfig);

    const projects = [...projectsState.get().projects, project];
    const rootOrder = [...projectsState.get().rootOrder, project.id];
    projectsState.set({ projects, rootOrder });
    saveProjects();
    ProjectList.render();
    closeModal();

    // Detect git status for the new project
    checkProjectGitStatus(project);
  };
};

document.getElementById('btn-new-folder').onclick = () => promptCreateFolder(null);
document.getElementById('btn-show-all').onclick = () => {
  setSelectedProjectFilter(null);
  ProjectList.render();
  TerminalManager.filterByProject(null);
  hideFilterGitActions();
};

// ========== FILTER GIT ACTIONS ==========
const filterGitActions = document.getElementById('filter-git-actions');
const filterBtnPull = document.getElementById('filter-btn-pull');
const filterBtnPush = document.getElementById('filter-btn-push');
const filterBtnBranch = document.getElementById('filter-btn-branch');
const filterBranchName = document.getElementById('filter-branch-name');
const branchDropdown = document.getElementById('branch-dropdown');
const branchDropdownList = document.getElementById('branch-dropdown-list');

let currentFilterProjectId = null;
let branchCache = { projectId: null, data: null };

function hideFilterGitActions() {
  filterGitActions.style.display = 'none';
  branchDropdown.classList.remove('active');
  filterBtnBranch.classList.remove('open');
  currentFilterProjectId = null;
}

async function showFilterGitActions(projectId) {
  const project = getProject(projectId);
  if (!project) {
    hideFilterGitActions();
    return;
  }

  // Check if it's a git repo
  const gitStatus = localState.gitRepoStatus.get(projectId);
  if (!gitStatus || !gitStatus.isGitRepo) {
    filterGitActions.style.display = 'none';
    return;
  }

  currentFilterProjectId = projectId;
  filterGitActions.style.display = 'flex';

  // Reset button states based on this project's git operations
  const gitOps = localState.gitOperations.get(projectId) || {};
  filterBtnPull.classList.toggle('loading', !!gitOps.pulling);
  filterBtnPull.disabled = !!gitOps.pulling;
  filterBtnPush.classList.toggle('loading', !!gitOps.pushing);
  filterBtnPush.disabled = !!gitOps.pushing;

  // Get current branch
  try {
    const branch = await api.git.currentBranch({ projectPath: project.path });
    filterBranchName.textContent = branch || 'main';
  } catch (e) {
    filterBranchName.textContent = '...';
  }
}

// Pull button
filterBtnPull.onclick = async () => {
  if (!currentFilterProjectId) return;
  const projectId = currentFilterProjectId;
  filterBtnPull.classList.add('loading');
  filterBtnPull.disabled = true;
  await gitPull(projectId);
  branchCache = { projectId: null, data: null };
  // Only remove loading if we're still on the same project
  if (currentFilterProjectId === projectId) {
    filterBtnPull.classList.remove('loading');
    filterBtnPull.disabled = false;
  }
};

// Push button
filterBtnPush.onclick = async () => {
  if (!currentFilterProjectId) return;
  const projectId = currentFilterProjectId;
  filterBtnPush.classList.add('loading');
  filterBtnPush.disabled = true;
  await gitPush(projectId);
  branchCache = { projectId: null, data: null };
  // Only remove loading if we're still on the same project
  if (currentFilterProjectId === projectId) {
    filterBtnPush.classList.remove('loading');
    filterBtnPush.disabled = false;
  }
};

// Branch button - toggle dropdown
filterBtnBranch.onclick = async (e) => {
  e.stopPropagation();
  const isOpen = branchDropdown.classList.contains('active');

  if (isOpen) {
    branchDropdown.classList.remove('active');
    filterBtnBranch.classList.remove('open');
  } else {
    // Show dropdown and load branches
    branchDropdown.classList.add('active');
    filterBtnBranch.classList.add('open');

    if (!currentFilterProjectId) return;
    const project = getProject(currentFilterProjectId);
    if (!project) return;

    // Use cache if available for this project
    const useCache = branchCache.projectId === currentFilterProjectId && branchCache.data;

    if (!useCache) {
      branchDropdownList.innerHTML = '<div class="branch-dropdown-loading">Chargement...</div>';
    }

    try {
      let branchesData, currentBranch;
      if (useCache) {
        branchesData = branchCache.data.branchesData;
        currentBranch = branchCache.data.currentBranch;
      } else {
        [branchesData, currentBranch] = await Promise.all([
          api.git.branches({ projectPath: project.path }),
          api.git.currentBranch({ projectPath: project.path })
        ]);
        branchCache = { projectId: currentFilterProjectId, data: { branchesData, currentBranch } };
      }

      const { local = [], remote = [] } = branchesData;

      if (local.length === 0 && remote.length === 0) {
        branchDropdownList.innerHTML = '<div class="branch-dropdown-loading">Aucune branche trouvée</div>';
        return;
      }

      let html = '';

      // Header with create branch button
      html += `<div class="branch-dropdown-header-row">
        <span>Branches</span>
        <button class="branch-create-btn" id="branch-create-toggle" title="Nouvelle branche">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>`;

      // Create branch input (hidden by default)
      html += `<div class="branch-create-input-row" id="branch-create-row" style="display:none">
        <input type="text" class="branch-create-input" id="branch-create-input" placeholder="Nom de la branche..." spellcheck="false" />
        <button class="branch-create-confirm" id="branch-create-confirm" title="Créer">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>`;

      // Local branches section
      if (local.length > 0) {
        html += '<div class="branch-dropdown-section-title">Branches locales</div>';
        html += local.map(branch => {
          const isCurrent = branch === currentBranch;
          return `
          <div class="branch-dropdown-item ${isCurrent ? 'current' : ''}" data-branch="${escapeHtml(branch)}">
            <span class="branch-dropdown-item-name">${escapeHtml(branch)}</span>
            ${!isCurrent ? `<div class="branch-dropdown-actions">
              <button class="branch-action-btn branch-merge-btn" data-action="merge" data-branch="${escapeHtml(branch)}" title="Merge dans ${escapeHtml(currentBranch)}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>
              </button>
              <button class="branch-action-btn branch-delete-btn" data-action="delete" data-branch="${escapeHtml(branch)}" title="Supprimer la branche">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>` : ''}
          </div>`;
        }).join('');
      }

      // Remote branches section
      if (remote.length > 0) {
        html += '<div class="branch-dropdown-section-title remote">Branches distantes</div>';
        html += remote.map(branch => `
          <div class="branch-dropdown-item remote" data-branch="${escapeHtml(branch)}" data-remote="true">
            <svg class="branch-remote-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            <span class="branch-dropdown-item-name">${escapeHtml(branch)}</span>
          </div>
        `).join('');
      }

      branchDropdownList.innerHTML = html;

      // Create branch toggle
      const createToggle = branchDropdownList.querySelector('#branch-create-toggle');
      const createRow = branchDropdownList.querySelector('#branch-create-row');
      const createInput = branchDropdownList.querySelector('#branch-create-input');
      const createConfirm = branchDropdownList.querySelector('#branch-create-confirm');

      createToggle.onclick = (ev) => {
        ev.stopPropagation();
        const visible = createRow.style.display !== 'none';
        createRow.style.display = visible ? 'none' : 'flex';
        if (!visible) createInput.focus();
      };

      const doCreateBranch = async () => {
        const name = createInput.value.trim();
        if (!name) return;
        createConfirm.disabled = true;
        createInput.disabled = true;
        const result = await api.git.createBranch({ projectPath: project.path, branch: name });
        if (result.success) {
          filterBranchName.textContent = name;
          branchCache = { projectId: null, data: null };
          showGitToast({ success: true, title: 'Branche créée', message: `Passé sur ${name}`, duration: 3000 });
          branchDropdown.classList.remove('active');
          filterBtnBranch.classList.remove('open');
          refreshDashboardAsync(currentFilterProjectId);
        } else {
          showGitToast({ success: false, title: 'Erreur', message: result.error || 'Impossible de créer la branche', duration: 5000 });
          createConfirm.disabled = false;
          createInput.disabled = false;
        }
      };

      createConfirm.onclick = (ev) => { ev.stopPropagation(); doCreateBranch(); };
      createInput.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); doCreateBranch(); } };
      createInput.onclick = (ev) => ev.stopPropagation();

      // Action buttons (merge / delete)
      branchDropdownList.querySelectorAll('.branch-action-btn').forEach(btn => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          const action = btn.dataset.action;
          const targetBranch = btn.dataset.branch;

          if (action === 'merge') {
            btn.disabled = true;
            const result = await api.git.merge({ projectPath: project.path, branch: targetBranch });
            if (result.success) {
              branchCache = { projectId: null, data: null };
              showGitToast({ success: true, title: 'Merge réussi', message: `${targetBranch} mergé dans ${currentBranch}`, duration: 3000 });
              branchDropdown.classList.remove('active');
              filterBtnBranch.classList.remove('open');
              refreshDashboardAsync(currentFilterProjectId);
            } else {
              showGitToast({ success: false, title: 'Erreur de merge', message: result.error || 'Merge échoué', duration: 5000 });
              btn.disabled = false;
            }
          }

          if (action === 'delete') {
            // Confirmation
            const item = btn.closest('.branch-dropdown-item');
            const nameSpan = item.querySelector('.branch-dropdown-item-name');
            const actionsDiv = item.querySelector('.branch-dropdown-actions');
            actionsDiv.style.display = 'none';
            nameSpan.innerHTML = `Supprimer <strong>${escapeHtml(targetBranch)}</strong> ?`;
            item.classList.add('confirm-delete');

            const confirmRow = document.createElement('div');
            confirmRow.className = 'branch-delete-confirm-row';
            confirmRow.innerHTML = `
              <button class="branch-confirm-yes">Supprimer</button>
              <button class="branch-confirm-no">Annuler</button>
            `;
            item.appendChild(confirmRow);

            confirmRow.querySelector('.branch-confirm-yes').onclick = async (e2) => {
              e2.stopPropagation();
              const result = await api.git.deleteBranch({ projectPath: project.path, branch: targetBranch });
              if (result.success) {
                branchCache = { projectId: null, data: null };
                showGitToast({ success: true, title: 'Branche supprimée', message: `${targetBranch} supprimée`, duration: 3000 });
                // Re-render the dropdown
                item.remove();
                refreshDashboardAsync(currentFilterProjectId);
              } else {
                showGitToast({ success: false, title: 'Erreur', message: result.error || 'Suppression échouée', duration: 5000 });
                // Restore UI
                confirmRow.remove();
                item.classList.remove('confirm-delete');
                nameSpan.textContent = targetBranch;
                actionsDiv.style.display = '';
              }
            };

            confirmRow.querySelector('.branch-confirm-no').onclick = (e2) => {
              e2.stopPropagation();
              confirmRow.remove();
              item.classList.remove('confirm-delete');
              nameSpan.textContent = targetBranch;
              actionsDiv.style.display = '';
            };
          }
        };
      });

      // Add click handlers for branch checkout
      branchDropdownList.querySelectorAll('.branch-dropdown-item').forEach(item => {
        // Only the item name triggers checkout, not action buttons
        const nameEl = item.querySelector('.branch-dropdown-item-name');
        if (!nameEl) return;
        nameEl.onclick = async (ev) => {
          ev.stopPropagation();
          const branch = item.dataset.branch;
          if (branch === currentBranch) {
            branchDropdown.classList.remove('active');
            filterBtnBranch.classList.remove('open');
            return;
          }

          // Show loading
          nameEl.innerHTML = `<span class="loading-spinner"></span> ${escapeHtml(branch)}`;

          const result = await api.git.checkout({
            projectPath: project.path,
            branch
          });

          if (result.success) {
            filterBranchName.textContent = branch;
            branchCache = { projectId: null, data: null };
            showGitToast({
              success: true,
              title: 'Branche changée',
              message: `Passé sur ${branch}`,
              duration: 3000
            });
            refreshDashboardAsync(currentFilterProjectId);
          } else {
            showGitToast({
              success: false,
              title: 'Erreur',
              message: result.error || 'Impossible de changer de branche',
              duration: 5000
            });
          }

          branchDropdown.classList.remove('active');
          filterBtnBranch.classList.remove('open');
        };
      });
    } catch (e) {
      branchDropdownList.innerHTML = '<div class="branch-dropdown-loading">Erreur de chargement</div>';
    }
  }
};

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!branchDropdown.contains(e.target) && !filterBtnBranch.contains(e.target)) {
    branchDropdown.classList.remove('active');
    filterBtnBranch.classList.remove('open');
  }
});

// Subscribe to project filter changes to show/hide git actions
projectsState.subscribe(() => {
  const selectedFilter = projectsState.get().selectedProjectFilter;
  const projects = projectsState.get().projects;

  if (selectedFilter !== null && projects[selectedFilter]) {
    showFilterGitActions(projects[selectedFilter].id);
  } else {
    hideFilterGitActions();
  }
});

// ========== GIT CHANGES PANEL ==========
const gitChangesPanel = document.getElementById('git-changes-panel');
const gitChangesList = document.getElementById('git-changes-list');
const gitChangesStats = document.getElementById('git-changes-stats');
const gitChangesProject = document.getElementById('git-changes-project');
const gitSelectAll = document.getElementById('git-select-all');
const gitCommitMessage = document.getElementById('git-commit-message');
const btnCommitSelected = document.getElementById('btn-commit-selected');
const btnGenerateCommit = document.getElementById('btn-generate-commit');
const commitCountSpan = document.getElementById('commit-count');
const changesCountBadge = document.getElementById('changes-count');
const filterBtnChanges = document.getElementById('filter-btn-changes');

const gitChangesState = {
  files: [],
  selectedFiles: new Set(),
  projectId: null,
  projectPath: null
};

// Toggle changes panel
filterBtnChanges.onclick = (e) => {
  e.stopPropagation();
  const isOpen = gitChangesPanel.classList.contains('active');

  // Close branch dropdown if open
  branchDropdown.classList.remove('active');
  filterBtnBranch.classList.remove('open');

  if (isOpen) {
    gitChangesPanel.classList.remove('active');
  } else {
    // Position panel aligned to Changes button
    const btnRect = filterBtnChanges.getBoundingClientRect();
    const headerRect = gitChangesPanel.parentElement.getBoundingClientRect();
    const panelWidth = 480;
    let left = btnRect.left - headerRect.left;
    // Ensure panel doesn't overflow right edge of header or viewport
    const maxRight = Math.min(headerRect.width, window.innerWidth - headerRect.left);
    if (left + panelWidth > maxRight) {
      left = Math.max(0, maxRight - panelWidth);
    }
    gitChangesPanel.style.left = left + 'px';

    gitChangesPanel.classList.add('active');
    loadGitChanges();
  }
};

// Close panel
document.getElementById('btn-close-changes').onclick = () => {
  gitChangesPanel.classList.remove('active');
};

// Refresh changes
document.getElementById('btn-refresh-changes').onclick = () => {
  loadGitChanges();
};

// Close panel when clicking outside
document.addEventListener('click', (e) => {
  if (!gitChangesPanel.contains(e.target) && !filterBtnChanges.contains(e.target)) {
    gitChangesPanel.classList.remove('active');
  }
});

async function loadGitChanges() {
  if (!currentFilterProjectId) return;

  const project = getProject(currentFilterProjectId);
  if (!project) return;

  gitChangesState.projectId = currentFilterProjectId;
  gitChangesState.projectPath = project.path;
  gitChangesProject.textContent = `- ${project.name}`;

  gitChangesList.innerHTML = '<div class="git-changes-loading">Chargement des changements...</div>';

  try {
    const status = await api.git.statusDetailed({ projectPath: project.path });

    if (!status.success) {
      gitChangesList.innerHTML = `<div class="git-changes-empty"><p>Erreur: ${status.error}</p></div>`;
      return;
    }

    gitChangesState.files = status.files || [];
    gitChangesState.selectedFiles.clear();

    renderGitChanges();
    updateChangesCount();
  } catch (e) {
    gitChangesList.innerHTML = `<div class="git-changes-empty"><p>Erreur: ${e.message}</p></div>`;
  }
}

function renderGitChanges() {
  const files = gitChangesState.files;

  if (files.length === 0) {
    gitChangesList.innerHTML = `
      <div class="git-changes-empty">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        <p>Aucun changement detecte</p>
      </div>
    `;
    gitChangesStats.innerHTML = '';
    return;
  }

  // Separate tracked (M, D, R, A) and untracked (?) files
  const tracked = [];
  const untracked = [];
  files.forEach((file, index) => {
    if (file.status === '?') {
      untracked.push({ file, index });
    } else {
      tracked.push({ file, index });
    }
  });

  // Calculate stats
  const stats = { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: untracked.length };
  tracked.forEach(({ file }) => {
    if (file.status === 'M') stats.modified++;
    else if (file.status === 'A') stats.added++;
    else if (file.status === 'D') stats.deleted++;
    else if (file.status === 'R') stats.renamed++;
  });

  gitChangesStats.innerHTML = `
    ${stats.modified ? `<span class="git-stat modified">M ${stats.modified}</span>` : ''}
    ${stats.added ? `<span class="git-stat added">A ${stats.added}</span>` : ''}
    ${stats.deleted ? `<span class="git-stat deleted">D ${stats.deleted}</span>` : ''}
    ${stats.renamed ? `<span class="git-stat renamed">R ${stats.renamed}</span>` : ''}
    ${stats.untracked ? `<span class="git-stat untracked">? ${stats.untracked}</span>` : ''}
  `;

  function renderFileItem({ file, index }) {
    const fileName = file.path.split('/').pop();
    const filePath = file.path.split('/').slice(0, -1).join('/');
    const isSelected = gitChangesState.selectedFiles.has(index);

    return `<div class="git-file-item ${isSelected ? 'selected' : ''}" data-index="${index}">
        <input type="checkbox" ${isSelected ? 'checked' : ''}>
        <span class="git-file-status ${file.status}">${file.status}</span>
        <div class="git-file-info">
          <div class="git-file-name">${escapeHtml(fileName)}</div>
          ${filePath ? `<div class="git-file-path">${escapeHtml(filePath)}</div>` : ''}
        </div>
        <div class="git-file-diff">
          ${file.additions ? `<span class="additions">+${file.additions}</span>` : ''}
          ${file.deletions ? `<span class="deletions">-${file.deletions}</span>` : ''}
        </div>
      </div>`;
  }

  let html = '';

  // Tracked changes section
  if (tracked.length > 0) {
    const trackedIndices = tracked.map(t => t.index);
    const allTrackedSelected = trackedIndices.every(i => gitChangesState.selectedFiles.has(i));
    const someTrackedSelected = trackedIndices.some(i => gitChangesState.selectedFiles.has(i));
    html += `<div class="git-changes-section">
      <div class="git-changes-section-header" data-section="tracked">
        <svg class="git-section-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        <input type="checkbox" class="git-section-checkbox" data-section="tracked" ${allTrackedSelected ? 'checked' : ''} ${!allTrackedSelected && someTrackedSelected ? 'data-indeterminate' : ''}>
        <span class="git-section-title">${t('ui.trackedChanges')}</span>
        <span class="git-section-count">${tracked.length}</span>
      </div>
      <div class="git-changes-section-files">
        ${tracked.map(renderFileItem).join('')}
      </div>
    </div>`;
  }

  // Untracked files section
  if (untracked.length > 0) {
    const untrackedIndices = untracked.map(u => u.index);
    const allUntrackedSelected = untrackedIndices.every(i => gitChangesState.selectedFiles.has(i));
    const someUntrackedSelected = untrackedIndices.some(i => gitChangesState.selectedFiles.has(i));
    html += `<div class="git-changes-section">
      <div class="git-changes-section-header" data-section="untracked">
        <svg class="git-section-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        <input type="checkbox" class="git-section-checkbox" data-section="untracked" ${allUntrackedSelected ? 'checked' : ''} ${!allUntrackedSelected && someUntrackedSelected ? 'data-indeterminate' : ''}>
        <span class="git-section-title">${t('ui.untrackedFiles')}</span>
        <span class="git-section-count">${untracked.length}</span>
      </div>
      <div class="git-changes-section-files">
        ${untracked.map(renderFileItem).join('')}
      </div>
    </div>`;
  }

  gitChangesList.innerHTML = html;

  // Set indeterminate state (can't be set via HTML attribute)
  gitChangesList.querySelectorAll('.git-section-checkbox[data-indeterminate]').forEach(cb => {
    cb.indeterminate = true;
    cb.removeAttribute('data-indeterminate');
  });

  // Attach file click handlers
  gitChangesList.querySelectorAll('.git-file-item').forEach(item => {
    const checkbox = item.querySelector('input[type="checkbox"]');
    const index = parseInt(item.dataset.index);

    item.onclick = (e) => {
      if (e.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      toggleFileSelection(index, checkbox.checked);
    };

    checkbox.onchange = () => {
      toggleFileSelection(index, checkbox.checked);
    };
  });

  // Attach section checkbox handlers
  gitChangesList.querySelectorAll('.git-section-checkbox').forEach(cb => {
    cb.onchange = () => {
      const section = cb.dataset.section;
      const items = section === 'tracked' ? tracked : untracked;
      items.forEach(({ index }) => {
        if (cb.checked) {
          gitChangesState.selectedFiles.add(index);
        } else {
          gitChangesState.selectedFiles.delete(index);
        }
      });
      renderGitChanges();
      updateCommitButton();
      updateSelectAllState();
    };
  });

  // Collapsible section headers (click on header but not checkbox)
  gitChangesList.querySelectorAll('.git-changes-section-header').forEach(header => {
    header.onclick = (e) => {
      if (e.target.closest('.git-section-checkbox')) return;
      const filesDiv = header.nextElementSibling;
      if (filesDiv) {
        header.classList.toggle('collapsed');
        filesDiv.classList.toggle('collapsed');
      }
    };
  });

  updateSelectAllState();
}

function toggleFileSelection(index, selected) {
  if (selected) {
    gitChangesState.selectedFiles.add(index);
  } else {
    gitChangesState.selectedFiles.delete(index);
  }

  const item = gitChangesList.querySelector(`[data-index="${index}"]`);
  if (item) {
    item.classList.toggle('selected', selected);
  }

  updateSectionCheckboxes();
  updateCommitButton();
  updateSelectAllState();
}

function updateSectionCheckboxes() {
  const files = gitChangesState.files;
  gitChangesList.querySelectorAll('.git-section-checkbox').forEach(cb => {
    const section = cb.dataset.section;
    const indices = [];
    files.forEach((f, i) => {
      if (section === 'tracked' && f.status !== '?') indices.push(i);
      else if (section === 'untracked' && f.status === '?') indices.push(i);
    });
    if (indices.length === 0) return;
    const allSelected = indices.every(i => gitChangesState.selectedFiles.has(i));
    const someSelected = indices.some(i => gitChangesState.selectedFiles.has(i));
    cb.checked = allSelected;
    cb.indeterminate = !allSelected && someSelected;
  });
}

function updateSelectAllState() {
  const total = gitChangesState.files.length;
  const selected = gitChangesState.selectedFiles.size;
  gitSelectAll.checked = total > 0 && selected === total;
  gitSelectAll.indeterminate = selected > 0 && selected < total;
}

function updateCommitButton() {
  const count = gitChangesState.selectedFiles.size;
  commitCountSpan.textContent = count;
  btnCommitSelected.disabled = count === 0 || !gitCommitMessage.value.trim();
}

function updateChangesCount() {
  const count = gitChangesState.files.length;
  if (count > 0) {
    changesCountBadge.textContent = count;
    changesCountBadge.style.display = 'inline';
    filterBtnChanges.classList.add('has-changes');
  } else {
    changesCountBadge.style.display = 'none';
    filterBtnChanges.classList.remove('has-changes');
  }
}

// Select all checkbox
gitSelectAll.onchange = () => {
  const shouldSelect = gitSelectAll.checked;
  gitChangesState.files.forEach((_, index) => {
    if (shouldSelect) {
      gitChangesState.selectedFiles.add(index);
    } else {
      gitChangesState.selectedFiles.delete(index);
    }
  });

  // Re-render to update section checkboxes and file checkboxes
  renderGitChanges();
  updateCommitButton();
};

// Commit message input
gitCommitMessage.oninput = () => {
  updateCommitButton();
};

// Generate commit message natively
btnGenerateCommit.onclick = async () => {
  if (gitChangesState.selectedFiles.size === 0) {
    showToast({ type: 'warning', title: 'Fichiers requis', message: 'Selectionnez au moins un fichier', duration: 3000 });
    return;
  }

  // Get selected files with their data
  const selectedFiles = Array.from(gitChangesState.selectedFiles)
    .map(i => gitChangesState.files[i])
    .filter(Boolean);

  // Show loading state
  btnGenerateCommit.disabled = true;
  const btnSpan = btnGenerateCommit.querySelector('span');
  const originalText = btnSpan.textContent;
  btnSpan.textContent = '...';

  try {
    const result = await api.git.generateCommitMessage({
      projectPath: gitChangesState.projectPath,
      files: selectedFiles,
      useAi: getSetting('aiCommitMessages') !== false
    });

    if (result.success && result.message) {
      gitCommitMessage.value = result.message;

      const sourceLabel = result.source === 'ai' ? 'AI' : 'Heuristique';
      showToast({
        type: 'success',
        title: `Message généré (${sourceLabel})`,
        message: result.message,
        duration: 3000
      });

      // If multiple groups, suggest splitting
      if (result.groups && result.groups.length > 1) {
        const groupNames = result.groups.map(g => g.name).join(', ');
        setTimeout(() => showToast({
          type: 'info',
          title: 'Commits multiples suggérés',
          message: `Les fichiers touchent ${result.groups.length} zones (${groupNames}). Envisagez de séparer en plusieurs commits.`,
          duration: 6000
        }), 500);
      }
    } else {
      showToast({ type: 'error', title: 'Erreur', message: result.error || 'Impossible de générer le message', duration: 3000 });
    }
  } catch (e) {
    showToast({ type: 'error', title: 'Erreur', message: e.message, duration: 3000 });
  } finally {
    btnGenerateCommit.disabled = false;
    btnSpan.textContent = originalText;
  }
};

// Commit selected files (auto-stages then commits)
btnCommitSelected.onclick = async () => {
  const message = gitCommitMessage.value.trim();
  if (!message) {
    showToast({ type: 'warning', title: 'Message requis', message: 'Entrez un message de commit', duration: 3000 });
    return;
  }

  if (gitChangesState.selectedFiles.size === 0) {
    showToast({ type: 'warning', title: 'Fichiers requis', message: 'Selectionnez au moins un fichier', duration: 3000 });
    return;
  }

  const selectedPaths = Array.from(gitChangesState.selectedFiles)
    .map(i => gitChangesState.files[i]?.path)
    .filter(Boolean);

  btnCommitSelected.disabled = true;
  btnCommitSelected.innerHTML = '<span class="loading-spinner"></span> Commit...';

  try {
    // First stage the files
    const stageResult = await api.git.stageFiles({
      projectPath: gitChangesState.projectPath,
      files: selectedPaths
    });

    if (!stageResult.success) {
      throw new Error(stageResult.error);
    }

    // Then commit
    const commitResult = await api.git.commit({
      projectPath: gitChangesState.projectPath,
      message: message
    });

    if (commitResult.success) {
      showGitToast({
        success: true,
        title: 'Commit cree',
        message: `${selectedPaths.length} fichier(s) commites`,
        duration: 3000
      });
      gitCommitMessage.value = '';
      loadGitChanges();
      refreshDashboardAsync(gitChangesState.projectId);
    } else {
      throw new Error(commitResult.error);
    }
  } catch (e) {
    showGitToast({
      success: false,
      title: 'Erreur de commit',
      message: e.message,
      duration: 5000
    });
  } finally {
    btnCommitSelected.disabled = false;
    btnCommitSelected.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> <span>${t('ui.commitSelected')}</span> (<span id="commit-count">${gitChangesState.selectedFiles.size}</span>)`;
  }
};

// Auto-refresh changes when panel is opened after git operations
async function refreshGitChangesIfOpen() {
  if (gitChangesPanel.classList.contains('active')) {
    await loadGitChanges();
  }
}

// ========== BUNDLED SKILLS INSTALLATION ==========
function installBundledSkills() {
  const bundledSkillsPath = path.join(__dirname, 'resources', 'bundled-skills');
  const bundledSkills = ['create-skill', 'create-agents'];

  bundledSkills.forEach(skillName => {
    const targetPath = path.join(skillsDir, skillName);
    const sourcePath = path.join(bundledSkillsPath, skillName, 'SKILL.md');

    // Only install if not already present
    if (!fs.existsSync(targetPath) && fs.existsSync(sourcePath)) {
      try {
        fs.mkdirSync(targetPath, { recursive: true });
        fs.copyFileSync(sourcePath, path.join(targetPath, 'SKILL.md'));
        console.debug(`Installed bundled skill: ${skillName}`);
      } catch (e) {
        console.error(`Failed to install bundled skill ${skillName}:`, e);
      }
    }
  });
}

// Install bundled skills on startup
installBundledSkills();

// ========== SKILLS/AGENTS CREATION MODAL ==========
let createModalType = 'skill'; // 'skill' or 'agent'

function openCreateModal(type) {
  createModalType = type;
  const modal = document.getElementById('create-modal');
  const title = document.getElementById('create-modal-title');
  const description = document.getElementById('create-modal-description');
  const projectSelect = document.getElementById('create-modal-project');

  title.textContent = type === 'skill' ? 'Nouveau Skill' : 'Nouvel Agent';
  description.value = '';
  description.placeholder = type === 'skill'
    ? 'Ex: Un skill qui genere des tests unitaires pour du code TypeScript en utilisant Vitest...'
    : 'Ex: Un agent qui review le code pour trouver des problemes de securite et de performance...';

  // Populate projects dropdown
  const projects = projectsState.get().projects;
  projectSelect.innerHTML = '<option value="">Selectionnez un projet...</option>' +
    '<option value="global">Global (~/.claude)</option>' +
    projects.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('');

  // Pre-select current project if any
  const selectedFilter = projectsState.get().selectedProjectFilter;
  if (selectedFilter !== null) {
    projectSelect.value = selectedFilter;
  }

  modal.classList.add('active');
  description.focus();
}

function closeCreateModal() {
  document.getElementById('create-modal').classList.remove('active');
}

async function submitCreateModal() {
  const description = document.getElementById('create-modal-description').value.trim();
  const projectIndex = document.getElementById('create-modal-project').value;

  if (!description) {
    alert('Veuillez entrer une description');
    return;
  }

  if (projectIndex === '') {
    alert('Veuillez selectionnez un projet');
    return;
  }

  let project;
  if (projectIndex === 'global') {
    const { os } = window.electron_nodeModules;
    project = { name: 'Global', path: os.homedir(), id: 'global' };
  } else {
    const projects = projectsState.get().projects;
    project = projects[parseInt(projectIndex)];
  }

  if (!project) {
    alert('Projet invalide');
    return;
  }

  closeCreateModal();

  // Switch to Claude tab
  document.querySelector('[data-tab="claude"]')?.click();

  // Create terminal for the project
  const terminalId = await TerminalManager.createTerminal(project, {
    skipPermissions: settingsState.get().skipPermissions
  });

  // Wait for terminal to be ready, then send the command
  setTimeout(() => {
    const command = createModalType === 'skill'
      ? `/create-skill ${description}`
      : `/create-agents ${description}`;

    api.terminal.input({ id: terminalId, data: command + '\r' });
  }, 1500);
}

// Create modal event listeners
document.getElementById('btn-new-skill')?.addEventListener('click', () => openCreateModal('skill'));
document.getElementById('btn-new-agent')?.addEventListener('click', () => openCreateModal('agent'));
document.getElementById('create-modal-close')?.addEventListener('click', closeCreateModal);
document.getElementById('create-modal-cancel')?.addEventListener('click', closeCreateModal);
document.getElementById('create-modal-submit')?.addEventListener('click', submitCreateModal);
document.getElementById('create-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'create-modal') closeCreateModal();
});

// Allow Enter in textarea to not submit, but Ctrl+Enter to submit
document.getElementById('create-modal-description')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    submitCreateModal();
  }
});

// ========== IPC LISTENERS ==========
api.quickPicker.onOpenProject((project) => {
  const projects = projectsState.get().projects;
  const existingProject = projects.find(p => p.path === project.path);
  if (existingProject) {
    const projectIndex = getProjectIndex(existingProject.id);
    setSelectedProjectFilter(projectIndex);
    ProjectList.render();
    createTerminalForProject(existingProject);
  }
});

api.tray.onOpenTerminal(() => {
  const selectedFilter = projectsState.get().selectedProjectFilter;
  const projects = projectsState.get().projects;
  if (selectedFilter !== null && projects[selectedFilter]) {
    createTerminalForProject(projects[selectedFilter]);
  } else if (projects.length > 0) {
    // No project selected, use the first one
    createTerminalForProject(projects[0]);
  }
});

api.tray.onShowSessions(() => {
  const selectedFilter = projectsState.get().selectedProjectFilter;
  const projects = projectsState.get().projects;

  // If a project is selected, show sessions modal
  if (selectedFilter !== null && projects[selectedFilter]) {
    showSessionsModal(projects[selectedFilter]);
  } else if (projects.length > 0) {
    // No project selected, select the first one and show its sessions
    setSelectedProjectFilter(0);
    ProjectList.render();
    showSessionsModal(projects[0]);
  }
});

// ========== PROJECTS PANEL RESIZER ==========
(function initProjectsPanelResizer() {
  const resizer = document.getElementById('projects-panel-resizer');
  const panel = document.querySelector('.projects-panel');
  if (!resizer || !panel) return;

  let startX, startWidth;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      const newWidth = Math.min(600, Math.max(200, startWidth + (e.clientX - startX)));
      panel.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      settingsState.setProp('projectsPanelWidth', panel.offsetWidth);
      saveSettings();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // Restore saved width
  const savedWidth = settingsState.get().projectsPanelWidth;
  if (savedWidth) {
    panel.style.width = savedWidth + 'px';
  }
})();

// ========== PROJECTS PANEL TOGGLE ==========
(function initProjectsPanelToggle() {
  const panel = document.querySelector('.projects-panel');
  const layout = document.getElementById('claude-layout');
  const btnToggle = document.getElementById('btn-toggle-projects');
  const btnShow = document.getElementById('btn-show-projects');
  if (!panel || !layout || !btnToggle || !btnShow) return;

  // Restore saved state
  if (localStorage.getItem('projects-panel-hidden') === 'true') {
    panel.classList.add('collapsed');
    layout.classList.add('projects-hidden');
  }

  btnToggle.onclick = () => {
    panel.classList.add('collapsed');
    layout.classList.add('projects-hidden');
    localStorage.setItem('projects-panel-hidden', 'true');
  };

  btnShow.onclick = () => {
    panel.classList.remove('collapsed');
    layout.classList.remove('projects-hidden');
    localStorage.setItem('projects-panel-hidden', 'false');
  };
})();

// ========== INIT ==========
setupContextMenuHandlers();
checkAllProjectsGitStatus();
ProjectList.render();

// Preload marketplace data silently
api.marketplace.featured(30).then(result => {
  if (result.success) localState.marketplace.featured = result.skills || [];
}).catch(() => {});

// Preload MCP registry data silently
api.mcpRegistry.browse(50).then(result => {
  if (result.success) localState.mcpRegistry.servers = result.servers || [];
}).catch(() => {});

// Initialize keyboard shortcuts with customizable settings
// Ctrl+Arrow shortcuts are handled directly in TerminalManager.js
// They only work when focused on a terminal (which is the only context where they make sense)
// Ctrl+Shift+T is handled by globalShortcut in main.js which sends 'open-terminal-current-project' IPC event
registerAllShortcuts();

// ========== UPDATE SYSTEM (GitHub Desktop style) ==========
const updateBanner = document.getElementById('update-banner');
const updateMessage = document.getElementById('update-message');
const updateProgressContainer = document.getElementById('update-progress-container');
const updateProgressBar = document.getElementById('update-progress-bar');
const updateProgressText = document.getElementById('update-progress-text');
const updateBtn = document.getElementById('update-btn');
const updateDismiss = document.getElementById('update-dismiss');

let updateState = {
  available: false,
  downloaded: false,
  version: null,
  downloadedVersion: null,  // Track actual downloaded version
  dismissed: false,
  dismissedVersion: null    // Track which version was dismissed
};

function showUpdateBanner() {
  if (updateState.dismissed) return;
  updateBanner.style.display = 'block';
  // Adjust main container height
  document.querySelector('.main-container').style.height = 'calc(100vh - 36px - 44px)';
}

function hideUpdateBanner() {
  updateBanner.style.display = 'none';
  document.querySelector('.main-container').style.height = 'calc(100vh - 36px)';
}

function updateProgress(percent) {
  const p = Math.round(percent);
  updateProgressBar.style.setProperty('--progress', `${p}%`);
  updateProgressText.textContent = `${p}%`;
}

// Handle update status from main process
api.updates.onStatus((data) => {
  switch (data.status) {
    case 'available':
      // If a new version is detected (different from what we knew about)
      // Reset dismiss state so user sees the new version
      if (updateState.version && data.version !== updateState.version) {
        // New version detected, reset dismiss if it was for the old version
        if (updateState.dismissedVersion !== data.version) {
          updateState.dismissed = false;
        }
        // Reset downloaded state since we're downloading a new version
        updateState.downloaded = false;
        updateState.downloadedVersion = null;
      }

      updateState.available = true;
      updateState.version = data.version;
      updateMessage.textContent = `Nouvelle version disponible: v${data.version}`;
      updateProgressContainer.style.display = 'flex';
      updateBtn.style.display = 'none';
      updateBanner.classList.remove('downloaded');
      showUpdateBanner();
      break;

    case 'downloading':
      updateProgress(data.progress || 0);
      break;

    case 'downloaded':
      updateState.downloaded = true;
      updateState.downloadedVersion = data.version;  // Track actual downloaded version
      updateState.version = data.version;  // Update to actual version
      updateMessage.textContent = `v${data.version} prete a installer`;
      updateProgressContainer.style.display = 'none';
      updateBtn.style.display = 'block';
      updateBtn.disabled = false;  // Re-enable button
      updateBtn.textContent = 'Redémarrer pour mettre à jour';  // Reset button text
      updateBanner.classList.add('downloaded');
      showUpdateBanner();
      break;

    case 'not-available':
      // No new version, hide banner if showing
      if (updateState.available && !updateState.downloaded) {
        hideUpdateBanner();
        updateState.available = false;
        updateState.version = null;
      }
      break;

    case 'error':
      console.error('Update error:', data.error);
      // Only hide if we were downloading, not if already downloaded
      if (!updateState.downloaded) {
        hideUpdateBanner();
      }
      break;
  }
});

// Restart and install button
updateBtn.addEventListener('click', () => {
  // Disable button and show installing state
  updateBtn.disabled = true;
  updateBtn.textContent = 'Installation...';
  api.app.installUpdate();
});

// Dismiss button
updateDismiss.addEventListener('click', () => {
  updateState.dismissed = true;
  updateState.dismissedVersion = updateState.version;  // Track which version was dismissed
  hideUpdateBanner();
});

// Display current version
api.app.getVersion().then(version => {
  const versionEl = document.getElementById('app-version');
  if (versionEl) {
    versionEl.textContent = `v${version}`;
  }
}).catch(() => {});

// ========== USAGE MONITOR ==========
const usageElements = {
  container: document.getElementById('titlebar-usage'),
  session: {
    bar: document.getElementById('usage-bar-session'),
    percent: document.getElementById('usage-percent-session')
  },
  weekly: {
    bar: document.getElementById('usage-bar-weekly'),
    percent: document.getElementById('usage-percent-weekly')
  },
  sonnet: {
    bar: document.getElementById('usage-bar-sonnet'),
    percent: document.getElementById('usage-percent-sonnet')
  }
};

/**
 * Update a single usage bar
 */
function updateUsageBar(elements, percent) {
  if (!elements.bar || !elements.percent) return;

  if (percent === null || percent === undefined) {
    elements.percent.textContent = '--%';
    elements.bar.style.width = '0%';
    elements.bar.classList.remove('warning', 'danger');
    return;
  }

  const roundedPercent = Math.round(percent);
  elements.percent.textContent = `${roundedPercent}%`;
  elements.bar.style.width = `${Math.min(roundedPercent, 100)}%`;

  // Set color based on usage level
  elements.bar.classList.remove('warning', 'danger');
  if (roundedPercent >= 90) {
    elements.bar.classList.add('danger');
  } else if (roundedPercent >= 70) {
    elements.bar.classList.add('warning');
  }
}

/**
 * Update usage display with new data
 */
function updateUsageDisplay(usageData) {
  if (!usageElements.container) return;

  usageElements.container.classList.remove('loading');

  if (!usageData || !usageData.data) {
    updateUsageBar(usageElements.session, null);
    updateUsageBar(usageElements.weekly, null);
    updateUsageBar(usageElements.sonnet, null);
    return;
  }

  const data = usageData.data;

  // Update all three usage bars
  updateUsageBar(usageElements.session, data.session);
  updateUsageBar(usageElements.weekly, data.weekly);
  updateUsageBar(usageElements.sonnet, data.sonnet);
}

/**
 * Fetch and update usage
 */
async function refreshUsageDisplay() {
  if (!usageElements.container) return;

  usageElements.container.classList.add('loading');

  try {
    const result = await api.usage.refresh();
    if (result.success) {
      updateUsageDisplay({ data: result.data, lastFetch: new Date().toISOString() });
    } else {
      usageElements.container.classList.remove('loading');
      updateUsageBar(usageElements.session, null);
      updateUsageBar(usageElements.weekly, null);
      updateUsageBar(usageElements.sonnet, null);
    }
  } catch (error) {
    usageElements.container.classList.remove('loading');
    updateUsageBar(usageElements.session, null);
    updateUsageBar(usageElements.weekly, null);
    updateUsageBar(usageElements.sonnet, null);
    console.error('Usage refresh error:', error);
  }
}

// Initialize usage monitor
if (usageElements.container) {
  // Click to refresh
  usageElements.container.addEventListener('click', () => {
    refreshUsageDisplay();
  });

  // Start periodic monitoring (every 60 seconds)
  api.usage.startMonitor(60000).catch(console.error);

  // Poll for updates every 5 seconds (check cached data)
  setInterval(async () => {
    try {
      const data = await api.usage.getData();
      if (data && data.data) {
        updateUsageDisplay(data);
      }
    } catch (e) {
      // Ignore errors during polling
    }
  }, 5000);

  // Initial fetch
  setTimeout(() => {
    refreshUsageDisplay();
  }, 2000);
}

// ========== CI STATUS BAR ==========
const ciStatusBar = {
  element: document.getElementById('ci-status-bar'),
  workflowName: document.getElementById('ci-workflow-name'),
  statusText: document.getElementById('ci-status-text'),
  branch: document.getElementById('ci-branch'),
  duration: document.getElementById('ci-duration'),
  linkBtn: document.getElementById('ci-status-link'),
  closeBtn: document.getElementById('ci-status-close'),
  currentRun: null,
  pollInterval: null,
  hideTimeout: null,
  startTime: null
};

/**
 * Show CI status bar with workflow info
 */
function showCIStatusBar(run) {
  if (!ciStatusBar.element) return;

  ciStatusBar.currentRun = run;
  ciStatusBar.startTime = new Date(run.createdAt);

  // Update content
  ciStatusBar.workflowName.textContent = run.name;
  ciStatusBar.branch.textContent = run.branch;

  // Set status
  ciStatusBar.element.classList.remove('success', 'failure', 'hiding');

  if (run.status === 'completed') {
    if (run.conclusion === 'success') {
      ciStatusBar.element.classList.add('success');
      ciStatusBar.statusText.textContent = 'Passed';
    } else {
      ciStatusBar.element.classList.add('failure');
      ciStatusBar.statusText.textContent = run.conclusion === 'cancelled' ? 'Cancelled' : 'Failed';
    }
  } else {
    ciStatusBar.statusText.textContent = run.status === 'queued' ? 'Queued' : 'Running';
  }

  // Update duration
  updateCIDuration();

  // Show bar
  ciStatusBar.element.style.display = 'flex';

  // Auto-hide after completion (5 seconds)
  if (run.status === 'completed') {
    clearTimeout(ciStatusBar.hideTimeout);
    ciStatusBar.hideTimeout = setTimeout(() => {
      hideCIStatusBar();
    }, 5000);
  }
}

/**
 * Hide CI status bar with animation
 */
function hideCIStatusBar() {
  if (!ciStatusBar.element) return;

  ciStatusBar.element.classList.add('hiding');
  setTimeout(() => {
    ciStatusBar.element.style.display = 'none';
    ciStatusBar.element.classList.remove('hiding');
    ciStatusBar.currentRun = null;
  }, 300);
}

/**
 * Update duration display
 */
function updateCIDuration() {
  if (!ciStatusBar.startTime || !ciStatusBar.duration) return;

  const elapsed = Math.floor((Date.now() - ciStatusBar.startTime.getTime()) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  ciStatusBar.duration.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Check CI status for current project
 */
async function checkCIStatus() {
  const filterIdx = projectsState.get().selectedProjectFilter;
  if (filterIdx === null || filterIdx === undefined) return;

  const projects = projectsState.get().projects;
  const project = projects[filterIdx];
  if (!project) return;

  try {
    // Get git info for remote URL
    const gitInfo = await api.git.info(project.path);
    if (!gitInfo.isGitRepo || !gitInfo.remoteUrl || !gitInfo.remoteUrl.includes('github.com')) {
      return;
    }

    // Fetch workflow runs
    const result = await api.github.workflowRuns(gitInfo.remoteUrl);
    if (!result.success || !result.authenticated || !result.runs || result.runs.length === 0) {
      // No runs or not authenticated - hide bar if showing
      if (ciStatusBar.currentRun) {
        hideCIStatusBar();
      }
      return;
    }

    // Find most recent run on current branch or any in-progress run
    const currentBranch = gitInfo.branch;
    const inProgressRun = result.runs.find(r => r.status === 'in_progress' || r.status === 'queued');
    const branchRun = result.runs.find(r => r.branch === currentBranch);
    const relevantRun = inProgressRun || branchRun;

    if (!relevantRun) {
      if (ciStatusBar.currentRun) {
        hideCIStatusBar();
      }
      return;
    }

    // Check if this is a new run or status changed
    if (!ciStatusBar.currentRun ||
        ciStatusBar.currentRun.id !== relevantRun.id ||
        ciStatusBar.currentRun.status !== relevantRun.status) {
      showCIStatusBar(relevantRun);
    }
  } catch (e) {
    console.error('[CI Status] Error checking status:', e);
  }
}

// Initialize CI status bar
if (ciStatusBar.element) {
  // Link button opens GitHub
  ciStatusBar.linkBtn?.addEventListener('click', () => {
    if (ciStatusBar.currentRun?.url) {
      api.dialog.openExternal(ciStatusBar.currentRun.url);
    }
  });

  // Close button hides bar
  ciStatusBar.closeBtn?.addEventListener('click', () => {
    hideCIStatusBar();
    // Don't show again for this run
    if (ciStatusBar.currentRun) {
      ciStatusBar.currentRun.dismissed = true;
    }
  });

  // Update duration every second when visible
  setInterval(() => {
    if (ciStatusBar.element.style.display !== 'none' &&
        ciStatusBar.currentRun?.status !== 'completed') {
      updateCIDuration();
    }
  }, 1000);

  // Poll CI status every 30 seconds
  setInterval(checkCIStatus, 30000);

  // Initial check after 3 seconds
  setTimeout(checkCIStatus, 3000);
}

// ========== TIME TRACKING DISPLAY ==========
const { formatDuration: formatTimeDisplay } = require('./src/renderer/utils/format');
const timeElements = {
  container: document.getElementById('titlebar-time'),
  today: document.getElementById('time-today'),
  week: document.getElementById('time-week'),
  month: document.getElementById('time-month')
};

const titlebarFormatOpts = { compact: true, alwaysShowMinutes: false };

/**
 * Update time tracking display in titlebar
 */
function updateTimeDisplay() {
  if (!timeElements.container) return;

  try {
    const { getGlobalTimes } = require('./src/renderer');
    const times = getGlobalTimes();

    timeElements.today.textContent = formatTimeDisplay(times.today, titlebarFormatOpts);
    timeElements.week.textContent = formatTimeDisplay(times.week, titlebarFormatOpts);
    timeElements.month.textContent = formatTimeDisplay(times.month, titlebarFormatOpts);
  } catch (e) {
    console.error('[TimeTracking] Error updating display:', e);
  }
}

// Initialize time tracking display
if (timeElements.container) {
  // Update every 10 seconds for more responsive display
  setInterval(updateTimeDisplay, 10000);

  // Initial update after state is initialized
  setTimeout(updateTimeDisplay, 1000);
}

// ========== TIME TRACKING SAVE ON QUIT ==========
// Listen for app quit to save active time tracking sessions
api.lifecycle.onWillQuit(() => {
  const { saveAllActiveSessions } = require('./src/renderer');
  saveAllActiveSessions();
});

// Backup cleanup on window unload (in case onWillQuit doesn't fire)
window.addEventListener('beforeunload', () => {
  const { saveAllActiveSessions } = require('./src/renderer');
  saveAllActiveSessions();
});

