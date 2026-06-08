/**
 * IPC Handlers - Central Registry
 * Registers all IPC handlers for the main process
 */

const { registerTerminalHandlers } = require('./terminal.ipc');
const { registerGitHandlers } = require('./git.ipc');
const { registerGitHubHandlers } = require('./github.ipc');
const { registerMcpHandlers } = require('./mcp.ipc');
const { registerFivemHandlers } = require('./fivem.ipc');
const { registerWebAppHandlers } = require('../../project-types/webapp/main/webapp.ipc');
const { registerPythonHandlers } = require('../../project-types/python/main/python.ipc');
const { registerApiHandlers } = require('../../project-types/api/main/api.ipc');
const { registerDialogHandlers, setMainWindow: setDialogMainWindow } = require('./dialog.ipc');
const { registerProjectHandlers } = require('./project.ipc');
const { registerClaudeHandlers } = require('./claude.ipc');
const { registerUsageHandlers, setMainWindow: setUsageMainWindow } = require('./usage.ipc');
const { registerMarketplaceHandlers } = require('./marketplace.ipc');
const { registerMcpRegistryHandlers } = require('./mcpRegistry.ipc');
const { registerPluginHandlers } = require('./plugin.ipc');
const { registerChatHandlers } = require('./chat.ipc');
const { registerHooksHandlers } = require('./hooks.ipc');
const { registerMinecraftHandlers } = require('../../project-types/minecraft/main/minecraft.ipc');
const { registerDiscordHandlers } = require('../../project-types/discord/main/discord.ipc');
const { registerRemoteHandlers } = require('./remote.ipc');
const { registerWorkflowHandlers } = require('./workflow.ipc');
const { registerCloudRelayHandlers, setCloudRelayMainWindow } = require('./cloud-relay.ipc');
const { registerCloudProjectsHandlers, setCloudProjectsMainWindow } = require('./cloud-projects.ipc');
const { registerCloudSyncHandlers, setCloudSyncMainWindow } = require('./cloud-sync.ipc');
const { registerDatabaseHandlers } = require('./database.ipc');
const { registerTelemetryHandlers } = require('./telemetry.ipc');
const { registerExplorerHandlers } = require('./explorer.ipc');
const { registerTimeHandlers } = require('./time.ipc');
const { registerParallelHandlers } = require('./parallel.ipc');
const { registerWorkspaceHandlers } = require('./workspace.ipc');
const { registerErrorLogHandlers } = require('./errorLog.ipc');
const { registerAccountsHandlers } = require('./accounts.ipc');
const { registerDiscordRpcHandlers } = require('./discord-rpc.ipc');

/**
 * Register all IPC handlers
 * @param {BrowserWindow} mainWindow - Main window reference
 */
