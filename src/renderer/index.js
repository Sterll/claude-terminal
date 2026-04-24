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

// ── Cloud event handlers ──────────────────────────────────────────────────

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
  if (!api?.project?.onQuickActionChanged) return;
  api.project.onQuickActionChanged(async () => {
    const { loadProjects } = require('./state/projects.state');
    await loadProjects();
  });
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
