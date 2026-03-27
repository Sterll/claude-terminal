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

// ── Register cloud reconnect + sync listeners at module load ──
// These are event listener registrations that wire up IPC listeners for cloud sync.
// They must run once when the module is first required (before the renderer IIFE completes).
const _api = window.electron_api;
_registerCloudListeners(_api);
_registerSyncListeners(_api);

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
              p.id === session.projectName || p.name === session.projectName || p.path?.replace(/\\/g, '/').split('/').pop() === session.projectName
            );
            await api.cloud.takeoverSession({
              sessionId: session.id,
              projectId: localProject?.id || session.projectName,
              projectName: session.projectName,
              localProjectPath: localProject?.path || null,
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
      for (const { projectName, displayName, changes: fileChanges } of changes) {
        const files = fileChanges.flatMap(c => c.changedFiles || []);
        if (files.length === 0) continue;

        const showName = displayName || projectName;
        // Build a message with the file list preview
        const preview = files.slice(0, 8).map(f => `  - ${f}`).join('\n');
        const moreText = files.length > 8 ? `\n  ... +${files.length - 8} ${t('cloud.syncMoreFiles')}` : '';
        const message = t('cloud.syncMessage', { project: showName, count: files.length }) + '\n\n' + preview + moreText;

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
              p.id === projectName || p.name === projectName || p.path?.replace(/\\/g, '/').split('/').pop() === projectName
            );
            if (localProject) {
              await api.cloud.downloadChanges({
                projectId: localProject.id,
                projectName,
                localProjectPath: localProject.path,
              });
              Toast.show(t('cloud.syncApplied'), 'success');
            } else {
              Toast.show(t('cloud.syncNoLocalProject', { project: showName }), 'warning');
            }
          } catch (err) {
            Toast.show(t('cloud.syncError') || t('cloud.uploadError'), 'error');
          }
        }
      }
    });
  }
}

// ── Sync listeners (wire local changes → SyncEngine via IPC) ──────────────────