function registerAllHandlers(mainWindow) {
  // Set main window references where needed
  setDialogMainWindow(mainWindow);
  setUsageMainWindow(mainWindow);
  setCloudRelayMainWindow(mainWindow);
  setCloudProjectsMainWindow(mainWindow);
  setCloudSyncMainWindow(mainWindow);
  // Register all handlers
  registerTerminalHandlers();
  registerGitHandlers();
  registerGitHubHandlers();
  registerMcpHandlers();
  registerFivemHandlers();
  registerWebAppHandlers();
  registerPythonHandlers();
  registerApiHandlers();
  registerDialogHandlers();
  registerProjectHandlers();
  registerClaudeHandlers();
  registerUsageHandlers();
  registerMarketplaceHandlers();
  registerMcpRegistryHandlers();
  registerPluginHandlers();
  registerChatHandlers();
  registerHooksHandlers();
  registerMinecraftHandlers();
  registerDiscordHandlers();
  registerRemoteHandlers();
  registerWorkflowHandlers(mainWindow);
  registerCloudRelayHandlers();
  registerCloudProjectsHandlers();
  registerCloudSyncHandlers();
  registerDatabaseHandlers();
  registerTelemetryHandlers();
  registerExplorerHandlers(mainWindow);
  registerTimeHandlers();
  registerParallelHandlers(mainWindow);
  registerWorkspaceHandlers();
  registerErrorLogHandlers();
  registerAccountsHandlers();
  registerDiscordRpcHandlers();

  // Wire terminal PTY exits → workflow triggers (no circular dep)
  const terminalService = require('../services/TerminalService');
  const workflowService  = require('../services/WorkflowService');
  terminalService.onExitCallback = (event) => {
    try { workflowService.onTerminalExit(event); } catch (e) {
      console.warn('[IPC] workflow.onTerminalExit failed:', e.message);
    }
  };

  // Wire chat session lifecycle → workflow triggers + Discord Rich Presence
  const chatService = require('../services/ChatService');
  const discordRpcService = require('../services/DiscordRpcService');
  const pathModule = require('path');

  // Pretty labels for the project-type fallback shown on the Discord presence.
  const PROJECT_TYPE_LABELS = {
    general: 'General', api: 'API', fivem: 'FiveM', minecraft: 'Minecraft',
    python: 'Python', webapp: 'Web app', discord: 'Discord bot',
  };

  // Resolve the Claude Terminal project entry for a session.
  // The folder on disk (basename of cwd) can differ from the name the user gave
  // the project (e.g. folder "base" → project "SpaceNew"), so prefer the
  // projects.json entry matched by id, then by path, and only fall back to the
  // cwd basename.
  const resolveProject = (projectId, cwd) => {
    try {
      const fsModule = require('fs');
      const { projectsFile } = require('../utils/paths');
      const raw = JSON.parse(fsModule.readFileSync(projectsFile, 'utf8'));
      const projects = Array.isArray(raw) ? raw : (raw.projects || []);
      let match = projectId ? projects.find((p) => p.id === projectId) : null;
      if (!match && cwd) {
        const norm = (s) => pathModule.resolve(String(s)).toLowerCase();
        const target = norm(cwd);
        match = projects.find((p) => p.path && norm(p.path) === target);
      }
      if (match && match.name) return { name: match.name, type: match.type || null };
    } catch { /* projects.json missing/corrupt → fall back */ }
    return { name: cwd ? pathModule.basename(cwd) : null, type: null };
  };

  // Second presence line: current git branch, else the project type.
  const resolveSubtitle = async (cwd, type) => {
    if (cwd) {
      try {
        const { getCurrentBranch } = require('../utils/git');
        const branch = await getCurrentBranch(cwd);
        if (branch) return `on ${branch}`;
      } catch { /* not a git repo → fall back to type */ }
    }
    if (type) return `${PROJECT_TYPE_LABELS[type] || type} project`;
    return undefined;
  };

  chatService.setLifecycleCallback((event) => {
    try { workflowService.onChatSessionEvent(event); } catch (e) {
      console.warn('[IPC] workflow.onChatSessionEvent failed:', e.message);
    }
    // Discord presence: "Coding in {project}" while a session runs, idle otherwise
    try {
      if (event.event === 'start') {
        const { name, type } = resolveProject(event.projectId, event.cwd);
        // Show the project immediately, then refine the subtitle once git resolves.
        discordRpcService.setProject(name, { coding: true });
        resolveSubtitle(event.cwd, type)
          .then((subtitle) => discordRpcService.setProject(name, { coding: true, subtitle }))
          .catch(() => { /* keep the initial presence */ });
      } else if (event.event === 'end') {
        discordRpcService.setIdle();
      }
    } catch (e) {
      console.warn('[IPC] discordRpc presence update failed:', e.message);
    }
  });

  // Wire chat messages (user/assistant) → workflow triggers
  chatService.setMessageCallback((event) => {
    try { workflowService.onChatMessage(event); } catch (e) {
      console.warn('[IPC] workflow.onChatMessage failed:', e.message);
    }
  });
}

module.exports = {
  registerAllHandlers
};
