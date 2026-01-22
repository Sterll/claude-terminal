/**
 * Usage IPC Handler
 * Fetches Claude Code usage via /usage command
 */

const { ipcMain } = require('electron');
const usageService = require('../services/UsageService');

let mainWindow = null;

/**
 * Set main window reference for sending updates
 */
function setMainWindow(win) {
  mainWindow = win;
}

/**
 * Register IPC handlers
 */
function registerUsageHandlers() {
  // Get current cached usage data
  ipcMain.handle('get-usage-data', () => {
    return usageService.getUsageData();
  });

  // Force refresh usage data
  ipcMain.handle('refresh-usage', async () => {
    try {
      const data = await usageService.refreshUsage();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Start periodic fetching
  ipcMain.handle('start-usage-monitor', (event, intervalMs) => {
    usageService.startPeriodicFetch(intervalMs || 60000);
    return { success: true };
  });

  // Stop periodic fetching
  ipcMain.handle('stop-usage-monitor', () => {
    usageService.stopPeriodicFetch();
    return { success: true };
  });
}

module.exports = { registerUsageHandlers, setMainWindow };
