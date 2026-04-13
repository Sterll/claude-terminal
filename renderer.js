/**
 * Claude Terminal - Renderer Process
 * Main entry point - orchestrates all modules
 */

// With contextIsolation: true, we use the preload API
// The API is exposed via contextBridge in preload.js
const api = window.electron_api;
const { path, fs, process: nodeProcess, __dirname } = window.electron_nodeModules;
const { fileExists, fsp, ensureDirs } = require('./src/renderer/utils/fs-async');

document.body.classList.add(`platform-${nodeProcess.platform}`);

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
  getSetting,
  setSetting,
  isNotificationsEnabled,
  toggleNotifications,
  createFolder,
  deleteFolder,
  renameFolder,
  renameProject,
  setSelectedProjectFilter,
  generateProjectId,
  initializeState,

  // Core
  core,

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
  getGlobalTimes,

  // Themes
  TERMINAL_THEMES,

  // Quick Actions
  QuickActions
} = require('./src/renderer');

const registry = require('./src/project-types/registry');
const { mergeTranslations } = require('./src/renderer/i18n');
const ModalComponent = require('./src/renderer/ui/components/Modal');
const { MemoryEditor, GitChangesPanel, ShortcutsManager, SettingsPanel, SkillsAgentsPanel, PluginsPanel, MarketplacePanel, McpPanel, WorkflowPanel, DatabasePanel, CloudPanel, ConnectivityPanel, ControlTowerPanel, SessionReplayPanel, ParallelTaskPanel, WorkspacePanel } = require('./src/renderer/ui/panels');

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
  document.getElementById('modal')?.classList.remove('modal--sessions');
}

// ========== LOCAL STATE ==========
const localState = {
  fivemServers: new Map(),
  gitOperations: new Map(),
  gitRepoStatus: new Map(),
  gitStatusInitialized: false,
  selectedDashboardProject: -1
};

// ========== I18N STATIC TEXT UPDATES ==========
// Update all elements with data-i18n attribute
function updateStaticTranslations() {
  // Single DOM scan with union selector instead of 4 separate scans
  const elements = document.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]');
  elements.forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
    const titleKey = el.getAttribute('data-i18n-title');
    if (titleKey) el.title = t(titleKey);
    const phKey = el.getAttribute('data-i18n-placeholder');
    if (phKey) el.placeholder = t(phKey);
    const ariaKey = el.getAttribute('data-i18n-aria-label');
    if (ariaKey) el.setAttribute('aria-label', t(ariaKey));
  });
}

// Listen for language changes
onLanguageChange(() => {
  updateStaticTranslations();
});

// ========== KEYBOARD SHORTCUTS (extracted to ShortcutsManager module) ==========
// ========== INITIALIZATION ==========
const { initClaudeEvents, switchProvider, getDashboardStats, setNotificationFn } = require('./src/renderer/events');
const { loadSessionData, clearProjectSessions, saveTerminalSessions } = require('./src/renderer/services/TerminalSessionService');

(async () => {
  await ensureDirectories();

  // Initialize core OOP infrastructure (ApiProvider + ServiceContainer)
  core.initCore(window.electron_api, window.electron_nodeModules);

  await initializeState(); // Loads settings, projects AND initializes time tracking

  // Restore saved panel widths (must be after settings are loaded)
  const savedPanelWidth = settingsState.get().projectsPanelWidth;
  if (savedPanelWidth) {
    const panel = document.querySelector('.projects-panel');
    if (panel) panel.style.width = savedPanelWidth + 'px';
    if (savedPanelWidth < 210) {
      const btnToggle = document.getElementById('btn-toggle-projects');
      if (btnToggle) btnToggle.style.display = 'none';
    }
  }
  const savedMemoryWidth = settingsState.get().memorySidebarWidth;
  if (savedMemoryWidth) {
    const memorySidebar = document.querySelector('.memory-sidebar');
    if (memorySidebar) memorySidebar.style.width = savedMemoryWidth + 'px';
  }

  // Apply body classes for settings that affect global CSS
  if (getSetting('showTabModeToggle') === false) {
    document.body.classList.add('hide-tab-mode-toggle');
  }

  initI18n(settingsState.get().language); // Initialize i18n with saved language preference
  _applyTabsOrder(); // Restore custom tab order before applying visibility
  applyPinnedTabs(); // Apply sidebar tab visibility from settings
  _initSidebarDragDrop(); // Enable drag & drop reordering in sidebar

  // Apply tooltips for collapsed sidebar
  if (localStorage.getItem('sidebar-collapsed') === 'true') {
    _applySidebarTooltips(true);
  }

  // Restore last active tab from settings
  const savedActiveTab = settingsState.get().activeTab;
  if (savedActiveTab && savedActiveTab !== 'claude') {
    if (savedActiveTab === 'settings') {
      document.getElementById('btn-settings')?.click();
    } else {
      const savedTab = document.querySelector(`.nav-tab[data-tab="${savedActiveTab}"]`);
      if (savedTab && !savedTab.classList.contains('nav-tab--hidden')) {
        savedTab.click();
      }
    }
  }

  // Initialize Claude event bus and provider (hooks or scraping)
  initClaudeEvents();

  // Restore terminal sessions from previous run
  try {
    const { setSkipExplorerCapture } = require('./src/renderer/services/TerminalSessionService');
    setSkipExplorerCapture(true);
    const sessionData = await loadSessionData();
    if (sessionData && sessionData.projects) {
      const projects = projectsState.get().projects;

      for (const projectId of Object.keys(sessionData.projects)) {
        const saved = sessionData.projects[projectId];
        const project = projects.find(p => p.id === projectId);
        if (!project) continue;
        if (!(await fileExists(project.path))) continue;
        if (!saved.tabs || saved.tabs.length === 0) continue;

        for (const tab of saved.tabs) {
          const cwd = (await fileExists(tab.cwd)) ? tab.cwd : project.path;
          await TerminalManager.createTerminal(project, {
            runClaude: !tab.isBasic,
            cwd,
            mode: tab.mode || null,
            skipPermissions: settingsState.get().skipPermissions,
            resumeSessionId: (!tab.isBasic && tab.claudeSessionId) ? tab.claudeSessionId : null,
            name: tab.name || null,
          });
        }

        if (saved.activeCwd) {
          const terminals = terminalsState.get().terminals;
          let activeId = null;
          terminals.forEach((td, id) => {
            if (td.project?.id === projectId && td.cwd === saved.activeCwd) {
              activeId = id;
            }
          });
          if (activeId !== null) {
            TerminalManager.setActiveTerminal(activeId);
          }
        }
      }

      if (sessionData.lastOpenedProjectId) {
        const idx = projects.findIndex(p => p.id === sessionData.lastOpenedProjectId);
        if (idx !== -1) {
          setSelectedProjectFilter(idx);
          TerminalManager.filterByProject(idx);
        }
      }

      // Schedule silence-based scroll per restored terminal (waits for PTY replay to finish)
      terminalsState.get().terminals.forEach((td, id) => {
        if (td.terminal && typeof td.terminal.scrollToBottom === 'function') {
          TerminalManager.scheduleScrollAfterRestore(id);
        }
      });
    }
  } catch (err) {
    console.error('[SessionRestore] Error restoring terminal sessions:', err);
  }
  // Re-enable explorer state capture after restore loop completes
  try {
    const { setSkipExplorerCapture: clearSkip } = require('./src/renderer/services/TerminalSessionService');
    clearSkip(false);
  } catch (e) { /* ignore */ }

  // Initialize project types registry
  registry.discoverAll();
  registry.loadAllTranslations(mergeTranslations);
  registry.injectAllStyles();

  // Preload dashboard data in background at startup
  DashboardService.loadAllDiskCaches().then(() => {
    setTimeout(() => DashboardService.preloadAllProjects(), 1000);
  }).catch(e => {
    console.error('Error loading disk caches:', e);
    setTimeout(() => DashboardService.preloadAllProjects(), 1000);
  });
  updateStaticTranslations(); // Apply translations to static HTML elements
  applyAccentColor(settingsState.get().accentColor || '#d97706');
  if (settingsState.get().compactProjects !== false) {
    document.body.classList.add('compact-projects');
  }
  if (settingsState.get().reduceMotion) {
    document.body.classList.add('reduce-motion');
  }
  // Restore notification bell state from persisted settings
  document.getElementById('btn-notifications').classList.toggle('active', isNotificationsEnabled());

  // ========== PANELS INIT (must run after state is loaded) ==========
  MemoryEditor.init({ showModal, closeModal, showToast });

  ShortcutsManager.init({
    settingsState, saveSettings,
    switchToSettingsTab: (...args) => SettingsPanel.switchToSettingsTab(...args),
    terminalsState, TerminalManager,
    projectsState, setSelectedProjectFilter, ProjectList,
    showSessionsModal,
    createTerminalForProject, FileExplorer
  });

  SettingsPanel.init({
    api, settingsState, saveSettings, saveSettingsImmediate,
    showToast, showModal, closeModal,
    applyAccentColor, TerminalManager, TERMINAL_THEMES,
    QuickActions, TimeTrackingDashboard, ShortcutsManager
  });

  SkillsAgentsPanel.init({
    api, fs, path, skillsDir, agentsDir, getSetting,
    loadMarketplaceContent: () => MarketplacePanel.loadMarketplaceContent(),
    searchMarketplace: (q) => MarketplacePanel.searchMarketplace(q),
    loadMarketplaceFeatured: () => MarketplacePanel.loadMarketplaceFeatured(),
    setMarketplaceSearchQuery: (q) => MarketplacePanel.setSearchQuery(q)
  });

  PluginsPanel.init({
    api, showModal, closeModal, showToast
  });

  MarketplacePanel.init({
    api, showModal, closeModal, skillsDir, path, fs
  });

  McpPanel.init({
    api, showModal, closeModal, showToast,
    claudeConfigFile, claudeSettingsFile,
    projectsState, path, fs
  });

  WorkflowPanel.init({ api, showToast, path, fs });

  ParallelTaskPanel.init({
    api,
    showToast,
    showModal,
    closeModal,
    projectsState,
    openTerminalAtPath: (worktreePath) => {
      // Switch to Claude tab and open a terminal at the worktree path
      document.querySelector('[data-tab="claude"]')?.click();
      const openedId = projectsState.get().openedProjectId;
      const project = projectsState.get().projects.find(p => p.id === openedId)
        || projectsState.get().projects[0];
      if (project) {
        TerminalManager.createTerminal(project, { cwd: worktreePath, runClaude: false });
      }
    }
  });

  DatabasePanel.init({
    api, showModal, closeModal, showToast,
    projectsState, path, fs
  });

  // Share notification fn with event bus consumer so hooks use the same logic
  setNotificationFn(showNotification);

  // Render project list now that projects are loaded
  ProjectList.render();

  // Initial git status check for all projects
  checkAllProjectsGitStatus();

  // ── Cloud auto-connect on startup ──
  _tryCloudAutoConnect();

  // Initialize keyboard shortcuts (needs settingsState loaded)
  ShortcutsManager.registerAllShortcuts();

  // Track last opened project for session restore
  projectsState.subscribe((state) => {
    if (state.selectedProjectFilter !== null && state.selectedProjectFilter !== undefined) {
      const project = state.projects[state.selectedProjectFilter];
      if (project) {
        saveTerminalSessions();
      }
    }
  });
})();

// ========== CLOUD AUTO-CONNECT ==========
async function _tryCloudAutoConnect() {
  try {
    const settings = settingsState.get();
    if (settings.cloudAutoConnect === false) return;
    if (!settings.cloudServerUrl || !settings.cloudApiKey) return;

    // Check if already connected
    const status = await api.cloud.status();
    if (status.connected) return;

    await api.cloud.connect({
      serverUrl: settings.cloudServerUrl,
      apiKey: settings.cloudApiKey,
    });
  } catch (e) {
    console.warn('[CloudAutoConnect] Failed:', e.message);
  }
}

// ========== NOTIFICATIONS ==========
function showNotification(type, title, body, terminalId, extraOptions) {
  if (!isNotificationsEnabled()) return;
  if (document.hasFocus() && terminalsState.get().activeTerminal === terminalId) return;
  const { buttons, autoDismiss, meta } = extraOptions || {};
  const defaultButtons = [{ label: t('terminals.notifBtnShow'), action: 'show', style: 'primary' }];
  api.notification.show({
    type: type || 'done',
    title,
    body,
    terminalId,
    autoDismiss: autoDismiss !== undefined ? autoDismiss : 8000,
    buttons: buttons || defaultButtons,
    meta: Object.assign({ notifType: type || 'done' }, meta || {})
  });
}

api.notification.onClicked(({ terminalId, answerText }) => {
  if (terminalId) {
    if (answerText) {
      // Answer silently — no UI switch, window stays in background
      const questionCard = document.querySelector('.chat-question-card:not(.resolved)');
      if (questionCard) {
        const options = questionCard.querySelectorAll('.chat-question-option');
        for (const opt of options) {
          if (opt.dataset.label === answerText) {
            opt.click();
            break;
          }
        }
        const submitBtn = questionCard.querySelector('.chat-question-submit');
        if (submitBtn) submitBtn.click();
      } else {
        // Fallback: PTY terminal session — type the answer as keyboard input
        api.terminal.input(terminalId, answerText + '\r');
      }
      return;
    }

    // No answer (action: show) — bring window to front and switch to terminal
    document.querySelector('[data-tab="claude"]')?.click();
    const termData = terminalsState.get().terminals.get(terminalId);
    if (termData && termData.projectIndex != null) {
      setSelectedProjectFilter(termData.projectIndex);
      ProjectList.render();
      TerminalManager.filterByProject(termData.projectIndex);
    }
    TerminalManager.setActiveTerminal(terminalId);
  }
});


// ========== GIT STATUS ==========
async function checkAllProjectsGitStatus() {
  const projects = projectsState.get().projects;
  // Check all projects in parallel (batches of 5 to avoid overwhelming IPC)
  const BATCH_SIZE = 5;
  let selectedProjectHandled = false;
  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (project) => {
      // Skip projects whose path doesn't exist (e.g. synced from another machine)
      // Use async access() to avoid blocking the renderer thread on slow/network paths
      if (project.path) {
        try { await fsp.access(project.path); } catch {
          localState.gitRepoStatus.set(project.id, { isGitRepo: false });
          return;
        }
      }
      try {
        // Run statusQuick and currentBranch in parallel instead of sequentially
        const [result, branch] = await Promise.all([
          api.git.statusQuick({ projectPath: project.path }),
          api.git.currentBranch({ projectPath: project.path }).catch(() => null)
        ]);
        const status = { isGitRepo: result.isGitRepo };
        if (result.isGitRepo && branch) {
          status.branch = branch;
        }
        localState.gitRepoStatus.set(project.id, status);
      } catch (e) {
        localState.gitRepoStatus.set(project.id, { isGitRepo: false });
      }
    }));

    // Progressive render: if the currently selected project was in this batch,
    // update buttons immediately instead of waiting for all batches to complete
    if (!selectedProjectHandled) {
      const currentState = projectsState.get();
      const selIdx = currentState.selectedProjectFilter;
      if (selIdx !== null && currentState.projects[selIdx]) {
        const selId = currentState.projects[selIdx].id;
        if (localState.gitRepoStatus.has(selId)) {
          showFilterGitActions(selId);
          selectedProjectHandled = true;
        }
      }
    }
  }
  localState.gitStatusInitialized = true;
  ProjectList.render();

  // Final update: use fresh state to avoid stale projects reference
  const currentState = projectsState.get();
  const selectedFilter = currentState.selectedProjectFilter;
  if (selectedFilter !== null && currentState.projects[selectedFilter]) {
    showFilterGitActions(currentState.projects[selectedFilter].id);
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
    <button class="toast-close" aria-label="${t('common.close')}">
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

  if (!output) return { message: t('git.alreadyUpToDate'), details };

  // Already up to date
  if (output.includes('Already up to date') || output.includes('Déjà à jour')) {
    return { message: t('git.alreadyUpToDate'), details: [{ icon: '✓', text: t('git.noChanges') }] };
  }

  // Fast-forward merge
  const filesChanged = output.match(/(\d+) files? changed/);
  const insertions = output.match(/(\d+) insertions?\(\+\)/);
  const deletions = output.match(/(\d+) deletions?\(-\)/);
  const commits = output.match(/(\d+) commits?/);

  if (filesChanged) {
    details.push({ icon: '📄', text: t('git.filesChanged', { count: filesChanged[1] }) });
  }
  if (insertions) {
    details.push({ icon: '+', text: t('git.insertions', { count: insertions[1] }) });
  }
  if (deletions) {
    details.push({ icon: '-', text: t('git.deletions', { count: deletions[1] }) });
  }

  return { message: '', details };
}

function parseGitPushOutput(output) {
  const details = [];

  if (!output) return { message: t('git.changesPushed'), details };

  // Everything up-to-date
  if (output.includes('Everything up-to-date')) {
    return { message: t('git.alreadySynchronized'), details: [{ icon: '✓', text: t('git.noChangesToPush') }] };
  }

  // Extract branch info
  const branchMatch = output.match(/(\w+)\.\.(\w+)\s+(\S+)\s+->\s+(\S+)/);
  if (branchMatch) {
    details.push({ icon: '↑', text: `${branchMatch[3]} → ${branchMatch[4]}` });
  }

  return { message: t('git.changesPushed'), details };
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
        onCopyPath: () => {},
        onTaskSessionOpen: async (proj, sessionId) => {
          const switchToClaude = () => {
            document.querySelector('[data-tab="claude"]')?.click();
            setSelectedProjectFilter(projectIndex);
            ProjectList.render();
            TerminalManager.filterByProject(projectIndex);
          };
          // Find existing terminal with this session
          const terms = terminalsState.get().terminals;
          for (const [id, td] of terms) {
            if (td.claudeSessionId === sessionId) {
              switchToClaude();
              TerminalManager.setActiveTerminal(id);
              return;
            }
          }
          // No terminal found → resume session
          await TerminalManager.resumeSession(proj, sessionId, { skipPermissions: settingsState.get().skipPermissions });
          switchToClaude();
        },
        onTaskRender: () => { refreshDashboardAsync(projectId); }
      });
    }
  }
}

async function gitPull(projectId, overridePath) {
  const project = getProject(projectId);
  if (!project) return;
  localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pulling: true });
  ProjectList.render();
  try {
    const result = await api.git.pull({ projectPath: overridePath || project.path });

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
        title: t('git.mergeConflicts'),
        message: t('git.conflictHint', { count: result.conflicts?.length || 0 }),
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
        title: t('git.pullSuccessful'),
        message: parsed.message,
        details: parsed.details,
        duration: 4000
      });

      // Refresh dashboard async - keep old data, load new in background
      refreshDashboardAsync(projectId);
    } else {
      showGitToast({
        success: false,
        title: t('git.pullError'),
        message: result.error || t('common.errorOccurred'),
        duration: 6000
      });
    }
  } catch (e) {
    localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pulling: false });
    ProjectList.render();
    showGitToast({
      success: false,
      title: t('git.pullError'),
      message: e.message || t('common.errorOccurred'),
      duration: 6000
    });
  }
}

