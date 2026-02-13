/**
 * Python IPC Handlers
 */

const { ipcMain } = require('electron');
const pythonService = require('./PythonService');

function registerHandlers() {
  ipcMain.handle('python-detect-info', async (event, { projectPath }) => {
    return pythonService.detectInfo(projectPath);
  });
}

module.exports = { registerHandlers, registerPythonHandlers: registerHandlers };
