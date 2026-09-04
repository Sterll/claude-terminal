/**
 * Renderer Process Bootstrap
 * Entry point for the renderer process modules
 */

// Core infrastructure (OOP base classes, DI container)
const core = require('./core');

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

// ── Register cloud listeners at module load ──
// These wire up IPC listeners for cloud project updates.
// Must run once when the module is first required.
const _api = window.electron_api;
_registerCloudListeners(_api);
_registerMcpProjectListeners(_api);

// Warm the model catalog once at startup. Every picker (chat footer, project
// settings, parallel run) then reads it synchronously, which is what keeps
// those call sites from each having to be async just to render a dropdown.
// Detached: a model list is never worth blocking startup on.
if (_api?.chat?.modelCatalog) {
  require('./services/ModelCatalogClient').load(_api).catch(() => {});
}

// ── Cloud event handlers ──────────────────────────────────────────────────

function _registerBackgroundTaskListeners(api) {
  if (!api?.chat?.onTaskUpdate) return;
  const store = require('./state/backgroundTasks.state');

  api.chat.onTaskUpdate((data) => {
    // Ambient housekeeping never belongs in a user-facing task list.
    if (!data || data.skipTranscript) return;
    if (data.phase === 'started') store.taskStarted(data);
    else if (data.phase === 'ended') store.taskEnded(data);
  });

  // The level feed is what settles a task whose end bookend never arrived.
  api.chat.onBackgroundTasks?.((data) => {
    if (data?.sessionId) store.syncLive(data.sessionId, data.tasks);
  });
}

function _registerCloudListeners(api) {
  if (!api?.cloud) return;

  const Toast = require('./ui/components/Toast');

  // Notify when a cloud project is updated (e.g. by a headless session)
  if (api.cloud.onProjectUpdated) {
    api.cloud.onProjectUpdated((msg) => {
      if (msg?.projectName) {
        Toast.show(`Cloud: ${msg.projectName} updated`, 'info', 3000);
      }
    });
  }

  // Reload projects from disk after cloud sync merges new data
  if (api.cloud.onProjectsReloaded) {
    api.cloud.onProjectsReloaded(async () => {
      const { loadProjects, checkMissingPaths } = require('./state/projects.state');
      await loadProjects();
      await checkMissingPaths();
    });
  }
}

// ── MCP project event handlers ───────────────────────────────────────────────

function _registerMcpProjectListeners(api) {
  if (api?.project?.onQuickActionChanged) {
    api.project.onQuickActionChanged(async () => {
      const { loadProjects } = require('./state/projects.state');
      await loadProjects();
    });
  }

  // The main process has always forwarded the MCP `quickaction_run` tool to the
  // 'quickaction:run' channel, and preload has always exposed the listener —
  // but nothing subscribed, so the tool sent its event into the void and the
  // action never ran. This is the missing end of that wire.
  if (api?.project?.onQuickActionRun) {
    api.project.onQuickActionRun(async ({ projectId, actionId } = {}) => {
      if (!projectId || !actionId) return;
      try {
        const { getProject } = require('./state/projects.state');
        const project = getProject(projectId);
        if (!project) {
          console.warn(`[MCP] quickaction:run for unknown project "${projectId}"`);
          return;
        }
        const { executeQuickAction } = require('./ui/components/QuickActions');
        await executeQuickAction(project, actionId);
      } catch (e) {
        console.error('[MCP] quickaction:run failed:', e && e.message);
      }
    });
  }
}

// Telemetry consent modal is handled in renderer.js (main entry point)

// Export everything for use in renderer.js
module.exports = {
  // Core infrastructure
  core,

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
  ...events
};
