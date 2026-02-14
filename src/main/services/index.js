/**
 * Main Process Services - Central Export
 */

const terminalService = require('./TerminalService');
const mcpService = require('./McpService');
const fivemService = require('./FivemService');
const webAppService = require('../../project-types/webapp/main/WebAppService');
const apiService = require('../../project-types/api/main/ApiService');
const updaterService = require('./UpdaterService');
const chatService = require('./ChatService');
const hooksService = require('./HooksService');
const hookEventServer = require('./HookEventServer');

/**
 * Initialize all services with main window reference
 * @param {BrowserWindow} mainWindow
 */
function initializeServices(mainWindow) {
  terminalService.setMainWindow(mainWindow);
  mcpService.setMainWindow(mainWindow);
  fivemService.setMainWindow(mainWindow);
  webAppService.setMainWindow(mainWindow);
  apiService.setMainWindow(mainWindow);
  updaterService.setMainWindow(mainWindow);
  chatService.setMainWindow(mainWindow);
  hookEventServer.setMainWindow(mainWindow);
}

/**
 * Cleanup all services before quit
 */
function cleanupServices() {
  terminalService.killAll();
  mcpService.stopAll();
  fivemService.stopAll();
  webAppService.stopAll();
  apiService.stopAll();
  chatService.closeAll();
  hookEventServer.stop();
}

module.exports = {
  terminalService,
  mcpService,
  fivemService,
  webAppService,
  apiService,
  updaterService,
  chatService,
  hooksService,
  hookEventServer,
  initializeServices,
  cleanupServices
};
