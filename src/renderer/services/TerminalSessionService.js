/**
 * TerminalSessionService
 * Persists and restores terminal sessions across app restarts.
 * Phase 04: Basic terminal tab persistence
 * Phase 06: Claude session ID capture + resume
 */

const { fs, path } = window.electron_nodeModules;

// Debounce timer for saves
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Get the session data file path.
 */
function getSessionFilePath() {
  const { dataDir } = require('../utils/paths');
  return path.join(dataDir, 'terminal-sessions.json');
}

/**
 * Load session data from disk.
 * @returns {Object|null} Session data or null if not available/disabled
 */
function loadSessionData() {
  try {
    const { getSetting } = require('../state/settings.state');
    if (!getSetting('restoreTerminalSessions')) return null;

    const filePath = getSessionFilePath();
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);

    // Validate structure
    if (!data || typeof data !== 'object' || !data.projects) return null;

    return data;
  } catch (e) {
    console.error('[TerminalSessionService] Error loading session data:', e);
    return null;
  }
}

/**
 * Save terminal sessions to disk (debounced).
 */
function saveTerminalSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTerminalSessionsImmediate();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Save terminal sessions to disk immediately.
 */
function saveTerminalSessionsImmediate() {
  clearTimeout(saveTimer);
  try {
    const { getSetting } = require('../state/settings.state');
    if (!getSetting('restoreTerminalSessions')) return;

    const { terminalsState } = require('../state/terminals.state');
    const { projectsState } = require('../state/projects.state');

    const terminals = terminalsState.get().terminals;
    const activeTerminalId = terminalsState.get().activeTerminal;
    const projects = projectsState.get().projects;
    const selectedFilter = projectsState.get().selectedProjectFilter;

    // Group terminals by project, using DOM tab order (reflects drag-and-drop reordering)
    const projectSessions = {};
    // Iterate all panes in order to capture full tab sequence
    const PaneManager = require('../ui/components/PaneManager');
    const paneOrder = PaneManager.getPaneOrder();
    const allTabElements = [];
    for (const paneId of paneOrder) {
      const tabsEl = PaneManager.getTabsContainer(paneId);
      if (tabsEl) {
        allTabElements.push(...tabsEl.querySelectorAll('.terminal-tab'));
      }
    }
    const orderedIds = Array.from(allTabElements).map(el => el.dataset.id);

    for (const id of orderedIds) {
      const td = terminals.get(id) || terminals.get(Number(id));
      if (!td || !td.project?.id) continue;

      const projectId = td.project.id;
      if (!projectSessions[projectId]) {
        projectSessions[projectId] = { tabs: [], activeCwd: null, activeTabIndex: null };
      }

      const tab = {
        cwd: td.cwd || td.project.path,
        isBasic: td.isBasic || false,
        mode: td.mode || 'terminal',
        claudeSessionId: td.claudeSessionId || null,
        name: td.name || null,
      };

      projectSessions[projectId].tabs.push(tab);

      // Track active tab index
      if (id === activeTerminalId) {
        projectSessions[projectId].activeTabIndex = projectSessions[projectId].tabs.length - 1;
        projectSessions[projectId].activeCwd = tab.cwd;
      }
    }

    // Add pane layout information per project (multi-pane only)
    if (paneOrder.length > 1) {
      for (const [projectId, session] of Object.entries(projectSessions)) {
        const paneDataArr = [];
        let globalTabIdx = 0;

        for (const pId of paneOrder) {
          const tabsEl = PaneManager.getTabsContainer(pId);
          if (!tabsEl) continue;

          const paneTabIndices = [];
          let paneActiveTabIndex = null;
          const paneActiveTab = PaneManager.getPaneActiveTab(pId);

          tabsEl.querySelectorAll('.terminal-tab').forEach(tabEl => {
            const termId = tabEl.dataset.id;
            const td = terminals.get(termId) || terminals.get(Number(termId));
            if (!td || td.project?.id !== projectId) return;

            paneTabIndices.push(globalTabIdx);
            if (String(termId) === String(paneActiveTab)) {
              paneActiveTabIndex = paneTabIndices.length - 1;
            }
            globalTabIdx++;
          });

          if (paneTabIndices.length > 0) {
            paneDataArr.push({
              tabIndices: paneTabIndices,
              activeTabIndex: paneActiveTabIndex ?? 0
            });
          }
        }

        if (paneDataArr.length > 1) {
          session.paneLayout = {
            count: paneDataArr.length,
            activePane: PaneManager.getActivePaneIndex(),
            panes: paneDataArr
          };
        }
      }
    }

    // Determine last opened project
    const currentProject = (selectedFilter !== null && selectedFilter !== undefined && projects[selectedFilter])
      ? projects[selectedFilter] : null;
    const lastOpenedProjectId = currentProject ? currentProject.id : null;

    const sessionData = {
      version: 2,
      savedAt: new Date().toISOString(),
      lastOpenedProjectId,
      projects: projectSessions,
    };

    const filePath = getSessionFilePath();
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(sessionData, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error('[TerminalSessionService] Error saving session data:', e);
  }
}

/**
 * Clear saved sessions for a specific project.
 * @param {string} projectId
 */
function clearProjectSessions(projectId) {
  try {
    const filePath = getSessionFilePath();
    if (!fs.existsSync(filePath)) return;

    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (data && data.projects && data.projects[projectId]) {
      delete data.projects[projectId];
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch (e) {
    console.error('[TerminalSessionService] Error clearing project sessions:', e);
  }
}

/**
 * Clear all session data (e.g., when feature is disabled).
 */
function clearAllSessions() {
  try {
    const filePath = getSessionFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.error('[TerminalSessionService] Error clearing all sessions:', e);
  }
}

module.exports = {
  loadSessionData,
  saveTerminalSessions,
  clearProjectSessions,
  clearAllSessions,
};
