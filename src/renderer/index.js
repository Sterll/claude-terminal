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

// The task registry is fed here rather than from the chat view, so a tab that
// is closed and reopened does not lose the work it started, and so the two CLI
// feeds are reconciled in exactly one place.
_registerBackgroundTaskListeners(_api);
_registerOrphanReaperListener(_api);

// ── Cloud event handlers ──────────────────────────────────────────────────

function _registerBackgroundTaskListeners(api) {
  const store = require('./state/backgroundTasks.state');

  // Read last run's history back. Detached: the registry merges whatever the
  // tabs claim in the meantime, so nothing here has to wait for the file.
  store.load().catch(e => console.error('Error loading background tasks:', e));
  // A debounced save has up to half a second of history in flight; unload is
  // the one moment that would drop it.
  window.addEventListener('beforeunload', () => store.flushSync());

  if (!api?.chat?.onTaskUpdate) return;

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

// Main kills what a Claude session left spinning (see OrphanReaper); the user
// hears about it here, since a process vanishing without a word would read as
// a crash of whatever it was.
function _registerOrphanReaperListener(api) {
  if (!api?.lifecycle?.onOrphansReaped) return;
  const Toast = require('./ui/components/Toast');
  api.lifecycle.onOrphansReaped((report) => {
    const count = report?.items?.length || 0;
    if (!count) return;
    const params = { count, cpu: Math.round(report.totalCpu || 0) };
    const key = count === 1 ? 'orphanReaper.toastOne' : 'orphanReaper.toastMany';
    Toast.show(i18n.t(key, params), 'warning', 8000);
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

  // project_create / project_update / project_delete write projects.json from
  // the MCP server process. The renderer's own poll on that file would catch it
  // within a few seconds; this is the same reload, without the wait.
  if (api?.project?.onProjectsChanged) {
    api.project.onProjectsChanged(async () => {
      const { loadProjects } = require('./state/projects.state');
      await loadProjects();
    });
  }

  // project_open. The preferred editor is per project and only the renderer
  // holds that mapping, which is why main forwards rather than spawning.
  if (api?.project?.onProjectOpen) {
    api.project.onProjectOpen(({ projectId } = {}) => {
      if (!projectId) return;
      try {
        const { getProject, getProjectEditor } = require('./state/projects.state');
        const { getSetting, getEditorCommand } = require('./state/settings.state');
        const project = getProject(projectId);
        if (!project) {
          console.warn(`[MCP] project:open for unknown project "${projectId}"`);
          return;
        }
        const editor = getProjectEditor(projectId) || getSetting('editor') || 'code';
        api.dialog.openInEditor({ editor: getEditorCommand(editor), path: project.path });
      } catch (e) {
        console.error('[MCP] project:open failed:', e && e.message);
      }
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
