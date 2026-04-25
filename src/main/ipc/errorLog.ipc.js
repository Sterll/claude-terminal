/**
 * Error Log IPC Handlers
 * Exposes error log data to the renderer process.
 */

const { ipcMain } = require('electron');
const errorLogService = require('../services/ErrorLogService');

function registerErrorLogHandlers() {
  ipcMain.handle('errorlog-get-entries', (_event, filters) => {
    return errorLogService.getEntries(filters);
  });

  ipcMain.handle('errorlog-get-stats', () => {
    return errorLogService.getStats();
  });

  ipcMain.handle('errorlog-get-patterns', () => {
    return errorLogService.getPatternAlerts();
  });

  ipcMain.handle('errorlog-clear', () => {
    errorLogService.clear();
    return { success: true };
  });

  ipcMain.handle('errorlog-export', () => {
    return errorLogService.exportForBugReport();
  });

  // Allow renderer to log errors too (e.g. from MCP, workflow UI)
  ipcMain.on('errorlog-log', (_event, { level, domain, message, stack, context }) => {
    errorLogService.log(level, domain, message, { stack, context });
  });
}

module.exports = { registerErrorLogHandlers };
