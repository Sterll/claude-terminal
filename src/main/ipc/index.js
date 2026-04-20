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

  // Wire terminal PTY exits → workflow triggers (no circular dep)
  const terminalService = require('../services/TerminalService');
  const workflowService  = require('../services/WorkflowService');
  terminalService.onExitCallback = (event) => {
    try { workflowService.onTerminalExit(event); } catch (e) {
      console.warn('[IPC] workflow.onTerminalExit failed:', e.message);
    }
  };

  // Wire chat session lifecycle → workflow triggers
  const chatService = require('../services/ChatService');
  chatService.setLifecycleCallback((event) => {
    try { workflowService.onChatSessionEvent(event); } catch (e) {
      console.warn('[IPC] workflow.onChatSessionEvent failed:', e.message);
    }
  });
}

module.exports = {
  registerAllHandlers
};