async function gitPush(projectId, overridePath) {
  const project = getProject(projectId);
  if (!project) return;
  localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pushing: true });
  ProjectList.render();
  try {
    const result = await api.git.push({ projectPath: overridePath || project.path });
    localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pushing: false, lastResult: result });
    ProjectList.render();

    if (result.success) {
      const parsed = parseGitPushOutput(result.output);
      showGitToast({
        success: true,
        title: t('git.pushSuccessful'),
        message: parsed.message,
        details: parsed.details,
        duration: 4000
      });

      // Refresh dashboard async - keep old data, load new in background
      refreshDashboardAsync(projectId);
    } else {
      showGitToast({
        success: false,
        title: t('git.pushError'),
        message: result.error || t('common.errorOccurred'),
        duration: 6000
      });
    }
  } catch (e) {
    localState.gitOperations.set(projectId, { ...localState.gitOperations.get(projectId), pushing: false });
    ProjectList.render();
    showGitToast({
      success: false,
      title: t('git.pushError'),
      message: e.message || t('common.errorOccurred'),
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
        title: t('git.mergeAborted'),
        message: t('git.mergeAbortedSuccess'),
        duration: 4000
      });

      // Refresh dashboard
      refreshDashboardAsync(projectId);
    } else {
      showGitToast({
        success: false,
        title: t('git.abortError'),
        message: result.error || t('common.errorOccurred'),
        duration: 6000
      });
    }
  } catch (e) {
    showGitToast({
      success: false,
      title: t('git.abortError'),
      message: e.message || t('common.errorOccurred'),
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
  TerminalManager.createTypeConsole(project, projectIndex);
}

// Register FiveM listeners - write to TerminalManager's FiveM console
api.fivem.onData(({ projectIndex, data }) => {
  // Update local state logs
  const server = localState.fivemServers.get(projectIndex) || { status: 'running', logs: [] };
  server.logs.push(data);
  if (server.logs.join('').length > 10000) server.logs = [server.logs.join('').slice(-10000)];
  localState.fivemServers.set(projectIndex, server);

  // Write to TerminalManager's FiveM console
  TerminalManager.writeTypeConsole(projectIndex, 'fivem', data);
});

api.fivem.onExit(({ projectIndex, code }) => {
  localState.fivemServers.set(projectIndex, { status: 'stopped', logs: localState.fivemServers.get(projectIndex)?.logs || [] });

  // Write exit message to console
  TerminalManager.writeTypeConsole(projectIndex, 'fivem', `\r\n[Server exited with code ${code}]\r\n`);

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
    TerminalManager.handleTypeConsoleError(projectIndex, error);
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

  TerminalManager.createTypeConsole(project, projectIndex);
}

function refreshWebAppInfoPanel(projectIndex) {
  // Find webapp console wrapper and re-render info if the Info tab is active
  const consoleTerminal = TerminalManager.getTypeConsoleTerminal(projectIndex, 'webapp');
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
  TerminalManager.writeTypeConsole(projectIndex, 'webapp', data);
});

api.webapp.onExit(({ projectIndex, code }) => {
  TerminalManager.writeTypeConsole(projectIndex, 'webapp', `\r\n[Dev server exited with code ${code}]\r\n`);
  ProjectList.render();
});

api.webapp.onPortDetected(({ projectIndex, port }) => {
  ProjectList.render();
  // Re-render Info panel if currently visible
  refreshWebAppInfoPanel(projectIndex);
});

// ========== MCP Terminal (create/send/close from MCP tools) ==========

if (api.mcpTerminal) {
  api.mcpTerminal.onCreate(async (data) => {
    try {
      const project = getProject(data.projectId);
      if (!project) {
        console.warn(`[MCP Terminal] Project not found: ${data.projectId}`);
        return;
      }
      console.log(`[MCP Terminal] Creating terminal for "${project.name}" (${data.mode || 'terminal'})`);
      await TerminalManager.createTerminal(project, {
        mode: data.mode || null,
        runClaude: data.mode === 'chat',
      });
    } catch (e) {
      console.error('[MCP Terminal] Create error:', e);
    }
  });

  api.mcpTerminal.onSend((data) => {
    try {
      // Find the active terminal for this project
      const terminals = terminalsState.get().terminals;
      let targetId = null;
      for (const [id, td] of terminals) {
        if (td.project?.id === data.projectId) {
          targetId = id;
          break;
        }
      }
      if (targetId === null) {
        console.warn(`[MCP Terminal] No terminal found for project: ${data.projectId}`);
        return;
      }
      console.log(`[MCP Terminal] Sending command to terminal ${targetId}: ${data.command}`);
      api.terminal.input({ id: targetId, data: data.command + '\r' });
    } catch (e) {
      console.error('[MCP Terminal] Send error:', e);
    }
  });

  api.mcpTerminal.onClose((data) => {
    try {
      const terminals = terminalsState.get().terminals;
      let targetId = null;
      if (data.terminalId) {
        targetId = parseInt(data.terminalId, 10);
      } else {
        for (const [id, td] of terminals) {
          if (td.project?.id === data.projectId) {
            targetId = id;
            break;
          }
        }
      }
      if (targetId === null) {
        console.warn(`[MCP Terminal] No terminal found to close for project: ${data.projectId}`);
        return;
      }
      console.log(`[MCP Terminal] Closing terminal ${targetId}`);
      TerminalManager.closeTerminal(targetId);
    } catch (e) {
      console.error('[MCP Terminal] Close error:', e);
    }
  });
}

// Sync terminals.json so MCP terminal_list can read active terminals
let _termSyncTimer = null;
terminalsState.subscribe(() => {
  if (_termSyncTimer) clearTimeout(_termSyncTimer);
  _termSyncTimer = setTimeout(() => {
    try {
      const terminals = terminalsState.get().terminals;
      const list = [];
      for (const [id, td] of terminals) {
        list.push({
          id,
          projectId: td.project?.id || null,
          projectName: td.project?.name || td.name || '?',
          mode: td.mode || 'terminal',
          started: td.createdAt || null,
        });
      }
      const filePath = path.join(dataDir, 'terminals.json');
      fsp.writeFile(filePath, JSON.stringify(list, null, 2)).catch(() => {});
    } catch (_) {}
  }, 500);
});

// ========== API ==========
async function startApiServer(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  const { startApiServer: doStart } = require('./src/project-types/api/renderer/ApiRendererService');
  await doStart(projectIndex);
  ProjectList.render();
}

async function stopApiServer(projectIndex) {
  const { stopApiServer: doStop } = require('./src/project-types/api/renderer/ApiRendererService');
  await doStop(projectIndex);
  ProjectList.render();
}

function openApiConsole(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  TerminalManager.createTypeConsole(project, projectIndex);
}

// Register API listeners - state + TerminalManager console
api.api.onData(({ projectIndex, data }) => {
  const { addApiLog } = require('./src/project-types/api/renderer/ApiState');
  addApiLog(projectIndex, data);
  TerminalManager.writeTypeConsole(projectIndex, 'api', data);
});

api.api.onExit(({ projectIndex, code }) => {
  const { setApiServerStatus, setApiPort } = require('./src/project-types/api/renderer/ApiState');
  setApiServerStatus(projectIndex, 'stopped');
  setApiPort(projectIndex, null);
  TerminalManager.writeTypeConsole(projectIndex, 'api', `\r\n[API server exited with code ${code}]\r\n`);
  ProjectList.render();
});

api.api.onPortDetected(({ projectIndex, port }) => {
  const { setApiPort } = require('./src/project-types/api/renderer/ApiState');
  setApiPort(projectIndex, port);
  ProjectList.render();
});

// ========== DISCORD ==========
async function startDiscordBot(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  const { startBot } = require('./src/project-types/discord/renderer/DiscordRendererService');
  await startBot(projectIndex);
  ProjectList.render();
}

async function stopDiscordBot(projectIndex) {
  const { stopBot } = require('./src/project-types/discord/renderer/DiscordRendererService');
  await stopBot(projectIndex);
  ProjectList.render();
}

function openDiscordConsole(projectIndex) {
  const projects = projectsState.get().projects;
  const project = projects[projectIndex];
  if (!project) return;

  TerminalManager.createTypeConsole(project, projectIndex);
}

async function scanDiscordCommands(projectIndex) {
  const { scanCommands } = require('./src/project-types/discord/renderer/DiscordRendererService');
  await scanCommands(projectIndex);
}

// Register Discord listeners - write to TerminalManager's Discord console
api.discord.onData(({ projectIndex, data }) => {
  const { addDiscordLog, setDiscordServerStatus } = require('./src/project-types/discord/renderer/DiscordState');
  addDiscordLog(projectIndex, data);
  setDiscordServerStatus(projectIndex, 'running');
  TerminalManager.writeTypeConsole(projectIndex, 'discord', data);
});

api.discord.onExit(({ projectIndex, code }) => {
  const { setDiscordServerStatus } = require('./src/project-types/discord/renderer/DiscordState');
  setDiscordServerStatus(projectIndex, 'stopped');
  TerminalManager.writeTypeConsole(projectIndex, 'discord', `\r\n[Bot exited with code ${code}]\r\n`);
  ProjectList.render();
});

api.discord.onStatusChange(({ projectIndex, status, botName, guildCount }) => {
  const { setDiscordServerStatus, setDiscordBotInfo } = require('./src/project-types/discord/renderer/DiscordState');
  if (status) setDiscordServerStatus(projectIndex, status);
  if (botName !== undefined || guildCount !== undefined) {
    setDiscordBotInfo(projectIndex, { botName, guildCount });
  }
  ProjectList.render();
});

// ========== DELETE PROJECT ==========
async function deleteProjectUI(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const projectIndex = getProjectIndex(projectId);

  // Capture cloud state before deletion
  const wasCloudSynced = cloudConnected && cloudUploadStatus.get(projectId)?.synced;
  const projectName = project.name || path.basename(project.path);

  const confirmed = await ModalComponent.showConfirm({
    title: t('projects.deleteProject') || 'Delete project',
    message: t('projects.confirmDelete', { name: project.name }) || `Delete "${project.name}"?`,
    confirmLabel: t('common.delete'),
    danger: true
  });
  if (!confirmed) return;

  // Stop any type-specific running processes (e.g., FiveM server)
  const deleteTypeHandler = registry.get(project.type);
  if (deleteTypeHandler.onProjectDelete) {
    deleteTypeHandler.onProjectDelete(project, projectIndex);
  }

  // Close all terminals associated with this project
  let closedTerminalCount = 0;
  const terminals = terminalsState.get().terminals;
  const terminalIdsToClose = [];
  terminals.forEach((term, id) => {
    if (term.projectIndex === projectIndex) {
      terminalIdsToClose.push(id);
    }
  });
  terminalIdsToClose.forEach(id => {
    TerminalManager.closeTerminal(id);
    closedTerminalCount++;
  });
  if (closedTerminalCount > 0) {
    showToast({
      type: 'info',
      title: t('projects.terminalsClosedWithProject', { count: closedTerminalCount })
    });
  }

  const projects = projectsState.get().projects.filter(p => p.id !== projectId);
  let rootOrder = projectsState.get().rootOrder;
  if (project.folderId === null) {
    rootOrder = rootOrder.filter(id => id !== projectId);
  }

  projectsState.set({ projects, rootOrder });
  saveProjects();
  clearProjectSessions(projectId);

  if (projectsState.get().selectedProjectFilter === projectIndex) {
    setSelectedProjectFilter(null);
  }
  ProjectList.render();
  TerminalManager.filterByProject(projectsState.get().selectedProjectFilter);

  // Propose to delete cloud copy if project was synced
  if (wasCloudSynced) {
    const cloudConfirmed = await ModalComponent.showConfirm({
      title: t('cloud.deleteCloudCopyTitle'),
      message: t('cloud.deleteCloudCopyMessage', { name: projectName }),
      confirmLabel: t('cloud.deleteCloudCopyConfirm'),
      cancelLabel: t('cloud.deleteCloudCopyKeep'),
      danger: true,
    });
    if (cloudConfirmed) {
      try {
        await api.cloud.deleteProject({ projectId, projectName });
        showToast({ type: 'success', title: t('cloud.deleteSuccess'), message: projectName });
      } catch (err) {
        showToast({ type: 'error', title: t('cloud.deleteError'), message: err.message });
      }
    }
  }
  cloudUploadStatus.delete(projectId);
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

// ========== WORKTREE CREATION ==========
async function openNewWorktreeModal(project) {
  // Load existing worktrees first
  let existingWorktrees = [];
  try {
    const wtResult = await api.git.worktreeList({ projectPath: project.path });
    if (wtResult?.success && wtResult.worktrees?.length > 1) {
      // Exclude main worktree (current project path)
      existingWorktrees = wtResult.worktrees.filter(wt => !wt.isMain);
    }
  } catch (_) {}

  const existingHtml = existingWorktrees.length > 0 ? `
    <div class="worktree-section">
      <p class="worktree-section-label">${escapeHtml(t('projects.worktreeExisting'))}</p>
      <div class="worktree-existing-list">
        ${existingWorktrees.map(wt => {
          const branchLabel = wt.detached ? wt.head?.substring(0, 7) : (wt.branch || '?');
          const shortPath = wt.path.replace(/\\/g, '/').split('/').slice(-2).join('/');
          return `<button class="worktree-existing-item" data-wt-path="${escapeHtml(wt.path)}" data-wt-branch="${escapeHtml(branchLabel)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" d="M6 3v12m0 0a3 3 0 100 6 3 3 0 000-6zm12-6a3 3 0 100-6 3 3 0 000 6zm0 0c0 4.5-1.5 6-6 6"/></svg>
            <span class="worktree-existing-branch">${escapeHtml(branchLabel)}</span>
            <span class="worktree-existing-path">${escapeHtml(shortPath)}</span>
          </button>`;
        }).join('')}
      </div>
    </div>
    <div class="worktree-divider"></div>` : '';

  const html = `
    <div class="worktree-modal-body">
      <div class="worktree-project-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
        <span>${escapeHtml(project.name || project.path)}</span>
      </div>
      ${existingHtml}
      <div class="worktree-section">
        ${existingWorktrees.length > 0 ? `<p class="worktree-section-label">${escapeHtml(t('projects.worktreeCreateNew'))}</p>` : ''}
        <div class="worktree-input-wrap">
          <span class="worktree-branch-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" d="M6 3v12m0 0a3 3 0 100 6 3 3 0 000-6zm12-6a3 3 0 100-6 3 3 0 000 6zm0 0c0 4.5-1.5 6-6 6"/></svg>
          </span>
          <input type="text" id="worktree-branch-input" class="worktree-input"
            placeholder="${t('projects.worktreeBranchPlaceholder')}"
            autocomplete="off" spellcheck="false">
        </div>
        <p class="worktree-hint">${t('projects.worktreeBranchLabel')}</p>
      </div>
    </div>
    <div class="worktree-modal-footer">
      <button class="worktree-btn-cancel" onclick="closeModal()">
        ${t('common.cancel')}
      </button>
      <button class="worktree-btn-create" id="worktree-create-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        ${t('projects.worktreeCreate')}
      </button>
    </div>`;

  showModal(t('projects.newWorktree'), html);

  // Wire existing worktree buttons
  document.querySelectorAll('.worktree-existing-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const wtPath = btn.dataset.wtPath;
      const wtBranch = btn.dataset.wtBranch;
      closeModal();
      TerminalManager.createTerminal(project, {
        skipPermissions: settingsState.get().skipPermissions,
        cwd: wtPath,
        name: wtBranch
      });
    });
  });

  const input = document.getElementById('worktree-branch-input');
  const createBtn = document.getElementById('worktree-create-btn');
  if (!input || !createBtn) return;

  input.focus();

  async function doCreate() {
    const branchName = input.value.trim();
    if (!branchName) { input.focus(); return; }

    createBtn.disabled = true;
    createBtn.innerHTML = `<span class="worktree-btn-spinner"></span>${t('projects.worktreeCreating')}`;

    // Worktree path: sibling folder named <project>-<branch> (slashes → dashes)
    const basePath = window.electron_nodeModules.path.dirname(project.path);
    const safeBranch = branchName.replace(/[/\\:*?"<>|]/g, '-');
    const projectBase = window.electron_nodeModules.path.basename(project.path);
    const worktreePath = window.electron_nodeModules.path.join(basePath, `${projectBase}-${safeBranch}`);

    const result = await api.git.worktreeCreate({
      projectPath: project.path,
      worktreePath,
      newBranch: branchName
    });

    if (!result.success) {
      createBtn.disabled = false;
      createBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>${t('projects.worktreeCreate')}`;
      showToast({ type: 'error', title: t('projects.worktreeError', { error: result.error }) });
      return;
    }

    closeModal();
    showToast({ type: 'success', title: t('projects.worktreeSuccess', { branch: branchName }) });

    // Open a tab in the same project, with the worktree path as cwd
    TerminalManager.createTerminal(project, {
      skipPermissions: settingsState.get().skipPermissions,
      cwd: worktreePath,
      name: safeBranch
    });
  }

  createBtn.addEventListener('click', doCreate);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
  });
}

// ========== SESSIONS MODAL ==========
// Pin storage for modal (shared with TerminalManager via same file)
const _modalPinsFile = path.join(window.electron_nodeModules.os.homedir(), '.claude-terminal', 'session-pins.json');
let _modalPinsCache = null;

async function _loadModalPins() {
  if (_modalPinsCache) return _modalPinsCache;
  try {
    const raw = await fsp.readFile(_modalPinsFile, 'utf8');
    _modalPinsCache = JSON.parse(raw);
  } catch { _modalPinsCache = {}; }
  return _modalPinsCache;
}

async function _saveModalPins() {
  try { await fsp.writeFile(_modalPinsFile, JSON.stringify(_modalPinsCache || {}, null, 2), 'utf8'); } catch {}
}

async function _toggleModalPin(sessionId) {
  const pins = await _loadModalPins();
  if (pins[sessionId]) delete pins[sessionId]; else pins[sessionId] = true;
  _modalPinsCache = pins;
  await _saveModalPins();
  return !!pins[sessionId];
}

// SVG sprites for session modal
const MODAL_SVG_DEFS = `<svg style="display:none" xmlns="http://www.w3.org/2000/svg">
  <symbol id="sm-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></symbol>
  <symbol id="sm-bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></symbol>
  <symbol id="sm-msg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></symbol>
  <symbol id="sm-clock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></symbol>
  <symbol id="sm-branch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></symbol>
  <symbol id="sm-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></symbol>
  <symbol id="sm-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="sm-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>
  <symbol id="sm-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></symbol>
</svg>`;

function _cleanModalSessionText(text) {
  if (!text) return { text: '', skillName: '' };
  let skillName = '';
  const cmdMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (cmdMatch) skillName = cmdMatch[1].trim().replace(/^\//, '');
  const argsMatch = text.match(/<command-args>([^<]+)<\/command-args>/);
  const argsText = argsMatch ? argsMatch[1].trim() : '';
  let cleaned = text.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/\[Request interrupted[^\]]*\]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned && argsText) cleaned = argsText;
  return { text: cleaned, skillName };
}

function _formatModalTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return t('time.justNow');
  if (diffMins < 60) return t('time.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('time.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('time.daysAgo', { count: diffDays });
  const locale = getCurrentLanguage() === 'fr' ? 'fr-FR' : 'en-US';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

function _truncateModalText(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max) + '...';
}

async function _preprocessModalSessions(sessions) {
  const now = Date.now();
  const pins = await _loadModalPins();
  return sessions.map(session => {
    const promptResult = _cleanModalSessionText(session.firstPrompt);
    const summaryResult = _cleanModalSessionText(session.summary);
    const skillName = promptResult.skillName || summaryResult.skillName;
    let displayTitle = '', displaySubtitle = '', isSkill = false;
    if (summaryResult.text) { displayTitle = summaryResult.text; displaySubtitle = promptResult.text; }
    else if (promptResult.text) { displayTitle = promptResult.text; }
    else if (skillName) { displayTitle = '/' + skillName; isSkill = true; }
    else { displayTitle = t('newProject.untitledConversation'); }
    const hoursAgo = (now - new Date(session.modified).getTime()) / 3600000;
    const freshness = hoursAgo < 1 ? 'hot' : hoursAgo < 24 ? 'warm' : '';
    const searchText = (displayTitle + ' ' + displaySubtitle + ' ' + (session.gitBranch || '')).toLowerCase();
    const pinned = !!pins[session.sessionId];
    return { ...session, displayTitle, displaySubtitle, isSkill, freshness, searchText, pinned };
  });
}

function _groupModalSessions(sessions) {
  const groups = {
    pinned: { key: 'pinned', label: t('sessions.pinned'), sessions: [] },
    today: { key: 'today', label: t('sessions.today'), sessions: [] },
    yesterday: { key: 'yesterday', label: t('sessions.yesterday'), sessions: [] },
    thisWeek: { key: 'thisWeek', label: t('sessions.thisWeek'), sessions: [] },
    older: { key: 'older', label: t('sessions.older'), sessions: [] }
  };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  sessions.forEach(s => {
    if (s.pinned) { groups.pinned.sessions.push(s); return; }
    const d = new Date(s.modified);
    if (d >= today) groups.today.sessions.push(s);
    else if (d >= yesterday) groups.yesterday.sessions.push(s);
    else if (d >= weekAgo) groups.thisWeek.sessions.push(s);
    else groups.older.sessions.push(s);
  });
  return Object.values(groups).filter(g => g.sessions.length > 0);
}

function _buildModalCardHtml(s, index) {
  const freshClass = s.freshness ? ` session-card--${s.freshness}` : '';
  const pinnedClass = s.pinned ? ' session-card--pinned' : '';
  const animClass = index < 10 ? ' session-card--anim' : ' session-card--instant';
  const skillClass = s.isSkill ? ' session-card-icon--skill' : '';
  const titleSkillClass = s.isSkill ? ' session-card-title--skill' : '';
  const iconId = s.isSkill ? 'sm-bolt' : 'sm-chat';
  const pinTitle = s.pinned ? t('sessions.unpin') : t('sessions.pin');

  return `<div class="session-card${freshClass}${pinnedClass}${animClass}" data-sid="${s.sessionId}" style="--ci:${index < 10 ? index : 0}">
<div class="session-card-icon${skillClass}"><svg width="16" height="16"><use href="#${iconId}"/></svg></div>
<div class="session-card-body">
<span class="session-card-title${titleSkillClass}">${escapeHtml(_truncateModalText(s.displayTitle, 80))}</span>
${s.displaySubtitle ? `<span class="session-card-subtitle">${escapeHtml(_truncateModalText(s.displaySubtitle, 120))}</span>` : ''}
</div>
<div class="session-card-meta">
<span class="session-meta-item"><svg width="11" height="11"><use href="#sm-msg"/></svg>${s.messageCount}</span>
<span class="session-meta-item"><svg width="11" height="11"><use href="#sm-clock"/></svg>${_formatModalTime(s.modified)}</span>
${s.gitBranch ? `<span class="session-meta-branch"><svg width="10" height="10"><use href="#sm-branch"/></svg>${escapeHtml(s.gitBranch)}</span>` : ''}
</div>
<button class="session-card-pin" data-pin-sid="${s.sessionId}" title="${pinTitle}"><svg width="13" height="13"><use href="#sm-pin"/></svg></button>
<div class="session-card-arrow"><svg width="12" height="12"><use href="#sm-arrow"/></svg></div>
</div>`;
}

async function showSessionsModal(project) {
  if (!project) return;

  try {
    const sessions = await api.claude.sessions(project.path);

    if (!sessions || sessions.length === 0) {
      showModal(t('terminals.resumeConversation') || 'Resume a conversation', `
        <div class="sessions-modal-empty">
          <p>${t('terminals.noTerminals') || 'No conversations yet'}</p>
          <button class="modal-btn primary" onclick="closeModal(); createTerminalForProject(projectsState.get().projects[${getProjectIndex(project.id)}])">
            ${t('terminals.newConversation') || 'New conversation'}
          </button>
        </div>
      `);
      return;
    }

    // Add sessions-modal-wide class to make the modal wider
    const modalEl = document.getElementById('modal');
    modalEl?.classList.add('modal--sessions');

    const processed = await _preprocessModalSessions(sessions);
    const groups = _groupModalSessions(processed);
    const flatSessions = [];
    groups.forEach(g => g.sessions.forEach(s => flatSessions.push(s)));
    const sessionMap = new Map(flatSessions.map(s => [s.sessionId, s]));

    let cardIndex = 0;
    const groupsHtml = groups.map(group => {
      const cardsHtml = group.sessions.map(session => {
        const html = _buildModalCardHtml(session, cardIndex);
        cardIndex++;
        return html;
      }).join('');
      return `<div class="session-group" data-group-key="${group.key}">
        <div class="session-group-label">
          <span class="session-group-text">${group.label}</span>
          <span class="session-group-count">${group.sessions.length}</span>
          <span class="session-group-line"></span>
        </div>
        ${cardsHtml}
      </div>`;
    }).join('');

    showModal(t('terminals.resumeConversation') || 'Resume a conversation', `
      ${MODAL_SVG_DEFS}
      <div class="sessions-modal-modern">
        <div class="sessions-modal-toolbar">
          <div class="sessions-search-wrapper">
            <svg class="sessions-search-icon" width="13" height="13"><use href="#sm-search"/></svg>
            <input type="text" class="sessions-search" placeholder="${t('common.search') || 'Search'}..." />
          </div>
          <span class="sessions-count">${sessions.length}</span>
          <button class="sessions-new-btn">
            <svg width="14" height="14"><use href="#sm-plus"/></svg>
            ${t('common.new') || 'New'}
          </button>
        </div>
        <div class="sessions-list">
          ${groupsHtml}
        </div>
      </div>
    `);

    const listEl = document.querySelector('.sessions-modal-modern .sessions-list');

    // Event delegation for clicks
    listEl?.addEventListener('click', async (e) => {
      const pinBtn = e.target.closest('.session-card-pin');
      if (pinBtn) {
        e.stopPropagation();
        const sid = pinBtn.dataset.pinSid;
        if (!sid) return;
        await _toggleModalPin(sid);
        // Invalidate cache in TerminalManager too
        _modalPinsCache = null;
        // Re-render
        showSessionsModal(project);
        return;
      }
      const card = e.target.closest('.session-card');
      if (!card) return;
      const sessionId = card.dataset.sid;
      if (!sessionId) return;
      const session = sessionMap.get(sessionId);
      const sessionName = session?.displayTitle || null;
      closeModal();
      TerminalManager.resumeSession(project, sessionId, {
        skipPermissions: settingsState.get().skipPermissions,
        name: sessionName
      });
    });

    // New conversation button
    document.querySelector('.sessions-modal-modern .sessions-new-btn')?.addEventListener('click', () => {
      closeModal();
      createTerminalForProject(project);
    });

    // Search
    const searchInput = document.querySelector('.sessions-modal-modern .sessions-search');
    if (searchInput) {
      let searchTimer = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          const query = searchInput.value.toLowerCase().trim();
          const cards = listEl.querySelectorAll('.session-card');
          const groupEls = listEl.querySelectorAll('.session-group');
          const visibility = [];
          cards.forEach(card => {
            const sid = card.dataset.sid;
            const session = sessionMap.get(sid);
            visibility.push({ card, match: !query || (session && session.searchText.includes(query)) });
          });
          visibility.forEach(({ card, match }) => { card.style.display = match ? '' : 'none'; });
          groupEls.forEach(group => {
            const hasVisible = group.querySelector('.session-card:not([style*="display: none"])');
            group.style.display = hasVisible ? '' : 'none';
          });
        }, 150);
      });
      // Auto-focus search
      requestAnimationFrame(() => searchInput.focus());
    }

  } catch (error) {
    console.error('Error showing sessions modal:', error);
    showModal('Error', `<p>${t('terminals.resumeError') || 'Unable to load sessions'}</p>`);
  }
}

// Make functions available globally for inline handlers
window.closeModal = closeModal;
window.createTerminalForProject = createTerminalForProject;
window.projectsState = projectsState;

// ========== CLOUD STATE PERSISTENCE ==========
const _cloudStateFile = path.join(window.electron_nodeModules.os.homedir(), '.claude-terminal', 'cloud-state.json');

async function _loadCloudState() {
  try {
    if (await fileExists(_cloudStateFile)) {
      const raw = await fsp.readFile(_cloudStateFile, 'utf8');
      return JSON.parse(raw);
    }
  } catch {}
  return {};
}

async function _saveCloudState(partial) {
  try {
    const current = await _loadCloudState();
    const merged = { ...current, ...partial };
    await fsp.writeFile(_cloudStateFile, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Cloud] Failed to save cloud state:', err.message);
  }
}

// ========== CLOUD UPLOAD ==========
// cloudUploadStatus: projectId -> { uploading?: boolean, synced?: boolean }
const cloudUploadStatus = new Map();
let cloudConnected = false;
let _activeUploadToast = null;

async function refreshCloudProjects() {
  try {
    const status = await api.cloud.status();
    if (!status.connected) return;
    const { projects: cloudProjects } = await api.cloud.getProjects();
    if (!cloudProjects || !Array.isArray(cloudProjects)) return;
    const cloudIds = new Set(cloudProjects.map(p => p.name)); // cloud name = project UUID
    const localProjects = projectsState.get().projects || [];

    // Persist cloud project IDs for deletion detection
    await _saveCloudState({ lastKnownCloudProjectIds: [...cloudIds] });

    for (const p of localProjects) {
      const cur = cloudUploadStatus.get(p.id) || {};
      if (cloudIds.has(p.id)) {
        cloudUploadStatus.set(p.id, {
          ...cur,
          synced: true,
          lastSync: cur.lastSync || null,
        });
      } else if (cur.synced) {
        cloudUploadStatus.delete(p.id);
      }
    }
    ProjectList.render();
  } catch (err) {
    if (err?.message?.includes('timed out') || err?.message?.includes('ECONNREFUSED') || err?.message?.includes('fetch')) {
      showToast({ type: 'warning', title: t('cloud.networkErrorTitle'), message: t('cloud.networkErrorMessage'), duration: 5000 });
    }
  }
}

async function cloudUploadProject(projectId) {
  const project = projectsState.get().projects.find(p => p.id === projectId);
  if (!project) return;

  // Skip if project directory doesn't exist (e.g. synced from another machine)
  if (project.path && !fs.existsSync(project.path)) return;

  // Check cloud connection
  try {
    const status = await api.cloud.status();
    if (!status.connected) {
      showToast({ type: 'warning', title: t('cloud.uploadTitle'), message: t('cloud.disconnected') });
      return;
    }
  } catch {
    showToast({ type: 'warning', title: t('cloud.uploadTitle'), message: t('cloud.disconnected') });
    return;
  }

  // Prevent double upload on same project
  if (cloudUploadStatus.get(projectId)?.uploading) return;

  cloudUploadStatus.set(projectId, { ...cloudUploadStatus.get(projectId), uploading: true });
  ProjectList.render();

  const projectName = project.name || path.basename(project.path);

  // Check if project has a GitHub remote — use git clone if available (faster)
  let useGitClone = false;
  if (api.cloud.checkGitRemote) {
    try {
      const { hasGitHub } = await api.cloud.checkGitRemote({ projectPath: project.path });
      useGitClone = hasGitHub;
    } catch (_) {}
  }

  _activeUploadToast = showToast({ type: 'info', title: t('cloud.uploadTitle'), message: useGitClone ? t('cloud.uploadPhaseCloning') || 'Cloning from GitHub...' : t('cloud.uploadPhaseScanning'), duration: 0 });

  // Safety net: auto-close toast after 5m30s if upload hangs
  const _uploadSafetyTimer = setTimeout(() => {
    if (_activeUploadToast) { _activeUploadToast.querySelector('.toast-close')?.click(); _activeUploadToast = null; }
  }, 330_000);

  try {
    if (useGitClone) {
      await api.cloud.uploadProjectGit({ projectId: project.id, projectName, projectPath: project.path });
    } else {
      await api.cloud.uploadProject({ projectId: project.id, projectName, projectPath: project.path });
    }
    cloudUploadStatus.set(projectId, { synced: true, lastSync: Date.now() });
    ProjectList.render();
    clearTimeout(_uploadSafetyTimer);
    if (_activeUploadToast) { _activeUploadToast.querySelector('.toast-close')?.click(); _activeUploadToast = null; }
    showToast({ type: 'success', title: t('cloud.uploadSuccess'), message: projectName });
  } catch (err) {
    // Keep synced state if it was previously synced
    const wasSynced = cloudUploadStatus.get(projectId)?.synced;
    cloudUploadStatus.set(projectId, wasSynced ? { synced: true } : {});
    if (!wasSynced) cloudUploadStatus.delete(projectId);
    ProjectList.render();
    clearTimeout(_uploadSafetyTimer);
    if (_activeUploadToast) { _activeUploadToast.querySelector('.toast-close')?.click(); _activeUploadToast = null; }
    showToast({ type: 'error', title: t('cloud.uploadError'), message: err.message || projectName });
  }
}

async function cloudDeleteProject(projectId) {
  const project = projectsState.get().projects.find(p => p.id === projectId);
  if (!project) return;
  const projectName = project.name || path.basename(project.path);

  const confirmed = await ModalComponent.showConfirm({
    title: t('cloud.deleteTitle'),
    message: t('cloud.confirmCloudDelete', { name: projectName }),
    confirmLabel: t('cloud.deleteTitle'),
    danger: true,
  });
  if (!confirmed) return;

  try {
    await api.cloud.deleteProject({ projectId, projectName });
    cloudUploadStatus.delete(projectId);
    ProjectList.render();
    showToast({ type: 'success', title: t('cloud.deleteSuccess'), message: projectName });
  } catch (err) {
    showToast({ type: 'error', title: t('cloud.deleteError'), message: err.message || projectName });
  }
}

let _uploadSpeedStart = null;
let _uploadSpeedLastMB = 0;
if (api.cloud?.onUploadProgress) {
  api.cloud.onUploadProgress((progress) => {
    // Update cloudUploadStatus for project list badge (SVG ring)
    if (progress.projectId) {
      const current = cloudUploadStatus.get(progress.projectId) || {};
      if (progress.phase === 'done') {
        cloudUploadStatus.set(progress.projectId, { ...current, uploadProgress: null });
      } else {
        cloudUploadStatus.set(progress.projectId, { ...current, uploadProgress: progress });
      }
      ProjectList.render();
    }

    // Update toast message
    if (!_activeUploadToast) { _uploadSpeedStart = null; return; }
    const msgEl = _activeUploadToast.querySelector('.toast-message');
    if (!msgEl) return;
    const phases = {
      scanning: t('cloud.uploadPhaseScanning'),
      compressing: t('cloud.uploadPhaseCompressing'),
      uploading: t('cloud.uploadPhaseUploading'),
      done: t('cloud.uploadSuccess'),
    };
    if (phases[progress.phase]) {
      if (progress.phase === 'uploading' && progress.uploadedMB != null && progress.totalMB != null) {
        const now = Date.now();
        if (!_uploadSpeedStart) _uploadSpeedStart = now;
        const elapsed = (now - _uploadSpeedStart) / 1000;
        const speed = elapsed > 1 ? (progress.uploadedMB / elapsed).toFixed(1) : null;
        const speedStr = speed ? ` — ${speed} MB/s` : '';
        msgEl.textContent = `${progress.uploadedMB} / ${progress.totalMB} MB (${progress.percent}%)${speedStr}`;
      } else {
        _uploadSpeedStart = null;
        const pct = typeof progress.percent === 'number' ? ` (${progress.percent}%)` : '';
        msgEl.textContent = phases[progress.phase] + pct;
      }
    }
  });
}

// Cross-machine notification: another desktop uploaded a project
if (api.cloud?.onProjectUpdated) {
  api.cloud.onProjectUpdated((data) => {
    const localProjects = projectsState.get().projects || [];
    const project = localProjects.find(p => p.id === data.projectId);
    const displayName = data.displayName || project?.name || data.projectId;

    showToast({
      type: 'info',
      title: t('cloud.projectUpdatedRemotely'),
      message: t('cloud.projectUpdatedRemotelyMessage', { name: displayName }),
      duration: 8000,
    });

    // Refresh cloud projects list
    if (project) {
      refreshCloudProjects();
    }
  });
}

// Refresh cloud projects on status change and at startup
function _updateCloudConnected(connected) {
  cloudConnected = connected;
  if (!connected) cloudUploadStatus.clear();
  ProjectList.setExternalState({ cloudConnected });
  ProjectList.render();
}

/**
 * Check for new cloud projects not present locally and show a notification.
 */
async function _checkNewCloudProjects() {
  try {
    const { projects: cloudProjects } = await api.cloud.getProjects();
    if (!cloudProjects || !Array.isArray(cloudProjects)) return;

    const localProjects = projectsState.get().projects || [];
    const localNames = new Set(localProjects.map(p => p.name));
    const localBasenames = new Set(
      localProjects.map(p => p.path?.replace(/\\/g, '/').split('/').pop()).filter(Boolean)
    );

    const newProjects = cloudProjects.filter(
      p => !localNames.has(p.name) && !localBasenames.has(p.name)
    );

    if (newProjects.length === 0) return;

    const names = newProjects.map(p => p.name);
    const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} (+${names.length - 3})`;

    const toast = showToast({
      type: 'info',
      title: t('cloud.newCloudProjectsTitle'),
      message: t('cloud.newCloudProjectsMessage', { list, count: names.length }),
      duration: 12000,
    });
    // Make toast clickable → navigate to cloud panel
    if (toast) {
      toast.style.cursor = 'pointer';
      toast.querySelector('.toast-content')?.addEventListener('click', () => {
        const cloudTab = document.querySelector('[data-tab="connectivity"]');
        if (cloudTab) cloudTab.click();
        toast.querySelector('.toast-close')?.click();
      });
    }
  } catch { /* ignore */ }
}

if (api.cloud?.onStatusChanged) {
  api.cloud.onStatusChanged((status) => {
    _updateCloudConnected(status.connected);
    if (status.connected) {
      refreshCloudProjects();
      _checkNewCloudProjects();
      _checkCloudDeletedProjects();
    }
  });
}
setTimeout(async () => {
  try {
    const s = await api.cloud.status();
    if (s.connected) {
      _updateCloudConnected(true);
      refreshCloudProjects();
      _checkNewCloudProjects();
      _checkCloudDeletedProjects();
    }
  } catch { /* ignore */ }
}, 3000);

// ── Auto-upload new projects to cloud ──
let _knownProjectIds = new Set(projectsState.get().projects.map(p => p.id));
let _skipAutoUploadIds = new Set(); // IDs imported from cloud — skip re-upload
/** Mark a project ID to skip auto-upload (called from CloudPanel on import) */
window._cloudSkipAutoUpload = (id) => _skipAutoUploadIds.add(id);
window._cloudReset = resetCloudState;
projectsState.subscribe((state) => {
  const currentIds = new Set(state.projects.map(p => p.id));
  const newIds = [...currentIds].filter(id => !_knownProjectIds.has(id));
  _knownProjectIds = currentIds;

  if (newIds.length === 0) return;
  if (!cloudConnected) return;
  if (settingsState.get().cloudAutoUploadProjects === false) return;

  for (const id of newIds) {
    if (_skipAutoUploadIds.has(id)) { _skipAutoUploadIds.delete(id); continue; }
    // Check if already synced (e.g. imported from cloud)
    if (cloudUploadStatus.get(id)?.synced) continue;
    cloudUploadProject(id).catch(() => {});
  }
});


/**
 * Detect projects deleted from cloud since last session.
 * Shows a single grouped notification instead of one modal per project.
 * Skips detection if cloud appears empty (likely server issue).
 */
async function _checkCloudDeletedProjects() {
  try {
    const cloudState = await _loadCloudState();
    const previousIds = new Set(cloudState.lastKnownCloudProjectIds || []);
    if (previousIds.size === 0) return; // No previous data - first connection

    const { projects: currentCloudProjects } = await api.cloud.getProjects();
    if (!currentCloudProjects || !Array.isArray(currentCloudProjects)) return;
    const currentIds = new Set(currentCloudProjects.map(p => p.name));

    // If cloud is completely empty but we had many projects before, likely a server
    // reset or connectivity issue - silently update state instead of spamming modals
    if (currentIds.size === 0 && previousIds.size > 1) {
      console.warn('[Cloud] Cloud is empty but had', previousIds.size, 'projects - skipping deletion check (likely server reset)');
      await _saveCloudState({ lastKnownCloudProjectIds: [] });
      // Clear synced status for all projects
      for (const id of previousIds) cloudUploadStatus.delete(id);
      ProjectList.render();
      return;
    }

    const localProjects = projectsState.get().projects || [];
    const removedProjects = localProjects.filter(p => previousIds.has(p.id) && !currentIds.has(p.id));

    if (removedProjects.length === 0) {
      await _saveCloudState({ lastKnownCloudProjectIds: [...currentIds] });
      return;
    }

    // Show a single grouped confirmation for all removed projects
    const names = removedProjects.map(p => p.name).join(', ');
    const confirmed = await ModalComponent.showConfirm({
      title: t('cloud.projectRemovedFromCloudTitle'),
      message: t('cloud.projectRemovedFromCloudMessage', { name: names, count: removedProjects.length }),
      confirmLabel: t('cloud.projectRemovedDelete'),
      cancelLabel: t('cloud.projectRemovedKeep'),
      danger: true,
    });

    if (confirmed) {
      const removedIds = new Set(removedProjects.map(p => p.id));
      // Close associated terminals
      const terminals = terminalsState.get().terminals;
      terminals.forEach((term, id) => {
        const proj = localProjects.find(p => getProjectIndex(p.id) === term.projectIndex);
        if (proj && removedIds.has(proj.id)) TerminalManager.closeTerminal(id);
      });

      const projects = projectsState.get().projects.filter(p => !removedIds.has(p.id));
      let rootOrder = projectsState.get().rootOrder.filter(id => !removedIds.has(id));
      projectsState.set({ projects, rootOrder });
      saveProjects();
      for (const p of removedProjects) {
        clearProjectSessions(p.id);
        cloudUploadStatus.delete(p.id);
      }
    } else {
      // User chose to keep - clear cloud state so we don't ask again
      for (const p of removedProjects) cloudUploadStatus.delete(p.id);
    }

    // Update stored state with current data
    await _saveCloudState({ lastKnownCloudProjectIds: [...currentIds] });
    ProjectList.render();
  } catch (err) {
    console.warn('[Cloud] Check cloud-deleted projects failed:', err.message);
  }
}

/** Reset cloud state - clears sync metadata, upload status, and cloud-state.json */
async function resetCloudState() {
  const confirmed = await ModalComponent.showConfirm({
    title: t('cloud.resetTitle'),
    message: t('cloud.resetMessage'),
    confirmLabel: t('cloud.resetConfirm'),
    danger: true,
  });
  if (!confirmed) return;

  // Clear cloud-state.json
  try { await fsp.unlink(_cloudStateFile); } catch {}

  // Clear all upload statuses
  cloudUploadStatus.clear();

  // Stop sync engine
  try { await api.cloud.syncStop(); } catch {}

  // Clear sync metadata
  const syncMetaFile = path.join(window.electron_nodeModules.os.homedir(), '.claude-terminal', 'sync-meta.json');
  try { await fsp.unlink(syncMetaFile); } catch {}

  ProjectList.render();
  showToast({ type: 'success', title: t('cloud.resetSuccess') });
}

// ========== SETUP COMPONENTS ==========
// Setup ProjectList
ProjectList.setExternalState({
  fivemServers: localState.fivemServers,
  gitOperations: localState.gitOperations,
  gitRepoStatus: localState.gitRepoStatus,
  cloudUploadStatus,
  cloudConnected
});
QuickActions.setGitRepoStatus(localState.gitRepoStatus);

ProjectList.setCallbacks({
  onCreateTerminal: createTerminalForProject,
  onCreateBasicTerminal: createBasicTerminalForProject,
  onStartFivem: startFivemServer,
  onStopFivem: stopFivemServer,
  onOpenFivemConsole: openFivemConsole,
  onStartWebApp: startWebAppServer,
  onStopWebApp: stopWebAppServer,
  onOpenWebAppConsole: openWebAppConsole,
  onStartApi: startApiServer,
  onStopApi: stopApiServer,
  onOpenApiConsole: openApiConsole,
  onStartDiscordBot: startDiscordBot,
  onStopDiscordBot: stopDiscordBot,
  onOpenDiscordConsole: openDiscordConsole,
  onScanDiscordCommands: scanDiscordCommands,
  onGitPull: gitPull,
  onGitPush: gitPush,
  onNewWorktree: openNewWorktreeModal,
  onCloudUpload: cloudUploadProject,
  onCloudDelete: cloudDeleteProject,
  onCloudReset: resetCloudState,
  onDeleteProject: deleteProjectUI,
  onRenameProject: renameProjectUI,
  onRenderProjects: () => ProjectList.render(),
  onCreateFolder: () => promptCreateFolder(null),
  onFilterTerminals: (idx) => { TerminalManager.filterByProject(idx); saveTerminalSessions(); },
  countTerminalsForProject: TerminalManager.countTerminalsForProject,
  getTerminalStatsForProject: TerminalManager.getTerminalStatsForProject
});

// Tab/project switch functions (shared between xterm handler and IPC ctrl-arrow)
function switchTerminal(direction) {
  const allTerminals = terminalsState.get().terminals;
  const currentId = terminalsState.get().activeTerminal;
  const currentFilter = projectsState.get().selectedProjectFilter;
  const projects = projectsState.get().projects;
  const filterProject = projects[currentFilter];

  // Get only visible terminals (respecting project filter)
  const visibleTerminals = [];
  allTerminals.forEach((termData, id) => {
    const isVisible = currentFilter === null ||
      (filterProject && termData.project && (
        termData.project.path === filterProject.path ||
        termData.project.parentRepoProjectId === filterProject.id
      ));
    if (isVisible) {
      visibleTerminals.push(id);
    }
  });

  if (visibleTerminals.length === 0) return;

  const currentIndex = visibleTerminals.indexOf(currentId);
  let targetIndex;

  if (currentIndex === -1) {
    targetIndex = 0;
  } else if (direction === 'left') {
    targetIndex = (currentIndex - 1 + visibleTerminals.length) % visibleTerminals.length;
  } else {
    targetIndex = (currentIndex + 1) % visibleTerminals.length;
  }

  TerminalManager.setActiveTerminal(visibleTerminals[targetIndex]);
}

function switchProject(direction) {
  const projects = projectsState.get().projects;
  const terminals = terminalsState.get().terminals;

  const visualOrder = getVisualProjectOrder();
  const projectsWithTerminals = visualOrder.filter(project => {
    for (const [, t] of terminals) {
      if (t.project && t.project.path === project.path) return true;
    }
    return false;
  });

  if (projectsWithTerminals.length <= 1) return;

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

// Setup TerminalManager
TerminalManager.setCallbacks({
  onNotification: showNotification,
  onRenderProjects: () => ProjectList.render(),
  onCreateTerminal: createTerminalForProject,
  onSwitchTerminal: switchTerminal,
  onSwitchProject: switchProject,
  onActiveTerminalChange: handleActiveTerminalChange
});

// Listen for Ctrl+Arrow forwarded from main process (bypasses Windows Snap)
// Ctrl+Left/Right: word-jump in active terminal (VT escape sequences)
// Ctrl+Up/Down: switches projects
api.window.onCtrlArrow((dir) => {
  if (dir === 'up' || dir === 'down') {
    switchProject(dir);
  } else if (dir === 'left' || dir === 'right') {
    // Word-jump when enabled, fall back to tab switching when disabled
    const ts = settingsState.get().terminalShortcuts || {};
    if (ts.ctrlArrow?.enabled === false) {
      switchTerminal(dir);
    } else {
      const activeId = terminalsState.get().activeTerminal;
      if (activeId) {
        const seq = dir === 'left' ? '\x1b[1;5D' : '\x1b[1;5C';
        api.terminal.input({ id: activeId, data: seq });
      }
    }
  }
});

// Listen for Ctrl+Tab/Ctrl+Shift+Tab forwarded from main process (Chromium swallows Tab)
api.window.onCtrlTab((dir) => {
  switchTerminal(dir);
});

// Sync Ctrl+Tab enabled state to main process on startup
{
  const ts = settingsState.get().terminalShortcuts || {};
  const ctrlTabEnabled = ts.ctrlTab?.enabled !== false;
  api.window.setCtrlTabEnabled(ctrlTabEnabled);
}

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
  },
  onAddToChat: (relativePath, fullPath) => {
    const activeId = terminalsState.get().activeTerminal;
    if (activeId == null) return;
    const termData = terminalsState.get().terminals.get(activeId);
    if (termData?.chatView?.addMentionChip) {
      termData.chatView.addMentionChip('file', { path: relativePath, fullPath });
    }
  }
});
FileExplorer.init();

// Toggle explorer button
const btnToggleExplorer = document.getElementById('btn-toggle-explorer');
if (btnToggleExplorer) {
  btnToggleExplorer.onclick = () => FileExplorer.toggle();
}

// Wire "+" new terminal button
const btnNewTerminal = document.getElementById('btn-new-terminal');
if (btnNewTerminal) {
  btnNewTerminal.onclick = () => {
    const selectedFilter = projectsState.get().selectedProjectFilter;
    const projects = projectsState.get().projects;
    if (selectedFilter !== null && projects[selectedFilter]) {
      createTerminalForProject(projects[selectedFilter]);
    }
  };
}

// ========== FILE WATCHER ==========
api.explorer.onChanges((changes) => {
  FileExplorer.applyWatcherChanges(changes).catch(() => {
    // Silently ignore — stale path, race condition, etc.
  });
});

api.explorer.onWatchLimitWarning((totalPaths) => {
  showToast({ type: 'warning', title: t('fileExplorer.title'), message: t('fileExplorer.watchLimitWarning', { count: totalPaths }) });
});
// Wire lightbulb resume session button
const btnResumeSession = document.getElementById('btn-resume-session');
if (btnResumeSession) {
  btnResumeSession.onclick = () => {
    const selectedFilter = projectsState.get().selectedProjectFilter;
    const projects = projectsState.get().projects;
    if (selectedFilter !== null && projects[selectedFilter]) {
      showSessionsModal(projects[selectedFilter]);
    }
  };
}

// Subscribe to project selection changes for FileExplorer
projectsState.subscribe(() => {
  const state = projectsState.get();
  const selectedFilter = state.selectedProjectFilter;
  const projects = state.projects;

  if (selectedFilter !== null && projects[selectedFilter]) {
    FileExplorer.setRootPath(projects[selectedFilter].path);
    api.explorer.watchDir(projects[selectedFilter].path);
  } else {
    FileExplorer.hide();
    api.explorer.stopWatch();
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
      <p>${t('closeDialog.whatToDo')}</p>
      <div class="close-dialog-options">
        <button class="close-option-btn" id="close-minimize">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
            <path d="M19 13H5v-2h14v2z"/>
          </svg>
          <span>${t('closeDialog.minimizeToTray')}</span>
          <small>${t('closeDialog.minimizeDesc')}</small>
        </button>
        <button class="close-option-btn close-option-quit" id="close-quit">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
          <span>${t('closeDialog.quitCompletely')}</span>
          <small>${t('closeDialog.quitDesc')}</small>
        </button>
      </div>
      <label class="close-dialog-remember">
        <input type="checkbox" id="close-remember">
        <span class="close-dialog-toggle"></span>
        <span class="close-dialog-remember-text">${t('closeDialog.rememberChoice')}</span>
      </label>
    </div>
  `;

  showModal(t('closeDialog.title'), content);

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
  toggleNotifications();
  const enabled = isNotificationsEnabled();
  document.getElementById('btn-notifications').classList.toggle('active', enabled);
};

document.getElementById('btn-settings').onclick = () => {
  const currentActive = document.querySelector('.nav-tab[data-tab].active');
  if (currentActive) _saveScrollPositions(currentActive.dataset.tab);
  SettingsPanel.switchToSettingsTab();
  setSetting('activeTab', 'settings');
};

// Sidebar collapse toggle
const sidebarEl = document.querySelector('.sidebar');
const btnCollapseSidebar = document.getElementById('btn-collapse-sidebar');
if (localStorage.getItem('sidebar-collapsed') === 'true') {
  sidebarEl.classList.add('collapsed');
}
btnCollapseSidebar.onclick = () => {
  sidebarEl.classList.toggle('collapsed');
  const isCollapsed = sidebarEl.classList.contains('collapsed');
  localStorage.setItem('sidebar-collapsed', isCollapsed);
  _applySidebarTooltips(isCollapsed);
};

// Toggle title ↔ data-tooltip for CSS tooltips in collapsed sidebar
function _applySidebarTooltips(isCollapsed) {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const els = sidebar.querySelectorAll('.nav-tab[data-tab], .settings-btn, .notification-toggle, #btn-more-tabs');
  els.forEach(el => {
    if (isCollapsed) {
      const label = el.title || el.querySelector('span:not(.more-tabs-badge)')?.textContent?.trim() || '';
      if (label) {
        el.dataset.tooltip = label;
        el.removeAttribute('title');
      }
    } else {
      if (el.dataset.tooltip) {
        el.title = el.dataset.tooltip;
        delete el.dataset.tooltip;
      }
    }
  });
}

// ========== TAB NAVIGATION ==========
// Scroll position preservation across tab switches
const _tabScrollPositions = new Map();

function _saveScrollPositions(tabId) {
  const panel = document.getElementById(`tab-${tabId}`);
  if (!panel) return;
  const entries = [];
  const save = (el) => {
    if (el.scrollTop || el.scrollLeft) {
      entries.push({ el, top: el.scrollTop, left: el.scrollLeft });
    }
  };
  save(panel);
  panel.querySelectorAll('*').forEach(save);
  if (entries.length) _tabScrollPositions.set(tabId, entries);
}

function _restoreScrollPositions(tabId) {
  const entries = _tabScrollPositions.get(tabId);
  if (!entries) return;
  requestAnimationFrame(() => {
    for (const { el, top, left } of entries) {
      if (el.isConnected) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
    }
  });
}

// Set ARIA roles on all nav-tabs (exclude More button which has its own role)
document.querySelectorAll('.nav-tab[data-tab]').forEach(tab => {
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
});

document.querySelectorAll('.nav-tab[data-tab]').forEach(tab => {
  tab.oncontextmenu = (e) => {
    const tabId = tab.dataset.tab;
    if (tabId === 'claude') return; // Claude is always pinned
    e.preventDefault();
    _showTabCtxMenu(e.clientX, e.clientY, tabId);
  };
  tab.onclick = () => {
    const tabId = tab.dataset.tab;
    // Save scroll positions of the currently active tab before switching
    const currentActive = document.querySelector('.nav-tab[data-tab].active');
    if (currentActive) _saveScrollPositions(currentActive.dataset.tab);

    document.querySelectorAll('.nav-tab[data-tab]').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById('btn-settings').classList.remove('active');
    document.getElementById('btn-more-tabs')?.classList.remove('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tabId}`).classList.add('active');
    if (tabId === 'plugins') PluginsPanel.loadPlugins();
    if (tabId === 'skills') SkillsAgentsPanel.loadSkills();
    if (tabId === 'agents') SkillsAgentsPanel.loadAgents();
    if (tabId === 'mcp') McpPanel.loadMcps();
    if (tabId === 'workflows') WorkflowPanel.load();
    if (tabId === 'tasks') ParallelTaskPanel.load();
    if (tabId === 'database') DatabasePanel.loadPanel();
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
    if (tabId === 'memory') MemoryEditor.loadMemory();
    if (tabId === 'connectivity') {
      const container = document.getElementById('tab-connectivity');
      if (container && !container.dataset.initialized) {
        container.innerHTML = ConnectivityPanel.buildHtml(settingsState.get());
        ConnectivityPanel.setupHandlers({
          settingsState,
          projectsState,
          saveSettings,
        });
        container.dataset.initialized = 'true';
      }
    }
    if (tabId !== 'connectivity') {
      ConnectivityPanel.cleanup();
    }
    // Cleanup TimeTrackingDashboard interval when leaving the tab
    if (tabId !== 'timetracking') {
      TimeTrackingDashboard.cleanup();
    }
    if (tabId === 'timetracking') {
      const container = document.getElementById('timetracking-container');
      if (container) TimeTrackingDashboard.init(container);
    }
    if (tabId === 'control-tower') {
      const root = document.getElementById('ct-panel-root');
      if (root) ControlTowerPanel.loadPanel(root);
    }
    if (tabId !== 'control-tower') {
      ControlTowerPanel.cleanup();
    }
    if (tabId === 'session-replay') {
      const container = document.getElementById('tab-session-replay');
      if (container && !container.dataset.initialized) {
        SessionReplayPanel.init(container, { projectsState, openedProjectId: projectsState.get().openedProjectId });
        container.dataset.initialized = 'true';
      }
    }
    if (tabId === 'workspace') {
      const root = document.getElementById('workspace-panel-root');
      if (root) WorkspacePanel.loadPanel(root);
    }
    if (tabId !== 'workspace') {
      WorkspacePanel.cleanup();
    }
    if (tabId === 'claude') {
      const activeId = terminalsState.get().activeTerminal;
      if (activeId) {
        const termData = terminalsState.get().terminals.get(activeId);
        if (termData?.fitAddon) termData.fitAddon.fit();
      }
    }
    // Restore scroll positions of the newly active tab
    _restoreScrollPositions(tabId);
    // Persist active tab for restart
    setSetting('activeTab', tabId);
  };
});

