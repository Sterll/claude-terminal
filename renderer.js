/**
 * Claude Terminal - Renderer Process
 * Main entry point - orchestrates all modules
 */

// With contextIsolation: true, we use the preload API
// The API is exposed via contextBridge in preload.js
const api = window.electron_api;
const { path, fs, process: nodeProcess, __dirname } = window.electron_nodeModules;

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
  loadProjects,
  saveProjects,
  loadSettings,
  saveSettings,
  createFolder,
  deleteFolder,
  renameFolder,
  renameProject,
  setSelectedProjectFilter,
  generateProjectId,
  initializeState,

  // Services
  services: { DashboardService, FivemService, TimeTrackingDashboard },

  // UI Components
  ProjectList,
  TerminalManager,
  FileExplorer,
  showContextMenu,
  hideContextMenu,

  // Features
  initKeyboardShortcuts,
  registerShortcut,
  unregisterShortcut,
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
  onLanguageChange
} = require('./src/renderer');

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
  notificationsEnabled: true,
  fivemServers: new Map(),
  gitOperations: new Map(),
  gitRepoStatus: new Map(),
  selectedDashboardProject: null
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
  nextTerminal: { key: 'Ctrl+Tab', labelKey: 'shortcuts.nextTerminal' },
  prevTerminal: { key: 'Ctrl+Shift+Tab', labelKey: 'shortcuts.prevTerminal' }
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
  registerShortcut(getShortcutKey('openSettings'), () => showSettingsModal(), { global: true });

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

  // Terminal navigation - Ctrl+Tab and Ctrl+Shift+Tab
  registerShortcut(getShortcutKey('nextTerminal'), () => {
    TerminalManager.focusNextTerminal();
  }, { global: true });

  registerShortcut(getShortcutKey('prevTerminal'), () => {
    TerminalManager.focusPrevTerminal();
  }, { global: true });
}

// ========== INITIALIZATION ==========
ensureDirectories();
initializeState(); // This loads settings, projects AND initializes time tracking
initI18n(settingsState.get().language); // Initialize i18n with saved language preference
updateStaticTranslations(); // Apply translations to static HTML elements
applyAccentColor(settingsState.get().accentColor || '#d97706');

// ========== NOTIFICATIONS ==========
function showNotification(title, body, terminalId) {
  if (!localState.notificationsEnabled) return;
  if (document.hasFocus() && terminalsState.get().activeTerminal === terminalId) return;
  api.notification.show({ title, body, terminalId });
}

