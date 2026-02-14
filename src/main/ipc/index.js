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
const { registerUsageHandlers } = require('./usage.ipc');
const { registerMarketplaceHandlers } = require('./marketplace.ipc');
const { registerMcpRegistryHandlers } = require('./mcpRegistry.ipc');
const { registerPluginHandlers } = require('./plugin.ipc');
const { registerChatHandlers } = require('./chat.ipc');
const { registerHooksHandlers } = require('./hooks.ipc');

/**
 * Register all IPC handlers
 * @param {BrowserWindow} mainWindow - Main window reference
 */
function registerAllHandlers(mainWindow) {
  // Set main window references where needed
  setDialogMainWindow(mainWindow);

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
}

module.exports = {
  registerAllHandlers
};