// ========== PINNED TABS SYSTEM ==========
const _ALL_TABS_ORDER = ['claude', 'git', 'database', 'mcp', 'plugins', 'skills', 'agents', 'workflows', 'tasks', 'control-tower', 'dashboard', 'timetracking', 'session-replay', 'memory', 'workspace', 'connectivity'];

function applyPinnedTabs() {
  const pinned = settingsState.get().pinnedTabs || _ALL_TABS_ORDER;
  let hiddenCount = 0;

  document.querySelectorAll('.nav-tab[data-tab]').forEach(tab => {
    const tabId = tab.dataset.tab;
    if (pinned.includes(tabId)) {
      tab.classList.remove('nav-tab--hidden');
    } else {
      tab.classList.add('nav-tab--hidden');
      hiddenCount++;
    }
  });

  _updateSeparatorVisibility();

  const moreBtn = document.getElementById('btn-more-tabs');
  const moreSep = document.getElementById('nav-separator-more');
  if (moreBtn) moreBtn.style.display = hiddenCount > 0 ? '' : 'none';
  if (moreSep) moreSep.style.display = hiddenCount > 0 ? '' : 'none';
  const badge = document.getElementById('more-tabs-badge');
  if (badge) badge.textContent = hiddenCount > 0 ? hiddenCount : '';
  // Update More button tooltip with hidden count
  if (moreBtn && hiddenCount > 0) {
    const label = t('ui.hiddenTabsCount', { count: hiddenCount });
    moreBtn.title = label;
    if (moreBtn.dataset.tooltip) moreBtn.dataset.tooltip = label;
  }
}

