/**
 * Claude Terminal - Renderer Process
 * Main entry point - orchestrates all modules
 */

// With contextIsolation: true, we use the preload API
// The API is exposed via contextBridge in preload.js
const api = window.electron_api;
const { path, fs, process: nodeProcess, __dirname } = window.electron_nodeModules;

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
const { MemoryEditor, GitChangesPanel, ShortcutsManager, SettingsPanel, SkillsAgentsPanel, PluginsPanel, MarketplacePanel, McpPanel, WorkflowPanel, DatabasePanel, CloudPanel } = require('./src/renderer/ui/panels');

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
  selectedDashboardProject: -1
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

// ========== KEYBOARD SHORTCUTS (extracted to ShortcutsManager module) ==========
// ========== INITIALIZATION ==========
const { initClaudeEvents, switchProvider, getDashboardStats, setNotificationFn } = require('./src/renderer/events');
const { loadSessionData, clearProjectSessions, saveTerminalSessions } = require('./src/renderer/services/TerminalSessionService');

(async () => {
  ensureDirectories();
  await initializeState(); // Loads settings, projects AND initializes time tracking

  // Apply body classes for settings that affect global CSS
  if (getSetting('showTabModeToggle') === false) {
    document.body.classList.add('hide-tab-mode-toggle');
  }

  initI18n(settingsState.get().language); // Initialize i18n with saved language preference

  // Initialize Claude event bus and provider (hooks or scraping)
  initClaudeEvents();

  // Initialize PaneManager (must be before any tab creation/session restore)
  const PaneManager = require('./src/renderer/ui/components/PaneManager');
  PaneManager.initPanes();

  // Wire pane focus to terminal activation (clicking a pane makes its active tab global)
  PaneManager.setOnPaneFocus((termId) => {
    TerminalManager.setActiveTerminal(termId);
  });
  PaneManager.setupPaneFocusHandlers();

  // Wire tab-moved callback for drag-to-split (activates moved tab)
  PaneManager.setOnTabMoved((termId) => {
    TerminalManager.setActiveTerminal(termId);
  });

  // Restore terminal sessions from previous run
  try {
    const sessionData = loadSessionData();
    if (sessionData && sessionData.projects) {
      const projects = projectsState.get().projects;

      for (const projectId of Object.keys(sessionData.projects)) {
        const saved = sessionData.projects[projectId];
        const project = projects.find(p => p.id === projectId);
        if (!project) continue;
        if (!fs.existsSync(project.path)) continue;
        if (!saved.tabs || saved.tabs.length === 0) continue;

        // Pre-create pane structure if paneLayout exists
        if (saved.paneLayout && saved.paneLayout.count > 1) {
          const paneCount = Math.min(saved.paneLayout.count, 3);
          for (let p = PaneManager.getPaneOrder().length; p < paneCount; p++) {
            const lastPaneId = PaneManager.getPaneOrder()[PaneManager.getPaneOrder().length - 1];
            PaneManager.createPane(lastPaneId);
          }
        }

        // Build a reverse map: tab index -> pane index
        const tabToPaneIndex = new Map();
        if (saved.paneLayout && saved.paneLayout.panes) {
          saved.paneLayout.panes.forEach((pane, paneIdx) => {
            (pane.tabIndices || []).forEach(tabIdx => {
              tabToPaneIndex.set(tabIdx, paneIdx);
            });
          });
        }

        const restoredIds = []; // Sparse array — index matches saved.tabs position

        for (let tabIdx = 0; tabIdx < saved.tabs.length; tabIdx++) {
          const tab = saved.tabs[tabIdx];
          let restoredId = null;

          // Determine target pane for this tab
          const paneIdx = tabToPaneIndex.get(tabIdx) ?? 0;
          const targetPaneId = PaneManager.getPaneOrder()[paneIdx] || PaneManager.getDefaultPaneId();

          // Temporarily set active pane to target so new tab goes there
          const prevActivePaneId = PaneManager.getActivePaneId();
          PaneManager.setActivePaneId(targetPaneId);

          // Terminal tab: existing restore logic
          const cwd = fs.existsSync(tab.cwd) ? tab.cwd : project.path;
          restoredId = await TerminalManager.createTerminal(project, {
            runClaude: !tab.isBasic,
            cwd,
            mode: tab.mode || null,
            skipPermissions: settingsState.get().skipPermissions,
            resumeSessionId: (!tab.isBasic && tab.claudeSessionId) ? tab.claudeSessionId : null,
            name: tab.name || null,
          });

          // Restore previous active pane
          PaneManager.setActivePaneId(prevActivePaneId);

          restoredIds[tabIdx] = restoredId || null; // Keep index alignment with saved.tabs
        }

        // Restore per-pane active tabs and global active pane
        if (saved.paneLayout && saved.paneLayout.panes) {
          saved.paneLayout.panes.forEach((paneData, paneIdx) => {
            const paneId = PaneManager.getPaneOrder()[paneIdx];
            if (!paneId) return;

            const activeIdx = paneData.activeTabIndex;
            if (activeIdx != null) {
              const tabIndices = paneData.tabIndices || [];
              const globalTabIdx = tabIndices[activeIdx];
              const activeTermId = globalTabIdx != null ? restoredIds[globalTabIdx] : null;
              if (activeTermId) {
                // Set this tab as active in its pane (pane-scoped toggle)
                PaneManager.setPaneActiveTab(paneId, String(activeTermId));
                const pane = PaneManager.getPanes().get(paneId);
                if (pane) {
                  pane.tabsEl.querySelectorAll('.terminal-tab').forEach(t =>
                    t.classList.toggle('active', t.dataset.id == activeTermId));
                  pane.contentEl.querySelectorAll('.terminal-wrapper').forEach(w => {
                    w.classList.toggle('active', w.dataset.id == activeTermId);
                    w.style.removeProperty('display');
                  });
                }
              }
            }
          });

          // Set the globally active pane and its active tab
          const activePaneIdx = saved.paneLayout.activePane ?? 0;
          const activePaneId = PaneManager.getPaneOrder()[activePaneIdx];
          if (activePaneId) {
            PaneManager.setActivePaneId(activePaneId);
            const paneActiveTab = PaneManager.getPaneActiveTab(activePaneId);
            if (paneActiveTab) {
              TerminalManager.setActiveTerminal(paneActiveTab);
            }
          }
        } else {
          // No paneLayout (v1 data or single pane) — use legacy activeCwd
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
      }

      if (sessionData.lastOpenedProjectId) {
        const idx = projects.findIndex(p => p.id === sessionData.lastOpenedProjectId);
        if (idx !== -1) {
          setSelectedProjectFilter(idx);
          TerminalManager.filterByProject(idx);
        }
      }
    }
  } catch (err) {
    console.error('[SessionRestore] Error restoring terminal sessions:', err);
  }

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
  MemoryEditor.init({ showModal, closeModal });

  ShortcutsManager.init({
    settingsState, saveSettings,
    switchToSettingsTab: (...args) => SettingsPanel.switchToSettingsTab(...args),
    terminalsState, TerminalManager,
    projectsState, setSelectedProjectFilter, ProjectList,
    showSessionsModal,
    openQuickPicker, getProjectIndex,
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

    // Connect (this will trigger onStatusChange → _checkPendingChangesOnReconnect)
    await api.cloud.connect({
      serverUrl: settings.cloudServerUrl,
      apiKey: settings.cloudApiKey,
    });
  } catch (e) {
    console.warn('[CloudAutoConnect] Failed:', e.message);
  }
}

// ========== NOTIFICATIONS ==========
function showNotification(type, title, body, terminalId) {
  if (!isNotificationsEnabled()) return;
  if (document.hasFocus() && terminalsState.get().activeTerminal === terminalId) return;
  const labels = { show: t('terminals.notifBtnShow') };
  api.notification.show({ type: type || 'done', title, body, terminalId, autoDismiss: 8000, labels });
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
      title: 'Pull error',
      message: e.message || 'An error occurred',
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
      title: 'Push error',
      message: e.message || 'An error occurred',
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

// ========== DELETE PROJECT ==========
async function deleteProjectUI(projectId) {
  const project = getProject(projectId);
  if (!project) return;
  const projectIndex = getProjectIndex(projectId);
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

function _loadModalPins() {
  if (_modalPinsCache) return _modalPinsCache;
  try {
    _modalPinsCache = JSON.parse(fs.readFileSync(_modalPinsFile, 'utf8'));
  } catch { _modalPinsCache = {}; }
  return _modalPinsCache;
}

function _saveModalPins() {
  try { fs.writeFileSync(_modalPinsFile, JSON.stringify(_modalPinsCache || {}, null, 2), 'utf8'); } catch {}
}

function _toggleModalPin(sessionId) {
  const pins = _loadModalPins();
  if (pins[sessionId]) delete pins[sessionId]; else pins[sessionId] = true;
  _modalPinsCache = pins;
  _saveModalPins();
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

function _preprocessModalSessions(sessions) {
  const now = Date.now();
  const pins = _loadModalPins();
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

    const processed = _preprocessModalSessions(sessions);
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
    listEl?.addEventListener('click', (e) => {
      const pinBtn = e.target.closest('.session-card-pin');
      if (pinBtn) {
        e.stopPropagation();
        const sid = pinBtn.dataset.pinSid;
        if (!sid) return;
        _toggleModalPin(sid);
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
      closeModal();
      TerminalManager.resumeSession(project, sessionId, {
        skipPermissions: settingsState.get().skipPermissions
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
    const cloudNames = new Set(cloudProjects.map(p => p.name));
    const localProjects = projectsState.get().projects || [];

    // Fetch sync metadata from main process (lastSync, errors, watcher status)
    let syncStatuses = {};
    try {
      syncStatuses = await api.cloud.getSyncStatus({}) || {};
    } catch { /* ignore if not available */ }

    for (const p of localProjects) {
      const name = p.name || path.basename(p.path);
      const cur = cloudUploadStatus.get(p.id) || {};
      if (cloudNames.has(name)) {
        const meta = syncStatuses[p.id];
        cloudUploadStatus.set(p.id, {
          ...cur,
          synced: true,
          lastSync: meta?.lastSync || cur.lastSync || null,
          lastError: meta?.lastError || null,
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
  _activeUploadToast = showToast({ type: 'info', title: t('cloud.uploadTitle'), message: t('cloud.uploadPhaseScanning'), duration: 0 });

  // Safety net: auto-close toast after 5m30s if upload hangs
  const _uploadSafetyTimer = setTimeout(() => {
    if (_activeUploadToast) { _activeUploadToast.querySelector('.toast-close')?.click(); _activeUploadToast = null; }
  }, 330_000);

  try {
    await api.cloud.uploadProject({ projectName, projectPath: project.path });
    cloudUploadStatus.set(projectId, { synced: true, lastSync: Date.now() });
    // Register for auto-sync (file watcher)
    api.cloud.registerAutoSync({ projectId, projectPath: project.path }).catch(() => {});
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

async function cloudSyncProject(projectId) {
  const project = projectsState.get().projects.find(p => p.id === projectId);
  if (!project) return;

  const projectName = project.name || path.basename(project.path);
  const status = cloudUploadStatus.get(projectId);
  if (!status?.pendingChanges) return;

  // Set syncing state
  cloudUploadStatus.set(projectId, { ...status, syncing: true });
  ProjectList.render();

  try {
    // Check for conflicts before downloading
    const { conflicts, totalFiles } = await api.cloud.checkConflicts({
      projectName,
      localProjectPath: project.path,
    });

    if (conflicts.length > 0) {
      // Show conflict resolution modal
      const resolutions = await _showConflictModal(conflicts);
      if (!resolutions) {
        // User cancelled
        cloudUploadStatus.set(projectId, { ...status, syncing: false });
        ProjectList.render();
        return;
      }
      await api.cloud.downloadWithResolutions({
        projectName,
        localProjectPath: project.path,
        resolutions,
      });
    } else {
      // No conflicts — download directly
      await api.cloud.downloadChanges({ projectName, localProjectPath: project.path });
    }

    cloudUploadStatus.set(projectId, { synced: true, lastSync: Date.now() });
    ProjectList.render();
    showToast({ type: 'success', title: t('cloud.syncApplied'), message: projectName });
    // Refresh pending changes
    api.cloud.checkPendingChanges().then(r => _updateProjectPendingChanges(r.changes)).catch(() => {});
  } catch (err) {
    cloudUploadStatus.set(projectId, { ...status, syncing: false });
    ProjectList.render();
    showToast({ type: 'error', title: t('cloud.syncError'), message: err.message || projectName });
  }
}

function _showConflictModal(conflicts) {
  return new Promise((resolve) => {
    const fileListHtml = conflicts.map(c => `
      <div class="conflict-file-row">
        <div class="conflict-file-name">${c.file}</div>
        <div class="conflict-file-actions">
          <label class="conflict-radio">
            <input type="radio" name="conflict-${c.file.replace(/[^a-zA-Z0-9]/g, '_')}" value="cloud" checked>
            <span>${t('cloud.conflictUseCloud')}</span>
          </label>
          <label class="conflict-radio">
            <input type="radio" name="conflict-${c.file.replace(/[^a-zA-Z0-9]/g, '_')}" value="local">
            <span>${t('cloud.conflictKeepLocal')}</span>
          </label>
          <label class="conflict-radio">
            <input type="radio" name="conflict-${c.file.replace(/[^a-zA-Z0-9]/g, '_')}" value="both">
            <span>${t('cloud.conflictKeepBoth')}</span>
          </label>
        </div>
      </div>
    `).join('');

    const modalHtml = `
      <div class="modal-overlay" id="conflict-modal-overlay">
        <div class="modal-container modal-large">
          <div class="modal-header">
            <h3>${t('cloud.conflictTitle', { count: conflicts.length })}</h3>
            <button class="modal-close" id="conflict-modal-close">&times;</button>
          </div>
          <div class="modal-body">
            <p class="conflict-description">${t('cloud.conflictDescription')}</p>
            <div class="conflict-select-all" style="display:flex;gap:8px;margin-bottom:8px;">
              <button class="btn-secondary btn-sm" id="conflict-all-cloud" style="font-size:var(--font-xs);padding:4px 10px;">${t('cloud.conflictAllCloud')}</button>
              <button class="btn-secondary btn-sm" id="conflict-all-local" style="font-size:var(--font-xs);padding:4px 10px;">${t('cloud.conflictAllLocal')}</button>
            </div>
            <div class="conflict-file-list">${fileListHtml}</div>
          </div>
          <div class="modal-footer">
            <button class="btn-secondary" id="conflict-cancel">${t('common.cancel')}</button>
            <button class="btn-primary" id="conflict-apply">${t('cloud.conflictApply')}</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const overlay = document.getElementById('conflict-modal-overlay');

    const cleanup = () => overlay?.remove();

    document.getElementById('conflict-modal-close')?.addEventListener('click', () => { cleanup(); resolve(null); });
    document.getElementById('conflict-cancel')?.addEventListener('click', () => { cleanup(); resolve(null); });
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });

    // Select All buttons
    document.getElementById('conflict-all-cloud')?.addEventListener('click', () => {
      overlay.querySelectorAll('input[type="radio"][value="cloud"]').forEach(r => { r.checked = true; });
    });
    document.getElementById('conflict-all-local')?.addEventListener('click', () => {
      overlay.querySelectorAll('input[type="radio"][value="local"]').forEach(r => { r.checked = true; });
    });

    document.getElementById('conflict-apply')?.addEventListener('click', () => {
      const resolutions = {};
      for (const c of conflicts) {
        const safeName = c.file.replace(/[^a-zA-Z0-9]/g, '_');
        const selected = overlay.querySelector(`input[name="conflict-${safeName}"]:checked`);
        resolutions[c.file] = selected?.value || 'cloud';
      }
      cleanup();
      resolve(resolutions);
    });
  });
}

if (api.cloud?.onUploadProgress) {
  api.cloud.onUploadProgress((progress) => {
    if (!_activeUploadToast) return;
    const msgEl = _activeUploadToast.querySelector('.toast-message');
    if (!msgEl) return;
    const phases = {
      scanning: t('cloud.uploadPhaseScanning'),
      compressing: t('cloud.uploadPhaseCompressing'),
      uploading: t('cloud.uploadPhaseUploading'),
      done: t('cloud.uploadSuccess'),
    };
    if (phases[progress.phase]) msgEl.textContent = phases[progress.phase];
  });
}

// Refresh cloud projects on status change and at startup
function _updateCloudConnected(connected) {
  cloudConnected = connected;
  if (!connected) cloudUploadStatus.clear();
  ProjectList.setExternalState({ cloudConnected });
  ProjectList.render();
}

if (api.cloud?.onStatusChanged) {
  api.cloud.onStatusChanged((status) => {
    _updateCloudConnected(status.connected);
    if (status.connected) {
      refreshCloudProjects();
      api.cloud.checkPendingChanges().then(r => _updateProjectPendingChanges(r.changes)).catch(() => {});
      _checkAllProjectsDiff();
    }
  });
}
setTimeout(async () => {
  try {
    const s = await api.cloud.status();
    if (s.connected) {
      _updateCloudConnected(true);
      refreshCloudProjects();
      api.cloud.checkPendingChanges().then(r => _updateProjectPendingChanges(r.changes)).catch(() => {});
      _checkAllProjectsDiff();
    }
  } catch { /* ignore */ }
}, 3000);

/**
 * Compare local vs cloud for all synced projects.
 * Shows a resolution modal per project if differences are found.
 */
async function _checkAllProjectsDiff() {
  try {
    const statuses = await api.cloud.getSyncStatus({});
    if (!statuses || typeof statuses !== 'object') return;
    const localProjects = projectsState.get().projects || [];

    // Collect all diffs first (no modals yet)
    const projectDiffs = [];
    for (const [projectId, meta] of Object.entries(statuses)) {
      if (!meta.registered) continue;
      const project = localProjects.find(p => p.id === projectId);
      if (!project) continue;
      const projectName = project.name || path.basename(project.path);

      try {
        const diff = await api.cloud.compareFiles({ projectName, localProjectPath: project.path });
        if (diff.onlyLocal.length === 0 && diff.onlyCloud.length === 0 && diff.sizeDiff.length === 0) continue;
        projectDiffs.push({ projectId, project, projectName, diff });
      } catch { /* skip this project */ }
    }

    if (projectDiffs.length === 0) return;

    // Show a single batched diff modal for all projects
    const actions = await _showBatchDiffModal(projectDiffs);
    if (!actions) return; // cancelled

    for (const { projectId, projectName, action } of actions) {
      const project = localProjects.find(p => p.id === projectId);
      if (!project) continue;
      try {
        if (action === 'push') {
          await cloudUploadProject(projectId);
        } else if (action === 'pull') {
          await api.cloud.downloadChanges({ projectName, localProjectPath: project.path });
          cloudUploadStatus.set(projectId, { synced: true, lastSync: Date.now() });
          ProjectList.render();
          showToast({ type: 'success', title: t('cloud.syncApplied'), message: projectName });
        }
      } catch { /* skip this project */ }
    }
  } catch { /* ignore */ }
}

function _showDiffModal(projectName, diff) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const totalDiffs = diff.onlyLocal.length + diff.onlyCloud.length + diff.sizeDiff.length;

    let filesHtml = '';
    if (diff.onlyLocal.length > 0) {
      filesHtml += `<div class="diff-section"><h4 style="color:var(--success);margin:8px 0 4px;">Local only (${diff.onlyLocal.length})</h4>`;
      filesHtml += diff.onlyLocal.slice(0, 10).map(f => `<div class="diff-file">${f}</div>`).join('');
      if (diff.onlyLocal.length > 10) filesHtml += `<div class="diff-file" style="color:var(--text-muted);">+${diff.onlyLocal.length - 10} more...</div>`;
      filesHtml += '</div>';
    }
    if (diff.onlyCloud.length > 0) {
      filesHtml += `<div class="diff-section"><h4 style="color:var(--info);margin:8px 0 4px;">Cloud only (${diff.onlyCloud.length})</h4>`;
      filesHtml += diff.onlyCloud.slice(0, 10).map(f => `<div class="diff-file">${f}</div>`).join('');
      if (diff.onlyCloud.length > 10) filesHtml += `<div class="diff-file" style="color:var(--text-muted);">+${diff.onlyCloud.length - 10} more...</div>`;
      filesHtml += '</div>';
    }
    if (diff.sizeDiff.length > 0) {
      filesHtml += `<div class="diff-section"><h4 style="color:var(--warning);margin:8px 0 4px;">Modified (${diff.sizeDiff.length})</h4>`;
      filesHtml += diff.sizeDiff.slice(0, 10).map(f => `<div class="diff-file">${f}</div>`).join('');
      if (diff.sizeDiff.length > 10) filesHtml += `<div class="diff-file" style="color:var(--text-muted);">+${diff.sizeDiff.length - 10} more...</div>`;
      filesHtml += '</div>';
    }

    overlay.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:var(--radius);padding:24px;max-width:500px;width:90%;">
        <h3 style="margin:0 0 8px;color:var(--text-primary);">${projectName}</h3>
        <p style="color:var(--text-secondary);font-size:var(--font-sm);margin:0 0 16px;">${totalDiffs} difference(s) between local and cloud</p>
        <div style="max-height:300px;overflow-y:auto;border:1px solid var(--border-color);border-radius:var(--radius-sm);padding:8px;background:var(--bg-primary);margin-bottom:16px;">
          ${filesHtml}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="diff-btn-skip" style="padding:8px 16px;border-radius:var(--radius-sm);border:1px solid var(--border-color);background:var(--bg-tertiary);color:var(--text-secondary);cursor:pointer;">Skip</button>
          <button class="diff-btn-pull" style="padding:8px 16px;border-radius:var(--radius-sm);border:none;background:var(--info);color:#fff;cursor:pointer;">Use Cloud</button>
          <button class="diff-btn-push" style="padding:8px 16px;border-radius:var(--radius-sm);border:none;background:var(--success);color:#fff;cursor:pointer;">Use Local</button>
        </div>
      </div>`;

    overlay.querySelector('.diff-btn-skip').onclick = () => { overlay.remove(); resolve('skip'); };
    overlay.querySelector('.diff-btn-pull').onclick = () => { overlay.remove(); resolve('pull'); };
    overlay.querySelector('.diff-btn-push').onclick = () => { overlay.remove(); resolve('push'); };

    document.body.appendChild(overlay);
  });
}

/**
 * Show a single batched diff modal for multiple projects at startup.
 * Each project gets a row with a Push/Pull/Skip action selector.
 */
function _showBatchDiffModal(projectDiffs) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const rowsHtml = projectDiffs.map((pd, i) => {
      const total = pd.diff.onlyLocal.length + pd.diff.onlyCloud.length + pd.diff.sizeDiff.length;
      const details = [];
      if (pd.diff.onlyLocal.length) details.push(`<span style="color:var(--success);">${pd.diff.onlyLocal.length} ${t('cloud.diffLocalOnly')}</span>`);
      if (pd.diff.onlyCloud.length) details.push(`<span style="color:var(--info);">${pd.diff.onlyCloud.length} ${t('cloud.diffCloudOnly')}</span>`);
      if (pd.diff.sizeDiff.length) details.push(`<span style="color:var(--warning);">${pd.diff.sizeDiff.length} ${t('cloud.diffModified')}</span>`);
      return `
        <div class="batch-diff-row" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border-color);">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${pd.projectName}</div>
            <div style="font-size:var(--font-xs);color:var(--text-secondary);margin-top:2px;">${t('cloud.diffCount', { count: total })} — ${details.join(', ')}</div>
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0;margin-left:12px;">
            <label style="display:flex;align-items:center;gap:3px;font-size:var(--font-xs);cursor:pointer;color:var(--text-secondary);">
              <input type="radio" name="batch-diff-${i}" value="skip" checked style="accent-color:var(--text-muted);"> ${t('cloud.diffSkip')}
            </label>
            <label style="display:flex;align-items:center;gap:3px;font-size:var(--font-xs);cursor:pointer;color:var(--info);">
              <input type="radio" name="batch-diff-${i}" value="pull" style="accent-color:var(--info);"> ${t('cloud.diffUseCloud')}
            </label>
            <label style="display:flex;align-items:center;gap:3px;font-size:var(--font-xs);cursor:pointer;color:var(--success);">
              <input type="radio" name="batch-diff-${i}" value="push" style="accent-color:var(--success);"> ${t('cloud.diffUseLocal')}
            </label>
          </div>
        </div>`;
    }).join('');

    overlay.innerHTML = `
      <div class="modal-container modal-large" style="max-width:650px;">
        <div class="modal-header">
          <h3>${t('cloud.diffBatchTitle', { count: projectDiffs.length })}</h3>
          <button class="modal-close batch-diff-close">&times;</button>
        </div>
        <div class="modal-body" style="padding:0;">
          <p style="padding:12px 16px;margin:0;color:var(--text-secondary);font-size:var(--font-sm);">${t('cloud.diffBatchDescription')}</p>
          <div style="max-height:400px;overflow-y:auto;">
            ${rowsHtml}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary batch-diff-cancel">${t('common.cancel')}</button>
          <button class="btn-primary batch-diff-apply">${t('cloud.conflictApply')}</button>
        </div>
      </div>`;

    const cleanup = () => overlay.remove();

    overlay.querySelector('.batch-diff-close').onclick = () => { cleanup(); resolve(null); };
    overlay.querySelector('.batch-diff-cancel').onclick = () => { cleanup(); resolve(null); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });

    overlay.querySelector('.batch-diff-apply').onclick = () => {
      const results = projectDiffs.map((pd, i) => {
        const selected = overlay.querySelector(`input[name="batch-diff-${i}"]:checked`);
        return { projectId: pd.projectId, projectName: pd.projectName, action: selected?.value || 'skip' };
      }).filter(r => r.action !== 'skip');
      cleanup();
      resolve(results);
    };

    document.body.appendChild(overlay);
  });
}

// ── Per-project pending changes tracking ──
function _updateProjectPendingChanges(changes) {
  const localProjects = projectsState.get().projects || [];
  // Reset existing pending states
  for (const [id, status] of cloudUploadStatus.entries()) {
    if (status.pendingChanges) {
      cloudUploadStatus.set(id, { ...status, pendingChanges: false, pendingCount: 0 });
    }
  }
  let totalPending = 0;
  for (const { projectName, changes: fileChanges } of (changes || [])) {
    const files = fileChanges.flatMap(c => c.changedFiles || []);
    if (files.length === 0) continue;
    totalPending += files.length;
    const localProject = localProjects.find(p =>
      p.name === projectName || path.basename(p.path) === projectName
    );
    if (localProject) {
      const existing = cloudUploadStatus.get(localProject.id) || {};
      cloudUploadStatus.set(localProject.id, { ...existing, pendingChanges: true, pendingCount: files.length });
    }
  }
  _updateCloudTabBadge(totalPending);
  ProjectList.render();
}

function _updateCloudTabBadge(count) {
  const tab = document.querySelector('.nav-tab[data-tab="cloud-panel"]');
  if (!tab) return;
  let badge = tab.querySelector('.nav-tab-badge');
  if (count > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'nav-tab-badge'; tab.appendChild(badge); }
    badge.textContent = String(count);
  } else if (badge) {
    badge.remove();
  }
}

// ── Background pending changes listener (from CloudSyncService main process) ──
if (api.cloud?.onPendingChanges) {
  api.cloud.onPendingChanges((data) => {
    _updateProjectPendingChanges(data.changes);
  });
}

// ── Auto-sync status listener ──
if (api.cloud?.onAutoSyncStatus) {
  api.cloud.onAutoSyncStatus(({ projectId, status, fileCount, error }) => {
    const existing = cloudUploadStatus.get(projectId) || {};
    if (status === 'uploading') {
      cloudUploadStatus.set(projectId, { ...existing, autoSyncing: true, lastError: null });
      const proj = projectsState.get().projects?.find(p => p.id === projectId);
      showToast({ type: 'info', title: t('cloud.autoSyncUploading'), message: proj?.name || projectId, duration: 3000 });
    } else if (status === 'synced') {
      cloudUploadStatus.set(projectId, { ...existing, synced: true, autoSyncing: false, lastSync: Date.now(), lastError: null });
      showToast({ type: 'success', title: t('cloud.autoSyncComplete'), message: t('cloud.autoSyncFiles', { count: fileCount }) });
    } else if (status === 'error') {
      cloudUploadStatus.set(projectId, { ...existing, autoSyncing: false, lastError: { message: error, timestamp: Date.now() } });
      showToast({ type: 'error', title: t('cloud.autoSyncError'), message: error });
    }
    ProjectList.render();
  });
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
  onGitPull: gitPull,
  onGitPush: gitPush,
  onNewWorktree: openNewWorktreeModal,
  onCloudUpload: cloudUploadProject,
  onCloudSync: cloudSyncProject,
  onCloudDelete: cloudDeleteProject,
  onDeleteProject: deleteProjectUI,
  onRenameProject: renameProjectUI,
  onRenderProjects: () => ProjectList.render(),
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
      (filterProject && termData.project && termData.project.path === filterProject.path);
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
  onSwitchProject: switchProject
});

// Listen for Ctrl+Arrow forwarded from main process (bypasses Windows Snap)
api.window.onCtrlArrow((dir) => {
  if (dir === 'left' || dir === 'right') switchTerminal(dir);
  else if (dir === 'up' || dir === 'down') switchProject(dir);
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
  if (enabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
};

document.getElementById('btn-settings').onclick = () => SettingsPanel.switchToSettingsTab();

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
    if (tabId === 'plugins') PluginsPanel.loadPlugins();
    if (tabId === 'skills') SkillsAgentsPanel.loadSkills();
    if (tabId === 'agents') SkillsAgentsPanel.loadAgents();
    if (tabId === 'mcp') McpPanel.loadMcps();
    if (tabId === 'workflows') WorkflowPanel.load();
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
    if (tabId === 'cloud-panel') {
      const container = document.getElementById('tab-cloud-panel');
      if (container && !container.dataset.initialized) {
        container.innerHTML = CloudPanel.buildHtml(settingsState.get());
        CloudPanel.setupHandlers({
          settingsState,
          projectsState,
          saveSettings,
          updateProjectPendingChanges: _updateProjectPendingChanges,
        });
        container.dataset.initialized = 'true';
      }
    }
    if (tabId !== 'cloud-panel') {
      CloudPanel.cleanup();
    }
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
        if (termData?.fitAddon) termData.fitAddon.fit();
      }
    }
  };
});

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
  const name = await showInputModal(t('dialog.newProjectName'), project.name);
  if (name && name.trim()) {
    renameProject(projectId, name.trim());
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
    onCopyPath: () => {}
  });
}

// ========== NEW PROJECT ==========
document.getElementById('btn-new-project').onclick = () => {
  const projectTypes = registry.getAll();
  const categoriesGrouped = registry.getByCategory();

  let typeIndex = 0;
  const typeColors = { standalone: 'var(--accent)', webapp: '#3b82f6', python: '#3776ab', api: '#a855f7', fivem: 'var(--success)' };
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
          <button type="button" class="wizard-btn-secondary" onclick="closeModal()">${t('common.cancel')}</button>
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
          </div>
        </div>

        <div class="wizard-fields-group">
          <div class="wizard-field clone-config" style="display: none;">
            <label class="wizard-label">${t('newProject.repoUrl')}</label>
            <input type="text" class="wizard-input" id="inp-repo-url" placeholder="https://github.com/user/repo.git">
            <div class="github-status-hint" id="github-status-hint"></div>
          </div>
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

  // Check GitHub auth status (simple hint)
  async function updateGitHubHint() {
    const hintEl = document.getElementById('github-status-hint');
    if (!hintEl) return;

    try {
      const result = await api.github.authStatus();
      githubConnected = result.authenticated;
      if (result.authenticated) {
        hintEl.innerHTML = `<span class="hint-success"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> ${t('newProject.githubConnected', { login: result.login })}</span>`;
      } else {
        hintEl.innerHTML = `<span class="hint-warning"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg> ${t('newProject.githubPrivateUnavailable')} - <a href="#" id="link-github-settings">${t('settings.githubConnect')}</a></span>`;
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

  // Source selector (folder vs clone)
  document.querySelectorAll('.wizard-source-btn').forEach(opt => {
    opt.onclick = () => {
      document.querySelectorAll('.wizard-source-btn').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      selectedSource = opt.dataset.source;
      const isClone = selectedSource === 'clone';
      const isCreate = selectedSource === 'create';
      document.querySelector('.clone-config').style.display = isClone ? 'block' : 'none';
      document.querySelector('.create-git-config').style.display = isCreate ? 'block' : 'none';
      if (isClone) {
        document.getElementById('label-path').textContent = t('newProject.destFolder');
        document.getElementById('inp-path').placeholder = t('newProject.destFolderPlaceholder');
        updateGitHubHint();
      } else if (isCreate) {
        document.getElementById('label-path').textContent = t('newProject.parentFolder');
        document.getElementById('inp-path').placeholder = t('newProject.parentFolderPlaceholder');
      } else {
        document.getElementById('label-path').textContent = t('newProject.projectPath');
        document.getElementById('inp-path').placeholder = t('newProject.projectFolderPlaceholder');
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
          showToast(t('newProject.unableToCreateFolder', { error: err.message }), 'error');
          return;
        }
      }
    }

    // If creating new, create the directory
    if (selectedSource === 'create') {
      projPath = path.join(projPath, name);
      try {
        if (fs.existsSync(projPath)) {
          showToast(t('newProject.folderAlreadyExists'), 'error');
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
            showToast(t('newProject.folderCreatedGitInitError', { error: gitErr.message }), 'error');
          }
        }
      } catch (err) {
        showToast(t('newProject.unableToCreateFolder', { error: err.message }), 'error');
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
      submitBtn.innerHTML = `<span class="btn-spinner"></span> ${t('newProject.cloning')}`;
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
        [branchesData, currentBranch] = await Promise.all([
          api.git.branches({ projectPath: project.path }),
          api.git.currentBranch({ projectPath: project.path })
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
          showGitToast({ success: false, title: t('common.error'), message: result.error || t('git.unableToCreateBranch'), duration: 5000 });
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
                showGitToast({ success: false, title: t('common.error'), message: result.error || t('git.deletionFailed'), duration: 5000 });
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
              title: t('common.error'),
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
    showFilterGitActions(projects[selectedFilter].id);
  } else {
    hideFilterGitActions();
  }
});

// ========== GIT CHANGES PANEL (extracted to GitChangesPanel module) ==========
GitChangesPanel.init({
  showToast,
  showGitToast,
  getCurrentFilterProjectId: () => currentFilterProjectId,
  getProject,
  refreshDashboardAsync,
  closeBranchDropdown: () => { branchDropdown.classList.remove('active'); filterBtnBranch.classList.remove('open'); },
  closeActionsDropdown: () => { const d = document.getElementById('actions-dropdown'); const b = document.getElementById('filter-btn-actions'); if (d) d.classList.remove('active'); if (b) b.classList.remove('open'); }
});


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

function openCreateModal(type) {
  createModalType = type;
  const modal = document.getElementById('create-modal');
  const title = document.getElementById('create-modal-title');
  const description = document.getElementById('create-modal-description');
  const projectSelect = document.getElementById('create-modal-project');

  title.textContent = type === 'skill' ? 'New Skill' : 'New Agent';
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
  document.getElementById('create-modal').classList.remove('active');
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
  closeCreateModal();

  // Show persistent in-progress toast
  const progressToast = showToast({
    type: 'info',
    title: t('ui.createWithClaude'),
    message: type === 'skill' ? t('ui.generatingSkill') : t('ui.generatingAgent'),
    duration: 0
  });

  const dismissToast = (toast) => {
    if (toast && toast.parentNode) {
      toast.classList.add('toast-exit');
      setTimeout(() => toast.remove(), 300);
    }
  };

  try {
    const result = await api.chat.generateSkillAgent({
      type,
      description,
      cwd,
      model: settingsState.get().chatModel || 'sonnet'
    });

    dismissToast(progressToast);

    if (result.success) {
      const successMsg = type === 'skill' ? t('ui.skillCreatedSuccess') : t('ui.agentCreatedSuccess');
      showToast({ type: 'success', title: t('ui.createWithClaude'), message: successMsg });

      // Desktop notification
      api.notification.show({
        title: type === 'skill' ? t('ui.newSkill') : t('ui.newAgent'),
        body: successMsg,
        autoDismiss: 6000
      });

      // Refresh the skills/agents panel
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
  } catch (err) {
    dismissToast(progressToast);
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

// Remote Control: ouvrir un tab chat depuis mobile
api.remote.onOpenChatTab(({ cwd, prompt, images, model, effort }) => {
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
    initialPrompt: prompt,
    initialImages: Array.isArray(images) && images.length ? images : null,
    initialModel: model || null,
    initialEffort: effort || null,
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
      console.log('[Remote] pushTime → todayMs:', today);
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
      updateMessage.textContent = t('updates.newVersionAvailable', { version: data.version });
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
      updateMessage.textContent = t('updates.readyToInstall', { version: data.version });
      updateProgressContainer.style.display = 'none';
      updateBtn.style.display = 'block';
      updateBtn.disabled = false;  // Re-enable button
      updateBtn.textContent = t('updates.restartToUpdate');  // Reset button text
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
  updateBtn.textContent = t('updates.installing');
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
      ciStatusBar.statusText.textContent = t('ci.passed');
    } else {
      ciStatusBar.element.classList.add('failure');
      ciStatusBar.statusText.textContent = run.conclusion === 'cancelled' ? t('ci.cancelled') : t('ci.failed');
    }
  } else {
    ciStatusBar.statusText.textContent = run.status === 'queued' ? t('ci.queued') : t('ci.running');
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
  const { saveAndShutdown } = require('./src/renderer');
  saveAndShutdown();
});

// Backup cleanup on window unload (in case onWillQuit doesn't fire)
window.addEventListener('beforeunload', () => {
  const { saveAndShutdown } = require('./src/renderer');
  saveAndShutdown();
});