api.notification.onClicked(({ terminalId }) => {
  if (terminalId) {
    // Switch to the terminal's project first so it becomes visible
    const termData = terminalsState.get().terminals.get(terminalId);
    if (termData && termData.projectIndex != null) {
      setSelectedProjectFilter(termData.projectIndex);
      ProjectList.render();
      TerminalManager.filterByProject(termData.projectIndex);
    }
    TerminalManager.setActiveTerminal(terminalId);
    document.querySelector('[data-tab="claude"]')?.click();
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
        localState.gitRepoStatus.set(project.id, { isGitRepo: result.isGitRepo });
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
  if (details && details.length > 0) {
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
        message: `${result.conflicts?.length || 0} fichier(s) en conflit`,
        details: 'Résolvez les conflits ou annulez le merge depuis le dashboard',
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

// ========== DELETE PROJECT ==========
function deleteProjectUI(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const projectIndex = getProjectIndex(projectId);
  if (!confirm(`Supprimer "${project.name}" ?`)) return;

  if (project.type === 'fivem' && localState.fivemServers.get(projectIndex)?.status !== 'stopped') {
    stopFivemServer(projectIndex);
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

    const sessionsHtml = sessions.map(session => `
      <div class="session-card-modal" data-session-id="${session.sessionId}">
        <div class="session-header">
          <span class="session-icon">💬</span>
          <span class="session-title">${escapeHtml(truncateText(session.summary, 50))}</span>
        </div>
        <div class="session-prompt">${escapeHtml(truncateText(session.firstPrompt, 100))}</div>
        <div class="session-meta">
          <span class="session-messages">${session.messageCount} msgs</span>
          <span class="session-time">${formatRelativeTime(session.modified)}</span>
          ${session.gitBranch ? `<span class="session-branch">${escapeHtml(session.gitBranch)}</span>` : ''}
        </div>
      </div>
    `).join('');

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

    // Get projects that have at least one terminal open (use path for stable comparison)
    const projectsWithTerminals = projects
      .map((p, idx) => ({ project: p, index: idx }))
      .filter(({ project }) => {
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
      ? projectsWithTerminals.findIndex(p => p.project.path === currentProject.path)
      : -1;

    let targetIdx;
    if (currentIdx === -1) {
      // No valid current project, start from first
      targetIdx = 0;
    } else if (direction === 'up') {
      targetIdx = (currentIdx - 1 + projectsWithTerminals.length) % projectsWithTerminals.length;
    } else {
      targetIdx = (currentIdx + 1) % projectsWithTerminals.length;
    }

    const targetProject = projectsWithTerminals[targetIdx];
    setSelectedProjectFilter(targetProject.index);
    ProjectList.render();
    TerminalManager.filterByProject(targetProject.index);
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

document.getElementById('btn-settings').onclick = () => showSettingsModal();

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
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.onclick = () => {
    const tabId = tab.dataset.tab;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    if (tabId === 'skills') loadSkills();
    if (tabId === 'agents') loadAgents();
    if (tabId === 'mcp') loadMcps();
    if (tabId === 'dashboard') populateDashboardProjects();
    if (tabId === 'memory') loadMemory();
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

// ========== SETTINGS MODAL ==========
async function showSettingsModal(initialTab = 'general') {
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

  showModal(t('settings.title'), `
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
      <button class="settings-tab ${initialTab === 'shortcuts' ? 'active' : ''}" data-tab="shortcuts">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/></svg>
        Raccourcis
      </button>
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
            <select id="terminal-theme-select" class="settings-select">
              <option value="claude" ${settings.terminalTheme === 'claude' || !settings.terminalTheme ? 'selected' : ''}>Claude</option>
              <option value="dracula" ${settings.terminalTheme === 'dracula' ? 'selected' : ''}>Dracula</option>
              <option value="monokai" ${settings.terminalTheme === 'monokai' ? 'selected' : ''}>Monokai</option>
              <option value="nord" ${settings.terminalTheme === 'nord' ? 'selected' : ''}>Nord</option>
              <option value="oneDark" ${settings.terminalTheme === 'oneDark' ? 'selected' : ''}>One Dark</option>
              <option value="gruvbox" ${settings.terminalTheme === 'gruvbox' ? 'selected' : ''}>Gruvbox</option>
              <option value="tokyoNight" ${settings.terminalTheme === 'tokyoNight' ? 'selected' : ''}>Tokyo Night</option>
              <option value="catppuccin" ${settings.terminalTheme === 'catppuccin' ? 'selected' : ''}>Catppuccin</option>
              <option value="synthwave" ${settings.terminalTheme === 'synthwave' ? 'selected' : ''}>Synthwave</option>
              <option value="matrix" ${settings.terminalTheme === 'matrix' ? 'selected' : ''}>Matrix</option>
            </select>
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
      <!-- Shortcuts Tab -->
      <div class="settings-panel ${initialTab === 'shortcuts' ? 'active' : ''}" data-panel="shortcuts">
        ${renderShortcutsPanel()}
      </div>
    </div>
  `, `
    <button type="button" class="btn-cancel" onclick="closeModal()">Fermer</button>
    <button type="button" class="btn-primary" id="btn-save-settings">Sauvegarder</button>
  `);

  // Tab switching
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`.settings-panel[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
    };
  });

  // Setup shortcuts panel handlers
  setupShortcutsPanelHandlers();

  // Execution mode cards
  document.querySelectorAll('.execution-mode-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('.execution-mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('dangerous-warning').style.display = card.dataset.mode === 'dangerous' ? 'flex' : 'none';
    };
  });

  // Color swatches
  document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.onclick = () => {
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      document.querySelector('.color-swatch-custom')?.classList.remove('selected');
      swatch.classList.add('selected');
    };
  });

  // Custom color picker
  const customColorInput = document.getElementById('custom-color-input');
  const customSwatch = document.querySelector('.color-swatch-custom');
  if (customColorInput && customSwatch) {
    customColorInput.oninput = (e) => {
      const color = e.target.value;
      customSwatch.style.background = color;
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      customSwatch.classList.add('selected');
    };
    customSwatch.onclick = (e) => {
      if (e.target === customColorInput) return;
      customColorInput.click();
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
            showSettingsModal('github');
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
        showSettingsModal('github');
      };
    }
  }
  setupGitHubAuth();

  // Save settings
  document.getElementById('btn-save-settings').onclick = async () => {
    const selectedMode = document.querySelector('.execution-mode-card.selected');
    const closeActionSelect = document.getElementById('close-action-select');
    const terminalThemeSelect = document.getElementById('terminal-theme-select');
    const languageSelect = document.getElementById('language-select');
    const newTerminalTheme = terminalThemeSelect?.value || 'claude';
    const newLanguage = languageSelect?.value || getCurrentLanguage();

    // Get accent color from preset swatch or custom picker
    let accentColor = settings.accentColor;
    const selectedSwatch = document.querySelector('.color-swatch.selected');
    const customSwatchSelected = document.querySelector('.color-swatch-custom.selected');
    if (selectedSwatch) {
      accentColor = selectedSwatch.dataset.color;
    } else if (customSwatchSelected) {
      accentColor = document.getElementById('custom-color-input')?.value || settings.accentColor;
    }

    const newSettings = {
      editor: settings.editor || 'code',
      skipPermissions: selectedMode?.dataset.mode === 'dangerous',
      accentColor,
      closeAction: closeActionSelect?.value || 'ask',
      terminalTheme: newTerminalTheme,
      language: newLanguage
    };
    settingsState.set(newSettings);
    saveSettings();

    // Update language if changed
    if (newLanguage !== getCurrentLanguage()) {
      setLanguage(newLanguage);
      // Reload to apply translations
      location.reload();
    }
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

    closeModal();
  };
}

window.closeModal = closeModal;
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };

// ========== SKILLS & AGENTS ==========
async function loadSkills() {
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
    html += localSkills.map(s => `
      <div class="list-card" data-path="${s.path.replace(/"/g, '&quot;')}" data-is-plugin="false">
        <div class="list-card-header">
          <div class="list-card-title">${escapeHtml(s.name)}</div>
          <div class="list-card-badge">Skill</div>
        </div>
        <div class="list-card-desc">${escapeHtml(s.description)}</div>
        <div class="list-card-footer">
          <button class="btn-sm btn-secondary btn-open">Ouvrir</button>
          <button class="btn-sm btn-delete btn-del">Suppr</button>
        </div>
      </div>`).join('');
    html += `</div></div>`;
  }

  // Plugin skills sections
  Object.entries(pluginsBySource).forEach(([source, skills]) => {
    html += `<div class="list-section">
      <div class="list-section-title"><span class="plugin-badge">Plugin</span> ${escapeHtml(source)} <span class="list-section-count">${skills.length}</span></div>
      <div class="list-section-grid">`;
    html += skills.map(s => `
      <div class="list-card plugin-card" data-path="${s.path.replace(/"/g, '&quot;')}" data-is-plugin="true">
        <div class="list-card-header">
          <div class="list-card-title">${escapeHtml(s.name)}</div>
          <div class="list-card-badge plugin">Plugin</div>
        </div>
        <div class="list-card-desc">${escapeHtml(s.description)}</div>
        <div class="list-card-footer">
          <button class="btn-sm btn-secondary btn-open">Ouvrir</button>
        </div>
      </div>`).join('');
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
  html += localState.agents.map(a => `
    <div class="list-card agent-card" data-path="${a.path.replace(/"/g, '&quot;')}">
      <div class="list-card-header">
        <div class="list-card-title">${escapeHtml(a.name)}</div>
        <div class="list-card-badge agent">Agent</div>
      </div>
      <div class="list-card-desc">${escapeHtml(a.description)}</div>
      <div class="list-card-footer">
        <button class="btn-sm btn-secondary btn-open">Ouvrir</button>
        <button class="btn-sm btn-delete btn-del">Suppr</button>
      </div>
    </div>`).join('');
  html += `</div></div>`;

  list.innerHTML = html;

  list.querySelectorAll('.list-card').forEach(card => {
    card.querySelector('.btn-open').onclick = () => api.dialog.openInExplorer(card.dataset.path);
    card.querySelector('.btn-del').onclick = async () => { if (confirm('Supprimer cet agent ?')) { await fs.promises.rm(card.dataset.path, { recursive: true, force: true }); loadAgents(); } };
  });
}

// ========== MCP ==========
function loadMcps() {
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
  const process = localState.mcpProcesses[mcp.id] || { status: 'stopped' };
  const statusLabel = process.status === 'running' ? 'Actif' : process.status === 'starting' ? 'Demarrage...' : 'Inactif';
  return `<div class="mcp-card" data-id="${mcp.id}">
    <div class="mcp-card-header">
      <div class="mcp-card-info">
        <span class="mcp-status-badge ${process.status}">${statusLabel}</span>
        <div class="mcp-card-title">${escapeHtml(mcp.name)}</div>
      </div>
    </div>
    <div class="mcp-card-details"><code>${escapeHtml(mcp.command)}${mcp.args?.length ? ' ' + mcp.args.join(' ') : ''}</code></div>
  </div>`;
}

// ========== DASHBOARD ==========
function populateDashboardProjects() {
  const list = document.getElementById('dashboard-projects-list');
  if (!list) return;
  const projects = projectsState.get().projects;

  if (projects.length === 0) {
    list.innerHTML = `<div class="dashboard-projects-empty">Aucun projet</div>`;
    return;
  }

  list.innerHTML = projects.map((p, i) => `
    <div class="dashboard-project-item ${localState.selectedDashboardProject === i ? 'active' : ''}" data-index="${i}">
      <div class="dashboard-project-icon">
        ${p.type === 'fivem'
          ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16V4H3v12h18m0-14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7v2h2v2H8v-2h2v-2H3a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2h18"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>'}
      </div>
      <div class="dashboard-project-info">
        <div class="dashboard-project-name">${escapeHtml(p.name)}</div>
        <div class="dashboard-project-path">${escapeHtml(p.path)}</div>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.dashboard-project-item').forEach(item => {
    item.onclick = () => {
      const index = parseInt(item.dataset.index);
      localState.selectedDashboardProject = index;
      populateDashboardProjects();
      renderDashboardContent(index);
    };
  });
}

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
  // Simple markdown parser
  let html = escapeHtml(md);

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code-block"><code class="lang-$1">$2</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Numbered lists
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // Paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<h[1-4]>)/g, '$1');
  html = html.replace(/(<\/h[1-4]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<pre)/g, '$1');
  html = html.replace(/(<\/pre>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');

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
  showModal('Nouveau Projet', `
    <form id="form-project">
      <div class="form-group">
        <label>Source du projet</label>
        <div class="source-selector">
          <div class="source-option selected" data-source="folder">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
            <span>Dossier existant</span>
          </div>
          <div class="source-option" data-source="create">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3H9v-2h3V9h2v3h3v2z"/></svg>
            <span>Creer un nouveau</span>
          </div>
          <div class="source-option" data-source="clone">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>
            <span>Cloner un repo</span>
          </div>
        </div>
      </div>
      <div class="form-group clone-config" style="display: none;">
        <label>URL du repository</label>
        <input type="text" id="inp-repo-url" placeholder="https://github.com/user/repo.git">
        <div class="github-status-hint" id="github-status-hint"></div>
      </div>
      <div class="form-group">
        <label>Nom du projet</label>
        <input type="text" id="inp-name" placeholder="Mon Projet" required>
      </div>
      <div class="form-group">
        <label id="label-path">Chemin du projet</label>
        <div class="input-with-btn">
          <input type="text" id="inp-path" placeholder="C:\\chemin\\projet" required>
          <button type="button" class="btn-browse" id="btn-browse">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
          </button>
        </div>
      </div>
      <div class="form-group">
        <label>Type de projet</label>
        <div class="type-selector">
          <div class="type-card selected" data-type="standalone">
            <div class="type-card-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10z"/></svg></div>
            <div class="type-card-content"><div class="type-card-title">Standalone</div><div class="type-card-desc">Terminal Claude classique</div></div>
          </div>
          <div class="type-card" data-type="fivem">
            <div class="type-card-icon fivem"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16V4H3v12h18m0-14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7v2h2v2H8v-2h2v-2H3a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2h18"/></svg></div>
            <div class="type-card-content"><div class="type-card-title">FiveM Server</div><div class="type-card-desc">Demarrer/arreter FXServer</div></div>
          </div>
        </div>
      </div>
      <div class="form-group create-git-config" style="display: none;">
        <label class="checkbox-label">
          <input type="checkbox" id="chk-init-git" checked>
          <span>Initialiser un repo Git</span>
        </label>
      </div>
      <div class="form-group fivem-config" style="display: none;">
        <label>Script de lancement</label>
        <div class="input-with-button">
          <input type="text" id="inp-fivem-cmd" placeholder="C:\\Serveur\\run.bat">
          <button type="button" id="btn-browse-fivem" class="btn-browse">Parcourir</button>
        </div>
      </div>
      <div class="form-group clone-status" style="display: none;">
        <div class="clone-progress">
          <span class="clone-progress-text">Clonage en cours...</span>
          <div class="clone-progress-bar"><div class="clone-progress-fill"></div></div>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-cancel" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn-primary" id="btn-create-project">Creer</button>
      </div>
    </form>
  `);

  let selectedType = 'standalone';
  let selectedSource = 'folder';
  let githubConnected = false;

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
          showSettingsModal('github');
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
        document.getElementById('label-path').textContent = 'Dossier de destination';
        document.getElementById('inp-path').placeholder = 'C:\\chemin\\destination';
        updateGitHubHint();
      } else if (isCreate) {
        document.getElementById('label-path').textContent = 'Dossier parent';
        document.getElementById('inp-path').placeholder = 'C:\\chemin\\parent';
      } else {
        document.getElementById('label-path').textContent = 'Chemin du projet';
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

  document.querySelectorAll('.type-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('.type-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedType = card.dataset.type;
      document.querySelector('.fivem-config').style.display = selectedType === 'fivem' ? 'block' : 'none';
    };
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

  document.getElementById('btn-browse-fivem').onclick = async () => {
    const file = await api.dialog.selectFile({ filters: [{ name: 'Scripts', extensions: ['bat', 'cmd', 'sh', 'exe'] }] });
    if (file) document.getElementById('inp-fivem-cmd').value = file;
  };

  document.getElementById('form-project').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('inp-name').value.trim();
    let projPath = document.getElementById('inp-path').value.trim();
    const repoUrl = document.getElementById('inp-repo-url')?.value.trim();

    if (!name || !projPath) return;

    // If creating new, create the directory
    if (selectedSource === 'create') {
      projPath = path.join(projPath, name);
      try {
        const fs = require('fs');
        if (fs.existsSync(projPath)) {
          showToast('Ce dossier existe deja', 'error');
          return;
        }
        fs.mkdirSync(projPath, { recursive: true });

        // Init git repo if checked
        if (document.getElementById('chk-init-git')?.checked) {
          const { execSync } = require('child_process');
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
          submitBtn.textContent = 'Creer';
          return;
        }
      } catch (err) {
        cloneStatus.innerHTML = `<div class="clone-error">${err.message}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Creer';
        return;
      }
    }

    const project = { id: generateProjectId(), name, path: projPath, type: selectedType, folderId: null };
    if (selectedType === 'fivem') project.fivemConfig = { runCommand: document.getElementById('inp-fivem-cmd').value.trim() };

    const projects = [...projectsState.get().projects, project];
    const rootOrder = [...projectsState.get().rootOrder, project.id];
    projectsState.set({ projects, rootOrder });
    saveProjects();
    ProjectList.render();
    closeModal();
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
  filterBtnPull.classList.add('loading');
  await gitPull(currentFilterProjectId);
  branchCache = { projectId: null, data: null };
  filterBtnPull.classList.remove('loading');
};

// Push button
filterBtnPush.onclick = async () => {
  if (!currentFilterProjectId) return;
  filterBtnPush.classList.add('loading');
  await gitPush(currentFilterProjectId);
  branchCache = { projectId: null, data: null };
  filterBtnPush.classList.remove('loading');
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
const btnStageSelected = document.getElementById('btn-stage-selected');
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

  // Calculate stats
  const stats = { added: 0, modified: 0, deleted: 0, untracked: 0 };
  files.forEach(f => {
    if (f.status === 'A' || f.status === '?') stats.untracked++;
    else if (f.status === 'M') stats.modified++;
    else if (f.status === 'D') stats.deleted++;
    else if (f.status === 'A') stats.added++;
  });

  gitChangesStats.innerHTML = `
    ${stats.modified ? `<span class="git-stat modified">M ${stats.modified}</span>` : ''}
    ${stats.added ? `<span class="git-stat added">A ${stats.added}</span>` : ''}
    ${stats.deleted ? `<span class="git-stat deleted">D ${stats.deleted}</span>` : ''}
    ${stats.untracked ? `<span class="git-stat untracked">? ${stats.untracked}</span>` : ''}
  `;

  gitChangesList.innerHTML = files.map((file, index) => {
    const fileName = file.path.split('/').pop();
    const filePath = file.path.split('/').slice(0, -1).join('/');
    const isSelected = gitChangesState.selectedFiles.has(index);

    return `
      <div class="git-file-item ${isSelected ? 'selected' : ''}" data-index="${index}">
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
      </div>
    `;
  }).join('');

  // Attach click handlers
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

  updateCommitButton();
  updateSelectAllState();
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

  gitChangesList.querySelectorAll('.git-file-item').forEach(item => {
    const checkbox = item.querySelector('input[type="checkbox"]');
    checkbox.checked = shouldSelect;
    item.classList.toggle('selected', shouldSelect);
  });

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
      files: selectedFiles
    });

    if (result.success && result.message) {
      gitCommitMessage.value = result.message;

      const sourceLabel = result.source === 'claude' ? 'Claude' : 'Heuristique';
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

// Stage selected files
btnStageSelected.onclick = async () => {
  if (gitChangesState.selectedFiles.size === 0) return;

  const selectedPaths = Array.from(gitChangesState.selectedFiles)
    .map(i => gitChangesState.files[i]?.path)
    .filter(Boolean);

  try {
    const result = await api.git.stageFiles({
      projectPath: gitChangesState.projectPath,
      files: selectedPaths
    });

    if (result.success) {
      showGitToast({
        success: true,
        title: 'Fichiers stages',
        message: `${selectedPaths.length} fichier(s) ajoute(s)`,
        duration: 3000
      });
      loadGitChanges();
    } else {
      showGitToast({
        success: false,
        title: 'Erreur',
        message: result.error,
        duration: 5000
      });
    }
  } catch (e) {
    showGitToast({
      success: false,
      title: 'Erreur',
      message: e.message,
      duration: 5000
    });
  }
};

// Commit selected files
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
    btnCommitSelected.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Commit (<span id="commit-count">${gitChangesState.selectedFiles.size}</span>)`;
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
        console.log(`Installed bundled skill: ${skillName}`);
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

  const projects = projectsState.get().projects;
  const project = projects[parseInt(projectIndex)];

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

// ========== INIT ==========
setupContextMenuHandlers();
checkAllProjectsGitStatus();
ProjectList.render();

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
  api.usage.startMonitor(60000).then(() => {
    console.log('Usage monitor started');
  }).catch(console.error);

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

console.log('Claude Terminal initialized');