function _updateSeparatorVisibility() {
  const nav = document.querySelector('.nav-tabs');
  if (!nav) return;
  const children = [...nav.children];
  children.forEach((el, i) => {
    if (!el.classList.contains('nav-separator') || el.id === 'nav-separator-more') return;
    let hasVisible = false;
    for (let j = i + 1; j < children.length; j++) {
      const child = children[j];
      if (child.classList.contains('nav-separator')) break;
      if (child.classList.contains('nav-tab') && child.id !== 'btn-more-tabs' && !child.classList.contains('nav-tab--hidden')) {
        hasVisible = true;
        break;
      }
    }
    el.style.display = hasVisible ? '' : 'none';
  });
}

function _pinTab(tabId) {
  const current = settingsState.get().pinnedTabs || [..._ALL_TABS_ORDER];
  if (current.includes(tabId)) return;
  const newPinned = [...current];
  const insertIdx = _ALL_TABS_ORDER.indexOf(tabId);
  let insertAt = newPinned.length;
  for (let i = 0; i < newPinned.length; i++) {
    if (_ALL_TABS_ORDER.indexOf(newPinned[i]) > insertIdx) { insertAt = i; break; }
  }
  newPinned.splice(insertAt, 0, tabId);
  setSetting('pinnedTabs', newPinned);
  applyPinnedTabs();
  _closeMoreDropdown();
}

function _unpinTab(tabId) {
  if (tabId === 'claude') return;
  const newPinned = (settingsState.get().pinnedTabs || [..._ALL_TABS_ORDER]).filter(t => t !== tabId);
  // If unpinned tab is currently active, switch to claude
  const activeTab = document.querySelector('.nav-tab.active');
  if (activeTab?.dataset.tab === tabId) {
    document.querySelector('[data-tab="claude"]')?.click();
  }
  setSetting('pinnedTabs', newPinned);
  applyPinnedTabs();
}

// ── Sidebar drag & drop ──────────────────────────────────────────────
function _applyTabsOrder() {
  const order = settingsState.get().tabsOrder;
  if (!order || !order.length) return;
  const nav = document.querySelector('.nav-tabs');
  const moreSep = document.getElementById('nav-separator-more');
  if (!nav || !moreSep) return;
  // Re-insert tabs in saved order, before the "more" separator
  order.slice().reverse().forEach(tabId => {
    const tab = nav.querySelector(`.nav-tab[data-tab="${tabId}"]`);
    if (tab) nav.insertBefore(tab, moreSep);
  });
}

function _saveTabsOrder() {
  const nav = document.querySelector('.nav-tabs');
  if (!nav) return;
  const order = [...nav.querySelectorAll('.nav-tab[data-tab]:not(#btn-more-tabs)')]
    .map(t => t.dataset.tab);
  setSetting('tabsOrder', order);
}

