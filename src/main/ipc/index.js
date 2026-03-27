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
const { registerCloudHandlers, setCloudMainWindow } = require('./cloud.ipc');
const { registerDatabaseHandlers } = require('./database.ipc');
const { registerTelemetryHandlers } = require('./telemetry.ipc');
const { registerExplorerHandlers } = require('./explorer.ipc');
const { registerTimeHandlers } = require('./time.ipc');
const { registerParallelHandlers } = require('./parallel.ipc');
const { registerSyncHandlers, setMainWindow: setSyncMainWindow } = require('./sync.ipc');

/**
 * Register all IPC handlers
 * @param {BrowserWindow} mainWindow - Main window reference
 */
function registerAllHandlers(mainWindow) {
  // Set main window references where needed
  setDialogMainWindow(mainWindow);
  setUsageMainWindow(mainWindow);
  setCloudMainWindow(mainWindow);
  setSyncMainWindow(mainWindow);

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
  registerCloudHandlers();
  registerDatabaseHandlers();
  registerTelemetryHandlers();
  registerExplorerHandlers(mainWindow);
  registerTimeHandlers();
  registerParallelHandlers(mainWindow);
  registerSyncHandlers();
}

module.exports = {
  registerAllHandlers
};
