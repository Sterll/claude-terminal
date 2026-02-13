/**
 * API IPC Handlers
 */

const { ipcMain } = require('electron');
const apiService = require('./ApiService');
const routeDetector = require('./ApiRouteDetector');
const apiTester = require('./ApiTester');

function registerHandlers() {
  ipcMain.handle('api-start', async (event, { projectIndex, projectPath, devCommand }) => {
    return apiService.start({ projectIndex, projectPath, devCommand });
  });

  ipcMain.handle('api-stop', async (event, { projectIndex }) => {
    return apiService.stop({ projectIndex });
  });

  ipcMain.on('api-input', (event, { projectIndex, data }) => {
    apiService.write(projectIndex, data);
  });

  ipcMain.on('api-resize', (event, { projectIndex, cols, rows }) => {
    apiService.resize(projectIndex, cols, rows);
  });

  ipcMain.handle('api-detect-framework', async (event, { projectPath }) => {
    return apiService.detectFramework(projectPath);
  });

  ipcMain.handle('api-get-port', async (event, { projectIndex }) => {
    return apiService.getDetectedPort(projectIndex);
  });

  ipcMain.handle('api-detect-routes', async (event, { projectPath }) => {
    return routeDetector.detectRoutes(projectPath);
  });

  ipcMain.handle('api-test-request', async (event, { url, method, headers, body }) => {
    return apiTester.sendRequest({ url, method, headers, body });
  });
}

module.exports = { registerHandlers, registerApiHandlers: registerHandlers };