function _reorderTab(draggedId, targetId, position) {
  const nav = document.querySelector('.nav-tabs');
  const dragged = nav.querySelector(`.nav-tab[data-tab="${draggedId}"]`);
  const target = nav.querySelector(`.nav-tab[data-tab="${targetId}"]`);
  if (!dragged || !target) return;
  if (position === 'after') {
    target.after(dragged);
  } else {
    target.before(dragged);
  }
  _updateSeparatorVisibility();
  _saveTabsOrder();
}

function _initSidebarDragDrop() {
  const nav = document.querySelector('.nav-tabs');
  if (!nav) return;
  let draggedId = null;
  let indicator = null;

  // Add drag handle on each tab
  nav.querySelectorAll('.nav-tab[data-tab]').forEach(tab => {
    if (tab.id === 'btn-more-tabs') return;
    if (tab.querySelector('.nav-tab-drag-handle')) return; // already added
    const handle = document.createElement('span');
    handle.className = 'nav-tab-drag-handle';
    handle.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
      <path d="M9 3h2v2H9zm4 0h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2z"/>
    </svg>`;
    handle.addEventListener('mousedown', () => { tab.draggable = true; });
    document.addEventListener('mouseup', () => { tab.draggable = false; }, { once: true });
    tab.prepend(handle);
  });

  nav.addEventListener('dragstart', e => {
    const tab = e.target.closest('.nav-tab[data-tab]');
    if (!tab || tab.id === 'btn-more-tabs') { e.preventDefault(); return; }
    draggedId = tab.dataset.tab;
    tab.classList.add('nav-tab--dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  nav.addEventListener('dragend', () => {
    nav.querySelectorAll('.nav-tab[data-tab]').forEach(t => {
      t.classList.remove('nav-tab--dragging');
      t.draggable = false;
    });
    indicator?.remove(); indicator = null; draggedId = null;
  });

  nav.addEventListener('dragover', e => {
    if (!draggedId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.nav-tab[data-tab]');
    if (!target || target.id === 'btn-more-tabs' || target.dataset.tab === draggedId) {
      indicator?.remove(); indicator = null; return;
    }
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.className = 'nav-tab-drop-indicator';
      nav.appendChild(indicator);
    }
    const navRect = nav.getBoundingClientRect();
    indicator.style.top = (after ? rect.bottom : rect.top) - navRect.top - nav.scrollTop + 'px';
  });

  nav.addEventListener('drop', e => {
    if (!draggedId) return;
    e.preventDefault();
    indicator?.remove(); indicator = null;
    const target = e.target.closest('.nav-tab[data-tab]');
    if (!target || target.id === 'btn-more-tabs') return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    _reorderTab(draggedId, target.dataset.tab, after ? 'after' : 'before');
  });
}

function _openCustomizeModal() {
  _closeMoreDropdown();

  const allTabs = _ALL_TABS_ORDER.map(id => {
    const el = document.querySelector(`.nav-tab[data-tab="${id}"]`);
    return {
      id,
      label: el?.querySelector('span')?.textContent?.trim() || id,
      svg: el?.querySelector('svg')?.outerHTML || '',
      locked: id === 'claude',
    };
  });

  const pinned = new Set(settingsState.get().pinnedTabs || _ALL_TABS_ORDER);
  const order = settingsState.get().tabsOrder || _ALL_TABS_ORDER;
  // Build ordered list: first tabs in saved order, then any missing ones
  const ordered = [
    ...order.map(id => allTabs.find(t => t.id === id)).filter(Boolean),
    ...allTabs.filter(t => !order.includes(t.id)),
  ];

  const content = `
    <div class="sc-list" id="sc-tab-list">
      ${ordered.map(tab => `
        <div class="sc-item" data-sc-id="${tab.id}" draggable="true">
          <span class="sc-drag-handle" title="${t('ui.sidebarDragHandle')}">⠿</span>
          <span class="sc-icon">${tab.svg}</span>
          <span class="sc-label">${tab.label}</span>
          <label class="settings-toggle${tab.locked ? ' sc-locked' : ''}">
            <input type="checkbox" data-sc-toggle="${tab.id}" ${pinned.has(tab.id) ? 'checked' : ''} ${tab.locked ? 'disabled' : ''}>
            <span class="settings-toggle-slider"></span>
          </label>
        </div>
      `).join('')}
    </div>
    <p class="sc-hint">${t('ui.sidebarDragHint')}</p>
  `;

  const footer = `
    <button class="btn btn-ghost" id="sc-reset-btn">${t('ui.sidebarReset')}</button>
    <button class="btn btn-primary" id="sc-close-btn">${t('common.close')}</button>
  `;

  document.getElementById('modal-title').textContent = t('ui.sidebarCustomize');
  showModal(t('ui.sidebarCustomize'), content, footer);

  document.getElementById('sc-close-btn').onclick = () => closeModal();
  document.getElementById('sc-reset-btn').onclick = () => {
    setSetting('pinnedTabs', [..._ALL_TABS_ORDER]);
    setSetting('tabsOrder', null);
    applyPinnedTabs();
    closeModal();
  };

  // Live toggle handlers
  document.querySelectorAll('[data-sc-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.scToggle;
      if (cb.checked) _pinTab(id); else _unpinTab(id);
    });
  });

  _initCustomizeModalDragDrop();
}

function _initCustomizeModalDragDrop() {
  const list = document.getElementById('sc-tab-list');
  if (!list) return;
  let draggedId = null;

  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.sc-item');
    if (!item) return;
    draggedId = item.dataset.scId;
    item.classList.add('sc-item--dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragend', () => {
    list.querySelectorAll('.sc-item').forEach(el => {
      el.classList.remove('sc-item--dragging', 'sc-item--drag-over-before', 'sc-item--drag-over-after');
    });
    draggedId = null;
  });

  list.addEventListener('dragover', e => {
    if (!draggedId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.sc-item');
    list.querySelectorAll('.sc-item').forEach(el => {
      el.classList.remove('sc-item--drag-over-before', 'sc-item--drag-over-after');
    });
    if (!target || target.dataset.scId === draggedId) return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    target.classList.add(after ? 'sc-item--drag-over-after' : 'sc-item--drag-over-before');
  });

  list.addEventListener('drop', e => {
    if (!draggedId) return;
    e.preventDefault();
    list.querySelectorAll('.sc-item').forEach(el => {
      el.classList.remove('sc-item--drag-over-before', 'sc-item--drag-over-after');
    });
    const target = e.target.closest('.sc-item');
    if (!target || target.dataset.scId === draggedId) return;
    const dragged = list.querySelector(`.sc-item[data-sc-id="${draggedId}"]`);
    if (!dragged) return;
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    if (after) target.after(dragged); else target.before(dragged);
    // Save new order from modal to tabsOrder + apply to sidebar
    const newOrder = [...list.querySelectorAll('.sc-item')].map(el => el.dataset.scId);
    setSetting('tabsOrder', newOrder);
    _applyTabsOrder();
    _updateSeparatorVisibility();
  });
}

function _buildMoreDropdown() {
  const pinned = settingsState.get().pinnedTabs || _ALL_TABS_ORDER;
  const unpinned = _ALL_TABS_ORDER.filter(id => !pinned.includes(id));
  const dropdown = document.getElementById('more-tabs-dropdown');
  if (!dropdown) return;

  dropdown.innerHTML = unpinned.map(tabId => {
    const tab = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
    if (!tab) return '';
    const svg = tab.querySelector('svg')?.outerHTML || '';
    const label = tab.querySelector('span')?.textContent?.trim() || tabId;
    return `
      <button class="nav-tab" data-more-tab="${tabId}" role="menuitem">
        ${svg}
        <span>${label}</span>
        <span class="more-pin-btn" title="${t('ui.sidebarPinToBar')}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
        </span>
      </button>`;
  }).join('');

  dropdown.querySelectorAll('[data-more-tab]').forEach(item => {
    item.onclick = (e) => {
      const tabId = item.dataset.moreTab;
      if (e.target.closest('.more-pin-btn')) {
        _pinTab(tabId);
        return;
      }
      // Navigate to the hidden tab (click works even on hidden elements)
      const hiddenTab = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
      if (hiddenTab) hiddenTab.click();
      // Mark More button as active (visual feedback that active tab is in overflow)
      document.getElementById('btn-more-tabs')?.classList.add('active');
      _closeMoreDropdown();
    };
  });

  // Customize option at the bottom
  const customizeBtn = document.createElement('button');
  customizeBtn.className = 'nav-tab more-customize-btn';
  customizeBtn.role = 'menuitem';
  customizeBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
    <span>${t('ui.sidebarCustomizeEllipsis')}</span>
  `;
  customizeBtn.onclick = () => _openCustomizeModal();
  dropdown.appendChild(customizeBtn);
}

function _openMoreDropdown() {
  const btn = document.getElementById('btn-more-tabs');
  const dropdown = document.getElementById('more-tabs-dropdown');
  if (!btn || !dropdown) return;
  _buildMoreDropdown();
  const rect = btn.getBoundingClientRect();
  dropdown.style.display = 'flex';
  // Position to the right of the sidebar
  dropdown.style.left = (rect.right + 8) + 'px';
  dropdown.style.top = rect.top + 'px';
  // Clamp vertically if overflow
  requestAnimationFrame(() => {
    const dropH = dropdown.offsetHeight;
    const viewH = window.innerHeight;
    if (rect.top + dropH > viewH - 8) {
      dropdown.style.top = Math.max(8, viewH - dropH - 8) + 'px';
    }
  });
}

function _closeMoreDropdown() {
  const dropdown = document.getElementById('more-tabs-dropdown');
  if (dropdown) dropdown.style.display = 'none';
}

function _showTabCtxMenu(x, y, tabId) {
  _closeMoreDropdown();
  const existing = document.getElementById('_tab-ctx-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = '_tab-ctx-menu';
  menu.className = 'tab-ctx-menu';
  menu.style.top = y + 'px';
  menu.style.left = x + 'px';
  menu.innerHTML = `
    <button class="tab-ctx-menu-item" id="_tab-ctx-unpin">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
      ${t('ui.sidebarHideFromBar')}
    </button>
    <button class="tab-ctx-menu-item" id="_tab-ctx-customize">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
      ${t('ui.sidebarCustomizeBar')}
    </button>`;
  document.body.appendChild(menu);
  document.getElementById('_tab-ctx-unpin').onclick = () => { _unpinTab(tabId); menu.remove(); };
  document.getElementById('_tab-ctx-customize').onclick = () => { menu.remove(); _openCustomizeModal(); };
  // Clamp to viewport
  requestAnimationFrame(() => {
    const mRect = menu.getBoundingClientRect();
    if (mRect.right > window.innerWidth) menu.style.left = (window.innerWidth - mRect.width - 8) + 'px';
    if (mRect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - mRect.height - 8) + 'px';
  });
  const closeOutside = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeOutside, true); } };
  setTimeout(() => document.addEventListener('click', closeOutside, true), 0);
}

// More button click handler
document.getElementById('btn-more-tabs')?.addEventListener('click', () => {
  const dropdown = document.getElementById('more-tabs-dropdown');
  if (dropdown?.style.display === 'none' || !dropdown?.style.display) {
    _openMoreDropdown();
  } else {
    _closeMoreDropdown();
  }
});

// Close More dropdown on outside click
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('more-tabs-dropdown');
  const moreBtn = document.getElementById('btn-more-tabs');
  if (dropdown?.style.display !== 'none' && !dropdown?.contains(e.target) && !moreBtn?.contains(e.target)) {
    _closeMoreDropdown();
  }
}, true);

// ========== CONTEXT MENU ==========
function setupContextMenuHandlers() {
  const list = document.getElementById('projects-list');

  list.addEventListener('contextmenu', (e) => {
    const projectItem = e.target.closest('.project-item');

    // Project right-clicks are handled by ProjectList.js oncontextmenu — skip here
    if (projectItem) return;

    const folderHeader = e.target.closest('.folder-header');
    if (folderHeader) {
      const folderItem = folderHeader.closest('.folder-item');
      if (folderItem) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenuForFolder(e.clientX, e.clientY, folderItem.dataset.folderId);
      }
    } else if (e.target === list || e.target.classList.contains('drop-zone-root')) {
      e.preventDefault();
      showContextMenuEmpty(e.clientX, e.clientY);
    }
  });
}

function showContextMenuForFolder(x, y, folderId) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = `
    <div class="context-menu-item" data-action="new-subfolder">${t('contextMenu.newSubfolder')}</div>
    <div class="context-menu-item" data-action="new-project">${t('contextMenu.newProject')}</div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item" data-action="customize">${t('contextMenu.customize')}</div>
    <div class="context-menu-item" data-action="rename">${t('contextMenu.rename')}</div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" data-action="delete">${t('contextMenu.deleteFolder')}</div>`;
  showContextMenuAt(menu, x, y, { type: 'folder', id: folderId });
}

function showContextMenuForProject(x, y, projectId) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = `
    <div class="context-menu-item" data-action="move-to-root">${t('contextMenu.moveToRoot')}</div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger" data-action="delete">${t('contextMenu.delete')}</div>`;
  showContextMenuAt(menu, x, y, { type: 'project', id: projectId });
}

function showContextMenuEmpty(x, y) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = `
    <div class="context-menu-item" data-action="new-folder">${t('contextMenu.newFolder')}</div>
    <div class="context-menu-item" data-action="new-project">${t('contextMenu.newProject')}</div>`;
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
        ModalComponent.showConfirm({
          title: t('projects.deleteFolder'),
          message: t('projects.confirmDeleteFolder'),
          confirmLabel: t('common.delete'),
          danger: true
        }).then(confirmed => {
          if (confirmed) {
            deleteFolder(contextTarget.id);
            ProjectList.render();
          }
        });
      } else if (contextTarget.type === 'project') {
        deleteProjectUI(contextTarget.id);
      }
      break;
    case 'customize':
      if (contextTarget.type === 'folder') {
        const folder = getFolder(contextTarget.id);
        if (folder) {
          const btn = document.querySelector(`.folder-item[data-folder-id="${contextTarget.id}"] .btn-folder-color`);
          if (btn) btn.click();
        }
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
  const name = await showInputModal(t('dialog.folderName'));
  if (name && name.trim()) {
    createFolder(name.trim(), parentId);
    ProjectList.render();
  }
}

async function promptRenameFolder(folderId) {
  const folder = getFolder(folderId);
  if (!folder) return;
  const name = await showInputModal(t('dialog.newName'), folder.name);
  if (name && name.trim()) {
    renameFolder(folderId, name.trim());
    ProjectList.render();
  }
}

async function renameProjectUI(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const oldName = project.name;
  const name = await showInputModal(t('dialog.newProjectName'), project.name);
  if (name && name.trim()) {
    const newName = name.trim();
    renameProject(projectId, newName);

    // Propagate displayName to cloud (fire-and-forget)
    if (cloudConnected && cloudUploadStatus.get(project.id)?.synced) {
      api.cloud.updateDisplayName({ projectId: project.id, displayName: newName }).catch(err => {
        console.warn('[Cloud] Failed to update display name:', err.message);
      });
    }

    // Propagate rename to terminal tabs that still use the old project name
    const projectIndex = getProjectIndex(projectId);
    const terminals = terminalsState.get().terminals;
    terminals.forEach((term, id) => {
      if (term.projectIndex === projectIndex && term.name === oldName) {
        TerminalManager.updateTerminalTabName(id, newName);
      }
    });

    ProjectList.render();
  }
}

// ========== SETTINGS TAB (extracted to SettingsPanel module) ==========

document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal-overlay').onclick = (e) => { if (e.target.id === 'modal-overlay') closeModal(); };

// ========== SKILLS & AGENTS (extracted to SkillsAgentsPanel module) ==========
// ========== PLUGINS (extracted to PluginsPanel module) ==========
// ========== MARKETPLACE (extracted to MarketplacePanel module) ==========
// ========== MCP (extracted to McpPanel module) ==========
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
    onCopyPath: () => {},
    onTaskSessionOpen: async (proj, sessionId) => {
      const switchToClaude = () => {
        document.querySelector('[data-tab="claude"]')?.click();
        setSelectedProjectFilter(projectIndex);
        ProjectList.render();
        TerminalManager.filterByProject(projectIndex);
      };
      const terms = terminalsState.get().terminals;
      for (const [id, td] of terms) {
        if (td.claudeSessionId === sessionId) {
          switchToClaude();
          TerminalManager.setActiveTerminal(id);
          return;
        }
      }
      await TerminalManager.resumeSession(proj, sessionId, { skipPermissions: settingsState.get().skipPermissions });
      switchToClaude();
    },
    onTaskRender: () => { renderDashboardContent(projectIndex); }
  });
}

