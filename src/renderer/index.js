/**
 * Renderer Process Bootstrap
 * Entry point for the renderer process modules
 */

// Utils
const utils = require('./utils');

// State
const state = require('./state');

// Services
const services = require('./services');

// UI Components
const ui = require('./ui');

// Features
const features = require('./features');

// Internationalization
const i18n = require('./i18n');

// Event system
const events = require('./events');

// Expose states on window for workflow field renderers
// _projectsState: State instance (field renderers call .get().projects)
window._projectsState = state.projectsState;
// _skillsAgentsState: plain object {agents, skills} — field renderers access .agents/.skills directly
// Updated via subscription so it stays fresh when loadAgents/loadSkills complete (async)
window._skillsAgentsState = state.skillsAgentsState.get();
state.skillsAgentsState.subscribe(() => {
  window._skillsAgentsState = state.skillsAgentsState.get();
});

/**
 * Initialize all renderer modules
 */
async function initialize() {
  // Tag platform on body for CSS targeting (macOS traffic lights, etc.)
  const platform = window.electron_nodeModules?.process?.platform || 'win32';
  document.body.classList.add(`platform-${platform}`);

  // Ensure directories exist
  utils.ensureDirectories();

  // Initialize state
  await state.initializeState();

  // Initialize i18n with saved language or auto-detect
  const savedLanguage = state.getSetting('language');
  i18n.initI18n(savedLanguage);

  // Initialize settings (applies accent color, etc.)
  await services.SettingsService.initializeSettings();

  // Terminal IPC listeners are handled by TerminalManager's centralized dispatcher

  services.McpService.registerMcpListeners(
    // onOutput callback
    (id, type, data) => {
      // MCP output received
    },
    // onExit callback
    (id, code) => {
      // MCP process exited
    }
  );

  // Register WebApp listeners
  const { registerWebAppListeners } = require('../project-types/webapp/renderer/WebAppRendererService');
  registerWebAppListeners(
    (projectIndex, data) => {},
    (projectIndex, code) => {
      // WebApp dev server stopped - re-render sidebar
    }
  );

  // API listeners are registered in renderer.js (same pattern as webapp)

  // Register Discord listeners
  const { registerListeners: registerDiscordListeners } = require('../project-types/discord/renderer/DiscordRendererService');
  registerDiscordListeners();

  services.FivemService.registerFivemListeners(
    // onData callback
    (projectIndex, data) => {
      // FiveM output received
    },
    // onExit callback
    (projectIndex, code) => {
      // FiveM server stopped
    },
    // onError callback
    (projectIndex, error) => {
      // FiveM error detected - show debug button
      ui.TerminalManager.showTypeErrorOverlay(projectIndex, error);
    }
  );

  // Listen for MCP-triggered quick actions
  const api = window.electron_api;
  if (api?.project?.onQuickActionRun) {
    api.project.onQuickActionRun((data) => {
      const { projectId, actionId } = data;
      if (!projectId || !actionId) return;
      const project = state.getProject(projectId);
      if (!project) return;
      ui.QuickActions.executeQuickAction(project, actionId);
    });
  }

  // ── Cloud reconnect listeners ──
  _registerCloudListeners(api);

  // Initialize Claude event bus and provider
  events.initClaudeEvents();

  // Load disk-cached dashboard data then refresh from APIs in background
  services.DashboardService.loadAllDiskCaches().then(() => {
    setTimeout(() => {
      services.DashboardService.preloadAllProjects();
    }, 500);
  }).catch(e => {
    console.error('Error loading disk caches:', e);
    // Still try to preload even if disk cache fails
    setTimeout(() => {
      services.DashboardService.preloadAllProjects();
    }, 500);
  });

}

// ── Cloud reconnect handlers ──────────────────────────────────────────────────

function _registerCloudListeners(api) {
  if (!api?.cloud) return;

  const { showConfirm } = require('./ui/components/Modal');
  const { t } = require('./i18n');
  const Toast = require('./ui/components/Toast');
  const { projectsState } = require('./state/projects.state');

  function _getAllProjects() {
    return projectsState.get().projects || [];
  }

  // Active headless sessions detected on reconnect
  if (api.cloud.onHeadlessActive) {
    api.cloud.onHeadlessActive(async ({ sessions }) => {
      if (!sessions || sessions.length === 0) return;
      for (const session of sessions) {
        const confirmed = await showConfirm({
          title: t('cloud.headlessReconnectTitle'),
          message: t('cloud.headlessReconnectMessage', { project: session.projectName || session.id }),
          confirmLabel: t('cloud.headlessTakeover'),
          cancelLabel: t('cloud.headlessContinue'),
        });
        if (confirmed) {
          try {
            const projects = _getAllProjects();
            const localProject = projects.find(p =>
              p.name === session.projectName || p.path?.replace(/\\/g, '/').split('/').pop() === session.projectName
            );
            await api.cloud.takeoverSession({
              sessionId: session.id,
              projectName: session.projectName,
              localProjectPath: localProject?.path || null,
              cloudProjectKey: session.projectName, // already scoped, use as-is
            });
            Toast.show(t('cloud.syncApplied'), 'success');
          } catch (err) {
            Toast.show(t('cloud.uploadError'), 'error');
          }
        }
      }
    });
  }

  // Pending file changes detected on reconnect
  if (api.cloud.onPendingChanges) {
    api.cloud.onPendingChanges(async ({ changes }) => {
      if (!changes || changes.length === 0) return;
      for (const { projectName, changes: fileChanges } of changes) {
        const files = fileChanges.flatMap(c => c.changedFiles || []);
        if (files.length === 0) continue;

        // Build a message with the file list preview
        const preview = files.slice(0, 8).map(f => `  - ${f}`).join('\n');
        const moreText = files.length > 8 ? `\n  ... +${files.length - 8} ${t('cloud.syncMoreFiles')}` : '';
        const message = t('cloud.syncMessage', { project: projectName, count: files.length }) + '\n\n' + preview + moreText;

        const confirmed = await showConfirm({
          title: t('cloud.syncTitle'),
          message,
          confirmLabel: t('cloud.syncApply'),
          cancelLabel: t('cloud.syncSkip'),
        });
        if (confirmed) {
          try {
            const projects = _getAllProjects();
            const localProject = projects.find(p =>
              p.name === projectName || p.path?.replace(/\\/g, '/').split('/').pop() === projectName
            );
            if (localProject) {
              await api.cloud.downloadChanges({
                projectName,
                localProjectPath: localProject.path,
                cloudProjectKey: projectName, // already scoped (comes from cloud), use as-is
              });
              Toast.show(t('cloud.syncApplied'), 'success');
            } else {
              Toast.show(t('cloud.syncNoLocalProject', { project: projectName }), 'warning');
            }
          } catch (err) {
            Toast.show(t('cloud.syncError') || t('cloud.uploadError'), 'error');
          }
        }
      }
    });
  }
}

// Telemetry consent modal is handled in renderer.js (main entry point)

// Export everything for use in renderer.js
module.exports = {
  // Utils
  utils,
  ...utils,

  // State
  state,
  ...state,

  // Services
  services,
  ...services,

  // UI
  ui,
  ...ui,

  // Features
  features,
  ...features,

  // i18n
  i18n,
  ...i18n,

  // Events
  events,
  ...events,

  // Initialize function
  initialize
};