function _registerSyncListeners(api) {
  if (!api?.sync) return;

  const { onSaveFlush } = require('./state/settings.state');
  const { projectsState } = require('./state/projects.state');
  const Toast = require('./ui/components/Toast');
  const { t } = require('./i18n');
  const { showConflictResolver } = require('./ui/components/ConflictResolver');

  // Wire settings save → push to cloud
  onSaveFlush(({ success }) => {
    if (success) {
      api.sync.pushEntity('settings');
    }
  });

  // Wire projects changes → push to cloud
  let projectsPushTimer = null;
  projectsState.subscribe(() => {
    clearTimeout(projectsPushTimer);
    projectsPushTimer = setTimeout(() => {
      api.sync.pushEntity('projects');
    }, 2000);
  });

  // Listen for sync status updates (from main process)
  if (api.sync.onStatus) {
    api.sync.onStatus(({ type, status, detail }) => {
      if (type === 'full-sync' && status === 'completed') {
        Toast.show(t('sync.fullSyncCompleted'), 'success', 3000);
      } else if (status === 'error' && detail) {
        Toast.show(`${t('sync.syncError')}: ${detail}`, 'error', 5000);
      }
    });
  }

  // Listen for conflict resolution requests from SyncEngine
  if (api.sync.onConflicts) {
    api.sync.onConflicts(async (conflicts) => {
      if (!conflicts || conflicts.length === 0) return;
      const resolutions = await showConflictResolver(conflicts);
      api.sync.resolveConflicts(resolutions);
    });
  }

  // Listen for settings updated from cloud (reload locally)
  if (api.sync.onSettingsUpdated) {
    const { loadSettings } = require('./state/settings.state');
    api.sync.onSettingsUpdated(async () => {
      await loadSettings();
      Toast.show(t('sync.settingsUpdated'), 'info', 3000);
    });
  }

  // Listen for projects updated from cloud (reload locally)
  if (api.sync.onProjectsUpdated) {
    const { loadProjects } = require('./state/projects.state');
    api.sync.onProjectsUpdated(async () => {
      await loadProjects();
      Toast.show(t('sync.projectsUpdated'), 'info', 3000);
    });
  }

  // Listen for MCP configs updated from cloud
  if (api.sync.onMcpUpdated) {
    api.sync.onMcpUpdated(() => {
      Toast.show(t('sync.mcpUpdated'), 'info', 3000);
    });
  }

  // Wire MCP config saves → push to cloud
  // McpService.saveMcps writes to ~/.claude.json
  const _origMcpSave = services.McpService?.saveMcps;
  if (_origMcpSave && typeof _origMcpSave === 'function') {
    services.McpService.saveMcps = async function (...args) {
      const result = await _origMcpSave.apply(this, args);
      api.sync.pushEntity('mcpConfigs');
      return result;
    };
  }

  // Wire skill/agent install/uninstall → push to cloud
  // Skills and agents are loaded from ~/.claude/skills/ and ~/.claude/agents/
  // Push after reload events from SkillService/AgentService
  const SkillService = services.SkillService;
  const AgentService = services.AgentService;

  if (SkillService?.loadSkills) {
    const _origLoadSkills = SkillService.loadSkills.bind(SkillService);
    SkillService._origLoadSkills = _origLoadSkills; // keep ref for cloud reload
    SkillService.loadSkills = async function (...args) {
      const result = await _origLoadSkills(...args);
      api.sync.pushEntity('skills');
      return result;
    };
  }

  if (AgentService?.loadAgents) {
    const _origLoadAgents = AgentService.loadAgents.bind(AgentService);
    AgentService._origLoadAgents = _origLoadAgents; // keep ref for cloud reload
    AgentService.loadAgents = async function (...args) {
      const result = await _origLoadAgents(...args);
      api.sync.pushEntity('agents');
      return result;
    };
  }

  // ── Keybindings sync ──
  // No direct service to monkey-patch; keybindings are edited via file.
  // Listen for cloud updates:
  if (api.sync.onKeybindingsUpdated) {
    api.sync.onKeybindingsUpdated(() => {
      Toast.show(t('sync.keybindingsUpdated'), 'info', 3000);
    });
  }

  // ── Memory (CLAUDE.md) sync ──
  // MemoryEditor saves via fs.writeFileSync → we patch the save method
  if (api.sync.onMemoryUpdated) {
    api.sync.onMemoryUpdated(() => {
      Toast.show(t('sync.memoryUpdated'), 'info', 3000);
    });
  }

  // ── Hooks config sync ──
  // Hooks are installed/removed via api.hooks.install()/remove()
  if (api.sync.onHooksConfigUpdated) {
    api.sync.onHooksConfigUpdated(() => {
      Toast.show(t('sync.hooksConfigUpdated'), 'info', 3000);
    });
  }

  // Wire hooks install/remove → push to cloud
  const hooksApi = window.electron_api?.hooks;
  if (hooksApi) {
    const _origInstall = hooksApi.install;
    if (_origInstall) {
      hooksApi.install = async function (...args) {
        const result = await _origInstall.apply(this, args);
        api.sync.pushEntity('hooksConfig');
        return result;
      };
    }
    const _origRemove = hooksApi.remove;
    if (_origRemove) {
      hooksApi.remove = async function (...args) {
        const result = await _origRemove.apply(this, args);
        api.sync.pushEntity('hooksConfig');
        return result;
      };
    }
  }

  // ── Installed plugins sync ──
  if (api.sync.onPluginsUpdated) {
    api.sync.onPluginsUpdated(() => {
      Toast.show(t('sync.pluginsUpdated'), 'info', 3000);
    });
  }

  // ── Skills/Agents updated from cloud → reload lists ──
  if (api.sync.onSkillsUpdated) {
    api.sync.onSkillsUpdated(async () => {
      if (SkillService?.loadSkills) {
        // Use _origLoadSkills to avoid re-pushing to cloud
        const _orig = SkillService._origLoadSkills || SkillService.loadSkills;
        await _orig.call(SkillService);
      }
      Toast.show(t('sync.skillsUpdated'), 'info', 3000);
    });
  }
  if (api.sync.onAgentsUpdated) {
    api.sync.onAgentsUpdated(async () => {
      if (AgentService?.loadAgents) {
        const _orig = AgentService._origLoadAgents || AgentService.loadAgents;
        await _orig.call(AgentService);
      }
      Toast.show(t('sync.agentsUpdated'), 'info', 3000);
    });
  }

  // ── Time tracking incremental push ──
  const { dataState: ttDataState } = require('./state/timeTracking.state');
  let ttPushTimer = null;
  ttDataState.subscribe(() => {
    clearTimeout(ttPushTimer);
    ttPushTimer = setTimeout(() => {
      api.sync.pushEntity('timeTracking');
    }, 10000); // 10s debounce — time tracking saves frequently
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