// ========== NEW PROJECT ==========
document.getElementById('btn-new-project').onclick = () => {
  const projectTypes = registry.getAll();
  const categoriesGrouped = registry.getByCategory();

  let typeIndex = 0;
  const typeColors = { standalone: 'var(--accent)', webapp: '#3b82f6', python: '#3776ab', api: '#a855f7', fivem: 'var(--success)', discord: '#5865F2' };
  const buildTypeRows = () => categoriesGrouped.map(({ category: cat, types }) => `
      <div class="wizard-type-category">${t(cat.nameKey)}</div>
      <div class="wizard-type-grid">
      ${types.map(tp => {
        const idx = typeIndex++;
        const color = typeColors[tp.id] || 'var(--accent)';
        return `
        <div class="wizard-type-card${tp.id === 'standalone' ? ' selected' : ''}" data-type="${tp.id}" style="animation-delay:${idx * 60}ms; --type-color: ${color}">
          <div class="wizard-type-card-icon">${tp.icon}</div>
          <span class="wizard-type-card-name">${t(tp.nameKey)}</span>
        </div>`;
      }).join('')}
      </div>
    `).join('');

  showModal(t('newProject.title'), `
    <form id="form-project" class="wizard-form">
      <div class="wizard-progress"><div class="wizard-progress-fill" id="wizard-progress-fill"></div></div>

      <div class="wizard-step active" data-step="1">
        <div class="wizard-type-list">
          ${buildTypeRows()}
        </div>
        <div class="wizard-actions">
          <button type="button" class="wizard-btn-secondary" id="btn-cancel-wizard">${t('common.cancel')}</button>
          <button type="button" class="wizard-btn-primary" id="btn-next-step">
            <span>${t('newProject.next')}</span>
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          </button>
        </div>
      </div>

      <div class="wizard-step" data-step="2">
        <div class="wizard-step2-header">
          <div class="wizard-type-badge" id="wizard-type-badge"></div>
          <div class="wizard-source-selector">
            <button type="button" class="wizard-source-btn selected" data-source="folder">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
              <span>${t('newProject.sourceFolder')}</span>
            </button>
            <button type="button" class="wizard-source-btn" data-source="create">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              <span>${t('newProject.sourceCreate')}</span>
            </button>
            <button type="button" class="wizard-source-btn" data-source="clone">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>
              <span>${t('newProject.sourceClone')}</span>
            </button>
            <button type="button" class="wizard-source-btn wizard-source-scaffold" data-source="scaffold" style="display: none;">
              <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>
              <span>${t('newProject.sourceScaffold')}</span>
            </button>
          </div>
        </div>

        <div class="wizard-fields-group">
          <div class="wizard-field clone-config" style="display: none;">
            <label class="wizard-label">${t('newProject.repoUrl')}</label>
            <div class="clone-input-wrapper">
              <svg class="clone-input-icon" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
              <input type="text" class="wizard-input clone-url-input" id="inp-repo-url" placeholder="${t('newProject.repoSearchPlaceholder')}">
            </div>
            <div class="github-status-hint" id="github-status-hint"></div>
            <div class="github-repo-list" id="github-repo-list" style="display: none;"></div>
          </div>
          ${(() => { try { return registry.get('webapp').getTemplateGridHtml ? registry.get('webapp').getTemplateGridHtml(t) : ''; } catch(_) { return ''; } })()}
          <div class="wizard-field">
            <label class="wizard-label">${t('newProject.projectName')}</label>
            <input type="text" class="wizard-input" id="inp-name" placeholder="${t('newProject.projectNamePlaceholder')}" required>
          </div>
          <div class="wizard-field">
            <label class="wizard-label" id="label-path">${t('newProject.projectPath')}</label>
            <div class="wizard-input-row">
              <input type="text" class="wizard-input" id="inp-path" placeholder="${t('newProject.projectFolderPlaceholder')}" required>
              <button type="button" class="wizard-browse-btn" id="btn-browse">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
              </button>
            </div>
            <div class="detection-hint" id="detection-hint"></div>
          </div>
          <div class="wizard-field create-git-config" style="display: none;">
            <label class="wizard-checkbox">
              <input type="checkbox" id="chk-init-git" checked>
              <span class="wizard-checkbox-mark"></span>
              <span>${t('newProject.initGit')}</span>
            </label>
          </div>
          <div class="type-specific-fields">${projectTypes.map(tp => tp.getWizardFields()).filter(Boolean).join('')}</div>
        </div>

        <div class="wizard-field clone-status" style="display: none;">
          <div class="clone-progress">
            <span class="clone-progress-text">${t('newProject.cloning')}</span>
            <div class="clone-progress-bar"><div class="clone-progress-fill"></div></div>
          </div>
        </div>
        <div class="wizard-actions">
          <button type="button" class="wizard-btn-secondary" id="btn-prev-step">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            <span>${t('newProject.back')}</span>
          </button>
          <button type="submit" class="wizard-btn-primary" id="btn-create-project">
            <span>${t('newProject.create')}</span>
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          </button>
        </div>
      </div>
    </form>
  `);

  let selectedType = 'standalone';
  let selectedSource = 'folder';
  let selectedTemplate = null;
  let githubConnected = false;

  // Wizard navigation
  function goToStep(step) {
    document.querySelectorAll('.wizard-step').forEach(s => s.classList.remove('active'));
    document.querySelector(`.wizard-step[data-step="${step}"]`).classList.add('active');
    // Update progress bar
    const fill = document.getElementById('wizard-progress-fill');
    if (fill) fill.style.width = step === 1 ? '50%' : '100%';
    if (step === 2) {
      const tp = registry.get(selectedType);
      const color = typeColors[selectedType] || 'var(--accent)';
      const form = document.getElementById('form-project');
      // Propagate type color to step 2
      form.style.setProperty('--type-color', color);
      const badge = document.getElementById('wizard-type-badge');
      if (tp && badge) {
        badge.innerHTML = `<span class="wizard-type-badge-icon">${tp.icon}</span><span class="wizard-type-badge-name">${t(tp.nameKey)}</span>`;
      }
      // Update progress bar color
      const fill = document.getElementById('wizard-progress-fill');
      if (fill) fill.style.background = color;
      // Show/hide scaffold source button based on type
      const scaffoldBtn = document.querySelector('.wizard-source-scaffold');
      if (scaffoldBtn) {
        scaffoldBtn.style.display = selectedType === 'webapp' ? '' : 'none';
        // Reset to folder if was on scaffold and type changed
        if (selectedSource === 'scaffold' && selectedType !== 'webapp') {
          const folderBtn = document.querySelector('.wizard-source-btn[data-source="folder"]');
          if (folderBtn) folderBtn.click();
        }
      }
      // Show/hide type-specific config fields
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

  document.getElementById('btn-cancel-wizard').onclick = () => closeModal();
  document.getElementById('btn-next-step').onclick = () => goToStep(2);
  document.getElementById('btn-prev-step').onclick = () => goToStep(1);

  // Type selection (step 1)
  document.querySelectorAll('.wizard-type-card').forEach(row => {
    row.onclick = () => {
      document.querySelectorAll('.wizard-type-card').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      selectedType = row.dataset.type;
    };
  });

  // Check GitHub auth status and load repos
  let repoSearchTimeout = null;
  let reposLoaded = false;

  async function updateGitHubHint() {
    const hintEl = document.getElementById('github-status-hint');
    const repoListEl = document.getElementById('github-repo-list');
    if (!hintEl) return;

    try {
      const result = await api.github.authStatus();
      githubConnected = result.authenticated;
      if (result.authenticated) {
        hintEl.innerHTML = `<span class="hint-success"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> ${t('newProject.githubConnected', { login: result.login })}</span>`;
        // Auto-load repos
        if (repoListEl && !reposLoaded) {
          loadGitHubRepos();
        }
      } else {
        hintEl.innerHTML = `<span class="hint-warning"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> ${t('newProject.githubPrivateUnavailable')} - <a href="#" id="link-github-settings">${t('settings.githubConnect')}</a></span>`;
        if (repoListEl) repoListEl.style.display = 'none';
        document.getElementById('link-github-settings')?.addEventListener('click', (e) => {
          e.preventDefault();
          closeModal();
          SettingsPanel.switchToSettingsTab('github');
        });
      }
    } catch (e) {
      hintEl.innerHTML = '';
    }
  }

  function isUrl(text) {
    return /^(https?:\/\/|git@)/.test(text.trim());
  }

  function formatRepoDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return t('common.today') || 'Today';
    if (diffDays === 1) return t('common.yesterday') || 'Yesterday';
    if (diffDays < 30) return `${diffDays}d`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
    return `${Math.floor(diffDays / 365)}y`;
  }

  function renderRepoList(repos) {
    const repoListEl = document.getElementById('github-repo-list');
    if (!repoListEl) return;

    if (!repos || repos.length === 0) {
      repoListEl.innerHTML = `<div class="github-repo-empty">${t('newProject.noReposFound')}</div>`;
      repoListEl.style.display = 'block';
      return;
    }

    repoListEl.innerHTML = repos.map(repo => `
      <div class="github-repo-item" data-clone-url="${repo.cloneUrl}" data-name="${repo.name}">
        <div class="github-repo-item-top">
          <span class="repo-name">${repo.name}</span>
          <span class="repo-visibility ${repo.private ? 'private' : 'public'}">${repo.private ? t('newProject.repoPrivate') : t('newProject.repoPublic')}</span>
        </div>
        <div class="repo-meta">
          <span class="repo-owner">${repo.owner}</span>
          ${repo.language ? `<span class="repo-lang">${repo.language}</span>` : ''}
          <span class="repo-date">${formatRepoDate(repo.updatedAt)}</span>
        </div>
      </div>
    `).join('');
    repoListEl.style.display = 'block';

    // Bind click handlers
    repoListEl.querySelectorAll('.github-repo-item').forEach(item => {
      item.onclick = () => {
        const cloneUrl = item.dataset.cloneUrl;
        const repoName = item.dataset.name;
        const urlInput = document.getElementById('inp-repo-url');
        const nameInput = document.getElementById('inp-name');
        if (urlInput) urlInput.value = cloneUrl;
        if (nameInput && !nameInput.value) nameInput.value = repoName;
        repoListEl.style.display = 'none';
      };
    });
  }

  async function loadGitHubRepos(query) {
    const repoListEl = document.getElementById('github-repo-list');
    if (!repoListEl || !githubConnected) return;

    repoListEl.innerHTML = `<div class="github-repo-loading"><span class="btn-spinner"></span> ${t('newProject.loadingRepos')}</div>`;
    repoListEl.style.display = 'block';

    try {
      const result = await api.github.listRepos({ query, perPage: 20 });
      if (result.success && result.repos) {
        reposLoaded = true;
        renderRepoList(result.repos);
      } else {
        repoListEl.innerHTML = `<div class="github-repo-empty">${result.error || t('newProject.noReposFound')}</div>`;
      }
    } catch (e) {
      repoListEl.innerHTML = `<div class="github-repo-empty">${e.message}</div>`;
    }
  }

  // Source selector (folder vs clone vs scaffold)
  document.querySelectorAll('.wizard-source-btn').forEach(opt => {
    opt.onclick = () => {
      document.querySelectorAll('.wizard-source-btn').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedSource = opt.dataset.source;
      const isClone = selectedSource === 'clone';
      const isCreate = selectedSource === 'create';
      const isScaffold = selectedSource === 'scaffold';
      document.querySelector('.clone-config').style.display = isClone ? 'block' : 'none';
      document.querySelector('.create-git-config').style.display = isCreate ? 'block' : 'none';
      const scaffoldEl = document.querySelector('.scaffold-templates');
      if (scaffoldEl) scaffoldEl.style.display = isScaffold ? 'block' : 'none';
      // Clear detection hint when switching sources
      const detectionHint = document.getElementById('detection-hint');
      if (detectionHint) detectionHint.innerHTML = '';
      if (isClone) {
        document.getElementById('label-path').textContent = t('newProject.destFolder');
        document.getElementById('inp-path').placeholder = t('newProject.destFolderPlaceholder');
        updateGitHubHint();
      } else if (isCreate || isScaffold) {
        document.getElementById('label-path').textContent = t('newProject.parentFolder');
        document.getElementById('inp-path').placeholder = t('newProject.parentFolderPlaceholder');
      } else {
        document.getElementById('label-path').textContent = t('newProject.projectPath');
        document.getElementById('inp-path').placeholder = t('newProject.projectFolderPlaceholder');
      }
      // Reset template selection when switching away from scaffold
      if (!isScaffold) selectedTemplate = null;
    };
  });

  // Scaffold template selection
  document.querySelectorAll('.scaffold-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('.scaffold-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedTemplate = card.dataset.template;
    };
  });

  // Auto-fill name from repo URL + search repos
  document.getElementById('inp-repo-url')?.addEventListener('input', (e) => {
    const value = e.target.value.trim();

    if (isUrl(value)) {
      // It's a URL - extract repo name and hide repo list
      if (!document.getElementById('inp-name').value) {
        const match = value.match(/\/([^\/]+?)(\.git)?$/);
        if (match) document.getElementById('inp-name').value = match[1];
      }
      const repoListEl = document.getElementById('github-repo-list');
      if (repoListEl) repoListEl.style.display = 'none';
    } else if (githubConnected) {
      // It's a search query - debounce and search repos
      clearTimeout(repoSearchTimeout);
      repoSearchTimeout = setTimeout(() => {
        loadGitHubRepos(value || undefined);
      }, 300);
    }
  });

  // Show repo list on focus when input is empty
  document.getElementById('inp-repo-url')?.addEventListener('focus', () => {
    const value = document.getElementById('inp-repo-url').value.trim();
    if (!isUrl(value) && githubConnected) {
      const repoListEl = document.getElementById('github-repo-list');
      if (repoListEl && repoListEl.children.length > 0) {
        repoListEl.style.display = 'block';
      } else if (!reposLoaded) {
        loadGitHubRepos();
      }
    }
  });

  document.getElementById('btn-browse').onclick = async () => {
    const folder = await api.dialog.selectFolder();
    if (folder) {
      document.getElementById('inp-path').value = folder;
      if (!document.getElementById('inp-name').value && selectedSource === 'folder') {
        document.getElementById('inp-name').value = path.basename(folder);
      }
      // Auto-detect framework for webapp type on folder source
      if (selectedSource === 'folder' && selectedType === 'webapp') {
        const detectionHint = document.getElementById('detection-hint');
        if (detectionHint) {
          try {
            const pkgPath = path.join(folder, 'package.json');
            if (await fileExists(pkgPath)) {
              const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
              const webappType = registry.get('webapp');
              const detected = webappType.detectFramework ? webappType.detectFramework(pkg) : null;
              if (detected) {
                detectionHint.innerHTML = `<span class="detection-badge"><span>${detected.icon}</span> ${t('newProject.detectedFramework', { framework: detected.name + (detected.version ? ' ' + detected.version : '') })}</span>`;
              } else {
                detectionHint.innerHTML = '';
              }
            } else {
              detectionHint.innerHTML = '';
            }
          } catch (_) {
            detectionHint.innerHTML = '';
          }
        }
      }
    }
  };

  document.getElementById('form-project').onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('inp-name').value.trim();
    let projPath = document.getElementById('inp-path').value.trim();
    const repoUrl = document.getElementById('inp-repo-url')?.value.trim();

    if (!name || !projPath) return;

    // Disable submit button to prevent double-click (BUG 5)
    const submitBtn = document.getElementById('btn-create-project');
    submitBtn.disabled = true;

    // Track whether we created a new directory (for cleanup on failure)
    let createdDir = null;

    // If using existing folder, ensure the directory exists
    if (selectedSource === 'folder') {
      if (!(await fileExists(projPath))) {
        try {
          await fsp.mkdir(projPath, { recursive: true });
          createdDir = projPath;
        } catch (err) {
          showToast(t('newProject.unableToCreateFolder', { error: err.message }), 'error');
          submitBtn.disabled = false;
          return;
        }
      }
    }

    // If creating new, create the directory
    if (selectedSource === 'create') {
      projPath = path.join(projPath, name);
      try {
        if (await fileExists(projPath)) {
          showToast(t('newProject.folderAlreadyExists'), 'error');
          submitBtn.disabled = false;
          return;
        }
        await fsp.mkdir(projPath, { recursive: true });
        createdDir = projPath;

        // Init git repo if checked
        if (document.getElementById('chk-init-git')?.checked) {
          const { execSync } = window.electron_nodeModules.child_process;
          try {
            execSync('git init', { cwd: projPath, stdio: 'ignore' });
            await fsp.writeFile(path.join(projPath, '.gitignore'), [
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
            showToast(t('newProject.folderCreatedGitInitError', { error: gitErr.message }), 'error');
          }
        }
      } catch (err) {
        showToast(t('newProject.unableToCreateFolder', { error: err.message }), 'error');
        submitBtn.disabled = false;
        return;
      }
    }

    // If cloning, append project name to path and clone
    if (selectedSource === 'clone' && repoUrl) {
      projPath = path.join(projPath, name);

      // Show progress
      const cloneStatus = document.querySelector('.clone-status');
      submitBtn.innerHTML = `<span class="btn-spinner"></span> ${t('newProject.cloning')}`;
      cloneStatus.style.display = 'block';

      try {
        const result = await api.git.clone({ repoUrl, targetPath: projPath });

        if (!result.success) {
          // Clean up partial clone directory (BUG 3)
          try { if (await fileExists(projPath)) await fsp.rm(projPath, { recursive: true, force: true }); } catch (_) {}
          cloneStatus.innerHTML = `<div class="clone-error">${result.error}</div>`;
          submitBtn.disabled = false;
          submitBtn.textContent = t('newProject.create');
          return;
        }
        createdDir = projPath;
      } catch (err) {
        // Clean up partial clone directory (BUG 3)
        try { if (await fileExists(projPath)) await fsp.rm(projPath, { recursive: true, force: true }); } catch (_) {}
        cloneStatus.innerHTML = `<div class="clone-error">${err.message}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = t('newProject.create');
        return;
      }
    }

    // If scaffolding, run the scaffold command
    if (selectedSource === 'scaffold' && selectedTemplate) {
      projPath = path.join(projPath, name);
      submitBtn.innerHTML = `<span class="btn-spinner"></span> ${t('newProject.scaffolding')}`;

      try {
        if (await fileExists(projPath)) {
          showToast(t('newProject.folderAlreadyExists'), 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = t('newProject.create');
          return;
        }
        const webappType = registry.get('webapp');
        const templates = webappType.getScaffoldTemplates ? webappType.getScaffoldTemplates() : [];
        const tpl = templates.find(t => t.id === selectedTemplate);
        if (!tpl) {
          showToast({ type: 'error', title: t('newProject.unknownTemplate', { id: selectedTemplate }) });
          submitBtn.disabled = false;
          submitBtn.textContent = t('newProject.create');
          return;
        }
        const { execSync } = window.electron_nodeModules.child_process;
        execSync(tpl.cmd(name), {
          cwd: path.dirname(projPath),
          stdio: 'ignore',
          timeout: 120000,
          env: { ...process.env, npm_config_yes: 'true' }
        });
        createdDir = projPath;
        // Force type to webapp for scaffold
        selectedType = 'webapp';
      } catch (err) {
        // Clean up partial scaffold directory
        try { if (await fileExists(projPath)) await fsp.rm(projPath, { recursive: true, force: true }); } catch (_) {}
        showToast(t('newProject.scaffoldError', { error: err.message }), 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = t('newProject.create');
        return;
      }
    }

    // Check for duplicate project path (BUG 2)
    const normalizedPath = projPath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    const existingProject = projectsState.get().projects.find(p =>
      p.path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === normalizedPath
    );
    if (existingProject) {
      showToast(t('newProject.duplicatePath', { name: existingProject.name }), 'error');
      submitBtn.disabled = false;
      return;
    }

    // Register project — wrapped in try-catch (BUG 1)
    try {
      const project = { id: generateProjectId(), name, path: projPath, type: selectedType, folderId: null };
      // Merge type-specific wizard config
      const typeHandler = registry.get(selectedType);
      const typeConfig = typeHandler.getWizardConfig(document.getElementById('form-project'));
      Object.assign(project, typeConfig);

      // Generate template files if type supports it
      if (typeHandler.afterProjectCreate) {
        await typeHandler.afterProjectCreate(project, projPath);
      }

      const projects = [...projectsState.get().projects, project];
      const rootOrder = [...projectsState.get().rootOrder, project.id];
      projectsState.set({ projects, rootOrder });
      saveProjects();
      ProjectList.render();
      closeModal();

      // Detect git status for the new project
      checkProjectGitStatus(project);
    } catch (err) {
      console.error('[NewProject] Failed to register project:', err);
      showToast(t('newProject.registrationError', { error: err.message }), 'error');
      submitBtn.disabled = false;
    }
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
let currentFilterWorktreePath = null; // non-null when active tab is a worktree
let branchCache = { projectId: null, data: null };

// Returns the git working directory: worktree path if active tab is a worktree, else project path
function getEffectiveGitPath() {
  return currentFilterWorktreePath || getProject(currentFilterProjectId)?.path;
}

function hideFilterGitActions() {
  filterGitActions.style.display = 'none';
  branchDropdown.classList.remove('active');
  filterBtnBranch.classList.remove('open');
  currentFilterProjectId = null;
  currentFilterWorktreePath = null;
  const worktreeBadge = document.getElementById('worktree-badge');
  if (worktreeBadge) worktreeBadge.style.display = 'none';
}

// Returns true if a terminal tab is actually working in a worktree path
// (path comparison is more reliable than parentProjectId which can be stale)
function isWorktreeTerminal(termData) {
  if (!termData || !termData.project) return false;
  const mainPath = getProject(termData.project.id)?.path;
  if (!mainPath) return false;
  // Chat tabs: project.path is overridden to worktree path
  // Terminal tabs: cwd is set to worktree path
  const activePath = termData.cwd || termData.project.path;
  return !!activePath && activePath !== mainPath;
}

// Called by TerminalManager when the active tab changes
function handleActiveTerminalChange(id, termData) {
  const worktreeBadge = document.getElementById('worktree-badge');
  if (!termData) {
    currentFilterWorktreePath = null;
    if (worktreeBadge) worktreeBadge.style.display = 'none';
    return;
  }
  if (isWorktreeTerminal(termData)) {
    currentFilterWorktreePath = termData.cwd || termData.project?.path || null;
    if (worktreeBadge) worktreeBadge.style.display = '';
  } else {
    currentFilterWorktreePath = null;
    if (worktreeBadge) worktreeBadge.style.display = 'none';
  }
  // Refresh branch name if git buttons are visible
  if (currentFilterProjectId && filterGitActions.style.display !== 'none') {
    const gitPath = getEffectiveGitPath();
    if (gitPath) {
      branchCache = { projectId: null, data: null };
      api.git.currentBranch({ projectPath: gitPath })
        .then(branch => { if (filterBranchName) filterBranchName.textContent = branch || 'main'; })
        .catch(() => {});
    }
  }
}

let _showFilterGitActionsVersion = 0;

async function showFilterGitActions(projectId) {
  const callVersion = ++_showFilterGitActionsVersion;

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

  // Sync worktree badge with the currently active terminal
  const activeId = terminalsState.get().activeTerminal;
  const activeTermData = activeId ? terminalsState.get().terminals.get(activeId) : null;
  const worktreeBadge = document.getElementById('worktree-badge');
  if (worktreeBadge) {
    const isWorktree = activeTermData && activeTermData.project?.id === projectId && isWorktreeTerminal(activeTermData);
    worktreeBadge.style.display = isWorktree ? '' : 'none';
    currentFilterWorktreePath = isWorktree ? (activeTermData.cwd || activeTermData.project?.path || null) : null;
  }

  // Reset button states based on this project's git operations
  const gitOps = localState.gitOperations.get(projectId) || {};
  filterBtnPull.classList.toggle('loading', !!gitOps.pulling);
  filterBtnPull.disabled = !!gitOps.pulling;
  filterBtnPush.classList.toggle('loading', !!gitOps.pushing);
  filterBtnPush.disabled = !!gitOps.pushing;

  // Get current branch (use worktree path if active tab is a worktree)
  try {
    const branch = await api.git.currentBranch({ projectPath: getEffectiveGitPath() || project.path });
    // Stale check: if user switched projects while we awaited, discard this result
    if (callVersion !== _showFilterGitActionsVersion) return;
    filterBranchName.textContent = branch || 'main';
  } catch (e) {
    if (callVersion !== _showFilterGitActionsVersion) return;
    filterBranchName.textContent = '...';
  }
}

// Pull button
filterBtnPull.onclick = async () => {
  if (!currentFilterProjectId) return;
  const projectId = currentFilterProjectId;
  const gitPath = getEffectiveGitPath();
  filterBtnPull.classList.add('loading');
  filterBtnPull.disabled = true;
  await gitPull(projectId, gitPath);
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
  const gitPath = getEffectiveGitPath();
  filterBtnPush.classList.add('loading');
  filterBtnPush.disabled = true;
  await gitPush(projectId, gitPath);
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

  // Close other dropdowns
  const actionsDropdown = document.getElementById('actions-dropdown');
  const actionsBtn = document.getElementById('filter-btn-actions');
  if (actionsDropdown) actionsDropdown.classList.remove('active');
  if (actionsBtn) actionsBtn.classList.remove('open');
  const gitChangesEl = document.getElementById('git-changes-panel');
  if (gitChangesEl) gitChangesEl.classList.remove('active');

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
      branchDropdownList.innerHTML = `<div class="branch-dropdown-loading">${t('common.loading')}</div>`;
    }

    try {
      let branchesData, currentBranch;
      if (useCache) {
        branchesData = branchCache.data.branchesData;
        currentBranch = branchCache.data.currentBranch;
      } else {
        const gitPath = getEffectiveGitPath() || project.path;
        [branchesData, currentBranch] = await Promise.all([
          api.git.branches({ projectPath: gitPath }),
          api.git.currentBranch({ projectPath: gitPath })
        ]);
        branchCache = { projectId: currentFilterProjectId, data: { branchesData, currentBranch } };
      }

      const { local = [], remote = [] } = branchesData;

      if (local.length === 0 && remote.length === 0) {
        branchDropdownList.innerHTML = `<div class="branch-dropdown-loading">${t('git.noBranchesFound')}</div>`;
        return;
      }

      let html = '';

      // Header with create branch button
      html += `<div class="branch-dropdown-header-row">
        <span>${t('branches.title')}</span>
        <button class="branch-create-btn" id="branch-create-toggle" title="${t('branches.newBranch')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>`;

      // Create branch input (hidden by default)
      html += `<div class="branch-create-input-row" id="branch-create-row" style="display:none">
        <input type="text" class="branch-create-input" id="branch-create-input" placeholder="${t('branches.branchName')}" spellcheck="false" />
        <button class="branch-create-confirm" id="branch-create-confirm" title="${t('branches.create')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>`;

      // Local branches section
      if (local.length > 0) {
        html += `<div class="branch-dropdown-section-title">${t('branches.localBranches')}</div>`;
        html += local.map(branch => {
          const isCurrent = branch === currentBranch;
          return `
          <div class="branch-dropdown-item ${isCurrent ? 'current' : ''}" data-branch="${escapeHtml(branch)}">
            <span class="branch-dropdown-item-name">${escapeHtml(branch)}</span>
            ${!isCurrent ? `<div class="branch-dropdown-actions">
              <button class="branch-action-btn branch-merge-btn" data-action="merge" data-branch="${escapeHtml(branch)}" title="${t('git.mergedInto', { source: escapeHtml(branch), target: escapeHtml(currentBranch) })}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>
              </button>
              <button class="branch-action-btn branch-delete-btn" data-action="delete" data-branch="${escapeHtml(branch)}" title="${t('git.branchDeleted')}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>` : ''}
          </div>`;
        }).join('');
      }

      // Remote branches section
      if (remote.length > 0) {
        html += `<div class="branch-dropdown-section-title remote">${t('branches.remoteBranches')}</div>`;
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
          showGitToast({ success: true, title: t('git.branchCreated'), message: t('git.switchedToBranch', { name }), duration: 3000 });
          branchDropdown.classList.remove('active');
          filterBtnBranch.classList.remove('open');
          refreshDashboardAsync(currentFilterProjectId);
        } else {
          showGitToast({ success: false, title: t('git.branchCreateError'), message: result.error || t('git.unableToCreateBranch'), duration: 5000 });
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
              showGitToast({ success: true, title: t('git.mergeSuccessful'), message: t('git.mergedInto', { source: targetBranch, target: currentBranch }), duration: 3000 });
              branchDropdown.classList.remove('active');
              filterBtnBranch.classList.remove('open');
              refreshDashboardAsync(currentFilterProjectId);
            } else {
              showGitToast({ success: false, title: t('git.mergeError'), message: result.error || t('git.mergeFailed'), duration: 5000 });
              btn.disabled = false;
            }
          }

          if (action === 'delete') {
            // Confirmation
            const item = btn.closest('.branch-dropdown-item');
            const nameSpan = item.querySelector('.branch-dropdown-item-name');
            const actionsDiv = item.querySelector('.branch-dropdown-actions');
            actionsDiv.style.display = 'none';
            nameSpan.innerHTML = `${t('git.confirmDeleteBranch', { name: `<strong>${escapeHtml(targetBranch)}</strong>` })}`;
            item.classList.add('confirm-delete');

            const confirmRow = document.createElement('div');
            confirmRow.className = 'branch-delete-confirm-row';
            confirmRow.innerHTML = `
              <button class="branch-confirm-yes">${t('common.delete')}</button>
              <button class="branch-confirm-no">${t('common.cancel')}</button>
            `;
            item.appendChild(confirmRow);

            confirmRow.querySelector('.branch-confirm-yes').onclick = async (e2) => {
              e2.stopPropagation();
              const result = await api.git.deleteBranch({ projectPath: project.path, branch: targetBranch });
              if (result.success) {
                branchCache = { projectId: null, data: null };
                showGitToast({ success: true, title: t('git.branchDeleted'), message: t('git.branchDeletedMsg', { name: targetBranch }), duration: 3000 });
                // Re-render the dropdown
                item.remove();
                refreshDashboardAsync(currentFilterProjectId);
              } else {
                showGitToast({ success: false, title: t('git.branchDeleteError'), message: result.error || t('git.deletionFailed'), duration: 5000 });
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
              title: t('git.branchChanged'),
              message: t('git.switchedToBranch', { name: branch }),
              duration: 3000
            });
            refreshDashboardAsync(currentFilterProjectId);
          } else {
            showGitToast({
              success: false,
              title: t('git.checkoutError'),
              message: result.error || t('git.unableToSwitchBranch'),
              duration: 5000
            });
          }

          branchDropdown.classList.remove('active');
          filterBtnBranch.classList.remove('open');
        };
      });
    } catch (e) {
      branchDropdownList.innerHTML = `<div class="branch-dropdown-loading">${t('git.loadingError')}</div>`;
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
    const projectId = projects[selectedFilter].id;
    // showFilterGitActions handles the case where git status is not yet loaded
    // (it hides buttons when gitRepoStatus is missing). checkAllProjectsGitStatus
    // will re-call showFilterGitActions when the status becomes available.
    showFilterGitActions(projectId);
  } else {
    hideFilterGitActions();
  }
});

// ========== GIT CHANGES PANEL (extracted to GitChangesPanel module) ==========
GitChangesPanel.init({
  showToast,
  showGitToast,
  getCurrentFilterProjectId: () => currentFilterProjectId,
  getEffectiveGitPath,
  getProject,
  refreshDashboardAsync,
  closeBranchDropdown: () => { branchDropdown.classList.remove('active'); filterBtnBranch.classList.remove('open'); },
  closeActionsDropdown: () => { const d = document.getElementById('actions-dropdown'); const b = document.getElementById('filter-btn-actions'); if (d) d.classList.remove('active'); if (b) b.classList.remove('open'); }
});


// ========== BUNDLED SKILLS INSTALLATION ==========
async function installBundledSkills() {
  const bundledSkillsPath = path.join(__dirname, 'resources', 'bundled-skills');
  const bundledSkills = ['create-skill', 'create-agents'];

  for (const skillName of bundledSkills) {
    const targetPath = path.join(skillsDir, skillName);
    const sourcePath = path.join(bundledSkillsPath, skillName, 'SKILL.md');

    // Only install if not already present
    if (!(await fileExists(targetPath)) && (await fileExists(sourcePath))) {
      try {
        await fsp.mkdir(targetPath, { recursive: true });
        await fsp.copyFile(sourcePath, path.join(targetPath, 'SKILL.md'));
        console.debug(`Installed bundled skill: ${skillName}`);
      } catch (e) {
        console.error(`Failed to install bundled skill ${skillName}:`, e);
      }
    }
  }
}

// Install bundled skills on startup
installBundledSkills();

// Verify hooks integrity on startup (handler exists, paths current, all hooks present)
if (getSetting('hooksEnabled')) {
  api.hooks.verify().then(result => {
    if (result.repaired) {
      console.log('[Hooks] Auto-repaired:', result.details);
    }
  }).catch(e => console.error('[Hooks] Verify failed:', e));
}

// ========== HOOKS CONSENT MODAL (for existing users) ==========
function showHooksConsentModal() {
  if (getSetting('hooksConsentShown')) return;
  // If hooks already enabled (user opted in before consent feature), just mark as shown
  if (getSetting('hooksEnabled')) {
    setSetting('hooksConsentShown', true);
    return;
  }

  const content = `
    <div class="hooks-consent-content">
      <p>${t('hooks.consent.description')}</p>
      <div class="hooks-consent-columns">
        <div class="hooks-consent-col hooks-consent-captured">
          <h4>${t('hooks.consent.dataTitle')}</h4>
          <div>&#10003; ${t('hooks.consent.data1')}</div>
          <div>&#10003; ${t('hooks.consent.data2')}</div>
          <div>&#10003; ${t('hooks.consent.data3')}</div>
        </div>
        <div class="hooks-consent-col hooks-consent-not-captured">
          <h4>${t('hooks.consent.noDataTitle')}</h4>
          <div>&#10007; ${t('hooks.consent.noData1')}</div>
          <div>&#10007; ${t('hooks.consent.noData2')}</div>
          <div>&#10007; ${t('hooks.consent.noData3')}</div>
        </div>
      </div>
    </div>
  `;

  const modal = ModalComponent.createModal({
    id: 'hooks-consent-modal',
    title: t('hooks.consent.title'),
    content,
    size: 'medium',
    buttons: [
      {
        label: t('hooks.consent.decline'),
        action: 'decline',
        onClick: (m) => {
          setSetting('hooksConsentShown', true);
          setSetting('hooksEnabled', false);
          ModalComponent.closeModal(m);
        }
      },
      {
        label: t('hooks.consent.accept'),
        action: 'accept',
        primary: true,
        onClick: async (m) => {
          setSetting('hooksConsentShown', true);
          setSetting('hooksEnabled', true);
          // Update settings tab toggle if visible
          const domToggle = document.getElementById('hooks-enabled-toggle');
          if (domToggle) domToggle.checked = true;
          try { await api.hooks.install(); } catch (e) { console.error('Failed to install hooks:', e); }
          const { switchProvider } = require('./src/renderer/events');
          switchProvider('hooks');
          ModalComponent.closeModal(m);
        }
      }
    ],
    onClose: () => {
      setSetting('hooksConsentShown', true);
      setSetting('hooksEnabled', false);
    }
  });
  ModalComponent.showModal(modal);
}

// Show hooks consent after a short delay for existing users
setTimeout(showHooksConsentModal, 2000);

// ========== TELEMETRY CONSENT MODAL (for existing users) ==========
function showTelemetryConsentModal() {
  if (getSetting('telemetryConsentShown')) return;

  const content = `
    <div style="padding: 4px 0;">
      <p style="margin-bottom: 16px; line-height: 1.6; color: var(--text-secondary); font-size: 13px;">
        ${t('telemetry.consentDescription')}
      </p>
      <div style="display: flex; gap: 12px; margin-bottom: 12px;">
        <div style="flex:1; padding: 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 10px;">
          <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; color: var(--accent);">
            ${t('telemetry.whatWeCollect')}
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0;">&#10003; ${t('telemetry.collect1')}</div>
          <div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0;">&#10003; ${t('telemetry.collect2')}</div>
          <div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0;">&#10003; ${t('telemetry.collect3')}</div>
          <div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0;">&#10003; ${t('telemetry.collect4')}</div>
        </div>
        <div style="flex:1; padding: 12px 14px; background: rgba(34,197,94,0.05); border: 1px solid rgba(34,197,94,0.2); border-radius: 10px;">
          <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; color: #22c55e;">
            ${t('telemetry.whatWeDoNotCollect')}
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0;">&#10007; ${t('telemetry.notCollect1')}</div>
          <div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0;">&#10007; ${t('telemetry.notCollect2')}</div>
          <div style="font-size: 12px; color: var(--text-secondary); padding: 2px 0;">&#10007; ${t('telemetry.notCollect3')}</div>
        </div>
      </div>
      <p style="font-size: 12px; color: var(--text-muted);">
        ${t('telemetry.consentChangeSettings')}
      </p>
    </div>
  `;

  const modal = ModalComponent.createModal({
    id: 'telemetry-consent-modal',
    title: t('telemetry.consentTitle'),
    content,
    size: 'medium',
    buttons: [
      {
        label: t('telemetry.consentDecline'),
        action: 'decline',
        onClick: (m) => {
          setSetting('telemetryConsentShown', true);
          setSetting('telemetryEnabled', false);
          ModalComponent.closeModal(m);
        }
      },
      {
        label: t('telemetry.consentAccept'),
        action: 'accept',
        primary: true,
        onClick: (m) => {
          setSetting('telemetryConsentShown', true);
          setSetting('telemetryEnabled', true);
          ModalComponent.closeModal(m);
        }
      }
    ],
    onClose: () => {
      setSetting('telemetryConsentShown', true);
      setSetting('telemetryEnabled', false);
    }
  });
  ModalComponent.showModal(modal);
}

// Show telemetry consent after hooks consent (stagger by 3s)
setTimeout(showTelemetryConsentModal, 3500);

// ========== SKILLS/AGENTS CREATION MODAL ==========
let createModalType = 'skill'; // 'skill' or 'agent'
let createModalGenerating = false; // tracks if generation is in progress

// Store original modal HTML for reset
const createModalOriginalBody = `
  <div class="create-modal-intro">
    <p data-i18n="ui.describeWhatToCreate">${t('ui.describeWhatToCreate')}</p>
  </div>
  <div class="create-modal-field">
    <label for="create-modal-description" data-i18n="ui.description">${t('ui.description')}</label>
    <textarea id="create-modal-description" rows="4"></textarea>
  </div>
  <div class="create-modal-field">
    <label data-i18n="ui.targetProject">${t('ui.targetProject')}</label>
    <select id="create-modal-project">
      <option value="">${t('ui.selectProject')}</option>
    </select>
    <p class="field-hint" data-i18n="ui.skillAgentHint">${t('ui.skillAgentHint')}</p>
  </div>
`;
const createModalOriginalFooter = `
  <button class="btn-secondary" id="create-modal-cancel">${t('common.cancel')}</button>
  <button class="btn-primary btn-create-with-claude" id="create-modal-submit">
    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
    <span>${t('ui.createWithClaude')}</span>
  </button>
`;

function resetCreateModal() {
  const modalBody = document.querySelector('#create-modal .modal-body');
  const modalFooter = document.querySelector('#create-modal .modal-footer');
  if (modalBody) modalBody.innerHTML = createModalOriginalBody;
  if (modalFooter) modalFooter.innerHTML = createModalOriginalFooter;

  // Re-bind form event listeners
  document.getElementById('create-modal-cancel')?.addEventListener('click', closeCreateModal);
  document.getElementById('create-modal-submit')?.addEventListener('click', submitCreateModal);
  document.getElementById('create-modal-description')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      submitCreateModal();
    }
  });
  createModalGenerating = false;
}

function openCreateModal(type) {
  createModalType = type;
  const modal = document.getElementById('create-modal');
  const title = document.getElementById('create-modal-title');

  // Reset modal to form mode if it was in progress mode
  resetCreateModal();

  title.textContent = type === 'skill' ? t('ui.newSkill') : t('ui.newAgent');
  const description = document.getElementById('create-modal-description');
  const projectSelect = document.getElementById('create-modal-project');

  description.value = '';
  description.placeholder = type === 'skill'
    ? 'Ex: A skill that generates unit tests for TypeScript code using Vitest...'
    : 'Ex: An agent that reviews code to find security and performance issues...';

  // Populate projects dropdown
  const projects = projectsState.get().projects;
  projectSelect.innerHTML = '<option value="">Select a project...</option>' +
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
  const modal = document.getElementById('create-modal');
  modal.classList.remove('active');
  // Reset to form mode for next open (unless generation is still running)
  if (!createModalGenerating) {
    resetCreateModal();
  }
}

async function submitCreateModal() {
  const description = document.getElementById('create-modal-description').value.trim();
  const projectIndex = document.getElementById('create-modal-project').value;

  if (!description) {
    showToast({ type: 'warning', title: t('ui.createWithClaude'), message: t('ui.describeWhatToCreate') });
    return;
  }

  if (projectIndex === '') {
    showToast({ type: 'warning', title: t('ui.createWithClaude'), message: t('ui.selectProject') });
    return;
  }

  let cwd;
  if (projectIndex === 'global') {
    const { os } = window.electron_nodeModules;
    cwd = os.homedir();
  } else {
    const projects = projectsState.get().projects;
    const project = projects[parseInt(projectIndex)];
    if (!project) return;
    cwd = project.path;
  }

  const type = createModalType;
  createModalGenerating = true;

  // Switch modal to progress mode
  const modalBody = document.querySelector('#create-modal .modal-body');
  const modalFooter = document.querySelector('#create-modal .modal-footer');

  modalBody.innerHTML = `
    <div class="create-progress">
      <div class="create-progress-header">
        <div class="spinner"></div>
        <div class="create-progress-title">${type === 'skill' ? t('ui.generatingSkill') : t('ui.generatingAgent')}</div>
      </div>
      <div class="create-progress-log" id="create-progress-log"></div>
    </div>
  `;

  modalFooter.innerHTML = `
    <button class="btn-secondary" id="create-modal-cancel-gen">${t('common.cancel')}</button>
  `;

  let currentGenId = null;
  let unsubProgress = null;
  let unsubComplete = null;

  const cleanup = () => {
    if (unsubProgress) unsubProgress();
    if (unsubComplete) unsubComplete();
    unsubProgress = null;
    unsubComplete = null;
    createModalGenerating = false;
  };

  const handleResult = (result) => {
    cleanup();
    closeCreateModal();

    if (result.success) {
      const successMsg = type === 'skill' ? t('ui.skillCreatedSuccess') : t('ui.agentCreatedSuccess');
      showToast({ type: 'success', title: t('ui.createWithClaude'), message: successMsg });

      // Desktop notification only if app is not focused (respects user preference)
      showNotification('done',
        type === 'skill' ? t('ui.newSkill') : t('ui.newAgent'),
        successMsg
      );

      if (type === 'skill') {
        SkillsAgentsPanel.loadSkills();
      } else {
        SkillsAgentsPanel.loadAgents();
      }
    } else {
      const isCancelled = result.error === 'Cancelled';
      showToast({
        type: isCancelled ? 'warning' : 'error',
        title: t('ui.createWithClaude'),
        message: isCancelled ? t('ui.generationCancelled') : `${t('ui.generationFailed')}: ${result.error}`,
        duration: 8000
      });
    }
  };

  // Listen for progress events
  unsubProgress = api.chat.onGenerationProgress(({ genId, message }) => {
    if (!message || (currentGenId && genId !== currentGenId)) return;
    const logEl = document.getElementById('create-progress-log');
    if (!logEl) return;

    const entry = document.createElement('div');
    entry.className = 'create-progress-entry';

    if (message.step === 'tool') {
      entry.innerHTML = `<span class="create-progress-icon tool">&bull;</span> <span>${escapeHtml(message.text)}</span>`;
    } else if (message.step === 'thinking') {
      entry.innerHTML = `<span class="create-progress-icon think">&bull;</span> <span>${escapeHtml(message.text)}</span>`;
    } else {
      entry.innerHTML = `<span class="create-progress-icon">&bull;</span> <span>${escapeHtml(message.text)}</span>`;
    }

    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  });

  // Listen for completion event
  unsubComplete = api.chat.onGenerationComplete(({ genId, result }) => {
    if (currentGenId && genId !== currentGenId) return;
    handleResult(result);
  });

  // Cancel button
  document.getElementById('create-modal-cancel-gen').onclick = () => {
    if (currentGenId) {
      api.chat.cancelGeneration({ genId: currentGenId });
    }
    cleanup();
    closeCreateModal();
    showToast({ type: 'warning', title: t('ui.createWithClaude'), message: t('ui.generationCancelled') });
  };

  try {
    // Fire-and-forget: get genId immediately
    const response = await api.chat.generateSkillAgent({
      type,
      description,
      cwd,
      model: settingsState.get().chatModel || 'sonnet'
    });

    if (response.error) {
      // Immediate error (not async)
      handleResult({ success: false, error: response.error });
      return;
    }

    currentGenId = response.genId;
  } catch (err) {
    cleanup();
    closeCreateModal();
    showToast({
      type: 'error',
      title: t('ui.createWithClaude'),
      message: `${t('ui.generationFailed')}: ${err.message}`,
      duration: 8000
    });
  }
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

// Quick picker command: navigate to a tab or trigger an action
api.quickPicker.onNavigateTab(({ tabId, action }) => {
  if (action === 'new-project') {
    document.getElementById('btn-new-project')?.click();
  } else if (tabId) {
    document.querySelector(`.nav-tab[data-tab="${tabId}"]`)?.click();
  }
});

// Remote Control: ouvrir un tab chat depuis mobile
api.remote.onOpenChatTab(({ cwd, prompt, images, model, effort, resumeSessionId }) => {
  const projects = projectsState.get().projects;
  const project = projects.find(p => cwd && cwd.replace(/\\/g, '/').startsWith(p.path.replace(/\\/g, '/')));
  if (!project) return;
  const projectIndex = getProjectIndex(project.id);
  setSelectedProjectFilter(projectIndex);
  ProjectList.render();
  TerminalManager.createTerminal(project, {
    mode: 'chat',
    skipPermissions: settingsState.get().skipPermissions,
    cwd,
    initialPrompt: prompt || null,
    initialImages: Array.isArray(images) && images.length ? images : null,
    initialModel: model || null,
    initialEffort: effort || null,
    resumeSessionId: resumeSessionId || null,
    onSessionStart: (sessionId) => {
      api.remote.notifySessionCreated({ sessionId, projectId: project.id, tabName: project.name });
    },
  });
});

// Remote Control: push live time tracking data
(function _startRemoteTimePush() {
  function pushTime() {
    try {
      const { today } = getGlobalTimes();
      api.remote.pushTimeData({ todayMs: today });
    } catch (e) { console.error('[Remote] pushTime error:', e); }
  }
  // Push immédiat quand le serveur le demande (nouveau client connecté)
  api.remote.onRequestTimePush(pushTime);
  // Push périodique toutes les 30s pour les clients déjà connectés
  setInterval(pushTime, 30000);
})();

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

api.tray.onOpenNewWorktree(() => {
  const selectedFilter = projectsState.get().selectedProjectFilter;
  const projects = projectsState.get().projects;
  const project = selectedFilter !== null ? projects[selectedFilter] : projects[0];
  if (project) openNewWorktreeModal(project);
});

api.tray.onOpenQuickPicker(() => {
  const { projects, selectedProjectFilter } = projectsState.get();
  const currentProject = selectedProjectFilter !== null ? projects[selectedProjectFilter] : null;
  openQuickPicker(document.body, {
    currentProject,
    onSelectProject: (project) => {
      const projectIndex = getProjectIndex(project.id);
      setSelectedProjectFilter(projectIndex);
      ProjectList.render();
      TerminalManager.filterByProject(projectIndex);
      createTerminalForProject(project);
    },
  });
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
  const btnToggle = document.getElementById('btn-toggle-projects');
  if (!resizer || !panel) return;

  function updateToggleVisibility(width) {
    if (btnToggle) btnToggle.style.display = width < 210 ? 'none' : '';
  }

  let startX, startWidth;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (e) => {
      const newWidth = Math.min(600, Math.max(170, startWidth + (e.clientX - startX)));
      panel.style.width = newWidth + 'px';
      updateToggleVisibility(newWidth);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      updateToggleVisibility(panel.offsetWidth);
      settingsState.setProp('projectsPanelWidth', panel.offsetWidth);
      saveSettingsImmediate();
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

// ========== UPDATE SYSTEM (GitHub Desktop style) ==========
const updateBanner = document.getElementById('update-banner');
const updateMessage = document.getElementById('update-message');
const updateProgressContainer = document.getElementById('update-progress-container');
const updateProgressBar = document.getElementById('update-progress-bar');
const updateProgressText = document.getElementById('update-progress-text');
const updateBtn = document.getElementById('update-btn');
const updateDismiss = document.getElementById('update-dismiss');
const updateChangelogToggle = document.getElementById('update-changelog-toggle');
const updateChangelog = document.getElementById('update-changelog');
const updateChangelogContent = document.getElementById('update-changelog-content');

let updateState = {
  available: false,
  downloaded: false,
  version: null,
  downloadedVersion: null,  // Track actual downloaded version
  dismissed: false,
  dismissedVersion: null,   // Track which version was dismissed
  changelog: null
};

function showUpdateBanner() {
  if (updateState.dismissed) return;
  updateBanner.style.display = 'block';
  // Adjust main container height
  document.querySelector('.main-container').style.height = 'calc(100vh - 36px - 44px)';
}

function hideUpdateBanner() {
  updateBanner.style.display = 'none';
  updateChangelog.style.display = 'none';
  updateChangelogToggle.classList.remove('expanded');
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
      updateState.changelog = null;
      updateMessage.textContent = t('updates.newVersionAvailable', { version: data.version });
      updateProgressContainer.style.display = 'flex';
      updateBtn.style.display = 'none';
      updateChangelogToggle.style.display = 'none';
      updateChangelog.style.display = 'none';
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
      updateState.changelog = data.changelog || null;
      updateMessage.textContent = t('updates.readyToInstall', { version: data.version });
      updateProgressContainer.style.display = 'none';
      updateBtn.style.display = 'block';
      updateBtn.disabled = false;  // Re-enable button
      updateBtn.textContent = t('updates.restartToUpdate');  // Reset button text
      updateBanner.classList.add('downloaded');
      // Show changelog toggle if we have release notes
      if (updateState.changelog) {
        updateChangelogToggle.style.display = 'inline-flex';
        try {
          const { marked } = require('marked');
          updateChangelogContent.innerHTML = marked(updateState.changelog);
        } catch (e) {
          updateChangelogContent.textContent = updateState.changelog;
        }
      } else {
        updateChangelogToggle.style.display = 'none';
      }
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
  updateBtn.textContent = t('updates.installing');
  api.app.installUpdate();
});

// Changelog toggle button
updateChangelogToggle.addEventListener('click', () => {
  const isOpen = updateChangelog.style.display !== 'none';
  updateChangelog.style.display = isOpen ? 'none' : 'block';
  updateChangelogToggle.classList.toggle('expanded', !isOpen);
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
let usageResetTargets = { session: null, weekly: null, sonnet: null };
let usageResetInterval = null;

const usageElements = {
  container: document.getElementById('titlebar-usage'),
  session: {
    bar: document.getElementById('usage-bar-session'),
    percent: document.getElementById('usage-percent-session'),
    reset: document.getElementById('usage-reset-session')
  },
  weekly: {
    bar: document.getElementById('usage-bar-weekly'),
    percent: document.getElementById('usage-percent-weekly'),
    reset: document.getElementById('usage-reset-weekly')
  },
  sonnet: {
    bar: document.getElementById('usage-bar-sonnet'),
    percent: document.getElementById('usage-percent-sonnet'),
    reset: document.getElementById('usage-reset-sonnet')
  },
  extra: {
    item: document.getElementById('usage-item-extra'),
    bar: document.getElementById('usage-bar-extra'),
    percent: document.getElementById('usage-percent-extra')
  }
};

/**
 * Update a single usage bar
 */
function updateUsageBar(elements, percent) {
  if (!elements.bar || !elements.percent) return;

  if (percent === null || percent === undefined) {
    elements.percent.textContent = '--';
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
 * Update extra usage display (paid tokens beyond plan)
 * extraUsage from API: { cost_usd: number } or null
 */
function updateExtraUsage(extraUsage) {
  const { item, bar, percent } = usageElements.extra;
  if (!item || !bar || !percent) return;

  // extraUsage can be an object { cost_usd } or a number or null
  let costUsd = null;
  if (extraUsage !== null && extraUsage !== undefined) {
    if (typeof extraUsage === 'object' && extraUsage.cost_usd != null) {
      costUsd = extraUsage.cost_usd;
    } else if (typeof extraUsage === 'number') {
      costUsd = extraUsage;
    }
  }

  if (costUsd === null || costUsd <= 0) {
    item.style.display = 'none';
    return;
  }

  item.style.display = '';
  percent.textContent = costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`;

  // Bar shows relative cost: full at $5, as a visual indicator
  const MAX_COST = 5;
  const pct = Math.min((costUsd / MAX_COST) * 100, 100);
  bar.style.width = `${pct}%`;
  bar.classList.remove('warning', 'danger');
  if (costUsd >= 2) bar.classList.add('danger');
  else if (costUsd >= 0.5) bar.classList.add('warning');
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
    updateResetEl(usageElements.session.reset, null);
    updateResetEl(usageElements.weekly.reset, null);
    updateResetEl(usageElements.sonnet.reset, null);
    if (usageElements.extra.item) usageElements.extra.item.style.display = 'none';
    return;
  }

  const data = usageData.data;

  // Update all three usage bars
  updateUsageBar(usageElements.session, data.session);
  updateUsageBar(usageElements.weekly, data.weekly);
  updateUsageBar(usageElements.sonnet, data.sonnet);

  // Extra usage (paid tokens beyond plan) — show only when non-zero
  updateExtraUsage(data.extraUsage);

  // Set reset targets for each category
  usageResetTargets.session = data.sessionReset ? new Date(data.sessionReset) : null;
  usageResetTargets.weekly = data.weeklyReset ? new Date(data.weeklyReset) : null;
  usageResetTargets.sonnet = data.sonnetReset ? new Date(data.sonnetReset) : null;
  startResetCountdown();
}

function startResetCountdown() {
  updateAllResets();
  if (!usageResetInterval) {
    usageResetInterval = setInterval(updateAllResets, 60000);
  }
}

function updateAllResets() {
  updateResetEl(usageElements.session.reset, usageResetTargets.session);
  updateResetEl(usageElements.weekly.reset, usageResetTargets.weekly);
  updateResetEl(usageElements.sonnet.reset, usageResetTargets.sonnet);
}

function updateResetEl(el, target) {
  if (!el) return;
  if (!target) { el.textContent = ''; return; }
  const remaining = target.getTime() - Date.now();
  if (remaining <= 0) { el.textContent = ''; return; }
  const lang = getCurrentLanguage();
  const d = Math.floor(remaining / 86400000);
  const h = Math.floor((remaining % 86400000) / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const dU = lang === 'fr' ? 'j' : 'd';
  if (d > 0) {
    el.textContent = `${d}${dU} ${h}h`;
  } else if (h > 0) {
    el.textContent = `${h}h ${String(m).padStart(2, '0')}min`;
  } else {
    el.textContent = `${m}min`;
  }
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

  // Listen for push updates from main process (no polling needed)
  if (api.usage.onDataUpdated) {
    api.usage.onDataUpdated((usagePayload) => {
      if (usagePayload && usagePayload.data) {
        updateUsageDisplay(usagePayload);
      }
    });
  }

  // Fallback poll every 30s (in case push event is missed)
  setInterval(async () => {
    try {
      const data = await api.usage.getData();
      if (data && data.data) {
        updateUsageDisplay(data);
      }
    } catch (e) {
      // Ignore errors during polling
    }
  }, 30000);

  // Initial fetch (after 2s to let main process start)
  setTimeout(() => {
    refreshUsageDisplay();
  }, 2000);
}

// ========== CI/CD HEADER INDICATOR ==========
const ciIndicator = {
  pill: document.getElementById('filter-ci-pill'),
  text: document.getElementById('filter-ci-text'),
  stepEl: document.getElementById('filter-ci-step'),
  fixBtn: document.getElementById('filter-ci-fix'),
  currentRun: null,
  currentJobs: [],
  currentRemoteUrl: null,
  fastPollInterval: null,
  hideTimeout: null,
  _fetchingLogs: false
};

function showCIIndicator(run, jobs = []) {
  if (!ciIndicator.pill) return;

  ciIndicator.currentRun = run;
  ciIndicator.currentJobs = jobs;

  const pill = ciIndicator.pill;
  pill.classList.remove('ci-running', 'ci-success', 'ci-failure');

  let stepText = null;
  let showFix = false;

  if (run.status === 'completed') {
    if (run.conclusion === 'success') {
      pill.classList.add('ci-success');
    } else if (run.conclusion === 'cancelled') {
      pill.classList.add('ci-failure');
    } else {
      pill.classList.add('ci-failure');
      showFix = true;
    }
  } else {
    pill.classList.add('ci-running');
    // Find active step across jobs
    const activeJob = jobs.find(j => j.status === 'in_progress');
    if (activeJob) {
      const activeStep = activeJob.steps.find(s => s.status === 'in_progress');
      if (activeStep) {
        stepText = `${activeStep.number}/${activeJob.steps.length}`;
      }
    }
  }

  ciIndicator.text.textContent = run.name;

  if (stepText) {
    ciIndicator.stepEl.textContent = stepText;
    ciIndicator.stepEl.style.display = '';
  } else {
    ciIndicator.stepEl.style.display = 'none';
  }

  ciIndicator.fixBtn.style.display = showFix ? '' : 'none';
  pill.style.display = 'flex';

  // Auto-hide success after 5s
  clearTimeout(ciIndicator.hideTimeout);
  if (run.status === 'completed' && run.conclusion === 'success') {
    ciIndicator.hideTimeout = setTimeout(() => hideCIIndicator(), 5000);
  }
}

function hideCIIndicator() {
  if (!ciIndicator.pill) return;
  ciIndicator.pill.style.display = 'none';
  ciIndicator.currentRun = null;
  ciIndicator.currentJobs = [];
  stopFastCIPoll();
}

function startFastCIPoll() {
  if (ciIndicator.fastPollInterval) return;
  ciIndicator.fastPollInterval = setInterval(checkCIStatus, 5000);
}

function stopFastCIPoll() {
  clearInterval(ciIndicator.fastPollInterval);
  ciIndicator.fastPollInterval = null;
}

async function checkCIStatus() {
  const filterIdx = projectsState.get().selectedProjectFilter;
  if (filterIdx === null || filterIdx === undefined) return;

  const projects = projectsState.get().projects;
  const project = projects[filterIdx];
  if (!project) return;

  try {
    const gitInfo = await api.git.infoFull(project.path);
    if (!gitInfo.isGitRepo || !gitInfo.remoteUrl || !gitInfo.remoteUrl.includes('github.com')) {
      if (ciIndicator.currentRun) hideCIIndicator();
      return;
    }

    ciIndicator.currentRemoteUrl = gitInfo.remoteUrl;

    const result = await api.github.workflowRuns(gitInfo.remoteUrl);
    if (!result.success || !result.authenticated || !result.runs || result.runs.length === 0) {
      if (ciIndicator.currentRun) hideCIIndicator();
      return;
    }

    const currentBranch = gitInfo.branch;
    const inProgressRun = result.runs.find(r => r.status === 'in_progress' || r.status === 'queued');
    const branchRun = result.runs.find(r => r.branch === currentBranch);
    const relevantRun = inProgressRun || branchRun;

    if (!relevantRun) {
      if (ciIndicator.currentRun) hideCIIndicator();
      return;
    }

    // Fetch jobs/steps when run is active (for step indicator)
    let jobs = ciIndicator.currentJobs;
    if (relevantRun.status === 'in_progress' || relevantRun.status === 'queued') {
      const jobsResult = await api.github.workflowJobs(gitInfo.remoteUrl, relevantRun.id);
      if (jobsResult.success && jobsResult.jobs) {
        jobs = jobsResult.jobs;
      }
      startFastCIPoll();
    } else {
      stopFastCIPoll();
      // Fetch jobs once on completion so "Fix it" has job data
      if (relevantRun.status === 'completed' && relevantRun.conclusion === 'failure' && ciIndicator.currentJobs.length === 0) {
        const jobsResult = await api.github.workflowJobs(gitInfo.remoteUrl, relevantRun.id);
        if (jobsResult.success && jobsResult.jobs) jobs = jobsResult.jobs;
      }
    }

    const changed = !ciIndicator.currentRun ||
      ciIndicator.currentRun.id !== relevantRun.id ||
      ciIndicator.currentRun.status !== relevantRun.status ||
      ciIndicator.currentRun.conclusion !== relevantRun.conclusion;

    if (changed || relevantRun.status === 'in_progress') {
      showCIIndicator(relevantRun, jobs);
    }
  } catch (e) {
    console.error('[CI Indicator] Error:', e);
  }
}

async function handleCIFixIt() {
  const run = ciIndicator.currentRun;
  const remoteUrl = ciIndicator.currentRemoteUrl;
  if (!run || !remoteUrl) return;

  const filterIdx = projectsState.get().selectedProjectFilter;
  if (filterIdx === null) return;
  const project = projectsState.get().projects[filterIdx];
  if (!project) return;

  // Find failed job
  const failedJob = ciIndicator.currentJobs.find(j => j.conclusion === 'failure') || ciIndicator.currentJobs[0];
  let logExcerpt = '';

  if (failedJob && !ciIndicator._fetchingLogs) {
    ciIndicator._fetchingLogs = true;
    try {
      const logsResult = await api.github.jobLogs(remoteUrl, failedJob.id);
      if (logsResult.success && logsResult.logs) {
        logExcerpt = logsResult.logs;
      }
    } catch (e) {
      console.error('[CI Fix] Error fetching logs:', e);
    } finally {
      ciIndicator._fetchingLogs = false;
    }
  }

  const failedStep = failedJob?.steps?.find(s => s.conclusion === 'failure');
  const stepName = failedStep ? failedStep.name : (failedJob?.name || 'unknown');
  const prompt = [
    `The CI workflow "${run.name}" failed on branch "${run.branch}".`,
    `Failed job: "${failedJob?.name || 'unknown'}", step: "${stepName}".`,
    '',
    'Here are the relevant error logs:',
    '```',
    logExcerpt || '(Could not retrieve logs)',
    '```',
    '',
    'Please analyze the error and fix the issue in the code.'
  ].join('\n');

  TerminalManager.createTerminal(project, {
    mode: 'chat',
    initialPrompt: prompt,
    skipPermissions: getSetting('skipPermissions') || false
  });
}

// Initialize CI indicator
if (ciIndicator.pill) {
  ciIndicator.fixBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    handleCIFixIt();
  });

  ciIndicator.pill.addEventListener('click', (e) => {
    if (e.target.closest('.filter-ci-fix')) return;
    if (ciIndicator.currentRun?.url) {
      api.dialog.openExternal(ciIndicator.currentRun.url);
    }
  });

  // Slow baseline poll (30s)
  setInterval(checkCIStatus, 30000);

  // Initial check after 3s
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

// ========== CLEANUP ON QUIT ==========
// Listen for app quit to save active time tracking sessions and cleanup services
api.lifecycle.onWillQuit(() => {
  const { saveAndShutdown } = require('./src/renderer');
  saveAndShutdown();
  DashboardService.cleanup();
});

// Backup cleanup on window unload (in case onWillQuit doesn't fire)
window.addEventListener('beforeunload', () => {
  const { saveAndShutdown } = require('./src/renderer');
  saveAndShutdown();
  DashboardService.cleanup();
});

